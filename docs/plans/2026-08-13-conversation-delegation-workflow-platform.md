# 会话、委派与 Workflow 平台实施计划

**状态：** 本机 release candidate 已完成；外部 canary 与长期运行观测待部署环境执行。

**日期：** 2026-08-13。

**决策依据：**

- [ADR-0044：会话控制面统一持久输入、运行中纠偏与父子关系](../adr/0044-conversation-control-plane-and-durable-inputs.md)
- [ADR-0045：Workflow 以持久 DAG 编排真实 Conversation 与 Turn](../adr/0045-workflows-orchestrate-conversation-turns.md)
- [BB 与 VibeX：会话、委派与工作流深度对比](../research/2026-08-13-bb-vibex-session-delegation-workflow-deep-dive.md)

**目标：** 先把现有 Conversation/Turn/Delegation/Automation 底座升级为统一、持久、
可编程的控制面，再交付确定性 Workflow。完成后不仅覆盖 BB 的 durable queue、
spawn/send/wait/steer、parent/child、sequence/parallel、structured output、预算、历史与
重启继续能力，还必须通过 VibeX 额外的副作用安全、worktree 隔离、多客户端幂等、
capability honesty 和 desktop/headless/Remote 一致性门禁。

**实施指南：**
[Conversation、委派与 Workflow 使用指南](../readme/conversation-delegation-workflows.md)。

### 2026-08-13 实施快照

以下是代码与自动测试已经证明的事实，不以页面存在代替运行时能力：

| Slice                  | 已落地证据                                                                                                                                                          | 部署环境仍需补充               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Conversation input     | 事件溯源 queue、payload-bound operation id、编辑/取消/重排、claim 与 stale recovery；前端改读服务端投影；10,000 events / 1,000 queued 重建门禁                      | 多设备真实网络抖动 soak        |
| Steering               | expected Turn、能力协商、accepted/rejected/unknown receipt、UI 与命令面分离                                                                                         | 各受支持真实 Agent 方言 smoke  |
| Relation / delegation  | 原子 relation、cycle prevention、legacy backfill、hard fan-out budget、父级 child/waiting/budget summary                                                            | 长时间 parent teardown soak    |
| Scoped session control | MCP `send_session_input` / `cancel_session_turn` / `wait_for_session`；自身/后代 + 同 workspace 单一授权入口；真实 TCP/WebSocket token revoke E2E                   | 跨设备 revoke soak             |
| Workflow kernel        | 新 `crates/workflows`、版本化 DAG、Agent/Approval、幂等 publish/start、持久 events/projections/claims；1,000-step 与 100 active Runs 容量门禁                       | 目标发行设备重复采样           |
| Output / recovery      | JSON Schema 子集、bindings、单次 repair、旧 attempt 证据保留、NeedsReview 决策；真实 Codex/ACP 完成与 Host 重建不重放 E2E；未知 runtime/tool/checkpoint fail closed | OS 级 SIGKILL canary           |
| Workspace              | shared writer 串行；`write_isolated` 创建真实 VibeX worktree、branch 与 HEAD evidence，不自动 merge                                                                 | 多仓库 worktree 长跑清理       |
| Adapters               | Application commands、Tauri/Remote、CLI、scoped MCP、Automation Workflow target；desktop/headless 编译与契约测试                                                    | 真实多端同 fixture smoke       |
| Observability          | Workflow Inspector、child navigation、resolved input、execution evidence、review actions；10,000 events 分页门禁                                                    | 浏览器超长历史交互采样         |
| Retention              | 30 天 terminal cleanup；running/waiting/needs_review 排除；worktree 删除失败则保留证据                                                                              | 配额驱动清理（时间策略已完成） |

实现采用一个保守偏差：虽然 Definition 接受 `read_only_shared`，在没有跨 Agent 可强制只读
工具能力之前仍按 shared workspace 串行。只有真实 `write_isolated` worktree 能并行写。这
牺牲一部分吞吐以保持 capability honesty，不把 Agent 的文字声明当安全边界。

