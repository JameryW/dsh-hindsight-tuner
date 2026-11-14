/**
 * Token accounting for the budget.
 *
 * `fast` is a dependency-free estimate: CJK characters count as one token each,
 * everything else at 0.28 tokens per character. It is deliberately conservative
 * for mixed prose/code, but it is still an estimate — the integration's own
 * journal reports characters, and a Chinese sentence can tokenize near 0.6
 * tokens per character, so the fast path can under- or over-count depending on
 * the material.
 *
 * `accurate` encodes with the target model's tokenizer when one is installed
 * (`js-tiktoken` or `tiktoken`, optional, loaded lazily). When no tokenizer is
 * available it falls back to the fast estimate with a safety margin and says so
 * in `status`; it never silently claims accuracy.
 */

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
  return Math.ceil(cjk + (text.length - cjk) * 0.28)
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

/** Resolve an optional tokenizer once; returns null when none is installed. */
let tokenizerPromise
export function loadTokenizer() {
  tokenizerPromise ??= (async () => {
    for (const id of ['js-tiktoken', 'tiktoken', '@dqbd/tiktoken']) {
      try {
        const mod = await import(id)
        const encoding =
          typeof mod.encodingForModel === 'function'
            ? mod.encodingForModel('gpt-4o')
            : typeof mod.getEncoding === 'function'
              ? mod.getEncoding('cl100k_base')
              : mod.Tiktoken
                ? new mod.Tiktoken('cl100k_base')
                : null
        if (encoding && typeof encoding.encode === 'function') {
          const name = `${id} (${typeof mod.encodingForModel === 'function' ? 'gpt-4o' : 'cl100k_base'})`
          return { name, encode: (text) => encoding.encode(text).length }
        }
      } catch {
        // keep looking; the package is optional
      }
    }
    return null
  })()
  return tokenizerPromise
}

/**
 * Trim `text` so that `count(result) <= maxTokens`.
 *
 * There is no hidden floor: when the marker alone does not fit, the result is
 * an empty string so the caller can drop the message entirely and stay inside
 * the budget. A cap of 0 or less disables trimming and returns the input.
 */
export function truncateToBudget(text, maxTokens, marker = '\n\n…[truncated]', count = estimateTokens) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  if (count(text) <= maxTokens) return text

  const markerTokens = count(marker)
  if (markerTokens > maxTokens) {
    // Not even the marker fits: let the caller drop the message.
    return ''
  }
  if (markerTokens === maxTokens) {
    return marker.trim()
  }

  const usable = maxTokens - markerTokens
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (count(text.slice(0, middle)) <= usable) low = middle
    else high = middle - 1
  }

  // Prefer a line boundary when it does not throw away too much.
  const newline = text.lastIndexOf('\n', low)
  const cut = newline > low * 0.55 ? newline : low
  const kept = text.slice(0, cut).replace(/\s+$/, '')
  return kept ? `${kept}${marker}` : marker.trimStart()
}

/**
 * Offsets that are safe to cut at: the end of a paragraph or the end of a
 * closed markdown code fence. A cut inside a fence would leave the rest of the
 * prompt rendered as code, which is worse than a slightly shorter recall.
 */
function boundaryOffsets(text) {
  const offsets = []
  let inFence = false
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      if (!inFence) offsets.push(Math.min(text.length, lineEnd + 1))
    } else if (!inFence && line.trim() === '') {
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
export function trimToBudget(text, maxTokens, marker = '\n\n…[truncated]', count = estimateTokens) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  if (count(text) <= maxTokens) return text

  const markerTokens = count(marker)
  if (markerTokens > maxTokens) return ''
  if (markerTokens === maxTokens) return marker.trim()

  const usable = maxTokens - markerTokens
  const offsets = boundaryOffsets(text)

  // Token counts are monotonic in prefix length, so the fitting boundaries are
  // a prefix of the sorted offset list; binary search the last of them.
  let low = 0
  let high = offsets.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (count(text.slice(0, offsets[middle])) <= usable) {
      found = offsets[middle]
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (found > 0) {
    const kept = text
      .slice(0, found)
      .replace(/\s+$/, '')
      // A trailing heading with no body is not useful context.
      .replace(/\n+#{1,6}[^\n]*$/, '')
      .replace(/\s+$/, '')
    if (kept) return `${kept}${marker}`
  }
  return truncateToBudget(text, maxTokens, marker, count)
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

/**
 * How much of `right` is already present in `left`, by non-trivial lines.
 *
 * This is deliberately line-based rather than token-based: recall payloads are
 * markdown, and a repeated paragraph or an unchanged page is a *line* repeat.
 * The denominator is the smaller set, so a recall that is a subset of the
 * previous one counts as fully repeated. Short lines are ignored because
 * headings and blank bullets repeat across unrelated pages.
 */
export function overlapRatio(left, right) {
  const lines = (text) => new Set(
    String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 12),
  )
  const a = lines(left)
  const b = lines(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const line of b) if (a.has(line)) shared += 1
  return shared / Math.min(a.size, b.size)
}
