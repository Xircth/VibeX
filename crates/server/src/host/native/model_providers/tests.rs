use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::*;

fn codex_catalog_cache(store_path: &Path) -> std::path::PathBuf {
    store_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("agent-catalogs")
        .join("codex-bundled.json")
}

#[test]
fn provider_model_ids_reads_default_and_selected_models() {
    assert_eq!(
        provider_model_ids(r#"{"id":"primary","models":["primary","extra"]}"#),
        vec!["primary".to_string(), "extra".to_string()]
    );
    assert_eq!(
        provider_model_ids(r#"{"default":"main","models":[{"id":"alt"}]}"#),
        vec!["main".to_string(), "alt".to_string()]
    );
    assert_eq!(
        provider_model_ids("plain-model"),
        vec!["plain-model".to_string()]
    );
}

#[test]
fn merge_provider_stores_keeps_host_ids_and_restores_missing_legacy_presets() {
    let mut dest = ProviderStore {
        providers: vec![StoredProvider {
            id: "keep".to_string(),
            name: "Host".to_string(),
            agent_id: AgentId::parse("codex").unwrap(),
            api_url: "https://host.example/v1".to_string(),
            api_key: "host-secret".to_string(),
            model: "host-model".to_string(),
        }],
        bindings: BTreeMap::from([("codex".to_string(), "keep".to_string())]),
        ..ProviderStore::default()
    };
    merge_provider_stores(
        &mut dest,
        ProviderStore {
            providers: vec![
                StoredProvider {
                    id: "keep".to_string(),
                    name: "Legacy duplicate".to_string(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    api_url: "https://legacy.example/v1".to_string(),
                    api_key: "legacy-secret".to_string(),
                    model: "legacy-model".to_string(),
                },
                StoredProvider {
                    id: "restored".to_string(),
                    name: "Saved".to_string(),
                    agent_id: AgentId::parse("claude_code").unwrap(),
                    api_url: "https://saved.example/v1".to_string(),
                    api_key: "saved-secret".to_string(),
                    model: "saved-model".to_string(),
                },
            ],
            bindings: BTreeMap::from([
                ("codex".to_string(), "should-not-win".to_string()),
                ("claude_code".to_string(), "restored".to_string()),
            ]),
            ..ProviderStore::default()
        },
    );
    assert_eq!(dest.providers.len(), 2);
    assert_eq!(dest.providers[0].name, "Host");
    assert_eq!(dest.providers[1].id, "restored");
    assert_eq!(dest.bindings.get("codex").map(String::as_str), Some("keep"));
    assert_eq!(
        dest.bindings.get("claude_code").map(String::as_str),
        Some("restored")
    );
}

#[tokio::test]
async fn probe_key_prefers_the_draft_and_can_reuse_the_edited_provider_secret() {
    let temp = tempfile::tempdir().unwrap();
    let store_path = temp.path().join("providers.json");
    write_store(
        &store_path,
        &ProviderStore {
            providers: vec![StoredProvider {
                id: "provider-1".to_string(),
                name: "Gateway".to_string(),
                agent_id: AgentId::parse("gemini").unwrap(),
                api_url: "https://saved.example/v1".to_string(),
                api_key: "saved-secret".to_string(),
                model: String::new(),
            }],
            ..ProviderStore::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(
        resolve_probe_api_key_from(
            &store_path,
            &AgentId::parse("gemini").unwrap(),
            Some("provider-1"),
            Some("draft-secret"),
            None,
            None
        )
        .await
        .unwrap(),
        "draft-secret"
    );
    assert_eq!(
        resolve_probe_api_key_from(
            &store_path,
            &AgentId::parse("gemini").unwrap(),
            Some("provider-1"),
            None,
            None,
            None
        )
        .await
        .unwrap(),
        "saved-secret"
    );
}

#[tokio::test]
async fn probe_key_falls_back_to_native_codex_auth_when_store_secret_is_empty() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
    )
    .await
    .unwrap();
    write_store(
        &store_path,
        &ProviderStore {
            providers: vec![StoredProvider {
                id: "custom".to_string(),
                name: "Custom".to_string(),
                agent_id: AgentId::parse("codex").unwrap(),
                api_url: "https://api.custom.example/v1".to_string(),
                api_key: String::new(),
                model: String::new(),
            }],
            ..ProviderStore::default()
        },
    )
    .await
    .unwrap();

    let key = resolve_probe_api_key_from(
        &store_path,
        &AgentId::parse("codex").unwrap(),
        Some("custom"),
        None,
        Some(&home),
        Some(&HashMap::new()),
    )
    .await
    .unwrap();
    assert_eq!(key, "sk-native");

    let listed = list_with_native(
        &store_path,
        AgentId::parse("codex").unwrap(),
        Some(&codex_home),
    )
    .await
    .unwrap();
    assert_eq!(listed.providers[0].api_key, "sk-native");
    assert!(listed.providers[0].credential_present);
}

#[tokio::test]
async fn lists_native_codex_provider_from_external_catalog_without_official_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("external.json"),
        r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model_provider = \"custom\"\nmodel_catalog_json = \"external.json\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();

    let listed = list_with_native(
        &store_path,
        AgentId::parse("codex").unwrap(),
        Some(&codex_home),
    )
    .await
    .unwrap();

    let custom = listed
        .providers
        .iter()
        .find(|provider| provider.id == "custom")
        .expect("native provider");
    assert_eq!(custom.api_url, "https://api.custom.example/v1");
    assert_eq!(custom.model, "gateway/model");
    assert_eq!(custom.api_key, "sk-native");
    assert!(custom.bound);
    assert_eq!(listed.bound_provider_id.as_deref(), Some("custom"));
}

async fn write_external_codex_provider(codex_home: &Path) {
    tokio::fs::create_dir_all(codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("external.json"),
        r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"gateway/model\"\nmodel_provider = \"custom\"\nmodel_catalog_json = \"external.json\"\nkeep = true\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native","keep":true}"#,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn standard_codex_preset_bind_replaces_provider_fields_without_touching_external_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/providers.json");
    write_external_codex_provider(&codex_home).await;
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("new-secret".to_string()),
            model: "preset-model".to_string(),
        },
    )
    .await
    .unwrap();
    let preset_id = created
        .providers
        .iter()
        .find(|provider| provider.name == "Gateway")
        .unwrap()
        .id
        .clone();

    bind(&store_path, &home, &environment, agent_id, Some(preset_id))
        .await
        .unwrap();

    let config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(
        config.get("model_provider").and_then(toml::Value::as_str),
        Some("vibex")
    );
    assert_eq!(
        config.get("model").and_then(toml::Value::as_str),
        Some("preset-model")
    );
    assert_eq!(
        config
            .get("model_catalog_json")
            .and_then(toml::Value::as_str),
        Some("external.json")
    );
    assert_eq!(
        config.get("keep").and_then(toml::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("vibex"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://gateway.example/v1")
    );
    assert_eq!(
        config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("custom"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://api.custom.example/v1")
    );
    assert_eq!(
        tokio::fs::read_to_string(codex_home.join("external.json"))
            .await
            .unwrap(),
        r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#
    );
    assert!(!codex_home.join(CODEX_SOURCE_FILE).exists());
    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
            .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "new-secret");
    assert_eq!(auth["keep"], true);
}

#[tokio::test]
async fn enabling_native_codex_provider_restores_official_config_and_external_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/providers.json");
    write_external_codex_provider(&codex_home).await;
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let listed = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    let native_id = listed
        .providers
        .iter()
        .find(|provider| provider.id == "custom")
        .unwrap()
        .id
        .clone();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("new-secret".to_string()),
            model: "preset-model".to_string(),
        },
    )
    .await
    .unwrap();
    let preset_id = created
        .providers
        .iter()
        .find(|provider| provider.name == "Gateway")
        .unwrap()
        .id
        .clone();
    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(preset_id),
    )
    .await
    .unwrap();

    let rebound = bind(&store_path, &home, &environment, agent_id, Some(native_id))
        .await
        .unwrap();

    let config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(
        config.get("model_provider").and_then(toml::Value::as_str),
        Some("custom")
    );
    assert_eq!(
        config
            .get("model_catalog_json")
            .and_then(toml::Value::as_str),
        Some("external.json")
    );
    assert_eq!(
        config.get("model").and_then(toml::Value::as_str),
        Some("gateway/model")
    );
    assert!(
        config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .is_none_or(|providers| !providers.contains_key("vibex"))
    );
    assert_eq!(
        tokio::fs::read_to_string(codex_home.join("external.json"))
            .await
            .unwrap(),
        r#"{"models":[{"slug":"gateway/model","display_name":"Gateway Model","visibility":"list"}]}"#
    );
    assert!(!codex_home.join(CODEX_SOURCE_FILE).exists());
    let custom = rebound
        .providers
        .iter()
        .find(|provider| provider.id == "custom")
        .unwrap();
    assert!(custom.bound);
    assert_eq!(rebound.bound_provider_id.as_deref(), Some("custom"));
    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
            .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "sk-native");
}

