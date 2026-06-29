---
date: 2026-06-28T22:51:21+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Full-auto tri-state toggle + retry-until-usage-limit-resets for the rpiv-wfex sidecar"
tags: [plan, rpiv-wfex, autonomy, rate-limit, retry, full-auto, watchdog]
status: ready
parent: .rpiv/artifacts/research/2026-06-28_22-37-10_full-auto-mode-and-usage-limit-retry.md
phase_count: 8
phases:
  - { n: 1, title: State foundation — autoMode tri-state }
  - { n: 2, title: Autonomy directive branching }
  - { n: 3, title: /wfex auto command }
  - { n: 4, title: Rate-limit retry loop }
  - { n: 5, title: Subscription reset wiring — agent_end message scan }
  - { n: 6, title: Self-check + docs }
  - { n: 7, title: Continue-preference for full-auto retry }
  - { n: 8, title: Manual continue hardening + metadata refresh }
unresolved_phase_count: 0
last_updated: 2026-06-29T12:57:54+0300
last_updated_by: Claude (revise)
last_updated_note: "review 2026-06-29_12-12-36: manual continue artifact scope + picker"
---

# Full-auto Tri-state Toggle + Retry-Until-Usage-Limit-Resets Implementation Plan

## Overview

Two additive features for the `rpiv-wfex` sidecar, zero engine edits. (1) A tri-state
`autoMode` toggle (`off | safe | unattended`, default `off`) held in the in-memory state slot,
surfaced as `/wfex auto <mode>`, that branches the autonomy directive text — `safe` auto-answers
the PAUSE-list decisions with a refined heuristic while genuine safety stops still halt;
`unattended` auto-answers everything except the plan/working-tree mismatch. (2) A new
`ratelimit.ts` registrar that observes 429s via `after_provider_response`, parses a reset time
when one is present (else 10-min polls), re-sends `/wfex resume @<runId>` until the usage window
clears, bounded by a wall-clock cap.

## Requirements

- **Full-auto toggle** — tri-state, default off. `safe` (#1): auto-pick PAUSE-list decisions —
  default Recommended, override to a more-complete option ONLY when strictly additive (no drawback)
  AND not deferred to a later unit/stage; genuine safety stops still halt. `unattended` (#2):
  auto-pick everything EXCEPT the plan/working-tree mismatch (carve-out kept).
- **Retry-until-reset** — on a 429 usage limit, stop dying after Pi's provider auto-retry exhausts;
  instead keep re-sending resume until the window resets, then continue. Parse a reset time when
  present for a single precise wait; else poll ~every 10 min. Bound total by a wall-clock cap
  (~one usage window + margin) then notify + stop.
- **Config note** — tune Pi's `retry.provider` for short blips (README doc only, no code).

## Current State Analysis

The sidecar is a 7-file Pi extension wiring three registrars (`extension.ts:14-16`):
`registerWfexCommands`, `registerAutonomy`, `registerWatchdog`. Run-state lives in a
`globalThis` `Symbol.for` slot (`state.ts:25-37`) surviving session replacement in-process.

### Key Discoveries
- **Autonomy is one prompt string** — `AUTONOMY_DIRECTIVE` (`autonomy.ts:18-46`) injected by a
  `before_agent_start` handler gated on `isRunActive()` (`autonomy.ts:54-59`). No toggle today;
  it reads state every turn so branching needs no re-registration.
- **The PAUSE list / safety EXEMPTION contract** — `autonomy.ts:30-37` routes substantive
  decisions to a human; `autonomy.ts:38-42` always halts (plan/working-tree mismatch, destructive
  "Stop"). `safe` lifts the PAUSE list; `unattended` lifts all but the working-tree mismatch.
- **The "3 tries" is Pi's provider auto-retry, not the sidecar** — `MAX_RESUME_ATTEMPTS=3`
  (`state.ts:11`) is the watchdog cap; the user's `Retry failed after 3 attempts` is Pi's
  `retry.provider` exhausting. The watchdog keys only on `session_start` (`watchdog.ts:62`) so a
  429 turn-failure bypasses it entirely — the core gap.
- **The 429 carries no guaranteed reset clock** — API-style `rate_limit_error` has no
  `retry-after`; the claude.ai subscription surface DOES embed "resets HH:MM (TZ)". So: parse when
  present, poll otherwise.
- **State slot patterns** — `setActiveRun`/`getActiveRunId`/`isRunActive` (`state.ts:41-52`) and
  the resuming guard `markResuming`/`isResuming`/`clearResuming` (`state.ts:62-78`) are the
  templates for the new `autoMode` accessors. The watchdog's own `EPOCH_SLOT`
  (`watchdog.ts:38-47`) is the template for a module-private timer slot.
- **Resume re-entry** — `pi.sendUserMessage("/wfex resume @<runId>")` (`watchdog.ts:103`) is the
  re-entry seam; the resuming guard must wrap it (the loop reuses the same command path).
- **Timer discipline** — Pi timers are plain Node globals but MUST start from an event, never the
  factory, and be cleaned up (`extensions.md:219-223`); `unref()` them.
- **after_provider_response shape** — `event.status` (HTTP code), `event.headers["retry-after"]`;
  header availability is provider-dependent (`extensions.md:649-660`). Fired before the stream
  body is consumed.

## Desired End State

```text
# Walk away overnight — auto-answer decisions, survive a 5-hour usage limit:
/wfex auto safe          → "rpiv-wfex: auto-mode set to safe (auto-answer decisions; safety stops still halt)."
# ... run proceeds; a 429 usage limit hits mid-stage ...
# ratelimit.ts notifies: "usage limit hit — retrying @<runId> until the window resets (cap 8h)."
# ... every 10 min (or at the parsed reset time) it re-sends /wfex resume; on success it clears and continues.

/wfex auto unattended    → also auto-answers safety stops EXCEPT a plan/working-tree mismatch.
/wfex auto off           → back to today's rote-confirmation-only behavior.
```

## What We're NOT Doing

- **No config-file persistence** — `autoMode` is in-memory only (lost on Pi process restart);
  enough for an overnight run in one process. Persisting to `~/.config/rpiv-pi/models.json` is a
  deferred follow-up.
- **No stage-idempotency changes** — the bounded wall-clock guard limits blast radius but does NOT
  make `commit` (or other side-effect stages) safe to cold-re-run. Documented caveat only.
- **No removal of `MAX_RESUME_ATTEMPTS`** — the freeze-rescue watchdog's 3-strike cap stays; the
  rate-limit loop is a separate concern with its own wall-clock bound.
- **No override of the working-tree mismatch in unattended** — that one safety stop is the carve-out
  the developer chose to keep.
- **Not touching the watchdog's session_start path** — the 429 observer lives in its own file.

## Decisions

### D1: autoMode persistence — in-memory state slot
**Decision**: Add `autoMode` to the existing `globalThis` state slot (`state.ts:13-24`), no config
I/O. The watchdog auto-resume runs in-process, so in-memory covers "set full-auto, walk away."
Lost only on a Pi process restart (acceptable; config persistence is a deferred follow-up).

### D2: unattended safety carve-out — keep the working-tree-mismatch halt
**Decision**: `unattended` auto-picks everything EXCEPT a plan/working-tree mismatch
(`autonomy.ts:38-42`). Applying a plan against a dirty tree is the one irreversible blast radius;
the carve-out keeps maximum autonomy safe. `safe` keeps the entire EXEMPTION block as hard halts.

### D3: retry loop home — new sibling `ratelimit.ts`
**Decision**: A fourth registrar `registerRateLimitRetry()` in its own file, wired in
`extension.ts`. Research is explicit: "a rate limit and a freeze are different failure modes —
don't overload the existing session_start path." Matches the one-file-per-concern layout.

### D4: 429 handling — parse reset time when present, else poll; bounded wall-clock
**Decision**: `parseResetDelayMs` reads `retry-after` (seconds) and the subscription "resets
HH:MM (TZ)" string. When it yields a delay, schedule a `setTimeout` for that delay (capped); else
fall back to a self-rescheduling 10-min `setTimeout` poll. Clear on the next non-429 response. Bound
total retry wall-clock at `MAX_RETRY_WALL_MS` (~8h = one window + margin), then notify + stop. Tune
Pi's `retry.provider` for short blips (README note).

**Subscription-body wiring (Phase 5):** `after_provider_response` exposes status + headers only, not
the body — so the subscription "resets HH:MM (TZ)" string is wired separately via an `agent_end`
message scan that refines the armed retry to the precise reset; degrades to polling when absent.

### D5: refined safe heuristic — Recommended unless strictly-better-no-drawback, respect deferral
**Decision**: `safe` replaces the current "ALWAYS prefer more-complete" rule (`autonomy.ts:27-28`),
which would wrongly pick a deferred-scope option. New rule: default Recommended; override to a
more-complete option ONLY when strictly additive (no drawback) AND its extra scope is not deferred
to a later unit/stage. Log each auto-decision (which question, which option, why) per the `258b8d7`
scope-creep lesson.

## Phase 1: State foundation — autoMode tri-state

### Overview
Add the `autoMode` tri-state to `WfexState` and its accessors. Foundation — no dependencies;
Phases 2, 3, 4 all read it.

### Changes Required:

#### 1. state.ts
**File**: state.ts
**Changes**: MODIFY — add `AutoMode` type, `autoMode` field on `WfexState`, and
`setAutoMode`/`getAutoMode` accessors beside the active-run siblings.

```ts
// --- add the AutoMode type above the WfexState interface (state.ts:13) ---

/**
 * Full-auto autonomy tier: off = today's rote-confirmation-only behavior;
 * safe = auto-answer PAUSE-list decisions (genuine safety stops still halt);
 * unattended = auto-answer all but the plan/working-tree mismatch.
 */
export type AutoMode = "off" | "safe" | "unattended";

// --- add this field to the WfexState interface, beside resumeAttempts ---

	/** Full-auto tier read by the autonomy directive each turn; "off" when unset. */
	autoMode?: AutoMode;

// --- add these accessors beside the active-run setters/getters ---

export function setAutoMode(mode: AutoMode): void {
	getState().autoMode = mode;
}

/** Current full-auto tier; "off" when unset (today's behavior). */
export function getAutoMode(): AutoMode {
	return getState().autoMode ?? "off";
}

// --- Q3 fix: reset autoMode to "off" on run-end so the tier never silently
//     persists into a later unrelated run in the same process. Add to clearActiveRun: ---
//
// export function clearActiveRun(): void {
// 	const s = getState();
// 	s.activeRunId = undefined;
// 	s.resumingRunId = undefined;
// 	s.autoMode = undefined;   // ← Q3: reset to "off" (getAutoMode returns "off" when undefined)
// }
```

### Success Criteria:

#### Automated Verification:
- [x] Accessors + type exported: `grep -cE "export function getAutoMode|export function setAutoMode|export type AutoMode" state.ts` returns 3
- [x] Module still loads under jiti: `npx jiti _loadcheck.ts` prints `off` and `ok`
- [x] Q3 — autoMode reset on run-end: `grep -q 's\.autoMode = undefined' state.ts` (in `clearActiveRun`)

#### Manual Verification:
- [ ] `getAutoMode()` returns `"off"` before any `setAutoMode` call (today's behavior preserved)
- [ ] After `setAutoMode('safe')` then `clearActiveRun()`, `getAutoMode()` returns `"off"` (Q3: tier reset per run)

## Phase 2: Autonomy directive branching

### Overview
Branch `AUTONOMY_DIRECTIVE` into three variants selected by `getAutoMode()`. Depends on Phase 1;
can run in parallel with Phase 3.

### Changes Required:

#### 1. autonomy.ts
**File**: autonomy.ts
**Changes**: MODIFY — split the directive into `off`/`safe`/`unattended` variants and select by
`getAutoMode()` in the `before_agent_start` handler. The existing `AUTONOMY_DIRECTIVE` export stays
verbatim as the `off` baseline (back-compat).

```ts
// --- import: add getAutoMode + AutoMode alongside isRunActive ---
import { getAutoMode, isRunActive, type AutoMode } from "./state.js";

// --- AUTONOMY_DIRECTIVE stays EXACTLY as today (the off baseline) ---
//     export const AUTONOMY_DIRECTIVE = [ ... ].join("\n");   // unchanged

// --- add shared heuristic + two variants below AUTONOMY_DIRECTIVE ---

/** Shared decision policy for safe + unattended: Recommended unless strictly-better-no-drawback, respect deferral. */
const DECISION_HEURISTIC = [
	"Decision heuristic:",
	"- Default to the option marked Recommended.",
	"- Override to a more-complete option ONLY when it is strictly additive (more features, NO",
	"  drawback) AND its extra scope is NOT deferred to a later unit/stage. If the extra scope",
	"  belongs to a later unit/stage, pick Recommended instead — do not pull deferred work forward.",
	"- If no option is marked Recommended, pick the one that does the most work without deferring scope.",
	"For each auto-decision, log ONE line: the question, the option picked, and the one-line reason.",
].join("\n");

/** #1 safe-auto: auto-answer rote + substantive decisions; genuine safety stops STILL halt. */
export const SAFE_AUTO_DIRECTIVE = [
	"## rpiv-wfex autonomy mode — SAFE AUTO (active workflow run)",
	"",
	"A multi-stage workflow run is in progress in SAFE-AUTO mode: walk it to completion without human",
	"babysitting, auto-answering decisions too — but genuine safety stops still halt.",
	"",
	"Auto-answer BOTH rote confirmations (confirm slice / approve work / approve commit / proceed? /",
	"ready to proceed / continue?) AND substantive decisions (triage apply-vs-dismiss-vs-defer;",
	"choosing an approach, architecture, or decomposition; resolving an ambiguous requirement). Do",
	"NOT wait.",
	"",
	DECISION_HEURISTIC,
	"",
	"EXEMPTION — genuine safety stops STILL always halt and ask (never auto-proceed), even in safe-auto:",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop).",
	'- Any step explicitly labelled a safety "Stop" / "do not proceed" for data-loss, destructive, or',
	"  irreversible reasons.",
].join("\n");

/** #2 unattended-auto: auto-answer EVERYTHING except the plan/working-tree mismatch (D2 carve-out). */
export const UNATTENDED_AUTO_DIRECTIVE = [
	"## rpiv-wfex autonomy mode — UNATTENDED AUTO (active workflow run)",
	"",
	"A multi-stage workflow run is in progress in UNATTENDED-AUTO mode: maximum autonomy. Auto-answer",
	"EVERYTHING — rote confirmations, substantive decisions, AND safety stops — using the heuristic",
	"below. Do NOT wait for a human.",
	"",
	DECISION_HEURISTIC,
	"",
	"CARVE-OUT — exactly ONE stop still halts and asks (never auto-proceed), even unattended:",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop):",
	"  applying a plan against a dirty/unexpected tree is irreversible. HALT and ask on this one.",
	'All other steps — including destructive/irreversible "Stop" steps — auto-proceed in unattended mode.',
].join("\n");

/** Select the directive text for the current full-auto tier. */
function directiveFor(mode: AutoMode): string {
	if (mode === "safe") return SAFE_AUTO_DIRECTIVE;
	if (mode === "unattended") return UNATTENDED_AUTO_DIRECTIVE;
	return AUTONOMY_DIRECTIVE; // off — today's rote-confirmation-only behavior
}

// --- change the handler return to select by tier ---
export function registerAutonomy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (!isRunActive()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${directiveFor(getAutoMode())}` };
	});
}
```

### Success Criteria:

#### Automated Verification:
- [x] Both new directives exported: `grep -cE "export const SAFE_AUTO_DIRECTIVE|export const UNATTENDED_AUTO_DIRECTIVE" autonomy.ts` returns 2
- [x] Handler selects by tier: `grep -q "directiveFor(getAutoMode())" autonomy.ts`
- [x] Module loads under jiti (Phase 1 on disk): `npx jiti _loadcheck.ts` prints `off` and `ok`

#### Manual Verification:
- [x] With `autoMode` off, the injected directive is byte-identical to today's `AUTONOMY_DIRECTIVE`
- [x] `safe` keeps the full EXEMPTION block (plan/working-tree mismatch + destructive Stop both halt)
- [x] `unattended` halts ONLY on the plan/working-tree mismatch; destructive Stop steps auto-proceed

## Phase 3: /wfex auto command

### Overview
Add `/wfex auto <mode>` to the subcommand dispatch. Depends on Phase 1; can run in parallel with
Phase 2.

### Changes Required:

#### 1. commands.ts
**File**: commands.ts
**Changes**: MODIFY — add an `auto` branch to the dispatch switch (`commands.ts:154-173`) that
parses the mode token, calls `setAutoMode`, and notifies; extend the state import; update the
description + usage strings.

```ts
// --- import: add the autoMode accessors + type alongside clearResuming ---
import { clearResuming, getAutoMode, setAutoMode, type AutoMode } from "./state.js";

