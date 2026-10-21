//! Antigravity subscription quota.
//!
//! The ACP server stores the Google OAuth client and refresh token in
//! `$GEMINI_HOME/antigravity-acp/acp_token.json` when Settings login finishes.
//! Quota is then the same Cloud Code summary the Antigravity app reads. This
//! probe does not spawn the Antigravity CLI and does not start a second login.

use std::{path::Path, time::Duration};

use serde_json::{Value, json};

use crate::{
    antigravity_auth::antigravity_acp_dir,
    plan_usage::{
        AgentPlanUsage, PlanProbeContext, PlanUsageResult, PlanUsageUnavailableReason,
        PlanUsageWindow,
    },
};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DAILY_BASE: &str = "https://daily-cloudcode-pa.googleapis.com";
const PROD_BASE: &str = "https://cloudcode-pa.googleapis.com";
const USER_AGENT: &str = "antigravity/acp";
const TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn probe_antigravity_plan_usage(context: &PlanProbeContext) -> PlanUsageResult {
    let home = dirs::home_dir();
    let acp_dir = match antigravity_acp_dir(&context.environment, home.as_deref()) {
        Ok(dir) => dir,
        Err(_) => {
            return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
        }
    };
    if !subscription_auth_allowed(&acp_dir.join("settings.json")) {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    }
    let token_path = acp_dir.join("acp_token.json");
    let Ok(raw) = std::fs::read_to_string(&token_path) else {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    };
    let Ok(mut token) = serde_json::from_str::<Value>(&raw) else {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    };
    let Some(refresh_token) = text_field(&token, "refresh_token") else {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    };
    let client_id = text_field(&token, "client_id").unwrap_or_default();
    let client_secret = text_field(&token, "client_secret").unwrap_or_default();
    if client_id.is_empty() || refresh_token.is_empty() {
        return PlanUsageResult::unavailable(PlanUsageUnavailableReason::NotLoggedIn);
    }

    let client = match reqwest::Client::builder().timeout(TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => return PlanUsageResult::error(error.to_string()),
    };
    let token_uri = text_field(&token, "token_uri").unwrap_or_else(|| TOKEN_URL.to_string());
    let access = match refresh_access_token(
        &client,
        &token_uri,
        &client_id,
        &client_secret,
        &refresh_token,
    )
    .await
    {
        Ok(access) => access,
        Err(result) => return result,
    };
    if let Some(rotated) = access.refresh_token.as_deref()
        && rotated != refresh_token
    {
        token["refresh_token"] = json!(rotated);
        let _ = write_token(&token_path, &token);
    }

    let project = text_field(&token, "project_id").unwrap_or_default();
    let load = match cloud_code(
        &client,
        PROD_BASE,
        "/v1internal:loadCodeAssist",
        &access.access_token,
        &json!({ "metadata": { "ideType": "ANTIGRAVITY" } }),
    )
    .await
    {
        Ok(value) => value,
        Err(result) => return result,
    };
    let project = if project.is_empty() {
        project_id_from(&load)
    } else {
        project
    };
    let project_body = if project.is_empty() {
        json!({})
    } else {
        json!({ "project": project })
    };

    // The daily host is what the Antigravity CLI reads, but it can omit a model
    // group that production still returns. Keep the daily window when both
    // answer the same group, and keep a group that only one host returned.
    let mut windows: Vec<PlanUsageWindow> = Vec::new();
    let mut last_error = None;
    for base in [DAILY_BASE, PROD_BASE] {
        match cloud_code(
            &client,
            base,
            "/v1internal:retrieveUserQuotaSummary",
            &access.access_token,
            &project_body,
        )
        .await
        {
            Ok(summary) => {
                for window in windows_from_quota_summary(&summary) {
                    if windows.iter().any(|existing| existing.id == window.id) {
                        continue;
                    }
                    windows.push(window);
                }
            }
            Err(result) => {
                if matches!(
                    result,
                    PlanUsageResult::Unavailable {
                        reason: PlanUsageUnavailableReason::TokenExpired
                    }
                ) {
                    return result;
                }
                last_error = Some(result);
            }
        }
    }
    if !windows.is_empty() {
        windows.sort_by(|left, right| window_rank(&left.id).cmp(&window_rank(&right.id)));
        return PlanUsageResult::Ok {
            usage: AgentPlanUsage {
                plan_type: plan_name_from_load(&load),
                windows,
                credits: None,
            },
        };
    }

    match cloud_code(
        &client,
        PROD_BASE,
        "/v1internal:retrieveUserQuota",
        &access.access_token,
        &project_body,
    )
    .await
    {
        Ok(quota) => {
            let windows = windows_from_model_buckets(&quota);
            if windows.is_empty() {
                last_error.unwrap_or_else(|| {
                    PlanUsageResult::error("Antigravity returned no quota windows.")
                })
            } else {
                PlanUsageResult::Ok {
                    usage: AgentPlanUsage {
                        plan_type: plan_name_from_load(&load),
                        windows,
                        credits: None,
                    },
                }
            }
        }
        Err(result) => last_error.unwrap_or(result),
    }
}

