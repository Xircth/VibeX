//! Inspect-time provider catalog templates (ADR-0079).
//!
//! v1 catalogs are static JSON resources. The Host parses them while inspecting
//! a package, caches the templates on the contribution, and lists the enabled
//! ones through `provider_catalog_list`. A handler field is rejected.

use std::{collections::BTreeSet, fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use crate::{PackageWarning, PluginError};

pub const MAX_CATALOGS_PER_PLUGIN: usize = 16;
pub const MAX_TEMPLATES_PER_CONTRIBUTION: usize = 500;
pub const MAX_RESOURCE_BYTES: u64 = 2 * 1024 * 1024;

const SECRET_KEYS: &[&str] = &["apikey", "api_key", "token", "authorization", "auth"];
const FORBIDDEN_FIELDS: &[&str] = &[
    "settingsConfig",
    "apiFormat",
    "requiresOAuth",
    "providerType",
    "theme",
    "partnerPromotionKey",
    "isPartner",
    "primePartner",
    "hidden",
    "extras",
    "handler",
];
const URL_FIELDS: &[&str] = &["apiUrl", "websiteUrl", "apiKeyUrl", "baseUrl"];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCatalogSurface {
    Reusable,
    Opencode,
    Dsh,
}

impl ProviderCatalogSurface {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reusable => "reusable",
            Self::Opencode => "opencode",
            Self::Dsh => "dsh",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "reusable" => Some(Self::Reusable),
            "opencode" => Some(Self::Opencode),
            "dsh" => Some(Self::Dsh),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalogModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalogTemplate {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoint_candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_field: Option<String>,
    pub category: String,
    pub surface: ProviderCatalogSurface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ProviderCatalogModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCatalogContribution {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub resource: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub agent_id: String,
    pub templates: Vec<ProviderCatalogTemplate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalogTemplateView {
    pub id: String,
    pub plugin_id: String,
    pub contribution_id: String,
    pub plugin_label: String,
    pub agent_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoint_candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_field: Option<String>,
    pub category: String,
    pub surface: ProviderCatalogSurface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ProviderCatalogModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalogSourceView {
    pub plugin_id: String,
    pub contribution_id: String,
    pub label: String,
    pub template_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalogListView {
    pub agent_id: String,
    pub generation: u64,
    pub templates: Vec<ProviderCatalogTemplateView>,
    pub sources: Vec<ProviderCatalogSourceView>,
}

pub struct CatalogListInput<'a> {
    pub plugin_id: &'a str,
    pub plugin_label: &'a str,
    pub contribution: &'a ProviderCatalogContribution,
}

pub fn expected_catalog_surface(agent_id: &str) -> ProviderCatalogSurface {
    match agent_id {
        "opencode" | "mimo_code" => ProviderCatalogSurface::Opencode,
        "deepseek_harness" => ProviderCatalogSurface::Dsh,
        _ => ProviderCatalogSurface::Reusable,
    }
}

pub fn normalize_catalog_category(value: Option<&str>) -> String {
    match value {
        Some("official" | "prime" | "partner" | "community") => value.unwrap().to_owned(),
        _ => "community".to_owned(),
    }
}

pub fn load_provider_catalog_contribution(
    root: &Path,
    integration: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> Option<ProviderCatalogContribution> {
    if integration.contains_key("handler") {
        return None;
    }
    let id = text(integration, "id")?;
    let label = text(integration, "label")?;
    let resource = text(integration, "resource")?;
    let agents = match integration.get("agents") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    let icon = match integration.get("icon") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) if crate::CONTRIBUTION_ICONS.contains(&name.as_str()) => {
            Some(name.clone())
        }
        Some(_) => return None,
    };
    let description = integration
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let relative = resource.replace('\\', "/");
    if !is_package_relative(&relative) {
        return None;
    }
    let path = root.join(&relative);
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    if metadata.len() > MAX_RESOURCE_BYTES {
        warnings.push(warn(
            "provider_catalog_truncated",
            format!("catalog resource `{relative}` exceeds 2 MiB and was ignored"),
            Some(&id),
        ));
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let file: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(warn(
                "provider_catalog_invalid",
                format!("catalog resource `{relative}` is not JSON: {error}"),
                Some(&id),
            ));
            return None;
        }
    };
    let object = file.as_object()?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        warnings.push(warn(
            "provider_catalog_invalid",
            format!("catalog resource `{relative}` schemaVersion must be 1"),
            Some(&id),
        ));
        return None;
    }
    let agent_id = object.get("agentId").and_then(Value::as_str)?.trim();
    if agent_id.is_empty() {
        return None;
    }
    let agent_id = agent_id.to_owned();
    if !agents.is_empty() && !agents.iter().any(|item| item == &agent_id) {
        warnings.push(warn(
            "provider_catalog_template_invalid",
            format!(
                "catalog `{id}` agentId `{agent_id}` is outside the contribution agents filter"
            ),
            Some(&id),
        ));
        return None;
    }

    let mut forbidden = Vec::new();
    inspect_forbidden(&file, "catalog", &mut forbidden);
    if !forbidden.is_empty() {
        warnings.push(warn(forbidden[0].0, forbidden[0].1.clone(), Some(&id)));
        return None;
    }

    let raw_templates = object.get("templates").and_then(Value::as_array)?;
    let mut templates = Vec::new();
    for (index, value) in raw_templates.iter().enumerate() {
        if templates.len() >= MAX_TEMPLATES_PER_CONTRIBUTION {
            warnings.push(warn(
                "provider_catalog_truncated",
                format!("catalog `{id}` truncated to {MAX_TEMPLATES_PER_CONTRIBUTION} templates"),
                Some(&id),
            ));
            break;
        }
        match parse_template(value, &agent_id) {
            Ok(template) => templates.push(template),
            Err(message) => warnings.push(warn(
                "provider_catalog_template_invalid",
                format!("catalog `{id}` templates[{index}]: {message}"),
                Some(&id),
            )),
        }
    }

    Some(ProviderCatalogContribution {
        id,
        label,
        icon,
        resource: relative,
        agents,
        description,
        agent_id,
        templates,
        error: None,
    })
}

pub fn aggregate_provider_catalogs(
    agent_id: &str,
    generation: u64,
    inputs: &[CatalogListInput<'_>],
) -> ProviderCatalogListView {
    let mut sources = Vec::new();
    let mut ranked: Vec<(u8, String, String, usize, ProviderCatalogTemplateView)> = Vec::new();
    for input in inputs {
        let contribution = input.contribution;
        if !contribution.agents.is_empty()
            && !contribution.agents.iter().any(|item| item == agent_id)
        {
            continue;
        }
        if contribution.agent_id != agent_id {
            continue;
        }
        sources.push(ProviderCatalogSourceView {
            plugin_id: input.plugin_id.to_owned(),
            contribution_id: contribution.id.clone(),
            label: contribution.label.clone(),
            template_count: contribution.templates.len() as u32,
            error: contribution.error.clone(),
        });
        for (index, template) in contribution.templates.iter().enumerate() {
            if template.agent_id != agent_id {
                continue;
            }
            let category = normalize_catalog_category(Some(template.category.as_str()));
            let rank = match category.as_str() {
                "official" => 0,
                "prime" => 1,
                "partner" => 2,
                _ => 3,
            };
            ranked.push((
                rank,
                input.plugin_id.to_owned(),
                contribution.id.clone(),
                index,
                template_view(input, template, category),
            ));
        }
    }

    ranked.sort_by(|left, right| {
        left.0.cmp(&right.0).then_with(|| {
            if left.0 < 3 {
                left.1
                    .cmp(&right.1)
                    .then_with(|| left.2.cmp(&right.2))
                    .then_with(|| left.3.cmp(&right.3))
            } else {
                left.4
                    .name
                    .locale_cmp(&right.4.name)
                    .then_with(|| left.1.cmp(&right.1))
                    .then_with(|| left.2.cmp(&right.2))
                    .then_with(|| left.4.id.cmp(&right.4.id))
            }
        })
    });

    ProviderCatalogListView {
        agent_id: agent_id.to_owned(),
        generation,
        templates: ranked.into_iter().map(|item| item.4).collect(),
        sources,
    }
}

trait LocaleName {
    fn locale_cmp(&self, other: &Self) -> std::cmp::Ordering;
}

impl LocaleName for String {
    fn locale_cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.to_lowercase()
            .cmp(&other.to_lowercase())
            .then_with(|| self.cmp(other))
    }
}

fn template_view(
    input: &CatalogListInput<'_>,
    template: &ProviderCatalogTemplate,
    category: String,
) -> ProviderCatalogTemplateView {
    ProviderCatalogTemplateView {
        id: template.id.clone(),
        plugin_id: input.plugin_id.to_owned(),
        contribution_id: input.contribution.id.clone(),
        plugin_label: input.plugin_label.to_owned(),
        agent_id: template.agent_id.clone(),
        name: template.name.clone(),
        website_url: template.website_url.clone(),
        api_key_url: template.api_key_url.clone(),
        endpoint_candidates: template.endpoint_candidates.clone(),
        api_key_field: template.api_key_field.clone(),
        category,
        surface: template.surface,
        api_url: template.api_url.clone(),
        model: template.model.clone(),
        provider_id: template.provider_id.clone(),
        npm: template.npm.clone(),
        api: template.api.clone(),
        base_url: template.base_url.clone(),
        models: template.models.clone(),
        display_name: template.display_name.clone(),
        notes: template.notes.clone(),
        default_model: template.default_model.clone(),
    }
}

fn parse_template(value: &Value, agent_id: &str) -> Result<ProviderCatalogTemplate, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "must be an object".to_owned())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "id is required".to_owned())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "name is required".to_owned())?;
    let surface = object
        .get("surface")
        .and_then(Value::as_str)
        .and_then(ProviderCatalogSurface::parse)
        .ok_or_else(|| "surface must be reusable, opencode, or dsh".to_owned())?;
    if surface != expected_catalog_surface(agent_id) {
        return Err(format!(
            "surface {} does not match agentId {agent_id}",
            surface.as_str()
        ));
    }
    let category = normalize_catalog_category(object.get("category").and_then(Value::as_str));
    let website_url = optional_url(object, "websiteUrl")?;
    let api_key_url = optional_url(object, "apiKeyUrl")?;
    let api_key_field = object
        .get("apiKeyField")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let endpoint_candidates = match object.get("endpointCandidates") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut urls = Vec::new();
            for item in items {
                let url = item
                    .as_str()
                    .ok_or_else(|| "endpointCandidates must be http(s) URLs".to_owned())?;
                urls.push(validate_catalog_url(url)?);
            }
            urls
        }
        Some(_) => return Err("endpointCandidates must be an array".to_owned()),
    };

    let mut template = ProviderCatalogTemplate {
        id: id.to_owned(),
        agent_id: agent_id.to_owned(),
        name: name.to_owned(),
        website_url,
        api_key_url,
        endpoint_candidates,
        api_key_field,
        category,
        surface,
        api_url: None,
        model: None,
        provider_id: None,
        npm: None,
        api: None,
        base_url: None,
        models: Vec::new(),
        display_name: None,
        notes: None,
        default_model: None,
    };

    match surface {
        ProviderCatalogSurface::Reusable => {
            template.api_url = Some(required_url(object, "apiUrl")?);
            template.model = Some(
                object
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "model is required".to_owned())?,
            );
        }
        ProviderCatalogSurface::Opencode => {
            template.provider_id = Some(
                object
                    .get("providerId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "providerId is required".to_owned())?
                    .to_owned(),
            );
            template.base_url = Some(required_url(object, "baseUrl")?);
            template.npm = object
                .get("npm")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            template.api = object
                .get("api")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            template.models = parse_models(object)?;
        }
        ProviderCatalogSurface::Dsh => {
            template.display_name = Some(
                object
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "displayName is required".to_owned())?
                    .to_owned(),
            );
            template.base_url = Some(required_url(object, "baseUrl")?);
            template.notes = object
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .filter(|value| !value.is_empty());
            template.api = object
                .get("api")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            template.default_model = object
                .get("defaultModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            template.models = parse_models(object)?;
        }
    }
    Ok(template)
}

