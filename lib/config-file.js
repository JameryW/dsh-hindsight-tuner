import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const BACKUPS_TO_KEEP = 3
const SECRET_KEYS = new Set(['apiToken', 'token', 'apiKey', 'password'])
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 5_000

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
    if (parsed && typeof parsed === 'object') {
      return {
        applied: parsed.applied && typeof parsed.applied === 'object' ? parsed.applied : {},
        journal: parsed.journal && typeof parsed.journal === 'object' ? parsed.journal : null,
        updatedAt: parsed.updatedAt ?? null,
      }
    }
  } catch {
    // Missing or corrupt state degrades to "nothing was applied by this plugin".
  }
  return { applied: {}, journal: null, updatedAt: null }
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

/** Preserve a stricter mode (0600 for a config holding an apiToken) if present. */
function originalMode(file) {
  try {
    const mode = statSync(file).mode & 0o777
    return mode === 0 ? 0o600 : mode & 0o600 ? mode : 0o600
  } catch {
    return 0o600
  }
}

/**
 * Write through a temporary file and rename, so a crash or a concurrent reader
 * never sees a half-written config. The temporary file is created 0600 (never
 * wider than the target) and inherits the target's stricter mode. Windows
 * antivirus and editors can hold the target briefly, so a locked rename is
 * retried a few times before failing.
 */
function atomicWriteJson(file, value, mode = originalMode(file)) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(temporary, mode) } catch { /* Windows may ignore POSIX modes */ }
    try {
      const handle = openSync(temporary, 'r+')
      try { fsyncSync(handle) } finally { closeSync(handle) }
    } catch { /* fsync is best-effort */ }
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
 * Serialize read-modify-write across processes with a sidecar lock file.
 * A lock older than LOCK_STALE_MS is treated as a crashed writer and replaced.
 */
