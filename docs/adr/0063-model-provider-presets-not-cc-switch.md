---
status: accepted
date: 2026-08-26
decision-makers:
  - VibeX maintainers
---

# Model Provider 管理保持 Agent 结构化预设，CC Switch 只作导入源

设置 → Agent → 鉴权 Provider 管理可复用 Model Provider 预设：卡片列表、启用即互斥绑定、新建/编辑走同栏子页。不恢复已删除的全局「模型提供商」页，也不采用 CC Switch 的全量覆盖 + 本地代理架构。

Agent 原生配置仍是 Runtime 权威（ADR-0022）；绑定只投影已适配字段（ADR-0037）。CC Switch 的 JSON 快照、Chat Completions 路由、统一供应商和 Codex OAuth 反向代理要么无法在不截获 CLI 的情况下生效，要么越过官方设备认证边界。本机 `~/.cc-switch/cc-switch.db` 只作为一次性只读导入源：抽出名称、端点、凭据和模型映射，预览后默认跳过同名，不改变当前绑定。复制预设只把不含密钥的字段写入本机剪贴板。
