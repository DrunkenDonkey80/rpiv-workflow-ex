---
date: 2026-06-28T22:37:10+0300
author: Flex
commit: 35a3eca
branch: master
repository: rpiv-workflow-ex
topic: "Full-auto decision auto-confirm toggle + retry-until-usage-limit-resets, and the agent restart/partial-output model"
tags: [research, codebase, rpiv-wfex, autonomy, watchdog, rate-limit, resume, full-auto]
status: ready
last_updated: 2026-06-28T22:37:10+0300
last_updated_by: Flex
---

# Research: Full-auto decision auto-confirm toggle + retry-until-usage-limit-resets

## Research Question

Two features for the `rpiv-wfex` sidecar:

1. **Full-auto toggle** — an option to switch a run into "full auto" for when the user can't be
   around. It auto-confirms decisions and takes the best option — usually the Recommended one,
   unless another option is strictly more practical. Decision shapes the user sees:
   - `1. build x (recommended); 2. build y but worse; 3. build z also bad` → pick **1**.
   - `1. build x (recommended); 2. build x + y, more features, no drawback, just more work` → pick **2**.
   - `1. build x (recommended); 2. build x + y but y handled in a later unit` → pick **1**.
   So the heuristic must read "Recommended" PLUS relative practicality — not blindly pick option 1
   or blindly pick the most complete.
2. **5-hour usage-limit handling** — today a limit ends the run with a "limit reached" error after
   "3 tries" (game over). Make it instead keep retrying (~every 10 min) until the limit window
   resets, then continue. Secondary: what happens to in-flight agents when the limit hits — do they
   lose partial output and need a cold restart, or can partial data be reused?

## Summary

- **The "3 tries" is NOT the sidecar.** The user's pasted error — `Retry failed after 3 attempts:
  429 {"type":"rate_limit_error", ...}` — is **Pi's own provider-level auto-retry** exhausting
  (`auto_retry_start` / `auto_retry_end`, governed by the `retry.provider` setting), not the
  sidecar's `MAX_RESUME_ATTEMPTS=3` (`state.ts:11`). Those are two unrelated "3"s. The sidecar's
  watchdog (`watchdog.ts:62`) keys **only on `session_start`**, which a 429 turn-failure does not
  reliably fire — so today a usage limit most likely **bypasses the watchdog entirely** and just
  dies in-chat. This is the core gap.

- **The 429 carries no reset timestamp.** The pasted error is the API-style
  `rate_limit_error` with message "Please try again later." — **no `retry-after`, no reset clock**.
  (The claude.ai *subscription* session-limit message DOES embed a reset time like "resets 7:30pm
  (Europe/Berlin)", but that is a different surface and not what fired here.) So precise
  wait-until-reset is impossible from this signal; **polling ~every 10 min until a turn succeeds is
  the correct pragmatic strategy** — exactly what the user proposed.

- **Decided design (this session):**
  - **Detection: BOTH** — tune Pi's `retry.provider` config (longer/more attempts for short blips)
    AND add a 429-observing retry loop in the sidecar (`after_provider_response`, status 429) that
    re-sends `/wfex resume @<runId>` on a 10-min interval for the hard 5-hour wall.
  - **Runaway guard: bounded wall-clock** — retry every 10 min but cap total at one usage window +
    margin (~6–12 h), then notify and stop.
  - **Full-auto: TWO stages (tri-state toggle), default off:**
    - **`#1 safe-auto`** — auto-answer the PAUSE-list decisions too (pick Recommended by default;
      override to a more-complete option ONLY when it is strictly additive, no drawback, AND not
      deferred to a later unit/stage). The genuine safety stops (`autonomy.ts:38-42`) STILL halt.
    - **`#2 unattended-auto`** — auto-pick **everything**, including the safety stops. Maximum
      autonomy, highest blast radius.

- **Partial agent output:** Pi has **no built-in sub-agents** and does **not persist in-flight tool
  output** — an aborted turn keeps only finalized tool results; partial work is lost. On plain
  resume the engine **cold re-runs** the interrupted stage. The existing `/wfex continue`
  (`continue.ts`) is the salvage path: it credits the on-disk artifact the stage already wrote via a
  synthetic `completed` row, advancing to the NEXT stage instead of redoing work. After a
  limit-reset resume, choosing resume (cold) vs continue (credit artifact) correctly is what
  determines whether partial data is reused.

## Detailed Findings

