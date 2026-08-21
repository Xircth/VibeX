//! Official ACP Registry parsing, validation and cached refresh semantics.

use std::{collections::BTreeMap, sync::Arc, time::Duration as StdDuration};

use api_types::AgentId;
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use regex::Regex;
use reqwest::header::{ETAG, IF_NONE_MATCH};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    BoundaryError, Clock, RegistryFetchResponse, RegistryFetcher,
    profiles::{BuiltInProfileCatalog, RegistryEntryIdentity},
};

const OFFICIAL_ICON_PREFIX: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/";
const FRESH_FOR: Duration = Duration::hours(24);
const MAX_REGISTRY_BYTES: usize = 4 * 1024 * 1024;
const MAX_ICON_BYTES: usize = 128 * 1024;
// The official catalog is on Cloudflare. From some networks the TLS
// handshake alone exceeds 5s (observed ~5.3s to the LAX POP), and
// `reqwest`'s connect timeout includes that handshake. A 5s connect
// budget therefore fails with "error sending request" while curl still
// gets HTTP 200. Keep enough headroom for a slow first handshake plus
// the subsequent catalog download.
const REGISTRY_CONNECT_TIMEOUT: StdDuration = StdDuration::from_secs(15);
const REGISTRY_REQUEST_TIMEOUT: StdDuration = StdDuration::from_secs(30);
const REGISTRY_USER_AGENT: &str = "vibex-acp-registry/1.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryPackageDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Official package-ecosystem checksum (npm `dist.integrity` etc.). The
    /// official Registry does not publish one today; when present, managed
    /// installs persist it as the component's official fingerprint.
    #[serde(default)]
    pub integrity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryBinaryTarget {
    pub archive: String,
    pub sha256: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryDistributions {
    pub binary: Option<BTreeMap<String, RegistryBinaryTarget>>,
    pub npx: Option<RegistryPackageDistribution>,
    pub uvx: Option<RegistryPackageDistribution>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryAgentEntry {
    pub agent_id: AgentId,
    pub registry_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub distributions: RegistryDistributions,
    pub icon_url: Option<String>,
    pub icon_svg: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryAddTarget {
    pub snapshot_id: Uuid,
    pub agent_id: AgentId,
    pub registry_id: String,
    pub version: String,
    pub distributions: RegistryDistributions,
}

impl RegistryAgentEntry {
    /// Capture an immutable add/install target before any later refresh mutates
    /// the visible Registry snapshot.
    pub fn lock_add_target(&self, snapshot_id: Uuid) -> RegistryAddTarget {
        RegistryAddTarget {
            snapshot_id,
            agent_id: self.agent_id.clone(),
            registry_id: self.registry_id.clone(),
            version: self.version.clone(),
            distributions: self.distributions.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrySnapshot {
    pub id: Uuid,
    pub source_url: String,
    pub fetched_at: DateTime<Utc>,
    pub schema_version: String,
    pub document_json: String,
    pub document_sha256: String,
    pub etag: Option<String>,
    pub entries: Vec<RegistryAgentEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryCacheFreshness {
    Empty,
    Fresh,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryView {
    pub snapshot_id: Uuid,
    pub fetched_at: Option<DateTime<Utc>>,
    pub freshness: RegistryCacheFreshness,
    pub entries: Vec<RegistryAgentEntry>,
    pub refresh_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RegistryCache {
    snapshot: Option<RegistrySnapshot>,
}

impl RegistryCache {
    pub fn from_snapshot(snapshot: RegistrySnapshot) -> Self {
        Self {
            snapshot: Some(snapshot),
        }
    }

    pub fn snapshot(&self) -> Option<&RegistrySnapshot> {
        self.snapshot.as_ref()
    }

    fn view(&self, now: DateTime<Utc>, refresh_error: Option<String>) -> RegistryView {
        let Some(snapshot) = &self.snapshot else {
            return RegistryView {
                snapshot_id: Uuid::nil(),
                fetched_at: None,
                freshness: RegistryCacheFreshness::Empty,
                entries: Vec::new(),
                refresh_error,
            };
        };
        let age = now.signed_duration_since(snapshot.fetched_at);
        let freshness = if age <= FRESH_FOR {
            RegistryCacheFreshness::Fresh
        } else {
            RegistryCacheFreshness::Stale
        };
        RegistryView {
            snapshot_id: snapshot.id,
            fetched_at: Some(snapshot.fetched_at),
            freshness,
            entries: snapshot.entries.clone(),
            refresh_error,
        }
    }
}

pub struct RegistrySnapshotClient {
    fetcher: Arc<dyn RegistryFetcher>,
    clock: Arc<dyn Clock>,
}

#[derive(Clone)]
pub struct OfficialRegistryHttpFetcher {
    client: reqwest::Client,
}

impl OfficialRegistryHttpFetcher {
    pub fn new(client: reqwest::Client) -> Self {
        // `reqwest` is deliberately compiled in rustls no-provider mode at the
        // workspace boundary. The Registry client is also used outside the
        // Tauri process (release probes and tests), so it must establish its
        // own TLS invariant instead of relying on application bootstrap order.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Self { client }
    }
}

impl Default for OfficialRegistryHttpFetcher {
    fn default() -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(REGISTRY_USER_AGENT)
            .connect_timeout(REGISTRY_CONNECT_TIMEOUT)
            .timeout(REGISTRY_REQUEST_TIMEOUT)
            .build()
            .expect("static ACP Registry HTTP client configuration must be valid");
        Self::new(client)
    }
}

#[async_trait]
impl RegistryFetcher for OfficialRegistryHttpFetcher {
    async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<RegistryFetchResponse, BoundaryError> {
        if url != RegistrySnapshotClient::OFFICIAL_REGISTRY_URL
            && !url.starts_with(OFFICIAL_ICON_PREFIX)
        {
            return Err(BoundaryError::new(
                "Registry HTTP adapter only permits the official ACP Registry",
            ));
        }
        let mut request = self.client.get(url);
        if let Some(etag) = etag {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .map_err(|error| BoundaryError::new(error.to_string()))?;
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let body = response
            .bytes()
            .await
            .map_err(|error| BoundaryError::new(error.to_string()))?
            .to_vec();
        Ok(RegistryFetchResponse { status, body, etag })
    }
}

impl RegistrySnapshotClient {
    pub const OFFICIAL_REGISTRY_URL: &'static str =
        "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

    pub fn new(fetcher: Arc<dyn RegistryFetcher>, clock: Arc<dyn Clock>) -> Self {
        Self { fetcher, clock }
    }

    /// Return cached data immediately while fresh. Empty/stale caches attempt a
    /// refresh; any failure leaves the previous valid snapshot untouched.
    pub async fn open(&self, cache: &mut RegistryCache) -> RegistryView {
        let now = self.clock.now();
        if cache
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| now.signed_duration_since(snapshot.fetched_at) <= FRESH_FOR)
        {
            return cache.view(now, None);
        }
        self.refresh(cache).await
    }

    pub async fn refresh(&self, cache: &mut RegistryCache) -> RegistryView {
        let now = self.clock.now();
        let etag = cache
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.etag.as_deref());
        let response = match self.fetcher.fetch(Self::OFFICIAL_REGISTRY_URL, etag).await {
            Ok(response) => response,
            Err(error) => return cache.view(now, Some(error.to_string())),
        };
        if response.status == 304 {
            if let Some(snapshot) = cache.snapshot.as_mut() {
                snapshot.fetched_at = now;
                return cache.view(now, None);
            }
            return cache.view(
                now,
                Some("Registry returned 304 without a cache".to_string()),
            );
        }
        if response.status != 200 {
            return cache.view(
                now,
                Some(format!("Registry returned HTTP {}", response.status)),
            );
        }

        match self.parse_snapshot(response.body, response.etag, now).await {
            Ok(snapshot) => {
                cache.snapshot = Some(snapshot);
                cache.view(now, None)
            }
            Err(error) => cache.view(now, Some(error)),
        }
    }

    async fn parse_snapshot(
        &self,
        body: Vec<u8>,
        etag: Option<String>,
        fetched_at: DateTime<Utc>,
    ) -> Result<RegistrySnapshot, String> {
        if body.len() > MAX_REGISTRY_BYTES {
            return Err("Registry response exceeds the size limit".to_string());
        }
        let document_json =
            String::from_utf8(body).map_err(|_| "Registry response is not UTF-8".to_string())?;
        let raw: RawRegistryDocument = serde_json::from_str(&document_json)
            .map_err(|error| format!("Registry schema validation failed: {error}"))?;
        validate_semver("Registry schema version", &raw.version)?;
        if raw.agents.is_empty() {
            return Err("Registry contains no Agents".to_string());
        }

        let profiles = BuiltInProfileCatalog::bundled();
        let mut entries = Vec::with_capacity(raw.agents.len());
        let mut seen = std::collections::HashSet::new();
        for raw_agent in raw.agents {
            validate_registry_id(&raw_agent.id)?;
            validate_semver("Agent version", &raw_agent.version)?;
            if !seen.insert(raw_agent.id.clone()) {
                return Err(format!("duplicate Registry Agent id `{}`", raw_agent.id));
            }
            validate_non_empty("Agent name", &raw_agent.name)?;
            validate_non_empty("Agent description", &raw_agent.description)?;
            validate_optional_url(raw_agent.repository.as_deref())?;
            validate_optional_url(raw_agent.website.as_deref())?;
            validate_distributions(&raw_agent.distribution)?;

            let identity = RegistryEntryIdentity {
                registry_id: raw_agent.id.clone(),
                display_name: raw_agent.name.clone(),
            };
            let agent_id = profiles
                .resolve_registry_entry(&identity)
                .cloned()
                .unwrap_or(AgentId::parse(&raw_agent.id).map_err(|error| error.to_string())?);
            let icon_svg = match raw_agent.icon.as_deref() {
                Some(url) if valid_official_icon_url(url, &raw_agent.id) => {
                    match self.fetcher.fetch(url, None).await {
                        Ok(response)
                            if response.status == 200 && response.body.len() <= MAX_ICON_BYTES =>
                        {
                            String::from_utf8(response.body)
                                .ok()
                                .and_then(|svg| sanitize_registry_svg(&svg))
                        }
                        _ => None,
                    }
                }
                _ => None,
            };
            entries.push(RegistryAgentEntry {
                agent_id,
                registry_id: raw_agent.id,
                name: raw_agent.name,
                version: raw_agent.version,
                description: raw_agent.description,
                repository: raw_agent.repository,
                website: raw_agent.website,
                authors: raw_agent.authors,
                license: raw_agent.license,
                distributions: raw_agent.distribution.into(),
                icon_url: raw_agent.icon,
                icon_svg,
            });
        }
        entries.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.agent_id.cmp(&right.agent_id))
        });

        let document_sha256 = format!("{:x}", Sha256::digest(document_json.as_bytes()));
        Ok(RegistrySnapshot {
            id: Uuid::new_v4(),
            source_url: Self::OFFICIAL_REGISTRY_URL.to_string(),
            fetched_at,
            schema_version: raw.version,
            document_json,
            document_sha256,
            etag,
            entries,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistryDocument {
    version: String,
    agents: Vec<RawRegistryAgent>,
    /// Reserved by the official Registry schema for additive metadata. VibeX
    /// does not execute or interpret Registry extensions, but their presence
    /// must not invalidate the otherwise signed/validated public catalog.
    #[serde(default, rename = "extensions")]
    _extensions: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistryAgent {
    id: String,
    name: String,
    version: String,
    description: String,
    repository: Option<String>,
    website: Option<String>,
    #[serde(default)]
    authors: Vec<String>,
    license: Option<String>,
    icon: Option<String>,
    distribution: RawRegistryDistributions,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistryDistributions {
    binary: Option<BTreeMap<String, RawRegistryBinaryTarget>>,
    npx: Option<RawRegistryPackageDistribution>,
    uvx: Option<RawRegistryPackageDistribution>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistryPackageDistribution {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Forward-compatible: a newer official catalog may add an ecosystem
    /// integrity field; accepting it keeps this build from rejecting it.
    #[serde(default)]
    integrity: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRegistryBinaryTarget {
    archive: String,
    sha256: Option<String>,
    cmd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

impl From<RawRegistryDistributions> for RegistryDistributions {
    fn from(raw: RawRegistryDistributions) -> Self {
        Self {
            binary: raw.binary.map(|targets| {
                targets
                    .into_iter()
                    .map(|(platform, target)| {
                        (
                            platform,
                            RegistryBinaryTarget {
                                archive: target.archive,
                                sha256: target.sha256,
                                cmd: target.cmd,
                                args: target.args,
                                env: target.env,
                            },
                        )
                    })
                    .collect()
            }),
            npx: raw.npx.map(package_distribution),
            uvx: raw.uvx.map(package_distribution),
        }
    }
}

fn package_distribution(raw: RawRegistryPackageDistribution) -> RegistryPackageDistribution {
    RegistryPackageDistribution {
        package: raw.package,
        args: raw.args,
        env: raw.env,
        integrity: raw.integrity,
    }
}

fn validate_registry_id(value: &str) -> Result<(), String> {
    let pattern = Regex::new(r"^[a-z][a-z0-9-]*$").expect("static Registry id regex");
    if pattern.is_match(value) {
        Ok(())
    } else {
        Err(format!("invalid Registry Agent id `{value}`"))
    }
}

fn validate_semver(label: &str, value: &str) -> Result<(), String> {
    let pattern = Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
        .expect("static semver regex");
    if pattern.is_match(value) {
        Ok(())
    } else {
        Err(format!("{label} `{value}` is invalid"))
    }
}

fn validate_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} is empty"))
    } else {
        Ok(())
    }
}

fn validate_optional_url(value: Option<&str>) -> Result<(), String> {
    if value.is_none_or(|url| url.starts_with("https://") || url.starts_with("http://")) {
        Ok(())
    } else {
        Err("Registry metadata contains an invalid URL".to_string())
    }
}

fn validate_distributions(raw: &RawRegistryDistributions) -> Result<(), String> {
    if raw.binary.is_none() && raw.npx.is_none() && raw.uvx.is_none() {
        return Err("Registry Agent has no distribution".to_string());
    }
    for package in [raw.npx.as_ref(), raw.uvx.as_ref()].into_iter().flatten() {
        validate_non_empty("Registry package", &package.package)?;
    }
    if let Some(targets) = &raw.binary {
        if targets.is_empty() {
            return Err("Registry binary distribution has no platform targets".to_string());
        }
        for (platform, target) in targets {
            if !DESKTOP_PLATFORMS.contains(&platform.as_str()) {
                return Err(format!("unsupported Registry platform `{platform}`"));
            }
            validate_optional_url(Some(&target.archive))?;
            validate_non_empty("Registry binary command", &target.cmd)?;
            if target.sha256.as_ref().is_some_and(|hash| !is_sha256(hash)) {
                return Err("Registry binary SHA-256 is invalid".to_string());
            }
        }
    }
    Ok(())
}

/// Parse the executable portion of an ACP Registry entry for an explicitly
/// user-declared Agent. This deliberately reuses the official Registry schema
/// and validation instead of accepting an arbitrary launch command.
pub fn parse_registry_distributions_json(raw: &str) -> Result<RegistryDistributions, String> {
    let distributions: RawRegistryDistributions = serde_json::from_str(raw)
        .map_err(|error| format!("Agent distribution schema validation failed: {error}"))?;
    validate_distributions(&distributions)?;
    Ok(distributions.into())
}

const DESKTOP_PLATFORMS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_official_icon_url(url: &str, registry_id: &str) -> bool {
    url == format!("{OFFICIAL_ICON_PREFIX}{registry_id}.svg")
}

/// Accept a deliberately small passive SVG subset. Unsafe or surprising
/// documents are omitted from the cache rather than partially rewritten.
pub fn sanitize_registry_svg(svg: &str) -> Option<String> {
    let trimmed = svg.trim();
    if trimmed.len() > MAX_ICON_BYTES
        || !trimmed.starts_with("<svg")
        || !trimmed.ends_with("</svg>")
    {
        return None;
    }
    let lowercase = trimmed.to_ascii_lowercase();
    let forbidden = [
        "<script",
        "<foreignobject",
        "<iframe",
        "<object",
        "<embed",
        "<style",
        "<!doctype",
        "<!entity",
        "javascript:",
        "data:",
        "url(",
    ];
    if forbidden.iter().any(|needle| lowercase.contains(needle)) {
        return None;
    }
    let event_attribute =
        Regex::new(r#"\son[a-z0-9_-]+\s*="#).expect("static SVG event attribute regex");
    if event_attribute.is_match(&lowercase) {
        return None;
    }
    let external_reference =
        Regex::new(r#"(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|//|data:|javascript:)"#)
            .expect("static SVG external reference regex");
    if external_reference.is_match(&lowercase) {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_registry_timeouts_outlast_slow_cloudflare_tls() {
        assert!(REGISTRY_CONNECT_TIMEOUT >= StdDuration::from_secs(15));
        assert!(REGISTRY_REQUEST_TIMEOUT >= StdDuration::from_secs(30));
        assert!(REGISTRY_REQUEST_TIMEOUT > REGISTRY_CONNECT_TIMEOUT);
    }
}
