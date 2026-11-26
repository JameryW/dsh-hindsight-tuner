/**
 * Zero-dependency Hindsight v1 HTTP client.
 *
 * Lets `@jameryw/dsh-hindsight-tuner` operate standalone without requiring
 * `@vectorize-io/hindsight-coding-agents`: pages tree/search/read, TEMPR recall,
 * reflect synthesis, async retain, and Git commit cold-start seeding.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { extractQueryTerms, sectionScore } from './tokens.js'

const PAGES_CACHE_TTL_MS = 15_000
const PAGES_CACHE_MAX = 24
const PAGE_CONTENT_CACHE_TTL_MS = 20_000
const PAGE_CONTENT_CACHE_MAX = 64
const DAEMON_WAKE_COOLDOWN_MS = 30_000
const RETRY_STATUS_CODES = new Set([502, 503, 504])
const RETRY_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])
const pagesCache = new Map()
const pageContentCache = new Map()
const inflightGets = new Map()
const daemonWakeCooldowns = new Map()

function cleanBaseUrl(apiUrl) {
  return String(apiUrl || 'http://127.0.0.1:9077').trim().replace(/\/+$/, '')
}

function cacheKey(apiUrl, bankId) {
  return `${cleanBaseUrl(apiUrl)}|${String(bankId ?? '')}`
}

function rememberLru(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) map.delete(map.keys().next().value)
}

export function invalidatePagesCache(apiUrl, bankId) {
  if (!apiUrl || !bankId) {
    pagesCache.clear()
    pageContentCache.clear()
    return
  }
  const prefix = cacheKey(apiUrl, bankId)
  pagesCache.delete(prefix)
  const contentPrefix = `${prefix}|`
  for (const key of pageContentCache.keys()) {
    if (key.startsWith(contentPrefix)) pageContentCache.delete(key)
  }
}

function extractDetail(data, raw) {
  if (data && typeof data === 'object') {
    const candidate = data.detail ?? data.message ?? data.error
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 240)
  }
  return typeof raw === 'string' ? raw.trim().slice(0, 240) : ''
}

/**
 * Distinguish an unrouted endpoint 404 (`{"detail":"Not Found"}` on pre-rename
 * `/knowledge-base` servers) from a cold-bank 404 (`{"detail":"Bank ... not found"}`),
 * avoiding redundant fallback requests on cold banks.
 */
function isUnrouted404(res) {
  if (!res || res.status !== 404) return false
  const detail = String(res.data?.detail ?? res.detail ?? '').trim().toLowerCase()
  return detail === 'not found' || detail === ''
}

/**
 * Compute Hindsight's per-item `observation_scopes` payload (`[[], ['source:x'], ...]`)
 * so `per_source` isolation is recorded directly on every retained item.
 */
export function resolveRetainScopes(tags, configured) {
  if (configured === undefined || configured === null) return undefined
  if (configured !== 'per_source') return configured
  const sources = [...new Set((Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && t.startsWith('source:')))].sort()
  return [[], ...sources.map((source) => [source])]
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function executeOnce(url, method, headers, body, timeout) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  init.signal = controller.signal

  try {
    const response = await fetch(url, init)
    const raw = await response.text().catch(() => '')
    let data = null
    if (raw) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = null
      }
    }
    const detail = response.ok ? '' : extractDetail(data, raw)
    return {
      ok: response.ok,
      status: response.status,
      data,
      detail,
      raw,
      error: response.ok ? null : (detail || `HTTP ${response.status}`),
      errorCode: null,
      url,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    const rawCode = error?.cause?.code || error?.code || null
    const code = rawCode || error?.message || String(error)
    return {
      ok: false,
      status: 0,
      data: null,
      detail: '',
      raw: '',
      error: aborted ? `timed out after ${timeout}ms` : String(code),
      errorCode: aborted ? 'ABORT_ERR' : rawCode,
      url,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Execute one HTTP request against a Hindsight server. Never throws; transport,
 * timeout, and HTTP errors are normalized into `{ ok, status, error, ... }`.
 * Idempotent GET requests share in-flight promises and retry once on transient
 * gateway/socket blips (never on ECONNREFUSED or timeouts).
 */
export async function requestHindsight({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId = null,
  path = '/health',
  method = 'GET',
  body,
  timeoutMs = 7000,
  retry = true,
} = {}) {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, data: null, detail: '', raw: '', error: 'fetch is unavailable in this host', url: '', durationMs: 0 }
  }
  const base = cleanBaseUrl(apiUrl)
  const suffix = path.startsWith('/') ? path : `/${path}`
  const url = bankId == null
    ? `${base}${suffix}`
    : `${base}/v1/default/banks/${encodeURIComponent(String(bankId))}${suffix}`

  const headers = { accept: 'application/json' }
  if (apiToken) headers.authorization = `Bearer ${apiToken}`
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 7000
  const upperMethod = String(method || 'GET').toUpperCase()
  const isGet = upperMethod === 'GET' && body === undefined

  const run = async () => {
    const startedAt = Date.now()
    const activeHeaders = { ...headers }
    let res = await executeOnce(url, upperMethod, activeHeaders, body, timeout)
    // Live 401 credential refresh (#3600): if the user updated apiToken on disk or
    // env since the request started, replay once with the refreshed token.
    if (res.status === 401 && typeof tokenProvider === 'function') {
      let refreshed = null
      try { refreshed = tokenProvider() } catch { refreshed = null }
      if (typeof refreshed === 'string' && refreshed && refreshed !== apiToken) {
        const retryBudget = Math.max(200, timeout - (Date.now() - startedAt))
        activeHeaders.authorization = `Bearer ${refreshed}`
        const replayed = await executeOnce(url, upperMethod, activeHeaders, body, retryBudget)
        res = { ...replayed, durationMs: Date.now() - startedAt }
      }
    }
    const transient = RETRY_STATUS_CODES.has(res.status) || (res.errorCode && RETRY_ERROR_CODES.has(res.errorCode))
    const remaining = timeout - (Date.now() - startedAt)
    if (!res.ok && isGet && retry !== false && transient && remaining >= 200) {
      await delayMs(50)
      const retryBudget = Math.max(150, timeout - (Date.now() - startedAt))
      const second = await executeOnce(url, upperMethod, activeHeaders, body, retryBudget)
      res = { ...second, durationMs: Date.now() - startedAt }
    }
    const { errorCode: _ignored, ...publicRes } = res
    return publicRes
  }

  if (!isGet) return run()

  const inflightKey = `${url}\0${apiToken || ''}\0${timeout}`
  const existing = inflightGets.get(inflightKey)
  if (existing) return existing
  const pending = run().finally(() => {
    if (inflightGets.get(inflightKey) === pending) inflightGets.delete(inflightKey)
  })
  inflightGets.set(inflightKey, pending)
  return pending
}

