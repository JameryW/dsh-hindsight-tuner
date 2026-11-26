/**
 * Value validation for the shared Hindsight config.
 *
 * The upstream loader is forgiving: an unknown enum falls back to a default, an
 * out-of-range number is used as-is, and a wrong type is merged into the config
 * that every harness reads. That means one bad agent-written value can silently
 * change behaviour for Claude Code, Codex and DSH at once. This module is the
 * single place that knows what each key accepts, so the tuner can refuse to
 * write a bad value and can explain a bad value that is already on disk.
 */

import { SCENARIO_NAMES, SCENARIO_TIER_NAMES } from './scenario.js'

/** Enumerations the integration itself resolves (see resolveAutoInject & co.). */
export const AUTO_INJECT_MODES = ['reflect', 'pages', 'recall', 'none']
export const OBSERVATION_SCOPE_MODES = ['shared', 'combined', 'per_tag', 'all_combinations', 'per_source']
export const SERVER_MODES = ['cloud', 'self-hosted', 'daemon']
export const REFLECT_BUDGETS = ['low', 'mid', 'high']

const isInteger = (value) => typeof value === 'number' && Number.isInteger(value)

/** Rules for the four keys the lean preset writes. */
// The timeout has no upstream cap (`raw.injectTimeoutMs || 7000`), so the bound
// here is only the plugin's own safety window; a slow self-hosted server may
// legitimately need more than two minutes.
export const PRESET_RULES = {
  autoInject: { kind: 'enum', values: AUTO_INJECT_MODES },
  injectTimeoutMs: { kind: 'integer', min: 1000, max: 600000 },
  observationScopes: { kind: 'scopes' },
  recallMaxTokens: { kind: 'integer', min: 100, max: 1000000 },
}

function describe(rule) {
  if (rule.kind === 'enum') return `one of ${rule.values.join('|')}`
  if (rule.kind === 'integer') return `an integer ${rule.min}..${rule.max}`
  if (rule.kind === 'scopes') return `one of ${OBSERVATION_SCOPE_MODES.join('|')}, or a list of scope groups like [["per_source"]]`
  if (rule.kind === 'boolean') return 'true or false'
  if (rule.kind === 'string') return 'a non-empty string'
  if (rule.kind === 'url') return 'an http:// or https:// URL'
  if (rule.kind === 'stringList') return 'a list of non-empty strings'
  return 'a valid value'
}

