/**
 * Unit tests for the Budgeted View policy and the repetition helpers it rests on.
 *
 * These are deliberately separate from smoke.mjs: smoke.mjs drives the plugin
 * through a fake DSH harness, while this file checks the pure selection rules
 * (segmentation, scoring, provenance, hard-budget safety, determinism) without a
 * harness, so a ranking regression is easy to localize.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_VIEW_CONTEXT_MESSAGES,
  budgetedView,
  createMatcher,
  evidenceHints,
  extractTerms,
  taskContextText,
  VIEW_POLICIES,
} from '../lib/view.js'
import {
  estimateTokens,
  repetitionRatio,
  splitBlocks,
  subtractRepeated,
} from '../lib/tokens.js'

function check(name, body) {
  try {
    body()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

check('splitBlocks keeps blank lines inside fences and splits paragraphs', () => {
  const text = [
    '### Page A',
    'commit 3f8a1c9',
    '',
    '- alpha fact that is long enough to count',
    '',
    '```js',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '### Page B',
    'beta fact that is long enough to count',
  ].join('\n')
  const blocks = splitBlocks(text)
  assert.equal(blocks.length, 4)
  assert.ok(blocks[2].includes('const a = 1\n\nconst b = 2'), 'the fence body stays in one block')
  assert.ok(blocks[3].startsWith('### Page B'))
})

check('extractTerms weights paths and backticked identifiers above prose', () => {
  const terms = extractTerms('Fix lib/tokens.js so `trimToBudget` respects the cap and zetaFunction does not leak')
  assert.ok(terms.get('lib/tokens.js') >= 4, 'a slash-path is a strong term')
  assert.ok(terms.get('trimtobudget') >= 3, 'a backticked identifier is a strong term')
  assert.ok(terms.get('zetafunction') >= 1, 'plain identifiers still count')
  assert.equal(terms.has('fix'), false, 'stopwords are not terms')
})

check('createMatcher ranks the task-matching block above unrelated ones', () => {
  const score = createMatcher('Fix the budget accounting in lib/tokens.js so trimToBudget never exceeds the cap')
  const relevant = '### Budget accounting\n- `lib/tokens.js` trimToBudget must never exceed the cap (commit 3f8a1c9).'
  const unrelated = '### Deployment\n- The old service used a different queue and was removed years ago.'
  assert.ok(score(relevant) > 0)
  assert.equal(score(unrelated), 0)
})

check('evidenceHints keeps commit, page and path pointers', () => {
  assert.deepEqual(evidenceHints('commit 3f8a1c9 path `lib/tokens.js`'), ['commit 3f8a1c9', 'path lib/tokens.js'])
  assert.deepEqual(evidenceHints('pageId: kp-1a976de9'), ['page kp-1a976de9'])
  assert.deepEqual(evidenceHints('no pointers here'), [])
})

check('budgetedView selects the matching block and never exceeds the budget', () => {
  const context = 'Fix the budget accounting in lib/tokens.js so trimToBudget never exceeds the cap; update the recallBudget test.'
  const unrelated = Array.from({ length: 12 }, (_, i) => `### Unrelated note ${i}\nOld deployment trivia number ${i} about a service that no longer exists here.`)
  const relevant = '### Budget accounting\n- `lib/tokens.js` trimToBudget must never exceed the cap; a `recallBudget` test asserts the boundary (commit 3f8a1c9, path lib/tokens.js).'
  const text = [...unrelated, relevant].join('\n\n')
  const view = budgetedView({ text, contextText: context, budget: 200, count: estimateTokens })
  assert.ok(view, 'a multi-block recall with a match yields a view')
  assert.equal(view.blocks, 13)
  assert.ok(view.kept >= 1 && view.omitted > 0)
  assert.ok(view.text.includes('lib/tokens.js'))
  assert.ok(view.text.includes('budgeted view kept'))
  assert.equal(view.text.includes('Unrelated note 0'), false, 'unrelated leading blocks are not paid for')
  assert.ok(view.tokens <= 200, 'the rendered view is measured against the hard budget')
  assert.ok(view.sources.some((source) => source.startsWith('commit ')), 'evidence survives selection')
})

check('budgetedView is deterministic', () => {
  const context = 'Fix lib/tokens.js trimToBudget'
  const text = `${'### A\nunrelated prose about a retired service.\n\n'}### B\n- \`lib/tokens.js\` trimToBudget caps tokens.\n\n### C\nanother unrelated note about a retired service.`
  const first = budgetedView({ text, contextText: context, budget: 300, count: estimateTokens })
  const second = budgetedView({ text, contextText: context, budget: 300, count: estimateTokens })
  assert.deepEqual(first, second)
})

check('budgetedView falls back to the prefix when there is no lexical signal', () => {
  const blocks = Array.from({ length: 6 }, (_, i) => `### Unrelated note ${i}\nsome prose that shares nothing with the task.`)
  const view = budgetedView({ text: blocks.join('\n\n'), contextText: 'completely different words about gardening', budget: 120, count: estimateTokens })
  assert.ok(view)
  assert.ok(view.text.startsWith('### Unrelated note 0'), 'the prefix is the no-signal fallback')
  assert.ok(view.tokens <= 120)
})

check('budgetedView returns null when there is nothing to select or no room', () => {
  const context = 'Fix lib/tokens.js'
  assert.equal(budgetedView({ text: 'a single block about `lib/tokens.js`', contextText: context, budget: 400, count: estimateTokens }), null)
  assert.equal(budgetedView({ text: '### A\ntext\n\n### B\ntext', contextText: context, budget: 0, count: estimateTokens }), null)
  const big = Array.from({ length: 5 }, (_, i) => `### Note ${i}\n${'long prose '.repeat(60)}`)
  assert.equal(budgetedView({ text: big.join('\n\n'), contextText: context, budget: 5, count: () => 40 }), null)
})

check('taskContextText reads recent non-memory messages in chronological order', () => {
  const messages = [
    { id: 'a', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
    { id: 'b', source: { kind: 'plugin:hindsight' }, content: [{ type: 'text', text: 'memory' }] },
    { id: 'c', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }, { type: 'image' }] },
  ]
  assert.equal(taskContextText(messages, 'plugin:hindsight'), 'first\nsecond')
  assert.equal(taskContextText(messages, 'plugin:hindsight', 1), 'second')
  assert.equal(DEFAULT_VIEW_CONTEXT_MESSAGES, 8)
  assert.deepEqual(VIEW_POLICIES, ['truncate', 'budgeted'])
})

check('repetitionRatio measures what is new, not what is old', () => {
  const old = ['- line one is long enough', '- line two is long enough', '- line three is long enough'].join('\n')
  const superset = `${old}\n- line four is brand new and long enough`
  assert.equal(repetitionRatio(old, old), 1)
  assert.ok(repetitionRatio(old, superset) > 0.5 && repetitionRatio(old, superset) < 1, 'a superset with new facts is not a full repeat')
  assert.equal(repetitionRatio(old, '- totally different content here'), 0)
})

check('subtractRepeated keeps only the new blocks of a superset recall', () => {
  const old = '### Old\n- keep diffs small and update the changelog\n- run the smoke test before committing'
  const next = `${old}\n\n### New\n- freeze the bank fingerprint before a benchmark run`
  const delta = subtractRepeated(old, next)
  assert.ok(delta.text.includes('freeze the bank fingerprint'))
  assert.equal(delta.text.includes('keep diffs small'), false)
  assert.ok(delta.omitted >= 1 && delta.kept >= 1)
  const identical = subtractRepeated(old, old)
  assert.equal(identical.text, '')
})

console.log('view: all checks passed')
