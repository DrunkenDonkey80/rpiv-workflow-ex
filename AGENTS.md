# Repository guidance

When code changes alter user-visible behavior, commands, switches, retry/resume semantics, installation steps, or safety boundaries, update the relevant documentation in the same change.

At minimum check:

- `README.md` for command behavior and operator-facing caveats.
- `package.json` metadata and shipped files when commands/files change.
- `.rpiv/artifacts/plans/` or validation artifacts when a workflow plan/checklist is being updated.

Do not leave behavior-changing code without matching docs.
