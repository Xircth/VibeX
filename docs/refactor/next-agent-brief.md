# 接手提示词：对抗性审查 + 后续开发（批次 D2、E）

> 你是 VibeX 架构整改任务的**接手工程师兼审查者**。前一个 Agent 声称完成了批次
> A、B、C、D1 并全绿。**你的第一职责不是相信它，而是从第一性原则出发证伪它。**
> 通过审查后，再继续未完成的 D2、E。

---

## 0. 第一性原则（贯穿全程的思维方式）

1. **不信任任何未经你亲自验证的断言。** “测试通过”不等于“正确”——测试只覆盖被写下的
   用例。正确性来自**不变量（invariant）成立**，不来自绿色的 CI。对每个批次，先问：
   *这个改动依赖哪条不变量？它在所有输入下都成立吗？我能不能构造一个反例？*
2. **从根因而非现象推理。** 不要问“它看起来对吗”，要问“它为什么必然对/必然错”。
3. **亲自读代码、亲自跑。** 不要根据提交信息或本文的转述下结论——那些可能是错的。
   打开 `git show <commit>`、读 diff、读被改文件的上下文、构造输入实际运行。
4. **区分“已验证”与“仅编译通过/仅单测通过”。** 尤其是**运行时验收**（见 §2）——
   前一个 Agent 在无 GUI/无可配置 agent 的环境里**无法**验证 B、C 的核心运行时行为，
   它们目前只有结构性论证 + 单测。这是最大的未知区。
5. **发现设计与代码现实冲突就停下报告**，不要自行改设计方向（ADR 已拍板）。但**发现
   实现 bug 必须修**——那不是改设计，是让实现符合设计。

---

## 1. 必读材料（开工前读完，不可跳过）

- `CLAUDE.md`（分层规则、命令、ACP 单轨标准重构规则）
- `CONTEXT.md`（领域词汇表：Turn 四终态、Projection、Timeline row、Revision、
  **Row op**、AgentKind 等——命名必须与之一致）
- `docs/adr/0001..0004`（崩溃恢复语义 / 单一身份枚举 / crates/conversations 归属 /
  IM 密钥明文 .env）
- `docs/refactor/batch-c-e-implementation-plan.md`（C/D/E 的完整设计与步骤）
- 本会话的五个提交（分支 `refactor/arch-remediation-impl`）：
  - `a554010` 批次A 事件版本化+容错
  - `555989e` 批次B 崩溃恢复
  - `f5b5525` 批次C 消灭双投影（**最难、最需审查**）
  - `abb2ac7` 批次D1 agent_runtime 表群退役
  - `fb0dc66` docs 实施指南
- 工作树背景：仓库含大量**与本任务无关的既有未提交改动**（settings/session polish）。
  按用户指示，批次A的提交一并纳入了它们；B/C/D1 的提交是干净的按批次改动。审查时
  以 `git show <batch-commit>` 聚焦本任务改动，别把无关 WIP 算到本任务头上。

---

## 2. 两个「仅结构性论证、未运行时验证」的验收（最高优先级审查项）

前一个 Agent 无法在其环境跑通它们；请你在能运行桌面应用（`pnpm run dev`）+ 有可配置
agent 的环境里**实测**，或至少构造集成测试逼近：

### 2.1 批次C 核心验收：长回复流式中刷新页面，前后时间线一致
这是“双投影症状”的直接检验。**攻击思路**：
- 让一个 agent 产出**很长的流式文本 + 中途夹带工具调用**的回复。
- 在流式**进行到一半**时刷新页面（重新 `conversation_detail`）。
- 逐行比对刷新前（live）与刷新后（reload）的时间线：文本内容、工具卡片、顺序、
  各行是否重复/丢失。**任何不一致都是双投影残留或新 bug。**
- 特别关注：刷新瞬间 `liveText` 覆盖字段与权威行的衔接——有没有**重复文本**（upsert
  未清 liveText）或**丢字**（append 被 revision 误判跳过）。

### 2.2 批次B 核心验收：崩溃恢复
- 跑一个长 turn，**中途 `kill -9` 进程**，重启应用。断言：
  该 turn 显示为「因重启中断」；会话能正常发起新 turn；旧 pending 权限不再出现；
  对支持 `session/load` 的 agent，重连后 agent **保有会话上下文**（惰性、在下次发送时）。
