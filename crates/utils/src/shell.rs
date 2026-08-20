//! Cross-platform shell command utilities

use std::{
    collections::HashSet,
    env::{join_paths, split_paths},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use crate::tokio::block_on;

/// Returns the appropriate shell command and argument for the current platform.
///
/// Returns (shell_program, shell_arg) where:
/// - Windows: Git Bash `bash.exe -c` when present, otherwise `cmd /C`
/// - Unix-like: ("sh", "-c") or the user's login shell
pub fn get_shell_command() -> (String, &'static str) {
    if cfg!(windows) {
        if let Ok(bash) = which::which("bash").or_else(|_| which::which("bash.exe")) {
            return (bash.to_string_lossy().into_owned(), "-c");
        }
        ("cmd".into(), "/C")
    } else {
        UnixShell::current_shell().get_shell_command()
    }
}

/// Returns the path to an interactive shell for the current platform.
/// Used for spawning PTY sessions.
///
/// On Windows, prefers PowerShell if available, falling back to cmd.exe.
/// On Unix, returns the user's configured shell from $SHELL.
pub async fn get_interactive_shell() -> PathBuf {
    if cfg!(windows) {
        // Prefer PowerShell if available, fall back to cmd.exe
        if let Some(powershell) = resolve_executable_path("powershell.exe").await {
            powershell
        } else {
            PathBuf::from("cmd.exe")
        }
    } else {
        UnixShell::current_shell().path().to_path_buf()
    }
}

/// Resolve an executable by name, falling back to a refreshed PATH if needed.
///
/// The search order is:
/// 1. Explicit paths (absolute or containing a separator).
/// 2. The current process PATH via `which`.
/// 3. A platform-specific refresh of PATH (login shell on Unix, PowerShell on Windows),
///    after which we re-run the `which` lookup and update the process PATH for future calls.
pub async fn resolve_executable_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }

    let path = Path::new(executable);
    if path.is_absolute() && path.is_file() {
        return Some(path.to_path_buf());
    }

    if let Some(found) = which(executable).await {
        return Some(found);
    }

    if let Some(home) = dirs::home_dir()
        && let Some(found) = find_executable_in_user_bin(executable, &home)
    {
        return Some(found);
    }

    // A desktop process is commonly launched with a smaller PATH than an
    // interactive shell. Refresh it once for the whole process, rather than
    // paying for several login-shell subprocesses for every missing command
    // during startup inventory (one per Agent/runtime used to make a clean
    // install noticeably slow).
    if refresh_process_path().await
        && let Some(found) = which(executable).await
    {
        return Some(found);
    }

    None
}

pub fn resolve_executable_path_blocking(executable: &str) -> Option<PathBuf> {
    block_on(resolve_executable_path(executable))
}

/// Merge two PATH strings into a single, de-duplicated PATH.
///
/// - Keeps the order of entries from `primary`.
/// - Appends only *unseen* entries from `secondary`.
/// - Ignores empty components.
/// - Returns a platform-correct PATH string (using the OS separator).
pub fn merge_paths(primary: impl AsRef<OsStr>, secondary: impl AsRef<OsStr>) -> OsString {
    let mut seen = HashSet::<PathBuf>::new();
    let mut merged = Vec::<PathBuf>::new();

    for p in split_paths(primary.as_ref()).chain(split_paths(secondary.as_ref())) {
        if !p.as_os_str().is_empty() && seen.insert(p.clone()) {
            merged.push(p);
        }
    }

    join_paths(merged).unwrap_or_default()
}

/// Expose a user-global binary directory to subsequently launched Agent
/// processes without adding any VibeX-private directory.
pub fn expose_user_bin_to_process_path(directory: &Path) {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let merged = merge_paths(directory.as_os_str(), &existing);
    if merged != existing {
        unsafe {
            std::env::set_var("PATH", merged);
        }
    }
}

async fn refresh_path() -> bool {
    let Some(refreshed) = get_fresh_path().await else {
        return false;
    };
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let refreshed_os = OsString::from(&refreshed);
    let merged = merge_paths(&existing, refreshed_os);
    if merged == existing {
        return false;
    }
    tracing::debug!(?existing, ?refreshed, ?merged, "Refreshed PATH");
    unsafe {
        std::env::set_var("PATH", &merged);
    }
    true
}

