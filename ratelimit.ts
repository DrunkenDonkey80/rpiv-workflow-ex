/**
 * rpiv-wfex rate-limit retry — when a usage limit (HTTP 429) ends a turn, Pi's
 * provider auto-retry exhausts and the run dies. This observer arms a timer that
 * re-sends `/wfex resume @<runId>` on a poll cadence until a non-429 response
 * clears it — bounded by a wall-clock cap so a never-resetting limit can't loop
 * forever.
 *
 * Detection seam: ARMED ON `agent_end`, NOT `after_provider_response`. For most
 * providers (e.g. OpenAI-compatible like glm/zai) the SDK THROWS on a non-2xx
 * 429 BEFORE the `onResponse` callback runs, so `after_provider_response` never
 * carries status 429 — the 429 surfaces instead as a thrown error that fails the
 * stage (often terminally) and ends the turn. `agent_end` is the seam that
 * reliably fires on that error and carries the message text containing "429" /
 * the reset string. `after_provider_response` is still wired (it fires on 2xx and
 * clears the retry once the limit lifts) and arms as a belt-and-suspenders path
 * for any provider whose `onResponse` does reach a 429.
 *
 * Terminal failure: a 429 can stop the workflow entirely ("implement failed").
 * That fires `workflow_end`, and the watchdog's onWorkflowEnd clears
 * `activeRunId`. This observer must NOT treat that as "run gone, stop retrying" —
 * the rate limit IS the recoverable case. So:
 *  - the retry is NOT cleared on `workflow_end` (it is cleared by a successful
 *    non-429 response after a resume, or by the wall-clock cap);
 *  - fireRetry resumes by its captured runId even when `activeRunId` was cleared,
 *    only bailing if a DIFFERENT run is now active.
 *
 * Multi-account: when the `cswap` switcher is installed, each retry first rotates
 * to another Claude account with headroom (cswap.ts) before resuming — so a
 * usage-limited account is sidestepped rather than waited out (see fireRetry).
 *
 * Reset timing: parseResetDelayMs reads a `retry-after` header / HTTP-date / the
 * English "resets HH:MM (TZ)" subscription string when present; otherwise it
 * polls every getPollIntervalMs() (user-configurable, default 10 min). Non-English
 * reset strings (e.g. Chinese "…重置 <datetime>") are intentionally NOT parsed —
 * polling covers them correctly and avoids TZ ambiguity. ponytail: poll wins over
 * cleverness here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearActiveRun, clearResuming, getActiveRunId, isResuming, loadPollIntervalMins, markResuming } from "./state.js";
import { cswapAvailable, rotateToNextAccount } from "./cswap.js";

/** Default poll cadence — exported so the selfcheck can reference it. Use getPollIntervalMs() for actual scheduling. */
export const POLL_INTERVAL_MS = 10 * 60 * 1000;
/** Poll cadence in ms — reads the persisted user setting (default 10 min). */
function getPollIntervalMs(): number { return loadPollIntervalMins() * 60_000; }
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
	lastKnownRunId = undefined;
}

