# Eval infrastructure (experiment-grade A/B harness)

Reproducible A/B evaluation for the Hindsight memory plugin. The suite is
dependency-free (Node >= 22 builtins only, ESM, no build step) and runs the same
way on Windows, macOS and Linux.

What changed from the old per-arm aggregate harness:

- every run is isolated in a **git worktree** pinned to a recorded base SHA;
- every task gets up to `maxAttempts` attempts, and **every attempt is a row**;
- the Hindsight **bank is fingerprinted** (Pages tree + stats) before/around a run;
- statistics are **paired at the task level** with a task-cluster bootstrap and a
  preregistered primary comparison;
- failed, errored and timed-out runs are **never dropped**; structural gaps are
  reported through a completeness check.

## Quick start

```bash
# 1. offline proof that the tooling itself works (no network, no agents)
node eval/selftest.mjs          # prints: eval selftest: 61 checks passed

# 2. inspect the plan without spending anything (your own task file, see below)
node eval/ab.mjs --tasks my-tasks.json --arms A3,A1 --primary A3:A1 --dry-run

# 3. capture a frozen bank fingerprint, then run the experiment
node eval/ab.mjs --tasks tasks.json --arms A3,A1 --primary A3:A1 --repeats 5 \
  --fingerprint-out experiments/p1-bank.json --report experiments/p1.json

# 4. a follow-up run must verify the same bank
node eval/ab.mjs --tasks tasks.json --arms A3,A1 --primary A3:A1 --repeats 5 \
  --verify-fingerprint experiments/p1-bank.json --report experiments/p1-rerun.json
```

Useful flags: `--attempts N` (default 3, per-task `maxAttempts` wins),
`--timeout ms` (default 600000), `--no-isolate`, `--keep-worktrees`,
`--reset-between-attempts`, `--allow-unmet-requires`, `--worktree-root <dir>`,
`--prices <file>`, `--bootstraps N` (default 4000), `--seed N` (default
20260101), `--json`. Run `node eval/ab.mjs --help` for the complete list.

`--dry-run` prints the matrix (tasks, arms + env, repeats, attempts, worktree
roots, bank/fingerprint actions) and exits 0 without spawning agents or touching
the bank. Exit code 1 means a harness error (bad flags/tasks, git failure,
unknown arm, fingerprint drift); a **completed experiment exits 0 even when every
task failed**. A worktree that cannot be deleted after the run is reported as a
warning in `cleanupErrors` and does not change the exit code — the rows and the
report are already complete.

## Task file

```json
{
  "tasks": [
    {
      "id": "fix-failing-test",
      "prompt": "Fix the failing test in test/parser.test.mjs ...",
      "cwd": "C:/work/fixture-repo",
      "check": ["node", "--test", "test/parser.test.mjs"],
      "maxAttempts": 3,
      "checkCwd": ".",
      "env": { "FIXTURE_MODE": "strict" }
    }
  ]
}
```

- `id` (unique non-empty string), `prompt` (non-empty), `cwd` (directory) and
  `check` are required.
- `check` accepts a string (`"node script.js --flag"`), an argv array, or
  `{ "command": "...", "args": [...] }`; it is spawned without a shell and its
  exit code is the pass/fail truth. For real grading use an array/object so
  quoting is unambiguous.
- `maxAttempts` (optional, integer >= 1) overrides `--attempts`.
- `checkCwd` (optional) resolves relative to the run cwd (worktree when
  isolated, otherwise `task.cwd`).
- `env` (optional) is merged into the agent and check environments. Precedence:
  `process.env` < `task.env` < `arm.env` < eval-pinned
  `HINDSIGHT_HARNESS=eval`, `HINDSIGHT_ARM=<arm>`, `HINDSIGHT_ATTEMPT=<n>`.
- `asOf` (required when any selected arm uses memory): the ISO instant when the
  task's history was frozen. A future cutoff is refused, and when `baseSha` is
  also given, a starting commit created after the cutoff is refused — the
  starting tree could already contain the fix.
