use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BootstrapConfig {
    #[serde(default)]
    pub custom_data_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataDirSettings {
    pub current_data_dir: PathBuf,
    pub default_data_dir: PathBuf,
    pub is_custom: bool,
}

/// Lightweight bootstrap configuration file path (`bootstrap.json`).
///
/// Stored in the OS config directory (`%APPDATA%\dimo\dimo\config\bootstrap.json` on Windows)
/// so the Host can locate a user-configured custom data directory before opening `db.sqlite`.
pub fn bootstrap_config_path() -> PathBuf {
    if let Some(explicit) =
        std::env::var_os("DIMO_BOOTSTRAP_CONFIG_PATH").filter(|value| !value.is_empty())
    {
        return PathBuf::from(explicit);
    }
    ProjectDirs::from("app", "dimo", "dimo")
        .map(|dirs| dirs.config_dir().join("bootstrap.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".dimo").join("bootstrap.json")))
        .unwrap_or_else(|| PathBuf::from(".dimo-bootstrap.json"))
}

pub fn load_bootstrap_config_from(path: &Path) -> BootstrapConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BootstrapConfig>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_bootstrap_config_to(path: &Path, config: &BootstrapConfig) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?;
    std::fs::write(path, encoded)
}

pub fn read_custom_data_dir_from(bootstrap_path: &Path) -> Option<PathBuf> {
    let config = load_bootstrap_config_from(bootstrap_path);
    let raw = config.custom_data_dir?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return None;
    }
    Some(crate::path::normalize_windows_extended_path_prefix(path))
}

pub fn read_custom_data_dir() -> Option<PathBuf> {
    let current = bootstrap_config_path();
    if let Some(dir) = read_custom_data_dir_from(&current) {
        return Some(dir);
    }
    let previous = pre_rename_bootstrap_config_path();
    (previous != current)
        .then(|| read_custom_data_dir_from(&previous))
        .flatten()
}

/// Stable data directory for release builds. It lives outside the install
/// tree, so replacing the app bundle cannot delete sessions.
///
/// Windows: `%APPDATA%\dimo\dimo\data`. macOS:
/// `~/Library/Application Support/app.dimo.dimo`. Linux: `$XDG_DATA_HOME/dimo`
/// or `~/.local/share/dimo`.
pub fn legacy_roaming_data_dir() -> PathBuf {
    ProjectDirs::from("app", "dimo", "dimo")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("dimo")))
        .unwrap_or_else(|| PathBuf::from(".dimo-data"))
}

/// Where the previous brand (`VibeX`) kept its data on this machine.
///
/// Users upgrading from VibeX keep their conversations, worktrees and settings
/// only if this directory is adopted, so it is resolved for read purposes and
/// never written through [`asset_dir`](crate::assets::asset_dir).
pub fn pre_rename_data_dir() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("vibex")))
        .unwrap_or_else(|| PathBuf::from(".vibex-data"))
}

/// Where the previous brand (`VibeX`) kept `bootstrap.json`.
pub fn pre_rename_bootstrap_config_path() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.config_dir().join("bootstrap.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".vibex").join("bootstrap.json")))
        .unwrap_or_else(|| PathBuf::from(".vibex-bootstrap.json"))
}

fn is_cargo_build_or_test_dir(dir: &Path) -> bool {
    let components: Vec<String> = dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    if components.last().is_some_and(|last| last == "deps") {
        return true;
    }
    for window in components.windows(2) {
        if window[0] == "target" && (window[1] == "debug" || window[1] == "release") {
            return true;
        }
    }
    false
}

pub fn probe_writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(".dimo-write-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn install_data_dir_for_exe_dir(install_dir: &Path) -> Option<PathBuf> {
    if !install_dir.exists() || is_cargo_build_or_test_dir(install_dir) {
        return None;
    }
    let candidate = install_dir.join("data");
    probe_writable_dir(&candidate)
        .then(|| crate::path::normalize_windows_extended_path_prefix(candidate))
}

/// `<install_dir>/data` when writable; `None` for read-only installs
/// (e.g. `C:\Program Files`) and Cargo build trees.
///
/// This is not the live data directory. Probing creates `<install_dir>/data`,
/// and a later app update deletes that directory on macOS. [`release_default_data_dir`]
/// must not call this.
pub fn install_data_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|install_dir| install_data_dir_for_exe_dir(&install_dir))
}

/// Install directory of a packaged app, excluding Cargo `target/{debug,release}`
/// and `deps` test binaries.
pub fn packaged_install_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let install_dir = exe.parent()?.to_path_buf();
    if is_cargo_build_or_test_dir(&install_dir) {
        return None;
    }
    Some(install_dir)
}

/// Live release data directory. `install_data` is ignored on purpose: 0.5.0
/// stored the only database under the install tree, and replacing `Dimo.app`
/// deleted it. The stable roaming/XDG directory is the only default.
pub fn resolve_release_data_dir(_install_data: Option<&Path>, stable: PathBuf) -> PathBuf {
    stable
}

/// Release default: [`legacy_roaming_data_dir`]. Does not create
/// `<install_dir>/data`.
pub fn release_default_data_dir() -> PathBuf {
    resolve_release_data_dir(None, legacy_roaming_data_dir())
}

