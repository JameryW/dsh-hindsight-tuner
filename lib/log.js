import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tunerDir } from './config-file.js'

const MAX_BYTES = 1_000_000

/**
 * Append one line to this plugin's own journal. Diagnostics never go to the
 * Hindsight logs: those belong to the other integration and are read-only here.
 * Every failure is swallowed — a full disk must not break an agent turn.
 */
export function record(entry) {
  try {
    const dir = tunerDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tuner.jsonl')
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Diagnostics are best effort by design.
  }
}
