use std::ffi::{OsStr, OsString};

#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn configure_tokio_command(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

#[cfg(windows)]
fn maybe_windows_cmd_shim(program: &OsStr) -> Option<OsString> {
    let path = Path::new(program);
    if path.components().count() != 1 || path.extension().is_some() {
        return None;
    }

    let raw = program.to_string_lossy();
    let normalized = raw.to_ascii_lowercase();
    let needs_cmd_shim = matches!(
        normalized.as_str(),
        "npm" | "npx" | "pnpm" | "pnpx" | "yarn" | "yarnpkg" | "corepack"
    );

    if needs_cmd_shim {
        Some(OsString::from(format!("{raw}.cmd")))
    } else {
        None
    }
}

pub fn normalized_program<S>(program: S) -> OsString
where
    S: AsRef<OsStr>,
{
    #[cfg(windows)]
    {
        if let Some(shimmed) = maybe_windows_cmd_shim(program.as_ref()) {
            return shimmed;
        }
    }

    program.as_ref().to_os_string()
}

pub fn tokio_command<S>(program: S) -> tokio::process::Command
where
    S: AsRef<OsStr>,
{
    let mut command = tokio::process::Command::new(normalized_program(program));
    configure_tokio_command(&mut command);
    command
}
