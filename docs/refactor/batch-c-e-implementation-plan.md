# 批次 C–E 实施指南（承接已完成的 A、B）

本文件承接 `docs/adr/0001..0004` 与根 `CONTEXT.md`，把批次 C/D/E 的**已拍板设计**落成可直接执行的实施步骤。批次 A（事件版本化+容错，commit `a554010`）与批次 B（崩溃恢复，commit `555989e`）已完成并全绿。

> 纪律不变：忠实实施，不重新设计；发现设计与代码现实冲突则停下报告。命令层薄化标杆是 `commands/model_provider.rs`。

---

## 批次 C：消灭双投影（行操作协议）

### 现状（双投影的根因）
- **初始加载**走 `conversation_detail`（`useConversationTimeline.ts:64` → invoke `conversation_detail`），其 `DbConversationDetail.timeline.rows` 来自 Rust 的 `ConversationProjector::project`（`crates/db/.../conversation_projection.rs`）。
  - 注意：`conversation_timeline_page` / `conversationApi.timelinePage` **已定义但零调用**；真正的初始加载是 `conversation_detail`。
- **实时流 + gap 回填**走原始事件 `ConversationEventEnvelope`，前端 `conversationStore.ts:258-477` 的 `applyEventRows` **再折叠一遍**（TS 版折叠）。
- 两套折叠（Rust vs TS）会漂移 → 流式中刷新页面时间线不一致（双投影症状）。

### 目标架构（单投影）
后端是唯一投影者，前端 store 退化为哑容器，消费两种 **row op**（见 `CONTEXT.md` 词汇表新增条目）：
1. **行 upsert**：按 `row_id` + 单调 `revision` 幂等插入/整体替换一行。
2. **文本追加 text-append**：只带流式文本新片段，前端追加进独立的 **live 文本覆盖字段**（该行下次 upsert 时清空）。消除长消息 O(n²)。

三条路径（初始加载 / 实时流 / gap 回填）消费同一种 `TimelineRow` 数据。

### 关键设计决策（已定）
- **revision = 产生该行当前状态的最新事件 `sequence`**（全局单调 → 每行单调）。无需独立计数器。
- **row_id 分配**（后端权威，前端不自行推导，避免 append-only 行无法去重）：
  - `message_turn` user：`${turn_id}:user`；assistant：`${turn_id}:assistant`（保留现有约定，`withPendingAssistantTurn` 依赖之）。
  - `permission_request`：`perm:${permission_id}`；`question_request`：`q:${question_id}`；`feedback_request`：`fb:${feedback_id}`；`terminal_summary`：`term:${terminal_id}`；`delegation`：`del:${delegation_id}`。
  - append-only 无自然 id 者用产生它的事件序号：`file_change_summary`→`fc:${seq}`，`session_notice`→`notice:${seq}`，`turn_error`→`err:${turn_id}:${seq}`。
- **live 文本覆盖字段**：前端每行维护 `liveText[row_id] = { text, reasoning }`。text-append 追加；upsert 时清空（upsert 的 blocks 已含到该点的全部文本，自我纠正）。纯文本流（无工具）期间 assistant 行可能尚未 upsert 出现——此时由 `withPendingAssistantTurn` 合成的流式气泡渲染 `liveText`。
- **幂等规则（前端）**：upsert 当 `!exists || revision >= 现有.revision` 时替换并置 revision；text-append 当 `exists && revision > 现有.revision` 时追加并置 revision（严格 `>` 防重投递重复追加）。
- **实时通道**：复用 `conversation-events` 通道，载荷从 `ConversationEventEnvelope` 改为 `ConversationRowOpBatch`（下述）。`notify_conversation_event`（IM 投递，`events.rs:628`）仍收原始 envelope，与前端通道解耦，不受影响。

### 后端改动

1. **新类型（`crates/agents/src/conversation.rs`，`#[ts(export)]` + `generate_types.rs` 注册）：**
   ```rust
   pub struct TimelineRow { pub row_id: String, pub revision: i64, pub row: ConversationTimelineRow }
   #[serde(rename_all="snake_case")] pub enum TimelineTextStream { Text, Reasoning }
   #[serde(tag="op", rename_all="snake_case")]
   pub enum ConversationRowOp {
       Upsert { row: TimelineRow },
       AppendText { row_id: String, revision: i64, stream: TimelineTextStream, delta: String },
   }
   pub struct ConversationRowOpBatch { pub conversation_id: Uuid, pub last_sequence: i64, pub ops: Vec<ConversationRowOp> }
   pub struct ConversationRowPage { pub conversation_id: Uuid, pub after_sequence: i64, pub last_sequence: i64, pub has_more: bool, pub rows: Vec<TimelineRow> } // gap 回填
   ```
   - 改 `ConversationTimeline.rows` 与 `ConversationTimelinePage.rows`：`Vec<ConversationTimelineRow>` → `Vec<TimelineRow>`。

