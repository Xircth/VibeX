---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# Agent 安装与认证是独立生命周期

Agent 的安装完成不以用户已经登录为前提：本地 runtime 与 ACP 组件安装、版本和
路径校验以及 ACP `initialize` 握手通过后，该 Agent 即为已安装。需要认证但尚未
登录或配置凭据的 Agent 进入待认证状态，继续显示在 Agent 设置中并提供认证入口；
只有满足认证与必要配置条件的就绪 Agent 才能用于创建新会话。

认证失败或用户暂缓认证不会回滚、删除已经验证通过的安装。安装状态、认证状态与
会话可用性必须分别表达，不能再用单一的“已配置”或“已启用”布尔值混合表示。
