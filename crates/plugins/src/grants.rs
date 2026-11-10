//! Declarative plugin capability grants and strict path/URL/env security boundary validation.
//!
//! Inspired by `expo/exact`'s `grants` crate:
//! - Fine-grained capability classification: `net.fetch`, `net.websocket`, `fs.read`,
//!   `fs.write`, `env.read`, `secret.keep`, `storage.kv`.
//! - Environment variable isolation via explicit `env.read` allowlist snapshots.
//! - Component-wise path prefix matching (`Path::components`) that rejects any `..`
//!   (`Component::ParentDir`) traversal and prevents `/home/user` from matching `/home/user2`.
//! - Strict URL validation that rejects deceptive `@` (`userinfo`) URLs and blocks
//!   cloud metadata / link-local SSRF targets (`169.254.169.254`, `169.254.0.0/16`,
//!   `fe80::/10`, `fd00:ec2::254`, `metadata.google.internal`, etc.) by default.

use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{HostCapabilityGrant, WorkerHostError};

/// Fine-grained declarative capability categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
pub enum GrantCapability {
    #[serde(rename = "net.fetch")]
    NetFetch,
    #[serde(rename = "net.websocket")]
    NetWebsocket,
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "env.read")]
    EnvRead,
    #[serde(rename = "secret.keep")]
    SecretKeep,
    #[serde(rename = "storage.kv")]
    StorageKv,
}

impl GrantCapability {
    pub const ALL: &'static [Self] = &[
        Self::NetFetch,
        Self::NetWebsocket,
        Self::FsRead,
        Self::FsWrite,
        Self::EnvRead,
        Self::SecretKeep,
        Self::StorageKv,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NetFetch => "net.fetch",
            Self::NetWebsocket => "net.websocket",
            Self::FsRead => "fs.read",
            Self::FsWrite => "fs.write",
            Self::EnvRead => "env.read",
            Self::SecretKeep => "secret.keep",
            Self::StorageKv => "storage.kv",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "net.fetch" | "network.fetch" => Some(Self::NetFetch),
            "net.websocket" | "network.websocket" => Some(Self::NetWebsocket),
            "fs.read" | "files.read" | "files.ro" | "files.readonly" => Some(Self::FsRead),
            "fs.write" | "files.write" => Some(Self::FsWrite),
            "env.read" => Some(Self::EnvRead),
            "secret.keep" | "secrets.keep" => Some(Self::SecretKeep),
            "storage.kv" => Some(Self::StorageKv),
            _ => None,
        }
    }
}

/// Parsed `.grants` / declarative permission manifest for a plugin or agent tool.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionManifest {
    #[serde(default)]
    pub net_fetch: Vec<String>,
    #[serde(default)]
    pub net_websocket: Vec<String>,
    #[serde(default)]
    pub fs_read: Vec<PathBuf>,
    #[serde(default)]
    pub fs_write: Vec<PathBuf>,
    #[serde(default)]
    pub env_read: Vec<String>,
    #[serde(default)]
    pub secret_keep: Vec<String>,
    #[serde(default)]
    pub storage_kv: bool,
}