function flattenTreeNodes(nodes, prefix = '', out = []) {
  if (!Array.isArray(nodes)) return out
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const id = node.id ?? node.page_id ?? node.pageId ?? node.slug ?? null
    const name = String(node.name ?? node.title ?? node.label ?? id ?? '').trim()
    const path = prefix && name ? `${prefix}/${name}` : (name || prefix)
    const children = Array.isArray(node.children)
      ? node.children
      : Array.isArray(node.nodes)
        ? node.nodes
        : Array.isArray(node.pages)
          ? node.pages
          : null
    const isFolder = node.kind === 'folder' || node.type === 'folder'
    if (id != null && (!isFolder || Boolean(node.mental_model_id || node.content || node.body))) {
      out.push({
        id: String(id),
        name: name || String(id),
        path: path || String(id),
        kind: String(node.kind ?? node.type ?? 'page'),
        description: typeof node.description === 'string' ? node.description : '',
        isStale: Boolean(node.is_stale),
      })
    }
    if (children) flattenTreeNodes(children, path, out)
  }
  return out
}

/** List the bank's hierarchical page tree (with legacy knowledge-base fallback). */
export async function listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs = 7000, useCache = true } = {}) {
  const key = cacheKey(apiUrl, bankId)
  if (useCache) {
    const hit = pagesCache.get(key)
    if (hit && Date.now() - hit.at < PAGES_CACHE_TTL_MS) return hit.value
  }

  let res = await requestHindsight({ apiUrl, apiToken, tokenProvider, bankId, path: '/pages/tree', timeoutMs })
  if (isUnrouted404(res)) {
    const legacy = await requestHindsight({ apiUrl, apiToken, tokenProvider, bankId, path: '/knowledge-base/tree', timeoutMs })
    if (legacy.ok || legacy.status !== 404) res = legacy
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, url: res.url, roots: [], pages: [], tree: null }
  }

  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const roots = Array.isArray(data.roots)
    ? data.roots
    : Array.isArray(data.pages)
      ? data.pages
      : Array.isArray(res.data)
        ? res.data
        : []
  const pages = flattenTreeNodes(roots)
  const value = { ok: true, status: res.status, error: null, url: res.url, roots, pages, tree: data }
  rememberLru(pagesCache, key, { at: Date.now(), value }, PAGES_CACHE_MAX)
  return value
}

