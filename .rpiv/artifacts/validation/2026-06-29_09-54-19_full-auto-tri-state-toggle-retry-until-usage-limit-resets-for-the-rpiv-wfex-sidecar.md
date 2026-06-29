---
date: 2026-06-29T09:54:19+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Validation of Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-28_22-51-21_full-auto-mode-and-usage-limit-retry.md"
tags: [validation, rpiv-wfex, autonomy, rate-limit, retry, full-auto, watchdog]
last_updated: 2026-06-29T09:54:19+0300
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

**Working-tree status:** All 7 modified files + 2 new files (`ratelimit.ts`, `ratelimit.selfcheck.ts`) are uncommitted. Changes validated against working tree (git diff HEAD shows +185 lines across 7 files).

### Automated Verification Results

**Phase 1 — state.ts:**
- ✓ Accessors + type exported: `grep -cE "export function getAutoMode|export function setAutoMode|export type AutoMode" state.ts` → 3
- ✓ `getAutoMode()` returns `"off"` via jiti: confirmed (`off` printed)

**Phase 2 — autonomy.ts:**
- ✓ Both directives exported: `grep -cE "SAFE_AUTO_DIRECTIVE|UNATTENDED_AUTO_DIRECTIVE" autonomy.ts` → 2
- ✓ Handler selects by tier: `grep -q "directiveFor(getAutoMode())" autonomy.ts` → found
- ✓ Module loads under jiti: prints `autonomy: ok`

**Phase 3 — commands.ts:**
- ✓ Auto branch wired: `grep -q 'sub === "auto"' commands.ts` → found
- ✓ Accessors imported: `setAutoMode` and `getAutoMode` found in commands.ts
- ✓ Module loads under jiti: prints `commands: ok`

**Phase 4 — ratelimit.ts + extension.ts + package.json:**
- ✓ Parser exported: `grep -q "export function parseResetDelayMs" ratelimit.ts` → found
- ✓ Registrar wired in extension: `grep -q "registerRateLimitRetry(pi)" extension.ts` → found
- ✓ No timer at module top level: `grep -nE "^(const|let|var)?\s*set(Timeout|Interval)" ratelimit.ts` → empty (exit 1)
- ✓ `ratelimit.ts` shipped: `node -e "require('./package.json').files.includes('ratelimit.ts')"` → true
- ✓ `parseResetDelayMs("600")` via jiti → `600000`
- ✓ Module loads under jiti: prints `ratelimit: ok`

**Phase 5 — ratelimit.ts agent_end:**
- ✓ `messagesText` exported: `grep -q "export function messagesText" ratelimit.ts` → found
- ✓ `agent_end` handler added: `grep -q 'pi.on("agent_end"' ratelimit.ts` → found
- ✓ Exactly 1 `registerRateLimitRetry` export: count → 1
- ✓ Module loads under jiti: prints `ratelimit: ok`

**Phase 6 — selfcheck + README:**
- ✓ `npx jiti ratelimit.selfcheck.ts` → `ratelimit.selfcheck: OK`
- ✓ `npx jiti continue.selfcheck.ts` → `continue.selfcheck: OK`
- ✓ README documents the toggle: `grep -q "/wfex auto" README.md` → found

**Phase 7 — continue-preference for full-auto:**
- ✓ Credit-prefer gated on full-auto: `grep -q 'getAutoMode() !== "off"' commands.ts` → found
- ✓ Stage filter passed: `grep -q 'findNewestArtifactMd(ctx.cwd, last.stage)' commands.ts` → found
- ✓ Notify at warning: `grep -q 'full-auto credited' commands.ts` → found (level `"warning"`)
- ✓ `findNewestArtifactMd` accepts `stageName`: `grep -q 'stageName' continue.ts` → found
- ✓ Reuses `buildCompletedRow` from `continue.ts`: found in commands.ts imports
- ✓ `continue.ts` loads under jiti: prints `continue: ok`
- ✓ `commands.ts` loads under jiti: prints `commands: ok`
- ✓ No regressions detected: `continue.selfcheck.ts` still passes

### Code Review Findings

#### Matches Plan:

