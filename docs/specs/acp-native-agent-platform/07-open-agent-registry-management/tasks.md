# Tasks: Open ACP Registry Agent Management (Strict TDD)

## Delivery rules

Every task is a vertical red → green → refactor slice. The **RED** command must
fail for the stated missing behavior before production code is changed. Run the
focused test again after the minimum implementation (**GREEN**), then run the
listed regression command before starting the next task. Do not batch all tests
before implementation, mock internal collaborators, or preserve a closed-Agent
path merely to keep compilation green.

Dependencies are sequential unless marked **parallel after**. Tasks intentionally
stay within a small public seam; compiler-driven call-site edits belong to the
task that replaces that seam, not a later compatibility layer.

## Phase A — executable specification and open identity

- [x] A1. Add management-domain fixtures and the open `AgentId` seam.
  - RED: `cargo test -p api-types agent_id_rejects_invalid_values_and_preserves_stable_ids`
    fails for valid generic Registry ids, built-in ids, and retired ids.
  - GREEN: Introduce `AgentId`, management source/state/value DTOs, and TS export;
    keep legacy string parsing in a migration-only module.
  - Refactor/delete: remove `AgentKind::ALL` and product-facing enum assumptions
    from new DTOs; do not add `Unknown` enum variants.
  - Verify: `cargo test -p api-types`; `pnpm run generate-types:check`.
  - Files: `crates/api-types/src/agent_*`, export module, generated types.

- [x] A2. Convert the live session eligibility and conversation binding seam to `AgentId`.
  - RED: `cargo test -p agents session_eligibility_uses_open_agent_id` fails when a
    non-built-in valid AgentId is supplied.
  - GREEN: Replace live `AgentKind` parameters in `crates/agents` session/runtime
    public APIs and conversation event binding with `AgentId`.
  - Refactor/delete: isolate legacy enum parsing to migration/history; delete live
    enum bridges rather than retaining dual overloads.
  - Verify: `cargo test -p agents session`; `cargo test -p api-types`; generated types.
  - Files: `crates/agents/src/{ids,session,manager,events}.rs`, API types.

- [x] A3. Establish public test seams and deterministic fixture ACP process.
  - RED: `cargo test -p agents management_fixture_acp_reports_initialize_and_version`
    fails because the fixture is absent.
  - GREEN: Add a test-only stdio ACP fixture plus fake `RegistryFetcher`,
    `InstallRunner`, `Clock`, and native filesystem boundary traits.
  - Refactor/delete: no mock of domain services/repositories; test doubles remain
    at HTTP/process/filesystem/time boundaries only.
  - Verify: `cargo test -p agents management_fixture`.
  - Files: `crates/agents/tests/**`, test support modules, dev dependencies only if needed.

## Phase B — persistence and evidence migration

- [x] B1. Create normalized management tables and public repositories.
  - RED: `cargo test -p db membership_repository_persists_open_id_and_position`
    fails against a migrated SQLite database.
  - GREEN: Add migrations/models/repositories for membership, installation locks,
    snapshot entries, diagnostics and session defaults; use transactions for
    position and current-lock updates.
  - Refactor/delete: do not extend `agent_setting` as the new source of truth.
  - Verify: `cargo test -p db agent_management`; `pnpm run prepare-db:check`.
  - Files: one migration set, `crates/db/src/models/agent_management/**`, tests.

- [x] B2. Implement evidence-based legacy migration.
  - RED: `cargo test -p db migrates_only_agents_with_actual_use_evidence` fails
    for default rows, explicit disable, config/runtime/history evidence, Pi and
    retired OpenClaw/Hermes fixtures.
  - GREEN: Implement the one-time transaction and migration-complete marker;
    preserve required ordering and histories without accessing the network.
  - Refactor/delete: remove `ensure_defaults` and the seven-row seed after the
    migration tests cover all legacy inputs.
  - Verify: `cargo test -p db legacy_agent_migration`; upgrade an existing test DB.
  - Files: migration, DB migration service/tests, old `agent_setting` removal.

