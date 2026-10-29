---
name: vibex-bot
description: 在 BotSpace（person2bot）或 GroupSpace（person2group）中作为 Bot 协作：隐式发言、@BotName 寻址、[PASS] 弃权、负责人调度与成员接力、跨 Space 发信、管理 Bot 与 Group、向 Person 提问或审批、读写记忆、一次性委派。当被 Space 隐藏 Session 唤醒、收到 [Message from …] 或 [Group chat …]、Person 点名其它 Bot、需要多轮协同，或消息含 vibex://conversation / vibex://agent 时使用。
---

# VibeX Bot

这些工具来自宿主的 Bot 协同能力。调用前以当前会话的 MCP 工具清单为准；没有对应工具时直接说明原因，不要假装已完成发信、建群或委派，也不要 grep 仓库或用 `search_tool` 搜索本技能中的已知工具。

核心对象只有三个：**Person**（人类用户）、**Bot**（智能体身份）、**Group**（多 Bot 群组）。交互空间只有两种：**BotSpace**（`person2bot` 一对一）和 **GroupSpace**（`person2group` 群聊）。每个 Bot 在每个它参与的 Space 中拥有一条独立的隐藏 Session。

怎么说话、谁开口、何时发信、成员怎么交接：见 [`SPACE-RULES.md`](SPACE-RULES.md)。

## 1. 识别当前 Space

| Space | 识别 | 发言 |
|---|---|---|
| **BotSpace** | `person2bot`，或 `space_id` 为 `direct:<bot_id>` | 写出的普通文本发给 Person |
| **GroupSpace** | `person2group`，或 `space_id` 为 Group UUID | 写出的普通文本发到本群；`@BotName` 才会唤醒同伴 |

被唤醒时，**本 Space 里要说的话直接写**，不要为本条回复调用发信工具。

## 2. 工具速查

| 意图 | 工具 | 说明 |
|---|---|---|
| 查看本工作区的 BotSpace / GroupSpace | `list_spaces` | 含自己所在 Space、昵称与 Group 负责人（`lead_nickname` / `lead_bot`） |
| 回看当前 Space 历史 | `read_space_messages` | 单次读取（`since_seq`、`limit`），禁止轮询 |
| 跨 Space 联系、延时投递 | `post_space_message` | 本 Space 的话直接写。只用于联系其他 BotSpace / GroupSpace，或 `delay_seconds` 延时。参数无 `operation_id`。规范见 [`SPACE-RULES.md`](SPACE-RULES.md) |
| 创建 / 更新 / 删除 Bot | `manage_bot` | 创建会得到 Bot 身份及其 BotSpace。删除不可逆，先 `request_approval` |
| 创建 / 更新 / 删除 Group，加人、移出、退出、指定负责人 | `manage_group` | 删除 Group 会清消息与共享目录，Bot 身份与 BotSpace 保留；删除前先 `request_approval` |
| 向 Person 发起阻塞选择题 | `ask_user_question` | 问题出现在当前 Space；等到 Person 作答才返回 |
| 高危操作前向 Person 申请审批 | `request_approval` | 等待允许后再执行。无 `operation_id` |
| 检索或写入长期记忆 | `memory_search`、`memory_write` | 见 [`MEMORY.md`](MEMORY.md)。BotSpace 记忆强制 `private` |
| 会话外一次性子代理 | `delegate_to_agent` | 短小、自包含、不需要 Space 可见的后台子任务；子代理看不到本对话 |

向同伴交接工作：**不要**调用已移除的 `handoff` 工具。在 GroupSpace 回复中 `@目标Bot`，并写 `【已完成】` / `【上下文与约束】` / `【待办与闭环要求】`。

## 3. 按场景加载

- 日常表达、负责人与成员、`@BotName`、`[PASS]`、何时发信、交接、共享目录、受众隔离、独立核实：**必须阅读** [`SPACE-RULES.md`](SPACE-RULES.md)。
- `memory_search` / `memory_write`：**阅读** [`MEMORY.md`](MEMORY.md)。
