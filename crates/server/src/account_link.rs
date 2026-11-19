//! Same-account device authorization.
//!
//! A device that presents a Dimo account token may connect directly when the token belongs
//! to the account currently signed in on the host. The host never trusts the identity a device
//! claims or a stale cached owner record: both tokens are verified live through the Dimo site
//! account API and matched by immutable account ID (falling back to username only when absent).
//! When same-account auto-connect is enabled (the default), the host issues a Companion
//! credential immediately and surfaces the 4-digit SAS connection code on both screens for
//! non-blocking visual verification.

use std::{path::Path, sync::OnceLock, time::Duration};

use async_trait::async_trait;
use serde_json::{Map, Value};

/// Keys the desktop frontend writes into the host's `frontend` settings section.
const HOST_ACCOUNT_TOKEN_KEY: &str = "__account_token_v1";
const HOST_SAME_ACCOUNT_AUTO_CONNECT_KEY: &str = "__same_account_auto_connect_v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum AccountLinkError {
    #[error("this computer is not signed in to a Dimo account")]
    HostSignedOut,
    #[error("the Dimo account token is not valid")]
    InvalidToken,
    #[error("the Dimo account does not match the account signed in on this computer")]
    Mismatch,
    #[error("Dimo account verification is unavailable")]
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
    pub user_id: Option<String>,
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

/// Resolves account tokens through the Dimo site account API.
pub(crate) struct SiteAccountResolver {
    client: reqwest::Client,
}

pub(crate) fn site_resolver() -> &'static SiteAccountResolver {
    static RESOLVER: OnceLock<SiteAccountResolver> = OnceLock::new();
    RESOLVER.get_or_init(|| SiteAccountResolver {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default(),
    })
}

#[async_trait]
impl AccountResolver for SiteAccountResolver {
    async fn resolve(&self, token: &str) -> Result<AccountIdentity, AccountLinkError> {
        let origin = utils::site_origin();
        let response = self
            .client
            .get(format!("{origin}/api/modelrouter/desktop"))
            .bearer_auth(token)
            .header("user-agent", "Dimo")
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

fn non_empty_id(value: Option<&Value>, key: &str) -> Option<String> {
    match value?.get(key)? {
        Value::String(raw) => {
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Value::Number(num) => Some(num.to_string()),
        _ => None,
    }
}

fn identity_from_user(user: Option<&Value>) -> Option<AccountIdentity> {
    let username = non_empty_str(user, "username")?.to_owned();
    let user_id = non_empty_id(user, "id");
    let display_name = non_empty_str(user, "displayName")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| username.clone());
    Some(AccountIdentity {
        user_id,
        username,
        display_name,
    })
}

struct HostAccount {
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
        token,
        auto_approve,
    }
}

fn identities_match(device: &AccountIdentity, owner: &AccountIdentity) -> bool {
    match (&device.user_id, &owner.user_id) {
        (Some(device_id), Some(owner_id)) => device_id == owner_id,
        _ => device.username.eq_ignore_ascii_case(&owner.username),
    }
}

/// Verifies that `device_token` belongs to the account currently signed in on this host and
/// returns that account's identity along with the host's auto-approve preference.
pub(crate) async fn verify_same_account(
    settings_path: &Path,
    resolver: &dyn AccountResolver,
    device_token: &str,
) -> Result<VerifiedSameAccount, AccountLinkError> {
    let host = read_host_account(settings_path).await;
    let Some(host_token) = host.token else {
        return Err(AccountLinkError::HostSignedOut);
    };
    let trimmed_device_token = device_token.trim();
    if trimmed_device_token.is_empty() {
        return Err(AccountLinkError::InvalidToken);
    }
    if trimmed_device_token == host_token {
        let identity = resolver.resolve(trimmed_device_token).await?;
        return Ok(VerifiedSameAccount {
            identity,
            auto_approve: host.auto_approve,
        });
    }
    let (device_res, owner_res) = tokio::join!(
        resolver.resolve(trimmed_device_token),
        resolver.resolve(&host_token),
    );
    let owner = match owner_res {
        Ok(owner) => owner,
        Err(AccountLinkError::InvalidToken) => return Err(AccountLinkError::HostSignedOut),
        Err(error) => return Err(error),
    };
    let device = device_res?;
    if identities_match(&device, &owner) {
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

    struct FakeResolver(HashMap<&'static str, (&'static str, &'static str)>);

    #[async_trait]
    impl AccountResolver for FakeResolver {
        async fn resolve(&self, token: &str) -> Result<AccountIdentity, AccountLinkError> {
            match self.0.get(token) {
                Some((user_id, username)) => Ok(AccountIdentity {
                    user_id: (!user_id.is_empty()).then(|| (*user_id).to_owned()),
                    username: (*username).to_owned(),
                    display_name: format!("{username} display"),
                }),
                None => Err(AccountLinkError::InvalidToken),
            }
        }
    }

    fn resolver() -> FakeResolver {
        FakeResolver(HashMap::from([
            ("tok-alice", ("uid-alice", "alice")),
            ("tok-alice-2", ("uid-alice", "Alice")),
            ("tok-recycled-alice", ("uid-impersonator", "alice")),
            ("tok-bob", ("uid-bob", "bob")),
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
            "__account_owner_v1": { "username": "alice", "displayName": "Alice" },
            HOST_ACCOUNT_TOKEN_KEY: "tok-alice",
        }))
        .await;
        let verified = verify_same_account(
            &dir.path().join("settings.json"),
            &resolver(),
            "tok-alice-2",
        )
        .await
        .unwrap();
        assert_eq!(verified.identity.user_id.as_deref(), Some("uid-alice"));
        assert_eq!(verified.identity.username, "Alice");
        assert!(verified.auto_approve);

        let manual_dir = settings_with(json!({
            HOST_ACCOUNT_TOKEN_KEY: "tok-alice",
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
    async fn rejects_stale_owner_cache_when_host_token_is_missing_or_revoked() {
        let missing_token_dir = settings_with(json!({
            "__account_owner_v1": { "username": "alice", "displayName": "Alice" },
        }))
        .await;
        assert_eq!(
            verify_same_account(
                &missing_token_dir.path().join("settings.json"),
                &resolver(),
                "tok-alice-2",
            )
            .await,
            Err(AccountLinkError::HostSignedOut)
        );

        let revoked_token_dir = settings_with(json!({
            "__account_owner_v1": { "username": "alice", "displayName": "Alice" },
            HOST_ACCOUNT_TOKEN_KEY: "tok-revoked-host",
        }))
        .await;
        assert_eq!(
            verify_same_account(
                &revoked_token_dir.path().join("settings.json"),
                &resolver(),
                "tok-alice-2",
            )
            .await,
            Err(AccountLinkError::HostSignedOut)
        );
    }

    #[tokio::test]
    async fn rejects_recycled_username_when_immutable_user_id_differs() {
        let dir = settings_with(json!({
            HOST_ACCOUNT_TOKEN_KEY: "tok-alice",
        }))
        .await;
        assert_eq!(
            verify_same_account(
                &dir.path().join("settings.json"),
                &resolver(),
                "tok-recycled-alice",
            )
            .await,
            Err(AccountLinkError::Mismatch)
        );
    }

    #[tokio::test]
    async fn rejects_other_accounts_and_invalid_tokens() {
        let dir = settings_with(json!({
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
