use std::{collections::HashMap, sync::Arc, time::Duration};

use remote_protocol::{CommandResponse, ErrorEnvelope, OperationId, ServerCapabilities};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{RwLock, oneshot};
use url::Url;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Clone)]
struct RemoteCredential(String);

impl std::fmt::Debug for RemoteCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RemoteCredential([REDACTED])")
    }
}

#[derive(Clone)]
struct RemoteProfile {
    base_url: String,
    token: RemoteCredential,
}

struct RemotePump {
    window_label: String,
    profile_id: String,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct RemoteDesktopRegistry {
    profiles: Arc<RwLock<HashMap<(String, String), RemoteProfile>>>,
    pumps: Arc<RwLock<HashMap<Uuid, RemotePump>>>,
    client: reqwest::Client,
}

impl RemoteDesktopRegistry {
    pub fn new() -> Result<Self, AppError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Ok(Self {
            profiles: Arc::new(RwLock::new(HashMap::new())),
            pumps: Arc::new(RwLock::new(HashMap::new())),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(internal)?,
        })
    }

    pub async fn connect(
        &self,
        window_label: &str,
        profile_id: &str,
        base_url: &str,
        token: String,
    ) -> Result<(), AppError> {
        if window_label.trim().is_empty() || profile_id.trim().is_empty() {
            return Err(AppError::BadRequest(
                "window and profile identifiers are required".to_string(),
            ));
        }
        if token.len() < 32 {
            return Err(AppError::BadRequest(
                "remote Server token must contain at least 32 bytes".to_string(),
            ));
        }
        let base_url = validate_base_url(base_url)?;
        self.profiles.write().await.insert(
            (window_label.to_string(), profile_id.to_string()),
            RemoteProfile {
                base_url,
                token: RemoteCredential(token),
            },
        );
        Ok(())
    }

    pub async fn disconnect(&self, window_label: &str, profile_id: &str) {
        self.cancel_pumps(|pump| {
            pump.window_label == window_label && pump.profile_id == profile_id
        })
        .await;
        self.profiles
            .write()
            .await
            .remove(&(window_label.to_string(), profile_id.to_string()));
    }

    pub async fn disconnect_window(&self, window_label: &str) {
        self.cancel_pumps(|pump| pump.window_label == window_label)
            .await;
        self.profiles
            .write()
            .await
            .retain(|(connected_window, _), _| connected_window != window_label);
    }

    pub async fn disconnect_profile(&self, profile_id: &str) {
        self.cancel_pumps(|pump| pump.profile_id == profile_id)
            .await;
        self.profiles
            .write()
            .await
            .retain(|(_, connected_profile), _| connected_profile != profile_id);
    }

