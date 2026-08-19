# Host 事件：Companion 与 Workstation 的消费契约

**状态：** 决策完成（随 ADR-0059 / ADR-0044）。

**日期：** 2026-08-18。

Companion 和 Workstation **不解析 ACP，不维护第二份会话权威**。它们消费 Host
已经写入事件日志、并经投影折叠过的事实。本文规定：哪些事件存在、如何到达
客户端、客户端如何折叠、哪些写操作会产生新事件。

权威实现：

- 事件类型：`crates/agents/src/conversation.rs` `ConversationEvent`
- 追加与投影：`crates/conversations/src/projection.rs`
- Agent 运行时映射：`crates/conversations/src/runtime_events.rs`
- 控制面写入口：ADR-0044 `ConversationControl`
- 传输：`crates/remote-protocol` + `docs/protocol/v1/`

## 1. 权威与分层

```text
Agent ACP / 用户 / Workflow / IM
        │
        ▼
ConversationControl（唯一写入口）
        │  append ConversationEvent
        ▼
Event log（conversation_events，单调 sequence）
        │  fold
        ▼
Projection（timeline rows、turn、permissions、inputs）
        │
        ├── Desktop Local Profile（同进程）
        └── Remote Protocol
                HTTP commands
                WS attach  →  snapshot / replay / live RemoteEvent
```

- 事件日志是唯一权威。投影可丢弃重建。
- `RemoteEvent.sequence` 即该 Conversation 的持久 sequence。
- `RemoteEvent.kind` 是开放字符串，等于 `ConversationEvent` 的 `kind`
  （snake_case）。未知 kind 必须保留 JSON，不得让缓存或 attach 失败。
- 客户端可用 Host 下发的 snapshot 加速首屏，但必须以 sequence 去重后的
  replay + live 为续传依据。

## 2. 传输

### 2.1 握手

1. `GET /api/v1/capabilities`（Bearer device credential）
2. 比较 `protocol_version` 主版本、`minimum_client_version`、`host_id`
3. 拉 Reachability 权威名单（capabilities 或只读面）
4. 一条 WebSocket：`GET /api/v1/ws`，
   `Sec-WebSocket-Protocol: vibex.token.<base64url>`
5. 凭证永不进 URL

### 2.2 一条 Socket，多个订阅

客户端发送：

```text
attach { subscription_id, resource: conversation, conversation_id, after_sequence }
detach { subscription_id }
ping
```

服务端按序：

```text
ready
snapshot?          // through_sequence + 投影 JSON
event…             // replay，sequence > after_sequence
live               // high_water_mark
event…             // 之后的实时事件
detached           // 撤销、会话删除、或客户端 detach
error              // ErrorEnvelope + operation_id
pong
```

规则：

- `ready` 表示订阅已登记，消除「命令已发、尚未订阅」竞态。
- 重复 sequence 丢弃。
- `after_sequence = 0` 且无本地缓存：允许带 snapshot。
- 重连：使用本地已确认的最大 sequence 作为 `after_sequence`。
- 设备被撤：已有 WS 必须立刻 `detached` / 断开，后续 HTTP 401。
- Companion 也可 `attach` `workflow_run`（只读）；P1 产品面可以不展示运行
  编辑器，但协议不得因此失败。

### 2.3 离线与通知

| 面 | 条件 | 内容 |
|---|---|---|
| `GET …/conversations/{id}/offline?after_sequence=` | `offline.read` | `read_only: true`，持久事件；禁止离线排队写 |
| `GET …/conversations/{id}/notification-summary` | `notification.summary` | 终态、时间、operation id；无 prompt / 输出 / 路径 |

P1 不接 FCM / APNs。前台服务只把摘要变成本地通知。

## 3. 写命令与事件的对应

所有写都带客户端生成的 `operation_id`。重试同一 id 不得产生第二条输入。

