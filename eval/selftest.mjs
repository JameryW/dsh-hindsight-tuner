#!/usr/bin/env node
/**
 * Offline selftest for the eval infrastructure.
 *
 * Uses only Node builtins and local fixtures: a throwaway git repository, a
 * local node:http fake Hindsight bank, and synthetic rows. No network, no real
 * agents, deterministic, and designed to finish in a few seconds.
 *
 * Run: node eval/selftest.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BankError,
  FINGERPRINT_FORMAT,
  assertFrozen,
  canonicalJson,
  captureFingerprint,
  fingerprintOf,
  fingerprintStats,
  fingerprintTree,
  probeCapabilities,
  readFingerprint,
  resolveBank,
  uniqueBankId,
  verifyFingerprint,
  writeFingerprint,
} from './bank.mjs'
import {
  DEFAULT_ARMS as HARNESS_DEFAULT_ARMS,
  evaluate,
  formatReport,
  parsePrimary,
  writeReport,
} from './harness.mjs'
import {
  ZERO_PRICES,
  assertComplete,
  costOfRow,
  formatMemoryValue,
  generalizationCheck,
  memoryGate,
  memoryValue,
  mulberry32,
  pairedComparison,
  summarizeArm,
} from './stats.mjs'
import { HINT_SEPARATOR, hintedPrompt } from './agents/claude-hint.mjs'
import {
  WorktreeError,
  baseShaOf,
  createWorktree,
  disposeWorktree,
  repoRootOf,
  resetWorktree,
  verifyWorktree,
  withWorktree,
} from './worktree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const AB_FILE = join(HERE, 'ab.mjs')
const {
  parseArgs,
  readTasks,
  readPrices,
  resolveArms,
  parseUsage,
  splitCommand,
  normalizeCheck,
  createRunner,
  pinExperimentConfig,
  verifyPinnedConfig,
  readPluginVersion,
} = await import('./ab.mjs')
import { auditTaskLeakage } from './leak.mjs'

// ---------------------------------------------------------------------------
// Tiny assertion / reporting helpers
// ---------------------------------------------------------------------------

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? null })
}

function check(name, fn) {
  try {
    const value = fn()
    if (value === false) throw new Error('check returned false')
    if (value && typeof value.then === 'function') {
      throw new Error('check() received a promise; use checkAsync()')
    }
    record(name, true)
  } catch (error) {
    record(name, false, describeError(error))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    record(name, true)
  } catch (error) {
    record(name, false, describeError(error))
  }
}

function describeError(error) {
  if (!error) return 'unknown error'
  const text = error.stack || error.message || String(error)
  return String(text).split('\n').slice(0, 4).join(' | ')
}

function ok(condition, message) {
  if (!condition) throw new Error(message)
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${formatValue(expected)}, got ${formatValue(actual)}`)
  }
}

/**
 * Compare paths by their canonical spelling. `git rev-parse --show-toplevel`
 * returns the real path of the working tree, which differs from the raw fixture
 * path wherever the temp directory is a symlink (`/var` → `/private/var` on
 * macOS) or uses an 8.3 short name (`RUNNER~1` → `runneradmin` on Windows CI).
 * Both spellings are the same directory, so the comparison must not depend on
 * which one the caller typed.
 *
 * The path itself may no longer exist by the time a report is compared (a run
 * removes its worktrees), so canonicalize the deepest existing ancestor and
 * re-append the rest.
 */
function canonicalPath(value) {
  const absolute = resolve(value)
  const suffix = []
  let current = absolute
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(current)
      return suffix.length > 0 ? join(real, ...suffix.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      suffix.push(basename(current))
      current = parent
    }
  }
  return absolute
}

function equalPath(actual, expected, label) {
  equal(canonicalPath(actual), canonicalPath(expected), label)
}

function deepEqual(actual, expected, label) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`)
}

function includes(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label}: expected output to contain ${JSON.stringify(needle)}`)
  }
}

function approx(actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected} (±${tolerance}), got ${formatValue(actual)}`)
  }
}

function matches(text, pattern, label) {
  if (!pattern.test(String(text))) {
    throw new Error(`${label}: output does not match ${pattern}`)
  }
}

function throws(fn, pattern, label) {
  let error = null
  try {
    fn()
  } catch (caught) {
    error = caught
  }
  if (!error) throw new Error(`${label}: expected an error`)
  if (pattern && !String(error.message).includes(pattern)) {
    throw new Error(`${label}: expected message containing ${JSON.stringify(pattern)}, got ${JSON.stringify(error.message)}`)
  }
  return error
}

async function throwsAsync(fn, pattern, label) {
  let error = null
  try {
    await fn()
  } catch (caught) {
    error = caught
  }
  if (!error) throw new Error(`${label}: expected an error`)
  if (pattern && !String(error.message).includes(pattern)) {
    throw new Error(`${label}: expected message containing ${JSON.stringify(pattern)}, got ${JSON.stringify(error.message)}`)
  }
  return error
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Read a worktree file with line endings normalized (Windows checkout safety). */
function readText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function makeGitRepo(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'eval-selftest@example.invalid'])
  git(dir, ['config', 'user.name', 'Eval Selftest'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(dir, 'tracked.txt'), 'one\n', 'utf8')
  git(dir, ['add', 'tracked.txt'])
  git(dir, ['commit', '-q', '-m', 'first', '--no-gpg-sign'])
  writeFileSync(join(dir, 'second.txt'), 'two\n', 'utf8')
  git(dir, ['add', 'second.txt'])
  git(dir, ['commit', '-q', '-m', 'second', '--no-gpg-sign'])
  writeFileSync(join(dir, 'tracked.txt'), 'three\n', 'utf8')
  git(dir, ['add', 'tracked.txt'])
  git(dir, ['commit', '-q', '-m', 'third', '--no-gpg-sign'])
  return {
    head: git(dir, ['rev-parse', 'HEAD']).trim(),
    previous: git(dir, ['rev-parse', 'HEAD~1']).trim(),
    first: git(dir, ['rev-parse', 'HEAD~2']).trim(),
  }
}

function gitWorktreeCount(repo) {
  const output = git(repo, ['worktree', 'list', '--porcelain'])
  return output.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length
}

/**
 * Start a local fake Hindsight bank. Serves the modern pages/tree, the legacy
 * alias, and stats; records every request so tests can assert paths and auth.
 */
async function startFakeBank({ bank, legacyOnly = false, stats, capabilities = null } = {}) {
  const state = {
    bank,
    legacyOnly,
    capabilities,
    tree: {
      roots: [
        {
          id: 'root-1',
          kind: 'folder',
          name: 'Selftest Root',
          parent_id: null,
          mental_model_id: null,
          managed: false,
          description: 'fake bank root',
        },
      ],
    },
    stats: stats ?? {
      bank_id: bank,
      total_nodes: 3,
      total_links: 1,
      total_documents: 2,
      nodes_by_fact_type: { fact: 3 },
      links_by_link_type: { semantic: 1 },
      pending_operations: 0,
      failed_operations: 0,
      operations_by_status: {},
      last_consolidated_at: '2026-01-01T00:00:00Z',
    },
    requests: [],
  }
  const server = createServer((request, response) => {
    const respond = (status, body) => {
      const payload = JSON.stringify(body)
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.setHeader('content-length', Buffer.byteLength(payload))
      response.end(payload)
    }
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      state.requests.push({ pathname, authorization: request.headers.authorization ?? null })
      if (pathname === '/health' && state.capabilities) {
        respond(200, { status: 'ok', version: '1.2.0', ...state.capabilities })
        return
      }
      const encodedBank = encodeURIComponent(state.bank)
      const bankPrefix = `/v1/default/banks/${encodedBank}/`
      if (!pathname.startsWith(bankPrefix)) {
        respond(404, { error: 'unknown bank' })
        return
      }
      if (pathname === `${bankPrefix}pages/tree`) {
        if (state.legacyOnly) respond(404, { error: 'no modern pages route' })
        else respond(200, state.tree)
        return
      }
      if (pathname === `${bankPrefix}knowledge-base/tree`) {
        respond(200, state.tree)
        return
      }
      if (pathname === `${bankPrefix}stats`) {
        respond(200, state.stats)
        return
      }
      respond(404, { error: 'unknown route' })
    } catch (error) {
      respond(500, { error: error && error.message ? error.message : String(error) })
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const apiUrl = `http://127.0.0.1:${address.port}`
  return {
    state,
    apiUrl,
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
    },
  }
}

function makeRow(overrides = {}) {
  return {
    taskId: 't1',
    arm: 'A',
    repeat: 0,
    attempt: 1,
    passed: false,
    tokens: null,
    usage: null,
    durationMs: null,
    cost: null,
    failureSignature: null,
    error: null,
    ...overrides,
  }
}

// Rows for a complete experiment: t1 passes on attempt 1, t2 exhausts its
// attempts with timeout rows (a legitimate failure, not a completeness issue).
function completeRows({ tasks, arms, repeats }) {
  const rows = []
  for (const task of tasks) {
    for (const arm of arms) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        if (task.id === 't1') {
          rows.push(
            makeRow({
              taskId: task.id,
              arm,
              repeat,
              attempt: 1,
              passed: true,
              tokens: 10,
              durationMs: 5,
            }),
          )
        } else {
          for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
            rows.push(
              makeRow({
                taskId: task.id,
                arm,
                repeat,
                attempt,
                passed: false,
                tokens: 10,
                durationMs: 7,
                failureSignature: 'timeout',
                error: 'timed out',
              }),
            )
          }
        }
      }
    }
  }
  return rows
}

