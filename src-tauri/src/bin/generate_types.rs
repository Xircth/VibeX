use std::{collections::BTreeMap, path::PathBuf, process::ExitCode};

use agents::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentCapability, AgentConnectionId,
    AgentConnectionSnapshot, AgentConnectionStatus, AgentContentBlock, AgentElicitationId,
    AgentElicitationRequest, AgentElicitationResponse, AgentErrorEvent, AgentEvent,
    AgentEventEnvelope, AgentFileReadRequest, AgentFileWriteRequest, AgentListedSession,
    AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionRequest,
    AgentPermissionResponse, AgentPlan, AgentPlanEntry, AgentPlanUsage,
    AgentPreparedSessionSnapshot, AgentPromptFinished, AgentPromptId, AgentPromptSnapshot,
    AgentPromptStatus, AgentSessionConfigChoice, AgentSessionConfigDependency,
    AgentSessionConfigOption, AgentSessionConfigOverride, AgentSessionControlsSnapshot,
    AgentSessionId, AgentSessionListPage, AgentSessionMode, AgentSessionSnapshot,
    AgentSessionStatus, AgentTerminalCreateRequest, AgentTerminalEnvVar, AgentTerminalExit,
    AgentTerminalId, AgentTerminalOutput, AgentTerminalOutputSnapshot, AgentTerminalSnapshot,
    AgentToolCall, AgentToolCallUpdate, AgentUsage, AuthenticationMethod,
    AuthenticationObservationState, AuthenticationSource, DelegationResultSummary,
    ImportedAgentMessage, ImportedAgentMessageMetadata, ImportedAgentMessageRole,
    ImportedAgentSession, LocalHistoryDestination, LocalHistoryImportJobSnapshot,
    LocalHistoryImportJobStatus, LocalHistoryImportLogEntry, LocalHistoryImportPhase,
    LocalHistoryImportProgress, LocalHistoryImportResult, LocalHistoryImportSelection,
    LocalHistoryScanFolder, LocalHistoryScanPage, LocalHistoryScanProgress,
    LocalHistoryScanSession, LocalHistorySessionStatus, PlanCredits, PlanUsageResult,
    PlanUsageUnavailableReason, PlanUsageWindow, RuntimeSnapshot,
    conversation::{
        AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentExecutionStats,
        AgentPromptCapabilities, ContentBlock, ConversationAgentConnectionStatus,
        ConversationArtifactPreviewReference, ConversationArtifactReference,
        ConversationBundleChecksum, ConversationBundleManifest, ConversationBundlePayload,
        ConversationDelegation, ConversationDelegationResult, ConversationDelegationView,
        ConversationDetail, ConversationError, ConversationErrorView, ConversationEvent,
        ConversationEventEnvelope, ConversationEventsPage, ConversationFeedbackRequest,
        ConversationFeedbackResponse, ConversationFileChange, ConversationFileChangeSummary,
        ConversationFileLocation, ConversationFileRef, ConversationInputBlock,
        ConversationInputEvent, ConversationInputPayload, ConversationNoticeAction,
        ConversationPermissionRequest, ConversationPermissionResponse, ConversationPermissionView,
        ConversationPlanEntry, ConversationQuestionRequest, ConversationQuestionResponse,
        ConversationRelationKind, ConversationRelationVisibility, ConversationRowOp,
        ConversationRowOpBatch, ConversationRowPage, ConversationSessionModes,
        ConversationSessionNotice, ConversationSteeringEvent, ConversationSummary,
        ConversationTerminalPatch, ConversationTerminalView, ConversationTimeline,
        ConversationTimelinePage, ConversationTimelineRow, ConversationToolCallPatch,
        ConversationTurnErrorKind, ConversationUsage, ConversationWorkflowRef, ImageData,
        MessageTurn, PlanEntry, SessionLoadFailureReason, SessionRecoveryStrategy, SessionStats,
        SubAgentToolCall, TimelineRow, TimelineTextStream, TurnBlockedReason, TurnRole, TurnUsage,
    },
};
use api_types::{
    AgentAccountFlowStatus, AgentAccountFlowView, AgentAuthModeKind, AgentAuthModeOptionView,
    AgentAuthModeView, AgentAuthenticationStatus, AgentDiagnosticView, AgentDiscoveryPhase,
    AgentDiscoveryProgressView, AgentEnvironmentDiagnosticCheckView,
    AgentEnvironmentDiagnosticLevel, AgentEnvironmentDiagnosticSectionView,
    AgentEnvironmentDiagnosticsView, AgentEnvironmentEntryView, AgentEnvironmentPatchRequest,
    AgentEnvironmentView, AgentId, AgentKind, AgentLifecycleState, AgentLocalRuntimeView,
    AgentManagementActionKind, AgentManagementActionReceipt, AgentManagementActionView,
    AgentManagementActionsView, AgentManagementErrorCode, AgentManagementErrorView,
    AgentManagementIdentity, AgentManagementView, AgentModelCatalogItemView,
    AgentModelCatalogSource, AgentModelCatalogView, AgentModelProviderImportCandidateView,
    AgentModelProviderImportPreviewView, AgentModelProviderImportRequest,
    AgentModelProviderImportSource, AgentModelProviderProbeView, AgentModelProviderSaveRequest,
    AgentModelProviderView, AgentModelProvidersView, AgentNativeConfigFieldKind,
    AgentNativeConfigFieldView, AgentNativeConfigFileView, AgentNativeConfigFileWriteRequest,
    AgentNativeConfigFormat, AgentNativeConfigOptionView, AgentNativeConfigPatchRequest,
    AgentNativeConfigSurface, AgentNativeConfigView, AgentOperationEvent, AgentOperationKind,
    AgentOperationReceipt, AgentOperationStatus, AgentPreflightItemView, AgentPreflightSource,
    AgentPreflightView, AgentRegistryView, AgentRegistryViewRow, AgentSettingsFeature, AgentSource,
    AgentUpdateCheckView, CodexCustomModelRequest, CodexDeviceCodePollView, CodexDeviceCodeView,
    CodexModelCatalogConfigRequest, CodexModelCatalogConfigView, CommunityAcpPresetView,
    DshCatalogProviderView, DshExtensionKind, DshPluginSummaryView, DshPluginView,
    DshProviderDiscoverRequest, DshProviderKind, DshProviderModelView, DshProviderSaveRequest,
    DshProviderView, DshProvidersView, GrokPluginSummaryView, GrokPluginView,
    OpenCodeCatalogModelView, OpenCodeCatalogProviderView, OpenCodePluginStatus,
    OpenCodePluginSummaryView, OpenCodePluginView, OpenCodeProviderCatalogSource,
    OpenCodeProviderCatalogView, OpenCodeProviderConnectRequest, OpenCodeProviderConnectionView,
    OpenCodeProviderConnectionsView, OpenCodeProviderModelRequest, OpenCodeProviderModelView,
    PiCommandValidationView, PiConfigurationView, PiCredentialsSaveRequest, PiCustomProviderView,
    PiPluginSummaryView, PiPluginView, PiRuntimeConfigurationView, PiRuntimeSaveRequest,
    UserAgentDefinitionRequest, UserAgentDefinitionView, UserAgentDistributionKind,
    UserAgentDistributionView, UserAgentEnvironmentVariableView, UserAgentIntegrityKind,
};
use application::{ConversationLiveFeedbackNote, ConversationOutputView};
use conversations::{
    ConversationChildSummaryView, ConversationInputStatus, ConversationInputSubmission,
    ConversationInputView, ConversationRelationView, ConversationSearchHit,
    ConversationSteeringReceipt, ConversationSteeringStatus,
};
use db::models::{
    chat_channel_message_log::ChatChannelMessageLog,
    conversation::DbConversationSummary,
    execution_process::ExecutionProcessRunReason,
    scratch::{CreateScratch, DraftFollowUpData, Scratch, ScratchUpdateOutcome, UpdateScratch},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskRelationships, TaskStatus, TaskWithAttemptStatus, UpdateTask},
    workspace::{Workspace, WorkspaceWithStatus},
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};
use executors::{
    actions::{ExecutorAction, ExecutorActionType},
    executors::{CodingAgent, SlashCommandDescription, SlashCommandKind},
    logs::{ActionType, utils::shell_command_parsing::CommandCategory},
    profile::ExecutorProfileId,
};
use git::{
    ConflictFileDetail, ConflictHunk, ConflictStageContent, GitBranch, StashEntry,
    WriteConflictResolutionResult,
};
use remote_protocol::{
    CapabilityId, ConversationId, ErrorCode, ErrorEnvelope, OperationId, ReachabilityOrigin,
    RemoteEvent, ServerCapabilities, SubscriptionBootstrap, SubscriptionId, SubscriptionRequest,
    SubscriptionResource, SubscriptionSnapshot,
};
use services::services::{
    config::{CommitReminderMode, Config, LinkOpenBehavior, NotificationConfig, NotificationWhen},
    usage::{
        ProjectUsageAgentUsage, ProjectUsageDailyUsage, ProjectUsageFolderUsage,
        ProjectUsageModelUsage, ProjectUsageProviderStatus, ProjectUsageSessionSummary,
        ProjectUsageSourcedTokens, ProjectUsageStatistics, ProjectUsageTokenCounts,
        ProjectUsageTrends, ProjectUsageUsageData, ProjectUsageWeekData,
        ProjectUsageWeeklyComparison,
    },
};
use ts_rs::TS;
use vibex::{
    commands::{
        artifact_preview::ArtifactPreviewLeaseDto,
        attention::{AttentionInbox, AttentionItem, AttentionItemKind},
        conversations::{ConversationActiveBinding, ConversationCurrentTurn, DbConversationDetail},
        crash_reports::{CrashReportMeta, CrashReportsInfo},
        sessions::{SessionContinuityMode, SessionSummary},
    },
    conversation_bundle::{
        ConversationExportResult, ConversationForkContinuity, ConversationForkResult,
        ConversationImportResult,
    },
    conversation_service::ConversationTurnSnapshot,
};
use workflows::{
    AgentStepSpec, ApprovalStepSpec, ClaimedWorkflowStep, CompletionPolicy, DebugRunScope,
    NotifyStepSpec, SideEffectClass, WorkflowBinding, WorkflowDefinition,
    WorkflowDefinitionSummary, WorkflowEvent, WorkflowEventRecord, WorkflowPolicy,
    WorkflowReviewDecision, WorkflowRunStatus, WorkflowRunView, WorkflowStep, WorkflowStepSpec,
    WorkflowStepStatus, WorkflowStepView, WorkflowValidationView, WorkflowVersionView,
    WorkspaceAccess,
};