struct AccessToken {
    access_token: String,
    refresh_token: Option<String>,
}

async fn refresh_access_token(
    client: &reqwest::Client,
    token_uri: &str,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<AccessToken, PlanUsageResult> {
    let body = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        form_encode(client_id),
        form_encode(client_secret),
        form_encode(refresh_token)
    );
    let response = client
        .post(token_uri)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|error| {
            PlanUsageResult::error(format!("Antigravity token refresh failed: {error}"))
        })?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::BAD_REQUEST {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    }
    if !status.is_success() {
        return Err(PlanUsageResult::error(format!(
            "Antigravity token refresh failed ({status})"
        )));
    }
    let Some(access_token) = text_field(&payload, "access_token") else {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    };
    Ok(AccessToken {
        access_token,
        refresh_token: text_field(&payload, "refresh_token"),
    })
}

async fn cloud_code(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    access_token: &str,
    body: &Value,
) -> Result<Value, PlanUsageResult> {
    let response = client
        .post(format!("{base}{path}"))
        .bearer_auth(access_token)
        .header("user-agent", USER_AGENT)
        .header("accept", "*/*")
        .json(body)
        .send()
        .await
        .map_err(|error| {
            PlanUsageResult::error(format!("Antigravity quota request failed: {error}"))
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(PlanUsageResult::unavailable(
            PlanUsageUnavailableReason::TokenExpired,
        ));
    }
    if status == reqwest::StatusCode::FORBIDDEN && text.contains("accounts.google.com") {
        return Err(PlanUsageResult::error(
            "Antigravity needs account verification before quota can be read.",
        ));
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(PlanUsageResult::error(
            "Antigravity quota endpoint rejected the ACP login.",
        ));
    }
    if !status.is_success() {
        return Err(PlanUsageResult::error(format!(
            "Antigravity quota request failed ({status})"
        )));
    }
    serde_json::from_str(&text)
        .map_err(|_| PlanUsageResult::error("Antigravity quota response was not JSON."))
}

fn subscription_auth_allowed(settings_path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(settings_path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return true;
    };
    match value
        .pointer("/auth/type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        None | Some("oauth-personal" | "oauth-business") => true,
        Some(_) => false,
    }
}

fn write_token(path: &Path, token: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(token).unwrap_or_default();
    let tmp = path.with_extension("json.vibex-tmp");
    std::fs::write(&tmp, bytes)?;
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path)?;
    }
    Ok(())
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn form_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn project_id_from(value: &Value) -> String {
    for container in [value, value.get("response").unwrap_or(&Value::Null)] {
        for key in ["cloudaicompanionProject", "projectId", "project"] {
            let Some(project) = container.get(key) else {
                continue;
            };
            if let Some(id) = project.as_str().map(str::trim).filter(|id| !id.is_empty()) {
                return id.to_string();
            }
            for nested in ["value", "id", "projectId"] {
                if let Some(id) = project
                    .get(nested)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                {
                    return id.to_string();
                }
            }
        }
    }
    String::new()
}

fn plan_name_from_load(response: &Value) -> Option<String> {
    if let Some(plan) = text_field(response, "planType").or_else(|| {
        response
            .get("planInfo")
            .and_then(|info| text_field(info, "planType"))
    }) {
        return Some(plan);
    }
    let paid = response.get("paidTier")?;
    let paid_id = text_field(paid, "id")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if paid_id == "g1-pro-tier" {
        return Some("Pro".to_string());
    }
    text_field(paid, "name").or_else(|| {
        let current = response.get("currentTier")?;
        match text_field(current, "id").unwrap_or_default().as_str() {
            "standard-tier" => Some("Paid".to_string()),
            "legacy-tier" => Some("Legacy".to_string()),
            "free-tier" => Some("Free".to_string()),
            _ => text_field(current, "name"),
        }
    })
}

