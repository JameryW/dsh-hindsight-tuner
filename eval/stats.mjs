/**
 * Statistics for attempt-level A/B evaluation.
 *
 * A "row" is one attempt:
 *   { taskId, arm, repeat, attempt, passed, tokens,
 *     usage: { input, output, cacheRead, cacheWrite } | null,
 *     durationMs, cost, failureSignature | null, error | null }
 *
 * A "run" is every attempt spent on one (taskId, arm, repeat) combination.
 * A task is solved when at least one run for it passes.
 *
 * Everything here is pure and deterministic (seeded mulberry32 bootstrap).
 * Nothing in this module writes to the console.
 */

export const ZERO_PRICES = Object.freeze({
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
})

const PRICE_KEYS = Object.keys(ZERO_PRICES)
const ZERO_SIGNS = Object.freeze({ positive: 0, negative: 0, zero: 0 })

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function asFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asTokenCount(value) {
  const number = asFiniteNumber(value)
  return number !== null && number >= 0 ? number : null
}

export function round(value, digits = 6) {
  const number = asFiniteNumber(value)
  if (number === null) return null
  const factor = 10 ** digits
  return Math.round((number + Number.EPSILON) * factor) / factor
}

function mean(values) {
  if (values.length === 0) return null
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function sum(values) {
  let total = 0
  for (const value of values) total += value
  return total
}

/** Normalize a price object; missing prices are zero. Throws on invalid values. */
export function normalizePrices(prices) {
  if (prices === null || prices === undefined) return { ...ZERO_PRICES }
  if (typeof prices !== 'object' || Array.isArray(prices)) {
    throw new TypeError(`prices must be an object (got ${Array.isArray(prices) ? 'array' : typeof prices})`)
  }
  const normalized = {}
  for (const key of PRICE_KEYS) {
    const raw = prices[key]
    if (raw === null || raw === undefined || raw === '') {
      normalized[key] = 0
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`prices.${key} must be a finite non-negative number (got ${JSON.stringify(raw)})`)
    }
    normalized[key] = value
  }
  return normalized
}

function isZeroPrices(prices) {
  return PRICE_KEYS.every((key) => prices[key] === 0)
}

function usageOf(row) {
  const raw = row && row.usage
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`row usage must be an object or null (got ${Array.isArray(raw) ? 'array' : typeof raw})`)
  }
  const fields = {
    input: asTokenCount(raw.input),
    output: asTokenCount(raw.output),
    cacheRead: asTokenCount(raw.cacheRead),
    cacheWrite: asTokenCount(raw.cacheWrite),
  }
  if (Object.values(fields).every((value) => value === null)) return null
  return {
    input: fields.input ?? 0,
    output: fields.output ?? 0,
    cacheRead: fields.cacheRead ?? 0,
    cacheWrite: fields.cacheWrite ?? 0,
  }
}

