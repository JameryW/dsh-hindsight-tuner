# dsh-hindsight-tuner

Self-contained Hindsight project memory engine, token-budgeted governor, and
diagnostics for DeepSeek Harness.

It runs **standalone as a single plugin** — no external
`@vectorize-io/hindsight-coding-agents` bundle is required — and also
coexists seamlessly as an outer governance and diagnostic layer if that bundle
is installed and enabled (`memoryLane: auto`, design rationale and evidence gates:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

0. **Built-in standalone Hindsight engine (`memoryLane: auto`).** When
   `@vectorize-io/hindsight-coding-agents` is absent or disabled in the active
   profile, this plugin drives the Hindsight v1 HTTP API directly (`lib/client.js`,
   `lib/memory-lane.js`):
   - pulls `pages`, `recall`, or `reflect` context on entering turns (skipping
     subagent turns and skipping whenever another hook already injected
     `plugin:hindsight`);
   - registers 10 native agent tools (`hindsight_search_pages`, `hindsight_list_pages`,
     `hindsight_read_page`, `hindsight_recall`, `hindsight_reflect`,
     `hindsight_sync_status`, `hindsight_diagnose`, `hindsight_retain`,
     `hindsight_ingest_document`, and `hindsight_capture_initiative`);
   - automatically retains completed non-subagent session turns on DSH
     lifecycle events (`agent/turn-stopping` & `agent/disposed`, supporting
     nested `assistant/message` + `tool/call` shapes, `inheritedEventCount`,
     per-item `observation_scopes`, `401` live `tokenProvider` refresh,
     `maxParallelRetains`, watermark deduplication, and credential redaction),
     syncs bank consolidation settings via `/import` (`manageBankConfig: true`),
     auto-wakes local `hindsight-embed` / `uvx` daemons when `serverMode: daemon`
     is offline, and supports optional periodic background `autoReflect`
     refreshes;
   - provides `/hindsight init [--limit N]`, `/hindsight stats`, `/hindsight pages [query]`,
     `/hindsight recall <query>`, `/hindsight reflect <query>`,
     `/hindsight retain <note>`, and `/hindsight seed [--limit N]` (plus opt-in
     `autoSeed: true`) while honouring `HINDSIGHT_RETAIN_SESSIONS=false` during
     frozen A/B runs.

1. **A lean shared profile.** On the first session it fills the missing tuning
   keys in `~/.hindsight/coding-agent.json` — the same file every Hindsight
   coding-agent harness reads:

   | Key | Value | Why |
   | --- | --- | --- |
   | `autoInject` | `pages` | The integration defaults to `reflect`, a multi-source synthesis before the first turn; `pages` skips it |
   | `injectTimeoutMs` | `7000` | Pinned to the page-fetch deadline this integration already uses, so a slower future default cannot stall a turn |
   | `observationScopes` | `per_source` | The default `shared` mixes commit facts with chat claims; `per_source` consolidates them apart |
   | `recallOptions.max_tokens` | `2000` | Pinned to the integration's own recall ceiling; lower it for tighter turns, raise it for richer recall |

   Existing values win by default (`overwrite: false`). The file is backed up
   before the first write, and `/hindsight revert` removes only keys this plugin
   added. A revert also persists `autoTune: false` in the plugin's state, so the
   next process does not quietly refill the keys; `/hindsight enable` restores
   automatic tuning.

2. **A hard per-turn injection budget.** The tuner registers as the *outermost*
   `agent/pre-step` waterfall listener (`prepend: true`), re-prepends when the
   optional `agents` service mounts, and re-prepends on `agent/created` /
   `agent/session-start` so it ends up outside the Hindsight hook regardless of
   bundle load order. It therefore sees the final message list and enforces
   one shared ceiling: the sum of every `plugin:hindsight` message in a turn is
   at most `maxInjectTokens`. Trimming is structure-aware: it cuts at a paragraph
   boundary or after a closed code fence (so markdown never ends inside an open
   fence) and only falls back to a line/character cut when no boundary fits; a
   long compact bullet list is split between its top-level items instead of being
   treated as one indivisible block. Fenced code is measured at a denser
   tokens-per-character rate than prose, so a payload full of code is not
   under-counted right where it is heaviest. A
   message that cannot fit even the marker is dropped. Across messages the
   budget is water-filled rather than proportionally cut: a short recall that
   fits within an equal share is kept whole, and the larger messages take the
   remainder. The water-filling is weighted by how strongly each message matches
   the current turn's text, so a large recall that is actually about the task
   keeps more of its body before a small, unrelated one is touched. There is no
   hidden 32-token floor — a tiny cap stays tiny (the
   minimum useful cap is `0`, which disables trimming). Because the integration
   dedupes by comparing the new recall against the last injected text, a trimmed
   message never matches, so every turn is re-trimmed to the same ceiling instead
   of letting a full-size payload through on the next turn.

   By default a turn may spend the whole cap. `budgetPolicy: adaptive` instead
   picks a ceiling per turn from `budgetTiers` (light/normal/deep, defaults
   800/1600/3000, never above `maxInjectTokens`), with a reason the status
   prints: the first recall of a session takes `deep` because nothing is in
   context yet; a recall that mostly repeats what is already in context (repeat
   ratio ≥60% of its own lines), or the turn right after one that had to be cut,
   takes `light`, because the model already has that text; a recall that overlaps
   the previous one by 30–60% takes `normal`, because only part of it is new;
   otherwise the smallest tier the recall fits is used.
   A cut is a one-turn cooldown, not a permanent downgrade: the turn after the
   light one is a single step back up through `normal`, so a recall larger than
   the light ceiling does not keep the session pinned at `light`. A pause of 20
   minutes or longer between two steps resets the cut state outright: the prefix
   cache is cold, so an old cut no longer describes the new request. A cut or a
   `budgeted` view that omitted blocks also disables the "full repeat" shortcut:
   the model did not receive everything, so a later turn asking a different
   question can legitimately revive the omitted blocks instead of being tiered
   down as if the text were already in context.
   The tier is a ceiling, not a target, and `status` shows the table, the last
   choice with its reason and the per-tier counts (`status --json` carries the
   same as data). `budgetPolicy: off` keeps the single hard ceiling.

   `budgetPolicy: scenario` (opt-in) goes one step further and also reads the
   turn itself. It keeps the same `budgetTiers` table but picks the scenario
   first: memory re-injected after a compaction and the first recall of a
   session take `deep`; a tool-continuation step, a recall that repeats what is
   already in context, and the first turn after one that had to be cut take
   `light` (the same one-turn cooldown as the adaptive policy); a
   prompt that reads like debugging, editing or review takes `normal`, while a
   question takes `light`; a prompt that reports an error or a failing step
   outranks both a tool continuation and the one-turn cooldown (the debugging
   turn needs the detail), unless the new recall mostly repeats the previous one;
   anything else uses the `default` tier. `scenarioTiers`
   maps any scenario to a different tier per workspace (for example
   `{ debug: 'light' }`), and the choice, its reason and its budget appear on the
   `budget` line, in `status --json`, and as a `scenario` field on the journal's
   `tier_selected` record. The `continuation` scenario only appears when the host
   asks for memory on a tool-continuation step; the shipped Hindsight integration
   injects on the step that carries the user prompt, so those steps normally have
   no recall to budget. Defaults stay `off`/`adaptive`; this policy is
   evidence-gated and waits for the P2 `A3`-vs-`A3-T`-vs-`A3-V` comparison before
   it can become a default.

   Duplicate governance is separate from the budget: with `repeatPolicy: skip`
   (default `inject`), a recall is compared with the text the model actually
   received last turn (line overlap ≥ `repeatThreshold`, default 0.9), never
   with the raw recall — a trimmed turn only delivered a prefix, so treating the
   raw text as "already in context" would hide the rest. Three cases are told
   apart: an identical recall is not injected again (the earlier message is still
   in the conversation, `status` counts the skip and the tokens saved); a recall
   that repeats old blocks but adds facts keeps only the new blocks, labelled
   `new-facts delta`, so the overlap rule can never drop a fact; and a candidate
   message that was already in the claimed batch in an earlier turn is history,
   which is never removed. If the session log shows the last delivery was
   shadowed by a compaction (`compaction/summary.shadowedSeqs` includes it, or a
   later event replaces its range), repetition is disabled and, when the
   integration suppressed a new injection because its own dedupe still sees the
   shadowed copy, the tuner re-appends the text the model used to have — labelled,
   counted in the cap, and reported as `re-entered`. A `new-facts delta` turn
   stores only the novel blocks as the last delivery, so the tuner keeps the last
   full non-delta base separately: if that base (rather than the later delta) was
   the copy removed by compaction, the re-injection restores the whole base, not
   the fragment.

   `viewPolicy: budgeted` (default `truncate`) changes how an over-budget recall
   is cut down. Instead of trimming the prefix, the recall is split into
   paragraph/fact blocks, each block is scored against the current turn's
   non-memory text (file paths, identifiers, error signatures, CJK terms — and
   the subwords of a compound identifier, so `trimToBudget` still matches a
   paragraph that says "budget"; short English words match only at word
   boundaries), and the highest-value blocks are kept until the allotment is
   spent. A block that matches through its section heading inherits part of that
   heading's score, a bare heading is never selected on its own, and selecting a
   child mounts its nearest parent heading with it so the kept text keeps its
   provenance. Kept blocks keep
   their headings and carry short evidence hints (commit SHA, page id, file path)
   when present, the payload ends with a `budgeted view kept N of M blocks`
   footer, and the whole selection is re-measured so it can never exceed the cap.
   With no lexical signal it falls back to the prefix, and a single-paragraph or
   tiny-budget message falls back to `trimToBudget`. `viewContextMessages`
   (default 8) bounds how many recent non-memory messages are used as the task
   context; the mode stays opt-in until the P1/P2 A/B gates justify it.

   The plain `truncate` path is query-aware too. Before cutting, the tuner gives
   the ceiling to `prioritizeSectionsByQuery`: the recall's `##`/`###` sections
   are scored against the current turn's text (paths and identifiers weigh most,
   compound identifiers contribute their subwords, long Chinese runs their
   2/3-grams), the fitting ones are selected by score, and they are rendered back
   in their original document order — selection changes what is kept, never the
   relative order, because a reshuffled prefix would invalidate the model's
   prefix cache. Without a ceiling (or with no lexical signal) the order is left
   alone. The cut marker then names the section
   headings that fell off and the tools that recover them
   (`hindsight_search_pages` / `hindsight_read_page`), so a capped recall points
   at the raw records instead of being a dead end; a ceiling too small for that
   pointer falls back to the shorter marker rather than dropping the recall.

