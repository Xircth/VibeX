# Spec Set: ACP-Native Agent Platform Replacement

## Intent

Replace VibeX's current agent execution architecture with a single ACP-native
agent platform. This is a big-bang replacement, not a compatibility migration.

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
- `02-registry-install-history/`: data-driven agent registry, installation,
  config/auth detection, MCP, skills, and history import.
- `03-tauri-api-storage/`: new Tauri command surface, event transport, database
  ownership, generated types.
- `04-frontend-agent-workbench/`: frontend input, output, queue, permissions,
  terminal, settings, and history UI.
- `05-legacy-removal-verification/`: deletion plan, compile fallout map, final
  verification gates, and rejected compatibility paths.
- `06-event-sourced-conversation-core/`: breaking refactor that makes VibeX's
  own conversation event log the canonical history source for ACP sessions,
  replacing Agent transcript re-parse as the live rendering path and adding
  projection, filesChanged, capability gating, and import/export planning.
- `07-open-agent-registry-management/`: replaces the closed seven-Agent settings
  model with the ACP Registry, managed local Runtime installations, Built-in
  Profiles, evidence-based migration, and the settings Agent bar / Registry UI.

## Architecture Basis

The registry is data-driven, with distribution variants such as `Npx`, `Binary`,
and `Uvx`. Runtime connection state is owned by an ACP connection manager with
command channels, prompt locking, cleanup guards, and typed frontend events.

VibeX conversation history is rebuilt from VibeX-owned events. Agent transcript
files are import-only inputs, not live conversation detail sources.
