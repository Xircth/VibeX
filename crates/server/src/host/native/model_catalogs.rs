use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use agents::{BuiltInProfileCatalog, NativeFileMutation};
use api_types::{
    AgentId, AgentKind, AgentModelCatalogItemView, AgentModelCatalogSource, AgentModelCatalogView,
    CodexModelCatalogConfigRequest, CodexModelCatalogConfigView,
};
use futures::StreamExt;
use serde_json::Value;

use super::{agent_process_command, apply_native_file_mutations, write_bytes_document};

const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_CATALOG_PAGES: usize = 8;
const ERROR_BODY_MAX_CHARS: usize = 240;
/// Anthropic-compatible protocol suffixes. Longest match first so `/api/anthropic`
/// is stripped as a whole instead of leaving a dangling `/api`.
const COMPAT_PROTOCOL_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];
const CODEX_CATALOG_FILE: &str = "vibex-model-catalog.json";
const CODEX_SOURCE_FILE: &str = "vibex-model-catalog.source.json";
type CodexCatalogFiles = (bool, Option<Vec<u8>>, Option<Vec<u8>>);
#[cfg(test)]
const IMPORT_SKIP_KEYS: &[&str] = &[
    "slug",
    "display_name",
    "context_window",
    "visibility",
    "supported_in_api",
    "priority",
    "upgrade",
];

pub async fn cursor(
    program: &Path,
    api_key: Option<&str>,
) -> Result<AgentModelCatalogView, String> {
    let mut command = agent_process_command(program);
    command.arg("models").kill_on_drop(true);
    command.env_remove("CURSOR_API_BASE_URL");
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        command.env("CURSOR_API_KEY", api_key);
    }
    let output = tokio::time::timeout(CATALOG_TIMEOUT, command.output())
        .await
        .map_err(|_| "Cursor 模型目录请求超时".to_string())?
        .map_err(|error| format!("运行 cursor-agent models 失败：{error}"))?;
    if !output.status.success() {
        return Err(command_error("cursor-agent models", &output.stderr));
    }
    let (models, default_model) = parse_cursor_models(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err("cursor-agent models 未返回可用模型".to_string());
    }
    Ok(AgentModelCatalogView {
        agent_id: AgentId::parse("cursor").expect("built-in id"),
        source: AgentModelCatalogSource::Live,
        models,
        default_model,
        error: None,
    })
}

pub async fn kimi(base_url: &str, api_key: &str) -> Result<AgentModelCatalogView, String> {
    let catalog = provider(
        AgentId::parse("kimi_code").expect("built-in id"),
        base_url,
        api_key,
    )
    .await?;
    if catalog.models.is_empty() {
        return Err("Kimi Provider 未返回任何模型".to_string());
    }
    Ok(catalog)
}

pub async fn provider(
    agent_id: AgentId,
    base_url: &str,
    api_key: &str,
) -> Result<AgentModelCatalogView, String> {
    if !BuiltInProfileCatalog::bundled().supports_reusable_model_providers(&agent_id) {
        return Err("该 Agent 不支持 Provider 模型探测".to_string());
    }
    let base_url = validate_model_endpoint(base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("读取 Provider 模型需要填写 API Key".to_string());
    }
    let urls = model_catalog_urls(&base_url);
    if urls.is_empty() {
        return Err("无法从 Provider API URL 推导模型目录地址".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(PROVIDER_CATALOG_TIMEOUT)
        .build()
        .map_err(|error| format!("创建 Provider 模型客户端失败：{error}"))?;

    let mut last_error = None;
    for url in urls {
        match fetch_provider_models(&client, &agent_id, url, api_key).await {
            Ok(models) => {
                return Ok(AgentModelCatalogView {
                    agent_id,
                    source: AgentModelCatalogSource::Live,
                    models,
                    default_model: None,
                    error: None,
                });
            }
            Err(error) if error.retryable => last_error = Some(error.message),
            Err(error) => return Err(error.message),
        }
    }
    Err(last_error.unwrap_or_else(|| "Provider 未返回任何模型".to_string()))
}

pub async fn codex(
    program: Option<&Path>,
    cache_path: &Path,
    force_refresh: bool,
) -> AgentModelCatalogView {
    if !force_refresh && let Some(cached) = read_codex_cache(cache_path, true).await {
        return codex_view(cached, AgentModelCatalogSource::Cache, None);
    }
    let mut live_error = program
        .is_none()
        .then(|| "未找到 Codex Runtime；请先安装或修复 Agent".to_string());
    if let Some(program) = program {
        match fetch_codex_models(program).await {
            Ok(document) => {
                if let Ok(bytes) = serde_json::to_vec(&document) {
                    let _ = write_bytes_document(cache_path, &bytes, false).await;
                }
                return codex_view(document, AgentModelCatalogSource::Live, None);
            }
            Err(error) => live_error = Some(error),
        }
    }
    if let Some(cached) = read_codex_cache(cache_path, false).await {
        return codex_view(cached, AgentModelCatalogSource::Cache, live_error);
    }
    AgentModelCatalogView {
        agent_id: AgentId::parse("codex").expect("built-in id"),
        source: AgentModelCatalogSource::Unavailable,
        models: Vec::new(),
        default_model: None,
        error: live_error,
    }
}

pub async fn codex_official_document(
    program: Option<&Path>,
    cache_path: &Path,
) -> Result<Value, String> {
    if let Some(cached) = read_codex_cache(cache_path, true).await {
        return Ok(cached);
    }
    if let Some(program) = program {
        let document = fetch_codex_models(program).await?;
        if let Ok(bytes) = serde_json::to_vec(&document) {
            let _ = write_bytes_document(cache_path, &bytes, false).await;
        }
        return Ok(document);
    }
    read_codex_cache(cache_path, false)
        .await
        .ok_or_else(|| "没有可用的 Codex Runtime 模型目录或缓存".to_string())
}

pub async fn load_codex_config(codex_home: &Path) -> Result<CodexModelCatalogConfigView, String> {
    let source_path = codex_home.join(CODEX_SOURCE_FILE);
    let generated_catalog_path = codex_home.join(CODEX_CATALOG_FILE);
    let (request, catalog_path) = match tokio::fs::read(&source_path).await {
        Ok(bytes) => (
            serde_json::from_slice::<CodexModelCatalogConfigRequest>(&bytes)
                .map_err(|error| format!("Codex 模型目录源文件无效：{error}"))?,
            generated_catalog_path,
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some((catalog_path, _, default_model)) =
                peek_external_codex_catalog(codex_home).await
            {
                (
                    CodexModelCatalogConfigRequest {
                        customs: Vec::new(),
                        excluded_officials: Vec::new(),
                        default_model: default_model.or(read_codex_root_model(codex_home).await?),
                    },
                    catalog_path,
                )
            } else {
                (
                    CodexModelCatalogConfigRequest {
                        customs: Vec::new(),
                        excluded_officials: Vec::new(),
                        default_model: read_codex_root_model(codex_home).await?,
                    },
                    generated_catalog_path,
                )
            }
        }
        Err(error) => return Err(format!("读取 Codex 模型目录源文件失败：{error}")),
    };
    Ok(CodexModelCatalogConfigView {
        customs: request.customs,
        excluded_officials: request.excluded_officials,
        default_model: request.default_model,
        catalog_path: catalog_path.display().to_string(),
        source_path: source_path.display().to_string(),
        active: catalog_path.is_file(),
    })
}

pub async fn peek_external_codex_catalog(
    codex_home: &Path,
) -> Option<(PathBuf, Value, Option<String>)> {
    match read_external_codex_catalog(codex_home).await {
        Ok(Some((path, catalog, default_model)))
            if path.file_name().and_then(|name| name.to_str()) != Some(CODEX_CATALOG_FILE) =>
        {
            Some((path, catalog, default_model))
        }
        _ => None,
    }
}

pub fn first_catalog_slug(catalog: &Value) -> Option<String> {
    catalog
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|model| {
            model
                .get("slug")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|slug| !slug.is_empty())
                .map(str::to_string)
        })
}

