# Tasks: 多智能体协同 / 委派（Phase 3）

> 配套 [spec.md](./spec.md) / [plan.md](./plan.md)。每个任务 ≤5 文件、可单会话完成、带验收(Acceptance)与验证(Verify)。
> 顺序即依赖序：`M1 → (M2 ∥ M3) → M4 → M5 → (M6 ∥ M7) → M8`。
> 状态：**Phase 4 - Implement 进行中** ｜ ✅ M1（DB）+ ✅ M2（broker/listener）+ ✅ M3（companion）｜ **58 测试绿**（db 13 + delegation 32 + proto 3 + vibex-mcp 10）｜ 下一步 M4（接线，核心集成门）｜ 2026-06-14
>
> 注：T2.6 已按认可的范围拆分 —— 实现了 setup 窗口竞态防护 + 合成 id 兜底；完整 tool_use_id 关联推迟到 M5（接真实 ClaudeCode 会话后验证）。

---

## M1 地基（DB）

- [ ] **T1.1 委派列迁移**
  - Acceptance：新增 `crates/db/migrations/20260614000000_delegation_columns.sql`，给 `sessions` 加 `parent_session_id BLOB` / `parent_tool_use_id TEXT` / `delegation_call_id TEXT`，并建 `idx_sessions_parent_session_id`、`idx_sessions_delegation_call_id`（均 `WHERE … IS NOT NULL` 部分索引）。
  - Verify：`cargo test -p db`（迁移在测试 harness 应用）；既有数据前向兼容。
  - Files：1（新 SQL）。

- [ ] **T1.2 session 模型与查询**
  - Acceptance：`Session` 结构加 3 字段；新增 `create_with_delegation(parent_session_id, parent_tool_use_id, delegation_call_id, …)` 与 `find_by_delegation_call_id()`；SELECT 列清单同步。
  - Verify：`cargo test -p db` 新增单测（插入子 session→按 call_id 查回，parent 链正确）。
  - Files：`crates/db/src/models/session.rs`（+ 必要的列常量）。

---

## M2 proto + broker 纯逻辑（可与 M3 并行）

- [ ] **T2.1 `delegation-proto` crate（线丝类型 + 帧编解码）**
  - Acceptance：新 crate；`BrokerMessage`(Call/Status/CancelTask/Cancel/Feedback/CommitFeedback/Ask)、`BrokerRequest/Response`、`DelegationTaskReport`、`TaskStatus`；`write_frame/read_frame`（u32 LE 长度前缀，16MiB 上限）。`agent_type` 线丝用 `String`。
  - Verify：`cargo test -p delegation-proto`（帧 round-trip；枚举 snake_case 稳定）。
  - Files：root `Cargo.toml`(member)、`crates/delegation-proto/{Cargo.toml,src/lib.rs,src/transport.rs,src/report.rs}`。

- [ ] **T2.2 `delegation` crate 骨架 + types + depth**
  - Acceptance：新 crate；`DelegationRequest/Success/Error/Outcome`、`DelegationMatchKey`、`DelegationLink`、`DelegationConfig`、`TaskStatus`；移植 `depth.rs`（泛型 parent_resolver walker）。
  - Verify：`cargo test -p delegation`（depth walker 全场景单测：root=0 / grandchild=2 / cap 饱和 / resolver 错误传播）。
  - Files：root `Cargo.toml`(member)、`crates/delegation/{Cargo.toml,src/lib.rs,src/types.rs,src/depth.rs}`。

- [ ] **T2.3 broker 的 5 个 trait + 测试 mock**
  - Acceptance：`ConnectionSpawner`/`DepthLookup`/`ChildStatusLookup`/`MetaWriter`/`EventEmitter`（均 `async_trait`）；`#[cfg(test)]` mock 实现（可预置结果、记录调用、门控竞态）。
  - Verify：`cargo test -p delegation`（mock 编译 + 基础调用断言）。
  - Files：`crates/delegation/src/{spawner.rs,lookups.rs,meta_writer.rs,event_emitter.rs}`（+ test mock 模块）。

