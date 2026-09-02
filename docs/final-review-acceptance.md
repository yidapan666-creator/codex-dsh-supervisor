# Final review acceptance blockers

Date: 2026-08-30

Status: **topology/reliability P1 findings are resolved locally**. Project-wide release acceptance still tracks the explicitly scoped P2 budget redesign below.

## Acceptance plan

This plan separates acceptance of the resolved P1 reliability work from final
release acceptance. A P1 sign-off does not claim that the P2 budget redesign is
implemented.

### 0. Freeze the candidate

- Record the branch, candidate commit (or `WORKTREE` while still uncommitted),
  Host version, protocol version, and acceptance date.
- Confirm that every changed file is expected and that no generated state,
  credentials, `.dsh-handoff` artifacts, or unrelated user work will enter the
  commit.
- Do not commit or push until every mandatory P1 gate below passes.

### 1. Automated release gate — mandatory

Run from the repository root:

1. `git diff --check`;
2. `pnpm verify` (workspace build/typecheck plus the complete test suite);
3. `pnpm bootstrap`;
4. `pnpm run doctor`;
5. with the project Host running, `pnpm run doctor --live --host http://127.0.0.1:18080`.

Acceptance: every command exits successfully, the test total is recorded, and
the live doctor reports the expected Host/protocol identity. A failed command
blocks sign-off; do not waive it with a prose explanation.

### 2. Durable Root identity and reconnect — mandatory

1. From one Codex task, create a DSH session and record `sessionId` plus the
   first `runId`.
2. Complete a small supervised run, then queue a second phase using the same
   `sessionId`.
3. Verify that the DSH Root/session and authoritative cwd are unchanged while
   the second phase has a new `runId`.
4. Restart MCP/Codex without stopping the Host. Use `dsh_runs`, when identity
   discovery is needed, followed by exact `dsh_recover(sessionId, runId)`.
5. Verify that no objective is replayed, no duplicate run is admitted, and the
   existing Web session remains observable.

Acceptance: one durable Root session survives MCP/Codex replacement; separate
executions remain distinguishable by `runId`.

### 3. Host lifecycle independence — mandatory

1. Start a supervised run and record the Host PID/instance identity.
2. Stop only the MCP client; confirm that the Host process and DSH session keep
   running.
3. Start a replacement MCP client and reconnect to the existing session.
4. Exercise the uncertain PID branch with the existing regression fixture and
   confirm that lifecycle state is retained and startup fails closed.

Acceptance: MCP exit never owns or terminates the DSH Host, and uncertain
process identity never causes the PID record to be deleted.

### 4. Same-worktree writer authority — mandatory

Run the following admissions concurrently through two independent MCP clients
connected to the same long-running Host:

| Case | Expected result |
| --- | --- |
| Root A writer, worktree A | admitted |
| Root B writer, the same real worktree A | rejected before provider execution |
| Root B writer, independent Git worktree B | admitted |
| Root C `read_only`, worktree A | admitted with native read-only sandbox |
| Root C attempts a filesystem/bash write | blocked by runtime |
| Root C attempts one-shot approval elevation | blocked by `approval/policy=never` |
| Cold persisted writer owns worktree A | a new writer is rejected |
| Persistence enumeration or inspection fails | admission fails closed as `DURABILITY_UNAVAILABLE` |

Acceptance: the Host's single atomic admission boundary is authoritative across
MCP clients; no separate workspace lock manager is involved.

### 5. Interrupted-run continuation — mandatory

1. Interrupt an active writer at a controlled test boundary and restart only
   the Host.
2. Recover the exact run and require `CONTINUATION_REQUIRED` with a model-free
   capsule no larger than 16 KiB.
3. Confirm that the capsule covers every affiliated Root/child session and
   lists session-scoped uncertain effects without tool arguments or outputs.
4. Attempt missing, edited/fabricated, stale, cross-session, and
   child-incomplete capsules; every attempt must be rejected before provider
   execution.
