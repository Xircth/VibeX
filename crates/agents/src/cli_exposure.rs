//! Stable terminal command exposure for VibeX-managed Agent runtimes.

use std::{
    ffi::OsStr,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use api_types::AgentId;
use uuid::Uuid;

const PROFILE_BLOCK_START: &str = "# >>> VibeX managed Agent CLI >>>";
const PROFILE_BLOCK_END: &str = "# <<< VibeX managed Agent CLI <<<";
const SHIM_MARKER_PREFIX: &str = "# VibeX Agent CLI: ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    Windows,
    Zsh,
    Bash,
    Fish,
    Posix,
}

impl ShellFamily {
    pub fn from_shell_path(shell: Option<&Path>) -> Self {
        match shell
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or_default()
        {
            "zsh" => Self::Zsh,
            "bash" => Self::Bash,
            "fish" => Self::Fish,
            _ => Self::Posix,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedCliCommand {
    pub command_name: String,
    pub shim_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum CliExposureError {
    #[error("managed Runtime executable does not exist: {0}")]
    RuntimeMissing(PathBuf),
    #[error("managed Runtime executable is outside its Agent installation: {0}")]
    RuntimeOutsideInstallation(PathBuf),
    #[error("managed Runtime executable has no safe terminal command name: {0}")]
    UnsafeCommandName(String),
    #[error(
        "terminal command `{command}` already resolves to `{existing_path}` and is not managed by Agent `{agent_id}`"
    )]
    CommandConflict {
        command: String,
        agent_id: AgentId,
        existing_path: PathBuf,
    },
    #[error("failed to manage terminal command: {0}")]
    Io(#[from] std::io::Error),
}

pub fn publish_managed_runtime_cli(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    runtime_executable: &Path,
    shell: ShellFamily,
) -> Result<PublishedCliCommand, CliExposureError> {
    let effective_path = std::env::var_os("PATH");
    publish_managed_runtime_cli_with_path(
        home_dir,
        agent_id,
        managed_install_root,
        runtime_executable,
        shell,
        effective_path.as_deref(),
    )
}

fn publish_managed_runtime_cli_with_path(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    runtime_executable: &Path,
    shell: ShellFamily,
    effective_path: Option<&OsStr>,
) -> Result<PublishedCliCommand, CliExposureError> {
    if !runtime_executable.is_file() {
        return Err(CliExposureError::RuntimeMissing(
            runtime_executable.to_path_buf(),
        ));
    }
    if !runtime_executable.starts_with(managed_install_root) {
        return Err(CliExposureError::RuntimeOutsideInstallation(
            runtime_executable.to_path_buf(),
        ));
    }
    let command_name = runtime_command_name(runtime_executable)?;
    let bin_dir = home_dir.join(".local").join("bin");
    fs::create_dir_all(&bin_dir)?;
    let shim_path = terminal_shim_path(&bin_dir, &command_name);
    ensure_replaceable_shim(&shim_path, agent_id, &command_name)?;
    ensure_no_effective_path_conflict(
        &command_name,
        effective_path,
        home_dir,
        &shim_path,
        runtime_executable,
        agent_id,
    )?;
    ensure_shell_path(home_dir, shell)?;
    write_shim_atomically(&shim_path, agent_id, runtime_executable)?;
    Ok(PublishedCliCommand {
        command_name,
        shim_path,
    })
}

pub fn remove_managed_runtime_cli(
    home_dir: &Path,
    agent_id: &AgentId,
    runtime_executable: &Path,
) -> Result<(), CliExposureError> {
    let command_name = runtime_command_name(runtime_executable)?;
    let shim_path = terminal_shim_path(&home_dir.join(".local").join("bin"), &command_name);
    match fs::read_to_string(&shim_path) {
        Ok(existing) if shim_is_owned_by(&existing, agent_id) => {
            fs::remove_file(shim_path)?;
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn switch_managed_runtime_cli(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    previous_runtime: Option<&Path>,
    next_runtime: &Path,
    shell: ShellFamily,
) -> Result<PublishedCliCommand, CliExposureError> {
    let effective_path = std::env::var_os("PATH");
    switch_managed_runtime_cli_with_path(
        home_dir,
        agent_id,
        managed_install_root,
        previous_runtime,
        next_runtime,
        shell,
        effective_path.as_deref(),
    )
}

fn switch_managed_runtime_cli_with_path(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    previous_runtime: Option<&Path>,
    next_runtime: &Path,
    shell: ShellFamily,
    effective_path: Option<&OsStr>,
) -> Result<PublishedCliCommand, CliExposureError> {
    let published = publish_managed_runtime_cli_with_path(
        home_dir,
        agent_id,
        managed_install_root,
        next_runtime,
        shell,
        effective_path,
    )?;
    if let Some(previous_runtime) = previous_runtime
        && runtime_command_name(previous_runtime)? != published.command_name
        && let Err(error) = remove_managed_runtime_cli(home_dir, agent_id, previous_runtime)
    {
        let _ = remove_managed_runtime_cli(home_dir, agent_id, next_runtime);
        return Err(error);
    }
    Ok(published)
}

fn runtime_command_name(runtime_executable: &Path) -> Result<String, CliExposureError> {
    let file_name = runtime_executable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let lower_file_name = file_name.to_ascii_lowercase();
    let command = [".exe", ".cmd", ".bat"]
        .into_iter()
        .find(|suffix| lower_file_name.ends_with(suffix))
        .map(|suffix| &file_name[..file_name.len() - suffix.len()])
        .unwrap_or(file_name);
    if command.is_empty()
        || command.starts_with('.')
        || !command
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CliExposureError::UnsafeCommandName(file_name.to_string()));
    }
    Ok(command.to_string())
}

fn terminal_shim_path(bin_dir: &Path, command_name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        bin_dir.join(format!("{command_name}.cmd"))
    }
    #[cfg(not(windows))]
    {
        bin_dir.join(command_name)
    }
}

fn ensure_replaceable_shim(
    shim_path: &Path,
    agent_id: &AgentId,
    command_name: &str,
) -> Result<(), CliExposureError> {
    match fs::read_to_string(shim_path) {
        Ok(existing) if shim_is_owned_by(&existing, agent_id) => Ok(()),
        Ok(_) => Err(CliExposureError::CommandConflict {
            command: command_name.to_string(),
            agent_id: agent_id.clone(),
            existing_path: shim_path.to_path_buf(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_no_effective_path_conflict(
    command_name: &str,
    effective_path: Option<&OsStr>,
    home_dir: &Path,
    shim_path: &Path,
    runtime_executable: &Path,
    agent_id: &AgentId,
) -> Result<(), CliExposureError> {
    let Some(effective_path) = effective_path else {
        return Ok(());
    };
    let existing = match which::which_in(command_name, Some(effective_path), home_dir) {
        Ok(existing) => existing,
        Err(which::Error::CannotFindBinaryPath) => return Ok(()),
        Err(error) => return Err(std::io::Error::other(error).into()),
    };
    let existing_is_ours = paths_refer_to_same_file(&existing, shim_path)
        && fs::read_to_string(shim_path)
            .is_ok_and(|contents| shim_is_owned_by(&contents, agent_id));
    if existing_is_ours || paths_refer_to_same_file(&existing, runtime_executable) {
        return Ok(());
    }
    Err(CliExposureError::CommandConflict {
        command: command_name.to_string(),
        agent_id: agent_id.clone(),
        existing_path: existing,
    })
}

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn shim_is_owned_by(contents: &str, agent_id: &AgentId) -> bool {
    let unix_marker = format!("{SHIM_MARKER_PREFIX}{}", agent_id.as_str());
    let windows_marker = format!("rem VibeX Agent CLI: {}", agent_id.as_str());
    contents.lines().any(|line| {
        let line = line.trim_end_matches('\r');
        line == unix_marker || line.eq_ignore_ascii_case(&windows_marker)
    })
}

fn write_shim_atomically(
    shim_path: &Path,
    agent_id: &AgentId,
    runtime_executable: &Path,
) -> Result<(), CliExposureError> {
    let temporary = shim_path.with_file_name(format!(
        ".{}.vibex-{}.tmp",
        shim_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("agent"),
        Uuid::new_v4()
    ));
    #[cfg(not(windows))]
    let contents = format!(
        "#!/bin/sh\n{SHIM_MARKER_PREFIX}{}\nexec {} \"$@\"\n",
        agent_id.as_str(),
        shell_quote(runtime_executable)
    );
    #[cfg(windows)]
    let contents = format!(
        "@echo off\r\nrem VibeX Agent CLI: {}\r\n\"{}\" %*\r\n",
        agent_id.as_str(),
        runtime_executable.display()
    );
    fs::write(&temporary, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))?;
    }
    if let Err(error) = replace_file_atomically(&temporary, shim_path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_file_atomically(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temporary: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn ensure_shell_path(home_dir: &Path, shell: ShellFamily) -> Result<(), CliExposureError> {
    if shell == ShellFamily::Windows {
        return ensure_windows_user_path(&home_dir.join(".local").join("bin"));
    }
    let profile_block = format!(
        "{PROFILE_BLOCK_START}\ncase \":$PATH:\" in\n  *\":$HOME/.local/bin:\"*) ;;\n  *) export PATH=\"$HOME/.local/bin:$PATH\" ;;\nesac\n{PROFILE_BLOCK_END}\n"
    );
    let fish_block = format!(
        "{PROFILE_BLOCK_START}\nif not contains -- \"$HOME/.local/bin\" $PATH\n    set -gx PATH \"$HOME/.local/bin\" $PATH\nend\n{PROFILE_BLOCK_END}\n"
    );
    let profiles: Vec<(PathBuf, &str)> = match shell {
        ShellFamily::Windows => unreachable!("Windows PATH handled above"),
        ShellFamily::Zsh => vec![
            (home_dir.join(".zprofile"), &profile_block),
            (home_dir.join(".zshrc"), &profile_block),
        ],
        ShellFamily::Bash => vec![
            (home_dir.join(".bash_profile"), &profile_block),
            (home_dir.join(".bashrc"), &profile_block),
        ],
        ShellFamily::Fish => vec![(
            home_dir.join(".config").join("fish").join("config.fish"),
            &fish_block,
        )],
        ShellFamily::Posix => vec![(home_dir.join(".profile"), &profile_block)],
    };
    for (profile, block) in profiles {
        append_managed_profile_block(&profile, block)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_windows_user_path(_bin_dir: &Path) -> Result<(), CliExposureError> {
    Ok(())
}

#[cfg(windows)]
fn ensure_windows_user_path(bin_dir: &Path) -> Result<(), CliExposureError> {
    use std::ffi::OsString;

    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, REG_EXPAND_SZ},
        types::{FromRegValue, ToRegValue},
    };

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (environment, _) = current_user.create_subkey("Environment")?;
    let existing_raw = environment.get_raw_value("Path").ok();
    let existing = existing_raw
        .as_ref()
        .and_then(|value| OsString::from_reg_value(value).ok())
        .unwrap_or_default();
    if std::env::split_paths(&existing).any(|entry| entry == bin_dir) {
        return Ok(());
    }
    let mut entries = vec![bin_dir.to_path_buf()];
    entries.extend(std::env::split_paths(&existing));
    let joined = std::env::join_paths(entries).map_err(|error| {
        CliExposureError::UnsafeCommandName(format!("invalid Windows user PATH: {error}"))
    })?;
    let mut joined_raw = joined.to_reg_value();
    if existing_raw.is_some_and(|value| value.vtype == REG_EXPAND_SZ) {
        joined_raw.vtype = REG_EXPAND_SZ;
    }
    environment.set_raw_value("Path", &joined_raw)?;
    broadcast_windows_environment_change();
    Ok(())
}

#[cfg(windows)]
fn broadcast_windows_environment_change() {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    let environment: Vec<u16> = OsStr::new("Environment")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut result = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            environment.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

fn append_managed_profile_block(path: &Path, block: &str) -> Result<(), CliExposureError> {
    let existing = match fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    if existing
        .lines()
        .any(|line| line.trim() == PROFILE_BLOCK_START)
    {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    file.write_all(block.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, fs, process::Command};

    use super::*;

    fn publish_for_test(
        home_dir: &Path,
        agent_id: &AgentId,
        managed_install_root: &Path,
        runtime_executable: &Path,
        shell: ShellFamily,
    ) -> Result<PublishedCliCommand, CliExposureError> {
        publish_managed_runtime_cli_with_path(
            home_dir,
            agent_id,
            managed_install_root,
            runtime_executable,
            shell,
            Some(OsStr::new("")),
        )
    }

    #[cfg(unix)]
    #[test]
    fn managed_runtime_cli_is_resolvable_and_runnable_from_a_new_terminal() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\nprintf 'grok 0.2.115\\n'\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();

        let published = publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        let output = Command::new("/bin/sh")
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .arg("-c")
            .arg(". \"$HOME/.profile\"; command -v grok; grok --version")
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\ngrok 0.2.115\n", published.shim_path.display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn uninstall_removes_only_the_owning_agents_terminal_command() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        let agent_id = AgentId::parse("grok-build").unwrap();
        let published = publish_for_test(
            &home,
            &agent_id,
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        remove_managed_runtime_cli(&home, &agent_id, &runtime).unwrap();

        assert!(!published.shim_path.exists());

        fs::write(&published.shim_path, "#!/bin/sh\n# installed by user\n").unwrap();
        remove_managed_runtime_cli(&home, &agent_id, &runtime).unwrap();
        assert_eq!(
            fs::read_to_string(&published.shim_path).unwrap(),
            "#!/bin/sh\n# installed by user\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn version_switch_repoints_the_command_and_removes_a_retired_command_name() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let old_runtime = install_root.join("release-1/bin/grok");
        let next_runtime = install_root.join("release-2/bin/xai-grok");
        for (runtime, output) in [
            (&old_runtime, "#!/bin/sh\nprintf 'old\\n'\n"),
            (&next_runtime, "#!/bin/sh\nprintf 'new\\n'\n"),
        ] {
            fs::create_dir_all(runtime.parent().unwrap()).unwrap();
            fs::write(runtime, output).unwrap();
            fs::set_permissions(runtime, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::create_dir_all(&home).unwrap();
        let agent_id = AgentId::parse("grok-build").unwrap();
        let old = publish_for_test(
            &home,
            &agent_id,
            &install_root,
            &old_runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        let current = switch_managed_runtime_cli_with_path(
            &home,
            &agent_id,
            &install_root,
            Some(&old_runtime),
            &next_runtime,
            ShellFamily::Posix,
            Some(OsStr::new("")),
        )
        .unwrap();

        assert!(!old.shim_path.exists());
        assert_eq!(
            Command::new(&current.shim_path).output().unwrap().stdout,
            b"new\n"
        );
    }

    #[test]
    fn configured_shell_selects_the_matching_startup_files() {
        assert_eq!(
            ShellFamily::from_shell_path(Some(Path::new("/bin/zsh"))),
            ShellFamily::Zsh
        );
        assert_eq!(
            ShellFamily::from_shell_path(Some(Path::new("/usr/local/bin/fish"))),
            ShellFamily::Fish
        );
        assert_eq!(ShellFamily::from_shell_path(None), ShellFamily::Posix);
    }

    #[cfg(unix)]
    #[test]
    fn publish_refuses_to_overwrite_a_foreign_terminal_command() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        let shim = home.join(".local/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(shim.parent().unwrap()).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&shim, "#!/bin/sh\n# user-owned command\n").unwrap();

        let error = publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap_err();

        assert!(matches!(error, CliExposureError::CommandConflict { .. }));
        assert_eq!(
            fs::read_to_string(shim).unwrap(),
            "#!/bin/sh\n# user-owned command\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repeated_publication_keeps_shell_startup_configuration_idempotent() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        let agent_id = AgentId::parse("grok-build").unwrap();

        for _ in 0..2 {
            publish_for_test(&home, &agent_id, &install_root, &runtime, ShellFamily::Zsh).unwrap();
        }

        for profile in [home.join(".zprofile"), home.join(".zshrc")] {
            assert_eq!(
                fs::read_to_string(profile)
                    .unwrap()
                    .matches(PROFILE_BLOCK_START)
                    .count(),
                1
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_local_bin_path_configuration_is_preserved_and_reinforced() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        let existing = "export PATH=\"$HOME/.local/bin:$PATH\"\n";
        fs::write(home.join(".profile"), existing).unwrap();

        publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        let profile = fs::read_to_string(home.join(".profile")).unwrap();
        assert!(profile.starts_with(existing));
        assert_eq!(profile.matches(PROFILE_BLOCK_START).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn publish_refuses_to_shadow_a_foreign_command_elsewhere_on_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let foreign_bin = temp.path().join("foreign-bin");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        let foreign_command = foreign_bin.join("grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&foreign_bin).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::write(&foreign_command, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&foreign_command, fs::Permissions::from_mode(0o755)).unwrap();

        let error = publish_managed_runtime_cli_with_path(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
            Some(foreign_bin.as_os_str()),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            CliExposureError::CommandConflict {
                existing_path,
                ..
            } if existing_path == foreign_command
        ));
        assert!(!home.join(".local/bin/grok").exists());
    }

    #[cfg(unix)]
    #[test]
    fn commented_out_path_configuration_does_not_suppress_managed_path_block() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            home.join(".profile"),
            "# export PATH=\"$HOME/.local/bin:$PATH\"\n",
        )
        .unwrap();

        publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        assert!(
            fs::read_to_string(home.join(".profile"))
                .unwrap()
                .contains(PROFILE_BLOCK_START)
        );
    }

    #[cfg(unix)]
    #[test]
    fn windows_executable_suffix_is_removed_case_insensitively() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/GROK.EXE");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();

        let published = publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        assert_eq!(published.command_name, "GROK");
        assert_eq!(published.shim_path, home.join(".local/bin/GROK"));
    }
}