### Autonomy directive — current selection policy and its gap (autonomy.ts)
- The whole autonomy behavior is the prompt string `AUTONOMY_DIRECTIVE` (`autonomy.ts:18-46`),
  injected by a `before_agent_start` handler (`autonomy.ts:54-59`) gated on `isRunActive()`
  (`autonomy.ts:55` → `state.ts:52`). There is **no toggle** today — it injects unconditionally
  whenever a run is active.
- Current selection policy is two crude rules:
  - Rote-confirmation whitelist (`autonomy.ts:21-25`): match `"confirm slice" | "approve work" |
    "approve commit" | "proceed?" | "ready to proceed" | "continue?"` → auto-pick Recommended; if
    none, "pick the most complete / highest-coverage option (the one that does more work)."
  - `autonomy.ts:27-28`: "**ALWAYS prefer the more-complete option even when it is more work. Do
    not downscope.**"
- **The gap for feature 1:** rule `autonomy.ts:27-28` would WRONGLY pick option 2 in the user's
  third shape (`x + y, but y is deferred to a later unit`) — "more complete" ≠ "right when the extra
  scope belongs to a later stage." The refined heuristic must be: **default Recommended; override to
  a more-complete option only when it is strictly additive with no drawback AND its extra scope is
  not deferred to a later unit/stage.**
- The PAUSE list (`autonomy.ts:30-37`) explicitly routes substantive decisions to a human: triage
  (apply/dismiss/defer), approach/architecture/decomposition, ambiguous requirements, "anything
  whose options carry real trade-offs." The safety EXEMPTION (`autonomy.ts:38-42`) always halts:
  implement plan/working-tree mismatch, and any step labelled a destructive/irreversible "Stop."
- **Feature 1 directly mutates this contract.** `#1 safe-auto` lifts the PAUSE list into
  auto-answer territory (with the refined heuristic) while keeping `autonomy.ts:38-42` as hard
  halts. `#2 unattended-auto` additionally overrides `autonomy.ts:38-42`.

### Toggle threading — where a tri-state flag lives (state.ts, commands.ts, autonomy.ts)
- Run-state is a `globalThis` `Symbol.for("@flex/rpiv-wfex:state")` slot (`state.ts:25-37`) that
  survives Pi session replacement in-process. The `WfexState` interface (`state.ts:13-24`) holds
  `activeRunId`, `resumingRunId`, `resumeAttempts`. Setters/getters are siblings:
  `setActiveRun`/`getActiveRunId`/`isRunActive`/`clearActiveRun` (`state.ts:41-60`).
- A new `autoMode: "off" | "safe" | "unattended"` field added to `WfexState` (`state.ts:13-24`)
  with a `setAutoMode`/`getAutoMode` pair (beside `state.ts:41-49`) is the natural home. The
  autonomy handler reads it at `autonomy.ts:55` and branches the directive text accordingly —
  **no re-registration of the hook needed** (it reads state every turn).
- Surface it as a `/wfex` subcommand in the dispatch switch (`commands.ts:159-173`), e.g.
  `/wfex auto safe | unattended | off`. The switch already parses `tokens[0]` as the subcommand.
- **Persistence caveat:** the slot is **in-memory only** — a toggle set there is lost on process
  restart. The watchdog's auto-resume happens within the same process, so in-memory is enough for
  "set full-auto, walk away, let it run overnight" as long as Pi isn't restarted. If the toggle must
  survive restarts, persist it to a config file (the `~/.config/rpiv-pi/models.json` surface noted in
  `README.md` is the existing precedent for sidecar-adjacent config). **Open decision — see Open
  Questions.**

### The retry path the user wants to change — two different "3"s (state.ts, watchdog.ts, Pi settings)
- **Sidecar `MAX_RESUME_ATTEMPTS=3`** (`state.ts:11`): consumed in `maybeResume`
  (`watchdog.ts:81-90`). When `getResumeAttempts(runId) >= 3` the watchdog notifies and calls
  `clearActiveRun()` (`watchdog.ts:88`) to stop re-firing. Attempts accrue via `bumpResumeAttempt`
  (`state.ts:82-87`); the ONLY trigger is a fresh `session_start` landing at `watchdog.ts:62-69`,
  which schedules a single `setTimeout(maybeResume, 8000)` (`ORPHAN_DEBOUNCE_MS`, `watchdog.ts:30`).
  **There is no periodic timer anywhere** — a 10-min loop is net-new.