5. Submit the exact capsule with its matching `parentRunId`; confirm that the
   same interrupted Root retains writer ownership and the continuation receives
   a new `runId`.
6. Verify that the worker reconciles uncertain effects before retrying them.

Acceptance: only the exact Host-recomputed full-run-tree capsule crosses the
crash boundary; another Root cannot take over the interrupted writer lease.

### 6. Completion and child ownership — mandatory

| Observation | Expected terminal state |
| --- | --- |
| `turn/end` without a valid matching supervisor handoff | `FAILED / MISSING_HANDOFF` |
| valid Root handoff without its corresponding `turn/end` | not `COMPLETED` |
| valid Root handoff plus corresponding `turn/end`, no children outstanding | `COMPLETED` |
| affiliated child still running | `WAITING / children-running` |
| child settled after an older Root handoff | `WAITING / root-rehandoff-required` |
| worker failure | `FAILED / WORKER_FAILED` |
| Host failure | `FAILED / HOST_FAILED` |
| malformed or inconsistent protocol evidence | `FAILED / PROTOCOL_ERROR` |

Also verify that Codex observes DSH children read-only, never relays child
completion with `dsh_steer`, and never takes child control merely because it saw
the child settle.

### 7. Five-minute supervision observation — mandatory

1. Run a task long enough to cross one ordinary five-minute cadence boundary.
2. Confirm that `dsh_wait` returns a compact aggregate containing step delta,
   tool counts by name, token delta, bounded project activity, and the latest
   accepted progress milestone when available.
3. Carry `asOfSeq` into the next `afterAsOfSeq` and confirm that already reported
   progress is not counted again.
4. Confirm that ordinary tool/event churn does not cause rapid re-polling and
   that an immediate return occurs only for a locked protocol/policy boundary.

Acceptance: `asOfSeq` behaves only as an observation boundary, never as a
claimed DSH server resume cursor.

### 8. Workspace and artifact confinement — mandatory

- Admit a regular artifact inside `.dsh-handoff/<runId>/` under the session cwd.
- Reject absolute paths, `..` traversal, symlink escape, hardlink aliasing,
  non-regular files, and any target whose real path leaves the session cwd.
- Confirm that the concise handoff remains bounded and references the admitted
  relative artifact path rather than copying a long report into model context.

Acceptance: every admitted artifact is handle-validated and physically
contained in the corresponding session workspace.

### 9. Sign-off and release decision

Record one result for each mandatory gate: `PASS`, `FAIL`, or `NOT RUN`.
Only all-`PASS` results qualify the topology/reliability P1 work for acceptance.
After P1 acceptance:

- review the complete diff once more;
- create one local Git commit with the acceptance evidence in its message or
  linked document;
- push only after explicit user approval;
- keep the budget redesign below labelled P2 and do not present the current raw
  token ceiling as calibrated task-work or billing-cost control.

Suggested acceptance record:

```text
Candidate:
Host instance/version:
Protocol version:
Automated gate/test count:
Root reconnect:
Host independence:
Writer/read-only concurrency:
Crash continuation:
Completion/children:
Five-minute observation:
Artifact confinement:
Known P2 exclusions:
Accepted by/date:
```

### Executed P1 acceptance record — 2026-08-30

- Candidate: the cold-session continuation follow-up based on `e3edd09`; its
  commit is the Git revision containing this acceptance record.
- Host: `6cba2056-6ace-4cec-ba6b-d1afc3950d2d`, version `0.1.1-rc.2`,
  protocol version 1, `http://127.0.0.1:18080`.
- Automated gate: PASS — build, typecheck, `git diff --check`, bootstrap,
  offline doctor 7/7, live doctor 8/8, 16 test files and 248/248 tests.
- Durable Root identity: PASS — session
  `session-53cd2fff-2324-40d5-af4f-2d2e9dc4cde2` completed two distinct
  runs while retaining the same Host/cwd/session identity.
