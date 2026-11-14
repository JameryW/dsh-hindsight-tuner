import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-hindsight-tuner-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.HINDSIGHT_CONFIG = join(scratch, 'coding-agent.json')
process.env.HINDSIGHT_DIAG_FILE = join(scratch, 'diag.jsonl')

// Pin the environment: the plugin looks for the integration in the profile, so
// give it a fake profile instead of relying on the machine running the test.
const fakeProfile = join(scratch, 'profile')
const fakeIntegration = join(fakeProfile, 'node_modules', '@vectorize-io', 'hindsight-coding-agents')
mkdirSync(fakeIntegration, { recursive: true })
writeFileSync(join(fakeIntegration, 'package.json'), '{"name":"@vectorize-io/hindsight-coding-agents","version":"0.0.0"}')
writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({
  name: 'test-profile',
  private: true,
  dependencies: {
    '@vectorize-io/hindsight-coding-agents': '0.8.7',
    'dsh-mnemon': '0.5.45',
    'dsh-context': '0.84.1',
  },
  dsh: { profile: { bundles: ['@vectorize-io/hindsight-coding-agents', 'dsh-mnemon'] } },
}, null, 2))
process.env.DSH_PROFILE_DIR = fakeProfile
delete process.env.DSH_PROFILE
delete process.env.DSH_INSTALL_DIR
for (const name of ['HINDSIGHT_AUTO_INJECT', 'HINDSIGHT_API_URL', 'HINDSIGHT_API_PORT', 'HINDSIGHT_DISABLED']) delete process.env[name]

const { estimateTokens, truncateToBudget, allocateBudget } = await import('../lib/tokens.js')
const { applyTuning, revertTuning, readConfigFile, getPath } = await import('../lib/config-file.js')
const { bankResolution, diagPath, effectiveConfig } = await import('../lib/diagnostics.js')

// --- token estimation and truncation ---------------------------------------
assert.equal(estimateTokens(''), 0)
assert.ok(estimateTokens('中文四个字') >= 5, 'CJK counts about one token per character')
assert.ok(estimateTokens('abcdefgh') < 4, 'latin text packs more than one char per token')

const long = Array.from({ length: 400 }, (_, index) => `line ${index} 这是一段记忆内容 with some latin prose in it.`).join('\n')
const capped = truncateToBudget(long, 900, '\n…[cut]')
assert.ok(capped.length < long.length)
assert.ok(capped.endsWith('…[cut]'))
assert.ok(estimateTokens(capped) <= 900, `expected <= 900 tokens, got ${estimateTokens(capped)}`)
assert.ok(capped.startsWith('line 0 '), 'keeps the head of the payload')
assert.equal(truncateToBudget('short', 900), 'short', 'no-op under budget')
assert.equal(truncateToBudget(long, 0), long, 'cap <= 0 disables')

// No hidden floor: a cap smaller than the marker yields nothing to inject.
assert.equal(truncateToBudget(long, 1, '\n…[a marker longer than one token]'), '', 'cannot fit -> empty, not 32 tokens')
assert.ok(estimateTokens(truncateToBudget(long, 12, '')) <= 12, 'tiny cap still holds')

// The cap holds for mixed CJK/latin text at every boundary, not just this sample.
let seed = 7
function randomText(words) {
  const pool = ['中', '记忆', 'word', 'token', '的', 'amber', 'ok']
  let out = ''
  for (let index = 0; index < words; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    out += `${pool[seed % pool.length]}${seed % 3 === 0 ? '\n' : ' '}`
  }
  return out
}
for (const cap of [40, 120, 600, 1600]) {
  for (let round = 0; round < 10; round += 1) {
    const output = truncateToBudget(randomText(300), cap, '\n…')
    assert.ok(estimateTokens(output) <= cap, `cap ${cap} held: ${estimateTokens(output)}`)
  }
}

// The turn budget is shared, never multiplied by the number of messages.
for (const tokens of [[900, 900], [5000, 10, 10], [1, 1, 1, 1]]) {
  const allocations = allocateBudget(tokens, 600)
  const sum = allocations.reduce((total, value) => total + value, 0)
  assert.ok(sum <= 600, `allocations sum ${sum} <= 600`)
  assert.ok(allocations.every((value, index) => value <= tokens[index]), 'never allocates more than a message has')
}

