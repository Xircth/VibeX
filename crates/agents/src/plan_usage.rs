//! Subscription plan / rate-limit usage probes for agents that expose them.
//!
//! Deliberately independent of the ACP runtime: Codex is probed through a
//! one-shot `codex app-server` JSON-RPC exchange, Claude Code through the
//! OAuth usage endpoint using the credentials the CLI already stores locally,
//! Grok through the official CLI chat-proxy settings/billing endpoints, and
//! Cursor through the official DashboardService period-usage API. None of the
//! probes touch live agent connections or conversations.

use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::ChildStdout,
    time::timeout,
};
use ts_rs::TS;
use workspace_utils::process::new_hidden_tokio_command;

use crate::{AgentId, cursor_auth, metadata};

const CODEX_APP_SERVER_TIMEOUT_SECS: u64 = 20;
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
/// The usage endpoint expects a Claude Code user agent; other agents land in
/// an aggressively rate-limited bucket.
const CLAUDE_USAGE_USER_AGENT: &str = "claude-code/2.1.2";
const CLAUDE_USAGE_TIMEOUT_SECS: u64 = 15;
const GROK_SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
/// `format=credits` is the shape the Grok CLI itself reads. The unparameterized
/// response only describes pay-as-you-go monthly billing, so subscription
/// accounts get `monthlyLimit: 0` and no usable window.
const GROK_BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_USAGE_USER_AGENT: &str = "grok-cli";
const GROK_USAGE_TIMEOUT_SECS: u64 = 15;
const GROK_OIDC_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
/// Nginx routes the CLI proxy to OAuth only when this header is present.
const GROK_TOKEN_AUTH_HEADER: &str = "xai-grok-cli";
const GROK_CLIENT_VERSION: &str = "1.0.13";
const CURSOR_PERIOD_USAGE_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_PLAN_INFO_URL: &str =
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const CURSOR_USAGE_USER_AGENT: &str = "cursor-agent";
const CURSOR_USAGE_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanUsageWindow {
    /// Stable window identifier the frontend maps to a localized label.
    /// Codex: `primary` / `secondary`. Claude: `five_hour` / `seven_day` /
    /// `seven_day_opus` / `seven_day_sonnet` / `extra_usage`. Grok: `weekly` /
    /// `monthly` / `plan_period`. Cursor: `cursor_models` / `other_models`.
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

fn plan_usage_cache() -> &'static Mutex<HashMap<AgentId, AgentPlanUsage>> {
    static CACHE: OnceLock<Mutex<HashMap<AgentId, AgentPlanUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cached_plan_usage(agent_id: &AgentId) -> Option<AgentPlanUsage> {
    plan_usage_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(agent_id).cloned())
}

pub async fn probe_plan_usage(agent_id: &AgentId) -> PlanUsageResult {
    let result = match agent_id.as_str() {
        "claude_code" => probe_claude_plan_usage().await,
        "codex" => probe_codex_plan_usage().await,
        "grok" => probe_grok_plan_usage().await,
        "cursor" => probe_cursor_plan_usage().await,
        _ => PlanUsageResult::unavailable(PlanUsageUnavailableReason::UnsupportedAgent),
    };
    if let PlanUsageResult::Ok { usage } = &result
        && let Ok(mut cache) = plan_usage_cache().lock()
    {
        cache.insert(agent_id.clone(), usage.clone());
    }
    result
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
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex.cmd"));
        candidates.push(npm_dir.join("codex"));
    }

    if let Some(profile) = env::var_os("USERPROFILE") {
        let npm_dir = PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("npm");
        candidates.push(npm_dir.join("codex.exe"));
        candidates.push(npm_dir.join("codex.cmd"));
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

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|n| n as i64))
        .or_else(|| value.as_f64().map(|n| n as i64))
        .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))
}

fn wrapped_number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .get("val")
            .and_then(|inner| inner.as_f64().or_else(|| inner.as_i64().map(|n| n as f64)))
    })
}

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, PlanUsageResult> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|error| PlanUsageResult::error(error.to_string()))
}

