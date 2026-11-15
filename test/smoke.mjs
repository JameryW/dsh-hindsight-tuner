import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { waitFor } from './wait.mjs'

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

const { estimateTokens, truncateToBudget, trimToBudget, allocateBudget, countTokens, percentile, FALLBACK_MARGIN, overlapRatio, repetitionRatio } = await import('../lib/tokens.js')
const { applyTuning, revertTuning, readConfigFile, getPath, autoTuneEnabled, setAutoTune, tunerState } = await import('../lib/config-file.js')
const { bankResolution, diagPath, effectiveConfig, effectiveServer, expandBankTemplate, optedOut, projectName, summarizeActivity } = await import('../lib/diagnostics.js')
const { record, flushJournal, journalPending, summarizeTunerJournal } = await import('../lib/log.js')

// --- journal buffering ------------------------------------------------------
record({ event: 'buffered_probe' })
assert.equal(journalPending(), 1, 'a turn event is not written on the critical path')
flushJournal()
assert.equal(journalPending(), 0, 'flush writes the buffer')
assert.match(readFileSync(join(process.env.DSH_HOME, 'storages', 'dsh-hindsight-tuner', 'tuner.jsonl'), 'utf8'), /buffered_probe/, 'the buffered line reaches the journal')

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

// Nested 4-backtick and tilde fences stay whole in trimToBudget.
const nestedFencePrefix = `## Nested Guide
\`\`\`\`md
\`\`\`js
const inner = 'inside nested fence'
\`\`\`
\`\`\`\`
`
const nestedCap = estimateTokens(nestedFencePrefix) + 30
const nestedTrimmed = trimToBudget(nestedFencePrefix + fenceTail, nestedCap, '\n…[cut]')
assert.ok(estimateTokens(nestedTrimmed) <= nestedCap, 'nested fence trim holds cap')
assert.ok(nestedTrimmed.includes("const inner = 'inside nested fence'"), 'keeps inner block')
assert.ok(nestedTrimmed.endsWith('````\n…[cut]'), 'closes at outer 4-backtick fence')

const tildeFencePrefix = `## Tilde Guide
~~~sh
echo first

echo second
~~~
`
const tildeCap = estimateTokens(tildeFencePrefix) + 30
const tildeTrimmed = trimToBudget(tildeFencePrefix + fenceTail, tildeCap, '\n…[cut]')
assert.ok(estimateTokens(tildeTrimmed) <= tildeCap, 'tilde fence trim holds cap')
assert.ok(tildeTrimmed.endsWith('~~~\n…[cut]'), 'closes at tilde fence')

// Orphan line-1 heading leaves nothing to keep and drops cleanly instead of keeping an empty shell.
assert.equal(
  trimToBudget(`# Only a heading line that is too long to fit\n${'body '.repeat(40)}`, 6, '\n…'),
  '',
  'orphan line-1 heading returns empty string',
)

// Non-subadditive custom counter shrink-back invariant.
const nonSubadditive = (text) => (text.includes('a…') ? 999 : text.length)
const weirdInput = `bbbbbb${'a'.repeat(40)}`
const weirdOut = truncateToBudget(weirdInput, 10, '…', nonSubadditive)
assert.ok(nonSubadditive(weirdOut) <= 10, `non-subadditive counter shrinks back cleanly: ${weirdOut}`)
assert.equal(weirdOut, 'bbbbbb…')

// UTF-16 surrogate pairs are never torn apart.
const emojis = '😀'.repeat(100)
for (const emojiCap of [10, 15, 25, 41]) {
  const emojiCut = trimToBudget(emojis, emojiCap, '\n…')
  assert.ok(estimateTokens(emojiCut) <= emojiCap, `emoji cap ${emojiCap} holds`)
  assert.equal(emojiCut.isWellFormed(), true, `emoji cut at cap ${emojiCap} preserves valid surrogate pairs`)
}

