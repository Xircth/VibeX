//! Remote plugin marketplace catalog consumed by the Host.

use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{PluginContentDocument, PluginError, PluginPackage, PluginSourceKind};

pub const DEFAULT_MARKETPLACE_ORIGIN: &str = "https://vibex.xforever.xin";
pub const COMMUNITY_PAGE_SIZE: u32 = 50;

/// Retired package id → successor. Official marketplace must show one product.
pub const REPLACED_PLUGIN_IDS: &[(&str, &str)] = &[("vibex.collaboration", "vibex.multi-agent")];

/// Topic categories for Host-bundled packages. "official" is the vibex owner, not a topic.
const BUNDLED_TOPIC_CATEGORIES: &[(&str, &str)] = &[
    ("vibex.office", "productivity"),
    ("vibex.session-enhance", "productivity"),
    ("vibex.multi-agent", "agent"),
    ("vibex.workflow-creator", "workflow"),
    ("vibex.plugin-development", "other"),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogListing {
    pub owner: String,
    pub plugin_name: String,
    pub tag: String,
    pub version: String,
    pub display_name: String,
    pub summary: String,
    pub category: String,
    pub source_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline_plugin_id: Option<String>,
    #[serde(default)]
    pub has_worker: bool,
    #[serde(default)]
    pub has_app: bool,
    #[serde(default)]
    pub has_mcp: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub opens: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_tree: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub official: Vec<CatalogListing>,
    pub community: Vec<CatalogListing>,
    pub community_limit: u32,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub remote: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub tag: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateStatus {
    pub plugin_id: String,
    pub update_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPluginDetail {
    pub listing: CatalogListing,
    pub summary: String,
    pub readme: String,
    pub contents: Vec<PluginContentDocument>,
}

pub struct InstalledOrigin {
    pub plugin_id: String,
    pub version: String,
    pub kind: PluginSourceKind,
    pub origin: Option<String>,
    pub git_ref: Option<String>,
}

pub fn marketplace_origin() -> String {
    std::env::var("VIBEX_MARKETPLACE_URL")
        .ok()
        .map(|value| value.trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_MARKETPLACE_ORIGIN.to_owned())
}

pub fn marketplace_listing_url(owner: &str, plugin_name: &str) -> String {
    format!(
        "{}/marketplace/{}/{}",
        marketplace_origin(),
        owner,
        plugin_name
    )
}

pub fn listing_identity(listing: &CatalogListing) -> String {
    format!(
        "{}/{}/{}@{}",
        listing.owner, listing.plugin_name, listing.tag, listing.version
    )
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    let Ok(current) = semver::Version::parse(current.trim_start_matches('v')) else {
        return candidate != current;
    };
    let Ok(candidate) = semver::Version::parse(candidate.trim_start_matches('v')) else {
        return candidate != current.to_string();
    };
    candidate > current
}

pub fn listing_from_package(package: &PluginPackage, offline: bool) -> CatalogListing {
    let owner = package
        .publisher
        .clone()
        .unwrap_or_else(|| "vibex".to_owned());
    let plugin_name = package.id.as_str().to_owned();
    let opens = package
        .app
        .file_openers
        .iter()
        .flat_map(|opener| {
            opener
                .extensions
                .iter()
                .cloned()
                .chain(opener.file_name_suffixes.iter().cloned())
        })
        .collect();
    CatalogListing {
        owner: owner.clone(),
        plugin_name: plugin_name.clone(),
        tag: package.version.clone(),
        version: package.version.clone(),
        display_name: package.name.clone(),
        summary: package.summary.clone(),
        category: bundled_topic_category(package.id.as_str())
            .unwrap_or("productivity")
            .to_owned(),
        source_kind: if offline { "offline" } else { "official" }.to_owned(),
        homepage: Some(marketplace_listing_url(&owner, &plugin_name)),
        repo: None,
        package_digest: None,
        download_url: None,
        sha256: None,
        offline_plugin_id: Some(package.id.as_str().to_owned()),
        readme: None,
        has_worker: package.entrypoints.worker.is_some(),
        has_app: package.entrypoints.app.is_some() || !package.app.surfaces.is_empty(),
        has_mcp: package
            .mcp
            .as_object()
            .is_some_and(|object| !object.is_empty()),
        opens,
        show_tree: None,
    }
}

pub fn plugin_ids_match(id: &str, canonical: &str) -> bool {
    let id = id.trim();
    if id.eq_ignore_ascii_case(canonical) {
        return true;
    }
    canonical
        .rsplit_once('.')
        .is_some_and(|(_, suffix)| id.eq_ignore_ascii_case(suffix))
}

pub fn is_channel_category(category: &str) -> bool {
    category.eq_ignore_ascii_case("official") || category.eq_ignore_ascii_case("community")
}

pub fn bundled_topic_category(plugin_id: &str) -> Option<&'static str> {
    let canonical = canonical_plugin_id(plugin_id);
    BUNDLED_TOPIC_CATEGORIES
        .iter()
        .find(|(id, _)| plugin_ids_match(&canonical, id) || plugin_ids_match(plugin_id, id))
        .map(|(_, topic)| *topic)
}

pub fn normalize_listing_category(listing: &mut CatalogListing) {
    if !is_channel_category(&listing.category) && !listing.category.trim().is_empty() {
        return;
    }
    if let Some(topic) = bundled_topic_category(listing_package_id(listing))
        .or_else(|| bundled_topic_category(&listing.plugin_name))
    {
        listing.category = topic.to_owned();
    }
}

pub fn prepare_marketplace_page(page: &mut CatalogPage) {
    for listing in page.official.iter_mut().chain(page.community.iter_mut()) {
        normalize_listing_category(listing);
    }
}

pub fn successor_plugin_id(id: &str) -> Option<&'static str> {
    REPLACED_PLUGIN_IDS
        .iter()
        .find(|(retired, _)| plugin_ids_match(id, retired))
        .map(|(_, successor)| *successor)
}

pub fn canonical_plugin_id(id: &str) -> String {
    successor_plugin_id(id).unwrap_or(id.trim()).to_string()
}

pub fn listing_package_id(listing: &CatalogListing) -> &str {
    listing
        .offline_plugin_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(listing.plugin_name.as_str())
}

pub fn listing_is_retired(listing: &CatalogListing) -> bool {
    successor_plugin_id(listing_package_id(listing)).is_some()
        || successor_plugin_id(&listing.plugin_name).is_some()
}

pub fn canonical_listing_id(listing: &CatalogListing) -> String {
    successor_plugin_id(listing_package_id(listing))
        .or_else(|| successor_plugin_id(&listing.plugin_name))
        .map(str::to_string)
        .unwrap_or_else(|| canonical_plugin_id(listing_package_id(listing)))
}

pub fn collapse_replaced_official(listings: Vec<CatalogListing>) -> Vec<CatalogListing> {
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(listings.len());
    for listing in listings {
        if listing_is_retired(&listing) {
            continue;
        }
        if !seen.insert(canonical_listing_id(&listing)) {
            continue;
        }
        kept.push(listing);
    }
    kept.sort_by(|left, right| left.display_name.cmp(&right.display_name));
    kept
}

pub fn fold_official_listings(
    remote: Vec<CatalogListing>,
    extra: impl IntoIterator<Item = CatalogListing>,
) -> Vec<CatalogListing> {
    let mut listings = remote;
    listings.extend(extra);
    collapse_replaced_official(listings)
}

pub fn merge_offline_official(
    page: &mut CatalogPage,
    roots: impl IntoIterator<Item = impl AsRef<Path>>,
) {
    let extra = roots.into_iter().filter_map(|root| {
        PluginPackage::inspect(root.as_ref(), PluginSourceKind::Marketplace)
            .ok()
            .map(|package| listing_from_package(&package, true))
    });
    page.official = fold_official_listings(std::mem::take(&mut page.official), extra);
    prepare_marketplace_page(page);
}

pub async fn fetch_catalog(query: Option<&str>) -> Result<CatalogPage, PluginError> {
    let origin = marketplace_origin();
    let client = marketplace_client(8)?;
    let official = fetch_list(&client, &format!("{origin}/api/marketplace/v1/official")).await;
    let community = if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        fetch_list(
            &client,
            &format!(
                "{origin}/api/marketplace/v1/search?q={}",
                utf8_percent_encode(query)
            ),
        )
        .await
        .map(|items| {
            items
                .into_iter()
                .filter(|item| !is_official_category(&item.category))
                .collect()
        })
    } else {
        fetch_list(
            &client,
            &format!("{origin}/api/marketplace/v1/community?limit={COMMUNITY_PAGE_SIZE}&offset=0"),
        )
        .await
    };
    if official.is_ok() || community.is_ok() {
        return Ok(CatalogPage {
            official: collapse_replaced_official(official.unwrap_or_default()),
            community: community.unwrap_or_default(),
            community_limit: COMMUNITY_PAGE_SIZE,
            query: query.unwrap_or_default().to_owned(),
            remote: true,
        });
    }
    let published = fetch_list(&client, &format!("{origin}/api/marketplace/list")).await?;
    Ok(page_from_published(published, query))
}

