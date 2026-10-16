//! Official-account session status and leftover local evidence.
//!
//! A completed logout stays signed out even when session files remain, and a
//! completed login stays signed in when those files are missing. A probe that
//! never recorded a logout still follows a live official-account session.

use std::time::Duration;

use api_types::AgentAuthenticationStatus;
use base64::Engine;
use serde_json::Value;

use crate::{
    AgentId, cursor_auth, metadata,
    profiles::{BuiltInProfileCatalog, ProfileManagementActionKind},
};

/// Keep a recorded official-account result when disk residue disagrees.
///
/// Leftover `auth.json` / credentials must not promote a signed-out agent, and
/// a missing file must not sign the user out after a successful login command.
pub fn prefer_recorded_account_over_residue(
    recorded: AgentAuthenticationStatus,
    observed: AgentAuthenticationStatus,
) -> AgentAuthenticationStatus {
    match (recorded, observed) {
        (_, AgentAuthenticationStatus::Account) => recorded,
        (AgentAuthenticationStatus::Account, AgentAuthenticationStatus::NotLoggedIn) => {
            AgentAuthenticationStatus::Account
        }
        (_, observed) => observed,
    }
}

/// A bound Model Provider with credentials is an API Key login.
///
/// Native config snapshots often stay `NotLoggedIn` until the next full probe,
/// so the bound preset is the authentication fact for Settings and preflight.
pub fn authentication_with_bound_provider(
    observed: AgentAuthenticationStatus,
    bound_with_credential: bool,
) -> AgentAuthenticationStatus {
    if bound_with_credential && matches!(observed, AgentAuthenticationStatus::NotLoggedIn) {
        AgentAuthenticationStatus::ApiKey
    } else {
        observed
    }
}

/// Combine a recorded probe, native snapshot, and bound-provider credentials.
///
/// `account_signed_out` is set only by a completed logout command. Without it,
/// a live official account replaces a probe that merely defaulted to signed out.
pub fn resolve_observed_authentication(
    recorded: AgentAuthenticationStatus,
    native: AgentAuthenticationStatus,
    bound_with_credential: bool,
    account_signed_out: bool,
) -> AgentAuthenticationStatus {
    let observed = authentication_with_bound_provider(native, bound_with_credential);
    if !account_signed_out
        && matches!(recorded, AgentAuthenticationStatus::NotLoggedIn)
        && matches!(observed, AgentAuthenticationStatus::Account)
    {
        return AgentAuthenticationStatus::Account;
    }
    prefer_recorded_account_over_residue(recorded, observed)
}

/// Map a finished official login/logout command to the recorded session status.
pub fn authentication_from_account_command(
    kind: ProfileManagementActionKind,
    exit_code: i32,
) -> Option<AgentAuthenticationStatus> {
    if exit_code != 0 {
        return None;
    }
    match kind {
        ProfileManagementActionKind::Login => Some(AgentAuthenticationStatus::Account),
        ProfileManagementActionKind::Logout => Some(AgentAuthenticationStatus::NotLoggedIn),
        ProfileManagementActionKind::Setup | ProfileManagementActionKind::Subscription => None,
    }
}

const CONFIRM_TIMEOUT_SECS: u64 = 4;
const CHATGPT_ME_URL: &str = "https://chatgpt.com/backend-api/me";
const CURSOR_PERIOD_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountSessionConfirmation {
    Confirmed,
    Rejected,
    Inconclusive,
}

pub fn account_session_from_http(status: u16, body: &str) -> AccountSessionConfirmation {
    if status == 401 || status == 403 {
        return AccountSessionConfirmation::Rejected;
    }
    if (200..300).contains(&status) {
        return AccountSessionConfirmation::Confirmed;
    }
    if account_session_body_is_rejected(body) {
        return AccountSessionConfirmation::Rejected;
    }
    AccountSessionConfirmation::Inconclusive
}

/// Codex stores ChatGPT tokens in `auth.json`, but those tokens are not a
/// reliable Bearer credential for `chatgpt.com/backend-api/me`. A 401 there
/// must not hide a present local ChatGPT session.
pub fn account_session_from_codex_http(status: u16, body: &str) -> AccountSessionConfirmation {
    if account_session_body_is_rejected(body) {
        return AccountSessionConfirmation::Rejected;
    }
    if (200..300).contains(&status) {
        return AccountSessionConfirmation::Confirmed;
    }
    AccountSessionConfirmation::Inconclusive
}

