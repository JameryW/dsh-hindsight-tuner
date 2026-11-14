import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const CLOUD_URL = 'https://api.hindsight.vectorize.io'
const DIAG_PATH = join(homedir(), '.hindsight', 'coding-agents-logs', 'diag.jsonl')
const TAIL_BUDGET = 8 * 1024 * 1024

function truthy(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false'
  return false
}

/**
 * The endpoint and identity the Hindsight integration will actually use, given
 * the shared config and the environment overrides it honours. This mirrors the
 * integration's own resolution so a diagnosis explains real behaviour.
 */
export function effectiveServer(config, env = process.env) {
  const mode = config.serverMode ?? env.HINDSIGHT_SERVER_MODE ?? 'cloud'
  const apiPort = Number(config.apiPort ?? env.HINDSIGHT_API_PORT ?? 9077)
  const configuredUrl = config.apiUrl ?? env.HINDSIGHT_API_URL
  const apiUrl = mode === 'daemon' ? `http://127.0.0.1:${apiPort}` : configuredUrl ?? CLOUD_URL
  const token = config.apiToken ?? env.HINDSIGHT_API_TOKEN
  const disabled = config.disabled === true || truthy(env.HINDSIGHT_DISABLED)
  return {
    mode,
    apiUrl,
    tokenSource: config.apiToken ? 'config' : env.HINDSIGHT_API_TOKEN ? 'env' : null,
    tokenSet: typeof token === 'string' && token.length > 0,
    token,
    disabled,
    bankId: config.bankId ?? null,
    bankTemplate: config.bankIdTemplate ?? 'coding-agent::{gitProject}',
  }
}

/** The bank this repository maps to, matching the integration's template. */
export function bankIdFor(config, repo) {
  if (typeof config.bankId === 'string' && config.bankId.length > 0) return config.bankId
  const template = typeof config.bankIdTemplate === 'string' && config.bankIdTemplate.length > 0
    ? config.bankIdTemplate
    : 'coding-agent::{gitProject}'
  const project = repo ?? 'misc'
  return template
    .replaceAll('{gitProject}', project)
    .replaceAll('{project}', project)
    .replaceAll('{harness}', 'dsh')
}

/** The `{gitProject}` value Hindsight resolves for a directory. */
export function projectName(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (common) {
      const absolute = isAbsolute(common) ? common : resolve(cwd, common)
      const leaf = basename(absolute)
      const name = leaf === '.git' || leaf.endsWith('.git') ? basename(dirname(absolute)) : leaf
      if (name) return { name, source: 'git' }
    }
  } catch {
    // Not a work tree, or git is unavailable: the integration falls back to the
    // directory name, so this report does too.
  }
  return { name: basename(resolve(cwd)) || 'misc', source: 'directory' }
}

/**
 * One authenticated GET against the bank's page tree. This is the cheapest
 * endpoint that distinguishes the three states that matter: reachable, rejected,
 * or unreachable — without writing anything into the user's memory.
 */
export async function probeServer({ apiUrl, apiToken, bankId, timeoutMs = 4000 }) {
  if (typeof fetch !== 'function') return { status: 0, ok: false, error: 'fetch is unavailable in this host' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = `${String(apiUrl).replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bankId)}/pages/tree`
  try {
    const headers = { accept: 'application/json' }
    if (apiToken) headers.authorization = `Bearer ${apiToken}`
    const response = await fetch(url, { headers, signal: controller.signal })
    let detail = ''
    if (!response.ok) detail = (await response.text().catch(() => '')).slice(0, 240)
    return { status: response.status, ok: response.ok, detail, url }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    const code = error?.cause?.code || error?.code || error?.message || String(error)
    return { status: 0, ok: false, error: aborted ? `timed out after ${timeoutMs}ms` : code, url }
  } finally {
    clearTimeout(timer)
  }
}

function readTail(path) {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_BUDGET)
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(handle, buffer, 0, buffer.length, start)
    return buffer.toString('utf8')
  } finally {
    closeSync(handle)
  }
}

/**
 * Aggregate the integration's own diagnostic journal. Only the newest `lines`
 * records are scanned, and nothing outside the requested window is summarised,
 * so a long-lived machine does not turn a status call into a full log read.
 */
export function summarizeActivity({ lines = 500, windowHours = 24, now = Date.now() } = {}) {
  if (!existsSync(DIAG_PATH)) {
    return { path: DIAG_PATH, exists: false, scanned: 0, totals: {}, recent: {}, lastInject: null, lastFailure: null, authFailures: 0 }
  }

  let entries = []
  try {
    const text = readTail(DIAG_PATH)
    for (const line of text.split('\n').slice(-lines)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry && typeof entry === 'object') entries.push(entry)
      } catch {
        // A torn trailing line is expected while another process appends.
      }
    }
  } catch {
    return { path: DIAG_PATH, exists: true, scanned: 0, totals: {}, recent: {}, lastInject: null, lastFailure: null, authFailures: 0, error: 'journal unreadable' }
  }

  const since = now - windowHours * 3_600_000
  const totals = {}
  const recent = {}
  let lastInject = null
  let lastFailure = null
  let authFailures = 0

  for (const entry of entries) {
    const event = typeof entry.event === 'string' ? entry.event : 'other'
    totals[event] = (totals[event] ?? 0) + 1
    const at = Date.parse(entry.ts ?? '')
    const inWindow = Number.isFinite(at) && at >= since
    if (inWindow) {
      recent[event] = (recent[event] ?? 0) + 1
      if (event === 'inject_ok' && Number.isFinite(entry.chars)) {
        lastInject = { chars: entry.chars, tokens: Math.ceil(entry.chars * 0.3), ts: entry.ts }
      }
      if (/_failed$/.test(event)) {
        const message = String(entry.error ?? '')
        if (/401|unauthor|authentication|api key/i.test(message)) authFailures += 1
        lastFailure = { event, error: message.slice(0, 200), ts: entry.ts }
      }
    }
  }

  return { path: DIAG_PATH, exists: true, scanned: entries.length, totals, recent, lastInject, lastFailure, authFailures }
}
