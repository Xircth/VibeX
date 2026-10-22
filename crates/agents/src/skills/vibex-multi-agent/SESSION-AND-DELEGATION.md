# 一等会话、角色与委派规范（Session & Delegation Guide）

VibeX 采用**自由协同与一等会话（First-Class Conversation）**模型：工作区内的所有会话——无论是用户直接创建的会话、基于自定义角色创建的会话、协作空间中的成员会话，还是通过委派产生的会话——都是一等公民，均支持多轮续聊、随时拉入协作空间或由用户直接接管对话。

---

## 一、三种协同机制的边界与选型

| 维度 | 协作空间群组协同 (`post_to_space`) | 一等会话点对点 (`create_conversation` + `send_session_input`) | 一次性子任务委派 (`delegate_to_agent`) |
|---|---|---|---|
| **可见性与形态** | 群组共享消息流，用户与空间内成员可见 | 独立持久化会话，留在工作区会话列表中 | 围绕单个独立子任务的后台会话 |
| **生命周期** | 随空间与成员长期存在，支持多方多轮配合 | 父会话退出不会取消它，可随时多轮追加指令 | 第一个 Turn 到达终态即完成本次委派；父会话退出会取消仍在运行的委派 |
| **适用场景** | 多角色分工协作、上下游交接、向用户阶段性应答与交付 | 创建具备特定角色人格（`role_id`）的专家会话并多轮指派任务 | 短小、自包含、只需拿回一份独立调研/改动摘要的子任务 |

---

## 二、创建与复用一等会话（`create_conversation` / `list_roles`）

1. **优先复用已有会话**
   - 在新建会话前，可先调用 `list_conversations`（查看本工作区会话元数据）或 `list_collaboration_spaces` / `list_space_members`（查看空间内已有成员），若有职责匹配的现成会话，直接通过 `post_to_space` 或 `send_session_input` 协作，避免无节制地重复创建新会话。

2. **基于角色或指定 Agent 创建**
   - 调用 `list_roles` 查看用户在「设置 → 常规 → MultiAgent协同 → 自定义角色」中配置的角色模板。
   - 调用 `create_conversation`：
     - 传入 `role_id`：直接快照该角色预设的 Agent、会话配置与人设提示词（`persona_prompt`）。
     - 仅传入 `agent_id`：创建该 Agent 的标准一等会话，使用宿主中为该 Agent 配置的默认委派配置。
   - 创建后若需将其纳入群组协同，可调用 `add_space_member` 将该 `conversation_id` 加入目标协作空间。

---

## 三、点对点会话输入（`send_session_input`）

1. **异步非阻塞投递**
   - `send_session_input` 立即返回投递状态（`dispatched`、`queued` 或 `scheduled`）。调用后继续推进你自己的工作，不要在原地死等。
   - 若确实需要等待目标会话当前轮次完成后再做汇总，调用 `wait_for_session`（传入 `conversation_id` 与合理的 `wait_ms`）。

2. **插话引导（`steer`）与延时投递（`delay_seconds`）**
   - **默认排队/直发**：不传 `steer` 时，若目标会话空闲则立即启动新 Turn，若正忙则进入其输入队列。
   - **在途插话（`steer: true`）**：仅当你明确需要修正目标会话**当前正在执行的那一轮 Turn** 时，才传 `steer: true` 并附带 `expected_turn_id`。若目标不支持 steer 或该 Turn 已结束，调用会返回明确错误且不会误入普通队列；此时先用 `get_session_info` 确认最新状态，不要盲目重发同一句指令。
   - **延时投递**：传入 `delay_seconds`（正整数）或 `deliver_at`（RFC3339 时间）可安排定时唤醒投递；到期前不占用普通输入队列。

---

## 四、按需查询会话上下文（`list_conversations` / `get_session_info`）

1. **两步精准查询**
   - `list_conversations` 仅返回会话 ID、标题、Agent、状态、更新时间等轻量元数据，不包含消息正文。
   - **禁止遍历调用**：绝不要对 `list_conversations` 返回的列表逐条调用 `get_session_info`。仅针对用户通过 `[会话标题](vibex://conversation/<uuid>)` 明确引用、或你在当前任务中确实需要读取其上下文的那一个 `conversation_id` 调用 `get_session_info`。

---

## 五、一次性委派（`delegate_to_agent`）

1. **识别显式委派意图**
   - 当用户消息中包含 `[&AgentName](vibex://agent/<agent_type>)` 时，代表用户要求你将对应工作委派给该 `<agent_type>`（稳定 ID 如 `claude_code`、`codex`、`opencode`、`antigravity`、`openclaw`、`cline`、`hermes`、`codebuddy`、`kimi_code`、`pi`、`grok`、`cursor`、`deepseek_harness`、`qoder`）。

2. **任务描述必须自包含**
   - 被委派会话看不到你当前的对话历史。`task` 参数必须完整写明：背景与目标、相关文件的绝对路径、约束条件，以及期望交回的结果格式。

3. **收集结果**
   - `delegate_to_agent` 立即返回 `task_id`（可并行发起多个委派）。
   - 在向用户汇总前，调用 `get_delegation_status`（传入 `task_ids` 数组并设置 `wait_ms`）阻塞等待或获取已完成的结果；等待期间不要向用户输出中间轮询废话。
