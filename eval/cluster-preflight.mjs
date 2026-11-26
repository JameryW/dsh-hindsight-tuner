/**
 * Offline single-linkage pages for the A3-C ablation.
 *
 * The pre-step hook does not build a graph. This module turns a sparse
 * neighbour-edge list into a spanning forest, cuts it into clusters, and
 * drafts a short unowned page per cluster. Search-slot and token checks run
 * on screening prompts only, using the same term weights as page search.
 * Held-out prompts never change τ, membership, or page text.
 */

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

import { estimateTokens, extractQueryTerms, queryTermWeight, sectionScore, termMatches } from '../lib/tokens.js'

const SCREENING_SETS = new Set(['screening', 'train', 'training', 'dev'])
const PAGE_TOKEN_BUDGET = 300
const ENTERED_RATE_MIN = 0.3
const TOKEN_RATIO_CONFIRM = 1.5
const DEFAULT_MIN_MEMBERS = 8
const DEFAULT_PAGE_CAP = 10
const PATH_EXT = /\.(?:[cm]?[jt]sx?|md|json|ya?ml|py|go|rs|java|toml)$/i

/**
 * Kruskal forest of an undirected edge list. Endpoints are stored in
 * lexicographic order, so `a—b` and `b—a` are one edge. Parallel edges keep
 * the lighter weight. Self-loops, missing endpoints, and non-finite weights
 * are dropped. Sort is by weight, then endpoints, so one edge list has one forest.
 *
 * @param {{source: string, target: string, weight: number}[]} edges
 * @returns {{source: string, target: string, weight: number}[]}
 */
