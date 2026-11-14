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
writeFileSync(join(fakeIntegration, 'package.json'), '{"name":"@vectorize-io/hindsight-coding-agents","version":"0.8.7"}')
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

const { estimateTokens, truncateToBudget, trimToBudget, allocateBudget, countTokens, percentile, FALLBACK_MARGIN } = await import('../lib/tokens.js')
const { applyTuning, revertTuning, readConfigFile, getPath, autoTuneEnabled, setAutoTune } = await import('../lib/config-file.js')
const { bankResolution, diagPath, effectiveConfig, optedOut } = await import('../lib/diagnostics.js')

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

// Water-filling, not a proportional cut: a message that fits an equal share
// keeps all of its content, and only the large message takes the remainder.
assert.deepEqual(allocateBudget([10, 300], 200), [10, 190], 'small recall stays whole')
assert.deepEqual(allocateBudget([50, 50, 300], 200), [50, 50, 100], 'the largest message absorbs the remainder')
assert.deepEqual(allocateBudget([100, 100, 100], 600), [100, 100, 100], 'no cut needed under the cap')
assert.equal(allocateBudget([], 600).length, 0)

// Recall is markdown: a cut must not split a code fence, and should land on a
// paragraph boundary rather than at an arbitrary character.
const fencePrefix = `## Summary
Short memory paragraph that must survive.

\`\`\`js
${Array.from({ length: 20 }, (_, index) => `const step${index} = run(${index})`).join('\n')}
\`\`\`
`
const fenceTail = `\n${Array.from({ length: 300 }, (_, index) => `- detail ${index} 这是很长的后续内容用来抢占预算`).join('\n')}`
const structured = fencePrefix + fenceTail
const fenceCap = estimateTokens(fencePrefix) + 30
const structuredTrim = trimToBudget(structured, fenceCap, '\n…[cut]')
assert.ok(estimateTokens(structuredTrim) <= fenceCap, 'structured trim holds the cap')
assert.ok(structuredTrim.startsWith('## Summary'), 'keeps the summary section')
assert.ok(structuredTrim.endsWith('```\n…[cut]'), `cut after the closed fence, got: ${JSON.stringify(structuredTrim.slice(-40))}`)
assert.equal(structuredTrim.split('```').length % 2, 1, 'every fence is closed')

// No boundary at all (one huge paragraph) still falls back to the character cut.
const noBoundary = 'x'.repeat(4000)
const noBoundaryTrim = trimToBudget(noBoundary, 100, '\n…[cut]')
assert.ok(estimateTokens(noBoundaryTrim) <= 100, 'fallback still holds the cap')
assert.ok(noBoundaryTrim.endsWith('…[cut]'))

// The fast path stays a documented estimate; accurate mode either uses the
// installed tokenizer or says it fell back instead of pretending to be exact.
const sample = '中文 mixed with ascii text'
assert.deepEqual(countTokens(sample, { mode: 'fast' }), { tokens: estimateTokens(sample), mode: 'fast', exact: true })
const fallback = countTokens(sample, { mode: 'accurate' })
assert.equal(fallback.exact, false, 'no tokenizer installed -> estimate, not exact')
assert.equal(fallback.tokens, Math.ceil(estimateTokens(sample) * FALLBACK_MARGIN), 'fallback carries the safety margin')
const exactCounter = countTokens('abcdef', { mode: 'accurate', encode: (text) => text.length })
assert.deepEqual(exactCounter, { tokens: 6, mode: 'accurate', exact: true }, 'an encoder is used when present')
assert.equal(countTokens('', { mode: 'accurate' }).tokens, 0)
assert.equal(percentile([3, 1, 4, 2], 50), 2)
assert.equal(percentile([3, 1, 4, 2], 95), 4)
assert.equal(percentile([], 50), null, 'no samples -> no percentile')

// Trimming honours whatever counter the caller supplies, so the accurate path
// and the fast path enforce the same ceiling with their own measurement.
const latinLong = 'word '.repeat(400)
const latinCount = (text) => Math.ceil(text.length / 4)
const latinTrimmed = truncateToBudget(latinLong, 100, '\n…', latinCount)
assert.ok(latinCount(latinTrimmed) <= 100, 'custom counter governs the cut')

