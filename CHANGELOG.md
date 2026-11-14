# Changelog

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
