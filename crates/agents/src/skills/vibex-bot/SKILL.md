---
name: vibex-bot
description: 在 BotSpace（person2bot）或 GroupSpace（person2group）中作为 Bot 协作：隐式发言、@BotName 寻址、[PASS] 弃权、负责人调度与成员接力、跨 Space 发信、管理 Bot 与 Group、向 Person 提问或审批、读写三层记忆与主题/收藏索引（MEMORY.md / topics / collection）、一次性委派。当被 Space 隐藏 Session 唤醒、收到 [Message from …] 或 [Group chat …]、含 [成员记忆] 索引指针、Person 点名其它 Bot、需要多轮协同，或消息含 vibex://conversation / vibex://agent 时使用。
---

# VibeX Bot

这些工具来自宿主的 Bot 协同能力。调用前以当前会话的 MCP 工具清单为准；参数以清单里的 schema 为准。没有对应工具时直接说明原因，不要假装已完成发信、建群或委派，也不要 grep 仓库或用 `search_tool` 搜索本技能中的已知工具。

核心对象只有三个：**Person**（人类用户）、**Bot**（智能体身份）、**Group**（多 Bot 群组）。交互空间只有两种：**BotSpace**（`person2bot` 一对一）和 **GroupSpace**（`person2group` 群聊）。每个 Bot 在每个它参与的 Space 中拥有一条独立的隐藏 Session。

Bot 身份按权限分为三级：**主管（总管）**（工作区唯一全局管理者，默认 `Master`，位于左侧列表顶部主管位，不可被删除）、**群负责人（Group Lead）**（单群内组织与汇总者）、**普通 Bot**（领域执行者）。怎么说话、三种回合、主管与负责人调度、何时发信、成员怎么交接：见 [`SPACE-RULES.md`](SPACE-RULES.md)，按第 3 节分节加载。

## 1. 识别当前 Space

| Space | 识别 | 发言 |
|---|---|---|
| **BotSpace** | `person2bot`，或 `space_id` 为 `direct:<bot_id>` | 写出的普通文本发给 Person |
| **GroupSpace** | `person2group`，或 `space_id` 为 Group UUID | 写出的普通文本发到本群；`@BotName` 才会唤醒同伴 |

被唤醒时，**本 Space 里要说的话直接写**，不要为本条回复调用发信工具。

## 2. 工具速查

协作空间工具：