/// `.app` bundle that contains `exe`, when `exe` is `*.app/Contents/MacOS/*`.
pub fn macos_app_bundle_containing(exe: &Path) -> Option<PathBuf> {
    let mut cursor = exe.parent()?;
    loop {
        if cursor.extension().is_some_and(|ext| ext == "app") {
            return Some(cursor.to_path_buf());
        }
        cursor = cursor.parent()?;
    }
}

/// Whether replacing the running app would delete `dir`.
///
/// Only a macOS in-app update replaces the whole `.app`. Windows NSIS and
/// Linux AppImage updates keep a sibling data directory. Cargo test binaries
/// are never treated as a bundle, even when `update_replaces_bundle` is set.
pub fn app_update_deletes_directory(
    update_replaces_bundle: bool,
    current_exe: &Path,
    dir: &Path,
) -> bool {
    if !update_replaces_bundle {
        return false;
    }
    let Some(exe_dir) = current_exe.parent() else {
        return false;
    };
    if is_cargo_build_or_test_dir(exe_dir) {
        return false;
    }
    macos_app_bundle_containing(current_exe).is_some_and(|bundle| dir.starts_with(bundle))
}

fn debug_dev_assets_dir() -> PathBuf {
    Path::new(PROJECT_ROOT)
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(PROJECT_ROOT))
        .join("dev_assets")
}

/// A legacy data directory whose database must be moved into the release
/// default before anything opens a database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyDataDirAdoption {
    pub legacy_dir: PathBuf,
    pub target_dir: PathBuf,
}

const ADOPTED_LEGACY_MARKER_FILE: &str = ".adopted-legacy-source";

pub fn same_data_dir(a: &Path, b: &Path) -> bool {
    same_path_for_adoption(a, b)
}

fn same_path_for_adoption(a: &Path, b: &Path) -> bool {
    let norm_a = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf()),
    );
    let norm_b = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf()),
    );
    if cfg!(windows) {
        norm_a
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .eq_ignore_ascii_case(norm_b.to_string_lossy().trim_end_matches(['\\', '/']))
    } else {
        norm_a == norm_b
    }
}

fn push_unique_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    let normalized = crate::path::normalize_windows_extended_path_prefix(candidate);
    if !candidates
        .iter()
        .any(|existing| same_path_for_adoption(existing, &normalized))
    {
        candidates.push(normalized);
    }
}

#[cfg(target_os = "windows")]
fn windows_vibex_registry_install_dirs() -> Vec<PathBuf> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
    };

    let mut dirs = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        if let Ok(uninst) = root.open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeX",
            KEY_READ,
        ) && let Ok(raw) = uninst.get_value::<String, _>("InstallLocation")
        {
            let trimmed = raw.trim().trim_matches('"').trim();
            if !trimmed.is_empty() {
                dirs.push(PathBuf::from(trimmed));
            }
        }
        for subkey in [
            r"Software\vibex\VibeX",
            r"Software\VibeX\VibeX",
            r"Software\Dimo\VibeX",
            r"Software\DimoADE\VibeX",
        ] {
            if let Ok(key) = root.open_subkey_with_flags(subkey, KEY_READ)
                && let Ok(raw) = key.get_value::<String, _>("")
            {
                let trimmed = raw.trim().trim_matches('"').trim();
                if !trimmed.is_empty() {
                    dirs.push(PathBuf::from(trimmed));
                }
            }
        }
    }
    dirs
}

