---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# 旧 Agent 按实际使用证据迁入开放集合

旧版本会无条件为 Claude Code、Codex、OpenCode、Gemini、OpenClaw、Cline 和 Hermes
补齐设置行，因此设置行存在本身不能代表用户选择。迁移后 Claude Code、Codex 与
OpenCode 直接成为 Built-in Agent，新的 Pi Agent 也默认加入并接受本地探测；
Gemini 与 Cline 只有在旧数据中存在非空用户配置、非默认 Agent 专属设置、安装或
已验证 Runtime 记录、历史会话等实际使用证据时，才成为已添加的普通 Registry
Agent，否则只作为可添加条目出现。由于旧表默认 `enabled = true`，设置行、启用值
与默认排序均不构成使用证据。

迁移先根据上述证据决定 Agent 是否进入已添加集合，再迁移启用状态。Claude Code、
Codex、OpenCode 以及有证据迁入的 Gemini、Cline 保留旧设置中的显式禁用状态；
旧值为启用时只能作为已添加 Agent 的启用结果，不能反过来充当迁入证据。新加入的
Pi 默认启用。

迁移不依赖当时联网。已按证据迁入的 Gemini 或 Cline 即使暂时无法在 Registry
核对，也保留已添加关系并在 Registry 恢复后协调。OpenClaw 与 Hermes 作为退役
Agent 不迁入导航带，也不能创建新会话，但其稳定身份和历史会话继续以只读方式
保留；迁移不删除外部 Runtime、认证文件或用户配置。
