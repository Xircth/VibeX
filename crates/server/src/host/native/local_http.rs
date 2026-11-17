use std::{net::IpAddr, time::Duration};

pub fn is_local_or_lan_url(url: &url::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let lower = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        return true;
    }
    let Ok(ip) = lower.parse::<IpAddr>() else {
        return false;
    };
    is_local_or_lan_ip(ip)
}

fn is_local_or_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_local_or_lan_ip(IpAddr::V4(mapped));
            }
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
    }
}

pub fn client_for_url(url: &url::Url, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if is_local_or_lan_url(url) {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|error| format!("初始化 HTTP 客户端失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_local_and_lan_hosts() {
        for raw in [
            "http://localhost:11434/v1",
            "http://api.localhost/v1",
            "http://ollama.local/v1",
            "http://llm.internal/v1",
            "http://127.0.0.1:8080/v1",
            "http://10.0.0.5:8000/v1",
            "http://172.16.1.2:8000/v1",
            "http://172.31.255.4:8000/v1",
            "http://192.168.1.50:1234/v1",
            "http://169.254.1.1:8000/v1",
            "http://[::1]:8000/v1",
            "http://[fd00::1]:8000/v1",
            "http://[fe80::1]:8000/v1",
            "http://[::ffff:192.168.1.10]:8000/v1",
        ] {
            let parsed = url::Url::parse(raw).expect("valid url");
            assert!(is_local_or_lan_url(&parsed), "expected local/LAN: {raw}");
        }

        for raw in [
            "https://api.openai.com/v1",
            "https://api.anthropic.com",
            "http://172.15.0.1:8000/v1",
            "http://172.32.0.1:8000/v1",
            "http://8.8.8.8/v1",
        ] {
            let parsed = url::Url::parse(raw).expect("valid url");
            assert!(!is_local_or_lan_url(&parsed), "expected public: {raw}");
        }
    }
}