/** Read the full Markdown body of a page by id, name, or tree path. */
export async function readPage({ apiUrl, apiToken, tokenProvider, bankId, pageId, timeoutMs = 7000, useCache = true } = {}) {
  const target = String(pageId ?? '').trim()
  if (!target) {
    return { ok: false, status: 400, id: '', name: '', content: '', description: '', isStale: false, error: 'pageId is required', url: '' }
  }

  const bankPrefix = cacheKey(apiUrl, bankId)
  const targetKey = `${bankPrefix}|${target}`
  if (useCache) {
    const cached = pageContentCache.get(targetKey)
    if (cached && Date.now() - cached.at < PAGE_CONTENT_CACHE_TTL_MS) return cached.value
  }

  let res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: `/pages/${encodeURIComponent(target)}`,
    timeoutMs,
  })
  if (isUnrouted404(res)) {
    const legacy = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: `/knowledge-base/pages/${encodeURIComponent(target)}`,
      timeoutMs,
    })
    if (legacy.ok || legacy.status !== 404) res = legacy
  }

  if (!res.ok && res.status === 404) {
    const tree = await listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs })
    if (tree.ok) {
      const lowered = target.toLowerCase()
      const match = tree.pages.find((p) => p.id === target || p.name === target || p.path === target)
        ?? tree.pages.find((p) => p.name.toLowerCase() === lowered || p.path.toLowerCase() === lowered)
      if (match && match.id !== target) {
        if (useCache) {
          const byId = pageContentCache.get(`${bankPrefix}|${match.id}`)
          if (byId && Date.now() - byId.at < PAGE_CONTENT_CACHE_TTL_MS) return byId.value
        }
        res = await requestHindsight({
          apiUrl,
          apiToken,
          tokenProvider,
          bankId,
          path: `/pages/${encodeURIComponent(match.id)}`,
          timeoutMs,
        })
        if (isUnrouted404(res)) {
          const legacyById = await requestHindsight({
            apiUrl,
            apiToken,
            tokenProvider,
            bankId,
            path: `/knowledge-base/pages/${encodeURIComponent(match.id)}`,
            timeoutMs,
          })
          if (legacyById.ok || legacyById.status !== 404) res = legacyById
        }
      }
    }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, id: target, name: target, content: '', description: '', isStale: false, error: res.error, url: res.url }
  }

  const data = res.data && typeof res.data === 'object' ? res.data : {}
  const content = data.content ?? data.markdown ?? data.body ?? data.text ?? ''
  const value = {
    ok: true,
    status: res.status,
    id: String(data.id ?? data.page_id ?? target),
    name: String(data.name ?? data.title ?? target),
    content: typeof content === 'string' ? content : String(content ?? ''),
    description: typeof data.description === 'string' ? data.description : '',
    isStale: Boolean(data.is_stale),
    error: null,
    url: res.url,
  }
  const now = Date.now()
  rememberLru(pageContentCache, targetKey, { at: now, value }, PAGE_CONTENT_CACHE_MAX)
  if (value.id !== target) {
    rememberLru(pageContentCache, `${bankPrefix}|${value.id}`, { at: now, value }, PAGE_CONTENT_CACHE_MAX)
  }
  return value
}

/** Hybrid search across a bank's pages, with lexical tree fallback on older servers. */
export async function searchPages({ apiUrl, apiToken, tokenProvider, bankId, query, limit = 5, timeoutMs = 7000 } = {}) {
  const q = String(query ?? '').trim()
  const clampedLimit = Math.max(1, Math.min(50, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 5))
  if (!q) return { ok: true, status: 200, results: [], error: null, url: '', fallback: false }

  let res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: `/pages/search?q=${encodeURIComponent(q)}&limit=${clampedLimit}`,
    timeoutMs,
  })
  if (isUnrouted404(res)) {
    const legacySearch = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: `/knowledge-base/search?q=${encodeURIComponent(q)}&limit=${clampedLimit}`,
      timeoutMs,
    })
    if (legacySearch.ok || (legacySearch.status !== 404 && legacySearch.status !== 405 && legacySearch.status !== 501)) {
      res = legacySearch
    }
  }

  if (res.ok) {
    const rawList = Array.isArray(res.data?.results)
      ? res.data.results
      : Array.isArray(res.data?.items)
        ? res.data.items
        : Array.isArray(res.data?.pages)
          ? res.data.pages
          : Array.isArray(res.data)
            ? res.data
            : []
    const results = rawList
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id ?? item.page_id ?? item.pageId ?? item.slug ?? item.name ?? ''),
        name: String(item.name ?? item.title ?? item.id ?? ''),
        path: String(item.path ?? item.name ?? item.title ?? item.id ?? ''),
        snippet: typeof item.snippet === 'string' ? item.snippet : (typeof item.description === 'string' ? item.description : ''),
        content: typeof item.content === 'string'
          ? item.content
          : (typeof item.markdown === 'string' ? item.markdown : (typeof item.body === 'string' ? item.body : '')),
        score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
      }))
      .slice(0, clampedLimit)
    return { ok: true, status: res.status, results, error: null, url: res.url, fallback: false }
  }

  if (res.status === 404 || res.status === 405 || res.status === 501) {
    const tree = await listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs })
    if (tree.ok) {
      const terms = extractQueryTerms(q)
      const ranked = tree.pages
        .map((page) => ({
          page,
          score: sectionScore(`${page.name} ${page.path} ${page.description}`, terms),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, clampedLimit)
        .map(({ page, score }) => ({
          id: page.id,
          name: page.name,
          path: page.path,
          snippet: page.description,
          content: '',
          score,
        }))
      return { ok: true, status: 200, results: ranked, error: null, url: tree.url, fallback: true }
    }
    return { ok: false, status: tree.status, results: [], error: tree.error, url: tree.url, fallback: true }
  }

  return { ok: false, status: res.status, results: [], error: res.error, url: res.url, fallback: false }
}

