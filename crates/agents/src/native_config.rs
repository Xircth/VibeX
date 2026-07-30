//! Profile-bound native configuration editing.

use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use api_types::{AgentAuthenticationStatus, AgentId};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::{
    AuthenticationPrecedence, BuiltInProfileCatalog, NativeConfigBinding, NativeConfigField,
    NativeConfigFieldKind, NativeConfigFormat, NativeFileSystem,
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
}

pub struct NativeConfigProvider {
    filesystem: Arc<dyn NativeFileSystem>,
    home: PathBuf,
    profiles: BuiltInProfileCatalog,
}

impl NativeConfigProvider {
    pub fn bundled(filesystem: Arc<dyn NativeFileSystem>, home: PathBuf) -> Self {
        Self {
            filesystem,
            home,
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
            documents.push((binding, path, parse_document(binding, bytes.as_deref())?));
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
        for (binding, _, document) in &documents {
            for field in binding
                .fields
                .iter()
                .filter(|field| patch.values.contains_key(field.field_id))
            {
                let current_revision = field_revision(value_at_path(document, field.path));
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

        for (binding, path, document) in &mut documents {
            for field in binding
                .fields
                .iter()
                .filter(|field| patch.values.contains_key(field.field_id))
            {
                match patch.values.get(field.field_id).cloned().flatten() {
                    Some(value) => {
                        let value = parse_field_value(field, &value)?;
                        set_value_at_path(document, field.path, value)?;
                        if let Some((key, value)) = field.object_discriminator {
                            set_discriminator(document, field.path, key, value)?;
                        }
                    }
                    None => remove_value_at_path(document, field.path),
                }
            }
            let bytes = serialize_document(binding, document)?;
            self.filesystem
                .write_atomic(path, &bytes)
                .await
                .map_err(|error| NativeConfigError::FileSystem(error.to_string()))?;
        }

        let snapshot = self.read(agent_id, account_logged_in).await?;
        Ok(NativeConfigSaveResult {
            snapshot,
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
        binding
            .directory_override_env
            .and_then(std::env::var_os)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(|directory| directory.join(binding.override_relative_path))
            .unwrap_or_else(|| self.home.join(binding.home_relative_path))
    }
}

const fn empty_document_preview(format: NativeConfigFormat) -> &'static str {
    match format {
        NativeConfigFormat::Json => "{}",
        NativeConfigFormat::Toml => "",
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
    }
}

fn field_snapshot(
    field: &NativeConfigField,
    document: &Value,
    path: PathBuf,
) -> NativeConfigFieldSnapshot {
    let raw = value_at_path(document, field.path);
    let value = scalar_string(raw);
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
        revision: field_revision(raw),
    }
}

fn scalar_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
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
    }
}

fn field_revision(value: Option<&Value>) -> String {
    let bytes = value
        .and_then(|value| serde_json::to_vec(value).ok())
        .unwrap_or_else(|| b"null".to_vec());
    format!("{:x}", Sha256::digest(bytes))
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
