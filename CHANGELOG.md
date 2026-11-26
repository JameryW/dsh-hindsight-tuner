# Changelog

## 0.20.0

- **A3-C screening preflight** (`eval/cluster-preflight.mjs`): an offline
  single-linkage cut drafts unowned cluster pages and scores them against
  screening search slots and per-attempt token ratio. Confirmation prompts do
  not tune the cut. The injection path and the default tuner settings are
  unchanged. P1's primary comparison remains A3 vs A1.
- **Self-contained single-plugin Hindsight engine (`memoryLane: auto`)**:
  - New `lib/client.js` (zero-dependency Hindsight v1 REST client aligned with
    upstream wire contracts: `/pages/tree`, `/pages/search` with unrouted-404
    `/knowledge-base` & lexical fallback, `/pages/:id` with LRU body caching,
    singleflight `GET` deduplication, live `401` `tokenProvider` replay,
    transient `502`/`503`/`504`/socket retry, `/memories/recall`, `/reflect`,
    `/memories` with per-item `strategy`/`tags`/`observation_scopes`, `/stats`,
    `/operations` & `/documents` sync inspection, idempotent cold-bank coding
    manifest + core page taxonomy bootstrap, `hindsight-embed`/`uvx` detached
    auto-wake, `/pages` initiative capture, and Git commit seeding) and
    `lib/memory-lane.js`.
  - Works completely standalone without `@vectorize-io/hindsight-coding-agents`:
    automatically pulls `pages`, `recall`, or `reflect` context into
    `agent/pre-step` (honouring `signal.aborted`, `toolGuideExtra`,
    `HINDSIGHT_DISABLE_HOOKS`, and `manageBankConfig`), incrementally retains
    completed non-subagent DSH session turns on `agent/turn-stopping` and
    `agent/disposed` (supporting nested `assistant/message`, `tool/call` actions,
    `inheritedEventCount`, `maxParallelRetains`, watermark deduplication, and
    credential redaction via `redactSecrets`), registers all 10 native Hindsight
    tools (`hindsight_search_pages`, `hindsight_list_pages`,
    `hindsight_read_page` [with `page_id` & `id`], `hindsight_recall`,
    `hindsight_reflect`, `hindsight_sync_status`, `hindsight_diagnose`,
    `hindsight_retain`, `hindsight_ingest_document`, and
    `hindsight_capture_initiative`), and adds `/hindsight init [--limit N]`,
    `/hindsight stats`, `/hindsight pages`, `/hindsight recall`,
    `/hindsight reflect`, `/hindsight retain`, and `/hindsight seed [--limit N]`.
  - Ships `tokenBudgetMode: calibrated` in `cordis.patch.yml` so new profiles
    get zero-dependency BPE-grade token accounting without `js-tiktoken`, and
    adds `HINDSIGHT_EVAL_AGENT_COMMAND` to `eval/ab.mjs` so evaluations no
    longer require a hardcoded `claude` CLI default.
  - Automatically detects installed/enabled `@vectorize-io/hindsight-coding-agents`
    and yields injection, retention & tool registration without double-injecting
    when both are active; adds validated settings `memoryLane`, `builtinTools`,
    `allowMemoryRetain`, and `autoSeed`.
- **v0.20 governance & evaluation upgrades**:
  - Built-in zero-dependency `tokenBudgetMode: calibrated` structural BPE
    tokenizer (`estimateCalibratedTokens`) with strict prefix monotonicity so
    accurate subword/number/CJK budgeting requires zero npm packages.
  - Evidence anchors (`EVIDENCE_BONUS = 0.15`, `Sources:` footer, unanchored
    failure-lesson verification warnings), monotonic `[snapshot #N]` headers,
    forged `[snapshot #` escaping even when `verifyReminder: false`, and cap-safe
    snapshot numbering on compaction re-entry.
  - Fresh timestamped evaluation banks (`--fresh-bank`), capability probing
    (`--probe-capabilities`), MIDR degradation gates (`--midr-threshold`),
    training/held-out + agent-family (`dsh` included) generalization checks,
    per-arm `HINDSIGHT_TUNER_*` policy environment overrides (`viewPolicy`,
    `budgetPolicy`, `maxInjectTokens`, `tokenBudgetMode`, `repeatPolicy`,
    `verifyReminder`, `memoryLane`), and built-in Gate P0 `R0`/`R1`/`R2`
    (`raw-error` & `structured-pitfall`) retry feedback in `eval/ab.mjs` +
    `eval/agents/claude-hint.mjs` (`HINDSIGHT_EVAL_AGENT_BIN`).