- [ ] **T2.4 broker 核心解析路径（含 stop_reason 映射）**
  - Acceptance：`DelegationBroker` + `PendingInner`(running/completed/setups)；`start_delegation`（校验 depth/agent_type/working_dir → spawn → send_prompt_linked → 注册 running → 返回 `Running` ack）；`complete_call`（running→completed，算 duration）；stop_reason 容错归一化映射（plan.md A2 表）。
  - Verify：`cargo test -p delegation`（mock spawner：注册→complete→Completed 报告；depth 超限拒绝；各 stop_reason→正确 error/success）。
  - Files：`crates/delegation/src/{broker.rs,stop_reason.rs}`（+ tests）。

- [ ] **T2.5 broker 异步：状态查询 + 取消 + 结果缓存驱逐**
  - Acceptance：`StatusWait`(Immediate/Bounded(≤60s)/Infinite) + `get_tasks_status`（批量、任一终态即返）；`cancel_delegation`；per-parent FIFO 字节上限（默认 512MB）+ 单结果 256KiB 截断 + 驱逐。
  - Verify：`cargo test -p delegation`（poll/block 语义；取消；超额驱逐保留最新）。
  - Files：`crates/delegation/src/broker.rs`（扩展，必要时拆 `cache.rs`）（+ tests）。

- [ ] **T2.6 broker 并行关联 + setup 窗口竞态裁决**
  - Acceptance：`ToolCallTracker` + `DelegationMatchKey(agent_type,task,working_dir)` 精确关联 + 未键 FIFO 兜底；`early_completes`/`early_cancels` + 到达序号戳「first-terminal-wins」；`pre_canceled_handles`。
  - Verify：`cargo test -p delegation`（2 个并行委派绑定正确不串；setup 期子先完成/父取消/MCP cancel 早到的排序裁决）。
  - Files：`crates/delegation/src/{broker.rs,tool_call_tracker.rs}`（+ tests）。

- [ ] **T2.7 listener（UDS/命名管道服务端）**
  - Acceptance：`TokenRegistry`(register/lookup/revoke/revoke_by_parent)；`serve_one` 解析 `BrokerMessage`、校验 token+parent 一致、转交 broker；Windows 命名管道「服务前先重绑下个实例」。
  - Verify：`cargo test -p delegation`（内存双工流 round-trip：Call→报告；坏 token 拒绝）。
  - Files：`crates/delegation/src/{listener.rs,token_registry.rs}`（+ tests）。

---

## M3 companion（可与 M2 并行，经 proto 解耦）

- [ ] **T3.1 `vibex-mcp` crate（stdio MCP server 骨架）**
  - Acceptance：新 `[[bin]]` crate；解析 `--parent-connection-id/--socket-path/--token/--parent-pid/--features`；stdin 逐行 dispatch `initialize`/`tools/list`/`tools/call`/`notifications/cancelled`；`tool_schema.json`（移植 codeg 5 工具，agent_type enum 用 VibeX 序列化名）。
  - Verify：CLI 冒烟（管道喂 JSON-RPC：initialize 握手、tools/list 返回 5 工具）+ dispatch 单测。
  - Files：root `Cargo.toml`(member)、`crates/vibex-mcp/{Cargo.toml,src/main.rs,tool_schema.json}`（transport 复用 proto）。

- [ ] **T3.2 companion transport client + 取消 + parent-pid 看门狗**
  - Acceptance：`tools/call` → 帧 `BrokerRequest` 到 socket、回包转 MCP `CallToolResult`（结构化 + content 文本双写）；`notifications/cancelled` → broker cancel（500ms 预算）；`--parent-pid` 退出/stdin EOF 时 drain 全部 in-flight。
  - Verify：集成测试（临时 socket + mock listener：round-trip / cancel / 父退出 drain）。
  - Files：`crates/vibex-mcp/src/{main.rs,client.rs,inflight.rs}`。

---

## M4 接线（最小端到端 —— 核心检查点）

