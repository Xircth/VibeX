use std::path::Path;

use db::DBService;
use remote_protocol::{
    CreatePairingRequest, IssuedPairingInvitation, PairingInvitationPayload, ReachabilityOrigin,
};

use crate::{
    AuthenticatedCredential, PairingCommand, ServerAuth, SqliteServerAuth, auth::AuthStoreError,
};

#[derive(Debug, thiserror::Error)]
pub enum PairingCliError {
    #[error("{0}")]
    Database(String),
    #[error("{0}")]
    HostIdentity(String),
    #[error("{0}")]
    Auth(#[from] AuthStoreError),
}

pub async fn issue_host_pairing(
    data_dir: &Path,
    command: PairingCommand,
    port: u16,
) -> Result<IssuedPairingInvitation, PairingCliError> {
    let db = DBService::new_at(data_dir)
        .await
        .map_err(|error| PairingCliError::Database(error.to_string()))?;
    let host_id = utils::assets::load_or_create_host_id(data_dir)
        .map_err(|error| PairingCliError::HostIdentity(error.to_string()))?;
    let auth = SqliteServerAuth::new(db.pool);
    let challenge = auth
        .create_pairing(
            &AuthenticatedCredential::host_console_owner(),
            CreatePairingRequest {
                preset: Some(command.preset),
                requested_scopes: Vec::new(),
                ttl_seconds: Some(command.ttl_seconds),
            },
        )
        .await?;
    let reachability = utils::net::advertised_http_origins(port, true)
        .into_iter()
        .filter(|origin| !remote_protocol::is_loopback_origin(origin))
        .map(ReachabilityOrigin::lan)
        .collect::<Vec<_>>();
    let payload =
        PairingInvitationPayload::from_challenge(host_id, command.preset, &challenge, reachability);
    Ok(IssuedPairingInvitation::from_payload(challenge, payload))
}

pub fn format_pairing_console(issued: &IssuedPairingInvitation) -> String {
    let mut out = format!(
        "Connection code  {}\nExpires          {}\nPreset           {}\n",
        issued.connection_code, issued.expires_at, issued.preset
    );
    out.push_str("Invitation\n  ");
    out.push_str(&issued.invitation);
    out.push('\n');
    if issued.reachability.is_empty() {
        out.push_str("Addresses\n  (none)\n");
    } else {
        out.push_str("Addresses\n");
        for origin in &issued.reachability {
            out.push_str("  ");
            out.push_str(&origin.origin);
            out.push('\n');
        }
    }
    out
}

pub async fn run_pairing_command(command: PairingCommand) -> std::process::ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let port = std::env::var("VIBEX_SERVER_LISTEN")
        .ok()
        .and_then(|value| {
            value
                .parse::<std::net::SocketAddr>()
                .ok()
                .map(|address| address.port())
                .or_else(|| value.parse().ok())
        })
        .unwrap_or(17891);
    match issue_host_pairing(&data_dir, command, port).await {
        Ok(issued) => {
            print!("{}", format_pairing_console(&issued));
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use remote_protocol::{DevicePermissionPreset, is_connection_code};

    use super::{PairingCommand, format_pairing_console, issue_host_pairing};

    #[tokio::test]
    async fn host_pairing_command_issues_a_week_long_connection_code() {
        let data_dir = tempfile::tempdir().expect("data dir");
        let week = 7 * 24 * 60 * 60;
        let issued = issue_host_pairing(
            data_dir.path(),
            PairingCommand {
                preset: DevicePermissionPreset::Companion,
                ttl_seconds: week,
            },
            17891,
        )
        .await
        .expect("issue pairing");

        assert!(is_connection_code(&issued.connection_code));
        assert_eq!(issued.preset, "companion");
        let expires = chrono::DateTime::parse_from_rfc3339(&issued.expires_at)
            .expect("expires_at")
            .timestamp();
        let remaining = expires - chrono::Utc::now().timestamp();
        assert!(
            (week - 15..=week + 15).contains(&remaining),
            "expected ~7d remaining, got {remaining}"
        );
        let printed = format_pairing_console(&issued);
        assert!(printed.contains(&issued.connection_code));
        assert!(printed.contains("vibex-pairing:"));
    }
}