fn parse_models(object: &Map<String, Value>) -> Result<Vec<ProviderCatalogModel>, String> {
    let models = object
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "models must be an array".to_owned())?;
    let mut parsed = Vec::new();
    for model in models {
        let model = model
            .as_object()
            .ok_or_else(|| "models entries must be objects".to_owned())?;
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "models[].id is required".to_owned())?;
        let name = match model.get("name") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
            Some(_) => return Err("models[].name must be a non-empty string when present".into()),
        };
        parsed.push(ProviderCatalogModel {
            id: id.to_owned(),
            name,
        });
    }
    Ok(parsed)
}

fn inspect_forbidden(value: &Value, path: &str, out: &mut Vec<(&'static str, String)>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                inspect_forbidden(item, &format!("{path}[{index}]"), out);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                let lowered = key.to_ascii_lowercase();
                if SECRET_KEYS.contains(&lowered.as_str()) {
                    out.push((
                        "provider_catalog_secret_forbidden",
                        format!("Catalog must not include secret field {key}"),
                    ));
                } else if FORBIDDEN_FIELDS.contains(&key.as_str()) {
                    out.push((
                        "provider_catalog_forbidden_field",
                        format!("Catalog must not include {key}"),
                    ));
                }
                if URL_FIELDS.contains(&key.as_str()) {
                    if let Some(url) = child.as_str()
                        && catalog_url_error(url).is_some()
                    {
                        out.push((
                            "provider_catalog_url_invalid",
                            format!("{child_path} is not a valid http(s) URL"),
                        ));
                    }
                    continue;
                }
                if key == "endpointCandidates" {
                    if let Some(items) = child.as_array() {
                        for (index, item) in items.iter().enumerate() {
                            if let Some(url) = item.as_str()
                                && catalog_url_error(url).is_some()
                            {
                                out.push((
                                    "provider_catalog_url_invalid",
                                    format!("{child_path}[{index}] is not a valid http(s) URL"),
                                ));
                            }
                        }
                    }
                    continue;
                }
                inspect_forbidden(child, &child_path, out);
            }
        }
        _ => {}
    }
}