本次交付验证：Conversation、Workflow、Delegation、MCP、Application、Automation 与
Server 相关 Rust suites 全绿；desktop/headless `cargo check` 和全目标 clippy（warnings as
errors）通过；generated TypeScript 无漂移；frontend typecheck、ESLint、Prettier 与全量
258 个测试文件、1,277 项测试通过。真实 `codex-acp` + 已认证 Codex 端到端运行完成，并在
运行中 Turn 后完整销毁和重建 HeadlessServer，证明原 Run/Step/child/Turn 进入
`needs_review`、attempt 与 child 均保持一个且不自动重发。真实 TCP/WebSocket token revoke
以及固定规模容量门禁也已通过。外部 canary、OS 级 SIGKILL、跨设备网络 soak 和发行设备
重复采样属于部署活动，因此本文只宣称本机 release candidate 达到 BB 功能基线并在副作用
安全、隔离和 capability honesty 上具有更强门槛，不把生产毕业写成已完成事实。

## 1. 完成定义

本计划不是以“新增了页面”“CLI 有命令”或“可以跑 demo”为完成标准。只有下列能力
同时成立，才达到平台级完成：

| 能力       | BB 基线                      | VibeX 完成门槛                                        | 超越点                                          |
| ---------- | ---------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| 普通输入   | durable queued messages      | 多消息、更新/取消/重排、claim、重启恢复               | Conversation Event Log 权威 + operation id      |
| 运行中输入 | steer/auto modes             | expected Turn + 协商能力 + receipt                    | unsupported 不静默排队，状态可审计              |
| 会话编程   | spawn/send/wait/stop SDK/CLI | 同一 Core 的 create/child/send/steer/wait/cancel/fork | Tauri、Remote、CLI、MCP 完全同语义              |
| 父子拓扑   | parent/child + visibility    | fork/delegation/workflow relation 与 summary          | 不新增 Manager 类型，不让 relation 污染历史     |
| 委派治理   | child threads                | 并发、调用数、期限、输出、作用域和写入策略            | 同工作树无未知并发写，隔离失败 fail closed      |
| Workflow   | sequence/parallel/phase      | 持久 DAG、Agent/Approval Steps、结构化输出            | 每步真实 Conversation/Turn，多端可审计          |
| 恢复       | 调用摘要复用                 | 已完成步骤证据复用，running mutating 需复核           | 不依据 hash 自动重放未知副作用                  |
| 调度       | 全局并发与 run budget        | owner lease、FIFO、run/global hard limits             | 与 Automation 共用 Host ownership，不起第二引擎 |
| 执行环境   | worker environment           | run/step worktree policy、diff/checkpoint             | 并发写隔离且不自动 merge                        |
| 扩展       | QuickJS workflow source      | versioned declarative IR + validator                  | SDK/Plugin 编译到同一 IR，无主进程任意代码      |

## 2. 不变量

每个实施切片都必须保持：

1. Conversation Event Log 是会话输入、Turn、steering 和 relation 可见事实的唯一权威；
2. Workflow Event Log 是 Run/Step 编排事实的唯一权威；
3. 同一 Conversation 同时最多一个 active Turn；
4. Agent Step 只能通过真实 Conversation/Turn 执行；
5. Interrupted Turn 绝不自动重发；
6. UI cache、内存 queue、connection map 和 scheduler task 不是权威；
7. Tauri、Axum、CLI 和 MCP adapter 不包含业务状态机；
8. 能力来自当次 Agent connection 或 Server negotiation，不按 Agent 名称推断；
9. 任意潜在写任务不得并发共享同一 workspace；
10. 自动化与 Workflow 不自动 merge、push、publish 或 deploy；
11. 每个破坏性或可能重复副作用的恢复动作都需要明确证据或用户决定；
12. 每个新 schema/event 先保证旧 reader 安全降级，再允许生产写入。

## 3. 目标模块与 seam