    async fn cancel_pumps(&self, predicate: impl Fn(&RemotePump) -> bool) {
        let mut pumps = self.pumps.write().await;
        let ids = pumps
            .iter()
            .filter(|(_, pump)| predicate(pump))
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(mut pump) = pumps.remove(&id)
                && let Some(cancel) = pump.cancel.take()
            {
                let _ = cancel.send(());
            }
        }
    }

    pub async fn cancel_subscription(&self, subscription_id: Uuid) {
        if let Some(mut pump) = self.pumps.write().await.remove(&subscription_id)
            && let Some(cancel) = pump.cancel.take()
        {
            let _ = cancel.send(());
        }
    }

    async fn profile(
        &self,
        window_label: &str,
        profile_id: &str,
    ) -> Result<RemoteProfile, AppError> {
        let profiles = self.profiles.read().await;
        if let Some(profile) = profiles.get(&(window_label.to_string(), profile_id.to_string())) {
            return Ok(profile.clone());
        }
        if let Some(host_window) = window_label
            .strip_prefix("settings-")
            .filter(|rest| rest.starts_with("host-") && rest.len() > "host-".len())
            && let Some(profile) = profiles.get(&(host_window.to_string(), profile_id.to_string()))
        {
            return Ok(profile.clone());
        }
        Err(AppError::NotFound(
            "remote Server profile not connected".to_string(),
        ))
    }

    pub async fn call(
        &self,
        window_label: &str,
        profile_id: &str,
        command: &str,
        args: Value,
        operation_id: Option<OperationId>,
    ) -> Result<Value, AppError> {
        if command.is_empty()
            || !command
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_' || byte.is_ascii_digit())
        {
            return Err(AppError::BadRequest(
                "remote command identifier is invalid".to_string(),
            ));
        }
        let profile = self.profile(window_label, profile_id).await?;
        let response = self
            .client
            .post(format!("{}/api/v1/call/{command}", profile.base_url))
            .bearer_auth(&profile.token.0)
            .header(
                "x-vibex-protocol-version",
                remote_protocol::PROTOCOL_VERSION,
            )
            .json(&serde_json::json!({
                "operation_id": operation_id.unwrap_or_default(),
                "args": args,
            }))
            .send()
            .await
            .map_err(internal)?;
        decode_command_response(response).await
    }

    pub async fn capabilities(
        &self,
        window_label: &str,
        profile_id: &str,
    ) -> Result<ServerCapabilities, AppError> {
        let profile = self.profile(window_label, profile_id).await?;
        let response = self
            .client
            .get(format!("{}/api/v1/capabilities", profile.base_url))
            .bearer_auth(&profile.token.0)
            .header(
                "x-vibex-protocol-version",
                remote_protocol::PROTOCOL_VERSION,
            )
            .send()
            .await
            .map_err(internal)?;
        if response.status().is_success() {
            return response.json().await.map_err(internal);
        }
        Err(remote_error(response).await)
    }

    pub async fn listen_host_event(
        &self,
        app: tauri::AppHandle,
        window_label: &str,
        profile_id: &str,
        event: String,
        subscription_id: Uuid,
    ) -> Result<Uuid, AppError> {
        let profile = self.profile(window_label, profile_id).await?;
        let channel = format!("remote-desktop:{profile_id}:{event}");
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.pumps.write().await.insert(
            subscription_id,
            RemotePump {
                window_label: window_label.to_string(),
                profile_id: profile_id.to_string(),
                cancel: Some(cancel_tx),
            },
        );
        let pumps = self.pumps.clone();
        let window_label = window_label.to_string();
        tokio::spawn(async move {
            let result = pump_host_event_socket(
                app,
                profile,
                event,
                channel,
                subscription_id,
                cancel_rx,
                window_label,
            )
            .await;
            pumps.write().await.remove(&subscription_id);
            if let Err(error) = result {
                tracing::warn!(%error, "remote desktop host event listen failed");
            }
        });
        Ok(subscription_id)
    }

    pub async fn subscribe_events(
        &self,
        window_label: &str,
        profile_id: &str,
        request: serde_json::Value,
        on_event: tauri::ipc::Channel<serde_json::Value>,
        subscription_id: Uuid,
    ) -> Result<Uuid, AppError> {
        let profile = self.profile(window_label, profile_id).await?;
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.pumps.write().await.insert(
            subscription_id,
            RemotePump {
                window_label: window_label.to_string(),
                profile_id: profile_id.to_string(),
                cancel: Some(cancel_tx),
            },
        );
        let pumps = self.pumps.clone();
        tokio::spawn(async move {
            let result =
                pump_subscription_socket(profile, request, on_event, subscription_id, cancel_rx)
                    .await;
            pumps.write().await.remove(&subscription_id);
            if let Err(error) = result {
                tracing::warn!(%error, "remote desktop subscription failed");
            }
        });
        Ok(subscription_id)
    }
}

async fn decode_command_response(response: reqwest::Response) -> Result<Value, AppError> {
    if response.status().is_success() {
        return response
            .json::<CommandResponse<Value>>()
            .await
            .map(|response| response.data)
            .map_err(internal);
    }
    Err(remote_error(response).await)
}

async fn remote_error(response: reqwest::Response) -> AppError {
    let status = response.status();
    match response.json::<ErrorEnvelope>().await {
        Ok(envelope) => AppError::BadRequest(format!(
            "remote Server rejected the request ({status}): {}",
            envelope.message
        )),
        Err(_) => AppError::Internal(format!("remote Server returned HTTP {status}")),
    }
}

