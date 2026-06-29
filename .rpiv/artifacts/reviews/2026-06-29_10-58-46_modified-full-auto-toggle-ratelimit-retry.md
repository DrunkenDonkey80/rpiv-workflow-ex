---
template_version: 2
date: 2026-06-29T10:58:46+0300
author: Flex
repository: rpiv-workflow-ex
branch: master
commit: 35a3eca
review_type: working
scope: "Uncommitted working-tree changes (vs HEAD): full-auto tri-state toggle + 429 rate-limit retry loop for the rpiv-wfex sidecar"
scope_strategy: working-tree
in_scope_files_count: 9
status: ready
severity: { critical: 1, important: 2, suggestion: 3 }
verification: { verified: 7, weakened: 0, falsified: 1 }
blockers_count: 3
tags: [code-review, rpiv-wfex, autonomy, rate-limit, retry, full-auto, resume]
---

# Code Review — Full-auto toggle + rate-limit retry (working tree)

**Commit:** `35a3eca` · **Status:** `ready` · **Findings:** 1🔴 · 2🟡 · 3🔵 · **Verification:** 7✓ / 0− / 1✗

## Top Blockers

1. **I1** — Full-auto credit writes a synthetic `completed` row from an artifact with no run-id scope — a prior run's same-named-stage artifact can be credited silently.
2. **I3** — Ratelimit give-up clears only its own slot, leaving `activeRunId`/`autoMode` stranded — autonomy keeps injecting and the watchdog may re-resume.

---

## Legend

```text
Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss
ID prefix   I interaction   Q quality   S security   G gap
Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)
Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]
```

---

## 🔴 Critical

### I1 🔴 Full-auto credit has no run-id/temporal anchor on the artifact `[cascade: false-promise]`

**Where**
`commands.ts:98`, `commands.ts:103`, `continue.ts:84-121`, `ratelimit.ts:190`

**Code**
```ts
// commands.ts
if (last && last.parent === undefined && (last.status === "failed" || last.status === "aborted")) {
    const found = findNewestArtifactMd(ctx.cwd, last.stage); // stage-scoped (I1/Q1 fix)
    ...
        if (rt.appendStage(ctx.cwd, runId, buildCompletedRow(last, found.rel, data, runId))) {
```
```ts
// continue.ts:113 — match is by path-segment / frontmatter stage name only
if (segments.some((seg) => seg === lower || seg === lower + "s")) return c;
```

