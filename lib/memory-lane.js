/**
 * Built-in standalone Hindsight lane and native agent tools.
 *
 * When `@vectorize-io/hindsight-coding-agents` is absent or disabled, this
 * module drives Hindsight directly via `lib/client.js` so `@jameryw/dsh-hindsight-tuner`
 * works as a self-contained single plugin:
 *   - `fetchTurnRecall()` pulls `pages`, `recall`, or `reflect` context on a
 *     turn when no external plugin already injected a memory message;
 *   - `registerHindsightTools()` exposes `hindsight_search_pages`,
 *     `hindsight_list_pages`, `hindsight_read_page`, `hindsight_recall`,
 *     `hindsight_reflect`, and `hindsight_retain`.
 */

import { getPath, readConfigFile } from './config-file.js'
import {
  captureInitiative,
  documentIdForTitle,
  ensureDaemonAwake,
  fetchSyncStatus,
  listPages,
  readPage,
  recallMemories,
  reflectMemories,
  retainMemories,
  searchPages,
  seedBankFromGit,
  syncBankConfig,
} from './client.js'
import {
  bankResolution,
  effectiveConfig,
  effectiveServer,
  optedOut,
  projectName,
} from './diagnostics.js'
import { stripRuntimePrefixes } from './envelope.js'
import { record } from './log.js'

function textOutput(renderFn) {
  return {
    schema: { type: 'string' },
    render: renderFn ?? ((_args, value) => [{ type: 'text', text: value }]),
  }
}

/** Resolve the effective server, bank, and config layers for `cwd`. */
export function resolveRuntimeTarget(cwd = process.cwd()) {
  const safeCwd = cwd || process.cwd()
  const file = readConfigFile()
  const project = projectName(safeCwd)
  const baseLayers = effectiveConfig(file.config, { cwd: safeCwd })
  const resolution = bankResolution(baseLayers.config, project.name, safeCwd)
  const layers = effectiveConfig(file.config, { cwd: safeCwd, bank: resolution.base ?? resolution.bank })
  const effective = layers.config
  const isOptedOut = optedOut(effective, safeCwd)
  const resolvedServer = effectiveServer(effective, {}, { tokenSource: layers.tokenSource })
  const disabled = resolvedServer.disabled || isOptedOut
  return {
    cwd: safeCwd,
    file,
    project,
    resolution,
    layers,
    effective,
    isOptedOut,
    server: { ...resolvedServer, disabled },
  }
}