| Companion 动作 | Control | 随后可见的事件（典型） |
|---|---|---|
| 新建会话 | `create` | `conversation_created`，可选 `conversation_input` / `user_turn_created` |
| 发送 / 排队 | `submit` | `conversation_input`（Submitted）；空闲则 `user_turn_created` → `user_turn_started` |
| 改未认领输入 | `submit` 更新 | `conversation_input`（Updated） |
| 取消排队输入 | 控制面取消输入 | `conversation_input`（Cancelled） |
| 纠偏在途 Turn | `steer` + `expected_turn_id` | `conversation_steering`；目标已变则 conflict，不改成排队 |
| 取消在途 Turn | `cancel` + `expected_turn_id` | `turn_cancelled` |
| 批/拒权限 | permission | `permission_responded`；Turn 继续或失败 |
| 回答提问 | question | `question_responded` |
| 打开只读 Artifact | 只读 fetch | 不写事件；预览租约是 Workstation 面 |

Companion **不得**：Git 写、终端、插件写、Workflow/Automation 写、改监听。
Host 用 scope fail-closed，不能只靠 UI 隐藏。

## 4. Conversation 事件目录与 Companion 折叠

客户端把事件折成时间线行。一行一个稳定 `row_id` + `revision`。文本 delta
合并进同一消息行，不每字一行。

| `kind` | Companion 呈现 | 备注 |
|---|---|---|
| `conversation_created` | 不单独成行；更新标题 | 标题可空 |
| `conversation_input` | 队列条：已提交 / 已更新 / 已认领 / 已取消 | 未认领可改可删 |
| `conversation_steering` | 纠偏条，挂在目标 Turn | Agent 不支持则 Host 报错，不得改成排队 |
| `conversation_relation_created` | 子会话卡片，可点开 | 只导航；不合并历史 |
| `agent_binding_started` | 状态：「正在启动 Agent」 | 含 agent id |
| `agent_binding_ready` | 去掉启动态 | 能力快照可用来显隐 steer |
| `agent_binding_recovered` | 简短恢复提示 | 策略：loaded / resumed / created / rebound |
| `agent_binding_recovery_failed` | 错误条 | |
| `agent_binding_load_failed` | 错误条 + 可重绑入口（若 Host 提供） | |
| `agent_connection_status_changed` | 顶栏连接，不是时间线行 | connecting / ready / recovering / error / closed |
| `user_turn_created` | 用户气泡（输入块） | 本轮开始 |
| `user_turn_queued` | 「已排队」 | 已有在途 Turn |
| `user_turn_started` | 去掉排队，进入在途 | |
| `assistant_text_delta` | 合并进助手消息 | 按 `message_id` |
| `assistant_reasoning_delta` | 思考块，默认折叠 | ADR-0058：不要当正文 |
| `assistant_content_appended` | 按块类型（图、资源链接） | 未知块保留 |
| `plan_updated` | 计划列表；status/priority 用协议字段 | 禁止一律写成 pending |
| `tool_call_upsert` | 工具卡片，按 tool id upsert | 进度/diff 只读 |
| `permission_requested` | **待办** + 时间线卡 | 必须能批/拒 |
| `permission_responded` | 卡变为已处理 | 任意设备互斥消解 |
| `question_requested` | **待办** + 结构化选项 | |
| `question_responded` | 已回答 | |
| `feedback_requested` | 若 Agent 发出则进待办 | |
| `feedback_submitted` | 已提交 | |
| `terminal_updated` | Companion **只读摘要**；不提供 PTY | 无终端 scope |
| `usage_updated` | 仅当字段存在时显示占用 | 缺失保持缺失，禁止填 0 |
| `file_change_summary_updated` | 「N 个文件」只读；点开看 diff 若有 artifact.read | 不能 commit |
| `artifact_revision_recorded` | 只读产物条目 | 无文件字节 |
| `artifact_preview_*` | Companion 可忽略或只读链到内容 | 预览租约不是 P1 必须 |
| `turn_blocked` | 待办角标；原因：权限/提问/认证 | |
| `turn_completed` | 结束条 | 终态之一 |
| `turn_failed` | 错误 + 可重试（新 Turn） | |
| `turn_cancelled` | 已取消 | |
| `turn_interrupted` | 已中断；**禁止自动重发** | ADR-0001 |
| `session_mode_updated` | Composer 模式，有则显示 | |
| `session_config_options_updated` | 选项，有则显示 | |
| `session_config_stale` | 通知：默认未生效 | 不假装已应用 |
| `prompt_capabilities_updated` | 决定能否 steer / 附图 | |
| `available_commands_updated` | 命令候选；无则空 | |
| `agent_session_info_updated` | 只回填 Agent 给出的 title 等 | 不本地猜标题 |
| `delegation_started` | 子会话卡 | 只读进入 child |
| `delegation_completed` | 卡上结果摘要 | |
| `raw_diagnostic_recorded` | 默认隐藏；诊断页可看 | 无 secret |

