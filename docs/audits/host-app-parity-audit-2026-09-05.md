# Host + APP 壳与纯桌面一致性审计报告

日期：2026-09-05  
审计对象：当前工作树 `/Users/mac/Projects/VibeX`  
审计限制：本轮只读检查；没有修改产品代码。新增的审计交付物不属于产品代码。

## 结论

当前实现**不能证明，也尚未达到“Host + APP 壳与纯桌面完全一致”**。Host 命令注册表、共享 Application Core、远程 WebSocket、Host Event Bus 和主机文件选择器已经落地了相当一部分，但实现仍是迁移中的混合态：有些路径走统一 Host 接缝，有些路径仍走桌面专属命令；有些流具备持久序列，有些流只有进程内广播；声明的命令集合很大，但端到端验证覆盖很小。

按两轮证据，存在 6 个 P0 阻断问题、8 个 P1 高风险问题和若干 P2 完整性问题。只要任一 P0 存在，就不能把远程 Workstation 视为纯桌面的等价替代，也不能把“命令已经列入 `HOST_COMMANDS`”当作能力已接管。

## 审计基线与方法

本轮完整读取了 `CONTEXT.md`，以及与 Host 家族、Application Core、远程协议、设备配对、会话恢复和 Host 接缝直接相关的 ADR：0033、0054、0056、0058、0059、0061、0062、0068、0071、0074、0078。仓库声明的 `/Users/sean/Documents/Projetcs/VibeX/.agents/skills/maiden-skill/SKILL.md` 与当前机器路径不一致且不存在；当前可见的 `/Users/mac/.agents/skills/maiden-skill/SKILL.md` 也不存在，因此只能依据仓库 `CONTEXT.md`、`CLAUDE.md` 和 ADR 执行等价的只读审计，未假装已读取缺失文件。

检查包括：

- 逐层阅读 `crates/application`、`crates/server`、`src-tauri`、`frontend/src/lib/transport`、`shared/hostCommands.ts` 和关键测试。
- 统计并比对生成的 Host 命令、桌面壳命令、前端调用入口、Server 路由和事件订阅入口。
- 检查命令参数解码、scope/capability、事件序列、重连、取消、错误映射、文件路径和生命周期。
- 运行前端 Host command contract、WebTransport、TauriTransport 测试。
- 尝试运行 `pnpm run check` 和 Server 测试；本机没有 `cargo`，所以 Rust 编译与 Rust 测试无法执行。

## 能力面覆盖矩阵

| 能力面 | 当前观察 | 结论 |
| --- | --- | --- |
| Project / Repo / Workspace | 已有 `DomainCommand` 与 Server domain 分派；只做了空项目/缺失文件 smoke 检查 | 接缝存在，端到端等价未证明 |
| Conversation / Turn | Core 与 durable conversation attach 存在；桌面仍有独立 `conversation_attach` 命令 | P0，双接缝残留 |
| Timeline 实时行 | Host Event Bus 转发与 `conversation-events` 存在 | P0，广播无 durable replay，重连依赖另一路 backfill |
| Patch streams | 9 类 stream 有 Host producer 和 WS attach | P1，注册/启动/取消/丢事件没有统一契约测试 |
| Agent 管理与配置 | 大量命令进入 Host 列表，事件频道也有转发 | P1，Server 只验证极少数读路径，写路径和进度流未覆盖 |
| Git / Diff / 文件 | Host domain 有读写实现；远程路径使用 `application.call` | P1，无法证明每个桌面按钮都已切换到 Host 接缝 |
| Terminal | Host `create/write/resize/close/attach` 与 SSE/事件桥接存在 | P1，远程 attach 生命周期和重复 bridge 风险未闭合 |
| Plugin / App surface | Host domain、preview proxy、surface 命令存在 | P1，权限、租约、iframe 消息和远程 UI 旅程未完成验证 |
| Workflow / Automation | Server runtime 与 dispatcher 存在 | P1，桌面每次调用重建 Core，自动化共享状态边界不稳 |
| Host console / pairing / device | Server 路由和 preset scope 存在 | P2，管理员与 Workstation 边界需做真实矩阵测试 |
| CEF / Office / updater / native dialogs | 明确属于桌面壳或本机控制台 | 设计上不要求远程等价，必须诚实隐藏/降级 |
| IM / chat channel | Host 侧代码存在 | 本轮未完成 Telegram/飞书/微信真实闭环验证，不能宣称通过 |

