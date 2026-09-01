# Contributing to dsh-gate

`dsh-gate` is an experimental workspace: a small MCP translation surface over DeepSeek Harness (DSH) plus a DSH-side plugin for durable supervisor handoffs. Before contributing, read the README (including the release-status blockers) and `docs/protocol.md`; the protocol contract is the compatibility boundary that must not drift.

## Development setup

```sh
pnpm bootstrap   # pinned DSH fork checkout, install, build, link, plugin install
pnpm verify      # typecheck + tests + build
```

`@dsh-gate/mcp-server` imports `@deepseek-ai/dsh-client-connection/network-client`, which is not published. The bootstrap fetches the pinned public fork commit (`68dd149a1834496ced7308de5a7084328855f13e` — see `DEPLOYMENT.md` for the contract and update policy), builds it, and reuses `scripts/link-local-dsh.mjs` to link the seam into `packages/mcp-server/node_modules`. A development checkout already at the pinned commit can be used directly:

```sh
node scripts/dsh-gate.mjs bootstrap --dsh-repo /path/to/verified/deepseek-harness
```

The bootstrap/doctor/Host workflow is documented in `DEPLOYMENT.md`; its focused tests live in `scripts/tests/`.

## Continuous integration

The GitHub Actions workflow runs on pull requests and pushes to `main` with Node 24 and pnpm 11.19.0. It executes `pnpm bootstrap` from a clean checkout, then `pnpm verify`; bootstrap needs network access to the pinned public DSH fork commit and the npm registry and never uses pre-seeded state.

## Handoff and long reports

`supervisor_handoff.summary` stays at or below 2048 characters. Longer task reports are written under the gitignored `.dsh-handoff/<taskId>/` directory inside the session cwd and admitted as relative-path artifacts — never to global directories such as `~/.codex`.

## What belongs here

- New MCP tools, wait-fold behavior, writer-admission policy, and artifact validation belong in this workspace, with focused tests.
- The supervisor-tools plugin's handoff and reported-failure budget behavior belongs in `packages/dsh-supervisor-tools`.
- DSH-core changes (for example the generic network-client seam) must stay out of this repository; they belong upstream as generic patches without dsh-gate vocabulary.

## Testing expectations

- Tests live next to the code under `packages/*/tests` and run with Vitest.
- Add a focused regression test alongside any risky behavior change; the suite is intentionally fast.
- Do not weaken protocol semantics to make a test pass: typed failures, observation cursors, valid-handoff-plus-turn-end completion, and root ownership of children are invariants.
- Host-runtime changes under `packages/dsh-supervisor-tools/src` or its Cordis patch require `pnpm build-id:update`. Build and typecheck fail while the content-derived identity is stale, so a running old Host cannot satisfy a newly built MCP by reusing the package version string.

## Review workflow

Do not commit directly to a shared baseline without review. Keep changes minimal and mechanical; prefer the smallest in-memory critical section over new lock services, and document cross-process limitations honestly rather than claiming more than the code enforces.
