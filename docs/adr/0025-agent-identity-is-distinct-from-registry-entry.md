---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Agent 身份独立于 Registry 条目

每个 Agent 只有一个稳定的 Agent kind，Built-in Agent Profile 与官方 Registry
entry 可以通过 VibeX 维护的显式映射绑定到同一身份，不生成重复的导航项、安装、
配置或历史归属。映射不能按名称模糊推断；未明确映射的相似条目仍是独立 Agent。

Built-in Agent Profile 对运行拓扑、检测、完整性和管理能力保持权威，Registry
提供目录元数据及其声明的分发信息。Registry entry 改名、换 id 或下架不会改变
已绑定 Agent 的稳定身份、设置与历史；VibeX 通过映射迁移条目变化，内置 Agent
也不会因 Registry 下架而消失。