## P0 阻断问题

### P0-1：桌面 `application_call` 每次请求重建 Application Core

证据：[src-tauri/src/commands/conversations.rs:407](/Users/mac/Projects/VibeX/src-tauri/src/commands/conversations.rs:407) 到 438 每次调用都重新执行 `server::host_application_core(...)`，再创建新的 `CommandRegistry`。相比之下，Server 在 [crates/server/src/runtime.rs:148](/Users/mac/Projects/VibeX/crates/server/src/runtime.rs:148) 把 Core 和 Registry 放进长期存在的 `ServerState`。

影响：桌面和 Server 的运行时事实不再具有相同生命周期。依赖缓存、订阅注册、自动化运行时、预览注册表、租约或其他内存状态的命令可能在一次调用后丢失；性能也会把初始化成本放到每个 UI 操作上。ADR-0078 要求 AppState 与 HeadlessServer 持有同一个 HostContext，这里仍是“按请求组装 Core”的迁移态。

验收要求：桌面 AppState 持有与 Host 生命周期一致的共享 Core/HostContext；连续调用、并发调用、事件订阅和自动化 lease 使用同一实例；加入 identity/lifecycle contract test。

### P0-2：`conversation_attach` 仍被列为桌面壳命令，绕过 Host Command Registry

证据：`shared/hostCommands.ts` 的 `HOST_COMMANDS` 包含 `conversation_detail`、`conversation_events_since` 和 `conversation_ensure_session_controls`，但 `conversation_attach` 位于 `DESKTOP_SHELL_COMMANDS`（生成源 [src-tauri/src/bin/generate_types.rs:300](/Users/mac/Projects/VibeX/src-tauri/src/bin/generate_types.rs:300)）。桌面实现仍在 [src-tauri/src/commands/conversations.rs:441](/Users/mac/Projects/VibeX/src-tauri/src/commands/conversations.rs:441)，而 `TauriTransport.subscribe` 在 [frontend/src/lib/transport/tauriTransport.ts:147](/Users/mac/Projects/VibeX/frontend/src/lib/transport/tauriTransport.ts:147) 直接调用它。

影响：同一会话 attach 在桌面和 Server 走两套实现；桌面版本不会使用 `host_application_core` 的 Server domain，也不会由 Host Registry 的命令/权限描述统一约束。契约测试还会把这个错误固化为“合法的桌面命令”。这直接违反 ADR-0078 第 3、6 节。

验收要求：`conversation_attach` 进入 Host Registry，桌面只通过 `application_call` 执行；桌面壳清单只保留窗口、原生对话框、本机控制台等明确壳能力；增加扫描测试禁止会话产品命令出现在壳清单。

### P0-3：Host Event Bus 是非持久广播，事件序列不能用于补放

证据：[crates/server/src/host/events.rs:28](/Users/mac/Projects/VibeX/crates/server/src/host/events.rs:28) 使用 `tokio::sync::broadcast`，只保留一个原子序列号，没有事件存储或 replay API。[crates/server/src/ws.rs:319](/Users/mac/Projects/VibeX/crates/server/src/ws.rs:319) 对 `host_event` 的 `after_sequence` 只原样放入 active subscription，attach 时返回空 replay；丢线期间产生的事件永远无法按序列补回。

影响：Agent 管理失效、设置变化、主题变化、终端生命周期、patch stream 等非 conversation 事件在断线、WS 重连或客户端短暂阻塞时可能永久丢失。桌面和远程端的“同一 Host 事实”会出现不同步，且事件序列看起来像 durable cursor，实际不是。

验收要求：逐类定义事件是 durable、可重建 invalidation 还是 best-effort；durable 事件必须落入事件日志或提供 snapshot/replay；best-effort 事件不得暴露可恢复序列，并必须有明确的重新读取路径；为断线、broadcast lag、重连和 attach 竞态写协议测试。

### P0-4：远程桌面订阅/监听没有可取消的服务端生命周期

