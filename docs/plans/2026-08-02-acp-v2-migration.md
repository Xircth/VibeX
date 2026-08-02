# ACP V1 → V2 迁移与架构改进计划

**状态：** 规划完成，尚未实施。

**日期：** 2026-08-02。

**决策依据：**
[ADR-0035：ACP V2 采用双协议适配器与 Session Item 语义核心](../adr/0035-acp-v2-dual-protocol-session-items.md)。

**目标：** 在不降低 V1 兼容性、不破坏既有 Conversation 历史的前提下，为 VibeX
增加可关闭的 ACP V2 Draft 支持，并把会话核心从 V1 Prompt/Turn 响应模型升级为
ID 驱动、可 replay、支持后台活动的 Session Item 模型。

**交付原则：** 纵向 TDD；每个提交只有一个可观察行为变化；每个提交结束时 V1 默认
路径可编译、可运行、已有测试通过。V2 在本计划完成后也不自动成为生产默认。

## 1. Problem statement

当前 ACP 实现可以稳定运行 V1 Agent，但协议知识集中在大型连接管理 implementation，
并已经进入 Conversation Event、Projection、数据库 side table、Tauri event 和 React
会话控制：

- 初始化使用 V1 Schema 和 `ProtocolVersion::LATEST`；
- Session 恢复优先 `session/load`，其次 V1 `session/resume`；
- Prompt response 携带 stop reason 并直接完成 Turn；
- 取消在 notification 发出后立即完成 Turn；
- Message/Thought 没有 Agent ID，Plan 是单一列表；
- Tool update、Terminal output 和部分 Content 被压平为 V1 形状；
- Session Modes 与 Config Options 是两套后端和前端状态；
- Client Terminal/FS、MCP stdio/HTTP/SSE 与 delegation 注入由同一 V1 builder 决定；
- `Option<T>` 与 SQL `COALESCE` 不能表达 V2 patch 的显式清空；
- active Turn 为空时，后台 Agent activity 不能形成完整 Timeline Projection。

直接在现有 manager 中加入 V2 分支只能“让请求发出去”，不能获得 V2 的功能价值，且会
让两版协议条件扩散到每个 caller。迁移必须先形成真实 Protocol Session seam，再让
V1/V2 Adapter 共享一个语义核心。

## 2. Scope

### In scope

- ACP V1/V2 initialize 协商和一连接一版本；
- V1/V2 分离的 wire schema、Adapter 和 fixtures；
- Prompt acknowledgement、foreground state、取消确认与后台更新；
- Session new/list/resume/close/delete 与隔离 replay reconciliation；
- Message、Thought、Tool Call、Plan、Display Terminal 的 Session Item 身份；
- omitted/null/value/chunk 四种更新语义；
- Event Log、Projection、derived read model、Row Ops 和 React Timeline 演进；
- 无损 Content、流式 Tool Content、结构化 Diff、V2 Permission subject；
- V1 Client Terminal 与 V2 Display Terminal 分离；
- V2 MCP stdio/HTTP、受限 Client tools 和现有 delegation companion；
- Mode 收敛到 Config Option；Slash Command、Auth、Usage、Session Info 与 unknown
  extensibility；
- Feature flags、诊断、兼容回退、fixture/real-Agent 测试与 rollout 门禁；
- 相关 CONTEXT、ADR、generated type 和 SQLx metadata 更新。

### Out of scope

- 删除 V1 或制定 V1 退役日期；
- 把 ACP V2 在本计划结束时设为所有用户默认；
- 远程 ACP URL、ACP-over-HTTP/WebSocket 或用户自定义启动命令；
- 改变 Agent Registry API 版本、安装锁、完整性或 Agent 身份模型；
- 由 VibeX 发起 `auth/login`、`auth/logout`、浏览器/设备码登录；
- 把 Agent Display Terminal 变成可输入、kill 或 wait 的 Client terminal；
- 自动把既有 V1 Agent Session 转换为 V2 隐藏上下文；
- 为某个 Agent kind 编写专属 V2 业务分支；
- Workflow Graph、并发前台 Turn 或自动 merge/push/deploy；
- 改变 ADR-0001 的“中断 Turn 绝不自动重发”。

## 3. Current-state inventory

| Area            | Existing module/interface                                     | Reuse                                          | Required change                                     |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Process/launch  | Agent runtime、connection manager、Launch Gate                | 完整复用验证与 stdio 启动                      | 把版本协商和 wire handler 移入 Adapter              |
| Capabilities    | V1 capability normalizer、capability snapshot                 | 复用 raw `_meta` 上限与快照持久化              | 新建 dialect-aware capability model                 |
| Auth            | `AuthenticationObserver`、Draft `auth/status` Adapter         | 保留稳定观察 interface                         | 初始化解析版本化；V2 authMethods 只记录不执行       |
| Session         | new/load/resume/list/delete/close/fork                        | 复用 Session identity、binding 和恢复错误      | 用语义 open/resume intent；V2 删除 load             |
| Prompt          | Runtime queue、one-foreground-turn、idle watchdog             | 保留队列和 Turn 单飞                           | 完成由 state observation 驱动，不由 RPC future 驱动 |
| Events          | Agent event envelope、Conversation Event Log                  | 保留 sequence/idempotency/raw evidence         | 增加 ID/Patch/State/Unknown 语义事件                |
| Projection      | Event reducer、snapshot、row upsert/append                    | 保留 Event Log 权威和 revision                 | 从 Turn-only 行扩展为 Session Item 行               |
| Tool/permission | Tool upsert、pending permission、远程审批                     | 保留 first-terminal-wins 与卡片                | 三态 patch、content chunks、开放 subject/outcome    |
| Elicitation     | Form-mode request/response                                    | 保留 capability gate 和 UI                     | 增加 V2 wire Adapter fixture                        |
| Terminal        | Client process registry、Terminal UI                          | V1 Adapter 和产品终端继续复用                  | 新建无控制 interface 的 Display Terminal            |
| MCP/delegation  | Session 注入 builder、`vibex-mcp`、Broker                     | 保留 token/路径/生命周期策略                   | 版本化 descriptor；V2 仅 stdio/HTTP 和显式 type     |
| Config          | Session Modes + Config Options                                | 复用 Config Option selector/default repository | V1 Mode 转成语义 Config Option；删除双数据流        |
| Content         | Text/Image、raw Protocol fallback                             | 复用内容大小约束                               | 五种标准类型无损；unknown bounded raw               |
| Frontend        | Timeline row store、revision、AppendText                      | 保留增量协议                                   | 行身份改为 Item ID，增加 Replace/Clear/background   |
| Tests           | manager/runtime unit、ACP fixture、projection fixture、Vitest | 全部作为 V1 characterization 基线              | 加 V2 wire/replay/patch/terminal/batch matrix       |

