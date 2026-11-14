/**
 * Hindsight memory tuning for DeepSeek Harness.
 *
 * The `@vectorize-io/hindsight-coding-agents` integration is strong at cold-start
 * seeding and cross-tool sharing, and expensive at recall: its default profile
 * lets one turn carry a large synthesis, and every behavioural key lives in a
 * global file that no harness UI edits. This plugin adds the missing DSH-side
 * control plane, without forking or duplicating that integration:
 *
 *  - it applies a lean profile to the shared `~/.hindsight/coding-agent.json`
 *    (pages-first injection, a short inject deadline, per-source observation
 *    scopes, and a recall token ceiling), fill-missing-only by default, with a
 *    backup, a lock, a crash-recoverable journal, and an exact undo;
 *  - it caps what a single turn can receive from Hindsight at `maxInjectTokens`,
 *    as the outermost `agent/pre-step` hook, so the cap sees the payload the
 *    model will actually get. Trimming would defeat the integration's own
 *    "unchanged recall" check, so every turn is trimmed to the same ceiling
 *    instead of being re-injected untrimmed;
 *  - it diagnoses the integration from its own journal and the effective config
 *    (including environment and per-harness overrides), because a missing token
 *    currently fails silently on every turn.
 *
 * It degrades to a report when the integration or its config is absent.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appliedPaths,
  applyTuning,
  autoTuneEnabled,
  getPath,
  readConfigFile,
  revertTuning,
  setAutoTune,
} from './lib/config-file.js'
import {
  bankResolution,
  diagPath,
  effectiveConfig,
  effectiveServer,
  installedBundles,
  optedOut,
  probeServer,
  projectName,
  summarizeActivity,
} from './lib/diagnostics.js'
import { record } from './lib/log.js'
import {
  allocateBudget,
  countTokens,
  estimateTokens,
  FALLBACK_MARGIN,
  loadTokenizer,
  percentile,
  trimToBudget,
} from './lib/tokens.js'
import { validateConfig, validateSettings } from './lib/validate.js'

const PLUGIN = 'hindsight-tuner'
const MAX_REMEMBERED_SESSIONS = 40
const ACTIONS = ['status', 'tune', 'revert', 'probe', 'suggest', 'enable', 'disable']
const READ_ACTIONS = ['status', 'probe', 'suggest']

export const name = PLUGIN

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const number = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)
  const text = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  return {
    autoTune: raw.autoTune !== false,
    overwrite: raw.overwrite === true,
    maxInjectTokens: number(raw.maxInjectTokens, 3000),
    autoInject: text(raw.autoInject, 'pages'),
    injectTimeoutMs: number(raw.injectTimeoutMs, 7000),
    // Accept the named mode or the integration's explicit list form; validation
    // rejects anything else instead of silently writing a broken value.
    observationScopes: raw.observationScopes ?? 'per_source',
    // The integration's own recall default is 2000; pinning it keeps the budget
    // explicit and survives a future release that raises its default.
    recallMaxTokens: number(raw.recallMaxTokens, 2000),
    sourceKind: text(raw.sourceKind, 'plugin:hindsight'),
    // fast: dependency-free estimate. accurate: the model tokenizer when one is
    // installed, with a labelled fallback when it is not.
    tokenBudgetMode: text(raw.tokenBudgetMode, 'fast').toLowerCase(),
    // A tool call is an agent action; writing the user's global config from it
    // is only allowed when the user edited this flag into the bundle config.
    // There is deliberately no per-call "confirm" argument: a model can set that
    // itself, which would make the boundary meaningless.
    allowAgentWrites: raw.allowAgentWrites === true,
  }
}

function buildPreset(settings) {
  // Only values that passed validation are written; an invalid bundle setting
  // is reported in status instead of being copied into the shared file.
  return settings.preset ?? []
}

function textOf(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Whether the memory integration itself is installed. Without it the config
 * file and a reachable server describe nothing this profile can use, and a
 * status that only probed the endpoint would claim a capability that is absent.
 */
/**
 * The upstream integration line this release is tested against (CI installs the
 * pinned version and runs the real hook integration test). The pre-step
 * contract is private to that package, so a version outside this line is
 * reported instead of being silently trusted.
 */
const TESTED_INTEGRATION = { line: '0.8', version: '0.8.7' }

let integrationMemo = null

function integrationManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    const version = typeof manifest?.version === 'string' ? manifest.version : null
    return { installed: true, path, version }
  } catch {
    return { installed: true, path, version: null }
  }
}

