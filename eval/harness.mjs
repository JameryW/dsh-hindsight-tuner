/**
 * Attempt-aware A/B harness.
 *
 * evaluate() runs every arm × task × repeat combination and, for each run,
 * attempts up to `task.maxAttempts` times until the task passes. It emits one
 * row per attempt plus one derived run per combination, computes per-arm
 * metrics and a structural completeness check, and keeps failed/timeout runs
 * in every metric (explicitly, never silently dropped).
 *
 * Library code never writes to the console; eval/ab.mjs owns CLI output.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  assertComplete,
  costOfRow,
  formatStatsReport,
  normalizePrices,
  pairedComparison,
  percentile,
  summarizeArm,
} from './stats.mjs'

export { percentile }

export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Default arms are the three memory modalities the plugin can express through
 * HINDSIGHT_AUTO_INJECT alone. The preregistered gate matrix (including arms
 * that need an agent wrapper) lives in eval/arms.example.json.
 */
export const DEFAULT_ARMS = [
  {
    name: 'A0',
    label: 'no memory',
    description: 'No Hindsight injection at all.',
    env: { HINDSIGHT_AUTO_INJECT: 'none' },
  },
  {
    name: 'A2',
    label: 'reflect',
    description: 'Reflect-before-first-turn injection only.',
    env: { HINDSIGHT_AUTO_INJECT: 'reflect' },
  },
  {
    name: 'A3',
    label: 'pages',
    description: 'Native Pages injection.',
    env: { HINDSIGHT_AUTO_INJECT: 'pages' },
  },
]

function fail(message) {
  throw new TypeError(message)
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`)
  return value
}

/** Parse and validate a preregistered primary comparison ("A3:A1" or [A3, A1]). */
export function parsePrimary(primary, armNames) {
  if (primary === null || primary === undefined || primary === '') return null
  let treatment
  let baseline
  if (Array.isArray(primary)) {
    if (primary.length !== 2) fail('primary must contain exactly two arm names')
    ;[treatment, baseline] = primary
  } else if (typeof primary === 'string') {
    const parts = primary.split(':')
    if (parts.length !== 2) fail(`primary must be "ARM:ARM" (got ${JSON.stringify(primary)})`)
    ;[treatment, baseline] = parts
  } else {
    fail('primary must be a string "ARM:ARM" or an array of two arm names')
  }
  treatment = typeof treatment === 'string' ? treatment.trim() : ''
  baseline = typeof baseline === 'string' ? baseline.trim() : ''
  if (!treatment || !baseline) fail(`primary must be "ARM:ARM" (got ${JSON.stringify(primary)})`)
  if (treatment === baseline) fail(`primary must compare two different arms (got ${JSON.stringify(primary)})`)
  if (Array.isArray(armNames) && armNames.length > 0) {
    for (const name of [treatment, baseline]) {
      if (!armNames.includes(name)) {
        fail(
          `primary references unknown arm ${JSON.stringify(name)}; known arms: ${armNames.join(', ')}`,
        )
      }
    }
  }
  return `${treatment}:${baseline}`
}

function normalizeMaxAttempts(value, label, fallback = DEFAULT_MAX_ATTEMPTS) {
  if (value === null || value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be an integer >= 1`)
  return value
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : now
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) fail('now must produce a valid date')
  return date
}

function normalizeArmList(arms) {
  if (!Array.isArray(arms) || arms.length === 0) fail('evaluate requires a non-empty arms array')
  const names = new Set()
  const normalized = arms.map((arm, index) => {
    if (!arm || typeof arm !== 'object') fail(`arms[${index}] must be an object`)
    const name = assertNonEmptyString(arm.name, `arms[${index}].name`)
    if (names.has(name)) fail(`duplicate arm name ${JSON.stringify(name)}`)
    names.add(name)
    if (arm.env !== undefined && (arm.env === null || typeof arm.env !== 'object' || Array.isArray(arm.env))) {
      fail(`arms[${index}].env must be an object when present`)
    }
    return arm
  })
  return normalized
}

