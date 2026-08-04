use std::{
    collections::VecDeque, convert::Infallible, net::SocketAddr, path::PathBuf, sync::LazyLock,
    time::Duration,
};

use agents::{AgentPermissionResponse, AgentSessionConfigOverride};
use axum::{
    Json, Router,
    extract::{Path, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use chrono::Utc;
use db::models::{
    conversation::{ConversationRecord, CreateConversationRecord, DbConversationSummary},
    session::SessionStatus,
};
use futures::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::Manager;
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use uuid::Uuid;

use crate::{
    commands::conversations::conversation_events_since_core,
    conversation_service::{ConversationSessionService, ConversationStartTurnInput},
    error::AppError,
    state::AppState,
};

const SETTINGS_FILE_NAME: &str = "web-service-settings.json";
const SETTINGS_SECTION: &str = "web_service";
const DEFAULT_PORT: u16 = 17891;

static WEB_SERVICE_RUNTIME: LazyLock<Mutex<Option<WebServiceRuntime>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug)]
struct WebServiceRuntime {
    port: u16,
    address: String,
    started_at: String,
    handle: JoinHandle<()>,
}

#[derive(Clone)]
struct WebServiceRouterState {
    app: tauri::AppHandle,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServiceConfig {
    pub port: u16,
    pub token: Option<String>,
    pub auto_start: bool,
}

impl Default for WebServiceConfig {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            token: None,
            auto_start: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerStatus {
    pub running: bool,
    pub port: u16,
    pub address: Option<String>,
    pub token_configured: bool,
    pub started_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortProbeResult {
    pub port: u16,
    pub available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ConversationListQuery {
    workspace_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct CreateConversationRequest {
    workspace_id: String,
    agent_id: agents::AgentId,
    title: Option<String>,
    initial_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebStartTurnRequest {
    agent_id: agents::AgentId,
    workspace_id: Option<String>,
    text: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    executor_profile_id: Option<executors::profile::ExecutorProfileId>,
    #[serde(default)]
    mode_override: Option<String>,
    #[serde(default)]
    config_overrides: Vec<AgentSessionConfigOverride>,
}

#[derive(Debug, Clone, Deserialize)]
struct PermissionResponseRequest {
    response: AgentPermissionResponse,
}

#[derive(Debug, Clone, Deserialize)]
struct CancelTurnRequest {
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct EventsQuery {
    after_sequence: Option<i64>,
}

fn legacy_settings_path() -> PathBuf {
    utils::assets::asset_dir().join(SETTINGS_FILE_NAME)
}

fn validate_port(port: u16) -> Result<(), AppError> {
    if port == 0 {
        return Err(AppError::BadRequest(
            "Web service port must be between 1 and 65535".to_string(),
        ));
    }
    Ok(())
}

fn normalize_config(mut config: WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    validate_port(config.port)?;
    config.token = config
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok(config)
}

async fn load_config() -> Result<WebServiceConfig, AppError> {
    if let Some(config) = services::services::settings_store::read_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    {
        return normalize_config(config);
    }

    let legacy_path = legacy_settings_path();
    let config = if legacy_path.exists() {
        let content = tokio::fs::read_to_string(&legacy_path)
            .await
            .map_err(|error| {
                AppError::Internal(format!(
                    "Failed to read web service settings {}: {error}",
                    legacy_path.display()
                ))
            })?;
        serde_json::from_str(&content).map_err(|error| {
            AppError::Internal(format!(
                "Invalid web service settings {}: {error}",
                legacy_path.display()
            ))
        })?
    } else {
        WebServiceConfig::default()
    };
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        &config,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    normalize_config(config)
}

async fn save_config(config: &WebServiceConfig) -> Result<WebServiceConfig, AppError> {
    let config = normalize_config(config.clone())?;
    services::services::settings_store::write_section(
        &utils::assets::settings_path(),
        SETTINGS_SECTION,
        &config,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(config)
}

fn router(state: WebServiceRouterState) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async {
                Json(json!({
                    "service": "VibeX Web Service",
                    "status": "ok",
                }))
            }),
        )
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "ok": true,
                    "service": "vibex",
                }))
            }),
        )
        .route("/api/conversations", get(api_list_conversations))
        .route("/api/conversations", post(api_create_conversation))
        .route(
            "/api/conversations/{conversation_id}/events",
            get(api_conversation_events),
        )
        .route(
            "/api/conversations/{conversation_id}/turns",
            post(api_start_turn),
        )
        .route(
            "/api/conversations/{conversation_id}/permissions/{permission_id}",
            post(api_respond_permission),
        )
        .route(
            "/api/conversations/{conversation_id}/cancel",
            post(api_cancel_turn),
        )
        .with_state(state)
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message.into(),
        })),
    )
        .into_response()
}

