use directories::ProjectDirs;
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};

const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

pub fn asset_dir() -> std::path::PathBuf {
    let path = if cfg!(debug_assertions) {
        std::path::PathBuf::from(PROJECT_ROOT).join("../../dev_assets")
    } else {
        ProjectDirs::from("app", "vibex", "vibex")
            .expect("OS didn't give us a home directory")
            .data_dir()
            .to_path_buf()
    };

    // Ensure the directory exists
    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create asset directory");
    }

    path
    // ✅ macOS → ~/Library/Application Support/MyApp
    // ✅ Linux → ~/.local/share/myapp   (respects XDG_DATA_HOME)
    // ✅ Windows → %APPDATA%\Example\MyApp
}

pub fn config_path() -> std::path::PathBuf {
    asset_dir().join("config.json")
}

/// Canonical, user-editable settings document shared by the UI and agents.
pub fn settings_path() -> std::path::PathBuf {
    dirs::home_dir()
        .expect("OS didn't give us a home directory")
        .join(".vibex")
        .join("settings.json")
}

/// Directory for rotating application log files (P2-8). Created on first use.
pub fn logs_dir() -> std::path::PathBuf {
    let path = asset_dir().join("logs");
    if !path.exists() {
        let _ = std::fs::create_dir_all(&path);
    }
    path
}

pub fn profiles_path() -> std::path::PathBuf {
    asset_dir().join("profiles.json")
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
/// Adding another builtin package under `assets/plugins/<name>` requires no
/// Host code change or plugin-id branch.
pub fn materialize_builtin_plugins(
    data_root: &std::path::Path,
) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut directories = BuiltinPluginAssets::iter()
        .filter_map(|path| {
            path.strip_suffix("/.vibex-plugin/plugin.json")
                .filter(|directory| !directory.contains('/'))
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    directories.sort();
    directories.dedup();
    directories
        .iter()
        .map(|directory| materialize_builtin_plugin(data_root, directory))
        .collect()
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
    use super::materialize_builtin_plugins;

    #[test]
    fn discovers_builtin_packages_without_plugin_specific_host_code() {
        let data = tempfile::tempdir().unwrap();
        let roots = materialize_builtin_plugins(data.path()).unwrap();

        assert_eq!(roots.len(), 1);
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(roots[0].join(".vibex-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["id"], "vibex.office");

        std::fs::write(
            roots[0].join("config.json"),
            br#"{"previewMode":"editable"}"#,
        )
        .unwrap();
        let repeated = materialize_builtin_plugins(data.path()).unwrap();
        assert_eq!(repeated, roots);
        assert_eq!(
            std::fs::read_to_string(roots[0].join("config.json")).unwrap(),
            r#"{"previewMode":"editable"}"#
        );
    }
}
