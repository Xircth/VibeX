---
status: accepted
date: 2026-08-13
decision-makers:
  - VibeX maintainers
---

# 会话控制面统一持久输入、运行中纠偏与父子关系

VibeX 将 Conversation 的创建、输入、纠偏、等待、取消和父子导航收敛到同一个
Application Core 会话控制面。普通输入先成为持久领域事实，再由每个 Conversation 的
单消费者调度器在空闲时创建真实 Turn；运行中纠偏是独立、能力驱动且不得静默降级的
操作。LLM 委派、桌面、Remote、CLI、SDK、MCP 和 Workflow 都必须经过该控制面。

本决定扩展 ADR-0031 的 LLM-mediated delegation，但不废除它：`&Agent` 仍是请求父
Agent 考虑委派的建议，companion 仍可创建 one-shot delegated Conversation。新增的是
确定性的通用会话原语，以及所有入口共享的持久语义。

## Context

VibeX 已经具备持久 Conversation、单一在途 Turn、事件日志、委派子 Conversation、
first-terminal-wins、取消传播和 Remote Application Core。当前缺口集中在入口：

- Composer 的 follow-up queue 只有一条消息，权威状态位于 React Query 内存；刷新、
  重启或换设备后不能恢复，也没有原子 claim 和幂等 dispatch；
- `crates/delegation/src/steering.rs` 管理 companion feedback/question，不是向活跃 Turn
  发送新输入的通用 steering；
- 委派主要由父 LLM 调用 MCP 触发，用户、CLI、Workflow 和 Agent 没有共享的
  create/send/wait/steer 原语；
- fork、delegation 和未来 workflow worker 的亲子元数据形状不同，导航、可见性和汇总
  容易按来源继续增加特例；
- 子 Agent 默认继承父工作目录，未知写入任务的并行 fan-out 可能竞争同一工作树；
- 中心委派限制主要是 depth，缺少并发、调用数、期限和输出上限。

BB 的 thread SDK、持久 queued messages、active-turn steer 和 parent/child topology
证明这些原语有产品价值；但 BB 在本次比较的锁定版本中已经移除特殊 Manager Thread。
VibeX 因此采用普通 Conversation + relation，不引入 Manager Conversation 类型。

## Decision drivers

1. Event Log 继续是 Conversation 输入和 Turn 生命周期的唯一权威。
2. 任意客户端重试、断线和并发提交都不得重复发送输入。
3. 调用方不需要先读取“是否空闲”再决定如何发送。
4. Steering 必须忠实反映当次 Agent Session 的真实能力和目标 Turn。
5. 委派不能扩大父会话的路径、凭据、权限或资源预算。
6. UI、Remote、CLI、SDK、MCP 和 Workflow 不得形成各自的队列或生命周期。
7. 接口保持小而深；不复制 BB 的所有 send mode 和别名。

## Decision

### 1. ConversationControl 是唯一写入口

Application Core 提供一个深的 `ConversationControl` module。其公开 interface 只表达
产品 intent，不暴露 ACP、Tauri、Axum、SQLite 或 React 类型：

```text
create(input, operation_id) -> Conversation
create_child(parent_id, relation, input, operation_id) -> Conversation
submit(conversation_id, input, operation_id) -> InputReceipt
steer(conversation_id, expected_turn_id, input, operation_id) -> SteeringReceipt
cancel(conversation_id, expected_turn_id, operation_id) -> TurnSnapshot
watch(conversation_id, after_sequence, condition) -> WatchResult
```

查询列表、详情、事件和输出继续是读 interface；fork 继续遵循 ADR-0005 的独立历史语义，
但通过同一个 Application Core 和 operation id 暴露。Transport 可以组合更友好的 CLI
命令，不能绕过上述写 interface。

`submit` 是普通输入的唯一入口。它总是先持久化，Conversation 空闲时立即被 dispatcher
认领并创建 Turn；已有在途 Turn 时保持排队。调用方不再使用“先查状态，再选择 start 或
queue”的竞态流程，也不需要 `auto`、`start`、`queue-if-active` 等重叠模式。

`steer` 是唯一例外：它向指定的 active Turn 追加纠偏输入，不创建新 Turn，也不进入
普通输入队列。它必须携带 `expected_turn_id`，目标已变化时返回 conflict。

### 2. Queued Conversation Input 是事件溯源领域事实

每个普通输入具有稳定 input id、operation id、revision、创建者、结构化 PromptBlocks、
Agent/Profile 与配置选择、PluginAction 引用和排序键。以下状态迁移由 Conversation Event
记录，名称可以随实现调整，语义不得改变：

