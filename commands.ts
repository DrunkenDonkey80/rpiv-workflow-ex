/**
 * rpiv-wfex commands — /wfex resume and /wfex runs. Thin wrappers over the
 * rpiv-workflow public API: the engine's /wf @<ref> resume already works
 * (command-run.ts:handleResume), so these reuse resumeWorkflowByRunId rather
 * than re-implementing it. The runtime barrel is imported lazily + guarded
 * (isModuleNotFound) so startup stays light and a missing sibling degrades
 * gracefully.
 *
 *   /wfex resume          → auto-pick the newest resumable run, then resume.
 *   /wfex resume @<ref>   → resume a specific run by name or run-id.
 *   /wfex continue [@ref] → mark an interrupted-but-done stage complete and
 *                           advance to the NEXT stage (see continue.ts).
 *   /wfex runs            → list runs with last-stage status.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunSummary, WorkflowHostContext, WorkflowStage } from "@juicesharp/rpiv-workflow";
import { buildCompletedRow, continueCmd, findNewestArtifactMd, parseFrontmatter, shouldOfferContinue } from "./continue.js";
import { loadWorkflowRuntime, type WfRuntime } from "./runtime.js";
import { clearResuming, getActiveRunId, getAutoMode, saveAutoMode, setAutoMode, type AutoMode } from "./state.js";

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Resume-worthy when the last stage failed/aborted or stopped mid-loop (trailing unit row). */
function isResumable(last: WorkflowStage | undefined): boolean {
	if (!last) return false;
	return last.status === "failed" || last.status === "aborted" || last.parent !== undefined;
}