fn app_error(error: AppError) -> Response {
    match &error {
        AppError::BadRequest(_) => api_error(StatusCode::BAD_REQUEST, error.to_string()),
        AppError::NotFound(_) => api_error(StatusCode::NOT_FOUND, error.to_string()),
        AppError::Conflict(_) => api_error(StatusCode::CONFLICT, error.to_string()),
        AppError::Internal(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

// The Err payload is a full HTTP `Response`; these local helpers return it by value
// for ergonomics rather than boxing on every call site.
#[allow(clippy::result_large_err)]
fn ensure_auth(headers: &HeaderMap, state: &WebServiceRouterState) -> Result<(), Response> {
    let Some(expected) = state.token.as_deref() else {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Web service token is not configured",
        ));
    };
    let bearer = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    let explicit = headers
        .get("x-vibex-token")
        .and_then(|value| value.to_str().ok());
    if bearer == Some(expected) || explicit == Some(expected) {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Invalid web service token",
        ))
    }
}

#[allow(clippy::result_large_err)]
fn parse_uuid(value: &str, label: &str) -> Result<Uuid, Response> {
    Uuid::parse_str(value)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, format!("invalid {label}: {error}")))
}

async fn web_conversation_last_sequence(
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
) -> Result<i64, AppError> {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COALESCE(MAX(sequence), 0)
           FROM conversation_events
           WHERE conversation_id = ?"#,
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

async fn emit_events_after(
    app: &tauri::AppHandle,
    projectors: &crate::events::ConversationRowProjectors,
    pool: &sqlx::SqlitePool,
    conversation_id: Uuid,
    after_sequence: i64,
) {
    // Frontend: the single row-op path (消灭双投影).
    crate::events::emit_conversation_row_ops_after(
        app,
        projectors,
        pool,
        conversation_id,
        after_sequence,
    )
    .await;
    // IM channels still consume the raw event envelopes.
    if let Ok(page) =
        conversation_events_since_core(pool, conversation_id, after_sequence, 50).await
    {
        for event in page.events {
            if let Err(error) =
                crate::commands::chat_channel::notify_conversation_event(&event).await
            {
                tracing::warn!(
                    conversation_id = %conversation_id,
                    sequence = event.sequence,
                    %error,
                    "Failed to notify chat channel for web service event"
                );
            }
        }
    }
}

async fn api_list_conversations(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Query(query): Query<ConversationListQuery>,
) -> Result<Json<Vec<DbConversationSummary>>, Response> {
    ensure_auth(&headers, &router_state)?;
    let state = router_state.app.state::<AppState>();
    let pool = &state.deployment.db().pool;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let rows = if let Some(workspace_id) = query.workspace_id {
        let workspace_id = parse_uuid(&workspace_id, "workspace_id")?;
        DbConversationSummary::list_for_workspace(pool, workspace_id)
            .await
            .map_err(AppError::from)
            .map_err(app_error)?
            .into_iter()
            .take(limit as usize)
            .collect()
    } else {
        sqlx::query_as::<_, DbConversationSummary>(&format!(
            r#"SELECT id,
                      workspace_id,
                      task_id,
                      name AS title,
                      title_locked,
                      status,
                      agent_type,
                      model,
                      external_session_id,
                      message_count,
                      pinned_at,
                      parent_session_id,
                      parent_tool_use_id,
                      delegation_call_id,
                      created_at,
                      updated_at
               FROM sessions
               WHERE deleted_at IS NULL
               ORDER BY active_turn_id IS NULL, updated_at DESC, created_at DESC
               LIMIT {limit}"#
        ))
        .fetch_all(pool)
        .await
        .map_err(AppError::from)
        .map_err(app_error)?
    };
    Ok(Json(rows))
}

async fn api_create_conversation(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Json(request): Json<CreateConversationRequest>,
) -> Result<Json<DbConversationSummary>, Response> {
    ensure_auth(&headers, &router_state)?;
    let state = router_state.app.state::<AppState>();
    let pool = &state.deployment.db().pool;
    let workspace_id = parse_uuid(&request.workspace_id, "workspace_id")?;
    let conversation_id = Uuid::new_v4();
    ConversationRecord::create(
        pool,
        conversation_id,
        CreateConversationRecord {
            workspace_id,
            task_id: None,
            title: request.title.as_deref(),
            initial_prompt: request.initial_prompt.as_deref(),
            status: Some(SessionStatus::Todo),
            executor: Some("agent"),
        },
    )
    .await
    .map_err(AppError::from)
    .map_err(app_error)?;
    sqlx::query(
        r#"UPDATE sessions
           SET agent_type = ?, updated_at = datetime('now', 'subsec')
           WHERE id = ?"#,
    )
    .bind(request.agent_id.as_str())
    .bind(conversation_id)
    .execute(pool)
    .await
    .map_err(AppError::from)
    .map_err(app_error)?;
    let summary = DbConversationSummary::find_by_id(pool, conversation_id)
        .await
        .map_err(AppError::from)
        .map_err(app_error)?
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "conversation was not created"))?;
    Ok(Json(summary))
}