pub async fn fetch_versions(
    owner: &str,
    plugin_name: &str,
) -> Result<Vec<CatalogVersion>, PluginError> {
    let origin = marketplace_origin();
    let client = marketplace_client(8)?;
    let url = format!("{origin}/api/marketplace/v1/listing/{owner}/{plugin_name}/versions");
    if let Ok(versions) = fetch_json::<Vec<CatalogVersion>>(&client, &url).await {
        return Ok(versions);
    }
    let listing = fetch_listing(owner, plugin_name).await?;
    Ok(vec![CatalogVersion {
        tag: listing.tag,
        version: listing.version,
        package_digest: listing.package_digest,
    }])
}

pub async fn fetch_listing(owner: &str, plugin_name: &str) -> Result<CatalogListing, PluginError> {
    let origin = marketplace_origin();
    let client = marketplace_client(8)?;
    let v1 = format!("{origin}/api/marketplace/v1/listing/{owner}/{plugin_name}");
    if let Ok(listing) = fetch_record(&client, &v1).await {
        return Ok(listing);
    }
    fetch_list(&client, &format!("{origin}/api/marketplace/list"))
        .await?
        .into_iter()
        .find(|item| item.owner == owner && item.plugin_name == plugin_name)
        .ok_or_else(|| PluginError::not_found(&format!("{owner}/{plugin_name}")))
}

