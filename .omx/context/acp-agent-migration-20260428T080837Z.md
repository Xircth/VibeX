# ACP Agent Migration Context Snapshot

Timestamp: 2026-04-28T08:08:37Z

## User Intent

Migrate VibeX's agent invocation layer to ACP without backward compatibility.
The immediate goal is a complete plan, not implementation.

## Root Cause Being Addressed

Codex failed after switching the launched CLI to a newer version because the
current executor uses `codex-app-server-protocol` pinned to `rust-v0.98.0`
and still calls the old `newConversation` / `sendUserMessage` app-server API.
Newer Codex app-server exposes `thread/start` and `turn/start` instead. Pinning
Codex back to `0.98.0` is only a compatibility stopgap, not a durable fix.

## Current Repository Facts

- `crates/executors/src/executors/mod.rs` defines `CodingAgent` as dedicated
  variants: `ClaudeCode`, `Codex`, `Opencode`, plus optional `QaMock`.
- `StandardCodingAgentExecutor` is the current spawn/follow-up/review/log
  normalization boundary used by action execution.
- `crates/executors/src/executors/acp/` already exists and includes:
  - `AcpAgentHarness`
  - `AcpClient`
  - `SessionManager`
  - `normalize_logs`
  - terminal lifecycle support
- `crates/executors/Cargo.toml` already depends on
  `agent-client-protocol = { version = "0.8", features = ["unstable"] }`.
- `crates/executors/Cargo.toml` still depends on old Codex crates:
  `codex-protocol`, `codex-app-server-protocol`, and `codex-core`, all pinned
  to OpenAI Codex tag `rust-v0.98.0`.
- `crates/executors/src/executors/codex.rs` currently launches
  `npx -y @openai/codex@0.98.0 app-server`.
- `crates/executors/src/executors/claude.rs` uses Claude Code's stream-json and
  control protocol directly.
- `crates/executors/src/executors/opencode.rs` launches `opencode serve` and
  drives OpenCode through its HTTP SDK surface.
- `crates/executors/default_profiles.json`, `profile.rs`, `src-tauri`
  commands, and frontend selectors all assume agent/profile identity flows
  through `BaseCodingAgent` / `ExecutorProfileId`.
- `src-tauri/src/commands/agent_settings.rs` currently checks and updates
  agent CLIs via direct CLI names (`claude`, `codex`, `opencode`) and npm
  package installs.

## Reference Project Facts

- `code-referance/desktop-cc-gui-main` contains a newer Codex app-server
  integration using `thread/start`, `turn/start`, `model/list`, turn events,
  and runtime lifecycle handling.
- This reference is useful to understand the protocol break and event parity,
  but the requested direction is ACP, not another Codex app-server migration.

## External ACP Facts

- The Agent Client Protocol ecosystem provides an official registry and SDKs.
- `agentclientprotocol/claude-agent-acp` provides a Claude Agent SDK ACP
  adapter with support for permissions, edit review, TODO, terminal, slash
  commands, and client MCP.
- The ACP registry lists `codex-acp` pointing to `zed-industries/codex-acp`,
  with npm and Windows binary launch options.
- OpenCode supports an `opencode acp` command over stdio JSON-RPC.

## Planning Constraints

- No backward compatibility layer should be preserved for the old Codex
  app-server protocol or the old bespoke Claude/OpenCode executors.
- Existing user-facing features should be preserved through the new ACP path:
  initial prompt, follow-up, review, model/profile selection, permissions,
  terminal/tool rendering, file edit rendering, files changed summaries,
  cancellation, slash command discovery where supported, MCP configuration,
  version/update checks, and session persistence.
- The migration should reuse the existing ACP harness where sound, but should
  not treat it as complete until fake-server and real-agent smoke tests prove
  parity.

## Git Hygiene Risk

The worktree contains unrelated tracked deletions under reference/backup
directories and many prior modifications. ACP implementation should not be
mixed with those changes. Reference directories should remain ignored/untracked
or be explicitly removed from tracking in a separate commit.
