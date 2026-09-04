use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use agents::profiles::ProfileManagementActionKind;
use api_types::{AgentAccountFlowStatus, AgentAccountFlowView, AgentId};

#[derive(Clone)]
pub struct PendingAccountFlow {
    pub action_id: String,
    pub kind: ProfileManagementActionKind,
    pub result_path: PathBuf,
}

fn pending_flows() -> &'static Mutex<HashMap<String, PendingAccountFlow>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, PendingAccountFlow>>> = OnceLock::new();
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn account_flow_result_path(agent_id: &AgentId) -> PathBuf {
    std::env::temp_dir().join(format!("vibex-account-flow-{}.exit", agent_id.as_str()))
}

pub fn wrap_account_flow_command(command: &str, result_path: &Path) -> String {
    let path = result_path.display().to_string();
    #[cfg(windows)]
    {
        format!("{command} & call echo %ERRORLEVEL%>\"{path}\"")
    }
    #[cfg(not(windows))]
    {
        let quoted = if path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:\\".contains(&byte))
        {
            path
        } else {
            format!("'{}'", path.replace('\'', "'\\''"))
        };
        format!("{{ {command}; }}; printf '%s\\n' \"$?\" > {quoted}")
    }
}

pub fn parse_account_flow_exit(contents: &str) -> Option<i32> {
    contents.trim().parse().ok()
}

pub fn register_account_flow(
    agent_id: &AgentId,
    action_id: impl Into<String>,
    kind: ProfileManagementActionKind,
    result_path: PathBuf,
) {
    if let Ok(mut flows) = pending_flows().lock() {
        flows.insert(
            agent_id.as_str().to_string(),
            PendingAccountFlow {
                action_id: action_id.into(),
                kind,
                result_path,
            },
        );
    }
}

pub fn take_account_flow(agent_id: &AgentId) -> Option<PendingAccountFlow> {
    pending_flows()
        .lock()
        .ok()
        .and_then(|mut flows| flows.remove(agent_id.as_str()))
}

pub fn peek_account_flow(agent_id: &AgentId) -> Option<PendingAccountFlow> {
    pending_flows()
        .lock()
        .ok()
        .and_then(|flows| flows.get(agent_id.as_str()).cloned())
}

pub fn idle_account_flow(agent_id: AgentId) -> AgentAccountFlowView {
    AgentAccountFlowView {
        agent_id,
        action_id: None,
        status: AgentAccountFlowStatus::Idle,
        exit_code: None,
        authentication: None,
    }
}

pub fn pending_account_flow_view(agent_id: AgentId, action_id: String) -> AgentAccountFlowView {
    AgentAccountFlowView {
        agent_id,
        action_id: Some(action_id),
        status: AgentAccountFlowStatus::Pending,
        exit_code: None,
        authentication: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_writes_the_command_exit_code() {
        let path = PathBuf::from("/tmp/vibex-account-flow-codex.exit");
        let wrapped = wrap_account_flow_command("codex logout", &path);
        assert!(wrapped.contains("codex logout"));
        assert!(wrapped.contains("/tmp/vibex-account-flow-codex.exit"));
        #[cfg(not(windows))]
        assert!(wrapped.contains("printf '%s\\n' \"$?\""));
    }

    #[test]
    fn parses_unix_and_windows_exit_files() {
        assert_eq!(parse_account_flow_exit("0\n"), Some(0));
        assert_eq!(parse_account_flow_exit("1\r\n"), Some(1));
        assert_eq!(parse_account_flow_exit("  "), None);
    }
}
