import assert from 'node:assert/strict'

import { estimateTokens } from '../lib/tokens.js'
import { evidenceHints } from '../lib/view.js'
import {
  buildClusterPage,
  cutForest,
  minimumSpanningForest,
  preflightDecision,
  runPreflight,
  signatureTerms,
  slotReport,
  suggestCut,
  tokenRatio,
} from '../eval/cluster-preflight.mjs'

const member = (path, symbol, extra = '') =>
  `See \`${path}\` when ${symbol} runs after compaction. ${extra}`.trim()

const texts = [
  member('lib/governor.js', 'lastInjectionState', 'The shadow seq decides reinject.'),
  member('lib/governor.js', 'lastInjectionState', 'repeatPolicy compares delivered text.'),
  member('lib/governor.js', 'reinject', 'lastInjectionState walks the session log.'),
  member('lib/tokens.js', 'once-only-symbol', 'This hapax path-like word zz_only appears once.'),
]

// --- forest -----------------------------------------------------------------
const forest = minimumSpanningForest([
  { source: 'b', target: 'c', weight: 0.4 },
  { source: 'a', target: 'b', weight: 0.2 },
  { source: 'a', target: 'c', weight: 0.9 },
  { source: 'a', target: 'b', weight: 0.5 },
  { source: 'b', target: 'a', weight: 0.7 },
  { source: 'a', target: 'a', weight: 0.1 },
  { source: '', target: 'z', weight: 0.01 },
  { source: 'a', target: 'b', weight: Number.NaN },
])
assert.deepEqual(
  forest.map((edge) => [edge.source, edge.target, edge.weight]),
  [['a', 'b', 0.2], ['b', 'c', 0.4]],
  'Kruskal keeps the lighter parallel edge and drops the cycle',
)
assert.deepEqual(
  minimumSpanningForest(forest.map((edge) => ({ source: edge.target, target: edge.source, weight: edge.weight })).reverse()),
  forest,
  'the same undirected edges produce the same forest',
)

const clusters = cutForest(
  [
    { source: 'a', target: 'b', weight: 0.1 },
    { source: 'b', target: 'c', weight: 0.2 },
    { source: 'c', target: 'd', weight: 0.8 },
    { source: 'd', target: 'e', weight: 0.1 },
  ],
  { tau: 0.3, minMembers: 2 },
)
assert.deepEqual(clusters.map((cluster) => cluster.members), [['a', 'b', 'c'], ['d', 'e']], 'edges heavier than tau split the forest')
assert.deepEqual(
  cutForest(
    [
      { source: 'a', target: 'b', weight: 0.1 },
      { source: 'b', target: 'c', weight: 0.2 },
      { source: 'c', target: 'd', weight: 0.8 },
      { source: 'd', target: 'e', weight: 0.1 },
    ],
    { tau: 0.3, minMembers: 2 },
  ),
  clusters,
  'the same cut yields the same membership',
)
assert.equal(clusters[0].id, 'cluster:a', 'cluster id is the smallest member')
assert.deepEqual(cutForest(clusters.length ? [{ source: 'a', target: 'b', weight: 0.1 }] : [], { tau: 0.3, minMembers: 8 }), [], 'a pair below the size floor is not a page')

// --- signature and page ------------------------------------------------------
const terms = signatureTerms(texts)
assert.ok(terms.some((entry) => entry.term === 'lib/governor.js' && entry.weight === 3), 'a repeated path outranks prose')
assert.ok(!terms.some((entry) => entry.term.includes('zz_only') || entry.term === 'once-only-symbol'), 'a term in one member is not a signature')

const page = buildClusterPage({
  id: 'cluster:governor',
  texts,
  path: 'lib/governor.js',
  commit: 'abc1234',
  tau: 0.18,
  tokenBudget: 300,
})
assert.equal(page.documentId, 'cluster:governor')
assert.deepEqual(page.tags, ['cluster:governor'], 'the page carries only its cluster tag')
assert.ok(page.tokens <= 300, `page fits the token budget (${page.tokens})`)
assert.match(page.content, /lastInjectionState/, 'the quoted sentence comes from a member')
assert.doesNotMatch(page.content, /screening-prompt-marker/, 'page text is not taken from a task prompt')
const hints = evidenceHints(page.content)
assert.ok(hints.some((hint) => hint.includes('lib/governor.js')), `path anchor visible: ${hints.join(', ')}`)
assert.ok(hints.some((hint) => hint.includes('abc1234')), `commit anchor visible: ${hints.join(', ')}`)

