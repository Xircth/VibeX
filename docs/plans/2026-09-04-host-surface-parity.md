# Host 能力面完整暴露 — 实施计划

依据 [ADR-0078](../adr/0078-host-command-registry-single-seam.md)。目标：用户通过 WebUI 或 Workstation 客户端操作 Host，与本机桌面同一条产品路径。

## 完成定义

1. 前端源码中每一个产品命令字面量都能被 Host 注册表解析，或明确属于 `DESKTOP_SHELL_COMMANDS`。
2. `capabilities` 由注册表派生，不含未实现能力。
3. 会话时间线、项目/工作区列表、文件树、终端、Git 读写在 Web 与远程桌面端到端可用。
4. 选目录选的是 Host 文件系统；时间线图片不依赖 `convertFileSrc`。
5. 桌面本机走同一 `application_call` + `HostApplicationDomains`；被迁入的 Tauri command 已删除。
6. 契约测试与 `generate-types:check` 守住边界。
7. 本机控制台、CEF、桌面壳按 `desktop.tauri` 诚实隐藏。

## 批次

### B0 — 骨架与契约

- `crates/server/src/host/`：`context`、`events`、`registry`、`dispatch`
- `host_commands!` 宏 + `HostApplicationDomains`
- 生成 `shared/hostCommands.ts`
- 前端扫描测试 + Rust 注册表测试
- `AppState` / `HeadlessServer` 持有 `Arc<HostContext>`

### B1 — 会话主路径

- 注册 `conversation_detail`、`conversation_events_since`、`conversation_ensure_session_controls`
- Host Event Bus 发出 `conversation-events:{id}` 行操作批次
- `WebTransport.listen` / `RemoteDesktopTransport.listen` 经 `host_event` 订阅
- `RemoteDesktopTransport.subscribe` 改走 Rust 侧 WebSocket
- 时间线在所有环境保持同一消费路径（detail + listen + events_since）

### B2 — Patch 流订阅

- 订阅资源 `patch_stream`
- `usePatchStream` 替换 `useTauriPatchStream`
- 删除 9 个 `subscribe_*_stream` Tauri command

### B3 — 产品命令迁入注册表

按域把实现从 `src-tauri/src/commands` 迁到 `crates/server/src/host/<domain>.rs`，`HostContext` 为唯一依赖：

- Project / Repo / Workspace / Git / PR / Worktree
- Session / Task / Tag / Scratch / Image / Attention
- File tree / Filesystem / Terminal（含 attach 重桥接与 Agent 终端）
- Conversation 辅助（attach 保留为桌面订阅引导，HTTP 不暴露该名）
- Agent 运行时 / Agent 管理 / 供应商 / Skill / Instruction / MCP
- Plugin（非桌面壳部分）
- Chat channel
- Automation / Workflow 源读写 / 脚本 / 用量
- 系统设置、日志设置、前端偏好、版本控制探测（只读与写配置，不含安装器 UI）

每迁完一域：删除对应 Tauri command、`TauriTransport` 走 `application_call`、跑该域测试。

### B4 — 前端宿主语义

- `pickHostDirectory()` + 项目创建/克隆/文件树/插件导入
- 图片 / 本地资源走 Host 读取 + Blob URL
- 桌面壳入口按 `desktop.tauri` 隐藏
- 终端 SSE 加 `application.call` scope

### B5 — 全量重检验

- `cargo test --workspace` 相关 crate
- `frontend` 契约测试 + 会话/项目/传输测试
- `pnpm run generate-types:check`
- 对照 ADR-0033 P0 清单与本计划完成定义逐项过验
