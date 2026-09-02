use std::sync::Arc;

use async_trait::async_trait;
use conversations::{
    CancelConversationInput, ConversationInputSubmission, ConversationInputView,
    ConversationRelationView, ConversationSteerInput, ConversationSteeringReceipt,
    ConversationTurnSnapshot, CreateForkConversation, ReorderConversationInput,
    SubmitConversationInput, UpdateConversationInput, create_fork_conversation,
};
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
    conversation_event::ConversationEventRecord,
    conversation_turn::ConversationTurnRecord,
};
use remote_protocol::{
    ConversationId, NotificationOutcome, NotificationSource, OfflineConversationCache, OperationId,
    RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionSnapshot,
    TerminalNotificationSummary,
};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    AcceptWorkflowCandidateRequest, ApplicationDomainPort, ApplicationError, CancelWorkflowRequest,
    CompleteWorkflowStepRequest, DebugWorkflowRequest, DecideWorkflowRequest, DomainCommand,
    ForkWorkflowRequest, NotificationProjector, PauseWorkflowRequest, PauseWorkflowStepRequest,
    Principal, PublishWorkflowRequest, ResumePausedWorkflowRequest, ResumeWorkflowRequest,
    StartWorkflowRequest, SubmitWorkflowStepInputRequest, TerminalNotificationEvidence,
    ValidateWorkflowRequest, WorkflowDefinitionSummary, WorkflowEventRecord, WorkflowExecutionPort,
    WorkflowRunView, WorkflowStepView, WorkflowValidationView, WorkflowVersionView,
    domain::unavailable_domains, workflow::UnavailableWorkflowExecution,
};

const READ_CONVERSATIONS_SCOPE: &str = "conversation.read";
const WRITE_CONVERSATIONS_SCOPE: &str = "conversation.write";
const ATTACH_CONVERSATIONS_SCOPE: &str = "conversation.attach";
const RESPOND_PERMISSION_SCOPE: &str = "conversation.permission";
const RESPOND_QUESTION_SCOPE: &str = "conversation.question";
const CANCEL_CONVERSATION_SCOPE: &str = "conversation.cancel";
const STEER_CONVERSATION_SCOPE: &str = "conversation.steer";
const LIVE_FEEDBACK_SCOPE: &str = "conversation.steer";
const OFFLINE_READ_SCOPE: &str = "offline.read";
const NOTIFICATION_SUMMARY_SCOPE: &str = "notification.summary";
const MAX_OFFLINE_EVENTS: i64 = 10_000;
const MAX_LIVE_EVENTS: i64 = 500;

#[derive(sqlx::FromRow)]
struct ProjectCatalogRow {
    id: Uuid,
    name: String,
    path: String,
}

#[derive(sqlx::FromRow)]
struct WorkspaceCatalogRow {
    id: Uuid,
    project_id: Uuid,
    name: Option<String>,
    branch: String,
}

#[derive(sqlx::FromRow)]
struct AgentCatalogRow {
    agent_id: String,
    enabled: bool,
    retained_icon_svg: Option<String>,
    display_name: Option<String>,
    lifecycle: Option<String>,
    authentication: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AgentBindingConfigRow {
    config_options_json: Option<String>,
    modes_json: Option<String>,
    current_mode: Option<String>,
}

pub(crate) fn catalog_agent_usable(
    enabled: bool,
    lifecycle: Option<&str>,
    authentication: Option<&str>,
) -> bool {
    if !enabled {
        return false;
    }
    let authentication = authentication.unwrap_or("").trim();
    if matches!(authentication, "not_logged_in" | "multiple_unknown") {
        return false;
    }
    match lifecycle.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("ready") => true,
        Some(_) => false,
    }
}

fn catalog_agent_from_row(row: AgentCatalogRow) -> ConversationCatalogAgent {
    let lifecycle = row.lifecycle.filter(|value| !value.is_empty());
    let authentication = row.authentication.filter(|value| !value.is_empty());
    ConversationCatalogAgent {
        id: row.agent_id,
        ready: row.enabled,
        usable: catalog_agent_usable(row.enabled, lifecycle.as_deref(), authentication.as_deref()),
        lifecycle,
        authentication,
        display_name: row.display_name.filter(|value| !value.is_empty()),
        icon_svg: row.retained_icon_svg.filter(|value| !value.is_empty()),
        current_mode: None,
        session_config: None,
        session_modes: None,
        session_config_json: None,
        session_modes_json: None,
    }
}

#[cfg(test)]
mod catalog_agent_usable_tests {
    use super::catalog_agent_usable;

    #[test]
    fn ready_account_is_usable() {
        assert!(catalog_agent_usable(true, Some("ready"), Some("account")));
        assert!(catalog_agent_usable(true, Some("ready"), Some("api_key")));
        assert!(catalog_agent_usable(
            true,
            Some("ready"),
            Some("not_required")
        ));
    }

    #[test]
    fn login_and_environment_failures_are_not_usable() {
        assert!(!catalog_agent_usable(
            true,
            Some("ready"),
            Some("not_logged_in")
        ));
        assert!(!catalog_agent_usable(true, Some("needs_auth"), None));
        assert!(!catalog_agent_usable(
            true,
            Some("needs_repair"),
            Some("api_key")
        ));
        assert!(!catalog_agent_usable(true, Some("uninstalled"), None));
    }

    #[test]
    fn missing_probe_does_not_block_an_enabled_agent() {
        assert!(catalog_agent_usable(true, None, None));
    }

    #[test]
    fn disabled_is_not_usable() {
        assert!(!catalog_agent_usable(false, Some("ready"), Some("account")));
    }
}

#[cfg(test)]
mod slash_commands_from_skills_tests {
    use agents::skills::{AgentSkillItem, AgentSkillScope};

    use super::{
        ConversationSlashCommand, slash_commands_from_available, slash_commands_from_skills,
    };

    #[test]
    fn maps_live_available_commands_to_slash_values() {
        let commands = slash_commands_from_available(&[agents::AgentAvailableCommand {
            name: "/compact".into(),
            description: Some("Compact context".into()),
            input_schema: None,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "compact".into(),
                description: Some("Compact context".into()),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: "compact".into(),
                value: "/compact".into(),
            }]
        );
    }

