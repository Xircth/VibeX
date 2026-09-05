---
status: accepted
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Host 能力面只有一个接缝：Host Command Registry 与 Host Event Bus

## Context

ADR-0033 规定桌面与 Server 共用同一 Application Core，Tauri command 与 HTTP handler
只做认证与 DTO 转换。2026-09-04 的全局检查表明这条规则在代码里没有成立：

- 前端通过 `BackendTransport` 调用 478 个后端命令；`vibex-server` 与桌面远程监听只
  注册了 173 个。其余 354 个在 WebUI 与远程 Workstation 下返回
  `command X is not registered`。
- 桌面本机的 `application_call` 没有挂 `ApplicationDomainPort`，`ServerApplicationDomains`
  是一份只服务 Server、桌面日常从不执行的平行实现。没有任何契约测试约束前端命令名
  与 Server 注册表的关系，漂移是结构性的。
- 会话时间线依赖 Tauri 事件 `conversation-events:{id}` 与 Tauri-only 命令
  `conversation_detail` / `conversation_events_since`；`WebTransport.listen` 与
  `RemoteDesktopTransport.listen` 只实现 `terminal-output:*`，其余 12 类推送事件在远程
  环境静默失效。`RemoteDesktopTransport.subscribe` 轮询一个 Server 上不存在的
  `conversation_attach`。
- 9 个 `subscribe_*_stream` patch 流只有 Tauri 实现；Server WS 只有
  `conversation` / `workflow_run` 两种订阅资源。
- Server 的 `capabilities` 是静态列表，声明了 `workspace.write`、`git.write` 等未实现的
  能力，前端无法据此诚实降级。
- 项目创建、克隆、文件树、插件导入直接调用 Tauri 原生对话框；时间线图片使用
  `convertFileSrc`。在浏览器里抛错，在远程桌面里语义错误（选的是客户端路径）。

用户可见结果：连上 Host 后能看到项目列表，点进去是空的；建出会话并发送后 Agent 在
Host 上运行，但界面永远不显示回复。

## Decision

### 1. Host 产品命令只有一份实现，位于 `crates/server::host`

所有面向 Workstation / WebUI 的产品命令（Project、Repo、Workspace、Git、PR、Session、
Task、Tag、Scratch、Image、Attention、Conversation 辅助、Agent 运行时、Agent 管理与
供应商、Skill、Instruction、MCP、Plugin、Chat channel、Automation、Workflow、系统设置、
日志设置等）的实现从 `src-tauri/src/commands` 移入 `crates/server/src/host/<domain>.rs`，
以 Tauri 无关的 `HostContext` 为唯一依赖。`src-tauri` 不再保留这些实现的副本。

`HostContext` 持有 Host 运行时的共享事实：`LocalDeployment`、`AgentRuntime`、
`ConversationContext` 组件、Plugin 控制面与 Worker Runtime、PTY、Agent 管理运行时状态、
本地历史导入运行时、用量缓存、以及 Host Event Bus。桌面 `AppState` 与
`HeadlessServer` 都持有同一个 `Arc<HostContext>`。

### 2. Host Command Registry 是唯一注册表

活接缝是 `application::DomainCommand` + `RegisteredCommand`（Conversation / Workflow
用例由 Application Core 直接实现，其余产品命令由 `ServerApplicationDomains` 派发）。
`pnpm run generate-types` 从 `RegisteredCommand::host_command_names()` 写出
`shared/hostCommands.ts`。ADR 里的 `host_commands!` / `HostContext` 名称对应同一职责，
不另建第二份注册表。

`crates/server::host` 用 `DomainCommand` 登记每个命令的名称、所需
scope、参数结构与实现函数，并生成：

- `HOST_COMMANDS: &[HostCommandDescriptor]`——命令名、scope 的静态清单；
- `dispatch(ctx, name, args)`——JSON 参数按 camelCase 反序列化为类型化参数后调用实现。

`crates/application` 不再硬编码 `DomainCommand` 枚举；`ApplicationDomainPort` 暴露自己的
描述符清单，`CommandRegistry` 据此解析名称与 scope。Conversation / Workflow 用例仍由
Application Core 直接实现。

`ServerCapabilities.capabilities` 由注册表 scope 派生，加上各适配器真实提供的能力
（HTTP/WS 适配器加 `preview.proxy`、`offline.read`、`notification.summary`；桌面加
`desktop.tauri`）。不允许出现没有对应实现的能力字面量。

### 3. 桌面走同一个接缝