pub fn detail_from_package(
    package: &PluginPackage,
    listing: CatalogListing,
) -> CatalogPluginDetail {
    let detail = package.product_detail().ok();
    CatalogPluginDetail {
        listing,
        summary: detail
            .as_ref()
            .map(|item| item.summary.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| package.summary.clone()),
        readme: detail
            .as_ref()
            .map(|item| item.readme.clone())
            .unwrap_or_default(),
        contents: detail.map(|item| item.contents).unwrap_or_default(),
    }
}

pub async fn fetch_artifact(
    owner: &str,
    plugin_name: &str,
    tag: Option<&str>,
) -> Result<CatalogListing, PluginError> {
    let origin = marketplace_origin();
    let client = marketplace_client(15)?;
    let mut v1 = format!("{origin}/api/marketplace/v1/artifact/{owner}/{plugin_name}");
    if let Some(tag) = tag.filter(|value| !value.is_empty()) {
        v1.push_str(&format!("?tag={}", utf8_percent_encode(tag)));
    }
    if let Ok(listing) = fetch_record(&client, &v1).await {
        return Ok(listing);
    }
    fetch_record(
        &client,
        &format!("{origin}/api/marketplace/artifact/{owner}/{plugin_name}"),
    )
    .await
}

pub fn marketplace_archive_suffix(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".zip") {
        "zip"
    } else if lower.contains(".tar.gz")
        || lower.contains(".tgz")
        || lower.contains("codeload.github.com")
    {
        "tar.gz"
    } else if lower.contains(".tar") {
        "tar"
    } else {
        "vxp"
    }
}

pub fn origin_kind(origin: Option<&str>) -> Option<&'static str> {
    let origin = origin?;
    if origin.contains("github.com") || origin.starts_with("github:") {
        Some("github")
    } else if origin.contains("marketplace") || origin.contains("xforever.xin") {
        Some("marketplace")
    } else {
        None
    }
}

pub fn source_allows_remote_update(kind: PluginSourceKind, origin: Option<&str>) -> bool {
    !matches!(
        kind,
        PluginSourceKind::DeveloperLink
            | PluginSourceKind::Builtin
            | PluginSourceKind::CodexNative
            | PluginSourceKind::ClaudeCodeNative
    ) && origin_kind(origin).is_some()
}