async fn read_external_codex_catalog(
    codex_home: &Path,
) -> Result<Option<(PathBuf, Value, Option<String>)>, String> {
    let config_path = codex_home.join("config.toml");
    let text = match tokio::fs::read_to_string(&config_path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Codex config.toml 失败：{error}")),
    };
    let table = toml::from_str::<toml::Table>(&text)
        .map_err(|error| format!("Codex config.toml 无效：{error}"))?;
    let Some(reference) = table
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let path = resolve_codex_catalog_path(reference, codex_home)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("读取外部 Codex 模型目录元数据失败：{error}"))?;
    if metadata.len() > 8 * 1024 * 1024 {
        return Err("外部 Codex 模型目录超过 8 MiB 安全上限".to_string());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("读取外部 Codex 模型目录失败：{error}"))?;
    let catalog = serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("外部 Codex 模型目录不是有效 JSON：{error}"))?;
    if catalog
        .get("models")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return Err("外部 Codex 模型目录缺少可用的 models 数组".to_string());
    }
    let default_model = table
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    Ok(Some((path, catalog, default_model)))
}

fn resolve_codex_catalog_path(reference: &str, codex_home: &Path) -> Result<PathBuf, String> {
    if reference == "~" {
        return dirs::home_dir().ok_or_else(|| "用户目录不可用".to_string());
    }
    if let Some(relative) = reference.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(relative))
            .ok_or_else(|| "用户目录不可用".to_string());
    }
    let path = Path::new(reference);
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        codex_home.join(path)
    })
}

