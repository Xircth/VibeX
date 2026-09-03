---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Agent 版本证据可以缺省但不能冲突

Installation lock 分别保存 Registry 声明版本、实际解析的制品版本、ACP 握手报告
版本与内容指纹。npx 与 uvx 必须解析为精确包版本；所有已经取得的版本证据必须
彼此一致，任何冲突都作为 Registry 元数据不一致处理，隔离新产物并终止安装或
更新，不能用其中一个值覆盖另一个。

ACP 当前只建议 Agent 在 `initialize` 中返回 `agentInfo.version`，因此普通 Registry
Binary 未报告 Runtime 版本时不单独判定失败；VibeX 以 Registry 声明版本与首次
取得的 SHA-256 锁定内容，并明确显示 Runtime 未报告版本。Built-in Agent Profile
可以把 Runtime 或 ACP 适配器的版本报告设为必需。适配器自带 vendor CLI 的 Agent
只验证 ACP；其余适配器型 Agent 的两个组件必须分别验证。后来发生的 Registry
元数据漂移不改变现有 Installation lock，但
在矛盾消除前不提供更新。
