//! QA Mode: Mock executor for testing
//!
//! This module provides a mock executor that:
//! 1. Performs random file operations (create, delete, modify)
//! 2. Streams 10 mock log entries over 10 seconds
//! 3. Outputs logs in ACP event format for compatibility with ACP log normalization

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
    executors::{
        ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
        acp::{self, AcpEvent},
    },
};

/// Mock executor for QA testing
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, TS, JsonSchema)]
pub struct QaMockExecutor;

#[async_trait]
impl StandardCodingAgentExecutor for QaMockExecutor {
    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        info!("QA Mock Executor: spawning mock execution");

        // 1. Perform file operations before spawning the log output process
        perform_file_operations(current_dir).await;

        // 2. Generate mock logs and write to temp file to avoid shell escaping issues
        let logs = generate_mock_logs(prompt);
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

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        _session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        // QA mode doesn't support real sessions, just spawn fresh
        info!("QA Mock Executor: follow-up request treated as new spawn");
        self.spawn(current_dir, prompt, env).await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, current_dir: &Path) {
        acp::normalize_logs(msg_store, current_dir);
    }

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

/// Generate mock log entries in ACP event format using strongly-typed structs.
fn generate_mock_logs(prompt: &str) -> Vec<String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let logs = vec![
        AcpEvent::SessionStart(session_id),
        AcpEvent::User(prompt.to_string()),
        AcpEvent::Thought(agent_client_protocol::ContentBlock::Text(
            agent_client_protocol::TextContent::new(
                "Analyzing the QA task and preparing mock execution...",
            ),
        )),
        AcpEvent::Message(agent_client_protocol::ContentBlock::Text(
            agent_client_protocol::TextContent::new(format!(
                "QA mode execution completed successfully.\n\nI performed mock file operations.\nOriginal prompt: {prompt}",
            )),
        )),
        AcpEvent::Done("\"end_turn\"".to_string()),
    ];

    logs.into_iter()
        .map(|log| serde_json::to_string(&log).expect("AcpEvent should serialize"))
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
    fn test_generate_mock_logs_deserializes_to_acp_event() {
        let logs = generate_mock_logs("test prompt");
        for (i, log) in logs.iter().enumerate() {
            let parsed: Result<AcpEvent, _> = serde_json::from_str(log);
            assert!(
                parsed.is_ok(),
                "Log entry {} should deserialize to AcpEvent: {} - error: {:?}",
                i,
                log,
                parsed.err()
            );
        }
    }

    #[test]
    fn test_escape_special_characters() {
        let logs = generate_mock_logs("test with \"quotes\" and\nnewlines");
        let final_log = &logs[3];
        let parsed: AcpEvent = serde_json::from_str(final_log).unwrap();

        if let AcpEvent::Message(agent_client_protocol::ContentBlock::Text(text)) = parsed {
            assert!(text.text.contains("test with \"quotes\" and\nnewlines"));
        } else {
            panic!("Expected message text event");
        }
    }
}
