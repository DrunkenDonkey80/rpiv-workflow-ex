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
