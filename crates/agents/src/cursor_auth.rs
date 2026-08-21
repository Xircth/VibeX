//! Official local Cursor account evidence.
//!
//! `cursor-agent login` stores the subscription token in the platform secret
//! store, not in `cli-config.json`. File-shaped `account_evidence` therefore
//! cannot see a completed login.

pub async fn cursor_account_token() -> Option<String> {
    read_cursor_keychain_token().await
}

#[cfg(target_os = "macos")]
async fn read_cursor_keychain_token() -> Option<String> {
    use workspace_utils::process::new_hidden_tokio_command;

    let output = new_hidden_tokio_command(
        "security",
        [
            "find-generic-password",
            "-s",
            "cursor-access-token",
            "-a",
            "cursor-user",
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
async fn read_cursor_keychain_token() -> Option<String> {
    None
}