// --- add the auto-mode handler near the other *Cmd helpers ---

const AUTO_MODES = new Set<AutoMode>(["off", "safe", "unattended"]);

/** `/wfex auto [off|safe|unattended]` — show or set the full-auto tier (in-memory, D1). */
function autoCmd(ctx: WorkflowHostContext, mode: string): void {
	if (!mode) {
		ctx.ui.notify(`rpiv-wfex: auto-mode is '${getAutoMode()}'. Set with /wfex auto off|safe|unattended.`, "info");
		return;
	}
	if (!AUTO_MODES.has(mode as AutoMode)) {
		ctx.ui.notify(`rpiv-wfex: unknown auto-mode '${mode}' — use off | safe | unattended.`, "warning");
		return;
	}
	setAutoMode(mode as AutoMode);
	const blurb =
		mode === "safe"
			? "auto-answer decisions; genuine safety stops still halt"
			: mode === "unattended"
				? "auto-answer everything except a plan/working-tree mismatch"
				: "rote confirmations only (default)";
	ctx.ui.notify(`rpiv-wfex: auto-mode set to ${mode} — ${blurb}.`, "info");
}

// --- in registerWfexCommands: update description + add the `auto` branch + usage line ---
export function registerWfexCommands(pi: ExtensionAPI): void {
	pi.registerCommand("wfex", {
		description: "rpiv-wfex: resume | continue | auto | runs — autonomous workflow resume, skip-done-stage, full-auto toggle, + run lister",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "";
			if (sub === "runs") return listRunsCmd(ctx);
			if (sub === "continue") return continueDispatch(pi, ctx, (tokens[1] ?? "").replace(/^@/, "").trim());
			if (sub === "auto") return autoCmd(ctx, (tokens[1] ?? "").toLowerCase());
			// "/wfex resume @ref", "/wfex resume", "/wfex @ref", "/wfex" all resume.
			const refToken = sub.startsWith("@") ? sub : (tokens[1] ?? "");
			if (sub === "resume" || sub === "" || sub.startsWith("@")) {
				return resumeCmd(pi, ctx, refToken.replace(/^@/, "").trim());
			}
			ctx.ui.notify("rpiv-wfex: usage — /wfex resume [@<ref>] | /wfex continue [@<ref>] | /wfex auto [off|safe|unattended] | /wfex runs", "warning");
		},
	});
}
```

### Success Criteria:

#### Automated Verification:
- [x] Auto branch wired: `grep -q 'sub === "auto"' commands.ts`
- [x] Accessors imported: `grep -q "setAutoMode" commands.ts && grep -q "getAutoMode" commands.ts`
- [x] Module loads under jiti (Phase 1 on disk): `npx jiti _loadcheck.ts` prints `off` and `ok`

#### Manual Verification:
- [x] `/wfex auto` with no arg reports the current mode; `/wfex auto safe` sets it; `/wfex auto bogus` warns
- [x] `/wfex auto` does not disturb the resume / continue / runs branches

## Phase 4: Rate-limit retry loop

### Overview
New `ratelimit.ts` registrar: observe 429 via `after_provider_response`, parse a reset delay or
poll, re-send resume until the window clears, bounded by a wall-clock cap. Wire it in
`extension.ts`. Depends on Phase 1 (reads `getActiveRunId`, reuses the resuming guard).

**Revision (review I3, `ratelimit.ts:159-166`):** when the cap is hit, clear shared run state with
`clearActiveRun()` as well as the private retry slot, matching the watchdog give-up path. Otherwise
`activeRunId`/`autoMode` stay live and the autonomy/watchdog hooks can keep acting on an abandoned
run.

### Changes Required:

#### 1. ratelimit.ts
**File**: ratelimit.ts
**Changes**: NEW — `parseResetDelayMs` (pure), `registerRateLimitRetry` (the observer + scheduler
+ bounded cap + resuming-guard reuse).

```ts
/**
 * rpiv-wfex rate-limit retry — when a usage limit (HTTP 429) ends a turn, Pi's
 * provider auto-retry exhausts and the run dies in-chat; the session_start
 * watchdog never sees it (different failure mode). This observer keys on
 * after_provider_response status 429, then re-sends `/wfex resume @<runId>` on a
 * timer until a non-429 response clears it — bounded by a wall-clock cap so a
 * never-resetting limit can't loop forever. Separate file from watchdog.ts by
 * decision (D3): a rate limit and a freeze are different failure modes.
 *
 * Reset timing: parseResetDelayMs reads the `retry-after` header (the signal
 * available at this seam) and the claude.ai subscription "resets HH:MM (TZ)"
 * string. NOTE: after_provider_response exposes status + headers only, not the
 * body, so the subscription string is wired separately in Phase 5 via an
 * agent_end message scan; here it falls back to 10-min polling.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearActiveRun, clearResuming, getActiveRunId, isResuming, markResuming } from "./state.js";

/** Poll cadence when no precise reset time is known. Also debounces against Pi's own provider auto-retry (seconds-scale), which clears us via a non-429 response before this first tick. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// Q5 fix: HTTP-date retry-after parsing — add as a third branch in parseResetDelayMs
// after /^\d+$/ and before the `resets …` regex:
//
// const d = new Date(s); // e.g. "Mon, 29 Jun 2026 18:00:00 GMT"
// if (!Number.isNaN(d.getTime())) {
//   const delta = d.getTime() - now.getTime();
//   return delta > 0 ? delta : undefined;
// }
/** Total retry budget from the first 429 — one usage window + margin. ponytail: bump if your reset window is longer than ~6h. */
const MAX_RETRY_WALL_MS = 8 * 60 * 60 * 1000;