- **Modularization & hot-path optimization**:
  - Split `index.js` into focused modules (`lib/envelope.js`, `lib/governor.js`,
    `lib/format.js`, `lib/client.js`, `lib/memory-lane.js`).
  - Zero-allocation single-pass `estimateTokens`, `openFenceAt`,
    `boundaryOffsets`, `collectDroppedHeadings`, `selectSectionsByQuery`, and
    `substantiveLines` scans across `lib/tokens.js` and `lib/view.js`, plus
    cached per-session substantive line sets and single-pass survivor
    measurement in `lib/governor.js`.
  - Single-syscall content-memoized `readConfigFile()` and `readState()` in
    `lib/config-file.js`, single-tokenize `createMatcher`/`budgetedView` and
    zero-split `blockHeading` in `lib/view.js`, revision/stat-memoized
    `summarizeTunerJournal()` in `lib/log.js`, short-TTL `canonicalPath` /
    profile directory memoization in `lib/diagnostics.js`, and bilingual DSH
    Plugin Manager detail pages (`docs/DETAIL.md`, `docs/DETAIL.zh.md`).
  - Fixed bare-heading orphan selection in `selectSectionsByQuery` and added
    multi-level ancestor heading mounting in `budgetedView`.
  - Pure-FS `.git` & linked-worktree resolution with unified `gitInfoCache` in
    `lib/diagnostics.js`, single-pass $O(N)$ `lastInjectionState` shadow scanning
    in `lib/governor.js`, built-in journal accounting in `lib/log.js` and
    `scripts/verify-live.mjs`, and 100% zero-dependency `test/integration.mjs`
    and CI workflow.

## 0.18.0

- New opt-in `budgetPolicy: scenario` (defaults stay `off`/`adaptive`). It keeps
  the `budgetTiers` table but chooses a scenario before the ceiling: memory
  re-injected after a compaction and the first recall of a session take `deep`;
  tool-continuation steps, repeats of what is already in context and turns after
  a cut take `light`; a prompt that reads like debug/edit/review work takes
  `normal`, questions take `light`, and anything else uses `default`. Precedence
  is compaction recovery > first turn > continuation > repeat > after-cut > task
  kind > default, so a repeat can never outrank a lost-memory recovery.
- `scenarioTiers` overrides any scenario's tier per workspace, and an invalid
  policy or override is reported as a settings issue (with the raw value) instead
  of being silently normalized. `status` shows the scenario table, the last
  choice with its reason and budget, and per-scenario counts; `status --json`,
  the journal's `tier_selected` record and `/hindsight suggest` carry the same
  data. The policy stays evidence-gated until the P2 selection comparison.
- New `lib/scenario.js` (pure, no host imports) and `test/scenario.mjs` cover the
  table, English/CJK prompt classification, every precedence step, overrides and
  invalid-input handling; `test/smoke.mjs` gains an end-to-end scenario section
  (first turn, debug prompt, continuation step, repeat, compaction recovery,
  override, invalid policy). Adds `node test/scenario.mjs` to `npm test` and CI.

## 0.17.0

- Budgeted View (`viewPolicy: budgeted`, default `truncate`): an over-budget
  recall is no longer cut to its prefix. The payload is split into
  paragraph/fence-aware fact blocks, each block is scored against the current
  turn's own non-memory text (file paths and backticked identifiers weighted
  above prose, CJK runs supported), and the highest-value blocks are kept until
  the allotment is spent. Kept blocks retain their headings and carry short
  evidence pointers (commit SHA, page id, file path) when present; the payload
  ends with a `budgeted view kept N of M blocks` footer and is re-measured so the
  rendered result can never exceed the cap. With no lexical signal it falls back
  to the prefix; a single-block or tiny-budget payload falls back to
  `trimToBudget`. `viewContextMessages` (default 8) bounds the task context.