- [x] B3. Migrate conversation references and retired identities.
  - RED: `cargo test -p db retired_agent_history_is_read_only_but_retrievable`
    fails for legacy OpenClaw/Hermes and a generic migrated conversation.
  - GREEN: Move conversation/delegation references to `AgentId`, retain version
    provenance, and introduce a read-only retired binding.
  - Refactor/delete: delete closed-type casts from conversation persistence.
  - Verify: `cargo test -p db conversation_agent`; `cargo test -p agents history`.
  - Files: conversation models/migrations, API DTOs, migration tests.

## Phase C — Catalog, Registry, Profiles, and probes

- [x] C1. Add bundled Built-in Profiles and explicit Registry bindings.
  - RED: `cargo test -p agents built_in_profiles_are_declarative_and_bind_explicitly`
    fails for the four built-ins, an unbound similar Registry name, and a renamed
    binding.
  - GREEN: Implement profile data, platform/topology/hash/config declarations,
    icons and Registry binding resolver.
  - Refactor/delete: delete hard-coded product Agent registry matches; profiles
    contain no JSX, command string override, or login runner.
  - Verify: `cargo test -p agents built_in_profile`.
  - Files: `crates/agents/src/{profiles,catalog}.rs`, profile fixtures/tests.

- [x] C2. Implement official Registry snapshot fetch/cache/validation.
  - RED: `cargo test -p agents registry_cache_keeps_last_valid_snapshot_on_invalid_refresh`
    fails for first fetch, 24-hour freshness, malformed response, offline empty
    state, add-version locking, and SVG sanitization fixtures.
  - GREEN: Implement exact official endpoint client, schema validation, atomic
    snapshot replacement, freshness calculation and view projections.
  - Refactor/delete: no custom URL/settings/PATH discovery API.
  - Verify: `cargo test -p agents registry`; snapshot repository tests.
  - Files: `crates/agents/src/{registry,registry_client,catalog}.rs`, DB adapter, tests.

- [x] C3. Implement management snapshot and read-only probe state machine.
  - RED: `cargo test -p agents management_snapshot_has_status_precedence` fails
    for disabled-ready, needs-auth, repair, operation, unsupported and retired
    combinations.
  - GREEN: Add `ProbeService` and state reducer; built-ins proactively inspect
    only profile candidates and attach verified external Runtime only after all
    required checks pass.
  - Refactor/delete: remove old `installed` heuristics based on PATH/npm/login
    marker and old global catalog warming from selectors.
  - Verify: `cargo test -p agents probe preflight`; property test state precedence.
  - Files: `crates/agents/src/{state,probe,local_detection,preflight}.rs`, tests.

## Phase D — locks, installation, configuration, lifecycle

- [x] D1. Implement deterministic installation planning and trust verification.
  - RED: `cargo test -p agents planner_locks_distribution_version_platform_and_trust`
    fails for Binary/npx/uvx precedence, unsupported platform, Profile choice,
    TOFU change, hash mismatch and version-evidence conflict fixtures.
  - GREEN: Implement the pure planner, Installation lock model, SHA-256 and
    ecosystem-integrity checks.
  - Refactor/delete: remove `latest`, temporary launch, silent fallback and
    unverified global installer behavior.
  - Verify: `cargo test -p agents install_planner integrity distribution`.
  - Files: `crates/agents/src/{distribution,installer,integrity}.rs`, tests.

- [x] D2. Implement bounded orchestration, repair/update/rollback and diagnostics.
  - RED: `cargo test -p agents orchestrator_keeps_membership_on_cancel_failure_or_interrupt`
    fails for two-job cap, per-Agent serialization, shared resource lock,
    staged atomic switch, old-lock rollback and 20-record redaction retention.
  - GREEN: Add asynchronous orchestrator and typed operation events/snapshots.
  - Refactor/delete: remove auto-repair/startup retry and direct UI process calls.
  - Verify: `cargo test -p agents orchestrator`; `cargo test -p db diagnostics`.
  - Files: `crates/agents/src/{installer,operations}.rs`, DB diagnostics, tests.