| 意图 | 工具 | 何时调用 / 最少参数 |
|---|---|---|
| 查看本工作区的 BotSpace / GroupSpace | `list_spaces` | 开口、派活、核对叫醒前看。可传 `space_id` 看详情。含主管（`supervisor_nickname` / `is_caller_supervisor`）、负责人、每位成员的 `is_supervisor` 与 `activity`（`working` / `waiting_for_person` / `waiting_for_bot` / `idle`，`waiting_for` 是在等谁） |
| 回看当前 GroupSpace 更早历史 | `read_space_messages` | `space_id`，可选 `since_seq`、`limit`。单次读取。GroupSpace 信封已自带 `[上次发言后的群内新消息]`（含本轮前序 Bot 发言），**不要**为查看刚发的群消息而调用本工具，也**不要**输出「我先看一下群里的最新消息」；仅在信封提示更早消息已折叠或需翻查更早历史时调用。BotSpace 历史已在当前会话里 |
| 跨 Space 联系、延时投递 | `post_space_message` | 本 Space 的话直接写。只用于其他 BotSpace / GroupSpace，或 `delay_seconds`。必填当前 `space_id` 与 `content`；`to` 一个 Bot 名或群名。叫醒、日志回执与回读见 [`SPACE-RULES.md`](SPACE-RULES.md)「跨 Space」 |
| 创建 / 更新 / 删除 / 打断 Bot | `manage_bot` | `action`: `create` / `update` / `delete` / `interrupt`。**权限**：`create`（创建前先 `list_spaces` 防重）、`delete`（不可删除主管）、修改其他 Bot 或变更 `persona_prompt` / `mode_id` / `agent_id` **仅限主管（总管）调用**；普通 Bot 仅能 `update` 自身昵称。`create` 必填 `nickname`（传入当前 Group 的 `space_id` 会同时入群）。`update` / `delete` / `interrupt` 填 `space_id`；`delete` / `interrupt` 再填 `bot_id` 或昵称。`delete` 先 `request_approval`。`interrupt` 只在同群对方必须立刻停下时用（主管可跨群打断） |
| 创建 / 更新 / 删除 Group，加人、移出、退出、指定负责人 | `manage_group` | `action`: `create` / `rename` / `delete` / `add_bot` / `remove_bot` / `leave` / `set_lead`。**权限**：`create` / `delete` **仅限主管（总管）调用**；`rename` / `add_bot` / `remove_bot` / `set_lead` **仅限主管或本群负责人调用**；普通成员仅可 `leave`。`create` / `rename` 必填 `name`。除 `create` 外必填 `space_id`。`add_bot` / `remove_bot` / `set_lead` 再填 `bot_id` 或昵称。`delete` 先 `request_approval`（清消息与共享目录，Bot 身份与 BotSpace 保留） |
| 向 Person 发起阻塞选择题 | `ask_user_question` | 必填 `questions`（1–4 条）。每条含 `question`、`header`（≤12 字）、`multiSelect`、`options`（2–4 项，每项 `label` + `description`）。推荐项把 `(Recommended)` 写进 label。问题出现在当前 Space，等到作答才返回。先把要说的话写完再调用 |
| 高危操作前向 Person 申请审批 | `request_approval` | 必填 `space_id`、`action`；可选 `command`、`reason`。等到允许后再执行。无 `operation_id` |
| 检索长期记忆或深读主题文档 | `memory_search` | 必填 `query`（按 `topic` 读全文时可传 `""`）；可选 `topic`（读取 `[成员记忆]` 中 `[[topic:<slug>]]` 完整文档）、`limit`（1–50，默认 8）。用于跨回合/跨 Space 召回事实、近期活动与收藏索引。详见 [`MEMORY.md`](MEMORY.md) |
| 写入、更新或移除记忆与主题 | `memory_write` | 必填 `content`；可选 `scope`（`thread` \| `global` \| `private`，**BotSpace 记忆强制 `private`**）、`op`（`add` \| `replace` \| `remove`）、`fact_id`（`replace`/`remove` 时传 `#id`）、`topic`（写入/删除 `topics/<topic>.md`）、`title`（主题标题）。遇到 Person 偏好、项目约定、已拍板决策或纠偏时**主动写入**；旧事实过时用 `replace` 原位更新；严禁写入密钥/凭证。详见 [`MEMORY.md`](MEMORY.md) |

会话与一次性委派（不是 Space 发言）：

| 意图 | 工具 | 何时调用 / 最少参数 |
|---|---|---|
| 会话外一次性子代理 | `delegate_to_agent` | 短小、自包含、不需要 Space 可见的后台子任务。必填 `agent_type`、`task`（冷启动，写全背景与绝对路径）。立刻返回 `task_id` |
| 收集或取消委派 | `get_delegation_status`、`cancel_delegation` | `get_delegation_status` 必填 `task_ids`，可用 `wait_ms` 等到终态。`cancel_delegation` 必填 `task_id`。这是委派收口，不是协作主循环 |
| 用户点名的过往会话 | `get_session_info`、`list_conversations` | 消息里出现 `vibex://conversation/<uuid>` 时，`get_session_info` 传该 `conversation_id`。只读 |
| 新建一等会话 | `create_conversation` | 工作区里一条持久 Conversation，不是 Bot，也不是 `delegate_to_agent` |
| 向指定 Conversation 注入指令 | `send_session_input` | 只在用户明确要往某条 Conversation 塞输入时用。Space 里说话用隐式文本或 `post_space_message` |

向同伴交接工作：在 GroupSpace 回复中 `@目标Bot`。格式与空节判定见 [`SPACE-RULES.md`](SPACE-RULES.md)「任务交接」。

## 3. 按场景加载

读信封头，只加载当前回合用得到的节：

- **每种回合**：[`SPACE-RULES.md`](SPACE-RULES.md) 一（口吻）、二（三种回合，对应当前信封）
- **GroupSpace，或要 `@` 同伴 / `[PASS]`**：三、四
- **跨 Space 或 `delay_seconds`**：五（叫醒、日志回执、回读）
- **把活交给同伴**：六
- **必须立刻停掉同群 Bot**：七
- **长文、契约、截图与共享收藏**：八
- **对 Person 说话，或引用同伴结论**：九
- **要 Person 拍板，或删除 Bot / Group**：十
- **解读 `[成员记忆]`（含 `[[topic:...]]` / `[[collection:...]]` 索引）、跨 Space 回忆、主动记住偏好/约定/决策、或调用 `memory_search` / `memory_write`**：[`MEMORY.md`](MEMORY.md)
