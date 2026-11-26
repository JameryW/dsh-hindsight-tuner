#!/usr/bin/env node
/**
 * CLI for the reproducible A/B evaluation harness.
 *
 * Responsibilities: parse flags, validate tasks/arms, resolve the Hindsight
 * bank, freeze/verify the bank fingerprint, create per-run git worktrees,
 * spawn the agent with the prompt on stdin, run the executable check, and
 * write the JSON + text report.
 *
 * Exit codes: 0 for a completed experiment (regardless of task outcomes) and
 * for --dry-run/--help; 1 only for harness errors (bad config, git missing,
 * bank unreachable during fingerprint verification, report write failure...).
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, tunerState } from '../lib/config-file.js'
import { ENV_KEYS } from '../lib/diagnostics.js'
import {
  DEFAULT_ARMS,
  evaluate,
  formatReport,
  parsePrimary,
  summarize as summarizeCompat,
  writeReport,
} from './harness.mjs'
import { armUsesMemory, auditTaskLeakage } from './leak.mjs'
import * as stats from './stats.mjs'
import {
  assertFrozen,
  captureFingerprint,
  probeCapabilities,
  readFingerprint,
  resolveBank,
  uniqueBankId,
  writeFingerprint,
} from './bank.mjs'
import {
  createWorktree,
  disposeWorktree,
  repoRootOf,
  resetWorktree,
  verifyWorktree,
} from './worktree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_AGENT = Object.freeze(['claude', '-p', '--output-format', 'json'])
const DEFAULT_REPEATS = 1
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_ATTEMPTS = 3
const DEFAULT_BOOTSTRAPS = 4000
const DEFAULT_SEED = 20260101
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const EXAMPLE_ARMS_FILE = resolve(HERE, 'arms.example.json')
const ENV_TO_CONFIG_KEY = Object.fromEntries(
  Object.entries(ENV_KEYS).map(([configKey, envName]) => [envName, configKey]),
)

function hashFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (error) {
    return error && error.code === 'ENOENT' ? null : 'unreadable'
  }
}

/** The plugin version is part of the evidence fingerprint, not process state. */
export function readPluginVersion() {
  const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'))
  return { name: pkg.name, version: pkg.version }
}

/**
 * Pin the pieces of host state an experiment must not silently move during a
 * run: the tuner's shared config file (autoTune may rewrite it), its state
 * file, the plugin version and the resolved settings it starts from. A
 * fingerprint of the config makes "the agent's config changed under the
 * experiment" a harness error instead of an unexplained performance shift.
 *
 * @param {{file?: string, stateFile?: string}} [options] injection points for tests
 * @returns {{plugin: object, file: string, configHash: string|null,
 *   stateFile: string, stateHash: string|null, autoTune: *, applied: string[],
 *   pinnedAt: string}}
 */
export function pinExperimentConfig(options = {}) {
  const state = tunerState()
  const file = resolve(options.file ?? configPath())
  const stateFile = resolve(options.stateFile ?? state.path)
  return {
    plugin: readPluginVersion(),
    file,
    configHash: hashFile(file),
    stateFile,
    stateHash: hashFile(stateFile),
    autoTune: state.autoTune,
    applied: state.applied,
    pinnedAt: new Date().toISOString(),
  }
}

/**
 * @param {object} pin result of `pinExperimentConfig`
 * @returns {{ok: boolean, problems: string[], configChanged: boolean,
 *   stateChanged: boolean}}
 */
export function verifyPinnedConfig(pin) {
  const configHash = hashFile(pin.file)
  const stateHash = hashFile(pin.stateFile)
  const configChanged = configHash !== pin.configHash
  const stateChanged = stateHash !== pin.stateHash
  const problems = []
  if (configChanged) {
    problems.push(
      `tuner config ${pin.file} changed during the experiment (${pin.configHash ?? 'absent'} -> ${configHash ?? 'absent'}); autoTune must not mutate the experiment config`,
    )
  }
  return { ok: problems.length === 0, problems, configChanged, stateChanged }
}

export const USAGE = `Usage: node eval/ab.mjs --tasks <file> [options]

Required:
  --tasks <file>              JSON task list ({tasks:[...]} or [...])

Leak prevention (checked before any run, including --dry-run):
  With a memory arm, every task must declare "asOf": the ISO instant when its
  history was frozen. A task whose "baseSha" was committed after its "asOf", or
  whose "exclude" list names that commit, is refused. Tasks in the "screening"
  and "confirmation" sets must not reuse the same checkout and prompt.

Experiment:
  --arms <csv|file>           Arms: comma-separated names from eval/arms.example.json,
                              a JSON arms file, or an inline JSON array (default arms: A0,A2,A3)
  --allow-unmet-requires      Run arms whose declared "requires" setup is not verified
                              (default: refuse so a gated arm cannot run silently unconfigured)
  --repeats N                 Repetitions per (arm, task) (default ${DEFAULT_REPEATS})
  --attempts N                Max attempts per run when a task fails (default ${DEFAULT_ATTEMPTS})
  --primary A:B               Preregistered comparison: A is treatment, B is baseline
  --seed N                    Bootstrap seed (default ${DEFAULT_SEED})
  --bootstraps N              Bootstrap resamples (default ${DEFAULT_BOOTSTRAPS})
  --prices <file>             USD per-million-token prices JSON
  --midr-threshold <rate>     MIDR gate ceiling for memory arms (0..1, default 0.05)
  --timeout ms                Per agent/check process timeout (default ${DEFAULT_TIMEOUT_MS})
  --agent-command "<cmd>"     Agent command; JSON array for args with spaces
                              (default: ${DEFAULT_AGENT.join(' ')})

Isolation:
  --no-isolate                Do not create git worktrees; run in task.cwd
  --worktree-root <dir>       Parent directory for worktrees (default: os.tmpdir())
  --keep-worktrees            Keep worktrees after the experiment
  --reset-between-attempts    git reset --hard <baseSha> && git clean -fdx before attempts 2..N
  --no-reset-between-attempts Disable the reset (default)

Bank reproducibility:
  --bank <id>                 Hindsight bank id (env HINDSIGHT_BANK_ID)
  --fresh-bank                Generate a timestamped unique bank id instead of reusing the
                              resolved default id (#6444: a crash-retried setup must not
                              delete a newly created bank)
  --api-url <url>             Hindsight API base URL (env HINDSIGHT_API_URL)
  --api-token <token>         Bearer token (env HINDSIGHT_API_TOKEN)
  --probe-capabilities        Probe separated Embedding and Operation Validator support
  --fingerprint-out <file>    Capture the bank fingerprint before running and write it
  --verify-fingerprint <file> Verify a frozen fingerprint before running (abort on drift)

Output:
  --report <file>             Write the JSON report
  --json                      Print the JSON report instead of text
  --dry-run                   Print the plan and exit 0 without spawning agents
  -h, --help                  Show this help
`