- **Pi provider auto-retry** (the user's actual error): Pi retries transient 429/5xx with backoff
  and emits `auto_retry_start` / `auto_retry_end` (RPC surface), capped by the `retry.provider`
  setting. When the provider's requested delay exceeds `retry.provider.maxRetryDelayMs` (e.g. a
  multi-hour quota reset) Pi **fails immediately** rather than waiting silently. The pasted
  `Retry failed after 3 attempts` is THIS mechanism exhausting — independent of `state.ts:11`.
- **Why the watchdog misses it:** `registerWatchdog`'s rescue arm fires only from `session_start`
  (`watchdog.ts:62`) and only when `ctx.isIdle()` after an 8 s debounce (`watchdog.ts:80`). A 429
  turn-failure surfaces via `after_provider_response` (status 429) and the `auto_retry_*` events —
  **not** a session disposal — so it does not produce the `session_shutdown → session_start`
  signature the watchdog keys on. The freeze the watchdog WAS built for is the un-timed
  `ctx.waitForIdle()` at the engine's `sessions/spawn.ts:69` (Pi disposes the session mid-stage). A
  rate limit is a distinct failure mode the current watchdog never observes.
- **Decided design:** add a 429-observing hook (`after_provider_response`, `event.status === 429` /
  `error.type === "rate_limit_error"`) that starts a **10-min `setInterval`** re-sending
  `/wfex resume @<runId>`; clear it on the next successful turn; **bounded by a wall-clock cap
  (~6–12 h)** then notify + stop. Also tune `retry.provider` for short blips. Pi timers are plain
  Node globals (available in the extension runtime) but **must be started from `session_start`/an
  event, never the factory**, and cleaned up — factory-started timers leak (Pi docs
  `extensions.md:219-223`).

### Resume re-entrancy + attempt-reset state machine the retry loop must not break (state.ts, watchdog.ts, commands.ts)
- `markResuming`/`isResuming`/`clearResuming` (`state.ts:62-78`) guard against the session_start
  storm `resumeWorkflowByRunId`'s own spawned sessions trigger. Set in `maybeResume`
  (`watchdog.ts:92`); released in `resumeCmd`'s `finally` (`commands.ts:108-115`) AND the lifecycle
  `onWorkflowStart` (`watchdog.ts:99-101`).
- `clearResumeAttempts` (`state.ts:97`) zeroes the counter on `onWorkflowStart`/`onWorkflowEnd`
  (`watchdog.ts:100,104`) — so a successful resume resets the 3-strike budget.
- **Implications for the 10-min loop:** (a) the loop's `sendUserMessage` re-enters via the same
  command path, so it MUST set/clear the resuming guard to avoid feedback storms; (b) the attempt
  counter should reset when the limit window resets (i.e. on a successful turn / `onWorkflowStart`),
  not on every interval tick; (c) the re-entrancy guard must **not wedge across the long sleep** —
  `commands.ts:111` already documents a queue-failure release path (`watchdog.ts:107`), reuse it.
- **`onWorkflowEnd` is the wrong terminal state for a recoverable limit:** it calls
  `clearResumeAttempts` + `clearActiveRun` (`watchdog.ts:103-107`), which would CANCEL retry intent.
  The retry loop must detect the limit signal *before* the run is treated as ended, and keep
  `activeRunId` set so resume targets remain valid.

### Agent execution + partial-output model (continue.ts, continue.selfcheck.ts, Pi docs, subagents.json)
- **Pi has no built-in sub-agents** (Pi README "No sub-agents" / `usage.md:306`). Where agents are
  spawned, they are separate processes; on parent disposal the `AbortSignal` fires and the extension
  hard-kills them (`SIGTERM`→`SIGKILL`). **In-flight tool output is NOT persisted** — only finalized
  tool results land in the session file; partial work is lost on abort.
- `.pi/subagents.json` knobs (`maxConcurrent:4`, `defaultMaxTurns:0`, `graceTurns:5`,
  `defaultJoinMode:"async"`) are the local dispatch config; async join means in-flight agents at a
  limit boundary are not cleanly drained.
- **The engine's behavior:** plain resume re-runs a `failed`/`aborted` stage **cold** (loses partial
  work — `selectResumeEntry`). `/wfex continue` salvages it: `findNewestArtifactMd`
  (`continue.ts:78-103`) locates the on-disk `.rpiv/artifacts/*.md` the interrupted agent already
  produced, `parseFrontmatter` (`continue.ts:43-67`) reads its metadata, and `buildCompletedRow`
  (`continue.ts:107-130`) synthesizes a `status:"completed"` row crediting it so
  `resumeWorkflowByRunId` advances to the NEXT stage.
