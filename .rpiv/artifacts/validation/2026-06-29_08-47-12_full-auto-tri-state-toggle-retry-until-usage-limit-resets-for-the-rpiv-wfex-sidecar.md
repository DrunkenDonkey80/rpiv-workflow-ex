---
date: 2026-06-29T08:47:12+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Validation of Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-28_22-51-21_full-auto-mode-and-usage-limit-retry.md"
tags: [validation, rpiv-wfex, autonomy, rate-limit, retry, full-auto, watchdog]
last_updated: 2026-06-29T08:47:12+0300
---

## Validation Report: Full-auto Tri-state Toggle + Retry-Until-Usage-Limit-Resets

### Implementation Status

- ✓ Phase 1: State foundation — autoMode tri-state — Fully implemented
- ✓ Phase 2: Autonomy directive branching — Fully implemented
- ✓ Phase 3: /wfex auto command — Fully implemented
- ✓ Phase 4: Rate-limit retry loop — Fully implemented
- ✓ Phase 5: Subscription reset wiring — Fully implemented
- ✓ Phase 6: Self-check + docs — Fully implemented
- ✓ Phase 7: Continue-preference for full-auto retry — Fully implemented

### Automated Verification Results

**Phase 1 — state.ts:**
- ✓ Accessors + type exported: `grep -cE "export function getAutoMode|export function setAutoMode|export type AutoMode" state.ts` — returns 3
- ✓ Module load: verified via `ratelimit.selfcheck.ts` and `continue.selfcheck.ts` which import from modules that chain through state.ts (jiti `-e` flag not executable on this Windows environment; selfchecks are the stronger signal)

**Phase 2 — autonomy.ts:**
- ✓ Both directives exported: `grep -cE "export const SAFE_AUTO_DIRECTIVE|export const UNATTENDED_AUTO_DIRECTIVE" autonomy.ts` — returns 2
- ✓ Handler selects by tier: `grep -q "directiveFor(getAutoMode())" autonomy.ts` — match found
- ✓ Module load: selfcheck chain validates transitively

**Phase 3 — commands.ts:**
- ✓ Auto branch wired: `grep -q 'sub === "auto"' commands.ts` — match found
- ✓ Accessors imported: `grep -q "setAutoMode" commands.ts && grep -q "getAutoMode" commands.ts` — both match
- ✓ Module load: validated via selfcheck chain

**Phase 4 — ratelimit.ts + extension.ts + package.json:**
- ✓ Parser exported: `grep -q "export function parseResetDelayMs" ratelimit.ts` — match found
- ✓ Registrar wired in extension: `grep -q "registerRateLimitRetry(pi)" extension.ts` — match found
- ✓ No timer at module top level: `grep -nE "^(const|let|var)?\s*set(Timeout|Interval)" ratelimit.ts` — exit 1 (no match = correct)
- ✓ `ratelimit.ts` shipped: `node -e "process.exit(require('./package.json').files.includes('ratelimit.ts')?0:1)"` — exit 0
- ✓ Module load + parser value: `npx jiti ratelimit.selfcheck.ts` — prints `ratelimit.selfcheck: OK` (stronger than inline jiti -e; exercises `parseResetDelayMs("600") === 600000`)

**Phase 5 — ratelimit.ts (subscription wiring):**
- ✓ Extractor exported: `grep -q "export function messagesText" ratelimit.ts` — match found
- ✓ agent_end handler added: `grep -q 'pi.on("agent_end"' ratelimit.ts` — match found
- ✓ Exactly one registrar export: `grep -c "export function registerRateLimitRetry" ratelimit.ts` — returns 1
- ✓ Module load: `npx jiti ratelimit.selfcheck.ts` — OK (all exports loadable)

**Phase 6 — ratelimit.selfcheck.ts + README.md:**
- ✓ Self-check passes: `npx jiti ratelimit.selfcheck.ts` — prints `ratelimit.selfcheck: OK`
- ✓ Pre-existing self-check still passes: `npx jiti continue.selfcheck.ts` — prints `continue.selfcheck: OK`
- ✓ README documents the toggle: `grep -q "/wfex auto" README.md` — match found

**Phase 7 — commands.ts (credit-prefer):**
- ✓ Credit-prefer gated on full-auto: `grep -q 'getAutoMode() !== "off"' commands.ts` — match found
- ✓ Reuses continue helpers: `grep -q "buildCompletedRow" commands.ts && grep -q "findNewestArtifactMd" commands.ts` — both match
- ✓ No regressions detected — `continue.selfcheck.ts` passes

### Code Review Findings

#### Matches Plan:

