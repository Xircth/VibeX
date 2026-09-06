use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};

const PROTOCOL: &str = "1.0";
const TOKEN_HEADER: &str = "x-vibex-plugin-dev-token";
const PROTOCOL_HEADER: &str = "x-vibex-plugin-dev-protocol";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevConnection {
    pub endpoint: String,
    pub token: String,
    pub protocol_version: &'static str,
}

#[derive(Clone)]
pub struct DesktopPreviewProxy {
    endpoint: Arc<str>,
    registry: server::PreviewProxyRegistry,
}

impl DesktopPreviewProxy {
    pub async fn start() -> anyhow::Result<Self> {
        Self::start_with_registry(server::PreviewProxyRegistry::default()).await
    }

    pub async fn start_with_registry(
        registry: server::PreviewProxyRegistry,
    ) -> anyhow::Result<Self> {
        let endpoint = server::start_loopback_preview_proxy(registry.clone()).await?;
        Ok(Self {
            endpoint: Arc::from(endpoint),
            registry,
        })
    }

    pub async fn register(&self, lease: &plugins::PluginPreviewSession) -> anyhow::Result<String> {
        let lease_id = uuid::Uuid::parse_str(&lease.lease_id)?;
        self.registry
            .register(
                lease_id,
                lease.loopback_port,
                &lease.capability_token,
                lease.expires_at_unix_ms,
            )
            .await?;
        Ok(format!(
            "{}/api/v1/previews/{lease_id}/c/{}/",
            self.endpoint, lease.capability_token
        ))
    }

    pub async fn revoke(&self, lease_id: &str) {
        if let Ok(lease_id) = uuid::Uuid::parse_str(lease_id) {
            self.registry.revoke(lease_id).await;
        }
    }

    pub async fn renew(&self, lease: &plugins::PluginPreviewSession) -> anyhow::Result<()> {
        let lease_id = uuid::Uuid::parse_str(&lease.lease_id)?;
        self.registry
            .renew(lease_id, lease.expires_at_unix_ms)
            .await?;
        Ok(())
    }

    pub fn registry(&self) -> server::PreviewProxyRegistry {
        self.registry.clone()
    }
}

#[tauri::command]
pub fn plugin_dev_connection(
    connection: tauri::State<'_, PluginDevConnection>,
) -> PluginDevConnection {
    connection.inner().clone()
}

#[derive(Clone)]
struct DevState {
    token: Arc<str>,
    plugins: Arc<plugins::PluginControlPlane>,
    pool: SqlitePool,
    broker: Arc<dyn plugins::CapabilityBroker>,
    worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    runtime_root: PathBuf,
    candidate_root: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedPackage {
    publisher: String,
    plugin_id: String,
    version: String,
    package_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkedInstallRequest {
    source_path: String,
    expected: ExpectedPackage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateRequest {
    source_path: String,
    expected_package_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallRequest {
    retain_data: bool,
}

pub fn persist_connection(
    path: &std::path::Path,
    connection: &PluginDevConnection,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::json!({
        "url": connection.endpoint,
        "token": connection.token,
        "protocolVersion": connection.protocol_version,
    });
    std::fs::write(path, format!("{body}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub async fn start(
    plugins: Arc<plugins::PluginControlPlane>,
    pool: SqlitePool,
    broker: Arc<dyn plugins::CapabilityBroker>,
    worker_runtime: Arc<plugins::PluginWorkerRuntimeProvider>,
    runtime_root: PathBuf,
    candidate_root: PathBuf,
    connection_path: Option<PathBuf>,
) -> anyhow::Result<PluginDevConnection> {
    let mut token_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let state = DevState {
        token: Arc::from(token.clone()),
        plugins,
        pool,
        broker,
        worker_runtime,
        runtime_root,
        candidate_root,
    };
    let router = Router::new()
        .route(
            "/api/plugin-dev/v1/linked-installations",
            post(install_linked),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/candidates",
            post(reload_candidate),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/linked-installation",
            delete(uninstall_linked),
        )
        .route(
            "/api/plugin-dev/v1/plugins/{publisher}/{id}/doctor",
            get(doctor),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let plugins = state.plugins.clone();
    let router = router.with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    start_artifact_http(plugins).await?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin Dev control server stopped");
        }
    });
    let connection = PluginDevConnection {
        endpoint: format!("http://{address}"),
        token,
        protocol_version: PROTOCOL,
    };
    if let Some(path) = connection_path {
        if let Err(error) = persist_connection(&path, &connection) {
            tracing::warn!(
                %error,
                path = %path.display(),
                "Plugin Dev connection file could not be written"
            );
        }
    }
    Ok(connection)
}

async fn start_artifact_http(plugins: Arc<plugins::PluginControlPlane>) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    plugins::set_artifact_origin(format!("http://{address}"));
    let router = Router::new()
        .route("/{plugin_id}/{*path}", get(serve_plugin_artifact))
        .with_state(plugins);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::warn!(%error, "Plugin artifact server stopped");
        }
    });
    Ok(())
}

