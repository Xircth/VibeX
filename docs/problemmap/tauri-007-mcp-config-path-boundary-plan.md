# TAURI-007 MCP config path boundary cleanup plan

## Scope

- File: `src-tauri/src/commands/config/mcp_servers.rs`
- Smell: weak boundary, panic-prone config mutation, missing tests.
- Current issue: `set_mcp_servers_in_config_path` assumes `McpConfig.servers_path` is non-empty and traversable, then uses `path.len() - 1`, `last().unwrap()`, and object `unwrap()` calls while mutating user config JSON.

## Behavior lock first

Add focused unit coverage for the pure config-path writer:

- an empty server path returns an error instead of panicking;
- a non-object intermediate value is replaced with an object before writing the server map.

The empty-path test should fail before the checked traversal exists.

## Cleanup order

1. Add the failing pure helper tests.
2. Add an explicit empty-path guard.
3. Replace unwrap-based traversal with checked object access and entry creation.
4. Keep MCP read/update API behavior and success messages unchanged.

## Verification

- `cargo test -p vibex mcp_servers --lib`
- `cargo check -p vibex`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
