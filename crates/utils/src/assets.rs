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
/// Stored in the OS config directory (`%APPDATA%\vibex\vibex\config\bootstrap.json` on Windows)
/// so the Host can locate a user-configured custom data directory before opening `db.sqlite`.
pub fn bootstrap_config_path() -> PathBuf {
    if let Some(explicit) =
        std::env::var_os("VIBEX_BOOTSTRAP_CONFIG_PATH").filter(|value| !value.is_empty())
    {
        return PathBuf::from(explicit);
    }
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.config_dir().join("bootstrap.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".vibex").join("bootstrap.json")))
        .unwrap_or_else(|| PathBuf::from(".vibex-bootstrap.json"))
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
    read_custom_data_dir_from(&bootstrap_config_path())
}

/// Data directory used before release builds moved data under the install
/// directory (`%APPDATA%\vibex\vibex\data` on Windows). Also the fallback when
/// the install directory is read-only.
pub fn legacy_roaming_data_dir() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("vibex")))
        .unwrap_or_else(|| PathBuf::from(".vibex-data"))
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
    let probe = dir.join(format!(".vibex-write-probe-{}", std::process::id()));
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
pub fn install_data_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|install_dir| install_data_dir_for_exe_dir(&install_dir))
}

/// Release default: `<install_dir>/data`, or [`legacy_roaming_data_dir`] when
/// the install directory is read-only. Data left in the legacy directory is
/// moved here at startup by `db::adopt_legacy_data_dir`, never shadowed.
pub fn release_default_data_dir() -> PathBuf {
    install_data_dir().unwrap_or_else(legacy_roaming_data_dir)
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

/// Returns the adoption to perform at startup, if any. Only release builds
/// without an explicit data directory (`VIBEX_DATA_DIR` or `bootstrap.json`)
/// adopt, and only when the legacy directory holds a database.
pub fn pending_legacy_data_dir_adoption() -> Option<LegacyDataDirAdoption> {
    if cfg!(debug_assertions)
        || std::env::var_os("VIBEX_DATA_DIR").is_some_and(|value| !value.is_empty())
        || read_custom_data_dir().is_some()
    {
        return None;
    }
    legacy_data_dir_adoption(legacy_roaming_data_dir(), install_data_dir()?)
}

pub fn legacy_data_dir_adoption(
    legacy_dir: PathBuf,
    target_dir: PathBuf,
) -> Option<LegacyDataDirAdoption> {
    (legacy_dir != target_dir && legacy_dir.join("db.sqlite").is_file()).then_some(
        LegacyDataDirAdoption {
            legacy_dir,
            target_dir,
        },
    )
}

pub fn default_data_dir_without_custom() -> PathBuf {
    if cfg!(debug_assertions) {
        debug_dev_assets_dir()
    } else {
        release_default_data_dir()
    }
}

/// Default Host data directory shared by Desktop release builds and `vibex-server`.
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
/// could not be moved yet (for example, an older VibeX still holds it open):
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

/// Canonical Host data directory for Desktop and `vibex-server`.
///
/// `VIBEX_DATA_DIR` wins. Otherwise this is [`asset_dir`] so debug Desktop
/// keeps using `dev_assets/` (unless customized) and release builds use
/// `<install_dir>/data` (Roaming when the install dir is read-only) or the
/// user's custom data directory.
pub fn host_data_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("VIBEX_DATA_DIR").filter(|value| !value.is_empty()) {
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

/// Settings live next to the Host database. `~/.vibex/settings.json` is copied
/// once if the Host file does not exist yet.
pub fn settings_path() -> PathBuf {
    let dest = host_data_dir().join("settings.json");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join("settings.json")),
        &dest,
    );
    dest
}

pub fn im_env_path() -> PathBuf {
    let dest = host_data_dir().join(".env");
    adopt_legacy_file(
        dirs::home_dir().map(|home| home.join(".vibex").join(".env")),
        &dest,
    );
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

/// Directories Tauri used for `app.path().app_data_dir()` with identifier
/// `com.vibex.app`. Host product files now live in [`host_data_dir`].
pub fn tauri_app_data_dir_candidates() -> Vec<PathBuf> {
    let Some(data) = dirs::data_dir() else {
        return Vec::new();
    };
    let mut dirs = vec![
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
/// Desktop and `vibex-server` must persist this next to the database so pairing
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
            if !path.join(".vibex-plugin/plugin.json").is_file() {
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
        std::fs::create_dir_all(extra.join(".vibex-plugin")).unwrap();
        std::fs::write(
            extra.join(".vibex-plugin/plugin.json"),
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
                    .any(|component| component.as_os_str() == "com.vibex.app")
                    && path
                        .file_name()
                        .is_some_and(|name| name == "agent-model-providers.json")
            }),
            "expected com.vibex.app candidate, got {files:?}"
        );
    }

    #[test]
    fn install_data_dir_uses_install_dir_data_and_skips_cargo_target_dirs() {
        let root = tempfile::tempdir().unwrap();
        let install_dir = root.path().join("VibeX");
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
            "read-only installs already use the legacy directory"
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
}
