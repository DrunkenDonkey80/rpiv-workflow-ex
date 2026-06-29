---
date: 2026-06-29T15:41:06+0300
author: Flex
commit: 5c779f0
branch: master
repository: rpiv-workflow-ex
topic: "cswap multi-account rotation on usage-limit (429) for the rpiv-wfex retry loop"
tags: [plan, rpiv-wfex, ratelimit, cswap, multi-account, autonomy, resume]
status: ready
parent: .rpiv/artifacts/research/2026-06-28_22-37-10_full-auto-mode-and-usage-limit-retry.md
phase_count: 3
phases:
  - { n: 1, title: cswap rotation module }
  - { n: 2, title: Wire rotation into the retry loop }
  - { n: 3, title: Self-checks and docs }
unresolved_phase_count: 0
last_updated: 2026-06-29T15:41:06+0300
last_updated_by: Flex
---

# cswap Multi-Account Rotation on Usage-Limit Implementation Plan

## Overview

When a usage limit (HTTP 429) ends a turn during an active workflow run, the rpiv-wfex
retry loop today re-sends `/wfex resume` on the same Claude account and polls until that
account's window resets. This plan adds a step in front of the resume: if the
`cswap` multi-account switcher is installed, rotate to the next non-rate-limited Claude
account (`cswap --switch --strategy next-available --json`) and resume there immediately.
When cswap is absent or every managed account is at its limit, the loop falls back to
today's poll-and-wait behavior unchanged.

## Requirements

- On a 429 during an active run, attempt to switch to another Claude account that still has
  usage headroom before waiting out the current account's reset window.
- Use the installed `cswap` CLI; this feature is Anthropic/Claude-specific (cswap manages
  only Claude Code accounts) — when cswap is not installed, behavior is exactly as today.
- Discover available accounts and pick one with headroom via cswap's own usage-aware
  strategy (no reimplementation of headroom math, no hardcoded slots).
- The re-sent `/wfex resume` turn is the "does this account have juice" probe — no separate
  probe message.
- When no account has headroom, do not hammer: try the accounts, then wait ~10 min and
  re-check (an account may reset in the interim), bounded by the existing wall-clock cap.

## Current State Analysis

The 429 retry loop lives entirely in `ratelimit.ts` and is registered by
`registerRateLimitRetry` (wired in `extension.ts:18`). It keys on
`after_provider_response` status 429, arms a `setTimeout` via `armRetry`, and each
`fireRetry` tick re-sends `/wfex resume @<runId>` guarded by the shared `isResuming`
re-entrancy marker (`state.ts:107-123`). A non-429 response clears the loop; a wall-clock
cap (`MAX_RETRY_WALL_MS`, 8h) bounds a never-resetting limit.

### Key Discoveries

- `ratelimit.ts:181-199` — `fireRetry`: the single place the resume is re-sent each tick;
  the natural insertion point for a pre-resume rotation attempt.
- `ratelimit.ts:230-247` — the `after_provider_response` 429 handler computes the initial
  arm delay from the `retry-after` header (`?? POLL_INTERVAL_MS`); this is where a
  "cswap present → fire immediately (delay 0)" branch goes.
- `ratelimit.ts:249-256` — the `agent_end` handler reschedules to a parsed subscription
  reset time; with cswap present we prefer the 10-min rotation cadence over waiting out a
  single account's HH:MM reset, so this reschedule is skipped when cswap is available.
- `ratelimit.ts:14-16` — `POLL_INTERVAL_MS = 10min`, `MAX_RETRY_WALL_MS = 8h`: the cadence
  and runaway guard are reused as-is.
- `ratelimit.ts:165-179` — `armRetry` already honors the wall-clock deadline and clamps the
  next delay to the remaining budget; rotation rides on top of it unchanged.
- `state.ts` exposes `getActiveRunId`, `isResuming`, `markResuming`, `clearResuming`,
  `clearActiveRun` — the rotation path reuses these; no new state is needed.
- cswap JSON contract (verified live, schemaVersion 1):
  - `cswap --switch --strategy next-available --json` → `{ switched: boolean, to: { number, email }, reason, message, warnings }`. `reason` is `switched` / `already-active` / `exhausted` / `stay`; an error envelope is `{ error: { type, message } }`. Exit code is 0 even for the error envelope and for `switched:false` — parse JSON, never trust exit code.
  - `cswap --version` is a cheap, offline presence check (no network).
