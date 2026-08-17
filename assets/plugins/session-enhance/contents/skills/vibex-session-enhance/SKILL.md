---
name: vibex-session-enhance
description: 使用 VibeX 会话工具向用户提问、读取实时反馈、查询被提及的会话，或控制本会话及其子会话。
---

# 会话增强

这些工具由宿主提供。只在对应开关打开时才会出现在工具清单里。

- `ask_user_question`：被真正的用户决策挡住时使用，阻塞直到用户作答。
- `check_user_feedback`：在动手前和每个阶段后拉取用户中途纠偏。没有新备注就继续。
- `get_session_info`：用户用会话链接点名另一段对话时，只读查询它。
- `send_session_input` / `cancel_session_turn` / `wait_for_session`：只作用于本会话或其子孙。
