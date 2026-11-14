import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const BACKUPS_TO_KEEP = 3
const SECRET_KEYS = new Set(['apiToken', 'token', 'apiKey', 'password'])

/** The DSH home the harness reports, falling back to the conventional path. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** This plugin's own state directory; never inside the Hindsight config file. */
export function tunerDir() {
  return join(dshHome(), 'storages', 'dsh-hindsight-tuner')
}

/**
 * The memory config every Hindsight coding-agent harness reads. `HINDSIGHT_CONFIG`
 * is the same override the integration honours, so a custom path stays shared.
 */
export function configPath() {
  return process.env.HINDSIGHT_CONFIG || join(homedir(), '.hindsight', 'coding-agent.json')
}

/** Read the shared config without ever creating it. */
export function readConfigFile() {
  const path = configPath()
  if (!existsSync(path)) return { path, kind: 'missing', config: {} }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { path, kind: 'unreadable', config: {}, error: error.code || String(error) }
  }
  try {
    const config = JSON.parse(text)
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return { path, kind: 'invalid', config: {}, error: 'top level is not a JSON object' }
    }
    return { path, kind: 'ok', config }
  } catch (error) {
    return { path, kind: 'invalid', config: {}, error: error.message }
  }
}

export function getPath(object, dotted) {
  let current = object
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function setPath(object, dotted, value) {
  const keys = dotted.split('.')
  let current = object
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]
    if (current[key] === null || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {}
    }
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

function deletePath(object, dotted) {
  const keys = dotted.split('.')
  let current = object
  for (let index = 0; index < keys.length - 1; index += 1) {
    current = current?.[keys[index]]
    if (current === null || typeof current !== 'object') return
  }
  delete current[keys[keys.length - 1]]
}

export function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => deepEqual(left[key], right[key]))
}

function readState() {
  const path = join(tunerDir(), 'state.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.applied && typeof parsed.applied === 'object') {
      return { applied: parsed.applied, updatedAt: parsed.updatedAt ?? null }
    }
  } catch {
    // Missing or corrupt state degrades to "nothing was applied by this plugin".
  }
  return { applied: {}, updatedAt: null }
}

function writeState(state) {
  const dir = tunerDir()
  mkdirSync(dir, { recursive: true })
  atomicWriteJson(join(dir, 'state.json'), { ...state, updatedAt: new Date().toISOString() })
}

/** Copy before the first write so a user can always recover the original file. */
function backup(file) {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = `${file}.bak-${stamp}`
  try {
    copyFileSync(file, destination)
    pruneBackups(dirname(file), `${basename(file)}.bak-`)
    return destination
  } catch {
    return null
  }
}

function pruneBackups(dir, prefix) {
  try {
    const stale = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(BACKUPS_TO_KEEP)
    for (const file of stale) unlinkSync(file)
  } catch {
    // Backups are a safety net, not a requirement.
  }
}

const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // A host without SharedArrayBuffer simply retries without a pause.
  }
}

function writeFailure(file, error) {
  const code = error?.code
  const reason = code === 'EACCES' || code === 'EPERM'
    ? 'the file or its directory is not writable'
    : code === 'EBUSY'
      ? 'the file is locked by another process'
      : error?.message ?? String(error)
  const mapped = new Error(`cannot write ${file}: ${reason}`)
  mapped.code = code
  return mapped
}

/**
 * Write through a temporary file and rename, so a crash or a concurrent reader
 * never sees a half-written config. Windows antivirus and editors can hold the
 * target briefly, so a locked rename is retried a few times before failing.
 */
function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* nothing to clean up */ }
    throw writeFailure(file, error)
  }

  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      renameSync(temporary, file)
      return
    } catch (error) {
      lastError = error
      if (!LOCKED_CODES.has(error?.code)) break
      sleepSync(15 * (attempt + 1))
    }
  }

  try { unlinkSync(temporary) } catch { /* keep the original error */ }
  throw writeFailure(file, lastError)
}

/**
 * Apply a `[dottedPath, value]` preset to the shared config.
 *
 * Defaults are fill-missing-only (`overwrite: false`): a value the user already
 * chose — including one written by the Hindsight installer or another harness —
 * is left alone. Every path this plugin adds is recorded so `revertTuning` can
 * undo exactly those edits and nothing else.
 */
export function applyTuning({ preset, overwrite = false, dryRun = false } = {}) {
  const file = readConfigFile()
  if (file.kind === 'invalid' || file.kind === 'unreadable') {
    throw new Error(`refusing to edit ${file.path}: ${file.error}`)
  }

  const config = structuredClone(file.config)
  const state = readState()
  const changed = []
  const kept = []
  let backupPath = null

  for (const [path, value] of preset) {
    const current = getPath(config, path)

    if (current === undefined) {
      setPath(config, path, value)
      changed.push({ path, from: null, to: value })
      if (!dryRun) state.applied[path] = { value, had: false, previous: null }
      continue
    }

    if (overwrite && !deepEqual(current, value)) {
      const recorded = state.applied[path]
      setPath(config, path, value)
      changed.push({ path, from: current, to: value })
      if (!dryRun) {
        // Someone changed this key after we wrote it: that newer value becomes
        // what revert must restore, not the value we saw on our first write.
        state.applied[path] = recorded && !deepEqual(current, recorded.value)
          ? { value, had: true, previous: current }
          : recorded
            ? { ...recorded, value }
            : { value, had: true, previous: current }
      }
      continue
    }

    kept.push({ path, value: current })
  }

  if (changed.length > 0 && !dryRun) {
    backupPath = backup(file.path)
    atomicWriteJson(file.path, config)
    writeState(state)
  }

  return { path: file.path, fileExisted: file.kind !== 'missing', changed, kept, dryRun, backupPath }
}

/**
 * Undo this plugin's edits: restore the recorded previous value, or delete the
 * key when it did not exist before. A path the user edited after we wrote it is
 * left untouched and reported as skipped rather than silently overwritten.
 */
export function revertTuning() {
  const file = readConfigFile()
  if (file.kind === 'invalid' || file.kind === 'unreadable') {
    throw new Error(`refusing to edit ${file.path}: ${file.error}`)
  }

  const config = structuredClone(file.config)
  const state = readState()
  const reverted = []
  const skipped = []

  for (const [path, recorded] of Object.entries(state.applied)) {
    const current = getPath(config, path)
    if (!deepEqual(current, recorded.value)) {
      skipped.push({ path, current })
      continue
    }
    if (recorded.had) setPath(config, path, recorded.previous)
    else deletePath(config, path)
    reverted.push({ path, restored: recorded.had ? recorded.previous : null })
    delete state.applied[path]
  }

  let backupPath = null
  if (reverted.length > 0 && file.kind === 'ok') {
    backupPath = backup(file.path)
    atomicWriteJson(file.path, config)
  }
  if (reverted.length > 0) writeState(state)

  return { path: file.path, reverted, skipped, backupPath }
}

/** Dotted paths this plugin has applied and not yet reverted. */
export function appliedPaths() {
  return Object.keys(readState().applied)
}

/** Replace secret values in place for anything that might be displayed. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(key) && item ? '***' : redact(item, depth + 1)
  }
  return out
}
