# rpiv-wfex — autonomy + resilience sidecar for rpiv-workflow

`rpiv-wfex` makes [`@juicesharp/rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow)
runs **autonomous** and **crash-resilient** — without editing rpiv-workflow or rpiv-pi. It is an
additive Pi extension that reuses the existing engine through its public API + Pi hooks (the same
shape as rpiv-pi's in-tree `rpiv-core/model-override.ts` sidecar). The original `/wf` stays the
runtime; this package only adds `/wfex …` commands and three hooks.

## What it does

1. **Autonomy** — a `before_agent_start` directive (active runs only) tells the model to
   auto-select the Recommended / most-complete option on the mechanical confirmation gates that
   live in rpiv-pi skill bodies (confirm slice / approve work / approve commit / proceed?). The one
   true safety stop (the `implement` plan vs. working-tree mismatch) is **exempted** and still halts.
2. **Resilience** — a `session_start` watchdog detects runs orphaned by the continue-policy
   `waitForIdle` freeze (when Pi disposes the session mid-stage and the engine's await never
   resolves) and auto-resumes them.
3. **Resume UX** — `/wfex resume` and `/wfex runs`.

## Commands

| Command | Effect |
|---|---|
| `/wfex resume` | Resume the newest resumable run (auto-picked). |
| `/wfex resume @<ref>` | Resume a specific run by name or run-id. |
| `/wfex continue [@<ref>]` | Advance PAST a stage that was interrupted but actually finished — instead of cold-re-running it. |
| `/wfex runs` | List runs with last-stage status; resumable ones flagged. |

### resume vs. continue

`/wf @id` (and `/wfex resume`) key on the trail's last row: a `completed` row routes
onward, but a `failed`/`aborted` row makes the engine **re-enter that stage** — so if `/wf`
died mid-stage after the skill already wrote its artifact, resume re-runs the whole stage
("10 minutes redoing todos that were already done").

`/wfex continue` fixes exactly that: it finds the artifact the interrupted stage produced,
asks you to confirm it, appends a synthetic `completed` row crediting that artifact, then
resumes — which now advances to the **next** stage. It refuses mid-loop trailers and any run
with no artifact to credit (use `/wfex resume` there). The watchdog deliberately stays on
plain `resume`: auto-advancing past a failure without a human check is unsafe.

## Install

```bash
pi install npm:rpiv-workflow-ex
```

This package ships raw `.ts` — Pi loads it via jiti, no build step. It self-registers on load.
Install it the same way as `@juicesharp/rpiv-workflow` (a peer) so both land in the same Pi npm
root and the runtime import resolves. Verify with `/wfex runs` after `/reload`.

## Model selection (config-only, not shipped here)

Pin the strongest model + `xhigh` thinking for `blueprint`/`design` + judges in
`~/.config/rpiv-pi/models.json` (consumed by rpiv-core's existing lifecycle — no code in this
package). Example:

```json
{
  "stages": { "blueprint": { "model": "<best-model>", "thinking": "xhigh" }, "design": { "model": "<best-model>", "thinking": "xhigh" } },
  "skills": { "judge": { "model": "<best-model>", "thinking": "xhigh" } }
}
```

## Caveats

- **Watchdog is best-effort.** It relies on `session_start` firing after a disposal and on an
  idle-debounce heuristic; if the signal doesn't arrive, fall back to `/wfex resume`.
- **Cold re-run on resume.** A frozen stage wrote no final row, so resume re-runs it cold. Verify
  side-effect stages (esp. `commit`) are idempotent before trusting unattended overnight runs. A
  per-run auto-resume attempt cap (3) bounds the blast radius.

## Upstream alignment

Built against `@juicesharp/rpiv-workflow` **v1.20.0**, commit
`faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`. On an upstream bump, re-verify the public API used:
`resumeWorkflowByRunId`, `listRuns`, `readLastStage`, `registerLifecycle`, and the
`before_agent_start` / `session_start` event shapes. Pin recorded in `package.json` under `rpiv`.