function totalUsageTokens(usage) {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/**
 * Cost of one attempt row in USD, from per-million-token prices.
 *
 * Special case: when every price is zero, `cost` is the row's total token count
 * instead of 0 USD. That keeps cost-based analyses (cost per solved task,
 * paired cost differences) meaningful when no price list is supplied; token
 * counts are then a proxy unit, not dollars. The proxy prefers the row's
 * canonical `tokens` value (so cost and the `tokens` metric share one scale) and
 * only falls back to summing the usage fields when `tokens` is absent.
 *
 * When a row has no token usage but does carry `cost`, that cost is returned
 * unchanged (allows external data to be analysed without re-pricing).
 */
export function costOfRow(row, prices = ZERO_PRICES) {
  const priceTable = normalizePrices(prices)
  const usage = usageOf(row)
  const rowTokens = asTokenCount(row && row.tokens)
  let totalTokens = usage ? totalUsageTokens(usage) : rowTokens
  if ((totalTokens === null || totalTokens === 0) && rowTokens !== null && rowTokens > 0) {
    totalTokens = rowTokens
  }

  if (totalTokens === null) {
    const explicit = asFiniteNumber(row && row.cost)
    return explicit !== null && explicit >= 0 ? round(explicit, 6) : null
  }
  if (isZeroPrices(priceTable)) {
    const proxy = rowTokens !== null && rowTokens > 0 ? rowTokens : totalTokens
    return round(proxy, 6)
  }

  let cost
  if (usage && totalUsageTokens(usage) > 0) {
    cost =
      (usage.input / 1_000_000) * priceTable.inputPerMTok +
      (usage.output / 1_000_000) * priceTable.outputPerMTok +
      (usage.cacheRead / 1_000_000) * priceTable.cacheReadPerMTok +
      (usage.cacheWrite / 1_000_000) * priceTable.cacheWritePerMTok
  } else {
    // Only a total token count is known (or the usage fields are all zero while
    // a positive token count was reported): price it at the uncached input rate.
    // An all-zero usage object is not enough information to price a row, and
    // the weighted branch would silently return 0 USD.
    cost = ((rowTokens ?? totalTokens) / 1_000_000) * priceTable.inputPerMTok
  }
  return round(cost, 6)
}

/** Nearest-rank percentile over an ascending-sorted array; p is a 0..1 fraction. */
export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null
  const fraction = Math.min(1, Math.max(0, Number(p)))
  const rank = Math.ceil(fraction * sortedValues.length)
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1))
  return sortedValues[index]
}

function sortedPercentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return percentile(sorted, p)
}

function assertRowShape(row, context, { requirePassed = true } = {}) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError(`${context}: each row must be an object`)
  }
  if (typeof row.taskId !== 'string' || !row.taskId) {
    throw new TypeError(`${context}: row.taskId must be a non-empty string`)
  }
  if (typeof row.arm !== 'string' || !row.arm) {
    throw new TypeError(`${context}: row.arm must be a non-empty string`)
  }
  if (!Number.isInteger(row.repeat) || row.repeat < 0) {
    throw new TypeError(`${context}: row.repeat must be a non-negative integer`)
  }
  if (!Number.isInteger(row.attempt) || row.attempt < 1) {
    throw new TypeError(`${context}: row.attempt must be an integer >= 1`)
  }
  if (requirePassed && typeof row.passed !== 'boolean') {
    throw new TypeError(`${context}: row.passed must be a boolean`)
  }
}

function groupRuns(rows) {
  const runs = new Map()
  for (const row of rows) {
    const key = JSON.stringify([row.taskId, row.arm, row.repeat])
    let run = runs.get(key)
    if (!run) {
      run = { taskId: row.taskId, arm: row.arm, repeat: row.repeat, rows: [] }
      runs.set(key, run)
    }
    run.rows.push(row)
  }
  for (const run of runs.values()) {
    run.rows.sort((a, b) => a.attempt - b.attempt)
  }
  return [...runs.values()]
}

function rowCost(row, prices) {
  if (prices !== null && prices !== undefined) return costOfRow(row, prices)
  const explicit = asFiniteNumber(row.cost)
  if (explicit !== null && explicit >= 0) return explicit
  return costOfRow(row, ZERO_PRICES)
}

function isIncompleteRun(run) {
  const { rows } = run
  if (rows.length === 0) return true
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].attempt !== index + 1) return true
  }
  const passedIndexes = []
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].passed === true) passedIndexes.push(index)
  }
  if (passedIndexes.length > 0) {
    // Attempts must stop at the first success.
    return passedIndexes[0] !== rows.length - 1 || passedIndexes.length !== 1
  }
  return false
}

/**
 * Summarize every attempt row for a single arm.
 *
 * `tokens` is the mean total tokens per run (failed runs included);
 * `tokensPerSuccess` is total tokens divided by solved runs. `costPerSolved`
 * is total cost divided by solved runs (null when nothing was solved).
 */
