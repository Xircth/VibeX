# BB 与 VibeX：会话、委派与工作流深度对比

> 日期：2026-08-13
> 基线：BB `aefe3ea49ef7d7236905893a5feaa5986a929872`；VibeX 当前工作区
> 续篇：[`2026-08-12-bb-agent-vibex-comparison.md`](./2026-08-12-bb-agent-vibex-comparison.md)

## 结论先行

VibeX 在这两个方向上都不是“从零开始”：它已经拥有可靠的 Conversation/Turn
事件语义、持久化委派子会话、取消传播、自动化租约、版本证据和每次运行的工作树隔离。
真正的差距在控制面，而不是执行底座：

1. **会话与委派**：VibeX 能让模型异步委派一个一次性任务，但尚未把
   `spawn / wait / tell / steer / queue / cancel` 做成统一、持久、可由用户、CLI、
   SDK、MCP 和工作流共同调用的会话原语。
2. **工作流**：VibeX 的 Automation 是“可靠地定时启动一个 Turn”；BB Workflow
   是“持久地编排一组有依赖、有并发、有结构化结果、可检查、可恢复的 Agent Call”。
   两者不是同一层抽象。

因此正确顺序是：**先补会话控制面，再建设独立 Workflow 域，最后让 Automation
成为 Workflow 的触发器之一。** 如果反过来直接做可视化流程编辑器，会在 UI 下复制一套
不可靠的队列、生命周期与执行状态。

还有一项需要修正前文表述：在本次锁定的 BB 版本中，专用的 Manager Thread 已被移除，
CLI 会明确提示改用带 `parentThreadId` 的普通子线程。BB 值得借鉴的是通用 parent/child
拓扑及操作原语，而不是一个特殊的 Manager 会话类型。

## 一、会话与委派

### 当前能力与真实差距

| 维度           | BB                                                                                       | VibeX 当前状态                                                                                                | 差距与影响                                                 |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 会话操作面     | SDK/CLI 对 thread 提供 spawn、fork、send、wait、events、output、stop、archive 等统一操作 | Application Core、Remote 和 Conversation 命令已有良好基础，但没有一套面向用户和 Agent 的完整公共 CLI/SDK 原语 | 自动化、UI、Agent 自操作容易各自接线，行为和权限逐渐分叉   |
| 活跃 Turn 输入 | `start`、`steer`、`queue-if-active`、`steer-if-active`、`auto` 是显式发送策略            | 主要是“空闲时 start”；没有通用、能力驱动的 `SteerActiveTurn`                                                  | 用户无法可靠纠偏正在运行的 Agent，调用方也无法声明预期语义 |
| 队列           | 数据库持久化；支持多条、更新、删除、重排、分组、claim 与陈旧 claim 恢复                  | Composer 仅支持一条消息，权威状态在 React Query `setQueryData`；Turn 结束后由组件 effect 启动                 | 刷新、重启、换客户端会丢失；无法保证顺序、幂等和单消费者   |
| 委派入口       | 用户、CLI、SDK、Agent 都可用相同 thread 原语建立父子关系和互发消息                       | 主要由模型通过 companion MCP 触发；`&Agent` 是提示，不是确定性指令                                            | 用户和工作流无法直接声明“必须委派给谁，并等待什么”         |
| 子会话生命周期 | 普通 thread，父子关系和 visibility 独立于执行方式                                        | 子任务会创建真实持久 Conversation，这是优势；但 broker 语义仍是一次性首 Turn 结果                             | 难以支持多轮澄清、父子互发消息和长生命周期协调             |
| 关系模型       | 通用 `parentThreadId`、origin、visible/hidden；工作流 worker 也复用 thread               | delegation parent 字段、fork provenance 分散存在，没有统一关系/可见性投影                                     | UI、查询、权限和统计需要按来源写特例                       |
| 聚合视图       | parent 可查看 child summary，worker 可隐藏                                               | 父会话有 Delegation Card，可打开/取消子会话                                                                   | 缺少运行/阻塞/失败汇总、待回答问题、权限请求和资源用量聚合 |
| 资源治理       | thread/workflow 层可组合并发、调用数、超时等预算                                         | 委派中心配置主要只有 enable 与 depth limit                                                                    | fan-out 容易消耗失控，且无法向用户解释“为何停止”           |
| 工作区安全     | thread/workflow 显式选择环境；工作流并发由调度器管理                                     | 委派子会话默认继承父工作目录                                                                                  | 并行写同一工作树可能竞争、覆盖或产生不可归因的修改         |