## 4. Target modules and interfaces

### 4.1 ProtocolNegotiator module

**Interface：** 输入经过 Launch Gate 的 transport、Client info、允许的最高 dialect 和
Client semantic capabilities；输出 negotiated dialect、peer info、normalized
capabilities 与选定的 Protocol Session Adapter。

**Implementation：** 负责 raw initialize、V1/V2 response decoding、握手 timeout、
before-session V1 fallback、schema/Draft revision 诊断。调用者不知道
`clientCapabilities`/`agentCapabilities` 与 V2 `capabilities`/`info` 的差异。

### 4.2 ProtocolSessionAdapter module

**Interface：** 接收 `SessionIntent`，输出有序 `SessionObservation` stream。它保证：

- 所有 observation 已脱离 wire Schema；
- Item ID 在 binding 内稳定；
- V1 缺失身份带明确 synthetic origin；
- V2 patch 保留三态；
- 已知畸形 payload 返回 typed protocol error；
- 未知 variant 和 `_meta` 在限制内可保存；
- 一次 connection 永远只有一个 Adapter。

**Adapters：** `AcpV1Adapter`、`AcpV2Adapter`、测试用 scripted adapter。

### 4.3 SemanticSessionCore module

**Interface：** 接收产品 intent 与 Adapter observation，返回要追加的 Conversation
Events、interaction requests 和 connection actions。它拥有：

- foreground state reducer；
- Prompt receipt 与 User Message acknowledgement 关联；
- CancelRequested 到 Cancelled confirmation；
- Session Item reducer；
- replay epoch 和 reconciliation；
- background Item/Turn 归属；
- Config Option、Command、Usage、Session Info 语义。

它不拥有进程启动、JSON-RPC、SQLite 或 React。

### 4.4 Conversation Projection module

**Interface：** 继续输入有序 Conversation Event Records，输出 Revisioned Row Ops 与
可重建 snapshot。新增 Item ID upsert、content replace/clear/append、session-level
background rows；旧事件继续使用兼容 reducer。

### 4.5 SessionEnvironment module

**Interface：** 根据 Conversation、Workspace、Agent capability 和 delegation policy
生成一次 New/Resume 使用的绝对 cwd、完整 additional directories、MCP descriptors
和 scope digest。V1/V2 Adapter 只负责 wire encoding。

## 5. Test seams and quality rules

在写第一条生产实现前锁定以下测试表面：

1. **Protocol fixture seam**
   - raw JSON-RPC stdin/stdout fixture；分别维护 V1 与 V2 transcript；
   - 测试版本协商、方法、notification、batch、unknown、malformed 和资源上限；
   - 不通过 mock SDK 私有类型证明兼容。
2. **Semantic session seam**
   - scripted Adapter 输入 observation，断言 Conversation Events/Actions；
   - 覆盖 state、cancel、replay、patch、background、permission；
   - 不断言内部 map 或私有 helper 调用顺序。
3. **Projection seam**
   - 从真实事件 fixture 建库/重建，断言 Timeline Rows 和 side records；
   - live append 与 full replay 必须得到相同最终投影；
   - rollback reader 必须把高 event version 降级为 Upgrade Notice。
4. **Application Core seam**
   - 通过 Conversation/Agent use case 发起 Turn、取消、Resume 和配置变更；
   - 使用 scripted Adapter，不能从 Tauri command 绕过核心。
5. **Tauri/Remote adapter seam**
   - 验证 generated DTO、稳定 error code 和 event/row-op serialization；
   - Tauri 与未来 Web adapter 消费同一 Application Core observation。
6. **React seam**
   - 通过用户可见 Timeline、Permission、Config、Terminal 和 background activity 交互；
   - mock conversation interface/transport，不 mock 组件内部 hook。
7. **Real Agent smoke seam**
   - 观察 negotiated dialect、Session 能力、Prompt 完成、取消、Resume 和无残留进程；
   - Agent 不支持某项能力时必须诚实降级，不使用名称白名单冒充支持。

所有测试遵循：测试公开行为，不测试私有调用顺序；协议 fixture 与领域 fixture分离；V1
与 V2 的 wire fixture 不共享 JSON 后再靠条件字段区分。

## 6. Phase overview

