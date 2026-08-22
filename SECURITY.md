# Security

`dsh-gate` is experimental, unreleased code that lets a supervisor drive DeepSeek Harness sessions over MCP. Treat it accordingly: do not run it against untrusted tasks or untrusted Hosts without review.

## Security posture

- **Writer admission.** At most one nonterminal writer task is admitted per real working tree (resolved through the Git worktree root). The admission check and task queue are serialized within one MCP process; parallel MCP processes are not serialized with each other. Read-only roots may coexist.
- **Artifact containment.** Worker-reported artifact paths must stay inside the authoritative session cwd. Admission rejects absolute paths, traversal, symlinks, hardlinks, and non-regular files, hashes through a validated file handle, and enforces per-artifact and total byte limits without loading artifacts into memory.
- **Handoff overflow containment.** Detailed handoff reports live under the gitignored `.dsh-handoff/<taskId>/` directory inside the session cwd and are admitted as relative-path artifacts. The handoff tool caps `summary` at 2048 characters, returns an actionable over-limit error, and never writes handoff data to `~/.codex` or any other global directory.
- **Approval gating.** The only operation that grants DSH a one-shot privileged action is `dsh_answer_approval`; the example Codex config forces a human approval prompt for it. DSH remains authoritative for the pending request.
- **Host independence.** The MCP process never stops the Host and never retains a kill capability over a launched Host.
- **Bootstrap containment.** The bootstrap/doctor workflow keeps all operational state (managed DSH checkout, `DSH_HOME`, logs, host metadata, install metadata) under the gitignored `.dsh-state/` directory; ordinary dependency/build outputs remain in existing gitignored workspace paths. It refuses dirty or mismatched DSH checkouts without destructive recovery, and failed phases print only their name, argv, and a credential-redacted output tail — never the environment.

## Reporting

There is no public reporting channel yet: the repository has no public URL and no maintainer contact has been published. Until one exists, treat any suspected vulnerability as a reason not to deploy the code, and report it through whatever private channel the maintainers provide once the repository goes public.
