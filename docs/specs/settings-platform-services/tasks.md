# Settings Platform Services Tasks

## Status

- [x] Remove old Tahoe design worktree.
- [x] Create new worktree from local `master`.
- [x] Scan VibeX settings architecture and `codeg-main` reference implementation.
- [x] Implement feature slices below after spec approval.

## T0. Worktree Setup

- [x] Remove `C:\Users\Administrator\Documents\Projects\VibeX-tahoe-design-system-convergence`.
- [x] Create `C:\Users\Administrator\Documents\Projects\VibeX-settings-platform-services`.
- [x] Branch: `feature/settings-platform-services`.

## T1. Settings IA And Route Shell

- [x] Task: Update settings exports, nav items, and routes.
  - Acceptance: new nav entries exist; old `/settings/editor` redirects to `/settings/general`.
  - Verify: `pnpm run frontend:check`.
  - Files: `frontend/src/pages/settings/*`, `frontend/src/MainAppRoutes.tsx`.

- [x] Task: Create shared settings section/list utilities if duplication grows.
  - Acceptance: pages reuse Tahoe section/row conventions without nested card clutter.
  - Verify: visual review and frontend typecheck.
  - Files: `frontend/src/pages/settings/*`.

Review: Complete. Shared Tahoe settings primitives are in `settings-ui.tsx`; settings routes and nav pass `pnpm run frontend:check`.

## T2. General Settings

- [x] Task: Create `GeneralSettings` page.
  - Acceptance: terminal and preview settings move from `EditorSettings`; editor selection remains available.
  - Verify: settings save still uses `configApi.saveConfig`.
  - Files: `frontend/src/pages/settings/GeneralSettings.tsx`, `EditorSettings.tsx`.

- [x] Task: Remove old editor page from nav while preserving redirect.
  - Acceptance: `/settings/editor` no longer appears in nav and redirects to `/settings/general`.
  - Verify: route smoke check.
  - Files: `SettingsLayout.tsx`, `MainAppRoutes.tsx`.

Review: Complete. Terminal, editor, and preview controls are available under `/settings/general`; `/settings/editor` redirects.

## T3. Version Control Settings

- [x] Task: Create `VersionControlSettings` with moved Git/PR settings.
  - Acceptance: worktree directory, branch prefix, commit prompt, and PR prompt are under `版本管理`.
  - Verify: config save keeps existing fields unchanged.
  - Files: `frontend/src/pages/settings/VersionControlSettings.tsx`.

- [x] Task: Add backend Git version and GitHub account commands.
  - Acceptance: UI can detect Git, validate custom path, add/test/remove GitHub accounts.
  - Verify: command compile/typecheck.
  - Files: `src-tauri/src/commands/version_control.rs`, `src-tauri/src/lib.rs`, API wrappers.

Review: Complete. Version control commands are registered, the UI detects Git/GitHub CLI state, and `pnpm run frontend:check` plus `cargo check` pass.

## T4. Instructions

- [x] Task: Add instruction API facade over existing tags.
  - Acceptance: existing tags list as local instructions; create/update/delete still persists to current tag storage.
  - Verify: typecheck and manual CRUD.
  - Files: `frontend/src/lib/api/*`, `src-tauri/src/commands/instructions.rs`.

- [x] Task: Create `InstructionsSettings` two-pane UI.
  - Acceptance: local/official market tabs, left list, right preview/edit, new instruction flow, Agent multi-select.
  - Verify: visual review against MCP two-pane layout.
  - Files: `frontend/src/pages/settings/InstructionsSettings.tsx`.

- [x] Task: Preserve composer `#tag_name` compatibility.
  - Acceptance: existing composer typeahead still resolves renamed instructions.
  - Verify: existing typeahead tests or manual check.
  - Files: composer typeahead files, shared types if needed.

Review: Complete. Instruction CRUD writes through tags, Agent availability metadata is separate, the old System tag section was removed, and `pnpm run frontend:check` plus `cargo check` pass.

## T5. System Settings: Proxy, Rendering, Backup

- [x] Task: Add `system_settings` commands for proxy and rendering.
  - Acceptance: proxy URL validation; rendering mode persisted and surfaced to UI.
  - Verify: backend check/typecheck.
  - Files: `src-tauri/src/commands/system_settings.rs`, `src-tauri/src/lib.rs`, frontend API.

