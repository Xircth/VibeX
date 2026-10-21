# Conversation JSONL Window Protocol 乱序 / 重复 / 异常拆分 根因诊断与根治修复方案

**日期**: 2026-10-18  
**关联设计文档**: `docs/plans/2026-10-18-conversation-jsonl-window-protocol.md`、`docs/adr/0082-jsonl-transcript-window.md`  
**对标基线**: Codeg (`2e657fac`)  
**状态**: 待执行（仅方案文档）

---

## 1. 背景与问题现象

在推进 `docs/plans/2026-10-18-conversation-jsonl-window-protocol.md` 与 Codeg 进行架构对齐的过程中，先后通过 `cdca6c86`、`5e49f5a6`、`1a26aff3` 三个提交引入了 JSONL 窗口读取、停写 SQLite 流式块以及前端流式状态修补。但在实际运行体验中仍存在三类高频严重缺陷：

1. **会话消息流中用户消息与 AI 消息乱序**（例如第 2 轮的用户提问出现在第 2 轮 AI 回复之后，或历史消息与实时消息穿插错位、第 2 轮起用户消息在刷新后彻底丢失）。
2. **AI 消息重复显示**（同一轮 AI 回复在界面上同时出现两个气泡，一份来自 JSONL 窗口快照，一份来自实时流式推送）。
3. **AI 消息被异常拆分**（同一轮 AI 回复在流式输出过程中被劈成前后两个气泡，或工具调用更新块在刷新后丢失，或多轮 AI 回复因中间缺少用户消息而直接连排）。

---

## 2. 核心架构偏离诊断：为什么之前的修复像“打地鼠”？

对比 Codeg (`2e657fac`) 与原计划 `2026-10-18-conversation-jsonl-window-protocol.md` 的核心决策（**D1 / D2 / D7 / D8 / D11**），当前实现的最大问题在于：**没有真正完成“单源替换”，而是构造了一个“双投影器、双 ID 命名空间、双 Revision 坐标系”的混合体（Chimera）**：

| 维度 | Codeg (`2e657fac`) & 原计划设计 | VibeX 当前实际实现（问题现状） | 冲突后果 |
| :--- | :--- | :--- | :--- |
| **JSONL 写入边界** | 在 **ACP 协议收发边界**（`PromptRequest` / `SessionNotification` / `PromptResponse`）直接记录原始 ACP wire payload；`PromptRequest` 发送前 bounded-wait 250ms 等待落盘 ack。 | 在 `ConversationAgentEventRecorder`（`runtime_events.rs`）通过 `mirror_appended_event` 将内部 `ConversationEvent` 逆向拼凑成伪造的 ACP JSON；**且只挂载在 Agent 接收侧，完全漏掉了用户发送侧**。 | 第 2 轮起用户提问 `UserTurnCreated` **从未写入 JSONL**；`ToolCallUpsert` 拼出的 `tool_call_update` 因 Schema 不匹配被 `acp_native` 反序列化丢弃；双重结束事件写出两条 `turn_end`。 |
| **窗口读取与实时流的关系** | **严格物理隔离**：`detail.turns: MessageTurn[]` 只存放已落盘的窗口历史（ID 为 `acp-0`, `acp-1`）；正在生成的轮次单独存放在 `liveMessage` + `optimisticUserTurns` 槽位。Turn 结束时用窗口 API 重载替换 `detail.turns` 并清空 `liveMessage`。 | **混装进同一个数组**：打开/刷新时把 JSONL 的 `MessageTurn` 包装成伪造的 `TimelineRow`（ID 为 `"acp-0"`, `"acp-1"`），而实时流仍然走 `ProjectionFold` + `HostRowOpPublisher` 生成 `"{turn_uuid}:user"` / `"{turn_uuid}:assistant"`，塞进同一个 `entry.rows` 数组。 | 同一轮对话在 JSONL 中叫 `"acp-1"`，在实时流中叫 `"{turn_uuid}:assistant"`。只要流中或结束时发生任何窗口合并/刷新，按 `row_id` 去重完全失效，直接产生**双份 AI 消息**或**单轮消息劈成两半**。 |
| **排序与游标坐标系 (`revision`)** | 窗口内 `MessageTurn` 直接按文件内自然顺序排列，分页使用 `before_turn_index`（0-based 数组下标），无跨系统 `revision` 比大小。 | JSONL 行使用 **毫秒级 Unix 时间戳**（`~1.76×10¹²`）作为 `revision`；而实时 `row_ops` 行使用 **SQLite 事件 `sequence`**（`0..100`）作为 `revision`。 | 两个相差 10 个数量级的数字在前端直接比大小：`applyPatchBlocks` 把 `revision=0` 的实时工具块当成旧包丢弃；`mergeOpenTimelineRows` 和 `timelineItemsForEntry` 排序彻底错乱。 |
| **实时序列号断层检测 (`watchGap`)** | 流式事件直接按 `session_id` 驱动 `liveMessage`，不依赖 SQLite `sequence` 连续性触发流中重载。 | `IncrementalRowProjector` 在遇到无 `RowOp` 的持久化事件（如 `UserTurnStarted`、`UsageUpdated`）时推进了 `last_sequence` 却不向前端发包，导致后续 `sequence=0` 的流式包携带的 `previous_sequence > entry.lastSequence`。 | **每一轮流式输出的第 1 个 chunk 和结束时的 `TurnCompleted` 都会百分之百误触发前端 `gapDetected`**，导致流式进行中被强制调用 `loadDetail` 重拉 JSONL，直接引爆双 ID 分裂与重复！ |