#[test]
fn gemini_cli_home_is_a_parent_directory_for_provider_projection() {
    let home = Path::new("/users/example");
    let homes = ProviderNativeHomes::resolve(
        home,
        &HashMap::from([(
            "GEMINI_CLI_HOME".to_string(),
            "/profiles/google".to_string(),
        )]),
    );

    assert_eq!(homes.gemini, PathBuf::from("/profiles/google/.gemini"));
}

#[tokio::test]
async fn bound_claude_provider_projects_structured_model_and_preserves_unknown_settings() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join(".claude/settings.json");
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(
        &path,
        br#"{"unknown":true,"env":{"KEEP":"yes","ANTHROPIC_API_KEY":"old","OPENAI_BASE_URL":"https://old.example"}}"#,
    )
        .await
        .unwrap();
    apply_provider(
        &ProviderNativeHomes::resolve(temp.path(), &HashMap::new()),
        &StoredProvider {
            id: "provider-1".to_string(),
            name: "Gateway".to_string(),
            agent_id: AgentId::parse("claude_code").unwrap(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: "secret".to_string(),
            model: r#"{"main":"gateway/sonnet","reasoning":"gateway/opus"}"#.to_string(),
        },
    )
    .await
    .unwrap();
    let document: Value = serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
    assert_eq!(document["unknown"], true);
    assert_eq!(document["env"]["KEEP"], "yes");
    assert_eq!(document["env"]["ANTHROPIC_MODEL"], "gateway/sonnet");
    assert_eq!(document["env"]["ANTHROPIC_REASONING_MODEL"], "gateway/opus");
    assert_eq!(document["env"]["ANTHROPIC_AUTH_TOKEN"], "secret");
    assert!(document["env"].get("ANTHROPIC_API_KEY").is_none());
    assert!(document["env"].get("OPENAI_BASE_URL").is_none());
}

#[tokio::test]
async fn gemini_provider_binding_scrubs_conflicting_auth_and_restores_it_on_unbind() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let settings_path = home.join(".gemini/settings.json");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(
        &settings_path,
        br#"{"env":{"GOOGLE_API_KEY":"vertex-old","GOOGLE_CLOUD_PROJECT":"project-old","KEEP":"yes"}}"#,
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("gemini").unwrap();
    let created = save(
        &store_path,
        &home,
        &HashMap::new(),
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gemini.example/v1".to_string(),
            api_key: Some("provider-secret".to_string()),
            model: "gemini-provider-model".to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &HashMap::new(),
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    let bound: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(bound["env"]["GEMINI_API_KEY"], "provider-secret");
    assert_eq!(bound["env"]["KEEP"], "yes");
    assert!(bound["env"].get("GOOGLE_API_KEY").is_none());
    assert!(bound["env"].get("GOOGLE_CLOUD_PROJECT").is_none());

    bind(&store_path, &home, &HashMap::new(), agent_id, None)
        .await
        .unwrap();
    let restored: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(restored["env"]["GOOGLE_API_KEY"], "vertex-old");
    assert_eq!(restored["env"]["GOOGLE_CLOUD_PROJECT"], "project-old");
    assert_eq!(restored["env"]["KEEP"], "yes");
}

#[tokio::test]
async fn antigravity_provider_binding_writes_acp_settings_auth_type() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let settings_path = home.join(".gemini/antigravity-acp/settings.json");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(
        &settings_path,
        br#"{"keep":true,"auth":{"type":"oauth-personal"},"env":{"GOOGLE_API_KEY":"old"}}"#,
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("antigravity").unwrap();
    let created = save(
        &store_path,
        &home,
        &HashMap::new(),
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gemini.example/v1".to_string(),
            api_key: Some("provider-secret".to_string()),
            model: "gemini-3".to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &HashMap::new(),
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    let bound: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(bound["keep"], true);
    assert_eq!(bound["auth"]["type"], "gemini-api-key");
    assert_eq!(bound["env"]["GEMINI_API_KEY"], "provider-secret");
    assert_eq!(
        bound["env"]["GOOGLE_GEMINI_BASE_URL"],
        "https://gemini.example/v1"
    );
    assert_eq!(bound["env"]["GEMINI_MODEL"], "gemini-3");
    assert!(bound["env"].get("GOOGLE_API_KEY").is_none());

    bind(&store_path, &home, &HashMap::new(), agent_id, None)
        .await
        .unwrap();
    let restored: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(restored["auth"]["type"], "oauth-personal");
    assert_eq!(restored["env"]["GOOGLE_API_KEY"], "old");
    assert_eq!(restored["keep"], true);
}

#[tokio::test]
async fn unbinding_provider_restores_the_native_values_from_before_first_binding() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let settings_path = home.join(".claude/settings.json");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(settings_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(
        &settings_path,
        br#"{"unknown":true,"env":{"ANTHROPIC_BASE_URL":"https://original.example","ANTHROPIC_AUTH_TOKEN":"original-secret","ANTHROPIC_MODEL":"original-model"}}"#,
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("claude_code").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("new-secret".to_string()),
            model: "gateway-model".to_string(),
        },
    )
    .await
    .unwrap();
    let provider_id = created.providers[0].id.clone();

    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(provider_id),
    )
    .await
    .unwrap();
    let bound: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(bound["env"]["ANTHROPIC_AUTH_TOKEN"], "new-secret");
    assert_eq!(bound["env"]["ANTHROPIC_MODEL"], "gateway-model");

    bind(&store_path, &home, &environment, agent_id, None)
        .await
        .unwrap();
    let restored: Value =
        serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
    assert_eq!(restored["unknown"], true);
    assert_eq!(
        restored["env"]["ANTHROPIC_BASE_URL"],
        "https://original.example"
    );
    assert_eq!(restored["env"]["ANTHROPIC_AUTH_TOKEN"], "original-secret");
    assert_eq!(restored["env"]["ANTHROPIC_MODEL"], "original-model");
}

