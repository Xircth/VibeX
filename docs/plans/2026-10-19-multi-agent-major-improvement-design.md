---
title: multi-agent 功能重大改进设计方案
date: 2026-10-19
status: draft
scope: vibex.multi-agent + VibeX Host
plugin: C:\Users\18190\Documents\projects\vibex-plugin-multi-agent
analysis: docs/plans/2026-10-18-multi-agent-collaboration-enhancement.md
---

# multi-agent 功能重大改进设计方案

本文是产品与领域设计。实施步骤、表结构、错误码和验收剧本在《multi-agent 功能重大改进技术方案》。两份一起读，才能从需求走到可运行的功能。

先前评估里的推荐值在本文全部冻结为实施值。范围收窄（同工作区、无义务状态机、无 DID）写在对应决策里，避免实现时再改口径。

## 1. 文档说明

VibeX 的 `vibex.multi-agent` 今天只做 LLM 中介的一次性委派：`delegate_to_agent` 拉起子 Conversation，父会话等待结果。用户要的是可复用角色、一等会话、按身份投递、延时队列，以及一个 IM 式协作空间。

这些能力的写入口在 Host Application Core（`ConversationControl`），不在插件私有存储。插件负责设置页、协作空间 Tab、Skill 和 MCP 声明。Host 不得出现 `if plugin_id == "vibex.multi-agent"`。

产品形态对照：协作空间对齐 AgoraHub 频道；按身份投递对齐 MCP Agent Mail；信封对齐 agent-inbox 的 ActivityStreams 2.0 Note；ANP 的 mention 只作验收词汇。投递保证层是 `submit` / `steer`。

## 2. 目标与非目标

### 2.1 需求跟踪

| 编号 | 需求 | 本文 | 批次 |
| --- | --- | --- | --- |
| R1 | 设置进入设置窗口独立页，离开插件详情配置表单 | §3.1 §6.1 | A |
| R2.1 | 按会话 ID 查状态和上下文；`@会话` 之后 Agent 能查 | §3.2 | B |
| R2.2 | 无 ID 时列出时间窗内活跃会话（ID、Agent、配置、状态）；默认近 7 天，设置可改，Agent 可覆盖 | §3.2 §6.1 | B |
| R3 | 角色（可复用会话模板）与可选团队；设置页与 Agent 写同一份数据 | §3.3 §4 | C |
| R4.1 | 按角色创建会话；Composer 摘要显示角色名；展开后角色属性为一级，会话配置为二级 | §3.4 §6.2 | C、D |
| R4.2 | 不经角色直接创建；两种会话都是一等公民 | §3.4 | C |
| R5.1 | 按会话 ID 插入消息；在途则排队；显式要求且 Agent 支持时 Steering | §3.5 | E |
| R5.2 | 向自己发送，进入队列 | §3.5 | E |
| R5.3 | 延时消息走独立队列，到期才进入普通队列 | §3.5 §4 | E |
| R6.1 | 协作空间成员是会话；`@` 投递后发送方不等待；上下文独立 | §3.6 | F |
| R6.2 | 成员身份由该会话自己定；拉人时可提议昵称 | §3.6 | F |
| R6.3 | 一条消息可 `@` 多人且文本相同；无 `@` 发给全体 Agent 可见成员 | §3.6 | F |
| R6.4 | 顶部 Tab，三栏 IM | §6.3 | G |
| R6.5 | 用户发消息时加入，对其他成员不可见、不可 `@` | §3.6 §6.3 | F、G |
| R6.6 | 查看成员会话后，切到工作区或看板仍是该会话 | §5 §6.3 | G |

### 2.2 做到什么算完成

一名只启用多智能体协同的用户可以：

1. 在「设置 → 多智能体协同」改查询窗口、深度、缓存和委派默认值，并维护角色与团队。
2. 让 Agent 列出近一周会话，再按 ID 看上下文。
3. 让 Agent 按角色或直接创建一等会话；基于角色的会话在 Composer 左下角显示角色名。
4. 让 Agent 向同工作区任意会话（含自己）立即或延时投递，调用立刻返回。
5. 创建协作空间，成员互发，在途则排队，空闲则开新 Turn，发送方继续自己的工作。
6. 在顶部「协作空间」Tab 看三栏 IM；点成员后回到工作区，当前会话就是该成员。

