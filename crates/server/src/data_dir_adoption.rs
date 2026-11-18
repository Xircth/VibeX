//! Moves legacy VibeX, Roaming, and install-directory databases into the
//! stable data directory outside the app bundle before any database is
//! opened. The install directory is not the live location: a macOS update
//! replaces the whole `.app` and deletes `<bundle>/Contents/MacOS/data`.

use std::{
    cmp::Reverse,
    path::{Path, PathBuf},
};

use serde_json::Value;
use utils::assets::LegacyDataDirAdoption;

use crate::host::catalog::system::remap_settings_json_paths;

const DB_FILES: [&str; 3] = ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"];

#[derive(Debug, PartialEq, Eq)]
pub enum DataDirAdoptionOutcome {
    /// The legacy directory now lives at `target_dir`. A database that was
    /// already at the target is kept aside in `superseded`, never deleted.
    Moved {
        legacy_dir: PathBuf,
        target_dir: PathBuf,
        superseded: Option<PathBuf>,
    },
    /// The target already held the more active/larger database, so it stays
    /// active and the legacy directory is kept aside in `superseded` (or
    /// recorded as already-evaluated when read-only).
    KeptTarget {
        target_dir: PathBuf,
        superseded: PathBuf,
    },
    /// The legacy directory could not be moved (usually still open by an
    /// older Dimo/VibeX). It is opened in place for this run and the move is
    /// retried on the next launch.
    OpenedInPlace { legacy_dir: PathBuf, error: String },
    /// A weaker install-tree copy was moved next to the stable directory so
    /// replacing the app bundle cannot delete it.
    PreservedInstallCopy { from: PathBuf, preserved: PathBuf },
    /// An install-tree database is still inside the install tree. A macOS
    /// update must not continue while this is true.
    InstallCopyRemains { dir: PathBuf, error: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
struct DirActivityScore {
    has_user_data: bool,
    activity_count: i64,
    onboarding_acknowledged: bool,
    database_bytes: u64,
}

/// Adopts every pending legacy directory, highest activity first. Must be
/// called before anything opens the Host database. Returns every outcome,
/// including install-tree copies parked beside the stable directory.
pub async fn adopt_legacy_data_dir() -> Vec<DataDirAdoptionOutcome> {
    let mut outcomes = adopt_ranked(utils::assets::pending_legacy_data_dir_adoptions()).await;
    if cfg!(test) {
        return outcomes;
    }
    let stable = utils::assets::release_default_data_dir();
    let explicit = explicit_data_dirs();
    if let Some(exe_dir) = utils::assets::packaged_install_dir()
        && (stable.join("db.sqlite").is_file() || !explicit.is_empty())
    {
        outcomes.extend(preserve_weaker_install_copies(&exe_dir, &stable, &explicit).await);
    }
    pin_opened_in_place_when_stable_is_empty(&outcomes, &stable);
    outcomes
}

/// Moves user data out of a directory the in-app updater will delete.
///
/// Startup has already adopted what it could before the database was opened.
/// This runs again immediately before the bundle is replaced. It does not
/// replace a stable database this process already has open. When a more
/// active database is still inside a macOS `.app`, the update is refused so
/// the next launch can adopt it before opening SQLite.
pub async fn evacuate_user_data_before_app_update() -> Result<(), String> {
    if cfg!(debug_assertions) || cfg!(test) {
        return Ok(());
    }
    let stable = utils::assets::release_default_data_dir();
    let outcomes = if stable.join("db.sqlite").is_file() {
        match utils::assets::packaged_install_dir() {
            Some(exe_dir) => {
                preserve_weaker_install_copies(&exe_dir, &stable, &explicit_data_dirs()).await
            }
            None => Vec::new(),
        }
    } else {
        adopt_legacy_data_dir().await
    };
    for outcome in &outcomes {
        log_data_dir_adoption(outcome);
    }
    if let Some(blocker) = install_tree_database_update_would_delete() {
        return Err(update_blocked_message(&blocker));
    }
    Ok(())
}

fn pin_opened_in_place_when_stable_is_empty(outcomes: &[DataDirAdoptionOutcome], stable: &Path) {
    if stable.join("db.sqlite").is_file() {
        return;
    }
    for outcome in outcomes {
        if let DataDirAdoptionOutcome::OpenedInPlace { legacy_dir, .. } = outcome
            && legacy_dir.join("db.sqlite").is_file()
        {
            utils::assets::use_data_dir_for_this_run(legacy_dir.clone());
            return;
        }
    }
}

fn explicit_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(value) = utils::assets::renamed_env_var("DIMO_DATA_DIR") {
        dirs.push(PathBuf::from(value));
    }
    if let Some(custom) = utils::assets::read_custom_data_dir() {
        dirs.push(custom);
    }
    dirs
}

async fn adopt_ranked(adoptions: Vec<LegacyDataDirAdoption>) -> Vec<DataDirAdoptionOutcome> {
    let ranked = rank_adoptions(adoptions).await;
    let mut outcomes = Vec::new();
    for adoption in ranked {
        let Some(still_pending) = utils::assets::legacy_data_dir_adoption(
            adoption.legacy_dir.clone(),
            adoption.target_dir.clone(),
        ) else {
            continue;
        };
        outcomes.push(adopt(&still_pending).await);
    }
    outcomes
}

async fn rank_adoptions(adoptions: Vec<LegacyDataDirAdoption>) -> Vec<LegacyDataDirAdoption> {
    if adoptions.len() <= 1 {
        return adoptions;
    }
    let mut scored = Vec::with_capacity(adoptions.len());
    for (idx, candidate) in adoptions.into_iter().enumerate() {
        let score = dir_activity_score(&candidate.legacy_dir).await;
        scored.push((score, Reverse(idx), candidate));
    }
    scored.sort_by(|left, right| (&right.0, &right.1).cmp(&(&left.0, &left.1)));
    scored
        .into_iter()
        .map(|(_, _, candidate)| candidate)
        .collect()
}

#[cfg(test)]
async fn select_best_adoption(
    adoptions: Vec<LegacyDataDirAdoption>,
) -> Option<LegacyDataDirAdoption> {
    rank_adoptions(adoptions).await.into_iter().next()
}

async fn dir_activity_score(dir: &Path) -> DirActivityScore {
    let db_summary = db::inspect_sqlite_content_summary(&dir.join("db.sqlite")).await;
    let has_user_data = db_summary.is_some_and(|summary| summary.has_user_data());
    let activity_count = db_summary
        .map(|summary| {
            summary
                .conversation_count
                .saturating_add(summary.project_count)
        })
        .unwrap_or(0);
    let onboarding_acknowledged = dir_onboarding_acknowledged(dir);
    let database_bytes = database_size(dir);
    DirActivityScore {
        has_user_data,
        activity_count,
        onboarding_acknowledged,
        database_bytes,
    }
}

fn dir_onboarding_acknowledged(dir: &Path) -> bool {
    file_onboarding_acknowledged(&dir.join("settings.json"))
        || file_onboarding_acknowledged(&dir.join("config.json"))
}

fn file_onboarding_acknowledged(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let app_ack = root
        .get("application")
        .and_then(|app| app.get("onboarding_acknowledged"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let top_ack = root
        .get("onboarding_acknowledged")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    app_ack || top_ack
}

pub async fn adopt(adoption: &LegacyDataDirAdoption) -> DataDirAdoptionOutcome {
    let LegacyDataDirAdoption {
        legacy_dir,
        target_dir,
    } = adoption;
    let legacy_score = dir_activity_score(legacy_dir).await;
    let target_score = if target_dir.exists() {
        dir_activity_score(target_dir).await
    } else {
        DirActivityScore::default()
    };
    let keep_target = target_score > legacy_score;
    match move_into_target_with_decision(legacy_dir, target_dir, keep_target) {
        Ok(MoveResult::Moved { superseded }) => {
            rewrite_moved_paths(legacy_dir, target_dir).await;
            DataDirAdoptionOutcome::Moved {
                legacy_dir: legacy_dir.clone(),
                target_dir: target_dir.clone(),
                superseded,
            }
        }
        Ok(MoveResult::KeptTarget { superseded }) => DataDirAdoptionOutcome::KeptTarget {
            target_dir: target_dir.clone(),
            superseded,
        },
        Err(error) => DataDirAdoptionOutcome::OpenedInPlace {
            legacy_dir: legacy_dir.clone(),
            error: error.to_string(),
        },
    }
}

/// Adoption runs before tracing is installed, so callers log the outcome
/// once logging is up.
pub fn log_data_dir_adoption(outcome: &DataDirAdoptionOutcome) {
    match outcome {
        DataDirAdoptionOutcome::Moved {
            legacy_dir,
            target_dir,
            superseded,
        } => tracing::info!(
            from = %legacy_dir.display(),
            to = %target_dir.display(),
            superseded = ?superseded,
            "moved existing Dimo data into the stable data directory"
        ),
        DataDirAdoptionOutcome::KeptTarget {
            target_dir,
            superseded,
        } => tracing::warn!(
            data_dir = %target_dir.display(),
            superseded = %superseded.display(),
            "stable data directory already held the more active database; legacy data kept aside"
        ),
        DataDirAdoptionOutcome::OpenedInPlace { legacy_dir, error } => tracing::warn!(
            data_dir = %legacy_dir.display(),
            %error,
            "could not move existing Dimo data yet; opened it in place and will retry next launch"
        ),
        DataDirAdoptionOutcome::PreservedInstallCopy { from, preserved } => tracing::info!(
            from = %from.display(),
            preserved = %preserved.display(),
            "preserved an install-directory database outside the app bundle"
        ),
        DataDirAdoptionOutcome::InstallCopyRemains { dir, error } => tracing::warn!(
            data_dir = %dir.display(),
            %error,
            "could not move an install-directory database out of the install tree"
        ),
    }
}

fn sqlite_dirs_directly_under(exe_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(exe_dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("db.sqlite").is_file() {
            found.push(path);
        }
    }
    found.sort();
    found
}

fn install_tree_database_update_would_delete() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    database_update_would_delete(cfg!(target_os = "macos"), &exe)
}

fn database_update_would_delete(
    update_replaces_bundle: bool,
    current_exe: &Path,
) -> Option<PathBuf> {
    let exe_dir = current_exe.parent()?;
    sqlite_dirs_directly_under(exe_dir).into_iter().find(|dir| {
        utils::assets::app_update_deletes_directory(update_replaces_bundle, current_exe, dir)
    })
}

fn update_blocked_message(dir: &Path) -> String {
    if explicit_data_dirs()
        .iter()
        .any(|explicit| utils::assets::same_data_dir(explicit, dir))
    {
        return format!(
            "更新已取消：当前数据目录在应用安装包内部（{}），继续更新会删掉它。请先把数据目录改到安装包外面，重新打开并确认会话还在，然后再更新。\nUpdate cancelled: the configured data directory is inside the app bundle ({}). Move it outside the bundle, open Dimo once and confirm your sessions are there, then update again.",
            dir.display(),
            dir.display()
        );
    }
    format!(
        "更新已取消：会话数据仍在应用安装目录里（{}），继续更新会把这份数据删掉。请完全退出 Dimo，重新打开并确认会话还在，然后再更新。\nUpdate cancelled: session data is still inside the app bundle ({}). Continuing would delete it. Quit Dimo completely, open it once and confirm your sessions are there, then update again.",
        dir.display(),
        dir.display()
    )
}

async fn preserve_weaker_install_copies(
    exe_dir: &Path,
    stable: &Path,
    skip: &[PathBuf],
) -> Vec<DataDirAdoptionOutcome> {
    let stable_score = dir_activity_score(stable).await;
    let mut outcomes = Vec::new();
    for dir in sqlite_dirs_directly_under(exe_dir) {
        if utils::assets::same_data_dir(&dir, stable)
            || skip
                .iter()
                .any(|kept| utils::assets::same_data_dir(&dir, kept))
        {
            continue;
        }
        let stable_is_live = stable.join("db.sqlite").is_file();
        let live_is_explicit = !skip.is_empty();
        if !stable_is_live && !live_is_explicit {
            outcomes.push(DataDirAdoptionOutcome::InstallCopyRemains {
                dir,
                error: "stable data directory has no database yet; leaving the only copy in place"
                    .to_string(),
            });
            continue;
        }
        if stable_is_live && !live_is_explicit {
            let readable = db::inspect_sqlite_content_summary(&dir.join("db.sqlite"))
                .await
                .is_some();
            let score = dir_activity_score(&dir).await;
            if !readable || score > stable_score {
                outcomes.push(DataDirAdoptionOutcome::InstallCopyRemains {
                    dir,
                    error:
                        "left in place so the next launch can adopt it before the database is open"
                            .to_string(),
                });
                continue;
            }
        }
        match preserve_sqlite_dir_beside_stable(&dir, stable) {
            Ok(preserved) => outcomes.push(DataDirAdoptionOutcome::PreservedInstallCopy {
                from: dir,
                preserved,
            }),
            Err(error) => outcomes.push(DataDirAdoptionOutcome::InstallCopyRemains {
                dir,
                error: error.to_string(),
            }),
        }
    }
    outcomes
}

fn preserve_sqlite_dir_beside_stable(dir: &Path, stable: &Path) -> std::io::Result<PathBuf> {
    let parent = stable.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "stable data directory has no parent",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let name = dir
        .file_name()
        .map(|file_name| file_name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut dest = parent.join(format!("{name}.preserved-{stamp}"));
    let mut suffix = 1u32;
    while dest.exists() {
        dest = parent.join(format!("{name}.preserved-{stamp}-{suffix}"));
        suffix += 1;
    }
    if utils::assets::same_data_dir(&dest, stable) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "refusing to overwrite the live data directory",
        ));
    }
    match std::fs::rename(dir, &dest) {
        Ok(()) => Ok(dest),
        Err(error) if is_windows_sharing_violation(&error) => Err(error),
        Err(_) => {
            if let Err(copy_err) = copy_dir_tree_for_adoption(dir, &dest) {
                let _ = std::fs::remove_dir_all(&dest);
                return Err(copy_err);
            }
            match std::fs::remove_dir_all(dir) {
                Ok(()) => Ok(dest),
                Err(error) => Err(error),
            }
        }
    }
}