桌面 `application_call` 挂载 `HostApplicationDomains`。`TauriTransport.call` 把所有
注册表内的命令经 `application_call` 发出；只有桌面壳命令直接 `invoke`。桌面壳命令是
一个显式、有限的前端清单 `DESKTOP_SHELL_COMMANDS`（窗口、托盘、Toast、原生对话框、
Inspector、外部编辑器/终端/文件管理器、更新器、本机控制台：监听、隧道、备份、设备、
远程档案），它们只在 `desktop.tauri` 能力存在时可用，UI 据此隐藏入口。

被移入注册表的命令对应的 Tauri command 与 `invoke_handler!` 条目一并删除。

### 4. Host Event Bus 是唯一推送面

Host 发出的推送事件（会话行操作批次、Agent 管理事件与失效通知、Agent 终端生命周期、
会话注意事项、工作区会话变化、设置文件变化、日志追加、本地历史导入进度）通过
`HostEventBus::emit(channel, payload)` 发出，不再直接调用 `AppHandle::emit`。

- 桌面适配器把总线转发到 Tauri 事件，频道名不变；
- Server WS 新增订阅资源 `host_event { channel }`，按 scope 校验频道前缀；
- `WebTransport.listen` 与 `RemoteDesktopTransport.listen` 通过该资源实现，
  `terminal-output:*` 保留 SSE 路径；
- `RemoteDesktopTransport.subscribe` 与 `listen` 由 Rust 侧持有凭据的 WebSocket
  客户端承载，凭据仍不进入 WebView。

### 5. Patch 流是订阅资源

新增订阅资源 `patch_stream { stream, args }`，覆盖原 9 个 `subscribe_*_stream`：
`projects`、`project_workspaces`、`execution_processes`、`diff`、`file_tree`、`scratch`、
`slash_commands`、`log`、`conversation`。生产者仍是 `deployment.events()` 中的现有流。
WS 在附着时启动生产者、在分离时停止；桌面通过 Channel 承载同一资源。
`useTauriPatchStream` 改为 `usePatchStream`，在所有环境只用 `transport.subscribe`。
9 个 Tauri 命令与对应事件频道删除。

### 6. 会话时间线在所有环境使用同一路径

`conversation_detail`、`conversation_events_since`、`conversation_ensure_session_controls`
进入注册表；实时行操作经 Host Event Bus 的 `conversation-events:{id}` 频道到达。
原始事件的 durable attach（`conversation` 资源）继续服务 Companion 与离线缓存。

### 7. 主机文件系统语义

选择目录一律是选择 **Host** 上的目录。`pickHostDirectory()` 在 `desktop.tauri` 存在时
使用原生对话框，否则使用基于 `list_directory` 的 `FolderPickerDialog`。时间线图片与
本地资源通过注册表命令读取并以 Blob URL 呈现，不再使用 `convertFileSrc`。

### 8. 契约测试

- Rust：注册表命令名唯一；每个描述符可被解析并具有 scope；capabilities 与注册表一致。
- `pnpm run generate-types` 额外生成 `shared/hostCommands.ts`（注册表命令名与 scope），
  `generate-types:check` 检查其新鲜度。
- 前端：扫描 `frontend/src` 中的命令字面量，每一个必须属于 `hostCommands` 或
  `DESKTOP_SHELL_COMMANDS`；`DESKTOP_SHELL_COMMANDS` 与 `hostCommands` 不相交。

## Consequences

- `vibex-server`、桌面作为 Host、桌面本机三种运行方式执行同一份命令实现；Server 不可能
  再落后于桌面。
- 桌面 IPC 的错误从 `AppError` 字符串统一为 `ErrorEnvelope`；`BackendTransport` 把它
  规范化为带 `code` 的 `Error`，前端按 `message` 匹配的既有逻辑不变。
- `crates/server` 体量显著增大；它是 Host 核心而非仅 HTTP 适配器，与 ADR-0033、
  ADR-0054 对 Host 的定义一致。
- CEF 浏览器、Office、更新器、备份、隧道与设备管理保持桌面壳 / 本机控制台专属，按
  ADR-0054 不进入远程面，并通过 `desktop.tauri` 诚实降级。
- ADR-0070 的 R0 与 R2 由本决定完成。

## Considered Options

- **按 P0 清单把缺失命令逐个复制进 `ServerApplicationDomains`。** 否决。保留两份实现，
  桌面日常不执行 Server 路径，漂移会再次发生。
- **让 Axum handler 调用 Tauri command。** 否决（ADR-0033 已否决）。
- **前端会话时间线改为消费原始事件并在前端折叠。** 否决。与"消灭双投影"决定冲突。
- **WebUI 直接使用管理员 token 时放开所有命令，Workstation 保持子集。** 否决。能力面
  由注册表与 scope 决定，与凭据类型无关。
