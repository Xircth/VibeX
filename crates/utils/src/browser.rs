use crate::is_wsl2;

/// Validate that a URL contains only safe characters for shell execution.
/// Rejects any URL containing shell metacharacters that could enable injection.
fn validate_url(url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Only allow characters that are valid in URLs per RFC 3986
    // This whitelist approach prevents any shell metacharacter injection
    let is_safe = url.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                ':' | '/'
                    | '?'
                    | '#'
                    | '['
                    | ']'
                    | '@'
                    | '!'
                    | '$'
                    | '&'
                    | '('
                    | ')'
                    | '*'
                    | '+'
                    | ','
                    | ';'
                    | '='
                    | '-'
                    | '.'
                    | '_'
                    | '~'
                    | '%'
            )
    });

    if !is_safe {
        return Err(format!("URL contains invalid characters: {url}").into());
    }

    // Must start with a known protocol to prevent command injection via protocol handlers
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("URL must use http or https protocol: {url}").into());
    }

    Ok(())
}

/// Open URL in browser with WSL2 support
pub async fn open_browser(url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if is_wsl2() {
        // Validate URL before passing to any shell command
        validate_url(url)?;

        // In WSL2, use PowerShell Start-Process with the URL as a single
        // quoted argument. The URL has been validated to contain only safe
        // RFC 3986 characters (no single quotes, backticks, or other
        // PowerShell metacharacters), so single-quote wrapping is safe.
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.arg("-NoProfile")
            .arg("-Command")
            .arg(format!("Start-Process '{url}'"));
        crate::process::configure_tokio_command_no_window(&mut cmd);
        cmd.spawn()?;
        Ok(())
    } else {
        // Use the standard open crate for other platforms
        open::that(url).map_err(|e| e.into())
    }
}
