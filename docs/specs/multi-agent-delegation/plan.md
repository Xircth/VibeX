# Plan: 多智能体协同 / 委派 —— 技术实施计划（Phase 2）

> 配套 [spec.md](./spec.md)。本计划先固化 spec §11 的待决项 Q1/Q2/Q5，再给出组件依赖、实施顺序、风险与验证检查点。
> 状态：**Phase 2 - Plan（待评审）** ｜ 2026-06-14

## A. 待决项核实结论（spec §11）

### A1（=Q1）Crate 边界：**3 个新 crate + src-tauri 接线**
workspace 已有 `crates/utils`/`crates/api-types` 等小而专的 crate（[Cargo.toml](../../../Cargo.toml)），新增 3 个合乎惯例。依赖 DAG（无环）：

```
crates/delegation-proto   ← 线丝类型（无业务依赖）
   ▲           ▲
   │           │
crates/        crates/vibex-mcp   ← companion 二进制（依赖最小：proto + tokio + serde_json + IPC）
delegation                         （绝不依赖 agents/db）
   ▲  （broker + listener + traits + types + depth；依赖 proto + agents[仅 AgentType]）
   │
src-tauri/src/delegation/  ← trait 具体实现（over AgentRuntime/db/Tauri）+ 注入 + 命令 + listener 启动
```

| crate | 职责 | 关键依赖 | 不依赖 |
|------|------|---------|--------|
| `crates/delegation-proto` | `BrokerMessage`/`BrokerRequest`/`BrokerResponse`、帧编解码、`DelegationTaskReport`、`TaskStatus`；线丝 `agent_type` 用 `String` | serde, serde_json | 一切业务 crate |
| `crates/delegation` | `DelegationBroker`、`listener`、5 个 trait（`ConnectionSpawner`/`DepthLookup`/`ChildStatusLookup`/`MetaWriter`/`EventEmitter`）、`DelegationRequest/Outcome/Error`、`depth` | delegation-proto, agents(仅 `AgentType`), tokio, uuid, thiserror, async-trait | db, tauri, src-tauri |
| `crates/vibex-mcp` | companion stdio MCP server（`[[bin]]`）+ transport client | delegation-proto, tokio, serde_json, IPC(命名管道/UDS) | delegation, agents, db |

> 理由：broker 纯逻辑、全 trait 解耦 → `cargo test -p delegation` 可脱离真实连接/DB 跑（沿用 codeg 测试套路）。companion 依赖最小 → sidecar 体积小、启动快、不被业务 crate 牵连。

### A2（=Q2）stop_reason 映射：**容错归一化**
- 来源：真实 turn = `format!("{:?}", acp::StopReason)`（PascalCase：`EndTurn`/`MaxTokens`/`MaxTurnRequests`/`Refusal`/`Cancelled`）；另有硬编码 `"end_turn"`/`"cancelled"`（[manager.rs](../../../crates/agents/src/manager.rs) 多处）。
- broker 映射器：`normalize(s) = s.to_lowercase().replace('_', "")`，再匹配：
  | 归一化 | → 结果 |
  |--------|--------|
  | `endturn` + 有文本 | `DelegationSuccess` |
  | `endturn` + 无文本 | `DelegationError::ChildEmpty` |
  | `maxtokens` | `ChildMaxTokens` |
  | `maxturnrequests` | `ChildMaxTurnRequests` |
  | `refusal` | `ChildRefusal` |
  | `cancelled`/`canceled` | `Canceled` |
  | 其它 | `ChildUnknown(s)` |
- 完成信号：spawner 监听 `AgentEvent::PromptFinished{ finished.prompt_id == 本次委派的 prompt }`（非全局 `TurnCompleted`），避免误判其它 prompt。
- **实现期需 pin**：ACP 0.11.1 `StopReason` 是宏生成的，实际变体集合在写 `spawner_impl` 时用 `cargo doc -p agent-client-protocol` 或断点核对一次，补全映射表。（不构成架构风险。）

### A3（=Q5）委派事件：**新增 `AgentEvent` 变体**
在 [events.rs](../../../crates/agents/src/events.rs) `AgentEvent` 加两个变体（沿用 `kind`+snake_case + `#[ts(export)]`）：
```rust
DelegationStarted  { parent_tool_use_id: String, child_connection_id: AgentConnectionId,
                     child_session_id: AgentSessionId, agent_type: AgentType, task_preview: String },
DelegationCompleted{ parent_tool_use_id: String, child_session_id: AgentSessionId,
                     agent_type: AgentType, result: DelegationResultSummary }, // Ok{duration_ms,text_preview?} | Err{code}
```
前端 [store.ts](../../../frontend/src/features/agents/store.ts) `reduceAgentEvent` 加两个 case；类型经 ts-rs 自动导出到前端 bindings。委派 context 订阅这两个事件维护 binding map。

---

## B. 组件清单（落地物）

**新增**
- crates：`delegation-proto`、`delegation`、`vibex-mcp`（含 `tool_schema.json`，移植 codeg 5 工具）。
- DB 迁移：`crates/db/migrations/<ts>_delegation_columns.sql`（sessions 加 `parent_session_id`/`parent_tool_use_id`/`delegation_call_id` + 索引）+ `session.rs` 模型/查询。
- src-tauri：`src/delegation/{mod,spawner_impl,lookups,meta_emitter_impl,injection,commands}.rs`。
- 前端：`frontend/src/features/delegation/`（context + 卡片 `DelegateToAgentToolCard` + 状态解析 + steering 作答/插话 UI）。

