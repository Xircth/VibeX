//! Stable terminal command exposure for VibeX-managed Agent runtimes.

use std::{
    borrow::Cow,
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
const WINDOWS_SHIM_MARKER_PREFIX: &str = "rem VibeX Agent CLI: ";
const TOOLCHAIN_SHIM_MARKER_PREFIX: &str = "# VibeX toolchain: ";
const WINDOWS_TOOLCHAIN_SHIM_MARKER_PREFIX: &str = "rem VibeX toolchain: ";

/// A published shim is a handful of lines. Anything larger is a real executable
/// and is never scanned for the ownership marker.
const MAX_SHIM_BYTES: u64 = 8 * 1024;

/// Prefix of the throwaway directory a managed install is prepared in before it
/// is promoted to the Agent's install root.
const STAGING_DIRECTORY_PREFIX: &str = ".staging-";

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

struct CliPublication<'a> {
    home_dir: &'a Path,
    agent_id: &'a AgentId,
    managed_install_root: &'a Path,
    runtime_executable: &'a Path,
    runtime_path_entries: &'a [PathBuf],
    shell: ShellFamily,
    effective_path: Option<&'a OsStr>,
}

#[derive(Debug, thiserror::Error)]
pub enum CliExposureError {
    #[error("managed Runtime executable does not exist: {0}")]
    RuntimeMissing(PathBuf),
    #[error("managed Runtime executable is outside its Agent installation: {0}")]
    RuntimeOutsideInstallation(PathBuf),
    #[error(
        "managed Runtime `{path}` is still inside a staging directory and has not been promoted into {install_root}"
    )]
    UnpromotedRuntime {
        path: PathBuf,
        install_root: PathBuf,
    },
    #[error("locked base Runtime PATH entry is not an absolute directory: {0}")]
    InvalidRuntimePath(PathBuf),
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
    #[error(
        "terminal command `{command}` already exists at `{existing_path}` and is not a VibeX toolchain shim"
    )]
    ToolchainCommandConflict {
        command: String,
        existing_path: PathBuf,
    },
    #[error("failed to manage terminal command: {0}")]
    Io(#[from] std::io::Error),
}

/// Ensure `~/.local/bin` is on the user PATH so user-environment Agent CLIs
/// are visible after install. Does not write a VibeX-owned shim.
pub fn ensure_user_cli_path(home_dir: &Path, shell: ShellFamily) -> Result<(), CliExposureError> {
    ensure_shell_path(home_dir, shell)
}

/// Publish a shared toolchain (Node, npm, npx) into the user environment.
///
/// Writes shims under `~/.local/bin` and puts that directory on the user PATH.
/// This is not an Agent installation artifact: uninstalling an Agent must not
/// remove these commands.
pub fn publish_user_toolchain_commands(
    home_dir: &Path,
    toolchain_bin_dir: &Path,
    commands: &[&str],
    shell: ShellFamily,
) -> Result<Vec<PublishedCliCommand>, CliExposureError> {
    if !toolchain_bin_dir.is_absolute() || !toolchain_bin_dir.is_dir() {
        return Err(CliExposureError::InvalidRuntimePath(
            toolchain_bin_dir.to_path_buf(),
        ));
    }
    let user_bin = home_dir.join(".local").join("bin");
    fs::create_dir_all(&user_bin)?;
    ensure_shell_path(home_dir, shell)?;
    #[cfg(windows)]
    {
        ensure_shell_path(home_dir, ShellFamily::Windows)?;
    }
    let mut published = Vec::new();
    for command in commands {
        let source = toolchain_command_path(toolchain_bin_dir, command);
        if !source.is_file() {
            continue;
        }
        let shim_path = terminal_shim_path(&user_bin, command);
        ensure_replaceable_toolchain_shim(&shim_path, command)?;
        write_toolchain_shim_atomically(&shim_path, command, &source, toolchain_bin_dir)?;
        published.push(PublishedCliCommand {
            command_name: (*command).to_string(),
            shim_path,
        });
    }
    Ok(published)
}

/// Install Node.js and npm into the user environment after a managed bootstrap.
///
/// Puts `node`, `npm`, and `npx` on the user PATH (`~/.local/bin` plus the
/// current process) so ACP packages with `#!/usr/bin/env node` can run.
pub fn export_managed_node_to_user_environment(
    home_dir: &Path,
    node_bin_dir: &Path,
    shell: ShellFamily,
) -> Result<Vec<PublishedCliCommand>, CliExposureError> {
    let published =
        publish_user_toolchain_commands(home_dir, node_bin_dir, &["node", "npm", "npx"], shell)?;
    let user_bin = home_dir.join(".local").join("bin");
    workspace_utils::shell::expose_user_bin_to_process_path(&user_bin);
    workspace_utils::shell::expose_user_bin_to_process_path(node_bin_dir);
    Ok(published)
}

