use std::path::Path;

use crate::{ConflictOp, GitCli, GitService, GitServiceError};

impl GitService {
    /// Return true if a rebase is currently in progress in this worktree.
    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let git = GitCli::new();
        git.is_rebase_in_progress(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase state check failed: {e}"))
        })
    }

    pub fn detect_conflict_op(
        &self,
        worktree_path: &Path,
    ) -> Result<Option<ConflictOp>, GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Rebase));
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Merge));
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return Ok(Some(ConflictOp::CherryPick));
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Revert));
        }
        Ok(None)
    }

    /// List conflicted (unmerged) files in the worktree.
    pub fn get_conflicted_files(
        &self,
        worktree_path: &Path,
    ) -> Result<Vec<String>, GitServiceError> {
        let git = GitCli::new();
        git.get_conflicted_files(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git diff for conflicts failed: {e}"))
        })
    }

    /// Abort an in-progress rebase in this worktree (no-op if none).
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.abort_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --abort failed: {e}"))
        })
    }

    /// Continue an in-progress rebase. Fails if there are unresolved conflicts.
    pub fn continue_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.continue_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --continue failed: {e}"))
        })
    }

    pub fn abort_conflicts(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            let has_conflicts = !self
                .get_conflicted_files(worktree_path)
                .unwrap_or_default()
                .is_empty();
            if has_conflicts {
                return self.abort_rebase(worktree_path);
            }
            return git.quit_rebase(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git rebase --quit failed: {e}"))
            });
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_merge(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git merge --abort failed: {e}"))
            });
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return git.abort_cherry_pick(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git cherry-pick --abort failed: {e}"))
            });
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_revert(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git revert --abort failed: {e}"))
            });
        }
        Ok(())
    }

    pub fn continue_conflicts(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        match self.detect_conflict_op(worktree_path)? {
            Some(ConflictOp::Rebase) => self.continue_rebase(worktree_path),
            Some(ConflictOp::Merge) => git.continue_merge(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git merge --continue failed: {e}"))
            }),
            Some(ConflictOp::CherryPick) => git.continue_cherry_pick(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!(
                    "git cherry-pick --continue failed: {e}"
                ))
            }),
            Some(ConflictOp::Revert) => git.continue_revert(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git revert --continue failed: {e}"))
            }),
            None => Ok(()),
        }
    }

    pub fn get_conflict_file_detail(
        &self,
        worktree_path: &Path,
        file_path: &str,
    ) -> Result<crate::ConflictFileDetail, GitServiceError> {
        let git = GitCli::new();
        let conflicted = self.get_conflicted_files(worktree_path)?;
        let is_resolved = !conflicted.iter().any(|path| path == file_path);
        let base = stage_content(&git, worktree_path, file_path, 1)?;
        let ours = stage_content(&git, worktree_path, file_path, 2)?;
        let theirs = stage_content(&git, worktree_path, file_path, 3)?;
        let worktree_file = worktree_path.join(file_path);
        let (result, is_binary) = match std::fs::read(&worktree_file) {
            Ok(bytes) if bytes.contains(&0) => (String::new(), true),
            Ok(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), false),
            Err(_) => (String::new(), false),
        };
        let hunks = if is_binary {
            Vec::new()
        } else {
            parse_conflict_hunks(&result)
        };
        Ok(crate::ConflictFileDetail {
            path: file_path.to_string(),
            base,
            ours,
            theirs,
            result,
            hunks,
            is_binary,
            is_resolved,
        })
    }

    pub fn write_conflict_resolution(
        &self,
        worktree_path: &Path,
        file_path: &str,
        content: &str,
    ) -> Result<crate::WriteConflictResolutionResult, GitServiceError> {
        let target = worktree_path.join(file_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, content)?;
        let git = GitCli::new();
        git.stage_file(worktree_path, file_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git add failed for {file_path}: {e}"))
        })?;
        let still_conflicted = self
            .get_conflicted_files(worktree_path)?
            .iter()
            .any(|path| path == file_path);
        Ok(crate::WriteConflictResolutionResult {
            path: file_path.to_string(),
            is_resolved: !still_conflicted,
        })
    }
}