// --- config validation ------------------------------------------------------
const { validateConfig, validateSettings } = await import('../lib/validate.js')

const badSettings = validateSettings({
  autoInject: 'sometime',
  injectTimeoutMs: 10,
  observationScopes: 'shared',
  recallMaxTokens: 3000,
  maxInjectTokens: -1,
  sourceKind: 'hindsight',
  tokenBudgetMode: 'fuzzy',
})
assert.deepEqual(badSettings.preset, [['observationScopes', 'shared'], ['recallOptions.max_tokens', 3000]], 'invalid settings never reach the preset')
assert.deepEqual(badSettings.issues.map((issue) => issue.field).sort(), ['autoInject', 'injectTimeoutMs', 'maxInjectTokens', 'sourceKind', 'tokenBudgetMode'])

const fileIssues = validateConfig({
  autoInject: 'sometime',
  serverMode: 'remote-ish',
  apiPort: 0,
  pageSearchLimit: 0,
  recallOptions: { max_tokens: 2 },
  banks: { anything: { free: 'form' } },
  paths: { 'C:/work': { autoInject: 'pages' } },
})
assert.deepEqual(fileIssues.map((issue) => issue.path).sort(), ['apiPort', 'autoInject', 'pageSearchLimit', 'recallOptions.max_tokens', 'serverMode'], 'free-form maps are not judged')
assert.deepEqual(validateConfig({ autoInject: 'pages' }), [], 'valid config has no issues')
// Upstream also accepts the explicit form, and has no hard cap on these numbers.
assert.deepEqual(validateConfig({ observationScopes: [['per_source'], ['shared']], seedLimit: 10000, pageSearchLimit: 500 }), [], 'list-form scopes and large limits are valid')
assert.deepEqual(validateConfig({ observationScopes: [] }).map((issue) => issue.path), ['observationScopes'], 'an empty scope list would silently fall back')
assert.deepEqual(validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: [['per_source']], recallMaxTokens: 2000, maxInjectTokens: 0, sourceKind: 'plugin:x', tokenBudgetMode: 'fast' }).issues, [], 'settings accept the list form and cap 0')
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'adaptive', budgetTiers: { light: 600, normal: 900, deep: 1200 } }).issues,
  [],
  'an ordered adaptive tier table is valid',
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'adaptive', budgetTiers: { light: 900, normal: 800, deep: 1200 } }).issues.map((issue) => issue.field),
  ['budgetTiers'],
  'out-of-order tiers would make the ceiling jump',
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'adaptive', budgetTiers: { light: 0, normal: 800, deep: 1200 } }).issues.map((issue) => issue.field),
  ['budgetTiers'],
  'a zero tier would silently disable the ceiling',
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'sometimes' }).issues.map((issue) => issue.field),
  ['budgetPolicy'],
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', repeatPolicy: 'sometimes' }).issues.map((issue) => issue.field),
  ['repeatPolicy'],
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', repeatPolicy: 'skip', repeatThreshold: 1.2 }).issues.map((issue) => issue.field),
  ['repeatThreshold'],
)

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
const mapRoot = join(scratch, 'shared-repo')
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
  autoInject: 'pages',
  observationScopes: 'shared',
  bankIdTemplate: 'coding-agent::{gitProject}',
  mapPathToBank: { [mapRoot]: 'coding-agent::shared' },
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

const mapped = bankResolution(readConfigFile().config, 'repo', join(mapRoot, 'sub'))
assert.equal(mapped.bank, 'coding-agent::shared')
assert.equal(mapped.source, 'mapPathToBank')
const staticBank = bankResolution({ bankId: 'coding-agent::fixed' }, 'repo', '/tmp/repo')
assert.equal(staticBank.bank, 'coding-agent::fixed')
assert.equal(staticBank.source, 'bankId')
const templated = bankResolution({}, 'repo', '/tmp/repo')
assert.equal(templated.bank, 'coding-agent::repo')
assert.equal(templated.source, 'bankIdTemplate')

