# Codex DSH Supervisor protocol

Codex DSH Supervisor is a stateless MCP-facing supervisor over an independently owned DSH Host. The Host owns agents, sessions, persistence, and its process lifetime. MCP owns only network connections and in-memory observations; exiting MCP calls `ConnectionController.stop()` and never signals or kills the Host. Existing `dsh-gate` wire and package identifiers remain stable compatibility surfaces.

Creating a session requires an absolute target-project `cwd`. MCP resolves it
to a real path, verifies that it exists and is a directory, and passes that
canonical path to the Host. A reconnect uses the session's durable cwd; if the
caller supplies a different cwd, the request fails instead of silently moving
the session. This keeps the DSH Web workspace and artifact boundary attached to
the project the user selected.

## Completion boundary

The worker receives a durable task packet containing the durable `sessionId`, a unique per-execution `runId`, and a random completion token. Legacy schema-version-1 packets remain readable, but new runs emit schema version 2. `COMPLETED` requires all of these facts in one turn:

1. a `supervisor_handoff` call whose session id, run id, and token match the latest task packet;
2. a successful correlated `tool/result` whose output was accepted;
3. the corresponding `turn/end` after that result.
4. every descendant session affiliated with that run has settled.

A completed `turn/end` without the handoff facts is `FAILED` with `MISSING_HANDOFF`. A valid Root handoff with an affiliated child still running remains `WAITING/children-running`; an inactive child without a durable terminal boundary remains `WAITING/child-settlement-unverified`. Once children settle, their latest terminal time is a completion watermark: the Root must integrate the reports and publish a newer valid handoff plus corresponding `turn/end`, otherwise the run remains `WAITING/root-rehandoff-required`. A child's durable token-budget stop takes precedence over an older Root handoff. Other failures use `WORKER_FAILED`, `HOST_FAILED`, or `PROTOCOL_ERROR`. Every wait, recover, and control call for a v2 run carries `sessionId + runId`; a stale run is rejected before it can observe or mutate the newer execution and never carries a contradictory `REATTACHED` marker.

Schema v2 may pin a caller `requestId`, its task-payload digest, and a
`budget.maxTokens`; new packets also pin the deterministic
`instructionProfile=engineering-v1`. Before admission, the gateway fills only
missing routine engineering defaults (writer scope, preservation/safety,
acceptance, focused-then-full verification, material-only escalation, and at
most five direct children). Explicit caller values—including zero—win, and the
compiler consumes no model tokens. Admission is a Host-owned operation: the supervisor plugin
serializes requests per session, checks every durable inbox/message packet
carrying the request id, queues the prompt through the Host API, and flushes the
inbox insertion before returning its stable run receipt. A same-id, same-digest
retry returns the original run id; a different digest is rejected. New
admission to a running session is rejected rather than parked in an unconfirmed
next-turn queue. The budget is enforced by the DSH Host plugin rather than MCP,
so client disconnect does not reset it. Before each model call, the Host uses
DSH's public prompt/request hooks and token meter to reserve the estimated full
input plus a bounded output allowance atomically across the run tree. A request
temporarily blocked by another live reservation waits for settlement; it does
not oversell or cancel that request.

A multi-part request carries one `executionBrief` in the same durable packet:
1–5 cohesive workstreams, unique ids, an acyclic dependency graph, bounded
scope/evidence hints, Root/child-candidate labels, observable per-stream done
conditions, and Root integration duties. The complete structure is capped at
16 KiB and included in the idempotency digest. Codex creates it in its existing
reasoning turn rather than invoking another planner. DSH Root decides actual
fanout and integrates every result; workstream hints never broaden
`allowedScope`. Atomic tasks record `SINGLE_STREAM_FALLBACK`.

## Observation cursor

`asOfSeq` is the highest DSH session event sequence observed while producing a response. `boundarySeq` is the event sequence that established the returned state. `afterAsOfSeq` only states the caller's prior observation and is never passed to DSH `events.mux({ since })`, because DSH v1 does not implement a usable server resume cursor. Reconnect always refreshes authoritative history.

The `dsh_task` receipt separates admission from observation: `admissionBoundarySeq` (also returned as the convenience field `initialWaitAfterAsOfSeq`) is the exact durable task-packet/inbox boundary, while `observedAsOfSeq` is the latest event seen before the receipt returned. Early worker events may already be included in `observedAsOfSeq`, so the first `dsh_wait` must use `afterAsOfSeq=initialWaitAfterAsOfSeq`. Later waits carry the preceding observation's `asOfSeq` normally.