/** Paired rows for cost/attempts/success comparisons (one repeat per task). */
function pairedRows({ arm, tasks, cost, attempts = 1, solved = true }) {
  const rows = []
  for (const taskId of tasks) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      rows.push(
        makeRow({
          taskId,
          arm,
          repeat: 0,
          attempt,
          passed: solved && attempt === attempts,
          tokens: cost,
          cost,
          durationMs: 10,
          failureSignature: solved ? null : 'check-failed',
          error: solved ? null : 'failed',
        }),
      )
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Worktree checks
// ---------------------------------------------------------------------------

async function worktreeChecks(repoDir, head, previous, worktreeRoot) {
  check('repoRootOf resolves a git work tree', () => {
    equalPath(repoRootOf(repoDir), resolve(repoDir), 'repoRootOf')
  })

  check('repoRootOf returns null outside git', () => {
    const plain = join(worktreeRoot, '..', 'plain-dir')
    mkdirSync(plain, { recursive: true })
    equal(repoRootOf(plain), null, 'repoRootOf(plain)')
  })

  check('baseShaOf resolves HEAD and arbitrary refs', () => {
    equal(baseShaOf(repoDir), head, 'baseShaOf HEAD')
    equal(baseShaOf(repoDir, 'HEAD~1'), previous, 'baseShaOf HEAD~1')
    matches(head, /^[0-9a-f]{40}$/i, 'head sha')
  })

  check('baseShaOf rejects an unknown revision with detail', () => {
    const error = throws(() => baseShaOf(repoDir, 'no-such-ref'), 'cannot resolve base revision', 'baseShaOf')
    ok(error instanceof WorktreeError, 'expected a WorktreeError')
    includes(error.message, 'no-such-ref', 'error mentions the revision')
  })

  check('createWorktree creates an isolated detached worktree', () => {
    const handle = createWorktree({ repo: repoDir, root: worktreeRoot, name: 'isolation' })
    try {
      equal(handle.baseSha, head, 'handle.baseSha')
      equalPath(handle.repo, resolve(repoDir), 'handle.repo')
      ok(existsSync(handle.path), 'worktree path exists')
      const prefix = worktreeRoot.endsWith(sep) ? worktreeRoot : `${worktreeRoot}${sep}`
      ok(handle.path.startsWith(prefix), 'worktree path stays under the requested root')
      equal(readText(join(handle.path, 'tracked.txt')), 'three\n', 'worktree content at HEAD')
      const verified = verifyWorktree(handle)
      equal(verified.ok, true, 'verifyWorktree.ok')
      equal(verified.head, head, 'verifyWorktree.head')

      writeFileSync(join(handle.path, 'isolated-write.txt'), 'only-in-worktree\n', 'utf8')
      equal(existsSync(join(repoDir, 'isolated-write.txt')), false, 'main repo unaffected')
      equal(git(repoDir, ['status', '--porcelain']).trim(), '', 'main repo status clean')
      equal(handle.disposed, false, 'handle not disposed yet')
    } finally {
      if (!handle.disposed) disposeWorktree(handle)
    }
  })

  check('createWorktree honours the base parameter', () => {
    const handle = createWorktree({
      repo: repoDir,
      base: 'HEAD~1',
      root: worktreeRoot,
      name: 'base-ref',
    })
    try {
      equal(handle.baseSha, previous, 'baseSha from HEAD~1')
      equal(readText(join(handle.path, 'tracked.txt')), 'one\n', 'content at HEAD~1')
      equal(existsSync(join(handle.path, 'second.txt')), true, 'second commit content present')
    } finally {
      if (!handle.disposed) disposeWorktree(handle)
    }
  })

  check('verifyWorktree detects HEAD drift', () => {
    const handle = createWorktree({ repo: repoDir, root: worktreeRoot, name: 'drift' })
    try {
      git(handle.path, ['commit', '-q', '--allow-empty', '-m', 'drift', '--no-gpg-sign'])
      const error = throws(() => verifyWorktree(handle), 'drifted', 'verifyWorktree drift')
      includes(error.message, handle.baseSha, 'error includes expected SHA')
    } finally {
      if (!handle.disposed) disposeWorktree(handle)
    }
  })

  check('disposeWorktree removes the worktree and prunes metadata', () => {
    const handle = createWorktree({ repo: repoDir, root: worktreeRoot, name: 'dispose' })
    const path = handle.path
    const outcome = disposeWorktree(handle)
    equal(outcome.removed, true, 'dispose outcome')
    equal(existsSync(path), false, 'worktree directory removed')
    equal(handle.disposed, true, 'handle marked disposed')
    equal(disposeWorktree(handle).alreadyDisposed, true, 'dispose is idempotent')
    equal(gitWorktreeCount(repoDir), 1, 'only the main worktree remains registered')
  })

  check('resetWorktree discards committed/staged edits and ignored artifacts', () => {
    const handle = createWorktree({ repo: repoDir, root: worktreeRoot, name: 'reset' })
    try {
      // Simulate what an agent attempt can leave behind: an edit committed in
      // the worktree, a staged-but-uncommitted edit, an untracked file and an
      // ignored build artifact. All four must be gone before attempt 2.
      writeFileSync(join(handle.path, 'tracked.txt'), 'attempt-one\n', 'utf8')
      git(handle.path, ['add', 'tracked.txt'])
      git(handle.path, ['commit', '-q', '-m', 'attempt one edit', '--no-gpg-sign'])
      writeFileSync(join(handle.path, 'second.txt'), 'staged-edit\n', 'utf8')
      git(handle.path, ['add', 'second.txt'])
      writeFileSync(join(handle.path, 'untracked.txt'), 'junk\n', 'utf8')
      writeFileSync(join(handle.path, '.gitignore'), '*.log\n', 'utf8')
      writeFileSync(join(handle.path, 'artifact.log'), 'ignored-artifact\n', 'utf8')
      equal(git(handle.path, ['status', '--porcelain']).trim().length > 0, true, 'dirty before reset')

      const outcome = resetWorktree(handle)
      equal(outcome.ok, true, 'resetWorktree.ok')
      equalPath(outcome.path, handle.path, 'resetWorktree path')
      equal(readText(join(handle.path, 'tracked.txt')), 'three\n', 'committed edit discarded')
      equal(readText(join(handle.path, 'second.txt')), 'two\n', 'staged edit discarded')
      equal(git(handle.path, ['rev-parse', 'HEAD']).trim(), handle.baseSha, 'HEAD back at the base commit')
      equal(git(handle.path, ['status', '--porcelain']).trim(), '', 'worktree is clean after reset')
      equal(existsSync(join(handle.path, 'untracked.txt')), false, 'untracked file removed')
      equal(existsSync(join(handle.path, 'artifact.log')), false, 'ignored artifact removed')
    } finally {
      if (!handle.disposed) disposeWorktree(handle)
    }
  })

  check('resetWorktree rejects handles without a path or baseSha', () => {
    throws(() => resetWorktree(null), 'requires a worktree handle', 'null handle')
    throws(() => resetWorktree({}), 'with a path', 'missing path')
    throws(() => resetWorktree({ path: repoDir }), 'no valid baseSha', 'missing baseSha')
  })

  await checkAsync('withWorktree disposes even when the callback throws', async () => {
    let inside = null
    const error = await throwsAsync(
      () =>
        withWorktree({ repo: repoDir, root: worktreeRoot, name: 'with-error' }, async (handle) => {
          inside = handle.path
          ok(existsSync(inside), 'worktree exists inside callback')
          throw new Error('callback-boom')
        }),
      'callback-boom',
      'withWorktree error passthrough',
    )
    equal(error.message.includes('callback-boom'), true, 'callback error preserved')
    equal(existsSync(inside), false, 'worktree removed after error')
  })

  await checkAsync('withWorktree returns the callback value and cleans up', async () => {
    let inside = null
    const value = await withWorktree(
      { repo: repoDir, root: worktreeRoot, name: 'with-return' },
      async (handle) => {
        inside = handle.path
        return 42
      },
    )
    equal(value, 42, 'callback return value')
    equal(existsSync(inside), false, 'worktree removed after success')
  })
}

// ---------------------------------------------------------------------------
// Bank checks
// ---------------------------------------------------------------------------

async function bankChecks(repoDir, tempRoot) {
  const bankName = 'coding-agent::selftest bank+slash/path'
  const fake = await startFakeBank({ bank: bankName })
  let captured = null
  const fingerprintFile = join(tempRoot, 'fingerprints', 'bank-fingerprint.json')

  try {
    check('resolveBank uses daemon and derived-bank defaults', () => {
      const resolved = resolveBank({ repo: repoDir })
      equal(resolved.apiUrl, 'http://127.0.0.1:9077', 'default apiUrl')
      equal(resolved.bank, `coding-agent::${basename(repoDir)}`, 'default bank')
      equal(resolved.tokenSet, false, 'no token by default')
      equal(resolved.source.apiUrl, 'default', 'apiUrl source')
      equal(resolved.source.bank, 'default', 'bank source')
    })

    check('resolveBank gives arguments precedence over env', () => {
      process.env.HINDSIGHT_API_URL = 'http://env.example:9999/'
      process.env.HINDSIGHT_BANK_ID = 'env-bank'
      process.env.HINDSIGHT_API_TOKEN = 'env-token'
      try {
        const fromEnv = resolveBank({ repo: repoDir })
        equal(fromEnv.apiUrl, 'http://env.example:9999', 'env apiUrl normalized')
        equal(fromEnv.bank, 'env-bank', 'env bank')
        equal(fromEnv.token, 'env-token', 'env token')
        equal(fromEnv.tokenSet, true, 'env token set')
        equal(fromEnv.source.apiUrl, 'env', 'env apiUrl source')

        const fromArgs = resolveBank({
          repo: repoDir,
          apiUrl: 'http://arg.example:1234/',
          bank: 'arg-bank',
          token: 'arg-token',
        })
        equal(fromArgs.apiUrl, 'http://arg.example:1234', 'arg apiUrl normalized')
        equal(fromArgs.bank, 'arg-bank', 'arg bank')
        equal(fromArgs.token, 'arg-token', 'arg token')
        equal(fromArgs.source.bank, 'argument', 'arg bank source')
      } finally {
        delete process.env.HINDSIGHT_API_URL
        delete process.env.HINDSIGHT_BANK_ID
        delete process.env.HINDSIGHT_API_TOKEN
      }
    })

    check('uniqueBankId appends a readable timestamp and random suffix', () => {
      const fixed = new Date('2026-11-23T12:01:02.345Z')
      const first = uniqueBankId('coding-agent::demo', { now: fixed, random: () => 0.123456 })
      matches(first, /^coding-agent::demo--eval-20261123-120102-[0-9a-z]{6}/, 'timestamp + random suffix')
      const second = uniqueBankId('coding-agent::demo', { now: fixed, random: () => 0.123456 })
      ok(first !== second, 'the process counter keeps repeated draws unique')
      throws(() => uniqueBankId('  '), 'non-empty', 'empty base rejected')
    })

    await checkAsync('probeCapabilities reads separated embeddings and operation validator flags', async () => {
      const capable = await startFakeBank({
        bank: 'cap-bank',
        capabilities: {
          embedding: { separate_embeddings: true },
          operation_validator: { available: true },
        },
      })
      try {
        const result = await probeCapabilities({ apiUrl: capable.apiUrl })
        equal(result.ok, true, 'capability probe ok')
        equal(result.version, '1.2.0', 'server version')
        equal(result.embedding.separated, true, 'separated embeddings detected')
        equal(result.operationValidator.available, true, 'operation validator detected')
      } finally {
        await capable.close()
      }
      const missing = await probeCapabilities({ apiUrl: fake.apiUrl })
      equal(missing.ok, false, 'no capability endpoint is not reported as supported')
      equal(missing.status, 404, 'all-404 status')
      equal(missing.embedding.separated, null, 'unknown embedding capability')
    })

    check('canonicalJson sorts keys recursively and preserves arrays', () => {
      equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}', 'canonical json')
      equal(canonicalJson({ list: [{ z: 1, y: 2 }] }), '{"list":[{"y":2,"z":1}]}', 'canonical arrays')
      equal(
        fingerprintOf({ tree: { roots: [{ name: 'a', id: '1' }] }, stats: { y: 2, x: 1 } }),
        fingerprintOf({ tree: { roots: [{ id: '1', name: 'a' }] }, stats: { x: 1, y: 2 } }),
        'fingerprint independent of key order',
      )
    })

    await checkAsync('captureFingerprint reads the encoded bank tree and stats', async () => {
      captured = await captureFingerprint({
        apiUrl: fake.apiUrl,
        bank: bankName,
        token: 'tok-123',
        timeoutMs: 5000,
      })
      equal(captured.bankId, bankName, 'bankId preserved')
      equal(captured.apiUrl, fake.apiUrl, 'apiUrl')
      matches(captured.fingerprint, /^[0-9a-f]{64}$/, 'sha256 fingerprint')
      equal(captured.tree.roots.length, 1, 'tree roots')
      equal(captured.stats.total_nodes, 3, 'stats total_nodes')
      ok(captured.capturedAt, 'capturedAt set')

      const encoded = encodeURIComponent(bankName)
      includes(encoded, '%3A', 'encodeURIComponent encodes colons')
      includes(encoded, '%20', 'encodeURIComponent encodes spaces')
      includes(encoded, '%2F', 'encodeURIComponent encodes slashes')
      const paths = fake.state.requests.map((request) => request.pathname)
      includes(paths.join('\n'), `/v1/default/banks/${encoded}/pages/tree`, 'encoded tree path')
      includes(paths.join('\n'), `/v1/default/banks/${encoded}/stats`, 'encoded stats path')
      const treeRequest = fake.state.requests.find((request) =>
        request.pathname.endsWith('/pages/tree'),
      )
      equal(treeRequest.authorization, 'Bearer tok-123', 'Bearer token only when provided')
    })

    await checkAsync('captureFingerprint is stable while the bank is unchanged', async () => {
      const second = await captureFingerprint({
        apiUrl: fake.apiUrl,
        bank: bankName,
        timeoutMs: 5000,
      })
      equal(second.fingerprint, captured.fingerprint, 'stable fingerprint')
      const last = fake.state.requests.at(-1)
      ok(last.pathname.endsWith('/stats'), 'last request was stats')
      const treeRequest = fake.state.requests
        .filter((request) => request.pathname.endsWith('/pages/tree'))
        .at(-1)
      equal(treeRequest.authorization, null, 'no Authorization header without a token')
    })

    await checkAsync('fingerprint files round-trip and verify', async () => {
      const written = writeFingerprint(fingerprintFile, captured)
      equal(written, fingerprintFile, 'writeFingerprint path')
      const loaded = readFingerprint(fingerprintFile)
      equal(loaded.fingerprint, captured.fingerprint, 'fingerprint round-trip')
      equal(loaded.bankId, bankName, 'bankId round-trip')
      const verification = await verifyFingerprint(fingerprintFile, {
        apiUrl: fake.apiUrl,
        bank: bankName,
        timeoutMs: 5000,
      })
      equal(verification.ok, true, 'verifyFingerprint ok')
      equal(verification.diffs.length, 0, 'no diffs')
    })

    check('readFingerprint rejects malformed files', () => {
      const broken = join(tempRoot, 'fingerprints', 'broken.json')
      writeFileSync(broken, JSON.stringify({ fingerprint: 'nope', tree: {}, stats: {} }), 'utf8')
      throws(() => readFingerprint(broken), 'sha256', 'invalid fingerprint file')
    })

    await checkAsync('verifyFingerprint and assertFrozen detect bank drift', async () => {
      fake.state.stats.total_nodes = 4
      try {
        const failed = await verifyFingerprint(captured, {
          apiUrl: fake.apiUrl,
          bank: bankName,
          timeoutMs: 5000,
        })
        equal(failed.ok, false, 'verifyFingerprint not ok after drift')
        ok(failed.diffs.length > 0, 'diffs reported')
        ok(
          failed.diffs.some((diff) => diff.includes('stats.total_nodes')),
          `expected a stats.total_nodes diff, got ${JSON.stringify(failed.diffs)}`,
        )
        equal(failed.actual.stats.total_nodes, 4, 'fresh capture reflects the new state')

        const error = await throwsAsync(
          () => assertFrozen(captured, { apiUrl: fake.apiUrl, bank: bankName, timeoutMs: 5000 }),
          'fingerprint changed',
          'assertFrozen drift error',
        )
        includes(error.message, captured.fingerprint, 'assertFrozen names the frozen fingerprint')
        ok(error instanceof BankError, 'assertFrozen throws BankError')
      } finally {
        fake.state.stats.total_nodes = 3
      }
    })

    await checkAsync('operation bookkeeping does not change the frozen fingerprint', async () => {
      fake.state.stats.operations_by_status = { completed: 25 }
      fake.state.stats.pending_operations = 2
      fake.state.stats.last_consolidated_at = '2026-02-01T00:00:00Z'
      try {
        const verification = await verifyFingerprint(captured, {
          apiUrl: fake.apiUrl,
          bank: bankName,
          timeoutMs: 5000,
        })
        equal(verification.ok, true, 'operation-only change stays ok')
        equal(verification.diffs.length, 0, 'no diffs for operation-only change')
        equal(verification.actual.fingerprint, captured.fingerprint, 'fingerprint ignores bookkeeping')
        equal(
          Object.keys(fingerprintStats({ operations_by_status: {}, pending_operations: 1 })).length,
          0,
          'fingerprintStats filters every bookkeeping key',
        )

        fake.state.stats.total_nodes = 4
        const drifted = await verifyFingerprint(captured, {
          apiUrl: fake.apiUrl,
          bank: bankName,
          timeoutMs: 5000,
        })
        equal(drifted.ok, false, 'memory change still fails')
        ok(
          drifted.diffs.some((diff) => diff.includes('stats.total_nodes')),
          `memory diff reported, got ${JSON.stringify(drifted.diffs)}`,
        )
      } finally {
        fake.state.stats.total_nodes = 3
        delete fake.state.stats.operations_by_status
        delete fake.state.stats.pending_operations
        delete fake.state.stats.last_consolidated_at
      }
    })

    await checkAsync('page refresh metadata does not change the frozen fingerprint', async () => {
      const root = fake.state.tree.roots[0]
      root.timestamp = '2026-04-01T00:00:00Z'
      root.is_stale = true
      root.last_refresh_failed_at = null
      try {
        const verification = await verifyFingerprint(captured, {
          apiUrl: fake.apiUrl,
          bank: bankName,
          timeoutMs: 5000,
        })
        equal(verification.ok, true, 'refresh metadata change stays ok')
        equal(verification.actual.fingerprint, captured.fingerprint, 'fingerprint ignores refresh metadata')
        equal(
          Object.keys(fingerprintTree({ timestamp: 'x', roots: [{ is_stale: true, name: 'a' }] })).includes(
            'timestamp',
          ),
          false,
          'fingerprintTree drops refresh metadata at every depth',
        )

        root.name = 'Renamed Root'
        const drifted = await verifyFingerprint(captured, {
          apiUrl: fake.apiUrl,
          bank: bankName,
          timeoutMs: 5000,
        })
        equal(drifted.ok, false, 'page structure change still fails')
        ok(
          drifted.diffs.some((diff) => diff.includes('tree.roots[0].name')),
          `page diff reported, got ${JSON.stringify(drifted.diffs)}`,
        )
      } finally {
        root.name = 'Selftest Root'
        delete root.timestamp
        delete root.is_stale
        delete root.last_refresh_failed_at
      }
    })

    await checkAsync('captureFingerprint falls back to the legacy knowledge-base tree', async () => {
      const legacy = await startFakeBank({ bank: 'legacy-bank', legacyOnly: true })
      try {
        const fingerprint = await captureFingerprint({
          apiUrl: legacy.apiUrl,
          bank: 'legacy-bank',
          timeoutMs: 5000,
        })
        equal(fingerprint.tree.roots.length, 1, 'legacy tree captured')
        const paths = legacy.state.requests.map((request) => request.pathname)
        includes(paths.join('\n'), '/pages/tree', 'modern path attempted first')
        includes(paths.join('\n'), '/knowledge-base/tree', 'legacy alias used')
      } finally {
        await legacy.close()
      }
    })

    await checkAsync('captureFingerprint explains an unknown bank', async () => {
      const error = await throwsAsync(
        () =>
          captureFingerprint({
            apiUrl: fake.apiUrl,
            bank: 'not-the-selftest-bank',
            timeoutMs: 5000,
          }),
        'no Pages tree',
        'unknown bank error',
      )
      includes(error.message, 'HTTP 404', 'error includes the 404 status')
    })
  } finally {
    await fake.close()
  }
}

