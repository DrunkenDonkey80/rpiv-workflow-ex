---
date: 2026-06-25T10:42:04+0300
author: Flex
commit: no-commit
branch: no-branch
repository: unknown
topic: "Autonomous + resilient + resumable rpiv-workflow via a non-invasive sidecar extension"
tags: [research, codebase, rpiv-workflow, rpiv-pi, pi-extensions, autonomy, resilience, resume]
status: ready
last_updated: 2026-06-25T10:42:04+0300
last_updated_by: Flex
---

# Research: Autonomous + resilient + resumable rpiv-workflow via a non-invasive sidecar extension

## Research Question

Fork/extend the rpiv-workflow extension to: (1) remove the artificial human-confirmation
guards (confirm slice, approve work, approve commit) and auto-answer easy questions using the
strongest model + thinking mode, always preferring the more-complete option; (2) stop the
workflow from "derailing" — when it hits a decision, a model limit, or an error it stops and
"the orchestrator is gone," continuing in-chat instead of resuming the loop — by making it more
robust and/or adding a `/wf resume` that continues an active run or reports it done and lists
active runs; (3) keep changes surgical and re-mergeable, record the upstream version/git-hash
alignment, and decide whether the original must be disabled.

**Developer-confirmed direction (see Developer Context):** achieve all three via an **additive
sidecar extension + pi hooks + commands**, touching neither `rpiv-workflow` nor `rpiv-pi`. This
is strictly preferable to copying code because there is then nothing to re-merge.

## Summary

All three goals are achievable as a **pure sidecar extension** modelled on the existing
`rpiv-core/model-override.ts` — which already augments rpiv-workflow at runtime via
`registerLifecycle` + pi events, editing zero engine code. Findings:

