use super::*;

pub(super) async fn ensure_managed_uv(managed_artifacts_dir: &Path) -> anyhow::Result<PathBuf> {
    let platform = current_platform();
    let artifact = managed_uv_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("uv is not supported on {platform}"))?;
    let final_executable = managed_uv_executable(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("could not resolve managed uv path"))?;
    if tokio::fs::metadata(&final_executable).await.is_ok() {
        println!(
            "Using managed uv {MANAGED_UV_VERSION}: {}",
            final_executable.display()
        );
        return Ok(final_executable);
    }

    let base = managed_artifacts_dir.join("agent-tools").join("uv");
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let filename = format!("uv-{}.{}", artifact.target, artifact.extension);
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{MANAGED_UV_VERSION}/{filename}"
    );
    println!("Downloading managed uv {MANAGED_UV_VERSION} ({platform})");
    let result = async {
        let bytes = download_archive(&url, MAX_MANAGED_TOOL_BYTES).await?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(artifact.sha256) {
            anyhow::bail!(
                "uv archive SHA-256 mismatch: expected {}, found {actual}",
                artifact.sha256
            );
        }
        extract_archive(&bytes, &url, &staging)?;
        let staged = staging
            .join(format!("uv-{}", artifact.target))
            .join(if cfg!(windows) { "uv.exe" } else { "uv" });
        let staged = if staged.is_file() {
            staged
        } else {
            find_staged_executable(&staging, if cfg!(windows) { "uv.exe" } else { "uv" })?
        };
        let version_root = base.join(MANAGED_UV_VERSION).join(&platform);
        tokio::fs::create_dir_all(&version_root).await?;
        let dest_dir = version_root.join(format!("uv-{}", artifact.target));
        tokio::fs::create_dir_all(&dest_dir).await?;
        let dest = dest_dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        tokio::fs::copy(&staged, &dest).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&dest).await?.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&dest, permissions).await?;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        println!("Managed uv {MANAGED_UV_VERSION} installed");
        Ok(dest)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

pub(super) async fn ensure_managed_bun(managed_artifacts_dir: &Path) -> anyhow::Result<PathBuf> {
    let platform = current_platform();
    let artifact = managed_bun_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("Bun is not supported on {platform}"))?;
    let final_executable = managed_bun_executable(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("could not resolve managed Bun path"))?;
    if tokio::fs::metadata(&final_executable).await.is_ok() {
        println!(
            "Using managed Bun {MANAGED_BUN_VERSION}: {}",
            final_executable.display()
        );
        return Ok(final_executable);
    }

    let base = managed_artifacts_dir.join("agent-tools").join("bun");
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let urls = managed_bun_download_urls(&artifact);
    println!("Downloading managed Bun {MANAGED_BUN_VERSION} ({platform})");
    let result = async {
        let (url, bytes) = download_archive_from(&urls, MAX_MANAGED_TOOL_BYTES).await?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(artifact.sha256) {
            anyhow::bail!(
                "Bun archive SHA-256 mismatch: expected {}, found {actual}",
                artifact.sha256
            );
        }
        extract_archive(&bytes, &url, &staging)?;
        let exe_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        let staged = staging
            .join(format!("bun-{}", artifact.target))
            .join(exe_name);
        let staged = if staged.is_file() {
            staged
        } else {
            find_staged_executable(&staging, exe_name)?
        };
        let version_root = base.join(MANAGED_BUN_VERSION).join(&platform);
        tokio::fs::create_dir_all(&version_root).await?;
        let dest_dir = version_root.join(format!("bun-{}", artifact.target));
        tokio::fs::create_dir_all(&dest_dir).await?;
        let dest = dest_dir.join(exe_name);
        tokio::fs::copy(&staged, &dest).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&dest).await?.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&dest, permissions).await?;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        println!("Managed Bun {MANAGED_BUN_VERSION} installed");
        Ok(dest)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

