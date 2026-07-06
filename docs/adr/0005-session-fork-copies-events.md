# 会话分叉：复制事件到分叉点，而非引用父日志

Fork 产生一个**完全独立**的新 Conversation：把父会话的事件日志复制到分叉点（写入新会话自己的 sequence 空间与幂等键域），亲子关系只作为展示元数据保留（`forked_from_conversation_id` + `fork_point_turn`），不参与任何读写路径。父会话存在在途 turn 时拒绝 fork（不复制半成品 turn）。agent 侧上下文按 Session resume 语义接入：支持 `session/load` 的 agent 恢复到分叉点上下文，不支持者以导入语义冷启动并向用户明示。

决定于 2026-07-04 的对抗性审查会（codeg-vs-vibex 差距计划，P1-4）。

## 2026-07-06 更新：ACP `session/fork` 实为可用，应作为首选

原 ADR 的前提"VibeX 无 ACP `session/fork` 线路调用"经复核**不准确**：VibeX 依赖的
`agent-client-protocol` v0.11.1 **提供** `session/fork`（`ForkSessionRequest`/
`ForkSessionResponse`，`impl_jsonrpc_request!(... "session/fork")`），只是被 crate
feature `unstable_session_fork` 门控（当前只启用了 `unstable`）；且 `AgentCapabilities.fork:
Option<SessionForkCapabilities>` 允许**从 initialize 响应动态探测**某 agent 是否支持——
这正是 codeg 的做法（`session_capabilities.fork.is_some()` 门控真实 fork）。

因此**首选方案修正为**（与 codeg 对齐）：当 agent 广告了 fork 能力时，发 `ForkSessionRequest`
让 agent **在服务端真正分叉出保留上下文的新会话 S2**，VibeX 侧再建兄弟 Conversation
（其可见历史仍按下述"复制事件到分叉点"填充，并绑定到 S2 的 external_session_id）。
这样 fork 后**继续对话时 agent 保有分叉前上下文**，克服了本 ADR 原方案"agent 冷启动、
上下文不延续"的核心局限。

落地要点：(1) Cargo 启用 `unstable_session_fork`；(2) 在 initialize 处理处捕获
`agent_capabilities.session_capabilities.fork` 并动态更新能力位（承接 P0-2 的诚实化，
替代静态声明）；(3) manager 增 `fork_session` 发 `ForkSessionRequest`；(4) 事件复制
（下述）用于 VibeX 侧兄弟会话的可见历史 + 绑定 S2；(5) agent 未广告 fork 时按下述
导入语义降级并明示。**下方"复制事件到分叉点"仍是 VibeX 侧会话历史的构建方式，不变。**

> 状态：该实现为一项较大且触及事件溯源核心的工作，且真实可用性取决于目标 agent
> 是否广告 fork（需实机验证），建议作为独立专项落地，不在长会话尾部仓促实现。

## Considered Options

- **引用父日志（copy-on-write）**：子会话只记 `parent_id + fork_point_sequence`，读取时拼接两段 —— 被否决：现有 `conversation_truncate_to_turn` 会**物理删除**父会话事件，引用语义下会静默破坏子会话完整性，需要级联保护；投影、FTS 索引（P1-2）、导出（P1-3）、批次 C 单投影协议全部要增加拼接分支。省下的存储（共同前缀，多为小文本事件）不值这些复杂度。
- **新会话 + 把历史文本塞进首条 prompt**：被否决：假 fork —— 上下文不保真（工具调用/权限历史丢失结构）、agent 端没有真实会话状态、token 成本反而更高。
- **实施时再定**：被否决：两种语义对 DB 迁移与批次 C 的交互面不同，悬而未决会阻塞相邻设计。

## Consequences

- 共同前缀存储两份，可接受；投影快照**不复制**（投影可随时重建）。
- 复制时必须重写 sequence 与幂等键，禁止跨会话复用原键（否则追加幂等性会误判）。
- 会话级统计会把共同前缀计两次；用量/成本核算以 CLI 会话文件扫描为准，不受影响。
- 术语见 CONTEXT.md「Session fork（会话分叉）」；与 reset-to-here（破坏性截断）互为补充而非替代。