| Phase | Outcome                                                           | V2 runtime state  |
| ----- | ----------------------------------------------------------------- | ----------------- |
| 0     | 文档、fixture、feature flag、V1 characterization 完整             | 未编译/关闭       |
| 1     | Protocol Session seam 与 V1 Adapter 落地，行为不变                | 关闭              |
| 2     | SDK V2、协商与 capability truth 落地                              | 只在 fixture 开启 |
| 3     | V2 Session、Prompt、Cancel、Resume/Replay 可运行                  | 开发 allowlist    |
| 4     | Session Item Event/Projection/数据迁移完成                        | 开发 allowlist    |
| 5     | Content、Tool、Plan、Terminal、Diff、Permission、MCP、Config 完整 | 内置 canary       |
| 6     | Tauri/React/Remote projection 完整，旧 UI 双轨删除                | opt-in preview    |
| 7     | 真实 Agent、性能、安全、rollback 与发布证据                       | opt-in preview    |
| 8     | 稳定化评审与清理                                                  | 仍不自动默认      |

## 7. Detailed commit plan

以下每个编号代表一个独立提交。提交不得同时跨入下一项；若单项仍过大，实施时继续按
Red test、domain implementation、adapter integration 拆分，但不能把多个编号合并成
一次大提交。

### Phase 0 — Guardrails and characterization

| ID  | Commit intent                                      | Red/characterization test                                                       | Minimal change and exit condition                                      |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 0.1 | `docs(acp): record v2 domain vocabulary`           | 文档链接检查发现 ACP dialect、Session Item、Prompt receipt、Replay epoch 未定义 | 更新 CONTEXT 术语并互链 ADR/计划；不改代码                             |
| 0.2 | `test(acp): freeze v1 initialize fixtures`         | 当前 fixture 不能逐字段证明 initialize/capability/auth status                   | 保存脱敏 V1 raw request/response 与期望 normalized capability          |
| 0.3 | `test(acp): freeze v1 session lifecycle fixtures`  | 当前测试不能复现 new/load/resume/prompt/cancel/mode/terminal                    | 增加 V1 正常、错误、取消、权限、终端 transcript，只做 characterization |
| 0.4 | `test(acp): add v2 baseline wire fixtures`         | 项目不能读取官方 V2 initialize/session examples                                 | 增加与官方 Schema revision 绑定的 V2 fixture，不接生产 runtime         |
| 0.5 | `test(conversations): freeze v1 event projections` | Message/Tool/Plan/Terminal 旧事件缺少完整 rebuild golden                        | 补齐旧 Event Log → Timeline/side table fixtures，确认当前结果          |
| 0.6 | `feat(acp): add disabled v2 rollout configuration` | 缺少配置时无法证明 V2 默认关闭                                                  | 增加 compile/runtime/agent allowlist 三层只读决策对象；默认返回 V1     |

**Phase 0 verify：**

```text
cargo test -p agents management_fixture
cargo test -p agents capability_normalization
cargo test -p conversations projection
cargo test -p db conversation_projection_fixtures
```

### Phase 1 — Extract the real seam and keep V1 behavior

| ID  | Commit intent                                             | Red test                                                      | Minimal change and exit condition                                                        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1.1 | `feat(acp): define protocol dialect and semantic ids`     | 无法在不导入 V1 Schema 时表示 dialect/item identity           | 只增加协议无关类型和序列化测试，尚不接 runtime                                           |
| 1.2 | `feat(acp): add explicit field patch reducer`             | `Option` 不能区分 unchanged/clear/set                         | 增加 `FieldPatch` 与 table-driven reducer tests                                          |
| 1.3 | `feat(acp): introduce protocol session interface`         | Runtime test 必须构造真实 SDK connection                      | 增加 scripted Adapter，Runtime 可通过 interface 观察事件                                 |
| 1.4 | `refactor(acp): move v1 initialization behind adapter`    | V1 fixture 不能通过新 seam 初始化                             | 移动 initialize/capability decoding；生产行为与 JSON 不变                                |
| 1.5 | `refactor(acp): move v1 session lifecycle behind adapter` | new/load/resume/list/close/delete 测试仍调用 manager 私有方法 | Adapter 消费 semantic intent 并发出 V1 RPC；结果保持一致                                 |
| 1.6 | `refactor(acp): move v1 prompt lifecycle behind adapter`  | Prompt 只能由 manager response future 结束                    | V1 Adapter 合成 Running/Idle observation，核心仍生成旧终态                               |
| 1.7 | `refactor(acp): isolate v1 client request bridge`         | Permission/Elicitation/Terminal/FS handler 无法单独测试       | V1 bridge 成为 Adapter 内部 module；行为和错误码不变                                     |
| 1.8 | `refactor(acp): reduce connection manager to composition` | 删除 Adapter 后复杂度会重新散到 manager caller                | manager 只组装 process、negotiator、adapter、core 和 command channel；全部 V1 tests 通过 |

**Phase 1 release gate：** 真实 Codex、Claude Code、OpenCode、Pi 的 V1 smoke 与迁移前
一致；V2 仍不可由生产配置开启。

### Phase 2 — SDK feature, negotiation and capability truth

| ID  | Commit intent                                             | Red test                                                        | Minimal change and exit condition                                     |
| --- | --------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| 2.1 | `build(acp): enable v2 schema with explicit v1 selection` | 启用 SDK feature 后 `LATEST` 编译失败或隐式变化                 | 启用 `unstable_protocol_v2`，所有既有调用显式 `V1`，行为不变          |
| 2.2 | `feat(acp): negotiate one dialect per connection`         | V2 request/V1 response 无法选择 V1 Adapter                      | raw initialize negotiator 解码 protocolVersion 并锁定 Adapter         |
| 2.3 | `feat(acp): decode v2 initialization`                     | V2 `info/capabilities` 被 V1 decoder 拒绝                       | V2 Adapter 读取必需 info、capabilities、authMethods 和 `_meta`        |
| 2.4 | `feat(acp): normalize versioned capabilities`             | V2 object marker 被当 bool，baseline list/resume/close 变 false | 新 normalized model 和 V1/V2 table tests                              |
| 2.5 | `feat(acp): persist negotiated dialect evidence`          | Binding/probe 无法解释实际使用 V1 还是 V2                       | 快照记录 dialect、peer info、schema revision 和 capability digest     |
| 2.6 | `feat(acp): enforce v2 rollout gates`                     | 非 allowlist Agent 在全局开关开启时也会尝试 V2                  | 编译、运行时、Agent 三层都允许才发送 V2                               |
| 2.7 | `feat(acp): add pre-session v1 reconnect fallback`        | 畸形/旧 V1 peer 在 V2 initialize 前失败后永久不可用             | 仅在 Session 未创建时允许一次新进程 V1 retry，并记录 typed diagnostic |

