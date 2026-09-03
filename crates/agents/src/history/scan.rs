use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
};

use api_types::{AgentId, AgentKind};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::{
    AgentHistoryError, AgentHistorySource, ImportedAgentSession, configured_history_sources,
    import_history_source, visit_imported_sessions,
};

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryScanEntry {
    pub source_agent: AgentKind,
    pub external_session_id: String,
    pub title: Option<String>,
    pub workspace_path: Option<PathBuf>,
    pub message_count: u32,
    pub updated_at: Option<DateTime<Utc>>,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum LocalHistoryImportPhase {
    Loading,
    Importing,
    Imported,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryImportProgress {
    pub current: u32,
    pub total: u32,
    pub agent_id: AgentId,
    pub external_session_id: String,
    pub title: Option<String>,
    pub phase: LocalHistoryImportPhase,
    pub imported: u32,
    pub skipped: u32,
    pub failed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
}

impl LocalHistoryImportProgress {
    pub fn for_selection(
        current: u32,
        total: u32,
        selection: &LocalHistoryImportSelection,
        title: Option<String>,
        phase: LocalHistoryImportPhase,
        result: &LocalHistoryImportResult,
    ) -> Self {
        Self {
            current,
            total,
            agent_id: selection.agent_id.clone(),
            external_session_id: selection.external_session_id.clone(),
            title,
            phase,
            imported: result.imported,
            skipped: result.skipped,
            failed: result.failed,
            conversation_id: None,
            workspace_id: None,
        }
    }

    pub fn with_conversation(mut self, conversation_id: Uuid, workspace_id: Uuid) -> Self {
        self.conversation_id = Some(conversation_id);
        self.workspace_id = Some(workspace_id);
        self
    }
}

const MAX_IMPORT_LOG_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum LocalHistoryImportJobStatus {
    Idle,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryImportLogEntry {
    pub phase: LocalHistoryImportPhase,
    pub agent_id: AgentId,
    pub external_session_id: String,
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LocalHistoryImportJobSnapshot {
    pub status: LocalHistoryImportJobStatus,
    pub progress: Option<LocalHistoryImportProgress>,
    pub result: Option<LocalHistoryImportResult>,
    pub log: Vec<LocalHistoryImportLogEntry>,
}

impl Default for LocalHistoryImportJobSnapshot {
    fn default() -> Self {
        Self {
            status: LocalHistoryImportJobStatus::Idle,
            progress: None,
            result: None,
            log: Vec::new(),
        }
    }
}

impl LocalHistoryImportJobSnapshot {
    pub fn begin_running() -> Self {
        Self {
            status: LocalHistoryImportJobStatus::Running,
            progress: None,
            result: None,
            log: Vec::new(),
        }
    }

    pub fn apply_progress(&mut self, progress: LocalHistoryImportProgress) {
        self.status = LocalHistoryImportJobStatus::Running;
        if matches!(
            progress.phase,
            LocalHistoryImportPhase::Imported
                | LocalHistoryImportPhase::Skipped
                | LocalHistoryImportPhase::Failed
        ) {
            self.log.push(LocalHistoryImportLogEntry {
                phase: progress.phase,
                agent_id: progress.agent_id.clone(),
                external_session_id: progress.external_session_id.clone(),
                title: progress.title.clone(),
                conversation_id: progress.conversation_id,
                error: None,
            });
            if self.log.len() > MAX_IMPORT_LOG_ENTRIES {
                let overflow = self.log.len() - MAX_IMPORT_LOG_ENTRIES;
                self.log.drain(0..overflow);
            }
        }
        self.progress = Some(progress);
    }

    pub fn finish(&mut self, result: LocalHistoryImportResult) {
        self.status = if result.imported == 0 && result.failed > 0 {
            LocalHistoryImportJobStatus::Failed
        } else {
            LocalHistoryImportJobStatus::Completed
        };
        self.result = Some(result);
    }

    pub fn fail_to_start(&mut self, error: String) {
        self.status = LocalHistoryImportJobStatus::Failed;
        self.result = Some(LocalHistoryImportResult {
            imported: 0,
            skipped: 0,
            failed: 1,
            conversation_ids: Vec::new(),
            errors: vec![error],
        });
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub struct LocalHistoryScanProgress {
    pub session_count: u32,
    pub bytes_scanned: u64,
}

pub fn scan_configured_history(
    agent_type: AgentKind,
    configured_env: &HashMap<String, String>,
) -> Result<Vec<HistoryScanEntry>, AgentHistoryError> {
    scan_configured_history_with_progress(agent_type, configured_env, |_| {})
}

pub fn scan_configured_history_with_progress(
    agent_type: AgentKind,
    configured_env: &HashMap<String, String>,
    on_progress: impl FnMut(LocalHistoryScanProgress),
) -> Result<Vec<HistoryScanEntry>, AgentHistoryError> {
    let sources = configured_history_sources(agent_type, configured_env);
    scan_history_sources(&sources, on_progress)
}

pub fn load_configured_history_session(
    agent_type: AgentKind,
    configured_env: &HashMap<String, String>,
    external_session_id: &str,
) -> Result<ImportedAgentSession, AgentHistoryError> {
    let sources = configured_history_sources(agent_type, configured_env);
    let mut first_error = None;
    for source in &sources {
        match load_history_session_from_source(source, external_session_id) {
            Ok(session) => return Ok(session),
            Err(AgentHistoryError::MissingSource(_)) => {}
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    Err(first_error.unwrap_or_else(|| AgentHistoryError::Parse {
        path: PathBuf::from(external_session_id),
        error: format!("local session {external_session_id} was not found"),
    }))
}

fn scan_history_sources(
    sources: &[AgentHistorySource],
    mut on_progress: impl FnMut(LocalHistoryScanProgress),
) -> Result<Vec<HistoryScanEntry>, AgentHistoryError> {
    let mut by_id = BTreeMap::<String, HistoryScanEntry>::new();
    let mut seen_files = BTreeSet::new();
    let mut bytes_scanned = 0u64;
    let mut first_error = None;
    for source in sources {
        if !source.path.exists() {
            continue;
        }
        match visit_imported_sessions(source, |session| {
            if let Some(path) = session.raw_source_path.as_ref()
                && seen_files.insert(path.clone())
            {
                bytes_scanned = bytes_scanned.saturating_add(source_len(path));
            }
            let entry = HistoryScanEntry::from(&session);
            let replace = by_id
                .get(&entry.external_session_id)
                .is_none_or(|existing| entry.message_count > existing.message_count);
            if replace {
                by_id.insert(entry.external_session_id.clone(), entry);
            }
            on_progress(LocalHistoryScanProgress {
                session_count: u32::try_from(by_id.len()).unwrap_or(u32::MAX),
                bytes_scanned,
            });
            true
        }) {
            Ok(()) => {}
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
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.external_session_id.cmp(&right.external_session_id))
    });
    Ok(sessions)
}

fn load_history_session_from_source(
    source: &AgentHistorySource,
    external_session_id: &str,
) -> Result<ImportedAgentSession, AgentHistoryError> {
    let mut found = None;
    visit_imported_sessions(source, |session| {
        if session.external_session_id == external_session_id {
            found = Some(session);
            false
        } else {
            true
        }
    })?;
    found.ok_or_else(|| AgentHistoryError::Parse {
        path: source.path.clone(),
        error: format!("local session {external_session_id} was not found"),
    })
}

impl From<&ImportedAgentSession> for HistoryScanEntry {
    fn from(session: &ImportedAgentSession) -> Self {
        Self {
            source_agent: session.source_agent,
            external_session_id: session.external_session_id.clone(),
            title: session.title.clone(),
            workspace_path: session.workspace_path.clone(),
            message_count: u32::try_from(session.messages.len()).unwrap_or(u32::MAX),
            updated_at: session.activity_times().map(|(_, updated)| updated),
        }
    }
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
    sessions: Vec<HistoryScanEntry>,
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
        let message_count = session.message_count;
        let updated_at = session.updated_at.map(|time| time.to_rfc3339());
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
    session.activity_times().map(|(_, updated)| updated)
}

fn source_len(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(
        agent: AgentKind,
        external_id: &str,
        path: Option<&str>,
        title: &str,
    ) -> HistoryScanEntry {
        HistoryScanEntry {
            source_agent: agent,
            external_session_id: external_id.to_string(),
            title: Some(title.to_string()),
            workspace_path: path.map(std::path::PathBuf::from),
            message_count: 1,
            updated_at: None,
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

    #[test]
    fn import_job_logs_finished_sessions_and_keeps_live_progress() {
        let mut snapshot = LocalHistoryImportJobSnapshot::begin_running();
        let agent_id = AgentId::parse("codex").expect("codex");
        let selection = LocalHistoryImportSelection {
            agent_id: agent_id.clone(),
            external_session_id: "codex-1".into(),
            workspace_id: Uuid::from_u128(1),
        };
        let mut result = LocalHistoryImportResult {
            imported: 0,
            skipped: 0,
            failed: 0,
            conversation_ids: Vec::new(),
            errors: Vec::new(),
        };
        snapshot.apply_progress(LocalHistoryImportProgress::for_selection(
            1,
            2,
            &selection,
            Some("One".into()),
            LocalHistoryImportPhase::Loading,
            &result,
        ));
        assert!(snapshot.log.is_empty());
        result.imported = 1;
        snapshot.apply_progress(
            LocalHistoryImportProgress::for_selection(
                1,
                2,
                &selection,
                Some("One".into()),
                LocalHistoryImportPhase::Imported,
                &result,
            )
            .with_conversation(Uuid::from_u128(9), selection.workspace_id),
        );
        assert_eq!(snapshot.log.len(), 1);
        assert_eq!(snapshot.log[0].external_session_id, "codex-1");
        snapshot.finish(result);
        assert_eq!(snapshot.status, LocalHistoryImportJobStatus::Completed);
    }

    #[test]
    fn scan_progress_counts_unique_sessions_and_source_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("one.jsonl");
        let second = temp.path().join("two.jsonl");
        std::fs::write(
            &first,
            r#"{"session_id":"a","role":"user","content":"hello"}"#,
        )
        .unwrap();
        std::fs::write(
            &second,
            r#"{"session_id":"b","role":"user","content":"world"}"#,
        )
        .unwrap();
        let expected_bytes = first.metadata().unwrap().len() + second.metadata().unwrap().len();
        let mut reports = Vec::new();
        let sessions = scan_history_sources(
            &[AgentHistorySource {
                agent_type: AgentKind::ClaudeCode,
                path: temp.path().to_path_buf(),
            }],
            |progress| reports.push(progress),
        )
        .unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(!reports.is_empty());
        let last = *reports.last().expect("progress");
        assert_eq!(last.session_count, 2);
        assert_eq!(last.bytes_scanned, expected_bytes);
        assert!(
            reports
                .windows(2)
                .all(|pair| pair[0].session_count <= pair[1].session_count)
        );
    }
}
