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
- **Workspace-less conversation（无工作区会话）** — 一种不挂靠任何 Project / Workspace 的 Conversation：没有 worktree、没有隔离工作区、没有 git 面板，用于纯聊天/咨询场景。与常规会话的唯一区别是缺少 Workspace 归属；其事件日志、Turn 生命周期、恢复与中断语义与常规会话**完全一致**。因无仓库工作区，其 agent 的文件/终端工具根目录由宿主指定的**专用临时目录**提供（而非某个项目仓库），并据此成为一个能力受限的低权限模式。落地决策（数据模型 + 工作目录/沙箱）见 ADR-0006。

## Channel domain

- **Chat channel（聊天通道）** — 会话与外部 IM 之间的桥接：向外投递会话事件通知，向内接收远程命令。
- **Authorized sender（授权发送者）** — 某个聊天通道配置中被明确列入、允许下发入站命令的发送者身份。不在列表内的消息被静默丢弃；授权列表为空时该通道入站整体禁用（fail-closed）。
- **Remote approval（远程审批）** — 授权发送者经聊天通道对某条待决权限请求做出的响应。语义与桌面端权限响应完全等同：作用于同一事件日志，二者互斥消解同一请求。

## Automation domain

- **Automation（自动化）** — 一份保存下来的"发起回合"配置（项目、执行档位、prompt 模板、隔离方式、触发方式），可被反复执行而无需打开会话界面。
- **Automation run（自动化运行）** — Automation 的一次执行实例，产生一个真实的 Conversation 与 Turn，并记录终态（成功/失败/中断/超时）。宿主进程未运行时不产生运行；错过的定时触发不补跑。

## Agent domain

- **Agent kind（agent 身份）** — agent 的稳定身份标识（claude_code、codex、opencode…），全系统唯一的身份枚举。回答"这是哪个 agent"。
- **Registry entry（注册表条目）** — 某个 agent 身份的元数据（展示名、描述、分发方式、registry id）。registry id（如 claude-acp）是条目的标识，不是身份本身。
- **History import（历史导入）** — 把外部工具（Claude Code、Codex 等）的本地会话历史接管进 VibeX 会话体系的行为。
- **Session fork（会话分叉）** — 从**当前状态**分出一个新 Conversation：新会话是原会话完整历史的独立副本（非破坏性，原会话不受影响），此后独立演化。当 agent 广告了 ACP `session/fork` 且有活会话时，agent 侧上下文也随之分叉（继续对话保有分叉前上下文）；否则新会话为无上下文副本，下次发送冷启动。从当前分叉（非历史某点），以保持可见历史与 agent 上下文一致。与 reset-to-here（在原会话上截断重来，破坏性）互为补充。语义决策见 ADR-0005（2026-07-06 更新）。

## Reference Docs
1. **ACP Docs**:https://agentclientprotocol.com/protocol/v1/overview