pub fn origin_owner_name(origin: &str, fallback_id: &str) -> (String, String) {
    if let Ok(url) = url::Url::parse(origin) {
        let parts: Vec<_> = url
            .path_segments()
            .map(|segments| {
                segments
                    .filter(|item| !item.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if parts.len() >= 2 {
            let owner = parts[parts.len() - 2].clone();
            let name = parts[parts.len() - 1].trim_end_matches(".git").to_owned();
            if owner != "marketplace" {
                return (owner, name);
            }
        }
    }
    if let Some((owner, name)) = fallback_id.split_once('.') {
        return (owner.to_owned(), name.to_owned());
    }
    ("vibex".to_owned(), fallback_id.to_owned())
}

pub async fn github_latest_tag(origin: &str) -> Result<String, PluginError> {
    let url = origin.trim_end_matches('/').trim_end_matches(".git");
    let rest = url
        .strip_prefix("https://github.com/")
        .ok_or_else(|| PluginError::not_found("github origin"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|error| PluginError::io("github client", error))?;
    let tags_api = format!("https://api.github.com/repos/{rest}/tags?per_page=100");
    if let Ok(response) = client
        .get(&tags_api)
        .header("user-agent", "VibeX")
        .send()
        .await
    {
        if response.status().is_success() {
            let body: Vec<serde_json::Value> = response
                .json()
                .await
                .map_err(|error| PluginError::io("github tags json", error))?;
            let mut tags: Vec<String> = body
                .iter()
                .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
                .map(str::to_owned)
                .collect();
            if !tags.is_empty() {
                tags.sort_by(|left, right| compare_version_desc(left, right));
                return Ok(tags[0].clone());
            }
        }
    }
    let api = format!("https://api.github.com/repos/{rest}/releases/latest");
    let response = client
        .get(api)
        .header("user-agent", "VibeX")
        .send()
        .await
        .map_err(|error| PluginError::io("github release", error))?;
    if !response.status().is_success() {
        return Err(PluginError::not_found("github release"));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| PluginError::io("github release json", error))?;
    body.get("tag_name")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .ok_or_else(|| PluginError::not_found("github tag"))
}

fn compare_version_desc(left: &str, right: &str) -> std::cmp::Ordering {
    if is_newer_version(right, left) {
        std::cmp::Ordering::Less
    } else if is_newer_version(left, right) {
        std::cmp::Ordering::Greater
    } else {
        right.cmp(left)
    }
}

fn newest_catalog_version(mut versions: Vec<CatalogVersion>) -> Option<CatalogVersion> {
    versions.sort_by(|left, right| {
        let by_version = compare_version_desc(&left.version, &right.version);
        if by_version != std::cmp::Ordering::Equal {
            return by_version;
        }
        compare_version_desc(&left.tag, &right.tag)
    });
    versions.into_iter().next()
}

pub async fn check_installed_updates(plugins: &[InstalledOrigin]) -> Vec<PluginUpdateStatus> {
    let mut updates = Vec::new();
    for plugin in plugins {
        if !source_allows_remote_update(plugin.kind, plugin.origin.as_deref()) {
            continue;
        }
        let origin = plugin.origin.clone().unwrap_or_default();
        let (owner, name) = origin_owner_name(&origin, &plugin.plugin_id);
        let current = plugin
            .git_ref
            .clone()
            .unwrap_or_else(|| plugin.version.clone());
        let available = if origin_kind(Some(&origin)) == Some("github") {
            github_latest_tag(&origin)
                .await
                .ok()
                .map(|tag| CatalogVersion {
                    tag: tag.clone(),
                    version: tag,
                    package_digest: None,
                })
        } else {
            fetch_versions(&owner, &name)
                .await
                .ok()
                .and_then(newest_catalog_version)
        };
        let update_available = available.as_ref().is_some_and(|item| {
            is_newer_version(&current, &item.tag)
                || is_newer_version(&current, &item.version)
                || is_newer_version(&plugin.version, &item.version)
        });
        if update_available {
            updates.push(PluginUpdateStatus {
                plugin_id: plugin.plugin_id.clone(),
                update_available: true,
                available_tag: Some(available.as_ref().unwrap().tag.clone()),
                available_version: Some(available.as_ref().unwrap().version.clone()),
            });
        }
    }
    updates
}

fn utf8_percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedRecord {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    author_id: String,
    #[serde(default)]
    plugin_name: String,
    #[serde(default)]
    plugin_id: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    source_kind: String,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    package_digest: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    readme: Option<String>,
    #[serde(default)]
    github_owner: Option<String>,
    #[serde(default)]
    github_repo: Option<String>,
    #[serde(default)]
    github_branch: Option<String>,
    #[serde(default)]
    show_tree: Option<bool>,
}

impl PublishedRecord {
    fn into_listing(self) -> Option<CatalogListing> {
        let owner = nonempty(&self.owner).or_else(|| nonempty(&self.author_id))?;
        let plugin_name = nonempty(&self.plugin_name).or_else(|| nonempty(&self.plugin_id))?;
        let version = nonempty(&self.version).unwrap_or_else(|| "0.0.0".to_owned());
        let tag = nonempty(&self.tag)
            .or_else(|| {
                self.github_branch
                    .clone()
                    .and_then(|value| nonempty(&value))
            })
            .unwrap_or_else(|| version.clone());
        let display_name = nonempty(&self.display_name)
            .or_else(|| nonempty(&self.name))
            .unwrap_or_else(|| plugin_name.clone());
        let repo = self
            .repo
            .clone()
            .and_then(|value| nonempty(&value))
            .or_else(|| match (&self.github_owner, &self.github_repo) {
                (Some(owner), Some(repo))
                    if !owner.trim().is_empty() && !repo.trim().is_empty() =>
                {
                    Some(format!("https://github.com/{owner}/{repo}"))
                }
                _ => None,
            });
        let homepage = self
            .homepage
            .and_then(|value| nonempty(&value))
            .or_else(|| repo.clone());
        Some(CatalogListing {
            owner,
            plugin_name,
            tag,
            version,
            display_name,
            summary: self.summary,
            category: nonempty(&self.category).unwrap_or_else(|| "community".to_owned()),
            source_kind: nonempty(&self.source_kind).unwrap_or_else(|| "marketplace".to_owned()),
            homepage,
            repo,
            package_digest: self.package_digest.and_then(|value| nonempty(&value)),
            download_url: self.download_url.and_then(|value| nonempty(&value)),
            sha256: self.sha256.and_then(|value| nonempty(&value)),
            offline_plugin_id: None,
            has_worker: false,
            has_app: false,
            has_mcp: false,
            opens: Vec::new(),
            readme: self.readme.and_then(|value| nonempty(&value)),
            show_tree: self.show_tree.or_else(|| {
                nonempty(&self.source_kind).map(|kind| kind.eq_ignore_ascii_case("github"))
            }),
        })
    }
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn is_official_category(category: &str) -> bool {
    category.eq_ignore_ascii_case("official")
}

fn page_from_published(items: Vec<CatalogListing>, query: Option<&str>) -> CatalogPage {
    let needle = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    let mut official = Vec::new();
    let mut community = Vec::new();
    for item in items {
        if let Some(needle) = needle.as_deref()
            && !item.display_name.to_ascii_lowercase().contains(needle)
            && !item.summary.to_ascii_lowercase().contains(needle)
            && !item.plugin_name.to_ascii_lowercase().contains(needle)
            && !item.owner.to_ascii_lowercase().contains(needle)
        {
            continue;
        }
        if is_official_category(&item.category) {
            official.push(item);
        } else {
            community.push(item);
        }
    }
    official = collapse_replaced_official(official);
    if needle.is_none() {
        community.truncate(COMMUNITY_PAGE_SIZE as usize);
    }
    CatalogPage {
        official,
        community,
        community_limit: COMMUNITY_PAGE_SIZE,
        query: query.unwrap_or_default().to_owned(),
        remote: true,
    }
}

fn marketplace_client(timeout_secs: u64) -> Result<reqwest::Client, PluginError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| PluginError::io("marketplace client", error))
}

async fn fetch_list(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<CatalogListing>, PluginError> {
    let records = fetch_json::<Vec<PublishedRecord>>(client, url).await?;
    Ok(records
        .into_iter()
        .filter_map(PublishedRecord::into_listing)
        .map(|item| absolutize_listing(url, item))
        .collect())
}

async fn fetch_record(client: &reqwest::Client, url: &str) -> Result<CatalogListing, PluginError> {
    let record = fetch_json::<PublishedRecord>(client, url).await?;
    record
        .into_listing()
        .map(|item| absolutize_listing(url, item))
        .ok_or_else(|| PluginError::not_found(url))
}

async fn fetch_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, PluginError> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| PluginError::io("marketplace list", error))?;
    if !response.status().is_success() {
        return Err(PluginError::io(
            "marketplace list",
            response.status().as_str(),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| PluginError::io("marketplace list body", error))?;
    let trimmed = bytes
        .iter()
        .find(|byte| !byte.is_ascii_whitespace())
        .copied()
        .unwrap_or(0);
    if trimmed != b'{' && trimmed != b'[' {
        return Err(PluginError::io(
            "marketplace list json",
            "response was not JSON",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| PluginError::io("marketplace list json", error))
}

fn absolutize_listing(request_url: &str, mut listing: CatalogListing) -> CatalogListing {
    let origin = request_url
        .parse::<url::Url>()
        .ok()
        .and_then(|parsed| Some(format!("{}://{}", parsed.scheme(), parsed.host_str()?)));
    if let Some(origin) = origin {
        listing.download_url = listing
            .download_url
            .map(|value| absolutize_url(&origin, &value));
        listing.homepage = listing
            .homepage
            .map(|value| absolutize_url(&origin, &value));
    }
    listing
}

fn absolutize_url(origin: &str, value: &str) -> String {
    if value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("builtin://")
        || value.starts_with("offline://")
        || value.starts_with("file:")
    {
        value.to_owned()
    } else if value.starts_with('/') {
        format!("{origin}{value}")
    } else {
        format!("{origin}/{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_semver_wins() {
        assert!(is_newer_version("1.0.0", "1.1.0"));
        assert!(!is_newer_version("1.2.0", "1.1.9"));
        assert!(is_newer_version("1.0.0", "v1.0.1"));
        assert_eq!(
            newest_catalog_version(vec![
                CatalogVersion {
                    tag: "v1.0.0".into(),
                    version: "1.0.0".into(),
                    package_digest: None,
                },
                CatalogVersion {
                    tag: "v1.2.0".into(),
                    version: "1.2.0".into(),
                    package_digest: None,
                },
                CatalogVersion {
                    tag: "v1.1.0".into(),
                    version: "1.1.0".into(),
                    package_digest: None,
                },
            ])
            .unwrap()
            .version,
            "1.2.0"
        );
    }

    #[test]
    fn origin_lock_distinguishes_github_from_marketplace() {
        assert_eq!(
            origin_kind(Some("https://github.com/acme/notes")),
            Some("github")
        );
        assert_eq!(
            origin_kind(Some("https://vibex.xforever.xin/marketplace/vibex/office")),
            Some("marketplace")
        );
        assert!(source_allows_remote_update(
            PluginSourceKind::Snapshot,
            Some("https://github.com/acme/notes")
        ));
        assert!(!source_allows_remote_update(
            PluginSourceKind::DeveloperLink,
            Some("https://github.com/acme/notes")
        ));
    }

    #[test]
    fn website_list_record_maps_to_catalog_listing() {
        let record: PublishedRecord = serde_json::from_str(
            r#"{
                "pluginId": "drawio",
                "authorId": "vibex",
                "name": "Drawio",
                "summary": "Drawio diagrams in VibeX.",
                "version": "1.0.0",
                "category": "productivity",
                "sourceKind": "github",
                "repo": "https://github.com/Xircth/vibex-drawio",
                "githubOwner": "Xircth",
                "githubRepo": "vibex-drawio",
                "githubBranch": "main"
            }"#,
        )
        .unwrap();
        let listing = record.into_listing().unwrap();
        assert_eq!(listing.owner, "vibex");
        assert_eq!(listing.plugin_name, "drawio");
        assert_eq!(listing.display_name, "Drawio");
        assert_eq!(listing.tag, "main");
        assert_eq!(listing.version, "1.0.0");
        assert_eq!(listing.category, "productivity");
        assert_eq!(listing.source_kind, "github");
        assert_eq!(listing.show_tree, Some(true));
        assert_eq!(
            listing.repo.as_deref(),
            Some("https://github.com/Xircth/vibex-drawio")
        );
    }

    #[test]
    fn published_catalog_keeps_non_official_plugins_in_community() {
        let drawio = CatalogListing {
            owner: "vibex".into(),
            plugin_name: "drawio".into(),
            tag: "main".into(),
            version: "1.0.0".into(),
            display_name: "Drawio".into(),
            summary: "Drawio diagrams in VibeX.".into(),
            category: "productivity".into(),
            source_kind: "github".into(),
            homepage: None,
            repo: None,
            package_digest: None,
            download_url: None,
            sha256: None,
            offline_plugin_id: None,
            has_worker: false,
            has_app: false,
            has_mcp: false,
            opens: Vec::new(),
            readme: None,
            show_tree: Some(true),
        };
        let office = CatalogListing {
            display_name: "Office".into(),
            plugin_name: "office".into(),
            category: "official".into(),
            ..drawio.clone()
        };
        let page = page_from_published(vec![drawio.clone(), office], None);
        assert_eq!(page.official.len(), 1);
        assert_eq!(page.community.len(), 1);
        assert_eq!(page.community[0].plugin_name, "drawio");
        let searched = page_from_published(vec![drawio], Some("draw"));
        assert_eq!(searched.community.len(), 1);
    }

    #[test]
    fn github_tarball_uses_tar_gz_suffix() {
        assert_eq!(
            marketplace_archive_suffix(
                "https://codeload.github.com/Xircth/vibex-drawio/tar.gz/main"
            ),
            "tar.gz"
        );
        assert_eq!(
            marketplace_archive_suffix("https://vibex.xforever.xin/files/a.vxp"),
            "vxp"
        );
    }

    fn listing(plugin_name: &str, display_name: &str, summary: &str) -> CatalogListing {
        CatalogListing {
            owner: "vibex".into(),
            plugin_name: plugin_name.into(),
            tag: "v1.0.0".into(),
            version: "1.0.0".into(),
            display_name: display_name.into(),
            summary: summary.into(),
            category: "official".into(),
            source_kind: "official".into(),
            homepage: None,
            repo: None,
            package_digest: None,
            download_url: None,
            sha256: None,
            offline_plugin_id: None,
            has_worker: false,
            has_app: false,
            has_mcp: true,
            opens: Vec::new(),
            readme: None,
            show_tree: None,
        }
    }

    #[test]
    fn official_catalog_keeps_one_multi_agent_product() {
        let collaboration = listing(
            "collaboration",
            "VibeX Collaboration",
            "让父 Agent 通过 vibex-mcp 把工作委派给其它 Agent。",
        );
        let successor = listing(
            "vibex.multi-agent",
            "多智能体协同",
            "让父 Agent 把子任务委托给其它 Agent。",
        );
        let office = listing("vibex.office", "办公套件", "Office files");
        let folded = fold_official_listings(
            vec![collaboration.clone(), successor.clone(), office.clone()],
            None,
        );
        assert_eq!(
            folded
                .iter()
                .map(|item| item.plugin_name.as_str())
                .collect::<Vec<_>>(),
            vec!["vibex.office", "vibex.multi-agent"]
        );

        let from_retired_only = fold_official_listings(vec![collaboration], [successor.clone()]);
        assert_eq!(from_retired_only.len(), 1);
        assert_eq!(from_retired_only[0].plugin_name, "vibex.multi-agent");
        assert_eq!(from_retired_only[0].display_name, "多智能体协同");

        let mut page = CatalogPage {
            official: vec![listing(
                "vibex.collaboration",
                "VibeX Collaboration",
                "retired",
            )],
            ..CatalogPage::default()
        };
        page.official = fold_official_listings(page.official, [successor]);
        assert_eq!(page.official.len(), 1);
        assert_eq!(page.official[0].plugin_name, "vibex.multi-agent");
    }

    #[test]
    fn official_listings_use_topic_categories_not_official_as_category() {
        let mut session = listing(
            "vibex.session-enhance",
            "会话增强",
            "让父 Agent 把子任务委托给其它 Agent。",
        );
        session.category = "official".into();
        normalize_listing_category(&mut session);
        assert_eq!(session.category, "productivity");
        assert_eq!(bundled_topic_category("vibex.multi-agent"), Some("agent"));
        assert_eq!(
            bundled_topic_category("vibex.workflow-creator"),
            Some("workflow")
        );
    }
}