const BOOLEAN_FLAGS = new Set([
  '--dry-run',
  '--json',
  '--keep-worktrees',
  '--reset-between-attempts',
  '--no-reset-between-attempts',
  '--no-isolate',
  '--allow-unmet-requires',
  '--fresh-bank',
  '--probe-capabilities',
  '--help',
  '-h',
])
const VALUE_FLAGS = new Set([
  '--tasks',
  '--report',
  '--repeats',
  '--timeout',
  '--arms',
  '--agent-command',
  '--attempts',
  '--worktree-root',
  '--bank',
  '--api-url',
  '--api-token',
  '--fingerprint-out',
  '--verify-fingerprint',
  '--primary',
  '--bootstraps',
  '--seed',
  '--prices',
  '--midr-threshold',
])

/** Split a command string respecting quotes and escaped spaces without breaking Windows paths. */
export function splitCommand(raw) {
  const source = String(raw ?? '')
  const parts = []
  let current = ''
  let quote = null
  let hasToken = false
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' && index + 1 < source.length && ['"', '\\', '$'].includes(source[index + 1])) {
        current += source[index + 1]
        index += 1
      } else {
        current += ch
      }
      continue
    }
    if (ch === '\'' || ch === '"') {
      quote = ch
      hasToken = true
    } else if (ch === '\\' && index + 1 < source.length && /[\s'"\\]/.test(source[index + 1])) {
      current += source[index + 1]
      hasToken = true
      index += 1
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        parts.push(current)
        current = ''
        hasToken = false
      }
    } else {
      current += ch
      hasToken = true
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command: ${source}`)
  if (hasToken) parts.push(current)
  return parts
}

function parseInteger(value, flag, { min = 0 } = {}) {
  const text = String(value).trim()
  if (!/^[+-]?\d+$/.test(text)) {
    throw new Error(`${flag} requires an integer (got ${JSON.stringify(value)})`)
  }
  const number = Number(text)
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${flag} requires a safe integer (got ${JSON.stringify(value)})`)
  }
  if (number < min) {
    throw new Error(`${flag} must be >= ${min} (got ${number})`)
  }
  return number
}

function parseRate(value, flag) {
  const text = String(value).trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw new Error(`${flag} requires a number between 0 and 1 (got ${JSON.stringify(value)})`)
  }
  const number = Number(text)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${flag} must be between 0 and 1 (got ${number})`)
  }
  return number
}

function parseAgentCommand(value) {
  const text = String(value).trim()
  if (!text) throw new Error('--agent-command requires a command')
  if (text.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`--agent-command JSON must be an array of strings: ${error.message}`)
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('--agent-command JSON must be a non-empty array of strings')
    }
    if (parsed.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error('--agent-command JSON must contain only non-empty strings')
    }
    return parsed
  }
  const parts = splitCommand(text)
  if (parts.length === 0 || !parts[0]) throw new Error('--agent-command requires a command')
  return parts
}

function defaultOptions() {
  return {
    help: false,
    tasks: null,
    report: null,
    repeats: DEFAULT_REPEATS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
    arms: null,
    agent: [...DEFAULT_AGENT],
    agentRaw: DEFAULT_AGENT.join(' '),
    attempts: DEFAULT_ATTEMPTS,
    isolate: true,
    worktreeRoot: null,
    bank: null,
    apiUrl: null,
    apiToken: null,
    fingerprintOut: null,
    verifyFingerprint: null,
    freshBank: false,
    probeCapabilities: false,
    midrThreshold: 0.05,
    primary: null,
    bootstraps: DEFAULT_BOOTSTRAPS,
    seed: DEFAULT_SEED,
    prices: null,
    json: false,
    keepWorktrees: false,
    resetBetweenAttempts: false,
    allowUnmetRequires: false,
  }
}

/**
 * True when a token is a flag this parser knows. Used to tell a missing value
 * (`--report --dry-run`) from a legitimate value that happens to start with
 * `--` (`--report --odd.json`).
 */
function isKnownFlag(value) {
  const text = String(value)
  const equalsIndex = text.indexOf('=')
  const name = equalsIndex > 0 ? text.slice(0, equalsIndex) : text
  return BOOLEAN_FLAGS.has(name) || VALUE_FLAGS.has(name)
}

/** Parse CLI argv (without `node eval/ab.mjs`). Throws on invalid usage. */
export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('parseArgs requires an array of arguments')
  const options = defaultOptions()
  let index = 0
  while (index < argv.length) {
    const token = String(argv[index])
    if (BOOLEAN_FLAGS.has(token)) {
      switch (token) {
        case '--dry-run':
          options.dryRun = true
          break
        case '--json':
          options.json = true
          break
        case '--keep-worktrees':
          options.keepWorktrees = true
          break
        case '--reset-between-attempts':
          options.resetBetweenAttempts = true
          break
        case '--no-reset-between-attempts':
          options.resetBetweenAttempts = false
          break
        case '--no-isolate':
          options.isolate = false
          break
        case '--allow-unmet-requires':
          options.allowUnmetRequires = true
          break
        case '--fresh-bank':
          options.freshBank = true
          break
        case '--probe-capabilities':
          options.probeCapabilities = true
          break
        default:
          options.help = true
          break
      }
      index += 1
      continue
    }
    const equalsIndex = token.startsWith('--') ? token.indexOf('=') : -1
    const flag = equalsIndex > 0 ? token.slice(0, equalsIndex) : token
    if (VALUE_FLAGS.has(flag)) {
      let value
      if (equalsIndex > 0) {
        value = token.slice(equalsIndex + 1)
        // `--flag=` is an ambiguous empty value; an empty string is never a
        // useful path/count, and silently accepting it hides a shell mistake.
        if (!value) throw new Error(`${flag} requires a value`)
        index += 1
      } else {
        value = argv[index + 1]
        // Only undefined or a known flag means the value is missing: a path can
        // legitimately start with `--` (e.g. `--report --odd.json`).
        if (value === undefined || isKnownFlag(value)) {
          throw new Error(`${flag} requires a value`)
        }
        index += 2
      }
      switch (flag) {
        case '--tasks':
          options.tasks = String(value)
          break
        case '--report':
          options.report = String(value)
          break
        case '--repeats':
          options.repeats = parseInteger(value, flag, { min: 1 })
          break
        case '--timeout':
          options.timeoutMs = parseInteger(value, flag, { min: 1 })
          break
        case '--arms':
          options.arms = String(value)
          break
        case '--agent-command':
          options.agent = parseAgentCommand(value)
          options.agentRaw = String(value)
          break
        case '--attempts':
          options.attempts = parseInteger(value, flag, { min: 1 })
          break
        case '--worktree-root':
          options.worktreeRoot = String(value)
          break
        case '--bank':
          options.bank = String(value)
          break
        case '--api-url':
          options.apiUrl = String(value)
          break
        case '--api-token':
          options.apiToken = String(value)
          break
        case '--fingerprint-out':
          options.fingerprintOut = String(value)
          break
        case '--verify-fingerprint':
          options.verifyFingerprint = String(value)
          break
        case '--primary':
          options.primary = parsePrimary(String(value))
          break
        case '--bootstraps':
          options.bootstraps = parseInteger(value, flag, { min: 1 })
          break
        case '--seed':
          options.seed = parseInteger(value, flag, { min: Number.MIN_SAFE_INTEGER })
          break
        case '--prices':
          options.prices = String(value)
          break
        case '--midr-threshold':
          options.midrThreshold = parseRate(value, flag)
          break
        default:
          throw new Error(`unknown argument: ${token}`)
      }
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  if (!options.help && !options.tasks) throw new Error('--tasks <file> is required')
  return options
}

function readJsonFile(file, label) {
  const target = resolve(file)
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${label} ${target}: ${error && error.message ? error.message : error}`)
  }
  try {
    return { target, value: JSON.parse(text) }
  } catch (error) {
    throw new Error(`${label} ${target} is not valid JSON: ${error && error.message ? error.message : error}`)
  }
}