- `set` (optional, `screening` or `confirmation`): the two sets must not reuse
  the same checkout and prompt, so the confirmation set is not chosen by the
  tasks it confirms.
- `exclude` (optional): commit or PR references that must stay out of the task's
  history; naming the starting commit there is refused.
- `baseSha` (optional): the expected pre-fix base commit, checked against
  `asOf` and `exclude` when both are present.

Leak prevention is a harness error, not a warning: evidence that cannot show its
own history cutoff is not evidence. The audit runs for `--dry-run` too, and the
resolved rules are printed (or included in `--json`) as the `leakage` field.

Tasks must be deterministic: no wall-clock, network or unseeded randomness
dependence, and the check must be runnable in a fresh checkout.
`eval/tasks.example.json` is a schema template: its `cwd` values are placeholder
fixture paths, so create your fixture repositories (or edit the paths) before
running it. A dry run marks such tasks with `[cwd missing]`.

## Isolation

For a task whose `cwd` is inside a git repository and isolation is enabled
(default), the harness:

1. resolves `git rev-parse --show-toplevel` and the base commit SHA;
2. creates a **detached** worktree in a unique temp directory
   (`<os.tmpdir()>/dsh-hindsight-eval-worktrees/...` by default;
   `--worktree-root` overrides the parent);
3. reuses that worktree for every attempt of the run (`git reset --hard
   <baseSha> && git clean -fdx` between attempts with
   `--reset-between-attempts`, so committed and ignored state from earlier
   attempts cannot leak into later ones);
4. removes it with `git worktree remove --force` + `git worktree prune`
   (`--keep-worktrees` keeps it for inspection).

A task whose `cwd` is a subdirectory of the repository runs in the matching
subdirectory of the worktree, not at its root.

The base SHA of every worktree is recorded in `report.worktrees[]` together with
the task's repository-relative `rel` offset and the resolved `cwd`, so a result
can be reproduced from that commit. The main checkout is never written to.
Only isolated runs appear there: non-git `task.cwd` directories run in place
(`--no-isolate` does the same everywhere) and are visible in the report only
through their rows, the experiment's `isolate` flag and the dry-run plan.

## Arm matrix and gates

Gate ids (`P0`-`P3`) and arm names (`R0`-`R2`, `A0`-`A5`) are **local naming
conventions for this suite**, not upstream plugin/API names. The matrix lives in
[`eval/arms.example.json`](arms.example.json); `--arms` takes a CSV of names from
that file, a custom arms JSON file, or an inline JSON array. Default arms are
`A0,A2,A3`.

| Gate | Question | Arms | Preregistered primary |
| --- | --- | --- | --- |
| P0 | Failure-feedback protocol: does structured failure information reduce attempts? | R0 no hint, R1 raw error, R2 structured pitfall | `R2:R0` |
| P1 | Memory source: do Hindsight Pages beat no memory and handwritten conventions? | A0 no memory, A1 handwritten conventions, A2 reflect, A3 pages | `A3:A1` |
| P2 | Injection view/budget: truncation vs Budgeted View at equal memory | A3 native pages, A3-T tuner truncation, A3-V Budgeted View | `A3-V:A3` (secondary `A3-T` vs `A3`) |
| P3 | Fact provenance: oracle-promoted facts vs raw session facts | A4 oracle-promoted facts, A5 raw session facts | `A4:A5` |

`--primary TREATMENT:BASELINE` is preregistration: the report always shows the
difference **treatment − baseline** (negative cost/attempts favours the
treatment; positive success favours it). Set it before the run; do not choose a
comparison after seeing the data.

Some arms cannot be expressed by environment variables alone and list this in
`requires`. Selecting such an arm **fails fast with the missing setup** unless
`--allow-unmet-requires` is passed, because the harness cannot verify that the
setup was done; the flag only records the operator's assertion and warns on
stderr. The same gate applies to `--dry-run` (the plan itself is what the flag
unlocks); a plan lists every arm's `hint`/`requires`.

