---
status: accepted
date: 2026-08-13
decision-makers:
  - VibeX maintainers
---

# Workflow 以持久 DAG 编排真实 Conversation 与 Turn

VibeX 新建独立 Workflow 领域：版本化 Workflow Definition 描述无环步骤依赖，一次
Workflow Run 通过持久 Step Run 编排真实 Conversation 与 Turn。Automation 继续负责
manual/schedule 触发与到期认领，但 target 扩展为单个 `TurnLaunchSpec` 或版本化
Workflow；Workflow 不复制 Conversation 历史、Turn 状态机、Agent runtime 或权限系统。

本决定落实 ADR-0031 延后的确定性编排，并扩展 ADR-0032。ADR-0032 的单 Turn Automation
仍然有效；与“Automation 必须且只能直接创建一个 Conversation/Turn”以及“所有遗留
running Automation Run 都立即 Interrupted”冲突之处，以本 ADR 的 target union 和
target-specific recovery 为准。

## Context

当前 Automation 已经可靠解决：版本化启动配置、manual/schedule、IANA timezone、原子
due claim、单 owner lease、运行取消、版本证据、真实 Conversation/Turn、崩溃后
Interrupted 和默认 worktree-per-run。它的 `RunSnapshot` 只关联一个 Conversation 与
一个 Turn，因此它是可靠触发器和单 Turn runner，不是流程编排器。

BB Workflow 已提供 sequence、parallel、pipeline、phase、结构化输出、共享并发预算、
历史、停止和按调用摘要恢复。VibeX 若只在 Automation 配置中继续添加“下一步”“并行”
字段，会把调度、步骤状态和恢复规则塞进一个原本清晰的领域；若在插件内复制 BB 的
QuickJS + 独立 SQLite，又会形成第二套执行事实、权限和恢复系统。

VibeX 的机会不是逐项复制 BB，而是复用已有事件日志、四种 Turn 终态、Application Core、
版本证据、worktree 隔离和多端 Remote，在副作用安全、可解释恢复和多客户端一致性上
超过 BB。

## Decision drivers

1. 每个 Agent 执行必须是可打开、可审计、可取消的真实 Conversation 与 Turn。
2. Workflow 的步骤状态必须在重启后恢复，且不得自动重放可能已产生副作用的工作。
3. 定义、输入、输出、预算、版本和 workspace evidence 必须足以解释一次运行。
4. 并行能力不能以多个 Agent 同时写一个工作树为代价。
5. Workflow authoring 与运行时实现分离；首版不执行任意 JavaScript 或 shell。
6. UI、Automation、CLI、Remote 和插件贡献共享一个 Workflow Core。
7. 首版只实现能交付完整价值的最小节点集合，不为未来节点建立空抽象。

## Decision

### 1. Workflow 是独立领域，Automation 只是触发器之一

核心实体如下：

```text
WorkflowDefinition(versioned)
        |
        v
WorkflowRun(definition snapshot + input + policy + workspace)
        |
        +-- StepRun -- AgentStep --> ConversationRelation(workflow_step)
        |                               |
        |                               +--> Conversation --> Turn(s)
        |
        +-- StepRun -- ApprovalStep
```

- **Workflow Definition** 是不可变版本，包含输入 schema、稳定 step id、依赖、step spec、
  output bindings、phase metadata 和默认 policy；编辑会创建新版本；
- **Workflow Run** 绑定一个 definition version、规范化输入、workspace identity、policy
  snapshot 和 resolved version evidence；运行期间不重新读取“最新版”定义；
- **Step Run** 是某一步在该 Run 中的一次执行记录；attempt 是显式重试产生的新记录，
  不覆盖旧证据；
- **Agent Step** 通过 ADR-0044 的 ConversationControl 创建 hidden workflow child、提交
  输入并等待真实 Turn；
- **Approval Step** 持久等待明确 principal 的批准、拒绝或取消，不伪装成 Agent Turn；
- **Phase** 只是步骤分组、进度和展示元数据，不拥有第二套状态机。

Automation target 变为：

```text
AutomationTarget
  Turn(TurnLaunchSpec)
  Workflow(WorkflowVersionRef, input)
```

Automation Run 记录触发、schedule 和 target launch 结果；Workflow target 的业务终态由
关联 Workflow Run 决定。manual、API、CLI 和插件也可以直接启动 Workflow Run，不能
为了复用 schedule 而伪造 Automation。

Direct Turn target 在 Host 重启时继续遵循 ADR-0032：遗留 running Run 与对应 Turn
成为 Interrupted，绝不重发。Workflow target 已经关联一个持久 Workflow Run 后，Host
重启只协调该 Run，不重新触发 target，也不因 dispatcher 进程死亡就把 Automation Run
提前终止；Automation Run 保持 running 并投影 linked Workflow 的 waiting/needs-review
摘要，直到 linked Workflow 到达终态。尚未成功创建 Workflow Run 的遗留 launch 才按
Interrupted 结束。

