/**
 * Token accounting for the budget.
 *
 * `fast` is a dependency-free estimate: one token per CJK character, 0.28 per
 * other character, and 0.38 inside fenced code blocks. The CJK weight is a
 * deliberate upper bound — DeepSeek's own tokenizer averages closer to 0.6 tokens
 * per Chinese character, so a purely Chinese recall is counted at roughly 1.7x
 * its real size. That under-fills the ceiling instead of overshooting it: the
 * ceiling is a promise to the host, and over-counting is the safe direction.
 * Use `accurate` for a tighter number.
 *
 * `accurate` counts with an OpenAI-compatible tokenizer (`js-tiktoken`,
 * `tiktoken` or `@dqbd/tiktoken`, optional and loaded lazily). It prefers the
 * current `o200k_base` vocabulary (what `gpt-4o` uses) and falls back to
 * `cl100k_base` when the installed package predates it; upstream Hindsight
 * 0.10.x made the same move, and the older vocabulary over-counts Chinese and
 * code by roughly 12–18%. That is still an approximation, not DeepSeek's own
 * tokenizer, and it is only as good as the encoding it happens to load;
 * `status` names the encoding that was used. When no tokenizer is available it
 * falls back to the fast estimate with a safety margin and says so in `status` —
 * it never silently claims accuracy.
 */

const CJK_TOKENS_PER_CHAR = 1
const OTHER_TOKENS_PER_CHAR = 0.28
// Dense code tokenizes heavier than prose: measured coding-agent samples run
// around 0.38 tokens per character inside fenced blocks. Counting those at the
// prose rate under-estimates the payload exactly where it is densest.
const FENCE_TOKENS_PER_CHAR = 0.38

const CJK = [
  [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xac00, 0xd7af], [0xf900, 0xfaff], [0xff00, 0xffef],
]

function isCjk(code) {
  for (const [low, high] of CJK) if (code >= low && code <= high) return true
  return false
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 13 || code === 11 || code === 12 || code === 160
}

/**
 * Inspect fence transitions on slice `text[start..end)` without slicing every line.
 * Equivalent to `stepFence(fence, text.slice(start, end))` for CommonMark backtick/tilde fences.
 */
function stepFenceSlice(fence, text, start, end) {
  let pos = start
  while (pos < end) {
    const ch = text.charCodeAt(pos)
    if (ch <= 32 || ch >= 127) {
      if (isSpaceCode(ch) || (ch >= 127 && /\s/.test(text[pos]))) {
        pos += 1
        continue
      }
    }
    break
  }
  if (fence === null) {
    if (pos + 2 >= end) return { fence: null, event: null }
    const marker = text.charCodeAt(pos)
    if (marker !== 96 && marker !== 126) return { fence: null, event: null }
    let runEnd = pos + 1
    while (runEnd < end && text.charCodeAt(runEnd) === marker) runEnd += 1
    const runLen = runEnd - pos
    if (runLen < 3) return { fence: null, event: null }
    if (marker === 96) {
      const nextTick = text.indexOf('`', runEnd)
      if (nextTick !== -1 && nextTick < end) return { fence: null, event: null }
    }
    return { fence: { char: marker === 96 ? '`' : '~', length: runLen }, event: 'open' }
  }
  const marker = fence.char.charCodeAt(0)
  if (pos >= end || text.charCodeAt(pos) !== marker) return { fence, event: 'inside' }
  let runEnd = pos + 1
  while (runEnd < end && text.charCodeAt(runEnd) === marker) runEnd += 1
  if (runEnd - pos < fence.length) return { fence, event: 'inside' }
  let tail = runEnd
  while (tail < end) {
    const ch = text.charCodeAt(tail)
    if (isSpaceCode(ch) || (ch >= 127 && /\s/.test(text[tail]))) {
      tail += 1
      continue
    }
    return { fence, event: 'inside' }
  }
  return { fence: null, event: 'close' }
}

/** Fast, dependency-free single-pass estimate with zero per-line string allocations. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let fenced = 0
  let fence = null
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    const inside = next.event === 'inside'
    for (let i = lineStart; i < lineEnd; ) {
      const code = text.codePointAt(i)
      if (isCjk(code)) cjk += 1
      else if (inside) fenced += 1
      i += code > 0xffff ? 2 : 1
    }
    fence = next.fence
    if (nl === -1) break
    lineStart = nl + 1
  }
  const other = len - cjk - fenced
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR + fenced * FENCE_TOKENS_PER_CHAR)
}

/** Safety margin applied when `accurate` mode requested but no tokenizer exists. */
export const FALLBACK_MARGIN = 1.1
export const TOKEN_BUDGET_MODES = ['fast', 'calibrated', 'accurate']

const CALIBRATED_CHUNK = /'[A-Za-z]{1,2}| ?[A-Za-z]+|\d{1,3}|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+|\s+|./gu
const CALIBRATED_SUBWORD = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g