- `ratelimit.selfcheck.ts` is an assert-only tripwire run via
  `node --import jiti/register ratelimit.selfcheck.ts`; it mocks `setTimeout` and drives the
  real handlers. It calls `fireRetry` directly, so the rotation call MUST be injectable to
  avoid switching the developer's real Claude account during a test run.

## Desired End State

```text
# Account 6 is the active Claude login; a workflow run hits a usage limit:
rpiv-wfex: usage limit (429) on @abcd — trying other Claude accounts (cswap), then polling (cap 8h).
rpiv-wfex: switched to Account-3 (flex@datecs.bg) — resuming @abcd.
# run continues on account 3 with no human present.

# Later, account 3 also limits and every managed account is exhausted:
rpiv-wfex: all managed Claude accounts at limit (exhausted) — re-checking @abcd in 10m.
# 10 min later an account has reset; rotation lands on it and resume continues.

# On a machine without cswap installed: behavior is unchanged —
rpiv-wfex: usage limit (429) on @abcd — retrying until it resets (cap 8h).
```

## What We're NOT Doing

- Not persisting the chosen account or any rotation preference — cswap owns account state.
- Not parsing per-account `resetsAt` from `cswap --list` to schedule a precise wake-up; the
  user chose 10-min polling between rotation sweeps (`next-available` already skips limited
  accounts in one call).
- Not adding a manual `/wfex rotate` command — rotation is automatic on a run 429 only.
- Not detecting the provider beyond cswap presence — cswap exists only for Claude/Anthropic,
  so "cswap installed + 429 in an active run" is the gate.
- Not gating rotation behind `/wfex auto` mode — the retry loop already runs on any run 429
  regardless of `autoMode`, and rotation rides the same trigger (D2).
- Not using `cswap --strategy best` or a `--list` + `--switch-to` scan — `next-available`
  was chosen (D1).
- Not touching `watchdog.ts` (a freeze is a different failure mode) or the autonomy directive.

## Decisions

### D1 — Rotation primitive: `cswap --switch --strategy next-available --json`
**Decision**: Rotate with `cswap --switch --strategy next-available --json`. It rotates to
the next account, skipping any currently at its 5h/7d limit, in a single call, and reports
`switched:false reason:"exhausted"` when none is available. Chosen over `--strategy best`
(jumps to most headroom) and over a manual `--list` + `--switch-to` scan (reimplements
headroom selection cswap already does). Developer choice.

### D2 — Gating: always on a run 429, independent of `/wfex auto`
**Decision**: Attempt rotation whenever a 429 fires during an active run — the same trigger
as today's retry loop (`ratelimit.ts` runs independent of `getAutoMode()`). Not gated behind
safe/unattended auto. Matches "set it and walk away." Developer choice.

### D3 — No probe turn; the resume is the probe
**Decision**: After a successful switch, re-send `/wfex resume` directly. cswap only lands
on an account with proven headroom (it skips limited ones); if that account 429s anyway, the
next tick rotates onward. No throwaway "hi" turn. Developer choice.

