/**
 * Hindsight bank / pages fingerprinting for A/B evaluation.
 *
 * An experiment result is only meaningful when every arm saw the same memory
 * bank. This module resolves the bank id and API URL the same way the plugin
 * does, captures a stable fingerprint of the bank's Pages tree plus its stats,
 * and verifies that fingerprint before (and after) a run.
 *
 * Fingerprint = sha256 of canonical (recursively key-sorted) JSON of
 * `{tree, stats}` with the server's bookkeeping filtered out (see
 * `VOLATILE_STATS` and `VOLATILE_TREE`). It proves the Pages tree's structure and
 * the memory-bearing stats are byte-for-byte identical (after canonicalisation);
 * it says nothing about page bodies, embeddings, or server internals.
 *
 * Endpoints (verified against Hindsight 0.8.x):
 *   GET {apiUrl}/v1/default/banks/{encodeURIComponent(bank)}/pages/tree
 *   GET {apiUrl}/v1/default/banks/{encodeURIComponent(bank)}/knowledge-base/tree
 *       (legacy alias, used only when pages/tree returns 404)
 *   GET {apiUrl}/v1/default/banks/{encodeURIComponent(bank)}/stats
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export const DEFAULT_API_URL = 'http://127.0.0.1:9077'
export const DEFAULT_BANK_TEMPLATE = 'coding-agent::{gitProject}'
export const DEFAULT_TIMEOUT_MS = 15_000
export const FINGERPRINT_FORMAT = 'dsh-hindsight-tuner/bank-fingerprint@2'
export const FINGERPRINT_ALGORITHM = 'sha256(canonical-json({tree,stats-without-operation-counters}))'

/**
 * Bank stats keys that record server bookkeeping, not memory content.
 *
 * They move on their own while a bank is healthy: the page-refresh cron queues
 * operations, maintenance sweeps the ledger, and consolidation records when it
 * last ran. Hashing them made the frozen-bank guard trip on a live bank whose
 * memories and Pages had not changed at all, so they are filtered out of both
 * the digest and the structural diff. Memory-bearing stats (node/link counts,
 * `nodes_by_fact_type`, `total_observations`, …) stay in, and the Pages tree is
 * hashed after dropping only its per-page refresh metadata (see
 * `VOLATILE_TREE`).
 */
const VOLATILE_STATS = new Set([
  'operations_by_status',
  'pending_operations',
  'failed_operations',
  'pending_consolidation',
  'failed_consolidation',
  'last_consolidated_at',
  'last_memory_write_at',
])

/** Stats with the operation bookkeeping removed (shallow copy). */
export function fingerprintStats(stats) {
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) return {}
  const copy = {}
  for (const [key, value] of Object.entries(stats)) {
    if (VOLATILE_STATS.has(key)) continue
    copy[key] = value
  }
  return copy
}

/**
 * Page-tree keys that only record when a page last refreshed.
 *
 * The content of a page is not in the tree at all; these fields move whenever
 * the refresh cron rewrites the page, even when the generated body is
 * unchanged. They are excluded so a page refresh is not mistaken for memory
 * drift. A description/tag/structure change still alters the digest.
 */
const VOLATILE_TREE = new Set(['timestamp', 'is_stale', 'last_refresh_failed_at'])

/** Page tree with per-page refresh metadata removed (deep copy). */
export function fingerprintTree(tree) {
  if (Array.isArray(tree)) return tree.map((entry) => fingerprintTree(entry))
  if (tree === null || typeof tree !== 'object') return tree
  const copy = {}
  for (const [key, value] of Object.entries(tree)) {
    if (VOLATILE_TREE.has(key)) continue
    copy[key] = fingerprintTree(value)
  }
  return copy
}

/** A bank/API problem was detected. */
export class BankError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BankError'
    Object.assign(this, details)
  }
}

/** An HTTP response was received but was not a success. */
export class BankHttpError extends BankError {
  constructor(status, message, details = {}) {
    super(message, { status, ...details })
    this.name = 'BankHttpError'
    this.status = status
  }
}

function envValue(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function quote(value) {
  return JSON.stringify(String(value))
}

function clip(text, limit = 240) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}

function normalizeApiUrl(value) {
  const url = String(value).trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    throw new BankError(
      `invalid apiUrl ${quote(url)}: expected an http(s) URL such as ${DEFAULT_API_URL}`,
    )
  }
  if (/\/v1$/i.test(url)) {
    throw new BankError(`invalid apiUrl ${quote(url)}: pass the server root, without the trailing /v1`)
  }
  return url
}

