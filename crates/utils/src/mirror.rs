//! Proxy-aware official/mirror URL resolution and fallback ordering.
//!
//! Routing policy:
//! - When an active proxy is detected or manually configured, try official
//!   upstream sources first, then public mirrors, then `mirror.dimo-ai.com`.
//! - When no active proxy is present, try verified public China mirrors first
//!   (where available), then `mirror.dimo-ai.com`, then official upstream as a
//!   last-resort fallback.

use crate::proxy::{has_active_proxy, refresh_auto_proxy_env};

pub const DIMO_MIRROR_ORIGIN: &str = "https://mirror.dimo-ai.com";

pub const OFFICIAL_NPM_REGISTRY: &str = "https://registry.npmjs.org";
pub const PUBLIC_NPM_MIRROR_REGISTRY: &str = "https://registry.npmmirror.com";
pub const DIMO_NPM_MIRROR_REGISTRY: &str = "https://mirror.dimo-ai.com/npm";

pub const OFFICIAL_ACP_REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
pub const DIMO_ACP_REGISTRY_URL: &str =
    "https://mirror.dimo-ai.com/acp-registry/v1/latest/registry.json";
pub const OFFICIAL_ACP_ICON_PREFIX: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/";
pub const DIMO_ACP_ICON_PREFIX: &str = "https://mirror.dimo-ai.com/acp-registry/v1/latest/";

pub const OFFICIAL_PYPI_INDEX: &str = "https://pypi.org/simple";
pub const PUBLIC_PYPI_TUNA_INDEX: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
pub const PUBLIC_PYPI_ALIYUN_INDEX: &str = "https://mirrors.aliyun.com/pypi/simple/";
pub const DIMO_PYPI_INDEX: &str = "https://mirror.dimo-ai.com/pypi/simple";

pub const PUBLIC_PYTHON_STANDALONE_MIRROR: &str =
    "https://registry.npmmirror.com/-/binary/python-build-standalone";
pub const DIMO_PYTHON_STANDALONE_MIRROR: &str =
    "https://mirror.dimo-ai.com/dl/github/astral-sh/python-build-standalone/releases/download";

/// Canonical upstream prefix -> `mirror.dimo-ai.com` prefix pairs.
const BINARY_MIRROR_PREFIXES: &[(&str, &str)] = &[
    (
        "https://github.com/",
        "https://mirror.dimo-ai.com/dl/github/",
    ),
    (
        "https://dl.google.com/",
        "https://mirror.dimo-ai.com/dl/google/",
    ),
    (
        "https://downloads.cursor.com/",
        "https://mirror.dimo-ai.com/dl/cursor/",
    ),
    (
        "https://prod.download.cli.kiro.dev/",
        "https://mirror.dimo-ai.com/dl/kiro-prod/",
    ),
    (
        "https://cli.kiro.dev/",
        "https://mirror.dimo-ai.com/dl/kiro-cli/",
    ),
    (
        "https://nodejs.org/",
        "https://mirror.dimo-ai.com/dl/nodejs/",
    ),
    (
        "https://opencode.ai/",
        "https://mirror.dimo-ai.com/dl/opencode/",
    ),
    (
        "https://downloads.poolside.ai/",
        "https://mirror.dimo-ai.com/dl/poolside/",
    ),
    (
        "https://static.devin.ai/",
        "https://mirror.dimo-ai.com/dl/devin/",
    ),
    (
        "https://sfc-repo.snowflakecomputing.com/",
        "https://mirror.dimo-ai.com/dl/snowflake/",
    ),
    (
        "https://lookaside.facebook.com/",
        "https://mirror.dimo-ai.com/dl/facebook/",
    ),
    (
        "https://cdn.agentclientprotocol.com/registry/",
        "https://mirror.dimo-ai.com/acp-registry/",
    ),
];