    #[test]
    fn maps_codex_dollar_skills_to_dollar_values() {
        let commands = slash_commands_from_available(&[agents::AgentAvailableCommand {
            name: "$deploy".into(),
            description: Some("Deploy skill".into()),
            input_schema: None,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "deploy".into(),
                description: Some("Deploy skill".into()),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: "deploy".into(),
                value: "$deploy".into(),
            }]
        );
    }

    #[test]
    fn maps_skill_id_and_path_to_desktop_slash_value() {
        let commands = slash_commands_from_skills(&[AgentSkillItem {
            id: "office-xlsx".into(),
            scope: AgentSkillScope::Global,
            path: "/Users/mac/.agents/skills/office-xlsx".into(),
            description: Some("Excel".into()),
            read_only: true,
        }]);
        assert_eq!(
            commands,
            vec![ConversationSlashCommand {
                name: "office-xlsx".into(),
                description: Some("Excel".into()),
                kind: "skill".into(),
                source_kind: "skill".into(),
                source_id: "/Users/mac/.agents/skills/office-xlsx".into(),
                value: "/office-xlsx".into(),
            }]
        );
    }
}

fn parse_json_value(raw: Option<&str>) -> Option<serde_json::Value> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn builtin_catalog_tags() -> Vec<ConversationCatalogTag> {
    vec![
        ConversationCatalogTag {
            id: "builtin:start-project-dev-server".into(),
            name: "启动项目开发服务器".into(),
            content: "分析当前项目并识别正确的开发服务器启动方式；必要时检查或安装依赖并修复基础环境问题；成功启动后验证服务可访问，再把可访问的本地 URL 直接告诉我。".into(),
        },
        ConversationCatalogTag {
            id: "builtin:review-changes".into(),
            name: "审查变更".into(),
            content: "请审查当前工作区的所有未提交代码变更。优先指出可能的 Bug、行为回归、可维护性问题、性能问题和测试缺口；按严重程度排序，尽量附上文件和行号。若没有发现问题，请明确说明未发现高风险问题，并列出仍未验证的风险。".into(),
        },
    ]
}

fn require_workflow_run(principal: &Principal) -> Result<(), ApplicationError> {
    if principal.allows("workflow.run") {
        Ok(())
    } else {
        Err(ApplicationError::forbidden("principal lacks workflow.run"))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListConversations {
    pub workspace_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListRecentConversations {
    pub since_days: i64,
    pub project_id: Option<Uuid>,
    pub limit: i64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogProject {
    pub id: Uuid,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogWorkspace {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub branch: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogAgent {
    pub id: String,
    pub ready: bool,
    #[serde(default)]
    pub usable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_svg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes_json: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalogTag {
    pub id: String,
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWorkspaceEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSlashCommand {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: String,
    pub source_kind: String,
    pub source_id: String,
    pub value: String,
}

fn slash_commands_from_available(
    commands: &[agents::AgentAvailableCommand],
) -> Vec<ConversationSlashCommand> {
    commands
        .iter()
        .filter_map(|command| {
            let raw = command.name.trim().trim_start_matches('/');
            let (name, value) = if let Some(skill) = raw.strip_prefix('$') {
                (skill.to_string(), format!("${skill}"))
            } else {
                (raw.to_string(), format!("/{raw}"))
            };
            if name.is_empty() {
                return None;
            }
            Some(ConversationSlashCommand {
                name: name.clone(),
                description: command
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                kind: "command".into(),
                source_kind: "runtime".into(),
                source_id: name,
                value,
            })
        })
        .collect()
}

#[cfg(test)]
fn slash_commands_from_skills(
    skills: &[agents::skills::AgentSkillItem],
) -> Vec<ConversationSlashCommand> {
    skills
        .iter()
        .filter_map(|skill| {
            let name = skill.id.trim().trim_start_matches('/').to_string();
            if name.is_empty() {
                return None;
            }
            Some(ConversationSlashCommand {
                name: name.clone(),
                description: skill
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                kind: "skill".into(),
                source_kind: "skill".into(),
                source_id: skill.path.clone(),
                value: format!("/{name}"),
            })
        })
        .collect()
}

#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCatalog {
    pub projects: Vec<ConversationCatalogProject>,
    pub workspaces: Vec<ConversationCatalogWorkspace>,
    pub agents: Vec<ConversationCatalogAgent>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<ConversationCatalogTag>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateConversation {
    pub workspace_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreateConversationWorkspace {
    pub project_id: Uuid,
    pub name: String,
    pub branch: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChildConversationRequest {
    pub parent_conversation_id: Uuid,
    pub agent_id: String,
    pub title: Option<String>,
    pub initial_prompt: Option<String>,
    #[serde(default = "default_child_visibility")]
    pub visible: bool,
}

const fn default_child_visibility() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartConversationTurn {
    pub agent_id: String,
    pub workspace_id: Uuid,
    pub conversation_id: Uuid,
    pub executor_profile_id: Option<serde_json::Value>,
    pub text: String,
    pub images: Vec<String>,
    pub mode_override: Option<String>,
    pub config_overrides: Vec<serde_json::Value>,
    #[serde(default, alias = "pluginActions")]
    pub workflow_refs: Vec<crate::ConversationWorkflowRef>,
    #[serde(default)]
    pub operation_id: Option<uuid::Uuid>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondConversationPermission {
    pub conversation_id: Uuid,
    pub permission_id: String,
    pub response: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondConversationQuestion {
    pub conversation_id: Uuid,
    pub question_id: String,
    pub response: serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationTurn {
    pub conversation_id: Uuid,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerConversationTurnRequest {
    pub conversation_id: Uuid,
    pub expected_turn_id: Uuid,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConversationFeedback {
    pub conversation_id: Uuid,
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationFeedbackRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationLiveFeedbackNote {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub status: String,
    pub delivered_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitConversationInputRequest {
    pub conversation_id: Uuid,
    pub payload: agents::ConversationInputPayload,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub payload: agents::ConversationInputPayload,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
    pub sort_key: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversationInputRequest {
    pub conversation_id: Uuid,
    pub input_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationInputsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationRelationsRequest {
    pub conversation_id: Uuid,
}

#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ConversationOutputView {
    pub conversation_id: Uuid,
    pub turn: Option<ConversationTurnSnapshot>,
    pub assistant_text: Option<String>,
}

#[async_trait]
pub trait ConversationExecutionPort: Send + Sync {
    async fn start_turn(
        &self,
        request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError>;

    async fn respond_permission(
        &self,
        _request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation permission response is not configured",
        ))
    }

    async fn respond_question(
        &self,
        _request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation question response is not configured",
        ))
    }

    async fn cancel_turn(&self, _request: CancelConversationTurn) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation cancellation is not configured",
        ))
    }

    async fn steer(
        &self,
        _request: ConversationSteerInput,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation steering is not configured",
        ))
    }

    async fn submit_input(
        &self,
        _request: SubmitConversationInput,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input submission is not configured",
        ))
    }

    async fn list_inputs(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input listing is not configured",
        ))
    }

    async fn list_relations(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation relation listing is not configured",
        ))
    }

    async fn update_input(
        &self,
        _request: UpdateConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input update is not configured",
        ))
    }

    async fn reorder_input(
        &self,
        _request: ReorderConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input reorder is not configured",
        ))
    }

    async fn cancel_input(
        &self,
        _request: CancelConversationInput,
    ) -> Result<ConversationInputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation input cancellation is not configured",
        ))
    }

    async fn set_session_mode(
        &self,
        _conversation_id: Uuid,
        _mode_id: String,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "session mode is not configured",
        ))
    }

    async fn set_session_config_option(
        &self,
        _conversation_id: Uuid,
        _key: String,
        _value: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "session config is not configured",
        ))
    }

    async fn submit_feedback(
        &self,
        _request: SubmitConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback is not configured",
        ))
    }

    async fn list_feedback(
        &self,
        _conversation_id: Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "live feedback is not configured",
        ))
    }
}