enum MoveResult {
    Moved { superseded: Option<PathBuf> },
    KeptTarget { superseded: PathBuf },
}

#[cfg(test)]
fn move_into_target(legacy_dir: &Path, target_dir: &Path) -> std::io::Result<MoveResult> {
    let keep_target = database_size(target_dir) > database_size(legacy_dir);
    move_into_target_with_decision(legacy_dir, target_dir, keep_target)
}

fn is_windows_sharing_violation(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(32)
    }
    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
}

fn move_into_target_with_decision(
    legacy_dir: &Path,
    target_dir: &Path,
    keep_target: bool,
) -> std::io::Result<MoveResult> {
    if keep_target {
        let superseded = match set_aside(legacy_dir) {
            Ok(aside) => aside,
            Err(_) => {
                // Read-only legacy directory (e.g. Program Files\VibeX\data):
                // mark as already evaluated so we don't inspect it on every launch.
                let _ = utils::assets::record_adopted_legacy_source(target_dir, legacy_dir);
                legacy_dir.to_path_buf()
            }
        };
        return Ok(MoveResult::KeptTarget { superseded });
    }
    let superseded = if is_empty_dir(target_dir) {
        std::fs::remove_dir(target_dir)?;
        None
    } else if target_dir.exists() {
        Some(set_aside(target_dir)?)
    } else {
        None
    };
    if let Some(parent) = target_dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(legacy_dir, target_dir) {
        Ok(()) => Ok(MoveResult::Moved { superseded }),
        Err(rename_err) => {
            if is_windows_sharing_violation(&rename_err) {
                if let Some(superseded) = &superseded {
                    let _ = std::fs::rename(superseded, target_dir);
                }
                return Err(rename_err);
            }
            // Cross-volume moves or read-only VibeX install directories cannot
            // be renamed directly; copy into a sibling staging dir and promote.
            let target_name = target_dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "data".to_string());
            let staging = target_dir
                .with_file_name(format!(".{target_name}.adopting-{}", std::process::id()));
            if staging.exists() {
                let _ = std::fs::remove_dir_all(&staging);
            }
            if let Err(copy_err) = copy_dir_tree_for_adoption(legacy_dir, &staging)
                .and_then(|()| std::fs::rename(&staging, target_dir))
            {
                let _ = std::fs::remove_dir_all(&staging);
                if let Some(superseded) = &superseded {
                    let _ = std::fs::rename(superseded, target_dir);
                }
                return Err(copy_err);
            }
            if set_aside(legacy_dir).is_err() {
                let _ = utils::assets::record_adopted_legacy_source(target_dir, legacy_dir);
            }
            Ok(MoveResult::Moved { superseded })
        }
    }
}

