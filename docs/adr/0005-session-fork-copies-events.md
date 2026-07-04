# 会话分叉：复制事件到分叉点，而非引用父日志

Fork 产生一个**完全独立**的新 Conversation：把父会话的事件日志复制到分叉点（写入新会话自己的 sequence 空间与幂等键域），亲子关系只作为展示元数据保留（`forked_from_conversation_id` + `fork_point_turn`），不参与任何读写路径。父会话存在在途 turn 时拒绝 fork（不复制半成品 turn）。agent 侧上下文按 Session resume 语义接入：支持 `session/load` 的 agent 恢复到分叉点上下文，不支持者以导入语义冷启动并向用户明示。

决定于 2026-07-04 的对抗性审查会（codeg-vs-vibex 差距计划，P1-4）。

## Considered Options

- **引用父日志（copy-on-write）**：子会话只记 `parent_id + fork_point_sequence`，读取时拼接两段 —— 被否决：现有 `conversation_truncate_to_turn` 会**物理删除**父会话事件，引用语义下会静默破坏子会话完整性，需要级联保护；投影、FTS 索引（P1-2）、导出（P1-3）、批次 C 单投影协议全部要增加拼接分支。省下的存储（共同前缀，多为小文本事件）不值这些复杂度。
- **新会话 + 把历史文本塞进首条 prompt**：被否决：假 fork —— 上下文不保真（工具调用/权限历史丢失结构）、agent 端没有真实会话状态、token 成本反而更高。
- **实施时再定**：被否决：两种语义对 DB 迁移与批次 C 的交互面不同，悬而未决会阻塞相邻设计。

## Consequences

- 共同前缀存储两份，可接受；投影快照**不复制**（投影可随时重建）。
- 复制时必须重写 sequence 与幂等键，禁止跨会话复用原键（否则追加幂等性会误判）。
- 会话级统计会把共同前缀计两次；用量/成本核算以 CLI 会话文件扫描为准，不受影响。
- 术语见 CONTEXT.md「Session fork（会话分叉）」；与 reset-to-here（破坏性截断）互为补充而非替代。
