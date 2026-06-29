/**
 * rpiv-wfex `/wfex continue` — advance a run PAST a stage that was interrupted
 * but actually finished its work, instead of cold-re-running it.
 *
 * Root cause (verified against the engine): resume keys on the trail's LAST row
 * — `selectResumeEntry` routes ONWARD only when that row is `status:"completed"`;
 * a `failed`/`aborted`/`skipped` trailer re-enters (reattaches or cold re-runs)
 * that stage. When `/wf` dies mid-stage the skill's artifact is already on disk
 * but the row is `failed`, so `/wf @id` redoes the whole stage.
 *
 * The fix composes two PUBLIC engine pieces, zero engine edits: append a
 * synthetic `completed` row for the interrupted stage (crediting the on-disk
 * artifact), then call `resumeWorkflowByRunId` — which now takes the
 * `completed → route onward` path and runs the NEXT stage.
 *
 * The synthetic row is schema-coupled, so it is built to the exact shape the
 * strict resume reader enforces (`isWorkflowStage` + `hasValidSessionRef` in
 * state/reads.ts): numeric stageNumber, string stage, enum status, an
 * `output.artifacts` array, and a PRESENT `session` key (we write `null`). A
 * malformed row makes resume REFUSE (fails safe — never corrupts state), and
 * the artifact is human-confirmed before the row is written.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowHostContext, WorkflowStage } from "@juicesharp/rpiv-workflow";

type WfRuntime = typeof import("@juicesharp/rpiv-workflow");

/** Strip one layer of matching single/double quotes. */
function unquote(s: string): string {
	return s.replace(/^["']|["']$/g, "");
}

/**
 * Best-effort YAML-frontmatter parse — flat `key: value`, `[a, b]` arrays,
 * quoted scalars. Faithful enough to populate the row's `data` (the rpiv-pi
 * pipeline reads the artifact FILE by path downstream, not this `data`, so a
 * `{}` fallback is functionally safe). `ponytail: flat parser, swap for a YAML
 * dep only if a nested-frontmatter stage ever needs data fidelity.`
 */
export function parseFrontmatter(md: string): Record<string, unknown> {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
	if (!m) return {};
	const out: Record<string, unknown> = {};
	for (const line of m[1]!.split(/\r?\n/)) {
		const mm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!mm) continue;
		const key = mm[1]!;
		const raw = mm[2]!.trim();
		if (raw === "") {
			out[key] = "";
		} else if (raw.startsWith("[") && raw.endsWith("]")) {
			out[key] = raw
				.slice(1, -1)
				.split(",")
				.map((s) => unquote(s.trim()))
				.filter((s) => s !== "");
		} else {
			out[key] = unquote(raw);
		}
	}
	return out;
}

export interface FoundArtifact {
	abs: string;
	/** cwd-relative, forward-slashed — matches the path style the engine records. */
	rel: string;
	mtimeMs: number;
}

/**
 * Newest `*.md` anywhere under `<cwd>/.rpiv/artifacts` (recursive), by mtime.
 * When `stageName` is provided, returns the newest candidate whose path segment
 * equals `stageName` (case-insensitive, also tries `stageName + 's'` to cover
 * the common artifact-dir convention plan→plans, design→designs), falling back
 * to a frontmatter `topic`/`stage` field match; returns `undefined` when no
 * candidate matches (caller falls through to a cold re-run). The no-stageName
 * path is unchanged for callers that intentionally want the global newest artifact.
 * ponytail: segment match covers the common artifact-path layout; no fuzzy score needed.
 */
export function findNewestArtifactMd(cwd: string, stageName?: string, newerThanMs?: number): FoundArtifact | undefined {
	const root = join(cwd, ".rpiv", "artifacts");
	const candidates: FoundArtifact[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // dir absent / unreadable — nothing to credit here
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory()) {
				walk(p);
			} else if (e.isFile() && e.name.endsWith(".md")) {
				try {
					const mtimeMs = statSync(p).mtimeMs;
					candidates.push({ abs: p, rel: relative(cwd, p).split(sep).join("/"), mtimeMs });
				} catch {
					// File disappeared / became unreadable between readdirSync and statSync — skip it.
				}
			}
		}
	};
	walk(root);
	let pool = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (newerThanMs !== undefined) pool = pool.filter((c) => c.mtimeMs > newerThanMs);
	if (!stageName) return pool[0];
	const lower = stageName.toLowerCase();
	// Path-segment match first — Q2 fix: match on directory-name boundary, not free substring.
	// A stage name like "design" must not match "redesign/" or "by-design/".
	// ponytail: pluralise once (append 's') covers plan→plans, design→designs, etc.
	for (const c of pool) {
		const segments = c.rel.toLowerCase().split(/[\\/]/);
		if (segments.some((seg) => seg === lower || seg === lower + "s")) return c;
	}
	// Frontmatter match as secondary (topic/stage field)
	for (const c of pool) {
		try {
			const fm = parseFrontmatter(readFileSync(c.abs, "utf8"));
			const topic = String(fm.topic ?? fm.stage ?? "").toLowerCase();
			if (topic.includes(lower)) return c;
		} catch {
			// unreadable → skip
		}
	}
	return undefined; // no stage-matched artifact → caller falls through to cold re-run
}