fn required_url(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} is required"))?;
    validate_catalog_url(value)
}

fn optional_url(object: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => validate_catalog_url(value).map(Some),
        Some(_) => Err(format!("{key} must be an http(s) URL")),
    }
}

fn validate_catalog_url(value: &str) -> Result<String, String> {
    catalog_url_error(value)
        .map(|reason| Err(reason.to_owned()))
        .unwrap_or_else(|| Ok(value.trim().to_owned()))
}

pub fn catalog_url_error(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.to_ascii_lowercase().starts_with("javascript:") {
        return Some("javascript: URLs are not allowed");
    }
    let Ok(url) = Url::parse(trimmed) else {
        return Some("must be an http(s) URL");
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Some("must be an http(s) URL");
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Some("must be an http(s) URL");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Some("must not include userinfo");
    }
    let keys: BTreeSet<String> = url
        .query_pairs()
        .map(|(key, _)| key.to_ascii_lowercase())
        .collect();
    if keys.contains("token") || keys.contains("api_key") || keys.contains("aff") {
        return Some("query must not contain token, api_key, or aff");
    }
    None
}

fn is_package_relative(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.chars().nth(1) == Some(':') {
        return false;
    }
    path.split('/').all(|part| !part.is_empty() && part != "..")
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn warn(code: &str, message: String, contribution: Option<&str>) -> PackageWarning {
    PackageWarning {
        code: code.to_owned(),
        message,
        contribution: contribution.map(str::to_owned),
    }
}

pub fn catalog_unavailable() -> PluginError {
    PluginError::coded(
        "provider_catalog_unavailable",
        "This Host has no provider catalog",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template(category: &str, name: &str, id: &str) -> ProviderCatalogTemplate {
        ProviderCatalogTemplate {
            id: id.to_owned(),
            agent_id: "claude_code".to_owned(),
            name: name.to_owned(),
            website_url: None,
            api_key_url: None,
            endpoint_candidates: Vec::new(),
            api_key_field: None,
            category: category.to_owned(),
            surface: ProviderCatalogSurface::Reusable,
            api_url: Some(format!("https://{id}.example")),
            model: Some("model".to_owned()),
            provider_id: None,
            npm: None,
            api: None,
            base_url: None,
            models: Vec::new(),
            display_name: None,
            notes: None,
            default_model: None,
        }
    }

    fn contribution(
        id: &str,
        templates: Vec<ProviderCatalogTemplate>,
    ) -> ProviderCatalogContribution {
        ProviderCatalogContribution {
            id: id.to_owned(),
            label: id.to_owned(),
            icon: None,
            resource: format!("catalogs/{id}.json"),
            agents: Vec::new(),
            description: None,
            agent_id: "claude_code".to_owned(),
            templates,
            error: None,
        }
    }

    #[test]
    fn unknown_categories_become_community_and_sort_by_name() {
        let zebra = contribution(
            "a",
            vec![
                template("mystery", "Zebra", "zebra"),
                template("official", "Omega", "omega"),
                template("prime", "Kimi", "kimi"),
                template("partner", "Packy", "packy"),
                template("community", "Apple", "apple"),
            ],
        );
        let listed = aggregate_provider_catalogs(
            "claude_code",
            3,
            &[CatalogListInput {
                plugin_id: "plug.a",
                plugin_label: "A",
                contribution: &zebra,
            }],
        );
        let names: Vec<_> = listed
            .templates
            .iter()
            .map(|item| item.name.as_str())
            .collect();
        assert_eq!(names, ["Omega", "Kimi", "Packy", "Apple", "Zebra"]);
        assert_eq!(listed.templates[4].category, "community");
    }

    #[test]
    fn duplicate_urls_from_two_plugins_are_kept() {
        let left = contribution("one", vec![template("community", "Same", "same")]);
        let right = contribution("two", vec![template("community", "Same", "same")]);
        let listed = aggregate_provider_catalogs(
            "claude_code",
            1,
            &[
                CatalogListInput {
                    plugin_id: "left",
                    plugin_label: "Left",
                    contribution: &left,
                },
                CatalogListInput {
                    plugin_id: "right",
                    plugin_label: "Right",
                    contribution: &right,
                },
            ],
        );
        assert_eq!(listed.templates.len(), 2);
        assert_eq!(listed.templates[0].plugin_id, "left");
        assert_eq!(listed.templates[1].plugin_id, "right");
    }

    #[test]
    fn javascript_urls_are_rejected() {
        assert_eq!(
            catalog_url_error("javascript:alert(1)"),
            Some("javascript: URLs are not allowed")
        );
        assert!(catalog_url_error("https://openrouter.ai/keys").is_none());
        assert_eq!(
            catalog_url_error("https://example.com/keys?aff=partner"),
            Some("query must not contain token, api_key, or aff")
        );
    }
}
