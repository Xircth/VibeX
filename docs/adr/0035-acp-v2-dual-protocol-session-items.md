---
status: accepted
date: 2026-08-02
decision-makers:
  - VibeX maintainers
---

# ACP V2 采用双协议适配器与 Session Item 语义核心

## Context

ACP 于 2026-07-20 发布 V2 Draft。V2 不是对 V1 方法名的整齐重命名，而是改变了
协议的基本工作模型：`session/prompt` 响应只确认消息已被 Agent 接受，前台工作的
运行、等待和结束由 `state_update` 通知表达；消息、工具调用、计划和 Agent 终端以
稳定 ID 执行 upsert；字段更新明确区分 omitted、`null` 和具体值；Agent 可以在
前台回到 idle 后继续产生后台更新。

V2 同时删除了 `session/load`、Session Modes、客户端文件系统和客户端终端执行
协议面。会话恢复统一为带可选 `replayFrom` 的 `session/resume`，Mode 统一为 Session
Config Option，需要客户端提供的文件、编辑器和命令能力通过 MCP server 暴露，ACP
中的 Terminal 变为 Agent 所有、只供显示的 Session Item。

VibeX 当前已经具备有价值的基础：

- Agent 运行统一经过 `AgentRuntime` 与连接管理器，并由经过验证的本地安装启动 stdio
  ACP 子进程；
- Conversation Event Log 是持久权威，Projection、side table 和 Timeline Row 都是
  可重建的读模型；
- Turn 已有 Completed、Failed、Cancelled、Interrupted 四个互斥终态；
- MCP delegation companion、权限、Elicitation、配置选项、终端和行级增量投影已经有
  可复用实现；
- `event_version` 与 Unknown 读取包装已经允许新版本事件在旧读取器中降级显示，而不是
  破坏整条时间线。

但当前 ACP 线路仍由 V1 的请求/响应形状主导：

- 一个大型连接管理模块同时负责进程、初始化、V1 方法调用、Prompt 生命周期、Agent
  请求和通知转换；
- `ProtocolVersion::LATEST` 当前等于 V1，项目没有显式启用 SDK 的
  `unstable_protocol_v2` feature；
- `session/prompt` 响应直接完成 Turn，发送 `session/cancel` 后立即宣告取消；
- Message/Thought 没有 Agent `messageId`，Plan 没有 `planId`，Terminal 仍是 V1
  客户端进程资源；
- `Option<T>` 与数据库 `COALESCE` 无法表达 V2 的“保持／清空／替换”三态 patch；
- 大多数 Agent 更新依附 active Turn，无 Turn 的后台活动不能形成完整可见投影；
- Resource 会被降级成 URI 文本，部分未知内容与诊断不会进入持久语义事件；
- `session/load`、`session/set_mode`、MCP SSE 和 V1 Client Terminal/FS 已经出现在领域
  或 UI 接口中，不能通过修改 RPC 名称自然演进到 V2。

ACP 官方明确把 V2 标为 Draft，要求实现同时使用版本协商和功能开关，不应默认在生产
启用，也不应因为增加 V2 而删除 V1。官方建议保留两个薄协议面，在 initialize 后按
每条连接选择一个版本，共享协议无关的应用逻辑。

## Decision drivers

本决策按以下优先级取舍：

1. **语义正确性优先于 1:1 迁移。** 产品需要可靠的长会话、恢复、后台活动、用户控制
   和可解释历史，而不是让每个 V1 方法都有一个同名 V2 包装。
2. **Event Log 继续是唯一历史权威。** Agent replay、内存 accumulator、数据库 side
   table 和前端 store 都不能成为第二权威。
3. **协议类型必须具有 locality。** V1/V2 wire 类型只能存在于各自 Adapter 内；核心
   不依赖某版 Schema。
4. **所有能力来自当次协商。** Agent 身份、Registry 元数据、历史 probe 和 SDK feature
   都不能冒充协商能力。
5. **Draft 变化必须可关闭。** 关闭 V2 不得破坏 V1 Agent、既有 Conversation 或 Agent
   管理管线。
6. **旧数据只兼容读取，不做破坏性重写。** 新投影可以重建，旧事件不能被“升级”成
   推测出来的新事实。
7. **未知不等于允许。** 前向兼容应保留未知数据并提供安全显示；权限、执行和认证上的
   未知值必须 fail-closed。

## Decision

### 1. V1 与 V2 作为两个真实 Adapter 并行存在

