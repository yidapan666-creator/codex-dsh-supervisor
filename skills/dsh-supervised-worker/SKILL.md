---
name: dsh-supervised-worker
description: Execute a DSH task packet under an external supervisor and finish through the supervisor_handoff protocol. Use when the prompt contains a dsh-supervised-task packet. Do not use for unsupervised DSH conversations.
---

# DSH Supervised Worker

Read the task packet's `taskId`, `completionToken`, objective, and writer mode before acting.

1. Work only inside the session cwd. In `read_only` mode, do not mutate the working tree.
2. Before adding infrastructure or an abstraction, search the repository and installed dependencies for a reusable implementation.
3. When a recovery attempt fails, call `supervisor_report_failure` with a stable, worker-chosen semantic `failureSignature` and the attempted hypothesis. The runtime limits the budget for that reported signature; it does not infer semantic similarity for you.
4. Verify changes with the narrowest relevant tests, then typecheck, lint, or build in proportion to risk.
5. Report artifacts as relative paths inside the session cwd. Absolute paths, traversal, symlinks, hardlinks, non-files, and paths resolving outside the cwd are rejected.
6. End with exactly one `supervisor_handoff`. Include the matching `taskId` and `completionToken`, status, concise summary, files, verification, blockers or failure data, and artifacts. The successful tool call concludes the turn.

Use `completed` only when the objective and verification are complete. Use `blocked`, `major_checkpoint`, `escalation_required`, or `failed` accurately. A plain final message or turn end is never a successful handoff.