/** Minimal ctx shape this observer reads. */
type RetryCtx = { ui: { notify(m: string, l?: "info" | "warning" | "error"): void } };

/** Module-private retry state in its own global slot (survives session replacement, like watchdog's EPOCH_SLOT). */
const RETRY_SLOT = Symbol.for("@flex/rpiv-wfex:ratelimit");
interface RetryState {
	timer?: ReturnType<typeof setTimeout>;
	deadlineMs?: number;
	/** The run this retry window is armed for — scopes the non-429 clear (a stray unrelated 200 must not cancel it). */
	runId?: string;
}
function retryState(): RetryState {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[RETRY_SLOT] as RetryState | undefined;
	if (!s) {
		s = {};
		g[RETRY_SLOT] = s;
	}
	return s;
}

function isRetryArmed(): boolean {
	return retryState().timer !== undefined;
}

function clearRetry(): void {
	const s = retryState();
	if (s.timer) clearTimeout(s.timer);
	s.timer = undefined;
	s.deadlineMs = undefined;
	s.runId = undefined;
}

/** notify on a possibly-stale ctx (timer fires up to 10 min later, after session replacement) — best-effort. */
function safeNotify(ctx: RetryCtx, msg: string, level?: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(msg, level);
	} catch {
		/* stale ctx after session replacement — notify is cosmetic, the resume goes through `pi` */
	}
}

function firstHeader(headers: Record<string, string | string[] | undefined> | undefined, key: string): string | undefined {
	const v = headers?.[key];
	return Array.isArray(v) ? v[0] : v;
}

/** Current wall-clock parts in an IANA time zone, or undefined for an invalid zone. */
function partsInTz(tz: string, now: Date): { h: number; m: number; s: number } | undefined {
	try {
		const fmt = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
		const h = Number(p.hour) % 24; // "24:00" → 0
		const m = Number(p.minute);
		const s = Number(p.second);
		if ([h, m, s].some(Number.isNaN)) return undefined;
		return { h, m, s };
	} catch {
		return undefined; // invalid IANA zone
	}
}

/**
 * Milliseconds to wait from `now` given a reset signal, or undefined when none
 * is parseable (caller falls back to polling). Handles THREE shapes:
 *  - a bare `retry-after` seconds value ("600")
 *  - an HTTP-date `retry-after` value ("Mon, 29 Jun 2026 18:00:00 GMT") — Q5 fix
 *  - the subscription "… resets 7:30pm (Europe/Berlin)" string → next occurrence
 *    of that wall-clock time in that zone (regex matches the substring anywhere).
 * ponytail: DST near the boundary can be off by an hour; bounded by MAX_RETRY_WALL_MS, good enough.
 */
export function parseResetDelayMs(input: string | undefined, now: Date = new Date()): number | undefined {
	if (!input) return undefined;
	const s = input.trim();
	if (/^\d+$/.test(s)) {
		const secs = Number(s);
		return secs > 0 ? secs * 1000 : undefined;
	}
	const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(s);
	if (!m) return undefined;
	let hour = Number(m[1]);
	const min = m[2] ? Number(m[2]) : 0;
	const ampm = m[3]?.toLowerCase();
	const tz = m[4]!.trim();
	if (ampm === "pm" && hour < 12) hour += 12;
	if (ampm === "am" && hour === 12) hour = 0;
	if (hour > 23 || min > 59) return undefined;
	const cur = partsInTz(tz, now);
	if (!cur) return undefined;
	const targetSod = hour * 3600 + min * 60;
	const nowSod = cur.h * 3600 + cur.m * 60; // Q4 fix: drop cur.s (floor to minute) so an imminent reset (now within 60s of target) doesn't wrap to +24h
	let deltaSec = targetSod - nowSod;
	if (deltaSec <= 0) deltaSec += 24 * 3600; // already passed today → next day
	return deltaSec * 1000;
}

/** Schedule the next retry tick, honoring the wall-clock cap. */
function armRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string, delayMs: number): void {
	const s = retryState();
	if (s.deadlineMs === undefined) {
		s.deadlineMs = Date.now() + MAX_RETRY_WALL_MS;
		s.runId = runId; // pin the armed run for the non-429 clear scope
	}
	const remaining = s.deadlineMs - Date.now();
	if (remaining <= 0) {
		clearRetry();
		clearActiveRun(); // I3: same give-up semantics as watchdog; also resets autoMode to "off"
		safeNotify(
			ctx,
			`rpiv-wfex: usage-limit retries for @${runId} exceeded the ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h cap — stopping. Run \`/wfex resume @${runId}\` when the limit resets.`,
			"warning",
		);
		return;
	}
	const t = setTimeout(() => fireRetry(pi, ctx, runId), Math.min(delayMs, remaining));
	t.unref?.();
	s.timer = t;
}

/** One retry tick: re-send resume (guarded), then re-arm to poll in case it limits again. */
function fireRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string): void {
	retryState().timer = undefined; // this tick consumed
	if (getActiveRunId() !== runId) {
		clearRetry();
		return; // run ended or changed — nothing to retry
	}
	// I1 fix: bail (re-arm to poll) when isResuming is already set by another resumer —
	// force-clearing discards a watchdog-owned interlock and can drive a second concurrent
	// resume for the same run. If still set after a full poll interval, let the watchdog
	// (session_start path) own recovery rather than clobbering its marker.
	if (isResuming(runId)) {
		armRetry(pi, ctx, runId, POLL_INTERVAL_MS); // re-poll; don't force-clear
		return;
	}
	markResuming(runId); // suppress the session_start storm the resume's own spawns trigger (same guard the watchdog uses)
	safeNotify(ctx, `rpiv-wfex: retrying @${runId} after usage limit…`, "info");
	void Promise.resolve(pi.sendUserMessage(`/wfex resume @${runId}`)).catch((err) => {
		clearResuming(runId); // queue failed → resumeCmd's finally never runs; release the guard here
		safeNotify(ctx, `rpiv-wfex: could not queue resume for @${runId} — ${String(err)}`, "error");
	});
	armRetry(pi, ctx, runId, POLL_INTERVAL_MS); // keep polling; a non-429 response clears the loop
}

/**
 * Register the 429 retry-until-reset observer. Wires after_provider_response —
 * the timer is created INSIDE the handler (never the factory body) per Pi's timer
 * discipline (extensions.md:219-223) and unref()'d so it never holds the process.
 * Q6: also registers workflow_end to clear the retry slot on clean run-end,
 * rather than relying solely on the next fireRetry tick's runId guard.
 */