function isAsciiAlpha(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/**
 * Built-in zero-dependency structural BPE estimator (`calibrated` mode).
 *
 * Splits contractions, space-prefixed words (and camelCase/ALLCAPS subwords),
 * 1..3 digit runs, ASCII operator runs, indentation runs, CJK characters, and
 * non-ASCII symbols similarly to `o200k_base` / DeepSeek V3 BPE, while staying
 * strictly monotonic in prefix length so binary-search trimming stays exact.
 */
export function estimateCalibratedTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let total = 0
  for (const match of text.matchAll(CALIBRATED_CHUNK)) {
    const chunk = match[0]
    const first = chunk.codePointAt(0)
    if (first <= 32 || (first >= 127 && /^\s+$/u.test(chunk))) {
      total += Math.ceil(chunk.length / 4)
      continue
    }
    if (isCjk(first)) {
      total += 0.85
      continue
    }
    if (first === 39 && chunk.length > 1 && chunk.length <= 3 && isAsciiAlpha(chunk.charCodeAt(1))) {
      total += 1
      continue
    }
    const wordStart = first === 32 ? 1 : 0
    if (wordStart < chunk.length && isAsciiAlpha(chunk.charCodeAt(wordStart))) {
      const word = wordStart === 0 ? chunk : chunk.slice(1)
      CALIBRATED_SUBWORD.lastIndex = 0
      let sub
      while ((sub = CALIBRATED_SUBWORD.exec(word)) !== null) {
        total += Math.ceil(sub[0].length / 5)
      }
      continue
    }
    if (first >= 48 && first <= 57) {
      total += 1
      continue
    }
    if (first > 127) {
      total += 1.5
    } else {
      total += Math.ceil(chunk.length / 3)
    }
  }
  return Math.ceil(total)
}

/**
 * Count tokens according to the configured mode.
 * Returns `{ tokens, mode, exact }`: `exact` is false when accurate mode had to
 * fall back to the estimate.
 */
export function countTokens(text, { mode = 'fast', encode } = {}) {
  if (typeof text !== 'string' || text.length === 0) return { tokens: 0, mode, exact: true }
  if (mode === 'calibrated') {
    return { tokens: estimateCalibratedTokens(text), mode: 'calibrated', exact: true }
  }
  if (mode === 'accurate' && typeof encode === 'function') {
    try {
      const tokens = encode(text)
      if (Number.isFinite(tokens) && tokens >= 0) return { tokens, mode, exact: true }
    } catch {
      // fall through to the estimate; a broken optional tokenizer must not break a turn
    }
  }
  const estimate = estimateTokens(text)
  return {
    tokens: mode === 'accurate' ? Math.ceil(estimate * FALLBACK_MARGIN) : estimate,
    mode,
    exact: mode === 'fast',
  }
}

/**
 * Open the best encoding a tokenizer package exposes.
 *
 * Order matters: `o200k_base` first (it is what `gpt-4o` uses and what upstream
 * Hindsight 0.10.x moved to), then the older `cl100k_base`. Some packages only
 * ship `encodingForModel`/`getEncoding`, others only the `Tiktoken` constructor,
 * so each is tried defensively and a broken package is skipped.
 */
function openEncoding(mod) {
  const attempts = []
  if (typeof mod.encodingForModel === 'function') {
    attempts.push(() => ({ encoding: mod.encodingForModel('gpt-4o'), label: 'gpt-4o' }))
    attempts.push(() => ({ encoding: mod.encodingForModel('gpt-4-turbo'), label: 'cl100k_base' }))
  }
  if (typeof mod.getEncoding === 'function') {
    attempts.push(() => ({ encoding: mod.getEncoding('o200k_base'), label: 'o200k_base' }))
    attempts.push(() => ({ encoding: mod.getEncoding('cl100k_base'), label: 'cl100k_base' }))
  }
  if (typeof mod.Tiktoken === 'function') {
    attempts.push(() => ({ encoding: new mod.Tiktoken('o200k_base'), label: 'o200k_base' }))
    attempts.push(() => ({ encoding: new mod.Tiktoken('cl100k_base'), label: 'cl100k_base' }))
  }
  for (const attempt of attempts) {
    try {
      const opened = attempt()
      if (opened?.encoding && typeof opened.encoding.encode === 'function') return opened
    } catch {
      // this vocabulary/constructor is not available; try the next one
    }
  }
  return null
}

/**
 * Resolve an optional tokenizer once; returns null when none is installed.
 *
 * The vocabularies these packages carry are OpenAI's (`o200k_base` preferred,
 * `cl100k_base` as the fallback). That makes the count a good approximation for
 * mixed Latin and code text and a rough one for Chinese; it is deliberately not
 * presented as DeepSeek's own tokenizer. `name` is surfaced in `status` so the
 * active encoding is visible.
 */
let tokenizerPromise
export function loadTokenizer() {
  tokenizerPromise ??= (async () => {
    for (const id of ['js-tiktoken', 'tiktoken', '@dqbd/tiktoken']) {
      try {
        const mod = await import(id)
        const opened = openEncoding(mod)
        if (opened) {
          return { name: `${id} (${opened.label})`, encode: (text) => opened.encoding.encode(text).length }
        }
      } catch {
        // keep looking; the package is optional
      }
    }
    return null
  })()
  return tokenizerPromise
}