- `isResumable` (`commands.ts:55-58`): `status === "failed" || "aborted" || parent !== undefined`
  classifies frozen vs mid-loop runs.
- **Answer to the user's secondary question:** in-flight agents DO lose partial output (Pi does not
  persist mid-turn work), and plain resume cold-re-runs the stage. BUT if the stage already wrote its
  artifact to `.rpiv/artifacts/` before dying, `/wfex continue` reuses that partial result instead of
  redoing it. So "reuse partial data" is achievable **only for stages that persist an artifact
  mid-flight** — anything not yet written to disk is gone and re-run cold.

### Synthetic-row schema contract (continue.ts, continue.selfcheck.ts)
- `buildCompletedRow` (`continue.ts:107-130`) emits `stageNumber`, `stage`, enum `status`,
  `output.artifacts[]`, and a **mandatory `session: null`** key. `continue.selfcheck.ts:24-44`
  copies the engine's `isWorkflowStage` + `hasValidSessionRef` predicates verbatim as a regression
  tripwire. A malformed row makes the engine's strict resume reader REFUSE the whole run (fail-safe).
- **Relevance:** if full-auto (after a limit reset) is to auto-credit partial artifacts WITHOUT the
  interactive `ctx.ui.select` prompt at `continue.ts:163-166`, the synthetic-row shape must stay
  exactly schema-coupled; `continue.selfcheck.ts` proves it still satisfies the reader.

### Extension wiring (extension.ts)
- Registrar order (`extension.ts:14-16`): `registerWfexCommands` first (watchdog triggers it), then
  `registerAutonomy`, then `registerWatchdog`. The lazy runtime barrel `loadRuntime`/`runtimeMemo`
  (`commands.ts:43-53`) with an `isModuleNotFound` graceful-degrade guard (`commands.ts:31-37`,
  mirrored at `watchdog.ts:49-55`) keeps startup light and tolerates an absent engine.
- Both new features funnel through these seams: the toggle changes `registerAutonomy`'s output; the
  retry loop adds a new hook + timer in `registerWatchdog` (or a new sibling registrar). Both depend
  on `loadRuntime` resolving `resumeWorkflowByRunId` correctly after a long limit-window sleep.

