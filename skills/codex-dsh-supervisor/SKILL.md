---
name: codex-dsh-supervisor
description: Supervise a coding task through the dsh-gate MCP tools, including durable reconnect, interaction handling, observation cursors, the five-minute aggregated progress cadence, and strict completion validation. Use when the user asks Codex to delegate or supervise work in a DSH Host. Do not use for ordinary local coding or general DSH explanations.
---

# Codex DSH Supervisor

Use the `dsh_*` MCP tools to supervise one DSH root session.

## Start the visible session

1. Call `dsh_start_or_connect` first. It connects to the configured Host, or starts one when `DSH_HOST_LAUNCH` is explicitly configured (automatic Host startup never happens without it). Pass the existing `sessionId` to reconnect and reuse the same session; the Host remains independently owned and MCP restart never stops it.
2. Open the returned `hostBaseUrl` in a visible browser tab so the user can watch the live session (the DSH web UI), and keep that tab available for the duration of the task. If a tab is already open on that URL, reuse it. After queuing the task, select its human-readable objective in the Web session sidebar when the UI exposes it; otherwise leave the session list visible and tell the user the `taskId`. MCP never owns or closes the browser.

## Assign and observe

3. Before assigning a writer task, establish a recoverable Git baseline and record `HEAD` plus `git status`. If the repository has no commit or the baseline would include user changes, obtain explicit human authorization before committing. Never create the baseline by stashing, resetting, discarding, or overwriting existing work. Read-only tasks do not require a new baseline.
4. Call `dsh_task` with a self-contained objective plus relevant context, scope, constraints, acceptance, verification, and escalation conditions. Default to `writer`; choose `read_only` for analysis. A second writer needs an independent Git worktree, not a workspace lock service.
   Treat ordinary in-scope edits, focused compilation/tests/builds, routine debugging, and any explicitly pre-authorized child use as execution authority: do not ask the human again. Escalate only when a missing choice would materially change the requested result, or before a security-sensitive, destructive, credentialed, external, or otherwise unauthorized side effect.
5. Call `dsh_wait` with the default timeout (300000 ms) — the five-minute aggregated progress cadence. One long observation arrives about every 300000 ms; do not re-poll on ordinary event churn. It returns early only for a material supervisor boundary, such as a terminal state, approval/question, checkpoint, blocker, or escalation. A `WAITING`/`TIMEOUT` return is the cadence observation: aggregate `progress` since the prior `asOfSeq` — step delta, tool counts by name, token deltas, and compact `projectActivity` (distinct files touched by successful edits/writes and targeted verification commands like `pnpm verify`). Surface the compact summary to the user; never dump raw logs, diffs, or tool outputs. Carry the returned `asOfSeq` into the next `afterAsOfSeq`; it is only an observation cursor, never a server resume cursor.
6. Resolve `APPROVAL_REQUIRED` and `QUESTION_REQUIRED` with the matching answer tool. Use `dsh_steer` only to transmit explicit user-authored new guidance or a user-requested correction; never synthesize a nudge merely because progress paused or a child settled. Use `dsh_cancel` only for the active turn.
7. Distinguish `WAITING.wait.reason=TIMEOUT` (cadence window expired) from worker state, and inspect `workerState` separately. For `FAILED`, report the explicit failure kind.
8. Accept success only from `COMPLETED`. The runtime requires a valid `supervisor_handoff` result and the corresponding `turn/end`; a turn ending alone is `MISSING_HANDOFF`. Terminal reporting must recap steps, tool counts, token deltas, verification results, the worker's final files, and the computed `projectActivity` totals — without equating every tool call with a project change.

## Children

When the user has pre-authorized up to 5 direct DSH children for the task, delegate freely within that cap and do not ask again; child creation is pre-authorized routine activity. DSH root exclusively owns child orchestration: the Host automatically relays child reports and settled notices into the root session. `dsh_agents` is read-only observability — report child activity and telemetry to the user, but never relay child completion/results with `dsh_steer`, never wake root to "take over," never steer or re-prompt a settled child, and never infer authority from observing one. Use `dsh_interrupt_agent` only on an explicit human request or a clear safety/resource emergency.

## Compile and verification policy

Run the narrowest relevant verification after a coherent or high-risk edit batch (for example, one focused test file or a single package typecheck), not after every edit. Run full verification (`pnpm verify` or the task's declared verification commands) before handoff, and report its results in the handoff `verification` array. Do not report raw logs; report compact outcomes.

## Boundaries

Never stop the DSH Host when the MCP task ends. On MCP restart, reconnect to the configured Host and the same session id. Verify artifact hashes and paths from the returned manifest before relying on them.

Worker handoff summaries stay at or below 2048 characters; detailed task reports arrive as admitted artifacts under `.dsh-handoff/<taskId>/` inside the session cwd (gitignored). Do not treat an over-limit summary as a failure to report detail — the worker should shorten the summary and pass the report path in `artifacts`.

Keep authority separated: DSH handles safe local execution, Codex decides material engineering or architecture changes, and the human decides security-sensitive or external side effects.

If the Host cannot be reached, report that connection failure. Do not silently start a Host unless `DSH_HOST_LAUNCH` was explicitly configured.