#[tokio::test]
async fn structured_codex_preset_model_binds_without_official_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"original-secret","keep":true}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"original-model\"\nkeep = true\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Catalog-shaped Provider".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("new-secret".to_string()),
            model: r#"{"customs":[{"slug":"gateway-a","base":"official-a"}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
        },
    )
    .await
    .unwrap();

    bind(
        &store_path,
        &home,
        &environment,
        agent_id,
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();

    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(codex_home.join("auth.json")).await.unwrap())
            .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "new-secret");
    assert_eq!(auth["keep"], true);
    let config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(
        config.get("model").and_then(toml::Value::as_str),
        Some("gateway-a")
    );
    assert_eq!(
        config
            .get("model_catalog_json")
            .and_then(toml::Value::as_str),
        Some(CODEX_CATALOG_FILE)
    );
    assert_eq!(
        config.get("keep").and_then(toml::Value::as_bool),
        Some(true)
    );
    let catalog: Value = serde_json::from_slice(
        &tokio::fs::read(codex_home.join(CODEX_CATALOG_FILE))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(catalog["models"][0]["slug"], "gateway-a");
    assert!(codex_home.join(CODEX_SOURCE_FILE).exists());
    let store = read_store(&store_path).await.unwrap();
    assert!(!store.bindings.is_empty());
    assert!(!store.projection_backups.is_empty());
}

#[tokio::test]
async fn codex_provider_projects_official_provider_table_and_restores_catalog_on_unbind() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    let cache_path = codex_catalog_cache(&store_path);
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::create_dir_all(cache_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"original-secret","keep":true}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"official-a\"\nmodel_provider = \"original\"\nmodel_catalog_json = \"vibex-model-catalog.json\"\n[model_providers.original]\nbase_url = \"https://original.example\"\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join(CODEX_CATALOG_FILE),
        r#"{"models":[{"slug":"old-custom"}]}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(codex_home.join(CODEX_SOURCE_FILE), r#"{"customs":[]}"#)
        .await
        .unwrap();
    tokio::fs::write(
        &cache_path,
        r#"{"models":[{"slug":"official-a","display_name":"Official A","visibility":"list","priority":0,"context_window":1000}]}"#,
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Codex Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("new-secret".to_string()),
            model: r#"{"customs":[{"slug":"gateway-a","display_name":"Gateway A","base":"official-a","overrides":{"default_verbosity":"high"}}],"excluded_officials":[],"default_model":"gateway-a"}"#.to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();

    let bound_config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(
        bound_config.get("model").and_then(toml::Value::as_str),
        Some("gateway-a")
    );
    assert_eq!(
        bound_config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("vibex"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://gateway.example/v1")
    );
    assert_eq!(
        bound_config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("original"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://original.example")
    );
    assert_eq!(
        bound_config
            .get("model_catalog_json")
            .and_then(toml::Value::as_str),
        Some("vibex-model-catalog.json")
    );
    let bound_catalog: Value = serde_json::from_slice(
        &tokio::fs::read(codex_home.join(CODEX_CATALOG_FILE))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(bound_catalog["models"][0]["slug"], "gateway-a");

    let mut externally_changed = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    externally_changed
        .get_mut("model_providers")
        .and_then(toml::Value::as_table_mut)
        .unwrap()
        .insert(
            "third_party".to_string(),
            toml::Value::Table(toml::Table::from_iter([(
                "base_url".to_string(),
                toml::Value::String("https://third-party.example".to_string()),
            )])),
        );
    write_toml_table(&codex_home.join("config.toml"), &externally_changed)
        .await
        .unwrap();

    bind(&store_path, &home, &environment, agent_id, None)
        .await
        .unwrap();
    let restored_config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(
        restored_config.get("model").and_then(toml::Value::as_str),
        Some("official-a")
    );
    assert_eq!(
        restored_config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("original"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://original.example")
    );
    assert_eq!(
        restored_config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("third_party"))
            .and_then(toml::Value::as_table)
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str),
        Some("https://third-party.example")
    );
    assert!(
        restored_config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .is_none_or(|providers| !providers.contains_key("vibex"))
    );
    assert_eq!(
        tokio::fs::read_to_string(codex_home.join(CODEX_CATALOG_FILE))
            .await
            .unwrap(),
        r#"{"models":[{"slug":"old-custom"}]}"#
    );
}

#[tokio::test]
async fn codex_provider_respects_the_saved_custom_home() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let custom_home = home.join("profiles/work-codex");
    let store_path = temp.path().join("data/providers.json");
    let environment = HashMap::from([(
        "CODEX_HOME".to_string(),
        "~/profiles/work-codex".to_string(),
    )]);
    let agent_id = AgentId::parse("codex").unwrap();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Work Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("custom-home-secret".to_string()),
            model: "gpt-work".to_string(),
        },
    )
    .await
    .unwrap();

    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();

    let auth: Value = serde_json::from_slice(
        &tokio::fs::read(custom_home.join("auth.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "custom-home-secret");
    assert!(auth.get("auth_mode").is_none());
    assert!(custom_home.join("config.toml").is_file());
    assert!(!home.join(".codex/auth.json").exists());

    bind(&store_path, &home, &environment, agent_id, None)
        .await
        .unwrap();
    let restored: Value = serde_json::from_slice(
        &tokio::fs::read(custom_home.join("auth.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(restored.get("OPENAI_API_KEY").is_none());
}

#[tokio::test]
async fn native_codex_provider_appears_as_bound_when_vibex_has_no_binding() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join("home/.codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    assert_eq!(view.bound_provider_id.as_deref(), Some("deepseek"));
    assert_eq!(view.providers.len(), 1);
    let native = &view.providers[0];
    assert_eq!(native.id, "deepseek");
    assert_eq!(native.name, "DeepSeek Gateway");
    assert_eq!(native.api_url, "https://api.deepseek.example/v1");
    assert_eq!(native.model, "deepseek-v4-flash");
    assert_eq!(native.api_key, "sk-native");
    assert!(native.bound);
    assert!(native.managed);
    assert!(native.credential_present);
}

#[tokio::test]
async fn native_codex_bearer_token_counts_as_logged_in_without_auth_json() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join("home/.codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(store_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        &store_path,
        serde_json::json!({
            "providers": [{
                "id": "custom",
                "name": "BeeAPI · codex",
                "agent_id": "codex",
                "api_url": "https://beeapi.ai/v1",
                "api_key": "",
                "model": "gpt-6-astra"
            }],
            "bindings": {}
        })
        .to_string(),
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        r#"
model = "gpt-6-astra"
model_provider = "custom"

[model_providers.custom]
base_url = "https://beeapi.ai/v1"
experimental_bearer_token = "sk-bee"
name = "BeeAPI · codex"
requires_openai_auth = false
wire_api = "responses"
"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("codex").unwrap(),
        Some(&codex_home),
    )
    .await
    .unwrap();
    assert_eq!(view.bound_provider_id.as_deref(), Some("custom"));
    let provider = view
        .providers
        .iter()
        .find(|item| item.id == "custom")
        .unwrap();
    assert!(provider.bound);
    assert!(provider.credential_present);
    assert_eq!(provider.api_key, "sk-bee");
}

#[tokio::test]
async fn native_codex_endpoint_without_provider_table_projects_synthetic_entry() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join("home/.codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"gpt-custom\"\nopenai_base_url = \"https://gateway.example/v1\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    let bound = view.bound_provider_id.as_deref().unwrap();
    let entry = view
        .providers
        .iter()
        .find(|provider| provider.id == bound)
        .unwrap();
    assert_eq!(entry.api_url, "https://gateway.example/v1");
    assert_eq!(entry.model, "gpt-custom");
    assert!(entry.bound);
    assert!(entry.managed);
}

#[tokio::test]
async fn vibex_binding_takes_precedence_over_native_codex_provider() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join("home/.codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &temp.path().join("home"),
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "VibeX Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://vibex.example/v1".to_string(),
            api_key: Some("vibex-secret".to_string()),
            model: "vibex-model".to_string(),
        },
    )
    .await
    .unwrap();
    let managed_id = created
        .providers
        .iter()
        .find(|provider| provider.name == "VibeX Gateway")
        .expect("saved VibeX provider")
        .id
        .clone();
    bind(
        &store_path,
        &temp.path().join("home"),
        &environment,
        agent_id.clone(),
        Some(managed_id.clone()),
    )
    .await
    .unwrap();
    let view = list_with_native(&store_path, agent_id, Some(&codex_home))
        .await
        .unwrap();
    assert_eq!(view.bound_provider_id, Some(managed_id.clone()));
    let managed = view
        .providers
        .iter()
        .find(|provider| provider.id == managed_id)
        .unwrap();
    assert!(managed.bound);
    assert!(managed.managed);
    let native = view
        .providers
        .iter()
        .find(|provider| provider.id == "deepseek")
        .expect("native Codex providers remain visible after a VibeX bind");
    assert!(!native.bound);
    assert!(native.managed);
}

#[tokio::test]
async fn native_config_wins_over_a_stale_vibex_store_binding() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "VibeX Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://vibex.example/v1".to_string(),
            api_key: Some("vibex-secret".to_string()),
            model: "vibex-model".to_string(),
        },
    )
    .await
    .unwrap();
    let managed_id = created
        .providers
        .iter()
        .find(|provider| provider.managed)
        .expect("saved VibeX provider")
        .id
        .clone();
    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(managed_id.clone()),
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"DeepSeek\"\n\n[model_providers.DeepSeek]\nname = \"DeepSeek\"\nbase_url = \"https://api.deepseek.example/v1\"\nwire_api = \"responses\"\n",
    )
    .await
    .unwrap();

    let view = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    assert_eq!(view.bound_provider_id.as_deref(), Some("DeepSeek"));
    let native = view
        .providers
        .iter()
        .find(|provider| provider.id == "DeepSeek")
        .expect("native DeepSeek provider");
    assert!(native.bound);
    assert!(native.managed);
    let managed = view
        .providers
        .iter()
        .find(|provider| provider.id == managed_id)
        .expect("VibeX preset remains listed");
    assert!(!managed.bound);
    assert!(managed.managed);

    let store = read_store(&store_path).await.unwrap();
    assert!(!store.bindings.contains_key("codex"));
    assert!(!store.projection_backups.contains_key("codex"));

    let state = read_native_codex_state(&codex_home).await.unwrap();
    assert!(native_codex_provider_ready(&state));
    assert!(state.credential_present);
}