- Hard read-only: PASS — both file-tool and bash writes were runtime-denied,
  approval remained unavailable, the probe file was absent, and Git remained
  unchanged.
- Writer authority: PASS — concurrent same-real-worktree Root B was rejected
  before provider execution while Root A held the lease; B was admitted only
  after A's valid terminal boundary.
- Crash continuation: PASS after finding and fixing one live-only defect. The
  first real Host restart proved the complete-tree capsule but exposed that
  admission tried to read live-agent cwd before a cold persisted Root had been
  resumed. Admission now reuses DSH's native cold-session resolver inside its
  per-session critical section. A second real restart admitted the exact
  1,417-byte, model-free, complete-tree capsule, rejected a missing capsule,
  reconciled the interrupted `sleep` without replay, found no lingering
  process, and completed with a valid handoff. The regression suite covers
  successful cold resume and fail-closed resolver failure.
- Completion invariant: PASS — an intentional turn end with zero handoff calls
  returned `FAILED / MISSING_HANDOFF`; valid matching handoffs plus turn end
  returned `COMPLETED`.
- Five-minute observation: PASS — one default 300,000 ms wait returned exactly
  one `WAITING / TIMEOUT` aggregate with worker still `RUNNING`, one bash call,
  and the token delta. The next wait used its `asOfSeq`, reported only the new
  `supervisor_handoff`, did not recount bash, and completed.
- Child ownership: PASS — one direct child was shown as
  `manager=DSH_ROOT`, `childCompletionDelivery=HOST_TO_PARENT_AUTOMATIC`, and
  `codexRole=OBSERVER`. Codex sent no steer; Root received and integrated the
  child result, then published a newer terminal handoff.
- Artifact confinement: PASS in the deterministic suite — traversal, direct
  and intermediate symlink escape, hardlink aliasing, size/count limits, and
  admitted in-cwd handoff artifacts are covered.
- Operational note: a Codex/MCP process already running before the new schema
  build cannot parse complete-tree continuation packets. The live test proved
  that the independent Host/run survive that stale client; a newly started
  client reattached successfully. Restart Codex/MCP after installing this
  candidate before release acceptance.
- Known exclusion: the provider-aware budget redesign remains P2; the current
  raw token ceiling is not presented as calibrated work or billing cost.

## P1 — Recovery continuation is not durably safe across the full run tree (resolved locally)

The review originally found two coupled gaps in the recovery contract:

1. continuation admission validates the capsule schema and matching `parentRunId`, but does not prove that the parent run durably ended as `CONTINUATION_REQUIRED` or that the supplied capsule is the exact model-free fold returned for that run; a caller can omit or fabricate the capsule;
2. capsule generation folds only the Root session, so unresolved side effects, project activity, and token use in affiliated child sessions can be omitted after a Host crash.

Required outcome:

- require an exact capsule whenever `parentRunId` is supplied;
- reject a capsule unless its parent is the same session's durable interrupted run;
- recompute and compare the expected capsule, or bind it with equivalent Host-verifiable integrity;
- fold the complete affiliated run tree, failing closed when child history cannot be reconciled;
- add negative tests for missing, fabricated, stale, cross-session, and child-incomplete capsules.

Local resolution: the Host recovery route now reconstructs the complete
affiliated run tree from attached and cold persisted sessions. Capsules identify every folded session and
its durable activation/terminal boundaries, aggregate project/token evidence,
and attach the owning session to every unresolved effect. Recovery fails closed
without a capsule when any child is active, terminally unverified, or unreadable.
Continuation requires both fields, proves the parent is the current interrupted
run for the addressed session, and recomputes and compares the capsule inside
the same Host admission critical section before queueing. The raw Root fold no
longer claims complete-tree capsule coverage. Focused coverage includes missing,
fabricated but schema-valid, stale, cross-session, child-inclusive, and
child-incomplete cases; `dsh_wait` and `dsh_recover` return the same exact
run-tree capsule.

