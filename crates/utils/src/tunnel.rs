//! Public tunnel endpoints used as Host Reachability.

use std::net::IpAddr;

pub const DEFAULT_TUNNEL_PORT: u16 = 443;
pub const TUNNEL_INSTALL_URL: &str = "https://vibex.xforever.xin/tunnel.sh";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn parse_tunnel_endpoint(input: &str, default_port: u16) -> Result<TunnelEndpoint, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Tunnel address is required".to_string());
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .trim();
    if authority.is_empty() {
        return Err("Tunnel address is required".to_string());
    }

    let (host, port) = split_host_port(authority, default_port)?;
    if host.is_empty() {
        return Err("Tunnel host is required".to_string());
    }
    Ok(TunnelEndpoint { host, port })
}

fn split_host_port(authority: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, remainder) = rest
            .split_once(']')
            .ok_or_else(|| "Invalid IPv6 tunnel address".to_string())?;
        if remainder.is_empty() {
            return Ok((host.to_string(), default_port));
        }
        let port = remainder
            .strip_prefix(':')
            .ok_or_else(|| "Invalid IPv6 tunnel address".to_string())?;
        return Ok((host.to_string(), parse_port(port)?));
    }
    if authority.chars().filter(|ch| *ch == ':').count() == 1
        && let Some((host, port)) = authority.rsplit_once(':')
    {
        return Ok((host.to_string(), parse_port(port)?));
    }
    Ok((authority.to_string(), default_port))
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| "Tunnel port must be between 1 and 65535".to_string())?;
    if port == 0 {
        return Err("Tunnel port must be between 1 and 65535".to_string());
    }
    Ok(port)
}

/// Origins to try when checking an existing tunnel, preferred first.
pub fn probe_origins(endpoint: &TunnelEndpoint, scheme_hint: Option<&str>) -> Vec<String> {
    let mut origins = Vec::new();
    let push = |origins: &mut Vec<String>, origin: String| {
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    };
    match scheme_hint {
        Some("http") => push(&mut origins, format_origin("http", endpoint)),
        Some("https") => push(&mut origins, format_origin("https", endpoint)),
        _ => {
            if endpoint.port == 80 {
                push(&mut origins, format_origin("http", endpoint));
            } else if endpoint.port == 443 {
                push(&mut origins, format_origin("https", endpoint));
                push(&mut origins, format_origin("http", endpoint));
            } else {
                push(&mut origins, format_origin("http", endpoint));
                push(&mut origins, format_origin("https", endpoint));
            }
        }
    }
    origins
}

pub fn format_origin(scheme: &str, endpoint: &TunnelEndpoint) -> String {
    let host = display_host(&endpoint.host);
    match (scheme, endpoint.port) {
        ("https", 443) | ("http", 80) => format!("{scheme}://{host}"),
        _ => format!("{scheme}://{host}:{}", endpoint.port),
    }
}

pub fn display_host(host: &str) -> String {
    if host.parse::<IpAddr>().ok().is_some_and(|ip| ip.is_ipv6()) && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn install_command(token: &str, port: u16) -> String {
    let sudo = if port < 1024 { "sudo " } else { "" };
    format!("curl -fsSL {TUNNEL_INSTALL_URL} | {sudo}sh -s -- -t {token} -p {port}")
}

pub fn extract_relay_token(input: &str) -> Option<String> {
    input.split_whitespace().find_map(|part| {
        let value = part.trim_matches(|ch| ch == '"' || ch == '\'');
        let rest = value.strip_prefix("vbx_tun_")?;
        if rest.len() == 32 && rest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Some(value.to_string())
        } else {
            None
        }
    })
}

pub fn scheme_hint_from_input(input: &str) -> Option<&'static str> {
    let lowered = input.trim().to_ascii_lowercase();
    if lowered.starts_with("https://") {
        Some("https")
    } else if lowered.starts_with("http://") {
        Some("http")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_TUNNEL_PORT, TunnelEndpoint, extract_relay_token, format_origin, install_command,
        parse_tunnel_endpoint, probe_origins, scheme_hint_from_input,
    };

    #[test]
    fn blank_input_is_rejected() {
        assert!(parse_tunnel_endpoint("  ", DEFAULT_TUNNEL_PORT).is_err());
    }

    #[test]
    fn host_without_port_defaults_to_443() {
        assert_eq!(
            parse_tunnel_endpoint("gate.example.com", DEFAULT_TUNNEL_PORT).unwrap(),
            TunnelEndpoint {
                host: "gate.example.com".to_string(),
                port: 443,
            }
        );
    }

    #[test]
    fn host_and_port_are_split() {
        assert_eq!(
            parse_tunnel_endpoint("203.0.113.10:8443", DEFAULT_TUNNEL_PORT).unwrap(),
            TunnelEndpoint {
                host: "203.0.113.10".to_string(),
                port: 8443,
            }
        );
    }

    #[test]
    fn scheme_and_path_are_stripped() {
        assert_eq!(
            parse_tunnel_endpoint("https://gate.example.com:8443/unused", 443).unwrap(),
            TunnelEndpoint {
                host: "gate.example.com".to_string(),
                port: 8443,
            }
        );
    }

    #[test]
    fn ipv6_host_keeps_brackets_in_origin() {
        let endpoint = parse_tunnel_endpoint("[2001:db8::1]", 443).unwrap();
        assert_eq!(endpoint.host, "2001:db8::1");
        assert_eq!(format_origin("https", &endpoint), "https://[2001:db8::1]");
    }

    #[test]
    fn probe_origins_prefer_https_on_443() {
        let endpoint = parse_tunnel_endpoint("gate.example.com", 443).unwrap();
        assert_eq!(
            probe_origins(&endpoint, None),
            vec![
                "https://gate.example.com".to_string(),
                "http://gate.example.com:443".to_string(),
            ]
        );
    }

    #[test]
    fn http_scheme_hint_skips_https() {
        let endpoint = parse_tunnel_endpoint("http://203.0.113.10:8080", 443).unwrap();
        assert_eq!(
            scheme_hint_from_input("http://203.0.113.10:8080"),
            Some("http")
        );
        assert_eq!(
            probe_origins(&endpoint, Some("http")),
            vec!["http://203.0.113.10:8080".to_string()]
        );
    }

    #[test]
    fn probe_origins_prefer_http_on_custom_ports() {
        let endpoint = parse_tunnel_endpoint("203.0.113.10:13630", 443).unwrap();
        assert_eq!(
            probe_origins(&endpoint, None),
            vec![
                "http://203.0.113.10:13630".to_string(),
                "https://203.0.113.10:13630".to_string(),
            ]
        );
    }

    #[test]
    fn extract_relay_token_from_install_command() {
        assert_eq!(
            extract_relay_token(
                "curl -fsSL https://vibex.xforever.xin/tunnel.sh | sh -s -- -t vbx_tun_e22cd3763db1436f847e709d79b3f9f9 -p 13630"
            )
            .as_deref(),
            Some("vbx_tun_e22cd3763db1436f847e709d79b3f9f9")
        );
        assert_eq!(extract_relay_token("47.109.140.92:13630"), None);
    }

    #[test]
    fn install_command_uses_sudo_for_privileged_ports() {
        assert_eq!(
            install_command("tok_abc", 443),
            "curl -fsSL https://vibex.xforever.xin/tunnel.sh | sudo sh -s -- -t tok_abc -p 443"
        );
        assert_eq!(
            install_command("tok_abc", 8443),
            "curl -fsSL https://vibex.xforever.xin/tunnel.sh | sh -s -- -t tok_abc -p 8443"
        );
    }
}
