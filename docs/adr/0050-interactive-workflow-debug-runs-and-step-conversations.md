---
status: accepted
date: 2026-08-14
decision-makers:
  - VibeX maintainers
---

# 交互式 Workflow 调试运行与步骤会话

## Context

ADR-0045 将 Agent step 映射为真实 Child Conversation 和 Turn，但当前 dispatcher 在第一个 Turn
完成后立即提取输出并调度下游。用户无法在节点内继续对话、冻结下游、单独测试一个节点，或在
运行到 C 后修改 B 并复用 A 的证据。线性 Inspector 与轮询也不足以表达并行 DAG 的真实状态。

## Decision

1. Agent step 拥有一个持久 Child Conversation，并可包含多个不可变 Turn。初始 Prompt 自动发送；
   用户或 Controller Agent 可以 Steering、取消当前 Turn、发送后续输入并查看完整证据。
2. 取消 Turn 使该 Turn 到达 `Cancelled`。继续对话创建新 Turn，不宣称恢复已终止生成过程。
3. 完成的 Turn 可以提出 Candidate step output。只有通过 Schema 校验并被策略接受的候选才成为
   Accepted step output，下游只能读取 accepted output。
4. Agent step 支持 `automatic` 与 `manual` completion policy。manual step 在候选产生后进入
   `awaiting_acceptance`；Human 或独立 Controller Agent 可以继续对话或接受候选。Worker Agent
   默认不能自我批准。
5. Definition 中的 Completion gate 是持久语义；Debug breakpoint 是单次 Debug run 的临时覆盖，
   两者不能混为一个可变定义字段。
6. Workflow run 增加 `pausing` 与 `paused` 非终态。暂停先关闭新步骤 claim，再取消全部在途 Turn；
   已发生的文件或外部副作用不回滚。终止仍是独立、不可恢复的终态操作。
7. 未修改 definition/input/checkpoint 时，恢复原 Run、原 Step attempt 与原 Child Conversation，
   但创建新 Turn。配置变化必须发布新 version 并创建 Derived workflow run。
8. Debug run 统一实现“测试此节点”和“从此节点重新运行”：前者只执行选中步骤，后者继续传递
   下游。两者共享隔离、Conversation、事件和审计语义。
9. Derived run 保留 parent relationship，只复用 definition/input/output contract 与 Workspace
   checkpoint 均可证明一致的上游 Accepted output。原 Run 永远保持只读。
10. Preview/Debug 默认使用隔离 worktree。外部发布、部署或消息等副作用需要幂等证据、补偿策略
    或当次显式确认。
11. Run、step、candidate、approval、pause、resume、fork 与 Conversation relationship 都写入持久
    事件日志。Workflow subscription 使用 snapshot → replay → high-water → live 契约。

## Consequences

- dispatcher 不能再把“Turn completed”直接等同于“Step completed”。
- UI 顶部必须区分“暂停运行”和“终止运行”；节点会话中区分 Steering、停止 Turn 与停止 Step。
- 并行节点在全局 paused 状态仍可分别继续节点对话，但 scheduler 保持关闭，直到恢复运行。
- 历史 attempts 进入节点详情；DAG 进度按 definition step 数量与每个 step 的最新 attempt 计算。

## Considered options

- **覆盖原 Run 的 B/C。** 否决。会破坏审计、复现和副作用证据。
- **真正暂停并恢复同一个 Turn。** 否决。多 Agent Runtime 不提供一致的生成进程快照能力，且违背
  Turn 终态不变量。
- **所有节点默认人工确认。** 否决。无人值守 Automation 将无法工作。