function withLock(target, callback) {
  mkdirSync(dirname(target), { recursive: true })
  const lockPath = `${target}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle = null

  while (handle === null) {
    try {
      handle = openSync(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw writeFailure(lockPath, error)
      try {
        const info = statSync(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // The other writer released the lock between open and stat.
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`another process is editing ${target}; remove ${lockPath} if it is stale`)
      }
      sleepSync(40)
    }
  }

  try {
    try { writeSync(handle, String(process.pid)) } catch { /* identification only */ }
    return callback()
  } finally {
    try { closeSync(handle) } catch { /* already closed */ }
    try { unlinkSync(lockPath) } catch { /* already removed */ }
  }
}

/**
 * Fold a journal left by a crash into the applied map. The journal is written
 * before the config, so its presence means the config write may or may not have
 * landed; comparing the live value tells us which.
 */
function recoverPending(file, state) {
  if (!state.journal || !Array.isArray(state.journal.changes)) return false
  const config = file.config
  for (const change of state.journal.changes) {
    const current = getPath(config, change.path)
    if (state.journal.kind === 'apply') {
      if (deepEqual(current, change.to)) {
        state.applied[change.path] = {
          value: change.to,
          had: change.from !== null && change.from !== undefined,
          previous: change.from ?? null,
        }
      }
    } else if (change.to === null ? current === undefined : deepEqual(current, change.to)) {
      delete state.applied[change.path]
    }
  }
  state.journal = null
  return true
}

/**
 * Apply a `[dottedPath, value]` preset to the shared config.
 *
 * Defaults are fill-missing-only (`overwrite: false`): a value the user already
 * chose — including one written by the Hindsight installer or another harness —
 * is left alone. Every path this plugin adds is recorded so `revertTuning` can
 * undo exactly those edits and nothing else. The write is serialized by a lock
 * and made recoverable by a journal written before the config changes.
 */
export function applyTuning({ preset, overwrite = false, dryRun = false } = {}) {
  const initial = readConfigFile()
  if (initial.kind === 'invalid' || initial.kind === 'unreadable') {
    throw new Error(`refusing to edit ${initial.path}: ${initial.error}`)
  }

  if (dryRun) {
    return tune(initial, { preset, overwrite, dryRun: true })
  }

  return withLock(initial.path, () => {
    const file = readConfigFile()
    if (file.kind === 'invalid' || file.kind === 'unreadable') {
      throw new Error(`refusing to edit ${file.path}: ${file.error}`)
    }
    const state = readState()
    const recovered = recoverPending(file, state)

    const result = tune(file, { preset, overwrite, dryRun: false, state })
    if (result.changed.length === 0) {
      if (recovered) writeState(state)
      return result
    }

    result.backupPath = backup(file.path)
    state.journal = {
      kind: 'apply',
      startedAt: new Date().toISOString(),
      changes: result.changed.map((change) => ({ path: change.path, from: change.from, to: change.to })),
    }
    // Journal first: if we crash after this point, the next run can tell
    // whether the config write landed.
    writeState(state)
    atomicWriteJson(file.path, file.config)
    for (const [path, entry] of Object.entries(result.commit)) state.applied[path] = entry
    state.journal = null
    writeState(state)
    return result
  })
}

/**
 * Compute the diff without touching the file. `file.config` is mutated in place
 * for a real write; the caller owns that copy.
 */
function tune(file, { preset, overwrite, dryRun, state = { applied: {} } }) {
  const config = structuredClone(file.config)
  const changed = []
  const kept = []
  const commit = {}

  for (const [path, value] of preset) {
    const current = getPath(config, path)

    if (current === undefined) {
      setPath(config, path, value)
      changed.push({ path, from: null, to: value })
      commit[path] = { value, had: false, previous: null }
      continue
    }

    if (overwrite && !deepEqual(current, value)) {
      const recorded = state.applied[path]
      setPath(config, path, value)
      changed.push({ path, from: current, to: value })
      // Someone changed this key after we wrote it: that newer value becomes
      // what revert must restore, not the value we saw on our first write.
      commit[path] = recorded && !deepEqual(current, recorded.value)
        ? { value, had: true, previous: current }
        : recorded
          ? { ...recorded, value }
          : { value, had: true, previous: current }
      continue
    }

    kept.push({ path, value: current })
  }

  // For a real write hand the mutated copy back to the caller.
  file.config = dryRun ? file.config : config
  return { path: file.path, fileExisted: file.kind !== 'missing', changed, kept, dryRun, backupPath: null, commit }
}

/**
 * Undo this plugin's edits: restore the recorded previous value, or delete the
 * key when it did not exist before. A path the user edited after we wrote it is
 * left untouched and reported as skipped rather than silently overwritten.
 */
export function revertTuning() {
  const initial = readConfigFile()
  if (initial.kind === 'invalid' || initial.kind === 'unreadable') {
    throw new Error(`refusing to edit ${initial.path}: ${initial.error}`)
  }

  const early = readState()
  if (!early.journal && Object.keys(early.applied).length === 0) {
    return { path: initial.path, reverted: [], skipped: [], backupPath: null }
  }

  return withLock(initial.path, () => {
    const file = readConfigFile()
    if (file.kind === 'invalid' || file.kind === 'unreadable') {
      throw new Error(`refusing to edit ${file.path}: ${file.error}`)
    }

    const config = structuredClone(file.config)
    const state = readState()
    const recovered = recoverPending(file, state)
    const reverted = []
    const skipped = []
    const restored = {}
    const removed = []

    for (const [path, recorded] of Object.entries(state.applied)) {
      const current = getPath(config, path)
      if (!deepEqual(current, recorded.value)) {
        skipped.push({ path, current })
        continue
      }
      if (recorded.had) {
        setPath(config, path, recorded.previous)
        restored[path] = recorded.previous
      } else {
        deletePath(config, path)
        removed.push(path)
      }
      reverted.push({ path, restored: recorded.had ? recorded.previous : null })
    }

    let backupPath = null
    if (reverted.length > 0) {
      backupPath = backup(file.path)
      state.journal = {
        kind: 'revert',
        startedAt: new Date().toISOString(),
        changes: reverted.map((entry) => ({ path: entry.path, to: entry.restored })),
      }
      writeState(state)
      atomicWriteJson(file.path, config)
      for (const path of Object.keys(restored)) delete state.applied[path]
      for (const path of removed) delete state.applied[path]
      state.journal = null
      writeState(state)
    } else if (recovered) {
      writeState(state)
    }

    return { path: file.path, reverted, skipped, backupPath }
  })
}

/** Dotted paths this plugin has applied and not yet reverted. */
export function appliedPaths() {
  const state = readState()
  recoverPending(readConfigFile(), state)
  return Object.keys(state.applied)
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
