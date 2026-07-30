---
status: superseded by ADR-0020
---

# 内置 Agent 的兼容契约由 VibeX 档案掌握

官方 ACP Registry manifest 只保证存在可启动的 ACP 分发，并不完整描述适配器背后的本地 Agent runtime；例如 Pi 的注册表条目只分发 `pi-acp`，但实际运行还依赖独立的 Pi CLI。VibeX 因此为每个内置 Agent 维护 Built-in Agent Profile，作为本地 Agent runtime、ACP 适配器、版本下限、连接方式与已验证组合的权威；官方 Registry 对内置 Agent 只提供发现信息和待验证的更新候选，不能直接改变其安装或启动契约。

## Consequences

- Registry 新版本只有通过 VibeX 兼容验证后，才能成为内置 Agent 的推荐组合。
- VibeX 可以在官方 Registry 条目缺失或不完整时继续安装和维护内置 Agent。
- 普通 Registry Agent 是否也必须具备独立的本地 Agent runtime，需要由后续决策明确，不能从官方 manifest 推断。
