/**
 * Integration test against the real Hindsight DSH hooks.
 *
 * The smoke test simulates a waterfall; this one imports the shipped
 * `@vectorize-io/hindsight-coding-agents` bundle, registers its real pre-step
 * hook *after* the tuner (so it is the outer listener at load time), fires the
 * session-start event the way DSH does, and checks the payload the model would
 * receive. That is the only test that proves the budget wraps the real
 * integration rather than a rehearsal of it.
 *
 * The package is optional for a local run: when it is not installed the test
 * prints `integration: skipped` and exits 0, so a cloner without memory can
 * still run the other suites. CI and `HINDSIGHT_INTEGRATION_REQUIRED=1` make it
 * a hard failure instead, so the composition proof cannot silently disappear.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { waitFor } from './wait.mjs'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-hindsight-integration-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

// Resolve the real installation *before* the environment is isolated below: on
// a developer machine the integration lives in a real profile, not in this
// checkout. Hard-coding the `desktop` profile name made this test silently skip
// everywhere else; scan the profiles that actually exist instead, in sorted
// order so the choice does not depend on directory order.
const PACKAGE = ['node_modules', '@vectorize-io', 'hindsight-coding-agents']
const realDshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const candidates = [
  process.env.HINDSIGHT_INTEGRATION_DIR,
  process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, ...PACKAGE) : null,
  join(root, ...PACKAGE),
]
const profilesRoot = join(realDshHome, 'profiles')
if (existsSync(profilesRoot)) {
  for (const profile of readdirSync(profilesRoot).sort()) candidates.push(join(profilesRoot, profile, ...PACKAGE))
}
const searched = candidates.filter(Boolean)
const packageDir = searched.find((candidate) => existsSync(join(candidate, 'dist', 'dsh.js')))
if (!packageDir) {
  const install = 'npm install --no-save --no-package-lock --no-audit --no-fund @vectorize-io/hindsight-coding-agents@0.8.7'
  const list = searched.map((candidate) => `  ${candidate}`).join('\n')
  if (process.env.CI || process.env.HINDSIGHT_INTEGRATION_REQUIRED) {
    console.error('integration: FAILED — @vectorize-io/hindsight-coding-agents is required but was not found')
    console.error(`searched:\n${list}`)
    console.error(`install it with:\n  ${install}\nor point HINDSIGHT_INTEGRATION_DIR at a copy that has dist/dsh.js.`)
    process.exit(1)
  }
  console.log('integration: skipped (install @vectorize-io/hindsight-coding-agents to run this test)')
  console.log(`searched:\n${list}`)
  console.log(`install it with:\n  ${install}`)
  process.exit(0)
}

process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.HINDSIGHT_CONFIG = join(scratch, 'coding-agent.json')
process.env.HINDSIGHT_DIAG_FILE = join(scratch, 'diag.jsonl')
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ observationScopes: 'shared' }, null, 2))

const fakeProfile = join(scratch, 'profile')
mkdirSync(join(fakeProfile, 'node_modules', '@vectorize-io'), { recursive: true })
writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({
  name: 'integration-profile',
  private: true,
  dependencies: { '@vectorize-io/hindsight-coding-agents': '0.8.7' },
  dsh: { profile: { bundles: ['@vectorize-io/hindsight-coding-agents'] } },
}, null, 2))
process.env.DSH_PROFILE_DIR = fakeProfile
delete process.env.DSH_PROFILE
delete process.env.DSH_INSTALL_DIR

const integration = await import(pathToFileURL(join(packageDir, 'dist', 'dsh.js')).href)
assert.equal(typeof integration.createDshHooks, 'function', 'the real package exports createDshHooks')

const { apply } = await import('../index.js')
const { estimateTokens } = await import('../lib/tokens.js')

function makeHarness() {
  const handlers = new Map()
  const harness = { handlers, tools: [], commands: [], disposers: [] }
  harness.ctx = {
    on(event, handler, options) {
      if (!handlers.has(event)) handlers.set(event, [])
      const list = handlers.get(event)
      const entry = { handler, prepend: options === true || options?.prepend === true }
      if (entry.prepend) list.unshift(entry)
      else list.push(entry)
      return () => {
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') harness.disposers.push(dispose)
      return () => {}
    },
    inject() {
      return () => {}
    },
  }
  return harness
}

/** Cordis waterfall: array order, each listener wrapping the next. */
function waterfall(harness, event, payload, inner) {
  const list = [...(harness.handlers.get(event) ?? [])]
  const run = (index) => (index >= list.length ? inner() : list[index].handler(payload, () => run(index + 1)))
  return run(0)
}