// A fallback cut that lands inside an unterminated fence closes the fence: the
// marker must never end up rendered as the last line of a code block.
const openFenceText = `\`\`\`js\r\n${Array.from({ length: 40 }, (_, index) => `const cut${index} = ${index} // long enough to cut through`).join('\r\n')}\r\n\`\`\`\r\n`
for (const fenceFallbackCap of [8, 12, 20]) {
  const fenceFallbackCut = truncateToBudget(openFenceText, fenceFallbackCap, 'M')
  const fenceLines = fenceFallbackCut.split('\n').filter((line) => /^\s*(`{3,}|~{3,})\s*$/.test(line))
  assert.equal(fenceLines.length % 2, 0, `fence fallback at cap ${fenceFallbackCap} leaves no open fence`)
  assert.ok(estimateTokens(fenceFallbackCut) <= fenceFallbackCap, `fence fallback at cap ${fenceFallbackCap} holds the cap`)
}

// Repetition ratio superset asymmetry, CJK weight, and bare fences.
const supersetBase = ['- line one is long enough', '- line two is long enough', '- line three is long enough'].join('\n')
assert.ok(repetitionRatio(supersetBase, `${supersetBase}\n- brand new fourth line here`) < 1, 'superset scores below 1')
assert.equal(overlapRatio('```\n```', '```\n```'), 0, 'bare fences alone carry no substantive lines')
assert.ok(repetitionRatio('- 端口 9077\n- 模式 daemon', '- 端口 9077\n- 模式 daemon') === 1, 'CJK facts count as substantive lines')

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
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'adaptive', budgetTiers: null }).issues.map((issue) => issue.field),
  ['budgetTiers'],
  'null budgetTiers fails cleanly without throwing',
)
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', budgetPolicy: 'adaptive', budgetTiers: [100, 200, 300] }).issues.map((issue) => issue.field),
  ['budgetTiers'],
  'array budgetTiers is rejected',
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
assert.deepEqual(
  validateSettings({ autoInject: 'pages', injectTimeoutMs: 7000, observationScopes: 'shared', recallMaxTokens: 2000, maxInjectTokens: 3000, sourceKind: 'plugin:x', tokenBudgetMode: 'fast', verifyReminder: 'yes' }).issues.map((issue) => issue.field),
  ['verifyReminder'],
  'the trust reminder is a boolean, not a stringly-typed setting',
)
assert.deepEqual(
  validateConfig({
    apiUrl: 'ftp://bad.example',
    optInPaths: [''],
    reflectBudget: 'extreme',
    daemonIdleTimeout: -1,
    retainTags: [123],
  }).map((issue) => issue.path).sort(),
  ['apiUrl', 'daemonIdleTimeout', 'optInPaths', 'reflectBudget', 'retainTags'],
  'expanded config rules flag bad URL, lists, reflectBudget, and idle timeout',
)
assert.deepEqual(
  validateConfig({
    apiUrl: 'https://api.hindsight.vectorize.io',
    optInPaths: ['/tmp/repo'],
    reflectBudget: 'mid',
    daemonIdleTimeout: 600,
    retainTags: ['tag-a'],
  }),
  [],
  'valid expanded config rules pass cleanly',
)
assert.deepEqual(
  validateConfig({
    surveyRefreshCommits: 0,
    injectTimeoutMs: 200000,
    recallOptions: { max_tokens: 100000 },
  }),
  [],
  'values the integration honours are not reported as invalid (0 commits, long timeout, large recall)',
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

// A lock naming a dead process is reclaimed instead of blocking every later
// write, and a lock naming a live one is waited for rather than deleted.
const configLock = `${process.env.HINDSIGHT_CONFIG}.lock`
writeFileSync(configLock, '999999:dead-owner')
const afterDeadLock = applyTuning({ preset: [['injectTimeoutMs', 7000]] })
assert.equal(afterDeadLock.changed.length, 0, 'a dead-owner lock is reclaimed and the write still runs')
assert.equal(existsSync(configLock), false, 'the reclaimed lock is removed after the write')

writeFileSync(configLock, `${process.pid}:held-by-this-process`)
assert.throws(() => applyTuning({ preset }), /another process is editing/, 'a live lock is not deleted')
unlinkSync(configLock)

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

// Nested object cleanup on revert + explicit removed/had journal recovery.
flushJournal()
const savedDshHome = process.env.DSH_HOME
const savedCfgFile = process.env.HINDSIGHT_CONFIG
const cfgIsolated = join(scratch, 'cfg-isolated')
process.env.DSH_HOME = join(cfgIsolated, 'dsh-home')
process.env.HINDSIGHT_CONFIG = join(cfgIsolated, 'coding-agent.json')
try {
  applyTuning({ preset: [['recallOptions.max_tokens', 2500]] })
  assert.equal(readConfigFile().config.recallOptions.max_tokens, 2500)
  revertTuning()
  assert.equal('recallOptions' in readConfigFile().config, false, 'empty parent plain objects are pruned on revert')

  const isoStateDir = join(process.env.DSH_HOME, 'storages', 'dsh-hindsight-tuner')
  mkdirSync(isoStateDir, { recursive: true })
  writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ keptNull: null }, null, 2))
  writeFileSync(join(isoStateDir, 'state.json'), JSON.stringify({
    applied: {
      'recallOptions.max_tokens': { value: 2500, had: false, previous: null },
      keptNull: { value: 'override', had: true, previous: null },
    },
    journal: {
      kind: 'revert',
      startedAt: new Date().toISOString(),
      changes: [
        { path: 'recallOptions.max_tokens', to: null, removed: true },
        { path: 'keptNull', to: null, removed: false },
      ],
    },
  }))
  const afterCrashRevert = revertTuning()
  assert.deepEqual(afterCrashRevert.reverted, [], 'explicit removed=true and had=true null-restore both settle pending state')
  assert.equal(readConfigFile().config.keptNull, null)
} finally {
  process.env.DSH_HOME = savedDshHome
  process.env.HINDSIGHT_CONFIG = savedCfgFile
}

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

const replacedRecall = effectiveConfig({
  recallOptions: { max_tokens: 2000, mode: 'fast' },
  harnesses: { dsh: { recallOptions: { budget: 'low' } } },
}, { env: {} })
assert.deepEqual(
  replacedRecall.config.recallOptions,
  { budget: 'low' },
  'recallOptions is replaced wholesale — upstream mergeRaw deep-merges only banks and paths',
)
assert.deepEqual(
  effectiveConfig({ recallOptions: { max_tokens: 2000 } }, { env: {} }).config.recallOptions,
  { max_tokens: 2000 },
  'a file-only recallOptions survives untouched',
)

const envTokLayers = effectiveConfig({}, { env: { HINDSIGHT_API_TOKEN: 'env-secret' } })
assert.equal(envTokLayers.tokenSource, 'env', 'env tokenSource reported when token comes from env')
assert.equal(effectiveServer(envTokLayers.config, {}, { tokenSource: envTokLayers.tokenSource }).tokenSource, 'env')
const cfgTokLayers = effectiveConfig({ apiToken: 'cfg-secret' }, { env: { HINDSIGHT_API_TOKEN: 'env-secret' } })
assert.equal(cfgTokLayers.tokenSource, 'config', 'config tokenSource wins over env')
assert.equal(effectiveServer(cfgTokLayers.config, {}, { tokenSource: cfgTokLayers.tokenSource }).tokenSource, 'config')

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

// Tilde paths expand consistently across paths, mapPathToBank, and optInPaths.
const tildeSub = join(homedir(), 'dsh-tilde-repo', 'sub')
assert.equal(
  effectiveConfig({ paths: { '~/dsh-tilde-repo': { pageSearchLimit: 9 } } }, { env: {}, cwd: tildeSub }).config.pageSearchLimit,
  9,
  '~/ expands in paths keys',
)
assert.equal(
  bankResolution({ mapPathToBank: { '~/dsh-tilde-repo': 'coding-agent::tilde' } }, 'repo', tildeSub).bank,
  'coding-agent::tilde',
  '~/ expands in mapPathToBank keys',
)
assert.equal(optedOut({ optInOnly: true, optInPaths: ['~/dsh-tilde-repo'] }, tildeSub), false, '~/ expands in optInPaths')

// Environment overrides follow the integration's reader: a blank value is
// skipped, booleans accept only 1/true/yes/on, and an unparsable number is
// dropped rather than passed through as a string.
const strictEnv = effectiveConfig({}, {
  env: {
    HINDSIGHT_AUTO_SEED: 'maybe',
    HINDSIGHT_DISABLED: 'off',
    HINDSIGHT_INJECT_TIMEOUT_MS: ' ',
    HINDSIGHT_PAGE_SEARCH_LIMIT: 'abc',
    HINDSIGHT_RETAIN_TAGS: ' , ',
    HINDSIGHT_MAX_PARALLEL_RETAINS: '3',
  },
})
assert.equal(strictEnv.config.autoSeed, false, 'a boolean override only accepts 1/true/yes/on')
assert.equal(strictEnv.config.disabled, false, 'an unrecognised boolean is false, not a string')
assert.deepEqual(
  strictEnv.envKeys.sort(),
  ['autoSeed', 'disabled', 'maxParallelRetains'],
  'blank, unparsable, and empty-list overrides are skipped',
)
assert.equal(strictEnv.config.maxParallelRetains, 3, 'numeric overrides arrive as numbers')

// Section overrides are stripped of the keys the integration reserves for the
// top-level bank resolution.
const stripped = effectiveConfig({
  paths: { [mapRoot]: { bankId: 'coding-agent::ignored', bankIdTemplate: 'ignored-{project}', autoInject: 'recall' } },
  banks: { 'coding-agent::repo': { bankId: 'coding-agent::ignored-too', bankIdTemplate: 'ignored', observationScopes: 'per_source' } },
}, { env: {}, cwd: join(mapRoot, 'sub'), bank: 'coding-agent::repo' })
assert.equal(stripped.config.bankId, undefined, 'bankId is not inherited from a section')
assert.equal(stripped.config.bankIdTemplate, undefined, 'bankIdTemplate is not inherited from a section')
assert.equal(stripped.config.autoInject, 'recall', 'the rest of the section still applies')

// Endpoint resolution mirrors resolveConfig's whitelist and `||` fallbacks.
const fallbackMode = effectiveServer({ serverMode: 'local', apiPort: 0, apiToken: '' }, {})
assert.equal(fallbackMode.mode, 'cloud', 'an unknown serverMode falls back to cloud')
assert.equal(fallbackMode.apiUrl, 'https://api.hindsight.vectorize.io')
assert.equal(fallbackMode.tokenSet, false)
assert.equal(fallbackMode.token, undefined, 'an empty token resolves to undefined')
const zeroPortDaemon = effectiveServer({ serverMode: 'daemon', apiPort: 0 }, {})
assert.equal(zeroPortDaemon.apiUrl, 'http://127.0.0.1:9077', 'apiPort 0 falls back to 9077 (upstream uses ||)')

// Template resolution: the placeholders and fallbacks documented upstream.
assert.equal(expandBankTemplate('{channel}/{user}', { env: {} }), 'default/anonymous', 'channel and user default when the env is unset')
assert.equal(
  expandBankTemplate('{channel}/{user}', { env: { HINDSIGHT_CHANNEL_ID: 'team', HINDSIGHT_USER_ID: 'jamer' } }),
  'team/jamer',
  'channel and user come from the env when set',
)
assert.equal(expandBankTemplate('{project}/{harness}', { cwd: join(mapRoot, 'sub') }), 'sub/dsh', 'project is the basename and harness is dsh')
assert.equal(expandBankTemplate('{nope}', {}), 'unknown', 'an unknown placeholder substitutes unknown')
assert.equal(bankResolution({ dynamicBankId: false }, 'repo', '/tmp/repo').bank, 'coding', 'a static bank with none configured falls back to coding')

// Bare .git repository strips .git suffix for projectName.
const bareRepo = join(scratch, 'my-bare-project.git')
execFileSync('git', ['init', '--bare', '-q', bareRepo], { stdio: 'ignore', windowsHide: true })
assert.deepEqual(projectName(bareRepo), { name: 'my-bare-project', source: 'git' }, 'bare repo strips .git suffix')

// A `paths` section keyed by the main checkout also applies inside a linked
// worktree, because the integration builds lookupDirectories from the git
// common dir rather than the worktree path.
const wtMain = join(scratch, 'wt-main')
execFileSync('git', ['init', '-q', wtMain], { stdio: 'ignore', windowsHide: true })
writeFileSync(join(wtMain, 'tracked.txt'), 'worktree probe\n')
const gitAuthor = ['-c', 'user.name=Tuner Smoke', '-c', 'user.email=tuner@example.invalid']
execFileSync('git', ['-C', wtMain, ...gitAuthor, 'add', 'tracked.txt'], { stdio: 'ignore', windowsHide: true })
execFileSync('git', ['-C', wtMain, ...gitAuthor, 'commit', '-q', '-m', 'init'], { stdio: 'ignore', windowsHide: true })
const wtLinked = join(scratch, 'wt-linked')
execFileSync('git', ['-C', wtMain, 'worktree', 'add', '-q', wtLinked], { stdio: 'ignore', windowsHide: true })
const wtConfig = { paths: { [wtMain]: { pageSearchLimit: 21 } }, mapPathToBank: { [wtMain]: 'coding-agent::worktree' } }
const fromLinked = effectiveConfig(wtConfig, { env: {}, cwd: wtLinked })
assert.equal(fromLinked.config.pageSearchLimit, 21, 'a paths section keyed by the main checkout applies inside a linked worktree')
assert.deepEqual(fromLinked.sections, [`paths.${wtMain}`])
assert.equal(bankResolution(wtConfig, 'wt-linked', wtLinked).bank, 'coding-agent::worktree', 'mapPathToBank matches the main checkout from a linked worktree')
assert.equal(
  effectiveConfig({ ...wtConfig, resolveWorktrees: false }, { env: {}, cwd: wtLinked }).config.pageSearchLimit,
  undefined,
  'resolveWorktrees: false keeps the section local',
)

// Both sides of a lookup canonicalize, so a directory reached through a symlink
// or junction still matches a section keyed by the real path — the same
// conversion git does when it reports the repository root.
const wtAlias = join(scratch, 'wt-alias')
try {
  symlinkSync(wtMain, wtAlias, 'junction')
  const aliased = effectiveConfig({ paths: { [wtMain]: { pageSearchLimit: 22 } } }, { env: {}, cwd: wtAlias })
  assert.equal(aliased.config.pageSearchLimit, 22, 'a symlinked directory canonicalizes to the path git reports')
} catch (error) {
  // Creating a link needs privileges on some hosts; the worktree case above
  // already covers the lookup, so a denied symlink must not fail the suite.
  if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOTSUP') throw error
}

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
// The schema is the permission boundary: a read-only profile must not offer a
// mutating action at all, or a schema-validating host would pass the model's
// request through. README documents this exact list, so pin it.
assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'probe', 'suggest'], 'the default tool schema only offers read actions')
assert.ok(harness.commands.some((command) => command.name === 'hindsight'), 'registers the command')
assert.ok(harness.handlers.get('agent/pre-step')[0].prepend, 'registers as an outermost hook')

const sessionStart = harness.handlers.get('agent/session-start')
assert.equal(sessionStart.length, 1)
// Auto-tune fills the config inside the handler; poll the file instead of
// sleeping, so the test follows a future async write without guessing a delay.
sessionStart[0].handler({ agent: { session: { header: { origin: 'main' } } } })
await waitFor(() => readConfigFile().config.autoInject === 'pages', { label: 'session-start auto-tune write' })

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
assert.equal(adaptiveStatus.budget.session.capped, 1, 'the session, not just the process, knows it was capped')
assert.equal(adaptiveStatus.budget.session.dropped, 0)
assert.match(await adaptiveTool.execute({ action: 'status' }, adaptiveExec), /capped 1 · skipped 0/, 'the recall line carries per-session caps')
assert.ok(adaptiveStatus.budget.trimmedTokens > 0, 'trimming is accounted as saved tokens')
assert.equal(adaptiveStatus.budget.session.tier, 'deep')
assert.match(await adaptiveTool.execute({ action: 'status' }, adaptiveExec), /adaptive 100\/200\/400 .*last deep 400/)

const repeatTurn = await adaptiveTurn('repeat', big)
assert.ok(estimateTokens(injectedText(repeatTurn)) <= 100, 'a repeated recall drops to the light ceiling')
adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.equal(adaptiveStatus.budget.tier.name, 'light')
assert.match(adaptiveStatus.budget.tier.reason, /repeats what is in context/)

const afterCutTurn = await adaptiveTurn('fresh', long.toUpperCase().repeat(3))
assert.ok(estimateTokens(injectedText(afterCutTurn)) <= 100, 'a turn after a cut stays on the light ceiling')
adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.match(adaptiveStatus.budget.tier.reason, /previous recall had to be cut/)

const stepUpRecall = Array.from({ length: 400 }, (_, index) => `alpha-zeta-${index} unique fact item for cooldown step-up check.`).join('\n')
const stepUpTurn = await adaptiveTurn('recover', stepUpRecall)
assert.ok(estimateTokens(injectedText(stepUpTurn)) <= 200, 'turn after light cooldown steps up to normal ceiling')
adaptiveStatus = JSON.parse(await adaptiveTool.execute({ action: 'status', json: true }, adaptiveExec))
assert.equal(adaptiveStatus.budget.tier.name, 'normal')
assert.match(adaptiveStatus.budget.tier.reason, /stepping back up after a cut/)
assert.equal('cooldown' in adaptiveStatus.budget.tier, false, 'internal cooldown flag is stripped from public status')

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
assert.equal(skipStatus.budget.session.skipped, 1, 'the session counts its own skips')
assert.match(await skipping.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, skipExec), /repeat skip ≥90% · skipped 1/)
const changedSkip = await skipTurn('changed', long.toUpperCase().repeat(3))
assert.equal(changedSkip.messages.length, 2, 'a different recall is still injected')
for (const dispose of skipping.disposers) dispose()

// --- repeat safety ----------------------------------------------------------
// Three failure modes of the old line-overlap rule: new facts lost when a recall
// repeats, history removed because a duplicate arrived, and memory lost after
// the context was compacted. Each case gets its own harness for clean state.
const conventions = Array.from({ length: 12 }, (_, i) => `- convention ${i}: keep diffs small and update the changelog`).join('\n')
const newFact = '- new fact: freeze the bank fingerprint before a benchmark run'
const statusOf = async (harness, sessionId) => JSON.parse(await harness.tools
  .find((candidate) => candidate.name === 'hindsight_tuner')
  .execute({ action: 'status', json: true }, { agent: { session: { header: { id: sessionId, cwd: process.cwd() } } } }))

// (1) A repeated recall that adds facts ships only the delta: neither the new
// facts nor the repeated blocks are misjudged.
const deltaHarness = makeHarness()
apply(deltaHarness.ctx, { autoTune: false, maxInjectTokens: 600, repeatPolicy: 'skip', repeatThreshold: 0.9 })
const deltaTurn = (messages) => waterfall(deltaHarness, 'agent/pre-step', { agent: { session: { header: { id: 'delta' } } } }, async () => ({ kind: 'enter', messages }))
await deltaTurn([human, adaptiveRecall('d1', conventions)])
const delta = await deltaTurn([human, adaptiveRecall('d2', `${conventions}\n\n${newFact}`)])
const deltaText = injectedText(delta)
assert.ok(deltaText.includes('freeze the bank fingerprint'), 'a repeated recall keeps the facts it adds')
assert.ok(deltaText.includes('new-facts delta'), 'the injected copy says it is a delta')
assert.ok(!deltaText.includes('convention 0'), 'blocks the model already has are not paid for twice')
assert.ok(estimateTokens(deltaText) <= 600, 'the delta still fits the cap')
const deltaStatus = await statusOf(deltaHarness, 'delta')
assert.equal(deltaStatus.budget.deltas, 1, 'a delta is not reported as a skipped turn')
assert.equal(deltaStatus.budget.repeatSkips, 0)
assert.ok(deltaStatus.budget.deltaSaved > 0, 'delta savings are recorded')
assert.match(
  await deltaHarness.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, { agent: { session: { header: { id: 'delta' } } } }),
  /deltas 1.*saved ~\d+ tok/,
  'formatSavings surfaces deltaSaved in status',
)
for (const dispose of deltaHarness.disposers) dispose()

// (1b) Dropped recall (after === 0) must not overwrite prior session memory state.
const dropPreserve = makeHarness()
apply(dropPreserve.ctx, { autoTune: false, maxInjectTokens: 30, repeatPolicy: 'skip', repeatThreshold: 0.9 })
const dropPreserveTurn = (messages) => waterfall(dropPreserve, 'agent/pre-step', { agent: { session: { header: { id: 'drop-keep' } } } }, async () => ({ kind: 'enter', messages }))
const firstShort = '- short kept fact that survives drop'
assert.equal((await dropPreserveTurn([human, adaptiveRecall('dk1', firstShort)])).messages.length, 2, 'short turn fits cap=30')
const droppedBig = await dropPreserveTurn([human, adaptiveRecall('dk2', big)])
assert.equal(droppedBig.messages.length, 1, 'oversized turn whose marker cannot fit is dropped')
const stillSkipped = await dropPreserveTurn([human, adaptiveRecall('dk3', firstShort)])
assert.equal(stillSkipped.messages.length, 1, 'dropped middle turn did not clobber lastRaw/lastInjectedText')
for (const dispose of dropPreserve.disposers) dispose()

// (2) History is kept when a duplicate arrives in the same turn; only the copy
// that has never reached the model is removed.
const historyHarness = makeHarness()
apply(historyHarness.ctx, { autoTune: false, maxInjectTokens: 600, repeatPolicy: 'skip', repeatThreshold: 0.9 })
const historyTurn = (messages) => waterfall(historyHarness, 'agent/pre-step', { agent: { session: { header: { id: 'history' } } } }, async () => ({ kind: 'enter', messages }))
await historyTurn([human, adaptiveRecall('h1', conventions)])
const keptHistory = await historyTurn([human, adaptiveRecall('h1', conventions), adaptiveRecall('h2', conventions)])
assert.equal(keptHistory.messages.length, 2, 'only the new duplicate is removed')
assert.ok(keptHistory.messages.some((message) => message.id === 'h1'), 'the recall the model already has is not dropped')
assert.ok(!keptHistory.messages.some((message) => message.id === 'h2'), 'the unseen duplicate is suppressed')
for (const dispose of historyHarness.disposers) dispose()

// (3) Compaction shadowed the recall: re-send it, even when the integration
// suppressed a new injection because its own dedupe scans shadowed events.
// Consecutive compactions do not double-prepend the re-entry banner, and
// reentry trim preserves prefixes (REENTRY_PREFIX + VERIFY_REMINDER).
const compactionHarness = makeHarness()
apply(compactionHarness.ctx, { autoTune: false, maxInjectTokens: 600, repeatPolicy: 'skip', verifyReminder: true })
const logged = []
const compactTurn = (messages) => waterfall(
  compactionHarness,
  'agent/pre-step',
  { agent: { session: { header: { id: 'compact' }, snapshotEvents: () => logged } } },
  async () => ({ kind: 'enter', messages }),
)
await compactTurn([human, adaptiveRecall('c1', conventions)])
logged.push({ type: 'user/message', seq: 2, data: { source: { kind: 'plugin:hindsight' }, content: [{ type: 'text', text: conventions }] } })
const quietTurn = await compactTurn([human])
assert.equal(quietTurn.messages.length, 1, 'without a shadowing event nothing is re-sent')
logged.push({ type: 'compaction/summary', seq: 3, data: { shadowedSeqs: [2] } })
const reentry = await compactTurn([human])
assert.equal(reentry.messages.length, 2, 'memory removed by compaction is re-injected')
const reentryText = injectedText(reentry)
assert.ok(reentryText.startsWith('[dsh-hindsight-tuner: memory re-injected after context compaction]'), 'the re-injection is labelled')
logged.push({ type: 'user/message', seq: 4, data: { source: { kind: 'plugin:hindsight' }, content: [{ type: 'text', text: reentryText }] } })
logged.push({ type: 'compaction/summary', seq: 5, data: { shadowedSeqs: [4] } })
const reentryAgain = await compactTurn([human])
const reentryAgainText = injectedText(reentryAgain)
assert.equal(
  (reentryAgainText.match(/\[dsh-hindsight-tuner: memory re-injected after context compaction\]/g) ?? []).length,
  1,
  'consecutive compactions do not double-prepend REENTRY_PREFIX',
)
assert.equal((reentryAgainText.match(/\[verify:/g) ?? []).length, 1, 'verify reminder stays single across re-entries')
const reentryStatus = await statusOf(compactionHarness, 'compact')
assert.equal(reentryStatus.budget.reentered, 2, 'the re-entries are counted separately from ordinary injections')
assert.match(await compactionHarness.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, { agent: { session: { header: { id: 'compact' } } } }), /re-entered 2/)
for (const dispose of compactionHarness.disposers) dispose()

const tightReentry = makeHarness()
apply(tightReentry.ctx, { autoTune: false, maxInjectTokens: 80, repeatPolicy: 'skip', verifyReminder: true })
const tightLog = []
const tightTurnFn = (messages) => waterfall(
  tightReentry,
  'agent/pre-step',
  { agent: { session: { header: { id: 'tight-re' }, snapshotEvents: () => tightLog } } },
  async () => ({ kind: 'enter', messages }),
)
const seedReentry = Array.from({ length: 12 }, (_, i) => `- item ${i}: detail`).join('\n')
await tightTurnFn([human, adaptiveRecall('tr1', seedReentry)])
tightLog.push({ type: 'user/message', seq: 2, data: { source: { kind: 'plugin:hindsight' }, content: [{ type: 'text', text: seedReentry }] } })
tightLog.push({ type: 'compaction/summary', seq: 3, data: { shadowedSeqs: [2] } })
const cappedReentry = await tightTurnFn([human])
const cappedReentryText = injectedText(cappedReentry)
assert.ok(estimateTokens(cappedReentryText) <= 80, 'trimmed re-entry respects cap')
assert.ok(cappedReentryText.startsWith('[dsh-hindsight-tuner: memory re-injected after context compaction]'), 'reentry trim protects REENTRY_PREFIX')
assert.ok(cappedReentryText.includes('[verify:'), 'reentry trim protects VERIFY_REMINDER')
for (const dispose of tightReentry.disposers) dispose()

// --- budgeted view ----------------------------------------------------------
// Truncation keeps the prefix; the budgeted view spends the same budget on the
// blocks whose evidence matches the task, and labels what it left out.
const viewHarness = makeHarness()
apply(viewHarness.ctx, { autoTune: false, maxInjectTokens: 300, viewPolicy: 'budgeted' })
const viewExec = { agent: { session: { header: { id: 'view', cwd: process.cwd() } } } }
const viewTask = {
  id: 'task',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'Fix the budget accounting in lib/tokens.js so trimToBudget never exceeds the cap; update the recallBudget test.' }],
}
const irrelevant = Array.from({ length: 18 }, (_, i) => `### Unrelated note ${i}\nOld deployment trivia number ${i} about a service that no longer exists in this repository and is not part of this task.`)
const relevant = '### Budget accounting\n- `lib/tokens.js` trimToBudget must never exceed the cap; a `recallBudget` test asserts the boundary (commit 3f8a1c9, path lib/tokens.js).'
const viewTurn = await waterfall(viewHarness, 'agent/pre-step', { agent: { session: { header: { id: 'view' } } } }, async () => ({
  kind: 'enter',
  messages: [viewTask, adaptiveRecall('v1', [...irrelevant.slice(0, 18), relevant].join('\n\n'))],
}))
const viewText = injectedText(viewTurn)
assert.ok(estimateTokens(viewText) <= 300, 'the selected view still fits the hard cap')
assert.ok(viewText.includes('lib/tokens.js'), 'the block matching the task is kept although it was last in the recall')
assert.ok(viewText.includes('budgeted view'), 'the payload says it is a selection, not a truncation')
assert.ok(!viewText.includes('Unrelated note 0'), 'topically unrelated leading blocks are not paid for')
const viewStatus = JSON.parse(await viewHarness.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status', json: true }, viewExec))
assert.equal(viewStatus.budget.viewPolicy, 'budgeted')
assert.equal(viewStatus.budget.viewTurns, 1)
assert.ok(viewStatus.budget.viewKept >= 1 && viewStatus.budget.viewOmitted > 0)

// Without any lexical signal the view falls back to the prefix, still measured.
const plainHarness = makeHarness()
apply(plainHarness.ctx, { autoTune: false, maxInjectTokens: 200, viewPolicy: 'budgeted' })
const plainTurn = await waterfall(plainHarness, 'agent/pre-step', { agent: { session: { header: { id: 'plain' } } } }, async () => ({
  kind: 'enter',
  messages: [human, adaptiveRecall('p1', irrelevant.join('\n\n'))],
}))
const plainText = injectedText(plainTurn)
assert.ok(plainText.startsWith('### Unrelated note 0'), 'with no signal the view keeps the prefix')
// token estimation is already imported at the top of this file
assert.ok(estimateTokens(plainText) <= 200, 'the fallback selection is still measured')
for (const dispose of viewHarness.disposers) dispose()
for (const dispose of plainHarness.disposers) dispose()

// A misspelled policy is reported and falls back, never silently half-applied.
const invalidView = makeHarness()
apply(invalidView.ctx, { autoTune: false, viewPolicy: 'magic' })
const invalidStatus = JSON.parse(await invalidView.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status', json: true }, viewExec))
assert.ok(invalidStatus.settingsIssues.some((issue) => issue.field === 'viewPolicy'), 'an invalid view policy is surfaced')
assert.equal(invalidStatus.budget.viewPolicy, 'truncate', 'an invalid view policy falls back to truncate')
for (const dispose of invalidView.disposers) dispose()

// --- scenario budget (v0.18, opt-in) ---------------------------------------
// The adaptive policy only knows repeat/cut; the scenario policy also reads the
// turn's state and a lexical task signal. Defaults stay off, so every harness
// here opts in explicitly and the assertions cover both the chosen tier and the
// reason status prints for it.
const scenarioHarness = makeHarness()
apply(scenarioHarness.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
})
const scenarioExec = { agent: { session: { header: { id: 'scenario', cwd: process.cwd() } } } }
const scenarioStatus = async (harness = scenarioHarness, id = 'scenario') => JSON.parse(await harness.tools
  .find((candidate) => candidate.name === 'hindsight_tuner')
  .execute({ action: 'status', json: true }, { agent: { session: { header: { id, cwd: process.cwd() } } } }))
const scenarioTurn = (harness, messages, extra = {}) => waterfall(
  harness,
  'agent/pre-step',
  { agent: { session: { header: { id: 'scenario' } } }, ...extra },
  async () => ({ kind: 'enter', messages }),
)
const freshRecall = (id) => adaptiveRecall(id, Array.from({ length: 12 }, (_, i) => `- fact ${i}: the scenario policy reads the journal before choosing a tier`).join('\n'))
const debugPrompt = {
  id: 'u-debug',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: 'Fix the failing view test — error: expected 3, got 2' }],
}

// First recall: nothing is in context, so the deep tier is used even though the
// prompt looks like a debugging turn.
await scenarioTurn(scenarioHarness, [human, adaptiveRecall('s1', conventions)])
const firstStatus = await scenarioStatus()
assert.equal(firstStatus.budget.policy, 'scenario')
assert.equal(firstStatus.budget.lastScenario.scenario, 'first-turn')
assert.equal(firstStatus.budget.tier.name, 'deep', 'a first turn gets the deep ceiling')
assert.equal(firstStatus.budget.tier.budget, 400)

// Second turn: a debugging prompt with step: 1 (DSH turn entry) lands on normal, not continuation.
const debugTurn = await scenarioTurn(scenarioHarness, [debugPrompt, freshRecall('s2')], { step: 1 })
const debugText = injectedText(debugTurn)
assert.ok(estimateTokens(debugText) <= 200, 'the debug scenario honours the normal ceiling')
const debugStatus = await scenarioStatus()
assert.equal(debugStatus.budget.lastScenario.scenario, 'debug', 'the prompt signal picks the scenario')
assert.equal(debugStatus.budget.tier.name, 'normal')
assert.equal(debugStatus.budget.tier.scenario, 'debug')
assert.equal(debugStatus.budget.scenarios.debug, 1)
assert.match(await scenarioHarness.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, scenarioExec), /scenario .*last debug → normal/)

// A tool-continuation step (step >= 2) inside the turn already carries the recall: light.
const continuationTurn = await scenarioTurn(scenarioHarness, [human, freshRecall('s3')], { step: 2 })
assert.ok(estimateTokens(injectedText(continuationTurn)) <= 100, 'a continuation step gets the light ceiling')
assert.equal((await scenarioStatus()).budget.lastScenario.scenario, 'continuation')

// The same recall requested again is a repeat, not a fresh debug turn.
await scenarioTurn(scenarioHarness, [human, freshRecall('s3-copy')])
const repeatStatus = await scenarioStatus()
assert.equal(repeatStatus.budget.lastScenario.scenario, 'repeat')
assert.equal(repeatStatus.budget.tier.name, 'light')

// after-cut is a one-turn rule, not a permanent downgrade: the adaptive policy
// hides the cut from the next turn with a cooldown, and the scenario policy must
// do the same. A recall that is always larger than the light ceiling would
// otherwise keep lastCapped true and pin the session at light forever.
const cutHarness = makeHarness()
apply(cutHarness.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
})
const cutTurn = (messages, extra = {}) => waterfall(
  cutHarness,
  'agent/pre-step',
  { agent: { session: { header: { id: 'scenario-cut' } } }, ...extra },
  async () => ({ kind: 'enter', messages }),
)
const cutStatus = async () => JSON.parse(await cutHarness.tools
  .find((candidate) => candidate.name === 'hindsight_tuner')
  .execute({ action: 'status', json: true }, { agent: { session: { header: { id: 'scenario-cut', cwd: process.cwd() } } } }))