export function registerRateLimitRetry(pi: ExtensionAPI): void {
	// Q6 fix: clear the retry slot on clean workflow_end. Mirrors watchdog's lifecycle hook.
	pi.on("workflow_end", async () => {
		clearRetry();
	});

	pi.on("after_provider_response", async (event, ctx) => {
		const status = (event as { status?: number }).status;
		if (status !== 429) {
			// Limit lifted → stop retrying, but only if this response plausibly belongs to the
			// armed run (or no run is active). An unrelated 200 (manual chat) while a run is
			// rate-limit-armed must not cancel the retry window.
			if (isRetryArmed()) {
				const armed = retryState().runId;
				const active = getActiveRunId();
				if (!active || active === armed) clearRetry();
			}
			return;
		}
		const runId = getActiveRunId();
		if (!runId) return; // 429 outside an active run — nothing to resume
		if (isRetryArmed()) return; // single-loop invariant — already retrying this window
		const headers = (event as { headers?: Record<string, string | string[] | undefined> }).headers;
		const delay = parseResetDelayMs(firstHeader(headers, "retry-after")) ?? POLL_INTERVAL_MS;
		safeNotify(
			ctx as RetryCtx,
			`rpiv-wfex: usage limit (429) on @${runId} — retrying until it resets (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`,
			"warning",
		);
		armRetry(pi, ctx as RetryCtx, runId, delay);
	});
}
```

#### 2. extension.ts
**File**: extension.ts
**Changes**: MODIFY — import and register `registerRateLimitRetry` as the fourth registrar (after
the watchdog; commands stay first since the retry loop triggers `/wfex resume`).

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutonomy } from "./autonomy.js";
import { registerWfexCommands } from "./commands.js";
import { registerRateLimitRetry } from "./ratelimit.js";
import { registerWatchdog } from "./watchdog.js";

export default function (pi: ExtensionAPI): void {
	registerWfexCommands(pi); // /wfex resume + /wfex runs (registered first — watchdog + ratelimit trigger it)
	registerAutonomy(pi); // before_agent_start autonomy directive (active runs only)
	registerWatchdog(pi); // session_start orphan auto-resume + lifecycle run-tracking
	registerRateLimitRetry(pi); // after_provider_response 429 retry-until-reset loop
}
```

#### 3. package.json
**File**: package.json
**Changes**: MODIFY — add `ratelimit.ts` to the `files` array in the SAME phase that makes
`extension.ts` import it, so each phase leaves the published package self-consistent (review
finding, Step 8). The selfcheck stays dev-only (like `continue.selfcheck.ts`).

```json
	"files": ["extension.ts", "state.ts", "autonomy.ts", "commands.ts", "continue.ts", "watchdog.ts", "ratelimit.ts", "README.md"],
```

### Success Criteria:

#### Automated Verification:
- [x] Parser exported: `grep -q "export function parseResetDelayMs" ratelimit.ts`
- [x] Registrar wired in extension: `grep -q "registerRateLimitRetry(pi)" extension.ts`
- [x] No timer at module top level (only inside handlers): `grep -nE "^(const|let|var)?\\s*set(Timeout|Interval)" ratelimit.ts` returns nothing
- [x] `ratelimit.ts` shipped: `node -e "process.exit(require('./package.json').files.includes('ratelimit.ts')?0:1)"`
- [x] Module loads under jiti: `npx jiti _test_phase4.ts` prints `600000` and `3600000`
- [x] I1 — bail on isResuming: `grep -q 'armRetry(pi, ctx, runId, POLL_INTERVAL_MS)' ratelimit.ts` inside `fireRetry`; no `clearResuming` call before `markResuming` in that function
- [x] Q4 — minute floor: `grep -q 'cur\.s' ratelimit.ts` returns nothing in the `nowSod` line (seconds dropped)
- [x] Q5 — HTTP-date branch: `grep -q 'new Date(s)' ratelimit.ts`; `parseResetDelayMs('Mon, 29 Jun 2026 18:00:00 GMT', new Date('2026-06-29T17:00:00Z'))` returns 3600000 ✓
- [x] Q6 — workflow_end registered: `grep -q 'workflow_end' ratelimit.ts`
- [x] I3 — cap give-up clears shared state: `grep -q 'clearActiveRun' ratelimit.ts` and the `remaining <= 0` branch calls it after `clearRetry()`

#### Manual Verification:
- [ ] A 429 during an active run notifies and re-sends `/wfex resume` on a timer; a non-429 clears it
- [ ] Retries stop after the wall-clock cap with a notify AND `activeRunId`/`autoMode` are cleared (I3)
- [ ] `parseResetDelayMs("600")` → 600000 (subscription-string path is wired in Phase 5, tested in Phase 6)
- [ ] I1: when `isResuming` is already set on a tick, the tick re-arms to poll and returns WITHOUT sending a second resume
- [ ] Q6: a clean workflow_end cancels any armed retry timer immediately (no stale slot into next run)

## Phase 5: Subscription reset wiring — agent_end message scan

### Overview
Wire the subscription "resets HH:MM (TZ)" string (which lives in the response body, not exposed at
`after_provider_response`) by scanning finalized messages at `agent_end` and refining the armed
retry's wait to the precise reset. Purely additive over the polling baseline — degrades to polling
if no reset string is present. Depends on Phase 4 (refines its armed loop).

### Changes Required:

#### 1. ratelimit.ts
**File**: ratelimit.ts
**Changes**: MODIFY — add `messagesText` (tolerant text extractor) + `rescheduleRetry`, and an
`agent_end` handler inside `registerRateLimitRetry` that refines the armed timer from the message
text. Update the file's module-doc note (subscription string is now wired here, not just polled).

```ts
// --- update the module-doc NOTE line to reflect the wiring (was: "falls back to 10-min polling") ---
//  * body, so the subscription string is wired below via an agent_end message
//  * scan (refineFromMessages); absent a reset string, it falls back to polling.

// --- add these helpers below fireRetry ---

/** Flatten finalized messages to plain text — tolerant of string or content-part[] shapes. */
export function messagesText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const out: string[] = [];
	for (const msg of messages) {
		const c = (msg as { content?: unknown }).content;
		if (typeof c === "string") {
			out.push(c);
		} else if (Array.isArray(c)) {
			for (const part of c) {
				const t = (part as { text?: unknown }).text;
				if (typeof t === "string") out.push(t);
			}
		}
	}
	return out.join("\n");
}

/** Replace the armed timer's wait with `delayMs` (precise reset), preserving the wall-clock deadline. */
function rescheduleRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string, delayMs: number): void {
	const s = retryState();
	if (s.timer) clearTimeout(s.timer);
	s.timer = undefined; // keep deadlineMs so the cap still measures from the first 429
	armRetry(pi, ctx, runId, delayMs);
}

// --- add this SECOND handler INSIDE registerRateLimitRetry, after the existing
//     pi.on("after_provider_response", …) call (one registrar, two pi.on calls) ---
	pi.on("agent_end", async (event, ctx) => {
		if (!isRetryArmed()) return; // only refine an already-armed retry
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
- [x] Extractor exported: `grep -q "export function messagesText" ratelimit.ts`
- [x] agent_end handler added: `grep -q 'pi.on("agent_end"' ratelimit.ts`
- [x] Exactly ONE registrar export: `grep -c "export function registerRateLimitRetry" ratelimit.ts` returns 1
- [x] Module loads under jiti: `npx jiti _loadcheck.ts` prints `off` and `ok`
<!-- Phase 5 verified complete 2026-06-29 -->

#### Manual Verification:
- [ ] An `agent_end` carrying "…resets 7:30pm (Europe/Berlin)…" while armed reschedules the retry to that time
- [ ] No reset string → loop keeps its 10-min polling cadence (no regression)

## Phase 6: Self-check + docs

### Overview
Assert-only self-check for the parser, message extraction, retry state machine, and cap cleanup;
README updates (commands table, caveats, `retry.provider` tuning note). Depends on Phases 4 + 5.

### Changes Required:

#### 1. ratelimit.selfcheck.ts
**File**: ratelimit.selfcheck.ts
**Changes**: MODIFY — keep the parser/message assertions, then replace the slot-only state-machine
block with a tiny fake-`pi.on` harness that invokes the real `after_provider_response` and
`agent_end` handlers. Monkeypatch `globalThis.setTimeout` only inside the selfcheck to capture the
scheduled callback/delay, then restore it in `finally`. Cover: single-loop guard,
deadline-from-first-429, run-scoped non-429 clear, `agent_end` reschedule, `fireRetry` sending one
`/wfex resume`, `isResuming` bail (no second send), and I3 cap give-up clearing `activeRunId` via
`clearActiveRun()`.

```ts
/**
 * rpiv-wfex ratelimit self-check — `npx jiti ratelimit.selfcheck.ts`.
 * Guards the parser (retry-after seconds + subscription "resets HH:MM (TZ)") and
 * the message-text extractor — the two pieces most likely to silently break and
 * leave the retry loop polling blindly. No framework — assert only (mirrors
 * continue.selfcheck.ts).
 */

import { strict as assert } from "node:assert";
import { messagesText, parseResetDelayMs } from "./ratelimit.js";

// --- parseResetDelayMs: retry-after seconds ---
assert.equal(parseResetDelayMs("600"), 600000, "retry-after seconds → ms");
assert.equal(parseResetDelayMs("0"), undefined, "zero retry-after → undefined");
assert.equal(parseResetDelayMs(undefined), undefined, "no input → undefined");
assert.equal(parseResetDelayMs("nothing parseable here"), undefined, "no reset string → undefined");

// --- parseResetDelayMs: subscription "resets HH:MM (TZ)" embedded in free text (UTC = no DST, exact) ---
const midnightUtc = new Date("2026-06-28T00:00:00Z");
assert.equal(parseResetDelayMs("resets 2:00 (UTC)", midnightUtc), 2 * 3600 * 1000, "02:00 UTC from 00:00 → 2h");
assert.equal(parseResetDelayMs("resets 23:00 (UTC)", midnightUtc), 23 * 3600 * 1000, "23:00 UTC from 00:00 → 23h");
assert.equal(parseResetDelayMs("resets 12:00am (UTC)", midnightUtc), 24 * 3600 * 1000, "midnight already-now wraps +24h");