fn plan_usage_from_status(status: reqwest::StatusCode, agent: &str) -> Option<PlanUsageResult> {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Some(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    }
    if !status.is_success() {
        return Some(PlanUsageResult::error(format!(
            "{agent} usage endpoint returned {status}."
        )));
    }
    None
}

// ── Grok: official CLI chat-proxy settings + billing ───────────────────────

struct GrokSessionCredentials {
    access_token: String,
    refresh_token: Option<String>,
    client_id: Option<String>,
    expires_at_ms: Option<i64>,
    user_id: Option<String>,
    email: Option<String>,
}

fn grok_home_dir() -> Option<PathBuf> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
}

fn grok_auth_path() -> Option<PathBuf> {
    grok_home_dir().map(|home| home.join("auth.json"))
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

fn parse_grok_session_credentials(raw: &str) -> Option<GrokSessionCredentials> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let entries = value.as_object()?;
    let mut fallback = None;
    for entry in entries.values() {
        let Some(access_token) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if access_token.is_empty() {
            continue;
        }
        let credentials = GrokSessionCredentials {
            access_token: access_token.to_string(),
            refresh_token: entry
                .get("refresh_token")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string),
            client_id: entry
                .get("oidc_client_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            expires_at_ms: entry
                .get("expires_at")
                .and_then(parse_rfc3339_ms)
                .or_else(|| {
                    jwt_payload(access_token)
                        .and_then(|payload| payload.get("exp").and_then(json_i64))
                        .map(|seconds| seconds.saturating_mul(1000))
                }),
            user_id: entry
                .get("user_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
            email: entry
                .get("email")
                .and_then(Value::as_str)
                .filter(|email| !email.is_empty())
                .map(str::to_string),
        };
        if entry.get("auth_mode").and_then(Value::as_str) == Some("oidc")
            || access_token.starts_with("eyJ")
        {
            return Some(credentials);
        }
        if fallback.is_none() {
            fallback = Some(credentials);
        }
    }
    fallback
}

async fn persist_grok_access_token(access_token: &str, expires_at_ms: Option<i64>) {
    let Some(path) = grok_auth_path() else {
        return;
    };
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(entries) = value.as_object_mut() else {
        return;
    };
    for entry in entries.values_mut() {
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        if object.get("key").and_then(Value::as_str).is_none() {
            continue;
        }
        object.insert("key".to_string(), Value::String(access_token.to_string()));
        if let Some(expires_at_ms) = expires_at_ms
            && let Some(expires_at) =
                chrono::DateTime::<chrono::Utc>::from_timestamp_millis(expires_at_ms)
        {
            object.insert(
                "expires_at".to_string(),
                Value::String(expires_at.to_rfc3339()),
            );
        }
        break;
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&value) {
        let _ = tokio::fs::write(&path, serialized).await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await;
        }
    }
}

async fn refresh_grok_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
    client_id: &str,
) -> Result<(String, Option<i64>), PlanUsageResult> {
    let discovery = match client.get(GROK_OIDC_DISCOVERY_URL).send().await {
        Ok(response) => response,
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    if !discovery.status().is_success() {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    }
    let token_endpoint = match discovery.json::<Value>().await {
        Ok(value) => value
            .get("token_endpoint")
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    let Some(token_endpoint) = token_endpoint else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    };

    let response = match client
        .post(token_endpoint)
        .header("User-Agent", GROK_USAGE_USER_AGENT)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    if !response.status().is_success() {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    }
    let value = match response.json::<Value>().await {
        Ok(value) => value,
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| PlanUsageResult::unavailable(PlanUsageUnavailableReason::TokenExpired))?;
    let expires_at_ms = value
        .get("expires_in")
        .and_then(json_i64)
        .map(|seconds| chrono::Utc::now().timestamp_millis() + seconds.saturating_mul(1000));
    Ok((access_token.to_string(), expires_at_ms))
}

async fn load_grok_session(
    client: &reqwest::Client,
) -> Result<GrokSessionCredentials, PlanUsageResult> {
    let Some(path) = grok_auth_path() else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::NotLoggedIn,
        ));
    };
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::NotLoggedIn,
        ));
    };
    let Some(mut credentials) = parse_grok_session_credentials(&raw) else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::NotLoggedIn,
        ));
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    if !is_token_expired(credentials.expires_at_ms, now_ms) {
        return Ok(credentials);
    }

    let (Some(refresh_token), Some(client_id)) = (
        credentials.refresh_token.as_deref(),
        credentials.client_id.as_deref(),
    ) else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    };
    let (access_token, expires_at_ms) =
        refresh_grok_access_token(client, refresh_token, client_id).await?;
    persist_grok_access_token(&access_token, expires_at_ms).await;
    credentials.access_token = access_token;
    credentials.expires_at_ms = expires_at_ms;
    Ok(credentials)
}