/** Multi-strategy TEMPR memory recall. */
export async function recallMemories({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  query,
  maxTokens = 2000,
  budget = 'mid',
  types,
  timeoutMs = 7000,
} = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: true, status: 200, results: [], error: null, url: '' }
  const body = {
    query: q,
    max_tokens: Math.max(100, Math.trunc(Number(maxTokens) || 2000)),
    budget: ['low', 'mid', 'high'].includes(budget) ? budget : 'mid',
  }
  if (Array.isArray(types) && types.length > 0) body.types = types

  const res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: '/memories/recall',
    method: 'POST',
    body,
    timeoutMs,
  })
  if (!res.ok) return { ok: false, status: res.status, results: [], error: res.error, url: res.url }

  const rawList = Array.isArray(res.data?.results)
    ? res.data.results
    : Array.isArray(res.data?.items)
      ? res.data.items
      : Array.isArray(res.data?.memories)
        ? res.data.memories
        : []
  const results = rawList
    .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({
      id: item.id != null ? String(item.id) : null,
      text: item.text.trim(),
      type: typeof item.type === 'string' ? item.type : 'fact',
      context: typeof item.context === 'string' ? item.context : null,
      entities: Array.isArray(item.entities) ? item.entities : [],
    }))
  return { ok: true, status: res.status, results, error: null, url: res.url }
}

/** Agentic reflection over accumulated bank memories. */
export async function reflectMemories({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  query,
  budget = 'low',
  timeoutMs = 15_000,
} = {}) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: true, status: 200, text: '', error: null, url: '' }
  const res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: '/reflect',
    method: 'POST',
    body: {
      query: q,
      budget: ['low', 'mid', 'high'].includes(budget) ? budget : 'low',
    },
    timeoutMs,
  })
  if (!res.ok) return { ok: false, status: res.status, text: '', error: res.error, url: res.url }
  const text = res.data?.text ?? res.data?.answer ?? res.data?.content ?? ''
  return {
    ok: true,
    status: res.status,
    text: typeof text === 'string' ? text.trim() : String(text ?? '').trim(),
    error: null,
    url: res.url,
  }
}

/** Queue one or more structured memory items into a bank. */
export async function retainMemories({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  items,
  async = true,
  tags,
  strategy,
  observationScopes,
  operationId,
  timeoutMs = 10_000,
} = {}) {
  const callTags = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()) : []
  const rawList = Array.isArray(items) ? items.filter((item) => item && typeof item.content === 'string' && item.content.trim()) : []
  if (rawList.length === 0) {
    return { ok: false, status: 400, operationId: null, count: 0, error: 'items must contain non-empty content', url: '' }
  }
  const list = rawList.map((item) => {
    const itemTags = [...new Set([
      ...(Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string' && t.trim()) : []),
      ...callTags,
    ])]
    const resolvedStrategy = item.strategy ?? strategy
    const scopes = item.observation_scopes ?? resolveRetainScopes(itemTags, observationScopes)
    return {
      ...item,
      ...(itemTags.length > 0 ? { tags: itemTags } : {}),
      ...(resolvedStrategy ? { strategy: resolvedStrategy } : {}),
      ...(scopes !== undefined ? { observation_scopes: scopes } : {}),
    }
  })
  const body = { items: list, async: async !== false }
  if (callTags.length > 0) body.tags = callTags
  if (typeof operationId === 'string' && operationId.trim()) body.operation_id = operationId.trim()

  const res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: '/memories',
    method: 'POST',
    body,
    timeoutMs,
  })
  if (res.ok) invalidatePagesCache(apiUrl, bankId)
  return {
    ok: res.ok,
    status: res.status,
    operationId: res.data?.operation_id ?? null,
    count: list.length,
    error: res.error,
    url: res.url,
  }
}