const SOURCE_KIND = 'plugin:hindsight'

// The ceiling checks below are only meaningful if the message exists: a missing
// injection reads as `''`, and `estimateTokens('') === 0` passes every upper
// bound. Assert one non-empty payload first, then measure it.
function injectedText(messages, label) {
  const found = messages.filter((message) => message?.source?.kind === SOURCE_KIND)
  assert.equal(found.length, 1, `${label}: the real integration injected exactly one memory message`)
  const joined = found[0].content.map((block) => block.text ?? '').join('\n')
  assert.ok(joined.trim().length > 0, `${label}: the injected recall has text`)
  return joined
}

const cap = 500
const memoryLines = Array.from({ length: 260 }, (_, index) => `memory line ${index}: 这是一条项目记忆 with detail about the repo and its decisions.`)
const bulk = memoryLines.join('\n')
assert.ok(estimateTokens(bulk) > cap * 4, 'fixture recall is far over the cap')

let injection = bulk
const workspace = {
  root: scratch,
  seeded: undefined,
  core: {
    async seedIfCold() {
      return { seeded: true }
    },
    async onPrompt(sessionId, prompt) {
      assert.ok(sessionId, 'session id is passed through')
      assert.match(prompt, /do the thing/, 'the real hook extracts the user prompt')
    },
    getInjection() {
      return injection
    },
  },
}

const hooks = integration.createDshHooks((agent) => (agent?.session?.header?.origin === 'subagent' ? undefined : workspace))
const harness = makeHarness()
apply(harness.ctx, { autoTune: false, maxInjectTokens: cap })

// Register the real integration *after* the tuner: on load order it becomes the
// outer listener, which is the exact situation the session-start re-prepend fixes.
harness.ctx.on('agent/session-start', hooks.sessionStart)
harness.ctx.on('agent/pre-step', hooks.preStep, { prepend: true })

const agent = {
  session: {
    header: { id: 'integration-session', cwd: scratch, origin: 'main' },
    events: [],
  },
}
for (const entry of [...(harness.handlers.get('agent/session-start') ?? [])]) {
  entry.handler({ agent })
}

const human = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }
const decision = await waterfall(harness, 'agent/pre-step', { agent, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))

const text = injectedText(decision.messages, 'first turn')
const tokens = estimateTokens(text)
assert.ok(tokens <= cap, `the final payload the model receives is within the ceiling: ${tokens} <= ${cap}`)
assert.match(text, /dsh-hindsight-tuner: cut from/, 'the tuner, not the integration, performed the cut')
assert.ok(decision.messages[0] === human, 'the user message is untouched')