### 一个容易被名称掩盖的问题

VibeX 的 `crates/delegation/src/steering.rs` 负责 companion 的反馈、提问和 session
信息，但它不是“向任意活跃 Turn 注入新用户输入”的通用 steer 原语。类似地，前端显示
“消息队列”并不意味着平台已有可靠队列：当前实现只读写 QueryClient 内存，并且文案明确
限制为单条消息。产品表面已有名词，平台语义仍然缺失。

### 改进方案

#### 1. 先建立统一的 Conversation Input Intent

在 Application Core 定义一个可持久、可审计的输入意图，而不是让调用方判断当前状态：

```text
ConversationInputIntent
├── StartWhenIdle
├── SteerActive
├── QueueAfterActive
└── Auto  // 仅当调用方明确选择时，按能力与状态决策
```

建议同时要求 `conversationId`、稳定 `operationId`、预期 active turn id/revision 和完整的
结构化 PromptBlocks。显式 `SteerActive` 在 provider 不支持时应失败；只有 `Auto` 才允许
按已声明规则退化到 queue，避免用户以为已纠偏，实际却在 Turn 结束后才发送。

#### 2. 把队列从 UI 状态升级为领域事实

新增持久化 `ConversationQueueItem`，至少包含：

- 稳定 ID、conversation ID、revision、排序键、创建者和 operation ID；
- PromptBlocks、Agent/Profile、mode、plugin action 等完整启动输入；
- queued/claimed/dispatched/cancelled 状态，claim token 与租约时间；
- 可选 group ID，为批量重排和原子发送预留语义。

事件日志或数据库服务是唯一权威，React Query 只做投影缓存。消费时使用原子 claim、幂等
dispatch 和陈旧 claim 恢复；桌面端、Remote、CLI、MCP 必须调用同一 Application Core。

#### 3. 把 steer 做成 AgentRuntime capability

在 ACP/AgentRuntime 语义层增加 `SteerActiveTurn` 能力，而不是按具体 provider 写 UI 分支。
连接握手公开能力；命令执行时验证 active turn correlation；adapter 不支持就返回稳定错误码。
这样未来不同 Agent 的原生 steer、模拟 steer 或完全不支持都能被如实表达。

#### 4. 统一关系模型，但保留不同业务语义

建议新增通用投影：

```text
ConversationRelation {
  parentConversationId,
  childConversationId,
  kind: delegation | workflow_worker | fork | ...,
  visibility: visible | hidden
}
```

不要增加 `ManagerConversation` 类型。Fork 的历史分叉语义、Delegation 的任务语义和
Workflow Worker 的步骤语义仍应分别由各自领域事实维护；通用 relation 只统一导航、权限、
查询与聚合。

#### 5. 明确委派执行策略

每次委派应快照以下策略：

- `interaction`: one-shot / conversational；
- `lifetime`: parent-connection-scoped / durable；
- `workspace`: shared-readonly / shared-serial / worktree-per-child；
- `budget`: 最大活跃 children、总调用数、墙钟时间、token/cost、输出大小；
- `completion`: 首个 Turn、显式完成信号或用户接管。

并行可写任务默认必须使用独立 worktree；若最终需要合并，应把 diff/artifact 与合并决策
作为显式交接，而不是让多个 Agent 同时写父工作目录。

## 二、工作流

### Automation 与 Workflow 的边界

VibeX Automation 当前做得好的部分应保留：版本化 `TurnLaunchSpec`、owner lease、原子
due claim、取消检查点、真实 Conversation/Turn、四种终态、版本证据和
`WorktreePerRun`。它已经是合格的**触发与单 Turn 运行器**。