3. **A diagnosis that does not lie.** With no token configured, the integration
   fails silently on every turn (`pages_failed`, `inject_unchanged`, `401` in
   its own journal). `/hindsight` reports the endpoint, token source, bank and
   routing source, probe result, journal activity, and the *effective* config —
   including `HINDSIGHT_*` environment overrides and the `harnesses.dsh`,
   `paths.<dir>` and `banks.<id>` layers the integration applies on top of the
   file. That makes "no memory" distinct from "no token", "server down", "bank
   not seeded", and "another hook wraps the budget". It also reports per-session
   turn count, last/max/average recall tokens, the Pages and Recall ceilings
   separately, invalid config values, and whether more than one plugin injected
   in the *same* turn. It names the installed integration version and reports a
   `compat` status: `tested` for the `0.8.x` line the CI integration test
   installs, `accepted` for `0.9.x`/`0.10.x` (the upstream line that followed the
   same tokenizer and schema moves, but is not covered by CI), and flagged as
   outside the supported lines otherwise, because the hook contract is private to
   that package. It also scans the active profile's patch files for the
   deprecated `hindsight_*_knowledge_page` tool names (renamed upstream to
   `hindsight_search_pages` / `hindsight_list_pages` / `hindsight_read_page`) and
   prints a `tools` line when stale references are still configured. It also
   detects a **stale process**:
   when the journal's newest failure still targets a different origin than the
   effective config, the running DSH predates the config change and will keep
   failing until it is restarted — a state no amount of correct file content
   fixes, so `/hindsight` names it on its own `process` line, with the age of the
   evidence; the claim expires after 15 minutes so an old failure cannot cry wolf
   forever. Only a server-confirmed success (`pages_ok`, `retain_ok`,
   `reflect_ok`) clears it: the static-guide `inject_ok` a stale process writes
   immediately after its failed fetch is local, so counting it as recovery would
   hide exactly the state this check exists to name. Journal entries are filtered
   by harness (a Claude Code failure is not
   DSH's), and failures whose URL points at a different origin than the
   configured server are counted separately instead of being folded into the
   auth-failure total. `/hindsight suggest` proposes a cap from the journal's own
   p95 recall size without writing anything. It uses the measured tokens-per-char
   density when the journal has enough samples (code-dense text 0.22–1.10 tok/char
   is honoured instead of being forced back to the 0.3 prose estimate), and
   proposes `recallOptions.max_tokens` at 2500 for the truncating view or 4000
   for the `budgeted` view — the recall pool must not be smaller than the cap the
   view is allowed to use. When the journal has addressed more
   than one bank, the activity line names the banks and their counts, so a
   routing change (or a second harness sharing the install) is visible instead of
   being averaged into one number; and the `recall` line reports the current
   session's own `capped` / `skipped` counts, not only process-wide totals.
   `status --json` (tool:
   `json: true`) returns the same diagnosis as data — server without the token,
   effective layers, preset diff, budget accounting, probe, activity, hint — so
   a script or a user does not have to parse the text report. Token savings are
   part of that report: `trimmedTokens` (what the ceiling removed) plus the
   duplicate-skip savings appear as `saved ~N tok` on the budget line.

4. **Writes that survive a crash and a second process.** The shared config is
   written under a sidecar lock, through a `0600` temporary file that keeps a
   stricter target mode, with a journal written before the config. The temporary
   file is checked against the `mtime`/size read under the lock immediately
   before the rename, so an editor that saved in between produces a clear
   "changed concurrently" error instead of a lost update. If DSH dies between
   the two commits, the next run folds the journal into the applied map by
   comparing the live value, so `/hindsight revert` still works. The lock only
   serialises processes that obey the same protocol — a text editor or another
   tool saving the JSON is not blocked, which is why the rename guard exists. A
   lock left by a dead writer is reclaimed immediately; one whose pid was
   recycled by an unrelated process, or one older than a minute, is reclaimed
   too, so a crash cannot block the next session. Leftover `*.tmp-*` files from
   a crash are swept at startup: they hold a full copy of the config, so they are
   not left lying around.

5. **Writes the model cannot authorize itself.** The `hindsight_tuner` tool is
   read-only by default: its schema offers only `status`, `probe` and `suggest`,
   and `tune`, `revert`, `enable` and `disable` are added to the schema only when
   the profile row sets `allowAgentWrites: true`. There is no `confirm` flag,
   because a flag the model fills in is not a permission boundary. A `dryRun`
   preview never writes, but it previews `tune` or `revert`, and those actions are
   absent from the read-only schema: tool `dryRun` previews require agent-write
   mode too. In a read-only profile the preview path is the user-typed
   `/hindsight tune --dry-run` / `/hindsight revert --dry-run` command, which is
   also the intended write path.

6. **A recall is evidence, not authority.** Pages are written by an earlier
   session; by the time they are injected the code they describe may already
   have changed. With `verifyReminder: true` (on in the shipped row), the
   injected recall is wrapped as data on both ends: it opens with a line saying
   the text is historical memory, not instructions, and to verify it against the
   current code and tests before acting, and it closes with an explicit
   end-of-memory boundary. A page that itself contains the banner text cannot
   close the region early: the marker is escaped inside the recall body, so
   exactly one real boundary ends the data. When the recall has to be cut, the
   closing boundary is reserved before trimming — it is appended again whenever
   the ceiling can afford it, instead of being the first thing the truncation
   removes. The reminder is part of the measured payload, so it is
   counted against the same ceiling as the recall itself — turning it on cannot
   silently overrun the budget. The `trust` line in `/hindsight` reports whether
   it is active.

The plugin's own journal (`<DSH_HOME>/storages/dsh-hindsight-tuner/tuner.jsonl`)
is buffered rather than written on every event: entries are flushed in one
append after 250 ms, immediately when 500 are pending, on dispose, and on a
normal process exit — diagnostics never sit on the model's critical path.

## Measuring memory

What the plugin can observe from inside the loop is reported as the `memory`
object in `status --json` (raw counters, including `pagesOk`) and as one line in
`/hindsight`: over the last 24 hours, the freshness percentage, how many recalls
were fresh (`inject_ok`) versus unchanged (`inject_unchanged`), and how many
server calls failed (`pages_failed` + `retain_failed` + `reflect_failed`).
Together with the budget accounting (`trimmedTokens`,
`savedTokens`, per-tier counts) that is enough to see whether memory is being
delivered and whether the budget is doing anything — not whether it *helped*.

Task-success measurement cannot live here honestly: the plugin never sees whether
a task passed, so a self-reported "Memory Precision@K" would be a guess. That is
why the repository ships the external harness described next.

The journal names *why* a turn received less memory instead of leaving it to be
inferred from token counts: `inject_skipped` (repeat), `inject_delta` (only the
new blocks travelled), `inject_reentered` (restored after a compaction) and
`inject_view` (Budgeted View kept blocks, with evidence pointers). `status` adds
the matching counters.

The Pages budget is reported separately from the Recall budget, because they are
different knobs: `recallOptions.max_tokens` cuts a synthesis, while
`pageSearchLimit` counts pages. When the journal contains `inject_pages`
entries, `status` shows `journal N injections, max M pages` and marks
`the limit binds` when the observed maximum reaches or exceeds the configured
`pageSearchLimit` (a page count above the limit is the same signal as one exactly
at it); `suggest` then proposes a limit from the observed maximum instead of a
round number.

`status --json` also groups the journal into semantic classes under
`activity.classes` — `injected`, `unchanged`, `fallback`, `timeout`, `cacheHit`,
`notRecalled`, `failed`, `other` — so a degraded injection or a timeout is
never read as a successful recall. The raw per-event counts stay available in
`activity.totals`/`recent`.

## A/B evaluation

`eval/` is an experiment-grade, dependency-free harness: it runs each task in an
isolated git worktree pinned to a recorded base SHA, gives each task up to
`maxAttempts` attempts (every attempt is a row, failures are never dropped),
fingerprints the Hindsight bank (`pages/tree` + memory-bearing `stats`, with the
server's operation bookkeeping excluded so a background refresh does not count as
drift) before the run, again
before each new arm and once at the end (background consolidation must not
change the memory mid-experiment; attempts also run with session retain off), and
compares arms with a **preregistered primary** and a task-level paired
bootstrap. Before any run it also audits leak prevention: with a memory arm,
every task must declare `asOf` (the instant its history was frozen), a starting
commit created after that cutoff is refused, a task may not start from a commit
its `exclude` list names as the target fix, and the `screening`/`confirmation`
sets may not reuse the same checkout and prompt — nor the same base commit, so
the confirmation set cannot be selected by the checkout it confirms. The run is
pinned to the plugin version and a sha256 of the tuner config; if `autoTune`
rewrites that config mid-experiment the harness fails instead of comparing
drifted arms. The report's `memory` block splits the paired cost into benefit,
total tax, and the tax that came from a damaged recall (`trim`/omitted view)
versus one that came from distraction (regressions with no trim metadata), with
the regressed task ids listed. It also reports **MIDR** (memory-induced
degradation rate) and enforces a default 5% ceiling (`--midr-threshold`), plus
warnings when tasks have no training/held-out split or cover only one agent
family. `--fresh-bank` derives a unique, timestamped evaluation bank instead of
reusing a name that a crash-retry could delete; `--probe-capabilities` records
whether the server separates embedding and operation-validator capabilities.
A completeness check turns missing rows or overlapping attempts into an explicit
inclusion warning in the report; a completed experiment exits 0 even when every
task failed. The harness never calls a model itself — you point it at an agent
command.

```sh
# offline proof that the tooling works (no network, no agents)
node eval/selftest.mjs

# inspect the plan: tasks, arms, worktrees, bank actions — spawns nothing
node eval/ab.mjs --tasks eval/tasks.example.json --arms A3,A0 --primary A3:A0 --dry-run

# a real run, with a frozen bank fingerprint saved for reproducibility
# (A1 declares a fixture requirement; pass --allow-unmet-requires once prepared)
node eval/ab.mjs --tasks tasks.json --arms A3,A1 --primary A3:A1 --allow-unmet-requires --repeats 5 \
  --fingerprint-out experiments/p1-bank.json --report experiments/p1.json

# a follow-up run must match the frozen bank, or it refuses to compare
node eval/ab.mjs --tasks tasks.json --arms A3,A1 --primary A3:A1 --allow-unmet-requires --repeats 5 \
  --verify-fingerprint experiments/p1-bank.json
```

A task is `{ id, prompt, cwd, check }` (optional `maxAttempts`, `checkCwd`,
`env`, and for memory arms the leak-prevention fields `asOf`, `set`, `exclude`,
`baseSha`); `check` is a command, argv array or `{command, args}` object and its
exit code is the ground truth. Arms are data: `A0` no memory, `A1` handwritten
conventions, `A2` Reflect, `A3` Pages, `A3-T` Pages + tuner truncation, `A3-V`
Pages + Budgeted View, plus the P0 (`R0`/`R1`/`R2`) and P3 (`A4`/`A5`) arms in
`eval/arms.example.json`. Arms that carry a written `hint` (the P0 `R1`/`R2`
failure feedback and `A1`) point `--agent-command` (or set
`HINDSIGHT_EVAL_AGENT_COMMAND`) at
`eval/agents/claude-hint.mjs`: it prepends that arm's `HINDSIGHT_EVAL_HINT` to
the prompt it receives on stdin and then runs `HINDSIGHT_EVAL_AGENT_BIN`
(default `claude`), passing the prompt through unchanged when no hint is set. `--prices` supplies cache-adjusted
input/output prices
so the report's cost columns reflect real cost rather than raw token counts; the
headline metrics are Attempts to Success and Cost per Solved Node, with Task
Success Rate as the non-inferiority guardrail. See [eval/README.md](eval/README.md)
for the task/arm schema, the completeness assertions and the metric definitions.

The check command is the limit of this design: tasks are only measurable when
"I did it correctly" is executable (`node --test`, a linter, a golden file). A
task whose success is a judgement call needs its own rubric, which this harness
does not invent.

## Verifying a restart

The running DSH process keeps the configuration it loaded; editing the file does
not reach it. `scripts/verify-live.mjs` checks the machine from the outside:

```sh
node scripts/verify-live.mjs          # PASS/NOTE/FAIL lines, exit 1 on failure
node scripts/verify-live.mjs --json   # same result as JSON
```

It resolves the effective server and bank for the current directory, calls
`/health` and the bank's page tree, reads the integration journal to catch a
stale process (or a `401` static-guide-only `inject_ok` with no real recall),
and checks the tuner's own state and journal (`state.json` and `tuner.jsonl`) to
confirm auto-tuning and `agent/pre-step` governance actually ran. An unseeded
bank is reported as NOTE rather than FAIL: the first page fetch 404s and the
integration injects its static guide, which is the expected cold state before a
session seeds the bank. A bank that answers but holds no pages is a NOTE too —
reachable is not the same as populated, and the script says so instead of
calling an empty memory "seeded". A `401`/`403` is never explained that way — it
stays a failure, because the process is talking to the wrong server or without a
token.

## Install

Clone the repository and install the directory as a local bundle:

```sh
git clone https://github.com/JameryW/dsh-hindsight-tuner.git
```

Then in DSH: **Plugins → Add plugin**, choose the cloned directory, and enable
the bundle. The install links the checkout, so edits here reach the profile on
the next DSH restart; the profile keeps its own copy of the row config.

## Use

- `/hindsight` — health, tuning, per-turn recall size, budget and journal
  activity for this session. It flags `drift` when a value in the file differs
  from the requested preset.
- `/hindsight status --json` — the same status as JSON, for scripts.
- `/hindsight stats [--json]` — live bank inventory (memory nodes, observations,
  links, fact breakdown, page count, stale pages, and pending operations).
- `/hindsight probe` — one reachability check, no journal read.
- `/hindsight suggest` — read-only cap/recall recommendation from the recent
  injection sizes.
- `/hindsight tune [--dry-run] [--overwrite] [--cap N]` — apply the lean profile
  now; `--cap` changes the session ceiling only.
- `/hindsight revert [--dry-run]` — undo this plugin's keys and persist an
  auto-tune opt-out, so a restart does not refill them.
- `/hindsight pages [query] [--limit N]` — list the bank's page tree, or run
  hybrid search across pages when `query` is provided.
- `/hindsight recall <query> [--limit N]` — recall atomic facts and experiences
  directly from the resolved bank.
- `/hindsight reflect <query>` — run agentic reflection over the resolved bank.
- `/hindsight retain <note>` — store a manual project note into the bank (with
  automatic credential redaction).
- `/hindsight seed [--limit N]` — ingest up to `N` (1..500, default 30) recent
  non-merge Git commits from the current directory into the resolved bank.
- `/hindsight init [--limit N]` — idempotently initialize a standalone coding
  bank: sync the coding manifest/strategies via `/import`, seed the 4 core page
  templates (`Architecture`, `Conventions`, `Component Map`, `Key Decisions`) if
  absent, and seed up to `N` recent Git commits.
- `/hindsight enable` / `/hindsight disable` — turn the persistent auto-tune
  opt-out back on or off. `disable` leaves existing keys untouched.

Control actions are exposed to the agent as the `hindsight_tuner` tool, and
both call the same implementation. Its schema lists `status`, `probe` and
`suggest` by default and adds `tune`, `revert`, `enable` and `disable` only when
the row sets `allowAgentWrites: true`, so a read-only profile cannot even offer
the write actions to a model. A tool call cannot escalate itself: a `dryRun`
preview never writes, and without agent writes enabled the write actions are
absent from the schema, while the shared guard refuses a real write even if a
host dispatches one anyway.

When the built-in lane is active (or `builtinTools: true`), the plugin also
registers the 10 native memory tools directly (`hindsight_search_pages`,
`hindsight_list_pages`, `hindsight_read_page` [accepting both `page_id` and `id`],
`hindsight_recall`, `hindsight_reflect`, `hindsight_sync_status`,
`hindsight_diagnose`, and — when `allowMemoryRetain` is on —
`hindsight_retain`, `hindsight_ingest_document`, and
`hindsight_capture_initiative`).

## Coexistence

This bundle owns the Hindsight lane only. What it does and does not coordinate:

- With `memoryLane: auto` (default), it activates its built-in Hindsight engine
  when `@vectorize-io/hindsight-coding-agents` is absent or disabled in
  `dsh.profile.bundles`, and automatically yields injection & tool registration
  to the external bundle when it is enabled — while still wrapping and governing
  its `plugin:hindsight` messages. Even in built-in mode, if another listener
  already attached a `plugin:hindsight` message on the turn, the built-in lane
  will not double-inject.
- `dsh-mnemon` can reach the same Hindsight server through its own
  `dsh-mnemon-provider-hindsight` adapter, but that adapter carries its own
  endpoint and bank settings: the shared file this plugin edits does not
  configure it. Running both lanes means two recalls per turn; `/hindsight`
  counts `sources` per injection kind and flags `stack` when more than one
  plugin injects.
- `billion-context` compresses at the proxy/ACP layer. The per-turn cap still
  applies before compression, but the two do not share a budget.
- The `bundles` line lists the memory-related bundles the profile declares
  (with the version actually installed under `node_modules`, or the declared
  range when it is absent, and enabled state), so a stacked setup is visible
  without
  reading `package.json`.

## Configuration

Tune the row in the profile's `cordis.patch.yml` (the user's patch layer
survives upgrades):

