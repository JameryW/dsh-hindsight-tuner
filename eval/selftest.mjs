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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BankError,
  assertFrozen,
  canonicalJson,
  captureFingerprint,
  fingerprintOf,
  readFingerprint,
  resolveBank,
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
  mulberry32,
  pairedComparison,
  summarizeArm,
} from './stats.mjs'
import {
  WorktreeError,
  baseShaOf,
  createWorktree,
  disposeWorktree,
  repoRootOf,
  verifyWorktree,
  withWorktree,
} from './worktree.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const AB_FILE = join(HERE, 'ab.mjs')
const { parseArgs, readTasks, readPrices, resolveArms, parseUsage } = await import('./ab.mjs')

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
async function startFakeBank({ bank, legacyOnly = false, stats } = {}) {
  const state = {
    bank,
    legacyOnly,
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
    equal(repoRootOf(repoDir), resolve(repoDir), 'repoRootOf')
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
      equal(handle.repo, resolve(repoDir), 'handle.repo')
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
    equal(parsed.dryRun, true, 'dry-run')

    const disabled = parseArgs([
      '--tasks',
      't.json',
      '--reset-between-attempts',
      '--no-reset-between-attempts',
    ])
    equal(disabled.resetBetweenAttempts, false, 'no-reset wins when last')
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
          },
          {
            id: 'impl',
            prompt: 'implement the export',
            cwd: repoDir,
            check: { command: 'node', args: ['-e', 'process.exit(0)'] },
            checkCwd: 'sub',
          },
          {
            id: 'stringcheck',
            prompt: 'string check form',
            cwd: repoDir,
            check: 'node script.js --flag',
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
  })

  check('readPrices normalizes a price file', () => {
    const pricesFile = join(tempRoot, 'prices.json')
    writeFileSync(pricesFile, JSON.stringify({ inputPerMTok: 3, outputPerMTok: 15 }), 'utf8')
    const prices = readPrices(pricesFile)
    equal(prices.inputPerMTok, 3, 'input price')
    equal(prices.outputPerMTok, 15, 'output price')
    equal(prices.cacheReadPerMTok, 0, 'missing price defaults to zero')
  })

  check('parseUsage reads the last JSON line and Claude usage shapes', () => {
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
    equal(plan.tasks[0].repo, resolve(repoDir), 'repo recorded')
    equal(plan.bank.apiUrl, 'http://127.0.0.1:9077', 'bank api url')
    equal(plan.bank.bankId, `coding-agent::${basename(repoDir)}`, 'bank id')
    equal(plan.bank.verify, null, 'no fingerprint verification')
    equal(plan.bank.fingerprintOut, null, 'no fingerprint capture')
    equal(plan.reportFile, null, 'no report written')
    equal(plan.prices, null, 'no prices')
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