function findIntegration() {
  const roots = new Set()
  if (process.env.DSH_PROFILE_DIR) roots.add(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    roots.add(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE))
  }
  if (process.env.DSH_INSTALL_DIR) roots.add(process.env.DSH_INSTALL_DIR)

  const key = [...roots].join('|')
  if (integrationMemo?.key === key) return integrationMemo.value

  let value = { installed: false, path: null, version: null }
  for (const root of roots) {
    const manifest = join(root, 'node_modules', '@vectorize-io', 'hindsight-coding-agents', 'package.json')
    if (existsSync(manifest)) {
      value = integrationManifest(manifest)
      break
    }
  }
  integrationMemo = { key, value }
  return value
}

/** Compare the installed integration with the line this release tests. */
function integrationCompatibility(integration) {
  if (!integration.installed) return null
  const version = integration.version
  const match = version ? /^(\d+)\.(\d+)/.exec(version) : null
  const line = match ? `${match[1]}.${match[2]}` : null
  return {
    version,
    tested: TESTED_INTEGRATION.version,
    line,
    compatible: line === null ? null : line === TESTED_INTEGRATION.line,
  }
}

/** Turn a JSON error body into one readable sentence. */
function detailMessage(text) {
  if (!text) return ''
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.detail ?? parsed?.message ?? parsed?.error
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // Not JSON; show the body itself.
  }
  return text
}

function remember(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > MAX_REMEMBERED_SESSIONS) map.delete(map.keys().next().value)
}

/**
 * Cap one turn's Hindsight recall.
 *
 * This runs as the outermost `agent/pre-step` listener, so it sees the final
 * message list after every other plugin (including Hindsight) has appended.
 * The budget is shared by all matching messages in the turn: it is not a
 * per-message limit, and there is no hidden minimum — when a message cannot fit
 * even a marker it is dropped so the turn stays under the ceiling.
 */
function createGovernor(settings, stats, meter) {
  const sessions = new Map()

  function sessionOf(sessionId) {
    let session = sessions.get(sessionId)
    if (!session) {
      session = { turns: 0, tokens: 0, last: 0, max: 0 }
      remember(sessions, sessionId, session)
    }
    return session
  }

  /** Count plugin-injected messages per turn, and detect a stacked setup. */
  function noteTurn(messages, sessionId) {
    const kinds = new Set()
    for (const message of messages) {
      const kind = message?.source?.kind
      if (typeof kind === 'string' && kind.startsWith('plugin:')) kinds.add(kind)
    }
    for (const kind of kinds) stats.sources[kind] = (stats.sources[kind] ?? 0) + 1
    if (kinds.size > 1) {
      stats.stackTurns += 1
      stats.lastStack = [...kinds].sort()
      record({ event: 'stack_turn', session: sessionId, kinds: [...kinds] })
    }
  }

  async function onPreStep(payload, next) {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const sessionId = payload?.agent?.session?.header?.id ?? 'unknown'
    noteTurn(decision.messages, sessionId)

    const candidates = []
    decision.messages.forEach((message, index) => {
      if (message?.source?.kind !== settings.sourceKind) return
      const text = textOf(message)
      if (!text) return
      candidates.push({ index, message, text, tokens: meter.measure(text) })
    })
    if (candidates.length === 0) return decision

    const total = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0)
    const cap = settings.maxInjectTokens
    let after = total
    let removed = new Set()
    let dropped = 0
    let messages = decision.messages

    if (cap && total > cap) {
      const allocations = allocateBudget(candidates.map((candidate) => candidate.tokens), cap)
      messages = decision.messages.slice()
      after = 0
      candidates.forEach((candidate, position) => {
        const allotted = allocations[position]
        if (candidate.tokens <= allotted) {
          after += candidate.tokens
          return
        }
        const marker = `\n\n…[dsh-hindsight-tuner: cut from ~${candidate.tokens} to ~${allotted} tokens. Ask Hindsight for the full recall explicitly, or raise maxInjectTokens.]`
        const trimmed = allotted > 0 ? trimToBudget(candidate.text, allotted, marker, meter.count) : ''
        if (!trimmed) {
          removed.add(candidate.index)
          dropped += 1
          return
        }
        const otherBlocks = Array.isArray(candidate.message.content)
          ? candidate.message.content.filter((block) => block?.type !== 'text')
          : []
        messages[candidate.index] = { ...candidate.message, content: [{ type: 'text', text: trimmed }, ...otherBlocks] }
        after += meter.count(trimmed)
      })
      stats.capped += 1
      stats.dropped += dropped
      stats.last = { before: total, after, at: new Date().toISOString() }
      record({ event: 'inject_capped', session: sessionId, before: total, after, dropped, mode: meter.mode })
    }

    // Accounting records both what Hindsight wanted and what actually reached
    // the model, so a capped turn never looks like an uncapped one.
    const session = sessionOf(sessionId)
    session.turns += 1
    session.last = total
    session.lastInjected = after
    session.max = Math.max(session.max, total)
    session.tokens += total
    session.injected = (session.injected ?? 0) + after
    stats.turns += 1
    stats.lastTurnTokens = total
    stats.maxTurnTokens = Math.max(stats.maxTurnTokens, total)
    stats.seen += candidates.length

    if (cap && total > cap) {
      return { ...decision, messages: messages.filter((_, index) => !removed.has(index)) }
    }
    return decision
  }

  return {
    onPreStep,
    session: (sessionId) => sessions.get(sessionId) ?? null,
    dispose: () => sessions.clear(),
  }
}

