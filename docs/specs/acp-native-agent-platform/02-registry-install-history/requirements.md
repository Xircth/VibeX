# Spec: Agent Registry, Install, Config, MCP, Skills, And History

## Objective

Model agents as plugin-like ACP entries. The registry should not be limited to
Claude Code, Codex, and OpenCode. It should include the Codeg-supported set at
minimum: Claude Code, Codex, OpenCode, Gemini, OpenClaw, Cline, and Hermes.

## Acceptance Criteria

1. WHEN the frontend lists agents THEN it SHALL receive registry entries for all
   supported ACP agents with name, description, distribution, version, platform,
   install status, auth/config status, and capability hints.
2. WHEN an agent is installed or updated THEN VibeX SHALL execute the registry
   distribution plan for Npx, Binary, Uvx, or System command entries.
3. WHEN config/auth is probed THEN VibeX SHALL report agent-specific status
   without turning ACP package names into the primary user-facing concept.
4. WHEN MCP or Skills are managed THEN settings SHALL be read/written through the
   agent's documented config surface or explicit registry metadata.
5. WHEN history is imported THEN VibeX SHALL parse each agent's native history
   store separately from live ACP sessions.
6. WHEN copied Codeg registry/parser code is used THEN license attribution SHALL
   be preserved.

## Agent Set

- Claude Code: `@agentclientprotocol/claude-agent-acp`.
- Codex: `codex-acp` binary distribution.
- OpenCode: `opencode acp`.
- Gemini: `@google/gemini-cli` with `--acp --skip-trust`.
- OpenClaw: `openclaw acp`.
- Cline: `cline --acp`.
- Hermes: `hermes-acp` through uvx or an explicit system command alternative.

## History Sources

- Claude Code: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`.
- Codex: `$CODEX_HOME/sessions` or `~/.codex/sessions`.
- OpenCode: `$XDG_DATA_HOME/opencode/opencode.db`.
- Gemini: `$GEMINI_CLI_HOME/.gemini` or `~/.gemini`.
- OpenClaw: `~/.openclaw/agents`.
- Cline: `$CLINE_DIR` or `~/.cline/data/tasks`.
- Hermes: `$HERMES_HOME/state.db` or `~/.hermes/state.db`.

## Boundaries

- Always: separate live ACP sessions from imported historical sessions.
- Always: represent install sources as registry metadata, not hard-coded UI
  branches.
- Always: expose exact command and version diagnostics for maintainers.
- Never: assume all agents support the same MCP or Skills schema.
- Never: block live ACP support because a history parser for the same agent is
  incomplete.

## Testing Strategy

- Unit-test registry metadata for every supported agent.
- Snapshot-test generated install plans per platform.
- Parser fixture tests for each history source.
- Config read/write tests use temporary home directories.
