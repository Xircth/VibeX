# 协作空间投递信封

群组投递写入成员隐藏会话的 Agent 提示词格式。权威模型见
[collaboration-member-identity.md](collaboration-member-identity.md)。

## 何时注入开场

规则、工具说明和人设只在 **这个助手在这个群组的这条 ACP 会话里第一次投递** 时注入。
记录存在 `collaboration_space_prompt_injections`，按 **会话 × 群组**
（`conversation_id` × `space_id`）区分，并带上当时绑定的 `acp_session_id`。

ACP 会话重建或恢复后会清掉该记录，下一次投递重新注入。之后的信封只保留来源、
收件人、序号、`root_id`、正文和引用的那条消息。

成员名单和更早历史不进信封。需要时调用：

- `list_space_members({ space_id })`
- `list_space_messages({ space_id, since_seq?, limit? })`（`since_seq` ≥ 0，`limit` 1–200）

## 后续信封（第二轮起）

```
[协作空间消息]
- 来源：User
- 收件人：@小A
- 序号：#2
- root_id：<user-root-message-id>
请再看缓存
```

引用回复时多一行：

```
- 引用：#1 User：请分析登录性能
```

`root_id` 是板块 A 的用户根消息 id；没有则省略该行。

## 首轮信封

在后续信封前面加上人设、`[协作空间成员身份]`（含 `space_id` 与自己的昵称）、
协同规则和 MCP 工具摘要。身份块不再列出全员名单，并写明用
`list_space_members` / `list_space_messages` 按需拉取。

## 改动前（每轮都带）

```
人设
你是后端评审，只看 diff。

[协作空间成员身份]
- 所属协作空间：评审工作 (space_id: space-demo)
  你的成员昵称：小A (conversation_id: conv-a)
  同空间成员：小A（你自己, conversation_id: conv-a）、小B (conversation_id: conv-b)、小C (conversation_id: conv-c)，以及 User（用户）
- 多智能体协同 MCP 工具：你可以使用 `list_collaboration_spaces`……
- 协作空间交互规则：
  1) 在对应空间回复：……
  2) 收到 User 消息先应答再执行：……
  3) 无需回复即停止：……
  4) 对用户屏蔽内部参数：……
  5) 空间感知与群收藏……
  6) 独立核实与反群体谬误……

[协作空间消息]
- 来源协作空间：评审工作 (space_id: space-demo)
- 消息来源：User（用户）
- 收件成员：@小A
- 消息序号：#1 (message_id: vibex://space-message/root-msg-1)
- 空间内成员：小A (conversation_id: conv-a)、小B (conversation_id: conv-b)、小C (conversation_id: conv-c)，以及 User（用户）
- 回复提醒：本条消息来自协作空间（space_id: "space-demo"）。需要用户或成员看见的内容，调用 `post_to_space`……

请分析登录性能
```

## 改动后 · 首轮

```
人设
你是后端评审，只看 diff。

[协作空间成员身份]
- 所属协作空间：评审工作 (space_id: space-demo)
  你的成员昵称：小A (conversation_id: conv-a)
  需要成员名单时调用 `list_space_members`（`space_id`）；需要更早历史时调用 `list_space_messages`（`space_id`、`since_seq`、`limit`）
- 多智能体协同 MCP 工具：……（含 list_space_members / list_space_messages）
- 协作空间交互规则：……（第 5 条要求按需拉名单和历史）

[协作空间消息]
- 来源：User
- 收件人：@小A
- 序号：#1
- root_id：root-msg-1
请分析登录性能
```

## 改动后 · 第二轮

```
[协作空间消息]
- 来源：User
- 收件人：@小A
- 序号：#2
- root_id：root-msg-1
请再看缓存
```