// A second turn with the same recall is capped again, never passed through raw.
const second = await waterfall(harness, 'agent/pre-step', { agent, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const secondText = injectedText(second.messages, 'second turn')
assert.ok(estimateTokens(secondText) <= cap, 'repeat turns stay within the same ceiling')

// With the cap off the real payload passes through unchanged, proving the
// difference comes from the tuner rather than from the stub.
const openHarness = makeHarness()
apply(openHarness.ctx, { autoTune: false, maxInjectTokens: 0 })
openHarness.ctx.on('agent/pre-step', hooks.preStep, { prepend: true })
const untouched = await waterfall(openHarness, 'agent/pre-step', { agent, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const untouchedText = injectedText(untouched.messages, 'cap-off turn')
assert.equal(untouchedText, injection, 'cap off leaves the integration payload alone')

for (const dispose of [...harness.disposers, ...openHarness.disposers]) dispose()

// DSH 0.2.x flow: `inject(['agents'])` mounts asynchronously after `apply()`,
// the integration registers `agent/pre-step` inside that `agents` callback,
// and session startup emits `agent/created` (with 1-based `step`).
const modernHarness = makeHarness()
const agentWaiters = []
let agentsMounted = false
const baseModernInject = modernHarness.ctx.inject
modernHarness.ctx.inject = (services, callback) => {
  if (services.includes('agents')) {
    if (agentsMounted) {
      callback({ agents: {} })
      return () => {}
    }
    agentWaiters.push(callback)
    return () => {
      const index = agentWaiters.indexOf(callback)
      if (index >= 0) agentWaiters.splice(index, 1)
    }
  }
  return baseModernInject(services, callback)
}

injection = bulk
apply(modernHarness.ctx, {
  autoTune: true,
  maxInjectTokens: cap,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 120, normal: 250, deep: cap },
})
// Upstream declares `inject: ['agents']` and mounts its `pre-step` after the tuner's callback.
modernHarness.ctx.inject(['agents'], () => {
  modernHarness.ctx.on('agent/pre-step', hooks.preStep, { prepend: true })
})
agentsMounted = true
for (const cb of agentWaiters.splice(0)) cb({ agents: {} })

const modernAgent = {
  session: {
    header: { id: 'modern-session', cwd: scratch, origin: 'main' },
    events: [],
  },
}
for (const entry of [...(modernHarness.handlers.get('agent/created') ?? [])]) {
  entry.handler({ agent: modernAgent, source: 'startup' })
}
await waitFor(() => JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8')).autoInject === 'pages', {
  label: 'agent/created auto-tune write',
})
const tunedFile = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8'))
assert.equal(tunedFile.autoInject, 'pages', 'agent/created auto-tunes coding-agent.json in DSH 0.2.x')

const step1Decision = await waterfall(modernHarness, 'agent/pre-step', { agent: modernAgent, step: 1, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const step1Text = injectedText(step1Decision.messages, 'modern turn 1')
assert.ok(estimateTokens(step1Text) <= cap && estimateTokens(step1Text) > 250, 'turn 1 (step: 1) wraps deferred agents hook and gets deep tier')

// That recall was cut, and the documented precedence puts `after-cut` above the
// prompt signal, so the very next turn would be a light after-cut turn. Send one
// small recall that fits the light tier: the cut state clears (the after-cut
// cooldown steps the turn after it back up), so the assertions below test the
// step handling and the task signal rather than the after-cut rule.
injection = Array.from({ length: 4 }, (_, i) => `settle line ${i}: a short memory item that fits the light tier.`).join('\n')
const settle = await waterfall(modernHarness, 'agent/pre-step', { agent: modernAgent, step: 1, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const settleText = injectedText(settle.messages, 'settle turn')
assert.ok(estimateTokens(settleText) <= 120, 'the settle turn is an after-cut light turn and was not cut again')

injection = Array.from({ length: 220 }, (_, i) => `debug turn line ${i}: fresh memory item for modern DSH scenario check.`).join('\n')
const debugPrompt = { id: 'human-debug', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing: fix the failing error' }] }
const step1Debug = await waterfall(modernHarness, 'agent/pre-step', { agent: modernAgent, step: 1, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [debugPrompt],
}))
const step1DebugText = injectedText(step1Debug.messages, 'debug turn')
assert.ok(estimateTokens(step1DebugText) <= 250 && estimateTokens(step1DebugText) > 120, 'turn 2 (step: 1) picks debug/normal rather than continuation/light')

injection = Array.from({ length: 220 }, (_, i) => `continuation turn line ${i}: unique content for step 2 light ceiling check.`).join('\n')
const step2Decision = await waterfall(modernHarness, 'agent/pre-step', { agent: modernAgent, step: 2, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const step2Text = injectedText(step2Decision.messages, 'step 2')
assert.ok(estimateTokens(step2Text) <= 120, 'step 2 triggers continuation/light tier')

// A failing step is about to be debugged, so it outranks the tool-continuation
// rule even on a later step: the debugging turn keeps the normal ceiling.
injection = Array.from({ length: 220 }, (_, i) => `debug continuation line ${i}: unique content for step 3 debug check.`).join('\n')
const step3Decision = await waterfall(modernHarness, 'agent/pre-step', { agent: modernAgent, step: 3, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [debugPrompt],
}))
const step3Text = injectedText(step3Decision.messages, 'step 3 debug')
assert.ok(
  estimateTokens(step3Text) > 120 && estimateTokens(step3Text) <= 250,
  'a failing step outranks continuation and keeps debug/normal',
)

for (const dispose of modernHarness.disposers) dispose()
console.log(`integration: all checks passed against ${join(packageDir, 'dist', 'dsh.js')}`)