- [x] Task: Add proxy and rendering sections to `SystemSettings`.
  - Acceptance: controls are compact Tahoe grouped rows; dirty/save behavior is clear.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/SystemSettings.tsx`.

- [x] Task: Port backup core and commands.
  - Acceptance: create, inspect, stage restore, and progress event commands exist and target VibeX data paths.
  - Verify: backend check; manual backup inspect if safe.
  - Files: `src-tauri/src/commands/backup/*`, `src-tauri/src/lib.rs`, Cargo deps if required.

- [x] Task: Add backup/restore UI section.
  - Acceptance: export/restore tabs, passphrase controls, preview metadata, staged restore confirmation.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/SystemSettings.tsx` or `BackupSettings.tsx`.

Review: Complete. Proxy settings validate through `reqwest::Proxy`, rendering uses the spec three-state mode, backup exports/inspects/restores VibeX portable data with progress events, and restore requires prior preview plus confirmation. Passphrase controls are present but disabled because this build does not include encryption. `pnpm run frontend:check` and `cargo check` pass.

## T6. Web Service

- [x] Task: Add web service backend manager.
  - Acceptance: saved config, start/stop/status, token generation, port probe.
  - Verify: backend check.
  - Files: `src-tauri/src/commands/web_service.rs`, `src-tauri/src/lib.rs`.

- [x] Task: Add `WebServiceSettings` page.
  - Acceptance: port/token/autostart/status/address controls match Tahoe design; route `/settings/web-service` works.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/WebServiceSettings.tsx`, API wrappers.

Review: Complete. Web service config is persisted, status/start/stop/probe/token commands are registered, auto-start is wired during app setup, and `/settings/web-service` uses compact Tahoe rows with status, port, token, and service controls. `pnpm run frontend:check` and `cargo check` pass.

## T7. Model Providers

- [x] Task: Add model provider persistence and secret commands.
  - Acceptance: provider CRUD and active provider per Agent are available.
  - Verify: backend check.
  - Files: backend commands/models/migrations or JSON store.

- [x] Task: Implement provider model fetching.
  - Acceptance: OpenAI-compatible `/v1/models` fetch works with configured endpoint/key and surfaces errors.
  - Verify: unit/manual with mockable endpoint where possible.
  - Files: `model_provider.rs`, frontend API.

- [x] Task: Create `ModelProviderSettings` UI.
  - Acceptance: list/filter/create/edit/delete/switch provider; custom JSON supported; secrets masked.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/ModelProviderSettings.tsx`, dialogs.

Review: Complete. Model providers are stored in a VibeX JSON store, API keys are kept in a separate secret store and only exposed as `has_api_key`, active provider is tracked per Agent, `/v1/models` sync uses the saved endpoint/key, and the settings page supports list/search/create/edit/delete/model sync/custom JSON/Agent activation. `pnpm run frontend:check` and `cargo check` pass.

## T8. Message Channels

- [x] Task: Add chat channel persistence/token/status commands.
  - Acceptance: channels can be created, enabled, tested, deleted; token presence is queryable.
  - Verify: backend check.
  - Files: `src-tauri/src/commands/chat_channel.rs`, storage models.

- [x] Task: Add event filter and command prefix commands.
  - Acceptance: user can configure event notification types and query prefix.
  - Verify: backend check.
  - Files: chat channel backend and frontend API.

- [x] Task: Create `ChatChannelSettings` UI.
  - Acceptance: channel list, commands, events, and other/options tabs.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/ChatChannelSettings.tsx`, supporting components.

- [x] Task: Wire VibeX events into channel notifications.
  - Acceptance: configured channels receive selected coding activity events.
  - Verify: manual event dispatch in dev mode.
  - Files: `src-tauri/src/events.rs`, chat channel modules.

Review: Complete. Chat channel CRUD, token presence, test send, event filter, and command prefix commands are registered. Agent runtime events are forwarded to enabled webhook channels according to the saved filter, without blocking the Tauri event stream. The UI provides channel/config/events/commands tabs and passes `pnpm run frontend:check`; `cargo check` passes.

## T9. Verification And Polish

- [x] Task: Run frontend/backend checks after implementation.
  - Acceptance: `pnpm run frontend:check` and `pnpm run backend:check` pass unless user says not to run tests/checks.
  - Verify: command output.

- [x] Task: Manual design audit.
  - Acceptance: no content glass, no nested cards, no text overflow, all icon-only controls labeled.
  - Verify: browser/app visual pass.

Review: Complete. Final root `pnpm run check` passes, covering `frontend:check` and `backend:check`. Code-level design audit found no placeholder settings pages or obvious nested-card violations in the new settings pages; icon-only controls added in this pass include title/aria labels where applicable. A live Tauri screenshot pass was not run in this turn.
