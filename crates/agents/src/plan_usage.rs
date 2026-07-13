//! Subscription plan / rate-limit usage probes for agents that expose them.
//!
//! Deliberately independent of the ACP runtime: Codex is probed through a
//! one-shot `codex app-server` JSON-RPC exchange, Claude Code through the
//! OAuth usage endpoint using the credentials the CLI already stores locally.
//! Neither probe touches live agent connections or conversations.

use std::{env, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::ChildStdout,
    time::timeout,
};
use ts_rs::TS;
use workspace_utils::process::new_hidden_tokio_command;

use crate::{AgentKind, metadata};

const CODEX_APP_SERVER_TIMEOUT_SECS: u64 = 20;
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
/// The usage endpoint expects a Claude Code user agent; other agents land in
/// an aggressively rate-limited bucket.
const CLAUDE_USAGE_USER_AGENT: &str = "claude-code/2.1.2";
const CLAUDE_USAGE_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanUsageWindow {
    /// Stable window identifier the frontend maps to a localized label.
    /// Codex: `primary` / `secondary`. Claude: `five_hour` / `seven_day` /
    /// `seven_day_opus` / `seven_day_sonnet` / `extra_usage`.
    pub id: String,
    pub used_percent: Option<f64>,
    #[ts(type = "number | null")]
    pub window_minutes: Option<i64>,
    #[ts(type = "number | null")]
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanCredits {
    pub balance: Option<String>,
    pub unlimited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentPlanUsage {
    pub plan_type: Option<String>,
    pub windows: Vec<PlanUsageWindow>,
    pub credits: Option<PlanCredits>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(use_ts_enum)]
#[ts(export)]
pub enum PlanUsageUnavailableReason {
    UnsupportedAgent,
    CliNotFound,
    NotLoggedIn,
    TokenExpired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum PlanUsageResult {
    Ok { usage: AgentPlanUsage },
    Unavailable { reason: PlanUsageUnavailableReason },
    Error { message: String },
}

impl PlanUsageResult {
    fn unavailable(reason: PlanUsageUnavailableReason) -> Self {
        Self::Unavailable { reason }
    }

    fn error(message: impl Into<String>) -> Self {
        Self::Error {
            message: message.into(),
        }
    }
}

pub async fn probe_plan_usage(agent_type: AgentKind) -> PlanUsageResult {
    match agent_type {
        AgentKind::ClaudeCode => probe_claude_plan_usage().await,
        AgentKind::Codex => probe_codex_plan_usage().await,
        _ => PlanUsageResult::unavailable(PlanUsageUnavailableReason::UnsupportedAgent),
    }
}

// ── Codex: one-shot `codex app-server` JSON-RPC probe ──────────────────────

fn existing_file(path: impl Into<PathBuf>) -> Option<PathBuf> {
    let path = path.into();
    path.is_file().then_some(path)
}

fn npm_codex_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(app_data) = env::var_os("APPDATA") {
        let npm_dir = PathBuf::from(app_data).join("npm");
        candidates.push(npm_dir.join("codex.cmd"));
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex"));
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        let npm_dir = PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("npm");
        candidates.push(npm_dir.join("codex.cmd"));
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex"));
    }

    candidates
}

fn resolve_codex_command_path() -> Option<PathBuf> {
    if let Some(path) = env::var_os("CODEX_BIN").and_then(existing_file) {
        return Some(path);
    }

    for name in ["codex.exe", "codex.cmd", "codex"] {
        if let Ok(path) = which::which(name) {
            return Some(path);
        }
    }

    npm_codex_candidates().into_iter().find_map(existing_file)
}

async fn write_app_server_message(
    stdin: &mut tokio::process::ChildStdin,
    value: Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn response_error_message(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    Some(error.to_string())
}

async fn read_app_server_response(
    lines: &mut Lines<BufReader<ChildStdout>>,
    target_id: u64,
) -> Result<Value, String> {
    loop {
        let line = lines
            .next_line()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Codex app-server closed before responding.".to_string())?;

        if line.trim().is_empty() {
            continue;
        }

        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("id").and_then(Value::as_u64) != Some(target_id) {
            continue;
        }

        if let Some(message) = response_error_message(&value) {
            return Err(message);
        }

        return Ok(value.get("result").cloned().unwrap_or(value));
    }
}

async fn probe_codex_plan_usage() -> PlanUsageResult {
    if !metadata::codex_auth_path().is_some_and(|path| path.exists()) {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    }

    let Some(codex_path) = resolve_codex_command_path() else {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::CliNotFound);
    };

    let mut child = match new_hidden_tokio_command(&codex_path, ["app-server"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return PlanUsageResult::error(format!(
                "Failed to start Codex app-server from {}: {error}",
                codex_path.display()
            ));
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return PlanUsageResult::error("Codex app-server stdin is unavailable.");
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return PlanUsageResult::error("Codex app-server stdout is unavailable.");
    };

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while matches!(lines.next_line().await, Ok(Some(_))) {}
        });
    }

    let mut stdout_lines = BufReader::new(stdout).lines();
    let init_params = json!({
        "clientInfo": {
            "name": "vibex",
            "title": "VibeX",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true
        }
    });

    let exchange = timeout(Duration::from_secs(CODEX_APP_SERVER_TIMEOUT_SECS), async {
        write_app_server_message(
            &mut stdin,
            json!({ "id": 1, "method": "initialize", "params": init_params }),
        )
        .await?;
        read_app_server_response(&mut stdout_lines, 1).await?;

        write_app_server_message(&mut stdin, json!({ "method": "initialized" })).await?;
        write_app_server_message(
            &mut stdin,
            json!({ "id": 2, "method": "account/rateLimits/read", "params": null }),
        )
        .await?;
        read_app_server_response(&mut stdout_lines, 2).await
    })
    .await;

    let _ = child.kill().await;

    match exchange {
        Ok(Ok(result)) => match map_codex_rate_limits(&result) {
            Some(usage) => PlanUsageResult::Ok { usage },
            None => PlanUsageResult::error("Codex app-server returned no rate-limit data."),
        },
        Ok(Err(message)) => PlanUsageResult::error(message),
        Err(_) => PlanUsageResult::error("Timed out while reading Codex account rate limits."),
    }
}

