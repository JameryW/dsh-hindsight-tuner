/**
 * Token accounting for the budget.
 *
 * `fast` is a dependency-free estimate: one token per CJK character, 0.28 per
 * other character. The CJK weight is a deliberate upper bound — DeepSeek's own
 * tokenizer averages closer to 0.6 tokens per Chinese character, so a purely
 * Chinese recall is counted at roughly 1.7x its real size. That under-fills the
 * ceiling instead of overshooting it: the ceiling is a promise to the host, and
 * over-counting is the safe direction. Use `accurate` for a tighter number.
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

const CJK = [
  [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xac00, 0xd7af], [0xf900, 0xfaff], [0xff00, 0xffef],
]

function isCjk(code) {
  for (const [low, high] of CJK) if (code >= low && code <= high) return true
  return false
}

/** Fast, dependency-free estimate. Kept as the single-number fast path. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const character of text) {
    if (isCjk(character.codePointAt(0))) cjk += 1
  }
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (text.length - cjk) * OTHER_TOKENS_PER_CHAR)
}

/** Safety margin applied when `accurate` mode requested but no tokenizer exists. */
export const FALLBACK_MARGIN = 1.1

/**
 * Count tokens according to the configured mode.
 * Returns `{ tokens, mode, exact }`: `exact` is false when accurate mode had to
 * fall back to the estimate.
 */
export function countTokens(text, { mode = 'fast', encode } = {}) {
  if (typeof text !== 'string' || text.length === 0) return { tokens: 0, mode, exact: true }
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

function findCutOffsetForEstimate(text, usable) {
  let cjk = 0
  let best = 0
  let offset = 0
  for (const character of text) {
    if (isCjk(character.codePointAt(0))) cjk += 1
    offset += character.length
    if (Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (offset - cjk) * OTHER_TOKENS_PER_CHAR) <= usable) best = offset
    else break
  }
  return best
}

function findBoundaryIndexForEstimate(text, offsets, usable) {
  if (offsets.length === 0) return -1
  let cjk = 0
  let offset = 0
  let idx = 0
  let foundIdx = -1
  for (const character of text) {
    while (idx < offsets.length && offsets[idx] <= offset) {
      if (Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (offset - cjk) * OTHER_TOKENS_PER_CHAR) <= usable) foundIdx = idx
      else return foundIdx
      idx += 1
    }
    if (idx >= offsets.length) return foundIdx
    if (isCjk(character.codePointAt(0))) cjk += 1
    offset += character.length
  }
  while (idx < offsets.length && offsets[idx] <= offset) {
    if (Math.ceil(cjk * CJK_TOKENS_PER_CHAR + (offset - cjk) * OTHER_TOKENS_PER_CHAR) <= usable) foundIdx = idx
    idx += 1
  }
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

function stepFence(fence, line) {
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

/**
 * The code fence left open by `text`, if the text ends inside one.
 *
 * A character-level cut can land in the middle of a fenced block. Truncation
 * must not hand back markdown whose marker sits inside an unterminated fence —
 * the rest of the message would be rendered as code.
 */
function openFenceAt(text) {
  let fence = null
  for (const line of text.split('\n')) fence = stepFence(fence, line).fence
  return fence
}

/** Close a trailing open fence with its own marker so the markdown stays valid. */
function closeOpenFence(text) {
  const fence = openFenceAt(text)
  if (!fence) return text
  return `${text}\n${fence.char.repeat(fence.length)}\n`
}

/**
 * Lexical terms from the current user message, used to reorder recall sections
 * before a trim.
 *
 * Deliberately simple and dependency-free: code identifiers, dotted or
 * path-like words, and CJK runs of two or more characters, lowercased and
 * de-duplicated. There is no stemming and no stop-word list — a false hit only
 * affects the order of sections, never whether a section is kept.
 */
const QUERY_TERM = /[A-Za-z_$][\w$./-]{2,}|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]{2,}/g

export function extractQueryTerms(queryText) {
  const terms = new Set()
  if (typeof queryText !== 'string' || queryText.length === 0) return terms
  for (const match of queryText.match(QUERY_TERM) ?? []) {
    const term = match.toLowerCase()
    if (term.length >= 2) terms.add(term)
  }
  return terms
}

/** Heavier weight for terms that look like paths or identifiers, not prose. */
function queryTermWeight(term) {
  if (/[/.\\]/.test(term)) return 3
  if (/[_$]/.test(term)) return 2
  return /[^\x00-\x7f]/.test(term) ? 2 : 1
}

function sectionScore(section, terms) {
  if (terms.size === 0) return 0
  const haystack = section.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!haystack.includes(term)) continue
    score += queryTermWeight(term)
  }
  return score
}

/**
 * Reorder `##`–`####` sections so the ones that mention the current query come
 * first, keeping the preamble in place.
 *
 * The trim is a prefix cut, so section order decides what survives. Scoring by
 * the user's own words spends the ceiling on the recall the turn is actually
 * about instead of whatever the bank happened to return first. The transform is
 * a pure reordering: the same characters are returned, only in a different
 * order, so it cannot change the token count. It is a no-op when the query has
 * no lexical signal or no section matches.
 */
