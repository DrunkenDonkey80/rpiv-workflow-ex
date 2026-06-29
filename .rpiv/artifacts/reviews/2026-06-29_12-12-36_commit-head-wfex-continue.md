---
template_version: 2
date: 2026-06-29T12:12:36+0300
author: Flex
repository: rpiv-workflow-ex
branch: master
commit: 35a3eca
review_type: commit
scope: "HEAD commit 35a3eca — /wfex continue"
scope_strategy: working-tree
in_scope_files_count: 5
status: ready
severity: { critical: 0, important: 2, suggestion: 2 }
verification: { verified: 4, weakened: 0, falsified: 0 }
blockers_count: 2
tags: [code-review, rpiv-wfex, continue, workflow]
---

# Code Review — HEAD commit 35a3eca (/wfex continue)

**Commit:** `35a3eca` · **Status:** `ready` · **Findings:** 0🔴 · 2🟡 · 2🔵 · **Verification:** 4✓ / 0− / 0✗

## Top Blockers

1. **I1** — Manual continue promises the interrupted stage's artifact, but selects the newest markdown globally.
2. **Q2** — No-ref `/wfex continue` can auto-pick a mid-loop run that `continueCmd` then refuses.

---

## Legend

```text
Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss
ID prefix   I interaction   Q quality   S security   G gap
Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)
Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]
```

---

## 🟡 Important

### I1 🟡 Manual continue can credit an unrelated newest artifact `[cascade: false-promise]`

**Where**
`README.md:46` → `continue.ts:183` → `continue.ts:207`

**Code**
```ts
// README.md:46
`/wfex continue` fixes exactly that: it finds the artifact the interrupted stage produced,

// continue.ts:183
const found = findNewestArtifactMd(ctx.cwd);

// continue.ts:207
if (!rt.appendStage(ctx.cwd, runId, row)) {
```

**Why**
The command is documented as crediting the interrupted stage's artifact, but the selection call has no stage, run-id, or timestamp constraint. If the user trusts that prompt and accepts the newest file, `appendStage` persists a synthetic completed row for whatever markdown happened to be newest.

**Fix**
Pass `last.stage` and a freshness guard into artifact selection for `continueCmd`, then fall back to cold resume when no matching artifact exists.

---

### Q2 🟡 No-ref `/wfex continue` can auto-pick a run that it then refuses

**Where**
`commands.ts:55` → `commands.ts:195` → `continue.ts:173`

**Code**
```ts
// commands.ts:55
return last.status === "failed" || last.status === "aborted" || last.parent !== undefined;

// commands.ts:195
const pick = pickNewestResumable(rt, ctx.cwd);

// continue.ts:173
if (last.parent !== undefined) {
```

**Why**
The shared auto-picker treats mid-loop rows as resumable, but `/wfex continue` rejects mid-loop rows. A bare `/wfex continue` can therefore choose the newest mid-loop run and stop instead of selecting a root failed/aborted run it can actually advance.

**Fix**
Use a continue-specific picker that only accepts root failed/aborted rows.

---

## 🔵 Suggestions

### Q3 🔵 Artifact scan can throw on a disappearing file

**Where**
`continue.ts:99`

**Fix**
Wrap `statSync(p)` per candidate and skip files that disappear or become unreadable after `readdirSync`.

---

### Q4 🔵 Package metadata still omits `/wfex continue`

**Where**
`package.json:4` → `commands.ts:216`

**Fix**
Update the package description to mention `/wfex continue`, or shorten it so command lists live only in README.

---

## Impact

| Consumer | Change | Findings |
| --- | --- | --- |
| `extension.ts:11-16` | loads the `/wfex` command hub | Q2 |
| `package.json:9-11` | ships `commands.ts`/`continue.ts` and registers the extension | Q4 |
| `README.md:46-49` | documents the stage-credit behavior users rely on | I1 |

---

## Precedents

| Commit | Subject | Follow-ups |
| --- | --- | --- |
| `b1164c3` | Add rpiv-wfex autonomy + resilience sidecar for rpiv-workflow | `258b8d7` narrowed over-broad autonomy within 30 days |
| `9eb35a0` | Rename package to rpiv-workflow-ex for npm publish | none found within 30 days |

**Recurring lessons (most → least frequent)**

1. Salvage/continue paths need tight artifact boundaries and selfchecks for stale or unrelated artifacts.
2. Command docs and package metadata drift easily; update them with the dispatcher change.

---

## Recommendation

| # | ID | Action | Alt / Note |
| - | --- | --- | --- |
| 1 | I1 | Scope manual continue artifact selection to the interrupted stage plus freshness. | Shares the helper with full-auto fixes. |
| 2 | Q2 | Split the continue picker from the resume picker. | One predicate is enough. |
| 3 | Q3 | Catch per-file `statSync` failures in the artifact scan. | Optional hardening. |
| 4 | Q4 | Refresh package metadata. | Or remove command enumeration there. |

Security found no sink findings. `package.json` changed only the publish `files` allowlist, so dependencies/CVEs had no actionable entries.
