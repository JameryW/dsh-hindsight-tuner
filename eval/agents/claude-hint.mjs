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
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const HINT_SEPARATOR = '\n\n---\n\n'

/** Prefix `input` with `hint` unless the hint is empty; exported for tests. */
export function hintedPrompt(input, hint) {
  const trimmed = typeof hint === 'string' ? hint.trim() : ''
  if (trimmed === '') return input
  return `${trimmed}${HINT_SEPARATOR}${input}`
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const input = await readStdin()
  const prompt = hintedPrompt(input, process.env.HINDSIGHT_EVAL_HINT)
  const child = spawn('claude', args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    // On Windows `claude` resolves to a .exe next to a .cmd shim; the shell is
    // what makes the shim work in the same way the operator's terminal does.
    shell: process.platform === 'win32'
  })
  child.on('error', (error) => {
    console.error(`claude-hint: failed to start claude: ${error.message}`)
    process.exit(127)
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`claude-hint: claude exited with signal ${signal}`)
      process.exit(1)
    }
    process.exit(code ?? 1)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`claude-hint: ${error?.message ?? error}`)
    process.exit(1)
  })
}
