---
date: 2026-06-25T16:10:53+0300
author: Flex
commit: no-commit
branch: no-branch
repository: unknown
topic: "Autonomous + resilient + resumable rpiv-workflow via a non-invasive sidecar extension"
tags: [plan, rpiv-wfex, rpiv-workflow, pi-extensions, autonomy, resilience, resume, sidecar]
status: ready
parent: ".rpiv/artifacts/designs/2026-06-25_11-03-01_autonomous-resilient-workflow-sidecar.md"
phase_count: 5
phases:
  - { n: 1, title: Foundation (package.json + state.ts) }
  - { n: 2, title: Autonomy (autonomy.ts) }
  - { n: 3, title: Resume commands (commands.ts) }
  - { n: 4, title: Watchdog (watchdog.ts) }
  - { n: 5, title: Wiring + docs (extension.ts + README.md) }
last_updated: 2026-06-25T16:10:53+0300
last_updated_by: Flex
---

# rpiv-wfex — Autonomy + Resilience Sidecar Implementation Plan

## Overview

Build `rpiv-wfex`, a standalone additive Pi extension that makes `@juicesharp/rpiv-workflow`
runs autonomous and crash-resilient **without touching rpiv-workflow or rpiv-pi**. It reuses the
existing engine through its public API + Pi hooks (the same shape as the in-tree
`rpiv-core/model-override.ts` sidecar). Autonomy comes from a `before_agent_start` system-prompt
directive gated to active runs; resilience from a `session_start` watchdog that auto-resumes runs
orphaned by the `waitForIdle` freeze; resume UX from `/wfex resume` and `/wfex runs`. The original
`/wf` stays the runtime — nothing is forked, disabled, or re-merged.

See design: `.rpiv/artifacts/designs/2026-06-25_11-03-01_autonomous-resilient-workflow-sidecar.md`.

## Desired End State

```ts
// 1. Autonomy — run a workflow; mechanical gates auto-resolve, the run walks unattended.
//    /wf ship "add feature X"
//    (no "confirm slice / approve commit" prompts; the 1 safety stop still halts.)

// 2. Resilience — Pi disposes the session mid-stage (model limit / auto-compaction).
//    On the next session_start the watchdog detects the orphaned run and auto-queues:
//      /wfex resume @2026-06-25_07-30-00-ab12
//    the run continues from the last completed stage — no manual action.

// 3. Resume UX — manual control when wanted:
//    /wfex runs            → lists runs with status (resumable ones flagged)
//    /wfex resume          → resumes the newest resumable run
//    /wfex resume @<ref>   → resumes a specific run by name or run-id
```

The package contains seven files: `package.json`, `state.ts`, `autonomy.ts`, `commands.ts`,
`watchdog.ts`, `extension.ts`, `README.md`. It loads under Pi via jiti (no build step), registers
`/wfex` plus the `before_agent_start` and `session_start` hooks, and degrades silently when the
rpiv-workflow sibling is absent.

## What We're NOT Doing

- **No engine/skill edits** — rpiv-workflow and rpiv-pi are untouched (the whole point).
- **No `waitForIdle` timeout in the engine** — the watchdog rescues disposal externally; forking
  the engine to add an abort signal is the rejected alternative.
- **No `models.json` file shipped** — model pinning is config-only and user-owned; documented in
  README, not authored here.
- **No `tool_call` block fallback** — directive-only autonomy; add later only if a gate measurably
  resists the directive.
- **No disabling / re-registering `/wf`** — the original stays the runtime; `/wfex` is the only new
  namespace, so no command collision.
- **No model-override lifecycle in this sidecar** — rpiv-core already owns it globally
  (double-registration trap).

---

## Phase 1: Foundation (package.json + state.ts)

### Overview
The foundation every other module imports: the sidecar manifest and the shared run-state slot
anchored on a `globalThis` `Symbol.for` so it survives Pi session replacement within the process.

### Changes Required:

#### 1. Sidecar manifest
**File**: `package.json`
**Changes**: Sidecar manifest — `pi.extensions: ["./extension.ts"]`, rpiv-workflow + pi-coding-agent
peers, and the upstream alignment pin (`upstreamBase`, `upstreamCommit`). No build tooling — Pi loads
`.ts` untranspiled via jiti.