impl PermissionManifest {
    /// Parses a line-oriented `.grants` declaration.
    ///
    /// Example:
    /// ```text
    /// # Network & filesystem grants
    /// net.fetch https://api.example.com https://*.github.com
    /// net.websocket wss://realtime.example.com
    /// fs.read /home/user/workspace
    /// fs.write /home/user/workspace/output
    /// env.read OPENAI_API_KEY NODE_ENV
    /// secret.keep OPENAI_API_KEY
    /// storage.kv
    /// ```
    pub fn parse_grants_str(input: &str) -> Result<Self, String> {
        let mut manifest = Self::default();
        for (idx, raw_line) in input.lines().enumerate() {
            let line_no = idx + 1;
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let Some(cap_token) = parts.next() else {
                continue;
            };
            let args: Vec<&str> = parts.collect();
            match GrantCapability::parse(cap_token) {
                Some(GrantCapability::NetFetch) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `net.fetch` requires at least one URL or host pattern"
                        ));
                    }
                    for pattern in args {
                        validate_network_grant_pattern(pattern, false)
                            .map_err(|err| format!("line {line_no}: {err}"))?;
                        if !manifest.net_fetch.iter().any(|existing| existing == pattern) {
                            manifest.net_fetch.push(pattern.to_owned());
                        }
                    }
                }
                Some(GrantCapability::NetWebsocket) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `net.websocket` requires at least one URL or host pattern"
                        ));
                    }
                    for pattern in args {
                        validate_network_grant_pattern(pattern, true)
                            .map_err(|err| format!("line {line_no}: {err}"))?;
                        if !manifest
                            .net_websocket
                            .iter()
                            .any(|existing| existing == pattern)
                        {
                            manifest.net_websocket.push(pattern.to_owned());
                        }
                    }
                }
                Some(GrantCapability::FsRead) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `fs.read` requires at least one path"
                        ));
                    }
                    for raw_path in args {
                        validate_no_parent_dir_str(raw_path)
                            .map_err(|err| format!("line {line_no}: {err}"))?;
                        let path = PathBuf::from(raw_path);
                        if !manifest.fs_read.contains(&path) {
                            manifest.fs_read.push(path);
                        }
                    }
                }
                Some(GrantCapability::FsWrite) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `fs.write` requires at least one path"
                        ));
                    }
                    for raw_path in args {
                        validate_no_parent_dir_str(raw_path)
                            .map_err(|err| format!("line {line_no}: {err}"))?;
                        let path = PathBuf::from(raw_path);
                        if !manifest.fs_write.contains(&path) {
                            manifest.fs_write.push(path);
                        }
                    }
                }
                Some(GrantCapability::EnvRead) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `env.read` requires at least one environment variable name"
                        ));
                    }
                    for var_name in args {
                        if !is_valid_env_var_name(var_name) {
                            return Err(format!(
                                "line {line_no}: invalid environment variable name `{var_name}`"
                            ));
                        }
                        if !manifest.env_read.iter().any(|existing| existing == var_name) {
                            manifest.env_read.push(var_name.to_owned());
                        }
                    }
                }
                Some(GrantCapability::SecretKeep) => {
                    if args.is_empty() {
                        return Err(format!(
                            "line {line_no}: `secret.keep` requires at least one secret key"
                        ));
                    }
                    for key in args {
                        if !manifest.secret_keep.iter().any(|existing| existing == key) {
                            manifest.secret_keep.push(key.to_owned());
                        }
                    }
                }
                Some(GrantCapability::StorageKv) => {
                    manifest.storage_kv = true;
                }
                None => {
                    return Err(format!(
                        "line {line_no}: unknown capability `{cap_token}`"
                    ));
                }
            }
        }
        Ok(manifest)
    }

    /// Converts the declarative manifest into [`HostCapabilityGrant`] entries.
    pub fn to_capability_grants(&self) -> Vec<HostCapabilityGrant> {
        let mut grants = Vec::new();
        if !self.net_fetch.is_empty() {
            grants.push(HostCapabilityGrant::new(
                GrantCapability::NetFetch.as_str(),
                json!({ "urls": self.net_fetch }),
            ));
        }
        if !self.net_websocket.is_empty() {
            grants.push(HostCapabilityGrant::new(
                GrantCapability::NetWebsocket.as_str(),
                json!({ "urls": self.net_websocket }),
            ));
        }
        if !self.fs_read.is_empty() {
            let paths: Vec<String> = self
                .fs_read
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            grants.push(HostCapabilityGrant::new(
                GrantCapability::FsRead.as_str(),
                json!({ "paths": paths }),
            ));
        }
        if !self.fs_write.is_empty() {
            let paths: Vec<String> = self
                .fs_write
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            grants.push(HostCapabilityGrant::new(
                GrantCapability::FsWrite.as_str(),
                json!({ "paths": paths }),
            ));
        }
        if !self.env_read.is_empty() {
            grants.push(HostCapabilityGrant::new(
                GrantCapability::EnvRead.as_str(),
                json!({ "variables": self.env_read }),
            ));
        }
        if !self.secret_keep.is_empty() {
            grants.push(HostCapabilityGrant::new(
                GrantCapability::SecretKeep.as_str(),
                json!({ "keys": self.secret_keep }),
            ));
        }
        if self.storage_kv {
            grants.push(HostCapabilityGrant::new(
                GrantCapability::StorageKv.as_str(),
                json!({}),
            ));
        }
        grants
    }

    /// Checks whether a read path is allowed by `fs.read` or `fs.write` grants.
    pub fn allows_fs_read(&self, path: &Path) -> bool {
        if contains_parent_dir_component(path) {
            return false;
        }
        self.fs_read
            .iter()
            .chain(self.fs_write.iter())
            .any(|root| path_has_component_prefix(path, root))
    }

    /// Checks whether a write path is allowed by `fs.write` grants.
    pub fn allows_fs_write(&self, path: &Path) -> bool {
        if contains_parent_dir_component(path) {
            return false;
        }
        self.fs_write
            .iter()
            .any(|root| path_has_component_prefix(path, root))
    }

    /// Checks whether a URL is allowed for `net.fetch`.
    pub fn allows_net_fetch(&self, raw_url: &str) -> Result<bool, WorkerHostError> {
        let parsed = validate_network_url(raw_url, false)?;
        if self.net_fetch.is_empty() {
            return Ok(false);
        }
        Ok(self
            .net_fetch
            .iter()
            .any(|pattern| url_matches_grant_pattern(&parsed, pattern)))
    }

    /// Checks whether a URL is allowed for `net.websocket`.
    pub fn allows_net_websocket(&self, raw_url: &str) -> Result<bool, WorkerHostError> {
        let parsed = validate_network_url(raw_url, true)?;
        if self.net_websocket.is_empty() {
            return Ok(false);
        }
        Ok(self
            .net_websocket
            .iter()
            .any(|pattern| url_matches_grant_pattern(&parsed, pattern)))
    }

    /// Builds an isolated environment snapshot containing ONLY variables listed in `env.read`.
    pub fn build_env_snapshot(
        &self,
        source_env: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let allowed: BTreeSet<&str> = self.env_read.iter().map(String::as_str).collect();
        source_env
            .iter()
            .filter(|(k, _)| allowed.contains(k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

fn is_valid_env_var_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Collects allowed environment variable names from `env.read` grants.
pub fn collect_allowed_env_vars(grants: &[HostCapabilityGrant]) -> BTreeSet<String> {
    let mut allowed = BTreeSet::new();
    for grant in grants {
        let cap = grant.capability.trim();
        if !matches!(cap, "env.read" | "env.*" | "env" | "*") {
            continue;
        }
        collect_env_vars_from_scope(&grant.scope, &mut allowed);
    }
    allowed
}

fn collect_env_vars_from_scope(scope: &Value, out: &mut BTreeSet<String>) {
    match scope {
        Value::String(s) => {
            for token in s.split_whitespace() {
                if !token.is_empty() {
                    out.insert(token.to_owned());
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    out.insert(s.to_owned());
                }
            }
        }
        Value::Object(map) => {
            for key in ["variables", "vars", "keys", "env", "allow", "allowed"] {
                if let Some(val) = map.get(key) {
                    collect_env_vars_from_scope(val, out);
                }
            }
            if let Some(single) = map.get("key").or_else(|| map.get("variable")).and_then(Value::as_str) {
                let trimmed = single.trim();
                if !trimmed.is_empty() {
                    out.insert(trimmed.to_owned());
                }
            }
        }
        _ => {}
    }
}

/// Builds an isolated environment variable snapshot from `source_env`,
/// retaining ONLY the variables explicitly granted via `env.read`.
///
/// Full `process.env` is never exposed to untrusted/sandboxed callers.
pub fn build_isolated_env_snapshot(
    grants: &[HostCapabilityGrant],
    source_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let allowed = collect_allowed_env_vars(grants);
    if allowed.is_empty() {
        return BTreeMap::new();
    }
    let allow_all = allowed.contains("*");
    source_env
        .iter()
        .filter(|(key, _)| {
            allow_all
                || allowed.contains(key.as_str())
                || (cfg!(windows)
                    && allowed
                        .iter()
                        .any(|item| item.eq_ignore_ascii_case(key.as_str())))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Returns `true` if `path` or its string representation contains any `..` (`ParentDir`) segment.
pub fn contains_parent_dir_component(path: &Path) -> bool {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return true;
    }
    // Also check normalized slash/backslash segments so `..\` on Unix or `../` on Windows
    // is always caught regardless of host OS separator conventions.
    path.to_string_lossy()
        .split(['/', '\\'])
        .any(|segment| segment == "..")
}

/// Rejects any path string containing `..` (`Component::ParentDir`).
pub fn validate_no_parent_dir_str(raw_path: &str) -> Result<(), String> {
    if contains_parent_dir_component(Path::new(raw_path)) {
        return Err(format!(
            "path `{raw_path}` contains forbidden `..` parent traversal"
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NormalizedPathSegment {
    Prefix(String),
    RootDir,
    Normal(String),
}

fn normalized_path_segments(path: &Path) -> Option<Vec<NormalizedPathSegment>> {
    if contains_parent_dir_component(path) {
        return None;
    }
    let raw = path.to_string_lossy();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(Vec::new());
    }

    // Handle cross-platform POSIX and Windows paths uniformly by component:
    let mut segments = Vec::new();
    let normalized = trimmed.replace('\\', "/");
    let mut rest = normalized.as_str();

    if let Some(colon_idx) = rest.find(':')
        && colon_idx == 1
        && rest.as_bytes()[0].is_ascii_alphabetic()
    {
        let drive = rest[..2].to_ascii_uppercase();
        segments.push(NormalizedPathSegment::Prefix(drive));
        rest = &rest[2..];
    }

    if rest.starts_with('/') {
        segments.push(NormalizedPathSegment::RootDir);
    }

    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        let token = if cfg!(windows) {
            part.to_ascii_lowercase()
        } else {
            part.to_owned()
        };
        segments.push(NormalizedPathSegment::Normal(token));
    }

    Some(segments)
}

/// Component-wise path prefix matching.
///
/// - Immediately returns `false` if either `path` or `prefix` contains `..` (`ParentDir`).
/// - Compares path components rather than raw strings, so granting `/home/user`
///   matches `/home/user` and `/home/user/file.txt`, but **never** matches `/home/user2`.
pub fn path_has_component_prefix(path: &Path, prefix: &Path) -> bool {
    let Some(path_segments) = normalized_path_segments(path) else {
        return false;
    };
    let Some(prefix_segments) = normalized_path_segments(prefix) else {
        return false;
    };
    if prefix_segments.is_empty() || path_segments.len() < prefix_segments.len() {
        return false;
    }
    path_segments[..prefix_segments.len()] == prefix_segments[..]
}

fn validate_network_grant_pattern(pattern: &str, allow_websocket: bool) -> Result<(), String> {
    let trimmed = pattern.trim();
    if trimmed == "*" {
        return Ok(());
    }
    if contains_url_userinfo(trimmed) {
        return Err(format!(
            "network grant pattern `{trimmed}` must not contain `@` userinfo"
        ));
    }
    let test_url = trimmed.replace("*.", "wildcard-sub.");
    let parsed = url::Url::parse(&test_url)
        .map_err(|err| format!("invalid network grant URL pattern `{trimmed}`: {err}"))?;
    let valid_scheme = if allow_websocket {
        matches!(parsed.scheme(), "ws" | "wss" | "http" | "https")
    } else {
        matches!(parsed.scheme(), "http" | "https")
    };
    if !valid_scheme {
        return Err(format!(
            "unsupported URL scheme `{}` in network grant `{trimmed}`",
            parsed.scheme()
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "network grant pattern `{trimmed}` must not contain `@` userinfo"
        ));
    }
    if let Some(host) = parsed.host_str()
        && is_blocked_ssrf_host(host)
    {
        return Err(format!(
            "network grant pattern `{trimmed}` targets a blocked metadata or link-local address"
        ));
    }
    Ok(())
}

fn contains_url_userinfo(raw_url: &str) -> bool {
    let Some(after_scheme) = raw_url
        .split_once("://")
        .map(|(_, rest)| rest)
    else {
        return false;
    };
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    after_scheme[..authority_end].contains('@')
}

/// Returns `true` if `host` is a cloud metadata service or link-local SSRF IP/hostname.
pub fn is_blocked_ssrf_host(host: &str) -> bool {
    let trimmed = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "metadata.google.internal"
            | "metadata.goog"
            | "instance-data"
            | "169.254.169.254"
            | "100.100.100.200"
    ) || lower.ends_with(".metadata.google.internal")
    {
        return true;
    }

    if let Ok(ip) = lower.parse::<IpAddr>() {
        return is_blocked_ssrf_ip(ip);
    }
    false
}

/// Returns `true` if `ip` is a cloud metadata or link-local IP address.
pub fn is_blocked_ssrf_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ssrf_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ssrf_ipv6(v6),
    }
}

fn is_blocked_ssrf_ipv4(v4: Ipv4Addr) -> bool {
    let octets = v4.octets();
    // 169.254.0.0/16 link-local (includes 169.254.169.254 AWS/GCP/Azure metadata and 169.254.170.2 ECS)
    if octets[0] == 169 && octets[1] == 254 {
        return true;
    }
    // 100.100.100.200 Alibaba Cloud metadata
    if octets == [100, 100, 100, 200] {
        return true;
    }
    // 0.0.0.0/8 "this network"
    if octets[0] == 0 {
        return true;
    }
    false
}

fn is_blocked_ssrf_ipv6(v6: Ipv6Addr) -> bool {
    if v6.is_unspecified() {
        return true;
    }
    // Check IPv4-mapped IPv6 addresses (e.g. ::ffff:169.254.169.254)
    if let Some(mapped_v4) = v6.to_ipv4_mapped()
        && is_blocked_ssrf_ipv4(mapped_v4)
    {
        return true;
    }
    let segments = v6.segments();
    // fe80::/10 IPv6 link-local
    if (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // fd00:ec2::254 AWS EC2 IPv6 metadata
    if segments == [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254] {
        return true;
    }
    false
}

/// Strictly validates a network URL against:
/// 1. Allowed schemes (`http`/`https`, plus `ws`/`wss` when `allow_websocket` is true).
/// 2. Deceptive `@` (`userinfo`) credentials (`https://api.example.com@evil.com`).
/// 3. Cloud metadata & link-local SSRF addresses (`169.254.169.254`, `169.254.0.0/16`, `fe80::/10`, etc.).
pub fn validate_network_url(
    raw_url: &str,
    allow_websocket: bool,
) -> Result<url::Url, WorkerHostError> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err(WorkerHostError::new("network_invalid_url", "url is required"));
    }
    if contains_url_userinfo(trimmed) {
        return Err(WorkerHostError::new(
            "network_invalid_url",
            "URLs containing `@` userinfo are forbidden",
        ));
    }
    let parsed_url = url::Url::parse(trimmed)
        .map_err(|error| WorkerHostError::new("network_invalid_url", error.to_string()))?;
    let valid_scheme = if allow_websocket {
        matches!(parsed_url.scheme(), "http" | "https" | "ws" | "wss")
    } else {
        matches!(parsed_url.scheme(), "http" | "https")
    };
    if !valid_scheme {
        return Err(WorkerHostError::new(
            "network_invalid_url",
            if allow_websocket {
                "only http, https, ws, and wss URLs are supported"
            } else {
                "only http and https URLs are supported"
            },
        ));
    }
    if !parsed_url.username().is_empty() || parsed_url.password().is_some() {
        return Err(WorkerHostError::new(
            "network_invalid_url",
            "URLs containing `@` userinfo are forbidden",
        ));
    }
    let host = parsed_url.host_str().ok_or_else(|| {
        WorkerHostError::new("network_invalid_url", "URL must include a valid host")
    })?;
    if is_blocked_ssrf_host(host) {
        return Err(WorkerHostError::new(
            "network_url_blocked",
            format!("Access to cloud metadata or link-local host `{host}` is blocked"),
        ));
    }
    Ok(parsed_url)
}

/// Checks if a validated `url::Url` matches a single grant pattern.
///
/// Supported patterns:
/// - `"*"`
/// - Full origin or URL prefix: `"https://api.example.com"`, `"https://api.example.com/v1/*"`
/// - Wildcard subdomain: `"https://*.github.com"`, `"*.github.com"`
/// - Bare host: `"api.example.com"`
pub fn url_matches_grant_pattern(url: &url::Url, pattern: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    let Some(url_host) = url.host_str() else {
        return false;
    };
    let url_host_lower = url_host.to_ascii_lowercase();

    if let Some((pattern_scheme, rest)) = pattern.split_once("://") {
        if !pattern_scheme.eq_ignore_ascii_case(url.scheme()) {
            return false;
        }
        let (pattern_authority, pattern_path) = match rest.find('/') {
            Some(idx) => (&rest[..idx], &rest[idx..]),
            None => (rest, ""),
        };
        if pattern_authority.contains('@') {
            return false;
        }
        let (pattern_host, pattern_port) = split_host_and_port(pattern_authority);
        if !host_matches_pattern(&url_host_lower, &pattern_host.to_ascii_lowercase()) {
            return false;
        }
        if let Some(expected_port) = pattern_port
            && url.port_or_known_default() != Some(expected_port)
        {
            return false;
        }
        if !pattern_path.is_empty() && pattern_path != "/" && pattern_path != "/*" {
            let clean_prefix = pattern_path.strip_suffix('*').unwrap_or(pattern_path);
            if !url.path().starts_with(clean_prefix) {
                return false;
            }
        }
        true
    } else {
        let (pattern_host, pattern_port) = split_host_and_port(pattern);
        if let Some(expected_port) = pattern_port
            && url.port_or_known_default() != Some(expected_port)
        {
            return false;
        }
        host_matches_pattern(&url_host_lower, &pattern_host.to_ascii_lowercase())
    }
}

fn split_host_and_port(authority: &str) -> (&str, Option<u16>) {
    if authority.starts_with('[') {
        if let Some(end_bracket) = authority.find(']') {
            let host = &authority[..=end_bracket];
            let remainder = &authority[end_bracket + 1..];
            let port = remainder
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok());
            return (host, port);
        }
        return (authority, None);
    }
    if let Some((host, port_str)) = authority.rsplit_once(':')
        && let Ok(port) = port_str.parse::<u16>()
    {
        return (host, Some(port));
    }
    (authority, None)
}

fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        // `*.github.com` matches `api.github.com` and `sub.api.github.com`, but not `github.com` or `evilgithub.com`
        return host.len() > suffix.len() + 1
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.';
    }
    host == pattern
}

