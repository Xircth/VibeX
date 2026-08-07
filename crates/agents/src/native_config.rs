//! Profile-bound native configuration editing.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use api_types::{AgentAuthenticationStatus, AgentId};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::{
    AuthenticationPrecedence, BuiltInProfileCatalog, NativeConfigBinding, NativeConfigField,
    NativeConfigFieldKind, NativeConfigFormat, NativeFileMutation, NativeFileSystem,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigFieldSnapshot {
    pub field_id: String,
    pub label: String,
    pub description: String,
    pub kind: NativeConfigFieldKind,
    pub options: Vec<(String, String)>,
    pub secret: bool,
    pub path: PathBuf,
    pub present: bool,
    pub value: Option<String>,
    pub masked_value: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigFileSnapshot {
    pub path: PathBuf,
    pub format: NativeConfigFormat,
    pub content: String,
    pub sensitive: bool,
    pub exists: bool,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigSnapshot {
    pub agent_id: AgentId,
    /// Retained as the primary path for callers that only need one location.
    pub path: PathBuf,
    pub paths: Vec<PathBuf>,
    pub exists: bool,
    pub fields: Vec<NativeConfigFieldSnapshot>,
    pub files: Vec<NativeConfigFileSnapshot>,
    pub authentication: AgentAuthenticationStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigPatch {
    pub base_field_revisions: BTreeMap<String, String>,
    pub values: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigFilePatch {
    pub path: PathBuf,
    pub base_revision: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigApplyEffect {
    NextSessionOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigSaveResult {
    pub snapshot: NativeConfigSnapshot,
    pub effect: ConfigApplyEffect,
}

#[derive(Debug, thiserror::Error)]
pub enum NativeConfigError {
    #[error("Agent {0} has no supported native configuration profile")]
    Unsupported(AgentId),
    #[error("native configuration filesystem error: {0}")]
    FileSystem(String),
    #[error("native configuration is invalid: {0}")]
    Invalid(String),
}

#[derive(Debug, thiserror::Error)]
pub enum NativeConfigSaveError {
    #[error(transparent)]
    Read(#[from] NativeConfigError),
    #[error("native configuration fields changed externally: {fields:?}")]
    FieldConflicts { fields: Vec<String> },
    #[error("unknown native configuration field `{0}`")]
    UnknownField(String),
    #[error("unknown native configuration file `{0}`")]
    UnknownFile(PathBuf),
    #[error("sensitive native configuration file `{0}` must use structured credential fields")]
    SensitiveFile(PathBuf),
    #[error("native configuration file changed externally: `{path}`")]
    FileConflict { path: PathBuf },
}

pub struct NativeConfigProvider {
    filesystem: Arc<dyn NativeFileSystem>,
    home: PathBuf,
    environment: BTreeMap<String, String>,
    profiles: BuiltInProfileCatalog,
}

impl NativeConfigProvider {
    pub fn bundled(filesystem: Arc<dyn NativeFileSystem>, home: PathBuf) -> Self {
        Self::with_environment(filesystem, home, BTreeMap::new())
    }

    pub fn with_environment(
        filesystem: Arc<dyn NativeFileSystem>,
        home: PathBuf,
        environment: BTreeMap<String, String>,
    ) -> Self {
        Self {
            filesystem,
            home,
            environment,
            profiles: BuiltInProfileCatalog::bundled(),
        }
    }

    pub async fn read(
        &self,
        agent_id: &AgentId,
        account_logged_in: bool,
    ) -> Result<NativeConfigSnapshot, NativeConfigError> {
        let profile = self.profile(agent_id)?;
        let mut paths = Vec::with_capacity(profile.native_config.len());
        let mut fields = Vec::new();
        let mut files = Vec::with_capacity(profile.native_config.len());
        let mut exists = false;

        for binding in profile.native_config {
            let path = self.binding_path(binding);
            let bytes = self
                .filesystem
                .read(&path)
                .await
                .map_err(|error| NativeConfigError::FileSystem(error.to_string()))?;
            let file_exists = bytes.is_some();
            exists |= file_exists;
            let document = parse_document(binding, bytes.as_deref())?;
            let content = match bytes.as_deref() {
                Some(bytes) => std::str::from_utf8(bytes)
                    .map(str::to_owned)
                    .map_err(|error| NativeConfigError::Invalid(error.to_string()))?,
                None => empty_document_preview(binding.format).to_string(),
            };
            fields.extend(
                binding
                    .fields
                    .iter()
                    .map(|field| field_snapshot(field, &document, path.clone())),
            );
            files.push(NativeConfigFileSnapshot {
                path: path.clone(),
                format: binding.format,
                content,
                sensitive: binding
                    .fields
                    .iter()
                    .any(|field| field.kind == NativeConfigFieldKind::Secret),
                exists: file_exists,
                revision: file_revision(bytes.as_deref()),
            });
            paths.push(path);
        }

        let api_key_present = fields.iter().any(|field| field.secret && field.present);
        Ok(NativeConfigSnapshot {
            agent_id: agent_id.clone(),
            path: paths.first().cloned().unwrap_or_else(|| self.home.clone()),
            paths,
            exists,
            fields,
            files,
            authentication: authentication_status(
                profile.authentication_precedence,
                account_logged_in,
                api_key_present,
            ),
        })
    }

    pub async fn save(
        &self,
        agent_id: &AgentId,
        patch: NativeConfigPatch,
        account_logged_in: bool,
    ) -> Result<NativeConfigSaveResult, NativeConfigSaveError> {
        let profile = self.profile(agent_id)?;
        let mut documents = Vec::new();

        // Read and validate every affected file before writing any file. This
        // prevents stale-field conflicts from producing a partial update.
        for binding in profile.native_config {
            if !patch.values.keys().any(|field_id| {
                binding
                    .fields
                    .iter()
                    .any(|field| field.field_id == field_id)
            }) {
                continue;
            }
            let path = self.binding_path(binding);
            let bytes = self
                .filesystem
                .read(&path)
                .await
                .map_err(|error| NativeConfigError::FileSystem(error.to_string()))?;
            let document = parse_document(binding, bytes.as_deref())?;
            documents.push((binding, path, bytes, document));
        }

        for field_id in patch.values.keys() {
            if !profile
                .native_config
                .iter()
                .flat_map(|binding| binding.fields.iter())
                .any(|field| field.field_id == field_id)
            {
                return Err(NativeConfigSaveError::UnknownField(field_id.clone()));
            }
        }

        let mut conflicts = Vec::new();
        for (binding, _, _, document) in &documents {
            for field in binding
                .fields
                .iter()
                .filter(|field| patch.values.contains_key(field.field_id))
            {
                let current_revision = if field.field_id == "codex_openai_base_url" {
                    field_revision(codex_base_url_value(document))
                } else if field.field_id == "anthropic_api_key" {
                    field_revision(claude_credential_value(document))
                } else {
                    field_revision(value_at_path(document, field.path))
                };
                if patch
                    .base_field_revisions
                    .get(field.field_id)
                    .is_none_or(|base| base != &current_revision)
                {
                    conflicts.push(field.field_id.to_string());
                }
            }
        }
        if !conflicts.is_empty() {
            return Err(NativeConfigSaveError::FieldConflicts { fields: conflicts });
        }

        let mut writes = Vec::with_capacity(documents.len());
        for (binding, path, original, document) in &mut documents {
            prepare_special_native_shape(document, &patch)?;
            for field in binding
                .fields
                .iter()
                .filter(|field| patch.values.contains_key(field.field_id))
            {
                match patch.values.get(field.field_id).cloned().flatten() {
                    Some(value) => {
                        if field.field_id == "codex_approval_policy" && value == "granular" {
                            continue;
                        }
                        if field.field_id == "codebuddy_environment"
                            && matches!(value.as_str(), "overseas" | "self_hosted")
                        {
                            continue;
                        }
                        if field.field_id == "codex_openai_base_url"
                            || field.field_id == "anthropic_api_key"
                        {
                            // 延迟到 finalize_*_shape：写回位置取决于原始配置
                            // （Codex 活跃表 / 顶层键；Claude AUTH_TOKEN /
                            // API_KEY），此处保留原始文档以便判断来源。
                            continue;
                        }
                        let value = parse_field_value(field, &value)?;
                        set_value_at_path(document, field.path, value)?;
                        if let Some((key, value)) = field.object_discriminator {
                            set_discriminator(document, field.path, key, value)?;
                        }
                    }
                    None => remove_value_at_path(document, field.path),
                }
            }
            finalize_special_native_shape(document, &patch)?;
            let bytes = if binding.format == NativeConfigFormat::Dotenv {
                serialize_dotenv_preserving(original.as_deref(), binding, document, &patch)?
            } else {
                serialize_document(binding, document)?
            };
            writes.push(NativeFileMutation {
                path: path.clone(),
                expected: original.clone(),
                replacement: Some(bytes),
                sensitive: binding
                    .fields
                    .iter()
                    .any(|field| field.kind == NativeConfigFieldKind::Secret),
            });
        }
        self.filesystem
            .apply_many_atomic(&writes)
            .await
            .map_err(|error| NativeConfigError::FileSystem(error.to_string()))?;

        let snapshot = self.read(agent_id, account_logged_in).await?;
        Ok(NativeConfigSaveResult {
            snapshot,
            effect: ConfigApplyEffect::NextSessionOnly,
        })
    }

    pub async fn save_file(
        &self,
        agent_id: &AgentId,
        patch: NativeConfigFilePatch,
        account_logged_in: bool,
    ) -> Result<NativeConfigSaveResult, NativeConfigSaveError> {
        let profile = self.profile(agent_id)?;
        let Some(binding) = profile
            .native_config
            .iter()
            .find(|binding| self.binding_path(binding) == patch.path)
        else {
            return Err(NativeConfigSaveError::UnknownFile(patch.path));
        };
        if binding
            .fields
            .iter()
            .any(|field| field.kind == NativeConfigFieldKind::Secret)
        {
            return Err(NativeConfigSaveError::SensitiveFile(patch.path));
        }

        let path = patch.path;
        let current = self
            .filesystem
            .read(&path)
            .await
            .map_err(|error| NativeConfigError::FileSystem(error.to_string()))?;
        if file_revision(current.as_deref()) != patch.base_revision {
            return Err(NativeConfigSaveError::FileConflict { path });
        }

        let replacement = patch.content.into_bytes();
        if replacement.len() > 1024 * 1024 {
            return Err(NativeConfigError::Invalid(
                "native configuration file exceeds the 1 MiB editor limit".to_string(),
            )
            .into());
        }
        parse_document(binding, Some(&replacement))?;
        if let Err(error) = self
            .filesystem
            .apply_many_atomic(&[NativeFileMutation {
                path: path.clone(),
                expected: current,
                replacement: Some(replacement),
                sensitive: false,
            }])
            .await
        {
            if error.to_string().contains("changed on disk") {
                return Err(NativeConfigSaveError::FileConflict { path });
            }
            return Err(NativeConfigError::FileSystem(error.to_string()).into());
        }

        Ok(NativeConfigSaveResult {
            snapshot: self.read(agent_id, account_logged_in).await?,
            effect: ConfigApplyEffect::NextSessionOnly,
        })
    }

    fn profile(&self, agent_id: &AgentId) -> Result<&crate::BuiltInProfile, NativeConfigError> {
        self.profiles
            .profile(agent_id)
            .filter(|profile| !profile.native_config.is_empty())
            .ok_or_else(|| NativeConfigError::Unsupported(agent_id.clone()))
    }

    fn binding_path(&self, binding: &NativeConfigBinding) -> PathBuf {
        let override_directory = binding
            .directory_override_env
            .and_then(|name| {
                self.environment
                    .get(name)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| PathBuf::from(value.trim()))
                    .or_else(|| {
                        std::env::var_os(name)
                            .filter(|value| !value.is_empty())
                            .map(PathBuf::from)
                    })
            })
            .map(|directory| expand_home_path(&self.home, directory));
        override_directory
            .map(|directory| directory.join(binding.override_relative_path))
            .unwrap_or_else(|| self.home.join(binding.home_relative_path))
    }
}

fn expand_home_path(home: &std::path::Path, path: PathBuf) -> PathBuf {
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

const fn empty_document_preview(format: NativeConfigFormat) -> &'static str {
    match format {
        NativeConfigFormat::Json => "{}",
        NativeConfigFormat::Toml => "",
        NativeConfigFormat::Yaml => "{}\n",
        NativeConfigFormat::Dotenv => "",
    }
}

fn parse_document(
    binding: &NativeConfigBinding,
    bytes: Option<&[u8]>,
) -> Result<Value, NativeConfigError> {
    let Some(bytes) = bytes else {
        return Ok(Value::Object(Map::new()));
    };
    let value = match binding.format {
        NativeConfigFormat::Json => serde_json::from_slice(bytes)
            .map_err(|error| NativeConfigError::Invalid(error.to_string()))?,
        NativeConfigFormat::Toml => {
            let text = std::str::from_utf8(bytes)
                .map_err(|error| NativeConfigError::Invalid(error.to_string()))?;
            let value: toml::Value = toml::from_str(text)
                .map_err(|error| NativeConfigError::Invalid(error.to_string()))?;
            serde_json::to_value(value)
                .map_err(|error| NativeConfigError::Invalid(error.to_string()))?
        }
        NativeConfigFormat::Yaml => serde_yaml::from_slice(bytes)
            .map_err(|error| NativeConfigError::Invalid(error.to_string()))?,
        NativeConfigFormat::Dotenv => parse_dotenv(bytes)?,
    };
    if value.is_object() {
        Ok(value)
    } else {
        Err(NativeConfigError::Invalid(
            "top-level value must be an object".to_string(),
        ))
    }
}

fn serialize_document(
    binding: &NativeConfigBinding,
    document: &Value,
) -> Result<Vec<u8>, NativeConfigError> {
    match binding.format {
        NativeConfigFormat::Json => serde_json::to_vec_pretty(document)
            .map_err(|error| NativeConfigError::Invalid(error.to_string())),
        NativeConfigFormat::Toml => {
            let value: toml::Value = serde_json::from_value(document.clone())
                .map_err(|error| NativeConfigError::Invalid(error.to_string()))?;
            toml::to_string_pretty(&value)
                .map(String::into_bytes)
                .map_err(|error| NativeConfigError::Invalid(error.to_string()))
        }
        NativeConfigFormat::Yaml => serde_yaml::to_string(document)
            .map(String::into_bytes)
            .map_err(|error| NativeConfigError::Invalid(error.to_string())),
        NativeConfigFormat::Dotenv => serialize_dotenv(document),
    }
}

fn field_snapshot(
    field: &NativeConfigField,
    document: &Value,
    path: PathBuf,
) -> NativeConfigFieldSnapshot {
    let raw = value_at_path(document, field.path);
    let (value, revision_source) = if field.field_id == "codebuddy_environment" {
        if value_at_path(document, &["CODEBUDDY_BASE_URL"])
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            (Some("self_hosted".to_string()), raw)
        } else {
            (
                scalar_string(raw).or_else(|| Some("overseas".to_string())),
                raw,
            )
        }
    } else if field.field_id == "codex_approval_policy"
        && raw
            .and_then(|value| value.get("granular"))
            .is_some_and(Value::is_object)
    {
        (Some("granular".to_string()), raw)
    } else if field.field_id == "codex_openai_base_url" {
        // Codex 的端点可能位于顶层 `openai_base_url`、兼容键 `api_base_url`
        // 或活跃 `[model_providers.<id>].base_url`；无论来自哪里都投影到
        // 同一个 `API URL` 字段展示，让用户看到正在使用的端点。
        let effective = codex_base_url_value(document);
        (scalar_string(effective), effective)
    } else if field.field_id == "anthropic_api_key" {
        // Claude Code 的凭据可能位于 `env.ANTHROPIC_AUTH_TOKEN`（优先）或
        // `env.ANTHROPIC_API_KEY`；secret 字段不返回明文，但 present 与
        // revision 必须反映实际生效的凭据来源。
        let effective = claude_credential_value(document);
        (scalar_string(effective), effective)
    } else {
        (scalar_string(raw), raw)
    };
    let present = value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let secret = field.kind == NativeConfigFieldKind::Secret;
    NativeConfigFieldSnapshot {
        field_id: field.field_id.to_string(),
        label: field.label.to_string(),
        description: field.description.to_string(),
        kind: field.kind,
        options: field
            .options
            .iter()
            .map(|(value, label)| ((*value).to_string(), (*label).to_string()))
            .collect(),
        secret,
        path,
        present,
        value: (!secret).then_some(value).flatten(),
        masked_value: (secret && present).then(|| "••••••••".to_string()),
        revision: field_revision(revision_source),
    }
}

/// Codex 当前活跃的 `model_provider` 标识（顶层 `model_provider` 键）。
fn codex_active_provider(document: &Value) -> Option<&str> {
    document
        .get("model_provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Claude Code 凭据字段的有效来源：Claude Code 优先使用
/// `env.ANTHROPIC_AUTH_TOKEN`（Bearer token），其次是 `env.ANTHROPIC_API_KEY`。
fn claude_credential_value(document: &Value) -> Option<&Value> {
    value_at_path(document, &["env", "ANTHROPIC_AUTH_TOKEN"])
        .or_else(|| value_at_path(document, &["env", "ANTHROPIC_API_KEY"]))
}

/// Codex 端点字段的有效来源：活跃 `[model_providers.<id>].base_url`，
/// 其次顶层 `openai_base_url`，最后兼容键 `api_base_url`。
fn codex_base_url_value(document: &Value) -> Option<&Value> {
    if let Some(provider) = codex_active_provider(document)
        && let Some(url) = document
            .get("model_providers")
            .and_then(|table| table.get(provider))
            .and_then(|entry| entry.get("base_url"))
    {
        return Some(url);
    }
    value_at_path(document, &["openai_base_url"])
        .or_else(|| value_at_path(document, &["api_base_url"]))
}

fn prepare_special_native_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    if patch
        .values
        .get("openai_api_key")
        .and_then(|value| value.as_deref())
        .is_some_and(|value| !value.trim().is_empty())
    {
        remove_value_at_path(document, &["auth_mode"]);
    }
    prepare_codebuddy_shape(document, patch)?;
    let granular_selected = patch
        .values
        .get("codex_approval_policy")
        .and_then(|value| value.as_deref())
        == Some("granular");
    if !granular_selected {
        return Ok(());
    }

    set_value_at_path(
        document,
        &["approval_policy"],
        serde_json::json!({
            "granular": {
                "sandbox_approval": true,
                "rules": true,
                "skill_approval": true,
                "request_permissions": true,
                "mcp_elicitations": true
            }
        }),
    )
}

fn finalize_special_native_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    validate_object_field(document, patch, "opencode_providers", &["provider"])?;
    validate_object_field(document, patch, "pi_custom_providers", &["providers"])?;
    finalize_claude_shape(document, patch)?;
    finalize_codex_shape(document, patch)?;
    finalize_grok_shape(document, patch)?;
    finalize_cursor_shape(document, patch)?;
    finalize_kimi_shape(document, patch)
}

fn validate_object_field(
    document: &Value,
    patch: &NativeConfigPatch,
    field_id: &str,
    path: &[&str],
) -> Result<(), NativeConfigError> {
    if !patch.values.contains_key(field_id) {
        return Ok(());
    }
    if value_at_path(document, path).is_some_and(|value| !value.is_object()) {
        return Err(NativeConfigError::Invalid(format!(
            "{field_id} must be a JSON object"
        )));
    }
    Ok(())
}

fn finalize_codex_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    if patch.values.contains_key("codex_writable_roots")
        && let Some(value) = value_at_path(document, &["sandbox_workspace_write", "writable_roots"])
    {
        let roots = value.as_array().ok_or_else(|| {
            NativeConfigError::Invalid(
                "codex_writable_roots must be a JSON string array".to_string(),
            )
        })?;
        let mut normalized = Vec::new();
        for root in roots {
            let root = root.as_str().ok_or_else(|| {
                NativeConfigError::Invalid(
                    "codex_writable_roots must be a JSON string array".to_string(),
                )
            })?;
            let root = root.trim();
            if root.is_empty() {
                continue;
            }
            if !is_portable_absolute_path(root) {
                return Err(NativeConfigError::Invalid(format!(
                    "codex writable_roots entries must be absolute paths: {root}"
                )));
            }
            if !normalized.iter().any(|existing| existing == root) {
                normalized.push(root.to_string());
            }
        }
        if normalized.is_empty() {
            remove_value_at_path(document, &["sandbox_workspace_write", "writable_roots"]);
        } else {
            set_value_at_path(
                document,
                &["sandbox_workspace_write", "writable_roots"],
                Value::Array(normalized.into_iter().map(Value::String).collect()),
            )?;
        }
    }
    if patch.values.contains_key("codex_openai_base_url") {
        // 字段写循环跳过该字段，因此这里读到的是原始文档。按 Codex 实际读取
        // 的位置归位：活跃 `[model_providers.<id>]` 表存在时写回表 `base_url`；
        // 否则跟随原始键（openai_base_url 优先，其次 api_base_url）。
        let had_openai = value_at_path(document, &["openai_base_url"]).is_some();
        let had_api = value_at_path(document, &["api_base_url"]).is_some();
        let new_value = patch.values.get("codex_openai_base_url").cloned().flatten();
        remove_value_at_path(document, &["openai_base_url"]);
        remove_value_at_path(document, &["api_base_url"]);
        let active_provider = codex_active_provider(document).map(str::to_owned);
        if let Some(provider) = active_provider {
            let path = ["model_providers", provider.as_str(), "base_url"];
            if let Some(value) = new_value {
                set_value_at_path(document, &path, Value::String(value))?;
            } else {
                // 用户清空端点时，同时移除表内旧值，避免刷新后仍显示旧端点。
                remove_value_at_path(document, &path);
            }
        } else if let Some(value) = new_value {
            let target = if had_openai {
                "openai_base_url"
            } else if had_api {
                "api_base_url"
            } else {
                "openai_base_url"
            };
            set_value_at_path(document, &[target], Value::String(value))?;
        }
    }
    Ok(())
}

fn is_portable_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
        || (value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .get(2)
                .is_some_and(|separator| matches!(separator, b'/' | b'\\'))
            && value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic))
}

/// Claude Code 凭据字段写回：字段写循环跳过该字段，因此这里读到的是原始
/// 文档。新值写回实际生效的位置（原 `ANTHROPIC_AUTH_TOKEN` 存在则写它，
/// 否则 `ANTHROPIC_API_KEY`），替换/清空时移除两个键，保证单一来源且清空
/// 真正生效（否则被另一个键残留遮挡）。
fn finalize_claude_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    if !patch.values.contains_key("anthropic_api_key") {
        return Ok(());
    }
    let had_token = value_at_path(document, &["env", "ANTHROPIC_AUTH_TOKEN"]).is_some();
    let new_value = patch.values.get("anthropic_api_key").cloned().flatten();
    if let Some(env) = document.get_mut("env").and_then(Value::as_object_mut) {
        env.remove("ANTHROPIC_API_KEY");
        env.remove("ANTHROPIC_AUTH_TOKEN");
    }
    if let Some(value) = new_value {
        let target = if had_token {
            "ANTHROPIC_AUTH_TOKEN"
        } else {
            "ANTHROPIC_API_KEY"
        };
        let path = ["env", target];
        set_value_at_path(document, &path, Value::String(value))?;
    }
    Ok(())
}

fn finalize_grok_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    if !patch.values.keys().any(|field| field.starts_with("grok_")) {
        return Ok(());
    }
    for (field, path) in [
        ("grok_base_url", &["model", "vibex", "base_url"][..]),
        ("grok_api_key", &["model", "vibex", "api_key"][..]),
    ] {
        if value_at_path(document, path)
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains(['\n', '\r']))
        {
            return Err(NativeConfigError::Invalid(format!(
                "{field} must not contain newlines"
            )));
        }
    }
    if value_at_path(document, &["model", "vibex", "context_window"])
        .and_then(Value::as_i64)
        .is_some_and(|value| value <= 0)
    {
        remove_value_at_path(document, &["model", "vibex", "context_window"]);
    }
    let custom_model = value_at_path(document, &["model", "vibex", "model"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(custom_model) = custom_model {
        set_value_at_path(
            document,
            &["model", "vibex", "model"],
            Value::String(custom_model),
        )?;
        set_value_at_path(
            document,
            &["models", "default"],
            Value::String("vibex".to_string()),
        )?;
    } else if value_at_path(document, &["models", "default"]).and_then(Value::as_str)
        == Some("vibex")
    {
        remove_value_at_path(document, &["models", "default"]);
    }
    Ok(())
}

fn finalize_cursor_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    for (field, path) in [
        ("cursor_allow_rules", &["permissions", "allow"][..]),
        ("cursor_deny_rules", &["permissions", "deny"][..]),
    ] {
        if !patch.values.contains_key(field) {
            continue;
        }
        normalize_json_string_array(document, path, field)?;
    }
    Ok(())
}

