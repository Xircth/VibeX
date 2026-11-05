use std::path::Path;

use serde_yaml::{Mapping, Value};

use crate::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpProviderDraft {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpNativeState {
    pub drafts: Vec<OmpProviderDraft>,
    pub active_provider: Option<String>,
}

pub async fn read_state(agent_dir: &Path) -> Result<OmpNativeState, String> {
    let models = read_yaml(&agent_dir.join("models.yml")).await?;
    let config = read_yaml(&agent_dir.join("config.yml")).await?;
    let active_provider = config
        .get("modelRoles")
        .and_then(Value::as_mapping)
        .and_then(|roles| roles.get(Value::String("default".to_string())))
        .and_then(Value::as_str)
        .and_then(|role| role.split('/').next())
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let Some(providers) = models.get("providers").and_then(Value::as_mapping) else {
        return Ok(OmpNativeState {
            drafts: Vec::new(),
            active_provider,
        });
    };
    let drafts = providers
        .iter()
        .filter_map(|(key, provider)| {
            let id = key.as_str()?.to_string();
            let object = provider.as_mapping()?;
            let api_url = text(object, "baseUrl");
            if api_url.is_empty() {
                return None;
            }
            let model = first_model_id(object);
            Some(OmpProviderDraft {
                name: id.clone(),
                id,
                api_url,
                api_key: text(object, "apiKey"),
                model,
            })
        })
        .collect();
    Ok(OmpNativeState {
        drafts,
        active_provider,
    })
}

pub async fn apply(
    agent_dir: &Path,
    provider_id: &str,
    name: &str,
    api_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(), String> {
    let models_path = agent_dir.join("models.yml");
    let config_path = agent_dir.join("config.yml");
    let filesystem = TokioNativeFileSystem;
    let models_original = filesystem
        .read(&models_path)
        .await
        .map_err(|error| error.to_string())?;
    let config_original = filesystem
        .read(&config_path)
        .await
        .map_err(|error| error.to_string())?;
    let mut models = mapping_from(models_original.as_deref(), &models_path)?;
    let mut config = mapping_from(config_original.as_deref(), &config_path)?;
    let providers = mapping_entry(&mut models, "providers");
    let key = provider_key(providers, provider_id, name, api_url);
    let model_id = model_id(model);
    let api = wire_api(model);
    let node = mapping_entry(providers, &key);
    insert_string(node, "baseUrl", api_url);
    insert_string(node, "api", api);
    insert_string(node, "auth", "apiKey");
    let secret = api_key.trim();
    if !secret.is_empty() {
        insert_string(node, "apiKey", secret);
    }
    node.insert(
        Value::String("models".to_string()),
        model_list(model, &model_id),
    );
    let roles = mapping_entry(&mut config, "modelRoles");
    insert_string(roles, "default", &format!("{key}/{model_id}"));
    filesystem
        .apply_many_atomic(&[
            yaml_mutation(&models_path, models_original, &models, true)?,
            yaml_mutation(&config_path, config_original, &config, false)?,
        ])
        .await
        .map_err(|error| error.to_string())
}

pub async fn clear_active_role(agent_dir: &Path) -> Result<(), String> {
    let config_path = agent_dir.join("config.yml");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem
        .read(&config_path)
        .await
        .map_err(|error| error.to_string())?;
    let mut config = mapping_from(original.as_deref(), &config_path)?;
    let Some(roles) = config
        .get_mut(Value::String("modelRoles".to_string()))
        .and_then(Value::as_mapping_mut)
    else {
        return Ok(());
    };
    if roles.remove(Value::String("default".to_string())).is_none() {
        return Ok(());
    }
    filesystem
        .apply_many_atomic(&[yaml_mutation(&config_path, original, &config, false)?])
        .await
        .map_err(|error| error.to_string())
}
pub async fn remove(agent_dir: &Path, provider_id: &str, name: &str) -> Result<(), String> {
    let models_path = agent_dir.join("models.yml");
    let config_path = agent_dir.join("config.yml");
    let filesystem = TokioNativeFileSystem;
    let models_original = filesystem
        .read(&models_path)
        .await
        .map_err(|error| error.to_string())?;
    let config_original = filesystem
        .read(&config_path)
        .await
        .map_err(|error| error.to_string())?;
    let mut models = mapping_from(models_original.as_deref(), &models_path)?;
    let mut config = mapping_from(config_original.as_deref(), &config_path)?;
    let keys = [provider_id.to_string(), slug(name)];
    let mut changed = false;
    if let Some(providers) = models
        .get_mut(Value::String("providers".to_string()))
        .and_then(Value::as_mapping_mut)
    {
        for key in &keys {
            if providers.remove(Value::String(key.clone())).is_some() {
                changed = true;
            }
        }
    }
    if let Some(roles) = config
        .get_mut(Value::String("modelRoles".to_string()))
        .and_then(Value::as_mapping_mut)
        && let Some(Value::String(role)) = roles.get(Value::String("default".to_string()))
        && keys.iter().any(|key| role.starts_with(&format!("{key}/")))
    {
        roles.remove(Value::String("default".to_string()));
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    filesystem
        .apply_many_atomic(&[
            yaml_mutation(&models_path, models_original, &models, true)?,
            yaml_mutation(&config_path, config_original, &config, false)?,
        ])
        .await
        .map_err(|error| error.to_string())
}

fn provider_key(providers: &Mapping, provider_id: &str, name: &str, api_url: &str) -> String {
    if providers.contains_key(Value::String(provider_id.to_string())) {
        return provider_id.to_string();
    }
    if let Some(existing) = providers.iter().find_map(|(key, provider)| {
        let same_url = provider
            .as_mapping()
            .is_some_and(|node| text(node, "baseUrl") == api_url);
        same_url.then(|| key.as_str().unwrap_or("").to_string())
    }) {
        if !existing.is_empty() {
            return existing;
        }
    }
    let slug = slug(name);
    if slug.is_empty() {
        "provider".to_string()
    } else {
        slug
    }
}

fn slug(name: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn model_id(raw: &str) -> String {
    model_ids(raw)
        .into_iter()
        .next()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "model".to_string())
}

fn model_ids(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return vec![raw.trim().to_string()];
    };
    let mut ids = Vec::new();
    if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
        ids.push(id.to_string());
    }
    if let Some(models) = value.get("models").and_then(serde_json::Value::as_array) {
        for model in models {
            if let Some(id) = model
                .as_str()
                .or_else(|| model.get("id").and_then(serde_json::Value::as_str))
            {
                ids.push(id.to_string());
            }
        }
    }
    if ids.is_empty() {
        if let Some(id) = value.as_str() {
            ids.push(id.to_string());
        }
    }
    ids
}

fn model_list(raw: &str, fallback: &str) -> Value {
    let mut sequence = serde_yaml::Sequence::new();

    for id in model_ids(raw) {
        if id.trim().is_empty()
            || sequence
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            continue;
        }
        let mut model = Mapping::new();
        model.insert(Value::String("id".to_string()), Value::String(id.clone()));
        model.insert(Value::String("name".to_string()), Value::String(id));
        sequence.push(Value::Mapping(model));
    }
    if sequence.is_empty() {
        let mut model = Mapping::new();
        model.insert(
            Value::String("id".to_string()),
            Value::String(fallback.to_string()),
        );
        model.insert(
            Value::String("name".to_string()),
            Value::String(fallback.to_string()),
        );
        sequence.push(Value::Mapping(model));
    }

    Value::Sequence(sequence)
}

