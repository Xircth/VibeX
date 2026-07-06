use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

mod crypto;

const BACKUP_FORMAT: &str = "vibex-portable-backup";
const BACKUP_VERSION: u32 = 1;
const BACKUP_PROGRESS_EVENT: &str = "vibex://backup-progress";

#[derive(Debug, Clone, Default, Deserialize)]
pub struct BackupCreateOptions {
    pub path: String,
    /// When set (non-empty), the backup is encrypted with this passphrase (P3-4).
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupInspectOptions {
    pub path: String,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackupRestoreStagePayload {
    pub path: String,
    pub passphrase: Option<String>,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub app_version: String,
    pub entry_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPreviewEntry {
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPreview {
    pub manifest: BackupManifest,
    pub entries: Vec<BackupPreviewEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRestoreResult {
    pub preview: BackupPreview,
    pub restored_entries: usize,
    pub requires_reload: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgressEvent {
    pub operation: String,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableBackup {
    manifest: BackupManifest,
    entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEntry {
    path: String,
    size_bytes: u64,
    modified_at: Option<String>,
    bytes_base64: String,
}

#[derive(Debug, Clone)]
struct BackupSource {
    logical_path: String,
    file_path: PathBuf,
}

fn emit_progress(
    app: &AppHandle,
    operation: &str,
    stage: &str,
    completed: usize,
    total: usize,
    message: impl Into<String>,
) {
    let _ = app.emit(
        BACKUP_PROGRESS_EVENT,
        BackupProgressEvent {
            operation: operation.to_string(),
            stage: stage.to_string(),
            completed,
            total,
            message: message.into(),
        },
    );
}

fn modified_at(metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let datetime: DateTime<Utc> = modified.into();
    Some(datetime.to_rfc3339())
}

fn asset_file_source(name: &str) -> Option<BackupSource> {
    let file_path = utils::assets::asset_dir().join(name);
    file_path.exists().then(|| BackupSource {
        logical_path: format!("asset/{name}"),
        file_path,
    })
}

fn vibex_root() -> Result<PathBuf, AppError> {
    dirs::home_dir()
        .map(|home| home.join(".vibex"))
        .ok_or_else(|| AppError::Internal("Unable to resolve user home directory".to_string()))
}

fn collect_directory_sources(
    base: &Path,
    logical_prefix: &str,
    current: &Path,
    sources: &mut Vec<BackupSource>,
) -> Result<(), AppError> {
    if !current.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(current).map_err(|error| {
        AppError::Internal(format!(
            "Failed to read directory {}: {error}",
            current.display()
        ))
    })? {
        let entry = entry.map_err(|error| {
            AppError::Internal(format!("Failed to read directory entry: {error}"))
        })?;
        let path = entry.path();
        let metadata = fs::metadata(&path).map_err(|error| {
            AppError::Internal(format!(
                "Failed to read metadata {}: {error}",
                path.display()
            ))
        })?;

        if metadata.is_dir() {
            collect_directory_sources(base, logical_prefix, &path, sources)?;
            continue;
        }

        if !metadata.is_file() {
            continue;
        }

        let relative = path.strip_prefix(base).map_err(|error| {
            AppError::Internal(format!(
                "Failed to derive relative backup path for {}: {error}",
                path.display()
            ))
        })?;
        let mut logical_path = logical_prefix.to_string();
        for component in relative.components() {
            let Component::Normal(part) = component else {
                continue;
            };
            logical_path.push('/');
            logical_path.push_str(&part.to_string_lossy().replace('\\', "/"));
        }

        sources.push(BackupSource {
            logical_path,
            file_path: path,
        });
    }

    Ok(())
}

fn collect_sources() -> Result<Vec<BackupSource>, AppError> {
    let mut sources = Vec::new();
    for name in [
        "config.json",
        "profiles.json",
        "db.sqlite",
        "version-control-settings.json",
        "instructions-metadata.json",
        "system-settings.json",
        "web-service-settings.json",
        "model-provider-settings.json",
        "model-provider-secrets.json",
        "chat-channel-settings.json",
        "chat-channel-secrets.json",
    ] {
        if let Some(source) = asset_file_source(name) {
            sources.push(source);
        }
    }

    let vibex_root = vibex_root()?;
    let mcp_path = vibex_root.join("mcp.json");
    if mcp_path.exists() {
        sources.push(BackupSource {
            logical_path: "vibex/mcp.json".to_string(),
            file_path: mcp_path,
        });
    }

    collect_directory_sources(
        &vibex_root.join("skills"),
        "vibex/skills",
        &vibex_root.join("skills"),
        &mut sources,
    )?;

    sources.sort_by(|a, b| a.logical_path.cmp(&b.logical_path));
    Ok(sources)
}

fn build_manifest(entries: &[BackupEntry]) -> BackupManifest {
    BackupManifest {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        created_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        entry_count: entries.len(),
        total_bytes: entries.iter().map(|entry| entry.size_bytes).sum(),
    }
}

fn preview_from_backup(backup: &PortableBackup) -> BackupPreview {
    BackupPreview {
        manifest: backup.manifest.clone(),
        entries: backup
            .entries
            .iter()
            .map(|entry| BackupPreviewEntry {
                path: entry.path.clone(),
                size_bytes: entry.size_bytes,
                modified_at: entry.modified_at.clone(),
            })
            .collect(),
    }
}

fn validate_backup(backup: &PortableBackup) -> Result<(), AppError> {
    if backup.manifest.format != BACKUP_FORMAT {
        return Err(AppError::BadRequest(format!(
            "Unsupported backup format: {}",
            backup.manifest.format
        )));
    }
    if backup.manifest.version != BACKUP_VERSION {
        return Err(AppError::BadRequest(format!(
            "Unsupported backup version: {}",
            backup.manifest.version
        )));
    }
    Ok(())
}

/// Trim a caller-supplied passphrase, treating blank as absent.
fn normalize_passphrase(passphrase: Option<&str>) -> Option<&str> {
    passphrase.map(str::trim).filter(|value| !value.is_empty())
}

fn read_backup_file(path: &Path, passphrase: Option<&str>) -> Result<PortableBackup, AppError> {
    let raw = fs::read(path).map_err(|error| {
        AppError::Internal(format!("Failed to read backup {}: {error}", path.display()))
    })?;

    // Auto-detect the envelope: an encrypted backup requires a passphrase; a
    // plaintext (legacy / unencrypted) backup parses directly and must NOT be
    // handed a passphrase silently ignored.
    let bytes = if crypto::is_encrypted(&raw) {
        let pass = normalize_passphrase(passphrase).ok_or_else(|| {
            AppError::BadRequest("This backup is encrypted; a passphrase is required".to_string())
        })?;
        crypto::decrypt_bytes(&raw, pass)?
    } else {
        raw
    };

    let backup: PortableBackup = serde_json::from_slice(&bytes).map_err(|error| {
        AppError::BadRequest(format!(
            "Failed to parse backup {}: {error}",
            path.display()
        ))
    })?;
    validate_backup(&backup)?;
    Ok(backup)
}

fn resolve_restore_target(logical_path: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(logical_path);
    if path.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "Backup entry path must be relative: {logical_path}"
        )));
    }

    let mut components = path.components();
    let Some(Component::Normal(prefix)) = components.next() else {
        return Err(AppError::BadRequest(format!(
            "Invalid backup entry path: {logical_path}"
        )));
    };

    let mut target = if prefix == OsStr::new("asset") {
        utils::assets::asset_dir()
    } else if prefix == OsStr::new("vibex") {
        vibex_root()?
    } else {
        return Err(AppError::BadRequest(format!(
            "Unsupported backup entry root: {}",
            prefix.to_string_lossy()
        )));
    };

    for component in components {
        let Component::Normal(part) = component else {
            return Err(AppError::BadRequest(format!(
                "Unsafe backup entry path: {logical_path}"
            )));
        };
        target.push(part);
    }

    Ok(target)
}

#[tauri::command]
pub async fn backup_create(
    app: AppHandle,
    options: BackupCreateOptions,
) -> Result<BackupPreview, AppError> {
    let backup_path = PathBuf::from(options.path.trim());
    if backup_path.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "Backup destination path cannot be empty".to_string(),
        ));
    }

    let sources = collect_sources()?;
    emit_progress(
        &app,
        "create",
        "collect",
        0,
        sources.len(),
        "Collected VibeX data files",
    );

    let total = sources.len();
    let mut entries = Vec::with_capacity(total);
    for (index, source) in sources.into_iter().enumerate() {
        let bytes = fs::read(&source.file_path).map_err(|error| {
            AppError::Internal(format!(
                "Failed to read backup source {}: {error}",
                source.file_path.display()
            ))
        })?;
        let metadata = fs::metadata(&source.file_path).map_err(|error| {
            AppError::Internal(format!(
                "Failed to read backup source metadata {}: {error}",
                source.file_path.display()
            ))
        })?;

        entries.push(BackupEntry {
            path: source.logical_path.clone(),
            size_bytes: bytes.len() as u64,
            modified_at: modified_at(&metadata),
            bytes_base64: general_purpose::STANDARD.encode(bytes),
        });

        emit_progress(
            &app,
            "create",
            "pack",
            index + 1,
            total,
            format!("Packed {}", source.logical_path),
        );
    }

    let manifest = build_manifest(&entries);
    let backup = PortableBackup { manifest, entries };
    if let Some(parent) = backup_path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::Internal(format!(
                "Failed to create backup destination {}: {error}",
                parent.display()
            ))
        })?;
    }

    let content = serde_json::to_vec_pretty(&backup)
        .map_err(|error| AppError::Internal(format!("Failed to serialize backup: {error}")))?;
    // Encrypt the payload when a passphrase was supplied (P3-4); otherwise write
    // the plaintext JSON as before.
    let content = match normalize_passphrase(options.passphrase.as_deref()) {
        Some(passphrase) => {
            emit_progress(&app, "create", "encrypt", total, total, "Encrypting backup");
            crypto::encrypt_bytes(&content, passphrase)?
        }
        None => content,
    };
    fs::write(&backup_path, content).map_err(|error| {
        AppError::Internal(format!(
            "Failed to write backup {}: {error}",
            backup_path.display()
        ))
    })?;

    emit_progress(
        &app,
        "create",
        "done",
        total,
        total,
        format!("Backup written to {}", backup_path.display()),
    );

    Ok(preview_from_backup(&backup))
}

