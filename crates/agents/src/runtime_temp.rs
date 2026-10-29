//! Writable short temp dir for ACP children.
//!
//! Google Antigravity's `agy_acp_server.exe` is a PyInstaller onefile. The
//! bootloader extracts into `%TEMP%\_MEI*` before any ACP handshake. If TEMP,
//! TMP, or TMPDIR is missing, a file, not writable, or so long that
//! `CreateDirectoryW` exceeds MAX_PATH, the child exits immediately:
//! `[PYI-33104:ERROR] Could not create temporary directory!` with Windows
//! status `-1` (`0xffffffff`).
//!
//! VibeX also kills ACP process groups (`kill_on_drop` / idle sweep) before
//! the bootloader can delete `_MEI*`, so the user TEMP fills with leftovers
//! and later creates start failing. Host-managed `%LOCALAPPDATA%\VibeX\acp-tmp\<agent>`
//! is short, writable, and isolated from that pollution.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};

use crate::AgentId;

const ACP_TMP_ROOT: &str = "VibeX";
const ACP_TMP_LEAF: &str = "acp-tmp";

pub fn agent_runtime_temp_dir_in(base: &Path, agent_id: &AgentId) -> PathBuf {
    base.join(ACP_TMP_ROOT)
        .join(ACP_TMP_LEAF)
        .join(agent_id.as_str())
}

fn runtime_temp_base() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
        })
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn agent_runtime_temp_dir(agent_id: &AgentId) -> PathBuf {
    agent_runtime_temp_dir_in(&runtime_temp_base(), agent_id)
}

pub fn prepare_agent_runtime_temp_in(base: &Path, agent_id: &AgentId) -> io::Result<PathBuf> {
    let dir = agent_runtime_temp_dir_in(base, agent_id);
    fs::create_dir_all(&dir)?;
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok")?;
    let _ = fs::remove_file(&probe);
    Ok(dir)
}

pub fn prepare_agent_runtime_temp(agent_id: &AgentId) -> io::Result<PathBuf> {
    prepare_agent_runtime_temp_in(&runtime_temp_base(), agent_id)
}

pub fn bind_agent_runtime_temp_env(env: &mut HashMap<String, String>, dir: &Path) {
    let value = dir.to_string_lossy().into_owned();
    env.insert("TEMP".to_string(), value.clone());
    env.insert("TMP".to_string(), value.clone());
    env.insert("TMPDIR".to_string(), value);
}

pub fn prepare_and_bind_agent_runtime_temp(
    agent_id: &AgentId,
    env: &mut HashMap<String, String>,
) -> io::Result<PathBuf> {
    let dir = prepare_agent_runtime_temp(agent_id)?;
    bind_agent_runtime_temp_env(env, &dir);
    Ok(dir)
}

#[cfg(test)]
fn prepare_and_bind_agent_runtime_temp_in(
    base: &Path,
    agent_id: &AgentId,
    env: &mut HashMap<String, String>,
) -> io::Result<PathBuf> {
    let dir = prepare_agent_runtime_temp_in(base, agent_id)?;
    bind_agent_runtime_temp_env(env, &dir);
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("bundled AgentId")
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root = std::env::var_os("CARGO_TARGET_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
            let dir = root
                .join("runtime-temp-tests")
                .join(uuid::Uuid::new_v4().simple().to_string());
            fs::create_dir_all(&dir).expect("test scratch must be writable");
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn prepare_creates_a_writable_per_agent_directory() {
        let tmp = Scratch::new();
        let antigravity = agent("antigravity");
        let grok = agent("grok");

        let agy_dir = prepare_agent_runtime_temp_in(&tmp.0, &antigravity).unwrap();
        let grok_dir = prepare_agent_runtime_temp_in(&tmp.0, &grok).unwrap();

        assert_eq!(
            agy_dir,
            tmp.0.join("VibeX").join("acp-tmp").join("antigravity")
        );
        assert_ne!(agy_dir, grok_dir);
        assert!(agy_dir.is_dir());

        let marker = agy_dir.join("_MEIprobe");
        fs::create_dir(&marker).expect("PyInstaller must be able to mkdir _MEI* here");
        fs::remove_dir(&marker).unwrap();
    }

    #[test]
    fn bind_overwrites_an_unwritable_inherited_temp() {
        let tmp = Scratch::new();
        let blocked = tmp.0.join("temp-is-a-file");
        fs::write(&blocked, b"not a directory").unwrap();
        let agent_id = agent("antigravity");
        let mut env = HashMap::from([
            ("TEMP".to_string(), blocked.to_string_lossy().into_owned()),
            ("TMP".to_string(), blocked.to_string_lossy().into_owned()),
            ("TMPDIR".to_string(), r"C:\Windows\System32".to_string()),
        ]);

        let dir = prepare_and_bind_agent_runtime_temp_in(&tmp.0, &agent_id, &mut env).unwrap();
        let expected = dir.to_string_lossy();

        assert_eq!(env.get("TEMP").map(String::as_str), Some(expected.as_ref()));
        assert_eq!(env.get("TMP").map(String::as_str), Some(expected.as_ref()));
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some(expected.as_ref())
        );
        assert!(dir.starts_with(&tmp.0));
        assert!(!dir.starts_with(&blocked));
    }

    #[test]
    fn prepare_fails_when_the_base_path_is_a_file() {
        let tmp = Scratch::new();
        let file_base = tmp.0.join("not-a-dir");
        fs::write(&file_base, b"nope").unwrap();
        assert!(prepare_agent_runtime_temp_in(&file_base, &agent("antigravity")).is_err());
    }

    #[test]
    fn production_temp_dir_is_not_the_process_temp() {
        let dir = agent_runtime_temp_dir(&agent("antigravity"));
        let process_temp = std::env::temp_dir();
        assert!(
            !dir.starts_with(&process_temp),
            "ACP temp {} must not live under process TEMP {}",
            dir.display(),
            process_temp.display()
        );
    }
}
