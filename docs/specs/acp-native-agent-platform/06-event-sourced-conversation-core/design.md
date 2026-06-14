# Design: ACP Event-Sourced Conversation Core

## Current Failure Shape

The current architecture splits one conversation across three truth sources:

1. runtime events in `AgentRuntime` and `agent_events`;
2. metadata on the product `sessions` row;
3. transcript turns re-parsed from an Agent CLI session file by
   `parsers::loader`.

That makes a failed or missing Agent transcript indistinguishable from a real
empty conversation. It also means frontend code must merge cold history and live
events, and any gap in that merge can produce the observed "message sent, no
reply" state.

The refactor replaces that split with one source of truth:

```text
ACP process
  -> crates/agents ACP bridge
  -> normalized AgentRuntime event
  -> ConversationEventAppender
  -> SQLite conversation event log
  -> ConversationProjector
  -> Tauri detail/page/events APIs
  -> frontend timeline store
  -> NormalizedConversation renderer
```

Realtime Tauri events and frontend optimistic state are performance features.
They are not history truth.

## Codeg Comparison Update

The implementation plan is now explicitly hybrid:

```text
VibeX-owned event log and projector
  = canonical history, import/export source, cold-open source

Codeg-style ACP runtime hardening
  = live connection state, prompt serialization, event coverage, reconnect
    transport, renderer coverage reference
```

Adopt Codeg's runtime mechanisms:

- backend-owned session snapshot for active live state;
- ACP event coverage for content, thinking, tools, permissions, questions,
  feedback, plans, usage, capabilities, config, commands, delegation, and
  errors;
- prompt locks and in-flight turn protection;
- spawn locks and handshake timeout;
- explicit `session/load` / `session/resume` / `session/new` recovery outcomes;
- snapshot plus bounded recent-event replay for live subscribers.

Reject Codeg's completed-history model:

- no `external_id + agent_type` history ownership;
- no transcript parser call from `conversation_detail`;
- no frontend transcript/live merge authority;
- no transcript-only portable export.

See `codeg-comparison-adoption.md` for the reviewed source files and adoption
matrix.

## Domain Model

### Identities

```text
conversation_id
  Product-owned stable id. Used by routes, DB queries, import/export, and UI.

turn_id
  Product-owned id for one user prompt cycle. Created before `session/prompt`.

conversation_event_id
  Product-owned id for one persisted event. Events are append-only.

conversation_sequence
  Monotonic integer scoped to one conversation.

agent_binding_id
  Product-owned id for the current Agent binding.

acp_session_id
  External ACP session id returned by `session/new`, loaded by `session/load`,
  or resumed by `session/resume`.

connection_id
  Runtime-only connection id. Useful for live routing and diagnostics, never
  required to render history.

prompt_id
  Runtime prompt id for one call into the ACP bridge. Usually maps 1:1 to a
  `turn_id`, but remains separate so retries and queue internals are explicit.
```

### Tables

The physical table names may be adjusted during implementation, but these
logical records must exist.

