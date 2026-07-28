---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# Agent 安装精确锁定版本并由用户确认升级

每次托管安装都记录 Agent Runtime、ACP 适配器和基础 Runtime 的确切版本与来源，
启动时不解析 `latest`。普通 Registry Agent 首次安装时锁定用户确认时 Registry
提供的具体版本；内置 Agent 只能安装 Built-in Agent Profile 中已经验证的版本组合。

Registry 刷新只产生更新提示，不自动升级。更新安装到独立版本位置，通过完整预检
和 ACP 握手后才切换为当前版本；失败时继续使用旧版本。外部 Runtime 的升级由其
所有者负责，VibeX 发现版本变化后只重新校验，不主动修改。
