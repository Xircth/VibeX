# M4 完整开发计划：委派接线（src-tauri 集成）

> 可独立执行的 M4 执行手册。配套 [spec.md](./spec.md) / [plan.md](./plan.md) / [tasks.md](./tasks.md) / [m4-impl-notes.md](./m4-impl-notes.md)（原始 API 测绘）。
> 状态：M1–M3 + groundwork 已完成并提交；本文件覆盖 M4 全部剩余工作。2026-06-14

---

## 0. 现状

**已提交（worktree `feature/multi-agent-delegation`）**
- `3d5e4077` M1–M3：`crates/{delegation-proto,delegation,vibex-mcp}` + db 委派列 + `AgentEvent::DelegationStarted/Completed` 变体 + shared/types.ts。**60 单测绿、零警告。**
- `bbeb1cf2` M4 groundwork：`AgentRuntime::emit_external()` + 蓝图文档。

**M4 目标**：把全 trait 解耦的 `DelegationBroker` 接到真实 VibeX，跑通**单个委派端到端**：ClaudeCode 调 `delegate_to_agent` → 子 session DB 落行（parent 链正确）→ 结果回父 LLM。

**性质警示**：M4 与 M1–M3 不同，是**紧耦合、全部接好才能 `cargo build -p vibex` 验证**的整体单元。建议一次性按本计划顺序写完再编译，而非中途反复编译。

---

## 1. 执行前提（已厘清，无需再调研）

