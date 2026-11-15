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

import { randomUUID } from 'node:crypto'
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
import { flushJournal, record } from './lib/log.js'
import {
  allocateBudget,
  countTokens,
  estimateTokens,
  FALLBACK_MARGIN,
  loadTokenizer,
  percentile,
  repetitionRatio,
  subtractRepeated,
  trimToBudget,
} from './lib/tokens.js'
import { validateConfig, validateSettings } from './lib/validate.js'
import {
  budgetedView,
  DEFAULT_VIEW_CONTEXT_MESSAGES,
  taskContextText,
  VIEW_POLICIES,
} from './lib/view.js'
import {
  chooseScenario,
  DEFAULT_SCENARIO_TIERS,
  SCENARIO_NAMES,
  SCENARIO_TIER_NAMES,
} from './lib/scenario.js'

const PLUGIN = 'hindsight-tuner'
const MAX_REMEMBERED_SESSIONS = 40
// Remembered message ids per session; enough to tell "this recall existed in an
// earlier turn" from "this recall is new", without holding arbitrary history.
const MAX_SEEN_IDS = 400
const REENTRY_PREFIX = '[dsh-hindsight-tuner: memory re-injected after context compaction]\n\n'
const REENTRY_MARKER = '\n\n…[dsh-hindsight-tuner: re-injected after the context was compacted; the earlier copy is no longer in context.]'
const DELTA_MARKER = '…[dsh-hindsight-tuner: new-facts delta — repeated blocks omitted; the earlier recall is still in the conversation.]'
const ACTIONS = ['status', 'tune', 'revert', 'probe', 'suggest', 'enable', 'disable']
const READ_ACTIONS = ['status', 'probe', 'suggest']

export const name = PLUGIN

function normalizeScenarioTiers(raw) {
  const tiers = { ...DEFAULT_SCENARIO_TIERS }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const scenario of SCENARIO_NAMES) {
      const value = typeof raw[scenario] === 'string' ? raw[scenario].toLowerCase() : null
      if (SCENARIO_TIER_NAMES.includes(value)) tiers[scenario] = value
    }
  }
  return tiers
}

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
    // off: one hard ceiling per turn (the 0.3–0.7 behaviour). adaptive: the
    // ceiling for a turn is chosen from a small tier table (light/normal/deep)
    // and can only lower the configured maxInjectTokens, never raise it.
    // scenario: the same tier table, chosen from the turn's state and lexical
    // task signal (debug/edit/review/question/continuation). Opt-in experiment.
    budgetPolicy: raw.budgetPolicy === 'adaptive' || raw.budgetPolicy === 'scenario'
      ? raw.budgetPolicy
      : 'off',
    budgetTiers: {
      light: number(raw.budgetTiers?.light, 800),
      normal: number(raw.budgetTiers?.normal, 1600),
      deep: number(raw.budgetTiers?.deep, 3000),
    },
    // Per-scenario tier overrides. Defaults are a starting table, not a measured
    // optimum; an invalid key or tier is reported and falls back per entry.
    scenarioTiers: normalizeScenarioTiers(raw.scenarioTiers),
    // inject: every turn gets the recall again (the integration's behaviour).
    // skip: a recall that mostly repeats what the model already received last
    // turn is dropped instead of re-sent; the earlier message is still in the
    // conversation, so the content is not lost, only the duplicate.
    repeatPolicy: text(raw.repeatPolicy, 'inject').toLowerCase() === 'skip' ? 'skip' : 'inject',
    repeatThreshold: Math.min(1, Math.max(0.5, number(raw.repeatThreshold, 0.9))),
    // A recall is evidence, not authority: the pages were written by an earlier
    // session and may describe code that has since changed. With this on, the
    // injected text opens with a short reminder to verify before acting.
    verifyReminder: raw.verifyReminder === true,

    // truncate: keep the leading blocks of a recall within the budget (the 0.x
    // behaviour). budgeted: score fact-sized blocks against the current turn and
    // spend the budget on the blocks whose evidence matches the task.
    viewPolicy: VIEW_POLICIES.includes(text(raw.viewPolicy, 'truncate').toLowerCase())
      ? text(raw.viewPolicy, 'truncate').toLowerCase()
      : 'truncate',
    viewContextMessages: Math.min(40, Math.max(1, Math.round(number(raw.viewContextMessages, DEFAULT_VIEW_CONTEXT_MESSAGES)))),

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
 * The user's prompt for this step, taken from the claimed batch only.
 *
 * The pre-step payload carries the exclusive batch claimed for the step, not the
 * whole conversation, so this is a small, current sample of what the model is
 * being asked to do. It is used for scenario classification only; a step whose
 * batch has no user message (a tool continuation) reads as an empty prompt and
 * falls through to the continuation scenario instead of guessing from the tool
 * output.
 */