/** Cold-start seed recent git commit history from `cwd` into the resolved bank. */
export async function seedBankFromGit({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  cwd = process.cwd(),
  limit = 30,
  tags = ['source:git', 'harness:dsh'],
  observationScopes,
  timeoutMs = 15_000,
} = {}) {
  const clampedLimit = Math.max(1, Math.min(500, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 30))
  let raw = ''
  try {
    raw = execFileSync(
      'git',
      ['log', `-n${clampedLimit}`, '--no-merges', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e'],
      {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
  } catch {
    return { ok: false, status: 0, reason: 'not-git', error: 'working directory is not a git repository or has no commits', count: 0 }
  }

  const items = []
  for (const record of raw.split('\x1e')) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const [sha = '', iso = '', subject = '', body = ''] = trimmed.split('\x1f')
    if (!sha || !subject.trim()) continue
    const detail = body.trim().slice(0, 1200)
    const content = `Commit ${sha.slice(0, 7)} (${iso.trim()}): ${subject.trim()}${detail ? `\n${detail}` : ''}`
    items.push({
      content,
      context: 'git-commit',
      document_id: `git:${sha.trim()}`,
      ...(iso.trim() ? { timestamp: iso.trim() } : {}),
    })
  }

  if (items.length === 0) {
    return { ok: false, status: 0, reason: 'empty', error: 'no non-merge commits found to seed', count: 0 }
  }

  return retainMemories({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    items,
    async: true,
    tags,
    strategy: 'git',
    observationScopes,
    timeoutMs,
  })
}

function slugifyTitle(value, fallback = 'doc') {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || fallback
}

/** Deterministic document_id for `hindsight_ingest_document` matching upstream slug/hash rules. */
export function documentIdForTitle(title) {
  const raw = String(title ?? '').trim()
  const slug = slugifyTitle(raw, '')
  if (/[^\x00-\x7f]/.test(raw) || !slug) {
    const hash = createHash('sha256').update(raw).digest('hex')
    return `${slug || 'doc'}--${hash}`
  }
  return slug
}

/**
 * Create or update a tracked feature/initiative page (`hindsight_capture_initiative`)
 * and retain its `[[page:<id>]]` marker memory.
 */
export async function captureInitiative({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  project = 'repository',
  title,
  summary,
  relatesToPageId,
  tags = [],
  observationScopes,
  timeoutMs = 10_000,
} = {}) {
  const cleanTitle = String(title ?? '').trim()
  const cleanSummary = String(summary ?? '').trim()
  if (!cleanTitle || !cleanSummary) {
    return { ok: false, status: 400, pageId: null, error: 'title and summary are required' }
  }

  let pageId = typeof relatesToPageId === 'string' && relatesToPageId.trim() ? relatesToPageId.trim() : ''
  if (!pageId) {
    let folderId
    const tree = await listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs, useCache: false })
    if (tree.ok && Array.isArray(tree.roots)) {
      const hit = tree.roots.find((n) => n?.kind === 'folder' && String(n?.name ?? '').toLowerCase() === 'initiatives')
      if (hit?.id) folderId = String(hit.id)
    }
    if (!folderId) {
      const folderRes = await requestHindsight({
        apiUrl,
        apiToken,
        tokenProvider,
        bankId,
        path: '/pages/folders',
        method: 'POST',
        body: { name: 'Initiatives' },
        timeoutMs,
      })
      if (folderRes.ok && folderRes.data?.id) folderId = String(folderRes.data.id)
    }
    const createRes = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: '/pages',
      method: 'POST',
      body: {
        name: cleanTitle,
        source_query: `Summarize the "${cleanTitle}" initiative in ${project}: what is being built or changed and why, and its current state.`,
        ...(folderId ? { parent_id: folderId } : {}),
        tags: ['knowledge:feature-work'],
        max_tokens: 4000,
      },
      timeoutMs,
    })
    if (createRes.ok) {
      pageId = String(createRes.data?.page_id ?? createRes.data?.id ?? '')
    }
    if (!pageId) pageId = `initiative-${slugifyTitle(cleanTitle, 'initiative')}`
  }

  const isUpdate = Boolean(typeof relatesToPageId === 'string' && relatesToPageId.trim())
  const verb = isUpdate ? 'Update to an existing initiative' : 'New initiative'
  const markerId = `initiative-marker-${slugifyTitle(pageId, 'initiative')}${isUpdate ? '-update' : ''}`
  const mergedTags = [...new Set([...(Array.isArray(tags) ? tags : []), 'knowledge:feature-work', 'source:upload', 'harness:dsh'])]
  const retainRes = await retainMemories({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    items: [{
      content: `${verb}: ${cleanTitle}. ${cleanSummary}`,
      context: `initiative marker for [[page:${pageId}]]`,
      document_id: markerId,
      metadata: { relatedPageId: pageId, harness: 'dsh' },
    }],
    async: true,
    tags: mergedTags,
    strategy: 'document',
    observationScopes,
    timeoutMs,
  })
  return {
    ok: retainRes.ok,
    status: retainRes.status,
    pageId,
    operationId: retainRes.operationId,
    error: retainRes.error,
  }
}

/** Fetch memory-bearing and operational statistics for a bank (`/stats`). */
export async function fetchBankStats({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs = 7000 } = {}) {
  const res = await requestHindsight({ apiUrl, apiToken, tokenProvider, bankId, path: '/stats', timeoutMs })
  if (!res.ok) return { ok: false, status: res.status, stats: null, error: res.error, url: res.url }
  const stats = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}
  return { ok: true, status: res.status, stats, error: null, url: res.url }
}

/**
 * Sync shared consolidation settings to the bank when `manageBankConfig` is enabled.
 * Supports Hindsight v1 `POST /import` (`{ version: "1", bank: ... }`) with
 * fallback to `PATCH /config` / `PUT /config`.
 */
export async function syncBankConfig({ apiUrl, apiToken, tokenProvider, bankId, config = {}, timeoutMs = 5000 } = {}) {
  if (!config || typeof config !== 'object') return { ok: true, skipped: true, status: 200, error: null }
  const payload = {}
  if (config.observationScopes !== undefined) payload.observation_scopes = config.observationScopes
  if (typeof config.pageTriggerType === 'string' && config.pageTriggerType.trim()) {
    payload.page_trigger_type = config.pageTriggerType.trim()
  }
  if (typeof config.pageTriggerCron === 'string' && config.pageTriggerCron.trim()) {
    payload.page_trigger_cron = config.pageTriggerCron.trim()
  }
  if (typeof config.retainExtractionMode === 'string' && config.retainExtractionMode.trim()) {
    payload.retain_extraction_mode = config.retainExtractionMode.trim()
  }
  if (Object.keys(payload).length === 0) return { ok: true, skipped: true, status: 200, error: null }

  let res = await requestHindsight({
    apiUrl,
    apiToken,
    tokenProvider,
    bankId,
    path: '/import',
    method: 'POST',
    body: { version: '1', bank: payload },
    timeoutMs,
  })
  if (!res.ok && (res.status === 404 || res.status === 405)) {
    res = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: '/config',
      method: 'PATCH',
      body: payload,
      timeoutMs,
    })
  }
  if (!res.ok && res.status === 405) {
    res = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: '/config',
      method: 'PUT',
      body: payload,
      timeoutMs,
    })
  }
  return { ok: res.ok, skipped: false, status: res.status, error: res.error }
}

