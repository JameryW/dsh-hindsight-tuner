/**
 * Hindsight memory engine, budget governor, and diagnostics for DeepSeek Harness.
 *
 * `@jameryw/dsh-hindsight-tuner` works standalone as a single plugin (built-in
 * Hindsight v1 REST client + native page/recall/reflect/retain tools + Git
 * seeding) and seamlessly coexists with `@vectorize-io/hindsight-coding-agents`
 * as an outer governance & diagnostic plane when that bundle is also active.
 */

import {
  fetchBankStats,
  listPages,
  recallMemories,
  reflectMemories,
  retainMemories,
  searchPages,
  seedBankFromGit,
} from './lib/client.js'
import {
  appliedPaths,
  applyTuning,
  autoTuneEnabled,
  configPath,
  getPath,
  readConfigFile,
  revertTuning,
  setAutoTune,
  sweepStaleTemps,
  tunerState,
} from './lib/config-file.js'
import {
  bankResolution,
  effectiveConfig,
  effectiveServer,
  findIntegration,
  hotReloadDiagnostics,
  installedBundles,
  legacyToolNames,
  optedOut,
  probeServer,
  projectName,
  summarizeActivity,
} from './lib/diagnostics.js'
import {
  ACCEPTED_INTEGRATION_LINES,
  TESTED_INTEGRATION,
  formatBankStats,
  formatProbe,
  formatRevert,
  formatStatus,
  formatSuggestion,
  formatTune,
  hintFor,
  memoryMetrics,
  originOf,
  staleProcess,
} from './lib/format.js'
import { createGovernor } from './lib/governor.js'
import { flushJournal, record, summarizeTunerJournal } from './lib/log.js'
import {
  createMemoryLane,
  redactSecrets,
  registerHindsightTools,
  resolveRuntimeTarget,
} from './lib/memory-lane.js'
import { DEFAULT_SCENARIO_TIERS, SCENARIO_NAMES, SCENARIO_TIER_NAMES } from './lib/scenario.js'
import { countTokens, estimateTokens, loadTokenizer, percentile } from './lib/tokens.js'
import { validateConfig, validateSettings } from './lib/validate.js'
import { DEFAULT_VIEW_CONTEXT_MESSAGES } from './lib/view.js'

const PLUGIN = 'hindsight-tuner'
const ACTIONS = ['status', 'tune', 'revert', 'probe', 'suggest', 'enable', 'disable']
const READ_ACTIONS = ['status', 'probe', 'suggest']
const COMMAND_ACTIONS = [...ACTIONS, 'seed', 'pages', 'recall', 'reflect', 'retain', 'stats']

export const TUNER_ENV_KEYS = Object.freeze({
  viewPolicy: 'HINDSIGHT_TUNER_VIEW_POLICY',
  budgetPolicy: 'HINDSIGHT_TUNER_BUDGET_POLICY',
  maxInjectTokens: 'HINDSIGHT_TUNER_MAX_INJECT_TOKENS',
  tokenBudgetMode: 'HINDSIGHT_TUNER_TOKEN_MODE',
  repeatPolicy: 'HINDSIGHT_TUNER_REPEAT_POLICY',
  verifyReminder: 'HINDSIGHT_TUNER_VERIFY_REMINDER',
  memoryLane: 'HINDSIGHT_TUNER_MEMORY_LANE',
})

function envString(env, name) {
  const val = env?.[name]
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : undefined
}

function envBoolean(raw) {
  const lowered = raw.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false
  return raw
}

function envInteger(raw) {
  if (/^[+-]?\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return raw
}

export const name = PLUGIN

function normalizeScenarioTiers(raw) {
  const tiers = { ...DEFAULT_SCENARIO_TIERS }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [scenarioName, value] of Object.entries(raw)) {
      const scenario = String(scenarioName).toLowerCase()
      const tier = typeof value === 'string' ? value.toLowerCase() : null
      if (SCENARIO_NAMES.includes(scenario) && SCENARIO_TIER_NAMES.includes(tier)) tiers[scenario] = tier
    }
  }
  return tiers
}

