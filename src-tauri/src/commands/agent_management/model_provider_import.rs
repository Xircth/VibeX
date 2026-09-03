use std::path::{Path, PathBuf};

use api_types::{
    AgentId, AgentKind, AgentModelProviderImportCandidateView, AgentModelProviderImportPreviewView,
    AgentModelProviderImportSource,
};
use serde_json::Value;
use sqlx::{Row, sqlite::SqliteConnectOptions};

#[derive(Debug, Clone)]
pub(super) struct ImportDraft {
    pub source_id: String,
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub model: String,
    pub skip_reason: Option<String>,
}

pub(super) fn cc_switch_db_path(home: &Path) -> PathBuf {
    std::env::var_os("CC_SWITCH_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cc-switch"))
        .join("cc-switch.db")
}

pub(super) fn cc_switch_app_type(agent_id: &AgentId) -> Option<&'static str> {
    match agent_id.as_str() {
        "claude_code" => Some("claude"),
        "codex" => Some("codex"),
        "grok" => Some("grokbuild"),
        "opencode" => Some("opencode"),
        "openclaw" => Some("openclaw"),
        "hermes" => Some("hermes"),
        "pi" => Some("pi"),
        id if AgentKind::Antigravity.matches_id(id) => Some("gemini"),
        _ => None,
    }
}

pub(super) async fn preview_cc_switch(
    home: &Path,
    agent_id: &AgentId,
    existing_names: &[String],
) -> (PathBuf, Vec<ImportDraft>, Option<String>) {
    let path = cc_switch_db_path(home);
    let Some(app_type) = cc_switch_app_type(agent_id) else {
        return (
            path,
            Vec::new(),
            Some("此 Agent 不支持从 CC Switch 导入".to_string()),
        );
    };
    if !path.is_file() {
        return (
            path.clone(),
            Vec::new(),
            Some(format!("未找到 CC Switch 数据库：{}", path.display())),
        );
    }
    match read_cc_switch_providers(&path, app_type).await {
        Ok(rows) => {
            let drafts = rows
                .into_iter()
                .map(|row| annotate_duplicate(extract_cc_switch_row(agent_id, row), existing_names))
                .collect();
            (path, drafts, None)
        }
        Err(error) => (path, Vec::new(), Some(error)),
    }
}

struct CcSwitchRow {
    id: String,
    name: String,
    settings_config: Value,
    meta: Value,
}

async fn read_cc_switch_providers(path: &Path, app_type: &str) -> Result<Vec<CcSwitchRow>, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(true);
    let pool = sqlx::SqlitePool::connect_with(options)
        .await
        .map_err(|error| format!("无法打开 CC Switch 数据库：{error}"))?;
    let rows = sqlx::query(
        "SELECT id, name, settings_config, meta FROM providers WHERE app_type = ?1 ORDER BY name, id",
    )
    .bind(app_type)
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("读取 CC Switch 供应商失败：{error}"))?;
    pool.close().await;
    let mut providers = Vec::new();
    for row in rows {
        let settings_config = parse_json_object(row.try_get::<String, _>("settings_config").ok());
        let meta = parse_json_object(row.try_get::<String, _>("meta").ok());
        providers.push(CcSwitchRow {
            id: row.try_get::<String, _>("id").unwrap_or_default(),
            name: row.try_get::<String, _>("name").unwrap_or_default(),
            settings_config,
            meta,
        });
    }
    Ok(providers)
}

fn parse_json_object(raw: Option<String>) -> Value {
    raw.and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Object(Default::default()))
}

fn extract_cc_switch_row(agent_id: &AgentId, row: CcSwitchRow) -> ImportDraft {
    let mut draft = ImportDraft {
        source_id: row.id,
        name: row.name,
        api_url: String::new(),
        api_key: String::new(),
        model: String::new(),
        skip_reason: None,
    };
    if should_skip_cc_switch(&row.meta, &row.settings_config) {
        draft.skip_reason = Some("无法投影的认证方式".to_string());
        return draft;
    }
    match agent_id.as_str() {
        "claude_code" => fill_claude_settings(&row.settings_config, &mut draft),
        "codex" => fill_codex_settings(&row.settings_config, &mut draft),
        "grok" => fill_grok_settings(&row.settings_config, &mut draft),
        "opencode" => fill_opencode_settings(&row.settings_config, &mut draft),
        "openclaw" => fill_openclaw_settings(&row.settings_config, &mut draft),
        "hermes" => fill_hermes_settings(&row.settings_config, &mut draft),
        "pi" => fill_pi_settings(&row.settings_config, &mut draft),
        _ => fill_gemini_settings(&row.settings_config, &mut draft),
    }
    if draft.skip_reason.is_none() && (draft.api_url.is_empty() || draft.api_key.is_empty()) {
        draft.skip_reason = Some("缺少端点或凭据".to_string());
    }
    draft
}