## Code References
- `autonomy.ts:18-46` — `AUTONOMY_DIRECTIVE` string (the entire selection policy)
- `autonomy.ts:21-28` — rote whitelist + "always more complete" rule (the heuristic to refine)
- `autonomy.ts:30-37` — PAUSE list (substantive decisions; lifted by `#1 safe-auto`)
- `autonomy.ts:38-42` — safety EXEMPTION (overridden only by `#2 unattended-auto`)
- `autonomy.ts:54-59` — `before_agent_start` injection, gated by `isRunActive()`
- `state.ts:11` — `MAX_RESUME_ATTEMPTS = 3` (the sidecar cap — NOT the user's error)
- `state.ts:13-24` — `WfexState` (add `autoMode` here)
- `state.ts:25-37` — `Symbol.for` global slot + `getState()`
- `state.ts:41-60` — active-run setters/getters (add `setAutoMode`/`getAutoMode` siblings)
- `state.ts:62-78` — resuming re-entrancy guard
- `state.ts:82-97` — resume-attempt counter
- `watchdog.ts:30` — `ORPHAN_DEBOUNCE_MS = 8000`
- `watchdog.ts:62-69` — `session_start` rescue trigger (the only trigger today; misses 429)
- `watchdog.ts:80-90` — `maybeResume` idle/attempt guards + 3-strike give-up
- `watchdog.ts:92-107` — resume re-entrancy mark + lifecycle `onWorkflowStart`/`onWorkflowEnd`
- `commands.ts:55-58` — `isResumable`
- `commands.ts:71-118` — `resumeCmd` (+ resuming-guard `finally`)
- `commands.ts:159-173` — `/wfex` subcommand dispatch switch (add `auto`)
- `continue.ts:78-103` — `findNewestArtifactMd` (partial-artifact salvage)
- `continue.ts:107-130` — `buildCompletedRow` (schema-coupled synthetic row)
- `continue.ts:131-200` — `continueCmd` (interactive credit-and-advance)
- `continue.selfcheck.ts:24-44` — engine strict-reader regression tripwire
- `extension.ts:14-16` — registrar wiring order
- `.pi/subagents.json` — `maxConcurrent:4`, `graceTurns:5`, `defaultJoinMode:"async"`

## Integration Points

### Inbound References (what the sidecar plugs into)
- `pi.on("before_agent_start", …)` (`autonomy.ts:54`) — autonomy directive injection.
- `pi.on("session_start", …)` (`watchdog.ts:62`) — orphan-freeze rescue.
- `pi.on("after_provider_response", …)` — **NEW** seam needed for 429 detection (Pi docs
  `extensions.md:632-640,657-658`: `event.status`, `event.headers["retry-after"]`).
- `pi.registerCommand("wfex", …)` (`commands.ts:154`) — add `/wfex auto <mode>`.
- `registerLifecycle({ onWorkflowStart, onWorkflowEnd })` (`watchdog.ts:96-108`) — active-run tracking.

### Outbound Dependencies
- `@juicesharp/rpiv-workflow` barrel → `resumeWorkflowByRunId`, `listRuns`, `readLastStage`,
  `appendStage` (`commands.ts:43-53`, `continue.ts`).
- `@juicesharp/rpiv-workflow/startup` → `registerLifecycle` (`watchdog.ts:96`).
- `pi.sendUserMessage("/wfex resume @<runId>")` (`watchdog.ts:103`) — re-entry into the engine
  (the retry loop reuses this).

### Infrastructure Wiring
- `extension.ts:14-16` — three registrars; a 429-retry registrar would be added here.
- Pi `retry.provider` setting (`maxRetryDelayMs`, attempts) — config-side tuning (decided: tune it).
- `~/.config/rpiv-pi/models.json` — existing sidecar-adjacent config precedent (candidate home if
  the toggle must persist across restarts).

## Architecture Insights
- **Autonomy is a prompt-priority problem, not code.** The toggle changes WHICH directive text is
  injected; it never re-registers the hook. Tri-state branching in `autonomy.ts` reading `autoMode`
  from state is the minimal change.
- **A rate limit and a freeze are different failure modes.** The watchdog handles the freeze
  (un-timed `waitForIdle` → session disposal). The 429 needs its OWN observer
  (`after_provider_response`) and its OWN timer (10-min poll). Don't overload the existing
  session_start path.
- **No machine-readable reset on the pasted 429.** Poll, don't schedule-to-timestamp. (If the run
  ever surfaces the claude.ai *subscription* "resets HH:MM" string instead, parsing that for a
  precise single wait is a later optimization — see Open Questions.)
- **Partial reuse hinges on artifact-on-disk.** Pi loses mid-turn work; the ONLY salvage is the
  `/wfex continue` artifact-credit path, and only for stages that wrote their artifact before dying.
- **Two-stage autonomy maps cleanly onto the existing directive structure:** `#1 safe-auto` removes
  the PAUSE-list halt (`autonomy.ts:30-37`) but keeps the safety EXEMPTION (`autonomy.ts:38-42`);
  `#2 unattended-auto` removes both. `off` is today's behavior (rote-only).

## Precedents & Lessons
3 precedents analyzed from git history.

### Precedent: initial sidecar with 3-strike watchdog + autonomy directive
**Commit(s)**: `b1164c3` — "Add rpiv-wfex autonomy + resilience sidecar for rpiv-workflow" (2026-06-25)
**Blast radius**: 12 files across state / autonomy / watchdog / commands / wiring / docs.
**Takeaway**: the `3` cap was a conservative valve to bound cold-re-run blast radius on
non-idempotent stages (esp. `commit`). Removing the hard cap for retry-until-reset trades a bounded
failure for unbounded retries — hence the decided **bounded wall-clock** guard.

### Precedent: narrowing autonomy directive after 4 hours (the key cautionary tale)
**Commit(s)**: `258b8d7` — "Narrow autonomy directive to rote confirmations only" (2026-06-25, +16/-9 in `autonomy.ts`)
**Root cause**: the initial directive auto-answered "approve decomposition" and triage — real
decisions — alongside mechanical gates. Fixed by adding the explicit PAUSE list + "unsure → ask."
**Takeaway**: **autonomy scope creep is the primary failure mode.** Feature 1's `#1 safe-auto`
deliberately re-expands that scope — so the refined heuristic (Recommended-unless-strictly-better,
respect deferral-to-later-unit) and the safety EXEMPTION must be encoded tightly, and each
auto-decision should be logged (which question, which option, why) for an audit trail.