```text
Queued -> Claimed -> Dispatched(turn_id)
   |         |
   |         +-> Queued        // 仅在尚未创建 Turn、且 claim 过期时恢复
   +-> Updated
   +-> Cancelled
```

- 同一 Conversation 只有一个输入消费者，按稳定顺序认领；
- queue side table、React Query 和远程缓存都是可重建投影，不是第二权威；
- claim、事件追加和投影更新位于同一事务；claim token 与期限阻止双消费者；
- dispatcher 先创建 Turn 并持久化 `Dispatched(turn_id)`，再向 Agent 发送 Prompt；
- 进程在 Prompt 发送后崩溃时，该 Turn 按 ADR-0001 成为 Interrupted，输入绝不重新排队；
- operation id 在相同 principal、command 和资源范围内幂等，payload 冲突必须失败；
- queued input 支持多条、更新、取消和重排；已经 claimed/dispatched 的输入不可编辑；
- v1 不引入 batch/group 语义；出现真实原子多输入用例时再单独增加。

前端现有本地单消息 queue 必须删除，Composer 直接消费服务端 queue projection。离线
Composer 内容仍是 ADR-0042 的 Conversation draft；只有服务端接受后才是 queued input。

### 3. Steering 是协商能力，不是模拟成功

`SteerActiveTurn` 进入协议无关的 AgentRuntime semantic interface。ACP Adapter 只有在
当次连接协商到真实能力时才能声明支持，并把 steering receipt 或稳定错误映射回核心。

- 显式 steer 不支持时返回 `steering_unsupported`，不得改成 queued input；
- active Turn 不匹配时返回 `turn_conflict`，不得发送到新的 Turn；
- steering 请求、Agent receipt 和拒绝都进入 Conversation Event Log；
- 连接在 receipt 前丢失时记录 unknown/interrupted 证据，不自动重发；
- UI 可以让用户显式选择“纠偏当前 Turn”或“下一条输入”，不能用同一个按钮隐藏降级；
- V1/V2 或不同 Agent 的 wire 差异只存在于 Adapter。

### 4. ConversationRelation 统一拓扑，不共享历史

父子导航使用通用关系事实：

```text
ConversationRelation {
  parent_conversation_id,
  child_conversation_id,
  kind: fork | delegation | workflow_step,
  visibility: visible | hidden
}
```

关系与 child identity 必须原子创建。它只统一导航、可见性、权限检查和 parent summary，
不参与 Conversation Event Log 的读取：fork 仍复制历史，delegation 和 workflow step
仍从自己的历史开始。`hidden` 只影响默认列表展示，不绕过审计、授权和直接导航。

父 Conversation 投影聚合直接 children 的 running、waiting、completed、failed、
cancelled、interrupted 数量，以及待决 permission/question 和预算摘要。聚合是读模型，
child Conversation 与 Turn 仍是执行事实。

### 5. 委派复用控制面并快照执行策略

Delegation Broker 不再直接拥有一套平行的 child launch 生命周期。它负责委派授权、预算、
结果归并和 companion 协议，并通过 `ConversationControl.create_child`、`submit`、`watch`
与 `cancel` 执行工作。

每次 delegation call 快照以下策略：

- completion：v1 为 child 首个 Turn 终态；后续对 child 的输入是新的显式操作；
- lifetime：默认 parent connection scoped；只有用户或 Workflow 明确创建的 durable child
  可在父连接结束后继续；
- workspace access：`read_only_shared`、`write_serialized` 或 `write_isolated`；未知任务
  默认 `write_serialized`；
- hard limits：depth、max active children、max calls、deadline、max result bytes；
- usage limits：只有 Agent 提供可信 usage 时才能作为硬 token/cost limit，否则显示
  unavailable，不能伪造精确预算。

同一工作区不得并发运行两个可能写入的 child。`write_serialized` 使用父工作区互斥锁；
`write_isolated` 使用从可验证 checkpoint 创建的独立 worktree。无法安全创建 checkpoint
时拒绝并行写或回退到显式串行，不得静默共享写目录。VibeX 不自动 merge、push 或发布
child 修改；diff/artifact 作为交接证据。

companion token 只能操作其 parent Conversation 和在该 scope 内创建的 descendants，
且继续受 connection、工作根、权限和撤销约束。它不能使用通用会话命令访问任意用户
Conversation。

### 6. 所有适配器共享同一命令与事件

Command Registry 增加上述会话操作和稳定 error envelope。Tauri、Remote HTTP/WS、未来
CLI/SDK 与 `vibex-mcp` 仅做认证、序列化和展示适配；事件订阅统一使用 conversation
sequence/cursor。命令与事件 schema 按 ADR-0033 版本化，旧客户端对未知 queue/relation/
steering 事件安全降级。

