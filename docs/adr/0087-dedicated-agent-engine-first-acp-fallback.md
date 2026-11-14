---
status: accepted
date: 2026-11-14
decision-makers:
  - VibeX maintainers
---

# Agent 接入与能力治理采用独立引擎适配优先、ACP 次选

VibeX 将 Agent 接入、会话控制与状态管理规范由「ACP 优先 / 全量统一走 ACP」调整为**「独立 Agent 引擎适配优先，ACP 为次选」**。通用 ACP 包装器（如 `claude-agent-acp`、`codex-acp`）会折损主力 Agent 原生 SDK 与官方服务协议提供的一手控制面信号（精确 Token 与 Prompt Cache 过期时间、限流恢复时间、原生在途纠偏、会话与代码协同回退、原生子代理流及细粒度权限钩子），迫使宿主不断维护脆弱的外围补丁；而为所有长尾 CLI 逐一编写专属驱动同样不可持续。因此采用明确的主次双层策略：

1. **独立 Agent 引擎适配优先（首选）**：对核心或需深度发挥能力的 Coding Agent，优先在 `crates/agents` 内直接对接其官方 SDK、原生服务协议（如 `app-server` JSON-RPC）与原生配置/会话机制，构建独立 Agent 引擎驱动。已具备独立引擎适配的 Agent 直接走原生驱动，不再经由 ACP 包装进程中转。
2. **ACP 兼容接入为次选（兜底）**：Agent Client Protocol（ACP v1/v2）作为标准兼容层与生态扩展通道，用于尚未提供独立引擎适配的内置 Agent、ACP 官方 Registry 条目与用户声明分发。
3. **管理与状态能力优先级反转**：当同一项认证、配额、模型目录、会话控制或状态探测能力同时可由独立引擎/已适配原生本地机制与通用 ACP 提供时，**独立引擎与原生适配优先，ACP 为次选补缺**；不再因等待或迁就 ACP 协议字段而阉割原生能力。
4. **单一领域接缝不变**：独立引擎驱动与次选 ACP 适配器统一收敛于 `crates/agents`（`AgentRuntime`）内部，向 `crates/conversations` 与前端暴露一致的会话控制面、Turn 状态机与时间线投影；用户侧设置与工作区交互保持统一体验，且不恢复 `crates/executors` 执行编码 Agent 的旧路径。

## Consequences

- **取代与修订关系**：
  - 取代 [ADR-0021](0021-acp-first-with-local-management-fallbacks.md) 中「ACP 优先、本地补缺」的优先级原则；ADR-0021 中关于凭据掩码、订阅只读展示与事件驱动刷新的通用约束保留。
  - 修订 [ADR-0010](0010-agent-runtime-topology.md)、[ADR-0020](0020-built-in-agents-share-the-universal-pipeline.md) 与 [ADR-0034](0034-harden-acp-registry-and-adopt-auth-status.md) 中「所有内置 Agent 均须通过 ACP 运行、不得拥有独立引擎运行时路径」的限制；上述文档中的 ACP 拓扑、握手与 Registry 规则此后仅约束走次选 ACP 通道的 Agent。
- 新增或深化 Agent 能力时，先评估并优先落地独立 Agent 引擎原生接口；仅当目标 Agent 无可用官方 SDK/原生协议或属于长尾生态接入时，采用 ACP 通道。
