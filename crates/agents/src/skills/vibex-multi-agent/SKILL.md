---
name: vibex-multi-agent
description: 在同一工作区里查询会话、创建可复用角色会话、向已有会话发消息，或在协作空间里投递。短的自包含子任务仍用一次性委派。当用户点名其它 Agent、要多轮协作，或消息里出现 vibex://conversation 时使用。
---

# 多智能体协同

这些工具来自宿主的 MultiAgent协同。没有工具就不要假装已经委派、创建或发到了空间。

schema 以本会话 MCP 清单为准。不要 grep 仓库，也不要用 `search_tool` 查这些工具的参数。Grok 的 `search_tool` 只用于发现未知 MCP。

## 先选对工具

| 意图 | 工具 |
|---|---|
| 短、自包含、要汇总回当前会话，父退出应取消 | `delegate_to_agent`，再用 `get_delegation_status` |
| 停掉仍在跑的一次性委派 | `cancel_delegation` |
| 看本工作区最近有哪些会话，不要正文 | `list_conversations` |
| 看某一个会话的标题和截断消息 | `get_session_info` |
| 留下一个可多轮的会话，或套用角色 | `create_conversation` |
| 告诉一个已存在的会话一件事，然后继续自己的工作 | `send_session_input` |
| 建房间、拉人、改自己的昵称、按昵称发消息 | `create_collaboration_space`、`add_space_member`、`set_space_identity`、`post_to_space` |
| 回看空间日志，立刻返回，不要等 | `list_space_messages` |

`get_delegation_status` 只服务于一次性委派。空间消息不要用它轮询。`list_space_messages` 不是等待。

## 查询

先 `list_conversations`。默认是当前工作区、设置里的查询窗口。响应有 ID、标题、Agent、状态，没有消息正文。不要对列表逐条调用 `get_session_info`。只对用户点名或你确实要读的那一个 ID 调用。

`@会话` 的 `vibex://conversation/<uuid>` 和裸 UUID 都可以传给 `get_session_info`。没有持久化的 mode 或配置时，响应该省略该字段，不要编造。

## 一次性委派

Composer 里的 `&` 只表示用户要你考虑把工作交给那个 Agent。界面不会因此创建子会话。

对每一个 `vibex://agent/<id>`：用 href 里的稳定 id 作为 `agent_type`，调用一次 `delegate_to_agent`。显示名称不是 id。用户明确说自己做时不要调用。

`task` 必须自包含：目标、完成标准、绝对路径、约束、要交回的摘要。子 Agent 看不到本对话。

调用立刻返回 `task_id`。对用户说话之前，用 `get_delegation_status` 收集结果；只要结果就传 `wait_ms`。父会话退出会取消仍在跑的委派子会话。子任务第一个 Turn 终态即结束。不要对委派子会话再发「继续」。

稳定 id：`claude_code`、`codex`、`opencode`、`antigravity`、`openclaw`、`cline`、`hermes`、`codebuddy`、`kimi_code`、`pi`、`grok`、`cursor`、`deepseek_harness`、`qoder`。不知道 id 就停，请用户重新插入 `&`。

## 一等会话

`create_conversation` 创建的会话留在当前工作区。父会话退出不会取消它。

- 带 `role_id`：用角色当时的 Agent 和配置。不要再混入委派默认。
- 只带 `agent_id`：普通会话，没有角色人格。

创建之后用返回的会话 ID。需要再跟它说话时用 `send_session_input` 或把它拉进协作空间，不要再 `delegate_to_agent` 假装那是续聊。

## 发送

`send_session_input` 立刻返回 `queued`、`dispatched` 或 `scheduled`。不要在工具里等对方 Turn 结束。返回后继续自己的工作。

默认就是提交。只有明确要改对方当前这一 Turn 时才传 `steer: true`，并且必须带 `expected_turn_id`。不支持、没有在途 Turn、或 Turn 已经变了，会返回稳定错误。不要改成不带 `steer` 再发同一句。

`delay_seconds` 省略或 0 是立即提交。到期前它不占普通队列。超过设置里的延时上限会被拒绝。

v1 只能发到同一工作区。别的工作区、已删除、已归档会表现为找不到，响应该没有标题。

## 协作空间

`create_collaboration_space` 在当前工作区建房间。`add_space_member` 提议昵称。对方要用 `set_space_identity` 改自己的昵称。改名只影响之后的 `@`，旧消息上的 actor 不变。

`post_to_space` 立刻返回。`to` 里每个昵称收到同一份 `content`。不同文本分两次发。

不传 `to`：投递给全部 Agent 可见成员，排除你自己。不要等对方回复才结束这一轮。

`list_space_messages` 传 `since_seq`，一次拿回更大的 seq 和全文，调用马上结束。不要把它当成收件箱循环。

## 失败时

- 没有这些工具：请用户打开「设置 → 常规 → MultiAgent协同」，然后新开或重新绑定会话。
- 开关已关但旧会话还留着工具：停止新的写调用。
- 深度超限：说明限制，把一次性委派收回到当前层，或请用户到设置页改委派深度。
- 昵称不存在：用当前昵称，不要猜旧名。