#[async_trait]
pub trait CompanionSessionPort: Send + Sync {
    async fn submit_feedback(
        &self,
        conversation_id: Uuid,
        text: &str,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError>;

    async fn list_feedback(
        &self,
        conversation_id: Uuid,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError>;

    async fn answer_question(
        &self,
        conversation_id: Uuid,
        question_id: &str,
        response: agents::AgentElicitationResponse,
    ) -> Result<bool, ApplicationError>;

    async fn clear_turn(&self, conversation_id: Uuid);
}

struct UnavailableConversationExecution;

#[async_trait]
impl ConversationExecutionPort for UnavailableConversationExecution {
    async fn start_turn(
        &self,
        _request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn respond_permission(
        &self,
        _request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn respond_question(
        &self,
        _request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }

    async fn cancel_turn(&self, _request: CancelConversationTurn) -> Result<(), ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation execution is not configured",
        ))
    }
}

#[async_trait]
pub trait ConversationRepository: Send + Sync {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError>;

    async fn list_recent(
        &self,
        _request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn catalog(&self) -> Result<ConversationCatalog, ApplicationError> {
        Ok(ConversationCatalog::default())
    }

    async fn workspace_entries(
        &self,
        _workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn slash_commands(
        &self,
        _agent_id: String,
        _workspace_id: Option<Uuid>,
        _conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        Ok(Vec::new())
    }

    async fn archive(&self, _conversation_id: Uuid) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn set_pinned(
        &self,
        _conversation_id: Uuid,
        _pinned: bool,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn delete(&self, _conversation_id: Uuid) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn rename(&self, _conversation_id: Uuid, _title: String) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn set_status(
        &self,
        _conversation_id: Uuid,
        _status: String,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }

    async fn create_workspace(
        &self,
        _request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "workspace creation is not configured",
        ))
    }

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError>;

    async fn create_child(
        &self,
        _operation_id: Uuid,
        _request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation child creation is not configured",
        ))
    }

    async fn output(
        &self,
        _conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "conversation output is not configured",
        ))
    }

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError>;

    async fn offline_cache(
        &self,
        _conversation_id: ConversationId,
        _after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "offline conversation reads are not configured",
        ))
    }

    async fn terminal_notification(
        &self,
        _conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        Err(ApplicationError::capability_unavailable(
            "terminal notification summaries are not configured",
        ))
    }
}

/// Adapter-owned live stream registration. Implementations must make future
/// events observable before returning, so the durable snapshot taken
/// afterwards closes the attach race without depending on a UI runtime.
#[async_trait]
pub trait ConversationSubscriptionRegistrar: Send + Sync {
    async fn register(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
    ) -> Result<(), ApplicationError>;
}

#[derive(Clone)]
pub struct SqliteConversationRepository {
    pool: SqlitePool,
}