// `paths`/`banks` sections are the integration's per-directory override, and a
// banks section may rename the bank itself.
const sectionConfig = {
  autoInject: 'pages',
  paths: { [mapRoot]: { autoInject: 'recall', pageSearchLimit: 4 } },
  banks: { 'coding-agent::repo': { observationScopes: 'per_source', bank: 'coding-agent::forced' } },
}
const sectioned = effectiveConfig(sectionConfig, { env: {}, cwd: join(mapRoot, 'sub'), bank: 'coding-agent::repo' })
assert.equal(sectioned.config.autoInject, 'recall', 'paths section wins over the base')
assert.equal(sectioned.config.pageSearchLimit, 4)
assert.equal(sectioned.config.observationScopes, 'per_source', 'banks section applies too')
assert.deepEqual(sectioned.sections, [`paths.${mapRoot}`, 'banks.coding-agent::repo'])
const renamed = bankResolution(sectionConfig, 'repo', join(scratch, 'elsewhere'))
assert.equal(renamed.bank, 'coding-agent::forced', 'banks.<id>.bank renames the bank')
assert.equal(renamed.source, 'bankSection')
assert.equal(renamed.base, 'coding-agent::repo')
assert.equal(optedOut({ optInOnly: true, optInPaths: [join(scratch, 'elsewhere')] }, mapRoot), true, 'opt-in excludes other directories')
assert.equal(optedOut({ optInOnly: true, optInPaths: [mapRoot] }, join(mapRoot, 'sub')), false)
assert.equal(optedOut({ optInOnly: true, mapPathToBank: { [mapRoot]: 'coding-agent::shared' } }, mapRoot), false, 'a mapped path counts as opted in')

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

// A reverted profile stays reverted across processes until enabled again.
assert.equal(autoTuneEnabled(), false, 'revert persists an opt-out')
setAutoTune(true)
assert.equal(autoTuneEnabled(), true)

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
assert.match(status, /layers\s+.*overrides autoInject=recall/, 'harness override is surfaced')
assert.ok(status.includes('dsh-mnemon 0.5.45'), 'lists a stacked memory bundle')
assert.ok(status.includes('dsh-context 0.84.1 (disabled)'), 'marks a declared but inactive bundle')
assert.match(status, /plugin:hindsight \d+ turns/, 'counts Hindsight turns')
assert.match(status, /recall\s+2 turns/, 'per-session recall accounting')
assert.match(status, /budget\s+cap 600 tok\/turn · capped \d+ · dropped 0/)
assert.match(status, /order\s+outermost hook/)
assert.match(status, /pages\s+pageSearchLimit=/)

// The same status is available as data, so a user or a script need not parse prose.
const statusJson = await tool.execute({ action: 'status', json: true }, exec)
const parsed = JSON.parse(statusJson)
assert.equal(parsed.server.apiUrl, 'http://127.0.0.1:9', 'JSON status carries the resolved server')
assert.equal('token' in parsed.server, false, 'JSON status never embeds the token itself')
assert.ok(parsed.tokenSource === undefined || typeof parsed.tokenSource === 'string')
assert.equal(typeof parsed.activity.foreignFailures, 'number', 'JSON status reports foreign failures')
assert.equal(parsed.stale, null, 'no stale process without a recent failure')
const integrationBundle = parsed.bundles.find((bundle) => bundle.name === '@vectorize-io/hindsight-coding-agents')
assert.ok(integrationBundle, 'JSON status lists the integration bundle')
assert.equal(integrationBundle.installed, true, 'JSON status resolves installed versions from node_modules')
assert.equal(parsed.compat.compatible, true)
assert.equal(parsed.budget.cap, 600)
assert.equal((await tool.execute({ action: 'probe', json: true }, exec)).includes('json is only valid with status'), true)
assert.match(status, /tier off/, 'the default policy is the single hard ceiling')