async fn api_start_turn(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(request): Json<WebStartTurnRequest>,
) -> Result<Json<Value>, Response> {
    ensure_auth(&headers, &router_state)?;
    let conversation_id = parse_uuid(&conversation_id, "conversation_id")?;
    let state = router_state.app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let workspace_id = if let Some(workspace_id) = request.workspace_id {
        parse_uuid(&workspace_id, "workspace_id")?
    } else {
        ConversationRecord::find_by_id(&pool, conversation_id)
            .await
            .map_err(AppError::from)
            .map_err(app_error)?
            .map(|conversation| conversation.workspace_id)
            .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "conversation not found"))?
    };
    let previous_last_sequence = web_conversation_last_sequence(&pool, conversation_id)
        .await
        .map_err(app_error)?;
    let result = ConversationSessionService::new(state.conversation_context())
        .start_turn(ConversationStartTurnInput {
            agent_id: request.agent_id,
            workspace_id,
            conversation_id,
            executor_profile_id: request.executor_profile_id,
            text: request.text,
            images: request.images,
            mode_override: request.mode_override,
            config_overrides: request.config_overrides,
        })
        .await;
    emit_events_after(
        &router_state.app,
        &state.conversation_row_projectors,
        &pool,
        conversation_id,
        previous_last_sequence,
    )
    .await;
    let (turn, _) = result.map_err(AppError::from).map_err(app_error)?;
    Ok(Json(json!(turn)))
}

