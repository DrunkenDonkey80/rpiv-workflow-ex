# Changelog

All notable changes to `rpiv-workflow-ex` are documented here.

## Unreleased

### Added

- Auto-answered workflow questions are now instructed to append reviewable bullets to `docs/rpiv-wfex-decisions/<runId>_decisions.md`.
- `/wfex decisions [@<runId>|all]` lists recorded auto decisions and timestamps; without args it uses the active workflow or latest log.

## [0.2.3] - 2026-06-29

### Fixed

- Usage-limit (429) auto-retry now actually fires. It previously never armed for most providers: the SDK throws on a non-2xx 429 *before* the `onResponse` callback runs, so `after_provider_response` never carried status 429 and the retry hook was effectively dead (e.g. for OpenAI-compatible providers like glm/`zai-coding-cn`). The retry now arms on `agent_end`, which reliably fires on the error turn and carries the "429" text. `after_provider_response` is retained as a belt-and-suspenders arm path and still owns the clear-on-2xx.
- The retry now survives a terminal stage failure. A 429 that stops the workflow ("implement failed — stopping workflow") fires `workflow_end`, which previously cleared the retry and cleared `activeRunId` — so the run was never resumed. The retry is no longer cleared on `workflow_end`; `fireRetry` resumes by its captured runId even after `activeRunId` was cleared, bailing only if a *different* run is active.
- Non-English reset strings no longer block the retry. Providers that emit e.g. Chinese `…重置 <datetime>` are covered by the 10-minute poll fallback (the English `resets HH:MM (TZ)` precise-wait still applies where present). Added `detectUsageLimitError` and a self-check covering the agent_end arm + terminal-failure resume path.

## [0.2.2] - 2026-06-29

### Fixed

- GitHub and npm installs no longer report `rpiv-wfex: @juicesharp/rpiv-workflow is not installed.` on a fresh machine. Those installs land in `~/.pi/agent/git/<host>/<owner>/<repo>/` — a sibling of the agent npm store — so the bare `import("@juicesharp/rpiv-workflow")` never resolved (only local-path installs got a `node_modules` symlink). The runtime is now self-locating: a shared `runtime.ts` resolves the peer from the agent npm store via `createRequire` and imports the file URL, which jiti transpiles (the same path that loads the extension). Verified end-to-end. No per-machine symlink is needed; both the command runtime and the watchdog `/startup` import use it.

## [0.2.1] - 2026-06-29

### Fixed

- `safe`/`unattended` auto mode no longer stalls on skill-body developer checkpoints (e.g. blueprint/design slice gates like "Slice N/M: … Approve? / Revise / Rethink / Revisit a decision"). The autonomy directives now carry an explicit `SKILL-CHECKPOINT OVERRIDE` clause that wins the prompt-priority contest over a skill body instructing "ask the developer" — such checkpoints are auto-answered Recommended without rendering the question, since they are routine gates, not safety stops.

## [0.2.0] - 2026-06-29

### Changed

- `/wfex auto` now persists the selected mode to `~/.pi/agent/wfex-prefs.json` and restores it on every session start with a visible notification.
- Auto mode is no longer reset when a workflow run ends — it is a global preference, not run-scoped.

### Fixed

- Peer dependency resolution error on startup when the extension is installed from a local path (symlinked `node_modules` to the pi agent npm store).

## [0.1.0] - 2026-06-29

### Added

- `/wfex resume` and `/wfex runs` for workflow recovery and visibility.
- `/wfex continue` to advance past interrupted stages that already wrote a fresh matching artifact.
- `/wfex auto off|safe|unattended` full-auto switch for low-touch workflow runs.
- Usage-limit retry loop for 429 responses, including retry-after parsing and reset-string detection.
- Runtime watchdog for orphaned workflow runs.
- Self-check scripts for loading, continue behavior, and rate-limit retry behavior.
- Operator README and repository guidance for keeping docs in sync with behavior changes.

[0.2.3]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.2.3
[0.2.2]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.2.2
[0.2.1]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.2.1
[0.2.0]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.2.0
[0.1.0]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.1.0
