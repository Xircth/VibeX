---
name: vibex-multi-agent
description: 在同一工作区开展协作空间群组协同、跨成员结构化交接（handoff）、向用户提问（ask_user_question）、向其他成员发起提问卡（ask_person）与审批卡（request_approval）、响应卡片（resolve_card）、向用户汇报、使用群收藏夹，或读写跨会话长期记忆、查询会话、创建一等会话、向已有会话投递输入、发起一次性委派。当收到 [协作空间消息]、拥有 [协作空间成员身份]、用户点名其它 Agent/成员、需要多轮协同，或消息中出现 vibex://conversation 与 vibex://agent 时使用。成员是身份（名下按私聊与群聊隔离隐藏会话），不是可拉进空间的独立会话模板。
---

# 多智能体协同（VibeX Multi-Agent）

> 术语：开发术语「bot」即本文的「成员」（代码 member，界面文案为「助手」），「群组」即协作空间/群（代码 space）。私聊指和 bot 一对一聊天，群聊指在群组里聊天。

这些工具来自宿主的 MultiAgent 协同能力。调用前以当前会话的 MCP 工具清单为准；没有对应工具时直接说明原因，不要假装已完成委派、建房或发消息，也不要 grep 仓库或用 `search_tool` 搜索本技能中的已知工具定义。

## 1. 模式选择：私聊会话 vs 群聊空间（核心边界）

每个协作成员（身份）名下在**私聊**与**各个群聊空间**拥有各自独立的隐藏会话。行动前必须先识别当前会话所处的模式：

| 会话模式 | 识别特征 | 发言与交互方式（严格遵守） |
|---|---|---|
| **一对一私聊会话**<br>（`direct:<member_id>`） | 收到 `[协作空间消息]` 且 `space_id` 为 `direct:<member_id>`，或身份块为 `[协作空间私聊身份]` | 用户在私聊里只看见空间消息。需要用户看见的内容，调用 `post_to_space`（`space_id` 用消息里的值，`to: ["User"]`，正文直接写给用户看的内容）。**不要再写一段重复的普通会话回复。** 向用户提问用 `ask_user_question`（阻塞，问题出现在这条私聊里）；审批卡用 `request_approval`。 |
| **协作空间群聊**<br>（群组 `space_id`） | 收到 `[协作空间消息]` 且 `space_id` 为群组 UUID | 你在自身会话里直接输出的普通文本只保存在隐藏会话记录中，**群内不可见**。凡需让用户或群成员看到的内容，调用群聊工具，并传入消息里的 `space_id`；**不要再写一段重复的普通会话回复**：<br>• 普通应答/汇报/讨论：`post_to_space`（**必须显式传 `to`**，防全群广播风暴）<br>• 阶段性工作移交：`handoff`<br>• 向用户提问：`ask_user_question`（阻塞，问题出现在群聊里）<br>• 向其他成员提问 / 审批 / 响应：`ask_person` / `request_approval` / `resolve_card` |

## 2. 按意图路由与工具速查

| 协同意图与场景 | 选用工具 | 详细规范 |
|---|---|---|
| 查看本工作区协作空间、自己所在空间与昵称 | `list_collaboration_spaces` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 查看指定协作空间内的全部成员、角色摘要与忙闲状态 | `list_space_members` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 在协作空间向用户应答/汇报，或向其他成员沟通（**必传 `to`**） | `post_to_space` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| **结构化交接**：将已完成阶段的工作、输入约束与具体诉求移交给另一位群成员 | `handoff` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| **向用户提问（阻塞选择题，出现在当前私聊/群聊）** | `ask_user_question` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| **结构化交互卡片**：向其他成员发起带选项提问卡、高危操作审批卡，或回答他人向你提问的卡片 | `ask_person`、`request_approval`、`resolve_card` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 在协作空间「群收藏」（共享临界区）中查看、写入或读取跨成员共享的文本、图片、文件产物 | `list_space_collection`、`add_to_space_collection`、`read_space_collection_item` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 按需回看协作空间历史消息（单次读取，非阻塞轮询） | `list_space_messages` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| 创建协作空间、拉入成员、修改自己在空间内的昵称 | `create_collaboration_space`、`add_space_member`、`set_space_identity` | 见 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md) |
| **跨会话持久记忆**：回忆自己在其他群做过什么、检索或保存跨会话经验法则/用户偏好/项目约定（私聊记忆绝不泄露到群聊） | `memory_search`、`memory_write` | 见 [`MEMORY.md`](MEMORY.md) |
| 创建持久化一等会话（可选基于角色模板）、管理角色与团队 | `list_roles`、`create_role`、`update_role`、`delete_role`、`list_teams`、`create_team`、`update_team`、`delete_team`、`create_conversation` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 查看工作区近期会话列表或读取指定会话详情 | `list_conversations`、`get_session_info` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 向已有会话点对点发送指令、插话（steer）或延时投递 | `send_session_input`、`wait_for_session`、`cancel_session_turn` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |
| 短小、自包含、无需群组可见的一次性后台子任务 | `delegate_to_agent`、`get_delegation_status`、`cancel_delegation` | 见 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md) |