---

## 3. 四大根本原因（Root Causes）代码级证据链

### 根因一：用户提问（`UserTurnCreated`）在 JSONL 创建后从未写入 JSONL 文件

1. **调用链断路**：
   - `crates/conversations/src/jsonl_history.rs:583` 的 `mirror_appended_event` 在全仓库中**仅**被 `crates/conversations/src/runtime_events.rs:234` 和 `275`（`ConversationAgentEventRecorder::append_record`）调用。
   - `ConversationAgentEventRecorder` 只处理从 Agent 进程收到的 `AgentEvent`。
   - 用户发送消息生成的 `ConversationEvent::UserTurnCreated` 位于 `crates/conversations/src/service.rs:941`（`commit_new_turn`），通过 `ConversationEventAppender::append_and_apply` 写入 SQLite 并调用 `self.ctx.event_publisher.publish(&created)`（即 `HostRowOpPublisher`）。**整条路径从未调用 `mirror_appended_event`**。
   - 此外，当 ACP Agent 回显 `SessionUpdate::UserMessageChunk` 时，`crates/agents/src/manager.rs:5562-5585` 将其转换成了 `AgentEvent::RawAcpDiagnostic`，在 `mirror_payload` 中被直接忽略。
2. **为什么第 1 轮有时能看到用户消息，第 2 轮起必丢**：
   - 第 1 轮打开会话时，磁盘上尚无 `.jsonl` 文件，`ensure_transcript_file` (`jsonl_history.rs:479`) 发现 `!file_path.is_file()`，执行一次性 `migrate_from_sqlite_events`，将 SQLite 中第 1 轮的 `UserTurnCreated` 迁移进了 `.jsonl`。（若第 1 轮首个 AI chunk 先于 `load_window` 落盘，则连第 1 轮用户消息也会丢失。）
   - 从第 2 轮开始，`file_path.is_file()` 恒为 `true`，`migrate_from_sqlite_events` 不再运行，导致**第 2、3、N 轮的用户提问在 `.jsonl` 中完全缺失**，磁盘文件中只有连续的 `Update(AI)` + `TurnEnd`。