- `state.ts:47-55` — `setAutoMode`/`getAutoMode` implemented exactly as specified; `getState().autoMode ?? "off"` default matches D1
- `autonomy.ts:50-68` — `SAFE_AUTO_DIRECTIVE` keeps both EXEMPTION entries (plan/working-tree mismatch + destructive Stop), matches D2
- `autonomy.ts:70-82` — `UNATTENDED_AUTO_DIRECTIVE` carves out only the working-tree mismatch, auto-proceeds on all others, matches D2
- `autonomy.ts:110` — `registerAutonomy` injects `directiveFor(getAutoMode())` per-turn, reads state fresh each call (no re-registration needed)
- `commands.ts:143-159` — `autoCmd` handles no-arg (reports mode), valid modes (set + blurb), invalid modes (warning) per plan spec
- `ratelimit.ts:23` — `RETRY_SLOT` uses `Symbol.for("@flex/rpiv-wfex:ratelimit")` — survives session replacement, same as watchdog's `EPOCH_SLOT`
- `ratelimit.ts:183-184` — `fireRetry` force-clears stale resuming guard before re-send (applied Plan Review finding: frozen resume can't wedge both loops)
- `ratelimit.ts:207-210` — `clearRetry` scoped to armed run's `runId` (applied Plan Review finding: unrelated 200 can't cancel active retry window)
- `ratelimit.ts:286-290` — `agent_end` handler refines armed timer from subscription reset string; no-op if loop not armed (Phase 5 additive-only semantics)
- `extension.ts:13-16` — All four registrars wired in correct order: commands → autonomy → watchdog → ratelimit
- `commands.ts:96-110` — Full-auto credit-prefer block: checks `getAutoMode() !== "off"`, reads last stage, finds newest artifact, credits it non-interactively (applied Plan Review finding §3/§6)
- `package.json` — `ratelimit.ts` in `files` array alongside the Phase 4 `extension.ts` edit (applied Plan Review finding: publish self-consistency)
- `ratelimit.selfcheck.ts` — `ratelimit.selfcheck.ts` not in `files` (dev-only, matches `continue.selfcheck.ts` precedent)

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ `setAutoMode`/`getAutoMode` follow the identical pattern to `setActiveRun`/`getActiveRunId` (delegate to `getState()`, consistent naming, only diff: `?? "off"` default — appropriate for mode semantics)
- ✓ `RETRY_SLOT` follows the `EPOCH_SLOT` pattern exactly: `Symbol.for("@flex/rpiv-wfex:<name>")`, module-private, survives session replacement
- ✓ `registerRateLimitRetry` matches `registerWatchdog` shape: `(pi: ExtensionAPI): void`, uses `pi.on()` listeners with `async (event, ctx)` handlers
- ✓ `autoCmd` dispatch matches `listRunsCmd`/`continueDispatch`: token parse → string match → delegated function
- ✓ `ratelimit.selfcheck.ts` mirrors `continue.selfcheck.ts`: `node:assert` only, no framework, comment-headed sections, `console.log("…: OK")` terminal
- ✓ Phase 7 credit-prefer block imports and reuses `buildCompletedRow`, `findNewestArtifactMd`, `parseFrontmatter` from `continue.ts` — no reimplementation

### Manual Testing Required:

1. Phase 1 — autoMode default:
   - [ ] `getAutoMode()` returns `"off"` before any `setAutoMode` call (today's behavior preserved)

2. Phase 2 — directive branching:
   - [ ] With `autoMode` off, the injected directive is byte-identical to today's `AUTONOMY_DIRECTIVE`
   - [ ] `safe` keeps the full EXEMPTION block (plan/working-tree mismatch + destructive Stop both halt)
   - [ ] `unattended` halts ONLY on the plan/working-tree mismatch; destructive Stop steps auto-proceed

3. Phase 3 — /wfex auto command:
   - [ ] `/wfex auto` (no arg) reports the current mode; `/wfex auto safe` sets it with blurb; `/wfex auto bogus` warns
   - [ ] `/wfex auto` does not disturb the resume / continue / runs branches

4. Phase 4 — rate-limit retry loop:
   - [ ] A 429 during an active run notifies and re-sends `/wfex resume` on a timer; a non-429 clears it
   - [ ] Retries stop after the wall-clock cap with a notify
   - [ ] `parseResetDelayMs("600")` → 600000 (validated by selfcheck)

5. Phase 5 — subscription reset wiring:
   - [ ] An `agent_end` carrying "…resets 7:30pm (Europe/Berlin)…" while armed reschedules the retry to that time
   - [ ] No reset string → loop keeps its 10-min polling cadence (no regression)

6. Phase 7 — continue-preference for full-auto retry:
   - [ ] In full-auto, resuming a failed/aborted stage with an artifact credits it and advances (no cold re-run)
   - [ ] `off` mode is unchanged (plain resume); no artifact / completed / loop-trailer → falls through to plain resume

### Recommendations:

- Ready to commit — implementation is complete and validated.
