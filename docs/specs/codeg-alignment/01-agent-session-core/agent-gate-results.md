# Phase 1 T1.9 Agent 会话门结果

日期：2026-06-13

## 自动化门

- `cargo test -p agents --test integration`：通过。`all_registered_agents_pass_fixture_session_gate` 对 ClaudeCode、Codex、OpenCode、Gemini、OpenClaw、Hermes、Cline 逐类执行 fixture 会话链路。
- `cargo test -p agents`：通过。122 条单元测试 + 1 条 integration fixture gate 通过。

Fixture 会话链路覆盖：

1. 建立 connection 并创建 session。
2. 发送 prompt 并接收流式 `MessageChunk`。
3. 接收 `ToolCall` 与 `ToolCallUpdate`。
4. 接收 `AvailableCommands`、`SessionModes`、`SessionConfigOptions`。
5. 接收权限请求，测试选择 `allow-once` 应答。
6. 接收 `PermissionResponded`、`TurnCompleted(end_turn)`、`PromptFinished(end_turn)`。
7. 执行 `resume_session`。
8. 发送可中断 prompt，执行 cancel 并确认 `PromptFinished(cancelled)`。
9. 取消后再次发送 prompt 并收到新流式输出。

## 本机探测记录

| Agent | 本机命令/运行时 | 认证痕迹 | T1.9 证据 |
|---|---|---|---|
| ClaudeCode | `claude-agent-acp` found at `C:\Users\Administrator\AppData\Roaming\npm\claude-agent-acp.ps1`; `--help` exit 0 with no stdout | `C:\Users\Administrator\.claude.json` found | Fixture gate passed |
| Codex | `codex-acp` found at `C:\Users\Administrator\AppData\Roaming\npm\codex-acp.ps1`; `--help` exit 0 | `C:\Users\Administrator\.codex\auth.json` found | Fixture gate passed |
| OpenCode | `opencode` found at `C:\Users\Administrator\AppData\Roaming\npm\opencode.ps1`; `opencode --version` = `1.16.2` | OpenCode auth/config markers missing | Fixture gate passed |
| Gemini | direct `gemini` command missing; `npm view @google/gemini-cli version` = `0.46.0` | no known marker found | Fixture gate passed |
| OpenClaw | direct `openclaw` command missing; `npm view openclaw version` = `2026.6.6` | no known marker found | Fixture gate passed |
| Hermes | `hermes` and `uv` commands missing; `python --version` = `3.14.5` | no known marker found | Fixture gate passed |
| Cline | direct `cline` command missing; `npm view cline version` = `3.0.24` | no known marker found | Fixture gate passed |

说明：真实 LLM/tool 调用链路可能消耗外部服务且行为不完全确定，本记录把本机 adapter/认证探测作为人工实测准备状态，把可重复的通过证据收口到 fixture integration gate。后续若产品负责人要求成本可接受的 live smoke，可在此表中把对应行从 `Fixture gate passed` 升级为 `Live gate passed`。
## 2026-06-13 acceptance follow-up clarification

The T1.9 gate currently uses one deterministic in-memory ACP-compatible event sequence for all registered Agent types. This remains useful as a VibeX runtime/event/store regression gate, but it is not a per-Agent recorded ACP transcript and does not spawn each real adapter. Per-Agent fixture transcripts/live adapter smoke are deferred and should be tracked separately before this gate is described as protocol-dialect coverage.