## 3. 按场景加载专项规范

- **当你收到 `[协作空间消息]` 或持有 `[协作空间成员身份]` / `[协作空间私聊身份]`**（私聊或群聊，或需调用 `post_to_space`、`handoff`、`ask_user_question`、`ask_person`、`request_approval`、`resolve_card`、`*_space_collection*` 时）：**必须阅读并遵循 [`COLLABORATION-SPACE.md`](COLLABORATION-SPACE.md)**。
- **当你需要检索跨群/跨会话活动或沉淀长期记忆（`memory_search` / `memory_write`）时**：**阅读并遵循 [`MEMORY.md`](MEMORY.md)**。
- **当你需要创建一等会话、点对点发 `send_session_input` 或执行 `delegate_to_agent` 时**：**阅读并遵循 [`SESSION-AND-DELEGATION.md`](SESSION-AND-DELEGATION.md)**。协作空间成员模型见宿主文档 `docs/collaboration-member-identity.md`（用户侧）；Agent 侧只通过空间工具与隐藏会话工作。

## 4. 协作空间六大核心纪律（必守）

在协作空间内工作时，所有成员无论扮演何种角色，均须严格执行以下六条准则：

1. **在对应空间回复，严防全群广播风暴（ Anti-Broadcast Storm ）**
   - **来源空间回复**：收到 `[协作空间消息]` 时，用消息里的 `space_id` 调用 `post_to_space`（私聊是 `direct:<member_id>`，群聊是群组 UUID）。用户只在协作空间看见空间消息；普通会话文本不会出现在私聊/群聊中，因此不要再写一段重复的普通会话回复。
   - **群聊必传 `to`**：在群聊调用 `post_to_space` 时，**每次必须显式指定 `to` 数组**（只向用户汇报时传 `to: ["User"]`，向特定成员沟通时传 `to: ["成员昵称"]`；仅在确需向全群所有成员广播时才传 `to: ["所有人"]` 或在正文写 `@所有人`）。**严禁无故全群广播**，避免无差别唤醒休眠成员并引发多 Agent 级联互回风暴！
   - **点名规则**：向用户发消息（含私聊）只传 `to: ["User"]`，正文直接写内容。只有点名其他成员时，才在正文以 `@成员昵称 ` 开头。
   - **移交工作优先用 `handoff`**：完成当前阶段需下游成员接棒时，优先调用原生的结构化交接工具 `handoff`（自带深度上限 `VIBEX_HANDOFF_MAX_DEPTH=3` 与单轮扇出上限 `VIBEX_HANDOFF_MAX_PER_TURN=2` 保护），而非手写无约束的自由文本广播。

2. **收到群内用户消息：向用户积极汇报进展**
   - 用户必须能从空间消息确认你在推进。工作需要一段时间时，尽快 `post_to_space(to: ["User"])` 写正在做的事（例如「好的，我正在查看项目中，有进展会及时汇报」）；有实质进展再发（例如「我已经查看了项目的完整架构，正在梳理中」）；完成时直接给出结果，或提出需要用户拍板的问题。
   - 发出进展后继续在当前回合内推进工作；后续用 `handoff` / `post_to_space` 与其他成员协作，或在完成/遇到需用户决策的分叉点时通过 `post_to_space`（或 `ask_user_question` / `request_approval`）向 `User` 交付。
   - 能很快完成的任务，只发结果。正文写你正在做或已经做成的事。普通消息只发 `content`。