### 2.3 明确不做

- 全 Host 任意工作区写权限。
- 义务状态机（open / blocked 必须有人回复）、文件租约、空间 KV、ANP DID、`group.send` JSON-RPC、端到端加密。
- Manager Conversation、第二套消息生命周期、`check_inbox` / `fetch_inbox` / `wait_for_space`。
- 在插件 Tab 内嵌 Host 时间线、Composer、权限卡。
- 修改角色后回写已存在会话。
- 把一次性委派改成多轮。`delegate_to_agent` 保持原语义。

## 3. 功能设计

### 3.1 设置页（R1）

入口是设置窗口侧栏「多智能体协同」，贡献种类 `app.settings.page`。插件详情「配置」Tab 不再是编辑入口：只保留只读摘要和「在设置中打开」。

这一页编辑两类数据：

| 数据 | 真相 | 谁改 |
| --- | --- | --- |
| `depthLimit`、`completedCacheMaxMb`、`agentDefaults`、`conversationListDefaultDays`、`delayMaxHours` | 插件 `config.json` | 设置页经 `storage.settings` |
| 角色、团队 | Host 表 | 设置页与 MCP 走同一 `host.call` |

`conversationListDefaultDays` 默认 7，允许 1–90。`delayMaxHours` 默认 24，硬顶 168（7 天）。

禁用插件后侧栏条目消失。已保存的 `config.json` 与 Host 领域行都保留。

### 3.2 查询会话（R2）

**按 ID。** 沿用 `crates/conversations/src/session_info.rs` 的唯一实现：任意未删除 Conversation 可读，返回标题、Agent、状态、模型、工作区、父会话、是否委派子会话、截断后的消息（最多 200 条 / 约 16k 字）。`@会话` 插入的 `vibex://conversation/<uuid>` 和裸 UUID 都能查。

协同 MCP 与会话增强 MCP 都暴露同一个工具名 `get_session_info`，底层一个函数。只开协同就能查。两套解析器不存在。

**列表。** 新工具 `list_conversations` 只在协同 MCP。返回 ID、标题、Agent、状态、`updated_at`、是否在途 Turn、父 ID、是否委派子会话、工作区、已持久化的 mode/config。没有快照就省略该字段，不编造。列表不含正文。正文继续 `get_session_info`。

默认 `since_days` 取设置；参数可覆盖。默认范围是当前工作区。`project_id` 或 `workspace_id` 必须显式传入才放宽。硬顶 100 条。

Skill 写明：先列表，再按需查单条，禁止对列表逐条拉全文。

### 3.3 角色与团队（R3）

角色是可复用模板，不是 Conversation。团队是可选分组。角色可以没有团队。

属性：

- 角色：`id`、`name`、`team_id?`、`summary`、`persona_prompt`、`agent_id`、`mode_id?`、`config_values?`
- 团队：`id`、`name`、`summary?`

用户在设置页创建、修改、删除。Agent 用 `create_role` / `update_role` / `delete_role` / `list_roles`，团队同样一套。两边写同一张表。

上限：每个 Host 100 个角色、30 个团队。超过则拒绝并返回稳定错误。

删除角色不删除已创建的会话。改角色不回写已创建的会话。人设提示词在设置页和创建时的会话说明里对用户可见，不出现在 Composer 一级菜单。

`agentDefaults` 只服务 `delegate_to_agent`。角色会话只用角色上的 Agent 与配置。两者不合并。

### 3.4 创建会话（R4）

两条路都进用户工作区的 `sessions` 表，父连接断开后仍在，不走 Delegation Broker 的一次性完成策略，也不走插件作用域的 `conversation.create`（那种会话默认不出现在工作区列表）。

| 工具 | 结果 |
| --- | --- |
| `delegate_to_agent` | 一次性子任务。子 Turn 终态即完成。父退出级联取消。行为不变 |
| `create_conversation` | 一等会话。可带 `role_id`，也可直接给 `agent_id`。关系种类 `spawned`：用于导航，不级联取消，不套用 first-terminal-wins |

创建时若有 `role_id`：把当时的名称、团队名、简介、Agent、人设提示词做成快照，写入会话人格投影。之后改角色不影响该会话。人设提示词作为用户可见的首条 Host 说明进入时间线。

