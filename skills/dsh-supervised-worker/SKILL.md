---
name: dsh-supervised-worker
description: Execute a DSH task packet under an external supervisor and finish through the supervisor_handoff protocol. Use when the prompt contains a dsh-supervised-task packet. Do not use for unsupervised DSH conversations.
---

# DSH Supervised Worker

Read the task packet identity before acting. For schema version 2, use its `sessionId`, `runId`, and `completionToken`; for a legacy schema version 1 packet, use `taskId` and `completionToken`. Also read the objective, writer mode, authority, and escalation conditions.

1. Work only inside the session cwd. In `read_only` mode, do not mutate the working tree.
2. Before adding infrastructure or an abstraction, search the repository and installed dependencies for a reusable implementation.
   When `authority.maxDirectChildren` is present, you may create that many direct children during this run without asking the supervisor again. The Host enforces the durable limit; a denied over-limit start is a resource boundary, not a request for more authority.
3. When a recovery attempt fails, call `supervisor_report_failure` with a stable, worker-chosen semantic `failureSignature` and the attempted hypothesis. The runtime limits the budget for that reported signature; it does not infer semantic similarity for you.
4. Verify changes with the narrowest relevant tests, then typecheck, lint, or build in proportion to risk.
5. At meaningful phase changes, you may call `supervisor_progress` with the current packet identity, bounded `phase`, `milestone`, `nextAction`, optional hypothesis/risk, and `needsSupervisor`. When asking for a decision, also provide its category, impact, blocking state, concise request/options, recommendation, and whether a human is inherently required. Never claim pre-authorization; only the task packet grants it. The tool never ends the turn, and runtime policy decides immediate versus cadence delivery. Do not emit routine tool narration: identical records are ignored and ordinary updates are limited to one per minute.
6. Report artifacts as relative paths inside the session cwd. Absolute paths, traversal, symlinks, hardlinks, non-files, and paths resolving outside the cwd are rejected. Keep `supervisor_handoff.summary` at or below 2048 characters; when more detail is needed, write a Markdown report under `.dsh-handoff/<runId>/` for schema version 2 (or `.dsh-handoff/<taskId>/` for legacy v1) inside the session cwd, include its relative path in `artifacts`, and reference it from the concise summary.
7. End with exactly one `supervisor_handoff`. For schema version 2 include the matching `sessionId`, `runId`, and `completionToken`; for schema version 1 include `taskId` and `completionToken`. Include status, concise summary, files, verification, blockers or failure data, and artifacts. The tool validates the identity before it concludes the turn, so correct any rejected identity instead of ending with plain prose.

Use `completed` only when the objective and verification are complete. Use `blocked`, `major_checkpoint`, `escalation_required`, or `failed` accurately. A plain final message or turn end is never a successful handoff.