VibeX 在 ACP 连接处建立 `Protocol Session` seam，并提供两个 Adapter：

```text
ACP stdio connection
        |
        v
ProtocolNegotiator
        |
        +-- AcpV1Adapter ----+
        |                    |
        +-- AcpV2Adapter ----+--> SemanticSessionCore
                                      |
                                      v
                              Conversation Event Log
                                      |
                                      v
                              Projection / Row Ops
```

这是一个真实 seam：两个 Adapter 处理不同 Schema、方法集合和生命周期，但向
`SemanticSessionCore` 提供同一个小 interface。核心 interface 表达以下 intent 和
observation，而不是暴露整套 ACP RPC：

```text
SessionIntent
  Negotiate
  NewSession | ResumeSession | ListSessions | DeleteSession | CloseSession
  SubmitPrompt | RequestCancel | SetConfigOption | ForkSession

SessionObservation
  Negotiated | SessionLinked | PromptReceipt | ForegroundStateChanged
  MessagePatched | MessageContentAppended
  ToolCallPatched | ToolCallContentAppended
  PlanReplaced | TerminalPatched | TerminalOutputAppended
  PermissionRequested | ElicitationRequested
  ConfigOptionsReplaced | CommandsReplaced | SessionInfoPatched | UsageObserved
  UnknownUpdate | ProtocolError
```

该 interface 是 callers 与测试共同使用的测试表面。进程启动、JSON-RPC、SDK 类型、
V1 合成 ID、V2 patch 解码和 Draft 兼容都属于 Adapter implementation，不进入
Conversation 或前端。

版本协商遵循以下规则：

1. V2 只在编译 feature、全局运行时 feature 和 Agent/profile allowlist 三者都允许时
   作为 initialize 的最高版本发送；否则明确发送 V1。
2. Agent 响应 V1 时，同一连接选择 `AcpV1Adapter`；响应 V2 时选择
   `AcpV2Adapter`。initialize 后不得在同一连接切换版本。
3. V2 初始化在任何 Session 创建前因已知兼容问题失败时，可以终止进程并最多用 V1
   新建一次连接；该 fallback 必须记录原因，不能在同一连接二次 initialize。
4. 一旦 V2 Session 已创建或恢复，任何错误都不得静默切换到 V1 Session，因为二者
   不能证明共享隐藏上下文。此时使用正常恢复或用户确认的 Session rebind。
5. V1 不设退役日期。删除 V1 需要独立 ADR，并以 V2 稳定、主要 Agent 支持率和实际
   协商遥测为依据。

### 2. Turn 是前台用户意图，不再等同于整个 ACP 活动窗口

VibeX 保留 CONTEXT 中的 Turn 产品语义：一次用户发起到 Agent 对该前台工作的应答
结束；同一 Conversation 同时最多一个前台 Turn 在途。V2 的 Session 可以在没有
active Turn 时继续产生后台更新，这些更新属于 Conversation，但不自动创建、重开或
完成 Turn。

前台状态按以下状态机折叠：

```text
Queued -> Submitted -> Running <-> RequiresAction -> Idle(stop reason)
                       |                                  |
                       +------ cancel requested ----------+
```

- V2 `session/prompt` 空响应只产生 `PromptReceipt::Accepted`，不产生 Turn 终态；
- V2 `state_update(running)` 表示 Agent 正在处理前台工作；
- `requires_action` 表示 Agent 等待用户、权限或其它动作，不结束 Turn；具体交互内容仍由
  Permission/Elicitation 请求提供；
- 带 stop reason 的 `idle` 结束当前前台 Turn；`cancelled` 映射为 TurnCancelled，其它
  正常原因映射为 TurnCompleted 并保留原始 reason；
- `session/cancel` 只记录 CancelRequested；收到 `idle(cancelled)` 才确认
  TurnCancelled。等待期间继续接收并持久化更新；
- 取消后连接丢失时不能伪造 Cancelled，按既有失败/中断规则记录可证明的终态；
- V1 Adapter 在 Prompt 请求成功发出后合成 Running，在 V1 Prompt 响应返回时合成
  Idle；V1 没有证据时不伪造 Accepted observation；
- Agent/宿主崩溃仍遵循 ADR-0001：在途 Turn 成为 Interrupted，绝不自动重发。

### 3. Session Item 成为消息、工具、计划和终端的统一身份模型