- [x] D3. Implement installation ownership and destructive-operation gate.
  - RED: `cargo test -p agents uninstall_or_remove_is_blocked_by_live_process`
    fails for active ACP process, in-flight turn, queued/running install, external
    components and shared base Runtime references.
  - GREEN: Add ownership-aware uninstall/remove services returning the exact
    user-facing blocking reason; delete only managed/unreferenced components.
  - Refactor/delete: no implicit cancellation/termination or external mutation.
  - Verify: `cargo test -p agents ownership lifecycle`; DB transaction tests.
  - Files: installer/lifecycle service, DB repository, tests.

- [x] D4. Implement Profile-bound native configuration and authentication status.
  - RED: `cargo test -p agents native_config_preserves_unknown_fields_and_reports_auth_status`
    fails for absent files, atomic create-on-save, multi-file JSON/TOML patches,
    typed Runtime options, official provider credential shapes, secret
    mask/presence, account/API precedence, conflict resolution and
    next-session-only effects.
  - GREEN: Implement version-aware configuration providers with
    read/patch/reread, explicit field-conflict DTOs, and unknown-field
    preservation across every Profile-declared official file.
  - Refactor/delete: remove hard-coded React configuration maps, env JSON mirrors,
    raw config editors, browser/CLI login/logout commands and ACP persistent writes.
  - Verify: `cargo test -p agents config`; native file fixtures; redaction tests.
  - Files: `crates/agents/src/{profiles,native_config}.rs`, Tauri projection,
    local provider adapter, tests.

- [x] D5. Gate ACP session creation/turns with management locks and defaults.
  - RED: `cargo test -p agents session_gate_rejects_disabled_not_ready_and_retired_agents`
    fails for enabled-ready, disabled, needs-auth, repair, unsupported, retired,
    stale option and session-rebind cases.
  - GREEN: Resolve absolute launch plans from current locks, enforce eligibility,
    persist per-turn Runtime versions, and apply only advertised new-session options.
  - Refactor/delete: eliminate any live lookup of static Registry or AgentKind in
    runtime launch/session commands.
  - Verify: `cargo test -p agents session runtime`; fixture ACP integration tests.
  - Files: runtime/session/manager/event modules, tests.

## Phase E — Tauri API, generated types, and frontend state

- [x] E1. Add typed management commands and management events.
  - RED: `cargo test -p vibex agent_management_commands_serialize_snapshots_and_errors`
    fails for Registry view, add/install, preflight, repair, config conflict,
    remove block and operation events.
  - GREEN: Register thin commands over `AgentManagementService`; map only typed
    domain errors and emit sequenced events.
  - Refactor/delete: remove old `agent_settings` command surface and hard-coded
    installer actions; do not retain aliases.
  - Verify: `cargo test -p vibex agent_management`; `pnpm run generate-types:check`.
  - Files: `src-tauri/src/commands/agent_management.rs`, registration, DTO exports/tests.

- [x] E2. Replace frontend static Agent data/API with management feature state.
  - RED: `pnpm --dir frontend exec vitest run src/features/agent-management/agentManagementStore.test.ts`
    fails for event reduction, optimistic add, refresh merge, operation state and
    snapshot invalidation.
  - GREEN: Add typed IPC client/query hooks/event reducer; remove static
    `constants/agents.ts`, `useSelectableAgents` closed joins and type mappings.
  - Refactor/delete: no stringly fallback list or client-side status policy.
  - Verify: focused Vitest suite; `pnpm run frontend:check`.
  - Files: `frontend/src/features/agent-management/**`, obsolete feature files/tests.

## Phase F — Settings UI vertical slices

- [x] F1. Deliver the accessible Agent bar.
  - RED: `pnpm --dir frontend exec vitest run src/pages/settings/AgentBar.test.tsx`
    fails for four default icons, generic insertion before sticky `+`, drag/button
    reorder, distributed horizontal spacing, scroll/focus behavior,
    state badge/disabled overlay and aria labels.
  - GREEN: Build the tokenized bar and persist order through management commands.
  - Refactor/delete: remove static horizontal list and closed Agent icon mapping.
  - Verify: focused Vitest; keyboard-only manual check in light/dark/reduced motion.
  - Files: Agent bar component/test, Agent settings composition, styles.