- **Goal 1 (autonomy) — the guards are model instructions, not engine code.** The workflow
  engine has **zero** human-confirmation seams; the chain walks fully autonomously
  (`runStageOrRecordFailure → advanceChain → runNext`). Every "confirm slice / approve work /
  approve commit" gate is an `ask_user_question` call **inside the rpiv-pi SKILL bodies** (~23
  mechanical gates + 1 true safety stop). Because skills are instructions the model chooses to
  follow, a sidecar can override them at the prompt level via `before_agent_start` (inject a
  system-prompt directive: "autonomy mode — auto-select the Recommended/most-complete option on
  mechanical gates; only ask on true safety stops"), scoped to active workflow runs. Model +
  thinking pinning (best model, `xhigh` for blueprint/design and judges) is **config-only** in
  `~/.config/rpiv-pi/models.json` — no code at all.

- **Goal 2 (resilience + resume) — resume already exists; the freeze has a precise root cause.**
  `/wf @<runId>` resume is **fully functional today** (`command.ts` parse → `resumeWorkflowByRunId`
  → `reconstructState` → `selectResumeEntry`). The "orchestrator gone" freeze is `continue`-policy
  stages awaiting `ctx.waitForIdle()` at `sessions/spawn.ts:69` with **no timeout/abort**: when Pi
  disposes the session (model-limit or auto-compaction), that promise never resolves, the run
  freezes mid-stage, and **no failure row is written** (incomplete JSONL). A sidecar handles both
  without engine edits: a `session_start`/`session_shutdown` **watchdog** (track an in-flight run
  via `registerLifecycle`; on an unexpected session re-fire, auto re-invoke `resumeWorkflowByRunId`
  for the orphaned runId) + a `/wfex resume` command (auto-pick newest resumable run via public
  `listRuns`/`readLastStage`, then `resumeWorkflowByRunId`) and a `/wfex runs` lister.

- **Goal 3 (surgical / version / disable) — pivot: nothing to disable, nothing to merge.** Because
  the sidecar **reuses** the original engine (it calls the public API and subscribes to lifecycle
  events), the original `/wf` extension stays **enabled** as the runtime. There is no command
  collision (sidecar adds `/wfex …`, never re-registers `/wf`), no engine fork, and therefore no
  re-merge burden. Record upstream alignment in the sidecar's own `package.json`
  (`upstreamBase: "1.20.0"`, `upstreamCommit: "faa0f9d…"`). The only caveat is the
  lifecycle-double-registration trap (below): the sidecar must **not** ship its own copy of the
  model-override lifecycle, since rpiv-core already registers one globally.

## Detailed Findings

### Engine autonomy — there are no gates to remove (rpiv-workflow)
- The chain is a mutual recursion composed exactly once: `CHAIN_DEPS = { runNext: … }`
  (`runner/run-stage.ts:56-60`). The sole catch site is `runStageOrRecordFailure`
  (`runner/run-stage.ts:86-98`); every stage routes through it.
- Success continuation is synchronous: a stage's `onSuccess` calls `advance(...)`
  (`runner/run-stage.ts:180`) → `advanceChain` (`runner/chain-advance.ts:19-63`) → `deps.runNext`
  (`chain-advance.ts:63`). **No pause/confirm/await-user seam exists on this path.**
- The only in-engine "stall" is `sessionPolicy: "continue"` (`stage-def.ts:60`, contract at
  `stage-def.ts:308-314`): it reuses the live session via `host.sendUserMessage` + `ctx.waitForIdle`
  (`sessions/spawn.ts:84-92`) — a deterministic send→wait→extract cycle, not a user gate.
- **Implication:** an autonomy layer must NOT touch the engine. The gates live one layer up.

### Where the guards actually live (rpiv-pi skills)
- Confirmed gate sites: `skills/commit/SKILL.md:61` ("{N} commit(s)… Proceed?"), the "Stop — do
  not proceed" safety directive at `skills/commit/SKILL.md:42`, and `skills/plan/SKILL.md:318`
  (applied/deferred/dismissed blocker triage, batched at `:324`). The analyzer's census across
  `commit, plan, blueprint, design, discover, implement, revise, research, validate, explore`
  found ~24 `ask_user_question`/"Stop" gates total: ~23 mechanical checkpoints that an autonomy
  variant can auto-answer by always selecting the Recommended / more-complete option, and **1 true
  safety stop** (the implement plan/working-tree mismatch) to preserve.
- These are authored in Markdown skill bodies — i.e. **instructions to the model**. The model
  decides whether to emit an `ask_user_question` tool call. A higher-priority system-prompt
  directive can therefore suppress the mechanical ones without editing any skill file.

### Model + thinking selection is config-only (rpiv-pi / rpiv-core)
- Config file: `~/.config/rpiv-pi/models.json` (`models-config.ts:197`, via `configPath`).
- Cascade `resolveStageModel` (`models-config.ts:301-318`): `presets[workflow].stages[stage]` →
  `stages[stage]` → `skills[skill]` → `defaults`. Entry is a bare model string or
  `{ model, thinking }` (`models-config.ts:85-99`); thinking ∈
  `off|minimal|low|medium|high|xhigh` (`models-config.ts:18-19`).
- Applied by the lifecycle listener `registerModelOverrideLifecycle` (`model-override.ts`):
  `onWorkflowStart` snapshots baseline, `onStageStart`/`onUnitStart` call
  `applyCascade → applyEffectiveModel` (`pi.setModel` + `pi.setThinkingLevel`), `onWorkflowEnd`
  restores baseline (the D7 no-bleedthrough invariant, `setBaselineModel: true`). Judge units
  re-resolve under `skills.<judge.skill>` (`onUnitStart`).
- **To always use the strongest model + thinking for blueprint/design (+ judges): author
  models.json only — zero code.** Example: `stages.blueprint`/`stages.design` →
  `{ model: "<best>", thinking: "xhigh" }`; `skills.judge` → same.

### The freeze: continue-policy + un-timed waitForIdle (rpiv-workflow)
- `CONTINUE_HANDLER.spawn` (`sessions/spawn.ts:84-92`): `sendIntoExistingSession` →
  `await ctx.waitForIdle()` (`:69`) → `await body(ctx)` (postStage extraction). If Pi disposes
  the session while `waitForIdle()` is pending, the promise **never resolves**; `body` never runs;
  no outcome row is written. `ctx.waitForIdle()` has **no abort signal** (noted at
  `internal-utils.ts:133`).
- This bubbles up: `runStageSession` (`sessions/index.ts:37-48`) → `runSingleStage`
  (`run-stage.ts:157-183`) → `executeRun`'s `await entry()` (`runner/runner.ts:34`) all hang. The
  result envelope is never assembled, `onWorkflowEnd` never fires, control never returns — "the
  orchestrator is gone."
- Disposal triggers Pi's `session_shutdown` then `session_start` (reason `new`/`resume`,
  `previousSessionFile`) — see Pi hook surface below. `rpiv-core` already recognises the stale ctx
  via `isStaleCtxError` (`utils.ts:88-98`, matches "stale after session replacement") and
  `applyOrSkipIfStale` (`model-override.ts:142-149`) — but that only swallows model-mutation
  errors; it does not rescue the hung `waitForIdle`.

