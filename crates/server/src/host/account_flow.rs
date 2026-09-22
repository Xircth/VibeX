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

pub fn launcher_script_path(agent_id: &AgentId, action_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "vibex-management-{}-{action_id}.cmd",
        agent_id.as_str()
    ))
}

/// The argument a management terminal runs to perform one account action.
///
/// Unix carries the whole thing inline. Windows cannot: the action is spliced
/// into a nested `cmd /C start "" cmd /K`, where the redirect target loses the
/// quotes around it and never reaches the file, and `echo <digit>>file` is read
/// as a write to handle 0 rather than an exit code. Either way the account flow
/// records nothing, so authentication management polls a pending flow forever.
/// Windows instead writes a launcher script and hands the terminal a single
/// path, leaving nothing to be re-parsed or re-quoted.
#[cfg_attr(not(windows), allow(unused_variables))]
pub async fn prepare_management_launch(
    agent_id: &AgentId,
    action_id: &str,
    command: &str,
    assignments: &[String],
    result_path: Option<&Path>,
) -> std::io::Result<String> {
    #[cfg(not(windows))]
    {
        let wrapped = match result_path {
            Some(result_path) => wrap_exit_code_capture(command, result_path),
            None => command.to_string(),
        };
        Ok(if assignments.is_empty() {
            wrapped
        } else {
            format!("{} {wrapped}", assignments.join(" "))
        })
    }
    #[cfg(windows)]
    {
        let script_path = launcher_script_path(agent_id, action_id);
        let mut script = String::from("@echo off\r\n");
        for assignment in assignments {
            script.push_str(assignment);
            script.push_str("\r\n");
        }
        // `cmd /c` keeps a `.cmd` shim on PATH from ending the script early, so
        // the exit code below is still recorded.
        script.push_str("cmd /c ");
        script.push_str(command);
        script.push_str("\r\n");
        if let Some(result_path) = result_path {
            // The space before `>` is load-bearing: `echo 0>"file"` is parsed
            // as a write to handle 0, which leaves the file empty.
            script.push_str(&format!(
                "echo %ERRORLEVEL% >\"{}\"\r\n",
                result_path.display()
            ));
        }
        tokio::fs::write(&script_path, script).await?;
        // Returned unquoted on purpose — the terminal applies this platform's
        // own quoting, and cmd preserves quotes around a quoted path there.
        Ok(script_path.display().to_string())
    }
}

#[cfg(not(windows))]
fn wrap_exit_code_capture(command: &str, result_path: &Path) -> String {
    let path = result_path.display().to_string();
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

/// Forget a registration whose action never launched. Without this the pending
/// view outlives the failed launch and authentication management polls an exit
/// code that will never be written.
pub fn cancel_account_flow(agent_id: &AgentId) {
    if let Ok(mut flows) = pending_flows().lock() {
        flows.remove(agent_id.as_str());
    }
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

    fn agent() -> AgentId {
        AgentId::parse("grok").expect("agent id")
    }

    #[test]
    fn cancelling_a_registration_leaves_the_agent_idle() {
        let agent = agent();
        register_account_flow(
            &agent,
            "login",
            ProfileManagementActionKind::Login,
            PathBuf::from("/tmp/vibex-account-flow-grok.exit"),
        );
        assert!(peek_account_flow(&agent).is_some());

        cancel_account_flow(&agent);

        assert!(peek_account_flow(&agent).is_none());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn launch_prefixes_environment_and_captures_the_exit_code() {
        let result_path = PathBuf::from("/tmp/vibex-account-flow-grok.exit");
        let launch = prepare_management_launch(
            &agent(),
            "login",
            "grok login",
            &["GROK_HOME='/a b'".to_string()],
            Some(&result_path),
        )
        .await
        .expect("launch");

        assert!(launch.starts_with("GROK_HOME='/a b' "));
        assert!(launch.contains("grok login"));
        assert!(launch.contains("printf '%s\\n' \"$?\""));
        assert!(launch.contains("/tmp/vibex-account-flow-grok.exit"));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn launch_without_a_watched_action_runs_the_command_alone() {
        let launch = prepare_management_launch(&agent(), "setup", "grok setup", &[], None)
            .await
            .expect("launch");

        assert_eq!(launch, "grok setup");
    }

    /// The exit code has to survive the terminal's own command line, which is
    /// what the previous one-liner could not do on Windows.
    #[cfg(windows)]
    #[tokio::test]
    async fn launch_writes_a_script_that_records_the_exit_code() {
        let result_path = PathBuf::from(r"C:\Temp\vibex-account-flow-grok.exit");
        let launch = prepare_management_launch(
            &agent(),
            "login",
            r#""C:\Program Files\grok\grok.cmd" login"#,
            &[r#"set "GROK_HOME=C:\a b\grok home""#.to_string()],
            Some(&result_path),
        )
        .await
        .expect("launch");

        let script = tokio::fs::read_to_string(&launch).await.expect("script");
        let _ = tokio::fs::remove_file(&launch).await;

        assert_eq!(
            launch,
            launcher_script_path(&agent(), "login")
                .display()
                .to_string()
        );
        assert!(script.starts_with("@echo off\r\n"));
        assert!(script.contains("set \"GROK_HOME=C:\\a b\\grok home\"\r\n"));
        assert!(script.contains("cmd /c \"C:\\Program Files\\grok\\grok.cmd\" login\r\n"));
        // The separating space is required; `echo 0>"file"` writes to handle 0.
        assert!(script.contains("echo %ERRORLEVEL% >\"C:\\Temp\\vibex-account-flow-grok.exit\""));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn launch_without_a_watched_action_omits_the_exit_code() {
        let launch = prepare_management_launch(&agent(), "setup", "grok setup", &[], None)
            .await
            .expect("launch");

        let script = tokio::fs::read_to_string(&launch).await.expect("script");
        let _ = tokio::fs::remove_file(&launch).await;

        assert!(script.contains("cmd /c grok setup\r\n"));
        assert!(!script.contains("ERRORLEVEL"));
    }

    #[test]
    fn parses_unix_and_windows_exit_files() {
        assert_eq!(parse_account_flow_exit("0\n"), Some(0));
        assert_eq!(parse_account_flow_exit("1\r\n"), Some(1));
        assert_eq!(parse_account_flow_exit("  "), None);
    }
}
