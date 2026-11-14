//! Same-account device authorization.
//!
//! A device that presents a VibeX account token may connect directly when the token belongs
//! to the account signed in on the host. The host never trusts the identity a device claims:
//! both sides are resolved through the VibeX site. When same-account auto-connect is enabled
//! (the default), the host issues a Companion credential immediately and surfaces the 4-digit
//! SAS connection code on both screens for non-blocking visual verification.

use std::{path::Path, sync::OnceLock, time::Duration};

use async_trait::async_trait;
use serde_json::{Map, Value};

/// Keys the desktop frontend writes into the host's `frontend` settings section.
const HOST_ACCOUNT_TOKEN_KEY: &str = "__account_token_v1";
const HOST_ACCOUNT_OWNER_KEY: &str = "__account_owner_v1";
const HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY: &str = "__same_account_auto_connect_v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum AccountLinkError {
    #[error("this computer is not signed in to a VibeX account")]
    HostSignedOut,
    #[error("the VibeX account token is not valid")]
    InvalidToken,
    #[error("the VibeX account does not match the account signed in on this computer")]
    Mismatch,
    #[error("VibeX account verification is unavailable")]
    Unavailable,
}

impl AccountLinkError {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::HostSignedOut => "host_account_signed_out",
            Self::InvalidToken => "account_token_invalid",
            Self::Mismatch => "account_mismatch",
            Self::Unavailable => "account_verification_unavailable",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AccountIdentity {
    pub username: String,
    pub display_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedSameAccount {
    pub identity: AccountIdentity,
    /// Defaults to `true` unless the user explicitly turned off same-account auto-connect in Settings.
    pub auto_approve: bool,
}

#[async_trait]
pub(crate) trait AccountResolver: Send + Sync {
    async fn resolve(&self, token: &str) -> Result<AccountIdentity, AccountLinkError>;
}

/// Resolves account tokens through the VibeX site account API.
pub(crate) struct SiteAccountResolver {
    client: reqwest::Client,
    origin: String,
}

pub(crate) fn site_resolver() -> &'static SiteAccountResolver {
    static RESOLVER: OnceLock<SiteAccountResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| SiteAccountResolver {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default(),
        origin: utils::site_origin(),
    })
}

#[async_trait]
impl AccountResolver for SiteAccountResolver {
    async fn resolve(&self, token: &str) -> Result<AccountIdentity, AccountLinkError> {
        let response = self
            .client
            .get(format!("{}/api/modelrouter/desktop", self.origin))
            .bearer_auth(token)
            .header("user-agent", "VibeX")
            .send()
            .await
            .map_err(|_| AccountLinkError::Unavailable)?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AccountLinkError::InvalidToken);
        }
        if !response.status().is_success() {
            return Err(AccountLinkError::Unavailable);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| AccountLinkError::Unavailable)?;
        identity_from_user(body.get("user")).ok_or(AccountLinkError::InvalidToken)
    }
}

fn non_empty_str<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn identity_from_user(user: Option<&Value>) -> Option<AccountIdentity> {
    let username = non_empty_str(user, "username")?.to_owned();
    let display_name = non_empty_str(user, "displayName")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| username.clone());
    Some(AccountIdentity {
        username,
        display_name,
    })
}

struct HostAccount {
    owner_username: Option<String>,
    token: Option<String>,
    auto_approve: bool,
}

async fn read_host_account(settings_path: &Path) -> HostAccount {
    let frontend: Map<String, Value> =
        services::services::settings_store::read_section(settings_path, "frontend")
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
    let owner_username =
        non_empty_str(frontend.get(HOST_ACCOUNT_OWNER_KEY), "username").map(ToOwned::to_owned);
    let token = match frontend.get(HOST_ACCOUNT_TOKEN_KEY) {
        Some(Value::String(raw)) => Some(raw.trim()),
        Some(object @ Value::Object(_)) => non_empty_str(Some(object), "token"),
        _ => None,
    }
    .filter(|token| !token.is_empty())
    .map(ToOwned::to_owned);
    let auto_approve = match frontend.get(HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(raw)) => !raw.trim().eq_ignore_ascii_case("false"),
        _ => true,
    };
    HostAccount {
        owner_username,
        token,
        auto_approve,
    }
}