```text
conversations
  id
  workspace_id
  task_id
  title
  title_locked
  status
  active_turn_id
  pinned_at
  parent_conversation_id
  parent_tool_call_id
  created_at
  updated_at
  deleted_at

conversation_agent_bindings
  id
  conversation_id
  agent_type
  working_dir
  acp_session_id
  acp_protocol_version
  load_supported
  resume_supported
  close_supported
  terminal_supported
  additional_directories_supported
  prompt_capabilities_json
  session_capabilities_json
  client_capabilities_json
  mcp_servers_json
  modes_json
  config_options_json
  current_mode
  status
  created_at
  updated_at

conversation_turns
  id
  conversation_id
  ordinal
  prompt_id
  role = user_prompt
  status = pending | queued | running | blocked | completed | failed | cancelled
  text_preview
  input_blocks_json
  stop_reason
  model
  usage_json
  error_json
  started_at
  completed_at
  created_at
  updated_at

conversation_events
  id
  conversation_id
  turn_id
  binding_id
  connection_id
  prompt_id
  sequence
  source = user | acp | host | runtime | system | import
  event_kind
  normalized_json
  raw_json
  idempotency_key
  created_at

conversation_tool_calls
  id
  conversation_id
  turn_id
  tool_call_id
  title
  kind
  status
  raw_input_json
  raw_output_json
  content_json
  locations_json
  created_at
  updated_at

conversation_file_changes
  id
  conversation_id
  turn_id
  source = acp_tool | checkpoint_diff | imported
  path
  change_kind = added | modified | deleted | renamed | unknown
  additions
  deletions
  old_path
  diff_summary_json
  created_at

conversation_permissions
  id
  conversation_id
  turn_id
  permission_id
  title
  details_json
  options_json
  status = pending | responded | cancelled
  response_json
  auto
  created_at
  responded_at

conversation_terminals
  id
  conversation_id
  turn_id
  terminal_id
  command
  args_json
  cwd
  status = created | running | exited | released | failed
  output_summary
  output_truncated
  exit_status_json
  created_at
  updated_at

conversation_attachments
  id
  conversation_id
  turn_id
  kind = image | resource | file | generated_image
  uri
  title
  mime_type
  metadata_json
  created_at

conversation_checkpoints
  id
  conversation_id
  turn_id
  ordinal
  before_snapshot_json
  after_snapshot_json
  diff_summary_json
  created_at
  finalized_at

conversation_imports
  id
  source = vibex_bundle | agent_transcript
  source_agent
  external_session_id
  bundle_version
  raw_source_path
  imported_conversation_id
  raw_json
  imported_at

conversation_exports
  id
  conversation_id
  bundle_version
  destination_path
  manifest_json
  exported_at
```

Existing `agent_connections`, `agent_sessions`, `agent_prompts`, and
`agent_events` may remain as runtime diagnostics, but they must not be the only
storage for conversation history. If retained, they are secondary snapshots.

## Normalized Event Contract

`crates/agents` can keep `AgentEvent` for runtime-level ACP translation. The
product conversation layer introduces `ConversationEvent`.

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationEvent {
    ConversationCreated { title: Option<String> },
    AgentBindingStarted { agent_type: AgentType, working_dir: String },
    AgentBindingReady { acp_session_id: String, capabilities: AcpCapabilitySnapshot },
    AgentBindingRecovered { strategy: SessionRecoveryStrategy },
    AgentBindingRecoveryFailed { reason: String },
    AgentBindingLoadFailed { reason: SessionLoadFailureReason },
    AgentConnectionStatusChanged { status: AgentConnectionStatus },

    UserTurnCreated { blocks: Vec<ConversationInputBlock> },
    UserTurnQueued,
    UserTurnStarted,

    AssistantTextDelta { text: String, message_id: Option<String> },
    AssistantReasoningDelta { text: String, message_id: Option<String> },
    PlanUpdated { entries: Vec<ConversationPlanEntry> },

    ToolCallUpsert { tool_call: ConversationToolCallPatch },
    PermissionRequested { request: ConversationPermissionRequest },
    PermissionResponded { permission_id: String, response: ConversationPermissionResponse },
    QuestionRequested { request: ConversationQuestionRequest },
    QuestionResponded { question_id: String, response: ConversationQuestionResponse },
    FeedbackRequested { request: ConversationFeedbackRequest },
    FeedbackSubmitted { feedback_id: String, response: ConversationFeedbackResponse },
    TerminalUpdated { terminal: ConversationTerminalPatch },

    UsageUpdated { usage: ConversationUsage },
    FileChangeSummaryUpdated { summary: ConversationFileChangeSummary },
    TurnBlocked { reason: TurnBlockedReason },
    TurnCompleted { stop_reason: Option<String> },
    TurnFailed { error: ConversationError },
    TurnCancelled { reason: Option<String> },

    SessionModeUpdated { current: Option<String>, modes: Vec<AgentSessionMode> },
    SessionConfigOptionsUpdated { options: Vec<AgentSessionConfigOption> },
    SessionConfigStale { stale: bool, reason: Option<String> },
    PromptCapabilitiesUpdated { capabilities: AgentPromptCapabilities },
    ForkSupportUpdated { supported: bool },
    AvailableCommandsUpdated { commands: Vec<AgentAvailableCommand> },
    DelegationStarted { delegation: ConversationDelegation },
    DelegationCompleted { delegation_id: String, result: ConversationDelegationResult },

    RawDiagnosticRecorded { label: String },
}
```

Rules:

- Events are append-only.
- Tool call updates are keyed by `tool_call_id`.
- Tool call updates preserve Codeg-equivalent fields: raw input, raw output,
  appended raw output, locations, metadata, images, and status.
- Plan entries are replaced as a snapshot in ACP v1. The internal shape must be
  ready to switch to id-based updates later.
- Message deltas accept optional future `message_id`.
- Questions, feedback, delegation, config-stale, prompt-capability, fork, and
  command updates are first-class events, not debug-only runtime metadata.
- Raw ACP payloads are stored beside normalized events, not embedded into UI DTOs.
- Every failed path appends `TurnFailed` or `AgentBindingRecoveryFailed`.

## Runtime and Session Lifecycle

### New Service Boundary

Add a service layer between Tauri commands and `AgentRuntime`:

```text
ConversationSessionService
  create_conversation
  ensure_agent_binding
  start_turn
  append_runtime_event
  cancel_turn
  respond_permission
  recover_binding
  close_conversation