/// Serialize and de-duplicate the implicit PATH refresh that follows a failed
/// executable lookup. `resolve_executable_path` may be called concurrently by
/// startup/preflight inventory, so a plain boolean would still let multiple
/// login shells run at once. Explicit post-install refreshes use the force
/// variant below and are intentionally not suppressed.
static IMPLICIT_PATH_REFRESH: OnceLock<tokio::sync::OnceCell<bool>> = OnceLock::new();

async fn refresh_path_once() -> bool {
    let cell = IMPLICIT_PATH_REFRESH.get_or_init(tokio::sync::OnceCell::const_new);
    *cell.get_or_init(|| async { refresh_path().await }).await
}

/// Refresh the current process PATH from the user's shell or system environment.
///
/// Desktop apps can be launched with a stale or reduced PATH. Calling this
/// before spawning agent processes lets child commands inherit the same tools
/// a user expects in their normal terminal.
pub async fn refresh_process_path() -> bool {
    refresh_path_once().await
}

/// Re-read PATH after VibeX itself has installed or updated a tool. Unlike
/// normal resolution this must not be cached: npm/fnm/nvm layouts can expose a
/// new global-bin directory only after the install finishes.
pub async fn refresh_process_path_after_install() -> bool {
    refresh_path().await
}

async fn which(executable: &str) -> Option<PathBuf> {
    let executable = executable.to_string();
    tokio::task::spawn_blocking(move || which::which(executable))
        .await
        .ok()
        .and_then(|result| result.ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserBinPlatform {
    Windows,
    Unix,
}

fn user_bin_directories(
    platform: UserBinPlatform,
    home: &Path,
    mut read_env: impl FnMut(&str) -> Option<OsString>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !directories.contains(&path) {
            directories.push(path);
        }
    };

    if let Some(pnpm_home) = read_env("PNPM_HOME") {
        push(PathBuf::from(pnpm_home));
    }
    if let Some(npm_prefix) = read_env("NPM_CONFIG_PREFIX") {
        let prefix = PathBuf::from(npm_prefix);
        push(match platform {
            UserBinPlatform::Windows => prefix,
            UserBinPlatform::Unix => prefix.join("bin"),
        });
    }

    match platform {
        UserBinPlatform::Windows => {
            let app_data = read_env("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Roaming"));
            let local_app_data = read_env("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData/Local"));
            push(app_data.join("npm"));
            push(local_app_data.join("pnpm"));
            push(home.join(".local/bin"));
        }
        UserBinPlatform::Unix => {
            push(home.join(".local/bin"));
            push(home.join(".local/share/pnpm"));
            push(home.join(".npm-global/bin"));
        }
    }

    push(home.join(".bun/bin"));
    push(home.join(".cargo/bin"));
    directories
}

fn find_executable_in_user_bin(executable: &str, home: &Path) -> Option<PathBuf> {
    let platform = if cfg!(windows) {
        UserBinPlatform::Windows
    } else {
        UserBinPlatform::Unix
    };
    let search_path = join_paths(user_bin_directories(platform, home, |name| {
        std::env::var_os(name)
    }))
    .ok()?;
    which::which_in(executable, Some(search_path), home).ok()
}

#[derive(Debug, Clone, PartialEq)]
pub enum UnixShell {
    Zsh(PathBuf),
    Bash(PathBuf),
    Sh(PathBuf),
    Other(PathBuf),
}

impl UnixShell {
    pub fn path(&self) -> &Path {
        match self {
            UnixShell::Zsh(p) | UnixShell::Bash(p) | UnixShell::Sh(p) | UnixShell::Other(p) => p,
        }
    }
    pub fn login(&self) -> bool {
        matches!(self, UnixShell::Zsh(_) | UnixShell::Bash(_))
    }
    pub fn config_file(&self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        let config_file = match self {
            UnixShell::Zsh(_) => Some(home.join(".zshrc")),
            UnixShell::Bash(_) => Some(home.join(".bashrc")),
            UnixShell::Sh(_) | UnixShell::Other(_) => None,
        };
        config_file.filter(|p| p.is_file())
    }

