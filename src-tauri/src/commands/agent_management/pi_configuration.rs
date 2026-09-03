use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use api_types::{
    PiCommandValidationView, PiConfigurationView, PiCredentialsSaveRequest, PiCustomProviderView,
    PiRuntimeConfigurationView, PiRuntimeSaveRequest,
};
use serde_json::{Map, Value};

use super::{
    agent_process_command, apply_native_file_mutations, json_document_mutation,
    read_json_object_or_empty, read_json_object_state,
};

const PI_COMMAND_ENV: &str = "PI_ACP_PI_COMMAND";
const PI_CONFIG_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV: &str = "PI_CODING_AGENT_SESSION_DIR";
const PI_TRUST_WORKSPACE_ENV: &str = "PI_ACP_TRUST_WORKSPACE";
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];
const BUILT_IN_PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "vercel-ai-gateway",
    "xai",
    "deepseek",
    "groq",
    "cerebras",
    "mistral",
    "nvidia",
    "together",
    "fireworks",
    "huggingface",
    "kimi-coding",
    "moonshotai",
    "moonshotai-cn",
    "zai",
    "zai-coding-cn",
    "minimax",
    "minimax-cn",
    "ant-ling",
    "xiaomi",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp",
    "opencode",
    "opencode-go",
];
const CUSTOM_PROTOCOLS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];

