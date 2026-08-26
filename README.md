# dsh-gate

`dsh-gate` lets Codex supervise long-running DeepSeek Harness sessions through MCP while keeping the DSH Host and sessions independent of the MCP process.

The workspace contains:

- `@dsh-gate/mcp-server`: nine MCP tools over DSH's public network client and reconnect controller;
- `@dsh-gate/supervisor-tools`: DSH-side handoff, artifact admission, and reported-failure budget tools;
- `@dsh-gate/decision-policy`: dependency-free, explainable intervention policy with locked protocol invariants;
- `@dsh-gate/rag-context`: standalone retrieval contracts, lexical baseline, and rank fusion; intentionally not connected to MCP or DSH;
- two narrow operator skills, example Codex/DSH configuration, and a deterministic bootstrap/doctor/Host workflow.

## Deploy, verify, and start

```sh
pnpm bootstrap      # fetch the pinned DSH fork commit, build & link the exact
                    # network client, install the supervisor plugin into an
                    # isolated project-local DSH home (.dsh-state/) — never starts the Host
pnpm run doctor     # verify pin, link, built artifacts, and plugin/profile
pnpm host:start     # start the independent DSH Web Host on http://127.0.0.1:8080
pnpm run doctor --live  # additionally verify the running Host identity/protocol
```

Install the included Codex supervisor skill into the personal skill directory shown by your Codex installation, then restart Codex:

```sh
pnpm skill:install -- --target /absolute/path/to/personal/skills
```

The installer deliberately requires an explicit absolute target instead of guessing a global directory. Re-running with `--force` preserves the previous installation as a timestamped sibling backup before replacing it.

Then copy `config/codex-mcp.example.toml` into the matching Codex config and replace the `<workspace-root>` placeholder with this checkout's absolute path — the only machine-specific value. The server executable is `packages/mcp-server/dist/cli.js` — if an older config still points at `dist/index.js`, update it to `dist/cli.js` (the library entry does not start the MCP server). Codex MCP configuration supports stdio servers with command, args, environment, startup timeout, and tool timeout fields.

For the full operator guide — prerequisites, the compatibility contract and update policy, Host independence, browser visibility, clean failure recovery, and the official-upstream-PR limitation — read **`DEPLOYMENT.md`**.

## The pinned DSH fork commit

`@dsh-gate/mcp-server` imports `@deepseek-ai/dsh-client-connection/network-client`, the generic network-client and reconnect-controller exports. Those exports are not part of any published DSH release; they are consumed from the public fork at exactly one commit:

- fork: `https://github.com/yidapan666-creator/deepseek-harness.git`
- commit: `7212c955438c70c9a2d168f67e85a8014b8d4488`

The **commit SHA is the compatibility contract** — bootstrap fetches by SHA (never a moving branch), doctor refuses a checkout whose `HEAD` differs or whose remote does not identify the fork, and a dirty checkout is refused without destructive recovery. The link itself is created by the existing `scripts/link-local-dsh.mjs`, reused by bootstrap; it is local-only, and no machine path is committed into package metadata. `dist/cli.js` probes the seam first and prints a clear diagnostic instead of a raw module-resolution error when it is missing.

To update the pin: change `DSH_PINNED_COMMIT` in `scripts/dsh-gate-lib.mjs`, remove `.dsh-state/dsh`, and re-run `pnpm bootstrap`. See `DEPLOYMENT.md` for the policy and for why the fork commit is not claimed as an upstream merge.

## Supervision cadence

`dsh_wait` runs a five-minute aggregated progress cadence: by default it returns about one observation every 300000 ms, and it returns early only when the decision outcome says `timing=immediate`. Terminal states, approval/question, checkpoint, blocker, escalation, and Host/protocol failure are locked protocol boundaries. Worker decision requests carry structured category/impact/blocking facts and are evaluated by the versioned decision policy; low-impact non-blocking requests may stay in the cadence, while sensitive or unauthorized decisions surface immediately. Every observation includes the matched decision action and reason. Ordinary mux event churn is folded from memory and never triggers one HTTP history refresh per event; reconciliation is periodic and mandatory before a visible boundary. Each cadence observation aggregates progress since the previous `asOfSeq` — step delta, tool counts, token deltas — plus a compact, bounded `projectActivity` summary of distinct project files touched by successful recognized edits/writes and targeted verification commands. Activity says whether instrumentation coverage is `complete` or `partial`, and verification evidence reports event-correlated outcomes separately from worker handoff claims. No raw reasoning, logs, diffs, tool arguments, or tool outputs are ever included.

When several Host URLs are configured, reconnect by `sessionId` discovers the existing session and binds the run to that Host. Connection failures are returned as structured `HOST_FAILED` envelopes instead of being flattened into “session not found.” Approval and question answers must echo the current stable `rpcId`, so a replayed or replaced interaction cannot be answered accidentally.

DSH session identity and supervised execution identity are separate. `dsh_start_or_connect` returns the durable `sessionId`; every `dsh_task` returns a new UUID `runId`. Wait, answer, steer, cancel, child-observation, and interrupt calls carry both values, so a delayed control for an older run is rejected before it can affect a newer turn in the same session.

The queued prompt starts with the human-readable objective and embeds the durable task packet afterward. This keeps protocol validation unchanged while making new supervised sessions recognizable by task name in the DSH Web sidebar.

## Long handoff details

`supervisor_handoff.summary` is capped at 2048 characters. When a task needs a longer report, write it as Markdown under `.dsh-handoff/<runId>/` (legacy v1: taskId) inside the session cwd, pass the relative path in `artifacts`, and reference it from the concise summary. The directory is gitignored. The handoff tool rejects over-limit summaries with exactly this instruction and never writes handoff data itself — in particular, never to `~/.codex` or any other global directory. Artifact admission enforces containment: relative paths only, no traversal, symlinks, hardlinks, or non-regular files, hashed through a validated handle within the session cwd.

## Release status

The source is licensed under MIT and prepared for public hosting at `yidapan666-creator/dsh-gate`: the DSH dependency is a public fork commit pinned by SHA, the working tree contains no machine-specific paths or secrets, and `pnpm verify` passes with the bootstrap-managed link. Publication as **npm packages is a separate, still-blocked decision**: both packages keep `"private": true`, and a clean package install cannot build or run until the upstream DSH network-client seam is published (the fork pin works for source deployments, not for registry consumers).

The remaining upstream limitation is npm publication: both packages stay private until the generic `@deepseek-ai/dsh-client-connection/network-client` exports are published upstream. The public fork pin at `7212c955438c70c9a2d168f67e85a8014b8d4488` makes source deployments reproducible today; it is not an upstream merge and no merge is claimed.

Source installation, build, tests, packaging checks, and the protocol contract are covered by the documented verification workflow.

See `docs/protocol.md` for state semantics, `docs/decision-policy-and-rag-research.md` for the intervention-policy design and unconnected RAG roadmap, `docs/manual-e2e.md` for the acceptance path, `docs/benchmark.md` for the evaluation design, `docs/source-provenance.md` for source and license traceability, and `docs/source-backed-reuse-review.md` for the historical design review. For contributors: `CONTRIBUTING.md`. For vulnerability reporting: `SECURITY.md`.
