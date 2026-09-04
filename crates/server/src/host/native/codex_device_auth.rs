use std::{path::Path, time::Duration};

use api_types::{CodexDeviceCodePollView, CodexDeviceCodeView};
use base64::Engine;
use serde::Deserialize;

const OAUTH_ISSUER: &str = "https://auth.openai.com";
const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(
        default = "default_interval",
        deserialize_with = "deserialize_interval"
    )]
    interval: u64,
}

#[derive(Deserialize)]
struct DeviceTokenResponse {
    authorization_code: String,
    code_verifier: String,
}

#[derive(Deserialize)]
struct OAuthTokenResponse {
    id_token: String,
    access_token: String,
    refresh_token: String,
}

fn default_interval() -> u64 {
    5
}

fn deserialize_interval<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de;
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| de::Error::custom("设备码轮询间隔必须是正整数")),
        serde_json::Value::String(value) => value.trim().parse().map_err(de::Error::custom),
        _ => Err(de::Error::custom("设备码轮询间隔格式无效")),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("创建 Codex 登录客户端失败：{error}"))
}

pub async fn request_device_code() -> Result<CodexDeviceCodeView, String> {
    let response = client()?
        .post(format!("{OAUTH_ISSUER}/api/accounts/deviceauth/usercode"))
        .json(&serde_json::json!({ "client_id": OAUTH_CLIENT_ID }))
        .send()
        .await
        .map_err(|error| format!("请求 Codex 设备码失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("Codex 设备码服务返回 HTTP {}", response.status()));
    }
    let code: DeviceCodeResponse = response
        .json()
        .await
        .map_err(|error| format!("解析 Codex 设备码失败：{error}"))?;
    Ok(CodexDeviceCodeView {
        user_code: code.user_code,
        verification_url: format!("{OAUTH_ISSUER}/codex/device"),
        device_auth_id: code.device_auth_id,
        interval: u32::try_from(code.interval.max(1)).unwrap_or(u32::MAX),
    })
}

pub async fn poll_device_code(
    codex_home: &Path,
    device_auth_id: String,
    user_code: String,
) -> Result<CodexDeviceCodePollView, String> {
    if device_auth_id.trim().is_empty() || user_code.trim().is_empty() {
        return Err("Codex 设备码会话无效".to_string());
    }
    let client = client()?;
    let response = client
        .post(format!("{OAUTH_ISSUER}/api/accounts/deviceauth/token"))
        .json(&serde_json::json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }))
        .send()
        .await
        .map_err(|error| format!("轮询 Codex 登录失败：{error}"))?;
    if !response.status().is_success() {
        return Ok(CodexDeviceCodePollView {
            status: "pending".to_string(),
            message: None,
        });
    }
    let code: DeviceTokenResponse = response
        .json()
        .await
        .map_err(|error| format!("解析 Codex 授权响应失败：{error}"))?;
    let redirect_uri = format!("{OAUTH_ISSUER}/deviceauth/callback");
    let response = client
        .post(format!("{OAUTH_ISSUER}/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.authorization_code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", OAUTH_CLIENT_ID),
            ("code_verifier", code.code_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("交换 Codex 登录令牌失败：{error}"))?;
    if !response.status().is_success() {
        return Ok(CodexDeviceCodePollView {
            status: "error".to_string(),
            message: Some(format!("Codex 令牌服务返回 HTTP {}", response.status())),
        });
    }
    let tokens: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|error| format!("解析 Codex 登录令牌失败：{error}"))?;
    let document = auth_document(&tokens);
    super::write_json_document(&codex_home.join("auth.json"), &document, true).await?;
    Ok(CodexDeviceCodePollView {
        status: "success".to_string(),
        message: None,
    })
}

fn extract_account_id(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&decoded)
        .ok()?
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

fn auth_document(tokens: &OAuthTokenResponse) -> serde_json::Value {
    serde_json::json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": tokens.id_token,
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "account_id": extract_account_id(&tokens.id_token).unwrap_or_default(),
        },
        "last_refresh": chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::{OAuthTokenResponse, auth_document, extract_account_id};

    #[test]
    fn extracts_chatgpt_account_id_from_id_token() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}"#);
        assert_eq!(
            extract_account_id(&format!("header.{payload}.signature")).as_deref(),
            Some("acct-1")
        );
    }

    #[test]
    fn persisted_auth_document_uses_chatgpt_mode_without_api_key() {
        let document = auth_document(&OAuthTokenResponse {
            id_token: "header.e30.signature".to_string(),
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
        });
        assert_eq!(document["auth_mode"], "chatgpt");
        assert!(document["OPENAI_API_KEY"].is_null());
        assert_eq!(document["tokens"]["access_token"], "access");
    }
}