新增 **Session Item** 概念：由 Agent Session 拥有、可在 Turn 内或 Turn 外更新、以
协议稳定 ID 识别的可见对象。首批类型为 Message、Thought、Tool Call、Plan 和
Display Terminal。

Item 身份至少由以下事实组成：

```text
conversation_id
agent_session_binding_id
item_kind
agent_owned_item_id
```

`messageId`、`toolCallId`、`planId`、`terminalId` 都按 opaque string 保存，VibeX 不
解析其格式。Item 可以带 `foreground_turn_id`，但该关联是可选属性，不是身份的一部分。
无 active Turn 的后台 Item 仍进入事件日志和投影。

V2 Agent 对用户消息的 `user_message`/`user_message_chunk` 是 canonical
acknowledgement。VibeX 使用本地 prompt id 与当次 acknowledgement 建立用户 Turn 到
Agent `messageId` 的映射，避免 replay 或多客户端观察时重复用户消息。

V1 缺少 ID 的 Message、Thought 和单 Plan 使用带命名空间的本地合成 ID。合成 ID 只
用于 VibeX 投影，标记 `identity_origin = synthesized_v1`，绝不发回 Agent，也不能被
解释为 Agent 提供的跨连接稳定身份。

### 4. Patch 必须显式表示 Unchanged、Clear 与 Set

所有 V2 patch 字段在语义核心中使用三态类型：

```text
FieldPatch<T>
  Unchanged
  Clear
  Set(T)
```

- wire 字段 omitted 映射 Unchanged；
- wire `null` 映射 Clear；
- 具体值映射 Set；
- whole-message content 的 `null` 或空数组按协议清空/替换；
- chunk observation 只执行 append，不被误建模成 Set；
- Tool Call 第一次出现即创建空 Item，再应用 patch；不再要求先收到独立 create；
- Plan update 按 `planId` 整体替换该 Plan 的 entries；
- Terminal snapshot 替换当前字节缓冲，Terminal chunk 在独立 base64 解码后追加。

持久事件保存显式 `FieldPatch` 变体；数据库 Projection 不能继续用 `Option<T>` 加
`COALESCE` 解释协议 patch。最终态 side table 可以保存 nullable 值，但 projector 必须
先执行三态语义。

### 5. Event Log 保存语义事实，Projection 以 Item ID 幂等折叠

ACP wire notification 先由 Adapter 变成 `SessionObservation`，再由 Application Core
映射为版本化 Conversation Event。`raw_json` 只作为有界诊断和未来恢复证据，不能替代
normalized event。

新事件遵循以下规则：

- Message、Tool、Plan、Terminal 事件携带稳定 Item ID；
- Turn 相关事件可以带 Turn ID，后台 Item 事件允许 Turn ID 为空；
- 同一 Item 的投影使用 Item ID upsert，Revision 使用 Conversation event sequence；
- Append 与 Replace/Clear 分开建模，前端 Row Op 不通过猜测 JSON 决定操作；
- Unknown V2 update、未知枚举和 `_meta` 在大小限制内保存；已知 discriminator 的畸形
  payload 是协议错误，不能伪装成 unknown；
- 旧 `ConversationEvent` 永久保持可读。启用新事件前提升 event version，并保留
  Unknown 升级提示；不回写或批量重写历史事件；
- Projection snapshot 和 side table 都可丢弃重建，schema 迁移采用 additive-first。

Timeline Row 从“每个 Turn 固定一条 Assistant 行”演进为按 Session Item ID 识别的行。
为了保持现有 UI 连续性，同一 Turn 内普通文本 Message 可以继续呈现为连续对话气泡，
但 row identity 与更新必须来自 Message ID，而不是仅来自 Turn ID。

### 6. Resume replay 在隔离 epoch 中折叠，禁止直接重复追加 chunk

V2 `session/resume` 使用两种明确模式：

- 不带 `replayFrom`：只重新连接，不要求历史重放；
- `replayFrom: { type: "start" }`：Agent 在响应前把完整历史作为普通
  `session/update` 重放，用于 V1 `session/load` 等价场景。

全量 replay 不能直接写入现有实时 accumulator，否则 Message/Terminal/Tool chunk 会
重复追加。V2 Adapter 必须：

1. 在发出带 `replayFrom` 的 Resume 时创建隔离 `ReplayEpoch`；
2. 从空状态按正常 Item reducer 折叠 replay 通知，并记录 replay 顺序；
3. 以 `session/resume` 响应作为 replay 完成屏障；
4. 将 replay 结果按 Item ID 与 VibeX 当前语义状态协调，只为缺失或变化的事实追加
   reconciliation event；完全相同的 Item 不产生新事件；
