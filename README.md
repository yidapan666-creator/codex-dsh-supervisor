# dsh-gate

`dsh-gate` lets Codex supervise long-running DeepSeek Harness sessions through MCP while keeping the DSH Host and sessions independent of the MCP process.

The workspace contains:

- `@dsh-gate/mcp-server`: eleven MCP tools over DSH's public network client and reconnect controller;
- `@dsh-gate/supervisor-tools`: DSH-side handoff, artifact admission, reported-failure budget, and Host-enforced task-token guard;
- `@dsh-gate/decision-policy`: dependency-free, explainable intervention policy with locked protocol invariants;
- `@dsh-gate/rag-context`: standalone retrieval contracts, lexical baseline, and rank fusion; intentionally not connected to MCP or DSH;
- `@dsh-gate/run-journal`: atomic, model-free terminal run records used as the durable source for future retrieval;
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

The installer deliberately requires an explicit absolute target instead of guessing a global directory. Re-running with `--force` preserves the previous installation under the adjacent non-discoverable `skill-backups/codex-dsh-supervisor/` directory and migrates legacy sibling backups, so Codex sees only one active skill.

Then copy `config/codex-mcp.example.toml` into the matching Codex config and replace the `<workspace-root>` placeholder with this checkout's absolute path — the only machine-specific value. The server executable is `packages/mcp-server/dist/cli.js` — if an older config still points at `dist/index.js`, update it to `dist/cli.js` (the library entry does not start the MCP server). Codex MCP configuration supports stdio servers with command, args, environment, startup timeout, and tool timeout fields.

## Use it from Codex

You normally invoke dsh-gate in natural language rather than calling its MCP tools yourself. For example:

> Use DSH in `/absolute/path/to/project` to fix the failing authentication tests. Use Standard mode, allow at most 3 direct child agents, enforce a 60000-token task budget, open DSH Web, and report aggregated progress every five minutes.

Omit the mode for ordinary work and Codex defaults to Standard. Ask for PTC mode when the task is dominated by broad repository exploration, independent reads/searches, or batchable tool sequences. A Root keeps its preset for its entire durable session; changing mode means creating a different Root. See the [Chinese quickstart](docs/quickstart-zh.md) for copyable Standard, PTC, continuation, and reconnect examples.

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

DSH session identity and supervised execution identity are separate. Creating through `dsh_start_or_connect` requires the target project's absolute `cwd`; the gateway resolves it, verifies that it is an existing directory, and sends the canonical path to the Host so the DSH Web session shows the intended workspace. Creation also fixes one qualified agent preset for the durable session: `standard` by default or `code` (the Web UI's PTC mode). PTC's nested SDK calls are folded from DSH's existing durable `tool/code-dispatch-start` / `tool/code-dispatch` records, so strict handoff validation, tool/activity telemetry, and uncertain-effect recovery keep the same semantics as native calls. `minimal` is rejected because its reduced composition cannot guarantee dsh-gate's hard read-only boundary; `cordis`/Creator is rejected because it grants Host-runtime and preset-authoring authority outside ordinary project scope. Unknown custom presets fail closed until qualified. Reconnecting preserves the session's authoritative cwd and preset and rejects a conflicting requested value. The call returns the durable `sessionId` and effective `agentPreset`; every `dsh_task` returns a new UUID `runId`. Wait, answer, steer, cancel, child-observation, and interrupt calls carry both values, so a delayed control for an older run is rejected before it can affect a newer turn in the same session.

