# Host + APP 壳一致性修复结果

日期：2026-09-05  
工作树：`/Users/mac/Projects/VibeX/.worktrees/fix/host-app-parity-remediation`  
分支：`fix/host-app-parity-remediation`  
基线：`4cb55ae4` 加上审计当时工作区未提交改动  
工具链：`nightly-2025-12-04`（`cargo 1.93.0-nightly`）

## 结论

P0 阻断项已在同一 Host 接缝上关闭，并有回归测试。远程 Workstation 与本机桌面不再走两套 Core / 两套会话 attach / 一个进程全局广播面。会话导出与项目模板不再写入客户端磁盘。公网明文 HTTP 不能再携带设备凭据。文件回收站走 Host Registry；原生编辑器、访达、Warp、托盘/图标等桌面壳命令不再经 `backendCall` 发往 Host。

本轮没有启动桌面 UI、Headless Server 真实发行目录、Playwright 或 Telegram/飞书/微信闭环。那些旅程的协议接缝已具备，但不能把静态/单测通过写成四种客户端表面的现场验收。

## P0

| ID | 处理 | 证据 |
| --- | --- | --- |
| P0-1 | `HostRuntime` 在桌面 `AppState` 与 `HeadlessServer` 各构造一次。`application_call` 只调用 `state.host.commands`。桌面 Web Server 复用同一 `HostRuntime`。 | `src-tauri/src/state.rs`、`src-tauri/src/commands/conversations.rs`、`crates/server/src/host_runtime.rs`、`crates/server/src/composition.rs`、`command_registry_shares_the_core_arc` |
| P0-2 | `conversation_attach` 进入 `RegisteredCommand` / `HOST_COMMANDS`。桌面壳清单删除该名。独立 Tauri command 删除。 | `shared/hostCommands.ts`、`hostCommandContract.test.ts`、`generate_types.rs` |
| P0-3 | Host Event Bus 按 catalog 分成 invalidation / best-effort。attach 返回 `EventDurability`；best-effort 不 replay；invalidation 只给最新 snapshot。 | `crates/server/src/host/events.rs`、`crates/remote-protocol/src/subscription.rs` |
| P0-4 | 远程桌面 pump 有 subscription id、oneshot 取消、detach 帧、窗口/profile 断开清理。前端 listen 先挂本地监听再启动 pump；iterator finally 发送 cancel。 | `src-tauri/src/remote_desktop.rs`、`remoteDesktopTransport.ts`、`webTransport.ts` |
| P0-5 | 会话导出：纯桌面用本机保存对话框；Web / 远程 Workstation 用 Blob download。不再静态导入 Tauri FS。 | `frontend/src/lib/exportConversation.ts`、`exportConversation.test.ts` |
| P0-6 | 新建项目的 README / `.gitignore` / LICENSE 由 `create_project` 在 Host 上与 git init、项目记录同一命令完成；失败回滚新建目录和 repo 行。 | `crates/server/src/host_ops/mod.rs`、`ProjectFormDialog.tsx` |
| P0-7 | `trash_item` 进入 Host Registry（Host 回收站，受仓库/工作区沙箱约束）。其余桌面壳命令改走 `desktopShellCall`（本机 Tauri invoke），Web 抛 `capability_unavailable`。原生编辑器、访达、Warp 只在 `environment === 'desktop'` 显示；Web/Remote 隐藏入口，文件仍可用应用内编辑器。契约测试禁止 `backendCall`/`invokeAsResult`/`callApplicationCommand` 调用 `DESKTOP_SHELL_COMMANDS`。 | `DomainCommand::FileTrash`、`desktopShell.ts`、`hostCommandContract.test.ts` |

## P1

