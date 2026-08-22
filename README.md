# dsh-gate

`dsh-gate` lets Codex supervise long-running DeepSeek Harness sessions through MCP while keeping the DSH Host and sessions independent of the MCP process.

The workspace contains:

- `@dsh-gate/mcp-server`: nine MCP tools over DSH's public network client and reconnect controller;
- `@dsh-gate/supervisor-tools`: DSH-side handoff, artifact admission, and reported-failure budget tools;
- two narrow operator skills and example Codex/DSH configuration.

## Build and connect

```sh
pnpm install
pnpm build
dsh plugin --profile web add /absolute/path/to/dsh-gate/packages/dsh-supervisor-tools
dsh web --host 127.0.0.1 --port 8080 --no-open
```

Copy `config/codex-mcp.example.toml` into the matching Codex config and replace the absolute server path. Codex MCP configuration supports stdio servers with command, args, environment, startup timeout, and tool timeout fields.

For development against the accompanying generic DSH patch, build that checkout and run:

```sh
node scripts/link-local-dsh.mjs /absolute/path/to/deepseek-harness
```

The link is local-only; no machine path is committed into package metadata. Once the public DSH client additions are released, a normal package install replaces it.

`DSH_HOST_LAUNCH` is optional JSON such as `{"argv":["dsh","web","--host","127.0.0.1","--port","8080","--no-open"]}`. When absent, connection failure never launches a Host. When present, launch is detached with ignored stdio, and MCP never retains a kill capability.

See `docs/protocol.md` for state semantics, `docs/manual-e2e.md` for the acceptance path, `docs/benchmark.md` for the evaluation design, and `docs/source-provenance.md` for source and license traceability.
