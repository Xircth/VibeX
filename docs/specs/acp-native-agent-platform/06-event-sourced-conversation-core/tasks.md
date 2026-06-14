# Tasks: ACP Event-Sourced Conversation Core

## Execution Rules

- Implement in order. Later tasks assume earlier contracts exist.
- After each task, review the task acceptance criteria before moving on.
- Do not preserve the old transcript-reparse path as a live compatibility
  feature.
- Adopt Codeg runtime hardening patterns only where they support the
  event-sourced architecture. Do not adopt Codeg's transcript-as-history model.
- Keep `codeg-comparison-adoption.md` as the reference checklist for runtime
  event coverage, prompt locking, spawn locking, session load/new behavior, and
  live replay transport.
- Do not change more than roughly five source files in one task. If a task grows,
  split it before implementation.
- Regenerate SQLx and TypeScript types after schema or exported DTO changes.

## Phase 0: Cutover Preparation

- [x] Task 0.1: Freeze the old live transcript path as deprecated in docs
  - Acceptance: Existing ACP-native spec README names Phase 06 as the canonical
    conversation core and states that Agent transcript files are import-only.
  - Verify: `rg -n "06-event-sourced|transcript.*import-only|canonical conversation" docs/specs/acp-native-agent-platform`
  - Files: `docs/specs/acp-native-agent-platform/README.md`

- [x] Task 0.2: Inventory deletion targets
  - Acceptance: A short deletion map lists every old path that must disappear or
    become import-only: transcript detail loading, frontend live-message bridge,
    legacy event folding, provider runtime conversation adapters.
  - Verify: `rg -n "parsers::loader|ConversationRuntimeContext|buildLiveMessageFromEvents|ExecutionProcess" docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/deletion-map.md`

- [x] Task 0.3: Define projection fixture format
  - Acceptance: A fixture format is documented for event-log input and projected
    timeline output, including message, reasoning, plan, tool, permission,
    terminal, usage, file-change, and error cases.
  - Verify: Inspect fixture schema examples in the document.
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/projection-fixtures.md`

- [x] Task 0.4: Phase 0 completeness review
  - Acceptance: Review confirms no implementation has started, all breaking
    assumptions are visible, and the Codeg adoption decision is linked as a
    runtime reference only.
  - Verify: Review document links to `requirements.md`, `design.md`, and
    `tasks.md`, plus `codeg-comparison-adoption.md`.
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase0-review.md`

## Phase 1: Database Foundation

- [x] Task 1.1: Add canonical conversation schema migration
  - Acceptance: Migration creates or replaces logical tables for conversations,
    agent bindings, turns, events, tool calls, file changes, permissions,
    terminals, attachments, checkpoints, imports, and exports.
  - Verify: `pnpm run prepare-db`
  - Files: `crates/db/migrations/<timestamp>_event_sourced_conversation_core.sql`

- [x] Task 1.2: Add conversation identity and binding models
  - Acceptance: `ConversationRecord`, `ConversationAgentBindingRecord`, create,
    find, update-status, and bind-ACP-session queries compile.
  - Verify: `cargo test -p db conversation_identity`
  - Files: `crates/db/src/models/conversation.rs`, `crates/db/src/models/mod.rs`

- [x] Task 1.3: Add turn model
  - Acceptance: `ConversationTurnRecord` supports create pending turn, mark
    queued/running/blocked/completed/failed/cancelled, and ordinal lookup.
  - Verify: `cargo test -p db conversation_turn`
  - Files: `crates/db/src/models/conversation_turn.rs`, `crates/db/src/models/mod.rs`

- [x] Task 1.4: Add append-only event model
  - Acceptance: `ConversationEventRecord` and `append_conversation_event` allocate
    per-conversation sequence and store normalized/raw JSON.
  - Verify: `cargo test -p db conversation_event`
  - Files: `crates/db/src/models/conversation_event.rs`, `crates/db/src/models/mod.rs`

- [x] Task 1.5: Add state tables for tool calls, permissions, terminals, and files
  - Acceptance: Upsert/list methods exist for tool calls, permission requests,
    terminal summaries, and file change summaries.
  - Verify: `cargo test -p db conversation_state_tables`
  - Files: `crates/db/src/models/conversation_tool.rs`, `crates/db/src/models/conversation_side_effects.rs`, `crates/db/src/models/mod.rs`

