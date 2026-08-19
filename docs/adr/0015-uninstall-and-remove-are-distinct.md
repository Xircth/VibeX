---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# 卸载与移除是不同操作

“卸载”按 Installation lock 的分发方式移除该 Agent 在用户环境中的 CLI 包
（`npm uninstall -g`、`uv tool uninstall`，或删除用户 bin 中由 VibeX 写入的
Binary），再清除锁。它保留已添加关系、导航带位置、设置和历史会话，使内置与
普通 Agent 都可以原位重新安装。卸载后 PATH 上该 Agent 命令仍在时必须失败并
保留锁，避免下次探测立刻重新接入。
“从 VibeX 移除”只适用于非内置 Agent：它先走同一套用户环境卸载，再终止已添加
关系，并清除 VibeX 保存的 Agent 专属设置与明文凭据，但不删除历史会话。

两种操作都不能删除 Agent 原生配置、凭据或共享工具链（Node、npm、uv、Python）。
也不能删除 Homebrew 或系统目录里 VibeX 写不进去的文件；这类残留只能报告给用户。

这一限制只约束卸载与移除的隐式副作用；它不禁止用户通过 Agent 档案明确提供的
白名单登录、注销或账号管理动作修改官方 CLI 的账号状态（见 ADR-0037）。

只要 Agent 仍有正在执行的 ACP 进程、在途回合或安装尝试，卸载与移除一律不可执行，
并明确提示“此 Agent 还有正在执行的进程，暂时无法卸载／移除”。VibeX 不会为卸载或
移除隐式取消任务或终止子进程；用户可以等待操作自然结束，或另行使用对应操作的取消
入口。移除提交前不删除现有 Installation lock、配置或 VibeX 凭据，避免留下仍在后台
运行但界面不可见的孤儿安装。