// already-passed time wraps to next day
const eveningUtc = new Date("2026-06-28T20:00:00Z");
assert.equal(parseResetDelayMs("resets 7:30 (UTC)", eveningUtc), (11 * 3600 + 30 * 60) * 1000, "passed target wraps to next day");

// Q4 fix: imminent reset (current time is seconds before the minute boundary) must NOT wrap to +24h.
// With the floor fix (drop cur.s), nowSod is floor-to-minute, so a time 45s before 07:30 UTC
// maps to nowSod=07:29*60=26940; targetSod=07:30*60=26100... wait, 07:29*60=26940 > 07:30*60=26100?
// Corrected: 07:29*3600+... let me think in seconds-of-day. 07:29 = 7*3600+29*60 = 25200+1740=26940.
// 07:30 = 7*3600+30*60 = 25200+1800=27000. So delta = 27000-26940 = 60s. Positive → no wrap. Correct!
const imminentBase = new Date("2026-06-28T07:29:45Z"); // 15s before 07:30 minute boundary; floor makes it 07:29 → +60s
assert.ok((parseResetDelayMs("resets 7:30 (UTC)", imminentBase) ?? 0) < 120_000 && (parseResetDelayMs("resets 7:30 (UTC)", imminentBase) ?? 0) > 0,
	"imminent reset (15s away, floored to minute) returns a small positive delta, not +24h");

// Q5 fix: HTTP-date retry-after
const httpDateStr = "Mon, 29 Jun 2026 18:00:00 GMT";
const httpNow = new Date("2026-06-29T17:00:00Z"); // 1h before
assert.equal(parseResetDelayMs(httpDateStr, httpNow), 3600 * 1000, "HTTP-date retry-after → ms until that time");
assert.equal(parseResetDelayMs("Thu, 01 Jan 2026 00:00:00 GMT", new Date("2026-01-01T01:00:00Z")), undefined, "past HTTP-date → undefined");

// am/pm normalization
assert.equal(parseResetDelayMs("resets 7:30pm (UTC)", midnightUtc), (19 * 3600 + 30 * 60) * 1000, "7:30pm → 19:30");

// embedded in a realistic message + invalid zone guard
const realistic = "You've hit your session limit · resets 7:30pm (Europe/Berlin). Try again later.";
const d = parseResetDelayMs(realistic);
assert.ok(typeof d === "number" && d > 0 && d <= 24 * 3600 * 1000, "subscription reset → 0<delay<=24h");
assert.equal(parseResetDelayMs("resets 7:30pm (Not/AZone)", midnightUtc), undefined, "invalid IANA zone → undefined");

// --- messagesText: tolerant extraction ---
assert.equal(messagesText("not an array"), "", "non-array → empty");
assert.equal(messagesText([{ content: "hello" }, { content: "world" }]), "hello\nworld", "string content joined");
assert.equal(messagesText([{ content: [{ type: "text", text: "a" }, { text: "b" }] }]), "a\nb", "content-part[].text joined");
const fromMsg = messagesText([{ content: "limit · resets 7:30pm (Europe/Berlin)" }]);
assert.ok((parseResetDelayMs(fromMsg) ?? 0) > 0, "extracted text feeds the parser");

// --- Q8/I3: real handler state-machine harness ---
// Capture real handlers from registerRateLimitRetry(fakePi), monkeypatch setTimeout to capture
// scheduled callbacks/delays, and drive the callbacks directly. Keep this tiny; no framework.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRateLimitRetry } from "./ratelimit.js";
import { __resetWfexState, getActiveRunId, isResuming, markResuming, setActiveRun } from "./state.js";