async fn api_respond_permission(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Path((conversation_id, permission_id)): Path<(String, String)>,
    Json(request): Json<PermissionResponseRequest>,
) -> Result<Json<Value>, Response> {
    ensure_auth(&headers, &router_state)?;
    let conversation_id = parse_uuid(&conversation_id, "conversation_id")?;
    let state = router_state.app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = web_conversation_last_sequence(&pool, conversation_id)
        .await
        .map_err(app_error)?;
    let result = ConversationSessionService::new(state.conversation_context())
        .respond_permission(conversation_id, permission_id, request.response)
        .await;
    emit_events_after(
        &router_state.app,
        &state.conversation_row_projectors,
        &pool,
        conversation_id,
        previous_last_sequence,
    )
    .await;
    result.map_err(AppError::from).map_err(app_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn api_cancel_turn(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(request): Json<CancelTurnRequest>,
) -> Result<Json<Value>, Response> {
    ensure_auth(&headers, &router_state)?;
    let conversation_id = parse_uuid(&conversation_id, "conversation_id")?;
    let state = router_state.app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let previous_last_sequence = web_conversation_last_sequence(&pool, conversation_id)
        .await
        .map_err(app_error)?;
    let result = ConversationSessionService::new(state.conversation_context())
        .cancel_turn(conversation_id, request.reason)
        .await;
    emit_events_after(
        &router_state.app,
        &state.conversation_row_projectors,
        &pool,
        conversation_id,
        previous_last_sequence,
    )
    .await;
    result.map_err(AppError::from).map_err(app_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn api_conversation_events(
    AxumState(router_state): AxumState<WebServiceRouterState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, Response> {
    ensure_auth(&headers, &router_state)?;
    let conversation_id = parse_uuid(&conversation_id, "conversation_id")?;
    let state = router_state.app.state::<AppState>();
    let pool = state.deployment.db().pool.clone();
    let after_sequence = query.after_sequence.unwrap_or(0);
    let stream = stream::unfold(
        (after_sequence, VecDeque::<Event>::new()),
        move |(mut after_sequence, mut pending)| {
            let pool = pool.clone();
            async move {
                if let Some(event) = pending.pop_front() {
                    return Some((Ok(event), (after_sequence, pending)));
                }

                match conversation_events_since_core(&pool, conversation_id, after_sequence, 100)
                    .await
                {
                    Ok(page) => {
                        after_sequence = page.last_sequence;
                        pending = page
                            .events
                            .into_iter()
                            .filter_map(|event| {
                                serde_json::to_string(&event)
                                    .ok()
                                    .map(|data| Event::default().event("conversation").data(data))
                            })
                            .collect();
                        if let Some(event) = pending.pop_front() {
                            Some((Ok(event), (after_sequence, pending)))
                        } else {
                            tokio::time::sleep(Duration::from_millis(750)).await;
                            Some((
                                Ok(Event::default().comment("poll")),
                                (after_sequence, pending),
                            ))
                        }
                    }
                    Err(error) => {
                        let event = Event::default()
                            .event("error")
                            .data(json!({ "error": error.to_string() }).to_string());
                        tokio::time::sleep(Duration::from_secs(1)).await;
                        Some((Ok(event), (after_sequence, pending)))
                    }
                }
            }
        },
    );

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn status_from_runtime(config: WebServiceConfig) -> WebServerStatus {
    let runtime = WEB_SERVICE_RUNTIME.lock().await;
    if let Some(runtime) = runtime.as_ref() {
        return WebServerStatus {
            running: true,
            port: runtime.port,
            address: Some(runtime.address.clone()),
            token_configured: config.token.is_some(),
            started_at: Some(runtime.started_at.clone()),
            message: None,
        };
    }

    WebServerStatus {
        running: false,
        port: config.port,
        address: None,
        token_configured: config.token.is_some(),
        started_at: None,
        message: None,
    }
}

#[tauri::command]
pub async fn get_web_service_config() -> Result<WebServiceConfig, AppError> {
    load_config().await
}

#[tauri::command]
pub async fn update_web_service_config(
    config: WebServiceConfig,
) -> Result<WebServiceConfig, AppError> {
    save_config(&config).await
}

#[tauri::command]
pub async fn get_web_server_status() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn start_web_server(app: tauri::AppHandle) -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    validate_port(config.port)?;

    {
        let runtime = WEB_SERVICE_RUNTIME.lock().await;
        if runtime.is_some() {
            drop(runtime);
            return Ok(status_from_runtime(config).await);
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", config.port))
        .await
        .map_err(|error| {
            AppError::Conflict(format!(
                "Failed to bind web service on 127.0.0.1:{}: {error}",
                config.port
            ))
        })?;
    let local_addr = listener.local_addr().map_err(|error| {
        AppError::Internal(format!("Failed to read web service address: {error}"))
    })?;
    let address = format!("http://{}", local_addr);
    let started_at = Utc::now().to_rfc3339();
    let app = router(WebServiceRouterState {
        app,
        token: config.token.clone(),
    });
    let handle = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::warn!("VibeX web service stopped with error: {}", error);
        }
    });

    let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
    *runtime = Some(WebServiceRuntime {
        port: local_addr.port(),
        address,
        started_at,
        handle,
    });

    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn stop_web_server() -> Result<WebServerStatus, AppError> {
    let config = load_config().await?;
    let mut runtime = WEB_SERVICE_RUNTIME.lock().await;
    if let Some(runtime) = runtime.take() {
        runtime.handle.abort();
    }
    drop(runtime);
    Ok(status_from_runtime(config).await)
}

#[tauri::command]
pub async fn probe_web_service_port(port: u16) -> Result<PortProbeResult, AppError> {
    validate_port(port)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpListener::bind(addr).await {
        Ok(listener) => {
            drop(listener);
            Ok(PortProbeResult {
                port,
                available: true,
                message: None,
            })
        }
        Err(error) => Ok(PortProbeResult {
            port,
            available: false,
            message: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn generate_web_service_token() -> Result<WebServiceConfig, AppError> {
    let mut config = load_config().await?;
    config.token = Some(Uuid::new_v4().simple().to_string());
    save_config(&config).await
}

pub async fn ensure_web_service_autostart(app: tauri::AppHandle) -> Result<(), AppError> {
    let config = load_config().await?;
    if config.auto_start {
        let _ = start_web_server(app).await?;
    }
    Ok(())
}