function normalizeTimeout(timeoutMs) {
  const value = timeoutMs == null ? DEFAULT_TIMEOUT_MS : timeoutMs
  if (!Number.isFinite(value) || value <= 0) {
    throw new BankError(`timeoutMs must be a positive number of milliseconds (got ${JSON.stringify(timeoutMs)})`)
  }
  return Math.trunc(value)
}

/**
 * Resolve API URL, bank id, and token using the same precedence as the plugin:
 * explicit argument > environment > default.
 *
 * Defaults: apiUrl = http://127.0.0.1:9077,
 *           bank   = coding-agent::<basename(repo || cwd || process.cwd())>,
 *           token  = only when provided (argument or HINDSIGHT_API_TOKEN).
 */
export function resolveBank({ apiUrl, bank, token, repo, cwd } = {}) {
  const apiArg = typeof apiUrl === 'string' && apiUrl.trim() ? apiUrl.trim() : null
  const apiEnv = envValue('HINDSIGHT_API_URL')
  const resolvedApiUrl = normalizeApiUrl(apiArg || apiEnv || DEFAULT_API_URL)

  const bankArg = typeof bank === 'string' && bank.trim() ? bank.trim() : null
  const bankEnv = envValue('HINDSIGHT_BANK_ID')
  const projectDir = resolve(repo || cwd || process.cwd())
  const resolvedBank = bankArg || bankEnv || DEFAULT_BANK_TEMPLATE.replace('{gitProject}', basename(projectDir))
  if (!resolvedBank.trim()) {
    throw new BankError('bank id resolved to an empty string; set --bank or HINDSIGHT_BANK_ID')
  }

  const tokenArg = typeof token === 'string' && token.trim() ? token.trim() : null
  const tokenEnv = envValue('HINDSIGHT_API_TOKEN')
  const resolvedToken = tokenArg || tokenEnv || null

  return {
    apiUrl: resolvedApiUrl,
    bank: resolvedBank,
    token: resolvedToken,
    tokenSet: Boolean(resolvedToken),
    source: {
      apiUrl: apiArg ? 'argument' : apiEnv ? 'env' : 'default',
      bank: bankArg ? 'argument' : bankEnv ? 'env' : 'default',
      token: tokenArg ? 'argument' : tokenEnv ? 'env' : 'none',
    },
  }
}

let evalBankCounter = 0

/**
 * Hindsight #6444: a crash-retried setup may delete a newly created bank that
 * reused the old name. Evaluation banks therefore carry a timestamp and a
 * random suffix, making each run's bank unmistakably new. The suffix is
 * deliberately readable (not a UUID) so a cleanup can find all eval banks.
 */
export function uniqueBankId(base, { now = new Date(), random = Math.random } = {}) {
  const name = String(base ?? '').trim()
  if (!name) throw new BankError('uniqueBankId requires a non-empty base bank id')
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new BankError('uniqueBankId received an invalid date')
  const stamp = date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const draw = Number(random())
  const fraction = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 0.999999999999) : 0
  evalBankCounter += 1
  const suffix = Math.floor(fraction * 36 ** 6).toString(36).padStart(6, '0').slice(-6)
  return `${name}--eval-${stamp}-${suffix}${evalBankCounter > 1 ? `-${evalBankCounter}` : ''}`
}

function findCapabilityBoolean(payload, patterns, path = '') {
  if (payload === null || typeof payload !== 'object') {
    if (typeof payload === 'boolean' && patterns.some((pattern) => pattern.test(path))) return payload
    return null
  }
  for (const [key, value] of Object.entries(payload)) {
    const next = path ? `${path}.${key}` : key
    const found = findCapabilityBoolean(value, patterns, next)
    if (found !== null) return found
  }
  return null
}

/**
 * Probe Hindsight v1.2.0's separated query/document embedding path and its
 * Operation Validator. The server has no single stable capability endpoint
 * across versions, so `/health` and `/v1/default/capabilities` are tried in
 * order; an absent field stays `null` (unknown) rather than being reported as
 * unsupported.
 */
