---
summary: 让父 Agent 通过 vibex-mcp 把工作委派给其它 Agent。
---
# VibeX Collaboration

启用后，Host 在支持 MCP 的新 Agent 会话中注入 `vibex-mcp`。用户可以用 `&Agent` 表达委派意图。

禁用后不再注入 companion。已有会话需要重建后才会去掉 MCP。