| 事实 | 出处 |
|------|------|
| 真实会话启动 = `runtime.ensure_session(EnsureAgentSessionInput)` → `runtime.send_prompt(SendAgentPromptInput)` | [agents.rs:480](../../../src-tauri/src/commands/agents.rs#L480) |
| `runtime.connect()` 只建连接 + initialize 握手，**不**驱动 ACP `session/new` | runtime.rs:247 |
| ACP `session/new` 由 [manager.rs `new_acp_session`](../../../crates/agents/src/manager.rs#L945) 在**首个 prompt 时**驱动 → 真实 `acp_session_id` | manager.rs:945 |
| `new_session_with_id(conn, session_id, acp_session_id)` 仅登记 session | runtime.rs:318 |
| ids `AgentConnectionId`/`AgentSessionId`/`AgentPromptId`：`From<Uuid>` + `Display` | ids.rs |
| pool = `state.deployment.db().pool`（`SqlitePool`） | state.rs |
| 启动设置 = `agent_runtime_launch_settings(&state, agent_type) -> AgentRuntimeLaunchSettings { auto_approve_mode: AgentAutoApproveMode, env: HashMap<String,String> }`（**需改 `pub(crate)`**） | agents.rs:347 |
| 事件发射 = `runtime.emit_external(conn_id, Some(session_id), AgentEvent::...)`（已加，复用 sink+broadcast+sequence） | runtime.rs:218 |
| `runtime.subscribe_events() -> broadcast::Receiver<AgentEventEnvelope>` | runtime.rs:215 |
| `runtime.disconnect(AgentConnectionId)`；`runtime.cancel_prompt(CancelAgentPromptInput{conn,session,prompt})` | runtime.rs:596/689 |

**API 字段**
```rust
ConnectAgentInput { agent_type, workspace_id: Uuid, working_dir: PathBuf, auto_approve_mode, env }
EnsureAgentSessionInput { agent_type, workspace_id, working_dir, session_id: AgentSessionId, acp_session_id: String, auto_approve_mode, env }
SendAgentPromptInput { connection_id: AgentConnectionId, session_id: AgentSessionId, blocks: Vec<AgentContentBlock> }
CancelAgentPromptInput { connection_id, session_id, prompt_id: AgentPromptId }
AgentContentBlock::Text { text: String }
```

**delegation crate 已导出**：`DelegationBroker`、`DelegationListener`、`TokenRegistry`/`TokenEntry`、`ConnectionSpawner`/`SpawnerError`、`DepthLookup`、`ChildStatusLookup`/`ChildStatusRecord`、`ParentSessionLookup`、`DelegationMetaWriter`、`DelegationEventEmitter`/`DelegationStartedEvent`/`DelegationCompletedEvent`、`DelegationLink`、`DelegationConfig`、`DelegationOutcome`、`outcome_from_turn`、`default_socket_path`、`TaskStatus`。

---

## 2. 步骤总览（依赖序）

```
A 依赖 + 模块骨架 → B lookups → C emitter → D spawner → E resolver task
→ F broker 构造 + AppState 字段 → G listener/resolver 启动 → H MCP 注入(T4.4)
→ I generate_types + 编译门 + 手验
```
A–G 让 broker 在应用内**活起来**（listener/resolver 跑）；H 让 ClaudeCode 自动拉起 companion（端到端）；I 验证。

---

## 3. 分步详解

### Step A — 依赖 + 模块骨架
- `src-tauri/Cargo.toml`：加 `delegation = { path = "../crates/delegation" }`（agents/db 已是依赖）。
- 新建 `src-tauri/src/delegation/mod.rs`，声明子模块：`lookups`、`emitter`、`spawner`、`resolver`、`wiring`（构造 + 启动）。
- `src-tauri/src/lib.rs`：加 `mod delegation;`。
- `agents.rs`：把 `agent_runtime_launch_settings` 与 `AgentRuntimeLaunchSettings` 改 `pub(crate)`（或迁到可共享处）。
- **验证**：`cargo build -p vibex`（空模块应通过）。

### Step B — lookups 实现（T4.2 之一）
`src-tauri/src/delegation/lookups.rs`，持 `SqlitePool` + `Arc<AgentRuntime>`：
```rust
pub struct DbDepthLookup { pool: SqlitePool }
#[async_trait] impl DepthLookup for DbDepthLookup {
    async fn parent_session_id(&self, id: Uuid) -> Result<Option<Uuid>, DelegationError> {
        match Session::find_by_id(&self.pool, id).await {
            Ok(Some(s)) => Ok(s.parent_session_id),
            Ok(None) => Ok(None),
            Err(e) => Err(DelegationError::SubagentRuntimeError(e.to_string())),
        }
    }
}

pub struct DbChildStatusLookup { pool: SqlitePool }
#[async_trait] impl ChildStatusLookup for DbChildStatusLookup {
    async fn status_by_call_id(&self, call_id: &str) -> Option<ChildStatusRecord> {
        let s = Session::find_by_delegation_call_id(&self.pool, call_id).await.ok()??;
        Some(ChildStatusRecord {
            child_session_id: s.id,
            status: map_session_status(&s.status),       // SessionStatus → TaskStatus
            agent_type: s.agent_type.as_deref().and_then(agent_type_from_executor_key),
        })
    }
}

// 父连接的当前 session：从 runtime snapshot 找该连接最近的 session（= 我们设的 AgentSessionId = sessions.id）
pub struct RuntimeParentLookup { runtime: Arc<AgentRuntime> }
#[async_trait] impl ParentSessionLookup for RuntimeParentLookup {
    async fn current_session_id(&self, parent_conn: &str) -> Option<Uuid> {
        let conn_id = AgentConnectionId::from(Uuid::parse_str(parent_conn).ok()?);
        let snap = self.runtime.snapshot().await;
        snap.sessions.iter()
            .filter(|s| s.connection_id == conn_id)
            .max_by_key(|s| s.updated_at)          // 最近活跃
            .map(|s| s.id.into())                  // AgentSessionId → Uuid
    }
}
```
- `map_session_status`：`SessionStatus::{Done→Completed, Archived→Canceled, InReview/InProgress/Todo→Running}`（按语义定，确认 SessionStatus 变体）。
- **注意**：`AgentSessionId.into() -> Uuid` 需确认 newtype 暴露 `.0` 或 `From`。
- **验证**：`cargo build -p vibex`。

### Step C — emitter + meta 实现（T4.2 之一）
`src-tauri/src/delegation/emitter.rs`，持 `Arc<AgentRuntime>`：
```rust
pub struct RuntimeEventEmitter { runtime: Arc<AgentRuntime> }
#[async_trait] impl DelegationEventEmitter for RuntimeEventEmitter {
    async fn emit_started(&self, e: DelegationStartedEvent) {
        let Some(conn) = parse_conn(&e.parent_connection_id) else { return };
        self.runtime.emit_external(conn, None, AgentEvent::DelegationStarted {
            parent_tool_use_id: e.parent_tool_use_id,
            child_session_id: e.child_session_id,
            agent_type: e.agent_type,
            task_preview: e.task_preview,
        }).await;
    }
    async fn emit_completed(&self, e: DelegationCompletedEvent) {
        let Some(conn) = parse_conn(&e.parent_connection_id) else { return };
        let result = summarize(&e.outcome);   // DelegationOutcome → DelegationResultSummary
        self.runtime.emit_external(conn, None, AgentEvent::DelegationCompleted {
            parent_tool_use_id: e.parent_tool_use_id,
            child_session_id: e.child_session_id,
            agent_type: e.agent_type,
            result,
        }).await;
    }
}
```
- `summarize`：`Ok(s) → DelegationResultSummary::Ok { duration_ms: Some(s.duration_ms), text_preview: preview(&s.text) }`；`Err{code,..} → Err { error_code: code }`。
- **MetaWriter（v1 决定）**：先 no-op + TODO（`DelegationStarted/Completed` 事件已够前端渲染卡片；meta 用于刷新重建留到 M7）：
  ```rust
  pub struct NoopMetaWriter;
  #[async_trait] impl DelegationMetaWriter for NoopMetaWriter {
      async fn write_meta(&self, _: &str, _: &str, _: serde_json::Value) {}
  }
  ```
- **验证**：`cargo build -p vibex`。

### Step D — ConnectionSpawner 实现（T4.1）
`src-tauri/src/delegation/spawner.rs`，持 `Arc<AgentRuntime>` + `SqlitePool` + 共享映射 `Arc<Mutex<HashMap<Uuid,(String,AgentType)>>>`（child_session→(call_id, agent_type)，供 resolver）：
```rust
#[async_trait] impl ConnectionSpawner for RuntimeSpawner {
    async fn spawn(&self, parent_conn: &str, agent_type: AgentType, working_dir: Option<String>) -> Result<String, SpawnerError> {
        let parent = AgentConnectionId::from(Uuid::parse_str(parent_conn).map_err(|e| SpawnerError::Spawn(e.to_string()))?);
        let snap = self.runtime.snapshot().await;
        let pc = snap.connections.iter().find(|c| c.id == parent)
            .ok_or_else(|| SpawnerError::Spawn("parent connection not found".into()))?;
        let wd = working_dir.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(&pc.working_dir));
        let ls = launch_settings(agent_type);   // auto_approve + env（复用 helper）
        let child = self.runtime.connect(ConnectAgentInput {
            agent_type, workspace_id: pc.workspace_id, working_dir: wd,
            auto_approve_mode: ls.auto_approve_mode, env: ls.env,
        }).await.map_err(|e| SpawnerError::Spawn(e.to_string()))?;
        Ok(child.id.to_string())
    }

    async fn send_prompt_linked(&self, child_conn: &str, task: String, link: DelegationLink) -> Result<Uuid, SpawnerError> {
        let conn = AgentConnectionId::from(Uuid::parse_str(child_conn).map_err(|e| SpawnerError::Other(e.to_string()))?);
        // 父 session 取 workspace_id + agent_type 上下文
        let parent = Session::find_by_id(&self.pool, link.parent_session_id).await
            .map_err(|e| SpawnerError::Other(e.to_string()))?
            .ok_or(SpawnerError::ParentGone)?;
        let child_id = Uuid::new_v4();
        Session::create_with_delegation(&self.pool, &CreateSession {
            executor: None, task_id: parent.task_id, name: None,
            initial_prompt: Some(task.clone()), status: Some(SessionStatus::InProgress),
        }, child_id, parent.workspace_id, link.parent_session_id, &link.parent_tool_use_id, &link.delegation_call_id)
            .await.map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;

        let session_id = AgentSessionId::from(child_id);
        self.runtime.new_session_with_id(conn, session_id, child_id.to_string()).await
            .map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;
        // 注册映射（agent_type 来自调用方上下文——见下注）
        self.map.lock().await.insert(child_id, (link.delegation_call_id.clone(), /*agent_type*/));
        self.runtime.send_prompt(SendAgentPromptInput {
            connection_id: conn, session_id,
            blocks: vec![AgentContentBlock::Text { text: task }],
        }).await.map_err(|e| SpawnerError::SendPrompt(e.to_string()))?;
        // agent_type 落 DB（external_session_id 由 SessionCreated 快照流程补，或此处补）
        Ok(child_id)
    }

    async fn cancel(&self, child_conn: &str) -> Result<(), SpawnerError> {
        let conn = AgentConnectionId::from(Uuid::parse_str(child_conn).map_err(|e| SpawnerError::Other(e.to_string()))?);
        let snap = self.runtime.snapshot().await;
        if let Some(s) = snap.sessions.iter().find(|s| s.connection_id == conn) {
            if let Some(pid) = s.active_prompt_id {
                let _ = self.runtime.cancel_prompt(CancelAgentPromptInput { connection_id: conn, session_id: s.id, prompt_id: pid }).await;
            }
        }
        Ok(())
    }

    async fn disconnect(&self, child_conn: &str) -> Result<(), SpawnerError> {
        let conn = AgentConnectionId::from(Uuid::parse_str(child_conn).map_err(|e| SpawnerError::Other(e.to_string()))?);
        let _ = self.runtime.disconnect(conn).await;
        Ok(())
    }
}
```
**注**：`agent_type` 在 `send_prompt_linked` 里拿不到（trait 没传）。两个选择：(a) 给 `DelegationLink` 加 `agent_type` 字段（小改 delegation crate）；(b) resolver 从 DB session.agent_type 反查。**推荐 (a)**：broker 构造 link 时已知 agent_type，最干净。需同步改 broker `send_prompt_linked` 调用处把 agent_type 放进 link。

### Step E — Resolver task（结果文本 + complete_call，解 Arc 环）
`src-tauri/src/delegation/resolver.rs`：独立后台 task，持 `Arc<DelegationBroker>` + `Arc<AgentRuntime>` + 共享映射：
```rust
pub fn spawn_resolver(broker: Arc<DelegationBroker>, runtime: Arc<AgentRuntime>,
                      map: Arc<Mutex<HashMap<Uuid,(String,AgentType)>>>) {
    let mut rx = runtime.subscribe_events();
    let mut text: HashMap<Uuid, String> = HashMap::new();   // per child_session 累加
    tauri::async_runtime::spawn(async move {
        while let Ok(env) = rx.recv().await {
            let Some(sid) = env.session_id.map(Uuid::from) else { continue };
            match env.event {
                AgentEvent::MessageChunk { content: AgentContentBlock::Text { text: t } } => {
                    if map.lock().await.contains_key(&sid) { text.entry(sid).or_default().push_str(&t); }
                }
                AgentEvent::PromptFinished { finished } => {
                    let entry = { map.lock().await.remove(&sid) };
                    if let Some((call_id, agent_type)) = entry {
                        let body = text.remove(&sid).unwrap_or_default();
                        let outcome = outcome_from_turn(finished.stop_reason.as_deref(), body, sid, agent_type, 1, 0);
                        broker.complete_call(&call_id, outcome).await;
                    }
                }
                _ => {}
            }
        }
    });
}
```
**无环**：resolver→broker→spawner→map；resolver 也持 map/runtime，但 broker 不持 resolver。

### Step F — broker 构造 + AppState 字段（T4.5 之一）
- `src-tauri/src/delegation/wiring.rs`：`build_delegation(runtime, pool) -> (Arc<DelegationBroker>, Arc<TokenRegistry>, PathBuf, Arc<Mutex<Map>>)`：
  ```rust
  let map = Arc::new(Mutex::new(HashMap::new()));
  let spawner = Arc::new(RuntimeSpawner { runtime: runtime.clone(), pool: pool.clone(), map: map.clone() });
  let broker = Arc::new(DelegationBroker::new(
      spawner,
      Arc::new(DbDepthLookup { pool: pool.clone() }),
      Arc::new(DbChildStatusLookup { pool: pool.clone() }),
      Arc::new(NoopMetaWriter),
      Arc::new(RuntimeEventEmitter { runtime: runtime.clone() }),
      DelegationConfig::default(),
  ));
  let tokens = Arc::new(TokenRegistry::new());
  let socket = default_socket_path(&std::env::temp_dir());
  (broker, tokens, socket, map)
  ```
- `src-tauri/src/state.rs` `AppState`：加 `delegation_broker: Arc<DelegationBroker>`、`delegation_tokens: Arc<TokenRegistry>`、`delegation_socket_path: PathBuf`。在 `AppState::new()` 调 `build_delegation`，spawn resolver（Step E），存字段。
- **验证**：`cargo build -p vibex`。

### Step G — listener + resolver 启动（T4.5 之一）
- 在 `AppState::new()` 或 `lib.rs` setup：
  ```rust
  let listener = Arc::new(DelegationListener::new(broker.clone(), tokens.clone(), Arc::new(RuntimeParentLookup{runtime: runtime.clone()})));
  let sock = socket.clone();
  tauri::async_runtime::spawn(async move { let _ = listener.run(sock).await; });
  ```
- resolver 已在 Step F spawn。
- **验证**：`cargo build -p vibex` + `pnpm tauri dev` 启动正常（listener 绑定、无 panic）。此时 broker 已活，可用手工 socket 帧测试（不经 agent）。

### Step H — MCP 注入（T4.4，端到端的最后一环）
让 ClaudeCode 启动时自动拉起 companion。在 [manager.rs `new_acp_session`](../../../crates/agents/src/manager.rs#L945) 的 `NewSessionRequest::new(cwd)` 上追加 companion：
1. `ConnectionManager` 安装一个 `DelegationInjection { tokens: Arc<TokenRegistry>, socket_path: PathBuf, enabled: bool }`（`OnceLock`/字段），由 `AppState::new` 注入。
2. `new_acp_session`：若**父 agent_type == ClaudeCode** 且 injection 存在且 enabled：
   ```rust
   let token = uuid::Uuid::new_v4().to_string();
   injection.tokens.register(token.clone(), TokenEntry { parent_connection_id: <conn>.to_string(), working_dir: working_dir.into() });
   let bin = locate_vibex_mcp_binary();  // env VIBEX_MCP_BIN → exe 同级 → PATH
   let companion = McpServerStdio::new("vibex-mcp", bin).args([
       "--parent-connection-id", <conn>, "--socket-path", socket, "--token", &token, "--features", "delegation",
   ]);
   req = req.mcp_servers(vec![McpServer::Stdio(companion)]);
   ```
   非 ClaudeCode：保持 `NewSessionRequest::new(cwd)` 原样。
3. **v1 仅 `--features delegation`**（steering 占位避免被命中，M6 再开）。
4. 连接 teardown 时 `tokens.revoke_by_parent(conn)`（可后续补）。
- **难点**：manager/runner 需访问 injection + 知道父 connection_id（runner 有 `snapshot.connection_id`）+ companion bin 定位。`locate_vibex_mcp_binary` 三级查找。
- **验证**：`pnpm tauri dev`，ClaudeCode 会话观察 companion 进程被拉起、回连 listener。

### Step I — 类型生成 + 编译门 + 手验
- `node scripts/run-generate-types.js`：同步 `AgentEvent::DelegationStarted/Completed` + `DelegationResultSummary` 到 `shared/types.ts`。
- **前端 reducer**：`frontend/src/features/agents/store.ts` 的 `reduceAgentEvent` 若是穷尽匹配，加 `delegation_started`/`delegation_completed` 两个 case（最小：忽略或存事件；完整 UI 在 M7）。否则前端 `tsc`/build 可能报未处理。
- **核心门**：`cargo build -p vibex` → `cargo test --workspace` → `pnpm tauri dev` 手验：ClaudeCode `delegate_to_agent(agent_type, task)` → 子 session DB 落行（`parent_session_id` 指向父、`delegation_call_id` 已写）→ broker 解析 `PromptFinished` → 结果回父 LLM。

---

## 4. 风险与缓解

| 风险 | 缓解 |
|------|------|
| manager 注入的穿透式管线最复杂 | 经 `ConnectionManager` 安装 `DelegationInjection`；先把 A–G 接通（broker 活），H 单独攻坚 |
| Arc 环（broker↔spawner） | resolver 独立 task 持 broker，spawner 不持 broker（Step E 设计） |
| `agent_type` 未经 trait 传到 spawner | 给 `DelegationLink` 加 `agent_type` 字段（小改 delegation crate + broker 构造处） |
| `AgentSessionId/ConnectionId ↔ Uuid` 转换 | 确认 `From<Uuid>` + `.0`/`Into<Uuid>`；ids.rs |
| `SessionStatus → TaskStatus` 映射 | 确认 SessionStatus 变体语义后实现 `map_session_status` |
| 前端 reducer 穷尽匹配破坏 build | Step I 加两个 case（最小处理） |
| `agent_type` 落 DB 的字符串格式 | 与 VibeX 既有 `persist_session_snapshot`/`registry_id_for` 对齐；用 `agent_type_from_executor_key` 反查保持一致 |
| auto_approve/env 继承 | 复用 `agent_runtime_launch_settings`（按 agent_type 取，非父连接），与正常启动一致 |
| companion bin 未打包（dev） | `VIBEX_MCP_BIN` env 覆盖；M8 做 sidecar `externalBin` |

---

## 5. 验证门（M4 完成判据）
1. `cargo build -p vibex` 通过（整树编译）。
2. `cargo test --workspace` 绿。
3. `node scripts/run-generate-types.js` 无差异（CI `generate-types:check` 绿）。
4. `pnpm tauri dev`：单个委派端到端 + DB 父子链正确（spec §9-1/2/6 的核心子集）。

---

## 6. M4 之后（预告）
- **M5** 异步全量：status/cancel 端到端 + **完整 tool_use_id 关联**（接真实 ClaudeCode 验证 `_meta.tool_use_id` 流向后，补 ToolCallTracker；替换合成 id 兜底）+ stop_reason 在生产者侧 match `StopReason` 枚举（替换 Debug 字符串解析）。
- **M6** steering：broker feedback 队列 + ask 阻塞；注入加 `--features feedback,ask`；前端作答/插话 UI。
- **M7** 前端：delegation context + 内联卡片 + 打开子会话 + meta 多级回落（届时 MetaWriter 从 no-op 升级）。
- **M8** 抛光：sidecar 打包、委派配置命令、效率微优化（config clone / finalize clone / status 唤醒惊群，见审查遗留）、端到端验收清单。
