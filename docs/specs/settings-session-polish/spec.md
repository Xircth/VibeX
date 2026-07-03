# Settings Window, Agent Settings, Channel Binding, and Composer Profile Polish Spec

Status: Draft
Date: 2026-07-01

## Background

This spec covers four regressions or incomplete integrations found in the current
VibeX codebase:

1. The Settings window is opened as a frameless webview instead of a normal app
   window, so it has no rounded native frame and no minimize/maximize/close
   buttons.
2. In Settings / Agent, "配置管理" and "预检查" use different surface styling;
   "配置管理" also has an extra border.
3. Message channels and Web service have persisted configuration and basic
   commands, but are not fully bound to real VibeX conversation events and
   session actions.
4. The follow-up composer profile controls duplicate Codex safety/permission
   affordances, so the input area can show two safety-related controls at once.

The work should preserve the existing Tauri + React architecture and the Tahoe
settings design tokens. It should not copy a second UI system into Settings.

## Investigation Summary

### Settings Window

- `src-tauri/src/commands/settings_window.rs` creates the `settings` window with
  `WebviewWindowBuilder` and explicitly calls `.decorations(false)`.
- There is no Settings-specific custom titlebar/window-control component in
  `frontend/src/pages/settings/SettingsLayout.tsx`.
- The main window keeps normal platform chrome via `src-tauri/tauri.conf.json`,
  so Settings is visually inconsistent with the rest of the app.

Assessment: this is a real window configuration issue, not a rendering bug in
the settings page.

### Agent Settings Surfaces

- `frontend/src/pages/settings/AgentSettings.tsx` defines a local
  `SettingsSection` that renders `settings-surface overflow-hidden rounded-xl`.
- The "预检查" section uses that `SettingsSection`.
- `frontend/src/pages/settings/AgentConfigManager.tsx` renders "配置管理" and
  "环境变量" as `section className="border bg-card overflow-hidden rounded-xl"`.

Assessment: this is a real styling mismatch. The extra border/background comes
from the local `AgentConfigManager` sections.

### Message Channels and Web Service

- `src-tauri/src/lib.rs` starts:
  - `events::start_agent_event_forwarding(...)`
  - `commands::chat_channel::start_inbound_manager(state.agent_runtime.clone())`
  - `commands::web_service::ensure_web_service_autostart()`
- Outbound chat notifications are partially wired:
  `src-tauri/src/events.rs` calls
  `chat_channel::notify_agent_event(...)` for selected low-frequency
  `AgentEvent`s such as prompt started/finished, permission requested, error,
  session created, turn completed, and connection status.
- That outbound path uses `crates/services/src/services/chat_delivery.rs` and
  builds simple lifecycle notifications from `AgentEvent`, not from normalized
  `ConversationEvent` projection data.
- Inbound chat commands are not conversation-native. `dispatch_command` in
  `src-tauri/src/commands/chat_channel.rs` resolves active ACP runtime sessions
  from `AgentRuntime::snapshot()` and sends work through
  `AgentRuntime::send_prompt(...)` directly.
- The conversation-native path is `ConversationSessionService::start_turn(...)`
  in `src-tauri/src/conversation_service.rs`, which creates/updates
  `ConversationRecord`, `ConversationTurnRecord`, appends
  `ConversationEvent`s, handles active turn state, checkpointing, profile
  overrides, and frontend event emission.
- `src-tauri/src/commands/web_service.rs` currently exposes only `/` and
  `/health` through Axum. Its token setting is stored, but the router does not
  enforce auth and does not expose conversation/session APIs or event streams.

Assessment: the user's suspicion is mostly correct. Message channels are
partially effective for outbound lifecycle notifications, but inbound chat
actions bypass real VibeX conversations. Web service is only a health/status
server today and is not bound to conversation events or session actions.

### Composer Profile Controls

- `frontend/src/components/tasks/follow-up/ActionBar.tsx` renders
  `TerminalProfileControls` with `lockExecutor={true}` and `iconOnly={true}`.
- For Codex, `TerminalProfileControls` renders separate rich controls:
  - a sandbox selector with a `Shield` icon, sourced from
    `getCodexSandboxOptions(...)`;
  - a model selector;
  - a reasoning-effort selector.
- Codex variant data in `frontend/src/utils/executor.ts` also models approval
  policy and exposes labels such as `Agent (full access)` through profile/config
  variants.

Assessment: this is a UI responsibility conflict. The same Codex safety concept
is represented both as a standalone icon-only control and in the profile/config
summary label. It is not evidence that the backend has two independent safety
states.

## Goals

- Make the Settings window behave like a normal platform application window.
- Make Agent Settings surfaces visually consistent with the rest of Settings.
- Bind message channels and Web service to real VibeX conversation/session
  events instead of detached ACP runtime commands.
- Ensure the composer has one clear safety/permission affordance per selected
  executor.
- Add tests that prevent these issues from silently returning.

## Non-Goals

- Do not redesign the full Settings information architecture.
- Do not replace the existing ACP runtime.
- Do not add public network exposure for Web service in this change; local
  service remains loopback-only unless a separate security spec expands it.