// ---------------------------------------------------------------------------
// Stats checks
// ---------------------------------------------------------------------------

function statsChecks() {
  check('mulberry32 is deterministic per seed and differs across seeds', () => {
    const one = mulberry32(7)
    const two = mulberry32(7)
    const other = mulberry32(8)
    const first = [one(), one(), one(), one()]
    const second = [two(), two(), two(), two()]
    deepEqual(first, second, 'same seed same sequence')
    ok(first[0] !== other(), 'different seed differs')
    ok(first.every((value) => value >= 0 && value < 1), 'values in [0,1)')
  })

  check('costOfRow applies per-million-token prices', () => {
    const prices = {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    }
    const row = makeRow({
      tokens: 4_500_000,
      usage: { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 1_000_000 },
    })
    approx(costOfRow(row, prices), 14.85, 1e-9, 'cost')
  })

  check('costOfRow falls back to total tokens when all prices are zero', () => {
    const row = makeRow({ tokens: 1234, usage: null })
    equal(costOfRow(row, ZERO_PRICES), 1234, 'zero-price cost is a token count')
    equal(costOfRow(makeRow({ tokens: 10, usage: { input: 4, output: 6 } })), 10, 'usage tokens')
    equal(
      costOfRow(makeRow({ tokens: 15, usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } })),
      15,
      'proxy follows the canonical token count when usage has cache tokens',
    )
  })

  check('costOfRow prices token-only rows at the input rate', () => {
    const prices = { inputPerMTok: 5, outputPerMTok: 99, cacheReadPerMTok: 1, cacheWritePerMTok: 1 }
    approx(costOfRow(makeRow({ tokens: 2_000_000, usage: null }), prices), 10, 1e-9, 'token-only cost')
  })

  check('costOfRow prices positive tokens reported with all-zero usage', () => {
    const prices = { inputPerMTok: 5, outputPerMTok: 99, cacheReadPerMTok: 1, cacheWritePerMTok: 1 }
    const row = makeRow({
      tokens: 2_000_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    // The all-zero usage object used to take the weighted branch and price the
    // row at 0 USD, hiding real spend.
    approx(costOfRow(row, prices), 10, 1e-9, 'zero usage cost priced at the input rate')
    equal(costOfRow(row, ZERO_PRICES), 2_000_000, 'zero-price proxy still follows the token count')
  })

  check('summarizeArm computes attempt-aware metrics', () => {
    const rows = [
      makeRow({ taskId: 't1', attempt: 1, passed: false, tokens: 100, durationMs: 10 }),
      makeRow({ taskId: 't1', attempt: 2, passed: true, tokens: 50, durationMs: 5 }),
      makeRow({ taskId: 't2', attempt: 1, passed: false, tokens: 100, durationMs: 20 }),
      makeRow({ taskId: 't2', attempt: 2, passed: false, tokens: 100, durationMs: 20 }),
      makeRow({ taskId: 't2', attempt: 3, passed: false, tokens: 100, durationMs: 20 }),
    ]
    const summary = summarizeArm(rows)
    equal(summary.arm, 'A', 'arm')
    equal(summary.tasks, 2, 'tasks')
    equal(summary.runs, 2, 'runs')
    equal(summary.attempts, 5, 'attempts')
    equal(summary.successRate, 50, 'success rate')
    equal(summary.firstAttemptSuccessRate, 0, 'first-attempt success')
    equal(summary.attemptsToSuccessMean, 2, 'attempts to success')
    equal(summary.failedTasks, 1, 'failed tasks')
    equal(summary.incomplete, 0, 'incomplete')
    equal(summary.costPerSolved, 450, 'cost per solved (token proxy)')
    equal(summary.tokens, 225, 'mean tokens per run')
    equal(summary.tokensPerSuccess, 450, 'tokens per success')
    equal(summary.durationP50Ms, 15, 'p50 duration')
    equal(summary.durationP95Ms, 60, 'p95 duration')
  })

  check('memoryValue splits benefit and tax against the no-memory baseline', () => {
    const rows = [
      makeRow({ taskId: 't1', arm: 'A0', passed: true }),
      makeRow({ taskId: 't2', arm: 'A0', passed: true }),
      makeRow({ taskId: 't3', arm: 'A0', passed: false }),
      makeRow({ taskId: 't1', arm: 'A3', passed: true }),
      makeRow({ taskId: 't2', arm: 'A3', passed: false }),
      makeRow({ taskId: 't3', arm: 'A3', passed: true }),
    ]
    const value = memoryValue(rows, { baseline: 'A0' })
    equal(value.baseline, 'A0', 'baseline')
    equal(value.tasks, 3, 'paired tasks')
    equal(value.arms.length, 1, 'one treatment arm')
    const [arm] = value.arms
    equal(arm.arm, 'A3', 'arm')
    equal(arm.tasks, 3, 'arm tasks')
    approx(arm.benefit, 1 / 3, 1e-4, 'benefit')
    approx(arm.tax, 1 / 3, 1e-4, 'tax')
    approx(arm.netValue, 0, 1e-4, 'net value')
    deepEqual(arm.improvedTaskIds, ['t3'], 'improved tasks')
    deepEqual(arm.regressedTaskIds, ['t2'], 'regressed tasks')
  })

  check('memoryValue auto-detects R0/A0, skips missing baselines and formats', () => {
    const rows = [
      makeRow({ taskId: 't1', arm: 'R0', passed: false }),
      makeRow({ taskId: 't1', arm: 'A3', passed: true }),
    ]
    const auto = memoryValue(rows)
    equal(auto.baseline, 'R0', 'auto baseline')
    approx(auto.arms[0].benefit, 1, 1e-9, 'full benefit')
    approx(auto.arms[0].tax, 0, 1e-9, 'no tax')
    matches(formatMemoryValue(auto), /memory value vs R0/, 'formatted block names the baseline')
    const none = memoryValue([makeRow({ taskId: 't1', arm: 'A3', passed: true })])
    equal(none.baseline, null, 'no baseline found')
    deepEqual(none.arms, [], 'no treatment arms without a baseline')
    equal(formatMemoryValue(none), null, 'no block without a baseline')
    throws(() => memoryValue(rows, { baseline: 'A9' }), 'not among the rows', 'unknown baseline rejected')
  })

  check('memoryValue splits trim tax from distraction tax', () => {
    const rows = [
      makeRow({ taskId: 't1', arm: 'A0', passed: true }),
      makeRow({ taskId: 't2', arm: 'A0', passed: true }),
      makeRow({ taskId: 't3', arm: 'A0', passed: true }),
      makeRow({ taskId: 't1', arm: 'A3', passed: false, trimmed: true }),
      makeRow({ taskId: 't2', arm: 'A3', passed: false, omittedBlocks: 2 }),
      makeRow({ taskId: 't3', arm: 'A3', passed: false }),
    ]
    const value = memoryValue(rows, { baseline: 'A0' })
    const [arm] = value.arms
    approx(arm.tax, 1, 1e-3, 'every regressed task counts as tax')
    approx(arm.trimTax, 2 / 3, 1e-3, 'cut and omitted tasks are trim tax')
    approx(arm.distractionTax, 1 / 3, 1e-3, 'a regression without trim metadata is distraction tax')
    matches(formatMemoryValue(value), /arm\s+benefit\s+tax\s+trim\s+distract\s+net/, 'columns name both taxes')
  })

  check('memoryValue reports MIDR and memoryGate enforces the 5% ceiling', () => {
    const rows = [
      makeRow({ taskId: 't1', arm: 'A0', passed: true }),
      makeRow({ taskId: 't2', arm: 'A0', passed: true }),
      makeRow({ taskId: 't3', arm: 'A0', passed: true }),
      makeRow({ taskId: 't4', arm: 'A0', passed: true }),
      makeRow({ taskId: 't1', arm: 'A3', passed: true }),
      makeRow({ taskId: 't2', arm: 'A3', passed: true }),
      makeRow({ taskId: 't3', arm: 'A3', passed: true }),
      makeRow({ taskId: 't4', arm: 'A3', passed: false }),
    ]
    const value = memoryValue(rows, { baseline: 'A0' })
    approx(value.arms[0].midr, 0.25, 1e-4, 'MIDR is the regressed share')
    const gate = memoryGate(value)
    equal(gate.passed, false, '25% degradation fails the default 5% ceiling')
    equal(gate.arms[0].degraded, 1, 'one degraded task')
    equal(memoryGate(value, { threshold: 0.25 }).passed, true, 'a 25% ceiling admits it')
    throws(() => memoryGate(value, { threshold: 1.2 }), 'between 0 and 1', 'invalid threshold rejected')
    equal(memoryGate(null), null, 'no memory block -> no gate')
    matches(formatMemoryValue(value), /midr/, 'MIDR column is rendered')
  })

  check('generalizationCheck warns without a held-out split and second family', () => {
    const warning = generalizationCheck([{ id: 't1', set: 'screening' }, { id: 't2' }], { agent: 'claude' })
    equal(warning.training, 1, 'screening counts as training')
    equal(warning.heldout, 0, 'no held-out tasks')
    ok(warning.warnings.some((line) => line.includes('training/held-out')), 'split warning')
    ok(warning.warnings.some((line) => line.includes('single agent family')), 'family warning')
    const good = generalizationCheck(
      [{ id: 't1', set: 'training' }, { id: 't2', set: 'confirmation' }],
      { agent: 'claude gpt' },
    )
    equal(good.warnings.length, 0, 'training/held-out + two families is clean')
    const dshAndClaude = generalizationCheck(
      [{ id: 't1', set: 'training' }, { id: 't2', set: 'heldout' }],
      { agent: ['dsh', 'claude'] },
    )
    equal(dshAndClaude.warnings.length, 0, 'dsh is recognized alongside claude as a distinct harness/family')
  })

  check('assertComplete accepts a complete experiment including timeout rows', () => {
    const tasks = [
      { id: 't1', maxAttempts: 3 },
      { id: 't2', maxAttempts: 2 },
    ]
    const rows = completeRows({ tasks, arms: ['A', 'B'], repeats: 2 })
    const result = assertComplete(rows, { tasks, arms: ['A', 'B'], repeats: 2, maxAttempts: 3 })
    equal(result.ok, true, 'complete experiment ok')
    deepEqual(result.problems, [], 'no problems')

    const filtered = rows.filter((row) => row.failureSignature !== 'timeout')
    const timeoutOnly = filtered.length < rows.length
    ok(timeoutOnly, 'timeout rows exist in the fixture')
    equal(
      assertComplete(filtered, { tasks, arms: ['A', 'B'], repeats: 2 }).ok,
      false,
      'dropping timeout rows is a completeness problem',
    )
  })

  check('assertComplete detects a missing (task, arm, repeat) run', () => {
    const tasks = [
      { id: 't1', maxAttempts: 3 },
      { id: 't2', maxAttempts: 2 },
    ]
    const rows = completeRows({ tasks, arms: ['A', 'B'], repeats: 2 })
    const missing = rows.filter(
      (row) => !(row.taskId === 't2' && row.arm === 'B' && row.repeat === 1),
    )
    const result = assertComplete(missing, { tasks, arms: ['A', 'B'], repeats: 2 })
    equal(result.ok, false, 'missing run detected')
    ok(
      result.problems.some((problem) => problem.includes('missing run') && problem.includes('arm B')),
      `expected a missing-run problem, got ${JSON.stringify(result.problems)}`,
    )
  })

  check('assertComplete detects attempt overflow and malformed passed flags', () => {
    const tasks = [{ id: 't1', maxAttempts: 2 }]
    const base = completeRows({ tasks, arms: ['A'], repeats: 1 })
    const overflow = [...base, makeRow({ taskId: 't1', arm: 'A', attempt: 3, passed: false })]
    const overflowResult = assertComplete(overflow, { tasks, arms: ['A'], repeats: 1 })
    equal(overflowResult.ok, false, 'overflow detected')
    ok(
      overflowResult.problems.some((problem) => problem.includes('exceeds maxAttempts 2')),
      `expected an overflow problem, got ${JSON.stringify(overflowResult.problems)}`,
    )

    const malformed = base.map((row) => (row.attempt === 1 ? { ...row, passed: undefined } : row))
    const malformedResult = assertComplete(malformed, { tasks, arms: ['A'], repeats: 1 })
    equal(malformedResult.ok, false, 'malformed passed detected')
    ok(
      malformedResult.problems.some((problem) => problem.includes('expected boolean')),
      `expected a passed-boolean problem, got ${JSON.stringify(malformedResult.problems)}`,
    )
  })

  check('pairedComparison finds a uniform 20% cost win', () => {
    const tasks = ['t0', 't1', 't2', 't3', 't4']
    const baseline = pairedRows({ arm: 'A', tasks, cost: 100 })
    const treatment = pairedRows({ arm: 'B', tasks, cost: 80 })
    const comparison = pairedComparison(baseline, treatment, { seed: 20260101, bootstraps: 4000 })
    equal(comparison.armBaseline, 'A', 'baseline arm')
    equal(comparison.armTreatment, 'B', 'treatment arm')
    equal(comparison.difference, 'B - A (treatment - baseline)', 'direction label')
    equal(comparison.nTasks, tasks.length, 'task count')
    const cost = comparison.metrics.costPerSolved
    equal(cost.n, tasks.length, 'cost n')
    equal(cost.meanDiff, -20, 'mean cost difference')
    ok(cost.ciHigh < 0, `95% CI must be entirely below 0, got [${cost.ciLow}, ${cost.ciHigh}]`)
    ok(cost.pValue < 0.05, `p-value must be < 0.05, got ${cost.pValue}`)
    equal(cost.signs.negative, tasks.length, 'all tasks favour treatment cost')
    const attempts = comparison.metrics.attempts
    equal(attempts.meanDiff, 0, 'attempts identical')
    equal(comparison.metrics.success.meanDiff, 0, 'success identical')
    deepEqual(comparison.tasks, [...tasks].sort(), 'tasks sorted')
  })

  check('pairedComparison of identical arms straddles zero', () => {
    const tasks = ['t0', 't1', 't2', 't3']
    const baseline = pairedRows({ arm: 'A', tasks, cost: 100 })
    const treatment = pairedRows({ arm: 'B', tasks, cost: 100 })
    const comparison = pairedComparison(baseline, treatment)
    for (const key of ['costPerSolved', 'attempts', 'success']) {
      const metric = comparison.metrics[key]
      equal(metric.meanDiff, 0, `${key} mean difference`)
      ok(metric.ciLow <= 0 && metric.ciHigh >= 0, `${key} CI should straddle 0`)
    }
    equal(comparison.metrics.costPerSolved.pValue, 1, 'p-value for identical arms')
  })

  check('pairedComparison is deterministic and pairs only shared tasks', () => {
    const tasks = ['t0', 't1', 't2']
    const baseline = pairedRows({ arm: 'A', tasks, cost: 100 })
    const treatment = pairedRows({ arm: 'B', tasks, cost: 90 })
    const extra = pairedRows({ arm: 'B', tasks: ['t9'], cost: 1 })
    const first = pairedComparison(baseline, [...treatment, ...extra], { seed: 5, bootstraps: 500 })
    const second = pairedComparison(baseline, [...treatment, ...extra], { seed: 5, bootstraps: 500 })
    equal(first.nTasks, 3, 'only shared tasks are paired')
    deepEqual(first.metrics.costPerSolved, second.metrics.costPerSolved, 'deterministic bootstrap')
    equal(first.metrics.costPerSolved.meanDiff, -10, 'cost difference')
  })
}

// ---------------------------------------------------------------------------
// Harness checks
// ---------------------------------------------------------------------------

async function harnessChecks() {
  const tasks = [
    { id: 't1', prompt: 'pass on attempt 2' },
    { id: 't2', prompt: 'always fail', maxAttempts: 2 },
  ]
  const arms = [
    { name: 'A', env: {} },
    { name: 'B', env: { HINDSIGHT_ARM: 'B' } },
  ]
  const calls = []

  async function fakeRunner({ task, arm, repeat, attempt }) {
    calls.push({ taskId: task.id, arm: arm.name, repeat, attempt })
    if (task.id === 't1') {
      if (attempt === 1) {
        return {
          passed: false,
          tokens: 100,
          usage: { input: 80, output: 20 },
          durationMs: 10,
          failureSignature: 'check-exit-1',
          error: 'check failed',
        }
      }
      return { passed: true, tokens: 50, durationMs: 5 }
    }
    return {
      passed: false,
      tokens: 100,
      durationMs: 7,
      failureSignature: 'timeout',
      error: 'timed out',
    }
  }

  const report = await evaluate({
    tasks,
    arms,
    runTask: fakeRunner,
    primary: 'B:A',
    now: new Date('2026-01-02T03:04:05.000Z'),
  })

  check('evaluate emits one row per attempt and attempts until pass', () => {
    equal(report.generatedAt, '2026-01-02T03:04:05.000Z', 'generatedAt')
    equal(report.repeats, 1, 'repeats')
    equal(report.rows.length, 8, 'attempt rows')
    equal(report.runs.length, 4, 'runs')
    equal(calls.length, 8, 'runner calls')
    const t1Rows = report.rows.filter((row) => row.taskId === 't1' && row.arm === 'A')
    deepEqual(t1Rows.map((row) => row.attempt), [1, 2], 't1 attempted 1 then 2')
    deepEqual(t1Rows.map((row) => row.passed), [false, true], 't1 failed then passed')
    const t2Rows = report.rows.filter((row) => row.taskId === 't2' && row.arm === 'A')
    equal(t2Rows.length, 2, 't2 exhausts maxAttempts')
    ok(
      report.rows.every((row) => typeof row.passed === 'boolean' && row.cost !== null),
      'every row has passed and cost',
    )
  })

  check('evaluate derives runs and arm metrics', () => {
    const t1Run = report.runs.find((run) => run.taskId === 't1' && run.arm === 'A')
    equal(t1Run.passed, true, 't1 solved')
    equal(t1Run.attempts, 2, 't1 attempts')
    equal(t1Run.successAtAttempt, 2, 't1 successAtAttempt')
    equal(t1Run.tokens, 150, 't1 tokens')
    equal(t1Run.cost, 150, 't1 cost token proxy')
    const t2Run = report.runs.find((run) => run.taskId === 't2' && run.arm === 'B')
    equal(t2Run.passed, false, 't2 unsolved')
    equal(t2Run.successAtAttempt, null, 't2 successAtAttempt null')
    equal(t2Run.attempts, 2, 't2 attempts')

    const metrics = report.metrics.A
    equal(metrics.runs, 2, 'runs')
    equal(metrics.attempts, 4, 'attempts')
    equal(metrics.successRate, 50, 'success rate')
    equal(metrics.firstAttemptSuccessRate, 0, 'first-attempt success')
    equal(metrics.attemptsToSuccessMean, 2, 'attempts to success')
    equal(metrics.failedTasks, 1, 'failed tasks')
    equal(metrics.costPerSolved, 350, 'cost per solved')
    equal(metrics.incomplete, 0, 'incomplete')
    equal(report.completeness.ok, true, 'completeness ok')
    equal(report.primary, 'B:A', 'primary normalized')
  })

  check('formatReport includes the primary comparison and inclusion warning', () => {
    const text = formatReport(report)
    includes(text, 'eval report', 'header')
    includes(text, 'paired comparison', 'paired comparison')
    includes(text, 'B (treatment) - A (baseline)', 'comparison direction')
    includes(text, 'failed, errored and timed-out runs are included', 'inclusion warning')
    includes(text, 'failed/timeout runs (2/4), kept in every metric', 'failed run inventory')
    includes(text, 'completeness: ok', 'completeness')
    includes(text, 'att/success', 'attempts metric label')
    includes(text, 'cost/solved', 'cost metric label')
  })

  await checkAsync('evaluate and formatReport surface memory value for a no-memory baseline', async () => {
    const matrix = await evaluate({
      tasks: [
        { id: 't1', prompt: 'x', maxAttempts: 1 },
        { id: 't2', prompt: 'x', maxAttempts: 1 },
      ],
      arms: [
        { name: 'A0', env: { HINDSIGHT_AUTO_INJECT: 'none' } },
        { name: 'A3', env: { HINDSIGHT_AUTO_INJECT: 'pages' } },
      ],
      runTask: async ({ task, arm }) => ({ passed: arm.name === 'A3' ? true : task.id === 't1', tokens: 5 }),
    })
    equal(matrix.memory.baseline, 'A0', 'baseline detected from the arm matrix')
    const [memoryArm] = matrix.memory.arms
    equal(memoryArm.arm, 'A3', 'treatment arm')
    approx(memoryArm.benefit, 0.5, 1e-9, 'benefit: t2 solved only with memory')
    approx(memoryArm.tax, 0, 1e-9, 'no regression')
    approx(memoryArm.netValue, 0.5, 1e-9, 'net value')
    deepEqual(memoryArm.improvedTaskIds, ['t2'], 'improved task')
    matches(formatReport(matrix), /memory value vs A0/, 'report prints the memory block')
    equal(report.memory?.baseline ?? null, null, 'the A/B report has no no-memory baseline')
  })

  check('parsePrimary validates and normalizes arm names', () => {
    equal(parsePrimary('A3:A1', ['A1', 'A3']), 'A3:A1', 'normalized primary')
    throws(() => parsePrimary('A3', ['A3']), 'ARM:ARM', 'missing colon')
    throws(() => parsePrimary('A3:A3', ['A3']), 'different arms', 'same arm')
    throws(() => parsePrimary('A9:A1', ['A1', 'A3']), 'unknown arm', 'unknown arm')
  })

  await checkAsync('evaluate catches runner throws as error rows and keeps attempts', async () => {
    const thrown = await evaluate({
      tasks: [{ id: 'boom', prompt: 'x', maxAttempts: 2 }],
      arms: [{ name: 'A', env: {} }],
      runTask: async () => {
        throw new Error('runner-boom')
      },
    })
    equal(thrown.rows.length, 2, 'both attempts recorded')
    deepEqual(
      thrown.rows.map((row) => row.failureSignature),
      ['runner-error', 'runner-error'],
      'failure signatures',
    )
    ok(
      thrown.rows.every((row) => row.error.includes('runner-boom') && row.passed === false),
      'runner errors recorded, never dropped',
    )
    equal(thrown.completeness.ok, true, 'exhausted attempts are complete')
  })

  await checkAsync('evaluate respects armOrder, onRow and run lifecycle hooks', async () => {
    const events = []
    const rowsSeen = []
    const hookReport = await evaluate({
      tasks: [{ id: 't', prompt: 'x', maxAttempts: 1 }],
      arms: [
        { name: 'A', env: {} },
        { name: 'B', env: {} },
      ],
      armOrder: ['B', 'A'],
      runTask: async () => ({ passed: true, tokens: 5 }),
      prepareRun: async ({ task, arm, repeat }) => {
        events.push(`prepare:${task.id}:${arm.name}:${repeat}`)
        return { worktree: { path: 'fake-worktree' } }
      },
      finishRun: async ({ task, arm, repeat, rows, context }) => {
        events.push(`finish:${task.id}:${arm.name}:${repeat}:${rows.length}`)
        equal(context.worktree.path, 'fake-worktree', 'run context passed to finishRun')
      },
      onRow: (row) => {
        rowsSeen.push(row.arm)
      },
    })
    deepEqual(
      hookReport.rows.map((row) => row.arm),
      ['B', 'A'],
      'armOrder controls row order',
    )
    deepEqual(events, ['prepare:t:B:0', 'finish:t:B:0:1', 'prepare:t:A:0', 'finish:t:A:0:1'], 'hook order')
    deepEqual(rowsSeen, ['B', 'A'], 'onRow sees every row')
  })

  await checkAsync('evaluate verifies the bank once per arm and once at the end', async () => {
    const verified = []
    const verifiedReport = await evaluate({
      tasks: [
        { id: 't1', prompt: 'x', maxAttempts: 1 },
        { id: 't2', prompt: 'x', maxAttempts: 1 },
      ],
      arms: [{ name: 'A', env: {} }, { name: 'B', env: {} }],
      runTask: async () => ({ passed: true, tokens: 5 }),
      verifyBank: async ({ arm, stage }) => {
        verified.push(`${arm?.name ?? 'all'}:${stage}`)
      },
    })
    deepEqual(verified, ['A:arm-start', 'B:arm-start', 'all:end'], 'one check per arm plus a final check')
    equal(verifiedReport.rows.length, 4, 'rows still recorded')
    let failed = ''
    try {
      await evaluate({
        tasks: [{ id: 't1', prompt: 'x', maxAttempts: 1 }],
        arms: [{ name: 'A', env: {} }],
        runTask: async () => ({ passed: true, tokens: 5 }),
        verifyBank: async () => {
          throw new Error('bank moved')
        },
      })
    } catch (error) {
      failed = error.message
    }
    equal(failed, 'bank moved', 'a failing bank check aborts the experiment')
  })

  await checkAsync('writeReport writes readable JSON atomically', async () => {
    const target = join(await makeTempDir('report'), 'nested', 'report.json')
    const written = writeReport(report, target)
    equal(written, target, 'writeReport returns the path')
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    equal(parsed.rows.length, report.rows.length, 'rows serialized')
    equal(parsed.completeness.ok, true, 'completeness serialized')
    ok(!existsSync(`${target}.tmp-`), 'no temp file left behind')
  })

  check('harness default arms cover the three env-expressible modalities', () => {
    deepEqual(
      HARNESS_DEFAULT_ARMS.map((arm) => arm.name),
      ['A0', 'A2', 'A3'],
      'default arm names',
    )
    deepEqual(
      HARNESS_DEFAULT_ARMS.map((arm) => arm.env.HINDSIGHT_AUTO_INJECT),
      ['none', 'reflect', 'pages'],
      'default autoInject values',
    )
  })

  check('stats zero prices document the token proxy', () => {
    equal(ZERO_PRICES.inputPerMTok, 0, 'zero price')
  })
}

async function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-eval-selftest-${prefix}-`))
  return dir
}

// ---------------------------------------------------------------------------
// AB CLI checks
// ---------------------------------------------------------------------------

async function abChecks(repoDir, tempRoot) {
  check('parseArgs applies documented defaults', () => {
    const parsed = parseArgs(['--tasks', 'tasks.json'])
    equal(parsed.tasks, 'tasks.json', 'tasks')
    equal(parsed.repeats, 1, 'repeats default')
    equal(parsed.attempts, 3, 'attempts default')
    equal(parsed.timeoutMs, 600000, 'timeout default')
    equal(parsed.bootstraps, 4000, 'bootstraps default')
    equal(parsed.seed, 20260101, 'seed default')
    equal(parsed.isolate, true, 'isolation on by default')
    equal(parsed.keepWorktrees, false, 'keepWorktrees default')
    equal(parsed.resetBetweenAttempts, false, 'reset default')
    equal(parsed.allowUnmetRequires, false, 'allowUnmetRequires default')
    equal(parsed.json, false, 'json default')
    equal(parsed.dryRun, false, 'dryRun default')
    deepEqual(parsed.agent, ['claude', '-p', '--output-format', 'json'], 'agent default')
  })

  check('parseArgs parses every documented flag', () => {
    const parsed = parseArgs([
      '--tasks',
      'tasks.json',
      '--report',
      'report.json',
      '--repeats',
      '2',
      '--timeout',
      '1000',
      '--arms',
      'A0,A3',
      '--agent-command',
      '["node","agent.mjs","--prompt","two words"]',
      '--attempts',
      '4',
      '--no-isolate',
      '--worktree-root',
      'trees',
      '--bank',
      'bank',
      '--api-url',
      'http://api.example:1/',
      '--api-token',
      'tok',
      '--fingerprint-out',
      'fp.json',
      '--verify-fingerprint',
      'frozen.json',
      '--primary',
      'A3:A1',
      '--bootstraps',
      '10',
      '--seed',
      '7',
      '--prices',
      'prices.json',
      '--json',
      '--keep-worktrees',
      '--reset-between-attempts',
      '--allow-unmet-requires',
      '--dry-run',
    ])
    equal(parsed.repeats, 2, 'repeats')
    equal(parsed.timeoutMs, 1000, 'timeout')
    equal(parsed.arms, 'A0,A3', 'arms')
    deepEqual(parsed.agent, ['node', 'agent.mjs', '--prompt', 'two words'], 'agent JSON form')
    equal(parsed.attempts, 4, 'attempts')
    equal(parsed.isolate, false, 'no-isolate')
    equal(parsed.worktreeRoot, 'trees', 'worktree root')
    equal(parsed.bank, 'bank', 'bank')
    equal(parsed.apiUrl, 'http://api.example:1/', 'api url')
    equal(parsed.apiToken, 'tok', 'api token')
    equal(parsed.fingerprintOut, 'fp.json', 'fingerprint out')
    equal(parsed.verifyFingerprint, 'frozen.json', 'verify fingerprint')
    equal(parsed.primary, 'A3:A1', 'primary')
    equal(parsed.bootstraps, 10, 'bootstraps')
    equal(parsed.seed, 7, 'seed')
    equal(parsed.prices, 'prices.json', 'prices')
    equal(parsed.json, true, 'json')
    equal(parsed.keepWorktrees, true, 'keep worktrees')
    equal(parsed.resetBetweenAttempts, true, 'reset between attempts')
    equal(parsed.allowUnmetRequires, true, 'allow unmet requires')
    equal(parsed.dryRun, true, 'dry-run')

    const disabled = parseArgs([
      '--tasks',
      't.json',
      '--reset-between-attempts',
      '--no-reset-between-attempts',
    ])
    equal(disabled.resetBetweenAttempts, false, 'no-reset wins when last')

    const envAgent = parseArgs(['--tasks', 't.json'], {
      env: { HINDSIGHT_EVAL_AGENT_COMMAND: 'dsh -p --json' },
    })
    deepEqual(envAgent.agent, ['dsh', '-p', '--json'], 'HINDSIGHT_EVAL_AGENT_COMMAND overrides default agent CLI')
    equal(envAgent.agentRaw, 'dsh -p --json', 'agentRaw preserves HINDSIGHT_EVAL_AGENT_COMMAND')

    const cliOverridesEnv = parseArgs(['--tasks', 't.json', '--agent-command', 'node runner.mjs'], {
      env: { HINDSIGHT_EVAL_AGENT_COMMAND: 'dsh -p --json' },
    })
    deepEqual(cliOverridesEnv.agent, ['node', 'runner.mjs'], 'explicit --agent-command wins over env default')
  })

  check('parseArgs rejects invalid usage', () => {
    throws(() => parseArgs([]), '--tasks <file> is required', 'missing tasks')
    throws(() => parseArgs(['--tasks']), 'requires a value', 'missing value')
    throws(() => parseArgs(['--tasks', 't.json', '--repeats', 'x']), 'integer', 'bad repeats')
    throws(() => parseArgs(['--tasks', 't.json', '--repeats', '0']), '>= 1', 'zero repeats')
    throws(() => parseArgs(['--tasks', 't.json', '--wat']), 'unknown argument', 'unknown flag')
    throws(
      () => parseArgs(['--tasks', 't.json', '--agent-command', '[1,2]']),
      'non-empty strings',
      'bad agent JSON',
    )
  })

  check('parseArgs accepts flag-like values and --flag=value forms', () => {
    // A report file named like a flag is a legitimate path; only known flags
    // are refused as values.
    const spaced = parseArgs(['--tasks', 't.json', '--report', '--odd.json'])
    equal(spaced.report, '--odd.json', 'flag-like path is a value')
    const inline = parseArgs(['--tasks=t.json', '--repeats=2', '--no-isolate'])
    equal(inline.tasks, 't.json', 'inline tasks')
    equal(inline.repeats, 2, 'inline repeats')
    equal(inline.isolate, false, 'inline form does not disturb boolean flags')
    throws(() => parseArgs(['--tasks', 't.json', '--report=']), 'requires a value', 'empty inline value')
    throws(
      () => parseArgs(['--tasks', 't.json', '--report', '--json']),
      'requires a value',
      'known flag is not accepted as a value',
    )
  })

  const tasksFile = join(tempRoot, 'tasks.json')
  writeFileSync(
    tasksFile,
    `${JSON.stringify(
      {
        tasks: [
          {
            id: 'fix',
            prompt: 'fix the failing test',
            cwd: repoDir,
            check: ['node', '-e', 'process.exit(0)'],
            maxAttempts: 2,
            env: { HINDSIGHT_ARM: 'x', N: 1 },
            asOf: '2020-01-01T00:00:00Z',
          },
          {
            id: 'impl',
            prompt: 'implement the export',
            cwd: repoDir,
            check: { command: 'node', args: ['-e', 'process.exit(0)'] },
            checkCwd: 'sub',
            asOf: '2020-01-01T00:00:00Z',
          },
          {
            id: 'stringcheck',
            prompt: 'string check form',
            cwd: repoDir,
            check: 'node script.js --flag',
            asOf: '2020-01-01T00:00:00Z',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  check('readTasks validates and normalizes task files', () => {
    const tasks = readTasks(tasksFile)
    equal(tasks.length, 3, 'task count')
    equal(tasks[0].id, 'fix', 'id')
    equal(tasks[0].maxAttempts, 2, 'maxAttempts')
    equal(tasks[0].env.HINDSIGHT_ARM, 'x', 'task env')
    deepEqual(tasks[0].check, { command: 'node', args: ['-e', 'process.exit(0)'] }, 'array check')
    equal(tasks[1].checkCwd, 'sub', 'checkCwd')
    deepEqual(tasks[1].check, { command: 'node', args: ['-e', 'process.exit(0)'] }, 'object check')
    deepEqual(tasks[2].check, { command: 'node', args: ['script.js', '--flag'] }, 'string check')
  })

  check('splitCommand and normalizeCheck handle quotes, escapes, and Windows paths', () => {
    deepEqual(
      splitCommand('node "my agent.mjs" \'single quoted\' escaped\\ arg'),
      ['node', 'my agent.mjs', 'single quoted', 'escaped arg'],
      'quotes and escaped spaces',
    )
    deepEqual(
      normalizeCheck('node "C:\\Program Files\\Tool\\app.exe" C:\\tools\\check.mjs'),
      { command: 'node', args: ['C:\\Program Files\\Tool\\app.exe', 'C:\\tools\\check.mjs'] },
      'Windows backslashes preserved',
    )
    deepEqual(
      parseArgs(['--tasks', 't.json', '--agent-command', 'node "my agent.mjs" --flag']).agent,
      ['node', 'my agent.mjs', '--flag'],
      'parseArgs agent string quoting',
    )
    throws(() => splitCommand('node "unterminated'), 'unterminated', 'unterminated quote error')
  })

  check('readTasks rejects malformed task files', () => {
    const duplicate = join(tempRoot, 'duplicate-tasks.json')
    writeFileSync(
      duplicate,
      JSON.stringify({
        tasks: [
          { id: 'same', prompt: 'a', cwd: repoDir, check: ['node', '-e', '0'] },
          { id: 'same', prompt: 'b', cwd: repoDir, check: ['node', '-e', '0'] },
        ],
      }),
      'utf8',
    )
    throws(() => readTasks(duplicate), 'duplicate task id', 'duplicate ids')
    throws(() => readTasks(join(tempRoot, 'missing.json')), 'cannot read task file', 'missing file')

    const noPrompt = join(tempRoot, 'no-prompt.json')
    writeFileSync(noPrompt, JSON.stringify({ tasks: [{ id: 'x', cwd: repoDir }] }), 'utf8')
    throws(() => readTasks(noPrompt), 'needs a non-empty prompt', 'missing prompt')
  })

  check('resolveArms resolves defaults, CSV names and arm files', () => {
    const defaults = resolveArms(null)
    deepEqual(
      defaults.arms.map((arm) => arm.name),
      ['A0', 'A2', 'A3'],
      'default arms',
    )

    const csv = resolveArms('A3,A3-T')
    deepEqual(
      csv.arms.map((arm) => arm.name),
      ['A3', 'A3-T'],
      'CSV arm names',
    )
    equal(csv.arms[0].env.HINDSIGHT_AUTO_INJECT, 'pages', 'A3 env')
    equal(csv.arms[1].env.HINDSIGHT_PAGE_SEARCH_LIMIT, '12', 'A3-T env')
    equal(csv.source.kind, 'csv', 'CSV source')

    const custom = join(tempRoot, 'custom-arms.json')
    writeFileSync(
      custom,
      JSON.stringify({ arms: [{ name: 'X', env: { HINDSIGHT_AUTO_INJECT: 'none' } }, { name: 'Y' }] }),
      'utf8',
    )
    const fromFile = resolveArms(custom)
    deepEqual(
      fromFile.arms.map((arm) => arm.name),
      ['X', 'Y'],
      'arm file names',
    )
    deepEqual(fromFile.arms[0].env, { HINDSIGHT_AUTO_INJECT: 'none' }, 'arm file env')
    deepEqual(fromFile.arms[1].env, {}, 'missing env defaults to {}')
    equal(fromFile.source.kind, 'file', 'file source')

    throws(() => resolveArms('NOPE'), 'unknown arm', 'unknown CSV name')
    // An explicitly empty --arms value used to silently select the default
    // arms, which hid a typo in whatever produced the empty string.
    throws(() => resolveArms(''), 'non-empty', 'explicitly empty arm spec')
    equal(resolveArms(null).source.kind, 'default', 'null keeps the default arms')
  })

  check('readPrices normalizes a price file', () => {
    const pricesFile = join(tempRoot, 'prices.json')
    writeFileSync(pricesFile, JSON.stringify({ inputPerMTok: 3, outputPerMTok: 15 }), 'utf8')
    const prices = readPrices(pricesFile)
    equal(prices.inputPerMTok, 3, 'input price')
    equal(prices.outputPerMTok, 15, 'output price')
    equal(prices.cacheReadPerMTok, 0, 'missing price defaults to zero')
  })

  check('parseUsage reads the last JSON line, multi-line JSON, and Claude usage shapes', () => {
    const stdout = [
      'starting agent',
      JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 4 } }),
      'done',
    ].join('\n')
    const parsed = parseUsage(stdout)
    equal(parsed.tokens, 14, 'token total')
    deepEqual(parsed.usage, { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 }, 'usage shape')

    const cacheLine = JSON.stringify({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    })
    const cached = parseUsage(`${cacheLine}\nnot json`)
    equal(cached.tokens, 15, 'input+output tokens (cache priced separately)')
    deepEqual(cached.usage, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }, 'cache usage')

    const pretty = JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
    }, null, 2)
    const prettyParsed = parseUsage(pretty)
    equal(prettyParsed.tokens, 20, 'multi-line pretty JSON tokens')
    deepEqual(prettyParsed.usage, { input: 12, output: 8, cacheRead: 40, cacheWrite: 10 }, 'multi-line pretty JSON usage')

    const total = parseUsage(JSON.stringify({ total_tokens: 7 }))
    equal(total.tokens, 7, 'top-level total_tokens')
    equal(total.usage, null, 'no usage object')
    deepEqual(parseUsage('no json here'), { usage: null, tokens: null }, 'no usage found')
  })

  // End-to-end dry run through the real CLI entry point: no agents, no network.
  const jsonRun = await runAbCli([
    '--tasks',
    tasksFile,
    '--arms',
    'A0',
    '--dry-run',
    '--json',
  ])
  check('ab --dry-run prints a JSON plan and exits 0', () => {
    equal(jsonRun.status, 0, `exit code (stderr: ${jsonRun.stderr.trim()})`)
    equal(jsonRun.stderr.trim(), '', 'dry run writes nothing to stderr')
    const plan = JSON.parse(jsonRun.stdout)
    equal(plan.tasks.length, 3, 'tasks in plan')
    equal(plan.arms.length, 1, 'arms in plan')
    equal(plan.arms[0].name, 'A0', 'selected arm')
    equal(plan.repeats, 1, 'repeats')
    equal(plan.attemptsDefault, 3, 'attempts default')
    equal(plan.plannedRuns, 3, 'planned runs')
    equal(plan.maxAgentInvocations, 2 + 3 + 3, 'max agent invocations')
    equal(plan.isolation.enabled, true, 'isolation enabled')
    equal(plan.tasks[0].isolated, true, 'git task isolated')
    equal(plan.tasks[0].maxAttempts, 2, 'per-task maxAttempts')
    equalPath(plan.tasks[0].repo, resolve(repoDir), 'repo recorded')
    equal(plan.bank.apiUrl, 'http://127.0.0.1:9077', 'bank api url')
    equal(plan.bank.bankId, `coding-agent::${basename(repoDir)}`, 'bank id')
    equal(plan.bank.verify, null, 'no fingerprint verification')
    equal(plan.bank.fingerprintOut, null, 'no fingerprint capture')
    equal(plan.reportFile, null, 'no report written')
    equal(plan.prices, null, 'no prices')
  })

  const frozenFile = join(tempRoot, 'frozen-fingerprint.json')
  const frozenDigest = fingerprintOf({ tree: { roots: [] }, stats: {} })
  writeFileSync(
    frozenFile,
    JSON.stringify({
      format: FINGERPRINT_FORMAT,
      apiUrl: 'http://frozen.invalid:1',
      bankId: 'frozen-bank',
      tree: { roots: [] },
      stats: {},
      fingerprint: frozenDigest,
    }),
    'utf8',
  )
  const overrideDryRun = await runAbCli([
    '--tasks',
    tasksFile,
    '--arms',
    'A0',
    '--verify-fingerprint',
    frozenFile,
    '--api-url',
    'http://explicit.invalid:2',
    '--bank',
    'explicit-bank',
    '--dry-run',
    '--json',
  ])
  check('ab --verify-fingerprint preserves explicit --api-url and --bank in --dry-run', () => {
    equal(overrideDryRun.status, 0, `exit code (stderr: ${overrideDryRun.stderr.trim()})`)
    const plan = JSON.parse(overrideDryRun.stdout)
    equal(plan.bank.apiUrl, 'http://explicit.invalid:2', 'explicit api-url preserved')
    equal(plan.bank.bankId, 'explicit-bank', 'explicit bank preserved')
    equal(plan.bank.expectedFingerprint, frozenDigest, 'fingerprint recorded')
  })

  await checkAsync('createRunner isolates HINDSIGHT_CONFIG keys overridden by arm env', async () => {
    const cfgFile = join(tempRoot, 'shared-hindsight.json')
    const outFile = join(tempRoot, 'runner-seen.json')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        apiToken: 'keep-secret',
        autoInject: 'pages',
        injectTimeoutMs: 7000,
        harnesses: { dsh: { autoInject: 'recall', pageSearchLimit: 6 } },
        paths: { [repoDir]: { autoInject: 'pages', seedLimit: 20 } },
        banks: { 'coding-agent::x': { autoInject: 'reflect', dynamicBankId: true } },
      }, null, 2),
      'utf8',
    )
    const agentScript = join(tempRoot, 'inspect-agent.mjs')
    writeFileSync(
      agentScript,
      [
        "import { readFileSync, writeFileSync } from 'node:fs'",
        'const cfgPath = process.env.HINDSIGHT_CONFIG',
        'writeFileSync(process.env.OUT_FILE, JSON.stringify({',
        '  cfgPath,',
        '  autoInjectEnv: process.env.HINDSIGHT_AUTO_INJECT,',
        "  cfg: JSON.parse(readFileSync(cfgPath, 'utf8')),",
        '}))',
      ].join('\n'),
      'utf8',
    )
    const prevCfg = process.env.HINDSIGHT_CONFIG
    process.env.HINDSIGHT_CONFIG = cfgFile
    try {
      const runner = createRunner({
        agent: [process.execPath, agentScript],
        timeoutMs: 10_000,
        resetBetweenAttempts: false,
      })
      const result = await runner({
        task: {
          id: 'iso',
          prompt: 'test',
          cwd: repoDir,
          check: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
          env: { OUT_FILE: outFile },
        },
        arm: { name: 'A0', env: { HINDSIGHT_AUTO_INJECT: 'none' } },
        attempt: 1,
        worktree: null,
      })
      equal(result.passed, true, `runner passed: ${result.error || result.note || ''}`)
      const seen = JSON.parse(readFileSync(outFile, 'utf8'))
      ok(seen.cfgPath !== cfgFile, 'isolated config path used')
      equal(seen.autoInjectEnv, 'none', 'arm env preserved')
      equal(seen.cfg.apiToken, 'keep-secret', 'non-overridden top-level key kept')
      equal(seen.cfg.injectTimeoutMs, 7000, 'non-overridden injectTimeoutMs kept')
      equal('autoInject' in seen.cfg, false, 'top-level autoInject stripped')
      equal('autoInject' in seen.cfg.harnesses.dsh, false, 'harnesses.dsh.autoInject stripped')
      equal(seen.cfg.harnesses.dsh.pageSearchLimit, 6, 'non-overridden harness key kept')
      equal('autoInject' in seen.cfg.paths[repoDir], false, 'paths.*.autoInject stripped')
      equal(seen.cfg.paths[repoDir].seedLimit, 20, 'non-overridden path key kept')
      equal('autoInject' in seen.cfg.banks['coding-agent::x'], false, 'banks.*.autoInject stripped')
      equal(seen.cfg.banks['coding-agent::x'].dynamicBankId, true, 'non-overridden bank key kept')
      equal(JSON.parse(readFileSync(cfgFile, 'utf8')).autoInject, 'pages', 'original config file untouched')
      equal(existsSync(dirname(seen.cfgPath)), false, 'isolated scratch dir cleaned up')
    } finally {
      if (prevCfg === undefined) delete process.env.HINDSIGHT_CONFIG
      else process.env.HINDSIGHT_CONFIG = prevCfg
    }
  })

  await checkAsync('createRunner keeps the command-not-found guidance for a missing agent', async () => {
    // On Windows this also exercises the ENOENT retry path: where.exe cannot
    // find the command, so it must not be retried through the shell and the
    // original guidance message must survive.
    const runner = createRunner({
      agent: ['dsh-eval-missing-command-xyz'],
      timeoutMs: 10_000,
      resetBetweenAttempts: false,
    })
    const result = await runner({
      task: {
        id: 'missing',
        prompt: 'x',
        cwd: repoDir,
        check: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      },
      arm: { name: 'A0', env: {} },
      attempt: 1,
      worktree: null,
    })
    equal(result.passed, false, 'run failed')
    equal(result.failureSignature, 'spawn-error', 'spawn error signature')
    includes(result.error, 'command not found', 'guidance message preserved')
  })

  // A task may point at a subdirectory of its repository; the isolated
  // worktree is a checkout of the whole repo, so the runner must cd into the
  // matching subdirectory instead of silently running at the worktree root.
  const subRepo = join(tempRoot, 'subdir-repo')
  makeGitRepo(subRepo)
  mkdirSync(join(subRepo, 'sub', 'pkg'), { recursive: true })
  writeFileSync(join(subRepo, 'sub', 'pkg', 'keep.txt'), 'keep\n', 'utf8')
  git(subRepo, ['add', '.'])
  git(subRepo, ['commit', '-q', '-m', 'add sub pkg', '--no-gpg-sign'])
  const subCwdFile = join(tempRoot, 'subdir-agent-cwd.json')
  const subTasksFile = join(tempRoot, 'subtasks.json')
  writeFileSync(
    subTasksFile,
    JSON.stringify({
      tasks: [
        {
          id: 'sub',
          prompt: 'report cwd',
          cwd: join(subRepo, 'sub', 'pkg'),
          env: { OUT_FILE: subCwdFile },
          check: ['node', '-e', 'process.exit(0)'],
          maxAttempts: 1,
        },
      ],
    }),
    'utf8',
  )
  const cwdAgentScript = join(tempRoot, 'cwd-agent.mjs')
  writeFileSync(
    cwdAgentScript,
    [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.env.OUT_FILE, JSON.stringify({ cwd: process.cwd() }))',
    ].join('\n'),
    'utf8',
  )
  const subRun = await runAbCli([
    '--tasks',
    subTasksFile,
    '--arms',
    'A0',
    '--agent-command',
    JSON.stringify([process.execPath, cwdAgentScript]),
    '--timeout',
    '60000',
    '--json',
    '--worktree-root',
    join(tempRoot, 'subdir-worktrees'),
  ])
  check('ab runs a subdirectory task inside the matching worktree subdirectory', () => {
    equal(subRun.status, 0, `exit code (stderr: ${subRun.stderr.trim()})`)
    const report = JSON.parse(subRun.stdout)
    equal(report.worktrees.length, 1, 'one isolated worktree recorded')
    equalPath(report.worktrees[0].rel, join('sub', 'pkg'), 'relative subdirectory recorded')
    equalPath(
      report.worktrees[0].cwd,
      join(report.worktrees[0].path, 'sub', 'pkg'),
      'worktree subdirectory recorded',
    )
    const seen = JSON.parse(readFileSync(subCwdFile, 'utf8'))
    equalPath(seen.cwd, report.worktrees[0].cwd, 'agent started in the task subdirectory')
  })

  const gatedArmsFile = join(tempRoot, 'gated-arms.json')
  writeFileSync(
    gatedArmsFile,
    JSON.stringify({
      arms: [{ name: 'G', hint: 'manual-setup', requires: ['seed the bank'], env: {} }],
    }),
    'utf8',
  )
  const gatedRefused = await runAbCli(['--tasks', tasksFile, '--arms', gatedArmsFile, '--dry-run'])
  const gatedAllowed = await runAbCli([
    '--tasks',
    tasksFile,
    '--arms',
    gatedArmsFile,
    '--dry-run',
    '--allow-unmet-requires',
    '--json',
  ])
  check('ab refuses arms with declared requires unless --allow-unmet-requires', () => {
    equal(gatedRefused.status, 1, 'refused without the flag')
    includes(gatedRefused.stderr, '--allow-unmet-requires', 'error names the override')
    includes(gatedRefused.stderr, 'G: seed the bank', 'error names the arm and its setup')
    equal(gatedAllowed.status, 0, `allowed with the flag (stderr: ${gatedAllowed.stderr.trim()})`)
    includes(gatedAllowed.stderr, 'requires are not verified', 'allowed run warns')
    const plan = JSON.parse(gatedAllowed.stdout)
    equal(plan.arms[0].hint, 'manual-setup', 'plan carries the arm hint')
    deepEqual(plan.arms[0].requires, ['seed the bank'], 'plan carries the declared setup')
  })

  const dryRunReport = join(tempRoot, 'dry-run-report.json')
  const dryRunWithReport = await runAbCli([
    '--tasks',
    tasksFile,
    '--arms',
    'A0',
    '--dry-run',
    '--report',
    dryRunReport,
  ])
  check('ab --dry-run --report warns that nothing is written', () => {
    equal(dryRunWithReport.status, 0, `exit code (stderr: ${dryRunWithReport.stderr.trim()})`)
    includes(dryRunWithReport.stderr, 'does not write the report', 'warning printed')
    includes(dryRunWithReport.stdout, 'report: ', 'plan still shows the report file')
    equal(existsSync(dryRunReport), false, 'no report file written')
  })

  const textRun = await runAbCli(['--tasks', tasksFile, '--arms', 'A0', '--dry-run'])
  check('ab --dry-run prints a readable plan', () => {
    equal(textRun.status, 0, `exit code (stderr: ${textRun.stderr.trim()})`)
    includes(textRun.stdout, 'eval dry run (no agents spawned, no bank requests)', 'dry-run header')
    includes(textRun.stdout, 'runs: 3 tasks × 1 arms × 1 repeats = 3 runs', 'run count')
    includes(textRun.stdout, 'fingerprint: none', 'fingerprint plan')
    includes(textRun.stdout, 'report: none', 'report plan')
    includes(textRun.stdout, 'fix', 'task id listed')
    includes(textRun.stdout, 'A0', 'arm listed')
  })

  // Leak prevention and evidence pinning: an experiment that cannot show its
  // history cutoff or that lets the tuner rewrite its config mid-run is refused.
  const noCutoffTasks = join(tempRoot, 'no-cutoff-tasks.json')
  writeFileSync(
    noCutoffTasks,
    JSON.stringify({
      tasks: [{ id: 'hot', prompt: 'fix it', cwd: repoDir, check: ['node', '-e', 'process.exit(0)'] }],
    }),
    'utf8',
  )
  const leakRefused = await runAbCli(['--tasks', noCutoffTasks, '--arms', 'A3', '--dry-run'])
  check('ab refuses memory arms for tasks without a history cutoff', () => {
    equal(leakRefused.status, 1, 'refused before any run')
    includes(leakRefused.stderr, 'task leakage checks failed', 'error names the audit')
    includes(leakRefused.stderr, 'has no asOf', 'error names the missing cutoff')
  })

  check('leak audit rejects late bases, excluded fixes, reused tasks and future cutoffs', () => {
    const base = 'a'.repeat(40)
    const audit = auditTaskLeakage(
      [
        {
          id: 't1',
          prompt: 'same prompt',
          cwd: repoDir,
          asOf: '2026-01-01T00:00:00Z',
          baseSha: base,
          set: 'screening',
          exclude: [base],
        },
        {
          id: 't2',
          prompt: 'same prompt',
          cwd: repoDir,
          asOf: '2026-01-01T00:00:00Z',
          set: 'confirmation',
        },
        { id: 't3', prompt: 'future', cwd: repoDir, asOf: '2999-01-01T00:00:00Z' },
      ],
      { now: Date.parse('2026-02-01T00:00:00Z'), gitCommitTime: () => '2026-03-01T00:00:00Z' },
    )
    equal(audit.ok, false, 'violations found')
    const text = audit.problems.join('\n')
    includes(text, 'after its asOf', 'late starting commit rejected')
    includes(text, 'names as the target fix', 'excluded base commit rejected')
    includes(text, 'must be disjoint', 'screening/confirmation reuse rejected')
    includes(text, 'in the future', 'future cutoff rejected')
    equal(audit.sets.screening, 1, 'screening set counted')
    equal(audit.sets.confirmation, 1, 'confirmation set counted')
  })

  check('leak audit rejects a base recorded in both sets', () => {
    const shared = 'b'.repeat(40)
    const audit = auditTaskLeakage(
      [
        { id: 's1', prompt: 'one prompt', cwd: repoDir, set: 'screening', baseSha: shared },
        { id: 'c1', prompt: 'two prompt', cwd: repoDir, set: 'confirmation', baseSha: shared },
      ],
      { gitCommitTime: () => null },
    )
    equal(audit.ok, false, 'shared base found')
    includes(audit.problems.join('\n'), 'each set needs its own checkout', 'cross-set baseSha rejected')
  })

  check('leak audit matches uppercase and abbreviated SHAs in exclude and cross-set baseSha', () => {
    const full = 'abcdef1234567890abcdef1234567890abcdef12'
    const audit = auditTaskLeakage(
      [
        {
          id: 's1',
          prompt: 'screening prompt',
          cwd: repoDir,
          set: 'screening',
          baseSha: full.slice(0, 10).toUpperCase(),
          exclude: [full],
        },
        {
          id: 'c1',
          prompt: 'confirmation prompt',
          cwd: repoDir,
          set: 'confirmation',
          baseSha: full,
        },
      ],
      { gitCommitTime: () => null },
    )
    equal(audit.ok, false, 'case/prefix SHA conflicts detected')
    const joined = audit.problems.join('\n')
    includes(joined, 'exclude list names as the target fix', 'short uppercase baseSha matches full lowercase exclude SHA')
    includes(joined, 'each set needs its own checkout', 'short uppercase screening baseSha matches full confirmation baseSha')
  })

  await checkAsync('createRunner strips retainSessions from coding-agent.json even when arm/task env omit it', async () => {
    const cfgFile = join(tempRoot, 'retain-hindsight.json')
    const outFile = join(tempRoot, 'retain-seen.json')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        retainSessions: true,
        autoInject: 'pages',
        harnesses: {
          eval: {
            retainSessions: true,
            paths: { [repoDir]: { retainSessions: true, seedLimit: 10 } },
            banks: { 'coding-agent::x': { retainSessions: true, dynamicBankId: true } },
          },
        },
      }, null, 2),
      'utf8',
    )
    const agentScript = join(tempRoot, 'inspect-retain.mjs')
    writeFileSync(
      agentScript,
      [
        "import { readFileSync, writeFileSync } from 'node:fs'",
        'const cfgPath = process.env.HINDSIGHT_CONFIG',
        'writeFileSync(process.env.OUT_FILE, JSON.stringify({',
        '  cfgPath,',
        '  retainEnv: process.env.HINDSIGHT_RETAIN_SESSIONS,',
        "  cfg: JSON.parse(readFileSync(cfgPath, 'utf8')),",
        '}))',
      ].join('\n'),
      'utf8',
    )
    const prevCfg = process.env.HINDSIGHT_CONFIG
    process.env.HINDSIGHT_CONFIG = cfgFile
    try {
      const runner = createRunner({
        agent: [process.execPath, agentScript],
        timeoutMs: 10_000,
        resetBetweenAttempts: false,
      })
      const result = await runner({
        task: {
          id: 'retain-iso',
          prompt: 'test',
          cwd: repoDir,
          check: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
          env: { OUT_FILE: outFile },
        },
        arm: { name: 'A3', env: {} },
        attempt: 1,
        worktree: null,
      })
      equal(result.passed, true, `runner passed: ${result.error || result.note || ''}`)
      const seen = JSON.parse(readFileSync(outFile, 'utf8'))
      ok(seen.cfgPath !== cfgFile, 'isolated config used for default retainSessions=false')
      equal(seen.retainEnv, 'false', 'default HINDSIGHT_RETAIN_SESSIONS=false preserved')
      equal('retainSessions' in seen.cfg, false, 'top-level retainSessions stripped')
      equal('retainSessions' in seen.cfg.harnesses.eval, false, 'harnesses.eval.retainSessions stripped')
      equal('retainSessions' in seen.cfg.harnesses.eval.paths[repoDir], false, 'nested harnesses.eval.paths.*.retainSessions stripped')
      equal('retainSessions' in seen.cfg.harnesses.eval.banks['coding-agent::x'], false, 'nested harnesses.eval.banks.*.retainSessions stripped')
      equal(seen.cfg.harnesses.eval.paths[repoDir].seedLimit, 10, 'unrelated nested path setting kept')
      equal(seen.cfg.autoInject, 'pages', 'unrelated top-level setting kept')
    } finally {
      if (prevCfg === undefined) delete process.env.HINDSIGHT_CONFIG
      else process.env.HINDSIGHT_CONFIG = prevCfg
    }
  })

  check('plugin version and tuner config are pinned for the experiment', () => {
    const version = readPluginVersion()
    equal(version.name, '@jameryw/dsh-hindsight-tuner', 'plugin name')
    matches(version.version, /^\d+\.\d+\.\d+/, 'plugin version')
    const configFile = join(tempRoot, 'pinned-config.json')
    const stateFile = join(tempRoot, 'pinned-state.json')
    writeFileSync(configFile, '{"autoInject":"pages"}', 'utf8')
    writeFileSync(stateFile, '{"applied":{}}', 'utf8')
    const pin = pinExperimentConfig({ file: configFile, stateFile })
    equal(pin.plugin.version, version.version, 'pin carries the plugin version')
    equal(pin.configHash.length, 64, 'config sha256 recorded')
    equal(verifyPinnedConfig(pin).ok, true, 'an unchanged config verifies')
    writeFileSync(configFile, '{"autoInject":"recall"}', 'utf8')
    const changed = verifyPinnedConfig(pin)
    equal(changed.ok, false, 'a mid-experiment rewrite is detected')
    equal(changed.configChanged, true, 'config flagged as changed')
    includes(changed.problems.join('\n'), 'changed during the experiment', 'problem names the mutation')
  })

  check('the claude-hint wrapper prepends only a non-empty written hint and supports R0/R1/R2 modes', () => {
    equal(hintedPrompt('do the task', ''), 'do the task', 'an empty hint passes the prompt through')
    equal(hintedPrompt('do the task', '   '), 'do the task', 'a blank hint passes the prompt through')
    equal(hintedPrompt('do the task', 'none'), 'do the task', 'R0 none passes the prompt through unchanged')
    equal(
      hintedPrompt('do the task', 'raw-error'),
      'do the task',
      'R1 raw-error is a no-op on attempt 1 when no previous failure exists',
    )
    includes(
      hintedPrompt('do the task', 'raw-error', { prevFailure: 'AssertionError: expected 2 to equal 3 at src/math.js:14:5' }),
      'Previous attempt check output:\nAssertionError',
      'R1 raw-error prepends raw failure output on retry',
    )
    const r2 = hintedPrompt('do the task', 'structured-pitfall', {
      prevFailure: 'AssertionError: expected 2 to equal 3\n    at file:///repo/src/math.js:14:5',
      prevSignature: 'check-exit-1',
    })
    includes(r2, '"protocol": "R2-structured-pitfall"', 'R2 structured-pitfall emits JSON pitfall summary')
    includes(r2, '"locality": "/repo/src/math.js:14:5"', 'R2 extracts POSIX file:line:col locality')
    const r2Win = hintedPrompt('do the task', 'structured-pitfall', {
      prevFailure: 'Error: boom at file:///C:/repo/src/math.js:9:2',
    })
    includes(r2Win, '"locality": "C:/repo/src/math.js:9:2"', 'R2 extracts Windows drive locality')
    equal(
      hintedPrompt('do the task', ' Use cents. '),
      `Use cents.${HINT_SEPARATOR}do the task`,
      'a hint is trimmed and prepended with a separator'
    )
    includes(hintedPrompt('prompt', 'hint'), HINT_SEPARATOR, 'separator keeps the bytes from running together')
  })
}