直接创建不写人格投影。Composer 摘要保持今天的 mode/model 短句。

配额：沿用委派的工作区根约束、深度和并发上限。`spawned` 会话计入活跃协同预算。

### 3.5 向会话发送（R5）

调用方不先查询是否空闲。`submit` 先持久化：空闲则认领并开 Turn，在途则排队。这是「按身份投递，对方空了再处理」。

**范围（v1）。** 同一工作区：自己、子孙、其他会话。其他工作区、已删除、已归档表现为 not found。这是对「任何会话」的隔离收窄：避免借协同写入别的 worktree。会话增强的 token 仍只写祖先树；协同 token 才打开同工作区。只开会话增强时，行为与今天一致。

**Steering。** 仅当调用方传 `steer: true`。必须带当前在途 Turn。Agent 不支持、没有在途 Turn、或 Turn 已变，返回稳定错误，不改成排队。默认路径是 `submit`。

**自己。** `conversation_id` 等于当前会话。无延时就是普通 `submit`，在途则进普通队列。用途包括「这段做完后再看」的后续输入。

**延时。** 行进 `conversation_delayed_inputs`，不占 `conversation_inputs.sort_key`。到期后由 Application Core 提升器调用同一次 `submit`，再进入普通队列。延时 0 或省略 = 立即提交。超过 `delayMaxHours`（硬顶 168）拒绝。

返回立刻是 `{ delivered: "queued" | "dispatched" | "scheduled", input_id, turn_id? }`。工具内不等待对方 Turn 结束。

同工作区互发可能循环。每会话每小时入队上限，相同 payload 摘要在冷却窗口内折叠为已有回执。

### 3.6 协作空间（R6）

协作空间是会话的 IM 房间，不是任务图，不是第三种 Conversation。

**成员。** Conversation，可以是角色会话，也可以是普通会话。每个成员在空间内有昵称。拉入时提议昵称；该会话可以改自己的昵称（「由会话自己定」）。同一空间内昵称唯一。改名只影响之后的 `@` 解析；已写入的消息保持发送时的 `actor`。

**发送。** `post_to_space` 立刻返回。Hub 写空间日志，把 `to` 展开成若干次 `submit`。对方在途则排队，空闲则开新 Turn。发送方继续自己的 Turn 或结束它。空间投递不抢 ACP 连接，不取消在途 Turn。

一条消息 `@` 多人 = 同一份 `content` 各交一份。不同文本分两次发送。

无 `@` = 向全部 `visible_to_agents` 的成员各 `submit` 一次，排除发送者自己。这是需求原文。AgoraHub 的 quiet-board（送达但不拉起义务）不采用。

**用户。** 用户在 Tab 里发出第一条消息时成为成员，`kind = user`，`visible_to_agents = false`。Agent 的成员名册和 `@` 解析看不到用户。中栏仍显示用户气泡。用户文本以 Host 用户身份投递给各 Agent 成员。

**上下文。** 各成员 JSONL 只包含投递给自己的那一份。空间日志是房间 transcript，不并进任一成员历史。

**回看。** `list_space_messages({ since_seq })` 返回 `seq` 更大的全文，给 UI 和偶尔回看。它不阻塞、不等待。

**身份。** 空间属于一个工作区。成员必须属于该工作区。

v1 没有「这条必须有人回复」的钉住状态。共享状态就是空间日志。

### 3.7 与一次性委派的分工

| 意图 | 用 |
| --- | --- |
| 短、自包含、要汇总回父、父退出应取消 | `delegate_to_agent` |
| 要复用人格、要多轮、要进协作空间、父退出仍保留 | `create_conversation` |
| 告诉另一个已存在的会话一件事，自己继续 | `send_session_input` 或 `post_to_space` |
| 看某次委派是否结束 | `get_delegation_status`（只用于委派） |

## 4. 领域模型

### 4.1 术语