fn normalize_json_string_array(
    document: &mut Value,
    path: &[&str],
    field_id: &str,
) -> Result<Vec<String>, NativeConfigError> {
    let Some(value) = value_at_path(document, path) else {
        return Ok(Vec::new());
    };
    let values = value.as_array().ok_or_else(|| {
        NativeConfigError::Invalid(format!("{field_id} must be a JSON string array"))
    })?;
    let mut normalized = Vec::new();
    for value in values {
        let value = value.as_str().ok_or_else(|| {
            NativeConfigError::Invalid(format!("{field_id} must be a JSON string array"))
        })?;
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.contains(['\n', '\r']) {
            return Err(NativeConfigError::Invalid(format!(
                "{field_id} entries must not contain newlines"
            )));
        }
        if !normalized.iter().any(|existing| existing == value) {
            normalized.push(value.to_string());
        }
    }
    if normalized.is_empty() {
        remove_value_at_path(document, path);
    } else {
        set_value_at_path(
            document,
            path,
            Value::Array(normalized.iter().cloned().map(Value::String).collect()),
        )?;
    }
    Ok(normalized)
}

fn finalize_kimi_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    if !patch.values.keys().any(|field| field.starts_with("kimi_")) {
        return Ok(());
    }

    for (field, path) in [
        ("kimi_base_url", &["providers", "vibex", "base_url"][..]),
        ("kimi_api_key", &["providers", "vibex", "api_key"][..]),
    ] {
        if value_at_path(document, path)
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains(['\n', '\r']))
        {
            return Err(NativeConfigError::Invalid(format!(
                "{field} must not contain newlines"
            )));
        }
    }
    if value_at_path(document, &["providers", "vibex", "env"])
        .is_some_and(|value| !value.is_object())
    {
        return Err(NativeConfigError::Invalid(
            "kimi_provider_env must be a JSON object".to_string(),
        ));
    }

    let model = value_at_path(document, &["models", "vibex", "model"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let Some(model) = model else {
        if value_at_path(document, &["default_model"]).and_then(Value::as_str) == Some("vibex") {
            remove_value_at_path(document, &["default_model"]);
        }
        return Ok(());
    };

    set_value_at_path(
        document,
        &["models", "vibex", "model"],
        Value::String(model),
    )?;
    set_value_at_path(
        document,
        &["models", "vibex", "provider"],
        Value::String("vibex".to_string()),
    )?;
    set_value_at_path(
        document,
        &["default_model"],
        Value::String("vibex".to_string()),
    )?;

    let context = value_at_path(document, &["models", "vibex", "max_context_size"])
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(262_144);
    set_value_at_path(
        document,
        &["models", "vibex", "max_context_size"],
        Value::Number(Number::from(context)),
    )?;

    normalize_kimi_string_array(document, &["models", "vibex", "capabilities"])?;
    let efforts = normalize_kimi_string_array(document, &["models", "vibex", "support_efforts"])?;
    let default_effort = value_at_path(document, &["models", "vibex", "default_effort"])
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if default_effort
        .as_ref()
        .is_some_and(|value| efforts.iter().any(|effort| effort == value))
    {
        set_value_at_path(
            document,
            &["models", "vibex", "default_effort"],
            Value::String(default_effort.expect("checked above")),
        )?;
    } else {
        remove_value_at_path(document, &["models", "vibex", "default_effort"]);
    }
    Ok(())
}

fn normalize_kimi_string_array(
    document: &mut Value,
    path: &[&str],
) -> Result<Vec<String>, NativeConfigError> {
    normalize_json_string_array(document, path, &path.join("."))
}

fn prepare_codebuddy_shape(
    document: &mut Value,
    patch: &NativeConfigPatch,
) -> Result<(), NativeConfigError> {
    let environment = patch
        .values
        .get("codebuddy_environment")
        .and_then(|value| value.as_deref());
    let base_url_patch = patch
        .values
        .get("codebuddy_base_url")
        .and_then(|value| value.as_deref())
        .map(str::trim);

    match environment {
        Some("overseas") => {
            remove_value_at_path(document, &["CODEBUDDY_INTERNET_ENVIRONMENT"]);
            remove_value_at_path(document, &["CODEBUDDY_BASE_URL"]);
        }
        Some("internal" | "ioa") => {
            remove_value_at_path(document, &["CODEBUDDY_BASE_URL"]);
        }
        Some("self_hosted") => {
            let base_url = base_url_patch
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    value_at_path(document, &["CODEBUDDY_BASE_URL"])
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .ok_or_else(|| {
                    NativeConfigError::Invalid(
                        "self-hosted CodeBuddy requires CODEBUDDY_BASE_URL".to_string(),
                    )
                })?;
            validate_codebuddy_url(base_url)?;
            remove_value_at_path(document, &["CODEBUDDY_INTERNET_ENVIRONMENT"]);
        }
        _ => {
            if let Some(base_url) = base_url_patch.filter(|value| !value.is_empty()) {
                validate_codebuddy_url(base_url)?;
                remove_value_at_path(document, &["CODEBUDDY_INTERNET_ENVIRONMENT"]);
            }
        }
    }
    Ok(())
}

fn validate_codebuddy_url(value: &str) -> Result<(), NativeConfigError> {
    let url = url::Url::parse(value).map_err(|error| {
        NativeConfigError::Invalid(format!("invalid CodeBuddy Base URL: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(NativeConfigError::Invalid(
            "CodeBuddy Base URL must be an http(s) URL without embedded credentials".to_string(),
        ));
    }
    Ok(())
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        complex @ (Value::Array(_) | Value::Object(_)) => {
            serde_json::to_string_pretty(complex).ok()
        }
        _ => None,
    }
}

fn parse_field_value(field: &NativeConfigField, value: &str) -> Result<Value, NativeConfigError> {
    match field.kind {
        NativeConfigFieldKind::Text | NativeConfigFieldKind::Secret => {
            Ok(Value::String(value.to_string()))
        }
        NativeConfigFieldKind::Select => {
            if !field.options.iter().any(|(option, _)| *option == value) {
                return Err(NativeConfigError::Invalid(format!(
                    "`{value}` is not valid for {}",
                    field.field_id
                )));
            }
            Ok(Value::String(value.to_string()))
        }
        NativeConfigFieldKind::Boolean => value
            .parse::<bool>()
            .map(Value::Bool)
            .map_err(|_| NativeConfigError::Invalid(format!("`{value}` is not a boolean"))),
        NativeConfigFieldKind::Number => value
            .parse::<i64>()
            .map(Number::from)
            .map(Value::Number)
            .map_err(|_| NativeConfigError::Invalid(format!("`{value}` is not an integer"))),
        NativeConfigFieldKind::Json => serde_json::from_str(value)
            .map_err(|error| NativeConfigError::Invalid(format!("invalid JSON: {error}"))),
    }
}

fn parse_dotenv(bytes: &[u8]) -> Result<Value, NativeConfigError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| NativeConfigError::Invalid(error.to_string()))?;
    let mut object = Map::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw_value)) = line.split_once('=') else {
            return Err(NativeConfigError::Invalid(format!(
                "invalid dotenv line {}",
                index + 1
            )));
        };
        let key = key.trim();
        if key.is_empty() || key.contains(char::is_whitespace) {
            return Err(NativeConfigError::Invalid(format!(
                "invalid dotenv key on line {}",
                index + 1
            )));
        }
        let value = raw_value.trim();
        let value = if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            &value[1..value.len() - 1]
        } else {
            value
        };
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
    Ok(Value::Object(object))
}

