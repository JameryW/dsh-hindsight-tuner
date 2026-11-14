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

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  appliedPaths,
  applyTuning,
  getPath,
  readConfigFile,
  revertTuning,
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
import { allocateBudget, estimateTokens, truncateToBudget } from './lib/tokens.js'

const PLUGIN = 'hindsight-tuner'
const MAX_REMEMBERED_SESSIONS = 40
const ACTIONS = ['status', 'tune', 'revert', 'probe']

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
    observationScopes: text(raw.observationScopes, 'per_source'),
    // The integration's own recall default is 2000; pinning it keeps the budget
    // explicit and survives a future release that raises its default.
    recallMaxTokens: number(raw.recallMaxTokens, 2000),
    sourceKind: text(raw.sourceKind, 'plugin:hindsight'),
    // A tool call is an agent action; writing the user's global config from it
    // needs either this opt-in or an explicit confirm argument.
    allowAgentWrites: raw.allowAgentWrites === true,
  }
}

function buildPreset(settings) {
  return [
    ['autoInject', settings.autoInject],
    ['injectTimeoutMs', settings.injectTimeoutMs],
    ['observationScopes', settings.observationScopes],
    ['recallOptions.max_tokens', settings.recallMaxTokens],
  ]
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
let integrationMemo = null

function findIntegration() {
  const roots = new Set()
  if (process.env.DSH_PROFILE_DIR) roots.add(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    roots.add(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE))
  }
  if (process.env.DSH_INSTALL_DIR) roots.add(process.env.DSH_INSTALL_DIR)

  const key = [...roots].join('|')
  if (integrationMemo?.key === key) return integrationMemo.value

  let value = { installed: false, path: null }
  for (const root of roots) {
    const manifest = join(root, 'node_modules', '@vectorize-io', 'hindsight-coding-agents', 'package.json')
    if (existsSync(manifest)) {
      value = { installed: true, path: manifest }
      break
    }
  }
  integrationMemo = { key, value }
  return value
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
function createGovernor(settings, stats) {
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
      candidates.push({ index, message, text, tokens: estimateTokens(text) })
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
        const trimmed = allotted > 0 ? truncateToBudget(candidate.text, allotted, marker) : ''
        if (!trimmed) {
          removed.add(candidate.index)
          dropped += 1
          return
        }
        const otherBlocks = Array.isArray(candidate.message.content)
          ? candidate.message.content.filter((block) => block?.type !== 'text')
          : []
        messages[candidate.index] = { ...candidate.message, content: [{ type: 'text', text: trimmed }, ...otherBlocks] }
        after += estimateTokens(trimmed)
      })
      stats.capped += 1
      stats.dropped += dropped
      stats.last = { before: total, after, at: new Date().toISOString() }
      record({ event: 'inject_capped', session: sessionId, before: total, after, dropped })
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
  const status = {
    file: { path: file.path, kind: file.kind, error: file.error ?? null },
    integration,
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
    activity: summarizeActivity(),
  }
  status.hint = hintFor(status)
  return status
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
    `  probe    ${formatProbe(status.probe)}`,
    `  bank     ${status.bank} (${status.bankSource})${status.bankBase ? ` renamed from ${status.bankBase}` : ''}${status.project.source === 'git' ? '' : '  (named from the directory; not shared with a git worktree bank)'}`,
    status.bundles.length > 0
      ? `  bundles  ${status.bundles.map((bundle) => `${bundle.name} ${bundle.version}${bundle.enabled ? '' : ' (disabled)'}`).join(' · ')}`
      : '  bundles  no memory bundles detected in this profile',
    `  config   ${status.file.path} (${describeKind(status.file.kind)}${status.file.error ? `: ${status.file.error}` : ''})`,
    `  tuning   ${formatPreset(status.preset)}`,
    ...(() => {
      const drift = presetDrift(status.preset, status.desired)
      return drift.length > 0 ? [`  drift    ${drift.join(' · ')} — /hindsight tune applies the preset`] : []
    })(),
    ...(() => {
      const layers = formatLayers({ config: status.effective, harnessKeys: status.layers.harness, envKeys: status.layers.env, sections: status.layers.sections }, status.desired)
      return layers ? [layers] : []
    })(),
    `  applied  ${status.applied.length ? `${status.applied.length} keys: ${status.applied.join(', ')}` : 'nothing by this plugin'}`,
    recall && recall.turns > 0
      ? `  recall   ${recall.turns} turns · last ~${recall.last}${recall.lastInjected !== recall.last ? ` → ~${recall.lastInjected}` : ''} tok · wanted max ~${recall.max} tok · avg ~${Math.round(recall.tokens / recall.turns)} tok`
      : '  recall   no Hindsight recall observed in this session yet',
    `  budget   ${status.budget.cap ? `cap ${status.budget.cap} tok/turn` : 'cap off'} · capped ${status.budget.capped} · dropped ${status.budget.dropped}`,
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
  if (!result.dryRun && result.changed.length > 0) {
    lines.push('  behavioural keys take effect for new sessions; apiToken is re-read on the next rejected request.')
    lines.push('  undo: /hindsight revert (removes only the keys above).')
  }
  return lines.join('\n')
}