**改动**
- `crates/agents/src/manager.rs::new_acp_session`：仅当父 = ClaudeCode 且功能开启时，向 `session/new` 的 `mcp_servers` 追加 companion（spec §4.3）。
- `crates/agents/src/events.rs`：加 2 个 `AgentEvent` 变体（A3）。
- `Cargo.toml`（workspace members）、`src-tauri/Cargo.toml`（依赖 delegation）、`src-tauri/tauri.conf.json`（`externalBin` sidecar）。
- `src-tauri/src/state.rs` / `lib.rs`：构造并持有 broker + TokenRegistry + socket 路径，启动 listener。
- `frontend/src/components/NormalizedConversation/tools/ToolCallCard.tsx`：按 tool_name 分发委派卡片。
- `shared/types.ts` / 前端 bindings：`generate_types` 重新生成。

---

## C. 实施顺序（里程碑）

> 原则：先纵向打通**一个最小端到端**（M4 收口），再横向补全异步/steering/前端深度。串行依赖用 →，可并行用 ∥。

- **M1 地基（DB）**：迁移 + `session.rs` 字段/`create_with_delegation`/`find_by_delegation_call_id`。
  - 验证：`cargo test -p db`；迁移可前向应用。
- **M2 proto + broker 纯逻辑** ∥ **M3 companion**（二者经 proto 解耦，可并行）
  - M2：`delegation-proto` 线丝类型 + `delegation` 的 types/depth/broker/listener + 5 trait + 单测（mock spawner/lookup，覆盖：注册/完成/取消、缓存驱逐、深度、并行关联键、setup 竞态、stop_reason 映射）。
    - 验证：`cargo test -p delegation` 全绿。
  - M3：`vibex-mcp` stdio MCP server（initialize/tools.list/tools.call/notifications.cancelled）+ transport client + `tool_schema.json`。
    - 验证：单测 transport round-trip；手动 `echo '{...}' | vibex-mcp ...` 冒烟。
- **M4 接线（最小端到端：同步直通先跑通）** ← M1,M2,M3
  - `spawner_impl`（over AgentRuntime，监听 PromptFinished）、`lookups`（over db）、`meta_emitter_impl`、`injection`（session/new 注入 companion + token 注册/吊销）、listener 启动、state 持有 broker。
  - 验证（**关键检查点**）：ClaudeCode 真实派发 1 个子 agent → DB 落子 session（parent 链正确）→ `delegate_to_agent` 返回 → broker 解析 PromptFinished → 结果回 companion → tool_result 回父 LLM。`pnpm tauri dev` 手验。
- **M5 异步全量** ← M4
  - task 注册表 + `get_delegation_status`(wait_ms/批量) + `cancel_delegation` + 并行 fan-out 关联 + 结果缓存/驱逐 + DB 回落 + 竞态裁决全开。
  - 验证：并行 2+ 委派不串卡；取消生效；驱逐后状态回落。
- **M6 steering** ∥ **M7 前端**（M4 后可并行）
  - M6：broker 端 feedback 队列 + ask 阻塞；companion 的 feedback「先回包后 commit」；`--features` 门控。
  - M7：delegation context + `DelegateToAgentToolCard`（图标+任务+状态徽章+打开子会话）+ 状态多级回落；steering 作答/插话输入 UI；`generate_types`。
  - 验证：前端委派相关单测；刷新后卡片从 meta 重建；端到端手验 §9 全部成功标准。
- **M8 收尾**：sidecar 多平台打包、`VIBEX_MCP_BIN` dev 覆盖、深度上限配置命令、文档与端到端清单。

依赖关系：`M1 → (M2 ∥ M3) → M4 → M5 → (M6 ∥ M7) → M8`。

---

## D. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| ACP `StopReason` 实际变体与假设不符 | 映射错误 → 委派结果误判 | M2 先写容错归一化 + `ChildUnknown` 兜底；M4 写 spawner 时 pin 一次实际变体 |
| companion 与父进程生命周期 | 父崩溃留孤儿 companion | 移植 codeg `--parent-pid` 看门狗 + stdin EOF 退出 |
| Windows 命名管道并发/重绑 | 连接间隙 `NotFound` | 移植 codeg「服务前先重绑下个实例」+ 客户端 200ms 重试 |
| 并行关联键串卡 | 多委派 UI 错位 | 移植 `DelegationMatchKey(agent_type,task,working_dir)` + 单测覆盖 |
| 子 agent 长时间运行阻塞父 turn | 异步语义下父需轮询 | 工具 schema 已明确异步语义；`get_delegation_status` wait_ms 封顶 60s |
| `session/new` 注入对非 ClaudeCode adapter 行为未知 | 越界报错 | v1 严格仅 ClaudeCode 注入；其它 agent 跳过 |
| ts-rs bindings 生成链 | 类型不同步前端 | M1 起每次改 Rust 类型即跑 `generate_types`，纳入验证步骤 |

---

## E. 验证检查点（阶段门）

1. **M1 后**：`cargo test -p db` 绿；迁移幂等可应用。
2. **M2 后**：`cargo test -p delegation` 绿（broker 全场景 mock 覆盖）。
3. **M3 后**：companion transport round-trip 单测 + CLI 冒烟。
4. **M4 后（核心门）**：单个委派端到端跑通 + DB 父子链正确 + `cargo test --workspace` 绿。
5. **M5 后**：并行 fan-out / 取消 / 状态回落手验通过。
6. **M7 后**：前端单测绿 + §9 成功标准 1–9 全部手验通过。

---

## F. 下一步

Plan 评审通过 → **Phase 3（Tasks）**：把 M1–M8 拆成 ≤5 文件/任务、带验收标准与验证步骤的离散任务清单，按依赖排序。