function normalizeTaskList(tasks, defaultMaxAttempts) {
  if (!Array.isArray(tasks) || tasks.length === 0) fail('evaluate requires a non-empty tasks array')
  const ids = new Set()
  return tasks.map((task, index) => {
    if (!task || typeof task !== 'object') fail(`tasks[${index}] must be an object`)
    const id = assertNonEmptyString(task.id, `tasks[${index}].id`)
    if (ids.has(id)) fail(`duplicate task id ${JSON.stringify(id)}`)
    ids.add(id)
    if (typeof task.prompt !== 'string' || !task.prompt) {
      fail(`tasks[${index}].prompt must be a non-empty string`)
    }
    const maxAttempts = normalizeMaxAttempts(
      task.maxAttempts,
      `tasks[${index}].maxAttempts`,
      defaultMaxAttempts,
    )
    return { ...task, maxAttempts }
  })
}

function normalizeUsage(raw, context) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`${context}: usage must be an object or null`)
  const fields = {
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
  }
  const usage = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      usage[key] = 0
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`${context}: usage.${key} must be a non-negative finite number`)
    }
    usage[key] = value
  }
  return usage
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function clipString(value, limit) {
  if (typeof value !== 'string' || !value) return null
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}

function buildRow({ task, arm, repeat, attempt, outcome, priceTable }) {
  const context = `runTask(${task.id}, ${arm.name}, repeat ${repeat}, attempt ${attempt})`
  const raw = outcome && typeof outcome === 'object' ? outcome : {}
  let passed = raw.passed === true
  let contractError = null
  if (typeof raw.passed !== 'boolean') {
    passed = false
    contractError = 'runner returned no boolean passed flag'
  }
  const usage = normalizeUsage(raw.usage, context)
  const usageTokens = usage
    ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    : null
  const explicitTokens = finiteOrNull(raw.tokens)
  let tokens = explicitTokens
  if (tokens === null && usageTokens !== null && usageTokens > 0) tokens = usageTokens
  if (tokens === null && usageTokens === 0) tokens = 0
  const durationMs = finiteOrNull(raw.durationMs)
  const errorParts = []
  if (contractError) errorParts.push(contractError)
  if (typeof raw.error === 'string' && raw.error.trim()) errorParts.push(raw.error.trim())
  const note = clipString(typeof raw.note === 'string' ? raw.note.trim() : null, 1000)

  const row = {
    taskId: task.id,
    arm: arm.name,
    repeat,
    attempt,
    passed,
    tokens,
    usage,
    durationMs,
    cost: null,
    failureSignature: clipString(
      typeof raw.failureSignature === 'string' ? raw.failureSignature.trim() : null,
      160,
    ),
    error: errorParts.length > 0 ? clipString(errorParts.join('; '), 1000) : null,
  }
  row.cost = costOfRow(row, priceTable)
  if (note) row.note = note
  return row
}

function deriveRun(runRows) {
  const first = runRows[0]
  const passRow = runRows.find((row) => row.passed === true) ?? null
  const tokens = runRows.map((row) => row.tokens).filter((value) => value !== null)
  const costs = runRows.map((row) => row.cost).filter((value) => value !== null)
  const durations = runRows.map((row) => row.durationMs).filter((value) => value !== null)
  return {
    taskId: first.taskId,
    arm: first.arm,
    repeat: first.repeat,
    passed: passRow !== null,
    attempts: runRows.length,
    successAtAttempt: passRow ? passRow.attempt : null,
    tokens: tokens.length > 0 ? tokens.reduce((total, value) => total + value, 0) : null,
    cost: costs.length > 0 ? costs.reduce((total, value) => total + value, 0) : null,
    durationMs: durations.length > 0 ? durations.reduce((total, value) => total + value, 0) : null,
  }
}

function normalizePricesOrZeros(prices) {
  if (prices === null || prices === undefined) return normalizePrices()
  return normalizePrices(prices)
}

