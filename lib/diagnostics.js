import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const CLOUD_URL = 'https://api.hindsight.vectorize.io'
const TAIL_BUDGET = 8 * 1024 * 1024

/**
 * Environment variables the Hindsight integration honours. Keeping the list
 * here lets the tuner show the value that will actually be used instead of the
 * file value it happens to find.
 */
export const ENV_KEYS = {
  autoInject: 'HINDSIGHT_AUTO_INJECT',
  pageSearchLimit: 'HINDSIGHT_PAGE_SEARCH_LIMIT',
  injectTimeoutMs: 'HINDSIGHT_INJECT_TIMEOUT_MS',
  serverMode: 'HINDSIGHT_SERVER_MODE',
  apiPort: 'HINDSIGHT_API_PORT',
  apiUrl: 'HINDSIGHT_API_URL',
  apiToken: 'HINDSIGHT_API_TOKEN',
  bankId: 'HINDSIGHT_BANK_ID',
  bankIdTemplate: 'HINDSIGHT_BANK_ID_TEMPLATE',
  dynamicBankId: 'HINDSIGHT_DYNAMIC_BANK_ID',
  disabled: 'HINDSIGHT_DISABLED',
  observationScopes: 'HINDSIGHT_OBSERVATION_SCOPES',
  autoSeed: 'HINDSIGHT_AUTO_SEED',
  seedLimit: 'HINDSIGHT_SEED_LIMIT',
}

const NUMERIC_KEYS = new Set(['pageSearchLimit', 'injectTimeoutMs', 'apiPort', 'seedLimit'])
const BOOLEAN_KEYS = new Set(['dynamicBankId', 'disabled', 'autoSeed'])

function coerce(key, value) {
  if (value === undefined || value === null || value === '') return undefined
  if (NUMERIC_KEYS.has(key)) {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value
    return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
  }
  return value
}

function mergeLayer(base, layer) {
  const merged = { ...base }
  if (!layer || typeof layer !== 'object') return merged
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'harnesses') continue
    if ((key === 'banks' || key === 'paths') && value && typeof value === 'object') {
      merged[key] = { ...(base?.[key] ?? {}), ...value }
      continue
    }
    merged[key] = value
  }
  return merged
}

/**
 * Keys a `paths`/`banks` section may not override: the integration strips them
 * before applying a section, because they decide which section applies at all.
 */
const SECTION_EXCLUDED = new Set([
  'bank', 'banks', 'paths', 'optInOnly', 'optInPaths', 'mapPathToBank',
  'dynamicBankId', 'resolveWorktrees', 'harness',
])

/** The longest directory key in a `paths` map that contains `cwd`. */
function sectionAt(map, cwd) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const target = normalizePath(resolve(cwd))
  let best = null
  for (const [key, value] of Object.entries(map)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const prefix = normalizePath(key)
    if (!prefix) continue
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, key, value }
    }
  }
  return best
}

function stripSection(section) {
  const output = { ...section }
  for (const key of SECTION_EXCLUDED) delete output[key]
  return output
}

/**
 * Resolve the config the integration will actually read: environment layer
 * first, then the shared file, then the `harnesses.dsh` override, then the
 * `paths.<directory>` and `banks.<id>` sections — the same precedence as the
 * upstream loader. `harnesses` itself is stripped.
 */
export function effectiveConfig(config, { env = process.env, harness = 'dsh', cwd, bank } = {}) {
  const envLayer = {}
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    const value = coerce(key, env?.[name])
    if (value !== undefined) envLayer[key] = value
  }
  const base = mergeLayer(envLayer, config)
  const perHarness = config?.harnesses?.[harness]
  let merged = mergeLayer(base, perHarness)
  const sections = []
  if (cwd) {
    const hit = sectionAt(config?.paths, cwd)
    if (hit) {
      merged = mergeLayer(merged, stripSection(hit.value))
      sections.push(`paths.${hit.key}`)
    }
  }
  if (bank) {
    const section = config?.banks?.[bank]
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      merged = mergeLayer(merged, stripSection(section))
      sections.push(`banks.${bank}`)
    }
  }
  return {
    config: merged,
    envKeys: Object.keys(envLayer),
    harnessKeys: perHarness && typeof perHarness === 'object' ? Object.keys(perHarness) : [],
    fileKeys: config && typeof config === 'object' ? Object.keys(config) : [],
    sections,
  }
}

