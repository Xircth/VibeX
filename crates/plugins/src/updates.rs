//! Resolves updates exclusively from the installed source. It never installs code.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{PluginError, PluginPackage, PluginSource};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSourceLock {
    pub source_kind: String,
    pub origin: String,
    pub owner: String,
    pub plugin_name: String,
    pub tag: String,
    pub version: String,
    pub package_digest: String,
}

impl PluginSourceLock {
    pub fn from_source(source: &PluginSource, version: &str, digest: &str) -> Option<Self> {
        if !matches!(
            source.kind,
            crate::PluginSourceKind::Snapshot | crate::PluginSourceKind::Marketplace
        ) {
            return None;
        }
        let raw = source.origin.as_deref()?;
        let url = url::Url::parse(raw).ok()?;
        let parts: Vec<_> = url
            .path_segments()?
            .filter(|part| !part.is_empty())
            .collect();
        let github = url.host_str() == Some("github.com");
        let (owner, name, origin) = if github && parts.len() >= 2 {
            (
                parts[0],
                parts[1].trim_end_matches(".git"),
                format!(
                    "https://github.com/{}/{}",
                    parts[0],
                    parts[1].trim_end_matches(".git")
                ),
            )
        } else {
            let start = parts.iter().position(|part| *part == "marketplace")?;
            let owner = *parts.get(start + 1)?;
            let name = *parts.get(start + 2)?;
            (owner, name, raw.trim_end_matches('/').to_owned())
        };
        Some(Self {
            source_kind: if github { "github" } else { "marketplace" }.to_owned(),
            origin,
            owner: owner.to_owned(),
            plugin_name: name.to_owned(),
            tag: source.git_ref.clone().unwrap_or_else(|| version.to_owned()),
            version: version.to_owned(),
            package_digest: digest.to_owned(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCandidate {
    pub source: PluginSourceLock,
    pub download_url: String,
    pub sha256: Option<String>,
    pub release_notes: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateStatus {
    pub plugin_id: String,
    pub update_available: bool,
    pub status: String,
    pub checked_at: u64,
    pub last_successful_at: Option<u64>,
    pub available_tag: Option<String>,
    pub available_version: Option<String>,
    pub error: Option<String>,
    pub candidate: Option<PluginUpdateCandidate>,
}

impl PluginUpdateStatus {
    pub fn failed(plugin_id: String, error: String, previous: Option<&Self>) -> Self {
        Self {
            plugin_id,
            update_available: previous.is_some_and(|item| item.update_available),
            status: "failed".to_owned(),
            checked_at: now(),
            last_successful_at: previous.and_then(|item| item.last_successful_at),
            available_tag: previous.and_then(|item| item.available_tag.clone()),
            available_version: previous.and_then(|item| item.available_version.clone()),
            candidate: previous.and_then(|item| item.candidate.clone()),
            error: Some(error),
        }
    }
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub struct PluginUpdateResolver {
    client: reqwest::Client,
    github_api: String,
}

impl PluginUpdateResolver {
    pub fn new() -> Result<Self, PluginError> {
        Self::with_github_api("https://api.github.com")
    }

    /// HTTP adapter seam, also used by local integration fixtures.
    pub fn with_github_api(github_api: &str) -> Result<Self, PluginError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .user_agent("VibeX")
                .build()
                .map_err(|e| PluginError::io("update client", e))?,
            github_api: github_api.trim_end_matches('/').to_owned(),
        })
    }

    async fn json(&self, url: &str) -> Result<Value, PluginError> {
        self.client
            .get(url)
            .send()
            .await
            .map_err(|e| PluginError::io("check plugin update", e))?
            .error_for_status()
            .map_err(|e| PluginError::io("check plugin update", e))?
            .json()
            .await
            .map_err(|e| PluginError::io("plugin release metadata", e))
    }

    pub async fn resolve(
        &self,
        source: &PluginSourceLock,
        requested: Option<&str>,
    ) -> Result<Option<PluginUpdateCandidate>, PluginError> {
        if source.source_kind == "github" {
            self.github(source, requested).await
        } else if source.source_kind == "marketplace" {
            self.marketplace(source, requested).await
        } else {
            Err(PluginError::invalid_manifest(
                "plugin has no remote update source",
            ))
        }
    }

    async fn github(
        &self,
        source: &PluginSourceLock,
        requested: Option<&str>,
    ) -> Result<Option<PluginUpdateCandidate>, PluginError> {
        let base = format!(
            "{}/repos/{}/{}",
            self.github_api,
            segment(&source.owner),
            segment(&source.plugin_name)
        );
        let releases = if let Some(tag) = requested {
            match self
                .json(&format!("{base}/releases/tags/{}", segment(tag)))
                .await
            {
                Ok(release) => vec![release],
                Err(_) => vec![self.github_tag(&base, tag).await?],
            }
        } else {
            self.json(&format!("{base}/releases?per_page=100"))
                .await?
                .as_array()
                .cloned()
                .ok_or_else(|| PluginError::invalid_manifest("GitHub releases must be an array"))?
        };
        let excluded_tags: std::collections::BTreeSet<_> = releases
            .iter()
            .filter(|release| {
                release["draft"].as_bool() == Some(true)
                    || release["prerelease"].as_bool() == Some(true)
            })
            .filter_map(|release| release["tag_name"].as_str().map(str::to_owned))
            .collect();
        let mut candidates = Vec::new();
        for release in releases {
            if release["draft"].as_bool() == Some(true)
                || release["prerelease"].as_bool() == Some(true)
            {
                continue;
            }
            let Some(tag) = release["tag_name"].as_str() else {
                continue;
            };
            let Ok(version) = semver::Version::parse(tag.trim_start_matches('v')) else {
                continue;
            };
            if !version.pre.is_empty() || !newer(&source.version, &version.to_string()) {
                continue;
            }
            let asset = release["assets"].as_array().and_then(|assets| {
                assets.iter().find(|asset| {
                    asset["name"]
                        .as_str()
                        .is_some_and(|name| name.ends_with(".vxp"))
                })
            });
            let download_url = asset
                .and_then(|a| a["browser_download_url"].as_str())
                .or_else(|| release["zipball_url"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{base}/zipball/{}", segment(tag)));
            let mut lock = source.clone();
            lock.tag = tag.to_owned();
            lock.version = version.to_string();
            lock.package_digest.clear();
            candidates.push((
                version,
                PluginUpdateCandidate {
                    source: lock,
                    download_url,
                    sha256: asset
                        .and_then(|a| a["digest"].as_str())
                        .filter(|s| s.starts_with("sha256:"))
                        .map(str::to_owned),
                    release_notes: release["body"].as_str().unwrap_or_default().to_owned(),
                },
            ));
        }
        if candidates.is_empty() && requested.is_none() {
            let tags = self.json(&format!("{base}/tags?per_page=100")).await?;
            for tag in tags
                .as_array()
                .ok_or_else(|| PluginError::invalid_manifest("GitHub tags must be an array"))?
            {
                let Some(name) = tag["name"].as_str() else {
                    continue;
                };
                if excluded_tags.contains(name) {
                    continue;
                }
                let Ok(version) = semver::Version::parse(name.trim_start_matches('v')) else {
                    continue;
                };
                if !version.pre.is_empty() || !newer(&source.version, &version.to_string()) {
                    continue;
                }
                let mut lock = source.clone();
                lock.tag = name.to_owned();
                lock.version = version.to_string();
                lock.package_digest.clear();
                candidates.push((
                    version,
                    PluginUpdateCandidate {
                        source: lock,
                        download_url: format!("{base}/zipball/{}", segment(name)),
                        sha256: None,
                        release_notes: String::new(),
                    },
                ));
            }
        }
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(candidates
            .into_iter()
            .next()
            .map(|(_, candidate)| candidate))
    }

    async fn github_tag(&self, base: &str, tag: &str) -> Result<Value, PluginError> {
        // A branch or arbitrary commit is not a stable upgrade target.
        let version = semver::Version::parse(tag.trim_start_matches('v'))
            .map_err(|e| PluginError::io("update requires a stable semver tag", e))?;
        if !version.pre.is_empty() {
            return Err(PluginError::invalid_manifest(
                "update requires a stable tag",
            ));
        }
        self.json(&format!("{base}/git/ref/tags/{}", segment(tag)))
            .await?;
        Ok(
            serde_json::json!({"tag_name": tag, "zipball_url": format!("{base}/zipball/{}", segment(tag))}),
        )
    }

    async fn marketplace(
        &self,
        source: &PluginSourceLock,
        requested: Option<&str>,
    ) -> Result<Option<PluginUpdateCandidate>, PluginError> {
        let origin = url::Url::parse(&source.origin)
            .map_err(|e| PluginError::io("marketplace source", e))?;
        let base = origin.origin().ascii_serialization();
        let listing = format!(
            "{base}/api/marketplace/v1/listing/{}/{}",
            segment(&source.owner),
            segment(&source.plugin_name)
        );
        let versions = self.json(&format!("{listing}/versions")).await?;
        let mut versions: Vec<_> = versions
            .as_array()
            .ok_or_else(|| PluginError::invalid_manifest("marketplace versions must be an array"))?
            .iter()
            .filter_map(|item| {
                let version =
                    semver::Version::parse(item["version"].as_str()?.trim_start_matches('v'))
                        .ok()?;
                let tag = item["tag"].as_str()?;
                (version.pre.is_empty()
                    && newer(&source.version, &version.to_string())
                    && requested.is_none_or(|r| r == tag || r == version.to_string()))
                .then(|| {
                    (
                        version,
                        tag.to_owned(),
                        item["packageDigest"].as_str().map(str::to_owned),
                    )
                })
            })
            .collect();
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        let Some((version, tag, digest)) = versions.into_iter().next() else {
            return Ok(None);
        };
        let artifact = self
            .json(&format!(
                "{base}/api/marketplace/v1/artifact/{}/{}?tag={}",
                segment(&source.owner),
                segment(&source.plugin_name),
                segment(&tag)
            ))
            .await?;
        if artifact["tag"].as_str() != Some(tag.as_str())
            || artifact["version"]
                .as_str()
                .map(|v| v.trim_start_matches('v'))
                != Some(version.to_string().as_str())
        {
            return Err(PluginError::invalid_manifest(
                "marketplace returned a different release than requested",
            ));
        }
        let mut lock = source.clone();
        lock.tag = tag;
        lock.version = version.to_string();
        lock.package_digest = artifact["packageDigest"]
            .as_str()
            .map(str::to_owned)
            .or(digest)
            .unwrap_or_default();
        let download_url = artifact["downloadUrl"]
            .as_str()
            .ok_or_else(|| PluginError::invalid_manifest("release has no download URL"))?
            .to_owned();
        Ok(Some(PluginUpdateCandidate {
            source: lock,
            download_url: origin
                .join(&download_url)
                .map_err(|e| PluginError::io("release download URL", e))?
                .to_string(),
            sha256: artifact["sha256"].as_str().map(str::to_owned),
            release_notes: artifact["releaseNotes"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        }))
    }

    pub async fn download(
        &self,
        candidate: &PluginUpdateCandidate,
        directory: &std::path::Path,
    ) -> Result<std::path::PathBuf, PluginError> {
        use sha2::{Digest, Sha256};
        let mut response = self
            .client
            .get(&candidate.download_url)
            .send()
            .await
            .map_err(|e| PluginError::io("download update", e))?
            .error_for_status()
            .map_err(|e| PluginError::io("download update", e))?;
        if response
            .content_length()
            .is_some_and(|size| size > 128 * 1024 * 1024)
        {
            return Err(PluginError::invalid_manifest(
                "plugin archive exceeds 128 MiB",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| PluginError::io("download update", e))?
        {
            if bytes.len() + chunk.len() > 128 * 1024 * 1024 {
                return Err(PluginError::invalid_manifest(
                    "plugin archive exceeds 128 MiB",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if let Some(expected) = &candidate.sha256 {
            let actual = format!("{:x}", Sha256::digest(&bytes));
            if !actual.eq_ignore_ascii_case(expected.trim_start_matches("sha256:")) {
                return Err(PluginError::invalid_manifest(
                    "plugin archive checksum mismatch",
                ));
            }
        }
        std::fs::create_dir_all(directory)
            .map_err(|e| PluginError::io("create update staging", e))?;
        let path = directory.join(format!("{}.vxp", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|e| PluginError::io("write plugin update", e))?;
        Ok(path)
    }
}

pub fn validate_update_package(
    package: &PluginPackage,
    candidate: &PluginUpdateCandidate,
) -> Result<(), PluginError> {
    if let Some(minimum) = &package.minimum_host_version {
        let minimum = semver::Version::parse(minimum.trim_start_matches('v'))
            .map_err(|e| PluginError::io("minimum Host version", e))?;
        let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
            .map_err(|e| PluginError::io("Host version", e))?;
        if current < minimum {
            return Err(PluginError::coded(
                "plugin_update_incompatible",
                "release requires a newer VibeX version",
            ));
        }
    }
    if package.version.trim_start_matches('v') != candidate.source.version.trim_start_matches('v') {
        return Err(PluginError::invalid_manifest(
            "downloaded package version does not match release",
        ));
    }
    if !candidate.source.package_digest.is_empty()
        && crate::package_content_digest(&package.source.path)?
            != candidate
                .source
                .package_digest
                .trim_start_matches("sha256:")
    {
        return Err(PluginError::invalid_manifest(
            "downloaded package digest does not match release",
        ));
    }
    Ok(())
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}
fn newer(current: &str, candidate: &str) -> bool {
    match (
        semver::Version::parse(current.trim_start_matches('v')),
        semver::Version::parse(candidate.trim_start_matches('v')),
    ) {
        (Ok(current), Ok(candidate)) => candidate > current,
        _ => false,
    }
}