// Each turn gets its own lines, so the ratio stays at 0% and only the cut state
// decides the tier (verbatim shared lines would read as a repeat instead).
const cutRecall = (tag) => adaptiveRecall(`cut-${tag}`, Array.from({ length: 60 }, (_, i) => `- ${tag} note ${i}: ${tag} owns this line and no other turn repeats it`).join('\n'))

// Turn 1 is deep but the recall is larger, so it is cut and the session is marked.
await cutTurn([human, cutRecall('alpha')])
const cutFirstStatus = await cutStatus()
assert.equal(cutFirstStatus.budget.lastScenario.scenario, 'first-turn')
assert.equal(cutFirstStatus.budget.tier.name, 'deep')

// Turn 2: the debugging prompt would normally pick normal, but the previous recall
// had to be cut, and after-cut ranks above the task signal.
const afterCut = await cutTurn([debugPrompt, cutRecall('beta')], { step: 1 })
assert.ok(estimateTokens(injectedText(afterCut)) <= 100, 'after-cut drops the next recall to the light ceiling')
assert.equal((await cutStatus()).budget.lastScenario.scenario, 'after-cut')

// Turn 3: the cooldown expired, so the task signal decides again.
const recovered = await cutTurn([debugPrompt, cutRecall('gamma')], { step: 1 })
const recoveredTokens = estimateTokens(injectedText(recovered))
assert.ok(recoveredTokens > 100 && recoveredTokens <= 200, 'a single cut does not pin the session to the light ceiling')
const recoveredStatus = await cutStatus()
assert.equal(recoveredStatus.budget.lastScenario.scenario, 'debug', 'the prompt signal is used again after the cooldown')
assert.equal(recoveredStatus.budget.tier.name, 'normal')