async fn grok_authorized_json(
    client: &reqwest::Client,
    url: &str,
    credentials: &GrokSessionCredentials,
) -> Result<Value, PlanUsageResult> {
    let mut request = client
        .get(url)
        .header(
            "Authorization",
            format!("Bearer {}", credentials.access_token),
        )
        .header("User-Agent", GROK_USAGE_USER_AGENT)
        .header("Accept", "application/json")
        .header("X-XAI-Token-Auth", GROK_TOKEN_AUTH_HEADER)
        .header("x-grok-client-version", GROK_CLIENT_VERSION);
    if let Some(user_id) = credentials.user_id.as_deref() {
        request = request.header("x-userid", user_id);
    }
    if let Some(email) = credentials.email.as_deref() {
        request = request.header("x-email", email);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    if let Some(result) = plan_usage_from_status(response.status(), "Grok") {
        return Err(result);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| PlanUsageResult::error(error.to_string()))
}

fn grok_restricted_tier_name(tier: &str) -> bool {
    let tier = tier.trim().to_ascii_lowercase();
    tier.is_empty() || tier == "free" || tier == "x basic" || tier == "x_basic"
}

fn grok_jwt_tier_display(token: &str) -> Option<String> {
    let tier = jwt_payload(token)?.get("tier").and_then(json_i64)?;
    Some(
        match tier {
            0 => "Free",
            1 => "SuperGrok",
            2 => "X Basic",
            3 => "X Premium",
            4 => "X Premium+",
            5 => "SuperGrok Heavy",
            6 => "SuperGrok Lite",
            7 => "SuperGrok Plus",
            _ => return None,
        }
        .to_string(),
    )
}

fn grok_settings_plan_type(settings: &Value) -> Option<String> {
    settings
        .get("subscription_tier_display")
        .and_then(Value::as_str)
        .or_else(|| settings.get("subscription_tier").and_then(Value::as_str))
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(str::to_string)
}

fn grok_plan_type(
    settings: &Value,
    access_token: Option<&str>,
    has_coding_window: bool,
) -> Option<String> {
    let display = grok_settings_plan_type(settings);
    if let Some(display) = display
        && !(has_coding_window && grok_restricted_tier_name(&display))
    {
        return Some(display);
    }
    access_token
        .and_then(grok_jwt_tier_display)
        .filter(|plan| !(has_coding_window && grok_restricted_tier_name(plan)))
}

fn grok_window_id(period_type: Option<&str>) -> &'static str {
    match period_type {
        Some("USAGE_PERIOD_TYPE_WEEKLY") => "weekly",
        Some("USAGE_PERIOD_TYPE_MONTHLY") => "monthly",
        _ => "plan_period",
    }
}

fn grok_product_usage_percent(config: &Value) -> Option<f64> {
    let products = config.get("productUsage")?.as_array()?;
    let grok_build = products.iter().find(|product| {
        product.get("product").and_then(Value::as_str) == Some("PRODUCT_GROK_BUILD")
    });
    grok_build
        .or_else(|| products.first())
        .and_then(|product| product.get("usagePercent").and_then(wrapped_number))
}

