# Deploying dsh-gate

This guide is the single source of truth for turning a fresh `dsh-gate` checkout
into a running deployment: one deterministic bootstrap, one doctor, and one
explicit Host start. It is written for both human operators and AI operators —
every command below is copy-pasteable and none of them improvise source edits.

## What the deployment is

```
┌────────────────────────────┐      HTTP/WS        ┌──────────────────────────────┐
│ dsh-gate MCP server        │ ──────────────────► │ DSH Web Host (independent)  │
│ (Codex side, stdio)        │  /api/* + events    │ node <checkout>/apps/cli/... │
└────────────────────────────┘                     └──────────────────────────────┘
        ▲                                                      │ owns
        │ imports the network client                          ▼
        └── linked from the pinned DSH fork commit      agents, sessions, web UI
```

- The **MCP server** (`packages/mcp-server/dist/cli.js`) is only a network
  client. It imports `@deepseek-ai/dsh-client-connection/network-client`,
  which is linked from the pinned DSH fork commit into the isolated checkout.
- The **DSH Web Host** is a separate process (`dsh web` from the same pinned
  checkout) that owns agents, sessions, and the browser UI at
  `http://127.0.0.1:8080`. It is **independent of MCP**: restarting or
  stopping MCP never touches it, and stopping the Host never stops MCP.
- The **supervisor plugin** (`@dsh-gate/supervisor-tools`) is installed into
  the DSH web profile inside an **isolated, project-local DSH home**, so
  nothing is written to `~/.dsh` or any other global location.

## The compatibility contract

The generic DSH network-client seam does not exist in any published DSH
release. This project consumes it from a public fork at **exactly one commit**:

- fork: `https://github.com/yidapan666-creator/deepseek-harness.git`
- commit: `7212c955438c70c9a2d168f67e85a8014b8d4488`
- branch (informational only): `codex/mcp-network-client`

The **commit SHA, never the branch**, is the compatibility contract. Bootstrap
fetches by SHA; doctor refuses a checkout whose `HEAD` is not that SHA or whose
remote does not identify the fork.

### Update policy

To move to a newer fork commit: change `DSH_PINNED_COMMIT` (and
`DSH_FORK_URL`/`DSH_FORK_BRANCH` if they change) in
`scripts/dsh-gate-lib.mjs`, remove the managed checkout
(`.dsh-state/dsh`), and re-run `pnpm bootstrap`. Never edit the pinned
checkout by hand, never point the workflow at a moving branch, and never
"fix" a build failure by patching the checkout — the checkout must stay
byte-identical to the pinned commit or bootstrap/doctor refuse it.

### The official-upstream-PR limitation

The compatibility commit lives on the public fork. It has **not** been merged
into the upstream `deepseek-ai/deepseek-harness` repository, and nothing in
this repository claims or guarantees an upstream merge. The upstream PR is the
official path to eventually replacing the fork pin with a published release;
until that happens, the fork pin is the compatibility contract and the
bootstrap exists precisely so nobody has to hand-apply a patch.

## Prerequisites

- **Node.js** `^22.19 || >=24` (the DSH engine requirement).
- **git**.
- **pnpm** `11.x` on PATH. When `corepack` works on your machine, the
  workflow prefers the repository-pinned pnpm version through it and falls
  back to the `pnpm` on PATH otherwise (all 11.x share the lockfile format
  used by both repositories). The effective version is recorded in
  `.dsh-state/install.json`.
- Network access to `github.com` (the fork fetch) and the npm registry
  (dependency installs). The Host does not need a browser — `--no-open` is
  always used.

## One-command bootstrap

```sh
pnpm bootstrap
```

Bootstrap installs the DSH-side plugin into the isolated project home but does
not guess a user-global Codex skill directory. Install the repository's Codex
supervisor skill into the explicit personal skill directory used by your Codex
installation, then restart Codex:

```sh
pnpm skill:install -- --target /absolute/path/to/personal/skills
```

The command refuses to overwrite an existing install unless `--force` is
supplied; forced updates preserve the previous directory as a timestamped
sibling backup.

Runs, in order, the following phases (each idempotent; re-running is a no-op
when everything is already current — pass `--force` to rebuild):

1. **checkout** — if `.dsh-state/dsh` is absent, `git init` + add the fork
   remote + `git fetch --depth 1 origin <sha>` + `git checkout --detach
   FETCH_HEAD`. If it is present, validate origin identity, exact `HEAD`, and
   full worktree cleanliness (tracked and untracked paths). A dirty or mismatched checkout is **refused
   with an actionable message — never cleaned, reset, or overwritten**.
2. **dsh-install** — `pnpm install --frozen-lockfile` inside the checkout.
3. **dsh-build** — `pnpm build` inside the checkout (lib + web frontend).
4. **gate-install** — `pnpm install --frozen-lockfile` in this repo.
5. **link** — `node scripts/link-local-dsh.mjs <checkout>`: the exact
   network-client link into `packages/mcp-server/node_modules`.
6. **gate-build** — `pnpm build` in this repo.
7. **plugin** — `DSH_HOME=<state>/dsh-home <checkout>/apps/cli/lib/bin.js
   plugin --profile web add <repo>/packages/dsh-supervisor-tools`.
8. **metadata** — write `.dsh-state/install.json`.

Bootstrap **never starts the Host** — that is a separate, explicit step
(`pnpm host:start`, or the configured `DSH_HOST_LAUNCH`).