impl SqliteConversationRepository {
    pub const fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    async fn workspace_root(&self, workspace_id: Uuid) -> Result<Option<String>, ApplicationError> {
        let row = sqlx::query_as::<_, (Option<String>, Option<String>, String)>(
            r#"SELECT w.agent_working_dir,
                      w.container_ref,
                      COALESCE(
                        NULLIF(TRIM(p.default_agent_working_dir), ''),
                        (
                          SELECT r.path
                          FROM project_repos pr
                          JOIN repos r ON r.id = pr.repo_id
                          WHERE pr.project_id = p.id
                          LIMIT 1
                        ),
                        ''
                      ) AS project_path
               FROM workspaces w
               JOIN projects p ON p.id = w.project_id
               WHERE w.id = ?"#,
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let Some((working_dir, container_ref, project_path)) = row else {
            return Ok(None);
        };
        let root = [
            working_dir.as_deref(),
            container_ref.as_deref(),
            Some(project_path.as_str()),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty() && std::path::Path::new(value).is_dir())
        .unwrap_or(project_path.as_str())
        .to_string();
        Ok(Some(root))
    }
}

#[async_trait]
impl ConversationRepository for SqliteConversationRepository {
    async fn list_for_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        DbConversationSummary::list_for_workspace(&self.pool, workspace_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn list_recent(
        &self,
        request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        DbConversationSummary::list_recent(
            &self.pool,
            request.since_days,
            request.project_id,
            request.limit,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn catalog(&self) -> Result<ConversationCatalog, ApplicationError> {
        let projects = sqlx::query_as::<_, ProjectCatalogRow>(
            r#"SELECT p.id AS id,
                      p.name AS name,
                      COALESCE(
                        NULLIF(TRIM(p.default_agent_working_dir), ''),
                        (
                          SELECT r.path
                          FROM project_repos pr
                          JOIN repos r ON r.id = pr.repo_id
                          WHERE pr.project_id = p.id
                          LIMIT 1
                        ),
                        ''
                      ) AS path
               FROM projects p
               ORDER BY p.updated_at DESC, p.created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .into_iter()
        .map(|project| ConversationCatalogProject {
            id: project.id,
            name: project.name,
            path: project.path,
        })
        .collect();
        let workspaces = sqlx::query_as::<_, WorkspaceCatalogRow>(
            r#"SELECT id, project_id, name, branch
               FROM workspaces
               WHERE archived = 0
               ORDER BY updated_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .into_iter()
        .map(|row| ConversationCatalogWorkspace {
            id: row.id,
            project_id: row.project_id,
            name: row
                .name
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| row.branch.clone()),
            branch: row.branch,
        })
        .collect();
        let mut agents = sqlx::query_as::<_, AgentCatalogRow>(
            r#"SELECT m.agent_id AS agent_id,
                      m.enabled AS enabled,
                      m.retained_icon_svg AS retained_icon_svg,
                      json_extract(m.retained_metadata_json, '$.name') AS display_name,
                      i.lifecycle AS lifecycle,
                      p.authentication AS authentication
               FROM agent_membership m
               LEFT JOIN agent_installation i ON i.agent_id = m.agent_id
               LEFT JOIN agent_probe p ON p.agent_id = m.agent_id
               WHERE m.retired = 0
               ORDER BY m.position ASC, m.agent_id ASC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .into_iter()
        .map(catalog_agent_from_row)
        .collect::<Vec<_>>();
        if agents.is_empty() {
            agents = sqlx::query_as::<_, AgentCatalogRow>(
                r#"SELECT s.agent_id AS agent_id,
                          1 AS enabled,
                          NULL AS retained_icon_svg,
                          NULL AS display_name,
                          i.lifecycle AS lifecycle,
                          p.authentication AS authentication
                   FROM (
                     SELECT DISTINCT agent_id
                     FROM sessions
                     WHERE agent_id IS NOT NULL AND TRIM(agent_id) != '' AND deleted_at IS NULL
                   ) s
                   LEFT JOIN agent_installation i ON i.agent_id = s.agent_id
                   LEFT JOIN agent_probe p ON p.agent_id = s.agent_id
                   ORDER BY s.agent_id"#,
            )
            .fetch_all(&self.pool)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .into_iter()
            .map(catalog_agent_from_row)
            .collect();
        }
        for agent in &mut agents {
            if let Ok(Some(row)) = sqlx::query_as::<_, AgentBindingConfigRow>(
                r#"SELECT config_options_json, modes_json, current_mode
                   FROM conversation_agent_bindings
                   WHERE agent_id = ?
                   ORDER BY updated_at DESC
                   LIMIT 1"#,
            )
            .bind(&agent.id)
            .fetch_optional(&self.pool)
            .await
            {
                agent.current_mode = row.current_mode.filter(|value| !value.is_empty());
                agent.session_config = parse_json_value(
                    row.config_options_json
                        .as_deref()
                        .filter(|value| !value.is_empty() && *value != "[]"),
                );
                agent.session_modes = parse_json_value(
                    row.modes_json
                        .as_deref()
                        .filter(|value| !value.is_empty() && *value != "[]"),
                );
                agent.session_config_json = row
                    .config_options_json
                    .filter(|value| !value.is_empty() && value != "[]");
                agent.session_modes_json = row
                    .modes_json
                    .filter(|value| !value.is_empty() && value != "[]");
            }
            if agent.session_config.is_none() {
                if let Ok(Some(controls)) = sqlx::query_scalar::<_, String>(
                    r#"SELECT controls_json
                       FROM agent_capability_catalog
                       WHERE agent_type = ?
                       ORDER BY retrieved_at DESC
                       LIMIT 1"#,
                )
                .bind(&agent.id)
                .fetch_optional(&self.pool)
                .await
                {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&controls) {
                        let modes = value
                            .get("modes")
                            .cloned()
                            .filter(|item| item != &serde_json::json!([]));
                        let options = value
                            .get("config_options")
                            .cloned()
                            .filter(|item| item != &serde_json::json!([]));
                        if agent.session_modes.is_none() {
                            agent.session_modes = modes;
                        }
                        agent.session_config = options;
                    }
                }
            }
        }
        let mut tags = builtin_catalog_tags();
        if let Ok(rows) = db::models::tag::Tag::find_all(&self.pool).await {
            for row in rows {
                if tags
                    .iter()
                    .any(|tag| tag.name.eq_ignore_ascii_case(&row.tag_name))
                {
                    continue;
                }
                tags.push(ConversationCatalogTag {
                    id: row.id.to_string(),
                    name: row.tag_name,
                    content: row.content,
                });
            }
        }
        Ok(ConversationCatalog {
            projects,
            workspaces,
            agents,
            tags,
        })
    }

    async fn workspace_entries(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        let Some(root) = self.workspace_root(workspace_id).await? else {
            return Err(ApplicationError::not_found("workspace not found"));
        };
        let path = std::path::Path::new(&root);
        if !path.is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        let read = std::fs::read_dir(path).map_err(|error| {
            ApplicationError::internal(format!("read workspace directory: {error}"))
        })?;
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            entries.push(ConversationWorkspaceEntry {
                name: name.clone(),
                path: name,
                directory,
            });
            if entries.len() >= 200 {
                break;
            }
        }
        entries.sort_by(|left, right| {
            right
                .directory
                .cmp(&left.directory)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn slash_commands(
        &self,
        _agent_id: String,
        _workspace_id: Option<Uuid>,
        conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        let Some(conversation_id) = conversation_id else {
            return Ok(Vec::new());
        };
        let record = db::models::conversation_event::ConversationEventRecord::latest_of_kind(
            &self.pool,
            conversation_id,
            "available_commands_updated",
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let Some(record) = record else {
            return Ok(Vec::new());
        };
        match serde_json::from_str::<agents::conversation::ConversationEvent>(
            &record.normalized_json,
        ) {
            Ok(agents::conversation::ConversationEvent::AvailableCommandsUpdated { commands }) => {
                Ok(slash_commands_from_available(&commands))
            }
            _ => Ok(Vec::new()),
        }
    }

    async fn archive(&self, conversation_id: Uuid) -> Result<(), ApplicationError> {
        db::models::session::Session::update_status(
            &self.pool,
            conversation_id,
            db::models::session::SessionStatus::Archived,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn set_pinned(
        &self,
        conversation_id: Uuid,
        pinned: bool,
    ) -> Result<(), ApplicationError> {
        DbConversationSummary::set_pinned(&self.pool, conversation_id, pinned)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn delete(&self, conversation_id: Uuid) -> Result<(), ApplicationError> {
        DbConversationSummary::soft_delete(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn rename(&self, conversation_id: Uuid, title: String) -> Result<(), ApplicationError> {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            return Err(ApplicationError::bad_request("title is required"));
        }
        DbConversationSummary::set_title(&self.pool, conversation_id, trimmed)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn set_status(
        &self,
        conversation_id: Uuid,
        status: String,
    ) -> Result<(), ApplicationError> {
        let parsed = status
            .parse::<db::models::session::SessionStatus>()
            .map_err(|_| ApplicationError::bad_request(format!("unknown status {status}")))?;
        db::models::session::Session::update_status(&self.pool, conversation_id, parsed)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    async fn create_workspace(
        &self,
        request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        let source = sqlx::query_as::<_, WorkspaceCatalogRow>(
            r#"SELECT id, project_id, name, branch
               FROM workspaces
               WHERE archived = 0 AND project_id = ?
               ORDER BY updated_at DESC
               LIMIT 1"#,
        )
        .bind(request.project_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .ok_or_else(|| ApplicationError::bad_request("这个项目还没有可复制的工作区"))?;
        let id = Uuid::new_v4();
        let branch = request
            .branch
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(source.branch);
        let name = request.name.trim().to_string();
        sqlx::query(
            r#"INSERT INTO workspaces (
                   id, project_id, task_id, parent_workspace_id, container_ref, branch,
                   use_worktree, agent_working_dir, setup_completed_at, name
               )
               SELECT ?, project_id, task_id, id, container_ref, ?, use_worktree,
                      agent_working_dir, setup_completed_at, ?
               FROM workspaces
               WHERE id = ?"#,
        )
        .bind(id)
        .bind(&branch)
        .bind(&name)
        .bind(source.id)
        .execute(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        Ok(ConversationCatalogWorkspace {
            id,
            project_id: request.project_id,
            name,
            branch,
        })
    }

    async fn create(
        &self,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let conversation_id = Uuid::new_v4();
        let agent_id = request.agent_id.trim();
        if agent_id.is_empty() {
            return Err(ApplicationError::bad_request("agentId is required"));
        }
        ConversationRecord::create(
            &self.pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: request.workspace_id,
                task_id: None,
                title: request.title.as_deref(),
                initial_prompt: request.initial_prompt.as_deref(),
                status: None,
                executor: Some(agent_id),
            },
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        sqlx::query(
            "UPDATE sessions
             SET agent_id = ?, agent_type = ?, executor = ?, updated_at = datetime('now', 'subsec')
             WHERE id = ?",
        )
        .bind(agent_id)
        .bind(agent_id)
        .bind(agent_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
    }

    async fn create_child(
        &self,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        let agent_id = agents::AgentId::parse(&request.agent_id)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let conversation_id = create_fork_conversation(
            &self.pool,
            CreateForkConversation {
                id: operation_id,
                parent_conversation_id: request.parent_conversation_id,
                agent_id,
                title: request.title,
                initial_prompt: request.initial_prompt,
                visible: request.visible,
            },
        )
        .await
        .map_err(|error| match error {
            conversations::ConversationServiceError::NotFound(message) => {
                ApplicationError::not_found(message)
            }
            conversations::ConversationServiceError::BadRequest(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::Conflict(message) => {
                ApplicationError::conflict(message)
            }
            conversations::ConversationServiceError::Internal(message) => {
                ApplicationError::internal(message)
            }
            conversations::ConversationServiceError::AuthenticationRequired(message) => {
                ApplicationError::bad_request(message)
            }
            conversations::ConversationServiceError::SessionUnavailable { message, .. } => {
                ApplicationError::bad_request(message)
            }
        })?;
        DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "conversation {conversation_id} was not created"
                ))
            })
    }

    async fn output(
        &self,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        let turn = ConversationTurnRecord::latest_for_conversation(&self.pool, conversation_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let last_sequence: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let assistant_text = match turn.as_ref() {
            Some(turn) => {
                crate::workflow::extract_last_assistant_text(&self.pool, conversation_id, turn.id)
                    .await
                    .ok()
            }
            None => None,
        };
        Ok(ConversationOutputView {
            conversation_id,
            turn: turn.map(|turn| ConversationTurnSnapshot {
                conversation_id,
                turn_id: turn.id,
                prompt_id: turn
                    .prompt_id
                    .and_then(|value| Uuid::parse_str(&value).ok()),
                status: turn.status,
                last_sequence,
            }),
            assistant_text,
        })
    }

    async fn attach(
        &self,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let high_water_mark = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events
             WHERE conversation_id = ?",
        )
        .bind(conversation_uuid)
        .fetch_one(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        if after_sequence >= high_water_mark {
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: false,
                snapshot: (after_sequence == 0).then_some(SubscriptionSnapshot {
                    through_sequence: high_water_mark,
                    payload: serde_json::json!({ "events": [] }),
                }),
                replay: Vec::new(),
                high_water_mark,
            });
        }

        let page_limit = if after_sequence == 0 {
            MAX_OFFLINE_EVENTS
        } else {
            MAX_LIVE_EVENTS
        };
        let records = ConversationEventRecord::events_since(
            &self.pool,
            conversation_uuid,
            after_sequence,
            page_limit,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(remote_event)
            .collect::<Vec<_>>();
        let delivered_through = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence.max(0));
        let (snapshot, replay) = if after_sequence == 0 {
            (
                Some(SubscriptionSnapshot {
                    through_sequence: delivered_through,
                    payload: serde_json::json!({ "events": events }),
                }),
                Vec::new(),
            )
        } else {
            (None, events)
        };
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: false,
            snapshot,
            replay,
            high_water_mark: delivered_through,
        })
    }

    async fn offline_cache(
        &self,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let high_water_mark = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)
             FROM conversation_events
             WHERE conversation_id = ?",
        )
        .bind(conversation_uuid)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let records = ConversationEventRecord::events_since(
            &mut *transaction,
            conversation_uuid,
            after_sequence,
            MAX_OFFLINE_EVENTS,
        )
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
        transaction
            .commit()
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let confirmed_through = records
            .last()
            .map_or(after_sequence.max(0).min(high_water_mark), |record| {
                record.sequence
            });
        let events = records
            .into_iter()
            .filter(|record| record.sequence <= high_water_mark)
            .map(remote_event)
            .collect();
        Ok(OfflineConversationCache {
            conversation_id,
            confirmed_through,
            read_only: true,
            events,
        })
    }

    async fn terminal_notification(
        &self,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        let conversation_uuid = conversation_id.as_uuid();
        let record = sqlx::query_as::<_, (Uuid, String, String, chrono::DateTime<chrono::Utc>)>(
            "SELECT id, event_kind, normalized_json, created_at
             FROM conversation_events
             WHERE conversation_id = ?
               AND event_kind IN (
                   'turn_completed', 'turn_failed', 'turn_cancelled', 'turn_interrupted'
               )
             ORDER BY sequence DESC
             LIMIT 1",
        )
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .ok_or_else(|| {
            ApplicationError::not_found(format!(
                "conversation {conversation_id} has no terminal event"
            ))
        })?;
        let source = sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT id, automation_id
             FROM automation_runs
             WHERE conversation_id = ?
             ORDER BY started_at DESC
             LIMIT 1",
        )
        .bind(conversation_uuid)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .map_or(
            NotificationSource::Conversation { conversation_id },
            |row| NotificationSource::Automation {
                run_id: row.0.to_string(),
                automation_id: row.1.to_string(),
                conversation_id: Some(conversation_id),
            },
        );
        let outcome = match record.1.as_str() {
            "turn_completed" => NotificationOutcome::Completed,
            "turn_failed" => NotificationOutcome::Failed,
            "turn_cancelled" => NotificationOutcome::Cancelled,
            "turn_interrupted" => NotificationOutcome::Interrupted,
            _ => {
                return Err(ApplicationError::internal(
                    "terminal event query returned a non-terminal event",
                ));
            }
        };
        Ok(NotificationProjector::project(
            TerminalNotificationEvidence {
                source,
                outcome,
                occurred_at: record.3.to_rfc3339(),
                operation_id: OperationId::from_uuid(record.0),
                private_detail: Some(record.2),
            },
        ))
    }
}

fn remote_event(record: ConversationEventRecord) -> RemoteEvent {
    let mut payload: serde_json::Value = serde_json::from_str(&record.normalized_json)
        .unwrap_or_else(|_| serde_json::json!({ "unparsed": record.normalized_json }));
    if let (Some(object), Some(turn_id)) = (payload.as_object_mut(), record.turn_id) {
        let turn = serde_json::Value::String(turn_id.to_string());
        object.entry("turnId").or_insert_with(|| turn.clone());
        object.entry("turn_id").or_insert(turn);
    }
    RemoteEvent {
        sequence: record.sequence,
        kind: record.event_kind,
        payload,
    }
}

pub struct ApplicationCore<R> {
    conversations: R,
    execution: Arc<dyn ConversationExecutionPort>,
    domains: Arc<dyn ApplicationDomainPort>,
    workflows: Arc<dyn WorkflowExecutionPort>,
}

impl<R> ApplicationCore<R>
where
    R: ConversationRepository,
{
    pub fn new(conversations: R) -> Self {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_execution<E>(conversations: R, execution: Arc<E>) -> Self
    where
        E: ConversationExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_domains<D>(conversations: R, domains: Arc<D>) -> Self
    where
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains,
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_ports<E, D>(conversations: R, execution: Arc<E>, domains: Arc<D>) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
            workflows: Arc::new(UnavailableWorkflowExecution),
        }
    }

    pub fn with_all_ports<E, D, W>(
        conversations: R,
        execution: Arc<E>,
        domains: Arc<D>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        D: ApplicationDomainPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains,
            workflows,
        }
    }

    pub fn with_execution_and_workflows<E, W>(
        conversations: R,
        execution: Arc<E>,
        workflows: Arc<W>,
    ) -> Self
    where
        E: ConversationExecutionPort + 'static,
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution,
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub fn with_workflows<W>(conversations: R, workflows: Arc<W>) -> Self
    where
        W: WorkflowExecutionPort + 'static,
    {
        Self {
            conversations,
            execution: Arc::new(UnavailableConversationExecution),
            domains: unavailable_domains(),
            workflows,
        }
    }

    pub async fn publish_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PublishWorkflowRequest,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows
            .publish(principal, operation_id, request)
            .await
    }

    pub async fn validate_workflow(
        &self,
        principal: &Principal,
        request: ValidateWorkflowRequest,
    ) -> Result<WorkflowValidationView, ApplicationError> {
        if !principal.allows("workflow.write") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write",
            ));
        }
        self.workflows.validate(request).await
    }