export async function probeCapabilities({ apiUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolved = resolveBank({ apiUrl, token })
  const timeout = normalizeTimeout(timeoutMs)
  const attempts = []
  let payload = null
  let usedUrl = null
  for (const path of ['/health', '/v1/default/capabilities']) {
    const url = `${resolved.apiUrl}${path}`
    try {
      const body = await fetchJson(url, { token: resolved.token, timeoutMs: timeout, what: 'capabilities' })
      attempts.push({ url, status: 200, ok: true })
      payload = payload && typeof payload === 'object' && body && typeof body === 'object'
        ? { ...payload, ...body }
        : (payload ?? body)
      usedUrl = usedUrl ?? url
    } catch (error) {
      if (error instanceof BankHttpError && error.status === 404) {
        attempts.push({ url, status: 404, ok: false })
        continue
      }
      return {
        apiUrl: resolved.apiUrl,
        ok: false,
        url: attempts.length > 0 ? attempts[attempts.length - 1].url : url,
        status: error instanceof BankHttpError ? error.status : 0,
        error: clip(error?.message ?? error),
        embedding: { separated: null },
        operationValidator: { available: null },
        attempts,
      }
    }
  }
  if (payload === null) {
    return {
      apiUrl: resolved.apiUrl,
      ok: false,
      url: attempts.length > 0 ? attempts[attempts.length - 1].url : null,
      status: 404,
      error: 'no capability endpoint returned a supported payload',
      embedding: { separated: null },
      operationValidator: { available: null },
      attempts,
    }
  }
  const separateEmbedding = findCapabilityBoolean(payload, [
    /(?:separate[d]?|split|query[._-]?document|query[._-]?and[._-]?document).*embedding/i,
    /embedding.*(?:separate[d]?|split|query[._-]?document|query[._-]?and[._-]?document)/i,
  ])
  const operationValidator = findCapabilityBoolean(payload, [
    /operation[._-]?validator/i,
    /validator.*operation/i,
  ])
  return {
    apiUrl: resolved.apiUrl,
    ok: true,
    url: usedUrl,
    status: 200,
    version: typeof payload?.version === 'string' ? payload.version : null,
    embedding: { separated: separateEmbedding },
    operationValidator: { available: operationValidator },
    attempts,
  }
}

async function fetchJson(url, { token, timeoutMs, what } = {}) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const name = error && error.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new BankError(
        `timed out after ${timeoutMs}ms fetching ${what} from ${url}: is the Hindsight API reachable?`,
        { cause: error },
      )
    }
    const code =
      (error && error.cause && (error.cause.code || error.cause.message)) ||
      (error && error.code) ||
      (error && error.message) ||
      'unknown error'
    throw new BankError(
      `cannot fetch ${what} from ${url}: ${clip(code)}` +
        '; is the Hindsight daemon running? Set --api-url or HINDSIGHT_API_URL.',
      { cause: error },
    )
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    throw new BankError(`could not read the ${what} response from ${url}: ${clip(error && error.message)}`, {
      cause: error,
    })
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? '; check --api-token / HINDSIGHT_API_TOKEN'
        : ''
    throw new BankHttpError(
      response.status,
      `${what} returned HTTP ${response.status} ${response.statusText}${hint} from ${url}` +
        (text ? `: ${clip(text)}` : ''),
      { url, body: text },
    )
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new BankError(`${what} from ${url} is not valid JSON: ${clip(text)}`, { url, body: text })
  }
}

function assertTreeShape(payload, url) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.roots)) {
    throw new BankError(
      `pages tree from ${url} has an unexpected shape: expected a JSON object with a "roots" array`,
      { url },
    )
  }
  return payload
}

function assertStatsShape(payload, url) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BankError(`bank stats from ${url} has an unexpected shape: expected a JSON object`, { url })
  }
  return payload
}

/** Recursively key-sorted JSON string. Arrays keep their order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/** sha256 over canonical JSON of the filtered tree and stats. */
export function fingerprintOf({ tree, stats } = {}) {
  const digest = createHash('sha256')
  digest.update(canonicalJson({ tree: fingerprintTree(tree), stats: fingerprintStats(stats) }), 'utf8')
  return digest.digest('hex')
}

/**
 * Capture the Pages tree and stats of a bank and fingerprint them.
 *
 * @returns {Promise<{apiUrl: string, bankId: string, capturedAt: string,
 *   tree: object, stats: object, fingerprint: string}>}
 */
