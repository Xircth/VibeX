mod support;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

// Only the POSIX-gated permission test below touches the real filesystem.
#[cfg(unix)]
use agents::TokioNativeFileSystem;
use agents::{
    AgentAuthenticationStatus, AgentId, BoundaryError, ConfigApplyEffect, NativeConfigFilePatch,
    NativeConfigFormat, NativeConfigPatch, NativeConfigProvider, NativeConfigSaveError,
    NativeFileMetadata, NativeFileMutation, NativeFileSystem,
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

    async fn write_atomic(
        &self,
        path: &Path,
        bytes: &[u8],
        _sensitive: bool,
    ) -> Result<(), BoundaryError> {
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

#[cfg(unix)]
#[tokio::test]
async fn native_filesystem_keeps_sensitive_documents_private() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("auth.json");
    TokioNativeFileSystem
        .write_atomic(&path, br#"{"token":"secret"}"#, true)
        .await
        .unwrap();

    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn native_file_transaction_rejects_a_concurrent_external_change() {
    let filesystem = MemoryNativeFileSystem::default();
    let path = PathBuf::from("/home/user/.codex/config.toml");
    filesystem
        .write_atomic(&path, b"model = \"external\"", false)
        .await
        .unwrap();

    let error = filesystem
        .apply_many_atomic(&[NativeFileMutation {
            path: path.clone(),
            expected: Some(b"model = \"opened\"".to_vec()),
            replacement: Some(b"model = \"user\"".to_vec()),
            sensitive: false,
        }])
        .await
        .unwrap_err();

    assert!(error.to_string().contains("changed on disk"));
    assert_eq!(
        filesystem.files.lock().unwrap()[&path],
        b"model = \"external\""
    );
}

#[tokio::test]
async fn raw_native_config_edit_validates_path_format_revision_and_sensitivity() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let config_path = PathBuf::from("/home/user/.codex/config.toml");
    let auth_path = PathBuf::from("/home/user/.codex/auth.json");
    filesystem
        .write_atomic(&config_path, b"model = \"gpt-5.4\"\n", false)
        .await
        .unwrap();
    filesystem
        .write_atomic(&auth_path, br#"{"OPENAI_API_KEY":"secret"}"#, true)
        .await
        .unwrap();
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let agent_id = AgentId::parse("codex").unwrap();
    let initial = provider.read(&agent_id, false).await.unwrap();
    let config_revision = initial
        .files
        .iter()
        .find(|file| file.path == config_path)
        .unwrap()
        .revision
        .clone();
    let auth_revision = initial
        .files
        .iter()
        .find(|file| file.path == auth_path)
        .unwrap()
        .revision
        .clone();

    let invalid = provider
        .save_file(
            &agent_id,
            NativeConfigFilePatch {
                path: config_path.clone(),
                base_revision: config_revision.clone(),
                content: "model = [".to_string(),
            },
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(invalid, NativeConfigSaveError::Read(_)));

    let sensitive = provider
        .save_file(
            &agent_id,
            NativeConfigFilePatch {
                path: auth_path.clone(),
                base_revision: auth_revision,
                content: "{}".to_string(),
            },
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        sensitive,
        NativeConfigSaveError::SensitiveFile(path) if path == auth_path
    ));

    let claude = AgentId::parse("claude_code").unwrap();
    let claude_settings = PathBuf::from("/home/user/.claude/settings.json");
    let claude_snapshot = provider.read(&claude, false).await.unwrap();
    let claude_file = claude_snapshot
        .files
        .iter()
        .find(|file| file.path == claude_settings)
        .unwrap();
    assert!(
        !claude_file.sensitive,
        "mixed Claude settings.json must stay editable"
    );
    provider
        .save_file(
            &claude,
            NativeConfigFilePatch {
                path: claude_settings.clone(),
                base_revision: claude_file.revision.clone(),
                content: "{\n  \"includeCoAuthoredBy\": false\n}\n".to_string(),
            },
            false,
        )
        .await
        .unwrap();
    assert!(
        filesystem
            .files
            .lock()
            .unwrap()
            .contains_key(&claude_settings)
    );

    let unknown = provider
        .save_file(
            &agent_id,
            NativeConfigFilePatch {
                path: PathBuf::from("/tmp/not-allowed.toml"),
                base_revision: config_revision.clone(),
                content: String::new(),
            },
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(unknown, NativeConfigSaveError::UnknownFile(_)));

    filesystem
        .write_atomic(&config_path, b"model = \"external\"\n", false)
        .await
        .unwrap();
    let conflict = provider
        .save_file(
            &agent_id,
            NativeConfigFilePatch {
                path: config_path.clone(),
                base_revision: config_revision,
                content: "model = \"gpt-5.6\"\n".to_string(),
            },
            false,
        )
        .await
        .unwrap_err();
    assert!(matches!(
        conflict,
        NativeConfigSaveError::FileConflict { path } if path == config_path
    ));
}

#[tokio::test]
async fn raw_native_config_edit_preserves_the_submitted_document() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let agent_id = AgentId::parse("codex").unwrap();
    let initial = provider.read(&agent_id, false).await.unwrap();
    let file = initial.files.iter().find(|file| !file.sensitive).unwrap();
    let content = "model = \"gpt-5.6\"\n[sandbox_workspace_write]\nnetwork_access = true\n";

    let saved = provider
        .save_file(
            &agent_id,
            NativeConfigFilePatch {
                path: file.path.clone(),
                base_revision: file.revision.clone(),
                content: content.to_string(),
            },
            false,
        )
        .await
        .unwrap();

    assert_eq!(
        filesystem.files.lock().unwrap()[&file.path],
        content.as_bytes()
    );
    let saved_file = saved
        .snapshot
        .files
        .iter()
        .find(|candidate| candidate.path == file.path)
        .unwrap();
    assert_ne!(saved_file.revision, file.revision);
    assert_eq!(saved_file.content, content);
}

#[tokio::test]
async fn saved_agent_home_is_authoritative_for_native_configuration() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::with_environment(
        filesystem,
        PathBuf::from("/home/user"),
        BTreeMap::from([("PI_CODING_AGENT_DIR".to_string(), "~/custom-pi".to_string())]),
    );

    let snapshot = provider
        .read(&AgentId::parse("pi").unwrap(), false)
        .await
        .unwrap();

    assert!(
        snapshot
            .paths
            .iter()
            .all(|path| path.starts_with("/home/user/custom-pi"))
    );
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
                    (
                        "codex_approval_policy".to_string(),
                        Some("never".to_string()),
                    ),
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
async fn codex_api_key_mode_removes_chatgpt_auth_mode() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let auth_path = PathBuf::from("/home/user/.codex/auth.json");
    filesystem.files.lock().unwrap().insert(
        auth_path.clone(),
        br#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"keep"}}"#
            .to_vec(),
    );
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let agent_id = AgentId::parse("codex").unwrap();
    let initial = provider.read(&agent_id, true).await.unwrap();

    provider
        .save(
            &agent_id,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "openai_api_key".to_string(),
                    Some("sk-local".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();

    let document: serde_json::Value =
        serde_json::from_slice(filesystem.files.lock().unwrap().get(&auth_path).unwrap()).unwrap();
    assert_eq!(document["OPENAI_API_KEY"], "sk-local");
    assert!(document.get("auth_mode").is_none());
    assert_eq!(document["tokens"]["access_token"], "keep");
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
async fn pi_custom_provider_api_key_counts_as_authenticated() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let pi = AgentId::parse("pi").unwrap();
    let path = PathBuf::from("/home/user/.pi/agent/auth.json");

    assert_eq!(
        provider.read(&pi, false).await.unwrap().authentication,
        AgentAuthenticationStatus::NotLoggedIn
    );

    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"{"cc-switch-open-code-go":{"type":"api_key","key":"sk-go"}}"#.to_vec(),
    );
    assert_eq!(
        provider.read(&pi, false).await.unwrap().authentication,
        AgentAuthenticationStatus::ApiKey
    );

    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"{"gateway":{"apiKey":"sk-alias"}}"#.to_vec(),
    );
    assert_eq!(
        provider.read(&pi, false).await.unwrap().authentication,
        AgentAuthenticationStatus::ApiKey
    );

    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"{"cc-switch-open-code-go":{"type":"api_key","key":"sk-go"}}"#.to_vec(),
    );
    assert_eq!(
        provider.read(&pi, true).await.unwrap().authentication,
        AgentAuthenticationStatus::MultipleUnknown
    );

    filesystem.files.lock().unwrap().insert(
        path,
        br#"{"cc-switch-open-code-go":{"type":"api_key","key":"   "}}"#.to_vec(),
    );
    assert_eq!(
        provider.read(&pi, false).await.unwrap().authentication,
        AgentAuthenticationStatus::NotLoggedIn
    );
}