### 2. Definition 使用声明式无环依赖图

首版 Definition 是稳定 step id 到 Step Spec 的有序映射，加显式 `depends_on`。没有依赖
的 steps 就绪；所有依赖完成后就绪；多个就绪 steps 可在预算和 workspace policy 允许时
并行。Sequence 与 parallel 由依赖边表达，不增加仅用于包裹数组的节点类型。

首版只有两种可执行 Step Spec：

```text
AgentStep {
  launch: AgentStepSpec,
  input_bindings,
  optional_output_schema,
  workspace_access,
  side_effect_class
}

ApprovalStep {
  title,
  decision_schema,
  approver_scope
}
```

Definition 保存前必须验证稳定 ID 唯一、依赖存在、无环、引用的上游 output 存在、schema
属于受支持子集且所有步骤可达。动态 map、condition、nested workflow 和任意 transform
不进入 v1；出现真实用例后，它们编译为同一 DAG snapshot，而不是创建第二执行器。

Workflow Definition 的持久格式是版本化、transport-neutral 的数据。未来 TypeScript/
Rust SDK 可以编译和验证该格式，但 SDK 代码不在 VibeX 主进程内执行。插件可以按
ADR-0043 贡献 definition/template；导入后仍经过同一 validator、版本和信任规则。

### 3. Workflow Event Log 是运行权威

每个 Run 使用仅追加、单调 sequence 的 Workflow Event Log。典型事实包括 RunStarted、
StepReady、StepStarted、StepWaitingApproval、StepOutputAccepted、StepCompleted、
StepFailed、StepCancelled、StepInterrupted、StepNeedsReview 和 RunSettled。

`workflow_runs`、`workflow_step_runs`、ready queue 和 UI summary 都是可重建投影。claim
使用 projection 做条件更新，但 claim、权威 event 和 projection update 必须在同一事务。
内存 task、scheduler queue 和 WebSocket 只是加速层。

Workflow Run 状态为 running、waiting、completed、failed、cancelled、interrupted 或
needs_review；completed/failed/cancelled/interrupted 四种与 Turn 同名状态保持相同含义，
waiting 表示存在 Approval/Interaction，needs_review 表示系统不能安全自动决定下一步。
一个 Run 只能 first-terminal-wins 地 settle 一次。

Workflow Core 对外保持小 interface：

```text
publish(definition) -> WorkflowVersion
start(version, input, workspace, policy, operation_id) -> WorkflowRun
decide(run_id, step_id, decision, operation_id) -> StepRun
cancel(run_id, operation_id) -> WorkflowRun
resume(run_id, review_decision, operation_id) -> WorkflowRun
watch(run_id, after_sequence, condition) -> WatchResult
```

Definition 查询/历史和 Run 查询/事件是读 interface。Tauri、Remote、CLI、SDK、Automation
和 Plugin adapter 共享这些操作与稳定错误码。

### 4. Agent Step 复用会话事实，不复制 runtime

每个 Agent Step attempt 创建一个 workflow child Conversation 和 relation，并用
ConversationControl `submit`、`watch`、`cancel` 执行。为避免 `crates/workflows` 依赖
`crates/application` 形成循环，Workflow implementation 只依赖内部
`ConversationExecutorPort`；Application composition 提供调用 ConversationControl 的
production adapter，测试提供 scripted adapter。该内部 seam 不进入 Workflow 的公开
interface。StepRun 保存 conversation id、turn ids、resolved Agent/runtime/plugin/tool
evidence、usage 和 artifact/checkpoint 引用。

Workflow Event Log 只保存步骤编排事实和引用，不复制 prompt stream、tool calls、权限或
Turn 终态。权限、Elicitation 和用户问题继续在 child Conversation 中解决；Workflow
Run 投影只显示 waiting summary 并链接原请求。取消从 Run 传播到 running Steps，再传播
到 active Turns，但各层只有自己的权威终态。

同一个 child 可在 output schema 校验失败后接收至多一次显式 repair Turn；repair 计入
Agent call、token、deadline 和历史。仍不合法则 StepFailed，不用正则或 UI 猜测结果。

### 5. 结构化输入输出使用受限 JSON Schema

Workflow input、Agent Step output 和 Approval decision 使用一个明确版本的 JSON Schema
子集。首版支持 object、array、string、number、integer、boolean、null、enum、required、
properties、items 与长度/数值上限；拒绝远程 `$ref`、自定义代码、正则灾难性回溯和未知
关键字。

