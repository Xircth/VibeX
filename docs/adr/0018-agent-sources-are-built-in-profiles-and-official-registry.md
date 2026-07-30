---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Agent 来源仅限内置档案与 ACP 官方 Registry

当前版本只接受 VibeX 维护的 Built-in Agent Profile 和 ACP 官方 Registry 两种
Agent 来源。不支持自定义 Registry URL、本地 `acp.json`、用户自定义 manifest、
任意启动命令注册或扫描 `PATH` 自动接管未登记 Agent，也不为普通 Registry Agent
补写专属外部 Runtime 适配。

未来 VibeX 自研 Agent 通过 Built-in Agent Profile 进入产品。企业私有 Registry
若出现明确需求，应作为拥有独立信任与治理边界的新能力设计，不能混入当前官方
Registry。