fn stage_content(
    git: &GitCli,
    worktree_path: &Path,
    file_path: &str,
    stage: u8,
) -> Result<crate::ConflictStageContent, GitServiceError> {
    match git.show_index_stage(worktree_path, file_path, stage) {
        Ok(Some(content)) => Ok(crate::ConflictStageContent {
            present: true,
            content: Some(content),
        }),
        Ok(None) => Ok(crate::ConflictStageContent {
            present: false,
            content: None,
        }),
        Err(error) => Err(GitServiceError::InvalidRepository(format!(
            "reading index stage {stage} for {file_path} failed: {error}"
        ))),
    }
}

fn parse_conflict_hunks(result: &str) -> Vec<crate::ConflictHunk> {
    let mut hunks = Vec::new();
    let mut ours = Vec::new();
    let mut theirs = Vec::new();
    let mut state = HunkParse::Plain;
    for line in result.lines() {
        if line.starts_with("<<<<<<<") {
            state = HunkParse::Ours;
            ours.clear();
            theirs.clear();
            continue;
        }
        if line.starts_with("=======") && matches!(state, HunkParse::Ours) {
            state = HunkParse::Theirs;
            continue;
        }
        if line.starts_with(">>>>>>>") && matches!(state, HunkParse::Theirs) {
            hunks.push(crate::ConflictHunk {
                index: hunks.len() as u32,
                ours: ours.join("\n"),
                theirs: theirs.join("\n"),
            });
            state = HunkParse::Plain;
            continue;
        }
        match state {
            HunkParse::Ours => ours.push(line.to_string()),
            HunkParse::Theirs => theirs.push(line.to_string()),
            HunkParse::Plain => {}
        }
    }
    hunks
}

enum HunkParse {
    Plain,
    Ours,
    Theirs,
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use tempfile::TempDir;

    use super::*;
    use crate::{ConflictOp, GitService};

    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_conflict_repo() -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_path_buf();
        git(&path, &["init"]);
        git(&path, &["config", "user.email", "test@example.com"]);
        git(&path, &["config", "user.name", "Test"]);
        fs::write(path.join("file.txt"), "base\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "-m", "base"]);
        git(&path, &["checkout", "-b", "theirs"]);
        fs::write(path.join("file.txt"), "theirs\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "-m", "theirs"]);
        git(&path, &["checkout", "-"]);
        fs::write(path.join("file.txt"), "ours\n").unwrap();
        git(&path, &["add", "file.txt"]);
        git(&path, &["commit", "-m", "ours"]);
        let _ = Command::new("git")
            .args(["merge", "theirs"])
            .current_dir(&path)
            .status();
        (tmp, path)
    }

    #[test]
    fn parse_conflict_hunks_extracts_both_sides() {
        let hunks = parse_conflict_hunks(
            "keep\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> theirs\nend\n",
        );
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].ours, "ours");
        assert_eq!(hunks[0].theirs, "theirs");
    }

    #[test]
    fn missing_stage_is_absent_not_empty() {
        let service = GitService::new();
        let (_tmp, path) = init_conflict_repo();
        let detail = service.get_conflict_file_detail(&path, "file.txt").unwrap();
        assert!(detail.base.present);
        assert!(detail.ours.present);
        assert!(detail.theirs.present);
        assert!(!detail.is_resolved);
        assert_eq!(detail.hunks.len(), 1);
    }

    #[test]
    fn write_marks_resolved_without_continuing() {
        let service = GitService::new();
        let (_tmp, path) = init_conflict_repo();
        let result = service
            .write_conflict_resolution(&path, "file.txt", "resolved\n")
            .unwrap();
        assert!(result.is_resolved);
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "resolved\n"
        );
        assert_eq!(
            service.detect_conflict_op(&path).unwrap(),
            Some(ConflictOp::Merge)
        );
    }

    #[test]
    fn continue_covers_merge() {
        let service = GitService::new();
        let (_tmp, path) = init_conflict_repo();
        service
            .write_conflict_resolution(&path, "file.txt", "resolved\n")
            .unwrap();
        service.continue_conflicts(&path).unwrap();
        assert_eq!(service.detect_conflict_op(&path).unwrap(), None);
    }
}