/** Normalize string, array, or object check commands using quote-aware parsing. */
export function normalizeCheck(check, label = 'task') {
  if (typeof check === 'string') {
    const parts = splitCommand(check.trim())
    if (parts.length === 0 || !parts[0]) throw new Error(`${label}.check must not be empty`)
    return { command: parts[0], args: parts.slice(1) }
  }
  if (Array.isArray(check)) {
    if (check.length === 0 || check.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error(`${label}.check array must contain non-empty strings`)
    }
    return { command: check[0], args: check.slice(1) }
  }
  if (check && typeof check === 'object') {
    if (typeof check.command !== 'string' || !check.command.trim()) {
      throw new Error(`${label}.check.command must be a non-empty string`)
    }
    const args = check.args ?? []
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${label}.check.args must be an array of strings`)
    }
    return { command: check.command, args }
  }
  throw new Error(`${label}.check must be a command string, an array, or {command, args}`)
}

function validateEnvObject(env, label) {
  if (env === null || env === undefined) return undefined
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`${label}.env must be an object`)
  }
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.includes('=') || key.includes('\0')) {
      throw new Error(`${label}.env has an invalid variable name ${JSON.stringify(key)}`)
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`${label}.env.${key} must be a string, number or boolean`)
    }
    result[key] = value
  }
  return result
}

/** Read and validate a task file. Returns the task array. */
export function readTasks(file) {
  const { target, value: parsed } = readJsonFile(file, 'task file')
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null
  if (!list) throw new Error(`task file ${target} must be an array or an object with a "tasks" array`)
  if (list.length === 0) throw new Error(`task file ${target} contains no tasks`)
  const ids = new Set()
  return list.map((raw, index) => {
    const label = `tasks[${index}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${target}: ${label} must be an object`)
    }
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new Error(`${target}: ${label}.id must be a non-empty string`)
    }
    const id = raw.id.trim()
    if (ids.has(id)) throw new Error(`${target}: duplicate task id ${JSON.stringify(id)}`)
    ids.add(id)
    if (typeof raw.prompt !== 'string' || !raw.prompt) {
      throw new Error(`${target}: task ${JSON.stringify(id)} needs a non-empty prompt`)
    }
    if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) {
      throw new Error(`${target}: task ${JSON.stringify(id)} needs a non-empty cwd`)
    }
    if (raw.check === undefined || raw.check === null) {
      throw new Error(`${target}: task ${JSON.stringify(id)} needs a check command`)
    }
    const check = normalizeCheck(raw.check, `task ${JSON.stringify(id)}`)
    const env = validateEnvObject(raw.env, `task ${JSON.stringify(id)}`)
    let maxAttempts
    if (raw.maxAttempts !== undefined && raw.maxAttempts !== null) {
      if (!Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 1) {
        throw new Error(`${target}: task ${JSON.stringify(id)} maxAttempts must be an integer >= 1`)
      }
      maxAttempts = raw.maxAttempts
    }
    let checkCwd
    if (raw.checkCwd !== undefined && raw.checkCwd !== null) {
      if (typeof raw.checkCwd !== 'string' || !raw.checkCwd.trim()) {
        throw new Error(`${target}: task ${JSON.stringify(id)} checkCwd must be a non-empty string`)
      }
      checkCwd = raw.checkCwd
    }
    return {
      ...raw,
      id,
      cwd: raw.cwd,
      check,
      ...(env ? { env } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(checkCwd !== undefined ? { checkCwd } : {}),
    }
  })
}

function validateArms(arms, label) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error(`${label} must contain a non-empty arms array`)
  }
  const names = new Set()
  return arms.map((raw, index) => {
    const itemLabel = `${label} arms[${index}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${itemLabel} must be an object`)
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error(`${itemLabel}.name must be a non-empty string`)
    }
    const name = raw.name.trim()
    if (names.has(name)) throw new Error(`${label}: duplicate arm name ${JSON.stringify(name)}`)
    names.add(name)
    return {
      ...raw,
      name,
      env: validateEnvObject(raw.env, itemLabel) ?? {},
    }
  })
}

let exampleArmsCache = null

function exampleArms() {
  if (exampleArmsCache) return exampleArmsCache
  const { value } = readJsonFile(EXAMPLE_ARMS_FILE, 'example arms file')
  const arms = Array.isArray(value) ? value : value && Array.isArray(value.arms) ? value.arms : null
  if (!arms) {
    throw new Error(`${EXAMPLE_ARMS_FILE} must contain an "arms" array`)
  }
  exampleArmsCache = validateArms(arms, EXAMPLE_ARMS_FILE)
  return exampleArmsCache
}

/**
 * Resolve --arms: null => default arms, CSV names => eval/arms.example.json,
 * a path => JSON arms file, inline JSON array => parsed directly.
 * Returns {arms, source}.
 */
export function resolveArms(spec) {
  if (spec === null || spec === undefined) {
    return { arms: DEFAULT_ARMS.map((arm) => ({ ...arm })), source: { kind: 'default' } }
  }
  const text = String(spec).trim()
  // An explicitly empty value (`--arms ""`, or whitespace) must not silently run
  // the default matrix: report the mistake instead of measuring other arms.
  if (!text) throw new Error('--arms requires a non-empty value')
  if (text.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`--arms inline JSON must be an array: ${error.message}`)
    }
    return { arms: validateArms(parsed, '--arms inline JSON'), source: { kind: 'inline' } }
  }
  const looksLikePath = /[\\/]/.test(text) || /\.json$/i.test(text)
  const candidate = resolve(text)
  if (existsSync(candidate)) {
    const { value } = readJsonFile(candidate, 'arms file')
    const arms = Array.isArray(value) ? value : value && Array.isArray(value.arms) ? value.arms : null
    if (!arms) throw new Error(`arms file ${candidate} must contain an "arms" array`)
    return { arms: validateArms(arms, candidate), source: { kind: 'file', path: candidate } }
  }
  if (looksLikePath) {
    throw new Error(`arms file ${candidate} does not exist`)
  }
  const matrix = exampleArms()
  const names = text.split(',').map((name) => name.trim()).filter(Boolean)
  if (names.length === 0) throw new Error('--arms CSV contains no arm names')
  const byName = new Map(matrix.map((arm) => [arm.name, arm]))
  const selected = names.map((name) => {
    const arm = byName.get(name)
    if (!arm) {
      throw new Error(
        `unknown arm ${JSON.stringify(name)} in --arms CSV; available in ${EXAMPLE_ARMS_FILE}: ` +
          matrix.map((entry) => entry.name).join(', '),
      )
    }
    return { ...arm, env: { ...arm.env } }
  })
  const unique = new Set(selected.map((arm) => arm.name))
  if (unique.size !== selected.length) throw new Error('--arms CSV contains duplicate arm names')
  return { arms: selected, source: { kind: 'csv', path: EXAMPLE_ARMS_FILE, names } }
}

/** Read a price file: {inputPerMTok,...} or {prices:{...}}. */
export function readPrices(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('--prices requires a file path')
  const { target, value } = readJsonFile(file, 'price file')
  const raw = value && typeof value === 'object' && value.prices && typeof value.prices === 'object' ? value.prices : value
  try {
    return stats.normalizePrices(raw)
  } catch (error) {
    throw new Error(`price file ${target} is invalid: ${error.message}`)
  }
}

function detectRepo(tasks) {
  for (const task of tasks) {
    const repo = repoRootOf(task.cwd)
    if (repo) return { repo, taskId: task.id, source: 'task' }
  }
  const cwdRepo = repoRootOf(process.cwd())
  return { repo: cwdRepo || process.cwd(), taskId: null, source: cwdRepo ? 'cwd' : 'cwd-nonrepo' }
}

function isOutsidePath(relPath) {
  return relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)
}

/**
 * Path of `dir` inside `repoRoot` ('' for the repository root), or null when it
 * is outside. Git can report the canonical toplevel while the caller typed a
 * different spelling (symlinked cwd, Windows 8.3 short name), so an apparent
 * escape is retried on real paths before it is rejected.
 */
function relativeToRepo(repoRoot, dir) {
  let relPath = relative(repoRoot, dir)
  if (!isOutsidePath(relPath)) return relPath
  try {
    relPath = relative(realpathSync.native(repoRoot), realpathSync.native(dir))
  } catch {
    return null
  }
  return isOutsidePath(relPath) ? null : relPath
}

function buildEnvForRun(task, arm, attempt, previousAttempt = null) {
  const env = { ...process.env }
  let retainDeclared = false
  for (const source of [task.env, arm.env]) {
    if (!source) continue
    if (Object.prototype.hasOwnProperty.call(source, 'HINDSIGHT_RETAIN_SESSIONS')) retainDeclared = true
    for (const [key, value] of Object.entries(source)) env[key] = String(value)
  }
  env.HINDSIGHT_HARNESS = 'eval'
  env.HINDSIGHT_ARM = arm.name
  env.HINDSIGHT_ATTEMPT = String(attempt)
  if (attempt > 1 && previousAttempt) {
    if (previousAttempt.failureSignature) {
      env.HINDSIGHT_EVAL_PREV_SIGNATURE = String(previousAttempt.failureSignature)
    }
    const rawDetail = [previousAttempt.error, previousAttempt.note].filter(Boolean).join('\n').trim()
    if (rawDetail) env.HINDSIGHT_EVAL_PREV_FAILURE = rawDetail.slice(0, 4000)
  } else {
    delete env.HINDSIGHT_EVAL_PREV_SIGNATURE
    delete env.HINDSIGHT_EVAL_PREV_FAILURE
  }
  // A/B arms must see a frozen bank: background consolidation between arms would
  // silently change the treatment. Arms that genuinely need retain can opt back
  // in through task.env/arm.env, which is recorded in the arm definition.
  if (!retainDeclared) env.HINDSIGHT_RETAIN_SESSIONS = 'false'
  return env
}

function clipTail(text, limit = 2000) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return null
  return value.length > limit ? `...${value.slice(-limit)}` : value
}

function killTree(child) {
  if (!child || child.pid === undefined || child.pid === null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // Best effort: the process may already be gone.
  }
}

/**
 * Capture the newest MAX_CAPTURE_BYTES bytes of one stream.
 *
 * The old cap compared a decoded string's `.length`, which counts UTF-16 code
 * units: multi-byte output (agent transcripts are not ASCII) could exceed the
 * byte budget by 2-3x. Raw chunks are capped by byte length and decoded once,
 * after the process finished.
 */
function byteTail() {
  const chunks = []
  let bytes = 0
  const push = (chunk) => {
    chunks.push(chunk)
    bytes += chunk.length
    while (bytes > MAX_CAPTURE_BYTES) {
      const overflow = bytes - MAX_CAPTURE_BYTES
      const head = chunks[0]
      if (head.length <= overflow) {
        chunks.shift()
        bytes -= head.length
      } else {
        chunks[0] = head.subarray(overflow)
        bytes -= overflow
      }
    }
  }
  const toString = () => (chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '')
  return { push, toString }
}

function spawnErrorMessage(error, command) {
  if (error && error.code === 'ENOENT') return `command not found: ${command}`
  return error && error.message ? error.message : String(error)
}

/**
 * Whether Windows can resolve `command` at all. Node's spawn only appends
 * `.exe` (CreateProcess), so a `.cmd` shim such as the default `claude`
 * launcher looks missing; `where.exe` searches PATHEXT, which tells a shim
 * apart from a genuinely absent command. Only consulted after an ENOENT.
 */
function resolvesOnWindows(command) {
  try {
    const result = spawnSync('where.exe', [command], { stdio: 'ignore', windowsHide: true })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Spawn one process with prompt on stdin, capture capped stdout/stderr, and
 * settle exactly once on close/error/timeout. Never rejects.
 *
 * On Windows a bare command such as the `claude` default is often a `.cmd` shim,
 * which CreateProcess cannot start: the first spawn fails with ENOENT and one
 * retry through the command shell is what makes the default agent work. A
 * command that `where.exe` cannot find is not retried, so it still reports
 * `command not found` instead of a confusing shell exit code.
 */
function runProcess(command, args, { cwd, env, stdin = null, timeoutMs } = {}) {
  return new Promise((resolveProcess) => {
    const startedAt = Date.now()
    const stdoutCapture = byteTail()
    const stderrCapture = byteTail()
    let settled = false
    let timedOut = false
    let timeoutHandle = null
    let child = null
    let retriedThroughShell = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const durationMs = Date.now() - startedAt
      resolveProcess({
        command,
        args,
        stdout: stdoutCapture.toString(),
        stderr: stderrCapture.toString(),
        durationMs,
        timedOut,
        ...result,
      })
    }
    const start = (shell) => {
      let current
      try {
        current = spawn(command, args, {
          cwd,
          env,
          shell,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        finish({ error: spawnErrorMessage(error, command), exitCode: null, signal: null })
        return
      }
      child = current
      current.stdout.on('data', (chunk) => stdoutCapture.push(chunk))
      current.stderr.on('data', (chunk) => stderrCapture.push(chunk))
      current.on('error', (error) => {
        // A stale failed spawn must not settle the run once a retry is active.
        if (current !== child) return
        if (process.platform === 'win32' && !retriedThroughShell && error && error.code === 'ENOENT') {
          retriedThroughShell = true
          if (resolvesOnWindows(command)) {
            start(true)
            return
          }
        }
        finish({ error: spawnErrorMessage(error, command), exitCode: null, signal: null })
      })
      current.on('close', (code, signal) => {
        if (current !== child) return
        finish({ error: null, exitCode: code, signal })
      })
      current.stdin.on('error', () => {
        // EPIPE: the agent exited without reading stdin. The exit code decides.
      })
      if (timeoutHandle) clearTimeout(timeoutHandle)
      timeoutHandle = setTimeout(() => {
        timedOut = true
        killTree(current)
      }, timeoutMs)
      if (stdin === null || stdin === undefined) current.stdin.end()
      else current.stdin.end(stdin)
    }
    start(false)
  })
}

function tokenNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function usageFromObject(parsed) {
  const candidates = [
    parsed && parsed.usage,
    parsed && parsed.result && parsed.result.usage,
    parsed && parsed.message && parsed.message.usage,
    parsed && parsed.stats && parsed.stats.usage,
  ]
  for (const usage of candidates) {
    if (!usage || typeof usage !== 'object') continue
    const input = tokenNumber(usage.input_tokens)
    const output = tokenNumber(usage.output_tokens)
    const cacheRead = tokenNumber(usage.cache_read_input_tokens)
    const cacheWrite = tokenNumber(usage.cache_creation_input_tokens)
    const total = tokenNumber(usage.total_tokens)
    if (input === null && output === null && cacheRead === null && cacheWrite === null && total === null) {
      continue
    }
    const normalized = {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
    }
    let tokens = total
    if (tokens === null) tokens = (input ?? 0) + (output ?? 0)
    const usageTotal = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite
    if ((tokens === null || tokens === 0) && usageTotal > 0) tokens = usageTotal
    return { usage: normalized, tokens }
  }
  for (const key of ['total_tokens', 'tokens']) {
    const total = tokenNumber(parsed && parsed[key])
    if (total !== null) return { usage: null, tokens: total }
  }
  return null
}

/** Parse usage from the last JSON line (or a multi-line JSON object) on stdout; returns {usage, tokens}. */
export function parseUsage(stdout) {
  const text = typeof stdout === 'string' ? stdout : ''
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const found = usageFromObject(parsed)
    if (found) return found
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const found = usageFromObject(parsed)
      if (found) return found
    } catch {
      // Output is not valid JSON.
    }
  }
  return { usage: null, tokens: null }
}

function stripOverriddenKeys(section, keys) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return
  for (const key of keys) delete section[key]
}

function prepareIsolatedConfigKeys(baseEnv, overrideEnv) {
  const overriddenKeys = new Set()
  for (const [envName, value] of Object.entries(overrideEnv ?? {})) {
    if (value === undefined) continue
    const configKey = ENV_TO_CONFIG_KEY[envName]
    if (configKey) overriddenKeys.add(configKey)
  }
  if (overriddenKeys.size === 0) return { env: {}, dir: null }
  const sourceFile = baseEnv.HINDSIGHT_CONFIG || configPath()
  if (!existsSync(sourceFile)) return { env: {}, dir: null }
  let parsed
  try {
    const raw = JSON.parse(readFileSync(sourceFile, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { env: {}, dir: null }
    parsed = raw
  } catch {
    return { env: {}, dir: null }
  }
  stripOverriddenKeys(parsed, overriddenKeys)
  for (const container of ['harnesses', 'paths', 'banks']) {
    const map = parsed[container]
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const section of Object.values(map)) {
      stripOverriddenKeys(section, overriddenKeys)
      if (container === 'harnesses' && section && typeof section === 'object' && !Array.isArray(section)) {
        for (const nested of ['paths', 'banks']) {
          const sub = section[nested]
          if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue
          for (const subSection of Object.values(sub)) stripOverriddenKeys(subSection, overriddenKeys)
        }
      }
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'tuner-ab-cfg-'))
  const target = join(dir, 'hindsight-config.json')
  writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { env: { HINDSIGHT_CONFIG: target }, dir }
}

/** Create the per-run agent + check runner, isolating HINDSIGHT_CONFIG keys overridden by arm/task env. */
export function createRunner(options) {
  return async function runTask({ task, arm, attempt, previousAttempts, worktree }) {
    // A task may point at a subdirectory of its repository; the worktree is a
    // fresh checkout of the whole repo, so run relative to the recorded offset
    // instead of dropping the subdirectory.
    const cwd = worktree ? join(worktree.path, worktree.rel ?? '') : resolve(task.cwd)
    if (options.resetBetweenAttempts && attempt > 1 && worktree) {
      resetWorktree(worktree)
    }
    const previousAttempt = Array.isArray(previousAttempts) && previousAttempts.length > 0
      ? previousAttempts[previousAttempts.length - 1]
      : null
    const baseEnv = buildEnvForRun(task, arm, attempt, previousAttempt)
    const armSetsConfig = arm?.env && Object.prototype.hasOwnProperty.call(arm.env, 'HINDSIGHT_CONFIG')
    const effectiveOverrides = {
      HINDSIGHT_HARNESS: baseEnv.HINDSIGHT_HARNESS,
      HINDSIGHT_RETAIN_SESSIONS: baseEnv.HINDSIGHT_RETAIN_SESSIONS,
      ...task.env,
      ...arm.env,
    }
    const isolated = armSetsConfig
      ? { env: {}, dir: null }
      : prepareIsolatedConfigKeys(baseEnv, effectiveOverrides)
    const env = { ...baseEnv, ...isolated.env }
    try {
      const agentResult = await runProcess(options.agent[0], options.agent.slice(1), {
        cwd,
        env,
        stdin: task.prompt,
        timeoutMs: options.timeoutMs,
      })
      const usage = parseUsage(agentResult.stdout)
      const base = {
        tokens: usage.tokens,
        usage: usage.usage,
        durationMs: agentResult.durationMs,
      }
      if (agentResult.timedOut) {
        return {
          ...base,
          passed: false,
          failureSignature: 'timeout',
          error: `agent timed out after ${options.timeoutMs}ms`,
          note: clipTail(agentResult.stderr) || clipTail(agentResult.stdout),
        }
      }
      if (agentResult.error) {
        return {
          ...base,
          passed: false,
          failureSignature: 'spawn-error',
          error: agentResult.error,
          note: clipTail(agentResult.stderr),
        }
      }
      if (agentResult.exitCode !== 0) {
        const code = agentResult.exitCode === null ? agentResult.signal : agentResult.exitCode
        return {
          ...base,
          passed: false,
          failureSignature: `agent-exit-${code}`,
          error: `agent exited with ${code}`,
          note: clipTail(agentResult.stderr) || clipTail(agentResult.stdout),
        }
      }

      const check = task.check
      if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.command !== 'string') {
        throw new Error(`task ${task.id} has an unnormalized check command`)
      }
      const checkCwd = task.checkCwd ? resolve(cwd, task.checkCwd) : cwd
      const checkResult = await runProcess(check.command, check.args ?? [], {
        cwd: checkCwd,
        env,
        stdin: null,
        timeoutMs: options.timeoutMs,
      })
      const durationMs = agentResult.durationMs + checkResult.durationMs
      if (checkResult.timedOut || checkResult.error || checkResult.exitCode !== 0) {
        let failureSignature
        let error
        if (checkResult.timedOut) {
          failureSignature = 'check-timeout'
          error = `check timed out after ${options.timeoutMs}ms`
        } else if (checkResult.error) {
          failureSignature = 'check-spawn-error'
          error = checkResult.error
        } else {
          failureSignature = `check-exit-${checkResult.exitCode}`
          error = `check failed with exit code ${checkResult.exitCode}`
        }
        return {
          ...base,
          durationMs,
          passed: false,
          failureSignature,
          error,
          note: clipTail(checkResult.stderr) || clipTail(checkResult.stdout),
        }
      }
      return { ...base, durationMs, passed: true }
    } finally {
      if (isolated.dir) {
        try {
          rmSync(isolated.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        } catch {
          // Best-effort scratch config cleanup.
        }
      }
    }
  }
}

function createWorktreeHooks(options, state) {
  const root = options.worktreeRoot ? resolve(options.worktreeRoot) : undefined
  return {
    async prepareRun({ task, arm, repeat }) {
      if (!options.isolate) return { worktree: null, isolated: false, repo: null }
      let repo
      try {
        repo = repoRootOf(task.cwd)
      } catch (error) {
        throw new Error(`task ${task.id}: cannot inspect git repository at ${task.cwd}: ${error.message}`)
      }
      if (!repo) return { worktree: null, isolated: false, repo: null }
      const rel = relativeToRepo(repo, resolve(task.cwd))
      if (rel === null) {
        throw new Error(
          `task ${task.id}: cwd ${resolve(task.cwd)} is outside the detected git repository ${repo}`,
        )
      }
      const handle = createWorktree({
        repo,
        root,
        name: `${task.id}-${arm.name}-r${repeat + 1}`,
      })
      // Carry the task's offset inside the repo so the runner can start in the
      // matching subdirectory of the worktree rather than its root.
      handle.rel = rel
      try {
        verifyWorktree(handle)
      } catch (error) {
        try {
          disposeWorktree(handle)
        } catch {
          // Keep the verification error as the useful one.
        }
        throw error
      }
      state.handles.push(handle)
      state.worktrees.push({
        taskId: task.id,
        arm: arm.name,
        repeat,
        path: handle.path,
        repo: handle.repo,
        baseSha: handle.baseSha,
        rel: rel || null,
        cwd: join(handle.path, rel),
      })
      return { worktree: handle, isolated: true, repo: handle.repo }
    },
    async finishRun({ task, arm, repeat, worktree }) {
      if (!worktree) return
      if (options.keepWorktrees) return
      try {
        disposeWorktree(worktree)
      } catch (error) {
        state.cleanupErrors.push({
          taskId: task.id,
          arm: arm.name,
          repeat,
          path: worktree.path,
          message: error && error.message ? error.message : String(error),
        })
      }
    },
  }
}

async function prepareBank(options, tasks) {
  const repoInfo = detectRepo(tasks)
  const resolved = resolveBank({
    apiUrl: options.apiUrl,
    bank: options.bank,
    token: options.apiToken,
    repo: repoInfo.repo,
  })
  const info = {
    apiUrl: resolved.apiUrl,
    bankId: resolved.bank,
    tokenSource: resolved.source.token,
    repo: repoInfo.repo,
    repoSource: repoInfo.source,
    verified: false,
    freshBank: Boolean(options.freshBank),
    fingerprint: null,
    capturedAt: null,
    expectedFingerprint: null,
    fingerprintFile: null,
    capabilities: null,
  }
  if (options.verifyFingerprint) {
    const expected = readFingerprint(options.verifyFingerprint)
    info.expectedFingerprint = expected.fingerprint
    if (!options.apiUrl) info.apiUrl = expected.apiUrl ?? info.apiUrl
    if (!options.bank) info.bankId = expected.bankId ?? info.bankId
  }
  if (options.dryRun) return { info, fingerprint: null, resolved }

  let fingerprint = null
  if (options.verifyFingerprint) {
    const expected = readFingerprint(options.verifyFingerprint)
    fingerprint = await assertFrozen(expected, {
      apiUrl: options.apiUrl ?? undefined,
      bank: options.bank ?? undefined,
      token: options.apiToken ?? undefined,
    })
    info.verified = true
    info.apiUrl = fingerprint.apiUrl
    info.bankId = fingerprint.bankId
  } else if (options.fingerprintOut) {
    fingerprint = await captureFingerprint({
      apiUrl: options.apiUrl ?? undefined,
      bank: options.bank ?? undefined,
      token: options.apiToken ?? undefined,
      repo: repoInfo.repo,
    })
    info.apiUrl = fingerprint.apiUrl
    info.bankId = fingerprint.bankId
  }
  if (fingerprint) {
    info.fingerprint = fingerprint.fingerprint
    info.capturedAt = fingerprint.capturedAt
    if (options.fingerprintOut) {
      info.fingerprintFile = writeFingerprint(options.fingerprintOut, fingerprint)
    }
  }
  if (options.probeCapabilities) {
    info.capabilities = await probeCapabilities({
      apiUrl: info.apiUrl,
      token: options.apiToken ?? undefined,
    })
  }
  return { info, fingerprint, resolved }
}

function buildPlan(options, tasks, armsResult, resolved, repoInfo) {
  const worktreeRoot = options.worktreeRoot ? resolve(options.worktreeRoot) : null
  const armList = armsResult.arms
  const plannedRuns = tasks.length * armList.length * options.repeats
  let maxAgentInvocations = 0
  for (const task of tasks) {
    maxAgentInvocations += (task.maxAttempts ?? options.attempts) * armList.length * options.repeats
  }
  const taskPlans = tasks.map((task) => {
    let repo = null
    let cwdRel = null
    if (options.isolate) {
      repo = repoRootOf(task.cwd)
      if (repo) cwdRel = relativeToRepo(repo, resolve(task.cwd))
    }
    return {
      id: task.id,
      cwd: resolve(task.cwd),
      cwdExists: existsSync(task.cwd),
      cwdRel: cwdRel || null,
      maxAttempts: task.maxAttempts ?? options.attempts,
      isolated: Boolean(options.isolate && repo),
      repo,
    }
  })
  const bankPlan = {
    apiUrl: resolved.apiUrl,
    bankId: resolved.bank,
    tokenSource: resolved.source.token,
    freshBank: Boolean(options.freshBank),
    verify: options.verifyFingerprint ? resolve(options.verifyFingerprint) : null,
    fingerprintOut: options.fingerprintOut ? resolve(options.fingerprintOut) : null,
    expectedFingerprint: null,
  }
  if (options.verifyFingerprint) {
    const expected = readFingerprint(options.verifyFingerprint)
    bankPlan.expectedFingerprint = expected.fingerprint
    if (!options.apiUrl) bankPlan.apiUrl = expected.apiUrl ?? bankPlan.apiUrl
    if (!options.bank) bankPlan.bankId = expected.bankId ?? bankPlan.bankId
  }
  return {
    tasksFile: resolve(options.tasks),
    armsSource: armsResult.source,
    arms: armList.map((arm) => ({
      name: arm.name,
      label: arm.label ?? null,
      env: arm.env ?? {},
      // Arm gates are declared in the arms file; carry them into the plan so a
      // dry run shows setup that environment variables alone cannot express.
      hint: arm.hint ?? null,
      requires: Array.isArray(arm.requires) ? arm.requires : [],
    })),
    tasks: taskPlans,
    repeats: options.repeats,
    attemptsDefault: options.attempts,
    plannedRuns,
    maxAgentInvocations,
    isolation: {
      enabled: options.isolate,
      worktreeRoot,
      keepWorktrees: options.keepWorktrees,
      resetBetweenAttempts: options.resetBetweenAttempts,
    },
    bank: bankPlan,
    prices: options.prices ? resolve(options.prices) : null,
    costUnit: options.prices ? 'USD' : 'tokens (no --prices: zero prices make cost = total tokens)',
    agent: options.agent,
    timeoutMs: options.timeoutMs,
    reportFile: options.report ? resolve(options.report) : null,
    repo: repoInfo,
  }
}

function printPlan(plan, options) {
  const lines = []
  lines.push('eval dry run (no agents spawned, no bank requests)')
  lines.push(`  tasks: ${plan.tasks.length} from ${plan.tasksFile}`)
  for (const task of plan.tasks) {
    lines.push(
      `    - ${task.id}  cwd=${task.cwd}  maxAttempts=${task.maxAttempts}` +
        `  ${task.isolated ? `isolate (repo ${task.repo}${task.cwdRel ? `, subdir ${task.cwdRel}` : ''})` : 'no worktree (shared cwd)'}` +
        (task.cwdExists === false ? '  [cwd missing: runs will fail until the fixture exists]' : ''),
    )
  }
  if (plan.leakage) {
    const sets = plan.leakage.sets ?? { screening: 0, confirmation: 0 }
    lines.push(
      `  leakage: ${plan.leakage.checked ?? plan.tasks.length} task(s) checked · screening ${sets.screening} · confirmation ${sets.confirmation}` +
        (plan.leakage.ok ? '' : `  PROBLEMS: ${(plan.leakage.problems ?? []).join('; ')}`),
    )
  }
  if (plan.pin) {
    const config = plan.pin.config ?? {}
    lines.push(
      `  pin: plugin ${plan.pin.plugin?.version ?? 'unknown'} · tuner config ${config.path ?? 'n/a'}` +
        (config.sha256 ? ` sha256 ${config.sha256.slice(0, 12)}…` : ' (absent)') +
        ` · autoTune ${config.autoTune === null || config.autoTune === undefined ? 'unset (default on)' : String(config.autoTune)}`,
    )
  }
  lines.push(`  arms: ${plan.arms.length} (${plan.armsSource.kind}${plan.armsSource.path ? `: ${plan.armsSource.path}` : ''})`)
  for (const arm of plan.arms) {
    const env = Object.entries(arm.env)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    lines.push(
      `    - ${arm.name}${arm.label ? ` (${arm.label})` : ''}${env ? `  env: ${env}` : ''}` +
        (arm.hint ? `  hint: ${arm.hint}` : '') +
        (arm.requires.length > 0 ? `  requires: ${arm.requires.join('; ')}` : ''),
    )
  }
  lines.push(`  repeats: ${plan.repeats} · attempts: ${plan.attemptsDefault} default (per-task overrides shown above)`)
  lines.push(
    `  runs: ${plan.tasks.length} tasks × ${plan.arms.length} arms × ${plan.repeats} repeats = ` +
      `${plan.plannedRuns} runs · at most ${plan.maxAgentInvocations} agent invocations`,
  )
  lines.push(
    `  isolation: ${plan.isolation.enabled ? 'on' : 'off'}` +
      (plan.isolation.enabled
        ? ` · worktree root: ${plan.isolation.worktreeRoot ?? '<os.tmpdir()>/dsh-hindsight-eval-worktrees'}`
        : ' (agents run in task.cwd)') +
      (plan.isolation.keepWorktrees ? ' · worktrees kept' : '') +
      (plan.isolation.resetBetweenAttempts ? ' · reset between attempts' : ''),
  )
  lines.push(`  bank: ${plan.bank.bankId} at ${plan.bank.apiUrl} (token: ${plan.bank.tokenSource})`)
  if (plan.bank.verify) {
    lines.push(
      `  fingerprint: verify ${plan.bank.verify} (sha256 ${plan.bank.expectedFingerprint}) before running; abort on drift`,
    )
  }
  if (plan.bank.fingerprintOut) {
    lines.push(`  fingerprint: capture → ${plan.bank.fingerprintOut} before running`)
  }
  if (!plan.bank.verify && !plan.bank.fingerprintOut) {
    lines.push('  fingerprint: none (pass --fingerprint-out or --verify-fingerprint to freeze the bank)')
  }
  lines.push(`  prices: ${plan.prices ?? 'none'} · cost unit: ${plan.costUnit}`)
  lines.push(`  agent: ${plan.agent.join(' ')} · timeout ${plan.timeoutMs}ms`)
  lines.push(`  report: ${plan.reportFile ?? 'none'}${options.dryRun ? ' (not written in --dry-run)' : ''}`)
  return lines.join('\n')
}

function attachErrorCleanup(state, options, error) {
  if (options.keepWorktrees) return
  for (const handle of state.handles) {
    if (handle.disposed) continue
    try {
      disposeWorktree(handle)
    } catch {
      // The primary error is the one worth reporting.
    }
  }
  return error
}

/**
 * Run the CLI. Returns the process exit code.
 * Throws for harness errors (the caller maps that to exit 1).
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const tasks = readTasks(options.tasks)
  const armsResult = resolveArms(options.arms)
  const armNames = armsResult.arms.map((arm) => arm.name)
  const gatedArms = armsResult.arms.filter((arm) => Array.isArray(arm.requires) && arm.requires.length > 0)
  if (gatedArms.length > 0) {
    const detail = gatedArms.map((arm) => `${arm.name}: ${arm.requires.join('; ')}`).join('\n')
    if (!options.allowUnmetRequires) {
      throw new Error(
        'selected arm(s) declare setup the harness cannot verify from environment variables ' +
          '(do that setup, then pass --allow-unmet-requires):\n' +
          detail,
      )
    }
    process.stderr.write(`eval: warning: running arm(s) whose declared requires are not verified:\n${detail}\n`)
  }
  const primary = options.primary ? parsePrimary(options.primary, armNames) : null
  const repoInfo = detectRepo(tasks)
  if (options.freshBank && options.bank) {
    throw new Error('--fresh-bank cannot be combined with --bank: the generated id must not be overridden')
  }
  if (options.freshBank && options.verifyFingerprint) {
    throw new Error('--fresh-bank cannot be combined with --verify-fingerprint: a fresh bank has no frozen baseline')
  }
  if (options.freshBank) {
    const base = resolveBank({
      apiUrl: options.apiUrl,
      token: options.apiToken,
      repo: repoInfo.repo,
    })
    options.bank = uniqueBankId(base.bank)
  }
  // Leak prevention (roadmap §6): a task that will see memory must declare the
  // history cutoff, and the cutoff must not admit commits after the task began.
  // The audit runs here so --dry-run fails loudly too, instead of the first
  // agent run discovering it.
  const memoryArms = armsResult.arms.filter((arm) => armUsesMemory(arm))
  const leakage = auditTaskLeakage(tasks, { requireAsOf: memoryArms.length > 0 })
  if (!leakage.ok) {
    throw new Error(`task leakage checks failed:\n- ${leakage.problems.join('\n- ')}`)
  }
  // Pin what an experiment must not silently move: the plugin version and the
  // tuner config/state the runs start from. Re-verified after the run.
  const pin = pinExperimentConfig()

  if (options.dryRun) {
    if (options.report) {
      process.stderr.write(
        `eval: warning: --dry-run does not write the report (${resolve(options.report)}); drop --dry-run to write it\n`,
      )
    }
    const plan = buildPlan(
      options,
      tasks,
      armsResult,
      resolveBank({
        apiUrl: options.apiUrl,
        bank: options.bank,
        token: options.apiToken,
        repo: repoInfo.repo,
      }),
      repoInfo,
    )
    plan.leakage = leakage
    plan.pin = {
      plugin: pin.plugin,
      config: { path: pin.file, sha256: pin.configHash, autoTune: pin.autoTune },
    }
    if (options.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    else process.stdout.write(`${printPlan(plan, options)}\n`)
    return 0
  }

  const prices = options.prices ? readPrices(options.prices) : null
  const bank = await prepareBank(options, tasks)
  // When a fingerprint was captured or verified, re-check it before every new
  // arm and once at the end: one check before the experiment cannot notice a
  // background consolidation that changes the bank while arms are running.
  const verifyBank = bank.fingerprint
    ? async ({ arm, stage }) => {
        const label = stage === 'end' ? 'before the experiment finished' : `before arm ${arm?.name ?? '?'}`
        try {
          await assertFrozen(bank.fingerprint, {
            apiUrl: bank.info.apiUrl,
            bank: bank.info.bankId,
            token: options.apiToken ?? undefined,
          })
        } catch (error) {
          throw new Error(`bank fingerprint check failed ${label}: ${error.message}`)
        }
      }
    : undefined
  const state = { worktrees: [], handles: [], cleanupErrors: [] }
  const hooks = createWorktreeHooks(options, state)
  const startedAt = new Date().toISOString()

  let evaluation
  try {
    evaluation = await evaluate({
      tasks,
      arms: armsResult.arms,
      runTask: createRunner(options),
      repeats: options.repeats,
      primary,
      prices,
      fingerprint: bank.fingerprint,
      defaultMaxAttempts: options.attempts,
      prepareRun: hooks.prepareRun,
      finishRun: hooks.finishRun,
      verifyBank,
      requireAsOf: memoryArms.length > 0,
      onRow: options.json
        ? undefined
        : (row) => {
            const outcome = row.passed ? 'pass' : 'fail'
            const signature = row.failureSignature ? ` (${row.failureSignature})` : ''
            process.stderr.write(
              `[${row.arm} ${row.taskId} r${row.repeat} a${row.attempt}] ${outcome}${signature}\n`,
            )
          },
    })
  } catch (error) {
    throw attachErrorCleanup(state, options, error)
  }
  const finishedAt = new Date().toISOString()
  // The pinned config must still be the config the runs used: autoTune rewriting
  // it mid-experiment would silently change every later arm.
  const pinCheck = verifyPinnedConfig(pin)
  if (!pinCheck.ok) {
    throw attachErrorCleanup(state, options, new Error(`experiment config guard failed: ${pinCheck.problems.join('; ')}`))
  }

  const report = {
    ...evaluation,
    experiment: {
      startedAt,
      finishedAt,
      tasksFile: resolve(options.tasks),
      armsSource: armsResult.source,
      agent: options.agent,
      timeoutMs: options.timeoutMs,
      attemptsDefault: options.attempts,
      repeats: options.repeats,
      isolate: options.isolate,
      worktreeRoot: options.worktreeRoot ? resolve(options.worktreeRoot) : null,
      keepWorktrees: options.keepWorktrees,
      resetBetweenAttempts: options.resetBetweenAttempts,
      allowUnmetRequires: options.allowUnmetRequires,
      armRequires: gatedArms.map((arm) => ({ arm: arm.name, requires: arm.requires })),
      armHints: armsResult.arms
        .filter((arm) => typeof arm.hint === 'string' && arm.hint.trim() !== '')
        .map((arm) => ({ arm: arm.name, hint: arm.hint.trim() })),
      seed: options.seed,
      bootstraps: options.bootstraps,
      alpha: 0.05,
      midrThreshold: options.midrThreshold,
      prices: options.prices ? resolve(options.prices) : null,
      costUnit: prices ? 'USD' : 'tokens (zero prices: cost = total tokens)',
      platform: process.platform,
      node: process.version,
      cwd: process.cwd(),
      // Evidence pins: what the runs were actually executed with. The resolved
      // bank id already lives in report.bank; repeating it here keeps the
      // experiment block self-describing.
      plugin: pin.plugin,
      bankId: bank.info.bankId,
      tuner: {
        configPath: pin.file,
        configSha256: pin.configHash,
        statePath: pin.stateFile,
        autoTune: pin.autoTune,
        appliedAtStart: pin.applied,
        configUnchanged: !pinCheck.configChanged,
        stateChanged: pinCheck.stateChanged,
      },
    },
    bank: bank.info,
    worktrees: state.worktrees,
    cleanupErrors: state.cleanupErrors,
  }
  report.midr = stats.memoryGate(report.memory, { threshold: options.midrThreshold })
  report.generalization = stats.generalizationCheck(tasks, { agent: options.agent })

  let text = formatReport(report, {
    primary,
    seed: options.seed,
    bootstraps: options.bootstraps,
  })
  if (report.midr && !report.midr.passed) {
    const failed = report.midr.arms.filter((arm) => !arm.pass).map((arm) => `${arm.arm} ${(arm.midr * 100).toFixed(1)}%`)
    text += `\nMIDR gate FAILED (ceiling ${(report.midr.threshold * 100).toFixed(1)}%): ${failed.join(', ')}`
  }
  if (report.generalization.warnings.length > 0) {
    text += `\nGeneralization warnings: ${report.generalization.warnings.join('; ')}`
  }
  if (options.report) writeReport(report, options.report)
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${text}\n`)

  if (state.cleanupErrors.length > 0) {
    // A worktree that cannot be deleted is a cleanup problem, not a lost
    // experiment: the rows and the report were already written. Windows keeps a
    // directory handle open while a just-exited agent or its shell hooks are
    // still finishing, and that must not turn a completed run into exit 1.
    const first = state.cleanupErrors[0]
    process.stderr.write(
      `eval: warning: ${state.cleanupErrors.length} worktree cleanup error(s); first: ${first.path}: ${first.message}\n` +
        'eval: the report is complete; remove the leftover directories manually or pass --keep-worktrees next time.\n',
    )
  }
  return 0
}

// Re-export a few helpers so eval scripts and the selftest can share them
// without importing the CLI implementation twice.
export { DEFAULT_ARMS, stats, summarizeCompat }

function canonicalPath(value) {
  const absolute = resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false
  const self = canonicalPath(fileURLToPath(import.meta.url))
  const script = canonicalPath(process.argv[1])
  return process.platform === 'win32'
    ? self.toLowerCase() === script.toLowerCase()
    : self === script
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error)
      process.stderr.write(`eval: ${message}\n`)
      process.exitCode = 1
    })
}