**Why**
`findNewestArtifactMd(cwd, stageName)` scopes candidates only by stage-*name* (path segment, then frontmatter `topic`/`stage`) — it searches all of `<cwd>/.rpiv/artifacts` with **no run-id and no temporal anchor**. When a top-level `failed`/`aborted` row is the last row and full-auto is on, `resumeCmd` credits the newest same-named-stage artifact and `appendStage` writes a synthetic `completed` row to the durable JSONL trail (no undo). The artifact can belong to a *different, earlier run* of a same-named stage, so incomplete/unrelated work is silently marked complete and the run advances past it. This path runs unattended on the ratelimit 429 auto-resume (`ratelimit.ts:190` → `resumeCmd`). (The stronger "a 429 leaves no trail row so the *previous* stage is credited" amplifier could not be confirmed against this repo — the engine's trail-write behavior is out of tree — so the finding rests on the cross-run-staleness core, which is independently reproducible.)

**Fix**
Scope artifact candidates to the current `runId` (e.g. require the artifact's frontmatter/path to carry this run's id, or only accept artifacts under this run's own artifact dir), and fall through to a cold re-run when none matches.

**Alt**
Require an mtime newer than the failed row's `ts` as a temporal guard, so a stale prior-run artifact can never satisfy the credit.

---

## 🟡 Important

### I3 🟡 Ratelimit give-up leaves `activeRunId`/`autoMode` set `[cascade: stranded-state]`

**Where**
`ratelimit.ts:160`, `ratelimit.ts:50-56`, `watchdog.ts:85`, `state.ts:76-81`

**Code**
```ts
// ratelimit.ts — armRetry give-up branch (remaining <= 0)
clearRetry();           // clears RETRY_SLOT only: timer, deadlineMs, runId
// ...no clearActiveRun() anywhere in ratelimit.ts
```
```ts
// watchdog.ts:85 — peer give-up DOES clear shared run state
clearActiveRun(); // give up: stop re-firing this process
```

**Why**
On the wall-clock cap, the ratelimit loop clears only its private slot. `activeRunId` and `autoMode` remain set, so `isRunActive()` stays `true` — the autonomy directive keeps injecting on later turns and the full-auto tier persists (the same class of leak the just-landed Q3 fix closed for clean run-end). A subsequent `session_start` still sees an active run, so the watchdog can treat it as orphaned and re-resume. The peer (`watchdog.ts:85`) clears shared state on its give-up; ratelimit's cleanup diverges.

**Fix**
On ratelimit give-up, call `clearActiveRun()` (or a shared give-up helper) so the run is no longer "live" after the cap is hit, matching the watchdog's give-up semantics.

---

### Q8 🟡 Risk-bearing logic has no runnable check

**Where**
`ratelimit.selfcheck.ts:104`, `commands.ts:96-107`, `continue.ts:84`

**Code**
```ts
//    (We can't invoke the real handler without pi.on infrastructure; instead verify the
```

**Why**
The selfchecks only exercise the pure parsers (`parseResetDelayMs`, `messagesText`) and a hand-rolled slot harness. The durable-trail-mutating full-auto credit block, `autoCmd`, the `fireRetry`/`armRetry`/`rescheduleRetry` state machine, and the new `findNewestArtifactMd(stageName)` branch (segment + frontmatter + undefined fallback) have no assertion behind them — exactly the money/correctness paths most likely to regress silently.

**Fix**
Add a `findNewestArtifactMd(stageName)` assertion to `continue.selfcheck.ts` (segment match, irregular-plural miss, frontmatter fallback, no-match → undefined) and a small harness for the credit-eligibility predicate; these are pure enough to test without `pi.on`.

---

## 🔵 Suggestions

### Q6 🔵 Single-'s' pluralization misses irregular plurals

**Where**
`continue.ts:113`

**Fix**
Stage names whose dir is an irregular plural (e.g. `analysis`→`analyses`) and whose frontmatter lacks a stage field fall through to a cold re-run; either broaden the segment match or document the limitation next to the `ponytail:` note.

### Q5 🔵 Empty catch emits no diagnostic

**Where**
`commands.ts:107`

**Fix**
The credit block's `catch {}` swallows `readFileSync`/`parseFrontmatter`/`appendStage` failures with no notify — for an unattended overnight run, emit one `info`/`warning` notify ("artifact unreadable → cold re-run") so the audit trail shows the fall-through.

### Q9 🔵 Over-indented block

**Where**
`commands.ts:100`

**Fix**
`if (found) {` carries an extra tab vs the surrounding block; re-indent for readability (cosmetic).

---

## 💭 Discussion

### D1 💭 `autoMode` is in-memory only — lost on Pi restart mid-run

**Where**
`state.ts:31`

**Why**
The full-auto tier lives only in the `globalThis` Symbol slot (self-documented "in-memory, D1"). An overnight unattended run that survives a Pi process restart silently reverts to `off`. That may be the intended fail-safe (restart → require re-opt-in), but it deserves an explicit note in the README so operators of long runs aren't surprised. Decide: document the transience, or persist the tier to config.

---

## Pattern Analysis

| Peer                     | Mirrored | Missing | Diverged | Intentional |
| ------------------------ | -------: | ------: | -------: | ----------: |
| `watchdog.ts`            |       12 |      11 |        9 |           1 |
| `continue.selfcheck.ts`  |        8 |       0 |        1 |           0 |

**Missing/Diverged rows drive:** I3 (no `clearActiveRun` on give-up; no attempt counter; caps by wall-clock not attempts), Q8 (no isIdle gate is intentional but the handler path is also untested).

**Key divergences from peer**
- Give-up cleanup: watchdog calls `clearActiveRun()`; ratelimit calls only `clearRetry()` (→ I3).
- Bounding: watchdog caps by `MAX_RESUME_ATTEMPTS` (3); ratelimit caps by `MAX_RETRY_WALL_MS` (8h) — a deliberate, documented trade-off, but it removes the hard per-run attempt ceiling (precedent #2 lesson).
- Staleness guard: watchdog uses a monotonic epoch; ratelimit pins by active-run identity — both sound, just different.

---

## Impact

| Consumer                              | Change                                   | Findings |
| ------------------------------------- | ---------------------------------------- | -------- |
| `commands.ts:73` resumeCmd (hub)      | now runs full-auto credit for 3 callers  | I1       |
| `watchdog.ts:96` auto-resume          | routes through resumeCmd credit block    | I1       |
| `ratelimit.ts:190` 429 auto-resume    | routes through resumeCmd credit block    | I1, I3   |
| `autonomy.ts:110` before_agent_start  | reads autoMode each turn                 | I3, D1   |

---

## Precedents

| Commit    | Subject                                                        | Follow-ups                                            |
| --------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `b1164c3` | Add rpiv-wfex autonomy + resilience sidecar                    | `258b8d7` (+12 min, autonomy.ts) — scope narrowing    |
| `258b8d7` | Narrow autonomy directive to rote confirmations only           | none (established the rote/substantive boundary)      |
| `35a3eca` | Add /wfex continue — advance past interrupted-but-done stage   | none; this change extends its salvage to non-interactive credit |

**Recurring lessons (most → least frequent)**

1. **Autonomy scope creep is the #1 historical failure mode** (`258b8d7` narrowed it within 12 min). The full-auto toggle deliberately re-expands scope — the safe-mode heuristic + EXEMPTION block must stay tight (they do here).
2. **Cold re-runs are costly; salvage must respect stage boundaries** (`35a3eca`). I1 is the exact residual: salvage is stage-*name*-scoped but not run-scoped.
3. **Re-entrancy guards must not wedge across long sleeps** (`b1164c3`). The I1-in-code fix (`fireRetry` re-arms instead of clobbering the guard) honors this; verification confirmed no cross-subsystem race (I2 dropped).

---

## Recommendation

| # | ID  | Action                                                                                     | Alt / Note                         |
| - | --- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1 | I1  | Scope artifact credit to the current `runId` (or guard by mtime > failed-row ts); else cold re-run | temporal mtime guard as a cheaper alt |
| 2 | I3  | Call `clearActiveRun()` on ratelimit give-up so the run isn't left "live" after the cap     | factor a shared give-up helper      |
| 3 | Q8  | Add `findNewestArtifactMd(stageName)` + credit-eligibility assertions to the selfchecks     | —                                  |
