# Codex DSH Supervisor

Let Codex supervise durable DeepSeek Harness (DSH) coding sessions through MCP—with reconnect, bounded execution, token budgets, and independent completion checks.

> The product and repository are **Codex DSH Supervisor**. The published package, CLI, MCP endpoints, and state directories retain the `dsh-gate` name for compatibility.

[System workflow](docs/diagrams/dsh-supervision-workflow.svg) · [Reviewed control loop](docs/diagrams/reviewed-supervision-control-loop.svg) · [中文快速上手](docs/quickstart-zh.md) · [Deployment guide](DEPLOYMENT.md)

## Quick start

```sh
npx @yidapan666/dsh-gate setup
```

The setup installs the matching release, configures Codex, installs the supervisor skill, starts the independent DSH Host, and runs a live health check. See [all installation and update options](docs/distribution.md).

Then ask Codex naturally:

> Use DSH in `/absolute/path/to/project` to fix the failing authentication tests. Use Standard mode with reviewed supervision, allow at most 3 direct child agents, enforce a 60000-token budget, open DSH Web, and report aggregated progress every five minutes.

The short form is also valid:

> Use DSH in `/absolute/path/to/project` to fix the failing authentication tests.

Missing routine constraints are filled without another model call. Standard mode, full-workspace writer scope, focused-then-full verification, material-only escalation, and at most five direct children are the defaults.

## Choose how DSH works

| Choice | Best for | Constraint |
| --- | --- | --- |
| **Standard** (default) | Coding, fixes, and normal repository work | Supports reviewed or delegated supervision |
| **PTC** | Broad read-only exploration and batchable searches | Delegated supervision only |
| **Minimal / Creator** | — | Rejected because they cannot satisfy the safety contract |

| Supervision | Codex involvement |
| --- | --- |
| **Reviewed** (default for writers) | Reviews material proposals, can pause/correct work, inspects the actual diff, and reruns relevant verification before acceptance |
| **Delegated** (default for read-only work) | Observes on the five-minute cadence and validates structured terminal evidence against Host facts |

## What it guarantees

- The DSH Host and sessions survive MCP or Codex restarts and can be rediscovered without replaying the task.
- A run is completed only after a valid supervisor handoff **and** its matching turn end; a turn end alone is never treated as success.
- Writers are isolated by Git worktree and checked against their admitted path scope; parallel writers require separate worktrees.
- Token budgets, child limits, execution leases, and read-only restrictions are enforced by the long-running Host—not only by prompt instructions.
- Five-minute observations report bounded progress, project activity, verification outcomes, tool counts, and token deltas without forwarding raw reasoning or logs.

<details>
<summary><strong>Source development setup</strong></summary>

```sh
pnpm bootstrap
pnpm run doctor
pnpm host:start
pnpm run doctor --live
pnpm skill:install -- --target /absolute/path/to/personal/skills
```

Copy `config/codex-mcp.example.toml` into the matching Codex configuration and replace `<workspace-root>` with this checkout's absolute path. The MCP executable is `packages/mcp-server/dist/cli.js`.

The source checkout pins the public DSH fork at commit `68dd149a1834496ced7308de5a7084328855f13e`. Bootstrap verifies that exact compatibility seam and refuses a dirty or mismatched checkout. See [DEPLOYMENT.md](DEPLOYMENT.md) for prerequisites, lifecycle commands, updating the pin, and recovery.

</details>

<details>
<summary><strong>How the supervision loop works</strong></summary>

1. Codex compiles one bounded task packet and admits it to one durable DSH Root.
2. DSH investigates and, in reviewed mode, submits material implementation proposals for a blocking Codex decision.
3. The Host grants only bounded execution phases and records durable identity, budget, lineage, and activity facts.
4. Codex observes at five-minute boundaries or immediately on approvals, material risk, failure, or protocol events.
5. Completion requires the worker handoff, matching turn end, Host checks, and Codex's independent diff and verification review.

Reconnect uses the durable `sessionId`, `runId`, request receipt, and observation cursor. Interrupted work resumes from a bounded recovery capsule; uncertain effects must be reconciled instead of blindly replayed. See the [protocol contract](docs/protocol.md).

</details>

<details>
<summary><strong>Packages, release model, and advanced components</strong></summary>

- `@dsh-gate/mcp-server` — MCP gateway, reconnect, observation, and control tools.
- `@dsh-gate/supervisor-tools` — Host-side admission, handoff, Git scope, budget, and execution enforcement.
- `@dsh-gate/decision-policy` — versioned intervention policy with explain, dry-run, and shadow evaluation.
- `@dsh-gate/run-journal` — bounded, atomic, model-free terminal run records.
- `@dsh-gate/rag-context` — standalone retrieval contracts and ranking baseline; not connected to live supervision.

Only the thin `@yidapan666/dsh-gate` installer is published to npm. It downloads an immutable, checksummed GitHub Release. npm, offline bundles, and source installs provide the same workflow when they target the same version; pushing `main` alone does not publish a release.

</details>

## Documentation

[Deployment](DEPLOYMENT.md) · [Distribution](docs/distribution.md) · [Protocol](docs/protocol.md) · [Chinese quickstart](docs/quickstart-zh.md) · [Manual E2E](docs/manual-e2e.md) · [Decision policy and RAG research](docs/decision-policy-and-rag-research.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