export function summarizeArm(rows, prices = undefined) {
  if (!Array.isArray(rows)) throw new TypeError('summarizeArm requires an array of attempt rows')
  if (rows.length === 0) {
    return {
      arm: null,
      tasks: 0,
      runs: 0,
      attempts: 0,
      successRate: null,
      firstAttemptSuccessRate: null,
      attemptsToSuccessMean: null,
      costPerSolved: null,
      tokens: null,
      tokensPerSuccess: null,
      durationP50Ms: null,
      durationP95Ms: null,
      failedTasks: 0,
      incomplete: 0,
    }
  }
  rows.forEach((row) => assertRowShape(row, 'summarizeArm'))
  const arm = rows[0].arm
  if (rows.some((row) => row.arm !== arm)) {
    throw new TypeError('summarizeArm requires rows from exactly one arm')
  }

  normalizePrices(prices)
  const pricedByRow = new Map()
  for (const row of rows) {
    pricedByRow.set(row, {
      cost: rowCost(row, prices),
      tokens: asTokenCount(row.tokens),
      duration: asFiniteNumber(row.durationMs),
    })
  }

  const runs = groupRuns(rows)
  const solvedRuns = []
  const firstAttemptPasses = []
  const successAttempts = []
  const runTokens = []
  const runDurations = []
  let incomplete = 0
  const solvedTaskIds = new Set()

  for (const run of runs) {
    if (isIncompleteRun(run)) incomplete += 1
    const runPriced = run.rows.map((row) => pricedByRow.get(row))
    const passRow = run.rows.find((row) => row.passed === true) ?? null
    if (passRow) {
      solvedRuns.push(run)
      solvedTaskIds.add(run.taskId)
      successAttempts.push(passRow.attempt)
    }
    const first = run.rows.find((row) => row.attempt === 1) ?? null
    if (first && first.passed === true) firstAttemptPasses.push(run)

    const tokensForRun = runPriced.map((entry) => entry.tokens).filter((value) => value !== null)
    const durationsForRun = runPriced.map((entry) => entry.duration).filter((value) => value !== null)
    if (tokensForRun.length > 0) runTokens.push(sum(tokensForRun))
    if (durationsForRun.length > 0) runDurations.push(sum(durationsForRun))
  }

  const allTasks = new Set(rows.map((row) => row.taskId))
  const failedTasks = [...allTasks].filter((taskId) => !solvedTaskIds.has(taskId)).length
  const priced = [...pricedByRow.values()]
  const totalTokens = sum(priced.map((entry) => entry.tokens).filter((value) => value !== null))
  const hasTokenData = priced.some((entry) => entry.tokens !== null)
  const totalCost = sum(priced.map((entry) => entry.cost).filter((value) => value !== null))
  const hasCostData = priced.some((entry) => entry.cost !== null)

  return {
    arm,
    tasks: allTasks.size,
    runs: runs.length,
    attempts: rows.length,
    successRate: runs.length > 0 ? round((solvedRuns.length / runs.length) * 100, 1) : null,
    firstAttemptSuccessRate:
      runs.length > 0 ? round((firstAttemptPasses.length / runs.length) * 100, 1) : null,
    attemptsToSuccessMean: successAttempts.length > 0 ? round(mean(successAttempts), 2) : null,
    costPerSolved:
      solvedRuns.length > 0 && hasCostData ? round(totalCost / solvedRuns.length, 6) : null,
    tokens: hasTokenData && runTokens.length > 0 ? round(totalTokens / runTokens.length, 1) : null,
    tokensPerSuccess:
      solvedRuns.length > 0 && hasTokenData ? round(totalTokens / solvedRuns.length, 1) : null,
    durationP50Ms: sortedPercentile(runDurations, 0.5),
    durationP95Ms: sortedPercentile(runDurations, 0.95),
    failedTasks,
    incomplete,
  }
}

