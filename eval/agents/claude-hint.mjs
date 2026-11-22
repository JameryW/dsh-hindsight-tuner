#!/usr/bin/env node
/**
 * Agent wrapper for arms that carry a written hint.
 *
 * The evaluation harness spawns the agent command with the task prompt on
 * stdin, so a hint cannot be appended to argv. This wrapper reads stdin, puts
 * `HINDSIGHT_EVAL_HINT` (when set) in front of the prompt, and then runs the
 * real `claude` CLI with the same arguments, piping the modified prompt to it.
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

/** Prefix `input` with `hint` unless the hint is empty; exported for tests. */
export function hintedPrompt(input, hint) {
  const trimmed = typeof hint === 'string' ? hint.trim() : ''
  if (trimmed === '') return input
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
  const input = await readStdin()
  const prompt = hintedPrompt(input, process.env.HINDSIGHT_EVAL_HINT)
  let retriedThroughShell = false
  let child = null
  const start = (shell) => {
    const current = spawn('claude', args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell,
      windowsHide: true,
    })
    child = current
    current.on('error', (error) => {
      if (current !== child) return
      // On Windows `claude` can be a `.cmd` shim that CreateProcess cannot run
      // directly; retry through the shell only after ENOENT + where.exe confirms
      // a shim exists so normal arguments are never shell-split unnecessarily.
      if (process.platform === 'win32' && !retriedThroughShell && error && error.code === 'ENOENT') {
        retriedThroughShell = true
        if (resolvesOnWindows('claude')) {
          start(true)
          return
        }
      }
      console.error(`claude-hint: failed to start claude: ${error.message}`)
      process.exit(127)
    })
    current.stdin.on('error', () => {})
    current.stdin.end(prompt)
    current.on('close', (code, signal) => {
      if (current !== child) return
      if (signal) {
        console.error(`claude-hint: claude exited with signal ${signal}`)
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
