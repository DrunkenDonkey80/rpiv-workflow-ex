# Changelog

All notable changes to `rpiv-workflow-ex` are documented here.

## [0.1.0] - 2026-06-29

### Added

- `/wfex resume` and `/wfex runs` for workflow recovery and visibility.
- `/wfex continue` to advance past interrupted stages that already wrote a fresh matching artifact.
- `/wfex auto off|safe|unattended` full-auto switch for low-touch workflow runs.
- Usage-limit retry loop for 429 responses, including retry-after parsing and reset-string detection.
- Runtime watchdog for orphaned workflow runs.
- Self-check scripts for loading, continue behavior, and rate-limit retry behavior.
- Operator README and repository guidance for keeping docs in sync with behavior changes.

[0.1.0]: https://github.com/DrunkenDonkey80/rpiv-workflow-ex/releases/tag/v0.1.0