- Do not add new providers or channel platforms beyond the existing channel
  kinds.

## Requirements

### R1. Settings Window Chrome

- Opening Settings must create a normal, resizable application window with
  platform minimize, maximize/zoom, and close controls.
- The Settings window must have platform-native rounded corners where the OS
  provides them.
- The Settings content must not be obscured by the titlebar/window controls.
- Reopening Settings must focus the existing `settings` window.

Preferred implementation:

- Change `src-tauri/src/commands/settings_window.rs` to use native decorations
  for the Settings window, matching the main window.
- Keep the existing size, min size, icon, center, and focus behavior.

Fallback implementation if the product intentionally requires frameless
Settings:

- Keep `decorations(false)` only if a custom Settings titlebar is implemented.
- Add drag region and explicit minimize/maximize/close buttons using Tauri
  window APIs.
- Ensure custom controls behave correctly on macOS, Windows, and Linux.

### R2. Agent Settings Surface Consistency

- "配置管理", "环境变量", and "预检查" must use the same grouped settings surface
  treatment.
- `AgentConfigManager` must not add an extra outer `border bg-card` wrapper when
  adjacent Settings sections use `settings-surface`.
- Section headers, padding, radius, divider treatment, and background should
  match the `SettingsSection` style used by `AgentSettings`.
- Light and dark themes must both keep readable contrast.

Preferred implementation:

- Extract the local `SettingsSection` in `AgentSettings.tsx` into a reusable
  small component, or pass a compatible wrapper/component into
  `AgentConfigManager`.
- Replace the "配置管理" and "环境变量" outer classes in
  `AgentConfigManager.tsx` with `settings-surface overflow-hidden rounded-xl`
  or the shared component.
- Keep inner form borders only where they frame real repeated/editor controls
  such as config file editors or toggle lists.

### R3. Conversation-Native Message Channels

- Channel CRUD/test/send configuration may remain file-backed for now, but
  runtime behavior must route through conversation-native services.
- Outbound channel notifications must subscribe to normalized
  `ConversationEventEnvelope`s after they are appended/emitted, not only raw
  `AgentEvent`s.
- The event filter should operate on conversation event names or a documented
  mapping from conversation events to user-facing channel events.
- Outbound messages should include stable conversation and turn identifiers when
  safe, so users can correlate notifications with the desktop conversation.
- Inbound chat commands that submit work must call the same conversation service
  path as the desktop composer:
  `ConversationSessionService::start_turn(...)`.
- Inbound command routing must resolve or create a real `conversation_id` and
  `workspace_id`, then append a real user turn. The desktop UI must show the
  same turn and assistant response.
- Inbound follow-up commands must respect in-flight turn locking, profile
  selection, mode/config overrides where applicable, and permission behavior.
- Direct `AgentRuntime::send_prompt(...)` from chat command handling must be
  removed or limited to explicitly documented low-level diagnostics.

Implementation outline:

1. Introduce a conversation-event notification sink:
   - Add a backend fanout function that receives each
     `ConversationEventEnvelope` after `append_and_emit_conversation_events(...)`
     succeeds in `src-tauri/src/events.rs`.
   - Dispatch filtered events to `chat_channel` using a new
     `notify_conversation_event(...)` API.
2. Map conversation events to channel notifications:
   - `UserTurnStarted` -> task started.
   - `PermissionRequested` -> permission request.
   - `TurnCompleted` -> task completed.
   - `TurnFailed` -> error.
   - Optional: coalesced assistant summary/final text for completion messages,
     with privacy controls.
3. Replace inbound `send_task(...)`:
   - Store a bridge from external sender to a real VibeX conversation, not just
     `(connection_id, session_id)`.
   - Resolve active conversations from the DB/projection rather than only
     `AgentRuntime::snapshot()`.
   - Call `ConversationSessionService::start_turn(...)`.
4. Preserve simple commands:
   - `help`, `ping`, `status`, and `echo` can remain lightweight.
   - `sessions` should become `conversations` or list real active
     conversations with workspace/agent labels.

### R4. Conversation-Native Web Service

- The Web service must do more than `/` and `/health` before the settings page
  presents it as a session integration surface.
- The configured token must be enforced for non-health APIs.
- Web service APIs must expose real conversation operations:
  - list active/recent conversations;
  - start a turn in a conversation;
  - create a conversation for a workspace/agent when needed;
  - respond to permission requests;
  - cancel an active turn.
- Web service must expose a real event stream for conversation updates:
  - Server-Sent Events or WebSocket is acceptable;
  - events must be sourced from `ConversationEventEnvelope`;
  - clients can filter by conversation id.
- The Web service must not invent a separate session model; it should reuse the
  same conversation IDs visible in the desktop UI.

Implementation outline:

1. Extend the Axum router in `src-tauri/src/commands/web_service.rs` with app
   state instead of a static router.
2. Store/pass the required `AppState` or narrower conversation service handles
   when starting the server.