Agent 的自由文本输出仍保存在 Conversation；Step output 是经 parser 与 schema validator
接受的独立 JSON value，并记录来源 Turn、schema digest 与 validation evidence。下游只
能引用已接受 output。输出与通知都有字节上限，超限明确失败而不是截断成看似有效 JSON。

### 6. Policy snapshot 统一预算和公平调度

Run 启动时快照：max concurrent Agent Steps、max Agent calls、deadline、max output bytes、
retention、可用时的 token/cost ceilings，以及取消/失败传播策略。所有 nested work 共享
父 Run 预算；不允许通过 child Workflow 或 repair Turn 重置计数。

同一 Host 的 Workflow dispatcher 使用同一个 data-directory owner lease 和持久 ready
queue，不再启动一个与 Automation Engine 竞争的内存调度器。公平性采用简单 FIFO；只有
实际 starvation 证据出现后才引入优先级。全局并发和每 Run 并发同时满足才能 claim。

usage capability 不可用时 token/cost 只报告 unknown，不能当作已经执行的硬限制。calls、
concurrency、deadline 和 bytes 永远是硬限制。

### 7. Workspace policy 禁止未隔离并发写

Workflow Run 默认拥有独立 run worktree，延续 ADR-0032。Step 的 workspace access 为：

- `read_only_shared`：可以在同一 run workspace 并行，只获得只读工具权限；
- `write_serialized`：获得 run workspace 的独占写租约；
- `write_isolated`：从已记录 checkpoint 创建 step worktree，可与其它隔离 step 并行。

两个可能写入的 steps 不得并发共享一个 workspace。`write_isolated` 完成后保存 diff、
artifact 和 checkpoint，不自动合并回 run workspace。后续需要消费修改时必须由显式
Approval Step 或未来独立 Apply Step 决定；v1 不引入自动 merge 节点。

side-effect class 为 `read_only`、`idempotent` 或 `mutating_unknown`。这是恢复与重试
证据，不是信任 Agent 自我声明：`read_only` 只有在工具权限实际强制只读时成立；无法
强制时按 `mutating_unknown` 处理。

### 8. 恢复基于不可变 Run 和 workspace evidence

Host 启动时先 reconcile running Runs，再 dispatch ready Steps：

- 已完成 Step 只有在 definition version、规范化 input digest、schema digest、运行时/
  工具版本证据、workspace identity 和 checkpoint 都匹配时才继续复用；
- 等待 Approval 的 Step 保持 waiting；决定使用 operation id 幂等；
- crash 时仍 running 的 Agent Step 对应 Turn 按 ADR-0001 变为 Interrupted；
- interrupted `mutating_unknown` Step 必须进入 needs_review，绝不自动重发；
- 只有能证明 Prompt 尚未提交给 Agent 的 preflight failure 才能自动回到 ready；
- 用户 review 可以接受现有工作区结果、创建新 attempt 重试、跳过允许跳过的 Step，或
  取消 Run；每个决定成为事件；
- Definition 源码或最新版改变不会让已开始 Run “追上新版本”。修改后应启动新 Run。

这比仅按 Agent call hash 重放更保守：摘要相同不足以证明文件或外部系统副作用相同。
VibeX 优先保证不重复副作用，再讨论缓存命中率。

### 9. 可观察性与多端行为来自同一投影

Conversation timeline 只显示一个紧凑 Workflow Run card；完整 inspector 展示 phase、
steps、依赖、children、waiting interaction、accepted output、attempts、版本、预算、
workspace evidence 和取消/恢复动作。桌面、Web 与移动端消费相同 Run summary/event schema；
能力不足的客户端安全显示未知 step/event，不阻止 Run 继续。

首个 CLI surface 为 `workflow validate|publish|run|show|wait|cancel|resume|history`。CLI
调用 Remote/Application Core，不在本地重写 validator 或 scheduler。Workflow 的定义
JSON 可存仓库并由 CI 调用 `validate`；可视化编辑器不是内核完成的前置条件。

## Compatibility with existing ADRs

| ADR      | 关系                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| ADR-0001 | running Agent Step 崩溃后绝不自动重发对应 Turn                                                                         |
| ADR-0003 | child Conversation/Turn 事实仍由 `crates/conversations` 拥有                                                           |
| ADR-0031 | 落实其延后的确定性编排；LLM delegation 继续作为另一入口                                                                |
| ADR-0032 | 保留调度、owner lease、版本证据和 worktree 默认；Direct Turn 仍 crash→Interrupted，Workflow target 改为协调 linked Run |
| ADR-0033 | Workflow commands/events 通过同一 Application Core 与 Remote Protocol                                                  |
| ADR-0035 | Agent Step 使用协议无关 Semantic Session interface 和真实能力                                                          |
| ADR-0043 | Plugin 可贡献 Workflow definition/template，但不创建私有运行时                                                         |
| ADR-0044 | Agent Step、child relation、输入、等待、取消全部复用 ConversationControl                                               |

