---
name: codex-dsh-supervisor
description: Supervise a coding task through the dsh-gate MCP tools, including durable reconnect, interaction handling, observation cursors, and strict completion validation. Use when the user asks Codex to delegate or supervise work in a DSH Host. Do not use for ordinary local coding or general DSH explanations.
---

# Codex DSH Supervisor

Use the `dsh_*` MCP tools to supervise one DSH root session.

1. Before assigning a writer task, establish a recoverable Git baseline and record `HEAD` plus `git status`. If the repository has no commit or the baseline would include user changes, obtain explicit human authorization before committing. Never create the baseline by stashing, resetting, discarding, or overwriting existing work. Read-only tasks do not require a new baseline.
2. Call `dsh_start_or_connect`. Reuse the returned `taskId` to reconnect an existing session; do not assume the MCP process owns the Host.
3. Call `dsh_task` with a self-contained objective plus relevant context, scope, constraints, acceptance, verification, and escalation conditions. Default to `writer`; choose `read_only` for analysis. A second writer needs an independent Git worktree, not a workspace lock service.
4. Call `dsh_wait` with a bounded timeout. Carry the returned `asOfSeq` into the next `afterAsOfSeq`; it is only an observation cursor, never a server resume cursor. `WAITING/PROGRESS` is a compact durable-activity heartbeat with step/tool counts and token deltas, not a semantic checkpoint. Report aggregated progress to the user during a long run; because commentary may collapse, every terminal response must recap root steps, tool counts by name, and token deltas.
5. Resolve `APPROVAL_REQUIRED` and `QUESTION_REQUIRED` with the matching answer tool. Use `dsh_steer` only to transmit explicit user-authored new guidance or a user-requested correction; never synthesize a nudge merely because progress paused or a child settled. Use `dsh_cancel` only for the active turn.
6. Distinguish `WAITING.wait.reason=PROGRESS` from `TIMEOUT`, and inspect `workerState` separately. For `FAILED`, report the explicit failure kind.
7. Accept success only from `COMPLETED`. The runtime requires a valid `supervisor_handoff` result and the corresponding `turn/end`; a turn ending alone is `MISSING_HANDOFF`.

DSH root exclusively owns child orchestration. The Host automatically relays child reports and settled notices into the root session. `dsh_agents` is read-only observability: report its child activity and telemetry to the user, but never relay child completion/results with `dsh_steer`, never wake root to “take over,” and never infer authority from observing a settled child. Use `dsh_interrupt_agent` only on an explicit human request or a clear safety/resource emergency.

Never stop the DSH Host when the MCP task ends. On MCP restart, reconnect to the configured Host and the same session id. Verify artifact hashes and paths from the returned manifest before relying on them.

Keep authority separated: DSH handles safe local execution, Codex decides material engineering or architecture changes, and the human decides security-sensitive or external side effects.

If the Host cannot be reached, report that connection failure. Do not silently start a Host unless `DSH_HOST_LAUNCH` was explicitly configured.
