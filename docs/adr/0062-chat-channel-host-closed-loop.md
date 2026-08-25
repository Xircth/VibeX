---
status: accepted
date: 2026-08-25
decision-makers:
  - VibeX maintainers
---

# 聊天通道在 Host 上走完编码闭环

[ADR-0056](0056-chat-channel-and-remote-access-codeg-parity.md) 规定了 IM 的产品闭环：
加通道 → 连接成功 → 选目录和 Agent、发任务、跟进、批准权限、取消，并收到
回合 / 错误 / 提问通知。审查证明这条路没有走完：出站通知挂在桌面事件循环上，
`/task` 不能新建会话，微信 iLink 的事件打到企业微信 Webhook，设置页有死开关。

本决定补上实现，不扩大 IM 的产品边界。IM 仍不是 Paired device，不操作配对、
隧道、Git、终端、Workflow 或 Plugin。

## 根因

1. **出站不是 Host 职责。** 会话事件在 `ConversationEventPublisher` 提交后，
   只有桌面 `events.rs` 再调 `notify_conversation_event`。`vibex-server` 用
   `NoopConversationEventPublisher`，入站能跑、回合完成和权限请求推不出去。
2. **`/task` 只跟进已有会话。** ADR-0056 写明可新建会话；实现要求先 `resume`。
3. **微信两种模式共用一个发送函数。** iLink 命令回复走 `sendmessage`，事件和
   测试发送走企业微信 Webhook。保存表单还会把扫码写入的 `mode` / `base_url` 清掉。
4. **事件键与活路径不一致。** 设置页的 `session_created` / `turn_completed` 没有
   对应的会话事件映射；提问已映射但不在默认过滤器和 UI 里；独立 HTTP 汇点只挂在
   从未调用的 `notify_agent_event` 上。
5. **桌面仍留着未启动的平行入站循环。** 违反 ADR-0056 的删除决定。

## 决定

### 1. 出站通知属于 Host

`ConversationEventPublisher` 是会话事件提交后的唯一接缝。Host 在这个接缝上投递
IM，桌面 publisher 仍先发 row-op，再投递；`vibex-server` 只投递。桌面事件循环
和命令收尾不再第二次投递。

独立 HTTP Webhook 汇点从同一接缝发出，不再挂在死函数上。

### 2. 事件以会话事件为权威

过滤器键只对应会真正产生的 `ConversationEvent`：

| 键 | 事件 |
| --- | --- |
| `prompt_started` | `UserTurnStarted` |
| `prompt_finished` | `TurnCompleted` |
| `permission_requested` | `PermissionRequested` |
| `question_requested` | `QuestionRequested` |
| `error` | `TurnFailed` |
| `turn_cancelled` | `TurnCancelled` |
| `turn_interrupted` | `TurnInterrupted` |
| `connection_status_changed` | `AgentConnectionStatusChanged` |
| `session_created` | `ConversationCreated`（IM 新建会话时写入） |

文案语言和「是否外发 prompt」作用于这条活路径。默认开启提问通知；prompt 文本
默认仍不外发。

### 3. `/task` 在已选 Project 与 Agent 上可以新建会话

未绑定会话时：已选 Project 取其最新未归档 Workspace，已选 Agent，创建
Conversation 并 `start_turn`。没有 Workspace 时失败并说明需先在 Host 打开该
Project。已绑定会话时，非前缀文本和 `/task` 仍是 follow-up。

`agent` 列出 Host `agent_membership` 中未退役、已启用的成员，而不是历史会话里
偶然出现过的 id。

### 4. 提问与权限走同一 Application Core

提问推到 IM 后，授权发送者用 `answer [n|text]` 答复，入口是
`ConversationSessionService::respond_question`，与桌面互斥消解同一请求。

### 5. 微信是两种模式，不是一个 Webhook Key

`config.mode` 为 `wecom`（只出站群机器人）或 `ilink`（扫码收发）。出站函数按
模式选择 API。保存渠道必须保留该模式已有字段。iLink 事件和测试发送使用最近一次
入站的 `context_token` 走 `sendmessage`；没有会话上下文时测试发送明确失败，而不是
改打企业微信。

### 6. 连接态真实，设置页可立即起停

每个入站适配器更新 `disconnected` / `connecting` / `connected` / `error`。
Telegram 只有 Bot API `ok: true` 才算 connected。设置页 Connect 立即拉起循环，
Disconnect 暂停循环直到再次 Connect 或重新启用。状态可被设置页读取。

Telegram Topic 模式在总题 `/task` 时调用 `createForumTopic`，之后一题一会话。

### 7. 删除平行入站

删除 `start_inbound_manager` 及其命令分发。入站只留 `start_chat_inbound`。

## 不做

- 不把 IM 做成 Paired device，不上配对 / Reachability / Tunnel 命令。
- 不把工具流、委派卡片或 token 级流式输出镜像到 IM。
- 不复制 CodeG 的平行 command 路由表或 keyring 存储（密钥仍按 ADR-0004）。
- 不把空授权名单改成「绑定 chat_id 也不准入站」：绑定目标仍表示该聊天可信；
  既无绑定目标也无 `authorized_senders` 时 fail-closed。iLink 在名单为空时仍
  允许刚扫码的机器人收第一条命令，随后应写入授权发送者。

## Consequences

- `CONTEXT.md` 补充：IM 出站与入站同属 Host；`/task` 可新建会话；提问用
  `answer`；微信两种模式分开发送。
- 前端事件开关与过滤器键对齐；微信表单区分企业微信与 iLink。
- 桌面与 `vibex-server` 对同一会话事件发出同一类 IM 通知。