#[tokio::test]
async fn native_deepseek_provider_is_ready_without_a_vibex_slot() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model_provider = \"deepseek\"\n\n[model_providers.deepseek]\nname = \"DeepSeek Gateway\"\nbase_url = \"https://api.deepseek.example/v1\"\n",
    )
    .await
    .unwrap();
    let state = read_native_codex_state(&codex_home).await.unwrap();
    assert_eq!(state.active_provider.as_deref(), Some("deepseek"));
    assert!(native_codex_provider_ready(&state));
    assert!(!native_uses_vibex_projection(Some(&state)));
}

#[tokio::test]
async fn adopted_native_codex_provider_can_be_enabled_after_creating_another() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\nwire_api = \"responses\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let listed = list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    assert_eq!(listed.bound_provider_id.as_deref(), Some("custom"));
    assert!(listed.providers.iter().all(|provider| provider.managed));
    save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "VibeX Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://vibex.example/v1".to_string(),
            api_key: Some("vibex-secret".to_string()),
            model: "vibex-model".to_string(),
        },
    )
    .await
    .unwrap();
    let bound = bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some("custom".to_string()),
    )
    .await
    .unwrap();
    assert_eq!(bound.bound_provider_id.as_deref(), Some("custom"));
    let custom = bound
        .providers
        .iter()
        .find(|provider| provider.id == "custom")
        .unwrap();
    assert!(custom.bound);
    assert!(custom.managed);
    let vibex = bound
        .providers
        .iter()
        .find(|provider| provider.name == "VibeX Gateway")
        .unwrap();
    assert!(!vibex.bound);
}

#[tokio::test]
async fn delete_rejects_the_in_use_provider_and_the_last_remaining_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "VibeX Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://vibex.example/v1".to_string(),
            api_key: Some("vibex-secret".to_string()),
            model: "vibex-model".to_string(),
        },
    )
    .await
    .unwrap();
    let vibex_id = created
        .providers
        .iter()
        .find(|provider| provider.name == "VibeX Gateway")
        .unwrap()
        .id
        .clone();
    let in_use = delete(&store_path, &home, &environment, agent_id.clone(), "custom")
        .await
        .unwrap_err();
    assert!(in_use.contains("无法删除正在使用的供应商"));

    let view = delete(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        &vibex_id,
    )
    .await
    .unwrap();
    assert_eq!(view.providers.len(), 1);
    assert_eq!(view.bound_provider_id.as_deref(), Some("custom"));
    assert!(
        view.providers
            .iter()
            .all(|provider| provider.id == "custom")
    );

    let last = delete(&store_path, &home, &environment, agent_id.clone(), "custom")
        .await
        .unwrap_err();
    assert!(last.contains("至少需要保留一个供应商"));

    let config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    assert!(
        config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .is_some_and(|providers| providers.contains_key("custom"))
    );
    let relisted = list_with_native(&store_path, agent_id, Some(&codex_home))
        .await
        .unwrap();
    assert_eq!(relisted.providers.len(), 1);
    assert_eq!(relisted.providers[0].id, "custom");
}

#[tokio::test]
async fn delete_unbound_native_provider_removes_native_table() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let codex_home = home.join(".codex");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(&codex_home).await.unwrap();
    tokio::fs::write(
        codex_home.join("auth.json"),
        br#"{"OPENAI_API_KEY":"sk-native"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        codex_home.join("config.toml"),
        "model = \"deepseek-v4-flash\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nname = \"Custom\"\nbase_url = \"https://api.custom.example/v1\"\n\n[model_providers.spare]\nname = \"Spare\"\nbase_url = \"https://api.spare.example/v1\"\n",
    )
    .await
    .unwrap();
    let agent_id = AgentId::parse("codex").unwrap();
    let environment = HashMap::new();
    list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
        .await
        .unwrap();
    let view = delete(&store_path, &home, &environment, agent_id.clone(), "spare")
        .await
        .unwrap();
    assert!(view.providers.iter().all(|provider| provider.id != "spare"));
    assert_eq!(view.bound_provider_id.as_deref(), Some("custom"));
    let config = read_toml_table(&codex_home.join("config.toml"))
        .await
        .unwrap();
    let providers = config
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .unwrap();
    assert!(providers.contains_key("custom"));
    assert!(!providers.contains_key("spare"));
    let relisted = list_with_native(&store_path, agent_id, Some(&codex_home))
        .await
        .unwrap();
    assert!(
        relisted
            .providers
            .iter()
            .all(|provider| provider.id != "spare")
    );
}

#[tokio::test]
async fn native_import_of_claude_custom_endpoint_reuses_the_live_provider() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let store_path = temp.path().join("data/agent-model-providers.json");
    tokio::fs::create_dir_all(home.join(".claude"))
        .await
        .unwrap();
    tokio::fs::write(
        home.join(".claude/settings.json"),
        br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-native","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
    )
    .await
    .unwrap();
    let preview = preview_import(
        &store_path,
        &home,
        &HashMap::new(),
        AgentId::parse("claude_code").unwrap(),
        api_types::AgentModelProviderImportSource::Native,
    )
    .await
    .unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].api_url, "https://api.deepseek.com");
    assert!(preview.candidates[0].credential_present);
    assert!(preview.candidates[0].skip_reason.is_none());
    let imported = apply_import(
        &store_path,
        &home,
        &HashMap::new(),
        AgentId::parse("claude_code").unwrap(),
        api_types::AgentModelProviderImportSource::Native,
        &["__native_live__".to_string()],
    )
    .await
    .unwrap();
    assert_eq!(imported.providers.len(), 1);
    assert!(imported.providers[0].managed);
    assert!(imported.providers[0].bound);
    assert_eq!(
        imported.bound_provider_id.as_deref(),
        Some(imported.providers[0].id.as_str())
    );
}