function estimateFromCounts(offset, cjk, fenced) {
  const other = offset - cjk - fenced
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR + fenced * FENCE_TOKENS_PER_CHAR)
}

function findCutOffsetForEstimate(text, usable) {
  let cjk = 0
  let fenced = 0
  let best = 0
  let fence = null
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    const inside = next.event === 'inside'
    let i = lineStart
    while (i < lineEnd) {
      const code = text.codePointAt(i)
      if (isCjk(code)) cjk += 1
      else if (inside) fenced += 1
      i += code > 0xffff ? 2 : 1
      if (estimateFromCounts(i, cjk, fenced) <= usable) best = i
      else return best
    }
    fence = next.fence
    if (nl === -1) break
    const afterNl = nl + 1
    if (estimateFromCounts(afterNl, cjk, fenced) <= usable) best = afterNl
    else return best
    lineStart = afterNl
  }
  return best
}

function findBoundaryIndexForEstimate(text, offsets, usable) {
  if (offsets.length === 0) return -1
  let cjk = 0
  let fenced = 0
  let offset = 0
  let idx = 0
  let foundIdx = -1
  let fence = null
  const checkBoundaries = () => {
    while (idx < offsets.length && offsets[idx] <= offset) {
      if (estimateFromCounts(offset, cjk, fenced) <= usable) foundIdx = idx
      else return false
      idx += 1
    }
    return idx < offsets.length
  }
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    const inside = next.event === 'inside'
    let i = lineStart
    while (i < lineEnd) {
      if (!checkBoundaries()) return foundIdx
      const code = text.codePointAt(i)
      if (isCjk(code)) cjk += 1
      else if (inside) fenced += 1
      i += code > 0xffff ? 2 : 1
      offset = i
    }
    fence = next.fence
    if (nl === -1) break
    if (!checkBoundaries()) return foundIdx
    offset = nl + 1
    lineStart = nl + 1
  }
  checkBoundaries()
  return foundIdx
}

function stripTrailingHeadings(text) {
  let previous
  let current = text.replace(/\s+$/, '')
  do {
    previous = current
    current = current.replace(/(?:^|\n+)#{1,6}(?:[ \t][^\n]*)?$/, '').replace(/\s+$/, '')
  } while (current !== previous)
  return current
}

function safeSurrogateCut(text, cut) {
  if (cut <= 0 || cut >= text.length) return cut
  const code = text.charCodeAt(cut - 1)
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut
}

function stepFence(fence, rawLine) {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (fence === null) {
    const open = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      return { fence: { char: open[1][0], length: open[1].length }, event: 'open' }
    }
    return { fence: null, event: null }
  }
  const trimmed = line.trim()
  if (trimmed.length >= fence.length && trimmed === fence.char.repeat(trimmed.length)) {
    return { fence: null, event: 'close' }
  }
  return { fence, event: 'inside' }
}

function isBlankSlice(text, start, end) {
  for (let i = start; i < end; i += 1) {
    const ch = text.charCodeAt(i)
    if (isSpaceCode(ch) || (ch >= 127 && /\s/.test(text[i]))) continue
    return false
  }
  return true
}

function headingLevelAt(text, start, end, minLevel, maxLevel) {
  let pos = start
  while (pos < end && text.charCodeAt(pos) === 35) pos += 1
  const level = pos - start
  if (level < minLevel || level > maxLevel || pos >= end) return 0
  const sep = text.charCodeAt(pos)
  return sep === 32 || sep === 9 ? level : 0
}

/**
 * The code fence left open by `text`, if the text ends inside one.
 *
 * A character-level cut can land in the middle of a fenced block. Truncation
 * must not hand back markdown whose marker sits inside an unterminated fence —
 * the rest of the message would be rendered as code.
 */
function openFenceAt(text) {
  let fence = null
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    fence = stepFenceSlice(fence, text, lineStart, lineEnd).fence
    if (nl === -1) break
    lineStart = nl + 1
  }
  return fence
}

/** Close a trailing open fence with its own marker so the markdown stays valid. */
function closeOpenFence(text, fence = openFenceAt(text)) {
  if (!fence) return text
  return `${text}\n${fence.char.repeat(fence.length)}\n`
}

/**
 * Lexical terms from the current user message, used to reorder recall sections
 * before a trim.
 *
 * Deliberately simple and dependency-free: code identifiers, dotted or
 * path-like words, and CJK runs of two or more characters, lowercased and
 * de-duplicated. Compound identifiers are also broken into their camelCase /
 * snake_case subwords, and long CJK runs into 2/3-grams, so `trimToBudget` can
 * match a paragraph that says "budget trimming" and a Chinese paragraph that
 * shares only a phrase. There is no stemming and no stop-word list — a false
 * hit only affects the order of sections, never whether a section is kept.
 */
const QUERY_TERM = /[A-Za-z_$][\w$./-]{2,}|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]{2,}/g
export const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g

