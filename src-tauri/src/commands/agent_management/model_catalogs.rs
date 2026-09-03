use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use agents::NativeFileMutation;
use api_types::{
    AgentId, AgentModelCatalogItemView, AgentModelCatalogSource, AgentModelCatalogView,
    CodexModelCatalogConfigRequest, CodexModelCatalogConfigView,
};
use futures::StreamExt;
use serde_json::Value;

use super::{agent_process_command, apply_native_file_mutations, write_bytes_document};

const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const CODEX_CATALOG_FILE: &str = "vibex-model-catalog.json";
const CODEX_SOURCE_FILE: &str = "vibex-model-catalog.source.json";
type CodexCatalogFiles = (bool, Option<Vec<u8>>, Option<Vec<u8>>);
const IMPORT_SKIP_KEYS: &[&str] = &[
    "slug",
    "display_name",
    "context_window",
    "visibility",
    "supported_in_api",
    "priority",
    "upgrade",
];

pub(super) async fn cursor(
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

pub(super) async fn kimi(base_url: &str, api_key: &str) -> Result<AgentModelCatalogView, String> {
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

pub(super) async fn provider(
    agent_id: AgentId,
    base_url: &str,
    api_key: &str,
) -> Result<AgentModelCatalogView, String> {
    if !matches!(
        agent_id.as_str(),
        "claude_code" | "codex" | "kimi_code" | "antigravity" | "gemini"
    ) {
        return Err("该 Agent 不支持 Provider 模型探测".to_string());
    }
    let base_url = validate_model_endpoint(base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("读取 Provider 模型需要填写 API Key".to_string());
    }
    let url = base_url
        .join("models")
        .map_err(|error| format!("Provider 模型地址无效：{error}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("创建 Provider 模型客户端失败：{error}"))?;
    let mut request = client.get(url).bearer_auth(api_key);
    request = match agent_id.as_str() {
        "claude_code" => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        "gemini" | "antigravity" => request.header("x-goog-api-key", api_key),
        _ => request,
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("读取 Provider 模型失败：{error}"))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err("Provider 模型响应超过 4 MiB 安全上限".to_string());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 Provider 模型响应失败：{error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_CATALOG_BYTES {
            return Err("Provider 模型响应超过 4 MiB 安全上限".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(format!("Provider 模型目录返回 HTTP {status}"));
    }
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Provider 模型响应不是有效 JSON：{error}"))?;
    let models = parse_openai_models(&body);
    Ok(AgentModelCatalogView {
        agent_id,
        source: AgentModelCatalogSource::Live,
        models,
        default_model: None,
        error: None,
    })
}

pub(super) async fn codex(
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

pub(super) async fn codex_official_document(
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

pub(super) async fn load_codex_config(
    codex_home: &Path,
) -> Result<CodexModelCatalogConfigView, String> {
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

pub(super) async fn peek_external_codex_catalog(
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

pub(super) fn first_catalog_slug(catalog: &Value) -> Option<String> {
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

pub(super) async fn apply_codex_config(
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
    apply_native_file_mutations(&mutations)
        .await
        .map_err(|error| error.message)?;
    Ok(CodexModelCatalogConfigView {
        customs: request.customs,
        excluded_officials: request.excluded_officials,
        default_model: request.default_model,
        catalog_path: catalog_path.display().to_string(),
        source_path: source_path.display().to_string(),
        active,
    })
}

pub(super) fn build_codex_catalog_files(
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

fn parse_openai_models(body: &Value) -> Vec<AgentModelCatalogItemView> {
    let entries = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array));
    let mut models = entries
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let raw_id = model
                .get("id")
                .or_else(|| model.get("name"))?
                .as_str()?
                .trim();
            let id = raw_id.strip_prefix("models/").unwrap_or(raw_id);
            (!id.is_empty()).then(|| AgentModelCatalogItemView {
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
        })
        .collect::<Vec<_>>();
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
        assert_eq!(
            std::fs::read_to_string(&catalog)
                .unwrap()
                .contains("custom-model"),
            true
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