| 术语 | 定义 |
| --- | --- |
| 角色 Role | 可复用的会话模板。不是 Conversation |
| 团队 Team | 角色的可选分组 |
| 会话人格投影 | 创建当时从角色抄下的名称、团队、简介、Agent。绑在一个 Conversation 上 |
| 排队输入 | 已进入 `conversation_inputs`、等待认领的普通输入 |
| 延时输入 | 尚未进入普通队列的定时输入。到期才提升 |
| 纠偏 Steering | 打进指定在途 Turn 的即时指导。不新建 Turn，不进普通队列 |
| 协作空间 Space | 一个工作区内的 IM 房间。关系 + 日志 + 投递 |
| 成员身份 | 空间内昵称。拉入时提议，成员可改自己的 |
| 空间消息 | 房间日志中的一条 AS2 Note。有单调 `seq` |
| 投递回执 | 某条空间消息对某个 Conversation 的一次 `submit` 结果：已排队或已认领 |

已有术语保持原义：Conversation、Turn、Queued conversation input、Turn steering（见 `CONTEXT.md` 与 ADR-0044）。空间不是 Manager Conversation。延时输入不是排队输入。

### 4.2 实体

```text
Team
  id, name, summary?, created_at, updated_at

Role
  id, name, team_id?, summary, persona_prompt,
  agent_id, mode_id?, config_values?,
  created_at, updated_at

ConversationPersona
  conversation_id   // 主键
  role_id?          // 来源，可为空（角色已删）
  name, team_name?, summary, agent_id
  snapshotted_at

DelayedInput
  id, conversation_id, operation_id,
  payload, principal, deliver_at,
  status: scheduled | promoted | cancelled | failed
  promoted_input_id?

Space
  id, workspace_id, name,
  created_by_conversation_id?, created_at

SpaceMember
  space_id, member_id,
  conversation_id?,          // 用户成员为空
  nickname,
  kind: agent | user,
  visible_to_agents          // user 恒为 false

SpaceMessage
  id, space_id, seq,
  envelope_json,             // AS2 Note
  created_at

SpaceDelivery
  space_message_id, conversation_id, operation_id,
  input_id?, status: queued | dispatched | failed
```

### 4.3 不变量

1. 一次 `submit` 只进入一个 Conversation 的普通队列。空间扇出是多次 `submit`。
2. 延时行在提升之前不占用该会话的 `sort_key`。
3. `steer` 失败不会留下排队输入。
4. 角色删除不删除 Conversation，不删除人格投影。投影里的 `role_id` 可空，名称仍在。
5. 空间消息的 `seq` 在该空间内严格递增。
6. 同一 `(space_message_id, conversation_id)` 至多一次成功投递。重试返回原回执。
7. `visible_to_agents = false` 的成员不进入 `@` 展开，也不进入无 `@` 广播。
8. 无 `@` 的广播排除发送者自己。
9. `spawned` 关系不随父退出级联取消。
10. 空间日志不是任一 Conversation 的 JSONL 权威历史。

### 4.4 信封

空间消息持久化为 ActivityStreams 2.0 Note 子集：

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Note",
  "id": "vibex://space-message/<uuid>",
  "actor": "vibex://space/<spaceId>/member/<nickname>",
  "attributedTo": "vibex://conversation/<conversationId>",
  "to": ["vibex://space/<spaceId>/member/小B"],
  "inReplyTo": null,
  "summary": "请评审当前 diff",
  "content": "请评审当前 diff。关注 auth.ts 的错误处理。",
  "published": "2026-10-19T08:00:00Z"
}
```

- `summary` 是标题。省略时 Host 取 `content` 首行。
- `inReplyTo` 是父指针，指向同空间已有消息。
- `to` 为空表示广播。
- 投进会话的文本：第一行是标题，下面是全文。排队被认领时 Agent 先看标题。

## 5. 架构设计

```text
设置窗口  app.settings.page     插件 Federation UI
协作空间  app.tab               插件 Federation UI（无 engine）
Composer  SessionSettingsSummary ← ConversationPersona（Host 前端）
                    │
                    ▼
公开 host.call（无插件 ID 分支）
  storage.settings.*
  collaboration.role.* / team.*
  collaboration.space.*
  workspace.focusConversation
                    │
                    ▼
Application Core
  ConversationControl.create / submit / steer
  SessionInfo 读
  DelayedInput 提升器
  SpaceRouter：写日志、展开 @、对每个目标 submit
                    │
                    ▼
