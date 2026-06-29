# rpiv-wfex — autonomy + resilience sidecar for rpiv-workflow

`rpiv-wfex` makes [`@juicesharp/rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow)
runs **autonomous** and **crash-resilient** — without editing rpiv-workflow or rpiv-pi. It is an
additive Pi extension that reuses the existing engine through its public API + Pi hooks (the same
shape as rpiv-pi's in-tree `rpiv-core/model-override.ts` sidecar). The original `/wf` stays the
runtime; this package only adds `/wfex …` commands and four hooks.

## What it does

1. **Autonomy** — a `before_agent_start` directive (active runs only) tells the model to
   auto-select the Recommended / most-complete option on the mechanical confirmation gates that
   live in rpiv-pi skill bodies (confirm slice / approve work / approve commit / proceed?). The one
   true safety stop (the `implement` plan vs. working-tree mismatch) is **exempted** and still halts.
2. **Resilience** — a `session_start` watchdog detects runs orphaned by the continue-policy
   `waitForIdle` freeze (when Pi disposes the session mid-stage and the engine's await never
   resolves) and auto-resumes them.
3. **Resume UX** — `/wfex resume` and `/wfex runs`.
4. **Full-auto mode** — `/wfex auto safe|unattended|off` (default `off`) branches the autonomy
   directive. `safe` auto-answers the substantive decision prompts too (default Recommended;
   override to a more-complete option only when strictly additive and not deferred to a later
   stage) while genuine safety stops still halt. `unattended` auto-answers everything EXCEPT a
   plan/working-tree mismatch (still halts). In-memory only — reset on a Pi process restart.
5. **Usage-limit retry** — an `after_provider_response` observer catches a 429 usage limit and
   re-sends `/wfex resume` until the window resets (parsing a "resets HH:MM (TZ)" reset time when
   present, else polling ~every 10 min), bounded by a ~8h wall-clock cap then notify + stop.

## Commands

| Command | Effect |
|---|---|
| `/wfex resume` | Resume the newest resumable run (auto-picked). |
| `/wfex resume @<ref>` | Resume a specific run by name or run-id. |
| `/wfex continue [@<ref>]` | Advance PAST a stage that was interrupted but actually finished — instead of cold-re-running it. |
| `/wfex runs` | List runs with last-stage status; resumable ones flagged. |
| `/wfex auto` | Report the current full-auto tier. |
| `/wfex auto off\|safe\|unattended` | Set the full-auto tier (in-memory). |

### resume vs. continue

`/wf @id` (and `/wfex resume`) key on the trail's last row: a `completed` row routes
onward, but a `failed`/`aborted` row makes the engine **re-enter that stage** — so if `/wf`
died mid-stage after the skill already wrote its artifact, resume re-runs the whole stage
("10 minutes redoing todos that were already done").

`/wfex continue` fixes exactly that: it finds a fresh artifact matching the interrupted
stage (newer than the failed/aborted trail row), asks you to confirm it, appends a synthetic
`completed` row crediting that artifact, then resumes — which now advances to the **next**
stage. It refuses mid-loop trailers and cold-reruns when no fresh stage artifact exists.
The watchdog deliberately stays on plain `resume`: auto-advancing past a failure without a
human check is unsafe.

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

## Usage-limit retry

On a 429, Pi's own provider auto-retry exhausts and the run would die in-chat; the sidecar's
watchdog never sees it (it keys on session disposal, a different failure mode). The retry loop
re-sends `/wfex resume @<runId>` until a non-429 response clears it. **Tune Pi's `retry.provider`**
(longer/more attempts) so short blips are absorbed by Pi and the loop only handles the hard
multi-hour wall.

## Caveats

- **Watchdog is best-effort.** It relies on `session_start` firing after a disposal and on an
  idle-debounce heuristic; if the signal doesn't arrive, fall back to `/wfex resume`.
- **Cold re-run on resume.** A frozen stage wrote no final row, so resume re-runs it cold. Verify
  side-effect stages (esp. `commit`) are idempotent before trusting unattended overnight runs. A
  per-run auto-resume attempt cap (3) bounds the blast radius.
- **Auto-mode is in-memory.** Lost on a Pi process restart; set it again after `/reload`.
- **`unattended` still halts on a plan/working-tree mismatch** — the one irreversible carve-out.
- **Bounded retry ≠ idempotent stages.** The ~8h cap bounds blast radius but does not make a
  non-idempotent stage (esp. `commit`) safe to cold-re-run after a limit reset.
- **Precise reset wait depends on the "resets HH:MM" string** appearing in `agent_end` messages;
  the API-style 429 carries no reset clock, so that surface falls back to 10-min polling.
- **Full-auto auto-credits artifacts without confirmation.** When `auto` is `safe`/`unattended`, a
  resume of a failed/aborted stage with an on-disk artifact is credited (advanced past) WITHOUT the
  human check `/wfex continue` normally carries — using the same stage + freshness boundary as
  manual continue: the artifact must match the stage and be newer than that failed/aborted row's
  timestamp. Stale or unmatched artifacts fall back to a cold re-run. This is the opt-in blast
  radius of full-auto; `off` keeps the cold re-run.

## Upstream alignment

Built against `@juicesharp/rpiv-workflow` **v1.20.0**, commit
`faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`. On an upstream bump, re-verify the public API used:
`resumeWorkflowByRunId`, `listRuns`, `readLastStage`, `registerLifecycle`, and the
`before_agent_start` / `session_start` event shapes. Pin recorded in `package.json` under `rpiv`.
