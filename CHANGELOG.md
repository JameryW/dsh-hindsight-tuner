# Changelog

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
