# Manual end-to-end check

1. Build this workspace with `pnpm build`.
2. Install the supervisor bundle into the DSH web profile from this checkout: `dsh plugin --profile web add /absolute/path/to/dsh-gate/packages/dsh-supervisor-tools`.
3. Start DSH independently, for example `dsh web --host 127.0.0.1 --port 8080 --no-open`. Leave it running.
4. Add the MCP config from `config/codex-mcp.example.toml` to Codex and restart MCP.
5. Call `dsh_start_or_connect`, then `dsh_task`, and repeatedly call `dsh_wait` with the last `asOfSeq`. A running task may return early with `WAITING/PROGRESS`; inspect its compact `progress` heartbeat and carry the new `asOfSeq`. `WAITING/TIMEOUT` means only that the bounded wait expired.
6. Restart only MCP and call `dsh_start_or_connect` with the existing session id. Confirm the same `hostInstanceId` and transcript return.
7. Exercise a question, an approval, a wait timeout, a valid handoff, a missing handoff, an out-of-cwd artifact, and two writer tasks sharing one cwd.

Expected: Host/session survive MCP restart; interaction states are typed; timeout and worker state are separate; only the valid handoff plus turn end completes; artifact escape is rejected; the second shared-tree writer is rejected.