/// Verifies that `device_token` belongs to the account signed in on this host and returns
/// that account's identity along with the host's auto-approve preference.
pub(crate) async fn verify_same_account(
    settings_path: &Path,
    resolver: &dyn AccountResolver,
    device_token: &str,
) -> Result<VerifiedSameAccount, AccountLinkError> {
    let host = read_host_account(settings_path).await;
    if host.owner_username.is_none() && host.token.is_none() {
        return Err(AccountLinkError::HostSignedOut);
    }
    let device = resolver.resolve(device_token).await?;
    let owner_username = match host.owner_username {
        Some(username) => username,
        None => match host.token {
            Some(token) => match resolver.resolve(&token).await {
                Ok(owner) => owner.username,
                Err(AccountLinkError::InvalidToken) => {
                    return Err(AccountLinkError::HostSignedOut);
                }
                Err(error) => return Err(error),
            },
            None => return Err(AccountLinkError::HostSignedOut),
        },
    };
    if device.username.eq_ignore_ascii_case(&owner_username) {
        Ok(VerifiedSameAccount {
            identity: device,
            auto_approve: host.auto_approve,
        })
    } else {
        Err(AccountLinkError::Mismatch)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    struct FakeResolver(HashMap<&'static str, &'static str>);

    #[async_trait]
    impl AccountResolver for FakeResolver {
        async fn resolve(&self, token: &str) -> Result<AccountIdentity, AccountLinkError> {
            match self.0.get(token) {
                Some(username) => Ok(AccountIdentity {
                    username: (*username).to_owned(),
                    display_name: format!("{username} display"),
                }),
                None => Err(AccountLinkError::InvalidToken),
            }
        }
    }

    fn resolver() -> FakeResolver {
        FakeResolver(HashMap::from([
            ("tok-alice", "alice"),
            ("tok-alice-2", "Alice"),
            ("tok-bob", "bob"),
        ]))
    }

    async fn settings_with(frontend: Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&json!({ "frontend": frontend })).unwrap(),
        )
        .await
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn accepts_device_of_the_host_owner() {
        let dir = settings_with(json!({
            HOST_ACCOUNT_OWNER_KEY: { "username": "alice", "displayName": "Alice" },
        }))
        .await;
        let verified = verify_same_account(
            &dir.path().join("settings.json"),
            &resolver(),
            "tok-alice-2",
        )
        .await
        .unwrap();
        assert_eq!(verified.identity.username, "Alice");
        assert!(verified.auto_approve);

        let manual_dir = settings_with(json!({
            HOST_ACCOUNT_OWNER_KEY: { "username": "alice", "displayName": "Alice" },
            HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY: false,
        }))
        .await;
        let manual = verify_same_account(
            &manual_dir.path().join("settings.json"),
            &resolver(),
            "tok-alice-2",
        )
        .await
        .unwrap();
        assert!(!manual.auto_approve);
    }

    #[tokio::test]
    async fn resolves_owner_from_host_token_when_owner_record_is_missing() {
        let dir = settings_with(json!({ HOST_ACCOUNT_TOKEN_KEY: "tok-alice" })).await;
        let path = dir.path().join("settings.json");
        assert!(
            verify_same_account(&path, &resolver(), "tok-alice")
                .await
                .is_ok()
        );
        assert_eq!(
            verify_same_account(&path, &resolver(), "tok-bob").await,
            Err(AccountLinkError::Mismatch)
        );
    }

    #[tokio::test]
    async fn rejects_other_accounts_and_invalid_tokens() {
        let dir = settings_with(json!({
        HOST_ACCOUNT_OWNER_KEY: { "username": "alice" },
        HOST_ACCOUNT_TOKEN_KEY: "tok-alice",
           }))
        .await;
        let path = dir.path().join("settings.json");
        assert_eq!(
            verify_same_account(&path, &resolver(), "tok-bob").await,
            Err(AccountLinkError::Mismatch)
        );
        assert_eq!(
            verify_same_account(&path, &resolver(), "forged").await,
            Err(AccountLinkError::InvalidToken)
        );
    }

    #[tokio::test]
    async fn rejects_when_host_is_signed_out() {
        let dir = settings_with(json!({})).await;
        let path = dir.path().join("settings.json");
        assert_eq!(
            verify_same_account(&path, &resolver(), "tok-alice").await,
            Err(AccountLinkError::HostSignedOut)
        );
        let missing = dir.path().join("missing.json");
        assert_eq!(
            verify_same_account(&missing, &resolver(), "tok-alice").await,
            Err(AccountLinkError::HostSignedOut)
        );
    }
}
