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
  const stack = []
  let current = object
  for (let index = 0; index < keys.length - 1; index += 1) {
    const next = current?.[keys[index]]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return
    stack.push([current, keys[index], next])
    current = next
  }
  delete current[keys[keys.length - 1]]
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const [parent, key, child] = stack[index]
    if (!Array.isArray(child) && Object.keys(child).length === 0) delete parent[key]
    else break
  }
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

function statePath() {
  return join(tunerDir(), 'state.json')
}

function readState() {
  const path = statePath()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return {
        applied: parsed.applied && typeof parsed.applied === 'object' ? parsed.applied : {},
        journal: parsed.journal && typeof parsed.journal === 'object' ? parsed.journal : null,
        // Persisted opt-out: "revert" must survive a restart, otherwise the
        // next session's ensureTuned() quietly re-applies what the user undid.
        autoTune: parsed.autoTune === true ? true : parsed.autoTune === false ? false : null,
        updatedAt: parsed.updatedAt ?? null,
      }
    }
  } catch {
    // Missing or corrupt state degrades to "nothing was applied by this plugin".
  }
  return { applied: {}, journal: null, autoTune: null, updatedAt: null }
}

function writeState(state) {
  const dir = tunerDir()
  mkdirSync(dir, { recursive: true })
  atomicWriteJson(statePath(), { ...state, updatedAt: new Date().toISOString() })
}

/** Whether the automatic first-session tune may run. An explicit opt-out wins. */
export function autoTuneEnabled() {
  return readState().autoTune !== false
}

/** Persist the opt-out so it also applies to the next DSH process. */
export function setAutoTune(enabled) {
  const target = statePath()
  withLock(target, () => {
    const state = readState()
    state.autoTune = enabled === true
    writeState(state)
  })
}