- [x] Task 1.6: Add import/export metadata models
  - Acceptance: Bundle import/export records can be inserted, listed, and linked
    to conversation ids.
  - Verify: `cargo test -p db conversation_import_export`
  - Files: `crates/db/src/models/conversation_bundle.rs`, `crates/db/src/models/mod.rs`

- [x] Task 1.7: Regenerate DB cache
  - Acceptance: SQLx cache matches the new schema.
  - Verify: `pnpm run prepare-db:check`
  - Files: `crates/db/.sqlx/*`

- [x] Task 1.8: Phase 1 completeness review
  - Acceptance: Review confirms no conversation detail query depends on Agent
    transcript files for canonical data.
  - Verify: `rg -n "transcript|parsers::loader|external_session_id" crates/db/src/models`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase1-review.md`

## Phase 2: Shared Domain Types

- [x] Task 2.1: Define `ConversationEvent` DTOs
  - Acceptance: Rust DTOs cover all normalized event kinds from `design.md` and
    export through `ts-rs`.
  - Verify: `pnpm run generate-types`
  - Files: `crates/agents/src/conversation.rs`, `src-tauri/src/bin/generate_types.rs`

- [x] Task 2.2: Define `ConversationTimeline` DTOs
  - Acceptance: Timeline row types represent message turns, permissions,
    terminal summaries, file-change summaries, errors, and session notices.
  - Verify: `pnpm run generate-types:check`
  - Files: `crates/agents/src/conversation.rs`, `src-tauri/src/bin/generate_types.rs`, `shared/types.ts`

- [x] Task 2.3: Extend ACP capability snapshot types
  - Acceptance: Capability snapshot includes protocol version, prompt block
    support, session load/resume/close, terminal, additional directories, MCP,
    modes, config options, and commands.
  - Verify: `cargo test -p agents capability_snapshot`
  - Files: `crates/agents/src/events.rs`, `crates/agents/src/conversation.rs`

- [x] Task 2.4: Define portable bundle DTOs
  - Acceptance: Export/import manifest and bundle payload DTOs exist and are
    versioned.
  - Verify: `pnpm run generate-types:check`
  - Files: `crates/agents/src/conversation.rs`, `src-tauri/src/bin/generate_types.rs`, `shared/types.ts`

- [x] Task 2.5: Map Codeg ACP event coverage to `ConversationEvent`
  - Acceptance: Normalized DTOs cover Codeg-equivalent content, thinking, tool
    update, permission, question, feedback, plan, usage, mode, config, prompt
    capability, fork support, command, delegation, config-stale,
    session-load-failed, and error cases.
  - Verify: `rg -n "QuestionRequested|FeedbackRequested|DelegationStarted|SessionConfigStale|PromptCapabilitiesUpdated|ForkSupportUpdated|AgentBindingLoadFailed" crates/agents src-tauri shared/types.ts`
  - Files: `crates/agents/src/conversation.rs`, `crates/agents/src/events.rs`, `src-tauri/src/bin/generate_types.rs`, `shared/types.ts`

- [x] Task 2.6: Phase 2 completeness review
  - Acceptance: Review confirms frontend can import all conversation DTOs from
    generated shared types without hand-written duplicates, and event coverage
    matches `codeg-comparison-adoption.md`.
  - Verify: `rg -n "ConversationEvent|ConversationTimeline|ConversationBundle" shared/types.ts frontend/src`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase2-review.md`

## Phase 3: Conversation Event Appender and Projector

- [x] Task 3.1: Implement event appender service
  - Acceptance: Appender inserts event and updates sequence in one transaction;
    duplicate idempotency keys do not create duplicate visible events.
  - Verify: `cargo test -p db conversation_event_appender`
  - Files: `crates/db/src/models/conversation_event.rs`, `crates/db/src/models/conversation_projection.rs`

- [x] Task 3.2: Implement turn state updater
  - Acceptance: User turn creation and terminal state updates are driven by
    conversation events.
  - Verify: `cargo test -p db conversation_turn_state`
  - Files: `crates/db/src/models/conversation_turn.rs`, `crates/db/src/models/conversation_event.rs`

- [x] Task 3.3: Implement tool call upsert projection
  - Acceptance: `ToolCallUpsert` updates by `tool_call_id`, preserves raw input,
    raw output, content, locations, and status.
  - Verify: `cargo test -p db conversation_tool_projection`
  - Files: `crates/db/src/models/conversation_tool.rs`, `crates/db/src/models/conversation_projection.rs`