### Operational state lives in `.dsh-state/` (gitignored)

| Path | Contents |
|---|---|
| `.dsh-state/dsh` | managed DSH fork checkout at the pinned commit |
| `.dsh-state/dsh-home` | isolated `DSH_HOME` (profiles, patches, state) |
| `.dsh-state/install.json` | install metadata (pin, paths, versions) |
| `.dsh-state/logs/host.log` | detached Host output |
| `.dsh-state/host/host.pid` | Host process record (pid, argv, url) |

`.dsh-state/` is in `.gitignore`: none of it can enter the public repository.
Normal workspace build products (`node_modules/`, package `dist/` directories,
and the network-client link under `packages/mcp-server/node_modules/`) also
remain in their existing gitignored locations.

## Verify with doctor

```sh
pnpm run doctor                              # all offline checks
pnpm run doctor --live                      # also probe a live Host on 127.0.0.1:8080
pnpm run doctor --live --host http://127.0.0.1:9000
```

Checks: install metadata, managed checkout (pin + fork identity + clean),
DSH build outputs (CLI, network-client lib, web dist), network-client link
target, built MCP entry, supervisor plugin/profile state, and — with
`--live` — a live Host's `protocolVersion` (must be `1`), `hostInstanceId`,
and a non-placeholder `version`. Any failed check exits non-zero with the
reason; the live check is optional and skipped without `--live`.

## Host lifecycle (independent of MCP)

```sh
pnpm host:start      # start the DSH Web Host on http://127.0.0.1:8080
pnpm host:status     # is it running? which hostInstanceId?
pnpm host:stop       # stop only the Host this checkout started
```

`host:start` verifies the checkout and profile first, then spawns
`node <checkout>/apps/cli/lib/bin.js web --host 127.0.0.1 --port 8080
--no-open` **detached** with `DSH_HOME` set to `.dsh-state/dsh-home`, cwd set
to this repository, output appended to `.dsh-state/logs/host.log`, and waits
for `/api/host.describe` to answer. `host:stop` kills **only** the pid
recorded in `.dsh-state/host/host.pid` — and only after verifying its command
line matches the dsh-gate Host, so it never kills an unrelated process. A Host
started outside dsh-gate is never touched.

- **Stopping MCP never stops the Host.** The MCP server holds no kill
  capability; its connection close only stops its own client.
- **Optional auto-launch:** set `DSH_HOST_LAUNCH` in the MCP environment to
  `{"argv":["node","<workspace-root>/scripts/dsh-gate.mjs","host","start"]}`
  (see `config/codex-mcp.example.toml`). The launch is detached with ignored
  stdio; MCP never retains a kill capability, and `pnpm host:stop` remains
  the stop path.
- **Browser visibility:** the Host serves the DSH Web UI itself at
  `http://127.0.0.1:8080`. Bootstrap and host commands never open a browser
  (`--no-open`); open the URL manually when you want the UI.

## Wiring Codex

1. `pnpm bootstrap` (once).
2. Copy `config/codex-mcp.example.toml` into your Codex config, replacing
   `<workspace-root>` with this checkout's absolute path. That placeholder is
   the only machine-specific value.
3. `pnpm host:start` (or rely on `DSH_HOST_LAUNCH`).
4. Use the MCP tools; `dsh_start_or_connect` connects to the live Host.

## Clean failure recovery

- **Bootstrap refuses a dirty/mismatched checkout** — it prints the failing
  phase, the exact command, and the reason, and never performs destructive
  recovery (no `clean`, `reset`, `stash`, `checkout --force`, or deletion).
  To recover deliberately: move the offending checkout aside yourself
  (for example `mv .dsh-state/dsh .dsh-state/dsh.broken`), or point at a
  clean checkout with `--dsh-repo <path>`.
- **Any phase failure** reports `phase "<name>" failed`, the command argv,
  the exit code, and a bounded, credential-redacted output tail — never the
  full environment. Fix the stated cause and re-run; bootstrap resumes from
  where it stopped (markers in `.dsh-state/install.json`).
- **To start completely fresh:** remove `.dsh-state/` and re-run
  `pnpm bootstrap`. Bootstrap also performs the ordinary gitignored workspace
  install/build writes (`node_modules/`, package `dist/`, and the
  network-client link); it never rewrites tracked source files.
- **To use an existing verified DSH checkout** instead of a fresh clone
  (for example during development/acceptance): pass
  `--dsh-repo /absolute/path/to/checkout`. It must be at the pinned commit
  and carry the fork remote, or it is refused. This path is never committed
  anywhere.

## Options

```sh
node scripts/dsh-gate.mjs bootstrap [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--dry-run] [--force]
node scripts/dsh-gate.mjs doctor   [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--live] [--host URL]
node scripts/dsh-gate.mjs host     start|status|stop [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--host URL] [--dry-run]
```

`--dry-run` prints the exact plan (phases, commands, cwd) and changes
nothing. `--state` relocates the whole `.dsh-state/` tree; `--dsh-repo` and
`--dsh-home` override just the checkout and the DSH home.

## Tests

```sh
pnpm test            # includes scripts/tests/dsh-gate-lib.spec.ts
pnpm verify          # typecheck + tests + build (the repository gate)
```

The workflow's unit tests cover argument parsing, dry-run planning, dirty /
mismatched checkout refusal, exact-pin checks, link reuse, doctor outcomes,
and command-failure phase reporting — all with fakes, no network.
