use agents::{AgentId, AgentSessionConfigOverride};
use executors::profile::ExecutorProfileId;
use plugins::{PluginAction, PluginId, PromptBlock, SkillId};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const AUTOMATION_SPEC_VERSION: u16 = 1;
pub const WORKFLOW_AUTOMATION_SPEC_VERSION: u16 = 1;
pub const PORTABLE_AUTOMATION_SPEC_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSpec {
    pub format_version: u16,
    pub name: String,
    pub trigger: crate::ScheduleSpec,
    pub target: PortableAutomationTarget,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", content = "spec", rename_all = "snake_case")]
pub enum PortableAutomationTarget {
    Turn(PortableTurnLaunchSpec),
    Workflow(PortableWorkflowLaunchSpec),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableTurnLaunchSpec {
    pub prompt_blocks: Vec<PromptBlock>,
    pub display_text: String,
    pub agent: AgentSelectionIntent,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: Vec<AgentSessionConfigOverride>,
    #[serde(default, alias = "workflowRefs")]
    pub plugin_actions: Vec<PluginActionRef>,
    #[serde(default)]
    pub skills: Vec<SkillId>,
    pub workspace: PortableWorkspaceRef,
    #[serde(default)]
    pub label_snapshot: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableWorkflowLaunchSpec {
    pub source_path: String,
    pub version_digest: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub policy_override: Option<serde_json::Value>,
    pub workspace: PortableWorkspaceRef,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableWorkspaceRef {
    pub project_name: String,
    pub root_folder_name: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default = "default_isolation")]
    pub isolation: IsolationSpec,
}

impl AutomationSpec {
    pub fn validate(&self) -> Result<(), AutomationError> {
        if self.format_version != PORTABLE_AUTOMATION_SPEC_VERSION {
            return Err(AutomationError::UnsupportedSpecVersion(self.format_version));
        }
        if self.name.trim().is_empty() {
            return Err(AutomationError::InvalidPortableReference);
        }
        let workspace = match &self.target {
            PortableAutomationTarget::Turn(spec) => {
                let placeholder = WorkspaceTarget {
                    project_id: Uuid::nil(),
                    root_folder: spec.workspace.root_folder_name.clone(),
                    branch: spec.workspace.branch.clone(),
                    isolation: spec.workspace.isolation.clone(),
                };
                validate_input(
                    &spec.prompt_blocks,
                    &spec.display_text,
                    &spec.plugin_actions,
                    &placeholder,
                )?;
                &spec.workspace
            }
            PortableAutomationTarget::Workflow(spec) => {
                let source = std::path::Path::new(&spec.source_path);
                if source.is_absolute()
                    || source
                        .components()
                        .any(|component| matches!(component, std::path::Component::ParentDir))
                    || !spec.source_path.ends_with(".vibex-workflow.json")
                    || spec.version_digest.trim().is_empty()
                {
                    return Err(AutomationError::InvalidPortableReference);
                }
                &spec.workspace
            }
        };
        if workspace.project_name.trim().is_empty()
            || workspace.root_folder_name.trim().is_empty()
            || std::path::Path::new(&workspace.root_folder_name).is_absolute()
            || workspace.root_folder_name.contains('/')
            || workspace.root_folder_name.contains('\\')
        {
            return Err(AutomationError::InvalidPortableReference);
        }
        Ok(())
    }
}

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
    #[serde(default, alias = "workflowRefs")]
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginActionRef {
    pub plugin_id: PluginId,
    pub action: PluginAction,
}

impl<'de> Deserialize<'de> for PluginActionRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            plugin_id: PluginId,
            #[serde(default)]
            action: Option<PluginAction>,
            #[serde(default)]
            workflow_id: Option<String>,
            #[serde(default)]
            action_id: Option<String>,
            #[serde(default)]
            version: Option<String>,
        }
        let raw = Raw::deserialize(deserializer)?;
        if let Some(action) = raw.action {
            return Ok(Self {
                plugin_id: raw.plugin_id,
                action,
            });
        }
        let workflow_id = raw
            .workflow_id
            .or(raw.action_id)
            .ok_or_else(|| serde::de::Error::missing_field("workflowId"))?;
        let _ = raw.version;
        Ok(Self {
            plugin_id: raw.plugin_id,
            action: PluginAction {
                id: plugins::ActionId::from_string(workflow_id.clone()),
                label: workflow_id,
                required_skills: Vec::new(),
                required_tools: Vec::new(),
                prompt_blocks: Vec::new(),
                artifact_intent: None,
            },
        })
    }
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
    #[error("portable Automation reference is invalid")]
    InvalidPortableReference,
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
            Self::InvalidPortableReference => "automation_invalid_portable_reference",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn portable_workspace() -> PortableWorkspaceRef {
        PortableWorkspaceRef {
            project_name: "VibeX".to_string(),
            root_folder_name: "VibeX".to_string(),
            branch: Some("main".to_string()),
            isolation: IsolationSpec::WorktreePerRun,
        }
    }

    #[test]
    fn workflow_refs_json_deserializes_as_plugin_action_refs() {
        let spec: PortableTurnLaunchSpec = serde_json::from_value(serde_json::json!({
            "promptBlocks": [{"type":"text","text":"run"}],
            "displayText": "run",
            "agent": {"agentId": "codex"},
            "workspace": {
                "projectName": "VibeX",
                "rootFolderName": "VibeX"
            },
            "workflowRefs": [{
                "pluginId": "office",
                "workflowId": "create-presentation",
                "version": "4.0.0"
            }]
        }))
        .unwrap();
        assert_eq!(spec.plugin_actions.len(), 1);
        assert_eq!(spec.plugin_actions[0].plugin_id.as_str(), "office");
        assert_eq!(
            spec.plugin_actions[0].action.id.as_str(),
            "create-presentation"
        );
    }

    #[test]
    fn portable_spec_contains_no_host_ids_or_absolute_paths() {
        let spec = AutomationSpec {
            format_version: PORTABLE_AUTOMATION_SPEC_VERSION,
            name: "Review".to_string(),
            trigger: crate::ScheduleSpec::Manual,
            target: PortableAutomationTarget::Turn(PortableTurnLaunchSpec {
                prompt_blocks: vec![PromptBlock::Text {
                    text: "review".to_string(),
                }],
                display_text: "review".to_string(),
                agent: AgentSelectionIntent {
                    agent_id: AgentId::parse("codex").unwrap(),
                    executor_profile_id: None,
                },
                mode_id: None,
                config_values: Vec::new(),
                plugin_actions: Vec::new(),
                skills: Vec::new(),
                workspace: portable_workspace(),
                label_snapshot: None,
            }),
        };
        spec.validate().unwrap();
        let json = serde_json::to_string(&spec).unwrap();
        assert!(!json.contains("projectId"));
        assert!(!json.contains("definitionVersionId"));
        assert!(!json.contains("/Users/"));
    }

    #[test]
    fn portable_spec_rejects_absolute_workflow_source() {
        let spec = AutomationSpec {
            format_version: PORTABLE_AUTOMATION_SPEC_VERSION,
            name: "Workflow".to_string(),
            trigger: crate::ScheduleSpec::Manual,
            target: PortableAutomationTarget::Workflow(PortableWorkflowLaunchSpec {
                source_path: "/tmp/release.vibex-workflow.json".to_string(),
                version_digest: "sha256:test".to_string(),
                input: serde_json::json!({}),
                policy_override: None,
                workspace: portable_workspace(),
            }),
        };
        assert_eq!(
            spec.validate().unwrap_err(),
            AutomationError::InvalidPortableReference
        );
    }
}