/** Copy before the first write so a user can always recover the original file. */
function backup(file) {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let destination = `${file}.bak-${stamp}`
  let suffix = 1
  while (existsSync(destination)) {
    destination = `${file}.bak-${stamp}-${suffix}`
    suffix += 1
  }
  try {
    copyFileSync(file, destination)
    try { chmodSync(destination, originalMode(file)) } catch { /* Windows may ignore POSIX modes */ }
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
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || b.localeCompare(a))
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

/** Cheap fingerprint of a file, used to detect a writer that ignores our lock. */
export function fileSnapshot(file) {
  try {
    const info = statSync(file)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

function assertUnchanged(file, expect) {
  if (expect === undefined || expect === null) return
  const now = fileSnapshot(file)
  if (!now || now.mtimeMs !== expect.mtimeMs || now.size !== expect.size) {
    const error = new Error(`${file} changed on disk after it was read; refusing to overwrite another writer`)
    error.code = 'ECONCURRENT'
    throw error
  }
}

/**
 * Write through a temporary file and rename, so a crash or a concurrent reader
 * never sees a half-written config. The temporary file is created 0600 (never
 * wider than the target) and inherits the target's stricter mode. Windows
 * antivirus and editors can hold the target briefly, so a locked rename is
 * retried a few times before failing. When `expect` is given, the target must
 * still match that fingerprint right before the rename.
 */
let tempCounter = 0

function atomicWriteJson(file, value, mode = originalMode(file), expect = null) {
  mkdirSync(dirname(file), { recursive: true })
  tempCounter += 1
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${tempCounter}`
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

  try {
    assertUnchanged(file, expect)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* keep the original error */ }
    throw error
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
        const had = typeof change.had === 'boolean'
          ? change.had
          : (change.from !== null && change.from !== undefined)
        state.applied[change.path] = {
          value: change.to,
          had,
          previous: change.from ?? null,
        }
      }
    } else if (
      typeof change.removed === 'boolean'
        ? (change.removed ? current === undefined : deepEqual(current, change.to))
        : (change.to === null ? current === undefined : deepEqual(current, change.to))
    ) {
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
export function applyTuning({ preset, overwrite = false, dryRun = false, enableAutoTune = false, _testAfterRead } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initial = readConfigFile()
    if (initial.kind === 'invalid' || initial.kind === 'unreadable') {
      throw new Error(`refusing to edit ${initial.path}: ${initial.error}`)
    }

    if (dryRun) {
      return tune(initial, { preset, overwrite, dryRun: true })
    }

    try {
      return withLock(initial.path, () => withLock(statePath(), () => {
        const file = readConfigFile()
        if (file.kind === 'invalid' || file.kind === 'unreadable') {
          throw new Error(`refusing to edit ${file.path}: ${file.error}`)
        }
        if (typeof _testAfterRead === 'function') _testAfterRead(file)
        const snapshot = fileSnapshot(file.path)
        const state = readState()
        const recovered = recoverPending(file, state)

        const result = tune(file, { preset, overwrite, dryRun: false, state })
        if (result.changed.length === 0) {
          if (enableAutoTune && state.autoTune !== true) {
            state.autoTune = true
            writeState(state)
          } else if (recovered) {
            writeState(state)
          }
          return result
        }

        result.backupPath = backup(file.path)
        state.journal = {
          kind: 'apply',
          startedAt: new Date().toISOString(),
          changes: result.changed.map((change) => ({
            path: change.path,
            from: change.from,
            had: change.had,
            to: change.to,
          })),
        }
        if (enableAutoTune) state.autoTune = true
        // Journal first: if we crash after this point, the next run can tell
        // whether the config write landed.
        writeState(state)
        atomicWriteJson(file.path, file.config, undefined, snapshot)
        for (const [path, entry] of Object.entries(result.commit)) state.applied[path] = entry
        state.journal = null
        writeState(state)
        return result
      }))
    } catch (error) {
      // The snapshot only protects the fixable case: a writer that landed during
      // this call. Re-read once with the fresh content before giving up.
      if (error?.code === 'ECONCURRENT' && attempt === 0) continue
      throw error
    }
  }
  throw new Error('config kept changing while it was being written; retry')
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
      changed.push({ path, from: null, had: false, to: value })
      commit[path] = { value, had: false, previous: null }
      continue
    }

    if (overwrite && !deepEqual(current, value)) {
      const recorded = state.applied[path]
      setPath(config, path, value)
      changed.push({ path, from: current, had: true, to: value })
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
export function revertTuning({ dryRun = false, _testAfterRead } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initial = readConfigFile()
    if (initial.kind === 'unreadable') {
      throw new Error(`refusing to edit ${initial.path}: ${initial.error}`)
    }
    if (initial.kind === 'missing') {
      // Nothing was written, but revert still means "stop auto-tuning".
      if (!dryRun) setAutoTune(false)
      return { path: initial.path, reverted: [], skipped: [], backupPath: null, dryRun }
    }
    if (initial.kind === 'invalid') {
      throw new Error(`refusing to edit ${initial.path}: ${initial.error}`)
    }

    if (dryRun) {
      const state = readState()
      const config = structuredClone(initial.config)
      recoverPending(initial, state)
      const plan = planRevert(config, state)
      return { path: initial.path, ...plan, backupPath: null, dryRun: true }
    }

    try {
      return withLock(initial.path, () => withLock(statePath(), () => {
        const file = readConfigFile()
        if (file.kind === 'invalid' || file.kind === 'unreadable') {
          throw new Error(`refusing to edit ${file.path}: ${file.error}`)
        }
        if (typeof _testAfterRead === 'function') _testAfterRead(file)
        const snapshot = fileSnapshot(file.path)
        const state = readState()
        const recovered = recoverPending(file, state)
        const config = structuredClone(file.config)
        const plan = planRevert(config, state)

        let backupPath = null
        if (plan.reverted.length > 0) {
          backupPath = backup(file.path)
          state.journal = {
            kind: 'revert',
            startedAt: new Date().toISOString(),
            changes: plan.reverted.map((entry) => ({ path: entry.path, to: entry.restored, removed: entry.removed })),
          }
          writeState(state)
          atomicWriteJson(file.path, config, undefined, snapshot)
          for (const path of Object.keys(plan.restored)) delete state.applied[path]
          for (const path of plan.removed) delete state.applied[path]
          state.journal = null
        } else if (!recovered && state.autoTune === false) {
          return { path: file.path, reverted: [], skipped: plan.skipped, backupPath: null, dryRun: false }
        }

        // Persisted opt-out: a restart must not re-apply what the user undid.
        state.autoTune = false
        writeState(state)
        return { path: file.path, reverted: plan.reverted, skipped: plan.skipped, backupPath, dryRun: false }
      }))
    } catch (error) {
      if (error?.code === 'ECONCURRENT' && attempt === 0) continue
      throw error
    }
  }
  throw new Error('config kept changing while it was being written; retry')
}

/** Compute (and apply to `config`) the exact undo without touching disk. */
function planRevert(config, state) {
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
    reverted.push({ path, restored: recorded.had ? recorded.previous : null, removed: !recorded.had })
  }
  return { reverted, skipped, restored, removed }
}

/** Dotted paths this plugin has applied and not yet reverted. */
export function appliedPaths() {
  const state = readState()
  recoverPending(readConfigFile(), state)
  return Object.keys(state.applied)
}

/** Read-only summary of the tuner's persisted state for diagnostics. */
export function tunerState() {
  const path = statePath()
  const exists = existsSync(path)
  const state = readState()
  return {
    path,
    exists,
    autoTune: state.autoTune,
    applied: Object.keys(state.applied),
    updatedAt: state.updatedAt,
  }
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
