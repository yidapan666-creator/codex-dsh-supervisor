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
supplied. Forced updates preserve the previous directory under the adjacent
non-discoverable `skill-backups/codex-dsh-supervisor/` directory; older sibling
backups are migrated there automatically so Codex discovers only one active
skill.

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
8. **worker-skill** — atomically install the repository's
   `dsh-supervised-worker/SKILL.md` into the isolated `DSH_HOME/skills`
   catalog.
9. **metadata** — write `.dsh-state/install.json`.

Bootstrap **never starts the Host** — that is a separate, explicit step
(`pnpm host:start`, or the configured `DSH_HOST_LAUNCH`).

The Codex MCP example sets `tool_timeout_sec = 360`: `dsh_wait` may use the
full 300-second cadence and still needs bounded connection and authoritative
refresh headroom before returning its aggregated observation.

### Operational state lives in `.dsh-state/` (gitignored)

| Path | Contents |
|---|---|
| `.dsh-state/dsh` | managed DSH fork checkout at the pinned commit |
| `.dsh-state/dsh-home` | isolated `DSH_HOME` (profiles, patches, state) |
| `.dsh-state/install.json` | install metadata (pin, paths, versions) |
| `.dsh-state/logs/http-<host>-<port>.log` | detached Host output, isolated by Host origin |
| `.dsh-state/host/http-<host>-<port>.pid` | Host process record (pid, argv, url), isolated by Host origin |
| `.dsh-state/host/http-<host>-<port>.start.lock` | short-lived per-origin Host startup lease; absent outside startup |

`.dsh-state/` is in `.gitignore`: none of it can enter the public repository.
Normal workspace build products (`node_modules/`, package `dist/` directories,
and the network-client link under `packages/mcp-server/node_modules/`) also
remain in their existing gitignored locations.

## Verify with doctor

```sh
pnpm run doctor                              # all offline checks
pnpm run doctor --live                      # also probe a live Host on 127.0.0.1:8080
pnpm run doctor --live --host http://127.0.0.1:9000
pnpm run doctor --live --session <sessionId> # also check provider/model routing; no model call
```

Checks: install metadata, managed checkout (pin + fork identity + clean),
DSH build outputs (CLI, network-client lib, web dist), network-client link
target, built MCP entry, supervisor plugin/profile state, and — with
`--live` — a live Host's `protocolVersion` (must be `1`), `hostInstanceId`,
and a non-placeholder `version`. With `--session`, doctor also calls the
session's read-only model-routing endpoint and requires the current
provider/model to be explicitly routable. Failures from unrelated provider
catalogs remain advisory. That check spends no tokens;
only an explicitly dispatched real task can prove that credentials and the
provider request path work end to end. Any failed check exits non-zero with the
reason; live checks are optional and skipped without `--live`.

## Host lifecycle (independent of MCP)

```sh
pnpm host:start      # start the DSH Web Host on http://127.0.0.1:8080
node scripts/dsh-gate.mjs host run  # foreground mode for launchd/systemd
pnpm host:status     # is it running? which hostInstanceId?
pnpm host:stop       # stop only the Host this checkout started
# For a custom port, pass the same URL to every lifecycle command:
node scripts/dsh-gate.mjs host start --host http://127.0.0.1:18080
node scripts/dsh-gate.mjs host status --host http://127.0.0.1:18080
node scripts/dsh-gate.mjs host stop --host http://127.0.0.1:18080
```

`host:start` verifies the checkout and profile first, then spawns
`node <checkout>/apps/cli/lib/bin.js web --host 127.0.0.1 --port 8080
--no-open` **detached** with `DSH_HOME` set to `.dsh-state/dsh-home`, cwd set
to this repository, output appended to its origin-scoped log, and waits
for `/api/host.describe` to answer. `host:stop` kills **only** the pid
recorded in that origin's PID file — and only after verifying its command
line matches the dsh-gate Host, so it never kills an unrelated process. A Host
started outside dsh-gate is never touched. Local launch accepts only an HTTP
loopback origin with no path, query, credentials, or fragment. Different ports
have separate PID files, readiness leases, and logs, so inspecting or operating
one Host cannot clear ownership for another. Legacy `host.pid` records are read
only when their recorded URL exactly matches the requested origin.

