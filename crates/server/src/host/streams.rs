use std::{
    collections::HashSet,
    sync::{Arc, OnceLock},
};

use application::{ApplicationError, DomainCommand};
use db::models::{scratch::ScratchType, workspace::Workspace};
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use utils::log_msg::LogMsg;
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse},
    host::events::global_host_events,
};

static FILE_TREE_WATCHERS: OnceLock<Arc<Mutex<HashSet<String>>>> = OnceLock::new();
static CONVERSATION_STREAMS: OnceLock<Arc<Mutex<HashSet<String>>>> = OnceLock::new();

fn file_tree_watchers() -> Arc<Mutex<HashSet<String>>> {
    FILE_TREE_WATCHERS
        .get_or_init(|| Arc::new(Mutex::new(HashSet::new())))
        .clone()
}

fn conversation_streams() -> Arc<Mutex<HashSet<String>>> {
    CONVERSATION_STREAMS
        .get_or_init(|| Arc::new(Mutex::new(HashSet::new())))
        .clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffStreamArgs {
    workspace_id: Uuid,
    stats_only: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationStreamArgs {
    execution_process_id: Uuid,
    normalized: Option<bool>,
    stream_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionProcessesStreamArgs {
    session_id: Uuid,
    show_soft_deleted: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStreamArgs {
    project_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeStreamArgs {
    root_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScratchStreamArgs {
    scratch_id: Uuid,
    scratch_type: ScratchType,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogStreamArgs {
    process_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlashCommandsStreamArgs {
    executor_profile_id: ExecutorProfileId,
    workspace_id: Option<Uuid>,
    repo_id: Option<Uuid>,
}

#[derive(serde::Serialize)]
struct FileTreeChangedPayload {
    root_path: String,
}

impl ServerApplicationDomains {
    pub(crate) async fn subscribe_stream(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::SubscribeDiffStream => self.subscribe_diff_stream(args).await,
            DomainCommand::SubscribeConversationStream => {
                self.subscribe_conversation_stream(args).await
            }
            DomainCommand::SubscribeExecutionProcessesStream => {
                self.subscribe_execution_processes_stream(args).await
            }
            DomainCommand::SubscribeProjectWorkspacesStream => {
                self.subscribe_project_workspaces_stream(args).await
            }
            DomainCommand::SubscribeProjectsStream => self.subscribe_projects_stream().await,
            DomainCommand::SubscribeFileTreeStream => self.subscribe_file_tree_stream(args).await,
            DomainCommand::SubscribeScratchStream => self.subscribe_scratch_stream(args).await,
            DomainCommand::SubscribeLogStream => self.subscribe_log_stream(args).await,
            DomainCommand::SubscribeSlashCommandsStream => {
                self.subscribe_slash_commands_stream(args).await
            }
            other => Err(ApplicationError::not_found(format!(
                "command `{}` is not a stream subscription",
                other.as_str()
            ))),
        }
    }

    async fn subscribe_diff_stream(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DiffStreamArgs = parse(args)?;
        let workspace = Workspace::find_by_id(&self.pool, args.workspace_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!("Workspace {} not found", args.workspace_id))
            })?;
        let channel = format!("diff-stream:{}", args.workspace_id);
        let deployment = self.deployment.clone();
        let stats = args.stats_only.unwrap_or(false);
        tokio::spawn(async move {
            match deployment.container().stream_diff(&workspace, stats).await {
                Ok(mut stream) => {
                    while let Some(Ok(msg)) = stream.next().await {
                        global_host_events().emit(&channel, &msg);
                    }
                }
                Err(error) => tracing::error!(%error, "failed to start diff stream"),
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_conversation_stream(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ConversationStreamArgs = parse(args)?;
        let channel = match args.stream_id.as_deref().filter(|id| !id.is_empty()) {
            Some(stream_id) => format!(
                "conversation-stream:{}:{stream_id}",
                args.execution_process_id
            ),
            None => format!("conversation-stream:{}", args.execution_process_id),
        };
        let stream_key = match args.stream_id.as_deref().filter(|id| !id.is_empty()) {
            Some(stream_id) => format!("{}:{stream_id}", args.execution_process_id),
            None => args.execution_process_id.to_string(),
        };
        {
            let registry = conversation_streams();
            let mut streams = registry.lock().await;
            if streams.contains(&stream_key) {
                return Ok(Value::Null);
            }
            streams.insert(stream_key.clone());
        }
        let deployment = self.deployment.clone();
        let use_normalized = args.normalized.unwrap_or(true);
        let process_id = args.execution_process_id;
        tokio::spawn(async move {
            let stream_opt = if use_normalized {
                deployment
                    .container()
                    .stream_normalized_logs(&process_id)
                    .await
            } else {
                deployment.container().stream_raw_logs(&process_id).await
            };
            if let Some(mut stream) = stream_opt {
                while let Some(Ok(msg)) = stream.next().await {
                    global_host_events().emit(&channel, &msg);
                }
            }
            global_host_events().emit(&channel, &LogMsg::Finished);
            let registry = conversation_streams();
            registry.lock().await.remove(&stream_key);
        });
        Ok(Value::Null)
    }

    async fn subscribe_execution_processes_stream(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: ExecutionProcessesStreamArgs = parse(args)?;
        let channel = format!("execution-processes-stream:{}", args.session_id);
        let deployment = self.deployment.clone();
        let soft_deleted = args.show_soft_deleted.unwrap_or(false);
        tokio::spawn(async move {
            match deployment
                .events()
                .stream_execution_processes_for_session_raw(args.session_id, soft_deleted)
                .await
            {
                Ok(mut stream) => {
                    while let Some(Ok(msg)) = stream.next().await {
                        global_host_events().emit(&channel, &msg);
                    }
                }
                Err(error) => tracing::error!(%error, "failed to start execution processes stream"),
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_project_workspaces_stream(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: ProjectStreamArgs = parse(args)?;
        let channel = format!("project-workspaces-stream:{}", args.project_id);
        let deployment = self.deployment.clone();
        tokio::spawn(async move {
            match deployment
                .events()
                .stream_project_workspaces_raw(args.project_id)
                .await
            {
                Ok(mut stream) => {
                    while let Some(Ok(msg)) = stream.next().await {
                        global_host_events().emit(&channel, &msg);
                    }
                }
                Err(error) => tracing::error!(%error, "failed to start project workspaces stream"),
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_projects_stream(&self) -> Result<Value, ApplicationError> {
        let deployment = self.deployment.clone();
        tokio::spawn(async move {
            match deployment.events().stream_projects_raw().await {
                Ok(mut stream) => {
                    while let Some(Ok(msg)) = stream.next().await {
                        global_host_events().emit("projects-stream", &msg);
                    }
                }
                Err(error) => tracing::error!(%error, "failed to start projects stream"),
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_file_tree_stream(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: FileTreeStreamArgs = parse(args)?;
        let canonical_root = std::fs::canonicalize(&args.root_path).map_err(|error| {
            ApplicationError::bad_request(format!(
                "Invalid file tree root '{}': {error}",
                args.root_path
            ))
        })?;
        let canonical_root_str = canonical_root.to_string_lossy().to_string();
        {
            let registry = file_tree_watchers();
            let mut watchers = registry.lock().await;
            if watchers.contains(&canonical_root_str) {
                return Ok(Value::Null);
            }
            watchers.insert(canonical_root_str.clone());
        }
        tokio::spawn(async move {
            match services::services::filesystem_watcher::async_watcher(canonical_root) {
                Ok((_watcher, mut receiver, normalized_root)) => {
                    let normalized_root_str = normalized_root.to_string_lossy().to_string();
                    while let Some(result) = receiver.next().await {
                        match result {
                            Ok(events) if !events.is_empty() => {
                                global_host_events().emit(
                                    "file-tree-stream",
                                    &FileTreeChangedPayload {
                                        root_path: normalized_root_str.clone(),
                                    },
                                );
                            }
                            Ok(_) => {}
                            Err(errors) => tracing::warn!(
                                "file tree watcher error for {normalized_root_str}: {errors:?}"
                            ),
                        }
                    }
                }
                Err(error) => tracing::error!(
                    "failed to start file tree watcher for {canonical_root_str}: {error}"
                ),
            }
            let registry = file_tree_watchers();
            registry.lock().await.remove(&canonical_root_str);
        });
        Ok(Value::Null)
    }

    async fn subscribe_scratch_stream(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ScratchStreamArgs = parse(args)?;
        let channel = format!("scratch-stream:{}", args.scratch_id);
        let deployment = self.deployment.clone();
        tokio::spawn(async move {
            match deployment
                .events()
                .stream_scratch_raw(args.scratch_id, &args.scratch_type)
                .await
            {
                Ok(mut stream) => {
                    while let Some(Ok(msg)) = stream.next().await {
                        global_host_events().emit(&channel, &msg);
                    }
                }
                Err(error) => tracing::error!(%error, "failed to start scratch stream"),
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_log_stream(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: LogStreamArgs = parse(args)?;
        let channel = format!("log-stream:{}", args.process_id);
        let deployment = self.deployment.clone();
        tokio::spawn(async move {
            if let Some(mut stream) = deployment
                .container()
                .stream_raw_logs(&args.process_id)
                .await
            {
                while let Some(Ok(msg)) = stream.next().await {
                    global_host_events().emit(&channel, &msg);
                }
            }
        });
        Ok(Value::Null)
    }

    async fn subscribe_slash_commands_stream(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: SlashCommandsStreamArgs = parse(args)?;
        let variant_str = args
            .executor_profile_id
            .variant
            .as_deref()
            .unwrap_or("default");
        let ws_str = args
            .workspace_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "none".to_string());
        let repo_str = args
            .repo_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "none".to_string());
        let channel = format!(
            "slash-commands-stream:{}:{}:{}:{}",
            args.executor_profile_id.executor, variant_str, ws_str, repo_str
        );
        let deployment = self.deployment.clone();
        tokio::spawn(async move {
            match deployment
                .container()
                .available_agent_slash_commands(
                    args.executor_profile_id,
                    args.workspace_id,
                    args.repo_id,
                )
                .await
            {
                Ok(Some(mut stream)) => {
                    while let Some(patch) = stream.next().await {
                        global_host_events().emit(&channel, LogMsg::JsonPatch(patch));
                    }
                    global_host_events().emit(&channel, &LogMsg::Finished);
                }
                Ok(None) => {
                    global_host_events().emit(&channel, &LogMsg::Finished);
                }
                Err(error) => {
                    tracing::error!(%error, "failed to start slash commands stream");
                    global_host_events().emit(&channel, &LogMsg::Finished);
                }
            }
        });
        Ok(json!(null))
    }
}