fn serialize_dotenv(document: &Value) -> Result<Vec<u8>, NativeConfigError> {
    let object = document.as_object().ok_or_else(|| {
        NativeConfigError::Invalid("dotenv document must be an object".to_string())
    })?;
    let mut output = String::new();
    for (key, value) in object {
        let value = value.as_str().ok_or_else(|| {
            NativeConfigError::Invalid(format!("dotenv value `{key}` must be text"))
        })?;
        if value.contains(['\n', '\r']) {
            return Err(NativeConfigError::Invalid(format!(
                "dotenv value `{key}` must not contain newlines"
            )));
        }
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        output.push_str(key);
        output.push_str("=\"");
        output.push_str(&escaped);
        output.push_str("\"\n");
    }
    Ok(output.into_bytes())
}

fn serialize_dotenv_preserving(
    original: Option<&[u8]>,
    binding: &NativeConfigBinding,
    document: &Value,
    patch: &NativeConfigPatch,
) -> Result<Vec<u8>, NativeConfigError> {
    let Some(original) = original else {
        return serialize_dotenv(document);
    };
    let text = std::str::from_utf8(original)
        .map_err(|error| NativeConfigError::Invalid(error.to_string()))?;
    let mut changed = binding
        .fields
        .iter()
        .filter(|field| patch.values.contains_key(field.field_id))
        .filter_map(|field| (field.path.len() == 1).then_some(field.path[0]))
        .collect::<std::collections::BTreeSet<_>>();
    if patch.values.contains_key("codebuddy_environment") {
        changed.insert("CODEBUDDY_BASE_URL");
    }
    if patch.values.contains_key("codebuddy_base_url") {
        changed.insert("CODEBUDDY_INTERNET_ENVIRONMENT");
    }
    let object = document.as_object().ok_or_else(|| {
        NativeConfigError::Invalid("dotenv document must be an object".to_string())
    })?;
    let mut found = std::collections::BTreeSet::new();
    let mut output = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let Some((key, equals)) = dotenv_line_key(line) else {
            output.push_str(line);
            continue;
        };
        if !changed.contains(key) {
            output.push_str(line);
            continue;
        }
        found.insert(key.to_string());
        let Some(value) = object.get(key).and_then(Value::as_str) else {
            continue;
        };
        if value.contains(['\n', '\r']) {
            return Err(NativeConfigError::Invalid(format!(
                "dotenv value `{key}` must not contain newlines"
            )));
        }
        output.push_str(&replace_dotenv_value(line, equals, value));
    }
    for key in changed {
        if found.contains(key) {
            continue;
        }
        let Some(value) = object.get(key).and_then(Value::as_str) else {
            continue;
        };
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(key);
        output.push('=');
        output.push_str(&quote_dotenv_value(value, Some('"')));
        output.push('\n');
    }
    Ok(output.into_bytes())
}