**Phase 2 verify：** V1-only fixture 回答 V1、dual fixture 回答 V2、V2 关闭时永远发送
V1、initialize 以后无法切换 Adapter。

### Phase 3 — V2 session and foreground lifecycle

| ID   | Commit intent                                         | Red test                                                             | Minimal change and exit condition                                                                   |
| ---- | ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 3.1  | `feat(acp): build one session environment`            | New 与 Resume 产生不同 cwd/root/MCP 列表                             | 引入环境 builder 和 scope digest；V1 编码保持原值                                                   |
| 3.2  | `feat(acp): implement v2 new list close delete`       | V2 baseline session fixture method-not-found                         | 编码基础方法；delete 仍按 capability 门控                                                           |
| 3.3  | `feat(acp): implement v2 resume without replay`       | 已知 Session 不能重新附着                                            | Resume 发送完整 cwd/additional roots/MCP；响应配置进入核心                                          |
| 3.4  | `feat(acp): add isolated replay epoch`                | replay chunk 直接追加导致文本/终端重复，历史 state 错误结束当前 Turn | Resume(start) 期间 observation 只进入空 epoch，历史 state/interaction 不推进当前 Turn，响应前不提交 |
| 3.5  | `feat(acp): reconcile completed replay`               | 相同 replay 重复生成事件，变化 replay 无法修复缺失 Item              | 以响应为 barrier，按 Item ID 生成 no-op/missing/changed reconciliation                              |
| 3.6  | `feat(acp): treat prompt response as receipt`         | V2 `{}` response 导致 TurnCompleted                                  | 只生成 Accepted receipt；Turn 保持 in-flight                                                        |
| 3.7  | `feat(acp): drive foreground turn from state updates` | running/requires_action/idle 不改变正确状态                          | reducer 处理状态转换；idle stop reason 唯一结束正常 Turn                                            |
| 3.8  | `fix(acp): confirm cancellation on idle cancelled`    | cancel notification 立即写 TurnCancelled                             | 增加 CancelRequested，继续消费更新，idle(cancelled) 才终态                                          |
| 3.9  | `feat(acp): accept session updates while idle`        | 无 active Turn 的 update 没有持久输出                                | observation 允许 `foreground_turn_id = None` 并进入事件管线                                         |
| 3.10 | `feat(acp): keep fork independently gated`            | V2 session 被误认为必有 fork                                         | Fork capability/feature 独立；无能力时保持既有冷分叉提示                                            |

**Phase 3 failure rules：** replay 未完成时断连则丢弃 epoch；V2 Session 建立后禁止自动
V1 fallback；取消等待超时不得伪造 Cancelled；任何自动重试都不得重发 Prompt。

### Phase 4 — Session Item events, storage and projection

| ID   | Commit intent                                            | Red test                                                    | Minimal change and exit condition                                      |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| 4.1  | `feat(events): introduce v2 event schema version`        | 旧 reader 读取新事件导致整条 Timeline 失败                  | 提升 writer event version，先证明旧 reader 显示 Upgrade Notice         |
| 4.2  | `feat(events): add session item identity events`         | Message/Tool/Plan/Terminal 不能共享 binding-scoped identity | 增加 item key、origin、optional Turn link 和 serde tests               |
| 4.3  | `feat(events): persist message patch and chunks`         | replace/clear/append 得到相同结果                           | 独立事件变体和 reducer table tests                                     |
| 4.4  | `feat(events): bind user message acknowledgements`       | Prompt 用户消息 replay 后重复                               | 保存 local prompt → canonical messageId 映射；相同 ack 幂等            |
| 4.5  | `feat(db): add derived session item read model`          | 无 Turn Item 无法查询，Item ID 无唯一约束                   | additive migration；唯一键含 Conversation/binding/kind/item ID         |
| 4.6  | `feat(projection): project message rows by message id`   | 两条 Agent message 被合并到同一 Turn assistant row          | Item ID 决定 row identity；普通同 Turn 文本保持连续视觉顺序            |
| 4.7  | `feat(projection): support replace clear and append ops` | 前端只能 AppendText/whole Upsert，clear 无法表达            | 增加显式 Row Op，revision 仍单调且重复应用幂等                         |
| 4.8  | `feat(events): project tool patches by tool call id`     | null 不能清除 output/location/meta                          | projector 执行 FieldPatch 后写最终 side record，移除 COALESCE 语义依赖 |
| 4.9  | `feat(events): project multiple plans by plan id`        | 每次 Plan update 追加新 block                               | 每 planId 一行/块，update 全量替换 entries                             |
| 4.10 | `feat(events): project display terminals by terminal id` | Terminal update 产生重复 summary row                        | Item ID upsert、snapshot replacement、byte-chunk append                |
| 4.11 | `feat(events): preserve unknown session updates`         | Raw diagnostic/unknown variant 被过滤                       | bounded Unknown event、generic row、known-malformed protocol error     |
| 4.12 | `feat(projection): reconcile background item ordering`   | Turn 为空的 Item 存在日志但不可见                           | 增加 session-level row order，Turn link 后到时可以 patch               |
| 4.13 | `test(projection): prove live replay equivalence`        | 同一 transcript live 与 rebuild 输出不同                    | golden test 比较 Timeline、side records、high-water mark 和 snapshot   |

