---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# 内置 Agent 永久保留，其他 Agent 可以移除

当前十二个内置 Agent（Claude Code、Codex、Gemini、OpenClaw、OpenCode、Cline、
Hermes、CodeBuddy、Kimi Code、Pi、Grok 与 Cursor）永久属于 VibeX Agent 集合，用户可以禁用、卸载其托管 Runtime
或清除配置，但不能把它们从 Agent 导航带移除。其他已添加 Agent 可以从 VibeX
移除；仍存在于上游 Registry 时重新成为可添加 Agent，已经下架时则只从本地界面
消失。

移除 Agent 不删除由它创建的历史会话。历史会话继续保留 Agent 身份和只读记录，
但在 Agent 重新添加并就绪前不能继续对话；存在运行中会话或在途回合时禁止移除，
必须先结束相关运行。
