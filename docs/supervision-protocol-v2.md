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
- Read-only Roots are pinned by durable DSH sandbox and no-approval policy
  events. The worker and its children cannot elevate into a write.
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

The task receipt also returns `initialWaitAfterAsOfSeq`, the exact durable
admission boundary, and `observedAsOfSeq`, the latest event already seen while
forming the receipt. The first wait uses the former so worker events racing the
receipt are not skipped; subsequent waits use the previous observation's
`asOfSeq`.

A task packet has this shape:

```ts
interface TaskPacketV2 {
  schemaVersion: 2
  instructionProfile?: 'engineering-v1'
  sessionId: string
  runId: string
  completionToken: string
  objective: string
  writerMode: 'writer' | 'read_only'
  executionBrief?: {
    schemaVersion: 1
    source: 'CODEX_COMPILED' | 'SINGLE_STREAM_FALLBACK'
    workstreams: Array<{
      id: string
      outcome: string
      scopeHints?: string[]
      evidenceToGather?: string[]
      dependsOn?: string[]
      delegation: 'root' | 'child_candidate'
      doneWhen: string[]
    }>
    integration: string[]
  }
  parentRunId?: string
  recoveryCapsule?: RecoveryCapsuleV1
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

New admissions also pin `instructionProfile=engineering-v1`. Before admission,
the gateway deterministically fills only missing routine engineering details:
full-session writer scope (`.`), preservation and safety constraints, concrete
acceptance and focused-then-full verification, material-only escalation, and a
maximum of five direct children. Explicit caller values always win, including
a narrower scope or a zero-child limit. The compiler makes no model call, and
its profile pin makes the exact instruction policy auditable after reconnect.

Codex compiles multi-part requests into one `executionBrief` during its existing
reasoning turn. The schema permits 1–5 unique workstreams, validates dependency
references and acyclicity, and caps the complete brief at 16 KiB. It carries
planning hints and observable completion conditions, never extra authority;
`allowedScope`, constraints, approval policy, and budget remain binding. DSH
Root may delegate `child_candidate` streams but retains shared-interface,
integration, verification, and handoff ownership. An omitted brief becomes one
explicit `SINGLE_STREAM_FALLBACK`, preserving migration without pretending that
semantic decomposition occurred.

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

Codex sends the objective plus any genuinely task-specific scope, constraints,
acceptance checks, verification commands, escalation conditions, Git baseline,
authority, and pre-authorized child budget in one durable packet. The
deterministic instruction compiler supplies omitted routine defaults, so the
human does not need to repeat the supervision boilerplate. Safe in-scope edits
and declared verification do not require another human confirmation.
The Host enforces `authority.maxDirectChildren` before configured child-start
tools run, using durable direct-child creation times plus atomic reservations
for concurrent starts. Within the limit the worker does not ask again; beyond
the limit the call is denied without transferring child control to Codex. The
bundled `subagent` and `subagent_fork` tools are both guarded, and DSH's native
absolute `maxDepth: 1` allows Root-to-child delegation while rejecting
grandchildren.

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

A Host-restart interruption additionally yields a model-free recovery capsule
capped at 16 KiB. The capsule folds only durable evidence across the complete
affiliated run tree: last accepted Root `supervisor_progress`, bounded task
baseline, project activity, token/budget snapshot, per-session recovery
boundaries, and unresolved side-effect metadata. An unresolved effect is a
potentially mutating/command/unknown tool call without a durable correlated
result; its entry names the owning session. Its arguments and output are never
copied. A continuation must supply both the exact capsule and matching
`parentRunId`. The Host recovery route folds attached and cold persisted
sessions. The Host admission critical section proves that parent is the current
interrupted run for the same session, recomputes the run-tree capsule, and
compares it exactly. Missing, fabricated, stale, cross-session, or
child-incomplete evidence fails before admission, and
the worker reconciles every uncertain effect before deciding whether retry is
safe.

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
escalation handoffs, once affiliated children and pending work are quiet. An
`interrupted` end retains ownership until an exact continuation is admitted for
the same Root.

The Host supervisor plugin owns task and writer admission. One Host-local
critical section serializes callers from multiple MCP processes, inspects live
and cold persisted sessions, durably flushes the DSH inbox insertion, and
returns the stored request receipt. This closes same-session `requestId` replay
and same-Host writer races without changing DSH core. Separate Hosts still lack
shared admission authority, so writer dispatch requires exactly one configured
Host; no filesystem lock service is added. Read-only admission uses DSH's native
`read-only + never-approve` policy pair. Writer admission applies
`workspace-write` without broadening the current approval policy.

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
- normal writer leases release after turn end and run-tree quietness;
- interrupted writer leases require exact same-Root continuation;
- read-only execution is enforced by DSH sandbox and approval-policy folds;
- no workspace lock manager is introduced.

### Final acceptance

- focused protocol tests, package typechecks, all unit tests, and build pass;
- manual Host/MCP reconnect preserves session and run identity;
- pending interaction replay works after MCP restart;
- Web remains independently visible and MCP shutdown never stops the Host;
- working tree diff contains no DSH core or Codex-specific upstream patch.