- **A3-V** needs the DSH plugin profile setting `settings.viewPolicy=budgeted`
  (lib/view.js) pinned before the run; `HINDSIGHT_PAGE_SEARCH_LIMIT` only covers
  the page search limit.
- **A1** needs either the fixture repository to contain the handwritten
  conventions file (AGENTS.md/CLAUDE.md) before worktrees are created, or the
  same conventions delivered as a written hint: set `HINDSIGHT_EVAL_HINT` in the
  arm's `env` and point `--agent-command` at `node eval/agents/claude-hint.mjs …`
  (see below).
- **A4/A5** need two differently seeded banks; run each bank as its own
  experiment with its own fingerprint, or pin a per-arm `HINDSIGHT_BANK_ID`.
- `HINDSIGHT_EVAL_HINT` is an eval-only convention for the agent command
  wrapper; it is not a plugin knob.

The harness writes the task prompt to the agent's **stdin**, so a wrapper is
what turns `HINDSIGHT_EVAL_HINT` into prompt text. `eval/agents/claude-hint.mjs`
reads stdin, prepends a non-empty hint (separated by `\n\n---\n\n`), runs the
real `claude` CLI with the same arguments, and pipes the modified prompt to it;
with an empty hint the prompt passes through unchanged, so one command serves
every arm:

```bash
--agent-command '["node","<repo>/eval/agents/claude-hint.mjs","-p",
                   "--output-format","json","--permission-mode","acceptEdits"]'
```

Use it for the gate P0 arms (R1/R2 failure feedback) and for A1. `report.json`
still records each arm's `hint` as metadata; the wrapper is the only component
that acts on it.

## Metrics

A **run** is one `(task, arm, repeat)` cell and consists of one or more
**attempt rows**. A run succeeds when any attempt passes; attempts stop at the
first pass. Attempt rows carry `passed`, `tokens`, `usage`, `durationMs`,
`cost`, `failureSignature` and `error`; derived runs carry `attempts` and
`successAtAttempt`.

- **Task Success Rate** – solved runs / runs for the arm. Failed, errored and
  timed-out runs are included.
- **First-attempt success** – runs that passed on attempt 1 / runs.
- **Attempts to Success** – mean attempt number over solved runs (null when no
  run was solved).
- **Cost per Solved Node** – total cost of all attempts for the arm divided by
  the number of solved runs. With `--prices` this is USD; without prices every
  price is zero and cost equals the row's token count (`tokens`: input+output,
  or the agent-reported total), so the metric is a **token proxy** (documented in
  the report as `costUnit`). Cache-token prices only apply when a price list is
  supplied, so the proxy stays on the same scale as the `tokens` metric. "Node"
  here means the solved unit task; the harness measures per solved run, not per
  memory node.
- **Tokens / tokens per success** – mean total tokens per run, and total tokens
  divided by solved runs.
- **Duration p50/p95** – percentiles over per-run summed attempt durations.
- **Memory Benefit / Tax / NetValue** – paired against the no-memory baseline
  (auto-detected as `R0`, else `A0` in the shipped arm list). For every task present in both arms, `rate(t)` is the fraction
  of that task's runs that passed; `Benefit` is the mean of `max(0, rate − rate_base)`,
  `Tax` the mean of `max(0, rate_base − rate)`, and `NetValue = Benefit − Tax`
  (all in success-rate units, 0..1). `regressedTaskIds` lists the tasks where the
  arm solved less than the baseline, so a positive net value cannot hide a
  regressed task; a metric report is emitted as `report.memory` and printed as a
  `memory value vs <baseline>` block.
