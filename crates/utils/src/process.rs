#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
#[cfg(windows)]
use std::path::PathBuf;
use std::{ffi::OsStr, path::Path};

use command_group::{AsyncCommandGroup, AsyncGroupChild};
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Pid, getpgid},
};
#[cfg(unix)]
use tokio::time::Duration;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
pub fn configure_std_command_no_window(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    command.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn configure_std_command_no_window(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    command
}

#[cfg(windows)]
pub fn configure_tokio_command_no_window(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    command.creation_flags(CREATE_NO_WINDOW)
}

#[cfg(not(windows))]
pub fn configure_tokio_command_no_window(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    command
}

#[cfg(windows)]
fn is_windows_batch_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

/// Resolve a bare program name (e.g. `npx`, `codex-acp`) to a concrete file on
/// Windows using PATH + PATHEXT, the way a shell would. Rust's `Command` calls
/// `CreateProcess`, which does NOT apply PATHEXT — so a bare `npx` (whose real
/// file is `npx.cmd`) fails to spawn. npm-installed CLIs ship as `.cmd` shims,
/// so without this every npx/binary agent silently fails to launch on Windows.
///
/// Returns `None` for names that already carry a path separator or an extension
/// (let `CreateProcess` handle those), or when nothing matches on PATH.
#[cfg(windows)]
fn resolve_windows_program(program: &Path) -> Option<PathBuf> {
    if program.components().count() != 1 || program.extension().is_some() {
        return None;
    }
    let name = program.as_os_str().to_string_lossy().to_string();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<String> = pathext
        .split(';')
        .map(|ext| ext.trim().to_string())
        .filter(|ext| !ext.is_empty())
        .collect();
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Build a tokio command that stays hidden on Windows, including `.cmd`/`.bat`
/// wrappers such as npm-installed CLIs.
pub fn new_hidden_tokio_command(
    program: impl AsRef<Path>,
    args: impl IntoIterator<Item = impl AsRef<OsStr>>,
) -> tokio::process::Command {
    let program = program.as_ref();

    #[cfg(windows)]
    {
        if is_windows_batch_script(program) {
            let mut command = tokio::process::Command::new("cmd.exe");
            configure_tokio_command_no_window(&mut command);
            command.arg("/d").arg("/c").arg(program).args(args);
            return command;
        }
        if let Some(resolved) = resolve_windows_program(program) {
            if is_windows_batch_script(&resolved) {
                let mut command = tokio::process::Command::new("cmd.exe");
                configure_tokio_command_no_window(&mut command);
                command.arg("/d").arg("/c").arg(&resolved).args(args);
                return command;
            }
            let mut command = tokio::process::Command::new(&resolved);
            configure_tokio_command_no_window(&mut command);
            command.args(args);
            return command;
        }
    }

    let mut command = tokio::process::Command::new(program);
    configure_tokio_command_no_window(&mut command);
    command.args(args);
    command
}

/// Build a std command that stays hidden on Windows, including `.cmd`/`.bat`
/// wrappers such as npm-installed CLIs.
pub fn new_hidden_std_command(
    program: impl AsRef<Path>,
    args: impl IntoIterator<Item = impl AsRef<OsStr>>,
) -> std::process::Command {
    let program = program.as_ref();

    #[cfg(windows)]
    {
        if is_windows_batch_script(program) {
            let mut command = std::process::Command::new("cmd.exe");
            configure_std_command_no_window(&mut command);
            command.arg("/d").arg("/c").arg(program).args(args);
            return command;
        }
        if let Some(resolved) = resolve_windows_program(program) {
            if is_windows_batch_script(&resolved) {
                let mut command = std::process::Command::new("cmd.exe");
                configure_std_command_no_window(&mut command);
                command.arg("/d").arg("/c").arg(&resolved).args(args);
                return command;
            }
            let mut command = std::process::Command::new(&resolved);
            configure_std_command_no_window(&mut command);
            command.args(args);
            return command;
        }
    }

    let mut command = std::process::Command::new(program);
    configure_std_command_no_window(&mut command);
    command.args(args);
    command
}

/// Spawn a tokio Command as a process group with CREATE_NO_WINDOW on Windows.
///
/// `command_group`'s `group_spawn()` overwrites any `creation_flags` previously
/// set on the Command (it calls `command.creation_flags(builder_flags | CREATE_SUSPENDED)`).
/// This helper uses the `CommandGroupBuilder` API to pass CREATE_NO_WINDOW correctly.
pub fn group_spawn_no_window(
    command: &mut tokio::process::Command,
) -> std::io::Result<AsyncGroupChild> {
    let mut builder = command.group();
    #[cfg(windows)]
    builder.creation_flags(CREATE_NO_WINDOW);
    builder.spawn()
}

pub async fn kill_process_group(child: &mut AsyncGroupChild) -> std::io::Result<()> {
    // hit the whole process group, not just the leader
    #[cfg(unix)]
    {
        if let Some(pid) = child.inner().id() {
            let pgid = getpgid(Some(Pid::from_raw(pid as i32)))
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            for sig in [Signal::SIGINT, Signal::SIGTERM, Signal::SIGKILL] {
                tracing::info!("Sending {:?} to process group {}", sig, pgid);
                if let Err(e) = killpg(pgid, sig) {
                    tracing::warn!(
                        "Failed to send signal {:?} to process group {}: {}",
                        sig,
                        pgid,
                        e
                    );
                }
                tracing::info!("Waiting 2s for process group {} to exit", pgid);
                tokio::time::sleep(Duration::from_secs(2)).await;
                if child.inner().try_wait()?.is_some() {
                    tracing::info!("Process group {} exited after {:?}", pgid, sig);
                    break;
                }
            }
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}

pub fn command_output_detail(output: &std::process::Output) -> Option<String> {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Some(stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!stdout.is_empty()).then_some(stdout)
}

#[cfg(test)]
mod command_output_detail_tests {
    use std::process::{ExitStatus, Output};

    use super::command_output_detail;

    #[cfg(unix)]
    fn failure_status() -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(1)
    }

    #[cfg(windows)]
    fn failure_status() -> ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(1)
    }

    fn output(stdout: &[u8], stderr: &[u8]) -> Output {
        Output {
            status: failure_status(),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn command_output_detail_prefers_stderr() {
        let output = output(b"stdout detail\n", b" stderr detail \n");

        assert_eq!(command_output_detail(&output), Some("stderr detail".into()));
    }

    #[test]
    fn command_output_detail_uses_stdout_when_stderr_is_empty() {
        let output = output(b" stdout detail \n", b"  \n");

        assert_eq!(command_output_detail(&output), Some("stdout detail".into()));
    }

    #[test]
    fn command_output_detail_returns_none_when_output_is_empty() {
        let output = output(b"  \n", b"\t\n");

        assert_eq!(command_output_detail(&output), None);
    }
}

#[cfg(test)]
mod command_construction_tests {
    use std::ffi::OsString;

    use super::{new_hidden_std_command, new_hidden_tokio_command};

    fn os_args(args: impl Iterator<Item = OsString>) -> Vec<OsString> {
        args.collect()
    }

    #[test]
    fn std_hidden_command_preserves_program_and_args() {
        let command = new_hidden_std_command("tool", ["--flag", "value with spaces"]);

        assert_eq!(command.get_program(), "tool");
        assert_eq!(
            os_args(command.get_args().map(OsString::from)),
            vec![
                OsString::from("--flag"),
                OsString::from("value with spaces")
            ]
        );
    }

    #[test]
    fn tokio_hidden_command_preserves_program_and_args() {
        let command = new_hidden_tokio_command("tool", ["--flag", "value with spaces"]);
        let std_command = command.as_std();

        assert_eq!(std_command.get_program(), "tool");
        assert_eq!(
            os_args(std_command.get_args().map(OsString::from)),
            vec![
                OsString::from("--flag"),
                OsString::from("value with spaces")
            ]
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::{
        fs,
        process::Stdio,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{new_hidden_std_command, new_hidden_tokio_command};

    #[tokio::test]
    async fn tokio_regular_executable_runs_with_args() {
        let mut command = new_hidden_tokio_command("cmd.exe", ["/d", "/c", "echo ok"]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = command.output().await.expect("run regular executable");

        assert!(
            output.status.success(),
            "expected success, got status {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[test]
    fn std_regular_executable_runs_with_args() {
        let output = new_hidden_std_command("cmd.exe", ["/d", "/c", "echo ok"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("run regular executable");

        assert!(
            output.status.success(),
            "expected success, got status {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[tokio::test]
    async fn batch_script_with_spaces_runs_successfully() {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "vibex-process-{unique_suffix}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temp_dir).expect("create temp test dir");

        let script_path = temp_dir.join("hello world.cmd");
        fs::write(&script_path, "@echo off\r\necho ok %1\r\n").expect("write batch script");

        let mut command = new_hidden_tokio_command(&script_path, ["arg"]);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        let output = command.output().await.expect("run batch script");

        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_dir(&temp_dir);

        assert!(
            output.status.success(),
            "expected success, got status {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok arg");
    }

    #[test]
    fn std_batch_script_with_spaces_runs_successfully() {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!(
            "vibex-process-std-{unique_suffix}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temp_dir).expect("create temp test dir");

        let script_path = temp_dir.join("hello world.cmd");
        fs::write(&script_path, "@echo off\r\necho ok %1\r\n").expect("write batch script");

        let output = new_hidden_std_command(&script_path, ["arg"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("run batch script");

        let _ = fs::remove_file(&script_path);
        let _ = fs::remove_dir(&temp_dir);

        assert!(
            output.status.success(),
            "expected success, got status {:?}, stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok arg");
    }
}
