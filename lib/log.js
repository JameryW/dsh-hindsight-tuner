import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tunerDir } from './config-file.js'

const MAX_BYTES = 1_000_000
const FLUSH_MS = 250
const MAX_PENDING = 500
// Rotation keeps at most two segments of ~1 MB each. Read each segment whole:
// a 24h summary must see lifecycle events (`activated`, `tune_applied`) even
// when a chatty day pushed them beyond a smaller tail window, otherwise status
// and verify-live can claim auto-tune never ran.
const READ_TAIL_BYTES = MAX_BYTES

let pending = []
let timer = null
let hooked = false
let journalRevision = 0
let journalSummaryCache = null
const JOURNAL_SUMMARY_TTL_MS = 5000

function flush() {
  timer = null
  if (pending.length === 0) return
  const lines = pending
  pending = []
  journalRevision += 1
  try {
    const dir = tunerDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tuner.jsonl')
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      const rotated = `${file}.1`
      try {
        if (existsSync(rotated)) unlinkSync(rotated)
      } catch { /* best-effort rotation cleanup */ }
      try {
        renameSync(file, rotated)
      } catch { /* if rotation fails, keep appending rather than dropping lines */ }
    }
    appendFileSync(file, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  } catch {
    // Diagnostics are best effort by design.
  }
}

/**
 * Append one line to this plugin's own journal. Diagnostics never go to the
 * Hindsight logs: those belong to the other integration and are read-only here.
 *
 * Writes are buffered: a turn can emit several events, and one append per event
 * would put the journal on the model's critical path. Entries are flushed in a
 * single append after a short delay, or as soon as the buffer is full. Every
 * failure is swallowed — a full disk must not break an agent turn.
 */
export function record(entry) {
  if (!hooked) {
    hooked = true
    // A pending line should not disappear when the process ends normally.
    process.once('exit', flush)
  }
  pending.push({ ts: new Date().toISOString(), ...entry })
  journalRevision += 1
  if (pending.length >= MAX_PENDING) {
    flush()
    return
  }
  if (timer === null) {
    timer = setTimeout(flush, FLUSH_MS)
    timer.unref?.()
  }
}

/** Write everything buffered right now. Exposed for tests and dispose paths. */
export function flushJournal() {
  if (timer !== null) clearTimeout(timer)
  flush()
}

/** Number of entries waiting to be written (tests and diagnostics only). */
export function journalPending() {
  return pending.length
}

/** Parse the newest `limit` bytes of one journal segment (torn lines ignored). */
function readTailEntries(file, limit) {
  const entries = []
  if (!existsSync(file)) return entries
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - limit)
    const length = size - start
    let text = ''
    if (length > 0) {
      const fileHandle = openSync(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        let total = 0
        while (total < length) {
          const bytesRead = readSync(fileHandle, buffer, total, length - total, start + total)
          if (bytesRead === 0) break
          total += bytesRead
        }
        text = buffer.toString('utf8', 0, total)
        if (start > 0) {
          const firstNewline = text.indexOf('\n')
          text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
        }
      } finally {
        closeSync(fileHandle)
      }
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object') entries.push(parsed)
      } catch {
        // Ignore torn head/tail lines.
      }
    }
  } catch {
    // Best-effort diagnostics only.
  }
  return entries
}

function segmentStamp(file) {
  try {
    const stat = statSync(file, { bigint: true })
    return `${stat.size}:${stat.mtimeNs}`
  } catch {
    return 'missing'
  }
}