export const DEFAULT_CODING_PAGES = Object.freeze([
  Object.freeze({
    name: 'Architecture',
    sourceQuery: (project) => `High-level architecture, module boundaries, data flow, and runtime lifecycle of ${project}.`,
  }),
  Object.freeze({
    name: 'Conventions',
    sourceQuery: (project) => `Coding conventions, invariants, testing practices, and recurring pitfalls in ${project}.`,
  }),
  Object.freeze({
    name: 'Component Map',
    sourceQuery: (project) => `Directory layout, key entrypoints, and file responsibilities across ${project}.`,
  }),
  Object.freeze({
    name: 'Key Decisions',
    sourceQuery: (project) => `Key design trade-offs, architectural decisions, and rationale recorded for ${project}.`,
  }),
])

/** Build the default coding-agent bank manifest for standalone initialization. */
export function codingBankManifest(project = 'repository', config = {}) {
  const name = String(project || 'repository').trim() || 'repository'
  const manifest = {
    mission: `Persistent engineering memory for ${name}: architecture, module contracts, conventions, decisions, and verified debugging lessons.`,
    observations_mission: `Extract durable facts, file paths, invariants, conventions, and design decisions for ${name}; ignore transient chatter and ephemeral secrets.`,
    strategies: {
      git: `Extract modules changed, architectural impact, bug fixes, and commit-level context from git history in ${name}.`,
      conversation: `Extract verified technical findings, file paths, command results, bug causes, and user preferences from coding sessions in ${name}.`,
      document: `Extract structured specifications, corrections, decisions, and initiative context for ${name}.`,
    },
  }
  if (config.observationScopes !== undefined) manifest.observation_scopes = config.observationScopes
  if (typeof config.pageTriggerType === 'string' && config.pageTriggerType.trim()) {
    manifest.page_trigger_type = config.pageTriggerType.trim()
  }
  if (typeof config.pageTriggerCron === 'string' && config.pageTriggerCron.trim()) {
    manifest.page_trigger_cron = config.pageTriggerCron.trim()
  }
  if (typeof config.retainExtractionMode === 'string' && config.retainExtractionMode.trim()) {
    manifest.retain_extraction_mode = config.retainExtractionMode.trim()
  }
  return manifest
}

const TERMINAL_OP_STATUSES = new Set(['completed', 'succeeded', 'done', 'failed', 'cancelled', 'canceled', 'error'])

/**
 * Inspect bank synchronization status (`hindsight_sync_status`): active background
 * operations, pending consolidation, document/node presence, and page counts.
 */
export async function fetchSyncStatus({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs = 7000 } = {}) {
  const [opsRes, docsRes, statsRes, pagesRes] = await Promise.all([
    requestHindsight({ apiUrl, apiToken, tokenProvider, bankId, path: '/operations', timeoutMs, retry: false }),
    requestHindsight({ apiUrl, apiToken, tokenProvider, bankId, path: '/documents?limit=1', timeoutMs, retry: false }),
    fetchBankStats({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs }),
    listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs, useCache: false }),
  ])

  const rawOps = Array.isArray(opsRes.data?.operations)
    ? opsRes.data.operations
    : Array.isArray(opsRes.data?.items)
      ? opsRes.data.items
      : Array.isArray(opsRes.data)
        ? opsRes.data
        : []
  const activeOperations = rawOps.filter((op) => !TERMINAL_OP_STATUSES.has(String(op?.status ?? '').toLowerCase())).length

  const rawDocs = Array.isArray(docsRes.data?.items)
    ? docsRes.data.items
    : Array.isArray(docsRes.data?.documents)
      ? docsRes.data.documents
      : Array.isArray(docsRes.data)
        ? docsRes.data
        : []

  const totalNodes = Number(statsRes.stats?.total_nodes ?? statsRes.stats?.nodes ?? statsRes.stats?.memory_count ?? 0) || 0
  const totalObservations = Number(statsRes.stats?.total_observations ?? statsRes.stats?.observations ?? 0) || 0
  const pendingConsolidation = Number(statsRes.stats?.pending_consolidation ?? statsRes.stats?.pending_operations ?? 0) || 0

  const pagesCount = pagesRes.ok ? pagesRes.pages.length : 0
  const stalePages = pagesRes.ok ? pagesRes.pages.filter((page) => page.isStale).length : 0
  const bankExists = pagesRes.ok || statsRes.ok || docsRes.ok || opsRes.ok
  const hasDocuments = (docsRes.ok && (rawDocs.length > 0 || (Number(docsRes.data?.total) || 0) > 0)) || totalNodes > 0
  const ok = bankExists || pagesRes.status === 404
  const synced = Boolean(ok && bankExists && activeOperations === 0 && pendingConsolidation === 0 && (hasDocuments || pagesCount > 0))

  return {
    ok,
    status: pagesRes.status || statsRes.status || opsRes.status || 0,
    synced,
    bankExists,
    hasDocuments,
    activeOperations,
    pendingConsolidation,
    pagesCount,
    stalePages,
    totalNodes,
    totalObservations,
    error: ok ? null : (pagesRes.error || statsRes.error || opsRes.error || 'bank unreachable'),
  }
}

