---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# 计量以 conversation_event 为归属权威，厂商日志降级为分项 token 的补充来源

Token 报告改从 VibeX 自己的事件日志出账，并补上按目录与按 Agent 的维度。厂商
日志不删，但它从「唯一事实来源」降级为「分项 token 的补充证据」，且必须按会话
标识对齐，不再按路径字符串猜归属。

本决定受 [ADR-0058](0058-session-auxiliary-capability-honesty.md) 约束：缺失的
token 分项保持缺失，不填零、不当作事实展示。

## Context

`KanbanUsageDashboard` 今天的数据来自 `get_project_usage_statistics`，它扫两个
目录：`~/.claude/projects/<encoded-path>/*.jsonl` 与 `~/.codex/sessions/**/*.jsonl`，
再按项目仓库与 workspace 的 `container_ref` 路径过滤。

四个问题：

1. **覆盖率**。内置 Agent 有 13 个，扫描器认识 2 个。用 Kimi、Cursor、Grok、
   DeepSeek 跑的会话，在计量里完全不存在——不是显示为 0，是根本不出现。报表
   因此系统性低报，而用户无从知道低报了多少。
2. **事实来源在产品之外**。Claude 或 Codex 改一次日志布局，VibeX 的报表就静默
   变空或变错，而 VibeX 对此没有任何检测手段。
3. **归属靠路径字符串**。Codex 扫描按 `cwd` 与 workspace 路径比对。worktree
   与 project-root 指向同一仓库的不同目录，符号链接、大小写不敏感文件系统、
   多根工作区都会让这个比对出错，而错的方向是静默的。
4. **已经有第二本账**。`ConversationEvent::UsageUpdated { usage: ConversationUsage }`
   已在事件日志里，字段是 `input_tokens` / `output_tokens` /
   `cache_creation_input_tokens` / `cache_read_input_tokens` / `context_used` /
   `context_window_max` / `cost_amount` / `cost_currency`。两本账互不校对。

但直接「全部改从事件出」会撞上 ADR-0058：ACP v1 的 `UsageUpdate` 给的是
**上下文占用**（`used` / `size` / `cost`），分项 token 只在 Agent 通过 `_meta`
额外提供时才有。按 ADR-0058，没提供就保持 0 且 **UI 不得当分项事实显示**。

也就是说：**事件日志的归属是准的、覆盖是全的，但分项 token 大多缺失；厂商日志
的分项 token 是真的，但只覆盖两家、归属靠猜。** 任何只选一边的方案都在骗人。
端到端 usage 的 ACP RFD（`PromptResponse` 上的可选 `usage`）是长期正路，VibeX
今天不消费——`AgentPromptFinished` 只读 `stop_reason`。

## Decision drivers

1. 归属必须是确定的，不能是字符串匹配的结果。
2. 每个数字要能说出它从哪来。
3. 覆盖缺口要显示成缺口，不能显示成零。

## Decision

### 1. conversation_event 是归属与口径的唯一权威

报表的行集合、维度归属与会话计数全部由事件日志与会话表决定，不由厂商日志决定。
维度键：

- **按目录**：`sessions.workspace_id` → `workspaces.project_id` /
  `workspaces.container_ref`。这是关系，不是路径比对。
- **按 Agent**：`sessions.agent_id`（`AgentKind` 的规范形态）。
- **按模型**：来自会话事件里 Agent 给出的模型标识。

一个会话出现在报表里，只因为它在 `sessions` 里且属于该项目——与它用哪个 Agent、
厂商是否写日志无关。**覆盖缺口因此变成可见的**：Kimi 会话会出现，只是它的分项
token 是缺失而不是零。

### 2. 每个数值带来源标记，不同来源不相加

计量值分两个来源：

| 来源 | 内容 | 可信度 |
|---|---|---|
| `protocol` | ACP `UsageUpdate` 与 `_meta`，落在 `UsageUpdated` 事件里 | 会话内权威 |
| `vendor_log` | Claude / Codex 日志扫描 | 仅覆盖两家 |