function describeKind(kind) {
  if (kind === 'ok') return 'present'
  if (kind === 'missing') return 'absent, created on first tune'
  return `unreadable${kind === 'invalid' ? ' JSON' : ''}`
}

function formatProbe(probe) {
  if (!probe) return 'not checked'
  if (probe.ok) return 'bank reachable'
  if (probe.status === 0) return `unreachable — ${probe.error}`
  const detail = probe.detail ? detailMessage(probe.detail).replace(/\s+/g, ' ').slice(0, 140) : ''
  if (probe.status === 401 || probe.status === 403) {
    return `${probe.status} authentication failed${detail ? ` — ${detail}` : ''}`
  }
  if (probe.status === 404) return `404 — the bank does not exist yet${detail ? ` (${detail})` : ''}`
  if (probe.status === 429) return '429 — rate limited by the server'
  return `${probe.status}${detail ? ` — ${detail}` : ''}`
}

function formatPreset(preset) {
  return [
    `autoInject=${preset.autoInject ?? 'unset'}`,
    `injectTimeoutMs=${preset.injectTimeoutMs ?? 'unset'}`,
    `observationScopes=${preset.observationScopes ?? 'unset'}`,
    `recall.max_tokens=${preset.recallMaxTokens ?? 'unset'}`,
  ].join(' · ')
}

/** Keys whose file value differs from the requested preset. */
function presetDrift(actual, desired) {
  const pairs = [
    ['autoInject', actual.autoInject, desired.autoInject],
    ['injectTimeoutMs', actual.injectTimeoutMs, desired.injectTimeoutMs],
    ['observationScopes', actual.observationScopes, desired.observationScopes],
    ['recallOptions.max_tokens', actual.recallMaxTokens, desired.recallMaxTokens],
  ]
  return pairs
    .filter(([, have, want]) => have !== want)
    .map(([key, have, want]) => `${key} ${have ?? 'unset'} ≠ ${want}`)
}

/**
 * Environment or harness overrides can change what the integration reads even
 * when the file looks correct; surface them instead of reporting a stale value.
 */
function formatLayers(layers, preset) {
  const effective = layers.config
  const rows = [
    ['autoInject', effective.autoInject],
    ['injectTimeoutMs', effective.injectTimeoutMs],
    ['observationScopes', effective.observationScopes],
    ['recallOptions.max_tokens', getPath(effective, 'recallOptions.max_tokens')],
  ]
  const drift = rows
    .filter(([key, value]) => value !== undefined && value !== preset[key === 'recallOptions.max_tokens' ? 'recallMaxTokens' : key])
    .map(([key, value]) => `${key}=${value}`)
  const parts = []
  if (layers.sections?.length > 0) parts.push(`sections ${layers.sections.join(', ')}`)
  if (layers.harnessKeys?.length > 0) parts.push('harnesses.dsh read')
  if (layers.envKeys?.length > 0) parts.push(`env ${layers.envKeys.join(', ')}`)
  if (drift.length > 0) parts.push(`overrides ${drift.join(' · ')}`)
  return parts.length > 0 ? `  layers   ${parts.join(' · ')}` : null
}

function formatActivity(activity) {
  if (!activity.exists) return 'no Hindsight journal yet'
  if (activity.error) return activity.error
  const entries = Object.entries(activity.recent ?? {}).sort((left, right) => right[1] - left[1])
  const parts = entries.slice(0, 5).map(([event, count]) => `${event} ${count}`)
  if (activity.authFailures > 0) parts.push(`auth failures ${activity.authFailures}`)
  if (activity.lastInject) parts.push(`last inject ~${activity.lastInject.tokens} tok`)
  return parts.length > 0 ? `24h: ${parts.join(' · ')}` : '24h: nothing recorded'
}

