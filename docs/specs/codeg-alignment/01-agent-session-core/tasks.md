# Tasks: Phase 1 — Agent 会话核心补齐

执行环境：worktree `../VibeX-agent-session-core`，分支 `feature/agent-session-core`。

- [x] T1.1 数据迁移：sessions 增列（external_session_id/agent_type）、
      新表 agent_pending_permissions、auto_approve 字段；prepare-db + 类型生成
  - Acceptance: 迁移可重放；`prepare-db:check`、`generate-types:check` 绿
  - Verify: `cargo test -p db`；两个 check 命令
  - Files: `crates/db/migrations/*`, `crates/db/src/models/*`
- [x] T1.2 events.rs 事件面扩展 + PromptFinished 增补 stop_reason；ts 导出
  - Acceptance: 新事件序列化往返测试通过
  - Verify: `cargo test -p agents events`
  - Files: `crates/agents/src/events.rs`, `shared/types.ts`(生成)
- [x] T1.3 握手超时 + stderr 环形缓冲 + 进程退出→会话断开事件
  - Acceptance: 超时 fixture 测试通过；Windows 无可见窗口（人工冒烟）
  - Verify: `cargo test -p agents manager`
  - Files: `crates/agents/src/{manager,connection相关}.rs`
- [x] T1.4 session/load 恢复 + SessionLoadFailed 回退 + resume 命令
  - Acceptance: 成功/失败/不支持三条测试通过
  - Verify: `cargo test -p agents runtime`
  - Files: `crates/agents/src/runtime.rs`, `src-tauri/src/commands/agents.rs`
- [x] T1.5 权限多选项 + 持久化 + auto-approve/YOLO 决策器
  - Acceptance: 三条权限测试通过；重启后未决权限恢复测试通过
  - Verify: `cargo test -p agents permissions`
  - Files: `crates/agents/src/permissions.rs`, db service, commands
- [x] T1.6 SessionModes/ConfigOptions/AvailableCommands 贯通（运行时→事件→
      store→命令面）
  - Acceptance: fixture 驱动测试 + store 归约测试通过
  - Verify: `cargo test -p agents` + `pnpm vitest run stores`
  - Files: runtime/events/commands + `frontend/src/stores/*`
- [x] T1.7 preflight 模块 + 认证检测 + `agent_preflight` 命令 + 设置页接线
  - Acceptance: 表驱动检查器测试；设置页能展示诊断（最小 UI，重美化留 Phase 2/7）
  - Verify: `cargo test -p agents preflight`；手动打开设置页
  - Files: `crates/agents/src/preflight.rs`(新), commands, AgentSettings.tsx
- [x] T1.8 env 合并优先级 + spawn 去重键收口（与在途修改合流）
  - Acceptance: 合并优先级表驱动测试；并发 ensure_session 去重测试
  - Verify: `cargo test -p agents`
  - Files: `crates/agents/src/{manager,runtime}.rs`
- [x] T1.9 全 Agent 会话门验证：本机已装 Agent 实测全链路；未装的跑 fixture
      集成测试；记录每类结果
  - Acceptance: 七类 Agent 各有「实测通过」或「fixture 测试通过」记录
  - Verify: 手动 + `cargo test -p agents --test integration`
- [x] T1.10 五轴审查 → 修复 → 全门验证 → 合并回 master
  - Acceptance: A1-A14 与全 Agent 会话门均完成/裁剪记录齐全；review findings 关闭。
  - Verify: `pnpm run check && pnpm run lint && cargo test --workspace &&
    cd frontend && pnpm vitest run`

## 2026-06-13 acceptance follow-up

- [x] T1.5 follow-up: pending permissions are readable from `RuntimeSnapshot.permissions`, hydrated by the frontend store, merged into the conversation permission panel, and cancelled in both `agent_permissions` and `agent_pending_permissions` on prompt finish/error or connection disconnect/failure.
  - Verify: `cargo test -p agents runtime`, `cargo test -p db agent_runtime`, `pnpm vitest run src/features/agents/store.test.ts src/components/logs/VirtualizedList.test.ts`
- [x] T1.6 follow-up: `agent_list_session_commands` returns the latest `AvailableCommands` event for a session. `agent_set_auto_approve` persists the Agent-level auto-approve setting for future connections/resumes.
  - Cropped: live ACP `set_session_mode` and `set_session_config` remain unsupported because the current ACP command bridge has no writable mode/config request path. They are explicit follow-up work, not considered complete in Phase 1.
- [x] T1.9 follow-up: the all-Agent gate remains a deterministic in-memory ACP-compatible fixture. It validates VibeX event handling for every registered Agent type, but it is not a per-Agent recorded ACP transcript and does not spawn each real adapter.
  - Cropped: per-Agent recorded ACP message fixtures/live adapter smoke are deferred until product approval for non-deterministic external Agent runs.
- [x] Runtime correctness follow-up: prompt-level `InternalError` is emitted as `Error`, marks the prompt failed, releases its queue slot, and advances the next queued prompt.