/// Re-syncs auto-mode OS proxy env vars if needed and returns whether an active
/// proxy is in effect for network routing.
pub fn proxy_is_active() -> bool {
    refresh_auto_proxy_env();
    has_active_proxy()
}

fn push_unique(list: &mut Vec<String>, candidate: String) {
    if !list.iter().any(|existing| existing == &candidate) {
        list.push(candidate);
    }
}

pub fn acp_registry_urls() -> Vec<&'static str> {
    acp_registry_urls_for_proxy(proxy_is_active())
}

pub fn acp_registry_urls_for_proxy(proxy_active: bool) -> Vec<&'static str> {
    if proxy_active {
        vec![OFFICIAL_ACP_REGISTRY_URL, DIMO_ACP_REGISTRY_URL]
    } else {
        vec![DIMO_ACP_REGISTRY_URL, OFFICIAL_ACP_REGISTRY_URL]
    }
}

pub fn acp_icon_url_candidates(url: &str) -> Vec<String> {
    acp_icon_url_candidates_for_proxy(url, proxy_is_active())
}

pub fn acp_icon_url_candidates_for_proxy(url: &str, proxy_active: bool) -> Vec<String> {
    let suffix = url
        .strip_prefix(OFFICIAL_ACP_ICON_PREFIX)
        .or_else(|| url.strip_prefix(DIMO_ACP_ICON_PREFIX));
    let Some(suffix) = suffix else {
        return vec![url.to_string()];
    };
    let official = format!("{OFFICIAL_ACP_ICON_PREFIX}{suffix}");
    let mirror = format!("{DIMO_ACP_ICON_PREFIX}{suffix}");
    if proxy_active {
        vec![official, mirror]
    } else {
        vec![mirror, official]
    }
}

pub fn npm_registry_candidates() -> Vec<&'static str> {
    npm_registry_candidates_for_proxy(proxy_is_active())
}

pub fn npm_registry_candidates_for_proxy(proxy_active: bool) -> Vec<&'static str> {
    if proxy_active {
        vec![
            OFFICIAL_NPM_REGISTRY,
            PUBLIC_NPM_MIRROR_REGISTRY,
            DIMO_NPM_MIRROR_REGISTRY,
        ]
    } else {
        vec![
            PUBLIC_NPM_MIRROR_REGISTRY,
            DIMO_NPM_MIRROR_REGISTRY,
            OFFICIAL_NPM_REGISTRY,
        ]
    }
}

/// Ordered candidate URLs for fetching an npm `dist.tarball`. Keeps `url` first
/// because it already comes from the registry whose metadata succeeded, then
/// appends alternate mirrors/official if applicable.
pub fn npm_tarball_url_candidates(url: &str) -> Vec<String> {
    npm_tarball_url_candidates_for_proxy(url, proxy_is_active())
}

pub fn npm_tarball_url_candidates_for_proxy(url: &str, proxy_active: bool) -> Vec<String> {
    let mut candidates = vec![url.to_string()];
    let suffix = url
        .strip_prefix(&format!("{OFFICIAL_NPM_REGISTRY}/"))
        .or_else(|| url.strip_prefix(&format!("{DIMO_NPM_MIRROR_REGISTRY}/")));
    if let Some(rest) = suffix {
        for base in npm_registry_candidates_for_proxy(proxy_active) {
            if base != PUBLIC_NPM_MIRROR_REGISTRY {
                push_unique(&mut candidates, format!("{base}/{rest}"));
            }
        }
    }
    candidates
}

pub fn node_download_url_candidates(version: &str, archive_name: &str) -> Vec<String> {
    node_download_url_candidates_for_proxy(version, archive_name, proxy_is_active())
}

