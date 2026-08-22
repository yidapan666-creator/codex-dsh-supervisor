# Manual end-to-end check

1. Build this workspace with `pnpm build`.
2. Install the supervisor bundle into the DSH web profile from this checkout: `dsh plugin --profile web add $(pwd)/packages/dsh-supervisor-tools`.
3. Start DSH independently, for example `dsh web --host 127.0.0.1 --port 8080 --no-open`. Leave it running.
4. Add the MCP config from `config/codex-mcp.example.toml` to Codex and restart MCP. Replace the `<workspace-root>` placeholder with this checkout's absolute path.
5. Call `dsh_start_or_connect`, then `dsh_task`, and call `dsh_wait` with the default timeout. Expect about one `WAITING/TIMEOUT` observation per five-minute window, each aggregating `progress` since the previous `asOfSeq` (step delta, tool counts, token deltas, and the compact `projectActivity` edits/verification summary); do not re-poll on ordinary churn. Confirm an approval or a terminal handoff returns immediately, before the window expires. Carry the returned `asOfSeq` into the next `afterAsOfSeq`.
6. Restart only MCP and call `dsh_start_or_connect` with the existing session id. Confirm the same `hostInstanceId` and transcript return.
7. Exercise a question, an approval, a wait timeout, a valid handoff, a missing handoff, an over-limit handoff summary (expect the actionable `.dsh-handoff/<taskId>/` recovery error), an out-of-cwd artifact, and two writer tasks sharing one cwd.

Expected: Host/session survive MCP restart; interaction states are typed; timeout and worker state are separate; only the valid handoff plus turn end completes; artifact escape is rejected; the second shared-tree writer is rejected.
