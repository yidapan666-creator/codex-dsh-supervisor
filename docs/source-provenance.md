# Source provenance

The detailed source-backed audit and reuse matrix live in `source-backed-reuse-review.md`. This shorter record tracks what reached the implementation.

| Source | Revision / package | License | Use in this workspace |
|---|---|---|---|
| DeepSeek Harness (public fork) | `7212c955438c70c9a2d168f67e85a8014b8d4488` on `https://github.com/yidapan666-creator/deepseek-harness.git` (branch `codex/mcp-network-client`), fetched by SHA via `pnpm bootstrap` | MIT | Direct public API reuse via the linked network client; no DSH source is copied into this repository. The fork commit is the pinned compatibility contract, not an upstream merge. |
| Model Context Protocol TypeScript SDK | `@modelcontextprotocol/server` 2.x | Upstream package license | Direct dependency for the stdio MCP server. |
| `1345191768/multiAgents` | `3df6b355b73b4727b7cf2dc14338928e256c839f` | MIT | Task-packet vocabulary and a TypeScript adaptation of the artifact admission checks from `src/ma/artifact_manifest.py`. |
| `obra/superpowers` | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` | MIT | Design reference for evidence-first debugging, verification, and narrow delegation language; no runtime imported. |
| `awslabs/cli-agent-orchestrator` | `e453bf86419088076220a8ab114e4bb60d987aa4` | Apache-2.0 + NOTICE | Design/test reference for a coarse MCP lifecycle surface; no code copied. |
| `maxto/agent-mux` | `b041ed5365161774c47fb9e944e96d1196f7694f` | MIT | Protocol-design reference for bounded handoffs and artifact references; no runtime copied. |
| `buildoak/agent-mux` | `4a27d544f8beeee172d9a509d917342a27ca9d7a` | MIT | Schema and test-design reference; no runtime copied. |

The artifact module identifies its adapted source in a code comment. All other external repositories in the audit are either direct dependencies through their published packages or design/test references; no tmux manager, process supervisor, workspace lock manager, workflow engine, event store, or worktree manager was copied.

The surrounding original code is released under the repository's MIT license. When redistributing, retain that license, the dependency licenses produced by the package manager, and the MIT attribution for the adapted multiAgents artifact logic.