pub(super) async fn run_npm_global_install<F>(
    npm: &Path,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    node: Option<&NodeRuntime>,
    on_progress: &mut F,
) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    let cmd_line = format!(
        "$ npm install -g --force --prefix {} {}",
        user_env.npm_prefix.display(),
        component.resolved_source
    );
    println!("{cmd_line}");
    on_progress(55, &cmd_line);
    let mut command = utils::process::new_hidden_tokio_command(npm, std::iter::empty::<&str>());
    if std::env::var_os("NODE_USE_ENV_PROXY").is_none() {
        command.env("NODE_USE_ENV_PROXY", "1");
    }
    if let Some(runtime) = node {
        prepend_command_path(&mut command, &runtime.bin_dir);
        command.env("npm_config_prefix", &user_env.npm_prefix);
    }
    command.args(npm_global_install_args(
        &user_env.npm_prefix,
        &component.resolved_source,
    ));
    run_command_with_progress("npm install -g", command, 68, on_progress).await
}

pub(super) async fn install_npm<F>(
    component: &PlannedInstallComponent,
    user_env: &mut UserEnvironmentLayout,
    node: Option<&NodeRuntime>,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    let npm = node
        .map(|runtime| runtime.npm.clone())
        .or(utils::shell::resolve_executable_path("npm").await)
        .ok_or_else(|| anyhow::anyhow!("npm was not found; install Node.js and npm first"))?;
    if let Err(error) = run_npm_global_install(&npm, component, user_env, node, on_progress).await {
        let fallback = user_env.user_npm_prefix();
        if !npm_install_permission_denied(&error.to_string()) || fallback == user_env.npm_prefix {
            return Err(error);
        }
        println!("Permission denied, retrying with user prefix...");
        on_progress(
            62,
            &format!(
                "[npm] permission denied on global prefix, retrying with {}",
                fallback.display()
            ),
        );
        *user_env = user_env.clone().with_npm_prefix(fallback);
        prepare_user_environment(user_env).await?;
        run_npm_global_install(&npm, component, user_env, node, on_progress).await?;
    }
    let package = npm_spec_name(&component.resolved_source);
    let name = if command_is_placeholder(&component.command) {
        package.rsplit('/').next().unwrap_or(package.as_str())
    } else {
        Path::new(&component.command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&component.command)
    };
    let bin = resolve_npm_shim(&user_env.npm_bin, name).ok_or_else(|| {
        anyhow::anyhow!(
            "npm install did not produce `{}` under {}",
            name,
            user_env.npm_bin.display()
        )
    })?;
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(bin).await?,
    ))
}

pub(super) fn command_is_placeholder(command: &str) -> bool {
    command.is_empty() || command == "npm"
}

pub(super) async fn live_npm_global_prefix(node: Option<&NodeRuntime>) -> Option<PathBuf> {
    let npm = if let Some(runtime) = node {
        runtime.npm.clone()
    } else {
        utils::shell::resolve_executable_path(if cfg!(windows) { "npm.cmd" } else { "npm" }).await?
    };
    let mut command = utils::process::new_hidden_tokio_command(&npm, std::iter::empty::<&str>());
    if let Some(runtime) = node {
        prepend_command_path(&mut command, &runtime.bin_dir);
    }
    command.arg("prefix").arg("-g").kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let decoded = utils::process::decode_process_output(&output.stdout);
    let prefix = decoded.lines().next()?.trim().to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(PathBuf::from(prefix))
    }
}

pub(super) async fn install_uv<F>(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    uv: Option<&Path>,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    let uv = uv
        .map(Path::to_path_buf)
        .or(utils::shell::resolve_executable_path("uv").await)
        .ok_or_else(|| anyhow::anyhow!("uv was not found; install uv first"))?;
    let cmd_line = format!(
        "$ uv tool install --force --no-config {}",
        component.resolved_source
    );
    println!("$ uv tool install {}", component.resolved_source);
    on_progress(55, &cmd_line);
    let mut command = utils::process::new_hidden_tokio_command(&uv, std::iter::empty::<&str>());
    command
        .arg("tool")
        .arg("install")
        .arg("--force")
        .arg("--no-config");
    if component.resolved_source.starts_with("hermes-agent[") {
        command.arg("--python").arg("3.13");
    }
    command
        .arg(&component.resolved_source)
        .env("UV_TOOL_DIR", &user_env.uv_tool_dir)
        .env("UV_TOOL_BIN_DIR", &user_env.uv_tool_bin)
        .env("UV_PYTHON_INSTALL_DIR", &user_env.uv_python_dir)
        .env("UV_CACHE_DIR", &user_env.uv_cache_dir);
    run_command_with_progress("uv tool install", command, 68, on_progress).await?;
    let name = Path::new(&component.command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(component.command.as_str());
    let bin = if cfg!(windows) {
        user_env.uv_tool_bin.join(format!("{name}.exe"))
    } else {
        user_env.uv_tool_bin.join(name)
    };
    if tokio::fs::metadata(&bin).await.is_err() {
        anyhow::bail!("uv tool install did not produce `{}`", bin.display());
    }
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(bin).await?,
    ))
}

