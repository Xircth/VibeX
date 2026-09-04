---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Turn 失败分类以结构化证据为准，恢复过程与恢复结果对用户可见

本 ADR 补齐限流、拒绝、服务故障三类失败，给 `recovering` 接上真实来源，让
恢复成功变成用户看得见的事实。它同时划定一条硬线：**分类只能来自协议码位或
宿主自己的观测，不能来自错误文本**。

本决定是 [ADR-0058](0058-session-auxiliary-capability-honesty.md) 在失败路径上的
延伸，不放宽它；也不改变 [ADR-0071](0071-conversation-turn-integrity.md) 的
Turn 终态与连接隔离语义。

## Context

失败分类今天已经是**按码位**做的，这一点是对的：
`TurnErrorCard.describeError` 只 `switch (error.code)`，message 只作展示。
码位由 `crates/agents/src/manager.rs` 的 `acp_error_code_str` 从 ACP JSON-RPC
错误映射而来：

```
-32700 parse_error      -32600 invalid_request   -32601 method_not_found
-32602 invalid_params   -32603 internal_error    -32800 request_cancelled
-32000 auth_required    -32002 resource_not_found -32042 url_elicitation_required
其余    rpc_{n}
```

加上宿主自造的 `idle_timeout`（空闲看门狗）与 `connection_closed`（在途断连），
以及 `AgentError::turn_failure_code()` 的四个会话级码位。

缺口有三处：

1. **可命名的码位没被命名。** 前端只认 8 个码位，`invalid_request`、
   `invalid_params`、`internal_error` 全部落进 `default` 分支，显示成一句泛化的
   错误加一个「重试」。`internal_error` 重试有意义，`invalid_params` 重试必然
   再失败——两者却是同一个按钮。

2. **限流没有码位。** JSON-RPC 没有限流码，ACP 也没定义。今天限流走到
   `rpc_{n}` 或 `default`。要把它命名，唯一诚实的证据在 `acp::Error` 的 `data`
   字段或 `_meta` 里，而这依赖 Agent 是否填。

3. **恢复过程与结果都不可见。**
   - `ConversationAgentConnectionStatus::Recovering` 在 Rust 与 `shared/types.ts`
     里都存在，**全仓库没有任何代码给它赋值**。上游 `AgentConnectionStatus`
     （`crates/agents/src/state.rs`）根本没有 `Recovering` 变体，映射表是
     `Disconnected→Closed / Connecting→Connecting / Ready→Ready / Failed→Error`。
     写进 DB 的 `"recovering"` 是另一个类型 `BindingStatus::Recovering`。
   - `AgentBindingRecovered` 有四个策略 `Loaded / Resumed / CreatedNewSession /
     Rebound`，生产代码只发 `Rebound`（`truncate_to_turn` 与 `rebind_session`）。
     `session/load` 或 `session/resume` 成功恢复时**不发任何事件**，所以投影里
     那条「删除加载失败通知」的规则永远不触发：一次自愈成功之后，失败通知还挂在
     那里。

ADR-0058 的约束在这里最容易被违反：限流信息几乎总是只出现在 message 文本里，
「匹配 rate limit / 429 / 配额」是最省事也最错的做法。换个 Agent、换个语言、
换个措辞就误报，而误报的代价是把一次真实的服务故障说成用户超额。

## Decision drivers

1. 分类是断言。没有证据的断言不做。
2. 不同分类必须导向不同动作，否则分类没有产品价值。
3. 恢复过程要有中间态，恢复成功要清掉失败痕迹。

## Decision

### 1. 失败证据分三级，分类只能建立在前两级上

| 级别 | 来源 | 例 |
|---|---|---|
| A 协议事实 | ACP / JSON-RPC 错误码位、`acp::Error.data` 中的结构化字段 | `-32603`、`data.http_status = 429` |
| B 宿主观测 | 宿主自己发起的请求与自己管理的进程 | 子进程退出码、连接层 HTTP 状态、看门狗超时 |
| C 自由文本 | `error.message`、Agent 助手文本 | 「rate limit exceeded」 |

A 与 B 可用于分类。**C 只能展示，永不参与分类。** 没有 A 也没有 B 时，分类是
`unknown`，UI 原样展示 message 并给出重试。

### 2. 三类新分类的准入条件

**`rejected`（请求被拒绝）** — 证据 A：`-32600 invalid_request`、
`-32602 invalid_params`。这是协议层对请求本身的判定，与运行时波动无关。
动作：**不提供重试**，因为原样重发必然再失败。提供的是「查看详情」与
「重新绑定会话」（当拒绝源于会话状态不一致时唯一有效的动作）。

**`service_error`（服务故障）** — 证据 A：`-32603 internal_error`，以及
`data` 里出现 5xx HTTP 状态。证据 B：Agent 子进程非正常退出。
动作：重试。这类失败重试有意义，且不应引导用户去改自己的输入。

