# dsh-gate protocol

`dsh-gate` is a stateless MCP-facing supervisor over an independently owned DSH Host. The Host owns agents, sessions, persistence, and its process lifetime. MCP owns only network connections and in-memory observations; exiting MCP calls `ConnectionController.stop()` and never signals or kills the Host.

## Completion boundary

The worker receives a durable task packet containing the durable `sessionId`, a unique per-execution `runId`, and a random completion token. Legacy schema-version-1 packets remain readable, but new runs emit schema version 2. `COMPLETED` requires all of these facts in one turn:

1. a `supervisor_handoff` call whose session id, run id, and token match the latest task packet;
2. a successful correlated `tool/result` whose output was accepted;
3. the corresponding `turn/end` after that result.

A completed `turn/end` without those facts is `FAILED` with `MISSING_HANDOFF`. Other failures use `WORKER_FAILED`, `HOST_FAILED`, or `PROTOCOL_ERROR`. Every wait and control call for a v2 run carries `sessionId + runId`; a stale run is rejected before it can observe or mutate the newer execution.

## Observation cursor

`asOfSeq` is the highest DSH session event sequence observed while producing a response. `boundarySeq` is the event sequence that established the returned state. `afterAsOfSeq` only states the caller's prior observation and is never passed to DSH `events.mux({ since })`, because DSH v1 does not implement a usable server resume cursor. Reconnect always refreshes authoritative history.

`dsh_wait` runs a five-minute aggregated progress cadence: with the default timeout (300000 ms) it returns about one observation per window and returns early when the attached decision outcome says `timing=immediate`. Terminal state, approval/question, checkpoint, blocker, escalation, and Host/protocol failure are locked protocol boundaries; structured worker requests are evaluated by the versioned worker policy. Ordinary event churn does not produce rapid repeated wait calls. The `WAITING` return at the window boundary is `wait.reason=TIMEOUT` with the aggregate `progress` since the caller's observation cursor; `workerState` independently says whether the worker was `RUNNING`, `IDLE`, or `UNKNOWN` at the observation. The `PROGRESS` wait reason remains in the schema for compatibility but is not emitted by the current cadence.

Codex must surface aggregated progress during long runs and repeat root step/tool/token figures and verification results in its terminal response. MCP output entering model context is not itself a user-visible report.

## Safety boundaries

- One nonterminal writer task is allowed per real working tree: the writer domain is the nearest ancestor carrying a `.git` worktree marker, so different subdirectories of one worktree share a domain and linked worktrees remain distinct; a non-Git directory falls back to its exact `realpath`. Read-only roots may coexist. Parallel writers require distinct existing Git worktrees; there is no workspace lock manager. Writer admission (availability check through durable task packet) is serialized within one MCP process, closing the in-process check-then-act race; admission across separate MCP processes or Hosts is not serialized.
- A writer lease belongs to the queued/active run and releases at its corresponding `turn/end`, regardless of whether the terminal handoff is completed, blocked, checkpoint, escalation, missing, or failed. A continuation queues a new run and reacquires admission.
- Artifact admission starts from the authoritative `session.list` cwd, requires path containment, rejects absolute paths, traversal, symlinks, hardlinks, and non-regular files, and hashes through a validated open file handle (so the file fstat'ed is the file hashed) with per-artifact and total byte limits; admission is sequential and never loads an artifact wholly into memory.
- Handoff summaries are capped at 2048 characters. An over-limit `supervisor_handoff` fails with an actionable error telling the worker to write the detailed report under `.dsh-handoff/<runId>/` (legacy v1: taskId) inside the session cwd and pass its relative path in `artifacts`; the tool never auto-writes handoff data, and the `.dsh-handoff` directory is gitignored so reports never enter the repository.
- A reported `host/agent-error` is surfaced as `FAILED/HOST_FAILED` but is not sticky: it is cleared when the Host reports the agent running again, when `session.list` shows the row running, or when the session is removed. The in-memory event cache is pruned to the latest supervised task packet boundary on every refresh, bounding retained history across supervised tasks.
- The anti-stuck mechanism counts exact worker-reported `failureSignature` values since the latest durable task packet and concludes the turn when the configured recovery budget is exhausted (two reports by default). Semantic equivalence remains the worker's judgment.

## Telemetry

When the Host mounts the native projection units, each observation carries compact `tokenUsage`, `sessionStats`, and `subagent` snapshots plus their projection `asOfSeq`. A `dsh_wait` response also carries a cursor-scoped `progress` heartbeat: observed event count, completed-step total/delta, tool-call total/delta grouped by tool name, token bucket deltas, the last activity category, and a bounded `projectActivity` summary. `projectActivity` reports distinct project file paths touched by *successful recognized* mutating tool calls (`edit`, `write`, `str_replace_editor` create/str_replace/insert) and distinct targeted verification commands attempted, with counts and capped samples. It labels instrumentation coverage `complete` or `partial`; zero edits under partial coverage never means the working tree is unchanged. Event-correlated verification evidence (`passed`, `failed`, or `pending`) is separate from the worker's handoff verification claims. Paths and command labels are sanitized and bounded, and no file contents, tool outputs, or full arguments are copied. The worker may attach bounded semantic context through `supervisor_progress` (`phase`, `milestone`, `nextAction`, optional hypothesis/risk, the legacy `needsSupervisor` hint, and a structured decision request). The DSH tool validates run identity, deduplicates identical records, rate-limits ordinary updates to one per minute, and never concludes the turn. The runtime evaluates worker-request facts and attaches its timing/audience/action/reason outcome; only an immediate outcome creates `SUPERVISOR_REQUIRED`. Later supervisor guidance consumes that boundary so it is not repeatedly returned. Terminal observations attach the task-scope `projectActivity` totals (distinct files, verification commands, completed steps, tool calls by name, and token usage) so the final report can recap meaningful project change and verification activity without equating every tool call with a project change. Token deltas reuse DSH's per-turn/per-step usage replacement semantics so streaming and finalized usage samples are not double-counted. Raw reasoning, tool arguments, tool results, assistant chunks, and transcripts are never copied into the supervisor context. Codex/Sol usage remains owned by Codex's own telemetry; DSH projections cover worker tokens, cache buckets, turns, timing, and child state without creating a second persistent metrics store.

Mux frames update the in-memory fold immediately. HTTP list/history reconciliation is periodic during ordinary work, then mandatory before cadence, material, and terminal returns. Reconnect without an explicit Host URL scans configured Hosts, binds the discovered session to that Host, and preserves connection failures as structured `HOST_FAILED` tool envelopes. Approval/question controls must echo the pending stable `rpcId`; stale interaction replies are rejected before responding to the Host.

Durable terminal observations create one structured run-journal record assembled
only from already-folded runtime facts, with `modelCallsUsed: 0`. The stable
run identity makes repeated terminal waits idempotent. Pending interactions,
ordinary waits, stale requests, and temporary Host/protocol failures are
excluded. Persistence fails open: a bounded `journal.warning` never changes the
task status.

DSH root exclusively manages its child tree. The Host automatically relays child reports and settled notices to that root; observing a child through `dsh_agents` never transfers ownership to Codex and never authorizes `dsh_steer`. `dsh_agents` enriches each direct child with existing session projection telemetry for read-only visibility. `dsh_interrupt_agent` is an explicit-human or safety-emergency control, not a routine orchestration action.
