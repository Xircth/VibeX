use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use rust_embed::RustEmbed;
const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

/// Default Host data directory shared by Desktop release builds and `vibex-server`.
///
/// Desktop debug builds still use the repo `dev_assets/` tree via [`asset_dir`].
pub fn default_host_data_dir() -> PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .or_else(|| dirs::data_dir().map(|path| path.join("vibex")))
        .unwrap_or_else(|| PathBuf::from(".vibex-data"))
}

pub fn asset_dir() -> PathBuf {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(PROJECT_ROOT).join("../../dev_assets")
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
/// keeps using `dev_assets/` and release builds share ProjectDirs with Server.
pub fn host_data_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("VIBEX_DATA_DIR") {
        let path = PathBuf::from(explicit);
        let _ = std::fs::create_dir_all(&path);
        return path;
    }
    asset_dir()
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
}
