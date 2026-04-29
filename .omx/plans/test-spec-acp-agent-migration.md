# Test Spec: ACP Agent Migration

Created: 2026-04-28T09:57:34Z

## Automated Checks

- `cargo check -p executors`
  - Proves executor crate compiles after deleting legacy protocol modules and
    dependencies.
- `cargo check -p vibex`
  - Proves Tauri command integration compiles with ACP setup/preflight changes.
- Legacy protocol search
  - Search `Cargo.toml`, `Cargo.lock`, `crates`, and `src-tauri` for:
    `codex_app_server_protocol`, `codex-protocol`, `codex_core`,
    `codex-core`, `codex-app-server-protocol`, `@openai/codex@0.98.0`,
    and `app-server`.
  - Expected: no production-source matches.
- Full workspace verification when tooling is available:
  - `pnpm run check`
  - `pnpm run lint`
  - `pnpm run backend:check`
  - `cargo test --workspace`
  - `pnpm run generate-types:check`

## Manual Smoke Tests

- Start a Codex session and confirm the launched command is the Codex ACP
  adapter path.
- Start a Claude Code session and confirm the launched command is the Claude
  ACP adapter path.
- Start an OpenCode session and confirm the launched command is `opencode acp`.
- Send a follow-up for each provider and confirm a forked ACP session
  continues with prior context.
- Trigger a permission request and verify approval/denial feedback reaches the
  ACP agent.
- Open agent settings preflight for all three providers and verify the adapter
  status text matches the ACP adapter/runtime model.

## Known Gaps

- Real adapter smoke tests require the ACP adapter packages and underlying
  provider CLIs to be installed in the desktop runtime environment.
- Frontend npm checks require `pnpm` on PATH; this environment did not expose
  `pnpm` during the migration session.
