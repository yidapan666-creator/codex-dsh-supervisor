# Contributing to dsh-gate

`dsh-gate` is an experimental workspace: a small MCP translation surface over DeepSeek Harness (DSH) plus a DSH-side plugin for durable supervisor handoffs. Before contributing, read the README (including the release-status blockers) and `docs/protocol.md`; the protocol contract is the compatibility boundary that must not drift.

## Development setup

```sh
pnpm install
pnpm verify   # typecheck + tests + build
```

The `@dsh-gate/mcp-server` package imports `@deepseek-ai/dsh-client-connection/network-client`, which is not yet published. Until the upstream DSH release lands, typechecking and building require the local development link described in the README:

```sh
node scripts/link-local-dsh.mjs /path/to/deepseek-harness
```

Without the link, `pnpm verify` fails at the mcp-server typecheck. This is a known upstream blocker, not a local breakage to "fix" by vendoring DSH source.

## What belongs here

- New MCP tools, wait-fold behavior, writer-admission policy, and artifact validation belong in this workspace, with focused tests.
- The supervisor-tools plugin's handoff and reported-failure budget behavior belongs in `packages/dsh-supervisor-tools`.
- DSH-core changes (for example the generic network-client seam) must stay out of this repository; they belong upstream as generic patches without dsh-gate vocabulary.

## Testing expectations

- Tests live next to the code under `packages/*/tests` and run with Vitest.
- Add a focused regression test alongside any risky behavior change; the suite is intentionally fast.
- Do not weaken protocol semantics to make a test pass: typed failures, observation cursors, valid-handoff-plus-turn-end completion, and root ownership of children are invariants.

## Review workflow

Do not commit directly to a shared baseline without review. Keep changes minimal and mechanical; prefer the smallest in-memory critical section over new lock services, and document cross-process limitations honestly rather than claiming more than the code enforces.