// --- shared config tuning ---------------------------------------------------
const preset = [
  ['autoInject', 'pages'],
  ['injectTimeoutMs', 7000],
  ['observationScopes', 'per_source'],
  ['recallOptions.max_tokens', 3000],
]

const created = applyTuning({ preset })
assert.equal(created.fileExisted, false, 'creates the file when absent')
assert.deepEqual(created.changed.map((change) => change.path).sort(), [
  'autoInject',
  'injectTimeoutMs',
  'observationScopes',
  'recallOptions.max_tokens',
])
assert.equal(existsSync(`${process.env.HINDSIGHT_CONFIG}.lock`), false, 'lock is released')

const written = readConfigFile()
assert.equal(written.kind, 'ok')
assert.equal(written.config.autoInject, 'pages')
assert.equal(written.config.injectTimeoutMs, 7000)
assert.equal(written.config.recallOptions.max_tokens, 3000)

// Existing user values win unless overwrite is requested.
const userFile = JSON.parse(JSON.stringify(written.config))
userFile.autoInject = 'reflect'
userFile.apiUrl = 'http://127.0.0.1:9'
userFile.recallOptions = { max_tokens: 12000 }
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify(userFile, null, 2))

const kept = applyTuning({ preset })
assert.equal(kept.changed.length, 0, 'fill-missing-only respects existing values')
assert.equal(readConfigFile().config.autoInject, 'reflect')

const overridden = applyTuning({ preset, overwrite: true })
assert.ok(overridden.changed.some((change) => change.path === 'autoInject'))
assert.equal(readConfigFile().config.autoInject, 'pages')
assert.equal(readConfigFile().config.recallOptions.max_tokens, 3000)

// Revert restores the previous value instead of deleting a pre-existing key.
const reverted = revertTuning()
assert.ok(reverted.reverted.some((entry) => entry.path === 'autoInject'))
assert.equal(readConfigFile().config.autoInject, 'reflect', 'previous value restored')
assert.equal(getPath(readConfigFile().config, 'recallOptions.max_tokens'), 12000)
assert.equal(readConfigFile().config.apiUrl, 'http://127.0.0.1:9', 'unrelated keys are preserved')

// A reverting plugin leaves a value the user changed after us alone.
applyTuning({ preset: [['observationScopes', 'per_source']] })
const edited = JSON.parse(JSON.stringify(readConfigFile().config))
edited.observationScopes = 'shared'
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify(edited, null, 2))
const skipped = revertTuning()
assert.deepEqual(skipped.reverted, [])
assert.equal(skipped.skipped[0].path, 'observationScopes')

// Invalid JSON is refused, never rewritten.
writeFileSync(process.env.HINDSIGHT_CONFIG, '{ not json')
assert.throws(() => applyTuning({ preset }), /refusing to edit/)
assert.throws(() => revertTuning(), /refusing to edit/)
assert.equal(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8'), '{ not json')

// A journal left by a crash is folded into the applied map on the next read.
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ autoInject: 'pages' }, null, 2))
const stateDir = join(process.env.DSH_HOME, 'storages', 'dsh-hindsight-tuner')
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
  applied: {},
  journal: { kind: 'apply', startedAt: new Date().toISOString(), changes: [{ path: 'autoInject', from: null, to: 'pages' }] },
}))
const recoveredRevert = revertTuning()
assert.deepEqual(recoveredRevert.reverted.map((entry) => entry.path), ['autoInject'], 'crash-recovered write is revertible')
assert.equal(readConfigFile().config.autoInject, undefined)

// --- effective config resolution -------------------------------------------
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
  autoInject: 'pages',
  observationScopes: 'shared',
  bankIdTemplate: 'coding-agent::{gitProject}',
  mapPathToBank: { 'C:\\work\\shared-repo': 'coding-agent::shared' },
  harnesses: { dsh: { autoInject: 'recall', injectTimeoutMs: 4000 } },
}, null, 2))

const layers = effectiveConfig(readConfigFile().config, { env: {} })
assert.equal(layers.config.autoInject, 'recall', 'harness override wins over the file')
assert.equal(layers.config.injectTimeoutMs, 4000)
assert.equal(layers.config.observationScopes, 'shared', 'harness layer keeps base keys')
assert.deepEqual(layers.harnessKeys.sort(), ['autoInject', 'injectTimeoutMs'])