fn grok_used_percent(config: &Value) -> Option<f64> {
    config
        .get("creditUsagePercent")
        .and_then(wrapped_number)
        .or_else(|| grok_product_usage_percent(config))
        .or_else(|| {
            let limit = config
                .get("monthlyLimit")
                .and_then(wrapped_number)
                .filter(|limit| *limit > 0.0)?;
            let used = config.get("used").and_then(wrapped_number).unwrap_or(0.0);
            Some((used / limit) * 100.0)
        })
}

/// Remaining pay-as-you-go allowance: prepaid credits first, then whatever is
/// left under the on-demand spending cap.
fn grok_credits(config: &Value) -> Option<PlanCredits> {
    let amount = config
        .get("prepaidBalance")
        .and_then(wrapped_number)
        .filter(|balance| *balance > 0.0)
        .or_else(|| {
            let cap = config
                .get("onDemandCap")
                .and_then(wrapped_number)
                .filter(|cap| *cap > 0.0)?;
            let used = config
                .get("onDemandUsed")
                .and_then(wrapped_number)
                .unwrap_or(0.0);
            Some((cap - used).max(0.0))
        })?;
    Some(PlanCredits {
        balance: Some(format!("{amount:.2}")),
        unlimited: false,
    })
}

fn map_grok_plan_usage(settings: &Value, billing: &Value) -> AgentPlanUsage {
    map_grok_plan_usage_for(settings, billing, None)
}

fn map_grok_plan_usage_for(
    settings: &Value,
    billing: &Value,
    access_token: Option<&str>,
) -> AgentPlanUsage {
    let config = billing.get("config").unwrap_or(billing);
    let period = config.get("currentPeriod");
    let period_bound = |period_key: &str, config_key: &str| {
        period
            .and_then(|period| period.get(period_key))
            .and_then(parse_rfc3339_ms)
            .or_else(|| config.get(config_key).and_then(parse_rfc3339_ms))
    };
    let period_start = period_bound("start", "billingPeriodStart");
    let period_end = period_bound("end", "billingPeriodEnd");
    let window_minutes = match (period_start, period_end) {
        (Some(start), Some(end)) if end > start => Some((end - start) / 60_000),
        _ => None,
    };

    // proto3 omits a 0.0 `creditUsagePercent` after a period reset. The weekly
    // window is still present on `currentPeriod`; keep it and leave the percent
    // missing instead of dropping the only quota the account returned.
    let used_percent = grok_used_percent(config);
    let windows = if used_percent.is_some() || period.is_some() {
        vec![PlanUsageWindow {
            id: grok_window_id(
                period
                    .and_then(|period| period.get("type"))
                    .and_then(Value::as_str),
            )
            .to_string(),
            used_percent,
            window_minutes,
            resets_at_ms: period_end,
        }]
    } else {
        Vec::new()
    };

    AgentPlanUsage {
        plan_type: grok_plan_type(settings, access_token, !windows.is_empty()),
        windows,
        credits: grok_credits(config),
    }
}

async fn probe_grok_plan_usage() -> PlanUsageResult {
    let client = match http_client(GROK_USAGE_TIMEOUT_SECS) {
        Ok(client) => client,
        Err(result) => return result,
    };
    let credentials = match load_grok_session(&client).await {
        Ok(credentials) => credentials,
        Err(result) => return result,
    };

    let settings = match grok_authorized_json(&client, GROK_SETTINGS_URL, &credentials).await {
        Ok(value) => value,
        Err(result) => return result,
    };
    let billing = match grok_authorized_json(&client, GROK_BILLING_URL, &credentials).await {
        Ok(value) => value,
        Err(result) => return result,
    };

    PlanUsageResult::Ok {
        usage: map_grok_plan_usage_for(&settings, &billing, Some(&credentials.access_token)),
    }
}

// ── Cursor: official DashboardService period usage ──────────────────────────