- Budgeted-view accounting is visible rather than implied: `status` reports
  `viewPolicy`, `viewTurns`, `viewKept` and `viewOmitted`, sessions carry their
  own counters, and the journal records `inject_view` with block counts, kept
  tokens and evidence pointers. A misspelled `viewPolicy` is reported as a
  settings issue instead of being silently normalized.
- New unit suite `test/view.mjs` covers segmentation (including blank lines
  inside fences), term weighting, ranking, provenance hints, budget safety,
  determinism, fallbacks and the repetition helpers; it runs in `npm test` and
  CI. `docs/ARCHITECTURE.md` records the governance boundary, the P0–P3 evidence
  gates, the metrics and the version roadmap.

## 0.16.0

- The A/B harness is now experiment-grade instead of a per-arm aggregate:
  every run is isolated in a git worktree pinned to a recorded base SHA, every
  task gets up to `maxAttempts` attempts and every attempt is a row, the
  Hindsight bank (Pages tree + stats) is fingerprinted and can be frozen with
  `--fingerprint-out`/`--verify-fingerprint`, and arm comparisons are paired at
  the task level with a preregistered primary, a task-cluster bootstrap and
  reported confidence intervals (new `eval/worktree.mjs`, `eval/bank.mjs`,
  `eval/stats.mjs`).
- Failed, errored and timed-out runs are never dropped: the completeness check
  reports missing rows/attempts as an inclusion warning, and cache-adjusted
  prices (`--prices`) turn raw usage into a real cost per solved node.
  `eval/arms.example.json` documents the P0 (`R0`/`R1`/`R2`), P1 (`A0`/`A1`/`A2`/
  `A3`), P2 (`A3-T`/`A3-V`) and P3 (`A4`/`A5`) arms with their gates;
  `eval/README.md` specifies the task/arm schema, the asserts a qualifying run
  must satisfy and the metric definitions. The offline self-test now exercises
  50 checks and stays required in `npm test` and CI.

## 0.15.0

- Repeat safety: repetition is measured against the text the model actually
  received last turn, not the raw recall. A mostly-repeated recall that adds
  facts is now narrowed to those new blocks (a labelled `new-facts delta`)
  instead of being dropped whole, so the old overlap rule can no longer discard
  new memory. Recalls whose message ids were seen in an earlier turn are history
  and are never removed as duplicates.