function normalizeConfig(input, env = process.env) {
  const raw = input && typeof input === 'object' ? input : {}
  const envCap = envString(env, TUNER_ENV_KEYS.maxInjectTokens)
  const envBudgetPolicy = envString(env, TUNER_ENV_KEYS.budgetPolicy)
  const envRepeatPolicy = envString(env, TUNER_ENV_KEYS.repeatPolicy)
  const envVerify = envString(env, TUNER_ENV_KEYS.verifyReminder)
  const envViewPolicy = envString(env, TUNER_ENV_KEYS.viewPolicy)
  const envTokenMode = envString(env, TUNER_ENV_KEYS.tokenBudgetMode)
  const envLane = envString(env, TUNER_ENV_KEYS.memoryLane)

  const rawTiers = raw.budgetTiers
  const budgetTiers = rawTiers === undefined
    ? { light: 800, normal: 1600, deep: 3000 }
    : (rawTiers !== null && typeof rawTiers === 'object' && !Array.isArray(rawTiers))
      ? {
          light: rawTiers.light === undefined ? 800 : rawTiers.light,
          normal: rawTiers.normal === undefined ? 1600 : rawTiers.normal,
          deep: rawTiers.deep === undefined ? 3000 : rawTiers.deep,
        }
      : rawTiers
  const maxInjectRaw = envCap !== undefined ? envInteger(envCap) : raw.maxInjectTokens
  const budgetPolicyRaw = envBudgetPolicy ?? raw.budgetPolicy
  const repeatPolicyRaw = envRepeatPolicy ?? raw.repeatPolicy
  const verifyRaw = envVerify !== undefined ? envBoolean(envVerify) : raw.verifyReminder
  const viewPolicyRaw = envViewPolicy ?? raw.viewPolicy
  const tokenModeRaw = envTokenMode ?? raw.tokenBudgetMode
  const memoryLaneRaw = envLane ?? raw.memoryLane

  return {
    autoTune: raw.autoTune !== false,
    overwrite: raw.overwrite === true,
    maxInjectTokens: maxInjectRaw === undefined ? 3000 : maxInjectRaw,
    autoInject: raw.autoInject === undefined ? 'pages' : raw.autoInject,
    injectTimeoutMs: raw.injectTimeoutMs === undefined ? 7000 : raw.injectTimeoutMs,
    observationScopes: raw.observationScopes === undefined ? 'per_source' : raw.observationScopes,
    recallMaxTokens: raw.recallMaxTokens === undefined ? 2000 : raw.recallMaxTokens,
    sourceKind: raw.sourceKind === undefined ? 'plugin:hindsight' : raw.sourceKind,
    budgetPolicy: budgetPolicyRaw === undefined
      ? 'off'
      : (typeof budgetPolicyRaw === 'string' ? budgetPolicyRaw.toLowerCase() : budgetPolicyRaw),
    budgetTiers,
    scenarioTiers: raw.scenarioTiers,
    repeatPolicy: repeatPolicyRaw === undefined
      ? 'inject'
      : (typeof repeatPolicyRaw === 'string' ? repeatPolicyRaw.toLowerCase() : repeatPolicyRaw),
    repeatThreshold: raw.repeatThreshold === undefined ? 0.9 : raw.repeatThreshold,
    verifyReminder: verifyRaw === undefined ? false : verifyRaw,
    viewPolicy: viewPolicyRaw === undefined
      ? 'truncate'
      : (typeof viewPolicyRaw === 'string' ? viewPolicyRaw.toLowerCase() : viewPolicyRaw),
    viewContextMessages: raw.viewContextMessages === undefined ? DEFAULT_VIEW_CONTEXT_MESSAGES : raw.viewContextMessages,
    tokenBudgetMode: tokenModeRaw === undefined
      ? 'fast'
      : (typeof tokenModeRaw === 'string' ? tokenModeRaw.toLowerCase() : tokenModeRaw),
    allowAgentWrites: raw.allowAgentWrites === true,
    // Standalone / single-plugin controls:
    memoryLane: memoryLaneRaw === undefined
      ? 'auto'
      : (typeof memoryLaneRaw === 'string' ? memoryLaneRaw.toLowerCase() : memoryLaneRaw),
    builtinTools: raw.builtinTools === undefined
      ? 'auto'
      : (typeof raw.builtinTools === 'string' ? raw.builtinTools.toLowerCase() : raw.builtinTools),
    allowMemoryRetain: raw.allowMemoryRetain === undefined ? true : raw.allowMemoryRetain,
    autoSeed: raw.autoSeed === undefined ? false : raw.autoSeed,
  }
}

function resolveActiveLane(settings, integration) {
  const externalActive = Boolean(integration?.installed && integration?.enabled !== false)
  if (settings.memoryLane === 'off') return 'off'
  if (settings.memoryLane === 'builtin') return 'builtin'
  if (settings.memoryLane === 'external') return externalActive ? 'external' : 'missing-external'
  return externalActive ? 'external' : 'builtin'
}

function integrationCompatibility(integration) {
  if (!integration.installed) return null
  const version = integration.version
  const match = version ? /^(\d+)\.(\d+)/.exec(version) : null
  const line = match ? `${match[1]}.${match[2]}` : null
  const status = line === null
    ? 'unknown'
    : line === TESTED_INTEGRATION.line
      ? 'tested'
      : ACCEPTED_INTEGRATION_LINES.includes(line)
        ? 'accepted'
        : 'untested'
  return {
    version,
    tested: TESTED_INTEGRATION.version,
    line,
    status,
    accepted: ACCEPTED_INTEGRATION_LINES,
    compatible: line === null ? null : status === 'tested' || status === 'accepted',
  }
}