/// Reset timestamps arrive as epoch seconds or milliseconds depending on the
/// Codex version; normalize to milliseconds.
fn normalize_epoch_ms(value: f64) -> i64 {
    if value > 1_000_000_000_000.0 {
        value as i64
    } else {
        (value * 1000.0) as i64
    }
}

fn map_codex_window(id: &str, window: &Value) -> Option<PlanUsageWindow> {
    if !window.is_object() {
        return None;
    }
    Some(PlanUsageWindow {
        id: id.to_string(),
        used_percent: window.get("usedPercent").and_then(Value::as_f64),
        window_minutes: window.get("windowDurationMins").and_then(Value::as_i64),
        resets_at_ms: window
            .get("resetsAt")
            .and_then(Value::as_f64)
            .map(normalize_epoch_ms),
    })
}

fn map_codex_rate_limits(result: &Value) -> Option<AgentPlanUsage> {
    let snapshot = result
        .get("rateLimitsByLimitId")
        .and_then(|by_id| by_id.get("codex"))
        .filter(|value| value.is_object())
        .or_else(|| result.get("rateLimits").filter(|value| value.is_object()))?;

    let mut windows = Vec::new();
    if let Some(window) = snapshot
        .get("primary")
        .and_then(|value| map_codex_window("primary", value))
    {
        windows.push(window);
    }
    if let Some(window) = snapshot
        .get("secondary")
        .and_then(|value| map_codex_window("secondary", value))
    {
        windows.push(window);
    }

    let credits = snapshot
        .get("credits")
        .filter(|value| value.is_object())
        .map(|credits| PlanCredits {
            balance: credits
                .get("balance")
                .and_then(Value::as_str)
                .map(str::to_string),
            unlimited: credits
                .get("unlimited")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });

    Some(AgentPlanUsage {
        plan_type: snapshot
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
        windows,
        credits,
    })
}

// ── Claude Code: OAuth usage endpoint with locally stored credentials ──────

struct ClaudeOauthCredentials {
    access_token: String,
    expires_at_ms: Option<i64>,
    subscription_type: Option<String>,
}

