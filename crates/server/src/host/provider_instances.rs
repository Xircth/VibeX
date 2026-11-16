//! Host commands for multi-account `ProviderInstanceRecord` management and secret testing.
//!
//! Secret API keys never touch SQLite: raw secrets supplied via `apiKeySecret` or inline
//! `SecretRef::Inline` are persisted to OS keychain / DPAPI via `SecretResolver::store_keychain`,
//! while `provider_instances.auth_mode` stores only the resulting `SecretRef::SystemKeychain`
//! reference plus a redacted preview.

use std::time::Instant;

use agents::secret_resolution::{
    ProviderAuthMode, SecretRef, SecretResolver, mask_secret_preview, validate_op_reference,
};
use application::ApplicationError;
use db::models::provider_instance::{
    CreateProviderInstanceInput, ProviderInstanceRecord, ProviderInstanceStoreError,
    UpdateProviderInstanceInput,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListProviderInstancesArgs {
    #[serde(default, alias = "agent_id")]
    agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProviderInstanceArgs {
    #[serde(default)]
    id: Option<String>,
    #[serde(default, alias = "instance_id")]
    instance_id: Option<String>,
    #[serde(alias = "agent_id")]
    agent_id: String,
    #[serde(default, alias = "display_name")]
    display_name: Option<String>,
    #[serde(default, alias = "auth_mode")]
    auth_mode: Option<Value>,
    #[serde(default, alias = "api_key_secret")]
    api_key_secret: Option<String>,
    #[serde(default, alias = "is_default")]
    is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceIdentityArgs {
    #[serde(alias = "agent_id")]
    agent_id: String,
    #[serde(alias = "instance_id")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestConnectionArgs {
    #[serde(alias = "agent_id")]
    agent_id: String,
    #[serde(default, alias = "instance_id")]
    instance_id: Option<String>,
    #[serde(default, alias = "auth_mode")]
    auth_mode: Option<Value>,
    #[serde(default, alias = "api_key_secret")]
    api_key_secret: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderInstanceWireView {
    id: String,
    instance_id: String,
    agent_id: String,
    display_name: String,
    auth_mode: Value,
    is_default: bool,
    has_active_sessions: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionTestWireResult {
    ok: bool,
    latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn unwrap_request(args: Value) -> Value {
    if let Some(inner) = args.get("request")
        && inner.is_object()
    {
        return inner.clone();
    }
    args
}

fn map_store_error(err: ProviderInstanceStoreError) -> ApplicationError {
    match err {
        ProviderInstanceStoreError::NotFound { .. } => ApplicationError::not_found(err.to_string()),
        ProviderInstanceStoreError::DuplicateInstance { .. }
        | ProviderInstanceStoreError::CannotDeleteDefaultWithSiblings { .. } => {
            ApplicationError::conflict(err.to_string())
        }
        ProviderInstanceStoreError::InvalidInput(_) => {
            ApplicationError::bad_request(err.to_string())
        }
        ProviderInstanceStoreError::Database(_) => internal_error(err),
    }
}

fn slugify_instance_id(display_name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in display_name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    let short_suffix = &Uuid::new_v4().simple().to_string()[..6];
    if slug.is_empty() {
        format!("instance-{short_suffix}")
    } else {
        format!("{slug}-{short_suffix}")
    }
}

fn to_wire_view(record: ProviderInstanceRecord, has_active_sessions: bool) -> ProviderInstanceWireView {
    let auth_mode = serde_json::from_str::<Value>(&record.auth_mode)
        .unwrap_or_else(|_| json!({ "mode": "OfficialOAuth" }));
    ProviderInstanceWireView {
        id: record.id,
        instance_id: record.instance_id,
        agent_id: record.agent_id,
        display_name: record.display_name,
        auth_mode,
        is_default: record.is_default,
        has_active_sessions,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

async fn agent_has_active_sessions(domains: &ServerApplicationDomains, raw_agent_id: &str) -> bool {
    let Ok(agent_id) = agents::AgentId::parse(raw_agent_id.trim()) else {
        return false;
    };
    domains
        .conversations
        .agent_runtime
        .has_active_sessions_for_agent(&agent_id)
        .await
}

async fn mark_provider_agent_sessions_stale(
    domains: &ServerApplicationDomains,
    raw_agent_id: &str,
) {
    if let Ok(agent_id) = agents::AgentId::parse(raw_agent_id.trim()) {
        domains
            .conversations
            .agent_runtime
            .mark_agent_sessions_config_stale(&agent_id, "provider_instance_changed")
            .await;
    }
}

async fn sanitize_and_store_auth_mode(
    agent_id: &str,
    instance_id: &str,
    raw_auth_mode: Value,
    api_key_secret: Option<&str>,
) -> Result<String, ApplicationError> {
    let parsed_mode: ProviderAuthMode = serde_json::from_value(raw_auth_mode.clone())
        .map_err(|err| ApplicationError::bad_request(format!("Invalid authMode: {err}")))?;

    let resolver = SecretResolver::new();
    let key_id = format!("provider:{}:{}", agent_id.trim(), instance_id.trim());

    match parsed_mode {
        ProviderAuthMode::OfficialOAuth {
            oauth_token_ref,
            account_email,
        } => {
            let clean_ref = match oauth_token_ref {
                Some(SecretRef::Inline { value }) if !value.trim().is_empty() => Some(
                    resolver
                        .store_keychain(&format!("{key_id}:oauth"), value.trim())
                        .await
                        .map_err(internal_error)?,
                ),
                other => other,
            };
            let serialized = serde_json::to_value(ProviderAuthMode::OfficialOAuth {
                oauth_token_ref: clean_ref,
                account_email,
            })
            .map_err(internal_error)?;
            serde_json::to_string(&serialized).map_err(internal_error)
        }
        ProviderAuthMode::ApiKey { key_ref } => {
            let explicit_secret = api_key_secret.map(str::trim).filter(|s| !s.is_empty());
            let existing_preview = raw_auth_mode
                .get("maskedPreview")
                .or_else(|| raw_auth_mode.get("masked_preview"))
                .and_then(Value::as_str)
                .map(str::to_string);

            let (final_ref, masked_preview) = if let Some(secret) = explicit_secret {
                let stored = resolver
                    .store_keychain(&key_id, secret)
                    .await
                    .map_err(internal_error)?;
                (Some(stored), Some(mask_secret_preview(secret)))
            } else if let Some(SecretRef::Inline { value }) = &key_ref {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    (None, existing_preview)
                } else {
                    let stored = resolver
                        .store_keychain(&key_id, trimmed)
                        .await
                        .map_err(internal_error)?;
                    (Some(stored), Some(mask_secret_preview(trimmed)))
                }
            } else {
                (key_ref, existing_preview)
            };

            let mut obj = serde_json::Map::new();
            obj.insert("mode".to_string(), Value::String("ApiKey".to_string()));
            if let Some(secret_ref) = final_ref {
                obj.insert(
                    "keyRef".to_string(),
                    serde_json::to_value(secret_ref).map_err(internal_error)?,
                );
            }
            if let Some(preview) = masked_preview {
                obj.insert("maskedPreview".to_string(), Value::String(preview));
            }
            serde_json::to_string(&Value::Object(obj)).map_err(internal_error)
        }
        ProviderAuthMode::SecretManager { op_reference } => {
            validate_op_reference(op_reference.trim())
                .map_err(|err| ApplicationError::bad_request(err.to_string()))?;
            let serialized = serde_json::to_value(ProviderAuthMode::SecretManager {
                op_reference: op_reference.trim().to_string(),
            })
            .map_err(internal_error)?;
            serde_json::to_string(&serialized).map_err(internal_error)
        }
    }
}

pub(crate) async fn list(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let parsed: ListProviderInstancesArgs = if args.is_null() {
        ListProviderInstancesArgs { agent_id: None }
    } else {
        parse(unwrap_request(args))?
    };
    let rows = match parsed
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(agent_id) => ProviderInstanceRecord::list_by_agent(domains.writer_pool(), agent_id)
            .await
            .map_err(map_store_error)?,
        None => ProviderInstanceRecord::list_all(domains.writer_pool())
            .await
            .map_err(map_store_error)?,
    };
    let mut views = Vec::with_capacity(rows.len());
    for row in rows {
        let active = agent_has_active_sessions(domains, &row.agent_id).await;
        views.push(to_wire_view(row, active));
    }
    serialize(views)
}

pub(crate) async fn create(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: UpsertProviderInstanceArgs = parse(unwrap_request(args))?;
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApplicationError::bad_request("displayName must not be empty"))?;
    let instance_id = input
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| slugify_instance_id(display_name));
    let raw_auth_mode = input
        .auth_mode
        .unwrap_or_else(|| json!({ "mode": "OfficialOAuth" }));
    let auth_mode_json = sanitize_and_store_auth_mode(
        &input.agent_id,
        &instance_id,
        raw_auth_mode,
        input.api_key_secret.as_deref(),
    )
    .await?;

    let created = ProviderInstanceRecord::create(
        domains.writer_pool(),
        CreateProviderInstanceInput {
            id: input.id.as_deref(),
            agent_id: &input.agent_id,
            instance_id: &instance_id,
            display_name,
            auth_mode: &auth_mode_json,
            is_default: input.is_default.unwrap_or(false),
        },
    )
    .await
    .map_err(map_store_error)?;

    if created.is_default {
        mark_provider_agent_sessions_stale(domains, &created.agent_id).await;
    }
    let active = agent_has_active_sessions(domains, &created.agent_id).await;
    serialize(to_wire_view(created, active))
}

pub(crate) async fn update(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: UpsertProviderInstanceArgs = parse(unwrap_request(args))?;
    let instance_id = input
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApplicationError::bad_request("instanceId is required for update"))?;

    let next_auth_mode = match input.auth_mode {
        Some(raw_mode) => Some(
            sanitize_and_store_auth_mode(
                &input.agent_id,
                instance_id,
                raw_mode,
                input.api_key_secret.as_deref(),
            )
            .await?,
        ),
        None => None,
    };

    let updated = ProviderInstanceRecord::update(
        domains.writer_pool(),
        &input.agent_id,
        instance_id,
        UpdateProviderInstanceInput {
            display_name: input.display_name.as_deref(),
            auth_mode: next_auth_mode.as_deref(),
            is_default: input.is_default,
        },
    )
    .await
    .map_err(map_store_error)?;

    mark_provider_agent_sessions_stale(domains, &updated.agent_id).await;
    let active = agent_has_active_sessions(domains, &updated.agent_id).await;
    serialize(to_wire_view(updated, active))
}

pub(crate) async fn set_default(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: InstanceIdentityArgs = parse(unwrap_request(args))?;
    let _ =
        ProviderInstanceRecord::set_default(domains.writer_pool(), &input.agent_id, &input.instance_id)
            .await
            .map_err(map_store_error)?;
    mark_provider_agent_sessions_stale(domains, &input.agent_id).await;
    Ok(Value::Null)
}

pub(crate) async fn delete(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: InstanceIdentityArgs = parse(unwrap_request(args))?;
    ProviderInstanceRecord::delete(domains.writer_pool(), &input.agent_id, &input.instance_id)
        .await
        .map_err(map_store_error)?;
    mark_provider_agent_sessions_stale(domains, &input.agent_id).await;
    Ok(Value::Null)
}

pub(crate) async fn test_connection(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let input: TestConnectionArgs = parse(unwrap_request(args))?;
    let started = Instant::now();

    let resolved_mode_value = if let Some(inline_mode) = input.auth_mode {
        inline_mode
    } else if let Some(instance_id) = input
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match ProviderInstanceRecord::find_by_instance(
            domains.writer_pool(),
            &input.agent_id,
            instance_id,
        )
        .await
        .map_err(map_store_error)?
        {
            Some(record) => serde_json::from_str::<Value>(&record.auth_mode)
                .unwrap_or_else(|_| json!({ "mode": "OfficialOAuth" })),
            None => {
                return serialize(ProviderConnectionTestWireResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: Some(format!(
                        "Provider instance '{instance_id}' not found for agent '{}'",
                        input.agent_id
                    )),
                });
            }
        }
    } else {
        json!({ "mode": "OfficialOAuth" })
    };

    let parsed_mode: ProviderAuthMode = match serde_json::from_value(resolved_mode_value) {
        Ok(mode) => mode,
        Err(err) => {
            return serialize(ProviderConnectionTestWireResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                account_email: None,
                error: Some(format!("Invalid authMode configuration: {err}")),
            });
        }
    };

    let resolver = SecretResolver::new();
    let result = match parsed_mode {
        ProviderAuthMode::OfficialOAuth {
            oauth_token_ref,
            account_email,
        } => match oauth_token_ref {
            Some(secret_ref) => match resolver.resolve(&secret_ref).await {
                Ok(token) if !token.trim().is_empty() => ProviderConnectionTestWireResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email,
                    error: None,
                },
                Ok(_) => ProviderConnectionTestWireResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: Some("Resolved OAuth token is empty".to_string()),
                },
                Err(err) => ProviderConnectionTestWireResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: Some(err.to_string()),
                },
            },
            None => ProviderConnectionTestWireResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                account_email,
                error: None,
            },
        },
        ProviderAuthMode::ApiKey { key_ref } => {
            if let Some(secret) = input
                .api_key_secret
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let _ = secret;
                ProviderConnectionTestWireResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: None,
                }
            } else if let Some(secret_ref) = key_ref {
                match resolver.resolve(&secret_ref).await {
                    Ok(secret) if !secret.trim().is_empty() => ProviderConnectionTestWireResult {
                        ok: true,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: None,
                    },
                    Ok(_) => ProviderConnectionTestWireResult {
                        ok: false,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: Some("Resolved API key is empty".to_string()),
                    },
                    Err(err) => ProviderConnectionTestWireResult {
                        ok: false,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: Some(err.to_string()),
                    },
                }
            } else {
                ProviderConnectionTestWireResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: Some("No API key secret or reference configured".to_string()),
                }
            }
        }
        ProviderAuthMode::SecretManager { op_reference } => {
            if let Err(err) = validate_op_reference(op_reference.trim()) {
                ProviderConnectionTestWireResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    account_email: None,
                    error: Some(err.to_string()),
                }
            } else {
                match resolver
                    .resolve(&SecretRef::OnePassword {
                        op_ref: op_reference.trim().to_string(),
                    })
                    .await
                {
                    Ok(secret) if !secret.trim().is_empty() => ProviderConnectionTestWireResult {
                        ok: true,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: None,
                    },
                    Ok(_) => ProviderConnectionTestWireResult {
                        ok: false,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: Some("1Password secret resolved to an empty value".to_string()),
                    },
                    Err(err) => ProviderConnectionTestWireResult {
                        ok: false,
                        latency_ms: started.elapsed().as_millis() as u64,
                        account_email: None,
                        error: Some(err.to_string()),
                    },
                }
            }
        }
    };

    serialize(result)
}