| Module                                                                 | Interface / ownership                                      | 隐藏的 implementation                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ConversationControl`（`crates/conversations` + `crates/application`） | create/child/submit/steer/cancel/watch                     | queue reducer、claim、Turn 创建、事件事务、runtime correlation                                   |
| `SemanticSessionCore`（`crates/agents`）                               | protocol-neutral prompt/steer/cancel intent 与 observation | ACP v1/v2 wire、capability decode、receipt correlation                                           |
| `DelegationBroker`（`crates/delegation`）                              | delegate/status/cancel 与 budget result                    | companion scope、child policies、result truncation；不再复制 launch lifecycle                    |
| `WorkflowCore`（新 `crates/workflows`）                                | publish/start/decide/cancel/resume/watch                   | DAG validator、event reducer、ready selection、budget、recovery；通过内部 port 执行 Conversation |
| `WorkflowDispatcher`（`crates/workflows`）                             | claim ready work under owner lease                         | FIFO、global/run concurrency、stale claim reconciliation                                         |
| Persistence adapters（`crates/db`）                                    | append/claim/project transaction                           | SQLite schema、SQLx、projection rebuild                                                          |
| Transport adapters                                                     | versioned commands/events                                  | Tauri invoke、HTTP/WS、CLI formatting、MCP framing                                               |

`crates/workflows` 是唯一新业务 crate。不要新建 queue、relation、scheduler、schema、
budget 等单用途 crates；这些逻辑分别属于 Conversation、Workflow 或 DB adapter。
`crates/workflows` 不依赖 `crates/application`：它接收内部 `ConversationExecutorPort`，
由 Application composition 提供 ConversationControl adapter，测试提供 scripted adapter。
Automation 同样通过 target-launch port 启动 Workflow，避免 domain crates 反向依赖组装层。

## 4. 数据模型演进

迁移遵循 additive-first，先读后写，最后删除旧路径。

### 4.1 Conversation

新增或投影以下事实：

- `conversation_input_id`、operation id、revision、sort key、principal、canonical input；
- queue lifecycle events 与 claim lease；
- steering requested/accepted/rejected/unknown events，关联 expected turn；
- `conversation_relations` projection：parent、child、kind、visibility；
- child summary projection；
- delegation policy snapshot 与 hard-budget counters。

既有 delegation parent 字段和 fork metadata 暂时双读，只用于 migration/backfill。relation
投影核验完成后，所有新写入只走 relation 事实；旧列保持兼容读取，不能批量改写历史事件。

### 4.2 Workflow

新增：

- immutable workflow definitions 与 versions；
- workflow run event log：run id、sequence、event version、kind、payload、operation id；
- run/step/ready projections 与 claim token/deadline；
- step attempt 到 conversation/turn 的关联；
- accepted output、schema digest、resolved version evidence、usage、artifact/checkpoint；
- Automation target discriminator 与 workflow run correlation。

不为 prompt/tool/permission 建 Workflow 副本；只保存 child Conversation/Turn ID。

## 5. Phase 总览

| Phase | 结果                                            | 用户可见状态                             |
| ----- | ----------------------------------------------- | ---------------------------------------- |
| 0     | characterization、schema 与开关锁定             | 行为不变                                 |
| 1     | 持久 Conversation input queue                   | queue 可跨重启/设备恢复                  |
| 2     | native steering 与统一会话命令                  | 可明确选择纠偏或下一条输入               |
| 3     | relation、委派策略与安全 workspace              | child 可导航、汇总、受预算和写隔离约束   |
| 4     | Remote/CLI/MCP 会话编程面                       | 用户和 Agent 可确定性 create/send/wait   |
| 5     | Workflow kernel 与持久 DAG                      | 可 validate/publish/start/cancel/restart |
| 6     | Agent/Approval Steps、输出和 Automation trigger | 可运行真实 sequence/parallel Workflow    |
| 7     | inspector、安全恢复与隔离并行写                 | 可审计、复核、恢复复杂运行               |
| 8     | BB 对标、性能、安全、清理与发布                 | 旧路径删除，达到正式可用                 |

Phase 1–4 是 Workflow 的前置条件。禁止在 Phase 1 完成前制作 Workflow UI 或在
Workflow 内实现私有 queue。

## 6. 详细提交计划

每个编号是一个可独立审查的 commit intent。实现时先写会失败的公开 interface 测试，
再写最小 production change；不得把下一编号的抽象提前搭空壳。

### Phase 0 — Characterization 与发布护栏

| ID  | Commit intent                                                  | Red/characterization evidence                                         | Exit condition                               |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| 0.1 | `test(conversations): freeze current start and queue behavior` | 当前测试不能证明刷新后 queue 消失、单 Turn 冲突与 start event order   | fixtures 明确现状，不改行为                  |
| 0.2 | `test(delegation): freeze child lifecycle and scope`           | desktop/headless child launch、cancel、parent teardown 未共享完整矩阵 | 两种 host 对相同 broker scenarios 一致       |
| 0.3 | `test(automation): freeze owner and run terminal semantics`    | Workflow 改造可能破坏 due claim/Turn terminal                         | 双 engine、cancel race、recovery golden 完整 |
| 0.4 | `feat(platform): add disabled rollout capabilities`            | 无法单独关闭 queue dispatcher、steer、relations、workflow             | 默认全关，旧路径完全不变                     |
| 0.5 | `docs(domain): record conversation and workflow language`      | glossary 不足以区分 draft/input/steer/run/step                        | CONTEXT 与 ADR 互链，无 implementation 细节  |

**Gate：** 当前桌面、server、automation、delegation tests 全绿；生产默认行为没有变化。

### Phase 1 — 持久 Conversation input queue

| ID  | Commit intent                                                  | Red test                                   | Minimal implementation / exit                                           |
| --- | -------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| 1.1 | `feat(conversations): define durable input events and reducer` | 无法从事件重建多条 queue                   | protocol-neutral types、state transitions、property/table tests         |
| 1.2 | `feat(db): persist input projection and atomic claim`          | 双消费者可 claim 同一 input                | additive migration、conditional claim、stale unsubmitted claim recovery |
| 1.3 | `feat(conversations): submit input idempotently`               | 重复 operation 会创建两条 input            | payload digest + operation scope；same retry 返回同 receipt             |
| 1.4 | `feat(conversations): dispatch queue into one turn`            | idle/busy race 可双 start 或越序           | claim -> create Turn -> Dispatched 同事务，发送在提交之后               |
| 1.5 | `feat(application): expose queue read/write commands`          | adapter 仍需直接调用 service/private DB    | submit/list/update/cancel/reorder 经 Command Registry                   |
| 1.6 | `feat(frontend): consume server queue projection`              | 刷新/第二窗口看不到同一 queue              | Composer、indicator、edit/cancel/reorder 使用 BackendTransport          |
| 1.7 | `refactor(frontend): delete local composer queue`              | React Query 仍可产生第二权威               | 删除 `useSessionComposerQueue` 的本地状态/dispatch effect 与旧文案      |
| 1.8 | `test(conversations): harden crash and concurrency`            | send 后 crash、stale claim、双客户端未覆盖 | 每个 input 最多一个 Turn；dispatched crash 不重排                       |

**Gate：** 默认启用新 queue；连续重启、两窗口、desktop + Web 并发下顺序与事件一致。

### Phase 2 — Steering 与统一 ConversationControl

| ID  | Commit intent                                             | Red test                                       | Minimal implementation / exit                               |
| --- | --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| 2.1 | `feat(agents): add semantic steer capability and intent`  | core 只能调用具体 ACP manager                  | scripted adapter 可支持/拒绝 steer，expected turn 必填      |
| 2.2 | `feat(agents): implement negotiated ACP steer adapters`   | capability marker、receipt、disconnect 无映射  | 每个支持的 dialect fixture 通过；unsupported 稳定失败       |
| 2.3 | `feat(conversations): persist steering lifecycle`         | 重连后无法解释 steer 是否接受                  | requested/accepted/rejected/unknown events 与 projection    |
| 2.4 | `feat(application): deepen ConversationControl interface` | create/start/cancel/watch 仍跨多个 caller 组合 | 所有写路径进入统一 module，transport 不知 runtime 状态机    |
| 2.5 | `feat(frontend): separate steer from queued follow-up`    | 同一操作会隐藏 fallback                        | active Turn 明确两个动作；unsupported 不显示可用 steer      |
| 2.6 | `test(remote): verify operation and turn conflicts`       | 多设备 steer 新旧 Turn 竞态未覆盖              | expected turn mismatch、duplicate op、disconnect tests 全绿 |

**Gate：** 支持 steer 的真实 Agent smoke 成功；不支持 Agent 从 UI 到 server 都不宣称支持。

### Phase 3 — Relation、Delegation 与 workspace policy

| ID  | Commit intent                                              | Red test                                        | Minimal implementation / exit                                    |
| --- | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 3.1 | `feat(conversations): add relation facts and projection`   | fork/delegation child 无统一查询                | 原子 child+relation、visibility、cycle prevention、rebuild       |
| 3.2 | `feat(db): backfill legacy child metadata`                 | 旧 fork/delegation 不出现在 relation read model | idempotent backfill，历史 event 不重写，双读校验                 |
| 3.3 | `refactor(delegation): launch through ConversationControl` | broker 与普通 input 各有 Turn lifecycle         | broker 只保留 scope/budget/result；旧 MCP behavior 不变          |
| 3.4 | `feat(delegation): enforce hard budget snapshot`           | depth 之外无法阻止 fan-out                      | active children、calls、deadline、result bytes 一致执行          |
| 3.5 | `feat(workspaces): serialize unknown writers`              | 两个 child 能同时写同一 root                    | per-workspace write lease；unknown 默认 serialized               |
| 3.6 | `feat(workspaces): isolate explicit child writers`         | 并行写没有 checkpoint/worktree evidence         | checkpoint-derived child worktree、diff/artifact、不自动 merge   |
| 3.7 | `feat(conversations): project parent child summary`        | parent 只能逐个打开 child 判断状态              | counts、waiting、budget 与 direct-child links 可重建             |
| 3.8 | `test(delegation): enforce descendant scope`               | companion 可猜 ID 操作别的 Conversation         | parent/descendant allowlist、root/permission/token revoke matrix |

**Gate：** fan-out read 可以并行；两个未知/写 child 永不并发共享工作树；desktop/headless
对相同策略产生相同事件、错误码和结果截断。

### Phase 4 — Remote、CLI、SDK 与 MCP 会话编程面

| ID  | Commit intent                                                 | Red test                            | Minimal implementation / exit                                  |
| --- | ------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| 4.1 | `feat(application): register complete conversation commands`  | list/create/start 之外仍要绕过 Core | create/child/send/steer/wait/cancel/fork/output 全注册         |
| 4.2 | `feat(remote): version conversation command and event schema` | Web 无 queue/relation/steer parity  | generated TS/schema、capabilities、unknown-event compatibility |
| 4.3 | `feat(cli): add thin conversation command client`             | 无法用 shell 完成 create/send/wait  | 新 CLI 只调用 Core/Remote；稳定 JSON 与 human output           |
| 4.4 | `feat(sdk): expose generated remote client`                   | 插件/脚本需手写 HTTP payload        | 一个薄 client；不复制 domain reducer 或 validator              |
| 4.5 | `feat(vibex-mcp): expose scoped child send, cancel and wait`  | 父 Agent 只能 one-shot status       | 仅 parent/descendants；复用 submit/watch/cancel                |
| 4.6 | `test(platform): run transport conformance suite`             | 每个 adapter 只有自己的 happy path  | 同 fixture 跨 Tauri/HTTP/CLI/MCP，结果和错误码一致             |

**Gate：** 无 UI 也能完成 create child → send → steer/wait → inspect output → cancel；CLI
断线重试不产生重复 input。

### Phase 5 — Workflow kernel

| ID  | Commit intent                                          | Red test                                 | Minimal implementation / exit                                         |
| --- | ------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| 5.1 | `feat(workflows): add definition types and validator`  | 环、坏引用和未知 schema 可保存           | Agent/Approval、depends_on、bindings、schema subset 完整验证          |
| 5.2 | `feat(workflows): publish immutable versions`          | 编辑可改变在途 Run                       | version + digest；同 operation/payload 幂等，冲突失败                 |
| 5.3 | `feat(db): add workflow event log and projections`     | restart 后 Run/Step 不可重建             | append/sequence/version、run/step/ready projections                   |
| 5.4 | `feat(workflows): reduce run and step lifecycle`       | terminal/waiting/needs_review 竞态不确定 | first-terminal-wins reducer 与 golden replay                          |
| 5.5 | `feat(workflows): claim ready steps under owner lease` | 双 dispatcher 双启动 Step                | FIFO conditional claim、global/run concurrency、stale preflight claim |
| 5.6 | `feat(application): expose workflow core commands`     | Tauri/server 需直接操作 DB               | publish/start/decide/cancel/resume/watch + read queries               |
| 5.7 | `test(workflows): prove deterministic restart`         | 同一 DAG 重启前后 ready order 不一致     | sequence/parallel/cancel/restart property + integration tests         |

**Gate：** 先用 deterministic fake Step executor 跑完整 DAG；此时尚不接真实 Agent，
Workflow feature 保持开发开关。

### Phase 6 — Agent/Approval Step、输出与 Automation target

| ID  | Commit intent                                                 | Red test                                             | Minimal implementation / exit                                                                                             |
| --- | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | `feat(workflows): execute agent step via ConversationControl` | Step executor 可绕过 Conversation                    | hidden child relation、submit/watch、Turn correlation                                                                     |
| 6.2 | `feat(workflows): propagate cancel and waiting interaction`   | Run cancel 不停 child；permission 被复制             | cancel active Turn；Run 只投影 child waiting summary                                                                      |
| 6.3 | `feat(workflows): validate structured step output`            | 下游可读未验证文本                                   | accepted JSON + schema/source digest；超限明确失败                                                                        |
| 6.4 | `feat(workflows): allow one bounded repair turn`              | invalid output 无可解释恢复                          | 同 child 新 Turn，最多一次，计入 calls/tokens/deadline                                                                    |
| 6.5 | `feat(workflows): enforce run and global budgets`             | nested/repair 可绕过上限                             | shared counters、deadline cancellation、usage unknown honesty                                                             |
| 6.6 | `feat(workflows): persist approval decisions`                 | 多设备可双批准或覆盖                                 | approver scope、operation id、first decision wins                                                                         |
| 6.7 | `feat(automation): add versioned workflow target`             | Automation 只能保存 TurnLaunchSpec                   | additive target union、旧 rows 映射 Turn、Run correlation；Direct Turn crash→Interrupted，Workflow target 协调 linked Run |
| 6.8 | `test(workflows): run real agent conformance`                 | fake executor 不能证明 Conversation/Turn integration | completed/failed/cancelled/interrupted/permission/output smoke                                                            |

**Gate：** manual 和 scheduled workflow 都能运行 sequence + parallel read-only steps、
Approval 与结构化输出；每个 Agent Step 都可打开真实 Conversation。

### Phase 7 — Inspector、安全恢复与隔离写

| ID  | Commit intent                                           | Red test                                | Minimal implementation / exit                                      |
| --- | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 7.1 | `feat(frontend): add compact workflow run card`         | timeline 无法关联后台 Run               | phase/progress/waiting/terminal summary + inspector link           |
| 7.2 | `feat(frontend): add workflow inspector`                | 无法判断 step、attempt、budget 和 child | DAG/list adaptive view、output/evidence、cancel/decide/resume      |
| 7.3 | `feat(workflows): reconcile interrupted steps safely`   | restart 会重发或永久 running            | preflight-only requeue；running Turn -> interrupted/needs_review   |
| 7.4 | `feat(workflows): verify completed step reuse evidence` | workspace 被改仍跳过 Step               | definition/input/schema/runtime/tool/workspace/checkpoint digest   |
| 7.5 | `feat(workflows): execute isolated write steps`         | 并行 writers 共享 run worktree          | per-step worktree、diff/artifact/checkpoint、no auto merge         |
| 7.6 | `feat(frontend): add review decisions`                  | mutating interrupted step 无安全出口    | accept evidence/retry attempt/skip-if-allowed/cancel，文案说明后果 |
| 7.7 | `feat(remote): expose workflow events and actions`      | Web/移动只能看 Conversation             | capability-gated summary/replay/decide/cancel/resume parity        |

**Gate：** 在 Agent 写文件期间强杀 Host，重启后不重复发送；inspector 展示 child、diff、
checkpoint 和 NeedsReview，用户每个决定都可审计。

### Phase 8 — 对标、清理与发布

| ID  | Commit intent                                            | Evidence                                   | Exit condition                                                  |
| --- | -------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| 8.1 | `test(platform): add BB parity scenarios`                | 能力表仍靠人工判断                         | queue/steer/child/workflow/history/restart executable scenarios |
| 8.2 | `test(platform): add adversarial concurrency suite`      | double claim/cancel/terminal races 未穷尽  | deterministic interleaving + SQLite multi-connection stress     |
| 8.3 | `test(platform): add security and scope suite`           | hidden child、MCP、path、approval 可能越权 | fail-closed matrix、fuzz/size bounds、credential redaction      |
| 8.4 | `perf(platform): bound projections and fan-out`          | 大 Run/长 queue 没有预算                   | 目标数据集下分页、rebuild、attach/replay 与内存上限达标         |
| 8.5 | `feat(workflows): add retention and cleanup`             | hidden children/worktrees 无限增长         | 复用 Automation retention policy，running/needs_review 永不误删 |
| 8.6 | `refactor(platform): delete superseded paths`            | local queue、direct launch、双关系写仍存在 | 删除旧 hooks/commands/DB writes/feature shims，无兼容分支残留   |
| 8.7 | `docs(platform): publish operations and authoring guide` | 用户只能读 ADR 猜用法                      | CLI/JSON examples、failure recovery、schema、security limits    |
| 8.8 | `release(platform): graduate rollout gates`              | 只在开发环境通过                           | canary → opt-in → default，每阶段有 rollback evidence           |

**Gate：** ADR-0044 与 ADR-0045 的全部 Acceptance criteria 逐项有自动测试或真实 Agent
证据；旧 queue 和旁路执行代码已删除。

## 7. 测试矩阵

### 7.1 公开 interface tests

- ConversationControl：submit idempotency、order、claim、dispatch、steer、cancel、watch；
- WorkflowCore：validate、publish、start、DAG readiness、decide、cancel、resume、settle；
- 测试只观察 events、receipts、projections 和 child facts，不断言私有 helper 调用。

### 7.2 Persistence integration

- SQLite 多连接竞争 claim；
- commit 前/后 crash injection；
- Event Log 从零 rebuild 与 live projection 相同；
- migration 在旧数据、部分 backfill、重复运行下幂等；
- SQLx offline metadata 随每次 query slice 更新。

### 7.3 Adapter conformance

- Tauri、Remote、CLI、MCP 对同一 operation fixtures 返回相同 stable codes；
- ACP 支持/不支持 steer、receipt 前断线、Turn mismatch；
- desktop/headless 使用相同 queue、delegation、workflow policies；
- 旧客户端安全忽略新 event/schema，写能力由 capability gate 禁用。

### 7.4 Lifecycle and safety

- cancel 与 complete、parent teardown、deadline、Host crash 的所有竞态；
- Prompt 发送前/后 crash；
- permission/question waiting；
- read-only 权限强制、write serialization、isolated worktree cleanup；
- output schema invalid/oversized、repair invalid、budget exhaustion；
- interrupted mutating step 不自动 retry。

### 7.5 最小验证命令

每个切片先跑定向测试，合并前至少运行：

```text
cargo test -p conversations
cargo test -p delegation
cargo test -p automation
cargo test -p application
cargo test -p remote-protocol
cargo test -p workflows
cd frontend && pnpm test
pnpm run check
pnpm run lint
```

涉及数据库查询时追加 `pnpm run prepare-db`；Rust 类型跨前端变化时追加
`pnpm run generate-types`，不得手改 `shared/types.ts`。

## 8. Rollout 与 rollback

下列名称是部署阶段的 capability gate，而不是需要永久保留在领域模型中的布尔字段。当前
工作树没有执行生产 writer cutover，因此不为“先新增、再立即删除”制造空 feature-flag
基础设施；外部 canary 的部署配置必须按这些能力独立开关，完成默认启用后再删除临时 gate：

```text
durable_conversation_inputs
conversation_steering
conversation_relations
delegation_execution_policies
workflow_runtime
workflow_automation_target
isolated_write_steps
```

- 新 reader 与 schema 先发布，确认旧数据重建，再开启新 writer；
- durable inputs 开启后不允许回到本地 queue writer；rollback 只能关闭 dispatch、保留数据
  并使用修复版本读取，不能让旧 UI 覆盖服务端 queue；
- Workflow dispatch 关闭时不改写既有 Run 状态；Run 保持可读、可取消并显示 runtime
  unavailable，重新启用后从持久事实协调；
- isolated worktree cleanup 永远在 terminal evidence 持久化后执行；
- schema migration 不 drop 旧列，直到至少一个稳定版本只读兼容并完成 backfill 核验；
- canary 每次只扩大一个 capability，不能一次同时默认启用 steer、workflow 和 isolated
  writes。

## 9. 性能与容量门槛

正式默认前使用固定 fixture 记录基线，具体阈值由目标设备实测锁定，至少覆盖：

- 10,000 条 Conversation events + 1,000 queued inputs 的 rebuild、分页和 attach；
- 1,000-step Workflow Definition validator 与 DAG ready selection；
- 100 active Runs、全局并发 Agent 上限下的公平 dispatch；
- 10,000 Step events 的 inspector 首屏与增量更新；
- output/result/event 单项和总字节上限；
- retention 扫描不阻塞 running/needs_review Runs。

没有 profiler 证据前保持 SQLite 索引 + FIFO，不引入消息队列、分布式锁、优先级调度、
图数据库或缓存服务。

### 9.1 本机 release gate 实测

以下数据来自 2026-08-13 当前开发机 debug test profile；阈值是防回退门禁，不是跨设备
性能承诺。容量测试默认 `ignored`，只在发布验证显式运行：

| 场景                                              |   实测 | 门禁 |
| ------------------------------------------------- | -----: | ---: |
| Conversation 10,000 events + 1,000 queued rebuild |  13 ms |  2 s |
| 1,000-step Definition 校验并物化 ready steps      | 182 ms | 10 s |
| 100 active Runs 公平 dispatch                     | 176 ms | 15 s |
| 10,000 Workflow events，两页各 200 条             |   4 ms |  1 s |

真实 Agent gate 使用 `@agentclientprotocol/codex-acp` 1.1.9 与本机已认证 Codex，27.94 秒
完成一次真实 Workflow Conversation/Turn；随后对第二个运行中 Agent Step 重建 Host，验证
进入 `needs_review` 且无重复 attempt、child 或 prompt。测试仅在显式提供绝对可执行路径时
运行，普通 CI 不依赖本机凭据：

```sh
VIBEX_REAL_AGENT_ACP=/absolute/path/to/codex-acp \
VIBEX_REAL_CODEX=/absolute/path/to/codex \
VIBEX_REAL_AGENT_TIMEOUT_SECONDS=120 \
cargo test -p server --test real_agent_workflow -- --ignored --nocapture

