# Tasks: Phase 6 — 多 Agent 协作委托

执行环境：worktree `../VibeX-delegation`，分支 `feature/delegation`。

- [ ] T6.1 数据迁移与关系模型
  - Acceptance: sessions 增加 `parent_session_id`、`parent_tool_use_id`、
    `delegation_call_id`、`delegation_depth`、`delegation_status`；可查询父子树；
    prepare-db 与类型生成通过。
  - Verify: `pnpm run prepare-db:check`, `pnpm run generate-types:check`,
    `cargo test -p db delegation_columns`
  - Files: `crates/db/migrations/*`, `crates/db/src/models/session.rs`

- [ ] T6.2 DelegationBroker 核心
  - Acceptance: 支持登记、状态查询、完成缓存、失败缓存、深度限制、循环检测、
    task_id/delegation_call_id 映射、父会话取消时级联取消。
  - Verify: `cargo test -p agents delegation_broker`
  - Files: `crates/agents/src/delegation/{broker,types,depth}.rs`

- [ ] T6.3 ConnectionSpawner / 一次性子会话
  - Acceptance: 子任务复用 Phase 1 runtime；可指定 agent_type、prompt、cwd、model；
    支持超时、取消、stderr 诊断、preflight 失败结构化返回。
  - Verify: `cargo test -p agents delegation_spawner`
  - Files: `crates/agents/src/delegation/spawner.rs`, runtime 接线

- [ ] T6.4 本地 IPC transport
  - Acceptance: Windows named pipe / Unix socket 二选一或双平台实现；会话 token 校验；
    伴生进程与主进程握手含版本号。
  - Verify: transport loopback 测试，Windows 权限冒烟。
  - Files: `crates/agents/src/delegation/transport.rs`

- [ ] T6.5 `vibex-mcp` stdio sidecar
  - Acceptance: 暴露 MCP tools：`delegate_to_agent`、`get_delegation_status`、
    `cancel_delegation`；stdio 协议可被假 Agent 调用；主程序缺失时返回清晰错误。
  - Verify: `cargo test -p agents --bin vibex_mcp` 或 sidecar 回环测试。
  - Files: `crates/agents/src/bin/vibex_mcp.rs` 或 `crates/vibex-mcp/*`

- [ ] T6.6 sidecar 构建与分发
  - Acceptance: dev/build 前自动准备 sidecar；Tauri externalBin 配置；`VIBEX_MCP_BIN`
    可覆盖；缺失时单条警告且会话继续。
  - Verify: `pnpm run dev`、`pnpm run tauri:build` 冒烟；检查产物包含 sidecar。
  - Files: `scripts/prepare-sidecars.js`, `src-tauri/tauri.conf.json`,
    root/package scripts

- [ ] T6.7 MCP 注入策略接 Phase 5
  - Acceptance: 按 Agent 类型写入/注入 MCP server；Hermes/OpenClaw 等不支持或需特殊
    路径时有策略表；不破坏用户既有 MCP 配置。
  - Verify: per-agent 配置写回 snapshot 测试。
  - Files: Phase 5 MCP 注入模块、`crates/agents/src/delegation/injection.rs`

- [ ] T6.8 事件面与状态同步
  - Acceptance: 新增 `DelegationStarted`、`DelegationProgress`、
    `DelegationCompleted`、`DelegationFailed`、`DelegationCancelled`；前端 store 可
    按 parent session 聚合。
  - Verify: Rust 序列化往返测试 + frontend store reducer 测试。
  - Files: `crates/agents/src/events.rs`, generated `shared/types.ts`,
    `frontend/src/features/agents/store.ts`

- [ ] T6.9 前端委托卡片与子会话视图
  - Acceptance: 消息流内显示目标 Agent、状态、耗时、摘要、取消按钮、打开子会话；
    支持状态查询/取消工具卡；子会话复用 Phase 2 渲染层。
  - Verify: `delegation-status-card`、`delegated-sub-thread` 行为测试 + 桌面冒烟。
  - Files: `frontend/src/components/NormalizedConversation/tools/Delegation*.tsx`,
    conversation detail dialog

- [ ] T6.10 权限链路与 auto-approve
  - Acceptance: 子会话权限请求路由到 UI；卡片标注“由父会话 X 委托”；auto-approve
    使用子 Agent 配置；父会话取消时未决权限关闭。
  - Verify: fixture e2e：子会话请求权限、用户批准/拒绝、父会话取消。
  - Files: permission store、delegation broker、frontend permission card

- [ ] T6.11 设置页深度与功能开关
  - Acceptance: 设置项包括启用委托、最大深度 1-8（默认 2）、默认目标 Agent、
    超时分钟；保存后新会话生效。
  - Verify: settings component test + backend config test。
  - Files: `frontend/src/pages/settings/AgentSettings.tsx` 或新 DelegationSettings,
    config model

- [ ] T6.12 E2E：真实/fixture 委托
  - Acceptance: 真实环境至少完成 Claude Code → Codex 或可用 Agent 组合；CI fixture
    不依赖真 CLI；结果回传主 Agent，UI 全程可见，取消可级联。
  - Verify: `cargo test --workspace delegation`, 手动冒烟记录。
  - Files: `src-tauri/tests/delegation_*`, fixture agent scripts

- [ ] T6.13 五轴审查 → 修复 → 全门验证 → 合并回 master
  - Acceptance: E1-E3 与 traceability #17 完成/裁剪记录齐全。
  - Verify: `pnpm run check`, `pnpm run lint`, `cargo test --workspace`,
    `cd frontend && pnpm vitest run`