/** Summarize recent tuner events (including buffered lines) across restarts. */
export function summarizeTunerJournal(options = {}) {
  const { windowHours = 24, now = Date.now() } = options
  const since = now - windowHours * 3_600_000
  const file = join(tunerDir(), 'tuner.jsonl')
  const rotatedFile = `${file}.1`
  const activeStamp = segmentStamp(file)
  const fileExists = activeStamp !== 'missing'
  const cacheable = options.now === undefined
  const cacheKey = cacheable
    ? `${file}|${windowHours}|${journalRevision}|${activeStamp}|${segmentStamp(rotatedFile)}`
    : null
  if (
    cacheKey !== null
    && journalSummaryCache
    && journalSummaryCache.key === cacheKey
    && Date.now() - journalSummaryCache.at < JOURNAL_SUMMARY_TTL_MS
  ) {
    return journalSummaryCache.value
  }

  // The active file rotates to `.1` at ~1 MB. Reading only the active file would
  // reset a 24h summary whenever rotation happens on a busy install.
  const entries = [
    ...readTailEntries(rotatedFile, READ_TAIL_BYTES),
    ...readTailEntries(file, READ_TAIL_BYTES),
  ]

  for (const entry of pending) entries.push(entry)

  let capped = 0
  let skipped = 0
  let trimmedTokens = 0
  let savedTokens = 0
  let activated = 0
  let tuneApplied = 0
  let tuneRequested = 0
  let tuneSkipped = 0
  let tuneFailed = 0
  let tierSelected = 0
  let reentered = 0
  let deltas = 0
  let viewed = 0
  let lastActivated = null
  let lastActivatedAt = -Infinity
  let lastTuneOkAt = -Infinity
  let lastTuneError = null
  let lastTuneErrorAt = -Infinity
  let builtinInjected = 0
  let builtinPagesOk = 0
  let builtinRecallOk = 0
  let builtinReflectOk = 0
  let builtinRetainOk = 0
  let builtinSeedOk = 0
  let builtinErrors = 0
  const builtinInjectSizes = []
  const builtinPages = { events: 0, total: 0, max: 0 }
  let builtinLastInject = null
  let builtinLastInjectAt = -Infinity
  let builtinLastSuccess = null
  let builtinLastSuccessAt = -Infinity
  let builtinLastFailure = null
  let builtinLastFailureAt = -Infinity

  for (const entry of entries) {
    const at = Date.parse(entry.ts ?? '')
    if (!Number.isFinite(at) || at < since) continue
    if (entry.event === 'inject_capped') {
      capped += 1
      if (Number.isFinite(entry.before) && Number.isFinite(entry.after)) {
        trimmedTokens += Math.max(0, entry.before - entry.after)
      }
    } else if (entry.event === 'inject_skipped') {
      skipped += 1
      if (Number.isFinite(entry.saved)) savedTokens += Math.max(0, entry.saved)
    } else if (entry.event === 'inject_delta') {
      deltas += 1
      if (Number.isFinite(entry.saved)) savedTokens += Math.max(0, entry.saved)
    } else if (entry.event === 'tier_selected') {
      tierSelected += 1
    } else if (entry.event === 'inject_reentered') {
      reentered += 1
    } else if (entry.event === 'inject_view') {
      viewed += 1
    } else if (entry.event === 'builtin_inject_ok') {
      builtinInjected += 1
      if (Number.isFinite(entry.chars)) {
        if (builtinInjectSizes.length >= 100) builtinInjectSizes.shift()
        builtinInjectSizes.push(entry.chars)
        if (at >= builtinLastInjectAt) {
          builtinLastInjectAt = at
          builtinLastInject = { chars: entry.chars, ts: entry.ts }
        }
      }
    } else if (entry.event === 'builtin_inject_pages') {
      if (Number.isFinite(entry.count)) {
        builtinPages.events += 1
        builtinPages.total += entry.count
        builtinPages.max = Math.max(builtinPages.max, entry.count)
      }
    } else if (
      entry.event === 'builtin_pages_ok'
      || entry.event === 'builtin_recall_ok'
      || entry.event === 'builtin_reflect_ok'
      || entry.event === 'builtin_retain_ok'
      || entry.event === 'builtin_seed_ok'
    ) {
      if (entry.event === 'builtin_pages_ok') builtinPagesOk += 1
      else if (entry.event === 'builtin_recall_ok') builtinRecallOk += 1
      else if (entry.event === 'builtin_reflect_ok') builtinReflectOk += 1
      else if (entry.event === 'builtin_retain_ok') builtinRetainOk += 1
      else if (entry.event === 'builtin_seed_ok') builtinSeedOk += 1
      if (at >= builtinLastSuccessAt) {
        builtinLastSuccessAt = at
        builtinLastSuccess = { event: entry.event, ts: entry.ts }
      }
    } else if (entry.event === 'builtin_failed') {
      builtinErrors += 1
      if (at >= builtinLastFailureAt) {
        builtinLastFailureAt = at
        builtinLastFailure = {
          event: entry.event,
          error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : null,
          endpoint: typeof entry.endpoint === 'string' ? entry.endpoint : null,
          bank: typeof entry.bank === 'string' ? entry.bank : null,
          status: Number.isFinite(entry.status) ? entry.status : null,
          ts: entry.ts,
        }
      }
    } else if (entry.event === 'activated') {
      activated += 1
      if (at >= lastActivatedAt) {
        lastActivatedAt = at
        lastActivated = {
          ts: entry.ts,
          autoTune: entry.autoTune,
          cap: entry.cap,
          recall: entry.recall,
          budgetPolicy: entry.budgetPolicy ?? null,
          repeatPolicy: entry.repeatPolicy ?? null,
        }
      }
    } else if (entry.event === 'tune_applied') {
      tuneApplied += 1
      if (at >= lastTuneOkAt) lastTuneOkAt = at
    } else if (entry.event === 'tune_requested') {
      tuneRequested += 1
      if (at >= lastTuneOkAt) lastTuneOkAt = at
    } else if (entry.event === 'tune_skipped') {
      tuneSkipped += 1
    } else if (entry.event === 'tune_failed') {
      tuneFailed += 1
      if (at >= lastTuneErrorAt) {
        lastTuneErrorAt = at
        lastTuneError = typeof entry.error === 'string' ? entry.error : null
      }
    }
  }

  const summary = {
    path: file,
    exists: fileExists,
    windowHours,
    capped,
    skipped,
    trimmedTokens,
    savedTokens,
    totalSaved: trimmedTokens + savedTokens,
    activated,
    tuneApplied,
    tuneRequested,
    tuneSkipped,
    tuneFailed,
    tierSelected,
    reentered,
    deltas,
    viewed,
    lastActivated,
    lastTuneError,
    tuneErrorActive: Number.isFinite(lastTuneErrorAt) && lastTuneErrorAt > lastTuneOkAt,
    builtin: {
      injected: builtinInjected,
      pagesOk: builtinPagesOk,
      recallOk: builtinRecallOk,
      reflectOk: builtinReflectOk,
      retainOk: builtinRetainOk,
      seedOk: builtinSeedOk,
      errors: builtinErrors,
      injectSizes: builtinInjectSizes,
      pages: builtinPages,
      lastInject: builtinLastInject,
      lastSuccess: builtinLastSuccess,
      lastFailure: builtinLastFailure,
    },
  }
  if (cacheKey !== null) journalSummaryCache = { key: cacheKey, at: Date.now(), value: summary }
  return summary
}