export async function captureFingerprint({
  apiUrl,
  bank,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  repo,
  cwd,
} = {}) {
  const resolved = resolveBank({ apiUrl, bank, token, repo, cwd })
  const timeout = normalizeTimeout(timeoutMs)
  const bankSegment = encodeURIComponent(resolved.bank)

  const treeUrl = `${resolved.apiUrl}/v1/default/banks/${bankSegment}/pages/tree`
  let tree
  let treeUrlUsed = treeUrl
  try {
    tree = await fetchJson(treeUrl, { token: resolved.token, timeoutMs: timeout, what: 'pages tree' })
  } catch (error) {
    if (!(error instanceof BankHttpError) || error.status !== 404) throw error
    const legacyUrl = `${resolved.apiUrl}/v1/default/banks/${bankSegment}/knowledge-base/tree`
    treeUrlUsed = legacyUrl
    try {
      tree = await fetchJson(legacyUrl, {
        token: resolved.token,
        timeoutMs: timeout,
        what: 'pages tree (legacy alias)',
      })
    } catch (legacyError) {
      if (legacyError instanceof BankHttpError && legacyError.status === 404) {
        throw new BankError(
          `bank ${quote(resolved.bank)} has no Pages tree: both ${treeUrl} and ${legacyUrl} returned HTTP 404.` +
            ' Check --bank / HINDSIGHT_BANK_ID.',
          { cause: legacyError },
        )
      }
      throw legacyError
    }
  }
  assertTreeShape(tree, treeUrlUsed)

  const statsUrl = `${resolved.apiUrl}/v1/default/banks/${bankSegment}/stats`
  const stats = assertStatsShape(
    await fetchJson(statsUrl, { token: resolved.token, timeoutMs: timeout, what: 'bank stats' }),
    statsUrl,
  )

  const fingerprint = fingerprintOf({ tree, stats })
  return {
    format: FINGERPRINT_FORMAT,
    algorithm: FINGERPRINT_ALGORITHM,
    apiUrl: resolved.apiUrl,
    bankId: resolved.bank,
    capturedAt: new Date().toISOString(),
    timeoutMs: timeout,
    tree,
    stats,
    fingerprint,
    source: resolved.source,
  }
}

let tempCounter = 0

/**
 * Atomically write a fingerprint file (pretty JSON, trailing newline).
 * Creates the parent directory when needed.
 */
