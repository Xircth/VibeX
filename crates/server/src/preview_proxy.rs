use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures::{Stream, StreamExt, stream::BoxStream};
use remote_protocol::{ErrorCode, ErrorEnvelope, OperationId};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::runtime::ServerState;

#[derive(Clone, Debug)]
struct PreviewRegistration {
    loopback_port: u16,
    capability_digest: [u8; 32],
    expires_at_unix_ms: u64,
}

/// Authoritative allowlist for the unauthenticated iframe proxy boundary.
///
/// Entries are created only from live Artifact preview leases. The registry
/// stores a digest of the short-lived capability and never accepts a host.
#[derive(Clone, Default)]
pub struct PreviewProxyRegistry {
    registrations: Arc<RwLock<HashMap<Uuid, PreviewRegistration>>>,
}

impl PreviewProxyRegistry {
    pub async fn register(
        &self,
        lease_id: Uuid,
        loopback_port: u16,
        capability: &str,
        expires_at_unix_ms: u64,
    ) -> Result<(), PreviewRegistrationError> {
        if loopback_port == 0 {
            return Err(PreviewRegistrationError::InvalidPort);
        }
        if capability.len() < 16 {
            return Err(PreviewRegistrationError::WeakCapability);
        }
        self.registrations.write().await.insert(
            lease_id,
            PreviewRegistration {
                loopback_port,
                capability_digest: Sha256::digest(capability.as_bytes()).into(),
                expires_at_unix_ms,
            },
        );
        Ok(())
    }

    pub async fn revoke(&self, lease_id: Uuid) {
        self.registrations.write().await.remove(&lease_id);
    }