/** Subwords of a compound identifier (`trimToBudget` → trim, to, budget). */
export function querySubwords(match) {
  const parts = String(match ?? '')
    .replace(CAMEL_BOUNDARY, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
  return parts.map((part) => part.toLowerCase()).filter((part) => part.length >= 3)
}

export function extractQueryTerms(queryText) {
  const terms = new Set()
  if (typeof queryText !== 'string' || queryText.length === 0) return terms
  for (const match of queryText.match(QUERY_TERM) ?? []) {
    const term = match.toLowerCase()
    if (term.length >= 2) terms.add(term)
    if (/[^\x00-\x7f]/.test(match) && match.length >= 4) {
      // CJK has no spaces: a phrase match has to come from n-grams.
      for (let index = 0; index + 2 <= match.length; index += 1) terms.add(match.slice(index, index + 2))
      for (let index = 0; index + 3 <= match.length; index += 1) terms.add(match.slice(index, index + 3))
      continue
    }
    if (!/[A-Z_$./-]/.test(match)) continue
    for (const part of querySubwords(match)) if (part !== term) terms.add(part)
  }
  return terms
}

/** Heavier weight for terms that look like paths or identifiers, not prose. */
export function queryTermWeight(term) {
  if (/[/.\\]/.test(term)) return 3
  if (/[_$]/.test(term)) return 2
  return /[^\x00-\x7f]/.test(term) ? 2 : 1
}

const WORDY_TERM = /^[a-z][a-z0-9]*$/

function isWordBoundaryChar(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 36
}

/**
 * Match a term without letting a short word match inside a longer one: `fix`
 * must not hit `prefix`, while identifiers keep substring matching because they
 * are specific enough not to collide.
 */
export function termMatches(haystack, term) {
  if (term.length > 4 || !WORDY_TERM.test(term)) return haystack.includes(term)
  let from = 0
  for (;;) {
    const at = haystack.indexOf(term, from)
    if (at < 0) return false
    const beforeOk = at === 0 || !isWordBoundaryChar(haystack.charCodeAt(at - 1))
    const afterAt = at + term.length
    const afterOk = afterAt >= haystack.length || !isWordBoundaryChar(haystack.charCodeAt(afterAt))
    if (beforeOk && afterOk) return true
    from = at + 1
  }
}

export function sectionScore(section, terms) {
  if (terms.size === 0) return 0
  const haystack = section.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!termMatches(haystack, term)) continue
    score += queryTermWeight(term)
  }
  return score
}

/**
 * How strongly `text` matches the current query, in the range 0..1.
 *
 * Used as a budget weight: a candidate the user's turn is about should keep
 * more of its content than an unrelated one when both are over the turn
 * ceiling. Normalising by the maximum possible per-term weight (3) keeps the
 * weight bounded even for long queries; a text with no term hits scores 0.
 */
export function queryRelevance(text, queryText) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const terms = extractQueryTerms(queryText)
  if (terms.size === 0) return 0
  return Math.min(1, sectionScore(text, terms) / (terms.size * 3))
}

/**
 * Reorder `##`–`####` sections so the ones that mention the current query come
 * first, keeping the preamble in place — or, when a ceiling is given, *select*
 * the sections that fit and render them in their original order.
 *
 * The trim is a prefix cut, so section order decides what survives. Scoring by
 * the user's own words spends the ceiling on the recall the turn is actually
 * about instead of whatever the bank happened to return first. With a
 * `maxTokens` ceiling the selection is by score but the retained sections are
 * rendered in document order: reordering the relative order of the sections the
 * model already saw would defeat the host's prefix cache, which only pays for a
 * stable prefix between turns. Without a ceiling the transform is a pure
 * reordering: the same characters are returned, only in a different order, so
 * it cannot change the token count. It is a no-op when the query has no lexical
 * signal or no section matches.
 */
