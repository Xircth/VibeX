//! Built-in 1,700+ Connector Marketplace catalog index and category taxonomy.
//!
//! Combines curated/featured MCP servers, the official MCP registry snapshot,
//! and the 1,500+ Open Connector (Oomol / Composio) application providers so
//! opening the Connector Marketplace returns categorized cards immediately
//! with zero network latency, while online Smithery / Official Registry queries
//! can dynamically merge on top.

use std::{collections::BTreeSet, sync::LazyLock};

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    McpError, McpMarketplaceInstallOption, McpMarketplaceInstallParameter, McpMarketplaceItem,
    McpMarketplaceServerDetail, bad, canonicalize_spec, collect_protocols_from_options, not_found,
    select_default_install_option, select_install_option, value_as_text,
};

pub const MARKETPLACE_CONNECTOR_CATALOG: &str = "connector_catalog";
pub const MARKETPLACE_OPEN_CONNECTOR: &str = "open_connector";
pub const MARKETPLACE_BUILTIN: &str = "builtin";

pub const CONNECTOR_CATEGORIES: [&str; 8] = [
    "developer_tools",
    "analytics",
    "model_context_protocol",
    "marketing_automation",
    "social",
    "productivity",
    "communication",
    "design",
];

#[derive(Debug, Clone, Deserialize)]
struct SnapshotApiKeyField {
    key: String,
    label: String,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    env_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SnapshotCatalogEntry {
    id: String,
    provider_id: String,
    server_id: String,
    name: String,
    description: String,
    category: String,
    kind: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    remote: bool,
    #[serde(default)]
    verified: bool,
    #[serde(default)]
    protocols: Vec<String>,
    default_spec: Value,
    #[serde(default)]
    api_key_field: Option<SnapshotApiKeyField>,
}

static SNAPSHOT_ENTRIES: LazyLock<Vec<SnapshotCatalogEntry>> = LazyLock::new(|| {
    let raw = include_str!("connector_catalog_snapshot.json");
    serde_json::from_str::<Vec<SnapshotCatalogEntry>>(raw)
        .expect("connector_catalog_snapshot.json must be valid JSON")
});

pub fn normalize_connector_category(raw: Option<&str>, name: &str, description: &str) -> String {
    if let Some(raw_val) = raw {
        let lower = raw_val.trim().to_ascii_lowercase();
        match lower.as_str() {
            "developer_tools" | "developer-tools" | "developer tools" | "devtools"
            | "开发者工具" => {
                return "developer_tools".to_string();
            }
            "analytics" | "data" | "data & analytics" | "分析" => {
                return "analytics".to_string();
            }
            "model_context_protocol" | "model context protocol" | "mcp" => {
                return "model_context_protocol".to_string();
            }
            "marketing_automation" | "marketing automation" | "marketing" => {
                return "marketing_automation".to_string();
            }
            "social" | "社交" => {
                return "social".to_string();
            }
            "productivity" | "生产力" => {
                return "productivity".to_string();
            }
            "communication" | "通信" => {
                return "communication".to_string();
            }
            "design" | "design & media" | "设计" => {
                return "design".to_string();
            }
            _ => {}
        }
    }

    let combined = format!("{name} {description}").to_ascii_lowercase();
    if ["figma", "canva", "excalidraw", "mermaid", "design", "svg"]
        .iter()
        .any(|kw| combined.contains(kw))
    {
        return "design".to_string();
    }
    if [
        "slack", "discord", "gmail", "telegram", "whatsapp", "email", "chat", "message",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "communication".to_string();
    }
    if [
        "notion",
        "linear",
        "jira",
        "confluence",
        "calendar",
        "todo",
        "task",
        "productivity",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "productivity".to_string();
    }
    if [
        "twitter",
        "reddit",
        "linkedin",
        "youtube",
        "instagram",
        "tiktok",
        "social",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "social".to_string();
    }
    if [
        "hubspot",
        "mailchimp",
        "klaviyo",
        "stripe",
        "shopify",
        "salesforce",
        "crm",
        "marketing",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "marketing_automation".to_string();
    }
    if [
        "serpapi",
        "exa",
        "snowflake",
        "bigquery",
        "posthog",
        "datadog",
        "analytics",
        "sql",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "analytics".to_string();
    }
    if [
        "github",
        "gitlab",
        "supabase",
        "firecrawl",
        "sentry",
        "cloudflare",
        "vercel",
        "docker",
        "git",
        "playwright",
    ]
    .iter()
    .any(|kw| combined.contains(kw))
    {
        return "developer_tools".to_string();
    }

    "model_context_protocol".to_string()
}

fn entry_matches_installed(entry: &SnapshotCatalogEntry, installed_ids: &BTreeSet<String>) -> bool {
    let id_low = entry.id.to_ascii_lowercase();
    let srv_low = entry.server_id.to_ascii_lowercase();
    let base_id = id_low.trim_end_matches("-mcp");
    installed_ids.contains(&id_low)
        || installed_ids.contains(&srv_low)
        || installed_ids.contains(base_id)
        || installed_ids.contains(&format!("{base_id}-mcp"))
}

fn entry_to_marketplace_item(
    entry: &SnapshotCatalogEntry,
    installed_ids: &BTreeSet<String>,
) -> McpMarketplaceItem {
    let status = if entry_matches_installed(entry, installed_ids) {
        Some("connected".to_string())
    } else if entry.status.as_deref() == Some("included") {
        Some("included".to_string())
    } else {
        Some("available".to_string())
    };

    McpMarketplaceItem {
        provider_id: entry.provider_id.clone(),
        server_id: entry.server_id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        homepage: entry.homepage.clone(),
        remote: entry.remote,
        verified: entry.verified,
        icon_url: entry.icon_url.clone(),
        latest_version: None,
        protocols: if entry.protocols.is_empty() {
            vec!["stdio".to_string()]
        } else {
            entry.protocols.clone()
        },
        owner: None,
        namespace: None,
        downloads: None,
        score: None,
        is_deployed: Some(entry.remote),
        category: Some(normalize_connector_category(
            Some(&entry.category),
            &entry.name,
            &entry.description,
        )),
        kind: Some(entry.kind.clone()),
        status,
        default_spec: Some(entry.default_spec.clone()),
    }
}

pub fn catalog_total_count() -> usize {
    SNAPSHOT_ENTRIES.len()
}

pub fn search_builtin_catalog(
    query: &str,
    category: Option<&str>,
    limit: usize,
    installed_ids: &BTreeSet<String>,
) -> Vec<McpMarketplaceItem> {
    let q = query.trim().to_ascii_lowercase();
    let normalized_cat = category
        .map(str::trim)
        .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case("all"))
        .map(|c| normalize_connector_category(Some(c), "", ""));