### D4 — cswap present → fire immediately + skip subscription-reset reschedule
**Decision**: When cswap is available, arm the first retry tick with delay 0 (rotate now
rather than wait the current account's window) and skip the `agent_end` subscription-reset
reschedule (we prefer the 10-min rotation cadence to waiting out one account's HH:MM reset).
When cswap is absent, the initial delay and the reschedule are exactly as today. Derived from
the user's "if we have cswap we can ignore the HH:MM detection … try them all then wait 10 min."

### D5 — Exhausted → wait, do not hammer
**Decision**: When `cswap` reports `switched:false` (every account at its limit), do NOT
re-send resume on the still-limited active account; re-arm the 10-min poll and re-rotate next
tick (an account may reset). Only a successful switch — or cswap being absent — proceeds to
the resume. cswap-absent keeps today's blind resume-and-poll behavior byte-for-byte. Derived.

## Phase 1: cswap rotation module

### Overview
New `cswap.ts` module: a cheap offline presence check, a pure JSON-outcome parser, and the
`next-available` rotation call, plus a test seam so self-checks never hit the real binary.
Foundation — depends on nothing.

### Changes Required:

#### 1. cswap.ts
**File**: cswap.ts
**Changes**: NEW — cswap presence check, switch-outcome parser, rotation call, test seam.

```typescript
/**
 * rpiv-wfex cswap bridge — when a usage limit (429) blocks an active run, the
 * retry loop in ratelimit.ts asks this module to rotate to another Claude
 * account instead of waiting out the current account's reset window. Backed by
 * the `cswap` (claude-swap) CLI, which manages multiple Claude Code logins; the
 * feature is Anthropic-specific (cswap exists only for Claude), so "cswap on
 * PATH" is the gate. When cswap is absent every entry point degrades to a no-op
 * and ratelimit.ts keeps its original poll-and-wait behavior.
 *
 * cswap quirk: it exits 0 even for its JSON error envelope and for a
 * switched:false result — so parseSwitchOutcome keys on the JSON body, never the
 * exit code. The rotation + presence calls route through a swappable impl seam
 * (__setCswapForTest) so self-checks never spawn the real binary and switch the
 * developer's live account.
 */

import { execFileSync } from "node:child_process";

const CSWAP = "cswap";
/** cswap network usage-fetch can take a couple seconds; cap it. */
const SWITCH_TIMEOUT_MS = 30_000;

/** Minimal outcome the retry loop needs: did we land on a different account, and a label/reason for the log. */
export interface SwitchResult {
	switched: boolean;
	/** "number (email)" of the account we ended on, when known. */
	account?: string;
	/** cswap reason ("switched" | "already-active" | "exhausted" | "stay") or an error message. */
	reason?: string;
}

/**
 * Parse `cswap --switch … --json` stdout into a SwitchResult. Pure — the
 * unit-testable core. Handles the success payload, the switched:false payload,
 * and the { error } envelope; unparseable input is treated as "did not switch".
 */
export function parseSwitchOutcome(stdout: string): SwitchResult {
	try {
		const j = JSON.parse(stdout) as {
			switched?: boolean;
			to?: { number?: number; email?: string };
			reason?: string;
			error?: { message?: string };
		};
		if (j.error) return { switched: false, reason: j.error.message ?? "cswap error" };
		const account = j.to && j.to.number !== undefined ? `${j.to.number} (${j.to.email ?? "?"})` : undefined;
		return { switched: j.switched === true, account, reason: j.reason };
	} catch {
		return { switched: false, reason: "unparseable cswap output" };
	}
}

/** Real presence check: `cswap --version` is offline + fast. */
function cswapAvailableReal(): boolean {
	try {
		execFileSync(CSWAP, ["--version"], { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Real rotation: `cswap --switch --strategy next-available --json` rotates to the
 * next account, skipping any at its 5h/7d limit. cswap emits its JSON envelope on
 * stdout even on the error path (exit 0), but a binary-missing/timeout throw has
 * stdout on the error object — parse it when present, else report the throw.
 * ponytail: synchronous spawn (~1-3s network fetch). Runs on an idle retry tick,
 * not a hot path; make async if it ever stalls the event loop noticeably.
 */
function rotateToNextAccountReal(): SwitchResult | undefined {
	if (!cswapAvailable()) return undefined;
	try {
		const out = execFileSync(CSWAP, ["--switch", "--strategy", "next-available", "--json"], {
			encoding: "utf8",
			timeout: SWITCH_TIMEOUT_MS,
		});
		return parseSwitchOutcome(out);
	} catch (e) {
		const stdout = (e as { stdout?: unknown }).stdout;
		if (typeof stdout === "string" && stdout.trim()) return parseSwitchOutcome(stdout);
		return { switched: false, reason: e instanceof Error ? e.message : String(e) };
	}
}

// --- swappable impl seam (self-checks stub these so no real binary is spawned) ---

let availableImpl: () => boolean = cswapAvailableReal;
let rotateImpl: () => SwitchResult | undefined = rotateToNextAccountReal;

/** True when the cswap CLI is installed (cheap, offline, called per 429). */
export function cswapAvailable(): boolean {
	return availableImpl();
}

/** Rotate to the next non-limited Claude account; undefined when cswap is absent. */
export function rotateToNextAccount(): SwitchResult | undefined {
	return rotateImpl();
}

/** Test seam — override (or reset with undefined) the cswap calls. Mirrors state.ts __resetWfexState. */
export function __setCswapForTest(overrides: { available?: () => boolean; rotate?: () => SwitchResult | undefined } | undefined): void {
	availableImpl = overrides?.available ?? cswapAvailableReal;
	rotateImpl = overrides?.rotate ?? rotateToNextAccountReal;
}
```

### Success Criteria:

#### Automated Verification:
- [x] Module loads clean and exports the rotation entry point: `node --import jiti/register -e "import('./cswap.ts').then(m=>{if(['parseSwitchOutcome','cswapAvailable','rotateToNextAccount','__setCswapForTest'].some(k=>typeof m[k]!=='function'))throw new Error('missing export');console.log('cswap loads: OK')})"`

#### Manual Verification:
- [x] The exact invocation issued is `cswap --switch --strategy next-available --json` (strategy spelled `next-available` — a typo makes cswap `parser.error` and exit nonzero).

## Phase 2: Wire rotation into the retry loop

### Overview
Insert rotation into `ratelimit.ts`: fire immediately when cswap is present, rotate before
each resume, skip the resume (wait) when all accounts are exhausted, and skip the
subscription-reset reschedule under cswap. Depends on Phase 1.

### Changes Required:

#### 1. ratelimit.ts
**File**: ratelimit.ts
**Changes**: MODIFY — import cswap helpers; rotation in `fireRetry`; delay-0 + messaging in the 429 handler; cswap-gated skip in the `agent_end` handler.

Module header (`ratelimit.ts:1-15`) — append one sentence after the existing doc:

```typescript
 * Multi-account: when the `cswap` switcher is installed, each retry first rotates
 * to another Claude account with headroom (cswap.ts) before resuming — so a
 * usage-limited account is sidestepped rather than waited out (see fireRetry).
```

New import (after the `./state.js` import at `ratelimit.ts:18`):

```typescript
import { cswapAvailable, rotateToNextAccount } from "./cswap.js";
```

`fireRetry` (`ratelimit.ts:175-205`) — insert the rotation step between the `isResuming` bail and `markResuming`:

```typescript
function fireRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string): void {
	retryState().timer = undefined; // this tick consumed
	if (getActiveRunId() !== runId) {
		clearRetry();
		return; // run ended or changed — nothing to retry
	}
	// I1: bail (re-arm to poll) when isResuming is already set by another resumer —
	// force-clearing discards a watchdog-owned interlock and can drive a second concurrent
	// resume for the same run. If still set after a full poll interval, let the watchdog
	// (session_start path) own recovery rather than clobbering its marker.
	if (isResuming(runId)) {
		armRetry(pi, ctx, runId, POLL_INTERVAL_MS); // re-poll; don't force-clear
		return;
	}
	// cswap multi-account rotation (D1-D5): before resuming the still-limited account,
	// try switching to another Claude account that still has headroom. undefined =>
	// cswap not installed => fall through to the original same-account resume+poll.
	const rot = rotateToNextAccount();
	if (rot && !rot.switched) {
		// cswap present but every managed account is at its limit (D5): don't hammer the
		// current account with a doomed resume — wait a poll interval and re-rotate (an
		// account may reset in the interim), still bounded by the wall-clock cap.
		safeNotify(ctx, `rpiv-wfex: all managed Claude accounts at limit (${rot.reason ?? "exhausted"}) — re-checking @${runId} in ${Math.round(POLL_INTERVAL_MS / 60_000)}m.`, "info");
		armRetry(pi, ctx, runId, POLL_INTERVAL_MS);
		return;
	}
	if (rot?.switched) {
		safeNotify(ctx, `rpiv-wfex: switched to Account-${rot.account ?? "?"} via cswap — resuming @${runId}.`, "info");
	}
	markResuming(runId); // suppress the session_start storm the resume's own spawns trigger (same guard the watchdog uses)
	safeNotify(ctx, `rpiv-wfex: retrying @${runId} after usage limit…`, "info");
	void Promise.resolve(pi.sendUserMessage(`/wfex resume @${runId}`)).catch((err) => {
		clearResuming(runId); // queue failed → resumeCmd's finally never runs; release the guard here
		safeNotify(ctx, `rpiv-wfex: could not queue resume for @${runId} — ${String(err)}`, "error");
	});
	armRetry(pi, ctx, runId, POLL_INTERVAL_MS); // keep polling; a non-429 response clears the loop
}
```

`after_provider_response` 429 branch (`ratelimit.ts:236-242`) — replace the delay/notify computation:

```typescript
		const headers = (event as { headers?: Record<string, string | string[] | undefined> }).headers;
		// D4: cswap installed → fire the first tick immediately (delay 0) to rotate accounts
		// rather than wait out this account's window; absent cswap → today's retry-after/poll wait.
		const hasCswap = cswapAvailable();
		const delay = hasCswap ? 0 : (parseResetDelayMs(firstHeader(headers, "retry-after")) ?? POLL_INTERVAL_MS);
		safeNotify(
			ctx as RetryCtx,
			hasCswap
				? `rpiv-wfex: usage limit (429) on @${runId} — trying other Claude accounts (cswap), then polling (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`
				: `rpiv-wfex: usage limit (429) on @${runId} — retrying until it resets (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`,
			"warning",
		);
		armRetry(pi, ctx as RetryCtx, runId, delay);
```

`agent_end` handler (`ratelimit.ts:243-251`) — add the cswap skip after the armed-check:

```typescript
	pi.on("agent_end", async (event, ctx) => {
		if (!isRetryArmed()) return; // only refine an already-armed retry
		if (cswapAvailable()) return; // D4: with cswap we poll-and-rotate every 10 min; don't defer to one account's HH:MM reset
		const runId = getActiveRunId();
		if (!runId) return;
		const messages = (event as { messages?: unknown }).messages;
		const delay = parseResetDelayMs(messagesText(messages));
		if (delay === undefined) return; // no subscription reset string → keep polling
		rescheduleRetry(pi, ctx as RetryCtx, runId, delay);
	});
```

### Success Criteria:

#### Automated Verification:
- [x] Extension still loads clean: `node --import jiti/register _loadcheck.ts` prints `ok`
- [x] cswap import is wired: `grep -q 'from "./cswap.js"' ratelimit.ts`
- [x] Both new call sites present: `grep -c 'cswapAvailable()' ratelimit.ts` returns >= 2 (429 handler + agent_end)

#### Manual Verification:
- [ ] cswap absent: a 429 logs "retrying until it resets" and resumes the same account (unchanged from today).
- [ ] cswap present + a switch succeeds: logs "switched to Account-N via cswap" then resumes on that account.
- [ ] cswap present + all accounts exhausted: logs "all managed Claude accounts at limit" and does NOT send a resume that tick (waits 10 min).

## Phase 3: Self-checks and docs

### Overview
Add `cswap.selfcheck.ts` for the pure parser, extend `ratelimit.selfcheck.ts` to drive the
rotation paths through the test seam, and update README, CHANGELOG, and `package.json` files.
Depends on Phase 2.

### Changes Required:

#### 1. cswap.selfcheck.ts
**File**: cswap.selfcheck.ts
**Changes**: NEW — assert-only tripwire for `parseSwitchOutcome`.

```typescript
/**
 * rpiv-wfex cswap self-check — `node --import jiti/register cswap.selfcheck.ts`.
 * Assert-only tripwire for parseSwitchOutcome against the real cswap JSON shapes
 * (verified live: switch payload, switched:false/exhausted, { error } envelope).
 */
import { strict as assert } from "node:assert";
import { parseSwitchOutcome } from "./cswap.js";

// success: switched to another account
const ok = parseSwitchOutcome(JSON.stringify({ schemaVersion: 1, switched: true, to: { number: 3, email: "flex@datecs.bg" }, reason: "switched" }));
assert.equal(ok.switched, true, "switch payload → switched true");
assert.equal(ok.account, "3 (flex@datecs.bg)", "account label is 'number (email)'");

// already-active: from == to (switched false)
const same = parseSwitchOutcome(JSON.stringify({ switched: false, to: { number: 6, email: "x@y.z" }, reason: "already-active" }));
assert.equal(same.switched, false, "already-active → switched false");

// exhausted: every managed account at its limit
const ex = parseSwitchOutcome(JSON.stringify({ switched: false, to: { number: 6, email: "x@y.z" }, reason: "exhausted" }));
assert.equal(ex.switched, false, "exhausted → switched false");
assert.equal(ex.reason, "exhausted", "exhausted reason preserved");

// error envelope (e.g. no stored credentials) — cswap exits 0, body carries the error
const err = parseSwitchOutcome(JSON.stringify({ schemaVersion: 1, error: { type: "SwitchError", message: "Account-2 has no stored credentials." } }));
assert.equal(err.switched, false, "error envelope → switched false");
assert.equal(err.reason, "Account-2 has no stored credentials.", "error message surfaced as reason");

// switched:true without a 'to' block → no account label, still parses
const noTo = parseSwitchOutcome(JSON.stringify({ switched: true }));
assert.equal(noTo.switched, true, "switched true without 'to'");
assert.equal(noTo.account, undefined, "no 'to' → undefined account");

// non-JSON / empty → switched false, never throws
assert.equal(parseSwitchOutcome("not json").switched, false, "garbage → switched false");
assert.equal(parseSwitchOutcome("").switched, false, "empty → switched false");

console.log("cswap.selfcheck: OK");
```

#### 2. ratelimit.selfcheck.ts
**File**: ratelimit.selfcheck.ts
**Changes**: MODIFY — inject the cswap test seam; assert the rotate-switched and rotate-exhausted paths.

New import (after the existing `./state.js` import):

```typescript
import { __setCswapForTest } from "./cswap.js";
```

In the EXISTING handler harness, force cswap absent so every current assert holds unchanged — insert right after `setActiveRun("run1");`:

```typescript
		__setCswapForTest({ available: () => false, rotate: () => undefined }); // existing asserts assume the no-cswap path
```

Add the seam reset to the EXISTING `finally` block:

```typescript
	} finally {
		globalThis.setTimeout = realSetTimeout;
		__setCswapForTest(undefined);
		__resetWfexState();
	}
```

Append this NEW block immediately before the final `console.log("ratelimit.selfcheck: OK");`:

```typescript
// --- cswap rotation paths (Phase 2 wiring) ---
{
	const handlers: Record<string, Function[]> = {};
	const sent: string[] = [];
	const fakePi = {
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		sendUserMessage: (msg: string) => { sent.push(msg); return Promise.resolve(); },
	} as unknown as ExtensionAPI;
	const fakeCtx = { ui: { notify: () => {} } };
	const realSetTimeout = globalThis.setTimeout;
	const scheduled: { fn: Function; delay: number }[] = [];
	const RL_SLOT = Symbol.for("@flex/rpiv-wfex:ratelimit");
	try {
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: Function, delay?: number) => {
			scheduled.push({ fn, delay: Number(delay) });
			return { unref: () => {} } as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		// switched: cswap present, a fresh account is found → immediate tick + resume
		__resetWfexState();
		(globalThis as Record<symbol, unknown>)[RL_SLOT] = undefined;
		setActiveRun("runC");
		__setCswapForTest({ available: () => true, rotate: () => ({ switched: true, account: "3 (a@b.c)" }) });
		registerRateLimitRetry(fakePi);
		await handlers.after_provider_response![0]!({ status: 429, headers: { "retry-after": "600" } }, fakeCtx);
		assert.equal(scheduled.at(-1)!.delay, 0, "cswap present → first 429 arms an immediate (delay 0) tick");
		scheduled.at(-1)!.fn();
		assert.deepEqual(sent, ["/wfex resume @runC"], "switched account → resume is sent");

		// exhausted: cswap present, all accounts at limit → no resume, just re-poll
		__resetWfexState();
		(globalThis as Record<symbol, unknown>)[RL_SLOT] = undefined; // defeat the isRetryArmed early-bail between sub-blocks
		setActiveRun("runX");
		sent.length = 0;
		__setCswapForTest({ available: () => true, rotate: () => ({ switched: false, reason: "exhausted" }) });
		await handlers.after_provider_response![0]!({ status: 429, headers: {} }, fakeCtx);
		const beforeFire = scheduled.length;
		scheduled.at(-1)!.fn();
		assert.deepEqual(sent, [], "all accounts exhausted → no resume sent this tick");
		assert.equal(scheduled.length, beforeFire + 1, "exhausted tick re-arms the poll timer");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		__setCswapForTest(undefined);
		(globalThis as Record<symbol, unknown>)[RL_SLOT] = undefined;
		__resetWfexState();
	}
}
```

#### 3. package.json
**File**: package.json
**Changes**: MODIFY — add `cswap.ts` to the shipped `files` array.

```json
	"files": ["extension.ts", "state.ts", "autonomy.ts", "commands.ts", "continue.ts", "watchdog.ts", "ratelimit.ts", "cswap.ts", "README.md", "CHANGELOG.md"],
```

#### 4. README.md
**File**: README.md
**Changes**: MODIFY — document cswap account-rotation on usage-limit.

Add this subsection at the end of the `## Usage-limit retry` section (before `## Model settings`):

```markdown
### Multi-account rotation (cswap)

If the [`cswap`](https://pypi.org/project/claude-swap/) multi-account switcher is installed, a 429 during an active run first tries to **switch to another Claude account that still has usage headroom** instead of waiting out the current account's reset window:

- on each retry it runs `cswap --switch --strategy next-available --json`, which rotates to the next account and skips any currently at its 5h/7d limit;
- on a successful switch it resumes immediately on the fresh account — the resumed turn itself is the "does this account still have quota" probe, so there is no extra check-in message;
- when every managed account is at its limit, it does not hammer the limited account: it waits about 10 minutes and re-checks (an account may reset in the interim), still bounded by the ~8-hour wall-clock cap.

This is Claude/Anthropic-specific (`cswap` manages only Claude Code logins). When `cswap` is not installed, the retry loop behaves exactly as described above on the same account (retry-after / reset-string / ~10-minute polling).
```

#### 5. CHANGELOG.md
**File**: CHANGELOG.md
**Changes**: MODIFY — add an [Unreleased] entry.

Insert above the `## [0.2.0] - 2026-06-29` heading:

```markdown
## [Unreleased]

### Added

- Multi-account rotation on usage limits: when the `cswap` switcher is installed, a 429 during an active run rotates to the next non-rate-limited Claude account (`cswap --switch --strategy next-available --json`) and resumes there instead of waiting out the current account's reset window. Falls back to the existing poll-and-wait loop when `cswap` is absent or every managed account is exhausted.
```

### Success Criteria:

#### Automated Verification:
- [x] cswap parser tripwire passes: `node --import jiti/register cswap.selfcheck.ts` prints `cswap.selfcheck: OK`
- [x] ratelimit tripwire passes with existing + new rotation asserts: `node --import jiti/register ratelimit.selfcheck.ts` prints `ratelimit.selfcheck: OK`
- [x] Extension loads clean: `node --import jiti/register _loadcheck.ts` prints `ok`
- [x] `cswap.ts` is shipped: `grep -q '"cswap.ts"' package.json`

#### Manual Verification:
- [ ] README `## Usage-limit retry` documents the cswap rotation behavior and the cswap-absent fallback.
- [ ] CHANGELOG `[Unreleased]` names the cswap multi-account rotation feature.

## Ordering Constraints

- Phase 1 (cswap.ts) is the foundation — Phases 2 and 3 import from it.
- Phase 2 wires Phase 1 into `ratelimit.ts`.
- Phase 3 tests + documents Phases 1-2 and must run last (its self-checks exercise the wired code).
- Phases are strictly sequential; none run in parallel.

## Verification Notes

- cswap returns exit code 0 even for its JSON error envelope and for `switched:false` — the
  parser must key on the JSON body, never the exit code (verified live).
- The self-check MUST NOT invoke the real `cswap` binary (it would switch the developer's
  active Claude account). Route rotation + availability through a test seam and force a stub
  in `ratelimit.selfcheck.ts`.
- cswap-absent path must remain byte-for-byte today's behavior: `node --import jiti/register
  ratelimit.selfcheck.ts` must still print `ratelimit.selfcheck: OK` with all existing asserts
  intact.
- `node --import jiti/register _loadcheck.ts` must still print `ok` (extension loads clean).
- `cswap --switch --strategy next-available --json` is the exact invocation — a typo in the
  strategy name makes cswap `parser.error` and exit nonzero (caught, falls back to wait).

## Performance Considerations

- `cswap --switch --strategy next-available` performs a usage network fetch (~1-3s). It runs
  on an idle retry tick (a setTimeout callback while the run is rate-limited), not a hot path,
  so a synchronous `execFileSync` is acceptable. Marked with a `ponytail:` ceiling comment —
  make async if it ever stalls the event loop noticeably.
- The `cswap --version` presence check is offline (no network — version print or an ENOENT throw).
  It is re-run per retry tick rather than memoized; on the idle ~10-min cadence the cost is
  negligible, so it is intentionally left uncached (a mid-session cswap install is then seen on the
  next tick instead of requiring a restart).

## Migration Notes

Not applicable — no persisted state, no schema. cswap-absent installs are unaffected.

## Pattern References

- `ratelimit.ts:1-90` — module shape (header doc, global-slot state, `safeNotify`, pure
  parser exports) to mirror in `cswap.ts`.
- `ratelimit.selfcheck.ts:1-40` — assert-only pure-function tripwire pattern for
  `cswap.selfcheck.ts`.
- `state.ts:160` — `__resetWfexState` test-seam convention to mirror with a cswap test seam.

## Developer Context

**Q (switch primitive): how should the sidecar pick the next account on a 429?**
A: `cswap --switch --strategy next-available --json` — rotates one step, skipping
rate-limited accounts (D1).

**Q (gating): when should account-rotation kick in?**
A: Always on a run 429, independent of `/wfex auto` mode — same trigger as today's retry loop (D2).

**Q (juice probe): how to confirm the new account has usage left?**
A: Trust cswap's headroom-aware rotation; the re-sent `/wfex resume` turn is the probe (D3).

## Plan History

- Phase 1: cswap rotation module — approved as generated (verifier: atomicity criterion moved to Phase 3; module-level seam vs Symbol slot accepted by-design — no cross-session state)
- Phase 2: Wire rotation into the retry loop — approved as generated (verifier: Decisions/Cross-slice/Research OK; cswap-absent path confirmed byte-for-byte unchanged)
- Phase 3: Self-checks and docs — approved as generated (verifier: Decisions/Cross-slice/Research OK; cswap-absent path preserves all existing ratelimit.selfcheck asserts; RL-slot reset defeats the isRetryArmed early-bail between sub-blocks)

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc          | codebase-loc | severity   | dimension    | finding   | recommendation   | resolution         |
| -------- | ----------------- | ------------ | ---------- | ------------ | --------- | ---------------- | ------------------ |
| code     | Phase 1 §1 (cswap.ts) | <n/a>    | suggestion | code-quality | Performance Considerations asserts the `cswap --version` presence check is "cached for the process," but `cswapAvailableReal()` re-spawns `execFileSync(CSWAP, ["--version"])` on every call — invoked per-429-handler, per-`agent_end`-while-armed, and again inside `rotateToNextAccountReal()` on every `fireRetry` tick; on cswap-absent machines each poll tick re-attempts the ENOENT spawn rather than reusing a cached `false`. | Memoize the first `cswapAvailableReal()` result in a module-level `boolean \| undefined` so `cswapAvailable()` honors the stated "cached for the process" guarantee. | dismissed: prose corrected — the inaccurate "cached for the process" claim was dropped from Performance Considerations; the offline ENOENT/`--version` spawn on the ~10-min idle tick is negligible, and leaving it uncached lets a mid-session cswap install be detected on the next tick. |

_artifact-coverage-reviewer: no findings — all 5 `## Verification Notes` entries covered by a Success Criteria bullet or a code mirror._

## References

- Research: `.rpiv/artifacts/research/2026-06-28_22-37-10_full-auto-mode-and-usage-limit-retry.md`
- Prior plan: `.rpiv/artifacts/plans/2026-06-28_22-51-21_full-auto-mode-and-usage-limit-retry.md`
- `ratelimit.ts` — the 429 retry loop being extended
- cswap (claude-swap 0.14.0) — `cswap --help`, `cswap --list --json`, `cswap --switch --strategy next-available --json`