证据：[src-tauri/src/remote_desktop.rs:165](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:165) 的 `listen_host_event` `tokio::spawn` 一个 WS pump，前端拿到的 unlisten 只取消 Tauri 事件监听；没有向 pump 发送 detach 或 abort。`subscribe_events` 在 [src-tauri/src/remote_desktop.rs:191](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:191) 同样 spawn，`RemoteDesktopTransport` 的 iterator finally（[frontend/src/lib/transport/remoteDesktopTransport.ts:94](/Users/mac/Projects/VibeX/frontend/src/lib/transport/remoteDesktopTransport.ts:94)）只设置本地 `closed`，不会关闭 Rust 侧 socket。

影响：每次组件重挂载、切换会话或重连都可能留下一个远程 WS；事件会重复投递、连接数增长，最终导致重复状态更新、资源泄漏和远程 Host 压力。`listen_host_event` 还在注册本地 listener 之前启动 pump（[src-tauri/src/remote_desktop.rs:179](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:179) 到 183），存在首事件丢失竞态。

验收要求：订阅返回显式 subscription handle；客户端 finally 必须发送 detach/取消；Rust 记录 window/profile/subscription owner 并在窗口断开时统一清理；覆盖重复挂载、取消、窗口关闭、Server 撤销设备和网络断开。

### P0-5：会话导出仍把远程 Host 内容写入客户端本地文件系统

证据：[frontend/src/lib/exportConversation.ts:1](/Users/mac/Projects/VibeX/frontend/src/lib/exportConversation.ts:1) 直接静态导入 `@tauri-apps/plugin-dialog` 和 `@tauri-apps/plugin-fs`，在 [frontend/src/lib/exportConversation.ts:34](/Users/mac/Projects/VibeX/frontend/src/lib/exportConversation.ts:34) 到 43 使用本机保存对话框和 `writeTextFile`。该函数被 Workspace session 列表和 Kanban 会话菜单直接调用，未按 transport environment 分支。

影响：浏览器/Web UI 会在运行时导入或调用 Tauri API 而失败；远程 Workstation 会把 Host 生成的会话导出写到客户端路径，和“Host 上的文件语义”相反。纯桌面与 Host + APP 壳的结果不一致。

验收要求：导出目标必须明确区分 Host artifact 与客户端下载；远程/Web 使用 HTTP 下载或 Blob download，纯桌面可继续使用本机保存对话框；导出错误和取消语义在各环境一致，并覆盖 Markdown/HTML、大文件和无标题会话。

### P0-6：远程项目创建的模板文件仍直接写客户端磁盘

证据：[frontend/src/components/dialogs/projects/ProjectFormDialog.tsx:260](/Users/mac/Projects/VibeX/frontend/src/components/dialogs/projects/ProjectFormDialog.tsx:260) 到 290 的 `writeTemplateFiles` 直接调用 Tauri `writeTextFile`。同一对话框通过 `pickHostDirectory` 取得 Host 目录，随后在 [frontend/src/components/dialogs/projects/ProjectFormDialog.tsx:293](/Users/mac/Projects/VibeX/frontend/src/components/dialogs/projects/ProjectFormDialog.tsx:293) 创建项目记录。

影响：远程选择 Host 目录后，项目记录可能在 Server 成功创建，但 README、`.gitignore` 和 LICENSE 写入客户端本地同名路径；Web 环境则直接失败。此问题会产生持久数据与 UI 反馈不一致，比单纯按钮不可用更严重。

验收要求：模板内容通过 Host Registry 的文件写入/项目创建用例在 Host 侧原子完成；客户端只提交模板选项和文本；失败时项目记录与模板文件不能处于半完成状态。

## P1 高风险问题

### P1-1：`HostEventBus` 使用全进程全局实例，无法表达 Host/数据目录隔离

证据：[crates/server/src/host/events.rs:12](/Users/mac/Projects/VibeX/crates/server/src/host/events.rs:12) 是 `static GLOBAL_BUS`。同一进程中若启动多个 Server runtime、桌面本机 Host 与远程适配器，事件都进入同一广播面；频道匹配没有 host identity 或 data-dir 维度。

