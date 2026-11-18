//! Writable short temp dir for ACP children.
//!
//! Google Antigravity's `agy_acp_server.exe` is a PyInstaller onefile. The
//! bootloader extracts into `%TEMP%\_MEI*` before any ACP handshake. If TEMP,
//! TMP, or TMPDIR is missing, a file, not writable, or so long that
//! `CreateDirectoryW` exceeds MAX_PATH, the child exits immediately:
//! `[PYI-33104:ERROR] Could not create temporary directory!` with Windows
//! status `-1` (`0xffffffff`).
//!
//! Dimo kills ACP process groups (`kill_on_drop`, idle sweep, job terminate)
//! before the bootloader can delete `_MEI*`. ACP launches and the Antigravity
//! sign-in helper therefore each get a directory under
//! `%LOCALAPPDATA%\Dimo\acp-tmp\<agent>\run-*`, removed when that launch ends.
//! Leftover `_MEI*` extracts and abandoned `run-*` directories are swept at
//! startup and before the next launch. A directory still held open by a
//! process, or a pending launch younger than two minutes, is left in place.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use crate::AgentId;

const ACP_TMP_ROOT: &str = "Dimo";
const ACP_TMP_LEAF: &str = "acp-tmp";
const PREPARE_ATTEMPTS: u32 = 5;
const PREPARE_RETRY_SLEEP: Duration = Duration::from_millis(30);
const CLEANUP_ATTEMPTS: u32 = 8;
const CLEANUP_RETRY_SLEEP: Duration = Duration::from_millis(50);
const SESSION_DIR_PREFIX: &str = "run-";
const SESSION_OWNER_FILE: &str = ".dimo-runtime-owner";
const SESSION_PENDING_GRACE: Duration = Duration::from_secs(120);

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
    prepare_writable_dir(&agent_runtime_temp_dir_in(base, agent_id))
}

pub fn prepare_agent_runtime_temp(agent_id: &AgentId) -> io::Result<PathBuf> {
    prepare_agent_runtime_temp_from_bases(runtime_temp_candidate_bases(), agent_id)
}

fn prepare_agent_runtime_temp_from_bases(
    bases: impl IntoIterator<Item = PathBuf>,
    agent_id: &AgentId,
) -> io::Result<PathBuf> {
    let mut last_error = None;
    for base in bases {
        match prepare_agent_runtime_temp_in(&base, agent_id) {
            Ok(dir) => return Ok(dir),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "no ACP temporary directory candidate",
        )
    }))
}

fn runtime_temp_candidate_bases() -> Vec<PathBuf> {
    let primary = runtime_temp_base();
    let scratch = workspace_utils::path::get_dimo_temp_dir();
    if scratch == primary {
        vec![primary]
    } else {
        vec![primary, scratch]
    }
}

fn prepare_writable_dir(dir: &Path) -> io::Result<PathBuf> {
    let mut last_error = None;
    for attempt in 0..PREPARE_ATTEMPTS {
        match try_prepare_writable_dir(dir) {
            Ok(path) => return Ok(path),
            Err(error) if is_transient_fs_error(&error) && attempt + 1 < PREPARE_ATTEMPTS => {
                last_error = Some(error);
                std::thread::sleep(PREPARE_RETRY_SLEEP);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not create a writable ACP temporary directory",
        )
    }))
}

