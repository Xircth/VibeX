use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};

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

#[derive(RustEmbed)]
#[folder = "../../assets/plugins"]
pub struct BuiltinPluginAssets;

/// Materializes every bundled VibeX plugin from application-owned bytes.
/// Builtin product plugins live in git submodules under `assets/plugins/<name>`.
/// Adding another checked-out package there requires no Host code change or
/// plugin-id branch.
pub fn materialize_builtin_plugins(
    data_root: &std::path::Path,
) -> std::io::Result<Vec<std::path::PathBuf>> {
    let directories = embedded_builtin_directories();
    if directories.is_empty() {
        tracing::error!("no official plugin manifests were embedded in this Host");
    }
    let mut by_id = existing_materialized_plugin_roots(data_root);
    for directory in &directories {
        let root = materialize_builtin_plugin(data_root, directory)?;
        if let Some(plugin_id) = materialized_plugin_id(&root) {
            by_id.insert(plugin_id, root);
        }
    }
    Ok(by_id.into_values().collect())
}

fn embedded_builtin_directories() -> Vec<String> {
    let mut directories = BTreeSet::new();
    for path in BuiltinPluginAssets::iter() {
        if let Some(directory) = path
            .strip_suffix("/.vibex-plugin/plugin.json")
            .filter(|directory| !directory.is_empty() && !directory.contains('/'))
        {
            directories.insert(directory.to_owned());
        }
        if let Some(directory) = path.split('/').next()
            && !directory.is_empty()
            && directory != "index"
            && BuiltinPluginAssets::get(&format!("{directory}/.vibex-plugin/plugin.json")).is_some()
        {
            directories.insert(directory.to_owned());
        }
    }
    directories.into_iter().collect()
}

/// Host data may already contain official packages from a previous launch.
/// Keep those roots importable even if this binary's embed list is empty.
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

fn materialized_plugin_id(root: &Path) -> Option<String> {
    root.parent()?
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}

fn materialize_builtin_plugin(
    data_root: &std::path::Path,
    directory: &str,
) -> std::io::Result<std::path::PathBuf> {
    let manifest_path = format!("{directory}/.vibex-plugin/plugin.json");
    let manifest = BuiltinPluginAssets::get(&manifest_path)
        .ok_or_else(|| std::io::Error::other("embedded plugin manifest disappeared"))?;
    let document: serde_json::Value =
        serde_json::from_slice(manifest.data.as_ref()).map_err(std::io::Error::other)?;
    let plugin_id = document
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'-' | b'_')
                })
        })
        .ok_or_else(|| std::io::Error::other("embedded plugin id is invalid"))?;
    let mut runtime_assets = builtin_asset_paths(directory);
    runtime_assets.sort();
    let mut package_hasher = Sha256::new();
    for (embedded_path, relative) in &runtime_assets {
        let embedded = BuiltinPluginAssets::get(embedded_path)
            .ok_or_else(|| std::io::Error::other("embedded plugin asset disappeared"))?;
        package_hasher.update(relative.as_bytes());
        package_hasher.update([0]);
        package_hasher.update(embedded.metadata.sha256_hash());
    }
    let fingerprint = package_hasher
        .finalize()
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let destination = data_root
        .join("builtin-plugins")
        .join(plugin_id)
        .join(fingerprint);

    if destination.exists() {
        verify_embedded_directory(directory, &destination)?;
        ensure_builtin_config(directory, &destination)?;
        return Ok(destination);
    }

    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::other("builtin plugin destination has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&staging)?;
    let materialized = (|| {
        for (embedded_path, relative) in &runtime_assets {
            let embedded = BuiltinPluginAssets::get(embedded_path)
                .ok_or_else(|| std::io::Error::other("embedded plugin asset disappeared"))?;
            let output = staging.join(relative);
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(output, embedded.data.as_ref())?;
        }
        ensure_builtin_config(directory, &staging)?;
        match std::fs::rename(&staging, &destination) {
            Ok(()) => Ok(()),
            Err(_) if destination.exists() => {
                std::fs::remove_dir_all(&staging)?;
                verify_embedded_directory(directory, &destination)
            }
            Err(error) => Err(error),
        }
    })();
    if materialized.is_err() && staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    materialized?;
    Ok(destination)
}

