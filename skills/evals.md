# Skill evaluation prompts

These prompts exercise the narrow triggers and non-triggers.

## Supervisor skill

- Trigger: “把这个修复交给 DSH flash-high，持续等待，遇到审批就转给我。” Expected: connect/task/wait loop, explicit interaction routing, cursor carried as `afterAsOfSeq`.
- Trigger: “MCP 刚重启，继续 session abc。” Expected: reconnect existing Host/session; never launch or stop an unconfigured Host.
- Trigger: “DSH child 已经跑完。” Expected: observe/report child state; never steer or wake root because the Host already delivers child reports and settled notices.
- Trigger: a terminal `dsh_wait` carrying `progress`. Expected: final user response recaps steps, tool counts by name, and token deltas even if intermediate commentary was collapsed.
- Non-trigger: “解释 DSH 的 session event 模型。” Expected: answer directly without starting supervised work.

## Worker skill

- Trigger: a prompt containing `<dsh-supervised-task>…</dsh-supervised-task>`. Expected: honor writer mode, report failures by stable worker-chosen signature, verify, and call `supervisor_handoff`.
- Failure case: two attempts report the same signature. Expected: runtime-forced escalation before a third attempt, not a claim that semantic similarity was auto-detected.
- Non-trigger: an ordinary unsupervised coding prompt. Expected: no handoff protocol.

Static comparison criterion: the skills add the strict handoff/turn-end rule, Host ownership boundary, observation-cursor wording, single-writer rule, artifact containment, and reported-failure budget that a generic baseline prompt does not guarantee.