- 攻击：中断的 turn 会不会被**自动重发**？（绝对禁止，ADR-0001）。恢复协调器是否
  真的**经事件日志**推进状态而非裸 UPDATE？（读 `recover_interrupted_turns`）。

---

## 3. 分批次对抗性审查清单（每条都要「构造反例或证明不可能」）

### 批次A（`a554010`）事件版本化 + 容错
- 唯一解析入口 `conversation_event_from_record` 降级为 `Unknown{kind,raw}` 是否**真的
  不再向上抛错**？`ProjectionFold::apply`、`ConversationStateApplier::apply_record`
  两条路径都覆盖了吗？构造：坏事件夹在正常事件中间，整条时间线仍能加载且坏事件为
  占位行、`last_sequence` 仍推进。
- `event_version` 是否在**写入路径**真的写了 1（读 `insert_conversation_event` 的
  bind）？还是只靠列默认值？
- ⚠️ 已知隐患：`conversation_event` 的解析并非只有一处——`events.rs`（回环解析，
  安全）与 gap 命令旧路径。批次C 已把 gap 改为按行，确认没有残留的会因坏事件炸掉
  时间线加载的解析点。

### 批次B（`555989e`）崩溃恢复
- 迁移 `20260703010000` 用**列交换法**给 `conversation_turns.status` CHECK 加
  `'interrupted'`。攻击：列交换是否保留了数据、索引、以及**引用该表的外键**
  （conversation_events.turn_id 等）？在**有存量数据**的库上跑迁移验证。
- Map 泄漏修复：`conversation_turn_locks` / `conversation_runtime_states`
  （批次C又加了 `conversation_row_projectors`）——`forget_conversation_runtime`
  是否在**所有**会话结束路径被调用？`close_conversation` 里「先 update_runtime_state
  再 forget」是否有竞态/多余？长期运行会不会仍泄漏（例如会话从不 close 的路径）？
- 权限作废走 `PermissionResponded(Cancelled)` 事件——重载投影后，被作废的权限行
  `status` 是否真的变 `responded`（批次B 补了 `PermissionResponded` 折叠）？构造重放验证。
- 惰性重连：`send_turn_to_agent` 的 `resume_external_session_id` 判定
  （无活连接 + 存在真实 acp_session_id）是否会在**正常同进程 follow-up**（活连接）时
  误触发 resume，导致对活 agent 重复 `session/load`？读 `runtime_connection_and_turn`
  的返回，构造：同会话连续两次发送，第二次不应 resume。
- 前端：中断 turn 的 `withPendingAssistantTurn` 是否被幽灵流式气泡困扰？
  （`interrupted` 是否被当终态）。

### 批次C（`f5b5525`）消灭双投影 —— **重点中的重点**
核心不变量（**必须亲自证明或证伪**）：*前端不折叠事件；初始加载、实时流、gap 回填
三条路径产出的行，均源自同一个 Rust `ProjectionFold`，故不可能漂移。*
- **有状态投影器 `IncrementalRowProjector` 的并发与顺序**：它在 `AppState` 的
  `Mutex<HashMap>` 后，被 **4 处 emit** 喂入（agent 流、start-turn 命令、chat_channel、
  web_service）。攻击：两处 emit **并发**为同一会话触发时，锁内的
  `emit_conversation_row_ops_after` 是否保证按序 apply？`after_sequence` 传错会怎样？
  `needs_load`（`last_sequence != after_sequence`）重载逻辑在 truncate/retry**回退**、
  乱序、会话首次激活时是否都正确？构造：truncate 到中途 turn 后再发送。
- **`apply` 返回 ops 的正确性**：流式文本走 early-return 只发 `AppendText`（不发整行
  Upsert，避免 O(n²)）；其余事件按 `revision == record.sequence` 收集受影响行的
  Upsert。攻击：一个事件同时触及多行时，是否**恰好**收集到全部且仅这些行？turn 的
  user 行被非文本事件反复 over-bump revision，会不会造成无谓的重复 Upsert（性能）
  或错误？
