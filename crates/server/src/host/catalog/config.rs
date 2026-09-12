use std::{collections::HashMap, time::Duration};

use agents::{
    AgentCapability, AgentContentBlock, AgentId, AgentSessionId, CancelAgentPromptInput,
    EnsureAgentSessionInput, SendAgentPromptInput, agent_capabilities,
    events::{AgentEvent, AgentSessionConfigOverride},
    permissions::AgentAutoApproveMode,
};
use application::ApplicationError;
use deployment::Deployment;
use executors::profile::ExecutorConfigs;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use services::services::{
    config::{
        Config, SoundFile,
        editor::{EditorConfig, EditorType},
        load_config_from_file, publish_config_runtime, save_config_to_file,
    },
    prompt_enhancement::{
        PROMPT_ENHANCE_TIMEOUT_SECS, PROMPT_ENHANCEMENT_CANCELLED, PromptEnhancementRequest,
        PromptEnhancementResponse, build_prompt_enhancement_payload, extract_enhanced_prompt,
        is_prompt_enhancement_cancelled_stop, selected_prompt_enhancement_agent,
        validate_prompt_enhancement_request,
    },
    worktree_manager::WorktreeManager,
};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::unwrap_named;
use crate::{
    domains::{PromptEnhancementRun, ServerApplicationDomains, internal_error, parse, serialize},
    host::events::current_host_events,
};

#[derive(Debug, Serialize, Deserialize)]
struct Environment {
    os_type: String,
    os_version: String,
    os_architecture: String,
    bitness: String,
}

