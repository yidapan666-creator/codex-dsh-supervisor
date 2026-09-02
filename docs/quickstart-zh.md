# dsh-gate 中文快速上手

## 三种部署方式

普通用户推荐一键安装：

```sh
npx @yidapan666-creator/dsh-gate setup
```

它会下载与当前系统匹配、带 SHA-256 校验的 GitHub Release，安装 Codex
skill，写入一个有明确边界且可升级的 MCP 配置块，启动独立 Host，再执行
live doctor。裸 npm 名称 `dsh-gate` 已被无关项目占用，因此官方包使用你的
scope；安装后的命令仍然叫 `dsh-gate`。

离线或需要先审计制品时：

```sh
npm exec --offline --yes \
  --package ./yidapan666-creator-dsh-gate-0.1.1.tgz -- \
  dsh-gate setup --bundle ./dsh-gate-runtime-0.1.1-darwin-arm64-offline.tar.gz
```

离线时需要同时下载 installer `.tgz`、对应平台 runtime
`*-offline.tar.gz` 以及两个 `.sha256`；命令只从本地 `.tgz` 启动安装器，
不会访问 npm registry。也可以先全局安装 CLI。生命周期命令若没有全局
CLI，就继续使用 `npx @yidapan666-creator/dsh-gate upgrade|uninstall`。

开发者仍可使用源码部署：`pnpm bootstrap`、`pnpm host:start`、
`pnpm run doctor --live`。升级执行安装器的 `upgrade`；卸载默认保留 session
状态，只有显式传入 `uninstall --purge` 才删除状态。完整说明见
[`distribution.md`](distribution.md)。

你不需要手动调用 `dsh_start_or_connect`、`dsh_task` 或 `dsh_wait`。安装并重启 Codex 后，直接用自然语言要求 Codex“使用 DSH”即可；`codex-dsh-supervisor` skill 负责执行下面的监督流程。

## 你有哪两个选项

DSH 原生有四种 preset，但 dsh-gate 的严格监督链路只开放两种：

| 用户名称 | MCP 参数 | 适合什么任务 | 建议 |
| --- | --- | --- | --- |
| Standard | `standard` | 普通编码、修 bug、交互式调试、代码 Review | 默认选择 |
| PTC | `code` | 大范围仓库探索、许多独立读取/搜索、适合批处理的工具序列 | 明确需要时使用 |

Minimal 没有经过严格只读边界认证；Creator 拥有修改 DSH runtime 和 preset 的能力。因此，dsh-gate 会拒绝这两种模式和未经认证的自定义 preset。

模式属于 DSH session（Root），创建后固定。后续在同一个 Root 继续任务，会保持原模式；若确实需要换模式，应创建另一个 Root。

## 最简单的调用方式

在 Codex 中直接说：

> 用 DSH 在 `/绝对路径/项目目录` 完成登录接口的超时修复。先复现，再修改并跑相关测试。允许最多 3 个直接子 agent；任务 token 上限 60000。每五分钟给我一次聚合进度，打开 DSH Web 让我能看到会话。

也可以只说：

> 用 DSH 在 `/绝对路径/项目目录` 修复登录接口超时。

网关会用不调用模型的 `engineering-v1` 编译器补齐常规工程约束、验收、先聚焦后全量的验证、仅在重大问题时升级、writer 的工作区范围，以及默认最多 5 个直接子 agent。你明确写出的范围、验证、预算或子 agent 上限永远优先；设为 0 就完全禁用子 agent。

## Codex 怎样高效拆分后交给 DSH

对于包含多个结果的需求，Codex 会在当前理解请求的同一次推理里生成一个有界 `executionBrief`，不会额外调用一次规划模型，也不会给同一 working tree 启动多个互相竞争的 Root。拆分遵循以下规则：

- 提取真正的交付结果，不按原句顺序机械切段；
- 把共享文件、状态或公共接口的工作放进同一个 workstream；
- 最多生成 5 个 workstream，只记录真实依赖；
- 独立调查、Review、测试或局部实现标为 `child_candidate`；公共接口、交叉整合和最终验证留给 Root；
- 每项都带可验证的 `doneWhen`，但不复制聊天记录、推理、日志、diff 或工具输出。

例如“修复登录、token 刷新、断连恢复和并发请求”会被压缩成类似：

```text
AUTH       token 生命周期与聚焦测试             child_candidate
RECOVERY   断连后复用同一 Host/session          dependsOn: AUTH
RACE       并发刷新和失败回滚                    child_candidate
Root       统一接口、解决交叉修改、完整验证与 handoff
```