**Migration policy：** 不重写旧 Event Log。旧 V1 event 在 compatibility projector 中生成
synthetic Item identity；新 side table 只做 derived read model。切换前保留旧 table 的
读取兼容，确认全量 rebuild 后再由后续清理提交删除无用列/表。

### Phase 5 — Complete V2 functional surfaces

| ID   | Commit intent                                                | Red test                                            | Minimal change and exit condition                                      |
| ---- | ------------------------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------- |
| 5.1  | `feat(acp): preserve all standard content blocks`            | Resource 变 URI、Audio/Resource Link 丢字段         | Agent/Event/Projection/DTO 端到端五类 content golden                   |
| 5.2  | `feat(acp): stream tool call content items`                  | Tool content chunk 需重发整个数组                   | 独立 append observation；whole content Set/Clear 可覆盖 accumulator    |
| 5.3  | `feat(acp): model structured file changes`                   | delete/move/binary diff 无法表达                    | FileChangeSet 与 add/delete/modify/move/copy/fileType/mime/patch tests |
| 5.4  | `feat(conversations): correlate reported and observed diffs` | ACP diff 覆盖 checkpoint diff 或被后者覆盖          | 保存 source 与 correlation，UI 可同时展示差异                          |
| 5.5  | `feat(acp): decode v2 permission subjects`                   | title/description/command subject 被压成 tool title | 独立 Permission model，tool_call subject 进入同一 Tool reducer         |
| 5.6  | `fix(permissions): fail closed on unknown v2 values`         | 未知 subject/outcome 被 auto policy 接受            | generic prompt、未知 outcome 永不 approval、scope-aware policy tests   |
| 5.7  | `feat(acp): add agent display terminal bytes`                | 分裂 UTF-8、binary、snapshot replacement 乱码或重复 | 每 chunk 独立 base64 decode、byte buffer、exit patch 和限制测试        |
| 5.8  | `refactor(acp): split execution and display terminals`       | Display terminal 暴露 kill/stdin 方法               | 两个 module/interface；V1 才能访问 execution controls                  |
| 5.9  | `feat(acp): encode versioned mcp descriptors`                | V2 仍发 SSE 或缺 type                               | V1 保持 stdio/HTTP/SSE；V2 只按 capability 发 stdio/HTTP tagged config |
| 5.10 | `feat(mcp): expose scoped client tools for v2`               | V2 Agent 缺 Client FS/command 功能或获得过宽路径    | MCP tools 绑定 SessionEnvironment roots、token 和 permission policy    |
| 5.11 | `refactor(acp): normalize v1 modes as config options`        | 核心仍需 SetMode 和 SetConfig 两个 intent           | V1 Adapter 双向转换，核心/DTO 只保留 Config Option                     |
| 5.12 | `feat(acp): implement v2 config option updates`              | configId/category/依赖 options 更新不完整           | set response 与 update 都替换完整有效 options，保存 default 继续校验   |
| 5.13 | `feat(acp): decode tagged slash command input`               | 未知 command input 让命令列表反序列化失败           | text 正常、unknown 保留且不可编辑、known malformed 拒绝                |
| 5.14 | `feat(acp): observe v2 auth methods without login actions`   | authMethods 被当成已登录或出现登录按钮              | 只记录 methodId/type；现有 auth/status/local provider 规则不变         |
| 5.15 | `feat(acp): preserve usage and session info observations`    | dialect 切换后 title/usage 语义漂移                 | 统一 observation；用户标题优先，usage 仍是 Agent 报告而非账单          |
| 5.16 | `feat(acp): accept bounded json-rpc batches`                 | V2 batch array 让 stdio decoder 断连                | 顺序 dispatch、batch/message/byte limits、生命周期发送不 batch         |

### Phase 6 — Application adapters and React cutover

| ID   | Commit intent                                                    | Red test                                                                   | Minimal change and exit condition                                          |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 6.1  | `feat(types): generate session item contracts`                   | Rust 新事件无法被 TS exhaustively 处理                                     | 生成新 DTO/Row Op；禁止手改 generated file                                 |
| 6.2  | `feat(tauri): forward item row operations`                       | Tauri event map 丢 messageId/planId/terminal bytes                         | adapter 只转换 stable core output，不重新实现 reducer                      |
| 6.3  | `feat(conversation-ui): key message rows by item id`             | replace/clear 更新错误气泡                                                 | store reducer 按 row ID/revision 幂等处理                                  |
| 6.4  | `feat(conversation-ui): render background activity`              | idle 后 Item 无可见归属                                                    | 增加 session-level activity row/section，不伪造 Turn                       |
| 6.5  | `feat(conversation-ui): render multiple plans and tool chunks`   | Plan 重复、Tool 内容刷新闪烁                                               | planId/toolCallId keyed components 与 append/replace tests                 |
| 6.6  | `feat(conversation-ui): render structured diffs and permissions` | binary/move/command subject 只能显示 raw JSON                              | typed cards；unknown 使用安全通用视图                                      |
| 6.7  | `feat(conversation-ui): render display-only terminals`           | V2 terminal 卡片出现 kill/input 控件                                       | isolated viewer/sanitized transcript，无进程控制                           |
| 6.8  | `refactor(conversation-ui): unify mode and config selectors`     | Session Mode/Config store 发生双写                                         | category=mode 使用相同 selector 数据流，保留视觉快捷入口                   |
| 6.9  | `feat(remote): preserve new events in versioned transport`       | Web/移动 attach 遇新事件断流                                               | capability/version gate、unknown preservation、after-sequence replay tests |
| 6.10 | `refactor(acp): remove obsolete dual ui paths`                   | 全仓仍有核心 SetSessionMode、V2 terminal controls 或 Turn-only assumptions | 只在 V1 Adapter 内保留 V1 wire 名称；删除前有完整 UI tests                 |

