# Architecture and upgrade roadmap

This document records the design decisions behind `@jameryw/dsh-hindsight-tuner`
and the evidence gates that decide what gets built next. It is deliberately
short: the README explains *how to use* the plugin, this file explains *why it is
shaped this way* and what would have to be true to change that.

## 1. Scope: memory governance, not memory storage

The tuner does not store memories. It sits between the agent loop and the memory
backend and decides, per turn:

- **whether** an injected recall is worth its tokens (repeat safety, staleness),
- **which part** of it survives the budget (truncation or Budgeted View),
- **how much** the turn may spend (hard cap, adaptive tiers, token accounting),
- **what happened** (journal, status, diagnosis) so an experiment can be audited.

Hindsight remains the backend: Git cold start, Pages, Recall, consolidation and
history stay there. Rewriting that store, or building a new distributed memory
runtime, is explicitly out of scope until the gates in §4 prove a gap.

```
Agent / orchestrator (planner, workers, retries, DAG)
        │  claims messages, asks for memory
        ▼
dsh-hindsight-tuner — governance
   budget · selection · repeat safety · provenance · diagnosis · eval harness
        │  pages / recall / reflect
        ▼
Hindsight — backend
   Git cold start · Pages · Recall · consolidation · history
        │
        ▼  (only if a gate fails for storage-level reasons)
optional, evidence-gated: directory-affinity retrieval · fact promotion gate ·
multi-agent shared governance · alternative backends
```

The governing principle: **the backend owns storage and retrieval; the
governance layer owns what is worth injecting, how much, and whether a memory may
become a shared fact.**

## 2. Why this boundary

A stored memory is cheap to add and expensive to trust. The main failure modes
observed in early use were not retrieval quality but governance quality:

1. A recall cut to the budget was compared against the *raw* recall on the next
   turn, so the integration thought it was unchanged and the trimmed prefix was
   never expanded.
2. Repeat detection used an overlap ratio with a `min()` denominator, so a recall
   that contained everything from the previous turn *plus* new facts scored 1.0
   and was dropped — the new facts were lost.
3. A repeat was judged against the log, not the model surface. After a DSH
   compaction shadowed the earlier injection, the integration believed memory was
   still present and stopped injecting: memory silently disappeared.
4. Truncation kept the prefix, which is arbitrary. The paragraph that matched the
   task could be the one cut away.

Each fix is small and testable *because* storage lives elsewhere. Adding AST
retrieval, a fact-promotion gate or a shared memory service before those
governance bugs were fixed would have measured noise.

## 3. What the plugin owns today

| Concern | Mechanism | Status |
| --- | --- | --- |
| Hard per-turn cap | outermost `agent/pre-step`, re-registered on `agents` mount and `agent/created` / `agent/session-start` | shipped |
| Budget across messages | weighted water-filling (`allocateBudget`): equal share by default, query-relevance weights keep task evidence before unrelated text; no hidden floor | shipped |
| Over-budget payload | query-aware section selection rendered in original document order (prefix-cache safe), then structure-aware trim that names the dropped sections and the tools that recover them; fenced code measured denser; a long compact list is split between top-level items | shipped |
| Over-budget selection | Budgeted View: block ranking against the task text (compound-identifier subwords, CJK n-grams, word-boundary prose terms), parent heading mounted with a selected child, provenance footer, measured result | shipped, opt-in |
| Repeat safety | compare against delivered text; identical turns skipped; new blocks sent as a `new-facts delta`; history never removed; a cut or omitted Budgeted View does not count as a full repeat; the last full non-delta base is kept for compaction re-injection; a 20-minute pause resets stale cut state | shipped |
| Compaction safety | detect a shadowed injection from session events; re-inject the delivered text, labelled and counted | shipped |
| Adaptive spend | per-turn tier from recent activity and the prompt signal (a failing step outranks a continuation or the one-turn cooldown), with reasons in status | shipped |
| Diagnosis | endpoint/token/bank/routing/effective config/probe/journal classified into semantic classes, compatible integration lines, deprecated tool names | shipped |
| Evaluation | A/B harness: isolated worktrees, leak-prevention audit, bank fingerprint verified before, between arms and after (session retain off), pinned plugin version and tuner-config hash, attempts-to-success, task-level statistics, paired memory benefit/tax, MIDR + generalization gates, and written arm hints delivered through `eval/agents/claude-hint.mjs` | shipped |