pub fn node_download_url_candidates_for_proxy(
    version: &str,
    archive_name: &str,
    proxy_active: bool,
) -> Vec<String> {
    let official = format!("https://nodejs.org/dist/v{version}/{archive_name}");
    let cdn_npmmirror = format!("https://cdn.npmmirror.com/binaries/node/v{version}/{archive_name}");
    let npmmirror = format!("https://npmmirror.com/mirrors/node/v{version}/{archive_name}");
    let dimo_mirror = format!("{DIMO_MIRROR_ORIGIN}/dl/nodejs/dist/v{version}/{archive_name}");
    if proxy_active {
        vec![official, cdn_npmmirror, npmmirror, dimo_mirror]
    } else {
        vec![cdn_npmmirror, npmmirror, dimo_mirror, official]
    }
}

pub fn uv_download_url_candidates(version: &str, archive_name: &str) -> Vec<String> {
    uv_download_url_candidates_for_proxy(version, archive_name, proxy_is_active())
}

pub fn uv_download_url_candidates_for_proxy(
    version: &str,
    archive_name: &str,
    proxy_active: bool,
) -> Vec<String> {
    let official =
        format!("https://github.com/astral-sh/uv/releases/download/{version}/{archive_name}");
    let dimo_mirror = format!(
        "{DIMO_MIRROR_ORIGIN}/dl/github/astral-sh/uv/releases/download/{version}/{archive_name}"
    );
    if proxy_active {
        vec![official, dimo_mirror]
    } else {
        vec![dimo_mirror, official]
    }
}

pub fn bun_download_url_candidates(version: &str, archive_name: &str) -> Vec<String> {
    bun_download_url_candidates_for_proxy(version, archive_name, proxy_is_active())
}

pub fn bun_download_url_candidates_for_proxy(
    version: &str,
    archive_name: &str,
    proxy_active: bool,
) -> Vec<String> {
    let official =
        format!("https://github.com/oven-sh/bun/releases/download/bun-v{version}/{archive_name}");
    let npmmirror = format!("https://npmmirror.com/mirrors/bun/bun-v{version}/{archive_name}");
    let dimo_mirror = format!(
        "{DIMO_MIRROR_ORIGIN}/dl/github/oven-sh/bun/releases/download/bun-v{version}/{archive_name}"
    );
    if proxy_active {
        vec![official, npmmirror, dimo_mirror]
    } else {
        vec![npmmirror, dimo_mirror, official]
    }
}

/// Ordered `(pypi_default_index, optional_uv_python_install_mirror)` pairs for
/// `uv tool install`.
pub fn uv_install_mirror_candidates() -> Vec<(&'static str, Option<&'static str>)> {
    uv_install_mirror_candidates_for_proxy(proxy_is_active())
}

pub fn uv_install_mirror_candidates_for_proxy(
    proxy_active: bool,
) -> Vec<(&'static str, Option<&'static str>)> {
    if proxy_active {
        vec![
            (OFFICIAL_PYPI_INDEX, None),
            (
                PUBLIC_PYPI_TUNA_INDEX,
                Some(PUBLIC_PYTHON_STANDALONE_MIRROR),
            ),
            (DIMO_PYPI_INDEX, Some(DIMO_PYTHON_STANDALONE_MIRROR)),
        ]
    } else {
        vec![
            (
                PUBLIC_PYPI_TUNA_INDEX,
                Some(PUBLIC_PYTHON_STANDALONE_MIRROR),
            ),
            (PUBLIC_PYPI_ALIYUN_INDEX, Some(DIMO_PYTHON_STANDALONE_MIRROR)),
            (DIMO_PYPI_INDEX, Some(DIMO_PYTHON_STANDALONE_MIRROR)),
            (OFFICIAL_PYPI_INDEX, None),
        ]
    }
}

/// Bidirectional URL candidate expansion for binary archives, scripts, and
/// manifests across official upstreams, public mirrors (where identical path
/// mirrors exist), and `mirror.dimo-ai.com`.
pub fn download_url_candidates(url: &str) -> Vec<String> {
    download_url_candidates_for_proxy(url, proxy_is_active())
}