function claimPrompt(messages, sourceKind, limit = 4000) {
  const parts = []
  for (let index = messages.length - 1; index >= 0 && parts.length < 2; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    if (message?.source?.kind === sourceKind) continue
    const text = textOf(message)
    if (text) parts.unshift(text)
  }
  return parts.join('\n').slice(0, limit)
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

/**
 * Trust governance: pages are written by an earlier session, so by the time
 * they are recalled the code they describe may already have changed. The
 * reminder is deliberately one short line and is measured like any other token,
 * so turning it on cannot silently break the ceiling.
 */
const VERIFY_REMINDER = '[verify: memory may be stale — check the current code and tests before acting]\n\n'

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
 * Pick this turn's ceiling from the tier table.
 *
 * The policy is intentionally explainable rather than clever: every branch has
 * a one-line reason that `status` prints, so a user can decide whether the rule
 * matches their workflow. Signals available without host-internal access are
 * the session's turn index, whether the last recall had to be cut, and how much
 * of the current recall repeats the previous one. Tiers can only lower the
 * configured ceiling — they never bypass `maxInjectTokens`.
 */
function chooseTier(tiers, session, text, total) {
  const size = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const light = size(tiers?.light)
  const normal = size(tiers?.normal)
  const deep = size(tiers?.deep)
  // Compare against what the model actually received last turn, not the raw
  // recall: a turn that was cut only delivered a prefix, so the remainder is
  // new information and must not be mistaken for a repeat. An unchanged raw
  // recall is nonetheless a repeat for budget purposes — asking for the same
  // (partly cut) recall again buys nothing, so it keeps the light ceiling.
  const previous = session.lastInjectedText || session.lastRaw
  // The stored raw recall is capped at 20k chars; compare on the same window.
  const sameRecall = Boolean(session.lastRaw) && text?.slice(0, 20_000) === session.lastRaw
  const overlap = session.turns > 0 && previous
    ? (sameRecall ? 1 : repetitionRatio(previous, text))
    : 0
  if (session.turns > 0 && overlap >= 0.6) {
    return { name: 'light', ceiling: light, reason: `${Math.round(overlap * 100)}% of this recall repeats what is in context` }
  }
  if (session.turns > 0 && session.lastCapped) {
    return { name: 'light', ceiling: light, reason: 'the previous recall had to be cut' }
  }
  if (session.turns === 0) {
    return { name: 'deep', ceiling: deep, reason: 'first recall of the session, nothing is in context yet' }
  }
  if (total <= light) return { name: 'light', ceiling: light, reason: 'fits the light ceiling' }
  if (total <= normal) return { name: 'normal', ceiling: normal, reason: 'fits the normal ceiling' }
  return { name: 'deep', ceiling: deep, reason: 'larger than the normal ceiling' }
}

/** Session events for the current agent, when the host exposes them. */
function sessionEvents(session) {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
    return Array.isArray(events) ? events : []
  } catch {
    return []
  }
}

/**
 * Where the last Hindsight injection sits in the session log, and whether a
 * later compaction removed it from the model surface.
 *
 * The integration's own "unchanged recall" check scans the raw event log, which
 * still contains shadowed events: after a compaction it believes the memory is
 * in context when it is not. The plugin reads the log itself and checks the
 * shadow metadata — compaction summaries list `shadowedSeqs`, and surface
 * replacements carry a `surfaceOp` range on the event envelope. Either is
 * authoritative for "the earlier copy is no longer in context".
 */
