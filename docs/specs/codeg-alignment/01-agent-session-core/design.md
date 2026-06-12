# Design: Phase 1 — Agent 会话核心补齐

## 所属层

- 运行时：`crates/agents`（connection/manager/runtime/events/permissions/
  session/registry/distribution/config + 新增 preflight 模块）
- 存储：`crates/db`（新增迁移：会话 external_id、未决权限表、agent 运行时
  配置表扩展）
- 命令面：`src-tauri/src/commands/agents.rs`
- 类型：ts-rs 导出 → `shared/types.ts`（生成）
- 前端消费：`frontend/src/stores`（agent store）、AgentSettings、会话视图
  （仅接线，重渲染留给 Phase 2）

## 参照实现（Codeg）

| 能力 | Codeg 文件 | 移植策略 |
|------|-----------|---------|
| session/load + fallback | `src-tauri/src/acp/connection.rs` L1547-1736 | 行为对齐重写（VibeX 连接模型不同，不照抄） |
| 事件面 | `src-tauri/src/acp/types.rs` | 选取 VibeX 必需子集（约 +12 种），保持命名一致便于后续对照 |
| 会话状态机 | `src-tauri/src/acp/session_state.rs` | 引入 in-flight state（tool calls、pending permissions） |
| preflight | `src-tauri/src/acp/preflight.rs` | 移植检查项模型 CheckItem/FixAction，检查器按 VibeX 分发类型实现 |
| 握手超时 | `src-tauri/src/acp/manager.rs` L95-131 | 直接对齐（tokio::time::timeout 包裹握手 future） |
| env 合并 | `connection.rs` merge_agent_env L48-73 | 直接对齐 |

## 数据模型变更

1. `sessions` 表新增列：`external_session_id TEXT NULL`（ACP 原生 id，用于
   resume）、`agent_type TEXT NULL`。迁移向后兼容（NULL 允许）。
2. 新表 `agent_pending_permissions`：`id, session_id, request_id, tool_call_json,
   options_json, created_at, resolved_at NULL, resolution TEXT NULL`。
3. `agent_runtime_configs`（若已存在则扩展）：auto_approve 策略字段
   `auto_approve_mode TEXT CHECK IN ('off','allow_always','yolo')`。

迁移后运行 `pnpm run prepare-db` 更新 SQLx 缓存，`pnpm run generate-types`。

## 模块设计

### events.rs 扩展
新增事件按 Codeg 命名：`SessionModes{modes, current}`、`ModeChanged{mode_id}`、
`SessionConfigOptions{options}`、`ConfigChanged{key,value}`、
`AvailableCommands{commands}`、`SessionLoadFailed{reason}`、`ForkSupported`、
`SessionConfigStale`、`TurnCompleted{stop_reason}`（现 PromptFinished 增补
stop_reason 字段而非新建重复事件——复用优先）。

### connection.rs / manager.rs
- `ensure_agent_session` 增加 resume 分支：存在 external_session_id 且 agent
  capabilities 含 loadSession → `session/load`；错误→记录、发
  `SessionLoadFailed`、回退 `session/new`。
- 握手：`tokio::time::timeout(handshake_timeout(), initialize_handshake())`；
  超时 kill 子进程，stderr 环形缓冲（最近 8KB）入错误事件。
- 进程退出监听：已有 wait 任务的，补充会话断开标记 + 事件。

### permissions.rs
- `AgentPermissionRequest` 扩展 options: `Vec<PermissionOption{id,name,kind}>`。
- 应答命令携带 option_id。
- auto-approve 决策器：会话级设置 > Agent 级设置；YOLO 即对每个请求选第一个
  allow 类选项；transcript 事件标记 `auto: true`。
- 持久化：请求落库（pending），应答更新 resolution；运行时启动时加载未决项
  重播为事件。

### preflight.rs（新模块）
`pub struct CheckItem { check_id, label, status: Pass|Warn|Fail, message,
fixes: Vec<FixAction> }`；`FixAction::OpenUrl{..} | InstallUv | Custom{..}`。
检查器集合按分发类型：Npx→node/npm 版本（对照 registry 声明的最低版本），
Binary→文件存在 + 可执行，Uvx→uv 存在。认证检查（A12）也作为 CheckItem 输出
（status=Warn 表示未登录）。命令面新增 `agent_preflight(agent_type)`。

### 命令面（src-tauri/commands/agents.rs）
新增/扩展：`agent_preflight`、`respond_permission(option_id)`、
`set_session_mode`、`set_session_config`、`list_session_commands`、
`set_auto_approve`、`resume_agent_session`。全部走 ts-rs 类型。

## 新依赖

无新增 Rust 依赖预期（tokio/serde/ts-rs/sqlx 已有）。若 preflight 需要语义化
版本比较，使用已有 `semver`（若 workspace 无则添加，design 记录：Codeg 同款
需求，标准库无版本比较）。

## 替代方案备忘

- 不引入 Codeg 的全部 31 种事件：Delegation/Question/Feedback 等事件属于
  Phase 6（委托）与后续，本阶段加入会成为死代码。
- 不把 session_state 全量照抄：VibeX 已有 RuntimeSnapshot 结构，扩展优于替换。

## 测试策略

- `crates/agents`：每个新事件路径一条单元测试；resume 成功/失败回退/不支持
  三条；握手超时一条（用假 agent 进程 fixture）；权限多选项 + auto-approve +
  YOLO 三条；preflight 检查器表驱动测试。
- 前端：agent store 对新事件的归约测试（vitest）。
- 集成 fixture：每个 Agent 类型一份 ACP 消息流 fixture（参照
  `crates/agents/fixtures/` 既有结构）。

## 风险

- ACP 各 Agent 对 session/load 支持度不一：以 capabilities 探测为准，避免
  硬编码 per-agent 行为表（Codeg 亦如此）。
- 在途修改与本阶段同文件（runtime.rs/manager.rs）：Phase 0 已先行提交，
  worktree 从含其的 master 切出。