fn copy_dir_tree_for_adoption(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with(".dimo-write-probe-")
            || name == ".adopted-legacy-source"
            || name.starts_with(".vibex-")
        {
            continue;
        }
        let from_path = entry.path();
        let to_path = dst.join(&file_name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_tree_for_adoption(&from_path, &to_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&from_path, &to_path)?;
        }
    }
    Ok(())
}

fn database_size(dir: &Path) -> u64 {
    DB_FILES
        .iter()
        .filter_map(|name| std::fs::metadata(dir.join(name)).ok())
        .map(|meta| meta.len())
        .sum()
}

fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
}

fn set_aside(dir: &Path) -> std::io::Result<PathBuf> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    let mut aside = dir.with_file_name(format!("{name}.superseded-{stamp}"));
    let mut suffix = 1u32;
    while aside.exists() {
        aside = dir.with_file_name(format!("{name}.superseded-{stamp}-{suffix}"));
        suffix += 1;
    }
    std::fs::rename(dir, &aside)?;
    Ok(aside)
}

async fn rewrite_moved_paths(legacy_dir: &Path, target_dir: &Path) {
    let db_file = target_dir.join("db.sqlite");
    if let Err(error) = db::remap_sqlite_file_data_dir_paths(&db_file, legacy_dir, target_dir).await
    {
        tracing::warn!(%error, "could not rewrite data paths in the adopted database");
    }
    let settings_file = target_dir.join("settings.json");
    let config_file = target_dir.join("config.json");
    if !settings_file.exists() && !config_file.exists() {
        utils::assets::adopt_legacy_settings_into(target_dir);
    }
    if let Err(error) = remap_settings_json_paths(&settings_file, legacy_dir, target_dir) {
        tracing::warn!(?error, "could not rewrite data paths in settings.json");
    }
    if let Err(error) = remap_settings_json_paths(&config_file, legacy_dir, target_dir) {
        tracing::warn!(?error, "could not rewrite data paths in config.json");
    }
    ensure_adopted_onboarding_acknowledged(target_dir).await;
    repair_worktrees(&target_dir.join("worktrees"));
}

