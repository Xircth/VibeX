use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{sync::Mutex, time::Instant};

const MAX_DOCUMENT_BYTES: u64 = 2_000_000;
const MAX_ARTIFACT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOKEN_LENGTH: usize = 128;
const MAX_REQUEST_ID_LENGTH: usize = 128;
const DEFAULT_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
struct AppSurfaceSession {
    plugin_id: String,
    surface_id: String,
    catalog_generation: u64,
    worker_generation: u64,
    allowed_methods: Vec<String>,
    last_sequence: u64,
    ready: bool,
    expires_at: Instant,
    artifact: Option<ArtifactEditorSession>,
}

#[derive(Clone)]
struct ArtifactEditorSession {
    path: PathBuf,
    name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppSurfaceErrorKind {
    NotFound,
    BadRequest,
    Conflict,
    Internal,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppSurfaceError {
    kind: AppSurfaceErrorKind,
    message: String,
}

impl AppSurfaceError {
    pub fn kind(&self) -> AppSurfaceErrorKind {
        self.kind
    }

    fn new(kind: AppSurfaceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceIdentity {
    pub plugin_id: String,
    pub surface_id: String,
    pub generation: u64,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceOpenRequest {
    #[serde(flatten)]
    pub identity: AppSurfaceIdentity,
    #[serde(default)]
    pub artifact_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceInvocation {
    #[serde(flatten)]
    pub identity: AppSurfaceIdentity,
    pub request_id: String,
    pub sequence: u64,
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceDocument {
    pub html: String,
    pub token: String,
    pub context: Value,
}

/// Application-level App Extension Host shared by Desktop and remote Server.
/// UI adapters never receive a package path; this service resolves only a
/// published contribution and binds its session to one Worker generation.
pub struct PluginAppSurfaceHost {
    plugins: Arc<crate::PluginControlPlane>,
    sessions: Mutex<HashMap<String, AppSurfaceSession>>,
    token_ttl: Duration,
}

impl PluginAppSurfaceHost {
    pub fn new(plugins: Arc<crate::PluginControlPlane>) -> Self {
        Self {
            plugins,
            sessions: Mutex::new(HashMap::new()),
            token_ttl: DEFAULT_TOKEN_TTL,
        }
    }

    #[doc(hidden)]
    pub fn with_token_ttl(plugins: Arc<crate::PluginControlPlane>, token_ttl: Duration) -> Self {
        Self {
            plugins,
            sessions: Mutex::new(HashMap::new()),
            token_ttl,
        }
    }

    pub async fn open(
        &self,
        request: AppSurfaceOpenRequest,
    ) -> Result<AppSurfaceDocument, AppSurfaceError> {
        let AppSurfaceOpenRequest {
            identity,
            artifact_path,
        } = request;
        validate_token(&identity.token)?;
        let plugin = self
            .plugins
            .plugin(&identity.plugin_id)
            .await
            .map_err(internal)?
            .ok_or_else(|| not_found("Plugin surface package not found"))?;
        if plugin.activation != crate::PluginActivation::Enabled {
            return Err(conflict("Plugin surface is disabled"));
        }
        let catalog = self.plugins.contributions().await.map_err(internal)?;
        let descriptor = catalog
            .items
            .iter()
            .find(|item| {
                item.plugin_id == identity.plugin_id
                    && item.id == identity.surface_id
                    && item.kind == crate::ContributionKind::AppSurface
            })
            .ok_or_else(|| not_found("Published App surface not found"))?;
        if descriptor.generation != identity.generation {
            return Err(conflict("App surface contribution generation is stale"));
        }
        let metadata = descriptor
            .metadata
            .as_object()
            .ok_or_else(|| internal("App surface descriptor is invalid"))?;
        let slot = metadata
            .get("slot")
            .and_then(Value::as_str)
            .ok_or_else(|| internal("App surface slot is missing"))?;
        if !matches!(slot, "plugin.detail.panel" | "artifact.editor")
            || metadata.get("appEntrypoint").and_then(Value::as_str) != Some("app")
        {
            return Err(bad_request("App surface targets an unsupported Host slot"));
        }
        let artifact = match (slot, artifact_path) {
            ("plugin.detail.panel", None) => None,
            ("artifact.editor", Some(path)) => Some(
                self.open_artifact_editor(&identity.plugin_id, &identity.surface_id, path)
                    .await?,
            ),
            ("artifact.editor", None) => {
                return Err(bad_request("Artifact editor surface requires a file"));
            }
            ("plugin.detail.panel", Some(_)) => {
                return Err(bad_request("Plugin detail surface cannot receive a file"));
            }
            _ => return Err(bad_request("App surface targets an unsupported Host slot")),
        };
        let handler = metadata
            .get("handler")
            .and_then(Value::as_str)
            .ok_or_else(|| internal("App surface handler is missing"))?;
        let allowed_methods = metadata
            .get("allowedMethods")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let lease = self
            .plugins
            .activation_lease(&identity.plugin_id)
            .await
            .ok_or_else(|| conflict("App surface Worker is not active"))?;
        for required in std::iter::once(handler).chain(allowed_methods.iter().map(String::as_str)) {
            if !lease
                .activation()
                .handlers
                .iter()
                .any(|registered| registered == required)
            {
                return Err(conflict(format!(
                    "App surface handler `{required}` is not registered by its Worker"
                )));
            }
        }
        let authority_token = uuid::Uuid::new_v4().simple().to_string();
        let session = AppSurfaceSession {
            plugin_id: identity.plugin_id.clone(),
            surface_id: identity.surface_id.clone(),
            catalog_generation: identity.generation,
            worker_generation: lease.activation().generation,
            allowed_methods,
            last_sequence: 0,
            ready: false,
            expires_at: Instant::now() + self.token_ttl,
            artifact: artifact.clone(),
        };
        let mut sessions = self.sessions.lock().await;
        let now = Instant::now();
        sessions.retain(|_, existing| existing.expires_at > now);
        if sessions.insert(authority_token.clone(), session).is_some() {
            return Err(conflict("App surface token is already mounted"));
        }
        drop(sessions);
        let result = async {
            lease
                .invoke(
                    handler,
                    json!({
                        "phase": "open",
                        "surfaceId": identity.surface_id,
                        "catalogGeneration": identity.generation,
                        "token": authority_token,
                    }),
                )
                .await
                .map_err(|error| conflict(error.to_string()))?;
            read_surface_document(&plugin.package).await
        }
        .await;
        let html = match result {
            Ok(html) => html,
            Err(error) => {
                self.sessions.lock().await.remove(&authority_token);
                return Err(error);
            }
        };
        if let Some(session) = self.sessions.lock().await.get_mut(&authority_token) {
            session.ready = true;
        }
        Ok(AppSurfaceDocument {
            html,
            token: authority_token,
            context: surface_context(slot, artifact.as_ref())?,
        })
    }

    async fn open_artifact_editor(
        &self,
        plugin_id: &str,
        surface_id: &str,
        path: PathBuf,
    ) -> Result<ArtifactEditorSession, AppSurfaceError> {
        let path = path
            .canonicalize()
            .map_err(|_| not_found("Artifact editor file is missing"))?;
        let metadata = std::fs::metadata(&path).map_err(internal)?;
        if !metadata.is_file() || metadata.len() > MAX_ARTIFACT_BYTES {
            return Err(bad_request(
                "Artifact editor file exceeds the supported size",
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let file_name = path.file_name().and_then(|value| value.to_str());
        let resolved = self
            .plugins
            .resolve_file_opener_for_file(file_name, extension.as_deref(), None)
            .await
            .map_err(internal)?
            .ok_or_else(|| not_found("No published plugin file opener matches this artifact"))?;
        if resolved.plugin_id != plugin_id
            || resolved.handler != surface_id
            || resolved.target != crate::FileOpenerTarget::AppSurface
        {
            return Err(conflict(
                "Artifact editor surface is not the published opener for this file",
            ));
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| bad_request("Artifact editor file name is invalid"))?
            .to_owned();
        Ok(ArtifactEditorSession { path, name })
    }

    pub async fn invoke(&self, request: AppSurfaceInvocation) -> Result<Value, AppSurfaceError> {
        if request.request_id.is_empty() || request.request_id.len() > MAX_REQUEST_ID_LENGTH {
            return Err(bad_request("App surface request id is invalid"));
        }
        validate_json(&request.params, 0, &mut 0)?;
        let authority_token = request.identity.token.clone();
        let (worker_generation, artifact) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(&authority_token)
                .ok_or_else(|| conflict("App surface session is revoked"))?;
            if session.expires_at <= Instant::now() {
                sessions.remove(&authority_token);
                return Err(conflict("App surface capability token expired"));
            }
            validate_identity(session, &request.identity)?;
            if !session.ready {
                return Err(conflict("App surface session is still opening"));
            }
            if request.sequence != session.last_sequence.saturating_add(1) {
                sessions.remove(&authority_token);
                return Err(conflict(
                    "App surface sequence is invalid; session was revoked",
                ));
            }
            let artifact_method = session.artifact.is_some()
                && matches!(
                    request.method.as_str(),
                    "artifact.readText" | "artifact.writeText"
                );
            if !artifact_method
                && !session
                    .allowed_methods
                    .iter()
                    .any(|allowed| allowed == &request.method)
            {
                sessions.remove(&authority_token);
                return Err(bad_request(
                    "App surface method is outside the published allowlist",
                ));
            }
            session.last_sequence = request.sequence;
            (session.worker_generation, session.artifact.clone())
        };
        if let Some(artifact) = artifact {
            match request.method.as_str() {
                "artifact.readText" => return read_artifact_text(&artifact),
                "artifact.writeText" => {
                    return write_artifact_text(&artifact, &request.params);
                }
                _ => {}
            }
        }
        let lease = self
            .plugins
            .activation_lease(&request.identity.plugin_id)
            .await
            .ok_or_else(|| conflict("App surface Worker is unavailable"))?;
        if lease.activation().generation != worker_generation {
            self.sessions.lock().await.remove(&authority_token);
            return Err(conflict(
                "App surface Worker generation changed; session was revoked",
            ));
        }
        lease
            .invoke(
                &request.method,
                json!({
                    "surfaceId": request.identity.surface_id,
                    "requestId": request.request_id,
                    "params": request.params,
                }),
            )
            .await
            .map_err(|error| conflict(error.to_string()))
    }

    pub async fn revoke(&self, identity: &AppSurfaceIdentity) -> Result<(), AppSurfaceError> {
        let authority_token = identity.token.clone();
        let session = self.sessions.lock().await.remove(&authority_token);
        if let Some(session) = session {
            validate_identity(&session, identity)?;
        }
        Ok(())
    }
}

fn surface_context(
    slot: &str,
    artifact: Option<&ArtifactEditorSession>,
) -> Result<Value, AppSurfaceError> {
    let artifact = artifact
        .map(|artifact| {
            let bytes = std::fs::read(&artifact.path).map_err(internal)?;
            Ok::<_, AppSurfaceError>(json!({
                "name": artifact.name,
                "revision": artifact_revision(&bytes),
                "readOnly": false,
            }))
        })
        .transpose()?;
    Ok(json!({ "slot": slot, "artifact": artifact }))
}

fn read_artifact_text(artifact: &ArtifactEditorSession) -> Result<Value, AppSurfaceError> {
    let bytes = read_artifact_bytes(&artifact.path)?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| bad_request("Artifact editor supports UTF-8 text documents only"))?;
    Ok(json!({
        "name": artifact.name,
        "content": content,
        "revision": artifact_revision(&bytes),
    }))
}

fn write_artifact_text(
    artifact: &ArtifactEditorSession,
    params: &Value,
) -> Result<Value, AppSurfaceError> {
    let params = params
        .as_object()
        .ok_or_else(|| bad_request("Artifact write parameters are invalid"))?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request("Artifact write content is required"))?;
    if content.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(bad_request(
            "Artifact editor file exceeds the supported size",
        ));
    }
    let expected_revision = params
        .get("expectedRevision")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_request("Artifact write revision is required"))?;
    let metadata = std::fs::metadata(&artifact.path).map_err(internal)?;
    let current = read_artifact_bytes(&artifact.path)?;
    if artifact_revision(&current) != expected_revision {
        return Err(conflict(
            "Artifact changed outside this editor; reload before saving",
        ));
    }
    let parent = artifact
        .path
        .parent()
        .ok_or_else(|| internal("Artifact parent directory is missing"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(internal)?;
    temporary.write_all(content.as_bytes()).map_err(internal)?;
    temporary.flush().map_err(internal)?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(internal)?;
    temporary.persist(&artifact.path).map_err(internal)?;
    Ok(json!({ "revision": artifact_revision(content.as_bytes()) }))
}

fn read_artifact_bytes(path: &Path) -> Result<Vec<u8>, AppSurfaceError> {
    let metadata = std::fs::metadata(path).map_err(internal)?;
    if !metadata.is_file() || metadata.len() > MAX_ARTIFACT_BYTES {
        return Err(bad_request(
            "Artifact editor file exceeds the supported size",
        ));
    }
    std::fs::read(path).map_err(internal)
}

fn artifact_revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

async fn read_surface_document(package: &crate::PluginPackage) -> Result<String, AppSurfaceError> {
    let app_root = package
        .entrypoints
        .app
        .as_deref()
        .ok_or_else(|| conflict("Plugin has no published App entrypoint"))?;
    let document = package
        .entrypoints
        .app_document
        .as_deref()
        .ok_or_else(|| conflict("Plugin App document is missing"))?;
    let package_root = package.content_root().canonicalize().map_err(internal)?;
    let app_root = package_root
        .join(app_root)
        .canonicalize()
        .map_err(|_| not_found("Plugin App root is missing"))?;
    let document = app_root
        .join(document)
        .canonicalize()
        .map_err(|_| not_found("Plugin App document is missing"))?;
    if !app_root.starts_with(&package_root) || !document.starts_with(&app_root) {
        return Err(bad_request(
            "Plugin App document escapes the verified package root",
        ));
    }
    let metadata = tokio::fs::metadata(&document).await.map_err(internal)?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(bad_request(
            "Plugin App document exceeds the supported size",
        ));
    }
    tokio::fs::read_to_string(document)
        .await
        .map_err(|error| bad_request(error.to_string()))
}

fn validate_identity(
    session: &AppSurfaceSession,
    identity: &AppSurfaceIdentity,
) -> Result<(), AppSurfaceError> {
    if session.plugin_id != identity.plugin_id
        || session.surface_id != identity.surface_id
        || session.catalog_generation != identity.generation
    {
        return Err(conflict("App surface session identity does not match"));
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), AppSurfaceError> {
    if token.len() < 32
        || token.len() > MAX_TOKEN_LENGTH
        || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(bad_request("App surface mount token is invalid"));
    }
    Ok(())
}

fn validate_json(value: &Value, depth: usize, count: &mut usize) -> Result<(), AppSurfaceError> {
    if depth > 24 || *count > 10_000 {
        return Err(bad_request("App surface payload exceeds JSON limits"));
    }
    *count += 1;
    match value {
        Value::Number(number) if number.as_f64().is_some_and(|value| !value.is_finite()) => {
            return Err(bad_request(
                "App surface payload contains a non-finite number",
            ));
        }
        Value::Array(values) => {
            for value in values {
                validate_json(value, depth + 1, count)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > 256 {
                    return Err(bad_request("App surface payload key is too long"));
                }
                validate_json(value, depth + 1, count)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn not_found(message: impl Into<String>) -> AppSurfaceError {
    AppSurfaceError::new(AppSurfaceErrorKind::NotFound, message)
}

fn bad_request(message: impl Into<String>) -> AppSurfaceError {
    AppSurfaceError::new(AppSurfaceErrorKind::BadRequest, message)
}

fn conflict(message: impl Into<String>) -> AppSurfaceError {
    AppSurfaceError::new(AppSurfaceErrorKind::Conflict, message)
}

fn internal(message: impl std::fmt::Display) -> AppSurfaceError {
    AppSurfaceError::new(AppSurfaceErrorKind::Internal, message.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::time::Instant;

    use super::{
        AppSurfaceIdentity, AppSurfaceSession, DEFAULT_TOKEN_TTL, validate_identity, validate_json,
        validate_token,
    };

    #[test]
    fn mount_tokens_and_identity_fail_closed() {
        assert!(validate_token(&"a".repeat(48)).is_ok());
        assert!(validate_token("short").is_err());
        let session = AppSurfaceSession {
            plugin_id: "acme.panel".to_owned(),
            surface_id: "panel".to_owned(),
            catalog_generation: 4,
            worker_generation: 8,
            allowed_methods: vec![],
            last_sequence: 0,
            ready: true,
            expires_at: Instant::now() + DEFAULT_TOKEN_TTL,
            artifact: None,
        };
        let identity = AppSurfaceIdentity {
            plugin_id: "acme.panel".to_owned(),
            surface_id: "panel".to_owned(),
            generation: 4,
            token: "a".repeat(48),
        };
        assert!(validate_identity(&session, &identity).is_ok());
        assert!(
            validate_identity(
                &session,
                &AppSurfaceIdentity {
                    plugin_id: "other".to_owned(),
                    ..identity
                }
            )
            .is_err()
        );
    }

    #[test]
    fn deeply_nested_json_is_rejected() {
        let mut value = json!(null);
        for _ in 0..26 {
            value = json!([value]);
        }
        assert!(validate_json(&value, 0, &mut 0).is_err());
    }
}