3. **为什么 `1a26aff3` 的 `retainInFlightStreamingUsers` 引发了严重的“用户消息在 AI 消息之后”乱序**：
   - `frontend/src/features/conversation/conversationStore.ts:901-960` 的 `retainInFlightStreamingUsers` 试图在 `load_success` 时把本地 `phase === 'streaming'` 的用户行塞回 JSONL 返回的 `rows` 中：
     ```ts
     const last = next[next.length - 1];
     const previous = next[next.length - 2];
     const lastIsAssistant =
       last?.row.kind === 'message' && last.row.turn.role === 'assistant';
     const previousIsUser =
       previous?.row.kind === 'message' && previous.row.turn.role === 'user';
     if (lastIsAssistant && !previousIsUser) {
       next.splice(next.length - 1, 0, user);
     } else {
       next.push(user);
     }
     ```
   - 当上一轮只有用户消息（无 AI 回复）或当前末尾两行恰好是 `[User 1, AI 2]` 时，`lastIsAssistant` 为 `true` 且 `previousIsUser`（`User 1`）也为 `true`，条件 `lastIsAssistant && !previousIsUser` 为 `false`，走入 `else` 分支 `next.push(user)`，**直接把 `User 2` 插到了 `AI 2` 的后面**（`User 1 -> AI 2 -> User 2`）。
   - 而一旦第 2 轮结束（`phase` 变为 `'settled'`），下一次刷新时 `retainInFlightStreamingUsers` 不再保留 `User 2`，导致 `User 2` 彻底消失，`AI 1` 与 `AI 2` 变成连续两个 AI 气泡。

---

### 根因二：`IncrementalRowProjector` 空 `ops` 推进游标，导致每轮流式必误判 `gapDetected` 并流中重拉 JSONL

在 `crates/conversations/src/projection.rs:1562-1579`：

```rust
pub fn apply_record(
    &mut self,
    record: &ConversationEventRecord,
) -> Result<Option<ConversationRowOpBatch>, serde_json::Error> {
    if record.sequence > 0 && record.sequence <= self.last_sequence {
        return Ok(None);
    }
    let previous_sequence = self.last_sequence;
    let ops = self.fold.apply_record(record)?;
    if record.sequence > 0 {
        self.last_sequence = record.sequence; // <--- BUG: 即使 ops 为空不发包，也推进了 self.last_sequence
    }
    if ops.is_empty() {
        return Ok(None);
    }
    Ok(Some(ConversationRowOpBatch {
        conversation_id: record.conversation_id,
        previous_sequence,
        last_sequence: self.last_sequence,
        ops,
    }))
}
```

1. 每当后端写入一条**不产生 `RowOp` 的持久化事件**（例如每轮必发的 `UserTurnStarted`、`ConversationInputDispatched`、`UsageUpdated`、`SessionModeUpdated`、`AvailableCommandsUpdated`），`self.last_sequence` 被推进（例如从 `2` 变为 `3`），但因为 `ops.is_empty()` 返回 `Ok(None)`，**前端的 `entry.lastSequence` 仍停留在 `2`**。
2. 紧接着，流式阶段发来 `ephemeral_record`（`record.sequence = 0`），`apply_record` 发出的 `ConversationRowOpBatch` 携带 `previous_sequence: 3, last_sequence: 3`。
3. 前端 `detectSequenceGap`（`conversationTimelineRegistry.ts:368`）与 `applyRowOpBatch`（`conversationStore.ts:755`）判断 `previous (3n) > entry.lastSequence (2n)` 成立：
   - **直接丢弃该流式增量包**；
   - 将 `gapDetected` 设为 `true`，触发 `watchGap`（`conversationTimelineRegistry.ts:171`）在流式输出中途调用 `loadDetail` 重读 JSONL！
4. 同理，Turn 结束前先到達的 `UsageUpdated`（无 `RowOp`）再次推进 `self.last_sequence`，导致紧随其后的 `TurnCompleted` 批次再次被前端当成 Gap 丢弃并触发重拉。

