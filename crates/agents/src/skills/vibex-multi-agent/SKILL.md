---
name: vibex-multi-agent
description: 在同一工作区开展协作空间群组协同、跨成员分工与向用户汇报，或查询会话、创建角色/一等会话、向已有会话投递输入、发起一次性委派。当收到 [协作空间消息]、拥有 [协作空间成员身份]、用户点名其它 Agent/成员、需要多轮协同，或消息中出现 vibex://conversation 与 vibex://agent 时使用。
---

# 多智能体协同（VibeX Multi-Agent）

这些工具来自宿主的 MultiAgent 协同能力。调用前以当前会话的 MCP 工具清单为准；没有对应工具时直接说明原因，不要假装已完成委派、建房或发消息，也不要 grep 仓库或用 `search_tool` 搜索本技能中的已知工具定义。

## 1. 协同模式与工具路由

| 协同场景 | 选用工具 | 详细规范 |
|---|---|---|
| 查看本工作区协作空间、自己所在空间与昵称 | `list_collaboration_spaces` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 查看指定协作空间内的全部成员、角色摘要与在线状态 | `list_space_members` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 在协作空间向 `@User` 应答/汇报，或向 `@成员昵称` 分工/交接 | `post_to_space` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 创建协作空间、拉入成员、修改自己在空间内的昵称 | `create_collaboration_space`、`add_space_member`、`set_space_identity` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 按需回看协作空间历史消息（单次读取，非阻塞轮询） | `list_space_messages` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 创建持久化一等会话，或基于自定义角色创建会话 | `list_roles`、`create_conversation` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 查看工作区近期会话列表或读取指定会话详情 | `list_conversations`、`get_session_info` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 向已有会话点对点发送指令、插话（steer）或延时投递 | `send_session_input`、`wait_for_session`、`cancel_session_turn` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 短小、自包含、无需群组可见的一次性后台子任务 | `delegate_to_agent`、`get_delegation_status`、`cancel_delegation` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |

## 2. 按场景加载专项规范

- **当你在协作空间中工作**（上下文含 `[协作空间成员身份]`、收到 `[协作空间消息]`，或需调用 `post_to_space` 等空间工具时）：**必须阅读并遵循 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md)**。
- **当你需要创建一等会话、使用角色模板、点对点发 `send_session_input` 或执行 `delegate_to_agent` 时**：**阅读并遵循 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md)**。

## 3. 协作空间四大核心纪律（必守）

在协作空间内收发消息时，所有成员无论扮演何种角色，均须严格执行以下四条准则：

1. **收到用户消息：先应答，后执行，再按需汇报（Ack-Then-Execute）**
   - 当收到来自 `User` 的任务或提问，且需要调用工具（读文件、搜代码、跑命令、查网页）或找其他成员协作时，**必须在开展耗时工作之前，第一时间先调用一次 `post_to_space`（`to: ["User"]`，`content` 以 `@User ` 开头）向用户发送简短接单回复**（1~2 句话说明“已收到 + 接下来的处理计划或分工”），避免用户长时间面对空白等待。
   - 发出首条应答后，继续在当前回合内推进工作；后续根据实际情况，自主向 `@其他成员` 发起协作，或在完成工作/遇到需用户决策的分叉点时再次通过 `post_to_space` 向 `@User` 同步进展与最终结果。
   - 仅当用户的消息无需任何工具调用、可在一句话内直接给出完整答案时，才合并为单条消息直接回复。

2. **成员间交互：有增量才发信，无需回复即静默终止（Silent Closure）**
   - 每次调用 `post_to_space` 必须携带**推进工作的实质增量**（派发新任务、回答具体问题、交付产出物、同步关键变更或阻塞求助）。
   - **当无需再回复时立即停止**：若收到的消息仅是确认或礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”、“没问题”），或对方已就你的问题给出闭环确认且不需要你提供新信息、做新决策或执行新动作，**直接结束当前回合，严禁再调用 `post_to_space` 回复“好的 / 收到 / 不客气”**，杜绝成员间无意义的来回刷屏。
   - 向其他成员布置任务或同步信息时，一次写清背景、边界与预期产出，**不要附加“收到请回复”**等纯确认要求。

3. **受众信息隔离：对用户隐藏系统内部参数（Audience Filtering）**
   - **发给用户（`@User`）的消息**：使用面向人类用户的自然业务与技术语言。**严禁在发给用户的正文中包含用户不可达的系统内部标识或协议字段**，包括 `space_id`、`conversation_id`、`member_id`、`operation_id`、`message_id`、`task_id`、`delayed_input_id`、`turn_id`、`expected_turn_id`、`seq`、`vibex://...` 等。介绍自己或同空间成员时，只说昵称、职责与可提供的帮助。
   - **发给其他成员（`@成员昵称`）的消息**：优先用成员昵称、文件路径与模块接口沟通；**仅当对方确实需要调用 `get_session_info`、`send_session_input` 等底层跨会话工具时**，才在发给该成员的消息中按需附带 `conversation_id`、`delayed_input_id` 等参数。

4. **群组式分工协同：主责清晰、上下游交接明确（Group Ownership）**
   - **精准点名**：协作任务必须明确 `to: ["成员昵称"]` 并在正文开头写 `@成员昵称 `，避免全员广播导致无人认领或多人重复劳动。
   - **牵头与交接**：多成员协作同一需求时，由被用户点名的牵头成员拆解任务并分派，上下游交接时一条消息交代清楚「已完成结论/改动路径 + 需对方接手的具体事项 + 完成后向谁反馈」。

## 4. 常见异常处理

- **缺少协同工具**：提示用户前往「设置 → 常规 → MultiAgent协同」开启开关，并新开或重新进入会话。
- **成员昵称不存在（`unknown_recipient`）**：先调用 `list_space_members` 获取空间最新成员昵称列表，使用最新昵称重发，不要猜测旧昵称。
- **幂等重试**：同一次写操作重试时复用相同的 `operation_id`；发送一条全新的空间消息（例如先向 `@User` 应答完、稍后再向 `@User` 汇报最终成果）必须生成新的 `operation_id`。