- Safe re-injection after compaction: the integration's unchanged-recall check
  scans the raw session log, which still contains events a compaction shadowed,
  so it can believe memory is in context when it is not. The tuner reads the log
  itself (`compaction/summary`'s `shadowedSeqs` and `surfaceOp: replace` ranges);
  when the last delivery was removed it disables repetition and re-appends the
  text the model used to have, labelled as a re-injection and counted in the same
  budget. `status` reports `re-entered` and `deltas` separately from `skipped`.
- Budget and status accounting distinguish what Hindsight wanted from what
  actually reached the model: a capped, skipped or delta turn never looks like
  an uncapped one, and `session.lastInjected`/`lastInjectedText` track the
  delivered text.
- New regression tests cover the superset recall (new facts survive), history
  retention when a duplicate arrives, the delta path, and both sides of the
  compaction re-injection decision.

## 0.14.0

- Pages and Recall are reported as the two separate budgets they are: `status`
  adds the observed journal traffic (`journal N injections, max M pages`) and
  says `the limit binds` when the configured `pageSearchLimit` is what capped
  the injections. `suggest` derives a `pageSearchLimit` from the observed
  maximum instead of proposing a round number, and leaves the value alone when
  the journal has no `inject_pages` evidence.
- External A/B harness (`eval/`): `eval/harness.mjs` runs a task set once per
  arm, keeps every run row and reports Task Success Rate, tokens per success
  and p50/p95 wall time; `eval/ab.mjs` drives a real agent command with a
  verifiable check as ground truth, and `--dry-run` exercises the pipeline with
  a fake runner so CI needs no credentials. `eval/selftest.mjs` is part of
  `npm test`.
- Post-restart verification (`scripts/verify-live.mjs`): resolves the effective
  server and bank for the current directory, calls `/health` and the bank's page
  tree, and reads the integration journal to distinguish a stale process
  (recent failures against another origin) from a healthy one. An unseeded bank
  is a NOTE, not a failure. `npm run verify` runs it.

## 0.13.0

- Budget accounting is per session as well as per process: the session block in
  `status --json` (and the `recall` line) now carries how many turns this
  session had capped, how many messages were dropped and how many recalls were
  skipped, plus the tokens trimming removed for it. A second concurrent session
  no longer makes the current one look capped when it is not.
- Activity keeps per-bank evidence: when the journal's failures addressed more
  than one bank in the window, the activity line names the top banks with counts.
  That surfaces a routing change or another harness sharing the install instead
  of hiding it behind a single `lastBank`.

## 0.12.0

- Operational memory metrics: `status` gains a `memory` line and `status --json`
  a `memory` block with the last 24 hours of `inject_ok` vs `inject_unchanged`
  (freshness percentage), consolidated pages and server errors. These are
  observable proxies — the plugin can see whether memory is being delivered and
  whether it changes, but not whether it helped the task.
- README gains "Measuring memory", which states that boundary explicitly and
  lists what an external A/B harness must score (task success rate, stale-memory
  errors, tokens per successful task, p95 recall latency); the JSON status is
  the interface for such a harness.

## 0.11.0

- Trust governance (`verifyReminder`, on in the shipped row): a recall is
  evidence, not authority. When enabled, the injected recall opens with one
  short line asking the model to verify remembered claims against the current
  code and tests before acting. The reminder is part of the measured payload, so
  it is paid for out of the same per-turn ceiling rather than added on top; a
  `trust` line in `/hindsight` reports whether it is active, and
  `budget.verifyReminder` carries the same as data in `status --json`.
- The activity cache key now includes a hash of the journal tail as well as
  size and nanosecond mtime. A test or another writer replacing the journal
  within one clock tick used to reuse a stale parse (caught by the stale-process
  test under a fast Windows run); the cache now follows content changes.

## 0.10.0

- The plugin's own journal is buffered: a turn can emit several events, and one
  append per event put the journal on the model's critical path. Entries are
  written in a single append after 250 ms, or immediately when 500 are pending,
  and the buffer is flushed on dispose and on a normal process exit.
  `flushJournal()` / `journalPending()` are exported for tests.
- Savings are accounted rather than implied: `budget.trimmedTokens` records what
  the ceiling removed across the process, alongside the duplicate-skip savings,
  and the budget line ends with `saved ~N tok` when either is non-zero.
- `suggest` also proposes an ordered adaptive tier table derived from the same
  p50/p95 distribution (light near p50, normal between, deep at the cap), so the
  read-only recommendation covers the 0.8 policy as well as the hard cap.

## 0.9.0

- Duplicate governance (`repeatPolicy: skip`, `repeatThreshold`, default 0.9):
  when the recall for a turn largely repeats the text injected on the previous
  turn, the duplicate message is removed instead of re-sent. The previous
  message is still in the conversation, so no context is lost — only the
  duplicate tokens are. The check is line-overlap based (the same signal the
  adaptive tiers use), and `status` reports the threshold, how many turns were
  skipped, the tokens saved and the last repeat ratio. `repeatPolicy: inject`
  keeps the upstream behaviour.
- A skipped turn is accounted honestly: the recall line shows `last ~N → ~0 tok`
  and the budget line says what was saved, so the skip is visible rather than
  looking like a recall that silently vanished.

## 0.8.0

- Adaptive budget tiers (`budgetPolicy: adaptive`, `budgetTiers`): a turn's
  ceiling is picked from light/normal/deep instead of always spending the cap.
  The pick has a stated reason — first recall of the session (`deep`, nothing is
  in context yet), a recall that mostly repeats the last one or follows a cut
  (`light`, the model already has it), otherwise the smallest tier the recall
  fits. Every tier is a ceiling: the configured `maxInjectTokens` still bounds
  them, and `status` shows the table, the last choice and its reason, and how
  often each tier was used. `budgetPolicy: off` keeps the old one-ceiling mode.
- `overlapRatio` (lib/tokens.js) compares line sets of the previous and current
  recall so the duplicate test is about content, not length.
- `validateSettings` rejects an unordered tier table (`light <= normal <= deep`,
  integers 0..64000) and an unknown policy before they reach the shared config.

## 0.7.0

- `status --json` (tool: `json: true`) returns the same diagnosis as data: the
  resolved server without the token itself, the effective config layers, the
  preset diff, per-session budget accounting, probe result, activity and the
  hint. Scripts no longer have to parse prose, and the written report and the
  machine-readable one cannot drift apart.
- Journal entries are filtered by `harness`, so Claude Code (or any other
  harness writing to the same journal) can no longer make DSH look broken or
  healthy. Entries without a harness field are treated as DSH's.
- Failures against an origin other than the configured server are counted
  separately (`activity.foreignFailures` and a line in the activity summary)
  instead of being mixed into auth-failure totals. That is what a pre-restart
  Cloud 401 looks like after the config points at the daemon.
- Stale-process evidence now expires after 15 minutes instead of an hour, and
  the `process` line says how old the evidence is. After a restart the process
  either succeeds or fails against the configured server; old failures should
  stop crying wolf.
- Bundle list resolves installed versions from `node_modules` and falls back to
  the declared range only when the package is not installed, so the line says
  what is actually loaded rather than what the manifest requests.
## 0.6.0

- Stale-process detection: the journal records the endpoint of its newest
  failure, so `status` can compare it with the effective `apiUrl`. When they
  differ and the failure is less than an hour old, the running DSH process
  predates the config change and memory keeps failing until a restart — reported
  on a dedicated `process` line and as the leading hint (above the generic
  auth/404 advice it used to be buried under). This is the state the live
  profile was in: config pointed at the daemon, the process still called Cloud
  and logged 401s.

## 0.5.0

- Structure-aware trimming: a recall is cut at the last paragraph boundary or
  after a closed markdown code fence that fits the budget, so the injected text
  never ends inside an open fence (which would render the rest of the prompt as
  code). The character/line cut stays as the fallback for a single oversized
  paragraph. No hidden floor: an unfittable marker still drops the message.
- Water-filling allocation: a short recall that fits an equal share of the turn
  budget is kept whole, and only the larger messages absorb the remainder.
  Proportional cutting damaged the short, high-signal recalls for no budget gain.
- Upstream compatibility line: `status` names the installed
  `@vectorize-io/hindsight-coding-agents` version and flags a version outside the
  tested `0.8.x` line, since the pre-step hook contract is private to that
  package. CI still runs the real hook integration test against `0.8.7`.

## 0.4.0

- Real integration test (`test/integration.mjs`): imports the shipped
  `@vectorize-io/hindsight-coding-agents` `dist/dsh.js`, registers its actual
  `agent/pre-step` hook *after* the tuner, fires `agent/session-start`, and
  asserts the final model payload is within the cap. CI installs the package so
  the test runs for real on Linux, Windows and macOS.
- Authorization is no longer self-service: the `confirm: true` parameter is gone.
  The tool is read-only (`status`, `probe`, `suggest`, `dryRun`) unless the row
  sets `allowAgentWrites: true`; `/hindsight tune|revert` is the user's write
  path. A boolean the model can fill in was never a permission boundary.
- Revert persists: it writes `autoTune: false` to the plugin state, so the next
  process does not refill the keys. New `/hindsight enable` / `disable` manage
  that opt-out explicitly.
- Token calibration: `tokenBudgetMode: fast|accurate`. Accurate uses
  `js-tiktoken` when installed, falls back to the estimate ×1.1 with an explicit
  "no tokenizer" notice, and `status` reports the measured fast/accurate p50/p95
  ratio instead of claiming accuracy.
- Strict validation (`lib/validate.js`): an invalid bundle setting is reported
  and dropped from the preset instead of being written; an invalid value already
  in the effective config is surfaced as `invalid ... the integration falls back`.
  A cap below the marker size drops the message rather than forcing 32 tokens;
  `0` still means off.
- New read-only `/hindsight suggest`: derives a cap from the journal's p95
  injection size (1.25×, clamped 512..8000) and keeps Pages and Recall reported
  as separate budgets.
- Concurrency: the write compares the `mtime`/size it read under the lock right
  before the rename, so a concurrent editor causes a clear `ECONCURRENT` error
  (with one retry) instead of a lost update.
- Added MIT `LICENSE`, `engines.node >= 22`, `npm test`, and a macOS CI job.

## 0.3.2

- Diagnosis: effective config now also applies the integration's per-directory
  layers — a matching `paths.<directory>` section and the `banks.<id>` section,
  including a `banks.<id>.bank` rename. `layers` names every override.
- `optInOnly` is evaluated for the session directory (a `mapPathToBank` hit
  counts as opted in), so a lane that will never inject is reported as disabled
  instead of healthy.
- Recall accounting shows what Hindsight wanted and what reached the model
  (`last ~22611 → ~593 tok`) instead of a raw size that reads like a leak.

## 0.3.1

- Correctness: the budget now actually applies. The tuner registers as the
  outermost `agent/pre-step` waterfall listener (`prepend: true`, re-registered
  on the first session start) so it sees Hindsight's message and the final
  payload, instead of running inside the integration's own `next()`.
- Correctness: one hard ceiling per turn. The sum of all `plugin:hindsight`
  messages is capped by proportionally allocating `maxInjectTokens`, every
  message is trimmed with a marker, and a message that cannot fit the marker is
  dropped. The hidden 32-token floor is gone.
- Repeat recalls are no longer dropped: because trimming defeats the
  integration's dedupe, the old shortcut alternated between capped and absent
  memory. Every turn is now trimmed to the same ceiling.
- Safety: config writes take a lock, re-read the file under it, write a `0600`
  temp that keeps a stricter original mode, and journal the change before
  touching the file. A crash between journal and config is recovered on the
  next change or revert.
- Diagnosis: `effective` shows the config the integration actually reads
  (environment < file < `harnesses.dsh`), and `pages`/`recall` are reported as
  two separate ceilings.
- `stack` now only flags plugins that inject in the *same* turn; per-session
  recall counts are tracked separately instead of one instance-wide total.
- Journal path honours `HINDSIGHT_DIAG_FILE`.
- Tool-initiated writes need `confirm: true` (or `allowAgentWrites: true`);
  the `/hindsight` command does not.

## 0.3.0

- Audit coexistence: `bundles` lists the memory-related bundles the profile
  declares with version and enabled state, and `sources` counts injected
  messages per plugin source kind.
- Flag a stacked setup with `stack` when more than one plugin injects per turn,
  so two memory lanes are visible instead of silently doubling the context.
- Document exactly which lanes this bundle does and does not coordinate
  (Hindsight direct, Mnemon's Hindsight provider, billion-context compression).

## 0.2.1

- Cache the journal parse, the git probe and the integration lookup, so repeated
  `/hindsight` calls no longer reread the diagnostic log or spawn git each time.
- Retry a locked config rename on Windows and report a locked or read-only file
  with a message that names the cause instead of a raw errno.
- Keep non-text content blocks when trimming a recall.
- Show `drift` when the file's tuning differs from the requested preset, so a
  hand-edited value is visible without comparing numbers.
- Property-test the token cap across mixed CJK/latin input.

## 0.2.0

- Rename the package to `@jameryw/dsh-hindsight-tuner`.
- Show per-turn recall cost in `/hindsight`: how many recalls were seen this
  session, with the last, maximum and average token size — visible even when
  a turn stays under the cap.
- Order diagnosis hints by what the probe found, so a 429 or a 5xx is no longer
  masked by the generic "no token" advice.
- Run tests in an OS temporary directory instead of a workspace-relative
  scratch path, and cover rate-limit, server-error, cap-off and
  missing-integration paths.

## 0.1.0

- First release: lean profile for `~/.hindsight/coding-agent.json`, per-turn
  injection cap with duplicate suppression, `/hindsight` command and
  `hindsight_tuner` tool.
