# dsh-gate protocol

`dsh-gate` is a stateless MCP-facing supervisor over an independently owned DSH Host. The Host owns agents, sessions, persistence, and its process lifetime. MCP owns only network connections and in-memory observations; exiting MCP calls `ConnectionController.stop()` and never signals or kills the Host.

## Completion boundary

The worker receives a durable task packet containing the session id and a random completion token. `COMPLETED` requires all of these facts in one turn:

1. a `supervisor_handoff` call whose task id and token match the latest task packet;
2. a successful correlated `tool/result` whose output was accepted;
3. the corresponding `turn/end` after that result.

A completed `turn/end` without those facts is `FAILED` with `MISSING_HANDOFF`. Other failures use `WORKER_FAILED`, `HOST_FAILED`, or `PROTOCOL_ERROR`.

## Observation cursor

`asOfSeq` is the highest DSH session event sequence observed while producing a response. `boundarySeq` is the event sequence that established the returned state. `afterAsOfSeq` only states the caller's prior observation and is never passed to DSH `events.mux({ since })`, because DSH v1 does not implement a usable server resume cursor. Reconnect always refreshes authoritative history.

`WAITING` distinguishes `wait.reason=PROGRESS` from `wait.reason=TIMEOUT`; `workerState` independently says whether the worker was `RUNNING`, `IDLE`, or `UNKNOWN` at the observation. A progress return means durable session history advanced beyond the caller's observation cursor, not that a semantic checkpoint or terminal boundary occurred.

Codex must surface aggregated progress during long runs and repeat root step/tool/token figures in its terminal response. MCP output entering model context is not itself a user-visible report.

## Safety boundaries

- One nonterminal writer task is allowed per real working-tree path. Read-only roots may coexist. Parallel writers require distinct existing Git worktrees; there is no extra workspace lock manager.
- Artifact admission starts from the authoritative `session.list` cwd, resolves both cwd and target with `realpath`, requires path containment, and rejects absolute paths, traversal, symlinks, hardlinks, and non-regular files before hashing.
- The anti-stuck mechanism counts exact worker-reported `failureSignature` values since the latest durable task packet and concludes the turn when the configured recovery budget is exhausted (two reports by default). Semantic equivalence remains the worker's judgment.

## Telemetry

When the Host mounts the native projection units, each observation carries compact `tokenUsage`, `sessionStats`, and `subagent` snapshots plus their projection `asOfSeq`. A `dsh_wait` response also carries a cursor-scoped `progress` heartbeat: observed event count, completed-step total/delta, tool-call total/delta grouped by tool name, token bucket deltas, and the last activity category. Token deltas reuse DSH's per-turn/per-step usage replacement semantics so streaming and finalized usage samples are not double-counted. Raw tool arguments, tool results, assistant chunks, and transcripts are never copied into the supervisor context. Codex/Sol usage remains owned by Codex's own telemetry; DSH projections cover worker tokens, cache buckets, turns, timing, and child state without creating a second persistent metrics store.

DSH root exclusively manages its child tree. The Host automatically relays child reports and settled notices to that root; observing a child through `dsh_agents` never transfers ownership to Codex and never authorizes `dsh_steer`. `dsh_agents` enriches each direct child with existing session projection telemetry for read-only visibility. `dsh_interrupt_agent` is an explicit-human or safety-emergency control, not a routine orchestration action.