// A bug inside the governor must not fail the host turn: the decision passes
// through unchanged and the killed pre-step is counted and shown in status.
const guardHarness = makeHarness()
apply(guardHarness.ctx, { autoTune: false, maxInjectTokens: 500 })
const guardExec = { agent: { session: { header: { id: 'guard', cwd: process.cwd() } } } }
const guardStatus = (json = true) => guardHarness.tools
  .find((candidate) => candidate.name === 'hindsight_tuner')
  .execute({ action: 'status', json }, guardExec)
// Iterating the messages throws: that is what an unexpected governor bug looks
// like from onPreStep's point of view, and it is the one error the guard exists for.
const poisoned = new Proxy([human, adaptiveRecall('guard', conventions)], {
  get(target, key, receiver) {
    if (key === Symbol.iterator) throw new Error('simulated governor bug')
    return Reflect.get(target, key, receiver)
  },
})
const guardResult = await waterfall(
  guardHarness,
  'agent/pre-step',
  { agent: { session: { header: { id: 'guard' } } } },
  async () => ({ kind: 'enter', messages: poisoned }),
)
assert.equal(guardResult.messages, poisoned, 'a governor bug passes the host decision through unchanged')
const guardJson = JSON.parse(await guardStatus())
assert.equal(guardJson.budget.prestepErrors, 1, 'the killed pre-step is counted')
assert.match(await guardStatus(false), /WARNING: 1 pre-step\(s\) failed inside the plugin/, 'status warns about the pass-through')

// Overrides are reported and applied to exactly one scenario.
const overrideHarness = makeHarness()
apply(overrideHarness.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
  scenarioTiers: { debug: 'light' },
})
await scenarioTurn(overrideHarness, [human, adaptiveRecall('o1', conventions)])
await scenarioTurn(overrideHarness, [debugPrompt, freshRecall('o2')])
const overrideStatus = await scenarioStatus(overrideHarness)
assert.equal(overrideStatus.budget.scenarioTiers.debug, 'light')
assert.equal(overrideStatus.budget.tier.name, 'light', 'the override replaces the default tier')
assert.match(await overrideHarness.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, scenarioExec), /overrides debug=light/)
for (const dispose of overrideHarness.disposers) dispose()

// Spelling is normalized: a hand-written mixed-case override is applied instead of
// being reported as a typo the applied table ignores.
const caseHarness = makeHarness()
apply(caseHarness.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
  scenarioTiers: { Debug: 'Light' },
})
const caseStatus = await scenarioStatus(caseHarness)
assert.equal(caseStatus.settingsIssues.some((issue) => issue.field === 'scenarioTiers'), false, 'mixed-case tier and scenario are not validation errors')
assert.equal(caseStatus.budget.scenarioTiers.debug, 'light', 'a mixed-case override is applied, not dropped')
for (const dispose of caseHarness.disposers) dispose()

// Compaction recovery outranks the task kind: the memory the new recall repeats
// is no longer in context, so it is worth the deep ceiling again.
const scenarioCompact = makeHarness()
apply(scenarioCompact.ctx, {
  autoTune: false,
  maxInjectTokens: 500,
  budgetPolicy: 'scenario',
  budgetTiers: { light: 100, normal: 200, deep: 400 },
})
const scenarioLogged = []
const compactScenarioTurn = (messages) => waterfall(
  scenarioCompact,
  'agent/pre-step',
  { agent: { session: { header: { id: 'scenario-compact' }, snapshotEvents: () => scenarioLogged } } },
  async () => ({ kind: 'enter', messages }),
)
await compactScenarioTurn([human, adaptiveRecall('c1', conventions)])
scenarioLogged.push({ type: 'user/message', seq: 2, data: { source: { kind: 'plugin:hindsight' }, content: [{ type: 'text', text: conventions }] } })
scenarioLogged.push({ type: 'compaction/summary', seq: 3, data: { shadowedSeqs: [2] } })
await compactScenarioTurn([human, freshRecall('c2')])
const compactStatus = await scenarioStatus(scenarioCompact, 'scenario-compact')
assert.equal(compactStatus.budget.lastScenario.scenario, 'compaction-recovery')
assert.equal(compactStatus.budget.tier.name, 'deep')
for (const dispose of scenarioCompact.disposers) dispose()

