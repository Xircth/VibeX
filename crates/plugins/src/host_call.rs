use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{CapabilityBroker, WorkerHostError};

pub const HOST_CALL_URL_ENV: &str = "VIBEX_HOST_CALL_URL";
pub const HOST_CALL_TOKEN_ENV: &str = "VIBEX_HOST_CALL_TOKEN";
pub const HOST_CALL_PLUGIN_ID_ENV: &str = "VIBEX_PLUGIN_ID";

static PROCESS: OnceLock<Arc<PluginHostCall>> = OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginHostCallContext {
    pub url: String,
    pub token: String,
    pub plugin_id: String,
}

struct IssuedToken {
    plugin_id: String,
    generation: u64,
}

/// Loopback host.call for plugin MCP stdio processes (ADR-0051).
///
/// Agent-spawned MCP has no Worker stdio. Host injects a URL and bearer token
/// into every non-host-family plugin MCP spec; the token is bound to one plugin.
pub struct PluginHostCall {
    broker: Arc<dyn CapabilityBroker>,
    tokens: Mutex<HashMap<String, IssuedToken>>,
    endpoint: OnceLock<String>,
}

#[derive(Deserialize)]
struct HostCallBody {
    capability: String,
    operation: String,
    #[serde(default)]
    input: Value,
}

impl PluginHostCall {
    pub fn new(broker: Arc<dyn CapabilityBroker>) -> Arc<Self> {
        Arc::new(Self {
            broker,
            tokens: Mutex::new(HashMap::new()),
            endpoint: OnceLock::new(),
        })
    }

    pub fn install_process_instance(self: &Arc<Self>) {
        let _ = PROCESS.set(Arc::clone(self));
    }

    pub fn process_instance() -> Option<Arc<Self>> {
        PROCESS.get().cloned()
    }

    pub fn endpoint(&self) -> Option<&str> {
        self.endpoint.get().map(String::as_str)
    }

    pub async fn bind_loopback(self: Arc<Self>) -> Result<Arc<Self>, WorkerHostError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| WorkerHostError::broker("host_call_bind_failed", error))?;
        let address = listener
            .local_addr()
            .map_err(|error| WorkerHostError::broker("host_call_bind_failed", error))?;
        let url = format!("http://{address}/host-call");
        let _ = self.endpoint.set(url);
        let router = Router::new()
            .route("/host-call", post(handle_host_call))
            .with_state(Arc::clone(&self));
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::warn!(%error, "plugin host.call loopback stopped");
            }
        });
        self.install_process_instance();
        Ok(self)
    }

    pub fn issue(
        &self,
        plugin_id: &str,
        generation: u64,
    ) -> Result<PluginHostCallContext, WorkerHostError> {
        let url = self.endpoint.get().cloned().ok_or_else(|| {
            WorkerHostError::broker(
                "host_call_unavailable",
                "plugin host.call loopback is not listening",
            )
        })?;
        self.revoke_plugin(plugin_id);
        let token = Uuid::new_v4().to_string();
        self.tokens.lock().expect("host.call tokens").insert(
            token.clone(),
            IssuedToken {
                plugin_id: plugin_id.to_owned(),
                generation,
            },
        );
        Ok(PluginHostCallContext {
            url,
            token,
            plugin_id: plugin_id.to_owned(),
        })
    }

    pub fn revoke_plugin(&self, plugin_id: &str) {
        self.tokens
            .lock()
            .expect("host.call tokens")
            .retain(|_, issued| issued.plugin_id != plugin_id);
    }

    fn lookup(&self, token: &str) -> Option<IssuedToken> {
        self.tokens
            .lock()
            .expect("host.call tokens")
            .get(token)
            .map(|issued| IssuedToken {
                plugin_id: issued.plugin_id.clone(),
                generation: issued.generation,
            })
    }
}