pub fn publish_managed_runtime_cli(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    runtime_executable: &Path,
    runtime_path_entries: &[PathBuf],
    shell: ShellFamily,
) -> Result<PublishedCliCommand, CliExposureError> {
    let effective_path = std::env::var_os("PATH");
    publish_managed_runtime_cli_with_path(CliPublication {
        home_dir,
        agent_id,
        managed_install_root,
        runtime_executable,
        runtime_path_entries,
        shell,
        effective_path: effective_path.as_deref(),
    })
}

fn publish_managed_runtime_cli_with_path(
    publication: CliPublication<'_>,
) -> Result<PublishedCliCommand, CliExposureError> {
    let CliPublication {
        home_dir,
        agent_id,
        managed_install_root,
        runtime_executable,
        runtime_path_entries,
        shell,
        effective_path,
    } = publication;
    if !runtime_executable.starts_with(managed_install_root) {
        return Err(CliExposureError::RuntimeOutsideInstallation(
            runtime_executable.to_path_buf(),
        ));
    }
    let runtime_executable = published_runtime_target(runtime_executable, managed_install_root)?;
    let runtime_executable = runtime_executable.as_ref();
    if !runtime_executable.is_file() {
        return Err(CliExposureError::RuntimeMissing(
            runtime_executable.to_path_buf(),
        ));
    }
    validate_runtime_path_entries(runtime_path_entries)?;
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
    write_shim_atomically(
        &shim_path,
        agent_id,
        runtime_executable,
        runtime_path_entries,
    )?;
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
    match fs::read(&shim_path) {
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
    runtime_path_entries: &[PathBuf],
    shell: ShellFamily,
) -> Result<PublishedCliCommand, CliExposureError> {
    let effective_path = std::env::var_os("PATH");
    switch_managed_runtime_cli_with_path(
        CliPublication {
            home_dir,
            agent_id,
            managed_install_root,
            runtime_executable: next_runtime,
            runtime_path_entries,
            shell,
            effective_path: effective_path.as_deref(),
        },
        previous_runtime,
    )
}

fn switch_managed_runtime_cli_with_path(
    publication: CliPublication<'_>,
    previous_runtime: Option<&Path>,
) -> Result<PublishedCliCommand, CliExposureError> {
    let home_dir = publication.home_dir;
    let agent_id = publication.agent_id;
    let next_runtime = publication.runtime_executable;
    let published = publish_managed_runtime_cli_with_path(publication)?;
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

/// The path a published shim must name for `runtime_executable`.
///
/// A managed install is prepared under a `.staging-<id>` directory and promoted
/// — renamed — into the Agent's install root; the staging directory does not
/// outlive the install. A lock that still names a staging path therefore
/// describes a location that is about to disappear, and a shim published from it
/// would shadow the user's own command of the same name on PATH only to break.
/// The promoted location is the one worth publishing, so a staging path is
/// rewritten onto the install root and refused when nothing has been promoted
/// there yet.
fn published_runtime_target<'a>(
    runtime_executable: &'a Path,
    managed_install_root: &Path,
) -> Result<Cow<'a, Path>, CliExposureError> {
    let Ok(relative) = runtime_executable.strip_prefix(managed_install_root) else {
        return Ok(Cow::Borrowed(runtime_executable));
    };
    let mut components = relative.components();
    let is_staging = components
        .next()
        .and_then(|component| component.as_os_str().to_str())
        .is_some_and(|name| name.starts_with(STAGING_DIRECTORY_PREFIX));
    if !is_staging {
        return Ok(Cow::Borrowed(runtime_executable));
    }
    let promoted = managed_install_root.join(components.as_path());
    if promoted.is_file() {
        return Ok(Cow::Owned(promoted));
    }
    Err(CliExposureError::UnpromotedRuntime {
        path: runtime_executable.to_path_buf(),
        install_root: managed_install_root.to_path_buf(),
    })
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
    match fs::read(shim_path) {
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
        && fs::read(shim_path).is_ok_and(|contents| shim_is_owned_by(&contents, agent_id));
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

fn shim_is_owned_by(contents: &[u8], agent_id: &AgentId) -> bool {
    shim_marker_owner(contents).is_some_and(|owner| owner.eq_ignore_ascii_case(agent_id.as_str()))
}

/// The value on one of VibeX's ownership marker lines, in a file it published.
///
/// Every marker is read the same way: the first line carrying either the POSIX
/// or the Windows prefix yields the name that follows it. Both prefixes are
/// matched as a full prefix, and a marker with nothing after it names nothing.
fn marker_value<'a>(contents: &'a [u8], prefixes: (&[u8], &[u8])) -> Option<&'a str> {
    let (posix_prefix, windows_prefix) = prefixes;
    contents.split(|byte| *byte == b'\n').find_map(|line| {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let value = line.strip_prefix(posix_prefix).or_else(|| {
            let (prefix, rest) = line.split_at_checked(windows_prefix.len())?;
            prefix.eq_ignore_ascii_case(windows_prefix).then_some(rest)
        })?;
        let value = std::str::from_utf8(value).ok()?.trim();
        (!value.is_empty()).then_some(value)
    })
}

