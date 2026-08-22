# Changelog

Notable changes to dsh-gate, tracked from the pre-publication baseline.

## Unreleased

- **Long-handoff overflow convention.** `supervisor_handoff.summary` is capped at 2048 characters. When more detail is needed, the worker writes a Markdown report under the gitignored `.dsh-handoff/<taskId>/` directory inside the session cwd, passes its relative path in `artifacts`, and references it from the concise summary. Over-limit summaries fail with an actionable error and are never auto-written.
- **GitHub-readiness pass.** Added ignore/export hygiene (`.dsh-handoff/`, `.gitattributes`, `.editorconfig`), and accurate setup, contribution, security, and release-status guidance. The source tree is ready for public hosting once the human license and repository-identity decisions land; npm/package publication remains blocked on the upstream DSH network-client release.

## Baseline

- MCP supervision gateway over DeepSeek Harness: `dsh_start_or_connect`, `dsh_task`, `dsh_wait`, `dsh_steer`, `dsh_answer_question`, `dsh_answer_approval`, `dsh_cancel`, `dsh_agents`, `dsh_interrupt_agent`.
- DSH-side supervisor-tools plugin: `supervisor_handoff`, `supervisor_report_failure`, and artifact admission.
- Operator skills (`dsh-supervised-worker`, `codex-dsh-supervisor`), example Codex/DSH configuration, and protocol documentation.