- [x] F2. Deliver the inline Registry view.
  - RED: `pnpm --dir frontend exec vitest run src/pages/settings/AgentRegistryView.test.tsx`
    fails for `+` navigation, tabs/sorting, search/disclosure, cached-first refresh,
    compact installation status, single-surface search, failure/empty state,
    unsupported row, add-and-install selection and delisted retained Agent behavior.
  - GREEN: Implement opaque grouped rows, tabs and retained view state.
  - Refactor/delete: remove modal/card-grid/static Registry UI.
  - Verify: focused Vitest; visual review against `DESIGN.md` in both themes.
  - Files: Registry components/tests, settings route state, styles/i18n.

- [x] F3. Deliver the universal Agent detail and preflight/operations UI.
  - RED: `pnpm --dir frontend exec vitest run src/pages/settings/AgentDetail.test.tsx`
    fails for state-driven sections, read-only check, explicit repair, Toast
    behavior, install progress, summary-header update/uninstall controls,
    disabled state and live-process block.
  - GREEN: Build shared sections from management snapshot/capability DTOs.
  - Refactor/delete: delete per-Agent settings branching and auto-fix control.
  - Verify: focused Vitest; `pnpm run frontend:lint`.
  - Files: detail components/tests, current `AgentSettings` replacement, i18n.

- [x] F4. Deliver configuration, diagnostics and session-picker integration.
  - RED: `pnpm --dir frontend exec vitest run src/pages/settings/AgentConfigurationAndDiagnostics.test.tsx`
    fails for description-free fields, page-level save/discard, staged removal,
    exact file previews, masked credential sources, unavailable generic config
    and disabled/not-ready picker gates.
  - GREEN: Render only DTO-declared fields plus the exact read-only file source;
    update the composer/session picker to consume management eligibility.
  - Refactor/delete: delete `AgentConfigManager`, environment/raw-editor UI and
    stale selector/install affordances; keep diagnostics as export-only.
  - Verify: focused Vitest; `pnpm run frontend:check`.
  - Files: config/diagnostics components/tests, picker/composer integration.

## Phase G — cutover, deletion, and release evidence

- [x] G1. Perform the product cutover and remove closed management paths.
  - RED: static gates fail while the old enum, seed and static frontend list are
    still reachable: `rg 'AgentKind::ALL|DEFAULT_AGENT_SETTINGS|SELECTABLE_AGENTS|AgentConfigManager' crates src-tauri frontend/src`.
  - GREEN: Switch all settings/session eligibility entry points to management
    snapshots and remove the obsolete implementations and their architecture-only tests.
  - Refactor/delete: legacy parser remains only in migration/history code; verify
    no product command accepts an enum-only Agent type.
  - Verify: static gates have only explicitly documented migration/history hits;
    `pnpm run generate-types:check`.
  - Files: deleted legacy modules plus call sites exposed by compiler.

- [x] G2. Run integration, visual, migration and real-agent release gates.
  - RED: run the full suite before final cleanup and record every unrelated
    baseline failure separately; do not weaken assertions to obtain green.
  - GREEN: resolve feature-caused failures, regenerate types/SQLx metadata, and
    capture test fixtures/screenshots.
  - Verify:
    - `cargo fmt --all`
    - `pnpm run generate-types && pnpm run generate-types:check`
    - `pnpm run prepare-db && pnpm run prepare-db:check`
    - `cargo test -p api-types && cargo test -p db && cargo test -p agents && cargo test -p vibex`
    - `pnpm --dir frontend exec vitest run src/features/agent-management src/pages/settings`
    - `pnpm run check && pnpm run lint && cargo test --workspace`
    - Manual: fresh install; migrated legacy database; offline cached Registry;
      built-in external detection; generic add/install/cancel/repair/update;
      active-process uninstall block; disabled Agent session rejection; API Key
      config conflict; real Codex/Claude Code/OpenCode/Pi ACP handshake and one
      generic Registry Agent on each supported distribution where available.
  - Files: release notes, generated files, any remaining feature regressions.

## Completion evidence

The phase is complete only when every task's focused red-green test is retained,
the cutover deletion gates pass, generated types/SQLx metadata are current, and
the manual scenarios in G2 demonstrate the actual local Runtime + ACP path. A
passing UI mock without the installation-lock/runtime fixture coverage is not
completion.