/// The Agent named on a published shim's ownership marker line.
fn shim_marker_owner(contents: &[u8]) -> Option<&str> {
    marker_value(
        contents,
        (
            SHIM_MARKER_PREFIX.as_bytes(),
            WINDOWS_SHIM_MARKER_PREFIX.as_bytes(),
        ),
    )
}

/// The command named on a published toolchain shim's ownership marker line.
fn toolchain_shim_marker_owner(contents: &[u8]) -> Option<&str> {
    marker_value(
        contents,
        (
            TOOLCHAIN_SHIM_MARKER_PREFIX.as_bytes(),
            WINDOWS_TOOLCHAIN_SHIM_MARKER_PREFIX.as_bytes(),
        ),
    )
}

/// The Agent that owns the published CLI shim at `path`, if `path` is one.
///
/// VibeX writes shims for its managed Runtimes into the user's `~/.local/bin`,
/// where they are indistinguishable from a user-installed command by name alone.
/// Callers asking "does this machine already have this Runtime?" must be able to
/// tell VibeX's own artifact from the user's, and the marker line is the only
/// durable evidence of that.
pub fn published_cli_shim_agent(path: &Path) -> Option<AgentId> {
    read_published_shim(path).map(|(agent_id, _)| agent_id)
}

/// Read a published shim: the Agent that owns it, plus its contents.
///
/// The size guard keeps this from slurping a real executable that merely shares
/// the command's name.
fn read_published_shim(path: &Path) -> Option<(AgentId, Vec<u8>)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SHIM_BYTES {
        return None;
    }
    let contents = fs::read(path).ok()?;
    let agent_id = AgentId::parse(shim_marker_owner(&contents)?).ok()?;
    Some((agent_id, contents))
}

/// Resolve a command to the *user's* executable, stepping over any VibeX
/// published shim.
///
/// VibeX publishes its managed Runtime under the vendor command name, so a probe
/// that stops at the first PATH hit reports VibeX's own installation as one the
/// user already had: the Agent is adopted as user-provided and the user's real
/// Runtime — when they have one — is never consulted. Resolving through here
/// keeps that distinction: `None` means the user has no Runtime of their own,
/// not that the command is missing.
pub async fn resolve_user_runtime_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    // The standard resolver also searches the well-known user bin directories
    // and can repair a desktop-launched PATH from the login shell, which widens
    // what the PATH scan below can see.
    let resolved = workspace_utils::shell::resolve_executable_path(command).await;
    if let Some(resolved) = resolved.as_deref()
        && published_cli_shim_agent(resolved).is_none()
    {
        return Some(resolved.to_path_buf());
    }
    // Either nothing resolved or the hit was VibeX's own shim; keep walking PATH
    // for a genuine user copy that the shim shadowed.
    let cwd = std::env::current_dir().ok()?;
    let search_path = std::env::var_os("PATH");
    first_user_runtime_in(command, search_path.as_deref(), &cwd)
}

/// The first `command` on `search_path` that is not a shim VibeX published.
fn first_user_runtime_in(
    command: &str,
    search_path: Option<&OsStr>,
    cwd: &Path,
) -> Option<PathBuf> {
    which::which_in_all(command, search_path, cwd)
        .ok()?
        .find(|candidate| candidate.is_file() && published_cli_shim_agent(candidate).is_none())
}

/// The Runtime a published shim runs, read back from the shim itself.
///
/// The target cannot be re-derived from settings: a shim outlives the install
/// that wrote it, which is precisely when the question matters. The shim is the
/// only durable record of what it points at.
fn shim_runtime_target(contents: &[u8]) -> Option<PathBuf> {
    let text = std::str::from_utf8(contents).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("exec ") {
            let quoted = rest.strip_suffix(" \"$@\"")?;
            return unquote_posix_shim_value(quoted).map(PathBuf::from);
        }
        if let Some(rest) = line.strip_suffix(" %*") {
            let quoted = rest.strip_prefix('"')?.strip_suffix('"')?;
            return Some(PathBuf::from(quoted.replace("%%", "%")));
        }
    }
    None
}

fn unquote_posix_shim_value(value: &str) -> Option<String> {
    let inner = value.strip_prefix('\'')?.strip_suffix('\'')?;
    Some(inner.replace("'\"'\"'", "'"))
}