// A misspelled policy or scenario is reported and falls back, never half-applied.
const badScenario = makeHarness()
apply(badScenario.ctx, { autoTune: false, budgetPolicy: 'magic', scenarioTiers: { debug: 'huge', 'no-such-scenario': 'light' } })
const badStatus = await scenarioStatus(badScenario, 'bad')
assert.ok(badStatus.settingsIssues.some((issue) => issue.field === 'budgetPolicy'), 'an invalid budget policy is surfaced')
assert.ok(badStatus.settingsIssues.some((issue) => issue.field === 'scenarioTiers'), 'invalid scenario tiers are surfaced')
assert.equal(badStatus.budget.policy, 'off', 'an invalid policy falls back to off')
assert.equal(badStatus.budget.scenarioTiers.debug, 'normal', 'an invalid override keeps the default tier')
for (const dispose of badScenario.disposers) dispose()
for (const dispose of scenarioHarness.disposers) dispose()

// --- trust reminder ---------------------------------------------------------
// The recall is evidence, not authority: with the reminder on, the injected text
// opens by telling the model to check current code and tests, and the reminder
// itself is paid for out of the same ceiling.
const trusting = makeHarness()
apply(trusting.ctx, { autoTune: false, maxInjectTokens: 500, verifyReminder: true })
const trustExec = { agent: { session: { header: { id: 'trust', cwd: process.cwd() } } } }
const trustTurn = await waterfall(trusting, 'agent/pre-step', { agent: { session: { header: { id: 'trust' } } } }, async () => ({
  kind: 'enter',
  messages: [human, adaptiveRecall('trust', big)],
}))
const trustedText = injectedText(trustTurn)
assert.ok(trustedText.startsWith('[verify:'), 'the recall opens with the verification reminder')
assert.ok(estimateTokens(trustedText) <= 500, 'the reminder is counted in the measured budget, not added on top')
const trustStatus = JSON.parse(await trusting.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status', json: true }, trustExec))
assert.equal(trustStatus.budget.verifyReminder, true)
assert.match(await trusting.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status' }, trustExec), /trust\s+the recall opens with a verify-before-acting reminder/)
assert.equal(JSON.parse(await trusting.tools.find((candidate) => candidate.name === 'hindsight_tuner').execute({ action: 'status', json: true }, { agent: { session: { header: { id: 'other' } } } })).budget.verifyReminder, true)
for (const dispose of trusting.disposers) dispose()

// verifyReminder + repeat/history + short unrelated recall + huge paragraph.
const verifySkip = makeHarness()
apply(verifySkip.ctx, { autoTune: false, maxInjectTokens: 300, repeatPolicy: 'skip', repeatThreshold: 0.9, verifyReminder: true })
const vsTurn = (messages) => waterfall(verifySkip, 'agent/pre-step', { agent: { session: { header: { id: 'vs' } } } }, async () => ({ kind: 'enter', messages }))
const vsFirst = await vsTurn([human, adaptiveRecall('vs1', conventions)])
const vsFirstText = injectedText(vsFirst)
assert.ok(vsFirstText.startsWith('[verify:'), 'first turn starts with verify reminder')
const vsHistoryOnly = await vsTurn([human, adaptiveRecall('vs1', vsFirstText)])
assert.equal((injectedText(vsHistoryOnly).match(/\[verify:/g) ?? []).length, 1, 'history copy does not get a second verify banner')
const vsDuplicateNewId = await vsTurn([human, adaptiveRecall('vs1-dup', conventions)])
assert.equal(vsDuplicateNewId.messages.length, 1, 'sameRecall strips VERIFY_REMINDER before matching lastRaw')
const vsShortUnrelated = await vsTurn([human, adaptiveRecall('vs1', vsFirstText), adaptiveRecall('vs2', '- short unrelated fact about sockets and locks')])
assert.equal(vsShortUnrelated.messages.length, 3, 'unrelated short turn-2 recall is not skipped')
assert.equal((vsShortUnrelated.messages[1].content[0].text.match(/\[verify:/g) ?? []).length, 1, 'existing history copy stays single-banner')
assert.equal((vsShortUnrelated.messages[2].content[0].text.match(/\[verify:/g) ?? []).length, 1, 'fresh survivor receives verify banner')
const vsHugePara = await vsTurn([human, adaptiveRecall('vs3', 'gianttoken '.repeat(400))])
const vsHugeText = injectedText(vsHugePara)
assert.ok(vsHugeText.startsWith('[verify:'), 'huge single paragraph preserves verify reminder')
assert.ok(estimateTokens(vsHugeText) <= 300, 'huge single paragraph stays within cap')
for (const dispose of verifySkip.disposers) dispose()

// verifyReminder + viewPolicy: 'budgeted' (both multi-block selection & 1-block trim fallback).
const verifyView = makeHarness()
apply(verifyView.ctx, { autoTune: false, maxInjectTokens: 260, viewPolicy: 'budgeted', verifyReminder: true })
const vvMulti = await waterfall(verifyView, 'agent/pre-step', { agent: { session: { header: { id: 'vv1' } } } }, async () => ({
  kind: 'enter',
  messages: [viewTask, adaptiveRecall('vvm', [...irrelevant, relevant].join('\n\n'))],
}))
const vvMultiText = injectedText(vvMulti)
assert.ok(vvMultiText.startsWith('[verify:'), 'budgeted view with verifyReminder keeps banner at start')
assert.ok(vvMultiText.includes('lib/tokens.js'), 'budgeted view keeps task-relevant block behind banner')
assert.ok(vvMultiText.includes('budgeted view'), 'budgeted view marker survives')
assert.ok(estimateTokens(vvMultiText) <= 260, `budgeted view + verifyReminder respects cap (got ${estimateTokens(vvMultiText)})`)
const vvSingle = await waterfall(verifyView, 'agent/pre-step', { agent: { session: { header: { id: 'vv2' } } } }, async () => ({
  kind: 'enter',
  messages: [viewTask, adaptiveRecall('vvs', 'singleblock '.repeat(350))],
}))
const vvSingleText = injectedText(vvSingle)
assert.ok(vvSingleText.startsWith('[verify:'), '1-block trim fallback keeps verify banner')
assert.ok(vvSingleText.includes('dsh-hindsight-tuner: cut from'), '1-block trim fallback includes cut marker')
assert.ok(estimateTokens(vvSingleText) <= 260, '1-block trim fallback stays within cap')
for (const dispose of verifyView.disposers) dispose()

// String `message.content` works across under-cap, trimmed, and budgeted-view turns.
const strHarness = makeHarness()
apply(strHarness.ctx, { autoTune: false, maxInjectTokens: 200, viewPolicy: 'budgeted' })
const strTurn = (messages) => waterfall(strHarness, 'agent/pre-step', { agent: { session: { header: { id: 'str' } } } }, async () => ({ kind: 'enter', messages }))
const strUnder = await strTurn([
  { id: 'u-str', role: 'user', source: { kind: 'user' }, content: 'Fix lib/tokens.js' },
  { id: 'r-str-1', role: 'user', source: { kind: 'plugin:hindsight', form: 'recall' }, content: 'short string recall' },
])
assert.equal(strUnder.messages[1].content, 'short string recall', 'under-cap string content untouched')
const strView = await strTurn([
  { id: 'u-str-2', role: 'user', source: { kind: 'user' }, content: 'Fix the budget accounting in lib/tokens.js trimToBudget recallBudget' },
  { id: 'r-str-2', role: 'user', source: { kind: 'plugin:hindsight', form: 'recall' }, content: [...irrelevant, relevant].join('\n\n') },
])
assert.equal(typeof strView.messages[1].content, 'string', 'rewritten string message preserves string shape')
assert.ok(strView.messages[1].content.includes('lib/tokens.js') && strView.messages[1].content.includes('budgeted view'))
assert.ok(estimateTokens(strView.messages[1].content) <= 200, 'string content view fits cap')
const strTrim = await strTurn([
  { id: 'u-str-3', role: 'user', source: { kind: 'user' }, content: 'hello' },
  { id: 'r-str-3', role: 'user', source: { kind: 'plugin:hindsight', form: 'recall' }, content: 'word '.repeat(500) },
])
assert.equal(typeof strTrim.messages[1].content, 'string', 'trimmed string message preserves string shape')
assert.ok(estimateTokens(strTrim.messages[1].content) <= 200, 'trimmed string message fits cap')
for (const dispose of strHarness.disposers) dispose()

// Invalid settings are rejected completely and fall back to safe defaults on apply().
const allBad = makeHarness()
apply(allBad.ctx, {
  autoTune: false,
  maxInjectTokens: -5,
  sourceKind: 'bad',
  tokenBudgetMode: 'bad',
  budgetPolicy: 'magic',
  budgetTiers: null,
  repeatPolicy: 'maybe',
  repeatThreshold: 2,
  verifyReminder: 'yes',
  viewPolicy: 'wrong',
  viewContextMessages: 99,
  scenarioTiers: { debug: 'ultra' },
})
const allBadStatus = JSON.parse(await allBad.tools.find((c) => c.name === 'hindsight_tuner').execute({ action: 'status', json: true }, trustExec))
for (const field of ['budgetTiers', 'maxInjectTokens', 'sourceKind', 'tokenBudgetMode', 'budgetPolicy', 'repeatPolicy', 'repeatThreshold', 'verifyReminder', 'viewPolicy', 'viewContextMessages', 'scenarioTiers']) {
  assert.ok(allBadStatus.settingsIssues.some((issue) => issue.field === field), `reports invalid ${field}`)
}
assert.equal(allBadStatus.budget.cap, 3000)
assert.equal(allBadStatus.budget.policy, 'off')
assert.deepEqual(allBadStatus.budget.tiers, { light: 800, normal: 1600, deep: 3000 })
assert.equal(allBadStatus.budget.repeatPolicy, 'inject')
assert.equal(allBadStatus.budget.repeatThreshold, 0.9)
assert.equal(allBadStatus.budget.verifyReminder, false)
assert.equal(allBadStatus.budget.viewPolicy, 'truncate')
assert.equal(allBadStatus.budget.viewContextMessages, 8)
assert.equal(allBadStatus.budget.scenarioTiers.debug, 'normal')
for (const dispose of allBad.disposers) dispose()

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
assert.equal((await command.handler({ rawInput: ' tune --cap=' })).kind, 'error', 'blank --cap= is rejected')
assert.equal((await command.handler({ rawInput: ' tune --cap' })).kind, 'error', 'bare --cap without value is rejected')
assert.match(await tool.execute({ action: 'unknown-action' }, exec), /Unknown action "unknown-action"/, 'tool rejects unknown action cleanly')

const suggestion = await tool.execute({ action: 'suggest' }, exec)
assert.match(suggestion, /budget suggestion/)
assert.match(suggestion, /maxInjectTokens: \d+/)
assert.match(suggestion, /recallOptions\.max_tokens: \d+/)
assert.match(suggestion, /Pages and Recall are separate ceilings/)

// The suggestion is fitted to the journal's own injections, not a fixed guess.
const now = new Date().toISOString()
const injectionJournal = [
  ...[1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600].map((chars) => ({ ts: now, event: 'inject_ok', chars })),
  ...[3, 5, 4].map((count) => ({ ts: now, event: 'inject_pages', count })),
]
  .map((entry) => JSON.stringify(entry))
  .join('\n')
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, injectionJournal)
const measured = await tool.execute({ action: 'suggest' }, exec)
assert.match(measured, /observed recall ~\d+ tok p50 · ~\d+ tok p95 \(10 injections, char-based estimate\)/)
assert.match(measured, /maxInjectTokens: 2475/, 'cap follows the p95, clamped')
assert.match(measured, /tiers\s+light \d+ \/ normal \d+ \/ deep 2475/, 'tiers follow the same distribution')
assert.match(measured, /pages\s+pageSearchLimit: 7\s+\(journal max 5 pages per injection; currently unset, unset\)/, 'the Pages budget is suggested from the journal, not guessed')
const pagesStatus = await tool.execute({ action: 'status' }, exec)
assert.match(pagesStatus, /pages\s+pageSearchLimit=unset · recall max_tokens=2500 · journal 3 injections, max 5 pages/, 'status separates the Pages and Recall budgets')
assert.match(measured, /recallOptions\.max_tokens: 2000/)
const memoryStatus = await tool.execute({ action: 'status' }, exec)
assert.match(memoryStatus, /memory\s+24h: 100% of recalls were fresh \(10 injected \/ 0 unchanged\) · 0 server errors/, 'the memory line reports observable freshness, not a task-success claim')
const memoryJson = JSON.parse(await tool.execute({ action: 'status', json: true }, exec))
assert.equal(memoryJson.memory.refreshPct, 100)
assert.equal(memoryJson.memory.injected, 10)

// A journal that still fails against another origin means the running process
// predates the config: the effective config alone cannot explain it.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, [
  { ts: now, event: 'pages_failed', error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Afixture/pages/tree -> 404 (old process)' },
  { ts: now, event: 'retain_failed', error: 'POST http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Amisc/memories -> 404 (old process)' },
].map((entry) => JSON.stringify(entry)).join('\n'))
const stale = await tool.execute({ action: 'status' }, exec)
assert.match(stale, /process\s+newest journal failure still targets http:\/\/127\.0\.0\.1:9077/, 'stale process is named')
assert.match(stale, /the running DSH loaded the old config; restart it/)
assert.match(stale, /under a minute ago/, 'the stale line says how old the evidence is')
assert.match(stale, /newest journal failure targets http:\/\/127\.0\.0\.1:9077/, 'hint explains the stale process')
assert.match(stale, /Restart DSH/)
assert.match(stale, /2 failures to another server \(old process\)/, 'failures against another origin are counted, not hidden')
assert.match(stale, /banks coding-agent::fixture 1, coding-agent::misc 1/, 'mixed banks in the journal are visible, not averaged away')

// A local injection after the failure is not recovery: the static guide is
// written by this plugin, so the stale process must keep being named.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, [
  { ts: new Date(Date.now() - 5000).toISOString(), event: 'pages_failed', error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Afixture/pages/tree -> 404' },
  { ts: new Date().toISOString(), event: 'inject_ok', chars: 120 },
].map((entry) => JSON.stringify(entry)).join('\n'))
const injectIsNotRecovery = JSON.parse(await tool.execute({ action: 'status', json: true }, exec))
assert.equal(injectIsNotRecovery.stale?.seen, 'http://127.0.0.1:9077', 'a local inject_ok does not clear a foreign-origin failure')
assert.equal(injectIsNotRecovery.activity.lastSuccess, null, 'local injections are not server successes')

// A newer server-confirmed success clears the earlier failure.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, [
  { ts: new Date(Date.now() - 5000).toISOString(), event: 'pages_failed', error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Afixture/pages/tree -> 404' },
  { ts: new Date().toISOString(), event: 'pages_ok', count: 2 },
].map((entry) => JSON.stringify(entry)).join('\n'))
const recoveredStale = JSON.parse(await tool.execute({ action: 'status', json: true }, exec))
assert.equal(recoveredStale.stale, null, 'a newer server success clears an earlier foreign-origin failure')
assert.equal(Date.parse(recoveredStale.activity.lastSuccess?.ts) > 0, true, 'the server success is recorded')

// endpointOf and bankOf strip wrapping punctuation and query strings cleanly.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, JSON.stringify({
  ts: now,
  event: 'pages_failed',
  error: 'GET (https://api.example:8443/v1/default/banks/coding-agent%3A%3Asub/pages/tree?limit=10) -> 500.',
}))
const punctActivity = summarizeActivity({ harness: 'dsh', expectedOrigin: 'http://127.0.0.1:9' })
assert.equal(punctActivity.lastEndpoint, 'https://api.example:8443')
assert.equal(punctActivity.lastBank, 'coding-agent::sub')