/**
 * Build the synthetic `completed` row that makes resume advance onward. Shape
 * mirrors a real artifact-md success row (see a completed row in any run trail)
 * and the strict-reader requirements above. `session: null` is mandatory — the
 * resume reader's `hasValidSessionRef` refuses a row missing the key.
 */
export function shouldOfferContinue(last: WorkflowStage | undefined): last is WorkflowStage {
	return !!last
		&& last.parent === undefined
		&& (last.status === "failed" || last.status === "aborted")
		&& Number.isFinite(Date.parse(last.ts));
}

export function buildCompletedRow(
	last: WorkflowStage,
	rel: string,
	data: Record<string, unknown>,
	runId: string,
): WorkflowStage {
	const ts = new Date().toISOString();
	const skill = last.skill ? { skill: last.skill } : {};
	return {
		stageNumber: last.stageNumber,
		stage: last.stage,
		...skill,
		status: "completed",
		ts,
		session: null,
		output: {
			kind: "artifact-md",
			artifacts: [{ handle: { kind: "fs", path: rel }, role: "primary" }],
			data,
			meta: { stage: last.stage, ...skill, stageNumber: last.stageNumber, ts, runId },
		},
		// `session` is a real serialized field on trail rows; the public
		// WorkflowStage type doesn't surface it, so cast past the type (jiti runs
		// untranspiled — JSON.stringify keeps the key, which the reader requires).
	} as unknown as WorkflowStage;
}

/**
 * `/wfex continue` for one resolved run. Caller (commands.ts) has already loaded
 * `rt` and resolved `runId`. Interactive by design — the "this stage is actually
 * done" call is substantive, so it asks before mutating the trail.
 */
export async function continueCmd(pi: ExtensionAPI, ctx: WorkflowHostContext, rt: WfRuntime, runId: string): Promise<void> {
	const last = rt.readLastStage(ctx.cwd, runId);
	if (!last) {
		ctx.ui.notify(`rpiv-wfex: @${runId} has no recorded stages — use \`/wfex resume @${runId}\`.`, "warning");
		return;
	}
	if (last.status === "completed") {
		ctx.ui.notify(`rpiv-wfex: @${runId} last stage '${last.stage}' already completed — advancing to the next stage.`, "info");
		await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		return;
	}
	if (!shouldOfferContinue(last)) {
		ctx.ui.notify(`rpiv-wfex: @${runId} last stage '${last.stage}' is not a root failed/aborted row with a parseable timestamp — cold re-running it.`, "warning");
		await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		return;
	}

	const stoppedAtMs = Date.parse(last.ts);
	const found = findNewestArtifactMd(ctx.cwd, last.stage, stoppedAtMs);
	if (!found) {
		ctx.ui.notify(`rpiv-wfex: no fresh artifact for interrupted stage '${last.stage}' newer than ${last.ts} — cold re-running it.`, "warning");
		await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		return;
	}

	const advanceLabel = `Advance — credit ${found.rel}`;
	const rerunLabel = `Re-run '${last.stage}' instead`;
	const choice = await ctx.ui.select(
		`@${runId}: stage '${last.stage}' is ${last.status}. Fresh stage artifact: ${found.rel} (modified ${new Date(found.mtimeMs).toLocaleString()}). Mark '${last.stage}' completed with it and advance to the next stage?`,
		[advanceLabel, rerunLabel, "Cancel"],
	);

	if (!choice || choice === "Cancel") {
		ctx.ui.notify("rpiv-wfex: continue cancelled.", "info");
		return;
	}
	if (choice === rerunLabel) {
		await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		return;
	}

	let data: Record<string, unknown>;
	try {
		data = parseFrontmatter(readFileSync(found.abs, "utf8"));
	} catch {
		ctx.ui.notify(`rpiv-wfex: artifact ${found.rel} disappeared or became unreadable — cold re-running '${last.stage}'.`, "warning");
		await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
		return;
	}
	const row = buildCompletedRow(last, found.rel, data, runId);
	if (!rt.appendStage(ctx.cwd, runId, row)) {
		ctx.ui.notify(`rpiv-wfex: failed to write the completed row for '${last.stage}' — trail not modified.`, "error");
		return;
	}
	ctx.ui.notify(`rpiv-wfex: marked '${last.stage}' completed (${found.rel}); advancing.`, "info");
	await rt.resumeWorkflowByRunId(ctx, runId, { host: pi });
}
