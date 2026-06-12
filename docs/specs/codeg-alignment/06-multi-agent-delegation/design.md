# Design: Phase 6 — 多 Agent 协作委托

## 所属层

- 新二进制：`crates/agents/src/bin/vibex_mcp.rs`（或独立 crate
  `crates/vibex-mcp`——按依赖面最小化定，stdio MCP server，工具：
  `delegate_to_agent`）
- 运行时：`crates/agents/src/delegation/`（broker.rs、spawner.rs、tracker.rs）
- 存储：sessions 表已含 parent 字段需求 → 迁移补
  `parent_session_id, delegation_call_id`
- 构建：`scripts/prepare-sidecars.js`（参照 Codeg
  `src-tauri/scripts/prepare-sidecars.mjs`）+ tauri.conf externalBin
- 前端：委托卡片（DelegatedSubThread）、子会话对话框、设置页深度配置

## 参照实现（Codeg）

`acp/delegation/broker.rs`（任务登记/完成缓存/深度控制）、
`acp/delegation/spawner.rs`（ConnectionSpawner trait：一次性会话）、
`bin/codeg_mcp.rs`（stdio MCP 伴生）、`message/delegated-sub-thread.tsx`。
broker/spawner 逻辑大段移植（标注出处），连接层适配 VibeX runtime。

## 通信模型

vibex-mcp（子进程，被 Agent CLI 启动）←stdio→ Agent CLI；
vibex-mcp ←本地 IPC（命名管道 win / unix socket）→ VibeX 主进程 broker。
主进程在注入 MCP 配置时把 IPC 端点 + 会话 token 写入 vibex-mcp 的 env。
Rejected: HTTP 回环端口（端口冲突与防火墙弹窗风险，Windows 命名管道更稳）。

## 模块拆分

| 模块 | 职责 | 不做 |
|---|---|---|
| `broker.rs` | delegation registry、状态机、完成缓存、父子关系、取消级联 | 不直接 spawn 进程 |
| `spawner.rs` | 调用 Phase 1 runtime 启动一次性子会话，收集结果 | 不复制 runtime 逻辑 |
| `transport.rs` | sidecar 与主进程本地 IPC、token、版本握手 | 不暴露公网端口 |
| `tool_schema.json` | MCP tools schema 快照 | 不放业务逻辑 |
| `event_emitter.rs` | 把 broker 状态映射为 AgentEvent/Tauri event | 不持久化 |
| `meta_writer.rs` | 写入子会话 parent/delegation 元数据 | 不修改用户 prompt |

## 状态机

`queued -> spawning -> running -> succeeded | failed | cancelled | timed_out`

- `queued`：broker 已登记但子会话尚未 spawn。
- `spawning`：preflight/env/连接握手中。
- `running`：子 Agent 已开始输出。
- `succeeded`：子会话正常结束，summary/result 可回传主 Agent。
- `failed`：preflight、spawn、runtime、工具调用错误。
- `cancelled`：用户、父会话或主 Agent 调用取消。
- `timed_out`：超过超时策略，视为 failed 的专门原因。

状态变化必须持久化到 session 关系字段并发前端事件。

## 新依赖

- MCP server 协议实现：优先复用 workspace 既有 MCP 相关依赖；不足则引入
  `rmcp`（官方 Rust SDK）。记录于执行时决策。
- `interprocess` 或 tokio 命名管道（win named pipe）——执行时按最小依赖选择。

## 测试策略

- broker：登记/完成/深度超限/循环拒绝/级联取消 单元测试。
- vibex-mcp：stdio 协议回环测试（假 broker）。
- 端到端：fixture agent 脚本驱动一次完整委托（CI 可跑，不依赖真 CLI）。

## 风险

- 各 Agent CLI 对 MCP server 注入语义不同（文件 vs 命令行）：完全走 Phase 5
  策略表，本阶段不新增注入路径。
- Windows 管道权限：会话 token 校验 + 当前用户 ACL。