function normalizeTasks(tasks, defaultMaxAttempts) {
  if (!Array.isArray(tasks)) throw new TypeError('assertComplete: tasks must be an array')
  const map = new Map()
  for (const task of tasks) {
    const id = typeof task === 'string' ? task : task && task.id
    if (typeof id !== 'string' || !id) {
      throw new TypeError('assertComplete: every task must be a string id or an object with a string id')
    }
    if (map.has(id)) throw new TypeError(`assertComplete: duplicate task id ${JSON.stringify(id)}`)
    let maxAttempts = defaultMaxAttempts
    if (task && typeof task === 'object' && task.maxAttempts !== null && task.maxAttempts !== undefined) {
      if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
        throw new TypeError(`assertComplete: task ${JSON.stringify(id)} has an invalid maxAttempts`)
      }
      maxAttempts = task.maxAttempts
    }
    map.set(id, { id, maxAttempts })
  }
  return map
}

function normalizeArms(arms) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new TypeError('assertComplete: arms must be a non-empty array')
  }
  const names = arms.map((arm) => {
    const name = typeof arm === 'string' ? arm : arm && arm.name
    if (typeof name !== 'string' || !name) {
      throw new TypeError('assertComplete: every arm must be a string name or an object with a string name')
    }
    return name
  })
  if (new Set(names).size !== names.length) throw new TypeError('assertComplete: duplicate arm name')
  return names
}

function runLabel(taskId, arm, repeat) {
  return `task ${taskId} · arm ${arm} · repeat ${repeat}`
}

/**
 * Check that the attempt rows form a complete, well-formed experiment.
 *
 * Timeout/error rows are not problems: a run may legitimately exhaust all
 * attempts without passing. Problems are structural: missing (task, arm,
 * repeat) combinations, attempt-number gaps/duplicates/overflow, a run that
 * stops before maxAttempts without a pass, malformed passed flags, rows for
 * unknown tasks/arms/repeats.
 */
