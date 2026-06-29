/**
 * rpiv-wfex shared run-state — anchored on a globalThis Symbol.for slot so it
 * survives Pi session replacement within the same process (the autonomy hook,
 * the watchdog lifecycle listener, and the /wfex commands all read/write it
 * across separate extension instances). Mirrors rpiv-workflow's `globalSlot`
 * (internal-utils.ts) — copied here rather than imported because that helper is
 * package-private (not in rpiv-workflow's public exports).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Max times the watchdog auto-fires resume for one runId before giving up. */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * Full-auto autonomy tier: off = today's rote-confirmation-only behavior;
 * safe = auto-answer PAUSE-list decisions (genuine safety stops still halt);
 * unattended = auto-answer all but the plan/working-tree mismatch.
 */
export type AutoMode = "off" | "safe" | "unattended";

interface WfexState {
	/** Run-id of the workflow currently in flight; cleared on clean onWorkflowEnd. */
	activeRunId?: string;
	/**
	 * Run-id the watchdog is mid-resume on — re-entrancy guard against the
	 * session_start storm that resumeWorkflowByRunId's own session spawns trigger.
	 */
	resumingRunId?: string;
	/** Per-run count of watchdog auto-resume attempts; bounds loops on a stuck stage. */
	resumeAttempts: Map<string, number>;
	/** Full-auto tier read by the autonomy directive each turn; "off" when unset. */
	autoMode?: AutoMode;
}

const SLOT = Symbol.for("@flex/rpiv-wfex:state");

function getState(): WfexState {
	const g = globalThis as Record<symbol, unknown>;
	let s = g[SLOT] as WfexState | undefined;
	if (s === undefined) {
		s = { resumeAttempts: new Map() };
		g[SLOT] = s;
	}
	return s;
}

// --- full-auto mode ---

const PREFS_FILE = join(homedir(), ".pi", "agent", "wfex-prefs.json");

interface Prefs { autoMode?: string; pollIntervalMins?: number; }

function loadPrefs(): Prefs {
	try { return JSON.parse(readFileSync(PREFS_FILE, "utf8")) as Prefs; } catch { return {}; }
}

function savePrefs(patch: Partial<Prefs>): void {
	try {
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		writeFileSync(PREFS_FILE, JSON.stringify({ ...loadPrefs(), ...patch }), "utf8");
	} catch { /* non-fatal */ }
}

export function saveAutoMode(mode: AutoMode): void { savePrefs({ autoMode: mode }); }

/** Load persisted auto mode from disk; returns "off" when absent or unreadable. */
export function loadAutoMode(): AutoMode {
	const m = loadPrefs().autoMode;
	if (m === "safe" || m === "unattended") return m as AutoMode;
	return "off";
}

/** Poll interval for rate-limit retries in minutes; default 10. */
export function loadPollIntervalMins(): number {
	const n = loadPrefs().pollIntervalMins;
	return typeof n === "number" && n >= 1 && n <= 120 ? n : 10;
}

export function savePollIntervalMins(mins: number): void { savePrefs({ pollIntervalMins: mins }); }

export function setAutoMode(mode: AutoMode): void {
	getState().autoMode = mode;
}

/** Current full-auto tier; "off" when unset (today's behavior). */
export function getAutoMode(): AutoMode {
	return getState().autoMode ?? "off";
}

// --- active-run tracking (set by watchdog lifecycle, read by autonomy) ---

export function setActiveRun(runId: string): void {
	getState().activeRunId = runId;
}

export function getActiveRunId(): string | undefined {
	return getState().activeRunId;
}

/** True while a workflow run is in flight — gates the autonomy directive. */
export function isRunActive(): boolean {
	return getState().activeRunId !== undefined;
}

/**
 * Clear active + resuming markers (clean end or give-up). Attempt counts persist
 * until explicitly reset so a give-up stays sticky for the rest of the process.
 */
export function clearActiveRun(): void {
	const s = getState();
	s.activeRunId = undefined;
	s.resumingRunId = undefined;
	// ponytail: auto mode is now a persistent preference; clearActiveRun no longer resets it
}

// --- watchdog re-entrancy guard ---

export function markResuming(runId: string): void {
	getState().resumingRunId = runId;
}

export function isResuming(runId: string): boolean {
	return getState().resumingRunId === runId;
}

/**
 * Clear the resuming guard iff it matches `runId` (idempotent). The /wfex resume
 * command calls this in a finally so a failed resume can't wedge the guard.
 */
export function clearResuming(runId: string): void {
	const s = getState();
	if (s.resumingRunId === runId) s.resumingRunId = undefined;
}

// --- resume-attempt cap ---

/** Increment and return the watchdog auto-resume attempt count for `runId`. */
export function bumpResumeAttempt(runId: string): number {
	const s = getState();
	const n = (s.resumeAttempts.get(runId) ?? 0) + 1;
	s.resumeAttempts.set(runId, n);
	return n;
}

export function getResumeAttempts(runId: string): number {
	return getState().resumeAttempts.get(runId) ?? 0;
}

export function clearResumeAttempts(runId: string): void {
	getState().resumeAttempts.delete(runId);
}

/** Test reset — wipe the slot between cases. */
export function __resetWfexState(): void {
	(globalThis as Record<symbol, unknown>)[SLOT] = undefined;
}