// --- adaptive tiers --------------------------------------------------------
// The tier table can only lower the hard cap, and each choice carries a reason
// that status prints, so the policy is auditable rather than magic.
const adaptive = makeHarness()
apply(adaptive.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'adaptive',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
})
const adaptiveTool = adaptive.tools.find((candidate) => candidate.name === 'hindsight_tuner')
const adaptiveExec = { agent: { session: { header: { id: 'adaptive', cwd: process.cwd() } } } }
const adaptiveRecall = (id, text) => ({
  id,
  role: 'user',
  source: { kind: 'plugin:hindsight', form: 'recall' },
  content: [{ type: 'text', text }],
})
const adaptiveTurn = (id, text) => waterfall(adaptive, 'agent/pre-step', { agent: { session: { header: { id: 'adaptive' } } } }, async () => ({
  kind: 'enter',
  messages: [human, adaptiveRecall(id, text)],
}))
const injectedText = (result) => result.messages.find((message) => message.source?.kind === 'plugin:hindsight').content[0].text

const deepTurn = await adaptiveTurn('deep', big)
assert.ok(estimateTokens(injectedText(deepTurn)) <= 400, 'first recall uses the deep ceiling, not the cap')
let adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.equal(adaptiveStatus.budget.policy, 'adaptive')
assert.equal(adaptiveStatus.budget.tier.name, 'deep')
assert.match(adaptiveStatus.budget.tier.reason, /first recall/, 'the first turn says why it is deep')
assert.equal(adaptiveStatus.budget.tierCounts.deep, 1)
assert.equal(adaptiveStatus.budget.session.tier, 'deep')
assert.match(await adaptiveTool.execute({ action: 'status' }, adaptiveExec), /adaptive 100\/200\/400 .*last deep 400/)

const repeatTurn = await adaptiveTurn('repeat', big)
assert.ok(estimateTokens(injectedText(repeatTurn)) <= 100, 'a repeated recall drops to the light ceiling')
adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.equal(adaptiveStatus.budget.tier.name, 'light')
assert.match(adaptiveStatus.budget.tier.reason, /repeats the previous one/)

const afterCutTurn = await adaptiveTurn('fresh', long.toUpperCase().repeat(3))
assert.ok(estimateTokens(injectedText(afterCutTurn)) <= 100, 'a turn after a cut stays on the light ceiling')
adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.match(adaptiveStatus.budget.tier.reason, /previous recall had to be cut/)

// A tier can never raise the hard cap.
const tight = makeHarness()
apply(tight.ctx, {
  autoTune: false,
  maxInjectTokens: 150,
  budgetPolicy: 'adaptive',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
})
const tightTurn = await waterfall(tight, 'agent/pre-step', { agent: { session: { header: { id: 'tight' } } } }, async () => ({
  kind: 'enter',
  messages: [human, adaptiveRecall('tight', big)],
}))
assert.ok(estimateTokens(injectedText(tightTurn)) <= 150, 'the configured cap still bounds a higher tier')
for (const dispose of adaptive.disposers) dispose()
for (const dispose of tight.disposers) dispose()

// --- duplicate governance ---------------------------------------------------
// A recall the model already received last turn is not re-sent; the earlier
// message is still in the conversation, so only the duplicate is removed.
const skipping = makeHarness()
apply(skipping.ctx, { autoTune: false, maxInjectTokens: 600, repeatPolicy: 'skip', repeatThreshold: 0.9 })
const skipExec = { agent: { session: { header: { id: 'skip', cwd: process.cwd() } } } }
const skipTurn = (id, text) => waterfall(skipping, 'agent/pre-step', { agent: { session: { header: { id: 'skip' } } } }, async () => ({
  kind: 'enter',
  messages: [human, adaptiveRecall(id, text)],
}))
const firstSkip = await skipTurn('first', big)
assert.equal(firstSkip.messages.length, 2, 'the first recall is injected')
const duplicateSkip = await skipTurn('duplicate', big)
assert.equal(duplicateSkip.messages.length, 1, 'an identical recall is not injected twice')
assert.equal(duplicateSkip.messages.some((message) => message.source?.kind === 'plugin:hindsight'), false)
const skipStatus = JSON.parse(await skipping.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status', json: true }, skipExec))
assert.equal(skipStatus.budget.repeatPolicy, 'skip')
assert.equal(skipStatus.budget.repeatSkips, 1)
assert.ok(skipStatus.budget.savedTokens > 0, 'the skipped payload is accounted as saved')
assert.equal(skipStatus.budget.session.lastInjected, 0, 'a skipped turn injected nothing')
assert.match(await skipping.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, skipExec), /repeat skip ≥90% · skipped 1 \(~\d+ tok saved\)/)
const changedSkip = await skipTurn('changed', long.toUpperCase().repeat(3))
assert.equal(changedSkip.messages.length, 2, 'a different recall is still injected')
for (const dispose of skipping.disposers) dispose()

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

