use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use futures::TryStreamExt;
use reqwest::{Client, Response as UpstreamResponse};

static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static PREFERRED_LOOPBACK_HOSTS: OnceLock<Mutex<HashMap<u16, String>>> = OnceLock::new();

const BIPPY_BUNDLE: &str = include_str!("preview_proxy/bippy_bundle.js");
const CLICK_TO_COMPONENT_SCRIPT: &str = include_str!("preview_proxy/click_to_component_script.js");
const BRIDGE_TOKEN_QUERY_PARAM: &str = "__vibex_bridge_token";

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
        .connect_timeout(Duration::from_millis(250))
        .no_proxy()
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

pub fn build_proxy_url(
    raw_url: &str,
    proxy_port: u16,
    bridge_token: Option<&str>,
) -> Option<String> {
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

    let mut proxied_url = reqwest::Url::parse(&proxied).ok()?;
    if let Some(bridge_token) = bridge_token.filter(|token| !token.is_empty()) {
        proxied_url
            .query_pairs_mut()
            .append_pair(BRIDGE_TOKEN_QUERY_PARAM, bridge_token);
    }

    Some(proxied_url.to_string())
}

pub fn get_proxy_url(raw_url: &str, bridge_token: Option<&str>) -> Option<String> {
    build_proxy_url(raw_url, PROXY_PORT.get().copied()?, bridge_token)
}

pub fn parse_target_port_from_host(host: &str) -> Option<u16> {
    let host_without_port = host.split(':').next()?.trim();
    let prefix = host_without_port.split('.').next()?.trim();
    if prefix.is_empty() || prefix.eq_ignore_ascii_case("localhost") {
        return None;
    }

    prefix.parse::<u16>().ok()
}

async fn proxy_request(State(client): State<Client>, request: Request<Body>) -> Response<Body> {
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
    let upstream_path_and_query = strip_bridge_token_from_path_query(path_and_query);
    let upstream_urls = build_upstream_url_candidates(target_port, &upstream_path_and_query);

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

    let upstream_response = match send_upstream_request(
        &client,
        target_port,
        &request_method,
        &request_headers,
        request_body.to_vec(),
        &upstream_urls,
    )
    .await
    {
        Ok(response) => response,
        Err(errors) => {
            if should_fallback_to_raw_preview(&request_method, &request_headers)
                && let Some(raw_url) = upstream_urls.first()
                && let Ok(location) = HeaderValue::from_str(raw_url)
            {
                let mut response = Response::new(Body::empty());
                *response.status_mut() = StatusCode::TEMPORARY_REDIRECT;
                response.headers_mut().insert(header::LOCATION, location);
                return response;
            }

            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach preview server: {}", errors.join("; ")),
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

    if !is_html {
        let mut response = Response::new(Body::from_stream(
            upstream_response
                .bytes_stream()
                .map_err(|error| std::io::Error::other(error.to_string())),
        ));
        *response.status_mut() = status;

        copy_response_headers(
            response.headers_mut(),
            &response_headers,
            target_port,
            PROXY_PORT.get().copied(),
        );

        return response;
    }

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

    let html = String::from_utf8_lossy(&response_body).to_string();
    let body = Body::from(inject_preview_scripts(&html));

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

fn build_upstream_url_candidates(target_port: u16, path_and_query: &str) -> Vec<String> {
    build_upstream_host_candidates(target_port)
        .into_iter()
        .map(|host| format!("http://{host}:{target_port}{path_and_query}"))
        .collect()
}

fn build_upstream_host_candidates(target_port: u16) -> Vec<String> {
    let preferred = preferred_loopback_hosts()
        .lock()
        .ok()
        .and_then(|hosts| hosts.get(&target_port).cloned());
    let mut candidates = Vec::with_capacity(2);

    if let Some(preferred) = preferred {
        candidates.push(preferred);
    }

    for host in ["127.0.0.1", "localhost"] {
        if !candidates.iter().any(|candidate| candidate == host) {
            candidates.push(host.to_string());
        }
    }

    candidates
}

fn preferred_loopback_hosts() -> &'static Mutex<HashMap<u16, String>> {
    PREFERRED_LOOPBACK_HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_successful_upstream_host(target_port: u16, url: &str) {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return;
    };
    let Some(host) = parsed.host_str() else {
        return;
    };
    if !matches!(host, "127.0.0.1" | "localhost") {
        return;
    }

    if let Ok(mut hosts) = preferred_loopback_hosts().lock() {
        hosts.insert(target_port, host.to_string());
    }
}

async fn send_upstream_request(
    client: &Client,
    target_port: u16,
    method: &Method,
    headers: &HeaderMap,
    body: Vec<u8>,
    urls: &[String],
) -> Result<UpstreamResponse, Vec<String>> {
    let mut errors = Vec::new();

    for url in urls {
        match build_upstream_request(client, method, headers, body.clone(), url)
            .send()
            .await
        {
            Ok(response) => {
                remember_successful_upstream_host(target_port, url);
                return Ok(response);
            }
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }

    Err(errors)
}

fn build_upstream_request(
    client: &Client,
    method: &Method,
    headers: &HeaderMap,
    body: Vec<u8>,
    url: &str,
) -> reqwest::RequestBuilder {
    let mut upstream_request = client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            url,
        )
        .body(body)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");

    for (name, value) in headers {
        if should_strip_request_header(name.as_str()) {
            continue;
        }
        if name == header::REFERER {
            if let Ok(referer) = value.to_str()
                && let Some(rewritten) = strip_bridge_token_from_absolute_url(referer)
                && let Ok(header_value) = HeaderValue::from_str(&rewritten)
            {
                upstream_request = upstream_request.header(name, header_value);
            }
            continue;
        }
        upstream_request = upstream_request.header(name, value);
    }

    upstream_request
}

fn should_fallback_to_raw_preview(method: &Method, headers: &HeaderMap) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && headers
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_ascii_lowercase().contains("text/html"))
            .unwrap_or(false)
}

