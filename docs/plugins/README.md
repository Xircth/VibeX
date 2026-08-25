# VibeX Plugin Platform

VibeX Plugin 是一个用户可理解的功能产品，不是 Skill、MCP、Runtime、命令或 App surface 的
集合页。一个插件以同一身份、版本、配置和生命周期扩展 VibeX；内部接线由 Kernel 管理。

## 面向用户和作者

- [插件指南](user-guide.md)，安装、启用、使用、关闭和卸载。
- [插件开发文档](developer-guide.md)，包结构、CLI、JS / Python / Rust SDK、测试、更新、本机分发。不含公共货架上传。
- [官方插件介绍](official-plugins.md)，随 Host 带来的 Office、会话增强、多智能体、Workflow Creator、插件开发。

## 用户入口

- `/plugins`：保留设置侧栏的单列已安装插件目录；
- `/plugins/:pluginId`：独立插件详情；
- “内容”：README 与经过验证的 `contents/` 结构；
- “配置”：根据 schema 编辑插件根 `config.json`；
- Agent-native plugin：仍在“设置 → Agent → 对应 Agent → 插件”管理，不混入产品目录。

## 规范文档

- [Package v4](package-v4.md)：README summary、contents、depends、config 与 manifest；
- [平台架构](platform-architecture.md)：Kernel、Full Trust Worker/App lifecycle 与 Remote seam；
- [SDK 与 CLI](sdk-and-cli.md)：作者 API、构建、验证、测试和 linked development；
- [Office reference plugin](office-reference-plugin.md)：同一公共契约下的 Office 完整能力；
- [迁移与验收](migration-and-verification.md)：迁移顺序、门禁和 rollback；
- [实现状态](implementation-status.md)：已落地能力与生产缺口。
- [bb 对齐与产品完成度](bb-parity-and-product-readiness.md)：逐项对照与下一阶段优先级。
- [优化方案](optimization-plan.md)：开发、测试、打包、发布、安装与装卸干净的分阶段计划。

## 决策

- ADR-0046：统一生命周期、隔离执行、版本化 SDK；
- ADR-0047：产品中心的包布局、内容、配置与 UI。
- ADR-0048：Full Trust 执行模型。