#[tokio::test]
async fn pi_provider_binding_writes_models_auth_and_settings() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(&agent_dir.join("settings.json"), br#"{"theme":"dark"}"#)
        .await
        .unwrap();
    tokio::fs::write(&agent_dir.join("models.json"), br#"{"keep":true}"#)
        .await
        .unwrap();
    tokio::fs::write(&agent_dir.join("auth.json"), br#"{}"#)
        .await
        .unwrap();
    let agent_id = AgentId::parse("pi").unwrap();
    let created = save(
        &store_path,
        &home,
        &HashMap::new(),
        AgentModelProviderSaveRequest {
            id: None,
            name: "Private Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://private.example/v1".to_string(),
            api_key: Some("sk-pi".to_string()),
            model: r#"{"id":"private-model","api":"openai-responses"}"#.to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &HashMap::new(),
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    let settings: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let models: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("models.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(agent_dir.join("auth.json")).await.unwrap())
            .unwrap();
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["defaultProvider"], "private-gateway");
    assert_eq!(settings["defaultModel"], "private-model");
    assert_eq!(
        models["providers"]["private-gateway"]["baseUrl"],
        "https://private.example/v1"
    );
    assert_eq!(
        models["providers"]["private-gateway"]["api"],
        "openai-responses"
    );
    assert_eq!(
        models["providers"]["private-gateway"]["apiKey"],
        "$PI_API_KEY"
    );
    assert_eq!(auth["private-gateway"]["key"], "sk-pi");
    assert_eq!(models["keep"], true);

    bind(&store_path, &home, &HashMap::new(), agent_id, None)
        .await
        .unwrap();
    let restored: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(restored["theme"], "dark");
    assert!(restored.get("defaultProvider").is_none());
}

#[tokio::test]
async fn pi_provider_binding_writes_reasoning_and_default_thinking_level() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(&agent_dir.join("settings.json"), br#"{"theme":"dark"}"#)
        .await
        .unwrap();
    tokio::fs::write(&agent_dir.join("models.json"), br#"{}"#)
        .await
        .unwrap();
    tokio::fs::write(&agent_dir.join("auth.json"), br#"{}"#)
        .await
        .unwrap();
    let agent_id = AgentId::parse("pi").unwrap();
    let created = save(
        &store_path,
        &home,
        &HashMap::new(),
        AgentModelProviderSaveRequest {
            id: None,
            name: "Private Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://private.example/v1".to_string(),
            api_key: Some("sk-pi".to_string()),
            model: r#"{"id":"private-model","api":"openai-responses","reasoning":true,"thinkingLevel":"high","thinkingLevelMap":{"off":"none","high":"HIGH","xhigh":null}}"#.to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &HashMap::new(),
        agent_id,
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    let settings: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let models: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("models.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["defaultThinkingLevel"], "high");
    let model = &models["providers"]["private-gateway"]["models"][0];
    assert_eq!(model["id"], "private-model");
    assert_eq!(model["reasoning"], true);
    assert_eq!(model["thinkingLevelMap"]["off"], "none");
    assert_eq!(model["thinkingLevelMap"]["high"], "HIGH");
    assert!(model["thinkingLevelMap"]["xhigh"].is_null());
}

#[tokio::test]
async fn pi_draft_recovers_reasoning_from_native_models() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"gateway","defaultModel":"glm-5.2","defaultThinkingLevel":"high"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"gateway":{"baseUrl":"https://gateway.example/v1","api":"openai-responses","models":[{"id":"glm-5.2","reasoning":true,"thinkingLevelMap":{"off":"none","high":"HIGH"}}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(agent_dir.join("auth.json"), br#"{}"#)
        .await
        .unwrap();

    let drafts = native_pi_drafts(&agent_dir).await.unwrap();
    let model: Value = serde_json::from_str(&drafts[0].model).unwrap();
    assert_eq!(model["id"], "glm-5.2");
    assert_eq!(model["api"], "openai-responses");
    assert_eq!(model["reasoning"], true);
    assert_eq!(model["thinkingLevel"], "high");
    assert_eq!(model["thinkingLevelMap"]["high"], "HIGH");
    assert_eq!(model["models"], serde_json::json!(["glm-5.2"]));
}

#[tokio::test]
async fn pi_draft_recovers_a_key_kept_inline_in_models_json() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"cc-switch-open-code-go":{"baseUrl":"https://gateway.example/v1","api":"openai-responses","apiKey":"sk-inline","models":[{"id":"glm-5.2"}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"cc-switch-open-code-go":{"type":"api_key","key":""}}"#,
    )
    .await
    .unwrap();

    let drafts = native_pi_drafts(&agent_dir).await.unwrap();

    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].source_id, "native:cc-switch-open-code-go");
    assert_eq!(drafts[0].api_key, "sk-inline");
}

#[tokio::test]
async fn pi_draft_prefers_a_usable_auth_key_over_the_inline_one() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"gateway":{"baseUrl":"https://gateway.example/v1","api":"openai-responses","apiKey":"sk-inline","models":[{"id":"m"}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"gateway":{"type":"api_key","key":"sk-auth"}}"#,
    )
    .await
    .unwrap();

    let drafts = native_pi_drafts(&agent_dir).await.unwrap();

    assert_eq!(drafts[0].api_key, "sk-auth");
}

#[tokio::test]
async fn pi_binding_keeps_unmanaged_node_fields_and_repairs_the_auth_entry() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"private-gateway":{"baseUrl":"https://old.example/v1","api":"openai-responses","apiKey":"sk-inline","name":"Gateway","headers":{"x-tenant":"a"},"models":[{"id":"old-model"}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"private-gateway":{"type":"api_key","key":""},"anthropic":{"type":"oauth","refresh":"native"}}"#,
    )
    .await
    .unwrap();

    apply_pi(
        &agent_dir,
        &StoredProvider {
            id: "provider-1".to_string(),
            name: "Private Gateway".to_string(),
            agent_id: AgentId::parse("pi").unwrap(),
            api_url: "https://new.example/v1".to_string(),
            api_key: "sk-fresh".to_string(),
            model: r#"{"id":"new-model","api":"anthropic-messages"}"#.to_string(),
        },
    )
    .await
    .unwrap();

    let models: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("models.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let node = &models["providers"]["private-gateway"];
    assert_eq!(node["baseUrl"], "https://new.example/v1");
    assert_eq!(node["api"], "anthropic-messages");
    assert_eq!(node["name"], "Gateway");
    assert_eq!(node["headers"]["x-tenant"], "a");
    assert_eq!(node["apiKey"], "sk-inline");

    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(agent_dir.join("auth.json")).await.unwrap())
            .unwrap();
    assert_eq!(auth["private-gateway"]["key"], "sk-fresh");
    assert_eq!(auth["anthropic"]["refresh"], "native");
}

#[tokio::test]
async fn pi_binding_without_a_key_drops_an_empty_entry_but_keeps_oauth() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"private-gateway":{"baseUrl":"https://old.example/v1","api":"openai-responses","apiKey":"sk-inline"}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"private-gateway":{"type":"api_key","key":""},"anthropic":{"type":"oauth","refresh":"native"}}"#,
    )
    .await
    .unwrap();

    apply_pi(
        &agent_dir,
        &StoredProvider {
            id: "provider-1".to_string(),
            name: "Private Gateway".to_string(),
            agent_id: AgentId::parse("pi").unwrap(),
            api_url: "https://old.example/v1".to_string(),
            api_key: String::new(),
            model: r#"{"id":"m","api":"openai-responses"}"#.to_string(),
        },
    )
    .await
    .unwrap();

    let auth: Value =
        serde_json::from_slice(&tokio::fs::read(agent_dir.join("auth.json")).await.unwrap())
            .unwrap();
    assert!(auth.get("private-gateway").is_none());
    assert_eq!(auth["anthropic"]["refresh"], "native");
}

#[tokio::test]
async fn pi_list_recognizes_native_providers_and_active_binding() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"private","defaultModel":"private-model"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"private":{"baseUrl":"https://private.example/v1","api":"openai-responses","models":[{"id":"private-model"}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"private":{"type":"api_key","key":"sk-pi"},"anthropic":{"type":"api_key","key":"sk-ant"}}"#,
    )
    .await
    .unwrap();
    let view = list_with_native(&store_path, AgentId::parse("pi").unwrap(), Some(&agent_dir))
        .await
        .unwrap();
    assert_eq!(view.bound_provider_id.as_deref(), Some("private"));
    let private = view
        .providers
        .iter()
        .find(|provider| provider.id == "private")
        .expect("native custom provider");
    assert!(private.bound);
    assert!(private.managed);
    assert!(private.credential_present);
    assert_eq!(private.api_key, "sk-pi");
    assert_eq!(private.api_url, "https://private.example/v1");
    assert!(
        view.providers
            .iter()
            .all(|provider| provider.id != "anthropic")
    );
}

#[tokio::test]
async fn pi_list_reads_api_key_aliases_from_auth_entries() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"gateway","defaultModel":"go"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"gateway":{"baseUrl":"https://opencode.ai/zen/go/v1","api":"openai-completions","models":[{"id":"go"}]}}}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("auth.json"),
        br#"{"gateway":{"type":"api_key","apiKey":"sk-go"}}"#,
    )
    .await
    .unwrap();
    let view = list_with_native(&store_path, AgentId::parse("pi").unwrap(), Some(&agent_dir))
        .await
        .unwrap();
    let gateway = view
        .providers
        .iter()
        .find(|provider| provider.id == "gateway")
        .expect("gateway");
    assert!(gateway.bound);
    assert!(gateway.credential_present);
    assert_eq!(gateway.api_key, "sk-go");
}