// The character-to-token ratio is answered by the caller: CJK recall is about one
// token per character, so reporting it with the English 0.3 baseline understates
// the size threefold.
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, JSON.stringify({ ts: now, event: 'inject_ok', chars: 900 }))
const latinSized = summarizeActivity({ lines: 5, harness: 'dsh', tokenRatio: 0.3 })
const cjkSized = summarizeActivity({ lines: 5, harness: 'dsh', tokenRatio: 1 })
assert.deepEqual(
  [latinSized.lastInject.tokens, cjkSized.lastInject.tokens],
  [270, 900],
  'lastInject tokens follow the measured char ratio, not a fixed 0.3',
)

// 550 foreign-harness lines after a DSH event still preserve the DSH failure in the tail scan.
const flooded = [
  JSON.stringify({ ts: now, event: 'pages_failed', error: 'GET http://127.0.0.1:9077/v1/default/banks/coding-agent%3A%3Adsh/pages/tree -> 500' }),
  ...Array.from({ length: 550 }, (_, index) => JSON.stringify({ ts: now, harness: 'claude-code', event: 'inject_ok', chars: index + 10 })),
].join('\n')
writeFileSync(process.env.HINDSIGHT_DIAG_FILE, flooded)
const filteredActivity = summarizeActivity({ lines: 500, harness: 'dsh', expectedOrigin: 'http://127.0.0.1:9' })
assert.equal(filteredActivity.lastFailure?.endpoint, 'http://127.0.0.1:9077', 'backwards harness filter finds DSH event beyond 500 foreign lines')

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

// Tuner journal >256KB tail read (multi-byte UTF-8 boundary), delta/cap aggregation, and cross-process history status line.
flushJournal()
const prevDshForJournal = process.env.DSH_HOME
const journalIso = join(scratch, 'tuner-journal-iso')
process.env.DSH_HOME = journalIso
try {
  const isoTunerDir = join(journalIso, 'storages', 'dsh-hindsight-tuner')
  mkdirSync(isoTunerDir, { recursive: true })
  const oldTs = new Date(Date.now() - 48 * 3_600_000).toISOString()
  const freshTs = new Date().toISOString()
  const padLine = JSON.stringify({ ts: oldTs, event: 'old_pad', note: '中文多字节内容'.repeat(20) })
  const padCount = Math.ceil((270 * 1024) / Buffer.byteLength(`${padLine}\n`, 'utf8'))
  const recentLines = [
    JSON.stringify({ ts: freshTs, event: 'inject_capped', before: 500, after: 200 }),
    JSON.stringify({ ts: freshTs, event: 'inject_skipped', saved: 150 }),
    JSON.stringify({ ts: freshTs, event: 'inject_delta', saved: 80 }),
  ]
  writeFileSync(
    join(isoTunerDir, 'tuner.jsonl'),
    `${Array.from({ length: padCount }, () => padLine).join('\n')}\n${recentLines.join('\n')}\n`,
    'utf8',
  )
  const historySummary = summarizeTunerJournal({ windowHours: 24 })
  assert.deepEqual(
    { capped: historySummary.capped, skipped: historySummary.skipped, trimmedTokens: historySummary.trimmedTokens, savedTokens: historySummary.savedTokens, totalSaved: historySummary.totalSaved },
    { capped: 1, skipped: 1, trimmedTokens: 300, savedTokens: 230, totalSaved: 530 },
    'summarizeTunerJournal reads >256KB multi-byte tail and aggregates capped, skipped, and delta savings',
  )

  // The active journal rotates to `.1` at ~1 MB; a 24h summary must not reset.
  renameSync(join(isoTunerDir, 'tuner.jsonl'), join(isoTunerDir, 'tuner.jsonl.1'))
  writeFileSync(
    join(isoTunerDir, 'tuner.jsonl'),
    `${JSON.stringify({ ts: freshTs, event: 'inject_capped', before: 400, after: 250 })}\n`,
    'utf8',
  )
  const rotatedSummary = summarizeTunerJournal({ windowHours: 24 })
  assert.deepEqual(
    { capped: rotatedSummary.capped, trimmedTokens: rotatedSummary.trimmedTokens },
    { capped: 2, trimmedTokens: 450 },
    'summarizeTunerJournal keeps counting in the rotated segment',
  )

  const crossProc = makeHarness()
  apply(crossProc.ctx, { autoTune: false, maxInjectTokens: 500 })
  const crossStatusText = await crossProc.tools.find((c) => c.name === 'hindsight_tuner').execute({ action: 'status' }, exec)
  assert.match(crossStatusText, /history\s+24h across processes: 2 capped · 1 skipped · saved ~680 tok/, 'formatStatus prints cross-process 24h history line')
  for (const dispose of crossProc.disposers) dispose()
} finally {
  flushJournal()
  process.env.DSH_HOME = prevDshForJournal
}

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

