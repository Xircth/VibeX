//! Event-sourced conversation core (ADR-0003).
//!
//! Home of the projection fold, snapshot resume, and the incremental row projector —
//! moved out of `crates/db` so the storage layer no longer depends on `agents` (the
//! db→agents reverse dependency is now gone). `crates/db` is a dumb storage layer;
//! this crate owns the folding of the event log into timeline projections.

pub mod bundle;
pub mod capability_catalog;
pub mod checkpoint_safety;
pub mod collaboration;
pub mod collaboration_cards;
pub mod collaboration_sidebar;
pub mod commit_reminder;
pub mod continuation;
pub mod event_folding;
pub mod export;
pub mod handoff;
pub mod host;
pub mod host_isolation;
pub mod input;
pub mod isolated_workspace;
pub mod jsonl_history;
mod legacy_transcript_checkpoint;
pub mod live_coalescer;
pub mod live_pipeline;
pub mod member_memory;
pub mod projection;
pub mod relation;
pub mod runtime_events;
pub mod scoped_control;
pub mod search;
pub mod service;
pub mod session_info;
pub mod transcript_segments;
pub mod turn_window;
pub mod usage_accounting;
pub mod workbench_status;

pub use bundle::{
    ConversationBundleError, ConversationExportResult, ConversationForkContinuity,
    ConversationForkResult, ConversationImportResult, export_conversation_bundle,
    import_conversation_bundle, resolve_agent_fork_point,
};
pub use capability_catalog::{
    capability_catalog_is_fresh, capability_catalog_is_fresh_for_provider_instance,
    invalidate_open_capability_catalog, load_capability_catalog_for_session_defaults,
    load_capability_catalog_for_session_defaults_for_provider_instance,
    open_capability_catalog_fingerprint, read_matching_capability_catalog_for_defaults,
    read_matching_capability_catalog_for_defaults_for_provider_instance,
    read_matching_open_capability_catalog,
    read_matching_open_capability_catalog_for_provider_instance, record_open_capability_catalog,
    refresh_open_capability_catalog, refresh_open_capability_catalog_for_provider_instance,
};
pub use checkpoint_safety::{
    CheckpointRollbackSafety, DEFAULT_ROLLBACK_LEASE_TTL_SECS, RollbackSafetyError,
    RollbackSafetyReport, WorkspaceRollbackLeaseGuard, ensure_workspace_leases_schema,
};
pub use collaboration::{
    HotGroupTracker, SessionProcessWarmup, SpaceWarmupResult, spawn_delayed_input_promoter,
    spawn_idle_session_sweeper, warmup_space_members,
};
pub use event_folding::{
    DEFAULT_FOLD_INITIAL_DELAY, DEFAULT_FOLD_INTERVAL, EventFoldReport, EventFolder, FoldReport,
    FoldedEvent, FoldedEventType, RECENT_TURN_BUFFER, spawn_periodic_event_folding_worker,
};
pub use export::{render_html, render_markdown};
pub use handoff::{
    ConversationEngineHandoffPackedItem, ConversationEngineHandoffPreview,
    DEFAULT_HANDOFF_TOKEN_BUDGET, DeterministicHandoffService, EngineHandoffConfirmation,
    HandoffContext, HandoffError, latest_agent_handoff_sequence,
};
pub use host::{
    DefaultConversationHost, resolve_absolute_workspace_agent_working_dir,
    resolve_agent_runtime_launch_settings,
    resolve_agent_runtime_launch_settings_for_provider_instance,
    resolve_workspace_agent_working_dir, session_launch_rejection_from_pool,
    workspace_prompt_blocks,
};
pub use host_isolation::resolve_effective_provider_instance_id;
pub use input::{
    CancelConversationInput, ConversationInputClaim, ConversationInputControl,
    ConversationInputControlError, ConversationInputEvent, ConversationInputQueue,
    ConversationInputState, ConversationInputStatus, ConversationInputSubmission,
    ConversationInputView, ReorderConversationInput, SubmitConversationInput,
    UpdateConversationInput,
};
pub use live_coalescer::{COALESCE_WINDOW, LiveRowOpCoalescer, MAX_PENDING_UPDATES};
pub use live_pipeline::{
    ConversationEventSink, ConversationLivePipeline, WorkspaceSessionsChanged,
};
pub use projection::{
    BatchAppendResult, BatchConversationEvent, CONVERSATION_PROJECTION_VERSION, CachedRowProjector,
    CheckpointMetadataUpdate, CommittedConversationEvent, ConversationEventAppender,
    ConversationProjector, ConversationRowProjectors, ConversationRowWindow,
    ConversationRowsSincePage, ConversationStateApplier, IncrementalRowProjector, MAX_BATCH_BYTES,
    MAX_BATCH_EVENTS, MAX_WINDOW_BYTES, OPEN_TIMELINE_ROW_LIMIT, OpenConversationProjection,
    TimelineKeysetCursor, backfill_next_legacy_batch, clear_internal_message_listeners,
    decode_timeline_cursor, encode_timeline_cursor, ensure_legacy_jsonl_migrated,
    ensure_legacy_jsonl_migrated_on_pool, evict_least_recently_used_projectors,
    extend_coalesced_row_ops, register_acp_replay_history_probe,
    register_internal_message_listener, register_projection_repair_hook,
    spawn_legacy_jsonl_backfill_worker, subscribe_internal_messages,
};
pub use relation::{
    ConversationChildSummaryView, ConversationRelationControl, ConversationRelationView,
    CreateConversationRelation,
};
pub use runtime_events::{
    ConversationAgentEventRecorder, RecordedConversationBatch, RecordedConversationCompletion,
    RuntimeEventRecordError, flush_conversation_persistence, start_agent_event_persistence,
    start_agent_event_persistence_with_observer,
};
pub use scoped_control::{
    ScopedConversationControl, ScopedConversationControlError, ScopedConversationWait,
};
pub use search::{
    ConversationSearchHit, backfill_missing, reindex_from_projection, search_conversations,
    search_conversations_with_offset,
};
pub use service::{
    AfterTurnEvent, AgentRuntimeLaunchSettings, BeforeTurnContext, ConversationContext,
    ConversationEventPublisher, ConversationHost, ConversationRuntimeState,
    ConversationServiceError, ConversationSessionService, ConversationSessionWarmup,
    ConversationStartTurnInput, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationSteeringStatus, ConversationTurnSnapshot, CreateDelegatedConversation,
    CreateForkConversation, CreateWorkflowConversation, ForkVisibleConversation,
    NoopConversationEventPublisher, PreparedCheckpointFileChanges, QueuedConversationInputClaim,
    RuntimeEventNotification, clear_turn_hooks, commit_checkpoint_metadata_on_connection,
    continuation_key_instance_id, create_delegated_conversation, create_fork_conversation, create_workflow_conversation,
    finalize_checkpoint_file_changes, fork_visible_conversation, prepare_checkpoint_file_changes,
    preview_checkpoint_file_changes, register_after_turn_hook, register_before_turn_hook,
    remember_creation_session_controls, subscribe_after_turn_events, subscribe_runtime_events,
};
pub use session_info::{
    SessionInfo, agent_session_title_from_patch, derive_session_display_name,
    first_prompt_session_name, load_compact_transcript, read_history_page,
    resolve_referenced_session, sanitize_agent_session_title, session_info_value,
};
pub use usage_accounting::{
    assemble_project_usage_statistics, attributed_sessions_from_rows, catch_up_usage_snapshots,
    session_stats_with_usage_snapshot, sync_vendor_usage_logs,
};