Before creating, reconnecting, locating, or resuming a session, MCP validates the plugin-owned `GET /api/dsh-gate.describe` endpoint in addition to DSH's generic `host.describe`. The descriptor pins the gate protocol, plugin/build identity, worker protocol, and required capability set. A generic Host with a missing, stale, or partially loaded supervisor plugin fails closed before task admission. `doctor --live` and managed Host startup apply the same readiness gate.

Every generic HTTP/RPC/WebSocket carrier and each plugin-owned endpoint requires
the same Host bearer credential. Bootstrap creates a non-symlink regular token
file with owner-only permissions, and MCP refuses an unsafe token file. Plain
HTTP is valid only on loopback; remote endpoints require HTTPS. The Web client
accepts the local token through a URL fragment, then sends it as a header or
WebSocket query credential without putting it in the initial HTTP request.

`dsh_wait` runs a five-minute aggregated progress cadence: with the default timeout (300000 ms) it returns about one observation per window and returns early when the attached decision outcome says `timing=immediate`. Terminal state, approval/question, checkpoint, blocker, escalation, and Host/protocol failure are locked protocol boundaries; structured worker requests are evaluated by the versioned worker policy. Ordinary event churn does not produce rapid repeated wait calls. The `WAITING` return at the window boundary is `wait.reason=TIMEOUT` with the aggregate `progress` since the caller's observation cursor; `workerState` independently says whether the worker was `RUNNING`, `IDLE`, or `UNKNOWN` at the observation. The `PROGRESS` wait reason remains in the schema for compatibility but is not emitted by the current cadence.

New runs pin the active decision-policy version and canonical SHA-256 digest in
their durable packet. An optional shadow policy is pinned beside it. On MCP
restart the catalog must still contain byte-semantically identical parsed policy
content for those identities; a missing or changed pin fails closed. Shadow
evaluation uses the same facts and engine, but only the active `decision` may
control return timing or action. `decisionShadow` is comparison evidence.

Codex must surface aggregated progress during long runs and repeat root step/tool/token figures and verification results in its terminal response. MCP output entering model context is not itself a user-visible report.

Bootstrap installs the versioned `dsh-supervised-worker` skill into the isolated
DSH Home. Each queued Root prompt contains DSH's native
`/dsh-supervised-worker` gesture, so the skill body is injected before task
execution. A missing or stale installed copy is a deployment failure rather
than an implicit fallback to prose-only instructions.

## Safety boundaries