- **Memory Precision (manual audit)** – of the memory statements actually
  injected into the agent context, the fraction that are relevant and correct
  for the task. This is a human audit: sample injected memories (e.g. 20 per
  arm), have at least one reviewer score each statement, and record
  `{arm, sampled, relevantAndCorrect, notes}` alongside the JSON report.
- **False Fact Adoption (manual)** – fraction of runs in which the agent used a
  memory statement that is contradicted by the repository/oracle facts in its
  reasoning or patch. Scored from transcripts/reports by the same audit pass;
  record `{arm, runsAudited, adoptedFalseFact}`.

Manual metrics are deliberately not invented by the harness. Keep the audit
sheet with the report so the numbers can be rechecked.

## Statistics

`pairedComparison(rowsBaseline, rowsTreatment, {seed, bootstraps, alpha})`
computes per-task values from **all repeats of that task kept together** (the
cluster is the task), then differences `treatment − baseline` for:

- cost per solved run (tasks where both arms have at least one solved run),
- mean attempts per task,
- success rate per task.

Statistical inference is a **task-cluster bootstrap**: resample tasks with
replacement 4000 times, take the observed mean difference, report the 95%
percentile interval, and a two-sided bootstrap p-value
(`2 * min(P(diff <= 0), P(diff >= 0))` with the usual `+1` correction). The RNG
is mulberry32 seeded by `--seed`, so identical input and seed give identical
numbers. `n` is the number of tasks contributing to that metric; when a task has
no defined value (e.g. no solved run in one arm) it is excluded from that
metric only, never silently from the report.

There is no post-hoc exclusion: no "drop timeouts", no "drop the slow task", no
switching the primary comparison. If the completeness check reports problems
(missing task/arm/repeat cells, attempt gaps, attempts after a pass, malformed
`passed` flags), the experiment is incomplete and should be re-run rather than
filtered. A complete run may legitimately contain failed/timeout rows – those
are listed explicitly in the text report.

## Bank fingerprint (reproducibility)

Defaults: `apiUrl` = `HINDSIGHT_API_URL` or `http://127.0.0.1:9077`; bank id =
`HINDSIGHT_BANK_ID` or `coding-agent::<basename(repo)>`; token =
`HINDSIGHT_API_TOKEN` only when the API needs one (sent as `Authorization:
Bearer`).

`captureFingerprint` reads
`GET /v1/default/banks/<url-encoded id>/pages/tree` (falling back to the legacy
`/knowledge-base/tree` on 404) and `GET .../stats`, canonicalises the JSON with
sorted keys and stores a sha256 over `{tree, stats}` in a fingerprint file that
also records `apiUrl`, `bankId`, `capturedAt` and `timeoutMs`. The server's
operation bookkeeping is filtered out of that digest (`operations_by_status`,
`pending_operations`, `failed_operations`, `pending_consolidation`,
`failed_consolidation`, `last_consolidated_at`, `last_memory_write_at`): a live
bank queues refreshes and maintenance on its own, and those counters move
without any memory changing. Memory-bearing stats (node/link counts,
`nodes_by_fact_type`, …) and the Pages tree stay in the digest, so a real change
still fails the check. Fingerprint files from the older format are refused with
`capture a new baseline with --fingerprint-out`; recapture once after upgrading.

`--fingerprint-out <file>` captures **before** the experiment and writes it.
`--verify-fingerprint <file>` re-captures **before** the experiment and aborts
with a structural diff if the Pages tree or the memory-bearing stats changed. The
fingerprint file's `apiUrl`/`bankId` are used when `--api-url`/`--bank` are not
passed. Per-page refresh metadata (`timestamp`, `is_stale`,
`last_refresh_failed_at`) is also excluded: a refresh cron rewrites it without
changing a page's identity, description or tags, and the diff would otherwise
name a page refresh as memory drift.
- With either option, the harness checks the fingerprint again before the first
  run of every new arm and once at the end of the matrix; a change aborts with
  `bank fingerprint check failed before arm <name>: …` (or `before the
  experiment finished`) instead of comparing arms measured against different
  memory. Attempts also run with `HINDSIGHT_RETAIN_SESSIONS=false` unless the
  task or arm declares its own value, so a run does not mutate the bank it is
  being measured against.

