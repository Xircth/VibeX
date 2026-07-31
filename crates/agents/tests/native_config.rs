mod support;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use agents::{
    AgentAuthenticationStatus, AgentId, BoundaryError, ConfigApplyEffect, NativeConfigFormat,
    NativeConfigPatch, NativeConfigProvider, NativeConfigSaveError, NativeFileMetadata,
    NativeFileSystem,
};
use async_trait::async_trait;
use support::management::MemoryNativeFileSystem;

#[derive(Default)]
struct FailSecondWriteFileSystem {
    files: Mutex<std::collections::HashMap<PathBuf, Vec<u8>>>,
    writes: Mutex<usize>,
}

#[async_trait]
impl NativeFileSystem for FailSecondWriteFileSystem {
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>, BoundaryError> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }

    async fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), BoundaryError> {
        let mut writes = self.writes.lock().unwrap();
        *writes += 1;
        if *writes == 2 {
            return Err(BoundaryError::new("injected second-file failure"));
        }
        self.files
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), bytes.to_vec());
        Ok(())
    }

    async fn remove_file(&self, path: &Path) -> Result<(), BoundaryError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn metadata(&self, path: &Path) -> Result<Option<NativeFileMetadata>, BoundaryError> {
        Ok(self
            .files
            .lock()
            .unwrap()
            .get(path)
            .map(|bytes| NativeFileMetadata {
                length: bytes.len() as u64,
            }))
    }
}

#[tokio::test]
async fn native_config_multi_file_failure_rolls_back_every_original() {
    let filesystem = Arc::new(FailSecondWriteFileSystem::default());
    let config_path = PathBuf::from("/home/user/.codex/config.toml");
    let auth_path = PathBuf::from("/home/user/.codex/auth.json");
    let original_config = br#"model = "old""#.to_vec();
    let original_auth = br#"{"OPENAI_API_KEY":"old"}"#.to_vec();
    filesystem
        .files
        .lock()
        .unwrap()
        .insert(config_path.clone(), original_config.clone());
    filesystem
        .files
        .lock()
        .unwrap()
        .insert(auth_path.clone(), original_auth.clone());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let agent_id = AgentId::parse("codex").unwrap();
    let initial = provider.read(&agent_id, false).await.unwrap();

    let result = provider
        .save(
            &agent_id,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    ("codex_model".to_string(), Some("new".to_string())),
                    ("openai_api_key".to_string(), Some("new-key".to_string())),
                ]),
            },
            false,
        )
        .await;
    assert!(result.is_err());
    let files = filesystem.files.lock().unwrap();
    assert_eq!(files[&config_path], original_config);
    assert_eq!(files[&auth_path], original_auth);
}

#[tokio::test]
async fn native_config_preserves_unknown_fields_and_reports_auth_status() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    let path = PathBuf::from("/home/user/.codex/auth.json");

    let absent = provider.read(&codex, false).await.unwrap();
    assert!(!absent.exists);
    assert_eq!(
        absent.authentication,
        AgentAuthenticationStatus::NotLoggedIn
    );

    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"{"unknown":{"keep":true},"OPENAI_API_KEY":"old"}"#.to_vec(),
    );
    let initial = provider.read(&codex, false).await.unwrap();
    assert_eq!(initial.authentication, AgentAuthenticationStatus::ApiKey);
    assert_eq!(initial.files.len(), 2);
    let auth_preview = initial.files.iter().find(|file| file.path == path).unwrap();
    assert!(auth_preview.exists);
    assert!(auth_preview.sensitive);
    assert_eq!(auth_preview.format, NativeConfigFormat::Json);
    assert_eq!(
        auth_preview.content,
        r#"{"unknown":{"keep":true},"OPENAI_API_KEY":"old"}"#
    );
    let config_preview = initial
        .files
        .iter()
        .find(|file| file.path == Path::new("/home/user/.codex/config.toml"))
        .unwrap();
    assert!(!config_preview.exists);
    assert!(!config_preview.sensitive);
    assert_eq!(config_preview.format, NativeConfigFormat::Toml);
    assert_eq!(config_preview.content, "");
    let field = initial
        .fields
        .iter()
        .find(|field| field.field_id == "openai_api_key")
        .unwrap();
    assert!(field.present);
    assert_eq!(field.masked_value.as_deref(), Some("••••••••"));

    // An unrelated external edit is merged because only same-field conflicts block.
    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"{"unknown":{"keep":true,"external":1},"OPENAI_API_KEY":"old"}"#.to_vec(),
    );
    let saved = provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "openai_api_key".to_string(),
                    Some("not-validated-by-vibex".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    assert_eq!(saved.effect, ConfigApplyEffect::NextSessionOnly);
    assert_eq!(
        saved.snapshot.authentication,
        AgentAuthenticationStatus::ApiKey
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(filesystem.files.lock().unwrap().get(&path).unwrap()).unwrap();
    assert_eq!(persisted["unknown"]["external"], 1);
    assert_eq!(persisted["OPENAI_API_KEY"], "not-validated-by-vibex");

    let stale = provider.read(&codex, false).await.unwrap();
    filesystem.files.lock().unwrap().insert(
        path,
        br#"{"unknown":{"keep":true},"OPENAI_API_KEY":"changed-elsewhere"}"#.to_vec(),
    );
    let conflict = provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: stale
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([("openai_api_key".to_string(), Some("mine".to_string()))]),
            },
            false,
        )
        .await;
    assert!(matches!(
        conflict,
        Err(NativeConfigSaveError::FieldConflicts { .. })
    ));

    assert_eq!(
        provider.read(&codex, true).await.unwrap().authentication,
        AgentAuthenticationStatus::Account
    );

    let pi = AgentId::parse("pi").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.pi/agent/auth.json"),
        br#"{"anthropic":{"type":"api_key","key":"present"}}"#.to_vec(),
    );
    assert_eq!(
        provider.read(&pi, true).await.unwrap().authentication,
        AgentAuthenticationStatus::MultipleUnknown
    );
}