export function prioritizeSectionsByQuery(text, queryText) {
  if (typeof text !== 'string' || text.length === 0) return text
  const terms = extractQueryTerms(queryText)
  if (terms.size === 0) return text

  // Find heading lines outside code fences; splitting inside a fence would move
  // half of a code block into another section and break the pairing.
  const starts = []
  let fence = null
  let offset = 0
  for (const line of text.split('\n')) {
    const next = stepFence(fence, line)
    if (fence === null && next.event !== 'open' && /^#{2,4}[ \t]/.test(line)) starts.push(offset)
    fence = next.fence
    offset += line.length + 1
  }
  if (starts.length === 0) return text

  const preamble = text.slice(0, starts[0])
  const sections = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length))
  const scored = sections.map((section, index) => ({ section, index, score: sectionScore(section, terms) }))
  if (!scored.some((entry) => entry.score > 0)) return text
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  if (scored.every((entry, position) => entry.index === position)) return text
  return preamble + scored.map((entry) => entry.section).join('')
}

const DROPPED_HEADINGS = /(?:^|\n)#{2,6}[ \t]+([^\n]+)/g
const RECOVERY_TOOLS = 'hindsight_search_pages / hindsight_read_page'

/**
 * Turn a static truncation marker into a recoverable pointer.
 *
 * A bare `…[truncated]` tells the model that memory was cut but not what was
 * cut, so the only recovery is to guess another query. The returned marker
 * factory lists the headings that fell off (and the tools that can fetch them
 * again), for roughly 15–25 tokens. A dropped tail without headings — a single
 * long paragraph — keeps the plain marker unchanged.
 */
export function buildRecoverableMarker(baseMarker, { headings = 2, titleChars = 48 } = {}) {
  const base = typeof baseMarker === 'function' ? baseMarker('') : baseMarker
  return (dropped) => {
    const titles = []
    if (typeof dropped === 'string' && dropped.length > 0) {
      const pattern = new RegExp(DROPPED_HEADINGS.source, 'g')
      let match
      while ((match = pattern.exec(dropped)) !== null && titles.length < headings) {
        const title = match[1].replace(/#+\s*$/, '').replace(/\s+/g, ' ').trim()
        if (!title || titles.includes(title)) continue
        titles.push(title.length > titleChars ? `${title.slice(0, Math.max(1, titleChars - 1))}…` : title)
      }
    }
    if (titles.length === 0) return base
    const list = titles.map((title) => JSON.stringify(title)).join(', ')
    const noun = titles.length === 1 ? 'section' : 'sections'
    return `${base}\n[cut ${noun} ${list} — recover with ${RECOVERY_TOOLS}]`
  }
}

/** Markers may be a plain string or the factory `buildRecoverableMarker` returns. */
function markerAt(marker, dropped) {
  return typeof marker === 'function' ? marker(dropped) : marker
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

  while (cut > minOffset) {
    const safeCut = safeSurrogateCut(text, cut)
    if (safeCut <= minOffset) return ''
    const kept = stripTrailingHeadings(text.slice(0, safeCut))
    if (!kept || kept.length <= minOffset) return ''
    const result = `${closeOpenFence(kept)}${markerAt(marker, text.slice(safeCut))}`
    if (count(result) <= maxTokens) return result
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
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    const next = stepFence(fence, line)
    fence = next.fence
    if (next.event === 'close' || (fence === null && next.event === null && line.trim() === '')) {
      offsets.push(Math.min(text.length, lineEnd + 1))
    }
    offset = lineEnd + 1
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
    const result = `${kept}${markerAt(marker, text.slice(offsets[idx]))}`
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
 */
export function allocateBudget(tokens, maxTokens) {
  const allocations = new Array(tokens.length).fill(0)
  if (tokens.length === 0) return allocations
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return allocations

  const total = tokens.reduce((sum, value) => sum + value, 0)
  if (total <= maxTokens) return allocations.map((_, index) => Math.max(0, Math.floor(tokens[index])))

  const order = tokens
    .map((value, index) => [value, index])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])

  let remaining = maxTokens
  let left = order.length
  for (const [value, index] of order) {
    if (remaining <= 0) break
    const fair = remaining / left
    const give = Math.min(value, Math.floor(value <= fair ? value : fair))
    allocations[index] = Math.max(0, give)
    remaining -= allocations[index]
    left -= 1
  }

  // Integer floors can leave a few tokens unused; give them to the largest
  // messages first, which are the ones already being cut.
  if (remaining > 0) {
    for (const [value, index] of [...order].reverse()) {
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

function lineWeight(line) {
  let weight = 0
  for (const ch of line) weight += isCjk(ch.codePointAt(0)) ? 3 : 1
  return weight
}

function isBareFence(line) {
  return /^(?:`{3,}[^`]*|~{3,}[^~]*)$/.test(line)
}

const substantiveLines = (text) => new Set(
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isBareFence(line) && lineWeight(line) >= 12),
)

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

/**
 * Split a markdown payload into fact-sized blocks: paragraphs separated by a
 * blank line, with blank lines inside a fenced code block kept intact.
 */
export function splitBlocks(text) {
  const blocks = []
  let current = []
  let fence = null
  for (const line of String(text ?? '').split('\n')) {
    const next = stepFence(fence, line)
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
  return blocks
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
    novelLines += novel.filter((line) => !isBareFence(line) && lineWeight(line) >= 12).length
  }
  return { text: kept.join('\n\n'), blocks: blocks.length, kept: kept.length, omitted, novelLines }
}