For continuous crash restart, copy the platform example from
`config/launchd/com.dsh-gate.host.plist.example` or
`config/systemd/dsh-gate-host.service.example`, replace every absolute-path
placeholder, and let it execute `host run`. That mode keeps the wrapper
attached, holds the cross-process startup lease until `/api/host.describe`
answers, forwards termination signals, writes the same verified PID record,
and exits when the Host exits so the OS supervisor can restart it. Do not put
API keys in a committed service definition; use the provider's DSH profile or
the platform's secret facility. Unload or disable the launchd/systemd unit
before `pnpm host:stop`; an enabled `KeepAlive`/`Restart` policy will otherwise
correctly start the Host again.

Run `pnpm bootstrap` before loading either service definition. Bootstrap
pre-creates `.dsh-state/logs`, which launchd requires because it opens the
configured stdout/stderr path before starting `host run`.

Concurrent starts are safe at both layers. One MCP process coalesces its own
overlapping launch requests, while `host:start` takes an exclusive,
cross-process, per-origin startup lease across PID/port discovery and the readiness probe.
Other MCP processes wait, then reconnect to the winner instead of spawning a
second Host. This lease is only for Host startup; it is not a working-tree
writer lock manager. If a `host:start` process is killed before its `finally`
cleanup, the lease is deliberately not guessed stale. Confirm that no
`host:start` process remains, then remove
the reported origin-scoped `.start.lock` manually and retry.

- **Stopping MCP never stops the Host.** The MCP server holds no kill
  capability; its connection close only stops its own client.
- **Optional auto-launch:** set `DSH_HOST_LAUNCH` in the MCP environment to
  `{"argv":["node","<workspace-root>/scripts/dsh-gate.mjs","host","start"]}`
  (see `config/codex-mcp.example.toml`). The launch is detached with ignored
  stdio; concurrent MCP launch requests converge through the startup lease,
  MCP never retains a kill capability, and `pnpm host:stop` remains the stop
  path. A custom launch command that bypasses `scripts/dsh-gate.mjs host
  start` must provide its own cross-process idempotency.
- **Browser visibility:** the Host serves the DSH Web UI itself at
  `http://127.0.0.1:8080`. Bootstrap and host commands never open a browser
  (`--no-open`); open the URL manually when you want the UI.

### Disconnect and crash behavior

- **Codex/MCP exit or network interruption:** the Host-owned agent and session
  keep running. The network client reconnects with bounded backoff; after an MCP
  restart use `dsh_runs` when identity is unknown, then `dsh_recover` and
  `dsh_wait`. Never replay the objective.
- **Ambiguous task dispatch:** retry `dsh_task` with the original `requestId`
  and byte-equivalent task fields. Host-side atomic admission returns the
  existing durable `runId` receipt; changing the payload under one request id
  is rejected. A genuinely new task waits until the session is idle.
- **Host process crash:** no client-side adapter can keep an in-memory model
  request alive. With `DSH_HOST_LAUNCH`, the next locate/recover call relaunches
  the detached Host; with the supplied launchd/systemd examples, `host run`
  lets the OS restart it continuously. DSH reloads the durable session and
  closes the orphaned turn as `interrupted`. `dsh_recover` returns
  `CONTINUATION_REQUIRED` plus a runtime-derived `recoveryCapsule` capped at
  16 KiB. It folds the complete affiliated run tree and includes every folded
  session's durable activation/terminal boundaries. Queue a new bounded task
  with both the exact `parentRunId` and capsule instead of guessing success or
  replaying the full prompt. Admission recomputes the capsule from refreshed
  Host history and rejects missing, fabricated, stale, cross-session, or
  child-incomplete evidence before a provider call. The capsule contains
  no tool arguments, tool outputs, transcript, or file contents. Its
  `uncertainEffects` ledger lists only calls with possible side effects and no
  durable correlated `tool/result`, together with the owning session; reconcile
  those effects before retrying.

### Per-task token budget

