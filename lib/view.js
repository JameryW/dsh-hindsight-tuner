/**
 * Budgeted View: choose which facts from a recall to inject instead of keeping
 * the prefix.
 *
 * Truncation is cheap but arbitrary: when a recall is larger than the turn's
 * budget, cutting the tail can throw away the one paragraph that matches the
 * task. This module splits the recall into fact-sized blocks, scores each block
 * against the current turn's own text (file paths, identifiers, error strings),
 * and spends the budget on the blocks most likely to matter. It stays
 * dependency-free and explainable: the score is lexical overlap plus explicit
 * evidence pointers, and the injected text carries a footer saying how much was
 * kept and a source note naming the commit/page/path evidence found in a block.
 *
 * Nothing here talks to Hindsight or reads the filesystem; the caller passes the
 * turn's non-memory text and a token counter, so the policy is testable alone.
 */
import { estimateTokens, splitBlocks } from './tokens.js'

export const VIEW_POLICIES = ['truncate', 'budgeted']

/** How many recent non-memory messages describe the current task. */
export const DEFAULT_VIEW_CONTEXT_MESSAGES = 8

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'are', 'was',
  'were', 'have', 'has', 'had', 'but', 'you', 'your', 'our', 'its', 'can',
  'could', 'should', 'would', 'use', 'using', 'used', 'into', 'than', 'then',
  'when', 'what', 'which', 'while', 'also', 'just', 'only', 'more', 'most',
  'some', 'any', 'all', 'one', 'two', 'new', 'old', 'get', 'got', 'make',
  'made', 'see', 'look', 'like', 'need', 'want', 'must', 'may', 'might',
  'will', 'does', 'did', 'done', 'add', 'adds', 'added', 'fix', 'fixes',
  'fixed', 'test', 'tests', 'code', 'file', 'files', 'run', 'runs', 'ran',
  'memory', 'recall', 'page', 'pages', 'note', 'notes',
])

const CODE_TOKEN = /[A-Za-z_$][\w$.@/-]{2,}/g
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{2,}/g
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g
const PATH_HINT = /`([^`\n]{2,120}?\.(?:[cm]?[jt]sx?|md|json|ya?ml|py|go|rs|java|toml))`/g
const COMMIT_HINT = /\b(?:commit|sha|revision)[: =#]*([0-9a-f]{7,40})\b/gi
const PAGE_HINT = /\bpage(?:Id| id)?[: =#]+([A-Za-z0-9_-]{6,})/gi

function addTerm(terms, term, weight) {
  const clean = String(term ?? '').trim().toLowerCase()
  if (clean.length < 2) return
  terms.set(clean, (terms.get(clean) ?? 0) + weight)
}

/** camelCase / snake_case subwords of an identifier, e.g. trimToBudget → trim, budget. */
function subwordsOf(match) {
  return String(match ?? '')
    .replace(CAMEL_BOUNDARY, '$1 $2')
    .split(/[^A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3)
}

/**
 * Terms from the current turn that a useful recall block should mention.
 * Backticked identifiers and slash-paths are weighted above plain words because
 * they name exact code, not a topic. Compound identifiers also contribute their
 * camelCase/snake_case subwords (with a smaller weight), and a long Chinese run
 * its 2/3-grams: a paragraph that says "budget trimming" or repeats a Chinese
 * phrase is relevant even when the exact token differs.
 */
export function extractTerms(text) {
  const terms = new Map()
  const source = String(text ?? '')
  for (const match of source.matchAll(/[\w@.-]+\/[\w@./-]+/g)) addTerm(terms, match[0], 4)
  for (const match of source.matchAll(/`([^`\n]{2,80})`/g)) addTerm(terms, match[1], 3)
  for (const match of source.matchAll(CODE_TOKEN)) {
    const term = match[0].toLowerCase()
    if (term.length < 3 || STOPWORDS.has(term) || /^\d+$/.test(term)) continue
    addTerm(terms, term, 1)
    if (/[A-Z_$./-]/.test(match[0])) {
      for (const sub of subwordsOf(match[0])) {
        if (sub !== term && !STOPWORDS.has(sub)) addTerm(terms, sub, 0.5)
      }
    }
  }
  for (const match of source.matchAll(CJK_RUN)) {
    addTerm(terms, match[0], 1)
    if (match[0].length >= 4) {
      for (let index = 0; index + 2 <= match[0].length; index += 1) addTerm(terms, match[0].slice(index, index + 2), 0.5)
      for (let index = 0; index + 3 <= match[0].length; index += 1) addTerm(terms, match[0].slice(index, index + 3), 0.5)
    }
  }
  return terms
}

