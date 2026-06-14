# M4 实现蓝图（编排链已厘清）

> 配套 spec/plan/tasks。本文件固化 M4 接线所需的真实 API 与解耦设计，便于跨会话续作。
> 2026-06-14

## 真实会话启动编排（已追踪）

- 用户发首条消息 → [`agent_send_workspace_prompt`](../../../src-tauri/src/commands/agents.rs#L480) → `runtime.ensure_session(EnsureAgentSessionInput)` → `runtime.send_prompt(SendAgentPromptInput)`。
- `runtime.connect()` **不**驱动 ACP `session/new`；它只建连接 + 跑 runner + 完成 `initialize` 握手后返回 Ready。
- ACP `session/new` 由 [manager.rs `new_acp_session`](../../../crates/agents/src/manager.rs#L945) 在**首个 prompt 到达时**按需驱动，生成真实 `acp_session_id`，并写入 `session_map: HashMap<AgentSessionId, String>`。
- `runtime.new_session_with_id(conn_id, session_id, acp_session_id)` 只是**登记**一个 session（acp_session_id 作外部引用）。
- DB `sessions` 行由 [sessions.rs](../../../src-tauri/src/commands/sessions.rs) `Session::create` 建；事件 `SessionCreated` 经 sink 持久化快照。

## 关键 API（runtime.rs）

- `ConnectAgentInput { agent_type, workspace_id: Uuid, working_dir: PathBuf, auto_approve_mode: AgentAutoApproveMode, env: HashMap<String,String> }`
- `EnsureAgentSessionInput { agent_type, workspace_id, working_dir, session_id: AgentSessionId, acp_session_id: String, auto_approve_mode, env }`
- `SendAgentPromptInput { connection_id: AgentConnectionId, session_id: AgentSessionId, blocks: Vec<AgentContentBlock> }`
- `CancelAgentPromptInput { connection_id, session_id, prompt_id: AgentPromptId }`
- `subscribe_events() -> broadcast::Receiver<AgentEventEnvelope>`
- `disconnect(connection_id) -> AgentConnectionSnapshot`
- `connect(input) -> AgentConnectionSnapshot`（`.id: AgentConnectionId`）
- ids（`AgentConnectionId`/`AgentSessionId`/`AgentPromptId`）均 `From<Uuid>` + `Display`。
- `AppState`：`agent_runtime: Arc<AgentRuntime>`；pool = `state.deployment.db().pool`。
- 启动设置：`agent_runtime_launch_settings(&state, agent_type) -> AgentRuntimeLaunchSettings { auto_approve_mode, env }`（agents.rs:347，需 `pub(crate)` 或复刻）。

## ConnectionSpawner 解耦映射

- `spawn(parent_conn, agent_type, working_dir)`：
  1. 解析 parent_conn → `AgentConnectionId`；从 `runtime.snapshot()` 找父连接取 `workspace_id`/`working_dir`。
  2. `agent_runtime_launch_settings(agent_type)` 取 auto_approve/env。
  3. `runtime.connect(ConnectAgentInput{...})` → 返回 child `AgentConnectionId`（`.to_string()` 作 child_connection_id）。
- `send_prompt_linked(child_conn, task, link)`：
  1. `child_db_session_id = Uuid::new_v4()`；查父 session 取 workspace_id；`Session::create_with_delegation(pool, &CreateSession{ initial_prompt: Some(task), status: InProgress, .. }, child_db_session_id, workspace_id, link.parent_session_id, &link.parent_tool_use_id, &link.delegation_call_id)`。
  2. `runtime.new_session_with_id(child_conn, AgentSessionId::from(child_db_session_id), child_db_session_id.to_string())`。
  3. **注册** `child_session_id → call_id` 进共享 `Arc<Mutex<HashMap<Uuid,String>>>`（供 resolver 用）。
  4. `runtime.send_prompt(SendAgentPromptInput{ child_conn, AgentSessionId::from(child_db_session_id), vec![AgentContentBlock::Text{ text: task }] })`。
  5. 返回 `child_db_session_id`。
- `cancel(child_conn)`：`runtime.snapshot()` 找该连接的 active session + active_prompt_id → `cancel_prompt(...)`。
- `disconnect(child_conn)`：`runtime.disconnect(AgentConnectionId)`。

## 结果文本 + complete_call：独立 Resolver task（解 Arc 环）

broker 持有 spawner → spawner 不能持有 broker（环）。改由**独立后台 task**（app 启动时 spawn）：
- 持有 `Arc<DelegationBroker>` + `Arc<AgentRuntime>` + 共享 `Arc<Mutex<HashMap<Uuid,String>>>`（child_session→call_id）+ per-session 文本累加器。
- `subscribe_events()` 循环：
  - `MessageChunk{Text}` 且 envelope.session_id 在映射中 → 累加文本。
  - `PromptFinished{stop_reason}` 且 session 在映射中 → `outcome = delegation::outcome_from_turn(stop_reason, accumulated_text, child_session_id, agent_type, 1, duration)` → `broker.complete_call(&call_id, outcome)` → 清理映射 + 累加器。
- 无环：resolver→broker→spawner→map；resolver 也持 map/runtime，但 broker 不持 resolver。

## 事件 emitter：给 AgentRuntime 加 `emit_external`

broadcast Sender 不公开。**加公共方法**（最干净，复用既有 sequence/sink/broadcast）：
```rust
// runtime.rs
pub async fn emit_external(&self, connection_id: AgentConnectionId, session_id: Option<AgentSessionId>, event: AgentEvent) {
    let mut state = self.state.write().await;
    Self::emit_with_parts_locked(&mut state, self.event_sink.as_ref(), &self.event_tx, connection_id, session_id, event);
}
```
delegation 的 `DelegationEventEmitter` 实现持 `Arc<AgentRuntime>`，把 `DelegationStartedEvent/CompletedEvent` 映射成 `AgentEvent::DelegationStarted/Completed`，对 **parent 连接** emit。需要 parent_connection_id → AgentConnectionId（emitter 收到的 event 带 parent_connection_id 字符串）。

## lookups 实现（over DB pool）

- `DepthLookup.parent_session_id(uuid)`：`Session::find_by_id(pool, uuid)?.parent_session_id`。
- `ChildStatusLookup.status_by_call_id(call_id)`：`Session::find_by_delegation_call_id(pool, call_id)` → 映射 session.status → TaskStatus + child_session_id + agent_type。
- `ParentSessionLookup.current_session_id(parent_conn)`：父连接的当前 session id。从 `runtime.snapshot()` 找该连接最近活跃 session 的 id（= 我们设的 AgentSessionId = sessions.id）。

## MetaWriter 实现（T4.4 之外）

`DelegationMetaWriter.write_meta(parent_conn, parent_tool_use_id, meta)`：经 `emit_external` 发一个 `AgentEvent::ToolCallUpdate`（带 meta）到 parent 连接，或落库到父 tool_call。v1 最小：可先 no-op + 日志（meta 主要用于刷新重建，M7 再精修），或发 ToolCallUpdate。**决定**：v1 走 `DelegationStarted/Completed` 事件已够前端渲染，meta_writer 先 no-op（带 TODO），M7 视需要补。

## MCP 注入（T4.4）

[manager.rs `new_acp_session`](../../../crates/agents/src/manager.rs#L945) 的 `NewSessionRequest::new(cwd)` 改为：父 agent==ClaudeCode 且功能开启时，追加 `McpServerStdio("vibex-mcp", bin).args([--parent-connection-id, --socket-path, --token, --features delegation])` 到 `.mcp_servers(...)`。token 在此 mint + 注册 TokenRegistry。需要 manager 能访问注入上下文（broker/tokens/socket_path/companion bin 定位）——经 ConnectionManager 安装一个 `DelegationInjection`（OnceLock）。**v1 仅 `--features delegation`**（steering 占位避免被命中，M6 再开 feedback,ask）。

## 接线（T4.5）

- src-tauri/Cargo.toml 加 `delegation = { path = "../crates/delegation" }`。
- AppState 加 `delegation_broker: Arc<DelegationBroker>` + `delegation_tokens: Arc<TokenRegistry>` + `delegation_socket_path: PathBuf`。
- state.rs `new()`：构造 broker（trait impls over runtime/pool/emitter）+ tokens + socket_path；spawn resolver task；spawn listener（`listener.run(socket_path)`）。
- lib.rs setup：已有 `start_agent_event_forwarding`；加委派 listener/resolver 启动（或在 state.rs::new 内 spawn）。
- 连接 teardown 时 `tokens.revoke_by_parent`（可后续补）。

## 验证（核心门 T4.5）

`cargo build -p vibex` 通过 → `cargo test --workspace` → `pnpm tauri dev` 手验：ClaudeCode `delegate_to_agent` → 子 session DB 落行（parent 链对）→ 结果回父 LLM。