export function shouldFullAutoCredit(last: WorkflowStage | undefined, mode: AutoMode): last is WorkflowStage {
	return mode !== "off" && shouldOfferContinue(last);
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

/** Newest root failed/aborted run that manual continue can actually advance. */
function pickNewestContinuable(rt: WfRuntime, cwd: string): RunSummary | undefined {
	return [...rt.listRuns(cwd)]
		.sort((a, b) => b.ts.localeCompare(a.ts))
		.find((r) => shouldOfferContinue(rt.readLastStage(cwd, r.runId)));
}

async function resumeCmd(pi: ExtensionAPI, ctx: WorkflowHostContext, ref: string): Promise<void> {
	try {
		const rt = await loadWorkflowRuntime();
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

		// Full-auto: prefer crediting a fresh stage-matched artifact over a cold re-run.
		// ponytail: mtime > failed-row ts is the cheap stale-prior-run guard; false negatives cold-rerun.
		const mode = getAutoMode();
		const last = rt.readLastStage(ctx.cwd, runId);
		if (shouldFullAutoCredit(last, mode)) {
			const failedAtMs = Date.parse(last.ts);
			const found = findNewestArtifactMd(ctx.cwd, last.stage, failedAtMs);
			if (found) {
				try {
					const data = parseFrontmatter(readFileSync(found.abs, "utf8")); // catch below guards unreadable artifacts
					if (rt.appendStage(ctx.cwd, runId, buildCompletedRow(last, found.rel, data, runId))) {
						ctx.ui.notify(`rpiv-wfex: full-auto credited '${last.stage}' with ${found.rel} (fresh stage artifact; no cold re-run).`, "warning");
						return;
					}
					ctx.ui.notify(`rpiv-wfex: full-auto could not write credit row for '${last.stage}' — cold re-run.`, "warning");
				} catch (e) {
					ctx.ui.notify(`rpiv-wfex: full-auto could not credit '${last.stage}' (${errMsg(e)}) — cold re-run.`, "warning");
				}
			}
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

function listDecisionsCmd(ctx: WorkflowHostContext, ref: string): void {
	const dir = join(ctx.cwd, "docs", "rpiv-wfex-decisions");
	if (!existsSync(dir)) {
		ctx.ui.notify("rpiv-wfex: no auto-decision logs found.", "info");
		return;
	}
	const all = readdirSync(dir).filter((f) => f.endsWith("_decisions.md"));
	const showAll = ref === "all";
	const target = showAll ? "" : ref || getActiveRunId();
	const files = showAll
		? all
		: target
			? all.filter((f) => f.startsWith(target))
			: all.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs).slice(0, 1);
	if (files.length === 0) {
		ctx.ui.notify(target ? `rpiv-wfex: no auto-decision log for @${target}.` : "rpiv-wfex: no auto-decision logs found.", "info");
		return;
	}
	const label = target ? `@${target}` : ref === "all" ? "all runs" : "latest run";
	const chunks = files.sort().map((f) => `## ${f}\n${readFileSync(join(dir, f), "utf8").trim()}`);
	ctx.ui.notify(`rpiv-wfex auto decisions (${label}):\n${chunks.join("\n\n")}`, "info");
}

async function listRunsCmd(ctx: WorkflowHostContext): Promise<void> {
	const rt = await loadWorkflowRuntime();
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

const AUTO_MODES = new Set<AutoMode>(["off", "safe", "unattended"]);

/** `/wfex auto [off|safe|unattended]` — show or set the full-auto tier (persisted). */
function autoCmd(ctx: WorkflowHostContext, mode: string): void {
	if (!mode) {
		ctx.ui.notify(`rpiv-wfex: auto-mode is '${getAutoMode()}'. Set with /wfex auto off|safe|unattended.`, "info");
		return;
	}
	if (!AUTO_MODES.has(mode as AutoMode)) {
		ctx.ui.notify(`rpiv-wfex: unknown auto-mode '${mode}' — use off | safe | unattended.`, "warning");
		return;
	}
	const m = mode as AutoMode;
	setAutoMode(m);
	saveAutoMode(m);
	const blurb =
		m === "safe"
			? "auto-answer decisions; genuine safety stops still halt"
			: m === "unattended"
				? "auto-answer everything except a plan/working-tree mismatch"
				: "rote confirmations only (default)";
	ctx.ui.notify(`rpiv-wfex: auto-mode set to ${m} — ${blurb}. Remembered across sessions.`, "info");
}

/**
 * `/wfex continue [@ref]` — advance PAST an interrupted-but-done stage instead
 * of cold-re-running it. Loads the runtime + resolves the run (newest resumable
 * when no ref), then delegates to the interactive `continueCmd`.
 */
async function continueDispatch(pi: ExtensionAPI, ctx: WorkflowHostContext, ref: string): Promise<void> {
	const rt = await loadWorkflowRuntime();
	if (!rt) {
		ctx.ui.notify("rpiv-wfex: @juicesharp/rpiv-workflow is not installed.", "error");
		return;
	}
	let runId = ref;
	if (!runId) {
		const pick = pickNewestContinuable(rt, ctx.cwd);
		if (!pick) {
			ctx.ui.notify("rpiv-wfex: no root failed/aborted workflow runs found to continue.", "warning");
			return;
		}
		runId = pick.runId;
	}
	try {
		await continueCmd(pi, ctx, rt, runId);
	} catch (e) {
		ctx.ui.notify(`rpiv-wfex: continue threw — ${errMsg(e)}`, "error");
	}
}

export function registerWfexCommands(pi: ExtensionAPI): void {
	pi.registerCommand("wfex", {
		description: "rpiv-wfex: resume | continue | auto | decisions | runs — autonomous workflow resume, skip-done-stage, full-auto toggle, + run lister",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "";
			if (sub === "runs") return listRunsCmd(ctx);
			if (sub === "decisions") return listDecisionsCmd(ctx, (tokens[1] ?? "").replace(/^@/, "").trim());
			if (sub === "continue") return continueDispatch(pi, ctx, (tokens[1] ?? "").replace(/^@/, "").trim());
			if (sub === "auto") return autoCmd(ctx, (tokens[1] ?? "").toLowerCase());
			// "/wfex resume @ref", "/wfex resume", "/wfex @ref", "/wfex" all resume.
			const refToken = sub.startsWith("@") ? sub : (tokens[1] ?? "");
			if (sub === "resume" || sub === "" || sub.startsWith("@")) {
				return resumeCmd(pi, ctx, refToken.replace(/^@/, "").trim());
			}
			ctx.ui.notify("rpiv-wfex: usage — /wfex resume [@<ref>] | /wfex continue [@<ref>] | /wfex auto [off|safe|unattended] | /wfex decisions [@<runId>|all] | /wfex runs", "warning");
		},
	});
}
