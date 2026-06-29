# rpiv-wfex

`rpiv-wfex` is a small Pi extension that helps `@juicesharp/rpiv-workflow` runs finish instead of stalling on routine prompts, frozen sessions, or usage-limit resets.

It does **not** fork or patch rpiv-workflow. It adds `/wfex …` commands and lifecycle hooks beside the normal `/wf` runtime, so upstream updates stay easy to compare and adopt.

## Why use it?

Long workflow runs often stop for reasons that are not real decisions:

- mechanical confirmations like "approve work", "approve commit", or "proceed";
- a Pi session disappearing while the workflow engine is still waiting;
- a model/provider usage limit ending the turn before the workflow can continue;
- an interrupted stage that already wrote its artifact, so a plain resume would redo work.

`rpiv-wfex` handles those cases with the least extra machinery possible:

1. injects an autonomy directive while a workflow run is active;
2. tracks the active run and resumes orphaned runs;
3. offers `/wfex continue` to credit a fresh artifact and advance past a completed-but-interrupted stage;
4. retries `/wfex resume @<runId>` after usage-limit 429s until the reset window passes;
5. lets you opt into `safe` or `unattended` auto-decision modes for overnight runs.

The goal: **get the project to completion without asking you to babysit obvious choices**, while still halting on the one dangerous case that should not be automated: applying a plan against a mismatched working tree.

## Install

From npm, once published:

```bash
pi install npm:rpiv-workflow-ex
```

From this repo:

```bash
pi install /path/to/rpiv-workflow-ex
```

Then restart Pi or run `/reload`, and verify:

```text
/wfex runs
```

This package ships raw `.ts`; Pi loads it through jiti. Install it in the same Pi environment as `@juicesharp/rpiv-workflow` so the peer import resolves.

## Commands

| Command | Effect |
|---|---|
| `/wfex` | Same as `/wfex resume`: resume the newest workflow run worth resuming. |
| `/wfex resume` | Resume the newest failed/aborted/incomplete run, or newest run if none is clearly incomplete. |
| `/wfex resume @<ref>` | Resume a specific run by id or name. |
| `/wfex continue` | Pick the newest root failed/aborted run that can be advanced past an already-written artifact. |
| `/wfex continue @<ref>` | For a specific run, find a fresh stage-matched artifact, ask once, write a synthetic completed row, then resume to the next stage. |
| `/wfex runs` | List known workflow runs and their last-stage status. |
| `/wfex auto` | Show the current auto mode. |
| `/wfex auto off` | Default. Only the original rote-confirmation autonomy is active. |
| `/wfex auto safe` | Auto-answer routine and substantive decisions using the Recommended/strictly-better heuristic; still halt on safety stops. |
| `/wfex auto unattended` | Auto-answer everything except the plan-vs-working-tree mismatch. Use only when you accept the blast radius. |

## Auto-mode switches

### `off`

Baseline mode. The extension only nudges mechanical confirmations so the workflow does not pause on rote gates. Substantive decisions still ask.

### `safe`

Best default for long runs. It auto-picks:

- the option marked **Recommended**;
- or a more-complete option only when it is strictly additive, has no drawback, and is not deferred to a later phase.

It logs each auto-decision with the question, every option it saw, the chosen option, and the reason. It still halts for genuine safety stops, especially destructive/data-loss prompts and plan/working-tree mismatch checks.

### `unattended`

Maximum autonomy. It uses the same decision heuristic but proceeds through almost every prompt. The only hard stop left is a plan/working-tree mismatch, because applying a plan to an unexpected tree is where automation becomes expensive.

Auto-mode is in-memory. It resets to `off` when the active run ends or Pi restarts.

## Resume vs continue

`/wfex resume` follows rpiv-workflow's normal resume semantics. If the last trail row is failed or aborted, the engine re-enters that stage.

`/wfex continue` is for the common case where the stage actually finished and wrote an artifact, but the workflow died before recording the completed row. It:

1. reads the run's last row;
2. accepts only root `failed`/`aborted` stages with parseable timestamps;
3. finds a fresh `.rpiv/artifacts/**/*.md` file matching that stage and newer than the failed row;
4. asks before mutating the trail;
5. appends a synthetic completed row and resumes onward.

If anything is stale, unmatched, unreadable, or cancelled, it cold-reruns instead.

## Usage-limit retry

When a provider returns HTTP 429 during an active run, Pi may exhaust its own short retry loop and leave the workflow dead in chat. `rpiv-wfex` arms a bounded retry loop:

- uses `retry-after` seconds when present;
- uses HTTP-date `retry-after` when present;
- scans `agent_end` text for strings like `resets 7:30pm (Europe/Berlin)`;
- otherwise polls about every 10 minutes;
- stops after about 8 hours and clears active run state.

Tune Pi's own `retry.provider` for short blips; this extension is for longer usage-window resets.

## Model settings

If you use rpiv-pi model overrides, keep them in:

```text
~/.config/rpiv-pi/models.json
```

A practical setup is strong models with `high` thinking for planning/review stages, and `medium` for implementation/validation. `xhigh` works, but can be painfully slow and expensive for routine runs.

## Caveats

- Watchdog resume is best-effort; if no lifecycle signal fires, run `/wfex resume` manually.
- Retry does not make non-idempotent stages safe. A cold re-run of a side-effecting stage can still repeat work.
- `unattended` is intentionally sharp. Prefer `safe` unless you really want the run to keep moving.
- Full-auto artifact credit is intentionally conservative: stale or unmatched artifacts fall back to cold re-run.

## Upstream alignment

Built against `@juicesharp/rpiv-workflow` **v1.20.0**, commit `faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`.

On an upstream bump, re-check the public API used here:

- `resumeWorkflowByRunId`
- `listRuns`
- `readLastStage`
- `appendStage`
- `registerLifecycle`
- Pi events: `before_agent_start`, `session_start`, `workflow_end`, `after_provider_response`, `agent_end`

The pin is also recorded in `package.json` under `rpiv`.
