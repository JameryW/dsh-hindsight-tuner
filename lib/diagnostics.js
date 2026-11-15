import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
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

/**
 * One environment variable as the upstream loader reads it: a blank value is
 * ignored, a boolean is only true for `1`/`true`/`yes`/`on` (anything else,
 * including a typo, is false), a non-numeric number is dropped, and an empty
 * list is not a list. Reporting the coerced value keeps `status` from claiming
 * an override the integration silently discarded.
 */
function coerce(key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  if (NUMERIC_KEYS.has(key)) {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
  }
  if (LIST_KEYS.has(key)) {
    if (Array.isArray(value)) return value
    const items = String(value).split(',').map((item) => item.trim()).filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  return value
}

/**
 * One layer over another, exactly as the upstream loader merges raw config
 * (`mergeRaw`): every key is replaced, and only `banks` and `paths` are merged
 * one level deep. Everything else — `recallOptions` included — is replaced
 * wholesale, so a per-harness `recallOptions` drops the file's copy instead of
 * blending it.
 */
function mergeLayer(base, layer) {
  const merged = { ...base }
  if (!layer || typeof layer !== 'object') return merged
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'harnesses') continue
    merged[key] = value
  }
  for (const key of ['banks', 'paths']) {
    const next = layer[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) continue
    const prev = base?.[key]
    merged[key] = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev, ...next } : { ...next }
  }
  return merged
}

/**
 * Keys a `paths`/`banks` section may not override: the integration strips them
 * before applying a section, because they decide which section applies at all —
 * a section may rename the bank with `bank`, but not change which bank is
 * derived in the first place.
 */
const SECTION_EXCLUDED = new Set([
  'bank', 'banks', 'paths', 'optInOnly', 'optInPaths', 'mapPathToBank',
  'dynamicBankId', 'resolveWorktrees', 'harness', 'bankId', 'bankIdTemplate',
])

const rootCache = new Map()

/**
 * The main project root for `directory`: a linked worktree resolves to its main
 * checkout through `--git-common-dir`, and a bare repository is its own root.
 * `null` means "not a git work tree", which is not an error — the integration
 * simply has one lookup directory then.
 */
function mainProjectRoot(directory) {
  const cwd = canonicalPath(directory)
  const hit = rootCache.get(cwd)
  if (hit && Date.now() - hit.at < PROJECT_TTL_MS) return hit.value
  let value = null
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
      value = canonicalPath(basename(absolute) === '.git' ? dirname(absolute) : absolute)
    }
  } catch {
    // Not a work tree, or git is unavailable: no second lookup directory.
  }
  rootCache.set(cwd, { at: Date.now(), value })
  if (rootCache.size > PROJECT_CACHE_SIZE) rootCache.delete(rootCache.keys().next().value)
  return value
}

/**
 * The directories the integration matches `paths`, `mapPathToBank` and
 * `optInPaths` against: the working directory, then the main worktree root when
 * `resolveWorktrees` is on (the default). A section keyed by the repository root
 * therefore applies while working in a linked worktree.
 */
function lookupDirectories(config, cwd) {
  const target = canonicalPath(cwd ?? '.')
  const directories = [target]
  if ((config?.resolveWorktrees ?? true) !== false) {
    const root = mainProjectRoot(target)
    if (root && normalizePath(root) !== normalizePath(target)) directories.push(root)
  }
  return directories
}

/**
 * The first directory with a hit, mirroring the upstream
 * `lookupDirectories(...).map(mapLookup).find(...)`; within one directory the
 * longest configured prefix wins. Both sides are canonicalized first, so a key
 * written as `/var/folders/…` still matches the `/private/var/…` path git
 * reports, and the same holds for a Windows short-name temp dir.
 */
function firstMapHit(map, directories, accept) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  for (const directory of directories) {
    const target = normalizePath(canonicalPath(directory))
    let best = null
    for (const [key, value] of Object.entries(map)) {
      if (!accept(value)) continue
      const rawKey = resolvePathKey(key)
      if (!rawKey) continue
      const prefix = normalizePath(canonicalPath(rawKey))
      if (target === prefix || target.startsWith(`${prefix}/`)) {
        if (!best || prefix.length > best.prefix.length) best = { prefix, key, value }
      }
    }
    if (best) return best
  }
  return null
}