/** The recent non-memory text of a claimed batch, newest message last. */
export function taskContextText(messages, sourceKind, limit = DEFAULT_VIEW_CONTEXT_MESSAGES) {
  const parts = []
  for (let index = messages.length - 1; index >= 0 && parts.length < limit; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind === sourceKind) continue
    if (typeof message?.content === 'string') {
      if (message.content) parts.push(message.content)
      continue
    }
    if (!Array.isArray(message?.content)) continue
    const text = message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text) parts.push(text)
  }
  return parts.reverse().join('\n')
}

const WORDY_TERM = /^[a-z][a-z0-9]*$/

/** Match a short prose word without letting it hit inside a longer word. */
function termMatches(haystack, term) {
  if (term.length > 4 || !WORDY_TERM.test(term)) return haystack.includes(term)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(term, from)
    if (at < 0) return false
    const before = at === 0 ? '' : haystack[at - 1]
    const after = haystack[at + term.length] ?? ''
    if (!/[a-z0-9_$]/.test(before) && !/[a-z0-9_$]/.test(after)) return true
    from = at + 1
  }
}

/**
 * Score one block. Overlap is normalized by the square root of the block's size
 * so a long block cannot win on length alone, and a fenced example gets a small
 * bonus: a code sample is more likely to be directly usable than prose.
 */