/// Discovers `<VibeX_install_dir>/data` (and legacy bundle dirs) where the
/// pre-rename `VibeX` desktop app stored its database and settings before
/// `Dimo` was installed into its own directory.
pub fn pre_rename_install_data_dir_candidates_for(
    current_exe: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    home_dir: Option<&Path>,
    app_data_dir: Option<&Path>,
    registry_install_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for install_root in registry_install_dirs {
        push_unique_candidate(&mut candidates, install_root.join("data"));
    }

    if let Some(exe_dir) = current_exe.and_then(|exe| exe.parent())
        && !is_cargo_build_or_test_dir(exe_dir)
    {
        if cfg!(target_os = "macos") {
            // `Dimo.app/Contents/MacOS` -> sibling `VibeX.app/Contents/MacOS/data`
            if let Some(apps_dir) = exe_dir
                .parent()
                .and_then(|contents| contents.parent())
                .and_then(|bundle| bundle.parent())
            {
                push_unique_candidate(
                    &mut candidates,
                    apps_dir
                        .join("VibeX.app")
                        .join("Contents")
                        .join("MacOS")
                        .join("data"),
                );
            }
        } else if let Some(parent) = exe_dir.parent() {
            push_unique_candidate(&mut candidates, parent.join("VibeX").join("data"));
            if cfg!(target_os = "linux") {
                push_unique_candidate(&mut candidates, parent.join("vibex").join("data"));
            }
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(local) = local_app_data {
            push_unique_candidate(&mut candidates, local.join("VibeX").join("data"));
            push_unique_candidate(
                &mut candidates,
                local.join("Programs").join("VibeX").join("data"),
            );
        }
        if let Some(pf) = program_files {
            push_unique_candidate(&mut candidates, pf.join("VibeX").join("data"));
        }
        if let Some(pf86) = program_files_x86 {
            push_unique_candidate(&mut candidates, pf86.join("VibeX").join("data"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = home_dir {
            push_unique_candidate(
                &mut candidates,
                home.join("Applications")
                    .join("VibeX.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("data"),
            );
        }
        push_unique_candidate(
            &mut candidates,
            PathBuf::from("/Applications/VibeX.app/Contents/MacOS/data"),
        );
    }

    if let Some(data_dir) = app_data_dir {
        push_unique_candidate(&mut candidates, data_dir.join("com.vibex.app"));
        push_unique_candidate(&mut candidates, data_dir.join("VibeX"));
    }

    candidates
}

/// `<Dimo install>/data` directories that may still hold the database written
/// by 0.5.0 and 0.5.1. Paths are joined only; nothing is created.
///
/// The running executable's sibling `data` is first so an activity-score tie
/// prefers the copy that app was using.
pub fn dimo_install_data_dir_candidates_for(
    current_exe: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    home_dir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(exe_dir) = current_exe.and_then(|exe| exe.parent())
        && !is_cargo_build_or_test_dir(exe_dir)
    {
        push_unique_candidate(&mut candidates, exe_dir.join("data"));
    }

    if cfg!(target_os = "windows") {
        if let Some(local) = local_app_data {
            push_unique_candidate(&mut candidates, local.join("Dimo").join("data"));
            push_unique_candidate(
                &mut candidates,
                local.join("Programs").join("Dimo").join("data"),
            );
        }
        if let Some(pf) = program_files {
            push_unique_candidate(&mut candidates, pf.join("Dimo").join("data"));
        }
        if let Some(pf86) = program_files_x86 {
            push_unique_candidate(&mut candidates, pf86.join("Dimo").join("data"));
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = home_dir {
            push_unique_candidate(
                &mut candidates,
                home.join("Applications")
                    .join("Dimo.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("data"),
            );
        }
        push_unique_candidate(
            &mut candidates,
            PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data"),
        );
    } else if cfg!(target_os = "linux") {
        if let Some(exe_dir) = current_exe.and_then(|exe| exe.parent())
            && !is_cargo_build_or_test_dir(exe_dir)
            && let Some(parent) = exe_dir.parent()
        {
            push_unique_candidate(&mut candidates, parent.join("Dimo").join("data"));
        }
        push_unique_candidate(&mut candidates, PathBuf::from("/opt/Dimo/data"));
    }

    candidates
}

pub fn dimo_install_data_dir_candidates() -> Vec<PathBuf> {
    let current_exe = std::env::current_exe().ok();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir);
    let program_files = std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let home_dir = dirs::home_dir();
    dimo_install_data_dir_candidates_for(
        current_exe.as_deref(),
        local_app_data.as_deref(),
        program_files.as_deref(),
        program_files_x86.as_deref(),
        home_dir.as_deref(),
    )
}

/// Set-aside copies named `{dir}.superseded-*` that still contain `db.sqlite`.
/// Missing directories are ignored. Nothing is created.
pub fn superseded_data_dirs_beside(dir: &Path) -> Vec<PathBuf> {
    let Some(parent) = dir.parent() else {
        return Vec::new();
    };
    if parent.as_os_str().is_empty() {
        return Vec::new();
    }
    let Some(file_name) = dir.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if file_name.is_empty() {
        return Vec::new();
    }
    let prefix = format!("{file_name}.superseded-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) && path.join("db.sqlite").is_file() {
            found.push(crate::path::normalize_windows_extended_path_prefix(path));
        }
    }
    found.sort();
    found
}

fn append_superseded_siblings(candidates: &mut Vec<PathBuf>) {
    let mut seeds = candidates.clone();
    seeds.push(release_default_data_dir());
    for seed in seeds {
        for sibling in superseded_data_dirs_beside(&seed) {
            push_unique_candidate(candidates, sibling);
        }
    }
}

pub fn pre_rename_install_data_dir_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let registry_dirs = windows_vibex_registry_install_dirs();
    #[cfg(not(target_os = "windows"))]
    let registry_dirs: Vec<PathBuf> = Vec::new();

    let current_exe = std::env::current_exe().ok();
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir);
    let program_files = std::env::var_os("ProgramFiles")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let home_dir = dirs::home_dir();
    let app_data_dir = dirs::data_dir();

    pre_rename_install_data_dir_candidates_for(
        current_exe.as_deref(),
        local_app_data.as_deref(),
        program_files.as_deref(),
        program_files_x86.as_deref(),
        home_dir.as_deref(),
        app_data_dir.as_deref(),
        &registry_dirs,
    )
}

/// Ordered directories that may still hold a database that belongs in the
/// stable roaming/XDG directory. The stable directory itself is the target,
/// not a source. Nothing here is created.
pub fn legacy_data_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = dimo_install_data_dir_candidates();
    for dir in pre_rename_install_data_dir_candidates() {
        push_unique_candidate(&mut candidates, dir);
    }
    push_unique_candidate(&mut candidates, pre_rename_data_dir());
    append_superseded_siblings(&mut candidates);
    let stable = release_default_data_dir();
    candidates.retain(|dir| !same_path_for_adoption(dir, &stable));
    candidates
}

pub fn read_adopted_legacy_sources(target_dir: &Path) -> Vec<PathBuf> {
    let marker = target_dir.join(ADOPTED_LEGACY_MARKER_FILE);
    let Ok(raw) = std::fs::read_to_string(marker) else {
        return Vec::new();
    };
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub fn record_adopted_legacy_source(target_dir: &Path, legacy_dir: &Path) -> std::io::Result<()> {
    let normalized = crate::path::normalize_windows_extended_path_prefix(
        std::fs::canonicalize(legacy_dir).unwrap_or_else(|_| legacy_dir.to_path_buf()),
    );
    let mut recorded = read_adopted_legacy_sources(target_dir);
    if recorded
        .iter()
        .any(|existing| same_path_for_adoption(existing, &normalized))
    {
        return Ok(());
    }
    recorded.push(normalized);
    std::fs::create_dir_all(target_dir)?;
    let content = recorded
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(target_dir.join(ADOPTED_LEGACY_MARKER_FILE), content)
}

fn is_already_adopted_legacy_source(target_dir: &Path, legacy_dir: &Path) -> bool {
    read_adopted_legacy_sources(target_dir)
        .into_iter()
        .any(|recorded| same_path_for_adoption(&recorded, legacy_dir))
}

/// Returns all legacy data directories holding a `db.sqlite` that are eligible
/// for adoption into the release default data directory.
pub fn pending_legacy_data_dir_adoptions() -> Vec<LegacyDataDirAdoption> {
    if cfg!(debug_assertions)
        || renamed_env_var("DIMO_DATA_DIR").is_some()
        || read_custom_data_dir().is_some()
    {
        return Vec::new();
    }
    let target_dir = release_default_data_dir();
    legacy_data_dir_candidates()
        .into_iter()
        .filter_map(|dir| legacy_data_dir_adoption(dir, target_dir.clone()))
        .collect()
}

/// First pending adoption in candidate order, before activity scoring.
/// Startup ranks every entry from [`pending_legacy_data_dir_adoptions`].
pub fn pending_legacy_data_dir_adoption() -> Option<LegacyDataDirAdoption> {
    pending_legacy_data_dir_adoptions().into_iter().next()
}

pub fn legacy_data_dir_adoption(
    legacy_dir: PathBuf,
    target_dir: PathBuf,
) -> Option<LegacyDataDirAdoption> {
    (!same_path_for_adoption(&legacy_dir, &target_dir)
        && !is_already_adopted_legacy_source(&target_dir, &legacy_dir)
        && legacy_dir.join("db.sqlite").is_file())
    .then_some(LegacyDataDirAdoption {
        legacy_dir,
        target_dir,
    })
}

pub fn default_data_dir_without_custom() -> PathBuf {
    if cfg!(debug_assertions) {
        debug_dev_assets_dir()
    } else {
        release_default_data_dir()
    }
}

/// Default Host data directory shared by Desktop release builds and `dimo-server`.
///
/// Desktop debug builds still use the repo `dev_assets/` tree via [`asset_dir`] unless
/// overridden by `bootstrap.json`.
pub fn default_host_data_dir() -> PathBuf {
    read_custom_data_dir()
        .filter(|custom| std::fs::create_dir_all(custom).is_ok())
        .unwrap_or_else(release_default_data_dir)
}

static DATA_DIR_FOR_THIS_RUN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Opens `dir` for the rest of this process. Used when a legacy data directory
/// could not be moved yet (for example, an older Dimo still holds it open):
/// the user's existing data is opened in place and the move is retried on the
/// next launch. Must run before anything resolves the data directory.
pub fn use_data_dir_for_this_run(dir: PathBuf) {
    let _ = DATA_DIR_FOR_THIS_RUN.set(dir);
}

pub fn asset_dir() -> PathBuf {
    if let Some(dir) = DATA_DIR_FOR_THIS_RUN.get() {
        return dir.clone();
    }
    let path = if cfg!(debug_assertions) {
        if let Some(custom) = read_custom_data_dir()
            && std::fs::create_dir_all(&custom).is_ok()
        {
            custom
        } else {
            debug_dev_assets_dir()
        }
    } else {
        default_host_data_dir()
    };

    // Ensure the directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create asset directory");
    }

    path
}

/// Canonical Host data directory for Desktop and `dimo-server`.
///
/// Reads a `DIMO_*` environment variable, falling back to the equivalent
/// `VIBEX_*` name so environments configured before the rename keep working.
pub fn renamed_env_var(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            let legacy = name
                .strip_prefix("DIMO_")
                .map(|rest| format!("VIBEX_{rest}"))?;
            std::env::var_os(legacy).filter(|value| !value.is_empty())
        })
}