/// Extracts URL/host allowlist patterns from a network capability grant scope.
pub fn collect_network_grant_patterns(scope: &Value, out: &mut Vec<String>) {
    match scope {
        Value::String(s) => {
            for token in s.split_whitespace() {
                if !token.is_empty() {
                    out.push(token.to_owned());
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    out.push(s.to_owned());
                }
            }
        }
        Value::Object(map) => {
            for key in ["urls", "hosts", "origins", "allow", "allowed", "patterns", "endpoints"] {
                if let Some(val) = map.get(key) {
                    collect_network_grant_patterns(val, out);
                }
            }
            for key in ["url", "host", "origin", "pattern"] {
                if let Some(s) = map.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                    out.push(s.to_owned());
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_declarative_grants_and_builds_isolated_env_snapshot() {
        let raw = r#"
            # Fine-grained plugin capability manifest
            net.fetch https://api.example.com https://*.github.com
            net.websocket wss://realtime.example.com
            fs.read /home/user/workspace
            fs.write /home/user/workspace/output
            env.read OPENAI_API_KEY NODE_ENV
            secret.keep GITHUB_TOKEN
            storage.kv
        "#;

        let manifest = PermissionManifest::parse_grants_str(raw).expect("parse valid .grants");
        assert_eq!(
            manifest.net_fetch,
            vec![
                "https://api.example.com".to_owned(),
                "https://*.github.com".to_owned()
            ]
        );
        assert_eq!(
            manifest.net_websocket,
            vec!["wss://realtime.example.com".to_owned()]
        );
        assert_eq!(manifest.fs_read, vec![PathBuf::from("/home/user/workspace")]);
        assert_eq!(
            manifest.fs_write,
            vec![PathBuf::from("/home/user/workspace/output")]
        );
        assert_eq!(
            manifest.env_read,
            vec!["OPENAI_API_KEY".to_owned(), "NODE_ENV".to_owned()]
        );
        assert_eq!(manifest.secret_keep, vec!["GITHUB_TOKEN".to_owned()]);
        assert!(manifest.storage_kv);

        let mut full_env = BTreeMap::new();
        full_env.insert("OPENAI_API_KEY".to_owned(), "sk-test".to_owned());
        full_env.insert("NODE_ENV".to_owned(), "production".to_owned());
        full_env.insert("AWS_SECRET_ACCESS_KEY".to_owned(), "super-secret".to_owned());

        let snapshot = manifest.build_env_snapshot(&full_env);
        assert_eq!(snapshot.len(), 2);
        assert_eq!(
            snapshot.get("OPENAI_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        assert_eq!(
            snapshot.get("NODE_ENV").map(String::as_str),
            Some("production")
        );
        assert!(!snapshot.contains_key("AWS_SECRET_ACCESS_KEY"));

        let grants = manifest.to_capability_grants();
        let snapshot_from_grants = build_isolated_env_snapshot(&grants, &full_env);
        assert_eq!(snapshot_from_grants, snapshot);
    }

    #[test]
    fn component_wise_path_prefix_prevents_sibling_confusion_and_rejects_parent_dir() {
        let allowed_root = Path::new("/home/user");
        assert!(path_has_component_prefix(
            Path::new("/home/user"),
            allowed_root
        ));
        assert!(path_has_component_prefix(
            Path::new("/home/user/file.txt"),
            allowed_root
        ));
        assert!(path_has_component_prefix(
            Path::new("/home/user/sub/dir/data.json"),
            allowed_root
        ));

        // Sibling directory `/home/user2` MUST NOT match `/home/user`
        assert!(!path_has_component_prefix(
            Path::new("/home/user2"),
            allowed_root
        ));
        assert!(!path_has_component_prefix(
            Path::new("/home/user2/file.txt"),
            allowed_root
        ));

        // Any `..` (Component::ParentDir) is immediately rejected
        assert!(contains_parent_dir_component(Path::new(
            "/home/user/../user2/file.txt"
        )));
        assert!(contains_parent_dir_component(Path::new("..\\secret.txt")));
        assert!(!path_has_component_prefix(
            Path::new("/home/user/../user/file.txt"),
            allowed_root
        ));
        assert!(
            PermissionManifest::parse_grants_str("fs.read /home/user/../etc").is_err(),
            "grants parser must reject paths with `..`"
        );
    }

    #[test]
    fn url_validation_rejects_deceptive_userinfo_and_blocks_ssrf_metadata_ips() {
        // Deceptive `@` userinfo URLs must be rejected immediately
        let err = validate_network_url("https://api.example.com@evil.com/v1/data", false)
            .expect_err("must reject @ userinfo URL");
        assert_eq!(err.code(), "network_invalid_url");
        assert!(err.message().contains("`@` userinfo"));

        let err2 = validate_network_url("https://user:pass@api.example.com/v1", false)
            .expect_err("must reject user:pass@ URL");
        assert_eq!(err2.code(), "network_invalid_url");

        // Cloud metadata & link-local SSRF addresses must be blocked by default
        for blocked_url in [
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.170.2/v2/credentials",
            "http://100.100.100.200/latest/meta-data/",
            "http://[fe80::1]/status",
            "http://[fd00:ec2::254]/latest/meta-data/",
            "http://[::ffff:169.254.169.254]/latest/meta-data/",
            "http://metadata.google.internal/computeMetadata/v1/",
        ] {
            let err = validate_network_url(blocked_url, false)
                .expect_err(&format!("must block SSRF URL {blocked_url}"));
            assert_eq!(err.code(), "network_url_blocked", "url: {blocked_url}");
        }

        // Valid URLs and wildcard subdomain matching
        let manifest = PermissionManifest::parse_grants_str(
            "net.fetch https://api.example.com https://*.github.com\nnet.websocket wss://realtime.example.com",
        )
        .expect("parse network grants");
        assert!(manifest
            .allows_net_fetch("https://api.example.com/v1/models")
            .expect("valid url"));
        assert!(manifest
            .allows_net_fetch("https://api.github.com/repos/expo/exact")
            .expect("valid wildcard subdomain"));
        assert!(!manifest
            .allows_net_fetch("https://github.com/expo/exact")
            .expect("root domain should not match *.github.com"));
        assert!(!manifest
            .allows_net_fetch("https://evil.com/phish")
            .expect("unlisted host denied"));
        assert!(manifest
            .allows_net_websocket("wss://realtime.example.com/socket")
            .expect("valid wss url"));
    }
}

