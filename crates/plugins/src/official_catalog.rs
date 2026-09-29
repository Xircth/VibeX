//! Host-side official plugin catalog (`vibex-plugin.json`).
//!
//! This is the identity of which plugins VibeX treats as official and where
//! their source repositories live. Plugin packages are not shipped inside the
//! Host installer; they are installed from the marketplace or a `.vxp`.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::catalog::{
    CatalogListing, CatalogPage, fold_official_listings, marketplace_plugin_slug, plugin_ids_match,
    prepare_marketplace_page,
};

const CATALOG_JSON: &str = include_str!("../../../vibex-plugin.json");

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPluginCatalog {
    pub schema_version: u32,
    pub marketplace: OfficialMarketplace,
    pub official: Vec<OfficialPluginRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialMarketplace {
    pub origin: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPluginRecord {
    pub id: String,
    #[serde(default)]
    pub publisher: String,
    pub repository: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub summary: String,
}

fn catalog() -> &'static OfficialPluginCatalog {
    static CATALOG: OnceLock<OfficialPluginCatalog> = OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(CATALOG_JSON).expect("vibex-plugin.json must parse"))
}

pub fn official_plugin_catalog() -> &'static OfficialPluginCatalog {
    catalog()
}

pub fn official_marketplace_origin() -> &'static str {
    catalog().marketplace.origin.trim_end_matches('/')
}

pub fn official_marketplace_home() -> String {
    let origin = official_marketplace_origin();
    let path = catalog().marketplace.path.trim();
    if path.is_empty() {
        format!("{origin}/marketplace")
    } else if path.starts_with('/') {
        format!("{origin}{path}")
    } else {
        format!("{origin}/{path}")
    }
}

pub fn official_plugin_record(plugin_id: &str) -> Option<&'static OfficialPluginRecord> {
    catalog().official.iter().find(|plugin| {
        plugin_ids_match(plugin_id, &plugin.id)
            || plugin_ids_match(&plugin.id, plugin_id)
            || marketplace_plugin_slug(plugin.publisher_or_vibex(), &plugin.id)
                .eq_ignore_ascii_case(plugin_id.trim())
    })
}

impl OfficialPluginRecord {
    fn publisher_or_vibex(&self) -> &str {
        if self.publisher.trim().is_empty() {
            "vibex"
        } else {
            self.publisher.trim()
        }
    }
}

pub fn official_plugin_category(plugin_id: &str) -> Option<&'static str> {
    official_plugin_record(plugin_id).and_then(|plugin| {
        let category = plugin.category.trim();
        if category.is_empty() {
            None
        } else {
            Some(plugin.category.as_str())
        }
    })
}

pub fn github_archive_urls_for_repository(repository: &str) -> Vec<String> {
    let trimmed = repository
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let Some((_, path)) = trimmed.split_once("github.com/") else {
        return Vec::new();
    };
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.contains("..") {
        return Vec::new();
    }
    vec![
        format!("https://codeload.github.com/{path}/tar.gz/refs/heads/main"),
        format!("https://codeload.github.com/{path}/tar.gz/main"),
    ]
}

pub fn listings_from_host_official_catalog() -> Vec<CatalogListing> {
    catalog()
        .official
        .iter()
        .map(listing_from_official_record)
        .collect()
}

fn listing_from_official_record(plugin: &OfficialPluginRecord) -> CatalogListing {
    let owner = plugin.publisher_or_vibex().to_owned();
    let plugin_name = marketplace_plugin_slug(&owner, &plugin.id);
    let download_url = github_archive_urls_for_repository(&plugin.repository)
        .into_iter()
        .next();
    CatalogListing {
        owner: owner.clone(),
        plugin_name: plugin_name.clone(),
        tag: String::new(),
        version: String::new(),
        display_name: plugin.id.clone(),
        summary: plugin.summary.clone(),
        category: if plugin.category.trim().is_empty() {
            "other".to_owned()
        } else {
            plugin.category.clone()
        },
        source_kind: "official".to_owned(),
        homepage: Some(crate::catalog::marketplace_listing_url(
            &owner,
            &plugin_name,
        )),
        repo: Some(plugin.repository.clone()),
        package_digest: None,
        download_url,
        sha256: None,
        offline_plugin_id: Some(plugin.id.clone()),
        has_worker: false,
        has_app: false,
        has_mcp: false,
        opens: Vec::new(),
        readme: None,
        show_tree: None,
        icon: None,
    }
}

pub fn merge_host_official_catalog(page: &mut CatalogPage) {
    let extra = listings_from_host_official_catalog();
    page.official = fold_official_listings(std::mem::take(&mut page.official), extra);
    prepare_marketplace_page(page);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_official_plugins_with_repositories() {
        let catalog = official_plugin_catalog();
        assert_eq!(catalog.marketplace.origin, "https://vibex.xforever.xin");
        assert!(
            catalog
                .official
                .iter()
                .any(|plugin| plugin.id == "vibex.browser"
                    && plugin.repository.contains("vibex-plugin-browser"))
        );
        assert!(
            catalog
                .official
                .iter()
                .any(|plugin| plugin.id == "vibex.open-connector")
        );
        assert!(official_plugin_record("browser").is_some());
        assert_eq!(official_plugin_category("vibex.multi-agent"), Some("agent"));
    }

    #[test]
    fn repository_becomes_codeload_tarball_urls() {
        let urls = github_archive_urls_for_repository(
            "https://github.com/Xircth/vibex-plugin-multi-agent.git",
        );
        assert!(
            urls.iter()
                .any(|url| url.contains("Xircth/vibex-plugin-multi-agent"))
        );
    }
}