#[tokio::test]
async fn bundled_profiles_manage_runtime_settings_across_all_declared_files() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();

    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"approval_policy = "never"
unknown_setting = "preserve-me"

[sandbox_workspace_write]
network_access = false
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
    let policy = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_approval_policy")
        .unwrap();
    assert_eq!(policy.value.as_deref(), Some("never"));
    assert!(!policy.secret);
    assert_eq!(
        initial
            .fields
            .iter()
            .find(|field| field.field_id == "codex_network_access")
            .and_then(|field| field.value.as_deref()),
        Some("false")
    );
    assert_eq!(
        initial
            .fields
            .iter()
            .find(|field| field.field_id == "codex_web_search")
            .and_then(|field| field.value.as_deref()),
        Some("cached")
    );
    assert!(
        !initial
            .fields
            .iter()
            .find(|field| field.field_id == "codex_web_search")
            .unwrap()
            .present
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
                    (
                        "codex_approval_policy".to_string(),
                        Some("on-request".to_string()),
                    ),
                    ("codex_network_access".to_string(), Some("true".to_string())),
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
    assert_eq!(config["approval_policy"].as_str(), Some("on-request"));
    assert_eq!(config["unknown_setting"].as_str(), Some("preserve-me"));
    assert_eq!(
        config["sandbox_workspace_write"]["network_access"].as_bool(),
        Some(true)
    );
    let auth: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/auth.json")],
    )
    .unwrap();
    assert_eq!(auth["OPENAI_API_KEY"], "sk-local");
}