Configuration stays opt-in at the plugin boundary for anything that changes
model-visible text in a new way: the schema defaults are `budgetPolicy: off`,
`repeatPolicy: inject`, `viewPolicy: truncate` and `verifyReminder: false`, so a
bare `apply()` reproduces the 0.x behaviour. The shipped bundle row is where the
measured policy is switched on (`budgetPolicy: adaptive`, `repeatPolicy: skip`,
`verifyReminder: true`), because skipping a duplicate removes text and the
reminder labels existing text rather than adding a new model-visible claim; a row
is a deliberate deployment choice, not a hidden plugin default. Budgeted View
(`viewPolicy: budgeted`) and the scenario policy stay opt-in until their A/B gates
are answered. The later additions keep the same rule: query-aware section ordering
only reorders the recall's own characters, and the verify reminder wraps the text
as untrusted data without adding a claim, so both are on in the shipped row; the
recoverable truncation pointer only changes the cut marker.

## 4. Evidence gates

No new capability is built until the previous gate is answered with a real task
A/B run. All arms below are defined by the same frozen bank snapshot and the same
task set; the primary comparison is preregistered before the run.

### P0 — is retry structure enough?

Arms: `R0` no hint, `R1` raw error, `R2` structured pitfall experience (≤500
tokens). Control `A0` estimates task difficulty. Run a few `A1/A3` pairs to
estimate variance before spending the run.

Pass: the dataset is complete (no dropped failures), each Arm/Repeat ran in an
isolated worktree on a recorded Git base SHA, and the bank/plugin fingerprints
are frozen and recorded. If structured retry removes most repeated failures,
keep `R2` and only validate long-term memory cheaply; do not expand memory.

### P1 — is memory worth more than handwritten conventions?

Arms `A0` no memory, `A1` handwritten conventions, `A2` Reflect, `A3` Pages. Pages
and Recall budgets are reported separately; Component Map and shared/per-source
ablations are run separately. Preregistered primary: **A3 vs A1**.

Pass: cost or retries improve by **≥15%** with a paired 95% CI that excludes
zero, and success is non-inferior. Stop: keep handwritten conventions + `R2`; no
long-term memory expansion.

### P2 — does selection beat truncation?

Same frozen bank: `A3` native Pages, `A3-T` Pages + tuner truncation, `A3-V`
Pages + Budgeted View. Ablate budget tiers, page count and repeat policy.

Pass: full-node cost drops **≥10%** without success degradation, stable across
tasks. Stop: if only injected tokens improve but task cost, retries or latency do
not, selection is a cosmetic change — revert it to opt-in and keep truncation.

### P3 — are promoted facts trustworthy?

`A4` orchestrator writes facts only after Validator + diff + test evidence;
`A5` retains raw session and can produce plausible false conventions. Run real
downstream tasks.

Pass: false facts cause measurable harm in `A5`, and the Oracle gate
significantly reduces that harm while retaining true facts. Stop: if pollution
harm is low or the gate has no stable gain, do not build promotion.

### P4 — build infrastructure only for a proven need

Only what P1–P3 showed cannot be delivered on the current backend.

## 5. Metrics

Primary:

- **Attempts to Success** — fixed max attempts per task; failed tasks are never
  dropped from the denominator.
- **Cost per Solved Node** — all attempt costs divided by solved nodes,
  cache-adjusted (prompt-cache hits must not be priced as fresh input).

Guardrails and efficiency:

- Task Success Rate: first-attempt success, final success, repeated failure
  signatures.
- Injected tokens, tool calls, p50/p95 wall time.
- Memory Precision: manual audit of promoted facts and whether their evidence
  covers the claim.
- False Fact Adoption: downstream tasks that act on a wrong promoted fact.

Statistics are task-level and paired, with a preregistered primary comparison,
stratified/clustered bootstrap and reported confidence intervals. Memory
timeouts and retrieval failures stay in the main analysis; they are never
dropped post-hoc.

## 6. Invariants the harness asserts

These are treated as executable tests, not intentions:

1. Every Arm/Repeat runs in a fresh worktree from a recorded base SHA.
2. Leak prevention (automated in `eval/leak.mjs`, refused before any run): tasks
   declare `asOf`; a starting commit created after that cutoff, a base commit
   named in the task's `exclude` list, a base commit shared by the `screening`
   and `confirmation` sets, and a checkout/prompt reused across the two sets are
   rejected. Only pre-cutoff history may
   be seeded into the bank — the fingerprint freezes what exists; choosing the
   cutoff while seeding stays an operator step.
3. Bank verifiability: A2/A3 share one pre-warmed frozen snapshot; A4/A5 are
   independently writable; the Bank/Pages version fingerprint is saved per run.
   The digest covers the Pages tree structure and the memory-bearing stats; the
   server's operation bookkeeping (queue and consolidation counters, last-write
   timestamps) and per-page refresh metadata (refresh timestamp, staleness flag)
   are excluded, because a healthy live bank moves them without changing a
   single memory.