#[derive(Debug, Serialize)]
struct UserSystemInfo {
    config: Config,
    #[serde(flatten)]
    profiles: ExecutorConfigs,
    environment: Environment,
    capabilities: HashMap<String, Vec<AgentCapability>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateConfigArgs {
    new_config: Config,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfilesArgs {
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorArgs {
    editor_type: EditorType,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SoundArgs {
    sound_file: SoundFile,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ClaudeSettings {
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    enabled_plugins: HashMap<String, bool>,
}

pub(super) async fn update_config(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UpdateConfigArgs = parse(args)?;
    let new_config = args.new_config;
    if !git::is_valid_branch_prefix(&new_config.git_branch_prefix) {
        return Err(ApplicationError::bad_request(
            "Invalid git branch prefix. Must be a valid git branch name component without slashes.",
        ));
    }
    let previous_theme = domains.deployment.config().read().await.theme.clone();
    let path = utils::assets::settings_path();
    save_config_to_file(&new_config, &path)
        .await
        .map_err(internal_error)?;
    publish_config_runtime(&new_config).await;
    {
        let mut config = domains.deployment.config().write().await;
        *config = new_config.clone();
    }
    WorktreeManager::set_workspace_dir_override(
        new_config
            .workspace_dir
            .as_ref()
            .map(|workspace_dir| utils::path::expand_tilde(workspace_dir)),
    );
    if std::mem::discriminant(&previous_theme) != std::mem::discriminant(&new_config.theme) {
        current_host_events().emit(
            "theme-changed",
            json!({ "theme": new_config.theme.clone() }),
        );
    }
    serialize(new_config)
}

pub(crate) async fn user_system_info(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let config = load_config_from_file(&utils::assets::settings_path()).await;
    publish_config_runtime(&config).await;
    {
        let mut current = domains.deployment.config().write().await;
        *current = config.clone();
    }
    WorktreeManager::set_workspace_dir_override(
        config
            .workspace_dir
            .as_ref()
            .map(|workspace_dir| utils::path::expand_tilde(workspace_dir)),
    );
    let profiles = ExecutorConfigs::get_cached();
    let mut capabilities = HashMap::new();
    for key in profiles.executors.keys() {
        capabilities.insert(key.to_string(), agent_capabilities());
    }
    serialize(UserSystemInfo {
        config,
        profiles,
        environment: Environment {
            os_type: std::env::consts::OS.to_string(),
            os_version: std::env::consts::OS.to_string(),
            os_architecture: std::env::consts::ARCH.to_string(),
            bitness: if usize::BITS == 64 {
                "64-bit".to_string()
            } else {
                "32-bit".to_string()
            },
        },
        capabilities,
    })
}

pub(super) fn settings_file_path() -> Result<Value, ApplicationError> {
    serialize(
        utils::assets::settings_path()
            .to_string_lossy()
            .into_owned(),
    )
}

pub(super) fn get_profiles() -> Result<Value, ApplicationError> {
    let profiles = ExecutorConfigs::get_cached();
    let content = serde_json::to_string_pretty(&profiles).unwrap_or_else(|_| {
        serde_json::to_string_pretty(&ExecutorConfigs::from_defaults()).unwrap_or_default()
    });
    Ok(json!({
        "content": content,
        "path": utils::assets::profiles_path().display().to_string(),
    }))
}

pub(super) async fn update_profiles(args: Value) -> Result<Value, ApplicationError> {
    let args: UpdateProfilesArgs = parse(args)?;
    let profiles: ExecutorConfigs = serde_json::from_str(&args.body).map_err(|error| {
        ApplicationError::bad_request(format!("Invalid executor profiles format: {error}"))
    })?;
    profiles.save_overrides().map_err(internal_error)?;
    ExecutorConfigs::reload();
    serialize("Executor profiles updated successfully".to_string())
}

pub(super) async fn check_editor_availability(args: Value) -> Result<Value, ApplicationError> {
    let args: EditorArgs = parse(args)?;
    let editor_config = EditorConfig::new(args.editor_type, None, None, None);
    Ok(json!({ "available": editor_config.check_availability().await }))
}

pub(super) async fn play_notification_sound(args: Value) -> Result<Value, ApplicationError> {
    let args: SoundArgs = parse(args)?;
    let file_path = args.sound_file.get_path().await.map_err(internal_error)?;
    if cfg!(target_os = "macos") {
        let _ = utils::process::new_hidden_tokio_command("afplay", [&file_path]).spawn();
    } else if cfg!(target_os = "linux") {
        let _ = utils::process::new_hidden_tokio_command("paplay", [&file_path])
            .spawn()
            .or_else(|_| utils::process::new_hidden_tokio_command("aplay", [&file_path]).spawn());
    } else {
        let file_path = file_path.to_string_lossy().replace('\'', "''");
        let script = format!("(New-Object Media.SoundPlayer '{file_path}').PlaySync()");
        let _ = utils::process::new_hidden_tokio_command(
            "powershell.exe",
            ["-NoProfile", "-Command", &script],
        )
        .spawn();
    }
    Ok(Value::Null)
}

fn prompt_enhancement_cancelled() -> ApplicationError {
    ApplicationError::bad_request(PROMPT_ENHANCEMENT_CANCELLED)
}

async fn disconnect_prompt_enhancement_run(
    domains: &ServerApplicationDomains,
    run: &PromptEnhancementRun,
) {
    if let Some(connection_id) = run.connection_id {
        let _ = domains
            .conversations
            .agent_runtime
            .disconnect(connection_id)
            .await;
    }
}

async fn abort_prompt_enhancement_run(
    domains: &ServerApplicationDomains,
    run: PromptEnhancementRun,
) {
    run.cancel.cancel();
    if let (Some(connection_id), Some(session_id), Some(prompt_id)) =
        (run.connection_id, run.session_id, run.prompt_id)
    {
        let _ = domains
            .conversations
            .agent_runtime
            .cancel_prompt(CancelAgentPromptInput {
                connection_id,
                session_id,
                prompt_id,
            })
            .await;
    }
    disconnect_prompt_enhancement_run(domains, &run).await;
}

async fn begin_prompt_enhancement(domains: &ServerApplicationDomains) -> (u64, CancellationToken) {
    let cancel = CancellationToken::new();
    let (generation, previous) = {
        let mut slot = domains.prompt_enhancement.lock().await;
        let generation = slot
            .as_ref()
            .map(|run| run.generation.wrapping_add(1))
            .unwrap_or(1);
        let previous = slot.replace(PromptEnhancementRun {
            generation,
            cancel: cancel.clone(),
            connection_id: None,
            session_id: None,
            prompt_id: None,
        });
        (generation, previous)
    };
    if let Some(previous) = previous {
        abort_prompt_enhancement_run(domains, previous).await;
    }
    (generation, cancel)
}

async fn bind_prompt_enhancement_run(
    domains: &ServerApplicationDomains,
    generation: u64,
    connection_id: agents::AgentConnectionId,
    session_id: AgentSessionId,
    prompt_id: Option<agents::AgentPromptId>,
) {
    let mut slot = domains.prompt_enhancement.lock().await;
    if let Some(run) = slot.as_mut()
        && run.generation == generation
    {
        run.connection_id = Some(connection_id);
        run.session_id = Some(session_id);
        run.prompt_id = prompt_id;
    }
}

async fn finish_prompt_enhancement(
    domains: &ServerApplicationDomains,
    generation: u64,
) -> Option<PromptEnhancementRun> {
    let mut slot = domains.prompt_enhancement.lock().await;
    if slot
        .as_ref()
        .is_some_and(|run| run.generation == generation)
    {
        slot.take()
    } else {
        None
    }
}

pub(super) async fn cancel_enhance_prompt(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let run = domains.prompt_enhancement.lock().await.take();
    if let Some(run) = run {
        abort_prompt_enhancement_run(domains, run).await;
    }
    Ok(Value::Null)
}

pub(super) async fn enhance_prompt(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let payload: PromptEnhancementRequest = unwrap_named(args, &["payload"])?;
    let config = domains.deployment.config().read().await.clone();
    validate_prompt_enhancement_request(&config, &payload)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let prompt_text = build_prompt_enhancement_payload(&config, &payload)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let agent_id =
        validated_enabled_agent(selected_prompt_enhancement_agent(&config), &domains.pool).await?;
    let config_overrides = config
        .prompt_enhancement_session_config
        .iter()
        .map(|(key, value)| AgentSessionConfigOverride {
            key: key.clone(),
            value: value.clone(),
        })
        .collect::<Vec<_>>();
    let model = config
        .prompt_enhancement_session_config
        .iter()
        .find(|(key, _)| key.contains("model"))
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| agent_id.to_string());
    let launch = conversations::resolve_agent_runtime_launch_settings(&domains.pool, &agent_id)
        .await
        .map_err(internal_error)?;
    let runtime = &domains.conversations.agent_runtime;
    let (generation, cancel) = begin_prompt_enhancement(domains).await;
    if cancel.is_cancelled() {
        return Err(prompt_enhancement_cancelled());
    }
    let events = runtime.subscribe_events();
    let session = match runtime
        .ensure_session(EnsureAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: launch.launch_lock,
            workspace_id: uuid::Uuid::nil(),
            working_dir: std::env::temp_dir(),
            additional_directories: Vec::new(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: launch.env,
            preferences: Default::default(),
        })
        .await
    {
        Ok(session) => session,
        Err(error) => {
            let _ = finish_prompt_enhancement(domains, generation).await;
            return Err(internal_error(error));
        }
    };
    bind_prompt_enhancement_run(domains, generation, session.connection_id, session.id, None).await;
    if cancel.is_cancelled() {
        if let Some(run) = finish_prompt_enhancement(domains, generation).await {
            abort_prompt_enhancement_run(domains, run).await;
        } else {
            let _ = runtime.disconnect(session.connection_id).await;
        }
        return Err(prompt_enhancement_cancelled());
    }
    let prompt = match runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override: config.prompt_enhancement_mode.clone(),
            config_overrides,
        })
        .await
    {
        Ok(prompt) => prompt,
        Err(error) => {
            if let Some(run) = finish_prompt_enhancement(domains, generation).await {
                abort_prompt_enhancement_run(domains, run).await;
            } else {
                let _ = runtime.disconnect(session.connection_id).await;
            }
            return Err(internal_error(error));
        }
    };
    bind_prompt_enhancement_run(
        domains,
        generation,
        session.connection_id,
        session.id,
        Some(prompt.id),
    )
    .await;
    if let agents::state::AgentPromptStatus::Failed { message } = &prompt.status {
        if let Some(run) = finish_prompt_enhancement(domains, generation).await {
            abort_prompt_enhancement_run(domains, run).await;
        } else {
            let _ = runtime.disconnect(session.connection_id).await;
        }
        return Err(ApplicationError::internal(format!(
            "Prompt enhancement Agent failed: {message}"
        )));
    }
    let response_text = tokio::select! {
        _ = cancel.cancelled() => Err(prompt_enhancement_cancelled()),
        result = collect_response_text(events, session.id, session.connection_id) => result,
        _ = tokio::time::sleep(Duration::from_secs(PROMPT_ENHANCE_TIMEOUT_SECS)) => {
            Err(ApplicationError::internal(format!(
                "Prompt enhancement Agent timed out after {PROMPT_ENHANCE_TIMEOUT_SECS} seconds"
            )))
        }
    };
    let finished = finish_prompt_enhancement(domains, generation).await;
    if cancel.is_cancelled() {
        if let Some(run) = finished {
            abort_prompt_enhancement_run(domains, run).await;
        } else {
            let _ = runtime.disconnect(session.connection_id).await;
        }
        return Err(prompt_enhancement_cancelled());
    }
    if let Some(run) = finished {
        disconnect_prompt_enhancement_run(domains, &run).await;
    } else {
        let _ = runtime.disconnect(session.connection_id).await;
    }
    let response_text = response_text?;
    let enhanced_prompt = extract_enhanced_prompt(&response_text).ok_or_else(|| {
        let detail = response_text.trim();
        if detail.is_empty() {
            ApplicationError::internal(
                "Agent response did not contain a valid EnhancedPrompt field",
            )
        } else {
            ApplicationError::internal(format!(
                "Agent response did not contain a valid EnhancedPrompt field. Raw output: {detail}"
            ))
        }
    })?;
    serialize(PromptEnhancementResponse {
        enhanced_prompt,
        model,
    })
}

async fn collect_response_text(
    mut events: tokio::sync::broadcast::Receiver<agents::events::AgentEventEnvelope>,
    session_id: AgentSessionId,
    connection_id: agents::AgentConnectionId,
) -> Result<String, ApplicationError> {
    let mut response_text = String::new();
    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(ApplicationError::internal(
                    "Prompt enhancement failed: Agent event stream closed",
                ));
            }
        };
        if envelope.session_id != Some(session_id) {
            if envelope.connection_id == connection_id
                && let AgentEvent::Error { error } = envelope.event
            {
                return Err(ApplicationError::internal(format!(
                    "Prompt enhancement Agent failed: {}",
                    error.message
                )));
            }
            continue;
        }
        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { finished } => {
                if is_prompt_enhancement_cancelled_stop(finished.stop_reason.as_deref()) {
                    return Err(prompt_enhancement_cancelled());
                }
                return Ok(response_text);
            }
            AgentEvent::Error { error } => {
                return Err(ApplicationError::internal(format!(
                    "Prompt enhancement Agent failed: {}",
                    error.message
                )));
            }
            _ => {}
        }
    }
}