function hintFor(status) {
  const probe = status.probe
  if (!status.integration.installed) {
    return 'The Hindsight memory bundle is not installed in this profile: add @vectorize-io/hindsight-coding-agents, then run /hindsight probe.'
  }
  if (status.server.disabled) {
    return status.server.disabledReason === 'optInOnly excludes this directory'
      ? 'This directory is outside optInOnly/optInPaths, so Hindsight will not inject here; add the path or remove optInOnly.'
      : 'Hindsight is disabled in the shared config (disabled: true); clear that key to turn memory back on.'
  }
  if (status.configIssues.length > 0) {
    return 'The shared config contains values the integration does not accept; it silently falls back for those keys. Fix the invalid lines above (or run /hindsight tune) before trusting this report.'
  }
  if (status.settingsIssues.length > 0) {
    return 'This bundle has invalid settings, so they were not written. Fix the row in cordis.patch.yml, then run /hindsight tune.'
  }
  if (status.stale) {
    return `The newest journal failure targets ${status.stale.seen}, but the effective config points at ${status.stale.expected}: the running DSH process loaded the old config. Restart DSH so the integration re-reads it.`
  }
  if (probe?.status === 401 || probe?.status === 403) {
    return 'The server rejected the token. Set "apiToken" in the shared config or HINDSIGHT_API_TOKEN, then run /hindsight probe to confirm — it is re-read on the next rejected request.'
  }
  if (probe && probe.status === 0) {
    return `The server is unreachable. For daemon mode, start hindsight-embed on ${status.server.apiUrl}.`
  }
  if (probe?.status === 404) {
    return 'The bank does not exist yet; the first session on this repository creates it by seeding git history.'
  }
  if (probe?.status === 429) {
    return 'The server rate-limited this probe; retry /hindsight probe shortly.'
  }
  if (probe && probe.status >= 500) {
    return `The server reported ${probe.status}. Check the hosted status page or your self-hosted instance, then retry /hindsight probe.`
  }
  if (!status.server.tokenSet && status.server.mode === 'cloud') {
    return 'No API token is configured, so Cloud calls fail with 401. Add "apiToken" to the shared config or set HINDSIGHT_API_TOKEN, then run /hindsight probe.'
  }
  if (status.budget.turns === 0 && (status.activity.recent?.inject_ok ?? 0) > 0) {
    return 'The journal shows Hindsight injections but none reached this hook: another pre-step listener is wrapping it. Restart DSH so the tuner registers after its bundle, then check /hindsight again.'
  }
  if (probe?.ok) {
    return 'Memory is reachable. A cold bank seeds git history on the first session; pages appear as they consolidate.'
  }
  return 'Run /hindsight tune to apply the lean profile, or inspect the config path above.'
}

async function buildStatus(settings, stats, governor, cwd = process.cwd(), sessionId = null) {
  const file = readConfigFile()
  const integration = findIntegration()
  const project = projectName(cwd)
  const baseLayers = effectiveConfig(file.config, { cwd })
  const resolution = bankResolution(baseLayers.config, project.name, cwd)
  const layers = effectiveConfig(file.config, { cwd, bank: resolution.base ?? resolution.bank })
  const effective = layers.config
  const disabled = effectiveServer(effective, {}).disabled || optedOut(effective, cwd)
  const server = { ...effectiveServer(effective, {}), disabled }
  const probe = !integration.installed || server.disabled ? null : await probeServer({
    apiUrl: server.apiUrl,
    apiToken: server.token,
    bankId: resolution.bank,
    timeoutMs: 4000,
  })

  const session = governor.session(sessionId)
  const ratios = stats.ratios ?? []
  const activity = summarizeActivity()
  const status = {
    file: { path: file.path, kind: file.kind, error: file.error ?? null },
    integration,
    compat: integrationCompatibility(integration),
    server: {
      mode: server.mode,
      apiUrl: server.apiUrl,
      disabled: server.disabled,
      disabledReason: server.disabled
        ? (optedOut(effective, cwd) ? 'optInOnly excludes this directory' : 'disabled is set in the effective config')
        : null,
      tokenSet: server.tokenSet,
      tokenSource: server.tokenSource,
    },
    bank: resolution.bank,
    bankSource: resolution.source,
    bankBase: resolution.base ?? null,
    project,
    bundles: installedBundles().bundles,
    sources: { ...stats.sources },
    stackTurns: stats.stackTurns,
    autoTune: autoTuneEnabled(),
    // Invalid bundle settings are never written; invalid file values are shown
    // because the integration would otherwise use them (or their fallback).
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
      turns: stats.turns,
      seen: stats.seen,
      lastTurnTokens: stats.lastTurnTokens,
      maxTurnTokens: stats.maxTurnTokens,
      capped: stats.capped,
      dropped: stats.dropped,
      last: stats.last,
      session: session ? { turns: session.turns, last: session.last, max: session.max, tokens: session.tokens } : null,
    },
    probe,
    activity,
  }
  status.stale = staleProcess(status)
  status.hint = hintFor(status)
  return status
}

/**
 * The integration is loaded once per process. If its journal's newest failure
 * still targets a different origin than the effective config, the running
 * process predates the config change — memory will keep failing until DSH is
 * restarted, which no amount of correct file content fixes.
 */
const STALE_FAILURE_MS = 3_600_000