    pub fn source_command(&self) -> Option<String> {
        if let Some(source_file) = self.config_file()
            && let Ok(escaped_source_file) =
                shlex::try_quote(source_file.to_string_lossy().as_ref())
        {
            Some(format!("source {escaped_source_file}"))
        } else {
            None
        }
    }
    pub fn current_shell() -> UnixShell {
        if let Ok(shell) = std::env::var("SHELL")
            && let Some(shell) = UnixShell::from_path(Path::new(&shell))
        {
            return shell;
        }
        UnixShell::Sh(PathBuf::from("/bin/sh"))
    }
    pub fn from_path(path: &Path) -> Option<UnixShell> {
        if path.is_absolute() && path.is_file() {
            let path_buf = path.to_path_buf();
            if path.file_name() == Some(OsStr::new("zsh")) {
                Some(UnixShell::Zsh(path_buf))
            } else if path.file_name() == Some(OsStr::new("bash")) {
                Some(UnixShell::Bash(path_buf))
            } else if path.file_name() == Some(OsStr::new("sh")) {
                Some(UnixShell::Sh(path_buf))
            } else {
                Some(UnixShell::Other(path_buf))
            }
        } else {
            None
        }
    }
    pub fn get_shell_command(&self) -> (String, &'static str) {
        (self.path().to_string_lossy().into_owned(), "-c")
    }
}

#[cfg(not(windows))]
async fn get_fresh_path() -> Option<String> {
    use std::{process::Stdio, time::Duration};

    use tokio::process::Command;

    async fn run(shell: &UnixShell) -> Option<String> {
        let mut cmd = Command::new(shell.path());
        if shell.login() {
            cmd.arg("-l");
        }
        if let Some(source_command) = shell.source_command() {
            cmd.arg("-c")
                .arg(format!("{source_command}; printf '%s' \"$PATH\""));
        } else {
            cmd.arg("-c").arg("printf '%s' \"$PATH\"");
        }
        cmd.env("TERM", "dumb")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        const PATH_REFRESH_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

        let child = cmd.spawn().ok()?;
        let output = match tokio::time::timeout(
            PATH_REFRESH_COMMAND_TIMEOUT,
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(output)) => output,
            Ok(Err(err)) => {
                tracing::debug!(
                    shell = %shell.path().display(),
                    ?err,
                    "Failed to retrieve PATH from login shell"
                );
                return None;
            }
            Err(_) => {
                tracing::warn!(
                    shell = %shell.path().display(),
                    timeout_secs = PATH_REFRESH_COMMAND_TIMEOUT.as_secs(),
                    "Timed out retrieving PATH from login shell"
                );
                return None;
            }
        };

        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if path.is_empty() { None } else { Some(path) }
    }

    let mut paths = Vec::<OsString>::new();

    let current_shell = UnixShell::current_shell();
    if let Some(path) = run(&current_shell).await {
        paths.push(OsString::from(path));
    }

    let shells: Vec<UnixShell> = ["/bin/zsh", "/bin/bash", "/bin/sh"]
        .into_iter()
        .filter_map(|p| UnixShell::from_path(Path::new(p)))
        .collect();
    for shell in shells {
        if !(shell == current_shell)
            && let Some(path) = run(&shell).await
        {
            paths.push(OsString::from(path));
        }
    }

    if paths.is_empty() {
        return None;
    }

    paths
        .into_iter()
        .reduce(|a, b| merge_paths(&a, &b))
        .map(|merged| merged.to_string_lossy().into_owned())
}

#[cfg(windows)]
async fn get_fresh_path() -> Option<String> {
    tokio::task::spawn_blocking(get_fresh_path_blocking)
        .await
        .ok()
        .flatten()
}

