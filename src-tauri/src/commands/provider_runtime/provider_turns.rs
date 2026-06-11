use std::path::PathBuf;

use db::models::{session::Session, workspace::Workspace};
use deployment::Deployment;
use serde_json::json;
use uuid::Uuid;

use super::{
    ACP_FALLBACK_ENV, BridgeRunSpec, ProviderId, ProviderRuntimeEvent, ProviderTurnRequest,
    acp_fallback_config, apply_native_commit_reminder_to_request,
    apply_profile_defaults_to_request, build_claude_sdk_bridge_args, build_claude_sdk_bridge_input,
    build_opencode_sdk_bridge_args, build_opencode_sdk_bridge_input, load_provider_workspace,
    normalize_provider_runtime_event, prompt_with_display_images, provider_executor_profile_id,
    provider_option_string, resolve_native_provider_request, resolve_provider_workspace_dir,
    should_force_acp_fallback, start_bridge_native_turn, start_codex_native_turn,
    write_claude_sdk_bridge_input_file, write_opencode_sdk_bridge_input_file,
};
use crate::{error::AppError, state::AppState};

pub(super) fn provider_visible_prompt(request: &ProviderTurnRequest) -> String {
    let display_text = provider_option_string(&request.provider_options, "display_text")
        .or_else(|| provider_option_string(&request.provider_options, "displayText"))
        .unwrap_or(request.text.as_str());
    prompt_with_display_images(display_text, &request.images)
}

async fn start_claude_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    visible_prompt: &str,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Claude;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_claude_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_claude_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_claude_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_claude_agent_sdk";

    start_bridge_native_turn(
        state,
        &request,
        visible_prompt,
        workspace,
        session,
        BridgeRunSpec {
            provider,
            runtime_source,
            program,
            args,
            input_path: bridge_input_path,
            workspace_dir,
            workspace_id,
            turn_id,
        },
    )
    .await
}

async fn start_opencode_sdk_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    visible_prompt: &str,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let provider = ProviderId::Opencode;
    let workspace_id = workspace.id;
    let turn_id = Uuid::new_v4().to_string();
    let bridge_input = build_opencode_sdk_bridge_input(&request, &workspace_dir)?;
    let bridge_input_path = write_opencode_sdk_bridge_input_file(&bridge_input)?;
    let program = "node";
    let args = build_opencode_sdk_bridge_args(&bridge_input_path);
    let runtime_source = "native_opencode_sdk";

    start_bridge_native_turn(
        state,
        &request,
        visible_prompt,
        workspace,
        session,
        BridgeRunSpec {
            provider,
            runtime_source,
            program,
            args,
            input_path: bridge_input_path,
            workspace_dir,
            workspace_id,
            turn_id,
        },
    )
    .await
}

pub(super) async fn try_native_provider_turn(
    state: &tauri::State<'_, AppState>,
    mut request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    apply_profile_defaults_to_request(&mut request);
    let visible_prompt = provider_visible_prompt(&request);
    let mut workspace = load_provider_workspace(state, workspace_id).await?;
    let workspace_dir = resolve_provider_workspace_dir(state, &mut workspace).await?;
    apply_native_commit_reminder_to_request(state, &mut request, &workspace_dir).await;
    match request.provider {
        ProviderId::Codex => {
            start_codex_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
        ProviderId::Claude => {
            start_claude_sdk_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
        ProviderId::Opencode => {
            start_opencode_sdk_native_turn(
                state,
                request,
                &visible_prompt,
                &workspace,
                workspace_dir,
                session,
            )
            .await
        }
    }
}

pub(super) fn native_provider_error_event(
    request: &ProviderTurnRequest,
    workspace_id: Uuid,
    session_id: Uuid,
    native_error: &AppError,
    fallback_policy: &str,
) -> ProviderRuntimeEvent {
    normalize_provider_runtime_event(ProviderRuntimeEvent {
        provider: request.provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: None,
        normalized: Vec::new(),
        event: json!({
            "type": "native_runtime_error",
            "method": "turn/error",
            "runtime_source": "native",
            "session_id": session_id,
            "provider": request.provider,
            "error": native_error.to_string(),
            "fallback_policy": fallback_policy,
            "fallback_available": acp_fallback_config(request.provider).enabled,
        }),
    })
}

pub(super) async fn fallback_acp_turn(
    state: tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace_id: Uuid,
    session: Session,
    native_error: Option<String>,
) -> Result<ProviderRuntimeEvent, AppError> {
    let fallback = acp_fallback_config(request.provider);
    if !fallback.enabled {
        let env_name = fallback.env_name.unwrap_or(ACP_FALLBACK_ENV);
        let native_error = native_error.unwrap_or_else(|| "native runtime unavailable".to_string());
        return Err(AppError::BadRequest(format!(
            "{} ACP fallback is disabled by `{}`; native runtime error: {}",
            request.provider.label(),
            env_name,
            native_error
        )));
    }

    let executor_profile_id = provider_executor_profile_id(&request);
    let prompt = prompt_with_display_images(&request.text, &request.images);
    let process = crate::commands::sessions::follow_up(
        state,
        session.id,
        prompt,
        executor_profile_id,
        None,
        None,
        None,
    )
    .await?;

    let mut payload = json!({
        "type": "execution_started",
        "runtime_source": "acp_fallback",
        "execution_process_id": process.id,
        "session_id": session.id,
        "provider": request.provider,
    });
    if let Some(native_error) = native_error
        && let Some(object) = payload.as_object_mut()
    {
        object.insert(
            "fallback_reason".to_string(),
            json!({
                "type": if should_force_acp_fallback(&request) {
                    "forced_by_request"
                } else {
                    "native_runtime_error"
                },
                "message": native_error,
            }),
        );
    }

    Ok(normalize_provider_runtime_event(ProviderRuntimeEvent {
        provider: request.provider,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id,
        turn_id: Some(process.id.to_string()),
        normalized: Vec::new(),
        event: payload,
    }))
}