---

### 根因三：双套 Row ID（`"acp-N"` vs `"{turn_uuid}:assistant"`）在流中重载时把同一条 AI 消息劈成两半或重复显示

当根因二的 `watchGap -> loadDetail` 在流式中途返回时：
1. 在 `conversationStore.ts:154`：
   ```ts
   const detailLastSequence = toBigInt(action.detail.timeline.last_sequence);
   const keepRealtimeRows = entry.lastSequence > detailLastSequence;
   ```
   由于流式 chunk 不再递增 SQLite `sequence`，`entry.lastSequence > detailLastSequence` 为 `false`。
2. `load_success` 用 JSONL 读出的 `incomingRows` 覆盖 `entry.rows`，此时已落盘的前半段 AI 回复在 `entry.rows` 中的 `row_id` 是 **`"acp-1"`**。
3. 80ms 后，同一个 Turn 的后续流式 chunk 通过 `row_ops` 到达，其目标 `row_id` 是 **`"{turn_uuid}:assistant"`**。
4. 因为 `"{turn_uuid}:assistant" !== "acp-1"`：
   - `AppendText` 写入 `entry.liveText["{turn_uuid}:assistant"]`；
   - `withPendingAssistantTurns`（`conversationStore.ts:975`）因 `messageTurnPairKey("acp-1")` 返回 `null`，判定当前用户提问没有配对的 assistant 行，**当场新建第二个 AI 气泡 `"{turn_uuid}:assistant"`**；
   - Turn 结束时 `TurnCompleted` 发送 `RowOp::Upsert("{turn_uuid}:assistant")`，在 `entry.rows` 中正式插入第二条 AI 消息行。
5. **结果**：前半截文字留在 `"acp-1"` 气泡，后半截文字（或整段文字）出现在 `"{turn_uuid}:assistant"` 气泡，直接造成 **AI 消息被异常拆分** 与 **AI 消息重复显示**。

---

### 根因四：双套 `revision` 坐标系冲突 + `mirror_payload` 伪造 JSON 导致工具更新丢失与二次拆分

1. **时间戳 `revision` (`~1.76×10¹²`) vs 事件序号 `revision` (`0..100`)**：
   - `jsonl_history::rows_from_turns` (`jsonl_history.rs:68`) 将 JSONL 行的 `revision` 设为 `turn.timestamp.timestamp_millis().max(1)`（13 位毫秒时间戳）。
   - 实时 `row_ops` 的 `revision` 是 SQLite `sequence`（流式 `ephemeral_record` 更是 `0`）。
   - 在 `conversationStore.ts:471` 的 `applyPatchBlocks` 中：
     ```ts
     if (index === undefined) {
       if (revision < maxRowRevision(rows)) {
         return { rows, liveText };
       }
     ```
     只要存在任何一条 JSONL 历史消息，`maxRowRevision(rows)` 即为 `~1.76×10¹²`，导致新轮次流式 `PatchBlocks`（`revision = 0`）在行尚未创建时被判定为 `0 < 1.76×10¹²` 而**静默丢弃**。
   - 在 `timelinePaging.ts:53` 的 `mergeOpenTimelineRows` 和 `conversationStore.ts:694` 的 `timelineItemsForEntry` 中，两套相差 10 个数量级的 `revision` 混排，直接导致实时行或 `sideItems` 被排到历史消息最顶端。