pub(super) async fn load(
    pool: &sqlx::SqlitePool,
    home: &Path,
) -> Result<PiConfigurationView, String> {
    let env = read_pi_env(pool).await?;
    let agent_dir = pi_agent_dir(home, &env);
    let settings = read_json_object_or_empty(&agent_dir.join("settings.json"))
        .await
        .map_err(|error| error.message)?;
    let auth = read_json_object_or_empty(&agent_dir.join("auth.json"))
        .await
        .map_err(|error| error.message)?;
    let models = read_json_object_or_empty(&agent_dir.join("models.json"))
        .await
        .map_err(|error| error.message)?;
    let mut auth_providers = auth
        .as_object()
        .into_iter()
        .flat_map(|auth| auth.keys().cloned())
        .collect::<Vec<_>>();
    auth_providers.sort();
    let default_provider = settings
        .get("defaultProvider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut custom_providers = models
        .get("providers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, provider)| {
            let provider = provider.as_object()?;
            Some(PiCustomProviderView {
                id: id.clone(),
                base_url: provider
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                api: provider
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or("openai-responses")
                    .to_string(),
            })
        })
        .collect::<Vec<_>>();
    custom_providers.sort_by(|left, right| left.id.cmp(&right.id));
    let credential_present = auth
        .get(&default_provider)
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("key"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    Ok(PiConfigurationView {
        default_provider,
        default_model: settings
            .get("defaultModel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        thinking_level: settings
            .get("defaultThinkingLevel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        credential_present,
        auth_providers,
        custom_providers,
        runtime: PiRuntimeConfigurationView {
            mode: if env
                .get(PI_COMMAND_ENV)
                .is_some_and(|command| !command.trim().is_empty())
            {
                "custom".to_string()
            } else {
                "default".to_string()
            },
            command: env.get(PI_COMMAND_ENV).cloned().unwrap_or_default(),
            config_dir: env.get(PI_CONFIG_DIR_ENV).cloned().unwrap_or_default(),
            session_dir: env.get(PI_SESSION_DIR_ENV).cloned().unwrap_or_default(),
            trust_workspace: env
                .get(PI_TRUST_WORKSPACE_ENV)
                .is_none_or(|value| value.trim() != "0"),
        },
    })
}

pub(super) async fn save_credentials(
    pool: &sqlx::SqlitePool,
    home: &Path,
    request: PiCredentialsSaveRequest,
) -> Result<PiConfigurationView, String> {
    let provider = request.provider.trim();
    let model = request.model.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("Pi Provider 与模型不能为空".to_string());
    }
    if provider.chars().any(char::is_whitespace) {
        return Err("Pi Provider ID 不能包含空格".to_string());
    }
    if request
        .api_key
        .as_deref()
        .is_some_and(|key| key.contains(['\n', '\r']))
    {
        return Err("Pi API Key 不能包含换行符".to_string());
    }
    let thinking_level = request
        .thinking_level
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if thinking_level.is_some_and(|value| !THINKING_LEVELS.contains(&value)) {
        return Err("Pi 推理强度无效".to_string());
    }
    let custom_base_url = request
        .custom_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let custom_api = request
        .custom_api
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if custom_base_url.is_some() != custom_api.is_some() {
        return Err("自定义 Pi Provider 需要同时填写 API URL 与协议".to_string());
    }
    if custom_base_url.is_some() && BUILT_IN_PROVIDERS.contains(&provider) {
        return Err("自定义 Pi Provider ID 不能与内置 Provider 重名".to_string());
    }
    if let Some(base_url) = custom_base_url {
        validate_http_url(base_url)?;
    }
    if custom_api.is_some_and(|api| !CUSTOM_PROTOCOLS.contains(&api)) {
        return Err("Pi 自定义 Provider 协议无效".to_string());
    }

    let env = read_pi_env(pool).await?;
    let agent_dir = pi_agent_dir(home, &env);
    let settings_path = agent_dir.join("settings.json");
    let auth_path = agent_dir.join("auth.json");
    let models_path = agent_dir.join("models.json");
    let (mut settings, settings_original) = read_json_object_state(&settings_path)
        .await
        .map_err(|error| error.message)?;
    let settings_object = settings.as_object_mut().expect("object");
    settings_object.insert(
        "defaultProvider".to_string(),
        Value::String(provider.to_string()),
    );
    settings_object.insert("defaultModel".to_string(), Value::String(model.to_string()));
    match thinking_level {
        Some(level) => {
            settings_object.insert(
                "defaultThinkingLevel".to_string(),
                Value::String(level.to_string()),
            );
        }
        None => {
            settings_object.remove("defaultThinkingLevel");
        }
    }

    let (mut auth, auth_original) = read_json_object_state(&auth_path)
        .await
        .map_err(|error| error.message)?;
    if let Some(api_key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        auth.as_object_mut().expect("object").insert(
            provider.to_string(),
            serde_json::json!({ "type": "api_key", "key": api_key }),
        );
    }

    let (mut models, models_original) = read_json_object_state(&models_path)
        .await
        .map_err(|error| error.message)?;
    if let (Some(base_url), Some(api)) = (custom_base_url, custom_api) {
        let providers = object_entry(models.as_object_mut().expect("object"), "providers")?;
        let entry = providers
            .entry(provider.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let entry = entry
            .as_object_mut()
            .ok_or_else(|| format!("Pi Provider `{provider}` 配置必须是对象"))?;
        entry.insert("baseUrl".to_string(), Value::String(base_url.to_string()));
        entry.insert("api".to_string(), Value::String(api.to_string()));
        let models = entry
            .entry("models".to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("Pi Provider `{provider}` 的 models 必须是数组"))?;
        if !models
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(model))
        {
            models.push(serde_json::json!({ "id": model, "name": model }));
        }
    }

    let mut mutations = vec![
        json_document_mutation(&settings_path, settings_original, &settings, false)
            .map_err(|error| error.message)?,
        json_document_mutation(&models_path, models_original, &models, false)
            .map_err(|error| error.message)?,
    ];
    if request
        .api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty())
    {
        mutations.push(
            json_document_mutation(&auth_path, auth_original, &auth, true)
                .map_err(|error| error.message)?,
        );
    }
    apply_native_file_mutations(&mutations)
        .await
        .map_err(|error| error.message)?;
    load(pool, home).await
}

pub(super) async fn save_runtime(
    pool: &sqlx::SqlitePool,
    request: PiRuntimeSaveRequest,
) -> Result<(), String> {
    if !matches!(request.mode.as_str(), "default" | "custom") {
        return Err("Pi Runtime 模式无效".to_string());
    }
    let mut env = read_pi_env(pool).await?;
    if request.mode == "custom" {
        let command = request.command.trim();
        if command.is_empty() {
            return Err("自定义 Pi Runtime 需要可执行文件".to_string());
        }
        if !validate_command(command).await.found {
            return Err("找不到可执行的 Pi Runtime".to_string());
        }
        env.insert(PI_COMMAND_ENV.to_string(), command.to_string());
        set_or_remove(&mut env, PI_CONFIG_DIR_ENV, &request.config_dir);
        set_or_remove(&mut env, PI_SESSION_DIR_ENV, &request.session_dir);
    } else {
        env.remove(PI_COMMAND_ENV);
        env.remove(PI_CONFIG_DIR_ENV);
        env.remove(PI_SESSION_DIR_ENV);
    }
    if request.trust_workspace {
        env.remove(PI_TRUST_WORKSPACE_ENV);
    } else {
        env.insert(PI_TRUST_WORKSPACE_ENV.to_string(), "0".to_string());
    }
    let env_json = serde_json::to_string(&env)
        .map_err(|error| format!("序列化 Pi Runtime 设置失败：{error}"))?;
    db::models::agent_setting::AgentSetting::ensure_row(pool, "pi")
        .await
        .map_err(|error| format!("保存 Pi Runtime 设置失败：{error}"))?;
    let result = sqlx::query(
        "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = 'pi'",
    )
    .bind(env_json)
    .execute(pool)
    .await
    .map_err(|error| format!("保存 Pi Runtime 设置失败：{error}"))?;
    if result.rows_affected() == 0 {
        return Err("Pi Agent 设置不存在".to_string());
    }
    Ok(())
}

pub(super) async fn validate_command(command: &str) -> PiCommandValidationView {
    let Some(resolved_path) = resolve_command(command) else {
        return PiCommandValidationView {
            found: false,
            resolved_path: None,
            version: None,
        };
    };
    let mut process = agent_process_command(&resolved_path);
    process.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), process.output())
        .await
        .ok()
        .and_then(Result::ok);
    let found = output
        .as_ref()
        .is_some_and(|output| output.status.success());
    let version = output
        .filter(|output| output.status.success())
        .and_then(|output| {
            [&output.stdout, &output.stderr]
                .into_iter()
                .find_map(|bytes| {
                    String::from_utf8_lossy(bytes)
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                        .map(str::to_string)
                })
        });
    PiCommandValidationView {
        found,
        resolved_path: Some(resolved_path.display().to_string()),
        version,
    }
}

