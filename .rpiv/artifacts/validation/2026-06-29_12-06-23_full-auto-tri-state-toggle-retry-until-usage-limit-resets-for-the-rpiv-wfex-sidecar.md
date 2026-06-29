---
template_version: 1
date: 2026-06-29T12:06:23+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Validation of Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar"
status: ready
verdict: fail
parent: ".rpiv/artifacts/plans/2026-06-28_22-51-21_full-auto-mode-and-usage-limit-retry.md"
tags: [validation, plan, rpiv-wfex, autonomy, rate-limit, retry, full-auto, watchdog]
last_updated: 2026-06-29T12:06:23+0300
---

## Validation Report: Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar

### Implementation Status

- ✓ Phase 1: State foundation — autoMode tri-state — Fully implemented
- ✓ Phase 2: Autonomy directive branching — Fully implemented
- ✓ Phase 3: /wfex auto command — Fully implemented
- ⚠️ Phase 4: Rate-limit retry loop — Implemented, but plan command `npx jiti _test_phase4.ts` cannot pass because `_test_phase4.ts` is absent
- ✓ Phase 5: Subscription reset wiring — agent_end message scan — Fully implemented
- ✓ Phase 6: Self-check + docs — Implemented, with documentation drift noted below
- ✓ Phase 7: Continue-preference for full-auto retry — Fully implemented

### Automated Verification Results

- ✓ Phase 1 exports: `grep -cE "export function getAutoMode|export function setAutoMode|export type AutoMode" state.ts` — returned 3
- ✗ Phase 1 module load: `npx jiti -e "import('./state.ts').then(m => console.log(m.getAutoMode()))"` — failed; current `npx jiti` treats `-e` as a module path (`Cannot find module ...\\-e`)
- ✓ Phase 1 reset: `grep -q 's\.autoMode = undefined' state.ts` — passed
- ✓ Phase 2 directives: `grep -cE "export const SAFE_AUTO_DIRECTIVE|export const UNATTENDED_AUTO_DIRECTIVE" autonomy.ts` — returned 2
- ✓ Phase 2 selection: `grep -q "directiveFor(getAutoMode())" autonomy.ts` — passed
- ✗ Phase 2 module load: `npx jiti -e "import('./autonomy.ts').then(()=>console.log('ok'))"` — failed with the same `-e` CLI handling issue
- ✓ Phase 3 branch/imports: `grep -q 'sub === "auto"' commands.ts` and accessor greps — passed
- ✗ Phase 3 module load: `npx jiti -e "import('./commands.ts').then(()=>console.log('ok'))"` — failed with the same `-e` CLI handling issue
- ✓ Phase 4 parser/wiring/package/timer greps — passed; no top-level `setTimeout`/`setInterval` match
- ✗ Phase 4 test file command: `npx jiti _test_phase4.ts` — failed; `_test_phase4.ts` does not exist
- ✗ Phase 4 alternate local file: `npx jiti _test_phase4.mjs` — failed; cannot resolve `jiti` from the repo
- ✗ Phase 4 HTTP-date eval: `npx jiti -e "import('./ratelimit.ts')..."` — failed with the same `-e` CLI handling issue
- ✓ Phase 4 I1/Q4/Q5/Q6/I3 greps — passed; `cur.s` absent from the `nowSod` line, `new Date(s)`, `workflow_end`, and `clearActiveRun` present
- ✓ Phase 5 extractor/agent_end/export-count greps — passed; registrar export count returned 1
- ✗ Phase 5 module load: `npx jiti -e "import('./ratelimit.ts').then(()=>console.log('ok'))"` — failed with the same `-e` CLI handling issue
- ✓ Phase 6 self-check: `npx jiti ratelimit.selfcheck.ts` — printed `ratelimit.selfcheck: OK`
- ✓ Phase 6 README/selfcheck greps — passed
- ✓ Phase 7 greps — predicate, temporal guard, warning notifications, guarded read, helper reuse all passed
- ✓ Phase 7 self-check: `npx jiti continue.selfcheck.ts` — printed `continue.selfcheck: OK`

### Code Review Findings

#### Matches Plan:

- `state.ts:18`, `state.ts:31`, `state.ts:48-54`, `state.ts:76-80` — tri-state `AutoMode`, in-memory field, accessors, and run-end reset are present.
- `autonomy.ts:56-104`, `autonomy.ts:107-110` — safe/unattended directive variants and `directiveFor(getAutoMode())` injection are present.
- `commands.ts:160-179`, `commands.ts:209-223` — `/wfex auto` reports/sets `off | safe | unattended` and is wired into dispatch.
- `ratelimit.ts:102-130`, `ratelimit.ts:211-250` — retry-after seconds, HTTP-date, subscription reset parsing, 429 observer, scoped non-429 clear, and `agent_end` reschedule are implemented.
- `ratelimit.ts:159-166` — cap give-up clears retry state and shared active state with `clearActiveRun()`.
- `commands.ts:58-63`, `commands.ts:97-114`, `continue.ts:84-126` — full-auto credit is gated on non-off mode, failed/aborted top-level row, parseable timestamp, stage match, and `mtimeMs > failedAtMs`.
- `package.json:10` — `ratelimit.ts` is included in the published `files` list.

#### Deviations from Plan:

- Automated verification deviation: several plan commands using `npx jiti -e ...` fail in this environment before loading the target module because the installed `jiti` CLI resolves `-e` as a file path. This blocks a `pass` verdict even though file-based selfchecks pass.
- `README.md:96-99` — the caveat says full-auto credits "the newest artifact under `.rpiv/artifacts`", but the implemented Phase 7 behavior is stricter: fresh (`mtimeMs > failed row ts`) and stage-matched. Documentation is stale relative to the revised plan.
- `README.md:7` — still says the package adds commands and "three hooks"; the implementation now registers the rate-limit observer too.

#### Pattern Conformance:

- ✓ Shared-state accessors follow the existing `globalThis`/`Symbol.for` pattern used by watchdog state.
- ✓ The command module remains a thin dispatcher over the workflow runtime, with lazy runtime import and guarded notifications.
- ✓ `ratelimit.ts` mirrors watchdog mechanics: private global slot, `unref()` timer, stale-context-safe notification, and guarded `sendUserMessage` resume re-entry.
- Minor acceptable variation: `ratelimit.ts:211-215` uses raw `pi.on("workflow_end")` cleanup rather than the watchdog lifecycle helper; functionally fine for this hook-only concern.

#### Potential Issues:

- `ratelimit.ts:243-250` — precise reset scheduling depends on `agent_end` exposing the subscription reset text in the expected message shape; if not, behavior degrades to 10-minute polling as planned.

### Manual Testing Required:

1. Auto-mode state and command:
   - [ ] `getAutoMode()` returns `"off"` before any `setAutoMode` call.
   - [ ] After `setAutoMode('safe')` then `clearActiveRun()`, `getAutoMode()` returns `"off"`.
   - [ ] `/wfex auto` reports the current mode; `/wfex auto safe` sets it; `/wfex auto bogus` warns.
   - [ ] `/wfex auto` does not disturb resume / continue / runs branches.
2. Autonomy directives:
   - [ ] With `autoMode` off, the injected directive is byte-identical to the baseline `AUTONOMY_DIRECTIVE`.
   - [ ] `safe` keeps plan/working-tree mismatch and destructive Stop as hard halts.
   - [ ] `unattended` halts only on plan/working-tree mismatch.
3. Rate-limit retry:
   - [ ] A 429 during an active run notifies and re-sends `/wfex resume` on a timer; a non-429 clears it.
   - [ ] Retries stop after the wall-clock cap with notify and clear `activeRunId`/`autoMode`.
   - [ ] An armed `agent_end` message containing `resets HH:MM (TZ)` reschedules to that time; no reset string keeps 10-minute polling.
   - [ ] `workflow_end` cancels any armed retry timer immediately.
4. Full-auto credit:
   - [ ] In full-auto, a fresh stage-matching artifact credits a failed/aborted stage and advances.
   - [ ] A stale prior-run artifact (`mtime <= failed row ts`) is not credited and cold resume runs.
   - [ ] Locked/deleted artifact warns then falls through to cold re-run.
   - [ ] Stage `plan` does not match path segments like `redesign` or `by-design`.
   - [ ] `off` mode remains plain resume; `continueCmd` without stageName still returns the global newest artifact.
5. Documentation:
   - [ ] README commands table and caveats read correctly after fixing the stale credit-scope wording.

### Recommendations:

- Fix or replace the failing `npx jiti -e` verification commands in the plan/tooling, or add a tiny checked-in `_test_phase4.ts` matching the plan command.
- Update `README.md` to describe fresh stage-matched full-auto artifact credit and the added rate-limit hook.
- Re-run `/skill:validate` after those gaps are fixed.