| Field | Default | Meaning |
| --- | --- | --- |
| `autoTune` | `true` | Fill the shared config on the first session |
| `overwrite` | `false` | Replace existing values instead of respecting them |
| `memoryLane` | `auto` | `auto` uses built-in engine unless external bundle is enabled; `builtin` forces built-in; `external` requires `@vectorize-io/hindsight-coding-agents`; `off` disables memory governance |
| `builtinTools` | `auto` | `auto` registers native `hindsight_*` tools when built-in lane is active; `true`/`false` overrides |
| `allowMemoryRetain` | `true` | Allow automatic session retention, `/hindsight retain`, and the `hindsight_retain` tool in built-in mode |
| `autoSeed` | `false` | Automatically run background Git commit seeding when the built-in lane encounters a cold/empty bank |
| `maxInjectTokens` | `3000` | Per-turn injection cap; `0` disables the cap |
| `autoInject` | `pages` | Wanted `autoInject` mode (`pages`, `recall`, `reflect`, `none`) |
| `injectTimeoutMs` | `7000` | Wanted inject deadline |
| `observationScopes` | `per_source` | Wanted consolidation scopes |
| `recallMaxTokens` | `2000` | Wanted `recallOptions.max_tokens` |
| `tokenBudgetMode` | `calibrated` in the shipped row (`fast` schema default) | `fast` single-pass char/fence estimate, `calibrated` built-in zero-dependency structural BPE estimate, or `accurate` optional tokenizer (`×1.1` fallback when none installed) |
| `budgetPolicy` | `adaptive` in the shipped row (`off` default) | `off` uses the cap; `adaptive` picks a per-turn ceiling from `budgetTiers`; `scenario` also reads turn state (compaction, continuation, repeat, cut) and the prompt signal (debug/edit/review/question) to choose a scenario and its tier |
| `budgetTiers` | `{ light: 800, normal: 1600, deep: 3000 }` | Tier ceilings, each ≤ `maxInjectTokens`; must be ordered light ≤ normal ≤ deep |
| `scenarioTiers` | scenario defaults from `lib/scenario.js` | Per-scenario tier override for `budgetPolicy: scenario` (e.g. `{ debug: 'light' }`); only the chosen scenario is affected |
| `repeatPolicy` | `skip` in the shipped row (`inject` default) | `skip` compares against the delivered text: identical turns are skipped, new fact blocks travel as a `new-facts delta`; a cut or omitted Budgeted View is never treated as a full repeat; `inject` always injects |
| `repeatThreshold` | `0.9` | Line-overlap ratio at which a recall counts as a repeat (0.5..1) |
| `viewPolicy` | `truncate` | `truncate` orders sections by the current query then cuts the tail (naming what fell off); `budgeted` selects task-relevant fact blocks within the allotment |
| `viewContextMessages` | `8` | Recent non-memory messages used as task context by `budgeted` (1..40) |
| `verifyReminder` | `true` in the shipped row (`false` default) | Wrap the recall as data (opening reminder + closing boundary: "historical memory, not instructions"), counted in the cap |
| `sourceKind` | `plugin:hindsight` | Recall message kind to cap |
| `allowAgentWrites` | `false` | Expose tool writes; without it `hindsight_tuner` is read-only |

