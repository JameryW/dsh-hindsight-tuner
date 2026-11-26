/**
 * Per-turn memory governor (`agent/pre-step`).
 *
 * Enforces the shared token ceiling (`maxInjectTokens`), adaptive/scenario tiers,
 * repeat/delta governance, compaction re-entry, verification envelope framing,
 * monotonic snapshot headers, and optional built-in recall injection when no
 * external memory plugin injected into the turn.
 */

import { randomUUID } from 'node:crypto'
import {
  DELTA_MARKER,
  MEMORY_ENVELOPE_CLOSE,
  REENTRY_MARKER,
  REENTRY_MARKER_MIN,
  REENTRY_PREFIX,
  VERIFY_REMINDER,
  escapeEnvelopeBoundaries,
  escapeSnapshotHeaders,
  leadingPrefix,
  stripRuntimePrefixes,
  withSnapshotHeader,
} from './envelope.js'
import { record } from './log.js'
import { chooseScenario } from './scenario.js'
import {
  allocateBudget,
  buildRecoverableMarker,
  queryRelevance,
  repetitionRatio,
  selectSectionsByQuery,
  substantiveLines,
  subtractRepeated,
  trimToBudget,
} from './tokens.js'
import { budgetedView, taskContextText } from './view.js'

const MAX_REMEMBERED_SESSIONS = 40
// Remembered message ids per session; enough to tell "this recall existed in an
// earlier turn" from "this recall is new", without holding arbitrary history.
const MAX_SEEN_IDS = 400
const RAW_MEMORY_LIMIT = 50_000
// A pause this long almost certainly means the host's prefix cache is cold and
// the user came back to a different question; memory policy state from the old
// exchange (a cut cooldown, a light tier) should not follow them into it.
const IDLE_RESET_MS = 20 * 60 * 1000

function remember(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > MAX_REMEMBERED_SESSIONS) map.delete(map.keys().next().value)
}