#[tokio::test]
async fn native_claude_custom_endpoint_is_adopted_and_bound() {
    let temp = tempfile::tempdir().unwrap();
    let claude_home = temp.path().join("home/.claude");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&claude_home).await.unwrap();
    tokio::fs::write(
        claude_home.join("settings.json"),
        br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com","ANTHROPIC_AUTH_TOKEN":"sk-gateway","ANTHROPIC_MODEL":"deepseek-chat"}}"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("claude_code").unwrap(),
        Some(&claude_home),
    )
    .await
    .unwrap();
    assert_eq!(view.providers.len(), 1);
    let provider = &view.providers[0];
    assert!(provider.managed);
    assert!(provider.bound);
    assert_eq!(provider.api_url, "https://api.deepseek.com");
    assert_eq!(provider.api_key, "sk-gateway");
    assert_eq!(
        view.bound_provider_id.as_deref(),
        Some(provider.id.as_str())
    );
}

#[tokio::test]
async fn official_anthropic_url_is_not_adopted_as_a_provider() {
    let temp = tempfile::tempdir().unwrap();
    let claude_home = temp.path().join("home/.claude");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&claude_home).await.unwrap();
    tokio::fs::write(
        claude_home.join("settings.json"),
        br#"{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"sk-ant"}}"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("claude_code").unwrap(),
        Some(&claude_home),
    )
    .await
    .unwrap();
    assert!(view.providers.is_empty());
    assert_eq!(view.bound_provider_id, None);
}

#[tokio::test]
async fn native_gemini_custom_endpoint_is_adopted_and_bound() {
    let temp = tempfile::tempdir().unwrap();
    let gemini_home = temp.path().join("home/.gemini");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&gemini_home).await.unwrap();
    tokio::fs::write(
        gemini_home.join("settings.json"),
        br#"{"env":{"GEMINI_BASE_URL":"https://gateway.example/v1","GEMINI_API_KEY":"sk-gemini","GEMINI_MODEL":"gemini-pro"}}"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("gemini").unwrap(),
        Some(&gemini_home),
    )
    .await
    .unwrap();
    assert_eq!(view.providers.len(), 1);
    let provider = &view.providers[0];
    assert!(provider.bound);
    assert_eq!(provider.api_url, "https://gateway.example/v1");
    assert_eq!(provider.api_key, "sk-gemini");
}

#[tokio::test]
async fn native_grok_custom_model_is_adopted_and_bound() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-grok"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("grok").unwrap(),
        Some(&grok_home),
    )
    .await
    .unwrap();
    assert_eq!(view.providers.len(), 1);
    let provider = &view.providers[0];
    assert!(provider.bound);
    assert!(provider.credential_present);
    assert_eq!(provider.api_url, "https://gateway.example/v1");
    assert_eq!(provider.api_key, "sk-grok");
}

#[tokio::test]
async fn grok_lists_every_native_provider_and_binds_the_default() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[models]
default = "gateway"

[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-gateway"
model = "grok-4"

[model.other]
name = "Other"
base_url = "https://other.example/v1"
api_key = "sk-other"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("grok").unwrap(),
        Some(&grok_home),
    )
    .await
    .unwrap();
    assert_eq!(view.providers.len(), 2);
    assert_eq!(view.bound_provider_id.as_deref(), Some("gateway"));
    let gateway = view
        .providers
        .iter()
        .find(|provider| provider.id == "gateway")
        .unwrap();
    assert!(gateway.bound);
    let other = view
        .providers
        .iter()
        .find(|provider| provider.id == "other")
        .unwrap();
    assert!(!other.bound);
}

#[tokio::test]
async fn grok_native_default_outranks_a_stale_store_binding() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(store_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        &store_path,
        serde_json::json!({
            "providers": [{
                "id": "stale",
                "name": "Stale",
                "agent_id": "grok",
                "api_url": "https://stale.example/v1",
                "api_key": "sk-stale",
                "model": "grok-4"
            }],
            "bindings": { "grok": "stale" }
        })
        .to_string(),
    )
    .await
    .unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[models]
default = "gateway"

[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-gateway"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("grok").unwrap(),
        Some(&grok_home),
    )
    .await
    .unwrap();
    assert_eq!(view.bound_provider_id.as_deref(), Some("gateway"));
    assert!(
        view.providers
            .iter()
            .any(|provider| provider.id == "stale" && !provider.bound)
    );
}

#[tokio::test]
async fn grok_vibex_default_marks_the_live_endpoint_enabled() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(store_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        &store_path,
        serde_json::json!({
            "providers": [{
                "id": "grok-4.6",
                "name": "BeeAPI · grok",
                "agent_id": "grok",
                "api_url": "https://beeapi.ai/v1",
                "api_key": "sk-bee",
                "model": "{\"id\":\"grok-4.6\"}"
            }],
            "bindings": {}
        })
        .to_string(),
    )
    .await
    .unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[models]
default = "vibex"

[model."grok-4.6"]
name = "BeeAPI · grok"
base_url = "https://beeapi.ai/v1"
api_key = "sk-bee"
model = "grok-4.6"

