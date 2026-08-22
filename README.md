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

Copy `config/codex-mcp.example.toml` into the matching Codex config and replace the `<workspace-root>` placeholder with this checkout's absolute path. The server executable is `packages/mcp-server/dist/cli.js` — if an older config still points at `dist/index.js`, update it to `dist/cli.js` (the library entry does not start the MCP server). Codex MCP configuration supports stdio servers with command, args, environment, startup timeout, and tool timeout fields.

`DSH_HOST_LAUNCH` must be explicitly configured for automatic Host startup. It is optional JSON such as `{"argv":["dsh","web","--host","127.0.0.1","--port","8080","--no-open"]}`. When absent, a connection failure never launches a Host (start DSH yourself, as in the command above). When present, launch is detached with ignored stdio, and MCP never retains a kill capability.

## Development against the unreleased DSH network-client seam

`@dsh-gate/mcp-server` imports `@deepseek-ai/dsh-client-connection/network-client`, the generic network-client and reconnect-controller exports. Those exports are not yet part of any published DSH release; they currently exist only as a local, uncommitted compatibility patch on a DeepSeek Harness checkout. To build and run against such a checkout:

```sh
node scripts/link-local-dsh.mjs /path/to/deepseek-harness
```

The link is local-only; no machine path is committed into package metadata. The `dist/cli.js` entry probes the seam first and prints this explanation instead of a raw module-resolution error when it is missing. Once the public DSH client additions are released, a normal package install replaces the link.

## Supervision cadence

`dsh_wait` runs a five-minute aggregated progress cadence: by default it returns about one observation every 300000 ms, and it returns early only for a material supervisor boundary — for example a terminal state, approval/question, checkpoint, blocker, or escalation. Ordinary event churn never triggers rapid repeated wait calls. Each cadence observation aggregates progress since the previous `asOfSeq` — step delta, tool counts, token deltas — plus a compact, bounded `projectActivity` summary of the distinct project files touched by successful edits/writes and the targeted verification commands attempted (for example `pnpm verify`). Terminal observations carry the task-scope totals. No raw logs, diffs, or tool outputs are ever included.

The queued prompt starts with the human-readable objective and embeds the durable task packet afterward. This keeps protocol validation unchanged while making new supervised sessions recognizable by task name in the DSH Web sidebar.

## Long handoff details

`supervisor_handoff.summary` is capped at 2048 characters. When a task needs a longer report, write it as Markdown under `.dsh-handoff/<taskId>/` inside the session cwd (the directory is gitignored), pass the relative path in `artifacts`, and reference it from the concise summary. The handoff tool rejects over-limit summaries with exactly this instruction and never writes handoff data itself — in particular, never to `~/.codex` or any other global directory. Artifact admission enforces containment: relative paths only, no traversal, symlinks, hardlinks, or non-regular files, hashed through a validated handle within the session cwd.

## Release status

The **source tree is ready for public source hosting** once the two human decisions below land: nothing in this repository depends on a known repository URL, the working tree contains no machine-specific paths or secrets, and `pnpm verify` passes with the documented local development link. Publication as **npm packages is a separate, still-blocked decision**: both packages keep `"private": true`, and a clean `pnpm install` cannot build or run until the upstream DSH seam is published. Known blockers, none of which can be resolved inside this repository:

1. **License decision (human).** No license has been chosen for this repository's original code. See `docs/source-provenance.md`.
2. **Repository identity (human).** No public GitHub owner/repository name has been established; nothing here should be cited as the canonical home yet.
3. **Upstream DSH network-client release (upstream).** Clean package installation cannot build or run until the generic `@deepseek-ai/dsh-client-connection/network-client` exports described above are published by DeepSeek Harness.

Everything else — build, tests, packaging, and the protocol contract — is intended to be release-ready once those decisions land.

See `docs/protocol.md` for state semantics, `docs/manual-e2e.md` for the acceptance path, `docs/benchmark.md` for the evaluation design, `docs/source-provenance.md` for source and license traceability, and `docs/source-backed-reuse-review.md` for the historical design review. For contributors: `CONTRIBUTING.md`. For vulnerability reporting: `SECURITY.md`.