async fn serve_plugin_artifact(
    State(plugins): State<Arc<plugins::PluginControlPlane>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Response {
    let Ok(Some(plugin)) = plugins.plugin(&plugin_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if plugin.activation != plugins::PluginActivation::Enabled {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(file) = plugin.package.checked_file(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    };
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        bytes,
    )
        .into_response()
}

async fn authenticate(State(state): State<DevState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let protocol_ok = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(PROTOCOL);
    let token_ok = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|candidate| constant_time_eq(candidate.as_bytes(), state.token.as_bytes()));
    if !protocol_ok || !token_ok {
        return DevError::new(
            StatusCode::UNAUTHORIZED,
            "plugin_dev_unauthorized",
            "Plugin Dev credentials are invalid",
        )
        .into_response();
    }
    next.run(request).await
}

async fn install_linked(
    State(state): State<DevState>,
    Json(request): Json<LinkedInstallRequest>,
) -> Result<Json<Value>, DevError> {
    let (mut package, digest) = inspect_linked_source(&request.source_path)?;
    verify_expected(&package, &digest, &request.expected)?;
    package
        .freeze_execution_root(&state.candidate_root, &digest)
        .map_err(DevError::plugin)?;
    let plugin_id = package.id.as_str().to_owned();
    let grants = selected_grants(&package)?;
    let node = state
        .worker_runtime
        .resolve()
        .await
        .map_err(DevError::plugin)?;
    let installed = state
        .plugins
        .plugin(&plugin_id)
        .await
        .map_err(DevError::plugin)?;
    if let Some(_installed) = installed {
        prepare_candidate_runtimes(&state, &package, &digest).await?;
        state
            .plugins
            .update_and_activate(&node, package.clone(), &grants, state.broker.clone())
            .await
            .map_err(|error| DevError::worker(error, None))?;
    } else {
        state
            .plugins
            .import(package.clone(), plugins::ConflictDecision::Reject)
            .await
            .map_err(DevError::plugin)?;
        if let Err(error) = prepare_candidate_runtimes(&state, &package, &digest).await {
            let _ = state.plugins.uninstall(&plugin_id).await;
            return Err(error);
        }
        state
            .plugins
            .activate_and_enable(&node, &plugin_id, &grants, state.broker.clone())
            .await
            .map_err(|error| DevError::worker(error, None))?;
    }
    activated_response(&state, &package, digest).await
}

async fn reload_candidate(
    State(state): State<DevState>,
    Path((publisher, id)): Path<(String, String)>,
    Json(request): Json<CandidateRequest>,
) -> Result<Json<Value>, DevError> {
    let (mut package, digest) = inspect_linked_source(&request.source_path)?;
    if package.publisher.as_deref() != Some(publisher.as_str())
        || package.id.as_str() != id
        || digest != request.expected_package_digest
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_dev_expectation_mismatch",
            "Candidate identity or digest does not match the linked package",
        ));
    }
    package
        .freeze_execution_root(&state.candidate_root, &digest)
        .map_err(DevError::plugin)?;
    let published = published_generation(&state, &id).await;
    prepare_candidate_runtimes(&state, &package, &digest).await?;
    let grants = selected_grants(&package)?;
    let node = state
        .worker_runtime
        .resolve()
        .await
        .map_err(DevError::plugin)?;
    state
        .plugins
        .update_and_activate(&node, package.clone(), &grants, state.broker.clone())
        .await
        .map_err(|error| DevError::worker(error, published))?;
    activated_response(&state, &package, digest).await
}