fn windows_from_quota_summary(payload: &Value) -> Vec<PlanUsageWindow> {
    let summary = payload
        .get("response")
        .or_else(|| payload.get("summary"))
        .unwrap_or(payload);
    let Some(groups) = summary.get("groups").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut windows = Vec::new();
    for group in groups {
        let group_name = quota_group_name(
            group
                .get("displayName")
                .or_else(|| group.get("display_name"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        for bucket in buckets {
            let Some(kind) = quota_bucket_kind(bucket) else {
                continue;
            };
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(remaining) = remaining_fraction(bucket) else {
                continue;
            };
            windows.push(PlanUsageWindow {
                id: window_id(&group_name, kind),
                used_percent: Some(used_percent(remaining)),
                window_minutes: Some(if kind == "session" { 300 } else { 10_080 }),
                resets_at_ms: reset_millis(
                    bucket.get("resetTime").or_else(|| bucket.get("reset_time")),
                ),
            });
        }
    }
    windows.sort_by(|left, right| window_rank(&left.id).cmp(&window_rank(&right.id)));
    windows
}

fn windows_from_model_buckets(payload: &Value) -> Vec<PlanUsageWindow> {
    let buckets = payload
        .get("buckets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut pools: Vec<(&str, f64, Option<i64>)> = Vec::new();
    for bucket in &buckets {
        let model_id = bucket
            .get("modelId")
            .or_else(|| bucket.get("model_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if model_id.is_empty() {
            continue;
        }
        let Some(remaining) = remaining_fraction(bucket) else {
            continue;
        };
        let pool = pool_for_model(model_id);
        let reset = reset_millis(bucket.get("resetTime").or_else(|| bucket.get("reset_time")));
        if let Some(existing) = pools.iter_mut().find(|(name, _, _)| *name == pool) {
            if remaining < existing.1 {
                *existing = (pool, remaining, reset);
            }
        } else {
            pools.push((pool, remaining, reset));
        }
    }
    let order = ["gemini_pro", "gemini_flash", "claude_pool", "argon_pool"];
    order
        .iter()
        .filter_map(|id| {
            pools
                .iter()
                .find(|(name, _, _)| name == id)
                .map(|(_, remaining, reset)| PlanUsageWindow {
                    id: (*id).to_string(),
                    used_percent: Some(used_percent(*remaining)),
                    window_minutes: None,
                    resets_at_ms: *reset,
                })
        })
        .collect()
}

fn quota_group_name(display_name: &str) -> String {
    let lower = display_name.trim().to_ascii_lowercase();
    if lower == "gemini" || lower == "gemini models" {
        return "Gemini".to_string();
    }
    if lower.contains("claude") || lower.contains("gpt") {
        return "Claude/GPT".to_string();
    }
    if lower.contains("argon") {
        return "Gemini 4 Argon".to_string();
    }
    if display_name.trim().is_empty() {
        "Quota".to_string()
    } else {
        display_name.trim().to_string()
    }
}

fn quota_bucket_kind(bucket: &Value) -> Option<&'static str> {
    // Cloud Code labels the buckets "Weekly Limit Remaining" and
    // "Five Hour Limit Remaining". Matching only the bare word drops them.
    for key in [
        "window",
        "bucketId",
        "bucket_id",
        "displayName",
        "display_name",
    ] {
        let Some(raw) = bucket.get(key).and_then(Value::as_str) else {
            continue;
        };
        let normalized = raw.trim().to_ascii_lowercase().replace(['_', '-'], " ");
        if normalized.contains("weekly") {
            return Some("weekly");
        }
        if normalized.contains("session")
            || normalized.contains("five hour")
            || normalized.contains("5 hour")
            || normalized.contains("5h")
        {
            return Some("session");
        }
    }
    None
}

fn window_id(group: &str, kind: &str) -> String {
    let group_id = match group {
        "Gemini" => "gemini",
        "Claude/GPT" => "claude_gpt",
        "Gemini 4 Argon" => "argon",
        _ => "quota",
    };
    let period = if kind == "session" {
        "five_hour"
    } else {
        "weekly"
    };
    format!("{group_id}_{period}")
}

fn window_rank(id: &str) -> u8 {
    match id {
        "gemini_five_hour" => 0,
        "gemini_weekly" => 1,
        "claude_gpt_five_hour" => 2,
        "claude_gpt_weekly" => 3,
        "argon_five_hour" => 4,
        "argon_weekly" => 5,
        _ => 6,
    }
}

fn pool_for_model(model_id: &str) -> &'static str {
    let lower = model_id.to_ascii_lowercase();
    if lower.contains("argon") {
        "argon_pool"
    } else if lower.contains("gemini") && lower.contains("pro") {
        "gemini_pro"
    } else if lower.contains("gemini") && lower.contains("flash") {
        "gemini_flash"
    } else {
        "claude_pool"
    }
}

fn remaining_fraction(bucket: &Value) -> Option<f64> {
    number_value(bucket.get("remainingFraction"))
        .or_else(|| number_value(bucket.get("remaining_fraction")))
        .or_else(|| {
            bucket
                .get("remaining")
                .and_then(|remaining| number_value(remaining.get("remainingFraction")))
        })
        .map(|value| value.clamp(0.0, 1.0))
}

fn number_value(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|number| number as f64))
        .or_else(|| value.as_str().and_then(|raw| raw.trim().parse().ok()))
}

fn used_percent(remaining: f64) -> f64 {
    let used = (100.0 - remaining * 100.0).clamp(0.0, 100.0);
    (used * 100.0).round() / 100.0
}

fn reset_millis(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_f64() {
        let millis = if number > 20_000_000_000.0 {
            number
        } else {
            number * 1000.0
        };
        return Some(millis as i64);
    }
    if let Some(number) = value.as_i64() {
        return Some(if number > 20_000_000_000 {
            number
        } else {
            number * 1000
        });
    }
    let text = value.as_str()?;
    chrono_millis(text)
}

fn chrono_millis(text: &str) -> Option<i64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    Some(parsed.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultra_plan_and_grouped_windows_come_from_the_quota_summary() {
        let load = json!({
            "currentTier": { "id": "free-tier", "name": "Free" },
            "paidTier": { "id": "g1-ultra-tier", "name": "Google AI Ultra" }
        });
        assert_eq!(
            plan_name_from_load(&load).as_deref(),
            Some("Google AI Ultra")
        );

        let summary = json!({
            "groups": [
                {
                    "displayName": "Claude and GPT models",
                    "buckets": [
                        {
                            "displayName": "Weekly Limit Remaining",
                            "remainingFraction": 0.4,
                            "resetTime": "2026-10-27T00:00:00Z"
                        },
                        {
                            "displayName": "Five Hour Limit Remaining",
                            "remainingFraction": 1,
                            "resetTime": "2026-10-20T12:00:00Z"
                        }
                    ]
                },
                {
                    "displayName": "Gemini Models",
                    "buckets": [
                        {
                            "displayName": "Five Hour Limit Remaining",
                            "remainingFraction": 0.9,
                            "resetTime": "2026-10-20T12:00:00Z"
                        },
                        { "displayName": "Weekly Limit", "remainingFraction": 0.5, "disabled": true }
                    ]
                }
            ]
        });
        let windows = windows_from_quota_summary(&summary);
        assert_eq!(
            windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "gemini_five_hour",
                "claude_gpt_five_hour",
                "claude_gpt_weekly"
            ]
        );
        assert_eq!(windows[0].used_percent, Some(10.0));
        assert_eq!(windows[0].window_minutes, Some(300));
        assert_eq!(windows[1].used_percent, Some(0.0));
        assert_eq!(windows[2].used_percent, Some(60.0));
        assert_eq!(windows[2].window_minutes, Some(10_080));
        assert!(windows[2].resets_at_ms.is_some());

        let live_shape = json!({
            "groups": [{
                "displayName": "Gemini Models",
                "buckets": [
                    {
                        "window": "weekly",
                        "bucketId": "gemini-weekly",
                        "displayName": "Weekly Limit Remaining",
                        "remainingFraction": 0.92
                    },
                    {
                        "window": "5h",
                        "bucketId": "gemini-5h",
                        "displayName": "Five Hour Limit Remaining",
                        "remainingFraction": 1
                    }
                ]
            }]
        });
        let live_windows = windows_from_quota_summary(&live_shape);
        assert_eq!(
            live_windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gemini_five_hour", "gemini_weekly"]
        );
    }

    #[test]
    fn legacy_model_buckets_collapse_into_pools() {
        let quota = json!({
            "buckets": [
                { "modelId": "gemini-3-pro", "remainingFraction": 0.2 },
                { "modelId": "gemini-3-flash", "remainingFraction": 0.8 },
                { "modelId": "claude-sonnet", "remainingFraction": 0.1 }
            ]
        });
        let windows = windows_from_model_buckets(&quota);
        assert_eq!(windows[0].id, "gemini_pro");
        assert_eq!(windows[0].used_percent, Some(80.0));
        assert_eq!(windows[1].id, "gemini_flash");
        assert_eq!(windows[2].id, "claude_pool");
    }

    #[test]
    fn api_key_auth_is_not_a_subscription() {
        let dir = std::env::temp_dir().join(format!("vibex-agy-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"auth":{"type":"gemini-api-key"}}"#,
        )
        .unwrap();
        assert!(!subscription_auth_allowed(&dir.join("settings.json")));
        std::fs::write(
            dir.join("settings.json"),
            r#"{"auth":{"type":"oauth-personal"}}"#,
        )
        .unwrap();
        assert!(subscription_auth_allowed(&dir.join("settings.json")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