function formatRevert(result) {
  if (result.reverted.length === 0) {
    const lines = [`Nothing reverted in ${result.path}`]
    for (const skipped of result.skipped) {
      lines.push(`  ! ${skipped.path}: changed since the plugin wrote it (now ${JSON.stringify(skipped.current)}), left alone`)
    }
    return lines.join('\n')
  }
  const lines = [`Reverted ${result.path}`]
  for (const entry of result.reverted) {
    lines.push(`  - ${entry.path}${entry.restored === null ? ' (removed)' : ` → ${JSON.stringify(entry.restored)}`}`)
  }
  for (const skipped of result.skipped) {
    lines.push(`  ! ${skipped.path}: changed since the plugin wrote it (now ${JSON.stringify(skipped.current)}), left alone`)
  }
  if (result.backupPath) lines.push(`  backup ${result.backupPath}`)
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
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
  }
  const governor = createGovernor(settings, stats)
  const preset = buildPreset(settings)
  let tuning = null
  let disposePreStep = null
  let reordered = false

  function ensureTuned() {
    if (tuning) return tuning
    tuning = (async () => {
      if (!settings.autoTune) return { skipped: true, reason: 'autoTune is off' }
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
  record({ event: 'activated', autoTune: settings.autoTune, cap: settings.maxInjectTokens, recall: settings.recallMaxTokens })

  /** A write from a tool call needs explicit authorization; a user command does not. */
  function mayWrite(options) {
    if (!options.viaTool) return true
    if (options.dryRun) return true
    if (settings.allowAgentWrites) return true
    return options.confirm === true
  }

  const refusal = 'Refused: this writes the shared Hindsight config. Pass confirm: true, or set allowAgentWrites: true in the bundle config.'

  async function runAction(action, options = {}) {
    const cwd = options.cwd ?? process.cwd()
    if (action === 'tune' || action === 'revert') {
      if (!mayWrite(options)) return refusal
    }
    if (action === 'tune') {
      const result = applyTuning({
        preset,
        overwrite: options.overwrite ?? settings.overwrite,
        dryRun: options.dryRun === true,
      })
      if (!result.dryRun) tuning = Promise.resolve(result)
      record({ event: result.dryRun ? 'tune_previewed' : 'tune_requested', changed: result.changed.map((change) => change.path) })
      return formatTune(result)
    }
    if (action === 'revert') {
      const result = revertTuning()
      tuning = Promise.resolve({ skipped: true, reason: 'reverted' })
      record({ event: 'tune_reverted', reverted: result.reverted.map((entry) => entry.path) })
      return formatRevert(result)
    }
    if (action === 'probe') {
      const integration = findIntegration()
      if (!integration.installed) {
        return 'Hindsight memory layer not installed: add @vectorize-io/hindsight-coding-agents to this profile first.'
      }
      const file = readConfigFile()
      const effective = effectiveConfig(file.config).config
      const server = effectiveServer(effective, {})
      const resolution = bankResolution(effective, projectName(cwd).name, cwd)
      const probe = await probeServer({ apiUrl: server.apiUrl, apiToken: server.token, bankId: resolution.bank, timeoutMs: 4000 })
      return `Hindsight server — ${formatProbe(probe)}\n  ${server.apiUrl} · bank ${resolution.bank} (${resolution.source})${server.tokenSet ? '' : ' · no token configured'}`
    }
    return formatStatus(await buildStatus(settings, stats, governor, cwd, options.sessionId))
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'hindsight_tuner',
      description:
        'Inspect and tune the Hindsight project-memory integration in this profile. Reports whether memory is reachable and why, applies a lean pages-first / per-source / token-budgeted profile to the shared ~/.hindsight/coding-agent.json, and can undo exactly the edits it made. Writes from this tool require confirm: true unless allowAgentWrites is enabled. Returns a short text report.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTIONS,
            description:
              'status: health, effective config, and this session\'s injection budget. tune: apply the lean profile to the shared config. revert: undo only the keys this plugin wrote. probe: reachability check without reading the journal.',
          },
          overwrite: {
            type: 'boolean',
            description: 'On tune, replace values that already exist instead of respecting the user\'s choice. Defaults to the bundle config.',
          },
          dryRun: {
            type: 'boolean',
            description: 'On tune, report the diff without writing the config file.',
          },
          confirm: {
            type: 'boolean',
            description: 'Explicit authorization for tune/revert when allowAgentWrites is off.',
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
            confirm: args?.confirm === true,
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
        description: 'Show Hindsight memory health and injection budget; append tune, revert, or probe',
        async handler(invocation) {
          const action = String(invocation?.rawInput ?? '').trim().split(/\s+/)[0] || 'status'
          if (!ACTIONS.includes(action)) {
            return { kind: 'error', text: `Unknown action "${action}". Use status, tune, revert, or probe.` }
          }
          try {
            return {
              kind: 'success',
              text: await runAction(action, {
                cwd: invocation?.agent?.session?.header?.cwd,
                sessionId: invocation?.agent?.session?.header?.id,
              }),
            }
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
