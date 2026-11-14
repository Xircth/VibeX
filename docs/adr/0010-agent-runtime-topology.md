---
status: accepted
date: 2026-07-28
amended: 2026-11-14 (ADR-0087)
---

# 本地 Runtime 拓扑：独立引擎优先，ACP 通道按原生 ACP 与适配器型 ACP 建模

> **修订说明（[ADR-0087](0087-dedicated-agent-engine-first-acp-fallback.md)）**：VibeX 现采用**独立 Agent 引擎适配优先，ACP 为次选**。已提供独立引擎驱动（直连官方 SDK 或原生 `app-server` 协议）的 Agent 直接验证并启动其原生引擎，不依赖 `*-acp` 包装包。本文下述 `NativeAcp` 与 `AdapterBacked` 拓扑规则适用于走次选 ACP 通道的 Agent。

在次选 ACP 通道内，“使用本地 Agent runtime”不等于每个 Agent 都必须在 ACP server 之外再有一个程序。VibeX 在 ACP 通道中区分原生 ACP agent（同一安装物同时提供 Agent runtime 与 ACP）和适配器型 ACP agent（ACP 桥接独立的本地 Agent runtime）。Built-in Agent Profile 声明所采用的引擎驱动或 ACP 拓扑。

适配器自带 vendor CLI 的内置 Agent（当前为 Claude Code 与 Codex）：会话只验证并启动 ACP 适配器；适配器使用其分发内的 CLI。PATH 上的 vendor CLI 只作可选本地证据（诊断、原生配置目录），不是会话启动门，也不得经 `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` 注入。安装不得强制再写入一份独立的 vendor CLI 包。

可用性与 CodeG 的 `is_cmd_available` / `verify_agent_installed` 对齐：列表、引导和会话是否“已安装/可启动”只看 ACP 启动命令能否在 PATH（含 npm 全局前缀）上解析。用户自装的 `claude-agent-acp` / `codex-acp` 算已安装，不必再有一份托管锁；仅有 `claude` / `codex` vendor CLI 不算已安装。

其余适配器型内置 Agent（当前为 Pi）：与 CodeG 相同，宿主只安装并验证 `pi-acp`；`pi` CLI 由适配器自行解析，不是预检查或会话启动门。自定义 `PI_ACP_PI_COMMAND` 属于设置，不进入预检查健康项。

## Consequences

- 普通 Registry Agent 默认把其 Registry 分发视为自包含的本地 runtime，安装到本机并通过可执行文件与 ACP 握手验证后才能使用。
- 普通 Registry Agent 若实际依赖 manifest 未声明的外部 runtime，预检失败后标记为不受支持；VibeX 不为其补写专属适配。
- Registry 分发不得只以临时下载方式在每次启动时直接执行；注册过程必须形成可复核的本地安装。
- 首版仅启动由官方 Registry 分发、在本机运行的 ACP `stdio` 进程（Binary、npx、uvx）；
  不接受远程 ACP URL、HTTP/WebSocket 端点或用户自定义启动命令，以保持运行时与安装锁
  的可验证绑定。
- Built-in Agent Profile 随 VibeX 应用发布更新；不得从远端动态下载或覆盖其运行拓扑、
  检测规则、版本组合或完整性基线。