function sectionMeta(section) {
  const nl = section.indexOf('\n')
  const firstLine = nl === -1 ? section : section.slice(0, nl)
  const heading = /^(#{2,4})[ \t]/.exec(firstLine)
  const level = heading ? heading[1].length : 6
  const bare = nl === -1 || section.slice(nl + 1).trim().length === 0
  return { level, bare }
}

export function selectSectionsByQuery(text, queryText, { maxTokens, count = estimateTokens } = {}) {
  if (typeof text !== 'string' || text.length === 0) return { text, dropped: '', selected: false }
  const terms = extractQueryTerms(queryText)
  if (terms.size === 0) return { text, dropped: '', selected: false }

  // Find heading lines outside code fences; splitting inside a fence would move
  // half of a code block into another section and break the pairing.
  const starts = []
  let fence = null
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    if (fence === null && next.event !== 'open' && headingLevelAt(text, lineStart, lineEnd, 2, 4) > 0) {
      starts.push(lineStart)
    }
    fence = next.fence
    if (nl === -1) break
    lineStart = nl + 1
  }
  if (starts.length === 0) return { text, dropped: '', selected: false }

  const preamble = text.slice(0, starts[0])
  const sections = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
  const scored = sections.map((section, index) => ({
    section,
    index,
    score: sectionScore(section, terms),
    ...sectionMeta(section),
  }))
  // Record nearest preceding bare parent heading for each section so a matching
  // child section can pull its container heading along without ever keeping
  // orphaned bare headings on their own.
  const stack = []
  for (const entry of scored) {
    while (stack.length > 0 && scored[stack[stack.length - 1]].level >= entry.level) stack.pop()
    entry.parentIdx = stack.length > 0 && scored[stack[stack.length - 1]].bare ? stack[stack.length - 1] : null
    if (entry.bare) stack.push(entry.index)
  }
  if (!scored.some((entry) => entry.score > 0)) return { text, dropped: '', selected: false }

  const ranked = [...scored].sort((left, right) => right.score - left.score || left.index - right.index)

  let cachedReordered = null
  const computeReordered = () => {
    if (cachedReordered !== null) return cachedReordered
    const emitted = new Set()
    const ordered = []
    const emitWithParents = (entry) => {
      if (entry.parentIdx != null && !emitted.has(entry.parentIdx)) emitWithParents(scored[entry.parentIdx])
      if (!emitted.has(entry.index)) {
        emitted.add(entry.index)
        ordered.push(entry)
      }
    }
    for (const entry of ranked) if (!entry.bare) emitWithParents(entry)
    for (const entry of ranked) if (!emitted.has(entry.index)) emitWithParents(entry)
    cachedReordered = ordered.every((entry, position) => entry.index === position)
      ? text
      : preamble + ordered.map((entry) => entry.section).join('')
    return cachedReordered
  }

  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    // Pick by score, render in the original order. A section that is dropped
    // here is returned in `dropped` so the recoverable marker can still name it.
    let used = count(preamble)
    const kept = new Set()
    for (const entry of ranked) {
      if (entry.bare) continue
      const toAdd = []
      if (!kept.has(entry.index)) toAdd.push(entry)
      let p = entry.parentIdx
      while (p != null) {
        if (!kept.has(p)) toAdd.push(scored[p])
        p = scored[p].parentIdx
      }
      const cost = toAdd.reduce((sum, item) => sum + count(item.section), 0)
      if (used + cost > maxTokens) continue
      used += cost
      for (const item of toAdd) kept.add(item.index)
    }
    if (kept.size === sections.length) return { text, reordered: text, dropped: '', selected: false }
    // Never discard every query-matching section just because it exceeded the
    // ceiling while smaller unrelated sections fit: fall through to score-order
    // reordering so the trim cuts inside the relevant section instead.
    const keptMatch = [...kept].some((index) => !scored[index].bare && scored[index].score > 0)
    if (kept.size > 0 && keptMatch) {
      return {
        text: preamble + sections.filter((_, index) => kept.has(index)).join(''),
        get reordered() { return computeReordered() },
        dropped: sections.filter((_, index) => !kept.has(index)).join(''),
        selected: true,
      }
    }
  }

  const reorderedText = computeReordered()
  return { text: reorderedText, reordered: reorderedText, dropped: '', selected: false }
}

export function prioritizeSectionsByQuery(text, queryText, options = {}) {
  return selectSectionsByQuery(text, queryText, options).text
}

const RECOVERY_TOOLS = 'hindsight_search_pages / hindsight_read_page'

function collectDroppedHeadings(text, titles, { limit, titleChars, initialFence = null }) {
  if (typeof text !== 'string' || text.length === 0 || titles.length >= limit) return
  let fence = initialFence
  let lineStart = 0
  const len = text.length
  while (lineStart <= len && titles.length < limit) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    if (fence === null && next.event !== 'open') {
      const level = headingLevelAt(text, lineStart, lineEnd, 2, 6)
      if (level > 0) {
        const rawTitle = text.slice(lineStart + level + 1, lineEnd)
        const title = rawTitle.replace(/#+\s*$/, '').replace(/\s+/g, ' ').trim()
        if (title && !titles.includes(title)) {
          titles.push(title.length > titleChars ? `${title.slice(0, Math.max(1, titleChars - 1))}…` : title)
        }
      }
    }
    fence = next.fence
    if (nl === -1) break
    lineStart = nl + 1
  }
}

/**
 * Turn a static truncation marker into a recoverable pointer.
 *
 * A bare `…[truncated]` tells the model that memory was cut but not what was
 * cut, so the only recovery is to guess another query. The returned marker
 * factory lists the headings that fell off (and the tools that can fetch them
 * again), for roughly 15–25 tokens. A dropped tail without headings — a single
 * long paragraph — keeps the plain marker unchanged.
 */