const HEADER: &str = "// This file was generated by `src-tauri/src/bin/generate_types.rs`.\n\
\n\
// Do not edit this file manually.";

#[derive(Clone)]
struct Declaration {
    name: String,
    content: String,
}

fn main() -> ExitCode {
    let mut check = false;
    for arg in std::env::args().skip(1) {
        if arg == "--check" {
            check = true;
        } else {
            eprintln!("Unknown argument: {arg}");
            eprintln!("Usage: cargo run --bin generate_types -- [--check]");
            return ExitCode::from(2);
        }
    }

    match run(check) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("generate-types failed: {error}");
            ExitCode::from(1)
        }
    }
}

fn run(check: bool) -> Result<ExitCode, String> {
    let mut failed = false;
    match sync_file(
        check,
        workspace_root().join("shared").join("types.ts"),
        |current| render_merged_types(&normalize_newlines(current)),
    )? {
        FileSync::UpToDate => println!("shared/types.ts is up to date"),
        FileSync::Updated => println!("updated shared/types.ts"),
        FileSync::Stale => {
            eprintln!("shared/types.ts is out of date. Run `pnpm run generate-types`.");
            failed = true;
        }
    }
    match sync_file(
        check,
        workspace_root().join("shared").join("hostCommands.ts"),
        |_| render_host_commands(),
    )? {
        FileSync::UpToDate => println!("shared/hostCommands.ts is up to date"),
        FileSync::Updated => println!("updated shared/hostCommands.ts"),
        FileSync::Stale => {
            eprintln!("shared/hostCommands.ts is out of date. Run `pnpm run generate-types`.");
            failed = true;
        }
    }
    if failed {
        Ok(ExitCode::from(1))
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

enum FileSync {
    UpToDate,
    Updated,
    Stale,
}

fn sync_file(
    check: bool,
    path: PathBuf,
    render: impl FnOnce(&str) -> String,
) -> Result<FileSync, String> {
    let current_raw = std::fs::read_to_string(&path).unwrap_or_default();
    let line_ending = if current_raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let current = normalize_newlines(&current_raw);
    let generated = render(&current);
    if current == generated {
        return Ok(FileSync::UpToDate);
    }
    if check {
        return Ok(FileSync::Stale);
    }
    let output = if line_ending == "\r\n" {
        generated.replace('\n', "\r\n")
    } else {
        generated
    };
    std::fs::write(&path, output)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(FileSync::Updated)
}

fn render_host_commands() -> String {
    let mut names = application::RegisteredCommand::host_command_names();
    names.sort_unstable();
    names.dedup();
    let host = names
        .into_iter()
        .map(|name| format!("  '{name}',"))
        .collect::<Vec<_>>()
        .join("\n");
    let shell = DESKTOP_SHELL_COMMANDS
        .iter()
        .map(|name| format!("  '{name}',"))
        .collect::<Vec<_>>()
        .join("\n");
    let scopes = application::DomainCommand::capability_scopes()
        .into_iter()
        .map(|scope| format!("  '{scope}',"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "/* Generated from RegisteredCommand + DomainCommand. Do not hand-edit. */\n\n\
export const HOST_COMMANDS = [\n{host}\n] as const;\n\n\
export const DESKTOP_SHELL_COMMANDS = [\n{shell}\n] as const;\n\n\
export const HOST_CAPABILITY_SCOPES = [\n{scopes}\n] as const;\n\n\
export type HostCommand = (typeof HOST_COMMANDS)[number];\n\
export type DesktopShellCommand = (typeof DESKTOP_SHELL_COMMANDS)[number];\n"
    )
}

const DESKTOP_SHELL_COMMANDS: &[&str] = &[
    "open_in_editor",
    "open_project_in_editor",
    "show_desktop_toast",
    "start_web_server",
    "stop_web_server",
    "host_client_connect",
    "host_client_disconnect",
    "host_client_call",
    "remote_desktop_connect",
    "remote_desktop_disconnect",
    "remote_desktop_call",
    "remote_desktop_capabilities",
    "remote_desktop_listen",
    "remote_desktop_subscribe",
    "create_ssh_tunnel",
    "close_ssh_tunnel",
    "backup_create",
    "backup_restore",
    "open_devtools",
    "plugin_dev_connection",
    "activate_desktop_toast",
    "set_app_icon",
    "update_tray_badge",
    "host_client_delete",
    "revoke_host_device",
    "conversation_attach",
    "fixture_delegate",
    "fixture_reset",
    "backup_cancel",
    "backup_inspect",
    "backup_restore_stage",
    "browser_apply_intent",
    "browser_close_tab",
    "browser_create_tab",
    "browser_get_tab",
    "cancel_create_host_tunnel",
    "check_existing_host_tunnel",
    "confirm_create_host_tunnel",
    "control_tauri_inspector",
    "create_host_device_pairing",
    "desktop_toast_window_ready",
    "exit_app",
    "generate_web_service_token",
    "get_host_tunnel",
    "get_tauri_inspector_status",
    "get_web_server_status",
    "get_web_service_config",
    "health_check",
    "host_client_discover",
    "host_client_status",
    "install_tauri_inspector",
    "is_main_window_focused",
    "list_host_devices",
    "open_external_terminal",
    "open_repo_in_editor",
    "open_settings_window",
    "open_workspace_in_editor",
    "probe_web_service_port",
    "remove_saved_host_tunnel",
    "reveal_in_file_manager",
    "select_saved_host_tunnel",
    "set_host_tunnel_enabled",
    "start_create_host_tunnel",
    "take_tauri_inspector_capture",
    "trash_item",
    "update_web_service_config",
    "plugin_control_import_cli",
];

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent workspace directory")
        .to_path_buf()
}

fn render_merged_types(existing: &str) -> String {
    let existing = remove_legacy_commit_reminder_constant(existing);
    let (_, existing_decls) = parse_declarations(&existing);
    let mut replacements = replacement_declarations();
    let tombstones = removed_declarations();
    let mut merged = Vec::with_capacity(existing_decls.len() + replacements.len());
    let mut inserted_session_continuity_mode = false;
    let mut seen_existing = std::collections::BTreeSet::new();

    for declaration in existing_decls {
        if tombstones.contains(declaration.name.as_str()) {
            continue;
        }

        if !seen_existing.insert(declaration.name.clone()) {
            continue;
        }

        if declaration.name == "SessionSummary"
            && let Some(replacement) = replacements.remove("SessionContinuityMode")
        {
            merged.push(replacement);
            inserted_session_continuity_mode = true;
        }

        if inserted_session_continuity_mode && declaration.name == "SessionContinuityMode" {
            continue;
        }

        if let Some(replacement) = replacements.remove(&declaration.name) {
            merged.push(replacement);
        } else {
            merged.push(declaration.content);
        }
    }

    for (_, replacement) in replacements {
        merged.push(replacement);
    }

    if merged.is_empty() {
        format!("{HEADER}\n")
    } else {
        format!("{HEADER}\n\n{}\n", merged.join("\n\n"))
    }
}

fn removed_declarations() -> &'static std::collections::BTreeSet<&'static str> {
    static REMOVED: std::sync::OnceLock<std::collections::BTreeSet<&'static str>> =
        std::sync::OnceLock::new();
    REMOVED.get_or_init(|| {
        std::collections::BTreeSet::from([
            // AgentKind remains a generated compatibility declaration while
            // live session identity migrates to AgentId. A declaration cannot
            // be both replaced and tombstoned without breaking idempotence.
            "ConversationPluginActionInvocation",
            "CapabilitySource",
            "CapabilityState",
            "CapabilityStatus",
            "ProviderCapabilityState",
            "AvailabilityInfo",
            "BaseAgentCapability",
            "GetMcpServerResponse",
            "McpConfig",
            "ProviderCommand",
            "ProviderHistorySnapshot",
            "ProviderId",
            "ProviderModel",
            "ProviderSessionSummary",
            "ProviderTurnRequest",
            "AgentPromptQueue",
            "QueueTransition",
            "AgentConfigStrategy",
            "AgentConfigSurface",
            "PathTemplate",
            "AgentMcpStrategy",
            "AgentMcpSurface",
            "AgentMcpConfig",
            "AgentSkillsStrategy",
            "AgentSkillsSurface",
            "AgentDistribution",
            "PlatformBinary",
            "SystemCommand",
            "CommandParts",
            "AgentRegistryEntry",
            "AgentInstallPlan",
            "AgentInstallStatus",
            "AgentPreflight",
            "AgentPreflightIssue",
            "AgentPreflightSeverity",
            "AgentRuntimeComponentInfo",
            "AgentAvailabilityInfo",
            "LocalAgentRuntimeInfo",
            "AgentSettingInfo",
            "UpdateAgentPreferences",
            "ReorderAgentsRequest",
            // Plugins: agent-driven console contract replaced the
            // VibeX-spawned console process (PluginConsoleStart → PluginActivation).
            "PluginConsoleStart",
            "Plugin",
            "PluginInput",
            "PluginActivation",
            "UserSystemInfo",
            "Automation",
            "AutomationInput",
            "AutomationRun",
            "Amp",
            "Auggie",
            "AuggieModel",
            "Autonomy",
            "CodingAgentFollowUpRequest",
            "CodingAgentInitialRequest",
            "Copilot",
            "CursorAgent",
            "Droid",
            "DroidReasoningEffort",
            "Gemini",
            "QwenCode",
            "RepoReviewContext",
            "ReviewRequest",
        ])
    })
}

fn remove_legacy_commit_reminder_constant(existing: &str) -> String {
    let Some(start) = existing.find("\nexport const DEFAULT_COMMIT_REMINDER_PROMPT =") else {
        return existing.to_string();
    };
    let Some(relative_end) =
        existing[start + 1..].find("\nexport const DEFAULT_MERGE_COMMIT_MESSAGE_TEMPLATE =")
    else {
        return existing.to_string();
    };
    let end = start + 1 + relative_end;
    format!("{}{}", &existing[..start], &existing[end..])
}

fn replacement_declarations() -> BTreeMap<String, String> {
    let mut decls = BTreeMap::new();
    insert_declaration::<SessionStatus>(&mut decls);
    insert_declaration::<Session>(&mut decls);
    insert_declaration::<CreateSession>(&mut decls);
    insert_declaration::<SessionContinuityMode>(&mut decls);
    insert_declaration::<SessionSummary>(&mut decls);
    insert_declaration::<Config>(&mut decls);
    insert_declaration::<NotificationConfig>(&mut decls);
    insert_declaration::<NotificationWhen>(&mut decls);
    insert_declaration::<LinkOpenBehavior>(&mut decls);
    insert_declaration::<CommitReminderMode>(&mut decls);
    insert_declaration::<DraftFollowUpData>(&mut decls);
    insert_declaration::<Scratch>(&mut decls);
    insert_declaration::<CreateScratch>(&mut decls);
    insert_declaration::<UpdateScratch>(&mut decls);
    insert_declaration::<ScratchUpdateOutcome>(&mut decls);
    insert_declaration::<ExecutorProfileId>(&mut decls);
    insert_declaration::<ExecutorAction>(&mut decls);
    insert_declaration::<ExecutorActionType>(&mut decls);
    insert_declaration::<CodingAgent>(&mut decls);
    insert_declaration::<ActionType>(&mut decls);
    insert_declaration::<CommandCategory>(&mut decls);
    // Temporary compatibility enum while live session identity migrates to the
    // open AgentId contract.
    insert_declaration::<AgentKind>(&mut decls);
    insert_declaration::<AgentId>(&mut decls);
    insert_declaration::<PlanUsageWindow>(&mut decls);
    insert_declaration::<PlanCredits>(&mut decls);
    insert_declaration::<AgentPlanUsage>(&mut decls);
    insert_declaration::<PlanUsageUnavailableReason>(&mut decls);
    insert_declaration::<PlanUsageResult>(&mut decls);
    insert_declaration::<AgentSource>(&mut decls);
    insert_declaration::<UserAgentDistributionKind>(&mut decls);
    insert_declaration::<UserAgentDefinitionRequest>(&mut decls);
    insert_declaration::<UserAgentIntegrityKind>(&mut decls);
    insert_declaration::<UserAgentEnvironmentVariableView>(&mut decls);
    insert_declaration::<UserAgentDistributionView>(&mut decls);
    insert_declaration::<UserAgentDefinitionView>(&mut decls);
    insert_declaration::<AgentLifecycleState>(&mut decls);
    insert_declaration::<AgentAuthenticationStatus>(&mut decls);
    insert_declaration::<AgentManagementIdentity>(&mut decls);
    insert_declaration::<AgentOperationKind>(&mut decls);
    insert_declaration::<AgentOperationStatus>(&mut decls);
    insert_declaration::<AgentLocalRuntimeView>(&mut decls);
    insert_declaration::<AgentDiscoveryPhase>(&mut decls);
    insert_declaration::<AgentDiscoveryProgressView>(&mut decls);
    insert_declaration::<AgentManagementView>(&mut decls);
    insert_declaration::<AgentRegistryViewRow>(&mut decls);
    insert_declaration::<CommunityAcpPresetView>(&mut decls);
    insert_declaration::<AgentRegistryView>(&mut decls);
    insert_declaration::<AgentUpdateCheckView>(&mut decls);
    insert_declaration::<AgentOperationEvent>(&mut decls);
    insert_declaration::<AgentManagementErrorCode>(&mut decls);
    insert_declaration::<AgentManagementErrorView>(&mut decls);
    insert_declaration::<AgentPreflightSource>(&mut decls);
    insert_declaration::<AgentPreflightItemView>(&mut decls);
    insert_declaration::<AgentPreflightView>(&mut decls);
    insert_declaration::<AgentManagementActionKind>(&mut decls);
    insert_declaration::<AgentManagementActionView>(&mut decls);
    insert_declaration::<AgentManagementActionsView>(&mut decls);
    insert_declaration::<AgentManagementActionReceipt>(&mut decls);
    insert_declaration::<AgentAccountFlowStatus>(&mut decls);
    insert_declaration::<AgentAccountFlowView>(&mut decls);
    insert_declaration::<OpenCodeProviderConnectionView>(&mut decls);
    insert_declaration::<OpenCodeProviderModelView>(&mut decls);
    insert_declaration::<OpenCodeProviderConnectionsView>(&mut decls);
    insert_declaration::<OpenCodeProviderConnectRequest>(&mut decls);
    insert_declaration::<OpenCodeProviderModelRequest>(&mut decls);
    insert_declaration::<OpenCodeProviderCatalogSource>(&mut decls);
    insert_declaration::<OpenCodeCatalogModelView>(&mut decls);
    insert_declaration::<OpenCodeCatalogProviderView>(&mut decls);
    insert_declaration::<OpenCodeProviderCatalogView>(&mut decls);
    insert_declaration::<CodexDeviceCodeView>(&mut decls);
    insert_declaration::<CodexDeviceCodePollView>(&mut decls);
    insert_declaration::<AgentModelCatalogSource>(&mut decls);
    insert_declaration::<AgentModelCatalogItemView>(&mut decls);
    insert_declaration::<AgentModelCatalogView>(&mut decls);
    insert_declaration::<CodexCustomModelRequest>(&mut decls);
    insert_declaration::<CodexModelCatalogConfigRequest>(&mut decls);
    insert_declaration::<CodexModelCatalogConfigView>(&mut decls);
    insert_declaration::<AgentModelProviderView>(&mut decls);
    insert_declaration::<AgentModelProvidersView>(&mut decls);
    insert_declaration::<AgentModelProviderProbeView>(&mut decls);
    insert_declaration::<AgentModelProviderImportSource>(&mut decls);
    insert_declaration::<AgentModelProviderImportCandidateView>(&mut decls);
    insert_declaration::<AgentModelProviderImportPreviewView>(&mut decls);
    insert_declaration::<AgentModelProviderImportRequest>(&mut decls);
    insert_declaration::<AgentModelProviderSaveRequest>(&mut decls);
    insert_declaration::<PiCustomProviderView>(&mut decls);
    insert_declaration::<PiRuntimeConfigurationView>(&mut decls);
    insert_declaration::<PiConfigurationView>(&mut decls);
    insert_declaration::<PiCredentialsSaveRequest>(&mut decls);
    insert_declaration::<PiRuntimeSaveRequest>(&mut decls);
    insert_declaration::<PiCommandValidationView>(&mut decls);
    insert_declaration::<DshProviderKind>(&mut decls);
    insert_declaration::<DshProviderModelView>(&mut decls);
    insert_declaration::<DshCatalogProviderView>(&mut decls);
    insert_declaration::<DshProviderView>(&mut decls);
    insert_declaration::<DshProvidersView>(&mut decls);
    insert_declaration::<DshProviderSaveRequest>(&mut decls);
    insert_declaration::<DshProviderDiscoverRequest>(&mut decls);
    insert_declaration::<DshExtensionKind>(&mut decls);
    insert_declaration::<DshPluginView>(&mut decls);
    insert_declaration::<DshPluginSummaryView>(&mut decls);
    insert_declaration::<GrokPluginView>(&mut decls);
    insert_declaration::<GrokPluginSummaryView>(&mut decls);
    insert_declaration::<PiPluginView>(&mut decls);
    insert_declaration::<PiPluginSummaryView>(&mut decls);
    insert_declaration::<AgentAuthModeKind>(&mut decls);
    insert_declaration::<AgentAuthModeOptionView>(&mut decls);
    insert_declaration::<AgentAuthModeView>(&mut decls);
    insert_declaration::<AgentEnvironmentEntryView>(&mut decls);
    insert_declaration::<AgentEnvironmentView>(&mut decls);
    insert_declaration::<AgentEnvironmentPatchRequest>(&mut decls);
    insert_declaration::<AgentEnvironmentDiagnosticLevel>(&mut decls);
    insert_declaration::<AgentEnvironmentDiagnosticCheckView>(&mut decls);
    insert_declaration::<AgentEnvironmentDiagnosticSectionView>(&mut decls);
    insert_declaration::<AgentEnvironmentDiagnosticsView>(&mut decls);
    insert_declaration::<OpenCodePluginStatus>(&mut decls);
    insert_declaration::<OpenCodePluginView>(&mut decls);
    insert_declaration::<OpenCodePluginSummaryView>(&mut decls);
    insert_declaration::<AgentNativeConfigOptionView>(&mut decls);
    insert_declaration::<AgentNativeConfigFieldKind>(&mut decls);
    insert_declaration::<AgentNativeConfigSurface>(&mut decls);
    insert_declaration::<AgentNativeConfigFieldView>(&mut decls);
    insert_declaration::<AgentNativeConfigFormat>(&mut decls);
    insert_declaration::<AgentNativeConfigFileView>(&mut decls);
    insert_declaration::<AgentNativeConfigFileWriteRequest>(&mut decls);
    insert_declaration::<AgentSettingsFeature>(&mut decls);
    insert_declaration::<AgentNativeConfigView>(&mut decls);
    insert_declaration::<AgentNativeConfigPatchRequest>(&mut decls);
    insert_declaration::<AgentDiagnosticView>(&mut decls);
    insert_declaration::<AgentOperationReceipt>(&mut decls);
    insert_declaration::<SlashCommandKind>(&mut decls);
    insert_declaration::<SlashCommandDescription>(&mut decls);
    insert_declaration::<TaskStatus>(&mut decls);
    insert_declaration::<Task>(&mut decls);
    insert_declaration::<TaskWithAttemptStatus>(&mut decls);
    insert_declaration::<TaskRelationships>(&mut decls);
    insert_declaration::<CreateTask>(&mut decls);
    insert_declaration::<UpdateTask>(&mut decls);

    insert_declaration::<Workspace>(&mut decls);
    insert_declaration::<WorkspaceWithStatus>(&mut decls);
    insert_declaration::<WorkspaceRepo>(&mut decls);
    insert_declaration::<RepoWithTargetBranch>(&mut decls);
    insert_declaration::<GitBranch>(&mut decls);
    insert_declaration::<StashEntry>(&mut decls);
    insert_declaration::<ConflictStageContent>(&mut decls);
    insert_declaration::<ConflictHunk>(&mut decls);
    insert_declaration::<ConflictFileDetail>(&mut decls);
    insert_declaration::<WriteConflictResolutionResult>(&mut decls);
    insert_declaration::<ConversationSearchHit>(&mut decls);
    insert_declaration::<ArtifactPreviewLeaseDto>(&mut decls);
    insert_declaration::<ExecutionProcessRunReason>(&mut decls);
    insert_declaration::<ChatChannelMessageLog>(&mut decls);
    insert_declaration::<AgentCapability>(&mut decls);
    insert_declaration::<CrashReportMeta>(&mut decls);
    insert_declaration::<CrashReportsInfo>(&mut decls);
    insert_declaration::<AttentionItemKind>(&mut decls);
    insert_declaration::<AttentionItem>(&mut decls);
    insert_declaration::<AttentionInbox>(&mut decls);
    insert_declaration::<AgentConnectionId>(&mut decls);
    insert_declaration::<AgentSessionId>(&mut decls);
    insert_declaration::<AgentPromptId>(&mut decls);
    insert_declaration::<AgentPermissionId>(&mut decls);
    insert_declaration::<AgentTerminalId>(&mut decls);
    insert_declaration::<AgentConnectionStatus>(&mut decls);
    insert_declaration::<AgentSessionStatus>(&mut decls);
    insert_declaration::<AgentPromptStatus>(&mut decls);
    insert_declaration::<AgentConnectionSnapshot>(&mut decls);
    insert_declaration::<AgentSessionSnapshot>(&mut decls);
    insert_declaration::<AgentPromptSnapshot>(&mut decls);
    insert_declaration::<AgentEventEnvelope>(&mut decls);
    insert_declaration::<AgentEvent>(&mut decls);
    insert_declaration::<DelegationResultSummary>(&mut decls);
    insert_declaration::<AgentContentBlock>(&mut decls);
    insert_declaration::<AgentToolCall>(&mut decls);
    insert_declaration::<AgentToolCallUpdate>(&mut decls);
    insert_declaration::<AgentPlan>(&mut decls);
    insert_declaration::<AgentPlanEntry>(&mut decls);
    insert_declaration::<AgentUsage>(&mut decls);
    insert_declaration::<ProjectUsageTokenCounts>(&mut decls);
    insert_declaration::<ProjectUsageSourcedTokens>(&mut decls);
    insert_declaration::<ProjectUsageUsageData>(&mut decls);
    insert_declaration::<ProjectUsageDailyUsage>(&mut decls);
    insert_declaration::<ProjectUsageModelUsage>(&mut decls);
    insert_declaration::<ProjectUsageFolderUsage>(&mut decls);
    insert_declaration::<ProjectUsageAgentUsage>(&mut decls);
    insert_declaration::<ProjectUsageSessionSummary>(&mut decls);
    insert_declaration::<ProjectUsageWeekData>(&mut decls);
    insert_declaration::<ProjectUsageTrends>(&mut decls);
    insert_declaration::<ProjectUsageWeeklyComparison>(&mut decls);
    insert_declaration::<ProjectUsageProviderStatus>(&mut decls);
    insert_declaration::<ProjectUsageStatistics>(&mut decls);
    insert_declaration::<AgentListedSession>(&mut decls);
    insert_declaration::<AgentSessionListPage>(&mut decls);
    insert_declaration::<AgentSessionMode>(&mut decls);
    insert_declaration::<AgentSessionConfigChoice>(&mut decls);
    insert_declaration::<AgentPreparedSessionSnapshot>(&mut decls);
    insert_declaration::<AgentSessionConfigDependency>(&mut decls);
    insert_declaration::<AgentSessionConfigOption>(&mut decls);
    insert_declaration::<AgentSessionConfigOverride>(&mut decls);
    insert_declaration::<AgentSessionControlsSnapshot>(&mut decls);
    insert_declaration::<AgentAvailableCommand>(&mut decls);
    insert_declaration::<AgentPromptFinished>(&mut decls);
    insert_declaration::<AgentErrorEvent>(&mut decls);
    insert_declaration::<AgentTerminalOutput>(&mut decls);
    insert_declaration::<AgentTerminalSnapshot>(&mut decls);
    insert_declaration::<AgentAutoApproveMode>(&mut decls);
    insert_declaration::<AgentPermissionOptionKind>(&mut decls);
    insert_declaration::<AgentPermissionOption>(&mut decls);
    insert_declaration::<AgentPermissionRequest>(&mut decls);
    insert_declaration::<AgentPermissionResponse>(&mut decls);
    insert_declaration::<AgentElicitationId>(&mut decls);
    insert_declaration::<AgentElicitationRequest>(&mut decls);
    insert_declaration::<AgentElicitationResponse>(&mut decls);
    insert_declaration::<AgentTerminalCreateRequest>(&mut decls);
    insert_declaration::<AgentTerminalEnvVar>(&mut decls);
    insert_declaration::<AgentTerminalOutputSnapshot>(&mut decls);
    insert_declaration::<AgentTerminalExit>(&mut decls);
    insert_declaration::<AgentFileReadRequest>(&mut decls);
    insert_declaration::<AgentFileWriteRequest>(&mut decls);
    insert_declaration::<ImportedAgentMessageRole>(&mut decls);
    insert_declaration::<ImportedAgentMessageMetadata>(&mut decls);
    insert_declaration::<ImportedAgentMessage>(&mut decls);
    insert_declaration::<ImportedAgentSession>(&mut decls);
    insert_declaration::<LocalHistorySessionStatus>(&mut decls);
    insert_declaration::<LocalHistoryScanSession>(&mut decls);
    insert_declaration::<LocalHistoryScanFolder>(&mut decls);
    insert_declaration::<LocalHistoryDestination>(&mut decls);
    insert_declaration::<LocalHistoryScanPage>(&mut decls);
    insert_declaration::<LocalHistoryScanProgress>(&mut decls);
    insert_declaration::<LocalHistoryImportSelection>(&mut decls);
    insert_declaration::<LocalHistoryImportResult>(&mut decls);
    insert_declaration::<LocalHistoryImportPhase>(&mut decls);
    insert_declaration::<LocalHistoryImportProgress>(&mut decls);
    insert_declaration::<LocalHistoryImportJobStatus>(&mut decls);
    insert_declaration::<LocalHistoryImportLogEntry>(&mut decls);
    insert_declaration::<LocalHistoryImportJobSnapshot>(&mut decls);
    insert_declaration::<RuntimeSnapshot>(&mut decls);
    insert_declaration::<TurnRole>(&mut decls);
    insert_declaration::<TurnUsage>(&mut decls);
    insert_declaration::<ImageData>(&mut decls);
    insert_declaration::<SubAgentToolCall>(&mut decls);
    insert_declaration::<AgentExecutionStats>(&mut decls);
    insert_declaration::<PlanEntry>(&mut decls);
    insert_declaration::<ContentBlock>(&mut decls);
    insert_declaration::<MessageTurn>(&mut decls);
    insert_declaration::<SessionStats>(&mut decls);
    insert_declaration::<ConversationSummary>(&mut decls);
    insert_declaration::<ConversationDetail>(&mut decls);
    insert_declaration::<AgentPromptCapabilities>(&mut decls);
    insert_declaration::<AuthenticationObservationState>(&mut decls);
    insert_declaration::<AuthenticationMethod>(&mut decls);
    insert_declaration::<AuthenticationSource>(&mut decls);
    insert_declaration::<AcpAuthenticationObservationSnapshot>(&mut decls);
    insert_declaration::<AcpCapabilitySnapshot>(&mut decls);
    insert_declaration::<ConversationInputBlock>(&mut decls);
    insert_declaration::<ConversationInputPayload>(&mut decls);
    insert_declaration::<ConversationFileRef>(&mut decls);
    insert_declaration::<ConversationInputEvent>(&mut decls);
    insert_declaration::<ConversationInputStatus>(&mut decls);
    insert_declaration::<ConversationInputView>(&mut decls);
    insert_declaration::<ConversationInputSubmission>(&mut decls);
    insert_declaration::<ConversationRelationView>(&mut decls);
    insert_declaration::<ConversationChildSummaryView>(&mut decls);
    insert_declaration::<ConversationRelationKind>(&mut decls);
    insert_declaration::<ConversationRelationVisibility>(&mut decls);
    insert_declaration::<ConversationSteeringEvent>(&mut decls);
    insert_declaration::<ConversationSteeringStatus>(&mut decls);
    insert_declaration::<ConversationSteeringReceipt>(&mut decls);
    insert_declaration::<ConversationLiveFeedbackNote>(&mut decls);
    insert_declaration::<ConversationPlanEntry>(&mut decls);
    insert_declaration::<ConversationFileLocation>(&mut decls);
    insert_declaration::<ConversationToolCallPatch>(&mut decls);
    insert_declaration::<ConversationPermissionRequest>(&mut decls);
    insert_declaration::<ConversationPermissionResponse>(&mut decls);
    insert_declaration::<ConversationQuestionRequest>(&mut decls);
    insert_declaration::<ConversationQuestionResponse>(&mut decls);
    insert_declaration::<ConversationFeedbackRequest>(&mut decls);
    insert_declaration::<ConversationFeedbackResponse>(&mut decls);
    insert_declaration::<ConversationTerminalPatch>(&mut decls);
    insert_declaration::<ConversationUsage>(&mut decls);
    insert_declaration::<ConversationFileChange>(&mut decls);
    insert_declaration::<ConversationFileChangeSummary>(&mut decls);
    insert_declaration::<ConversationTurnErrorKind>(&mut decls);
    insert_declaration::<ConversationError>(&mut decls);
    insert_declaration::<TurnBlockedReason>(&mut decls);
    insert_declaration::<SessionRecoveryStrategy>(&mut decls);
    insert_declaration::<SessionLoadFailureReason>(&mut decls);
    insert_declaration::<ConversationAgentConnectionStatus>(&mut decls);
    insert_declaration::<ConversationDelegation>(&mut decls);
    insert_declaration::<ConversationDelegationResult>(&mut decls);
    insert_declaration::<ConversationDelegationView>(&mut decls);
    insert_declaration::<ConversationArtifactReference>(&mut decls);
    insert_declaration::<ConversationArtifactPreviewReference>(&mut decls);
    insert_declaration::<ConversationWorkflowRef>(&mut decls);
    insert_declaration::<ConversationEvent>(&mut decls);
    insert_declaration::<ConversationEventEnvelope>(&mut decls);
    insert_declaration::<ConversationPermissionView>(&mut decls);
    insert_declaration::<ConversationTerminalView>(&mut decls);
    insert_declaration::<ConversationErrorView>(&mut decls);
    insert_declaration::<ConversationSessionNotice>(&mut decls);
    insert_declaration::<ConversationNoticeAction>(&mut decls);
    insert_declaration::<ConversationTimelineRow>(&mut decls);
    insert_declaration::<TimelineRow>(&mut decls);
    insert_declaration::<TimelineTextStream>(&mut decls);
    insert_declaration::<ConversationRowOp>(&mut decls);
    insert_declaration::<ConversationRowOpBatch>(&mut decls);
    insert_declaration::<ConversationRowPage>(&mut decls);
    insert_declaration::<ConversationSessionModes>(&mut decls);
    insert_declaration::<ConversationTimeline>(&mut decls);
    insert_declaration::<ConversationEventsPage>(&mut decls);
    insert_declaration::<ConversationTimelinePage>(&mut decls);
    insert_declaration::<ConversationBundleChecksum>(&mut decls);
    insert_declaration::<ConversationBundleManifest>(&mut decls);
    insert_declaration::<ConversationBundlePayload>(&mut decls);
    insert_declaration::<ConversationExportResult>(&mut decls);
    insert_declaration::<ConversationImportResult>(&mut decls);
    insert_declaration::<ConversationForkContinuity>(&mut decls);
    insert_declaration::<ConversationForkResult>(&mut decls);
    insert_declaration::<DbConversationSummary>(&mut decls);
    insert_declaration::<ConversationActiveBinding>(&mut decls);
    insert_declaration::<ConversationCurrentTurn>(&mut decls);
    insert_declaration::<DbConversationDetail>(&mut decls);
    insert_declaration::<ConversationTurnSnapshot>(&mut decls);
    insert_declaration::<ConversationOutputView>(&mut decls);
    insert_declaration::<OperationId>(&mut decls);
    insert_declaration::<SubscriptionId>(&mut decls);
    insert_declaration::<ConversationId>(&mut decls);
    insert_declaration::<ErrorCode>(&mut decls);
    insert_declaration::<ErrorEnvelope>(&mut decls);
    insert_declaration::<CapabilityId>(&mut decls);
    insert_declaration::<ReachabilityOrigin>(&mut decls);
    insert_declaration::<ServerCapabilities>(&mut decls);
    insert_declaration::<WorkflowDefinition>(&mut decls);
    insert_declaration::<WorkflowStep>(&mut decls);
    insert_declaration::<WorkflowStepSpec>(&mut decls);
    insert_declaration::<AgentStepSpec>(&mut decls);
    insert_declaration::<ApprovalStepSpec>(&mut decls);
    insert_declaration::<NotifyStepSpec>(&mut decls);
    insert_declaration::<CompletionPolicy>(&mut decls);
    insert_declaration::<WorkflowBinding>(&mut decls);
    insert_declaration::<WorkspaceAccess>(&mut decls);
    insert_declaration::<SideEffectClass>(&mut decls);
    insert_declaration::<WorkflowPolicy>(&mut decls);
    insert_declaration::<WorkflowRunStatus>(&mut decls);
    insert_declaration::<DebugRunScope>(&mut decls);
    insert_declaration::<WorkflowStepStatus>(&mut decls);
    insert_declaration::<WorkflowEvent>(&mut decls);
    insert_declaration::<WorkflowReviewDecision>(&mut decls);
    insert_declaration::<WorkflowValidationView>(&mut decls);
    insert_declaration::<WorkflowVersionView>(&mut decls);
    insert_declaration::<WorkflowDefinitionSummary>(&mut decls);
    insert_declaration::<WorkflowRunView>(&mut decls);
    insert_declaration::<WorkflowStepView>(&mut decls);
    insert_declaration::<WorkflowEventRecord>(&mut decls);
    insert_declaration::<ClaimedWorkflowStep>(&mut decls);
    insert_declaration::<SubscriptionRequest>(&mut decls);
    insert_declaration::<SubscriptionResource>(&mut decls);
    insert_declaration::<RemoteEvent>(&mut decls);
    insert_declaration::<SubscriptionSnapshot>(&mut decls);
    insert_declaration::<SubscriptionBootstrap>(&mut decls);
    decls
}

fn insert_declaration<T: TS>(decls: &mut BTreeMap<String, String>) {
    let name = T::ident();
    let declaration = format!("export {}", T::decl().trim());
    let declaration = trim_trailing_line_whitespace(&declaration);
    decls.insert(name, declaration);
}

fn trim_trailing_line_whitespace(content: &str) -> String {
    content
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_declarations(content: &str) -> (String, Vec<Declaration>) {
    let lines: Vec<&str> = content.lines().collect();
    let mut starts: Vec<(usize, String)> = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        if let Some(name) = declaration_name(line) {
            starts.push((index, name.to_string()));
        }
    }

    if starts.is_empty() {
        return (content.trim().to_string(), Vec::new());
    }

    let header = lines[..starts[0].0].join("\n").trim().to_string();
    let mut declarations = Vec::with_capacity(starts.len());

    for i in 0..starts.len() {
        let (start_index, name) = &starts[i];
        let end_index = if i + 1 < starts.len() {
            starts[i + 1].0
        } else {
            lines.len()
        };
        let decl = lines[*start_index..end_index].join("\n").trim().to_string();
        declarations.push(Declaration {
            name: name.clone(),
            content: decl,
        });
    }

    (header, declarations)
}

fn declaration_name(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix("export type ")
        .or_else(|| trimmed.strip_prefix("export enum "))?;
    let end = rest
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .unwrap_or(rest.len());
    if end == 0 { None } else { Some(&rest[..end]) }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_types_include_open_agent_identity_contract() {
        let declarations = replacement_declarations();

        for name in [
            "AgentId",
            "AgentSource",
            "AgentLifecycleState",
            "AgentAuthenticationStatus",
            "AgentManagementIdentity",
            "AgentManagementView",
            "AgentRegistryView",
            "CommunityAcpPresetView",
            "AgentOperationEvent",
            "AgentManagementErrorView",
        ] {
            assert!(
                declarations.contains_key(name),
                "missing generated declaration {name}"
            );
        }
    }

    #[test]
    fn adding_open_agent_types_is_idempotent_in_one_generation() {
        let existing =
            format!("{HEADER}\n\nexport type AgentKind = \"claude_code\" | \"codex\";\n");

        let once = render_merged_types(&existing);
        let twice = render_merged_types(&once);

        assert_eq!(once, twice);
    }

    #[test]
    fn generation_removes_the_legacy_commit_reminder_prompt_constant() {
        let existing = "export type ResetMode = \"soft\";\n\nexport const DEFAULT_COMMIT_REMINDER_PROMPT =\n  \"legacy\";\n\nexport const DEFAULT_MERGE_COMMIT_MESSAGE_TEMPLATE =\n  \"merge\";\n\nexport type Config = {};\n";

        let generated = render_merged_types(existing);

        assert!(!generated.contains("DEFAULT_COMMIT_REMINDER_PROMPT"));
        assert!(generated.contains("DEFAULT_MERGE_COMMIT_MESSAGE_TEMPLATE"));
    }
}
