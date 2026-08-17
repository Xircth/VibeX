---
status: accepted
date: 2026-08-14
decision-makers:
  - VibeX maintainers
---

# Host 托管的插件域 MCP Runtime

## Context

当前 `content.mcp` 只保存并投影静态 MCP 配置，不能引用 Plugin managed Runtime、获得按会话短期
凭据或绑定 Workspace。现有 `vibex-mcp` 是平台内置的多 Agent 协作 companion；把 Workflow 工具
继续加入其中会把两个可独立安装、启停和演进的产品绑定成平台基础能力。

Workflow Creator 需要一个本地 MCP，而多 Agent 协作未来也要迁移为独立插件。因此平台需要的是
通用 MCP Runtime 托管 seam，不是另一个内置业务 MCP。协作与会话增强的产品拆分、凭据寿命和
`vibex-mcp` 退场已由 [ADR-0057](0057-session-enhance-and-multi-agent-plugins.md) 落地。

## Decision

1. 每个产品 Plugin 独立拥有 MCP identity、tool catalog、protocol compatibility、Runtime 和 Agent
   binding。Workflow Creator 使用 `vibex-workflow-mcp`；未来协作插件使用独立 MCP。
2. Plugin manifest 的 `content.mcp` 扩展为可以引用 managed Runtime、声明 STDIO transport、支持的
   MCP protocol revisions 与所需 Host scopes。
3. Host 解析并按 Agent session 启动 Runtime，注入绑定 Workspace 与 Plugin generation 的
   连接上下文（至少包含父 Conversation 与 workspace）。Plugin 不持久保存 Server URL、主
   token 或 device credential。凭据默认按会话、最小 scope；会话增强与多智能体协同改用
   插件启用期间的长驻、按插件拆开的 scope，见 ADR-0057。
4. 新 MCP 以 protocol revision `2026-07-28` 为主，实现 `server/discover`、逐请求版本声明与不支持
   版本错误；同时按协商兼容 Host SDK 支持的旧 revision。
5. 长操作立即返回稳定业务 ID；客户端协商 Tasks extension 时同时提供 task handle，否则使用普通
   tools/read/wait 轮询。MCP Tasks 不是 Workflow 运行事实源。
6. 默认 Agent binding 是“所有当前及未来兼容 Agent，减去显式排除项”。插件设置与 MCP 设置编辑
   同一 binding intent。
7. 不支持 MCP 或无法协商协议的 Agent 显示为 incompatible，不能伪装成已配置。
8. Plugin SDK、CLI validator、Host parser、Runtime resolver、Agent projection 与 testing harness 必须
   同时支持该 contribution，不能由插件直接调用内部 Tauri/Axum API 绕过。

## Consequences

- `content.mcp` 需要 managed/static 两种明确 descriptor，而不是靠 resource JSON 猜测。
- 现有会话通常不能动态增加 STDIO MCP；binding 变化后 Host 必须提示重新建立 Agent session。
- 平台 `vibex-mcp` 在 ADR-0057 落地的同一版本删除注入；Workflow 交付不依赖该迁移。
- Full Trust 允许 Runtime 执行，但动态身份与 generation lifecycle 仍由 Host 管理以保证正确性。

## Considered options

- **扩展现有 `vibex-mcp`。** 否决。它把多 Agent 协作和 Workflow Creator 变成不可独立演进的单一
  产品。
- **插件保存 Server URL/token。** 否决。凭据生命周期、撤销与 Workspace scope 无法可靠管理。
- **只提供远程 HTTP MCP。** 否决。首要场景是随本地 App 生命周期工作的 Agent STDIO MCP。