export function buildRecoverableMarker(baseMarker, { headings = 2, titleChars = 48, extraDropped = '' } = {}) {
  const base = typeof baseMarker === 'function' ? baseMarker('') : baseMarker
  return (dropped, context = null) => {
    const titles = []
    if (typeof extraDropped === 'string' && extraDropped.length > 0) {
      collectDroppedHeadings(extraDropped, titles, { limit: headings, titleChars, initialFence: null })
    }
    if (typeof dropped === 'string' && dropped.length > 0 && titles.length < headings) {
      collectDroppedHeadings(dropped, titles, {
        limit: headings,
        titleChars,
        initialFence: context?.initialFence ?? null,
      })
    }
    if (titles.length === 0) return base
    const list = titles.map((title) => JSON.stringify(title)).join(', ')
    const noun = titles.length === 1 ? 'section' : 'sections'
    return `${base}\n[cut ${noun} ${list} — recover with ${RECOVERY_TOOLS}]`
  }
}

/** Markers may be a plain string or the factory `buildRecoverableMarker` returns. */
function markerAt(marker, dropped, context = null) {
  return typeof marker === 'function' ? marker(dropped, context) : marker
}

function droppedAfter(text, keptLength, keptOpenFence) {
  if (keptLength >= text.length) return { dropped: '', initialFence: null }
  if (keptLength === 0 || text[keptLength - 1] === '\n') {
    return { dropped: text.slice(keptLength), initialFence: keptOpenFence }
  }
  const nextNewline = text.indexOf('\n', keptLength)
  if (nextNewline < 0) return { dropped: '', initialFence: null }
  return {
    dropped: text.slice(nextNewline + 1),
    initialFence: openFenceAt(text.slice(0, nextNewline)),
  }
}

/**
 * Trim `text` so that `count(result) <= maxTokens`.
 *
 * There is no hidden floor: when no content fits alongside the marker, the
 * result is an empty string so the caller can drop the message entirely and stay
 * inside the budget. A cap of 0 or less disables trimming and returns the input.
 */
export function truncateToBudget(text, maxTokens, marker = '\n\n…[truncated]', count = estimateTokens, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  if (count(text) <= maxTokens) return text

  const minOffset = Number.isFinite(options?.minOffset) && options.minOffset > 0 ? options.minOffset : 0
  const markerTokens = count(markerAt(marker, ''))
  if (markerTokens >= maxTokens) {
    // Not enough room for even one token of content alongside the marker.
    return ''
  }

  const usable = maxTokens - markerTokens
  let low = 0
  if (count === estimateTokens) {
    low = findCutOffsetForEstimate(text, usable)
  } else {
    let high = text.length
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (count(text.slice(0, safeSurrogateCut(text, middle))) <= usable) low = middle
      else high = middle - 1
    }
    low = safeSurrogateCut(text, low)
  }
  if (low <= minOffset) return ''

  // Prefer a line boundary when it does not throw away too much or cut before minOffset.
  const newline = text.lastIndexOf('\n', low)
  let cut = newline > minOffset && newline > low * 0.55 ? newline : low
  let refined = false

  while (cut > minOffset) {
    const safeCut = safeSurrogateCut(text, cut)
    if (safeCut <= minOffset) return ''
    const kept = stripTrailingHeadings(text.slice(0, safeCut))
    if (!kept || kept.length <= minOffset) return ''
    const openFence = openFenceAt(kept)
    const closed = closeOpenFence(kept, openFence)
    const { dropped, initialFence } = droppedAfter(text, kept.length, openFence)
    const resolvedMarker = markerAt(marker, dropped, { initialFence })
    const result = `${closed}${resolvedMarker}`
    const measured = count(result)
    if (measured <= maxTokens) return result
    if (!refined && count === estimateTokens && measured - maxTokens > 4) {
      refined = true
      const overhead = count(`${closed.slice(kept.length)}${resolvedMarker}`)
      const nextCut = overhead < maxTokens ? findCutOffsetForEstimate(text, maxTokens - overhead) : 0
      const stepLimit = Math.min(safeCut - 1, kept.length - 1)
      if (nextCut > minOffset && nextCut < stepLimit) {
        cut = nextCut
        continue
      }
    }
    cut = Math.min(safeCut - 1, kept.length - 1)
  }
  return ''
}

/**
 * Offsets that are safe to cut at: the end of a paragraph or the end of a
 * closed markdown code fence. Tracks fence character and length per CommonMark
 * so nested backtick or tilde fences do not close prematurely.
 */
