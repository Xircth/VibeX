# 崩溃恢复：只恢复上下文，绝不重放在途 turn

会话事件日志是永久权威存储，但 agent 是本地子进程——宿主崩溃时正在运行的 turn 的生成过程物理上不可恢复。我们决定：启动协调器把孤立的在途 turn 追加 `TurnInterrupted` 终止事件（并作废其孤立的 pending 权限请求），会话上下文通过 ACP `session/load` 在**惰性时机**（打开会话/下次发送时）重载进新 agent 进程；被中断的 turn 只提供一键重试，**绝不自动重发**，因为 agent 崩溃前可能已产生文件编辑等副作用，重跑与否只有看得到工作区状态的用户能判断。

## Considered Options

- 启动时直接 UPDATE turn 状态、不写事件 —— 被否决：破坏"状态只由事件推进"的不变量，事件日志会出现无法解释的状态跳变。
- 恢复后自动重发原 prompt —— 被否决：副作用重复风险。
- 启动时急切重连最近活跃会话 —— 被否决为 v1：启动时批量拉起 N 个 agent 子进程，代价高且多数用不到；现有 `ensure_acp_session` 已是惰性语义，顺势接通 `resume_supported` 即可。

## Consequences

- `TurnInterrupted` 是新事件变体，必须在事件容错反序列化（读取侧 `Unknown{kind, raw}` 包装兜底 + `event_version` 列）落地**之后**才能引入——否则版本回退会炸整条时间线。实施顺序因此为：先容错，后恢复。
- Interrupted 成为 turn 的第四个终态（区别于 Failed=agent 报错、Cancelled=用户取消），见 CONTEXT.md。