3. Add token middleware for all non-health endpoints.
4. Add local-only APIs:
   - `GET /api/conversations`
   - `GET /api/conversations/:id/events`
   - `POST /api/conversations/:id/turns`
   - `POST /api/conversations/:id/permissions/:permission_id`
   - `POST /api/conversations/:id/cancel`
5. Make auto-start use the same stateful router as manual start.

### R5. Composer Profile Control De-Duplication

- The follow-up composer must show only one safety/permission control for Codex.
- The agent/profile selector must choose the executor/profile identity. It
  should not duplicate the same safety state shown by a separate shield control.
- Codex safety state must have one source of truth:
  `sandbox + approvalPolicy` from the selected Codex variant/profile.
- Changing the visible safety control must update the same `ExecutorProfileId`
  data currently used by launch/profile overrides.
- The visible label must be unambiguous:
  - Good examples: `Full access`, `Workspace`, `Read only`, `Ask approval`.
  - Avoid showing both `Agent (full access)` and a separate shield-only control
    for the same state.

Preferred implementation:

- For `lockExecutor={true}` and `iconOnly={true}` in the composer, replace the
  separate Codex sandbox icon plus profile/config summary with a single
  Codex safety selector.
- The selector can combine sandbox and approval policy in one menu:
  `Full access / Never ask`, `Workspace / Ask`, etc.
- Keep model and reasoning controls as separate controls because they are
  orthogonal to safety.
- If the profile/config selector remains visible, remove safety text from its
  compact label or hide it when the dedicated safety selector is rendered.

Alternative implementation:

- Keep the existing profile/config selector as the single control and hide the
  Codex sandbox selector in the composer. This is simpler but less explicit.

## Acceptance Criteria

### Settings Window

- Opening Settings shows platform window controls.
- Settings can be minimized, maximized/restored, closed, reopened, and focused.
- The Settings window frame looks consistent with the main window on the target
  OS.

### Agent Settings

- "配置管理" and "预检查" have matching background, radius, and surface border
  behavior.
- No extra outer border appears around "配置管理".
- Existing config save, login, file editor, and environment variable flows still
  work.

### Message Channels

- A desktop-created conversation emits channel notifications from real
  `ConversationEvent`s.
- An inbound chat `task` command creates or continues a real VibeX conversation
  turn visible in the desktop UI.
- Assistant completion/failure is reflected in both the desktop UI and the
  configured channel.
- Permission requests are either routed to a real permission response flow or
  explicitly reported as unsupported for the channel; they must not silently hang.

### Web Service

- `/health` remains unauthenticated and local-only.
- Non-health endpoints require the configured token.
- Starting a turn through Web service creates the same DB/projection events as
  sending from the desktop composer.
- Event streaming returns real `ConversationEventEnvelope`s for the requested
  conversation.

### Composer Controls

- With Codex selected, the composer shows only one safety/permission affordance.
- Changing the safety control changes the selected Codex variant/profile and is
  used by the subsequent turn.
- Claude Code and OpenCode still show their expected permission/model controls.

## Test Plan

Frontend:

- Add/update tests around `TerminalProfileControls` to assert that Codex
  composer mode renders a single safety control.
- Add/update tests around `AgentConfigManager` or `AgentSettings` to assert that
  config/preflight sections share the same surface class contract.
- Run `cd frontend && pnpm run check`.

Rust:

- Add tests for chat channel event mapping from `ConversationEvent` to rich
  notification payloads.
- Add tests that inbound channel task dispatch calls a conversation-native
  service boundary instead of direct `AgentRuntime::send_prompt`.
- Add Web service route tests for auth, health, conversation turn creation, and
  event streaming.
- Run targeted tests first, then `cargo test --workspace` if the touched surface
  is broad.

Manual / Integration:

- Open Settings from the app and verify native window controls.
- In Settings / Agent, compare "配置管理" and "预检查" in light and dark themes.
- Configure a local webhook channel and verify notifications for a real desktop
  conversation.
- Send an inbound command through a test channel and verify the new turn appears
  in the desktop conversation.
- Start the Web service, call its conversation APIs with and without token, and
  confirm only authenticated requests can mutate/read session data.

## Risks and Mitigations

- Native window chrome differs by OS. Prefer platform decorations for Settings
  to reduce custom titlebar maintenance.
- Conversation event streams can be noisy. Keep event filters and debounce, but
  apply them after normalization so filters remain understandable.
- External channels can leak prompt content. Keep `include_prompt_text` default
  off and add separate controls before sending assistant text externally.
- Web service token enforcement is security-critical. Keep `/health` minimal and
  require auth for all session data.
- Inbound channel routing needs workspace/conversation selection. If no target
  can be inferred, reply with a clear command flow instead of creating a hidden
  conversation in the wrong workspace.

## Suggested Implementation Order

1. Fix Settings window chrome.
2. Unify Agent Settings surfaces.
3. De-duplicate Codex composer safety/profile controls.
4. Add conversation-event notification sink for outbound channels.
5. Migrate inbound channel `task` dispatch to `ConversationSessionService`.
6. Extend Web service with authenticated conversation APIs and event streaming.
7. Add regression tests and run targeted checks.