### Precedent: `/wfex continue` for the artifact-exists edge case
**Commit(s)**: `35a3eca` — "Add /wfex continue — advance past an interrupted-but-done stage" (2026-06-26, 5 files)
**Takeaway**: cold re-runs are costly; a stage-aware salvage (credit the on-disk artifact) is the
proven way to reuse partial output. The limit-reset retry loop will hit frozen-mid-stage runs
repeatedly and should prefer `continue` semantics where an artifact exists, plain `resume` otherwise.

### Composite Lessons
- Autonomy scope creep broke things within 4 h (`258b8d7`) — `#1 safe-auto` must be narrow, logged,
  and reversible to `off`.
- The `3`-strike cap (`b1164c3`) bounds non-idempotent re-runs — keep a runaway guard (bounded
  wall-clock) when removing it.
- Cold re-runs are wasteful (`35a3eca`) — reuse partial artifacts via `continue` where present.
- The re-entrancy guard (`state.ts:62-78`) is essential — the higher-frequency retry loop must not
  wedge it across the long sleep.

## Historical Context (from `.rpiv/artifacts/`)
- `.rpiv/artifacts/research/2026-06-25_10-42-04_autonomous-resilient-workflow-sidecar.md` — original
  sidecar research: engine has zero confirmation seams, autonomy is prompt-priority, the freeze is
  un-timed `waitForIdle` at `sessions/spawn.ts:69`, resume is already complete.
- `.rpiv/artifacts/designs/2026-06-25_11-03-01_autonomous-resilient-workflow-sidecar.md` — design (D1–D4 decisions).
- `.rpiv/artifacts/plans/2026-06-25_16-10-53_autonomous-resilient-workflow-sidecar.md` — phased plan for the original build.
- `.rpiv/artifacts/validation/2026-06-25_16-46-44_autonomous-resilient-workflow-sidecar.md` — validation report.

## Developer Context
**Q (`watchdog.ts:62`, `state.ts:11`, Pi `retry.provider`): the pasted 429 exhausts Pi's provider auto-retry, not the sidecar cap, and the watchdog never sees it — which seam handles retry-until-reset?**
A: **Both** — tune Pi's `retry.provider` config for short blips AND add a 429-observing 10-min retry loop in the sidecar for the hard 5-hour wall.

**Q (`autonomy.ts:30-42`): commit `258b8d7` added the PAUSE list to STOP auto-deciding substantive choices; full-auto wants to auto-pick them — what should the toggle do?**
A: **Two stages.** `#1 safe-auto` = auto-pick decisions (Recommended unless strictly-better-no-drawback, respecting deferral) while genuine safety stops still halt. `#2 unattended-auto` = auto-pick everything including safety stops. Tri-state toggle, default off.

**Q (`state.ts:11`, README caveat): cold re-runs can hit non-idempotent stages — should the 10-min retry loop carry a runaway guard?**
A: **Bounded wall-clock** — retry every 10 min capped at one usage window + margin (~6–12 h), then notify and stop.

## Open Questions
1. **Toggle persistence** — should `autoMode` survive a Pi process restart? In-memory (`state.ts`
   slot) is enough for overnight runs in one process; persisting to `~/.config/rpiv-pi/models.json`
   (or a sibling config) survives restarts but adds I/O + a config surface. Not yet decided.
2. **Subscription vs API 429** — the pasted error is the API-style `rate_limit_error` (no reset
   time). If runs can also surface the claude.ai subscription "You've hit your session limit · resets
   HH:MM (TZ)" string, parsing it for a single precise wait would beat 10-min polling. Confirm which
   surface the user's setup actually hits before building a parser.
3. **Stage idempotency for unattended retry** — carried from the original research (Open Q #3): is
   `commit` (and other side-effect stages) safe to cold-re-run after a limit-reset resume? The
   bounded wall-clock guard limits blast radius but does not make a non-idempotent stage safe.
4. **`#2 unattended-auto` and the implement safety stop** — auto-proceeding past a plan/working-tree
   mismatch (`autonomy.ts:38-42`) can apply a plan against a dirty tree. Confirm this is acceptable
   for the unattended tier, or add a narrower carve-out (e.g. still stop on working-tree mismatch but
   auto-proceed on everything else).