```

`src-tauri` commands call the service. `AgentRuntime` only handles ACP process
and protocol concerns.

### Codeg-Hardened Runtime Snapshot

The service keeps a backend-owned runtime snapshot for each active conversation
binding. This is modeled after Codeg's live `SessionState`, but it is not the
conversation history source.

```text
ConversationRuntimeState
  conversation_id
  binding_id
  acp_session_id
  connection_id
  active_turn_id
  live_message
  active_tool_calls
  pending_permission
  pending_question
  active_delegations
  modes
  current_mode
  config_options
  prompt_capabilities
  fork_supported
  available_commands
  usage
  event_sequence
  recent_events
  pending_user_message
  turn_in_flight
  config_stale
  connection_status
  recovery_status
```

Rules:

- runtime state may answer live snapshot queries and seed subscribers;
- persisted `conversation_events` rebuild the same user-visible timeline after
  refresh or restart;
- the runtime state is discarded safely when the ACP process exits because all
  user-visible facts have already been appended or are finalized by a failure
  event.

### Prompt Serialization and Spawn Locks

Adopt Codeg's protection around prompt sending:

- use a spawn lock keyed by agent type, working directory, and ACP session or
  conversation identity so concurrent UI actions cannot start duplicate Agent
  processes for the same target;
- apply a bounded ACP startup handshake timeout;
- use a per-conversation prompt lock that covers active-turn check, local turn
  creation or queueing, user event append, binding recovery, and ACP
  `session/prompt` dispatch;
- reject empty prompts before side effects;
- if a turn is already in flight, either create a `queued` local turn or return
  a typed rejection that the UI renders immediately; never send two prompts into
  the same ACP session concurrently;
- append the user turn event before dispatching the ACP prompt so refresh cannot
  lose the user's message;
- on dispatch failure, process exit, closed command channel, cancellation, or
  timeout, append a visible terminal event before releasing the prompt lock.

### Create or Open

```text
conversation_start_turn(input)
  -> create conversation if missing
  -> create local turn with input blocks
  -> checkpoint workspace before send
  -> ensure binding:
       existing ready connection + ACP session map
       else connect + initialize + recover via load/resume/new
  -> append AgentBindingReady or recovery event
  -> send session/prompt
  -> append UserTurnStarted
