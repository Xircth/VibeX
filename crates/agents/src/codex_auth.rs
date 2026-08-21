//! Codex authentication-mode policy and native auth document projection.
//!
//! This belongs to the Agent application/domain layer so Tauri commands only
//! resolve paths, coordinate persistence, and translate errors to wire views.

use serde_json::Value;

pub const CODEX_AUTH_MODES: &[&str] = &["chatgpt_subscription", "api_key", "model_provider"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAuthModeProjection {
    pub mode: &'static str,
    pub credential_present: bool,
}

pub fn apply_codex_auth_mode(
    document: &mut Value,
    mode: &str,
    api_key: Option<&str>,
) -> Result<(), String> {
    let object = document
        .as_object_mut()
        .ok_or_else(|| "Codex auth.json top level must be an object".to_string())?;
    match mode {
        "chatgpt_subscription" => {
            object.insert("auth_mode".to_string(), serde_json::json!("chatgpt"));
            object.insert("OPENAI_API_KEY".to_string(), Value::Null);
        }
        "api_key" => {
            if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
                object.insert("OPENAI_API_KEY".to_string(), serde_json::json!(api_key));
            }
            object.remove("auth_mode");
            if object
                .get("OPENAI_API_KEY")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err("api_key mode requires OPENAI_API_KEY".to_string());
            }
        }
        "model_provider" => {
            object.remove("auth_mode");
        }
        _ => return Err(format!("unsupported Codex authentication mode `{mode}`")),
    }
    Ok(())
}

pub fn project_codex_auth_mode(auth: &Value, provider_bound: bool) -> CodexAuthModeProjection {
    let credential_present = auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let subscription = auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
        || auth.get("OPENAI_API_KEY").is_none()
        || auth.get("OPENAI_API_KEY").is_some_and(Value::is_null);
    let mode = if provider_bound {
        "model_provider"
    } else if subscription {
        "chatgpt_subscription"
    } else {
        "api_key"
    };
    CodexAuthModeProjection {
        mode,
        credential_present,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_prefers_provider_then_subscription_then_api_key() {
        assert_eq!(
            project_codex_auth_mode(
                &serde_json::json!({
                    "auth_mode": "chatgpt",
                    "OPENAI_API_KEY": null,
                    "tokens": { "access_token": "token" }
                }),
                false,
            )
            .mode,
            "chatgpt_subscription"
        );
        let key =
            project_codex_auth_mode(&serde_json::json!({ "OPENAI_API_KEY": "sk-local" }), false);
        assert_eq!(key.mode, "api_key");
        assert!(key.credential_present);
        assert_eq!(
            project_codex_auth_mode(
                &serde_json::json!({ "OPENAI_API_KEY": "sk-provider" }),
                true,
            )
            .mode,
            "model_provider"
        );
    }

    #[test]
    fn mode_changes_are_mutually_exclusive_and_preserve_tokens() {
        let mut document = serde_json::json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "access_token": "keep" }
        });
        apply_codex_auth_mode(&mut document, "api_key", Some("sk-local")).unwrap();
        assert_eq!(document["OPENAI_API_KEY"], "sk-local");
        assert!(document.get("auth_mode").is_none());
        assert_eq!(document["tokens"]["access_token"], "keep");

        apply_codex_auth_mode(&mut document, "chatgpt_subscription", None).unwrap();
        assert_eq!(document["auth_mode"], "chatgpt");
        assert!(document["OPENAI_API_KEY"].is_null());
    }
}
