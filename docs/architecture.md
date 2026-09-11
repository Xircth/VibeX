# VibeX 项目架构

核对日期：2026-09-06。本文依据当前仓库源码、Cargo/pnpm 工作区与已接受 ADR 写成，不沿用 2026-06-18 的 [`架构审查报告.md`](./架构审查报告.md)（该审查时 CLI executor 仍在跑 Agent，Host 家族尚未落地）。

## 1. 文档目的与一句话产品定位

本文描述 VibeX **今天**如何分层、如何持久化、以及产品命令如何到达同一套 Host 逻辑。它是架构总览，不是 ADR 汇编，也不是代码审查记分卡。

**产品定位：** VibeX 是本地优先的 AI 编程 Agent 编排工作台。它把 Claude Code、Codex、OpenCode、Google Antigravity、Cursor、Grok 等 ACP Agent 接到同一套 Project / Workspace（git worktree 隔离）/ Conversation / Turn 上，并在桌面、无头 Server、远程 Workstation 与移动伴随端之间共用一个 Host。

同一数据目录同一时刻只能有一个 **VibeX Host**（桌面进程或 `vibex-server`）。Agent 进程、Git worktree、Plugin Worker、Automation Engine、官方 MCP 与 Chat channel 适配器都跑在 Host 上。客户端（本机 UI、WebUI、另一台桌面、Android Companion、IM）只操作该 Host。

## 2. 前后端技术栈

### 前端

| 层 | 现状 |
| --- | --- |
| 语言 | TypeScript 5.9，`frontend/` 为 ESM |
| UI | React 19.2 + React Compiler（`babel-plugin-react-compiler`） |
| 构建 | Vite 5 + `@vitejs/plugin-react`；pnpm workspace（`pnpm@10.13.1`，Node ≥ 18） |
| 路由 / 数据 | `react-router-dom` 6、`@tanstack/react-query` 5、Zustand 4 |
| 设计体系 | [`DESIGN.md`](../DESIGN.md) 为视觉权威（macOS Tahoe；Liquid Glass 只用于导航/控件层，内容面不透明）。全部路由包在 `LegacyDesignScope`（历史名，现为有效设计作用域）；token 在 `frontend/src/styles/legacy/index.css`，Tailwind 配置为 `frontend/tailwind.legacy.config.js`。Radix 原语 + shadcn 兼容 token（`--surface-*`、`--text-*`、`.settings-surface`） |
| 会话渲染 | `@astryxdesign/core` 0.3.0（ADR-0039/0040）；时间线入口为 `AgentTimelineConversation` |
| 工作区布局 | Dockview 5（Conversation 是一等 Dockview 面板，ADR-0042） |
| 编辑器 / 终端 / 图 | Monaco、xterm、`@xyflow/react`、Shiki、Mermaid、KaTeX、`@git-diff-view/react` |
| 插件 UI | `@module-federation/runtime`（高频面板）+ iframe App surface（文档/富媒体） |
| i18n | i18next；`frontend/src/i18n/locales/{en,zh-CN}/` |
| 测试 | Vitest + jsdom（邻接 `*.test.ts(x)`）；Playwright（`frontend/tests-e2e/`，含 WebUI） |
| 路径别名 | `@` → `frontend/src`，`shared` → 仓库根 `shared/` |

前端 **不直接 import Rust**。业务调用与订阅走 `BackendTransport`（`frontend/src/lib/transport/`）：

- `TauriTransport`：本机 Host。注册表内命令经 Tauri `application_call`；桌面壳命令直接 `invoke`。
- `WebTransport`：浏览器连 `vibex-server`（HTTP + WebSocket，Remote Protocol v1）。
- `RemoteDesktopTransport` / `BoundHostTransport`：桌面作为 Workstation 连另一 Host。

### 后端

| 层 | 现状 |
| --- | --- |
| 语言 | Rust edition 2024；工具链钉在 `rust-toolchain.toml` 的 `nightly-2025-12-04` |
| 异步 / HTTP | Tokio 1、Axum 0.8（`macros` / `multipart` / `ws`） |
| 桌面壳 | Tauri 2（`src-tauri` 包名 `vibex`）；插件含 dialog / fs / shell / updater / deep-link / single-instance |
| Agent 协议 | `agent-client-protocol` 1.2.0（`unstable` + `unstable_session_fork`）。新能力按 ACP v2 语义设计，运行时经版本协商保留 v1（ADR-0035） |
| 序列化 | serde / serde_json；`ts-rs` 生成 TypeScript |
| TLS | 进程启动时装一次 rustls `aws_lc_rs` provider（reqwest 为 no-provider 构建） |
| 浏览器预览 | `crates/browser-cef` + `crates/browser-runtime`（CEF 150）；远程走 preview proxy，不在客户端再跑一套 runtime |