export function minimumSpanningForest(edges) {
  const lightest = new Map()
  for (const edge of edges ?? []) {
    const rawSource = typeof edge?.source === 'string' ? edge.source : ''
    const rawTarget = typeof edge?.target === 'string' ? edge.target : ''
    const weight = Number(edge?.weight)
    if (!rawSource || !rawTarget || rawSource === rawTarget || !Number.isFinite(weight)) continue
    const source = rawSource < rawTarget ? rawSource : rawTarget
    const target = rawSource < rawTarget ? rawTarget : rawSource
    const key = `${source}\0${target}`
    const previous = lightest.get(key)
    if (!previous || weight < previous.weight) lightest.set(key, { source, target, weight })
  }
  const list = [...lightest.values()]
  list.sort((a, b) => a.weight - b.weight || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))

  const parent = new Map()
  function find(id) {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    let cursor = id
    while (cursor !== root) {
      const next = parent.get(cursor)
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  function add(id) {
    if (!parent.has(id)) parent.set(id, id)
  }

  const forest = []
  for (const edge of list) {
    add(edge.source)
    add(edge.target)
    const left = find(edge.source)
    const right = find(edge.target)
    if (left === right) continue
    parent.set(right, left)
    forest.push(edge)
  }
  return forest
}

/**
 * Cut forest edges heavier than `tau` and drop clusters smaller than
 * `minMembers`. Cluster id is `cluster:` plus the lexicographically smallest
 * member, which is stable for a given membership.
 *
 * @param {{source: string, target: string, weight: number}[]} forestEdges
 * @param {{tau?: number, minMembers?: number}} [options]
 */
export function cutForest(forestEdges, { tau = Infinity, minMembers = DEFAULT_MIN_MEMBERS } = {}) {
  const parent = new Map()
  function find(id) {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    let cursor = id
    while (cursor !== root) {
      const next = parent.get(cursor)
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  function add(id) {
    if (!parent.has(id)) parent.set(id, id)
  }

  const floor = Number.isFinite(minMembers) ? minMembers : DEFAULT_MIN_MEMBERS
  for (const edge of forestEdges ?? []) {
    add(edge.source)
    add(edge.target)
    if (Number(edge.weight) > tau) continue
    const left = find(edge.source)
    const right = find(edge.target)
    if (left !== right) parent.set(right, left)
  }

  const groups = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    const group = groups.get(root)
    if (group) group.push(id)
    else groups.set(root, [id])
  }

  const clusters = []
  for (const members of groups.values()) {
    if (members.length < floor) continue
    members.sort()
    clusters.push({ id: `cluster:${members[0]}`, members })
  }
  clusters.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return clusters
}

/**
 * Terms shared by at least `minFraction` of the member texts (and at least two
 * members). Rank is document frequency times `queryTermWeight`, so paths beat
 * prose. Hapax terms stay out: a path that appears once is not the cluster's
 * signature.
 *
 * @param {string[]} texts
 * @param {{minFraction?: number}} [options]
 */
export function signatureTerms(texts, { minFraction = 0.2 } = {}) {
  const docs = (Array.isArray(texts) ? texts : []).filter((text) => typeof text === 'string' && text.trim())
  if (docs.length === 0) return []
  const counts = new Map()
  for (const text of docs) {
    for (const term of extractQueryTerms(text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }
  const floor = Math.max(2, Math.ceil(docs.length * minFraction))
  const ranked = []
  for (const [term, df] of counts) {
    if (df < floor) continue
    const weight = queryTermWeight(term)
    ranked.push({ term, df, weight, score: df * weight })
  }
  ranked.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
  return ranked
}

function sentencesOf(text) {
  return String(text ?? '')
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12 && part.length <= 240)
}

function bestSentence(texts, terms) {
  let best = ''
  let bestHits = 0
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      const haystack = sentence.toLowerCase()
      let hits = 0
      for (const term of terms) if (termMatches(haystack, term.term)) hits += 1
      if (hits > bestHits || (hits === bestHits && hits > 0 && sentence.length < best.length)) {
        best = sentence
        bestHits = hits
      }
    }
  }
  return bestHits > 0 ? best : ''
}

function pathTerm(terms) {
  return terms.find((entry) => entry.weight === 3 && PATH_EXT.test(entry.term))?.term ?? ''
}

/**
 * Draft one unowned cluster page. Shared paths and identifiers come from the
 * member texts, plus one sentence already present in a member. A caller-supplied
 * path is used only when some member already contains it. Tail terms go first,
 * then the footer, and only then the member sentence. The backticked path and
 * the `commit` line stay even when they alone exceed `tokenBudget`.
 */
export function buildClusterPage({
  id,
  texts = [],
  path = '',
  commit = '',
  tau = null,
  tokenBudget = PAGE_TOKEN_BUDGET,
} = {}) {
  const members = (Array.isArray(texts) ? texts : []).filter((text) => typeof text === 'string' && text.trim())
  const ranked = signatureTerms(members)
  const suppliedPath = typeof path === 'string' && members.some((text) => text.includes(path)) ? path : ''
  const chosenPath = suppliedPath || pathTerm(ranked)
  const tauText = Number.isFinite(Number(tau)) ? `path_max ≤ ${tau}` : 'path_max'
  const footer = `members ${members.length} · one single-linkage cluster on the neighbour graph (${tauText}).`

  function render(terms, sentence, includeFooter) {
    const lines = []
    if (chosenPath) lines.push(`path \`${chosenPath}\``)
    if (commit) lines.push(`commit ${commit}`)
    if (terms.length > 0) lines.push('', terms.map((entry) => entry.term).join('\n'))
    if (sentence) lines.push('', sentence)
    if (includeFooter) lines.push('', footer)
    return `${lines.join('\n').trim()}\n`
  }

  let terms = ranked.slice()
  let sentence = bestSentence(members, ranked)
  let includeFooter = true
  const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : PAGE_TOKEN_BUDGET
  let content = render(terms, sentence, includeFooter)
  while (estimateTokens(content) > budget) {
    if (terms.length > 0) terms = terms.slice(0, -1)
    else if (includeFooter) includeFooter = false
    else if (sentence) sentence = ''
    else break
    content = render(terms, sentence, includeFooter)
  }

  const pageId = typeof id === 'string' && id.trim() ? id.trim() : 'cluster:untitled'
  const label = chosenPath || terms[0]?.term || pageId.slice('cluster:'.length)
  return {
    id: pageId,
    documentId: pageId,
    tags: [pageId],
    title: `Cluster: ${label}`,
    content,
    tokens: estimateTokens(content),
    terms: terms.map((entry) => entry.term),
  }
}

function pageHaystack(page) {
  return [page?.name, page?.path, page?.description, page?.content, page?.title].filter((part) => typeof part === 'string').join('\n')
}

/**
 * Compare the top-L search hits of the baseline bank and the cluster bank.
 * `pathRisk` lists prompt paths that a displaced page still mentions and that
 * none of the entered cluster pages mention.
 */
export function slotReport({ baseline = [], treatment = [], clusterIds = [], prompt = '' } = {}) {
  const clusters = new Set(clusterIds)
  const treatmentIds = new Set(treatment.map((page) => page?.id).filter(Boolean))
  const entered = treatment.filter((page) => page && clusters.has(page.id))
  const displaced = baseline.filter((page) => page?.id && !treatmentIds.has(page.id))
  const terms = extractQueryTerms(prompt)
  const pathTerms = [...terms].filter((term) => queryTermWeight(term) === 3)
  const enteredHay = entered.map((page) => pageHaystack(page)).join('\n').toLowerCase()
  const scores = entered.map((page) => sectionScore(pageHaystack(page), terms))
  const pathRisk = []
  for (const page of displaced) {
    const haystack = pageHaystack(page).toLowerCase()
    for (const term of pathTerms) {
      if (!termMatches(haystack, term)) continue
      if (enteredHay && termMatches(enteredHay, term)) continue
      pathRisk.push({ pageId: page.id, term })
    }
  }
  return {
    entered: entered.map((page) => page.id),
    displaced: displaced.map((page) => page.id),
    scores,
    pathRisk,
  }
}

/** Text shape `fetchPagesPayload` builds before the governor trims it. */
export function injectionText(pages) {
  return (Array.isArray(pages) ? pages : [])
    .filter((page) => page && (page.id || page.name || page.content))
    .map((page) => {
      const title = page.name || page.title || page.id
      const body = page.content || page.description || ''
      return `## ${title} (pageId: ${page.id})\n\n${body}`
    })
    .join('\n\n')
}

/**
 * Token ratio r of one attempt's injection. Each eval attempt is a new
 * `runTask`, so this cost is paid again on the next attempt. When both arms
 * solve on the same attempt, cost moves with r. Treatment attempts must fall
 * below `1/r` of the baseline attempts before cost per solved node drops.
 */
export function tokenRatio(baselinePages, treatmentPages) {
  const baselineTokens = estimateTokens(injectionText(baselinePages))
  const treatmentTokens = estimateTokens(injectionText(treatmentPages))
  const r = baselineTokens > 0 ? treatmentTokens / baselineTokens : null
  return {
    baselineTokens,
    treatmentTokens,
    r,
    attemptsFactor: r !== null && r > 0 ? 1 / r : null,
  }
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  if (nums.length % 2 === 1) return nums[mid]
  return (nums[mid - 1] + nums[mid]) / 2
}

/**
 * Gate a preflight. Only screening rows count. Confirmation rows are reported
 * as ignored so a caller can see that they were not used to tune the cut.
 *
 * @param {{id?: string, set?: string, entered?: number, pathRisk?: boolean, score?: number, r?: number|null}[]} rows
 */
export function preflightDecision(rows) {
  const screening = []
  const ignored = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const set = typeof row?.set === 'string' ? row.set.trim().toLowerCase() : ''
    if (SCREENING_SETS.has(set)) screening.push(row)
    else ignored.push({ id: row?.id ?? null, set: set || 'unspecified' })
  }

  const enteredRate = screening.length === 0 ? 0 : screening.filter((row) => Number(row.entered) > 0).length / screening.length
  const pageScores = []
  for (const row of screening) {
    if (Array.isArray(row.scores) && row.scores.length > 0) pageScores.push(...row.scores.filter((score) => Number.isFinite(score)))
    else if (Number(row.entered) > 0 && Number.isFinite(row.score)) pageScores.push(row.score)
  }
  const medianScore = median(pageScores)
  const medianR = median(screening.map((row) => row.r).filter((value) => Number.isFinite(value)))
  const pathRiskTasks = screening.filter((row) => row.pathRisk).map((row) => row.id ?? null)
  const reasons = []
  if (screening.length === 0) reasons.push('no screening tasks')
  if (!(enteredRate >= ENTERED_RATE_MIN)) reasons.push(`entered rate ${enteredRate.toFixed(2)} is below ${ENTERED_RATE_MIN}`)
  if (pathRiskTasks.length > 0) reasons.push(`path risk on ${pathRiskTasks.length} screening task(s)`)
  if (!(medianScore > 0)) reasons.push('median cluster score is not above 0')

  const pass = reasons.length === 0
  const readyForConfirmation = pass && medianR !== null && medianR <= TOKEN_RATIO_CONFIRM
  return {
    pass,
    readyForConfirmation,
    enteredRate,
    medianScore,
    medianR,
    attemptsFactor: medianR !== null && medianR > 0 ? 1 / medianR : null,
    pathRiskTasks,
    screeningTasks: screening.length,
    ignored,
    reasons,
    warnings: pass && !readyForConfirmation
      ? [`median token ratio ${medianR === null ? 'unknown' : medianR.toFixed(2)} is above ${TOKEN_RATIO_CONFIRM}; shorten pages before the confirmation run`]
      : [],
  }
}