```json
{
	"name": "@flex/rpiv-wfex",
	"version": "0.1.0",
	"description": "Autonomy + resilience sidecar for @juicesharp/rpiv-workflow. Auto-answers mechanical workflow gates, auto-resumes runs orphaned by session disposal, and adds /wfex resume + /wfex runs. Touches neither rpiv-workflow nor rpiv-pi.",
	"keywords": ["pi-package", "pi-extension", "rpiv", "workflow", "autonomy", "resilience", "resume", "sidecar"],
	"license": "MIT",
	"author": "Flex",
	"type": "module",
	"files": ["extension.ts", "state.ts", "autonomy.ts", "commands.ts", "watchdog.ts", "README.md"],
	"pi": {
		"extensions": ["./extension.ts"]
	},
	"peerDependencies": {
		"@earendil-works/pi-coding-agent": "*",
		"@juicesharp/rpiv-workflow": "*"
	},
	"rpiv": {
		"upstreamBase": "1.20.0",
		"upstreamCommit": "faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85"
	}
}
```

#### 2. Shared run-state slot
**File**: `state.ts`
**Changes**: Global `Symbol.for` run-state slot — active run, the "resuming" re-entrancy guard, and
per-run resume-attempt counts. Mirrors rpiv-workflow's `globalSlot` (copied, not imported — that
helper is package-private).

```ts
/**
 * rpiv-wfex shared run-state — anchored on a globalThis Symbol.for slot so it
 * survives Pi session replacement within the same process (the autonomy hook,
 * the watchdog lifecycle listener, and the /wfex commands all read/write it
 * across separate extension instances). Mirrors rpiv-workflow's `globalSlot`
 * (internal-utils.ts) — copied here rather than imported because that helper is
 * package-private (not in rpiv-workflow's public exports).
 */

/** Max times the watchdog auto-fires resume for one runId before giving up. */
export const MAX_RESUME_ATTEMPTS = 3;

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
```

### Success Criteria:

#### Automated Verification:
- [x] package.json is valid JSON: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`
- [x] pi.extensions entry present: `grep -q '"./extension.ts"' package.json`
- [x] upstream commit pin recorded: `grep -q 'faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85' package.json`
- [x] state slot is Symbol.for-anchored: `grep -q 'Symbol.for("@flex/rpiv-wfex:state")' state.ts`
- [x] foundation API surface present: `grep -c '^export function' state.ts` returns >= 9 (got 11)

#### Manual Verification:
- [ ] Run-state survives a Pi session replacement (re-verified end-to-end in the Watchdog slice).

---

## Phase 2: Autonomy (autonomy.ts)

### Overview
`registerAutonomy(pi)` — the `before_agent_start` handler that appends the autonomy directive to the
system prompt when a workflow run is active, exempting the safety stop. Depends only on Phase 1;
independent of Phase 3 (parallelizable).

### Changes Required:

#### 1. Autonomy directive + registrar
**File**: `autonomy.ts`
**Changes**: `before_agent_start` directive injection gated to active runs via the shared state slot;
exempts the one true safety stop.

```ts
/**
 * rpiv-wfex autonomy — suppress the mechanical human-confirmation gates that
 * live in rpiv-pi skill bodies (confirm slice / approve work / approve commit)
 * by injecting a high-priority system-prompt directive while a workflow run is
 * active. Gates are Markdown instructions the model chooses to follow, so a
 * before_agent_start directive overrides them at prompt priority (research:
 * "autonomy is a prompt-priority problem, not a code problem"). Gated to active
 * runs via the shared state slot so normal chat is untouched.
 *
 * Directive-only by decision (D3): tool_call can block but not answer, so it is
 * not used here. The one true safety stop (implement plan/working-tree mismatch)
 * is explicitly exempted (D4).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRunActive } from "./state.js";

export const AUTONOMY_DIRECTIVE = [
	"## rpiv-wfex autonomy mode (active workflow run)",
	"",
	"A multi-stage workflow run is in progress and must walk to completion without human babysitting.",
	'When a skill step would call `ask_user_question` for a MECHANICAL checkpoint — e.g. "confirm slice",',
	'"approve work", "approve commit", "proceed?", "approve decomposition", "ready to proceed", applied/',
	"deferred/dismissed triage — do NOT wait for the user. Auto-select the option marked Recommended; if",
	"none is marked, pick the most complete / highest-coverage option (the one that does more work). Then",
	"continue immediately.",
	"",
	"ALWAYS prefer the more-complete option even when it is more work. Do not downscope to save effort.",
	"",
	"EXEMPTION — genuine safety stops still halt and ask the user:",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop).",
	'- Any step explicitly labelled a safety "Stop" / "do not proceed" for data-loss, destructive, or',
	"  irreversible reasons.",
	"For these, surface the stop and wait for an explicit human decision — never auto-proceed.",
].join("\n");

/**
 * Register the before_agent_start autonomy directive. No-op per turn unless a
 * workflow run is active (the state slot is set by the watchdog lifecycle at
 * onWorkflowStart and cleared at onWorkflowEnd), so normal chat turns are
 * never modified. Returns the chained system prompt per the before_agent_start
 * contract (docs/extensions.md) — appends to `event.systemPrompt`, which already
 * carries earlier handlers' changes, so this composes safely with other
 * extensions.
 */
