/**
 * Git worktree isolation for A/B experiments.
 *
 * Every (arm, task, repeat) run can be executed in its own detached git
 * worktree, so an agent's edits never leak into the main checkout or into
 * another arm's run. The worktree starts at an exact commit (the base SHA),
 * which is recorded in the experiment report for reproducibility.
 *
 * The module is synchronous and dependency-free (git CLI + node builtins).
 * It never prints to the console; callers decide how to report failures.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const GIT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 16 * 1024 * 1024
const DEFAULT_ROOT_PREFIX = 'dsh-hindsight-eval-worktrees'
const NAME_MAX = 48

/** The base revision could not be resolved or the worktree is not a git work tree. */
export class WorktreeError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'WorktreeError'
    Object.assign(this, details)
  }
}

function toText(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value.toString === 'function') {
    try {
      return value.toString('utf8')
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function firstLine(text) {
  const line = toText(text).trim().split(/\r?\n/).find((entry) => entry.trim())
  return line ? line.trim() : ''
}

function quote(value) {
  return JSON.stringify(String(value))
}

/**
 * Block the current thread for a short backoff without timers/async.
 * Used only by best-effort cleanup: the experiment result is already decided,
 * and on Windows a just-exited agent (or one of its shell hooks) can keep a
 * directory handle open for a few hundred milliseconds.
 */
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Without SharedArrayBuffer the retries still run; only the delay is lost.
  }
}

/**
 * Run git with array arguments (never a shell) and capture output.
 * `allowFailure` turns a non-zero exit into a result value instead of an error;
 * a missing git executable always throws, because silently pretending "not a
 * repository" would hide a broken environment.
 */
function runGit(args, { cwd, allowFailure = false } = {}) {
  if (typeof cwd !== 'string' || !cwd) {
    throw new WorktreeError(`git ${args.join(' ')}: cwd must be a non-empty string`)
  }
  // A missing cwd makes spawn report ENOENT for the git executable, which would
  // otherwise be misreported as "git is not installed". Check it first.
  let cwdStat
  try {
    cwdStat = statSync(cwd)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new WorktreeError(
        `git ${args.join(' ')}: working directory does not exist: ${quote(cwd)}`,
        { cause: error },
      )
    }
    throw error
  }
  if (!cwdStat.isDirectory()) {
    throw new WorktreeError(`git ${args.join(' ')}: working directory is not a directory: ${quote(cwd)}`)
  }
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
    })
    return { ok: true, status: 0, stdout: toText(stdout), stderr: '', args, cwd }
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'ENOENT' : null
    if (code === 'ENOENT') {
      throw new WorktreeError(
        `git executable not found on PATH: worktree isolation needs git (${firstLine(error.message)})`,
        { cause: error },
      )
    }
    const stdout = toText(error && error.stdout)
    const stderr = toText(error && error.stderr)
    const status = typeof error.status === 'number' ? error.status : null
    const result = { ok: false, status, stdout, stderr, args, cwd }
    if (allowFailure) return result
    const detail = stderr.trim() || stdout.trim() || firstLine(error.message) || `exit ${status}`
    throw new WorktreeError(
      `git ${args.join(' ')} failed in ${cwd}${status === null ? '' : ` (exit ${status})`}: ${detail}`,
      { cause: error, ...result },
    )
  }
}

function assertDirectoryArgument(dir, fnName) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new TypeError(`${fnName} requires a non-empty directory path`)
  }
  return resolve(dir)
}

/** Paths must stay inside the worktree root before we ever delete them. */
function assertInside(root, candidate) {
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    throw new WorktreeError(`refusing to touch path outside the worktree root: ${candidate}`)
  }
}

/**
 * Resolve the root of the git working tree containing `dir`.
 * Returns null when `dir` is not inside a git repository (including a missing
 * directory); throws when git itself is missing.
 */
export function repoRootOf(dir) {
  const start = assertDirectoryArgument(dir, 'repoRootOf')
  let stat
  try {
    stat = statSync(start)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isDirectory()) return null
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd: start, allowFailure: true })
  if (!result.ok) return null
  const root = result.stdout.trim()
  return root ? resolve(root) : null
}

/**
 * Resolve a base revision to a commit SHA. Defaults to HEAD.
 * Throws a precise error when the repository or the revision cannot be found.
 */