function boundaryOffsets(text) {
  const offsets = []
  let fence = null
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    const next = stepFenceSlice(fence, text, lineStart, lineEnd)
    fence = next.fence
    if (next.event === 'close' || (fence === null && next.event === null && isBlankSlice(text, lineStart, lineEnd))) {
      offsets.push(Math.min(len, lineEnd + 1))
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return offsets
}

/**
 * Structure-aware trim: the largest paragraph/fence boundary that fits.
 *
 * Recall payloads are markdown. Cutting them at an arbitrary character can
 * split a code fence or a sentence; this prefers a boundary and only falls back
 * to the character/line cut when no boundary fits (e.g. one huge first
 * paragraph). The same hard rules as `truncateToBudget` apply: no hidden floor,
 * a cap of 0 disables, and an unfittable marker yields an empty string.
 */
export function trimToBudget(text, maxTokens, marker = '\n\n…[truncated]', count = estimateTokens, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  if (count(text) <= maxTokens) return text

  const minOffset = Number.isFinite(options?.minOffset) && options.minOffset > 0 ? options.minOffset : 0
  const markerTokens = count(markerAt(marker, ''))
  if (markerTokens >= maxTokens) return ''

  const usable = maxTokens - markerTokens
  const allOffsets = boundaryOffsets(text)
  const offsets = minOffset > 0 ? allOffsets.filter((offset) => offset > minOffset) : allOffsets

  let foundIdx = -1
  if (count === estimateTokens) {
    foundIdx = findBoundaryIndexForEstimate(text, offsets, usable)
  } else {
    // Token counts are monotonic in prefix length, so the fitting boundaries are
    // a prefix of the sorted offset list; binary search the last of them.
    let low = 0
    let high = offsets.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (count(text.slice(0, offsets[middle])) <= usable) {
        foundIdx = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
  }

  for (let idx = foundIdx; idx >= 0; idx -= 1) {
    const kept = stripTrailingHeadings(text.slice(0, offsets[idx]))
    if (!kept || kept.length <= minOffset) break
    const { dropped, initialFence } = droppedAfter(text, kept.length, null)
    const result = `${kept}${markerAt(marker, dropped, { initialFence })}`
    if (count(result) <= maxTokens) return result
  }
  return truncateToBudget(text, maxTokens, marker, count, options)
}

/**
 * Split a turn-wide budget across messages, keeping small messages whole.
 *
 * This is water-filling rather than a proportional cut: a message that fits in
 * an equal share keeps all of its content, and larger messages take the
 * remainder. Proportionally cutting every message was cheaper to reason about
 * but it damaged the short, high-signal recalls for no benefit — the turn is
 * bounded either way. The sum never exceeds `maxTokens`, and no message gets
 * more than it has.
 *
 * `weights` (optional, one positive number per message) makes the shares
 * proportional: the same depth is offered per unit of weight, so a query-
 * relevant recall keeps more of its body before a co-located but unrelated one
 * is touched. Omitting weights is byte-for-byte the original equal-share
 * water-filling.
 */
export function allocateBudget(tokens, maxTokens, weights = null) {
  const allocations = new Array(tokens.length).fill(0)
  if (tokens.length === 0) return allocations
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return allocations

  const total = tokens.reduce((sum, value) => sum + value, 0)
  if (total <= maxTokens) return allocations.map((_, index) => Math.max(0, Math.floor(tokens[index])))

  const weightAt = (index) => {
    const raw = Array.isArray(weights) ? weights[index] : 1
    return Number.isFinite(raw) && raw > 0 ? raw : 1
  }
  const order = tokens
    .map((value, index) => ({ value, index, weight: weightAt(index) }))
    .sort((a, b) => (a.value / a.weight) - (b.value / b.weight) || a.value - b.value || a.index - b.index)

  let remaining = maxTokens
  let leftWeight = order.reduce((sum, entry) => sum + entry.weight, 0)
  for (const { value, index, weight } of order) {
    if (remaining <= 0) break
    const fair = remaining / leftWeight
    const give = Math.min(value, Math.floor(fair * weight))
    allocations[index] = Math.max(0, give)
    remaining -= allocations[index]
    leftWeight -= weight
  }

  // Integer floors can leave a few tokens unused; give them to the largest
  // messages first, which are the ones already being cut.
  if (remaining > 0) {
    for (const { value, index } of [...order].reverse()) {
      if (remaining <= 0) break
      const room = Math.max(0, value - allocations[index])
      if (room <= 0) continue
      const add = Math.min(room, remaining)
      allocations[index] += add
      remaining -= add
    }
  }
  return allocations
}

/** Nearest-rank percentile, used for the fast/accurate calibration report. */
export function percentile(values, percent) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))
  return sorted[index]
}

function hasSubstantiveWeight(line) {
  let weight = 0
  for (let i = 0; i < line.length; ) {
    const code = line.codePointAt(i)
    weight += isCjk(code) ? 3 : 1
    if (weight >= 12) return true
    i += code > 0xffff ? 2 : 1
  }
  return false
}

function isBareFence(line) {
  const first = line.charCodeAt(0)
  if (first !== 96 && first !== 126) return false
  return /^(?:`{3,}[^`]*|~{3,}[^~]*)$/.test(line)
}

