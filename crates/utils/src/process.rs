use command_group::{AsyncCommandGroup, AsyncGroupChild};
#[cfg(unix)]
use nix::{
    sys::signal::{Signal, killpg},
    unistd::{Pid, getpgid},
};
#[cfg(unix)]
use tokio::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

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
