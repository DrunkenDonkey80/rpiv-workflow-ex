/**
 * rpiv-wfex continue self-check — `npx jiti continue.selfcheck.ts`.
 *
 * Guards the two pieces most likely to silently break: the frontmatter parse,
 * and (critically) that buildCompletedRow emits a row the engine's STRICT
 * resume reader accepts — a malformed row makes resume refuse the whole run.
 * The guard predicates below are copied verbatim from rpiv-workflow's
 * state/reads.ts (isWorkflowStage + hasValidSessionRef) so this fails loudly if
 * buildCompletedRow ever drifts from that shape. No framework — assert only.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompletedRow, continueCmd, findNewestArtifactMd, parseFrontmatter, shouldOfferContinue } from "./continue.js";
import { shouldFullAutoCredit } from "./commands.js";

// --- frontmatter: quoted scalar with colons/commas, arrays, blanks ---
const fm = parseFrontmatter(
	['---', 'topic: "A: b, c"', "tags: [x, y, z]", "author: Flex", "blank:", "---", "# body"].join("\n"),
);
assert.equal(fm.topic, "A: b, c", "quoted scalar must keep inner punctuation");
assert.deepEqual(fm.tags, ["x", "y", "z"], "array must split + unquote");
assert.equal(fm.author, "Flex");
assert.equal(fm.blank, "");
assert.deepEqual(parseFrontmatter("no frontmatter here"), {}, "missing block → {}");

// --- buildCompletedRow must satisfy the engine's strict resume reader ---
const STAGE_STATUSES = new Set(["completed", "failed", "skipped", "aborted"]);
const last = { stageNumber: 2, stage: "design", skill: "design", status: "failed", ts: "t" } as never;
const row = buildCompletedRow(last, ".rpiv/artifacts/designs/x.md", { topic: "t" }, "RID") as Record<string, unknown>;

// isWorkflowStage
assert.equal(typeof row.stageNumber, "number");
assert.equal(typeof row.stage, "string");
assert.ok(typeof row.status === "string" && STAGE_STATUSES.has(row.status as string));
assert.equal(row.status, "completed", "must be completed so resume routes onward");
assert.ok(Array.isArray((row.output as { artifacts?: unknown }).artifacts), "output.artifacts must be an array");
assert.equal(row.parent, undefined, "non-loop row carries no parent");
// hasValidSessionRef: key PRESENT, null or {id:string}
assert.ok("session" in row, "session key MUST be present");
assert.equal(row.session, null);
// artifact handle shape + path style
const art = (row.output as { artifacts: { handle: { kind: string; path: string }; role: string }[] }).artifacts[0]!;
assert.equal(art.handle.kind, "fs");
assert.equal(art.handle.path, ".rpiv/artifacts/designs/x.md");
assert.equal(art.role, "primary");

// --- artifact finder scoping: path segment, frontmatter fallback, temporal guard ---
const tmp = mkdtempSync(join(tmpdir(), "wfex-continue-"));
try {
	const artifacts = join(tmp, ".rpiv", "artifacts");
	const writeMd = (rel: string, body: string, mtime: Date): string => {
		const p = join(artifacts, ...rel.split("/"));
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, body);
		utimesSync(p, mtime, mtime);
		return p;
	};
	const failTs = Date.parse("2026-06-29T10:00:00Z");
	writeMd("plans/new.md", "---\ntopic: plan\n---\n", new Date(failTs + 60_000));
	writeMd("redesign/nope.md", "---\ntopic: other\n---\n", new Date(failTs + 120_000));
	writeMd("analyses/nope.md", "---\ntopic: other\n---\n", new Date(failTs + 180_000));
	writeMd("misc/analysis.md", "---\ntopic: analysis result\n---\n", new Date(failTs + 240_000));
	writeMd("designs/stale.md", "---\ntopic: design\n---\n", new Date(failTs - 60_000));

	assert.equal(findNewestArtifactMd(tmp, "plan", failTs)?.rel, ".rpiv/artifacts/plans/new.md", "stage matches path segment/plural only");
	assert.equal(findNewestArtifactMd(tmp, "analysis", failTs)?.rel, ".rpiv/artifacts/misc/analysis.md", "irregular plural path misses; frontmatter fallback can match");
	assert.equal(findNewestArtifactMd(tmp, "missing", failTs), undefined, "no stage match → undefined");
	assert.equal(findNewestArtifactMd(tmp, "design", failTs), undefined, "newerThanMs rejects stale artifacts");
	assert.equal(findNewestArtifactMd(tmp)?.rel, ".rpiv/artifacts/misc/analysis.md", "no stageName keeps global newest behavior");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

// --- disappearing artifact after select degrades to cold re-run ---
{
	const tmp = mkdtempSync(join(tmpdir(), "wfex-continue-race-"));
	try {
		const artifacts = join(tmp, ".rpiv", "artifacts", "plans");
		mkdirSync(artifacts, { recursive: true });
		const artifact = join(artifacts, "fresh.md");
		writeFileSync(artifact, "---\ntopic: plan\n---\n");
		const failedAt = new Date("2026-06-29T10:00:00Z");
		utimesSync(artifact, new Date(failedAt.getTime() + 60_000), new Date(failedAt.getTime() + 60_000));
		let resumed = 0;
		let appended = 0;
		const rt = {
			readLastStage: () => ({ stageNumber: 1, stage: "plan", status: "failed", ts: failedAt.toISOString() }),
			resumeWorkflowByRunId: async () => { resumed++; return { success: true, runId: "RID" }; },
			appendStage: () => { appended++; return true; },
		} as never;
		const ctx = {
			cwd: tmp,
			ui: {
				notify: () => {},
				select: async (_msg: string, opts: string[]) => { rmSync(artifact); return opts[0]; },
			},
		} as never;
		await continueCmd({} as never, ctx, rt, "RID");
		assert.equal(resumed, 1, "disappearing selected artifact cold-reruns");
		assert.equal(appended, 0, "disappearing selected artifact does not append a credit row");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// --- full-auto credit predicate ---
const failed = { stageNumber: 1, stage: "plan", status: "failed", ts: "2026-06-29T10:00:00Z" } as never;
const aborted = { stageNumber: 1, stage: "plan", status: "aborted", ts: "2026-06-29T10:00:00Z" } as never;
const completed = { stageNumber: 1, stage: "plan", status: "completed", ts: "2026-06-29T10:00:00Z" } as never;
const skipped = { stageNumber: 1, stage: "plan", status: "skipped", ts: "2026-06-29T10:00:00Z" } as never;
const child = { stageNumber: 1, stage: "plan", status: "failed", ts: "2026-06-29T10:00:00Z", parent: "loop" } as never;
const badTs = { stageNumber: 1, stage: "plan", status: "failed", ts: "not-a-date" } as never;
assert.equal(shouldOfferContinue(failed), true, "manual continue accepts top-level failed + parseable ts");
assert.equal(shouldOfferContinue(aborted), true, "manual continue accepts top-level aborted + parseable ts");
assert.equal(shouldOfferContinue(completed), false, "manual continue rejects completed rows");
assert.equal(shouldOfferContinue(child), false, "manual continue rejects mid-loop rows");
assert.equal(shouldOfferContinue(skipped), false, "manual continue rejects skipped rows");
assert.equal(shouldOfferContinue(badTs), false, "manual continue rejects unparseable ts");
assert.equal(shouldFullAutoCredit(failed, "safe"), true, "safe + top-level failed + parseable ts credits");
assert.equal(shouldFullAutoCredit(aborted, "unattended"), true, "unattended + top-level aborted + parseable ts credits");
assert.equal(shouldFullAutoCredit(failed, "off"), false, "off never auto-credits");
assert.equal(shouldFullAutoCredit(completed, "safe"), false, "completed rows do not credit");
assert.equal(shouldFullAutoCredit(child, "safe"), false, "loop child rows do not credit");
assert.equal(shouldFullAutoCredit(badTs, "safe"), false, "unparseable ts cold-reruns");

console.log("continue.selfcheck: OK");