这四项作为一个 durable task packet 一次性交给一个 DSH Root。Root 再根据成本和依赖决定是否真的开子 agent；`scopeHints` 只是规划提示，真正的写入权限仍由 `allowedScope` 强制限定。任务确实只有一项时，Codex 可以省略该结构，网关会明确记录 `SINGLE_STREAM_FALLBACK`，不会假装做过语义拆分。

没有指定模式时，Codex 会选择 Standard。开始时 Codex 应明确告诉你：

- 新建还是复用哪个 DSH Root；
- 使用 Standard 还是 PTC，以及选择原因；
- 项目目录、writer/read-only、token budget 和子 agent 上限；
- DSH Web 地址。

## Standard 示例：让 DSH 编码

> 用 DSH 在 `/Users/me/projects/my-app` 修复 issue #42。使用 Standard 模式。可以修改代码并运行相关测试，最多开 2 个直接子 agent，token 上限 80000。不要发布、推送或删除文件。完成后告诉我修改文件、验证结果、工具调用数和 token 使用量。

适合连续编码、根据测试结果调整实现、需要与工具逐步交互的任务。

## PTC 示例：先做大范围只读 Review

> 用 DSH 的 PTC 模式只读检查 `/Users/me/projects/my-app` 的认证链路。重点看 session 恢复、并发 writer 和 token budget，允许最多 5 个直接子 agent，token 上限 50000。不要修改文件。给出按 P0/P1/P2 排序且带文件位置的结论。

PTC 会把适合并发或批处理的读、搜索、命令放进 `run_code`。dsh-gate 仍会从 durable `tool/code-dispatch*` 事件中统计实际的内层工具调用，并执行与 Standard 相同的 handoff、恢复和完成校验。PTC 不代表必然更省 token；预算仍应由你明确设置。

## 同一个 Root 继续下一项工作

当前任务完成后，可以说：

> 继续使用刚才的 DSH Root，根据 Review 结果修复 P1。保持原来的模式和项目目录，token 上限 40000，最多 3 个直接子 agent。先告诉我将复用的 sessionId，再派发新 run。

同一 `sessionId` 是持续会话地址；每次新任务会得到新的 `runId`。Codex 不应把旧 run 的 wait、answer 或 cancel 用到新 run 上。

## Codex 或 MCP 重启后继续

如果你知道标识：

> 重新连接 DSH session `<sessionId>` 的 run `<runId>`，不要重发任务。先 recover，再从返回的 observation cursor 继续等待，并打开现有 DSH Web 会话。

如果标识丢了：

> 帮我找回刚才在 `/Users/me/projects/my-app` 运行的 DSH 任务。先用 durable run 列表定位，不要重新派发；找到后 recover 并继续监督。

MCP 退出不会顺带停止独立运行的 DSH Host。若 Host 本身重启并中断 turn，Codex 会使用 runtime 生成的有界 recovery capsule 新建 continuation run；不会复制整段旧提示或盲目重放结果不确定的工具调用。

## 你在运行中会看到什么

普通进展按五分钟聚合汇报，而不是每个小事件都打扰你。汇报包括：

- 新完成的 step 数；
- 新增工具调用及按名称计数；
- token 增量；
- 已确认的项目文件修改和测试/build/lint/typecheck；
- 最新 worker milestone；
- 当前 worker 状态以及是否需要你处理问题或授权。

敏感授权、无法替你决定的问题、checkpoint、失败、协议错误和最终完成可以提前返回。只有有效 `supervisor_handoff`、对应的 `turn/end`，以及所有关联子 agent 收敛后，任务才会显示 `COMPLETED`。

## Codex 实际执行的链路

1. 记录 Git 基线，决定新建或复用 Root，并选择 Standard/PTC。
2. 调用 `dsh_start_or_connect`，用返回的 `browserUrl` 打开已鉴权的 DSH Web；该 URL fragment 是本机凭据，不写日志、不分享，也不能当成 `hostBaseUrl` 回传。
3. 调用 `dsh_task`，记录唯一的 `sessionId + runId`。
4. 使用 `dsh_wait` 每五分钟取得一次聚合观察；必要时处理明确的交互或恢复。
5. 只在严格完成条件成立后汇报完成，并给出步骤、工具、token、文件和验证总结。

日常使用时，你只需要写清任务目标、项目绝对路径、是否允许修改、预算和子 agent 上限。其余协议步骤应由 Codex 完成。