function pathSection(config, cwd) {
  return firstMapHit(
    config?.paths,
    lookupDirectories(config, cwd),
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  )
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
  let pathLayer = null
  let bankLayer = null
  if (cwd) {
    const hit = pathSection(config, cwd)
    if (hit) {
      pathLayer = stripSection(hit.value)
      merged = mergeLayer(merged, pathLayer)
      sections.push(`paths.${hit.key}`)
    }
  }
  if (bank) {
    const section = config?.banks?.[bank]
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      bankLayer = stripSection(section)
      merged = mergeLayer(merged, bankLayer)
      sections.push(`banks.${bank}`)
    }
  }
  const configOverridesToken = [config, perHarness, pathLayer, bankLayer].some(
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
 * integration's own resolution — the `cloud`/`self-hosted`/`daemon` whitelist,
 * `apiPort || 9077`, and `apiToken || undefined` — so a diagnosis explains real
 * behaviour instead of repeating a typo.
 */
export function effectiveServer(config, env = process.env, options = {}) {
  const rawMode = config.serverMode ?? env.HINDSIGHT_SERVER_MODE
  const mode = ['cloud', 'self-hosted', 'daemon'].includes(rawMode) ? rawMode : 'cloud'
  const apiPort = Number(config.apiPort ?? env.HINDSIGHT_API_PORT ?? 9077) || 9077
  const configuredUrl = config.apiUrl ?? env.HINDSIGHT_API_URL
  const apiUrl = mode === 'daemon' ? `http://127.0.0.1:${apiPort}` : configuredUrl ?? CLOUD_URL
  const rawToken = config.apiToken ?? env.HINDSIGHT_API_TOKEN
  const tokenSet = typeof rawToken === 'string' && rawToken.length > 0
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
    token: tokenSet ? rawToken : undefined,
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
 * A path with symlinks and Windows 8.3 short names resolved, so a `paths` key
 * written the ordinary way matches the directory git reports: macOS temp dirs
 * live behind `/private`, and a CI runner names its temp dir `RUNNER~1`.
 */
function canonicalPath(value) {
  const absolute = resolve(value)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * A bank-id template as the integration resolves it. The upstream resolver knows
 * exactly five placeholders — `{gitProject}`, `{project}`, `{harness}`,
 * `{channel}` and `{user}` — and substitutes `unknown` for anything else:
 * `{project}` is the directory name, `{channel}` defaults to `default`, and
 * `{user}` to `anonymous`.
 */
const BANK_PLACEHOLDER = /\{([a-zA-Z_]+)\}/g

export function expandBankTemplate(template, { repo, cwd, harness = 'dsh', env = process.env } = {}) {
  const directory = cwd ? basename(resolve(cwd)) : 'unknown'
  const resolvers = {
    gitProject: () => repo ?? directory,
    project: () => directory,
    harness: () => harness,
    channel: () => env.HINDSIGHT_CHANNEL_ID || 'default',
    user: () => env.HINDSIGHT_USER_ID || 'anonymous',
  }
  return String(template).replace(BANK_PLACEHOLDER, (_, name) => (resolvers[name] ? resolvers[name]() : 'unknown'))
}

/** The `mapPathToBank` bank for `cwd`, matched through the same lookup directories. */
function mappedBank(config, cwd) {
  const hit = firstMapHit(
    config?.mapPathToBank,
    lookupDirectories(config, cwd),
    (value) => typeof value === 'string' && value.length > 0,
  )
  return hit?.value ?? null
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
  if (!dynamic) {
    // A static bank wins; with none configured the integration falls back to its
    // built-in default name rather than templating.
    const bank = typeof config.bankId === 'string' && config.bankId.length > 0 ? config.bankId : 'coding'
    return { bank, source: 'bankId' }
  }
  const template = typeof config?.bankIdTemplate === 'string' && config.bankIdTemplate.length > 0
    ? config.bankIdTemplate
    : 'coding-agent::{gitProject}'
  return { bank: expandBankTemplate(template, { repo, cwd }), source: 'bankIdTemplate' }
}

/**
 * Whether `optInOnly` keeps this directory out of the memory lane. The
 * integration answers this before it resolves a bank, so a status that ignores
 * it would claim a working lane that never injects. Listing a worktree root in
 * `optInPaths` opts its linked worktrees in too.
 */
export function optedOut(config, cwd = process.cwd()) {
  if (!config?.optInOnly) return false
  const directories = lookupDirectories(config, cwd)
  const paths = Array.isArray(config.optInPaths) ? config.optInPaths : []
  const listed = directories.some((directory) => {
    const target = normalizePath(canonicalPath(directory))
    return paths.some((entry) => {
      if (!entry) return false
      const rawKey = resolvePathKey(String(entry))
      if (!rawKey) return false
      const prefix = normalizePath(canonicalPath(rawKey))
      return target === prefix || target.startsWith(`${prefix}/`)
    })
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

/** The package name this plugin is loaded as; used only to recognize the active profile. */
const PLUGIN_BUNDLE = '@jameryw/dsh-hindsight-tuner'
const profileCache = new Map()

/** Cached `package.json` of a directory that may be a DSH profile root. */
function profileManifest(directory) {
  const key = resolve(directory)
  if (profileCache.has(key)) return profileCache.get(key)
  let value = null
  try {
    value = JSON.parse(readFileSync(join(key, 'package.json'), 'utf8'))
  } catch {
    value = null
  }
  if (profileCache.size >= 64) profileCache.clear()
  profileCache.set(key, value)
  return value
}

/**
 * A DSH profile root declares its bundle list (`dsh.profile`); a plain bundle or
 * application root merely has a `package.json`. The distinction matters because
 * the desktop host passes several directories on `process.argv`, most of which
 * are not profiles.
 */
export function isProfileRoot(directory) {
  if (typeof directory !== 'string' || directory.length === 0) return false
  const manifest = profileManifest(directory)
  if (!manifest) return false
  if (manifest.dsh && typeof manifest.dsh === 'object' && manifest.dsh.profile) return true
  return typeof manifest.name === 'string' && manifest.name.startsWith('dsh-profile-')
}

function profilesUnderHome(env) {
  const base = env.DSH_HOME ? join(env.DSH_HOME, 'profiles') : join(homedir(), '.dsh', 'profiles')
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Every directory that may hold the active DSH profile, in priority order.
 *
 * Child processes get `DSH_PROFILE_DIR`, but the DSH desktop host runs plugin
 * code in its own process, passes the active profile directory as a positional
 * argument to its entrypoint, and exports none of those variables. Reading only
 * the environment there reported an installed and loaded memory bundle as "not
 * installed", so `argv` is searched too. When neither source names a profile,
 * the profiles under DSH_HOME are the fallback — preferring the one that lists
 * this plugin keeps a multi-profile host from reporting a sibling profile.
 */
export function profileRoots(env = process.env, argv = process.argv) {
  const roots = []
  const push = (directory) => {
    if (typeof directory !== 'string' || directory.length === 0) return
    const absolute = resolve(directory)
    if (!roots.includes(absolute)) roots.push(absolute)
  }
  if (env.DSH_PROFILE_DIR) push(env.DSH_PROFILE_DIR)
  if (env.DSH_HOME && env.DSH_PROFILE) push(join(env.DSH_HOME, 'profiles', env.DSH_PROFILE))
  if (env.DSH_INSTALL_DIR) push(env.DSH_INSTALL_DIR)
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (isProfileRoot(arg)) push(arg)
  }
  if (roots.length === 0) {
    const candidates = profilesUnderHome(env).filter((directory) => isProfileRoot(directory))
    const loading = candidates.filter((directory) => {
      const bundles = profileManifest(directory)?.dsh?.profile?.bundles
      return Array.isArray(bundles) && bundles.includes(PLUGIN_BUNDLE)
    })
    for (const directory of loading.length > 0 ? loading : candidates) push(directory)
  }
  return roots
}

/**
 * Memory-related bundles the profile declares, with their version and whether
 * their patch is in the active bundle list. This is how a stacked memory setup
 * becomes visible: the tuner itself only owns the Hindsight lane.
 */
export function installedBundles(env = process.env, argv = process.argv) {
  const roots = profileRoots(env, argv)
  const profile =
    roots.find((root) => isProfileRoot(root)) ?? roots.find((root) => existsSync(join(root, 'package.json'))) ?? null
  if (!profile) return { profile: null, roots, bundles: [] }

  const manifest = profileManifest(profile)
  if (!manifest) return { profile, roots, bundles: [] }

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
  return { profile, roots, bundles }
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
  const ratioKey = Number.isFinite(options.tokenRatio) && options.tokenRatio > 0 ? Math.round(options.tokenRatio * 100) / 100 : 0.3
  const key = cacheable ? `${diagStatKey()}:${harness ?? '*'}:${expectedOrigin ?? ''}:${ratioKey}` : null
  if (key !== null && activityCache && activityCache.key === key && Date.now() - activityCache.at < ACTIVITY_TTL_MS) {
    return activityCache.value
  }

  const value = computeActivity(lines, windowHours, now, { harness, expectedOrigin, tokenRatio: options.tokenRatio })
  if (key !== null) activityCache = { key, at: Date.now(), value }
  return value
}

// Only a confirmed server round-trip proves the running process reached the
// configured server. `inject_ok` and `inject_pages` are written by this plugin
// after it assembled text locally (a static tool guide counts as an injection),
// so counting them as success would let a stale process look recovered on the
// very line after its pages fetch failed with 401.
const SERVER_SUCCESS_EVENTS = new Set(['pages_ok', 'retain_ok', 'reflect_ok'])

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

function computeActivity(lines, windowHours, now, { harness = 'dsh', expectedOrigin = null, tokenRatio = null } = {}) {
  // The journal records characters. The caller may pass the tokens-per-character
  // ratio this process actually measured: CJK recall is ~1 token per character,
  // so the 0.3 English baseline would report it at a third of its real size.
  const ratio = Number.isFinite(tokenRatio) && tokenRatio > 0 ? tokenRatio : 0.3
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
  // Newest success confirmed by the server (not a local injection): this is what
  // distinguishes "the process reloaded the config" from "the process still
  // talks to the old server but keeps injecting from its static guide".
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
      if (SERVER_SUCCESS_EVENTS.has(event) && at >= lastSuccessAt) {
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
        lastInject = { chars: entry.chars, tokens: Math.ceil(entry.chars * ratio), ts: entry.ts }
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