async fn ensure_adopted_onboarding_acknowledged(target_dir: &Path) {
    let Some(summary) = db::inspect_sqlite_content_summary(&target_dir.join("db.sqlite")).await
    else {
        return;
    };
    if !summary.has_user_data() {
        return;
    }
    let settings_file = target_dir.join("settings.json");
    let config_file = target_dir.join("config.json");
    let source_file = if settings_file.exists() {
        &settings_file
    } else if config_file.exists() {
        &config_file
    } else {
        &settings_file
    };
    let mut config = services::services::config::load_config_from_file(source_file).await;
    if !config.disclaimer_acknowledged || !config.onboarding_acknowledged {
        config.disclaimer_acknowledged = true;
        config.onboarding_acknowledged = true;
        if let Err(error) =
            services::services::config::save_config_to_file(&config, &settings_file).await
        {
            tracing::warn!(%error, "could not persist onboarding_acknowledged after adoption");
        }
    }
}

/// Moving the data directory moves its git worktrees; their parent
/// repositories still point at the old location until repaired.
fn repair_worktrees(worktrees_root: &Path) {
    for worktree in linked_worktrees(worktrees_root) {
        let mut command = std::process::Command::new("git");
        command
            .arg("-C")
            .arg(&worktree)
            .args(["worktree", "repair"]);
        utils::process::configure_std_command_no_window(&mut command);
        match command.output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => tracing::warn!(
                worktree = %worktree.display(),
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "git worktree repair failed after data directory move"
            ),
            Err(error) => tracing::warn!(
                worktree = %worktree.display(),
                %error,
                "could not run git worktree repair after data directory move"
            ),
        }
    }
}