2. **`ProjectionFold`（`conversation_projection.rs`，原地增强，不搬家——ADR-0003）：**
   - `ProjectedTurn` 增 `revision: i64`（每个触及该 turn 的事件置为 `record.sequence`）。
   - `side_rows: Vec<ConversationTimelineRow>` → `Vec<TimelineRow>`（创建/修改时带 row_id + revision=record.sequence）。permission_responded / delegation_completed 修改时同样刷新 revision。
   - `into_timeline` 产出 `Vec<TimelineRow>`：message_turn 行 revision=turn.revision，row_id 按上述约定。
   - 增量发射：新增 `apply` 变体或伴随方法产出 `Vec<ConversationRowOp>`（文本 delta→AppendText；其余→受影响行 Upsert）。**单一实现**：Upsert 行内容必须来自同一 `ProjectionFold`，禁止另写平行折叠。
   - `refresh_snapshot_on_settle` 的 snapshot 里 `ProjectionSnapshotState` 增 revision 字段。

3. **ops 计算（供 emit 用，复用单一折叠）：**
   - 推荐实现：`conversation_row_ops_for_record(pool, record) -> Vec<ConversationRowOp>`：
     - `AssistantTextDelta`/`AssistantReasoningDelta` → `AppendText{ row_id: assistant, revision: seq, stream, delta }`（无状态）。
     - 其余 → `ConversationProjector::project(pool, conv)`，取 `rows.filter(|r| r.revision == record.sequence)`，逐个 `Upsert`。（非文本事件不频繁，O(turn)/事件可接受；文本走 AppendText 避免 O(n²)。）
   - 幂等/乱序由前端 revision 规则兜底。

4. **集中化 emit（4 处发射点归一）：**
   - 现有 4 处向 `CONVERSATION_EVENTS` 发 envelope：`events.rs:622,650`（agent 流）、`conversations.rs:384`（`emit_conversation_events_after`，start-turn/权限/取消命令）、`chat_channel.rs:1457`、`web_service.rs:324`。
   - 新增单一 `emit_conversation_row_ops(app, pool, conversation_id, records)`：算 ops → 发 `ConversationRowOpBatch`。4 处全部改调它。
   - `events.rs` 的 coalescer 仍在（合批），但发的是 ops 批。

5. **gap 回填命令（`conversations.rs:231` `conversation_events_since_core`）改为按行：**
   - 新命令/改造：返回 `ConversationRowPage`，`rows = project(conv).rows.filter(revision > after_sequence)`。不再拉原始事件、不再 `event_envelope_from_record`。
   - 注意：`event_envelope_from_record`（`conversations.rs:626`）与 `events.rs:715` 的 envelope 解析路径随之可简化/退役（`events.rs:715` 是对刚序列化事件的回环解析，可保留）。

6. `pnpm run generate-types`（删除的类型进 `removed_declarations()`，新类型 `insert_declaration`）。

### 前端改动（`frontend/src/features/conversation/`）
- **删除 `applyEventRows`（约 258-477）与其折叠 helper**（`userTurnFromEvent`/`upsertMessageTurn`/`updateAssistantTurn`/`setTurnPhase`/`appendTextBlock`/`appendThinkingBlock`/`toolBlocks`）。
- **store 改为哑容器**：
  - `rows` 改为按 `row_id` 索引（`Record<row_id, TimelineRow>` 或保留数组+`row_id` 键）。
  - 新增 `liveText: Record<row_id, {text, reasoning}>`。
  - reducer：`row_ops` action → upsert（幂等规则）+ text-append（追加 liveText）；upsert 时清 `liveText[row_id]`。
  - **保留**的非折叠职责（勿删）：gap 检测（`ConversationGapState`，`applyConversationEvent:217-230`）、`lastSequence` 推进、session 模式/配置（`session_mode_updated`/`session_config_options_updated`）、乐观 turn（`optimistic_turn`/`reconcileOptimisticTurns`）、`currentTurnId`、pending 气泡合成（`withPendingAssistantTurn`/`withOptimisticPendingAssistantTurn`，改为从 `liveText[${turn}:assistant]` 取流式文本）。
  - `keepRealtimeRows` 守卫（`load_success:91-98`）与文本版 `reconcileOptimisticTurns` 因不再前端折叠而简化为按 `row_id` 对账。
- **render 路径**：`timelineTurnsForEntry`/`sideRowsForEntry` 与 `AgentTimelineConversation.tsx` 的 `row.kind` 派发改为读 `row.row.kind`（因 `TimelineRow` 包装），并把 `liveText` 覆盖到 assistant 行的尾部文本/思考块。side 行现在有稳定 `row_id`，可作 React key。
- **hook（`useConversationTimeline.ts`）**：订阅改收 `ConversationRowOpBatch` → dispatch `row_ops`；gap 回填 `conversationApi.eventsSince` 改调返回 `ConversationRowPage` 的新命令 → dispatch upsert 那批行。

### 验收
- 长回复流式中刷新页面，刷新前后时间线完全一致（**运行时手测**，headless 无法覆盖）。
- 单测覆盖：Rust 折叠产出的 ops（文本→AppendText、工具/状态→Upsert、revision 单调）、gap 命令按行、前端 store 幂等 upsert + liveText concat + upsert 清空 liveText。
- `pnpm --filter ./frontend test` 通过，重写受影响测试（见下）。