fn should_skip_cc_switch(meta: &Value, settings: &Value) -> bool {
    let provider_type = meta
        .get("providerType")
        .or_else(|| meta.get("provider_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(
        provider_type,
        "codex_oauth" | "xai_oauth" | "github_copilot"
    ) {
        return true;
    }
    settings
        .pointer("/env/ANTHROPIC_BASE_URL")
        .and_then(Value::as_str)
        .is_some_and(|url| url.contains("chatgpt.com/backend-api/codex"))
}

fn fill_claude_settings(settings: &Value, draft: &mut ImportDraft) {
    let env = settings.get("env").unwrap_or(settings);
    draft.api_url = json_string(env, &["ANTHROPIC_BASE_URL"]);
    draft.api_key = json_string(env, &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    let mut mapping = serde_json::Map::new();
    for (source, key) in [
        ("main", "ANTHROPIC_MODEL"),
        ("reasoning", "ANTHROPIC_REASONING_MODEL"),
        ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
        ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
        ("customOption", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
        ("customOptionName", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
        (
            "customOptionDescription",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
        ),
    ] {
        let value = json_string(env, &[key]);
        if !value.is_empty() {
            mapping.insert(source.to_string(), Value::String(value));
        }
    }
    draft.model = if mapping.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&mapping).unwrap_or_default()
    };
}

fn fill_codex_settings(settings: &Value, draft: &mut ImportDraft) {
    let auth = settings.get("auth").unwrap_or(settings);
    draft.api_key = json_string(auth, &["OPENAI_API_KEY"]);
    let config_text = settings
        .get("config")
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| serde_json::to_string_pretty(value).ok())
        })
        .unwrap_or_default();
    let table = toml::from_str::<toml::Table>(&config_text).unwrap_or_default();
    draft.api_url = table
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| {
            let active = table
                .get("model_provider")
                .and_then(toml::Value::as_str)
                .unwrap_or("");
            providers
                .get(active)
                .or_else(|| providers.values().next())
                .and_then(toml::Value::as_table)
        })
        .and_then(|provider| provider.get("base_url"))
        .and_then(toml::Value::as_str)
        .or_else(|| {
            table
                .get("openai_base_url")
                .or_else(|| table.get("api_base_url"))
                .and_then(toml::Value::as_str)
        })
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(model) = table.get("model").and_then(toml::Value::as_str) {
        draft.model = serde_json::json!({ "default_model": model }).to_string();
    }
}

fn fill_grok_settings(settings: &Value, draft: &mut ImportDraft) {
    let config_text = settings
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if config_text.trim().is_empty() {
        draft.skip_reason = Some("官方登录状态无法投影为自定义端点".to_string());
        return;
    }
    let table = toml::from_str::<toml::Table>(&config_text).unwrap_or_default();
    let default = table
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("default"))
        .and_then(toml::Value::as_str)
        .unwrap_or("");
    let Some(entry) = table
        .get("model")
        .and_then(toml::Value::as_table)
        .and_then(|models| {
            models
                .get(default)
                .or_else(|| models.values().next())
                .and_then(toml::Value::as_table)
        })
    else {
        draft.skip_reason = Some("缺少端点或凭据".to_string());
        return;
    };
    draft.api_url = entry
        .get("base_url")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    draft.api_key = entry
        .get("api_key")
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let model_id = entry
        .get("model")
        .and_then(toml::Value::as_str)
        .unwrap_or(default)
        .to_string();
    draft.model = serde_json::json!({
        "id": model_id,
        "api_backend": entry.get("api_backend").and_then(toml::Value::as_str).unwrap_or("responses"),
        "context_window": entry.get("context_window").and_then(toml::Value::as_integer)
    })
    .to_string();
}