#[cfg(test)]
fn import_codex_catalog(
    catalog: &Value,
    root_model: Option<&str>,
    official: &[Value],
) -> CodexModelCatalogConfigRequest {
    let official_slugs = official
        .iter()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let fallback = official
        .iter()
        .min_by_key(|model| {
            model
                .get("priority")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX)
        })
        .and_then(|model| model.get("slug").and_then(Value::as_str))
        .unwrap_or_default();
    let fallback_object = official
        .iter()
        .find(|model| model.get("slug").and_then(Value::as_str) == Some(fallback))
        .and_then(Value::as_object);
    let foreign = catalog
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .collect::<Vec<_>>();
    let foreign_slugs = foreign
        .iter()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let customs = foreign
        .iter()
        .filter_map(|model| {
            let slug = model
                .get("slug")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|slug| !slug.is_empty())?;
            if official_slugs.contains(slug) {
                return None;
            }
            let overrides = model
                .iter()
                .filter(|(key, value)| {
                    !IMPORT_SKIP_KEYS.contains(&key.as_str())
                        && fallback_object.and_then(|base| base.get(*key)) != Some(*value)
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>();
            Some(api_types::CodexCustomModelRequest {
                slug: slug.to_string(),
                display_name: model
                    .get("display_name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                context_window: model
                    .get("context_window")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                base: fallback.to_string(),
                overrides: (!overrides.is_empty()).then(|| Value::Object(overrides)),
            })
        })
        .collect();
    let excluded_officials = official
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .filter(|slug| !foreign_slugs.contains(slug))
        .map(str::to_string)
        .collect();
    CodexModelCatalogConfigRequest {
        customs,
        excluded_officials,
        default_model: root_model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

pub async fn apply_codex_config(
    codex_home: &Path,
    official_document: &Value,
    request: CodexModelCatalogConfigRequest,
) -> Result<CodexModelCatalogConfigView, String> {
    let catalog_path = codex_home.join(CODEX_CATALOG_FILE);
    let source_path = codex_home.join(CODEX_SOURCE_FILE);
    tokio::fs::create_dir_all(codex_home)
        .await
        .map_err(|error| format!("创建 Codex 配置目录失败：{error}"))?;

    let (active, catalog_replacement, source_replacement) =
        build_codex_catalog_files(official_document, &request)?;
    let catalog_original = read_optional_bytes(&catalog_path).await?;
    let source_original = read_optional_bytes(&source_path).await?;
    let mut mutations = Vec::with_capacity(3);
    mutations.push(NativeFileMutation {
        path: catalog_path.clone(),
        expected: catalog_original,
        replacement: catalog_replacement,
        sensitive: false,
    });
    mutations.push(NativeFileMutation {
        path: source_path.clone(),
        expected: source_original,
        replacement: source_replacement,
        sensitive: false,
    });
    mutations.push(
        prepare_codex_config_toml(codex_home, active, request.default_model.as_deref()).await?,
    );
    apply_native_file_mutations(&mutations).await?;
    Ok(CodexModelCatalogConfigView {
        customs: request.customs,
        excluded_officials: request.excluded_officials,
        default_model: request.default_model,
        catalog_path: catalog_path.display().to_string(),
        source_path: source_path.display().to_string(),
        active,
    })
}

pub fn build_codex_catalog_files(
    official_document: &Value,
    request: &CodexModelCatalogConfigRequest,
) -> Result<CodexCatalogFiles, String> {
    let official = official_document
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex 官方模型目录缺少 models 数组".to_string())?;
    validate_codex_config(request, official)?;
    let active = !request.customs.is_empty() || !request.excluded_officials.is_empty();
    if !active {
        return Ok((false, None, None));
    }
    let catalog = expand_codex_catalog(request, official)?;
    let catalog_bytes = serde_json::to_vec_pretty(&catalog)
        .map_err(|error| format!("序列化 Codex 模型目录失败：{error}"))?;
    let source_bytes = serde_json::to_vec_pretty(request)
        .map_err(|error| format!("序列化 Codex 模型目录源文件失败：{error}"))?;
    Ok((true, Some(catalog_bytes), Some(source_bytes)))
}

fn validate_codex_config(
    request: &CodexModelCatalogConfigRequest,
    official: &[Value],
) -> Result<(), String> {
    let official_slugs = official
        .iter()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let mut custom_slugs = HashSet::new();
    for custom in &request.customs {
        let slug = custom.slug.trim();
        if slug.is_empty() || slug.chars().any(char::is_whitespace) {
            return Err("Codex 自定义模型 ID 不能为空或包含空格".to_string());
        }
        if official_slugs.contains(slug) {
            return Err(format!("自定义模型 `{slug}` 与官方模型重名"));
        }
        if !custom_slugs.insert(slug) {
            return Err(format!("自定义模型 `{slug}` 重复"));
        }
        if !official_slugs.contains(custom.base.trim()) {
            return Err(format!(
                "自定义模型 `{slug}` 的模板 `{}` 不存在",
                custom.base
            ));
        }
        if custom
            .overrides
            .as_ref()
            .is_some_and(|overrides| !overrides.is_object())
        {
            return Err(format!("自定义模型 `{slug}` 的高级覆盖必须是 JSON 对象"));
        }
    }
    if request
        .excluded_officials
        .iter()
        .any(|slug| !official_slugs.contains(slug.as_str()))
    {
        return Err("排除列表包含未知 Codex 官方模型".to_string());
    }
    if let Some(default_model) = request.default_model.as_deref() {
        let available = custom_slugs.contains(default_model)
            || (official_slugs.contains(default_model)
                && !request
                    .excluded_officials
                    .iter()
                    .any(|slug| slug == default_model));
        if !available {
            return Err(format!("默认模型 `{default_model}` 不在启用的模型清单中"));
        }
    }
    Ok(())
}

pub fn expand_provider_codex_catalog(
    request: &CodexModelCatalogConfigRequest,
    official: &[Value],
) -> Result<Value, String> {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for custom in &request.customs {
        let slug = custom.slug.trim();
        if slug.is_empty() {
            continue;
        }
        if slug.chars().any(char::is_whitespace) {
            return Err("Codex 自定义模型 ID 不能为空或包含空格".to_string());
        }
        if !seen.insert(slug.to_string()) {
            return Err(format!("自定义模型 `{slug}` 重复"));
        }
        models.push(materialize_provider_catalog_model(custom, slug, official));
    }
    if let Some(default) = request
        .default_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && seen.insert(default.to_string())
    {
        models.push(materialize_provider_catalog_model(
            &api_types::CodexCustomModelRequest {
                slug: default.to_string(),
                display_name: None,
                context_window: None,
                base: default.to_string(),
                overrides: None,
            },
            default,
            official,
        ));
    }
    for (index, model) in models.iter_mut().enumerate() {
        if let Some(model) = model.as_object_mut() {
            model.insert("priority".to_string(), Value::from(index as u64));
        }
    }
    Ok(serde_json::json!({ "models": models }))
}

pub async fn cached_official_models(cache_path: &Path) -> Vec<Value> {
    read_codex_cache(cache_path, false)
        .await
        .and_then(|document| document.get("models").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn materialize_provider_catalog_model(
    custom: &api_types::CodexCustomModelRequest,
    slug: &str,
    official: &[Value],
) -> Value {
    let mut model = official
        .iter()
        .find(|model| model.get("slug").and_then(Value::as_str) == Some(custom.base.trim()))
        .or_else(|| official.first())
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            let mut map = serde_json::Map::new();
            map.insert("visibility".to_string(), Value::String("list".to_string()));
            map.insert("supported_in_api".to_string(), Value::Bool(true));
            map.insert("context_window".to_string(), Value::from(128_000));
            map.insert("max_context_window".to_string(), Value::from(128_000));
            map
        });
    if let Some(overrides) = custom.overrides.as_ref().and_then(Value::as_object) {
        model.extend(overrides.clone());
    }
    model.insert("slug".to_string(), Value::String(slug.to_string()));
    model.insert(
        "display_name".to_string(),
        Value::String(
            custom
                .display_name
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| slug.to_string()),
        ),
    );
    if let Some(context_window) = custom.context_window {
        model.insert("context_window".to_string(), Value::from(context_window));
        let maximum = model
            .get("max_context_window")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .max(u64::from(context_window));
        model.insert("max_context_window".to_string(), Value::from(maximum));
    }
    model.insert("visibility".to_string(), Value::String("list".to_string()));
    model.insert("supported_in_api".to_string(), Value::Bool(true));
    model.insert("upgrade".to_string(), Value::Null);
    Value::Object(model)
}

fn expand_codex_catalog(
    request: &CodexModelCatalogConfigRequest,
    official: &[Value],
) -> Result<Value, String> {
    let excluded = request
        .excluded_officials
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut models = Vec::with_capacity(request.customs.len() + official.len());
    for custom in &request.customs {
        let base = official
            .iter()
            .find(|model| model.get("slug").and_then(Value::as_str) == Some(custom.base.as_str()))
            .and_then(Value::as_object)
            .ok_or_else(|| format!("找不到 Codex 模型模板 `{}`", custom.base))?;
        let mut model = base.clone();
        if let Some(overrides) = custom.overrides.as_ref().and_then(Value::as_object) {
            model.extend(overrides.clone());
        }
        model.insert("slug".to_string(), Value::String(custom.slug.clone()));
        model.insert(
            "display_name".to_string(),
            Value::String(
                custom
                    .display_name
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| custom.slug.clone()),
            ),
        );
        if let Some(context_window) = custom.context_window {
            model.insert("context_window".to_string(), Value::from(context_window));
            let maximum = model
                .get("max_context_window")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .max(u64::from(context_window));
            model.insert("max_context_window".to_string(), Value::from(maximum));
        }
        model.insert("visibility".to_string(), Value::String("list".to_string()));
        model.insert("supported_in_api".to_string(), Value::Bool(true));
        model.insert("upgrade".to_string(), Value::Null);
        models.push(Value::Object(model));
    }
    models.extend(
        official
            .iter()
            .filter(|model| {
                model
                    .get("slug")
                    .and_then(Value::as_str)
                    .is_none_or(|slug| !excluded.contains(slug))
            })
            .cloned(),
    );
    for (index, model) in models.iter_mut().enumerate() {
        if let Some(model) = model.as_object_mut() {
            model.insert("priority".to_string(), Value::from(index as u64));
        }
    }
    Ok(serde_json::json!({ "models": models }))
}

async fn read_codex_root_model(codex_home: &Path) -> Result<Option<String>, String> {
    let path = codex_home.join("config.toml");
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Codex config.toml 失败：{error}")),
    };
    let table = toml::from_str::<toml::Table>(&text)
        .map_err(|error| format!("Codex config.toml 无效：{error}"))?;
    Ok(table
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::to_string))
}