async fn validated_enabled_agent(
    configured_agent: Option<&str>,
    pool: &sqlx::SqlitePool,
) -> Result<AgentId, ApplicationError> {
    let Some(raw_agent_id) = configured_agent else {
        return Err(ApplicationError::bad_request(
            "Choose an Agent in Settings → General before using prompt enhancement.",
        ));
    };
    let agent_id = AgentId::parse(raw_agent_id).map_err(|_| {
        ApplicationError::bad_request(format!(
            "The saved prompt enhancement Agent `{raw_agent_id}` is not valid."
        ))
    })?;
    let enabled = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM agent_membership membership
           JOIN agent_installation installation
             ON installation.agent_id = membership.agent_id
           WHERE membership.agent_id = ?
             AND membership.enabled = 1
             AND membership.retired = 0
             AND installation.current_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await
    .map_err(internal_error)?;
    if enabled == 0 {
        return Err(ApplicationError::bad_request(format!(
            "The saved prompt enhancement Agent `{agent_id}` is not enabled."
        )));
    }
    Ok(agent_id)
}

pub(super) async fn list_prompt_enhancement_models(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let documents =
        sqlx::query_scalar::<_, String>("SELECT controls_json FROM agent_capability_catalog")
            .fetch_all(&domains.pool)
            .await
            .map_err(internal_error)?;
    let mut models = Vec::new();
    for document in documents {
        let Ok(value) = serde_json::from_str::<Value>(&document) else {
            continue;
        };
        let Some(options) = value
            .get("configOptions")
            .or_else(|| value.get("config_options"))
        else {
            continue;
        };
        let Some(options) = options.as_array() else {
            continue;
        };
        for option in options {
            if option.get("category").and_then(Value::as_str) != Some("model") {
                continue;
            }
            let Some(choices) = option.get("choices").and_then(Value::as_array) else {
                continue;
            };
            for choice in choices {
                let Some(model) = choice
                    .get("value")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                if !models.iter().any(|existing: &String| existing == model) {
                    models.push(model.to_string());
                }
            }
        }
    }
    Ok(json!({ "models": models }))
}