export function baseShaOf(repo, base = 'HEAD') {
  if (typeof repo !== 'string' || !repo.trim()) {
    throw new TypeError('baseShaOf requires a repository path')
  }
  const root = repoRootOf(repo)
  if (!root) {
    throw new WorktreeError(
      `cannot resolve git repository for ${quote(repo)}: not inside a git working tree`,
    )
  }
  const ref = base == null || base === '' ? 'HEAD' : String(base)
  const result = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, allowFailure: true })
  const sha = result.ok ? result.stdout.trim() : ''
  if (!sha) {
    const why = firstLine(result.stderr) || firstLine(result.stdout) || `git rev-parse exited ${result.status}`
    throw new WorktreeError(
      `cannot resolve base revision ${quote(ref)} in ${root}: ${why}` +
        ' (make sure the repository has at least one commit and the ref exists)',
    )
  }
  return sha
}

function sanitizeName(name) {
  const raw = typeof name === 'string' && name.trim() ? name.trim() : 'run'
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, NAME_MAX)
  return safe || 'run'
}

function uniqueWorktreePath(root, slug) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const candidate = join(root, `${slug}-${suffix}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new WorktreeError(`cannot allocate a unique worktree directory under ${root}`)
}

function makeHandle({ path, repo, baseSha, name }) {
  let disposedAt = null
  return {
    path,
    repo,
    baseSha,
    name,
    get disposed() {
      return disposedAt !== null
    },
    dispose() {
      if (disposedAt !== null) return { removed: false, path, alreadyDisposed: true }
      // Only mark the handle disposed after the removal succeeded: a failed
      // dispose (locked directory, EPERM) must stay retryable, otherwise the
      // caller believes the worktree is gone while it still holds disk and a
      // registration entry.
      const result = removeWorktree({ repo, path })
      disposedAt = new Date().toISOString()
      return result
    },
  }
}

const REMOVE_ATTEMPTS = 4
const REMOVE_RETRY_MS = 150
const DELETE_ATTEMPTS = 16
const DELETE_RETRY_MS = 500

function removeWorktree({ repo, path }) {
  let result = null
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    result = runGit(['worktree', 'remove', '--force', path], { cwd: repo, allowFailure: true })
    if (result.ok || !existsSync(path)) break
    // Windows can report EPERM/EBUSY while the agent process or one of its
    // hooks is still releasing the directory; retry briefly before giving up.
    if (attempt < REMOVE_ATTEMPTS - 1) sleepSync(REMOVE_RETRY_MS * (attempt + 1))
  }
  // `git worktree remove` deletes the registration before the files on Windows,
  // so later attempts report "not a working tree" while the directory (still
  // held open by a lingering agent/hook) remains. The deletion loop below
  // handles that case; a `git worktree prune` here would be a no-op because the
  // directory still exists, so it is deliberately omitted.
  let fallbackError = null
  for (let attempt = 0; attempt < DELETE_ATTEMPTS && existsSync(path); attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      break
    } catch (error) {
      fallbackError = error
      if (attempt < DELETE_ATTEMPTS - 1) sleepSync(DELETE_RETRY_MS)
    }
  }
  const prune = runGit(['worktree', 'prune'], { cwd: repo, allowFailure: true })
  if (!prune.ok) {
    throw new WorktreeError(
      `removed worktree ${path} but could not prune ${repo}: ${firstLine(prune.stderr) || `exit ${prune.status}`}`,
    )
  }
  if (existsSync(path)) {
    const details = fallbackError ? `; fallback delete failed: ${firstLine(fallbackError.message)}` : ''
    throw new WorktreeError(
      `could not remove worktree ${path}: ${firstLine(result?.stderr) || `git exited ${result?.status}`}${details}`,
    )
  }
  return { removed: true, path }
}

/**
 * Create a detached worktree of `repo` at `base` (default HEAD).
 *
 * @param {{repo: string, base?: string, root?: string, name?: string}} options
 * @returns {{path: string, repo: string, baseSha: string, name: string,
 *            readonly disposed: boolean, dispose: () => {removed: boolean, path: string}}}
 */
export function createWorktree({ repo, base = 'HEAD', root, name } = {}) {
  if (typeof repo !== 'string' || !repo.trim()) {
    throw new TypeError('createWorktree requires { repo } (a path inside a git working tree)')
  }
  const repoRoot = repoRootOf(repo)
  if (!repoRoot) {
    throw new WorktreeError(
      `cannot create worktree: ${quote(repo)} is not inside a git working tree`,
    )
  }
  const baseSha = baseShaOf(repoRoot, base)
  const worktreeRoot = resolve(root || join(tmpdir(), DEFAULT_ROOT_PREFIX))
  mkdirSync(worktreeRoot, { recursive: true })
  const slug = sanitizeName(name)
  const path = uniqueWorktreePath(worktreeRoot, slug)
  assertInside(worktreeRoot, path)

  let created = false
  try {
    runGit(['worktree', 'add', '--detach', path, baseSha], { cwd: repoRoot })
    created = true
    const handle = makeHandle({ path, repo: repoRoot, baseSha, name: slug })
    verifyWorktree(handle)
    return handle
  } catch (error) {
    if (created) {
      runGit(['worktree', 'remove', '--force', path], { cwd: repoRoot, allowFailure: true })
      if (existsSync(path)) {
        try {
          rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
        } catch {
          // The original error is the useful one; prune below still runs.
        }
      }
    }
    runGit(['worktree', 'prune'], { cwd: repoRoot, allowFailure: true })
    const detail = error instanceof Error ? firstLine(error.message) : String(error)
    throw new WorktreeError(
      `cannot create git worktree at ${path} from ${repoRoot} @ ${baseSha}: ${detail}`,
      { cause: error },
    )
  }
}

/**
 * Verify that the worktree still points at the recorded base commit.
 * Throws with the expected/found SHAs on drift, and when the path is not a
 * readable git work tree.
 */
export function verifyWorktree(handle) {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError('verifyWorktree requires a worktree handle')
  }
  const { path, baseSha } = handle
  if (typeof path !== 'string' || !path) {
    throw new WorktreeError('worktree handle has no path')
  }
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
    throw new WorktreeError(`worktree handle has no valid baseSha (got ${JSON.stringify(baseSha)})`, {
      path,
    })
  }
  const result = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: path, allowFailure: true })
  if (!result.ok) {
    throw new WorktreeError(
      `worktree at ${path} is not a readable git work tree: ${firstLine(result.stderr) || 'git rev-parse failed'}`,
      { path, baseSha },
    )
  }
  const head = result.stdout.trim()
  if (head !== baseSha) {
    throw new WorktreeError(
      `worktree HEAD drifted at ${path}: expected ${baseSha}, found ${head}`,
      { path, baseSha, head },
    )
  }
  return { ok: true, path, baseSha, head }
}

/** Dispose a worktree handle (idempotent; also exported standalone per the eval API). */
export function disposeWorktree(handle) {
  if (!handle || typeof handle.dispose !== 'function') {
    throw new TypeError('disposeWorktree requires a worktree handle returned by createWorktree')
  }
  return handle.dispose()
}

/**
 * Reset a worktree between attempts: return it to its recorded base commit and
 * remove untracked plus ignored files
 * (`git reset --hard <baseSha> && git clean -fdx`).
 *
 * The earlier `git checkout -- . && git clean -fd` contract could not honour
 * `--reset-between-attempts`: staged edits, commits the agent created and
 * ignored build artifacts all survived, so attempt 2 started from attempt 1's
 * state. Resetting to the recorded base SHA is the only reset that is actually
 * independent of what the previous attempt did.
 */
export function resetWorktree(handle) {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError('resetWorktree requires a worktree handle')
  }
  const { path, baseSha } = handle
  if (typeof path !== 'string' || !path) {
    throw new TypeError('resetWorktree requires a worktree handle with a path')
  }
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
    throw new WorktreeError(`worktree handle has no valid baseSha (got ${JSON.stringify(baseSha)})`, {
      path,
    })
  }
  // Fail with the same detail verifyWorktree gives when the path is gone or no
  // longer a git work tree, instead of a raw `git reset --hard` failure.
  const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: path, allowFailure: true })
  if (!head.ok) {
    throw new WorktreeError(
      `worktree at ${path} is not a readable git work tree: ${firstLine(head.stderr) || 'git rev-parse failed'}`,
      { path, baseSha },
    )
  }
  runGit(['reset', '--hard', baseSha], { cwd: path })
  runGit(['clean', '-fdx'], { cwd: path })
  return { ok: true, path, baseSha }
}

/**
 * Run `fn(handle)` inside a fresh worktree and always dispose it afterwards,
 * preserving the callback's error when cleanup also fails.
 */
export async function withWorktree(options, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withWorktree(options, fn) requires a callback function')
  }
  const handle = createWorktree(options)
  let result
  let failure = null
  try {
    result = await fn(handle)
  } catch (error) {
    failure = error
  }
  let cleanupError = null
  try {
    disposeWorktree(handle)
  } catch (error) {
    cleanupError = error
  }
  if (failure) {
    if (cleanupError) {
      const suffix = `; worktree cleanup also failed: ${firstLine(cleanupError.message)}`
      if (failure instanceof Error) failure.message = `${failure.message}${suffix}`
      else failure = new WorktreeError(`${String(failure)}${suffix}`, { cause: failure })
    }
    throw failure
  }
  if (cleanupError) throw cleanupError
  return result
}