### Resume is already a complete, deterministic system (rpiv-workflow)
- State trail: append-only JSONL at `.rpiv/workflows/runs/<runId>.jsonl`; header (line 1) written
  before any execution (`runner/runner.ts:176-188`), `STATE_SCHEMA_VERSION = 1`
  (`state/state.ts:77-87`); runId `YYYY-MM-DD_HH-MM-SS-<4hex>` (`state/paths.ts:27-35`).
- Reconstruction `reconstructState` (`runner/resume.ts:51-115`): strict fold — version-mismatch
  refusal (`:86-89`), malformed-row refusal (`state/reads.ts:193-206`, `session` must be `null` or
  `{id}`), loop-drift guard (`resume.ts:307-325`). `lastChainIndex` vs `stageNumber` diverge past
  loops (`resume.ts:62-63`).
- Re-entry `selectResumeEntry` (`runner/resume-entry.ts:25-55`): four arms — drift→fail; trailing
  unit row→`resumeLoopStage`; completed→`advance` (no-op at stop); failed/aborted→
  `resumeStageWithSession` or cold `runStageOrRecordFailure`.
- `/wf @<runId>` path is complete: parse `@<ref>` (`command.ts:180-184`) → `handleResume`
  (`command-run.ts:134-148`) → `resumeWorkflowByRunId` (`runner/by-run-id.ts:42-81`,
  `resolveRun → loadWorkflows → findWorkflow`) → `resumeWorkflow` (`runner/runner.ts:180-200`).
- `resolveRun` (`state/resolve.ts:25-71`) accepts a `--name` slug, a literal runId, or a pasted
  path; rebuilds `names.json` on miss.
- **Missing for one-command auto-resume:** only a ~10-line wrapper — `listRuns(cwd).sort(by ts
  desc)`, filter `readLastStage().status ∈ {failed,aborted}` or trailing unit row, then
  `resumeWorkflowByRunId`. All inputs are public (see Integration Points).

### Pi hook surface that makes the sidecar possible (pi-coding-agent)
- `before_agent_start` — can inject a message and **modify the system prompt**
  (`docs/extensions.md:497-532`). This is the autonomy-injection seam.
- `tool_call` — **can block or mutate `event.input`**, but its return only controls blocking
  (`{block, reason}`); it cannot return a synthetic success result (`docs/extensions.md:705-740`).
  So it is a *hard* fallback enforcement (block a mechanical `ask_user_question` with a
  proceed-reason), not the primary mechanism — the primary is the `before_agent_start` directive.
- `session_start` (reason `startup|new|resume|fork`, `previousSessionFile`) + `session_shutdown`
  (`docs/extensions.md:386-432, 485-495`) — the disposal signal the watchdog keys on.
- `registerLifecycle` (`startup.ts`, dispatched via `events.ts:226-277`) — how the sidecar learns
  a workflow is active (subscribe to `onWorkflowStart`/`onStageStart`/`onWorkflowEnd`), exactly as
  `model-override.ts` does. **Append-only global registry** (`events.ts:262-263`).
- `registerCommand` — for `/wfex resume` and `/wfex runs`.