## Consequences

### Positive

- Automation 保持简单，Workflow 获得独立且可恢复的运行模型；
- 每个 Agent 步骤都能打开完整 Conversation，权限和工具历史没有第二份；
- 声明式 DAG 用依赖边同时表达 sequence 和 parallel，接口比嵌套组合器更小；
- 事件溯源、operation id、Remote parity 和安全 workspace policy 超过 BB 的插件内运行；
- 崩溃恢复不依据 call hash 猜测副作用，用户能基于 diff/checkpoint 做决定；
- 未来 UI、SDK 和插件只需产生同一 Definition，不扩展执行器数量。

### Negative

- 需要新的 Workflow Event Log、projection 和 dispatcher；Automation tables 不能直接
  冒充多步骤状态；
- DAG、schema 和 output bindings 需要严格 validator 与兼容版本；
- hidden child Conversations 会增加存储与 retention 压力；
- 安全的并行写需要 step worktree 和显式交接，首版能力少于自动合并系统；
- 声明式 v1 不支持任意代码控制流，复杂 Workflow 要等待有证据的扩展。

## Considered options

### 继续扩张 Automation

否决。触发计划与步骤编排有不同身份、状态、恢复和观察需求；合并后 Automation 会成为
无法测试的调度器、DAG、Agent runtime 和 UI 集合体。

### 复制 BB 的 QuickJS 和插件 SQLite

否决。它会新增代码执行信任面、第二数据库、第二调度器和第二运行事实。VibeX 首版用
声明式 DAG；未来 SDK 编译为同一格式，动态逻辑在隔离进程内运行。

### Workflow Step 直接调用 Agent runtime

否决。它会绕过 Conversation Event Log、权限、恢复、Remote 查看和 Turn 终态，产生
不可审计的后台 Agent 路径。

### 每个组合器都是节点类型

否决。Sequence 和 parallel 已由依赖边完整表达；Phase 只是 metadata。只有拥有独立
生命周期或权限语义的行为才成为 Step Spec。

### 按输入 hash 自动重跑或复用所有 Agent calls

否决。hash 不证明 workspace 和外部副作用一致；运行中中断的 mutating step 必须人工
复核，已完成步骤也需要版本和 checkpoint evidence。

### 首版自动合并隔离 Step 的修改

否决。自动 merge 需要冲突、审查、失败恢复和权限语义；diff/artifact 交接已足够交付
安全的并行执行。

## Acceptance criteria

1. Definition validator 拒绝环、缺失依赖、失效 output 引用、重复 ID 和不支持的 schema。
2. Run 永久绑定一个 definition version 与 policy snapshot，定义更新不改变在途 Run。
3. sequence/parallel DAG 在重启前后产生相同 ready order 和最终输出。
4. 双 dispatcher 只 claim 一次 Step；一个 attempt 最多创建一个 child Conversation。
5. 每个 Agent Step 可从 Run inspector 打开其 Conversation 和所有 Turn。
6. permission/question 在 child Conversation 中解决，Run 正确投影 waiting 且不复制请求。
7. 结构化输出只能在 schema 校验成功后被下游引用；repair 最多一次且计入预算。
8. Run 取消传播到所有 running child Turns，并只产生一个 Run terminal state。
9. crash 后 completed Steps 在证据一致时保留；running mutating Steps 进入 needs_review。
10. 任何潜在写 Steps 都不会并发共享一个 workspace，隔离 Step 不自动合并。
11. manual、Automation、CLI 和 Remote 启动相同版本时产生相同 Run/Step 事件语义。
12. calls、concurrency、deadline 和 output bytes 在 desktop/headless 一致硬限制。
13. Workflow Event Log 可从零重建 Run/Step/ready/summary 投影。
14. 未安装 Workflow 插件或新版 UI 不影响历史 Run 的只读解释与 child Conversation。
15. 完成 BB 对标门槛：持久 sequence/parallel/phase、结构化输出、预算、history、wait、
    cancel 和 restart continuation；并额外通过副作用复核、worktree 隔离、多客户端幂等、
    capability-honest Agent 执行与 Remote parity 门禁。

## Review triggers

- 真实 Workflow 需要动态 map/condition/nesting 且静态展开不可接受；
- 需要自动合并或 Apply Step；
- 需要在定义中运行用户代码；
- 引入多用户审批、组织权限或共享 Workflow；
- 持久 Run 数量证明单一 FIFO 产生 starvation；
- 有可靠外部事务/幂等协议支持自动恢复 mutating Steps。