- One nonterminal writer task is allowed per real working tree: the writer domain is the nearest ancestor carrying a `.git` worktree marker, so different subdirectories of one worktree share a domain and linked worktrees remain distinct; a non-Git directory falls back to its exact `realpath`. Read-only roots may coexist, but a Root cannot accept a new run of either mode while its previous supervised run has an unfinished Root turn, pending follow-up, or active/pending descendant. Parallel writers require distinct existing Git worktrees; there is no workspace lock manager. One Host-local critical section serializes writer check-and-admit across every MCP client, and its ownership scan includes attached agents plus cold persisted sessions. A writer dispatch fails closed unless exactly one Host URL is configured, because separate Hosts have no shared atomic admission authority; read-only discovery and work remain multi-Host capable.
- Writer execution additionally requires a Git worktree. Inside the same Host admission critical section, the runtime fsyncs an authoritative HEAD and fingerprints every pre-existing dirty path before the provider can run. Caller baseline prose is not an authority. Writer `allowedScope` entries are workspace-relative path prefixes; absent scope means the complete session cwd, while absolute/traversing scope is rejected. A `completed` handoff is rejected if the recomputed task-era committed or uncommitted path set escapes those prefixes. Unchanged pre-existing dirty files are not attributed to the worker; further edits or reverts of those files are.
- A writer lease belongs to the queued/active run. Its root `turn/end` is necessary but does not release the lease while a descendant agent is still running or the root has queued follow-up work; an `interrupted` turn also retains ownership until the same Root supplies an exact Host-validated continuation. Other terminal reasons release once the tree is quiet. This prevents both an early root handoff and a crash boundary with uncertain effects from overlapping another writer.
- `read_only` is an execution boundary, not prompt advice. Host admission appends DSH's native `sandbox/mode=read-only` and `approval/policy=never` before queueing the packet. DSH filesystem and bash sandbox consumers resolve that durable policy for each call, one-shot elevation is rejected, and child agents inherit it. Writer admission applies `workspace-write` but never broadens an existing approval policy; changing `never` back to `ask` remains an explicit user/deployment action.
- Artifact admission starts from the authoritative `session.list` cwd, requires path containment, rejects absolute paths, traversal, symlinks, hardlinks, and non-regular files, and hashes through a validated open file handle (so the file fstat'ed is the file hashed) with per-artifact and total byte limits; admission is sequential and never loads an artifact wholly into memory.
- Handoff output is bounded before it can enter supervisor context: summary 2048 characters, stage 128, file list 64 × 256, verification 32 entries with 256-character commands and 512-character summaries, blocker 1024, failure signature 256, attempted hypotheses 16 × 512, and artifact paths 16 × 512. Reported recovery failures separately cap signature at 256, summary at 1024, and hypothesis at 512, and only the currently addressed Root may consume that recovery budget. DSH rc.8's public tool-schema DSL validates the structure but does not support JSON Schema length/count keywords, so the authoritative bounds are enforced at the Host tool execution boundary with the `.dsh-handoff/<runId>/` recovery convention. The MCP fold repeats the bounds for malformed or legacy durable results and exposes the affected fields in `handoffTruncated` instead of silently returning an unbounded payload. Host errors, MCP failures, approvals, and question previews are also bounded; an oversized approval or question batch is marked `answerInWeb=true` so Codex does not decide from a partial/truncated interaction. The tool never auto-writes handoff data, and `.dsh-handoff` is gitignored.
- A reported `host/agent-error` is surfaced as `FAILED/HOST_FAILED` but is not sticky: it is cleared when the Host reports the agent running again, when `session.list` shows the row running, or when the session is removed. The in-memory event cache is pruned to the latest supervised task packet boundary on every refresh, bounding retained history across supervised tasks.
- The anti-stuck mechanism counts exact worker-reported `failureSignature` values since the latest durable task packet and concludes the turn when the configured recovery budget is exhausted (two reports by default). Semantic equivalence remains the worker's judgment.
- When `authority.maxDirectChildren` is present, the Host gates configured direct-child creation tools before execution. It atomically combines persisted direct-child session headers created inside the current run window with in-flight start reservations, so parallel calls cannot exceed the cap. Failed starts release their reservation. The bundled guarded tools are `subagent` and `subagent_fork`; deployments with renamed or additional child tools must list them in `directChildToolNames`. The profile also sets DSH's native absolute `maxDepth: 1` on both tools, allowing Root-to-child delegation while forbidding grandchildren. Codex remains observation-only and does not duplicate either control.

- `dsh_agents` and `dsh_interrupt_agent` are scoped to the addressed run. A child must have a post-Root-boundary accepted-work event and must not be a nested different supervised run. Historical children remain visible in DSH Web but cannot be mistaken for or interrupted as current-run work through MCP.

## Telemetry

When a task packet carries a token budget, the Host folds provider-reported
usage with DSH's streaming/final replacement semantics, excludes inherited
child seed usage, and aggregates the root plus durable descendants. Run
affiliation is derived without an extra model call from durable lineage, the
root task-packet window, and each descendant's accepted-work boundary. This
covers spawn, fork, nested descendants, and a continuable child that accepts
new work in a later run while excluding its earlier work. Reaching
the limit cancels the run tree with a durable hook reason and yields
`ESCALATION_REQUIRED/token-budget-exhausted`. Request reservations prevent
concurrent agents from claiming the same remaining allowance, and each request's
`maxTokens` is capped before dispatch. Reservations are fsynced as independent
Host-private records before request admission and are removed only after the
corresponding usage or step terminal boundary is durably flushed. After a Host
restart, an open durable step without usage remains charged pessimistically;
an orphan record that never reached DSH's durable provider checkpoint is
reclaimed. If the next complete input cannot fit,
no provider call is made and the terminal hook is
`token-budget-request-rejected` with used, remaining, and required-input
figures; this is distinct from `token-budget-exhausted`. Because provider usage is authoritative
only after a response, the final total can still cross the cutoff by input-token
estimation or provider-reporting variance; the field is not an exact billing cap.
Every budgeted wait/recovery and `dsh_runs` entry refreshes a read-only Host
projection built by the same durable fold as enforcement, so `budget` reports
`coverage=run_tree`, counted session count, and cumulative uncached-input,
cache-read, cache-write, and output buckets without a model call. The
cursor-scoped heartbeat token delta remains the root session's event delta; the
run-tree budget is cumulative so descendants are never guessed from a root
cursor. An optional read-only `dsh-usage-monitor` bridge exposes only
session-lifetime root totals (`scope=session_lifetime`,
`includesDescendants=false`, `authoritativeForBudget=false`); its cost fields
are neither read nor used, and a missing row is distinct from monitor downtime.

When the Host mounts the native projection units, each observation carries compact `tokenUsage`, `sessionStats`, and `subagent` snapshots plus their projection `asOfSeq`. A `dsh_wait` response also carries a cursor-scoped `progress` heartbeat: observed event count, completed-step total/delta, tool-call total/delta grouped by tool name, token bucket deltas, the last activity category, and a bounded `projectActivity` summary. `projectActivity` reports distinct project file paths touched by *successful recognized* mutating tool calls (`edit`, `write`, `str_replace_editor` create/str_replace/insert) and distinct targeted verification commands attempted, with counts and capped samples. It labels instrumentation coverage `complete` or `partial`; zero edits under partial coverage never means the working tree is unchanged. Event-correlated verification evidence (`passed`, `failed`, or `pending`) is separate from the worker's handoff verification claims. Paths and command labels are sanitized and bounded, and no file contents, tool outputs, or full arguments are copied. The worker may attach bounded semantic context through `supervisor_progress` (`phase`, `milestone`, `nextAction`, optional hypothesis/risk, the legacy `needsSupervisor` hint, and a structured decision request). The DSH tool validates run identity, deduplicates identical records, rate-limits ordinary updates to one per minute, and never concludes the turn. The runtime evaluates worker-request facts and attaches its timing/audience/action/reason outcome; only an immediate outcome creates `SUPERVISOR_REQUIRED`. Later supervisor guidance consumes that boundary so it is not repeatedly returned. Terminal observations attach the task-scope `projectActivity` totals (distinct files, verification commands, completed steps, tool calls by name, and token usage) so the final report can recap meaningful project change and verification activity without equating every tool call with a project change. Token deltas reuse DSH's per-turn/per-step usage replacement semantics so streaming and finalized usage samples are not double-counted. Raw reasoning, tool arguments, tool results, assistant chunks, and transcripts are never copied into the supervisor context. Codex/Sol usage remains owned by Codex's own telemetry; DSH projections cover worker tokens, cache buckets, turns, timing, and child state without creating a second persistent metrics store.

Mux frames update the in-memory fold immediately. HTTP list/history reconciliation is periodic during ordinary work, then mandatory before cadence, material, and terminal returns. Reconnect without an explicit Host URL scans configured Hosts, binds the discovered session to that Host, and preserves connection failures as structured `HOST_FAILED` tool envelopes. Approval/question controls must echo the pending stable `rpcId`; stale interaction replies are rejected before responding to the Host.

`dsh_runs` reconstructs compact root-run identities from Host sessions and
`dsh_recover` reattaches without replay. MCP/network loss leaves the Host turn
running. A Host-process crash is different: DSH persistence closes the orphaned
turn as `interrupted`, which folds to retryable `HOST_FAILED` plus
`CONTINUATION_REQUIRED`. The same durable fold emits a maximum-16-KiB
`recoveryCapsule` with the last accepted Root semantic progress plus bounded
baseline, project activity, token usage, and `uncertainEffects` folded across
the complete affiliated run tree. Its `runTree` member identifies every folded
session and its activation/terminal boundaries; every uncertain-effect entry
identifies its owning session. A
ledger entry exists when a potentially side-effecting `tool/call` has no durable
correlated `tool/result`; known read-only and supervisor-reporting tools are
excluded, while unknown tools fail conservatively into `UNKNOWN_TOOL_EFFECT`.
Entries contain only bounded call/tool metadata—never arguments, results,
transcripts, source, or command text. Only a new task carrying the exact
`parentRunId` and capsule may continue it. Supplying either without the other is
rejected. The Host recovery route reads attached and cold persisted sessions,
proves the parent is the current interrupted run for that session, reconstructs
the complete affiliated tree, and returns the capsule. The same Host admission
critical section recomputes it and requires a byte-semantically exact capsule
match. Missing, fabricated, stale, and cross-session capsules fail before a
provider call. Recovery fails closed without a capsule when an affiliated child
is active, lacks a durable terminal boundary, or cannot be reconciled. The
worker must reconcile uncertain effects before any retry.

Durable terminal observations create one structured run-journal record assembled
only from already-folded runtime facts, with `modelCallsUsed: 0`. The stable
run identity makes repeated terminal waits idempotent. Pending interactions,
ordinary waits, stale requests, and temporary Host/protocol failures are
excluded. Persistence fails open: a bounded `journal.warning` never changes the
task status.

DSH root exclusively manages its child tree. The Host automatically relays child reports and settled notices to that root; observing a child through `dsh_agents` never transfers ownership to Codex and never authorizes `dsh_steer`. `dsh_agents` enriches each direct child with existing session projection telemetry for read-only visibility. `dsh_interrupt_agent` is an explicit-human or safety-emergency control, not a routine orchestration action.
