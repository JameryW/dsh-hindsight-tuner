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
 *    backup and an exact undo;
 *  - it caps what a single turn can receive from Hindsight at `maxInjectTokens`,
 *    compensating for the integration's own dedupe check, which compares the
 *    last injected text and would re-inject after a trim;
 *  - it diagnoses the integration from its own journal, because a missing token
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
  bankIdFor,
  effectiveServer,
  probeServer,
  projectName,
  summarizeActivity,
} from './lib/diagnostics.js'
import { record } from './lib/log.js'
import { estimateTokens, truncateToBudget } from './lib/tokens.js'

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
function findIntegration() {
  const roots = new Set()
  if (process.env.DSH_PROFILE_DIR) roots.add(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    roots.add(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE))
  }
  if (process.env.DSH_INSTALL_DIR) roots.add(process.env.DSH_INSTALL_DIR)
  for (const root of roots) {
    const manifest = join(root, 'node_modules', '@vectorize-io', 'hindsight-coding-agents', 'package.json')
    if (existsSync(manifest)) return { installed: true, path: manifest }
  }
  return { installed: false, path: null }
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
 * Cap one turn's Hindsight recall. The integration decides "unchanged" by
 * comparing the new recall with the last injected message, which our trim
 * breaks; so when the same raw payload arrives twice we drop the duplicate
 * instead of letting it through untrimmed.
 */
function createGovernor(settings, stats) {
  const seen = new Map()

  async function onPreStep(payload, next) {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const index = decision.messages.findIndex((message) => message?.source?.kind === settings.sourceKind)
    if (index < 0) return decision

    const message = decision.messages[index]
    const raw = textOf(message)
    if (!raw) return decision
    const tokens = estimateTokens(raw)

    stats.seen += 1
    stats.lastTokens = tokens
    stats.maxTokens = Math.max(stats.maxTokens, tokens)
    stats.totalTokens += tokens

    const cap = settings.maxInjectTokens
    if (!cap || tokens <= cap) return decision

    const sessionId = payload?.agent?.session?.header?.id ?? 'unknown'
    const previous = seen.get(sessionId)

    if (previous && previous.raw === raw) {
      stats.deduped += 1
      record({ event: 'inject_deduped', session: sessionId, tokens })
      return { ...decision, messages: decision.messages.filter((_, position) => position !== index) }
    }

    const marker = `\n\n…[dsh-hindsight-tuner: cut from ~${tokens} to ~${cap} tokens. Ask Hindsight for the full recall explicitly, or raise maxInjectTokens.]`
    const trimmed = truncateToBudget(raw, cap, marker)
    const after = estimateTokens(trimmed)

    remember(seen, sessionId, { raw })
    stats.capped += 1
    stats.last = { before: tokens, after, at: new Date().toISOString() }
    record({ event: 'inject_capped', session: sessionId, before: tokens, after })

    const messages = decision.messages.slice()
    messages[index] = { ...message, content: [{ type: 'text', text: trimmed }] }
    return { ...decision, messages }
  }

  return { onPreStep, dispose: () => seen.clear() }
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
    return 'Hindsight is disabled in the shared config (disabled: true); clear that key to turn memory back on.'
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
  if (probe?.ok) {
    return 'Memory is reachable. A cold bank seeds git history on the first session; pages appear as they consolidate.'
  }
  return 'Run /hindsight tune to apply the lean profile, or inspect the config path above.'
}