2. **`ToolCallUpsert` 逆向拼装的 `tool_call_update` 不符合 ACP Schema**：
   - `runtime_events.rs:869` 将 `AgentEvent::ToolCallUpdate.content` 包装为 JSON 对象 `{"text": "..."}`，`jsonl_history.rs:580` 将其原样写入 `"sessionUpdate": "tool_call_update"` 的 `"content"` 字段。
   - `crates/agents/src/parsers/acp_native.rs:514` 使用 `acp::schema::v1::SessionUpdate::deserialize` 解析时，`ToolCallUpdateFields.content` 要求 `Option<Vec<ToolCallContent>>`（数组），反序列化直接失败并跳过该行，导致从 JSONL 恢复时所有工具执行结果与状态更新丢失。
   - 若首次 `ToolCall` 事件自带 `content` 或 `raw_output`，`jsonl_history.rs:571` 的 `updating` 判断还会把首次 `ToolCall` 误写成缺少 `title` 的 `tool_call_update`，连工具卡片本身都无法生成。
3. **双重结束事件（`TurnCompleted` + `PromptFinished`）写两次 `turn_end`**：
   - `runtime_events.rs:924-930` 将 `AgentEvent::TurnCompleted` 和 `AgentEvent::PromptFinished` 均映射为 `ConversationEvent::TurnCompleted`，向 JSONL 写入两次 `EntryKind::TurnEnd`。在 `acp_native::project_turns` 中，第一个 `turn_end` 就会关闭当前 `PendingTurn`，若其后还有尾部块，就会被拆分为新的 AI Turn。

---

## 4. 根治修复方案设计（全面对齐 Codeg `2e657fac`）

### 4.1 架构原则（Architecture Invariants）

1. **JSONL 写入单一边界原则**：
   - 废除从 `ConversationEvent` 逆向拼凑 JSONL 的 `jsonl_history::mirror_appended_event` / `mirror_payload`。
   - 对所有使用 ACP JSONL 的 Agent（`records_acp_jsonl(&agent_id) == true`），直接在 `crates/agents/src/manager.rs` 的 **ACP Wire 收发边界**调用 `acp_transcript` 记录原始 ACP 协议消息。
2. **已落盘窗口（Persisted Window）与实时流（In-Flight Stream）严格物理隔离原则**：
   - 前端 Store 中不再把 JSONL 窗口行（`acp-0`, `acp-1`）与实时流增量（`{turn_uuid}:*`）混装进同一个按 `row_id` / `revision` 合并的数组。
   - 已落盘历史窗口只由 `get_conversation_detail_window` 返回的权威 `turns` 驱动；正在流式生成的当前轮次独立存放在 `inFlightTurn`（或隔离的实时层）中，渲染时拼在已落盘窗口末尾。
   - 当一轮对话到达终态（`TurnCompleted` / `TurnFailed` / `TurnCancelled` / `TurnInterrupted`）时，触发一次 `get_conversation_detail_window` 尾部窗口拉取，用文件投影出的权威 `turns` 原子替换已落盘窗口并清空当前轮次的流式缓冲。
3. **单调一致的序号与分页坐标原则**：
   - 窗口内历史消息完全按文件内自然顺序（0-based `turn_index`）排列与向前分页（`before_turn_index`），彻底废除用毫秒时间戳伪造 `revision` 的做法。

---

### 4.2 阶段一：后端 ACP Wire 边界直接录制 JSONL（修复根因一 & 根因四之工具块/双重 `turn_end`）

**涉及文件**：
- `crates/agents/src/manager.rs`
- `crates/agents/src/acp_transcript.rs`
- `crates/conversations/src/jsonl_history.rs`
- `crates/conversations/src/runtime_events.rs`

**具体改动**：