pub async fn resolve_account_label(agent_id: &AgentId) -> Option<String> {
    match agent_id.as_str() {
        "codex" => {
            account_label_from_codex_auth(&read_json_value(metadata::codex_auth_path()?).await?)
        }
        "claude_code" => {
            account_label_from_document(&read_json_value(metadata::claude_config_path()?).await?)
        }
        "cursor" => jwt_identity(cursor_auth::cursor_account_token().await?.as_str()),
        "grok" => account_label_from_grok_auth(&read_json_value(grok_auth_path()?).await?),
        "antigravity" | "gemini" => resolve_antigravity_account_label().await,
        _ => None,
    }
}

pub fn account_label_from_codex_auth(auth: &Value) -> Option<String> {
    auth.get("tokens")
        .and_then(|tokens| tokens.get("id_token"))
        .and_then(Value::as_str)
        .and_then(jwt_identity)
        .or_else(|| account_label_from_document(auth))
}

pub fn account_label_from_antigravity_token(value: &Value) -> Option<String> {
    identity_from_value(value)
        .or_else(|| {
            value
                .get("id_token")
                .and_then(Value::as_str)
                .and_then(jwt_identity)
        })
        .or_else(|| account_label_from_document(value))
}

pub fn extract_email_from_antigravity_log(content: &str) -> Option<String> {
    for line in content.lines().rev() {
        if let Some(pos) = line.find("OAuth: authenticated successfully as ") {
            let email = line[pos + "OAuth: authenticated successfully as ".len()..].trim();
            if !email.is_empty() && email.contains('@') {
                return Some(email.to_string());
            }
        }
        if let Some(pos) = line.find("applyAuthResult: email=") {
            let rest = &line[pos + "applyAuthResult: email=".len()..];
            let email = rest.split(',').next().unwrap_or("").trim();
            if !email.is_empty() && email.contains('@') {
                return Some(email.to_string());
            }
        }
    }
    None
}

async fn read_antigravity_email_from_logs() -> Option<String> {
    let log_dir = metadata::gemini_home()?.join("antigravity-cli").join("log");
    let mut entries = tokio::fs::read_dir(log_dir).await.ok()?;
    let mut newest_file = None;
    let mut newest_time = std::time::SystemTime::UNIX_EPOCH;

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("log") {
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    if modified > newest_time {
                        newest_time = modified;
                        newest_file = Some(path);
                    }
                }
            }
        }
    }

    let file_path = newest_file?;
    let content = tokio::fs::read_to_string(file_path).await.ok()?;
    extract_email_from_antigravity_log(&content)
}

async fn refresh_antigravity_token_email(doc: &Value) -> Option<String> {
    let refresh_token = doc.get("refresh_token").and_then(Value::as_str)?;
    let client_id = doc.get("client_id").and_then(Value::as_str)?;
    let client_secret = doc
        .get("client_secret")
        .and_then(Value::as_str)
        .unwrap_or("");
    let token_uri = doc
        .get("token_uri")
        .and_then(Value::as_str)
        .unwrap_or("https://oauth2.googleapis.com/token");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CONFIRM_TIMEOUT_SECS))
        .build()
        .ok()?;

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];

    let response = client.post(token_uri).form(&params).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let res_json = response.json::<Value>().await.ok()?;
    account_label_from_antigravity_token(&res_json)
}

pub async fn resolve_antigravity_account_label() -> Option<String> {
    let token_path = metadata::antigravity_token_path()?;
    let mut token_doc = read_json_value(token_path.clone()).await;

    if let Some(doc) = &token_doc {
        if let Some(label) = account_label_from_antigravity_token(doc) {
            return Some(label);
        }
    }

    let mut resolved_email = read_antigravity_email_from_logs().await;

    if resolved_email.is_none() {
        if let Some(doc) = &token_doc {
            resolved_email = refresh_antigravity_token_email(doc).await;
        }
    }

    if let Some(ref email) = resolved_email {
        if let Some(ref mut doc) = token_doc {
            if doc.is_object() {
                doc["email"] = Value::String(email.clone());
                if let Ok(bytes) = serde_json::to_vec_pretty(doc) {
                    let _ = tokio::fs::write(&token_path, bytes).await;
                }
            }
        }
    }

    resolved_email
}

