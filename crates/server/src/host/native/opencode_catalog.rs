use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use api_types::{
    OpenCodeCatalogModelView, OpenCodeCatalogProviderView, OpenCodeProviderCatalogSource,
    OpenCodeProviderCatalogView,
};
use futures::StreamExt;

use super::write_bytes_document;

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_MODELS_DEV_BYTES: usize = 8 * 1024 * 1024;
const BUNDLED_SNAPSHOT: &str =
    include_str!("../../../../../src-tauri/resources/opencode/models-dev.json");

fn is_oauth_provider(provider_id: &str) -> bool {
    matches!(provider_id, "openai" | "github-copilot" | "gitlab")
}

pub fn normalize_models_dev(raw: &str) -> Result<Vec<OpenCodeCatalogProviderView>, String> {
    let root: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("解析 models.dev 失败：{error}"))?;
    let object = root
        .as_object()
        .ok_or_else(|| "models.dev 顶层不是 JSON 对象".to_string())?;

    let mut providers = Vec::with_capacity(object.len());
    for (key, raw_provider) in object {
        let Some(provider) = raw_provider.as_object() else {
            continue;
        };
        let id = provider
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(key)
            .to_string();
        let name = provider
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&id)
            .to_string();
        let npm = provider
            .get("npm")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let doc = provider
            .get("doc")
            .and_then(serde_json::Value::as_str)
            .and_then(safe_http_url);
        let env = provider
            .get("env")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut models = provider
            .get("models")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flat_map(|models| models.iter())
            .filter_map(|(model_key, raw_model)| {
                let model = raw_model.as_object()?;
                let id = model
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(model_key)
                    .to_string();
                Some(OpenCodeCatalogModelView {
                    name: model
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or(&id)
                        .to_string(),
                    id,
                    reasoning: model
                        .get("reasoning")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    tool_call: model
                        .get("tool_call")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    context: model
                        .get("limit")
                        .and_then(|value| value.get("context"))
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok()),
                    cost_in: model
                        .get("cost")
                        .and_then(|value| value.get("input"))
                        .and_then(serde_json::Value::as_f64),
                    cost_out: model
                        .get("cost")
                        .and_then(|value| value.get("output"))
                        .and_then(serde_json::Value::as_f64),
                })
            })
            .collect::<Vec<_>>();
        models.sort_by(|left, right| left.id.cmp(&right.id));
        providers.push(OpenCodeCatalogProviderView {
            id: id.clone(),
            name,
            npm,
            env,
            doc,
            auth_kind: if is_oauth_provider(&id) {
                "oauth".to_string()
            } else {
                "api".to_string()
            },
            models,
        });
    }
    providers.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(providers)
}

fn bundled_catalog() -> Vec<OpenCodeCatalogProviderView> {
    let mut providers: Vec<OpenCodeCatalogProviderView> =
        serde_json::from_str(BUNDLED_SNAPSHOT).unwrap_or_default();
    sanitize_docs(&mut providers);
    providers
}

fn safe_http_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.to_string())
}

fn sanitize_docs(providers: &mut [OpenCodeCatalogProviderView]) {
    for provider in providers {
        provider.doc = provider.doc.as_deref().and_then(safe_http_url);
    }
}

fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir
        .join("cache")
        .join("opencode")
        .join("models-dev.json")
}

fn read_cache(data_dir: &Path, require_fresh: bool) -> Option<Vec<OpenCodeCatalogProviderView>> {
    let path = cache_path(data_dir);
    if require_fresh {
        let age = std::fs::metadata(&path)
            .ok()?
            .modified()
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())?;
        if age > CACHE_TTL {
            return None;
        }
    }
    let mut providers: Vec<OpenCodeCatalogProviderView> =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    sanitize_docs(&mut providers);
    Some(providers)
}

async fn write_cache(data_dir: &Path, providers: &[OpenCodeCatalogProviderView]) {
    let path = cache_path(data_dir);
    let Some(parent) = path.parent() else {
        return;
    };
    if tokio::fs::create_dir_all(parent).await.is_err() {
        return;
    }
    if let Ok(document) = serde_json::to_vec(providers) {
        let _ = write_bytes_document(&path, &document, false).await;
    }
}

async fn fetch_live() -> Result<Vec<OpenCodeCatalogProviderView>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("创建 models.dev 客户端失败：{error}"))?;
    let response = client
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|error| format!("读取 models.dev 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("models.dev 返回 HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MODELS_DEV_BYTES as u64)
    {
        return Err("models.dev 响应超过 8 MiB 安全上限".to_string());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 models.dev 响应失败：{error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_MODELS_DEV_BYTES {
            return Err("models.dev 响应超过 8 MiB 安全上限".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&body)
        .map_err(|error| format!("models.dev 响应不是 UTF-8：{error}"))?;
    normalize_models_dev(text)
}

pub async fn provider_catalog(data_dir: &Path, force_refresh: bool) -> OpenCodeProviderCatalogView {
    if !force_refresh && let Some(providers) = read_cache(data_dir, true) {
        return OpenCodeProviderCatalogView {
            source: OpenCodeProviderCatalogSource::Cache,
            providers,
        };
    }
    if let Ok(providers) = fetch_live().await
        && !providers.is_empty()
    {
        write_cache(data_dir, &providers).await;
        return OpenCodeProviderCatalogView {
            source: OpenCodeProviderCatalogSource::Live,
            providers,
        };
    }
    if let Some(providers) = read_cache(data_dir, false) {
        return OpenCodeProviderCatalogView {
            source: OpenCodeProviderCatalogSource::Cache,
            providers,
        };
    }
    OpenCodeProviderCatalogView {
        source: OpenCodeProviderCatalogSource::Bundled,
        providers: bundled_catalog(),
    }
}

#[cfg(test)]
mod tests {
    use super::{bundled_catalog, normalize_models_dev};

    #[test]
    fn normalizes_models_and_classifies_supported_oauth_providers() {
        let providers = normalize_models_dev(
            r#"{
              "openai": {
                "name": "OpenAI",
                "models": {
                  "gpt-5": {
                    "name": "GPT-5",
                    "reasoning": true,
                    "tool_call": true,
                    "limit": { "context": 400000 },
                    "cost": { "input": 1.25, "output": 10 }
                  }
                }
              },
              "anthropic": { "name": "Anthropic" }
            }"#,
        )
        .unwrap();

        assert_eq!(providers[0].id, "anthropic");
        assert_eq!(providers[0].auth_kind, "api");
        assert_eq!(providers[1].auth_kind, "oauth");
        assert_eq!(providers[1].models[0].context, Some(400000));
    }

    #[test]
    fn rejects_non_http_provider_documentation_urls() {
        let providers = normalize_models_dev(
            r#"{
              "unsafe": {"doc":"file:///tmp/secret"},
              "safe": {"doc":"https://docs.example.test/provider"}
            }"#,
        )
        .unwrap();

        assert_eq!(providers[0].id, "safe");
        assert_eq!(
            providers[0].doc.as_deref(),
            Some("https://docs.example.test/provider")
        );
        assert_eq!(providers[1].id, "unsafe");
        assert!(providers[1].doc.is_none());
    }

    #[test]
    fn bundled_catalog_keeps_offline_provider_coverage() {
        let providers = bundled_catalog();
        assert!(providers.len() > 30);
        assert!(providers.iter().any(|provider| provider.id == "openai"));
        assert!(providers.iter().any(|provider| provider.id == "openrouter"));
    }
}