// --- DSH 0.2.x lifecycle, deferred agents mount, wrapped-hook status, & verify-live ---
{
  // (1) agent/created triggers autoTune on main sessions and skips subagents.
  flushJournal()
  const prevDsh = process.env.DSH_HOME
  const prevCfg = process.env.HINDSIGHT_CONFIG
  const prevDiag = process.env.HINDSIGHT_DIAG_FILE
  const isoCreated = join(scratch, 'iso-created')
  mkdirSync(isoCreated, { recursive: true })
  process.env.DSH_HOME = join(isoCreated, 'dsh-home')
  process.env.HINDSIGHT_CONFIG = join(isoCreated, 'coding-agent.json')
  process.env.HINDSIGHT_DIAG_FILE = join(isoCreated, 'diag.jsonl')
  writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ apiUrl: 'http://127.0.0.1:9', observationScopes: 'shared' }, null, 2))
  let createdHarness = null
  try {
    createdHarness = makeHarness()
    apply(createdHarness.ctx, { autoTune: true, maxInjectTokens: 500 })
    const createdHandlers = createdHarness.handlers.get('agent/created') ?? []
    assert.equal(createdHandlers.length, 1, 'registers agent/created lifecycle listener')

    // The subagent guard returns before ensureTuned is called, so there is no
    // pending write to wait for: asserting immediately is the stronger check.
    createdHandlers[0].handler({ agent: { session: { header: { id: 'sub-1', origin: 'subagent' } } }, source: 'subagent' })
    assert.equal(readConfigFile().config.autoInject, undefined, 'subagent agent/created does not trigger auto-tune')
    assert.equal(tunerState().exists, false, 'subagent does not create tuner state.json')

    createdHandlers[0].handler({ agent: { session: { header: { id: 'main-1', origin: 'main' } } }, source: 'startup' })
    await waitFor(() => readConfigFile().config.autoInject === 'pages', { label: 'agent/created auto-tune write' })
    assert.equal(readConfigFile().config.autoInject, 'pages', 'main agent/created auto-tunes coding-agent.json')
    assert.equal(tunerState().exists, true, 'auto-tune writes state.json')
    assert.equal(summarizeTunerJournal({ windowHours: 24 }).tuneApplied, 1, 'records tune_applied in tuner journal')
  } finally {
    if (createdHarness) for (const dispose of createdHarness.disposers) dispose()
    flushJournal()
    process.env.DSH_HOME = prevDsh
    process.env.HINDSIGHT_CONFIG = prevCfg
    process.env.HINDSIGHT_DIAG_FILE = prevDiag
  }
}

{
  // (2) Deferred ctx.inject(['agents']) mount race: regardless of bundle order,
  // re-prepending on agents mount and agent/created keeps tuner outermost.
  function makeDeferredAgentsHarness() {
    const base = makeHarness()
    const waiters = []
    let mounted = false
    const origInject = base.ctx.inject
    base.ctx.inject = (services, callback) => {
      if (services.includes('agents')) {
        if (mounted) {
          callback({ agents: {} })
          return () => {}
        }
        waiters.push(callback)
        return () => {
          const idx = waiters.indexOf(callback)
          if (idx >= 0) waiters.splice(idx, 1)
        }
      }
      return origInject(services, callback)
    }
    base.mountAgents = () => {
      mounted = true
      for (const cb of waiters.splice(0)) cb({ agents: {} })
    }
    return base
  }

  const upstreamLate = async (payload, next) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, { ...recallMessage, id: 'deferred-upstream' }] }
  }

  // Case 2a: tuner activates first, upstream also registers inside delayed `agents`,
  // then `agent/created` re-prepends tuner outside upstream.
  const raceA = makeDeferredAgentsHarness()
  apply(raceA.ctx, { autoTune: false, maxInjectTokens: 120 })
  raceA.ctx.inject(['agents'], () => {
    raceA.ctx.on('agent/pre-step', upstreamLate, { prepend: true })
  })
  raceA.mountAgents()
  for (const entry of [...(raceA.handlers.get('agent/created') ?? [])]) {
    entry.handler({ agent: { session: { header: { id: 'race-a', origin: 'main' } } }, source: 'startup' })
  }
  assert.equal(raceA.handlers.get('agent/pre-step').length, 2, 're-prepend disposes previous pre-step listener instead of duplicating')
  const raceADecision = await waterfall(raceA, 'agent/pre-step', { agent: { session: { header: { id: 'race-a' } } } }, async () => ({
    kind: 'enter',
    messages: [human],
  }))
  assert.ok(estimateTokens(raceADecision.messages[1].content[0].text) <= 120, 'tuner wraps upstream after delayed agents mount + agent/created')
  assert.match(raceADecision.messages[1].content[0].text, /dsh-hindsight-tuner: cut from/)
  for (const dispose of raceA.disposers) dispose()

  // Case 2b: upstream registers inside delayed `agents` before tuner; agents mount
  // alone restores tuner as outermost even before any session lifecycle event.
  const raceB = makeDeferredAgentsHarness()
  raceB.ctx.inject(['agents'], () => {
    raceB.ctx.on('agent/pre-step', upstreamLate, { prepend: true })
  })
  apply(raceB.ctx, { autoTune: false, maxInjectTokens: 120 })
  raceB.mountAgents()
  const raceBDecision = await waterfall(raceB, 'agent/pre-step', { agent: { session: { header: { id: 'race-b' } } } }, async () => ({
    kind: 'enter',
    messages: [human],
  }))
  assert.ok(estimateTokens(raceBDecision.messages[1].content[0].text) <= 120, 'tuner wraps upstream on agents mount alone when loaded after upstream')
  for (const dispose of raceB.disposers) dispose()
}

{
  // (3) onBeforeStep safety fallback triggers autoTune on the first non-subagent
  // pre-step even if the host did not emit agent/created or agent/session-start.
  flushJournal()
  const prevDsh = process.env.DSH_HOME
  const prevCfg = process.env.HINDSIGHT_CONFIG
  const prevDiag = process.env.HINDSIGHT_DIAG_FILE
  const isoFallback = join(scratch, 'iso-fallback')
  mkdirSync(isoFallback, { recursive: true })
  process.env.DSH_HOME = join(isoFallback, 'dsh-home')
  process.env.HINDSIGHT_CONFIG = join(isoFallback, 'coding-agent.json')
  process.env.HINDSIGHT_DIAG_FILE = join(isoFallback, 'diag.jsonl')
  writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ apiUrl: 'http://127.0.0.1:9', observationScopes: 'shared' }, null, 2))
  let fallbackHarness = null
  try {
    fallbackHarness = makeHarness()
    apply(fallbackHarness.ctx, { autoTune: true, maxInjectTokens: 500 })

    await waterfall(fallbackHarness, 'agent/pre-step', { agent: { session: { header: { id: 'sub-pre', origin: 'subagent' } } } }, async () => ({
      kind: 'enter',
      messages: [human],
    }))
    // onBeforeStep skips subagents before ensureTuned, so nothing is pending.
    assert.equal(readConfigFile().config.autoInject, undefined, 'subagent pre-step does not auto-tune')

    await waterfall(fallbackHarness, 'agent/pre-step', { agent: { session: { header: { id: 'main-pre', origin: 'main' } } } }, async () => ({
      kind: 'enter',
      messages: [human],
    }))
    await waitFor(() => readConfigFile().config.autoInject === 'pages', { label: 'pre-step auto-tune fallback write' })
    assert.equal(readConfigFile().config.autoInject, 'pages', 'first non-subagent pre-step falls back to auto-tuning')
    assert.equal(tunerState().exists, true)
  } finally {
    if (fallbackHarness) for (const dispose of fallbackHarness.disposers) dispose()
    flushJournal()
    process.env.DSH_HOME = prevDsh
    process.env.HINDSIGHT_CONFIG = prevCfg
    process.env.HINDSIGHT_DIAG_FILE = prevDiag
  }
}

{
  // (4) Wrapped-hook status detection ignores pre-boot injections and accurately
  // warns when preSteps > 0 and DSH logs an injection after activation.
  flushJournal()
  const prevDsh = process.env.DSH_HOME
  const prevCfg = process.env.HINDSIGHT_CONFIG
  const prevDiag = process.env.HINDSIGHT_DIAG_FILE
  const isoOrder = join(scratch, 'iso-order')
  mkdirSync(isoOrder, { recursive: true })
  process.env.DSH_HOME = join(isoOrder, 'dsh-home')
  process.env.HINDSIGHT_CONFIG = join(isoOrder, 'coding-agent.json')
  process.env.HINDSIGHT_DIAG_FILE = join(isoOrder, 'diag.jsonl')
  writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ apiUrl: 'http://127.0.0.1:9', apiToken: 'test-token' }, null, 2))
  const preBootTs = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(process.env.HINDSIGHT_DIAG_FILE, `${JSON.stringify({ ts: preBootTs, harness: 'dsh', event: 'inject_ok', chars: 4000 })}\n`)
  let orderHarness = null
  const savedFetchOrder = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('{"pages":[]}', { status: 200 })
    orderHarness = makeHarness()
    apply(orderHarness.ctx, { autoTune: false, maxInjectTokens: 500 })
    const orderTool = orderHarness.tools.find((c) => c.name === 'hindsight_tuner')
    const orderExec = { agent: { session: { header: { id: 'ord', cwd: process.cwd() } } } }

    const beforeText = await orderTool.execute({ action: 'status' }, orderExec)
    const beforeJson = JSON.parse(await orderTool.execute({ action: 'status', json: true }, orderExec))
    assert.equal(beforeJson.budget.preSteps, 0)
    assert.equal(beforeJson.budget.injectSinceBoot, false)
    assert.doesNotMatch(beforeText, /WARNING: pre-step ran/)
    assert.doesNotMatch(beforeText, /another pre-step listener is wrapping it/)

    await waterfall(orderHarness, 'agent/pre-step', { agent: { session: { header: { id: 'ord' } } } }, async () => ({
      kind: 'enter',
      messages: [human],
    }))
    const postBootTs = new Date(Date.now() + 2000).toISOString()
    writeFileSync(process.env.HINDSIGHT_DIAG_FILE, `${JSON.stringify({ ts: postBootTs, harness: 'dsh', event: 'inject_ok', chars: 4000 })}\n`)

    const afterJson = JSON.parse(await orderTool.execute({ action: 'status', json: true }, orderExec))
    const afterText = await orderTool.execute({ action: 'status' }, orderExec)
    assert.equal(afterJson.budget.preSteps, 1)
    assert.equal(afterJson.budget.turns, 0)
    assert.equal(afterJson.budget.injectSinceBoot, true)
    assert.match(afterText, /order\s+WARNING: pre-step ran and DSH logged an injection, but none reached this hook/)
    assert.match(afterText, /another pre-step listener is wrapping it/)
  } finally {
    globalThis.fetch = savedFetchOrder
    if (orderHarness) for (const dispose of orderHarness.disposers) dispose()
    flushJournal()
    process.env.DSH_HOME = prevDsh
    process.env.HINDSIGHT_CONFIG = prevCfg
    process.env.HINDSIGHT_DIAG_FILE = prevDiag
  }
}