5. 屏障之后的通知进入 live reducer；
6. replay 失败时丢弃未提交 epoch，不污染既有 Event Log。

Replay epoch 中的历史 `state_update` 只用于恢复 Agent Session 的历史/当前观察，不能
创建、完成或取消一个 VibeX 当前 Turn；历史 replay 也不能重新打开已经结束的
Permission/Elicitation。只有 replay barrier 之后的 live observation 可以推进新的前台
Turn 和待决交互。

VibeX Event Log 仍是可见 Conversation 历史的权威。Agent replay 用于恢复 Agent Session
的 Item 状态和弥补缺失观察，不能覆盖用户明确标题、VibeX Turn 终态、权限决定、文件
checkpoint 或已经记录的本地事实。

### 7. Capability Snapshot 按 dialect 归一化但保留结构

新的能力模型至少包含：

```text
NegotiatedProtocol
  dialect: v1 | v2_draft
  protocol_version
  peer_info
  session_baseline
  optional_session_capabilities
  prompt_content_capabilities
  mcp_capabilities
  auth_methods
  extension_capabilities
  raw_meta
  capability_digest
```

归一化规则：

- V1 继续读取各自 bool/object marker；
- V2 出现 `capabilities.session` 即承诺 new/list/resume/close/prompt/cancel/update 基础方法，
  不再为 list/resume/close 保存虚假独立开关；
- V2 support marker 使用对象存在性判断，`null`/缺失均为 unsupported；
- delete、additional directories、Prompt 内容和 MCP 等可选能力继续精确门控；
- V2 没有 load、Client FS、Client Terminal、Session Modes 和 MCP SSE 能力；
- Draft/unstable feature 不能仅凭 `protocolVersion: 2` 开启，必须再由独立 capability 或
  feature flag 授权；
- 保存原始 bounded `_meta` 和 capability digest，但未知字段不自动授予权限。

Conversation Binding、Agent probe 和管理快照记录实际协商 dialect。Registry entry、
Built-in identity 和安装版本只作为兼容性/诊断输入，不能声明 runtime capability。

### 8. 内容、工具、计划和命令必须端到端无损

- Text、Image、Audio、Resource Link、Embedded Resource 五种标准内容类型在 Agent、
  Conversation Event、Projection、generated type 与 React 中保持结构化表示；
- Resource Link icons 与 annotation 在允许范围内保存；Resource 不再变成 URI 文本；
- 未知 content type 使用 bounded raw representation，并提供通用不可执行 UI；
- Tool Call content 支持 whole replacement、clear 与单项 chunk append；
- Tool status、Plan status/priority、Config category 和命令 input discriminator 都按开放
  enum 处理；
- V2 Slash Command `input` 按 tagged union 解码，已知 text 正常呈现，未知类型保留并
  禁用不理解的参数编辑。

### 9. V1 Client Terminal 与 V2 Display Terminal 是不同模块

V1 Client Terminal 是 Agent 请求 VibeX 创建、等待、终止和释放的本地进程资源；V2
Display Terminal 是 Agent 自己拥有、VibeX 只显示的 Session Item。二者不能共享一个
含控制方法的 interface。

- V1 Adapter 可以继续使用现有 Client execution terminal，直到 V1 单独退役；
- V2 Adapter 不广告或处理 `terminal/*` 与 `fs/*` Client RPC；
- V2 Display Terminal 只接受 patch/snapshot/chunk，UI 不提供 stdin、kill、wait 或
  release 控件；
- 每个 base64 chunk 独立解码为 bytes 后追加，不能先拼字符串再解码；
- 渲染使用隔离终端 emulator 或净化 transcript，并对缓冲、单 chunk、总输出设置上限；
- VibeX 产品自身的交互终端不因 ACP V2 而删除，但它不是 V2 ACP Client capability。

### 10. Client 工具统一通过有作用域的 MCP 暴露

V2 Agent 若需要读取文件、编辑未保存 buffer 或运行由 Client 提供的命令，VibeX 通过
传入 `session/new`/`session/resume` 的 MCP servers 提供，而不是复活已删除的 FS/Terminal
RPC。

- New 与 Resume 共用 `SessionEnvironment`：绝对 cwd、完整 additional directories 和
  MCP server 列表；