fn parse_claude_credentials_json(raw: &str) -> Option<ClaudeOauthCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let oauth = value.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken").and_then(Value::as_str)?;
    if access_token.is_empty() {
        return None;
    }
    Some(ClaudeOauthCredentials {
        access_token: access_token.to_string(),
        expires_at_ms: oauth.get("expiresAt").and_then(Value::as_i64),
        subscription_type: oauth
            .get("subscriptionType")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn claude_credentials_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

#[cfg(target_os = "macos")]
async fn read_claude_keychain_credentials() -> Option<String> {
    let output = new_hidden_tokio_command(
        "security",
        [
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ],
    )
    .output()
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(not(target_os = "macos"))]
async fn read_claude_keychain_credentials() -> Option<String> {
    None
}

async fn load_claude_credentials() -> Result<ClaudeOauthCredentials, PlanUsageResult> {
    if let Ok(token) = env::var("CLAUDE_CODE_OAUTH_TOKEN")
        && !token.trim().is_empty()
    {
        return Ok(ClaudeOauthCredentials {
            access_token: token.trim().to_string(),
            expires_at_ms: None,
            subscription_type: None,
        });
    }

    if let Some(path) = claude_credentials_file_path()
        && let Ok(raw) = tokio::fs::read_to_string(&path).await
        && let Some(credentials) = parse_claude_credentials_json(&raw)
    {
        return Ok(credentials);
    }

    if let Some(raw) = read_claude_keychain_credentials().await
        && let Some(credentials) = parse_claude_credentials_json(&raw)
    {
        return Ok(credentials);
    }

    Err(PlanUsageResult::unavailable(
        PlanUsageUnavailableReason::NotLoggedIn,
    ))
}

fn is_token_expired(expires_at_ms: Option<i64>, now_ms: i64) -> bool {
    expires_at_ms.is_some_and(|expires_at| expires_at <= now_ms)
}

async fn probe_claude_plan_usage() -> PlanUsageResult {
    let credentials = match load_claude_credentials().await {
        Ok(credentials) => credentials,
        Err(result) => return result,
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    if is_token_expired(credentials.expires_at_ms, now_ms) {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::TokenExpired);
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(CLAUDE_USAGE_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(error) => return PlanUsageResult::error(error.to_string()),
    };

    let response = match client
        .get(CLAUDE_USAGE_URL)
        .header(
            "Authorization",
            format!("Bearer {}", credentials.access_token),
        )
        .header("anthropic-beta", CLAUDE_OAUTH_BETA_HEADER)
        .header("User-Agent", CLAUDE_USAGE_USER_AGENT)
        .header("Content-Type", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return PlanUsageResult::error(error.to_string()),
    };

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::TokenExpired);
    }
    if !status.is_success() {
        return PlanUsageResult::error(format!("Claude usage endpoint returned {status}."));
    }

    match response.json::<Value>().await {
        Ok(value) => PlanUsageResult::Ok {
            usage: map_claude_usage(&value, credentials.subscription_type),
        },
        Err(error) => PlanUsageResult::error(error.to_string()),
    }
}

fn parse_rfc3339_ms(value: &Value) -> Option<i64> {
    let raw = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|instant| instant.timestamp_millis())
}

fn map_claude_window(
    id: &str,
    window: &Value,
    window_minutes: Option<i64>,
) -> Option<PlanUsageWindow> {
    if !window.is_object() {
        return None;
    }
    Some(PlanUsageWindow {
        id: id.to_string(),
        used_percent: window.get("utilization").and_then(Value::as_f64),
        window_minutes,
        resets_at_ms: window.get("resets_at").and_then(parse_rfc3339_ms),
    })
}

fn map_claude_usage(value: &Value, subscription_type: Option<String>) -> AgentPlanUsage {
    let mut windows = Vec::new();
    for (id, minutes) in [
        ("five_hour", Some(300)),
        ("seven_day", Some(10_080)),
        ("seven_day_opus", Some(10_080)),
        ("seven_day_sonnet", Some(10_080)),
    ] {
        if let Some(window) = value
            .get(id)
            .and_then(|window| map_claude_window(id, window, minutes))
        {
            windows.push(window);
        }
    }

    if let Some(extra) = value.get("extra_usage")
        && extra
            .get("is_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        windows.push(PlanUsageWindow {
            id: "extra_usage".to_string(),
            used_percent: extra.get("utilization").and_then(Value::as_f64),
            window_minutes: None,
            resets_at_ms: None,
        });
    }

    AgentPlanUsage {
        plan_type: subscription_type.map(|plan| capitalize_plan(&plan)),
        windows,
        credits: None,
    }
}

