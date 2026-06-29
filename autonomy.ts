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
import { getAutoMode, isRunActive, type AutoMode } from "./state.js";

export const AUTONOMY_DIRECTIVE = [
	"## rpiv-wfex autonomy mode (active workflow run)",
	"",
	"A multi-stage workflow run is in progress and must walk to completion without human babysitting.",
	"Auto-answer ONLY a ROTE CONFIRMATION whose prompt is purely a yes / continue gate — its text",
	'matches one of: "confirm slice", "approve work", "approve commit", "proceed?", "ready to proceed",',
	'"continue?". For these, do NOT wait: auto-select the option marked Recommended; if none is marked,',
	"pick the most complete / highest-coverage option (the one that does more work). Then continue.",
	"",
	"For rote confirmations, ALWAYS prefer the more-complete option even when it is more work. Do not",
	"downscope to save effort.",
	"",
	"PAUSE and ask the user for ANY question that carries a real decision, even mid-run — these are NOT",
	"rote and must reach a human:",
	"- Triage of review / audit findings (apply vs. dismiss vs. defer).",
	"- Selecting an approach, architecture, or decomposition.",
	"- Resolving an ambiguous or underspecified requirement.",
	"- Anything whose options carry real trade-offs, or anything not in the rote-confirmation list above.",
	"When unsure whether a question is rote or substantive, treat it as SUBSTANTIVE and ask.",
	"",
	"EXEMPTION — genuine safety stops ALSO always halt and ask (never auto-proceed):",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop).",
	'- Any step explicitly labelled a safety "Stop" / "do not proceed" for data-loss, destructive, or',
	"  irreversible reasons."
].join("\n");

/** Shared decision policy for safe + unattended: Recommended unless strictly-better-no-drawback, respect deferral. */
const DECISION_HEURISTIC = [
	"Decision heuristic:",
	"- Default to the option marked Recommended.",
	"- Override to a more-complete option ONLY when it is strictly additive (more features, NO",
	"  drawback) AND its extra scope is NOT deferred to a later unit/stage. If the extra scope",
	"  belongs to a later unit/stage, pick Recommended instead — do not pull deferred work forward.",
	"- If no option is marked Recommended, pick the one that does the most work without deferring scope.",
	"For each auto-decision, log ONE line: the question, the option picked, and the one-line reason.",
].join("\n");

/** #1 safe-auto: auto-answer rote + substantive decisions; genuine safety stops STILL halt. */
export const SAFE_AUTO_DIRECTIVE = [
	"## rpiv-wfex autonomy mode — SAFE AUTO (active workflow run)",
	"",
	"A multi-stage workflow run is in progress in SAFE-AUTO mode: walk it to completion without human",
	"babysitting, auto-answering decisions too — but genuine safety stops still halt.",
	"",
	"Auto-answer BOTH rote confirmations (confirm slice / approve work / approve commit / proceed? /",
	"ready to proceed / continue?) AND substantive decisions (triage apply-vs-dismiss-vs-defer;",
	"choosing an approach, architecture, or decomposition; resolving an ambiguous requirement). Do",
	"NOT wait.",
	"",
	DECISION_HEURISTIC,
	"",
	"EXEMPTION — genuine safety stops STILL always halt and ask (never auto-proceed), even in safe-auto:",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop).",
	'- Any step explicitly labelled a safety "Stop" / "do not proceed" for data-loss, destructive, or',
	"  irreversible reasons.",
].join("\n");

/** #2 unattended-auto: auto-answer EVERYTHING except the plan/working-tree mismatch (D2 carve-out). */
export const UNATTENDED_AUTO_DIRECTIVE = [
	"## rpiv-wfex autonomy mode — UNATTENDED AUTO (active workflow run)",
	"",
	"A multi-stage workflow run is in progress in UNATTENDED-AUTO mode: maximum autonomy. Auto-answer",
	"EVERYTHING — rote confirmations, substantive decisions, AND safety stops — using the heuristic",
	"below. Do NOT wait for a human.",
	"",
	DECISION_HEURISTIC,
	"",
	"CARVE-OUT — exactly ONE stop still halts and asks (never auto-proceed), even unattended:",
	"- A plan vs. working-tree mismatch detected before implementing (the implement safety stop):",
	"  applying a plan against a dirty/unexpected tree is irreversible. HALT and ask on this one.",
	'All other steps — including destructive/irreversible "Stop" steps — auto-proceed in unattended mode.',
].join("\n");

/** Select the directive text for the current full-auto tier. */
function directiveFor(mode: AutoMode): string {
	if (mode === "safe") return SAFE_AUTO_DIRECTIVE;
	if (mode === "unattended") return UNATTENDED_AUTO_DIRECTIVE;
	return AUTONOMY_DIRECTIVE; // off — today's rote-confirmation-only behavior
}

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
		return { systemPrompt: `${event.systemPrompt}\n\n${directiveFor(getAutoMode())}` };
	});
}