pub(super) async fn install_binary<F>(
    agent_id: &AgentId,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    on_progress: &mut F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(u8, &str),
{
    if is_kiro_official_installer(agent_id, &component.resolved_source) {
        on_progress(55, &format!("GET {}", component.resolved_source));
        return install_kiro_from_official_installer(component, user_env).await;
    }
    println!(
        "Downloading {} ({})",
        component.component_id, component.version
    );
    on_progress(55, &format!("GET {}", component.resolved_source));
    let bytes = reqwest::get(&component.resolved_source)
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    on_progress(
        65,
        &format!(
            "[download] {} ({} bytes)",
            component.component_id,
            bytes.len()
        ),
    );
    let staging = utils::path::unique_dimo_scratch_dir("agent")?;
    let extract_result = extract_archive(&bytes, &component.resolved_source, &staging);
    let staged =
        match extract_result.and_then(|_| find_staged_executable(&staging, &component.command)) {
            Ok(path) => path,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error);
            }
        };
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    let destination = user_bin_destination(&user_env.user_bin, &component.command, &staged);
    let siblings = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .map(|profile| profile.binary_required_siblings(cfg!(windows)))
        .unwrap_or(&[]);
    let install_result =
        install_staged_binary_and_siblings(&staged, &destination, &user_env.user_bin, siblings)
            .await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    install_result?;
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(destination).await?,
    ))
}

pub(super) async fn install_staged_binary_and_siblings(
    staged: &Path,
    destination: &Path,
    user_bin: &Path,
    siblings: &[&str],
) -> anyhow::Result<()> {
    replace_executable_file(staged, destination).await?;
    if let Some(staged_dir) = staged.parent() {
        for sibling in siblings {
            let name = Path::new(sibling)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(sibling);
            let source = staged_dir.join(name);
            if !source.is_file() {
                anyhow::bail!("extracted archive is missing required sibling `{name}`");
            }
            replace_executable_file(&source, &user_bin.join(name)).await?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(destination).await?.permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(destination, permissions).await?;
    }
    Ok(())
}

/// Replaces `destination` with `source` in the same directory so an active or
/// lingering process holding `destination` open (Windows `ERROR_SHARING_VIOLATION`
/// / `os error 32` or Unix `ETXTBSY`) does not block binary ACP updates.
pub(super) async fn replace_executable_file(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow::anyhow!("destination `{}` has no parent", destination.display()))?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            anyhow::anyhow!("destination `{}` has no file name", destination.display())
        })?;
    cleanup_stale_replaced_files(parent, file_name).await;

    let temp_new = parent.join(format!(".{file_name}.new-{}", Uuid::new_v4()));
    tokio::fs::copy(source, &temp_new).await?;

    if tokio::fs::rename(&temp_new, destination).await.is_ok() {
        return Ok(());
    }

    let aside = parent.join(format!(".{file_name}.old-{}", Uuid::new_v4()));
    let moved_aside = tokio::fs::rename(destination, &aside).await.is_ok();
    match tokio::fs::rename(&temp_new, destination).await {
        Ok(()) => {
            if moved_aside {
                let _ = tokio::fs::remove_file(&aside).await;
            }
            Ok(())
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temp_new).await;
            if moved_aside {
                let _ = tokio::fs::rename(&aside, destination).await;
            }
            Err(error.into())
        }
    }
}