async fn load_cursor_access_token() -> Result<String, PlanUsageResult> {
    if let Ok(token) = env::var("CURSOR_API_KEY")
        && !token.trim().is_empty()
    {
        return Ok(token.trim().to_string());
    }
    if let Some(token) = cursor_auth::cursor_account_token().await {
        return Ok(token);
    }
    Err(PlanUsageResult::unavailable(
        PlanUsageUnavailableReason::NotLoggedIn,
    ))
}

async fn cursor_authorized_json(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
) -> Result<Value, PlanUsageResult> {
    let response = match client
        .post(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", CURSOR_USAGE_USER_AGENT)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body("{}")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return Err(PlanUsageResult::error(error.to_string())),
    };
    if let Some(result) = plan_usage_from_status(response.status(), "Cursor") {
        return Err(result);
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| PlanUsageResult::error(error.to_string()))
}

fn map_cursor_window(
    id: &str,
    used_percent: Option<f64>,
    window_minutes: Option<i64>,
    resets_at_ms: Option<i64>,
) -> Option<PlanUsageWindow> {
    used_percent.map(|used_percent| PlanUsageWindow {
        id: id.to_string(),
        used_percent: Some(used_percent),
        window_minutes,
        resets_at_ms,
    })
}

fn map_cursor_plan_usage(period: &Value, plan_info: Option<&Value>) -> AgentPlanUsage {
    let plan_usage = period.get("planUsage").unwrap_or(period);
    let cycle_start = period.get("billingCycleStart").and_then(json_i64);
    let cycle_end = period.get("billingCycleEnd").and_then(json_i64);
    let window_minutes = match (cycle_start, cycle_end) {
        (Some(start), Some(end)) if end > start => Some((end - start) / 60_000),
        _ => None,
    };

    let mut windows = Vec::new();
    if let Some(window) = map_cursor_window(
        "cursor_models",
        plan_usage.get("autoPercentUsed").and_then(Value::as_f64),
        window_minutes,
        cycle_end,
    ) {
        windows.push(window);
    }
    if let Some(window) = map_cursor_window(
        "other_models",
        plan_usage.get("apiPercentUsed").and_then(Value::as_f64),
        window_minutes,
        cycle_end,
    ) {
        windows.push(window);
    }
    if windows.is_empty()
        && let Some(window) = map_cursor_window(
            "monthly",
            plan_usage.get("totalPercentUsed").and_then(Value::as_f64),
            window_minutes,
            cycle_end,
        )
    {
        windows.push(window);
    }

    let plan_type = plan_info
        .and_then(|value| value.get("planInfo"))
        .and_then(|info| info.get("planName"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string);

    let remaining = plan_usage.get("remaining").and_then(json_i64);
    let limit = plan_usage.get("limit").and_then(json_i64);
    let credits = match (remaining, limit) {
        (Some(remaining), Some(limit)) if limit > 0 => Some(PlanCredits {
            balance: Some(format!("{:.2}", remaining as f64 / 100.0)),
            unlimited: false,
        }),
        _ => None,
    };

    AgentPlanUsage {
        plan_type,
        windows,
        credits,
    }
}

async fn probe_cursor_plan_usage() -> PlanUsageResult {
    let access_token = match load_cursor_access_token().await {
        Ok(token) => token,
        Err(result) => return result,
    };
    let client = match http_client(CURSOR_USAGE_TIMEOUT_SECS) {
        Ok(client) => client,
        Err(result) => return result,
    };

    let period = match cursor_authorized_json(&client, CURSOR_PERIOD_USAGE_URL, &access_token).await
    {
        Ok(value) => value,
        Err(result) => return result,
    };
    let plan_info = cursor_authorized_json(&client, CURSOR_PLAN_INFO_URL, &access_token)
        .await
        .ok();

    PlanUsageResult::Ok {
        usage: map_cursor_plan_usage(&period, plan_info.as_ref()),
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
    fn grok_session_credentials_prefer_oidc_jwt() {
        let raw = r#"{
            "https://auth.x.ai::client": {
                "key": "eyJhbGciOiJub25lIn0.eyJleHAiOjE3ODcwNDE1MDYsInRpZXIiOjV9.sig",
                "auth_mode": "oidc",
                "refresh_token": "refresh-1",
                "oidc_client_id": "client",
                "user_id": "user-1",
                "email": "user@example.com",
                "expires_at": "2026-08-18T08:25:06.366514Z"
            }
        }"#;
        let credentials = parse_grok_session_credentials(raw).expect("credentials");
        assert!(credentials.access_token.starts_with("eyJ"));
        assert_eq!(credentials.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(credentials.client_id.as_deref(), Some("client"));
        assert_eq!(credentials.user_id.as_deref(), Some("user-1"));
        assert_eq!(credentials.email.as_deref(), Some("user@example.com"));
        assert!(credentials.expires_at_ms.is_some());
    }

    #[test]
    fn grok_session_credentials_reject_empty_store() {
        assert!(parse_grok_session_credentials("{}").is_none());
        assert!(parse_grok_session_credentials(r#"{"x":{"key":""}}"#).is_none());
        assert!(parse_grok_session_credentials("not json").is_none());
    }

    #[test]
    fn grok_usage_maps_weekly_subscription_period() {
        let settings = json!({ "subscription_tier_display": "SuperGrok Heavy" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-08-28T13:59:50.639993+00:00",
                    "end": "2026-09-04T13:59:50.639993+00:00"
                },
                "creditUsagePercent": 100.0,
                "onDemandCap": { "val": 0 },
                "onDemandUsed": { "val": 0 },
                "prepaidBalance": { "val": 0 },
                "billingPeriodStart": "2026-08-28T13:59:50.639993+00:00",
                "billingPeriodEnd": "2026-09-04T13:59:50.639993+00:00"
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert_eq!(usage.plan_type.as_deref(), Some("SuperGrok Heavy"));
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert_eq!(usage.windows[0].used_percent, Some(100.0));
        assert_eq!(usage.windows[0].window_minutes, Some(10_080));
        assert!(usage.windows[0].resets_at_ms.is_some());
        assert!(usage.credits.is_none());
    }

    #[test]
    fn grok_usage_maps_monthly_period_and_on_demand_remainder() {
        let settings = json!({ "subscription_tier_display": "SuperGrok" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_MONTHLY",
                    "start": "2026-08-01T00:00:00Z",
                    "end": "2026-09-01T00:00:00Z"
                },
                "creditUsagePercent": 25.0,
                "onDemandCap": { "val": 25 },
                "onDemandUsed": { "val": 10 }
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "monthly");
        assert_eq!(usage.windows[0].used_percent, Some(25.0));
        assert_eq!(usage.windows[0].window_minutes, Some(44_640));
        assert_eq!(usage.credits.unwrap().balance.as_deref(), Some("15.00"));
    }

    #[test]
    fn grok_usage_prefers_prepaid_balance_and_falls_back_to_duration_label() {
        let settings = json!({});
        let billing = json!({
            "config": {
                "creditUsagePercent": 12.5,
                "prepaidBalance": { "val": 40 },
                "onDemandCap": { "val": 25 },
                "onDemandUsed": { "val": 10 }
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert!(usage.plan_type.is_none());
        assert_eq!(usage.windows[0].id, "plan_period");
        assert_eq!(usage.windows[0].window_minutes, None);
        assert_eq!(usage.credits.unwrap().balance.as_deref(), Some("40.00"));
    }

    #[test]
    fn grok_usage_keeps_weekly_window_when_credits_percent_is_omitted() {
        let settings = json!({ "subscription_tier_display": "SuperGrok Heavy" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-09-04T13:59:50.639993+00:00",
                    "end": "2026-09-11T13:59:50.639993+00:00"
                },
                "onDemandCap": { "val": 0 },
                "onDemandUsed": { "val": 0 },
                "isUnifiedBillingUser": true,
                "prepaidBalance": { "val": 0 },
                "billingPeriodStart": "2026-09-04T13:59:50.639993+00:00",
                "billingPeriodEnd": "2026-09-11T13:59:50.639993+00:00"
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert_eq!(usage.windows[0].used_percent, None);
        assert_eq!(usage.windows[0].window_minutes, Some(10_080));
        assert!(usage.windows[0].resets_at_ms.is_some());
    }

    #[test]
    fn grok_usage_reads_product_percent_when_overall_percent_is_absent() {
        let settings = json!({ "subscription_tier_display": "SuperGrok" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-06-01T00:00:00Z",
                    "end": "2026-06-08T00:00:00Z"
                },
                "productUsage": [
                    { "product": "PRODUCT_GROK", "usagePercent": 10.0 },
                    { "product": "PRODUCT_GROK_BUILD", "usagePercent": 61.2 }
                ]
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert_eq!(usage.windows[0].used_percent, Some(61.2));
    }

    #[test]
    fn grok_usage_ignores_chat_free_tier_when_coding_window_exists() {
        let settings = json!({ "subscription_tier_display": "Free" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-09-04T13:59:50.639993+00:00",
                    "end": "2026-09-11T13:59:50.639993+00:00"
                }
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert!(usage.plan_type.is_none());
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
    }

    #[test]
    fn grok_usage_reads_heavy_from_jwt_when_settings_report_free() {
        let settings = json!({ "subscription_tier_display": "Free" });
        let billing = json!({
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-09-04T13:59:50.639993+00:00",
                    "end": "2026-09-11T13:59:50.639993+00:00"
                }
            }
        });
        let token = "eyJhbGciOiJub25lIn0.eyJleHAiOjE3ODcwNDE1MDYsInRpZXIiOjV9.sig";
        let usage = map_grok_plan_usage_for(&settings, &billing, Some(token));
        assert_eq!(usage.plan_type.as_deref(), Some("SuperGrok Heavy"));
        assert_eq!(usage.windows[0].id, "weekly");
    }

    #[test]
    fn grok_usage_skips_payg_month_without_a_usable_limit() {
        let settings = json!({ "subscription_tier_display": "SuperGrok Heavy" });
        let billing = json!({
            "config": {
                "monthlyLimit": { "val": 0 },
                "used": { "val": 157 },
                "onDemandCap": { "val": 0 },
                "billingPeriodStart": "2026-09-01T00:00:00+00:00",
                "billingPeriodEnd": "2026-10-01T00:00:00+00:00"
            }
        });
        let usage = map_grok_plan_usage(&settings, &billing);
        assert!(usage.windows.is_empty());
    }

    #[test]
    fn cursor_usage_maps_official_pools_and_plan() {
        let period = json!({
            "billingCycleStart": "1786771054000",
            "billingCycleEnd": "1789449454000",
            "planUsage": {
                "remaining": 32000,
                "limit": 40000,
                "autoPercentUsed": 12.5,
                "apiPercentUsed": 40.0,
                "totalPercentUsed": 20.0
            }
        });
        let plan_info = json!({
            "planInfo": { "planName": "Ultra", "includedAmountCents": 40000 }
        });
        let usage = map_cursor_plan_usage(&period, Some(&plan_info));
        assert_eq!(usage.plan_type.as_deref(), Some("Ultra"));
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].id, "cursor_models");
        assert_eq!(usage.windows[0].used_percent, Some(12.5));
        assert_eq!(usage.windows[1].id, "other_models");
        assert_eq!(usage.windows[1].used_percent, Some(40.0));
        assert_eq!(usage.credits.unwrap().balance.as_deref(), Some("320.00"));
    }

    #[test]
    fn cursor_usage_falls_back_to_total_percent() {
        let period = json!({
            "billingCycleEnd": 1_789_449_454_000_i64,
            "planUsage": { "totalPercentUsed": 8.0 }
        });
        let usage = map_cursor_plan_usage(&period, None);
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "monthly");
        assert_eq!(usage.windows[0].used_percent, Some(8.0));
        assert!(usage.plan_type.is_none());
    }

    #[test]
    fn unsupported_agents_report_unavailable() {
        let agent_id = AgentId::parse("gemini").expect("valid agent id");
        let result = tokio_test_block_on(probe_plan_usage(&agent_id));
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