```

The old pattern `ensure_session(acp_session_id = request.session_id)` is removed.
The local `conversation_id` must never masquerade as the external ACP session id.

### ACP Session Establishment

New conversations:

1. connect and initialize;
2. call `session/new`;
3. persist returned `acp_session_id`;
4. persist modes/config/capabilities;
5. send prompt.

Existing conversations:

1. read the latest binding;
2. connect and initialize;
3. if ACP advertises load support, call `session/load`;
4. else if resume support exists, call `session/resume`;
5. else create a new ACP session and append a recovery warning event;
6. send prompt only after the binding is usable.

Recovery outcomes:

- `ResourceNotFound` from `session/load` appends `AgentBindingLoadFailed` and a
  visible session notice. It must not fall back to "empty transcript" behavior.
- authentication-required results append a blocked/recovery event and stop the
  send path until the user fixes auth.
- unsupported `session/load` or `session/resume` may degrade to `session/new`
  only when initialize capabilities make that path valid.
- if a new ACP session is created for an existing VibeX conversation, persist it
  as a new binding event and keep the existing VibeX timeline intact.
- replay notifications produced during `session/load` are treated as recovery
  diagnostics unless they can be mapped idempotently to existing turn events.

### Prompt Completion

`session/update` events are converted to normalized events immediately. The final
prompt response updates the turn terminal state.

If the ACP process exits, the prompt future errors, the command channel closes,
or initialization fails after the local turn was created, the service appends
`TurnFailed` and the frontend renders it. No send path may end without a
terminal conversation event.

## Event Append and Projection

### Appender

`ConversationEventAppender` owns:

- sequence allocation;
- idempotency keys;
- inserting `conversation_events`;
- updating current tables such as turns, tool calls, permissions, terminals,
  checkpoints, and file changes;
- emitting the persisted `ConversationEventEnvelope` to Tauri.

It should run in a DB transaction when a state table update and event insert
belong to the same fact.

### Projector

`ConversationProjector` folds events into `ConversationTimeline`.

```ts
export type ConversationTimelineRow =
  | { kind: 'message_turn'; turn: MessageTurn; phase: 'settled' | 'streaming' }
  | { kind: 'permission_request'; request: ConversationPermissionView }
  | { kind: 'terminal_summary'; terminal: ConversationTerminalView }
  | { kind: 'file_change_summary'; summary: ConversationFileChangeSummary }
  | { kind: 'turn_error'; error: ConversationErrorView }
  | { kind: 'session_notice'; notice: ConversationSessionNotice };
```

Projection invariants:

- one user turn row per `turn_id`;
- assistant deltas after the latest running turn fold into assistant content;
- reasoning content defaults to folded but is present in data;
- tool calls update in place by `tool_call_id`;
- a completed tool call followed by assistant text can start a new assistant
  display group while remaining in the same `turn_id`;
- usage, model, stop reason, and completion time attach to the turn;
- file changes attach to the turn after checkpoint finalization;
- errors are rows, not banners only.

The projector belongs in Rust first so cold detail and import/export share the
same behavior. Frontend-only helpers may exist for view memoization, but not for
protocol truth.

## Tauri API

Replace or add these commands:

```text
conversation_create(input) -> ConversationSummary
conversation_start_turn(input) -> ConversationTurnSnapshot
conversation_cancel_turn(input) -> void
conversation_respond_permission(input) -> void
conversation_detail(input) -> ConversationDetail
conversation_events_since(input) -> ConversationEventsPage
conversation_timeline_page(input) -> ConversationTimelinePage
conversation_export(input) -> ConversationExportResult
conversation_import(input) -> ConversationImportResult
conversation_reset_to_checkpoint(input) -> void
conversation_close(input) -> void
```

`agent_send_workspace_prompt` can be deleted or reduced to a private wrapper
during the cutover. The public frontend should call conversation commands.

`agent_runtime_snapshot` remains useful for registry, installation, connection,
and debug panels, but not for conversation history rendering.

## Tauri Event Channels

Keep `agent-events` only for runtime/debug surfaces if needed. Introduce:

```text
conversation-events
```

Payload:

```rust
pub struct ConversationEventEnvelope {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub turn_id: Option<Uuid>,
    pub sequence: i64,
    pub source: ConversationEventSource,
    pub event: ConversationEvent,
    pub created_at: DateTime<Utc>,
}
```

Live transport follows the Codeg pattern but with durable fallback:

- each active conversation keeps a bounded recent-event buffer in runtime state;
- each subscriber attaches by receiving a snapshot plus the current event
  sequence;
- cursors inside the recent buffer are replayed from memory;
- old cursors, process restarts, oversized events, and sequence gaps fall back to
  `conversation_events_since`;
- unfillable gaps fall back to `conversation_detail` and backend projection.

Frontend subscription behavior:

1. subscribe to `conversation-events`;
2. load `conversation_detail`;
3. call `conversation_events_since(last_sequence)` if a gap is detected;
4. apply events to local cache only after sequence ordering is valid;
5. fall back to refetch detail if projection version changes or a gap cannot be
   filled.

## Frontend Architecture

### Deleted or Replaced Concepts

- Delete `ConversationRuntimeContext` as a transcript/live merge authority.
- Delete frontend code that derives the latest assistant message by folding raw
  `AgentEventEnvelope[]` after `prompt_started`.
- Delete comments and API assumptions that `conversationDetail` reparses Agent
  transcript files.
- Keep renderer components only if they consume canonical `MessageTurn` or
  `ConversationTimelineRow` DTOs.

### New Store

```text
conversationStore
  summariesByWorkspace
  detailById
  eventsByConversation
  timelineByConversation
  pendingTurnByConversation
  gapStateByConversation