async fn uninstall_linked(
    State(state): State<DevState>,
    Path((publisher, id)): Path<(String, String)>,
    Json(request): Json<UninstallRequest>,
) -> Result<Json<Value>, DevError> {
    if !request.retain_data {
        return Err(DevError::new(
            StatusCode::NOT_IMPLEMENTED,
            "plugin_data_delete_unsupported",
            "This Host has no plugin-owned storage to delete; uninstall with data retention",
        ));
    }
    let plugin = state
        .plugins
        .plugin(&id)
        .await
        .map_err(DevError::plugin)?
        .ok_or_else(|| DevError::not_found(&id))?;
    if plugin.publisher.as_deref() != Some(publisher.as_str())
        || plugin.source.kind != plugins::PluginSourceKind::DeveloperLink
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_not_linked",
            "Plugin identity is not a linked development installation",
        ));
    }
    state
        .plugins
        .deactivate_worker(&id)
        .await
        .map_err(|error| DevError::worker(error, None))?;
    state
        .plugins
        .uninstall(&id)
        .await
        .map_err(DevError::plugin)?;
    Ok(Json(json!({
        "protocolVersion": PROTOCOL,
        "plugin": { "publisher": publisher, "id": id },
        "removed": true,
        "dataRetention": "retained",
    })))
}

fn selected_grants(
    package: &plugins::PluginPackage,
) -> Result<Vec<plugins::CapabilityGrant>, DevError> {
    plugins::candidate_capability_grants(package, &[], &[]).map_err(DevError::plugin)
}

async fn prepare_candidate_runtimes(
    state: &DevState,
    package: &plugins::PluginPackage,
    package_digest: &str,
) -> Result<(), DevError> {
    for declared in &package.runtimes {
        let ready = state
            .plugins
            .runtime_for_package(package.id.as_str(), package_digest, &declared.id)
            .await
            .map_err(DevError::plugin)?
            .is_some_and(|locked| {
                declared
                    .version
                    .as_deref()
                    .is_none_or(|version| version == locked.version)
                    && (declared.target.is_empty() || declared.target == locked.target)
                    && (declared.content_digest.is_empty()
                        || declared.content_digest == locked.content_digest)
                    && locked.executable_path.is_absolute()
                    && locked.executable_path.is_file()
            });
        if ready {
            continue;
        }
        let host = plugins::ContentAddressedRuntimeHost::new(state.runtime_root.clone(), declared)
            .map_err(DevError::plugin)?;
        let installation = plugins::GlobalRuntimeInstaller::new(&host)
            .install(package.id.as_str(), declared)
            .await
            .map_err(DevError::plugin)?;
        state
            .plugins
            .record_runtime_for_package(package.id.as_str(), package_digest, installation)
            .await
            .map_err(DevError::plugin)?;
    }
    Ok(())
}

#[cfg(test)]
fn reload_grants_from_existing(
    package: &plugins::PluginPackage,
    _existing: &[plugins::CapabilityGrant],
    _published_generation: Option<u64>,
) -> Result<Vec<plugins::CapabilityGrant>, DevError> {
    selected_grants(package)
}