- [ ] **T4.1 `ConnectionSpawner` 实现（over AgentRuntime）**
  - Acceptance：`spawn`→`AgentRuntime.connect`+`new_session`（继承 workspace/cwd）；`send_prompt_linked`→`send_prompt` + 持久化 `DelegationLink` 到子 session；订阅 `AgentEvent::PromptFinished{prompt_id==本委派}` 回调 `complete_call`；`cancel`/`disconnect`。
  - Verify：集成测试或 `pnpm tauri dev` 手验单次委派解析。
  - Files：`src-tauri/src/delegation/{mod.rs,spawner_impl.rs}`。

- [ ] **T4.2 lookups + meta + event 实现**
  - Acceptance：`DepthLookup`/`ChildStatusLookup`（over db）；`MetaWriter`+`EventEmitter`（发 `DelegationStarted/Completed` 到 agent-events、写 meta）。
  - Verify：集成/手验（深度按 parent_session_id 计算；事件出现在 agent-events）。
  - Files：`src-tauri/src/delegation/{lookups.rs,meta_emitter_impl.rs}`。

- [ ] **T4.3 新增 `AgentEvent` 委派变体**
  - Acceptance：`events.rs` 加 `DelegationStarted`/`DelegationCompleted` + `DelegationResultSummary`（`kind`=snake_case，`#[ts(export)]`）。
  - Verify：`cargo test -p agents`（序列化 kind 正确）+ `generate_types` 生成无误。
  - Files：`crates/agents/src/events.rs`。

- [ ] **T4.4 MCP 注入（session/new 的 mcp_servers，仅 ClaudeCode）**
  - Acceptance：`new_acp_session` 在父=ClaudeCode 且功能开启时，向 `NewSessionRequest.mcp_servers` 追加 `McpServerStdio("vibex-mcp", …)`（带 token/socket/features args）；非 ClaudeCode 不受影响；token 在此 mint+注册。
  - Verify：单测（请求构造含 companion 条目）+ 手验（companion 进程被拉起、回连成功）。
  - Files：`crates/agents/src/manager.rs`（+ 注入 helper，必要时 `src-tauri/src/delegation/injection.rs`）。

- [ ] **T4.5 app state 接线 + listener 启动（★ M4 核心门）**
  - Acceptance：`AppState` 构造并持有 `DelegationBroker`+`TokenRegistry`+socket 路径；启动期 spawn listener；连接 teardown 时 `revoke_by_parent`。
  - Verify：`pnpm tauri dev` 启动正常；**端到端**：ClaudeCode 调 `delegate_to_agent` → DB 落子 session（parent 链对）→ 结果回父 LLM；`cargo test --workspace` 绿。
  - Files：`src-tauri/src/{state.rs,lib.rs}`、`src-tauri/src/delegation/injection.rs`。

---

## M5 异步全量（端到端）

- [ ] **T5.1 status/cancel 工具端到端**
  - Acceptance：`get_delegation_status`(wait_ms/批量) 与 `cancel_delegation` 经真实 companion→listener→broker 跑通。
  - Verify：手验（轮询/阻塞/取消行为符合 schema 描述）。
  - Files：`crates/delegation/src/listener.rs`、`crates/vibex-mcp/src/main.rs`（status/cancel 分支）。

- [ ] **T5.2 ACP 侧 tool_call 注册 + fan-out 关联端到端**
  - Acceptance：父侧 `session/update(tool_call)` 携带的 id/raw_input 经 `register_pending_tool_call_with_key` 进 `ToolCallTracker`，与 MCP 侧 Call 正确绑定；并行 2+ 委派不串卡。
  - Verify：手验并行 fan-out；卡片归属正确。
  - Files：`crates/agents/src/manager.rs`（tool_call 事件）、`src-tauri/src/delegation/spawner_impl.rs`（关联接线）。

---

## M6 steering（可与 M7 并行）

- [ ] **T6.1 check_user_feedback（队列 + 至少一次投递）**
  - Acceptance：broker 端 per-parent 未读插话队列；listener feedback round-trip 返回 `_commit_ids`；companion「先回包、回包成功后 commit」。
  - Verify：`cargo test -p delegation`（队列读/commit）+ 手验。
  - Files：`crates/delegation/src/{listener.rs,feedback.rs}`、`crates/vibex-mcp/src/main.rs`。