/// `DIMO_DATA_DIR` wins. Otherwise this is [`asset_dir`] so debug Desktop
/// keeps using `dev_assets/` (unless customized) and release builds use the
/// stable roaming/XDG directory ([`legacy_roaming_data_dir`]) or the user's
/// custom data directory.
pub fn host_data_dir() -> PathBuf {
    if let Some(explicit) = renamed_env_var("DIMO_DATA_DIR") {
        let path = PathBuf::from(explicit);
        let _ = std::fs::create_dir_all(&path);
        return path;
    }
    asset_dir()
}

pub fn get_data_dir_settings() -> DataDirSettings {
    let current_data_dir = crate::path::normalize_windows_extended_path_prefix(host_data_dir());
    let default_data_dir =
        crate::path::normalize_windows_extended_path_prefix(default_data_dir_without_custom());
    let is_custom = read_custom_data_dir().is_some() || current_data_dir != default_data_dir;
    DataDirSettings {
        current_data_dir,
        default_data_dir,
        is_custom,
    }
}

pub fn set_custom_data_dir(new_dir: Option<&Path>) -> std::io::Result<DataDirSettings> {
    let normalized = new_dir.map(|dir| {
        crate::path::normalize_windows_extended_path_prefix(dir)
            .to_string_lossy()
            .into_owned()
    });
    let config = BootstrapConfig {
        custom_data_dir: normalized,
    };
    save_bootstrap_config_to(&bootstrap_config_path(), &config)?;
    Ok(get_data_dir_settings())
}