影响：测试、开发模式或多 profile 场景可能出现跨 Host 事件串流。ADR-0059 要求 Server Profile 与 Host identity 唯一归属，事件也应具有相同边界。

### P1-2：Server WS attach 的错误处理会静默断开整条连接

证据：[crates/server/src/ws.rs:97](/Users/mac/Projects/VibeX/crates/server/src/ws.rs:97) 到 120 解析错误会发送 error，但 `handle_client_message(...).await.is_err()` 直接 break；HostEvent、PatchStream 未授权、参数错误或未知资源在 [crates/server/src/ws.rs:319](/Users/mac/Projects/VibeX/crates/server/src/ws.rs:319) 到 349 多数走 `Err(())`，没有带 `subscription_id` 的错误响应。

影响：一个错误订阅会杀掉同一 WS 上其他正常订阅；前端只能看到 socket close，无法区分权限不足、参数错误、版本不兼容和服务故障，重连后继续重复失败。

### P1-3：Patch stream attach 没有“注册成功后再订阅”的原子握手

证据：[crates/server/src/ws.rs:340](/Users/mac/Projects/VibeX/crates/server/src/ws.rs:340) 到 359 先执行 `subscribe_*_stream` producer，再把 active subscription 插入 map；producer 发出的第一批事件通过全局 broadcast 发送，订阅者尚未进入 `subscriptions`，因此可能丢失。返回的 bootstrap 也没有 snapshot 或 producer high-water mark。

影响：项目、文件树、diff、slash command 等初始状态可能偶发空白，尤其在远程打开页面或重连时。

### P1-4：Server capabilities 仍是 scope 集合，不是“可执行能力”的完整事实

证据：[crates/server/src/runtime.rs:137](/Users/mac/Projects/VibeX/crates/server/src/runtime.rs:137) 到 146 从 `DomainCommand::capability_scopes()` 生成 capabilities；该函数还手工加入 `device.pair`、`device.revoke`、`offline.read`、`preview.proxy` 等 scope。它没有检查具体 domain 是否已配置，也没有把 adapter 实际提供的 `preview.proxy`、`offline.read`、`notification.summary` 与注册表实现状态绑定。

影响：客户端可看到一个 scope，就误以为完整功能可用；例如能力存在但依赖运行时、租约、Agent binding 或权限尚未 ready 的情况没有细分。ADR-0078 要求 capabilities 由注册表和适配器真实能力派生。

### P1-5：命令参数契约仍靠宽松启发式解码，可能掩盖前后端不一致

证据：[crates/application/src/args.rs:1](/Users/mac/Projects/VibeX/crates/application/src/args.rs:1) 到 27 会尝试 `request`、`payload` 解包、合并 sibling 字段和原值多次反序列化。该策略有测试，但不是每个 Host command 的 typed DTO contract；同一字段在嵌套 payload 时可能被覆盖或选择另一种形状。

影响：桌面壳、WebTransport、RemoteDesktopTransport 三种调用者可以“碰巧”成功，但语义不同；错误会在错误的 DTO 分支被解释，形成静默参数漂移。

### P1-6：终端 attach 会为同一 session 重复启动 output bridge

证据：[crates/server/src/host_ops/mod.rs:1122](/Users/mac/Projects/VibeX/crates/server/src/host_ops/mod.rs:1122) 到 1141 每次 `attach_terminal` 都调用 `spawn_terminal_output_bridge`。该 bridge 没有 session 去重或 owner 生命周期。

影响：重复打开终端可能重复转发输出，且关闭订阅不会停止 bridge；远程与桌面观察结果可能重复或顺序异常。

### P1-7：Host 命令覆盖很大，但 Server 端到端验证覆盖极小

证据：生成清单有 492 个 `HOST_COMMANDS` 和 67 个 `DESKTOP_SHELL_COMMANDS`。前端契约测试只做静态扫描和集合不相交检查；Server [crates/server/tests/web_domains.rs:210](/Users/mac/Projects/VibeX/crates/server/tests/web_domains.rs:210) 只验证 `get_projects`、`agent_management_bar`、缺失文件及少量插件/自动化读路径。

