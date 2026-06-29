---
template_version: 1
date: 2026-06-29T18:10:46+0300
author: Flex
commit: 5c779f0
branch: master
repository: rpiv-workflow-ex
topic: "Validation of cswap multi-account rotation on usage-limit (429) for the rpiv-wfex retry loop"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-29_15-41-06_cswap-account-rotation-on-usage-limit.md"
tags: [validation, plan, rpiv-wfex, ratelimit, cswap, multi-account, autonomy, resume]
last_updated: 2026-06-29T18:10:46+0300
---

## Validation Report: cswap multi-account rotation on usage-limit (429) for the rpiv-wfex retry loop

### Implementation Status

- ✓ Phase 1: cswap rotation module — Fully implemented
- ✓ Phase 2: Wire rotation into the retry loop — Fully implemented
- ✓ Phase 3: Self-checks and docs — Fully implemented

### Automated Verification Results

- ⚠️ Module loads + exports entry points: `node --import jiti/register -e "import('./cswap.ts')…"` — reports a false "missing export". This is a harness artifact, not a defect: jiti wraps a dynamic `import()` issued from `node -e` so the namespace exposes only `default` and the named exports read as `undefined`. The criterion (module loads, exports `parseSwitchOutcome`/`cswapAvailable`/`rotateToNextAccount`/`__setCswapForTest`) is met — verified three other ways below.
- ✓ Exports present (static import): a `.ts` file doing `import * as m from "./cswap.ts"` prints all four symbols as `function`.
- ✓ cswap parser tripwire: `node --import jiti/register cswap.selfcheck.ts` — prints `cswap.selfcheck: OK` (imports `parseSwitchOutcome`).
- ✓ ratelimit tripwire (existing + new rotation asserts): `node --import jiti/register ratelimit.selfcheck.ts` — prints `ratelimit.selfcheck: OK` (imports `__setCswapForTest`; all prior asserts intact under forced cswap-absent).
- ✓ Extension loads clean: `node --import jiti/register _loadcheck.ts` — prints `ok` (loads extension → ratelimit → cswap).
- ✓ cswap import wired: `grep -q 'from "./cswap.js"' ratelimit.ts` — present.
- ✓ Both new call sites present: `grep -c 'cswapAvailable()' ratelimit.ts` — returns 2 (429 handler + agent_end).
- ✓ `cswap.ts` shipped: `grep -q '"cswap.ts"' package.json` — present in `files`.
- ✓ No regressions detected — every pre-existing assert in `ratelimit.selfcheck.ts` still passes.

### Code Review Findings

#### Matches Plan:

- `cswap.ts:1-104` — NEW module byte-identical to Phase 1 spec: header doc, `SwitchResult`, pure `parseSwitchOutcome` (error envelope / `switched:false` / unparseable all handled), `cswapAvailableReal` (`--version`, offline), `rotateToNextAccountReal` (parses stdout on the throw path too), and the `__setCswapForTest` swappable seam.
- `cswap.ts:74` — exact invocation `["--switch", "--strategy", "next-available", "--json"]` — strategy spelled `next-available` as required (Phase 1 manual criterion).
- `ratelimit.ts:15-17` — header doc gains the multi-account sentence.
- `ratelimit.ts:22` — `import { cswapAvailable, rotateToNextAccount } from "./cswap.js";`.
- `ratelimit.ts:193-207` — `fireRetry` rotation step inserted between the `isResuming` bail and `markResuming`: `undefined` → fall through (cswap absent), `!switched` → notify "all managed Claude accounts at limit" + re-arm poll, no resume (D5), `switched` → notify "switched to Account-…" then resume (D3).
- `ratelimit.ts:253-262` — 429 handler computes `hasCswap` and arms `delay 0` when present (D4) with the branched warning message.
- `ratelimit.ts:268-269` — `agent_end` handler skips the subscription-reset reschedule when `cswapAvailable()` (D4).
- `ratelimit.selfcheck.ts:10,75,114-162` — `__setCswapForTest` import; cswap forced absent for the existing harness; seam reset added to the existing `finally`; new rotation block asserts the switched path (delay 0 + resume sent) and the exhausted path (no resume, poll re-armed), with the `RL_SLOT` reset defeating the `isRetryArmed` early-bail between sub-blocks.
- `package.json:13` — `"cswap.ts"` added to the shipped `files` array.
- `README.md:112-121` — "Multi-account rotation (cswap)" subsection documents the rotation, the resume-as-probe, the exhausted-wait, and the cswap-absent fallback.
- `CHANGELOG.md:5-11` — `[Unreleased] → Added` names the cswap multi-account rotation feature.

#### Deviations from Plan:

- None. Implementation is a faithful, line-for-line realization of the plan across all three phases.

#### Pattern Conformance:

- ✓ `cswap.ts` mirrors the `ratelimit.ts` module shape (header doc, pure parser export, real-impl + swappable seam) and the `state.ts` `__resetWfexState` test-seam convention (`__setCswapForTest`) as called for in Pattern References.
- ✓ `cswap.selfcheck.ts` follows the assert-only pure-function tripwire pattern; both self-checks remain framework-free.

### Manual Testing Required:

Runtime behaviors that require a live Pi run and an installed `cswap` (cannot be exercised by the self-checks, which stub the binary):

1. cswap absent:
   - [ ] A 429 during an active run logs "retrying until it resets" and resumes the same account (unchanged from before this feature).
2. cswap present + switch succeeds:
   - [ ] A 429 logs "switched to Account-N via cswap" and the run resumes on the fresh account.
3. cswap present + all accounts exhausted:
   - [ ] A 429 logs "all managed Claude accounts at limit" and does NOT send a resume that tick (waits ~10 min, then re-rotates).

### Recommendations:

- Ready to commit — implementation is complete and validated; all automated criteria pass (the lone "failure" is a jiti `node -e` harness artifact, not a code defect).
- Optional: replace the Phase 1 automated command in future plans with a static-import or `import().then(m => m.default ?? m)` form so the check does not false-fail under jiti's dynamic-import-from-eval wrapping.
- The three Manual Testing items above require a live `cswap` install + a real 429 and remain for operator verification.
