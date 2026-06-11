# Tasks: Registry, Install, Config, MCP, Skills, And History

- [x] Task: Add registry metadata for all target agents.
  - Acceptance: Registry returns stable entries for Claude Code, Codex,
    OpenCode, Gemini, OpenClaw, Cline, and Hermes.
  - Verify: `cargo test -p agents registry`
  - Files: `crates/agents/src/registry.rs`.

- [x] Task: Add distribution command builders.
  - Acceptance: Npx, Binary, Uvx, and System commands build reproducibly on
    Windows, macOS, and Linux.
  - Verify: `cargo test -p agents distribution`
  - Files: `distribution.rs`, platform helpers.

- [x] Task: Add install/update/preflight services.
  - Acceptance: Install status distinguishes missing prerequisite, missing agent,
    unsupported platform, auth missing, and ready.
  - Verify: `cargo test -p agents install preflight`
  - Files: `installer.rs`, `preflight.rs`.

- [x] Task: Add config, MCP, and skills strategies.
  - Acceptance: Each agent declares supported config surfaces; unsupported
    operations return typed unsupported errors.
  - Verify: `cargo test -p agents config mcp skills`
  - Files: `config.rs`, `mcp.rs`, `skills.rs`.

- [x] Task: Add history parser framework and first fixture set.
  - Acceptance: Parser framework handles all target agent types; fixtures cover
    at least one happy path and one corrupt source per implemented parser.
  - Verify: `cargo test -p agents history`
  - Files: `history/**`, fixtures.
