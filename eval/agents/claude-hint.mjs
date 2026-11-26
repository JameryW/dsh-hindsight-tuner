#!/usr/bin/env node
/**
 * Agent wrapper for arms that carry a written hint.
 *
 * The evaluation harness spawns the agent command with the task prompt on
 * stdin, so a hint cannot be appended to argv. This wrapper reads stdin, puts
 * `HINDSIGHT_EVAL_HINT` (when set) in front of the prompt, and then runs the
 * configured agent CLI (`HINDSIGHT_EVAL_AGENT_BIN`, default `claude`) with the
 * same arguments, piping the modified prompt to it.
 *
 * Use it for the gate P0 arms R1/R2 and the P1 arm A1:
 *
 *   --agent-command '["node","<repo>/eval/agents/claude-hint.mjs","-p",
 *                      "--output-format","json","--permission-mode","acceptEdits"]'
 *
 * When HINDSIGHT_EVAL_HINT is empty or missing the prompt is passed through
 * unchanged, so the same command can serve every arm.
 */
import { spawn, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HINT_SEPARATOR = '\n\n---\n\n'

const LOCALITY_PATTERN = /(?:file:\/\/\/?(?=[A-Za-z]:)|file:\/\/)?([A-Za-z0-9_./\\-]+(?:\/|\\)[A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|cpp|c|h)|[A-Za-z]:[\\/][A-Za-z0-9_./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|cpp|c|h)|[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|cpp|c|h)):(\d+)(?::(\d+))?/
const ASSERTION_PATTERN = /^(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error|FAIL|not ok)\b[^\n]*/m

/** Extract a compact (<=500 token) structured failure summary for Gate P0 arm R2. */
export function extractStructuredPitfall(failureText, signature = null) {
  const raw = String(failureText ?? '').trim()
  if (!raw) return null
  const assertionMatch = ASSERTION_PATTERN.exec(raw)
  const localityMatch = LOCALITY_PATTERN.exec(raw)
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const assertion = (assertionMatch ? assertionMatch[0] : lines[0] ?? '').slice(0, 240)
  const locality = localityMatch
    ? `${localityMatch[1]}:${localityMatch[2]}${localityMatch[3] ? `:${localityMatch[3]}` : ''}`
    : null
  const summary = {
    protocol: 'R2-structured-pitfall',
    signature: signature || 'check-failed',
    assertion,
    locality,
    pitfall: locality
      ? `Inspect ${locality} first and address the failing condition (${assertion.slice(0, 120)}) before retrying.`
      : `Address the failing check condition (${assertion.slice(0, 140)}) before retrying.`,
  }
  return `Structured failure feedback (previous attempt):\n${JSON.stringify(summary, null, 2)}`
}

/**
 * Prefix `input` with `hint` unless the hint is empty/`none`.
 * Supports Gate P0 dynamic modes (`raw-error` and `structured-pitfall`) using
 * `HINDSIGHT_EVAL_PREV_FAILURE` populated on retry attempts 2..N.
 */
export function hintedPrompt(input, hint, options = {}) {
  const trimmed = typeof hint === 'string' ? hint.trim() : ''
  if (trimmed === '' || trimmed === 'none') return input
  const prevFailure = typeof options.prevFailure === 'string' ? options.prevFailure.trim() : ''
  const prevSignature = typeof options.prevSignature === 'string' ? options.prevSignature.trim() : null
  if (trimmed === 'raw-error') {
    if (!prevFailure) return input
    return `Previous attempt check output:\n${prevFailure.slice(0, 3000)}${HINT_SEPARATOR}${input}`
  }
  if (trimmed === 'structured-pitfall') {
    const structured = extractStructuredPitfall(prevFailure, prevSignature)
    if (!structured) return input
    return `${structured}${HINT_SEPARATOR}${input}`
  }
  return `${trimmed}${HINT_SEPARATOR}${input}`
}

function readStdin() {
  return new Promise((resolveStdin, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolveStdin(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

function resolvesOnWindows(command) {
  try {
    const result = spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
    return result.status === 0
  } catch {
    return false
  }
}

function canonical(path) {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  const self = canonical(fileURLToPath(import.meta.url))
  const script = canonical(process.argv[1])
  return process.platform === 'win32'
    ? self.toLowerCase() === script.toLowerCase()
    : self === script
}

async function main() {
  const args = process.argv.slice(2)
  const agentBin = process.env.HINDSIGHT_EVAL_AGENT_BIN?.trim() || 'claude'
  const input = await readStdin()
  const prompt = hintedPrompt(input, process.env.HINDSIGHT_EVAL_HINT, {
    prevFailure: process.env.HINDSIGHT_EVAL_PREV_FAILURE,
    prevSignature: process.env.HINDSIGHT_EVAL_PREV_SIGNATURE,
  })
  let retriedThroughShell = false
  let child = null
  const start = (shell) => {
    const current = spawn(agentBin, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell,
      windowsHide: true,
    })
    child = current
    current.on('error', (error) => {
      if (current !== child) return
      // On Windows an agent CLI can be a `.cmd` shim that CreateProcess cannot run
      // directly; retry through the shell only after ENOENT + where.exe confirms
      // a shim exists so normal arguments are never shell-split unnecessarily.
      if (process.platform === 'win32' && !retriedThroughShell && error && error.code === 'ENOENT') {
        retriedThroughShell = true
        if (resolvesOnWindows(agentBin)) {
          start(true)
          return
        }
      }
      console.error(`claude-hint: failed to start ${agentBin}: ${error.message}`)
      process.exit(127)
    })
    current.stdin.on('error', () => {})
    current.stdin.end(prompt)
    current.on('close', (code, signal) => {
      if (current !== child) return
      if (signal) {
        console.error(`claude-hint: ${agentBin} exited with signal ${signal}`)
        process.exit(1)
      }
      process.exit(code ?? 1)
    })
  }
  start(false)
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(`claude-hint: ${error?.message ?? error}`)
    process.exit(1)
  })
}
