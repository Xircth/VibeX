use std::collections::{BTreeMap, BTreeSet, HashMap};

use api_types::{AgentId, AgentKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::{
    AgentHistoryError, AgentHistorySource, ImportedAgentSession, configured_history_sources,
    import_history_source,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum LocalHistorySessionStatus {
    New,
    Imported,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryScanSession {
    pub agent_id: AgentId,
    pub external_session_id: String,
    pub title: Option<String>,
    pub workspace_path: Option<String>,
    pub message_count: u32,
    pub updated_at: Option<String>,
    pub status: LocalHistorySessionStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryScanFolder {
    pub path: String,
    pub name: String,
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub workspace_id: Option<Uuid>,
    pub sessions: Vec<LocalHistoryScanSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryDestination {
    pub project_id: Uuid,
    pub project_name: String,
    pub workspace_id: Uuid,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryScanPage {
    pub folders: Vec<LocalHistoryScanFolder>,
    pub destinations: Vec<LocalHistoryDestination>,
    pub total_sessions: u32,
    pub importable_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryImportSelection {
    pub agent_id: AgentId,
    pub external_session_id: String,
    pub workspace_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    pub conversation_ids: Vec<Uuid>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPathDestination {
    pub path: String,
    pub project_id: Uuid,
    pub project_name: String,
    pub workspace_id: Uuid,
}

pub fn normalize_history_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return String::new();
    }
    let unified = trimmed.replace('\\', "/");
    let without_private = unified
        .strip_prefix("/private/")
        .map(|rest| format!("/{rest}"))
        .unwrap_or(unified);
    without_private.to_ascii_lowercase()
}

pub fn history_folder_name(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return String::new();
    }
    PathLastComponent::from(trimmed).into_owned()
}

struct PathLastComponent<'a>(&'a str);

impl<'a> PathLastComponent<'a> {
    fn from(path: &'a str) -> Self {
        Self(path)
    }

    fn into_owned(self) -> String {
        self.0
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .unwrap_or(self.0)
            .to_string()
    }
}

pub fn history_paths_overlap(left: &str, right: &str) -> bool {
    let left = normalize_history_path(left);
    let right = normalize_history_path(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left == right || left.starts_with(&(right.clone() + "/")) || right.starts_with(&(left + "/"))
}

pub fn match_history_destination<'a>(
    workspace_path: Option<&str>,
    destinations: &'a [HistoryPathDestination],
) -> Option<&'a HistoryPathDestination> {
    let path = workspace_path.filter(|value| !value.trim().is_empty())?;
    destinations
        .iter()
        .filter(|destination| history_paths_overlap(path, &destination.path))
        .max_by_key(|destination| normalize_history_path(&destination.path).len())
}

pub fn scan_configured_history(
    agent_type: AgentKind,
    configured_env: &HashMap<String, String>,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let sources = configured_history_sources(agent_type, configured_env);
    merge_history_sources(&sources)
}

pub fn merge_history_sources(
    sources: &[AgentHistorySource],
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut by_id = BTreeMap::<String, ImportedAgentSession>::new();
    let mut first_error = None;
    for source in sources {
        match import_history_source(source) {
            Ok(sessions) => {
                for session in sessions {
                    let replace = by_id
                        .get(&session.external_session_id)
                        .is_none_or(|existing| session.messages.len() > existing.messages.len());
                    if replace {
                        by_id.insert(session.external_session_id.clone(), session);
                    }
                }
            }
            Err(AgentHistoryError::MissingSource(_)) => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if by_id.is_empty()
        && let Some(error) = first_error
    {
        return Err(error);
    }
    let mut sessions = by_id.into_values().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        latest_message_time(right)
            .cmp(&latest_message_time(left))
            .then_with(|| left.external_session_id.cmp(&right.external_session_id))
    });
    Ok(sessions)
}

pub fn build_local_history_scan_page(
    sessions: Vec<ImportedAgentSession>,
    imported: &BTreeSet<(String, String)>,
    destinations: &[HistoryPathDestination],
    project_destinations: Vec<LocalHistoryDestination>,
) -> LocalHistoryScanPage {
    let mut folders = BTreeMap::<String, LocalHistoryScanFolder>::new();
    for session in sessions {
        let agent_id = AgentId::parse(session.source_agent.as_str())
            .unwrap_or_else(|_| AgentId::parse("unknown").expect("fallback agent id"));
        let status = if imported.contains(&(
            agent_id.as_str().to_string(),
            session.external_session_id.clone(),
        )) {
            LocalHistorySessionStatus::Imported
        } else {
            LocalHistorySessionStatus::New
        };
        let display_path = session
            .workspace_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_default();
        let group_key = normalize_history_path(&display_path);
        let matched = match_history_destination(
            (!display_path.is_empty()).then_some(display_path.as_str()),
            destinations,
        );
        let message_count = u32::try_from(session.messages.len()).unwrap_or(u32::MAX);
        let updated_at = latest_message_time(&session).map(|time| time.to_rfc3339());
        let scan_session = LocalHistoryScanSession {
            agent_id,
            external_session_id: session.external_session_id,
            title: session.title,
            workspace_path: (!display_path.is_empty()).then_some(display_path.clone()),
            message_count,
            updated_at,
            status,
        };
        folders
            .entry(group_key)
            .and_modify(|folder| folder.sessions.push(scan_session.clone()))
            .or_insert_with(|| LocalHistoryScanFolder {
                path: display_path.clone(),
                name: history_folder_name(&display_path),
                project_id: matched.map(|destination| destination.project_id),
                project_name: matched.map(|destination| destination.project_name.clone()),
                workspace_id: matched.map(|destination| destination.workspace_id),
                sessions: vec![scan_session],
            });
    }

    let mut folders = folders.into_values().collect::<Vec<_>>();
    folders.sort_by(|left, right| {
        left.path
            .to_ascii_lowercase()
            .cmp(&right.path.to_ascii_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    let total_sessions = folders
        .iter()
        .map(|folder| folder.sessions.len() as u32)
        .sum();
    let importable_count = folders
        .iter()
        .flat_map(|folder| folder.sessions.iter())
        .filter(|session| session.status == LocalHistorySessionStatus::New)
        .count() as u32;
    LocalHistoryScanPage {
        folders,
        destinations: project_destinations,
        total_sessions,
        importable_count,
    }
}

fn latest_message_time(session: &ImportedAgentSession) -> Option<chrono::DateTime<chrono::Utc>> {
    session
        .messages
        .iter()
        .filter_map(|message| message.created_at)
        .max()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{ImportedAgentMessage, ImportedAgentMessageRole};

    fn session(
        agent: AgentKind,
        external_id: &str,
        path: Option<&str>,
        title: &str,
    ) -> ImportedAgentSession {
        ImportedAgentSession {
            source_agent: agent,
            external_session_id: external_id.to_string(),
            title: Some(title.to_string()),
            workspace_path: path.map(std::path::PathBuf::from),
            messages: vec![ImportedAgentMessage {
                role: ImportedAgentMessageRole::User,
                content: title.to_string(),
                created_at: None,
                metadata: Default::default(),
            }],
            raw_source_path: None,
        }
    }

    #[test]
    fn macos_private_prefix_and_separators_match() {
        assert!(history_paths_overlap(
            "/private/Users/mac/Projects/VibeX",
            "/Users/mac/Projects/VibeX"
        ));
        assert!(history_paths_overlap(r"C:\Work\app", "c:/work/app/src"));
        assert!(!history_paths_overlap("/Users/mac/a", "/Users/mac/ab"));
    }

    #[test]
    fn longest_overlapping_destination_wins() {
        let project = Uuid::from_u128(1);
        let workspace = Uuid::from_u128(2);
        let nested = Uuid::from_u128(3);
        let destinations = vec![
            HistoryPathDestination {
                path: "/Users/mac/Projects/VibeX".into(),
                project_id: project,
                project_name: "VibeX".into(),
                workspace_id: workspace,
            },
            HistoryPathDestination {
                path: "/Users/mac/Projects/VibeX/crates/agents".into(),
                project_id: project,
                project_name: "VibeX".into(),
                workspace_id: nested,
            },
        ];

        let matched = match_history_destination(
            Some("/Users/mac/Projects/VibeX/crates/agents/src"),
            &destinations,
        )
        .expect("nested match");
        assert_eq!(matched.workspace_id, nested);
    }

    #[test]
    fn scan_page_groups_by_path_and_marks_imported() {
        let project = Uuid::from_u128(11);
        let workspace = Uuid::from_u128(12);
        let destinations = vec![HistoryPathDestination {
            path: "/Users/mac/Projects/VibeX".into(),
            project_id: project,
            project_name: "VibeX".into(),
            workspace_id: workspace,
        }];
        let mut imported = BTreeSet::new();
        imported.insert(("codex".to_string(), "already".to_string()));

        let page = build_local_history_scan_page(
            vec![
                session(
                    AgentKind::Codex,
                    "already",
                    Some("/Users/mac/Projects/VibeX"),
                    "Old Codex",
                ),
                session(
                    AgentKind::ClaudeCode,
                    "fresh",
                    Some("/private/Users/mac/Projects/VibeX"),
                    "New Claude",
                ),
                session(AgentKind::Codex, "loose", None, "No folder"),
            ],
            &imported,
            &destinations,
            vec![LocalHistoryDestination {
                project_id: project,
                project_name: "VibeX".into(),
                workspace_id: workspace,
                workspace_name: Some("main".into()),
            }],
        );

        assert_eq!(page.folders.len(), 2);
        assert_eq!(page.total_sessions, 3);
        assert_eq!(page.importable_count, 2);

        let matched = page
            .folders
            .iter()
            .find(|folder| folder.workspace_id == Some(workspace))
            .expect("matched folder");
        assert_eq!(matched.sessions.len(), 2);
        assert!(matched.sessions.iter().any(|session| session.status
            == LocalHistorySessionStatus::Imported
            && session.external_session_id == "already"));
        assert!(
            matched
                .sessions
                .iter()
                .any(|session| session.status == LocalHistorySessionStatus::New
                    && session.external_session_id == "fresh")
        );

        let unmatched = page
            .folders
            .iter()
            .find(|folder| folder.path.is_empty())
            .expect("unmatched folder");
        assert_eq!(unmatched.workspace_id, None);
        assert_eq!(unmatched.sessions[0].external_session_id, "loose");
    }
}