**`rate_limited`（触发限流）** — 证据 A：`data` 中的 `http_status = 429`，或
Agent 给出的结构化限流字段（含可选的重置时间）。证据 B：宿主自己对
Provider 发起的请求收到 429。
动作：展示重置时间（若有）并允许稍后重试。

**没有上述证据的限流，不成立。** 宿主不猜。这条是本 ADR 的核心取舍：宁可把
一次真限流显示成 `unknown`，也不把一次服务故障误报成限流。

### 3. 配额事实与失败并列展示，但不改写分类

`crates/agents/src/plan_usage.rs` 已经能对 `claude_code` / `codex` / `grok` /
`cursor` 探测订阅额度窗口（`used_percent`、`resets_at_ms`）。当一个 Turn 失败
且宿主**已持有**该 Agent 的额度事实时，失败卡片可以把这条事实并列显示。

它是**旁证，不是判据**：分类仍由第 2 条决定。文案必须表述为两件同时为真的事
（「这次请求失败」+「你的额度窗口已用尽，将在 X 重置」），不得表述为因果
（「因为限流所以失败」）。宿主没有证据说这两件事有因果关系。

失败发生时不主动发起额度探测——那会在服务已经出问题时再加一次请求。只用
已缓存的探测结果，没有就不显示。

### 4. `rpc_{n}` 保留为兜底，且必须可见

未映射的码位继续产出 `rpc_{n}`。UI 对它按 `unknown` 处理，但**必须把原始码位
显示出来**。一个能被用户复制上报的 `rpc_-32004` 比一句「未知错误」有用。

### 5. `Recovering` 要么有来源，要么删除

`AgentConnectionStatus`（`crates/agents/src/state.rs`）增加 `Recovering` 变体，
在两个窗口内成立：

- ACP 会话恢复窗口——即 ADR-0071 §1 定义的 `session/load` / `session/resume`
  期间。宿主本来就必须知道自己在恢复（否则无法门控回放），这个已知状态直接
  成为连接状态的来源。
- 重绑窗口——`detach_agent_session` 之后到新会话 Ready 之间。DB 侧
  `BindingStatus::Recovering` 已经在这段时间成立（ADR-0071 §5），连接状态与它
  对齐即可，不引入第三个真值。

映射表相应扩展为 `Recovering → Recovering`。如果实现时发现这两个窗口都无法
可靠观测，则**删除** `ConversationAgentConnectionStatus::Recovering` 与
`shared/types.ts` 里对应的字面量。一个永远不会出现的状态是残留，按 maiden
原则 4 清除，不留着装门面。

### 6. 恢复成功必须发事件

`prepare_session` 走 `session/load` 成功时发
`AgentBindingRecovered { strategy: Loaded }`，走 `session/resume` 成功时发
`Resumed`，冷启动新建会话顶替失效会话时发 `CreatedNewSession`。投影已有的
「`Loaded` / `Resumed` 删除加载失败通知」规则由此第一次真正生效。

判定「这是一次恢复」的依据是：本次 `prepare_session` 之前该 binding 存在未清除
的失败通知，或状态为 `Recovering`。首次正常建立会话不发恢复事件。

同样的清理原则：若某个策略在实现后仍无生产来源，删除该变体而不是留空位。

### 7. 分类是后端事实，不是前端映射表

`error.code` 的取值集合由 Rust 侧定义并导出，前端按导出的类型穷尽处理。
今天前端手写的 8 个字符串字面量是第二份真值，改为消费生成类型后，新增码位会
在前端产生编译期缺口，而不是静默落进 `default`。

## Consequences

- `TurnErrorCard` 的动作从「重试 / 重新绑定」二选一，扩展为按分类决定；
  `rejected` 类不再提供重试按钮。
- `AgentConnectionStatus` 增加变体是穷尽匹配点的变化，映射表与相关测试同步。
- 恢复事件补齐后，一次成功自愈会**删除**已存在的失败通知——这是 UI 上可观察的
  行为变化：用户可能看到通知自行消失。这是正确的，通知描述的状态已不再为真。
- 限流分类的覆盖率取决于 Agent 是否在 `data` 里给结构化字段。首个版本大概率
  只有少数 Agent 命中。这是**已知且接受**的覆盖缺口，不用文本匹配去填。
  补齐它的正路是向 ACP 上游提议标准化限流错误数据，而不是在宿主侧猜。
- `error.code` 类型化后，`shared/types.ts` 需要重新生成。

## Considered Options

- **用正则匹配 message 判定限流**：否决。直接违反 ADR-0058，且 Agent 一改文案
  就失效。误报把服务故障说成用户超额，比不分类更糟。
- **失败时主动探测额度来判定限流**：否决。在服务可能已经异常时追加请求；且
  「额度用尽」与「这次失败」之间的因果是推断，不是观测。
- **保留 `Recovering` 不接线，等以后再说**：否决。一个五个变体里有一个永不出现
  的枚举，会让每个读代码的人以为它有来源。要么接，要么删。
- **把 `internal_error` 也归入可重试的 `unknown`**：否决。它能被命名，命名后
  用户知道问题不在自己这边，这个区分有产品价值。
