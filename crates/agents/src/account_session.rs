//! Official-account session status and leftover local evidence.
//!
//! Settings treats a completed login or logout command as the source of truth.
//! Local files and keychain entries can outlive a banned, expired, or revoked
//! session, so residue must not flip the signed-in badge on or off by itself.

use std::time::Duration;

use api_types::AgentAuthenticationStatus;
use base64::Engine;
use serde_json::Value;

use crate::{AgentId, cursor_auth, metadata, profiles::ProfileManagementActionKind};

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
}