export function substantiveLines(text) {
  if (text instanceof Set) return text
  const set = new Set()
  if (typeof text !== 'string' || text.length === 0) return set
  let lineStart = 0
  const len = text.length
  while (lineStart <= len) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    let start = lineStart
    let end = lineEnd
    while (start < end && (isSpaceCode(text.charCodeAt(start)) || (text.charCodeAt(start) >= 127 && /\s/.test(text[start])))) {
      start += 1
    }
    while (end > start && (isSpaceCode(text.charCodeAt(end - 1)) || (text.charCodeAt(end - 1) >= 127 && /\s/.test(text[end - 1])))) {
      end -= 1
    }
    if (end > start) {
      const line = text.slice(start, end)
      if (!isBareFence(line) && hasSubstantiveWeight(line)) set.add(line)
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return set
}

/**
 * How much of `right` is already present in `left`, by non-trivial lines.
 *
 * This is deliberately line-based rather than token-based: recall payloads are
 * markdown, and a repeated paragraph or an unchanged page is a *line* repeat.
 * The denominator is the smaller set, so a recall that is a subset of the
 * previous one counts as fully repeated. Short lines and bare fences are
 * ignored, while CJK characters carry higher weight so compact CJK facts count.
 *
 * Kept for the "how similar are these two texts" question. Do NOT use it to
 * decide whether a new recall is worth injecting: a superset scores 1.0 because
 * every old line matched, which would silently drop the new facts. Use
 * `repetitionRatio` for that decision.
 */
export function overlapRatio(left, right) {
  const a = substantiveLines(left)
  const b = substantiveLines(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const line of b) if (a.has(line)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/**
 * How much of `next` the reader already has in `previous`, by non-trivial lines.
 *
 * The denominator is the size of `next`, so this answers the only question that
 * matters for skipping: "how much of what I am about to send is already in
 * context?". A recall that repeats every previous line AND adds new facts
 * therefore scores below 1 and is never silently dropped. A zero denominator
 * (no substantive lines) is treated as fully repeated only when the previous
 * text also had none; that keeps shrunken/delta recalls from being re-sent.
 */
export function repetitionRatio(previous, next) {
  const a = substantiveLines(previous)
  const b = substantiveLines(next)
  if (b.size === 0) return a.size === 0 ? 1 : 0
  let shared = 0
  for (const line of b) if (a.has(line)) shared += 1
  return shared / b.size
}

const HEADING_AT_START = /^#{1,6}[ \t]/
const TOP_LIST_ITEM = /^(?:[-*+]|\d+[.)])[ \t]+/
const COMPACT_LIST_TOKENS = 280

/**
 * Split a long list block into pieces, for recalls written as one dense list.
 *
 * A 40-item bullet list written without blank lines is one block to the
 * paragraph splitter, so a view can only keep all of it or none of it. Items at
 * the top level are the natural seam: accumulate them until the piece exceeds
 * the per-block soft limit, without touching indented continuation lines.
 */
function splitCompactList(block) {
  if (estimateTokens(block) <= COMPACT_LIST_TOKENS) return [block]
  // Never split around a fence: a `- item` line inside a code sample is data.
  if (/^\s*(?:`{3,}|~{3,})/m.test(block)) return [block]
  const lines = block.split('\n')
  const items = []
  let current = []
  for (const line of lines) {
    if (TOP_LIST_ITEM.test(line)) {
      if (current.length > 0) items.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) items.push(current.join('\n'))
  if (items.length < 2 || items.filter((item) => TOP_LIST_ITEM.test(item)).length === 0) return [block]
  const pieces = []
  let buffer = ''
  for (const item of items) {
    const candidate = buffer.length > 0 ? `${buffer}\n${item}` : item
    if (buffer.length > 0 && estimateTokens(candidate) > COMPACT_LIST_TOKENS) {
      pieces.push(buffer)
      buffer = item
    } else {
      buffer = candidate
    }
  }
  if (buffer.length > 0) pieces.push(buffer)
  return pieces
}

/**
 * Split a markdown payload into fact-sized blocks.
 *
 * Paragraphs are separated by a blank line, with blank lines inside a fenced
 * code block kept intact. A heading also starts a new block even when it has no
 * blank line before it (`## Next steps` glued to the previous paragraph is a new
 * fact, not the tail of the old one), and an oversized flat list is split at its
 * top-level items so a budgeted view can keep the part that matters.
 */
export function splitBlocks(text) {
  const blocks = []
  let current = []
  let fence = null
  for (const line of String(text ?? '').split('\n')) {
    const next = stepFence(fence, line)
    if (fence === null && next.event !== 'open' && HEADING_AT_START.test(line) && current.length > 0) {
      blocks.push(current.join('\n'))
      current = []
    }
    fence = next.fence
    if (fence === null && next.event === null && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
      }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current.join('\n'))
  return blocks.flatMap((block) => splitCompactList(block))
}

/**
 * The part of `text` that is not already present in `previous`.
 *
 * Used when a recall is mostly repeated but not entirely: instead of dropping
 * the whole recall (losing the new facts) or re-sending all of it (paying twice
 * for the repeated part), keep only the blocks that carry at least one line the
 * reader has not seen. Block granularity is deliberate — line-level surgery
 * would break markdown structure and the surrounding context of a changed line.
 */
export function subtractRepeated(previous, text) {
  const known = new Set(
    String(previous ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  const blocks = splitBlocks(text)
  const kept = []
  let omitted = 0
  let novelLines = 0
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const novel = lines.filter((line) => !known.has(line))
    if (novel.length === 0) {
      omitted += 1
      continue
    }
    kept.push(block)
    novelLines += novel.filter((line) => !isBareFence(line) && hasSubstantiveWeight(line)).length
  }
  return { text: kept.join('\n\n'), blocks: blocks.length, kept: kept.length, omitted, novelLines }
}