pub(crate) fn validate_base_url(value: &str) -> Result<String, AppError> {
    let url = Url::parse(value.trim())
        .map_err(|error| AppError::BadRequest(format!("invalid Server URL: {error}")))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(AppError::BadRequest(
            "remote Server URL must use HTTP or HTTPS".to_string(),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(AppError::BadRequest(
            "remote Server URL must be an origin without credentials, path, query, or fragment"
                .to_string(),
        ));
    }
    let origin = url.as_str().trim_end_matches('/').to_string();
    if url.scheme() == "http" && !remote_protocol::origin_allows_plaintext_http(&origin) {
        return Err(AppError::BadRequest(
            "public Server origins must use HTTPS".to_string(),
        ));
    }
    Ok(origin)
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::Internal(error.to_string())
}

fn websocket_url(base_url: &str) -> String {
    format!("{}/api/v1/ws", base_url.replacen("http", "ws", 1))
}

fn token_protocol(token: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    format!("vibex.token.{}", URL_SAFE_NO_PAD.encode(token.as_bytes()))
}

async fn connect_remote_socket(
    profile: &RemoteProfile,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    AppError,
> {
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
    let mut request = websocket_url(&profile.base_url)
        .into_client_request()
        .map_err(internal)?;
    let protocol = format!("vibex.v1, {}", token_protocol(&profile.token.0));
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocol).map_err(internal)?,
    );
    let (stream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(internal)?;
    Ok(stream)
}

fn emit_host_event_to_window_family(
    app: &tauri::AppHandle,
    window_label: &str,
    channel: &str,
    payload: &Value,
) {
    use tauri::{Emitter, EventTarget};
    for label in crate::host_windows::host_family_event_labels(window_label) {
        let _ = app.emit_to(EventTarget::labeled(&label), channel, payload);
    }
}

async fn pump_host_event_socket(
    app: tauri::AppHandle,
    profile: RemoteProfile,
    event: String,
    channel: String,
    subscription_id: Uuid,
    cancel_rx: oneshot::Receiver<()>,
    window_label: String,
) -> Result<(), AppError> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut stream = connect_remote_socket(&profile).await?;
    let attach = serde_json::json!({
        "type": "attach",
        "request": {
            "subscription_id": subscription_id,
            "resource": "host_event",
            "channel": event,
            "after_sequence": 0,
        }
    });
    stream
        .send(Message::Text(attach.to_string().into()))
        .await
        .map_err(internal)?;
    tokio::pin!(cancel_rx);
    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let detach = serde_json::json!({
                    "type": "detach",
                    "subscription_id": subscription_id,
                });
                let _ = stream.send(Message::Text(detach.to_string().into())).await;
                break;
            }
            frame = stream.next() => {
                let Some(frame) = frame else { break };
                let Message::Text(text) = frame.map_err(internal)? else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(Value::as_str) != Some("event") {
                    continue;
                }
                if let Some(payload) = value.pointer("/event/payload") {
                    emit_host_event_to_window_family(&app, &window_label, &channel, payload);
                }
            }
        }
    }
    Ok(())
}