| ID | 处理 |
| --- | --- |
| P1-1 | 删除 `GLOBAL_BUS`。每个 `HostEventBus` 实例隔离。产品命令执行用 task-local 绑定当前 Host 总线。 |
| P1-2 | 单个 attach 失败返回带 `subscription_id` 的 `Error`，不关闭 WebSocket。`websocket_keeps_the_connection_when_one_subscription_is_invalid` 通过。 |
| P1-3 | Patch stream 先登记订阅再启动 producer，再 `attach_bootstrap`。 |
| P1-4 | `AdapterCapabilities`：Server HTTP 有 preview/offline/notification/device，没有 `desktop.tauri`；桌面 Host 另加 `desktop.tauri`。 |
| P1-5 | `ArgShape::{Canonical,Request,Payload,Compat}`。`conversation_attach` 为 `Request`。Domain 命令仍走已测试的 Compat，但不再是无声明启发式。 |
| P1-6 | `TerminalBridgeRegistry` 按 session 引用计数；重复 attach 不双开 pump；close 时 release。 |
| P1-7 | 全部 Host command 生成 descriptor（name/scope/kind/argShape）。契约测试约束唯一性、可解析、会话产品命令不在壳清单。 |
| P1-8 | 非 loopback/私网/`.local` 的 origin 强制 HTTPS。配对邀请和 published reachability 丢弃公网明文 HTTP。 | `remote-protocol` origin 判定、`validate_base_url`、`merge_host_reachability` |

## 生成物

- `shared/hostCommands.ts`：`HOST_COMMANDS`、`DESKTOP_SHELL_COMMANDS`、`HOST_CAPABILITY_SCOPES`、`HOST_COMMAND_DESCRIPTORS`、`HOST_EVENT_CHANNELS`
- `shared/types.ts`：`EventDurability`，`SubscriptionBootstrap.durability`

## 验证

在本工作树执行：

```text
cargo test -p application --lib
cargo test -p server --lib host::events
cargo test -p server --test host_parity_contract
cargo test -p server --test websocket
pnpm exec vitest run src/lib/transport/hostCommandContract.test.ts \
  src/lib/transport/tauriTransport.test.ts \
  src/lib/transport/webTransport.test.ts \
  src/lib/transport/remoteDesktopTransport.test.ts
cargo check -p vibex --bins
cargo run -p vibex --bin generate_types
```

通过项：application lib 29（含 `trash_item` Host 命令）；Host Event Bus 8；host_parity_contract 3（含 `trash_item`）；websocket 4；pairing_invitation 5；host_ops create_project/templates + trash payload；remote_desktop URL/TLS 3；host_tunnel reachability 3；前端 transport/contract 含「禁止 backendCall 调用桌面壳」与 `trash_item` Host 归属；desktopShell 4；terminalPreferences Warp 门控 2；exportConversation 4；ProjectFormDialog 4；LogsSettings/AgentConfigurationAndDiagnostics/ProjectCard 既有桌面路径仍通过；generate_types 写出 hostCommands（`trash_item` 在 `HOST_COMMANDS`）；vibex bins check 通过。

未作为本轮回归的项：

- `crates/server` 中 `host::native::dsh_configuration` 3 个失败来自审计基线已有的未提交 Agent/Provider 改动，不是本接缝。
- `src-tauri` lib test 因基线 `capability_probe_result` 未导出而不能编译。
- workspace clippy `-D warnings` 在 `plugins` / `agents` 上已有与本改动无关的失败。
- 未跑四种客户端表面的现场旅程，也未跑 Telegram/飞书/微信真实闭环。

## 四种表面

| 表面 | 本轮状态 |
| --- | --- |
| 纯桌面 Host | 同一 `HostRuntime`；会话 attach 走 Host Registry；事件总线为该 Host 实例 |
| 桌面 Workstation | 远程 pump 可取消；错误订阅不再杀整条 WS |
| 浏览器 Web UI | WebTransport detach 已有；subscription error 只关闭该订阅；原生编辑器/访达/Warp/设置窗隐藏或改走应用内设置；删除走 Host 回收站 |
| `vibex-server` | composition 一次构造 HostRuntime 并交给 ServerRuntime |

桌面专属（CEF、Office、更新器、本机对话框、监听/TLS/设备管理、原生编辑器、访达、Warp）仍在 `DESKTOP_SHELL_COMMANDS`，只通过 `desktopShellCall` 在 Tauri 客户端调用。
