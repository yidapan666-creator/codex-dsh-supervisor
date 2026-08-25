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
4. Call `dsh_start_or_connect`, pass its `sessionId` to `dsh_task`, record the returned unique `runId`, and call `dsh_wait` with that exact `sessionId + runId` and the default timeout. Expect about one `WAITING/TIMEOUT` observation per five-minute window, each aggregating `progress` since the previous `asOfSeq` (step delta, tool counts, token deltas, and the compact `projectActivity` edits/verification summary); do not re-poll on ordinary churn. Have the worker publish ordinary `supervisor_progress` and confirm it is folded into the cadence, then publish `needsSupervisor=true` and confirm `SUPERVISOR_REQUIRED` returns immediately without ending the worker turn. Confirm later guidance consumes that request. Carry the returned `asOfSeq` into the next `afterAsOfSeq`.
5. Restart only MCP and call `dsh_start_or_connect` with the existing session id. Confirm the same `hostInstanceId` and transcript return — the Host outlived the MCP restart.
6. Exercise a question, an approval, a wait timeout, a valid handoff, a missing handoff, an over-limit handoff summary (expect the actionable `.dsh-handoff/<runId>/` recovery error), an out-of-cwd artifact, and two writer tasks sharing one cwd.
7. Stop the Host explicitly with `pnpm host:stop`; confirm the MCP process is unaffected.

Expected: Host/session survive MCP restart; interaction states are typed; timeout and worker state are separate; only the valid handoff plus turn end completes; artifact escape is rejected; the second shared-tree writer is rejected; the Host stops only via its explicit stop path.
