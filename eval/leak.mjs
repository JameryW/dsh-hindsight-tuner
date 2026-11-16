/**
 * Leak-prevention assertions for the A/B harness.
 *
 * The architecture roadmap (§6, "hard constraints to write as automated
 * assertions") asks every experiment to prove, before the first run, that a
 * task can only see history that existed *before* the task started:
 *
 *  - a task that runs with memory arms must declare `asOf`, the moment its
 *    history was frozen; a missing cutoff cannot exclude future commits;
 *  - `asOf` must be a real ISO instant and not in the future;
 *  - the task's starting commit (`baseSha`) must have been created at or
 *    before `asOf`, so the starting tree cannot already contain the fix;
 *  - `exclude` (the target fix commit / PR references) must not name the
 *    starting commit — a task cannot begin from the change it is meant to make;
 *  - the screening and confirmation sets must be disjoint: reusing the same
 *    repository checkout and prompt in both sets means the confirmation set
 *    was chosen by the very tasks it confirms.
 *
 * These are harness errors, not warnings: evidence that cannot show its own
 * cutoff is not evidence. `auditTaskLeakage` is exported so the CLI can run it
 * during `--dry-run` too, and `gitCommitTime` is injectable so the selftest can
 * exercise the rules without spending real repositories.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export const TASK_SETS = ['screening', 'confirmation']

/** Recursively key-free signature of the task's source material. */
export function taskSignature(task) {
  const cwd = task && typeof task.cwd === 'string' ? resolve(task.cwd) : ''
  const prompt = task && typeof task.prompt === 'string' ? task.prompt.trim() : ''
  return `${cwd}\u0000${prompt}`
}

function defaultGitCommitTime(cwd, sha) {
  try {
    return (
      execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%cI', sha], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    // Not a git checkout, unknown commit, or git unavailable: the caller
    // records that the cutoff could not be checked rather than inventing one.
    return null
  }
}

/**
 * Audit a task list for the leak-prevention constraints.
 *
 * @param {object[]} tasks normalized task definitions
 * @param {object} [options]
 * @param {number} [options.now] current epoch milliseconds (default Date.now())
 * @param {boolean} [options.requireAsOf] reject a task without `asOf`; the
 *   harness sets this whenever a memory arm is selected
 * @param {Function} [options.gitCommitTime] (cwd, sha) => ISO string | null
 * @returns {{ok: boolean, problems: string[], checked: number,
 *   sets: {screening: number, confirmation: number}}}
 */
export function auditTaskLeakage(tasks, options = {}) {
  const { now = Date.now(), requireAsOf = false, gitCommitTime = defaultGitCommitTime } = options
  const sets = { screening: 0, confirmation: 0 }
  const problems = []
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, problems: ['no tasks to audit'], checked: 0, sets }
  }

  const ids = new Set()
  const signatures = new Map()
  tasks.forEach((task, index) => {
    const label = `tasks[${index}]`
    const id = task && typeof task.id === 'string' ? task.id.trim() : ''
    if (!id) {
      problems.push(`${label} has no id`)
      return
    }
    if (ids.has(id)) problems.push(`duplicate task id ${JSON.stringify(id)}`)
    ids.add(id)

    const set = task.set
    if (set !== undefined) {
      if (!TASK_SETS.includes(set)) {
        problems.push(
          `task ${JSON.stringify(id)} declares set ${JSON.stringify(set)}; use ${TASK_SETS.map((name) => JSON.stringify(name)).join(' or ')}`,
        )
      } else {
        sets[set] += 1
      }
    }

    // The same (checkout, prompt) pair in two sets means the confirmation set
    // reuses the screening tasks, so it cannot confirm anything.
    const signature = taskSignature(task)
    const seen = signatures.get(signature)
    if (seen === undefined) {
      signatures.set(signature, { id, set })
    } else if (seen.set !== undefined && set !== undefined && seen.set !== set) {
      problems.push(
        `task ${JSON.stringify(id)} repeats task ${JSON.stringify(seen.id)} in the ${set} set; the screening and confirmation sets must be disjoint`,
      )
    }

    if (task.asOf === undefined) {
      if (requireAsOf) {
        problems.push(
          `task ${JSON.stringify(id)} has no asOf; memory arms need the history cutoff so commits after the task started cannot leak in`,
        )
      }
    } else {
      const cutoff = Date.parse(task.asOf)
      if (!Number.isFinite(cutoff)) {
        problems.push(`task ${JSON.stringify(id)} has an unparsable asOf ${JSON.stringify(task.asOf)}`)
      } else {
        if (cutoff > now) {
          problems.push(
            `task ${JSON.stringify(id)} has an asOf in the future (${task.asOf}); a history cutoff cannot exclude commits that do not exist yet`,
          )
        }
        if (typeof task.cwd === 'string' && typeof task.baseSha === 'string' && task.baseSha.trim()) {
          const committed = gitCommitTime(task.cwd, task.baseSha)
          const committedAt = committed === null ? NaN : Date.parse(committed)
          if (Number.isFinite(committedAt) && committedAt > cutoff) {
            problems.push(
              `task ${JSON.stringify(id)} starts from ${task.baseSha}, committed ${committed}, after its asOf ${task.asOf}; the starting tree may already contain the fix`,
            )
          }
        }
      }
    }

    if (task.exclude !== undefined && !Array.isArray(task.exclude)) {
      problems.push(`task ${JSON.stringify(id)} exclude must be an array of commit or PR references`)
    } else if (Array.isArray(task.exclude) && typeof task.baseSha === 'string' && task.baseSha.trim()) {
      const base = task.baseSha.trim()
      const named = task.exclude.some(
        (entry) => typeof entry === 'string' && entry.trim() !== '' && (base === entry.trim() || (entry.trim().length >= 7 && base.startsWith(entry.trim()))),
      )
      if (named) {
        problems.push(
          `task ${JSON.stringify(id)} starts from ${base}, which its exclude list names as the target fix; pick the pre-fix base commit`,
        )
      }
    }
  })

  return { ok: problems.length === 0, problems, checked: tasks.length, sets }
}

/**
 * @param {object[]} tasks
 * @param {object} [options] see `auditTaskLeakage`
 * @returns {object} the audit, when it passed
 * @throws {Error} when any leak-prevention rule is violated; `error.audit`
 *   carries the full result for reports.
 */
export function assertNoLeakage(tasks, options) {
  const audit = auditTaskLeakage(tasks, options)
  if (!audit.ok) {
    const error = new Error(`task leakage checks failed: ${audit.problems.join('; ')}`)
    error.audit = audit
    throw error
  }
  return audit
}

/** Whether an arm uses memory (the integration injects by default). */
export function armUsesMemory(arm) {
  const configured = arm && arm.env && typeof arm.env === 'object' ? arm.env.HINDSIGHT_AUTO_INJECT : undefined
  return (configured ?? 'pages') !== 'none'
}
