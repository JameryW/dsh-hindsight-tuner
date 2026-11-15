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
  serverMode: 'HINDSIGHT_SERVER_MODE',
  apiUrl: 'HINDSIGHT_API_URL',
  apiToken: 'HINDSIGHT_API_TOKEN',
  apiPort: 'HINDSIGHT_API_PORT',
  daemonIdleTimeout: 'HINDSIGHT_DAEMON_IDLE_TIMEOUT',
  embedVersion: 'HINDSIGHT_EMBED_VERSION',
  embedPackagePath: 'HINDSIGHT_EMBED_PACKAGE_PATH',
  daemonProfile: 'HINDSIGHT_DAEMON_PROFILE',
  bankId: 'HINDSIGHT_BANK_ID',
  dynamicBankId: 'HINDSIGHT_DYNAMIC_BANK_ID',
  bankIdTemplate: 'HINDSIGHT_BANK_ID_TEMPLATE',
  resolveWorktrees: 'HINDSIGHT_RESOLVE_WORKTREES',
  optInOnly: 'HINDSIGHT_OPT_IN_ONLY',
  optInPaths: 'HINDSIGHT_OPT_IN_PATHS',
  harness: 'HINDSIGHT_HARNESS',
  disabled: 'HINDSIGHT_DISABLED',
  retainSessions: 'HINDSIGHT_RETAIN_SESSIONS',
  maxParallelRetains: 'HINDSIGHT_MAX_PARALLEL_RETAINS',
  reflectTimeoutMs: 'HINDSIGHT_REFLECT_TIMEOUT_MS',
  reflectToolTimeoutMs: 'HINDSIGHT_REFLECT_TOOL_TIMEOUT_MS',
  injectTimeoutMs: 'HINDSIGHT_INJECT_TIMEOUT_MS',
  reflectBudget: 'HINDSIGHT_REFLECT_BUDGET',
  autoInject: 'HINDSIGHT_AUTO_INJECT',
  pageSearchLimit: 'HINDSIGHT_PAGE_SEARCH_LIMIT',
  toolGuideExtra: 'HINDSIGHT_TOOL_GUIDE_EXTRA',
  autoReflect: 'HINDSIGHT_AUTO_REFLECT',
  pageRefreshEveryTurns: 'HINDSIGHT_PAGE_REFRESH_EVERY_TURNS',
  pageTriggerType: 'HINDSIGHT_PAGE_TRIGGER_TYPE',
  pageTriggerCron: 'HINDSIGHT_PAGE_TRIGGER_CRON',
  autoSeed: 'HINDSIGHT_AUTO_SEED',
  seedLimit: 'HINDSIGHT_SEED_LIMIT',
  codebaseSurvey: 'HINDSIGHT_CODEBASE_SURVEY',
  surveyModel: 'HINDSIGHT_SURVEY_MODEL',
  surveyBudgetUsd: 'HINDSIGHT_SURVEY_BUDGET_USD',
  surveyRefreshCommits: 'HINDSIGHT_SURVEY_REFRESH_COMMITS',
  logLevel: 'HINDSIGHT_LOG_LEVEL',
  autoUpdate: 'HINDSIGHT_AUTO_UPDATE',
  gitIngest: 'HINDSIGHT_GIT_INGEST',
  // Scalar modes only; an explicit scope list is file-only upstream.
  observationScopes: 'HINDSIGHT_OBSERVATION_SCOPES',
  retainTags: 'HINDSIGHT_RETAIN_TAGS',
  manageBankConfig: 'HINDSIGHT_MANAGE_BANK_CONFIG',
  retainExtractionMode: 'HINDSIGHT_RETAIN_EXTRACTION_MODE',
}

