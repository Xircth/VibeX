use agents::AgentId;
use plugins::PromptBlock;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AgentSelectionIntent, AutomationDraftInput, IsolationSpec, ScheduleSpec, TurnLaunchSpecInput,
    WorkflowLaunchSpec, WorkspaceTarget,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDraft {
    pub name: String,
    pub enabled: bool,
    pub trigger: ScheduleSpec,
    pub launch: AutomationDraftInput,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAutomationDraft {
    pub name: String,
    pub enabled: bool,
    pub trigger: ScheduleSpec,
    pub launch: WorkflowLaunchSpec,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutomationTemplate {
    pub id: String,
    pub draft: AutomationDraft,
}

pub struct BuiltinTemplateCatalog;

impl BuiltinTemplateCatalog {
    pub fn all() -> Vec<AutomationTemplate> {
        [
            (
                "code-review",
                "Code review",
                "Review the current branch for correctness, security, and maintainability. Report findings in the Conversation; do not merge or push.",
            ),
            (
                "dependency-check",
                "Dependency check",
                "Inspect project dependencies for stale, vulnerable, or unnecessary packages. Propose changes without publishing.",
            ),
            (
                "test-coverage",
                "Test coverage",
                "Run the relevant test suite, identify meaningful coverage gaps, and implement focused tests in this isolated worktree.",
            ),
            (
                "todo-scan",
                "TODO scan",
                "Find actionable TODO and FIXME markers, group them by risk, and recommend the smallest useful next steps.",
            ),
            (
                "ci-triage",
                "CI triage",
                "Diagnose the latest available CI failures using repository evidence. Prepare fixes locally without pushing or deploying.",
            ),
            (
                "release-notes",
                "Release notes",
                "Draft release notes from the repository history and current changes. Do not publish a release.",
            ),
            (
                "security-audit",
                "Security audit",
                "Audit the current branch for trust-boundary, secret-handling, injection, and dependency risks. Record evidence and mitigations.",
            ),
        ]
        .into_iter()
        .map(|(id, name, prompt)| AutomationTemplate {
            id: id.to_string(),
            draft: ordinary_draft(name, prompt),
        })
        .collect()
    }
}

fn ordinary_draft(name: &str, prompt: &str) -> AutomationDraft {
    AutomationDraft {
        name: name.to_string(),
        enabled: false,
        trigger: ScheduleSpec::Manual,
        launch: AutomationDraftInput(TurnLaunchSpecInput {
            prompt_blocks: vec![PromptBlock::Text {
                text: prompt.to_string(),
            }],
            display_text: prompt.to_string(),
            agent: AgentSelectionIntent {
                agent_id: AgentId::parse("codex").expect("builtin agent id"),
                executor_profile_id: None,
            },
            mode_id: None,
            config_values: Vec::new(),
            plugin_actions: Vec::new(),
            skills: Vec::new(),
            workspace: WorkspaceTarget {
                project_id: Uuid::nil(),
                root_folder: "${workspace_root}".to_string(),
                branch: None,
                isolation: IsolationSpec::WorktreePerRun,
            },
            label_snapshot: Some(name.to_string()),
        }),
    }
}