function originOf(url) {
  try {
    return new URL(String(url)).origin.toLowerCase()
  } catch {
    return String(url ?? '').replace(/\/+$/, '').toLowerCase()
  }
}

function staleProcess(status) {
  const seen = status.activity.lastEndpoint
  if (!seen) return null
  const failedAt = Date.parse(status.activity.lastFailure?.ts ?? '')
  if (!Number.isFinite(failedAt) || Date.now() - failedAt > STALE_FAILURE_MS) return null
  const expected = originOf(status.server.apiUrl)
  if (!expected || originOf(seen) === expected) return null
  return {
    seen: originOf(seen),
    expected,
    event: status.activity.lastFailure?.event ?? null,
    bank: status.activity.lastBank ?? null,
  }
}

function formatStatus(status) {
  const state = !status.integration.installed
    ? 'memory layer not installed'
    : status.server.disabled
      ? 'disabled'
      : status.probe?.ok
        ? 'reachable'
        : 'memory unavailable'
  const recall = status.budget.session
  const lines = [
    `Hindsight memory — ${state}`,
    `  server   ${status.server.apiUrl} (${status.server.mode}) · token ${status.server.tokenSet ? `set (${status.server.tokenSource})` : 'not set'}`,
    ...(status.stale
      ? [`  process  newest journal failure still targets ${status.stale.seen} (${status.stale.event ?? 'failure'}${status.stale.bank ? `, bank ${status.stale.bank}` : ''}) — the running DSH loaded the old config; restart it`]
      : []),
    `  probe    ${formatProbe(status.probe)}`,
    `  bank     ${status.bank} (${status.bankSource})${status.bankBase ? ` renamed from ${status.bankBase}` : ''}${status.project.source === 'git' ? '' : '  (named from the directory; not shared with a git worktree bank)'}`,
    status.bundles.length > 0
      ? `  bundles  ${status.bundles.map((bundle) => `${bundle.name} ${bundle.version}${bundle.enabled ? '' : ' (disabled)'}`).join(' · ')}`
      : '  bundles  no memory bundles detected in this profile',
    ...(status.compat ? [`  compat   ${formatCompat(status.compat)}`] : []),
    `  config   ${status.file.path} (${describeKind(status.file.kind)}${status.file.error ? `: ${status.file.error}` : ''})`,
    `  auto     ${status.autoTune ? 'tune on the first session of a new process' : 'off (persisted; /hindsight enable turns it back on)'}`,
    `  tuning   ${formatPreset(status.preset)}`,
    ...(() => {
      const drift = presetDrift(status.preset, status.desired)
      return drift.length > 0 ? [`  drift    ${drift.join(' · ')} — /hindsight tune applies the preset`] : []
    })(),
    ...(() => {
      const layers = formatLayers({ config: status.effective, harnessKeys: status.layers.harness, envKeys: status.layers.env, sections: status.layers.sections }, status.desired)
      return layers ? [layers] : []
    })(),
    ...status.settingsIssues.map((issue) => `  invalid  ${issue.field}=${JSON.stringify(issue.value)} (${issue.message}) — not written`),
    ...status.configIssues.map((issue) => `  invalid  ${issue.path}=${JSON.stringify(issue.value)} (${issue.message}) — the integration falls back`),
    `  applied  ${status.applied.length ? `${status.applied.length} keys: ${status.applied.join(', ')}` : 'nothing by this plugin'}`,
    recall && recall.turns > 0
      ? `  recall   ${recall.turns} turns · last ~${recall.last}${recall.lastInjected !== recall.last ? ` → ~${recall.lastInjected}` : ''} tok · wanted max ~${recall.max} tok · avg ~${Math.round(recall.tokens / recall.turns)} tok`
      : '  recall   no Hindsight recall observed in this session yet',
    `  budget   ${status.budget.cap ? `cap ${status.budget.cap} tok/turn` : 'cap off'} · capped ${status.budget.capped} · dropped ${status.budget.dropped}`,
    `  tokens   ${formatTokens(status.tokens)}`,
  ]

  if (status.budget.turns > 0) {
    lines.push('  order    outermost hook: this turn\u2019s payload passed through the budget')
  } else {
    lines.push('  order    outermost hook installed (prepend); confirmed on the first recall')
  }

  const pages = status.effective.pageSearchLimit
  lines.push(`  pages    pageSearchLimit=${pages ?? 'unset'}${status.effective.recallMaxTokens != null ? ` · recall max_tokens=${status.effective.recallMaxTokens}` : ''}  (two separate ceilings)`)

  const sources = Object.entries(status.sources ?? {})
  lines.push(sources.length > 0
    ? `  sources  ${sources.map(([kind, count]) => `${kind} ${count} turns`).join(' · ')}`
    : '  sources  no plugin-injected messages in this session yet')
  if (status.stackTurns > 0) {
    lines.push(`  stack    more than one plugin injects per turn (${status.stackTurns} turns: ${(status.sources && Object.keys(status.sources).join(', ')) || 'unknown'}); their budgets add up — keep one memory lane`)
  }
  if (status.budget.last) {
    lines.push(`  last     cut ~${status.budget.last.before} → ~${status.budget.last.after} tokens`)
  }
  lines.push(`  journal  ${status.activity.path ?? diagPath()}`)
  lines.push(`  activity ${formatActivity(status.activity)}`)
  if (!status.probe?.ok && status.activity.lastInject) {
    lines.push('  note     inject_ok counts what Hindsight sent; while recall fails that is its static tool guide, not project memory')
  }
  lines.push(`  next     ${status.hint}`)
  return lines.join('\n')
}

