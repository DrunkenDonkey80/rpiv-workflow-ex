/**
 * rpiv-wfex commands — /wfex resume and /wfex runs. Thin wrappers over the
 * rpiv-workflow public API: the engine's /wf @<ref> resume already works
 * (command-run.ts:handleResume), so these reuse resumeWorkflowByRunId rather
 * than re-implementing it. The runtime barrel is imported lazily + guarded
 * (isModuleNotFound) so startup stays light and a missing sibling degrades
 * gracefully.
 *
 *   /wfex resume        → auto-pick the newest resumable run, then resume.
 *   /wfex resume @<ref> → resume a specific run by name or run-id.
 *   /wfex runs          → list runs with last-stage status.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunSummary, WorkflowHostContext, WorkflowStage } from "@juicesharp/rpiv-workflow";
import { clearResuming } from "./state.js";

type WfRuntime = typeof import("@juicesharp/rpiv-workflow");

let runtimeMemo: Promise<WfRuntime> | undefined;

const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** Walk the cause chain (jiti wraps import errors) for a missing-module code. */
function isModuleNotFound(err: unknown): boolean {
	for (let cur: unknown = err, depth = 0; cur != null && depth < 16; cur = (cur as { cause?: unknown }).cause, depth++) {
		if (typeof cur === "object" && MODULE_NOT_FOUND_CODES.has((cur as { code?: unknown }).code as string)) return true;
	}
	return false;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Lazily import the heavy workflow runtime barrel; undefined when absent. */
async function loadRuntime(): Promise<WfRuntime | undefined> {
	runtimeMemo ??= import("@juicesharp/rpiv-workflow");
	try {
		return await runtimeMemo;
	} catch (e) {
		runtimeMemo = undefined; // don't memoize a rejection — next call retries
		if (isModuleNotFound(e)) return undefined;
		throw e;
	}
}

/** Resume-worthy when the last stage failed/aborted or stopped mid-loop (trailing unit row). */
function isResumable(last: WorkflowStage | undefined): boolean {
	if (!last) return false;
	return last.status === "failed" || last.status === "aborted" || last.parent !== undefined;
}

/**
 * Newest clearly-incomplete run, else the newest run overall — the freeze case
 * (un-timed waitForIdle, sessions/spawn.ts:69) leaves a completed-LOOKING trail
 * because the frozen stage wrote no row; resumeWorkflowByRunId no-ops if the run
 * is genuinely complete (selectResumeEntry completed→advance, no-op at stop).
 */
function pickNewestResumable(rt: WfRuntime, cwd: string): RunSummary | undefined {
	const runs = [...rt.listRuns(cwd)].sort((a, b) => b.ts.localeCompare(a.ts));
	const incomplete = runs.find((r) => isResumable(rt.readLastStage(cwd, r.runId)));
	return incomplete ?? runs[0];
}

async function resumeCmd(pi: ExtensionAPI, ctx: WorkflowHostContext, ref: string): Promise<void> {
	try {
		const rt = await loadRuntime();
		if (!rt) {
			ctx.ui.notify("rpiv-wfex: @juicesharp/rpiv-workflow is not installed.", "error");
			return;
		}

		let runId = ref;
		if (!runId) {
			const pick = pickNewestResumable(rt, ctx.cwd);
			if (!pick) {
				ctx.ui.notify("rpiv-wfex: no workflow runs found to resume.", "warning");
				return;
			}
			runId = pick.runId;
			ctx.ui.notify(`rpiv-wfex: resuming newest run @${runId} (${pick.workflow}).`, "info");
		}

		// pi (ExtensionAPI) structurally satisfies WorkflowHost; ctx satisfies
		// WorkflowHostContext — the same call the engine's /wf @<ref> makes.
		const result = await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		// No-runId failure = no-JSONL refusal (ref didn't resolve, load error, workflow
		// gone); in-run failures carry a runId and were already notified by the stage
		// machinery's JSONL failure row. Mirrors command-run.ts:handleResume.
		if (!result.success && result.runId === undefined && result.error) {
			ctx.ui.notify(result.error, "error");
		}
	} catch (e) {
		ctx.ui.notify(`rpiv-wfex: resume threw — ${errMsg(e)}`, "error");
	} finally {
		// Release the watchdog re-entrancy guard for exactly the runId the watchdog
		// marked (the incoming explicit ref) on EVERY exit path — including the !rt and
		// no-runs early returns — so a failed/declined resume can never wedge future
		// auto-resume. Empty ref = human auto-pick path, where nothing was marked, so
		// the guard skips the call entirely.
		if (ref) clearResuming(ref);
	}
}

async function listRunsCmd(ctx: WorkflowHostContext): Promise<void> {
	const rt = await loadRuntime();
	if (!rt) {
		ctx.ui.notify("rpiv-wfex: @juicesharp/rpiv-workflow is not installed.", "error");
		return;
	}
	const runs = [...rt.listRuns(ctx.cwd)].sort((a, b) => b.ts.localeCompare(a.ts));
	if (runs.length === 0) {
		ctx.ui.notify("rpiv-wfex: no workflow runs found.", "info");
		return;
	}
	const lines = runs.map((r) => {
		const last = rt.readLastStage(ctx.cwd, r.runId);
		const status = last ? last.status : "—";
		const flag = isResumable(last) ? " ⟳ resumable" : "";
		const nm = r.name ? ` "${r.name}"` : "";
		return `@${r.runId}${nm} — ${r.workflow} [${status}]${flag}`;
	});
	ctx.ui.notify(`rpiv-wfex runs (${runs.length}):\n${lines.join("\n")}`, "info");
}

export function registerWfexCommands(pi: ExtensionAPI): void {
	pi.registerCommand("wfex", {
		description: "rpiv-wfex: resume | runs — autonomous workflow resume + run lister",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "";
			if (sub === "runs") return listRunsCmd(ctx);
			// "/wfex resume @ref", "/wfex resume", "/wfex @ref", "/wfex" all resume.
			const refToken = sub.startsWith("@") ? sub : (tokens[1] ?? "");
			if (sub === "resume" || sub === "" || sub.startsWith("@")) {
				return resumeCmd(pi, ctx, refToken.replace(/^@/, "").trim());
			}
			ctx.ui.notify("rpiv-wfex: usage — /wfex resume [@<ref>] | /wfex runs", "warning");
		},
	});
}
