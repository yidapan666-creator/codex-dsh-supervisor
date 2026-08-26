---
name: codex-dsh-supervisor
description: Supervise a coding task through the dsh-gate MCP tools, including durable reconnect, interaction handling, observation cursors, the five-minute aggregated progress cadence, and strict completion validation. Use when the user asks Codex to delegate or supervise work in a DSH Host. Do not use for ordinary local coding or general DSH explanations.
---

# Codex DSH Supervisor

Use the `dsh_*` MCP tools to supervise one DSH root session.

## Start the visible session

1. Call `dsh_start_or_connect` first. It connects to the configured Host, or starts one when `DSH_HOST_LAUNCH` is explicitly configured (automatic Host startup never happens without it). Pass the existing `sessionId` to reconnect and reuse the same session; the Host remains independently owned and MCP restart never stops it. Treat the returned `sessionId` as the durable conversation address, not as one task execution.
2. Open the returned `hostBaseUrl` in a visible browser tab so the user can watch the live session (the DSH web UI), and keep that tab available for the duration of the task. If a tab is already open on that URL, reuse it. After queuing the task, select its human-readable objective in the Web session sidebar when the UI exposes it; otherwise leave the session list visible and tell the user the `sessionId` and `runId`. MCP never owns or closes the browser.

## Assign and observe

3. Before assigning a writer task, establish a recoverable Git baseline and record `HEAD` plus `git status`. If the repository has no commit or the baseline would include user changes, obtain explicit human authorization before committing. Never create the baseline by stashing, resetting, discarding, or overwriting existing work. Read-only tasks do not require a new baseline.
4. Call `dsh_task` with the `sessionId` and a self-contained objective plus relevant context, scope, constraints, acceptance, verification, escalation conditions, Git baseline, and pre-authorized child budget. Default to `writer`; choose `read_only` for analysis. Record the returned `runId`: every wait, answer, steer, cancel, child-observation, and interrupt call for this execution must carry the exact `sessionId + runId`. A second writer needs an independent Git worktree, not a workspace lock service.
   Treat ordinary in-scope edits, focused compilation/tests/builds, routine debugging, and any explicitly pre-authorized child use as execution authority: do not ask the human again. Escalate only when a missing choice would materially change the requested result, or before a security-sensitive, destructive, credentialed, external, or otherwise unauthorized side effect.
5. Call `dsh_wait` with the exact `sessionId + runId` and default timeout (300000 ms) — the five-minute aggregated progress cadence. One long observation arrives about every 300000 ms; do not re-poll on ordinary event churn. Return timing is controlled by the observation's explainable `decision`: locked protocol boundaries and policy-matched worker requests may be immediate; ordinary progress stays in the cadence. Follow `decision.action` and `decision.audience`; do not ask the human when the result says cadence/none. A `WAITING`/`TIMEOUT` return is the cadence observation: aggregate `progress` since the prior `asOfSeq` — step delta, tool counts by name, token deltas, and compact `projectActivity` (distinct files touched by successful edits/writes and targeted verification commands like `pnpm verify`) — plus the latest accepted bounded `supervisorProgress` milestone when present. Surface the compact summary to the user; never dump raw reasoning, logs, diffs, tool arguments, or tool outputs. Carry the returned `asOfSeq` into the next `afterAsOfSeq`; it is only an observation cursor, never a server resume cursor. A stale-run failure means a newer run exists: do not act on it as though it belonged to the old execution.
6. Resolve `APPROVAL_REQUIRED` and `QUESTION_REQUIRED` with the matching answer tool, exact `sessionId + runId`, and the current observation's stable `rpcId`; never answer a replayed/stale interaction id. For `SUPERVISOR_REQUIRED`, surface the bounded milestone, risk, and requested next action; steer only when the answer follows from the user's already stated policy, otherwise ask the user. Use `dsh_steer` only to transmit explicit user-authored new guidance or a user-requested correction; never synthesize a nudge merely because progress paused or a child settled. Use `dsh_cancel` only for the active run. After a checkpoint, continue by queueing a new run with `parentRunId`; do not use a free-form steer as a continuation protocol.
7. Distinguish `WAITING.wait.reason=TIMEOUT` (cadence window expired) from worker state, and inspect `workerState` separately. For `FAILED`, report the explicit failure kind.
8. Accept success only from `COMPLETED`. The runtime requires a valid `supervisor_handoff` result and the corresponding `turn/end`; a turn ending alone is `MISSING_HANDOFF`. Terminal reporting must recap steps, tool counts, token deltas, verification results, the worker's final files, and the computed `projectActivity` totals. State whether activity coverage is complete or partial and distinguish runtime-correlated verification evidence from worker claims; never equate every tool call with a project change. Also report whether `journal.recorded` succeeded. The journal uses existing runtime facts and zero additional model calls; its warning never changes the task outcome. Do not retrieve historical records unless explicitly requested or selected by a future retrieval policy.

## Children

When the user has pre-authorized up to 5 direct DSH children for the task, record that limit in the task authority and delegate freely within the cap without asking again. DSH root exclusively owns child orchestration: the Host automatically relays child reports and settled notices into the root session. `dsh_agents` with the current `sessionId + runId` is read-only observability — report child activity and telemetry to the user, but never relay child completion/results with `dsh_steer`, never wake root to "take over," never steer or re-prompt a settled child, and never infer authority from observing one. Use `dsh_interrupt_agent` only on an explicit human request or a clear safety/resource emergency.

## Compile and verification policy

Run the narrowest relevant verification after a coherent or high-risk edit batch (for example, one focused test file or a single package typecheck), not after every edit. Run full verification (`pnpm verify` or the task's declared verification commands) before handoff, and report its results in the handoff `verification` array. Do not report raw logs; report compact outcomes.

## Boundaries

Never stop the DSH Host when the MCP task ends. On MCP restart, reconnect to the configured Host and the same session id. Verify artifact hashes and paths from the returned manifest before relying on them.

Worker handoff summaries stay at or below 2048 characters; detailed task reports arrive as admitted artifacts under `.dsh-handoff/<runId>/` inside the session cwd (gitignored; legacy v1 packets may use taskId). Do not treat an over-limit summary as a failure to report detail — the worker should shorten the summary and pass the report path in `artifacts`.

Keep authority separated: DSH handles safe local execution, Codex decides material engineering or architecture changes, and the human decides security-sensitive or external side effects.

If the Host cannot be reached, report that connection failure. Do not silently start a Host unless `DSH_HOST_LAUNCH` was explicitly configured.