vibex-mcp
  product=delegation   列表、角色、创建、空间、同工作区发送
  product=session      get_session_info 同一实现；子孙范围的发送
```

消息规则只活在 Application Core。MCP、设置页、协作空间 Tab 都是客户端。

`workspace.focusConversation({ conversationId })` 只做导航：聚焦该窗口已有的 Conversation 面板，或按 ADR-0042 打开唯一面板，并更新窗口当前会话。插件 iframe 不挂载 `AgentTimelineConversation`。

官方无特权检查继续要求：Host 只认识贡献种类和通用 API。

## 6. 页面设计

视觉沿用 `DESIGN.md`：`LegacyDesignScope`、`--surface-*`、`--text-*`、`.settings-surface`。不新增调色板。文案只帮助操作、判断状态或从错误恢复。

### 6.1 设置 → 多智能体协同

```text
多智能体协同
├ 常规
│   委派深度          [ 3 ]
│   完成缓存 (MB)     [ 64 ]
│   查询窗口（天）    [ 7 ]
│   延时上限（小时）  [ 24 ]
├ 委派默认
│   Agent、mode、配置（沿用现有 agentDefaults 字段）
├ 团队
│   列表 · 新建 · 重命名 · 删除
└ 角色
    列表 · 新建 · 编辑 · 删除
    编辑：名称、团队、简介、人设提示词、Agent、会话配置