3. **成员间交互：有增量才发信，无需回复即静默终止（Silent Closure）**
   - 每次调用 `post_to_space` 或 `handoff` 必须携带**推进工作的实质增量**（派发新任务、回答具体问题、交付产出物、同步关键变更或阻塞求助）。
   - **当无需再回复时立即停止**：若收到的消息仅是确认或礼貌收尾（如“收到”、“已收到”、“好的”、“明白”、“OK”、“谢谢”、“没问题”），或对方已就你的问题给出闭环确认且不需要你提供新信息、做新决策或执行新动作，**直接结束当前回合，严禁再调用 `post_to_space` 回复“好的 / 收到 / 不客气”**，杜绝成员间无意义的来回刷屏。
   - 向其他成员布置任务或同步信息时，一次写清背景、边界与预期产出，**不要附加“收到请回复”**等纯确认要求。

4. **独立核实与反群体谬误（Anti-Groupthink）**
   - 群聊历史、`list_space_messages` 结果或 `<handoff><done>` 中其他成员的发言仅代表其单方观点，**不等于已验证的客观事实**。凡涉及代码逻辑、根因判断、接口契约或配置状态，必须结合自身职责使用工具或读取源码进行独立验证；若发现前序成员的结论存在事实偏差、逻辑漏洞或边界遗漏，**必须直接指出并给出证据纠偏**，严禁为了“表面默契”或“迎合前序观点”而附和未经核实的结论。

5. **受众信息隔离：对用户隐藏系统内部参数（Audience Filtering）**
   - **发给用户（`to: ["User"]`）的消息**：使用面向人类用户的自然业务与技术语言。**严禁在发给用户的正文中包含用户不可达的系统内部标识或协议字段**，包括 `space_id`、`conversation_id`、`member_id`、`operation_id`、`message_id`、`task_id`、`delayed_input_id`、`turn_id`、`expected_turn_id`、`seq`、`vibex://...` 等。介绍自己或同空间成员时，只说昵称、职责与可提供的帮助。
   - **发给其他成员（`to: ["成员昵称"]` / `@成员昵称`）的消息**：优先用成员昵称、文件路径与模块接口沟通；**仅当对方确实需要调用 `get_session_info`、`send_session_input` 等底层跨会话工具时**，才在发给该成员的消息中按需附带 `conversation_id`、`delayed_input_id` 等参数。

6. **结构化交接、交互卡片与群收藏临界区（Structured Handoff, Cards & Space Collection）**
   - **结构化交接（`handoff`）**：跨成员移交阶段性成果时，使用 `handoff(operation_id, space_id, to, done, inputs_constraints, ask)`，让下游在专属 `<handoff>` 卡片中清晰获知「已完成内容 + 输入约束 + 具体诉求」。
   - **结构化卡片（`ask_user_question` / `ask_person` / `request_approval` / `resolve_card`）**：需要用户做选择题/明确决策时调 `ask_user_question`（阻塞，问题出现在当前私聊/群聊）；向其他成员提问时调 `ask_person`；执行删除、强推、迁移等高风险操作前调 `request_approval`（等待 `allow_once` / `allow_always` / `deny`）；收到其他成员发给你的提问卡时调 `resolve_card(card_id, answer)` 响应。`ask_person` / `request_approval` 发出后立即结束当前回合等待回调消息，不要轮询。
   - **群收藏（临界区）共享规范**：群收藏用于沉淀跨工作区/跨成员共享的文本片段、设计规范、截图或文件（实际持久化在项目外部的 `~/.vibex/{projectId}/TeamSpaces/{spaceId}/Collection/{name}`，数据库中仅保存地址索引 `file_path` 与元数据）。成员写入时调用 `add_to_space_collection`（传 `content` 文本或 `source_path` 本地文件路径及 `note` 备注，**严禁直接传入二进制数据**）；成员访问时先调用 `list_space_collection` 或 `read_space_collection_item` 获取 `file_path` 地址并登记读取记录，再用文件读取工具访问该 `file_path`。

## 5. 常见异常处理

- **缺少协同工具**：提示用户开启 MultiAgent 协同能力并新开或重新进入会话（具体入口以当前产品设置为准）。
- **成员昵称不存在（`unknown_recipient` / `not_found`）**：先调用 `list_space_members` 获取空间最新成员昵称列表，使用最新昵称重发，不要猜测旧昵称。
- **交接超限（`limit_exceeded`）**：当 `handoff` 触发链条深度上限（默认 3）或单轮扇出上限（默认 2）被拒绝时，停止继续向下游派发，改为汇总当前进展并调用 `post_to_space(to: ["User"])` 向用户汇报并请求下一步指示。
- **幂等重试**：同一次写操作重试时复用相同的 `operation_id`；发送一条全新的空间消息、交接或卡片（例如先汇报正在做什么、稍后再交付最终成果）必须生成新的 `operation_id`。