/**
 * Idempotently initialize a standalone Hindsight coding bank: sync coding
 * strategies/mission (preserving any existing server overrides) and seed
 * missing core pages (`Architecture`, `Conventions`, `Component Map`, `Key Decisions`).
 */
export async function bootstrapCodingBank({
  apiUrl,
  apiToken,
  tokenProvider,
  bankId,
  project = 'repository',
  config = {},
  seedPages = true,
  timeoutMs = 10_000,
} = {}) {
  let configSynced = false
  let lastStatus = 200

  if (config?.manageBankConfig !== false) {
    const existingCfg = await requestHindsight({
      apiUrl,
      apiToken,
      tokenProvider,
      bankId,
      path: '/config',
      timeoutMs,
      retry: false,
    })
    const overrides = existingCfg.ok && existingCfg.data?.overrides && typeof existingCfg.data.overrides === 'object'
      ? existingCfg.data.overrides
      : {}
    const manifest = codingBankManifest(project, config)
    const toApply = {}
    for (const [key, value] of Object.entries(manifest)) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
        toApply[key] = value
      }
    }
    if (Object.keys(toApply).length > 0) {
      let applyRes = await requestHindsight({
        apiUrl,
        apiToken,
        tokenProvider,
        bankId,
        path: '/import',
        method: 'POST',
        body: { version: '1', bank: toApply },
        timeoutMs,
      })
      if (!applyRes.ok && (applyRes.status === 404 || applyRes.status === 405)) {
        applyRes = await requestHindsight({
          apiUrl,
          apiToken,
          tokenProvider,
          bankId,
          path: '/config',
          method: 'PATCH',
          body: toApply,
          timeoutMs,
        })
      }
      if (!applyRes.ok && applyRes.status !== 404 && applyRes.status !== 405) {
        return {
          ok: false,
          status: applyRes.status,
          configSynced: false,
          createdPages: [],
          existingPages: 0,
          error: applyRes.error,
        }
      }
      if (applyRes.ok) {
        configSynced = true
        lastStatus = applyRes.status
      }
    }
  }

  const createdPages = []
  let existingPages = 0
  if (seedPages !== false) {
    const tree = await listPages({ apiUrl, apiToken, tokenProvider, bankId, timeoutMs, useCache: false })
    if (!tree.ok && tree.status !== 404) {
      return {
        ok: false,
        status: tree.status,
        configSynced,
        createdPages,
        existingPages: 0,
        error: tree.error,
      }
    }
    const current = tree.ok ? tree.pages : []
    existingPages = current.length
    const existingNames = new Set(current.map((page) => String(page.name ?? '').trim().toLowerCase()).filter(Boolean))

    for (const def of DEFAULT_CODING_PAGES) {
      if (existingNames.has(def.name.toLowerCase())) continue
      const pageRes = await requestHindsight({
        apiUrl,
        apiToken,
        tokenProvider,
        bankId,
        path: '/pages',
        method: 'POST',
        body: {
          name: def.name,
          source_query: def.sourceQuery(project),
          max_tokens: 4000,
        },
        timeoutMs,
      })
      if (pageRes.ok) {
        createdPages.push({
          id: String(pageRes.data?.page_id ?? pageRes.data?.id ?? def.name.toLowerCase().replace(/\s+/g, '-')),
          name: def.name,
        })
        lastStatus = pageRes.status
      } else if (![404, 405, 409].includes(pageRes.status)) {
        return {
          ok: false,
          status: pageRes.status,
          configSynced,
          createdPages,
          existingPages,
          error: pageRes.error,
        }
      }
    }
    if (createdPages.length > 0) invalidatePagesCache(apiUrl, bankId)
  }

  return {
    ok: true,
    status: lastStatus,
    configSynced,
    createdPages,
    existingPages,
    error: null,
  }
}