pub(super) fn resolve_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let candidate = Path::new(command);
    let resolved = if candidate.is_absolute() || command.contains(['/', '\\']) {
        candidate.to_path_buf()
    } else {
        which::which(command).ok()?
    };
    if !resolved.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(&resolved).ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    std::fs::canonicalize(&resolved).ok().or(Some(resolved))
}

pub(super) async fn read_pi_env(
    pool: &sqlx::SqlitePool,
) -> Result<HashMap<String, String>, String> {
    let raw = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = 'pi'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("读取 Pi Runtime 设置失败：{error}"))?
    .flatten();
    raw.as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| format!("Pi Runtime 设置无效：{error}"))
        .map(Option::unwrap_or_default)
}

pub(super) fn pi_agent_dir(home: &Path, env: &HashMap<String, String>) -> PathBuf {
    env.get(PI_CONFIG_DIR_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|path| expand_home(path, home))
        .unwrap_or_else(|| home.join(".pi/agent"))
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(relative) = path.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(path)
    }
}

fn set_or_remove(env: &mut HashMap<String, String>, key: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        env.remove(key);
    } else {
        env.insert(key.to_string(), value.to_string());
    }
}

fn validate_http_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|error| format!("Pi API URL 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Pi API URL 必须是无内嵌凭据的 http(s) 地址".to_string());
    }
    Ok(())
}

fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("Pi 配置字段 `{key}` 必须是对象"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool(env: &str) -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(
            r#"CREATE TABLE agent_setting (
                agent_type TEXT PRIMARY KEY,
                env_json TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"#,
        )
        .execute(&pool)
        .await
        .expect("schema");
        sqlx::query("INSERT INTO agent_setting (agent_type, env_json) VALUES ('pi', ?)")
            .bind(env)
            .execute(&pool)
            .await
            .expect("pi setting");
        pool
    }

    #[tokio::test]
    async fn credentials_save_preserves_unknown_pi_configuration() {
        let home = tempfile::tempdir().expect("home");
        let agent_dir = home.path().join("custom-pi");
        tokio::fs::create_dir_all(&agent_dir)
            .await
            .expect("agent dir");
        tokio::fs::write(
            agent_dir.join("settings.json"),
            br#"{"theme":"dark","defaultProvider":"old","defaultModel":"old-model"}"#,
        )
        .await
        .expect("settings");
        tokio::fs::write(
            agent_dir.join("auth.json"),
            br#"{"other":{"type":"api_key","key":"keep"}}"#,
        )
        .await
        .expect("auth");
        tokio::fs::write(
            agent_dir.join("models.json"),
            br#"{"unrelated":true,"providers":{"other":{"baseUrl":"https://keep.test","api":"openai-responses","models":[{"id":"keep"}]}}}"#,
        )
        .await
        .expect("models");
        let pool = test_pool(
            &serde_json::json!({ (PI_CONFIG_DIR_ENV): agent_dir.display().to_string() })
                .to_string(),
        )
        .await;

        let view = save_credentials(
            &pool,
            home.path(),
            PiCredentialsSaveRequest {
                provider: "private".to_string(),
                model: "model-1".to_string(),
                thinking_level: Some("high".to_string()),
                api_key: Some("secret".to_string()),
                custom_base_url: Some("https://api.example.test/v1".to_string()),
                custom_api: Some("openai-responses".to_string()),
            },
        )
        .await
        .expect("save credentials");

        assert_eq!(view.default_provider, "private");
        assert_eq!(view.default_model, "model-1");
        assert_eq!(view.thinking_level, "high");
        assert!(view.credential_present);
        assert_eq!(view.auth_providers, vec!["other", "private"]);
        let settings: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("settings.json"))
                .await
                .expect("read settings"),
        )
        .expect("settings json");
        let auth: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("auth.json"))
                .await
                .expect("read auth"),
        )
        .expect("auth json");
        let models: Value = serde_json::from_slice(
            &tokio::fs::read(agent_dir.join("models.json"))
                .await
                .expect("read models"),
        )
        .expect("models json");
        assert_eq!(settings["theme"], "dark");
        assert_eq!(auth["other"]["key"], "keep");
        assert_eq!(auth["private"]["key"], "secret");
        assert_eq!(models["unrelated"], true);
        assert_eq!(models["providers"]["other"]["models"][0]["id"], "keep");
        assert_eq!(
            models["providers"]["private"]["baseUrl"],
            "https://api.example.test/v1"
        );
        assert_eq!(models["providers"]["private"]["models"][0]["id"], "model-1");
    }

    #[tokio::test]
    async fn runtime_save_preserves_unrelated_environment() {
        let pool = test_pool(r#"{"UNRELATED":"keep","PI_ACP_PI_COMMAND":"old"}"#).await;

        save_runtime(
            &pool,
            PiRuntimeSaveRequest {
                mode: "default".to_string(),
                command: String::new(),
                config_dir: String::new(),
                session_dir: String::new(),
                trust_workspace: false,
            },
        )
        .await
        .expect("save runtime");

        let raw = sqlx::query_scalar::<_, String>(
            "SELECT env_json FROM agent_setting WHERE agent_type = 'pi'",
        )
        .fetch_one(&pool)
        .await
        .expect("read env");
        let env: HashMap<String, String> = serde_json::from_str(&raw).expect("valid env");
        assert_eq!(env.get("UNRELATED").map(String::as_str), Some("keep"));
        assert!(!env.contains_key(PI_COMMAND_ENV));
        assert_eq!(
            env.get(PI_TRUST_WORKSPACE_ENV).map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn home_expansion_uses_the_app_supplied_home() {
        let home = Path::new("/application/home");

        assert_eq!(expand_home("~/.pi/custom", home), home.join(".pi/custom"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn validation_rejects_an_executable_whose_version_probe_fails() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let command = temp.path().join("broken-pi");
        std::fs::write(&command, "#!/bin/sh\necho broken >&2\nexit 1\n").expect("script");
        let mut permissions = std::fs::metadata(&command).expect("metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&command, permissions).expect("permissions");

        let validation = validate_command(command.to_str().expect("utf-8 path")).await;

        assert!(!validation.found);
        assert!(validation.resolved_path.is_some());
        assert_eq!(validation.version, None);
    }
}
