/**
 * Integration tests for `@jameryw/dsh-hindsight-tuner`.
 *
 * Part 1 (required, 100% standalone & offline): starts a local Hindsight v1
 * HTTP server in a temporary git repository with NO external Hindsight plugin
 * installed, proving the built-in memory lane (`pages`, `recall`, `reflect`),
 * all 6 native tools (`hindsight_search_pages`, `hindsight_list_pages`,
 * `hindsight_read_page`, `hindsight_recall`, `hindsight_reflect`,
 * `hindsight_retain`), `/hindsight seed` / `probe` / `status` / `suggest`,
 * governance caps, Budgeted View, and coexistence protection against double
 * injection.
 *
 * Part 2 (optional): if `@vectorize-io/hindsight-coding-agents/dist/dsh.js`
 * also exists locally, verifies hook composition with `createDshHooks`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { waitFor } from './wait.mjs'

const root = resolve(import.meta.dirname, '..')
const initialDshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-hindsight-integration-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

// Isolate environment BEFORE importing plugin modules so no real user home is touched.
const standaloneDshHome = join(scratch, 'standalone-dsh-home')
const standaloneProfile = join(scratch, 'standalone-profile')
mkdirSync(standaloneProfile, { recursive: true })
writeFileSync(join(standaloneProfile, 'package.json'), JSON.stringify({
  name: 'standalone-profile',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@jameryw/dsh-hindsight-tuner'] } },
}, null, 2))

const repoDir = join(scratch, 'sample-repo')
mkdirSync(repoDir, { recursive: true })
execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore', windowsHide: true })
writeFileSync(join(repoDir, 'README.md'), '# sample\n')
const gitAuthor = ['-c', 'user.name=Integration Test', '-c', 'user.email=test@example.invalid']
execFileSync('git', [...gitAuthor, 'add', 'README.md'], { cwd: repoDir, stdio: 'ignore', windowsHide: true })
execFileSync('git', [...gitAuthor, 'commit', '-q', '-m', 'feat: initial project layout'], { cwd: repoDir, stdio: 'ignore', windowsHide: true })
writeFileSync(join(repoDir, 'tokens.js'), 'export const cap = 300\n')
execFileSync('git', [...gitAuthor, 'add', 'tokens.js'], { cwd: repoDir, stdio: 'ignore', windowsHide: true })
execFileSync('git', [...gitAuthor, 'commit', '-q', '-m', 'fix: enforce token ceiling in tokens.js'], { cwd: repoDir, stdio: 'ignore', windowsHide: true })

process.env.DSH_HOME = standaloneDshHome
process.env.DSH_PROFILE_DIR = standaloneProfile
delete process.env.DSH_PROFILE
delete process.env.DSH_INSTALL_DIR
process.env.HINDSIGHT_CONFIG = join(scratch, 'coding-agent.json')
process.env.HINDSIGHT_DIAG_FILE = join(scratch, 'diag.jsonl')

const pagesStore = [
  {
    id: 'page-arch-01',
    name: 'Architecture Overview',
    path: 'Architecture/Overview',
    description: 'High-level system architecture and unrelated legacy services',
    content: [
      '### Legacy services',
      Array.from({ length: 45 }, (_, i) => `- legacy service note ${i}: older queue worker topology`).join('\n'),
    ].join('\n'),
  },
  {
    id: 'page-budget-02',
    name: 'Budget Accounting',
    path: 'Core/Budget Accounting',
    description: 'Token budget ceiling and trimToBudget invariants in lib/tokens.js',
    content: [
      '### Token ceiling',
      '- `lib/tokens.js` `trimToBudget` enforces `maxInjectTokens` strictly (commit 3f8a1c9, path `lib/tokens.js`).',
      '- `budgetedView` prefers query-relevant blocks and preserves evidence pointers.',
      Array.from({ length: 30 }, (_, i) => `- extra detail ${i}: token accounting invariant row ${i}`).join('\n'),
    ].join('\n'),
  },
]

const serverRequests = []
const retainedBatches = []
const syncedConfigs = []
let transientFlakyLeft = 0

const mockServer = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsedBody = null
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = null
      }
    }
    serverRequests.push({ method: req.method, pathname: url.pathname, search: url.search, body: parsedBody })

    if (url.pathname === '/flaky-health') {
      if (transientFlakyLeft > 0) {
        transientFlakyLeft -= 1
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"detail":"Service warming up"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      return
    }

    if (url.pathname === '/auth-rotated') {
      if (req.headers.authorization !== 'Bearer rotated-secret-tok') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"detail":"Invalid token"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version: '1.2.0' }))
      return
    }

    const match = /^\/v1\/default\/banks\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"detail":"Not found"}')
      return
    }
    const route = match[2]

    if (route === '/pages/tree') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        bank_id: decodeURIComponent(match[1]),
        roots: [
          {
            id: 'folder-core',
            kind: 'folder',
            name: 'Core',
            children: pagesStore.map(({ id, name, description }) => ({ id, name, description, kind: 'page' })),
          },
        ],
      }))
      return
    }

    if (route === '/pages/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const limit = Number(url.searchParams.get('limit') ?? 5) || 5
      const ranked = pagesStore
        .map((page) => ({
          ...page,
          score: (page.name.toLowerCase().includes('budget') && q.includes('budget')) || q.includes('tokens') ? 0.92 : 0.4,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        results: ranked.map(({ id, name, path, description, score }) => ({
          id,
          name,
          path,
          snippet: description,
          score,
        })),
      }))
      return
    }

    if (route.startsWith('/pages/')) {
      const pageId = decodeURIComponent(route.slice('/pages/'.length))
      const page = pagesStore.find((entry) => entry.id === pageId)
      if (!page) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"detail":"Page not found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(page))
      return
    }

    if (route === '/memories/recall' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        results: [
          { id: 'mem-1', type: 'experience', text: 'Always verify trimToBudget caps before releasing.', context: 'budget' },
          { id: 'mem-2', type: 'world', text: 'Standalone plugin talks directly to /v1/default/banks.', context: 'architecture' },
        ],
      }))
      return
    }

    if (route === '/reflect' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        text: 'Synthesized reflection: `lib/tokens.js` enforces strict token ceilings across all turns.',
      }))
      return
    }

    if (route === '/memories' && req.method === 'POST') {
      retainedBatches.push(parsedBody)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ operation_id: `op-${retainedBatches.length}`, accepted: true }))
      return
    }

    if (route === '/stats' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        total_nodes: 42,
        total_observations: 18,
        total_links: 65,
        nodes_by_fact_type: { world: 24, experience: 18 },
        pending_operations: 0,
      }))
      return
    }

    if (route === '/pages/folders' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'folder-initiatives', name: parsedBody?.name ?? 'Initiatives' }))
      return
    }

    if (route === '/pages' && req.method === 'POST') {
      const mintedId = 'kp-initiative-01'
      pagesStore.push({
        id: mintedId,
        name: parsedBody?.name ?? 'Initiative',
        path: `Initiatives/${parsedBody?.name ?? 'Initiative'}`,
        description: parsedBody?.source_query ?? '',
        content: `Tracking ${parsedBody?.name ?? 'Initiative'}`,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ page_id: mintedId, id: mintedId }))
      return
    }

    if (route === '/import' && req.method === 'POST') {
      syncedConfigs.push(parsedBody?.bank ?? parsedBody)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ imported: true }))
      return
    }

    if (route === '/config' && (req.method === 'PATCH' || req.method === 'PUT')) {
      syncedConfigs.push(parsedBody)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ updated: true }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"detail":"Unknown route"}')
  })
})

await new Promise((resolveListen) => mockServer.listen(0, '127.0.0.1', resolveListen))
const apiUrl = `http://127.0.0.1:${mockServer.address().port}`
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
  serverMode: 'self-hosted',
  apiUrl,
  apiToken: 'standalone-test-token',
  observationScopes: 'per_source',
}, null, 2))

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

function waterfall(harness, event, payload, inner) {
  const list = [...(harness.handlers.get(event) ?? [])]
  const run = (index) => (index >= list.length ? inner() : list[index].handler(payload, () => run(index + 1)))
  return run(0)
}

const SOURCE_KIND = 'plugin:hindsight'

function injectedText(messages, label) {
  const found = messages.filter((message) => message?.source?.kind === SOURCE_KIND)
  assert.equal(found.length, 1, `${label}: injected exactly one memory message`)
  const joined = found[0].content.map((block) => block.text ?? '').join('\n')
  assert.ok(joined.trim().length > 0, `${label}: injected recall has text`)
  return joined
}

try {
  // 1. Standalone activation WITHOUT @vectorize-io/hindsight-coding-agents
  const cap = 350
  const standalone = makeHarness()
  apply(standalone.ctx, {
    autoTune: true,
    maxInjectTokens: cap,
    budgetPolicy: 'adaptive',
    budgetTiers: { light: 140, normal: 250, deep: cap },
    viewPolicy: 'budgeted',
    verifyReminder: true,
    repeatPolicy: 'skip',
  })

  // Verify all 9 tools are registered in standalone mode (tuner first)
  assert.deepEqual(
    standalone.tools.map((t) => t.name),
    [
      'hindsight_tuner',
      'hindsight_search_pages',
      'hindsight_list_pages',
      'hindsight_read_page',
      'hindsight_recall',
      'hindsight_reflect',
      'hindsight_retain',
      'hindsight_ingest_document',
      'hindsight_capture_initiative',
    ],
    'standalone mode registers tuner + all 8 native Hindsight tools',
  )

  const standaloneEvents = []
  const sessionHeader = { id: 'standalone-1', cwd: repoDir, origin: 'main' }
  const session = { header: sessionHeader, snapshotEvents: () => standaloneEvents }
  for (const entry of [...(standalone.handlers.get('agent/created') ?? [])]) {
    entry.handler({ agent: { session }, source: 'startup' })
  }
  await waitFor(() => JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8')).autoInject === 'pages', {
    label: 'standalone agent/created auto-tune write',
  })

  // 2. Built-in pages auto-injection + Budgeted View + verifyReminder + cap
  const userTurn1 = {
    id: 'u1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Fix trimToBudget in lib/tokens.js so budget ceiling holds' }],
  }
  const decision1 = await waterfall(standalone, 'agent/pre-step', { agent: { session }, step: 1 }, async () => ({
    kind: 'enter',
    messages: [userTurn1],
  }))
  const text1 = injectedText(decision1.messages, 'standalone pages turn 1')
  assert.ok(estimateTokens(text1) <= cap, `standalone pages turn within cap (${estimateTokens(text1)} <= ${cap})`)
  assert.ok(text1.includes('[Hindsight historical memory'), 'verifyReminder wraps built-in recall')
  assert.ok(text1.includes('[snapshot #1 — supersedes'), 'snapshot #1 present')
  assert.ok(text1.includes('lib/tokens.js'), 'built-in pages + budgetedView kept task-relevant page')
  assert.ok(text1.includes('[end of Hindsight memory'), 'envelope closed cleanly')

  // Record in log and verify compaction re-injection works on built-in lane too
  standaloneEvents.push({ type: 'user/message', seq: 1, data: { source: { kind: SOURCE_KIND }, content: [{ type: 'text', text: text1 }] } })
  standaloneEvents.push({ type: 'compaction/summary', seq: 2, data: { shadowedSeqs: [1] } })
  const decisionCompact = await waterfall(standalone, 'agent/pre-step', { agent: { session }, step: 1 }, async () => ({
    kind: 'enter',
    messages: [{ id: 'u-empty-check', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }],
  }))
  const compactText = injectedText(decisionCompact.messages, 'standalone compaction re-entry')
  assert.ok(compactText.includes('memory re-injected after context compaction'), 'compaction re-injects built-in memory')
  assert.ok(compactText.includes('[snapshot #2 — supersedes'), 're-entry advances snapshot to #2')
  assert.ok(estimateTokens(compactText) <= cap, 'compaction re-entry stays under cap')

  // 3. All 6 native tools + /hindsight command work against mock server
  const exec = { agent: { session } }
  const callTool = (toolName, args) => standalone.tools.find((t) => t.name === toolName).execute(args, exec)

  const searchOut = await callTool('hindsight_search_pages', { query: 'budget tokens', limit: 2 })
  assert.match(searchOut, /\[page-budget-02\]/, 'hindsight_search_pages returns matching page')

  const listOut = await callTool('hindsight_list_pages', {})
  assert.match(listOut, /Core\/Architecture Overview/, 'hindsight_list_pages flattens tree')

  const readOut = await callTool('hindsight_read_page', { id: 'page-budget-02' })
  assert.match(readOut, /# Budget Accounting \(pageId: page-budget-02\)/, 'hindsight_read_page fetches body')

  const readByPageIdOut = await callTool('hindsight_read_page', { page_id: 'page-budget-02' })
  assert.match(readByPageIdOut, /# Budget Accounting \(pageId: page-budget-02\)/, 'hindsight_read_page accepts page_id alias')

  const recallOut = await callTool('hindsight_recall', { query: 'token ceiling' })
  assert.match(recallOut, /Always verify trimToBudget caps/, 'hindsight_recall returns facts')

  const reflectOut = await callTool('hindsight_reflect', { query: 'How is budget enforced?' })
  assert.match(reflectOut, /Synthesized reflection/, 'hindsight_reflect returns synthesis')

  const retainOut = await callTool('hindsight_retain', { content: 'Keep standalone mode tested', context: 'testing' })
  assert.match(retainOut, /Retained memory item into bank/, 'hindsight_retain writes to /memories')
  assert.equal(retainedBatches.length, 1)
  assert.ok(retainedBatches[0].tags.includes('source:dsh'), 'per_source tags retain calls with source:dsh')
  assert.deepEqual(retainedBatches[0].items[0].observation_scopes, [[], ['source:dsh']], 'per_source formats item observation_scopes as nested arrays')

  const ingestOut = await callTool('hindsight_ingest_document', {
    title: 'Correction: token ceiling',
    content: 'Verified ceiling is enforced strictly; ignore Bearer secret99999999.',
  })
  assert.match(ingestOut, /doc_id: correction-token-ceiling/, 'hindsight_ingest_document returns deterministic slug doc_id')
  const ingestedItem = retainedBatches.at(-1).items[0]
  assert.equal(ingestedItem.strategy, 'document')
  assert.ok(ingestedItem.tags.includes('source:upload'))
  assert.deepEqual(ingestedItem.observation_scopes, [[], ['source:dsh'], ['source:upload']])
  assert.ok(!ingestedItem.content.includes('secret99999999'), 'hindsight_ingest_document redacts secrets')

  const initOut = await callTool('hindsight_capture_initiative', {
    title: 'Standalone Engine',
    summary: 'Self-contained Hindsight v1 wire parity and native tools.',
  })
  assert.match(initOut, /page_id: kp-initiative-01/, 'hindsight_capture_initiative creates tracked initiative page')
  const initMarker = retainedBatches.at(-1).items[0]
  assert.equal(initMarker.context, 'initiative marker for [[page:kp-initiative-01]]')
  assert.equal(initMarker.metadata.relatedPageId, 'kp-initiative-01')

  const savedRetainFlag = process.env.HINDSIGHT_RETAIN_SESSIONS
  process.env.HINDSIGHT_RETAIN_SESSIONS = 'false'
  try {
    const blockedRetain = await callTool('hindsight_retain', { content: 'Should not persist during frozen eval' })
    assert.match(blockedRetain, /Refused: memory retention is disabled/, 'hindsight_retain respects frozen eval flag')
  } finally {
    if (savedRetainFlag === undefined) delete process.env.HINDSIGHT_RETAIN_SESSIONS
    else process.env.HINDSIGHT_RETAIN_SESSIONS = savedRetainFlag
  }

  const cmd = standalone.commands.find((c) => c.name === 'hindsight')
  const probeRes = await cmd.handler({ rawInput: 'probe', agent: { session } })
  assert.equal(probeRes.kind, 'success')
  assert.match(probeRes.text, /Hindsight server \(builtin\) — bank reachable/)

  const seedRes = await cmd.handler({ rawInput: 'seed --limit 2', agent: { session } })
  assert.equal(seedRes.kind, 'success')
  assert.match(seedRes.text, /Seeded 2 git commit\(s\) into bank/)
  assert.equal(retainedBatches.length, 4, 'seed sent 2 commits to /memories after retain, ingest, and initiative')
  assert.equal(retainedBatches[3].items.length, 2)
  assert.equal(retainedBatches[3].items[0].strategy, 'git')

  const statusText = await callTool('hindsight_tuner', { action: 'status' })
  assert.match(statusText, /lane\s+built-in Hindsight engine \(standalone · tools on\)/)
  assert.match(statusText, /activity 24h \(built-in\):/)

  const suggestText = await callTool('hindsight_tuner', { action: 'suggest' })
  assert.match(suggestText, /observed recall ~/)

  // 4. Built-in recall and reflect auto-injection modes (file overrides env in effectiveConfig)
  const savedCfgText = readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8')
  const parsedCfg = JSON.parse(savedCfgText)
  try {
    writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ ...parsedCfg, autoInject: 'recall' }, null, 2))
    const recallTurn = await waterfall(standalone, 'agent/pre-step', {
      agent: { session: { header: { id: 'mode-recall', cwd: repoDir, origin: 'main' } } },
    }, async () => ({ kind: 'enter', messages: [userTurn1] }))
    assert.ok(injectedText(recallTurn.messages, 'recall mode').includes('Always verify trimToBudget caps'))

    writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ ...parsedCfg, autoInject: 'reflect' }, null, 2))
    const reflectTurn = await waterfall(standalone, 'agent/pre-step', {
      agent: { session: { header: { id: 'mode-reflect', cwd: repoDir, origin: 'main' } } },
    }, async () => ({ kind: 'enter', messages: [userTurn1] }))
    assert.ok(injectedText(reflectTurn.messages, 'reflect mode').includes('Synthesized reflection'))
  } finally {
    writeFileSync(process.env.HINDSIGHT_CONFIG, savedCfgText)
  }

  // 5. Coexistence guard: if another hook already injected plugin:hindsight, do NOT double-inject
  const requestsBefore = serverRequests.length
  const preInjected = Array.from({ length: 120 }, (_, i) => `- existing external recall line ${i} with detail`).join('\n')
  const coexDecision = await waterfall(standalone, 'agent/pre-step', {
    agent: { session: { header: { id: 'coexist', cwd: repoDir, origin: 'main' } } },
  }, async () => ({
    kind: 'enter',
    messages: [
      userTurn1,
      { id: 'ext-msg', role: 'user', source: { kind: SOURCE_KIND, form: 'recall' }, content: [{ type: 'text', text: preInjected }] },
    ],
  }))
  const coexText = injectedText(coexDecision.messages, 'coexistence turn')
  assert.ok(estimateTokens(coexText) <= cap, 'coexistence still enforces cap')
  assert.equal(serverRequests.length, requestsBefore, 'built-in lane did not hit server when recall was already injected')

  // 6. Client caching, singleflight GET deduplication, and transient 503 retry
  const { requestHindsight, invalidatePagesCache } = await import('../lib/client.js')
  invalidatePagesCache()
  const beforeCacheReads = serverRequests.filter((r) => r.pathname.endsWith('/pages/page-budget-02')).length
  await callTool('hindsight_read_page', { id: 'page-budget-02' })
  await callTool('hindsight_read_page', { id: 'page-budget-02' })
  const afterCacheReads = serverRequests.filter((r) => r.pathname.endsWith('/pages/page-budget-02')).length
  assert.equal(afterCacheReads - beforeCacheReads, 1, 'second readPage call is served from pageContentCache')

  // Concurrent identical GETs share a single in-flight request, and transient 503 retries once
  transientFlakyLeft = 1
  const flakyBefore = serverRequests.filter((r) => r.pathname === '/flaky-health').length
  const [f1, f2] = await Promise.all([
    requestHindsight({ apiUrl, path: '/flaky-health', timeoutMs: 2000 }),
    requestHindsight({ apiUrl, path: '/flaky-health', timeoutMs: 2000 }),
  ])
  assert.equal(f1.ok, true, 'transient 503 recovered on retry')
  assert.equal(f2.ok, true, 'singleflight caller shared the recovered response')
  const flakyAfter = serverRequests.filter((r) => r.pathname === '/flaky-health').length
  assert.equal(flakyAfter - flakyBefore, 2, 'singleflight + 1 retry issued exactly 2 HTTP calls total across 2 concurrent callers')

  // Live 401 credential refresh via tokenProvider
  const rotatedRes = await requestHindsight({
    apiUrl,
    apiToken: 'stale-token-001',
    tokenProvider: () => 'rotated-secret-tok',
    path: '/auth-rotated',
    timeoutMs: 2000,
  })
  assert.equal(rotatedRes.ok, true, 'requestHindsight replays once with refreshed token on 401')

  // 7. Extended /hindsight slash commands (pages, recall, retain + cache invalidation + secret redaction)
  const cmdPagesTree = await cmd.handler({ rawInput: 'pages', agent: { session } })
  assert.equal(cmdPagesTree.kind, 'success')
  assert.match(cmdPagesTree.text, /Pages tree for/)

  const cmdPagesSearch = await cmd.handler({ rawInput: 'pages budget --limit 1', agent: { session } })
  assert.equal(cmdPagesSearch.kind, 'success')
  assert.match(cmdPagesSearch.text, /\[page-budget-02\]/)

  const cmdRecall = await cmd.handler({ rawInput: 'recall token ceiling --limit 1', agent: { session } })
  assert.equal(cmdRecall.kind, 'success')
  assert.match(cmdRecall.text, /Always verify trimToBudget caps/)

  const cmdReflect = await cmd.handler({ rawInput: 'reflect How is budget enforced?', agent: { session } })
  assert.equal(cmdReflect.kind, 'success')
  assert.match(cmdReflect.text, /Synthesized reflection/)

  const cmdStats = await cmd.handler({ rawInput: 'stats', agent: { session } })
  assert.equal(cmdStats.kind, 'success')
  assert.match(cmdStats.text, /memories nodes 42 · observations 18 · links 65/)
  assert.match(cmdStats.text, /pages\s+3 page\(s\)/)

  const cmdStatsJson = await cmd.handler({ rawInput: 'stats --json', agent: { session } })
  assert.equal(cmdStatsJson.kind, 'success')
  assert.equal(JSON.parse(cmdStatsJson.text).stats.total_nodes, 42)

  const cmdRetain = await cmd.handler({
    rawInput: 'retain Verified ceiling check with token Bearer supersecret12345',
    agent: { session },
  })
  assert.equal(cmdRetain.kind, 'success')
  assert.match(cmdRetain.text, /Retained memory item/)
  const manualItem = retainedBatches.at(-1).items[0]
  assert.ok(!manualItem.content.includes('supersecret12345'), '/hindsight retain redacts secrets')
  assert.ok(manualItem.content.includes('Bearer [REDACTED]'))

  // Retain invalidated pageContentCache, so reading page-budget-02 hits server again
  const beforeInvalidatedRead = serverRequests.filter((r) => r.pathname.endsWith('/pages/page-budget-02')).length
  await callTool('hindsight_read_page', { id: 'page-budget-02' })
  const afterInvalidatedRead = serverRequests.filter((r) => r.pathname.endsWith('/pages/page-budget-02')).length
  assert.equal(afterInvalidatedRead - beforeInvalidatedRead, 1, 'retain invalidated pageContentCache')

  // 8. Automatic standalone session turn retention (real DSH nested event shape, agent/turn-stopping, inheritedEventCount, redaction)
  const batchesBeforeSession = retainedBatches.length
  const dshSession = {
    header: { id: 'dsh-live-1', cwd: repoDir, origin: 'main' },
    inheritedEventCount: 1,
    snapshotEvents: () => [
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Inherited parent event that must be skipped' }] } },
      {
        type: 'user/message',
        seq: 10,
        time: 1732500000000,
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '[Hindsight historical memory — old]\n\nDebug token sk-proj-1234567890abcdefghij in lib/tokens.js' }],
        },
      },
      {
        type: 'tool/call',
        seq: 11,
        data: { name: 'edit_file', arguments: '{"Path":"lib/tokens.js"}' },
      },
      {
        type: 'assistant/message',
        seq: 12,
        time: 1732500005000,
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Fixed trimToBudget boundary handling and removed Bearer secret-session-tok99.' }],
          },
        },
      },
    ],
  }
  for (const entry of [...(standalone.handlers.get('agent/turn-stopping') ?? [])]) {
    entry.handler({ agent: { session: dshSession } })
  }
  await waitFor(() => retainedBatches.length === batchesBeforeSession + 1, {
    label: 'automatic standalone session turn retention via agent/turn-stopping',
  })
  const autoRetained = retainedBatches.at(-1)
  assert.ok(autoRetained.tags.includes('source:session'), 'session retention tagged with source:session')
  assert.ok(autoRetained.tags.includes('source:chat'), 'session retention tagged with source:chat')
  assert.ok(autoRetained.tags.includes('source:dsh'), 'session retention tagged with source:dsh under per_source')
  assert.ok(autoRetained.tags.includes('harness:dsh'), 'session retention tagged with harness:dsh')
  assert.equal(autoRetained.items[0].document_id, 'dsh:dsh-live-1:10-12')
  assert.equal(autoRetained.items[0].strategy, 'conversation')
  assert.equal(autoRetained.items[0].timestamp, new Date(1732500000000).toISOString())
  assert.ok(autoRetained.items[0].content.includes('[tool: edit_file]'), 'tool/call events captured in Actions')
  assert.ok(!autoRetained.items[0].content.includes('Inherited parent event'), 'inheritedEventCount skipped parent events')
  assert.ok(!autoRetained.items[0].content.includes('sk-proj-1234567890abcdefghij'), 'session retention scrubbed sk-* secret')
  assert.ok(!autoRetained.items[0].content.includes('secret-session-tok99'), 'session retention scrubbed Bearer token')
  assert.ok(autoRetained.items[0].content.includes('[REDACTED_KEY]'))

  // Firing turn-stopping again with no new assistant events is a no-op
  for (const entry of [...(standalone.handlers.get('agent/turn-stopping') ?? [])]) {
    entry.handler({ agent: { session: dshSession } })
  }
  assert.equal(retainedBatches.length, batchesBeforeSession + 1, 'watermark prevents duplicate session retain')

  // Frozen eval flag suppresses automatic session retention and advances watermark safely
  const prevRetainEnv = process.env.HINDSIGHT_RETAIN_SESSIONS
  process.env.HINDSIGHT_RETAIN_SESSIONS = 'false'
  try {
    const frozenSession = {
      header: { id: 'standalone-frozen', cwd: repoDir, origin: 'main' },
      snapshotEvents: () => [
        { type: 'user/message', seq: 14, data: { source: { kind: 'user' }, content: 'Frozen eval prompt that must never persist' } },
        { type: 'assistant/message', seq: 15, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Frozen eval answer that must never persist' }] } } },
      ],
    }
    for (const entry of [...(standalone.handlers.get('agent/turn-stopping') ?? [])]) {
      entry.handler({ agent: { session: frozenSession } })
    }
    assert.equal(retainedBatches.length, batchesBeforeSession + 1, 'HINDSIGHT_RETAIN_SESSIONS=false blocks auto session retain')
  } finally {
    if (prevRetainEnv === undefined) delete process.env.HINDSIGHT_RETAIN_SESSIONS
    else process.env.HINDSIGHT_RETAIN_SESSIONS = prevRetainEnv
  }

  // 9. manageBankConfig sync, toolGuideExtra injection, and standalone `daemon` auto-wake
  const baseCfg = JSON.parse(readFileSync(process.env.HINDSIGHT_CONFIG, 'utf8'))
  try {
    writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
      ...baseCfg,
      autoInject: 'recall',
      manageBankConfig: true,
      pageTriggerType: 'threshold',
      toolGuideExtra: 'Extra guide: prefer pageId anchors.',
    }, null, 2))
    const syncTurn = await waterfall(standalone, 'agent/pre-step', {
      agent: { session: { header: { id: 'sync-cfg-session', cwd: repoDir, origin: 'main' } } },
    }, async () => ({ kind: 'enter', messages: [userTurn1] }))
    const syncText = injectedText(syncTurn.messages, 'manageBankConfig + toolGuideExtra turn')
    assert.ok(syncText.includes('Extra guide: prefer pageId anchors.'), 'toolGuideExtra appended on first turn')
    await waitFor(() => syncedConfigs.length === 1, { label: 'manageBankConfig PATCH /config' })
    assert.equal(syncedConfigs[0].observation_scopes, 'per_source')
    assert.equal(syncedConfigs[0].page_trigger_type, 'threshold')

    // Reserve an unused local port and verify standalone `serverMode: 'daemon'` auto-wakes hindsight-embed
    const portFinder = createServer()
    await new Promise((r) => portFinder.listen(0, '127.0.0.1', r))
    const daemonPort = portFinder.address().port
    await new Promise((r) => portFinder.close(r))

    const mockDaemonScript = join(scratch, 'mock-hindsight-embed.mjs')
    writeFileSync(mockDaemonScript, [
      "import { createServer } from 'node:http'",
      'const idx = process.argv.indexOf("--port")',
      'const port = Number(process.argv[idx + 1])',
      'const srv = createServer((req, res) => {',
      '  res.writeHead(200, { "content-type": "application/json" })',
      '  if (req.url === "/health") { res.end(\'{"status":"ok"}\'); return }',
      '  res.end(JSON.stringify({ results: [{ id: "d1", type: "world", text: "Auto-woken daemon memory fact" }] }))',
      '  setImmediate(() => srv.close(() => process.exit(0)))',
      '})',
      'srv.listen(port, "127.0.0.1", () => {',
      '  const timer = setTimeout(() => srv.close(() => process.exit(0)), 2500)',
      '  timer.unref()',
      '})',
    ].join('\n'))

    writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({
      serverMode: 'daemon',
      apiPort: daemonPort,
      autoInject: 'recall',
      embedPackagePath: mockDaemonScript,
    }, null, 2))
    const daemonTurn = await waterfall(standalone, 'agent/pre-step', {
      agent: { session: { header: { id: 'daemon-wake-session', cwd: repoDir, origin: 'main' } } },
    }, async () => ({ kind: 'enter', messages: [userTurn1] }))
    const daemonText = injectedText(daemonTurn.messages, 'standalone daemon auto-wake turn')
    assert.ok(daemonText.includes('Auto-woken daemon memory fact'), 'standalone daemon mode auto-spawned and recalled')
  } finally {
    writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify(baseCfg, null, 2))
  }

  for (const dispose of standalone.disposers) dispose()
  console.log('integration: standalone checks passed')
} finally {
  await new Promise((resolveClose) => mockServer.close(resolveClose))
}

// ---------------------------------------------------------------------------
// Part 2 (Optional): If @vectorize-io/hindsight-coding-agents is present on
// disk, also verify hook composition with its real `createDshHooks`.
// ---------------------------------------------------------------------------
const PACKAGE = ['node_modules', '@vectorize-io', 'hindsight-coding-agents']
const candidates = process.env.HINDSIGHT_INTEGRATION_DIR
  ? [process.env.HINDSIGHT_INTEGRATION_DIR]
  : [join(root, ...PACKAGE)]
if (!process.env.HINDSIGHT_INTEGRATION_DIR) {
  const profilesRoot = join(initialDshHome, 'profiles')
  if (existsSync(profilesRoot)) {
    for (const profile of readdirSync(profilesRoot).sort()) candidates.push(join(profilesRoot, profile, ...PACKAGE))
  }
}
const packageDir = candidates.filter(Boolean).find((candidate) => existsSync(join(candidate, 'dist', 'dsh.js')))

if (!packageDir) {
  console.log('integration: external hook check skipped (@vectorize-io/hindsight-coding-agents not installed; standalone mode verified)')
  process.exit(0)
}

const extProfile = join(scratch, 'ext-profile')
mkdirSync(join(extProfile, 'node_modules', '@vectorize-io', 'hindsight-coding-agents'), { recursive: true })
writeFileSync(
  join(extProfile, 'node_modules', '@vectorize-io', 'hindsight-coding-agents', 'package.json'),
  '{"name":"@vectorize-io/hindsight-coding-agents","version":"0.8.7"}',
)
writeFileSync(join(extProfile, 'package.json'), JSON.stringify({
  name: 'integration-profile',
  private: true,
  dependencies: { '@vectorize-io/hindsight-coding-agents': '0.8.7' },
  dsh: { profile: { bundles: ['@vectorize-io/hindsight-coding-agents'] } },
}, null, 2))
process.env.DSH_PROFILE_DIR = extProfile
process.env.DSH_HOME = join(scratch, 'ext-dsh-home')
writeFileSync(process.env.HINDSIGHT_CONFIG, JSON.stringify({ observationScopes: 'shared' }, null, 2))

const integration = await import(pathToFileURL(join(packageDir, 'dist', 'dsh.js')).href)
assert.equal(typeof integration.createDshHooks, 'function', 'the external package exports createDshHooks')

const cap = 500
const bulk = Array.from({ length: 260 }, (_, index) => `memory line ${index}: 这是一条项目记忆 with detail about the repo and its decisions.`).join('\n')
const workspace = {
  root: scratch,
  seeded: undefined,
  core: {
    async seedIfCold() { return { seeded: true } },
    async onPrompt(sessionId, prompt) {
      assert.ok(sessionId)
      assert.match(prompt, /do the thing/)
    },
    getInjection() { return bulk },
  },
}
const hooks = integration.createDshHooks((agent) => (agent?.session?.header?.origin === 'subagent' ? undefined : workspace))
const extHarness = makeHarness()
apply(extHarness.ctx, { autoTune: false, maxInjectTokens: cap })
extHarness.ctx.on('agent/session-start', hooks.sessionStart)
extHarness.ctx.on('agent/pre-step', hooks.preStep, { prepend: true })

const extAgent = { session: { header: { id: 'integration-session', cwd: scratch, origin: 'main' }, events: [] } }
for (const entry of [...(extHarness.handlers.get('agent/session-start') ?? [])]) entry.handler({ agent: extAgent })
const human = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'do the thing' }] }
const extDecision = await waterfall(extHarness, 'agent/pre-step', { agent: extAgent, signal: { aborted: false } }, async () => ({
  kind: 'enter',
  messages: [human],
}))
const extText = injectedText(extDecision.messages, 'external hook turn')
assert.ok(estimateTokens(extText) <= cap, `external hook payload stays within cap (${estimateTokens(extText)} <= ${cap})`)
for (const dispose of extHarness.disposers) dispose()
console.log(`integration: external hook check also passed against ${join(packageDir, 'dist', 'dsh.js')}`)
