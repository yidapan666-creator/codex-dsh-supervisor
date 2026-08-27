# Supervision protocol v2

Status: implementation contract for `codex/supervision-protocol-v2`.

This document defines the next dsh-gate supervision boundary. It separates a
durable DSH session from one supervised execution, makes every intervention
stale-safe, adds bounded worker-authored phase context to runtime-derived
progress, and preserves the existing completion and Host-lifetime invariants.

## Invariants that do not change

- The DSH Host owns sessions and outlives MCP. MCP shutdown stops only its
  network clients.
- DSH root exclusively manages its child tree. Codex observes children and may
  interrupt one only on explicit human request or a safety/resource emergency.
- `asOfSeq` is an observation cursor, never a DSH server resume cursor.
- Success requires a valid accepted `supervisor_handoff`, its corresponding
  `turn/end`, and convergence of every affiliated child. A plain turn end is
  never success; a root handoff remains waiting while its child work is active.
- One active writer is allowed per real Git working tree. Parallel writers use
  existing independent worktrees; dsh-gate does not create a workspace lock
  manager.
- Artifact paths are relative to the authoritative session cwd and remain
  subject to realpath, file-handle, type, link, count, and byte-limit admission.
- Reported-failure budgets count exact worker-reported signatures. Semantic
  similarity remains the worker's responsibility.

## Identities and boundaries

Three identifiers have distinct meanings:

| Identifier | Lifetime | Owner | Purpose |
|---|---|---|---|
| `sessionId` | DSH session | Host | Durable transcript, cwd, agent, and reconnect address |
| `runId` | One queued supervised execution | dsh-gate | Wait/control correlation, accounting, checkpoints, and terminal result |
| `completionToken` | One run | dsh-gate, secret to the worker packet | Proves that a handoff belongs to the current run |

`dsh_start_or_connect` returns `sessionId`. `dsh_task` creates and returns a new
UUID `runId` and a new completion token. The completion token is embedded in the
durable packet but is never required from Codex after queueing. Every later
supervision tool addresses `sessionId + runId`.

A task packet has this shape:

```ts
interface TaskPacketV2 {
  schemaVersion: 2
  sessionId: string
  runId: string
  completionToken: string
  objective: string
  writerMode: 'writer' | 'read_only'
  parentRunId?: string
  baseline?: {
    head?: string
    statusSummary: string
  }
  context?: string
  allowedScope?: string[]
  constraints?: string[]
  acceptanceCriteria?: string[]
  verification?: string[]
  escalationConditions?: string[]
  authority?: {
    maxDirectChildren?: number
    preAuthorizedActions?: string[]
    preAuthorizedDecisionCategories?: DecisionCategory[]
  }
  decisionPolicy?: {
    activeVersion: string
    activeDigest: string
    shadowVersion?: string
    shadowDigest?: string
  }
}
```

All strings and arrays receive explicit wire-size limits. Packet parsing uses one
shared strict schema on the MCP and worker sides. A malformed newest packet is a
typed protocol error; marker-like user prose cannot silently become a packet.
Newly queued runs always include the decision-policy identity. The version and
canonical digest pin active behavior across MCP restarts. An optional shadow
identity is pinned for reproducible comparison but has no enforcement authority.
Older v2 packets without this field remain migration-compatible.

## Stale-safe control

`dsh_wait`, `dsh_steer`, `dsh_cancel`, approval answers, and question answers
carry `sessionId` and `runId`. Mutating controls also carry the supervisor's
`expectedBoundarySeq` when one was observed.

Before mutating a turn, the gateway refreshes authoritative history and rejects
the request when:

- the latest valid packet has a different run id;
- the supplied boundary is ahead of or behind the active material boundary;
- the requested interaction no longer matches the Host's pending rpc id.

The rejection is structured as `PROTOCOL_ERROR` with `stale: true`; it never
steers, cancels, or answers the newer run.

## Information flow

### Codex to DSH at queue time

Codex sends the complete objective, scope, constraints, acceptance checks,
verification commands, escalation conditions, Git baseline, authority, and
pre-authorized child budget in one durable packet. Safe in-scope edits and
declared verification do not require another human confirmation.
The Host enforces `authority.maxDirectChildren` before configured child-start
tools run, using durable direct-child creation times plus atomic reservations
for concurrent starts. Within the limit the worker does not ask again; beyond
the limit the call is denied without transferring child control to Codex.

### DSH to Codex during ordinary work

Runtime-derived heartbeat fields remain the source of quantitative truth:

- observation cursor and event count;
- completed-step total and delta;
- tool-call total, delta, and names;
- worker token/cache delta;
- successful recognized file mutations;
- verification attempts and correlated outcomes;
- direct-child state and telemetry when available.

The worker may add bounded semantic context through `supervisor_progress`:

```ts
interface SupervisorProgress {
  phase: 'investigating' | 'implementing' | 'verifying' | 'recovering'
  milestone: string
  nextAction: string
  currentHypothesis?: string
  risk?: string
  needsSupervisor: boolean
  decision?: {
    category: DecisionCategory
    impact: 'low' | 'medium' | 'high'
    blocking: boolean
    requiresHuman?: boolean
    request: string
    options?: string[]
    recommendation?: string
  }
}
```

