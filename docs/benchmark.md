# Benchmark design

Use a fixed 12–20 task suite and compare three conditions against the same repository revision, tool permissions, timeout, and acceptance tests:

- A: Sol performs the task directly;
- B: one DSH worker performs it without Codex supervision;
- C: Sol supervises a DSH worker through `dsh-gate`.

The minimum 12 tasks should include two each of: localized bug fixes, cross-package changes, unknown-root-cause debugging, test additions, read-only architecture investigations, and approval/question-dependent tasks. At least two writer tasks must exercise independent Git worktrees; same-working-tree parallel writers are an invalid run, not a concurrency result. Freeze task prompts and setup commits before running any condition.

Record one row per task and condition with:

```csv
task_id,condition,setup_commit,success,acceptance_passed,wall_seconds,sol_input_tokens,sol_output_tokens,dsh_uncached_input,dsh_cache_read,dsh_cache_write,dsh_output_tokens,dsh_turns,human_interventions,approval_count,question_count,recovery_reports,terminal_status,failure_kind,notes
```

Primary metrics are acceptance-test success and wall time. Secondary metrics are Sol token use, DSH token/cache use, number of interventions, and terminal-state correctness. A run is successful only when its predeclared acceptance checks pass; model self-report is not sufficient. For condition C, `COMPLETED` must also satisfy the valid handoff plus corresponding `turn/end` invariant. Record wait timeouts as observations rather than task failures, and retain typed `failure_kind` values instead of collapsing them into a generic error.

Run tasks in randomized condition order with at least three repetitions when cost permits. Report medians and bootstrap confidence intervals; publish raw rows and exclusions. Do not claim cost savings until provider billing can be joined to the token fields—DSH telemetry currently reports token/cache quantities, while Codex owns Sol usage and quota telemetry.