pub fn account_label_from_document(value: &Value) -> Option<String> {
    identity_from_value(value).or_else(|| value.get("oauthAccount").and_then(identity_from_value))
}

pub fn account_label_from_grok_auth(value: &Value) -> Option<String> {
    account_label_from_document(value).or_else(|| {
        value.as_object()?.values().find_map(|entry| {
            entry
                .get("key")
                .and_then(Value::as_str)
                .and_then(jwt_identity)
                .or_else(|| account_label_from_document(entry))
        })
    })
}

pub fn jwt_identity(token: &str) -> Option<String> {
    identity_from_value(&jwt_payload(token)?)
}

fn grok_auth_path() -> Option<std::path::PathBuf> {
    std::env::var_os("GROK_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
        .map(|home| home.join("auth.json"))
}

async fn read_json_value(path: std::path::PathBuf) -> Option<Value> {
    let bytes = tokio::fs::read(path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let padded = match payload.len() % 4 {
        0 => payload.to_string(),
        rest => format!("{payload}{}", "=".repeat(4 - rest)),
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(padded.trim_end_matches('='))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&padded))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn identity_from_value(value: &Value) -> Option<String> {
    const KEYS: &[&str] = &[
        "email",
        "emailAddress",
        "preferred_username",
        "name",
        "username",
    ];
    for key in KEYS {
        if let Some(label) = value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
        {
            return Some(label.to_string());
        }
    }
    for nested in [
        "https://api.openai.com/profile",
        "https://api.openai.com/auth",
    ] {
        if let Some(label) = value.get(nested).and_then(identity_from_value) {
            return Some(label);
        }
    }
    None
}

pub fn extract_codex_access_token(auth: &Value) -> Option<String> {
    auth.get("tokens")
        .and_then(|tokens| tokens.get("access_token"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

pub async fn confirm_account_session(
    agent_id: &AgentId,
    local_account_present: bool,
    local_auth_document: Option<&Value>,
) -> AccountSessionConfirmation {
    if !local_account_present {
        return AccountSessionConfirmation::Rejected;
    }
    match agent_id.as_str() {
        "codex" => confirm_codex_account(local_auth_document).await,
        "cursor" => confirm_cursor_account().await,
        _ => AccountSessionConfirmation::Inconclusive,
    }
}

pub fn account_still_present(local: bool, confirmation: AccountSessionConfirmation) -> bool {
    match confirmation {
        AccountSessionConfirmation::Rejected => false,
        AccountSessionConfirmation::Confirmed | AccountSessionConfirmation::Inconclusive => local,
    }
}

fn account_session_body_is_rejected(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    [
        "banned",
        "deactivated",
        "disabled",
        "account_deactivated",
        "account has been deactivated",
        "your account has been banned",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

async fn confirm_codex_account(document: Option<&Value>) -> AccountSessionConfirmation {
    let Some(token) = document.and_then(extract_codex_access_token) else {
        return AccountSessionConfirmation::Rejected;
    };
    match confirm_bearer_get_response(CHATGPT_ME_URL, &token, None).await {
        Some((status, body)) => account_session_from_codex_http(status, &body),
        None => AccountSessionConfirmation::Inconclusive,
    }
}

async fn confirm_cursor_account() -> AccountSessionConfirmation {
    let Some(token) = cursor_auth::cursor_account_token().await else {
        return AccountSessionConfirmation::Rejected;
    };
    confirm_bearer_post(CURSOR_PERIOD_USAGE_URL, &token, Some("cursor-agent"), "{}").await
}

async fn confirm_bearer_get_response(
    url: &str,
    token: &str,
    user_agent: Option<&str>,
) -> Option<(u16, String)> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CONFIRM_TIMEOUT_SECS))
        .build()
        .ok()?;
    let mut request = client
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json");
    if let Some(user_agent) = user_agent {
        request = request.header("User-Agent", user_agent);
    }
    let response = request.send().await.ok()?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Some((status, body))
}

async fn confirm_bearer_post(
    url: &str,
    token: &str,
    user_agent: Option<&str>,
    body: &str,
) -> AccountSessionConfirmation {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(CONFIRM_TIMEOUT_SECS))
        .build()
    else {
        return AccountSessionConfirmation::Inconclusive;
    };
    let mut request = client
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if let Some(user_agent) = user_agent {
        request = request.header("User-Agent", user_agent);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            account_session_from_http(status, &text)
        }
        Err(_) => AccountSessionConfirmation::Inconclusive,
    }
}

/// Whether the agent's official-account evidence is present on disk or in the
/// keychain. This is the login fact; it is not an API-key credential.
pub async fn official_account_present(
    home: &std::path::Path,
    agent_id: &AgentId,
    environment: &std::collections::HashMap<String, String>,
) -> bool {
    if agent_id.as_str() == "cursor" {
        return cursor_auth::cursor_account_token().await.is_some();
    }
    let Some(bytes) = read_account_evidence_bytes(home, agent_id, environment).await else {
        return false;
    };
    serde_json::from_slice::<Value>(&bytes).is_ok_and(|value| {
        if agent_id.as_str() == "kimi_code" && kimi_credential_is_synthetic(&value) {
            return false;
        }
        BuiltInProfileCatalog::bundled()
            .profile(agent_id)
            .and_then(|profile| profile.account_evidence.as_ref())
            .is_some_and(|evidence| evidence.matches(&value))
    })
}

async fn read_account_evidence_bytes(
    home: &std::path::Path,
    agent_id: &AgentId,
    environment: &std::collections::HashMap<String, String>,
) -> Option<Vec<u8>> {
    let evidence = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| profile.account_evidence.clone())?;
    let override_directory = evidence.directory_override_env.and_then(|name| {
        environment
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_home_path(home, value))
            .or_else(|| {
                std::env::var_os(name)
                    .filter(|value| !value.is_empty())
                    .map(|value| expand_home_path(home, &value.to_string_lossy()))
            })
    });
    let directory = override_directory
        .map(|directory| directory.join(evidence.override_relative_directory))
        .unwrap_or_else(|| home.join(evidence.home_relative_directory));
    tokio::fs::read(directory.join(evidence.relative_file))
        .await
        .ok()
}

