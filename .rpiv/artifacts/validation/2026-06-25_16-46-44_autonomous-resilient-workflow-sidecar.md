---
date: 2026-06-25T16:46:44+0300
author: Flex
commit: no-commit
branch: no-branch
repository: unknown
topic: "Validation of Autonomous + resilient + resumable rpiv-workflow via a non-invasive sidecar extension"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-25_16-10-53_autonomous-resilient-workflow-sidecar.md"
tags: [validation, rpiv-wfex, rpiv-workflow, pi-extensions, autonomy, resilience, resume, sidecar]
last_updated: 2026-06-25T16:46:44+0300
---

## Validation Report: Autonomous + Resilient + Resumable rpiv-workflow via a Non-Invasive Sidecar Extension

> Git history unavailable — validation based on file inspection only.

### Implementation Status

- ✓ Phase 1: Foundation (package.json + state.ts) — Fully implemented
- ✓ Phase 2: Autonomy (autonomy.ts) — Fully implemented
- ✓ Phase 3: Resume commands (commands.ts) — Fully implemented
- ✓ Phase 4: Watchdog (watchdog.ts) — Fully implemented
- ✓ Phase 5: Wiring + docs (extension.ts + README.md) — Fully implemented

### Automated Verification Results

**Phase 1 — Foundation**
- ✓ package.json valid JSON: `node -e "JSON.parse(...)"` — passes, well-formed JSON
- ✓ pi.extensions entry present: `grep -q '"./extension.ts"' package.json` — present
- ✓ upstream commit pin recorded: `grep -q 'faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85' package.json` — present in `rpiv.upstreamCommit`
- ✓ state slot Symbol.for-anchored: `grep -q 'Symbol.for("@flex/rpiv-wfex:state")' state.ts` — present
- ✓ foundation API surface ≥ 9 exports: `grep -c '^export function' state.ts` — 11 (exceeds threshold)

**Phase 2 — Autonomy**
- ✓ directive gated on active run: `grep -q 'isRunActive()' autonomy.ts` — present
- ✓ directive injected via systemPrompt return: `grep -q 'systemPrompt' autonomy.ts` — present
- ✓ safety-stop exemption present: `grep -qi 'EXEMPTION' autonomy.ts` — present
- ✓ registerAutonomy exported: `grep -q 'export function registerAutonomy' autonomy.ts` — present
- ✓ no setModel in autonomy path: `grep -E 'setModel' autonomy.ts` — absent from code (JSDoc comment only; not actual usage)

**Phase 3 — Resume commands**
- ✓ /wfex registered, /wf NOT: both checks pass
- ✓ resumeWorkflowByRunId reused: `grep -q 'resumeWorkflowByRunId' commands.ts` — present
- ✓ listRuns + readLastStage: both present
- ✓ dynamic import guarded: `grep -q 'isModuleNotFound' commands.ts` — present
- ✓ clearResuming(ref) in finally: present at `commands.ts:115`

**Phase 4 — Watchdog**
- ✓ no setModel/setThinkingLevel: absent from file
- ✓ /startup lifecycle entry: `@juicesharp/rpiv-workflow/startup` imported
- ✓ sendUserMessage + /wfex resume @: both present
- ✓ markResuming + MAX_RESUME_ATTEMPTS: both present
- ✓ isIdle() + currentEpoch(): both present
- ✓ isModuleNotFound guard: present
- ✓ registerWatchdog exported: present

**Phase 5 — Wiring + docs**
- ✓ default export wires all 3 registrars: all present in extension.ts
- ✓ all 7 package files exist: package.json, state.ts, autonomy.ts, commands.ts, watchdog.ts, extension.ts, README.md — all confirmed
- ✓ pi.extensions entry resolves: extension.ts present + entry matches
- ✓ no registerCommand("wf") in any .ts: absent
- ✓ README upstream pin: `faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85` present

**Total: 27/27 automated checks pass.**
- ✓ No regressions detected (additive new package, zero engine edits verified)

### Code Review Findings

#### Matches Plan:

