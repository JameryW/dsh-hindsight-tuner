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
const PATH_HINT = /`([^`\n]{2,120}?\.(?:[cm]?[jt]sx?|md|json|ya?ml|py|go|rs|java|toml))`/g
const COMMIT_HINT = /\b(?:commit|sha|revision)[: =#]*([0-9a-f]{7,40})\b/gi
const PAGE_HINT = /\bpage(?:Id| id)?[: =#]+([A-Za-z0-9_-]{6,})/gi

function addTerm(terms, term, weight) {
  const clean = String(term ?? '').trim().toLowerCase()
  if (clean.length < 2) return
  terms.set(clean, (terms.get(clean) ?? 0) + weight)
}

/**
 * Terms from the current turn that a useful recall block should mention.
 * Backticked identifiers and slash-paths are weighted above plain words because
 * they name exact code, not a topic.
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
  }
  for (const match of source.matchAll(CJK_RUN)) addTerm(terms, match[0], 1)
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
      if (!haystack.includes(term)) continue
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
  const scored = blocks.map((block, index) => ({ index, block, tokens: count(block), score: score(block) }))
  const total = scored.reduce((sum, entry) => sum + entry.tokens, 0)
  const relevant = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
  // With no lexical signal at all, keep the prefix: same behaviour as truncation
  // but still measured and labelled, so a caller can tell the two modes apart.
  const order = relevant.length > 0 ? relevant : scored

  const chosen = []
  let used = 0
  // The first block is not special-cased as a heading: a recall can begin with an
  // old note whose heading has nothing to do with this task, and paying for it
  // would reproduce the prefix bias this mode exists to remove.
  for (const entry of order) {
    if (used + entry.tokens > budget) continue
    chosen.push(entry)
    used += entry.tokens
  }
  if (chosen.length === 0) return null

  const kept = chosen.sort((a, b) => a.index - b.index)
  const footerOf = () => `\n\n…[dsh-hindsight-tuner: budgeted view kept ${kept.length} of ${scored.length} blocks (~${kept.reduce((sum, entry) => sum + entry.tokens, 0)} of ~${total} tokens). Ask Hindsight for the full recall explicitly if you need the rest.]`
  let rendered = `${render(kept)}${footerOf()}`
  // The footer and source notes are part of the payload, so re-check the hard
  // ceiling and give blocks up (lowest score first) until the result fits.
  while (count(rendered) > budget && kept.length > 0) {
    kept.sort((a, b) => a.score - b.score || b.index - a.index)
    kept.shift()
    kept.sort((a, b) => a.index - b.index)
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