fn fill_opencode_settings(settings: &Value, draft: &mut ImportDraft) {
    let options = settings.get("options").unwrap_or(settings);
    draft.api_url = json_string(options, &["baseURL", "baseUrl", "base_url"]);
    draft.api_key = json_string(options, &["apiKey", "api_key"]);
    if let Some((id, model)) = settings
        .get("models")
        .and_then(Value::as_object)
        .and_then(|models| models.iter().next())
    {
        let name = model
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id.as_str());
        draft.model = serde_json::json!({
            "id": id,
            "name": name,
            "npm": json_string(settings, &["npm"])
        })
        .to_string();
    }
}

fn fill_openclaw_settings(settings: &Value, draft: &mut ImportDraft) {
    draft.api_url = json_string(settings, &["baseUrl", "base_url"]);
    draft.api_key = json_string(settings, &["apiKey", "api_key"]);
    if let Some(model) = settings
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.first())
    {
        draft.model = json_string(model, &["id"]).if_empty_then(|| json_string(model, &["name"]));
    }
}

fn fill_pi_settings(settings: &Value, draft: &mut ImportDraft) {
    if let Some((id, provider)) = settings
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|providers| providers.iter().next())
    {
        fill_pi_provider(id, provider, settings, draft);
        return;
    }
    let id = json_string(settings, &["id", "name"]);
    fill_pi_provider(
        if id.is_empty() { "pi" } else { &id },
        settings,
        settings,
        draft,
    );
}

fn fill_pi_provider(id: &str, provider: &Value, root: &Value, draft: &mut ImportDraft) {
    draft.api_url = json_string(provider, &["baseUrl", "base_url"]);
    draft.api_key = json_string(provider, &["apiKey", "api_key"]).if_empty_then(|| {
        json_string(root, &["apiKey", "api_key"]).if_empty_then(|| {
            root.get("auth")
                .and_then(Value::as_object)
                .and_then(|auth| auth.get(id))
                .map(|entry| json_string(entry, &["key", "apiKey", "api_key"]))
                .unwrap_or_default()
        })
    });
    let api = json_string(provider, &["api"]).if_empty_then(|| "openai-responses".to_string());
    let model = provider
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.first())
        .map(|entry| json_string(entry, &["id"]))
        .unwrap_or_else(|| json_string(provider, &["model", "defaultModel"]));
    draft.model = serde_json::json!({ "id": model, "api": api }).to_string();
}

fn fill_hermes_settings(settings: &Value, draft: &mut ImportDraft) {
    draft.api_url = json_string(settings, &["base_url", "baseUrl"]);
    draft.api_key = json_string(settings, &["api_key", "apiKey"]);
    if let Some(model) = settings
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| models.first())
    {
        draft.model = json_string(model, &["id"]);
    } else {
        draft.model = json_string(settings, &["name"]);
    }
}

trait IfEmpty {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String;
}

impl IfEmpty for String {
    fn if_empty_then(self, fallback: impl FnOnce() -> String) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn fill_gemini_settings(settings: &Value, draft: &mut ImportDraft) {
    let env = settings.get("env").unwrap_or(settings);
    draft.api_url = json_string(
        env,
        &["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "API_BASE_URL"],
    );
    draft.api_key = json_string(
        env,
        &["GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"],
    );
    draft.model = json_string(env, &["GEMINI_MODEL"]);
}

fn json_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| {
            value
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
        })
        .unwrap_or("")
        .to_string()
}

pub(super) fn annotate_duplicate(mut draft: ImportDraft, existing_names: &[String]) -> ImportDraft {
    if draft.skip_reason.is_none()
        && existing_names
            .iter()
            .any(|name| name.eq_ignore_ascii_case(&draft.name))
    {
        draft.skip_reason = Some("已存在同名预设".to_string());
    }
    draft
}

pub(super) fn drafts_to_preview(
    agent_id: AgentId,
    source: AgentModelProviderImportSource,
    source_path: Option<String>,
    drafts: Vec<ImportDraft>,
    error: Option<String>,
) -> AgentModelProviderImportPreviewView {
    AgentModelProviderImportPreviewView {
        agent_id,
        source,
        source_path,
        candidates: drafts.iter().map(ImportDraft::to_view).collect(),
        error,
    }
}