async function buildStatus(settings, stats, cwd = process.cwd()) {
  const file = readConfigFile()
  const server = effectiveServer(file.config)
  const integration = findIntegration()
  const project = projectName(cwd)
  const bank = bankIdFor(file.config, project.name)
  const probe = !integration.installed || server.disabled ? null : await probeServer({
    apiUrl: server.apiUrl,
    apiToken: server.token,
    bankId: bank,
    timeoutMs: 4000,
  })

  const status = {
    file: { path: file.path, kind: file.kind, error: file.error ?? null },
    integration,
    server: {
      mode: server.mode,
      apiUrl: server.apiUrl,
      disabled: server.disabled,
      tokenSet: server.tokenSet,
      tokenSource: server.tokenSource,
    },
    bank,
    project,
    preset: {
      autoInject: getPath(file.config, 'autoInject') ?? null,
      injectTimeoutMs: getPath(file.config, 'injectTimeoutMs') ?? null,
      observationScopes: getPath(file.config, 'observationScopes') ?? null,
      recallMaxTokens: getPath(file.config, 'recallOptions.max_tokens') ?? null,
    },
    applied: appliedPaths(),
    budget: {
      cap: settings.maxInjectTokens,
      seen: stats.seen,
      lastTokens: stats.lastTokens,
      maxTokens: stats.maxTokens,
      avgTokens: stats.seen > 0 ? Math.round(stats.totalTokens / stats.seen) : 0,
      capped: stats.capped,
      deduped: stats.deduped,
      last: stats.last,
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
  const lines = [
    `Hindsight memory — ${state}`,
    `  server   ${status.server.apiUrl} (${status.server.mode}) · token ${status.server.tokenSet ? `set (${status.server.tokenSource})` : 'not set'}`,
    `  probe    ${formatProbe(status.probe)}`,
    `  bank     ${status.bank}${status.project.source === 'git' ? '' : '  (named from the directory; not shared with a git worktree bank)'}`,
    `  config   ${status.file.path} (${describeKind(status.file.kind)}${status.file.error ? `: ${status.file.error}` : ''})`,
    `  tuning   ${formatPreset(status.preset)}`,
    `  applied  ${status.applied.length ? `${status.applied.length} keys: ${status.applied.join(', ')}` : 'nothing by this plugin'}`,
    status.budget.seen > 0
      ? `  recall   this session: ${status.budget.seen} seen · last ~${status.budget.lastTokens} tok · max ~${status.budget.maxTokens} tok · avg ~${status.budget.avgTokens} tok`
      : '  recall   no Hindsight recall observed in this session yet',
    `  budget   ${status.budget.cap ? `cap ${status.budget.cap} tok/turn` : 'cap off'} · capped ${status.budget.capped} · deduped ${status.budget.deduped}`,
  ]
  if (status.budget.last) {
    lines.push(`  last     cut ~${status.budget.last.before} → ~${status.budget.last.after} tokens`)
  }
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
  const stats = { seen: 0, lastTokens: 0, maxTokens: 0, totalTokens: 0, capped: 0, deduped: 0, last: null }
  const governor = createGovernor(settings, stats)
  const preset = buildPreset(settings)
  let tuning = null

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

  ctx.on('agent/session-start', ({ agent } = {}) => {
    if (agent?.session?.header?.origin === 'subagent') return
    ensureTuned().catch(() => {})
  })
  ctx.on('agent/pre-step', governor.onPreStep)
  ctx.effect(() => () => governor.dispose())
  record({ event: 'activated', autoTune: settings.autoTune, cap: settings.maxInjectTokens, recall: settings.recallMaxTokens })

  async function runAction(action, options = {}) {
    const cwd = options.cwd ?? process.cwd()
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
      const server = effectiveServer(file.config)
      const bank = bankIdFor(file.config, projectName(cwd).name)
      const probe = await probeServer({ apiUrl: server.apiUrl, apiToken: server.token, bankId: bank, timeoutMs: 4000 })
      return `Hindsight server — ${formatProbe(probe)}\n  ${server.apiUrl} · bank ${bank}${server.tokenSet ? '' : ' · no token configured'}`
    }
    return formatStatus(await buildStatus(settings, stats, cwd))
  }

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register({
      name: 'hindsight_tuner',
      description:
        'Inspect and tune the Hindsight project-memory integration in this profile. Reports whether memory is reachable and why, applies a lean pages-first / per-source / token-budgeted profile to the shared ~/.hindsight/coding-agent.json, and can undo exactly the edits it made. Returns a short text report.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTIONS,
            description:
              'status: health, current tuning and this session\'s injection budget. tune: apply the lean profile to the shared config. revert: undo only the keys this plugin wrote. probe: reachability check without reading the journal.',
          },
          overwrite: {
            type: 'boolean',
            description: 'On tune, replace values that already exist instead of respecting the user\'s choice. Defaults to the bundle config.',
          },
          dryRun: {
            type: 'boolean',
            description: 'On tune, report the diff without writing the config file.',
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
              text: await runAction(action, { cwd: invocation?.agent?.session?.header?.cwd }),
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
