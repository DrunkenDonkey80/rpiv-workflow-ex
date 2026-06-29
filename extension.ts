/**
 * rpiv-wfex — autonomy + resilience sidecar for @juicesharp/rpiv-workflow.
 *
 * Thin table-of-contents entry (rpiv-core/index.ts shape): wires the four
 * per-concern registrars. Adds ZERO engine edits — it reuses the rpiv-workflow
 * engine via its public API + Pi hooks, so the original /wf stays the runtime.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutonomy } from "./autonomy.js";
import { registerWfexCommands } from "./commands.js";
import { registerRateLimitRetry } from "./ratelimit.js";
import { registerWatchdog } from "./watchdog.js";

export default function (pi: ExtensionAPI): void {
	registerWfexCommands(pi); // /wfex resume + /wfex runs (registered first — watchdog + ratelimit trigger it)
	registerAutonomy(pi); // before_agent_start autonomy directive (active runs only)
	registerWatchdog(pi); // session_start orphan auto-resume + lifecycle run-tracking
	registerRateLimitRetry(pi); // after_provider_response 429 retry-until-reset loop
}