```

Responsibilities:

- optimistic user row immediately after `conversation_start_turn`;
- reconcile optimistic turn with persisted `UserTurnCreated`;
- apply ordered `conversation-events`;
- fetch missing events when sequence gaps appear;
- refetch projection on projector version mismatch;
- expose selectors for timeline rows, permissions, active turn, and errors.

### Rendering

The first screen of a conversation is always a timeline:

- user message rows;
- assistant message rows;
- folded reasoning;
- tool call cards;
- plan card;
- permission card;
- terminal summary;
- file change summary;
- usage/turn stats;
- visible turn error.

Use Codeg's renderer coverage as a checklist for edge cases: optimistic user
turns, active tool calls, tool output append, delegation, permission, question,
feedback, config stale state, and session load failure. The implementation must
not reintroduce Codeg's frontend transcript/live merge authority; these cases
arrive as backend-projected timeline rows.

The styling follows the Tahoe/macOS design convergence already defined for the
app: quiet native panels, compact controls, no marketing cards, no nested cards,
and stable dimensions for streaming rows.

## filesChanged

`filesChanged` is produced by the backend.

```text
before checkpoint
  -> send prompt
  -> ACP tool updates may provide diff/location hints
  -> prompt terminal event
  -> after checkpoint
  -> git/workspace diff
  -> merge tool hints + checkpoint diff
  -> append FileChangeSummaryUpdated
```

Rules:

- checkpoint diff wins when it conflicts with unstructured tool text;
- ACP structured diff can enrich per-file labels and inline snippets;
- file paths are normalized relative to workspace root when possible;
- deleted/renamed files are preserved;
- generated summaries are stored, not recomputed by the frontend on every load.

## Import and Export

### Bundle Format

```text
vibex-conversation-bundle/
  manifest.json
  conversations.json
  bindings.json
  turns.json
  events.jsonl
  tool-calls.json
  file-changes.json
  permissions.json
  terminals.json
  attachments/
  checkpoints/