const MAX_RETAINED_SESSIONS = 64
const BEARER_SECRET = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi
const KNOWN_API_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g
const KEY_VALUE_SECRET = /(["']?(?:apiToken|api_token|apiKey|api_key|access_token|refresh_token|client_secret|password|secret)["']?\s*[:=]\s*["']?)([^"'\s,}\n]{8,})/gi

/** Scrub common bearer tokens, API keys, and credential assignments before retention. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(BEARER_SECRET, '$1[REDACTED]')
    .replace(KNOWN_API_KEYS, '[REDACTED_KEY]')
    .replace(KEY_VALUE_SECRET, '$1[REDACTED]')
}

function rememberSession(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > MAX_RETAINED_SESSIONS) map.delete(map.keys().next().value)
}

const SESSION_RETAIN_CONTEXT =
  'conversation between the user and you (the coding agent): user turns are the user\'s words and decisions, assistant turns are yours. When an assistant turn says something is fixed, passes or works, record it as the agent\'s claim ("the agent reported X fixed"), not as an established fact.'

const INJECTED_TAG_BLOCKS = /<hindsight_(?:pages|page_refresh|memories|context)>[\s\S]*?<\/hindsight_(?:pages|page_refresh|memories|context)>/gi

function stripInjectedBlocks(text) {
  return stripRuntimePrefixes(String(text ?? '')).replace(INJECTED_TAG_BLOCKS, '').trim()
}

function liveTokenProvider(cwd) {
  return () => resolveRuntimeTarget(cwd).server.token
}

function readSessionEvents(session) {
  try {
    const raw = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    if (!Array.isArray(raw)) return []
    const inherited = Number.isInteger(session?.inheritedEventCount) && session.inheritedEventCount > 0
      ? session.inheritedEventCount
      : 0
    return inherited > 0 ? raw.slice(inherited) : raw
  } catch {
    return []
  }
}

function extractContentBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function extractEventText(event) {
  if (event?.type === 'tool/call') {
    const name = event?.data?.name
    if (typeof name === 'string' && name.trim()) return `[tool: ${name.trim()}]`
    return ''
  }
  // Real DSH stores `assistant/message` payload at `event.data.message.content`,
  // while `user/message` and synthetic test events use `event.data.content`.
  const content = event?.data?.message?.content ?? event?.data?.content ?? event?.content
  return stripInjectedBlocks(extractContentBlocks(content))
}

function classifyEventRole(event, sourceKind) {
  if (!event || typeof event !== 'object') return null
  const type = typeof event.type === 'string' ? event.type : ''
  const role = event?.data?.message?.role ?? event?.data?.role ?? event?.role ?? ''
  if (type === 'user/message' || (!type && role === 'user')) {
    const kind = event?.data?.source?.kind ?? event?.source?.kind ?? ''
    if (kind === sourceKind || (typeof kind === 'string' && kind.startsWith('plugin:'))) return null
    return 'user'
  }
  if (type === 'assistant/message' || role === 'assistant') return 'assistant'
  if (type === 'tool/call' && typeof event?.data?.name === 'string') return 'action'
  return null
}

function extractCompletedExchanges(events, watermark, sourceKind) {
  let lastAssistantIndex = -1
  let lastAssistantSeq = watermark
  const annotated = []

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const seq = Number.isFinite(event?.seq) && event.seq > 0 ? event.seq : index + 1
    if (seq <= watermark) continue
    const role = classifyEventRole(event, sourceKind)
    if (!role) continue
    const text = extractEventText(event).trim()
    if (!text) continue
    const ts = typeof event.time === 'number' && Number.isFinite(event.time)
      ? new Date(event.time).toISOString()
      : null
    const pos = annotated.length
    annotated.push({ seq, role, text, ts })
    if (role === 'assistant') {
      lastAssistantIndex = pos
      lastAssistantSeq = seq
    }
  }

  if (lastAssistantIndex < 0) return { exchanges: [], nextWatermark: watermark }

  const exchanges = []
  let userParts = []
  let actionParts = []
  let assistantParts = []
  let startSeq = null
  let endSeq = null
  let timestamp = null

  const flush = () => {
    if (assistantParts.length === 0) return
    const userText = userParts.join('\n').trim()
    const assistantText = assistantParts.join('\n').trim()
    const actionsText = [...new Set(actionParts)].slice(0, 12).join(', ')
    if (assistantText.length > 0 && userText.length + assistantText.length >= 20) {
      exchanges.push({ startSeq, endSeq, userText, actionsText, assistantText, timestamp })
    }
    userParts = []
    actionParts = []
    assistantParts = []
    startSeq = null
    endSeq = null
    timestamp = null
  }

  for (let i = 0; i <= lastAssistantIndex; i += 1) {
    const entry = annotated[i]
    if (entry.role === 'user') {
      if (assistantParts.length > 0) flush()
      if (startSeq === null) startSeq = entry.seq
      if (!timestamp && entry.ts) timestamp = entry.ts
      endSeq = entry.seq
      userParts.push(entry.text)
    } else if (entry.role === 'action') {
      if (startSeq === null) startSeq = entry.seq
      endSeq = entry.seq
      actionParts.push(entry.text)
    } else {
      if (startSeq === null) startSeq = entry.seq
      if (!timestamp && entry.ts) timestamp = entry.ts
      endSeq = entry.seq
      assistantParts.push(entry.text)
    }
  }
  flush()

  return { exchanges, nextWatermark: lastAssistantSeq }
}

function retainAllowed(target) {
  if (target.server.disabled) return false
  if (process.env.HINDSIGHT_RETAIN_SESSIONS === 'false') return false
  if (target.effective.retainSessions === false) return false
  return true
}

function resolveRetainTags(target, settings, extraTags = []) {
  const tags = new Set()
  if (Array.isArray(target.effective.retainTags)) {
    for (const tag of target.effective.retainTags) if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim())
  }
  if (Array.isArray(extraTags)) {
    for (const tag of extraTags) if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim())
  }
  const scopes = target.effective.observationScopes ?? settings.observationScopes
  if (scopes === 'per_source') tags.add('source:dsh')
  return [...tags]
}

/**
 * Create the per-plugin built-in recall & retention engine used when no external
 * Hindsight plugin already owns the turn.
 */
export function createMemoryLane(settings) {
  const seededBanks = new Set()
  const syncedConfigBanks = new Set()
  const retainedSessions = new Map()
  const pendingPromises = new Set()
  const retainQueue = []
  let activeRetains = 0

  function scheduleRetainTask(maxParallel, task) {
    const limit = Math.max(1, Math.min(16, Number.isInteger(maxParallel) ? maxParallel : 2))
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    pendingPromises.add(done)

    const pump = () => {
      while (activeRetains < limit && retainQueue.length > 0) {
        const next = retainQueue.shift()
        activeRetains += 1
        Promise.resolve()
          .then(next.task)
          .catch(() => {})
          .finally(() => {
            activeRetains -= 1
            pendingPromises.delete(next.done)
            next.resolveDone()
            pump()
          })
      }
    }

    retainQueue.push({ task, done, resolveDone })
    pump()
    return done
  }

  async function flushRetains() {
    while (pendingPromises.size > 0) {
      await Promise.allSettled([...pendingPromises])
    }
  }

  function maybeAutoSeed(target) {
    if (!retainAllowed(target)) return
    const enabled = target.effective.autoSeed === true || settings.autoSeed === true
    if (!enabled) return
    const bankId = target.resolution.bank
    if (seededBanks.has(bankId)) return
    seededBanks.add(bankId)
    const limit = Number.isFinite(target.effective.seedLimit) ? target.effective.seedLimit : 30
    seedBankFromGit({
      apiUrl: target.server.apiUrl,
      apiToken: target.server.token,
      tokenProvider: liveTokenProvider(target.cwd),
      bankId,
      cwd: target.cwd,
      limit,
      tags: resolveRetainTags(target, settings, ['source:git']),
      observationScopes: target.effective.observationScopes ?? settings.observationScopes,
    })
      .then((res) => {
        if (res.ok) record({ event: 'builtin_seed_ok', bank: bankId, count: res.count })
      })
      .catch(() => {
        // Cold-start seeding is strictly best-effort and must never disturb a turn.
      })
  }

  function maybeSyncBankConfig(target) {
    if (target.server.disabled || target.effective.manageBankConfig !== true) return
    const bankKey = `${target.server.apiUrl}|${target.resolution.bank}`
    if (syncedConfigBanks.has(bankKey)) return
    syncedConfigBanks.add(bankKey)
    syncBankConfig({
      apiUrl: target.server.apiUrl,
      apiToken: target.server.token,
      tokenProvider: liveTokenProvider(target.cwd),
      bankId: target.resolution.bank,
      config: target.effective,
    }).catch(() => {})
  }

  async function maybeWakeDaemon(res, target, timeoutMs) {
    if (res.status !== 0 || target.server.mode !== 'daemon') return false
    const woken = await ensureDaemonAwake({
      apiUrl: target.server.apiUrl,
      apiToken: target.server.token,
      apiPort: target.effective.apiPort ?? 9077,
      daemonIdleTimeout: target.effective.daemonIdleTimeout,
      daemonProfile: target.effective.daemonProfile,
      embedPackagePath: target.effective.embedPackagePath ?? process.env.HINDSIGHT_EMBED_PACKAGE_PATH,
      embedVersion: target.effective.embedVersion ?? process.env.HINDSIGHT_EMBED_VERSION,
      waitMs: Math.min(3000, Math.max(400, Math.floor(timeoutMs * 0.6))),
    })
    if (woken.ok && woken.spawned) {
      record({ event: 'daemon_started', harness: 'dsh', apiUrl: target.server.apiUrl })
    }
    return woken.ok
  }

  function withToolGuideExtra(text, target, firstTurn) {
    if (!text || !firstTurn) return text
    const extra = typeof target.effective.toolGuideExtra === 'string' ? target.effective.toolGuideExtra.trim() : ''
    return extra ? `${text}\n\n${extra}` : text
  }

  function recordFailure(res, target) {
    record({
      event: 'builtin_failed',
      status: res.status ?? 0,
      error: res.error ?? 'request failed',
      endpoint: target.server.apiUrl,
      bank: target.resolution.bank,
    })
  }

  async function fetchPagesPayload(auth, target, query, firstTurn, pageLimit, recallMaxTokens) {
    let search = await searchPages({ ...auth, query, limit: pageLimit })
    if (!search.ok && await maybeWakeDaemon(search, target, auth.timeoutMs)) {
      search = await searchPages({ ...auth, query, limit: pageLimit })
    }
    if (!search.ok) {
      if (search.status === 404) {
        maybeAutoSeed(target)
        return null
      }
      recordFailure(search, target)
      return null
    }

    let hits = search.results
    if (hits.length === 0) {
      const tree = await listPages(auth)
      if (!tree.ok) {
        if (tree.status === 404) maybeAutoSeed(target)
        else recordFailure(tree, target)
        return null
      }
      if (tree.pages.length === 0) {
        maybeAutoSeed(target)
        // Before background consolidation builds Pages, fall back to direct
        // fact recall so recently retained facts are still visible.
        const fallback = await recallMemories({
          ...auth,
          query,
          maxTokens: Math.min(recallMaxTokens, 1200),
          budget: 'low',
        })
        if (fallback.ok && fallback.results.length > 0) {
          const text = `## Hindsight recalled memories\n${fallback.results.map((item) => `- [${item.type}] ${item.text}`).join('\n')}`
          record({ event: 'builtin_recall_ok', count: fallback.results.length, bank: target.resolution.bank })
          record({ event: 'builtin_inject_ok', chars: text.length, mode: 'recall-fallback', bank: target.resolution.bank })
          return text
        }
        return null
      }
      if (!firstTurn) return null
      hits = tree.pages.slice(0, Math.min(3, pageLimit)).map((page) => ({
        id: page.id,
        name: page.name,
        path: page.path,
        snippet: page.description,
        content: '',
      }))
    }

    const candidates = hits.slice(0, pageLimit)
    const hydrated = await Promise.all(
      candidates.map(async (hit) => {
        if (hit.content && hit.content.trim()) {
          return { id: hit.id, title: hit.name || hit.path || hit.id, body: hit.content.trim() }
        }
        const page = await readPage({ ...auth, pageId: hit.id })
        if (page.ok && page.content.trim()) {
          return { id: page.id, title: page.name || hit.name || page.id, body: page.content.trim() }
        }
        const fallbackBody = (hit.snippet ?? '').trim()
        return fallbackBody ? { id: hit.id, title: hit.name || hit.path || hit.id, body: fallbackBody } : null
      }),
    )

    const charCeiling = Math.max(2000, recallMaxTokens * 4)
    const sections = []
    let chars = 0
    for (const item of hydrated) {
      if (!item) continue
      const section = `## ${item.title} (pageId: ${item.id})\n\n${item.body}`
      if (sections.length > 0 && chars + section.length > charCeiling) break
      sections.push(section)
      chars += section.length + 2
    }
    if (sections.length === 0) return null

    const text = sections.join('\n\n')
    record({ event: 'builtin_pages_ok', count: sections.length, bank: target.resolution.bank })
    record({ event: 'builtin_inject_pages', count: sections.length, bank: target.resolution.bank })
    record({ event: 'builtin_inject_ok', chars: text.length, mode: 'pages', bank: target.resolution.bank })
    return text
  }

  async function fetchTurnRecall({ cwd = process.cwd(), promptText = '', firstTurn = false } = {}) {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return null
    const query = String(promptText ?? '').trim()
    if (!query) return null

    const target = resolveRuntimeTarget(cwd)
    if (target.server.disabled) return null
    maybeSyncBankConfig(target)

    const mode = String(target.effective.autoInject ?? settings.autoInject ?? 'pages').toLowerCase()
    if (mode === 'none') return null

    const timeoutMs = Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000
    const recallMaxTokens = Number(
      getPath(target.effective, 'recallOptions.max_tokens') ?? settings.recallMaxTokens ?? 2000,
    ) || 2000
    const pageLimit = Math.max(1, Math.min(25, Number(target.effective.pageSearchLimit ?? 5) || 5))
    const auth = {
      apiUrl: target.server.apiUrl,
      apiToken: target.server.token,
      tokenProvider: liveTokenProvider(target.cwd),
      bankId: target.resolution.bank,
      timeoutMs,
    }

    if (mode === 'recall') {
      let recalled = await recallMemories({
        ...auth,
        query,
        maxTokens: recallMaxTokens,
        budget: target.effective.reflectBudget ?? 'mid',
      })
      if (!recalled.ok && await maybeWakeDaemon(recalled, target, timeoutMs)) {
        recalled = await recallMemories({
          ...auth,
          query,
          maxTokens: recallMaxTokens,
          budget: target.effective.reflectBudget ?? 'mid',
        })
      }
      if (!recalled.ok) {
        if (recalled.status === 404) maybeAutoSeed(target)
        else recordFailure(recalled, target)
        return null
      }
      if (recalled.results.length === 0) return null
      const text = `## Hindsight recalled memories\n${recalled.results.map((item) => `- [${item.type}] ${item.text}`).join('\n')}`
      record({ event: 'builtin_recall_ok', count: recalled.results.length, bank: target.resolution.bank })
      record({ event: 'builtin_inject_ok', chars: text.length, mode: 'recall', bank: target.resolution.bank })
      return withToolGuideExtra(text, target, firstTurn)
    }

    if (mode === 'reflect') {
      const reflectTimeout = Number(target.effective.reflectTimeoutMs ?? timeoutMs) || timeoutMs
      let reflected = await reflectMemories({
        ...auth,
        query,
        budget: target.effective.reflectBudget ?? 'low',
        timeoutMs: reflectTimeout,
      })
      if (!reflected.ok && await maybeWakeDaemon(reflected, target, reflectTimeout)) {
        reflected = await reflectMemories({
          ...auth,
          query,
          budget: target.effective.reflectBudget ?? 'low',
          timeoutMs: reflectTimeout,
        })
      }
      if (!reflected.ok) {
        if (reflected.status === 404) maybeAutoSeed(target)
        else recordFailure(reflected, target)
        return null
      }
      if (!reflected.text) return null
      const text = `## Hindsight reflection\n${reflected.text}`
      record({ event: 'builtin_reflect_ok', bank: target.resolution.bank })
      record({ event: 'builtin_inject_ok', chars: text.length, mode: 'reflect', bank: target.resolution.bank })
      return withToolGuideExtra(text, target, firstTurn)
    }

    const pagesText = await fetchPagesPayload(auth, target, query, firstTurn, pageLimit, recallMaxTokens)
    return withToolGuideExtra(pagesText, target, firstTurn)
  }

  function retainSessionTurns(agent) {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return { queued: 0, reason: 'hooks-disabled' }
    if (settings.allowMemoryRetain === false) return { queued: 0, reason: 'disabled' }
    const session = agent?.session
    if (!session || session.header?.origin === 'subagent') return { queued: 0, reason: 'subagent' }
    const sessionId = session.header?.id ?? null
    if (!sessionId) return { queued: 0, reason: 'no-session' }

    const events = readSessionEvents(session)
    if (events.length === 0) return { queued: 0, reason: 'empty' }

    let state = retainedSessions.get(sessionId)
    if (!state) {
      state = { watermark: 0, turns: 0 }
      rememberSession(retainedSessions, sessionId, state)
    } else {
      rememberSession(retainedSessions, sessionId, state)
    }

    const { exchanges, nextWatermark } = extractCompletedExchanges(
      events,
      state.watermark,
      settings.sourceKind ?? 'plugin:hindsight',
    )
    if (nextWatermark <= state.watermark || exchanges.length === 0) {
      state.watermark = Math.max(state.watermark, nextWatermark)
      return { queued: 0, reason: 'up-to-date' }
    }

    // Advance watermark immediately so concurrent post-step / turn-stopping hooks
    // or frozen-eval turns never enqueue duplicate or leaked retains.
    state.watermark = nextWatermark

    const target = resolveRuntimeTarget(session.header?.cwd)
    if (!retainAllowed(target)) return { queued: 0, reason: 'retain-disabled' }

    const bankId = target.resolution.bank
    const scopes = target.effective.observationScopes ?? settings.observationScopes
    const items = exchanges.map((exchange) => {
      const cleanUser = redactSecrets(exchange.userText).slice(0, 2000)
      const cleanAssistant = redactSecrets(exchange.assistantText).slice(0, 4000)
      const lines = [`Session turn (${target.project.name}):`]
      if (cleanUser) lines.push(`User: ${cleanUser}`)
      if (exchange.actionsText) lines.push(`Actions: ${exchange.actionsText}`)
      lines.push(`Assistant: ${cleanAssistant}`)
      return {
        content: lines.join('\n'),
        context: SESSION_RETAIN_CONTEXT,
        document_id: `dsh:${sessionId}:${exchange.startSeq}-${exchange.endSeq}`,
        ...(exchange.timestamp ? { timestamp: exchange.timestamp } : {}),
        metadata: {
          source: 'chat',
          session_id: sessionId,
          harness: 'dsh',
        },
      }
    })

    state.turns += exchanges.length
    const refreshEvery = Number.isInteger(target.effective.pageRefreshEveryTurns) && target.effective.pageRefreshEveryTurns > 0
      ? target.effective.pageRefreshEveryTurns
      : null
    const shouldReflect = target.effective.autoReflect === true && refreshEvery !== null && state.turns % refreshEvery === 0
    const tags = resolveRetainTags(target, settings, ['source:session', 'source:chat', 'harness:dsh'])
    const maxParallel = Number.isInteger(target.effective.maxParallelRetains) ? target.effective.maxParallelRetains : 2
    const refreshToken = liveTokenProvider(target.cwd)

    scheduleRetainTask(maxParallel, async () => {
      const res = await retainMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: refreshToken,
        bankId,
        items,
        async: true,
        tags,
        strategy: 'conversation',
        observationScopes: scopes,
      })
      if (!res.ok) {
        recordFailure(res, target)
        return
      }
      record({ event: 'builtin_retain_ok', bank: bankId, count: items.length, source: 'session' })
      if (shouldReflect) {
        const reflectRes = await reflectMemories({
          apiUrl: target.server.apiUrl,
          apiToken: target.server.token,
          tokenProvider: refreshToken,
          bankId,
          query: `Consolidate recent coding session updates for ${target.project.name}`,
          budget: 'low',
          timeoutMs: Number(target.effective.reflectTimeoutMs ?? 15000) || 15000,
        })
        if (reflectRes.ok) record({ event: 'builtin_reflect_ok', bank: bankId, source: 'auto-refresh' })
      }
    })

    return { queued: items.length }
  }

  return { fetchTurnRecall, retainSessionTurns, flushRetains }
}

