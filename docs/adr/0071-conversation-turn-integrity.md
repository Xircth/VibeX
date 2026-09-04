---
status: accepted
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Conversation Turn 完整性：取消、恢复回放、连接隔离与终态可达

用户在一次连续使用中报告了七个现象：第二轮把第一轮的 AI 消息重新吐一遍并粘成
「AI 消息 AB」、点中断中断不了同时内存涨到 4 GB 以上、重发消息报
`CHECK constraint failed: status IN (...)`、中断过的对话稍后仍给出输出、Mode 从
「完全访问」自己变回「Approve for me」、重发失败后重新发送导致并行对话、AI 输出
结束后停止按钮不肯变回发送按钮。

这七个现象不是七个 bug，而是五个根因在事件溯源会话核心上的组合表现。诊断记录见
[`.scratch/conversation-turn-integrity/PRD.md`](../../.scratch/conversation-turn-integrity/PRD.md)。
本 ADR 固定其中四条不可回退的语义约束。

它不改变 [ADR-0044](0044-conversation-control-plane-and-durable-inputs.md) 的
Turn 控制面模型、[ADR-0001](0001-crash-recovery-semantics.md) 的崩溃恢复语义，也不
放宽 [ADR-0061](0061-host-local-safety-and-performance-baseline.md) 的锁与内存基线；
它把这三者在「一个 Turn 从发出到终态」这条路径上的实现要求写成硬约束。

## Context

事件溯源的前提是：**宿主的事件日志是唯一权威，投影只是它的函数**（ADR-0044）。
一旦有第二个事实来源，或者权威日志接受了不是新事实的写入，投影就会分叉，而分叉
在 UI 上表现为「消息重复」「归属错乱」「状态卡住」——这正是上面七个现象的形状。

审查发现四处破坏了这个前提，一处破坏了终态的可达性：

1. **恢复回放被当成新事实。** ACP `session/load` / `session/resume` 期间，Agent 会
   把整段历史以 `session/update` 通知重放。连接管理器没有「正在恢复」的门控，于是
   宿主把自己已经持久化的事实又 append 了一遍。长会话每次重连近似平方级膨胀，
   这是内存现象的主要来源；而无在途 Turn 时这些回放会落到上一轮的 assistant
   消息，是「AI 消息 AB」的起点。

2. **取消只是通知，不是握手。** 取消分支发出 `session/cancel` 后立刻宣布
   `PromptFinished{cancelled}` 并丢弃 `session/prompt` 的请求 future，不等 Agent 以
   `StopReason::Cancelled` 回应。Agent 之后继续产出的内容此时已无在途 Turn 可归，
   落进下一轮。用户看到的就是「中断没生效」。

3. **Turn 归属依赖一份会过期的缓存。** 记录器的 `active_turns` 只在它自己看到
   `PromptFinished` 时清除，而服务端的 `cancel_turn` / `interrupt_orphaned_turn`
   直接写终态事件、不经过记录器。缓存于是指向已终结的 Turn，新一轮的 chunk 与
   ToolCall 全部以旧 `turn_id` 落库。文本还能靠投影重定向勉强救回，ToolCall 与
   Plan 没有重定向路径，直接挂错。

4. **连接跨 Conversation 复用。** `ensure_session` 在会话自己的连接失效后会回退去
   复用同 workspace / agent / working_dir 的另一个 Ready 连接。但 prompt 循环是按
   **连接**串行的：复用后第二个 `Prompt` 命令落到「已有活跃 prompt」分支，只留一条
   诊断就被静默丢弃，服务端 Turn 永远 `running`；两个 Conversation 交叉写同一 ACP
   会话则表现为并行对话。任何走到 `session/new` 的路径还会拿回 Agent 的默认 mode,
   而宿主不持久化用户的显式选择——这是一次**权限收敛方向相反**的静默回退。

5. **终态 op 存在丢失窗口。** 行操作发布分三段取锁（读游标 → 读事件 → 载入投影器
   → apply），并发发布者中后到者建立的投影器会静默吸收尚未发布的序号，先到者随后
   因 `sequence <= last_sequence()` 跳过它。settle 时刻恰好是并发最高点，而当时的
   实现又在 settle 时丢弃投影器，保证下一次是冷载入。丢掉的正是最后一条终态 op，
   它没有「下一批」来触发 gap 自愈，所以只能刷新页面。

另有一处数据一致性缺陷把上面几条串成了用户看到的 #6：`invalidate_agent_session`
把 binding 状态写成裸字符串 `"rebind_required"`，违反迁移里的 CHECK 约束；而
`truncate_to_turn` 先物理删除事件再调用它，失败后留下「事件已截断、binding 仍指向
旧 ACP 会话、`AgentBindingRecovered` 未写入」的半提交状态。

## Decision

### 1. 会话恢复的回放不进入事件日志

连接管理器必须知道自己正在恢复哪个 ACP 会话。在恢复窗口内，内容类
`session/update`（assistant 消息、思考、工具调用与更新、计划）一律丢弃；控制类
更新（mode、config option、available commands）保留，因为它们描述的是会话当前
能力，不是历史事实。

宿主重放自己的历史给 Agent 是**同步**，Agent 回放给宿主不是新事实。任何让恢复
产生新事件的实现都违反 ADR-0044，按缺陷处理。

