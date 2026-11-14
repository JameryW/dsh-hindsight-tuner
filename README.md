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

2. **A hard per-turn injection budget.** The tuner registers as the *outermost*
   `agent/pre-step` waterfall listener (`prepend: true`, re-registered once on
   the first session start so it ends up outside the Hindsight hook regardless
   of bundle load order). It therefore sees the final message list and enforces
   one shared ceiling: the sum of every `plugin:hindsight` message in a turn is
   at most `maxInjectTokens`. Trimming happens on a line boundary with an
   explicit marker; a message that cannot fit even the marker is dropped. There
   is no hidden 32-token floor — a tiny cap stays tiny. Because the integration
   dedupes by comparing the new recall against the last injected text, a trimmed
   message never matches, so every turn is re-trimmed to the same ceiling
   instead of letting a full-size payload through on the next turn.

3. **A diagnosis that does not lie.** With no token configured, the integration
   fails silently on every turn (`pages_failed`, `inject_unchanged`, `401` in
   its own journal). `/hindsight` reports the endpoint, token source, bank and
   routing source, probe result, journal activity, and the *effective* config —
   including `HINDSIGHT_*` environment overrides and the `harnesses.dsh` layer
   the integration applies on top of the file. That makes "no memory" distinct
   from "no token", "server down", "bank not seeded", and "another hook wraps
   the budget". It also reports per-session turn count, last/max/average recall
   tokens, and whether more than one plugin injected in the *same* turn.

4. **Writes that survive a crash and a second process.** The shared config is
   written under a sidecar lock, through a `0600` temporary file that keeps a
   stricter target mode, with a journal written before the config. If DSH dies
   between the two commits, the next run folds the journal into the applied map
   by comparing the live value, so `/hindsight revert` still works. A tool call
   that would write needs `confirm: true` (or `allowAgentWrites: true`); the
   `/hindsight` command is user-initiated and does not.

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
- `/hindsight probe` — one reachability check, no journal read.
- `/hindsight tune` — apply the lean profile now.
- `/hindsight revert` — undo this plugin's keys.

The same operations are exposed to the agent as the `hindsight_tuner` tool
(`status`, `tune`, `revert`, `probe`), and both call the same implementation.
Tool-initiated `tune`/`revert` require `confirm: true` (or the row's
`allowAgentWrites`); `dryRun` previews are always allowed.

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
  (with version and enabled state), so a stacked setup is visible without
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
| `sourceKind` | `plugin:hindsight` | Recall message source kind to cap |
| `allowAgentWrites` | `false` | Let the agent tool write the shared config without `confirm: true` |

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
  (`HINDSIGHT_*`) first, then the file, then `harnesses.dsh`. `status` shows
  `layers` whenever those layers change a value the preset would otherwise
  report as correct.
- The journal path honours `HINDSIGHT_DIAG_FILE`, the same override the
  integration uses; otherwise it reads `~/.hindsight/coding-agents-logs/diag.jsonl`.
- The outermost registration is re-applied on the first non-subagent session
  start. Without a session (or if another plugin re-registers later), the cap
  still runs but only sees messages appended inside its own `next()` — the
  `order` line reports whether a turn has actually passed through it.
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