## P1 — Same-worktree concurrency was not Host-authoritative (resolved locally)

The former MCP preflight could see only sessions exposed through its current
client and `read_only` was worker guidance rather than a non-elevatable runtime
boundary. Multiple Codex/MCP processes could therefore race, and a cold
persisted writer could disappear from ownership checks.

Local resolution:

- the long-running Host owns one atomic check-and-admit boundary for all MCP
  clients; the MCP-local writer queue and check-then-act scan were removed;
- the Host merges attached agents with `sessionPersistence` snapshots and
  inspected cold sessions before task, continuation, and writer admission;
- one real worktree admits one writer Root, while independent Git worktrees may
  admit parallel writers; no workspace lock manager or lease database exists;
- `read_only` durably applies DSH's native `sandbox/mode=read-only` and
  `approval/policy=never` before the inbox insert, preventing filesystem/bash
  writes and one-shot elevation; children inherit both policies;
- writer admission applies `workspace-write` without broadening an existing
  deployment/session approval policy;
- interrupted writers retain ownership until an exact same-Root continuation;
  an ordinary new task cannot discard the recovery boundary;
- persistence enumeration/inspection failure is a typed fail-closed admission
  error.

Regression coverage includes concurrent Host admissions, cold writer ownership,
read-only/no-approval policy ordering, exact continuation revalidation,
interrupted ownership, persistence failure, and schema compatibility of the
Host-generated recovery capsule.

Validation on 2026-08-30 passed `git diff --check`, the complete workspace
build and typecheck, and all 246 tests. Bootstrap and the seven deployment
doctor checks passed; after an idle-only restart, the independently managed
Host on `127.0.0.1:18080` reported protocol version 1 / Host version
`0.1.1-rc.2`, preserved its persisted sessions, and served the new
`/api/dsh-gate.recovery-capsule` route.

## P2 — Host PID ownership is deleted under uncertainty (resolved locally)

The review found that when process inspection returned `unknown` and the Host
HTTP probe was also unavailable, `host start` treated the PID file as stale and
removed it. A restricted shell could therefore orphan lifecycle ownership for a
still-running Host.

Required outcome:

- retain the PID file and fail closed for `unknown + probe failure`;
- delete lifecycle state only after the process is positively known to be dead;
- add a startup-level regression test, not only a unit test for the three-state PID probe.

Local resolution: `host start` now retains the PID file and refuses startup for
`unknown + probe failure`; only a positive `dead` result selects stale-record
deletion. The startup decision has focused regression coverage. Verification on
2026-08-29 passed the focused script suite (54/54), the full build and typecheck,
all 239 tests, and `git diff --check`.

## P2 — DSH task budgets conflate work, resource usage, and cost

The final-review run used a manually selected 120,000-token cutoff. It consumed 112,730 tokens, then rejected the 27,473-token next input before the worker could publish a valid supervisor handoff. The run performed useful work but produced no admissible review result, so the budget choice wasted the completed model work from the user's perspective.

Required outcome:

- keep the existing 1:1 token sum only as an explicitly named emergency resource
  ceiling; it is neither a task-work estimate nor a billing-cost limit;
- bound loops independently with a model-request/step limit and expose the
  remaining count to the worker;
- reserve finalization structurally with one or more request slots, rather than
  guessing a token margin;
- make cost authority provider-aware and user-owned, using versioned pricing
  over the provider's distinct usage buckets when such pricing is configured;
- learn advisory task-work recommendations from successful comparable runs,
  not from initial context size, changed-file count, or a fixed multiplier;
- make cold-start uncertainty explicit: without enough comparable history,
  return no calibrated recommendation and require a user preset or explicit
  ceiling;
- add deterministic tests for request-slot finalization, exact next-request
  admission, cost reservation, cold-start behavior, percentile selection, and
  policy/model version isolation.

### Source-backed budget workflow