未知 `kind`：占位行「Host 更新了此会话」，payload 进只读缓存。

## 5. Snapshot

`SubscriptionSnapshot.payload` 是投影，不是另一套模型。最低字段：

- `conversation_id`、`title`、`through_sequence`
- 当前 Turn（id、状态）
- timeline rows（已折叠）
- 未认领 inputs
- 未处理 permission / question
- agent 连接状态、capabilities 快照

客户端：用 snapshot 填行，再用 replay/live 按 sequence 打补丁。本地行
`revision` 落后才应用。

## 6. 会话目录（开新会话所必需）

ADR-0054 未给 Companion `application.call`。没有只读目录就无法选
Project / Workspace / Agent。因此 Host 必须在 **conversation.read** 下提供
只读目录，而不是开放 `application.call`：

- 已添加且就绪的 Agent（id、显示名、是否 ready）
- 用户可见的 Project / Workspace（id、名称、目录路径、所属、分支）
- 某项目近 N 天会话（`conversation_list_recent`，默认 3 天）
- 无工作区会话是否可用（ADR-0006）

这是会话读模型的一部分，不是运维面。

## 7. Host 级信号（非 Conversation sequence）

这些不是 `conversation_events` 的一行：

| 信号 | 如何到达 | Companion |
|---|---|---|
| Reachability 名单变化 | 上线拉名单；新邀请合并 | 更新试探列表 |
| 设备撤销 | WS 断开 + 后续 401 | `auth_required`，清凭证需用户再配对 |
| Host 进程消失 | 连接失败 / attach 超时 | `offline`，只读缓存 |
| Agent 连接状态 | `agent_connection_status_changed` | 顶栏 |
| 终态通知 | 前台服务轮询 summary | 本地通知，无正文 |
| capabilities / 最低版本 | 每次连接 | `incompatible` 时禁用写 |

不要为「局域网 IP 变了」另做 WebSocket 事件；名单权威在 Host，客户端重连即拉。

## 8. 多设备与冲突

- 同一 Conversation 同一时刻至多一个在途 Turn。
- 两台 Companion 同时批同一权限：先到的生效，后到的 conflict / already resolved。
- 草稿：若开放 Composer 草稿，必须走 Host revision；冲突保留服务器与本机两份
  （ADR-0042 / 0058）。P1 可只做提交，不做跨设备草稿。
- Steering 必须带 `expected_turn_id`。

## 9. 安全

事件与 snapshot **不得**包含：管理员 token、device credential、pairing secret、
FRP token、原始环境密钥。`TerminalNotificationSummary` 不得包含 prompt、输出、
路径。公网 HTTP 由本机控制台在出邀请前确认，不在事件层另开例外。

## 10. 客户端状态机

```text
connecting → online → recovering → online
                ↘ offline
                ↘ auth_required
                ↘ incompatible
```

- 只有 `online` 可写。
- `recovering`：重 attach，保留当前投影。
- `offline`：展示缓存，时间戳为最后确认 sequence 时间。
- 试探 origin：上次成功 → 远程 HTTPS → 其余。

## 11. 验收

- 同一 golden fixture（桌面已有 conversation-projection）在 Kotlin reducer
  上得到相同 row_id / 终态。
- 未知 kind 不崩、缓存仍可读。
- 断线后用 `after_sequence` 续上，不丢、不双份气泡。
- `turn_interrupted` 没有自动重发。
- 权限在桌面与手机互斥消解。