export function textOf(message) {
  if (typeof message?.content === 'string') return message.content
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
 * being asked to do. A step whose batch has no user message (a tool continuation)
 * reads as an empty prompt.
 */
export function claimPrompt(messages, limit = 4000) {
  const parts = []
  for (let index = messages.length - 1; index >= 0 && parts.length < 2; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    const text = textOf(message)
    if (text) parts.unshift(text)
  }
  return parts.join('\n').slice(0, limit)
}

/**
 * True when the previous turn did not hand the model the whole recall.
 *
 * `lastCapped` covers a plain tail cut; `lastOmittedBlocks` covers a budgeted
 * view that deliberately kept only the blocks matching that turn's query.
 */
export function hadOmittedContent(session) {
  return Boolean(session?.lastCapped || (session?.lastOmittedBlocks ?? 0) > 0)
}

/**
 * Pick this turn's ceiling from the tier table.
 *
 * Tiers can only lower the configured ceiling — they never bypass
 * `maxInjectTokens`. A post-cut cooldown drops one turn to `light`, then steps
 * up through `normal` so a single large turn cannot lock a session in `light`.
 */
export function chooseTier(
  tiers,
  session,
  text,
  total,
  { shadowed = null, precomputedOverlap = null, precomputedSame = null } = {},
) {
  const size = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const light = size(tiers?.light)
  const normal = size(tiers?.normal)
  const deep = size(tiers?.deep)
  let overlap = 0
  if (session.turns > 0) {
    if (typeof precomputedOverlap === 'number' && Number.isFinite(precomputedOverlap)) {
      overlap = precomputedOverlap
    } else {
      const cleanText = stripRuntimePrefixes(text)
      const previous = shadowed ? '' : stripRuntimePrefixes(session.lastInjectedText || session.lastRaw)
      if (previous) {
        const sameRecall = precomputedSame !== null
          ? precomputedSame
          : (!shadowed && !hadOmittedContent(session) && Boolean(session.lastRaw) && cleanText.slice(0, RAW_MEMORY_LIMIT) === session.lastRaw)
        overlap = sameRecall ? 1 : repetitionRatio(previous, cleanText)
      }
    }
  }

  if (session.turns === 0) {
    return { name: 'deep', ceiling: deep, reason: 'first recall of the session, nothing is in context yet' }
  }
  if (overlap >= 0.6) {
    return { name: 'light', ceiling: light, reason: `${Math.round(overlap * 100)}% of this recall repeats what is in context` }
  }
  if (!shadowed && session.lastCapped && (session.cutCooldowns ?? 0) === 0) {
    return { name: 'light', ceiling: light, cooldown: true, reason: 'the previous recall had to be cut' }
  }
  if (overlap >= 0.3) {
    return { name: 'normal', ceiling: normal, reason: `${Math.round(overlap * 100)}% of this recall overlaps the previous one` }
  }
  if (total <= light) return { name: 'light', ceiling: light, reason: 'fits the light ceiling' }
  if (!shadowed && session.lastCapped && (session.cutCooldowns ?? 0) > 0) {
    return { name: 'normal', ceiling: normal, reason: 'stepping back up after a cut' }
  }
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

function eventText(event) {
  const content = event?.data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find((entry) => entry?.type === 'text')
    return typeof block?.text === 'string' ? block.text : ''
  }
  return ''
}

function isSeqShadowed(seq, shadowedMap, replaceRanges) {
  if (seq === null) return null
  let bestIndex = Infinity
  let bestReason = null
  const compactAt = shadowedMap.get(seq)
  if (compactAt !== undefined) {
    bestIndex = compactAt
    bestReason = 'compact'
  }
  for (const range of replaceRanges) {
    if (range.index >= bestIndex) break
    if (seq >= range.startSeq && seq <= range.endSeq) {
      bestIndex = range.index
      bestReason = 'replace'
      break
    }
  }
  return bestReason
}

/**
 * Single O(N) backwards pass over session events to locate the last Hindsight
 * injection (plus its preceding full base if the latest was a delta) and check
 * whether a later compaction or surface replacement shadowed it.
 */
export function lastInjectionState(session, sourceKind) {
  const events = sessionEvents(session)
  const shadowedMap = new Map()
  const replaceRanges = []
  let latest = null

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && event?.data?.source?.kind === sourceKind) {
      const seq = Number.isFinite(event.seq) ? event.seq : null
      const shadowed = isSeqShadowed(seq, shadowedMap, replaceRanges)
      const isDelta = eventText(event).includes(DELTA_MARKER)
      if (!latest) {
        latest = { seq, shadowed, isDelta }
        if (!isDelta) return latest
      } else if (!isDelta) {
        return { ...latest, baseSeq: seq, baseShadowed: shadowed }
      }
    }
    const shadowedSeqs = event?.data?.shadowedSeqs
    if (Array.isArray(shadowedSeqs)) {
      for (const s of shadowedSeqs) shadowedMap.set(s, index)
    }
    const op = event?.surfaceOp
    if (op && op.op === 'replace' && Number.isFinite(op.startSeq) && Number.isFinite(op.endSeq)) {
      replaceRanges.unshift({ index, startSeq: op.startSeq, endSeq: op.endSeq })
    }
  }
  return latest
}

/**
 * Cap and govern one turn's Hindsight recall as the outermost `agent/pre-step`
 * listener.
 */
