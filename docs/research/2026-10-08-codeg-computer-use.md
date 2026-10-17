# codeg Computer Use Research

Research date: 2026-10-08\
Repository: `C:\Users\18190\Documents\projects\codeg`\
Revision: `592131c72e2a05478e7f8398a91cb653c8e3996f` (`v0.34.0`, 2026-10-07)

The reference repository was synchronized to `origin/main` before this review. Its
worktree was clean at the recorded revision. This document distinguishes observed
codeg behavior from VibeX design recommendations; codeg's implementation is not
evidence of universal platform security or accessibility guarantees.

## Product model

Computer use shares explicitly selected native application windows with an agent.
The user chooses a target and a level of access; the agent can discover apps and
windows, inspect accessibility data or screenshots, verify state, and perform a
bounded set of actions. Read and control are distinct. Targets can be a window, an
application, or the whole screen, with broader scopes enabling broader operations.
Foreground input, app launch, window movement, clipboard access, and screen sharing
have separate policy controls. Background input is the default where supported.

The visible contract treats desktop content as untrusted input. Agents may use the
content to carry out the user's request, but must not treat instructions found in
that content as authority to change the task.

## Architecture

```text
ACP/MCP tool adapter or desktop UI
  -> ComputerService (policy, grants, target table, generation, stop, activity)
  -> LocalBackend (versioned framed protocol)
  -> signed/package-managed helper
  -> OS APIs and pinned computer-use driver
```

The ACP tool adapter delegates to the same service used by the desktop UI. It does
not grant tools a separate authorization path. Service startup creates the local
backend, target table, and driver manager. Configuration changes update policy;
turning the capability off or adding a matching block rule revokes affected grants.
Idle grants are swept. The app also owns a persistent activity indicator, action
marker, and global Stop shortcut.

The helper protocol is versioned, length-framed JSON with a closed operation enum.
It does not expose arbitrary driver tool names or process execution. Helper-side
checks repeat important identity, session, secret-field, and observation freshness
checks. The pinned driver speaks a fixed MCP JSON-RPC revision. Distribution checks
pin versions and verify package integrity/signatures where supported. macOS uses a
separately signed helper as the TCC permission subject. This narrows the callable
surface; it is not a general-purpose sandbox, particularly on Windows and X11 where
the helper generally shares the user's OS authority.

## Tool contract

The public tool schemas are in `src-tauri/src/acp/delegation/tool_schema.json`;
listener-side typed operations and refusal mapping are in
`src-tauri/src/acp/computer_tools.rs`.

| Group | Operations | Contract highlights |
| --- | --- | --- |
| Discovery | `computer_list_apps`, `computer_list_windows` | Lists stable target identity and sharing state; does not reveal titles of unshared windows. |
| Observation | `computer_snapshot`, `computer_screenshot` | Snapshot returns accessibility roles, labels, values and refs; secret values are omitted. Screenshot includes dimensions, desktop bounds and observation generation. |
| Verification | `computer_verify` | Evaluates predicates such as bounds, role, label, enabled and selected, returning satisfied/unsatisfied/unknown without echoing sampled values. |
| Input | `computer_click`, `computer_drag`, `computer_scroll`, `computer_type`, `computer_press_key`, `computer_hold_key`, `computer_set_value` | Requires control authorization. Element refs and coordinates must come from the latest observation for that target. |
| App/window | `computer_restore`, `computer_invoke_menu`, `computer_launch_app`, `computer_set_window_frame` | Whole-app/screen authorization is required for app-level menus. Launch and moving windows are separately user-enabled. Foreground side effects vary by OS. |
| Clipboard | `computer_clipboard_read`, `computer_clipboard_write` | Separately enabled. Read is provenance-limited to agent-written clipboard data or content copied from a currently authorized target; it does not read arbitrary user clipboard contents. |
| Stop | User UI and shortcut | A stop ends sharing and rejects later operations until the user shares again. |

