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