{
	const handlers: Record<string, Function[]> = {};
	const sent: string[] = [];
	const notes: string[] = [];
	const fakePi = {
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		sendUserMessage: (msg: string) => { sent.push(msg); return Promise.resolve(); },
	} as unknown as ExtensionAPI;
	const fakeCtx = { ui: { notify: (m: string) => notes.push(m) } };

	const realSetTimeout = globalThis.setTimeout;
	const scheduled: { fn: Function; delay: number }[] = [];
	try {
		(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: Function, delay?: number) => {
			scheduled.push({ fn, delay: Number(delay) });
			return { unref: () => {} } as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;

		__resetWfexState();
		setActiveRun("run1");
		registerRateLimitRetry(fakePi);
		await handlers.after_provider_response![0]!({ status: 429, headers: { "retry-after": "600" } }, fakeCtx);
		assert.equal(scheduled.length, 1, "first 429 arms one timer");
		const firstDelay = scheduled[0]!.delay;
		await handlers.after_provider_response![0]!({ status: 429, headers: {} }, fakeCtx);
		assert.equal(scheduled.length, 1, "second 429 while armed does not arm another timer");
		assert.equal(scheduled[0]!.delay, firstDelay, "deadline/delay not bumped by second 429");

		await handlers.agent_end![0]!({ messages: [{ content: "limit resets 7:30pm (UTC)" }] }, fakeCtx);
		assert.equal(scheduled.length, 2, "agent_end reset string reschedules the armed retry");

		scheduled.at(-1)!.fn();
		assert.deepEqual(sent, ["/wfex resume @run1"], "fireRetry sends one resume");
		assert.equal(isResuming("run1"), true, "fireRetry marks resuming");
		const sendsAfterFirstFire = sent.length;
		scheduled.at(-1)!.fn();
		assert.equal(sent.length, sendsAfterFirstFire, "isResuming bail prevents a second send");

		// I3: cap give-up clears active run. Force an expired deadline in the private slot, then fire.
		const slot = Symbol.for("@flex/rpiv-wfex:ratelimit");
		(globalThis as Record<symbol, { timer?: unknown; deadlineMs?: number; runId?: string }>)[slot] = { deadlineMs: Date.now() - 1, runId: "run1" };
		markResuming("other"); // prove clearActiveRun clears shared state, not just retry slot
		scheduled.at(-1)!.fn();
		assert.equal(getActiveRunId(), undefined, "cap give-up clears activeRunId");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		__resetWfexState();
	}
}

console.log("ratelimit.selfcheck: OK");
```

#### 2. README.md
**File**: README.md
**Changes**: MODIFY — document `/wfex auto`, the retry-until-reset behavior, the `retry.provider`
tuning note, and the in-memory/idempotency caveats. Representative edits:

```md
## What it does (add items)

4. **Full-auto mode** — `/wfex auto safe|unattended|off` (default `off`) branches the autonomy
   directive. `safe` auto-answers the substantive decision prompts too (default Recommended;
   override to a more-complete option only when strictly additive and not deferred to a later
   stage) while genuine safety stops still halt. `unattended` auto-answers everything EXCEPT a
   plan/working-tree mismatch (still halts). In-memory only — reset on a Pi process restart.
5. **Usage-limit retry** — a `after_provider_response` observer catches a 429 usage limit and
   re-sends `/wfex resume` until the window resets (parsing a "resets HH:MM (TZ)" reset time when
   present, else polling ~every 10 min), bounded by a ~8h wall-clock cap then notify + stop.

## Commands (add rows)

| `/wfex auto` | Report the current full-auto tier. |
| `/wfex auto off\|safe\|unattended` | Set the full-auto tier (in-memory). |

## Usage-limit retry (new subsection)

On a 429, Pi's own provider auto-retry exhausts and the run would die in-chat; the sidecar's
watchdog never sees it (it keys on session disposal, a different failure mode). The retry loop
re-sends `/wfex resume @<runId>` until a non-429 response clears it. **Tune Pi's `retry.provider`**
(longer/more attempts) so short blips are absorbed by Pi and the loop only handles the hard
multi-hour wall.

## Caveats (add)

- **Auto-mode is in-memory.** Lost on a Pi process restart; set it again after `/reload`.
- **`unattended` still halts on a plan/working-tree mismatch** — the one irreversible carve-out.
- **Bounded retry ≠ idempotent stages.** The ~8h cap bounds blast radius but does not make a
  non-idempotent stage (esp. `commit`) safe to cold-re-run after a limit reset.
- **Precise reset wait depends on the "resets HH:MM" string** appearing in `agent_end` messages;
  the API-style 429 carries no reset clock, so that surface falls back to 10-min polling.
- **Full-auto auto-credits artifacts without confirmation.** When `auto` is `safe`/`unattended`, a
  resume of a failed/aborted stage with an on-disk artifact is credited (advanced past) WITHOUT the
  human check `/wfex continue` normally carries — but only when the artifact matches the stage and
  is newer than that failed/aborted row's timestamp. Stale or unmatched artifacts fall back to a
  cold re-run. This is the opt-in blast radius of full-auto; `off` keeps the cold re-run.
```

### Success Criteria:

#### Automated Verification:
- [x] Self-check passes (parser + real handler state-machine + I3/Q4/Q5/G1): `npx jiti ratelimit.selfcheck.ts` prints `ratelimit.selfcheck: OK`
- [x] README documents the toggle: `grep -q "/wfex auto" README.md`
- [x] Q8 — real handler harness added: `grep -q 'after_provider_response' ratelimit.selfcheck.ts && grep -q 'agent_end' ratelimit.selfcheck.ts`
- [x] I3 — cap cleanup asserted: `grep -q 'clearActiveRun' ratelimit.selfcheck.ts && grep -q 'getActiveRunId' ratelimit.selfcheck.ts`
- [x] Q4 selfcheck assertion present: `grep -q 'imminent reset' ratelimit.selfcheck.ts`
- [x] Q5 selfcheck assertion present: `grep -q 'HTTP-date' ratelimit.selfcheck.ts`

#### Manual Verification:
- [ ] README commands table and caveats read correctly
- [ ] `ratelimit.ts` is shipped in `package.json` files (added in Phase 4); `ratelimit.selfcheck.ts` is NOT

## Phase 7: Continue-preference for full-auto retry

### Overview
In full-auto (`autoMode !== "off"`), prefer crediting an on-disk artifact over a cold re-run of a
failed/aborted stage (precedent `35a3eca`) — non-interactively, since the user opted into full-auto.
Edits `resumeCmd` and `continue.ts`; the Phase 4 retry loop (which re-sends `/wfex resume`) routes
through here unchanged. Depends on Phase 3 (`getAutoMode`) and the existing `continue.ts` exports.
Added at Step 9 (applied review finding, precedents §3/§6).

**Revision (review I1/Q1):** The original credit used `findNewestArtifactMd(ctx.cwd)` with no
scoping — any `.md` anywhere under `.rpiv/artifacts` (including prior runs/stages) could be
credited. The first fix added a `stageName` filter, but review `2026-06-29_10-58-46` found that
stage-name-only scoping still credits stale artifacts from prior runs. Final fix: add a temporal
anchor too. `findNewestArtifactMd` accepts `newerThanMs`; `resumeCmd` passes `Date.parse(last.ts)`
and skips credit when the failed/aborted row has no parseable timestamp. No fresh stage-matching
artifact → cold re-run (safe degradation). Notify level stays `"warning"`; read/parse/append
fall-throughs also notify once for audit trail (Q5).

### Changes Required:

#### 1. continue.ts
**File**: continue.ts
**Changes**: MODIFY — extend `findNewestArtifactMd` at `continue.ts:84` with optional
`stageName` and `newerThanMs` parameters. When `newerThanMs` is provided, discard older/equal
candidates before stage matching. When `stageName` is provided, match by path segment (`stage` or
`stage + "s"`) or frontmatter `topic`/`stage`; no match returns `undefined` (caller cold-reruns).
The helper's no-argument path still returns the global newest artifact for legacy callers; Phase 8
then changes manual `continueCmd` to pass `last.stage` + a timestamp freshness guard too.

```ts
// --- updated signature ---
export function findNewestArtifactMd(cwd: string, stageName?: string, newerThanMs?: number): FoundArtifact | undefined {
	// ... existing walk unchanged: collect ALL markdown candidates, sorted newest first ...
	let pool = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (newerThanMs !== undefined) {
		pool = pool.filter((c) => c.mtimeMs > newerThanMs); // I1: stale prior-run artifacts cannot credit this failure
	}
	if (!stageName) return pool[0];

	const lower = stageName.toLowerCase();
	// Q2: path-segment boundary, not free substring. ponytail: +"s" covers plan→plans/design→designs;
	// irregular plurals (analysis→analyses) intentionally fall through to frontmatter or cold re-run.
	for (const c of pool) {
		const segments = c.rel.toLowerCase().split(/[\\/]/);
		if (segments.some((seg) => seg === lower || seg === lower + "s")) return c;
	}
	for (const c of pool) {
		try {
			const fm = parseFrontmatter(readFileSync(c.abs, "utf8"));
			const topic = String(fm.topic ?? fm.stage ?? "").toLowerCase();
			if (topic.includes(lower)) return c;
		} catch {
			// unreadable → skip
		}
	}
	return undefined;
}
```

> **Implementation note:** The temporal guard is deliberately conservative. If the failed row's
> timestamp is missing/unparseable or the artifact mtime is not newer than it, full-auto does not
> credit; it cold-reruns. False negatives are safer than silently advancing a stale prior-run
> artifact.

#### 2. commands.ts
**File**: commands.ts
**Changes**: MODIFY — extend imports (`readFileSync`, the `continue.ts` credit helpers); add a
small exported `shouldFullAutoCredit` predicate for Q8 selfchecks; update the credit block in
`resumeCmd` at `commands.ts:96-107` to pass both `last.stage` and `Date.parse(last.ts)` to
`findNewestArtifactMd`; raise all fall-through diagnostics to `"warning"` for audit trail.

```ts
// --- imports: add readFileSync + widen the continue.js import ---
import { readFileSync } from "node:fs";
import { buildCompletedRow, continueCmd, findNewestArtifactMd, parseFrontmatter } from "./continue.js";
//   (HEAD had: import { continueCmd } from "./continue.js"; — the state.js import from Phase 3 is untouched)

export function shouldFullAutoCredit(last: WorkflowStage | undefined, mode: AutoMode): last is WorkflowStage {
	return mode !== "off"
		&& !!last
		&& last.parent === undefined
		&& (last.status === "failed" || last.status === "aborted")
		&& Number.isFinite(Date.parse(last.ts));
}

// --- in resumeCmd, INSERT immediately before the existing
//     `const result = await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });` line ---

		const mode = getAutoMode();
		if (mode !== "off") {
			const last = rt.readLastStage(ctx.cwd, runId);
			if (shouldFullAutoCredit(last, mode)) {
				const failedAtMs = Date.parse(last.ts);
				const found = findNewestArtifactMd(ctx.cwd, last.stage, failedAtMs); // I1: stage + temporal guard
				if (found) {
					try {
						const data = parseFrontmatter(readFileSync(found.abs, "utf8"));
						if (rt.appendStage(ctx.cwd, runId, buildCompletedRow(last, found.rel, data, runId))) {
							ctx.ui.notify(`rpiv-wfex: full-auto credited '${last.stage}' with ${found.rel} (fresh stage artifact; no cold re-run).`, "warning");
							return;
						}
						ctx.ui.notify(`rpiv-wfex: full-auto could not write credit row for '${last.stage}' — cold re-run.`, "warning");
					} catch (e) {
						ctx.ui.notify(`rpiv-wfex: full-auto could not credit '${last.stage}' (${errMsg(e)}) — cold re-run.`, "warning");
					}
				}
				// else: no fresh stage-matched artifact → fall through to plain cold re-run
			}
		}
```

#### 3. continue.selfcheck.ts
**File**: continue.selfcheck.ts
**Changes**: MODIFY — extend the existing assert-only check to import `findNewestArtifactMd` and
`shouldFullAutoCredit`. Use `mkdtempSync` under `tmpdir()` and write a minimal `.rpiv/artifacts`
tree. Cover the Q8/I1 cases: path-segment match, irregular-plural miss (`analysis` must not match
`analyses` unless frontmatter says so), frontmatter fallback, no-match → `undefined`,
`newerThanMs` rejects stale artifacts, and `shouldFullAutoCredit` only accepts full-auto + top-level
`failed`/`aborted` rows with parseable `ts`.

### Success Criteria:

#### Automated Verification:
- [x] Credit-prefer gated on full-auto via predicate: `grep -q 'shouldFullAutoCredit' commands.ts && grep -q 'mode !== "off"' commands.ts`
- [x] Stage + temporal guard passed: `grep -q 'findNewestArtifactMd(ctx.cwd, last.stage, failedAtMs)' commands.ts && grep -q 'Date.parse(last.ts)' commands.ts`
- [x] Artifact finder accepts temporal guard: `grep -q 'newerThanMs' continue.ts && grep -q 'mtimeMs > newerThanMs' continue.ts`
- [x] I1/Q8 artifact scope assertions present: `grep -q 'newerThanMs' continue.selfcheck.ts && grep -q 'findNewestArtifactMd' continue.selfcheck.ts && grep -q 'shouldFullAutoCredit' continue.selfcheck.ts`
- [x] Notify at warning for credit and fall-through: `grep -q 'full-auto credited' commands.ts && grep -q 'could not credit' commands.ts && grep -q '"warning"' commands.ts`
- [x] Q2 — path-segment boundary in continue.ts: `grep -q 'split' continue.ts` (seg === lower || seg === lower + 's'); NOT a bare `.includes` on the full path
- [x] Q1 — guarded readFileSync in commands.ts: `grep -A5 'readFileSync(found.abs' commands.ts | grep -q 'catch'`
- [x] Reuses continue helpers (no reimplementation): `grep -q "buildCompletedRow" commands.ts && grep -q "findNewestArtifactMd" commands.ts`
- [x] Module loads under jiti (Phases 1+3 on disk): `npx jiti continue.selfcheck.ts` passes with the new Q8/I1 assertions
- [x] continue.ts still loads: `npx jiti continue.selfcheck.ts` prints `continue.selfcheck: OK`

#### Manual Verification:
- [ ] In full-auto, resuming a failed/aborted stage with a fresh stage-matching artifact credits it (warning) and advances
- [ ] In full-auto, a stale prior-run artifact (mtime <= failed row `ts`) is NOT credited; plain cold resume runs (I1)
- [ ] In full-auto, a locked/deleted artifact → warning then cold re-run (no abort) (Q1/Q5)
- [ ] Stage name "plan" does NOT match a path segment "redesign" or "by-design" (Q2)
- [ ] In full-auto, no fresh stage-matching artifact → falls through to cold re-run (no credit, no crash)
- [ ] `off` mode is unchanged (plain resume); completed / loop-trailer → falls through to plain resume
- [ ] The no-stageName helper path is unchanged for callers that intentionally want the global newest artifact

## Phase 8: Manual continue hardening + metadata refresh

### Overview
Apply review `.rpiv/artifacts/reviews/2026-06-29_12-12-36_commit-head-wfex-continue.md` to the
manual `/wfex continue` path. The interactive command must credit only a fresh artifact for the
interrupted root stage, the no-ref picker must not auto-pick mid-loop runs that `continueCmd`
refuses, artifact scanning should skip disappearing files, and package/docs metadata should stop
omitting `/wfex continue`.

### Changes Required:

#### 1. continue.ts
**File**: continue.ts
**Changes**: MODIFY — harden artifact scanning; add a reusable predicate for rows that can be
credited; pass `last.stage` + `Date.parse(last.ts)` into `findNewestArtifactMd` from `continueCmd`;
fall back to cold resume when no fresh stage artifact exists.

```ts
// --- inside findNewestArtifactMd walk(): wrap statSync per candidate (review Q3) ---
} else if (e.isFile() && e.name.endsWith(".md")) {
	try {
		const mtimeMs = statSync(p).mtimeMs;
		candidates.push({ abs: p, rel: relative(cwd, p).split(sep).join("/"), mtimeMs });
	} catch {
		// file disappeared / became unreadable between readdirSync and statSync — skip it
	}
}