[model.vibex]
name = "beeapi"
base_url = "https://beeapi.ai/v1"
api_key = "sk-bee"
model = "grok-4.6"
"#,
    )
    .await
    .unwrap();
    let view = list_with_native(
        &store_path,
        AgentId::parse("grok").unwrap(),
        Some(&grok_home),
    )
    .await
    .unwrap();
    let enabled = view
        .providers
        .iter()
        .find(|provider| provider.bound)
        .expect("the live BeeAPI endpoint must show as enabled");
    assert_eq!(enabled.api_url, "https://beeapi.ai/v1");
    assert_eq!(view.bound_provider_id.as_deref(), Some(enabled.id.as_str()));
}

#[tokio::test]
async fn grok_enabling_a_native_provider_only_changes_default() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let grok_home = home.join(".grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[models]
default = "other"

[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-gateway"
model = "grok-4"

[model.other]
name = "Other"
base_url = "https://other.example/v1"
api_key = "sk-other"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    tokio::fs::write(grok_home.join("auth.json"), br#"{"token":"session"}"#)
        .await
        .unwrap();
    let environment = HashMap::from([(
        "GROK_HOME".to_string(),
        grok_home.to_string_lossy().to_string(),
    )]);
    let agent_id = AgentId::parse("grok").unwrap();
    list_with_native(&store_path, agent_id.clone(), Some(&grok_home))
        .await
        .unwrap();
    bind(
        &store_path,
        &home,
        &environment,
        agent_id,
        Some("gateway".to_string()),
    )
    .await
    .unwrap();
    let config = read_toml_table(&grok_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(config["models"]["default"].as_str(), Some("gateway"));
    assert!(config["model"].get("gateway").is_some());
    assert!(config["model"].get("other").is_some());
    assert!(config["model"].get("vibex").is_none());
    let auth = tokio::fs::read_to_string(grok_home.join("auth.json"))
        .await
        .unwrap();
    assert_eq!(auth.trim(), "{}");
}

#[tokio::test]
async fn grok_unbind_keeps_hand_written_provider_tables() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let grok_home = home.join(".grok");
    let store_path = temp.path().join("data/providers.json");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[models]
default = "grok-4.6"

[model.gateway]
name = "Gateway"
base_url = "https://gateway.example/v1"
api_key = "sk-gateway"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    let environment = HashMap::from([(
        "GROK_HOME".to_string(),
        grok_home.to_string_lossy().to_string(),
    )]);
    let agent_id = AgentId::parse("grok").unwrap();
    let created = save(
        &store_path,
        &home,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "VibeX Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://vibex.example/v1".to_string(),
            api_key: Some("sk-vibex".to_string()),
            model: "grok-4".to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    bind(&store_path, &home, &environment, agent_id.clone(), None)
        .await
        .unwrap();
    let config = read_toml_table(&grok_home.join("config.toml"))
        .await
        .unwrap();
    assert_eq!(config["models"]["default"].as_str(), Some("grok-4.6"));
    assert!(config["model"].get("gateway").is_some());
    assert!(config["model"].get("vibex").is_none());
    let view = list_with_native(&store_path, agent_id, Some(&grok_home))
        .await
        .unwrap();
    assert!(view.bound_provider_id.is_none());
    assert!(
        view.providers
            .iter()
            .any(|provider| provider.id == "gateway")
    );
}

/// Bind a grok provider carrying `model`, and hand back the resulting
/// `config.toml` so a test can assert on the tables it projected.
async fn bind_grok_provider(temp: &Path, model: &str) -> toml::Table {
    let grok_home = temp.join("home/.grok");
    let store_path = temp.join("data/providers.json");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    let environment = HashMap::from([(
        "GROK_HOME".to_string(),
        grok_home.to_string_lossy().to_string(),
    )]);
    let agent_id = AgentId::parse("grok").unwrap();
    let created = save(
        &store_path,
        temp,
        &environment,
        AgentModelProviderSaveRequest {
            id: None,
            name: "Gateway".to_string(),
            agent_id: agent_id.clone(),
            api_url: "https://gateway.example/v1".to_string(),
            api_key: Some("sk-grok".to_string()),
            model: model.to_string(),
        },
    )
    .await
    .unwrap();
    bind(
        &store_path,
        temp,
        &environment,
        agent_id,
        Some(created.providers[0].id.clone()),
    )
    .await
    .unwrap();
    let bytes = tokio::fs::read(grok_home.join("config.toml"))
        .await
        .unwrap();
    toml::from_str(std::str::from_utf8(&bytes).unwrap()).unwrap()
}

#[tokio::test]
async fn grok_binding_writes_one_table_per_enabled_model() {
    let temp = tempfile::tempdir().unwrap();
    let config = bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a","b","c"]}"#,
    )
    .await;

    // The default names a table, so the primary model has to own `vibex`
    // while the rest become reachable tables of their own. One table per
    // model is what makes every checked model usable in grok.
    assert_eq!(config["models"]["default"].as_str(), Some("vibex"));
    let models = config["model"].as_table().unwrap();
    assert_eq!(models.len(), 3);
    for (table, expected) in [("vibex", "a"), ("vibex-b", "b"), ("vibex-c", "c")] {
        let entry = models[table].as_table().unwrap();
        assert_eq!(entry["model"].as_str(), Some(expected), "table {table}");
        assert_eq!(
            entry["base_url"].as_str(),
            Some("https://gateway.example/v1")
        );
        assert_eq!(entry["api_key"].as_str(), Some("sk-grok"));
    }
    // The default carries the provider's own name — it is the provider —
    // and the extras are told apart by their model id, since a shared name
    // would list the same provider three times in grok's picker.
    assert_eq!(models["vibex"]["name"].as_str(), Some("Gateway"));
    assert_eq!(models["vibex-b"]["name"].as_str(), Some("Gateway (b)"));
    assert_eq!(models["vibex-c"]["name"].as_str(), Some("Gateway (c)"));
}

#[tokio::test]
async fn grok_import_collapses_the_tables_vibex_projected() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    let store_path = temp.path().join("data/providers.json");
    bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a","b","c"]}"#,
    )
    .await;

    let view = list_with_native(
        &store_path,
        AgentId::parse("grok").unwrap(),
        Some(&grok_home),
    )
    .await
    .unwrap();

    // One provider, not one per projected table.
    assert_eq!(view.providers.len(), 1);
    assert_eq!(view.providers[0].name, "Gateway");
    let model: Value = serde_json::from_str(&view.providers[0].model).unwrap();
    assert_eq!(model["id"], "a");
    assert_eq!(model["models"], serde_json::json!(["a", "b", "c"]));
}

#[tokio::test]
async fn grok_binding_drops_the_tables_of_models_the_user_disabled() {
    let temp = tempfile::tempdir().unwrap();
    bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a","b","c"]}"#,
    )
    .await;
    let config = bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a"]}"#,
    )
    .await;

    // Unchecking a model has to take it out of grok's picker; leaving the
    // table behind would keep it selectable forever.
    let models = config["model"].as_table().unwrap();
    assert_eq!(models.len(), 1);
    assert!(models.contains_key("vibex"));
}

#[tokio::test]
async fn grok_binding_keeps_a_hand_written_model_table() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[model.company-grok]
base_url = "https://company.example/v1"
model = "grok-4"
"#,
    )
    .await
    .unwrap();
    let config = bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a","b"]}"#,
    )
    .await;

    // The sweep only owns the names VibeX mints.
    let models = config["model"].as_table().unwrap();
    assert!(models.contains_key("company-grok"));
    assert!(models.contains_key("vibex"));
    assert!(models.contains_key("vibex-b"));
}

