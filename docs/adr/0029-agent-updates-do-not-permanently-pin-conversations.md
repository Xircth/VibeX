---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Agent 更新不让 Conversation 永久锁定旧版本

每个 Turn 记录实际使用的 Agent Runtime 与 ACP 适配器版本，但 Conversation 不永久
绑定该版本。更新原子切换后，新 Conversation 和没有存活 Agent 进程的既有
Conversation 都在下次执行时使用新的当前版本；正在运行的进程不被热切换，其在途
Turn 自然到达终态后才释放旧版本。

若新版本无法加载旧 ACP session，VibeX 不得静默声称恢复成功，也不得自动伪造历史
重放；完整事件历史继续保留，用户明确确认后才能执行 Session rebind。托管安装只需
保留当前版本、一个已验证回滚版本以及仍被存活进程引用的版本。需要继续使用旧版本
时回滚整个 Agent，不为单个 Conversation 建立永久版本分叉。

Session rebind 创建使用相同工作目录的冷启动 ACP session，并在时间线写入带新版本
信息的明确边界。VibeX 不自动重放旧 prompt、工具调用、权限响应、终端输出或文件
操作，也不在后台生成或发送摘要 Turn。确认重绑定后，用户可以在下一次发送前编辑
一段上下文交接说明；该说明只与用户的新消息一起发送。确认界面必须说明可见历史
仍在，但 Agent 隐藏上下文已经丢失。