fn dotenv_line_key(line: &str) -> Option<(&str, usize)> {
    let body = line.trim_end_matches(['\r', '\n']);
    let leading = body.len() - body.trim_start().len();
    let mut candidate = &body[leading..];
    if candidate.starts_with('#') || candidate.is_empty() {
        return None;
    }
    let export_len = candidate
        .strip_prefix("export ")
        .map(|stripped| candidate.len() - stripped.len())
        .unwrap_or(0);
    candidate = &candidate[export_len..];
    let relative_equals = candidate.find('=')?;
    let key = candidate[..relative_equals].trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    Some((key, leading + export_len + relative_equals))
}

fn replace_dotenv_value(line: &str, equals: usize, value: &str) -> String {
    let newline = if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let body = line.trim_end_matches(['\r', '\n']);
    let after_equals = &body[equals + 1..];
    let leading_spaces = after_equals.len() - after_equals.trim_start().len();
    let raw_value = after_equals.trim_start();
    let quote = raw_value
        .chars()
        .next()
        .filter(|quote| matches!(quote, '\'' | '"'));
    let trailing = quote
        .and_then(|quote| raw_value[1..].find(quote).map(|index| index + 2))
        .map(|end| &raw_value[end..])
        .or_else(|| raw_value.find(" #").map(|comment| &raw_value[comment..]))
        .unwrap_or("");
    format!(
        "{}{}{}{}{}",
        &body[..equals + 1],
        &after_equals[..leading_spaces],
        quote_dotenv_value(value, quote),
        trailing,
        newline
    )
}