```

`manifest.json` includes:

- bundle version;
- export app version;
- exported_at;
- source platform;
- conversation ids;
- projection version;
- checksum map.

### Export

Export reads from VibeX tables only. Agent transcript files are not required.

### Import

VibeX bundle import:

- creates new conversation ids unless explicit overwrite is requested;
- restores events and projection metadata;
- replays projector to validate timeline equivalence;
- stores imported bindings as inactive unless the user chooses to reconnect.

Agent transcript import:

- parses external data once;
- creates synthetic `ConversationEvent` rows;
- stores the source path and raw import payload;
- does not bind the imported transcript as the future rendering source.

## ACP Capability Handling

Persist capabilities at initialization and session setup:

- protocol version;
- prompt block support: text, image, resource;
- session capabilities: load, resume, close, additional directories;
- terminal support;
- filesystem request support;
- MCP server injection support;
- permission request support;
- modes and config options;
- available commands.

Capability-gated behavior:

- hide or disable image/resource attachments if unsupported;
- show "history visible, Agent context not restored" when load/resume is
  unsupported and a new ACP session is created;
- disable mode/config controls unless session options are present;
- display unsupported command/tool diagnostics as conversation notices.

## Migration and Cutover

This is a direct refactor. The implementation should not build adapters that
keep the old model alive.

Recommended cutover:

1. add new schema and models;
2. add new conversation service and projector;
3. route sending through `conversation_start_turn`;
4. switch conversation detail to event projection;
5. switch frontend to conversation timeline store;
6. remove transcript-reparse path from active product code;
7. remove old bridge tests and replace them with projector/timeline tests;
8. keep external Agent transcript parsers only behind explicit import commands.

If historical local data must be preserved, write a one-time importer from old
metadata/transcripts into event-sourced conversations. It must be explicit and
visible, not an invisible compatibility layer.

## Files and Modules Affected

Backend:

- `crates/agents/src/events.rs`
- `crates/agents/src/manager.rs`
- `crates/agents/src/runtime.rs`
- `crates/agents/src/conversation.rs`
- `crates/agents/src/parsers/*`
- `crates/db/migrations/*`
- `crates/db/src/models/conversation.rs`
- `crates/db/src/models/agent_runtime.rs`
- new `crates/db/src/models/conversation_events.rs`
- new `crates/db/src/models/conversation_projection.rs`
- `src-tauri/src/commands/agents.rs`
- `src-tauri/src/commands/conversations.rs`
- `src-tauri/src/events.rs`
- `src-tauri/src/bin/generate_types.rs`

Frontend:

- `frontend/src/features/agents/api.ts`
- `frontend/src/features/agents/events.ts`
- `frontend/src/features/agents/store.ts`
- `frontend/src/features/agents/useAgentWorkbench.ts`
- `frontend/src/features/agents/ConversationRuntimeContext.tsx`
- `frontend/src/features/agents/useConversationRuntimeBridge.ts`
- `frontend/src/features/agents/liveMessage.ts`
- `frontend/src/features/agents/sendAgentRuntimeTurn.ts`
- new `frontend/src/features/conversation/*`
- `frontend/src/components/logs/AgentTimelineConversation.tsx`
- `frontend/src/components/NormalizedConversation/*`
- `frontend/src/components/conversation-thread/*`
- `frontend/src/hooks/useFollowUpSend.ts`
- `shared/types.ts`

Docs:

- `docs/specs/acp-native-agent-platform/README.md`
- this phase's `requirements.md`, `design.md`, `tasks.md`
- this phase's `codeg-comparison-adoption.md`
- closure review documents after each implementation phase.

## Risks and Mitigations

- Risk: projection logic becomes too large.
  - Mitigation: keep event normalization, state table updates, and timeline
    projection as separate modules with fixture tests.
- Risk: frontend misses realtime events.
  - Mitigation: sequence gap detection and `events_since` recovery.
- Risk: ACP agents differ in load/resume support.
  - Mitigation: capability snapshot drives behavior; degraded state is visible.
- Risk: file changes are incomplete from ACP output.
  - Mitigation: checkpoint diff is authoritative fallback.
- Risk: destructive migration loses local history.
  - Mitigation: optional explicit one-time import/export before cutover; no
    hidden compatibility path.
- Risk: raw ACP schema evolves.
  - Mitigation: normalized event contract stores raw diagnostics and supports
    upsert-style tool updates and optional message IDs now.