{
  // (5) Expanded summarizeTunerJournal tracks lifecycle/governance counts and clears
  // active tune errors after a subsequent successful tune_requested/tune_applied.
  flushJournal()
  const prevDsh = process.env.DSH_HOME
  const isoSummary = join(scratch, 'iso-journal-fields')
  process.env.DSH_HOME = isoSummary
  try {
    const dir = join(isoSummary, 'storages', 'dsh-hindsight-tuner')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'tuner.jsonl')
    const t0 = new Date(Date.now() - 10_000).toISOString()
    const t1 = new Date(Date.now() - 5_000).toISOString()
    writeFileSync(file, [
      { ts: t0, event: 'activated', autoTune: true, cap: 3000, recall: 2000, budgetPolicy: 'adaptive', repeatPolicy: 'skip' },
      { ts: t1, event: 'tune_failed', error: 'EACCES: read-only config' },
      { ts: t1, event: 'tier_selected', tier: 'deep', budget: 3000 },
      { ts: t1, event: 'inject_reentered', tokens: 120 },
      { ts: t1, event: 'inject_view', blocks: 4, kept: 2, omitted: 2 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    const activeErr = summarizeTunerJournal({ windowHours: 24 })
    assert.equal(activeErr.activated, 1)
    assert.equal(activeErr.tuneFailed, 1)
    assert.equal(activeErr.tuneErrorActive, true)
    assert.equal(activeErr.lastTuneError, 'EACCES: read-only config')
    assert.equal(activeErr.tierSelected, 1)
    assert.equal(activeErr.reentered, 1)
    assert.equal(activeErr.viewed, 1)
    assert.equal(activeErr.lastActivated.budgetPolicy, 'adaptive')
    assert.equal(activeErr.lastActivated.repeatPolicy, 'skip')

    const t2 = new Date().toISOString()
    writeFileSync(file, JSON.stringify({ ts: t2, event: 'tune_requested', changed: ['autoInject'] }) + '\n', { flag: 'a' })
    const cleared = summarizeTunerJournal({ windowHours: 24 })
    assert.equal(cleared.tuneRequested, 1)
    assert.equal(cleared.tuneFailed, 1)
    assert.equal(cleared.tuneErrorActive, false, 'later successful tune clears tuneErrorActive')
  } finally {
    flushJournal()
    process.env.DSH_HOME = prevDsh
  }
}

{
  // (6) Async hermetic subprocess verification of scripts/verify-live.mjs --json.
  let serverMode = '200'
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      return
    }
    if (req.url?.includes('/pages/tree')) {
      if (serverMode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"detail":"Authentication failed: API key required"}')
      } else if (serverMode === '404') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"Bank not found"}')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"pages":[]}')
      }
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  function runVerify(extraEnv) {
    return new Promise((resolveProc, rejectProc) => {
      const env = { ...process.env, ...extraEnv }
      for (const k of ['HINDSIGHT_API_TOKEN', 'HINDSIGHT_API_URL', 'HINDSIGHT_API_PORT', 'HINDSIGHT_AUTO_INJECT', 'HINDSIGHT_DISABLED']) {
        delete env[k]
      }
      const child = spawn(process.execPath, [join(root, 'scripts', 'verify-live.mjs'), '--json'], {
        cwd: scratch,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', rejectProc)
      child.on('close', (code) => {
        try {
          resolveProc({ code, data: JSON.parse(stdout), stderr })
        } catch (err) {
          rejectProc(new Error(`verify-live invalid JSON (exit ${code}): ${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`))
        }
      })
    })
  }

  try {
    const byName = (res, id) => res.data.results.find((r) => r.name === id)

    // 6a: 401 server + static-guide inject_ok + autoTune=true with no state.json -> fail recall & tuner.
    serverMode = '401'
    const caseA = join(scratch, 'verify-a')
    mkdirSync(join(caseA, 'dsh-home', 'storages', 'dsh-hindsight-tuner'), { recursive: true })
    writeFileSync(join(caseA, 'coding-agent.json'), JSON.stringify({ apiUrl: baseUrl }))
    const aBoot = new Date(Date.now() - 5000).toISOString()
    const aInject = new Date().toISOString()
    writeFileSync(join(caseA, 'diag.jsonl'), [
      { ts: aBoot, harness: 'dsh', event: 'pages_failed', error: `GET ${baseUrl}/v1/default/banks/b/pages/tree -> 401` },
      { ts: aInject, harness: 'dsh', event: 'inject_ok', chars: 6961 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(join(caseA, 'dsh-home', 'storages', 'dsh-hindsight-tuner', 'tuner.jsonl'), JSON.stringify({
      ts: aBoot, event: 'activated', autoTune: true, cap: 3000, recall: 2000, budgetPolicy: 'adaptive',
    }) + '\n')
    const resA = await runVerify({
      DSH_HOME: join(caseA, 'dsh-home'),
      HINDSIGHT_CONFIG: join(caseA, 'coding-agent.json'),
      HINDSIGHT_DIAG_FILE: join(caseA, 'diag.jsonl'),
    })
    assert.equal(resA.code, 1)
    assert.equal(resA.data.passed, false)
    assert.equal(byName(resA, 'bank').status, 'fail')
    assert.equal(byName(resA, 'recall').status, 'fail')
    assert.match(byName(resA, 'recall').detail, /static tool guide only/)
    assert.equal(byName(resA, 'tuner').status, 'fail')
    assert.match(byName(resA, 'tuner').detail, /auto-tune never ran/)

    // 6b: 200 bank + pages_ok + inject_ok + state.json present, yet 0 governed events under adaptive -> fail tuner.
    serverMode = '200'
    const caseB = join(scratch, 'verify-b')
    mkdirSync(join(caseB, 'dsh-home', 'storages', 'dsh-hindsight-tuner'), { recursive: true })
    writeFileSync(join(caseB, 'coding-agent.json'), JSON.stringify({ apiUrl: baseUrl, apiToken: 'ok', autoInject: 'pages' }))
    writeFileSync(join(caseB, 'diag.jsonl'), [
      { ts: aBoot, harness: 'dsh', event: 'pages_ok', count: 2 },
      { ts: aInject, harness: 'dsh', event: 'inject_ok', chars: 1200 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    writeFileSync(join(caseB, 'dsh-home', 'storages', 'dsh-hindsight-tuner', 'state.json'), JSON.stringify({ autoTune: true, applied: { autoInject: { value: 'pages', had: false, previous: null } } }))
    writeFileSync(join(caseB, 'dsh-home', 'storages', 'dsh-hindsight-tuner', 'tuner.jsonl'), [
      { ts: aBoot, event: 'activated', autoTune: true, cap: 3000, recall: 2000, budgetPolicy: 'adaptive' },
      { ts: aBoot, event: 'tune_applied', changed: ['autoInject'] },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    const resB = await runVerify({
      DSH_HOME: join(caseB, 'dsh-home'),
      HINDSIGHT_CONFIG: join(caseB, 'coding-agent.json'),
      HINDSIGHT_DIAG_FILE: join(caseB, 'diag.jsonl'),
    })
    assert.equal(resB.code, 1)
    assert.equal(byName(resB, 'recall').status, 'pass')
    assert.equal(byName(resB, 'tuner').status, 'fail')
    assert.match(byName(resB, 'tuner').detail, /hook order or lifecycle mismatch/)

    // 6c: Healthy end-to-end (200 + pages_ok + inject_ok + tier_selected + state.json) -> pass, exit 0.
    writeFileSync(
      join(caseB, 'dsh-home', 'storages', 'dsh-hindsight-tuner', 'tuner.jsonl'),
      JSON.stringify({ ts: aInject, event: 'tier_selected', tier: 'deep', budget: 3000 }) + '\n',
      { flag: 'a' },
    )
    const resC = await runVerify({
      DSH_HOME: join(caseB, 'dsh-home'),
      HINDSIGHT_CONFIG: join(caseB, 'coding-agent.json'),
      HINDSIGHT_DIAG_FILE: join(caseB, 'diag.jsonl'),
    })
    assert.equal(resC.code, 0)
    assert.equal(resC.data.passed, true)
    assert.equal(byName(resC, 'recall').status, 'pass')
    assert.equal(byName(resC, 'tuner').status, 'pass')

    // 6d: Cold machine (no tuner state/journal yet, 404 bank, empty diag.jsonl) -> exit 0 with notes.
    serverMode = '404'
    const caseD = join(scratch, 'verify-d')
    mkdirSync(caseD, { recursive: true })
    writeFileSync(join(caseD, 'coding-agent.json'), JSON.stringify({ apiUrl: baseUrl, apiToken: 'ok' }))
    writeFileSync(join(caseD, 'diag.jsonl'), '')
    const resD = await runVerify({
      DSH_HOME: join(caseD, 'dsh-home'),
      HINDSIGHT_CONFIG: join(caseD, 'coding-agent.json'),
      HINDSIGHT_DIAG_FILE: join(caseD, 'diag.jsonl'),
    })
    assert.equal(resD.code, 0)
    assert.equal(resD.data.passed, true)
    assert.equal(byName(resD, 'bank').status, 'note')
    assert.equal(byName(resD, 'recall').status, 'note')
    assert.equal(byName(resD, 'tuner').status, 'note')

    // 6e: 404 bank + a failed page fetch + the static-guide inject_ok is the
    // documented cold state: the failures are explained by the unseeded bank,
    // so recall is a note, not a failure (a 401 stays a failure, see 6a).
    writeFileSync(join(caseD, 'diag.jsonl'), [
      { ts: aBoot, harness: 'dsh', event: 'pages_failed', error: `GET ${baseUrl}/v1/default/banks/b/pages/tree -> 404 {"detail":"Bank not found"}` },
      { ts: aInject, harness: 'dsh', event: 'inject_ok', chars: 3232 },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    const resE = await runVerify({
      DSH_HOME: join(caseD, 'dsh-home'),
      HINDSIGHT_CONFIG: join(caseD, 'coding-agent.json'),
      HINDSIGHT_DIAG_FILE: join(caseD, 'diag.jsonl'),
    })
    assert.equal(resE.code, 0, 'an unseeded bank with a static-guide injection is a note, not a failure')
    assert.equal(byName(resE, 'recall').status, 'note')
    assert.match(byName(resE, 'recall').detail, /bank is not seeded yet \(static guide only\)/)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

// --- package contract -------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.version, '0.18.0', 'version matches this release')
assert.ok(pkg.engines?.node?.includes('>=22'), 'declares a Node floor the tests can rely on')
assert.equal(pkg.license, 'MIT')
assert.ok(pkg.files.includes('docs'), 'docs ship with the bundle')
assert.ok(pkg.scripts?.test, 'package exposes the test command CI runs')

for (const dispose of harness.disposers) dispose()
for (const dispose of writer.disposers) dispose()
for (const dispose of zero.disposers) dispose()
for (const dispose of lateHarness.disposers) dispose()
for (const dispose of tinyHarness.disposers) dispose()
for (const dispose of separate.disposers) dispose()
console.log('smoke: all checks passed')