- `state.ts:24,26–33` — `Symbol.for("@flex/rpiv-wfex:state")` slot with lazy init; exact plan spec
- `state.ts:67–72` — `clearResuming` idempotent conditional clear; matches spec
- `autonomy.ts:59–60` — `isRunActive()` gate + `{ systemPrompt: ... }` return; matches before_agent_start contract in plan
- `autonomy.ts:43–47` — EXEMPTION block for safety stops; matches D4
- `commands.ts:40–50` — lazy memoized import with rejection-clearing (`runtimeMemo = undefined` on error); matches plan spec
- `commands.ts:114–116` — `clearResuming(ref)` in `finally`, guarded by `if (ref)` for empty auto-pick path; matches plan's reviewed bug-fix (applied concern from Plan Review table)
- `commands.ts:124–130` — all five routing arms (`/wfex`, `/wfex resume`, `/wfex resume @ref`, `/wfex @ref`, `/wfex runs`) correctly dispatched
- `watchdog.ts:55` — `timer.unref?.()` optional chain; matches plan (Node + browser safe)
- `watchdog.ts:51,59,60` — re-entrancy guard (`isResuming`) + epoch supersession (`currentEpoch`) + idle gate (`isIdle()`); all three isolation mechanisms from plan present
- `watchdog.ts:75` — `clearResuming(runId)` in `sendUserMessage` `.catch`; matches applied Plan Review fix (concern row, `applied` resolution)
- `watchdog.ts:83–90` — `onWorkflowStart` clears the resuming guard; `onWorkflowEnd` guards `activeRunId` match before clear; matches plan spec
- `extension.ts:14–16` — `commands → autonomy → watchdog` registration order; matches plan (commands first so watchdog's sendUserMessage can trigger it)

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Potential Issues:

- `commands.ts:115–133` — `listRunsCmd` lacks a try-catch, unlike `resumeCmd` (which has try-catch-finally). If `loadRuntime()` throws a non-module-not-found error (e.g., a syntax error in the rpiv-workflow barrel), the rejection propagates to the command handler unguarded. Low-probability in practice (module loads cleanly or not at all), but inconsistent with the `resumeCmd` defensive pattern already established in the same file. Suggested fix: wrap `listRunsCmd` body in `try { … } catch (e) { ctx.ui.notify(\`rpiv-wfex: list threw — ${errMsg(e)}\`, "error"); }`.

### Manual Testing Required:

1. **Autonomy** (jiti smoke + directive injection):
   - [ ] Load the package under Pi; confirm `/wfex` registers and `before_agent_start` + `session_start` hooks are present with no error
   - [ ] During a `/wf <workflow> "<desc>"` run, confirm mechanical gates (confirm slice / approve work / approve commit / proceed?) auto-resolve without pausing
   - [ ] Confirm the autonomy directive text appears in stage-session system prompts during an active run
   - [ ] Confirm normal chat (no active run) is unaffected — `ask_user_question` still pauses for the user

2. **Safety stop exemption**:
   - [ ] Trigger the `implement` plan/working-tree-mismatch safety stop; confirm it still halts and waits for a human decision (exemption holds)

3. **Resume UX**:
   - [ ] `/wfex runs` lists runs with last-stage status; resumable runs are flagged with ⟳
   - [ ] `/wfex resume` (no ref) resumes the newest resumable run with a status notification
   - [ ] `/wfex resume @<ref>` resumes a specific run by id

4. **Resilience / watchdog**:
   - [ ] Kill the session mid-stage; confirm the watchdog detects the orphan after ~8 s debounce and auto-queues `/wfex resume @<runId>`; confirm the run continues from its last completed stage
   - [ ] Confirm a healthy multi-stage run does NOT trigger a spurious resume (agent is busy at the debounce timeout — `isIdle()` returns false)
   - [ ] After `MAX_RESUME_ATTEMPTS` (3) consecutive re-freezes on the same runId, confirm the watchdog notifies for manual resume and stops re-firing

5. **Lifecycle correctness**:
   - [ ] Confirm the lifecycle listener never changes the model (rpiv-core's override owns model selection; no `setModel` / `setThinkingLevel` in this package)

6. **Overnight run safety**:
   - [ ] Verify the `commit` skill / `gitCommitCollector` is idempotent on a no-op working tree (cold-resume safety for unattended overnight runs)

### Recommendations:

- **Pre-commit (optional)**: Add try-catch to `listRunsCmd` (`commands.ts:115`) matching `resumeCmd` — low probability gap, but consistent defensive style. One-liner change.
- Ready to commit — all automated checks pass, implementation is a complete and faithful realization of the 5-phase plan.
