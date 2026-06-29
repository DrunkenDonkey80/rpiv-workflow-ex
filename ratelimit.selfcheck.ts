/**
 * rpiv-wfex ratelimit self-check — `npx jiti ratelimit.selfcheck.ts`.
 * Assert-only tripwire for the parser, message extractor, and the real retry handlers.
 */

import { strict as assert } from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messagesText, parseResetDelayMs, registerRateLimitRetry } from "./ratelimit.js";
import { __resetWfexState, clearActiveRun, getActiveRunId, isResuming, markResuming, setActiveRun } from "./state.js";

// --- parseResetDelayMs: retry-after seconds ---
assert.equal(parseResetDelayMs("600"), 600000, "retry-after seconds → ms");
assert.equal(parseResetDelayMs("0"), undefined, "zero retry-after → undefined");
assert.equal(parseResetDelayMs(undefined), undefined, "no input → undefined");
assert.equal(parseResetDelayMs("nothing parseable here"), undefined, "no reset string → undefined");

// --- parseResetDelayMs: subscription "resets HH:MM (TZ)" embedded in free text (UTC = exact) ---
const midnightUtc = new Date("2026-06-28T00:00:00Z");
assert.equal(parseResetDelayMs("resets 2:00 (UTC)", midnightUtc), 2 * 3600 * 1000, "02:00 UTC from 00:00 → 2h");
assert.equal(parseResetDelayMs("resets 23:00 (UTC)", midnightUtc), 23 * 3600 * 1000, "23:00 UTC from 00:00 → 23h");
assert.equal(parseResetDelayMs("resets 12:00am (UTC)", midnightUtc), 24 * 3600 * 1000, "midnight already-now wraps +24h");

const eveningUtc = new Date("2026-06-28T20:00:00Z");
assert.equal(parseResetDelayMs("resets 7:30 (UTC)", eveningUtc), (11 * 3600 + 30 * 60) * 1000, "passed target wraps to next day");

// Q4: imminent reset must be small-positive, not +24h.
const imminentBase = new Date("2026-06-28T07:29:45Z");
const imminentResult = parseResetDelayMs("resets 7:30 (UTC)", imminentBase) ?? 0;
assert.ok(imminentResult > 0 && imminentResult < 120_000, "imminent reset (15s away, floored to minute) returns a small positive delta, not +24h");

// Q5: HTTP-date retry-after
const httpDateStr = "Mon, 29 Jun 2026 18:00:00 GMT";
const httpNow = new Date("2026-06-29T17:00:00Z");
assert.equal(parseResetDelayMs(httpDateStr, httpNow), 3600 * 1000, "HTTP-date retry-after → ms until that time");
assert.equal(parseResetDelayMs("Thu, 01 Jan 2026 00:00:00 GMT", new Date("2026-01-01T01:00:00Z")), undefined, "past HTTP-date → undefined");

assert.equal(parseResetDelayMs("resets 7:30pm (UTC)", midnightUtc), (19 * 3600 + 30 * 60) * 1000, "7:30pm → 19:30");

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
assert.equal(typeof clearActiveRun, "function", "I3 cleanup primitive is exported for cap give-up");
{
	const handlers: Record<string, Function[]> = {};
	const sent: string[] = [];
	const notes: string[] = [];
	const fakePi = {
		on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
		sendUserMessage: (msg: string) => { sent.push(msg); return Promise.resolve(); },
	} as unknown as ExtensionAPI;
	const fakeCtx = { ui: { notify: (m: string) => notes.push(m) } };
	void notes;

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

		await handlers.after_provider_response![0]!({ status: 200 }, fakeCtx);
		assert.equal(scheduled.length, 1, "matching non-429 clears without arming a new timer");

		await handlers.after_provider_response![0]!({ status: 429, headers: {} }, fakeCtx);
		assert.equal(scheduled.length, 2, "re-arm after clear schedules again");
		setActiveRun("other");
		await handlers.after_provider_response![0]!({ status: 200 }, fakeCtx);
		setActiveRun("run1");
		await handlers.after_provider_response![0]!({ status: 429, headers: {} }, fakeCtx);
		assert.equal(scheduled.length, 2, "unrelated non-429 did not clear armed retry");

		await handlers.agent_end![0]!({ messages: [{ content: "limit resets 7:30pm (UTC)" }] }, fakeCtx);
		assert.equal(scheduled.length, 3, "agent_end reset string reschedules the armed retry");

		scheduled.at(-1)!.fn();
		assert.deepEqual(sent, ["/wfex resume @run1"], "fireRetry sends one resume");
		assert.equal(isResuming("run1"), true, "fireRetry marks resuming");
		const sendsAfterFirstFire = sent.length;
		scheduled.at(-1)!.fn();
		assert.equal(sent.length, sendsAfterFirstFire, "isResuming bail prevents a second send");

		// I3: cap give-up calls clearActiveRun, so active run is gone.
		const slot = Symbol.for("@flex/rpiv-wfex:ratelimit");
		(globalThis as Record<symbol, { timer?: unknown; deadlineMs?: number; runId?: string }>)[slot] = { deadlineMs: Date.now() - 1, runId: "run1" };
		markResuming("other");
		scheduled.at(-1)!.fn();
		assert.equal(getActiveRunId(), undefined, "cap give-up clears activeRunId");
	} finally {
		globalThis.setTimeout = realSetTimeout;
		__resetWfexState();
	}
}

console.log("ratelimit.selfcheck: OK");