fn inject_preview_scripts(html: &str) -> String {
    let mut output = html.to_string();
    let lower = output.to_ascii_lowercase();
    let bippy_tag = format!("<script>{}</script>", BIPPY_BUNDLE);
    let inspect_tag = format!("<script>{}</script>", CLICK_TO_COMPONENT_SCRIPT);

    if let Some(head_pos) = lower.find("<head>") {
        let insert_pos = head_pos + "<head>".len();
        output.insert_str(insert_pos, &format!("{}{}", bippy_tag, inspect_tag));
    } else {
        output = format!("{}{}{}", bippy_tag, inspect_tag, output);
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

        if name == header::LOCATION
            && let (Some(proxy_port), Ok(location)) = (proxy_port, value.to_str())
            && let Some(rewritten) = rewrite_location(location, target_port, proxy_port)
            && let Ok(header_value) = HeaderValue::from_str(&rewritten)
        {
            destination.insert(name.clone(), header_value);
            continue;
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

    build_proxy_url(location, proxy_port, None)
}

fn strip_bridge_token_from_path_query(path_and_query: &str) -> String {
    let Some((path, _query)) = path_and_query.split_once('?') else {
        return path_and_query.to_string();
    };

    let Ok(mut parsed) = reqwest::Url::parse(&format!("http://preview.localhost{path_and_query}"))
    else {
        return path_and_query.to_string();
    };

    let filtered_pairs = parsed
        .query_pairs()
        .filter(|(key, _)| key != BRIDGE_TOKEN_QUERY_PARAM)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();

    parsed.set_query(None);
    {
        let mut pairs = parsed.query_pairs_mut();
        for (key, value) in filtered_pairs {
            pairs.append_pair(&key, &value);
        }
    }

    let filtered_query = parsed.query().unwrap_or_default();

    if filtered_query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{filtered_query}")
    }
}

fn strip_bridge_token_from_absolute_url(raw_url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(raw_url).ok()?;
    let filtered_pairs = parsed
        .query_pairs()
        .filter(|(key, _)| key != BRIDGE_TOKEN_QUERY_PARAM)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();

    parsed.set_query(None);
    {
        let mut pairs = parsed.query_pairs_mut();
        for (key, value) in filtered_pairs {
            pairs.append_pair(&key, &value);
        }
    }

    Some(parsed.to_string())
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
    use axum::http::{HeaderMap, Method, header};

    use super::{
        build_proxy_url, build_upstream_url_candidates, parse_target_port_from_host,
        remember_successful_upstream_host, should_fallback_to_raw_preview,
        strip_bridge_token_from_absolute_url, strip_bridge_token_from_path_query,
    };

    #[test]
    fn builds_proxy_url_from_loopback_dev_server() {
        let proxied = build_proxy_url("http://localhost:3000/path?q=1", 43123, None).unwrap();
        assert_eq!(proxied, "http://3000.localhost:43123/path?q=1");
    }

    #[test]
    fn adds_bridge_token_to_proxy_url() {
        let proxied =
            build_proxy_url("http://localhost:3000/path?q=1", 43123, Some("a&b=c#d")).unwrap();
        assert_eq!(
            proxied,
            "http://3000.localhost:43123/path?q=1&__vibex_bridge_token=a%26b%3Dc%23d"
        );
    }

    #[test]
    fn rejects_non_loopback_hosts() {
        assert!(build_proxy_url("https://example.com/app", 43123, None).is_none());
    }

    #[test]
    fn parses_target_port_from_proxy_host() {
        assert_eq!(
            parse_target_port_from_host("3000.localhost:43123"),
            Some(3000)
        );
        assert_eq!(parse_target_port_from_host("5173.localhost"), Some(5173));
        assert_eq!(parse_target_port_from_host("localhost:43123"), None);
    }

    #[test]
    fn accepts_tauri_localhost_as_loopback_host() {
        let proxied = build_proxy_url("http://tauri.localhost:3000/path", 43123, None).unwrap();
        assert_eq!(proxied, "http://3000.localhost:43123/path");
    }

    #[test]
    fn strips_bridge_token_before_proxying_upstream() {
        assert_eq!(
            strip_bridge_token_from_path_query("/app?q=1&__vibex_bridge_token=abc&x=2"),
            "/app?q=1&x=2"
        );
        assert_eq!(
            strip_bridge_token_from_path_query("/app?__vibex_bridge_token=abc"),
            "/app"
        );
        assert_eq!(
            strip_bridge_token_from_path_query("/app?x=1&__vibex_bridge_token=a%26b%3Dc%23d"),
            "/app?x=1"
        );
    }

    #[test]
    fn strips_bridge_token_from_referer_url() {
        assert_eq!(
            strip_bridge_token_from_absolute_url(
                "http://3000.localhost:43123/app?q=1&__vibex_bridge_token=abc#section"
            )
            .as_deref(),
            Some("http://3000.localhost:43123/app?q=1#section")
        );
    }

    #[test]
    fn tries_multiple_loopback_hosts_for_preview_requests() {
        assert_eq!(
            build_upstream_url_candidates(5173, "/app?q=1"),
            vec![
                "http://127.0.0.1:5173/app?q=1".to_string(),
                "http://localhost:5173/app?q=1".to_string()
            ]
        );
    }

    #[test]
    fn prefers_the_last_successful_loopback_host_for_a_port() {
        remember_successful_upstream_host(61234, "http://localhost:61234/app");

        assert_eq!(
            build_upstream_url_candidates(61234, "/chunk.js")[0],
            "http://localhost:61234/chunk.js"
        );
    }

    #[test]
    fn falls_back_to_raw_url_only_for_html_navigation_requests() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT,
            "text/html,application/xhtml+xml".parse().unwrap(),
        );

        assert!(should_fallback_to_raw_preview(&Method::GET, &headers));
        assert!(should_fallback_to_raw_preview(&Method::HEAD, &headers));
        assert!(!should_fallback_to_raw_preview(&Method::POST, &headers));

        headers.insert(header::ACCEPT, "text/css,*/*".parse().unwrap());
        assert!(!should_fallback_to_raw_preview(&Method::GET, &headers));
    }
}
