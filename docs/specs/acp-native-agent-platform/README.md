# Spec Set: ACP-Native Agent Platform Replacement

## Intent

Replace VibeX's current agent execution architecture with an ACP-native agent
platform modeled after Codeg's agent layer. This is a big-bang replacement, not a
compatibility migration.

## Non-Negotiable Direction

1. `crates/agents` becomes the only product-owned agent orchestration layer.
2. ACP is the primary and only live agent protocol for coding agents.
3. The old agent paths are removed from the product path in the same replacement:
   - `crates/executors/src/executors/acp`
   - provider runtime commands and frontend adapters
   - Claude/OpenCode SDK bridge scripts
   - Codex app-server native-provider orchestration
   - ACP fallback policy and native-provider fallback concepts
4. No compatibility adapter is added from the new runtime back to
   `SpawnedChild`, `MsgStore`, `ExecutionProcess`, provider runtime events, or
   old normalized conversation logs.
5. Non-agent workbench systems remain only where they are not agent runtimes:
   file tree, Git, workspaces, preview, project rail, settings shell, and
   ordinary user terminals.

## Spec Layout

- `00-master-cutover/`: product-wide objective, success criteria, and cutover
  rules.
- `01-agents-crate-runtime/`: new `crates/agents` runtime, ACP connection model,
  event stream, queue, cancellation, permissions, terminal, filesystem.
- `02-registry-install-history/`: Codeg-style agent registry, installation,
  config/auth detection, MCP, skills, and history import.
- `03-tauri-api-storage/`: new Tauri command surface, event transport, database
  ownership, generated types.
- `04-frontend-agent-workbench/`: frontend input, output, queue, permissions,
  terminal, settings, and history UI.
- `05-legacy-removal-verification/`: deletion plan, compile fallout map, final
  verification gates, and rejected compatibility paths.

## Source References

The target design is informed by Codeg's public implementation:

- Agent registry lists Claude Code, Codex, Gemini, OpenClaw, OpenCode, Cline, and
  Hermes as ACP agents.
- Agent metadata uses distribution variants such as `Npx`, `Binary`, and `Uvx`.
- Runtime connection state is owned by an ACP connection manager with command
  channels, prompt locking, connection state, cleanup guards, and frontend event
  emission.

When copying source, preserve upstream license notices and attribution. If a file
is substantially copied, include the Codeg origin and license header in the new
file or crate-level NOTICE.