function truthy(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== '0' && value.toLowerCase() !== 'false'
  return false
}

/**
 * The endpoint and identity the Hindsight integration will actually use, given
 * the effective config and any remaining environment overrides. This mirrors the
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

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * A `{gitProject}` value as the integration resolves it. Templates may also use
 * `{project}`, `{harness}`, `{channel}`, and `{user}`.
 */
export function expandBankTemplate(template, { repo, cwd } = {}) {
  const project = repo ?? (cwd ? basename(resolve(cwd)) : 'misc')
  return String(template)
    .replaceAll('{gitProject}', project)
    .replaceAll('{project}', project)
    .replaceAll('{harness}', 'dsh')
    .replaceAll('{channel}', 'dsh')
    .replaceAll('{user}', process.env.USERNAME || process.env.USER || 'user')
}

/** The longest `mapPathToBank` prefix that contains `cwd`, if any. */
function mappedBank(config, cwd) {
  const map = config?.mapPathToBank
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const target = normalizePath(resolve(cwd ?? '.'))
  let best = null
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string' || value.length === 0) continue
    const prefix = normalizePath(key)
    if (!prefix) continue
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.length) best = { length: prefix.length, value }
    }
  }
  return best?.value ?? null
}

/**
 * The bank this repository maps to, and why: an explicit path mapping wins,
 * then a static `bankId`, otherwise the template.
 */
export function bankResolution(config, repo, cwd = process.cwd()) {
  const direct = mappedBank(config, cwd)
  const base = direct
    ? { bank: direct, source: 'mapPathToBank' }
    : contractBank(config, repo, cwd)
  const section = config?.banks?.[base.bank]
  if (section && typeof section === 'object' && typeof section.bank === 'string' && section.bank) {
    return { bank: section.bank, source: 'bankSection', base: base.bank }
  }
  return base
}

function contractBank(config, repo, cwd) {
  const dynamic = config?.dynamicBankId ?? !config?.bankId
  if (!dynamic && typeof config.bankId === 'string' && config.bankId.length > 0) {
    return { bank: config.bankId, source: 'bankId' }
  }
  const template = typeof config?.bankIdTemplate === 'string' && config.bankIdTemplate.length > 0
    ? config.bankIdTemplate
    : 'coding-agent::{gitProject}'
  return { bank: expandBankTemplate(template, { repo, cwd }), source: 'bankIdTemplate' }
}

/**
 * Whether `optInOnly` keeps this directory out of the memory lane. The
 * integration answers this before it resolves a bank, so a status that ignores
 * it would claim a working lane that never injects.
 */
export function optedOut(config, cwd = process.cwd()) {
  if (!config?.optInOnly) return false
  const target = normalizePath(resolve(cwd))
  const paths = Array.isArray(config.optInPaths) ? config.optInPaths : []
  const listed = paths.some((entry) => {
    if (!entry) return false
    const prefix = normalizePath(resolve(String(entry)))
    return target === prefix || target.startsWith(`${prefix}/`)
  })
  if (listed) return false
  return !mappedBank(config, cwd)
}

/** Backwards-compatible string-only lookup. */
export function bankIdFor(config, repo, cwd) {
  return bankResolution(config, repo, cwd).bank
}

const MEMORY_BUNDLE = /^(@vectorize-io\/hindsight-coding-agents|dsh-mnemon(-|$))/

function classifyBundle(name) {
  if (name === '@vectorize-io/hindsight-coding-agents') return 'memory'
  if (MEMORY_BUNDLE.test(name)) return 'memory'
  if (name === 'billion-context') return 'compression'
  if (name === 'dsh-context') return 'context'
  return null
}

