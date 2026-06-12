# Requirements: Phase 1 — Agent 会话核心补齐 (agent-session-core)

## Objective

把 VibeX 的 ACP 运行时（`crates/agents`）从「能跑通基本 prompt」补齐到 Codeg
级别的会话能力，确保 Claude Code、Codex、OpenCode、OpenClaw、Hermes、Gemini CLI
（以及 Cline）七类 Agent 都能：建立连接、恢复历史会话、切换模式、调整配置、
使用斜杠命令、走完整权限流，并在环境不满足时获得可自助修复的诊断。

对应差距：A1–A14（见 ../README.md）。

## User Stories

- 作为用户，我重启应用后打开之前的 Agent 会话，能继续对话而不丢上下文
  （session/load）。
- 作为用户，我能在会话中切换 Agent 的运行模式（如 plan/code/auto），并看到当
  前模式。
- 作为用户，我能在会话中选择模型等 Agent 配置项（SessionConfigOptions）。
- 作为用户，我输入 `/` 能看到该 Agent 通告的可用命令（AvailableCommands）。
- 作为用户，Agent 请求权限时我能看到该 Agent 提供的全部选项（不止允许/拒绝），
  并可设置自动批准（auto-approve / YOLO）。
- 作为用户，某 Agent 因 Node 版本不足无法启动时，我能在设置页看到具体诊断和
  修复指引（Preflight）。
- 作为用户，我能看到每个 Agent 的登录/认证状态，知道哪个需要先登录。

## Acceptance Criteria (EARS)

### A1 会话恢复
1. WHEN 用户打开一个存在 external session id 的历史会话且对应 Agent 支持
   `session/load`，THE SYSTEM SHALL 通过 `session/load` 恢复会话并回放历史
   transcript 到事件流。
2. IF `session/load` 失败或 Agent 不支持，THEN THE SYSTEM SHALL 自动回退
   `session/new` 并发出 `SessionLoadFailed` 事件（含原因），UI 呈现降级提示。

### A2 事件面扩展
3. THE `AgentEvent` 枚举 SHALL 至少新增：`SessionModes`、`ModeChanged`、
   `SessionConfigOptions`、`ConfigChanged`、`AvailableCommands`、
   `SessionLoadFailed`、`TurnCompleted{stop_reason}`、`ForkSupported`、
   `SessionConfigStale`，并通过 ts-rs 导出到 `shared/types.ts`。
4. WHEN Agent 通过 ACP 通告 modes/config/commands，THE SYSTEM SHALL 把它们
   持久化到运行时快照并广播事件，前端店面（agent store）能读到。

### A3/A8 权限体系
5. WHEN Agent 发出 permission request，THE SYSTEM SHALL 透传其全部
   `PermissionOption`（option_id/name/kind），UI 渲染全部选项。
6. WHERE 用户开启了某会话/某 Agent 的 auto-approve，THE SYSTEM SHALL 按既定
   选项自动应答并在 transcript 中标记「自动批准」。
7. THE SYSTEM SHALL 提供 YOLO（一键全批准本会话）开关，默认关闭，开启时 UI
   有持续可见的警示态。
8. WHEN 应用重启或前端刷新，未决权限请求 SHALL 从持久层恢复并重新呈现（A9）。

### A4 Preflight
9. WHEN 用户打开 Agent 设置页或首次启动某 Agent，THE SYSTEM SHALL 运行
   preflight 检查（按分发类型：Node/npm 版本、binary 存在、uv 可用、网络），
   产出结构化 `CheckItem{check_id,label,status,message,fixes}`。
10. IF 检查失败且存在已知修复，THEN THE SYSTEM SHALL 呈现 FixAction（如打开
    下载页、安装 uv）。

### A10 进程健壮性
11. THE SYSTEM SHALL 对 spawn→ACP 握手设置可配置超时（默认 60s，env
    `VIBEX_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS` 覆盖），超时后终止子进程并发出
    带诊断（捕获的 stderr 摘要）的错误事件。
12. WHEN Agent 进程异常退出，THE SYSTEM SHALL 将关联会话标记为断开、清理
    in-flight prompt、保留 transcript，并允许用户一键重连（重建连接 + 尝试
    session/load）。

### A12 认证检测
13. THE SYSTEM SHALL 按 Agent 读取认证痕迹（如 `~/.codex/auth.json`、
    `~/.claude/projects` 存在性、opencode.json 等）并在设置页与连接失败诊断中
    呈现登录状态/指引。

### A11/A14 其他
14. THE SYSTEM SHALL 实现 spawn 去重键（agent_type, working_dir, session_id），
    并保证 env 合并优先级：registry 默认 < DB 运行时配置 < 代理设置。

### 全 Agent 会话门（产品负责人硬性要求）
15. 对 ClaudeCode、Codex、OpenCode、Gemini、OpenClaw、Hermes、Cline 每一类：
    WHEN 本机已安装该 Agent 且已认证，THE SYSTEM SHALL 能完成「新建会话 → 发
    prompt → 收流式输出 → 工具调用 → 权限应答 → turn 完成 → 停止/中断 → 再次
    发送」全链路。无法在本机验证的 Agent，必须有覆盖其 ACP 消息流的集成测试
    （fixture 驱动）。

## Edge / Error Cases

- session/load 时 Agent 返回部分历史：以 Agent 返回为准，不与本地 transcript
  拼接去重。
- 权限请求在用户应答前连接断开：标记为 expired，不自动应答。
- preflight 在离线环境：网络类检查标记 Warn 而非 Fail。
- Windows：所有子进程继续走 `new_hidden_tokio_command`，不得出现可见终端窗口。

## Boundaries

- Always：每个行为切片先写/更新测试；事件类型变更后运行
  `pnpm run generate-types && pnpm run generate-types:check`。
- Ask first：数据库迁移结构有歧义时。
- Never：在前端用渲染层 guard 掩盖运行时状态 bug；为兼容旧事件加 shim。

## Success Criteria

- A1-A14 验收全过；`cargo test -p agents` 新增覆盖 ≥ 每个新事件/状态机路径
  一条测试；全门绿；手动冒烟（实际安装的 Agent 至少 Claude Code + Codex +
  Gemini 三类）通过第 15 条全链路。

## Open Questions

- Cline 在 VibeX 注册表中的分发定义是否已可用（执行时核实 registry）。