// --- add near buildCompletedRow or before continueCmd ---
export function shouldOfferContinue(last: WorkflowStage | undefined): last is WorkflowStage {
	return !!last
		&& last.parent === undefined
		&& (last.status === "failed" || last.status === "aborted")
		&& Number.isFinite(Date.parse(last.ts));
}

// --- in continueCmd: after the completed-row fast path, before artifact selection ---
if (!shouldOfferContinue(last)) {
	ctx.ui.notify(`rpiv-wfex: @${runId} last stage '${last.stage}' is not a root failed/aborted row with a parseable timestamp — cold re-running it.`, "warning");
	await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
	return;
}

const stoppedAtMs = Date.parse(last.ts);
const found = findNewestArtifactMd(ctx.cwd, last.stage, stoppedAtMs); // I1: manual continue gets stage + freshness too
if (!found) {
	ctx.ui.notify(`rpiv-wfex: no fresh artifact for interrupted stage '${last.stage}' newer than ${last.ts} — cold re-running it.`, "warning");
	await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
	return;
}
```

Also update the select prompt from "Newest artifact" to "Fresh stage artifact" so the human is not
promised a global newest markdown file.

#### 2. commands.ts
**File**: commands.ts
**Changes**: MODIFY — split the picker used by bare `/wfex continue` from the broader resume picker
(review Q2). Reuse `shouldOfferContinue` for both the no-ref picker and `shouldFullAutoCredit`.

```ts
// --- import from continue.js ---
import { buildCompletedRow, continueCmd, findNewestArtifactMd, parseFrontmatter, shouldOfferContinue } from "./continue.js";

export function shouldFullAutoCredit(last: WorkflowStage | undefined, mode: AutoMode): last is WorkflowStage {
	return mode !== "off" && shouldOfferContinue(last);
}

/** Newest root failed/aborted run that manual continue can actually advance. */
function pickNewestContinuable(rt: WfRuntime, cwd: string): RunSummary | undefined {
	return [...rt.listRuns(cwd)]
		.sort((a, b) => b.ts.localeCompare(a.ts))
		.find((r) => shouldOfferContinue(rt.readLastStage(cwd, r.runId)));
}