export function registerAutonomy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (!isRunActive()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${AUTONOMY_DIRECTIVE}` };
	});
}
```

### Success Criteria:

#### Automated Verification:
- [x] directive gated on active run: `grep -q 'isRunActive()' autonomy.ts`
- [x] directive injected via systemPrompt return: `grep -q 'systemPrompt' autonomy.ts`
- [x] safety-stop exemption present: `grep -qi 'EXEMPTION' autonomy.ts`
- [x] registrar exported: `grep -q 'export function registerAutonomy' autonomy.ts`
- [x] no tool_call / setModel in the autonomy path (D3, observation-only): `! grep -qE 'tool_call|setModel' autonomy.ts` — note: `tool_call` appears only in JSDoc comment explaining why it's NOT used; no actual tool_call or setModel in code

#### Manual Verification:
- [ ] During a `/wf` run, mechanical gates auto-resolve (no pause) and the directive text appears in the stage session's system prompt.
- [ ] In normal chat (no active run), the directive is absent and `ask_user_question` still works.
- [ ] The implement plan/working-tree-mismatch safety stop still halts and asks (exemption holds).

---

## Phase 3: Resume commands (commands.ts)

### Overview
`registerWfexCommands(pi)` — `/wfex resume` (auto-pick newest resumable or explicit `@ref`) and
`/wfex runs` (lister), built on `listRuns`/`readLastStage`/`resumeWorkflowByRunId`. Depends only on
Phase 1; independent of Phase 2 (parallelizable). Phase 4 depends on this phase.

### Changes Required:

#### 1. `/wfex resume` + `/wfex runs`
**File**: `commands.ts`
**Changes**: Thin wrappers over the rpiv-workflow public API — reuse `resumeWorkflowByRunId` rather
than re-implementing resume; lazy + `isModuleNotFound`-guarded runtime import; release the watchdog
guard on every exit path.

```ts
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
```

### Success Criteria:

#### Automated Verification:
- [x] `/wfex` registered, `/wf` is NOT: `grep -q 'registerCommand("wfex"' commands.ts && ! grep -q 'registerCommand("wf"' commands.ts`
- [x] resume reuses the engine API (no re-implementation): `grep -q 'resumeWorkflowByRunId' commands.ts`
- [x] uses public readers for the picker: `grep -q 'listRuns' commands.ts && grep -q 'readLastStage' commands.ts`
- [x] dynamic import guarded: `grep -q 'isModuleNotFound' commands.ts`
- [x] watchdog guard released for the resumed ref: `grep -q 'clearResuming(ref)' commands.ts`

#### Manual Verification:
- [ ] `/wfex runs` lists runs with last-stage status and flags resumable ones.
- [ ] `/wfex resume` (no ref) resumes the newest resumable run; `/wfex resume @<ref>` resumes a specific run.
- [ ] A run frozen by the `waitForIdle` disposal resumes from its last completed stage.
- [ ] When the runtime barrel is missing, `/wfex resume @<id>` notifies and still clears the resume guard (no wedge).

---

## Phase 4: Watchdog (watchdog.ts)

### Overview
`registerWatchdog(pi)` — observation-only `registerLifecycle` to track the in-flight runId in state,
plus a `session_start` handler that detects an orphaned run and auto-fires resume via
`sendUserMessage`, guarded by the resuming flag + per-run cap. Depends on Phase 1 and Phase 3 (it
triggers `/wfex resume`, which Phase 3 registers).

### Changes Required:

#### 1. Lifecycle tracking + session_start auto-resume
**File**: `watchdog.ts`
**Changes**: OBSERVATION half (`registerLifecycle`, never mutates model) + RESCUE half
(`session_start` orphan detection with idle debounce, epoch supersession, re-entrancy guard, and
per-run cap; resume routed through the `/wfex resume` command via `sendUserMessage`).

```ts
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
	markResuming,
	MAX_RESUME_ATTEMPTS,
	setActiveRun,
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
```

### Success Criteria:

#### Automated Verification:
- [x] observation-only, no model mutation (D1 / double-registration trap): `! grep -qE 'setModel|setThinkingLevel' watchdog.ts`
- [x] uses the lightweight /startup lifecycle entry: `grep -q '@juicesharp/rpiv-workflow/startup' watchdog.ts`
- [x] resume routed through the command: `grep -q 'sendUserMessage(' watchdog.ts && grep -q '/wfex resume @' watchdog.ts`
- [x] re-entrancy guard + per-run cap: `grep -q 'markResuming' watchdog.ts && grep -q 'MAX_RESUME_ATTEMPTS' watchdog.ts`
- [x] idle-gated + epoch-superseded (no stale-ctx action): `grep -q 'isIdle()' watchdog.ts && grep -q 'currentEpoch()' watchdog.ts`
- [x] dynamic import guarded (sibling-absent degrades): `grep -q 'isModuleNotFound' watchdog.ts`
- [x] registrar exported: `grep -q 'export function registerWatchdog' watchdog.ts`

#### Manual Verification:
- [ ] A run frozen by session disposal auto-resumes after the ~8s debounce and continues from its last completed stage.
- [ ] A healthy multi-stage run does NOT trigger a spurious resume between stages (agent busy at the debounce check).
- [ ] After `MAX_RESUME_ATTEMPTS` re-freezes, the watchdog notifies for manual resume and stops re-firing.
- [ ] The lifecycle listener never changes the model (rpiv-core's override still owns model selection during the run).

---

## Phase 5: Wiring + docs (extension.ts + README.md)

### Overview
Thin default export wiring the three registrars (rpiv-core/index.ts table-of-contents shape) plus
the README. Depends on Phases 2, 3, 4.

### Changes Required:

#### 1. Extension entry
**File**: `extension.ts`
**Changes**: Thin default export wiring the three per-concern registrars. Adds zero engine edits.

```ts
/**
 * rpiv-wfex — autonomy + resilience sidecar for @juicesharp/rpiv-workflow.
 *
 * Thin table-of-contents entry (rpiv-core/index.ts shape): wires the three
 * per-concern registrars. Adds ZERO engine edits — it reuses the rpiv-workflow
 * engine via its public API + Pi hooks, so the original /wf stays the runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutonomy } from "./autonomy.js";
import { registerWfexCommands } from "./commands.js";
import { registerWatchdog } from "./watchdog.js";

export default function (pi: ExtensionAPI): void {
	registerWfexCommands(pi); // /wfex resume + /wfex runs (registered first — watchdog triggers it)
	registerAutonomy(pi); // before_agent_start autonomy directive (active runs only)
	registerWatchdog(pi); // session_start orphan auto-resume + lifecycle run-tracking
}
```

#### 2. README
**File**: `README.md`
**Changes**: Install, upstream pin/alignment, what the sidecar does, and the models.json pointer.

```markdown
# rpiv-wfex — autonomy + resilience sidecar for rpiv-workflow

`rpiv-wfex` makes [`@juicesharp/rpiv-workflow`](https://www.npmjs.com/package/@juicesharp/rpiv-workflow)
runs **autonomous** and **crash-resilient** — without editing rpiv-workflow or rpiv-pi. It is an
additive Pi extension that reuses the existing engine through its public API + Pi hooks (the same
shape as rpiv-pi's in-tree `rpiv-core/model-override.ts` sidecar). The original `/wf` stays the
runtime; this package only adds `/wfex …` commands and three hooks.

## What it does

1. **Autonomy** — a `before_agent_start` directive (active runs only) tells the model to
   auto-select the Recommended / most-complete option on the mechanical confirmation gates that
   live in rpiv-pi skill bodies (confirm slice / approve work / approve commit / proceed?). The one
   true safety stop (the `implement` plan vs. working-tree mismatch) is **exempted** and still halts.
2. **Resilience** — a `session_start` watchdog detects runs orphaned by the continue-policy
   `waitForIdle` freeze (when Pi disposes the session mid-stage and the engine's await never
   resolves) and auto-resumes them.
3. **Resume UX** — `/wfex resume` and `/wfex runs`.

## Commands

| Command | Effect |
|---|---|
| `/wfex resume` | Resume the newest resumable run (auto-picked). |
| `/wfex resume @<ref>` | Resume a specific run by name or run-id. |
| `/wfex runs` | List runs with last-stage status; resumable ones flagged. |

## Install

This package ships raw `.ts` — Pi loads it via jiti, no build step. Add it to your Pi packages
alongside `@juicesharp/rpiv-workflow` (a peer). It self-registers on load.

## Model selection (config-only, not shipped here)

Pin the strongest model + `xhigh` thinking for `blueprint`/`design` + judges in
`~/.config/rpiv-pi/models.json` (consumed by rpiv-core's existing lifecycle — no code in this
package). Example:

```json
{
  "stages": { "blueprint": { "model": "<best-model>", "thinking": "xhigh" }, "design": { "model": "<best-model>", "thinking": "xhigh" } },
  "skills": { "judge": { "model": "<best-model>", "thinking": "xhigh" } }
}
```

## Caveats

- **Watchdog is best-effort.** It relies on `session_start` firing after a disposal and on an
  idle-debounce heuristic; if the signal doesn't arrive, fall back to `/wfex resume`.
- **Cold re-run on resume.** A frozen stage wrote no final row, so resume re-runs it cold. Verify
  side-effect stages (esp. `commit`) are idempotent before trusting unattended overnight runs. A
  per-run auto-resume attempt cap (3) bounds the blast radius.

## Upstream alignment

Built against `@juicesharp/rpiv-workflow` **v1.20.0**, commit
`faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`. On an upstream bump, re-verify the public API used:
`resumeWorkflowByRunId`, `listRuns`, `readLastStage`, `registerLifecycle`, and the
`before_agent_start` / `session_start` event shapes. Pin recorded in `package.json` under `rpiv`.
```

### Success Criteria:

#### Automated Verification:
- [x] default export wires all three registrars: `grep -q 'registerWfexCommands(pi)' extension.ts && grep -q 'registerAutonomy(pi)' extension.ts && grep -q 'registerWatchdog(pi)' extension.ts`
- [x] all seven package files exist: `for f in package.json state.ts autonomy.ts commands.ts watchdog.ts extension.ts README.md; do test -f "$f" || echo "MISSING $f"; done` prints nothing
- [x] pi.extensions entry now resolves: `test -f extension.ts && grep -q '"./extension.ts"' package.json`
- [x] no engine edits / no /wf re-registration: `! grep -rq 'registerCommand("wf"' *.ts`
- [x] README records the upstream pin: `grep -q 'faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85' README.md`

#### Manual Verification:
- [ ] Loading the package under Pi registers `/wfex` and the before_agent_start + session_start hooks with no error (jiti smoke).
- [ ] `/wf <workflow> "<desc>"` runs autonomously end-to-end; `/wfex runs` lists it; killing the session mid-stage triggers watchdog auto-resume.

---

## Testing Strategy

### Automated:
- Structural greps per phase Success Criteria (no `tsc --noEmit` gate — Pi loads `.ts` untranspiled
  via jiti; no local `node_modules`, peer types resolve from the global pi install at runtime).
- `package.json` JSON validity check.

### Manual Testing Steps:
1. Load the package under Pi; confirm `/wfex` and the `before_agent_start` + `session_start` hooks
   register with no error (jiti smoke).
2. Run `/wf <workflow> "<desc>"` end-to-end; confirm mechanical gates auto-resolve (no pause) and
   the autonomy directive text appears in stage session system prompts; confirm normal chat is
   unaffected and `ask_user_question` still works there.
3. Confirm the implement plan/working-tree-mismatch safety stop still halts and asks.
4. Kill the session mid-stage; confirm the watchdog detects the orphan after the ~8s debounce and
   auto-resumes from the last completed stage; confirm a healthy multi-stage run does NOT trigger a
   spurious resume; confirm after `MAX_RESUME_ATTEMPTS` re-freezes it notifies for manual resume.
5. Confirm `/wfex runs` lists runs with last-stage status and flags resumable ones; `/wfex resume`
   (no ref) resumes the newest resumable run; `/wfex resume @<ref>` resumes a specific run.
6. Verify the `commit` skill / `gitCommitCollector` is idempotent on a no-op tree (cold-resume
   safety for unattended overnight runs).

## Performance Considerations

- `before_agent_start` runs per turn; the directive build is a string concat gated by one boolean
  read — negligible.
- `/wfex runs` and the resume picker do header-only reads (`listRuns` reads line 1 of each JSONL;
  `readLastStage` reads one file) — O(runs) small reads, sized for inspect UIs.
- The watchdog does no work unless a run is in-flight at `session_start` (one boolean read otherwise).

## Migration Notes

Not applicable — additive new package, no schema or data migration. The shared trail dir
`<cwd>/.rpiv/workflows/runs/` is reused (runIds are unique); nothing is rewritten. Rollback =
remove the extension; the original `/wf` is unaffected.

## Developer Context

_Empty at skeleton write; Step 4.4 fallback notes and any post-write developer interactions land here._

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 3 §1 (commands.ts) | rpiv-workflow index.ts:86 | blocker | codebase-fit | Reviewer (grounded on artifacts, not live source) claimed `rt.resumeWorkflowByRunId` is undefined because the documented barrel list omits it. | Import from a subpath, or confirm the main barrel re-exports it. | dismissed: falsified by live evidence — installed `@juicesharp/rpiv-workflow/index.ts:86` exports `resumeWorkflowByRunId` as a value; `rt.resumeWorkflowByRunId` resolves. Reviewer trusted an incomplete artifact barrel list. |
| code | Phase 3 §1 (commands.ts) | rpiv-workflow registration.ts:83,201,213 | concern | codebase-fit | `import type { RunSummary, WorkflowHostContext, WorkflowStage } from "@juicesharp/rpiv-workflow"` claimed wrong because the documented barrel omits these types. | Import from declaring subpaths or verify barrel re-export. | dismissed: falsified — `index.ts` does `export * from "./registration.js"`, and registration.ts re-exports WorkflowHostContext (:83), RunSummary (:201), WorkflowStage (:213). All three type imports resolve from the main barrel. |
| code | Phase 4 §1 (watchdog.ts) | <n/a> | concern | code-quality | On the `sendUserMessage` rejection path the `.catch` notifies but never calls `clearResuming(runId)`; since the resume command never ran, its `finally` guard release never fires, so `resumingRunId` stays set and every future `session_start` short-circuits at `isResuming(runId)` — the run is permanently un-rescued. | Add `clearResuming(runId)` inside the `sendUserMessage(...).catch(...)`. | applied (plan-local; design follow-up: .rpiv/artifacts/designs/2026-06-25_11-03-01_autonomous-resilient-workflow-sidecar.md): added `clearResuming(runId)` in the Phase 4 `.catch` so a failed queue can't wedge the re-entrancy guard. |

_Coverage reviewer: no findings — all `## What We're NOT Doing` constraints and `## Performance Considerations` notes land in a phase's Success Criteria or a visible code mirror._

## References

- Design: `.rpiv/artifacts/designs/2026-06-25_11-03-01_autonomous-resilient-workflow-sidecar.md`
- Research: `.rpiv/artifacts/research/2026-06-25_10-42-04_autonomous-resilient-workflow-sidecar.md`
- Upstream: `@juicesharp/rpiv-workflow` v1.20.0, commit `faa0f9dcbe75d22e24e4a27b79ab1bfb15f38f85`
- Template: `@juicesharp/rpiv-pi/extensions/rpiv-core/model-override.ts`
- Pi hooks: `@earendil-works/pi-coding-agent/docs/extensions.md`
