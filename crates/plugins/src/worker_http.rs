//! Shared validation for Host-managed HTTP MCP endpoints reported by Workers.

use serde_json::{Value, json};

/// `managedRuntime.kind = "workerHttp"` handler name, if this spec uses that path.
pub fn worker_http_handler(spec: &Value) -> Option<&str> {
    let managed = spec.get("managedRuntime")?.as_object()?;
    if managed.get("kind").and_then(Value::as_str) != Some("workerHttp") {
        return None;
    }
    managed.get("handler").and_then(Value::as_str).filter(|handler| !handler.is_empty())
}

/// Build a native `type: http` MCP spec from a Worker `mcp.endpoint` payload.
pub fn worker_http_mcp_spec_from_endpoint(value: &Value) -> Result<Value, String> {
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "mcp.endpoint must return url".to_owned())?;
    let authorization = value
        .get("headers")
        .and_then(Value::as_object)
        .and_then(|headers| headers.get("Authorization"))
        .and_then(Value::as_str)
        .ok_or_else(|| "mcp.endpoint must return headers.Authorization".to_owned())?;
    validate_loopback_mcp_url(url)?;
    if !authorization.starts_with("Bearer ") || authorization.len() < 16 {
        return Err("mcp.endpoint Authorization must be a Bearer token".to_owned());
    }
    Ok(json!({
        "type": "http",
        "url": url,
        "headers": { "Authorization": authorization }
    }))
}

pub fn validate_loopback_mcp_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "mcp url is invalid".to_owned())?;
    if parsed.scheme() != "http" {
        return Err("mcp url must be http on loopback".to_owned());
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "127.0.0.1" && host != "localhost" && host != "[::1]" && host != "::1" {
        return Err("mcp url must be 127.0.0.1 or [::1]".to_owned());
    }
    if host == "localhost" {
        return Err("mcp url must use 127.0.0.1, not localhost".to_owned());
    }
    if parsed.path() != "/mcp" {
        return Err("mcp url path must be /mcp".to_owned());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("mcp url must not include query or fragment".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_http_mcp() {
        let spec = worker_http_mcp_spec_from_endpoint(&json!({
            "url": "http://127.0.0.1:43111/mcp",
            "headers": { "Authorization": "Bearer test-token-value" }
        }))
        .expect("valid endpoint");
        assert_eq!(spec["type"], "http");
        assert_eq!(spec["url"], "http://127.0.0.1:43111/mcp");
    }

    #[test]
    fn rejects_non_loopback_and_stdio_shaped_payloads() {
        assert!(validate_loopback_mcp_url("https://127.0.0.1/mcp").is_err());
        assert!(validate_loopback_mcp_url("http://example.com/mcp").is_err());
        assert!(validate_loopback_mcp_url("http://localhost:9/mcp").is_err());
        assert!(validate_loopback_mcp_url("http://127.0.0.1:9/v1").is_err());
        assert!(worker_http_mcp_spec_from_endpoint(&json!({ "url": "http://127.0.0.1:9/mcp" })).is_err());
    }

    #[test]
    fn reads_worker_http_handler() {
        assert_eq!(
            worker_http_handler(&json!({
                "managedRuntime": { "kind": "workerHttp", "handler": "mcp.endpoint" }
            })),
            Some("mcp.endpoint")
        );
        assert_eq!(
            worker_http_handler(&json!({
                "managedRuntime": { "kind": "hostFamilyBinary", "handler": "mcp.endpoint" }
            })),
            None
        );
    }
}