fn try_prepare_writable_dir(dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    // A shared `.write-probe` races when two connections spawn the same
    // agent: Windows returns ACCESS_DENIED (5) or SHARING_VIOLATION (32).
    let probe = dir.join(format!(".write-probe-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&probe, b"ok")?;
    let _ = fs::remove_file(&probe);
    Ok(dir.to_path_buf())
}

fn is_transient_fs_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Interrupted | io::ErrorKind::TimedOut
    ) || matches!(error.raw_os_error(), Some(5 | 32))
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

/// One ACP or native-engine launch's temporary directory.
///
/// Dropping the session removes that directory, including any PyInstaller
/// `_MEI*` tree the child extracted into it.
#[must_use = "dropping the session removes its temporary directory"]
pub struct AgentRuntimeTempSession {
    dir: PathBuf,
}

impl AgentRuntimeTempSession {
    pub fn path(&self) -> &Path {
        &self.dir
    }

    pub fn bind_env(&self, env: &mut HashMap<String, String>) {
        bind_agent_runtime_temp_env(env, &self.dir);
    }

    pub fn record_owner_pid(&self, pid: u32) {
        let _ = fs::write(self.dir.join(SESSION_OWNER_FILE), pid.to_string());
    }
}

impl Drop for AgentRuntimeTempSession {
    fn drop(&mut self) {
        release_runtime_temp_session(&self.dir);
    }
}

pub fn prepare_agent_runtime_temp_session(
    agent_id: &AgentId,
) -> io::Result<AgentRuntimeTempSession> {
    let parent = prepare_agent_runtime_temp(agent_id)?;
    create_runtime_temp_session(&parent)
}

/// Remove PyInstaller extracts and abandoned per-launch directories under
/// every host ACP temp root. Safe to call while other launches are running:
/// open extracts and sessions owned by a live process are skipped.
pub fn sweep_stale_agent_runtime_temps() {
    let mut removed = 0u32;
    for base in runtime_temp_candidate_bases() {
        let root = base.join(ACP_TMP_ROOT).join(ACP_TMP_LEAF);
        removed += sweep_runtime_temp_root(&root);
    }
    if removed > 0 {
        tracing::info!(
            removed,
            "removed stale ACP PyInstaller temporary directories"
        );
    }
}

fn create_runtime_temp_session(parent: &Path) -> io::Result<AgentRuntimeTempSession> {
    sweep_agent_runtime_temp(parent);
    for _ in 0..PREPARE_ATTEMPTS {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let dir = parent.join(format!("{SESSION_DIR_PREFIX}{}", &token[..12]));
        match fs::create_dir(&dir) {
            Ok(()) => {
                if let Err(error) = fs::write(dir.join(SESSION_OWNER_FILE), b"pending") {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(error);
                }
                return Ok(AgentRuntimeTempSession { dir });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique ACP temporary directory",
    ))
}

fn release_runtime_temp_session(dir: &Path) {
    let _ = fs::write(dir.join(SESSION_OWNER_FILE), b"dead");
    if let Err(error) = remove_tree_retrying(dir) {
        tracing::warn!(
            path = %dir.display(),
            %error,
            "ACP temporary directory remained after the launch ended"
        );
    }
}

fn sweep_runtime_temp_root(root: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0u32;
    for entry in entries.flatten() {
        if !is_real_directory(&entry) {
            continue;
        }
        removed += sweep_agent_runtime_temp(&entry.path());
    }
    removed
}

fn sweep_agent_runtime_temp(dir: &Path) -> u32 {
    sweep_agent_runtime_temp_at(dir, SystemTime::now(), SESSION_PENDING_GRACE)
}

fn sweep_agent_runtime_temp_at(dir: &Path, now: SystemTime, grace: Duration) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0u32;
    for entry in entries.flatten() {
        if !is_real_directory(&entry) {
            continue;
        }
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        if reclaim_stale_child(&entry.path(), &name, now, grace) {
            removed += 1;
        }
    }
    removed
}

fn is_real_directory(entry: &fs::DirEntry) -> bool {
    match entry.file_type() {
        Ok(file_type) => file_type.is_dir() && !file_type.is_symlink(),
        Err(_) => false,
    }
}

fn reclaim_stale_child(path: &Path, name: &str, now: SystemTime, grace: Duration) -> bool {
    if is_pyinstaller_extract(name) {
        if directory_has_locked_file(path) {
            return false;
        }
        return remove_tree_retrying(path).is_ok();
    }
    if !name.starts_with(SESSION_DIR_PREFIX) || name.len() == SESSION_DIR_PREFIX.len() {
        return false;
    }
    match owner_state(path) {
        OwnerState::Alive => false,
        OwnerState::Pending => {
            let Some(age) = dir_age(path, now) else {
                return false;
            };
            if age < grace || directory_has_locked_file(path) {
                return false;
            }
            remove_tree_retrying(path).is_ok()
        }
        OwnerState::Dead => {
            if directory_has_locked_file(path) {
                return false;
            }
            remove_tree_retrying(path).is_ok()
        }
    }
}

enum OwnerState {
    Pending,
    Alive,
    Dead,
}

fn owner_state(dir: &Path) -> OwnerState {
    let text = fs::read_to_string(dir.join(SESSION_OWNER_FILE)).unwrap_or_default();
    let text = text.trim();
    if text.is_empty() || text == "pending" {
        return OwnerState::Pending;
    }
    match text.parse::<u32>() {
        Ok(pid) if process_is_alive(pid) => OwnerState::Alive,
        _ => OwnerState::Dead,
    }
}

fn dir_age(dir: &Path, now: SystemTime) -> Option<Duration> {
    let modified = fs::metadata(dir).ok()?.modified().ok()?;
    now.duration_since(modified).ok()
}

fn is_pyinstaller_extract(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("_MEI") else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

fn remove_tree_retrying(dir: &Path) -> io::Result<()> {
    let mut last_error = None;
    for attempt in 0..CLEANUP_ATTEMPTS {
        match fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if is_transient_fs_error(&error) && attempt + 1 < CLEANUP_ATTEMPTS => {
                last_error = Some(error);
                std::thread::sleep(CLEANUP_RETRY_SLEEP);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not remove an ACP temporary directory",
        )
    }))
}