pub fn download_url_candidates_for_proxy(url: &str, proxy_active: bool) -> Vec<String> {
    let mut official_url = None;
    let mut mirror_url = None;

    for (official_prefix, mirror_prefix) in BINARY_MIRROR_PREFIXES {
        if let Some(rest) = url.strip_prefix(official_prefix) {
            official_url = Some(url.to_string());
            mirror_url = Some(format!("{mirror_prefix}{rest}"));
            break;
        }
        if let Some(rest) = url.strip_prefix(mirror_prefix) {
            official_url = Some(format!("{official_prefix}{rest}"));
            mirror_url = Some(url.to_string());
            break;
        }
    }

    let (Some(official), Some(mirror)) = (official_url, mirror_url) else {
        return vec![url.to_string()];
    };

    let public_mirror = if let Some(rest) = official.strip_prefix("https://nodejs.org/dist/") {
        Some(format!("https://cdn.npmmirror.com/binaries/node/{rest}"))
    } else {
        official
            .strip_prefix("https://github.com/oven-sh/bun/releases/download/")
            .map(|rest| format!("https://npmmirror.com/mirrors/bun/{rest}"))
    };

    let mut out = Vec::with_capacity(3);
    if proxy_active {
        push_unique(&mut out, official);
        if let Some(public) = public_mirror {
            push_unique(&mut out, public);
        }
        push_unique(&mut out, mirror);
    } else {
        if let Some(public) = public_mirror {
            push_unique(&mut out, public);
        }
        push_unique(&mut out, mirror);
        push_unique(&mut out, official);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_urls_order_official_first_when_proxy_active_and_mirrors_first_otherwise() {
        let with_proxy =
            node_download_url_candidates_for_proxy("22.22.3", "node-v22.22.3-linux-x64.tar.gz", true);
        assert_eq!(
            with_proxy[0],
            "https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-x64.tar.gz"
        );
        assert_eq!(
            with_proxy.last().unwrap(),
            "https://mirror.dimo-ai.com/dl/nodejs/dist/v22.22.3/node-v22.22.3-linux-x64.tar.gz"
        );

        let no_proxy = node_download_url_candidates_for_proxy(
            "22.22.3",
            "node-v22.22.3-linux-x64.tar.gz",
            false,
        );
        assert_eq!(
            no_proxy[0],
            "https://cdn.npmmirror.com/binaries/node/v22.22.3/node-v22.22.3-linux-x64.tar.gz"
        );
        assert_eq!(
            no_proxy[2],
            "https://mirror.dimo-ai.com/dl/nodejs/dist/v22.22.3/node-v22.22.3-linux-x64.tar.gz"
        );
        assert_eq!(
            no_proxy[3],
            "https://nodejs.org/dist/v22.22.3/node-v22.22.3-linux-x64.tar.gz"
        );
    }

    #[test]
    fn download_candidates_map_bidirectionally_between_official_and_dimo_mirror() {
        let from_mirror = download_url_candidates_for_proxy(
            "https://mirror.dimo-ai.com/dl/github/anomalyco/opencode/releases/download/v1.19.3/opencode-windows-x64.zip",
            true,
        );
        assert_eq!(
            from_mirror,
            vec![
                "https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-windows-x64.zip",
                "https://mirror.dimo-ai.com/dl/github/anomalyco/opencode/releases/download/v1.19.3/opencode-windows-x64.zip",
            ]
        );

        let from_official = download_url_candidates_for_proxy(
            "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
            false,
        );
        assert_eq!(
            from_official,
            vec![
                "https://mirror.dimo-ai.com/dl/google/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
                "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.1-windows-x86_64.zip",
            ]
        );
    }

    #[test]
    fn non_proxied_hosts_stay_single_candidate() {
        let url = "https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.209.1/traex-windows-x86_64.exe.gz";
        assert_eq!(download_url_candidates_for_proxy(url, false), vec![url]);
    }
}