/**
 * Run an experiment.
 *
 * @param {object} options
 * @param {Array} options.tasks tasks with `{id, prompt, maxAttempts?}`
 * @param {Array} options.arms arms with `{name, env?, ...}`
 * @param {Function} options.runTask async ({task, arm, repeat, attempt, worktree, fingerprint})
 *   => {passed, tokens?, usage?, durationMs?, note?, failureSignature?, error?}
 * @param {number} [options.repeats=1]
 * @param {Function|number} [options.now=Date.now]
 * @param {string[]} [options.armOrder] exact permutation of arm names to control run order
 * @param {string} [options.primary] preregistered "treatment:baseline" comparison
 * @param {Function} [options.onRow] called with every emitted attempt row
 * @param {object} [options.prices] USD per-million-token prices
 * @param {object} [options.fingerprint] frozen bank fingerprint passed to runTask
 * @param {number} [options.defaultMaxAttempts=3]
 * @param {Function} [options.prepareRun] async ({task, arm, repeat}) => context
 * @param {Function} [options.finishRun] async ({task, arm, repeat, worktree, rows, context})
 */
export async function evaluate(options = {}) {
  const {
    tasks: rawTasks,
    arms: rawArms,
    runTask,
    repeats = 1,
    now = Date.now,
    armOrder,
    primary = null,
    onRow,
    prices = null,
    fingerprint = null,
    defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS,
    prepareRun,
    finishRun,
  } = options
  if (typeof runTask !== 'function') fail('evaluate requires a runTask function')
  if (onRow !== undefined && typeof onRow !== 'function') fail('onRow must be a function')
  if (prepareRun !== undefined && typeof prepareRun !== 'function') fail('prepareRun must be a function')
  if (finishRun !== undefined && typeof finishRun !== 'function') fail('finishRun must be a function')
  if (!Number.isInteger(repeats) || repeats < 1) fail('repeats must be an integer >= 1')
  const maxAttemptsDefault = normalizeMaxAttempts(defaultMaxAttempts, 'defaultMaxAttempts', DEFAULT_MAX_ATTEMPTS)

  const arms = normalizeArmList(rawArms ?? DEFAULT_ARMS)
  const tasks = normalizeTaskList(rawTasks, maxAttemptsDefault)
  const armNames = arms.map((arm) => arm.name)
  const order = armOrder === undefined || armOrder === null ? armNames : armOrder
  if (!Array.isArray(order)) fail('armOrder must be an array of arm names')
  if (
    order.length !== armNames.length ||
    new Set(order).size !== order.length ||
    armNames.some((name) => !order.includes(name))
  ) {
    fail(`armOrder must be a permutation of the arm names (${armNames.join(', ')})`)
  }
  const primarySpec = parsePrimary(primary, armNames)
  const priceTable = normalizePricesOrZeros(prices)
  const armMap = new Map(arms.map((arm) => [arm.name, arm]))
  const generatedAt = normalizeNow(now).toISOString()

  const rows = []
  const runs = []
  for (const task of tasks) {
    for (const armName of order) {
      const arm = armMap.get(armName)
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        let context = null
        if (prepareRun) context = await prepareRun({ task, arm, repeat })
        const runRows = []
        try {
          for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
            let outcome
            try {
              outcome = await runTask({
                task,
                arm,
                repeat,
                attempt,
                worktree: context && context.worktree ? context.worktree : null,
                fingerprint: fingerprint ?? null,
              })
            } catch (error) {
              outcome = {
                passed: false,
                error: error instanceof Error ? error.message : String(error),
                failureSignature: 'runner-error',
              }
            }
            const row = buildRow({ task, arm, repeat, attempt, outcome, priceTable })
            rows.push(row)
            runRows.push(row)
            if (onRow) await onRow(row)
            if (row.passed) break
          }
        } finally {
          if (finishRun) {
            await finishRun({
              task,
              arm,
              repeat,
              worktree: context && context.worktree ? context.worktree : null,
              rows: runRows,
              context,
            })
          }
        }
        runs.push(deriveRun(runRows))
      }
    }
  }

  const metrics = {}
  for (const armName of order) {
    metrics[armName] = summarizeArm(
      rows.filter((row) => row.arm === armName),
      priceTable,
    )
  }
  const completeness = assertComplete(rows, {
    tasks: tasks.map((task) => ({ id: task.id, maxAttempts: task.maxAttempts })),
    arms: order,
    repeats,
    maxAttempts: maxAttemptsDefault,
  })

  return {
    generatedAt,
    repeats,
    arms,
    tasks,
    rows,
    runs,
    metrics,
    completeness,
    primary: primarySpec,
    prices: priceTable,
  }
}

