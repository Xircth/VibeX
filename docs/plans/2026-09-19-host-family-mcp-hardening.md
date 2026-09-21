# Host-family MCP hardening

Date: 2026-09-19
Status: accepted for implementation
Related: ADR-0051, ADR-0055, ADR-0057, ADR-0069
Codeg baseline: sibling `codeg` (`DelegationService`, `inject_codeg_mcp`, `locate_codeg_mcp_binary`)

## Problem

Official product MCP (`vibex-delegation-mcp`, `vibex-session-mcp`,
`vibex-workflow-mcp`) is declared by plugins and materialized by the VibeX
MCP registrar (`hostFamilyBinary`). The process is the Host-family sidecar
`vibex-mcp` / `vibex-workflow-mcp`, spawned by the Agent CLI over stdio.

Two defects made that path unusable on Windows:

1. Empty sidecar files were packaged and then projected as the basename
   `vibex-mcp.exe`, which is not on PATH (`spawn_failed` / program not found).
2. Host broker bind happened once at boot with no ping, no rebind, and no
   skip-if-unrunnable injection, so a dead socket or a missing binary looked
   the same as “plugin off”.

This plan keeps the registrar. It does not invent a second MCP registry, a
plugin-owned process supervisor, or Agent-stdio hot reconnect (Grok CLI does
not hot-plug MCP mid-session).

## Layers (corrected)

| Layer | Owns | Does not own |
|---|---|---|
| Plugin package | `content.mcp` declaration, enable switch, tool-group config | Spawning or restarting `vibex-mcp.exe` |
| Registrar | Enable projection, disable teardown, `plugin_mcp_status` snapshot | Broker socket, ACP session lifecycle |
| Host | Sidecar locate, broker socket, ACP `session/new` injection, ping/rebind | A second registration system |
| Agent CLI | stdio MCP client spawn / reconnect | Host broker |

`--supervise` in Codeg is the Server process supervisor, not MCP. Do not copy
it onto `vibex-mcp.exe`.

## Already shipped

- Empty sidecar detection in `scripts/stage-host-sidecars.js` and
  `locate_host_family_binary` (skip 0-byte files).
- Status-bar MCP popover: plugins as rows, expand tools, enable/disable via
  `plugin_control_set_enabled`, `plugin_mcp_status` Host command.

## Remaining work

### P0 — Injection must not lie

1. **Runnable locator.** Add `locate_runnable_host_family_binary(base) -> Option<PathBuf>`
   that never returns a PATH basename. Keep `locate_host_family_binary` as a
   compatibility wrapper that still falls back for callers that only log a path.
2. **Native projection skip.** `materialize_host_family_binary_mcp` (desktop
   `plugin_control.rs` and Server `plugin_projections.rs`) returns `Ok(None)`
   when the binary is not runnable. Never write `command = "vibex-mcp.exe"`.
3. **ACP injection skip.** `VibexDelegationInjector` and
   `HeadlessDelegationInjector` omit a server whose command is not runnable.
   If every official server is omitted, return `Unsupported { code: "companion_binary_missing" }`.
   Do not inject a ghost path that can fail `session/new` on strict agents.
4. **`--parent-pid`.** ACP inject args and `host_family_stdio_spec` pass
   `std::process::id()`. `vibex-mcp` already parses the flag.

### P1 — Broker is a service, not a fire-and-forget task

5. **`DelegationService`** in `crates/delegation` (Codeg `acp/delegation/service.rs`
   behavior, VibeX types):
   - Boot `start()` binds once.
   - `is_listening()` is an end-to-end ping with a 1.5s timeout, not “task
     handle still exists”.
   - `ensure_running()` is idempotent: ping ok → no-op; ping fail → bind
     replacement first, then drop the old accept loop. Windows: do not rebind
     a live named-pipe accept loop (`first_pipe_instance`).
   - Concurrent `ensure_running` shares one lock.
6. **Wire `Ping`.** Add untokened `BrokerMessage::Ping` → `{ ok: true }`
   payload. Unix accept errors sleep 100ms instead of spinning.
7. **Windows client.** `vibex-mcp` pipe open already retries `ERROR_PIPE_BUSY`;
   also retry `NotFound` inside the same 200ms budget (Codeg).
8. **Status.** `plugin_mcp_status` reports `listening` for the broker.
   `plugin_mcp_ensure_running` (`plugin.write`) calls `ensure_running`.
   Status-bar popover shows a Start control only when the headline is
   `stopped` because the socket is down (not when the binary is missing).

### P2 — Observability copy

9. Status-bar copy already distinguishes unavailable (binary) vs disabled
   (plugin off). Keep it. Do not add a plugin Worker watchdog for sidecars.
10. Document that Grok CLI sessions that failed MCP spawn at start must be
    opened again after the sidecar is fixed. That is an Agent-client limit.

## Codeg alignment (ACP inject)

Must match:

- Absolute runnable command, or skip.
- `--parent-connection-id`, `--socket-path`, `--token`, `--features`,
  `--parent-pid`.
- `supports_mcp=false` → empty `mcpServers` (already gated).
- One-shot broker RPC (already).

Must **not** match:

- Codeg writes product MCP only on the ACP wire for Grok. VibeX plugins
  **must** keep native projection so Grok CLI can spawn `vibex-delegation-mcp`.

## Acceptance

- Empty sidecar: new ACP session starts; no companion; grok config has no
  basename command; logs name `companion_binary_missing` or projection skip.
- Real sidecar next to Host: ACP injects absolute path + `--parent-pid`;
  native projection uses the same path; `initialize` / `tools/list` work.
- Kill the broker socket (Unix) or fail ping: `ensure_running` restores ping
  without restarting the app. Windows live pipe is not torn down by a no-op
  ensure.
- Disable the plugin: binding gone, native entry removed, new sessions do not
  inject.
- Tests: `host_bin` empty stub; inject skip; projection skip; `DelegationService`
  ping/ensure; `stage-host-sidecars`; StatusBarMcp; `plugin_mcp_status` contract.

## Out of scope

- Plugin-side process supervisor for `vibex-mcp.exe`.
- Hot-reconnect of an already-failed Grok CLI MCP client.
- Replacing `hostFamilyBinary` with another registry.