- **liveText 覆盖字段的正确性**（前端 `conversationStore.ts`）：
  - upsert 是否清空该行 liveText（否则重复文本）？append 的 revision 严格 `>` 去重
    是否会在正常流中误跳过一个 delta（丢字）？
  - 纯文本流（无工具、turn 未 settle）期间 assistant 行尚未 upsert，靠 liveText +
    pending 气泡渲染——turn settle 时的终态 Upsert 是否把 liveText 正确「冲刷」进
    权威行？构造 §2.1 的比对。
- ⚠️ **已知被简化的点（重点审查是否可接受）**：前一个 Agent **移除了基于序号的
  gap 检测**，改为「订阅时按行回填 + row op 幂等自愈」。攻击：一个 live 批次在
  **turn 中途被丢弃**（非订阅时刻，例如瞬时断连）会怎样？该批次里的工具调用 Upsert
  会不会**直到下一个非文本事件或整会话重载才出现**？这是否违反“流式中一致”的验收？
  如果是真问题，考虑：给 `ConversationRowOpBatch` 加起始序号做 gap 检测，或缩短
  回填触发条件。**给出你的判断与证据。**
- **投影器内存**：`conversation_row_projectors` 只在 `forget_conversation_runtime`
  移除。存在“会话打开后从不 close”的长命进程路径吗？会不会无界增长？
- 4 处 emit 归一后，**IM 投递仍走原始 envelope**（`notify_conversation_event`）——
  确认没有把 IM 通知也误改成 row op，且没有重复通知。
- 投影版本从 v1→v2（快照结构变更）：旧 v1 快照是否被**丢弃重建**而非反序列化炸掉？
  读 `load_fold_from_snapshot` 的版本判定。

### 批次D1（`abb2ac7`）agent_runtime 表群退役
- `agent_runtime_snapshot` 现在只取 live runtime——**agents 工作台前端**是否依赖过
  已被删的持久化数据（重启后 live runtime 为空时，工作台该显示什么）？读
  `frontend/src/features/agents/*`，构造重启后打开工作台。
- 迁移 `20260703020000`：`INSERT SELECT agent_history_imports → conversation_imports`
  用 `randomblob(16)` 造 id、source='agent_transcript'。在**有存量 history import
  数据**的库上跑，确认迁移成功且导入功能仍可用；确认 `DROP` 9 表不误伤（外键、其它
  引用）。
- 影子写入删除约 350 行——确认删的**全是** shadow-write，没有误删 conversation-event
  转发路径（`terminal_title`、`MappedConversationEventRecord`、coalescer 必须保留）。

### 审查产出
对每条：给出**结论（成立/存在缺陷）+ 证据（代码位置/复现步骤/构造的反例）**。
发现的实现 bug 直接修并补测试（分独立提交）；发现设计冲突则停下报告。

---

## 4. 后续开发：批次 D2、E（严格遵守 A→…→E 顺序，且各自独立提交）

> 详细步骤见 `docs/refactor/batch-c-e-implementation-plan.md`。以下是补充与告警。

### 批次D2 · 单一身份枚举 AgentKind（ADR-0002）—— **最大的单一改动**
- 实测规模：`AgentType` **441 处/60 文件** + `BaseCodingAgent` **63 处/14 文件** ≈
  **500 处/70 文件**。**不要试图一次性手改 500 处。**
- **serde 敏感性（第一性原则核心）**：AgentKind 必须采用 DB **既有持久化的 snake_case
  键**（`claude_code` 等，见 `registry.rs:executor_key_for`）以实现**零数据迁移**。
  **先做的第一件事**：搞清楚 `agents::AgentType` 与 `executors::BaseCodingAgent`
  **各自当前的 serde 表示**（分别序列化成什么字符串？写进 DB 的哪些列？）。只有当
  你确认了这一点，才能决定别名过渡是否零风险。