async fn prepare_codex_config_toml(
    codex_home: &Path,
    active: bool,
    default_model: Option<&str>,
) -> Result<NativeFileMutation, String> {
    let path = codex_home.join("config.toml");
    let original = read_optional_bytes(&path).await?;
    let text = original
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|error| format!("Codex config.toml 不是 UTF-8：{error}"))?
        .unwrap_or_default();
    let mut table = if text.trim().is_empty() {
        toml::Table::new()
    } else {
        toml::from_str::<toml::Table>(text)
            .map_err(|error| format!("Codex config.toml 无效：{error}"))?
    };
    if active {
        table.insert(
            "model_catalog_json".to_string(),
            toml::Value::String(CODEX_CATALOG_FILE.to_string()),
        );
    } else {
        table.remove("model_catalog_json");
    }
    match default_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(model) => {
            table.insert("model".to_string(), toml::Value::String(model.to_string()));
        }
        None => {
            table.remove("model");
        }
    }
    let bytes = toml::to_string_pretty(&table)
        .map(String::into_bytes)
        .map_err(|error| format!("序列化 Codex config.toml 失败：{error}"))?;
    Ok(NativeFileMutation {
        path,
        expected: original,
        replacement: Some(bytes),
        sensitive: false,
    })
}

async fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

async fn fetch_codex_models(program: &Path) -> Result<Value, String> {
    let mut command = agent_process_command(program);
    command
        .args(["debug", "models", "--bundled"])
        .kill_on_drop(true);
    let output = tokio::time::timeout(CATALOG_TIMEOUT, command.output())
        .await
        .map_err(|_| "Codex 模型目录请求超时".to_string())?
        .map_err(|error| format!("运行 Codex 模型目录命令失败：{error}"))?;
    if !output.status.success() {
        return Err(command_error(
            "codex debug models --bundled",
            &output.stderr,
        ));
    }
    if output.stdout.len() > MAX_CATALOG_BYTES {
        return Err("Codex 模型目录超过 4 MiB 安全上限".to_string());
    }
    let document: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Codex 模型目录不是有效 JSON：{error}"))?;
    let has_models = document
        .get("models")
        .and_then(Value::as_array)
        .is_some_and(|models| !models.is_empty());
    if !has_models {
        return Err("Codex 模型目录为空".to_string());
    }
    Ok(document)
}

async fn read_codex_cache(path: &Path, require_fresh: bool) -> Option<Value> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if require_fresh {
        let modified = metadata.modified().ok()?;
        if modified.elapsed().ok()? > Duration::from_secs(24 * 60 * 60) {
            return None;
        }
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn codex_view(
    document: Value,
    source: AgentModelCatalogSource,
    error: Option<String>,
) -> AgentModelCatalogView {
    let source_models = document
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut models = source_models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) != Some("hide"))
        .filter_map(|model| {
            let id = model.get("slug")?.as_str()?.to_string();
            let label = model
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let reasoning_levels = model
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|level| level.get("effort").and_then(Value::as_str))
                .map(str::to_string)
                .collect();
            Some((
                model
                    .get("priority")
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX),
                AgentModelCatalogItemView {
                    id,
                    label,
                    context_window: model
                        .get("context_window")
                        .and_then(Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok()),
                    reasoning_levels,
                },
            ))
        })
        .collect::<Vec<_>>();
    models.sort_by_key(|(priority, _)| *priority);
    let models = models
        .into_iter()
        .map(|(_, model)| model)
        .collect::<Vec<_>>();
    let default_model = models.first().map(|model| model.id.clone());
    AgentModelCatalogView {
        agent_id: AgentId::parse("codex").expect("built-in id"),
        source,
        models,
        default_model,
        error,
    }
}