#[tokio::test]
async fn grok_binding_clears_a_field_the_user_emptied() {
    let temp = tempfile::tempdir().unwrap();
    let grok_home = temp.path().join("home/.grok");
    tokio::fs::create_dir_all(&grok_home).await.unwrap();
    tokio::fs::write(
        grok_home.join("config.toml"),
        r#"
[model.vibex]
model = "old"
context_window = 200000
"#,
    )
    .await
    .unwrap();
    let config = bind_grok_provider(
        temp.path(),
        r#"{"id":"a","api_backend":"responses","models":["a"]}"#,
    )
    .await;

    // Rebuilding the table is what makes clearing a field stick.
    let vibex = config["model"]["vibex"].as_table().unwrap();
    assert!(!vibex.contains_key("context_window"));
    assert_eq!(vibex["model"].as_str(), Some("a"));
}

#[tokio::test]
async fn pi_draft_keeps_every_model_the_provider_lists() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"gateway","defaultModel":"b"}"#,
    )
    .await
    .unwrap();
    // `c` is written the way cc-switch writes it: a bare id, not an object.
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"gateway":{"baseUrl":"https://gateway.example/v1","api":"openai-responses","models":[{"id":"a"},{"id":"b"},{"id":"c"}]}}}"#,
    )
    .await
    .unwrap();

    let drafts = native_pi_drafts(&agent_dir).await.unwrap();

    let model: Value = serde_json::from_str(&drafts[0].model).unwrap();
    // Importing used to keep only the first id, so the models the user had
    // enabled came back missing.
    assert_eq!(
        model["models"],
        serde_json::json!(["b", "a", "c"]),
        "every model survives, with pi's default leading"
    );
    // Leading matters: `apply_pi` reads the first entry back as the default,
    // so anything else would move the user off their model on the next save.
    assert_eq!(model["id"], "b");
    assert_eq!(model["api"], "openai-responses");
}

#[tokio::test]
async fn pi_binding_writes_reasoning_and_effort_map_on_the_default_model() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"private-gateway":{"baseUrl":"https://old.example/v1","api":"openai-responses","headers":{"x-tenant":"a"},"models":[{"id":"private-model","compat":true}]}}}"#,
    )
    .await
    .unwrap();

    apply_pi(
        &agent_dir,
        &StoredProvider {
            id: "provider-1".to_string(),
            name: "Private Gateway".to_string(),
            agent_id: AgentId::parse("pi").unwrap(),
            api_url: "https://new.example/v1".to_string(),
            api_key: "sk-fresh".to_string(),
            model: r#"{"id":"private-model","api":"openai-responses","reasoning":true,"thinkingLevel":"high","thinkingLevelMap":{"off":"none","xhigh":null}}"#.to_string(),
        },
    )
    .await
    .unwrap();

    let settings: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    let models: Value = serde_json::from_slice(
        &tokio::fs::read(agent_dir.join("models.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["defaultThinkingLevel"], "high");
    let entry = &models["providers"]["private-gateway"]["models"][0];
    assert_eq!(entry["id"], "private-model");
    assert_eq!(entry["compat"], true);
    assert_eq!(entry["reasoning"], true);
    assert_eq!(entry["thinkingLevelMap"]["off"], "none");
    assert_eq!(entry["thinkingLevelMap"]["xhigh"], Value::Null);
    assert_eq!(
        models["providers"]["private-gateway"]["headers"]["x-tenant"],
        "a"
    );
}

#[tokio::test]
async fn pi_draft_reads_reasoning_from_the_default_model() {
    let temp = tempfile::tempdir().unwrap();
    let agent_dir = temp.path().join(".pi/agent");
    tokio::fs::create_dir_all(&agent_dir).await.unwrap();
    tokio::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"gateway","defaultModel":"a","defaultThinkingLevel":"medium"}"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        agent_dir.join("models.json"),
        br#"{"providers":{"gateway":{"baseUrl":"https://gateway.example/v1","api":"openai-responses","models":[{"id":"a","reasoning":true,"thinkingLevelMap":{"off":"none"}}]}}}"#,
    )
    .await
    .unwrap();

    let drafts = native_pi_drafts(&agent_dir).await.unwrap();
    let model: Value = serde_json::from_str(&drafts[0].model).unwrap();
    assert_eq!(model["reasoning"], true);
    assert_eq!(model["thinkingLevelMap"]["off"], "none");
    assert_eq!(model["thinkingLevel"], "medium");
}

async fn write_kimi_gate_config(kimi_home: &Path) {
    tokio::fs::create_dir_all(kimi_home.join("credentials"))
        .await
        .unwrap();
    tokio::fs::write(
        kimi_home.join("config.toml"),
        "default_model = \"vibex\"\n\n[providers.vibex]\ntype = \"openai\"\nbase_url = \"https://gateway.example/v1\"\napi_key = \"sk-gate\"\n\n[models.vibex]\nprovider = \"vibex\"\nmodel = \"gateway/model\"\n",
    )
    .await
    .unwrap();
    tokio::fs::write(
        kimi_home.join("credentials/kimi-code.json"),
        br#"{"access_token":"vibex-local-gate","_vibex_synthetic":true}"#,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn kimi_login_cleanup_removes_the_gate_provider_and_its_credential() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let kimi_home = home.join(".kimi-code");
    write_kimi_gate_config(&kimi_home).await;

    let mutations = prepare_kimi_vibex_configuration_cleanup(&home, &HashMap::new())
        .await
        .unwrap();
    assert_eq!(mutations.len(), 2);
    apply_projection_mutations(&mutations).await.unwrap();

    let config = tokio::fs::read_to_string(kimi_home.join("config.toml"))
        .await
        .unwrap();
    assert!(
        !config.contains("vibex"),
        "an official login would still reach the gate: {config}"
    );
    assert!(!kimi_home.join("credentials/kimi-code.json").exists());
}

#[tokio::test]
async fn kimi_login_cleanup_leaves_a_signed_in_agent_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let kimi_home = home.join(".kimi-code");
    tokio::fs::create_dir_all(kimi_home.join("credentials"))
        .await
        .unwrap();
    let config = "# hand written\n[providers.moonshot]\napi_key = \"sk-live\"\n";
    tokio::fs::write(kimi_home.join("config.toml"), config)
        .await
        .unwrap();
    tokio::fs::write(
        kimi_home.join("credentials/kimi-code.json"),
        br#"{"access_token":"real-token"}"#,
    )
    .await
    .unwrap();

    let mutations = prepare_kimi_vibex_configuration_cleanup(&home, &HashMap::new())
        .await
        .unwrap();
    apply_projection_mutations(&mutations).await.unwrap();

    assert!(mutations.is_empty(), "unexpected mutations: {mutations:?}");
    assert_eq!(
        tokio::fs::read_to_string(kimi_home.join("config.toml"))
            .await
            .unwrap(),
        config
    );
    assert!(kimi_home.join("credentials/kimi-code.json").exists());
}

#[tokio::test]
async fn kimi_login_cleanup_ignores_a_missing_native_home() {
    let temp = tempfile::tempdir().unwrap();

    let mutations = prepare_kimi_vibex_configuration_cleanup(temp.path(), &HashMap::new())
        .await
        .unwrap();

    assert!(mutations.is_empty(), "unexpected mutations: {mutations:?}");
}

#[test]
fn the_gate_credential_is_recognized_with_or_without_its_marker() {
    assert!(kimi_credential_is_synthetic(
        &serde_json::json!({"_vibex_synthetic": true})
    ));
    assert!(kimi_credential_is_synthetic(
        &serde_json::json!({"access_token": "vibex-local-gate"})
    ));
    assert!(!kimi_credential_is_synthetic(
        &serde_json::json!({"access_token": "sk-live"})
    ));
}