// Agent writes are off by default and there is no `confirm` flag to self-approve
// with: only the user-typed command or an explicit allowAgentWrites setting writes.
assert.match(await tool.execute({ action: 'tune', dryRun: true }, exec), /Would tune/, 'previews are read-only')
assert.match(await tool.execute({ action: 'tune' }, exec), /Refused/, 'tool cannot tune without allowAgentWrites')
assert.match(await tool.execute({ action: 'revert' }, exec), /Refused/, 'tool cannot revert without allowAgentWrites')
assert.match(await tool.execute({ action: 'enable' }, exec), /Refused/, 'tool cannot flip auto-tune')

const writer = makeHarness()
apply(writer.ctx, { autoTune: false, allowAgentWrites: true, maxInjectTokens: 600 })
const writerTool = writer.tools.find((candidate) => candidate.name === 'hindsight_tuner')
const writerTune = await writerTool.execute({ action: 'tune' }, exec)
assert.match(writerTune, /Tuned/)
assert.equal(autoTuneEnabled(), true, 'an explicit tune re-enables auto-tune')
const writerRevert = await writerTool.execute({ action: 'revert' }, exec)
assert.match(writerRevert, /Reverted/)
assert.match(writerRevert, /auto-tune is now off/)
assert.equal(autoTuneEnabled(), false, 'revert persists an opt-out for new processes')
assert.match(await writerTool.execute({ action: 'disable' }, exec), /Auto-tune disabled/)
assert.match(await writerTool.execute({ action: 'enable' }, exec), /Auto-tune enabled/)
assert.equal(autoTuneEnabled(), true)

const beforePreview = readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8')
const preview = await writerTool.execute({ action: 'tune', dryRun: true }, exec)
assert.match(preview, /Would tune/)
assert.match(preview, /dry run: no file was changed/)
assert.equal(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8'), beforePreview, 'a dry run writes nothing')

const command = harness.commands.find((candidate) => candidate.name === 'hindsight')
const commandResult = await command.handler({ rawInput: ' status' })
assert.equal(commandResult.kind, 'success')
assert.match(commandResult.text, /Hindsight memory —/)
assert.match(commandResult.text, /auto\s+(tune on|off)/, 'status shows the auto-tune state')

// The command is the user's write path, and it takes explicit flags.
const commandJson = await command.handler({ rawInput: ' status --json' })
assert.equal(commandJson.kind, 'success')
assert.equal(JSON.parse(commandJson.text).server.apiUrl, 'http://127.0.0.1:9')
assert.equal((await command.handler({ rawInput: ' probe --json' })).kind, 'error', '--json is a status flag')
const caps = await command.handler({ rawInput: ' tune --cap 400' })
assert.equal(caps.kind, 'success')
assert.match(caps.text, /Tuned/)
const cappedStatus = await tool.execute({ action: 'status' }, exec)
assert.match(cappedStatus, /budget\s+cap 400 tok\/turn/)
assert.equal((await command.handler({ rawInput: ' tune --cap 64001' })).kind, 'error', 'a cap beyond the supported range is rejected')
assert.equal((await command.handler({ rawInput: ' status --dry-run' })).kind, 'error', 'flags are rejected on status')
assert.equal((await command.handler({ rawInput: ' revert --overwrite' })).kind, 'error', '--overwrite is a tune flag')
// A preview must not change the session ceiling either.
const previewCap = await command.handler({ rawInput: ' tune --dry-run --cap 777' })
assert.equal(previewCap.kind, 'success')
assert.match(previewCap.text, /no file was changed/)
assert.match(await tool.execute({ action: 'status' }, exec), /budget\s+cap 400 tok\/turn/, 'dry run leaves the live cap alone')
assert.equal((await command.handler({ rawInput: ' frobnicate' })).kind, 'error', 'unknown actions are rejected')

const suggestion = await tool.execute({ action: 'suggest' }, exec)
assert.match(suggestion, /budget suggestion/)
assert.match(suggestion, /maxInjectTokens: \d+/)
assert.match(suggestion, /recallOptions\.max_tokens: \d+/)
assert.match(suggestion, /Pages and Recall are separate ceilings/)

// The suggestion is fitted to the journal's own injections, not a fixed guess.
const now = new Date().toISOString()
const injectionJournal = [1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600]
  .map((chars) => JSON.stringify({ ts: now, event: 'inject_ok', chars }))
  .join('\n')
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, injectionJournal)
const measured = await tool.execute({ action: 'suggest' }, exec)
assert.match(measured, /observed recall ~\d+ tok p50 · ~\d+ tok p95 \(10 injections, char-based estimate\)/)
assert.match(measured, /maxInjectTokens: 2475/, 'cap follows the p95, clamped')
assert.match(measured, /recallOptions\.max_tokens: 2000/)

