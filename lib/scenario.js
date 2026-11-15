/**
 * Scenario-aware budget policy (v0.18, opt-in).
 *
 * The adaptive policy (v0.9) only knows two things about a turn: whether the
 * recall repeats what the model already has, and whether the previous recall had
 * to be cut. That is cheap but blind to *why* the turn exists. A debugging turn
 * that just received a stack trace benefits from pitfall memory, while a
 * tool-continuation step inside the same turn is already carrying the recall and
 * should not spend a second full budget on it.
 *
 * This module classifies a turn into a named scenario and maps it to one of the
 * existing budget tiers. It is deliberately lexical and explainable: every
 * decision prints a one-line reason, and no scenario can raise `maxInjectTokens`
 * or the configured tier ceilings. Defaults keep the policy off; enabling it is
 * an experiment, to be validated by the P2 gate (A3 native pages vs A3-T tuner
 * truncation vs A3-V budgeted view) before anyone treats it as the default.
 *
 * Precedence, most to least specific:
 *   compaction recovery > first turn > tool continuation > repeat >
 *   previous recall cut > task kind > default.
 * The first two are recovery/information-poor states where a deeper ceiling is
 * justified; the middle three are "the information is (partly) already here"
 * states; the task kind only chooses between normal and light.
 */

/** Every scenario the policy can report, in precedence order. */
export const SCENARIO_NAMES = [
  'compaction-recovery',
  'first-turn',
  'continuation',
  'repeat',
  'after-cut',
  'debug',
  'edit',
  'review',
  'question',
  'default',
]

/** Tier names shared with `budgetTiers`; a scenario maps to exactly one. */
export const SCENARIO_TIER_NAMES = ['light', 'normal', 'deep']

/**
 * Default scenario -> tier map. These are starting points, not measured
 * optima: the P2 ablation must decide whether scenario policy is worth keeping
 * and which map is better than a flat ceiling.
 */
export const DEFAULT_SCENARIO_TIERS = Object.freeze({
  'compaction-recovery': 'deep',
  'first-turn': 'deep',
  continuation: 'light',
  repeat: 'light',
  'after-cut': 'light',
  debug: 'normal',
  edit: 'normal',
  review: 'normal',
  question: 'light',
  default: 'normal',
})

const TASK_HINTS = [
  {
    kind: 'debug',
    hints: [
      [/\b(?:error|exception|traceback|stack\s?trace|panic|crash(?:ed|es)?|regression|bug|broken|failing|failure|failed|timeout|timed out|segfault|assertion)\b/i, 'failure keyword'],
      [/(报错|异常|崩溃|失败|回归|修复|调试|排查|不通过)/, 'failure keyword'],
    ],
  },
  {
    kind: 'review',
    hints: [
      [/\b(?:review|audit|inspect|explain|understand|analy[sz]e|diagnose)\b/i, 'review keyword'],
      [/(审查|复核|解释|分析|为什么|理解|说明|评估)/, 'review keyword'],
    ],
  },
  {
    kind: 'edit',
    hints: [
      [/\b(?:add|implement|refactor|rename|move|extract|upgrade|update|change|write|create|delete|remove|migrate|port|fix|solve|support|introduce)\b/i, 'change keyword'],
      [/(实现|重构|新增|添加|修改|删除|迁移|升级|重命名|支持|编写|接入)/, 'change keyword'],
    ],
  },
  {
    kind: 'question',
    hints: [
      [/^\s*(?:what|how|why|where|when|who|which|can|could|should|would|is|are|do|does|did|have|has)\b/i, 'question opener'],
      [/\?\s*$/, 'question mark'],
      [/(吗|呢|？)/, 'question marker'],
    ],
  },
]

/**
 * Classify the claimed prompt by lexical task hints.
 *
 * Returns `{ kind, reason }` where kind is one of debug/edit/review/question or
 * 'default'. First match wins in the priority order above: "fix the failing
 * test" is a debugging turn, not an edit, because the failure is what memory
 * can help with.
 */
export function classifyTask(text) {
  const prompt = typeof text === 'string' ? text : ''
  if (prompt.trim().length === 0) return { kind: 'default', reason: 'no prompt text in this step' }
  for (const group of TASK_HINTS) {
    for (const [pattern, label] of group.hints) {
      if (pattern.test(prompt)) return { kind: group.kind, reason: `${label} in the prompt` }
    }
  }
  return { kind: 'default', reason: 'no task signal in the prompt' }
}

/**
 * Pick the scenario for this turn and the tier it maps to.
 *
 * All inputs are already-observed signals from the governor; the function is
 * pure so the table can be tested without a host. `overrides` is the validated
 * `scenarioTiers` setting; an invalid entry is ignored here (validation already
 * reports it), never half-applied.
 */
export function chooseScenario({
  firstTurn = false,
  step = 0,
  shadowed = null,
  repetition = 0,
  lastCapped = false,
  promptText = '',
  overrides = null,
} = {}) {
  let scenario = 'default'
  let reason = 'no task signal; normal ceiling'
  if (shadowed) {
    scenario = 'compaction-recovery'
    reason = shadowed === 'replace'
      ? 'the earlier recall was replaced in the model surface'
      : 'the earlier recall was shadowed by a compaction'
  } else if (firstTurn) {
    scenario = 'first-turn'
    reason = 'first recall of the session, nothing is in context yet'
  } else if (Number.isFinite(step) && step > 0) {
    scenario = 'continuation'
    reason = `tool-continuation step ${step}: this turn already received its recall`
  } else if (typeof repetition === 'number' && repetition >= 0.6) {
    scenario = 'repeat'
    reason = `${Math.round(repetition * 100)}% of this recall repeats what is in context`
  } else if (lastCapped) {
    scenario = 'after-cut'
    reason = 'the previous recall had to be cut'
  } else {
    const task = classifyTask(promptText)
    if (task.kind !== 'default') {
      scenario = task.kind
      reason = task.reason
    }
  }
  const tier = overrides && SCENARIO_TIER_NAMES.includes(overrides[scenario])
    ? overrides[scenario]
    : DEFAULT_SCENARIO_TIERS[scenario]
  return { scenario, tier, reason }
}