const envLayers = effectiveConfig(readConfigFile().config, { env: { HINDSIGHT_AUTO_INJECT: 'reflect', HINDSIGHT_INJECT_TIMEOUT_MS: '1234' } })
assert.equal(envLayers.config.autoInject, 'recall', 'file and harness win over env')
assert.equal(envLayers.config.injectTimeoutMs, 4000)
assert.equal(envLayers.envKeys.length, 2)

const baseOnly = effectiveConfig({ autoInject: 'pages', harnesses: { dsh: { autoInject: 'recall' } } }, { env: { HINDSIGHT_AUTO_INJECT: 'reflect' } })
assert.equal(baseOnly.config.autoInject, 'recall', 'cumulative precedence')

const mapped = bankResolution(readConfigFile().config, 'repo', 'C:\\work\\shared-repo\\sub')
assert.equal(mapped.bank, 'coding-agent::shared')
assert.equal(mapped.source, 'mapPathToBank')
const staticBank = bankResolution({ bankId: 'coding-agent::fixed' }, 'repo', '/tmp/repo')
assert.equal(staticBank.bank, 'coding-agent::fixed')
assert.equal(staticBank.source, 'bankId')
const templated = bankResolution({}, 'repo', '/tmp/repo')
assert.equal(templated.bank, 'coding-agent::repo')
assert.equal(templated.source, 'bankIdTemplate')

// --- plugin surface: hooks, tool, command ----------------------------------
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
  apiUrl: 'http://127.0.0.1:9',
  observationScopes: 'shared',
  harnesses: { dsh: { autoInject: 'recall' } },
}, null, 2))
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, '')

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
    inject(services, callback) {
      if (services.includes('tools')) {
        callback({ tools: { register(definition) { harness.tools.push(definition) } } })
      }
      if (services.includes('commands')) {
        callback({ commands: { register(definition) { harness.commands.push(definition); return () => {} } } })
      }
      return () => {}
    },
  }
  return harness
}

/** Simulate Cordis' waterfall: array order, each listener wrapping the next. */
function waterfall(harness, event, payload, inner) {
  const list = [...(harness.handlers.get(event) ?? [])]
  const run = (index) => (index >= list.length ? inner() : list[index].handler(payload, () => run(index + 1)))
  return run(0)
}

const { apply } = await import('../index.js')
const harness = makeHarness()
apply(harness.ctx, { autoTune: true, maxInjectTokens: 600, recallMaxTokens: 2500 })

const tool = harness.tools.find((candidate) => candidate.name === 'hindsight_tuner')
assert.ok(tool, 'registers the tool')
assert.ok(harness.commands.some((command) => command.name === 'hindsight'), 'registers the command')
assert.ok(harness.handlers.get('agent/pre-step')[0].prepend, 'registers as an outermost hook')

const sessionStart = harness.handlers.get('agent/session-start')
assert.equal(sessionStart.length, 1)
sessionStart[0].handler({ agent: { session: { header: { origin: 'main' } } } })
await new Promise((done) => setTimeout(done, 100))

const tuned = readConfigFile()
assert.equal(tuned.config.autoInject, 'pages', 'session start fills missing keys')
assert.equal(tuned.config.observationScopes, 'shared', 'does not overwrite the user value')
assert.equal(tuned.config.recallOptions.max_tokens, 2500)

const big = long.repeat(3)
const recallMessage = {
  id: 'recall',
  role: 'user',
  source: { kind: 'plugin:hindsight', form: 'recall' },
  content: [{ type: 'text', text: big }],
}
const human = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }

// P0-1: an upstream plugin that registered later must still be wrapped. It is
// appended after `next()`, exactly like the Hindsight integration.
const lateHarness = makeHarness()
apply(lateHarness.ctx, { autoTune: false, maxInjectTokens: 500 })
lateHarness.ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  return { ...decision, messages: [...decision.messages, { ...recallMessage, id: 'late-recall' }] }
}, { prepend: true })
lateHarness.handlers.get('agent/session-start')[0].handler({ agent: { session: { header: { origin: 'main' } } } })
await new Promise((done) => setTimeout(done, 50))