function formatCompat(compat) {
  if (!compat.version) return `version unreadable (this release is tested with ${compat.tested})`
  if (compat.compatible === null) return `${compat.version} (this release is tested with ${compat.tested})`
  if (compat.compatible) return `${compat.version} (tested line ${TESTED_INTEGRATION.line}.x)`
  return `${compat.version} — outside the tested ${TESTED_INTEGRATION.line}.x line; the pre-step contract is private to that package, rerun npm test before trusting the budget`
}

function formatTokens(tokens) {
  if (tokens.mode !== 'accurate') return 'fast estimate (CJK 1/char, other 0.28/char)'
  const head = tokens.ready
    ? `accurate: ${tokens.name}`
    : `accurate requested, no tokenizer installed — fast ×${FALLBACK_MARGIN} (npm i js-tiktoken)`
  const calibration = tokens.samples > 0 && Number.isFinite(tokens.p50)
    ? ` · fast/accurate p50 ${tokens.p50.toFixed(2)}× p95 ${tokens.p95.toFixed(2)}× (n=${tokens.samples})`
    : ''
  return `${head}${calibration}`
}

function formatTune(result) {
  const heading = result.dryRun ? 'Would tune' : 'Tuned'
  const lines = [`${heading} ${result.path} (${result.fileExisted ? 'existing' : 'new file'})`]
  for (const change of result.changed) {
    const from = change.from === null ? 'unset' : JSON.stringify(change.from)
    lines.push(`  ${result.dryRun ? '~' : '+'} ${change.path}: ${from} → ${JSON.stringify(change.to)}`)
  }
  for (const kept of result.kept) lines.push(`  = ${kept.path}: already ${JSON.stringify(kept.value)}`)
  if (result.changed.length === 0) lines.push('  nothing to change')
  if (result.backupPath) lines.push(`  backup ${result.backupPath}`)
  if (result.dryRun) {
    lines.push('  (dry run: no file was changed)')
  } else if (result.changed.length > 0) {
    lines.push('  behavioural keys take effect for new sessions; apiToken is re-read on the next rejected request.')
    lines.push('  undo: /hindsight revert (removes only the keys above).')
  }
  return lines.join('\n')
}