## Code References
- `runner/run-stage.ts:56-98` — `CHAIN_DEPS` composition + `runStageOrRecordFailure` (sole catch site)
- `runner/chain-advance.ts:19-63` — `advanceChain` routing + `deps.runNext` recurse; halt arms at `:90-120`
- `sessions/spawn.ts:69,84-92` — `CONTINUE_HANDLER` un-timed `ctx.waitForIdle()` (the freeze)
- `runner/runner.ts:34,176-200` — `executeRun await entry()`; header write; `resumeWorkflow`
- `runner/resume.ts:51-115,307-325` — `reconstructState` strict fold + drift guard
- `runner/resume-entry.ts:25-55` — `selectResumeEntry` four-arm re-entry
- `runner/by-run-id.ts:42-81` — `resumeWorkflowByRunId` (public convenience wrapper)
- `command.ts:78,156-184` — `registerCommand("wf")`, `parseArgs`, `@<ref>` resume sigil
- `command-run.ts:134-148` — `handleResume`
- `state/reads.ts:259-305` — `readHeader`, `readLastStage`, `listRuns`
- `state/resolve.ts:25-71` — `resolveRun` dual-mode resolution
- `state/state.ts:30,45-115,77-87` — `StageStatus`, `WorkflowStage`/`WorkflowHeader`, `STATE_SCHEMA_VERSION`
- `registration.ts:258-262` — public barrel: `listRuns, readHeader, readLastStage, resolveRun, RunSummary, WorkflowHeader, WorkflowStage`
- `startup.ts` — `registerLifecycle`, `registerBuiltInsProvider`, `registerBuiltIns` (sidecar entry points)
- rpiv-core `model-override.ts:142-149,194-367` — `applyOrSkipIfStale`, `applyEffectiveModel`, lifecycle hooks (the canonical sidecar template)
- rpiv-core `models-config.ts:18-19,85-99,197,301-318` — thinking levels, entry schema, config path, cascade
- rpiv-core `utils.ts:88-98` — `isStaleCtxError`
- rpiv-core `events.ts:226-277` — `LifecycleDispatcher` + append-only `registerLifecycle` registry
- pi `docs/extensions.md:386-432,485-532,705-740` — `session_start/shutdown`, `before_agent_start`, `tool_call`
- skills: `skills/commit/SKILL.md:42,61`, `skills/plan/SKILL.md:318,324` — confirmed guard sites

## Integration Points

### Inbound References (what a sidecar plugs into)
- `pi.on("before_agent_start", …)` — inject autonomy directive into the system prompt (gated on active-run flag).
- `pi.on("session_start" | "session_shutdown", …)` — watchdog disposal detection.
- `pi.registerCommand("wfex", …)` — `/wfex resume`, `/wfex runs`.
- `registerLifecycle({ onWorkflowStart, onStageStart, onWorkflowEnd })` from `@juicesharp/rpiv-workflow/startup` — track active run + current runId.

### Outbound Dependencies (public APIs the sidecar calls)
- `@juicesharp/rpiv-workflow/runner/by-run-id` → `resumeWorkflowByRunId(ctx, ref, { host })`.
- `@juicesharp/rpiv-workflow` barrel → `listRuns`, `readHeader`, `readLastStage`, `resolveRun`, types.
- `@juicesharp/rpiv-workflow/startup` → `registerLifecycle` (do NOT use `registerBuiltIns`/lifecycle for model-override — already owned by rpiv-core).
- `~/.config/rpiv-pi/models.json` → authored data, consumed by rpiv-core's existing lifecycle.

### Infrastructure Wiring
- Sidecar `package.json` `pi.extensions: ["./extension.ts"]` — its own entry; record `upstreamBase`/`upstreamCommit` here.
- Shared trail dir `<cwd>/.rpiv/workflows/runs/` — reused, not duplicated (runIds are unique).

## Architecture Insights
- **The model-override extension is the existence proof.** It augments rpiv-workflow at runtime
  (lifecycle + pi events, config-driven) with zero engine edits. The autonomy/resilience sidecar
  is the same shape with different hooks.
- **Autonomy is a prompt-priority problem, not a code problem.** Skills instruct the model to ask;
  a higher-priority `before_agent_start` directive overrides the mechanical ones. `tool_call`
  blocking is a hard fallback, not the primary lever (it cannot fabricate a success result).
- **Resume is solved; the freeze is the real gap.** Prefer auto-resume-on-disposal (watchdog) over
  forking the engine to add a `waitForIdle` timeout — the watchdog needs no engine edit and the
  JSONL trail, though missing the final row, is reconstructable to the last completed stage.