async fn doctor(
    State(state): State<DevState>,
    Path((publisher, id)): Path<(String, String)>,
) -> Result<Json<Value>, DevError> {
    let plugin = state
        .plugins
        .plugin(&id)
        .await
        .map_err(DevError::plugin)?
        .ok_or_else(|| DevError::not_found(&id))?;
    if plugin.publisher.as_deref() != Some(publisher.as_str()) {
        return Err(DevError::not_found(&id));
    }
    let runtimes = state
        .plugins
        .runtime_inventory()
        .await
        .map_err(DevError::plugin)?
        .into_iter()
        .filter(|runtime| runtime.referenced_plugins.contains(&id))
        .collect::<Vec<_>>();
    let catalog = state
        .plugins
        .contributions()
        .await
        .map_err(DevError::plugin)?;
    // Every published contribution, not a hand-kept whitelist: an author who
    // adds a kind the Host learned about later must still see it here, or
    // `doctor` reports "nothing wrong" about a contribution it never looked at.
    let contributions = catalog
        .items
        .into_iter()
        .filter(|item| item.plugin_id == id)
        .collect::<Vec<_>>();
    let bindings = sqlx::query(
        "SELECT agent_id, desired, applied, pending_reason, error_code
         FROM plugin_agent_bindings_v4 WHERE plugin_id = ? ORDER BY agent_id",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await
    .map_err(DevError::database)?
    .into_iter()
    .map(|row| {
        json!({
            "agentId": row.get::<String, _>("agent_id"),
            "desired": row.get::<i64, _>("desired") == 1,
            "applied": row.get::<i64, _>("applied") == 1,
            "pendingReason": row.get::<Option<String>, _>("pending_reason"),
            "errorCode": row.get::<Option<String>, _>("error_code"),
        })
    })
    .collect::<Vec<_>>();
    let generation = published_generation(&state, &id).await;
    let mut diagnostics = if plugin.activation == plugins::PluginActivation::Enabled
        && plugin.entrypoints.worker.is_some()
        && state.plugins.activation_lease(&id).await.is_none()
    {
        vec![json!({
            "code": "worker_not_running",
            "severity": "error",
            "message": "Published Worker generation is not running",
        })]
    } else {
        Vec::new()
    };
    if plugin.source.kind == plugins::PluginSourceKind::DeveloperLink {
        let published_digest = sqlx::query_scalar::<_, String>(
            "SELECT current_package_digest FROM plugin_installations_v4 WHERE plugin_id = ?",
        )
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(DevError::database)?;
        match inspect_linked_source(plugin.source.path.to_string_lossy().as_ref()) {
            Ok((candidate, digest)) => {
                if candidate.publisher != plugin.publisher
                    || candidate.id != plugin.id
                    || published_digest.as_deref() != Some(digest.as_str())
                {
                    diagnostics.push(json!({
                        "code": "linked_candidate_invalid",
                        "severity": "error",
                        "message": "Linked source identity or digest no longer matches the installation",
                    }));
                }
            }
            Err(error) => diagnostics.push(json!({
                "code": "linked_candidate_invalid",
                "severity": "error",
                "message": error.message,
            })),
        }
    }
    Ok(Json(json!({
        "protocolVersion": PROTOCOL,
        "plugin": { "publisher": publisher, "id": id },
        "installation": {
            "version": plugin.version,
            "sourcePath": plugin.source.path,
            "sourceKind": plugin.source.kind,
            "packageDigest": plugin.package_digest,
            "origin": plugin.source.origin,
            "gitRef": plugin.source.git_ref,
            "gitSha": plugin.source.git_sha,
            "locked": plugin.source.locked,
        },
        "activation": { "enabled": plugin.activation == plugins::PluginActivation::Enabled, "generation": generation },
        "sourceKind": match plugin.source.kind {
            plugins::PluginSourceKind::DeveloperLink => "linked",
            plugins::PluginSourceKind::Builtin => "builtin",
            plugins::PluginSourceKind::Marketplace => "marketplace",
            _ => "installed",
        },
        "runtimes": runtimes,
        "contributions": contributions,
        "agentBindings": bindings,
        "mcpRebindingRequired": bindings.iter().any(|binding| {
            binding.get("desired").and_then(|value| value.as_bool()) == Some(true)
                && binding.get("applied").and_then(|value| value.as_bool()) != Some(true)
        }),
        "recentCrashes": plugins::recent_plugin_crashes(&id),
        "diagnostics": diagnostics,
    })))
}

fn inspect_linked_source(source: &str) -> Result<(plugins::PluginPackage, String), DevError> {
    let raw = PathBuf::from(source);
    let root = raw.canonicalize().map_err(|_| {
        DevError::bad_request("plugin_link_source_missing", "Linked source does not exist")
    })?;
    if !root.is_dir() {
        return Err(DevError::bad_request(
            "plugin_link_source_not_directory",
            "Linked source must be a directory",
        ));
    }
    let package = plugins::PluginPackage::inspect(&root, plugins::PluginSourceKind::DeveloperLink)
        .map_err(DevError::plugin)?;
    let digest = plugins::package_content_digest(&root).map_err(DevError::plugin)?;
    Ok((package, digest))
}

fn verify_expected(
    package: &plugins::PluginPackage,
    digest: &str,
    expected: &ExpectedPackage,
) -> Result<(), DevError> {
    if package.publisher.as_deref() != Some(expected.publisher.as_str())
        || package.id.as_str() != expected.plugin_id
        || package.version != expected.version
        || digest != expected.package_digest
    {
        return Err(DevError::new(
            StatusCode::CONFLICT,
            "plugin_dev_expectation_mismatch",
            "Package identity, version, or digest does not match the Host inspection",
        ));
    }
    Ok(())
}

async fn activated_response(
    state: &DevState,
    package: &plugins::PluginPackage,
    digest: String,
) -> Result<Json<Value>, DevError> {
    let generation = published_generation(state, package.id.as_str())
        .await
        .ok_or_else(|| {
            DevError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "plugin_generation_missing",
                "Plugin activated without a published generation",
            )
        })?;
    Ok(Json(json!({
        "protocolVersion": PROTOCOL,
        "plugin": { "publisher": package.publisher, "id": package.id.as_str() },
        "generation": generation,
        "packageDigest": digest,
        "state": "active",
    })))
}