export function createMatcher(contextText) {
  const terms = extractTerms(contextText)
  if (terms.size === 0) return () => 0
  return function score(block) {
    const haystack = String(block ?? '').toLowerCase()
    let total = 0
    for (const [term, weight] of terms) {
      if (!termMatches(haystack, term)) continue
      total += weight * (term.length >= 7 ? 1.5 : 1)
    }
    if (/^\s*(?:```|~~~)/m.test(haystack) && total > 0) total += 0.25
    return total / Math.sqrt(Math.max(1, estimateTokens(block)))
  }
}

/** Source pointers embedded in a block, rendered with the block so evidence survives selection. */
export function evidenceHints(block) {
  const hints = []
  const text = String(block ?? '')
  for (const match of text.matchAll(COMMIT_HINT)) hints.push(`commit ${match[1]}`)
  for (const match of text.matchAll(PAGE_HINT)) hints.push(`page ${match[1]}`)
  for (const match of text.matchAll(PATH_HINT)) hints.push(`path ${match[1]}`)
  return [...new Set(hints)].slice(0, 2)
}

function render(kept) {
  return kept.map((entry) => entry.block).join('\n\n')
}

const HEADING_LINE = /^\s{0,3}(#{1,6})[ \t]+(\S.*)$/

/** Split a block's leading heading from its body, if it has one. */
function blockHeading(block) {
  const lines = String(block ?? '').split('\n')
  const match = HEADING_LINE.exec(lines[0] ?? '')
  if (!match) return null
  return {
    level: match[1].length,
    title: match[2].trim(),
    bare: lines.slice(1).join('\n').trim().length === 0,
  }
}

/**
 * Record each block's nearest parent heading.
 *
 * A recall often interleaves headings with the paragraphs under them; once it
 * is split into blocks that context is lost. The parent index lets a child
 * inherit part of its heading's relevance and, when it is selected, mount the
 * heading text so the injected paragraph still says what it is about.
 */
function annotateHeadings(entries) {
  const stack = []
  for (const entry of entries) {
    entry.heading = blockHeading(entry.block)
    if (entry.heading) {
      while (stack.length > 0 && entries[stack[stack.length - 1]].heading.level >= entry.heading.level) stack.pop()
      entry.parentHeadingIdx = stack.length > 0 ? stack[stack.length - 1] : null
      stack.push(entry.index)
    } else {
      entry.parentHeadingIdx = stack.length > 0 ? stack[stack.length - 1] : null
    }
  }
}

/**
 * Drop any bare heading that no longer has a selected child under it.
 * Loops to a fixed point so nested bare headings unwind cleanly.
 */
function pruneBareHeadings(entries) {
  let current = entries
  for (;;) {
    const activeParents = new Set(current.map((entry) => entry.parentHeadingIdx).filter((idx) => idx != null))
    const next = current.filter((entry) => !entry.heading?.bare || activeParents.has(entry.index))
    if (next.length === current.length) return current
    current = next
  }
}

/**
 * Pick blocks worth their tokens.
 *
 * @param {object} options
 * @param {string} options.text raw recall text
 * @param {string} options.contextText text of this turn's non-memory messages
 * @param {number} options.budget token ceiling for the rendered result
 * @param {(text: string) => number} options.count exact token counter
 * @returns {{text: string, blocks: number, kept: number, omitted: number, tokens: number, sources: string[]} | null}
 *   null when the input has a single block (nothing to select) or does not fit
 *   at all; the caller then falls back to ordinary truncation.
 */
export function budgetedView({ text, contextText, budget, count = estimateTokens }) {
  if (!Number.isFinite(budget) || budget <= 0) return null
  const blocks = splitBlocks(String(text ?? ''))
  if (blocks.length <= 1) return null
  const score = createMatcher(contextText)
  const scored = blocks.map((block, index) => ({ index, block, tokens: count(block), score: score(block), weight: 0 }))
  annotateHeadings(scored)
  for (const entry of scored) {
    // A child inherits part of its heading's relevance, so a paragraph under a
    // matching heading beats an unrelated paragraph of the same size.
    entry.weight = entry.score + (entry.parentHeadingIdx == null ? 0 : 0.35 * scored[entry.parentHeadingIdx].score)
  }
  const total = scored.reduce((sum, entry) => sum + entry.tokens, 0)
  const relevant = scored
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  // With no lexical signal at all, keep the prefix: same behaviour as truncation
  // but still measured and labelled, so a caller can tell the two modes apart.
  const chosen = new Map()
  let used = 0
  const add = (entry) => {
    if (!chosen.has(entry.index)) {
      chosen.set(entry.index, entry)
      used += entry.tokens
    }
  }
  if (relevant.length > 0) {
    for (const entry of relevant) {
      // A bare heading is never injected on its own: it names content that was
      // not paid for. It is mounted below when one of its children is selected.
      if (entry.heading?.bare) continue
      const needed = []
      if (!chosen.has(entry.index)) needed.push(entry)
      const parentIdx = entry.parentHeadingIdx
      if (parentIdx != null && !chosen.has(parentIdx)) needed.push(scored[parentIdx])
      if (needed.reduce((sum, item) => sum + item.tokens, 0) + used > budget) continue
      for (const item of needed) add(item)
    }
  } else {
    for (const entry of scored) {
      if (used + entry.tokens > budget) continue
      add(entry)
    }
  }
  if (chosen.size === 0) return null

  let kept = pruneBareHeadings([...chosen.values()].sort((a, b) => a.index - b.index))
  if (kept.length === 0) return null
  const footerOf = () => `\n\n…[dsh-hindsight-tuner: budgeted view kept ${kept.length} of ${scored.length} blocks (~${kept.reduce((sum, entry) => sum + entry.tokens, 0)} of ~${total} tokens). Ask Hindsight for the full recall explicitly if you need the rest.]`
  let rendered = `${render(kept)}${footerOf()}`
  // The footer and source notes are part of the payload, so re-check the hard
  // ceiling and give blocks up (lowest weight first) until the result fits,
  // pruning any bare heading orphaned by dropping its children.
  while (count(rendered) > budget && kept.length > 0) {
    kept.sort((a, b) => a.weight - b.weight || b.index - a.index)
    kept.shift()
    kept = pruneBareHeadings(kept.sort((a, b) => a.index - b.index))
    if (kept.length === 0) return null
    rendered = `${render(kept)}${footerOf()}`
  }
  if (kept.length === 0) return null
  const sources = kept.flatMap((entry) => evidenceHints(entry.block))
  return {
    text: rendered,
    blocks: scored.length,
    kept: kept.length,
    omitted: scored.length - kept.length,
    tokens: count(rendered),
    sources: [...new Set(sources)].slice(0, 6),
  }
}