UI 不得把两个来源的数字加成一个「总 token」。同一维度下若两个来源都有值，
展示 `protocol` 并把 `vendor_log` 作为对照；不一致时显示不一致，不做取舍。
`context_used` / `context_window_max` 是上下文占用，**任何情况下不与 token
分项相加**——这是 ADR-0058 已经定过的区分，报表层不得重新混淆。

### 3. 厂商日志按会话标识对齐，不按路径

日志条目通过 `sessions.external_session_id` 与会话行对齐。对不上的条目
**不进项目报表**，只允许出现在一个独立的「未归属」计数里。

这一条会让报表数字比今天小，因为今天靠路径匹配捞进来的一部分条目会失去归属。
这是修正，不是回退：那些条目本来就不确定属于哪个项目。

### 4. 缺失显示为缺失

某个维度下没有分项 token 时，显示为「未提供」而不是 0，并说明原因（该 Agent
未通过协议提供 token 分项）。用户由此知道「这个 Agent 我看不到 token」，而不是
误以为「这个 Agent 没花 token」。

成本同理：`cost_amount` 只在 Agent 提供或本地费率表能覆盖该模型时给出；覆盖不到
的模型不估算。

### 5. 消费端到端 usage，补齐分项 token 的正路

宿主开始消费 ACP `PromptResponse` 上的可选 `usage`（端到端 usage RFD），把它
作为 `protocol` 来源的一部分写入回合终态。这是让分项 token 从「少数 Agent 有」
走向「多数 Agent 有」的唯一不靠猜的路径。

Agent 不提供时行为不变——缺失仍是缺失。

### 6. 订阅额度与 token 计量是两件事，不并表

`plan_usage.rs` 的 `AgentPlanUsage` 描述的是订阅窗口占用，与本次会话花了多少
token 没有可加关系。`PlanUsageDashboard` 保持独立标签页，不并入 token 报表的
总计。

## Consequences

- 报表覆盖从 2 个 Agent 扩到全部会话，但**可见的分项 token 总量会下降**，因为
  未对齐的日志条目失去归属、未提供分项的 Agent 显示为缺失而不是 0。用户会觉得
  「数字变少了」，需要在发布说明里讲清这是精度修正。
- `ProjectUsageStatistics` 系列类型要增加维度（`by_folder` / `by_agent`）与来源
  标记，是破坏性形状变化，需重新生成 `shared/types.ts`。
- 按事件聚合意味着计量查询要走 `conversation_events` 的 `UsageUpdated`，长会话
  下需要投影或物化视图支撑，不能每次报表都重放全部事件。这条与
  [ADR-0061](0061-host-local-safety-and-performance-baseline.md) 的性能基线相关，
  实现时必须有聚合读模型而不是即席扫描。
- 厂商日志扫描器保留但缩小职责，只做分项 token 补充。它不再决定报表里有哪些行。
- `external_session_id` 成为对齐的关键列，它为空的会话拿不到 `vendor_log` 补充。

## Considered Options

- **完全废弃厂商日志，只用事件**：否决。今天绝大多数 Agent 不给分项 token，
  纯事件方案会让 Claude / Codex 用户的报表从「有真数据」退化为「大片缺失」，
  是功能倒退。
- **保留日志为主，事件为辅**：否决。归属问题在日志侧无解——日志里没有 VibeX 的
  workspace 概念，只有路径。按目录与按 Agent 的维度在日志侧做不出可靠结果。
- **把 `context_used` 当作 token 展示**：否决。ADR-0058 已经定过，上下文占用不是
  输入 token，这正是当时修掉的谎报。
- **对未提供分项的 Agent 用模型费率估算 token**：否决。估算值与观测值形状相同
  却语义不同，一旦进表就再也分不开。
