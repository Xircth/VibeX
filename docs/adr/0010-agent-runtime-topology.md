---
status: accepted
date: 2026-07-28
amended: 2026-09-02
---

# 本地 Runtime 按原生 ACP 与适配器型 ACP 建模

“使用本地 Agent runtime”不等于每个 Agent 都必须在 ACP server 之外再有一个程序。VibeX 区分原生 ACP agent（同一安装物同时提供 Agent runtime 与 ACP）和适配器型 ACP agent（ACP 桥接独立的本地 Agent runtime）。Built-in Agent Profile 声明拓扑，以及适配器是否自带可用的 vendor CLI。

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