fn wire_api(raw: &str) -> &'static str {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return "openai-completions";
    };
    match value.get("api").and_then(serde_json::Value::as_str) {
        Some("anthropic-messages") => "anthropic-messages",
        Some("google-generative-ai") => "google-generative-ai",
        Some("openai-responses") => "openai-responses",
        Some("openai-completions") => "openai-completions",
        _ => "openai-completions",
    }
}

fn first_model_id(provider: &Mapping) -> String {
    provider
        .get(Value::String("models".to_string()))
        .and_then(Value::as_sequence)
        .and_then(|models| models.first())
        .and_then(|model| model.get("id").or_else(|| model.as_str().map(|_| model)))
        .and_then(Value::as_str)
        .unwrap_or("model")
        .to_string()
}

fn text(mapping: &Mapping, key: &str) -> String {
    mapping
        .get(Value::String(key.to_string()))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn insert_string(mapping: &mut Mapping, key: &str, value: &str) {
    mapping.insert(
        Value::String(key.to_string()),
        Value::String(value.to_string()),
    );
}

fn mapping_entry<'a>(parent: &'a mut Mapping, key: &str) -> &'a mut Mapping {
    let yaml_key = Value::String(key.to_string());
    if !parent.get(&yaml_key).is_some_and(Value::is_mapping) {
        parent.insert(yaml_key.clone(), Value::Mapping(Mapping::new()));
    }
    parent
        .get_mut(&yaml_key)
        .and_then(Value::as_mapping_mut)
        .expect("mapping just inserted")
}

