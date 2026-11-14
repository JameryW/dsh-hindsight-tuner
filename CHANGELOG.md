# Changelog

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
