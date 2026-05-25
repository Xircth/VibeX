use crate::is_wsl2;

const WSL_BROWSER_PROGRAM: &str = "powershell.exe";
const WSL_BROWSER_SCRIPT: &str = "Start-Process -FilePath $args[0]";

#[derive(Debug, PartialEq, Eq)]
struct BrowserCommandParts<'a> {
    program: &'static str,
    args: [&'a str; 4],
}

/// Validate that a URL is safe to hand to the external browser launcher.
fn validate_browser_url(url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Keep the historical URL whitelist until call-site behavior is fully
    // mapped. The PowerShell script no longer depends on this for escaping.
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

fn wsl_browser_command_parts(
    url: &str,
) -> Result<BrowserCommandParts<'_>, Box<dyn std::error::Error + Send + Sync>> {
    validate_browser_url(url)?;

    Ok(BrowserCommandParts {
        program: WSL_BROWSER_PROGRAM,
        args: ["-NoProfile", "-Command", WSL_BROWSER_SCRIPT, url],
    })
}

/// Open URL in browser with WSL2 support
pub async fn open_browser(url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if is_wsl2() {
        let command = wsl_browser_command_parts(url)?;
        let mut cmd = tokio::process::Command::new(command.program);
        cmd.args(command.args);
        crate::process::configure_tokio_command_no_window(&mut cmd);
        cmd.spawn()?;
        Ok(())
    } else {
        // Use the standard open crate for other platforms
        open::that(url).map_err(|e| e.into())
    }
}

#[cfg(test)]
mod tests {
    use super::wsl_browser_command_parts;

    #[test]
    fn wsl_browser_command_keeps_url_out_of_powershell_script() {
        let url = "https://example.com/path?query=1&next=%2Fok";

        let command = wsl_browser_command_parts(url).expect("valid URL");

        assert_eq!(command.program, "powershell.exe");
        assert_eq!(
            command.args,
            [
                "-NoProfile",
                "-Command",
                "Start-Process -FilePath $args[0]",
                url
            ]
        );
    }

    #[test]
    fn wsl_browser_command_rejects_non_http_protocols() {
        let err = wsl_browser_command_parts("file:///C:/Windows/System32/calc.exe")
            .expect_err("file protocol should be rejected");

        assert!(err.to_string().contains("http or https"));
    }
}
