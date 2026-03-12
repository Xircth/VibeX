use crate::is_wsl2;

/// Open URL in browser with WSL2 support
pub async fn open_browser(url: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if is_wsl2() {
        // In WSL2, use PowerShell to open the browser
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.arg("-Command")
            .arg(format!("Start-Process '{url}'"));
        crate::process::configure_tokio_command_no_window(&mut cmd);
        cmd.spawn()?;
        Ok(())
    } else {
        // Use the standard open crate for other platforms
        open::that(url).map_err(|e| e.into())
    }
}