pub(super) async fn cleanup_stale_replaced_files(parent: &Path, file_name: &str) {
    let old_prefix = format!(".{file_name}.old-");
    let new_prefix = format!(".{file_name}.new-");
    let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with(&old_prefix) || name.starts_with(&new_prefix) {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

pub(super) fn is_kiro_official_installer(agent_id: &AgentId, source: &str) -> bool {
    let lower = source_path(source).to_ascii_lowercase();
    agent_id.as_str() == "kiro"
        && (lower.ends_with(".ps1") || lower.ends_with(".msi") || lower.ends_with("/install"))
}

pub(super) fn sanitize_kiro_powershell_script(script: &str) -> String {
    script
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("Read-Host") {
                "# Read-Host disabled for unattended install"
            } else if trimmed.starts_with("Remove-Item") && trimmed.contains("$tempDir") {
                "# Preserve downloaded MSI in staging for fallback extraction"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

pub(super) async fn install_kiro_from_official_installer(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    let staging = utils::path::unique_dimo_scratch_dir("kiro")?;
    let result = if cfg!(windows) {
        install_kiro_windows_with_fallback(component, user_env, &staging).await
    } else {
        install_kiro_unix_installer(component, user_env, &staging).await
    };
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

pub(super) async fn resolve_installed_kiro_binary(user_env: &UserEnvironmentLayout) -> Option<PathBuf> {
    let _ = utils::shell::refresh_process_path_after_install().await;
    if cfg!(windows) {
        let mut candidates = Vec::new();
        for env_key in ["ProgramFiles", "ProgramW6432"] {
            if let Some(root) = std::env::var_os(env_key).map(PathBuf::from) {
                candidates.push(root.join("Kiro-Cli").join("kiro-cli.exe"));
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files\Kiro-Cli\kiro-cli.exe"));
        candidates.push(user_env.user_bin.join("kiro-cli.exe"));
        for candidate in candidates {
            if candidate.is_file() {
                if let Some(parent) = candidate.parent() {
                    utils::shell::expose_user_bin_to_process_path(parent);
                }
                if let Ok(canon) = tokio::fs::canonicalize(&candidate).await {
                    return Some(utils::process::prefer_direct_spawn_executable(canon));
                }
                return Some(candidate);
            }
        }
    } else {
        let candidate = user_env.user_bin.join("kiro-cli");
        if candidate.is_file()
            && let Ok(canon) = tokio::fs::canonicalize(&candidate).await
        {
            return Some(utils::process::prefer_direct_spawn_executable(canon));
        }
    }
    if let Some(resolved) = utils::shell::resolve_executable_path("kiro-cli").await
        && let Ok(canon) = tokio::fs::canonicalize(&resolved).await
    {
        return Some(utils::process::prefer_direct_spawn_executable(canon));
    }
    None
}

pub(super) async fn install_kiro_windows_with_fallback(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    // 1. Try the official https://cli.kiro.dev/install.ps1 script with PowerShell
    //    ExecutionPolicy Bypass and non-interactive sanitization.
    if source_path(&component.resolved_source)
        .to_ascii_lowercase()
        .ends_with(".ps1")
    {
        println!(
            "Running Kiro official PowerShell installer: {}",
            component.resolved_source
        );
        if let Ok(response) = reqwest::get(&component.resolved_source).await
            && let Ok(response) = response.error_for_status()
            && let Ok(script_text) = response.text().await
        {
            let sanitized = sanitize_kiro_powershell_script(&script_text);
            let script_path = staging.join("install.ps1");
            if tokio::fs::write(&script_path, sanitized).await.is_ok() {
                let mut cmd = utils::process::new_hidden_tokio_command(
                    "powershell.exe",
                    [
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ],
                );
                cmd.arg(&script_path)
                    .env("TEMP", staging)
                    .env("TMP", staging)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true);
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    run_command("powershell install.ps1", cmd),
                )
                .await;
                if let Some(installed) = resolve_installed_kiro_binary(user_env).await {
                    return Ok(installed);
                }
            }
        }
    }

    // 2. Fallback: Use MSI already downloaded by install.ps1 in staging, or download
    //    the official Windows MSI from Kiro's manifest.json and verify SHA-256.
    let msi_from_ps1 = staging.join("kiro-cli-installer").join("kiro-cli.msi");
    let msi_path = if msi_from_ps1.is_file() {
        msi_from_ps1
    } else {
        download_kiro_windows_msi(component, staging).await?
    };

    // 2a. Try standard silent MSI install (`msiexec /i <msi> /quiet /norestart`).
    let mut msi_install = utils::process::new_hidden_tokio_command("msiexec.exe", ["/i"]);
    msi_install
        .arg(&msi_path)
        .arg("/quiet")
        .arg("/norestart")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        run_command("msiexec /i", msi_install),
    )
    .await;
    if let Some(installed) = resolve_installed_kiro_binary(user_env).await {
        return Ok(installed);
    }

    // 2b. Non-admin permission fallback: `msiexec /a <msi> /qn TARGETDIR=<extract_dir>`
    //     unpacks the MSI into user-writable storage without requiring Administrator privileges.
    let extract_dir = staging.join("extracted");
    tokio::fs::create_dir_all(&extract_dir).await?;
    let target_dir_arg = format!("TARGETDIR={}", extract_dir.display());
    let mut msi_extract = utils::process::new_hidden_tokio_command("msiexec.exe", ["/a"]);
    msi_extract
        .arg(&msi_path)
        .arg("/qn")
        .arg(&target_dir_arg)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        run_command("msiexec /a", msi_extract),
    )
    .await
    .map_err(|_| anyhow::anyhow!("msiexec administrative extraction timed out"))??;

    let staged_exe = find_staged_executable(&extract_dir, "kiro-cli.exe")?;
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    if let Some(staged_dir) = staged_exe.parent() {
        for entry in std::fs::read_dir(staged_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file()
                && let Some(name) = path.file_name()
            {
                replace_executable_file(&path, &user_env.user_bin.join(name)).await?;
            }
        }
    } else {
        replace_executable_file(&staged_exe, &user_env.user_bin.join("kiro-cli.exe")).await?;
    }
    utils::shell::expose_user_bin_to_process_path(&user_env.user_bin);
    let dest = user_env.user_bin.join("kiro-cli.exe");
    Ok(utils::process::prefer_direct_spawn_executable(
        tokio::fs::canonicalize(dest).await?,
    ))
}

pub(super) async fn download_kiro_windows_msi(
    component: &PlannedInstallComponent,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    let (msi_url, expected_sha256) = if source_path(&component.resolved_source)
        .to_ascii_lowercase()
        .ends_with(".msi")
    {
        (component.resolved_source.clone(), None)
    } else {
        const KIRO_MANIFEST_URL: &str =
            "https://prod.download.cli.kiro.dev/stable/latest/manifest.json";
        let manifest: serde_json::Value = reqwest::get(KIRO_MANIFEST_URL)
            .await?
            .error_for_status()?
            .json()
            .await?;
        let pkg = manifest
            .get("packages")
            .and_then(serde_json::Value::as_array)
            .and_then(|pkgs| {
                pkgs.iter().find(|p| {
                    p.get("os").and_then(serde_json::Value::as_str) == Some("windows")
                        && p.get("fileType").and_then(serde_json::Value::as_str) == Some("msi")
                        && p.get("architecture").and_then(serde_json::Value::as_str)
                            == Some("x86_64")
                })
            })
            .ok_or_else(|| {
                anyhow::anyhow!("Kiro manifest.json does not contain a Windows x86_64 MSI package")
            })?;
        let download = pkg
            .get("download")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Kiro MSI package is missing download path"))?;
        let sha256 = pkg
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        (
            format!("https://prod.download.cli.kiro.dev/stable/{download}"),
            sha256,
        )
    };
    println!("Downloading Kiro Windows MSI: {msi_url}");
    let bytes = reqwest::get(&msi_url)
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if let Some(expected) = expected_sha256 {
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(&expected) {
            anyhow::bail!("Kiro MSI SHA-256 mismatch: expected {expected}, found {actual}");
        }
    }
    let msi_path = staging.join("kiro-cli.msi");
    tokio::fs::write(&msi_path, &bytes).await?;
    Ok(msi_path)
}

pub(super) async fn install_kiro_unix_installer(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
    staging: &Path,
) -> anyhow::Result<PathBuf> {
    println!(
        "Running Kiro official installer: {}",
        component.resolved_source
    );
    let script_bytes = reqwest::get(&component.resolved_source)
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let script_path = staging.join("install.sh");
    tokio::fs::write(&script_path, &script_bytes).await?;
    let mut cmd = utils::process::new_hidden_tokio_command("bash", [&script_path]);
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(
        std::time::Duration::from_secs(180),
        run_command("bash install.sh", cmd),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Kiro installer script timed out"))??;
    resolve_installed_kiro_binary(user_env)
        .await
        .ok_or_else(|| anyhow::anyhow!("Kiro installer finished but `kiro-cli` was not found"))
}

pub(super) fn user_bin_destination(user_bin: &Path, command: &str, staged: &Path) -> PathBuf {
    let name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".exe") || lower.ends_with(".bat") {
            user_bin.join(name)
        } else if staged
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
        {
            user_bin.join(format!("{name}.cmd"))
        } else {
            user_bin.join(format!("{name}.exe"))
        }
    } else {
        user_bin.join(name)
    }
}

pub(super) fn extract_archive(bytes: &[u8], source: &str, destination: &Path) -> anyhow::Result<()> {
    if source_path(source).to_ascii_lowercase().ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        archive.extract(destination)?;
        return Ok(());
    }
    if is_single_file_gzip(source, bytes) {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(bytes).read_to_end(&mut decoded)?;
        if looks_like_tar(&decoded) {
            return extract_tar(bytes, destination);
        }
        std::fs::create_dir_all(destination)?;
        std::fs::write(destination.join(gzip_member_name(source)), &decoded)?;
        return Ok(());
    }
    extract_tar(bytes, destination)
}

pub(super) fn source_path(source: &str) -> &str {
    source.split(['?', '#']).next().unwrap_or(source)
}

pub(super) fn is_single_file_gzip(source: &str, bytes: &[u8]) -> bool {
    let path = source_path(source).to_ascii_lowercase();
    path.ends_with(".gz")
        && !path.ends_with(".tar.gz")
        && !path.ends_with(".tgz")
        && bytes.starts_with(&[0x1f, 0x8b])
}

pub(super) fn looks_like_tar(bytes: &[u8]) -> bool {
    bytes.len() >= 262 && &bytes[257..262] == b"ustar"
}

pub(super) fn gzip_member_name(source: &str) -> String {
    let path = source_path(source);
    let file = path.rsplit(['/', '\\']).next().unwrap_or("payload");
    let name = file
        .to_ascii_lowercase()
        .ends_with(".gz")
        .then(|| &file[..file.len() - 3])
        .filter(|name| !name.is_empty())
        .unwrap_or("payload");
    name.to_string()
}

pub(super) fn extract_tar(bytes: &[u8], destination: &Path) -> anyhow::Result<()> {
    let archive = destination.join("download.archive");
    std::fs::write(&archive, bytes)?;
    let mut command = std::process::Command::new("tar");
    utils::process::configure_std_command_no_window(&mut command);
    let status = command
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(destination)
        .status()?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        anyhow::bail!("tar extract failed with {status}");
    }
    Ok(())
}