Freeze one bank per experiment. Never compare arms measured on different banks.
For A4/A5 use two separate experiments, each with its own frozen fingerprint.

## Reproducibility checklist

Record with every reported result:

1. **Worktree base SHA** – in `report.worktrees[]` (and the task cwd commits).
2. **Bank fingerprint** – the sha256 and the fingerprint file; assert `bank.verified`.
3. **Arm env** – `report.arms[].env` (what was pinned on top of the task env).
4. **Tuner settings, plugin version and config pin** – the report pins
   `experiment.plugin` (name/version), `experiment.bankId` and
   `experiment.tuner` (config path + sha256, state path, `autoTune`,
   `configUnchanged`, `stateChanged`). The run fails if the config hash changes
   before the end, so `autoTune` cannot silently drift the arm; still record the
   resolved values from the report. `state.json` changes are recorded but only a
   config change is fatal.
5. **Agent and model** – `--agent-command` (recorded in `report.experiment.agent`)
   including model/version flags.
6. **Seed/bootstraps/alpha** and the preregistered `--primary`.
7. **Prices** file when cost is in USD (otherwise note the token proxy).
8. **Manual audit sheet** for Memory Precision / False Fact Adoption.

## Report shape

```jsonc
{
  "generatedAt": "2026-...",
  "repeats": 5,
  "arms": [{ "name": "A3", "env": { ... }, "hint": "...", "requires": [] }],
  "tasks": [{ "id": "...", "prompt": "...", "cwd": "...", "check": {...} }],
  "rows": [ /* one row per attempt: taskId, arm, repeat, attempt, passed, tokens,
               usage, durationMs, cost, failureSignature, error */ ],
  "runs": [ /* taskId, arm, repeat, passed, attempts, successAtAttempt,
               tokens, cost, durationMs */ ],
  "metrics": { "A3": { /* summarizeArm fields */ }, "A1": { ... } },
  "completeness": { "ok": true, "problems": [] },
  "leakage": { "ok": true, "checked": 12,
               "sets": { "screening": 8, "confirmation": 4 }, "problems": [] },
  "memory": { "baseline": "A0", "tasks": 12, "arms": [ /* benefit/tax/net */ ] },
  "primary": "A3:A1",
  "prices": { ... } ,
  "bank": { "apiUrl", "bankId", "verified", "fingerprint", "capturedAt", ... },
  "worktrees": [{ "taskId", "arm", "repeat", "path", "repo", "baseSha",
                  "rel", "cwd" }],
  "experiment": { "startedAt", "finishedAt", "agent", "timeoutMs", "seed",
                  "allowUnmetRequires", "armRequires",
                  "plugin": { "name": "@jameryw/dsh-hindsight-tuner", "version": "0.18.0" },
                  "bankId": "coding-agent::repo",
                  "tuner": { "configPath", "configSha256", "statePath",
                             "autoTune", "appliedAtStart", "configUnchanged",
                             "stateChanged" } },
  "cleanupErrors": []
}
```

Text reports contain the arm table, the preregistered paired comparison,
completeness warnings, the explicit "failed, errored and timed-out runs are
included in every rate and cost" line, the failed-run inventory and a task × arm
solved/runs matrix.

## Limitations

- **Bank writes need an explicit Pages refresh before downstream runs.** The
  integration/refresh timing is asynchronous; capture the fingerprint only after
  the bank has settled. A fingerprint taken mid-ingest can drift during the
  experiment even though the harness itself never writes to the bank.
- **The fingerprint proves tree/memory-stats equality only.** It does not hash page
  bodies, embeddings, recall scoring config or pending operation contents, so two
  banks with equal tree+stats can still retrieve differently. Operation
  bookkeeping is deliberately excluded — a live bank's refresh cron and
  maintenance change those counters without changing memory.