### Phase 7 — Rollout, observability and real-Agent validation

| ID  | Commit intent                                       | Red/test                                                  | Minimal change and exit condition                                                                   |
| --- | --------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 7.1 | `feat(acp): add redacted protocol diagnostics`      | 无法解释为什么选择 dialect/fallback                       | 记录 dialect、peer version、capability digest、schema revision、fallback code；不记 secrets/content |
| 7.2 | `feat(acp): add lifecycle consistency metrics`      | Prompt 永久 Running、cancel/replay 重复无法发现           | 统计非法 transition、cancel latency、replay no-op/change、background item 和 protocol error         |
| 7.3 | `test(acp): add adversarial v2 fixture matrix`      | malformed known、unknown future、batch limit 等路径无覆盖 | fixture 覆盖官方 SDK checklist 的全部异常                                                           |
| 7.4 | `test(acp): run v1 and v2 compatibility matrix`     | 某 feature 组合只在单版本工作                             | V1-only、dual→V1、dual→V2、V2 feature absent/present、init failure matrix                           |
| 7.5 | `test(acp): smoke built-in agents`                  | 内置 Agent 实际协商/Resume/Cancel 未知                    | 对可用版本逐 Agent 留存脱敏 evidence；能力缺失诚实降级                                              |
| 7.6 | `test(acp): smoke generic registry distributions`   | Binary/npx/uvx 启动与 V2 feature 交互未知                 | 每种分发至少一个 Agent，验证 Launch Gate 与进程清理                                                 |
| 7.7 | `test(acp): validate restart and rollback`          | V2 事件后旧 build、重启、关闭开关行为未知                 | 高版本事件显示 upgrade notice；关闭 V2 后旧 Conversation 可读，V1 新 Turn 可运行                    |
| 7.8 | `docs(acp): publish canary evidence and known gaps` | 无证据就可能把 V2 设为默认                                | 记录 Agent/版本/平台/能力/失败，明确默认仍关闭                                                      |

### Phase 8 — Stabilization review and cleanup

| ID  | Commit intent                                     | Required evidence                                             | Minimal change and exit condition                                            |
| --- | ------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 8.1 | `refactor(acp): delete obsolete v1 leakage`       | V1/V2 fixture、full projection rebuild、real smoke 全绿       | 删除 core/UI 中的 V1 Schema 名称，V1 wire 只在 Adapter                       |
| 8.2 | `refactor(db): retire superseded derived columns` | 新 read model 已经至少一个 release 可重建且 rollback 证据完成 | 独立 additive→cleanup migration；Event Log 永不删除                          |
| 8.3 | `docs(acp): reconcile adr traceability`           | 各 ADR 的 V1 假设有实现证据                                   | 更新 CONTEXT、ADR-0001/0005/0021/0023/0034 的 superseded notes，不改历史结论 |
| 8.4 | `chore(acp): update stable v2 sdk surface`        | ACP V2 正式稳定且 SDK 发布稳定 feature                        | 先更新 fixtures/Adapter，再移除 Draft feature；核心 interface 不变           |
| 8.5 | `docs(acp): decide production default separately` | canary、错误率、主要 Agent 支持、恢复/取消数据满足门槛        | 单独评审是否默认 V2；不在实现提交中顺手开启                                  |

## 8. Data and event migration strategy

### 8.1 Event compatibility

1. 新 semantic event 使用新的 `event_version`；旧 writer/readers 保持 version 1。
2. 写入任何 version 2 event 前，保留并验证现有 `ParsedEvent::Unknown` 路径。
3. 旧事件不回写。Compatibility projector 在读取 V1 Message/Plan 等事件时生成本地
   synthetic Item identity；这只是读模型，不改变历史 JSON。
4. `raw_json` 保留有大小上限的 wire evidence；normalized event 是业务权威。
5. 旧应用读取新事件时显示升级提示并继续显示其它历史；不得崩溃或截断列表。

### 8.2 Derived schema

迁移顺序固定为：

```text
add new item read model
-> dual project old/new event shapes
-> rebuild and compare
-> switch queries/Row Ops
-> observe one release
-> remove superseded derived columns in a later migration
```

- 新表/索引以 Conversation、Binding、Item Kind、Agent Item ID 形成唯一身份；
- optional Turn link 不参与唯一键；
- side record 保存折叠后的最终值，不保存 `FieldPatch::Unchanged`；
- byte terminal data 与 sanitized summary 分离，二者都有容量上限；
- Projection snapshot 包含 schema/version，版本不匹配时丢弃重建；
- 任何迁移失败都保留 Event Log 和旧 side table，不做部分 cutover。

### 8.3 Replay reconciliation

- Resume replay 在临时 epoch 内从空 reducer 开始；
- Agent 响应是 epoch barrier；未收到响应则整个 epoch 丢弃；
- Item 相同为 no-op，缺失/变化才追加 reconciliation event；
- chunk 只在 epoch 内追加一次，最终用 canonical content/bytes 协调；
- 历史 state update 不创建/完成当前 Turn，历史交互不重新进入 pending；
- replay 顺序保存为 Agent session order，但不会重写 VibeX event sequence；
- 无法可靠关联既有本地 User Turn 的历史 user message 保持 unbound，不做文本模糊匹配。

## 9. Rollout and fallback matrix