pub(super) fn find_staged_executable(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let relative = PathBuf::from(command);
    let direct = root.join(&relative);
    if direct.is_file() {
        return Ok(direct);
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("binary command `{command}` is not a file name"))?;
    let mut named = None;
    let mut only_file = None;
    let mut file_count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some("download.archive") {
                continue;
            }
            file_count += 1;
            if path.file_name() == Some(file_name) {
                named = Some(path.clone());
            }
            only_file = Some(path);
        }
    }
    if let Some(path) = named {
        return Ok(path);
    }
    if file_count == 1 {
        return only_file.ok_or_else(|| anyhow::anyhow!("extracted archive is empty"));
    }
    anyhow::bail!("extracted archive does not contain `{command}`")
}

pub(super) async fn prepare_user_environment(user_env: &UserEnvironmentLayout) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    tokio::fs::create_dir_all(&user_env.npm_bin).await?;
    tokio::fs::create_dir_all(&user_env.uv_tool_dir).await?;
    for directory in user_env.path_entries() {
        utils::shell::expose_user_bin_to_process_path(&directory);
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
    Ok(())
}

pub(super) async fn verify_handshake(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
) -> anyhow::Result<()> {
    if is_native_engine_profile(agent_id) {
        if agents::launch_program_is_legacy_acp_shim(agent_id, &lock.absolute_acp_program) {
            anyhow::bail!(
                "legacy ACP shim `{}` cannot be used for native engine `{agent_id}`",
                lock.absolute_acp_program.display()
            );
        }
        let version = probe_version(&lock.absolute_acp_program, &["--version"])
            .await
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "native engine `{}` failed `--version` health check",
                    lock.absolute_acp_program.display()
                )
            })?;
        if version.trim().is_empty() {
            anyhow::bail!(
                "native engine `{}` returned an empty version string",
                lock.absolute_acp_program.display()
            );
        }
        return Ok(());
    }
    let (event_tx, _event_rx) = agents::manager::manager_event_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let readiness = tokio::time::timeout(std::time::Duration::from_secs(30), ready).await;
    let _ = manager.disconnect(connection_id).await;
    readiness
        .map_err(|_| anyhow::anyhow!("ACP handshake timed out"))?
        .map_err(|_| anyhow::anyhow!("ACP process exited before initialize"))??;
    Ok(())
}