function isDirectoryPath(target) {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function hasExecutableOnPath(bin) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    execFileSync(probe, [bin], { stdio: 'ignore', timeout: 2000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

function resolveEmbedCommand({ embedPackagePath, embedVersion } = {}) {
  const customPath = typeof embedPackagePath === 'string' ? embedPackagePath.trim() : ''
  if (customPath) {
    if (/\.(?:m|c)?js$/i.test(customPath)) return { kind: 'js', command: process.execPath, baseArgs: [customPath] }
    if (isDirectoryPath(customPath)) {
      return hasExecutableOnPath('uv')
        ? { kind: 'embed', command: 'uv', baseArgs: ['run', '--directory', customPath, 'hindsight-embed'] }
        : null
    }
    return { kind: 'embed', command: customPath, baseArgs: [] }
  }
  if (hasExecutableOnPath('hindsight-embed')) {
    return { kind: 'embed', command: 'hindsight-embed', baseArgs: [] }
  }
  if (hasExecutableOnPath('uvx')) {
    const ver = typeof embedVersion === 'string' && embedVersion.trim() ? embedVersion.trim() : 'latest'
    return { kind: 'embed', command: 'uvx', baseArgs: [`hindsight-embed@${ver}`] }
  }
  return null
}

/**
 * Best-effort auto-wake for `serverMode: 'daemon'` in standalone mode.
 *
 * Mirrors Hindsight's `HindsightServer` lifecycle (`profile create <profile>
 * --merge --port <port>` followed by `daemon --profile <profile> start` via
 * `hindsight-embed` or `uvx hindsight-embed@latest`, with Darwin CPU env flags),
 * while also supporting custom `.js`/`.mjs` daemon scripts.
 */
export async function ensureDaemonAwake({
  apiUrl,
  apiToken,
  apiPort = 9077,
  daemonIdleTimeout,
  daemonProfile,
  embedPackagePath,
  embedVersion,
  waitMs = 3000,
} = {}) {
  if (process.env.HINDSIGHT_NO_DAEMON_SPAWN === '1') {
    return { ok: false, spawned: false, error: 'daemon auto-spawn disabled by HINDSIGHT_NO_DAEMON_SPAWN=1' }
  }
  const base = cleanBaseUrl(apiUrl || `http://127.0.0.1:${apiPort || 9077}`)
  const precheck = await requestHindsight({ apiUrl: base, apiToken, path: '/health', timeoutMs: 400, retry: false })
  if (precheck.ok) return { ok: true, spawned: false, error: null }

  const cooldownKey = `${base}|${embedPackagePath || ''}`
  const lastAttempt = daemonWakeCooldowns.get(cooldownKey) ?? 0
  if (Date.now() - lastAttempt < DAEMON_WAKE_COOLDOWN_MS) {
    return { ok: false, spawned: false, error: 'daemon wake cooldown active' }
  }
  daemonWakeCooldowns.set(cooldownKey, Date.now())

  const resolved = resolveEmbedCommand({ embedPackagePath, embedVersion })
  if (!resolved) {
    return { ok: false, spawned: false, error: 'neither hindsight-embed nor uvx was found on PATH' }
  }

  const port = Number.isInteger(Number(apiPort)) && Number(apiPort) > 0 ? Number(apiPort) : 9077
  const profile = typeof daemonProfile === 'string' && daemonProfile.trim() ? daemonProfile.trim() : 'coding-agents'
  const childEnv = { ...process.env }
  if (process.platform === 'darwin') {
    childEnv.HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU ??= '1'
    childEnv.HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU ??= '1'
  }

  let spawnError = null
  try {
    let command = resolved.command
    let args
    if (resolved.kind === 'js') {
      args = [
        ...resolved.baseArgs,
        'daemon',
        'start',
        '--port',
        String(port),
        ...(Number.isFinite(daemonIdleTimeout) && daemonIdleTimeout >= 0 ? ['--idle-timeout', String(Math.trunc(daemonIdleTimeout))] : []),
        '--profile',
        profile,
      ]
    } else {
      const createArgs = [
        ...resolved.baseArgs,
        'profile',
        'create',
        profile,
        '--merge',
        '--port',
        String(port),
      ]
      if (process.platform === 'darwin') {
        createArgs.push('--env', `HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU=${childEnv.HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU}`)
        createArgs.push('--env', `HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU=${childEnv.HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU}`)
      }
      const startArgs = [
        ...resolved.baseArgs,
        'daemon',
        '--profile',
        profile,
        'start',
        ...(Number.isFinite(daemonIdleTimeout) && daemonIdleTimeout >= 0 ? ['--idle-timeout', String(Math.trunc(daemonIdleTimeout))] : []),
      ]
      const bootstrap = [
        "const { spawnSync } = require('node:child_process');",
        'const spec = JSON.parse(process.argv[1]);',
        "spawnSync(spec.cmd, spec.create, { stdio: 'ignore', windowsHide: true });",
        "spawnSync(spec.cmd, spec.start, { stdio: 'ignore', windowsHide: true });",
      ].join(' ')
      command = process.execPath
      args = ['-e', bootstrap, JSON.stringify({ cmd: resolved.command, create: createArgs, start: startArgs })]
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv,
    })
    child.once('error', (err) => { spawnError = err })
    child.unref?.()
  } catch (error) {
    return { ok: false, spawned: false, error: error?.code || error?.message || String(error) }
  }

  const deadline = Date.now() + Math.max(200, Math.min(8000, Math.trunc(waitMs || 3000)))
  while (Date.now() < deadline) {
    await delayMs(60)
    if (spawnError) {
      return { ok: false, spawned: false, error: spawnError?.code || spawnError?.message || String(spawnError) }
    }
    const check = await requestHindsight({ apiUrl: base, apiToken, path: '/health', timeoutMs: 350, retry: false })
    if (check.ok) {
      daemonWakeCooldowns.delete(cooldownKey)
      return { ok: true, spawned: true, error: null }
    }
  }
  return { ok: false, spawned: true, error: 'daemon did not become healthy before deadline' }
}
