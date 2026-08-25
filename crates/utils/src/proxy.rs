//! OS and environment proxy detection for Host network requests.

#[cfg(unix)]
use std::process::Command;
use std::sync::OnceLock;

static INHERITED_PROXY: OnceLock<Option<String>> = OnceLock::new();

/// How a proxy URL was observed. PAC is reported but not applied process-wide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxySource {
    System,
    Env,
    Pac,
}

impl ProxySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Env => "env",
            Self::Pac => "pac",
        }
    }

    pub fn applies_to_process(self) -> bool {
        matches!(self, Self::System | Self::Env)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedProxy {
    pub url: String,
    pub source: ProxySource,
}

const ENV_PROXY_KEYS: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// Snapshot the process proxy env once, before VibeX overwrites it.
pub fn capture_inherited_proxy() {
    let _ = INHERITED_PROXY.get_or_init(env_proxy_url);
}

/// Best proxy currently advertised by the OS or the launching environment.
pub fn detect_proxy() -> Option<DetectedProxy> {
    if let Some(detected) = detect_os_proxy() {
        return Some(detected);
    }
    inherited_proxy_url().map(|url| DetectedProxy {
        url,
        source: ProxySource::Env,
    })
}

fn inherited_proxy_url() -> Option<String> {
    INHERITED_PROXY
        .get()
        .cloned()
        .flatten()
        .or_else(env_proxy_url)
}

pub fn env_proxy_url() -> Option<String> {
    for key in ENV_PROXY_KEYS {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Some(trimmed.to_string());
        }
    }
    None
}

