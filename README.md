# dsh-hindsight-tuner

Token-budgeted tuning and diagnostics for Hindsight project memory inside DeepSeek Harness.

It complements [`@vectorize-io/hindsight-coding-agents`](https://www.npmjs.com/package/@vectorize-io/hindsight-coding-agents)
rather than replacing it. That integration owns the memory (Git seeding, pages,
cross-tool banks); this bundle owns three things it does not provide:

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
   `agent/pre-step` waterfall listener (`prepend: true`, re-registered once on
   the first session start so it ends up outside the Hindsight hook regardless
   of bundle load order). It therefore sees the final message list and enforces
   one shared ceiling: the sum of every `plugin:hindsight` message in a turn is
   at most `maxInjectTokens`. Trimming is structure-aware: it cuts at a paragraph
   boundary or after a closed code fence (so markdown never ends inside an open
   fence) and only falls back to a line/character cut when no boundary fits. A
   message that cannot fit even the marker is dropped. Across messages the
   budget is water-filled rather than proportionally cut: a short recall that
   fits within an equal share is kept whole, and the larger messages take the
   remainder. There is no hidden 32-token floor — a tiny cap stays tiny (the
   minimum useful cap is `0`, which disables trimming). Because the integration
   dedupes by comparing the new recall against the last injected text, a trimmed
   message never matches, so every turn is re-trimmed to the same ceiling instead
   of letting a full-size payload through on the next turn.

   By default a turn may spend the whole cap. `budgetPolicy: adaptive` instead
   picks a ceiling per turn from `budgetTiers` (light/normal/deep, defaults
   800/1600/3000, never above `maxInjectTokens`), with a reason the status
   prints: the first recall of a session takes `deep` because nothing is in
   context yet; a recall that mostly repeats the previous one (line overlap
   ≥60%) or follows a turn that had to be cut takes `light`, because the model
   already has that text; otherwise the smallest tier the recall fits is used.
   The tier is a ceiling, not a target, and `status` shows the table, the last
   choice with its reason and the per-tier counts (`status --json` carries the
   same as data). `budgetPolicy: off` keeps the single hard ceiling.

   Duplicate governance is separate from the budget: with `repeatPolicy: skip`
   (default `inject`), a recall that mostly repeats the previous turn's text
   (line overlap ≥ `repeatThreshold`, default 0.9) is not injected again at all.
   The earlier message is still in the conversation, so the content is not lost;
   `status` reports the skipped turns, the tokens saved and the last repeat
   ratio, and the recall line shows the turn as `last ~N → ~0 tok`.

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
   in the *same* turn. It names the installed integration version and flags a
   version outside the `0.8.x` line the CI integration test covers, because the
   hook contract is private to that package. It also detects a **stale process**:
   when the journal's newest failure still targets a different origin than the
   effective config, the running DSH predates the config change and will keep
   failing until it is restarted — a state no amount of correct file content
   fixes, so `/hindsight` names it on its own `process` line, with the age of the
   evidence; the claim expires after 15 minutes so an old failure cannot cry wolf
   forever. Journal entries are filtered by harness (a Claude Code failure is not
   DSH's), and failures whose URL points at a different origin than the
   configured server are counted separately instead of being folded into the
   auth-failure total. `/hindsight suggest` proposes a cap from the journal's own
   p95 recall size without writing anything. When the journal has addressed more
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
   tool saving the JSON is not blocked, which is why the rename guard exists.

5. **Writes the model cannot authorize itself.** The `hindsight_tuner` tool is
   read-only by default (`status`, `probe`, `suggest`, and `dryRun` previews).
   `tune`, `revert`, `enable` and `disable` are exposed to the tool only when the
   profile row sets `allowAgentWrites: true`; there is no `confirm` flag, because
   a flag the model fills in is not a permission boundary. The user-typed
   `/hindsight tune` / `/hindsight revert` command is the intended write path.

6. **A recall is evidence, not authority.** Pages are written by an earlier
   session; by the time they are injected the code they describe may already
   have changed. With `verifyReminder: true` (on in the shipped row), the
   injected recall opens with one short line telling the model to check the
   current code and tests before acting on remembered claims. The reminder is
   part of the measured payload, so it is counted against the same ceiling as
   the recall itself — turning it on cannot silently overrun the budget. The
   `trust` line in `/hindsight` reports whether it is active.

The plugin's own journal (`<DSH_HOME>/storages/dsh-hindsight-tuner/tuner.jsonl`)
is buffered rather than written on every event: entries are flushed in one
append after 250 ms, immediately when 500 are pending, on dispose, and on a
normal process exit — diagnostics never sit on the model's critical path.

## Measuring memory

What the plugin can observe from inside the loop is reported as `memory` in
`status --json` and as one line in `/hindsight`: over the last 24 hours, how many
recalls were fresh (`inject_ok`) versus unchanged (`inject_unchanged`), the
resulting freshness percentage, how many pages were consolidated (`pages_ok`),
and how many server calls failed (`pages_failed` + `retain_failed` +
`reflect_failed`). Together with the budget accounting (`trimmedTokens`,
`savedTokens`, per-tier counts) that is enough to see whether memory is being
delivered and whether the budget is doing anything — not whether it *helped*.

Task-success measurement cannot live here honestly: the plugin never sees whether
a task passed, so a self-reported "Memory Precision@K" would be a guess. A real
A/B of memory policies needs an external harness that runs the same task set
under arms (no memory / pages / recall / tuned tiers) and scores the outcomes,
then compares Task Success Rate, stale-memory errors, tokens per successful task
and p95 recall latency. The plugin makes that harness possible by exposing the
budget, freshness and savings as JSON; it does not pretend to be the harness.

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
- `/hindsight probe` — one reachability check, no journal read.
- `/hindsight suggest` — read-only cap/recall recommendation from the recent
  injection sizes.
- `/hindsight tune [--dry-run] [--overwrite] [--cap N]` — apply the lean profile
  now; `--cap` changes the session ceiling only.
- `/hindsight revert [--dry-run]` — undo this plugin's keys and persist an
  auto-tune opt-out, so a restart does not refill them.
- `/hindsight enable` / `/hindsight disable` — turn the persistent auto-tune
  opt-out back on or off. `disable` leaves existing keys untouched.

The same operations are exposed to the agent as the `hindsight_tuner` tool
(`status`, `probe`, `suggest`; plus `tune`, `revert`, `enable`, `disable` when the
row sets `allowAgentWrites: true`), and both call the same implementation. A
tool call cannot escalate itself: `dryRun` previews are always allowed, writes
are not.

## Coexistence

This bundle owns the Hindsight lane only. What it does and does not coordinate:

- It caps and diagnoses `@vectorize-io/hindsight-coding-agents` injections
  (`plugin:hindsight`). It does not configure or cap another memory provider.
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
| `maxInjectTokens` | `3000` | Per-turn injection cap; `0` disables the cap |
| `autoInject` | `pages` | Wanted `autoInject` mode |
| `injectTimeoutMs` | `7000` | Wanted inject deadline |
| `observationScopes` | `per_source` | Wanted consolidation scopes |
| `recallMaxTokens` | `2000` | Wanted `recallOptions.max_tokens` |
| `tokenBudgetMode` | `fast` | `fast` estimate or `accurate` tokenizer (optional `js-tiktoken`) |
| `budgetPolicy` | `adaptive` in the shipped row (`off` default) | `adaptive` picks a per-turn ceiling from `budgetTiers`; `off` uses the cap |
| `budgetTiers` | `{ light: 800, normal: 1600, deep: 3000 }` | Tier ceilings, each ≤ `maxInjectTokens`; must be ordered light ≤ normal ≤ deep |
| `repeatPolicy` | `skip` in the shipped row (`inject` default) | `skip` drops a recall that repeats the previous turn; `inject` always injects |
| `repeatThreshold` | `0.9` | Line-overlap ratio at which a recall counts as a repeat (0.5..1) |
| `verifyReminder` | `true` in the shipped row (`false` default) | Prefix the recall with a one-line "verify against current code/tests" reminder, counted in the cap |
| `sourceKind` | `plugin:hindsight` | Recall message kind to cap |
| `allowAgentWrites` | `false` | Expose tool writes; without it the tool is read-only |

## Limits

- It needs `@vectorize-io/hindsight-coding-agents` for memory itself. The plugin
  checks whether that package resolves from the profile; when it does not,
  `status` says `memory layer not installed` and changes nothing on the model path.
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
  rename the bank). `status` shows `layers` whenever one of those layers changes
  a value the preset would otherwise report as correct.
- `optInOnly` / `optInPaths` is evaluated against the session directory (a
  `mapPathToBank` hit counts as opted in), so a directory that will never inject
  is reported as disabled instead of healthy.
- The journal path honours `HINDSIGHT_DIAG_FILE`, the same override the
  integration uses; otherwise it reads `~/.hindsight/coding-agents-logs/diag.jsonl`.
- The outermost registration is re-applied on the first non-subagent session
  start. Without a session (or if another plugin registers later), the cap still
  runs but only sees messages appended inside its own `next()` — the `order` line
  reports whether a turn has actually passed through it.
- Token counts are an estimate by default (CJK ≈ 1 token/char, other text ≈
  3.6 chars/token). `tokenBudgetMode: accurate` uses `js-tiktoken` when it is
  installed and otherwise falls back to the estimate with a ×1.1 margin; `status`
  names which path is active and, after accurate turns, reports the measured
  fast/accurate p50 and p95 ratio.
- The budget applies to `plugin:hindsight` messages. A second provider that
  injects its own source kind is counted and flagged, not capped.
- The shared config is global: a value written here is used by Claude Code and
  Codex on the same machine too. That is the point of the shared bank, and also
  why `overwrite` defaults to off.
- Disabling the bundle stops the cap and the tuning. It does not revert keys
  already written; run `/hindsight revert` first if that is what you want.

## Development

```sh
node test/smoke.mjs        # hermetic unit/behaviour tests
node test/integration.mjs  # real @vectorize-io/hindsight-coding-agents hooks
```

The smoke test is hermetic: it points `HINDSIGHT_CONFIG` and `DSH_HOME` at a
scratch directory, so it never reads or writes your real memory config. The
integration test loads the shipped Hindsight `dist/dsh.js`, registers its real
`agent/pre-step` hook after the tuner, and asserts the payload the model would
receive is inside the ceiling; it skips (exit 0) when the package is not
installed, and CI installs it so every job runs it for real.
