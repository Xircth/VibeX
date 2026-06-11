//! QA Mode: Mock executor for testing
//!
//! This module provides a mock executor that:
//! 1. Performs random file operations (create, delete, modify)
//! 2. Streams 10 mock log entries over 10 seconds
//! 3. Outputs simple JSONL diagnostics for QA inspection.

use std::{path::Path, process::Stdio, sync::Arc};

use async_trait::async_trait;
use rand::seq::SliceRandom as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

use crate::{
    env::ExecutionEnv,
    executors::{ExecutorError, SpawnedChild, StandardCodingAgentExecutor},
};

/// Mock executor for QA testing
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, TS, JsonSchema)]
pub struct QaMockExecutor;

impl QaMockExecutor {
    async fn spawn_with_session(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: Option<&str>,
    ) -> Result<SpawnedChild, ExecutorError> {
        info!("QA Mock Executor: spawning mock execution");

        // 1. Perform file operations before spawning the log output process
        perform_file_operations(current_dir).await;

        // 2. Generate mock logs and write to temp file to avoid shell escaping issues
        let logs = match session_id {
            Some(session_id) => generate_mock_logs_for_session(prompt, session_id.to_string()),
            None => generate_mock_logs(prompt),
        };
        let temp_dir = std::env::temp_dir();
        let log_file = temp_dir.join(format!("qa_mock_logs_{}.jsonl", uuid::Uuid::new_v4()));

        // Write all logs to file, one per line
        let content = logs.join("\n") + "\n";
        tokio::fs::write(&log_file, &content)
            .await
            .map_err(|e| ExecutorError::Io(std::io::Error::other(e)))?;

        // 3. Create shell script that reads file and outputs with delays
        // Using IFS= read -r to preserve exact content (no word splitting, no backslash interpretation)
        let script = format!(
            r#"while IFS= read -r line; do echo "$line"; sleep 1; done < "{}"; rm -f "{}""#,
            log_file.display(),
            log_file.display()
        );

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(&script)
            .current_dir(current_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child =
            workspace_utils::process::group_spawn_no_window(&mut cmd).map_err(ExecutorError::Io)?;
        Ok(SpawnedChild::from(child))
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for QaMockExecutor {
    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        self.spawn_with_session(current_dir, prompt, None).await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        info!("QA Mock Executor: follow-up request preserving session id");
        self.spawn_with_session(current_dir, prompt, Some(session_id))
            .await
    }

    fn normalize_logs(&self, _msg_store: Arc<MsgStore>, _current_dir: &Path) {}

    fn default_mcp_config_path(&self) -> Option<std::path::PathBuf> {
        None // QA mock doesn't need MCP config
    }
}

/// Perform random file operations in the worktree
async fn perform_file_operations(dir: &Path) {
    info!("QA Mock: performing file operations in {:?}", dir);

    // Create: qa_created_{uuid}.txt
    let uuid = uuid::Uuid::new_v4();
    let new_file = dir.join(format!("qa_created_{}.txt", uuid));
    match tokio::fs::write(&new_file, "QA mode created this file\n").await {
        Ok(_) => info!("QA Mock: created file {:?}", new_file),
        Err(e) => warn!("QA Mock: failed to create file: {}", e),
    }

    // Find files (excluding .git and binary files)
    let files: Vec<_> = walkdir::WalkDir::new(dir)
        .max_depth(3) // Limit depth to avoid long walks
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| !e.path().to_string_lossy().contains(".git"))
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ["rs", "ts", "js", "txt", "md", "json"].contains(&ext))
        })
        .collect();

    if files.len() >= 2 {
        // Pick random indices before any await points (thread_rng is not Send)
        let (remove_idx, modify_idx) = {
            let mut rng = rand::thread_rng();
            let mut indices: Vec<usize> = (0..files.len()).collect();
            indices.shuffle(&mut rng);
            (indices.first().copied(), indices.get(1).copied())
        };

        // Remove a random file (first shuffled index)
        if let Some(idx) = remove_idx {
            let file_to_remove = files[idx].path().to_path_buf();
            // Don't remove the file we just created
            if file_to_remove != new_file {
                match tokio::fs::remove_file(&file_to_remove).await {
                    Ok(_) => info!("QA Mock: removed file {:?}", file_to_remove),
                    Err(e) => warn!("QA Mock: failed to remove file: {}", e),
                }
            }
        }

        // Modify a different random file (second shuffled index)
        if let Some(idx) = modify_idx {
            let file_to_modify = files[idx].path().to_path_buf();
            // Don't modify the file we just created
            if file_to_modify != new_file {
                match tokio::fs::read_to_string(&file_to_modify).await {
                    Ok(content) => {
                        let modified = format!(
                            "{}\n// QA modification at {}\n",
                            content,
                            chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC")
                        );
                        match tokio::fs::write(&file_to_modify, modified).await {
                            Ok(_) => info!("QA Mock: modified file {:?}", file_to_modify),
                            Err(e) => warn!("QA Mock: failed to write modified file: {}", e),
                        }
                    }
                    Err(e) => warn!("QA Mock: failed to read file for modification: {}", e),
                }
            }
        }
    } else {
        info!(
            "QA Mock: not enough files found for remove/modify operations (found {})",
            files.len()
        );
    }
}