function check(rule, value) {
  if (rule.kind === 'enum') {
    return typeof value === 'string' && rule.values.includes(value)
      ? null
      : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  if (rule.kind === 'scopes') {
    // Upstream resolveObservationScopes accepts a named mode or an explicit list
    // of scope groups, so a config using the list form is valid, not broken.
    if (typeof value === 'string') {
      return OBSERVATION_SCOPE_MODES.includes(value) ? null : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
    }
    if (Array.isArray(value) && value.length > 0) {
      const ok = value.every((group) => Array.isArray(group) && group.length > 0
        && group.every((scope) => typeof scope === 'string' && scope.trim() !== ''))
      return ok ? null : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
    }
    return `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  if (rule.kind === 'integer') {
    return isInteger(value) && value >= rule.min && value <= rule.max
      ? null
      : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  if (rule.kind === 'boolean') {
    return typeof value === 'boolean' ? null : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  if (rule.kind === 'string') {
    return typeof value === 'string' && value.length > 0
      ? null
      : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  if (rule.kind === 'url') {
    if (typeof value !== 'string' || value.length === 0) return `expected ${describe(rule)}, got ${JSON.stringify(value)}`
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? null
        : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
    } catch {
      return `expected ${describe(rule)}, got ${JSON.stringify(value)}`
    }
  }
  if (rule.kind === 'stringList') {
    const ok = Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
    return ok ? null : `expected ${describe(rule)}, got ${JSON.stringify(value)}`
  }
  return null
}

/**
 * Validate the bundle settings that become the preset. Invalid entries are
 * reported and dropped from the preset: a typo must not reach the shared file.
 */
export function validateSettings(settings) {
  const issues = []
  const preset = []
  const pairs = [
    ['autoInject', settings.autoInject],
    ['injectTimeoutMs', settings.injectTimeoutMs],
    ['observationScopes', settings.observationScopes],
    ['recallMaxTokens', settings.recallMaxTokens],
  ]
  for (const [name, value] of pairs) {
    const error = check(PRESET_RULES[name], value)
    if (error) {
      issues.push({ field: name, value, message: error })
      continue
    }
    preset.push([name === 'recallMaxTokens' ? 'recallOptions.max_tokens' : name, value])
  }

  if (!isInteger(settings.maxInjectTokens) || settings.maxInjectTokens < 0 || settings.maxInjectTokens > 64000) {
    issues.push({
      field: 'maxInjectTokens',
      value: settings.maxInjectTokens,
      message: 'expected an integer 0..64000 (0 turns the cap off; a tiny cap drops the recall instead of exceeding it)',
    })
  }
  if (typeof settings.sourceKind !== 'string' || !settings.sourceKind.startsWith('plugin:')) {
    issues.push({ field: 'sourceKind', value: settings.sourceKind, message: 'expected a plugin:* source kind' })
  }
  if (!['fast', 'calibrated', 'accurate'].includes(settings.tokenBudgetMode)) {
    issues.push({ field: 'tokenBudgetMode', value: settings.tokenBudgetMode, message: 'expected fast, calibrated or accurate' })
  }
  const policy = settings.budgetPolicy ?? 'off'
  if (!['off', 'adaptive', 'scenario'].includes(policy)) {
    issues.push({ field: 'budgetPolicy', value: settings.budgetPolicy, message: 'expected off, adaptive or scenario' })
  }
  // Scenario tiers are validated on the raw value too: a misspelled scenario or
  // tier must be reported, not silently replaced by the default table.
  if (settings.scenarioTiers !== undefined) {
    const scenarioTiers = settings.scenarioTiers
    if (scenarioTiers === null || typeof scenarioTiers !== 'object' || Array.isArray(scenarioTiers)) {
      issues.push({
        field: 'scenarioTiers',
        value: scenarioTiers,
        message: `expected an object mapping scenario -> ${SCENARIO_TIER_NAMES.join('|')} (scenarios: ${SCENARIO_NAMES.join(', ')})`,
      })
    } else {
      for (const [rawScenario, rawTier] of Object.entries(scenarioTiers)) {
        // Matching is case-insensitive because the applied form is normalized
        // the same way: `{ Debug: 'Deep' }` is a valid spelling, not a typo.
        const scenario = String(rawScenario).toLowerCase()
        const tier = typeof rawTier === 'string' ? rawTier.toLowerCase() : rawTier
        if (!SCENARIO_NAMES.includes(scenario)) {
          issues.push({ field: 'scenarioTiers', value: rawScenario, message: `unknown scenario; expected one of ${SCENARIO_NAMES.join(', ')}` })
        } else if (!SCENARIO_TIER_NAMES.includes(tier)) {
          issues.push({ field: 'scenarioTiers', value: scenarioTiers, message: `expected ${SCENARIO_TIER_NAMES.join('|')} for '${scenario}', got ${JSON.stringify(rawTier)}` })
        }
      }
    }
  }
  const tiers = settings.budgetTiers === undefined ? { light: 800, normal: 1600, deep: 3000 } : settings.budgetTiers
  const validTierMap = tiers !== null && typeof tiers === 'object' && !Array.isArray(tiers)
  const tierIssue = !validTierMap || ['light', 'normal', 'deep'].find((name) => {
    const value = tiers[name]
    return !isInteger(value) || value < 1 || value > 64000
  })
  if (tierIssue || !(tiers.light <= tiers.normal && tiers.normal <= tiers.deep)) {
    issues.push({
      field: 'budgetTiers',
      value: settings.budgetTiers,
      message: 'expected light <= normal <= deep, each an integer 1..64000',
    })
  }
  const repeatPolicy = settings.repeatPolicy ?? 'inject'
  if (!['inject', 'skip'].includes(repeatPolicy)) {
    issues.push({ field: 'repeatPolicy', value: settings.repeatPolicy, message: 'expected inject or skip' })
  }
  const repeatThreshold = settings.repeatThreshold ?? 0.9
  if (typeof repeatThreshold !== 'number' || !Number.isFinite(repeatThreshold) || repeatThreshold < 0.5 || repeatThreshold > 1) {
    issues.push({ field: 'repeatThreshold', value: settings.repeatThreshold, message: 'expected a number 0.5..1' })
  }
  if (settings.verifyReminder !== undefined && typeof settings.verifyReminder !== 'boolean') {
    issues.push({ field: 'verifyReminder', value: settings.verifyReminder, message: 'expected a boolean' })
  }
  // The view policy is value-laden: budgeted selection can change which facts a
  // model sees, so it must be opted into explicitly rather than guessed from a
  // typo. A bad value falls back to truncate and is reported, never half-applied.
  const viewPolicy = settings.viewPolicy ?? 'truncate'
  if (!['truncate', 'budgeted'].includes(viewPolicy)) {
    issues.push({ field: 'viewPolicy', value: settings.viewPolicy, message: 'expected truncate or budgeted' })
  }
  const viewContextMessages = settings.viewContextMessages ?? 8
  if (!isInteger(viewContextMessages) || viewContextMessages < 1 || viewContextMessages > 40) {
    issues.push({ field: 'viewContextMessages', value: settings.viewContextMessages, message: 'expected an integer 1..40' })
  }
  if (settings.memoryLane !== undefined && !['auto', 'builtin', 'external', 'off'].includes(settings.memoryLane)) {
    issues.push({ field: 'memoryLane', value: settings.memoryLane, message: 'expected auto, builtin, external or off' })
  }
  if (settings.builtinTools !== undefined && settings.builtinTools !== 'auto' && typeof settings.builtinTools !== 'boolean') {
    issues.push({ field: 'builtinTools', value: settings.builtinTools, message: 'expected auto, true or false' })
  }
  if (settings.allowMemoryRetain !== undefined && typeof settings.allowMemoryRetain !== 'boolean') {
    issues.push({ field: 'allowMemoryRetain', value: settings.allowMemoryRetain, message: 'expected a boolean' })
  }
  if (settings.autoSeed !== undefined && typeof settings.autoSeed !== 'boolean') {
    issues.push({ field: 'autoSeed', value: settings.autoSeed, message: 'expected a boolean' })
  }
  return { issues, preset }
}

const CONFIG_RULES = {
  autoInject: PRESET_RULES.autoInject,
  observationScopes: { kind: 'scopes' },
  serverMode: { kind: 'enum', values: SERVER_MODES },
  apiUrl: { kind: 'url' },
  injectTimeoutMs: { kind: 'integer', min: 1000, max: 600000 },
  reflectTimeoutMs: { kind: 'integer', min: 1000, max: 300000 },
  reflectToolTimeoutMs: { kind: 'integer', min: 1000, max: 300000 },
  reflectBudget: { kind: 'enum', values: REFLECT_BUDGETS },
  apiPort: { kind: 'integer', min: 1, max: 65535 },
  daemonIdleTimeout: { kind: 'integer', min: 0, max: 86400 },
  maxParallelRetains: { kind: 'integer', min: 1, max: 64 },
  pageRefreshEveryTurns: { kind: 'integer', min: 1, max: 1000 },
  // `raw.surveyRefreshCommits ?? 20` keeps 0, which means "re-survey every
  // commit", so 0 is a deliberate value rather than a missing one.
  surveyRefreshCommits: { kind: 'integer', min: 0, max: 10000 },
  // Upstream has no hard caps for these two; only values it would silently
  // replace (0 via `|| default`) or negatives are treated as broken.
  pageSearchLimit: { kind: 'integer', min: 1, max: 1000 },
  seedLimit: { kind: 'integer', min: 1, max: 100000 },
  'recallOptions.max_tokens': { kind: 'integer', min: 100, max: 1000000 },
  disabled: { kind: 'boolean' },
  dynamicBankId: { kind: 'boolean' },
  resolveWorktrees: { kind: 'boolean' },
  optInOnly: { kind: 'boolean' },
  optInPaths: { kind: 'stringList' },
  retainTags: { kind: 'stringList' },
  retainSessions: { kind: 'boolean' },
  autoReflect: { kind: 'boolean' },
  autoSeed: { kind: 'boolean' },
  codebaseSurvey: { kind: 'boolean' },
  autoUpdate: { kind: 'boolean' },
  manageBankConfig: { kind: 'boolean' },
  bankId: { kind: 'string' },
  bankIdTemplate: { kind: 'string' },
}

/**
 * Check an already-effective config. Only keys with an unambiguous contract are
 * checked; free-form maps (`banks`, `paths`, `mapPathToBank`) are not judged.
 */
export function validateConfig(config) {
  const issues = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) return issues
  for (const [path, rule] of Object.entries(CONFIG_RULES)) {
    const parts = path.split('.')
    let value = config
    for (const part of parts) {
      if (value === null || typeof value !== 'object') { value = undefined; break }
      value = value[part]
    }
    if (value === undefined) continue
    const error = check(rule, value)
    if (error) issues.push({ path, value, message: error })
  }
  return issues
}
