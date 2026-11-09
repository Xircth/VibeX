//! Moves a legacy Roaming data directory into the release default
//! (`<install_dir>/data`) before any database is opened, so an install-dir
//! database can never shadow the user's existing data.

use std::path::{Path, PathBuf};

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
    /// The target already held the larger database, so it stays active and
    /// the legacy directory is kept aside in `superseded`.
    KeptTarget {
        target_dir: PathBuf,
        superseded: PathBuf,
    },
    /// The legacy directory could not be moved (usually still open by an
    /// older VibeX). It is opened in place for this run and the move is
    /// retried on the next launch.
    OpenedInPlace { legacy_dir: PathBuf, error: String },
}

/// Runs the pending legacy adoption, if any. Must be called before anything
/// resolves the Host data directory.
pub async fn adopt_legacy_data_dir() -> Option<DataDirAdoptionOutcome> {
    let adoption = utils::assets::pending_legacy_data_dir_adoption()?;
    let outcome = adopt(&adoption).await;
    if let DataDirAdoptionOutcome::OpenedInPlace { legacy_dir, .. } = &outcome {
        utils::assets::use_data_dir_for_this_run(legacy_dir.clone());
    }
    Some(outcome)
}

pub async fn adopt(adoption: &LegacyDataDirAdoption) -> DataDirAdoptionOutcome {
    let LegacyDataDirAdoption {
        legacy_dir,
        target_dir,
    } = adoption;
    match move_into_target(legacy_dir, target_dir) {
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
            "moved existing VibeX data into the install data directory"
        ),
        DataDirAdoptionOutcome::KeptTarget {
            target_dir,
            superseded,
        } => tracing::warn!(
            data_dir = %target_dir.display(),
            superseded = %superseded.display(),
            "install data directory already held the larger database; legacy data kept aside"
        ),
        DataDirAdoptionOutcome::OpenedInPlace { legacy_dir, error } => tracing::warn!(
            data_dir = %legacy_dir.display(),
            %error,
            "could not move existing VibeX data yet; opened it in place and will retry next launch"
        ),
    }
}

enum MoveResult {
    Moved { superseded: Option<PathBuf> },
    KeptTarget { superseded: PathBuf },
}

fn move_into_target(legacy_dir: &Path, target_dir: &Path) -> std::io::Result<MoveResult> {
    if database_size(target_dir) > database_size(legacy_dir) {
        let superseded = set_aside(legacy_dir)?;
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
    if let Err(error) = std::fs::rename(legacy_dir, target_dir) {
        if let Some(superseded) = &superseded {
            let _ = std::fs::rename(superseded, target_dir);
        }
        return Err(error);
    }
    Ok(MoveResult::Moved { superseded })
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
    let aside = dir.with_file_name(format!("{name}.superseded-{stamp}"));
    std::fs::rename(dir, &aside)?;
    Ok(aside)
}

async fn rewrite_moved_paths(legacy_dir: &Path, target_dir: &Path) {
    let db_file = target_dir.join("db.sqlite");
    if let Err(error) = db::remap_sqlite_file_data_dir_paths(&db_file, legacy_dir, target_dir).await
    {
        tracing::warn!(%error, "could not rewrite data paths in the adopted database");
    }
    if let Err(error) =
        remap_settings_json_paths(&target_dir.join("settings.json"), legacy_dir, target_dir)
    {
        tracing::warn!(?error, "could not rewrite data paths in settings.json");
    }
    repair_worktrees(&target_dir.join("worktrees"));
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
    use super::*;

    fn write_db(dir: &Path, bytes: usize) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("db.sqlite"), vec![0u8; bytes]).unwrap();
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
}