async fn pump_subscription_socket(
    profile: RemoteProfile,
    request: Value,
    on_event: tauri::ipc::Channel<Value>,
    subscription_id: Uuid,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<(), AppError> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut stream = connect_remote_socket(&profile).await?;
    let mut request = request;
    if let Some(object) = request.as_object_mut() {
        object.insert(
            "subscription_id".to_string(),
            serde_json::json!(subscription_id),
        );
    }
    let attach = serde_json::json!({
        "type": "attach",
        "request": request,
    });
    stream
        .send(Message::Text(attach.to_string().into()))
        .await
        .map_err(internal)?;
    tokio::pin!(cancel_rx);
    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let detach = serde_json::json!({
                    "type": "detach",
                    "subscription_id": subscription_id,
                });
                let _ = stream.send(Message::Text(detach.to_string().into())).await;
                break;
            }
            frame = stream.next() => {
                let Some(frame) = frame else { break };
                let Message::Text(text) = frame.map_err(internal)? else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("event") => {
                        if let Some(event) = value.get("event") {
                            let _ = on_event.send(event.clone());
                        }
                    }
                    Some("snapshot") => {
                        if let Some(snapshot) = value.get("snapshot") {
                            let _ = on_event.send(serde_json::json!({
                                "kind": "subscription_snapshot",
                                "payload": snapshot.get("payload"),
                                "sequence": snapshot.get("through_sequence"),
                            }));
                        }
                    }
                    Some("error") => {
                        if let Some(error) = value.get("error") {
                            let _ = on_event.send(serde_json::json!({
                                "kind": "subscription_error",
                                "payload": error,
                                "sequence": 0,
                            }));
                        }
                    }
                    Some("detached") => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDesktopProfileInput {
    pub profile_id: String,
    pub base_url: String,
    pub token: String,
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, extract::Request, http::header, routing::post};
    use remote_protocol::{CommandResponse, OperationId};

    use super::{RemoteCredential, RemoteDesktopRegistry, validate_base_url};

    #[test]
    fn remote_server_urls_accept_http_or_https_origins() {
        assert!(validate_base_url("https://server.example").is_ok());
        assert!(validate_base_url("http://127.0.0.1:17891").is_ok());
        assert!(validate_base_url("http://192.168.1.20:17891").is_ok());
        assert!(validate_base_url("http://studio.local:17891").is_ok());
        assert!(validate_base_url("http://[::1]:17891").is_ok());
        assert!(validate_base_url("http://10.8.0.2:17891").is_ok());
        assert!(validate_base_url("http://203.0.113.10:443").is_err());
        assert!(validate_base_url("http://example.com").is_err());
        assert!(validate_base_url("https://203.0.113.10").is_ok());
        assert!(validate_base_url("ftp://server.example").is_err());
        assert!(validate_base_url("https://user@server.example").is_err());
        assert!(validate_base_url("https://server.example/path").is_err());
    }

    #[tokio::test]
    async fn same_profile_name_is_isolated_by_desktop_window() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new().route(
            "/api/v1/call/{command}",
            post(|request: Request| async move {
                let authorization = request
                    .headers()
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                Json(CommandResponse::new(
                    OperationId::new(),
                    serde_json::json!(if authorization.ends_with('a') {
                        "window-a"
                    } else {
                        "window-b"
                    }),
                ))
            }),
        );
        let _task = tokio::spawn(async move { axum::serve(listener, router).await });
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let base_url = format!("http://{address}");
        registry
            .connect(
                "window-a",
                "shared-name",
                &base_url,
                format!("{}a", "x".repeat(32)),
            )
            .await
            .expect("window a");
        registry
            .connect(
                "window-b",
                "shared-name",
                &base_url,
                format!("{}b", "x".repeat(32)),
            )
            .await
            .expect("window b");

        assert_eq!(
            registry
                .call(
                    "window-a",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("call a"),
            "window-a"
        );
        assert_eq!(
            registry
                .call(
                    "window-b",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("call b"),
            "window-b"
        );
        registry.disconnect_window("window-a").await;
        assert!(
            registry
                .call(
                    "window-a",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_err()
        );
        assert!(
            registry
                .call(
                    "window-b",
                    "shared-name",
                    "ping",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_ok()
        );
        assert_eq!(
            format!("{:?}", RemoteCredential("super-secret".to_string())),
            "RemoteCredential([REDACTED])"
        );
    }

    #[tokio::test]
    async fn remote_calls_stay_on_the_bound_window_and_its_settings() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new().route(
            "/api/v1/call/{command}",
            post(|_request: Request| async move {
                Json(CommandResponse::new(
                    OperationId::new(),
                    serde_json::json!("bound"),
                ))
            }),
        );
        let _task = tokio::spawn(async move { axum::serve(listener, router).await });
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let base_url = format!("http://{address}");
        registry
            .connect("host-abc", "active-host-client", &base_url, "x".repeat(32))
            .await
            .expect("host window");

        assert!(
            registry
                .call(
                    "main",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .is_err()
        );
        assert_eq!(
            registry
                .call(
                    "host-abc",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("host window"),
            "bound"
        );
        assert_eq!(
            registry
                .call(
                    "settings-host-abc",
                    "active-host-client",
                    "get_projects",
                    serde_json::json!({}),
                    None
                )
                .await
                .expect("host settings window"),
            "bound"
        );
        _task.abort();
    }

    #[tokio::test]
    async fn cancel_subscription_stops_the_owned_pump() {
        let registry = RemoteDesktopRegistry::new().expect("registry");
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = uuid::Uuid::new_v4();
        registry.pumps.write().await.insert(
            id,
            super::RemotePump {
                window_label: "window-a".into(),
                profile_id: "profile".into(),
                cancel: Some(tx),
            },
        );
        registry.cancel_subscription(id).await;
        assert!(rx.await.is_ok());
        assert!(registry.pumps.read().await.get(&id).is_none());
    }
}