fn directory_has_locked_file(dir: &Path) -> bool {
    #[cfg(windows)]
    {
        directory_has_locked_file_windows(dir)
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        false
    }
}

#[cfg(windows)]
fn directory_has_locked_file_windows(root: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => return true,
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return true;
            };
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                return true;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            match fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
                Ok(file) => drop(file),
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => return true,
            }
        }
    }
    false
}

fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        process_is_alive_windows(pid)
    }
    #[cfg(unix)]
    {
        process_is_alive_unix(pid)
    }
    #[cfg(not(any(windows, unix)))]
    {
        false
    }
}

#[cfg(windows)]
fn process_is_alive_windows(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(unix)]
fn process_is_alive_unix(pid: u32) -> bool {
    // `kill(-1, 0)` signals every process the caller may signal. A pid that
    // does not fit in a positive pid_t must not reach libc.
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
            tmp.0.join("Dimo").join("acp-tmp").join("antigravity")
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

    #[test]
    fn production_prepare_creates_a_writable_directory() {
        let dir = prepare_agent_runtime_temp(&agent("grok")).expect("host ACP temp");
        let marker = dir.join(format!("_MEIprobe-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&marker).expect("PyInstaller mkdir in bound TEMP");
        fs::remove_dir(&marker).unwrap();
        assert!(
            !dir.starts_with(std::env::temp_dir()),
            "ACP temp {} must not live under process TEMP",
            dir.display()
        );
    }

    #[cfg(windows)]
    #[test]
    fn prepare_succeeds_while_legacy_write_probe_is_exclusively_locked() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = Scratch::new();
        let agent_id = agent("grok");
        let dir = prepare_agent_runtime_temp_in(&tmp.0, &agent_id).unwrap();
        let legacy = dir.join(".write-probe");
        fs::write(&legacy, b"held").unwrap();
        let _lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&legacy)
            .expect("exclusive lock on the legacy probe name");

        prepare_agent_runtime_temp_in(&tmp.0, &agent_id)
            .expect("spawn must not reuse a locked .write-probe name");
    }

    #[test]
    fn prepare_from_bases_skips_an_unwritable_preferred_base() {
        let tmp = Scratch::new();
        let blocked = tmp.0.join("blocked");
        fs::write(&blocked, b"file").unwrap();
        let fallback = tmp.0.join("fallback");
        fs::create_dir_all(&fallback).unwrap();

        let dir = prepare_agent_runtime_temp_from_bases(
            [blocked.clone(), fallback.clone()],
            &agent("grok"),
        )
        .expect("must fall back to a writable ACP temp base");

        assert!(dir.starts_with(fallback.join("Dimo").join("acp-tmp")));
        assert!(!dir.starts_with(&blocked));
        fs::create_dir(dir.join("_MEIprobe")).unwrap();
    }

    #[test]
    fn process_liveness_matches_this_process() {
        assert!(!process_is_alive(0));
        assert!(process_is_alive(std::process::id()));
        assert!(!process_is_alive(u32::MAX));
    }

    #[test]
    fn new_session_sweeps_unlocked_extracts_then_removes_its_dir_on_drop() {
        let tmp = Scratch::new();
        let parent = prepare_agent_runtime_temp_in(&tmp.0, &agent("antigravity")).unwrap();
        let stale = parent.join("_MEI12345");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("payload.bin"), b"stale").unwrap();
        let unrelated = parent.join("_MEIprobe");
        fs::create_dir(&unrelated).unwrap();
        let probe = parent.join(".write-probe-keep");
        fs::write(&probe, b"ok").unwrap();

        let session = create_runtime_temp_session(&parent).unwrap();
        assert!(!stale.exists());
        assert!(unrelated.is_dir());
        assert!(probe.is_file());

        let mut env = HashMap::new();
        session.bind_env(&mut env);
        let path = session.path().to_path_buf();
        assert!(path.starts_with(&parent));
        assert_ne!(path, parent);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(SESSION_DIR_PREFIX));
        assert_eq!(name.len(), SESSION_DIR_PREFIX.len() + 12);
        let bound = path.to_string_lossy();
        assert_eq!(env.get("TEMP").map(String::as_str), Some(bound.as_ref()));
        assert_eq!(env.get("TMP").map(String::as_str), Some(bound.as_ref()));
        assert_eq!(env.get("TMPDIR").map(String::as_str), Some(bound.as_ref()));
        fs::create_dir(path.join("_MEI77")).unwrap();
        drop(session);
        assert!(!path.exists());
        assert!(parent.is_dir());
        assert!(unrelated.is_dir());
    }

    #[test]
    fn sweep_keeps_live_owners_and_young_pending_dirs() {
        let tmp = Scratch::new();
        let parent = prepare_agent_runtime_temp_in(&tmp.0, &agent("antigravity")).unwrap();
        let live = parent.join("run-liveowner01");
        fs::create_dir(&live).unwrap();
        fs::write(
            live.join(SESSION_OWNER_FILE),
            std::process::id().to_string(),
        )
        .unwrap();
        let pending = parent.join("run-pending0001");
        fs::create_dir(&pending).unwrap();
        fs::write(pending.join(SESSION_OWNER_FILE), b"pending").unwrap();

        let removed =
            sweep_agent_runtime_temp_at(&parent, SystemTime::now(), SESSION_PENDING_GRACE);
        assert_eq!(removed, 0);
        assert!(live.is_dir());
        assert!(pending.is_dir());

        let soon = SystemTime::now() + Duration::from_secs(10);
        assert_eq!(
            sweep_agent_runtime_temp_at(&parent, soon, SESSION_PENDING_GRACE),
            0
        );
        assert!(pending.is_dir());
        assert_eq!(
            sweep_agent_runtime_temp_at(&parent, SystemTime::UNIX_EPOCH, SESSION_PENDING_GRACE),
            0
        );
        assert!(pending.is_dir());
    }

    #[test]
    fn sweep_removes_old_pending_and_dead_owners() {
        let tmp = Scratch::new();
        let parent = prepare_agent_runtime_temp_in(&tmp.0, &agent("antigravity")).unwrap();
        let pending = parent.join("run-oldpending1");
        fs::create_dir(&pending).unwrap();
        fs::write(pending.join(SESSION_OWNER_FILE), b"pending").unwrap();
        let dead = parent.join("run-deadowner01");
        fs::create_dir(&dead).unwrap();
        fs::write(dead.join(SESSION_OWNER_FILE), u32::MAX.to_string()).unwrap();
        let garbage = parent.join("run-notapid0001");
        fs::create_dir(&garbage).unwrap();
        fs::write(garbage.join(SESSION_OWNER_FILE), b"not-a-pid").unwrap();
        let live = parent.join("run-stillalive1");
        fs::create_dir(&live).unwrap();
        fs::write(
            live.join(SESSION_OWNER_FILE),
            std::process::id().to_string(),
        )
        .unwrap();

        let later = SystemTime::now() + Duration::from_secs(600);
        let removed = sweep_agent_runtime_temp_at(&parent, later, SESSION_PENDING_GRACE);
        assert_eq!(removed, 3);
        assert!(!pending.exists());
        assert!(!dead.exists());
        assert!(!garbage.exists());
        assert!(live.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn sweep_keeps_a_locked_extract_until_the_lock_is_released() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = Scratch::new();
        let parent = prepare_agent_runtime_temp_in(&tmp.0, &agent("antigravity")).unwrap();
        let mei = parent.join("_MEI999");
        fs::create_dir(&mei).unwrap();
        let file = mei.join("locked.bin");
        fs::write(&file, b"held").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&file)
            .expect("exclusive lock");

        assert_eq!(sweep_agent_runtime_temp(&parent), 0);
        assert!(mei.is_dir());
        drop(lock);
        assert_eq!(sweep_agent_runtime_temp(&parent), 1);
        assert!(!mei.exists());
    }
}