/**
 * Memory-related bundles the profile declares, with their version and whether
 * their patch is in the active bundle list. This is how a stacked memory setup
 * becomes visible: the tuner itself only owns the Hindsight lane.
 */
export function installedBundles(env = process.env) {
  const roots = []
  if (env.DSH_PROFILE_DIR) roots.push(env.DSH_PROFILE_DIR)
  if (env.DSH_HOME && env.DSH_PROFILE) roots.push(join(env.DSH_HOME, 'profiles', env.DSH_PROFILE))

  const profile = roots.find((root) => existsSync(join(root, 'package.json')))
  if (!profile) return { profile: null, bundles: [] }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  } catch {
    return { profile, bundles: [] }
  }

  const enabled = new Set(Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [])
  const bundles = []
  for (const [name, version] of Object.entries(manifest?.dependencies ?? {})) {
    const kind = classifyBundle(name)
    if (kind) bundles.push({ name, version: String(version), kind, enabled: enabled.has(name) })
  }
  return { profile, bundles }
}

/** The `{gitProject}` value Hindsight resolves for a directory. */
const projectCache = new Map()
const PROJECT_TTL_MS = 5000
const PROJECT_CACHE_SIZE = 10

export function projectName(cwd) {
  const directory = resolve(cwd)
  const hit = projectCache.get(directory)
  if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.value

  let value = { name: basename(directory) || 'misc', source: 'directory' }
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (common) {
      const absolute = isAbsolute(common) ? common : resolve(directory, common)
      const leaf = basename(absolute)
      const name = leaf === '.git' || leaf.endsWith('.git') ? basename(dirname(absolute)) : leaf
      if (name) value = { name, source: 'git' }
    }
  } catch {
    // Not a work tree, or git is unavailable: the integration falls back to the
    // directory name, so this report does too.
  }

  projectCache.set(directory, { at: Date.now(), value })
  if (projectCache.size > PROJECT_CACHE_SIZE) {
    projectCache.delete(projectCache.keys().next().value)
  }
  return value
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

/** The diagnostic journal path, honouring the integration's own override. */
export function diagPath() {
  return process.env.HINDSIGHT_DIAG_FILE || join(homedir(), '.hindsight', 'coding-agents-logs', 'diag.jsonl')
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

function diagStatKey() {
  try {
    const stat = statSync(diagPath())
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

let activityCache = null
const ACTIVITY_TTL_MS = 5000

/**
 * Aggregate the integration's own diagnostic journal. Only the newest `lines`
 * records are scanned, and nothing outside the requested window is summarised,
 * so a long-lived machine does not turn a status call into a full log read.
 * Repeated calls reuse the parse until the journal changes or the TTL expires.
 */
export function summarizeActivity(options = {}) {
  const { lines = 500, windowHours = 24, now = Date.now() } = options
  const cacheable = lines === 500 && windowHours === 24 && options.now === undefined
  const key = cacheable ? diagStatKey() : null
  if (key !== null && activityCache && activityCache.key === key && Date.now() - activityCache.at < ACTIVITY_TTL_MS) {
    return activityCache.value
  }

  const value = computeActivity(lines, windowHours, now)
  if (key !== null) activityCache = { key, at: Date.now(), value }
  return value
}

function computeActivity(lines, windowHours, now) {
  const path = diagPath()
  if (!existsSync(path)) {
    return { path, exists: false, scanned: 0, totals: {}, recent: {}, lastInject: null, lastFailure: null, authFailures: 0 }
  }

  let entries = []
  try {
    const text = readTail(path)
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
    return { path, exists: true, scanned: 0, totals: {}, recent: {}, lastInject: null, lastFailure: null, authFailures: 0, error: 'journal unreadable' }
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

  return { path, exists: true, scanned: entries.length, totals, recent, lastInject, lastFailure, authFailures }
}
