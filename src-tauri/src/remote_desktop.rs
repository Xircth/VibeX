use std::{collections::HashMap, sync::Arc, time::Duration};

use remote_protocol::{CommandResponse, ErrorEnvelope, OperationId, ServerCapabilities};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::RwLock;
use url::Url;

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

#[derive(Clone)]
pub struct RemoteDesktopRegistry {
    profiles: Arc<RwLock<HashMap<(String, String), RemoteProfile>>>,
    client: reqwest::Client,
}

impl RemoteDesktopRegistry {
    pub fn new() -> Result<Self, AppError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Ok(Self {
            profiles: Arc::new(RwLock::new(HashMap::new())),
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
        self.profiles
            .write()
            .await
            .remove(&(window_label.to_string(), profile_id.to_string()));
    }

    pub async fn disconnect_window(&self, window_label: &str) {
        self.profiles
            .write()
            .await
            .retain(|(connected_window, _), _| connected_window != window_label);
    }

    pub async fn call(
        &self,
        window_label: &str,
        profile_id: &str,
        command: &str,
        args: Value,
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
        let profile = self
            .profiles
            .read()
            .await
            .get(&(window_label.to_string(), profile_id.to_string()))
            .cloned()
            .ok_or_else(|| AppError::NotFound("remote Server profile not connected".to_string()))?;
        let response = self
            .client
            .post(format!("{}/api/v1/call/{command}", profile.base_url))
            .bearer_auth(&profile.token.0)
            .header(
                "x-vibex-protocol-version",
                remote_protocol::PROTOCOL_VERSION,
            )
            .json(&serde_json::json!({
                "operation_id": OperationId::new(),
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
        let profile = self
            .profiles
            .read()
            .await
            .get(&(window_label.to_string(), profile_id.to_string()))
            .cloned()
            .ok_or_else(|| AppError::NotFound("remote Server profile not connected".to_string()))?;
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

fn validate_base_url(value: &str) -> Result<String, AppError> {
    let url = Url::parse(value.trim())
        .map_err(|error| AppError::BadRequest(format!("invalid Server URL: {error}")))?;
    let loopback = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|host| host.is_loopback())
        || matches!(url.host_str(), Some("localhost"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(AppError::BadRequest(
            "remote Server URL must use HTTPS unless it is loopback".to_string(),
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
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::Internal(error.to_string())
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
    fn remote_server_urls_require_https_except_for_loopback() {
        assert!(validate_base_url("https://server.example").is_ok());
        assert!(validate_base_url("http://127.0.0.1:3080").is_ok());
        assert!(validate_base_url("http://server.example").is_err());
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
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
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
                .call("window-a", "shared-name", "ping", serde_json::json!({}))
                .await
                .expect("call a"),
            "window-a"
        );
        assert_eq!(
            registry
                .call("window-b", "shared-name", "ping", serde_json::json!({}))
                .await
                .expect("call b"),
            "window-b"
        );
        registry.disconnect_window("window-a").await;
        assert!(
            registry
                .call("window-a", "shared-name", "ping", serde_json::json!({}))
                .await
                .is_err()
        );
        assert!(
            registry
                .call("window-b", "shared-name", "ping", serde_json::json!({}))
                .await
                .is_ok()
        );
        assert_eq!(
            format!("{:?}", RemoteCredential("super-secret".to_string())),
            "RemoteCredential([REDACTED])"
        );
        task.abort();
    }
}