function formatRevert(result) {
  const heading = result.dryRun ? 'Would revert' : 'Reverted'
  if (result.reverted.length === 0) {
    const lines = [`${heading} — nothing to undo in ${result.path}`]
    for (const skipped of result.skipped) {
      lines.push(`  ! ${skipped.path}: changed since the plugin wrote it (now ${JSON.stringify(skipped.current)}), left alone`)
    }
    if (!result.dryRun) {
      lines.push('  auto-tune is now off for new processes; /hindsight enable turns it back on.')
    }
    return lines.join('\n')
  }
  const lines = [`${heading} ${result.path}`]
  for (const entry of result.reverted) {
    lines.push(`  - ${entry.path}${entry.restored === null ? ' (removed)' : ` → ${JSON.stringify(entry.restored)}`}`)
  }
  for (const skipped of result.skipped) {
    lines.push(`  ! ${skipped.path}: changed since the plugin wrote it (now ${JSON.stringify(skipped.current)}), left alone`)
  }
  if (result.backupPath) lines.push(`  backup ${result.backupPath}`)
  if (result.dryRun) lines.push('  (dry run: no file was changed)')
  else lines.push('  auto-tune is now off for new processes; /hindsight enable turns it back on.')
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const checked = validateSettings(settings)
  settings.issues = checked.issues
  settings.preset = checked.preset
  if (settings.issues.some((issue) => issue.field === 'maxInjectTokens')) {
    settings.maxInjectTokens = 3000
  }

  const stats = {
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
    ratios: [],
    tokenizer: { mode: settings.tokenBudgetMode, name: null, ready: settings.tokenBudgetMode === 'fast' },
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
    measure(text) {
      const counted = countTokens(text, { mode: settings.tokenBudgetMode, encode: tokenizer?.encode })
      if (settings.tokenBudgetMode === 'accurate' && counted.exact) {
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

  const governor = createGovernor(settings, stats, meter)
  const preset = buildPreset(settings)
  let tuning = null
  let disposePreStep = null
  let reordered = false

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
        record({ event: 'tune_applied', changed: result.changed.map((change) => change.path) })
        return result
      } catch (error) {
        const message = String(error?.message ?? error)
        record({ event: 'tune_failed', error: message })
        return { error: message }
      }
    })()
    return tuning
  }

  /**
   * Re-register the pre-step hook as the outermost waterfall listener. This is
   * what makes the budget authoritative: Cordis prepends, so the last registration
   * wins, and a session-start fires after every bundle has mounted — that is the
   * first moment at which "after Hindsight" can be guaranteed regardless of the
   * profile's bundle order.
   */
  function attachPreStep() {
    try { disposePreStep?.() } catch { /* already gone */ }
    disposePreStep = ctx.on('agent/pre-step', governor.onPreStep, { prepend: true })
  }

  attachPreStep()

  ctx.on('agent/session-start', ({ agent } = {}) => {
    if (agent?.session?.header?.origin === 'subagent') return
    if (!reordered) {
      reordered = true
      attachPreStep()
    }
    ensureTuned().catch(() => {})
  })
  ctx.effect(() => () => {
    try { disposePreStep?.() } catch { /* already gone */ }
    governor.dispose()
  })
  record({ event: 'activated', autoTune: settings.autoTune, cap: settings.maxInjectTokens, recall: settings.recallMaxTokens, tokenBudgetMode: settings.tokenBudgetMode })

  /**
   * Writes are a user action, not an agent action. There is deliberately no
   * per-call "confirm" flag: a model can supply that itself, so it is not an
   * authorization boundary. A user who wants agent writes edits
   * `allowAgentWrites: true` into the bundle config; everyone else uses
   * /hindsight tune or /hindsight revert.
   */
  function mayWrite(options) {
    if (!options.viaTool) return true
    if (options.dryRun === true) return true
    return settings.allowAgentWrites
  }

  const refusal = 'Refused: this writes the shared Hindsight config, and agent writes are disabled for this bundle. Ask the user to run /hindsight tune (or /hindsight revert), or set allowAgentWrites: true in the bundle config.'

  function formatSuggestion(status) {
    const chars = status.activity.injectSizes ?? []
    // The upstream journal records characters, not tokens; use its own 0.3
    // chars/token ratio and label the result as derived.
    const seen = chars.map((size) => Math.ceil(size * 0.3))
    const p50 = percentile(seen, 50)
    const p95 = percentile(seen, 95)
    const observed = p95 ?? status.budget.maxTurnTokens ?? 0
    const cap = Math.max(512, Math.min(8000, Math.ceil((observed || 2000) * 1.25)))
    const recall = Math.min(cap, 2000)
    const lines = ['Hindsight budget suggestion (read-only)']
    if (p95) {
      lines.push(`  observed recall ~${p50} tok p50 · ~${p95} tok p95 (${seen.length} injections, char-based estimate)`)
    } else if (status.budget.maxTurnTokens > 0) {
      lines.push(`  observed recall: this session wanted up to ~${status.budget.maxTurnTokens} tok in one turn`)
    } else {
      lines.push('  no recall measured yet: the suggestion starts from the 2000-token default')
    }
    lines.push(`  cap      maxInjectTokens: ${cap}  (1.25× the p95, clamped 512..8000; current ${status.budget.cap})`)
    lines.push(`  recall   recallOptions.max_tokens: ${recall}  (Pages and Recall are separate ceilings; do not make recall larger than the cap by accident)`)
    if (status.effective.autoInject !== 'pages') {
      lines.push('  pages    autoInject: pages injects stored pages without a synthesis pass; prefer it for coding sessions')
    }
    lines.push('  apply    set these in the bundle config (cordis.patch.yml), or use /hindsight tune --cap N for this session only')
    lines.push('  why      a cap near the p95 keeps most turns intact while a rare huge recall is trimmed instead of dominating the window')
    return lines.join('\n')
  }

  async function runAction(action, options = {}) {
    const cwd = options.cwd ?? process.cwd()
    const writes = ['tune', 'revert', 'enable', 'disable']
    if (writes.includes(action) && !mayWrite(options)) return refusal

    if (action === 'tune') {
      const dryRun = options.dryRun === true
      if (options.cap !== undefined) {
        if (!Number.isInteger(options.cap) || options.cap < 0 || options.cap > 64000) {
          return 'Refused: --cap must be an integer 0..64000 (0 turns the cap off).'
        }
        // A preview must not change this session's behaviour either.
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
      if (!dryRun) tuning = Promise.resolve(result)
      record({ event: dryRun ? 'tune_previewed' : 'tune_requested', changed: result.changed.map((change) => change.path) })
      return formatTune(result)
    }
    if (action === 'revert') {
      const dryRun = options.dryRun === true
      const result = revertTuning({ dryRun })
      if (!dryRun) tuning = Promise.resolve({ skipped: true, reason: 'reverted' })
      record({ event: dryRun ? 'revert_previewed' : 'tune_reverted', reverted: result.reverted.map((entry) => entry.path) })
      return formatRevert(result)
    }
    if (action === 'disable') {
      setAutoTune(false)
      tuning = Promise.resolve({ skipped: true, reason: 'auto-tune disabled' })
      record({ event: 'autotune_disabled' })
      return 'Auto-tune disabled for this profile. Existing config keys are untouched; /hindsight enable restores automatic tuning.'
    }
    if (action === 'enable') {
      setAutoTune(true)
      tuning = null
      record({ event: 'autotune_enabled' })
      return 'Auto-tune enabled. The lean profile will be applied on the next session start; /hindsight tune applies it now.'
    }
    if (action === 'probe') {
      const integration = findIntegration()
      if (!integration.installed) {
        return 'Hindsight memory layer not installed: add @vectorize-io/hindsight-coding-agents to this profile first.'
      }
      const file = readConfigFile()
      const base = effectiveConfig(file.config, { cwd }).config
      const resolution = bankResolution(base, projectName(cwd).name, cwd)
      const effective = effectiveConfig(file.config, { cwd, bank: resolution.base ?? resolution.bank }).config
      const server = effectiveServer(effective, {})
      const probe = await probeServer({ apiUrl: server.apiUrl, apiToken: server.token, bankId: resolution.bank, timeoutMs: 4000 })
      return `Hindsight server — ${formatProbe(probe)}\n  ${server.apiUrl} · bank ${resolution.bank} (${resolution.source})${server.tokenSet ? '' : ' · no token configured'}`
    }
    if (action === 'suggest') {
      return formatSuggestion(await buildStatus(settings, stats, governor, cwd, options.sessionId))
    }
    return formatStatus(await buildStatus(settings, stats, governor, cwd, options.sessionId))
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'hindsight_tuner',
      description:
        'Inspect the Hindsight project-memory integration in this profile: reachability, the effective shared config (environment, harness, paths/banks sections), token budget and per-turn recall cost, invalid values, and a read-only budget suggestion. This tool does not modify the shared config unless the user explicitly enabled allowAgentWrites in the bundle config; ask them to run /hindsight tune or /hindsight revert instead. Returns a short text report.',
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
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : 'status'
        try {
          return await runAction(action, {
            cwd: exec?.agent?.session?.header?.cwd,
            sessionId: exec?.agent?.session?.header?.id,
            viaTool: true,
            overwrite: typeof args?.overwrite === 'boolean' ? args.overwrite : undefined,
            dryRun: args?.dryRun === true,
          })
        } catch (error) {
          return `hindsight_tuner ${action} failed: ${String(error?.message ?? error)}`
        }
      },
    })
  })

  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: 'hindsight',
        description: 'Hindsight memory: status | tune [--dry-run] [--overwrite] [--cap N] | revert [--dry-run] | probe | suggest | enable | disable',
        async handler(invocation) {
          const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const action = parts.shift() || 'status'
          if (!ACTIONS.includes(action)) {
            return { kind: 'error', text: `Unknown action "${action}". Use ${ACTIONS.join(', ')}.` }
          }
          const flags = parseCommandFlags(parts)
          if (flags.unknown) {
            return { kind: 'error', text: `Unknown option "${flags.unknown}". Use --dry-run, --overwrite, or --cap N.` }
          }
          if ((flags.overwrite || flags.cap !== undefined) && action !== 'tune') {
            return { kind: 'error', text: 'Options --overwrite and --cap are only valid for tune.' }
          }
          if (flags.dryRun && !['tune', 'revert'].includes(action)) {
            return { kind: 'error', text: 'Option --dry-run is only valid for tune or revert.' }
          }
          try {
            const text = await runAction(action, {
              cwd: invocation?.agent?.session?.header?.cwd,
              sessionId: invocation?.agent?.session?.header?.id,
              dryRun: flags.dryRun === true,
              overwrite: flags.overwrite === true,
              cap: flags.cap,
            })
            return { kind: text.startsWith('Refused:') ? 'error' : 'success', text }
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

function parseCommandFlags(parts) {
  const flags = {}
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === '--dry-run') flags.dryRun = true
    else if (part === '--overwrite') flags.overwrite = true
    else if (part === '--cap') flags.cap = Number(parts[++index])
    else if (part.startsWith('--cap=')) flags.cap = Number(part.slice('--cap='.length))
    else flags.unknown = part
  }
  return flags
}