cargo test -p conversations \
  rebuilds_ten_thousand_input_events_with_one_thousand_queued_inputs \
  -- --ignored --nocapture
cargo test -p workflows -- --ignored --nocapture
```

对抗性门禁额外证明：外键开启的真实数据库中必须先创建稳定 child Conversation，再把
Step 标为 started；该顺序避免了单元测试关闭外键时未暴露的悬空引用。相同 StepRun ID
作为 child ID，使 preflight 崩溃重试幂等，不需要额外去重服务。

## 10. 明确后置

以下能力不属于本计划完成条件：

- 任意 JavaScript/shell Workflow runtime；
- dynamic map、condition、nested workflow；
- 自动 merge、push、publish、deploy；
- 多用户 RBAC、团队审批和共享 Workflow marketplace；
- 基于不可信 Agent 文本声明的 read-only 或 token 精确预算；
- batch/group Conversation input；
- Workflow 图形编辑器。首版 JSON/模板 + validator + inspector 足以完成 author/run/debug
  闭环；只有实际 authoring 数据证明需要时再建设图形编辑器。

这些后置项不能预先制造 interface、表、feature flag 或空节点类型。出现真实需求时依据
ADR Review trigger 重新决策。

## 11. 最终验收场景

1. 两台设备同时向 busy Conversation 提交、编辑和重排输入，Host 重启后严格一次、按序
   创建 Turns。
2. 用户对支持的 Agent steering 当前 Turn；另一设备持有旧 Turn ID 的请求稳定冲突；
   不支持 Agent 明确失败且输入未被偷偷排队。
3. 父 Agent 并行委派多个 read-only child，查看 summary，再向指定 child 追加输入并等待；
   companion 无法访问 scope 外 Conversation。
4. 两个写 child 请求同一 workspace 时被串行；显式 isolated children 并行完成并留下
   独立 diff，未自动合并。
5. 一个 scheduled Workflow 运行 `A -> (B, C) -> Approval -> D`；B/C 结构化输出被 D
   引用，所有 steps 有真实 child Conversation。
6. C 写文件期间 Host 被强杀；重启后 C/Run 进入 NeedsReview，C 不重发；B 只有在
   runtime/tool/workspace/checkpoint 证据可验证且一致时保持完成，否则同样 fail closed；用户
   检查证据后创建新 attempt，历史保留。
7. 同一 Workflow 通过 desktop、CLI 和 Automation 启动，产生相同 Definition/Run/Step
   语义；Remote 断线后按 sequence 补放，不重复事件。
8. calls、deadline 或 output bytes 超限时，尚未开始的 Steps 不启动，运行得到可解释终态，
   running child 被正确取消。
9. 删除 Workflow 插件或升级 Agent 后，历史 Run、版本证据、accepted output、child
   Conversation 和 diff 仍可阅读；旧 Run 不被新定义改写。
10. 旧 Composer 本地 queue、直接 Workflow-to-Agent runtime、插件私有 Workflow DB、
    Manager Conversation 和并发共享写目录均不存在。
