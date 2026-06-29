---
template_version: 1
date: 2026-06-29T13:16:16+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Validation of Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar"
status: ready
verdict: fail
parent: ".rpiv/artifacts/plans/2026-06-28_22-51-21_full-auto-mode-and-usage-limit-retry.md"
tags: [validation, plan, rpiv-wfex, autonomy, rate-limit, retry, full-auto, watchdog]
last_updated: 2026-06-29T13:16:16+0300
---

## Validation Report: Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar

### Implementation Status

- ✓ Phase 1: State foundation — autoMode tri-state — Fully implemented
- ✓ Phase 2: Autonomy directive branching — Fully implemented
- ✓ Phase 3: /wfex auto command — Fully implemented
- ✓ Phase 4: Rate-limit retry loop — Fully implemented
- ✓ Phase 5: Subscription reset wiring — agent_end message scan — Fully implemented
- ✓ Phase 6: Self-check + docs — Partially implemented (see Findings)
- ✓ Phase 7: Continue-preference for full-auto retry — Fully implemented
- ✓ Phase 8: Manual continue hardening + metadata refresh — Fully implemented

### Automated Verification Results

- ✓ State/accessor greps: `grep -cE "export function getAutoMode|export function setAutoMode|export type AutoMode" state.ts`; `grep -q 's\.autoMode = undefined' state.ts` — expected symbols and reset are present.
- ✗ Plan jiti `-e` module-load checks: `npx jiti -e "import('./state.ts')..."`, `autonomy.ts`, `commands.ts`, and `ratelimit.ts` — failed in this environment because the installed `jiti` CLI treats `-e` as a module path (`Cannot find module ...\\-e`).
- ✓ Autonomy and command wiring greps: exported safe/unattended directives, `directiveFor(getAutoMode())`, `/wfex auto`, and auto-mode imports are present.
- ✗ Phase 4 plan smoke test: `npx jiti _test_phase4.ts` — failed because `_test_phase4.ts` is absent; the repo contains untracked `_test_phase4.mjs`, which also fails under `npx jiti` because it imports package `jiti` directly and `jiti` is not a project dependency.
- ✓ Rate-limit structural greps: parser export, extension registrar, no top-level timer creation, package `files` includes `ratelimit.ts`, `isResuming` re-arm path, HTTP-date branch, `workflow_end`, and cap `clearActiveRun` are present.
- ✓ Self-check: `npx jiti ratelimit.selfcheck.ts` — prints `ratelimit.selfcheck: OK`.
- ✓ Self-check: `npx jiti continue.selfcheck.ts` — prints `continue.selfcheck: OK`.
- ✓ Phase 6-8 greps: README `/wfex auto`, real handler harness, cap cleanup assertions, Q4/Q5 assertions, full-auto credit predicate, stage + temporal guard, warning fall-throughs, continue picker, stat skip, package metadata, and README fresh-artifact wording are present.

### Code Review Findings

#### Matches Plan:

- state.ts:18,48-54,76-80 — defines `AutoMode`, exposes `setAutoMode`/`getAutoMode`, defaults to `off`, and resets mode on `clearActiveRun()`.
- autonomy.ts:56-95,107-110 — adds safe/unattended directives and selects the directive from `getAutoMode()` while preserving the off baseline.
- commands.ts:166-182,212-226 — implements and dispatches `/wfex auto [off|safe|unattended]` without disturbing resume/continue/runs.
- ratelimit.ts:102-130,152-203,211-250 — parses retry-after/reset signals, arms one retry loop, re-sends `/wfex resume @<runId>`, clears on scoped non-429/workflow_end, and clears active state on cap give-up.
- ratelimit.ts:134-148,243-250 — scans `agent_end` messages and reschedules an armed retry from a subscription reset string.
- commands.ts:58-60,100-117 and continue.ts:84-130 — full-auto resume credits only a fresh stage-matching artifact, with stale/unmatched artifacts falling through to cold resume.
- continue.ts:139-143,189-203 and commands.ts:75-78,197-203 — manual continue now uses the same root failed/aborted + parseable timestamp predicate and a continue-specific no-ref picker.

#### Deviations from Plan:

- README.md:7 — intro still says the package adds “three hooks”; the implementation now registers a fourth rate-limit hook. This is a documentation drift from the Phase 6/8 docs refresh.
- Verification artifact mismatch — the plan expects `_test_phase4.ts`, but the working tree has `_test_phase4.mjs`; the required automated command therefore cannot pass as written.

#### Pattern Conformance:

- ✓ State accessors follow the existing `globalThis` symbol-slot pattern from `state.ts`.
- ✓ `registerRateLimitRetry` follows the watchdog-style event registrar/timer pattern: timers start from event handlers and are `unref()`'d.
- ✓ Command dispatch and assert-only selfchecks follow existing lightweight sidecar conventions.
- Minor observation: package keywords were not refreshed for `auto`, `continue`, or `ratelimit`; this is acceptable metadata drift, not a functional deviation.

#### Potential Issues:

- continue.ts:219 — after a user confirms the fresh artifact, `readFileSync(found.abs, "utf8")` is not guarded. Phase 8 hardens scan-time `statSync`, but a file that disappears between scan/select and final read can still throw instead of warning/cold-rerunning.

### Manual Testing Required:

1. Auto-mode command and directive behavior:
   - [ ] `/wfex auto` reports the current mode; `/wfex auto safe` sets it; `/wfex auto bogus` warns.
   - [ ] `safe` auto-answers decisions but halts on plan/working-tree mismatch and destructive safety stops.
   - [ ] `unattended` halts only on plan/working-tree mismatch.
2. Rate-limit retry behavior:
   - [ ] A 429 during an active run notifies and re-sends `/wfex resume @<runId>` on the timer; a relevant non-429 clears it.
   - [ ] An `agent_end` message containing `resets HH:MM (TZ)` reschedules the retry; no reset string keeps polling.
   - [ ] Cap give-up clears `activeRunId` and `autoMode`.
3. Continue/full-auto artifact behavior:
   - [ ] Full-auto credits only a fresh artifact matching the interrupted stage; stale/unmatched artifacts cold-rerun.
   - [ ] Bare `/wfex continue` selects the newest root failed/aborted run it can advance, not mid-loop rows.
   - [ ] Explicit `/wfex continue @<run>` with no fresh stage artifact warns and cold-reruns.

### Recommendations:

- Fix the validation-command drift: either add the expected `_test_phase4.ts` smoke test or update the plan/test artifact, and avoid `npx jiti -e` if the current jiti CLI does not support it.
- Update README.md intro from “three hooks” to match the four registered hooks.
- Consider guarding `continue.ts` final `readFileSync(found.abs, "utf8")` the same way full-auto credit does, so disappearing artifacts after selection degrade to warning/cold-rerun.
- Re-run `/skill:validate` after the above gaps are fixed.