    pub async fn start_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: StartWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.start(principal, operation_id, request).await
    }

    pub async fn debug_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DebugWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.write") || !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.write or workflow.run",
            ));
        }
        self.workflows.debug(principal, operation_id, request).await
    }

    pub async fn show_workflow(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.show(run_id).await
    }

    pub async fn workflow_steps(
        &self,
        principal: &Principal,
        run_id: Uuid,
    ) -> Result<Vec<WorkflowStepView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.steps(run_id).await
    }

    pub async fn workflow_version(
        &self,
        principal: &Principal,
        version_id: Uuid,
    ) -> Result<WorkflowVersionView, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.version(version_id).await
    }

    pub async fn workflow_definitions(
        &self,
        principal: &Principal,
        limit: u32,
    ) -> Result<Vec<WorkflowDefinitionSummary>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.definitions(limit).await
    }

    pub async fn workflow_versions(
        &self,
        principal: &Principal,
        definition_id: Uuid,
        limit: u32,
    ) -> Result<Vec<WorkflowVersionView>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.versions(definition_id, limit).await
    }

    pub async fn workflow_events(
        &self,
        principal: &Principal,
        run_id: Uuid,
        after_sequence: i64,
        limit: i64,
    ) -> Result<Vec<WorkflowEventRecord>, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        self.workflows.events(run_id, after_sequence, limit).await
    }

    pub async fn attach_workflow_run(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        run_id: Uuid,
        after_sequence: i64,
    ) -> Result<SubscriptionBootstrap, ApplicationError> {
        if !principal.allows("workflow.read") {
            return Err(ApplicationError::forbidden("principal lacks workflow.read"));
        }
        let run = self.workflows.show(run_id).await?;
        if after_sequence == 0 {
            let steps = self.workflows.steps(run_id).await?;
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: true,
                snapshot: Some(SubscriptionSnapshot {
                    through_sequence: run.last_sequence,
                    payload: serde_json::json!({"run": run, "steps": steps}),
                }),
                replay: Vec::new(),
                high_water_mark: run.last_sequence,
            });
        }
        if after_sequence >= run.last_sequence {
            return Ok(SubscriptionBootstrap {
                subscription_id,
                ready: true,
                snapshot: None,
                replay: Vec::new(),
                high_water_mark: run.last_sequence,
            });
        }
        let records = self
            .workflows
            .events(run_id, after_sequence, MAX_LIVE_EVENTS)
            .await?;
        let replay = records
            .into_iter()
            .filter(|event| event.sequence <= run.last_sequence)
            .map(|event| RemoteEvent {
                sequence: event.sequence,
                kind: event.event_kind,
                payload: serde_json::from_str(&event.payload_json)
                    .unwrap_or_else(|_| serde_json::json!({"unparsed": event.payload_json})),
            })
            .collect::<Vec<_>>();
        let high_water_mark = replay
            .last()
            .map(|event| event.sequence)
            .unwrap_or(after_sequence)
            .min(run.last_sequence);
        Ok(SubscriptionBootstrap {
            subscription_id,
            ready: true,
            snapshot: None,
            replay,
            high_water_mark,
        })
    }

    pub async fn complete_workflow_step(
        &self,
        principal: &Principal,
        request: CompleteWorkflowStepRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.internal") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.internal",
            ));
        }
        self.workflows.complete_step(request).await
    }

    pub async fn decide_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: DecideWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.approve") {
            return Err(ApplicationError::forbidden(
                "principal lacks workflow.approve",
            ));
        }
        self.workflows
            .decide(principal, operation_id, request)
            .await
    }

    pub async fn cancel_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows.cancel(operation_id, request).await
    }

    pub async fn resume_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumeWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        if !principal.allows("workflow.run") {
            return Err(ApplicationError::forbidden("principal lacks workflow.run"));
        }
        self.workflows
            .resume(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: PauseWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .pause_run(principal, operation_id, request)
            .await
    }

    pub async fn resume_paused_workflow(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ResumePausedWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .resume_paused_run(principal, operation_id, request)
            .await
    }

    pub async fn accept_workflow_candidate(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: AcceptWorkflowCandidateRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .accept_candidate(principal, operation_id, request)
            .await
    }

    pub async fn pause_workflow_step(
        &self,
        principal: &Principal,
        request: PauseWorkflowStepRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows.pause_step(request).await
    }

    pub async fn submit_workflow_step_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitWorkflowStepInputRequest,
    ) -> Result<WorkflowStepView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .submit_step_input(operation_id, request)
            .await
    }

    pub async fn fork_workflow_from_step(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ForkWorkflowRequest,
    ) -> Result<WorkflowRunView, ApplicationError> {
        require_workflow_run(principal)?;
        self.workflows
            .fork_from_step(principal, operation_id, request)
            .await
    }

    pub async fn list_conversations(
        &self,
        principal: &Principal,
        request: ListConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations
            .list_for_workspace(request.workspace_id)
            .await
    }

    pub async fn list_recent_conversations(
        &self,
        principal: &Principal,
        request: ListRecentConversations,
    ) -> Result<Vec<DbConversationSummary>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.list_recent(request).await
    }

    pub async fn conversation_catalog(
        &self,
        principal: &Principal,
    ) -> Result<ConversationCatalog, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.catalog().await
    }

    pub async fn conversation_workspace_entries(
        &self,
        principal: &Principal,
        workspace_id: Uuid,
    ) -> Result<Vec<ConversationWorkspaceEntry>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.workspace_entries(workspace_id).await
    }

    pub async fn conversation_slash_commands(
        &self,
        principal: &Principal,
        agent_id: String,
        workspace_id: Option<Uuid>,
        conversation_id: Option<Uuid>,
    ) -> Result<Vec<ConversationSlashCommand>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations
            .slash_commands(agent_id, workspace_id, conversation_id)
            .await
    }

    pub async fn archive_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.archive(conversation_id).await
    }

    pub async fn set_conversation_pinned(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        pinned: bool,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.set_pinned(conversation_id, pinned).await
    }

    pub async fn delete_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.delete(conversation_id).await
    }

    pub async fn rename_conversation(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        title: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.rename(conversation_id, title).await
    }

    pub async fn set_conversation_status(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        status: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.set_status(conversation_id, status).await
    }

    pub async fn set_session_mode(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        mode_id: String,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .set_session_mode(conversation_id, mode_id)
            .await
    }

    pub async fn set_session_config_option(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
        key: String,
        value: serde_json::Value,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .set_session_config_option(conversation_id, key, value)
            .await
    }

    pub async fn create_conversation_workspace(
        &self,
        principal: &Principal,
        request: CreateConversationWorkspace,
    ) -> Result<ConversationCatalogWorkspace, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create_workspace(request).await
    }

    pub async fn create_conversation(
        &self,
        principal: &Principal,
        request: CreateConversation,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create(request).await
    }

    pub async fn create_child_conversation(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CreateChildConversationRequest,
    ) -> Result<DbConversationSummary, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.conversations.create_child(operation_id, request).await
    }

    pub async fn conversation_output(
        &self,
        principal: &Principal,
        conversation_id: Uuid,
    ) -> Result<ConversationOutputView, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.conversations.output(conversation_id).await
    }

    pub async fn start_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        mut request: StartConversationTurn,
    ) -> Result<ConversationTurnSnapshot, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        request.operation_id = Some(operation_id);
        self.execution.start_turn(request).await
    }

    pub async fn submit_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SubmitConversationInputRequest,
    ) -> Result<ConversationInputSubmission, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .submit_input(SubmitConversationInput {
                conversation_id: request.conversation_id,
                operation_id,
                payload: request.payload,
                principal: principal_evidence(principal),
            })
            .await
    }

    pub async fn steer_conversation_turn(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: SteerConversationTurnRequest,
    ) -> Result<ConversationSteeringReceipt, ApplicationError> {
        if !principal.allows(STEER_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution
            .steer(ConversationSteerInput {
                conversation_id: request.conversation_id,
                operation_id,
                expected_turn_id: request.expected_turn_id,
                text: request.text,
                images: request.images,
                principal: principal_evidence(principal),
            })
            .await
    }

    pub async fn submit_conversation_feedback(
        &self,
        principal: &Principal,
        request: SubmitConversationFeedback,
    ) -> Result<ConversationLiveFeedbackNote, ApplicationError> {
        if !principal.allows(LIVE_FEEDBACK_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.steer",
            ));
        }
        self.execution.submit_feedback(request).await
    }

    pub async fn list_conversation_feedback(
        &self,
        principal: &Principal,
        request: ListConversationFeedbackRequest,
    ) -> Result<Vec<ConversationLiveFeedbackNote>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_feedback(request.conversation_id).await
    }

    pub async fn list_conversation_inputs(
        &self,
        principal: &Principal,
        request: ListConversationInputsRequest,
    ) -> Result<Vec<ConversationInputView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_inputs(request.conversation_id).await
    }

    pub async fn list_conversation_relations(
        &self,
        principal: &Principal,
        request: ListConversationRelationsRequest,
    ) -> Result<Vec<ConversationRelationView>, ApplicationError> {
        if !principal.allows(READ_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.read",
            ));
        }
        self.execution.list_relations(request.conversation_id).await
    }

    pub async fn update_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: UpdateConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .update_input(UpdateConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                payload: request.payload,
            })
            .await
    }

    pub async fn reorder_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: ReorderConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .reorder_input(ReorderConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
                sort_key: request.sort_key,
            })
            .await
    }

    pub async fn cancel_conversation_input(
        &self,
        principal: &Principal,
        operation_id: Uuid,
        request: CancelConversationInputRequest,
    ) -> Result<ConversationInputView, ApplicationError> {
        if !principal.allows(WRITE_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.write",
            ));
        }
        self.execution
            .cancel_input(CancelConversationInput {
                conversation_id: request.conversation_id,
                input_id: request.input_id,
                operation_id,
                expected_revision: request.expected_revision,
            })
            .await
    }

    pub async fn respond_conversation_permission(
        &self,
        principal: &Principal,
        request: RespondConversationPermission,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(RESPOND_PERMISSION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.permission",
            ));
        }
        self.execution.respond_permission(request).await
    }

    pub async fn respond_conversation_question(
        &self,
        principal: &Principal,
        request: RespondConversationQuestion,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(RESPOND_QUESTION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.question",
            ));
        }
        self.execution.respond_question(request).await
    }

    pub async fn cancel_conversation_turn(
        &self,
        principal: &Principal,
        request: CancelConversationTurn,
    ) -> Result<(), ApplicationError> {
        if !principal.allows(CANCEL_CONVERSATION_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.cancel",
            ));
        }
        self.execution.cancel_turn(request).await
    }

    pub async fn execute_domain(
        &self,
        principal: &Principal,
        command: DomainCommand,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ApplicationError> {
        if !principal.allows(command.required_scope()) {
            return Err(ApplicationError::forbidden(format!(
                "principal lacks {}",
                command.required_scope()
            )));
        }
        self.domains.execute(principal, command, args).await
    }

    pub async fn offline_conversation_cache(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
        after_sequence: i64,
    ) -> Result<OfflineConversationCache, ApplicationError> {
        if !principal.allows(OFFLINE_READ_SCOPE) {
            return Err(ApplicationError::forbidden("principal lacks offline.read"));
        }
        self.conversations
            .offline_cache(conversation_id, after_sequence)
            .await
    }

    pub async fn terminal_notification_summary(
        &self,
        principal: &Principal,
        conversation_id: ConversationId,
    ) -> Result<TerminalNotificationSummary, ApplicationError> {
        if !principal.allows(NOTIFICATION_SUMMARY_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks notification.summary",
            ));
        }
        self.conversations
            .terminal_notification(conversation_id)
            .await
    }

    pub async fn attach_conversation<S>(
        &self,
        principal: &Principal,
        subscription_id: SubscriptionId,
        conversation_id: ConversationId,
        after_sequence: i64,
        subscriptions: &S,
    ) -> Result<SubscriptionBootstrap, ApplicationError>
    where
        S: ConversationSubscriptionRegistrar + ?Sized,
    {
        if !principal.allows(ATTACH_CONVERSATIONS_SCOPE) {
            return Err(ApplicationError::forbidden(
                "principal lacks conversation.attach",
            ));
        }
        subscriptions
            .register(subscription_id, conversation_id)
            .await?;
        let mut bootstrap = self
            .conversations
            .attach(subscription_id, conversation_id, after_sequence)
            .await?;
        bootstrap.ready = true;
        Ok(bootstrap)
    }
}

fn principal_evidence(principal: &Principal) -> serde_json::Value {
    match principal {
        Principal::LocalDesktop => serde_json::json!({ "kind": "local_desktop" }),
        Principal::Remote {
            subject,
            credential_id,
            device_id,
            ..
        } => serde_json::json!({
            "kind": "remote",
            "subject": subject,
            "credentialId": credential_id,
            "deviceId": device_id,
        }),
    }
}