pub fn config_path() -> PathBuf {
    host_data_dir().join("config.json")
}

/// Copy `settings.json` (or legacy `config.json`) from known VibeX / home
/// locations into `target_dir` if `target_dir/settings.json` does not exist yet.
pub fn adopt_legacy_settings_into(target_dir: &Path) {
    let dest = target_dir.join("settings.json");
    if dest.exists() {
        return;
    }
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join("settings.json")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join("settings.json")),
        &dest,
    );
    for legacy_dir in pre_rename_install_data_dir_candidates()
        .into_iter()
        .chain(std::iter::once(pre_rename_data_dir()))
    {
        if same_path_for_adoption(&legacy_dir, target_dir) {
            continue;
        }
        adopt_legacy_file(Some(legacy_dir.join("settings.json")), &dest);
        if dest.exists() {
            return;
        }
    }
}

/// Settings live next to the Host database. `~/.dimo/settings.json` (or
/// pre-rename `~/.vibex/settings.json` and VibeX data directories in release
/// builds) is copied once if the Host file does not exist yet.
pub fn settings_path() -> PathBuf {
    let data_dir = host_data_dir();
    let dest = data_dir.join("settings.json");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join("settings.json")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join("settings.json")),
        &dest,
    );
    if !cfg!(debug_assertions) {
        adopt_legacy_settings_into(&data_dir);
    }
    dest
}

pub fn im_env_path() -> PathBuf {
    let data_dir = host_data_dir();
    let dest = data_dir.join(".env");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".dimo").join(".env")),
        &dest,
    );
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join(".env")),
        &dest,
    );
    if !cfg!(debug_assertions) {
        for legacy_dir in pre_rename_install_data_dir_candidates()
            .into_iter()
            .chain(std::iter::once(pre_rename_data_dir()))
        {
            if !same_path_for_adoption(&legacy_dir, &data_dir) {
                adopt_legacy_file(Some(legacy_dir.join(".env")), &dest);
            }
        }
    }
    dest
}

fn adopt_legacy_file(legacy: Option<PathBuf>, dest: &Path) {
    let Some(legacy) = legacy else {
        return;
    };
    if dest.exists() || !legacy.exists() {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(legacy, dest);
}

/// Directories Tauri used for `app.path().app_data_dir()`. Host product files
/// now live in [`host_data_dir`].
///
/// The `com.vibex.app` / `VibeX` / `vibex` entries are the pre-rename
/// identifiers: files written before the Dimo rename are still picked up from
/// there when the new location does not have them yet.
pub fn tauri_app_data_dir_candidates() -> Vec<PathBuf> {
    let Some(data) = dirs::data_dir() else {
        return Vec::new();
    };
    let mut dirs = vec![
        data.join("com.dimo.app"),
        data.join("Dimo"),
        data.join("dimo"),
        data.join("com.vibex.app"),
        data.join("VibeX"),
        data.join("vibex"),
    ];
    dirs.dedup();
    dirs
}

pub fn tauri_app_data_file_candidates(relative: impl AsRef<Path>) -> Vec<PathBuf> {
    let relative = relative.as_ref();
    tauri_app_data_dir_candidates()
        .into_iter()
        .map(|root| root.join(relative))
        .collect()
}

/// Copy `relative` from the first existing Tauri app-data location when `dest`
/// is missing. Existing Host files win.
pub fn adopt_tauri_app_data_file(relative: impl AsRef<Path>, dest: &Path) {
    if dest.exists() {
        return;
    }
    for legacy in tauri_app_data_file_candidates(relative) {
        adopt_legacy_file(Some(legacy), dest);
        if dest.exists() {
            return;
        }
    }
}

/// Copy files that exist in `from` but not yet under `dest`.
pub fn copy_missing_files(from: &Path, dest: &Path) {
    let _ = std::fs::create_dir_all(dest);
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let target = dest.join(name);
        if !target.exists() {
            let _ = std::fs::copy(&path, &target);
        }
    }
}

/// Copy files that exist in a legacy Tauri directory but not yet under Host.
pub fn adopt_tauri_app_data_dir_files(relative: impl AsRef<Path>, dest: &Path) {
    for legacy_dir in tauri_app_data_file_candidates(relative) {
        copy_missing_files(&legacy_dir, dest);
    }
}