function formatSigned(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  const number = Number(value)
  const sign = number > 0 ? '+' : ''
  return `${sign}${number.toFixed(digits)}`
}

function formatMetricDiff(metric, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  if (metric.unit === 'rate') return `${formatSigned(Number(value) * 100, 1)}pp`
  if (metric.unit === 'USD') return formatSigned(value, 4)
  return formatSigned(value, 2)
}

function failureReason(report, run) {
  const rows = Array.isArray(report.rows)
    ? report.rows.filter(
        (row) =>
          row.taskId === run.taskId &&
          row.arm === run.arm &&
          row.repeat === run.repeat,
      )
    : []
  if (rows.length === 0) return 'no attempt rows'
  const last = rows[rows.length - 1]
  if (last.error) return clipString(last.error, 160)
  if (last.failureSignature) return last.failureSignature
  return last.passed === false ? 'failed (no signature)' : 'unknown failure'
}

function taskMatrix(report) {
  const lines = []
  const armNames = report.arms.map((arm) => arm.name)
  const byTask = new Map()
  for (const run of report.runs) {
    let entry = byTask.get(run.taskId)
    if (!entry) {
      entry = new Map()
      byTask.set(run.taskId, entry)
    }
    const current = entry.get(run.arm) ?? { runs: 0, solved: 0 }
    current.runs += 1
    if (run.passed) current.solved += 1
    entry.set(run.arm, current)
  }
  const taskIds = [...byTask.keys()].sort()
  if (taskIds.length === 0) return lines
  const width = Math.max(4, ...taskIds.map((id) => id.length))
  const headers = ['task'.padEnd(width), ...armNames.map((name) => name.padStart(9))]
  lines.push(headers.join('  '))
  for (const taskId of taskIds) {
    const cells = armNames.map((arm) => {
      const entry = byTask.get(taskId).get(arm)
      return (entry ? `${entry.solved}/${entry.runs}` : '—').padStart(9)
    })
    lines.push([taskId.padEnd(width), ...cells].join('  '))
  }
  return lines
}

/**
 * Render a human-readable report: arm table, paired comparison for the
 * preregistered primary, completeness warnings, failed/timeout inventory, and
 * a task × arm solved-runs matrix.
 */