- V2 MCP descriptor 必须携带 `type`，仅支持已协商的 stdio/HTTP；SSE 只留在 V1
  Adapter 兼容面；
- delegation companion 继续走同一 MCP builder，不按 Agent 名称开启；
- MCP token 绑定 connection、Agent、Conversation 和允许根，沿用 ADR-0031 的撤销与
  路径限制；
- workspace-less Conversation 的 MCP 根目录仍受 ADR-0006 的专用 scratch 目录约束；
- MCP 工具调用仍经过 VibeX 权限政策，不能因从 ACP Client RPC 改为 MCP 而扩大权限。

### 11. Diff 与 Permission 使用独立领域模型

V2 Tool content 中的 Diff 映射为结构化 `FileChangeSet`：add、delete、modify、move、
copy，以及 text、binary、directory、symlink file type、MIME 和可选 `git_patch`。

ACP Diff 是“Agent 报告的修改”，VibeX checkpoint/git diff 是“工作区观测到的修改”。
二者分别保存并可核验，不互相覆盖，也不把 Agent 声明当作磁盘权威。

Permission Request 使用必需 title、可选 description、选项和开放 subject：

- `tool_call` subject 复用普通 Tool Patch reducer；
- `command` subject 显示 command、必需绝对 cwd 和可选关联，但不表示命令由 Client
  Terminal 执行；
- 缺失或未知 subject 使用通用提示并默认拒绝自动授权；
- 未知 outcome 永远不能解释为 approval；
- 本地和远程审批继续竞争同一个 pending permission，first-terminal-wins；
- 自动批准策略必须同时识别 option、subject 类型与作用域。

### 12. Mode 只作为 Config Option 的展示类别

语义核心不再暴露 `SetSessionMode` 或独立 Session Modes 状态。V2 使用
`session/set_config_option`，标识字段为 `configId`；`mode`、`model`、`model_config`、
`thought_level` 都是 category。

V1 Adapter 把 V1 Session Modes 转换为 category=`mode` 的语义 Config Option，并把
核心的 set-config intent 翻译回 `session/set_mode`。这样 UI 只保留一条配置数据流，
但 V1 wire 兼容仍由 Adapter 承担。

ADR-0023 的产品规则不变：保存的是经验证的新会话默认偏好，不是 Agent 原生配置；
失效 option 回退 Agent 默认并提示，不阻止就绪。

### 13. V2 Auth 不改变 VibeX 的只读认证政策

V2 `authMethods` 非空表示 Agent 提供 `auth/login` 与 `auth/logout`，但 VibeX 仍遵循
ADR-0012/0021：不启动账号登录、不调用注销、不接管外部凭据。VibeX 记录 methodId、
type 与能力事实，用于解释和就绪判断，不在本 ADR 增加登录 UI。

现有 Draft `auth/status` 继续作为独立 `AuthenticationObserver` Adapter，不与 V2
Schema 强行合并。保存配置、进入设置或创建真实会话前的只读观察规则保持不变；真实
AuthRequired 继续是当次 Session 的权威证据。

### 14. Extensibility、Transport 与资源限制

- 自定义 enum/tagged union 值必须以 `_` 开头；未知非下划线值作为未来标准值保留；
- 已知 discriminator 的缺字段/错类型 payload 返回协议错误；只有真正未知的 variant
  进入 unknown fallback；
- `_meta` 在 capability、content、tool、session update 等层按 namespaced、大小受限、
  可丢弃 JSON 保存，不能绕过能力或权限；
- stdio decoder 接受 JSON-RPC batch array，限制 batch 长度、单消息和总字节数；
- 生命周期消息不批量发送；请求取消与普通 RPC batch 分开处理；
- 本 ADR 不启用远程 ACP URL、HTTP 或 WebSocket Transport。ADR-0010 的本地 stdio
  启动边界保持不变；ADR-0033 的 VibeX Remote Protocol 也不是 ACP Transport。

### 15. Registry、安装和 Agent 身份与协议版本正交

ACP Registry 的 `v1/latest` URL 是 Registry API 版本，不随某条 Agent Connection
协商到 ACP V2 而改名。Installation Lock、Launch Gate、Binary 完整性、Managed/External
所有权和 Agent 身份规则保持不变。

