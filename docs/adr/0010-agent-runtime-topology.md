---
status: accepted
---

# 本地 Runtime 按原生 ACP 与适配器型 ACP 建模

“使用本地 Agent runtime”不等于每个 Agent 都必须在 ACP server 之外再有一个程序。VibeX 区分原生 ACP agent（同一安装物同时提供 Agent runtime 与 ACP）和适配器型 ACP agent（ACP 桥接独立的本地 Agent runtime）；Built-in Agent Profile 明确声明拓扑，适配器型内置 Agent 必须验证并绑定两个组件，禁止适配器静默改用其内置 CLI。

## Consequences

- 普通 Registry Agent 默认把其 Registry 分发视为自包含的本地 runtime，安装到本机并通过可执行文件与 ACP 握手验证后才能使用。
- 普通 Registry Agent 若实际依赖 manifest 未声明的外部 runtime，预检失败后标记为不受支持；VibeX 不为其补写专属适配。
- Registry 分发不得只以临时下载方式在每次启动时直接执行；注册过程必须形成可复核的本地安装。
- 首版仅启动由官方 Registry 分发、在本机运行的 ACP `stdio` 进程（Binary、npx、uvx）；
  不接受远程 ACP URL、HTTP/WebSocket 端点或用户自定义启动命令，以保持运行时与安装锁
  的可验证绑定。
- Built-in Agent Profile 随 VibeX 应用发布更新；不得从远端动态下载或覆盖其运行拓扑、
  检测规则、版本组合或完整性基线。