// A journal that still fails against another origin means the running process
// predates the config: the effective config alone cannot explain it.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, JSON.stringify({
  ts: now,
  event: 'pages_failed',
  error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Afixture/pages/tree -> 404 (old process)',
}))
const stale = await tool.execute({ action: 'status' }, exec)
assert.match(stale, /process\s+newest journal failure still targets http:\/\/127\.0\.0\.1:9077/, 'stale process is named')
assert.match(stale, /the running DSH loaded the old config; restart it/)
assert.match(stale, /under a minute ago/, 'the stale line says how old the evidence is')
assert.match(stale, /newest journal failure targets http:\/\/127\.0\.0\.1:9077/, 'hint explains the stale process')
assert.match(stale, /Restart DSH/)
assert.match(stale, /1 failures to another server \(old process\)/, 'failures against another origin are counted, not hidden')

// Only recent evidence counts: a failure from twenty minutes ago is history,
// not proof that this process is still misconfigured.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, JSON.stringify({
  ts: new Date(Date.now() - 20 * 60_000).toISOString(),
  event: 'pages_failed',
  error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Afixture/pages/tree -> 404 (old process)',
}))
assert.doesNotMatch(await tool.execute({ action: 'status' }, exec), /process\s+newest journal failure/, 'an old failure is not called stale')

// Another harness writing to the same journal is not this process's problem.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, JSON.stringify({
  ts: now,
  harness: 'claude-code',
  event: 'pages_failed',
  error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Aclaude/pages/tree -> 404',
}))
const foreignOnly = await tool.execute({ action: 'status' }, exec)
assert.doesNotMatch(foreignOnly, /process\s+newest journal failure/, 'another harness failure is ignored')
assert.doesNotMatch(foreignOnly, /failures to another server/, 'another harness failure is not counted as DSH foreign traffic')
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, injectionJournal)

// A config with an invalid value is reported, not silently accepted.
const savedConfig = readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8')
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ autoInject: 'sometime', apiPort: 0, recallOptions: { max_tokens: 2 } }, null, 2))
const diagnosed = await tool.execute({ action: 'status' }, exec)
assert.match(diagnosed, /invalid\s+autoInject="sometime"/, 'invalid effective config is surfaced')
assert.match(diagnosed, /invalid\s+apiPort=0/)
assert.match(diagnosed, /integration falls back/)
assert.match(diagnosed, /compat\s+0\.8\.7 \(tested line 0\.8\.x\)/, 'compat line names the tested integration line')
writeFileSync(process.env.HINDSIGHT_CONFIG, savedConfig)

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

// --- package contract -------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.version, '0.9.0', 'version matches this release')
assert.ok(pkg.engines?.node?.includes('>=22'), 'declares a Node floor the tests can rely on')
assert.equal(pkg.license, 'MIT')
assert.ok(pkg.files.includes('docs'), 'docs ship with the bundle')
assert.ok(pkg.scripts?.test, 'package exposes the test command CI runs')

for (const dispose of harness.disposers) dispose()
for (const dispose of zero.disposers) dispose()
for (const dispose of lateHarness.disposers) dispose()
for (const dispose of tinyHarness.disposers) dispose()
for (const dispose of separate.disposers) dispose()
console.log('smoke: all checks passed')