Every new dispatch can also carry a caller-minted UUID `requestId`. The Host supervisor plugin serializes admission per session, commits the task into DSH's durable inbox, and returns a stable `runId` receipt. If the MCP response is lost, retrying the exact payload with the same id returns that receipt without queueing the objective twice; reusing the id with a different payload is rejected. A new supervised task is rejected while the session is already running, so an uncommitted next-turn queue can never masquerade as an admitted task. After broader context loss, `dsh_runs` rediscovers root runs from DSH's authoritative sessions and `dsh_recover` reattaches without prompt replay. If a Host restart durably interrupts the active turn, recovery also returns a model-free `recoveryCapsule` capped at 16 KiB. It contains the last accepted Root progress plus bounded baseline, compact project activity, token/budget evidence, and session-scoped `uncertainEffects` folded across the complete affiliated run tree. Tool arguments, outputs, source text, and transcripts are never copied. A continuation must carry both the exact capsule and its `parentRunId`; admission refreshes Host history, proves that the parent is the current interrupted run for that session, recomputes the capsule, and rejects missing, fabricated, stale, cross-session, or child-incomplete evidence before the provider is called. The worker reconciles every uncertain effect and never blindly replays it.

Bootstrap also installs the repository's `dsh-supervised-worker` skill into the isolated `DSH_HOME/skills` catalog. Every admitted task includes DSH's native `/dsh-supervised-worker` gesture, so the Host loads the exact worker contract before the model acts instead of relying on a name mentioned in prose. Doctor and Host startup fail closed when that installed copy is missing or stale.

Writer check-and-admit is atomic in the long-running Host across separate Codex and MCP clients. The critical section scans both attached agents and cold persisted sessions before committing the durable inbox insertion, so an MCP restart or an unloaded Root cannot hide an existing owner. A `read_only` admission durably applies DSH's native `sandbox/mode=read-only` together with `approval/policy=never`; filesystem tools and sandboxed commands cannot write or obtain a one-shot elevation, and DSH children inherit the restriction. Writer admission applies `workspace-write` but never broadens the deployment/session approval policy. A deployment configured with more than one Host rejects writer tasks because those Hosts do not share admission authority; read-only work and reconnect discovery still support multiple Hosts. Parallel writers use independent Git worktrees, not a second workspace lock service.

`authority.maxDirectChildren` is also Host-enforced, not merely prompt advice. Before a configured child-start tool runs, the plugin atomically counts persisted direct children created in this run plus concurrent start reservations. Calls inside the cap proceed without another supervisor question; an over-limit call is denied, and failed starts release their slot. Both bundled child tools (`subagent` and `subagent_fork`) are guarded, and DSH's native `maxDepth: 1` forbids grandchildren; renamed or additional child tools belong in the plugin's `directChildToolNames` configuration. DSH root keeps orchestration ownership throughout.

An optional `tokenBudget.maxTokens` (or deployment default `DSH_DEFAULT_TASK_TOKEN_BUDGET`) is fixed in the durable task packet and enforced inside the independent Host across the root/descendant run tree. The Host atomically reserves each request before dispatch: DSH's token meter estimates the complete input envelope (surface, system prompt, and tools), concurrent requests cannot reserve the same remaining budget, and `maxTokens` is capped to the unreserved output allowance (`maxReservedOutputTokensPerRequest`, 8192 by default). If even the next input cannot fit, the Host makes no provider call and returns `token-budget-request-rejected` with used, remaining, and required-input figures; this is distinct from an already consumed `token-budget-exhausted` state. Provider-reported disjoint uncached-input, cache-read, cache-write, and output buckets settle admitted reservations afterward; cost estimation is deliberately excluded. This is a reliable cutoff, not a mathematically exact provider-billing cap: final total may cross the limit by tokenizer-estimation or provider-reporting variance, but no longer by multiple concurrent agents each claiming the same remaining allowance. Spawn, fork, nested, and later continuable-child activations are affiliated from DSH's existing durable lineage and accepted-work boundaries, so affiliation adds no model prompt or token charge. Fork seed usage is excluded, streaming/final samples use replacement semantics, and persisted cold descendants are reconciled before every model step and request. Budgeted waits, recovery, and run discovery read the same Host-owned durable run-tree fold and expose cumulative buckets plus counted sessions without a model call. `DSH_USAGE_MONITOR_URL` optionally reads the existing `dsh-usage-monitor` `/api/sessions` bridge for session-lifetime root comparison only; missing rows and monitor downtime are distinct, descendants are not included, and those readings never control the budget.