#[tokio::test]
async fn bundled_profiles_manage_runtime_settings_across_all_declared_files() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();

    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-existing"
unknown_setting = "preserve-me"

[features]
responses_websockets_v2 = false
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    assert_eq!(initial.paths.len(), 2);
    assert!(
        initial
            .files
            .iter()
            .find(|file| file.path == Path::new("/home/user/.codex/config.toml"))
            .unwrap()
            .content
            .contains("unknown_setting = \"preserve-me\"")
    );
    let model = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_model")
        .unwrap();
    assert_eq!(model.value.as_deref(), Some("gpt-existing"));
    assert!(!model.secret);
    assert_eq!(
        initial
            .fields
            .iter()
            .find(|field| field.field_id == "codex_responses_websockets")
            .and_then(|field| field.value.as_deref()),
        Some("false")
    );

    let revisions = initial
        .fields
        .iter()
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: revisions,
                values: BTreeMap::from([
                    ("codex_model".to_string(), Some("gpt-new".to_string())),
                    (
                        "codex_responses_websockets".to_string(),
                        Some("true".to_string()),
                    ),
                    ("openai_api_key".to_string(), Some("sk-local".to_string())),
                ]),
            },
            false,
        )
        .await
        .unwrap();

    let config = String::from_utf8(
        filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")].clone(),
    )
    .unwrap();
    let config: toml::Value = toml::from_str(&config).unwrap();
    assert_eq!(config["model"].as_str(), Some("gpt-new"));
    assert_eq!(config["unknown_setting"].as_str(), Some("preserve-me"));
    assert_eq!(
        config["features"]["responses_websockets_v2"].as_bool(),
        Some(true)
    );
    let auth: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/auth.json")],
    )
    .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "sk-local");
}

#[tokio::test]
async fn tagged_provider_keys_preserve_the_official_auth_shape() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let pi = AgentId::parse("pi").unwrap();
    let initial = provider.read(&pi, false).await.unwrap();

    provider
        .save(
            &pi,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "pi_anthropic_api_key".to_string(),
                        Some("sk-ant-local".to_string()),
                    ),
                    (
                        "pi_default_provider".to_string(),
                        Some("anthropic".to_string()),
                    ),
                    (
                        "pi_compaction_reserve_tokens".to_string(),
                        Some("24000".to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();

    let auth: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.pi/agent/auth.json")],
    )
    .unwrap();
    assert_eq!(auth["anthropic"]["type"], "api_key");
    assert_eq!(auth["anthropic"]["key"], "sk-ant-local");

    let settings: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.pi/agent/settings.json")],
    )
    .unwrap();
    assert_eq!(settings["defaultProvider"], "anthropic");
    assert_eq!(settings["compaction"]["reserveTokens"], 24000);
}
