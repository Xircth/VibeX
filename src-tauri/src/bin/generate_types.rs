use std::{collections::BTreeMap, path::PathBuf, process::ExitCode};

use agents::{
    AgentAutoApproveMode, AgentAvailableCommand, AgentCapability, AgentConnectionId,
    AgentConnectionSnapshot, AgentConnectionStatus, AgentContentBlock, AgentElicitationId,
    AgentElicitationRequest, AgentElicitationResponse, AgentErrorEvent, AgentEvent,
    AgentEventEnvelope, AgentFileReadRequest, AgentFileWriteRequest, AgentListedSession,
    AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind, AgentPermissionRequest,
    AgentPermissionResponse, AgentPlan, AgentPreparedSessionSnapshot, AgentPromptFinished,
    AgentPromptId, AgentPromptSnapshot, AgentPromptStatus, AgentSessionConfigChoice,
    AgentSessionConfigDependency, AgentSessionConfigOption, AgentSessionConfigOverride,
    AgentSessionControlsSnapshot, AgentSessionId, AgentSessionListPage, AgentSessionMode,
    AgentSessionSnapshot, AgentSessionStatus, AgentTerminalCreateRequest, AgentTerminalEnvVar,
    AgentTerminalExit, AgentTerminalId, AgentTerminalOutput, AgentTerminalOutputSnapshot,
    AgentTerminalSnapshot, AgentToolCall, AgentToolCallUpdate, AgentUsage, AuthenticationMethod,
    AuthenticationObservationState, AuthenticationSource, DelegationResultSummary,
    ImportedAgentMessage, ImportedAgentMessageRole, ImportedAgentSession, RuntimeSnapshot,
    conversation::{
        AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentExecutionStats,
        AgentPromptCapabilities, ContentBlock, ConversationAgentConnectionStatus,
        ConversationArtifactPreviewReference, ConversationArtifactReference,
        ConversationBundleChecksum, ConversationBundleManifest, ConversationBundlePayload,
        ConversationDelegation, ConversationDelegationResult, ConversationDelegationView,
        ConversationDetail, ConversationError, ConversationErrorView, ConversationEvent,
        ConversationEventEnvelope, ConversationEventsPage, ConversationFeedbackRequest,
        ConversationFeedbackResponse, ConversationFileChange, ConversationFileChangeSummary,
        ConversationFileLocation, ConversationInputBlock, ConversationPermissionRequest,
        ConversationPermissionResponse, ConversationPermissionView, ConversationPlanEntry,
        ConversationPluginActionInvocation, ConversationQuestionRequest,
        ConversationQuestionResponse, ConversationRowOp, ConversationRowOpBatch,
        ConversationRowPage, ConversationSessionModes, ConversationSessionNotice,
        ConversationSummary, ConversationTerminalPatch, ConversationTerminalView,
        ConversationTimeline, ConversationTimelinePage, ConversationTimelineRow,
        ConversationToolCallPatch, ConversationUsage, ImageData, MessageTurn, PlanEntry,
        SessionLoadFailureReason, SessionRecoveryStrategy, SessionStats, SubAgentToolCall,
        TimelineRow, TimelineTextStream, TurnBlockedReason, TurnRole, TurnUsage,
    },
};
use api_types::{
    AgentAuthenticationStatus, AgentDiagnosticView, AgentId, AgentKind, AgentLifecycleState,
    AgentManagementErrorCode, AgentManagementErrorView, AgentManagementIdentity,
    AgentManagementView, AgentNativeConfigFieldKind, AgentNativeConfigFieldView,
    AgentNativeConfigFileView, AgentNativeConfigFormat, AgentNativeConfigOptionView,
    AgentNativeConfigPatchRequest, AgentNativeConfigView, AgentOperationEvent, AgentOperationKind,
    AgentOperationReceipt, AgentOperationStatus, AgentPreflightItemView, AgentPreflightView,
    AgentRegistryView, AgentRegistryViewRow, AgentSource, AgentUpdateCheckView,
    UserAgentDefinitionRequest, UserAgentDefinitionView, UserAgentDistributionKind,
    UserAgentDistributionView, UserAgentEnvironmentVariableView, UserAgentIntegrityKind,
};
use conversations::ConversationSearchHit;
use db::models::{
    automation::{Automation, AutomationInput, AutomationRun},
    chat_channel_message_log::ChatChannelMessageLog,
    conversation::DbConversationSummary,
    execution_process::ExecutionProcessRunReason,
    scratch::DraftFollowUpData,
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskRelationships, TaskStatus, TaskWithAttemptStatus, UpdateTask},
    workspace::{Workspace, WorkspaceWithStatus},
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};
use executors::{
    executors::{SlashCommandDescription, SlashCommandKind},
    logs::{ActionType, utils::shell_command_parsing::CommandCategory},
    profile::ExecutorProfileId,
};
use git::{GitBranch, StashEntry};
use remote_protocol::{
    CapabilityId, ConversationId, ErrorCode, ErrorEnvelope, OperationId, RemoteEvent,
    ServerCapabilities, SubscriptionBootstrap, SubscriptionId, SubscriptionRequest,
    SubscriptionResource, SubscriptionSnapshot,
};
use services::services::config::{Config, LinkOpenBehavior};
use ts_rs::TS;
use vibex::{
    commands::{
        attention::{AttentionInbox, AttentionItem, AttentionItemKind},
        conversations::{ConversationActiveBinding, ConversationCurrentTurn, DbConversationDetail},
        crash_reports::{CrashReportMeta, CrashReportsInfo},
        office_tools::{
            ArtifactPreviewLeaseDto, OfficeArtifactIntent, OfficeComponentReadiness,
            OfficePluginAction, OfficePluginCatalog, OfficePluginIdentity, OfficePluginReadiness,
            OfficePromptBlock,
        },
        sessions::{SessionContinuityMode, SessionSummary},
    },
    conversation_bundle::{ConversationExportResult, ConversationImportResult},
    conversation_service::ConversationTurnSnapshot,
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
    let shared_types_path = workspace_root().join("shared").join("types.ts");
    let current_raw = std::fs::read_to_string(&shared_types_path)
        .map_err(|error| format!("failed to read {}: {error}", shared_types_path.display()))?;
    let line_ending = if current_raw.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };

    let current = normalize_newlines(&current_raw);
    let generated = render_merged_types(&current);

    if current == generated {
        println!("shared/types.ts is up to date");
        return Ok(ExitCode::SUCCESS);
    }

    if check {
        eprintln!("shared/types.ts is out of date. Run `pnpm run generate-types`.");
        return Ok(ExitCode::from(1));
    }

    let output = if line_ending == "\r\n" {
        generated.replace('\n', "\r\n")
    } else {
        generated
    };

    std::fs::write(&shared_types_path, output)
        .map_err(|error| format!("failed to write {}: {error}", shared_types_path.display()))?;
    println!("updated {}", shared_types_path.display());

    Ok(ExitCode::SUCCESS)
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri should have a parent workspace directory")
        .to_path_buf()
}