1. **在 `crates/agents/src/manager.rs` 封装统一的录制辅助函数（对齐 Codeg `acp/connection.rs`）**：
   - `record_transcript_header(&agent_id, &acp_session_id, &working_dir)`：在 `new_acp_session` 和 `load_or_new_acp_session`（`claim_replay_transcript` 之外的首次绑定）中确保写入 `HeaderLine`。
   - `record_prompt(&agent_id, &acp_session_id, &acp_prompt_blocks)`：
     - 在 `AgentConnectionRunner::run_prompt`（`manager.rs:4227` 构造 `PromptRequest` 处），将 `Vec<acp::schema::v1::ContentBlock>` 序列化为 `{"prompt": prompt_blocks}`，调用 `acp_transcript::record_entry(..., EntryKind::Prompt, payload)`。
     - **关键时序保证**：使用 `tokio::time::timeout(Duration::from_millis(250), ack_rx).await` 等待 writer 线程落盘 ack 后再调用 `conn.send_request(request)`。这保证任何紧随其后的窗口读取都能在 `.jsonl` 中读到该轮的用户 Prompt，且严格位于该轮所有 `Update` 之前。
   - `record_session_update(&agent_id, &acp_session_id, &args.update)`：
     - 在 `AcpClientBridge::session_notification`（`manager.rs:5409`）中，当 `bound_session_id.is_some()` 且 `is_session_transcript_update(&args.update)`（或包含 usage 的更新）时，直接将**原始 `acp::schema::v1::SessionUpdate`** 序列化写入 `EntryKind::Update`。
     - 注意：跳过被过滤的 `pi_startup_banner`；对于流式去重（`gate_stream_chunk`），仅对通过 `gate_stream_chunk` 的 `AgentMessageChunk` / `AgentThoughtChunk` 录制 `EntryKind::Update`，避免 `codex-acp` 尾部全量快照重复写入 JSONL。
   - `record_turn_end(&agent_id, &acp_session_id, stop_reason, usage)`：
     - 在 `AgentConnectionRunner::run_prompt` 的 `prompt_future` 结束分支（正常返回、错误返回、idle timeout、cancel 结束）写入**唯一一次** `EntryKind::TurnEnd`（例如 `{"stopReason": "end_turn"}` 或 `"cancelled"` / `"error"`）。
   - **Steer（流中插话）录制**：
     - 当 `steer_prompt` 成功返回 `AgentSteerOutcome::Injected` 时，在 wire 边界（或 `service.rs::steer` 确认 `Injected` 时）将 steer 块作为 `EntryKind::Prompt` 写入 JSONL，确保插话在落盘历史中也有准确位置。

2. **清理 `runtime_events.rs` 与 `jsonl_history.rs` 中的伪造镜像逻辑**：
   - 删除 `runtime_events.rs` 中对 `jsonl_history::mirror_appended_event` 的两次调用。
   - 删除 `jsonl_history.rs` 中的 `mirror_appended_event` 与 `mirror_payload`（保留 `migrate_from_sqlite_events` 仅用于升级存量尚未生成 `.jsonl` 的旧 SQLite 会话，但修正 `migrate_from_sqlite_events` 中 `ToolCallUpsert` 到标准 `acp::schema::v1::ToolCall` / `ToolCallUpdate` 的格式转换，确保旧会话迁移后也能被 `acp_native::project_turns` 100% 反序列化）。

---

### 4.3 阶段二：修复 `IncrementalRowProjector` 序号断层与双坐标系（修复根因二 & 根因四之 `revision` 冲突）

**涉及文件**：
- `crates/conversations/src/projection.rs`
- `crates/conversations/src/jsonl_history.rs`

**具体改动**：

