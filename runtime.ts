/**
 * rpiv-wfex peer resolution — locate @juicesharp/rpiv-workflow regardless of
 * how Pi installed this extension. Self-locating so a fresh github/npm install
 * works with NO per-machine node_modules symlink.
 *
 * A bare `import("@juicesharp/rpiv-workflow")` resolves only when Pi linked
 * node_modules into THIS extension's install dir. That linkage happens for
 * local-path installs (a symlink into the agent npm store) but NOT for github
 * or npm installs, which land in ~/.pi/agent/git/<host>/<owner>/<repo>/ — a
 * SIBLING of the agent npm store, not a descendant. Bare-specifier resolution
 * walks UP from the importing file, so it never reaches the store: the import
 * throws ERR_MODULE_NOT_FOUND and every /wfex command reports "not installed".
 * (The watchdog's /startup import fails the same way, but silently.)
 *
 * Fix: when the bare import fails, resolve the peer from the agent npm store
 * (~/.pi/agent/npm/node_modules) via createRequire, then import the resolved
 * file URL. The calling module is jiti-loaded, so jiti rewrites the dynamic
 * import (even with a variable argument) and transpiles the target .ts — the
 * same path that loads the extension itself. Verified end-to-end against the
 * store on a github-style install.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type WfRuntime = typeof import("@juicesharp/rpiv-workflow");

const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** Walk the cause chain (jiti wraps import errors) for a missing-module code. */
export function isModuleNotFound(err: unknown): boolean {
	for (let cur: unknown = err, depth = 0; cur != null && depth < 16; cur = (cur as { cause?: unknown }).cause, depth++) {
		if (typeof cur === "object" && MODULE_NOT_FOUND_CODES.has((cur as { code?: unknown }).code as string)) return true;
	}
	return false;
}

/**
 * Bases from which a peer may resolve, most-specific first. Today only the Pi
 * agent npm store is needed; the array leaves room for future store relocations.
 */
function resolutionBases(): string[] {
	return [join(homedir(), ".pi", "agent", "npm", "node_modules")];
}

/**
 * Resolve a bare specifier (supports subpaths like "pkg/startup") to an absolute
 * file path via the agent store. Returns undefined when the peer is genuinely
 * absent (not installed at all). The createRequire filename need not exist — it
 * only anchors resolution to <base>/.
 */
export function resolvePeer(specifier: string): string | undefined {
	for (const base of resolutionBases()) {
		try {
			const req = createRequire(join(base, "package.json"));
			return req.resolve(specifier);
		} catch {
			// not resolvable from this base — try the next
		}
	}
	return undefined;
}

/**
 * Import a peer module by bare specifier, falling back to store resolution when
 * bare-specifier resolution fails (the github/npm install case). Returns the
 * module namespace, or undefined when the peer is genuinely absent.
 */
export async function importPeer<T = unknown>(specifier: string): Promise<T | undefined> {
	try {
		return (await import(specifier)) as T;
	} catch (e) {
		if (!isModuleNotFound(e)) throw e; // non-resolution error surfaces
	}
	const resolved = resolvePeer(specifier);
	if (!resolved) return undefined;
	return (await import(pathToFileURL(resolved).href)) as T;
}

let runtimeMemo: Promise<WfRuntime | undefined> | undefined;

/**
 * Lazily import the heavy workflow runtime barrel, memoizing success and
 * re-attempting after an absence (so installing the peer mid-session is picked
 * up). Returns undefined only when @juicesharp/rpiv-workflow is genuinely absent.
 */
export async function loadWorkflowRuntime(): Promise<WfRuntime | undefined> {
	const attempt = runtimeMemo ?? (runtimeMemo = importPeer<WfRuntime>("@juicesharp/rpiv-workflow"));
	try {
		const rt = await attempt;
		if (!rt) runtimeMemo = undefined; // absent now — let a later retry re-resolve
		return rt;
	} catch (e) {
		runtimeMemo = undefined; // don't memoize a rejection — next call retries
		if (isModuleNotFound(e)) return undefined;
		throw e;
	}
}
