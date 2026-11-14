/**
 * Token estimation and budget-bounded truncation.
 *
 * Recall payloads are prose mixed with CJK, so neither `chars / 4` nor a real
 * tokenizer is worth a dependency here: a printable estimate that is stable
 * turn to turn is enough to enforce a ceiling. CJK and full-width characters
 * are counted as one token each, everything else at ~3.6 characters per token,
 * which tracks the BPE-ish behaviour of the mixed corpora these injections
 * carry without pulling a tokenizer into the host process.
 */

const CJK =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g

/** Estimated model tokens for a string. Never negative, safe on empty input. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = text.match(CJK)
  return Math.ceil((cjk ? cjk.length : 0) + (text.length - (cjk ? cjk.length : 0)) * 0.28)
}

/**
 * Cut `text` down to roughly `maxTokens`, preferring a line boundary near the
 * cut. The returned string always ends with `marker` so neither the model nor
 * a later reader mistakes the payload for the complete recall.
 */
export function truncateToBudget(text, maxTokens, marker = '\n\n…[truncated]') {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return text
  if (estimateTokens(text) <= maxTokens) return text

  // Reserve room for the marker itself so the result still honours the cap.
  const budget = Math.max(32, maxTokens - estimateTokens(marker) - 8)

  // Largest prefix whose estimate fits: estimateTokens is monotonic in length.
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (estimateTokens(text.slice(0, mid)) <= budget) low = mid
    else high = mid - 1
  }

  // Prefer cutting on a newline when one sits reasonably close to the ceiling.
  const newline = text.lastIndexOf('\n', low)
  const cut = newline > low * 0.55 ? newline : low
  const kept = text.slice(0, cut).replace(/\s+$/, '')
  return kept + marker
}