/**
 * One next edit after a failed or costly preflight. Score failure rewrites
 * page text and does not move τ. Path risk raises the size floor. A low
 * entered rate lowers τ until the page cap.
 */
export function suggestCut({
  screeningTasks = 0,
  enteredRate = 0,
  pathRisk = false,
  scoreMedian = null,
  pageCount = 0,
  pageCap = DEFAULT_PAGE_CAP,
} = {}) {
  if (!screeningTasks) {
    return { action: 'need-screening', reason: 'preflight has no screening tasks, so τ and page text stay frozen' }
  }
  if (!pageCount) {
    return { action: 'lower-min-members', reason: 'no cluster met the size floor' }
  }
  if (!(scoreMedian > 0)) {
    return { action: 'rewrite-summaries', reason: 'cluster pages have no lexical overlap with screening prompts; do not move τ' }
  }
  if (pathRisk) {
    return { action: 'raise-min-members', reason: 'a cluster page displaced a path-bearing page without carrying that path' }
  }
  if (!(enteredRate >= ENTERED_RATE_MIN)) {
    if (pageCount >= pageCap) {
      return { action: 'hold-page-cap', reason: `already at ${pageCount} pages; lowering τ would crowd the search slots` }
    }
    return { action: 'lower-tau', reason: 'clusters are too coarse to enter the top search slots' }
  }
  return { action: 'freeze', reason: 'screening preflight passed; freeze τ, membership, and page text before confirmation' }
}

