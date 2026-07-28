---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# 卸载与移除是不同操作

“卸载”只删除 VibeX 托管的 Agent Runtime 与 ACP 适配器，保留 Agent 的已添加
关系、导航带位置、设置和历史会话，使内置与普通 Agent 都可以原位重新安装。
“从 VibeX 移除”只适用于非内置 Agent：它终止已添加关系，并清除 VibeX 保存的
Agent 专属设置、明文凭据和托管运行组件，但不删除历史会话。

两种操作都不能修改外部 Runtime、外部 CLI 登录状态或外部配置文件。共享的
Node、Python、uv 等托管环境在仍有使用者时必须保留；无人使用时只进入可清理
状态，不随单个 Agent 的卸载或移除连带删除。