#[cfg(windows)]
fn get_fresh_path_blocking() -> Option<String> {
    use std::{
        ffi::{OsStr, OsString},
        os::windows::ffi::{OsStrExt, OsStringExt},
    };

    use winreg::{HKEY, RegKey, enums::*};

    // Expand %VARS% for registry PATH entries
    fn expand_env_vars(input: &OsStr) -> OsString {
        use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;

        let wide: Vec<u16> = input.encode_wide().chain(Some(0)).collect();
        unsafe {
            let needed = ExpandEnvironmentStringsW(wide.as_ptr(), std::ptr::null_mut(), 0);
            if needed == 0 {
                return input.to_os_string();
            }
            let mut buf = vec![0u16; needed as usize];
            let written = ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), needed);
            if written == 0 {
                return input.to_os_string();
            }
            // written includes the trailing NUL when it fits
            OsString::from_wide(&buf[..(written as usize).saturating_sub(1)])
        }
    }

    fn read_registry_path(root: HKEY, subkey: &str) -> Option<OsString> {
        let key = RegKey::predef(root)
            .open_subkey_with_flags(subkey, KEY_READ)
            .ok()?;
        key.get_value::<String, _>("Path").ok().map(OsString::from)
    }

    let mut paths: Vec<OsString> = Vec::new();

    if let Some(user_path) = read_registry_path(HKEY_CURRENT_USER, "Environment") {
        paths.push(expand_env_vars(&user_path));
    }

    if let Some(machine_path) = read_registry_path(
        HKEY_LOCAL_MACHINE,
        r"System\CurrentControlSet\Control\Session Manager\Environment",
    ) {
        paths.push(expand_env_vars(&machine_path));
    }

    if paths.is_empty() {
        return None;
    }

    paths
        .into_iter()
        .reduce(|a, b| merge_paths(&a, &b))
        .map(|merged| merged.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, ffi::OsString, path::Path};

    use super::{UserBinPlatform, user_bin_directories};

    #[test]
    fn windows_user_bins_include_npm_pnpm_bun_and_cargo_locations() {
        let home = Path::new(r"C:\Users\developer");
        let environment = HashMap::from([
            (
                "APPDATA",
                OsString::from(r"C:\Users\developer\AppData\Roaming"),
            ),
            (
                "LOCALAPPDATA",
                OsString::from(r"C:\Users\developer\AppData\Local"),
            ),
            ("PNPM_HOME", OsString::from(r"D:\pnpm")),
            ("NPM_CONFIG_PREFIX", OsString::from(r"D:\npm-prefix")),
        ]);

        let directories = user_bin_directories(UserBinPlatform::Windows, home, |name| {
            environment.get(name).cloned()
        });

        assert_eq!(
            directories,
            vec![
                Path::new(r"D:\pnpm").to_path_buf(),
                Path::new(r"D:\npm-prefix").to_path_buf(),
                Path::new(r"C:\Users\developer\AppData\Roaming").join("npm"),
                Path::new(r"C:\Users\developer\AppData\Local").join("pnpm"),
                home.join(".local/bin"),
                home.join(".bun/bin"),
                home.join(".cargo/bin"),
            ]
        );
    }

    #[test]
    fn unix_user_bins_include_pnpm_npm_bun_and_cargo_locations() {
        let home = Path::new("/home/developer");
        let environment = HashMap::from([
            ("PNPM_HOME", OsString::from("/opt/pnpm")),
            ("NPM_CONFIG_PREFIX", OsString::from("/opt/npm")),
        ]);

        let directories = user_bin_directories(UserBinPlatform::Unix, home, |name| {
            environment.get(name).cloned()
        });

        assert_eq!(
            directories,
            vec![
                Path::new("/opt/pnpm").to_path_buf(),
                Path::new("/opt/npm/bin").to_path_buf(),
                home.join(".local/bin"),
                home.join(".local/share/pnpm"),
                home.join(".npm-global/bin"),
                home.join(".bun/bin"),
                home.join(".cargo/bin"),
            ]
        );
    }

    #[cfg(unix)]
    mod unix_resolution {
        use std::os::unix::fs::PermissionsExt;

        use super::super::find_executable_in_user_bin;

        #[test]
        fn resolves_vibex_stable_user_command_without_a_login_shell() {
            let home = tempfile::tempdir().unwrap();
            let bin = home.path().join(".local/bin");
            std::fs::create_dir_all(&bin).unwrap();
            let executable = bin.join("codex");
            std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
            let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions).unwrap();

            assert_eq!(
                find_executable_in_user_bin("codex", home.path()),
                Some(executable)
            );
        }
    }
}
