use directories::ProjectDirs;
use rust_embed::RustEmbed;

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
