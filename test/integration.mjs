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
 * The package is optional: when it is not installed the test reports a skip
 * instead of failing, so a cloner without memory installed can still run it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-hindsight-integration-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.HINDSIGHT_CONFIG = join(scratch, 'coding-agent.json')
process.env.HINDSIGHT_DIAG_FILE = join(scratch, 'diag.jsonl')
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ observationScopes: 'shared' }, null, 2))

// The tuner looks for the integration in the profile; give it the same tree we
// load from so status and the hook see a consistent installation.
const candidates = [
  process.env.HINDSIGHT_INTEGRATION_DIR,
  join(root, 'node_modules', '@vectorize-io', 'hindsight-coding-agents'),
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@vectorize-io', 'hindsight-coding-agents'),
].filter(Boolean)
const packageDir = candidates.find((candidate) => existsSync(join(candidate, 'dist', 'dsh.js')))
if (!packageDir) {
  console.log('integration: skipped (install @vectorize-io/hindsight-coding-agents to run this test)')
  process.exit(0)
}

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

const injected = decision.messages.filter((message) => message?.source?.kind === 'plugin:hindsight')
assert.equal(injected.length, 1, 'the real integration injected one memory message')
const text = injected[0].content.map((block) => block.text ?? '').join('\n')
const tokens = estimateTokens(text)
assert.ok(tokens <= cap, `the final payload the model receives is within the ceiling: ${tokens} <= ${cap}`)
assert.match(text, /dsh-hindsight-tuner: cut from/, 'the tuner, not the integration, performed the cut')
assert.ok(decision.messages[0] === human, 'the user message is untouched')

// A second turn with the same recall is capped again, never passed through raw.
const second = await waterfall(harness, 'agent/pre-step', { agent, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const secondText = second.messages.find((message) => message?.source?.kind === 'plugin:hindsight')?.content[0]?.text ?? ''
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
const untouchedText = untouched.messages.find((message) => message?.source?.kind === 'plugin:hindsight')?.content[0]?.text ?? ''
assert.equal(untouchedText, injection, 'cap off leaves the integration payload alone')

for (const dispose of [...harness.disposers, ...openHarness.disposers]) dispose()
console.log(`integration: all checks passed against ${join(packageDir, 'dist', 'dsh.js')}`)