pub(super) async fn get_claude_settings() -> Result<Value, ApplicationError> {
    let path = claude_settings_path()
        .ok_or_else(|| ApplicationError::internal("Could not determine home directory"))?;
    if !path.exists() {
        return serialize(ClaudeSettings::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(internal_error)?;
    let raw: Value = serde_json::from_str(&content).map_err(internal_error)?;
    if !raw.is_object() {
        return Err(ApplicationError::internal(
            "Claude settings JSON must contain an object at the root",
        ));
    }
    serialize(ClaudeSettings {
        env: raw
            .get("env")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(internal_error)?
            .unwrap_or_default(),
        enabled_plugins: raw
            .get("enabledPlugins")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(internal_error)?
            .unwrap_or_default(),
    })
}

pub(super) async fn update_claude_settings(args: Value) -> Result<Value, ApplicationError> {
    let settings: ClaudeSettings = unwrap_named(args, &["settings"])?;
    let path = claude_settings_path()
        .ok_or_else(|| ApplicationError::internal("Could not determine home directory"))?;
    let mut existing: Value = if path.exists() {
        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(internal_error)?;
        serde_json::from_str(&content).map_err(internal_error)?
    } else {
        json!({})
    };
    let obj = existing.as_object_mut().ok_or_else(|| {
        ApplicationError::internal("Claude settings JSON must contain an object at the root")
    })?;
    obj.insert(
        "env".to_string(),
        serde_json::to_value(&settings.env).map_err(internal_error)?,
    );
    obj.insert(
        "enabledPlugins".to_string(),
        serde_json::to_value(&settings.enabled_plugins).map_err(internal_error)?,
    );
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::write(
        &path,
        serde_json::to_string_pretty(&existing).map_err(internal_error)?,
    )
    .await
    .map_err(internal_error)?;
    serialize(settings)
}

pub(super) fn claude_settings_path_value() -> Result<Value, ApplicationError> {
    serialize(
        claude_settings_path()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    )
}

fn claude_settings_path() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
        })
}