/**
 * Build pages from a neighbour graph and score caller-supplied search hits.
 * This does not call the bank. Search hits stay whatever the two banks returned.
 */
export function runPreflight(input = {}) {
  const tau = Number.isFinite(Number(input.tau)) ? Number(input.tau) : Infinity
  const minMembers = Number.isFinite(Number(input.minMembers)) ? Number(input.minMembers) : DEFAULT_MIN_MEMBERS
  const forest = minimumSpanningForest(input.edges)
  const clusters = cutForest(forest, { tau, minMembers })
  const texts = input.texts && typeof input.texts === 'object' ? input.texts : {}
  const pages = clusters.map((cluster) => buildClusterPage({
    id: cluster.id,
    texts: cluster.members.map((id) => (typeof texts[id] === 'string' ? texts[id] : '')),
    path: input.path,
    commit: input.commit,
    tau,
    tokenBudget: input.tokenBudget,
  }))
  const clusterIds = pages.map((page) => page.id)
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const rows = tasks.map((task) => {
    const ids = Array.isArray(task.clusterIds) ? task.clusterIds : clusterIds
    const report = slotReport({
      baseline: task.baseline ?? [],
      treatment: task.treatment ?? [],
      clusterIds: ids,
      prompt: task.prompt ?? '',
    })
    const ratio = tokenRatio(task.baseline ?? [], task.treatment ?? [])
    return {
      id: task.id ?? null,
      set: task.set,
      entered: report.entered.length,
      pathRisk: report.pathRisk.length > 0,
      score: report.scores.length > 0 ? Math.max(...report.scores) : 0,
      scores: report.scores,
      r: ratio.r,
      report,
      ratio,
    }
  })
  const decision = preflightDecision(rows)
  const suggestion = suggestCut({
    screeningTasks: decision.screeningTasks,
    enteredRate: decision.enteredRate,
    pathRisk: decision.pathRiskTasks.length > 0,
    scoreMedian: decision.medianScore,
    pageCount: pages.length,
    pageCap: Number.isFinite(Number(input.pageCap)) ? Number(input.pageCap) : DEFAULT_PAGE_CAP,
  })
  return { forest, clusters, pages, rows, decision, suggestion }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: node eval/cluster-preflight.mjs <preflight.json>\n')
    process.exit(1)
  }
  let input
  try {
    input = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    process.stderr.write(`cluster-preflight: cannot read ${file}: ${error.message}\n`)
    process.exit(1)
  }
  const result = runPreflight(input)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
