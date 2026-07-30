---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# Binary 完整性采用预期哈希与首次信任两级策略

内置 Agent 与 VibeX 托管的基础 Runtime 必须在 Built-in Agent Profile 中提供预期
SHA-256，缺失或不匹配时禁止执行。官方 ACP Registry 当前没有 Binary 校验和字段，
因此普通 Registry Binary 采用首次信任：首次下载后、执行前计算 SHA-256 并写入
安装锁，此后启动、修复和重新下载都必须匹配该指纹。

首次信任 Binary 只能标示为“Registry 来源·首次指纹”，不能宣称“VibeX 已验证”；
同一版本内容变化或哈希不匹配时立即隔离并禁止启动，只有明确安装新版本或重置
信任才能继续。`npx` 与 `uvx` 分发锁定确切版本，并使用对应包生态的完整性校验。