| Peer/condition                       | Highest sent | Negotiated action             | Fallback                           |
| ------------------------------------ | ------------ | ----------------------------- | ---------------------------------- |
| V2 compile/runtime gate off          | V1           | V1 Adapter                    | 无                                 |
| Agent 不在 allowlist                 | V1           | V1 Adapter                    | 无                                 |
| V1-only Agent 正常响应 V1            | V2           | 同连接选择 V1 Adapter         | 无需重启                           |
| Dual Agent 响应 V2                   | V2           | V2 Adapter                    | Session 前失败可按规则重启 V1      |
| V2 initialize 兼容错误、尚无 Session | V2           | 终止连接                      | 最多一次新进程 V1 retry，记录原因  |
| V2 Session 已创建/恢复后错误         | V2           | 关闭/失败/恢复                | 禁止自动 V1；必要时用户确认 rebind |
| V2 optional feature 未广告           | V2           | 隐藏/不调用该 feature         | 不按 Agent 名称补开                |
| 未知 future variant                  | V2           | bounded preserve + generic UI | 安全相关操作默认拒绝               |
| 已知 variant 畸形                    | V2           | protocol error                | 不降级成 unknown                   |

Rollout stages：

1. **Fixture only：** 生产 binary 编译 V2，但 runtime gate 永远 false。
2. **Developer allowlist：** 仅开发设置和指定 Agent 安装开启，显示 Draft 标识。
3. **Built-in canary：** 对通过真实 smoke 的版本组合可选开启；失败自动关闭后续新 V2
   connection，但不切换已经创建的 Session。
4. **User opt-in preview：** 明确实验开关、诊断导出和一键关闭未来连接。
5. **Default review：** ACP V2 稳定后，依据独立评审决定；不是本计划自动步骤。

## 10. Observability

必须记录以下不含用户内容和凭据的结构化证据：

- Agent ID、Runtime/Adapter version、negotiated dialect、peer info version；
- V2 Schema/Draft revision、capability digest、启用的 feature gates；
- initialize result、before-session fallback reason、connection close reason；
- Prompt submitted/accepted/running/requires_action/idle 的合法 transition；
- cancel requested/confirmed/timeout latency；
- replay epoch item count、no-op/change/missing count、barrier/abort；
- background item count和无法关联 Turn 的数量；
- unknown variant、known malformed、`_meta` truncated、batch limit；
- terminal decode/truncation、permission unknown/fail-closed；
- 进程、连接、临时目录在 probe/Session 结束后的资源计数。

禁止在普通日志记录 Prompt content、Tool raw input/output、MCP token、Auth header、API Key
或完整 Terminal output。诊断导出沿用既有脱敏和最近记录上限。

## 11. Risk register

| Risk              | Failure mode                           | Mitigation                                               | Release gate                        |
| ----------------- | -------------------------------------- | -------------------------------------------------------- | ----------------------------------- |
| V2 Draft 漂移     | SDK/Schema 小版本破坏 wire decode      | 固定依赖、记录 revision、独立 fixtures、Adapter locality | Schema 更新不得绕过 fixture diff    |
| Prompt 过早完成   | Ack 被当终态，自动化/Turn 提前成功     | State reducer；Turn terminal tests                       | Ack 后 Turn 必须仍 in-flight        |
| 取消假成功        | Agent 仍运行而 UI 已 cancelled         | 等 idle(cancelled)，连接丢失不伪造                       | cancel race matrix                  |
| Replay 重复       | 文本/Terminal chunk 翻倍               | 隔离 epoch + barrier + reconciliation                    | 同一 replay 两次最终投影相同        |
| 后台活动丢失      | idle 后工具/计划不显示                 | Session-level Item，不依赖 active Turn                   | background fixture + UI test        |
| Patch 清空失败    | 旧 output/meta/location 残留           | FieldPatch + projector 显式 clear                        | omit/null/value table tests         |
| Terminal 字节损坏 | split UTF-8/binary 乱码或崩溃          | 独立 base64 decode、byte buffer、限制                    | invalid/split byte fixtures         |
| 权限扩大          | unknown subject/outcome 自动允许       | fail-closed，auto policy 限定 known scope                | adversarial permission tests        |
| MCP 越权          | V2 Client tools 可访问额外路径         | SessionEnvironment root、token binding、permission       | workspace/workspace-less path tests |
| V1 回归           | 提取 seam 改变真实 Agent 行为          | Phase 0 characterization、每阶段 V1 smoke                | 任一 V1 regression 阻断合并         |
| 旧版本回滚        | 新 Event 让旧应用打不开会话            | event version unknown wrapper、additive schema           | downgrade fixture                   |
| 非标准 Agent      | Peer 不遵循官方协商/顺序               | typed diagnostics、pre-session one-shot fallback         | generic Registry smoke              |
| 性能退化          | Item/byte/replay 使 Event/Row Ops 膨胀 | bounded buffers、append ops、snapshot、bench             | 长会话基准不出现 O(n²)              |

## 12. Acceptance criteria

### Protocol and compatibility

- [ ] V1-only、dual V1/V2、V2 baseline fixture 均可协商并选择唯一 Adapter。
- [ ] V2 默认关闭；关闭后所有 V1 public behavior 与 wire fixture 不变。
- [ ] V1/V2 wire types、fixtures 和 generated models 分开维护。
- [ ] V2 optional/unstable feature 逐能力门控，不因 protocolVersion 自动开启。
- [ ] V2 Session 建立后不存在静默 V1 fallback。

### Session lifecycle

- [ ] Prompt response 只产生 Accepted receipt，不产生 Turn terminal。
- [ ] running/requires_action/idle 状态顺序和非法转换有测试。
- [ ] idle(stopReason) 正确映射 Completed/Cancelled 并保留 raw reason。
- [ ] CancelRequested 后继续接收更新，idle(cancelled) 才确认。
- [ ] Host crash 保持 Interrupted，Prompt 永不自动重发。
- [ ] 无 active Turn 的后台更新可保存、重建、远程 replay 和显示。