- **Tokenizer estimate vs exact.** Token counts come from the agent's own JSON
  usage when available; cost is computed from those counts and the supplied
  price list. Without a prices file, cost equals the row's `tokens` count, which
  is not comparable across models/tokenizers and should not be interpreted as
  money.
- **Attempts change the success definition.** A run succeeds on any passing
  attempt, so failure feedback (P0 hints) and memory quality interact; compare
  attempts only between arms with the same attempt policy and hint handling.
- **Isolation requires git.** Non-git tasks share `task.cwd`; side effects can
  leak between repeats unless the task itself is idempotent.
- **Windows can keep a worktree locked briefly.** Cleanup retries the removal for
  a few seconds; if an agent hook is still finishing, the directory is left in
  place, listed in `cleanupErrors`, and the run still exits 0. Remove leftovers
  manually (or use `--keep-worktrees` deliberately).
- **Manual metrics are not automated.** Memory Precision and False Fact Adoption
  require a human audit and a recorded sampling rule.
- **Leak audit proves the metadata, not the seeding.** `asOf`, `baseSha` and the
  screening/confirmation split are asserted automatically, but whether only
  pre-cutoff history was actually seeded into the bank is still an operator step:
  the fingerprint freezes the resulting bank, it cannot tell how it was built.
- **`state.json` drift is recorded, not fatal.** A run fails only when the tuner
  config file changes; `autoTune` bookkeeping in `state.json` is reported as
  `experiment.tuner.stateChanged` for review.
- **P3 needs two banks.** One `--fingerprint-out` covers the primary bank; use
  per-arm `HINDSIGHT_BANK_ID` plus separate runs for a full two-bank comparison.
- **A3-V cannot be selected by env alone.** Pin the DSH plugin profile
  `viewPolicy` (and record it) before running that arm.

## Files

| File | Responsibility |
| --- | --- |
| `eval/worktree.mjs` | git worktree isolation: `repoRootOf`, `baseShaOf`, `createWorktree`, `verifyWorktree`, `disposeWorktree`, `resetWorktree`, `withWorktree` |
| `eval/bank.mjs` | bank resolution, Pages tree/stats fingerprinting, fingerprint files, `verifyFingerprint`/`assertFrozen` |
| `eval/stats.mjs` | attempt-row costs, `summarizeArm`, `assertComplete`, task-cluster `pairedComparison`, `formatStatsReport` |
| `eval/leak.mjs` | leak-prevention audit: `asOf`/`baseSha` cutoff, `exclude` targets, screening/confirmation disjointness |
| `eval/harness.mjs` | attempts-aware `evaluate`, derived runs, `formatReport`, `writeReport` |
| `eval/ab.mjs` | CLI: flags, task/arm loading, worktree + bank lifecycle, agent/check spawning, JSON report |
| `eval/selftest.mjs` | offline deterministic selftest (temp git repo, fake bank, synthetic rows, CLI dry runs) |
| `eval/arms.example.json` | gate/arm matrix with pinned env and documentation fields |
| `eval/README.md` | this document |

## Selftest

`node eval/selftest.mjs` runs entirely offline: it creates a throwaway git
repository (three commits), asserts worktree creation/isolation/drift/dispose and
that `--reset-between-attempts` discards committed, staged, untracked and ignored
state, starts local `node:http` fake banks to exercise fingerprint capture
(including URL encoding and legacy fallback), drift detection and frozen
verification, checks completeness/cost/bootstrap statistics against synthetic
rows, drives the harness attempts loop with fake runners, and runs the real CLI
several times with `--dry-run` (text and JSON plans, unmet-requires refusal,
report warning) plus one end-to-end run against a temporary repository with a
fake agent. It finishes in a few seconds, requires no network or real agent, and
exits non-zero with per-check details on failure.