fn expand_home_path(home: &std::path::Path, value: &str) -> std::path::PathBuf {
    let path = std::path::PathBuf::from(value.trim());
    if path == std::path::Path::new("~") {
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

fn kimi_credential_is_synthetic(value: &Value) -> bool {
    value.get("_vibex_synthetic").and_then(Value::as_bool) == Some(true)
        || value.get("access_token").and_then(Value::as_str) == Some("vibex-local-gate")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_401_and_403_reject_a_stale_account() {
        assert_eq!(
            account_session_from_http(401, ""),
            AccountSessionConfirmation::Rejected
        );
        assert_eq!(
            account_session_from_http(403, "forbidden"),
            AccountSessionConfirmation::Rejected
        );
    }

    #[test]
    fn http_success_confirms_the_account() {
        assert_eq!(
            account_session_from_http(200, r#"{"id":"user"}"#),
            AccountSessionConfirmation::Confirmed
        );
    }

    #[test]
    fn banned_body_rejects_even_without_401() {
        assert_eq!(
            account_session_from_http(400, "Your account has been banned"),
            AccountSessionConfirmation::Rejected
        );
        assert_eq!(
            account_session_from_http(500, "account_deactivated"),
            AccountSessionConfirmation::Rejected
        );
    }

    #[test]
    fn network_shaped_failures_stay_inconclusive() {
        assert_eq!(
            account_session_from_http(502, "bad gateway"),
            AccountSessionConfirmation::Inconclusive
        );
    }

    #[test]
    fn rejected_confirmation_clears_local_residue() {
        assert!(!account_still_present(
            true,
            AccountSessionConfirmation::Rejected
        ));
        assert!(account_still_present(
            true,
            AccountSessionConfirmation::Inconclusive
        ));
        assert!(!account_still_present(
            false,
            AccountSessionConfirmation::Confirmed
        ));
    }

    #[test]
    fn bound_provider_credentials_count_as_api_key_login() {
        assert_eq!(
            authentication_with_bound_provider(AgentAuthenticationStatus::NotLoggedIn, true),
            AgentAuthenticationStatus::ApiKey
        );
        assert_eq!(
            authentication_with_bound_provider(AgentAuthenticationStatus::NotLoggedIn, false),
            AgentAuthenticationStatus::NotLoggedIn
        );
        assert_eq!(
            authentication_with_bound_provider(AgentAuthenticationStatus::Account, true),
            AgentAuthenticationStatus::Account
        );
        assert_eq!(
            resolve_observed_authentication(
                AgentAuthenticationStatus::NotLoggedIn,
                AgentAuthenticationStatus::NotLoggedIn,
                true,
                false,
            ),
            AgentAuthenticationStatus::ApiKey
        );
        assert_eq!(
            resolve_observed_authentication(
                AgentAuthenticationStatus::Account,
                AgentAuthenticationStatus::NotLoggedIn,
                true,
                false,
            ),
            AgentAuthenticationStatus::ApiKey
        );
    }

    #[test]
    fn a_live_official_account_replaces_an_unconfirmed_signed_out_probe() {
        assert_eq!(
            resolve_observed_authentication(
                AgentAuthenticationStatus::NotLoggedIn,
                AgentAuthenticationStatus::Account,
                false,
                false,
            ),
            AgentAuthenticationStatus::Account
        );
        assert_eq!(
            resolve_observed_authentication(
                AgentAuthenticationStatus::ApiKey,
                AgentAuthenticationStatus::Account,
                false,
                false,
            ),
            AgentAuthenticationStatus::ApiKey
        );
    }

    #[test]
    fn an_explicit_sign_out_keeps_leftover_account_files_signed_out() {
        assert_eq!(
            resolve_observed_authentication(
                AgentAuthenticationStatus::NotLoggedIn,
                AgentAuthenticationStatus::Account,
                false,
                true,
            ),
            AgentAuthenticationStatus::NotLoggedIn
        );
    }

    #[test]
    fn leftover_session_files_do_not_promote_a_signed_out_agent() {
        assert_eq!(
            prefer_recorded_account_over_residue(
                AgentAuthenticationStatus::NotLoggedIn,
                AgentAuthenticationStatus::Account
            ),
            AgentAuthenticationStatus::NotLoggedIn
        );
        assert_eq!(
            prefer_recorded_account_over_residue(
                AgentAuthenticationStatus::ApiKey,
                AgentAuthenticationStatus::Account
            ),
            AgentAuthenticationStatus::ApiKey
        );
    }

    #[test]
    fn missing_session_files_do_not_clear_a_successful_login() {
        assert_eq!(
            prefer_recorded_account_over_residue(
                AgentAuthenticationStatus::Account,
                AgentAuthenticationStatus::NotLoggedIn
            ),
            AgentAuthenticationStatus::Account
        );
    }

    #[test]
    fn native_api_key_still_replaces_a_recorded_account() {
        assert_eq!(
            prefer_recorded_account_over_residue(
                AgentAuthenticationStatus::Account,
                AgentAuthenticationStatus::ApiKey
            ),
            AgentAuthenticationStatus::ApiKey
        );
    }

    #[test]
    fn successful_login_and_logout_commands_record_session_status() {
        assert_eq!(
            authentication_from_account_command(ProfileManagementActionKind::Login, 0),
            Some(AgentAuthenticationStatus::Account)
        );
        assert_eq!(
            authentication_from_account_command(ProfileManagementActionKind::Logout, 0),
            Some(AgentAuthenticationStatus::NotLoggedIn)
        );
        assert_eq!(
            authentication_from_account_command(ProfileManagementActionKind::Login, 1),
            None
        );
    }

    #[tokio::test]
    async fn grok_auth_file_counts_as_an_official_account() {
        let home = std::env::temp_dir().join(format!(
            "vibex-grok-auth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = tokio::fs::remove_dir_all(&home).await;
        tokio::fs::create_dir_all(home.join(".grok")).await.unwrap();
        let auth = home.join(".grok").join("auth.json");
        tokio::fs::write(&auth, br#"{"session":{"auth_mode":"oidc"}}"#)
            .await
            .unwrap();
        let agent = AgentId::parse("grok").unwrap();
        let environment = std::collections::HashMap::new();
        assert!(official_account_present(&home, &agent, &environment).await);
        tokio::fs::write(&auth, b"{}").await.unwrap();
        assert!(!official_account_present(&home, &agent, &environment).await);
        let _ = tokio::fs::remove_dir_all(&home).await;
    }

    #[test]
    fn reads_chatgpt_email_from_the_id_token() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"email":"ada@example.com"}"#);
        let auth = serde_json::json!({
            "tokens": { "id_token": format!("header.{payload}.signature") }
        });
        assert_eq!(
            account_label_from_codex_auth(&auth).as_deref(),
            Some("ada@example.com")
        );
    }

    #[test]
    fn reads_claude_email_from_oauth_account() {
        assert_eq!(
            account_label_from_document(&serde_json::json!({
                "oauthAccount": { "emailAddress": "linus@example.com" }
            }))
            .as_deref(),
            Some("linus@example.com")
        );
    }

    #[test]
    fn codex_http_401_without_a_ban_keeps_local_chatgpt_tokens() {
        assert_eq!(
            account_session_from_codex_http(401, r#"{"detail":"Unauthorized"}"#),
            AccountSessionConfirmation::Inconclusive
        );
        assert_eq!(
            account_session_from_codex_http(403, "forbidden"),
            AccountSessionConfirmation::Inconclusive
        );
        assert_eq!(
            account_session_from_codex_http(200, r#"{"email":"ada@example.com"}"#),
            AccountSessionConfirmation::Confirmed
        );
        assert_eq!(
            account_session_from_codex_http(401, "Your account has been banned"),
            AccountSessionConfirmation::Rejected
        );
        assert!(account_still_present(
            true,
            account_session_from_codex_http(401, "unauthorized")
        ));
    }

    #[test]
    fn leftover_codex_tokens_without_access_token_are_rejected() {
        assert_eq!(
            extract_codex_access_token(&serde_json::json!({
                "tokens": { "refresh_token": "stale" }
            })),
            None
        );
        assert!(!account_still_present(
            true,
            AccountSessionConfirmation::Rejected
        ));
    }

    #[test]
    fn extracts_codex_chatgpt_access_tokens_only() {
        assert_eq!(
            extract_codex_access_token(&serde_json::json!({
                "tokens": { "access_token": " tok " }
            })),
            Some("tok".to_string())
        );
        assert_eq!(
            extract_codex_access_token(&serde_json::json!({
                "OPENAI_API_KEY": "sk-local",
                "tokens": {}
            })),
            None
        );
    }

    #[test]
    fn extracts_email_from_antigravity_token_document() {
        assert_eq!(
            account_label_from_antigravity_token(&serde_json::json!({
                "email": "user@gmail.com",
                "refresh_token": "token123"
            })),
            Some("user@gmail.com".to_string())
        );

        assert_eq!(
            account_label_from_antigravity_token(&serde_json::json!({
                "oauthAccount": { "email": "account@gmail.com" }
            })),
            Some("account@gmail.com".to_string())
        );
    }

    #[test]
    fn extracts_email_from_antigravity_cli_log() {
        let log = r#"
I1011 14:53:09.766535     319 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)
I1011 14:53:09.766535     319 server_oauth.go:204] applyAuthResult: email=dev@google.com, authMethod=consumer, quotaProject=
I1011 14:53:09.766535     319 server_oauth.go:209] OAuth: authenticated successfully as dev@google.com
"#;
        assert_eq!(
            extract_email_from_antigravity_log(log),
            Some("dev@google.com".to_string())
        );

        let log2 = r#"
I1011 14:53:09.766535     319 server_oauth.go:204] applyAuthResult: email=engineer@example.com, authMethod=consumer
"#;
        assert_eq!(
            extract_email_from_antigravity_log(log2),
            Some("engineer@example.com".to_string())
        );
    }
}
