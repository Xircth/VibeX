# 协作空间投递信封

群组投递写入成员隐藏会话的 Agent 提示词格式。权威模型见
[collaboration-member-identity.md](collaboration-member-identity.md)。

## 何时注入开场

规则、工具说明和人设只在 **这个助手在这个群组的这条 ACP 会话里第一次投递** 时注入。
记录存在 `collaboration_space_prompt_injections`，按 **会话 × 群组**
（`conversation_id` × `space_id`）区分，并带上当时绑定的 `acp_session_id`。

ACP 会话重建或恢复后会清掉该记录，下一次投递重新注入。之后每次投递是
**一行英文头 + 正文**。

成员名单和更早历史不进信封。GroupSpace 投递信封会按时间顺序自动附带该 Bot 上次完成回合以来的群内新增上下文（`[上次发言后的群内新消息]`，含本轮前序成员刚发出的回复，最多数条原文 + 超出部分单行折叠摘要）。Bot 直接基于信封内的增量上下文推进，无需每回合调用工具查看群消息；仅当信封提示更早消息「已折叠」或需查询成员/更早历史时才调用：

- `list_spaces({ space_id? })`
- `read_space_messages({ space_id, since_seq?, limit? })`（`since_seq` ≥ 0，`limit` 1–200）

## 每次投递

BotSpace：

```
[Message from Person · to @小A]
请再看缓存
```

GroupSpace：

```
[Group chat "评审工作" · from Person · to @小A]
请再看缓存
```

可选子句用 ` · ` 接在同一行里：

- `to @小A, @小B` — 有具名收件人时
- `quoting #1 Person: 请分析登录性能` — `reply_to` 指向的消息
- `speaking order: @小A (you, now) → @小B (waiting)` — 本轮至少两名 Bot
- `still at work: @Coder (working)` — 群里仍在跑回合的其他 Bot

落盘 `envelope_json` 仍是 `{id, sender, to, content, reply_to, published}`；
英文头只出现在隐藏 Session 的 Agent 提示词里。

## 首轮投递

在上述英文头前面加上人设和 `[Space 身份与协作规则]`（含 Bot 昵称、BotSpace /
GroupSpace、`space_id`、共享目录、隐式发言与 `[PASS]`）。身份块不列出全员名单。

```
人设
你是后端评审，只看 diff。

[Space 身份与协作规则]
- 你是 Bot「小A」，当前空间是 GroupSpace（space_id: …）。…
- 完整协作规范位于 `~/.vibex/skills/vibex-bot/SKILL.md`
- …

[Group chat "评审工作" · from Person · to @小A]
请分析登录性能
```
