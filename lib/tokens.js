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
 * Split a turn-wide budget across messages in proportion to their size.
 * Every message gets at most its own token count, and the sum of allocations
 * can never exceed `maxTokens`.
 */
export function allocateBudget(tokens, maxTokens) {
  const allocations = new Array(tokens.length).fill(0)
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return allocations

  let remaining = maxTokens
  let left = tokens.reduce((sum, value) => sum + value, 0)
  const order = tokens
    .map((value, index) => [value, index])
    .sort((a, b) => a[0] - b[0])

  for (const [value, index] of order) {
    if (remaining <= 0 || left <= 0) break
    const share = Math.floor((remaining * value) / left)
    const give = Math.min(value, share)
    allocations[index] = give
    remaining -= give
    left -= value
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
