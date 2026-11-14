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

/** Enumerations the integration itself resolves (see resolveAutoInject & co.). */
export const AUTO_INJECT_MODES = ['reflect', 'pages', 'recall', 'none']
export const OBSERVATION_SCOPE_MODES = ['shared', 'combined', 'per_tag', 'all_combinations', 'per_source']
export const SERVER_MODES = ['cloud', 'self-hosted', 'daemon']

const isInteger = (value) => typeof value === 'number' && Number.isInteger(value)

/** Rules for the four keys the lean preset writes. */
export const PRESET_RULES = {
  autoInject: { kind: 'enum', values: AUTO_INJECT_MODES },
  injectTimeoutMs: { kind: 'integer', min: 1000, max: 120000 },
  observationScopes: { kind: 'scopes' },
  recallMaxTokens: { kind: 'integer', min: 100, max: 64000 },
}

function describe(rule) {
  if (rule.kind === 'enum') return `one of ${rule.values.join('|')}`
  if (rule.kind === 'integer') return `an integer ${rule.min}..${rule.max}`
  if (rule.kind === 'scopes') return `one of ${OBSERVATION_SCOPE_MODES.join('|')}, or a list of scope groups like [["per_source"]]`
  if (rule.kind === 'boolean') return 'true or false'
  if (rule.kind === 'string') return 'a non-empty string'
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
  if (!['fast', 'accurate'].includes(settings.tokenBudgetMode)) {
    issues.push({ field: 'tokenBudgetMode', value: settings.tokenBudgetMode, message: 'expected fast or accurate' })
  }
  const policy = settings.budgetPolicy ?? 'off'
  if (!['off', 'adaptive'].includes(policy)) {
    issues.push({ field: 'budgetPolicy', value: settings.budgetPolicy, message: 'expected off or adaptive' })
  }
  const tiers = settings.budgetTiers ?? { light: 800, normal: 1600, deep: 3000 }
  const tierIssue = ['light', 'normal', 'deep'].find((name) => {
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
  return { issues, preset }
}

const CONFIG_RULES = {
  autoInject: PRESET_RULES.autoInject,
  observationScopes: { kind: 'scopes' },
  serverMode: { kind: 'enum', values: SERVER_MODES },
  injectTimeoutMs: { kind: 'integer', min: 1000, max: 120000 },
  reflectTimeoutMs: { kind: 'integer', min: 1000, max: 300000 },
  apiPort: { kind: 'integer', min: 1, max: 65535 },
  // Upstream has no hard caps for these two; only values it would silently
  // replace (0 via `|| default`) or negatives are treated as broken.
  pageSearchLimit: { kind: 'integer', min: 1, max: 1000 },
  seedLimit: { kind: 'integer', min: 1, max: 100000 },
  'recallOptions.max_tokens': { kind: 'integer', min: 100, max: 64000 },
  disabled: { kind: 'boolean' },
  dynamicBankId: { kind: 'boolean' },
  optInOnly: { kind: 'boolean' },
  autoSeed: { kind: 'boolean' },
  bankId: { kind: 'string' },
  bankIdTemplate: { kind: 'string' },
}

/**
 * Check an already-effective config. Only keys with an unambiguous contract are
 * checked; free-form maps (`banks`, `paths`, `mapPathToBank`) are not judged.
 */
export function validateConfig(config) {
  const issues = []
  if (!config || typeof config !== 'object') return issues
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