pub(super) async fn persist_lock(
    pool: &SqlitePool,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
) -> anyhow::Result<()> {
    let lock_id = Uuid::new_v4();
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({ "kind": "built_in_profile" }),
        LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "built_in_profile_with_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::UserDefinition { definition_sha256 } => serde_json::json!({
            "kind": "user_definition",
            "definition_sha256": definition_sha256,
        }),
    };
    let resolved_json = serde_json::json!({
        "source": source,
        "frozen_plan": plan,
        "absolute_acp_program": installation.launch_lock.absolute_acp_program,
        "args": installation.launch_lock.args,
        "env": installation.launch_lock.env,
        "runtime_version": installation.launch_lock.runtime_version,
        "acp_version": installation.launch_lock.acp_version,
    })
    .to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(lock_id.to_string())
    .bind(plan.agent_id.as_str())
    .bind(plan.registry_bound_version())
    .bind(&plan.platform)
    .bind(
        plan.components
            .first()
            .map(|component| format!("{:?}", component.distribution_kind).to_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    )
    .bind(resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    for component in &installation.components {
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256,
                trust_state, ownership, shared_resource_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind("user_environment")
        .bind("external")
        .bind(Option::<String>::None)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'external', 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(plan.agent_id.as_str())
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ?
             AND severity = 'error'
             AND read_at IS NULL"#,
    )
    .bind(plan.agent_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn probe_version(executable: &Path, version_args: &[&str]) -> Option<String> {
    if version_args.is_empty() {
        return None;
    }
    let mut command =
        utils::process::new_hidden_tokio_command(executable, version_args.iter().copied());
    command.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = utils::process::decode_process_output(&output.stdout);
    let stderr = utils::process::decode_process_output(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub(super) async fn file_sha256(path: &Path) -> anyhow::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(super) async fn run_command(label: &str, mut command: tokio::process::Command) -> anyhow::Result<()> {
    let output = command.output().await?;
    if output.status.success() {
        return Ok(());
    }
    let detail = utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("exit status {}", output.status));
    anyhow::bail!("{label} failed: {detail}")
}

pub(super) async fn run_command_with_progress<F>(
    label: &str,
    mut command: tokio::process::Command,
    percent: u8,
    on_progress: &mut F,
) -> anyhow::Result<()>
where
    F: FnMut(u8, &str),
{
    let output = command.output().await?;
    let stdout = utils::process::decode_process_output(&output.stdout);
    let stderr = utils::process::decode_process_output(&output.stderr);
    for line in stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(40)
    {
        on_progress(percent, line);
    }
    if output.status.success() {
        return Ok(());
    }
    let detail = utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("exit status {}", output.status));
    anyhow::bail!("{label} failed: {detail}")
}