impl ImportDraft {
    pub(super) fn to_view(&self) -> AgentModelProviderImportCandidateView {
        AgentModelProviderImportCandidateView {
            source_id: self.source_id.clone(),
            name: self.name.clone(),
            api_url: self.api_url.clone(),
            model: self.model.clone(),
            credential_present: !self.api_key.trim().is_empty(),
            skip_reason: self.skip_reason.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_codex_oauth_and_chatgpt_reverse_proxy() {
        let oauth = extract_cc_switch_row(
            &AgentId::parse("claude_code").unwrap(),
            CcSwitchRow {
                id: "oauth".into(),
                name: "Codex OAuth".into(),
                settings_config: serde_json::json!({
                    "env": { "ANTHROPIC_BASE_URL": "https://api.example.com" }
                }),
                meta: serde_json::json!({ "providerType": "codex_oauth" }),
            },
        );
        assert_eq!(oauth.skip_reason.as_deref(), Some("无法投影的认证方式"));

        let proxy = extract_cc_switch_row(
            &AgentId::parse("claude_code").unwrap(),
            CcSwitchRow {
                id: "proxy".into(),
                name: "ChatGPT Relay".into(),
                settings_config: serde_json::json!({
                    "env": {
                        "ANTHROPIC_BASE_URL": "https://chatgpt.com/backend-api/codex",
                        "ANTHROPIC_API_KEY": "secret"
                    }
                }),
                meta: serde_json::json!({}),
            },
        );
        assert_eq!(proxy.skip_reason.as_deref(), Some("无法投影的认证方式"));
    }

    #[test]
    fn extracts_claude_env_and_marks_duplicate_names() {
        let draft = extract_cc_switch_row(
            &AgentId::parse("claude_code").unwrap(),
            CcSwitchRow {
                id: "deepseek".into(),
                name: "DeepSeek".into(),
                settings_config: serde_json::json!({
                    "env": {
                        "ANTHROPIC_BASE_URL": "https://api.deepseek.com",
                        "ANTHROPIC_AUTH_TOKEN": "sk-test",
                        "ANTHROPIC_MODEL": "deepseek-chat"
                    }
                }),
                meta: serde_json::json!({}),
            },
        );
        assert!(draft.skip_reason.is_none());
        assert_eq!(draft.api_url, "https://api.deepseek.com");
        assert_eq!(draft.api_key, "sk-test");
        assert!(draft.model.contains("deepseek-chat"));
        let skipped = annotate_duplicate(draft, &["deepseek".to_string()]);
        assert_eq!(skipped.skip_reason.as_deref(), Some("已存在同名预设"));
    }

    #[test]
    fn extracts_codex_auth_and_toml_config() {
        let draft = extract_cc_switch_row(
            &AgentId::parse("codex").unwrap(),
            CcSwitchRow {
                id: "gw".into(),
                name: "Gateway".into(),
                settings_config: serde_json::json!({
                    "auth": { "OPENAI_API_KEY": "sk-codex" },
                    "config": "model = \"gpt-5.4\"\nmodel_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://gateway.example/v1\"\n"
                }),
                meta: serde_json::json!({}),
            },
        );
        assert!(draft.skip_reason.is_none());
        assert_eq!(draft.api_url, "https://gateway.example/v1");
        assert_eq!(draft.api_key, "sk-codex");
        assert!(draft.model.contains("gpt-5.4"));
    }

    #[test]
    fn extracts_pi_provider_entries() {
        let draft = extract_cc_switch_row(
            &AgentId::parse("pi").unwrap(),
            CcSwitchRow {
                id: "gw".into(),
                name: "Gateway".into(),
                settings_config: serde_json::json!({
                    "providers": {
                        "private": {
                            "baseUrl": "https://private.example/v1",
                            "api": "openai-responses",
                            "models": [{ "id": "private-model" }]
                        }
                    },
                    "auth": { "private": { "type": "api_key", "key": "sk-pi" } }
                }),
                meta: serde_json::json!({}),
            },
        );
        assert!(draft.skip_reason.is_none());
        assert_eq!(draft.api_url, "https://private.example/v1");
        assert_eq!(draft.api_key, "sk-pi");
        assert!(draft.model.contains("private-model"));
        assert!(draft.model.contains("openai-responses"));
    }
}