function formatDisabledReason(target) {
  return target.isOptedOut
    ? 'Hindsight is disabled for this directory (optInOnly excludes it).'
    : 'Hindsight is disabled in the effective config (disabled: true).'
}

const SAFE_DIAGNOSTIC_ENV_KEYS = Object.freeze([
  'HINDSIGHT_API_URL',
  'HINDSIGHT_API_PORT',
  'HINDSIGHT_BANK_ID',
  'HINDSIGHT_CONFIG',
  'HINDSIGHT_AUTO_INJECT',
  'HINDSIGHT_DISABLED',
  'HINDSIGHT_RETAIN_SESSIONS',
  'HINDSIGHT_DISABLE_HOOKS',
])

/** Build a secret-free diagnostic payload matching upstream `hindsight_diagnose`. */
export function buildSafeDiagnostics(target, settings = {}) {
  const environment = {}
  for (const key of SAFE_DIAGNOSTIC_ENV_KEYS) {
    environment[key] = process.env[key] ?? null
  }
  environment.HINDSIGHT_API_TOKEN = process.env.HINDSIGHT_API_TOKEN ? '[SET]' : null

  return {
    harness: 'dsh',
    lane: 'builtin',
    bank_id: target.resolution.bank,
    bank_source: target.resolution.source,
    workspace: target.cwd,
    project: target.project,
    config: {
      path: target.file?.path ?? null,
      exists: target.file?.kind === 'ok',
      status: target.file?.kind ?? 'missing',
      server_mode: target.server.mode,
      api_url: target.server.apiUrl,
      api_token_configured: Boolean(target.server.token),
      token_source: target.server.tokenSource ?? null,
      disabled: Boolean(target.server.disabled),
      opt_in_excluded: Boolean(target.isOptedOut),
      auto_inject: String(target.effective.autoInject ?? settings.autoInject ?? 'pages'),
      retain_sessions: retainAllowed(target) && settings.allowMemoryRetain !== false,
    },
    environment,
  }
}