- [ ] **T6.2 ask_user_question（阻塞问答）**
  - Acceptance：listener 注册问题→广播卡片→阻塞等作答→回传；one-at-a-time 拒绝；teardown 竞态处理。
  - Verify：`cargo test -p delegation` + 手验（卡片弹出、作答返回结构化答案）。
  - Files：`crates/delegation/src/{listener.rs,questions.rs}`。

- [ ] **T6.3 `--features` 门控端到端**
  - Acceptance：delegation/feedback/ask 三个开关任一开启才注入 companion，`--features` 精确控制工具暴露。
  - Verify：单测 `companion_features_arg` + 手验关某项后该工具不出现。
  - Files：`crates/agents/src/manager.rs`(注入决策)、`crates/vibex-mcp/src/main.rs`(门控)。

---

## M7 前端（可与 M6 并行）

- [ ] **T7.1 委派 context + reducer cases**
  - Acceptance：`delegation-context.tsx` 根级订阅 agent-events，维护 `Map<parent_tool_use_id, DelegationBinding>`，完成后 2s 宽限 detach；`store.ts` 加 `delegation_started/completed` 两个 case。
  - Verify：前端单测（reduce 两事件→binding 正确）。
  - Files：`frontend/src/features/delegation/delegation-context.tsx`、`frontend/src/features/agents/store.ts`。

- [ ] **T7.2 委派内联卡片 + 打开子会话**
  - Acceptance：`ToolCallCard.tsx` 按 tool_name 识别 `delegate_to_agent` → `DelegateToAgentToolCard`（子 agent 图标+任务+状态徽章+「打开子会话」按钮，用 `useNavigateWithSearch` 跳子 session）。
  - Verify：前端单测（running/ok/err 渲染）+ 手验点击跳转。
  - Files：`frontend/src/components/NormalizedConversation/tools/{ToolCallCard.tsx,DelegateToAgentToolCard.tsx}`、卡片 shell 复用。

- [ ] **T7.3 状态多级回落 + steering 作答/插话 UI**
  - Acceptance：状态解析 实时 binding→meta→tool input/output；`ask_user_question` 作答卡片可选并提交；会话工作时的「插话」输入入口（落 feedback 队列）。
  - Verify：前端单测（解析回落）+ 手验作答/插话往返。
  - Files：`frontend/src/features/delegation/{delegation-status.ts,…}`、ask/feedback 输入组件。

- [ ] **T7.4 类型生成同步**
  - Acceptance：新 Rust 类型（事件变体/报告）经 `generate_types` 同步到 `shared/types.ts` 与 bindings，前端编译无 any。
  - Verify：`generate_types` + `pnpm --filter frontend run build`。
  - Files：`shared/types.ts`、bindings（生成物）。

---

## M8 收尾

- [ ] **T8.1 sidecar 打包**
  - Acceptance：`tauri.conf.json` `externalBin` 注册 `vibex-mcp`；多平台命名 `vibex-mcp-<target-triple>`；dev 期 `VIBEX_MCP_BIN` 覆盖；`locate_vibex_mcp_binary` 三级查找（env→同级→PATH）。
  - Verify：本机打包后 companion 随应用可被定位拉起。
  - Files：`src-tauri/tauri.conf.json`、`src-tauri/src/delegation/injection.rs`、构建脚本（如需）。

- [ ] **T8.2 委派配置命令 + 设置项**
  - Acceptance：Tauri 命令读写 `DelegationConfig`（启停、depth_limit）；设置 UI 暴露开关。
  - Verify：手验设置改动生效（关闭后不注入）。
  - Files：`src-tauri/src/delegation/commands.rs`、前端设置组件。

- [ ] **T8.3 端到端验收清单**
  - Acceptance：成文的手验清单覆盖 spec §9 全部 9 条成功标准。
  - Verify：逐条通过并记录。
  - Files：`docs/specs/multi-agent-delegation/acceptance.md`。

---

## 评审门控（Phase 3）

任务清单覆盖 spec §9 全部成功标准。批准后进入 **Phase 4（Implement）**，从 **T1.1** 起按序执行（遵循 incremental-implementation / TDD：先写验证再实现），每个任务完成即对照 Verify 自检。
