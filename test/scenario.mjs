import assert from 'node:assert/strict'

import {
  chooseScenario,
  classifyTask,
  DEFAULT_SCENARIO_TIERS,
  SCENARIO_NAMES,
  SCENARIO_TIER_NAMES,
} from '../lib/scenario.js'

// --- the table ---------------------------------------------------------------
assert.deepEqual([...SCENARIO_NAMES].sort(), Object.keys(DEFAULT_SCENARIO_TIERS).sort(), 'every scenario has a default tier')
for (const [scenario, tier] of Object.entries(DEFAULT_SCENARIO_TIERS)) {
  assert.ok(SCENARIO_TIER_NAMES.includes(tier), `${scenario} maps to a real tier (${tier})`)
}
assert.equal(DEFAULT_SCENARIO_TIERS['first-turn'], 'deep', 'a first turn has no context yet')
assert.equal(DEFAULT_SCENARIO_TIERS['compaction-recovery'], 'deep', 'memory lost to compaction is worth restoring deeply')
assert.equal(DEFAULT_SCENARIO_TIERS.continuation, 'light', 'a tool step already carries the turn recall')
assert.equal(DEFAULT_SCENARIO_TIERS.question, 'light', 'a question rarely needs the full budget')

// --- task classification -----------------------------------------------------
assert.equal(classifyTask('Fix the failing test in lib/view.js — error: expected 3, got 2').kind, 'debug')
assert.equal(classifyTask('修复视图预算的报错').kind, 'debug')
assert.equal(classifyTask('Review the diff for leaked tokens').kind, 'review')
assert.equal(classifyTask('Explain how the bank fingerprint works').kind, 'review')
assert.equal(classifyTask('Add a retry loop around the fetch call').kind, 'edit')
assert.equal(classifyTask('重构 trimToBudget 的边界处理').kind, 'edit')
assert.equal(classifyTask('How does the budget tier table work?').kind, 'question')
assert.equal(classifyTask('').kind, 'default')
assert.equal(classifyTask('   ').kind, 'default')
assert.equal(classifyTask('hello there').kind, 'default')
assert.match(classifyTask('Fix the failing test').reason, /failure keyword/)

// --- precedence --------------------------------------------------------------
const shadowed = chooseScenario({ firstTurn: true, shadowed: 'compact', step: 2, repetition: 1, lastCapped: true })
assert.equal(shadowed.scenario, 'compaction-recovery', 'compaction wins over every other state')
assert.equal(shadowed.tier, 'deep')
const replaced = chooseScenario({ shadowed: 'replace' })
assert.equal(replaced.scenario, 'compaction-recovery')
assert.match(replaced.reason, /replaced/)

assert.equal(chooseScenario({ firstTurn: true, step: 2, promptText: 'fix the error' }).scenario, 'first-turn')
// DSH passes 1-based step numbers inside a turn: step 1 is turn entry, >=2 is continuation.
assert.equal(chooseScenario({ step: 1, promptText: 'Fix the error' }).scenario, 'debug')
assert.equal(chooseScenario({ step: 1 }).scenario, 'default')
// An explicit failure signature outranks continuation and the after-cut cooldown
// (proposal 14): a debugging step needs pitfall memory even mid-turn.
assert.equal(chooseScenario({ step: 2, promptText: 'Fix the error' }).scenario, 'debug')
assert.equal(chooseScenario({ step: 2, promptText: 'Add a retry loop' }).scenario, 'continuation')
assert.equal(chooseScenario({ step: 3 }).scenario, 'continuation')
assert.equal(chooseScenario({ step: 3 }).tier, 'light')
assert.equal(chooseScenario({ repetition: 0.8, promptText: 'fix the error' }).scenario, 'repeat')
assert.equal(chooseScenario({ repetition: 0.8 }).tier, 'light')
assert.equal(chooseScenario({ lastCapped: true, promptText: 'fix the error' }).scenario, 'debug')
assert.equal(chooseScenario({ lastCapped: true, promptText: 'Add a retry loop' }).scenario, 'after-cut')
assert.equal(
  chooseScenario({ lastCapped: true, repetition: 0.5, promptText: 'fix the error' }).scenario,
  'after-cut',
  'a mostly-repeating debug recall keeps the cut cooldown',
)

// Task kind only applies when no turn-state signal is present.
const debug = chooseScenario({ promptText: 'Fix the failing test — error: expected 3' })
assert.equal(debug.scenario, 'debug')
assert.equal(debug.tier, 'normal')
assert.match(debug.reason, /failure keyword/)
assert.equal(chooseScenario({ promptText: 'How does this work?' }).scenario, 'question')
assert.equal(chooseScenario({ promptText: 'How does this work?' }).tier, 'light')

// No signal at all is still explainable and bounded.
const fallback = chooseScenario()
assert.equal(fallback.scenario, 'default')
assert.equal(fallback.tier, 'normal')
assert.match(fallback.reason, /no task signal/)

// --- overrides ---------------------------------------------------------------
const overridden = chooseScenario({ promptText: 'Fix the failing test — error', overrides: { debug: 'light' } })
assert.equal(overridden.tier, 'light', 'a validated override replaces the default tier')
// Passing an override for a scenario does not select that scenario, and it must
// not rewrite the shared default table: selection is still driven by the turn
// state and prompt, so snapshot the table around the unrelated overrides.
const defaultsBefore = { ...DEFAULT_SCENARIO_TIERS }
const already = chooseScenario({ overrides: { debug: 'normal' } })
assert.equal(already.scenario, 'default', 'an override for a scenario does not select it')
assert.equal(already.tier, 'normal')
const unrelated = chooseScenario({ promptText: 'How does this work?', overrides: { debug: 'deep' } })
assert.equal(unrelated.scenario, 'question', 'an override for another scenario leaves classification alone')
assert.equal(unrelated.tier, 'light', 'and leaves that scenario on its own default tier')
assert.deepEqual(DEFAULT_SCENARIO_TIERS, defaultsBefore, 'an override lookup never rewrites the shared default table')
const junk = chooseScenario({ promptText: 'Fix the failing test — error', overrides: { debug: 'huge' } })
assert.equal(junk.tier, 'normal', 'an invalid override is ignored here (validation reports it)')
const repeatOverride = chooseScenario({ repetition: 0.9, overrides: { repeat: 'deep' } })
assert.equal(repeatOverride.tier, 'deep', 'any scenario can be overridden')

console.log('scenario: all checks passed')