The tool does not conclude the turn. The runtime deduplicates and rate-limits
progress records. Ordinary records are folded into the next five-minute
heartbeat. `needsSupervisor` is a legacy hint; the structured request is folded
through the versioned decision policy. The policy outcome—not the boolean—decides
whether the request creates an early boundary. Pre-authorization comes only from
the task packet and never from the worker.
Raw reasoning, transcripts, diffs, tool arguments, and tool output never enter
the heartbeat.

Activity summaries state their coverage (`complete` or `partial`). A zero under
partial coverage never claims that the working tree is unchanged. Verification
reports distinguish worker claims from event-correlated runtime evidence.

### DSH to Codex at a material boundary

Immediate boundaries are:

- approval required;
- question required;
- worker-requested supervisor decision;
- reported-failure budget exhausted;
- blocked, checkpoint, escalation, failed, or completed handoff;
- Host/protocol failure.

Every boundary includes `sessionId`, `runId`, `boundarySeq`, `workerState`, a
typed reason, compact context, and a suggested legal next action. A checkpoint
ends its turn. Continuing it queues a new run with `parentRunId` rather than
using a free-form stale-prone nudge.

### Terminal transfer

The worker tool validates the latest packet's session id, run id, and completion
token before artifact admission or `concludeTurn()`. Its successful tool result
contains the canonical handoff. The MCP fold validates and consumes that result,
then requires the corresponding turn end.

Codex independently inspects the Git diff/status and proportionate verification
before reporting completion. Worker-reported verification is evidence input, not
automatic acceptance.

## Intervention policy

Codex does not intervene for ordinary event churn, a slow command, one quiet
window, a settled child, or routine compilation. It intervenes only when:

- a pending interaction requires an answer;
- a decision is missing and materially changes architecture, acceptance, or
  requested scope;
- a security-sensitive, destructive, credentialed, external, or otherwise
  unauthorized side effect is proposed;
- the recovery budget is exhausted;
- runtime evidence contradicts the task packet or handoff;
- the human explicitly requests correction, cancellation, or interruption;
- a clear safety/resource emergency exists.

Questions whose answers are already unambiguous in the task packet may be
answered by Codex without waking the human. Scope expansion and material choices
remain human decisions.

## Writer admission

Writer ownership follows an explicit run lease rather than semantic status.
Admission is held while a writer run is queued or its turn is active and is
released at the corresponding turn end, including blocked, checkpoint, and
escalation handoffs. A continuation reacquires admission as a new run.

The Host supervisor plugin owns per-session task admission. It serializes
callers from multiple MCP processes, durably flushes the DSH inbox insertion,
and returns the stored request receipt. This closes same-session `requestId`
replay without changing DSH core. Writer exclusion across different sessions,
MCP processes, or Hosts remains a separate limitation; no filesystem lock
service is added.

## Wait and reconnect

- Default user cadence remains five minutes.
- Mux events update the in-memory observation immediately.
- Authoritative list/history reconciliation is coalesced and single-flight,
  periodic during ordinary work, and mandatory before a material or terminal
  return.
- A run is bound to its discovered Host connection. Reconnect with a session id
  scans configured Hosts when no explicit Host URL is supplied.
- Pending approvals/questions rely on the Host's stable-rpc-id replay contract
  and receive an integration test across MCP reconnect.
- Tool errors use structured failure envelopes; Host connection failures are
  never flattened into an inaccurate “session not found” message.

## Delivery phases and acceptance

### Phase 1 — identity and stale controls

- v2 packet carries `sessionId` and unique `runId`.
- two runs in one session remain independently observable;
- stale wait/steer/cancel/answer calls cannot affect or report the newer run;
- v1 packets remain readable during migration but new tasks emit v2 only.

### Phase 2 — authoritative handoff

- wrong session/run/token is rejected before turn conclusion;
- fold consumes a schema-validated canonical handoff result;
- valid handoff plus matching turn end completes only after affiliated children settle;
- turn end alone remains `MISSING_HANDOFF`.

### Phase 3 — semantic progress and evidence

- progress tool is bounded, deduplicated, and non-concluding;
- ordinary progress waits for cadence; decision-required progress returns early;
- heartbeats label activity coverage and verification evidence;
- no raw logs, diffs, arguments, outputs, or private reasoning are copied.

### Phase 4 — connection and writer behavior

- ordinary event churn does not cause one HTTP history refresh per event;
- material boundaries receive authoritative refresh before return;
- multi-Host reconnect locates the existing session;
- writer lease releases on every corresponding turn end;
- no workspace lock manager is introduced.

### Final acceptance

- focused protocol tests, package typechecks, all unit tests, and build pass;
- manual Host/MCP reconnect preserves session and run identity;
- pending interaction replay works after MCP restart;
- Web remains independently visible and MCP shutdown never stops the Host;
- working tree diff contains no DSH core or Codex-specific upstream patch.