The design adapts four established controls instead of inventing one formula:

- Anthropic task budgets are advisory and model-visible; Anthropic recommends
  collecting representative unbudgeted runs and initially selecting a high
  empirical percentile rather than guessing from prompt size.
- OpenAI Agents and LangGraph bound model turns/supersteps independently from
  token accounting and expose remaining execution capacity.
- mini-SWE-agent combines a cost ceiling with an iteration limit.
- DeepSeek reports cache-hit input, cache-miss input, and output separately and
  prices them differently; repeated cached context therefore cannot be treated
  as task work or billing cost at a 1:1 rate.

Implement three independent controls:

1. **Advisory work budget.** Count newly produced task material across the run
   tree (model output and newly introduced tool-result/task content), excluding
   conversation prefixes merely resent on later stateless requests. Prefer a
   provider-native task-budget facility when available. This budget is visible
   to the worker so it can change from investigation to verification and
   handoff before exhaustion; it is not a hard billing boundary.
2. **Hard cost authority.** When a versioned provider price table is configured,
   calculate cost from the provider's authoritative usage buckets. Before a
   request, reserve the worst-case price of its measured input and capped output;
   settle the reservation from reported usage afterward. The user confirms the
   ceiling or configures an auto-approval ceiling. If pricing is unavailable or
   stale, report cost authority as unavailable rather than substituting raw
   tokens.
3. **Hard request/step authority.** Limit total model requests across Root and
   children. Declare `finalizationRequests` as workflow structure. Ordinary work
   is no longer admitted when only those slots remain; the worker receives the
   remaining count and must verify/summarize/handoff. A final slot is a request,
   not a guessed number of tokens.

Keep exact request-envelope measurement for a narrower purpose: it proves
whether the *next* provider call fits its context window and any optional
emergency resource ceiling. It does not predict how many calls the task needs.
The existing `tokenBudget.maxTokens` can remain backward compatible, but its UI
and protocol description must call it a 1:1 run-tree resource ceiling.

Recommendations come from the existing model-free run journal after extending
it with provider/model/effort, task profile, request count, usage buckets,
work-token total, price-table version, and verified terminal outcome. Comparable
successful runs are selected under a versioned policy. Bootstrap at the 99th
percentile as recommended by Anthropic; tune the percentile only from measured
completion rate and cost. Report the sample count, percentile, policy version,
and confidence with every recommendation. Do not emit a recommendation when the
policy's declared minimum sample requirement is not met.

The initial user flow is therefore:

1. classify the run under a visible, versioned task profile;
2. return a calibrated recommendation when comparable history exists;
3. otherwise present only user-owned named presets/limits, clearly marked
   uncalibrated;
4. let the user confirm or override, subject to any configured organizational
   ceiling;
5. pin the complete budget policy and price-table versions for the run;
6. report work, requests, provider usage buckets, and cost separately during
   observation and in the terminal run record.

Reuse decision: **adapt existing mechanisms**. Extend the current Host token
meter, atomic request reservations, provider usage fold, run journal, and
versioned policy catalog. Do not add a second budget service or use the RAG
module for budget estimation.

Primary references:

- Anthropic, `Task budgets` and `Optimizing for cost and intelligence`;
- OpenAI Agents SDK, `Running agents` and `Usage`;
- LangGraph, `Graph API overview` (`recursion_limit` and remaining steps);
- mini-SWE-agent, default agent cost/step limits;
- DeepSeek, chat usage, multi-round chat, context caching, and pricing docs.

Evidence from the failed review run:

- configured limit: 120,000;
- settled usage: 20,590 uncached input + 87,936 cache read + 0 cache write + 4,204 output = 112,730;
- remaining: 7,270;
- next measured input: 27,473;
- completed work: 8 steps, 9 tool calls, `pnpm verify` passed;
- terminal protocol result: no valid supervisor handoff; `ESCALATION_REQUIRED / token-budget-request-rejected`.
