---
template_version: 2
date: 2026-06-29T08:51:02+0300
author: Flex
repository: rpiv-workflow-ex
branch: master
commit: 35a3eca
review_type: working
scope: "Working-tree changes — full-auto tri-state toggle + usage-limit retry loop (8 files)"
scope_strategy: working-tree
in_scope_files_count: 8
status: ready
severity: { critical: 0, important: 2, suggestion: 1 }
verification: { verified: 4, weakened: 0, falsified: 0 }
blockers_count: 2
tags: [code-review, rpiv-wfex, autonomy, rate-limit, retry, full-auto]
---

# Code Review — Full-auto toggle + usage-limit retry (working tree)

**Commit:** `35a3eca` (working tree) · **Status:** `ready` · **Findings:** 0🔴 · 2🟡 · 1🔵 · **Verification:** 4✓ / 0− / 0✗

## Top Blockers

1. **I1** — Usage-limit retry automates the loose "newest artifact" credit, so an unattended overnight 429 can silently skip a stage that never finished.
2. **Q1** — Full-auto credit picks the newest `.md` anywhere under `.rpiv/artifacts`, which may belong to a different stage or run.

---

## Legend

```text
Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss
ID prefix   I interaction   Q quality   S security   G gap
Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)
```

---

## 🟡 Important

### I1 🟡 Retry loop amplifies the unconfirmed full-auto credit

**Where**
`ratelimit.ts:180` → `commands.ts:96-102`

**Code**
```ts
// ratelimit.ts:180 — the retry tick re-enters resume on a timer
void Promise.resolve(pi.sendUserMessage(`/wfex resume @${runId}`)).catch((err) => {
// commands.ts:96-102 — which, in full-auto, credits an artifact and advances
if (getAutoMode() !== "off") {
  const last = rt.readLastStage(ctx.cwd, runId);
  if (last && last.parent === undefined && (last.status === "failed" || last.status === "aborted")) {
    const found = findNewestArtifactMd(ctx.cwd);
```

**Why**
A 429 mid-stage arms the retry loop, which re-sends `/wfex resume @<runId>` on a timer. In `safe`/`unattended` mode that resume path (Q1) credits the newest on-disk artifact and advances *past* the stage — with no human check. A stage interrupted by a usage limit before it finished writing its own artifact will be credited with whatever `.md` is newest (possibly a prior stage's or prior run's), turning a one-off manual heuristic into an automatic, repeated, unattended skip. This is the documented blast-radius of full-auto, but the retry automation is what makes it fire unattended overnight — exactly the target use case.

**Fix**
Scope the full-auto credit to an artifact the *interrupted stage itself* plausibly produced (match `last.stage`/`runId` against the artifact path or frontmatter) before crediting, or gate auto-credit to `safe` only and keep `unattended` on cold re-run for failed (not aborted) trailers.

**Alt**
Leave as-is (it is opt-in and documented), but log the credited artifact path at `warning` level so an unattended run leaves an audit trail of every skip.

---

### Q1 🟡 Full-auto credits the newest artifact anywhere, not the stage's own

**Where**
`commands.ts:99`

**Code**
```ts
const found = findNewestArtifactMd(ctx.cwd);
```

**Why**
`findNewestArtifactMd` returns the newest `*.md` recursively under `.rpiv/artifacts` regardless of stage, run, or kind. `continueCmd` uses the identical heuristic but asks the human to confirm the specific file first (`continue.ts` `ctx.ui.select`); the full-auto path drops that confirmation entirely. If a review/validation/plan doc is written after the interrupted stage's own artifact, that unrelated file is what gets credited into the synthetic `completed` row.

**Fix**
Filter candidates by the interrupted stage (e.g. path segment or frontmatter `parent`/`stage` matching `last.stage`) and skip the credit when none match, falling through to the existing cold re-run.

---

## 🔵 Suggestions

### Q2 🔵 Retry timer state machine has no self-check

**Where**
`ratelimit.ts:145` (`armRetry`/`fireRetry`/`clearRetry`/non-429 clear scoping)

**Fix**
The self-check covers `parseResetDelayMs` + `messagesText` (the parser, correctly the most breakable part) but not the arm/fire/reschedule/clear state machine — the single-loop invariant, deadline-from-first-429, and run-scoped non-429 clear are untested. Add a few `assert`s driving `retryState()` directly with a fake `pi.sendUserMessage` to lock the invariants. Acceptable to defer — timers are awkward to test and the parser is the silent-failure surface.

---

## 💭 Discussion

### D1 💭 `unattended` auto-proceeds past destructive "Stop" steps by prompt instruction only

**Where**
`autonomy.ts:88`

**Why**
`UNATTENDED_AUTO_DIRECTIVE` instructs the model to auto-proceed on destructive/irreversible "Stop" steps (carving out only the plan/working-tree mismatch). This is the stated intent of the tier, but the gate is a Markdown directive the model *chooses* to follow — there is no code-level enforcement in either direction, consistent with the rest of the sidecar's prompt-priority design. Worth confirming the team is comfortable that the single hard carve-out is prompt-enforced, not code-enforced, before trusting `unattended` on irreversible steps.

---

## Pattern Analysis

| Peer                    | Mirrored | Missing | Diverged | Intentional |
| ----------------------- | -------: | ------: | -------: | ----------: |
| `watchdog.ts`           |        4 |       0 |        1 |           0 |
| `continue.selfcheck.ts` |        4 |       0 |        0 |           0 |

> Peer-mirror agent hit a provider 429 before emitting its table; this row is the orchestrator's own comparison after reading both peers in full.

**Key divergences from peer**
- `ratelimit.ts` replaces the watchdog's monotonic `EPOCH_SLOT` staleness guard with a single-loop `isRetryArmed()` invariant (the 429 handler early-returns while a timer is armed, so at most one retry timer ever exists). Justified divergence — the epoch guard exists because multiple `session_start` events schedule overlapping watchdog timers, a condition the single-loop retry cannot reach.
- `markResuming`/`clearResuming` acquire+release symmetry, the `Symbol.for` private slot, the `register*(pi)` registrar shape, and the `void Promise.resolve(pi.sendUserMessage(...)).catch(clearResuming)` send pattern are all mirrored from `watchdog.ts`.

---

## Impact

| Consumer        | Change                                              | Findings |
| --------------- | --------------------------------------------------- | -------- |
| `extension.ts:19` | new `registerRateLimitRetry(pi)` registrar in fan-out | —     |
| `commands.ts:96`  | `resumeCmd` gains the full-auto credit branch         | Q1, I1 |
| `autonomy.ts:110` | per-turn directive now selected by `getAutoMode()`    | D1     |

---

## Recommendation

| # | ID  | Action                                                                                          | Alt / Note                          |
| - | --- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1 | I1  | Scope full-auto auto-credit to the interrupted stage's own artifact, or restrict it to `safe`.  | Or log every credited path at warn. |
| 2 | Q1  | Filter `findNewestArtifactMd` candidates by stage/run before crediting; fall through otherwise. | Shares the fix with I1.             |
| 3 | Q2  | Add `assert`-based coverage for the arm/fire/clear state machine.                               | Defer-able.                         |

**Note:** the feature is well-engineered and faithfully mirrors the existing watchdog/continue patterns; both 🟡 findings are facets of the same loose-artifact-selection heuristic that the validation report already flagged as the opt-in blast-radius of full-auto. No correctness defect in `off` (default) mode. Precedent severity weighting was a no-op (4 commits, days old, no 30-day follow-ups). Precedents/CVE/Dependencies lenses were skipped: `package.json` touched only the `files` allowlist, no dependency fields.