function registerSafe(toolCtx, definition) {
  try {
    toolCtx.tools.register(definition)
  } catch {
    // Another plugin or host layer already registered a tool with the same name.
  }
}

/**
 * Register the native Hindsight page, recall, reflect, and retain tools
 * directly inside this plugin so no secondary plugin is required.
 */
export function registerHindsightTools(toolCtx, settings) {
  if (!toolCtx?.tools || typeof toolCtx.tools.register !== 'function') return

  registerSafe(toolCtx, {
    name: 'hindsight_search_pages',
    description: 'Search structured Hindsight project memory pages (hybrid BM25 + vector search) for architecture, conventions, and past decisions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for project pages.' },
        limit: { type: 'integer', description: 'Maximum pages to return (1..25, default 5).' },
      },
      required: ['query'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const query = String(args?.query ?? '').trim()
      if (!query) return 'hindsight_search_pages: query is required.'
      const limit = Number.isInteger(args?.limit) ? Math.max(1, Math.min(25, args.limit)) : 5
      const res = await searchPages({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        query,
        limit,
        timeoutMs: Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000,
      })
      if (!res.ok) return `hindsight_search_pages failed (${res.status}): ${res.error}`
      record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: res.results.length })
      if (res.results.length === 0) return `No matching pages in bank ${target.resolution.bank}.`
      return [
        `Pages in ${target.resolution.bank} (${res.results.length}):`,
        ...res.results.map((page, index) => {
          const score = page.score != null ? ` · score ${page.score.toFixed(2)}` : ''
          const snippet = page.snippet ? `\n  ${page.snippet.replace(/\s+/g, ' ').slice(0, 200)}` : ''
          return `${index + 1}. [${page.id}] ${page.path || page.name}${score}${snippet}`
        }),
      ].join('\n')
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_list_pages',
    description: 'List the folder and page hierarchy of the current Hindsight project memory bank.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: textOutput(),
    async execute(_args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const res = await listPages({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        timeoutMs: Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000,
        useCache: false,
      })
      if (!res.ok) {
        if (res.status === 404) return `Bank ${target.resolution.bank} is not seeded yet (404).`
        return `hindsight_list_pages failed (${res.status}): ${res.error}`
      }
      record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: res.pages.length })
      if (res.pages.length === 0) return `Bank ${target.resolution.bank} exists but has no pages yet.`
      return [
        `Pages tree for ${target.resolution.bank} (${res.pages.length}):`,
        ...res.pages.map((page) => `- [${page.id}] ${page.path}${page.isStale ? ' (stale)' : ''}${page.description ? ` — ${page.description}` : ''}`),
      ].join('\n')
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_read_page',
    description: 'Read the full markdown content of a Hindsight project memory page by page_id, id, title, or path.',
    parameters: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'Page id returned by hindsight_list_pages, hindsight_search_pages, or [[page:<id>]] links.' },
        id: { type: 'string', description: 'Alias for page_id (id, title, or path).' },
      },
    },
    output: textOutput(),
    async execute(args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const pageId = String(args?.page_id ?? args?.id ?? args?.pageId ?? args?.path ?? '').trim()
      if (!pageId) return 'hindsight_read_page: page_id (or id) is required.'
      const res = await readPage({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        pageId,
        timeoutMs: Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000,
      })
      if (!res.ok) return `hindsight_read_page failed (${res.status}): ${res.error}`
      record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: 1 })
      const staleNote = res.isStale ? ' [stale]' : ''
      return `# ${res.name} (pageId: ${res.id})${staleNote}\n\n${res.content || '(empty page)'}`
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_recall',
    description: 'Recall atomic facts, experiences, and observations from Hindsight using multi-strategy retrieval (semantic, BM25, graph, temporal).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or topic to recall from the project bank.' },
        maxTokens: { type: 'integer', description: 'Optional recall token limit (100..20000).' },
        budget: { type: 'string', enum: ['low', 'mid', 'high'], description: 'Search depth budget (default mid).' },
      },
      required: ['query'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const query = String(args?.query ?? '').trim()
      if (!query) return 'hindsight_recall: query is required.'
      const maxTokens = Number.isInteger(args?.maxTokens)
        ? Math.max(100, Math.min(20000, args.maxTokens))
        : (Number(getPath(target.effective, 'recallOptions.max_tokens') ?? settings.recallMaxTokens ?? 2000) || 2000)
      const budget = ['low', 'mid', 'high'].includes(args?.budget) ? args.budget : 'mid'
      const res = await recallMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        query,
        maxTokens,
        budget,
        timeoutMs: Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000,
      })
      if (!res.ok) return `hindsight_recall failed (${res.status}): ${res.error}`
      record({ event: 'builtin_recall_ok', bank: target.resolution.bank, count: res.results.length })
      if (res.results.length === 0) return `No matching memories in bank ${target.resolution.bank}.`
      return [
        `Recalled memories from ${target.resolution.bank} (${res.results.length}):`,
        ...res.results.map((item) => `- [${item.type}] ${item.text}${item.context ? ` (context: ${item.context})` : ''}`),
      ].join('\n')
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_reflect',
    description: 'Run Hindsight agentic reflection over the memory bank to synthesize patterns or reasoning about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or synthesis prompt for Hindsight reflect.' },
        budget: { type: 'string', enum: ['low', 'mid', 'high'], description: 'Reflection reasoning budget (default low).' },
      },
      required: ['query'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const query = String(args?.query ?? '').trim()
      if (!query) return 'hindsight_reflect: query is required.'
      const budget = ['low', 'mid', 'high'].includes(args?.budget)
        ? args.budget
        : (target.effective.reflectBudget ?? 'low')
      const res = await reflectMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        query,
        budget,
        timeoutMs: Number(target.effective.reflectToolTimeoutMs ?? target.effective.reflectTimeoutMs ?? 15000) || 15000,
      })
      if (!res.ok) return `hindsight_reflect failed (${res.status}): ${res.error}`
      record({ event: 'builtin_reflect_ok', bank: target.resolution.bank })
      return res.text || `No reflection produced for bank ${target.resolution.bank}.`
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_sync_status',
    description: 'Check Hindsight bank synchronization status: seeded documents, page counts, and active background extraction or consolidation operations.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: textOutput(),
    async execute(_args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      if (target.server.disabled) return formatDisabledReason(target)
      const timeoutMs = Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000
      const res = await fetchSyncStatus({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        tokenProvider: liveTokenProvider(target.cwd),
        bankId: target.resolution.bank,
        timeoutMs,
      })
      if (!res.ok) return `hindsight_sync_status failed (${res.status}): ${res.error}`
      if (res.pagesCount > 0) {
        record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: res.pagesCount })
      }
      return [
        `Sync status for bank ${target.resolution.bank}: synced=${res.synced ? 'yes' : 'no'}`,
        `  bank_exists: ${res.bankExists ? 'yes' : 'no'}`,
        `  documents_seeded: ${res.hasDocuments ? 'yes' : 'no'}`,
        `  pages: ${res.pagesCount}${res.stalePages > 0 ? ` (${res.stalePages} stale)` : ''}`,
        `  active_operations: ${res.activeOperations}`,
        `  pending_consolidation: ${res.pendingConsolidation}`,
        `  nodes: ${res.totalNodes} · observations: ${res.totalObservations}`,
      ].join('\n')
    },
  })

  registerSafe(toolCtx, {
    name: 'hindsight_diagnose',
    description: 'Return a safe, secret-redacted diagnostic snapshot of Hindsight resolution (bank id, workspace, harness, server mode, config file, and environment flags).',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: textOutput(),
    async execute(_args, exec) {
      const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
      return JSON.stringify(buildSafeDiagnostics(target, settings), null, 2)
    },
  })

  if (settings.allowMemoryRetain !== false) {
    registerSafe(toolCtx, {
      name: 'hindsight_retain',
      description: 'Store a verified project fact, architecture decision, or debugging lesson into the Hindsight memory bank.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Verified fact or lesson to store (include file path or commit SHA anchor when possible).' },
          context: { type: 'string', description: 'Optional short context label (e.g. architecture, convention, bugfix).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional scope tags.' },
          documentId: { type: 'string', description: 'Optional stable document_id for idempotent updates.' },
        },
        required: ['content'],
      },
      output: textOutput(),
      async execute(args, exec) {
        const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
        if (!retainAllowed(target)) {
          return target.server.disabled
            ? formatDisabledReason(target)
            : 'Refused: memory retention is disabled (HINDSIGHT_RETAIN_SESSIONS=false or retainSessions: false).'
        }
        const rawContent = String(args?.content ?? '').trim()
        if (!rawContent) return 'hindsight_retain: content is required.'
        const content = redactSecrets(rawContent)
        const item = {
          content,
          ...(typeof args?.context === 'string' && args.context.trim() ? { context: args.context.trim() } : {}),
          ...(typeof args?.documentId === 'string' && args.documentId.trim() ? { document_id: args.documentId.trim() } : {}),
        }
        const tags = resolveRetainTags(target, settings, [...(Array.isArray(args?.tags) ? args.tags : []), 'harness:dsh'])
        const scopes = target.effective.observationScopes ?? settings.observationScopes
        const res = await retainMemories({
          apiUrl: target.server.apiUrl,
          apiToken: target.server.token,
          tokenProvider: liveTokenProvider(target.cwd),
          bankId: target.resolution.bank,
          items: [item],
          async: true,
          tags,
          strategy: 'document',
          observationScopes: scopes,
        })
        if (!res.ok) return `hindsight_retain failed (${res.status}): ${res.error}`
        record({ event: 'builtin_retain_ok', bank: target.resolution.bank, count: 1 })
        return `Retained memory item into bank ${target.resolution.bank} (status ${res.status}${res.operationId ? `, operation ${res.operationId}` : ''}).`
      },
    })

    registerSafe(toolCtx, {
      name: 'hindsight_ingest_document',
      description: 'Save a durable note, design document, or "Correction: <topic>" record into the repository memory bank (newer facts supersede stale ones).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title (e.g. "Correction: token ceiling" or "Architecture notes").' },
          content: { type: 'string', description: 'Document or verified correction body to ingest.' },
        },
        required: ['title', 'content'],
      },
      output: textOutput(),
      async execute(args, exec) {
        const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
        if (!retainAllowed(target)) {
          return target.server.disabled
            ? formatDisabledReason(target)
            : 'Refused: memory retention is disabled (HINDSIGHT_RETAIN_SESSIONS=false or retainSessions: false).'
        }
        const title = String(args?.title ?? '').trim()
        const rawContent = String(args?.content ?? '').trim()
        if (!title || !rawContent) return 'hindsight_ingest_document: title and content are required.'
        const content = redactSecrets(rawContent)
        const docId = documentIdForTitle(title)
        const tags = resolveRetainTags(target, settings, ['source:upload', 'harness:dsh'])
        const scopes = target.effective.observationScopes ?? settings.observationScopes
        const res = await retainMemories({
          apiUrl: target.server.apiUrl,
          apiToken: target.server.token,
          tokenProvider: liveTokenProvider(target.cwd),
          bankId: target.resolution.bank,
          items: [{
            content: `# ${redactSecrets(title)}\n\n${content}`,
            context: 'ingested document',
            document_id: docId,
            metadata: { title: redactSecrets(title), harness: 'dsh' },
          }],
          async: true,
          tags,
          strategy: 'document',
          observationScopes: scopes,
        })
        if (!res.ok) return `hindsight_ingest_document failed (${res.status}): ${res.error}`
        record({ event: 'builtin_retain_ok', bank: target.resolution.bank, count: 1 })
        return `Ingested document "${title}" (doc_id: ${docId}) into bank ${target.resolution.bank}.`
      },
    })

    registerSafe(toolCtx, {
      name: 'hindsight_capture_initiative',
      description: 'Record a new feature/initiative as a tracked page under Initiatives, or update an existing initiative page when scope/rationale changes.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short specific name of the initiative.' },
          summary: { type: 'string', description: '2-3 sentences describing what is being built/changed and why.' },
          relates_to_page_id: { type: 'string', description: 'Existing initiative page id when updating an in-flight initiative.' },
        },
        required: ['title', 'summary'],
      },
      output: textOutput(),
      async execute(args, exec) {
        const target = resolveRuntimeTarget(exec?.agent?.session?.header?.cwd)
        if (!retainAllowed(target)) {
          return target.server.disabled
            ? formatDisabledReason(target)
            : 'Refused: memory retention is disabled (HINDSIGHT_RETAIN_SESSIONS=false or retainSessions: false).'
        }
        const title = redactSecrets(String(args?.title ?? '').trim())
        const summary = redactSecrets(String(args?.summary ?? '').trim())
        if (!title || !summary) return 'hindsight_capture_initiative: title and summary are required.'
        const tags = resolveRetainTags(target, settings, ['source:upload', 'harness:dsh'])
        const scopes = target.effective.observationScopes ?? settings.observationScopes
        const res = await captureInitiative({
          apiUrl: target.server.apiUrl,
          apiToken: target.server.token,
          tokenProvider: liveTokenProvider(target.cwd),
          bankId: target.resolution.bank,
          project: target.project.name,
          title,
          summary,
          relatesToPageId: args?.relates_to_page_id,
          tags,
          observationScopes: scopes,
        })
        if (!res.ok) return `hindsight_capture_initiative failed (${res.status}): ${res.error}`
        record({ event: 'builtin_retain_ok', bank: target.resolution.bank, count: 1 })
        return `Captured initiative "${title}" (page_id: ${res.pageId}) in bank ${target.resolution.bank}.`
      },
    })
  }
}
