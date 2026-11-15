// Command-line driver for the A/B harness.
//
// The harness itself is policy-free; this driver knows how to run a real
// coding agent and a verifiable check, or a dry run that exercises the whole
// pipeline without credentials. The measured setup is deliberately simple:
// one task directory (a scratch copy), one agent invocation, one check
// command whose exit code is the ground truth.
//
//   node eval/ab.mjs --tasks eval/tasks.json --report eval/report.json
//   node eval/ab.mjs --tasks eval/tasks.json --dry-run
//
// The agent receives the prompt on stdin and is expected to exit when done.
// `--agent-command` accepts either a JSON array or a space-separated string:
//   --agent-command '["claude","-p","--output-format","json"]'

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { evaluate, formatReport, writeReport, DEFAULT_ARMS } from './harness.mjs'

const DEFAULT_AGENT = ['claude', '-p', '--output-format', 'json']
const DEFAULT_TIMEOUT_MS = 10 * 60_000

function parseArgs(argv) {
  const options = { tasks: null, report: null, repeats: 1, dryRun: false, agent: DEFAULT_AGENT, timeoutMs: DEFAULT_TIMEOUT_MS, arms: DEFAULT_ARMS }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value == null || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }
    if (flag === '--tasks') options.tasks = next()
    else if (flag === '--report') options.report = next()
    else if (flag === '--repeats') options.repeats = Math.max(1, Number.parseInt(next(), 10) || 1)
    else if (flag === '--timeout') options.timeoutMs = Math.max(1000, Number.parseInt(next(), 10) || DEFAULT_TIMEOUT_MS)
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--arms') options.arms = JSON.parse(next())
    else if (flag === '--agent-command') {
      const raw = next()
      options.agent = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(/\s+/).filter(Boolean)
    } else throw new Error(`unknown option ${flag}`)
  }
  if (!options.tasks) throw new Error('--tasks is required (see eval/tasks.example.json)')
  return options
}

function readTasks(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${file}: expected a non-empty "tasks" array`)
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || typeof task?.prompt !== 'string') throw new Error(`${file}: every task needs string id and prompt`)
    if (typeof task.cwd !== 'string' || task.cwd === '') throw new Error(`${file}: task ${task.id} needs a cwd`)
    if (task.check == null) throw new Error(`${file}: task ${task.id} needs a check command`)
  }
  return tasks
}

function runProcess(command, args, { cwd, env, stdin, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, durationMs: Date.now() - startedAt })
    }
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already be gone; the timeout result stands.
      }
      finish({ exitCode: null, timedOut: true, stdout, stderr })
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish({ exitCode: null, error: error.message, stdout, stderr }))
    child.on('close', (exitCode) => finish({ exitCode, timedOut: false, stdout, stderr }))
    if (child.stdin) {
      child.stdin.on('error', () => {})
      if (stdin != null) child.stdin.end(stdin)
      else child.stdin.end()
    }
  })
}

function checkCommand(check) {
  if (typeof check === 'string') {
    const [command, ...args] = check.split(/\s+/).filter(Boolean)
    return { command, args }
  }
  if (Array.isArray(check)) return { command: check[0], args: check.slice(1) }
  if (check && typeof check.command === 'string') return { command: check.command, args: Array.isArray(check.args) ? check.args : [] }
  throw new Error('check must be a string, an array, or {command,args}')
}

function usageTokens(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      const usage = parsed?.usage ?? parsed?.result?.usage
      if (usage) {
        const input = Number(usage.input_tokens ?? 0)
        const output = Number(usage.output_tokens ?? 0)
        const total = input + output
        if (total > 0) return total
      }
      if (Number.isFinite(parsed?.total_tokens)) return parsed.total_tokens
    } catch {
      // Not the JSON summary line; keep looking.
    }
  }
  return null
}

function defaultRunner(options) {
  return async ({ task, arm }) => {
    const env = { ...process.env, ...task.env, ...arm.env, HINDSIGHT_HARNESS: 'eval', HINDSIGHT_ARM: arm.name }
    const agent = await runProcess(options.agent[0], options.agent.slice(1), {
      cwd: task.cwd,
      env,
      stdin: task.prompt,
      timeoutMs: options.timeoutMs,
    })
    const note = [agent.error, agent.timedOut ? 'agent timed out' : null].filter(Boolean).join('; ') || null
    if (agent.exitCode !== 0 || agent.timedOut || agent.error) {
      return { passed: false, durationMs: agent.durationMs, tokens: usageTokens(agent.stdout), note }
    }
    const check = checkCommand(task.check)
    const verified = await runProcess(check.command, check.args, {
      cwd: typeof task.checkCwd === 'string' ? task.checkCwd : task.cwd,
      env,
      timeoutMs: options.timeoutMs,
    })
    return {
      passed: verified.exitCode === 0,
      durationMs: agent.durationMs + verified.durationMs,
      tokens: usageTokens(agent.stdout),
      note: verified.exitCode === 0 ? note : (note ?? 'check failed') + (verified.stderr ? `: ${verified.stderr.trim().split('\n').slice(-1)[0]}` : ''),
    }
  }
}

function fakeRunner({ task, arm }) {
  return {
    passed: true,
    durationMs: 1,
    note: `dry run: would run ${arm.name} on ${task.id}`,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const tasks = readTasks(options.tasks)
  const report = await evaluate({
    tasks,
    arms: options.arms,
    repeats: options.repeats,
    runTask: options.dryRun ? fakeRunner : defaultRunner(options),
  })
  console.log(formatReport(report))
  if (options.report) console.log(`report written to ${writeReport(report, options.report)}`)
}

main().catch((error) => {
  console.error(`ab: ${error.message}`)
  process.exitCode = 1
})