4. Config verifiability (pinned in the report): the plugin version, resolved
   Bank ID and a sha256 of the tuner config are recorded before the run. A
   config change during the run fails the experiment (`autoTune` must not
   mutate it); `state.json` changes are recorded but only config changes are
   fatal.
5. Write visibility: facts written in A4/A5 must finish extraction, consolidation
   and an explicit Pages refresh before a downstream test reads them
   (`pageTriggerType: manual` does not auto-refresh).
6. Complete records: the journal is classified into `injected`, `unchanged`,
   `fallback`, `timeout`, `cacheHit`, `notRecalled`, `failed` and `other`
   (`activity.classes`), so a fallback or timeout is never read as a recall;
   "configured Reflect" is not treated as "Reflect executed".

## 7. v0.20 memory-governance upgrades

Four upgrades follow the 2026 evidence reviewed for this release. They are
deliberately small: each adds a check to the existing governance path rather than
changing the memory backend.

- **P36 — evidence anchors.** Budgeted View adds `EVIDENCE_BONUS = 0.15` to a
  block that carries a `commit`, `page`, or `path` anchor, exposes the collected
  anchors as a `Sources:` footer, and sets `verificationNeeded` when a kept block
  reads like a failure lesson without any anchor. The footer then tells the model
  to check current code/tests before acting. A plausible lesson without evidence
  is not promoted by prose alone.
- **P37 — monotonic snapshot declarations.** Every delivered memory view starts
  with `[snapshot #N — supersedes earlier memory-governor views]`, where `N`
  increases per session; re-injection after compaction also receives a fresh
  number. This prevents a compacted stale view from being read as current. The
  status surface reports the cordis runtime version, isolate-realm readiness
  (>= 4.1.0), and whether the root config has an `include` section, so a hot
  reload cannot silently leave the plugin on an old boundary.
- **P38 — evaluation-bank isolation and capability probing.** `uniqueBankId()`
  appends a UTC timestamp plus random suffix to a bank name, and `--fresh-bank`
  refuses to combine with a fixed `--bank` or `--verify-fingerprint`. A
  crash-retry therefore cannot delete or reuse a newly created same-name bank.
  `probeCapabilities()` reports separated embedding and operation-validator
  support; when no capability endpoint exists it returns `ok: false` rather than
  inventing a capability.
- **P39 — MIDR gate and generalization check.** `memoryValue()` reports MIDR
  (memory-induced degradation rate) as the share of shared tasks whose success
  rate falls below the baseline. `memoryGate()` defaults to a 5% ceiling and the
  A/B report fails the gate above it. `generalizationCheck()` warns when tasks
  have no training/held-out split or when the experiment covers only one agent
  family, so a tuned harness cannot claim broad generalization from one model.

## 8. Roadmap

| Version | Content | Gate |
| --- | --- | --- |
| 0.15 | repeat-rate fix, delta recall, safe re-injection after compaction, regression tests | must |
| 0.16 | reproducible A/B harness: worktrees, bank fingerprints, attempts/statistics | must |
| 0.17 | Budgeted View: block selection, provenance footer, measured budget | after P1 shows memory value |
| 0.18 | scenario-aware budget, `scenarioTiers` overrides (shipped opt-in; Pages/Recall policy optimization still after P2) | after P2 |
| 0.19 | Oracle fact promotion, conflict detection, rollback/audit | after P3 confirms harm |
| 0.20 | evidence-anchored selection, snapshot declarations, fresh eval banks/capability probe, MIDR + generalization gates | after the corresponding A/B gates |
| 1.0 | unified memory governance for distributed DAG agents | only on real production demand |

Decision tree: P0 retry structure solves most repeated failures → keep `R2` and
validate memory cheaply. If room remains → P1 `A3` vs `A1`. If memory is worth
it → validate Budgeted View (P2). If pollution causes real harm → validate the
promotion gate (P3). Build a memory runtime only if the existing stack proves
insufficient.

## 9. Deliberately not doing now

- Rewriting the Hindsight store or consolidation pipeline.
- OpenViking TrieHI, a default Hy-Memory-30B-A3B extractor, a global
  `per_source` mandate.
- Proving value by token reduction alone.
- A new TiKV/Qdrant/PostgreSQL memory service.
- Treating the current three budget tiers or dedupe thresholds as optimal without
  ablation.

The one-line summary: **Hindsight stores memory, the tuner governs memory,
Budgeted View improves information per token, and real task A/B runs decide what
is built next.**