### 生成类型（禁止手改）

- `shared/types.ts`：`src-tauri/src/bin/generate_types.rs` **合并**写出。未列入替换表的声明会保留；tombstone 在 `removed_declarations()`。`pnpm run generate-types`。
- `shared/hostCommands.ts`：同一生成器从 `RegisteredCommand::host_command_names()` 写出 `HOST_COMMANDS`、`HOST_COMMAND_DESCRIPTORS`、`DESKTOP_SHELL_COMMANDS`。当前约 **499** 条 Host 产品命令、**68** 条桌面壳命令。
- Remote Protocol schema：`pnpm run remote-protocol-schema` → `docs/protocol/v1/`。

### IPC / 运输

```text
React UI
  └─ BackendTransport
        ├─ TauriTransport ── application_call / 桌面壳 invoke ── HostRuntime
        ├─ WebTransport ──── POST /api/v1/commands + WS 订阅 ── vibex-server
        └─ RemoteDesktopTransport ── 桌面作为 Workstation 连远端 Host
                    │
                    ▼
            Application Core  +  ServerApplicationDomains
                    │
     conversations / agents / plugins / workflows / automation / git / db
```

Remote Protocol 在 `crates/remote-protocol`，版本常量 `PROTOCOL_VERSION = "1.0"`。命令带 `operation_id`；会话订阅是 durable attach（ready → snapshot/replay → high-water → live）。

## 3. 进程与分层