Pass `tokenBudget.maxTokens` to `dsh_task`, or configure
`DSH_DEFAULT_TASK_TOKEN_BUDGET`. The value is pinned in the task packet and the
DSH-side plugin enforces it even when Codex/MCP is disconnected. It aggregates
provider-reported uncached input, cache read/write, and output across the run's
root and persisted descendants; it never converts tokens to estimated money.
Spawn, fork, nested, and reused continuable-child activations are affiliated
from durable `parentSession`, task-packet, and accepted-work boundaries. This
does not inject another model message or spend tokens, and inherited fork seed
usage is not counted twice. Cold descendants are reconciled after Host restart.
Before dispatch, DSH's token meter estimates the complete request input and the
Host atomically reserves that input plus a capped output allowance across the
run tree. Concurrent agents therefore cannot claim the same remaining budget;
requests wait for live reservations to settle near the boundary. The plugin's
`maxReservedOutputTokensPerRequest` setting (8192 by default) bounds each call's
output reservation. A request whose complete input cannot fit is rejected
before any provider call and reports used, remaining, and required-input token
figures instead of claiming the existing usage already exhausted the limit.
Provider usage settles admitted estimates afterward, so this is a
reliable cutoff rather than an exact billing cap: tokenizer-estimation or
provider-reporting variance can still carry the final total past the limit. Optional
`DSH_USAGE_MONITOR_URL=http://127.0.0.1:41999` reads the existing
`dsh-usage-monitor` bridge for session-lifetime root comparison only; it does
not include descendants. Missing rows and bridge downtime are reported
separately, neither can stop a task, and monitor totals are never enforcement
authority. The Host's own read-only budget endpoint uses the enforcement fold
and adds the cumulative run-tree buckets and counted sessions to budgeted
wait/recover/run-discovery observations without a model call.

### Writer topology

The Host plugin performs one atomic writer check-and-admit across all MCP
clients connected to that Host. A writer request is rejected when more than one
Host URL is configured because independent Hosts have no shared admission
authority. Multi-Host discovery and read-only work remain supported. Use one
Host per writer topology and independent Git worktrees for parallel writers;
there is no separate workspace lock manager.

### Run-journal retention

Terminal run records publish atomically without overwriting a concurrent
winner. Defaults retain at most 10,000 records, 180 days, and 256 MiB. Lower the
limits with `DSH_RUN_JOURNAL_MAX_RECORDS`,
`DSH_RUN_JOURNAL_MAX_AGE_DAYS`, and `DSH_RUN_JOURNAL_MAX_BYTES`; set
`DSH_RUN_JOURNAL_ENABLED=false` to disable journal writes. The journal library
provides bounded cursor pages so consumers do not need to load the retained set
at once.

### Direct-child authority

`authority.maxDirectChildren` is enforced in the DSH Host before child creation,
including parallel start attempts. The bundled profile guards both `subagent`
and `subagent_fork`, and sets DSH's native absolute `maxDepth: 1` on both so a
Root may create direct children but those children cannot create grandchildren.
If a deployment renames either tool or mounts another direct-child
creation tool, add every such name to the supervisor plugin's
`directChildToolNames` list; startup rejects an empty list rather than silently
disabling the authority boundary. The counter uses persisted direct-child
session creation facts for the current run and does not move orchestration
ownership from the DSH root to MCP/Codex.

## Wiring Codex

1. `pnpm bootstrap` (once).
   This also installs `skills/dsh-supervised-worker/SKILL.md` into the isolated
   `DSH_HOME/skills` catalog. Re-run bootstrap after updating that contract;
   doctor and Host startup reject a missing or stale installed copy.
2. Copy `config/codex-mcp.example.toml` into your Codex config, replacing
   `<workspace-root>` with this checkout's absolute path. That placeholder is
   the only machine-specific value.
3. `pnpm host:start` (or rely on `DSH_HOST_LAUNCH`).
4. Use the MCP tools; create with `dsh_start_or_connect` and the target
   project's absolute `cwd`. The gateway resolves and validates that directory
   before creating the session, so the DSH Web UI is rooted at the intended
   workspace. Omit `agentPreset` for Standard mode or pass `code` for PTC mode;
   both preserve the strict supervision fold. Minimal and Creator sessions are
   rejected because their capability boundaries do not match supervised
   project work. Reconnect with the existing `sessionId`; omit `cwd` and
   `agentPreset`, or provide the same values only. A conflicting reconnect is
   rejected rather than silently moving, recomposing, or recreating the
   session.

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
node scripts/dsh-gate.mjs doctor   [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--live] [--host URL] [--session ID]
node scripts/dsh-gate.mjs host     start|run|status|stop [--state DIR] [--dsh-repo DIR] [--dsh-home DIR] [--host URL] [--dry-run]
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