async fn published_generation(state: &DevState, plugin_id: &str) -> Option<u64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT generation_id FROM plugin_generations_v4
         WHERE plugin_id = ? AND state IN ('active','active_degraded')
         ORDER BY generation_id DESC LIMIT 1",
    )
    .bind(plugin_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .and_then(|value| u64::try_from(value).ok())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[derive(Debug)]
struct DevError {
    status: StatusCode,
    code: &'static str,
    message: String,
    published_generation: Option<u64>,
}

impl DevError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            published_generation: None,
        }
    }

    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    fn not_found(id: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "plugin_not_found",
            format!("Plugin `{id}` is not installed"),
        )
    }

    fn plugin(error: plugins::PluginError) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "plugin_operation_failed",
            error.to_string(),
        )
    }

    fn database(error: sqlx::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin_registry_failed",
            error.to_string(),
        )
    }

    fn worker(error: plugins::WorkerHostError, published_generation: Option<u64>) -> Self {
        let mut result = Self::new(
            StatusCode::BAD_REQUEST,
            "plugin_candidate_failed",
            error.to_string(),
        );
        result.published_generation = published_generation;
        result
    }
}

impl IntoResponse for DevError {
    fn into_response(self) -> Response<Body> {
        (
            self.status,
            Json(json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "retryable": false,
                    "publishedGeneration": self.published_generation,
                }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{constant_time_eq, reload_grants_from_existing, selected_grants};

    #[test]
    fn persists_a_loopback_connection_for_the_product_cli() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("plugin-dev.json");
        super::persist_connection(
            &path,
            &super::PluginDevConnection {
                endpoint: "http://127.0.0.1:43100".to_owned(),
                token: "dev-token".to_owned(),
                protocol_version: super::PROTOCOL,
            },
        )
        .unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["url"], "http://127.0.0.1:43100");
        assert_eq!(raw["token"], "dev-token");
        assert_eq!(raw["protocolVersion"], "1.0");
    }

    #[test]
    fn token_comparison_requires_equal_bytes() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn rust_digest_matches_the_public_cli_package_lock_algorithm() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".vibex-plugin")).unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(
            root.path().join(".vibex-plugin/plugin.json"),
            br#"{"id":"digest"}"#,
        )
        .unwrap();
        std::fs::write(root.path().join("src/worker.mjs"), b"export default 1;\n").unwrap();
        std::fs::write(
            root.path().join(".vibex-plugin/developer-link.json"),
            b"private path",
        )
        .unwrap();

        let digest = plugins::package_content_digest(root.path()).unwrap();

        assert_eq!(
            digest,
            "fd2e7a45f9ba9845d9fbdd1941060df7da68e8fbd5b40b5ac4b342ff780f86ca"
        );
    }

    #[test]
    fn linked_candidates_inherit_full_trust_without_reauthorization() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".vibex-plugin")).unwrap();
        std::fs::create_dir_all(root.path().join("skills/sample")).unwrap();
        std::fs::write(root.path().join("skills/sample/SKILL.md"), "# Sample\n").unwrap();
        std::fs::write(
            root.path().join(".vibex-plugin/plugin.json"),
            serde_json::json!({
                "manifestVersion": 4,
                "apiVersion": "1.0",
                "id": "permission-test",
                "publisher": "dev.test",
                "version": "1.0.0",
                "name": "Permission test",
                "engines": { "vibex": ">=0.1.3", "pluginSdk": "^1.0.0" },
                "permissions": [{
                    "id": "preview",
                    "capability": "artifact.preview",
                    "scope": { "providers": ["sample"] },
                    "reason": "Preview"
                }],
                "contributes": {
                    "agent.skills": [{
                        "id": "sample", "kindVersion": 1,
                        "path": "skills/sample", "targets": ["codex"]
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();
        let package =
            plugins::PluginPackage::inspect(root.path(), plugins::PluginSourceKind::DeveloperLink)
                .unwrap();

        let implicit = selected_grants(&package).unwrap();
        assert_eq!(implicit.len(), 1);
        assert_eq!(implicit[0].capability, "artifact.preview");

        let reloaded = reload_grants_from_existing(&package, &[], Some(41)).unwrap();
        assert_eq!(reloaded.len(), 1);
    }
}