- [x] Task 3.4: Implement permission and terminal projection
  - Acceptance: Permission requests/responses and terminal updates project into
    state tables and timeline rows.
  - Verify: `cargo test -p db conversation_side_effect_projection`
  - Files: `crates/db/src/models/conversation_side_effects.rs`, `crates/db/src/models/conversation_projection.rs`

- [x] Task 3.5: Implement message and reasoning timeline projection
  - Acceptance: Text deltas, reasoning deltas, plan snapshots, tool calls, and
    completion events fold into stable `ConversationTimelineRow` values.
  - Verify: `cargo test -p db conversation_timeline_projection`
  - Files: `crates/db/src/models/conversation_projection.rs`, `crates/db/tests/conversation_projection.rs`

- [x] Task 3.6: Add projection fixtures
  - Acceptance: Fixtures cover happy path, no assistant output error path,
    permission-blocked path, tool-heavy path, terminal path, and file-change
    path.
  - Verify: `cargo test -p db conversation_projection_fixtures`
  - Files: `crates/db/fixtures/conversation-projection/*.json`, `crates/db/tests/conversation_projection.rs`

- [x] Task 3.7: Phase 3 completeness review
  - Acceptance: Review confirms a timeline can be rebuilt from DB events alone.
  - Verify: Delete/rename fixture raw transcript files and confirm projector
    tests still pass.
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase3-review.md`

## Phase 4: ACP Runtime Integration

- [x] Task 4.1: Add conversation service boundary
  - Acceptance: `ConversationSessionService` owns start-turn, ensure-binding,
    append-runtime-event, cancel-turn, respond-permission, recovery methods, and
    a Codeg-style live runtime snapshot for active conversation state.
  - Verify: `cargo check`
  - Files: `src-tauri/src/conversation_service.rs`, `src-tauri/src/lib.rs`

- [x] Task 4.2: Replace `agent_send_workspace_prompt` public path
  - Acceptance: Frontend-facing send command becomes `conversation_start_turn`;
    it creates a turn before ACP send, serializes prompt dispatch with a
    per-conversation prompt lock, rejects empty prompts before side effects, and
    returns a turn snapshot.
  - Verify: `cargo test --workspace conversation_start_turn`
  - Files: `src-tauri/src/commands/conversations.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/lib.rs`

- [x] Task 4.3: Correct ACP session identity and spawn de-duplication
  - Acceptance: Local conversation id is never passed as ACP session id; actual
    ACP `session_id` is stored only after `session/new/load/resume`; ACP process
    startup uses spawn locks and a handshake timeout.
  - Verify: `cargo test -p agents acp_session_identity`
  - Files: `crates/agents/src/runtime.rs`, `crates/agents/src/manager.rs`

- [x] Task 4.4: Persist initialize and session capabilities
  - Acceptance: Initialize response and session setup controls are captured into
    `conversation_agent_bindings`, including prompt capabilities, fork support,
    modes, config options, available commands, and config-stale state.
  - Verify: `cargo test --workspace conversation_capabilities`
  - Files: `crates/agents/src/manager.rs`, `src-tauri/src/conversation_service.rs`, `crates/db/src/models/conversation.rs`

- [x] Task 4.5: Convert ACP notifications to conversation events
  - Acceptance: message chunks, thought chunks, plan, tool call/update, usage,
    modes, config, commands, questions, feedback, delegation, diagnostics,
    config-stale notices, session-load failures, and errors append normalized
    conversation events.
  - Verify: `cargo test -p agents acp_notification_mapping`
  - Files: `crates/agents/src/manager.rs`, `crates/agents/src/events.rs`, `src-tauri/src/conversation_service.rs`

- [x] Task 4.6: Convert host requests to conversation events
  - Acceptance: permission requests, permission responses, terminal lifecycle,
    terminal output summaries, and file IO diagnostics append events.
  - Verify: `cargo test -p agents acp_host_request_mapping`
  - Files: `crates/agents/src/permissions.rs`, `crates/agents/src/terminal.rs`, `src-tauri/src/conversation_service.rs`

- [x] Task 4.7: Guarantee visible terminal events for failed sends
  - Acceptance: spawn failure, handshake timeout, command channel closed,
    `session/load` resource not found, authentication required,
    `session/prompt` error, process exit, in-flight rejection, and cancellation
    all create visible `TurnFailed`, `TurnCancelled`, `TurnBlocked`, or session
    recovery events.
  - Verify: `cargo test -p agents failed_prompt_emits_terminal_event`
  - Files: `crates/agents/src/runtime.rs`, `crates/agents/src/manager.rs`, `src-tauri/src/conversation_service.rs`

- [x] Task 4.8: Implement checkpoint diff finalization
  - Acceptance: Before/after workspace snapshots generate
    `FileChangeSummaryUpdated` and persist `conversation_file_changes`.
  - Verify: `cargo test --workspace conversation_checkpoint_file_changes`
  - Files: `src-tauri/src/conversation_service.rs`, `crates/db/src/models/conversation_side_effects.rs`, `crates/local-deployment/src/container.rs`

- [x] Task 4.9: Phase 4 completeness review
  - Acceptance: Review traces one prompt from command to ACP bridge to event
    append to projection, including prompt lock, spawn lock, session recovery,
    in-flight protection, and error path.
  - Verify: `rg -n "conversation_start_turn|TurnFailed|FileChangeSummaryUpdated|turn_in_flight|spawn_lock|AgentBindingLoadFailed" src-tauri crates`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase4-review.md`