- 推荐的**分步、可编译中间态**（每步都能 `cargo check` 通过、可提交）：
  1. 在 `crates/api-types` 新增 `AgentKind`（7 agent + QaMock 常驻第 8 变体；serde
     snake_case；反序列化对历史杂拼写 SCREAMING/Pascal 宽容，见
     `agent_type_from_executor_key`）。**加类型互转测试覆盖每个既有键与杂拼写。**
  2. 令 `AgentType`、`BaseCodingAgent` 成为 `AgentKind` 的 `type` 别名（或 re-export），
     使 500 处调用点不动即编译通过。**此时立刻用 §3 的手法验证 serde 表示未变**
     （对每个变体，序列化结果与改前逐字节相同；旧库能打开）——这是本批次**最大风险**。
  3. 逐 crate 把别名替换为 `AgentKind`（机械搬迁，与行为无关，可单独提交）。
  4. 删除六处字符串 match 桥接函数（`agent_type_from_executor_key`/`executor_key_for`
     等）；`registry_id`（`claude-acp`）是条目元数据，**保留**，不参与统一。
  5. 清空 `crates/api-types` 零引用死模块（先 `grep` 证明零引用）：issue*、
     notification、pull_request、user、project_status。
  6. `pnpm run generate-types`（删除类型进 `removed_declarations()` 墓碑；新类型
     `insert_declaration`）；同步前端对 AgentType 的引用。
- 验收：`grep -rn "BaseCodingAgent\|AgentType\b" crates/ src-tauri/` 只剩 alias 或
  零命中；**旧库（含杂拼写 agent 键的 sessions 行）能正常打开**（亲自拿一个旧库验证）；
  `generate-types:check`、`prepare-db:check` 通过。
- D1 已铺路的事实：`agent_runtime_snapshot` 取自 live runtime（无表依赖）、
  `AgentRuntime::default()` 用 NoopEventSink——D2 不必再碰这些。

### 批次E · 命令层下沉
- 新建 `crates/conversations`（依赖 agents + db）：迁入 `conversation_service.rs`
  全部编排 + 批次B 的恢复协调器 + 从 `crates/db` 搬入投影折叠/快照
  （`conversation_projection.rs`，含批次C 新增的 `IncrementalRowProjector`）。
  搬完后**删除 `crates/db` 对 `agents` 的依赖**——`crates/db/Cargo.toml` 不含
  `agents` 是本批次**硬验收**。
- `agent_skills.rs`（1242 行）逻辑迁入 `crates/agents/src/skills.rs`，命令层留薄委派。
- `chat_channel.rs`（1642 行；注意批次C 已在其中加了 row-op emit 调用）逻辑并入
  `crates/services::chat_delivery`；IM 密钥迁 `~/.vibex/.env`（明文、权限 0600、
  **只收 IM 渠道密钥**；迁移时读旧 JSON 写入 .env 后删旧文件）。ADR-0004 有意明文，
  **不要改成钥匙串**。
- 薄命令层标杆：`commands/model_provider.rs`（78 行纯委派）。
- 验收：`crates/db/Cargo.toml` 不含 `agents`；三命令文件只剩薄委派；全量门槛通过。

---

## 5. 全局纪律（与原任务一致，不可违背）

- 每完成一个批次（或子批次 D1/D2）跑全量：
  `pnpm run check && pnpm run lint && cargo test --workspace && pnpm --filter ./frontend test`
  以及 `pnpm run generate-types:check`、`pnpm run prepare-db:check`（改过 sqlx 宏/迁移
  必须先 `pnpm run prepare-db`）。
- **绝不提交破损树**：working tree 可以是 WIP，但**任何提交都必须编译+过门槛**。
  D2 的 500 处改动务必用 §4 的可编译中间态分步提交，切勿留 70 文件半转换的破损提交。
- 提交粒度：每批次≥1 提交；批次内**行为变化与机械搬迁分开**提交；审查修复独立提交。
- 命名对齐 `CONTEXT.md`；出现词汇表未覆盖的新概念就更新 `CONTEXT.md` 并在交付说明指出。
- 被 ADR 明确否决过的「顺手优化」一律不做（事件 upcasting 注册表、.env 换钥匙串、
  启动时急切重连、复用 legacy RFC-6902 ConversationPatch）。
- 诚实汇报：跑失败就贴输出说失败；跳过的步骤明说；只有亲自验证通过才说“已验证”。
  区分“单测/编译通过”与“运行时验收通过”。