#[tauri::command]
pub async fn backup_inspect(options: BackupInspectOptions) -> Result<BackupPreview, AppError> {
    let path = PathBuf::from(options.path.trim());
    if path.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "Backup path cannot be empty".to_string(),
        ));
    }

    let backup = read_backup_file(&path, options.passphrase.as_deref())?;
    Ok(preview_from_backup(&backup))
}

#[tauri::command]
pub async fn backup_restore_stage(
    app: AppHandle,
    payload: BackupRestoreStagePayload,
) -> Result<BackupRestoreResult, AppError> {
    if !payload.confirmed {
        return Err(AppError::BadRequest(
            "Restore must be confirmed after backup inspection".to_string(),
        ));
    }

    let path = PathBuf::from(payload.path.trim());
    if path.as_os_str().is_empty() {
        return Err(AppError::BadRequest(
            "Backup path cannot be empty".to_string(),
        ));
    }

    let backup = read_backup_file(&path, payload.passphrase.as_deref())?;
    let preview = preview_from_backup(&backup);
    let total = backup.entries.len();

    for (index, entry) in backup.entries.iter().enumerate() {
        let target = resolve_restore_target(&entry.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                AppError::Internal(format!(
                    "Failed to create restore directory {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let bytes = general_purpose::STANDARD
            .decode(&entry.bytes_base64)
            .map_err(|error| {
                AppError::BadRequest(format!(
                    "Invalid backup payload for {}: {error}",
                    entry.path
                ))
            })?;

        fs::write(&target, bytes).map_err(|error| {
            AppError::Internal(format!(
                "Failed to restore {} to {}: {error}",
                entry.path,
                target.display()
            ))
        })?;

        emit_progress(
            &app,
            "restore",
            "write",
            index + 1,
            total,
            format!("Restored {}", entry.path),
        );
    }

    emit_progress(
        &app,
        "restore",
        "done",
        total,
        total,
        "Restore completed; restart is recommended",
    );

    Ok(BackupRestoreResult {
        preview,
        restored_entries: total,
        requires_reload: true,
    })
}

#[tauri::command]
pub async fn backup_cancel(_op_id: Option<String>) -> Result<(), AppError> {
    Ok(())
}