## Phase 5: Tauri Conversation API and Event Transport

- [x] Task 5.1: Implement `conversation_detail`
  - Acceptance: Detail returns summary, active binding, projected timeline,
    current turn state, session stats, and projection version from DB events.
  - Verify: `cargo test --workspace conversation_detail_projection`
  - Files: `src-tauri/src/commands/conversations.rs`, `crates/db/src/models/conversation_projection.rs`

- [x] Task 5.2: Implement event paging APIs
  - Acceptance: `conversation_events_since` and `conversation_timeline_page`
    support sequence-based gap recovery and pagination.
  - Verify: `cargo test --workspace conversation_event_paging`
  - Files: `src-tauri/src/commands/conversations.rs`, `crates/db/src/models/conversation_event.rs`

- [x] Task 5.3: Add `conversation-events` Tauri channel
  - Acceptance: Persisted `ConversationEventEnvelope` is emitted after append;
    frontend can ignore runtime-only `agent-events` for conversation history;
    active conversations support snapshot attach, bounded recent-event replay,
    and durable fallback via `conversation_events_since`.
  - Verify: frontend event runtime tests or `cargo test --workspace conversation_event_channel`
  - Files: `src-tauri/src/events.rs`, `src-tauri/src/conversation_service.rs`, `frontend/src/features/conversation/events.ts`

- [x] Task 5.4: Implement conversation permission command
  - Acceptance: Permission response updates ACP bridge and appends
    `PermissionResponded`.
  - Verify: `cargo test --workspace conversation_permission_response`
  - Files: `src-tauri/src/commands/conversations.rs`, `src-tauri/src/conversation_service.rs`

- [x] Task 5.5: Implement conversation cancel and close commands
  - Acceptance: Cancel marks active turn cancelled; close uses ACP close support
    when available and records degraded behavior when unavailable.
  - Verify: `cargo test --workspace conversation_cancel_close`
  - Files: `src-tauri/src/commands/conversations.rs`, `src-tauri/src/conversation_service.rs`, `crates/agents/src/runtime.rs`

- [x] Task 5.6: Regenerate shared types
  - Acceptance: `shared/types.ts` contains conversation commands/events/timeline
    DTOs and no hand-written frontend duplicates are needed.
  - Verify: `pnpm run generate-types:check`
  - Files: `shared/types.ts`

- [x] Task 5.7: Phase 5 completeness review
  - Acceptance: Review confirms all public frontend conversation reads use the
    new Tauri API, and live event transport can recover old cursors through the
    durable event log.
  - Verify: `rg -n "conversation_detail|conversation_events_since|agent_send_workspace_prompt|agent-events|recent_events" frontend/src src-tauri/src`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase5-review.md`

## Phase 6: Frontend Store and Rendering

- [x] Task 6.1: Add frontend conversation API wrapper
  - Acceptance: `conversationApi` wraps create, startTurn, detail, eventsSince,
    timelinePage, cancel, permission, export, and import commands.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation/conversationApi.test.ts`
  - Files: `frontend/src/features/conversation/conversationApi.ts`, `frontend/src/features/conversation/conversationApi.test.ts`