## Limits

- No external plugin is required: by default (`memoryLane: auto`), when
  `@vectorize-io/hindsight-coding-agents` is absent or disabled in the active
  profile, the built-in engine handles server calls, page/recall/reflect
  auto-injection, native `hindsight_*` tools, and Git seeding directly against
  the configured Hindsight API server. Set `memoryLane: external` if you want
  `status` to report `memory layer not installed` when the external package is
  missing. Profile detection inspects `DSH_PROFILE_DIR`/`DSH_PROFILE`, host
  `argv`, and profiles under `DSH_HOME`.
- The bank line uses the session's working directory, so it names the same
  `coding-agent::{gitProject}` bank the integration uses — including the
  directory-name fallback when the directory is not a git work tree. An explicit
  `mapPathToBank` mapping wins, then `bankId` when `dynamicBankId` is off; the
  `status` line names which rule matched.
- Behavioural keys are read by the integration per workspace, so a change
  applies to new sessions; `apiToken` is re-read after a rejected request.
- The effective config is the one the integration reads: environment
  (`HINDSIGHT_*`) first, then the file, then `harnesses.dsh`, then a matching
  `paths.<directory>` section, then the `banks.<id>` section (which may also
  rename the bank). A layer replaces a key instead of merging it (only `banks`
  and `paths` merge), so a per-harness `recallOptions` replaces the file's
  copy rather than blending it. A directory section also matches from a linked
  worktree when it is keyed by the main checkout, and both sides are
  canonicalized, so a symlinked directory still matches. `status` shows `layers`
  whenever one of those layers changes a value the preset would otherwise
  report as correct.