    async fn authorize(
        &self,
        lease_id: Uuid,
        capability: &str,
    ) -> Result<PreviewRegistration, PreviewProxyError> {
        let Some(registration) = self.registrations.read().await.get(&lease_id).cloned() else {
            return Err(PreviewProxyError::UnknownLease);
        };
        if registration.expires_at_unix_ms <= now_unix_ms() {
            self.registrations.write().await.remove(&lease_id);
            return Err(PreviewProxyError::ExpiredCapability);
        }
        let candidate: [u8; 32] = Sha256::digest(capability.as_bytes()).into();
        let difference = registration
            .capability_digest
            .iter()
            .zip(candidate)
            .fold(0_u8, |difference, (expected, actual)| {
                difference | (expected ^ actual)
            });
        if difference != 0 {
            return Err(PreviewProxyError::WrongCapability);
        }
        Ok(registration)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PreviewRegistrationError {
    #[error("preview port must be non-zero")]
    InvalidPort,
    #[error("preview capability must contain at least 16 bytes")]
    WeakCapability,
}

#[derive(Debug, thiserror::Error)]
enum PreviewProxyError {
    #[error("preview lease is not registered")]
    UnknownLease,
    #[error("preview capability is invalid")]
    WrongCapability,
    #[error("preview capability has expired")]
    ExpiredCapability,
    #[error("preview path is invalid")]
    InvalidPath,
    #[error("preview provider is unavailable")]
    UpstreamUnavailable,
}

#[derive(Deserialize)]
pub(crate) struct PreviewCapabilityQuery {
    cap: Option<String>,
}

pub(crate) async fn proxy_root<R>(
    state: State<Arc<ServerState<R>>>,
    Path(lease_id): Path<Uuid>,
    query: Query<PreviewCapabilityQuery>,
) -> Response {
    proxy(
        state,
        lease_id,
        String::new(),
        query.cap.clone().unwrap_or_default(),
    )
    .await
}

pub(crate) async fn proxy_path<R>(
    state: State<Arc<ServerState<R>>>,
    Path((lease_id, path)): Path<(Uuid, String)>,
    query: Query<PreviewCapabilityQuery>,
) -> Response {
    let (capability, upstream_path) = if let Some(capability_path) = path.strip_prefix("c/") {
        let mut parts = capability_path.splitn(2, '/');
        (
            parts.next().unwrap_or_default().to_string(),
            parts.next().unwrap_or_default().to_string(),
        )
    } else {
        (query.cap.clone().unwrap_or_default(), path)
    };
    proxy(state, lease_id, upstream_path, capability).await
}

async fn proxy<R>(
    State(state): State<Arc<ServerState<R>>>,
    lease_id: Uuid,
    path: String,
    capability: String,
) -> Response {
    if capability.is_empty() {
        return proxy_error(PreviewProxyError::WrongCapability);
    }
    let registration = match state.preview_proxy.authorize(lease_id, &capability).await {
        Ok(registration) => registration,
        Err(error) => return proxy_error(error),
    };
    if !valid_relative_url_path(&path) {
        return proxy_error(PreviewProxyError::InvalidPath);
    }
    let upstream = format!("http://127.0.0.1:{}/{}", registration.loopback_port, path);
    let response = match state.preview_client.get(upstream).send().await {
        Ok(response) => response,
        Err(_) => return proxy_error(PreviewProxyError::UpstreamUnavailable),
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
    let proxy_base = format!("/api/v1/previews/{lease_id}/c/{capability}/");
    let is_sse = content_type
        .to_str()
        .is_ok_and(|value| value.starts_with("text/event-stream"));
    let body = if is_sse {
        let from = format!("http://127.0.0.1:{}/", registration.loopback_port);
        Body::from_stream(rewrite_sse_stream(
            response.bytes_stream().boxed(),
            from,
            proxy_base,
        ))
    } else {
        let bytes = match read_bounded(response, 16 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(error) => return proxy_error(error),
        };
        if content_type
            .to_str()
            .is_ok_and(|value| value.starts_with("text/html"))
        {
            Body::from(rewrite_html(&bytes, &proxy_base))
        } else {
            Body::from(bytes)
        }
    };
    let mut proxied = Response::new(body);
    *proxied.status_mut() =
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    proxied
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    proxied.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
    proxied.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; \
             style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:",
        ),
    );
    proxied
}

fn valid_relative_url_path(path: &str) -> bool {
    !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.split(['/', '\\']).any(|part| part == "..")
        && !path.contains('\0')
        && !path.contains("://")
}

fn rewrite_html(bytes: &[u8], proxy_base: &str) -> Vec<u8> {
    let Ok(html) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let base = format!(r#"<base href="{proxy_base}">"#);
    if let Some(index) = html.find("<head>") {
        let insert = index + "<head>".len();
        format!("{}{}{}", &html[..insert], base, &html[insert..]).into_bytes()
    } else {
        format!("{base}{html}").into_bytes()
    }
}

async fn read_bounded(
    response: reqwest::Response,
    maximum_bytes: usize,
) -> Result<Vec<u8>, PreviewProxyError> {
    let mut stream = response.bytes_stream();
    let mut output = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| PreviewProxyError::UpstreamUnavailable)?;
        if output.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(PreviewProxyError::UpstreamUnavailable);
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn rewrite_sse_stream(
    stream: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    from: String,
    to: String,
) -> impl Stream<Item = Result<Bytes, reqwest::Error>> {
    futures::stream::try_unfold(
        (stream, Vec::<u8>::new(), false),
        move |(mut stream, mut buffered, ended)| {
            let from = from.clone();
            let to = to.clone();
            async move {
                let mut ended = ended;
                loop {
                    if let Some(last_newline) = buffered.iter().rposition(|byte| *byte == b'\n') {
                        let remainder = buffered.split_off(last_newline + 1);
                        let ready = rewrite_sse_bytes(&buffered, &from, &to);
                        return Ok(Some((Bytes::from(ready), (stream, remainder, ended))));
                    }
                    if ended {
                        if buffered.is_empty() {
                            return Ok(None);
                        }
                        let ready = rewrite_sse_bytes(&buffered, &from, &to);
                        return Ok(Some((Bytes::from(ready), (stream, Vec::new(), true))));
                    }
                    if buffered.len() > 64 * 1024 {
                        let retained = from.len().saturating_sub(1).min(buffered.len());
                        let remainder = buffered.split_off(buffered.len() - retained);
                        let ready = rewrite_sse_bytes(&buffered, &from, &to);
                        return Ok(Some((Bytes::from(ready), (stream, remainder, false))));
                    }
                    match stream.next().await {
                        Some(Ok(chunk)) => buffered.extend_from_slice(&chunk),
                        Some(Err(error)) => return Err(error),
                        None => ended = true,
                    }
                }
            }
        },
    )
}

fn rewrite_sse_bytes(bytes: &[u8], from: &str, to: &str) -> Vec<u8> {
    let Ok(body) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    body.replace(from, to).into_bytes()
}

fn proxy_error(error: PreviewProxyError) -> Response {
    let (status, code) = match error {
        PreviewProxyError::UnknownLease => (StatusCode::NOT_FOUND, ErrorCode::NotFound),
        PreviewProxyError::WrongCapability => (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized),
        PreviewProxyError::ExpiredCapability => (StatusCode::GONE, ErrorCode::Conflict),
        PreviewProxyError::InvalidPath => (StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
        PreviewProxyError::UpstreamUnavailable => {
            (StatusCode::BAD_GATEWAY, ErrorCode::CapabilityUnavailable)
        }
    };
    (
        status,
        Json(ErrorEnvelope::new(
            code,
            error.to_string(),
            false,
            OperationId::new(),
        )),
    )
        .into_response()
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