function lastInjectionState(session, sourceKind) {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== sourceKind) continue
    const seq = Number.isFinite(event.seq) ? event.seq : null
    let shadowed = null
    if (seq !== null) {
      for (let next = index + 1; next < events.length; next += 1) {
        const later = events[next]
        const shadowedSeqs = later?.data?.shadowedSeqs
        if (Array.isArray(shadowedSeqs) && shadowedSeqs.includes(seq)) {
          shadowed = 'compact'
          break
        }
        const op = later?.surfaceOp
        if (
          op && op.op === 'replace'
          && Number.isFinite(op.startSeq) && Number.isFinite(op.endSeq)
          && seq >= op.startSeq && seq <= op.endSeq
        ) {
          shadowed = 'replace'
          break
        }
      }
    }
    return { seq, shadowed }
  }
  return null
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
      session = {
        turns: 0,
        tokens: 0,
        last: 0,
        max: 0,
        lastRaw: '',
        // What the model actually received last turn (the trimmed text, not the
        // raw recall). Repetition and "is it still in context" are decided
        // against this, never against content that was cut before delivery.
        lastInjectedText: '',
        lastCapped: false,
        tier: null,
        // The last scenario chosen for this session (scenario budget policy
        // only); kept for status so a user can see why a ceiling was used.
        scenario: null,
        capped: 0,
        dropped: 0,
        skipped: 0,
        trimmedTokens: 0,
        lastInjected: 0,
        injected: 0,
        reentered: 0,
        deltas: 0,
        deltaSaved: 0,
        // Message ids seen in earlier turns. An id seen before is history the
        // model already has, so it is never silently dropped as a duplicate.
        seenIds: new Set(),
      }
      remember(sessions, sessionId, session)
    }
    return session
  }

  /** Remember the ids a later turn can use to recognise history. */
  function noteIds(session, messages) {
    for (const message of messages) {
      const id = message?.id
      if (typeof id !== 'string' || id.length === 0) continue
      session.seenIds.add(id)
      while (session.seenIds.size > MAX_SEEN_IDS) {
        session.seenIds.delete(session.seenIds.values().next().value)
      }
    }
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

  /** Non-text blocks of a message, preserved when its text is rewritten. */
  function extraBlocks(message) {
    return Array.isArray(message?.content) ? message.content.filter((block) => block?.type !== 'text') : []
  }

  function rebuild(message, text) {
    return { ...message, content: [{ type: 'text', text }, ...extraBlocks(message)] }
  }

  /**
   * Rebuild the last recall the model actually saw, because compaction removed
   * it while the integration's dedupe still believed it was present.
   */
  function reentryText(session) {
    const text = `${REENTRY_PREFIX}${session.lastInjectedText}`
    const cap = settings.maxInjectTokens
    if (cap && meter.measure(text) > cap) {
      return trimToBudget(text, cap, REENTRY_MARKER, meter.count)
    }
    return text
  }

  /** Append a re-injection and account for it like any other injected text. */
  function reinject(decision, session, sessionId, logState) {
    const text = reentryText(session)
    if (!text) return decision
    const tokens = meter.measure(text)
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: settings.sourceKind, form: 'recall' },
    }
    noteIds(session, [message])
    stats.reentered += 1
    stats.turns += 1
    stats.seen += 1
    stats.lastTurnTokens = tokens
    stats.maxTurnTokens = Math.max(stats.maxTurnTokens, tokens)
    session.reentered += 1
    session.turns += 1
    session.last = tokens
    session.lastInjected = tokens
    session.max = Math.max(session.max, tokens)
    session.tokens += tokens
    session.injected = (session.injected ?? 0) + tokens
    session.lastCapped = false
    session.lastInjectedText = text.slice(0, 20_000)
    record({
      event: 'inject_reentered',
      session: sessionId,
      reason: logState?.shadowed === 'compact' ? 'context-compacted' : 'surface-replaced',
      seq: logState?.seq ?? null,
      tokens,
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  async function onPreStep(payload, next) {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const agentSession = payload?.agent?.session
    const sessionId = agentSession?.header?.id ?? 'unknown'
    noteTurn(decision.messages, sessionId)
    const session = sessionOf(sessionId)
    const logState = lastInjectionState(agentSession, settings.sourceKind)
    const shadowed = logState?.shadowed ?? null
    const hadInjection = session.lastInjected > 0 && Boolean(session.lastInjectedText)

    const candidates = []
    decision.messages.forEach((message, index) => {
      if (message?.source?.kind !== settings.sourceKind) return
      const text = textOf(message)
      if (!text) return
      candidates.push({
        index,
        message,
        text,
        tokens: meter.measure(text),
        // An id known from an earlier turn is history the model already has; it
        // may be rewritten for budget, never silently dropped as a duplicate.
        isNew: !session.seenIds.has(message.id),
      })
    })

    // No new recall arrived. If the last one was shadowed by a compaction, the
    // integration's unchanged-recall check still suppresses it (it scans the
    // raw log, which keeps shadowed events): re-inject the text the model used
    // to have instead of letting memory stay missing for the rest of the session.
    if (candidates.length === 0) {
      if (hadInjection && shadowed) return reinject(decision, session, sessionId, logState)
      return decision
    }

    noteIds(session, candidates.map((candidate) => candidate.message))
    const visible = candidates.filter((candidate) => !candidate.isNew)
    const fresh = candidates.filter((candidate) => candidate.isNew)

    // Repetition is measured against what the model actually received. When a
    // compaction shadowed that text it is no longer in context, so nothing is
    // "already there" and re-sending is required rather than wasteful.
    const previous = shadowed || !session.lastInjectedText ? '' : session.lastInjectedText
    const freshText = fresh.map((candidate) => candidate.text).join('\n')
    // An unchanged raw recall is a full repeat even when last turn delivered only
    // a trimmed prefix: re-sending it would re-trim to the same prefix and buy
    // nothing, so no block of it can be "new facts".
    const sameRecall = Boolean(session.lastRaw) && freshText.slice(0, 20_000) === session.lastRaw
    const repeatRatio = previous && freshText
      ? (sameRecall ? 1 : repetitionRatio(previous, freshText))
      : 0
    stats.lastRepeat = repeatRatio

    const edits = new Map()
    const removed = new Set()
    let suppressed = 0
    let suppressedTokens = 0
    let deltaTurns = 0
    let deltaBlocks = 0
    if (
      settings.repeatPolicy === 'skip' && session.turns > 0 && previous && freshText
      && repeatRatio >= settings.repeatThreshold
    ) {
      if (sameRecall) {
        for (const candidate of fresh) {
          candidate.removed = true
          removed.add(candidate.index)
          suppressed += 1
          suppressedTokens += candidate.tokens
        }
      } else {
        // Mostly repeated but changed: keep only the blocks that carry lines the
        // model has not seen. Dropping the whole recall would lose those facts;
        // re-sending all of it would pay twice for the repeated part.
        for (const candidate of fresh) {
          const novel = subtractRepeated(previous, candidate.text)
          if (!novel.text) {
            candidate.removed = true
            removed.add(candidate.index)
            suppressed += 1
            suppressedTokens += candidate.tokens
            continue
          }
          if (novel.omitted > 0) {
            const deltaText = `${novel.text}\n\n${DELTA_MARKER}`
            const message = rebuild(candidate.message, deltaText)
            candidate.text = deltaText
            candidate.tokens = meter.measure(deltaText)
            candidate.message = message
            edits.set(candidate.index, message)
            deltaBlocks += novel.omitted
            deltaTurns += 1
          }
        }
      }
    }

    const survivors = candidates.filter((candidate) => !candidate.removed)
    if (survivors.length === 0) {
      // The turn carried nothing but a duplicate. The earlier message stays in
      // the conversation, so only this copy is dropped.
      stats.repeatSkips += 1
      stats.savedTokens += suppressedTokens
      session.skipped += 1
      record({ event: 'inject_skipped', session: sessionId, reason: 'repeat', ratio: repeatRatio, saved: suppressedTokens })
      const wanted = candidates.reduce((sum, candidate) => sum + candidate.tokens, 0)
      session.turns += 1
      session.last = wanted
      session.lastInjected = 0
      session.max = Math.max(session.max, wanted)
      session.tokens += wanted
      session.lastCapped = false
      stats.turns += 1
      stats.lastTurnTokens = wanted
      stats.maxTurnTokens = Math.max(stats.maxTurnTokens, wanted)
      stats.seen += candidates.length
      return { ...decision, messages: decision.messages.filter((_, index) => !removed.has(index)) }
    }
    if (suppressed > 0) {
      stats.repeatSkips += 1
      stats.savedTokens += suppressedTokens
      session.skipped += 1
      record({ event: 'inject_skipped', session: sessionId, reason: 'repeat', ratio: repeatRatio, saved: suppressedTokens })
    }
    if (deltaTurns > 0) {
      stats.deltas += 1
      stats.deltaSaved += suppressedTokens
      session.deltas += 1
      session.deltaSaved += suppressedTokens
      record({ event: 'inject_delta', session: sessionId, ratio: repeatRatio, blocks: deltaBlocks, saved: suppressedTokens })
    }

    // A recall is evidence, not authority: it was written by an earlier session
    // and may describe code that has since changed. The reminder is part of the
    // injected text and therefore part of the measured budget, never a freebie.
    const remind = Boolean(settings.verifyReminder)
    if (remind) {
      const first = survivors[0]
      first.text = `${VERIFY_REMINDER}${first.text}`
      first.tokens = meter.measure(first.text)
      first.message = rebuild(first.message, first.text)
      edits.set(first.index, first.message)
    }

    const total = survivors.reduce((sum, candidate) => sum + candidate.tokens, 0)
    const combined = survivors.map((candidate) => candidate.text).join('\n')
    const cap = settings.maxInjectTokens

    let budget = cap
    let tier = null
    let after = total
    let dropped = 0
    const finalTexts = new Map()

    if (cap && (settings.budgetPolicy === 'adaptive' || settings.budgetPolicy === 'scenario')) {
      if (settings.budgetPolicy === 'adaptive') {
        tier = chooseTier(settings.budgetTiers, session, combined, total)
      } else {
        const scenario = chooseScenario({
          firstTurn: session.turns === 0,
          step: payload?.step,
          shadowed,
          repetition: repeatRatio,
          lastCapped: session.lastCapped,
          promptText: claimPrompt(decision.messages, settings.sourceKind),
          overrides: settings.scenarioTiers,
        })
        tier = {
          name: scenario.tier,
          ceiling: settings.budgetTiers[scenario.tier],
          reason: scenario.reason,
          scenario: scenario.scenario,
        }
        session.scenario = scenario.scenario
        stats.scenarios[scenario.scenario] = (stats.scenarios[scenario.scenario] ?? 0) + 1
        stats.lastScenario = { ...scenario, at: new Date().toISOString() }
      }
      budget = Math.min(cap, tier.ceiling)
      session.tier = tier.name
      stats.tiers[tier.name] = (stats.tiers[tier.name] ?? 0) + 1
      stats.lastTier = { ...tier, budget, requested: total }
      if (settings.budgetPolicy === 'scenario' && stats.lastScenario) stats.lastScenario.budget = budget
      record({
        event: 'tier_selected',
        session: sessionId,
        policy: settings.budgetPolicy,
        tier: tier.name,
        scenario: tier.scenario ?? null,
        ceiling: tier.ceiling,
        budget,
        requested: total,
        reason: tier.reason,
      })
    }

    if (budget && total > budget) {
      const allocations = allocateBudget(survivors.map((candidate) => candidate.tokens), budget)
      // Only the budgeted view needs to know what the turn is about; the default
      // truncating mode never reads the other messages.
      const viewContext = settings.viewPolicy === 'budgeted'
        ? taskContextText(decision.messages, settings.sourceKind, settings.viewContextMessages)
        : ''
      after = 0
      survivors.forEach((candidate, position) => {
        const allotted = allocations[position]
        if (candidate.tokens <= allotted) {
          after += candidate.tokens
          finalTexts.set(candidate.index, candidate.text)
          return
        }
        let trimmed = ''
        if (allotted > 0 && settings.viewPolicy === 'budgeted') {
          // Budgeted view: spend the allotment on the fact blocks that match the
          // task, keeping evidence pointers, instead of the leading blocks.
          const view = budgetedView({
            text: candidate.text,
            contextText: viewContext,
            budget: allotted,
            count: (value) => meter.count(value),
          })
          if (view) {
            trimmed = view.text
            stats.viewTurns += 1
            stats.viewKept += view.kept
            stats.viewOmitted += view.omitted
            record({
              event: 'inject_view',
              session: sessionId,
              blocks: view.blocks,
              kept: view.kept,
              omitted: view.omitted,
              tokens: view.tokens,
              sources: view.sources,
            })
          }
        }
        if (!trimmed && allotted > 0) {
          const marker = `\n\n…[dsh-hindsight-tuner: cut from ~${candidate.tokens} to ~${allotted} tokens. Ask Hindsight for the full recall explicitly, or raise maxInjectTokens.]`
          trimmed = trimToBudget(candidate.text, allotted, marker, meter.count)
        }
        if (!trimmed) {
          removed.add(candidate.index)
          dropped += 1
          return
        }
        const message = rebuild(candidate.message, trimmed)
        edits.set(candidate.index, message)
        finalTexts.set(candidate.index, trimmed)
        after += meter.count(trimmed)
      })
      stats.capped += 1
      stats.dropped += dropped
      stats.trimmedTokens += Math.max(0, total - after)
      session.capped += 1
      session.dropped += dropped
      session.trimmedTokens += Math.max(0, total - after)
      stats.last = { before: total, after, at: new Date().toISOString() }
      record({ event: 'inject_capped', session: sessionId, before: total, after, dropped, mode: meter.mode })
    } else {
      for (const candidate of survivors) finalTexts.set(candidate.index, candidate.text)
    }

    // Accounting records both what Hindsight wanted and what actually reached
    // the model, so a capped or skipped turn never looks like an uncapped one.
    const cappedThisTurn = Boolean(budget && total > budget)
    const deliveredText = survivors
      .filter((candidate) => !removed.has(candidate.index))
      .map((candidate) => finalTexts.get(candidate.index) ?? candidate.text)
      .join('\n')

    session.turns += 1
    session.last = total
    session.lastInjected = after
    session.max = Math.max(session.max, total)
    session.tokens += total
    session.injected = (session.injected ?? 0) + after
    session.lastCapped = cappedThisTurn
    // Remember the fresh recall request (history copies are not "the recall"
    // that arrives next turn), so an unchanged request is detected exactly.
    session.lastRaw = (fresh.length > 0 ? fresh : candidates)
      .map((candidate) => candidate.text)
      .join('\n')
      .slice(0, 20_000)
    if (after > 0 && deliveredText) session.lastInjectedText = deliveredText.slice(0, 20_000)
    stats.turns += 1
    stats.lastTurnTokens = total
    stats.maxTurnTokens = Math.max(stats.maxTurnTokens, total)
    stats.seen += candidates.length

    if (cappedThisTurn || remind || suppressed > 0 || deltaTurns > 0) {
      const rewritten = decision.messages.slice()
      for (const [index, message] of edits) rewritten[index] = message
      return { ...decision, messages: rewritten.filter((_, index) => !removed.has(index)) }
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
  if (activity.foreignFailures > 0) parts.push(`${activity.foreignFailures} failures to another server (old process)`)
  const banks = Object.entries(activity.banks ?? {}).sort((left, right) => right[1] - left[1])
  if (banks.length > 1) parts.push(`banks ${banks.slice(0, 2).map(([bank, count]) => `${bank} ${count}`).join(', ')}`)
  if (activity.lastInject) parts.push(`last inject ~${activity.lastInject.tokens} tok`)
  return parts.length > 0 ? `24h: ${parts.join(' · ')}` : '24h: nothing recorded'
}

/**
 * Operational proxies for memory quality. The plugin can see whether a recall
 * changed since the previous turn and whether the server produced pages, but it
 * cannot see whether the recalled text helped the task — that needs an external
 * evaluation harness (see README: Measuring memory).
 */
function memoryMetrics(activity) {
  const recent = activity?.recent ?? {}
  const injected = recent.inject_ok ?? 0
  const unchanged = recent.inject_unchanged ?? 0
  const attempts = injected + unchanged
  return {
    windowHours: 24,
    injected,
    unchanged,
    refreshPct: attempts > 0 ? Math.round((injected / attempts) * 1000) / 10 : null,
    pagesOk: recent.pages_ok ?? 0,
    serverErrors: (recent.pages_failed ?? 0) + (recent.retain_failed ?? 0) + (recent.reflect_failed ?? 0),
  }
}

function formatMemory(memory) {
  if (!memory || memory.refreshPct === null) return null
  return `24h: ${memory.refreshPct}% of recalls were fresh (${memory.injected} injected / ${memory.unchanged} unchanged) · ${memory.serverErrors} server errors`
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown age'
  if (ms < 60_000) return 'under a minute ago'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
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
  const expectedOrigin = originOf(server.apiUrl)
  const activity = summarizeActivity({ expectedOrigin, harness: 'dsh' })
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
      policy: settings.budgetPolicy,
      tiers: settings.budgetTiers,
      tier: stats.lastTier,
      tierCounts: { ...stats.tiers },
      // Scenario policy: the table, the overrides in effect, and what has been
      // observed this process. Kept separate from the adaptive counters so a
      // status reader can tell which policy produced a ceiling.
      scenarioTiers: settings.scenarioTiers,
      scenarios: { ...stats.scenarios },
      lastScenario: stats.lastScenario,
      repeatPolicy: settings.repeatPolicy,
      repeatThreshold: settings.repeatThreshold,
      verifyReminder: settings.verifyReminder,
      repeatSkips: stats.repeatSkips,
      savedTokens: stats.savedTokens,
      // A re-entry is a recall re-sent because compaction shadowed the copy the
      // model had; it is counted separately from ordinary injections.
      reentered: stats.reentered,
      deltas: stats.deltas,
      deltaSaved: stats.deltaSaved,
      // Budgeted view: how many times block selection ran, and how many blocks
      // it kept or left out (a plain count, not a claim that omission was safe).
      viewPolicy: settings.viewPolicy,
      viewContextMessages: settings.viewContextMessages,
      viewTurns: stats.viewTurns,
      viewKept: stats.viewKept,
      viewOmitted: stats.viewOmitted,
      trimmedTokens: stats.trimmedTokens,
      lastRepeat: stats.lastRepeat,
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
    memory: memoryMetrics(activity),
  }
  status.stale = staleProcess(status)
  status.hint = hintFor(status)
  return status
}

/**
 * The integration is loaded once per process. If its journal's newest failure
 * still targets a different origin than the effective config, the running
 * process predates the config change — memory will keep failing until DSH is
 * restarted, which no amount of correct file content fixes. The window is short
 * on purpose: after a restart the process either succeeds or fails against the
 * configured server, so an old cloud failure must not keep crying wolf.
 */
const STALE_FAILURE_MS = 15 * 60_000

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
  if (!Number.isFinite(failedAt)) return null
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
      ? [`  process  newest journal failure still targets ${status.stale.seen} (${status.stale.event ?? 'failure'}${status.stale.bank ? `, bank ${status.stale.bank}` : ''}, ${formatAge(status.stale.ageMs)}) — the running DSH loaded the old config; restart it`]
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
      ? `  recall   ${recall.turns} turns · last ~${recall.last}${recall.lastInjected !== recall.last ? ` → ~${recall.lastInjected}` : ''} tok · wanted max ~${recall.max} tok · avg ~${Math.round(recall.tokens / recall.turns)} tok · capped ${recall.capped} · skipped ${recall.skipped}`
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
  } else {
    lines.push('  order    outermost hook installed (prepend); confirmed on the first recall')
  }

  const pageLimit = status.effective.pageSearchLimit
  const observedPages = status.activity?.pages
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
    lines.push(`  stack    more than one plugin injects per turn (${status.stackTurns} turns: ${(status.sources && Object.keys(status.sources).join(', ')) || 'unknown'}); their budgets add up — keep one memory lane`)
  }
  if (status.budget.last) {
    lines.push(`  last     cut ~${status.budget.last.before} → ~${status.budget.last.after} tokens`)
  }
  lines.push(`  journal  ${status.activity.path ?? diagPath()}`)
  lines.push(`  activity ${formatActivity(status.activity)}`)
  const memoryLine = formatMemory(status.memory)
  if (memoryLine) lines.push(`  memory   ${memoryLine}`)
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