    let mut out = Vec::new();
    for entry in SNAPSHOT_ENTRIES.iter() {
        if let Some(ref cat) = normalized_cat
            && &entry.category != cat
        {
            continue;
        }
        if !q.is_empty() {
            let matches = entry.name.to_ascii_lowercase().contains(&q)
                || entry.server_id.to_ascii_lowercase().contains(&q)
                || entry.id.to_ascii_lowercase().contains(&q)
                || entry.description.to_ascii_lowercase().contains(&q)
                || entry.category.to_ascii_lowercase().contains(&q);
            if !matches {
                continue;
            }
        }
        out.push(entry_to_marketplace_item(entry, installed_ids));
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn find_snapshot_entry(server_id: &str) -> Option<&'static SnapshotCatalogEntry> {
    let needle = server_id.trim().to_ascii_lowercase();
    let stripped = needle
        .trim_start_matches('@')
        .split('/')
        .next_back()
        .unwrap_or(&needle);
    let base = stripped.trim_end_matches("-mcp");
    SNAPSHOT_ENTRIES.iter().find(|entry| {
        let id_low = entry.id.to_ascii_lowercase();
        let srv_low = entry.server_id.to_ascii_lowercase();
        let name_low = entry.name.to_ascii_lowercase();
        let entry_base = id_low.trim_end_matches("-mcp");
        id_low == needle
            || srv_low == needle
            || name_low == needle
            || id_low == stripped
            || srv_low == stripped
            || entry_base == base
    })
}

fn build_snapshot_install_options(
    entry: &SnapshotCatalogEntry,
) -> Result<Vec<McpMarketplaceInstallOption>, McpError> {
    let protocol = entry
        .default_spec
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(if entry.remote { "http" } else { "stdio" })
        .to_string();

    let spec = canonicalize_spec(&entry.default_spec, "connector catalog default_spec")
        .unwrap_or_else(|_| {
            json!({
                "type": "stdio",
                "command": "npx",
                "args": ["-y", entry.server_id]
            })
        });

    let mut parameters = Vec::new();
    if let Some(ref field) = entry.api_key_field {
        parameters.push(McpMarketplaceInstallParameter {
            key: field.key.clone(),
            label: field.label.clone(),
            description: None,
            required: true,
            secret: true,
            kind: "string".to_string(),
            default_value: None,
            placeholder: field.placeholder.clone(),
            enum_values: Vec::new(),
            location: Some("env".to_string()),
        });
    }

    Ok(vec![McpMarketplaceInstallOption {
        id: format!("catalog:{}:{protocol}", entry.id),
        protocol: protocol.clone(),
        label: format!("{protocol} (default)"),
        description: Some(entry.description.clone()),
        spec,
        parameters,
    }])
}

pub fn get_snapshot_server_detail(
    server_id: &str,
    installed_ids: &BTreeSet<String>,
) -> Option<McpMarketplaceServerDetail> {
    let entry = find_snapshot_entry(server_id)?;
    let install_options = build_snapshot_install_options(entry).ok()?;
    let default_option = select_default_install_option(&install_options);
    let spec = default_option
        .map(|opt| opt.spec.clone())
        .unwrap_or_else(|| entry.default_spec.clone());
    let item = entry_to_marketplace_item(entry, installed_ids);

    Some(McpMarketplaceServerDetail {
        provider_id: item.provider_id,
        server_id: item.server_id,
        name: item.name,
        description: item.description,
        homepage: item.homepage,
        remote: item.remote,
        verified: item.verified,
        icon_url: item.icon_url,
        latest_version: item.latest_version,
        protocols: collect_protocols_from_options(&install_options),
        owner: item.owner,
        namespace: item.namespace,
        downloads: item.downloads,
        score: item.score,
        is_deployed: item.is_deployed,
        category: item.category,
        kind: item.kind,
        status: item.status,
        default_option_id: default_option.map(|opt| opt.id.clone()),
        install_options,
        spec,
    })
}

pub fn resolve_snapshot_install_spec(
    server_id: &str,
    option_id: &Option<String>,
    values: &Map<String, Value>,
) -> Result<Value, McpError> {
    let entry = find_snapshot_entry(server_id).ok_or_else(|| {
        not_found(format!(
            "connector '{}' not found in built-in catalog",
            server_id
        ))
    })?;
    let options = build_snapshot_install_options(entry)?;
    let selected = select_install_option(&options, option_id)
        .ok_or_else(|| not_found("no install option available for connector"))?;

    let mut spec = selected.spec.clone();
    if let Some(ref field) = entry.api_key_field {
        let provided = values.get(&field.key).and_then(value_as_text);
        if let Some(secret_val) = provided {
            let env_key = field.env_key.as_deref().unwrap_or(&field.key).to_string();
            if let Some(obj) = spec.as_object_mut() {
                if obj.get("type").and_then(Value::as_str) == Some("http")
                    || obj.get("type").and_then(Value::as_str) == Some("sse")
                {
                    let headers = obj
                        .entry("headers".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(hmap) = headers.as_object_mut() {
                        hmap.insert(
                            "Authorization".to_string(),
                            Value::String(format!("Bearer {secret_val}")),
                        );
                    }
                } else {
                    let env = obj
                        .entry("env".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(emap) = env.as_object_mut() {
                        emap.insert(env_key, Value::String(secret_val));
                    }
                }
            }
        } else {
            return Err(bad(format!("missing required configuration '{}'", field.key)));
        }
    }

    canonicalize_spec(&spec, "connector catalog install")
}