fn capitalize_plan(raw: &str) -> String {
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_rate_limits_prefer_by_limit_id_snapshot() {
        let result = json!({
            "rateLimits": { "planType": "plus", "primary": { "usedPercent": 10.0 } },
            "rateLimitsByLimitId": {
                "codex": {
                    "planType": "pro",
                    "primary": {
                        "usedPercent": 42.5,
                        "windowDurationMins": 300,
                        "resetsAt": 1_760_000_000
                    },
                    "secondary": {
                        "usedPercent": 12.0,
                        "windowDurationMins": 10_080,
                        "resetsAt": 1_760_000_000_000_i64
                    },
                    "credits": { "hasCredits": true, "unlimited": false, "balance": "12.50" }
                }
            }
        });

        let usage = map_codex_rate_limits(&result).expect("snapshot expected");
        assert_eq!(usage.plan_type.as_deref(), Some("pro"));
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].id, "primary");
        assert_eq!(usage.windows[0].used_percent, Some(42.5));
        assert_eq!(usage.windows[0].window_minutes, Some(300));
        // Seconds-resolution reset normalized to ms.
        assert_eq!(usage.windows[0].resets_at_ms, Some(1_760_000_000_000));
        // Millisecond-resolution reset preserved as-is.
        assert_eq!(usage.windows[1].resets_at_ms, Some(1_760_000_000_000));
        let credits = usage.credits.expect("credits expected");
        assert_eq!(credits.balance.as_deref(), Some("12.50"));
        assert!(!credits.unlimited);
    }

    #[test]
    fn codex_rate_limits_fall_back_to_top_level_snapshot() {
        let result = json!({
            "rateLimits": {
                "planType": "plus",
                "primary": { "usedPercent": 55.0 }
            }
        });

        let usage = map_codex_rate_limits(&result).expect("snapshot expected");
        assert_eq!(usage.plan_type.as_deref(), Some("plus"));
        assert_eq!(usage.windows.len(), 1);
        assert!(usage.credits.is_none());
    }

    #[test]
    fn codex_rate_limits_missing_snapshot_returns_none() {
        assert!(map_codex_rate_limits(&json!({})).is_none());
        assert!(map_codex_rate_limits(&json!({ "rateLimits": null })).is_none());
    }

    #[test]
    fn claude_usage_maps_windows_and_skips_null() {
        let value = json!({
            "five_hour": { "utilization": 34.0, "resets_at": "2026-07-07T12:00:00Z" },
            "seven_day": { "utilization": 61.5, "resets_at": "2026-07-10T00:00:00+00:00" },
            "seven_day_opus": null,
            "seven_day_sonnet": { "utilization": 5.0, "resets_at": "2026-07-10T00:00:00Z" },
            "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null }
        });

        let usage = map_claude_usage(&value, Some("max".to_string()));
        assert_eq!(usage.plan_type.as_deref(), Some("Max"));
        let ids: Vec<&str> = usage.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["five_hour", "seven_day", "seven_day_sonnet"]);
        assert_eq!(usage.windows[0].used_percent, Some(34.0));
        assert!(usage.windows[0].resets_at_ms.is_some());
        assert!(usage.credits.is_none());
    }

    #[test]
    fn claude_usage_includes_enabled_extra_usage_window() {
        let value = json!({
            "five_hour": { "utilization": 10.0, "resets_at": "2026-07-07T12:00:00Z" },
            "extra_usage": { "is_enabled": true, "monthly_limit": 50, "used_credits": 20, "utilization": 40.0 }
        });

        let usage = map_claude_usage(&value, None);
        let extra = usage
            .windows
            .iter()
            .find(|window| window.id == "extra_usage")
            .expect("extra usage window expected");
        assert_eq!(extra.used_percent, Some(40.0));
        assert!(usage.plan_type.is_none());
    }

    #[test]
    fn claude_credentials_parse_and_expiry() {
        let raw = r#"{
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-abc",
                "refreshToken": "sk-ant-ort01-def",
                "expiresAt": 1751900000000,
                "subscriptionType": "max"
            }
        }"#;

        let credentials = parse_claude_credentials_json(raw).expect("credentials expected");
        assert_eq!(credentials.access_token, "sk-ant-oat01-abc");
        assert_eq!(credentials.subscription_type.as_deref(), Some("max"));
        assert!(is_token_expired(
            credentials.expires_at_ms,
            1_751_900_000_001
        ));
        assert!(!is_token_expired(
            credentials.expires_at_ms,
            1_751_899_999_999
        ));
        assert!(!is_token_expired(None, i64::MAX));
    }

    #[test]
    fn claude_credentials_reject_missing_or_empty_token() {
        assert!(parse_claude_credentials_json("{}").is_none());
        assert!(parse_claude_credentials_json(r#"{"claudeAiOauth":{"accessToken":""}}"#).is_none());
        assert!(parse_claude_credentials_json("not json").is_none());
    }

    #[test]
    fn unsupported_agents_report_unavailable() {
        let result = tokio_test_block_on(probe_plan_usage(AgentKind::Gemini));
        assert_eq!(
            result,
            PlanUsageResult::Unavailable {
                reason: PlanUsageUnavailableReason::UnsupportedAgent
            }
        );
    }

    fn tokio_test_block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }
}