const bloated = Array.from({ length: 6 }, () => `${member('lib/governor.js', 'lastInjectionState')} ${'identifier_token '.repeat(80)}`)
const trimmed = buildClusterPage({ id: 'cluster:governor', texts: bloated, path: 'lib/governor.js', commit: 'abc1234', tau: 0.2, tokenBudget: 80 })
assert.ok(trimmed.tokens <= 80, `tight budget holds (${trimmed.tokens})`)
assert.match(trimmed.content, /`lib\/governor\.js`/, 'the path anchor survives trimming')
assert.match(trimmed.content, /commit abc1234/, 'the commit line survives trimming')
const foreign = buildClusterPage({
  id: 'cluster:governor',
  texts,
  path: 'lib/not-in-members.js',
  commit: 'abc1234',
  tau: 0.18,
})
assert.match(foreign.content, /`lib\/governor\.js`/)
assert.doesNotMatch(foreign.content, /not-in-members/)

const memberSentence = 'See `lib/governor.js` when lastInjectionState runs after compaction.'
assert.ok(texts.some((text) => text.includes(memberSentence)))
const anchorsAndSentence = `path \`lib/governor.js\`\ncommit abc1234\n\n${memberSentence}\n`
assert.ok(estimateTokens(anchorsAndSentence) <= 50, 'the member sentence itself fits in 50 tokens')
const fitted = buildClusterPage({
  id: 'cluster:governor',
  texts,
  path: 'lib/governor.js',
  commit: 'abc1234',
  tau: 0.18,
  tokenBudget: 50,
})
assert.ok(fitted.tokens <= 50, `budget 50 holds (${fitted.tokens})`)
assert.ok(fitted.content.includes(memberSentence), 'a budget that fits the member sentence keeps it')
assert.doesNotMatch(fitted.content, /single-linkage cluster/, 'the footer is shed before the member sentence')

// --- search slots ------------------------------------------------------------
const prompt = 'Fix reinject in lib/governor.js after compaction'
const baseline = [
  { id: 'page-decisions', name: 'Key decisions', content: 'See `lib/governor.js` for reinject.' },
  { id: 'page-map', name: 'Component map', content: 'Broad map of the repo.' },
]
const treatment = [
  { id: 'cluster:governor', name: 'Cluster: lib/governor.js', content: page.content },
  { id: 'page-map', name: 'Component map', content: 'Broad map of the repo.' },
]
const slots = slotReport({ baseline, treatment, clusterIds: ['cluster:governor'], prompt })
assert.deepEqual(slots.entered, ['cluster:governor'])
assert.deepEqual(slots.displaced, ['page-decisions'])
assert.ok(slots.scores[0] > 0, 'the cluster page shares terms with the prompt')
assert.equal(slots.pathRisk.length, 0, 'the cluster page still carries the displaced path')

const risky = slotReport({
  baseline,
  treatment: [{ id: 'cluster:other', name: 'Cluster: other', content: 'No file is named here.' }, baseline[1]],
  clusterIds: ['cluster:other'],
  prompt,
})
assert.ok(risky.pathRisk.some((item) => item.term === 'lib/governor.js'), 'displacing a path without carrying it is a risk')

const ratio = tokenRatio(baseline, treatment)
assert.ok(ratio.r > 1, 'a longer cluster page raises tokens per attempt')
assert.ok(ratio.attemptsFactor < 1, 'attempts must fall below 1/r of baseline')

