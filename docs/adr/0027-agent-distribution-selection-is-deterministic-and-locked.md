---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Agent 分发方式确定性选择并写入安装锁

ACP Registry 允许一个 Agent 同时声明 Binary、npx 和 uvx 等多个独立分发方式。
Built-in Agent 由 Built-in Agent Profile 指定已验证方式；普通 Agent 默认优先
选择当前平台 Binary，否则优先复用已经验证的 Node 或 Python 环境，条件相同时
固定按 npx、uvx 选择。常规添加流程不要求用户先理解或选择分发方式。

用户确认添加并安装时，VibeX 锁定当时展示的 Agent 版本、所选分发方式、目标平台
和解析后的精确包版本，并在详情页呈现实际方式与信任等级。默认方式失败时不得
静默切换；用户只能在修复流程中明确确认改用另一个兼容方式并形成新的 Installation
lock。Registry 刷新不改变现有安装的分发方式。