影响：注册成功不代表实现成功，更不代表参数、权限、事件和 UI 结果一致。当前没有按 domain 的命令矩阵、scope 矩阵、错误矩阵和真实 UI 旅程证据。

### P1-8：RemoteDesktop 允许公网明文 HTTP，未落实公网 TLS 门槛

证据：[src-tauri/src/remote_desktop.rs:236](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:236) 到 255 只校验 scheme 是 `http` 或 `https`；测试还明确接受 `http://203.0.113.10:443`（[src-tauri/src/remote_desktop.rs:395](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:395) 到 399）。这使 HTTP Bearer token 和 WebSocket token 可被用于公网地址。

影响：ADR-0033/0054 规定公网使用必须通过 TLS 终止层。当前客户端允许把长期设备凭据发往公网明文 origin，安全边界依赖用户自觉，且 UI 没有强制区分 loopback/LAN 与公网。

验收要求：loopback/LAN 的明文例外必须可证明，非私有/非 loopback origin 强制 HTTPS；公开地址的 pairing/reachability 也必须拒绝或明确要求 TLS；增加 IPv4、IPv6、DNS、公网端口和代理场景测试。

## P2 完整性问题

- `RemoteDesktopRegistry` 把远程 profile 仅存于进程内 map（[src-tauri/src/remote_desktop.rs:27](/Users/mac/Projects/VibeX/src-tauri/src/remote_desktop.rs:27)），重启后需要重新注入 token；这不一定违反设计，但不能被误称为 Server Profile 持久化闭环。
- `RemoteDesktopTransport` 的 `artifactPreviewUrl` 接口要求 `loopbackPort`，实现完全不使用它（[frontend/src/lib/transport/remoteDesktopTransport.ts:174](/Users/mac/Projects/VibeX/frontend/src/lib/transport/remoteDesktopTransport.ts:174)），说明 transport DTO 仍有未收敛参数。
- 会话导出和项目模板是本轮新增确认的客户端文件系统越界，不能再归入“少数桌面专属能力”；它们是普通工作流，必须 Host 化或明确改成客户端下载/模板上传语义。
- Host Event Bus 的 `channel_allowed` 是手写前缀表（[crates/server/src/host/events.rs:64](/Users/mac/Projects/VibeX/crates/server/src/host/events.rs:64)），没有从事件描述符/权限派生；新增频道很容易出现“生产了但远程不允许”或“允许但没有生产者”。
- `frontend/src/lib/hostFs.ts` 已按 transport environment 分支，Web 使用 `FolderPickerDialog`，方向正确；但本轮没有完成真实 Web Server UI 的选择、路径校验、项目创建和克隆旅程，因此不能把此处视为通过。
- `window.open`、原生编辑器、系统文件管理器、更新器、CEF/CDP 等仍然存在，但其中一部分按 ADR-0033/0054 属于桌面专属能力。问题不是“必须远程复制”，而是每个入口都需要 capability gate 和可见的不可用语义。

## 已确认通过的部分

- `HOST_COMMANDS` 与 `DESKTOP_SHELL_COMMANDS` 生成后集合不相交，前端静态命令扫描测试通过。
- `WebTransport`、`TauriTransport` 和 Host command contract 定向测试共 12 项通过。
- WebTransport 使用 `vibex.v1` 子协议、Bearer HTTP、JSON-safe sequence 检查和重连游标；这些是正向基础，但还不足以证明端到端可靠性。
- Server 路由具备 `/api/v1/capabilities`、`/call/{command}`、`/ws`、配对、离线会话、通知摘要、终端输出和 preview proxy 的基本形状。
- 主机目录选择已提供 Web fallback，避免在浏览器里调用 Tauri dialog；仍需真实 UI 旅程与路径安全测试。

## 验证限制

`pnpm run check` 的前端 TypeScript 阶段通过，进入后端阶段时失败：本机 `cargo` 不在 PATH，返回 `sh: cargo: command not found`。Server Rust 测试同样无法启动。没有运行成功的 Rust 编译结果，不能对当前工作树作“后端可编译”承诺。

本轮没有启动桌面应用、Headless Server、Playwright 或真实 IM provider，因此没有把静态审计冒充为完整运行验收。报告中标为“未证明”的项目必须在修复计划的验证批次中补齐。