/// Directory for rotating application log files (P2-8). Created on first use.
pub fn logs_dir() -> PathBuf {
    let path = host_data_dir().join("logs");
    if !path.exists() {
        let _ = std::fs::create_dir_all(&path);
    }
    path
}

pub fn profiles_path() -> PathBuf {
    host_data_dir().join("profiles.json")
}

pub fn host_identity_path(data_root: &Path) -> PathBuf {
    data_root.join("host-identity.json")
}

/// Stable Host identity for the given data directory.
///
/// Desktop and `dimo-server` must persist this next to the database so pairing
/// and capabilities keep the same identity across restarts and Host family
/// processes.
pub fn load_or_create_host_id(data_root: &Path) -> std::io::Result<String> {
    let path = host_identity_path(data_root);
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(host_id) = value
            .get("host_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return Ok(host_id.to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let host_id = uuid::Uuid::new_v4().to_string();
    let encoded = serde_json::to_vec_pretty(&serde_json::json!({ "host_id": host_id }))
        .map_err(std::io::Error::other)?;
    let staging = path.with_extension("json.tmp");
    std::fs::write(&staging, encoded)?;
    restrict_owner_read_write(&staging);
    match std::fs::rename(&staging, &path) {
        Ok(()) => {}
        Err(_) if path.exists() => {
            let _ = std::fs::remove_file(&staging);
            if let Ok(text) = std::fs::read_to_string(&path)
                && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                && let Some(existing) = value
                    .get("host_id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            {
                return Ok(existing.to_string());
            }
        }
        Err(error) => {
            let _ = std::fs::remove_file(&staging);
            return Err(error);
        }
    }
    restrict_owner_read_write(&path);
    Ok(host_id)
}

fn restrict_owner_read_write(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[derive(RustEmbed)]
#[folder = "../../assets/sounds"]
pub struct SoundAssets;

#[derive(RustEmbed)]
#[folder = "../../assets/scripts"]
pub struct ScriptAssets;

/// Official plugin packages are no longer rust-embedded into the Host.
/// Older Hosts may still have copies under `builtin-plugins/`; keep those
/// visible so marketplace updates can replace them.
pub fn existing_official_plugin_roots(data_root: &Path) -> Vec<PathBuf> {
    existing_materialized_plugin_roots(data_root)
        .into_values()
        .collect()
}

fn existing_materialized_plugin_roots(data_root: &Path) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    let root = data_root.join("builtin-plugins");
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let Some(plugin_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        let Ok(versions) = std::fs::read_dir(&plugin_dir) else {
            continue;
        };
        for version in versions.flatten() {
            let path = version.path();
            if version.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if !path.join(".dimo-plugin/plugin.json").is_file() {
                continue;
            }
            let modified = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if best
                .as_ref()
                .is_none_or(|(current, _)| modified >= *current)
            {
                best = Some((modified, path));
            }
        }
        if let Some((_, path)) = best {
            found.insert(plugin_id, path);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        adopt_legacy_file, copy_missing_files, existing_official_plugin_roots,
        load_or_create_host_id, tauri_app_data_file_candidates,
    };

    #[test]
    fn host_does_not_embed_plugin_packages() {
        let src = include_str!("assets.rs");
        assert!(!src.contains("#[folder = \"../../assets/plugins\"]"));
    }

    #[test]
    fn packaged_host_data_dir_is_not_the_debug_tree() {
        let dir = super::default_host_data_dir();
        let text = dir.to_string_lossy();
        assert!(
            !text.contains("dev_assets"),
            "release Host data must use ProjectDirs, got {text}"
        );
        if cfg!(debug_assertions) {
            let debug_dir = super::asset_dir();
            assert!(
                debug_dir.to_string_lossy().contains("dev_assets"),
                "debug Desktop still uses the repo dev_assets tree"
            );
        } else {
            assert_eq!(super::asset_dir(), dir);
        }
    }

    #[test]
    fn keeps_already_materialized_packages_when_scanning_the_host_data_directory() {
        let data = tempfile::tempdir().unwrap();
        let extra = data
            .path()
            .join("builtin-plugins/dev.example.extra/aaaaaaaaaaaa");
        std::fs::create_dir_all(extra.join(".dimo-plugin")).unwrap();
        std::fs::write(
            extra.join(".dimo-plugin/plugin.json"),
            br#"{"id":"dev.example.extra"}"#,
        )
        .unwrap();

        let roots = existing_official_plugin_roots(data.path());
        assert_eq!(roots, vec![extra]);
    }

    #[test]
    fn host_identity_is_stable_for_a_data_directory() {
        let data = tempfile::tempdir().unwrap();
        let first = load_or_create_host_id(data.path()).unwrap();
        let second = load_or_create_host_id(data.path()).unwrap();
        assert!(!first.is_empty());
        assert_eq!(first, second);
        assert!(
            data.path().join("host-identity.json").is_file(),
            "host identity must live in the Host data directory"
        );
    }

    #[test]
    fn adopt_legacy_file_copies_once_and_does_not_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("legacy.json");
        let dest = root.path().join("host/current.json");
        std::fs::write(&legacy, br#"{"from":"legacy"}"#).unwrap();
        adopt_legacy_file(Some(legacy.clone()), &dest);
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            r#"{"from":"legacy"}"#
        );
        std::fs::write(&legacy, br#"{"from":"newer-legacy"}"#).unwrap();
        adopt_legacy_file(Some(legacy), &dest);
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            r#"{"from":"legacy"}"#
        );
    }

    #[test]
    fn copy_missing_files_fills_gaps_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("legacy");
        let dest = root.path().join("host");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(from.join("cached.json"), b"legacy").unwrap();
        std::fs::write(from.join("keep.json"), b"legacy-keep").unwrap();
        std::fs::write(dest.join("keep.json"), b"host-keep").unwrap();
        copy_missing_files(&from, &dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("cached.json")).unwrap(),
            "legacy"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("keep.json")).unwrap(),
            "host-keep"
        );
    }

    #[test]
    fn tauri_app_data_candidates_include_the_bundle_identifier() {
        let files = tauri_app_data_file_candidates("agent-model-providers.json");
        assert!(
            files.iter().any(|path| {
                path.components()
                    .any(|component| component.as_os_str() == "com.dimo.app")
                    && path
                        .file_name()
                        .is_some_and(|name| name == "agent-model-providers.json")
            }),
            "expected com.dimo.app candidate, got {files:?}"
        );
    }

    #[test]
    fn install_data_dir_uses_install_dir_data_and_skips_cargo_target_dirs() {
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("Dimo");
        std::fs::create_dir_all(&install_dir).unwrap();

        let resolved = super::install_data_dir_for_exe_dir(&install_dir)
            .expect("install_dir/data should be writable");
        assert_eq!(resolved, install_dir.join("data"));

        let debug_dir = root.path().join("target").join("debug");
        std::fs::create_dir_all(debug_dir.join("deps")).unwrap();
        assert!(super::install_data_dir_for_exe_dir(&debug_dir).is_none());
        assert!(super::install_data_dir_for_exe_dir(&debug_dir.join("deps")).is_none());
    }

    #[test]
    fn legacy_data_dir_is_adopted_only_when_it_holds_a_database() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("roaming").join("data");
        let target = root.path().join("install").join("data");
        std::fs::create_dir_all(&legacy).unwrap();

        assert_eq!(
            super::legacy_data_dir_adoption(legacy.clone(), target.clone()),
            None
        );

        std::fs::write(legacy.join("db.sqlite"), b"sqlite").unwrap();
        assert_eq!(
            super::legacy_data_dir_adoption(legacy.clone(), target.clone()),
            Some(super::LegacyDataDirAdoption {
                legacy_dir: legacy.clone(),
                target_dir: target,
            })
        );
        assert_eq!(
            super::legacy_data_dir_adoption(legacy.clone(), legacy),
            None,
            "a directory is not adopted into itself"
        );
    }

    #[test]
    fn empty_custom_data_dir_value_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        let bootstrap = root.path().join("config").join("bootstrap.json");
        std::fs::create_dir_all(bootstrap.parent().unwrap()).unwrap();
        std::fs::write(&bootstrap, br#"{"custom_data_dir": ""}"#).unwrap();
        assert_eq!(super::read_custom_data_dir_from(&bootstrap), None);

        let custom = root.path().join("custom");
        super::save_bootstrap_config_to(
            &bootstrap,
            &super::BootstrapConfig {
                custom_data_dir: Some(custom.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        assert_eq!(super::read_custom_data_dir_from(&bootstrap), Some(custom));
    }

    #[test]
    fn pre_rename_install_candidates_include_registry_sibling_and_standard_vibex_dirs() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("Apps").join("Dimo").join("dimo.exe");
        let reg_dir = root.path().join("CustomVibeX");
        let local = root.path().join("LocalAppData");
        let pf = root.path().join("ProgramFiles");
        let pf86 = root.path().join("ProgramFilesX86");
        let home = root.path().join("Home");
        let app_data = root.path().join("Roaming");

        let candidates = super::pre_rename_install_data_dir_candidates_for(
            Some(&exe),
            Some(&local),
            Some(&pf),
            Some(&pf86),
            Some(&home),
            Some(&app_data),
            std::slice::from_ref(&reg_dir),
        );

        assert!(candidates.contains(&reg_dir.join("data")));
        if !cfg!(target_os = "macos") {
            assert!(candidates.contains(&root.path().join("Apps").join("VibeX").join("data")));
        }
        if cfg!(target_os = "windows") {
            assert!(candidates.contains(&local.join("VibeX").join("data")));
            assert!(candidates.contains(&local.join("Programs").join("VibeX").join("data")));
            assert!(candidates.contains(&pf.join("VibeX").join("data")));
        }
        assert!(candidates.contains(&app_data.join("com.vibex.app")));
    }

    #[test]
    fn recorded_adopted_legacy_source_prevents_repeated_adoption() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("vibex").join("data");
        let target = root.path().join("dimo").join("data");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(legacy.join("db.sqlite"), b"sqlite").unwrap();

        assert!(super::legacy_data_dir_adoption(legacy.clone(), target.clone()).is_some());
        super::record_adopted_legacy_source(&target, &legacy).unwrap();
        assert_eq!(super::legacy_data_dir_adoption(legacy, target), None);
    }

    #[test]
    fn release_data_dir_ignores_the_install_directory() {
        let install = PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data");
        let stable = PathBuf::from("/Users/me/Library/Application Support/app.dimo.dimo");
        let resolved = super::resolve_release_data_dir(Some(&install), stable.clone());
        assert_eq!(resolved, stable);
        assert_ne!(resolved, install);
        assert_eq!(
            super::resolve_release_data_dir(None, stable.clone()),
            stable
        );
        assert_eq!(
            super::release_default_data_dir(),
            super::legacy_roaming_data_dir()
        );
    }

    #[test]
    fn release_default_data_dir_does_not_create_an_install_directory() {
        let source = include_str!("assets.rs");
        let start = source
            .find("pub fn release_default_data_dir()")
            .expect("release_default_data_dir");
        let body = &source[start..];
        let end = body.find("\n}\n").expect("function end");
        let body = &body[..end];
        assert!(
            !body.contains("install_data_dir"),
            "resolving the live data directory must not probe or create <install>/data"
        );
        assert!(body.contains("resolve_release_data_dir(None"));
    }

    #[test]
    fn dimo_install_candidates_start_with_the_running_bundle_data_dir() {
        let root = tempfile::tempdir().unwrap();
        let exe = root
            .path()
            .join("Dimo.app")
            .join("Contents")
            .join("MacOS")
            .join("dimo");
        let local = root.path().join("LocalAppData");
        let pf = root.path().join("ProgramFiles");
        let pf86 = root.path().join("ProgramFilesX86");
        let home = root.path().join("Home");
        let candidates = super::dimo_install_data_dir_candidates_for(
            Some(&exe),
            Some(&local),
            Some(&pf),
            Some(&pf86),
            Some(&home),
        );
        let bundle_data = exe.parent().unwrap().join("data");
        assert_eq!(candidates.first(), Some(&bundle_data));
        assert!(!candidates.contains(&super::legacy_roaming_data_dir()));
        if cfg!(target_os = "windows") {
            assert!(candidates.contains(&local.join("Dimo").join("data")));
            assert!(candidates.contains(&local.join("Programs").join("Dimo").join("data")));
            assert!(candidates.contains(&pf.join("Dimo").join("data")));
        }
        if cfg!(target_os = "macos") {
            assert!(
                candidates.contains(
                    &home
                        .join("Applications")
                        .join("Dimo.app")
                        .join("Contents")
                        .join("MacOS")
                        .join("data")
                )
            );
            assert!(
                candidates.contains(&PathBuf::from("/Applications/Dimo.app/Contents/MacOS/data"))
            );
        }
        if cfg!(target_os = "linux") {
            assert!(candidates.contains(&PathBuf::from("/opt/Dimo/data")));
        }
    }

    #[test]
    fn dimo_install_candidates_skip_cargo_build_trees() {
        let root = tempfile::tempdir().unwrap();
        let exe = root
            .path()
            .join("target")
            .join("debug")
            .join("deps")
            .join("dimo-test");
        let candidates =
            super::dimo_install_data_dir_candidates_for(Some(&exe), None, None, None, None);
        assert!(
            candidates.iter().all(|dir| !dir.starts_with(root.path())),
            "cargo test binaries must not adopt target/debug/deps/data: {candidates:?}"
        );
    }

    #[test]
    fn superseded_siblings_with_a_database_are_adoption_sources() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let kept = root.path().join("data.superseded-20261118-120000");
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(kept.join("db.sqlite"), b"sqlite").unwrap();
        let empty = root.path().join("data.superseded-20261118-130000");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(root.path().join("data.superseded-note.txt"), b"no").unwrap();

        let found = super::superseded_data_dirs_beside(&data);
        assert_eq!(found, vec![kept]);
    }

    #[test]
    fn app_update_deletes_only_a_macos_bundle_database() {
        let exe = Path::new("/Applications/Dimo.app/Contents/MacOS/dimo");
        let data = Path::new("/Applications/Dimo.app/Contents/MacOS/data");
        let aside =
            Path::new("/Applications/Dimo.app/Contents/MacOS/data.superseded-20261118-120000");
        let roaming = Path::new("/Users/me/Library/Application Support/app.dimo.dimo");
        assert!(super::app_update_deletes_directory(true, exe, data));
        assert!(super::app_update_deletes_directory(true, exe, aside));
        assert!(!super::app_update_deletes_directory(false, exe, data));
        assert!(!super::app_update_deletes_directory(true, exe, roaming));

        let cargo = Path::new("/repo/target/debug/deps/dimo-test");
        let cargo_data = Path::new("/repo/target/debug/deps/data");
        assert!(!super::app_update_deletes_directory(
            true, cargo, cargo_data
        ));

        let windows = Path::new(r"C:\Users\me\AppData\Local\Dimo\dimo.exe");
        let windows_data = Path::new(r"C:\Users\me\AppData\Local\Dimo\data");
        assert!(!super::app_update_deletes_directory(
            false,
            windows,
            windows_data
        ));
    }
}