#[tokio::test]
async fn codex_api_url_reads_and_writes_the_active_provider_table() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "deepseek-v4-flash"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek Gateway"
base_url = "https://api.deepseek.example/v1"
wire_api = "responses"
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    let url = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_openai_base_url")
        .unwrap();
    assert_eq!(
        url.value.as_deref(),
        Some("https://api.deepseek.example/v1")
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
                values: BTreeMap::from([(
                    "codex_openai_base_url".to_string(),
                    Some("https://new.example/v1".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        config["model_providers"]["deepseek"]["base_url"].as_str(),
        Some("https://new.example/v1")
    );
    assert!(config.get("openai_base_url").is_none());
    assert!(config.get("api_base_url").is_none());
}

#[tokio::test]
async fn clearing_codex_api_url_removes_the_active_provider_table_value() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "deepseek-v4-flash"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek Gateway"
base_url = "https://api.deepseek.example/v1"
wire_api = "responses"
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
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
                values: BTreeMap::from([("codex_openai_base_url".to_string(), None)]),
            },
            false,
        )
        .await
        .unwrap();
    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    // 清空后表内旧值一并移除，刷新不会回显旧端点。
    assert!(
        config["model_providers"]["deepseek"]
            .get("base_url")
            .is_none()
    );
    assert!(config.get("openai_base_url").is_none());
    assert!(config.get("api_base_url").is_none());
}

#[tokio::test]
async fn codex_websockets_reads_custom_provider_default_false() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol"
model_provider = "vibex"

[model_providers.vibex]
name = "vibex"
base_url = "https://beeapi.ai/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        .to_vec(),
    );

    let snapshot = provider.read(&codex, false).await.unwrap();
    let websockets = snapshot
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    // 自定义 provider 未声明 supports_websockets → Codex 按 serde 默认 false
    //（关闭 WebSocket），开关应显示为开启。
    assert_eq!(websockets.value.as_deref(), Some("false"));
    assert!(websockets.present);
}

#[tokio::test]
async fn codex_websockets_reads_effective_support_by_provider_kind() {
    let codex = AgentId::parse("codex").unwrap();

    // 未指定 provider → 默认 openai，支持 WebSocket（开关关闭）。
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol""#.to_vec(),
    );
    let snapshot = provider.read(&codex, false).await.unwrap();
    let websockets = snapshot
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("true"));

    // openai 内置硬编码支持 WebSocket，配置表无法覆盖。
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol"
model_provider = "openai"