export function assertComplete(rows, { tasks, arms, repeats, maxAttempts = 3 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('assertComplete requires an array of attempt rows')
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new TypeError('assertComplete: repeats must be an integer >= 1')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('assertComplete: maxAttempts must be an integer >= 1')
  }
  const taskMap = normalizeTasks(tasks, maxAttempts)
  const armNames = normalizeArms(arms)
  const problems = []
  // Structural row validation is reported as a problem rather than thrown:
  // a malformed `passed` flag must show up in the completeness report.
  const usableRows = []
  for (const row of rows) {
    try {
      assertRowShape(row, 'assertComplete', { requirePassed: false })
      usableRows.push(row)
    } catch (error) {
      problems.push(`malformed row: ${error.message}`)
    }
  }

  const combos = new Map()
  for (const row of usableRows) {
    const key = JSON.stringify([row.taskId, row.arm, row.repeat])
    let list = combos.get(key)
    if (!list) {
      list = []
      combos.set(key, list)
    }
    list.push(row)
  }

  // Rows that do not belong to the declared experiment matrix.
  const seenUnknown = new Set()
  for (const row of usableRows) {
    if (!taskMap.has(row.taskId)) {
      const key = `task:${row.taskId}`
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key)
        problems.push(`unexpected row for unknown task ${JSON.stringify(row.taskId)}`)
      }
    }
    if (!armNames.includes(row.arm)) {
      const key = `arm:${row.arm}`
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key)
        problems.push(`unexpected row for unknown arm ${JSON.stringify(row.arm)}`)
      }
    }
    if (row.repeat >= repeats) {
      const key = `repeat:${row.taskId}:${row.arm}:${row.repeat}`
      if (!seenUnknown.has(key)) {
        seenUnknown.add(key)
        problems.push(`unexpected row for out-of-range repeat ${row.repeat} (${runLabel(row.taskId, row.arm, row.repeat)})`)
      }
    }
  }

  for (const task of taskMap.values()) {
    for (const arm of armNames) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const label = runLabel(task.id, arm, repeat)
        const list = combos.get(JSON.stringify([task.id, arm, repeat])) ?? []
        if (list.length === 0) {
          problems.push(`missing run: ${label} (no attempt rows)`)
          continue
        }

        const sorted = [...list].sort((a, b) => a.attempt - b.attempt)
        const seenAttempts = new Set()
        for (const row of sorted) {
          if (typeof row.passed !== 'boolean') {
            problems.push(`${label}: attempt ${row.attempt} has passed=${JSON.stringify(row.passed)} (expected boolean)`)
          }
          if (row.attempt > task.maxAttempts) {
            problems.push(
              `${label}: attempt ${row.attempt} exceeds maxAttempts ${task.maxAttempts}`,
            )
          }
          if (seenAttempts.has(row.attempt)) {
            problems.push(`${label}: duplicate attempt ${row.attempt}`)
          }
          seenAttempts.add(row.attempt)
        }

        const recorded = [...seenAttempts].sort((a, b) => a - b)
        const expectedPrefix = recorded.every((attempt, index) => attempt === index + 1)
        if (!expectedPrefix) {
          problems.push(
            `${label}: attempt numbers must be 1..${recorded.length} without gaps (recorded ${recorded.join(',')})`,
          )
        }

        const firstPass = sorted.find((row) => row.passed === true) ?? null
        if (firstPass) {
          if (firstPass.attempt !== recorded[recorded.length - 1]) {
            problems.push(`${label}: attempts recorded after the first pass at attempt ${firstPass.attempt}`)
          }
        } else {
          const lastAttempt = recorded.length > 0 ? recorded[recorded.length - 1] : 0
          if (lastAttempt < task.maxAttempts) {
            problems.push(
              `${label}: stopped early with no pass (recorded attempts 1..${lastAttempt} of ${task.maxAttempts})`,
            )
          }
        }
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

function emptyMetric(label, unit) {
  return {
    label,
    unit,
    n: 0,
    meanDiff: null,
    ciLow: null,
    ciHigh: null,
    pValue: null,
    signs: { ...ZERO_SIGNS },
  }
}

function bootstrapMetric(values, { bootstraps, seed, alpha, label, unit }) {
  if (values.length === 0) return emptyMetric(label, unit)
  const observed = mean(values)
  const signs = { positive: 0, negative: 0, zero: 0 }
  for (const value of values) {
    if (value > 0) signs.positive += 1
    else if (value < 0) signs.negative += 1
    else signs.zero += 1
  }
  const random = mulberry32(seed)
  const means = []
  const count = values.length
  for (let sample = 0; sample < bootstraps; sample += 1) {
    let total = 0
    for (let index = 0; index < count; index += 1) {
      total += values[Math.floor(random() * count)]
    }
    means.push(total / count)
  }
  means.sort((a, b) => a - b)
  const ciLow = percentile(means, alpha / 2)
  const ciHigh = percentile(means, 1 - alpha / 2)
  let below = 0
  let above = 0
  for (const value of means) {
    if (value <= 0) below += 1
    if (value >= 0) above += 1
  }
  const pValue = Math.min(1, 2 * Math.min((below + 1) / (bootstraps + 1), (above + 1) / (bootstraps + 1)))
  return {
    label,
    unit,
    n: values.length,
    meanDiff: round(observed, 6),
    ciLow: round(ciLow, 6),
    ciHigh: round(ciHigh, 6),
    pValue: round(pValue, 4),
    signs,
  }
}

function taskLevelStats(rows, prices) {
  const byTask = new Map()
  for (const row of rows) {
    let task = byTask.get(row.taskId)
    if (!task) {
      task = { taskId: row.taskId, runs: new Map() }
      byTask.set(row.taskId, task)
    }
    const key = row.repeat
    let run = task.runs.get(key)
    if (!run) {
      run = { repeat: row.repeat, rows: [] }
      task.runs.set(key, run)
    }
    run.rows.push(row)
  }
  const result = new Map()
  for (const [taskId, task] of byTask) {
    const runs = [...task.runs.values()]
    const solved = runs.filter((run) => run.rows.some((row) => row.passed === true))
    const attemptsMean = runs.length > 0 ? mean(runs.map((run) => run.rows.length)) : null
    const successRate = runs.length > 0 ? solved.length / runs.length : null
    let costTotal = 0
    let costSeen = false
    for (const run of runs) {
      for (const row of run.rows) {
        const cost = rowCost(row, prices)
        if (cost !== null) {
          costTotal += cost
          costSeen = true
        }
      }
    }
    const costPerSolved = costSeen && solved.length > 0 ? costTotal / solved.length : null
    result.set(taskId, { taskId, attemptsMean, successRate, costPerSolved })
  }
  return result
}

function singleArmName(rows, label) {
  if (rows.length === 0) return null
  const names = new Set(rows.map((row) => row.arm))
  if (names.size !== 1) {
    throw new TypeError(`${label} must contain rows from exactly one arm (found ${[...names].join(', ')})`)
  }
  return rows[0].arm
}

/**
 * Paired comparison of two arms over the same tasks.
 *
 * Direction: every reported difference is `treatment - baseline`, i.e. the
 * value for `rowsB` minus the value for `rowsA`. Negative cost/attempts
 * differences favour B; positive success differences favour B.
 *
 * Per-task values are computed with all repeats of that task kept together,
 * then tasks are resampled with replacement `bootstraps` times (task-cluster
 * bootstrap). Metrics with fewer than one defined pair report n=0/null.
 */
export function pairedComparison(rowsA, rowsB, options = {}) {
  if (!Array.isArray(rowsA) || !Array.isArray(rowsB)) {
    throw new TypeError('pairedComparison requires two row arrays')
  }
  rowsA.forEach((row) => assertRowShape(row, 'pairedComparison(rowsA)'))
  rowsB.forEach((row) => assertRowShape(row, 'pairedComparison(rowsB)'))

  const { seed = 20260101, bootstraps = 4000, alpha = 0.05, prices = null } = options
  if (!Number.isInteger(bootstraps) || bootstraps < 1) {
    throw new TypeError(`pairedComparison: bootstraps must be an integer >= 1 (got ${JSON.stringify(bootstraps)})`)
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new TypeError(`pairedComparison: alpha must be a number in (0,1) (got ${JSON.stringify(alpha)})`)
  }
  if (!Number.isFinite(seed)) throw new TypeError('pairedComparison: seed must be a finite number')

  const priceTable = prices === null || prices === undefined ? null : normalizePrices(prices)
  const armA = singleArmName(rowsA, 'rowsA')
  const armB = singleArmName(rowsB, 'rowsB')
  const statsA = taskLevelStats(rowsA, priceTable)
  const statsB = taskLevelStats(rowsB, priceTable)
  const sharedTasks = [...statsA.keys()].filter((taskId) => statsB.has(taskId)).sort()
  const pairs = sharedTasks.map((taskId) => ({ taskId, a: statsA.get(taskId), b: statsB.get(taskId) }))

  const costValues = []
  const attemptValues = []
  const successValues = []
  for (const pair of pairs) {
    if (pair.a.costPerSolved !== null && pair.b.costPerSolved !== null) {
      costValues.push(pair.b.costPerSolved - pair.a.costPerSolved)
    }
    if (pair.a.attemptsMean !== null && pair.b.attemptsMean !== null) {
      attemptValues.push(pair.b.attemptsMean - pair.a.attemptsMean)
    }
    if (pair.a.successRate !== null && pair.b.successRate !== null) {
      successValues.push(pair.b.successRate - pair.a.successRate)
    }
  }

  return {
    seed: seed >>> 0,
    bootstraps,
    alpha,
    difference: 'B - A (treatment - baseline)',
    armBaseline: armA,
    armTreatment: armB,
    nTasks: pairs.length,
    tasks: pairs.map((pair) => pair.taskId),
    metrics: {
      costPerSolved: bootstrapMetric(costValues, {
        bootstraps,
        seed,
        alpha,
        label: 'cost per solved node',
        unit: 'USD',
      }),
      attempts: bootstrapMetric(attemptValues, {
        bootstraps,
        seed,
        alpha,
        label: 'attempts per task',
        unit: 'attempts',
      }),
      success: bootstrapMetric(successValues, {
        bootstraps,
        seed: (seed + 1) >>> 0,
        alpha,
        label: 'task success risk difference',
        unit: 'rate',
      }),
    },
  }
}

/**
 * Memory benefit / tax / net value against a no-memory baseline, paired by task.
 *
 * A heavier memory system can lose to plain retrieval: it buys solved tasks
 * (benefit) but can also break tasks the model already solved without it (tax,
 * negative transfer). Success rates are per task across that arm's repeats, and
 * only tasks present in both arms are compared.
 *
 *   benefit  = mean over tasks of max(0, rate_memory - rate_baseline)
 *   tax      = mean over tasks of max(0, rate_baseline - rate_memory)
 *   netValue = benefit - tax
 *
 * `regressedTaskIds` names the exact tasks the memory arm made worse, which is
 * the actionable list: inspect those before adopting the arm.
 */
export function memoryValue(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('memoryValue requires an array of attempt rows')
  rows.forEach((row) => assertRowShape(row, 'memoryValue'))
  const armNames = [...new Set(rows.map((row) => row.arm))]
  if (armNames.length === 0) throw new TypeError('memoryValue requires at least one row')

  // Defaults follow the shipped arm matrix: R0 (bare baseline) then A0 (memory
  // disabled but the harness present). A caller can name any other arm.
  const requested = options.baseline ?? null
  const baseline = requested ?? (armNames.includes('R0') ? 'R0' : armNames.includes('A0') ? 'A0' : null)
  if (baseline === null) {
    return { baseline: null, tasks: 0, arms: [], reason: 'no no-memory baseline arm found (looked for R0/A0)' }
  }
  if (!armNames.includes(baseline)) {
    throw new TypeError(`memoryValue: baseline arm ${JSON.stringify(baseline)} is not among the rows (${armNames.join(', ')})`)
  }

  const runs = groupRuns(rows)
  const rateFor = (arm) => {
    const byTask = new Map()
    for (const run of runs) {
      if (run.arm !== arm) continue
      const entry = byTask.get(run.taskId) ?? { solved: 0, runs: 0 }
      entry.runs += 1
      if (run.rows.some((row) => row.passed === true)) entry.solved += 1
      byTask.set(run.taskId, entry)
    }
    return new Map(
      [...byTask].map(([taskId, entry]) => [taskId, entry.runs > 0 ? entry.solved / entry.runs : null]),
    )
  }

  const base = rateFor(baseline)
  const arms = []
  for (const arm of armNames) {
    if (arm === baseline) continue
    const mine = rateFor(arm)
    const improvedTaskIds = []
    const regressedTaskIds = []
    let benefitSum = 0
    let taxSum = 0
    let tasks = 0
    for (const [taskId, baseRate] of base) {
      const armRate = mine.get(taskId)
      if (baseRate === null || armRate === null || armRate === undefined) continue
      tasks += 1
      const delta = armRate - baseRate
      if (delta > 0) {
        benefitSum += delta
        improvedTaskIds.push(taskId)
      } else if (delta < 0) {
        taxSum += -delta
        regressedTaskIds.push(taskId)
      }
    }
    if (tasks === 0) continue
    const benefit = round(benefitSum / tasks, 4)
    const tax = round(taxSum / tasks, 4)
    arms.push({
      arm,
      tasks,
      benefit,
      tax,
      netValue: round(benefit - tax, 4),
      improvedTaskIds: improvedTaskIds.sort(),
      // Tasks where Tax > 0: the ones to read before trusting the arm.
      regressedTaskIds: regressedTaskIds.sort(),
    })
  }
  arms.sort((left, right) => right.netValue - left.netValue || left.arm.localeCompare(right.arm))
  return { baseline, tasks: base.size, arms }
}

/** One compact block for `formatReport`; null when there is no baseline. */
export function formatMemoryValue(value) {
  if (!value || !Array.isArray(value.arms) || value.arms.length === 0) return null
  const lines = [`memory value vs ${value.baseline} — mean per-task success-rate change (0..1)`]
  const header = `${'arm'.padEnd(14)}${'benefit'.padStart(9)}${'tax'.padStart(9)}${'net'.padStart(9)}  regressed`
  lines.push(header)
  for (const arm of value.arms) {
    const regressed = arm.regressedTaskIds.length > 0 ? arm.regressedTaskIds.join(', ') : '-'
    lines.push(
      `${String(arm.arm).padEnd(14)}${formatNumber(arm.benefit, 2).padStart(9)}${formatNumber(arm.tax, 2).padStart(9)}${formatNumber(arm.netValue, 2).padStart(9)}  ${regressed}`,
    )
  }
  return lines.join('\n')
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  return Number(value).toFixed(digits)
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  return `${Number(value).toFixed(1)}%`
}

function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  const number = Number(value)
  if (Math.abs(number) >= 1000) return number.toFixed(0)
  if (Math.abs(number) >= 1) return number.toFixed(2)
  return number.toFixed(4)
}

