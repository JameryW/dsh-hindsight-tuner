/**
 * Diagnostic status, budget suggestion, and mutation report formatters.
 *
 * Pure formatting and read-only status interpretation separated from `index.js`
 * so the plugin entrypoint stays compact and readable.
 */

import { getPath } from './config-file.js'
import { diagPath } from './diagnostics.js'
import { DEFAULT_SCENARIO_TIERS, SCENARIO_NAMES } from './scenario.js'
import { FALLBACK_MARGIN, percentile } from './tokens.js'

export const TESTED_INTEGRATION = { line: '0.8', version: '0.8.7' }
export const ACCEPTED_INTEGRATION_LINES = ['0.9', '0.10']
const STALE_FAILURE_MS = 15 * 60_000

export function originOf(url) {
  try {
    return new URL(String(url)).origin.toLowerCase()
  } catch {
    return String(url ?? '').replace(/\/+$/, '').toLowerCase()
  }
}

export function detailMessage(text) {
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

export function describeKind(kind) {
  if (kind === 'ok') return 'present'
  if (kind === 'missing') return 'absent, created on first tune'
  return `unreadable${kind === 'invalid' ? ' JSON' : ''}`
}

export function formatProbe(probe) {
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

export function formatPreset(preset) {
  return [
    `autoInject=${preset.autoInject ?? 'unset'}`,
    `injectTimeoutMs=${preset.injectTimeoutMs ?? 'unset'}`,
    `observationScopes=${preset.observationScopes ?? 'unset'}`,
    `recall.max_tokens=${preset.recallMaxTokens ?? 'unset'}`,
  ].join(' · ')
}

export function presetDrift(actual, desired) {
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

export function formatLayers(layers, preset) {
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

export function formatActivity(activity, history = null, tokenRatio = 0.3) {
  const ratio = Number.isFinite(tokenRatio) && tokenRatio >= 0.22 && tokenRatio <= 1.10 ? tokenRatio : 0.3
  const builtin = history?.builtin
  const hasBuiltin = builtin && (builtin.injected > 0 || builtin.pagesOk > 0 || builtin.recallOk > 0 || builtin.reflectOk > 0 || builtin.retainOk > 0 || builtin.errors > 0)
  if (!activity.exists || activity.scanned === 0) {
    if (!hasBuiltin) return activity.exists ? '24h: nothing recorded' : 'no Hindsight journal yet'
    const parts = []
    if (builtin.injected > 0) parts.push(`inject_ok ${builtin.injected}`)
    if (builtin.pagesOk > 0) parts.push(`pages_ok ${builtin.pagesOk}`)
    if (builtin.recallOk > 0) parts.push(`recall_ok ${builtin.recallOk}`)
    if (builtin.reflectOk > 0) parts.push(`reflect_ok ${builtin.reflectOk}`)
    if (builtin.retainOk > 0) parts.push(`retain_ok ${builtin.retainOk}`)
    if (builtin.errors > 0) parts.push(`errors ${builtin.errors}`)
    if (builtin.lastInject) parts.push(`last inject ~${Math.ceil(builtin.lastInject.chars * ratio)} tok`)
    return `24h (built-in): ${parts.join(' · ')}`
  }
  if (activity.error) return activity.error
  const entries = Object.entries(activity.recent ?? {}).sort((left, right) => right[1] - left[1])
  const parts = entries.slice(0, 5).map(([event, count]) => `${event} ${count}`)
  if (activity.authFailures > 0) parts.push(`auth failures ${activity.authFailures}`)
  if (activity.foreignFailures > 0) parts.push(`${activity.foreignFailures} failures to another server (old process)`)
  const banks = Object.entries(activity.banks ?? {}).sort((left, right) => right[1] - left[1])
  if (banks.length > 1) parts.push(`banks ${banks.slice(0, 2).map(([bank, count]) => `${bank} ${count}`).join(', ')}`)
  if (activity.lastInject) parts.push(`last inject ~${activity.lastInject.tokens} tok`)
  return parts.length > 0 ? `24h: ${parts.join(' · ')}` : '24h: nothing recorded'
}

export function memoryMetrics(activity, history = null) {
  const recent = activity?.recent ?? {}
  const extInjected = recent.inject_ok ?? 0
  const unchanged = recent.inject_unchanged ?? 0
  const builtin = history?.builtin
  const injected = extInjected > 0 ? extInjected : (builtin?.injected ?? 0)
  const attempts = injected + unchanged
  const pagesOk = (recent.pages_ok ?? 0) > 0 ? recent.pages_ok : (builtin?.pagesOk ?? 0)
  const extErrors = (recent.pages_failed ?? 0) + (recent.retain_failed ?? 0) + (recent.reflect_failed ?? 0)
  const serverErrors = extErrors + (builtin?.errors ?? 0)
  return {
    windowHours: 24,
    injected,
    unchanged,
    refreshPct: attempts > 0 ? Math.round((injected / attempts) * 1000) / 10 : null,
    pagesOk,
    serverErrors,
  }
}

export function formatMemory(memory) {
  if (!memory || memory.refreshPct === null) return null
  return `24h: ${memory.refreshPct}% of recalls were fresh (${memory.injected} injected / ${memory.unchanged} unchanged) · ${memory.serverErrors} server errors`
}

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age'
  if (ms < 60_000) return 'under a minute ago'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

export function staleProcess(status) {
  const seen = status.activity.lastFailure?.endpoint ?? status.activity.lastEndpoint
  if (!seen) return null
  const failedAt = Date.parse(status.activity.lastFailure?.ts ?? '')
  if (!Number.isFinite(failedAt)) return null
  const succeededAt = Date.parse(status.activity.lastSuccess?.ts ?? '')
  if (Number.isFinite(succeededAt) && succeededAt > failedAt) return null
  const ageMs = Date.now() - failedAt
  if (ageMs < 0 || ageMs > STALE_FAILURE_MS) return null
  const expected = originOf(status.server.apiUrl)
  if (!expected || originOf(seen) === expected) return null
  return {
    seen: originOf(seen),
    expected,
    event: status.activity.lastFailure?.event ?? null,
    bank: status.activity.lastBank ?? null,
    ageMs,
  }
}

export function hintFor(status) {
  const probe = status.probe
  const activeLane = status.lane?.active
  if (activeLane === 'missing-external') {
    return 'The Hindsight memory bundle is not installed in this profile: add @vectorize-io/hindsight-coding-agents, or set memoryLane: auto for the built-in engine, then run /hindsight probe.'
  }
  if (activeLane === 'off') {
    return 'Hindsight memory governance is turned off by memoryLane: off; set memoryLane: auto to re-enable.'
  }
  if (status.server.disabled) {
    return status.server.disabledReason === 'optInOnly excludes this directory'
      ? 'This directory is outside optInOnly/optInPaths, so Hindsight will not inject here; add the path or remove optInOnly.'
      : 'Hindsight is disabled in the shared config (disabled: true); clear that key to turn memory back on.'
  }
  if (status.configIssues.length > 0) {
    return 'The shared config contains values the integration does not accept: it silently falls back for enums and types, and uses out-of-range numbers as they are. Fix the invalid lines above (or run /hindsight tune) before trusting this report.'
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
    return activeLane === 'builtin'
      ? 'The bank does not exist yet; run /hindsight seed (or enable autoSeed) to populate it from git history.'
      : 'The bank does not exist yet; the first session on this repository creates it by seeding git history.'
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
  if (status.tuneError) {
    return `Automatic tuning failed (${status.tuneError}). Fix the permission or file error above, then run /hindsight tune.`
  }
  if (status.budget.prestepErrors > 0) {
    return `${status.budget.prestepErrors} pre-step(s) failed inside the plugin and passed through ungoverned; inspect tuner.jsonl (prestep_error) before trusting the budget.`
  }
  if (activeLane === 'external' && status.budget.turns === 0 && status.budget.preSteps > 0 && status.budget.injectSinceBoot) {
    return 'The journal shows Hindsight injections since this process started, but none reached this hook: another pre-step listener is wrapping it. Restart DSH or check bundle order, then check /hindsight again.'
  }
  if (probe?.ok) {
    return activeLane === 'builtin'
      ? 'Memory is reachable (built-in engine). Use /hindsight seed to ingest git commits if the bank is cold.'
      : 'Memory is reachable. A cold bank seeds git history on the first session; pages appear as they consolidate.'
  }
  return 'Run /hindsight tune to apply the lean profile, or inspect the config path above.'
}

export function formatCompat(compat) {
  if (!compat.version) return `version unreadable (this release is tested with ${compat.tested})`
  if (compat.compatible === null) return `${compat.version} (this release is tested with ${compat.tested})`
  if (compat.status === 'tested') return `${compat.version} (tested line ${TESTED_INTEGRATION.line}.x)`
  if (compat.status === 'accepted') {
    return `${compat.version} (accepted ${ACCEPTED_INTEGRATION_LINES.join('/')}.x line; CI-tested with ${TESTED_INTEGRATION.line}.x only)`
  }
  return `${compat.version} — outside the supported ${TESTED_INTEGRATION.line}.x–${ACCEPTED_INTEGRATION_LINES[ACCEPTED_INTEGRATION_LINES.length - 1]}.x lines; the pre-step contract is private to that package, rerun npm test before trusting the budget`
}

export function formatTokens(tokens) {
  if (tokens.mode === 'calibrated') {
    const calibration = tokens.samples > 0 && Number.isFinite(tokens.p50)
      ? ` · calibrated/fast p50 ${tokens.p50.toFixed(2)}× p95 ${tokens.p95.toFixed(2)}× (n=${tokens.samples})`
      : ''
    return `calibrated BPE estimate (built-in, zero-dependency)${calibration}`
  }
  if (tokens.mode !== 'accurate') return 'fast estimate (CJK 1/char, other 0.28/char)'
  const head = tokens.ready
    ? `accurate: ${tokens.name}`
    : `accurate requested, no external tokenizer installed — fast ×${FALLBACK_MARGIN}`
  const calibration = tokens.samples > 0 && Number.isFinite(tokens.p50)
    ? ` · fast/accurate p50 ${tokens.p50.toFixed(2)}× p95 ${tokens.p95.toFixed(2)}× (n=${tokens.samples})`
    : ''
  return `${head}${calibration}`
}

export function formatTier(budget) {
  const tiers = budget.tiers ?? {}
  const table = `${tiers.light ?? '?'}/${tiers.normal ?? '?'}/${tiers.deep ?? '?'} (light/normal/deep)`
  const last = budget.tier
  if (budget.policy === 'scenario') {
    const overrides = scenarioOverrides(budget)
    if (!last) return `scenario ${table}${overrides} · no recall yet`
    const used = Number.isFinite(last.budget) ? last.budget : last.ceiling
    const wanted = Number.isFinite(last.requested) ? `; ~${last.requested} wanted` : ''
    return `scenario ${table}${overrides} · last ${last.scenario ?? '?'} → ${last.name} ${used} (${last.reason}${wanted})`
  }
  if (budget.policy !== 'adaptive') return 'tier off'
  if (!last) return `adaptive ${table} · no recall yet`
  const used = Number.isFinite(last.budget) ? last.budget : last.ceiling
  const wanted = Number.isFinite(last.requested) ? `; ~${last.requested} wanted` : ''
  return `adaptive ${table} · last ${last.name} ${used} (${last.reason}${wanted})`
}

function scenarioOverrides(budget) {
  const tiers = budget.scenarioTiers ?? {}
  const changed = SCENARIO_NAMES.filter((scenario) => tiers[scenario] && tiers[scenario] !== DEFAULT_SCENARIO_TIERS[scenario])
  return changed.length > 0
    ? ` · overrides ${changed.map((scenario) => `${scenario}=${tiers[scenario]}`).join(', ')}`
    : ''
}

export function formatScenarios(budget) {
  if (budget.policy !== 'scenario') return ''
  const counts = Object.entries(budget.scenarios ?? {}).sort((left, right) => right[1] - left[1])
  return counts.length > 0
    ? ` · scenarios ${counts.map(([scenario, count]) => `${scenario} ${count}`).join(', ')}`
    : ''
}

export function formatRepeat(budget) {
  if (budget.repeatPolicy !== 'skip') return 'repeat inject'
  const threshold = Math.round((budget.repeatThreshold ?? 0.9) * 100)
  const last = Number.isFinite(budget.lastRepeat) && budget.lastRepeat > 0
    ? ` · last ${Math.round(budget.lastRepeat * 100)}% repeat`
    : ''
  const reentered = budget.reentered > 0 ? ` · re-entered ${budget.reentered}` : ''
  const deltas = budget.deltas > 0 ? ` · deltas ${budget.deltas}` : ''
  return `repeat skip ≥${threshold}% · skipped ${budget.repeatSkips}${last}${reentered}${deltas}`
}

export function formatSavings(budget) {
  const saved = (budget.trimmedTokens ?? 0) + (budget.savedTokens ?? 0) + (budget.deltaSaved ?? 0)
  return saved > 0 ? ` · saved ~${saved} tok` : ''
}

export function formatTune(result) {
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

export function formatRevert(result) {
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

export function formatLaneLine(status) {
  const lane = status.lane?.active
  if (lane === 'builtin') {
    return `  lane     built-in Hindsight engine (standalone · tools ${status.lane.tools ? 'on' : 'off'})`
  }
  if (lane === 'external') {
    return `  lane     external @vectorize-io/hindsight-coding-agents ${status.integration.version ?? ''}`.trimEnd()
  }
  if (lane === 'missing-external') {
    return '  lane     external required (not installed; set memoryLane: auto for built-in)'
  }
  if (lane === 'off') {
    return '  lane     off (memoryLane: off)'
  }
  return null
}

export function formatStatus(status) {
  const activeLane = status.lane?.active
  const state = activeLane === 'missing-external'
    ? 'memory layer not installed'
    : activeLane === 'off' || status.server.disabled
      ? 'disabled'
      : status.probe?.ok
        ? 'reachable'
        : 'memory unavailable'
  const recall = status.budget.session
  const laneLine = formatLaneLine(status)
  const lines = [
    `Hindsight memory — ${state}`,
    ...(laneLine ? [laneLine] : []),
    `  server   ${status.server.apiUrl} (${status.server.mode}) · token ${status.server.tokenSet ? `set (${status.server.tokenSource})` : 'not set'}`,
    ...(status.stale
      ? [`  process  newest journal failure still targets ${status.stale.seen} (${status.stale.event ?? 'failure'}${status.stale.bank ? `, bank ${status.stale.bank}` : ''}, ${formatAge(status.stale.ageMs)}) — the running DSH loaded the old config; restart it`]
      : []),
    `  probe    ${formatProbe(status.probe)}`,
    `  bank     ${status.bank} (${status.bankSource})${status.bankBase ? ` renamed from ${status.bankBase}` : ''}${status.project.source === 'git' ? '' : '  (named from the directory; not shared with a git worktree bank)'}`,
    status.bundles.length > 0
      ? `  bundles  ${status.bundles.map((bundle) => `${bundle.name} ${bundle.version}${bundle.enabled ? '' : ' (disabled)'}`).join(' · ')}`
      : `  bundles  no external memory bundles in this profile${status.bundleProfile ? '' : ` (looked in ${status.bundleRoots.length > 0 ? status.bundleRoots.join(', ') : 'no profile path'})`}`,
    ...(status.compat ? [`  compat   ${formatCompat(status.compat)}`] : []),
    ...(status.runtime
      ? [`  runtime  cordis ${status.runtime.version ?? 'unknown'}${status.runtime.isolateRealm === true ? ' (isolate realm)' : status.runtime.isolateRealm === false ? ' (pre-4.1 realm)' : ''}${status.runtime.rootInclude === false ? ' · root Include missing' : ''}`]
      : []),
    ...(status.legacyTools.length > 0
      ? [`  tools    deprecated page tool name(s) still in this profile's patches: ${status.legacyTools.map((entry) => entry.tool).join(', ')} — use hindsight_search_pages / hindsight_list_pages / hindsight_read_page`]
      : []),
    `  config   ${status.file.path} (${describeKind(status.file.kind)}${status.file.error ? `: ${status.file.error}` : ''})`,
    `  auto     ${status.autoTune ? 'tune on the first session of a new process' : 'off (persisted; /hindsight enable turns it back on)'}`,
    ...(status.tuneError ? [`  tune     auto-tune error: ${status.tuneError}`] : []),
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
      ? `  recall   ${recall.turns} turns · last ~${recall.last}${recall.lastInjected !== recall.last ? ` → ~${recall.lastInjected}` : ''} tok · wanted max ~${recall.max} tok · avg ~${Math.round(recall.tokens / recall.turns)} tok · capped ${recall.capped} · skipped ${recall.skipped}${recall.snapshot ? ` · snapshot #${recall.snapshot}` : ''}`
      : '  recall   no Hindsight recall observed in this session yet',
    `  budget   ${status.budget.cap ? `cap ${status.budget.cap} tok/turn` : 'cap off'} · capped ${status.budget.capped} · dropped ${status.budget.dropped} · ${formatTier(status.budget)} · ${formatRepeat(status.budget)}${formatScenarios(status.budget)}${formatSavings(status.budget)}`,
    `  trust    ${status.budget.verifyReminder ? 'the recall opens with a verify-before-acting reminder (counted in the cap)' : 'injected as-is (verifyReminder off)'}`,
    `  tokens   ${formatTokens(status.tokens)}`,
  ]

  if (status.budget.turns > 0) {
    lines.push(
      status.budget.capped > 0
        ? '  order    outermost hook: a recall in this process passed through the budget'
        : '  order    outermost hook: saw the recall and it was within the ceiling',
    )
  } else if (activeLane === 'external' && status.budget.preSteps > 0 && status.budget.injectSinceBoot) {
    lines.push('  order    WARNING: pre-step ran and DSH logged an injection, but none reached this hook (another listener wrapped it)')
  } else {
    lines.push('  order    outermost hook installed (prepend); confirmed on the first recall')
  }
  if (status.budget.prestepErrors > 0) {
    lines.push(`  errors   WARNING: ${status.budget.prestepErrors} pre-step(s) failed inside the plugin and passed through ungoverned (journal: prestep_error)`)
  }

  const pageLimit = status.effective.pageSearchLimit
  const observedPages = status.activity?.pages?.events > 0 ? status.activity.pages : status.history?.builtin?.pages
  const pageParts = [`pageSearchLimit=${pageLimit ?? 'unset'}`]
  if (status.effective.recallMaxTokens != null) pageParts.push(`recall max_tokens=${status.effective.recallMaxTokens}`)
  if (observedPages?.events > 0) {
    pageParts.push(`journal ${observedPages.events} injections, max ${observedPages.max} pages`)
    if (pageLimit != null && observedPages.max >= pageLimit) pageParts.push('the limit binds')
  }
  lines.push(`  pages    ${pageParts.join(' · ')}  (two separate ceilings)`)

  const sources = Object.entries(status.sources ?? {})
  lines.push(sources.length > 0
    ? `  sources  ${sources.map(([kind, count]) => `${kind} ${count} turns`).join(' · ')}`
    : '  sources  no plugin-injected messages in this session yet')
  if (status.stackTurns > 0) {
    const stackList = (status.lastStack ?? Object.keys(status.sources ?? {})).join(', ') || 'unknown'
    lines.push(`  stack    more than one plugin injects per turn (${status.stackTurns} turns: ${stackList}); their budgets add up — keep one memory lane`)
  }
  if (status.budget.last) {
    lines.push(`  last     cut ~${status.budget.last.before} → ~${status.budget.last.after} tokens`)
  }
  const sessionSaved = (status.budget.trimmedTokens ?? 0) + (status.budget.savedTokens ?? 0) + (status.budget.deltaSaved ?? 0)
  if (
    status.history
    && (
      status.history.capped > status.budget.capped
      || status.history.skipped > status.budget.repeatSkips
      || status.history.totalSaved > sessionSaved
    )
  ) {
    lines.push(`  history  24h across processes: ${status.history.capped} capped · ${status.history.skipped} skipped · saved ~${status.history.totalSaved} tok`)
  }
  lines.push(`  journal  ${activeLane === 'builtin' && !status.activity.exists && status.history?.path ? status.history.path : (status.activity.path ?? diagPath())}`)
  lines.push(`  activity ${formatActivity(status.activity, status.history, status.budget.charRatio)}`)
  const memoryLine = formatMemory(status.memory)
  if (memoryLine) lines.push(`  memory   ${memoryLine}`)
  if (status.probe && !status.probe.ok && status.activity.lastInject) {
    lines.push('  note     inject_ok counts what Hindsight sent; while recall fails that is its static tool guide, not project memory')
  }
  lines.push(`  next     ${status.hint}`)
  return lines.join('\n')
}

export function formatSuggestion(status) {
  const extChars = status.activity.injectSizes ?? []
  const chars = extChars.length > 0 ? extChars : (status.history?.builtin?.injectSizes ?? [])
  const measuredRatio = status.budget.charRatio
  const usableRatio = Number.isFinite(measuredRatio) && measuredRatio >= 0.22 && measuredRatio <= 1.10
  const charRatio = usableRatio ? measuredRatio : 0.3
  const seen = chars.map((size) => Math.ceil(size * charRatio))
  const p50 = percentile(seen, 50)
  const p95 = percentile(seen, 95)
  const observed = p95 ?? status.budget.maxTurnTokens ?? 0
  const cap = Math.max(512, Math.min(8000, Math.ceil((observed || 2000) * 1.25)))
  const recall = status.budget.viewPolicy === 'budgeted' ? Math.min(cap, 4000) : Math.min(cap, 2500)
  const lines = ['Hindsight budget suggestion (read-only)']
  if (p95) {
    lines.push(`  observed recall ~${p50} tok p50 · ~${p95} tok p95 (${seen.length} injections, char-based estimate)`)
  } else if (status.budget.maxTurnTokens > 0) {
    lines.push(`  observed recall: this session wanted up to ~${status.budget.maxTurnTokens} tok in one turn`)
  } else {
    lines.push('  no recall measured yet: the suggestion starts from the 2000-token default')
  }
  lines.push(`  cap      maxInjectTokens: ${cap}  (1.25× the p95, clamped 512..8000; current ${status.budget.cap})`)
  if (usableRatio) {
    lines.push(`  density  scaled with ~${measuredRatio} tok/char measured in this process (English prose is ~0.3, code-dense text is higher); the cap above already accounts for it`)
  }
  lines.push(`  recall   recallOptions.max_tokens: ${recall}  (Pages and Recall are separate ceilings; do not make recall larger than the cap by accident)`)
  const observedPages = status.activity?.pages?.events > 0 ? status.activity.pages : status.history?.builtin?.pages
  if (observedPages?.events > 0) {
    const limit = status.effective.pageSearchLimit
    const wanted = Math.max(3, Math.min(20, observedPages.max + 2))
    const state = limit == null ? 'unset' : observedPages.max >= limit ? 'the limit binds' : 'not binding'
    lines.push(`  pages    pageSearchLimit: ${wanted}  (journal max ${observedPages.max} pages per injection; currently ${limit ?? 'unset'}, ${state})`)
  }
  if (p50 && p95) {
    const light = Math.min(p95, Math.max(128, Math.ceil(p50 * 0.9)))
    const normal = Math.min(p95, Math.max(light, Math.ceil((p50 + p95) / 2)))
    lines.push(`  tiers    light ${light} / normal ${normal} / deep ${cap}  (budgetPolicy: adaptive; from the same p50/p95, never above the cap)`)
  }
  if (status.budget.policy !== 'scenario') {
    lines.push('  scenario budgetPolicy: scenario maps turn state (compaction, first turn, continuation, repeat, cut) and the prompt signal (debug/edit/review/question) to light/normal/deep; opt-in, tune one case with scenarioTiers')
  }
  if (status.effective.autoInject !== 'pages') {
    lines.push('  pages    autoInject: pages injects stored pages without a synthesis pass; prefer it for coding sessions')
  }
  lines.push('  apply    set these in the bundle config (cordis.patch.yml), or use /hindsight tune --cap N for this session only')
  lines.push('  why      a cap near the p95 keeps most turns intact while a rare huge recall is trimmed instead of dominating the window')
  return lines.join('\n')
}

export function formatBankStats(bankId, statsRes, pagesRes) {
  const lines = [`Hindsight bank inventory — ${bankId}`]
  if (statsRes?.ok && statsRes.stats) {
    const s = statsRes.stats
    const nodes = s.total_nodes ?? s.nodes ?? s.memory_count ?? null
    const obs = s.total_observations ?? s.observations ?? null
    const links = s.total_links ?? s.links ?? null
    const parts = []
    if (nodes != null) parts.push(`nodes ${nodes}`)
    if (obs != null) parts.push(`observations ${obs}`)
    if (links != null) parts.push(`links ${links}`)
    if (parts.length > 0) lines.push(`  memories ${parts.join(' · ')}`)
    if (s.nodes_by_fact_type && typeof s.nodes_by_fact_type === 'object') {
      const types = Object.entries(s.nodes_by_fact_type).map(([k, v]) => `${k} ${v}`).join(' · ')
      if (types) lines.push(`  types    ${types}`)
    }
    const pending = s.pending_operations ?? s.pending_consolidation ?? null
    if (pending != null) lines.push(`  queue    pending operations ${pending}`)
  } else if (statsRes && !statsRes.ok) {
    lines.push(`  memories stats unavailable (${statsRes.status || 'unreachable'}${statsRes.error ? `: ${statsRes.error}` : ''})`)
  }
  if (pagesRes?.ok) {
    const total = pagesRes.pages.length
    const stale = pagesRes.pages.filter((page) => page.isStale).length
    lines.push(`  pages    ${total} page(s)${stale > 0 ? ` (${stale} stale)` : ''}`)
  } else if (pagesRes?.status === 404) {
    lines.push('  pages    bank not seeded yet (404)')
  } else if (pagesRes) {
    lines.push(`  pages    unavailable (${pagesRes.status || 'unreachable'}${pagesRes.error ? `: ${pagesRes.error}` : ''})`)
  }
  return lines.join('\n')
}