/// Generate mock log entries as simple JSON diagnostics.
fn generate_mock_logs(prompt: &str) -> Vec<String> {
    generate_mock_logs_for_session(prompt, uuid::Uuid::new_v4().to_string())
}

fn generate_mock_logs_for_session(prompt: &str, session_id: String) -> Vec<String> {
    let logs = vec![
        serde_json::json!({ "kind": "session_start", "session_id": session_id }),
        serde_json::json!({ "kind": "user", "text": prompt }),
        serde_json::json!({
            "kind": "thought",
            "text": "Analyzing the QA task and preparing mock execution..."
        }),
        serde_json::json!({
            "kind": "message",
            "text": format!(
                "QA mode execution completed successfully.\n\nI performed mock file operations.\nOriginal prompt: {prompt}",
            )
        }),
        serde_json::json!({ "kind": "done", "stop_reason": "end_turn" }),
    ];

    logs.into_iter()
        .map(|log| serde_json::to_string(&log).expect("QA log should serialize"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_mock_logs_count() {
        let logs = generate_mock_logs("test prompt");
        assert_eq!(logs.len(), 5, "Should generate exactly 5 log entries");
    }

    #[test]
    fn test_generate_mock_logs_valid_json() {
        let logs = generate_mock_logs("test prompt");
        for (i, log) in logs.iter().enumerate() {
            let parsed: Result<serde_json::Value, _> = serde_json::from_str(log);
            assert!(
                parsed.is_ok(),
                "Log entry {} should be valid JSON: {}",
                i,
                log
            );
        }
    }

    #[test]
    fn test_generate_mock_logs_include_kind() {
        let logs = generate_mock_logs("test prompt");
        for (i, log) in logs.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(log).expect("valid json");
            assert!(
                parsed.get("kind").and_then(serde_json::Value::as_str).is_some(),
                "Log entry {} should include a kind: {}",
                i,
                log
            );
        }
    }

    #[test]
    fn test_escape_special_characters() {
        let logs = generate_mock_logs("test with \"quotes\" and\nnewlines");
        let final_log = &logs[3];
        let parsed: serde_json::Value = serde_json::from_str(final_log).unwrap();

        assert_eq!(parsed["kind"], "message");
        assert!(parsed["text"]
            .as_str()
            .expect("message text")
            .contains("test with \"quotes\" and\nnewlines"));
    }

    #[test]
    fn test_generate_mock_logs_can_preserve_follow_up_session_id() {
        let logs = generate_mock_logs_for_session("follow up", "existing-session".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&logs[0]).unwrap();

        assert_eq!(parsed["kind"], "session_start");
        assert_eq!(parsed["session_id"], "existing-session");
    }
}