const NUMERIC_KEYS = new Set([
  'pageSearchLimit', 'injectTimeoutMs', 'apiPort', 'seedLimit', 'daemonIdleTimeout',
  'reflectTimeoutMs', 'reflectToolTimeoutMs', 'maxParallelRetains', 'pageRefreshEveryTurns',
  'surveyBudgetUsd', 'surveyRefreshCommits',
])
const BOOLEAN_KEYS = new Set([
  'dynamicBankId', 'disabled', 'autoSeed', 'resolveWorktrees', 'optInOnly',
  'retainSessions', 'autoReflect', 'codebaseSurvey', 'autoUpdate', 'manageBankConfig',
])
const LIST_KEYS = new Set(['optInPaths', 'retainTags'])

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
  if (LIST_KEYS.has(key)) {
    if (Array.isArray(value)) return value
    return String(value).split(',').map((item) => item.trim()).filter(Boolean)
  }
  return value
}

function mergeLayer(base, layer) {
  const merged = { ...base }
  if (!layer || typeof layer !== 'object') return merged
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'harnesses') continue
    if ((key === 'banks' || key === 'paths' || key === 'recallOptions') && value && typeof value === 'object' && !Array.isArray(value)) {
      const prev = base?.[key]
      merged[key] = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev, ...value } : { ...value }
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
    const prefix = normalizePath(resolvePathKey(key))
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
  let pathSection = null
  let bankSection = null
  if (cwd) {
    const hit = sectionAt(config?.paths, cwd)
    if (hit) {
      pathSection = stripSection(hit.value)
      merged = mergeLayer(merged, pathSection)
      sections.push(`paths.${hit.key}`)
    }
  }
  if (bank) {
    const section = config?.banks?.[bank]
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      bankSection = stripSection(section)
      merged = mergeLayer(merged, bankSection)
      sections.push(`banks.${bank}`)
    }
  }
  const configOverridesToken = [config, perHarness, pathSection, bankSection].some(
    (layer) => layer && typeof layer === 'object' && Object.prototype.hasOwnProperty.call(layer, 'apiToken') && layer.apiToken !== undefined,
  )
  const tokenSource = typeof merged.apiToken === 'string' && merged.apiToken.length > 0
    ? (configOverridesToken ? 'config' : 'env')
    : null
  return {
    config: merged,
    envKeys: Object.keys(envLayer),
    harnessKeys: perHarness && typeof perHarness === 'object' ? Object.keys(perHarness) : [],
    fileKeys: config && typeof config === 'object' ? Object.keys(config) : [],
    sections,
    tokenSource,
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
export function effectiveServer(config, env = process.env, options = {}) {
  const mode = config.serverMode ?? env.HINDSIGHT_SERVER_MODE ?? 'cloud'
  const apiPort = Number(config.apiPort ?? env.HINDSIGHT_API_PORT ?? 9077)
  const configuredUrl = config.apiUrl ?? env.HINDSIGHT_API_URL
  const apiUrl = mode === 'daemon' ? `http://127.0.0.1:${apiPort}` : configuredUrl ?? CLOUD_URL
  const token = config.apiToken ?? env.HINDSIGHT_API_TOKEN
  const tokenSet = typeof token === 'string' && token.length > 0
  const disabled = config.disabled === true || truthy(env.HINDSIGHT_DISABLED)
  const tokenSource = !tokenSet
    ? null
    : options.tokenSource
      ? options.tokenSource
      : config.apiToken ? 'config' : env.HINDSIGHT_API_TOKEN ? 'env' : null
  return {
    mode,
    apiUrl,
    tokenSource,
    tokenSet,
    token,
    disabled,
    bankId: config.bankId ?? null,
    bankTemplate: config.bankIdTemplate ?? 'coding-agent::{gitProject}',
  }
}

function resolvePathKey(key) {
  const raw = String(key ?? '')
  if (!raw) return ''
  if (/^[a-zA-Z]:[/\\]/.test(raw)) return raw
  const expanded = raw === '~'
    ? homedir()
    : (raw.startsWith('~/') || raw.startsWith('~\\')) ? join(homedir(), raw.slice(2)) : raw
  return resolve(expanded)
}

function normalizePath(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/\/+$/, '')
  if (process.platform === 'win32' || process.platform === 'darwin' || /^[a-zA-Z]:\//.test(normalized)) {
    return normalized.toLowerCase()
  }
  return normalized
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
    const prefix = normalizePath(resolvePathKey(key))
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
    const prefix = normalizePath(resolvePathKey(String(entry)))
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
  for (const [name, declared] of Object.entries(manifest?.dependencies ?? {})) {
    const kind = classifyBundle(name)
    if (!kind) continue
    // The manifest usually holds a range ("^0.1.213"); the installed tree holds
    // the version actually running, which is what a diagnosis should report.
    let version = null
    try {
      const installed = JSON.parse(readFileSync(join(profile, 'node_modules', name, 'package.json'), 'utf8'))
      if (typeof installed?.version === 'string' && installed.version) version = installed.version
    } catch {
      // A bundle declared but not installed: the declared range is the best fact.
    }
    bundles.push({
      name,
      version: version ?? String(declared),
      declared: String(declared),
      installed: version !== null,
      kind,
      enabled: enabled.has(name),
    })
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
      const name = leaf === '.git' ? basename(dirname(absolute)) : leaf.endsWith('.git') ? leaf.slice(0, -4) : leaf
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
  if (size === 0) return ''
  const start = Math.max(0, size - TAIL_BUDGET)
  const length = size - start
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let total = 0
    while (total < length) {
      const bytesRead = readSync(handle, buffer, total, length - total, start + total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const text = buffer.toString('utf8', 0, total)
    if (start > 0) {
      // Drop any partial UTF-8 character or split first JSONL line at the tail boundary.
      const firstNewline = text.indexOf('\n')
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text
  } finally {
    closeSync(handle)
  }
}

function diagStatKey() {
  try {
    const path = diagPath()
    const stat = statSync(path, { bigint: true })
    // Size plus mtime alone can collide when a test or another writer replaces
    // the file within one clock tick; hashing the tail makes the cache key
    // change with the content, without re-parsing the whole journal.
    const length = Math.min(256, Number(stat.size))
    let hash = 2166136261
    if (length > 0) {
      const fd = openSync(path, 'r')
      try {
        const buffer = Buffer.alloc(length)
        const bytesRead = readSync(fd, buffer, 0, length, Number(stat.size) - length)
        for (const byte of buffer.subarray(0, bytesRead)) hash = Math.imul(hash ^ byte, 16777619) >>> 0
      } finally {
        closeSync(fd)
      }
    }
    return `${stat.size}:${stat.mtimeNs}:${hash}`
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
  const { lines = 500, windowHours = 24, now = Date.now(), harness = 'dsh', expectedOrigin = null } = options
  const cacheable = lines === 500 && windowHours === 24 && options.now === undefined
  const key = cacheable ? `${diagStatKey()}:${harness ?? '*'}:${expectedOrigin ?? ''}` : null
  if (key !== null && activityCache && activityCache.key === key && Date.now() - activityCache.at < ACTIVITY_TTL_MS) {
    return activityCache.value
  }

  const value = computeActivity(lines, windowHours, now, { harness, expectedOrigin })
  if (key !== null) activityCache = { key, at: Date.now(), value }
  return value
}

const SUCCESS_EVENTS = new Set(['inject_ok', 'inject_pages', 'pages_ok', 'retain_ok', 'reflect_ok'])

function readMatchingTailEntries(path, limit, harness) {
  const text = readTail(path)
  const collected = []
  let end = text.length
  while (end > 0 && collected.length < limit) {
    const nl = text.lastIndexOf('\n', end - 1)
    const start = nl + 1
    const line = text.slice(start, end).trim()
    end = nl
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (!entry || typeof entry !== 'object') continue
      if (harness && typeof entry.harness === 'string' && entry.harness !== harness) continue
      collected.push(entry)
    } catch {
      // A torn line at the tail or buffer boundary is expected while another process appends.
    }
  }
  collected.reverse()
  return collected
}

function computeActivity(lines, windowHours, now, { harness = 'dsh', expectedOrigin = null } = {}) {
  const empty = {
    path: diagPath(),
    exists: false,
    scanned: 0,
    totals: {},
    recent: {},
    lastInject: null,
    lastSuccess: null,
    lastFailure: null,
    authFailures: 0,
    injectSizes: [],
    lastEndpoint: null,
    lastBank: null,
    foreignFailures: 0,
    banks: {},
    pages: { events: 0, total: 0, max: 0 },
  }

  if (!empty.path || !existsSync(empty.path)) return empty
  const path = empty.path

  let entries
  try {
    entries = readMatchingTailEntries(path, lines, harness)
  } catch {
    return { ...empty, exists: true, error: 'journal unreadable' }
  }

  const since = now - windowHours * 3_600_000
  const totals = {}
  const recent = {}
  let lastInject = null
  let lastSuccess = null
  let lastSuccessAt = -Infinity
  let lastFailure = null
  let lastEndpoint = null
  let lastBank = null
  let authFailures = 0
  let foreignFailures = 0
  let scanned = 0
  const injectSizes = []
  const banks = {}
  const pages = { events: 0, total: 0, max: 0 }

  for (const entry of entries) {
    // The journal is shared by every harness that uses this Hindsight install;
    // another harness's failures say nothing about this process.
    if (harness && typeof entry.harness === 'string' && entry.harness !== harness) continue
    scanned += 1
    const event = typeof entry.event === 'string' ? entry.event : 'other'
    totals[event] = (totals[event] ?? 0) + 1
    const at = Date.parse(entry.ts ?? '')
    const inWindow = Number.isFinite(at) && at >= since
    if (inWindow) {
      recent[event] = (recent[event] ?? 0) + 1
      if (SUCCESS_EVENTS.has(event) && at >= lastSuccessAt) {
        lastSuccessAt = at
        lastSuccess = { event, ts: entry.ts }
      }
      if (event === 'inject_pages' && Number.isFinite(entry.count)) {
        // Pages injection is the other budget: the journal records how many
        // pages a turn actually carried, which is how a binding
        // pageSearchLimit can be told apart from an idle one.
        pages.events += 1
        pages.total += entry.count
        pages.max = Math.max(pages.max, entry.count)
      }
      if (event === 'inject_ok' && Number.isFinite(entry.chars)) {
        lastInject = { chars: entry.chars, tokens: Math.ceil(entry.chars * 0.3), ts: entry.ts }
        if (injectSizes.length < 100) injectSizes.push(entry.chars)
      }
      if (/_failed$/.test(event)) {
        const message = String(entry.error ?? '')
        if (/401|unauthor|authentication|api key/i.test(message)) authFailures += 1
        // The error text carries the request URL, which is how a status can tell
        // that the running process still targets a different server.
        const endpoint = endpointOf(message)
        lastFailure = { event, error: message.slice(0, 200), ts: entry.ts, endpoint }
        lastEndpoint = endpoint
        if (endpoint && expectedOrigin && !sameOrigin(endpoint, expectedOrigin)) foreignFailures += 1
        const bank = bankOf(message)
        if (bank) {
          lastBank = bank
          // Which banks are actually addressed: a mixed history is evidence of
          // a routing change (or a second harness sharing the install).
          banks[bank] = (banks[bank] ?? 0) + 1
        }
      }
    }
  }

  return {
    path,
    exists: true,
    scanned,
    totals,
    recent,
    lastInject,
    lastSuccess,
    lastFailure,
    authFailures,
    injectSizes,
    lastEndpoint,
    lastBank,
    foreignFailures,
    banks,
    pages,
  }
}

/** Whether two URLs name the same scheme/host/port. */
function sameOrigin(left, right) {
  try {
    return new URL(String(left)).origin.toLowerCase() === new URL(String(right)).origin.toLowerCase()
  } catch {
    return String(left).replace(/\/+$/, '').toLowerCase() === String(right).replace(/\/+$/, '').toLowerCase()
  }
}

/** Origin of the first URL in an error message. */
function endpointOf(message) {
  const match = /(https?:\/\/[^\s/>)"'\]]+)/.exec(message)
  if (!match) return null
  const raw = match[1].replace(/[.,;:)"'\]]+$/, '')
  try {
    return new URL(raw).origin
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

/** The bank id in a `/banks/<id>/...` request path. */
function bankOf(message) {
  const match = /\/banks\/([^/\s?#]+)/.exec(message)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}