- **No disabling, no merging.** Reusing the engine means the original stays the runtime; the sidecar
  only adds `/wfex …` and hooks. Re-merge cost ≈ 0; on upstream bumps, only re-verify that the
  public API signatures used (`resumeWorkflowByRunId`, `listRuns`, `registerLifecycle`,
  `before_agent_start`/`session_start` event shapes) are unchanged.

### Watch-outs
- **Lifecycle double-registration** (`events.ts:262-263` append-only registry): if the sidecar
  ever registers a model-override-style lifecycle, both fire and the second `pi.setModel` wins
  silently. The sidecar must subscribe for *observation* (active-run tracking) only, never re-apply
  model overrides — leave that to rpiv-core + models.json.
- **`tool_call` cannot answer** — only block/mutate. Auto-answering must be prompt-driven.
- **Watchdog re-entrancy** — `resumeWorkflowByRunId` itself spawns sessions; guard against the
  watchdog re-firing on the session_start its own resume triggers (track "resuming runId" state).
- **Incomplete trail on freeze** — the frozen stage wrote no row; resume re-runs that stage cold
  (`selectResumeEntry` failed/aborted/sessionless arm). Idempotency of the re-run stage matters
  for stages with side effects (e.g. commit) — verify before relying on overnight auto-resume.

## Precedents & Lessons
Upstream git history not swept — the fork/sidecar repo does not exist yet and the cwd is not a
repo (`commit: no-commit`). Upstream is pinned at `@juicesharp/rpiv-workflow` **v1.20.0**, commit
**`faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`** for re-verification on future bumps.

### Composite Lessons
- The closest in-tree precedent is `rpiv-core/model-override.ts` — treat it as the reference sidecar
  (lifecycle + pi events + config, zero engine edits, mandatory baseline restore, stale-ctx tolerance).

## Historical Context (from `.rpiv/artifacts/`)
- None — first artifact in this workspace.

## Developer Context
**Q (`skills/commit/SKILL.md:61`, `skills/plan/SKILL.md:318`): the guards live in skill bodies, not the engine — how should the fork handle the skill layer?**
A: Prefer option 3 — achieve autonomy via **hooks**, leaving the original extension untouched ("if by hooks we can achieve that it will be amazing because original extension won't be touched at all").

**Q (`sessions/spawn.ts:69`, `runner/by-run-id.ts`): resilience + resume — engine fix vs external wrapper?**
A: Prefer doing it via an **additional extension + commands + hooks** rather than duplicating rpiv-workflow, if feasible ("if it can also be done by additional extension and commands and hooks instead of duplicating -workflow then it is the absolutely preferable way, if not - so be it"). Specifically: `/wfex resume`, and "maybe the spawn fix in there too — stale ctx detection and re-firing the original workflow engine."

**Q (model selection): which stages get the strongest model + thinking?**
A: Use the best model + thinking mode for blueprint/design (and judges); always select the more-complete/better option even if more work. Config-only via `~/.config/rpiv-pi/models.json`.

**Q (disable original?): does the original `/wf` need disabling?**
A (resolved by architecture): No. The sidecar reuses the original engine, so the original stays enabled as the runtime; only `/wfex …` commands and hooks are added. No collision, no disabling, no re-merge.

## Related Research
- None yet.

## Open Questions
1. **`before_agent_start` scoping** — exact mechanism to gate the autonomy directive to *active
   workflow turns only* (not normal chat). Lifecycle `onWorkflowStart`/`onWorkflowEnd` give an
   active-run flag, but confirm the timing relative to `before_agent_start` firing within a stage's
   session turns.
2. **Watchdog reliability under disposal** — confirm `session_start` actually fires (and the
   extension instance is rebound) after a *model-limit* disposal mid-`waitForIdle`, vs only after
   auto-compaction; and that `previousSessionFile` lets the sidecar correlate to the orphaned runId.
3. **Stage idempotency for auto-resume** — which stages (esp. `commit`) are safe to re-run cold
   when the freeze left no final row, before trusting unattended overnight auto-resume.
4. **`tool_call` block-as-answer behavior** — if prompt-injection proves insufficient for a stubborn
   gate, verify how the model interprets a `{block, reason}` result on `ask_user_question` (does it
   cleanly proceed on the reason text, or error out).
