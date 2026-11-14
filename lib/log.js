import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tunerDir } from './config-file.js'

const MAX_BYTES = 1_000_000
const FLUSH_MS = 250
const MAX_PENDING = 500

let pending = []
let timer = null
let hooked = false

function flush() {
  timer = null
  if (pending.length === 0) return
  const lines = pending
  pending = []
  try {
    const dir = tunerDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tuner.jsonl')
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
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