/** The tier table and, once a recall has happened, the choice made for it. */
function formatTier(budget) {
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

/** Overridden scenario entries only: the default table is the same every run. */
function scenarioOverrides(budget) {
  const tiers = budget.scenarioTiers ?? {}
  const changed = SCENARIO_NAMES.filter((scenario) => tiers[scenario] && tiers[scenario] !== DEFAULT_SCENARIO_TIERS[scenario])
  return changed.length > 0
    ? ` · overrides ${changed.map((scenario) => `${scenario}=${tiers[scenario]}`).join(', ')}`
    : ''
}

/** Scenario counts for this process, when the scenario policy has run. */
function formatScenarios(budget) {
  if (budget.policy !== 'scenario') return ''
  const counts = Object.entries(budget.scenarios ?? {}).sort((left, right) => right[1] - left[1])
  return counts.length > 0
    ? ` · scenarios ${counts.map(([scenario, count]) => `${scenario} ${count}`).join(', ')}`
    : ''
}

/** Duplicate governance: what was suppressed, and how much it saved. */
function formatRepeat(budget) {
  if (budget.repeatPolicy !== 'skip') return 'repeat inject'
  const threshold = Math.round((budget.repeatThreshold ?? 0.9) * 100)
  const last = Number.isFinite(budget.lastRepeat) && budget.lastRepeat > 0
    ? ` · last ${Math.round(budget.lastRepeat * 100)}% repeat`
    : ''
  // Re-entries and deltas are names for what the tuner did about repeats rather
  // than how many it caught: a shadowed recall had to be re-sent, and a
  // mostly-repeated one was narrowed to its new facts instead of being dropped.
  const reentered = budget.reentered > 0 ? ` · re-entered ${budget.reentered}` : ''
  const deltas = budget.deltas > 0 ? ` · deltas ${budget.deltas}` : ''
  return `repeat skip ≥${threshold}% · skipped ${budget.repeatSkips}${last}${reentered}${deltas}`
}

/** Tokens that never reached the model, from trimming plus skipped recalls. */
function formatSavings(budget) {
  const saved = (budget.trimmedTokens ?? 0) + (budget.savedTokens ?? 0)
  return saved > 0 ? ` · saved ~${saved} tok` : ''
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
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  // Most settings are normalized before validation (a bad number falls back);
  // the policy-like values are validated on the raw value so a typo is reported
  // instead of being silently replaced by the default.
  const checked = validateSettings({
    ...settings,
    budgetPolicy: raw.budgetPolicy ?? settings.budgetPolicy,
    scenarioTiers: raw.scenarioTiers ?? settings.scenarioTiers,
    viewPolicy: raw.viewPolicy ?? settings.viewPolicy,
    viewContextMessages: raw.viewContextMessages ?? settings.viewContextMessages,
  })
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
    lastRepeat: 0,
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
    flushJournal()
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
    const observedPages = status.activity?.pages
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
    // Scenario policy is an opt-in experiment: suggest it, do not imply that the
    // default table is measured or that every session benefits from it.
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
    const status = await buildStatus(settings, stats, governor, cwd, options.sessionId)
    if (options.json === true) return JSON.stringify(status, null, 2)
    return formatStatus(status)
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
        if (args?.json === true && action !== 'status') {
          return 'hindsight_tuner: json is only valid with status.'
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
  })

  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: 'hindsight',
        description: 'Hindsight memory: status [--json] | tune [--dry-run] [--overwrite] [--cap N] | revert [--dry-run] | probe | suggest | enable | disable',
        async handler(invocation) {
          const parts = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
          const action = parts.shift() || 'status'
          if (!ACTIONS.includes(action)) {
            return { kind: 'error', text: `Unknown action "${action}". Use ${ACTIONS.join(', ')}.` }
          }
          const flags = parseCommandFlags(parts)
          if (flags.unknown) {
            return { kind: 'error', text: `Unknown option "${flags.unknown}". Use --dry-run, --overwrite, --cap N, or --json.` }
          }
          if ((flags.overwrite || flags.cap !== undefined) && action !== 'tune') {
            return { kind: 'error', text: 'Options --overwrite and --cap are only valid for tune.' }
          }
          if (flags.dryRun && !['tune', 'revert'].includes(action)) {
            return { kind: 'error', text: 'Option --dry-run is only valid for tune or revert.' }
          }
          if (flags.json && action !== 'status') {
            return { kind: 'error', text: 'Option --json is only valid for status.' }
          }
          try {
            const text = await runAction(action, {
              cwd: invocation?.agent?.session?.header?.cwd,
              sessionId: invocation?.agent?.session?.header?.id,
              dryRun: flags.dryRun === true,
              overwrite: flags.overwrite === true,
              cap: flags.cap,
              json: flags.json === true,
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
    else if (part === '--json') flags.json = true
    else if (part === '--cap') flags.cap = Number(parts[++index])
    else if (part.startsWith('--cap=')) flags.cap = Number(part.slice('--cap='.length))
    else flags.unknown = part
  }
  return flags
}