安装/探测可以记录“该安装曾成功协商哪些 dialect”作为带时间的证据，但每次真实连接
仍必须 initialize。升级 Agent 后不保证旧 ACP Session 可跨 dialect 恢复；失败时遵循
ADR-0029 的显式 Session rebind，不能伪造上下文连续。

## Compatibility with existing ADRs

本 ADR 对下列决策的关系是：

| ADR            | 关系                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| ADR-0001       | 保留“不重放在途 Turn”；把 V1 `session/load` 实现假设替换为 dialect-specific Resume，并新增隔离 replay epoch |
| ADR-0003       | 保留 `crates/conversations` 对 Event Log、Turn 与 Projection 的所有权                                       |
| ADR-0005       | 保留 VibeX 复制事件的 Fork 语义；Agent `session/fork` 继续独立门控，不视为 V2 baseline                      |
| ADR-0006       | 保留 workspace-less scratch root；V2 MCP 必须服从相同路径范围                                               |
| ADR-0010       | 保留 Native/Adapter-backed topology 和本地 stdio 限制                                                       |
| ADR-0012、0021 | 保留安装/认证分离和只读认证；补充 V2 auth surface 的观察规则                                                |
| ADR-0020       | 保留所有 Agent 共用统一管线；V2 allowlist 只能控制 rollout，不能形成 Agent 专属业务逻辑                     |
| ADR-0023       | 保留 session default 语义；用统一 Config Option 取代独立 Mode 领域                                          |
| ADR-0029       | 保留 Conversation 不锁版本和显式 rebind；禁止在已建 V2 Session 后静默降为 V1                                |
| ADR-0031       | 保留 MCP delegation；统一进入版本化 SessionEnvironment builder                                              |
| ADR-0032       | Automation 仍产生真实 Turn；其完成以语义 Turn 终态为准，不以 Prompt RPC response 为准                       |
| ADR-0033       | Session Item 事件必须能经 Remote Protocol replay；ACP dialect 不泄漏成第二套前端业务协议                    |
| ADR-0034       | 保留完整能力快照、草案兼容层和 `_meta` 原则；取代其中 V1-only capability 列表与稳定能力 roadmap 的协议假设  |

若上述 ADR 的具体 V1 方法名与本文冲突，以本文为准；其产品不变量继续有效。

## Delivery and release policy

实施必须遵循配套的
[ACP V1 → V2 迁移与架构改进计划](../plans/2026-08-02-acp-v2-migration.md)。总体门禁为：

1. 先建立 V1 characterization fixture，再提取 Adapter；
2. 先让 V1 通过新 seam，再增加 V2，不同时重写核心和接入新协议；
3. 每个切片先写公共 interface 的失败测试，再做最小实现；
4. 新 Event 先验证旧 reader 的 Unknown 降级和 Projection rebuild；
5. V2 默认关闭，只对明确 allowlist 的测试 Agent/canary 开启；
6. 真实 Agent smoke 至少覆盖 V1-only、V1/V2 dual、V2 Draft 变体和畸形 peer；
7. V2 成为生产默认需要本 ADR 的后续评审，不因实现完成自动发生。

## Consequences

### Positive

- VibeX 的核心围绕 Session 状态与 Item 事实，而不是某一版 ACP 方法，未来协议变化集中
  在 Adapter；
- V2 后台工作、消息替换、流式工具内容、多计划、展示终端和结构化 Diff 可以完整进入
  Event Log 与 UI；
- V1 保持可用，Draft 变化可以按 Agent/feature 关闭；
- Resume replay、取消和 Prompt 完成具有可验证时点，减少重复内容和错误终态；
- Mode/Config、MCP/Client tool、Terminal display/execution 的职责不再重叠；
- 前向兼容保留未知信息，但安全相关未知值不会扩大权限。

### Negative

- 短期同时维护两套 Schema、fixture 和 Adapter，代码量与测试矩阵增加；
- Event、Projection、数据库 side table、generated types 和 React Timeline 都需要分阶段
  演进，不能只修改 ACP manager；
- V2 Draft 变化可能导致重复适配工作，因此默认关闭且必须记录 schema/revision；
- V1 缺少稳定 Message ID，只能使用有明确局限的合成身份；
- Agent replay 与 VibeX 权威历史需要 reconciliation module，不能直接转发通知；
- 一旦 V2 Session 已产生隐藏上下文，发生协议问题时无法无损自动降为 V1。

## Considered options

### 只升级 SDK，在现有 manager 中增加 V2 分支