pub fn attach_host_call_env(spec: &mut Value, ctx: &PluginHostCallContext, cwd: Option<&Path>) {
    let Some(object) = spec.as_object_mut() else {
        return;
    };
    let env = object
        .entry("env")
        .or_insert_with(|| Value::Object(Default::default()));
    if let Some(map) = env.as_object_mut() {
        map.insert(HOST_CALL_URL_ENV.to_owned(), json!(ctx.url));
        map.insert(HOST_CALL_TOKEN_ENV.to_owned(), json!(ctx.token));
        map.insert(HOST_CALL_PLUGIN_ID_ENV.to_owned(), json!(ctx.plugin_id));
    }
    if let Some(cwd) = cwd {
        object.insert("cwd".to_owned(), json!(cwd.to_string_lossy().into_owned()));
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
}

async fn handle_host_call(
    State(gateway): State<Arc<PluginHostCall>>,
    headers: HeaderMap,
    Json(body): Json<HostCallBody>,
) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "code": "host_call_unauthorized",
                "message": "plugin host.call requires a bearer token",
            })),
        )
            .into_response();
    };
    let Some(issued) = gateway.lookup(&token) else {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "code": "host_call_forbidden",
                "message": "plugin host.call token is not valid",
            })),
        )
            .into_response();
    };
    let capability = body.capability.trim();
    let operation = body.operation.trim();
    if capability.is_empty() || operation.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "code": "host_call_invalid",
                "message": "capability and operation are required",
            })),
        )
            .into_response();
    }
    match gateway
        .broker
        .call(
            &issued.plugin_id,
            issued.generation,
            capability,
            operation,
            body.input,
        )
        .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "code": error.code(),
                "message": error.message(),
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;

    use super::*;

    struct RecordingBroker {
        calls: Mutex<Vec<(String, String, String, Value)>>,
    }

    #[async_trait]
    impl CapabilityBroker for RecordingBroker {
        async fn call(
            &self,
            plugin_id: &str,
            _generation: u64,
            capability: &str,
            operation: &str,
            input: Value,
        ) -> Result<Value, WorkerHostError> {
            self.calls.lock().expect("calls").push((
                plugin_id.to_owned(),
                capability.to_owned(),
                operation.to_owned(),
                input.clone(),
            ));
            Ok(json!({ "ok": true, "pluginId": plugin_id, "operation": operation }))
        }
    }

    #[test]
    fn attach_host_call_env_merges_without_plugin_id_special_cases() {
        let mut spec = json!({
            "type": "stdio",
            "command": "node",
            "args": ["runtime/mcp-server.mjs"],
            "env": { "EXISTING": "1" }
        });
        attach_host_call_env(
            &mut spec,
            &PluginHostCallContext {
                url: "http://127.0.0.1:9/host-call".into(),
                token: "tok".into(),
                plugin_id: "example.tools".into(),
            },
            Some(Path::new("/plugins/example.tools")),
        );
        assert_eq!(spec["env"]["EXISTING"], "1");
        assert_eq!(
            spec["env"][HOST_CALL_URL_ENV],
            "http://127.0.0.1:9/host-call"
        );
        assert_eq!(spec["env"][HOST_CALL_TOKEN_ENV], "tok");
        assert_eq!(spec["env"][HOST_CALL_PLUGIN_ID_ENV], "example.tools");
        assert_eq!(spec["cwd"], "/plugins/example.tools");
        let encoded = spec.to_string();
        assert!(!encoded.contains("vibex.browser"));
    }

    async fn post_host_call(url: &str, token: &str, body: &str) -> (u16, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host = url
            .trim_start_matches("http://")
            .trim_end_matches("/host-call");
        let mut stream = tokio::net::TcpStream::connect(host).await.expect("connect");
        let request = format!(
            "POST /host-call HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.expect("read");
        let status = raw
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let json = raw
            .split("\r\n\r\n")
            .nth(1)
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or(json!({}));
        (status, json)
    }

    #[tokio::test]
    async fn issued_token_dispatches_to_the_owning_plugin_only() {
        let broker = Arc::new(RecordingBroker {
            calls: Mutex::new(Vec::new()),
        });
        let gateway = PluginHostCall::new(broker.clone())
            .bind_loopback()
            .await
            .expect("listen");
        let ctx = gateway.issue("example.tools", 4).expect("issue");
        let (status, body) = post_host_call(
            &ctx.url,
            &ctx.token,
            r#"{"capability":"browser","operation":"tab.list","input":{"unused":true}}"#,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(body["pluginId"], "example.tools");
        assert_eq!(body["operation"], "tab.list");
        let calls = broker.calls.lock().expect("calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "example.tools");
        assert_eq!(calls[0].1, "browser");
        assert_eq!(calls[0].2, "tab.list");
    }

    #[tokio::test]
    async fn unknown_token_is_rejected() {
        let broker = Arc::new(RecordingBroker {
            calls: Mutex::new(Vec::new()),
        });
        let gateway = PluginHostCall::new(broker)
            .bind_loopback()
            .await
            .expect("listen");
        let url = gateway.endpoint().expect("url").to_owned();
        let (status, body) = post_host_call(
            &url,
            "missing",
            r#"{"capability":"browser","operation":"tab.list"}"#,
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(body["code"], "host_call_forbidden");
    }

    #[tokio::test]
    async fn reissue_revokes_the_previous_token() {
        let broker = Arc::new(RecordingBroker {
            calls: Mutex::new(Vec::new()),
        });
        let gateway = PluginHostCall::new(broker)
            .bind_loopback()
            .await
            .expect("listen");
        let first = gateway.issue("example.tools", 1).expect("first");
        let _second = gateway.issue("example.tools", 2).expect("second");
        let (status, _) = post_host_call(
            &first.url,
            &first.token,
            r#"{"capability":"browser","operation":"tab.list"}"#,
        )
        .await;
        assert_eq!(status, 403);
    }
}
