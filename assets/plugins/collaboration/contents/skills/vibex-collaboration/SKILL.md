---
name: vibex-collaboration
description: 通过 VibeX 委派工具把工作交给被 `&Agent` mention 的其它 Agent。
---

# VibeX Collaboration

当用户用 `[&Codex](vibex://agent/codex)` 这类结构化 mention 点名其它 Agent 时，调用 `delegate_to_agent`。Mention 本身不是已经开始的子任务。

- `delegate_to_agent` 立即返回 `task_id`，子任务异步运行。
- 用 `get_delegation_status` 等待或查询，用 `cancel_delegation` 取消。
- 每个子任务是独立 Child Conversation；父会话退出会级联取消仍在运行的子任务。
- 不要把 mention 显示名称再做模糊匹配；只用 mention 里的稳定 Agent id。
