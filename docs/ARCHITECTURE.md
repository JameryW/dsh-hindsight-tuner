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
| Budget across messages | water-filling (`allocateBudget`), no hidden floor | shipped |
| Over-budget payload | structure-aware trim (headings/fences preserved) | shipped |
| Over-budget selection | Budgeted View: block ranking against the task text, provenance footer, measured result | shipped, opt-in |
| Repeat safety | compare against delivered text; identical turns skipped; new blocks sent as a `new-facts delta`; history never removed | shipped |
| Compaction safety | detect a shadowed injection from session events; re-inject the delivered text, labelled and counted | shipped |
| Adaptive spend | per-turn tier from recent activity, with reasons in status | shipped |
| Diagnosis | endpoint/token/bank/routing/effective config/probe/journal | shipped |
| Evaluation | A/B harness: isolated worktrees, frozen bank, attempts-to-success, task-level statistics | shipped |

Configuration stays opt-in for anything that changes model-visible text in a new
way: `viewPolicy: budgeted` and `repeatPolicy: skip` are validated settings, not
defaults smuggled into a release.

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
2. Leak prevention: only history available before the task timestamp is readable;
   the target fix commit/PR is excluded; screening and confirmation task sets are
   disjoint.
3. Bank verifiability: A2/A3 share one pre-warmed frozen snapshot; A4/A5 are
   independently writable; the Bank/Pages version fingerprint is saved per run.
4. Config verifiability: `autoTune` cannot change the experiment's config; the
   plugin version and resolved Bank ID are pinned in the report.
5. Write visibility: facts written in A4/A5 must finish extraction, consolidation
   and an explicit Pages refresh before a downstream test reads them
   (`pageTriggerType: manual` does not auto-refresh).
6. Complete records: the journal distinguishes successful injection, fallback,
   timeout, cache hit and not-recalled; "configured Reflect" is not treated as
   "Reflect executed".

## 7. Roadmap

| Version | Content | Gate |
| --- | --- | --- |
| 0.15 | repeat-rate fix, delta recall, safe re-injection after compaction, regression tests | must |
| 0.16 | reproducible A/B harness: worktrees, bank fingerprints, attempts/statistics | must |
| 0.17 | Budgeted View: block selection, provenance footer, measured budget | after P1 shows memory value |
| 0.18 | scenario-aware budget, `scenarioTiers` overrides (shipped opt-in; Pages/Recall policy optimization still after P2) | after P2 |
| 0.19 | Oracle fact promotion, conflict detection, rollback/audit | after P3 confirms harm |
| 1.0 | unified memory governance for distributed DAG agents | only on real production demand |

Decision tree: P0 retry structure solves most repeated failures → keep `R2` and
validate memory cheaply. If room remains → P1 `A3` vs `A1`. If memory is worth
it → validate Budgeted View (P2). If pollution causes real harm → validate the
promotion gate (P3). Build a memory runtime only if the existing stack proves
insufficient.

## 8. Deliberately not doing now

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
