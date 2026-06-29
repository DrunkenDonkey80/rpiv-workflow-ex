/**
 * rpiv-wfex watchdog — rescue runs orphaned by the continue-policy waitForIdle
 * freeze (sessions/spawn.ts:69): when Pi disposes the session mid-stage, the
 * engine's await never resolves, onWorkflowEnd never fires, and "the
 * orchestrator is gone." Two halves: OBSERVATION (registerLifecycle, never
 * mutates model — the events.ts registry is append-only and rpiv-core already
 * owns model-override) + RESCUE (session_start auto-resume).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	bumpResumeAttempt,
	clearActiveRun,
	clearResumeAttempts,
	clearResuming,
	getActiveRunId,
	getResumeAttempts,
	isResuming,
	loadAutoMode,
	markResuming,
	MAX_RESUME_ATTEMPTS,
	setActiveRun,
	setAutoMode,
} from "./state.js";

/**
 * Idle-debounce before declaring a run orphaned. A normal default-policy stage
 * transition opens a replacement session then IMMEDIATELY continues (agent goes
 * busy), so an agent still idle this long after a session_start with a run in
 * flight is the freeze signature, not a healthy hand-off.
 */
const ORPHAN_DEBOUNCE_MS = 8000;

/**
 * Watchdog-internal monotonic epoch, in its OWN global slot (survives session
 * replacement). Each session_start bumps it; a timer captures the value at
 * schedule time and bails if a newer session_start superseded it — so a stale
 * ctx captured by a now-replaced session never drives a resume.
 */
const EPOCH_SLOT = Symbol.for("@flex/rpiv-wfex:watchdog-epoch");
function bumpEpoch(): number {
	const g = globalThis as Record<symbol, unknown>;
	const next = ((g[EPOCH_SLOT] as number | undefined) ?? 0) + 1;
	g[EPOCH_SLOT] = next;
	return next;
}
function currentEpoch(): number {
	return ((globalThis as Record<symbol, unknown>)[EPOCH_SLOT] as number | undefined) ?? 0;
}

const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
function isModuleNotFound(err: unknown): boolean {
	for (let cur: unknown = err, depth = 0; cur != null && depth < 16; cur = (cur as { cause?: unknown }).cause, depth++) {
		if (typeof cur === "object" && MODULE_NOT_FOUND_CODES.has((cur as { code?: unknown }).code as string)) return true;
	}
	return false;
}

/** Minimal shape of the session_start ctx the watchdog reads (ExtensionContext subset). */
type WatchdogCtx = { isIdle(): boolean; ui: { notify(m: string, l?: "info" | "warning" | "error"): void } };

export function registerWatchdog(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const saved = loadAutoMode();
		if (saved !== "off") {
			setAutoMode(saved);
			ctx.ui.notify(`rpiv-wfex: auto-mode restored to '${saved}' (remembered). Use /wfex auto off to disable.`, "info");
		}
		const runId = getActiveRunId();
		if (!runId || isResuming(runId)) return; // nothing active, or our own resume's sessions
		const epoch = bumpEpoch();
		const timer = setTimeout(() => maybeResume(pi, ctx, runId, epoch), ORPHAN_DEBOUNCE_MS);
		timer.unref?.();
	});
	void registerWatchdogLifecycle().catch((err) => {
		if (isModuleNotFound(err)) return; // sibling absent — no runs to observe; degrade silently
		console.error("[rpiv-wfex] watchdog lifecycle registration failed:", err);
	});
}

function maybeResume(pi: ExtensionAPI, ctx: WatchdogCtx, runId: string, epoch: number): void {
	if (epoch !== currentEpoch()) return; // a newer session_start superseded this timer
	if (getActiveRunId() !== runId || isResuming(runId)) return; // run ended/changed, or resume in flight
	if (!ctx.isIdle()) return; // streaming → orchestrator alive → not frozen

	const attempts = getResumeAttempts(runId);
	if (attempts >= MAX_RESUME_ATTEMPTS) {
		ctx.ui.notify(
			`rpiv-wfex: run @${runId} stalled again after ${attempts} auto-resume attempts — run \`/wfex resume @${runId}\` manually.`,
			"warning",
		);
		clearActiveRun(); // give up: stop re-firing this process
		return;
	}

	markResuming(runId); // suppress the session_start storm the resume's own spawns trigger
	const n = bumpResumeAttempt(runId);
	ctx.ui.notify(`rpiv-wfex: workflow run @${runId} looks orphaned — auto-resuming (attempt ${n}/${MAX_RESUME_ATTEMPTS}).`, "info");
	// session_start ctx has no newSession; route resume through the command, which
	// runs with a full ExtensionCommandContext (docs/extensions.md:1273). Agent is
	// idle here, so sendUserMessage triggers a turn. Wrap so a rejected send can't
	// become an unhandled rejection.
	void Promise.resolve(pi.sendUserMessage(`/wfex resume @${runId}`)).catch((err) => {
		clearResuming(runId); // queue failed → the command's finally never runs; release the guard here so a future session_start can retry
		ctx.ui.notify(`rpiv-wfex: could not queue resume for @${runId} — ${String(err)}`, "error");
	});
}

async function registerWatchdogLifecycle(): Promise<void> {
	const { registerLifecycle } = await import("@juicesharp/rpiv-workflow/startup");
	registerLifecycle({
		// Run took hold (fresh /wf or a resume): mark active, release any watchdog
		// guard so a SECOND freeze of the resumed run is detectable.
		onWorkflowStart: (ctx) => {
			setActiveRun(ctx.runId);
			clearResuming(ctx.runId);
		},
		// Fires on clean completion AND terminal failure — either way the
		// orchestrator returned, so this run is NOT an orphan. Clear it.
		onWorkflowEnd: (_result, ctx) => {
			clearResumeAttempts(ctx.runId);
			if (getActiveRunId() === ctx.runId) clearActiveRun();
		},
	});
}