export function formatReport(report, options = {}) {
  if (!report || typeof report !== 'object') throw new TypeError('formatReport requires a report object')
  if (!Array.isArray(report.arms) || !Array.isArray(report.rows) || !Array.isArray(report.runs)) {
    throw new TypeError('formatReport requires a report with arms, rows and runs arrays')
  }
  const armNames = report.arms.map((arm) => arm.name)
  const primarySpec = parsePrimary(options.primary ?? report.primary ?? null, armNames)
  const seed = options.seed ?? 20260101
  const bootstraps = options.bootstraps ?? 4000
  const alpha = options.alpha ?? 0.05

  const lines = []
  lines.push(`eval report · generated ${report.generatedAt}`)
  lines.push(
    `  ${report.tasks.length} tasks × ${armNames.length} arms × ${report.repeats} repeats` +
      ` · ${report.rows.length} attempt rows · ${report.runs.length} runs`,
  )
  lines.push(`  arms: ${armNames.join(', ')}`)
  lines.push(
    '  failed, errored and timed-out runs are included in every rate and cost (no post-hoc exclusion)',
  )
  lines.push('')
  lines.push(formatStatsReport(report))

  if (primarySpec) {
    const [treatment, baseline] = primarySpec.split(':')
    const treatmentRows = report.rows.filter((row) => row.arm === treatment)
    const baselineRows = report.rows.filter((row) => row.arm === baseline)
    lines.push('')
    if (treatmentRows.length === 0 || baselineRows.length === 0) {
      lines.push(`paired comparison ${treatment} - ${baseline}: unavailable (one arm has no rows)`)
    } else {
      const comparison = pairedComparison(baselineRows, treatmentRows, {
        seed,
        bootstraps,
        alpha,
        prices: report.prices ?? null,
      })
      lines.push(
        `paired comparison (task-cluster bootstrap, ${comparison.nTasks} tasks, seed ${seed}, ` +
          `${bootstraps} resamples, ${((1 - alpha) * 100).toFixed(0)}% CI): ` +
          `${treatment} (treatment) - ${baseline} (baseline)`,
      )
      lines.push(
        '  negative = treatment lower than baseline (cost/attempts lower is better; success lower is worse)',
      )
      const entries = [
        ['cost/solved', comparison.metrics.costPerSolved],
        ['attempts', comparison.metrics.attempts],
        ['success', comparison.metrics.success],
      ]
      for (const [label, metric] of entries) {
        const signs = metric.signs
        lines.push(
          `  ${label.padEnd(12)} ${formatMetricDiff(metric, metric.meanDiff)}` +
            `  [${formatMetricDiff(metric, metric.ciLow)}, ${formatMetricDiff(metric, metric.ciHigh)}]` +
            `  p=${metric.pValue === null ? 'n/a' : metric.pValue.toFixed(4)}` +
            `  n=${metric.n}  signs +${signs.positive}/-${signs.negative}/0${signs.zero}`,
        )
      }
    }
  }

  const failedRuns = report.runs.filter((run) => !run.passed)
  failedRuns.sort((a, b) =>
    a.arm === b.arm
      ? a.taskId === b.taskId
        ? a.repeat - b.repeat
        : a.taskId < b.taskId
          ? -1
          : 1
      : a.arm < b.arm
        ? -1
        : 1,
  )
  lines.push('')
  lines.push(
    `failed/timeout runs (${failedRuns.length}/${report.runs.length}), kept in every metric:`,
  )
  if (failedRuns.length === 0) {
    lines.push('  none')
  } else {
    const shown = failedRuns.slice(0, 40)
    for (const run of shown) {
      lines.push(
        `  - ${run.taskId} · ${run.arm} · repeat ${run.repeat} · ${run.attempts} attempt(s)` +
          ` · ${failureReason(report, run)}`,
      )
    }
    if (failedRuns.length > shown.length) {
      lines.push(`  ... and ${failedRuns.length - shown.length} more (see the JSON report)`)
    }
  }

  const matrix = taskMatrix(report)
  if (matrix.length > 0) {
    lines.push('')
    lines.push('task × arm (solved runs / runs):')
    lines.push(...matrix)
  }
  return lines.join('\n')
}

let tempCounter = 0

/** Atomically write the JSON report. */
export function writeReport(report, file) {
  if (!report || typeof report !== 'object') throw new TypeError('writeReport requires a report object')
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('writeReport requires a file path')
  const target = resolve(file)
  mkdirSync(dirname(target), { recursive: true })
  tempCounter += 1
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${tempCounter}`
  try {
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Keep the original write error.
    }
    throw new Error(`cannot write report ${target}: ${error && error.message ? error.message : error}`, {
      cause: error,
    })
  }
  return target
}

/** Backwards-compatible helper: summarize rows grouped by arm into one object. */
export function summarize(rows) {
  if (!Array.isArray(rows)) throw new TypeError('summarize requires an array of attempt rows')
  const groups = new Map()
  for (const row of rows) {
    if (!row || typeof row.arm !== 'string') {
      throw new TypeError('summarize requires rows with a string arm')
    }
    const list = groups.get(row.arm) ?? []
    list.push(row)
    groups.set(row.arm, list)
  }
  const result = {}
  for (const arm of [...groups.keys()].sort()) {
    result[arm] = summarizeArm(groups.get(arm))
  }
  return result
}