- [x] Task 6.2: Add conversation realtime subscription
  - Acceptance: `conversation-events` listener returns typed unsubscribe and
    does not depend on `agent-events`.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation/events.test.ts`
  - Files: `frontend/src/features/conversation/events.ts`, `frontend/src/features/conversation/events.test.ts`

- [x] Task 6.3: Implement conversation timeline store
  - Acceptance: Store hydrates detail, applies ordered events, detects sequence
    gaps, requests gap fill, and reconciles optimistic turns.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation/conversationStore.test.ts`
  - Files: `frontend/src/features/conversation/conversationStore.ts`, `frontend/src/features/conversation/conversationStore.test.ts`

- [x] Task 6.4: Implement `useConversationTimeline`
  - Acceptance: Hook loads detail, subscribes to events, exposes timeline rows,
    active turn, pending permissions, send/cancel/respond actions, and error
    state.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation/UseConversationTimeline.test.tsx`
  - Files: `frontend/src/features/conversation/useConversationTimeline.ts`, `frontend/src/features/conversation/UseConversationTimeline.test.tsx`

- [x] Task 6.5: Switch follow-up send to `conversation_start_turn`
  - Acceptance: `useFollowUpSend` and `sendAgentRuntimeTurn` no longer call
    `agent_send_workspace_prompt`; optimistic user turn uses returned `turn_id`.
  - Verify: `cd frontend; pnpm exec vitest run src/features/agents/sendAgentRuntimeTurn.test.ts src/hooks/useFollowUpSend.test.tsx`
  - Files: `frontend/src/features/agents/sendAgentRuntimeTurn.ts`, `frontend/src/hooks/useFollowUpSend.ts`

- [x] Task 6.6: Replace `AgentTimelineConversation` data source
  - Acceptance: Conversation view renders `ConversationTimelineRow[]` from
    `useConversationTimeline`; no transcript/live merge bridge is mounted.
  - Verify: `cd frontend; pnpm exec vitest run src/components/logs/AgentTimelineConversation.test.tsx`
  - Files: `frontend/src/components/logs/AgentTimelineConversation.tsx`, `frontend/src/features/conversation/useConversationTimeline.ts`

- [x] Task 6.7: Adapt renderer to canonical timeline rows
  - Acceptance: Message, reasoning, plan, tool call, permission, terminal,
    question, feedback, delegation, file-change, usage, config-stale,
    session-load-failed, and error rows render through stable components.
  - Verify: `cd frontend; pnpm exec vitest run src/components/NormalizedConversation`
  - Files: `frontend/src/components/NormalizedConversation/MessageTurnView.tsx`, `frontend/src/components/NormalizedConversation/tools/*`

- [x] Task 6.8: Remove frontend live-message bridge
  - Acceptance: `ConversationRuntimeContext`, `useConversationRuntimeBridge`,
    and `liveMessage` are deleted or test-only fixtures no longer imported by
    product code.
  - Verify: `rg -n "ConversationRuntimeContext|useConversationRuntimeBridge|buildLiveMessageFromEvents|liveMessage" frontend/src`
  - Files: `frontend/src/features/agents/ConversationRuntimeContext.tsx`, `frontend/src/features/agents/useConversationRuntimeBridge.ts`, `frontend/src/features/agents/liveMessage.ts`

- [x] Task 6.9: Add frontend gap recovery and refresh tests
  - Acceptance: Tests cover missed realtime event, refresh during streaming,
    in-flight prompt rejection or queueing, failed turn rendering, session load
    failure rendering, and import-restored timeline.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation`
  - Files: `frontend/src/features/conversation/*.test.ts`, `frontend/src/components/logs/*.test.tsx`

- [x] Task 6.10: Phase 6 completeness review
  - Acceptance: Review confirms frontend conversation rendering consumes
    canonical DTOs only and follows the Tahoe/macOS design constraints.
  - Verify: `pnpm run frontend:check`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase6-review.md`

## Phase 7: Import, Export, and Backup

- [x] Task 7.1: Implement VibeX bundle export backend
  - Acceptance: Export writes manifest, conversations, bindings, turns, events,
    tool calls, file changes, permissions, terminals, attachments, and checkpoint
    metadata, including capability snapshots and recovery/session notices.
  - Verify: `cargo test --workspace conversation_bundle_export`
  - Files: `src-tauri/src/commands/conversations.rs`, `src-tauri/src/conversation_bundle.rs`, `crates/db/src/models/conversation_bundle.rs`

- [x] Task 7.2: Implement VibeX bundle import backend
  - Acceptance: Import restores a renderable conversation with new ids and
    validates projection equivalence.
  - Verify: `cargo test --workspace conversation_bundle_import`
  - Files: `src-tauri/src/conversation_bundle.rs`, `crates/db/src/models/conversation_bundle.rs`, `crates/db/src/models/conversation_projection.rs`

- [x] Task 7.3: Convert Agent transcript import to synthetic events
  - Acceptance: Existing Agent transcript parsers are reachable only through
    explicit import; imported messages become VibeX conversation events.
  - Verify: `cargo test -p agents history_import_to_conversation_events`
  - Files: `crates/agents/src/parsers/loader.rs`, `src-tauri/src/commands/conversations.rs`, `crates/db/src/models/conversation_event.rs`

- [x] Task 7.4: Add frontend import/export controls
  - Acceptance: Settings/system backup or conversation menu can export/import
    VibeX bundles and display import result.
  - Verify: `cd frontend; pnpm exec vitest run src/features/conversation/ConversationBundle.test.tsx`
  - Files: `frontend/src/features/conversation/ConversationBundle.tsx`, `frontend/src/pages/settings/SystemSettings.tsx`

- [x] Task 7.5: Phase 7 completeness review
  - Acceptance: Review confirms a bundle import works without external Agent
    transcript files.
  - Verify: Manual export/import fixture plus `cargo test --workspace conversation_bundle`
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/phase7-review.md`

## Phase 8: Legacy Removal and Verification

- [x] Task 8.1: Remove backend transcript detail dependency
  - Acceptance: `conversation_detail` no longer imports or calls
    `agents::parsers::loader`.
  - Verify: `rg -n "parsers::loader|load_conversation_detail|load_transcript" src-tauri crates/db crates/agents`
  - Files: `src-tauri/src/commands/conversations.rs`, `crates/db/src/models/conversation.rs`

- [x] Task 8.2: Remove old runtime event history assumptions
  - Acceptance: `agent_events` is debug/runtime history only; product
    conversation detail uses `conversation_events`.
  - Verify: `rg -n "agent_events" src-tauri crates/db frontend/src`
  - Files: `crates/db/src/models/agent_runtime.rs`, `src-tauri/src/events.rs`

- [x] Task 8.3: Remove old frontend imports
  - Acceptance: No product file imports deleted live-message bridge modules.
  - Verify: `pnpm run frontend:check`
  - Files: `frontend/src/features/agents/*`, `frontend/src/components/logs/AgentTimelineConversation.tsx`

- [x] Task 8.4: Remove stale generated types and tests
  - Acceptance: `shared/types.ts` and tests no longer expose old detail model
    comments or bridge-only types.
  - Verify: `pnpm run generate-types:check && cd frontend; pnpm exec vitest run`
  - Files: `shared/types.ts`, `frontend/src/features/agents/*.test.ts`, `frontend/src/features/conversation/*.test.ts`

- [x] Task 8.5: End-to-end no-response regression fixture
  - Acceptance: Fake ACP cases prove message output, no-output failure, command
    channel close, handshake timeout, and process exit all render visible rows.
  - Verify: `cargo test -p agents no_response_regressions && cd frontend; pnpm exec vitest run src/features/conversation/noResponseRegression.test.ts`
  - Files: `crates/agents/src/runtime.rs`, `crates/agents/src/manager.rs`, `frontend/src/features/conversation/noResponseRegression.test.ts`

- [x] Task 8.6: Full verification gate
  - Acceptance: All planned checks pass or failures are documented with owner and
    reason.
  - Verify:
    ```powershell
    pnpm run prepare-db:check
    pnpm run generate-types:check
    pnpm run frontend:check
    pnpm run frontend:lint
    pnpm run backend:check
    pnpm run backend:lint
    cargo test -p db
    cargo test -p agents
    cargo test --workspace
    cd frontend; pnpm exec vitest run
    ```
  - Files: no source files; verification only

- [x] Task 8.7: Final closure review
  - Acceptance: Closure review maps every requirement R1-R10 to implemented
    files, tests, and remaining known risks.
  - Verify: Review document exists and links all phase reviews.
  - Files: `docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core/final-closure-review.md`