fn detect_os_proxy() -> Option<DetectedProxy> {
    #[cfg(target_os = "macos")]
    {
        detect_macos_proxy()
    }
    #[cfg(windows)]
    {
        detect_windows_proxy()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        detect_gnome_proxy()
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn detect_macos_proxy() -> Option<DetectedProxy> {
    let output = Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()
        .filter(|result| result.status.success())?;
    parse_scutil_proxy(std::str::from_utf8(&output.stdout).ok()?)
}

#[cfg(windows)]
fn detect_windows_proxy() -> Option<DetectedProxy> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    let pac: String = key.get_value("AutoConfigURL").unwrap_or_default();
    parse_windows_proxy(enabled != 0, &server, &pac)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn detect_gnome_proxy() -> Option<DetectedProxy> {
    let mode = gsettings_value(&["get", "org.gnome.system.proxy", "mode"])?;
    match mode.trim_matches('\'') {
        "manual" => {
            let https = gnome_protocol_proxy("https");
            let http = gnome_protocol_proxy("http");
            let socks = gnome_protocol_proxy("socks");
            https.or(http).or(socks).map(|url| DetectedProxy {
                url,
                source: ProxySource::System,
            })
        }
        "auto" => gsettings_value(&["get", "org.gnome.system.proxy", "autoconfig-url"])
            .map(|url| url.trim_matches('\'').trim().to_string())
            .filter(|url| !url.is_empty())
            .map(|url| DetectedProxy {
                url,
                source: ProxySource::Pac,
            }),
        _ => None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn gnome_protocol_proxy(protocol: &str) -> Option<String> {
    let schema = format!("org.gnome.system.proxy.{protocol}");
    let host = gsettings_value(&["get", &schema, "host"])?
        .trim_matches('\'')
        .trim()
        .to_string();
    if host.is_empty() {
        return None;
    }
    let port = gsettings_value(&["get", &schema, "port"])?
        .rsplit(' ')
        .next()?
        .parse::<u16>()
        .ok()?;
    Some(format_proxy_url(
        if protocol == "socks" {
            "socks5"
        } else {
            "http"
        },
        &host,
        port,
    ))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn gsettings_value(args: &[&str]) -> Option<String> {
    let output = Command::new("gsettings")
        .args(args)
        .output()
        .ok()
        .filter(|result| result.status.success())?;
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn parse_scutil_proxy(text: &str) -> Option<DetectedProxy> {
    scutil_system_proxy(text, "HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http")
        .or_else(|| scutil_system_proxy(text, "HTTPEnable", "HTTPProxy", "HTTPPort", "http"))
        .or_else(|| scutil_system_proxy(text, "SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"))
        .or_else(|| {
            if !scutil_flag(text, "ProxyAutoConfigEnable") {
                return None;
            }
            let url = scutil_string(text, "ProxyAutoConfigURLString")?;
            (!url.is_empty()).then_some(DetectedProxy {
                url,
                source: ProxySource::Pac,
            })
        })
}

fn scutil_system_proxy(
    text: &str,
    flag: &str,
    host_key: &str,
    port_key: &str,
    scheme: &str,
) -> Option<DetectedProxy> {
    if !scutil_flag(text, flag) {
        return None;
    }
    scutil_endpoint(text, host_key, port_key, scheme).map(|url| DetectedProxy {
        url,
        source: ProxySource::System,
    })
}

pub fn parse_windows_proxy(enabled: bool, server: &str, pac: &str) -> Option<DetectedProxy> {
    if enabled && let Some(url) = parse_windows_proxy_server(server) {
        return Some(DetectedProxy {
            url,
            source: ProxySource::System,
        });
    }
    let pac = pac.trim();
    if pac.is_empty() {
        return None;
    }
    Some(DetectedProxy {
        url: pac.to_string(),
        source: ProxySource::Pac,
    })
}

pub fn parse_windows_proxy_server(server: &str) -> Option<String> {
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    if server.contains('=') {
        let mut http = None;
        let mut https = None;
        let mut socks = None;
        for part in server.split(';') {
            let Some((scheme, endpoint)) = part.split_once('=') else {
                continue;
            };
            let endpoint = endpoint.trim();
            if endpoint.is_empty() {
                continue;
            }
            match scheme.trim().to_ascii_lowercase().as_str() {
                "https" => https = Some(ensure_proxy_scheme(endpoint, "http")),
                "http" => http = Some(ensure_proxy_scheme(endpoint, "http")),
                "socks" | "socks5" => socks = Some(ensure_proxy_scheme(endpoint, "socks5")),
                _ => {}
            }
        }
        return https.or(http).or(socks);
    }
    Some(ensure_proxy_scheme(server, "http"))
}

fn scutil_flag(text: &str, key: &str) -> bool {
    scutil_string(text, key).is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn scutil_endpoint(text: &str, host_key: &str, port_key: &str, scheme: &str) -> Option<String> {
    let host = scutil_string(text, host_key)?;
    let port = scutil_string(text, port_key)?.parse::<u16>().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some(format_proxy_url(scheme, &host, port))
}

fn scutil_string(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        let Some((found_key, value)) = line.split_once(':') else {
            continue;
        };
        if found_key.trim() == key {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn format_proxy_url(scheme: &str, host: &str, port: u16) -> String {
    let host = host.trim().trim_matches(|ch| ch == '[' || ch == ']');
    if host.contains(':') && !host.starts_with('[') {
        format!("{scheme}://[{host}]:{port}")
    } else {
        format!("{scheme}://{host}:{port}")
    }
}

fn ensure_proxy_scheme(value: &str, default_scheme: &str) -> String {
    let value = value.trim();
    if value.contains("://") {
        return value.to_string();
    }
    if let Some((host, port)) = value.rsplit_once(':')
        && let Ok(port) = port.parse::<u16>()
    {
        return format_proxy_url(default_scheme, host, port);
    }
    format!("{default_scheme}://{value}")
}

#[cfg(test)]
mod tests {
    use super::{ProxySource, parse_scutil_proxy, parse_windows_proxy, parse_windows_proxy_server};

    const SCUTIL_HTTP: &str = r#"
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}
"#;

    const SCUTIL_SOCKS: &str = r#"
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
"#;

    const SCUTIL_PAC: &str = r#"
<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad.example/proxy.pac
}
"#;

    #[test]
    fn scutil_prefers_https_system_proxy() {
        let detected = parse_scutil_proxy(SCUTIL_HTTP).expect("http proxy");
        assert_eq!(detected.url, "http://127.0.0.1:7890");
        assert_eq!(detected.source, ProxySource::System);
        assert!(detected.source.applies_to_process());
    }

    #[test]
    fn scutil_uses_socks_when_http_is_off() {
        let detected = parse_scutil_proxy(SCUTIL_SOCKS).expect("socks proxy");
        assert_eq!(detected.url, "socks5://127.0.0.1:1080");
        assert_eq!(detected.source, ProxySource::System);
    }

    #[test]
    fn scutil_reports_pac_without_applying_it_as_http_proxy() {
        let detected = parse_scutil_proxy(SCUTIL_PAC).expect("pac");
        assert_eq!(detected.url, "http://wpad.example/proxy.pac");
        assert_eq!(detected.source, ProxySource::Pac);
        assert!(!detected.source.applies_to_process());
    }

    #[test]
    fn windows_single_server_becomes_http_url() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server("http://127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn windows_scheme_list_prefers_https() {
        assert_eq!(
            parse_windows_proxy_server(
                "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080"
            )
            .as_deref(),
            Some("http://127.0.0.1:7891")
        );
    }

    #[test]
    fn windows_disabled_manual_still_reports_pac() {
        let detected = parse_windows_proxy(false, "", "http://wpad.example/proxy.pac")
            .expect("pac from autoconfig");
        assert_eq!(detected.source, ProxySource::Pac);
        assert_eq!(detected.url, "http://wpad.example/proxy.pac");
    }
}