1. **修复 `IncrementalRowProjector` 的 `previous_sequence` 断层（`crates/conversations/src/projection.rs:1530-1580`）**：
   - 在 `IncrementalRowProjector` 中区分两个游标：
     - `last_seen_sequence: i64`：记录已处理过的最大 SQLite `record.sequence`（用于幂等跳过重复事件）；
     - `last_emitted_sequence: i64`：记录**上一次实际向前端发出非空 `ConversationRowOpBatch` 时**的序列号（初始化为 `from_records` 时的 `last_sequence`）。
   - 在 `apply_record` 中：
     ```rust
     if record.sequence > 0 && record.sequence <= self.last_seen_sequence {
         return Ok(None);
     }
     let previous_sequence = self.last_emitted_sequence;
     let ops = self.fold.apply_record(record)?;
     if record.sequence > 0 {
         self.last_seen_sequence = record.sequence;
     }
     if ops.is_empty() {
         return Ok(None);
     }
     self.last_emitted_sequence = self.last_seen_sequence;
     Ok(Some(ConversationRowOpBatch {
         conversation_id: record.conversation_id,
         previous_sequence,
         last_sequence: self.last_emitted_sequence,
         ops,
     }))
     ```
   - **效果**：当 `UserTurnStarted`、`ConversationInputDispatched`、`UsageUpdated` 等不产生 `RowOp` 的事件经过投影器时，不会导致下一条有效 `RowOpBatch` 的 `previous_sequence` 跳号，**彻底消灭流式过程中前端误报 `gapDetected` 触发 mid-turn `loadDetail` 的问题**！

2. **废除 `jsonl_history::rows_from_turns` 中的毫秒时间戳 `revision`**：
   - 在 `crates/conversations/src/jsonl_history.rs:68-82` 中，停止使用 `turn.timestamp.timestamp_millis()` 作为 `TimelineRow.revision`。
   - JSONL 窗口行的 `revision` 统一使用基于窗口内顺序的单调小序号（或与当前会话 `db_cursor` 对齐的基准序号），并在前端将“已落盘窗口行”与“实时流式行”彻底分层管理（见阶段三）。

---

### 4.4 阶段三：前端状态分层——隔离“已落盘窗口历史”与“实时流式轮次”（修复根因三 & 彻底根除乱序/重复/拆分）

**涉及文件**：
- `frontend/src/features/conversation/conversationStore.ts`
- `frontend/src/features/conversation/conversationTimelineRegistry.ts`
- `frontend/src/features/conversation/timelinePaging.ts`

**具体改动（对齐 Codeg `message-state-context.tsx`）**：

1. **在 `ConversationTimelineEntry` 中将“窗口历史”与“实时流状态”物理分离**：
   - **`windowRows: TimelineRow[]`**（或直接存储窗口返回的已落盘消息行 `acp-0`, `acp-1`, ...）：
     - **唯一数据来源**：仅由 `load_success`（`get_conversation_detail_window`）和向前分页 `prepend_older_page`（`get_conversation_turns_page`）更新。
     - 窗口内顺序严格以服务端返回的数组顺序为准（`prependTimelineRows` 仅按 `row_id` 去重并将更早的页直接拼在数组头部），不再按 `revision` 与实时行混排。
   - **`liveRows: TimelineRow[]` + `liveText: Record<string, LiveTextState>`**（实时流式层）：
     - **唯一数据来源**：仅由乐观发送（`insert_optimistic_user`）和当前未落盘轮次的实时 `row_ops`（`{turn_uuid}:user`, `{turn_uuid}:assistant`, 以及当前轮产生的 side rows）驱动。
   - **Turn 终态收敛（Settlement Reconciliation）**：
     - 当收到当前 Turn 的终态事件（`TurnCompleted` / `TurnFailed` / `TurnCancelled` / `TurnInterrupted`）或执行完整的 `loadDetail` 刷新且 `hasActiveTurn === false` 时：
       1. 调用 `get_conversation_detail_window` 获取已包含该轮完整 `Prompt` + `Update` + `TurnEnd` 的最新 JSONL 窗口；
       2. 在 `load_success` 中用最新窗口原子更新 `windowRows`，并清空已收敛的 `liveRows` / `liveText` / `optimistic` 占位。
     - 若在 Turn 仍在流式进行中（`hasActiveTurn === true`）收到了 `load_success`（例如首次打开正在运行的会话）：
       - 如果 JSONL 窗口末尾已经包含了当前正在流式生成的最后一轮（因为阶段一保证了 `Prompt` 在发送前已落盘、且 `Update` 已实时追加到 JSONL），则在渲染合并层中，将 `windowRows` 中正在流式的那一轮（`phase === 'streaming'` 的末尾 user/assistant 行）与 `liveRows` 中的当前轮按“实时层优先（或仅在 `liveRows` 为空时回退显示 `windowRows` 末尾流式行）”进行**单轮对齐替换**，**绝不允许 `"acp-N"` 与 `"{turn_uuid}:*"` 同时出现在最终渲染列表 `items` 中**！