// --- gates -------------------------------------------------------------------
const decision = preflightDecision([
  { id: 's1', set: 'screening', entered: 1, pathRisk: false, score: 4, scores: [4], r: 1.2 },
  { id: 's2', set: 'screening', entered: 1, pathRisk: false, score: 2, scores: [2], r: 1.1 },
  { id: 'c1', set: 'confirmation', entered: 0, pathRisk: true, score: 0, r: 9 },
  { id: 'u1', set: '', entered: 0, pathRisk: false, score: 0, r: 9 },
])
assert.equal(decision.pass, true, decision.reasons.join('; '))
assert.equal(decision.readyForConfirmation, true)
assert.equal(decision.attemptsFactor, 1 / decision.medianR)
assert.equal(decision.screeningTasks, 2, 'confirmation and unlabeled tasks do not tune the cut')
assert.equal(decision.ignored.length, 2)
assert.ok(decision.medianR <= 1.5)

const blocked = preflightDecision([
  { id: 's1', set: 'screening', entered: 0, pathRisk: false, score: 0, r: 2 },
  { id: 's2', set: 'train', entered: 1, pathRisk: true, score: 0, scores: [0], r: 2 },
  { id: 's3', set: 'screening', entered: 0, pathRisk: false, score: 0, r: 2 },
  { id: 's4', set: 'dev', entered: 0, pathRisk: false, score: 0, r: 2 },
])
assert.equal(blocked.pass, false)
assert.ok(blocked.reasons.some((reason) => reason.startsWith('entered rate')), blocked.reasons.join('; '))
assert.ok(blocked.pathRiskTasks.includes('s2'))

const costly = preflightDecision([
  { id: 's1', set: 'screening', entered: 1, pathRisk: false, scores: [3], r: 2 },
  { id: 's2', set: 'screening', entered: 1, pathRisk: false, scores: [4], r: 2 },
])
assert.equal(costly.pass, true, costly.reasons.join('; '))
assert.equal(costly.readyForConfirmation, false)
assert.equal(costly.medianR, 2)
assert.equal(costly.attemptsFactor, 1 / costly.medianR)

assert.equal(suggestCut({ screeningTasks: 0 }).action, 'need-screening')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 0, enteredRate: 0, scoreMedian: 0 }).action, 'lower-min-members')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 3, enteredRate: 0.1, scoreMedian: 0, pathRisk: true }).action, 'rewrite-summaries')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 3, enteredRate: 0.1, scoreMedian: 2, pathRisk: true }).action, 'raise-min-members')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 3, enteredRate: 0.1, scoreMedian: 2, pathRisk: false }).action, 'lower-tau')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 10, enteredRate: 0.1, scoreMedian: 2, pathRisk: false }).action, 'hold-page-cap')
assert.equal(suggestCut({ screeningTasks: 4, pageCount: 3, enteredRate: 0.5, scoreMedian: 2, pathRisk: false }).action, 'freeze')

// --- combined run, held-out prompt absent from pages -------------------------
const prepared = runPreflight({
  tau: 0.3,
  minMembers: 2,
  commit: 'abc1234',
  edges: [
    { source: 'g1', target: 'g2', weight: 0.1 },
    { source: 'g2', target: 'g3', weight: 0.2 },
    { source: 'g3', target: 't1', weight: 0.9 },
  ],
  texts: {
    g1: texts[0],
    g2: texts[1],
    g3: texts[2],
    t1: 'unrelated tokens.js note that should split off',
  },
  tasks: [
    {
      id: 'screen',
      set: 'screening',
      prompt,
      clusterIds: ['cluster:governor'],
      baseline,
      treatment,
    },
    {
      id: 'held',
      set: 'confirmation',
      prompt: 'SECRET_CONFIRMATION_PHRASE lib/other.js',
      baseline,
      treatment,
    },
  ],
})
assert.deepEqual(prepared.clusters.map((cluster) => cluster.id), ['cluster:g1'])
assert.ok(!prepared.pages.some((entry) => entry.content.includes('SECRET_CONFIRMATION_PHRASE')))
assert.equal(prepared.decision.pass, true, prepared.decision.reasons.join('; '))
assert.equal(prepared.suggestion.action, 'freeze')

console.log('cluster-preflight: ok')