function runAbCli(args) {
  return new Promise((resolveRun) => {
    const child = spawnNode([AB_FILE, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
    child.on('error', (error) => resolveRun({ status: -1, stdout, stderr: String(error) }))
  })
}

function spawnNode(args) {
  const { spawn } = spawnModule
  return spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

const spawnModule = await import('node:child_process')

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ENV_KEYS = ['HINDSIGHT_API_URL', 'HINDSIGHT_BANK_ID', 'HINDSIGHT_API_TOKEN']
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
for (const key of ENV_KEYS) delete process.env[key]

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-eval-selftest-'))
let setupFailure = null

try {
  const repoDir = join(tempRoot, 'repo')
  const worktreeRoot = join(tempRoot, 'worktrees')
  const { head, previous } = makeGitRepo(repoDir)

  await worktreeChecks(repoDir, head, previous, worktreeRoot)
  await bankChecks(repoDir, tempRoot)
  statsChecks()
  await harnessChecks()
  await abChecks(repoDir, tempRoot)
} catch (error) {
  setupFailure = error
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`eval selftest: could not remove ${tempRoot}: ${error && error.message}\n`)
  }
}

const failures = results.filter((result) => !result.ok)
if (setupFailure) {
  process.stderr.write(`eval selftest: setup failed: ${describeError(setupFailure)}\n`)
}
for (const failure of failures) {
  process.stderr.write(`FAIL ${failure.name}: ${failure.detail}\n`)
}
if (failures.length > 0 || setupFailure) {
  process.stderr.write(
    `eval selftest: ${results.length - failures.length}/${results.length} checks passed\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write(`eval selftest: ${results.length} checks passed\n`)
}
