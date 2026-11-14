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
   added.

2. **A hard per-turn injection budget.** A recall that arrives larger than
   `maxInjectTokens` is cut on a line boundary with an explicit truncation
   marker. This matters because the integration dedupes by comparing the new
   recall against the last injected text: a trimmed message never matches, so
   the tuner also drops that duplicate instead of letting a full-size payload
   through on the following turn.

3. **A diagnosis that does not lie.** With no token configured, the integration
   fails silently on every turn (`pages_failed`, `inject_unchanged`, `401` in
   its own journal). `/hindsight` reports the endpoint, token source, bank,
   probe result and journal activity, so "no memory" is distinguishable from
   "no token" and "server down".

## Install

Clone the repository and install the directory as a local bundle:

```sh
git clone https://github.com/JameryW/dsh-hindsight-tuner.git
```

Then in DSH: **Plugins → Add plugin**, choose the cloned directory, and enable
the bundle. The install links the checkout, so edits here reach the profile on
the next DSH restart; the profile keeps its own copy of the row config.

## Use

- `/hindsight` — health, tuning, budget and journal activity for this session.
- `/hindsight probe` — one reachability check, no journal read.
- `/hindsight tune` — apply the lean profile now.
- `/hindsight revert` — undo this plugin's keys.

The same operations are exposed to the agent as the `hindsight_tuner` tool
(`status`, `tune`, `revert`, `probe`), and both call the same implementation.

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
| `sourceKind` | `plugin:hindsight` | Recall message source kind to cap |

## Limits

- It needs `@vectorize-io/hindsight-coding-agents` for memory itself. The plugin
  checks whether that package resolves from the profile; when it does not,
  `status` says `memory layer not installed` and changes nothing on the model path.
- The bank line uses the session's working directory, so it names the same
  `coding-agent::{gitProject}` bank the integration uses — including the
  directory-name fallback when the directory is not a git work tree.
- Behavioural keys are read by the integration per workspace, so a change
  applies to new sessions; `apiToken` is re-read after a rejected request.
- Token counts are an estimate (CJK ≈ 1 token/char, other text ≈ 3.6 chars/token),
  not a tokenizer.
- The shared config is global: a value written here is used by Claude Code and
  Codex on the same machine too. That is the point of the shared bank, and also
  why `overwrite` defaults to off.
- Disabling the bundle stops the cap and the tuning. It does not revert keys
  already written; run `/hindsight revert` first if that is what you want.

## Development

```sh
node test/smoke.mjs
```

The smoke test is hermetic: it points `HINDSIGHT_CONFIG` and `DSH_HOME` at a
scratch directory, so it never reads or writes your real memory config.