[model_providers.openai]
name = "OpenAI Override"
supports_websockets = false
"#
        .to_vec(),
    );
    let snapshot = provider.read(&codex, false).await.unwrap();
    let websockets = snapshot
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("true"));

    // ollama 内置不支持 WebSocket → 开关显示为开启。
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol"
model_provider = "ollama"
"#
        .to_vec(),
    );
    let snapshot = provider.read(&codex, false).await.unwrap();
    let websockets = snapshot
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("false"));
}

#[tokio::test]
async fn codex_websockets_writes_active_custom_provider_and_legacy_features() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol"
model_provider = "vibex"

[model_providers.vibex]
name = "vibex"
base_url = "https://beeapi.ai/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    let websockets = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("false"));
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
                values: BTreeMap::from([(
                    "codex_responses_websockets".to_string(),
                    Some("true".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();

    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    // 开启 WebSocket：写进活跃自定义 provider 表，并同步 legacy features 键。
    assert_eq!(
        config["model_providers"]["vibex"]["supports_websockets"].as_bool(),
        Some(true)
    );
    assert_eq!(
        config["features"]["responses_websockets_v2"].as_bool(),
        Some(true)
    );

    // 基于写入后的快照再次保存 false，验证冲突检测与新的来源节点一致。
    let after_enable = provider.read(&codex, false).await.unwrap();
    let websockets = after_enable
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("true"));
    let revisions = after_enable
        .fields
        .iter()
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: revisions,
                values: BTreeMap::from([(
                    "codex_responses_websockets".to_string(),
                    Some("false".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();

    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        config["model_providers"]["vibex"]["supports_websockets"].as_bool(),
        Some(false)
    );
    assert_eq!(
        config["features"]["responses_websockets_v2"].as_bool(),
        Some(false)
    );

    // 清空开关：同时移除 provider 表与 legacy features 键。
    let after_disable = provider.read(&codex, false).await.unwrap();
    let revisions = after_disable
        .fields
        .iter()
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: revisions,
                values: BTreeMap::from([("codex_responses_websockets".to_string(), None)]),
            },
            false,
        )
        .await
        .unwrap();

    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        config["model_providers"]["vibex"]
            .get("supports_websockets")
            .is_none()
    );
    assert!(
        config
            .get("features")
            .and_then(|features| features.get("responses_websockets_v2"))
            .is_none()
    );
}

#[tokio::test]
async fn codex_websockets_write_to_reserved_provider_is_ignored() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-5.6-sol"
model_provider = "ollama"

[model_providers.ollama]
name = "Local OSS"
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    let websockets = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_responses_websockets")
        .unwrap();
    assert_eq!(websockets.value.as_deref(), Some("false"));
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
                values: BTreeMap::from([(
                    "codex_responses_websockets".to_string(),
                    Some("false".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();

    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    // 内置 provider 的表由 Codex 引擎管理：写入只落到 legacy features 键，
    // 不会给 reserved 表凭空增加 supports_websockets。
    assert_eq!(
        config["features"]["responses_websockets_v2"].as_bool(),
        Some(false)
    );
    assert!(
        config["model_providers"]["ollama"]
            .get("supports_websockets")
            .is_none()
    );
}

#[tokio::test]
async fn codex_api_url_falls_back_to_top_level_base_url_keys_and_writes_them_back() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.codex/config.toml"),
        br#"model = "gpt-custom"
api_base_url = "https://gateway.example/v1"
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    let url = initial
        .fields
        .iter()
        .find(|field| field.field_id == "codex_openai_base_url")
        .unwrap();
    assert_eq!(url.value.as_deref(), Some("https://gateway.example/v1"));
    assert!(url.present);

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
                values: BTreeMap::from([(
                    "codex_openai_base_url".to_string(),
                    Some("https://new-gateway.example/v1".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let config: toml::Value = toml::from_str(
        &String::from_utf8(
            filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.codex/config.toml")]
                .clone(),
        )
        .unwrap(),
    )
    .unwrap();
    // 原值来自 api_base_url，保存后仍写回 api_base_url 而非 openai_base_url。
    assert_eq!(
        config["api_base_url"].as_str(),
        Some("https://new-gateway.example/v1")
    );
    assert!(config.get("openai_base_url").is_none());
}

#[tokio::test]
async fn advanced_codeg_parity_fields_write_their_native_shapes() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));

    let claude = AgentId::parse("claude_code").unwrap();
    let claude_initial = provider.read(&claude, false).await.unwrap();
    provider
        .save(
            &claude,
            NativeConfigPatch {
                base_field_revisions: claude_initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "sonnet_model".to_string(),
                        Some("gateway/sonnet".to_string()),
                    ),
                    ("opus_model".to_string(), Some("gateway/opus".to_string())),
                    (
                        "claude_disable_nonessential_traffic".to_string(),
                        Some("1".to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();
    let claude_settings: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.claude/settings.json")],
    )
    .unwrap();
    assert_eq!(
        claude_settings["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"],
        "gateway/sonnet"
    );
    assert_eq!(
        claude_settings["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"],
        "gateway/opus"
    );
    assert_eq!(
        claude_settings["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
        "1"
    );

    let grok = AgentId::parse("grok").unwrap();
    let grok_initial = provider.read(&grok, false).await.unwrap();
    provider
        .save(
            &grok,
            NativeConfigPatch {
                base_field_revisions: grok_initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "grok_permission".to_string(),
                        Some("acceptEdits".to_string()),
                    ),
                    (
                        "grok_api_backend".to_string(),
                        Some("responses".to_string()),
                    ),
                    (
                        "grok_auto_compact_threshold".to_string(),
                        Some("80".to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();
    let grok_config = String::from_utf8(
        filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.grok/config.toml")].clone(),
    )
    .unwrap();
    let grok_config: toml::Value = toml::from_str(&grok_config).unwrap();
    assert_eq!(
        grok_config["ui"]["permission_mode"].as_str(),
        Some("acceptEdits")
    );
    assert_eq!(
        grok_config["model"]["vibex"]["api_backend"].as_str(),
        Some("responses")
    );
    assert_eq!(
        grok_config["session"]["auto_compact_threshold_percent"].as_integer(),
        Some(80)
    );

    let pi = AgentId::parse("pi").unwrap();
    let pi_initial = provider.read(&pi, false).await.unwrap();
    provider
        .save(
            &pi,
            NativeConfigPatch {
                base_field_revisions: pi_initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "pi_custom_providers".to_string(),
                    Some(r#"{"local":{"baseUrl":"http://localhost:11434"}}"#.to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let pi_models: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.pi/agent/models.json")],
    )
    .unwrap();
    assert_eq!(
        pi_models["providers"]["local"]["baseUrl"],
        "http://localhost:11434"
    );

    let antigravity = AgentId::parse("antigravity").unwrap();
    let antigravity_initial = provider.read(&antigravity, false).await.unwrap();
    provider
        .save(
            &antigravity,
            NativeConfigPatch {
                base_field_revisions: antigravity_initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "antigravity_tool_permission".to_string(),
                        Some("always-proceed".to_string()),
                    ),
                    (
                        "antigravity_agent_mode".to_string(),
                        Some("accept-edits".to_string()),
                    ),
                    (
                        "antigravity_terminal_sandbox".to_string(),
                        Some("true".to_string()),
                    ),
                    (
                        "antigravity_permissions".to_string(),
                        Some(r#"{"allow":["command(git)"]}"#.to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();
    let antigravity_cli: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()
            [&PathBuf::from("/home/user/.gemini/antigravity-cli/settings.json")],
    )
    .unwrap();
    assert_eq!(antigravity_cli["toolPermission"], "always-proceed");
    assert_eq!(antigravity_cli["agentMode"], "accept-edits");
    assert_eq!(antigravity_cli["enableTerminalSandbox"], true);
    assert_eq!(antigravity_cli["permissions"]["allow"][0], "command(git)");
}

#[tokio::test]
async fn kimi_managed_model_is_normalized_to_the_native_schema() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let kimi = AgentId::parse("kimi_code").unwrap();
    let initial = provider.read(&kimi, false).await.unwrap();

    let saved = provider
        .save(
            &kimi,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    ("kimi_interface".to_string(), Some("openai".to_string())),
                    ("kimi_model".to_string(), Some("  demo-model  ".to_string())),
                    ("kimi_context".to_string(), Some("0".to_string())),
                    (
                        "kimi_capabilities".to_string(),
                        Some(r#"["thinking", " tool_use ", "thinking", ""]"#.to_string()),
                    ),
                    (
                        "kimi_support_efforts".to_string(),
                        Some(r#"["low", " high ", "low", ""]"#.to_string()),
                    ),
                    (
                        "kimi_default_effort".to_string(),
                        Some("medium".to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();

    let path = PathBuf::from("/home/user/.kimi-code/config.toml");
    let config = String::from_utf8(filesystem.files.lock().unwrap()[&path].clone()).unwrap();
    let config: toml::Value = toml::from_str(&config).unwrap();
    assert_eq!(config["default_model"].as_str(), Some("vibex"));
    assert_eq!(
        config["models"]["vibex"]["provider"].as_str(),
        Some("vibex")
    );
    assert_eq!(
        config["models"]["vibex"]["model"].as_str(),
        Some("demo-model")
    );
    assert_eq!(
        config["models"]["vibex"]["max_context_size"].as_integer(),
        Some(262_144)
    );
    assert_eq!(
        config["models"]["vibex"]["capabilities"]
            .as_array()
            .unwrap(),
        &[
            toml::Value::String("thinking".to_string()),
            toml::Value::String("tool_use".to_string()),
        ]
    );
    assert_eq!(
        config["models"]["vibex"]["support_efforts"]
            .as_array()
            .unwrap(),
        &[
            toml::Value::String("low".to_string()),
            toml::Value::String("high".to_string()),
        ]
    );
    assert!(config["models"]["vibex"].get("default_effort").is_none());

    provider
        .save(
            &kimi,
            NativeConfigPatch {
                base_field_revisions: saved
                    .snapshot
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "kimi_default_effort".to_string(),
                    Some("high".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let config = String::from_utf8(filesystem.files.lock().unwrap()[&path].clone()).unwrap();
    let config: toml::Value = toml::from_str(&config).unwrap();
    assert_eq!(
        config["models"]["vibex"]["default_effort"].as_str(),
        Some("high")
    );
}

#[tokio::test]
async fn kimi_provider_environment_rejects_non_object_json_without_writing() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let path = PathBuf::from("/home/user/.kimi-code/config.toml");
    let original = b"unknown = \"preserve\"\n".to_vec();
    filesystem
        .files
        .lock()
        .unwrap()
        .insert(path.clone(), original.clone());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let kimi = AgentId::parse("kimi_code").unwrap();
    let initial = provider.read(&kimi, false).await.unwrap();

    let result = provider
        .save(
            &kimi,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "kimi_provider_env".to_string(),
                    Some(r#"["not", "an", "object"]"#.to_string()),
                )]),
            },
            false,
        )
        .await;

    assert!(matches!(result, Err(NativeConfigSaveError::Read(_))));
    assert_eq!(filesystem.files.lock().unwrap()[&path], original);
}

#[tokio::test]
async fn structured_json_fields_enforce_their_native_container_shapes() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));

    for (agent, field, value) in [
        ("pi", "pi_custom_providers", r#"["not-an-object"]"#),
        ("cursor", "cursor_allow_rules", r#"{"not":"an-array"}"#),
        (
            "antigravity",
            "antigravity_permissions",
            r#"["not-an-object"]"#,
        ),
    ] {
        let agent_id = AgentId::parse(agent).unwrap();
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
                    values: BTreeMap::from([(field.to_string(), Some(value.to_string()))]),
                },
                false,
            )
            .await;
        assert!(
            matches!(result, Err(NativeConfigSaveError::Read(_))),
            "{agent}.{field} accepted an incompatible JSON container"
        );
    }
    assert!(filesystem.files.lock().unwrap().is_empty());
}

#[tokio::test]
async fn codex_granular_approval_is_mutually_exclusive_with_simple_policy() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let codex = AgentId::parse("codex").unwrap();
    let path = PathBuf::from("/home/user/.codex/config.toml");
    filesystem.files.lock().unwrap().insert(
        path.clone(),
        br#"approval_policy = "on-request"
unknown_setting = "preserve-me"
"#
        .to_vec(),
    );

    let initial = provider.read(&codex, false).await.unwrap();
    provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "codex_approval_policy".to_string(),
                        Some("granular".to_string()),
                    ),
                    (
                        "codex_approval_sandbox".to_string(),
                        Some("true".to_string()),
                    ),
                    (
                        "codex_approval_rules".to_string(),
                        Some("false".to_string()),
                    ),
                    (
                        "codex_approval_skills".to_string(),
                        Some("true".to_string()),
                    ),
                    (
                        "codex_approval_permissions".to_string(),
                        Some("false".to_string()),
                    ),
                    ("codex_approval_mcp".to_string(), Some("true".to_string())),
                ]),
            },
            false,
        )
        .await
        .unwrap();

    let config = String::from_utf8(filesystem.files.lock().unwrap()[&path].clone()).unwrap();
    let config: toml::Value = toml::from_str(&config).unwrap();
    assert_eq!(config["unknown_setting"].as_str(), Some("preserve-me"));
    assert_eq!(
        config["approval_policy"]["granular"]["sandbox_approval"].as_bool(),
        Some(true)
    );
    assert_eq!(
        config["approval_policy"]["granular"]["rules"].as_bool(),
        Some(false)
    );
    assert_eq!(
        config["approval_policy"]["granular"]["skill_approval"].as_bool(),
        Some(true)
    );
    assert_eq!(
        config["approval_policy"]["granular"]["request_permissions"].as_bool(),
        Some(false)
    );
    assert_eq!(
        config["approval_policy"]["granular"]["mcp_elicitations"].as_bool(),
        Some(true)
    );

    let granular = provider.read(&codex, false).await.unwrap();
    provider
        .save(
            &codex,
            NativeConfigPatch {
                base_field_revisions: granular
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "codex_approval_policy".to_string(),
                    Some("never".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let config = String::from_utf8(filesystem.files.lock().unwrap()[&path].clone()).unwrap();
    let config: toml::Value = toml::from_str(&config).unwrap();
    assert_eq!(config["approval_policy"].as_str(), Some("never"));
}

#[tokio::test]
async fn hermes_yaml_dotenv_and_cursor_json_fields_round_trip() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let hermes = AgentId::parse("hermes").unwrap();
    let hermes_config = PathBuf::from("/home/user/.hermes/config.yaml");
    let hermes_env = PathBuf::from("/home/user/.hermes/.env");
    filesystem.files.lock().unwrap().insert(
        hermes_config.clone(),
        b"unknown:\n  preserve: true\nmodel:\n  provider: openai\n  default: old\n".to_vec(),
    );
    filesystem.files.lock().unwrap().insert(
        hermes_env.clone(),
        b"# user comment\nexport UNRELATED='value with spaces'\nOPENAI_API_KEY = \"old-key\" # provider key\n".to_vec(),
    );

    let initial = provider.read(&hermes, false).await.unwrap();
    provider
        .save(
            &hermes,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    ("hermes_model".to_string(), Some("new-model".to_string())),
                    ("hermes_openai_key".to_string(), Some("new-key".to_string())),
                ]),
            },
            false,
        )
        .await
        .unwrap();
    let yaml: serde_yaml::Value = serde_yaml::from_slice(
        filesystem
            .files
            .lock()
            .unwrap()
            .get(&hermes_config)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(yaml["model"]["default"].as_str(), Some("new-model"));
    assert_eq!(yaml["unknown"]["preserve"].as_bool(), Some(true));
    let env = String::from_utf8(
        filesystem
            .files
            .lock()
            .unwrap()
            .get(&hermes_env)
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert!(env.contains("# user comment"));
    assert!(env.contains("export UNRELATED='value with spaces'"));
    assert!(env.contains("OPENAI_API_KEY = \"new-key\" # provider key"));

    let cursor = AgentId::parse("cursor").unwrap();
    let cursor_initial = provider.read(&cursor, false).await.unwrap();
    provider
        .save(
            &cursor,
            NativeConfigPatch {
                base_field_revisions: cursor_initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "cursor_allow_rules".to_string(),
                    Some(r#"["Shell(git status)", "Read"]"#.to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let cursor_config: serde_json::Value = serde_json::from_slice(
        filesystem
            .files
            .lock()
            .unwrap()
            .get(&PathBuf::from("/home/user/.cursor/cli-config.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(cursor_config["permissions"]["allow"][1], "Read");
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

#[tokio::test]
async fn codebuddy_routes_private_and_hosted_environments_exclusively() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let agent_id = AgentId::parse("codebuddy").unwrap();
    let initial = provider.read(&agent_id, false).await.unwrap();

    let private = provider
        .save(
            &agent_id,
            NativeConfigPatch {
                base_field_revisions: initial
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([
                    (
                        "codebuddy_environment".to_string(),
                        Some("self_hosted".to_string()),
                    ),
                    (
                        "codebuddy_base_url".to_string(),
                        Some("https://codebuddy.example".to_string()),
                    ),
                ]),
            },
            false,
        )
        .await
        .unwrap();
    let env_path = PathBuf::from("/home/user/.codebuddy/.env");
    let private_env =
        String::from_utf8(filesystem.files.lock().unwrap()[&env_path].clone()).unwrap();
    assert!(private_env.contains("CODEBUDDY_BASE_URL="));
    assert!(private_env.contains("https://codebuddy.example"));
    assert!(!private_env.contains("CODEBUDDY_INTERNET_ENVIRONMENT"));

    provider
        .save(
            &agent_id,
            NativeConfigPatch {
                base_field_revisions: private
                    .snapshot
                    .fields
                    .iter()
                    .map(|field| (field.field_id.clone(), field.revision.clone()))
                    .collect(),
                values: BTreeMap::from([(
                    "codebuddy_environment".to_string(),
                    Some("internal".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let hosted_env =
        String::from_utf8(filesystem.files.lock().unwrap()[&env_path].clone()).unwrap();
    assert!(hosted_env.contains("CODEBUDDY_INTERNET_ENVIRONMENT="));
    assert!(hosted_env.contains("internal"));
    assert!(!hosted_env.contains("CODEBUDDY_BASE_URL"));
}

#[tokio::test]
async fn claude_api_key_reads_and_writes_the_auth_token_source() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let claude = AgentId::parse("claude_code").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.claude/settings.json"),
        br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-bearer","ANTHROPIC_MODEL":"sonnet"}}"#.to_vec(),
    );

    let initial = provider.read(&claude, false).await.unwrap();
    let key = initial
        .fields
        .iter()
        .find(|field| field.field_id == "anthropic_api_key")
        .unwrap();
    assert!(key.secret);
    assert!(key.present);
    assert_eq!(key.masked_value.as_deref(), Some("••••••••"));

    // 保存新 key：写回原来源 AUTH_TOKEN，不残留 API_KEY，未知字段保留。
    let revisions = initial
        .fields
        .iter()
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    provider
        .save(
            &claude,
            NativeConfigPatch {
                base_field_revisions: revisions,
                values: BTreeMap::from([(
                    "anthropic_api_key".to_string(),
                    Some("sk-new".to_string()),
                )]),
            },
            false,
        )
        .await
        .unwrap();
    let settings: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.claude/settings.json")],
    )
    .unwrap();
    assert_eq!(settings["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-new");
    assert!(settings["env"].get("ANTHROPIC_API_KEY").is_none());
    assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "sonnet");
}

#[tokio::test]
async fn clearing_claude_api_key_removes_both_credential_keys() {
    let filesystem = Arc::new(MemoryNativeFileSystem::default());
    let provider = NativeConfigProvider::bundled(filesystem.clone(), PathBuf::from("/home/user"));
    let claude = AgentId::parse("claude_code").unwrap();
    filesystem.files.lock().unwrap().insert(
        PathBuf::from("/home/user/.claude/settings.json"),
        br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-bearer","ANTHROPIC_API_KEY":"sk-legacy"}}"#.to_vec(),
    );

    let initial = provider.read(&claude, false).await.unwrap();
    let revisions = initial
        .fields
        .iter()
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    provider
        .save(
            &claude,
            NativeConfigPatch {
                base_field_revisions: revisions,
                values: BTreeMap::from([("anthropic_api_key".to_string(), None)]),
            },
            false,
        )
        .await
        .unwrap();
    let settings: serde_json::Value = serde_json::from_slice(
        &filesystem.files.lock().unwrap()[&PathBuf::from("/home/user/.claude/settings.json")],
    )
    .unwrap();
    // 清空时两个凭据键都移除，刷新后不会因残留旧键再次显示已配置。
    assert!(settings["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    assert!(settings["env"].get("ANTHROPIC_API_KEY").is_none());
}
