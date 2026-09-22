# Codeg 架构浏览器插件

彻底移除 CEF Web Preview，按 Codeg 的系统 WebView 架构在 Host 实现原生标签，并以官方插件 `vibex.browser` 交付完整产品面。

| 文档 | 内容 |
| --- | --- |
| [design.md](design.md) | 拆除清单、Host 能力面、插件移植方案、阶段计划 |
| [tasks.md](tasks.md) | 可立即开工的任务清单（依赖、交付物、验收） |

状态：`ready-for-implementation`。产品约束来自 2026-09-20 架构评估：不保留 CEF；原生 WebView 留在 Host；插件持有壳层入口、MCP 与 chrome。
