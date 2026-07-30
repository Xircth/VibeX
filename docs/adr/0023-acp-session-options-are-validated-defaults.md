---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# ACP 会话选项只能作为经验证的新会话默认偏好

模型、模式、推理强度等 ACP 配置选项属于具体 Agent session，VibeX 可以记忆用户选择
的 option id 与 value，但不能把它们写成 Agent 原生配置或视为永久能力。创建新会话
时，VibeX 只有在 Agent 仍广告对应选项和值时才应用偏好；选项失效时使用 Agent
默认值并提示用户，不阻止 Agent 就绪。

每个既有会话继续持有自己的 ACP 配置。修改新会话默认偏好不会追溯改变既有会话，
也不会覆盖 Agent Runtime 的持久配置。

首版只维护每个 Agent 的全局新会话默认偏好，并允许创建会话时做一次性覆盖；一次性
选择不反向修改默认值。首版不增加 Project 级持久覆盖层，避免形成 Agent、Project
与会话三级隐式优先关系。

Session rebind 时，VibeX 尝试沿用该 Conversation 原有的模型、模式与推理选项，
但只重新应用新版本仍然广告的相同 option id 与 value；失效选项回退到 Agent 默认
并明确提示。选项迁移不能被误表示为 Agent 隐藏上下文已经恢复。