2. **删除所有因双系统混装而打的补丁函数**：
   - 删除 `conversationStore.ts` 中的 `retainInFlightStreamingUsers`（`lines 901-960`）。
   - 删除 `conversationStore.ts` 中的 `orderSameTurnUserBeforeAssistant`（`lines 1002-1066`）和 `mergeOptimisticUsersBeforeOrphanAssistants`（`lines 1081-1105`）中针对跨体系行的猜测性重排。
   - 简化 `timelineItemsForEntry`（`conversationStore.ts:689-735`）：
     - 先按自然顺序输出 `windowRows`（若 `liveRows` 正在承载当前最后一轮，则跳过 `windowRows` 末尾对应的未完结流式行，避免双份显示）；
     - 再按顺序接上当前轮次的 `liveRows`（`{turn_uuid}:user` -> `"{turn_uuid}:assistant"`）。

---

## 5. 验证与回归测试计划（Verification Checklist）

在后续执行本方案时，需通过以下测试验证所有根因均已彻底消除：

1. **多轮连续对话 JSONL 完整性测试（验证根因一修复）**：
   - 连续发送 3 轮对话（Turn 1 -> Turn 2 -> Turn 3），验证磁盘 `<acp_session_id>.jsonl` 中严格按序包含 3 条 `k: "prompt"`、对应的 `k: "update"` 以及 3 条 `k: "turn_end"`。
   - 在第 2 轮、第 3 轮流式进行中及结束后分别调用 `get_conversation_detail_window`，验证返回的每轮用户消息与 AI 消息顺序严格为 `User 1 -> AI 1 -> User 2 -> AI 2 -> User 3 -> AI 3`，无任何用户消息丢失或排到 AI 消息之后。
2. **流式过程零假阳性 Gap 测试（验证根因二修复）**：
   - 在包含 `UserTurnCreated` -> `UserTurnStarted` -> 多次 `AssistantTextDelta` -> `ToolCallUpsert` -> `UsageUpdated` -> `TurnCompleted` 的完整事件流中，验证 `IncrementalRowProjector` 发出的每一批 `ConversationRowOpBatch` 的 `previous_sequence` 与上一批的 `last_sequence` 严格连续（`detectSequenceGap` 全程返回 `false`）。
3. **流式中途刷新 / 打开运行中会话不重复、不拆分测试（验证根因三修复）**：
   - 在 AI 流式输出前半段后主动触发一次 `loadDetail` 刷新，随后继续推送后半段 `AssistantTextDelta` 与 `ToolCallUpsert` 直至 `TurnCompleted`，断言前端 `selectConversationTimelineItems` 中始终只有**唯一一个**当前轮次的 AI 消息气泡，不会同时出现 `"acp-N"` 和 `"{turn_uuid}:assistant"`，也不会将同一轮回复拆成两个气泡。
4. **工具调用（`tool_call` + `tool_call_update`）落盘与重载一致性测试（验证根因四修复）**：
   - 执行包含工具调用（含流式输出、状态从 `running` 变为 `completed`、带输出结果）的对话，完成后重新加载窗口，验证 `acp_native::project_turns` 无 `skipping unparsable session update` 警告，且工具标题、输入、输出、状态与流式阶段完全一致。
5. **长会话向前分页（`loadOlder`）顺序稳定性测试**：
   - 在 > 30 轮的会话中多次向上滚动触发 `loadOlder`，验证历史页 prepend 后顺序严格单调，无任何消息跳到顶部或尾部。
