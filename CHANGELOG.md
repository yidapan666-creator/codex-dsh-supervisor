# Changelog

Notable changes to dsh-gate, tracked from the pre-publication baseline.

## Unreleased

- **Reproducible public-source deployment.** New `scripts/dsh-gate.mjs` workflow: `pnpm bootstrap` fetches the pinned public DSH fork commit (`7212c955438c70c9a2d168f67e85a8014b8d4488`, by SHA — never a branch), installs and builds it, reuses `scripts/link-local-dsh.mjs` for the network-client link, installs `@dsh-gate/supervisor-tools` into an isolated project-local `DSH_HOME` under the gitignored `.dsh-state/`, and never starts the Host; `pnpm run doctor` validates the pin, link, built artifacts, plugin/profile, and optionally a live Host (`protocolVersion=1`, `hostInstanceId`, non-placeholder `version`); `pnpm host:start|status|stop` manage the independent DSH Web Host on `127.0.0.1:8080 --no-open`. `--dry-run`, `--force`, and `--state`/`--dsh-repo`/`--dsh-home`/`--host` overrides are supported; dirty or mismatched checkouts are refused without destructive recovery; failing phases report name, argv, and redacted output. New `DEPLOYMENT.md` documents the contract, update policy, Host independence, browser visibility, clean failure recovery, and the official-upstream-PR limitation. Focused unit tests in `scripts/tests/`.
- **Long-handoff overflow convention.** `supervisor_handoff.summary` is capped at 2048 characters. When more detail is needed, the worker writes a Markdown report under the gitignored `.dsh-handoff/<taskId>/` directory inside the session cwd, passes its relative path in `artifacts`, and references it from the concise summary. Over-limit summaries fail with an actionable error and are never auto-written.
- **GitHub-readiness pass.** Added the MIT license, canonical `yidapan666-creator/dsh-gate` repository metadata, ignore/export hygiene (`.dsh-handoff/`, `.gitattributes`, `.editorconfig`), and accurate setup, contribution, security, and release-status guidance. npm/package publication remains blocked on the upstream DSH network-client release (the fork pin covers source deployments only).

## Baseline

- MCP supervision gateway over DeepSeek Harness: `dsh_start_or_connect`, `dsh_task`, `dsh_wait`, `dsh_steer`, `dsh_answer_question`, `dsh_answer_approval`, `dsh_cancel`, `dsh_agents`, `dsh_interrupt_agent`.
- DSH-side supervisor-tools plugin: `supervisor_handoff`, `supervisor_report_failure`, and artifact admission.
- Operator skills (`dsh-supervised-worker`, `codex-dsh-supervisor`), example Codex/DSH configuration, and protocol documentation.
