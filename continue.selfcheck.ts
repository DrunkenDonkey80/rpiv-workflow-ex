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
import { buildCompletedRow, parseFrontmatter } from "./continue.js";

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

console.log("continue.selfcheck: OK");