/** Last runId seen active — fallback for arming when `activeRunId` was already cleared by a terminal-failure workflow_end. */
let lastKnownRunId: string | undefined;
function rememberActiveRun(): void {
	const a = getActiveRunId();
	if (a) lastKnownRunId = a;
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
 *  - an HTTP-date `retry-after` value ("Mon, 29 Jun 2026 18:00:00 GMT") — Q5
 *  - the subscription "… resets 7:30pm (Europe/Berlin)" string → next occurrence
 *    of that wall-clock time in that zone (regex matches the substring anywhere).
 * Non-English reset strings (e.g. Chinese "重置") are deliberately NOT matched —
 * polling covers them. ponytail: DST near the boundary can be off by an hour;
 * bounded by MAX_RETRY_WALL_MS, good enough.
 */
export function parseResetDelayMs(input: string | undefined, now: Date = new Date()): number | undefined {
	if (!input) return undefined;
	const s = input.trim();
	if (/^\d+$/.test(s)) {
		const secs = Number(s);
		return secs > 0 ? secs * 1000 : undefined;
	}
	// Q5: HTTP-date retry-after (e.g. "Mon, 29 Jun 2026 18:00:00 GMT")
	const d = new Date(s);
	if (!Number.isNaN(d.getTime())) {
		const delta = d.getTime() - now.getTime();
		return delta > 0 ? delta : undefined;
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
	const nowSod = cur.h * 3600 + cur.m * 60; // Q4: floor to minute — an imminent reset (within 60s of target) must not wrap to +24h
	let deltaSec = targetSod - nowSod;
	if (deltaSec <= 0) deltaSec += 24 * 3600; // already passed today → next day
	return deltaSec * 1000;
}

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

/**
 * Flatten messages to text INCLUDING assistant error text (errorMessage), which is
 * where a 429 surfaces for OpenAI-compatible providers (stopReason "error"). The
 * base messagesText reads only `.content`, which omits the provider error string.
 */
function errorAndContentText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const out: string[] = [];
	for (const msg of messages) {
		const m = msg as { content?: unknown; errorMessage?: unknown };
		if (typeof m.errorMessage === "string") out.push(m.errorMessage);
		const c = m.content;
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

/**
 * Does this turn's messages indicate a usage-limit failure we should retry past?
 * True when the error/content text carries a 429 OR a parseable reset string.
 */
export function detectUsageLimitError(messages: unknown): boolean {
	const text = errorAndContentText(messages);
	if (/429\b/.test(text)) return true;
	if (parseResetDelayMs(text) !== undefined) return true;
	return false;
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
	// Bail only if a DIFFERENT run is now active. activeRunId may be undefined
	// because a terminal 429 failure cleared it (watchdog onWorkflowEnd) — that is
	// exactly the case we retry through, so undefined does NOT count as "different".
	const active = getActiveRunId();
	if (active !== undefined && active !== runId) {
		clearRetry();
		return;
	}
	// I1: bail (re-arm to poll) when isResuming is already set by another resumer —
	// force-clearing discards a watchdog-owned interlock and can drive a second concurrent
	// resume for the same run.
	if (isResuming(runId)) {
		armRetry(pi, ctx, runId, getPollIntervalMs()); // re-poll; don't force-clear
		return;
	}
	// cswap multi-account rotation: before resuming the still-limited account,
	// try switching to another Claude account that still has headroom. undefined =>
	// cswap not installed => fall through to the original same-account resume+poll.
	const rot = rotateToNextAccount();
	if (rot && !rot.switched) {
		// cswap present but every managed account is at its limit: wait a poll interval
		// and re-rotate (an account may reset in the interim).
		safeNotify(ctx, `rpiv-wfex: all managed Claude accounts at limit (${rot.reason ?? "exhausted"}) — re-checking @${runId} in ${loadPollIntervalMins()}m.`, "info");
		armRetry(pi, ctx, runId, getPollIntervalMs());
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
	armRetry(pi, ctx, runId, getPollIntervalMs()); // keep polling; a non-429 response clears the loop
}

/** Replace the armed timer's wait with `delayMs` (precise reset), preserving the wall-clock deadline. */
function rescheduleRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string, delayMs: number): void {
	const s = retryState();
	if (s.timer) clearTimeout(s.timer);
	s.timer = undefined; // keep deadlineMs so the cap still measures from the first 429
	armRetry(pi, ctx, runId, delayMs);
}

/**
 * Register the 429 retry-until-reset observer. The timer is created INSIDE a
 * handler (never the factory body) per Pi's timer discipline (extensions.md) and
 * unref()'d so it never holds the process.
 */
export function registerRateLimitRetry(pi: ExtensionAPI): void {
	pi.on("after_provider_response", async (event, ctx) => {
		rememberActiveRun();
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
		const runId = getActiveRunId() ?? lastKnownRunId;
		if (!runId) return; // 429 outside an active run — nothing to resume
		if (isRetryArmed()) return; // single-loop invariant — already retrying this window
		const headers = (event as { headers?: Record<string, string | string[] | undefined> }).headers;
		// cswap installed → fire the first tick immediately (delay 0) to rotate accounts
		// rather than wait out this account's window; absent cswap → retry-after/poll wait.
		const hasCswap = cswapAvailable();
		const delay = hasCswap ? 0 : (parseResetDelayMs(firstHeader(headers, "retry-after")) ?? getPollIntervalMs());
		safeNotify(
			ctx as RetryCtx,
			hasCswap
				? `rpiv-wfex: usage limit (429) on @${runId} — trying other Claude accounts (cswap), then polling (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`
				: `rpiv-wfex: usage limit (429) on @${runId} — retrying until it resets (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`,
			"warning",
		);
		armRetry(pi, ctx as RetryCtx, runId, delay);
	});

	pi.on("agent_end", async (event, ctx) => {
		rememberActiveRun();
		const messages = (event as { messages?: unknown }).messages;
		// Primary arm seam: a 429 surfaces here as an error message (SDKs throw on
		// non-2xx before after_provider_response can carry it). Healthy turns carry
		// no limit signal → nothing to do (the non-429 clear is owned by
		// after_provider_response, which fires on the 2xx resume).
		if (!detectUsageLimitError(messages)) return;
		const runId = getActiveRunId() ?? lastKnownRunId;
		if (!runId) return;
		if (!isRetryArmed()) {
			// cswap installed → rotate immediately; otherwise poll.
			const hasCswap = cswapAvailable();
			safeNotify(
				ctx as RetryCtx,
				hasCswap
					? `rpiv-wfex: usage limit (429) on @${runId} — trying other Claude accounts (cswap), then polling (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`
					: `rpiv-wfex: usage limit (429) on @${runId} — retrying every ~${loadPollIntervalMins()} min until it lifts (cap ${Math.round(MAX_RETRY_WALL_MS / 3_600_000)}h).`,
				"warning",
			);
			armRetry(pi, ctx as RetryCtx, runId, hasCswap ? 0 : getPollIntervalMs());
			return;
		}
		// Already armed: tighten to a precise reset wait only when an English reset string is present.
		// With cswap we rotate accounts instead of waiting, so skip the reschedule.
		if (cswapAvailable()) return;
		const delay = parseResetDelayMs(messagesText(messages));
		if (delay !== undefined) rescheduleRetry(pi, ctx as RetryCtx, runId, delay);
	});
}