fn render_merged_types(existing: &str) -> String {
    let (_, existing_decls) = parse_declarations(existing);
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
            "PlanUsageWindow",
            "PlanCredits",
            "AgentPlanUsage",
            "PlanUsageUnavailableReason",
            "PlanUsageResult",
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
        ])
    })
}

fn replacement_declarations() -> BTreeMap<String, String> {
    let mut decls = BTreeMap::new();
    insert_declaration::<SessionStatus>(&mut decls);
    insert_declaration::<Session>(&mut decls);
    insert_declaration::<CreateSession>(&mut decls);
    insert_declaration::<SessionContinuityMode>(&mut decls);
    insert_declaration::<SessionSummary>(&mut decls);
    insert_declaration::<Config>(&mut decls);
    insert_declaration::<LinkOpenBehavior>(&mut decls);
    insert_declaration::<DraftFollowUpData>(&mut decls);
    insert_declaration::<ExecutorProfileId>(&mut decls);
    insert_declaration::<ActionType>(&mut decls);
    insert_declaration::<CommandCategory>(&mut decls);
    // Temporary compatibility enum while live session identity migrates to the
    // open AgentId contract.
    insert_declaration::<AgentKind>(&mut decls);
    insert_declaration::<AgentId>(&mut decls);
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
    insert_declaration::<AgentManagementView>(&mut decls);
    insert_declaration::<AgentRegistryViewRow>(&mut decls);
    insert_declaration::<AgentRegistryView>(&mut decls);
    insert_declaration::<AgentUpdateCheckView>(&mut decls);
    insert_declaration::<AgentOperationEvent>(&mut decls);
    insert_declaration::<AgentManagementErrorCode>(&mut decls);
    insert_declaration::<AgentManagementErrorView>(&mut decls);
    insert_declaration::<AgentPreflightItemView>(&mut decls);
    insert_declaration::<AgentPreflightView>(&mut decls);
    insert_declaration::<AgentNativeConfigOptionView>(&mut decls);
    insert_declaration::<AgentNativeConfigFieldKind>(&mut decls);
    insert_declaration::<AgentNativeConfigFieldView>(&mut decls);
    insert_declaration::<AgentNativeConfigFormat>(&mut decls);
    insert_declaration::<AgentNativeConfigFileView>(&mut decls);
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
    insert_declaration::<ConversationSearchHit>(&mut decls);
    insert_declaration::<Automation>(&mut decls);
    insert_declaration::<AutomationInput>(&mut decls);
    insert_declaration::<AutomationRun>(&mut decls);
    insert_declaration::<OfficePromptBlock>(&mut decls);
    insert_declaration::<OfficeArtifactIntent>(&mut decls);
    insert_declaration::<OfficePluginAction>(&mut decls);
    insert_declaration::<OfficePluginIdentity>(&mut decls);
    insert_declaration::<OfficeComponentReadiness>(&mut decls);
    insert_declaration::<OfficePluginReadiness>(&mut decls);
    insert_declaration::<OfficePluginCatalog>(&mut decls);
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
    insert_declaration::<AgentUsage>(&mut decls);
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
    insert_declaration::<ImportedAgentMessage>(&mut decls);
    insert_declaration::<ImportedAgentSession>(&mut decls);
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
    insert_declaration::<ConversationPluginActionInvocation>(&mut decls);
    insert_declaration::<ConversationEvent>(&mut decls);
    insert_declaration::<ConversationEventEnvelope>(&mut decls);
    insert_declaration::<ConversationPermissionView>(&mut decls);
    insert_declaration::<ConversationTerminalView>(&mut decls);
    insert_declaration::<ConversationErrorView>(&mut decls);
    insert_declaration::<ConversationSessionNotice>(&mut decls);
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
    insert_declaration::<DbConversationSummary>(&mut decls);
    insert_declaration::<ConversationActiveBinding>(&mut decls);
    insert_declaration::<ConversationCurrentTurn>(&mut decls);
    insert_declaration::<DbConversationDetail>(&mut decls);
    insert_declaration::<ConversationTurnSnapshot>(&mut decls);
    insert_declaration::<OperationId>(&mut decls);
    insert_declaration::<SubscriptionId>(&mut decls);
    insert_declaration::<ConversationId>(&mut decls);
    insert_declaration::<ErrorCode>(&mut decls);
    insert_declaration::<ErrorEnvelope>(&mut decls);
    insert_declaration::<CapabilityId>(&mut decls);
    insert_declaration::<ServerCapabilities>(&mut decls);
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
}