否决。V1/V2 生命周期、Capability、Terminal、Mode 和 patch 语义不同；条件分支会让
协议知识继续扩散到 runtime、Conversation 和 UI，无法形成真实 seam。

### 把 V2 事件降级为现有 V1 AgentEvent

否决。该方案会丢失 messageId/planId、三态 patch、后台 Item、Prompt ack、Terminal
bytes 和未知变体，表面兼容但无法获得 V2 的主要功能价值。

### 为 V2 新建第二套完整 Runtime 和 Conversation 管线

否决。它会产生双 Event Log、双 Turn 状态机和双 UI，违反统一 Agent 管线与共享
Application Core 决策。变化只应存在于协议 Adapter。

### 立即删除 V1

否决。V2 仍是 Draft，V1-only peers 会长期存在，官方明确要求 side-by-side 支持。

### 等 V2 稳定后再做任何工作

否决。默认生产启用可以等待稳定，但 V1 已暴露的领域耦合、错误取消和 Turn/Session
混淆是当前架构问题。先提取 seam、修正语义核心和建立 fixture 能立即降低风险。

### 用公共最低能力集屏蔽所有 V1/V2 差异

否决。只保留两版交集会主动放弃后台活动、稳定身份、结构化 Diff、Terminal display
和三态 patch。共享核心应统一语义，不应抹平功能。

## Acceptance criteria

本 ADR 的实现只有满足以下条件才算完成：

1. 同一构建可连接 V1-only 与 V2 Agent，每条连接只使用协商版本。
2. V2 可在运行时完全关闭，关闭后所有 V1 characterization tests 与真实 smoke 不变。
3. `session/prompt` acknowledgement 不结束 Turn；只有 foreground idle 或错误规则产生
   Turn 终态。
4. 取消请求后继续接收更新，只有 `idle(cancelled)` 产生 TurnCancelled。
5. 无 active Turn 的 V2 Message、Tool、Plan、Terminal 可以持久化并显示。
6. Message、Tool、Plan、Terminal 分别以 Agent ID 幂等 upsert。
7. omitted、`null`、value 和 chunk append 在 Event、Projection、数据库与 UI 中语义
   一致。
8. `resume(replayFrom:start)` 不重复文本或终端 chunk，失败 replay 不污染 Event Log。
9. Resource、Resource Link、Audio、Image 和未知 Content 不再被静默丢弃或降级为 URI。
10. V2 不暴露 Client FS/Terminal RPC；Display Terminal 没有进程控制入口。
11. V2 MCP 只使用协商的 stdio/HTTP、显式 type 和受限路径；SSE 只存在于 V1 兼容面。
12. Mode UI 完全由 Config Options 驱动，核心没有第二套 Mode 状态。
13. 结构化 Diff 与 checkpoint diff 保持不同来源且都可呈现。
14. 未知 Permission subject/outcome 不会产生自动批准。
15. 已知畸形 variant 被拒绝，真正未知 variant 与 bounded `_meta` 可保存和安全显示。
16. 旧 Conversation Event 全部可读，Projection 可以从零重建相同结果。
17. Registry、安装锁、Launch Gate 和 Agent 身份没有因 ACP dialect 产生第二套逻辑。
18. V2 默认生产开关保持关闭，直到单独评审决定开启。

## Review triggers

发生以下任一事件时复审本 ADR：

- ACP V2 从 Draft 稳定；
- 官方 Rust SDK 更改版本协商或移除 `unstable_protocol_v2`；
- V2 Schema 改变 Prompt state、patch、replay 或 Terminal 的核心语义；
- 主要内置 Agent 提供无法由本 semantic interface 表达的新 Session 模型；
- VibeX 决定启用远程 ACP Transport；
- 有足够遥测支持讨论 V1 退役。

## Protocol references

- [ACP V2 Draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)
- [Migrating from V1](https://agentclientprotocol.com/protocol/v2/migration)
- [V2 overview](https://agentclientprotocol.com/protocol/v2/overview)
- [V2 initialization](https://agentclientprotocol.com/protocol/v2/initialization)
- [V2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)
- [V2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- [V2 tool calls](https://agentclientprotocol.com/protocol/v2/tool-calls)
- [V2 extensibility](https://agentclientprotocol.com/protocol/v2/extensibility)
- [V2 transports](https://agentclientprotocol.com/protocol/v2/transports)
- [V2 schema](https://agentclientprotocol.com/protocol/v2/schema)

最后核对：2026-08-02。