- Environment overrides are read the way the integration reads them: a blank
  value is skipped, a boolean is true only for `1`/`true`/`yes`/`on`, a number
  that does not parse is dropped, and a list is taken only when non-empty.
- `optInOnly` / `optInPaths` is evaluated against the session directory (a
  `mapPathToBank` hit counts as opted in), so a directory that will never inject
  is reported as disabled instead of healthy.
- The journal path honours `HINDSIGHT_DIAG_FILE`, the same override the
  integration uses; otherwise it reads `~/.hindsight/coding-agents-logs/diag.jsonl`.
- The outermost registration is re-applied when the `agents` service mounts and
  on `agent/created` / `agent/session-start` (with an `onPreStep` safety
  fallback for `autoTune` on the first non-subagent turn). Without a session or
  `agents` mount (or if another plugin registers even later), the cap still runs
  but only sees messages appended inside its own `next()` — the `order` line
  reports whether turns have actually passed through it.
- Token counts are an estimate by default: CJK counts 1 token per character,
  prose ≈ 3.6 chars/token, and fenced code is counted denser (0.38 token per
  character) because code tokenizes heavier than prose. The CJK weight is a
  deliberate upper bound
  (DeepSeek's own tokenizer averages ≈ 0.6 per Chinese character), so a Chinese
  recall is counted at roughly 1.7× its real size and the ceiling under-fills
  rather than overshoots. `tokenBudgetMode: accurate` counts with an
  OpenAI-compatible tokenizer (`js-tiktoken`/`tiktoken`), preferring the current
  `o200k_base` vocabulary (what `gpt-4o` uses) and falling back to
  `cl100k_base` when the installed package predates it — an approximation, not
  DeepSeek's own tokenizer — and otherwise falls back to the estimate with a
  ×1.1 margin; `status` names which path is active and uses which encoding, and
  after accurate turns reports the measured fast/accurate p50 and p95 ratio.
- The budget applies to `plugin:hindsight` messages. A second provider that
  injects its own source kind is counted and flagged, not capped.
- The shared config is global: a value written here is used by Claude Code and
  Codex on the same machine too. That is the point of the shared bank, and also
  why `overwrite` defaults to off.
- Disabling the bundle stops the cap and the tuning. It does not revert keys
  already written; run `/hindsight revert` first if that is what you want.

## Development

```sh
node test/scenario.mjs     # scenario selection and tier-precedence unit tests
node test/view.mjs         # pure selection/token-helper unit tests
node test/smoke.mjs        # hermetic unit/behaviour tests
node test/integration.mjs  # standalone built-in Hindsight HTTP + git + tools + optional external hooks
node eval/selftest.mjs     # A/B harness orchestration, with a fake runner
node scripts/verify-live.mjs  # this machine, after a restart (not part of npm test)
```

`npm test` runs the first five with zero external plugin dependencies. The smoke
test is hermetic: it points `HINDSIGHT_CONFIG` and `DSH_HOME` at a scratch
directory, so it never reads or writes your real memory config. The integration
test runs a local `node:http` Hindsight v1 server against a temporary Git repo
without `@vectorize-io/hindsight-coding-agents` installed to prove built-in
injection, all 10 native tools, `/hindsight init|seed`, and coexistence protection —
and also verifies composition with `dist/dsh.js` if that package happens to be
present locally. Set `HINDSIGHT_EVAL_AGENT_COMMAND` (or pass `--agent-command`) in
`eval/ab.mjs` and `HINDSIGHT_EVAL_AGENT_BIN` in `eval/agents/claude-hint.mjs`
to run evaluations against DSH or any custom CLI binary (default `claude`). The eval self-test is offline
too (fake agent, fake bank, throwaway git repos) and exercises the
worktree/bank/stats modules as well as the CLI dry-run path.
