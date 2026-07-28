---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# Agent 纳入关系独立于安装状态与 Registry 可用性

VibeX 用“已添加”表达 Agent 已经进入用户的 Agent 集合，而不用“已安装”代替这一
关系。四个内置 Agent 默认已添加；其他 Registry Agent 在用户确认“添加并安装”时
立即成为已添加 Agent、进入统一 Agent 导航带，并在其详情页继续安装、预检查、
认证和修复。

ACP 注册表视图以“已添加”和“可添加”两个 Tab 表达本地纳入关系，两个列表各自
排序；内置 Agent 在已添加列表中置顶，其他 Agent 按名称排序。安装中、待认证、
损坏或需修复不会移除已添加关系，上游 Registry 下架也只会让条目从注册表视图
消失，不会移除本地 Agent 导航带中的 Agent。
