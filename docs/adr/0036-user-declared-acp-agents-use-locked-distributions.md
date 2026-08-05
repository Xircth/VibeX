---
status: accepted
date: 2026-08-05
decision-makers:
  - VibeX maintainers
---

# 用户声明的 ACP Agent 复用版本锁定安装管线

## Context

VibeX 已经通过 Built-in Agent Profile 与 ACP 官方 Registry 支持开放的
`AgentId`、统一 membership、安装计划、Installation lock、启动前完整性校验和 ACP
能力协商。不过 ADR-0010、ADR-0018 与 ADR-0034 暂时禁止所有用户声明来源，因此
官方 Registry 尚未收录的内部 Agent、开发中 Agent 和 fork 无法接入。

竞品 Codeg 已允许用户粘贴 ACP Registry 兼容的 `distribution` JSON，并把该定义加入
统一 Agent 列表。这个交互值得采用，但 VibeX 不能因此绕过已经建立的 Registry
freshness、冻结目标、安装锁和启动前校验边界。

## Decision

VibeX 新增 **User-declared agent definition（用户声明 Agent 定义）** 作为第三种受控
Agent 来源。它只接受 ACP Registry `distribution` 兼容的 Binary、npx 或 uvx 声明，
不接受任意本地启动命令、PATH 自动发现、远程 ACP URL、自定义 Registry URL 或每次
启动临时下载执行。

用户声明定义包含：

- 不可变、全局唯一的稳定 `AgentId`；
- 展示名、描述和语义版本；
- 用户明确选择的分发方式；
- 该分发方式所需的 Registry 兼容 distribution 数据；
- 由规范化定义计算的 SHA-256 digest。

保存与添加在一个数据库事务内完成。新 Agent 立即获得 membership、默认启用并进入
Agent bar；安装失败、取消或中断不撤销 membership。Built-in 与已有 Agent id 不得被
覆盖。

安装前，定义必须通过与官方 Registry 相同的结构、平台、URL、包版本和 SHA-256
校验。npx/uvx 包必须精确锁定到定义版本；Binary 使用声明的预期 SHA-256，缺失时沿用
普通 Registry Binary 的 TOFU 策略。所选分发在创建操作时冻结，不允许失败后静默切换。

`FrozenInstallPlan` 与 `InstallationLock` 记录 `user_definition` 来源及 definition
digest。执行器只消费冻结计划；定义之后被编辑不会改变已经排队或已经安装的版本。
每次创建 ACP 连接仍执行 ADR-0034 的 LaunchGate 与内容哈希验证。

官方 Registry catalog 与用户声明定义保持两个独立投影：

- 官方 catalog 继续只展示当前已验证的官方 snapshot，并保留 freshness/离线限制；
- 用户声明 Agent 不伪装成 Registry entry，也不受 Registry 在线状态约束；
- Agent bar 与详情页继续使用统一 membership、状态、安装、认证和会话管线；
- 移除用户声明 Agent 时删除 VibeX 拥有的定义与托管产物，但保留历史 Conversation。

## Consequences

- 这项决策仅取代 ADR-0010、ADR-0018 与 ADR-0034 中“来源仅限两种”及“禁止用户声明
  distribution”的边界；它不放宽远程 ACP、任意命令、PATH 接管或完整性要求。
- 用户声明来源的真实性由用户负责，VibeX 只声明“用户提供”；不得显示“官方
  Registry”或“VibeX 已验证”徽标。
- 手动添加 UI 使用设置页内联表单，不把 Registry freshness 与用户定义的可保存性
  混为一体；错误必须在字段旁给出可修复说明。
- 第一阶段不提供任意图标 URL、专属原生配置适配、历史文件解析或 Agent 名称特判。
  Agent 通过通用 ACP 事件日志保留 VibeX Conversation 历史。

## Rejected alternatives

- **允许任意可执行路径与参数。** 否决：无法形成可复现安装锁，也扩大了 PATH 劫持与
  任意进程启动面。
- **把用户定义写入 Registry snapshot。** 否决：会伪造来源、破坏离线 freshness 与
  上游下架语义。
- **保存后每次启动直接运行 npx/uvx latest。** 否决：破坏精确版本、生态完整性和
  可复现修复。
- **只在前端校验 JSON。** 否决：WebView 是不受信边界；Application Core 必须重复
  解析、规范化、校验并原子持久化。