async function buildStatus(settings, stats, governor, cwd = process.cwd(), sessionId = null, { skipProbe = false } = {}) {
  const file = readConfigFile()
  const integration = findIntegration()
  const activeLane = resolveActiveLane(settings, integration)
  const bundles = installedBundles()
  const project = projectName(cwd)
  const baseLayers = effectiveConfig(file.config, { cwd })
  const resolution = bankResolution(baseLayers.config, project.name, cwd)
  const layers = effectiveConfig(file.config, { cwd, bank: resolution.base ?? resolution.bank })
  const effective = layers.config
  const isOptedOut = optedOut(effective, cwd)
  const resolvedServer = effectiveServer(effective, {}, { tokenSource: layers.tokenSource })
  const disabled = resolvedServer.disabled || isOptedOut
  const server = { ...resolvedServer, disabled }

  const shouldProbe = !skipProbe && !server.disabled && activeLane !== 'missing-external' && activeLane !== 'off'
  const probe = shouldProbe
    ? await probeServer({
        apiUrl: server.apiUrl,
        apiToken: server.token,
        bankId: resolution.bank,
        timeoutMs: 4000,
      })
    : null

  const session = governor.session(sessionId)
  const ratios = stats.ratios ?? []
  const expectedOrigin = originOf(server.apiUrl)
  const charRatio = stats.totalChars > 0 ? Math.round((stats.totalTokens / stats.totalChars) * 100) / 100 : null
  const usableRatio = Number.isFinite(charRatio) && charRatio >= 0.22 && charRatio <= 1.10
  const activity = summarizeActivity({
    expectedOrigin,
    harness: 'dsh',
    tokenRatio: usableRatio ? charRatio : null,
  })
  const history = summarizeTunerJournal({ windowHours: 24 })
  const lastInjectAt = activity.lastInject?.ts ? Date.parse(activity.lastInject.ts) : Number.NaN
  const injectSinceBoot = Number.isFinite(lastInjectAt) && Number.isFinite(stats.activatedAt) && lastInjectAt >= stats.activatedAt

  const status = {
    file: { path: file.path, kind: file.kind, error: file.error ?? null },
    integration,
    lane: {
      active: activeLane,
      configured: settings.memoryLane,
      tools: settings.builtinTools === true || (settings.builtinTools === 'auto' && activeLane === 'builtin'),
      retain: settings.allowMemoryRetain !== false,
    },
    compat: integrationCompatibility(integration),
    runtime: hotReloadDiagnostics(null),
    server: {
      mode: server.mode,
      apiUrl: server.apiUrl,
      disabled: server.disabled,
      disabledReason: server.disabled
        ? (isOptedOut ? 'optInOnly excludes this directory' : 'disabled is set in the effective config')
        : null,
      tokenSet: server.tokenSet,
      tokenSource: server.tokenSource,
    },
    bank: resolution.bank,
    bankSource: resolution.source,
    bankBase: resolution.base ?? null,
    project,
    bundles: bundles.bundles,
    bundleProfile: bundles.profile,
    bundleRoots: bundles.roots,
    legacyTools: legacyToolNames(bundles.roots),
    sources: { ...stats.sources },
    stackTurns: stats.stackTurns,
    lastStack: stats.lastStack,
    autoTune: autoTuneEnabled(),
    tuneError: stats.lastTuneError ?? null,
    settingsIssues: settings.issues ?? [],
    configIssues: validateConfig(effective),
    tokens: {
      mode: stats.tokenizer?.mode ?? settings.tokenBudgetMode,
      name: stats.tokenizer?.name ?? null,
      ready: stats.tokenizer?.ready ?? false,
      p50: percentile(ratios, 50),
      p95: percentile(ratios, 95),
      samples: ratios.length,
    },
    preset: {
      autoInject: getPath(file.config, 'autoInject') ?? null,
      injectTimeoutMs: getPath(file.config, 'injectTimeoutMs') ?? null,
      observationScopes: getPath(file.config, 'observationScopes') ?? null,
      recallMaxTokens: getPath(file.config, 'recallOptions.max_tokens') ?? null,
    },
    effective: {
      autoInject: effective.autoInject ?? null,
      injectTimeoutMs: effective.injectTimeoutMs ?? null,
      observationScopes: effective.observationScopes ?? null,
      recallMaxTokens: getPath(effective, 'recallOptions.max_tokens') ?? null,
      pageSearchLimit: effective.pageSearchLimit ?? null,
    },
    layers: { env: layers.envKeys, harness: layers.harnessKeys, sections: layers.sections },
    desired: {
      autoInject: settings.autoInject,
      injectTimeoutMs: settings.injectTimeoutMs,
      observationScopes: settings.observationScopes,
      recallMaxTokens: settings.recallMaxTokens,
    },
    applied: appliedPaths(),
    budget: {
      cap: settings.maxInjectTokens,
      policy: settings.budgetPolicy,
      tiers: settings.budgetTiers,
      tier: stats.lastTier,
      tierCounts: { ...stats.tiers },
      scenarioTiers: settings.scenarioTiers,
      scenarios: { ...stats.scenarios },
      lastScenario: stats.lastScenario,
      repeatPolicy: settings.repeatPolicy,
      repeatThreshold: settings.repeatThreshold,
      verifyReminder: settings.verifyReminder,
      repeatSkips: stats.repeatSkips,
      savedTokens: stats.savedTokens,
      reentered: stats.reentered,
      deltas: stats.deltas,
      deltaSaved: stats.deltaSaved,
      viewPolicy: settings.viewPolicy,
      viewContextMessages: settings.viewContextMessages,
      viewTurns: stats.viewTurns,
      viewKept: stats.viewKept,
      viewOmitted: stats.viewOmitted,
      trimmedTokens: stats.trimmedTokens,
      charRatio,
      lastRepeat: stats.lastRepeat,
      preSteps: stats.preSteps,
      prestepErrors: stats.prestepErrors,
      injectSinceBoot,
      turns: stats.turns,
      seen: stats.seen,
      lastTurnTokens: stats.lastTurnTokens,
      maxTurnTokens: stats.maxTurnTokens,
      capped: stats.capped,
      dropped: stats.dropped,
      last: stats.last,
      session: session
        ? {
            turns: session.turns,
            snapshot: session.snapshot ?? 0,
            last: session.last,
            max: session.max,
            tokens: session.tokens,
            injected: session.injected ?? 0,
            lastInjected: session.lastInjected ?? session.last,
            tier: session.tier ?? null,
            scenario: session.scenario ?? null,
            capped: session.capped,
            dropped: session.dropped,
            skipped: session.skipped,
            trimmedTokens: session.trimmedTokens,
            reentered: session.reentered ?? 0,
            deltas: session.deltas ?? 0,
          }
        : null,
    },
    probe,
    activity,
    history,
    memory: memoryMetrics(activity, history),
  }
  status.stale = staleProcess(status)
  status.hint = hintFor(status)
  return status
}

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const checked = validateSettings(settings)
  settings.issues = checked.issues
  settings.preset = checked.preset
  const issueFields = new Set(settings.issues.map((issue) => issue.field))
  if (issueFields.has('autoInject')) settings.autoInject = 'pages'
  if (issueFields.has('injectTimeoutMs')) settings.injectTimeoutMs = 7000
  if (issueFields.has('observationScopes')) settings.observationScopes = 'per_source'
  if (issueFields.has('recallMaxTokens')) settings.recallMaxTokens = 2000
  if (issueFields.has('maxInjectTokens')) settings.maxInjectTokens = 3000
  if (issueFields.has('sourceKind')) settings.sourceKind = 'plugin:hindsight'
  if (issueFields.has('tokenBudgetMode')) settings.tokenBudgetMode = 'fast'
  if (issueFields.has('budgetPolicy')) settings.budgetPolicy = 'off'
  if (issueFields.has('budgetTiers')) settings.budgetTiers = { light: 800, normal: 1600, deep: 3000 }
  if (issueFields.has('repeatPolicy')) settings.repeatPolicy = 'inject'
  if (issueFields.has('repeatThreshold')) settings.repeatThreshold = 0.9
  if (issueFields.has('verifyReminder')) settings.verifyReminder = false
  if (issueFields.has('viewPolicy')) settings.viewPolicy = 'truncate'
  if (issueFields.has('viewContextMessages')) settings.viewContextMessages = DEFAULT_VIEW_CONTEXT_MESSAGES
  if (issueFields.has('memoryLane')) settings.memoryLane = 'auto'
  if (issueFields.has('builtinTools')) settings.builtinTools = 'auto'
  if (issueFields.has('allowMemoryRetain')) settings.allowMemoryRetain = true
  if (issueFields.has('autoSeed')) settings.autoSeed = false
  settings.scenarioTiers = normalizeScenarioTiers(settings.scenarioTiers)

  try {
    sweepStaleTemps(configPath())
    sweepStaleTemps(tunerState().path)
  } catch {
    // Housekeeping must never fail plugin activation.
  }

  const stats = {
    activatedAt: Date.now(),
    preSteps: 0,
    prestepErrors: 0,
    turns: 0,
    seen: 0,
    lastTurnTokens: 0,
    maxTurnTokens: 0,
    capped: 0,
    dropped: 0,
    stackTurns: 0,
    lastStack: null,
    last: null,
    sources: {},
    tiers: { light: 0, normal: 0, deep: 0 },
    lastTier: null,
    scenarios: {},
    lastScenario: null,
    repeatSkips: 0,
    savedTokens: 0,
    reentered: 0,
    deltas: 0,
    deltaSaved: 0,
    viewTurns: 0,
    viewKept: 0,
    viewOmitted: 0,
    trimmedTokens: 0,
    totalChars: 0,
    totalTokens: 0,
    lastRepeat: 0,
    ratios: [],
    lastTuneError: null,
    tokenizer: {
      mode: settings.tokenBudgetMode,
      name: settings.tokenBudgetMode === 'calibrated' ? 'built-in calibrated BPE' : null,
      ready: settings.tokenBudgetMode === 'fast' || settings.tokenBudgetMode === 'calibrated',
    },
  }

  let tokenizer = null
  if (settings.tokenBudgetMode === 'accurate') {
    loadTokenizer()
      .then((loaded) => {
        tokenizer = loaded
        stats.tokenizer = { mode: 'accurate', name: loaded?.name ?? null, ready: Boolean(loaded) }
        record({ event: 'tokenizer', mode: 'accurate', name: loaded?.name ?? null })
      })
      .catch(() => { /* the estimate still applies */ })
  }

  const meter = {
    mode: settings.tokenBudgetMode,
    fastCount: settings.tokenBudgetMode === 'fast' ? estimateTokens : null,
    measure(text) {
      const counted = countTokens(text, { mode: settings.tokenBudgetMode, encode: tokenizer?.encode })
      if ((settings.tokenBudgetMode === 'accurate' || settings.tokenBudgetMode === 'calibrated') && counted.exact) {
        const fast = estimateTokens(text)
        if (fast > 0) stats.ratios.push(counted.tokens / fast)
        while (stats.ratios.length > 200) stats.ratios.shift()
      }
      return counted.tokens
    },
    count(text) {
      return countTokens(text, { mode: settings.tokenBudgetMode, encode: tokenizer?.encode }).tokens
    },
  }

  const preset = settings.preset ?? []
  let tuning = null
  let disposePreStep = null
  let disposed = false

  function ensureTuned() {
    if (tuning) return tuning
    tuning = (async () => {
      if (!settings.autoTune) return { skipped: true, reason: 'autoTune is off' }
      if (!autoTuneEnabled()) {
        record({ event: 'tune_skipped', reason: 'persisted opt-out' })
        return { skipped: true, reason: 'auto-tune is off (persisted; /hindsight enable)' }
      }
      try {
        const result = applyTuning({ preset, overwrite: settings.overwrite })
        stats.lastTuneError = null
        record({ event: 'tune_applied', changed: result.changed.map((change) => change.path) })
        return result
      } catch (error) {
        const message = String(error?.message ?? error)
        stats.lastTuneError = message
        record({ event: 'tune_failed', error: message })
        return { error: message }
      }
    })()
    return tuning
  }

  const memoryLane = createMemoryLane(settings)

  function maybeRetainSession(payload) {
    if (disposed || settings.allowMemoryRetain === false) return
    const agent = payload?.agent ?? payload
    if (!agent?.session || agent.session?.header?.origin === 'subagent') return
    if (resolveActiveLane(settings, findIntegration()) !== 'builtin') return
    memoryLane.retainSessionTurns(agent)
  }

  const governor = createGovernor(settings, stats, meter, {
    onBeforeStep(payload) {
      if (settings.autoTune && !tuning && payload?.agent?.session?.header?.origin !== 'subagent') {
        ensureTuned().catch(() => {})
      }
      maybeRetainSession(payload)
    },
    fetchRecall(context) {
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane !== 'builtin') return null
      return memoryLane.fetchTurnRecall(context)
    },
  })

  function attachPreStep() {
    if (disposed) return
    try { disposePreStep?.() } catch { /* already gone */ }
    disposePreStep = ctx.on('agent/pre-step', governor.onPreStep, { prepend: true })
  }

  attachPreStep()

  const disposeAgents = typeof ctx.inject === 'function'
    ? ctx.inject(['agents'], () => {
        attachPreStep()
      })
    : null

  function onSessionLifecycle(payload) {
    const agent = payload?.agent ?? payload
    attachPreStep()
    if (agent?.session?.header?.origin === 'subagent') return
    ensureTuned().catch(() => {})
  }

  const disposeCreated = ctx.on('agent/created', onSessionLifecycle)
  const disposeSessionStart = ctx.on('agent/session-start', onSessionLifecycle)
  const disposePostStep = ctx.on('agent/post-step', maybeRetainSession)
  const disposeTurnStopping = ctx.on('agent/turn-stopping', maybeRetainSession)
  const disposeTurnEnd = ctx.on('agent/turn-end', maybeRetainSession)
  const disposeSessionEnd = ctx.on('agent/session-end', maybeRetainSession)
  const disposeDisposed = ctx.on('agent/disposed', maybeRetainSession)
  ctx.effect(() => () => {
    disposed = true
    try { disposePreStep?.() } catch { /* already gone */ }
    try { disposeAgents?.() } catch { /* already gone */ }
    try { disposeCreated?.() } catch { /* already gone */ }
    try { disposeSessionStart?.() } catch { /* already gone */ }
    try { disposePostStep?.() } catch { /* already gone */ }
    try { disposeTurnStopping?.() } catch { /* already gone */ }
    try { disposeTurnEnd?.() } catch { /* already gone */ }
    try { disposeSessionEnd?.() } catch { /* already gone */ }
    try { disposeDisposed?.() } catch { /* already gone */ }
    governor.dispose()
    flushJournal()
  })
  record({
    event: 'activated',
    autoTune: settings.autoTune,
    cap: settings.maxInjectTokens,
    recall: settings.recallMaxTokens,
    budgetPolicy: settings.budgetPolicy,
    repeatPolicy: settings.repeatPolicy,
    verifyReminder: Boolean(settings.verifyReminder),
    tokenBudgetMode: settings.tokenBudgetMode,
    memoryLane: settings.memoryLane,
  })

  function mayWrite(action, options) {
    if (!options.viaTool) return true
    if (options.dryRun === true && (action === 'tune' || action === 'revert')) return true
    return settings.allowAgentWrites
  }

  const refusal = 'Refused: this writes the shared Hindsight config, and agent writes are disabled for this bundle. Ask the user to run /hindsight tune (or /hindsight revert), or set allowAgentWrites: true in the bundle config.'

  async function runAction(action, options = {}) {
    const cwd = options.cwd ?? process.cwd()
    const writes = ['tune', 'revert', 'enable', 'disable']
    if (writes.includes(action) && !mayWrite(action, options)) return refusal

    if (action === 'tune') {
      const dryRun = options.dryRun === true
      if (options.cap !== undefined) {
        if (!Number.isInteger(options.cap) || options.cap < 0 || options.cap > 64000) {
          return 'Refused: --cap must be an integer 0..64000 (0 turns the cap off).'
        }
        if (!dryRun) {
          settings.maxInjectTokens = options.cap
          record({ event: 'cap_changed', cap: options.cap, scope: 'session' })
        }
      }
      const result = applyTuning({
        preset,
        overwrite: options.overwrite ?? settings.overwrite,
        dryRun,
        enableAutoTune: !dryRun,
      })
      if (!dryRun) {
        stats.lastTuneError = null
        settings.autoTune = true
        tuning = Promise.resolve(result)
      }
      record({ event: dryRun ? 'tune_previewed' : 'tune_requested', changed: result.changed.map((change) => change.path) })
      return formatTune(result)
    }
    if (action === 'revert') {
      const dryRun = options.dryRun === true
      const result = revertTuning({ dryRun })
      if (!dryRun) {
        settings.autoTune = false
        tuning = Promise.resolve({ skipped: true, reason: 'reverted' })
      }
      record({ event: dryRun ? 'revert_previewed' : 'tune_reverted', reverted: result.reverted.map((entry) => entry.path) })
      return formatRevert(result)
    }
    if (action === 'disable') {
      setAutoTune(false)
      settings.autoTune = false
      tuning = Promise.resolve({ skipped: true, reason: 'auto-tune disabled' })
      record({ event: 'autotune_disabled' })
      return 'Auto-tune disabled for this profile. Existing config keys are untouched; /hindsight enable restores automatic tuning.'
    }
    if (action === 'enable') {
      setAutoTune(true)
      settings.autoTune = true
      tuning = null
      record({ event: 'autotune_enabled' })
      return 'Auto-tune enabled. It applies from this turn on; /hindsight tune applies the lean profile right away.'
    }
    if (action === 'seed') {
      const integration = findIntegration()
      const lane = resolveActiveLane(settings, integration)
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      if (process.env.HINDSIGHT_RETAIN_SESSIONS === 'false' || target.effective.retainSessions === false) {
        return 'Refused: session retention is disabled (HINDSIGHT_RETAIN_SESSIONS=false or retainSessions: false).'
      }
      const limit = options.limit ?? (Number.isFinite(target.effective.seedLimit) ? target.effective.seedLimit : 30)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return 'Refused: --limit must be an integer 1..500.'
      }
      const scopes = target.effective.observationScopes ?? settings.observationScopes
      const tags = scopes === 'per_source' ? ['source:git', 'source:dsh', 'harness:dsh'] : ['source:git', 'harness:dsh']
      const res = await seedBankFromGit({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        cwd,
        limit,
        tags,
        observationScopes: scopes,
      })
      if (!res.ok) return `Seed failed: ${res.error}`
      record({ event: 'builtin_seed_ok', bank: target.resolution.bank, count: res.count })
      return `Seeded ${res.count} git commit(s) into bank ${target.resolution.bank}${res.operationId ? ` (operation ${res.operationId})` : ''}.`
    }
    if (action === 'pages') {
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)) {
        return 'Refused: --limit for pages must be an integer 1..50.'
      }
      const timeoutMs = Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000
      const query = String(options.query ?? '').trim()
      if (query) {
        const res = await searchPages({
          apiUrl: target.server.apiUrl,
          apiToken: target.server.token,
          bankId: target.resolution.bank,
          query,
          limit: options.limit ?? 5,
          timeoutMs,
        })
        if (!res.ok) return `Pages failed (${res.status}): ${res.error}`
        record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: res.results.length })
        if (res.results.length === 0) return `No matching pages in bank ${target.resolution.bank} for "${query}".`
        return [
          `Pages in ${target.resolution.bank} matching "${query}" (${res.results.length}):`,
          ...res.results.map((page, index) => {
            const score = page.score != null ? ` · score ${page.score.toFixed(2)}` : ''
            const snippet = page.snippet ? `\n  ${page.snippet.replace(/\s+/g, ' ').slice(0, 200)}` : ''
            return `${index + 1}. [${page.id}] ${page.path || page.name}${score}${snippet}`
          }),
        ].join('\n')
      }
      const res = await listPages({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        timeoutMs,
        useCache: false,
      })
      if (!res.ok) {
        if (res.status === 404) return `Bank ${target.resolution.bank} is not seeded yet (404).`
        return `Pages failed (${res.status}): ${res.error}`
      }
      record({ event: 'builtin_pages_ok', bank: target.resolution.bank, count: res.pages.length })
      if (res.pages.length === 0) return `Bank ${target.resolution.bank} exists but has no pages yet.`
      const shown = options.limit ? res.pages.slice(0, options.limit) : res.pages
      return [
        `Pages tree for ${target.resolution.bank} (${shown.length}${shown.length < res.pages.length ? ` of ${res.pages.length}` : ''}):`,
        ...shown.map((page) => `- [${page.id}] ${page.path}${page.isStale ? ' (stale)' : ''}${page.description ? ` — ${page.description}` : ''}`),
      ].join('\n')
    }
    if (action === 'recall') {
      const query = String(options.query ?? '').trim()
      if (!query) return 'Refused: provide a search query, e.g. /hindsight recall token ceiling.'
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)) {
        return 'Refused: --limit for recall must be an integer 1..50.'
      }
      const maxTokens = Number(getPath(target.effective, 'recallOptions.max_tokens') ?? settings.recallMaxTokens ?? 2000) || 2000
      const res = await recallMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        query,
        maxTokens,
        budget: 'mid',
        timeoutMs: Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000,
      })
      if (!res.ok) return `Recall failed (${res.status}): ${res.error}`
      record({ event: 'builtin_recall_ok', bank: target.resolution.bank, count: res.results.length })
      if (res.results.length === 0) return `No matching memories in bank ${target.resolution.bank}.`
      const items = options.limit ? res.results.slice(0, options.limit) : res.results
      return [
        `Recalled memories from ${target.resolution.bank} (${items.length}):`,
        ...items.map((item) => `- [${item.type}] ${item.text}${item.context ? ` (context: ${item.context})` : ''}`),
      ].join('\n')
    }
    if (action === 'retain') {
      if (settings.allowMemoryRetain === false) {
        return 'Refused: memory retention is disabled in bundle settings (allowMemoryRetain: false).'
      }
      const note = redactSecrets(String(options.query ?? '').trim())
      if (!note) return 'Refused: provide a note to store, e.g. /hindsight retain Always verify budget caps.'
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      if (process.env.HINDSIGHT_RETAIN_SESSIONS === 'false' || target.effective.retainSessions === false) {
        return 'Refused: session retention is disabled (HINDSIGHT_RETAIN_SESSIONS=false or retainSessions: false).'
      }
      const scopes = target.effective.observationScopes ?? settings.observationScopes
      const tags = scopes === 'per_source' ? ['source:dsh', 'source:manual', 'harness:dsh'] : ['source:manual', 'harness:dsh']
      const res = await retainMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        items: [{ content: note, context: 'manual-note' }],
        async: true,
        tags,
        strategy: 'document',
        observationScopes: scopes,
      })
      if (!res.ok) return `Retain failed (${res.status}): ${res.error}`
      record({ event: 'builtin_retain_ok', bank: target.resolution.bank, count: 1 })
      return `Retained memory item into bank ${target.resolution.bank}${res.operationId ? ` (operation ${res.operationId})` : ''}.`
    }
    if (action === 'reflect') {
      const query = String(options.query ?? '').trim()
      if (!query) return 'Refused: provide a question or topic, e.g. /hindsight reflect How is budget enforced?'
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      const res = await reflectMemories({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        query,
        budget: target.effective.reflectBudget ?? 'low',
        timeoutMs: Number(target.effective.reflectToolTimeoutMs ?? target.effective.reflectTimeoutMs ?? 15000) || 15000,
      })
      if (!res.ok) return `Reflect failed (${res.status}): ${res.error}`
      record({ event: 'builtin_reflect_ok', bank: target.resolution.bank })
      return res.text || `No reflection produced for bank ${target.resolution.bank}.`
    }
    if (action === 'stats') {
      const lane = resolveActiveLane(settings, findIntegration())
      if (lane === 'off') return 'Refused: memory governance is disabled (memoryLane: off).'
      if (lane === 'missing-external') {
        return 'Refused: memoryLane is set to external and @vectorize-io/hindsight-coding-agents is not installed.'
      }
      const target = resolveRuntimeTarget(cwd)
      if (target.server.disabled) {
        return target.isOptedOut
          ? 'Refused: this directory is outside optInOnly/optInPaths.'
          : 'Refused: Hindsight is disabled in the shared config (disabled: true).'
      }
      const timeoutMs = Number(target.effective.injectTimeoutMs ?? settings.injectTimeoutMs ?? 7000) || 7000
      const auth = {
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        timeoutMs,
      }
      const [statsRes, pagesRes] = await Promise.all([
        fetchBankStats(auth),
        listPages({ ...auth, useCache: false }),
      ])
      if (!statsRes.ok && !pagesRes.ok && pagesRes.status !== 404) {
        return `Stats failed (${statsRes.status || pagesRes.status}): ${statsRes.error || pagesRes.error}`
      }
      if (options.json === true) {
        return JSON.stringify({
          bank: target.resolution.bank,
          apiUrl: target.server.apiUrl,
          stats: statsRes.stats,
          pages: pagesRes.ok ? pagesRes.pages.length : 0,
          stalePages: pagesRes.ok ? pagesRes.pages.filter((page) => page.isStale).length : 0,
        }, null, 2)
      }
      return formatBankStats(target.resolution.bank, statsRes, pagesRes)
    }
    if (action === 'probe') {
      const integration = findIntegration()
      const lane = resolveActiveLane(settings, integration)
      if (lane === 'missing-external') {
        return 'Hindsight memory layer not installed: add @vectorize-io/hindsight-coding-agents to this profile first, or set memoryLane: auto for the built-in engine.'
      }
      if (lane === 'off') {
        return 'Hindsight memory is disabled (memoryLane: off).'
      }
      const target = resolveRuntimeTarget(cwd)
      const probe = await probeServer({
        apiUrl: target.server.apiUrl,
        apiToken: target.server.token,
        bankId: target.resolution.bank,
        timeoutMs: 4000,
      })
      return `Hindsight server (${lane}) — ${formatProbe(probe)}\n  ${target.server.apiUrl} · bank ${target.resolution.bank} (${target.resolution.source})${target.server.tokenSet ? '' : ' · no token configured'}`
    }
    if (action === 'suggest') {
      return formatSuggestion(await buildStatus(settings, stats, governor, cwd, options.sessionId, { skipProbe: true }))
    }
    const status = await buildStatus(settings, stats, governor, cwd, options.sessionId)
    if (options.json === true) return JSON.stringify(status, null, 2)
    return formatStatus(status)
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'hindsight_tuner',
      description:
        'Inspect the Hindsight project-memory engine and budget governor in this profile: reachability, the effective shared config (environment, harness, paths/banks sections), token budget and per-turn recall cost, invalid values, and a read-only budget suggestion. This tool does not modify the shared config unless the user explicitly enabled allowAgentWrites in the bundle config; ask them to run /hindsight tune or /hindsight revert instead. Returns a short text report.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: settings.allowAgentWrites ? ACTIONS : READ_ACTIONS,
            description:
              'status: health, effective config, and this session\'s injection budget. probe: reachability check without reading the journal. suggest: read-only cap/recall recommendation. tune/revert/enable/disable only when allowAgentWrites is enabled.',
          },
          overwrite: {
            type: 'boolean',
            description: 'Agent-write mode only: on tune, replace values that already exist instead of respecting the user\'s choice.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Agent-write mode only: report the tune diff without writing the config file.',
          },
          json: {
            type: 'boolean',
            description: 'status only: return the machine-readable status object as JSON instead of the text report.',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : 'status'
        if (!ACTIONS.includes(action)) {
          return `Unknown action "${action}". Use ${ACTIONS.join(', ')}.`
        }
        if (args?.json === true && action !== 'status') {
          return 'hindsight_tuner: json is only valid with status.'
        }
        if (args?.overwrite !== undefined && action !== 'tune') {
          return 'hindsight_tuner: overwrite is only valid with tune.'
        }
        if (args?.dryRun === true && !['tune', 'revert'].includes(action)) {
          return 'hindsight_tuner: dryRun is only valid with tune or revert.'
        }
        try {
          return await runAction(action, {
            cwd: exec?.agent?.session?.header?.cwd,
            sessionId: exec?.agent?.session?.header?.id,
            viaTool: true,
            json: args?.json === true,
            overwrite: typeof args?.overwrite === 'boolean' ? args.overwrite : undefined,
            dryRun: args?.dryRun === true,
          })
        } catch (error) {
          return `hindsight_tuner ${action} failed: ${String(error?.message ?? error)}`
        }
      },
    })

    const activeLane = resolveActiveLane(settings, findIntegration())
    const enableBuiltinTools = settings.builtinTools === true || (settings.builtinTools === 'auto' && activeLane === 'builtin')
    if (enableBuiltinTools) registerHindsightTools(toolCtx, settings)
  })

  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: 'hindsight',
        description: 'Hindsight memory: status [--json] | stats [--json] | pages [query] [--limit N] | recall <query> [--limit N] | reflect <query> | retain <note> | seed [--limit N] | tune [--dry-run] [--overwrite] [--cap N] | revert [--dry-run] | probe | suggest | enable | disable',
        async handler(invocation) {
          const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const action = parts.shift() || 'status'
          if (!COMMAND_ACTIONS.includes(action)) {
            return { kind: 'error', text: `Unknown action "${action}". Use ${COMMAND_ACTIONS.join(', ')}.` }
          }
          const acceptsQuery = ['pages', 'recall', 'reflect', 'retain'].includes(action)
          const flags = parseCommandFlags(parts, { allowPositional: acceptsQuery })
          if (flags.unknown) {
            return { kind: 'error', text: `Unknown option "${flags.unknown}". Use --dry-run, --overwrite, --cap N, --limit N, or --json.` }
          }
          if ((flags.overwrite || flags.cap !== undefined) && action !== 'tune') {
            return { kind: 'error', text: 'Options --overwrite and --cap are only valid for tune.' }
          }
          if (flags.limit !== undefined && !['seed', 'pages', 'recall'].includes(action)) {
            return { kind: 'error', text: 'Option --limit is only valid for seed, pages, or recall.' }
          }
          if (flags.dryRun && !['tune', 'revert'].includes(action)) {
            return { kind: 'error', text: 'Option --dry-run is only valid for tune or revert.' }
          }
          if (flags.json && !['status', 'stats'].includes(action)) {
            return { kind: 'error', text: 'Option --json is only valid for status or stats.' }
          }
          try {
            const text = await runAction(action, {
              cwd: invocation?.agent?.session?.header?.cwd,
              sessionId: invocation?.agent?.session?.header?.id,
              dryRun: flags.dryRun === true,
              overwrite: flags.overwrite ? true : undefined,
              cap: flags.cap,
              limit: flags.limit,
              query: flags.positional.join(' '),
              json: flags.json === true,
            })
            const isError = /^(?:Refused:|Seed failed:|Pages failed|Recall failed|Reflect failed|Retain failed|Stats failed)/.test(text)
            return { kind: isError ? 'error' : 'success', text }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      })
    } catch (error) {
      record({ event: 'command_failed', error: String(error?.message ?? error) })
    }
  })
}

function parseCommandFlags(parts, { allowPositional = false } = {}) {
  const flags = { positional: [] }
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === '--dry-run') flags.dryRun = true
    else if (part === '--overwrite') flags.overwrite = true
    else if (part === '--json') flags.json = true
    else if (part === '--cap') {
      const raw = index + 1 < parts.length ? parts[++index] : ''
      flags.cap = raw.trim() === '' ? Number.NaN : Number(raw)
    } else if (part.startsWith('--cap=')) {
      const raw = part.slice('--cap='.length)
      flags.cap = raw.trim() === '' ? Number.NaN : Number(raw)
    } else if (part === '--limit') {
      const raw = index + 1 < parts.length ? parts[++index] : ''
      flags.limit = raw.trim() === '' ? Number.NaN : Number(raw)
    } else if (part.startsWith('--limit=')) {
      const raw = part.slice('--limit='.length)
      flags.limit = raw.trim() === '' ? Number.NaN : Number(raw)
    } else if (!part.startsWith('-') && allowPositional) {
      flags.positional.push(part)
    } else flags.unknown = part
  }
  return flags
}
