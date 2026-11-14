# VibeX Plugin Platform (`v4`)

VibeX Plugin 是一个以统一产品身份、版本、配置和生命周期扩展 VibeX 的完整功能包（遵循 [ADR-0069：一切皆插件](../adr/0069-everything-is-a-plugin-platform.md)）。一个插件可以同时连接 **Agent**（Skill、MCP、Hook、Workflow）、**App**（文件预览/编辑器、面板、工具栏、状态栏、命令、设置、主题、右键菜单）、**Host**（Worker、后台服务、Provider 接缝）和 **Runtime**（受校验并锁定的本地二进制），且**官方插件与第三方插件完全同权**（零私有 API、零 ID 特判）。

## 面向用户与插件作者

- [插件使用指南](user-guide.md) — 在设置与 `vibex plugin` CLI 中发现、安装、启用、配置、更新与卸载插件。
- [插件开发文档](developer-guide.md) — 包布局、`vibex-plugin` CLI、`@vibex/plugin-sdk`（JS/TS `^2.0.0`）、Python / Rust Worker SDK、热更新链接（`--dev`）与打包分发。
- [官方插件全景介绍](official-plugins.md) — 17 个官方插件（`plugins/*` 与 `vibex-plugin.json`）及宿主内置协作空间说明。

## 用户入口

- `/plugins`：包含「已安装」与「插件市场」两个 Tab 的产品插件目录；
- `/plugins/:pluginId`：独立插件详情页，仅设「内容」（`README.md` 与经过验证的 `contents/`）与「配置」（基于 Schema 原子读写根 `config.json`）两个主 Tab；
- Agent 原生插件（Codex、Claude Code、Grok、DeepSeek Harness 等自有插件格式）：仍在「设置 → Agent → 对应 Agent」底部管理，不混入 VibeX 产品插件目录。

## 平台规范与契约

- [Package v4 规范](package-v4.md) — `.vibex-plugin/plugin.json`、README `summary` frontmatter、`contents/`、`depends/` 与 `config.json` 规范；
- [SDK 与 CLI 参考](sdk-and-cli.md) — `@vibex/plugin-sdk`、`@vibex/plugin-cli`（`vibex-plugin`）与开发链接工作流；
- [平台内核架构](platform-architecture.md) — Plugin Kernel、Activation Generations、Full-Trust Worker/App 生命周期与远程 Host 执行边界；
- [23 类贡献点与权限绑定表](../plugin-contract/bindings.md) — `L0`–`L3` 贡献类型、渲染轨道与 `host.call` 契约参考。

## 核心架构决策（ADR）

- [ADR-0046](../adr/0046-full-stack-plugin-platform-and-isolated-sdk.md) — 统一插件内核生命周期、隔离进程管理与版本化 SDK；
- [ADR-0047](../adr/0047-product-centric-plugin-package-and-content-model.md) — 以产品为中心的 Package v4 包结构、内容与配置模型；
- [ADR-0048](../adr/0048-full-trust-plugin-execution-model.md) — Full Trust 本机执行模型；
- [ADR-0066](../adr/0066-plugin-marketplace-authoring-and-session-honesty.md) — 插件市场、来源锁更新与新会话生效诚实性；
- [ADR-0069](../adr/0069-everything-is-a-plugin-platform.md) — 一切皆插件：壳层贡献点、Provider 接缝与无特权官方插件。