Decision rules live as immutable, versioned JSON files under `config/decision-policies/`. New runs pin the active policy version plus its canonical SHA-256 digest in the durable task packet; an optional shadow policy is pinned the same way but never controls timing or action. After an MCP restart the gateway resolves the pinned version from the catalog and fails closed if the file is missing or changed. To inspect a decision without running DSH, build once and run `pnpm policy:explain -- --policy config/decision-policies/2026-08-26.v1.json --facts '{"signal":"WORKER_DECISION","category":"information","impact":"low","blocking":false}'`; add `--shadow <file>` for an observer-only comparison. `dry-run` is an equivalent CLI command. The legacy `DSH_DECISION_POLICY_JSON` input remains migration-only; file configuration is preferred.

The queued prompt starts with the human-readable objective and embeds the durable task packet afterward. This keeps protocol validation unchanged while making new supervised sessions recognizable by task name in the DSH Web sidebar.

## Long handoff details

`supervisor_handoff.summary` is capped at 2048 characters. File lists (64), verification claims (32), attempted hypotheses (16), artifacts (16), and every model-facing string are bounded too; Host-side input validation rejects overflow, while the MCP fold defensively caps malformed or legacy output and reports the affected fields in `handoffTruncated`. When a task needs a longer report, write it as Markdown under `.dsh-handoff/<runId>/` (legacy v1: taskId) inside the session cwd, pass the relative path in `artifacts`, and reference it from the concise summary. The directory is gitignored. The handoff tool never writes handoff data itself — in particular, never to `~/.codex` or any other global directory. Artifact admission enforces containment: relative paths only, no traversal, symlinks, hardlinks, or non-regular files, hashed through a validated handle within the session cwd.

## Model-free run journal

At a durable run terminal state, the gateway writes one atomic JSON record under `.dsh-state/memory/runs/`. It reuses the bounded task objective (which may contain user-supplied text), accepted handoff, runtime project activity, verification, failure kind, and bounded decision history; it never calls a model (`modelCallsUsed: 0`) and never records heartbeat narration, reasoning, tool arguments, tool outputs, transcripts, or later chat/steer message bodies. Concurrent terminal writers publish with no-overwrite atomic creation, repeated terminal waits reuse the same run-id record, and the library exposes bounded cursor pages. Default retention is 10,000 records, 180 days, and 256 MiB; deployments can lower these with `DSH_RUN_JOURNAL_MAX_RECORDS`, `DSH_RUN_JOURNAL_MAX_AGE_DAYS`, and `DSH_RUN_JOURNAL_MAX_BYTES`. A journal write failure is reported as a warning on the observation and never changes the DSH outcome. Durable Host failures with a corresponding `turn/end` are recorded; temporary connectivity/protocol failures and stale-run requests are not.

## Release status

The source is licensed under MIT and prepared for public hosting at `yidapan666-creator/dsh-gate`: the DSH dependency is a public fork commit pinned by SHA, the working tree contains no machine-specific paths or secrets, and `pnpm verify` passes with the bootstrap-managed link. Publication as **npm packages is a separate, still-blocked decision**: the workspace packages keep `"private": true`, and a clean package install cannot build or run until the upstream DSH network-client seam is published (the fork pin works for source deployments, not for registry consumers).

The remaining upstream limitation is npm publication: the workspace packages stay private until the generic `@deepseek-ai/dsh-client-connection/network-client` exports are published upstream. The public fork pin at `7212c955438c70c9a2d168f67e85a8014b8d4488` makes source deployments reproducible today; it is not an upstream merge and no merge is claimed.

Source installation, build, tests, packaging checks, and the protocol contract are covered by the documented verification workflow.

See `docs/protocol.md` for state semantics, `docs/decision-policy-and-rag-research.md` for the intervention-policy design and unconnected RAG roadmap, `docs/manual-e2e.md` for the acceptance path, `docs/benchmark.md` for the evaluation design, `docs/source-provenance.md` for source and license traceability, and `docs/source-backed-reuse-review.md` for the historical design review. For contributors: `CONTRIBUTING.md`. For vulnerability reporting: `SECURITY.md`.
