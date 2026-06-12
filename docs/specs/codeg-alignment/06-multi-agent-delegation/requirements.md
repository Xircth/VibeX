# Requirements: Phase 6 — 多 Agent 协作委托 (multi-agent-delegation)

## Objective

实现 Codeg 的多 Agent 协作：主 Agent 在会话内通过 `delegate_to_agent` 工具把
子任务委托给另一类 Agent（如 Claude Code 调 Codex/Gemini），子任务作为独立
会话运行并在 UI 中可见、可打开、可取消。机制：随应用分发的 stdio MCP 伴生
二进制 `vibex-mcp`，向 Agent CLI 暴露委托工具。

对应差距：E1–E3。前置：Phase 1（事件面）、Phase 5（MCP 注入面）。

## Acceptance Criteria (EARS)

1. THE 构建产物 SHALL 包含 `vibex-mcp` 伴生二进制（Tauri sidecar/同目录分发，
   `VIBEX_MCP_BIN` env 可覆盖路径）；伴生缺失时委托功能跳过并记录单条警告，
   会话其余功能不受影响（Codeg 同语义）。
2. WHEN Agent 会话启动且委托启用，THE SYSTEM SHALL 把 vibex-mcp 作为 MCP
   server 注入该 Agent（按 Phase 5 的 per-agent 注入策略）。
3. WHEN 主 Agent 调用 `delegate_to_agent(agent_type, prompt, ...)`，THE
   SYSTEM SHALL 异步返回 task_id，spawn 目标 Agent 的一次性会话执行任务，
   完成后把结果回传给主 Agent（工具结果）。
4. THE 委托会话 SHALL 作为独立会话持久化（parent 关系：parent_session_id +
   delegation_call_id），在 UI 中渲染为委托卡片（状态/目标 Agent/可展开打开
   子会话视图）。
5. THE 委托深度 SHALL 受配置限制（默认 2，范围 1–8，设置页可调）；超限调用
   返回结构化错误给主 Agent。
6. WHEN 主会话被取消/中断，THE SYSTEM SHALL 级联取消其全部子委托会话。
7. WHEN 子会话发出权限请求，THE 请求 SHALL 路由到 UI 并标注其委托链来源；
   auto-approve 规则按子会话所属配置独立判定。
8. THE `DelegationStarted/DelegationCompleted` 事件 SHALL 进入事件面并被前端
   店面消费。

## MCP Tool Contract

`vibex-mcp` 至少暴露以下工具，schema 需版本化并纳入快照测试：

| Tool | 输入 | 输出 |
|---|---|---|
| `delegate_to_agent` | `agent_type`, `prompt`, `cwd?`, `model?`, `timeout_ms?`, `metadata?` | 立即返回 `task_id`, `delegation_call_id`, `status_url?`；最终结果通过工具结果或状态查询返回 |
| `get_delegation_status` | `task_id` 或 `delegation_call_id` | `queued/running/succeeded/failed/cancelled`, elapsed, summary, error?, child_session_id? |
| `cancel_delegation` | `task_id` 或 `delegation_call_id`, `reason?` | `cancelled: boolean`, `status`, `message` |

所有输出必须是结构化 JSON，供主 Agent 可靠读取；人类可读摘要由前端卡片负责。

## UI Contract

- 主会话消息流：`delegate_to_agent` 调用出现时显示委托卡片，含目标 Agent、prompt
  摘要、状态、耗时、打开子会话、取消按钮。
- 子会话详情：复用 Phase 2 渲染层，不另建简化日志视图。
- 状态轮询工具：`get_delegation_status` 多次调用应聚合为一个状态组，避免消息流被
  重复低价值卡片刷屏。
- 错误态：未安装 Agent、preflight 失败、超时、深度超限、版本不匹配都要显示可操作
  诊断，而不是只显示 raw JSON。

## Edge / Error Cases

- 目标 Agent 未安装/preflight 失败：工具调用返回结构化错误（含诊断），不挂起。
- 子会话超时（可配置，默认 30 分钟）：取消并回传超时错误。
- 伴生二进制版本与主程序不匹配：握手校验版本，警告降级。
- 循环委托（A→B→A）：深度限制兜底 + 链路 id 检测直接拒绝。

## Boundaries

- Always：子会话完整走 Phase 1 的运行时（不另起执行路径——复用）。
- Ask first：无。
- Never：同步阻塞主 Agent 的 prompt 循环等待子任务。

## Success Criteria

- 冒烟：Claude Code 主会话委托 Codex 完成一个文件修改任务，结果回传、UI 全程
  可见；级联取消验证；全门绿 + sidecar 构建脚本纳入 `pnpm run dev`/打包流程。