fn quote_dotenv_value(value: &str, preferred_quote: Option<char>) -> String {
    if preferred_quote == Some('\'') && !value.contains('\'') {
        return format!("'{value}'");
    }
    if preferred_quote.is_none()
        && !value.is_empty()
        && !value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, '#' | '\'' | '"'))
    {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn field_revision(value: Option<&Value>) -> String {
    let bytes = value
        .and_then(|value| serde_json::to_vec(value).ok())
        .unwrap_or_else(|| b"null".to_vec());
    format!("{:x}", Sha256::digest(bytes))
}

fn file_revision(bytes: Option<&[u8]>) -> String {
    let mut digest = Sha256::new();
    match bytes {
        Some(bytes) => {
            digest.update([1]);
            digest.update(bytes);
        }
        None => digest.update([0]),
    }
    format!("{:x}", digest.finalize())
}

fn value_at_path<'a>(document: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(document, |current, segment| current.get(*segment))
}

fn set_value_at_path(
    document: &mut Value,
    path: &[&str],
    value: Value,
) -> Result<(), NativeConfigError> {
    let Some((last, parents)) = path.split_last() else {
        return Err(NativeConfigError::Invalid(
            "field path is empty".to_string(),
        ));
    };
    let mut current = document;
    for segment in parents {
        let object = current.as_object_mut().ok_or_else(|| {
            NativeConfigError::Invalid(format!("field parent `{segment}` is not an object"))
        })?;
        current = object
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current
        .as_object_mut()
        .ok_or_else(|| NativeConfigError::Invalid("field parent is not an object".to_string()))?
        .insert((*last).to_string(), value);
    Ok(())
}

fn set_discriminator(
    document: &mut Value,
    field_path: &[&str],
    key: &str,
    value: &str,
) -> Result<(), NativeConfigError> {
    let Some((_, parent)) = field_path.split_last() else {
        return Ok(());
    };
    let mut discriminator_path = parent.to_vec();
    discriminator_path.push(key);
    set_value_at_path(
        document,
        &discriminator_path,
        Value::String(value.to_string()),
    )
}

fn remove_value_at_path(document: &mut Value, path: &[&str]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = document;
    for segment in parents {
        let Some(next) = current.get_mut(*segment) else {
            return;
        };
        current = next;
    }
    if let Some(object) = current.as_object_mut() {
        object.remove(*last);
    }
}

fn authentication_status(
    precedence: AuthenticationPrecedence,
    account: bool,
    api_key: bool,
) -> AgentAuthenticationStatus {
    match (account, api_key) {
        (false, false) => AgentAuthenticationStatus::NotLoggedIn,
        (true, false) => AgentAuthenticationStatus::Account,
        (false, true) => AgentAuthenticationStatus::ApiKey,
        (true, true) => match precedence {
            AuthenticationPrecedence::AccountThenApiKey => AgentAuthenticationStatus::Account,
            AuthenticationPrecedence::ApiKeyThenAccount => AgentAuthenticationStatus::ApiKey,
            AuthenticationPrecedence::SingleSource => AgentAuthenticationStatus::MultipleUnknown,
        },
    }
}