fn builtin_asset_paths(directory: &str) -> Vec<(String, String)> {
    let prefix = format!("{directory}/");
    BuiltinPluginAssets::iter()
        .filter_map(|path| {
            let embedded_path = path.into_owned();
            let relative = embedded_path.strip_prefix(&prefix)?.to_owned();
            is_builtin_runtime_asset(std::path::Path::new(&relative))
                .then_some((embedded_path, relative))
        })
        .collect()
}

fn ensure_builtin_config(directory: &str, root: &std::path::Path) -> std::io::Result<()> {
    let path = root.join("config.json");
    if path.exists() {
        return Ok(());
    }
    let embedded = BuiltinPluginAssets::get(&format!("{directory}/config.json"))
        .ok_or_else(|| std::io::Error::other("embedded plugin config is missing"))?;
    std::fs::write(path, embedded.data.as_ref())
}

fn verify_embedded_directory(directory: &str, root: &std::path::Path) -> std::io::Result<()> {
    for (embedded_path, relative) in builtin_asset_paths(directory) {
        let path = root.join(relative);
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() {
            return Err(std::io::Error::other(
                "materialized builtin plugin contains a non-file asset",
            ));
        }
        let embedded = BuiltinPluginAssets::get(&embedded_path)
            .ok_or_else(|| std::io::Error::other("embedded plugin asset disappeared"))?;
        if std::fs::read(path)? != embedded.data.as_ref() {
            return Err(std::io::Error::other(
                "materialized builtin plugin failed integrity verification",
            ));
        }
    }
    Ok(())
}

fn is_builtin_runtime_asset(path: &std::path::Path) -> bool {
    if path == std::path::Path::new("package.json") || path == std::path::Path::new("README.md") {
        return true;
    }
    matches!(
        path.components().next(),
        Some(std::path::Component::Normal(first))
            if first == ".vibex-plugin"
                || first == "dist"
                || first == "contents"
                || first == "depends"
                || first == "assets"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        adopt_legacy_file, copy_missing_files, load_or_create_host_id, materialize_builtin_plugins,
        tauri_app_data_file_candidates,
    };

    #[test]
    fn discovers_builtin_packages_without_plugin_specific_host_code() {
        let data = tempfile::tempdir().unwrap();
        let roots = materialize_builtin_plugins(data.path()).unwrap();

        let mut ids = roots
            .iter()
            .map(|root| {
                let manifest: serde_json::Value = serde_json::from_slice(
                    &std::fs::read(root.join(".vibex-plugin/plugin.json")).unwrap(),
                )
                .unwrap();
                manifest["id"].as_str().unwrap().to_owned()
            })
            .collect::<Vec<_>>();
        ids.sort();
        assert_eq!(
            ids,
            [
                "vibex.multi-agent",
                "vibex.office",
                "vibex.plugin-development",
                "vibex.session-enhance",
                "vibex.workflow-creator",
            ]
        );
        let office = roots
            .iter()
            .find(|root| root.to_string_lossy().contains("vibex.office"))
            .unwrap();

        std::fs::write(office.join("config.json"), br#"{"idleTimeoutMinutes": 7}"#).unwrap();
        let repeated = materialize_builtin_plugins(data.path()).unwrap();
        assert_eq!(repeated, roots);
        let repeated_office = repeated
            .iter()
            .find(|root| root.to_string_lossy().contains("vibex.office"))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(repeated_office.join("config.json")).unwrap(),
            r#"{"idleTimeoutMinutes": 7}"#
        );
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

        let roots = materialize_builtin_plugins(data.path()).unwrap();
        assert!(
            roots.iter().any(|root| root == &extra),
            "already materialized packages must stay visible to Host import"
        );
        assert_eq!(roots.len(), 6);
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
