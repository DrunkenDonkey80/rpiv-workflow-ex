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
 * body, so the subscription string is wired below via an agent_end message
 * scan (refineFromMessages); absent a reset string, it falls back to polling.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearActiveRun, clearResuming, getActiveRunId, isResuming, markResuming } from "./state.js";

/** Poll cadence when no precise reset time is known. Also debounces against Pi's own provider auto-retry (seconds-scale), which clears us via a non-429 response before this first tick. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;
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
 *  - an HTTP-date `retry-after` value ("Mon, 29 Jun 2026 18:00:00 GMT") — Q5
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
	// I1: bail (re-arm to poll) when isResuming is already set by another resumer —
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

/** Replace the armed timer's wait with `delayMs` (precise reset), preserving the wall-clock deadline. */
function rescheduleRetry(pi: ExtensionAPI, ctx: RetryCtx, runId: string, delayMs: number): void {
	const s = retryState();
	if (s.timer) clearTimeout(s.timer);
	s.timer = undefined; // keep deadlineMs so the cap still measures from the first 429
	armRetry(pi, ctx, runId, delayMs);
}

/**
 * Register the 429 retry-until-reset observer. Wires after_provider_response —
 * the timer is created INSIDE the handler (never the factory body) per Pi's timer
 * discipline (extensions.md:219-223) and unref()'d so it never holds the process.
 */
export function registerRateLimitRetry(pi: ExtensionAPI): void {
	// Q6: clear the retry slot on clean workflow_end — mirrors watchdog's lifecycle hook.
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

	pi.on("agent_end", async (event, ctx) => {
		if (!isRetryArmed()) return; // only refine an already-armed retry
		const runId = getActiveRunId();
		if (!runId) return;
		const messages = (event as { messages?: unknown }).messages;
		const delay = parseResetDelayMs(messagesText(messages));
		if (delay === undefined) return; // no subscription reset string → keep polling
		rescheduleRetry(pi, ctx as RetryCtx, runId, delay);
	});
}
