import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const scratch = resolve(root, '..', '..', '.tmp-hindsight-tuner')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.HINDSIGHT_CONFIG = join(scratch, 'coding-agent.json')

const { estimateTokens, truncateToBudget } = await import('../lib/tokens.js')
const { applyTuning, revertTuning, readConfigFile, getPath } = await import('../lib/config-file.js')

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

// --- plugin surface: hooks, tool, command ----------------------------------
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
  apiUrl: 'http://127.0.0.1:9',
  observationScopes: 'shared',
}, null, 2))

const handlers = new Map()
const tools = []
const commands = []
const disposers = []

const ctx = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {}
  },
  effect(factory) {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  inject(services, callback) {
    if (services.includes('tools')) {
      callback({ tools: { register(definition) { tools.push(definition) } } })
    }
    if (services.includes('commands')) {
      callback({ commands: { register(definition) { commands.push(definition); return () => {} } } })
    }
    return () => {}
  },
}

const { apply } = await import('../index.js')
apply(ctx, { autoTune: true, maxInjectTokens: 600, recallMaxTokens: 2500 })

assert.ok(tools.some((tool) => tool.name === 'hindsight_tuner'), 'registers the tool')
assert.ok(commands.some((command) => command.name === 'hindsight'), 'registers the command')

const sessionStart = handlers.get('agent/session-start')
assert.ok(sessionStart?.length === 1)
sessionStart[0]({ agent: { session: { header: { origin: 'main' } } } })
await new Promise((done) => setTimeout(done, 100))

const tuned = readConfigFile()
assert.equal(tuned.config.autoInject, 'pages', 'session start fills missing keys')
assert.equal(tuned.config.autoInject, 'pages')
assert.equal(tuned.config.observationScopes, 'shared', 'does not overwrite the user value')
assert.equal(tuned.config.recallOptions.max_tokens, 2500)

const preStep = handlers.get('agent/pre-step')[0]
const big = long.repeat(3)
const recallMessage = {
  id: 'recall',
  role: 'user',
  source: { kind: 'plugin:hindsight', form: 'recall' },
  content: [{ type: 'text', text: big }],
}
const human = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }
const next = async () => ({ kind: 'enter', messages: [human, recallMessage] })

const first = await preStep({ agent: { session: { header: { id: 'session-1' } } } }, next)
const firstRecall = first.messages.find((message) => message.source?.kind === 'plugin:hindsight')
const firstText = firstRecall.content[0].text
assert.ok(firstText.includes('dsh-hindsight-tuner: cut from'), 'marks the cut')
assert.ok(estimateTokens(firstText) <= 600, `cap honoured: ${estimateTokens(firstText)}`)
assert.equal(first.messages.length, 2)

// Same raw recall again: the integration would re-inject it because our trimmed
// message no longer matches. We drop the duplicate instead.
const second = await preStep({ agent: { session: { header: { id: 'session-1' } } } }, next)
assert.equal(second.messages.length, 1, 'duplicate recall is dropped')
assert.equal(second.messages[0].id, 'human')

// A different session is independent.
const otherSession = await preStep({ agent: { session: { header: { id: 'session-2' } } } }, next)
assert.equal(otherSession.messages.length, 2)

// Under the cap: untouched.
const small = { ...recallMessage, content: [{ type: 'text', text: 'short recall' }] }
const under = await preStep({}, async () => ({ kind: 'enter', messages: [small] }))
assert.equal(under.messages[0].content[0].text, 'short recall')

// The tool and the command share one implementation.
const tool = tools.find((candidate) => candidate.name === 'hindsight_tuner')
const status = await tool.execute({ action: 'status' })
assert.match(status, /Hindsight memory —/)
assert.match(status, /127\.0\.0\.1:9/)
assert.match(status, /unreachable/)
assert.match(status, /budget\s+cap 600 tok\/turn/)

const preview = await tool.execute({ action: 'tune', dryRun: true })
assert.match(preview, /Would tune/)

const revertOutput = await tool.execute({ action: 'revert' })
assert.match(revertOutput, /Reverted/)

const command = commands.find((candidate) => candidate.name === 'hindsight')
const commandResult = await command.handler({ rawInput: ' status' })
assert.equal(commandResult.kind, 'success')
assert.match(commandResult.text, /Hindsight memory —/)

for (const dispose of disposers) dispose()
rmSync(scratch, { recursive: true, force: true })
console.log('smoke: all checks passed')