function formatInteger(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a'
  return String(Math.round(Number(value)))
}

/**
 * Render an arm summary table, plus completeness problems when present.
 * Accepts an evaluate() report, an array of summaries, or a single summary.
 */
export function formatStatsReport(result) {
  let summaries = []
  let completeness = null
  if (Array.isArray(result)) {
    summaries = result
  } else if (result && typeof result === 'object' && result.metrics) {
    completeness = result.completeness ?? null
    summaries = Array.isArray(result.metrics) ? result.metrics : Object.values(result.metrics)
  } else if (result && typeof result === 'object' && typeof result.arm === 'string') {
    summaries = [result]
  }
  summaries = summaries
    .filter((summary) => summary && typeof summary === 'object' && typeof summary.arm === 'string')
    .sort((a, b) => (a.arm < b.arm ? -1 : a.arm > b.arm ? 1 : 0))
  if (summaries.length === 0) return 'stats: no rows'

  const headers = [
    'arm',
    'tasks',
    'runs',
    'attempts',
    'success',
    'first',
    'att/success',
    'cost/solved',
    'tok/success',
    'p50ms',
    'p95ms',
    'failed',
  ]
  const tableRows = summaries.map((summary) => [
    summary.arm,
    formatInteger(summary.tasks),
    formatInteger(summary.runs),
    formatInteger(summary.attempts),
    formatPercent(summary.successRate),
    formatPercent(summary.firstAttemptSuccessRate),
    formatNumber(summary.attemptsToSuccessMean, 2),
    formatCost(summary.costPerSolved),
    formatInteger(summary.tokensPerSuccess),
    formatInteger(summary.durationP50Ms),
    formatInteger(summary.durationP95Ms),
    formatInteger(summary.failedTasks),
  ])
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...tableRows.map((row) => row[column].length)),
  )
  const renderRow = (row) =>
    row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ')
  const lines = [renderRow(headers), renderRow(widths.map((width) => '-'.repeat(width)))]
  for (const row of tableRows) lines.push(renderRow(row))

  if (completeness && typeof completeness === 'object') {
    if (completeness.ok) {
      lines.push('completeness: ok')
    } else {
      const problems = Array.isArray(completeness.problems) ? completeness.problems : []
      lines.push(`completeness: ${problems.length} problem(s)`)
      const shown = problems.slice(0, 25)
      for (const problem of shown) lines.push(`  - ${problem}`)
      if (problems.length > shown.length) lines.push(`  ... and ${problems.length - shown.length} more`)
    }
  }
  return lines.join('\n')
}