```text
手机 Companion / IM / 其它桌面 Workstation / 本机 WebView
        │  Remote Protocol 或 Chat channel
        ▼
┌────────────────────── VibeX Host（独占一个数据目录） ──────────────────────┐
│  Desktop: src-tauri `vibex`          或  Headless: `vibex-server`        │
│       HostRuntime（ApplicationCore + CommandRegistry + HostEventBus）     │
│       AgentRuntime / PluginControlPlane / AutomationEngine / Delegation   │
│       LocalDeployment（SQLite + git + worktree + PTY + 脚本执行）         │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.1 前端（`frontend/src`）

React 应用。主窗路由在 `MainAppRoutes.tsx`：项目列表、IDE 工作区（Dockview）、设置、插件详情、Workflow Studio。独立窗：桌面 Toast（`/desktop-toast`）。

`DesktopHostBootstrap` 在 Tauri 里挂 `TauriTransport` 或绑定远端 Host；`WebTransportBootstrap` 给静态 WebUI 用。

### 3.2 Tauri 壳（`src-tauri`）

桌面二进制 `vibex`。`AppState`（`src-tauri/src/state.rs`）持有：

- `Arc<dyn Deployment>` + 具体 `LocalDeployment`
- `AgentRuntime`、`ConversationContext` 组件（turn lock / runtime state / row projector）
- `PluginControlPlane`、Worker runtime、capability broker、App surface host
- `server::HostRuntime`（与无头 Server 同一接缝）
- PTY、delegation、remote desktop registry、本机控制台状态

`src-tauri/src/lib.rs` 的 `invoke_handler!` **不再**注册全部产品命令。活接缝是 `commands::conversations::application_call` → `state.host.commands.execute_name`。仍直接 `invoke` 的是桌面壳：窗口/托盘/Toast、原生对话框与外部编辑器/终端/文件管理器、CEF 浏览器、备份、本机控制台（监听、隧道、配对、设备撤销）、远程档案、插件 dev server、Inspector。

`src-tauri/src/conversation_service.rs` 只剩壳适配：`AppConversationHost` / `AppConversationEventPublisher`。Turn 生命周期在 `crates/conversations::ConversationSessionService`。

### 3.3 Rust crates（`crates/`）

Tauri 无关的领域与基础设施。桌面与 `vibex-server` 都链接同一套 crate。见第 7 节目录地图。

### 3.4 Host 家族（ADR-0054）

一次版本同时打出：

| 产物 | 形态 | 内容 |
| --- | --- | --- |
| VibeX Desktop | dmg / NSIS / AppImage 等 | 壳 + Host + 前端 + `vibex-mcp` + 官方插件快照 |
| VibeX Server | 跨平台目录 | `vibex-server`、`vibex-mcp`、`web/`、`plugins/bundled/` |
| VibeX Companion | Android APK（iOS 后续） | 薄客户端，不跑 Agent / Git / 插件 |

无头入口：`crates/server/src/bin/vibex-server.rs` → `HeadlessServer::bootstrap`（`crates/server/src/composition.rs`）。HTTP/WS 在 `crates/server/src/runtime.rs`。打包脚本：`scripts/package-host-family.js`。部署说明：[`docs/deployment/headless-server.md`](./deployment/headless-server.md)（与当前 `HeadlessServer` / `npx vibexs serve` 一致）。

数据目录：`utils::assets::asset_dir()`。debug 桌面用仓库 `dev_assets/`；release / Server 用 `ProjectDirs`（`app.vibex.vibex`）或 `VIBEX_DATA_DIR`。同一数据目录被 Server 占用时，本机桌面只能当客户端，不能再起第二份 Host。

### 3.5 Android Companion（仍真实，但是薄客户端）

- 本仓库：`mobile/android/`（`companion-core` JVM 配对客户端 + Jetpack Compose `app` 壳，ADR-0041）。
- 产品 UI 仓：`~/Projects/vibex-remote-android`（见 `docs/companion/`）。协议权威在本仓库 `docs/protocol/v1/`，含生成的 Kotlin 模型。
- Companion **不**在手机上跑 Agent、worktree 或 Plugin Worker。配对预设为 Companion Device（会话、审批、只读 Artifact、离线缓存）。

## 4. 数据库

### 引擎与工具链

- **SQLite**，SQLx 0.8.6（`runtime-tokio` + `sqlite` + `chrono` + `uuid`）。`crates/db` 额外开 `sqlite-preupdate-hook`。
- **Offline 查询验证**：缓存 `crates/db/.sqlx/`。改 `query!` / 迁移后必须 `pnpm run prepare-db`；CI 跑 `prepare-db:check`。
- 迁移：`crates/db/migrations/`（约 135 份）。`DBService` 启动时 `sqlx::migrate!("./migrations")`，并跑 Agent/插件遗留协调（`crates/db/src/lib.rs`）。
- 模型：`crates/db/src/models/`。`crates/db` 是存储层，**不**折叠时间线（投影在 `crates/conversations`）。

### 领域聚合（当前表，不是 2025 年初的 `task_attempts` 心智模型）

历史迁移把 `task_attempts` 重命名为 `workspaces`，并拆出 `sessions`（20251216）。此后 **`sessions.id` 就是 Conversation 的物理身份**（`crates/db/src/models/conversation.rs` 写明 cutover 约定）。时间线权威已不再是 Agent transcript 文件。

| 聚合 | 主要表 | 说明 |
| --- | --- | --- |
| Project / Repo | `projects`、`project_repositories`、`repos` | 项目可挂多个 git 仓库；脚本字段在 repo 上 |
| Workspace | `workspaces`、`workspace_repos` | `use_worktree` 区分项目根工作区与隔离 worktree（ADR-0068）。`container_ref` 指向磁盘工作目录 |
| Conversation | `sessions` | 标题、pin、软删、`agent_id`、`external_session_id`、委派父指针。`workspace_id` **今天仍是 `NOT NULL`** |
| ACP 绑定 | `conversation_agent_bindings` | ACP session id、协议版本、能力 JSON、binding 状态 |
| Turn | `conversation_turns` | 每会话至多一个在途 Turn。终态：`completed` / `failed` / `cancelled` / `interrupted` |
| Event log | `conversation_events` | 仅追加；`(conversation_id, sequence)` 唯一；`idempotency_key` 去重。`event_version` 当前为 1 |
| 投影缓存 | `conversation_projection_snapshots` | 可丢弃；按 `projection_version` 失效后从事件重建 |
| 输入 / 纠偏 / 关系 | `conversation_inputs`、`conversation_steering`、`conversation_relations` | ADR-0044 控制面。关系 kind：`delegation` / `fork` / `workflow_step` |
| 工具 / 副作用 | `conversation_tool_calls` 及 permission/question 等 side-effect 表 | 从事件折叠，不是权威 |
| 用量 | `conversation_usage_snapshots`、`vendor_usage_*` | ADR-0075：协议用量从 `usage_updated` 事件增量投影；vendor jsonl 为补充 |
| 全文检索 | conversation FTS | `crates/conversations/src/search.rs` |
| 脚本进程 | `execution_processes`、`execution_process_logs` | **只跑 setup/cleanup/archive/dev-server 脚本**，不再跑 Agent |
| Agent 管理 | `agent_membership`、`agent_setting`、installation/probe/operation 表 | 纳入、启用、安装锁、探测与内置 Agent 管理动作 |
| Plugin | `plugin_*_v4`（packages / installations / activation_intents / generations / contributions / runtime_artifacts…） | 现行控制面。`plugin_control_*` 保留为只读迁移输入。`plugin_grants_v4` 已删除（全信任，ADR-0048） |
| Workflow | `workflow_definitions`、`workflow_definition_versions`、`workflow_runs`、`workflow_events`、`workflow_step_runs` | 不可变版本 + 事件化运行 |
| Automation | `automations`、`automation_runs` | 目标为 Turn 或已发布 Workflow 版本 |
| Pairing | `server_pairing_challenges`、`server_device_credentials`、`server_auth_audit_events`、`server_access_tokens` | 设备配对与管理员 token 哈希 |
| Chat channel | `chat_channel_message_log` | 入站/出站审计。通道配置在 settings store，不在独立配置表 |
| Artifact | artifact / revision 表 | 数据库存路径与证据，不存文件内容 |

### 事件溯源与投影

1. Agent 运行时经 `runtime_event_channel` 发出 `AgentEventEnvelope`。
2. `ConversationAgentEventRecorder` 写入 `conversation_events`。
3. `ConversationProjector` / `IncrementalRowProjector` 折成 `ConversationTimelineRow`。内存投影器缓存在 `ConversationRowProjectors`（桌面 `AppState` 与 Server `ConversationContext` 各持一份）。
4. 前端只消费时间线行与 row op（`frontend/src/features/conversation`、`AgentTimelineConversation`）。
5. 启动恢复把孤立在途 Turn 标为 `interrupted`，**绝不自动重发**（ADR-0001）。

## 5. 核心领域架构

### 5.1 Conversation / Turn

术语以根目录 `CONTEXT.md` 为准。实现落点：

- 控制面写入口：`crates/application::ApplicationCore`（`create` / `submit` / `steer` / `cancel` / attach）。普通输入先持久化到 `conversation_inputs`，空闲时 dispatcher 认领并开 Turn；`steer` 只追加到指定在途 Turn，不建新 Turn。
- 编排：`crates/conversations::ConversationSessionService`，依赖 `ConversationHost` + `ConversationContext`（`Deployment`、`AgentRuntime`、turn lock、runtime state、row projector）。
- 前端 Composer：`frontend/src/components/tasks/follow-up/`。`@` 引用面板（文件/会话/提交/指令）、`/` 命令、`&Agent` 提及（仅多智能体插件启用后）。

Workspace-less conversation（ADR-0006）是已接受目标：`sessions.workspace_id` 改为可空，Agent 使用 per-conversation 临时目录。 **当前 schema 与 `Session.workspace_id: Uuid` 仍为 NOT NULL**，尚未落地。

### 5.2 ACP `AgentRuntime`

`crates/agents` 是唯一 Agent 运行时。它 **不**依赖 executor / `ExecutionProcess` / `MsgStore`。

- `AgentRuntime`（`runtime.rs`）+ `AgentConnectionManager`（`manager.rs`）：stdio JSON-RPC ACP 连接、session new/resume/fork、prompt、permission、elicitation、终端。
- 调度留在 connection manager：连接、session-resume、session-fork 生命周期保持既有语义。
- 身份：`crates/api-types` 的 `AgentId` / `AgentKind`（ADR-0002）。`executors::BaseCodingAgent` 仍是配置 schema 的稳定 key；`agent_type_from_executor_key` 是过渡桥。
- 安装：用户环境（PATH / npm / uv），Installation lock 只记录观察（ADR-0060）。内置档案驱动统一管线；ACP 状态优先，本地探测补缺（ADR-0021）。
- LaunchGate 在启动前检查安装锁、鉴权模式、冲突环境变量（ADR-0064）。

### 5.3 Workspace / worktree

- `crates/services`：`WorktreeManager`、`WorkspaceManager`、`ProjectService`、`RepoService`、文件搜索、diff 流、filesystem watcher、审批。
- `crates/git`：branch / diff / remote / worktree / conflict / stats；libgit2 + CLI 回退。
- 默认从首页打开项目必须落在 **项目根工作区**（`use_worktree: false`），不得因已有 worktree 就改成隔离区（ADR-0068）。
- Agent 长期终端是 ACP 终端投影，不是用户 PTY，也不是 `ExecutionProcess`。

### 5.4 Plugin control plane

活入口是 `plugins::PluginControlPlane`（`crates/plugins`），不是 Tauri plugin API。

- 包模型：一个 Publisher + Plugin ID、版本、digest；`contents/`、`config.json`、`depends/`（ADR-0047）。
- 执行：Full Trust（ADR-0048）。独立 Worker/App frame 提供崩溃与热更新隔离，不是安全沙箱。
- 贡献：Agent（Skill/MCP/Hook/Workflow）、App（opener/preview/设置/命令/surface）、Host（Worker/事件）、Runtime。
- 官方产品 MCP（启用插件后才注入后续 Agent session）：`vibex-session-mcp`、`vibex-delegation-mcp`、`vibex-workflow-mcp`、`vibex-plugin-dev-mcp`（`crates/plugins/src/official_mcp.rs`）。
- 发行快照在 `assets/plugins/`（session-enhance、multi-agent、workflow-creator、office、plugin-development、remote-ssh、science）。`host-chrome`、`host-surface`、`provider-import` 是作者参考包，不进市场与发行物。
- 「一切皆插件」（ADR-0069）：L0 基座不插件化（会话核、ACP、git、DB、插件内核）；L1 Provider 缝与 L2 UI slot 按接管面总表推进。官方能力插件与第三方走同一控制面，无特权。

[`docs/plugins/platform-architecture.md`](./plugins/platform-architecture.md) 仍有设计期问题陈述（`OfficeRuntime`、v2/v3 双表）。以 `crates/plugins` + ADR-0046/0047/0048/0069 为准。

### 5.5 Workflow / Automation

- **Workflow**（`crates/workflows`，ADR-0045）：不可变 DAG 版本；Run 编排真实 child Conversation/Turn，不复制其历史。Studio 与 Workflow Creator 插件共用同一 Core（ADR-0052）。
- **Automation**（`crates/automation`，ADR-0032/0045）：版本化 Turn 或 Workflow 触发。单数据目录单 Engine lease；due claim 在同一事务创建 Run 并推进 `next_run_at`。默认每 Run 独立 worktree。启动恢复：遗留 direct-Turn Run → Interrupted；已关联 Workflow 的跟随原运行终态，不重放目标。

### 5.6 Delegation / MCP

- `crates/delegation`：进程内 `DelegationBroker`。父 Agent 调 MCP `delegate_to_agent` → 进程外 `vibex-mcp` → UDS/named pipe → broker → 子 ACP session。
- `crates/vibex-mcp`、`crates/vibex-workflow-mcp`：随 Host 家族分发的二进制。产品 MCP 只有对应官方插件启用后才注入。
- `&Agent` 是 LLM-mediated 委派建议，不是前端直接开子会话（ADR-0031/0057）。

### 5.7 Chat channel / pairing

- Chat channel（ADR-0056/0062）：Host 侧桥接 Telegram / 飞书 / 微信 / QQ / webhook（`crates/server/src/host/catalog/chat.rs`、`chat_inbound.rs`、`chat_notify.rs`）。授权发送者 fail-closed。入站命令与桌面权限/提问响应作用于同一事件日志。
- Pairing（ADR-0059）：本机控制台出示短时邀请（Host 身份 + 权限预设 + Reachability + 一次性 secret）。兑换得到长期可撤销 device credential。预设：Workstation Device vs Companion Device。Host 身份存在数据目录，不以 URL 识别 Host。

## 6. 依赖注入与命令缝

### `Deployment`

`crates/deployment::Deployment` 是后端服务对象安全表面：`db` / `git` / `container` / `project` / `repo` / `image` / `filesystem` / `events` / `file_search` / `approvals` / `config`。唯一实现 `crates/local-deployment::LocalDeployment`（脚本容器、PTY、worktree）。`AppState.deployment` 与 Server bootstrap 都持 `Arc<dyn Deployment>`。

PTY 不能放进 object-safe trait（向上依赖），所以桌面 `AppState.pty` 与 Server 各自持有同一 `PtyService` 句柄。

### Host Command Registry（ADR-0078，当前活接缝）

产品命令只有一份实现，在 `crates/server/src/host/` 与 `crates/application`：

| 种类 | 实现 | 例子 |
| --- | --- | --- |
| Core | `ApplicationCore` 直接执行 | `conversation_*`、`workflow_*` |
| Domain | `ServerApplicationDomains`（`crates/server/src/domains.rs`）经 `ApplicationDomainPort` | Project/Workspace/Git/Agent/Plugin/Automation/Chat/设置… |

`CommandRegistry::execute_name(principal, name, operation_id, args)` 是桌面 `application_call` 与 Server `POST /api/v1/commands` 的同一入口。capabilities 由注册表 scope + 适配器位（`AdapterCapabilities`：HTTP 加 `preview.proxy` / `offline.read` / `notification.summary`；桌面再加 `desktop.tauri`）派生，不允许声明没有实现的能力字面量。

`HostEventBus`（`crates/server/src/host/events.rs`）是唯一推送面：会话 row op、patch 流、终端输出经此到 Tauri 转发或 WebSocket。

`HostRuntime`（`crates/server/src/host_runtime.rs`）把 Core、Registry、Event Bus、preview proxy、Automation 所有权绑在一起；桌面 `AppState.host` 与 `HeadlessServer` 共用该类型。

## 7. 目录地图

### 顶层

| 路径 | 职责 |
| --- | --- |
| `frontend/` | React UI、Vitest、Playwright WebUI |
| `src-tauri/` | 桌面壳、窗口、托盘、CEF helper、`generate_types` |
| `crates/` | Host 领域与基础设施 |
| `shared/` | 生成的 TS 类型与 Host 命令表 |
| `packages/` | `@vibex/plugin-sdk`、`plugin-cli`、plugin-contract |
| `assets/plugins/` | 官方插件快照（随 Host 家族打包） |
| `mobile/android/` | Companion 配对核心 + Compose 壳 |
| `docs/adr/` | 已接受架构决定 |
| `docs/protocol/v1/` | Remote Protocol schema |
| `npx-cli/` | `npx vibexs` 安装/启动 Server |

### `crates/`

| Crate | 职责 |
| --- | --- |
| `application` | 运输无关用例：`ApplicationCore`、`CommandRegistry`、`DomainCommand`、Principal |
| `server` | Headless 组装、Axum、Host 命令实现、配对、Chat inbound、preview proxy、`vibex-server` bin |
| `remote-protocol` | 版本化 DTO、error envelope、pairing、subscription |
| `conversations` | 事件折叠、输入队列、关系、Turn 编排、用量、搜索 |
| `agents` | ACP `AgentRuntime` / 连接管理 / 安装锁 / 内置档案 / LaunchGate |
| `api-types` | 跨 crate 的 `AgentId` / `AgentKind` / 管理状态 |
| `plugins` | PluginControlPlane、Worker、App surface、marketplace、官方 MCP 门 |
| `plugin-sdk` | Worker stdio SDK |
| `workflows` | Workflow 定义/运行/事件存储 |
| `automation` | Engine、schedule、isolation、retention |
| `delegation` / `delegation-proto` | 多智能体 broker 与 IPC 帧 |
| `vibex-mcp` / `vibex-workflow-mcp` | 随 Host 分发的 MCP 二进制 |
| `db` | SQLite、迁移、行模型 |
| `deployment` / `local-deployment` | `Deployment` trait 与本机实现（含 PTY、脚本容器） |
| `services` | Workspace/worktree、config、审批、diff、PR、chat delivery、用量 |
| `git` | git 操作 |
| `executors` | **不再跑 Agent**。脚本 `ScriptRequest`、`default_profiles.json` 配置 schema、`NormalizedEntry` 日志形状 |
| `artifacts` / `tool-runtime` | Artifact 记录与声明式工具运行时锁 |
| `browser-cef` / `browser-runtime` | 本机 CEF 预览 |
| `utils` | 数据目录、进程、网络、msg_store（脚本日志，非 Agent） |
| `review` | 独立代码审查 CLI（`main.rs`） |

### `frontend/src` 要点

| 路径 | 职责 |
| --- | --- |
| `components/logs/AgentTimelineConversation.tsx` | 唯一会话时间线渲染器 |
| `components/NormalizedConversation/` | 行/工具卡 |
| `components/layout/` | Dockview 壳、项目轨 |
| `features/conversation/` | 时间线 hook 与 row op |
| `features/workflow/` | Studio |
| `lib/transport/` | BackendTransport 实现 |
| `lib/api/` | 对 Host 命令的薄封装 |
| `pages/settings/` | Agent、插件、Chat channel、Web 服务、配对控制台 |

### `src-tauri/src` 要点

| 路径 | 职责 |
| --- | --- |
| `lib.rs` | Tauri builder + 短 invoke 表 |
| `state.rs` | `AppState` |
| `commands/` | 桌面壳命令；产品命令已迁走 |
| `host_bus.rs` | 把 `HostEventBus` 接到 Tauri emit |
| `delegation/` | 桌面侧 broker 接线 |
| `bin/generate_types.rs` | TS 生成 |

## 8. 现状与迁移约束

1. **ACP-native 是唯一 Agent 路径。** 禁止在 `crates/executors` 或 `ExecutionProcess` 上加 Agent 功能。`ExecutorActionType` 只剩 `ScriptRequest`。会话 UI 不得回到已删除的 `ExecutionProcessConversation` / `useConversationHistory`。
2. **Application Core 是桌面与 Server 的同一用例缝**（ADR-0033）。新业务加在 `RegisteredCommand` / `DomainCommand`，不要在 `src-tauri/src/commands` 再写一份产品实现。
3. **Host 命令注册表是单一产品面**（ADR-0078）。`shared/hostCommands.ts` 由生成器约束前端命令名。桌面壳命令显式隔离，WebUI/Workstation 不可用时靠 `desktop.tauri` capability 隐藏。该接缝仍有收口中的 residual（例如 provider bind / remote profile host 模块正在向 `crates/server/src/host/` 集中）。
4. **Everything-is-a-plugin 是方向，不是「内核也是插件」。** L0（会话核、ACP、git、DB、插件内核）保持内置。官方插件无特权，与第三方同一控制面（ADR-0069）。能力等价官方插件可按 Host 版本白名单默认启用，其它市场插件默认禁用。
5. **Full Trust。** 不要把已删除的 `plugin_grants_v4` 或逐 capability 审批加回来。
6. **`sessions.id` = Conversation id** 仍是物理模型。不要再引入平行的 `conversations` 表当权威。
7. **Workspace-less**（ADR-0006）已决策、未改 schema。不要在文档或 API 上假装 `workspace_id` 可空。
8. **ACP v2 双协议。** 新设计对齐 v2 语义；发布必须能与只讲 v1 的 Agent 共存。
9. **生成物。** 禁止手改 `shared/types.ts`、`shared/hostCommands.ts`、`crates/db/.sqlx/`。
10. **2026-06 架构审查是历史文件。** 其中「CLI executor 跑 Agent、无 Host 家族、无 Application Core」均已过时。

## 9. 常用开发命令

在仓库根目录：

```bash
pnpm install                 # JS 依赖（跑任何 pnpm script 之前需要）
pnpm run dev                 # Tauri 桌面 + Vite HMR（== dev:desktop）
pnpm run check               # frontend tsc --noEmit + cargo check
pnpm run lint                # eslint max-warnings 0 + clippy -D warnings --features qa-mode
pnpm run format              # cargo fmt --all + Prettier
pnpm run generate-types      # 刷新 shared/types.ts 与 shared/hostCommands.ts
pnpm run generate-types:check
pnpm run prepare-db          # 刷新 SQLx offline 缓存（需 sqlx-cli）
pnpm run prepare-db:check
pnpm run host-family:package # 组装 vibex-server 目录产物
```

前端：

```bash
cd frontend
pnpm test                    # vitest run
pnpm exec vitest run src/path/file.test.ts
pnpm run test:e2e:web        # 构建 WebUI + vibex-server + Playwright
```

后端：

```bash
cargo test --workspace
cargo test -p agents acp_session_resume
cargo check                  # == pnpm run backend:check
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings
```

`qa-mode` feature 启用 `QaMock`，clippy/lint 需要它。TLS 客户端必须在 rustls provider 安装之后创建。