fn mapping_from(bytes: Option<&[u8]>, path: &Path) -> Result<Mapping, String> {
    match bytes {
        Some(bytes) if !bytes.is_empty() => {
            let value: Value = serde_yaml::from_slice(bytes)
                .map_err(|error| format!("{} 无效：{error}", path.display()))?;
            value
                .as_mapping()
                .cloned()
                .ok_or_else(|| format!("{} 顶层必须是对象", path.display()))
        }
        _ => Ok(Mapping::new()),
    }
}

async fn read_yaml(path: &Path) -> Result<Value, String> {
    match tokio::fs::read_to_string(path).await {
        Ok(text) if !text.trim().is_empty() => {
            serde_yaml::from_str(&text).map_err(|error| format!("{} 无效：{error}", path.display()))
        }
        Ok(_) => Ok(Value::Mapping(Mapping::new())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Value::Mapping(Mapping::new()))
        }
        Err(error) => Err(format!("读取 {} 失败：{error}", path.display())),
    }
}

fn yaml_mutation(
    path: &Path,
    expected: Option<Vec<u8>>,
    value: &Mapping,
    sensitive: bool,
) -> Result<NativeFileMutation, String> {
    Ok(NativeFileMutation {
        path: path.to_path_buf(),
        expected,
        replacement: Some(
            serde_yaml::to_string(&Value::Mapping(value.clone()))
                .map_err(|error| format!("序列化 {} 失败：{error}", path.display()))?
                .into_bytes(),
        ),
        sensitive,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn apply_writes_provider_and_keeps_sibling_config() {
        let temp = tempfile::tempdir().unwrap();
        let agent_dir = temp.path();
        tokio::fs::write(
            agent_dir.join("models.yml"),
            "providers:\n  kept:\n    baseUrl: http://kept.example\n    apiKey: sk-kept\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("config.yml"),
            "theme:\n  dark: dark\nmodelRoles:\n  plan: kept/old\n",
        )
        .await
        .unwrap();

        apply(
            agent_dir,
            "provider-1",
            "Local Gate",
            "http://localhost:11434/v1",
            "sk-local",
            r#"{"id":"glm-5","api":"openai-completions","models":["glm-5","glm-4"]}"#,
        )
        .await
        .unwrap();

        let state = read_state(agent_dir).await.unwrap();
        assert_eq!(state.active_provider.as_deref(), Some("local-gate"));
        assert_eq!(state.drafts.len(), 2);
        let local = state
            .drafts
            .iter()
            .find(|draft| draft.id == "local-gate")
            .unwrap();
        assert_eq!(local.api_url, "http://localhost:11434/v1");
        assert_eq!(local.api_key, "sk-local");
        assert_eq!(local.model, "glm-5");
        let config = tokio::fs::read_to_string(agent_dir.join("config.yml"))
            .await
            .unwrap();
        assert!(config.contains("plan:"));
        assert!(config.contains("dark:"));
    }

    #[tokio::test]
    async fn remove_drops_only_the_named_provider() {
        let temp = tempfile::tempdir().unwrap();
        let agent_dir = temp.path();
        apply(
            agent_dir,
            "provider-1",
            "Local Gate",
            "http://localhost:11434/v1",
            "sk-local",
            "glm-5",
        )
        .await
        .unwrap();
        apply(
            agent_dir,
            "provider-2",
            "Other",
            "http://other.example/v1",
            "sk-other",
            "other",
        )
        .await
        .unwrap();

        remove(agent_dir, "provider-2", "Other").await.unwrap();

        let state = read_state(agent_dir).await.unwrap();
        assert_eq!(state.drafts.len(), 1);
        assert_eq!(state.drafts[0].id, "local-gate");
        assert_eq!(state.active_provider, None);
    }

    #[tokio::test]
    async fn clear_active_role_keeps_other_roles_and_providers() {
        let temp = tempfile::tempdir().unwrap();
        let agent_dir = temp.path();
        apply(
            agent_dir,
            "provider-1",
            "Local Gate",
            "http://localhost:11434/v1",
            "sk-local",
            "glm-5",
        )
        .await
        .unwrap();
        tokio::fs::write(
            agent_dir.join("config.yml"),
            "theme:\n  dark: dark\nmodelRoles:\n  default: local-gate/glm-5\n  plan: kept/old\n",
        )
        .await
        .unwrap();

        clear_active_role(agent_dir).await.unwrap();

        let state = read_state(agent_dir).await.unwrap();
        assert_eq!(state.active_provider, None);
        assert_eq!(state.drafts.len(), 1);
        let config = tokio::fs::read_to_string(agent_dir.join("config.yml"))
            .await
            .unwrap();
        assert!(config.contains("plan:"));
        assert!(!config.contains("local-gate/glm-5"));
    }
}
