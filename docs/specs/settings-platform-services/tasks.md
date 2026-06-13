# Settings Platform Services Tasks

## Status

- [x] Remove old Tahoe design worktree.
- [x] Create new worktree from local `master`.
- [x] Scan VibeX settings architecture and `codeg-main` reference implementation.
- [ ] Implement feature slices below after spec approval.

## T0. Worktree Setup

- [x] Remove `C:\Users\Administrator\Documents\Projects\VibeX-tahoe-design-system-convergence`.
- [x] Create `C:\Users\Administrator\Documents\Projects\VibeX-settings-platform-services`.
- [x] Branch: `feature/settings-platform-services`.

## T1. Settings IA And Route Shell

- [ ] Task: Update settings exports, nav items, and routes.
  - Acceptance: new nav entries exist; old `/settings/editor` redirects to `/settings/general`.
  - Verify: `pnpm run frontend:check`.
  - Files: `frontend/src/pages/settings/*`, `frontend/src/MainAppRoutes.tsx`.

- [ ] Task: Create shared settings section/list utilities if duplication grows.
  - Acceptance: pages reuse Tahoe section/row conventions without nested card clutter.
  - Verify: visual review and frontend typecheck.
  - Files: `frontend/src/pages/settings/*`.

## T2. General Settings

- [ ] Task: Create `GeneralSettings` page.
  - Acceptance: terminal and preview settings move from `EditorSettings`; editor selection remains available.
  - Verify: settings save still uses `configApi.saveConfig`.
  - Files: `frontend/src/pages/settings/GeneralSettings.tsx`, `EditorSettings.tsx`.

- [ ] Task: Remove old editor page from nav while preserving redirect.
  - Acceptance: `/settings/editor` no longer appears in nav and redirects to `/settings/general`.
  - Verify: route smoke check.
  - Files: `SettingsLayout.tsx`, `MainAppRoutes.tsx`.

## T3. Version Control Settings

- [ ] Task: Create `VersionControlSettings` with moved Git/PR settings.
  - Acceptance: worktree directory, branch prefix, commit prompt, and PR prompt are under `版本管理`.
  - Verify: config save keeps existing fields unchanged.
  - Files: `frontend/src/pages/settings/VersionControlSettings.tsx`.

- [ ] Task: Add backend Git version and GitHub account commands.
  - Acceptance: UI can detect Git, validate custom path, add/test/remove GitHub accounts.
  - Verify: command compile/typecheck.
  - Files: `src-tauri/src/commands/version_control.rs`, `src-tauri/src/lib.rs`, API wrappers.

## T4. Instructions

- [ ] Task: Add instruction API facade over existing tags.
  - Acceptance: existing tags list as local instructions; create/update/delete still persists to current tag storage.
  - Verify: typecheck and manual CRUD.
  - Files: `frontend/src/lib/api/*`, `src-tauri/src/commands/instructions.rs`.

- [ ] Task: Create `InstructionsSettings` two-pane UI.
  - Acceptance: local/official market tabs, left list, right preview/edit, new instruction flow, Agent multi-select.
  - Verify: visual review against MCP two-pane layout.
  - Files: `frontend/src/pages/settings/InstructionsSettings.tsx`.

- [ ] Task: Preserve composer `#tag_name` compatibility.
  - Acceptance: existing composer typeahead still resolves renamed instructions.
  - Verify: existing typeahead tests or manual check.
  - Files: composer typeahead files, shared types if needed.

## T5. System Settings: Proxy, Rendering, Backup

- [ ] Task: Add `system_settings` commands for proxy and rendering.
  - Acceptance: proxy URL validation; rendering mode persisted and surfaced to UI.
  - Verify: backend check/typecheck.
  - Files: `src-tauri/src/commands/system_settings.rs`, `src-tauri/src/lib.rs`, frontend API.

- [ ] Task: Add proxy and rendering sections to `SystemSettings`.
  - Acceptance: controls are compact Tahoe grouped rows; dirty/save behavior is clear.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/SystemSettings.tsx`.

- [ ] Task: Port backup core and commands.
  - Acceptance: create, inspect, stage restore, and progress event commands exist and target VibeX data paths.
  - Verify: backend check; manual backup inspect if safe.
  - Files: `src-tauri/src/commands/backup/*`, `src-tauri/src/lib.rs`, Cargo deps if required.

- [ ] Task: Add backup/restore UI section.
  - Acceptance: export/restore tabs, passphrase controls, preview metadata, staged restore confirmation.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/SystemSettings.tsx` or `BackupSettings.tsx`.

## T6. Web Service

- [ ] Task: Add web service backend manager.
  - Acceptance: saved config, start/stop/status, token generation, port probe.
  - Verify: backend check.
  - Files: `src-tauri/src/commands/web_service.rs`, `src-tauri/src/lib.rs`.

- [ ] Task: Add `WebServiceSettings` page.
  - Acceptance: port/token/autostart/status/address controls match Tahoe design; route `/settings/web-service` works.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/WebServiceSettings.tsx`, API wrappers.

## T7. Model Providers

- [ ] Task: Add model provider persistence and secret commands.
  - Acceptance: provider CRUD and active provider per Agent are available.
  - Verify: backend check.
  - Files: backend commands/models/migrations or JSON store.

- [ ] Task: Implement provider model fetching.
  - Acceptance: OpenAI-compatible `/v1/models` fetch works with configured endpoint/key and surfaces errors.
  - Verify: unit/manual with mockable endpoint where possible.
  - Files: `model_provider.rs`, frontend API.

- [ ] Task: Create `ModelProviderSettings` UI.
  - Acceptance: list/filter/create/edit/delete/switch provider; custom JSON supported; secrets masked.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/ModelProviderSettings.tsx`, dialogs.

## T8. Message Channels

- [ ] Task: Add chat channel persistence/token/status commands.
  - Acceptance: channels can be created, enabled, tested, deleted; token presence is queryable.
  - Verify: backend check.
  - Files: `src-tauri/src/commands/chat_channel.rs`, storage models.

- [ ] Task: Add event filter and command prefix commands.
  - Acceptance: user can configure event notification types and query prefix.
  - Verify: backend check.
  - Files: chat channel backend and frontend API.

- [ ] Task: Create `ChatChannelSettings` UI.
  - Acceptance: channel list, commands, events, and other/options tabs.
  - Verify: frontend typecheck and visual review.
  - Files: `frontend/src/pages/settings/ChatChannelSettings.tsx`, supporting components.

- [ ] Task: Wire VibeX events into channel notifications.
  - Acceptance: configured channels receive selected coding activity events.
  - Verify: manual event dispatch in dev mode.
  - Files: `src-tauri/src/events.rs`, chat channel modules.

## T9. Verification And Polish

- [ ] Task: Run frontend/backend checks after implementation.
  - Acceptance: `pnpm run frontend:check` and `pnpm run backend:check` pass unless user says not to run tests/checks.
  - Verify: command output.

- [ ] Task: Manual design audit.
  - Acceptance: no content glass, no nested cards, no text overflow, all icon-only controls labeled.
  - Verify: browser/app visual pass.
