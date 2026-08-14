use agents::{AgentId, AgentSessionConfigOverride};
use executors::profile::ExecutorProfileId;
use plugins::{PluginAction, PluginId, PromptBlock, SkillId};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const AUTOMATION_SPEC_VERSION: u16 = 1;
pub const WORKFLOW_AUTOMATION_SPEC_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaunchSpec {
    pub spec_version: u16,
    pub definition_version_id: Uuid,
    pub input: serde_json::Value,
    #[serde(default)]
    pub policy_override: Option<serde_json::Value>,
    pub workspace: WorkspaceTarget,
}

impl WorkflowLaunchSpec {
    pub fn validate(&self) -> Result<(), AutomationError> {
        if self.spec_version != WORKFLOW_AUTOMATION_SPEC_VERSION {
            return Err(AutomationError::UnsupportedSpecVersion(self.spec_version));
        }
        if self.workspace.root_folder.trim().is_empty() {
            return Err(AutomationError::MissingWorkspaceRoot);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", content = "spec", rename_all = "snake_case")]
pub enum AutomationTarget {
    Turn(TurnLaunchSpec),
    Workflow(WorkflowLaunchSpec),
}

impl AutomationTarget {
    pub const fn workspace(&self) -> &WorkspaceTarget {
        match self {
            Self::Turn(spec) => &spec.workspace,
            Self::Workflow(spec) => &spec.workspace,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnLaunchSpec {
    pub spec_version: u16,
    pub prompt_blocks: Vec<PromptBlock>,
    pub display_text: String,
    pub agent: AgentSelectionIntent,
    pub mode_id: Option<String>,
    pub config_values: Vec<AgentSessionConfigOverride>,
    pub plugin_actions: Vec<PluginActionRef>,
    pub skills: Vec<SkillId>,
    pub workspace: WorkspaceTarget,
    #[serde(default)]
    pub label_snapshot: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnLaunchSpecInput {
    pub prompt_blocks: Vec<PromptBlock>,
    pub display_text: String,
    pub agent: AgentSelectionIntent,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: Vec<AgentSessionConfigOverride>,
    #[serde(default)]
    pub plugin_actions: Vec<PluginActionRef>,
    #[serde(default)]
    pub skills: Vec<SkillId>,
    pub workspace: WorkspaceTarget,
    #[serde(default)]
    pub label_snapshot: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ComposerCanonicalInput(pub TurnLaunchSpecInput);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(transparent)]
pub struct AutomationDraftInput(pub TurnLaunchSpecInput);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectionIntent {
    pub agent_id: AgentId,
    #[serde(default)]
    pub executor_profile_id: Option<ExecutorProfileId>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginActionRef {
    pub plugin_id: PluginId,
    pub action: PluginAction,
}

pub trait PluginActionCatalogPort {
    fn contains(&self, action: &PluginActionRef) -> bool;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationSpec {
    WorktreePerRun,
    SharedInRoot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTarget {
    pub project_id: Uuid,
    pub root_folder: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default = "default_isolation")]
    pub isolation: IsolationSpec,
}

fn default_isolation() -> IsolationSpec {
    IsolationSpec::WorktreePerRun
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AutomationError {
    #[error("unsupported TurnLaunchSpec version {0}")]
    UnsupportedSpecVersion(u16),
    #[error("prompt must contain at least one non-empty block")]
    EmptyPrompt,
    #[error("workspace root folder is required")]
    MissingWorkspaceRoot,
    #[error("plugin action reference is invalid")]
    InvalidPluginAction,
    #[error("plugin action {plugin_id}/{action_id} is unavailable")]
    UnavailablePluginAction {
        plugin_id: String,
        action_id: String,
    },
}

impl AutomationError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSpecVersion(_) => "automation_unsupported_spec_version",
            Self::EmptyPrompt => "automation_empty_prompt",
            Self::MissingWorkspaceRoot => "automation_missing_workspace_root",
            Self::InvalidPluginAction => "automation_invalid_plugin_action",
            Self::UnavailablePluginAction { .. } => "automation_plugin_action_unavailable",
        }
    }
}

impl TurnLaunchSpec {
    pub fn from_composer(input: ComposerCanonicalInput) -> Result<Self, AutomationError> {
        Self::normalize(input.0)
    }

    pub fn from_automation_draft(input: AutomationDraftInput) -> Result<Self, AutomationError> {
        Self::normalize(input.0)
    }

    pub fn validate(&self) -> Result<(), AutomationError> {
        if self.spec_version != AUTOMATION_SPEC_VERSION {
            return Err(AutomationError::UnsupportedSpecVersion(self.spec_version));
        }
        validate_input(
            &self.prompt_blocks,
            &self.display_text,
            &self.plugin_actions,
            &self.workspace,
        )
    }

    pub fn validate_plugin_actions(
        &self,
        catalog: &impl PluginActionCatalogPort,
    ) -> Result<(), AutomationError> {
        if let Some(reference) = self
            .plugin_actions
            .iter()
            .find(|reference| !catalog.contains(reference))
        {
            return Err(AutomationError::UnavailablePluginAction {
                plugin_id: reference.plugin_id.as_str().to_owned(),
                action_id: reference.action.id.as_str().to_owned(),
            });
        }
        Ok(())
    }

    fn normalize(input: TurnLaunchSpecInput) -> Result<Self, AutomationError> {
        validate_input(
            &input.prompt_blocks,
            &input.display_text,
            &input.plugin_actions,
            &input.workspace,
        )?;
        Ok(Self {
            spec_version: AUTOMATION_SPEC_VERSION,
            prompt_blocks: input.prompt_blocks,
            display_text: input.display_text,
            agent: input.agent,
            mode_id: input.mode_id,
            config_values: input.config_values,
            plugin_actions: input.plugin_actions,
            skills: input.skills,
            workspace: input.workspace,
            label_snapshot: input.label_snapshot,
        })
    }
}

fn validate_input(
    prompt_blocks: &[PromptBlock],
    display_text: &str,
    plugin_actions: &[PluginActionRef],
    workspace: &WorkspaceTarget,
) -> Result<(), AutomationError> {
    let has_prompt = prompt_blocks.iter().any(|block| match block {
        PromptBlock::Text { text } => !text.trim().is_empty(),
    }) || !display_text.trim().is_empty();
    if !has_prompt {
        return Err(AutomationError::EmptyPrompt);
    }
    if workspace.root_folder.trim().is_empty() {
        return Err(AutomationError::MissingWorkspaceRoot);
    }
    if plugin_actions.iter().any(|reference| {
        reference.plugin_id.as_str().trim().is_empty()
            || reference.action.id.as_str().trim().is_empty()
    }) {
        return Err(AutomationError::InvalidPluginAction);
    }
    Ok(())
}
