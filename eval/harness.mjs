// A/B harness for the memory lane.
//
// The plugin can see what Hindsight sent, how large it was and whether it was
// repeated, but it cannot see whether the agent then did the task better. That
// judgement needs an outside loop: the same task set run once per arm, with a
// verifiable check per task. This module is the outside loop, kept free of any
// network or model call so it can be tested without credentials.
//
// Contract between the harness and a runner:
//
//   await runTask({ task, arm, repeat }) -> { passed, durationMs, tokens?, note? }
//
// A task is `{ id, prompt, check }`; the runner prepares an isolated working
// copy, invokes the agent with the arm's environment, then runs `check` there.
// An arm is `{ name, env }`; the harness only merges `env` into the runner's
// environment, so arms stay a data problem, not a code branch.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_ARMS = [
  { name: 'no-memory', env: { HINDSIGHT_AUTO_INJECT: 'none' } },
  { name: 'pages', env: { HINDSIGHT_AUTO_INJECT: 'pages' } },
  { name: 'recall', env: { HINDSIGHT_AUTO_INJECT: 'recall' } },
]

/** Nearest-rank percentile; null for an empty sample so a report never invents a number. */
export function percentile(values, percent) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (clean.length === 0) return null
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((percent / 100) * clean.length) - 1))
  return clean[index]
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null
}

/**
 * Per-arm metrics. Success rate is the headline number; tokens and latency are
 * reported only when the runner supplied them, so an arm that cannot report
 * usage stays visible instead of sorting as "free".
 */
export function summarize(rows) {
  const arms = [...new Set(rows.map((row) => row.arm))]
  const metrics = {}
  for (const arm of arms) {
    const armRows = rows.filter((row) => row.arm === arm)
    const passed = armRows.filter((row) => row.passed).length
    const tokens = armRows.map((row) => row.tokens).filter((value) => Number.isFinite(value))
    const durations = armRows.map((row) => row.durationMs).filter((value) => Number.isFinite(value))
    const tokensPerSuccess = passed > 0 && tokens.length > 0
      ? round(tokens.reduce((sum, value) => sum + value, 0) / passed)
      : null
    metrics[arm] = {
      runs: armRows.length,
      passed,
      successRate: armRows.length > 0 ? round((passed / armRows.length) * 100) : null,
      tokens: tokens.length > 0 ? round(tokens.reduce((sum, value) => sum + value, 0) / tokens.length) : null,
      tokensPerSuccess,
      durationP50Ms: percentile(durations, 50),
      durationP95Ms: percentile(durations, 95),
    }
  }
  return metrics
}

/**
 * Run every task under every arm, `repeats` times, and return the raw rows
 * plus per-arm metrics. Rows are kept unaggregated on purpose: a report is
 * only credible if the individual outcomes can be inspected.
 */
export async function evaluate({ tasks = [], arms = DEFAULT_ARMS, runTask, repeats = 1, now = Date.now() } = {}) {
  if (typeof runTask !== 'function') throw new TypeError('evaluate: runTask must be a function')
  if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError('evaluate: at least one task is required')
  if (!Array.isArray(arms) || arms.length === 0) throw new TypeError('evaluate: at least one arm is required')
  const runCount = Math.max(1, Math.trunc(repeats) || 1)
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || task.id === '') throw new TypeError('evaluate: every task needs an id')
    if (typeof task.prompt !== 'string' || task.prompt === '') throw new TypeError(`evaluate: task ${task.id} needs a prompt`)
  }
  for (const arm of arms) {
    if (!arm || typeof arm.name !== 'string' || arm.name === '') throw new TypeError('evaluate: every arm needs a name')
    if (arm.env != null && typeof arm.env !== 'object') throw new TypeError(`evaluate: arm ${arm.name} env must be an object`)
  }

  const rows = []
  for (const task of tasks) {
    for (const arm of arms) {
      for (let repeat = 0; repeat < runCount; repeat += 1) {
        const result = await runTask({ task, arm, repeat })
        rows.push({
          task: task.id,
          arm: arm.name,
          repeat,
          passed: Boolean(result?.passed),
          durationMs: Number.isFinite(result?.durationMs) ? Math.round(result.durationMs) : null,
          tokens: Number.isFinite(result?.tokens) ? Math.round(result.tokens) : null,
          note: typeof result?.note === 'string' ? result.note.slice(0, 300) : null,
        })
      }
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    repeats: runCount,
    arms: arms.map((arm) => arm.name),
    tasks: tasks.map((task) => task.id),
    rows,
    metrics: summarize(rows),
  }
}

/** A compact text report; the JSON report is the machine-readable one. */
export function formatReport(report) {
  const lines = [`generated ${report.generatedAt} · ${report.tasks.length} tasks × ${report.arms.length} arms × ${report.repeats} repeats`]
  for (const arm of report.arms) {
    const metric = report.metrics[arm]
    const tokens = metric.tokens == null ? 'tokens n/a' : `${metric.tokens} tok/run, ${metric.tokensPerSuccess ?? 'n/a'} tok/success`
    lines.push(
      `${arm.padEnd(12)} success ${String(metric.successRate ?? 'n/a').padStart(5)}%  ` +
        `(${metric.passed}/${metric.runs})  ${tokens}  p50 ${metric.durationP50Ms ?? 'n/a'}ms  p95 ${metric.durationP95Ms ?? 'n/a'}ms`,
    )
  }
  const failed = report.rows.filter((row) => !row.passed)
  if (failed.length > 0) {
    lines.push('failed runs:')
    for (const row of failed) lines.push(`  ${row.task} · ${row.arm}${row.repeat ? ` · repeat ${row.repeat}` : ''}`)
  }
  lines.push('')
  lines.push('task'.padEnd(24) + report.arms.map((arm) => arm.padEnd(12)).join(''))
  for (const task of report.tasks) {
    const cells = report.arms.map((arm) => {
      const runs = report.rows.filter((row) => row.task === task && row.arm === arm)
      if (runs.length === 0) return '-'.padEnd(12)
      const wins = runs.filter((row) => row.passed).length
      return `${wins}/${runs.length}`.padEnd(12)
    })
    lines.push(String(task).padEnd(24) + cells.join(''))
  }
  return lines.join('\n')
}

export function writeReport(report, file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return file
}