但当前 `RunSnapshot` 只有一个 conversation ID 和一个 turn ID；定义里只有一个 Agent、
一个工作区和一组 prompt/plugin 配置。前端目前主要生成每日 cron，并只编辑第一个 plugin
action。这无法表达步骤依赖、并行、结构化输出或恢复点。

| 维度       | BB Workflow                                            | VibeX Automation               | 应补能力                                                     |
| ---------- | ------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------ |
| 编排       | sequence、parallel、pipeline/map、phase、嵌套一次      | 启动一个 Turn                  | 独立、版本化 Workflow Definition                             |
| 运行记录   | run 与有序 call 持久化，hidden worker threads 仍可追溯 | run 关联一个 Conversation/Turn | WorkflowRun、StepRun/AgentCall，并链接真实 Conversation/Turn |
| 输出契约   | JSON Schema 校验的结构化结果                           | 自由文本终态                   | 保守 JSON Schema 子集、校验与有限修复                        |
| 调度与预算 | 共享 FIFO、并发上限、调用数、总超时                    | Automation 级运行租约和取消    | run 级并发/调用/token/cost/timeout 策略快照                  |
| 可观察性   | phase、live card、inspector、history、CLI              | 历史和单 Turn 状态             | 步骤 DAG/阶段、输出、重试、预算、子会话检查器                |
| 恢复       | 按调用哈希重放最长不变前缀                             | 中断可标记，但没有步骤恢复     | 基于步骤证据的谨慎复用与人工复核                             |
| 执行沙箱   | QuickJS 能力白名单，无 Node/fs/shell/network           | 无流程脚本运行时               | 先声明式 IR；代码 SDK 后续编译为同一 IR 并隔离运行           |

### 推荐领域模型

```text
Automation/Manual/API Trigger
            │
            ▼
WorkflowDefinition(versioned) ──► WorkflowRun(policy snapshot)
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                    StepRun                  StepRun
                  Agent / Gate          Sequence / Parallel
                         │
                         ▼
              real Conversation + Turn
```

- `WorkflowDefinition`：不可变版本、输入 schema、步骤 IR、输出 schema、默认策略；
- `WorkflowRun`：definition version、输入、workspace identity、策略快照、总体状态；
- `StepRun`：稳定 step key、attempt、依赖、输入摘要、输出、状态、时间和错误；
- `AgentCall`：链接真实 conversation/turn，不复制对话历史；
- `Artifact/Checkpoint`：步骤结束时记录 workspace/diff/artifact 证据。

MVP 只需要 `Agent`、`Sequence`、`Parallel`、`Phase` 和人工 `Approval/Gate`。`Map/Pipeline`、
嵌套工作流和代码 SDK 可后置。Automation 的 target 扩展为
`Turn(TurnLaunchSpec) | Workflow(WorkflowRef, args)`，而不是让 Automation 自身长成流程引擎。

### 恢复与副作用：不要直接照搬 BB

BB 会重新求值源码，并按 SHA-256 复用最长不变的成功调用前缀。这对纯计算很高效，但
Agent 调用可能已经改文件、发消息或操作外部系统，仅按输入哈希重放不足以证明安全。

VibeX 应要求步骤声明副作用等级：`read_only`、`idempotent`、`mutating_unknown`。只有在
definition/version、规范化输入、runtime/tool 版本、workspace identity/checkpoint 都匹配时，
已完成步骤才可自动复用。崩溃时处于 running 的 `mutating_unknown` 步骤进入
`NeedsReview`，默认不自动重跑；由用户检查 diff/artifact 后选择接受、重试或回滚。

### 作者体验与安全边界

第一阶段优先声明式 IR、模板和 UI，不把任意 JavaScript 或 shell 放进主服务进程。未来若
需要“代码定义工作流”，SDK 应编译为同一版本化 IR；动态逻辑在隔离进程/沙箱中执行，只
获得显式 capability。这样 CLI、UI、插件贡献和代码 SDK 最终仍共享一个运行时与审计模型。