### 受影响测试（需改写/新增）
- 前端 `conversationStore.test.ts`：折叠类用例（:61,:152,:196,:233,:265,:331,:359,:422,:467,:568,:591）改为投喂 row ops 断言 store 状态；gap/optimistic/mode 用例（:294,:504,:541,:643,:121）基本存活。`noResponseRegression.test.ts`、`UseConversationTimeline.test.tsx`（:178 折叠 24 delta）同理。
- 后端 `conversation_projection.rs` 测试：`timeline.rows[i]` → `.row`；断言 row_id/revision。

### 禁止
- 不复用 legacy RFC-6902 `ConversationPatch`。
- 不在本批次搬投影模块（ADR-0003：行为变化与位置变化分开；搬家在 E）。

---

## 批次 D：退役收尾

### D1 · agent_runtime 表群退役（非死表，先迁三处活跃用途再删）
1. 删只写不读的影子事件槽 `SqliteAgentRuntimeSink`（`src-tauri/src/events.rs:76`，接线点 `state.rs:55`）——`conversation_events` 是唯一权威日志。
2. 删 `get_runtime_snapshot` 里从 `agent_permissions` 合并 pending 权限的逻辑（`src-tauri/src/commands/agents.rs:209`）——批次 B 落地后无存在理由。
3. **保留历史导入**：`agent_history_imports` 存量迁移 `INSERT SELECT` 进 `conversation_imports`（表已存在，见 `20260616..event_sourced_conversation_core.sql`）；写入点 `agents.rs:718` 改指新表。
4. 以上完成后新增迁移 `DROP` 全部 9 张 `agent_*` 表，删 `crates/db/src/models/agent_runtime.rs`。

### D2 · 单一身份枚举 AgentKind（ADR-0002）
1. `crates/api-types` 新增 `AgentKind`（7 agent + QaMock 常驻第 8 变体）；serde 用 DB 既有 snake_case 键（`claude_code` 等，见 `registry.rs:executor_key_for`）实现零数据迁移；反序列化保留对历史杂拼写（SCREAMING/Pascal，见 `agent_type_from_executor_key`）的宽容解析。
2. `agents::AgentType` 与 `executors::BaseCodingAgent` 全替换为 `AgentKind`（可先 type alias 过渡，最终删旧名）；六处字符串 match 桥接函数删除。`registry_id`（`claude-acp` 等）是条目元数据，保留原样不参与统一。
3. 清空 `crates/api-types` 零引用死模块（issue*、notification、pull_request、user、project_status）。
4. `pnpm run generate-types`（删除类型进 `removed_declarations()`，新类型 `insert_declaration`）。

### 验收
`grep -rn "BaseCodingAgent\|AgentType\b" crates/ src-tauri/` 只剩 alias 或零命中；旧库（含杂拼写 agent 键的 sessions 行）能正常打开；`generate-types:check`、`prepare-db:check` 通过。

---

## 批次 E：命令层下沉

1. 新建 `crates/conversations`（依赖 agents + db）：迁入 `conversation_service.rs` 全部编排 + 批次 B 的恢复协调器 + 从 `crates/db` 搬入投影折叠/快照（`conversation_projection.rs`）。搬完后**删除 `crates/db` 对 `agents` 的依赖**（硬验收：`crates/db/Cargo.toml` 不含 `agents`）。
2. `agent_skills.rs`（1242 行）扫描/安装/托管/市场逻辑迁入 `crates/agents/src/skills.rs`，命令层只留委派。
3. `chat_channel.rs`（1642 行）投递/WebSocket/持久化并入 `crates/services` 的 `chat_delivery` 模块；密钥迁至 `~/.vibex/.env`（明文、权限 0600、**只收 IM 渠道密钥**；迁移时读旧 JSON 写入 .env 后删旧文件）。按 ADR-0004 有意明文，不改钥匙串。
4. 三个命令文件下沉后达到 `model_provider.rs`（78 行纯委派）同等形态。

### 验收
`crates/db/Cargo.toml` 不含 `agents`；三命令文件只剩薄委派；`pnpm run check`、`pnpm run lint`（含 `--features qa-mode`）、`cargo test --workspace`、前端全部测试通过。

---

## 全局纪律速查
每批次跑：`pnpm run check && pnpm run lint && cargo test --workspace && pnpm --filter ./frontend test`，以及 `generate-types:check`、`prepare-db:check`（改过 sqlx 宏/迁移先 `prepare-db`）。批次内行为变化与机械搬迁分开提交。命名对齐 `CONTEXT.md`。

> 工作树背景：仓库含大量与本任务无关的既有未提交改动（settings/session polish）。按用户指示批次 A 提交已一并纳入；后续批次提交只含各自改动。曾顺带修复阻塞门槛的既有问题：git crate 缺 `DiffChangeKind` import、chat_channel `collapsible_if`、web_service `result_large_err`。
