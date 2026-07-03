# VibeX — Ubiquitous Language

Glossary of domain terms. Keep entries implementation-free; link decisions to ADRs in `docs/adr/`.

## Conversation domain

- **Conversation（会话）** — 用户与一个 agent 之间的持久对话。其完整历史由事件日志权威记录，与任何 agent 进程的存活无关。
- **Turn（回合）** — 会话内一次"用户发起 → agent 应答完毕"的完整周期。同一会话内同一时刻至多一个 turn 在途。
- **In-flight turn（在途回合）** — 已开始、尚未到达终态的 turn。
- **Turn 终态** — 每个 turn 最终恰好落在以下四个终态之一：
  - **Completed（完成）** — agent 正常应答完毕。
  - **Failed（失败）** — agent 侧报告了错误。
  - **Cancelled（取消）** — 用户主动请求停止。
  - **Interrupted（中断）** — 宿主进程在 turn 运行期间死亡（崩溃/强杀/重启），生成过程无法恢复。与 Failed 不同：不是 agent 的错误；与 Cancelled 不同：不是用户的意图。中断的 turn 只能由用户手动重试，绝不自动重发（agent 崩溃前可能已产生副作用）。
- **Session resume（会话恢复）** — 将会话的上下文重载进一个新拉起的 agent 进程。恢复的是**上下文**，永远不是在途 turn 的生成过程。是否可恢复取决于 agent 的能力位。
- **Recovery（启动恢复）** — 宿主启动时对上一次进程生命周期遗留状态的协调：将孤立的在途 turn 判定为 Interrupted，使会话回到可发起新 turn 的状态。
- **Event log（事件日志）** — 会话的权威、仅追加的历史记录。会话的一切状态都是事件的推论。
- **Projection（投影）** — 从事件日志折叠出的派生读模型。投影永远可以从事件重建，本身不是权威。
- **Timeline row（时间线行）** — 投影的最小单元：时间线上一个可独立更新的条目（一条消息、一次工具调用、一次权限请求等）。前端渲染的唯一输入。
- **Revision（行修订号）** — 单个时间线行的单调版本号，用于增量更新的幂等去重。
- **Snapshot（投影快照）** — 投影在某个事件序号处的物化缓存，纯粹是重放的加速手段，可随时丢弃重建。

## Agent domain

- **Agent kind（agent 身份）** — agent 的稳定身份标识（claude_code、codex、opencode…），全系统唯一的身份枚举。回答"这是哪个 agent"。
- **Registry entry（注册表条目）** — 某个 agent 身份的元数据（展示名、描述、分发方式、registry id）。registry id（如 claude-acp）是条目的标识，不是身份本身。
- **History import（历史导入）** — 把外部工具（Claude Code、Codex 等）的本地会话历史接管进 VibeX 会话体系的行为。
