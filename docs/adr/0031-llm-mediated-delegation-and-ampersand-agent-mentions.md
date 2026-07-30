---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# 多 Agent 采用 Codeg 式异步委派，Agent Mention 使用 `&`

VibeX 的首个完整多 Agent 协作模式采用 Codeg 已验证的 LLM-mediated delegation：
父 Agent 通过按会话注入的 `vibex-mcp` companion 调用异步委派工具，主进程内
Delegation Broker 创建一次性子 Conversation/Turn，父 Agent 通过状态工具等待、
轮询、取消并汇总结果。

本决定确认以下公开行为：

- `delegate_to_agent` 立即返回 `task_id`，子任务异步运行；
- `get_delegation_status` 支持批量查询和有界/无限等待；
- `cancel_delegation` 终止指定子任务；
- 每个子任务产生一等的子 Conversation，并持久化父会话、父工具调用和 delegation id；
- 支持并行 fan-out、深度限制、父级退出时级联取消、结果大小上限和持久化状态回退；
- 所有真正支持 ACP `session/new.mcp_servers` 的父 Agent 走同一注入管线，能力不支持
  时明确显示，禁止按 Agent 名称硬编码成功假象；
- 子任务 v1 为 one-shot，首个 Turn 到达终态即完成，不提供隐式多轮续聊。

现有 `crates/delegation`、`crates/delegation-proto`、`crates/vibex-mcp` 和
`src-tauri/src/delegation` 是继续完善的基础。目标是行为对齐 Codeg，而不是把其巨型
Broker 文件整体复制进 VibeX；现有模块边界可以替换，只要公开行为与不变量成立。

## `&Agent` Mention

Composer 中 Agent Mention 的可见触发符固定为 `&`，例如 `&Codex`。编辑器必须将其
保存为结构化 `AgentMention { agent_kind, display_name }`，不得依赖显示名称或发送时
重新做模糊匹配。发送到 Agent 时使用稳定、可读的序列化形式，例如：

```markdown
[&Codex](vibex://agent/codex)
```

Mention 只表达“用户明确要求考虑把工作委派给该 Agent”，并通过 companion tool
schema 告知父 LLM 应为每个被 Mention 的 Agent 调用 `delegate_to_agent`。它不是
前端直接创建子会话的隐藏命令。因此，LLM 不执行委派时必须在可观测数据中如实表现，
UI 不得仅因出现 Mention 就显示子任务已经启动。

`&` 只在 token 边界触发选择器；普通文本中的 `A&B`、URL 查询参数和代码块不得被
自动转换为 Mention。Mention 解析、序列化和粘贴往返必须有独立行为测试。

## 暂不采用显式 Graph 编排

由用户或后端确定性创建 fan-out/fan-in 图、预算、重试和汇总节点的
Graph Engineering 模式具有价值，但当前没有稳定领域基础。本阶段不建立半成品图
模型，也不把图概念泄漏进 Delegation API。未来应通过独立 ADR 决定 Workflow Graph
的节点、边、状态恢复、资源隔离和人工审批语义。

## 安全与生命周期

- companion 与 Broker 使用 UDS/Windows named pipe，加长度前缀帧和大小上限；
- 每个父会话使用短期随机 token，token 绑定 parent connection 与工作目录；
- 父连接 teardown 时吊销 token，并级联取消仍运行的子任务；
- 工作目录必须位于父会话允许的根范围内，子任务不得借 delegation 扩大路径权限；
- Broker 竞态采用 first-terminal-wins，完成、取消和父退出只能产生一个终态；
- Delegation 生命周期通过 Conversation 事件记录，缓存只是加速层。

## Consequences

- 现有“v1 仅 Claude Code 注入”的限制被取代；实施时按 Agent 真实 MCP 能力逐个开放，
  不能使用静态白名单冒充能力协商。
- 前端必须新增 `&Agent` Mention、委派卡片、子会话导航和刷新后状态重建。
- `ask_user_question`、`check_user_feedback` 与 `get_session_info` 可以使用同一
  companion/listener，但按独立 feature flag 暴露。
- LLM-mediated delegation 天生不是确定性调度；产品文案与测试必须如实验证“工具
  调用发生后”的行为，不把 Mention 本身当作执行保证。

## Considered Options

- 前端看到多个 Mention 后直接并发创建子会话：本阶段否决。它改变了用户与主 Agent
  的职责关系，实质上是尚未决策的 Graph 编排。
- 使用 `@` 作为 Agent Mention：否决。VibeX 选择 `&` 区分 Agent 与其它引用语法。
- 为每种父 Agent 写一套 delegation 实现：否决。是否可注入由 ACP/MCP 能力决定，
  Agent kind 只提供身份，不改变统一管线。
