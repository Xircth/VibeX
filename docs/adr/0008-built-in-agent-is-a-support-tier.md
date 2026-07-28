---
status: accepted
---

# 内置 Agent 是产品支持等级，而非捆绑或安装方式

VibeX 将 Codex、Claude Code、OpenCode 与 Pi 设为首批内置 Agent：它们直接展示，并可获得历史导入、原生配置等增强能力；同时仍通过 ACP 接入，按需安装并验证本地 Agent runtime 与 ACP 适配器，不随 VibeX 捆绑可执行文件。内置身份意味着 VibeX 主动测试并承担兼容性责任，而非单纯的 UI 置顶；其他 Agent 只获得注册表驱动的通用 ACP 支持，VibeX 不自动检测或接管未登记、非 ACP 的本地 Agent。

## Consequences

- VibeX 可以为内置 Agent 维护官方注册表之外的兼容版本下限、启动参数与增强适配。
- OpenClaw 与 Hermes 不再属于产品支持集合；其既有安装和历史数据的迁移策略另行决定。
- 未来由 VibeX 开发的专用 Agent 可以进入同一支持等级，无需引入另一套接入模型。