- `state.ts:17,34,43-49` — `AutoMode` type, `autoMode?: AutoMode` field, and `setAutoMode`/`getAutoMode` accessors follow the active-run accessor pattern verbatim
- `autonomy.ts:52-108` — `DECISION_HEURISTIC`, `SAFE_AUTO_DIRECTIVE`, `UNATTENDED_AUTO_DIRECTIVE`, and `directiveFor` implemented exactly as specified; `AUTONOMY_DIRECTIVE` (the `off` baseline) is untouched
- `autonomy.ts:122-126` — `before_agent_start` handler gates on `isRunActive()` and returns `directiveFor(getAutoMode())`, injecting the correct tier each turn
- `commands.ts:162-175` — `autoCmd` function and `auto` dispatch branch match plan; blurb strings for each mode match the Desired End State
- `commands.ts:107-127` — full-auto credit-prefer block immediately precedes `resumeWorkflowByRunId`; conditions (`parent === undefined`, `failed | aborted`) and stage-scoped find match plan exactly (I1/Q1 fix applied)
- `ratelimit.ts` — `parseResetDelayMs` handles both the bare seconds format and the subscription "resets HH:MM (TZ)" substring correctly; wall-clock cap, single-loop invariant, run-scoped non-429 clear, and stale-guard force-clear all implemented as specified (review findings applied)
- `ratelimit.ts:registerRateLimitRetry` — timers created inside handlers only (never the factory body); `t.unref?.()` called on every `setTimeout`; two `pi.on` calls (after_provider_response + agent_end) inside one registrar
- `continue.ts:86-125` — `findNewestArtifactMd` collects all candidates first, sorts by mtime, then applies path-match and frontmatter-match filters for the `stageName` path; returns `undefined` on no match (safe degradation)
- `extension.ts` — four registrars in the correct order: commands → autonomy → watchdog → ratelimit
- `package.json` — `ratelimit.ts` shipped in `files`; `ratelimit.selfcheck.ts` correctly excluded (dev-only)
- `ratelimit.selfcheck.ts` — covers parser (seconds, subscription strings, DST edge, invalid zone), `messagesText`, and state-machine invariants (5 assertions)
- `README.md` — commands table, full-auto mode explanation, usage-limit retry section, `retry.provider` tuning note, and all 5 caveats (in-memory, carve-out, bounded retry, subscription string dependency, auto-credit blast radius) present

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan including all review-finding resolutions (I1/Q1 stage-filter, single-loop guard, run-scoped clear, stale-guard force-clear, state-machine selfcheck).

### Manual Testing Required:

1. **autoMode tri-state toggle:**
   - [ ] `/wfex auto` with no arg reports the current mode (`off` initially)
   - [ ] `/wfex auto safe` sets mode and returns the correct blurb
   - [ ] `/wfex auto unattended` sets mode and returns the correct blurb
   - [ ] `/wfex auto off` resets; `/wfex auto bogus` shows a warning
   - [ ] `/wfex auto` does not disturb the resume/continue/runs branches

2. **Autonomy directive injection:**
   - [ ] With `autoMode` off, injected directive is byte-identical to today's `AUTONOMY_DIRECTIVE`
   - [ ] `safe` keeps the full EXEMPTION block (plan/working-tree mismatch + destructive Stop both halt)
   - [ ] `unattended` halts ONLY on the plan/working-tree mismatch; destructive Stop steps auto-proceed

3. **Rate-limit retry loop:**
   - [ ] A 429 during an active run notifies and re-sends `/wfex resume` on a timer; a non-429 clears it
   - [ ] Retries stop after the 8h wall-clock cap with a notify
   - [ ] An unrelated 200 (manual chat, different run) while armed does NOT cancel the retry window
   - [ ] `agent_end` carrying "…resets 7:30pm (Europe/Berlin)…" while armed reschedules the retry precisely
   - [ ] No reset string in agent_end → loop keeps its 10-min polling cadence (no regression)

4. **Full-auto continue-preference:**
   - [ ] In full-auto, resuming a failed/aborted stage with a stage-matching artifact credits it (`warning`) and advances without prompting
   - [ ] In full-auto, no stage-matching artifact → falls through to cold re-run (no credit, no crash)
   - [ ] `off` mode is unchanged (plain resume); completed / loop-trailer rows fall through to plain resume
   - [ ] `continueCmd` (no stageName) is unchanged — still prompts and returns the global newest artifact

### Recommendations:

- Ready to commit — implementation is complete and validated.