export function createGovernor(settings, stats, meter, { onBeforeStep, fetchRecall } = {}) {
  const sessions = new Map()

  function sessionOf(sessionId) {
    let session = sessions.get(sessionId)
    if (!session) {
      session = {
        turns: 0,
        snapshot: 0,
        tokens: 0,
        last: 0,
        max: 0,
        lastRaw: '',
        lastInjectedText: '',
        lastSubstantiveSet: null,
        lastOmittedBlocks: 0,
        lastBaseText: '',
        lastCapped: false,
        cutCooldowns: 0,
        lastStepAt: 0,
        tier: null,
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
        seenIds: new Set(),
      }
      remember(sessions, sessionId, session)
    } else {
      remember(sessions, sessionId, session)
    }
    return session
  }

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

  function extraBlocks(message) {
    return Array.isArray(message?.content) ? message.content.filter((block) => block?.type !== 'text') : []
  }

  function rebuild(message, text) {
    if (typeof message?.content === 'string') return { ...message, content: text }
    return { ...message, content: [{ type: 'text', text }, ...extraBlocks(message)] }
  }

  /**
   * Rebuild the last recall the model actually saw, applying the next snapshot
   * declaration BEFORE trimming against `cap` so digit growth (`#9` -> `#10`)
   * can never push a re-entry over the hard ceiling.
   */
  function reentryText(session, logState, nextSnapshot) {
    const prior = logState?.baseShadowed && session.lastBaseText ? session.lastBaseText : session.lastInjectedText
    const withBanner = prior.startsWith(REENTRY_PREFIX) ? prior : `${REENTRY_PREFIX}${prior}`
    const text = withSnapshotHeader(withBanner, nextSnapshot)
    const cap = settings.maxInjectTokens
    if (cap && meter.measure(text) > cap) {
      const countFn = meter.fastCount ?? meter.count
      const hasEnvelope = text.endsWith(MEMORY_ENVELOPE_CLOSE) && leadingPrefix(text).includes(VERIFY_REMINDER)
      const body = hasEnvelope ? text.slice(0, -MEMORY_ENVELOPE_CLOSE.length) : text
      const minOffset = leadingPrefix(body).length
      const prefixTokens = minOffset > 0 ? countFn(body.slice(0, minOffset)) : 0
      const tryTrim = (markers, closeSuffix) => {
        const closeTokens = closeSuffix ? countFn(closeSuffix) : 0
        const inner = cap - closeTokens
        if (inner <= prefixTokens) return ''
        for (const marker of markers) {
          const cut = trimToBudget(body, inner, marker, countFn, { minOffset })
          if (!cut || cut.length <= minOffset) continue
          const joined = `${cut}${closeSuffix}`
          if (countFn(joined) <= cap) return joined
        }
        return ''
      }
      if (hasEnvelope) {
        const closed = tryTrim([REENTRY_MARKER, REENTRY_MARKER_MIN], MEMORY_ENVELOPE_CLOSE)
        if (closed) return closed
      }
      return tryTrim([REENTRY_MARKER, REENTRY_MARKER_MIN, ''], '')
    }
    return text
  }

  function reinject(decision, session, sessionId, logState) {
    const nextSnapshot = (session.snapshot ?? 0) + 1
    const text = reentryText(session, logState, nextSnapshot)
    if (!text) return decision
    session.snapshot = nextSnapshot
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
    session.cutCooldowns = 0
    session.lastOmittedBlocks = 0
    session.lastInjectedText = text.slice(0, RAW_MEMORY_LIMIT)
    session.lastSubstantiveSet = substantiveLines(stripRuntimePrefixes(session.lastInjectedText))
    session.lastBaseText = text.slice(0, RAW_MEMORY_LIMIT)
    record({
      event: 'inject_reentered',
      session: sessionId,
      reason: (logState?.shadowed ?? logState?.baseShadowed) === 'compact' ? 'context-compacted' : 'surface-replaced',
      seq: logState?.seq ?? null,
      tokens,
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  function collectCandidates(messages, session) {
    const candidates = []
    let measuredChars = 0
    let measuredTokens = 0
    messages.forEach((message, index) => {
      if (message?.source?.kind !== settings.sourceKind) return
      const text = textOf(message)
      if (!text) return
      const rawText = stripRuntimePrefixes(text)
      const tokens = meter.measure(text)
      const rawTokens = rawText === text ? tokens : meter.count(rawText)
      measuredChars += rawText.length
      measuredTokens += rawTokens
      candidates.push({
        index,
        message,
        text,
        rawText,
        tokens,
        hasEnvelope: text.endsWith(MEMORY_ENVELOPE_CLOSE) && leadingPrefix(text).includes(VERIFY_REMINDER),
        isNew: !session.seenIds.has(message.id),
      })
    })
    return { candidates, measuredChars, measuredTokens }
  }

  async function onPreStep(payload, next) {
    if (typeof onBeforeStep === 'function') onBeforeStep(payload)
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    try {
      return await govern(payload, decision)
    } catch (error) {
      stats.prestepErrors += 1
      try {
        record({
          event: 'prestep_error',
          session: payload?.agent?.session?.header?.id ?? null,
          error: `${error?.name ?? 'Error'}: ${error?.message ?? error}`,
        })
      } catch {
        // The pass-through matters more than the journal line.
      }
      return decision
    }
  }

  async function govern(payload, inputDecision) {
    stats.preSteps += 1
    let decision = inputDecision

    const agentSession = payload?.agent?.session
    const sessionId = agentSession?.header?.id ?? 'unknown'
    const session = sessionOf(sessionId)
    const nowMs = Date.now()
    const idleMs = session.lastStepAt > 0 ? nowMs - session.lastStepAt : 0
    session.lastStepAt = nowMs
    if (idleMs >= IDLE_RESET_MS) {
      session.lastCapped = false
      session.cutCooldowns = 0
      record({ event: 'idle_reset', session: sessionId, idleMs })
    }
    const logState = lastInjectionState(agentSession, settings.sourceKind)
    const baseShadowed = logState?.baseShadowed ?? null
    const shadowed = logState?.shadowed ?? baseShadowed
    const hadInjection = Boolean(session.lastInjectedText)

    let { candidates, measuredChars, measuredTokens } = collectCandidates(decision.messages, session)

    // No external recall arrived. First check compaction re-entry; otherwise if
    // the standalone built-in memory lane is active and this is not a subagent
    // turn, pull recall directly before running the normal governor pipeline.
    if (candidates.length === 0) {
      if (hadInjection && shadowed) {
        noteTurn(decision.messages, sessionId)
        return reinject(decision, session, sessionId, logState)
      }
      if (typeof fetchRecall === 'function' && agentSession?.header?.origin !== 'subagent' && !payload?.signal?.aborted) {
        const promptText = claimPrompt(decision.messages)
        if (promptText) {
          const recalledText = await fetchRecall({
            cwd: agentSession?.header?.cwd,
            promptText,
            firstTurn: session.turns === 0,
          })
          if (typeof recalledText === 'string' && recalledText.trim()) {
            const injectedMessage = {
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: recalledText }],
              source: { kind: settings.sourceKind, form: 'recall' },
            }
            decision = { ...decision, messages: [...decision.messages, injectedMessage] }
            ;({ candidates, measuredChars, measuredTokens } = collectCandidates(decision.messages, session))
          }
        }
      }
    }

    noteTurn(decision.messages, sessionId)
    if (candidates.length === 0) return decision

    stats.totalChars = (stats.totalChars ?? 0) + measuredChars
    stats.totalTokens = (stats.totalTokens ?? 0) + measuredTokens

    noteIds(session, candidates.map((candidate) => candidate.message))
    const fresh = candidates.filter((candidate) => candidate.isNew)

    const previous = shadowed || !session.lastInjectedText ? '' : stripRuntimePrefixes(session.lastInjectedText)
    const previousLines = previous
      ? (session.lastSubstantiveSet ?? (session.lastSubstantiveSet = substantiveLines(previous)))
      : null
    const freshText = fresh.map((candidate) => candidate.rawText).join('\n')
    const sameRecall = !hadOmittedContent(session)
      && Boolean(session.lastRaw)
      && Boolean(freshText)
      && freshText.slice(0, RAW_MEMORY_LIMIT) === session.lastRaw
    const repeatRatio = previousLines && freshText
      ? (sameRecall ? 1 : repetitionRatio(previousLines, freshText))
      : 0
    stats.lastRepeat = repeatRatio

    const edits = new Map()
    const removed = new Set()
    let suppressed = 0
    let suppressedTokens = 0
    let deltaTurns = 0
    let deltaBlocks = 0
    let deltaSavedTokens = 0
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
        for (const candidate of fresh) {
          const novel = subtractRepeated(previous, candidate.rawText)
          if (!novel.text) {
            candidate.removed = true
            removed.add(candidate.index)
            suppressed += 1
            suppressedTokens += candidate.tokens
            continue
          }
          if (novel.omitted > 0) {
            const deltaText = `${novel.text}\n\n${DELTA_MARKER}`
            const deltaTokens = meter.measure(deltaText)
            deltaSavedTokens += Math.max(0, candidate.tokens - deltaTokens)
            const message = rebuild(candidate.message, deltaText)
            candidate.text = deltaText
            candidate.hasEnvelope = false
            candidate.tokens = deltaTokens
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
      stats.deltaSaved += deltaSavedTokens
      session.deltas += 1
      session.deltaSaved += deltaSavedTokens
      record({ event: 'inject_delta', session: sessionId, ratio: repeatRatio, blocks: deltaBlocks, saved: deltaSavedTokens })
    }

    const queryText = claimPrompt(decision.messages)
    const remind = Boolean(settings.verifyReminder)
    const snapshotTarget = survivors.find((candidate) => candidate.isNew) ?? null
    const modifiedSurvivors = new Set()
    let remindApplied = false
    let headerEscaped = false
    let snapshotApplied = false

    if (remind) {
      const freshSurvivors = survivors.filter((candidate) => candidate.isNew)
      const targets = freshSurvivors.length > 0 ? freshSurvivors : [survivors[0]]
      for (const target of targets) {
        if (!target.text.startsWith(VERIFY_REMINDER) && !target.text.startsWith(`${REENTRY_PREFIX}${VERIFY_REMINDER}`)) {
          target.text = `${VERIFY_REMINDER}${escapeEnvelopeBoundaries(target.text)}${MEMORY_ENVELOPE_CLOSE}`
          target.hasEnvelope = true
          modifiedSurvivors.add(target)
          remindApplied = true
        }
      }
    } else {
      for (const candidate of survivors) {
        if (!candidate.isNew) continue
        const safe = escapeSnapshotHeaders(candidate.text)
        if (safe !== candidate.text) {
          candidate.text = safe
          modifiedSurvivors.add(candidate)
          headerEscaped = true
        }
      }
    }

    if (snapshotTarget) {
      const nextSnapshot = (session.snapshot ?? 0) + 1
      const nextText = withSnapshotHeader(snapshotTarget.text, nextSnapshot)
      if (nextText !== snapshotTarget.text) {
        snapshotTarget.text = nextText
        modifiedSurvivors.add(snapshotTarget)
        session.snapshot = nextSnapshot
        snapshotApplied = true
      }
    }

    // Measure and rebuild each modified survivor once instead of re-measuring
    // twice when both envelope framing and snapshot numbering apply.
    for (const candidate of modifiedSurvivors) {
      candidate.tokens = meter.measure(candidate.text)
      candidate.message = rebuild(candidate.message, candidate.text)
      edits.set(candidate.index, candidate.message)
    }

    const total = survivors.reduce((sum, candidate) => sum + candidate.tokens, 0)
    const combined = survivors.map((candidate) => stripRuntimePrefixes(candidate.text)).join('\n')
    const cap = settings.maxInjectTokens

    let budget = cap
    let tier = null
    let after = total
    let dropped = 0
    let omittedBlocks = 0
    const finalTexts = new Map()

    if (cap && (settings.budgetPolicy === 'adaptive' || settings.budgetPolicy === 'scenario')) {
      if (settings.budgetPolicy === 'adaptive') {
        const reuseOverlap = deltaTurns === 0 && suppressed === 0 && fresh.length === candidates.length
        tier = chooseTier(settings.budgetTiers, session, combined, total, {
          shadowed,
          precomputedOverlap: reuseOverlap ? repeatRatio : null,
          precomputedSame: reuseOverlap ? sameRecall : null,
        })
      } else {
        const scenario = chooseScenario({
          firstTurn: session.turns === 0,
          step: payload?.step,
          shadowed,
          repetition: repeatRatio,
          lastCapped: session.lastCapped && (session.cutCooldowns ?? 0) === 0,
          promptText: queryText,
          overrides: settings.scenarioTiers,
        })
        tier = {
          name: scenario.tier,
          ceiling: settings.budgetTiers[scenario.tier],
          reason: scenario.reason,
          scenario: scenario.scenario,
          cooldown: scenario.scenario === 'after-cut',
        }
        session.scenario = scenario.scenario
        stats.scenarios[scenario.scenario] = (stats.scenarios[scenario.scenario] ?? 0) + 1
        stats.lastScenario = { ...scenario, at: new Date().toISOString() }
      }
      const { cooldown: _cooldown, ...publicTier } = tier
      budget = Math.min(cap, tier.ceiling)
      session.tier = tier.name
      stats.tiers[tier.name] = (stats.tiers[tier.name] ?? 0) + 1
      stats.lastTier = { ...publicTier, budget, requested: total }
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
      const weights = survivors.map((candidate) => 1 + queryRelevance(stripRuntimePrefixes(candidate.text), queryText))
      const allocations = allocateBudget(survivors.map((candidate) => candidate.tokens), budget, weights)
      const viewContext = settings.viewPolicy === 'budgeted'
        ? taskContextText(decision.messages, settings.sourceKind, settings.viewContextMessages)
        : ''
      const countFn = meter.fastCount ?? meter.count
      after = 0
      survivors.forEach((candidate, position) => {
        const allotted = allocations[position]
        if (candidate.tokens <= allotted) {
          after += candidate.tokens
          finalTexts.set(candidate.index, candidate.text)
          return
        }
        const hasEnvelope = Boolean(candidate.hasEnvelope)
        const baseText = hasEnvelope && candidate.text.endsWith(MEMORY_ENVELOPE_CLOSE)
          ? candidate.text.slice(0, -MEMORY_ENVELOPE_CLOSE.length)
          : candidate.text
        const prefix = leadingPrefix(baseText)
        const prefixTokens = prefix ? countFn(prefix) : 0
        const closeSuffix = hasEnvelope ? MEMORY_ENVELOPE_CLOSE : ''
        const closeTokens = closeSuffix ? countFn(closeSuffix) : 0
        let trimmed = ''
        if (allotted > prefixTokens && settings.viewPolicy === 'budgeted') {
          const body = baseText.slice(prefix.length)
          const runView = (suffix, suffixTokens) => {
            const bodyBudget = allotted - prefixTokens - suffixTokens
            if (bodyBudget <= 0) return null
            let view = budgetedView({
              text: body,
              contextText: viewContext,
              budget: bodyBudget,
              count: countFn,
            })
            if (view && (prefix || suffix)) {
              const over = countFn(`${prefix}${view.text}${suffix}`) - allotted
              if (over > 0) {
                view = bodyBudget - over > 0
                  ? budgetedView({
                      text: body,
                      contextText: viewContext,
                      budget: bodyBudget - over,
                      count: countFn,
                    })
                  : null
                if (view && countFn(`${prefix}${view.text}${suffix}`) > allotted) view = null
              }
            }
            return view ? { view, text: `${prefix}${view.text}${suffix}` } : null
          }
          const picked = (closeSuffix ? runView(closeSuffix, closeTokens) : null) ?? runView('', 0)
          if (picked) {
            const { view } = picked
            trimmed = picked.text
            stats.viewTurns += 1
            stats.viewKept += view.kept
            stats.viewOmitted += view.omitted
            omittedBlocks += view.omitted
            record({
              event: 'inject_view',
              session: sessionId,
              blocks: view.blocks,
              kept: view.kept,
              omitted: view.omitted,
              tokens: meter.count(trimmed),
              sources: view.sources,
              verificationNeeded: Boolean(view.verificationNeeded),
            })
          }
        }
        if (!trimmed && allotted > 0) {
          const baseMarker = `\n\n…[dsh-hindsight-tuner: cut from ~${candidate.tokens} to ~${allotted} tokens. Ask Hindsight for the full recall explicitly, or raise maxInjectTokens.]`
          const baseMarkerTokens = countFn(baseMarker)
          const trimWithEnvelope = (suffix, suffixTokens) => {
            const innerBudget = allotted - suffixTokens
            if (innerBudget <= prefixTokens) return ''
            const fit = (content) => {
              if (!content || content.length <= prefix.length) return ''
              const joined = `${content}${suffix}`
              return countFn(joined) <= allotted ? joined : ''
            }
            const selectionCap = Math.max(0, innerBudget - baseMarkerTokens)
            const selection = selectionCap > prefixTokens
              ? selectSectionsByQuery(baseText, queryText, { maxTokens: selectionCap, count: countFn })
              : selectSectionsByQuery(baseText, queryText)
            if (selection.selected) {
              const keptBody = selection.text.replace(/\s+$/, '')
              const pointer1 = buildRecoverableMarker(baseMarker, { extraDropped: selection.dropped })('')
              const withPointer1 = fit(`${keptBody}${pointer1}`)
              if (withPointer1) return withPointer1
              const pointerCap = innerBudget - countFn(pointer1)
              if (pointerCap > prefixTokens) {
                const selection2 = selectSectionsByQuery(baseText, queryText, { maxTokens: pointerCap, count: countFn })
                if (selection2.selected) {
                  const pointer2 = buildRecoverableMarker(baseMarker, { extraDropped: selection2.dropped })('')
                  const withPointer2 = fit(`${selection2.text.replace(/\s+$/, '')}${pointer2}`)
                  if (withPointer2) return withPointer2
                }
              }
              const withBase = fit(`${keptBody}${baseMarker}`)
              if (withBase) return withBase
            }
            const ordered = selection.selected ? (selection.reordered ?? selectSectionsByQuery(baseText, queryText).text) : selection.text
            const marker = buildRecoverableMarker(baseMarker)
            for (const activeMarker of [marker, baseMarker]) {
              const cut = trimToBudget(ordered, innerBudget, activeMarker, countFn, { minOffset: prefix.length })
              if (!cut) continue
              const joined = fit(cut)
              if (joined) return joined
              if (suffix) {
                const over = countFn(`${cut}${suffix}`) - allotted
                if (over > 0 && innerBudget - over > prefixTokens) {
                  const tighter = fit(trimToBudget(ordered, innerBudget - over, activeMarker, countFn, { minOffset: prefix.length }))
                  if (tighter) return tighter
                }
              }
            }
            return ''
          }
          trimmed = (closeSuffix ? trimWithEnvelope(closeSuffix, closeTokens) : '') || trimWithEnvelope('', 0)
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
    session.lastOmittedBlocks = omittedBlocks
    session.cutCooldowns = tier?.cooldown ? 1 : 0
    if (after > 0) {
      session.lastRaw = (fresh.length > 0 ? fresh : candidates)
        .map((candidate) => candidate.rawText)
        .join('\n')
        .slice(0, RAW_MEMORY_LIMIT)
      if (deliveredText) {
        session.lastInjectedText = deliveredText.slice(0, RAW_MEMORY_LIMIT)
        session.lastSubstantiveSet = substantiveLines(stripRuntimePrefixes(session.lastInjectedText))
        if (deltaTurns === 0) session.lastBaseText = deliveredText.slice(0, RAW_MEMORY_LIMIT)
      }
    }
    stats.turns += 1
    stats.lastTurnTokens = total
    stats.maxTurnTokens = Math.max(stats.maxTurnTokens, total)
    stats.seen += candidates.length

    if (cappedThisTurn || remindApplied || snapshotApplied || headerEscaped || suppressed > 0 || deltaTurns > 0) {
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