### 2. 取消是与 Agent 的握手，不是单向通知

发出 `session/cancel` 后必须继续等待 `session/prompt` 的响应，收到后才宣布
`PromptFinished{cancelled}`。等待有上限（当前 10 秒）；超时则强制收尾，并把该 ACP
会话标记为不可再复用——因为一个不确认取消的会话随时可能吐出无处归属的内容，让它
继续服务下一个 Turn 就是把错乱推迟而不是消除。

推论：Turn 归属只有两个合法答案——当前在途 Turn，或者「无归属」。仅在途才有意义的
事件（消息 chunk、思考、工具调用、计划）在没有在途 Turn 时必须**丢弃并记诊断**，
不得回落到「最新的那个 Turn」。把「无归属」翻译成「归给上一轮」是本次事故里最贵的
一行代码。

### 3. 一个 Conversation 一个连接

`ensure_session` 不得返回其它 Conversation 正在使用的连接。连接不跨 Conversation
复用，即使 workspace、agent 和 working_dir 完全相同。

prompt 循环遇到已有活跃 prompt 的 `Prompt` 命令时，必须回传错误（`prompt_conflict`）
让服务端把该 Turn 标为失败并可重排，不得静默丢弃。静默丢弃会制造一个永不到达终态的
Turn，而永不终态的 Turn 在 UI 上就是一个停不下来的按钮。

### 4. 用户显式选择的 mode / config 由宿主持久化，并在第一次广播前 apply

对齐 CodeG：`preferred_mode_id` + `preferred_config_values` 在 `session/new` /
`session/load` / `session/resume` 完成时、**第一次** `session_modes` /
`session_config_options` 发出之前 apply。UI 从未见过 Agent 默认值，因此不存在
「先闪默认再改回来」的窗口。建立期间的中间 `session/update`（mode / config）
同样被拦住，直到 apply 结束。

记忆分两层，按 key 合并（CodeG `saveConfigPreference` / `getSavedPrefsForConnect`）：

1. **Conversation binding 是该对话的权威。** `session/set_mode` 与
   `session/set_config_option` 成功后按 key 合并写入；改一个 option 不得丢掉其它
   key。Agent 广播默认值不得回写这份记录。
2. **Agent last-used 是新会话的继承。** 同一选择同时 upsert 到
   `agent_session_default`（已有的 per-agent 默认表，对应 CodeG 的 per-`agentType`
   `selector-prefs`）。新建对话读这层；已有对话里 binding 按 key 覆盖 last-used。
   不把偏好写进浏览器 localStorage——宿主 / DB 是权威（ADR-0044）。

解析出的 `SessionControlPreferences` 随 prepare / resume / prompt 进入连接管理器。
建立后的 skip-if-current 重放只是保险（in-memory 驱动或被 Agent 拒绝的记忆值）。
重放不是新选择，不得回写 binding。

每个 Turn 仍按「profile / slash 默认 ← last-used ← binding 记忆 ← 本轮显式选择」
合并 override。权限相关设置不得因为重连而静默回退到 Agent 默认值，实际生效的值和
界面显示的值都不行（ADR-0058）。

### 5. binding 状态由枚举收口

`conversation_agent_bindings.status` 只能通过 Rust 枚举写入，取值与迁移的 CHECK
约束一一对应（`pending` / `connecting` / `ready` / `recovering` / `failed` /
`closed`）。「等待 rebind」的语义归入 `recovering`。

涉及事件截断的操作必须先失效会话再截断事件：失效失败就不截断，不留半提交状态。

### 6. 投影器缓存有界，而非 settle 即弃

行操作的发布路径（读游标 → 读事件 → 载入投影器 → apply）在同一临界区内完成。
settle 后保留投影器，改用容量上限淘汰最久未用的会话——既消除冷载入竞态窗口，也
满足 ADR-0061 §8.2 对重复重放的约束。

## Consequences

- 会话恢复后，Agent 侧的历史回放对宿主是不可见的。这意味着宿主的事件日志必须
  本来就完整；ADR-0001 的崩溃恢复语义因此从「最好如此」变成了这条路径的前置条件。
- 取消变成有延迟的操作（最坏 10 秒）。UI 需要表达「正在取消」这个中间态，不能假设
  点击后立即终态。不确认取消的 Agent 会失去会话复用能力，下一轮走冷启动。
- 连接不再跨 Conversation 复用，同一 workspace 下多开对话会占用更多 Agent 进程。
  这是为隔离付的确定成本，优于交叉写同一 ACP 会话。
- `prompt_conflict` 成为前端需要处理的一类 Turn 失败，它可重发。
- mode / config 的权威在 Conversation 上是 binding，在新会话上是 Agent last-used。
  Agent 单方面改变 mode 时，宿主的持久化选择在下一次重绑时胜出。
- 本 ADR 不引入新的隔离承诺：Agent 仍是全信任本机代码（ADR-0061 §1）。这里约束的
  只是宿主自己的记账正确性。

## 边界

- 静态审查加针对性回归测试，没有对长会话或多 Agent 并发做压测。
- 10 秒取消上限是工程取值，不是从任何 ACP 规范推出的；如果实测有 Agent 稳定超过
  这个值，应调整常量而不是取消握手。
- 投影器缓存上限同理，按实测调整。