```

空态：「还没有角色」。按钮：「新建角色」。

删除角色确认：「删除后，已创建的会话仍保留。」

插件详情配置 Tab：「深度 3 · 查询窗口 7 天」加按钮「在设置中打开」。

### 6.2 Composer 左下角

无人格投影：保持现有短句（mode / model / effort）。

有人格投影：

- 折叠：只显示角色名，例如「评审员」。
- 展开一级：名称、团队、简介、Agent。
- 二级子菜单「会话配置」：现有 mode 与 config 行。改的是这个会话，不是角色模板。
- 一级不显示角色 ID，不显示人设提示词。

### 6.3 协作空间 Tab

顶部 Tab 标题「协作空间」。页内三栏，插件自己画。不声明 `engine`。

```text
┌ 空间          ┬ 评审工作                         ┬ 成员          ┐
│ 评审工作      │ 小A  请评审当前 diff              │ 小A  评审员   │
│ 发布检查      │ 小B  错误处理缺少测试             │ 小B           │
│               │ 你   我看一下 auth.ts             │ 小C           │
│               │                                   │               │
│               │ [输入消息，@ 点名成员]     发送   │ 在工作区打开  │
└───────────────┴───────────────────────────────────┴───────────────┘
```

- 左栏空态：「还没有协作空间」/「新建空间」。
- 中栏空态：「还没有消息」。
- 右栏是成员卡片和空间名称。点成员或「在工作区打开」调用 `workspace.focusConversation`。v1 不在右栏嵌时间线。
- 用户气泡作者显示「你」。成员列表里用户行只给用户自己看，Agent 名册接口不返回它。
- 发送失败时输入保留，行下显示原因：「不在这个空间」「昵称不存在」。
- `@` 在输入框内弹出当前空间的 Agent 可见昵称。选中后插入昵称 token。

### 6.4 跨面保持

在协作空间点开小B之后，窗口当前会话是小B。切到工作区或看板，焦点面板是小B 的那一个 Conversation 面板。同一窗口不出现第二份小B 面板。

## 7. 接口概要

完整字段、错误码和幂等键见技术方案 §5。

| 面 | 操作 |
| --- | --- |
| 设置 | `storage.settings.get/put` |
| 角色 | `collaboration.role.create/update/delete/list` |
| 团队 | `collaboration.team.create/update/delete/list` |
| 会话 | `get_session_info`、`list_conversations`、`create_conversation` |
| 发送 | `send_session_input`（同工作区、self、可选 delay、可选 steer） |
| 空间 | `create_collaboration_space`、`add_space_member`、`set_space_identity`、`post_to_space`、`list_space_messages` |
| 导航 | `workspace.focusConversation` |

`post_to_space` 与 `send_session_input` 都立刻返回回执。

## 8. 关键决策

1. **Host 先开缝，插件再消费。** 插件公开 SDK 写不了任意工作区会话，也改不了 Composer。只改插件会做出轮询式假 IM。
2. **写入口只有 `ConversationControl`。** 空间路由器是它上面的扇出，不是第二队列。
3. **v1 发送范围是同工作区。** `relation.rs` 今天已要求同工作区，再要求祖先树。协同 token 去掉祖先树限制，保留工作区限制。
4. **查询只有一个读实现。** 协同和会话增强都调用 `session_info`。列表只在协同，且不含全文。
5. **角色进 Host 表。** `config.json` 只放标量。改角色不回写会话。
6. **`spawned` 与 `delegated` 分开。** 前者是一等会话，不级联取消。
7. **延时表独立。** 提升时才 `submit`，避免堵住即时消息。提升器在 Application Core，不在插件 `host.service`。
8. **默认 `submit`，显式才 `steer`。** 不支持就失败。
9. **无 `@` 给全体 Agent 可见成员开 Turn。** 不采用 AgoraHub quiet-board。
10. **attention 用 `summary` + 全文。** 标题在前，全文仍内联，因为要开 Turn。
11. **v1 不做义务、租约、空间 KV、DID。** 房间日志就是共享状态。
12. **Tab 与 Open Connector 同构。** 无 `engine`。跨面保持用 `focusConversation`。
13. **用户是隐身成员。** UI 可见，Agent 名册不可见。
14. **昵称可被提议，最终由该会话修改。** 唯一性按空间约束。

被否决的替代：

- 把角色 JSON 塞进 `config.json`：长提示词和按 ID 查询不适合配置文件。
- 让 Agent `fetch_inbox`：对方不轮询就会漏信。Agent Mail 的 120 秒 hook 是反例。
- 插件 Tab 内再做一个 Host 会话引擎：时间线、权限卡、纠偏、草稿都会分叉。Open Connector 已证明顶级 Tab 可以没有引擎。
- 把延时行插进 `conversation_inputs`：会占 `sort_key`，挡住后面的即时消息。

## 9. 安全、幂等、恢复

- 跨工作区 ID 与不存在的 ID 同样返回 not found，不泄露标题。
- 每次写带 `operation_id`。同一操作重复调用返回第一次的回执，不产生第二个 Turn。
- 空间投递幂等键是 `space_message_id + conversation_id`。
- 进程在「延时行已提升、Turn 未开始」之间崩溃：普通排队输入按 ADR-0044 恢复。未提升的行仍等 `deliver_at`。已 Dispatched 的 Turn 不自动重发。
- 目标在提升前被归档：行标 `failed`，不重试成活 Turn。
- 广播和互 `@` 有速率与摘要冷却。
- 人设提示词对用户可见，避免隐藏指令。
- 插件停用：MCP 写失败关闭；已经排队的会话输入继续由会话调度器处理，因为它们已是会话事实。

## 10. 开放问题

没有阻塞实施的产品未决项。下列数值就是实施值：查询默认 7 天（1–90）、延时默认 24 小时（硬顶 168）、角色 100、团队 30、列表硬顶 100、卸载后保留 Host 领域行。

## PR Plan

与技术方案批次一一对应。细节、文件和验收在技术方案。

| PR | 标题 | 依赖 | 内容 |
| --- | --- | --- | --- |
| A | 设置页迁入设置窗口 | 无 | 插件 Worker/App、`app.settings.page`、标量配置 |
| B | 会话查询 | A 的默认天数 | `list_conversations`、协同侧 `get_session_info` |
| C | 角色、团队、一等创建 | A | Host 表、MCP、`spawned` 会话 |
| D | Composer 角色摘要 | C | 人格投影驱动 `SessionSettingsSummary` |
| E | 同工作区发送与延时队列 | B | ADR-0044 作用域、延时表、提升器 |
| F | 协作空间控制面 | C、E | 空间表、AS2、`post_to_space` |
| G | 协作空间 Tab | F | `app.tab` 三栏、`focusConversation` |

## 参考

- `docs/plans/2026-10-18-multi-agent-collaboration-enhancement.md`
- ADR-0031、ADR-0042、ADR-0044、ADR-0057、ADR-0058、ADR-0069、ADR-0082
- AgoraHub、MCP Agent Mail、agent-inbox、ANP Messaging（语义对照，见评估 §2.5）