export function writeFingerprint(file, fingerprint) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('writeFingerprint requires a file path')
  }
  validateFingerprintObject(fingerprint, 'writeFingerprint')
  const target = resolve(file)
  mkdirSync(dirname(target), { recursive: true })
  tempCounter += 1
  const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}-${tempCounter}`
  try {
    writeFileSync(temp, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // The original write error is the meaningful one.
    }
    throw new BankError(`cannot write bank fingerprint ${target}: ${clip(error && error.message)}`, {
      cause: error,
    })
  }
  return target
}

function validateFingerprintObject(fingerprint, context) {
  if (fingerprint === null || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) {
    throw new BankError(`${context}: fingerprint must be an object`)
  }
  if (typeof fingerprint.fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint.fingerprint)) {
    throw new BankError(`${context}: fingerprint.fingerprint must be a sha256 hex digest`)
  }
  if (fingerprint.format != null && fingerprint.format !== FINGERPRINT_FORMAT) {
    throw new BankError(
      `${context}: fingerprint.format ${JSON.stringify(fingerprint.format)} predates ${FINGERPRINT_FORMAT} ` +
        '(operation counters used to be part of the digest); capture a new baseline with --fingerprint-out',
    )
  }
  if (fingerprint.tree === null || typeof fingerprint.tree !== 'object' || Array.isArray(fingerprint.tree)) {
    throw new BankError(`${context}: fingerprint.tree must be an object`)
  }
  if (fingerprint.stats === null || typeof fingerprint.stats !== 'object' || Array.isArray(fingerprint.stats)) {
    throw new BankError(`${context}: fingerprint.stats must be an object`)
  }
  return fingerprint
}

/** Read and validate a fingerprint file. */
export function readFingerprint(file) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('readFingerprint requires a file path')
  }
  const target = resolve(file)
  let text
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    throw new BankError(`cannot read bank fingerprint ${target}: ${clip(error && error.message)}`, {
      cause: error,
    })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BankError(`bank fingerprint ${target} is not valid JSON: ${clip(error && error.message)}`, {
      cause: error,
    })
  }
  validateFingerprintObject(parsed, `bank fingerprint ${target}`)
  if (parsed.bankId != null && typeof parsed.bankId !== 'string') {
    throw new BankError(`bank fingerprint ${target} has a non-string bankId`)
  }
  if (parsed.apiUrl != null) parsed.apiUrl = normalizeApiUrl(parsed.apiUrl)
  return parsed
}

function shortValue(value, limit = 120) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = 'undefined'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function diffValues(path, expected, actual, out, limit) {
  if (out.length >= limit) return
  if (expected === actual) return
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    for (const key of keys) {
      diffValues(`${path}.${key}`, expected[key], actual[key], out, limit)
      if (out.length >= limit) return
    }
    return
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push(`${path}.length: expected ${expected.length}, actual ${actual.length}`)
    }
    const shared = Math.min(expected.length, actual.length)
    for (let index = 0; index < shared; index += 1) {
      diffValues(`${path}[${index}]`, expected[index], actual[index], out, limit)
      if (out.length >= limit) return
    }
    return
  }
  out.push(`${path}: expected ${shortValue(expected)}, actual ${shortValue(actual)}`)
}

/**
 * Re-capture the bank and compare it to a frozen fingerprint.
 *
 * @param {object|string} expected captured fingerprint object or fingerprint file path
 * @param {{apiUrl?: string, bank?: string, token?: string, timeoutMs?: number,
 *          maxDiffs?: number, repo?: string, cwd?: string}} [opts]
 * @returns {Promise<{ok: boolean, actual: object, expectedFingerprint: string, diffs: string[]}>}
 */
export async function verifyFingerprint(expected, opts = {}) {
  const frozen = typeof expected === 'string' ? readFingerprint(expected) : validateFingerprintObject(expected, 'verifyFingerprint')
  const maxDiffs =
    Number.isFinite(opts.maxDiffs) && opts.maxDiffs > 0 ? Math.trunc(opts.maxDiffs) : 20
  const actual = await captureFingerprint({
    apiUrl: opts.apiUrl ?? frozen.apiUrl,
    bank: opts.bank ?? frozen.bankId,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? frozen.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    repo: opts.repo,
    cwd: opts.cwd,
  })

  const diffs = []
  if (frozen.apiUrl && normalizeApiUrl(frozen.apiUrl) !== actual.apiUrl) {
    diffs.push(`apiUrl: expected ${frozen.apiUrl}, actual ${actual.apiUrl}`)
  }
  if (frozen.bankId && frozen.bankId !== actual.bankId) {
    diffs.push(`bankId: expected ${frozen.bankId}, actual ${actual.bankId}`)
  }
  if (frozen.fingerprint === actual.fingerprint) {
    return { ok: diffs.length === 0, actual, expectedFingerprint: frozen.fingerprint, diffs }
  }

  const structural = []
  diffValues('tree', fingerprintTree(frozen.tree), fingerprintTree(actual.tree), structural, maxDiffs)
  diffValues('stats', fingerprintStats(frozen.stats), fingerprintStats(actual.stats), structural, maxDiffs)
  if (structural.length > 0) {
    diffs.push(...structural)
  } else {
    diffs.push(
      'fingerprint: expected ' +
        `${frozen.fingerprint}, actual ${actual.fingerprint} (no structural difference found; ` +
        'the fingerprint file may predate the canonicalisation algorithm)',
    )
  }
  return { ok: diffs.length === 0, actual, expectedFingerprint: frozen.fingerprint, diffs }
}

/**
 * Verify a frozen fingerprint and throw a precise, actionable error on drift.
 * Returns the fresh capture on success (so callers can persist it).
 */
export async function assertFrozen(expected, opts = {}) {
  const result = await verifyFingerprint(expected, opts)
  if (!result.ok) {
    const frozen = typeof expected === 'string' ? expected : expected && expected.fingerprint
    const lines = [
      `Hindsight bank fingerprint changed for bank ${quote(result.actual.bankId)} at ${result.actual.apiUrl}:`,
      `  frozen: ${frozen}`,
      `  actual: ${result.actual.fingerprint}`,
      `  differences (${result.diffs.length} shown):`,
      ...result.diffs.map((diff) => `    - ${diff}`),
      'The bank changed between captures; reset it to the frozen snapshot (or capture a new',
      'baseline with --fingerprint-out) and re-run. Never compare arms measured on different banks.',
    ]
    throw new BankError(lines.join('\n'), { diffs: result.diffs, actual: result.actual })
  }
  return result.actual
}