fn parse_cursor_models(text: &str) -> (Vec<AgentModelCatalogItemView>, Option<String>) {
    let mut models = Vec::new();
    let mut default_model = None;
    for raw_line in text.lines() {
        let line = strip_ansi(raw_line).trim().to_string();
        if line.is_empty()
            || line.ends_with(':')
            || line.to_ascii_lowercase().starts_with("available model")
        {
            continue;
        }
        let is_default = line.to_ascii_lowercase().contains("(default)");
        let line = line.replace("(default)", "").trim().to_string();
        let (id, label) = line
            .split_once(" - ")
            .map(|(id, label)| (id.trim(), label.trim()))
            .unwrap_or((line.as_str(), line.as_str()));
        if id.is_empty() || id.contains(char::is_whitespace) {
            continue;
        }
        if is_default {
            default_model = Some(id.to_string());
        }
        if !models
            .iter()
            .any(|model: &AgentModelCatalogItemView| model.id == id)
        {
            models.push(AgentModelCatalogItemView {
                id: id.to_string(),
                label: label.to_string(),
                context_window: None,
                reasoning_levels: Vec::new(),
            });
        }
    }
    (models, default_model)
}

struct ProbeError {
    message: String,
    retryable: bool,
}

impl ProbeError {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

async fn fetch_provider_models(
    client: &reqwest::Client,
    agent_id: &AgentId,
    url: url::Url,
    api_key: &str,
) -> Result<Vec<AgentModelCatalogItemView>, ProbeError> {
    let (mut body, mut models) =
        fetch_provider_catalog_page(client, agent_id, url.clone(), api_key).await?;
    let mut page_url = url;
    let mut pages = 1;
    while pages < MAX_CATALOG_PAGES {
        let Some(after_id) = catalog_page_cursor(&body) else {
            break;
        };
        let mut next = page_url.clone();
        next.query_pairs_mut()
            .clear()
            .append_pair("after_id", &after_id)
            .append_pair("after", &after_id)
            .append_pair("limit", "1000");
        match fetch_provider_catalog_page(client, agent_id, next.clone(), api_key).await {
            Ok((next_body, extra)) => {
                if extra.is_empty() {
                    break;
                }
                models.extend(extra);
                let next_cursor = catalog_page_cursor(&next_body);
                page_url = next;
                body = next_body;
                pages += 1;
                if next_cursor.as_deref() == Some(after_id.as_str()) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(normalize_catalog_models(models))
}

async fn fetch_provider_catalog_page(
    client: &reqwest::Client,
    agent_id: &AgentId,
    url: url::Url,
    api_key: &str,
) -> Result<(Value, Vec<AgentModelCatalogItemView>), ProbeError> {
    let request = apply_provider_auth(client.get(url), agent_id, api_key);
    let response = request
        .send()
        .await
        .map_err(|error| ProbeError::retryable(format!("读取 Provider 模型失败：{error}")))?;
    let (status, bytes) = read_limited_body(response).await?;
    if is_auth_failure(status) {
        return Err(ProbeError::fatal(http_catalog_error(status, &bytes)));
    }
    if !status.is_success() {
        let message = http_catalog_error(status, &bytes);
        return Err(if is_missing_endpoint(status) {
            ProbeError::retryable(message)
        } else {
            ProbeError::fatal(message)
        });
    }
    let body = parse_catalog_json(&bytes)?;
    let Some(models) = parse_catalog_models(&body) else {
        return Err(ProbeError::retryable(
            "Provider 模型响应不是有效的模型目录".to_string(),
        ));
    };
    Ok((body, models))
}

fn apply_provider_auth(
    request: reqwest::RequestBuilder,
    agent_id: &AgentId,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let request = request
        .header(reqwest::header::ACCEPT, "application/json")
        .bearer_auth(api_key);
    if AgentKind::Antigravity.matches_id(agent_id.as_str()) {
        request.header("x-goog-api-key", api_key)
    } else {
        // A reusable provider may speak OpenAI or Anthropic depending on a
        // field the draft probe does not carry, so send both credentials —
        // the Bearer token is already on the request.
        request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    }
}

async fn read_limited_body(
    response: reqwest::Response,
) -> Result<(reqwest::StatusCode, Vec<u8>), ProbeError> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err(ProbeError::fatal(
            "Provider 模型响应超过 4 MiB 安全上限".to_string(),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            ProbeError::retryable(format!("读取 Provider 模型响应失败：{error}"))
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
            return Err(ProbeError::fatal(
                "Provider 模型响应超过 4 MiB 安全上限".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}

fn parse_catalog_json(bytes: &[u8]) -> Result<Value, ProbeError> {
    serde_json::from_slice(bytes).map_err(|error| {
        let preview = String::from_utf8_lossy(bytes);
        let message = if preview.trim_start().starts_with('<') {
            "Provider 模型响应不是有效 JSON（收到 HTML 页面）".to_string()
        } else {
            format!("Provider 模型响应不是有效 JSON：{error}")
        };
        ProbeError::retryable(message)
    })
}

fn http_catalog_error(status: reqwest::StatusCode, bytes: &[u8]) -> String {
    let detail = String::from_utf8_lossy(bytes);
    let detail = detail.trim();
    if detail.is_empty() || detail.starts_with('<') {
        format!("Provider 模型目录返回 HTTP {status}")
    } else {
        format!(
            "Provider 模型目录返回 HTTP {status}：{}",
            truncate_error_body(detail)
        )
    }
}

fn truncate_error_body(body: &str) -> String {
    let mut truncated: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
    if body.chars().count() > ERROR_BODY_MAX_CHARS {
        truncated.push('…');
    }
    truncated
}

fn is_auth_failure(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403)
}

fn is_missing_endpoint(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 405)
}

fn catalog_page_cursor(body: &Value) -> Option<String> {
    let has_more = body.get("has_more").and_then(Value::as_bool)?;
    if !has_more {
        return None;
    }
    body.get("last_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Candidate GET URLs for a provider's model catalog.
///
/// Order matches cc-switch: versioned bases keep `{base}/models`; Anthropic
/// protocol suffixes such as `/api/anthropic` try `{base}/v1/models` first,
/// then the origin `/v1/models` fallback.
fn model_catalog_urls(base: &url::Url) -> Vec<url::Url> {
    let path = base.path().trim_end_matches('/');
    let mut paths = Vec::new();
    if path.ends_with("/models") {
        paths.push(path.to_string());
    } else if last_segment_is_api_version(path) {
        paths.push(format!("{path}/models"));
        let last = path.rsplit('/').next().unwrap_or("");
        // `/v4/models` is the primary listing path; keep `/v4/v1/models` as a
        // fallback. `/v1beta` is already a versioned Google path and must not
        // grow another `/v1`.
        if last != "v1"
            && last.strip_prefix('v').is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            paths.push(format!("{path}/v1/models"));
        }
    } else {
        paths.push(format!("{path}/v1/models"));
        if strip_compat_suffix(path).is_none() {
            paths.push(format!("{path}/models"));
        }
    }
    if let Some(stripped) = strip_compat_suffix(path) {
        let stripped = stripped.trim_end_matches('/');
        paths.push(format!("{stripped}/v1/models"));
        paths.push(format!("{stripped}/models"));
    }

    let mut urls = Vec::new();
    for candidate in paths {
        let normalized = if candidate.is_empty() {
            "/".to_string()
        } else if candidate.starts_with('/') {
            candidate
        } else {
            format!("/{candidate}")
        };
        let mut url = base.clone();
        url.set_path(&normalized);
        url.set_query(None);
        url.set_fragment(None);
        if !urls
            .iter()
            .any(|existing: &url::Url| existing.as_str() == url.as_str())
        {
            urls.push(url);
        }
    }
    urls
}

fn strip_compat_suffix(path: &str) -> Option<&str> {
    COMPAT_PROTOCOL_SUFFIXES
        .iter()
        .find(|suffix| path.ends_with(*suffix))
        .map(|suffix| &path[..path.len() - suffix.len()])
}

fn last_segment_is_api_version(path: &str) -> bool {
    is_api_version_segment(path.rsplit('/').next().unwrap_or(""))
}

fn is_api_version_segment(segment: &str) -> bool {
    let Some(rest) = segment.strip_prefix('v') else {
        return false;
    };
    let digit_len = rest.bytes().take_while(u8::is_ascii_digit).count();
    digit_len > 0
        && rest[digit_len..]
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic())
}

fn catalog_entries(body: &Value) -> Option<&Vec<Value>> {
    body.get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .or_else(|| body.as_array())
}

fn parse_catalog_models(body: &Value) -> Option<Vec<AgentModelCatalogItemView>> {
    catalog_entries(body)?;
    Some(parse_openai_models(body))
}

fn parse_openai_models(body: &Value) -> Vec<AgentModelCatalogItemView> {
    let models = catalog_entries(body)
        .into_iter()
        .flatten()
        .filter_map(parse_catalog_model)
        .collect();
    normalize_catalog_models(models)
}

fn parse_catalog_model(model: &Value) -> Option<AgentModelCatalogItemView> {
    let raw_id = match model {
        Value::String(id) => id.as_str(),
        Value::Object(_) => model
            .get("id")
            .or_else(|| model.get("name"))
            .or_else(|| model.get("slug"))?
            .as_str()?,
        _ => return None,
    }
    .trim();
    let id = raw_id.strip_prefix("models/").unwrap_or(raw_id);
    if id.is_empty() {
        return None;
    }
    Some(AgentModelCatalogItemView {
        id: id.to_string(),
        label: model
            .get("display_name")
            .or_else(|| model.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string(),
        context_window: model
            .get("context_window")
            .or_else(|| model.get("context_length"))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        reasoning_levels: Vec::new(),
    })
}

fn normalize_catalog_models(
    mut models: Vec<AgentModelCatalogItemView>,
) -> Vec<AgentModelCatalogItemView> {
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup_by(|left, right| left.id == right.id);
    models
}

fn validate_model_endpoint(base_url: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|error| format!("Provider API URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Provider API URL 仅支持 http 或 https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Provider API URL 不能包含用户名或密码".to_string());
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

fn strip_ansi(value: &str) -> String {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]").expect("ansi regex"))
        .replace_all(value, "")
        .into_owned()
}

fn command_error(command: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr).trim().to_string();
    if detail.is_empty() {
        format!("{command} 返回失败状态")
    } else {
        format!("{command} 失败：{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_parser_preserves_labels_and_default() {
        let (models, default_model) = parse_cursor_models(
            "Available models:\n\u{1b}[32mauto - Auto (default)\u{1b}[0m\ncomposer-1 - Composer 1\n",
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].id, "composer-1");
        assert_eq!(models[1].label, "Composer 1");
        assert_eq!(default_model.as_deref(), Some("auto"));
    }

    #[test]
    fn openai_parser_sorts_deduplicates_and_reads_context() {
        let models = parse_openai_models(&serde_json::json!({
            "data": [
                {"id": "z-model"},
                {"id": "a-model", "context_length": 131072},
                {"id": "a-model"}
            ]
        }));
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "a-model");
        assert_eq!(models[0].context_window, Some(131072));
    }

    #[test]
    fn openai_parser_reads_slug_string_ids_and_top_level_arrays() {
        let from_slug = parse_openai_models(&serde_json::json!({
            "models": [{"slug": "glm-5.3", "display_name": "GLM-5.3"}]
        }));
        assert_eq!(from_slug[0].id, "glm-5.3");
        assert_eq!(from_slug[0].label, "GLM-5.3");

        let from_strings = parse_openai_models(&serde_json::json!({
            "data": ["glm-5.3", "glm-5.2"]
        }));
        assert_eq!(
            from_strings
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["glm-5.2", "glm-5.3"]
        );

        let from_array = parse_openai_models(&serde_json::json!([{"id": "only-model"}]));
        assert_eq!(from_array[0].id, "only-model");
        assert!(
            parse_catalog_models(&serde_json::json!({"error": {"message": "missing"}})).is_none()
        );
    }

    #[test]
    fn endpoint_rejects_credentials_and_non_http_schemes() {
        assert!(validate_model_endpoint("file:///tmp/models").is_err());
        assert!(validate_model_endpoint("https://user:pass@example.com/v1").is_err());
        assert_eq!(
            validate_model_endpoint("https://example.com/v1")
                .unwrap()
                .as_str(),
            "https://example.com/v1/"
        );
    }

    fn catalog_url_strings(base: &str) -> Vec<String> {
        model_catalog_urls(&validate_model_endpoint(base).unwrap())
            .into_iter()
            .map(|url| url.to_string())
            .collect()
    }

    #[test]
    fn catalog_urls_keep_versioned_openai_endpoints() {
        assert_eq!(
            catalog_url_strings("https://example.com/v1"),
            vec!["https://example.com/v1/models"]
        );
        assert_eq!(
            catalog_url_strings("https://api.z.ai/api/coding/paas/v4"),
            vec![
                "https://api.z.ai/api/coding/paas/v4/models",
                "https://api.z.ai/api/coding/paas/v4/v1/models",
            ]
        );
        assert_eq!(
            catalog_url_strings("https://generativelanguage.googleapis.com/v1beta"),
            vec!["https://generativelanguage.googleapis.com/v1beta/models"]
        );
        assert_eq!(
            catalog_url_strings("https://api.openai.com/v1/models"),
            vec!["https://api.openai.com/v1/models"]
        );
    }

    #[test]
    fn catalog_urls_probe_anthropic_compat_bases_like_cc_switch() {
        assert_eq!(
            catalog_url_strings("https://api.z.ai/api/anthropic"),
            vec![
                "https://api.z.ai/api/anthropic/v1/models",
                "https://api.z.ai/v1/models",
                "https://api.z.ai/models",
            ]
        );
        assert_eq!(
            catalog_url_strings("https://api.deepseek.com/anthropic"),
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
        assert_eq!(
            catalog_url_strings("https://api.siliconflow.cn"),
            vec![
                "https://api.siliconflow.cn/v1/models",
                "https://api.siliconflow.cn/models",
            ]
        );
    }

    #[test]
    fn catalog_page_cursor_follows_anthropic_has_more() {
        assert_eq!(
            catalog_page_cursor(&serde_json::json!({
                "has_more": true,
                "last_id": "page-2"
            }))
            .as_deref(),
            Some("page-2")
        );
        assert!(
            catalog_page_cursor(&serde_json::json!({
                "has_more": false,
                "last_id": "page-2"
            }))
            .is_none()
        );
    }

    #[tokio::test]
    async fn provider_catalog_uses_the_draft_endpoint_and_returns_normalized_models() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/models HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer draft-secret")
            );

            let body = r#"{"data":[{"id":"z-model"},{"id":"a-model","display_name":"A Model"},{"id":"a-model"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let catalog = provider(
            AgentId::parse("codex").unwrap(),
            &format!("http://{address}/v1"),
            "draft-secret",
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(catalog.agent_id.as_str(), "codex");
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[0].id, "a-model");
        assert_eq!(catalog.models[0].label, "A Model");
        assert_eq!(catalog.models[1].id, "z-model");
    }

    #[tokio::test]
    async fn pi_provider_catalog_probes_with_both_credential_headers() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.starts_with("get /v1/models http/1.1"));
            assert!(request.contains("authorization: bearer draft-secret"));
            assert!(request.contains("x-api-key: draft-secret"));
            assert!(request.contains("anthropic-version: 2023-06-01"));

            let body = r#"{"data":[{"id":"glm-5.2"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let catalog = provider(
            AgentId::parse("pi").unwrap(),
            &format!("http://{address}/v1"),
            "draft-secret",
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(catalog.agent_id.as_str(), "pi");
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].id, "glm-5.2");
    }

    #[tokio::test]
    async fn grok_provider_catalog_probes_the_same_way_as_pi() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.starts_with("get /v1/models http/1.1"));
            assert!(request.contains("authorization: bearer draft-secret"));
            assert!(request.contains("x-api-key: draft-secret"));
            assert!(request.contains("anthropic-version: 2023-06-01"));

            let body = r#"{"data":[{"id":"grok-4"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let catalog = provider(
            AgentId::parse("grok").unwrap(),
            &format!("http://{address}/v1"),
            "draft-secret",
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(catalog.agent_id.as_str(), "grok");
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].id, "grok-4");
    }

    #[tokio::test]
    async fn anthropic_compat_base_probes_v1_models_not_bare_models() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /api/anthropic/v1/models HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer draft-secret")
            );
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("x-api-key: draft-secret")
            );
            assert!(request.contains("anthropic-version: 2023-06-01"));

            let body = r#"{"data":[{"id":"glm-5.3","display_name":"GLM-5.3"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let catalog = provider(
            AgentId::parse("claude_code").unwrap(),
            &format!("http://{address}/api/anthropic"),
            "draft-secret",
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].id, "glm-5.3");
        assert_eq!(catalog.models[0].label, "GLM-5.3");
    }

    #[tokio::test]
    async fn provider_catalog_skips_missing_or_non_catalog_candidates() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0_u8; 4096];
                let read = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let (status, body) = if request.starts_with("GET /api/anthropic/v1/models ") {
                    ("404 Not Found", r#"{"error":{"message":"not found"}}"#)
                } else if request.starts_with("GET /v1/models ") {
                    ("200 OK", r#"{"data":[{"id":"glm-5.3"}]}"#)
                } else {
                    panic!("unexpected request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let catalog = provider(
            AgentId::parse("claude_code").unwrap(),
            &format!("http://{address}/api/anthropic"),
            "draft-secret",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(catalog.models[0].id, "glm-5.3");
    }

    #[tokio::test]
    async fn provider_catalog_stops_on_auth_failure() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /api/anthropic/v1/models "));
            let body = r#"{"error":{"message":"invalid api key"}}"#;
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            let second = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            assert!(
                second.is_err(),
                "401 must not fall through to later candidates"
            );
        });

        let error = provider(
            AgentId::parse("claude_code").unwrap(),
            &format!("http://{address}/api/anthropic"),
            "draft-secret",
        )
        .await
        .unwrap_err();
        server.await.unwrap();
        assert!(error.contains("HTTP 401"));
        assert!(error.contains("invalid api key"));
    }

    #[tokio::test]
    async fn provider_catalog_reports_non_json_when_every_candidate_fails() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut request = vec![0_u8; 4096];
                let _ = stream.read(&mut request).await.unwrap();
                let body = "<html>not json</html>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let error = provider(
            AgentId::parse("codex").unwrap(),
            &format!("http://{address}/v1"),
            "draft-secret",
        )
        .await
        .unwrap_err();
        server.abort();
        assert!(error.contains("不是有效 JSON"));
        assert!(error.contains("HTML"));
    }

    #[tokio::test]
    async fn cursor_cannot_probe_a_reusable_provider_catalog() {
        let error = provider(
            AgentId::parse("cursor").unwrap(),
            "https://example.com/v1",
            "draft-secret",
        )
        .await
        .unwrap_err();
        assert_eq!(error, "该 Agent 不支持 Provider 模型探测");
    }

    #[test]
    fn codex_custom_catalog_clones_official_shape_and_excludes_entries() {
        let official = vec![
            serde_json::json!({
                "slug": "official-a",
                "display_name": "Official A",
                "visibility": "list",
                "priority": 0,
                "context_window": 1000,
                "required_shape": {"kept": true}
            }),
            serde_json::json!({
                "slug": "official-b",
                "display_name": "Official B",
                "visibility": "list",
                "priority": 1
            }),
        ];
        let request = CodexModelCatalogConfigRequest {
            customs: vec![api_types::CodexCustomModelRequest {
                slug: "gateway/model".to_string(),
                display_name: Some("Gateway Model".to_string()),
                context_window: Some(2048),
                base: "official-a".to_string(),
                overrides: Some(serde_json::json!({
                    "default_verbosity": "high",
                    "supports_parallel_tool_calls": false
                })),
            }],
            excluded_officials: vec!["official-b".to_string()],
            default_model: Some("gateway/model".to_string()),
        };
        validate_codex_config(&request, &official).unwrap();
        let expanded = expand_codex_catalog(&request, &official).unwrap();
        let models = expanded["models"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["slug"], "gateway/model");
        assert_eq!(models[0]["context_window"], 2048);
        assert_eq!(models[0]["required_shape"]["kept"], true);
        assert_eq!(models[0]["default_verbosity"], "high");
        assert_eq!(models[0]["supports_parallel_tool_calls"], false);
        assert_eq!(models[1]["slug"], "official-a");
    }

    #[test]
    fn provider_catalog_keeps_custom_slugs_without_an_official_template() {
        let request = CodexModelCatalogConfigRequest {
            customs: vec![api_types::CodexCustomModelRequest {
                slug: "gpt-5.6-sol".to_string(),
                display_name: Some("GPT-5.6-Sol".to_string()),
                context_window: None,
                base: "gpt-5.5".to_string(),
                overrides: None,
            }],
            excluded_officials: Vec::new(),
            default_model: Some("gpt-5.6-sol".to_string()),
        };
        let expanded = expand_provider_codex_catalog(&request, &[]).unwrap();
        let models = expanded["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["slug"], "gpt-5.6-sol");
        assert_eq!(models[0]["display_name"], "GPT-5.6-Sol");
        assert_eq!(models[0]["visibility"], "list");
        assert_eq!(models[0]["supported_in_api"], true);
    }

    #[test]
    fn imports_foreign_codex_catalog_as_compact_user_intent() {
        let official = vec![
            serde_json::json!({
                "slug": "official-a",
                "display_name": "Official A",
                "visibility": "list",
                "priority": 0,
                "context_window": 1000,
                "wire_api": "responses"
            }),
            serde_json::json!({
                "slug": "official-b",
                "display_name": "Official B",
                "visibility": "list",
                "priority": 1
            }),
        ];
        let foreign = serde_json::json!({
            "models": [
                official[0].clone(),
                {
                    "slug": "gateway/model",
                    "display_name": "Gateway Model",
                    "visibility": "list",
                    "priority": 1,
                    "context_window": 4096,
                    "wire_api": "chat"
                }
            ]
        });

        let imported = import_codex_catalog(&foreign, Some("gateway/model"), &official);

        assert_eq!(imported.customs.len(), 1);
        assert_eq!(imported.customs[0].slug, "gateway/model");
        assert_eq!(imported.customs[0].base, "official-a");
        assert_eq!(imported.customs[0].context_window, Some(4096));
        assert_eq!(
            imported.customs[0]
                .overrides
                .as_ref()
                .and_then(|value| value.get("wire_api")),
            Some(&serde_json::json!("chat"))
        );
        assert_eq!(imported.excluded_officials, vec!["official-b"]);
        assert_eq!(imported.default_model.as_deref(), Some("gateway/model"));
    }

    #[tokio::test]
    async fn load_config_adopts_relative_external_catalog_without_rewriting_it() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = temp.path().join("external.json");
        std::fs::write(
            &catalog,
            serde_json::to_vec(&serde_json::json!({
                "models": [{
                    "slug": "custom-model",
                    "display_name": "Custom",
                    "visibility": "list"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            "model = \"custom-model\"\nmodel_catalog_json = \"external.json\"\n",
        )
        .unwrap();

        let loaded = load_codex_config(temp.path()).await.unwrap();

        assert!(loaded.active);
        assert_eq!(loaded.catalog_path, catalog.display().to_string());
        assert!(loaded.customs.is_empty());
        assert!(loaded.excluded_officials.is_empty());
        assert_eq!(loaded.default_model.as_deref(), Some("custom-model"));
        assert!(!temp.path().join(CODEX_SOURCE_FILE).exists());
        assert!(
            std::fs::read_to_string(&catalog)
                .unwrap()
                .contains("custom-model")
        );
    }

    #[tokio::test]
    async fn load_config_keeps_external_catalog_without_official_document() {
        let temp = tempfile::tempdir().unwrap();
        let catalog = temp.path().join("external.json");
        std::fs::write(
            &catalog,
            serde_json::to_vec(&serde_json::json!({
                "models": [{
                    "slug": "custom-model",
                    "display_name": "Custom",
                    "visibility": "list"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            temp.path().join("config.toml"),
            "model = \"custom-model\"\nmodel_catalog_json = \"external.json\"\n",
        )
        .unwrap();

        let loaded = load_codex_config(temp.path()).await.unwrap();

        assert!(loaded.active);
        assert_eq!(loaded.catalog_path, catalog.display().to_string());
        assert!(loaded.customs.is_empty());
        assert_eq!(loaded.default_model.as_deref(), Some("custom-model"));
        assert!(!temp.path().join(CODEX_SOURCE_FILE).exists());
    }
}