/// Whether VibeX published the file at hand.
///
/// The marker line is the only evidence of that, and it is what keeps a user's
/// own command of the same name from being mistaken for one of ours.
fn is_vibex_published_shim(contents: &[u8]) -> bool {
    shim_marker_owner(contents).is_some() || toolchain_shim_marker_owner(contents).is_some()
}

/// Remove shims VibeX published whose target no longer exists.
///
/// A shim outlives the installation it points at: the managed tree is deleted,
/// or an install is abandoned before it is promoted, and the command stays on
/// the user's `PATH` pointing at nothing. It carries the vendor command name, so
/// a dead shim shadows whatever the user installed under that name — their own
/// Runtime, or their own Node — and the failure names neither VibeX nor the
/// shim. Nothing else removes it, because nothing else knows it is there.
///
/// Only a file carrying one of VibeX's own ownership markers is ever considered,
/// and the sweep is deliberately literal about liveness: a shim is orphaned only
/// when the program it names is not an existing file. A shim whose command is
/// merely *unexpected* — one VibeX would no longer publish — still runs, and
/// removing it would take a working command away from the user.
pub fn remove_orphaned_cli_shims(
    home_dir: &Path,
) -> Result<Vec<PublishedCliCommand>, CliExposureError> {
    let bin_dir = home_dir.join(".local").join("bin");
    let entries = match fs::read_dir(&bin_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut removed = Vec::new();
    for entry in entries {
        let shim_path = entry?.path();
        let Ok(metadata) = fs::metadata(&shim_path) else {
            continue;
        };
        // Same guard as reading a shim: a handful of lines, never a real
        // executable that merely shares the command's name.
        if !metadata.is_file() || metadata.len() > MAX_SHIM_BYTES {
            continue;
        }
        let Ok(contents) = fs::read(&shim_path) else {
            continue;
        };
        if !is_vibex_published_shim(&contents) {
            continue;
        }
        let Some(target) = shim_runtime_target(&contents) else {
            // Not readable as a shim VibeX wrote: it cannot be proven that the
            // target is gone, so the file is left alone rather than guessed at.
            continue;
        };
        if target.is_file() {
            continue;
        }
        let Some(command_name) = shim_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Err(error) = fs::remove_file(&shim_path) {
            tracing::warn!(
                path = %shim_path.display(),
                %error,
                "failed to remove an orphaned CLI shim"
            );
            continue;
        }
        removed.push(PublishedCliCommand {
            command_name: command_name.to_string(),
            shim_path,
        });
    }
    Ok(removed)
}

fn write_shim_atomically(
    shim_path: &Path,
    agent_id: &AgentId,
    runtime_executable: &Path,
    runtime_path_entries: &[PathBuf],
) -> Result<(), CliExposureError> {
    let temporary = shim_path.with_file_name(format!(
        ".{}.vibex-{}.tmp",
        shim_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("agent"),
        Uuid::new_v4()
    ));
    let contents = render_shim(
        native_shim_format(),
        agent_id,
        runtime_executable,
        runtime_path_entries,
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
fn native_shim_format() -> ShellFamily {
    ShellFamily::Posix
}

#[cfg(windows)]
fn native_shim_format() -> ShellFamily {
    ShellFamily::Windows
}

fn validate_runtime_path_entries(entries: &[PathBuf]) -> Result<(), CliExposureError> {
    for entry in entries {
        if !entry.is_absolute() || !entry.is_dir() {
            return Err(CliExposureError::InvalidRuntimePath(entry.clone()));
        }
        let contains_path_separator = if cfg!(windows) {
            entry.to_string_lossy().contains(';')
        } else {
            entry.to_string_lossy().contains(':')
        };
        if contains_path_separator {
            return Err(CliExposureError::InvalidRuntimePath(entry.clone()));
        }
    }
    Ok(())
}

fn render_shim(
    format: ShellFamily,
    agent_id: &AgentId,
    runtime_executable: &Path,
    runtime_path_entries: &[PathBuf],
) -> String {
    match format {
        ShellFamily::Windows => {
            let path_binding = if runtime_path_entries.is_empty() {
                String::new()
            } else {
                let prefix = runtime_path_entries
                    .iter()
                    .map(|entry| escape_windows_batch_value(&entry.to_string_lossy()))
                    .collect::<Vec<_>>()
                    .join(";");
                format!("set \"PATH={prefix};%PATH%\"\r\n")
            };
            format!(
                "@echo off\r\nsetlocal DisableDelayedExpansion\r\n{WINDOWS_SHIM_MARKER_PREFIX}{}\r\n{path_binding}\"{}\" %*\r\nexit /b %ERRORLEVEL%\r\n",
                agent_id.as_str(),
                escape_windows_batch_value(&runtime_executable.to_string_lossy())
            )
        }
        ShellFamily::Zsh | ShellFamily::Bash | ShellFamily::Fish | ShellFamily::Posix => {
            let path_binding = if runtime_path_entries.is_empty() {
                String::new()
            } else {
                let prefix = runtime_path_entries
                    .iter()
                    .map(|entry| shell_quote(entry))
                    .collect::<Vec<_>>()
                    .join(":");
                format!("PATH={prefix}:\"$PATH\"\nexport PATH\n")
            };
            format!(
                "#!/bin/sh\n{SHIM_MARKER_PREFIX}{}\n{path_binding}exec {} \"$@\"\n",
                agent_id.as_str(),
                shell_quote(runtime_executable)
            )
        }
    }
}

fn escape_windows_batch_value(value: &str) -> String {
    value.replace('%', "%%")
}

fn toolchain_command_path(bin_dir: &Path, command: &str) -> PathBuf {
    if cfg!(windows) {
        match command {
            "node" => bin_dir.join("node.exe"),
            "npm" => bin_dir.join("npm.cmd"),
            "npx" => bin_dir.join("npx.cmd"),
            other => bin_dir.join(format!("{other}.cmd")),
        }
    } else {
        bin_dir.join(command)
    }
}

fn ensure_replaceable_toolchain_shim(
    shim_path: &Path,
    command_name: &str,
) -> Result<(), CliExposureError> {
    match fs::read(shim_path) {
        Ok(existing) if toolchain_shim_is_owned(&existing, command_name) => Ok(()),
        Ok(_) => Err(CliExposureError::ToolchainCommandConflict {
            command: command_name.to_string(),
            existing_path: shim_path.to_path_buf(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn toolchain_shim_is_owned(contents: &[u8], command_name: &str) -> bool {
    toolchain_shim_marker_owner(contents).is_some_and(|owner| owner == command_name)
}

fn write_toolchain_shim_atomically(
    shim_path: &Path,
    command_name: &str,
    runtime_executable: &Path,
    toolchain_bin_dir: &Path,
) -> Result<(), CliExposureError> {
    let temporary = shim_path.with_file_name(format!(
        ".{}.vibex-toolchain-{}.tmp",
        shim_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("toolchain"),
        Uuid::new_v4()
    ));
    let contents = render_toolchain_shim(
        native_shim_format(),
        command_name,
        runtime_executable,
        toolchain_bin_dir,
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

fn render_toolchain_shim(
    format: ShellFamily,
    command_name: &str,
    runtime_executable: &Path,
    toolchain_bin_dir: &Path,
) -> String {
    match format {
        ShellFamily::Windows => {
            format!(
                "@echo off\r\nsetlocal DisableDelayedExpansion\r\n{WINDOWS_TOOLCHAIN_SHIM_MARKER_PREFIX}{command_name}\r\nset \"PATH={};%PATH%\"\r\n\"{}\" %*\r\nexit /b %ERRORLEVEL%\r\n",
                escape_windows_batch_value(&toolchain_bin_dir.to_string_lossy()),
                escape_windows_batch_value(&runtime_executable.to_string_lossy())
            )
        }
        ShellFamily::Zsh | ShellFamily::Bash | ShellFamily::Fish | ShellFamily::Posix => {
            format!(
                "#!/bin/sh\n{TOOLCHAIN_SHIM_MARKER_PREFIX}{command_name}\nPATH={}:\"$PATH\"\nexport PATH\nexec {} \"$@\"\n",
                shell_quote(toolchain_bin_dir),
                shell_quote(runtime_executable)
            )
        }
    }
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
    // The profile is user-owned free-form text: it may contain bytes that are
    // not valid UTF-8 (legacy encodings, binary artifacts). Work on raw bytes
    // so a non-UTF-8 profile can never block the install; we only ever append
    // the ASCII block and never rewrite the existing content.
    let marker = PROFILE_BLOCK_START.as_bytes();
    let existing = match fs::read(path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    if existing
        .split(|byte| *byte == b'\n')
        .any(|line| line.trim_ascii() == marker)
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
    if !existing.is_empty() && !existing.ends_with(b"\n") {
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
        publish_managed_runtime_cli_with_path(CliPublication {
            home_dir,
            agent_id,
            managed_install_root,
            runtime_executable,
            runtime_path_entries: &[],
            shell,
            effective_path: Some(OsStr::new("")),
        })
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
    fn managed_runtime_cli_binds_its_locked_base_runtime_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/claude-code");
        let runtime = install_root.join("release/bin/claude");
        let node_bin = temp.path().join("managed node/bin");
        let node = node_bin.join("node");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&node_bin).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/usr/bin/env node\n").unwrap();
        fs::write(&node, "#!/bin/sh\nprintf 'managed-node:%s\\n' \"$2\"\n").unwrap();
        for executable in [&runtime, &node] {
            fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
        }

        // Pin the effective PATH: the real one would resolve `claude` to whatever the
        // developer has installed and report it as a command conflict.
        let published = publish_managed_runtime_cli_with_path(CliPublication {
            home_dir: &home,
            agent_id: &AgentId::parse("claude-code").unwrap(),
            managed_install_root: &install_root,
            runtime_executable: &runtime,
            runtime_path_entries: std::slice::from_ref(&node_bin),
            shell: ShellFamily::Posix,
            effective_path: Some(OsStr::new("")),
        })
        .unwrap();

        let output = Command::new(&published.shim_path)
            .env("PATH", published.shim_path.parent().unwrap())
            .arg("--version")
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"managed-node:--version\n");
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
            CliPublication {
                home_dir: &home,
                agent_id: &agent_id,
                managed_install_root: &install_root,
                runtime_executable: &next_runtime,
                runtime_path_entries: &[],
                shell: ShellFamily::Posix,
                effective_path: Some(OsStr::new("")),
            },
            Some(&old_runtime),
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

    #[test]
    fn windows_shim_binds_locked_runtime_without_changing_the_user_path() {
        let agent_id = AgentId::parse("claude-code").unwrap();
        let contents = render_shim(
            ShellFamily::Windows,
            &agent_id,
            Path::new(r"C:\Users\Dev%20\VibeX\agents\claude.cmd"),
            &[PathBuf::from(r"C:\Users\Dev%20\VibeX\node")],
        );

        assert!(contents.contains("set \"PATH=C:\\Users\\Dev%%20\\VibeX\\node;%PATH%\"\r\n"));
        assert!(contents.contains("\"C:\\Users\\Dev%%20\\VibeX\\agents\\claude.cmd\" %*\r\n"));
        assert!(contents.ends_with("exit /b %ERRORLEVEL%\r\n"));
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
    fn non_utf8_profile_is_preserved_and_still_receives_the_managed_block() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/grok-build");
        let runtime = install_root.join("release/bin/grok");
        let profile = home.join(".profile");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();
        // A legacy-encoded / byte-dirty profile must never block the install.
        let legacy_bytes = b"# shell rc in a legacy encoding\n\xff\xfe\x00\n";
        fs::write(&profile, legacy_bytes).unwrap();

        publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        let written = fs::read(&profile).unwrap();
        assert!(
            written.starts_with(legacy_bytes),
            "original bytes were rewritten"
        );
        assert!(
            String::from_utf8_lossy(&written).contains(PROFILE_BLOCK_START),
            "managed block was not appended"
        );
    }

    #[cfg(unix)]
    #[test]
    fn binary_shim_reports_a_conflict_instead_of_a_utf8_io_error() {
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
        fs::write(&shim, [0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0xff]).unwrap();

        let error = publish_for_test(
            &home,
            &AgentId::parse("grok-build").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap_err();

        assert!(
            matches!(error, CliExposureError::CommandConflict { .. }),
            "expected CommandConflict, got {error}"
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

        let agent_id = AgentId::parse("grok-build").unwrap();
        let error = publish_managed_runtime_cli_with_path(CliPublication {
            home_dir: &home,
            agent_id: &agent_id,
            managed_install_root: &install_root,
            runtime_executable: &runtime,
            runtime_path_entries: &[],
            shell: ShellFamily::Posix,
            effective_path: Some(foreign_bin.as_os_str()),
        })
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

    #[cfg(unix)]
    #[test]
    fn managed_node_is_exported_to_the_user_bin_and_login_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let node_bin = temp.path().join("managed-node/bin");
        fs::create_dir_all(&node_bin).unwrap();
        fs::create_dir_all(&home).unwrap();
        for (name, script) in [
            ("node", "#!/bin/sh\nprintf 'v22.22.3\\n'\n"),
            ("npm", "#!/bin/sh\nprintf '10.9.2\\n'\n"),
            ("npx", "#!/bin/sh\nprintf '10.9.2\\n'\n"),
        ] {
            let executable = node_bin.join(name);
            fs::write(&executable, script).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let published = publish_user_toolchain_commands(
            &home,
            &node_bin,
            &["node", "npm", "npx"],
            ShellFamily::Posix,
        )
        .unwrap();

        assert_eq!(published.len(), 3);
        let node_shim = home.join(".local/bin/node");
        let npm_shim = home.join(".local/bin/npm");
        assert!(node_shim.is_file());
        assert!(npm_shim.is_file());
        assert!(
            fs::read_to_string(&node_shim)
                .unwrap()
                .contains("# VibeX toolchain: node")
        );

        let output = Command::new("/bin/sh")
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .arg("-c")
            .arg(". \"$HOME/.profile\"; command -v node; node --version; command -v npm; npm --version")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains(&format!("{}\n", node_shim.display())),
            "{stdout}"
        );
        assert!(stdout.contains("v22.22.3"), "{stdout}");
        assert!(stdout.contains("10.9.2"), "{stdout}");
    }

    #[cfg(unix)]
    #[test]
    fn managed_node_export_does_not_overwrite_a_user_node() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let node_bin = temp.path().join("managed-node/bin");
        let shim = home.join(".local/bin/node");
        fs::create_dir_all(&node_bin).unwrap();
        fs::create_dir_all(shim.parent().unwrap()).unwrap();
        fs::write(node_bin.join("node"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(node_bin.join("node"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(&shim, "#!/bin/sh\n# user node\n").unwrap();

        let error =
            publish_user_toolchain_commands(&home, &node_bin, &["node"], ShellFamily::Posix)
                .unwrap_err();

        assert!(matches!(
            error,
            CliExposureError::ToolchainCommandConflict { .. }
        ));
        assert_eq!(
            fs::read_to_string(shim).unwrap(),
            "#!/bin/sh\n# user node\n"
        );
    }

    #[test]
    fn shim_ownership_is_read_from_the_marker_line_alone() {
        assert_eq!(
            shim_marker_owner(b"#!/bin/sh\n# VibeX Agent CLI: pi\nexec /x \"$@\"\n"),
            Some("pi")
        );
        assert_eq!(
            shim_marker_owner(b"@echo off\r\nrem VibeX Agent CLI: codex\r\n\"x\" %*\r\n"),
            Some("codex")
        );
        assert_eq!(shim_marker_owner(b"rem VibeX toolchain: node\n"), None);
        // A command that merely mentions VibeX is not one VibeX published, and
        // neither is a user's own script next to a published shim.
        assert_eq!(
            shim_marker_owner(b"# see VibeX Agent CLI: pi\nexec /x\n"),
            None
        );
        assert_eq!(
            shim_marker_owner(b"#!/bin/sh\nexec /usr/local/bin/pi \"$@\"\n"),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_published_shim_names_the_agent_that_owns_it() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/pi");
        let runtime = install_root.join("release/pi");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();

        let published = publish_for_test(
            &home,
            &AgentId::parse("pi").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();

        assert_eq!(
            published_cli_shim_agent(&published.shim_path),
            Some(AgentId::parse("pi").unwrap())
        );

        let user_owned = home.join("user-bin/pi");
        fs::create_dir_all(user_owned.parent().unwrap()).unwrap();
        fs::write(&user_owned, "#!/bin/sh\nexec /usr/local/bin/pi \"$@\"\n").unwrap();
        assert_eq!(published_cli_shim_agent(&user_owned), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_staging_runtime_is_published_from_the_promoted_install_root() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/pi");
        let relative = Path::new("0-agent_runtime/node_modules/.bin/pi");
        let staged = install_root.join(".staging-ed0e2b16").join(relative);
        let promoted = install_root.join(relative);
        for path in [&staged, &promoted] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "#!/bin/sh\n").unwrap();
        }
        fs::create_dir_all(&home).unwrap();

        let published = publish_for_test(
            &home,
            &AgentId::parse("pi").unwrap(),
            &install_root,
            &staged,
            ShellFamily::Posix,
        )
        .unwrap();

        let shim = fs::read_to_string(&published.shim_path).unwrap();
        assert!(shim.contains(&promoted.display().to_string()), "{shim}");
        assert!(!shim.contains(STAGING_DIRECTORY_PREFIX), "{shim}");
    }

    #[cfg(unix)]
    #[test]
    fn a_runtime_left_in_staging_is_never_published() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let install_root = temp.path().join("app-data/agents/pi");
        let staged = install_root.join(".staging-ed0e2b16/0-agent_runtime/node_modules/.bin/pi");
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        fs::write(&staged, "#!/bin/sh\n").unwrap();
        fs::create_dir_all(&home).unwrap();

        let error = publish_for_test(
            &home,
            &AgentId::parse("pi").unwrap(),
            &install_root,
            &staged,
            ShellFamily::Posix,
        )
        .unwrap_err();

        assert!(
            matches!(error, CliExposureError::UnpromotedRuntime { .. }),
            "{error}"
        );
        assert!(!home.join(".local/bin/pi").exists());
    }

    #[cfg(unix)]
    #[test]
    fn user_runtime_resolution_steps_over_a_published_shim() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let real_bin = temp.path().join("real-bin");
        let install_root = temp.path().join("app-data/agents/pi");
        let runtime = install_root.join("release/pi");
        fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        fs::create_dir_all(&real_bin).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(&runtime, "#!/bin/sh\n").unwrap();
        let real = real_bin.join("pi");
        fs::write(&real, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();

        let published = publish_for_test(
            &home,
            &AgentId::parse("pi").unwrap(),
            &install_root,
            &runtime,
            ShellFamily::Posix,
        )
        .unwrap();
        assert_eq!(published.command_name, "pi");

        // VibeX's shim comes first on PATH and would otherwise be reported as the
        // Runtime the user already had.
        let search_path =
            std::env::join_paths([published.shim_path.parent().unwrap(), &real_bin]).unwrap();
        let resolved = first_user_runtime_in("pi", Some(&search_path), temp.path()).unwrap();

        assert_eq!(
            fs::canonicalize(resolved).unwrap(),
            fs::canonicalize(&real).unwrap()
        );
    }

    #[test]
    fn a_shim_reports_the_target_it_runs() {
        assert_eq!(
            shim_runtime_target(b"#!/bin/sh\n# VibeX Agent CLI: pi\nexec '/opt/pi' \"$@\"\n"),
            Some(PathBuf::from("/opt/pi"))
        );
        assert_eq!(
            shim_runtime_target(b"@echo off\r\nrem VibeX Agent CLI: pi\r\n\"C:/Pi/pi.cmd\" %*\r\n"),
            Some(PathBuf::from("C:/Pi/pi.cmd"))
        );
        // The batch form doubles `%`; the shim's own escaping is undone.
        assert_eq!(
            shim_runtime_target(b"\"C:/n%%ode/node.cmd\" %*\r\n"),
            Some(PathBuf::from("C:/n%ode/node.cmd"))
        );
        // A quote inside the path survives the shim's own escaping.
        assert_eq!(
            shim_runtime_target(b"#!/bin/sh\nexec '/opt/it'\"'\"'s/pi' \"$@\"\n"),
            Some(PathBuf::from("/opt/it's/pi"))
        );
        assert_eq!(shim_runtime_target(b"#!/bin/sh\necho hello\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_removes_a_shim_only_once_its_target_is_gone() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let mut published = Vec::new();
        for command in ["pi", "codex"] {
            let install_root = temp.path().join("app-data/agents").join(command);
            let runtime = install_root.join("release").join(command);
            fs::create_dir_all(runtime.parent().unwrap()).unwrap();
            fs::write(&runtime, "#!/bin/sh\n").unwrap();
            let shim = publish_for_test(
                &home,
                &AgentId::parse(command).unwrap(),
                &install_root,
                &runtime,
                ShellFamily::Posix,
            )
            .unwrap();
            published.push((runtime, shim));
        }
        let (live_runtime, live_shim) = published.pop().unwrap();
        let (dead_runtime, dead_shim) = published.pop().unwrap();

        // Both shims are publishable and both point at a real Runtime.
        assert!(remove_orphaned_cli_shims(&home).unwrap().is_empty());

        fs::remove_file(&dead_runtime).unwrap();
        let removed = remove_orphaned_cli_shims(&home).unwrap();

        assert_eq!(
            removed
                .iter()
                .map(|shim| shim.command_name.as_str())
                .collect::<Vec<_>>(),
            vec!["pi"]
        );
        assert!(!dead_shim.shim_path.exists());
        assert!(live_runtime.is_file());
        assert!(live_shim.shim_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_removes_a_toolchain_shim_whose_target_is_gone() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let bin = home.join(".local").join("bin");
        let toolchain = temp.path().join("toolchain/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&toolchain).unwrap();
        fs::write(toolchain.join("node"), "#!/bin/sh\n").unwrap();
        publish_user_toolchain_commands(&home, &toolchain, &["node"], ShellFamily::Posix).unwrap();
        assert!(bin.join("node").exists());

        assert!(remove_orphaned_cli_shims(&home).unwrap().is_empty());
        fs::remove_file(toolchain.join("node")).unwrap();

        let removed = remove_orphaned_cli_shims(&home).unwrap();
        assert_eq!(removed.len(), 1, "{removed:?}");
        assert_eq!(removed[0].command_name, "node");
        assert!(!bin.join("node").exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_never_removes_a_command_vibex_did_not_publish() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let bin = home.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        // The user's own command under the vendor name, pointed at a Runtime that
        // does not exist. VibeX did not write it, so it is not VibeX's to delete.
        fs::write(bin.join("pi"), "#!/bin/sh\nexec /opt/gone/pi \"$@\"\n").unwrap();
        // VibeX's marker with nothing after it names no command to check.
        fs::write(bin.join("mystery"), "# VibeX Agent CLI:\n").unwrap();

        assert!(remove_orphaned_cli_shims(&home).unwrap().is_empty());
        assert!(bin.join("pi").exists());
        assert!(bin.join("mystery").exists());
    }

    #[test]
    fn a_home_without_a_user_bin_directory_sweeps_nothing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(remove_orphaned_cli_shims(temp.path()).unwrap().is_empty());
    }
}