fn linked_worktrees(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(workspaces) = std::fs::read_dir(root) else {
        return found;
    };
    for workspace in workspaces.flatten() {
        let workspace = workspace.path();
        if workspace.join(".git").is_file() {
            found.push(workspace);
            continue;
        }
        let Ok(children) = std::fs::read_dir(&workspace) else {
            continue;
        };
        found.extend(
            children
                .flatten()
                .map(|child| child.path())
                .filter(|child| child.join(".git").is_file()),
        );
    }
    found
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    fn write_db(dir: &Path, bytes: usize) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("db.sqlite"), vec![0u8; bytes]).unwrap();
    }

    async fn create_test_sqlite(dir: &Path, conversations: &[&str], pad_wal_bytes: usize) {
        std::fs::create_dir_all(dir).unwrap();
        let db_path = dir.join("db.sqlite");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE conversations (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        for id in conversations {
            sqlx::query("INSERT INTO conversations (id) VALUES (?1)")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
        if pad_wal_bytes > 0 {
            std::fs::write(dir.join("db.sqlite-wal"), vec![0u8; pad_wal_bytes]).unwrap();
        }
    }

    fn adoption(root: &Path) -> LegacyDataDirAdoption {
        LegacyDataDirAdoption {
            legacy_dir: root.join("roaming").join("data"),
            target_dir: root.join("install").join("data"),
        }
    }

    #[test]
    fn legacy_data_moves_into_an_empty_install_dir() {
        let root = tempfile::tempdir().unwrap();
        let dirs = adoption(root.path());
        write_db(&dirs.legacy_dir, 64);
        std::fs::write(dirs.legacy_dir.join("settings.json"), b"{}").unwrap();
        std::fs::create_dir_all(&dirs.target_dir).unwrap();

        let MoveResult::Moved { superseded } =
            move_into_target(&dirs.legacy_dir, &dirs.target_dir).unwrap()
        else {
            panic!("legacy data should move");
        };
        assert_eq!(superseded, None);
        assert!(!dirs.legacy_dir.exists());
        assert_eq!(database_size(&dirs.target_dir), 64);
        assert!(dirs.target_dir.join("settings.json").is_file());
    }

    #[test]
    fn a_smaller_install_dir_database_is_set_aside_not_deleted() {
        let root = tempfile::tempdir().unwrap();
        let dirs = adoption(root.path());
        write_db(&dirs.legacy_dir, 4096);
        write_db(&dirs.target_dir, 16);

        let MoveResult::Moved { superseded } =
            move_into_target(&dirs.legacy_dir, &dirs.target_dir).unwrap()
        else {
            panic!("larger legacy database should win");
        };
        let superseded = superseded.expect("existing target kept aside");
        assert_eq!(database_size(&superseded), 16);
        assert_eq!(database_size(&dirs.target_dir), 4096);
        assert!(!dirs.legacy_dir.exists());
    }

    #[test]
    fn a_larger_install_dir_database_stays_and_legacy_is_set_aside() {
        let root = tempfile::tempdir().unwrap();
        let dirs = adoption(root.path());
        write_db(&dirs.legacy_dir, 16);
        write_db(&dirs.target_dir, 4096);

        let MoveResult::KeptTarget { superseded } =
            move_into_target(&dirs.legacy_dir, &dirs.target_dir).unwrap()
        else {
            panic!("larger target database should stay");
        };
        assert_eq!(database_size(&superseded), 16);
        assert_eq!(database_size(&dirs.target_dir), 4096);
        assert!(!dirs.legacy_dir.exists());
    }

    #[tokio::test]
    async fn populated_vibex_db_beats_larger_empty_target_and_preserves_onboarding() {
        let root = tempfile::tempdir().unwrap();
        let dirs = adoption(root.path());
        create_test_sqlite(&dirs.legacy_dir, &["conv-1", "conv-2"], 0).await;
        create_test_sqlite(&dirs.target_dir, &[], 512 * 1024).await;
        std::fs::write(
            dirs.target_dir.join("settings.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "application": {
                    "disclaimer_acknowledged": false,
                    "onboarding_acknowledged": false,
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let outcome = adopt(&dirs).await;
        let DataDirAdoptionOutcome::Moved {
            target_dir,
            superseded,
            ..
        } = outcome
        else {
            panic!("populated legacy database should beat empty target: {outcome:?}");
        };
        assert!(superseded.is_some());
        let summary = db::inspect_sqlite_content_summary(&target_dir.join("db.sqlite"))
            .await
            .unwrap();
        assert_eq!(summary.conversation_count, 2);

        let migrated_config =
            services::services::config::load_config_from_file(&target_dir.join("settings.json"))
                .await;
        assert!(migrated_config.disclaimer_acknowledged);
        assert!(migrated_config.onboarding_acknowledged);
    }

    #[tokio::test]
    async fn select_best_adoption_prefers_populated_candidate_over_empty_larger_candidate() {
        let root = tempfile::tempdir().unwrap();
        let target_dir = root.path().join("dimo").join("data");
        let empty_candidate = root.path().join("vibex-roaming").join("data");
        let active_candidate = root.path().join("vibex-install").join("data");

        create_test_sqlite(&empty_candidate, &[], 256 * 1024).await;
        create_test_sqlite(&active_candidate, &["conv-a"], 0).await;

        let chosen = select_best_adoption(vec![
            LegacyDataDirAdoption {
                legacy_dir: empty_candidate,
                target_dir: target_dir.clone(),
            },
            LegacyDataDirAdoption {
                legacy_dir: active_candidate.clone(),
                target_dir,
            },
        ])
        .await
        .expect("chosen adoption");

        assert_eq!(chosen.legacy_dir, active_candidate);
    }

    #[test]
    fn worktrees_are_found_one_and_two_levels_deep() {
        let root = tempfile::tempdir().unwrap();
        let flat = root.path().join("ws-a");
        let nested = root.path().join("ws-b").join("Repo");
        for dir in [&flat, &nested] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(".git"), b"gitdir: x").unwrap();
        }
        let mut found = linked_worktrees(root.path());
        found.sort();
        assert_eq!(found, vec![flat, nested]);
    }

    #[tokio::test]
    async fn adopt_ranked_moves_every_candidate_and_keeps_the_active_database() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("stable");
        let weak = root.path().join("empty-large");
        let strong = root.path().join("populated");
        create_test_sqlite(&weak, &[], 256 * 1024).await;
        create_test_sqlite(&strong, &["conv-a"], 0).await;

        let outcomes = adopt_ranked(vec![
            LegacyDataDirAdoption {
                legacy_dir: weak.clone(),
                target_dir: target.clone(),
            },
            LegacyDataDirAdoption {
                legacy_dir: strong.clone(),
                target_dir: target.clone(),
            },
        ])
        .await;

        assert_eq!(outcomes.len(), 2);
        assert!(!strong.exists());
        assert!(!weak.exists());
        let summary = db::inspect_sqlite_content_summary(&target.join("db.sqlite"))
            .await
            .expect("stable database");
        assert_eq!(summary.conversation_count, 1);
    }

    #[tokio::test]
    async fn weaker_install_copies_are_preserved_beside_the_stable_directory() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("Dimo.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        let aside = exe_dir.join("data.superseded-20261118-120000");
        create_test_sqlite(&data, &[], 64).await;
        create_test_sqlite(&aside, &[], 32).await;
        let stable = root.path().join("AppSupport").join("app.dimo.dimo");
        create_test_sqlite(&stable, &["kept"], 0).await;

        let outcomes = preserve_weaker_install_copies(&exe_dir, &stable, &[]).await;

        assert!(outcomes.iter().all(|outcome| {
            matches!(outcome, DataDirAdoptionOutcome::PreservedInstallCopy { .. })
        }));
        assert!(!data.exists());
        assert!(!aside.exists());
        let summary = db::inspect_sqlite_content_summary(&stable.join("db.sqlite"))
            .await
            .expect("live database");
        assert_eq!(summary.conversation_count, 1);
        let preserved: Vec<_> = std::fs::read_dir(stable.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".preserved-"))
            })
            .collect();
        assert_eq!(preserved.len(), 2);
        assert!(preserved.iter().all(|dir| dir.join("db.sqlite").is_file()));
    }

    #[tokio::test]
    async fn a_more_active_install_database_is_not_parked_away_from_its_path() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        create_test_sqlite(&data, &["real-session"], 0).await;
        let stable = root.path().join("AppSupport").join("app.dimo.dimo");
        create_test_sqlite(&stable, &[], 4096).await;

        let outcomes = preserve_weaker_install_copies(&exe_dir, &stable, &[]).await;

        assert!(matches!(
            outcomes.as_slice(),
            [DataDirAdoptionOutcome::InstallCopyRemains { .. }]
        ));
        assert!(data.join("db.sqlite").is_file());
        assert_eq!(
            std::fs::read_dir(stable.parent().unwrap())
                .unwrap()
                .flatten()
                .filter(|entry| { entry.file_name().to_string_lossy().contains(".preserved-") })
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn the_only_database_is_not_moved_into_a_preserved_folder() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        create_test_sqlite(&data, &["only-copy"], 0).await;
        let stable = root.path().join("AppSupport").join("app.dimo.dimo");
        std::fs::create_dir_all(&stable).unwrap();

        let outcomes = preserve_weaker_install_copies(&exe_dir, &stable, &[]).await;

        assert!(matches!(
            outcomes.as_slice(),
            [DataDirAdoptionOutcome::InstallCopyRemains { .. }]
        ));
        assert!(data.join("db.sqlite").is_file());
        assert!(!stable.join("db.sqlite").is_file());
    }

    #[tokio::test]
    async fn an_install_copy_is_preserved_when_the_live_directory_is_explicit() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        create_test_sqlite(&data, &["old"], 0).await;
        let stable = root.path().join("AppSupport").join("app.dimo.dimo");
        std::fs::create_dir_all(&stable).unwrap();
        let custom = root.path().join("custom");
        create_test_sqlite(&custom, &["live"], 0).await;

        let outcomes =
            preserve_weaker_install_copies(&exe_dir, &stable, std::slice::from_ref(&custom)).await;

        assert!(matches!(
            outcomes.as_slice(),
            [DataDirAdoptionOutcome::PreservedInstallCopy { .. }]
        ));
        assert!(!data.exists());
        assert!(custom.join("db.sqlite").is_file());
        let summary = db::inspect_sqlite_content_summary(&custom.join("db.sqlite"))
            .await
            .expect("custom database");
        assert_eq!(summary.conversation_count, 1);
    }

    #[tokio::test]
    async fn an_explicit_data_directory_inside_the_install_tree_is_not_moved() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        create_test_sqlite(&data, &["live"], 0).await;
        let stable = root.path().join("AppSupport").join("app.dimo.dimo");
        std::fs::create_dir_all(&stable).unwrap();

        let outcomes =
            preserve_weaker_install_copies(&exe_dir, &stable, std::slice::from_ref(&data)).await;

        assert!(outcomes.is_empty());
        assert!(data.join("db.sqlite").is_file());
    }

    #[test]
    fn macos_bundle_update_would_delete_a_database_left_beside_the_executable() {
        let root = tempfile::tempdir().unwrap();
        let exe_dir = root.path().join("Dimo.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let data = exe_dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("db.sqlite"), b"x").unwrap();
        let exe = exe_dir.join("dimo");

        assert_eq!(
            database_update_would_delete(true, &exe).as_deref(),
            Some(data.as_path())
        );
        assert!(database_update_would_delete(false, &exe).is_none());
    }

    #[tokio::test]
    async fn evacuate_does_not_touch_the_machine_from_a_test_build() {
        assert!(evacuate_user_data_before_app_update().await.is_ok());
    }
}
