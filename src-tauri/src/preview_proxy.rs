use std::sync::OnceLock;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use reqwest::Client;

static PROXY_PORT: OnceLock<u16> = OnceLock::new();

const BIPPY_BUNDLE: &str = include_str!("preview_proxy/bippy_bundle.js");
const CLICK_TO_COMPONENT_SCRIPT: &str =
    include_str!("preview_proxy/click_to_component_script.js");

pub async fn ensure_started() -> Result<(), String> {
    if PROXY_PORT.get().is_some() {
        return Ok(());
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Failed to bind preview proxy: {error}"))?;
    let proxy_port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read preview proxy port: {error}"))?
        .port();

    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Failed to build preview proxy client: {error}"))?;

    PROXY_PORT
        .set(proxy_port)
        .map_err(|_| "Preview proxy already started".to_string())?;

    let app = Router::new()
        .route("/", any(proxy_request))
        .route("/{*path}", any(proxy_request))
        .with_state(client);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("Preview proxy server exited: {}", error);
        }
    });

    Ok(())
}

pub fn build_proxy_url(raw_url: &str, proxy_port: u16) -> Option<String> {
    let parsed = reqwest::Url::parse(raw_url).ok()?;
    if parsed.scheme() != "http" {
        return None;
    }

    let host = parsed.host_str()?.to_ascii_lowercase();
    if !is_loopback_host(&host) {
        return None;
    }

    let target_port = parsed.port_or_known_default()?;
    let mut proxied = format!(
        "http://{}.localhost:{}{}",
        target_port,
        proxy_port,
        parsed.path()
    );

    if let Some(query) = parsed.query() {
        proxied.push('?');
        proxied.push_str(query);
    }

    if let Some(fragment) = parsed.fragment() {
        proxied.push('#');
        proxied.push_str(fragment);
    }

    Some(proxied)
}

pub fn get_proxy_url(raw_url: &str) -> Option<String> {
    build_proxy_url(raw_url, PROXY_PORT.get().copied()?)
}

pub fn parse_target_port_from_host(host: &str) -> Option<u16> {
    let host_without_port = host.split(':').next()?.trim();
    let prefix = host_without_port.split('.').next()?.trim();
    if prefix.is_empty() || prefix.eq_ignore_ascii_case("localhost") {
        return None;
    }

    prefix.parse::<u16>().ok()
}

async fn proxy_request(
    State(client): State<Client>,
    request: Request<Body>,
) -> Response<Body> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let Some(target_port) = parse_target_port_from_host(&host) else {
        return (
            StatusCode::BAD_REQUEST,
            "Preview proxy host must use {port}.localhost",
        )
            .into_response();
    };

    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let upstream_url = format!("http://127.0.0.1:{}{}", target_port, path_and_query);

    let request_headers = request.headers().clone();
    let request_method = request.method().clone();
    let request_body = match to_bytes(request.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("Failed to read preview request body: {error}"),
            )
                .into_response();
        }
    };

    let mut upstream_request = client
        .request(
            reqwest::Method::from_bytes(request_method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET),
            &upstream_url,
        )
        .body(request_body.to_vec())
        .header(reqwest::header::ACCEPT_ENCODING, "identity");

    for (name, value) in &request_headers {
        if should_strip_request_header(name.as_str()) {
            continue;
        }
        upstream_request = upstream_request.header(name, value);
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach preview server: {error}"),
            )
                .into_response();
        }
    };

    let status = upstream_response.status();
    let response_headers = upstream_response.headers().clone();
    let is_html = response_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false);

    let response_body = match upstream_response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to read preview response: {error}"),
            )
                .into_response();
        }
    };

    let body = if is_html {
        let html = String::from_utf8_lossy(&response_body).to_string();
        Body::from(inject_preview_scripts(&html))
    } else {
        Body::from(response_body.to_vec())
    };

    let mut response = Response::new(body);
    *response.status_mut() = status;

    copy_response_headers(
        response.headers_mut(),
        &response_headers,
        target_port,
        PROXY_PORT.get().copied(),
    );

    response
}

fn inject_preview_scripts(html: &str) -> String {
    let mut output = html.to_string();
    let lower = output.to_ascii_lowercase();
    let bippy_tag = format!("<script>{}</script>", BIPPY_BUNDLE);
    let inspect_tag = format!("<script>{}</script>", CLICK_TO_COMPONENT_SCRIPT);

    if let Some(head_pos) = lower.find("<head>") {
        let insert_pos = head_pos + "<head>".len();
        output.insert_str(insert_pos, &bippy_tag);
    } else {
        output = format!("{}{}", bippy_tag, output);
    }

    let lower = output.to_ascii_lowercase();
    if let Some(body_pos) = lower.rfind("</body>") {
        output.insert_str(body_pos, &inspect_tag);
    } else {
        output.push_str(&inspect_tag);
    }

    output
}

fn copy_response_headers(
    destination: &mut HeaderMap,
    source: &HeaderMap,
    target_port: u16,
    proxy_port: Option<u16>,
) {
    for (name, value) in source {
        if should_strip_response_header(name.as_str()) {
            continue;
        }

        if name == header::LOCATION {
            if let (Some(proxy_port), Ok(location)) = (proxy_port, value.to_str()) {
                if let Some(rewritten) = rewrite_location(location, target_port, proxy_port) {
                    if let Ok(header_value) = HeaderValue::from_str(&rewritten) {
                        destination.insert(name.clone(), header_value);
                        continue;
                    }
                }
            }
        }

        destination.insert(name.clone(), value.clone());
    }
}

fn rewrite_location(location: &str, target_port: u16, proxy_port: u16) -> Option<String> {
    let parsed = reqwest::Url::parse(location).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !is_loopback_host(&host) || parsed.port_or_known_default()? != target_port {
        return None;
    }

    build_proxy_url(location, proxy_port)
}

fn should_strip_request_header(header_name: &str) -> bool {
    matches!(
        header_name.to_ascii_lowercase().as_str(),
        "host" | "connection" | "content-length" | "accept-encoding"
    )
}

fn should_strip_response_header(header_name: &str) -> bool {
    matches!(
        header_name.to_ascii_lowercase().as_str(),
        "content-length"
            | "content-encoding"
            | "transfer-encoding"
            | "connection"
            | "content-security-policy"
            | "x-frame-options"
            | "cross-origin-opener-policy"
            | "cross-origin-embedder-policy"
    )
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1")
        || host.eq_ignore_ascii_case("tauri.localhost")
        || host.ends_with(".localhost")
}

#[cfg(test)]
mod tests {
    use super::{build_proxy_url, parse_target_port_from_host};

    #[test]
    fn builds_proxy_url_from_loopback_dev_server() {
        let proxied = build_proxy_url("http://localhost:3000/path?q=1", 43123).unwrap();
        assert_eq!(proxied, "http://3000.localhost:43123/path?q=1");
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        assert!(build_proxy_url("https://example.com/app", 43123).is_none());
    }

    #[test]
    fn parses_target_port_from_proxy_host() {
        assert_eq!(parse_target_port_from_host("3000.localhost:43123"), Some(3000));
        assert_eq!(parse_target_port_from_host("5173.localhost"), Some(5173));
        assert_eq!(parse_target_port_from_host("localhost:43123"), None);
    }

    #[test]
    fn accepts_tauri_localhost_as_loopback_host() {
        let proxied = build_proxy_url("http://tauri.localhost:3000/path", 43123).unwrap();
        assert_eq!(proxied, "http://3000.localhost:43123/path");
    }
}