const wrapped = await waterfall(lateHarness, 'agent/pre-step', { agent: { session: { header: { id: 'ordered' } } } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
assert.equal(wrapped.messages.length, 2, 'the late recall message survives')
assert.ok(estimateTokens(wrapped.messages[1].content[0].text) <= 500, 'outermost tuner capped a later registrar')
assert.ok(wrapped.messages[1].content[0].text.includes('dsh-hindsight-tuner: cut from'), 'the cut marker is present')

let recallSequence = 0
const next = async () => {
  recallSequence += 1
  return {
    kind: 'enter',
    messages: [human, { ...recallMessage, id: `recall-${recallSequence}` }],
  }
}

const preStepPayload = { agent: { session: { header: { id: 'session-1' } } } }
const first = await waterfall(harness, 'agent/pre-step', preStepPayload, next)
const firstText = first.messages.find((message) => message.source?.kind === 'plugin:hindsight').content[0].text
assert.ok(firstText.includes('dsh-hindsight-tuner: cut from'), 'marks the cut')
assert.ok(estimateTokens(firstText) <= 600, `cap honoured: ${estimateTokens(firstText)}`)
assert.equal(first.messages.length, 2)

// Same raw recall again: it is still trimmed, never re-injected untrimmed.
const second = await waterfall(harness, 'agent/pre-step', preStepPayload, next)
assert.equal(second.messages.length, 2, 'repeat recall is kept, not dropped')
assert.ok(estimateTokens(second.messages[1].content[0].text) <= 600, 'repeat is trimmed to the same ceiling')

// Two matching messages share one turn budget.
const twin = await waterfall(harness, 'agent/pre-step', { agent: { session: { header: { id: 'twins' } } } }, async () => ({
  kind: 'enter',
  messages: [
    human,
    { ...recallMessage, id: 'r1', content: [{ type: 'text', text: big }] },
    { ...recallMessage, id: 'r2', content: [{ type: 'text', text: big }] },
  ],
}))
const twinTokens = twin.messages
  .filter((message) => message.source?.kind === 'plugin:hindsight')
  .reduce((sum, message) => sum + estimateTokens(message.content[0].text), 0)
assert.ok(twinTokens <= 600, `two messages share the cap: ${twinTokens}`)

// A cap that cannot fit even a marker drops the message instead of exceeding it.
const tinyHarness = makeHarness()
apply(tinyHarness.ctx, { autoTune: false, maxInjectTokens: 3 })
const tiny = await waterfall(tinyHarness, 'agent/pre-step', { agent: { session: { header: { id: 'tiny' } } } }, async () => ({
  kind: 'enter',
  messages: [human, { ...recallMessage, id: 'tiny-recall', content: [{ type: 'text', text: big }] }],
}))
assert.equal(tiny.messages.length, 1, 'unfittable message is dropped')

// Under the cap: untouched.
const small = { ...recallMessage, id: 'recall-small', content: [{ type: 'text', text: 'short recall' }] }
const under = await waterfall(harness, 'agent/pre-step', { agent: { session: { header: { id: 'under' } } } }, async () => ({ kind: 'enter', messages: [small] }))
assert.equal(under.messages[0].content[0].text, 'short recall')

// A recall that carries images keeps them; only its text is trimmed.
const withImage = {
  ...recallMessage,
  id: 'recall-image',
  content: [
    { type: 'text', text: big },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ],
}
const imageResult = await waterfall(harness, 'agent/pre-step', { agent: { session: { header: { id: 'image-session' } } } }, async () => ({ kind: 'enter', messages: [withImage] }))
assert.ok(imageResult.messages[0].content.some((block) => block.type === 'image'), 'keeps non-text blocks')
assert.ok(imageResult.messages[0].content[0].text.length < big.length, 'trims only the text block')

// --- status, tool and command ----------------------------------------------
const exec = { agent: { session: { header: { id: 'session-1', cwd: process.cwd() } } } }
const status = await tool.execute({ action: 'status' }, exec)
assert.match(status, /Hindsight memory —/)
assert.match(status, /127\.0\.0\.1:9/)
assert.match(status, /unreachable/)
assert.match(status, /drift\s+observationScopes shared ≠ per_source/)
assert.match(status, /layers\s+overrides autoInject=recall/, 'harness override is surfaced')
assert.ok(status.includes('dsh-mnemon 0.5.45'), 'lists a stacked memory bundle')
assert.ok(status.includes('dsh-context 0.84.1 (disabled)'), 'marks a declared but inactive bundle')
assert.match(status, /plugin:hindsight \d+ turns/, 'counts Hindsight turns')
assert.match(status, /recall\s+2 turns/, 'per-session recall accounting')
assert.match(status, /budget\s+cap 600 tok\/turn · capped \d+ · dropped 0/)
assert.match(status, /order\s+outermost hook/)
assert.match(status, /pages\s+pageSearchLimit=/)

// A second memory plugin injecting on the same turn is visible and flagged.
const mnemonMessage = {
  id: 'mnemon-1',
  role: 'user',
  source: { kind: 'plugin:dsh-mnemon', form: 'recall' },
  content: [{ type: 'text', text: 'mnemon recall' }],
}
await waterfall(harness, 'agent/pre-step', { agent: { session: { header: { id: 'stacked' } } } }, async () => ({
  kind: 'enter',
  messages: [human, mnemonMessage, small],
}))
const stacked = await tool.execute({ action: 'status' }, exec)
assert.ok(stacked.includes('plugin:dsh-mnemon 1 turns'), 'counts another plugin source')
assert.match(stacked, /stack\s+more than one plugin injects/)

// Different turns with different plugins are not a stack.
const separate = makeHarness()
apply(separate.ctx, { autoTune: false, maxInjectTokens: 0 })
await waterfall(separate, 'agent/pre-step', { agent: { session: { header: { id: 'sep' } } } }, async () => ({ kind: 'enter', messages: [mnemonMessage] }))
await waterfall(separate, 'agent/pre-step', { agent: { session: { header: { id: 'sep' } } } }, async () => ({ kind: 'enter', messages: [human, small] }))
const separateStatus = await separate.tools[0].execute({ action: 'status' }, exec)
assert.doesNotMatch(separateStatus, /stack\s+more than one plugin/)

// Writes from a tool call need confirm: true; previews and commands do not.
assert.match(await tool.execute({ action: 'tune', dryRun: true }, exec), /Would tune/, 'previews are read-only')
assert.match(await tool.execute({ action: 'tune' }, exec), /Refused/)
assert.match(await tool.execute({ action: 'revert' }, exec), /Refused/)

const commitOutput = await tool.execute({ action: 'tune', confirm: true }, exec)
assert.match(commitOutput, /Tuned/)

const revertOutput = await tool.execute({ action: 'revert', confirm: true }, exec)
assert.match(revertOutput, /Reverted/)

const command = harness.commands.find((candidate) => candidate.name === 'hindsight')
const commandResult = await command.handler({ rawInput: ' status' })
assert.equal(commandResult.kind, 'success')
assert.match(commandResult.text, /Hindsight memory —/)

const diagnosticPath = diagPath()
assert.equal(diagnosticPath, process.env.HINDSIGHT_DIAG_FILE, 'journal override is honoured')

// --- hint branches behind a stubbed endpoint --------------------------------
const realFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response('{"detail":"nope"}', { status: 404 })
  assert.match(await tool.execute({ action: 'status' }, exec), /bank does not exist yet/)

  globalThis.fetch = async () => new Response('', { status: 429 })
  assert.match(await tool.execute({ action: 'status' }, exec), /rate-limited/)

  globalThis.fetch = async () => new Response('', { status: 503 })
  assert.match(await tool.execute({ action: 'status' }, exec), /server reported 503/)
} finally {
  globalThis.fetch = realFetch
}

// --- cap off: still counts, never rewrites ---------------------------------
const zero = makeHarness()
apply(zero.ctx, { autoTune: false, maxInjectTokens: 0 })
const untouched = await waterfall(zero, 'agent/pre-step', { agent: { session: { header: { id: 'zero' } } } }, next)
assert.equal(untouched.messages[1].content[0].text, big, 'cap 0 leaves the recall alone')
const zeroStatus = await zero.tools[0].execute({ action: 'status' }, { agent: { session: { header: { id: 'zero' } } } })
assert.match(zeroStatus, /recall\s+1 turns/)
assert.match(zeroStatus, /cap off/)

// --- memory layer absent ----------------------------------------------------
const savedProfileDir = process.env.DSH_PROFILE_DIR
process.env.DSH_PROFILE_DIR = join(scratch, 'profile-without-integration')
try {
  const missing = await tool.execute({ action: 'status' }, exec)
  assert.match(missing, /memory layer not installed/)
  assert.match(missing, /probe\s+not checked/)
  assert.match(await tool.execute({ action: 'probe' }, exec), /not installed/)
} finally {
  process.env.DSH_PROFILE_DIR = savedProfileDir
}

for (const dispose of harness.disposers) dispose()
for (const dispose of zero.disposers) dispose()
for (const dispose of lateHarness.disposers) dispose()
for (const dispose of tinyHarness.disposers) dispose()
for (const dispose of separate.disposers) dispose()
console.log('smoke: all checks passed')