Refusals are structured tool results (error code and recovery note), not opaque
transport errors. They distinguish missing grants, missing control level, stale
observations, blocked targets, unsupported operations, stopped state, and transient
conditions. The tool schema documents whether retrying is useful and what only the
user can change.

## Authorization and freshness

The host records authorization against target identity, access level, grant epoch,
expiry, and current policy. Window identity is not just a title; target tracking
accounts for process/window identity and changes over time. Each snapshot/capture
advances an observation generation. Re-sharing, revocation, target replacement,
window changes, or a new observation invalidate stale element refs and points.
Coordinates are tied to a specific screenshot and coordinate space; desktop units
and image pixels are not interchangeable.

The service checks authorization and policy before dispatch. Important checks are
repeated at the helper/action boundary. Stop is serialized with queued actions: once
the stopped state is published, no later action is allowed through. A failed helper
action is not blindly replayed because it may already have taken effect.

## UI and settings

The interface includes a window picker, persistent indicator, action marker, and
dedicated Computer Use settings. The picker distinguishes app/window/screen targets
and read/control sharing levels. The indicator exposes what is shared and provides
Stop. Settings include grant lifetime, target blocklist, default delivery mode,
foreground input, launch/window movement, clipboard, screen-wide access, indicator
visibility, and configurable Stop shortcut. Platform permission status and driver
health are surfaced with actions to request permission, open system settings,
reveal the helper, or install/remove the managed driver.

The frontend API/store/hooks mirror Rust wire types and subscribe to backend state,
grant, activity, driver, marker, stop-key, and settings-change events. The UI is a
projection of host-owned state, not the authority that makes a grant valid.

## Implementation and verification evidence

- Tool schemas and behavioral limits: `src-tauri/src/acp/delegation/tool_schema.json`
- Listener adapter and refusal values: `src-tauri/src/acp/computer_tools.rs`
- Central service, shared MCP access and stop: `src-tauri/src/commands/computer.rs`
- Target identity and invalidation: `src-tauri/src/computer/targets.rs`
- Agent grant/epoch logic: `src-tauri/src/computer/agent.rs`
- Closed helper protocol: `src-tauri/src/computer/protocol.rs`
- Local helper backend: `src-tauri/src/computer/local.rs`
- UI state API: `src/lib/computer/computer-api.ts`, `computer-store.ts`, `types.ts`
- Window picker and activity UI: `src/components/computer/computer-window-picker.tsx`, `computer-indicator.tsx`, `computer-marker.tsx`
- Settings: `src/components/settings/computer-settings.tsx`, `src/app/settings/computer-use/page.tsx`
- Tests: Rust unit tests in the computer and ACP modules; frontend tests under `src/lib/computer/` and `src/components/computer/`; helper packaging checks in release workflows.

Static inspection confirms test coverage exists for grants, expiry, blocklists,
identity, protocol framing, snapshot refs, secret fields, stop behavior, refusal
mapping, and UI state. This research did not run the test suite or verify real OS
behavior; per-platform end-to-end testing remains necessary.

## VibeX adaptation

VibeX's plugin is the product and integration surface; the Host remains the sole
authority for desktop capture and input. A plugin may contribute documentation,
settings, commands, status, and a managed MCP tool adapter, but it must call a public
versioned Host API for all OS operations. It must not invoke private Tauri commands,
Rust APIs, or the helper directly. MCP is one client of the same authorization
service, not a grant shortcut.

VibeX's Full Trust model means installed plugin code has broad local process
authority, but does not remove the need for explicit user-controlled sharing,
revocation, target binding, visible activity, and Stop. Keep settings preferences
in the plugin's `config.json`; keep live grants, epochs, target identity, stop state,
and activity in Host-owned runtime state. Unsupported host platforms must report
unavailable rather than pretending to offer equivalent behavior.

Relevant VibeX decisions: ADR-0046, ADR-0047, ADR-0048, ADR-0051, ADR-0061,
ADR-0066, ADR-0069, ADR-0078, and ADR-0081.
