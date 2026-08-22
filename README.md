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
dsh plugin --profile web add $(pwd)/packages/dsh-supervisor-tools
dsh web --host 127.0.0.1 --port 8080 --no-open
```

Copy `config/codex-mcp.example.toml` into the matching Codex config and replace the `<workspace-root>` placeholder with this checkout's absolute path. Codex MCP configuration supports stdio servers with command, args, environment, startup timeout, and tool timeout fields.

## Development against the unreleased DSH network-client seam

`@dsh-gate/mcp-server` imports `@deepseek-ai/dsh-client-connection/network-client`, the generic network-client and reconnect-controller exports. Those exports are not yet part of any published DSH release; they currently exist only as a local, uncommitted compatibility patch on a DeepSeek Harness checkout. To build and run against such a checkout:

```sh
node scripts/link-local-dsh.mjs /path/to/deepseek-harness
```

The link is local-only; no machine path is committed into package metadata. The `dist/cli.js` entry probes the seam first and prints this explanation instead of a raw module-resolution error when it is missing. Once the public DSH client additions are released, a normal package install replaces the link.

`DSH_HOST_LAUNCH` is optional JSON such as `{"argv":["dsh","web","--host","127.0.0.1","--port","8080","--no-open"]}`. When absent, connection failure never launches a Host. When present, launch is detached with ignored stdio, and MCP never retains a kill capability.

## Release status

This repository is not yet releasable in public form. The known blockers, none of which can be resolved inside this repository:

1. **Upstream DSH network-client release.** Clean package installation cannot build or run until the generic `@deepseek-ai/dsh-client-connection/network-client` exports described above are published by DeepSeek Harness.
2. **License decision.** No license has been chosen for this repository's original code. See `docs/source-provenance.md`.
3. **Repository identity.** No public GitHub repository URL has been established; nothing here should be cited as the canonical home yet.

Everything else — build, tests, packaging, and the protocol contract — is intended to be release-ready once those three decisions land.

See `docs/protocol.md` for state semantics, `docs/manual-e2e.md` for the acceptance path, `docs/benchmark.md` for the evaluation design, `docs/source-provenance.md` for source and license traceability, and `docs/source-backed-reuse-review.md` for the historical design review. For contributors: `CONTRIBUTING.md`. For vulnerability reporting: `SECURITY.md`.