// --- in continueDispatch no-ref path ---
const pick = pickNewestContinuable(rt, ctx.cwd);
```

`pickNewestResumable` stays unchanged for `/wfex resume`; mid-loop rows remain resume-worthy, just
not continue-worthy.

#### 3. continue.selfcheck.ts
**File**: continue.selfcheck.ts
**Changes**: MODIFY — import `shouldOfferContinue`; assert the shared predicate accepts only root
`failed`/`aborted` rows with parseable timestamps and rejects completed, mid-loop, skipped, and bad
`ts` rows. Keep the existing stage-segment/frontmatter/freshness artifact assertions.

#### 4. README.md + package.json
**Files**: README.md, package.json
**Changes**: MODIFY — refresh user-facing metadata/docs.

- `package.json` description mentions `/wfex continue` (or stops enumerating commands entirely).
- README `resume vs. continue` says `/wfex continue` credits a **fresh artifact matching the
  interrupted stage**, not the global newest markdown file.
- README caveat for full-auto credit says it uses the same stage + freshness boundary; stale or
  unmatched artifacts cold-rerun.

### Success Criteria:

#### Automated Verification:
- [x] I1 — manual continue passes stage + temporal guard: `grep -q 'findNewestArtifactMd(ctx.cwd, last.stage, stoppedAtMs)' continue.ts && grep -q 'Date.parse(last.ts)' continue.ts`
- [x] Q2 — bare continue has its own picker: `grep -q 'function pickNewestContinuable' commands.ts && grep -A20 'continueDispatch' commands.ts | grep -q 'pickNewestContinuable'`
- [x] Q2 — continue predicate excludes mid-loop rows: `grep -q 'export function shouldOfferContinue' continue.ts && grep -q 'last.parent === undefined' continue.ts`
- [x] Q3 — disappearing artifact files are skipped: `grep -A8 'statSync(p)' continue.ts | grep -q 'catch'`
- [x] Selfcheck covers the predicate and still passes: `grep -q 'shouldOfferContinue' continue.selfcheck.ts && npx jiti continue.selfcheck.ts` prints `continue.selfcheck: OK`
- [x] Q4 — package metadata mentions continue or avoids stale command enumeration: `node -e "const d=require('./package.json').description; process.exit(/continue/.test(d)||!/resume/.test(d)?0:1)"`
- [x] README no longer promises global-newest credit for continue/full-auto: `grep -q 'fresh artifact' README.md && ! grep -q 'credits the newest artifact under' README.md`

#### Manual Verification:
- [ ] Bare `/wfex continue` selects the newest root `failed`/`aborted` run it can advance, not a newer mid-loop run
- [ ] Explicit `/wfex continue @<run>` with a fresh stage-matching artifact prompts to credit that artifact and advances
- [ ] Explicit `/wfex continue @<run>` with only stale or unrelated artifacts warns and cold-reruns the interrupted stage
- [ ] A disappearing artifact during scan is skipped without throwing
- [ ] `/wfex resume` still treats mid-loop rows as resumable

## Ordering Constraints

- Phase 1 (state) is the foundation — must land before Phases 2, 3, 4.
- Phases 2 and 3 are independent of each other (both only read `getAutoMode`) — can run in parallel.
- Phase 4 depends on Phase 1 only; independent of Phases 2/3 — can run in parallel with them.
- Phase 5 (subscription reset wiring) depends on Phase 4 (refines its armed loop) — same file.
- Phase 6 depends on Phases 4 + 5 (selfcheck imports `ratelimit.ts`; README documents the loop).
- Phase 7 depends on Phase 3 (`getAutoMode`) + `continue.ts` exports; independent of Phases 4-6 —
  can run in parallel with them (touches `resumeCmd`, `continue.ts`, and `continue.selfcheck.ts`).
- Phase 8 depends on Phase 7's `continue.ts` artifact helper/freshness guard and should run after
  Phase 7 when implementing the review follow-up.

## Verification Notes

- **Timer leak guard** — confirm no timer is started from a registrar factory body; all timers
  start inside the `after_provider_response` handler and are `unref()`'d. Grep: timers must be
  created inside `pi.on(...)` callbacks, not at module/registrar top level.
- **Single-loop invariant** — only one retry timer at a time per process; a second 429 while armed
  must not reset the deadline or create another timer.
- **Resuming-guard reuse** — the loop's `sendUserMessage` re-enters the resume command path, which
  sets/clears `markResuming`/`clearResuming`; verify the loop does not wedge the guard across the
  long sleep (mirror `commands.ts:111` finally release; `watchdog.ts:107` queue-failure release).
- **activeRunId lifecycle** — the loop captures `runId` at 429 time, clears retry state on clean
  `workflow_end`, and clears shared active state on wall-clock cap give-up (I3).
- **Schema coupling untouched** — this plan does not alter `buildCompletedRow`; `continue.selfcheck.ts`
  must still pass (`npx jiti continue.selfcheck.ts`).
- **Directive scope creep** (`258b8d7` lesson) — `safe` must be narrow, logged, reversible to `off`;
  the safety EXEMPTION must remain a hard halt under `safe`.

## Performance Considerations

- The 10-min `setInterval` / single `setTimeout` is negligible load; `unref()` keeps it from
  holding the process open.
- No hot-path impact: `getAutoMode()` is a Map-free field read every turn in `before_agent_start`,
  same cost as the existing `isRunActive()` check.

## Migration Notes

Not applicable — additive in-memory state and a new registrar. No persisted schema, no data
migration, no rollback concern. Removing the feature = revert the files; no on-disk state to clean.

## Pattern References

- `state.ts:41-60` — active-run accessor pattern (template for `setAutoMode`/`getAutoMode`).
- `state.ts:62-78` — resuming-guard accessors (the loop reuses these verbatim).
- `watchdog.ts:38-47` — `EPOCH_SLOT` module-private global slot (template for the timer slot).
- `watchdog.ts:60-75` — `registerWatchdog` registrar shape (template for `registerRateLimitRetry`).
- `watchdog.ts:92-107` — resume re-entry via `sendUserMessage` + guard release on queue failure.
- `commands.ts:154-173` — `/wfex` dispatch switch (template for the `auto` subcommand).
- `continue.selfcheck.ts` — assert-only selfcheck pattern (template for `ratelimit.selfcheck.ts`).
- `extensions.md:649-660` — `after_provider_response` event shape.

## Developer Context

**Q (Open Q1, state.ts:25-37): should `autoMode` survive a Pi process restart?**
A: In-memory only — the state slot. Config persistence deferred. (D1)

**Q (Open Q4, autonomy.ts:38-42): how should `unattended` treat the plan/working-tree mismatch?**
A: Keep the working-tree carve-out — unattended halts on that one mismatch, auto-picks all else. (D2)

**Q (architecture insight, watchdog.ts:62): where should the 429 retry loop live?**
A: New sibling `ratelimit.ts` (4th registrar) — keep freeze-rescue and rate-limit apart. (D3)

**Q (Open Q2): build the subscription "resets HH:MM (TZ)" parser now or defer?**
A: Build now — parse reset time when present, poll otherwise; bounded wall-clock cap. (D4)

**Inherited from research Developer Context (fixed, not re-asked):** detection = BOTH (tune
`retry.provider` + add the 429 loop); full-auto = tri-state, default off; runaway guard = bounded
wall-clock.

## Plan History

- Phase 1: State foundation — approved as generated
- Phase 2: Autonomy directive branching — approved as generated
- Phase 3: /wfex auto command — approved as generated
- Phase 4: Rate-limit retry loop — approved as generated
- Phase 5: Subscription reset wiring — approved as generated (added after Phase 4 review: wire subscription "resets HH:MM" via agent_end scan)
- Phase 6: Self-check + docs — approved as generated
- Phase 7: Continue-preference for full-auto retry — approved as generated (added at Step 9: applied review findings §3/§6)
- Phase 6 + 7 revised (post-implementation review findings I1/Q1/Q2): stage-filter added to `findNewestArtifactMd`; Phase 7 now edits `continue.ts` + `commands.ts`; Phase 6 selfcheck extended with state-machine assertions
- Phases 1, 4, 6, 7 revised (code-review 2026-06-29_09-58-31): Q3 autoMode reset in clearActiveRun (Phase 1); I1 bail-on-isResuming + Q4 floor-nowSod + Q5 HTTP-date + Q6 workflow_end (Phase 4); Q4/Q5/G1 selfcheck assertions (Phase 6); Q1 try/catch readFileSync + Q2 path-segment boundary (Phase 7)
- Phases 4, 6, 7 revised (code-review 2026-06-29_10-58-46): I3 clearActiveRun on ratelimit cap give-up (Phase 4); Q8 real ratelimit handler selfcheck (Phase 6); I1 temporal artifact guard + Q5 warning fall-through + Q8 artifact/credit selfchecks (Phase 7)
- Phase 8 added (code-review 2026-06-29_12-12-36): manual `/wfex continue` now gets the same stage + temporal artifact boundary, a continue-specific no-ref picker, statSync hardening, and metadata/docs refresh.

## Follow-up — 2026-06-29T11:39:50+0300

Applied review `.rpiv/artifacts/reviews/2026-06-29_10-58-46_modified-full-auto-toggle-ratelimit-retry.md` to the plan:
- I1: full-auto artifact credit is now stage-scoped AND temporally anchored (`mtimeMs > Date.parse(last.ts)`), else cold re-run.
- I3: ratelimit cap give-up clears shared active-run state (`clearActiveRun()`), not just the private retry slot.
- Q8/Q5/Q6/Q9: selfchecks cover the risky paths in the phases that own them; fall-throughs notify; irregular plural limitation is documented/tested; commands snippet is re-indented.

## Follow-up — 2026-06-29T12:57:54+0300

Applied review `.rpiv/artifacts/reviews/2026-06-29_12-12-36_commit-head-wfex-continue.md` to the plan:
- I1: manual `/wfex continue` must use `last.stage` + `Date.parse(last.ts)` when selecting an artifact; no fresh stage match cold-reruns.
- Q2: bare `/wfex continue` gets a root-failed/aborted-only picker instead of reusing the broader resume picker.
- Q3/Q4: per-file artifact stat failures are skipped, and README/package metadata are refreshed.

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source   | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| -------- | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| code     | Phase 4 §1 (ratelimit.ts) `fireRetry` | watchdog.ts:62 | concern | code-quality | If the re-sent resume turn itself freezes (`waitForIdle` hang), `clearResuming` never runs; every later `fireRetry` tick sees `isResuming` and only re-polls without re-sending, AND `session_start` watchdog rescue is suppressed — both loops wedge until the 8h cap. | Have `fireRetry` clear the resuming guard for `runId` before the next re-send (or time-box it) so a frozen resume can't stall both loops. | superseded by later review: do NOT force-clear another subsystem's guard; re-arm to poll when `isResuming` is set, and let the cap/give-up cleanup stop the run. |
| code     | Phase 4 §1 (ratelimit.ts) handler | <n/a> | concern | code-quality | `clearRetry()` fires on ANY non-429 status with no run-scoping, so an unrelated 200 (e.g. manual chat) while armed cancels the retry loop prematurely. | Gate `clearRetry()` on the response belonging to the armed run (`getActiveRunId() === armedRunId`). | applied: store `runId` on RetryState at arm; clear only when no active run or it matches the armed run |
| coverage | ## Precedents & Lessons §3 | commands.ts resumeCmd (Phase 7) | concern | verification-coverage | Precedent `35a3eca`: the limit-reset loop "should prefer `continue` semantics where an artifact exists, plain `resume` otherwise" — the loop unconditionally sends `/wfex resume`. | Add a continue-preference branch, or a Manual criterion exercising it. | applied: new Phase 7 — `resumeCmd` prefers continue-credit (non-interactive) for a failed/aborted stage with an on-disk artifact when `getAutoMode() !== "off"`, else plain resume. Reuses continue.ts helpers. |
| coverage | ## Precedents & Lessons §6 | commands.ts resumeCmd (Phase 7) | concern | verification-coverage | Composite lesson "reuse partial artifacts via `continue` where present" — no criterion exercises artifact reuse; loop only re-sends `resume`. | Implement the continue-credit path or assert continue-preference. | applied: same Phase 7 credit-prefer block; Phase 7 Manual criterion exercises artifact reuse vs cold re-run. |
| code     | Phase 6 §3 (package.json) | package.json:11 | suggestion | actionability | `ratelimit.ts` is added to `files` only in Phase 6, but Phase 4 makes `extension.ts` import `./ratelimit.js` — a publish between Phase 4 and Phase 6 ships an import of an unshipped file. | Move the `files` insertion into Phase 4 alongside the `extension.ts` edit so each phase is self-consistent. | applied: package.json `files` edit moved to Phase 4 |
| working-tree | Phase 7 + continue.ts | commands.ts:99 | concern | correctness | I1/Q1: `findNewestArtifactMd(ctx.cwd)` with no scoping credits any `.md` (prior run/stage) unattended overnight. | Add `stageName` filter to `findNewestArtifactMd`; pass `last.stage`; fall through to cold re-run when none match. | applied: Phase 7 now extends `continue.ts` with optional `stageName` param; `commands.ts` passes `last.stage`; notify raised to `"warning"` |
| working-tree | Phase 6 selfcheck | ratelimit.selfcheck.ts | suggestion | verification-coverage | Q2: arm/fire/clear state-machine invariants (single-loop, deadline-from-first-429, run-scoped clear) have no assertions. | Add assert-based state-machine coverage to `ratelimit.selfcheck.ts`. | applied: Phase 6 selfcheck extended with state-machine block (scope 5 assertions) |
| working-tree review 2026-06-29_10-58-46 | Phase 7 + `commands.ts:96-107` / `continue.ts:84-124` | `commands.ts`, `continue.ts` | critical | correctness | I1: stage-name-only artifact credit can silently credit a prior run's artifact. | Add a current-run anchor; minimally require a fresh artifact newer than the failed/aborted row timestamp, else cold re-run. | planned: Phase 7 adds `newerThanMs`, passes `Date.parse(last.ts)`, and tests stale-artifact rejection. |
| working-tree review 2026-06-29_10-58-46 | Phase 4 `ratelimit.ts:159-166` | `ratelimit.ts`, `state.ts` | important | lifecycle | I3: ratelimit cap give-up clears only the private retry slot, leaving `activeRunId`/`autoMode` live. | Call `clearActiveRun()` on cap give-up, matching watchdog semantics. | planned: Phase 4 import/call `clearActiveRun`; Phase 6 selfcheck asserts active state clears. |
| working-tree review 2026-06-29_10-58-46 | Phase 6/7 selfchecks | `ratelimit.selfcheck.ts`, `continue.selfcheck.ts` | important | verification-coverage | Q8: risky logic is checked mostly by grep/slot simulations, not runnable handler/artifact assertions. | Add fake-handler ratelimit harness plus artifact finder and credit predicate assertions. | planned: Phase 6 extends ratelimit selfcheck; Phase 7 extends continue selfcheck. |
| commit review 2026-06-29_12-12-36 | Phase 8 manual continue | `continue.ts:183` | important | correctness | I1: manual continue still selects the newest markdown globally, despite docs promising the interrupted stage's artifact. | Pass `last.stage` and a freshness guard into `findNewestArtifactMd`; cold-rerun when none match. | planned: Phase 8 updates `continueCmd` to use `stoppedAtMs` + stage match and adjusts prompts/docs. |
| commit review 2026-06-29_12-12-36 | Phase 8 no-ref picker | `commands.ts:55`, `commands.ts:195`, `continue.ts:173` | important | command-flow | Q2: bare `/wfex continue` can auto-pick a mid-loop run that `continueCmd` refuses. | Use a continue-specific picker accepting only root failed/aborted rows. | planned: Phase 8 adds `shouldOfferContinue` + `pickNewestContinuable`. |
| commit review 2026-06-29_12-12-36 | Phase 8 artifact scan | `continue.ts:99` | suggestion | hardening | Q3: `statSync` can throw when a file disappears during scan. | Wrap per-file `statSync` and skip the candidate. | planned: Phase 8 wraps the candidate stat. |
| commit review 2026-06-29_12-12-36 | Phase 8 metadata | `package.json:4`, `README.md:46` | suggestion | docs | Q4: package description omits `/wfex continue`; README wording over-promises global artifact selection. | Refresh package metadata and README wording. | planned: Phase 8 updates package/README. |

## References

- Research: `.rpiv/artifacts/research/2026-06-28_22-37-10_full-auto-mode-and-usage-limit-retry.md`
- Prior sidecar plan: `.rpiv/artifacts/plans/2026-06-25_16-10-53_autonomous-resilient-workflow-sidecar.md`
- Pi docs: `extensions.md` (after_provider_response :649-660; timer discipline :219-223)
- Precedents: `b1164c3` (initial sidecar), `258b8d7` (autonomy narrowing — scope-creep lesson),
  `35a3eca` (/wfex continue)
