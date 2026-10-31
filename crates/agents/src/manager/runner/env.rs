use super::*;

pub(in crate::manager) fn wire_mcp_offer(capabilities: &AcpCapabilitySnapshot) -> WireMcpOffer {
    WireMcpOffer {
        stdio: capabilities.mcp_stdio,
        http: capabilities.mcp_http,
        sse: capabilities.mcp_sse,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::manager) struct WireMcpOffer {
    pub(in crate::manager) stdio: bool,
    pub(in crate::manager) http: bool,
    pub(in crate::manager) sse: bool,
}

pub(in crate::manager) const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

pub(in crate::manager) const PROXY_URL_FORWARD_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

pub(in crate::manager) fn merged_agent_env(
    configured_env: &HashMap<String, String>,
) -> HashMap<String, String> {
    merge_agent_env(configured_env, forwarded_proxy_env())
}

pub(in crate::manager) fn forwarded_proxy_env() -> Vec<(String, String)> {
    let from_process: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| PROXY_ENV_KEYS.contains(&key.as_str()))
        .filter(|(_, value)| !value.trim().is_empty())
        .collect();
    // Only forward proxy vars that actually have a value. An empty
    // `HTTPS_PROXY=""` inherited from the parent shell makes the agent's
    // HTTP client (reqwest) treat the proxy as misconfigured and fail the
    // request outright — so a blank proxy must not be propagated.
    if proxy_url_env_present(&from_process) {
        return from_process;
    }
    let mut env = proxy_env_from_detected(detect_proxy().as_ref());
    env.extend(from_process);
    env
}

pub(in crate::manager) fn proxy_url_env_present(env: &[(String, String)]) -> bool {
    env.iter().any(|(key, _)| {
        PROXY_URL_FORWARD_KEYS
            .iter()
            .any(|forward| key.eq_ignore_ascii_case(forward))
    })
}

pub(in crate::manager) fn proxy_env_from_detected(
    detected: Option<&DetectedProxy>,
) -> Vec<(String, String)> {
    let Some(detected) = detected else {
        return Vec::new();
    };
    if !detected.source.applies_to_process() {
        return Vec::new();
    }
    let url = detected.url.trim();
    if url.is_empty() {
        return Vec::new();
    }
    PROXY_URL_FORWARD_KEYS
        .iter()
        .map(|key| ((*key).to_string(), url.to_string()))
        .collect()
}

pub(in crate::manager) fn merge_agent_env(
    configured_env: &HashMap<String, String>,
    proxy_env: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut env = HashMap::from([
        ("NPM_CONFIG_LOGLEVEL".to_string(), "error".to_string()),
        ("NODE_NO_WARNINGS".to_string(), "1".to_string()),
    ]);
    env.extend(configured_env.clone());
    env.extend(proxy_env);
    env
}