首个 CLI surface 只提供一组名称：`conversation create|child|send|steer|wait|cancel|fork`。
不同时维护 `thread`、`session`、`tell`、`spawn` 等同义命令。代码 SDK 是 Remote Protocol
生成类型与一个薄 client，不复制领域对象。

## Compatibility with existing ADRs

| ADR      | 关系                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| ADR-0001 | 保留 Interrupted Turn 绝不自动重发；dispatched input 不重新入队                    |
| ADR-0003 | Conversation Event、queue reducer、relation projection 仍归 `crates/conversations` |
| ADR-0005 | relation 只增加导航；fork 的复制历史语义不变                                       |
| ADR-0031 | 保留 LLM-mediated delegation 和 one-shot completion；增加通用控制面与安全策略      |
| ADR-0033 | 所有本地/远程入口经过同一 Application Core 与版本化 schema                         |
| ADR-0035 | steer 位于 Semantic Session seam；能力来自当次连接协商                             |
| ADR-0042 | draft 与 queued input 分离；多设备显示同一服务端 queue projection                  |

## Consequences

### Positive

- 队列、幂等、恢复与单消费者规则从 UI 集中到一个深 module；
- 桌面、远程、Agent 和未来 Workflow 获得相同的会话能力；
- native steer 真实可见，unsupported 不再被静默包装成 follow-up；
- parent/child 导航统一而不污染 Conversation 历史；
- 并行委派的写入冲突和资源失控成为可执行策略，而不是提示词约定；
- 相比 BB，VibeX 额外提供事件溯源、多客户端 operation id、能力诚实性与 worktree 安全。

### Negative

- 普通发送从直接 start Turn 改为先追加 queued input，需要迁移现有调用者和测试；
- queue claim 与 Turn 创建必须共享事务，数据库接口会增加条件更新；
- relation migration 要合并既有 fork/delegation 元数据而不改变历史；
- 安全的隔离写需要 checkpoint/worktree 证据，无法用简单 cwd 继承替代；
- 部分 Agent 不支持 steer，产品能力会诚实但不完全一致。

## Considered options

### 复制 BB 的多种 send mode

否决。`start`、`auto`、`queue-if-active` 和 `steer-if-active` 让调用方学习状态机，并在
状态检查与提交之间留下竞态。普通输入统一持久化、steer 显式分离的 interface 更小。

### 保留 React Query queue，仅增加本地持久化

否决。它仍无法解决多设备、headless owner、原子 claim、operation id 和 Workflow
消费，且会制造第二权威。

### 新增 Manager Conversation

否决。普通 parent Conversation + relation + summary 已覆盖协调需求；BB 也已经移除
特殊 Manager Thread。新增类型只会扩大创建、列表、权限和 UI 分支。

### 让 Delegation Broker 成为通用会话控制面

否决。Broker 的职责是委派策略和结果归并；将普通 Conversation 输入放入 Broker 会让
用户发送、Remote 和 Workflow 被迫依赖 MCP/委派术语。

### Steering 不支持时自动排队

否决。运行中纠偏与下一 Turn 输入的时机、成本和用户意图不同，静默降级会产生错误确信。

## Acceptance criteria

1. 刷新、重启、断线和换设备后，多条 queued inputs 的内容、顺序与 revision 一致。
2. 两个客户端用同一 operation id 重试只产生一个 input；不同 payload 返回冲突。
3. 双 dispatcher 竞争时只有一个 claim，且一个 input 最多创建一个 Turn。
4. Prompt 发送后崩溃只产生 Interrupted Turn，不自动重发或重新入队。
5. queued input 可更新、取消、重排；claimed/dispatched input 拒绝修改。
6. native steer 只作用于 expected active Turn；unsupported 和 turn mismatch 稳定失败。
7. Tauri、Remote、CLI 和 MCP 的同一操作生成相同事件与错误码。
8. fork、delegation、workflow child 都能通过 relation 导航，但历史读取不依赖 parent。
9. parent summary 可从关系和 child 事实完全重建。
10. companion 不能操作 scope 外 Conversation，也不能扩大工作目录或权限。
11. 两个潜在写 child 不会并发共享同一工作区；隔离失败不会静默降级为并发写。
12. depth、active children、calls、deadline 与结果大小限制在桌面和 headless 一致执行。
13. 删除前端本地 queue 后，所有提交路径仍通过 Application Core 完成端到端任务。

## Review triggers

- ACP 标准化跨 Agent steering 或 queued prompt；
- 引入多人/多租户所有权模型；
- 实际需求证明需要原子 input batches；
- 隔离 child worktree 需要自动合并；
- 可信 usage 覆盖率足以把 token/cost 设为默认硬预算。
