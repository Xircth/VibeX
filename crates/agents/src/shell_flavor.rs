//! Shell family classification shared by the built-in PTY and the ACP terminal
//! runtime.
//!
//! Both need the same answer — "what dialect does this shell path speak?" —
//! so a Windows `COMSPEC` pointing at a cmd-compatible replacement gets `/C`
//! rather than POSIX `-c`.

use std::path::Path;

/// Lowercased file name of a shell path, falling back to the raw value when the
/// path has no file-name component.
pub fn shell_basename(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase()
}

/// The command-line dialect a shell speaks. This is about invocation syntax
/// (`-c` vs `/C` vs `-Command`), not login/interactive flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    /// `pwsh` / `powershell`: `-NoLogo -NoProfile -Command <script>`.
    PowerShell,
    /// `cmd.exe` and cmd-compatible replacements: `/D /S /C <line>`.
    Cmd,
    /// Everything with the POSIX `-c <line>` convention.
    Posix,
}

impl ShellFamily {
    /// Whether the shell resolves names the OS cannot exec on its own — its
    /// builtins and aliases. `Get-ChildItem` and `dir` are real commands to
    /// PowerShell and cmd but not to `execvp`.
    pub fn resolves_bare_builtins(self) -> bool {
        matches!(self, ShellFamily::PowerShell | ShellFamily::Cmd)
    }
}

/// Classify a shell path. The unknown-shell fallback is platform-specific:
/// on Windows an unrecognized `COMSPEC` is overwhelmingly a cmd replacement,
/// while on unix an unrecognized shell is overwhelmingly POSIX-ish.
pub fn classify_shell_family(shell: &str) -> ShellFamily {
    let name = shell_basename(shell);

    if name.contains("pwsh") || name.contains("powershell") {
        return ShellFamily::PowerShell;
    }
    if name == "cmd" || name == "cmd.exe" {
        return ShellFamily::Cmd;
    }

    #[cfg(target_os = "windows")]
    {
        if name.contains("bash")
            || name.contains("zsh")
            || name.contains("fish")
            || name.ends_with("sh.exe")
        {
            ShellFamily::Posix
        } else {
            ShellFamily::Cmd
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ShellFamily::Posix
    }
}

/// bash / zsh / sh / dash / ksh / ash / mksh / busybox / fish accept `-l -i`
/// and `eval "$VAR"`. Unknown shells get a raw spawn.
pub fn is_bash_like_posix_shell(shell: &str) -> bool {
    matches!(
        shell_basename(shell).as_str(),
        "bash"
            | "zsh"
            | "sh"
            | "dash"
            | "ksh"
            | "ash"
            | "mksh"
            | "busybox"
            | "fish"
            | "bash.exe"
            | "zsh.exe"
            | "sh.exe"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basename_lowercases_and_strips_directories() {
        assert_eq!(shell_basename("/bin/ZSH"), "zsh");
        assert_eq!(shell_basename("pwsh.exe"), "pwsh.exe");
        assert_eq!(shell_basename("C:\\tools\\nu.exe"), {
            if cfg!(target_os = "windows") {
                "nu.exe".to_string()
            } else {
                "c:\\tools\\nu.exe".to_string()
            }
        });
    }

    #[test]
    fn powershell_is_recognized_on_every_platform() {
        assert_eq!(classify_shell_family("pwsh"), ShellFamily::PowerShell);
        assert_eq!(classify_shell_family("pwsh.exe"), ShellFamily::PowerShell);
        assert_eq!(
            classify_shell_family("C:\\Program Files\\PowerShell\\7\\powershell.exe"),
            ShellFamily::PowerShell
        );
    }

    #[test]
    fn cmd_is_recognized_by_name_on_every_platform() {
        assert_eq!(classify_shell_family("cmd.exe"), ShellFamily::Cmd);
        assert_eq!(classify_shell_family("CMD.EXE"), ShellFamily::Cmd);
        assert_eq!(classify_shell_family("cmd"), ShellFamily::Cmd);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unknown_unix_shells_are_posix() {
        assert_eq!(classify_shell_family("/bin/sh"), ShellFamily::Posix);
        assert_eq!(
            classify_shell_family("/usr/local/bin/fish"),
            ShellFamily::Posix
        );
        assert_eq!(classify_shell_family("/opt/nu"), ShellFamily::Posix);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unknown_windows_shells_fall_back_to_cmd() {
        assert_eq!(
            classify_shell_family("C:\\Windows\\System32\\cmd.exe"),
            ShellFamily::Cmd
        );
        assert_eq!(
            classify_shell_family("C:\\tools\\tcc.exe"),
            ShellFamily::Cmd
        );
        assert_eq!(
            classify_shell_family("C:\\Program Files\\Git\\bin\\bash.exe"),
            ShellFamily::Posix
        );
        assert_eq!(classify_shell_family("sh.exe"), ShellFamily::Posix);
    }

    #[test]
    fn only_windows_shells_resolve_bare_builtins() {
        assert!(ShellFamily::PowerShell.resolves_bare_builtins());
        assert!(ShellFamily::Cmd.resolves_bare_builtins());
        assert!(!ShellFamily::Posix.resolves_bare_builtins());
    }

    #[test]
    fn bash_like_posix_shells_accept_login_flags() {
        assert!(is_bash_like_posix_shell("/bin/zsh"));
        assert!(is_bash_like_posix_shell("bash.exe"));
        assert!(!is_bash_like_posix_shell("pwsh"));
        assert!(!is_bash_like_posix_shell("nu"));
    }
}
