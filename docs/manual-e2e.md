# Manual end-to-end check

1. Bootstrap the deployment: `pnpm bootstrap` (or, against an already-verified
   checkout at the pinned commit, `node scripts/dsh-gate.mjs bootstrap
   --dsh-repo /path/to/verified/deepseek-harness`). Confirm `.dsh-state/`
   holds the managed checkout, the isolated `dsh-home`, and `install.json`;
   confirm `pnpm run doctor` passes all offline checks.
2. Start DSH independently: `pnpm host:start` (spawns
   `dsh web --host 127.0.0.1 --port 8080 --no-open` with the project-local
   `DSH_HOME`). Leave it running; `pnpm host:status` shows the
   `hostInstanceId`. `pnpm run doctor --live` verifies `protocolVersion=1`.
3. Add the MCP config from `config/codex-mcp.example.toml` to Codex and restart MCP. Replace the `<workspace-root>` placeholder with this checkout's absolute path.
4. Call `dsh_start_or_connect`, pass its `sessionId` to `dsh_task`, record the returned unique `runId`, and call `dsh_wait` with that exact `sessionId + runId` and the default timeout. Expect about one `WAITING/TIMEOUT` observation per five-minute window, each aggregating `progress` since the previous `asOfSeq` (step delta, tool counts, token deltas, and the compact `projectActivity` edits/verification summary); do not re-poll on ordinary churn. Have the worker publish ordinary `supervisor_progress` and confirm it is folded into the cadence. Then publish a low-impact non-blocking structured decision and confirm it stays in cadence, followed by a sensitive or blocking structured decision and confirm the returned `decision` explains whether `SUPERVISOR_REQUIRED` is immediate and which audience/action applies. Confirm later guidance consumes that request. Carry the returned `asOfSeq` into the next `afterAsOfSeq`.
5. At terminal state, confirm `journal.recorded=true`, the stored record reports `modelCallsUsed=0`, and a repeated terminal wait returns the same `recordId` without adding a second file. In a disposable check, make the journal unwritable and confirm only `journal.warning` changes while the terminal status remains intact.
6. Restart only MCP and call `dsh_start_or_connect` with the existing session id and no explicit Host URL. With multiple configured Hosts, confirm it discovers the non-default Host when appropriate and returns the same `hostInstanceId` and transcript — the Host outlived the MCP restart.
7. Exercise a question, an approval, a wait timeout, a valid handoff, a missing handoff, an over-limit handoff summary (expect the actionable `.dsh-handoff/<runId>/` recovery error), an out-of-cwd artifact, and two writer tasks sharing one cwd.
8. Stop the Host explicitly with `pnpm host:stop`; confirm the MCP process is unaffected.

Expected: Host/session survive MCP restart; replayed interactions retain a stable `rpcId` and stale replies are rejected; timeout and worker state are separate; ordinary mux churn does not cause one history request per event; activity coverage and runtime verification evidence are explicit; only the valid handoff plus turn end completes; artifact escape is rejected; the second shared-tree writer is rejected until its run reaches `turn/end`; the Host stops only via its explicit stop path.