### Identity, patch and replay

- [ ] Message/Thought/Tool/Plan/Terminal 都有 binding-scoped Item identity。
- [ ] V1 synthetic identity 不会泄漏回 Agent或被声明为 Agent identity。
- [ ] omitted/null/value/chunk 在 wire、event、projection、DB、Row Op、UI 一致。
- [ ] Whole replace 能覆盖之前 chunks，Clear 能删除旧字段/content。
- [ ] Resume replay 两次不重复文本、工具内容或 Terminal bytes。
- [ ] Replay 失败不写入部分事件，完成 replay 只记录实际 reconciliation。

### Functional surfaces

- [ ] 五种标准 Content 无损往返，未知 Content 安全显示。
- [ ] Tool content streaming、多个 Plan、structured Diff 正常呈现。
- [ ] ACP Diff 与 checkpoint/git observation 来源可区分。
- [ ] V2 Display Terminal 无 input/kill/wait/release 控件。
- [ ] split/invalid UTF-8、binary、snapshot replacement、exit state 有 fixture。
- [ ] V2 没有 Client FS/Terminal RPC，Client tools 通过 scoped MCP。
- [ ] V2 MCP 仅发送已协商 stdio/HTTP 和明确 type；SSE 仅在 V1 Adapter。
- [ ] Permission unknown subject/outcome 永不自动批准。
- [ ] Mode/Model/Thought Level 全部走单一 Config Option data flow。
- [ ] VibeX 不因 V2 authMethods 增加登录/注销动作。

### Persistence and UI

- [ ] 旧 Event Log 不重写，旧 Conversation 全部可读。
- [ ] 新 Event 在旧 reader 中降级为 Upgrade Notice，而非破坏 Timeline。
- [ ] Live append、full rebuild、snapshot tail replay 得到相同 Projection。
- [ ] Item Row ID 与 Revision 在重复、乱序允许范围和 reconnect 中保持幂等。
- [ ] Tauri 与 Remote adapter 不包含第二套 Session reducer。
- [ ] 长文本、Tool stream、Terminal output 不重新引入 O(n²) full-row broadcast。

### Operations and rollout

- [ ] Registry/Install/Launch Gate 没有按 dialect 分叉成第二套业务管线。
- [ ] Probe/Session 结束后无残留进程、连接、token 和临时目录。
- [ ] 诊断可解释 dialect、capability、fallback、state、replay、cancel，且不泄漏内容/凭据。
- [ ] Built-in 与 Binary/npx/uvx Registry Agent smoke evidence 已保存。
- [ ] 正式默认启用仍需单独评审。

## 13. Verification commands

每个切片先运行最窄测试；阶段结束运行对应全包测试：

```text
cargo test -p agents
cargo test -p conversations
cargo test -p db
cargo test -p vibex
pnpm --dir frontend exec vitest run
```

修改 Rust/TS 类型或 SQL 查询后：

```text
pnpm run generate-types
pnpm run generate-types:check
pnpm run prepare-db
pnpm run prepare-db:check
```

每个 Phase release gate：

```text
cargo fmt --all --check
pnpm run check
pnpm run lint
cargo test --workspace
```

正式 canary 前另外运行：

- 长会话 1000+ Message/Tool/Terminal update 的内存、数据库和 Row Op 基准；
- application kill、Agent kill、stdio 断开、cancel race、Resume replay interruption；
- workspace 与 workspace-less Conversation 的 MCP 路径越权测试；
- Windows/macOS/Linux 上可用 Agent 的 stdio、base64 Terminal 和进程回收 smoke；
- V2 开启后再关闭、应用升级后回滚旧 reader 的数据库 fixture。

## 14. Traceability

| ADR-0035 decision                     | Plan phases |
| ------------------------------------- | ----------- |
| 双 Adapter 与一连接一版本             | 0、1、2     |
| Turn/Session 分离与 Prompt state      | 3、4、6     |
| Session Item 与三态 Patch             | 1、4        |
| Replay epoch/reconciliation           | 3、4、7     |
| Capability truth                      | 2、7        |
| 无损 Content/Tool/Plan                | 4、5、6     |
| V1 execution/V2 display terminal 分离 | 5、6        |
| MCP 取代 V2 Client FS/Terminal        | 3、5、7     |
| Structured Diff/Permission            | 5、6        |
| Mode 收敛为 Config Option             | 5、6        |
| Extensibility/Batch                   | 2、4、5、7  |
| Event compatibility/rollback          | 0、4、7、8  |
| Draft rollout policy                  | 0、2、7、8  |

## 15. Definition of done

本计划的“完成”是：VibeX 已拥有可维护、可关闭、通过真实 Agent 验证的 V2 支持，V1
仍通过同一 Semantic Session Core 正常运行，所有 V2 功能都进入同一 Conversation
Event Log、Projection 与 UI；不是“V2 已成为默认”，也不是“V1 可以删除”。

ACP V2 稳定、SDK feature 变化或生产默认启用均是完成后的独立评审事项。

## Protocol references

- [ACP V2 Draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)
- [ACP V1 → V2 migration guide](https://agentclientprotocol.com/protocol/v2/migration)
- [ACP V2 schema](https://agentclientprotocol.com/protocol/v2/schema)
- [ACP V2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- [ACP V2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)
- [ACP V2 tool calls](https://agentclientprotocol.com/protocol/v2/tool-calls)
- [ACP V2 extensibility](https://agentclientprotocol.com/protocol/v2/extensibility)
- [ACP V2 transports](https://agentclientprotocol.com/protocol/v2/transports)

最后核对：2026-08-02。
