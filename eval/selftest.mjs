// Self-test for the A/B harness: exercises the pipeline with a fake runner so
// the harness is covered in CI without credentials or a model call.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, formatReport, percentile, summarize, writeReport } from './harness.mjs'

assert.equal(percentile([], 95), null)
assert.equal(percentile([5], 95), 5)
assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
assert.equal(percentile([1, 2, 3, 4, 5], 95), 5)

const arms = [{ name: 'good', env: { HINDSIGHT_AUTO_INJECT: 'pages' } }, { name: 'bad', env: {} }]
const tasks = [{ id: 'task-a', prompt: 'do a' }, { id: 'task-b', prompt: 'do b' }]

const report = await evaluate({
  tasks,
  arms,
  repeats: 2,
  now: Date.parse('2026-11-15T00:00:00Z'),
  runTask: async ({ task, arm }) => ({
    passed: arm.name === 'good',
    durationMs: task.id === 'task-a' ? 100 : 300,
    tokens: arm.name === 'good' ? 1000 : 500,
  }),
})

assert.equal(report.rows.length, 8, '2 tasks × 2 arms × 2 repeats')
assert.equal(report.generatedAt, '2026-11-15T00:00:00.000Z')
assert.equal(report.metrics.good.successRate, 100)
assert.equal(report.metrics.bad.successRate, 0)
assert.equal(report.metrics.good.tokens, 1000)
assert.equal(report.metrics.good.tokensPerSuccess, 1000)
assert.equal(report.metrics.good.durationP50Ms, 100)
assert.equal(report.metrics.good.durationP95Ms, 300)
assert.equal(report.metrics.bad.tokensPerSuccess, null)

const text = formatReport(report)
assert.match(text, /good\s+success\s+100%/)
assert.match(text, /bad\s+success\s+0%/)
assert.match(text, /task-a\s+2\/2\s+0\/2/, 'matrix shows per-task wins')
const failedLines = text.split('failed runs:')[1].split('\n').filter((line) => line.startsWith('  '))
assert.equal(failedLines.length, 4, 'every failed run is inspectable')

const summary = summarize([{ arm: 'x', passed: true, durationMs: 1, tokens: null }])
assert.equal(summary.x.successRate, 100)
assert.equal(summary.x.tokens, null, 'missing usage is reported as missing, not zero')

await assert.rejects(() => evaluate({ tasks: [], arms, runTask: async () => ({}) }), /at least one task/)
await assert.rejects(() => evaluate({ tasks, arms: [], runTask: async () => ({}) }), /at least one arm/)
await assert.rejects(() => evaluate({ tasks, arms }), /runTask must be a function/)
await assert.rejects(() => evaluate({ tasks: [{ prompt: 'x' }], arms, runTask: async () => ({}) }), /needs an id/)

const directory = mkdtempSync(join(tmpdir(), 'tuner-eval-'))
try {
  const file = join(directory, 'nested', 'report.json')
  writeReport(report, file)
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.rows.length, 8)
  assert.equal(written.metrics.bad.passed, 0)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('eval: all checks passed')