## 三、分阶段路线图

### P0：会话控制面

1. 持久化多消息队列，替换 React Query 权威状态；完成 claim、幂等、恢复和多客户端测试。
2. 增加 capability-driven steer 与显式 Input Intent。
3. 通过相同 Core 暴露最小 CLI/SDK/MCP：`list/show/spawn/fork/tell/wait/queue/steer/cancel`。

### P1：协调拓扑与 Workflow MVP

1. ConversationRelation/visibility 与 parent child-summary 投影。
2. 委派 workspace、lifetime、interaction 和 budget 策略。
3. 建立 WorkflowDefinition/Run/StepRun；支持 Agent、Sequence、Parallel、Phase、Approval。
4. 结构化输出、运行历史、步骤检查器、取消传播；执行仍复用真实 Conversation/Turn。

### P2：安全恢复与生态

1. Map/Pipeline、有限嵌套、重试策略、workspace checkpoint 和副作用感知恢复。
2. token/cost 预算、缓存证据、模板和插件贡献点。
3. 隔离的代码 SDK/编译器，以及完整 CLI/Remote 自动化体验。

每阶段的发布门槛应包含：进程崩溃、多客户端竞争、重复 operation、陈旧 queue claim、
取消与完成竞态、不支持 steer 的 provider、并行写隔离、schema 修复失败和恢复时副作用审查。

## 四、明确不应做的事

- 不新增特殊 Manager 会话类型；使用通用 parent/child relation。
- 不把 UI 内存队列继续包装成平台能力；先确立后端权威。
- 不在未确认 provider 能力时静默把 steer 变成 follow-up。
- 不允许并行 worker 默认共享可写工作目录。
- 不为工作流建立第二套 Conversation/Turn 历史或终态定义。
- 不在 MVP 把任意 JS/shell 引入中心进程。
- 不自动重跑已开始但未确认是否产生副作用的步骤。

## 五、主要源码证据

### VibeX

- 委派 broker、状态等待与取消：`crates/delegation/src/broker.rs`
- 委派配置与深度限制：`crates/delegation/src/types.rs`
- 持久化委派 Conversation：`crates/conversations/src/service.rs`
- 桌面/服务端 child spawner：`src-tauri/src/delegation/spawner.rs`、
  `crates/server/src/delegation_runtime.rs`
- 当前前端单消息内存队列：
  `frontend/src/components/tasks/follow-up/useSessionComposerQueue.ts`
- Automation 单 Turn spec/run：`crates/automation/src/spec.rs`、
  `crates/automation/src/runner.rs`
- Automation UI 的 daily cron/首个 plugin action：
  `frontend/src/pages/settings/AutomationsSettings.tsx`
- 架构约束：ADR 0031、0032、0035。

### BB（锁定提交）

- [Thread SDK](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/packages/sdk/src/areas/threads.ts)
- [Thread API contract](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/packages/server-contract/src/api/threads.ts)
- [Thread send/steer policy](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/apps/server/src/services/threads/thread-send.ts)
- [Queued message domain](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/packages/domain/src/thread.ts)
- [Durable queue storage](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/packages/db/src/data/queued-thread-messages.ts)
- [Workflow design and semantics](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/plugins/workflows/README.md)
- [Workflow runtime scheduler](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/plugins/workflows/src/runtime.ts)
- [Manager command migration notice](https://github.com/badlogic/pi-mono/blob/aefe3ea49ef7d7236905893a5feaa5986a929872/apps/cli/src/commands/manager.ts)

## 最终判断

VibeX 最值得保留的是它已经统一的 Conversation/Turn 事实、终态、版本证据和安全隔离；
最应该向 BB 学习的是把这些底层事实升格为稳定的可编程原语，以及在其上增加真正的
Workflow Run/Step 模型。目标不是复制 BB 的 QuickJS 或旧的 Manager 概念，而是形成：

> **一个会话控制面、一套执行事实、两个清晰领域（Automation 负责触发，Workflow 负责
> 编排），所有 UI/CLI/SDK/Agent 操作共享同一语义。**
