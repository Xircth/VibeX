//! Zero-index-pollution Git checkpoint refs (`refs/dimo/checkpoints/{conversation_id}/{turn_ordinal}`).
//!
//! Captures dirty working-tree edits plus untracked files before each turn using an
//! isolated temporary `GIT_INDEX_FILE` inside `<git_dir>/dimo-tmp-index-{uuid}`
//! (supporting both standard repositories and linked git worktrees where `.git` is
//! a gitfile). Never mutates `.git/index`, `HEAD`, or user branches.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use workspace_utils::process::new_hidden_tokio_command;

pub const CHECKPOINT_REF_PREFIX: &str = "refs/dimo/checkpoints";

#[derive(Debug, thiserror::Error)]
pub enum CheckpointRefError {
    #[error("`{0}` is not inside a Git worktree")]
    NotAGitRepository(PathBuf),

    #[error("Checkpoint ref `{0}` was not found")]
    CheckpointNotFound(String),

    #[error("Git command `git {args}` failed: {stderr}")]
    GitCommandFailed { args: String, stderr: String },

    #[error("I/O error during Git checkpoint operation: {0}")]
    Io(#[from] std::io::Error),
}

/// Handle to an immutable hidden Git commit stored under `refs/dimo/checkpoints/...`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRefHandle {
    pub conversation_id: Uuid,
    pub turn_ordinal: i32,
    pub ref_name: String,
    pub commit_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit_oid: Option<String>,
}

/// Summary of working-tree changes between current disk state and a checkpoint tree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSummary {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub restored_files: Vec<String>,
    pub removed_files: Vec<String>,
}

struct TempIndexGuard {
    path: PathBuf,
}

impl TempIndexGuard {
    fn new(git_dir: &Path) -> Self {
        Self {
            path: git_dir.join(format!("dimo-tmp-index-{}", Uuid::new_v4())),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempIndexGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Stateless service managing hidden Git checkpoint refs for multi-turn Rewind.
#[derive(Debug, Clone, Copy, Default)]
pub struct CheckpointRef;

impl CheckpointRef {
    pub const fn new() -> Self {
        Self
    }

    pub fn ref_name(conversation_id: Uuid, turn_ordinal: i32) -> String {
        format!("{CHECKPOINT_REF_PREFIX}/{conversation_id}/{turn_ordinal}")
    }

    /// Captures all tracked modifications, deletions, and non-ignored untracked files
    /// in `worktree` into `refs/dimo/checkpoints/{conversation_id}/{turn_ordinal}`
    /// without touching `.git/index` or `HEAD`.
    pub async fn capture(
        &self,
        worktree: &Path,
        conversation_id: Uuid,
        turn_ordinal: i32,
    ) -> Result<CheckpointRefHandle, CheckpointRefError> {
        let git_dir = resolve_git_dir(worktree).await?;
        let head_oid = try_rev_parse_head(worktree).await;

        let temp_index = TempIndexGuard::new(&git_dir);
        let idx = temp_index.path();

        if let Some(ref head) = head_oid {
            run_git(worktree, Some(idx), &["read-tree", head], &[]).await?;
        }

        run_git(worktree, Some(idx), &["add", "-A", "--", "."], &[]).await?;

        let tree_out = run_git(worktree, Some(idx), &["write-tree"], &[]).await?;
        let tree_oid = String::from_utf8_lossy(&tree_out).trim().to_string();

        let message = format!("dimo checkpoint {conversation_id} turn-{turn_ordinal}");
        let mut commit_args = vec!["commit-tree", tree_oid.as_str()];
        if let Some(ref head) = head_oid {
            commit_args.push("-p");
            commit_args.push(head.as_str());
        }
        commit_args.push("-m");
        commit_args.push(message.as_str());

        let commit_out = run_git(
            worktree,
            Some(idx),
            &commit_args,
            &[
                ("GIT_AUTHOR_NAME", "Dimo Checkpoint"),
                ("GIT_AUTHOR_EMAIL", "checkpoint@dimo.local"),
                ("GIT_COMMITTER_NAME", "Dimo Checkpoint"),
                ("GIT_COMMITTER_EMAIL", "checkpoint@dimo.local"),
            ],
        )
        .await?;
        let commit_oid = String::from_utf8_lossy(&commit_out).trim().to_string();

        let ref_name = Self::ref_name(conversation_id, turn_ordinal);
        run_git(
            worktree,
            None,
            &["update-ref", ref_name.as_str(), commit_oid.as_str()],
            &[],
        )
        .await?;

        Ok(CheckpointRefHandle {
            conversation_id,
            turn_ordinal,
            ref_name,
            commit_oid,
            head_commit_oid: head_oid,
        })
    }

    /// Computes a non-mutating diff summary between the current working tree and `handle`.
    pub async fn diff_summary(
        &self,
        worktree: &Path,
        handle: &CheckpointRefHandle,
    ) -> Result<GitDiffSummary, CheckpointRefError> {
        let git_dir = resolve_git_dir(worktree).await?;
        let target_commit = verify_checkpoint_commit(worktree, handle).await?;
        compute_diff_against_tree(worktree, &git_dir, &target_commit).await
    }

    /// Restores `worktree` files (both tracked and checkpointed untracked) to the exact
    /// tree recorded in `handle`, removing post-checkpoint non-ignored files while
    /// preserving `.gitignore`d artifacts (`node_modules`, `target`), `.git/index`,
    /// `HEAD`, and all other checkpoint refs.
    pub async fn restore(
        &self,
        worktree: &Path,
        handle: &CheckpointRefHandle,
    ) -> Result<GitDiffSummary, CheckpointRefError> {
        let git_dir = resolve_git_dir(worktree).await?;
        let target_commit = verify_checkpoint_commit(worktree, handle).await?;

        let mut summary = compute_diff_against_tree(worktree, &git_dir, &target_commit).await?;

        let target_paths = list_commit_paths(worktree, &target_commit).await?;
        let current_paths = list_worktree_non_ignored_paths(worktree).await?;

        let mut removed_files = Vec::new();
        for rel_path in current_paths {
            if !target_paths.contains(&rel_path) {
                let full_path = worktree.join(&rel_path);
                if full_path.is_file() || full_path.is_symlink() {
                    std::fs::remove_file(&full_path)?;
                    prune_empty_parent_dirs(&full_path, worktree);
                    removed_files.push(rel_path);
                }
            }
        }
        removed_files.sort();

        // Materialize every blob in `target_commit` into `worktree` via an isolated
        // temporary index so `.git/index` and `HEAD` remain completely untouched.
        let temp_index = TempIndexGuard::new(&git_dir);
        let idx = temp_index.path();
        run_git(worktree, Some(idx), &["read-tree", &target_commit], &[]).await?;
        run_git(worktree, Some(idx), &["checkout-index", "-a", "-f"], &[]).await?;

        let mut restored_files: Vec<String> = target_paths.into_iter().collect();
        restored_files.sort();
        summary.restored_files = restored_files;
        summary.removed_files = removed_files;

        Ok(summary)
    }

    /// Convenience helper resolving `refs/dimo/checkpoints/{conversation_id}/{turn_ordinal}`
    /// directly and restoring `worktree` to that checkpoint.
    pub async fn restore_by_ordinal(
        &self,
        worktree: &Path,
        conversation_id: Uuid,
        turn_ordinal: i32,
    ) -> Result<GitDiffSummary, CheckpointRefError> {
        let ref_name = Self::ref_name(conversation_id, turn_ordinal);
        let commit_oid = resolve_ref_commit(worktree, &ref_name).await?;
        let handle = CheckpointRefHandle {
            conversation_id,
            turn_ordinal,
            ref_name,
            commit_oid,
            head_commit_oid: None,
        };
        self.restore(worktree, &handle).await
    }

    /// Lists all recorded checkpoint handles for `conversation_id`, ordered by `turn_ordinal` ascending.
    pub async fn list_checkpoints(
        &self,
        worktree: &Path,
        conversation_id: Uuid,
    ) -> Result<Vec<CheckpointRefHandle>, CheckpointRefError> {
        let _ = resolve_git_dir(worktree).await?;
        let prefix = format!("{CHECKPOINT_REF_PREFIX}/{conversation_id}/");
        let out = run_git(
            worktree,
            None,
            &[
                "for-each-ref",
                "--format=%(refname)\t%(objectname)",
                prefix.as_str(),
            ],
            &[],
        )
        .await?;

        let mut handles = Vec::new();
        for line in String::from_utf8_lossy(&out).lines() {
            let Some((ref_name, oid)) = line.trim().split_once('\t') else {
                continue;
            };
            let Some(ordinal_str) = ref_name.strip_prefix(&prefix) else {
                continue;
            };
            let Ok(turn_ordinal) = ordinal_str.parse::<i32>() else {
                continue;
            };
            handles.push(CheckpointRefHandle {
                conversation_id,
                turn_ordinal,
                ref_name: ref_name.to_string(),
                commit_oid: oid.to_string(),
                head_commit_oid: None,
            });
        }
        handles.sort_by_key(|h| h.turn_ordinal);
        Ok(handles)
    }

    /// Prunes older checkpoint refs for `conversation_id`, keeping the newest `keep_recent`
    /// checkpoints by `turn_ordinal`. Returns the number of deleted refs.
    pub async fn prune(
        &self,
        worktree: &Path,
        conversation_id: Uuid,
        keep_recent: usize,
    ) -> Result<usize, CheckpointRefError> {
        let mut handles = self.list_checkpoints(worktree, conversation_id).await?;
        // Sort newest turn_ordinal first.
        handles.sort_by(|a, b| b.turn_ordinal.cmp(&a.turn_ordinal));

        if handles.len() <= keep_recent {
            return Ok(0);
        }

        let mut deleted = 0usize;
        for stale in handles.into_iter().skip(keep_recent) {
            run_git(worktree, None, &["update-ref", "-d", &stale.ref_name], &[]).await?;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// Deletes all checkpoint refs for `conversation_id` at or above `min_ordinal`
    /// when truncating or rewinding history.
    pub async fn delete_refs_from_ordinal(
        &self,
        worktree: &Path,
        conversation_id: Uuid,
        min_ordinal: i32,
    ) -> Result<usize, CheckpointRefError> {
        let handles = self.list_checkpoints(worktree, conversation_id).await?;
        let mut deleted = 0usize;
        for handle in handles {
            if handle.turn_ordinal >= min_ordinal {
                run_git(worktree, None, &["update-ref", "-d", &handle.ref_name], &[]).await?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }
}

async fn resolve_git_dir(worktree: &Path) -> Result<PathBuf, CheckpointRefError> {
    if !worktree.is_dir() {
        return Err(CheckpointRefError::NotAGitRepository(
            worktree.to_path_buf(),
        ));
    }

    let out = run_git(worktree, None, &["rev-parse", "--git-dir"], &[])
        .await
        .map_err(|_| CheckpointRefError::NotAGitRepository(worktree.to_path_buf()))?;
    let raw = String::from_utf8_lossy(&out).trim().to_string();
    if raw.is_empty() {
        return Err(CheckpointRefError::NotAGitRepository(
            worktree.to_path_buf(),
        ));
    }

    let candidate = PathBuf::from(&raw);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        worktree.join(candidate)
    };
    if !resolved.is_dir() {
        return Err(CheckpointRefError::NotAGitRepository(
            worktree.to_path_buf(),
        ));
    }
    Ok(resolved)
}

async fn try_rev_parse_head(worktree: &Path) -> Option<String> {
    let out = run_git(worktree, None, &["rev-parse", "--verify", "HEAD"], &[])
        .await
        .ok()?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    (!oid.is_empty()).then_some(oid)
}

async fn resolve_ref_commit(worktree: &Path, ref_name: &str) -> Result<String, CheckpointRefError> {
    let spec = format!("{ref_name}^{{commit}}");
    let out = run_git(worktree, None, &["rev-parse", "--verify", &spec], &[])
        .await
        .map_err(|_| CheckpointRefError::CheckpointNotFound(ref_name.to_string()))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

async fn verify_checkpoint_commit(
    worktree: &Path,
    handle: &CheckpointRefHandle,
) -> Result<String, CheckpointRefError> {
    if let Ok(oid) = resolve_ref_commit(worktree, &handle.ref_name).await {
        return Ok(oid);
    }
    if !handle.commit_oid.trim().is_empty() {
        let spec = format!("{}^{{commit}}", handle.commit_oid.trim());
        if let Ok(out) = run_git(worktree, None, &["rev-parse", "--verify", &spec], &[]).await {
            return Ok(String::from_utf8_lossy(&out).trim().to_string());
        }
    }
    Err(CheckpointRefError::CheckpointNotFound(
        handle.ref_name.clone(),
    ))
}

async fn compute_diff_against_tree(
    worktree: &Path,
    git_dir: &Path,
    target_commit: &str,
) -> Result<GitDiffSummary, CheckpointRefError> {
    let temp_index = TempIndexGuard::new(git_dir);
    let idx = temp_index.path();
    if let Some(head) = try_rev_parse_head(worktree).await {
        run_git(worktree, Some(idx), &["read-tree", &head], &[]).await?;
    }
    run_git(worktree, Some(idx), &["add", "-A", "--", "."], &[]).await?;
    let current_tree_out = run_git(worktree, Some(idx), &["write-tree"], &[]).await?;
    let current_tree = String::from_utf8_lossy(&current_tree_out)
        .trim()
        .to_string();

    let diff_out = run_git(
        worktree,
        None,
        &["diff-tree", "--numstat", "-r", &current_tree, target_commit],
        &[],
    )
    .await?;

    let mut files_changed = 0usize;
    let mut insertions = 0usize;
    let mut deletions = 0usize;
    for line in String::from_utf8_lossy(&diff_out).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            files_changed += 1;
            insertions += parts[0].parse::<usize>().unwrap_or(0);
            deletions += parts[1].parse::<usize>().unwrap_or(0);
        }
    }

    Ok(GitDiffSummary {
        files_changed,
        insertions,
        deletions,
        restored_files: Vec::new(),
        removed_files: Vec::new(),
    })
}

async fn list_commit_paths(
    worktree: &Path,
    commit_oid: &str,
) -> Result<HashSet<String>, CheckpointRefError> {
    let out = run_git(
        worktree,
        None,
        &["ls-tree", "-r", "-z", "--name-only", commit_oid],
        &[],
    )
    .await?;
    Ok(parse_nul_delimited_paths(&out))
}

async fn list_worktree_non_ignored_paths(
    worktree: &Path,
) -> Result<HashSet<String>, CheckpointRefError> {
    let tracked = run_git(worktree, None, &["ls-files", "-z"], &[]).await?;
    let untracked = run_git(
        worktree,
        None,
        &["ls-files", "-z", "--others", "--exclude-standard"],
        &[],
    )
    .await?;

    let mut combined = parse_nul_delimited_paths(&tracked);
    combined.extend(parse_nul_delimited_paths(&untracked));
    Ok(combined)
}

fn parse_nul_delimited_paths(raw: &[u8]) -> HashSet<String> {
    raw.split(|b| *b == 0)
        .filter(|slice| !slice.is_empty())
        .map(|slice| String::from_utf8_lossy(slice).into_owned())
        .collect()
}

fn prune_empty_parent_dirs(removed_file: &Path, stop_at: &Path) {
    let mut current = removed_file.parent();
    while let Some(dir) = current {
        if dir == stop_at || !dir.starts_with(stop_at) {
            break;
        }
        let is_empty = std::fs::read_dir(dir)
            .ok()
            .is_some_and(|mut entries| entries.next().is_none());
        if !is_empty || std::fs::remove_dir(dir).is_err() {
            break;
        }
        current = dir.parent();
    }
}

async fn run_git(
    worktree: &Path,
    git_index_file: Option<&Path>,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<Vec<u8>, CheckpointRefError> {
    let mut cmd = new_hidden_tokio_command(
        "git",
        ["-c", "core.quotepath=false", "-c", "core.autocrlf=false"],
    );
    cmd.args(args);
    cmd.current_dir(worktree);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index_path) = git_index_file {
        cmd.env("GIT_INDEX_FILE", index_path);
    }
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    let output = cmd.output().await?;
    if !output.status.success() {
        return Err(CheckpointRefError::GitCommandFailed {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("create tempdir");
        run_git(dir.path(), None, &["init"], &[])
            .await
            .expect("git init");
        run_git(dir.path(), None, &["config", "user.name", "Test User"], &[])
            .await
            .expect("git config user.name");
        run_git(
            dir.path(),
            None,
            &["config", "user.email", "test@example.com"],
            &[],
        )
        .await
        .expect("git config user.email");

        std::fs::write(dir.path().join(".gitignore"), "ignored_cache/\n").expect("write gitignore");
        std::fs::write(dir.path().join("tracked.txt"), "initial-v0\n").expect("write tracked.txt");
        run_git(dir.path(), None, &["add", "."], &[])
            .await
            .expect("git add initial");
        run_git(dir.path(), None, &["commit", "-m", "initial commit"], &[])
            .await
            .expect("git commit initial");
        dir
    }

    #[tokio::test]
    async fn five_uncommitted_turns_rewind_to_turn_2_without_losing_prior_turns_or_touching_index()
    {
        let repo = init_temp_repo().await;
        let root = repo.path();
        let checkpoints = CheckpointRef::new();
        let conversation_id = Uuid::new_v4();

        // Create an ignored build cache file to verify `.gitignore`d files survive rewind.
        let ignored_dir = root.join("ignored_cache");
        std::fs::create_dir_all(&ignored_dir).expect("create ignored_cache");
        std::fs::write(ignored_dir.join("artifact.bin"), b"keep-me").expect("write ignored file");

        let initial_head = try_rev_parse_head(root).await.expect("initial HEAD");
        let git_index_path = root.join(".git").join("index");
        let initial_index_bytes = std::fs::read(&git_index_path).expect("read initial .git/index");

        let mut handles = Vec::new();

        // Simulate 5 consecutive turns WITHOUT a single `git commit`.
        // Before each turn N (1..=5) has settled its state, we mutate tracked + untracked
        // files and capture checkpoint N.
        for turn in 1..=5 {
            std::fs::write(
                root.join("tracked.txt"),
                format!("tracked-at-turn-{turn}\n"),
            )
            .expect("update tracked.txt");
            std::fs::write(
                root.join(format!("untracked_turn_{turn}.txt")),
                format!("untracked-payload-{turn}\n"),
            )
            .expect("write untracked file");

            let handle = checkpoints
                .capture(root, conversation_id, turn)
                .await
                .expect("capture checkpoint");
            assert_eq!(handle.turn_ordinal, turn);
            handles.push(handle);

            // Verify `.git/index` and `HEAD` were NEVER mutated by `capture`!
            assert_eq!(
                try_rev_parse_head(root).await.as_deref(),
                Some(initial_head.as_str())
            );
            assert_eq!(
                std::fs::read(&git_index_path).expect("read .git/index"),
                initial_index_bytes,
                ".git/index must remain byte-for-byte untouched across captures"
            );
        }

        // Rewind to turn 2!
        let turn_2_handle = &handles[1];
        let summary = checkpoints
            .restore(root, turn_2_handle)
            .await
            .expect("restore turn 2");
        assert!(summary.files_changed >= 4);

        // Exact turn-2 tracked and untracked files must be intact (NOT wiped back to v0!).
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).expect("read tracked.txt"),
            "tracked-at-turn-2\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("untracked_turn_1.txt")).expect("read turn 1 file"),
            "untracked-payload-1\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("untracked_turn_2.txt")).expect("read turn 2 file"),
            "untracked-payload-2\n"
        );

        // Post-checkpoint untracked files from turns 3..=5 must be removed cleanly.
        for later_turn in 3..=5 {
            assert!(
                !root
                    .join(format!("untracked_turn_{later_turn}.txt"))
                    .exists(),
                "untracked_turn_{later_turn}.txt should be removed on rewind to turn 2"
            );
        }

        // Ignored artifacts (`node_modules` / `target` / `ignored_cache`) must remain intact.
        assert_eq!(
            std::fs::read(ignored_dir.join("artifact.bin")).expect("ignored file intact"),
            b"keep-me"
        );

        // `.git/index` and `HEAD` must STILL be untouched!
        assert_eq!(
            try_rev_parse_head(root).await.as_deref(),
            Some(initial_head.as_str())
        );
        assert_eq!(
            std::fs::read(&git_index_path).expect("read .git/index after restore"),
            initial_index_bytes
        );

        // Checkpoint refs for turns 3..=5 must still exist and remain restorable!
        let listed = checkpoints
            .list_checkpoints(root, conversation_id)
            .await
            .expect("list checkpoints");
        assert_eq!(listed.len(), 5);

        checkpoints
            .restore(root, &handles[4])
            .await
            .expect("restore forward to turn 5");
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).expect("read tracked at turn 5"),
            "tracked-at-turn-5\n"
        );
        assert!(root.join("untracked_turn_5.txt").is_file());

        // Pruning with `keep_recent = 2` keeps turns 4 and 5 and deletes turns 1..=3.
        let pruned = checkpoints
            .prune(root, conversation_id, 2)
            .await
            .expect("prune checkpoints");
        assert_eq!(pruned, 3);
        let remaining = checkpoints
            .list_checkpoints(root, conversation_id)
            .await
            .expect("list remaining");
        let remaining_ordinals: Vec<i32> = remaining.iter().map(|h| h.turn_ordinal).collect();
        assert_eq!(remaining_ordinals, vec![4, 5]);
    }

    #[tokio::test]
    async fn supports_linked_git_worktree_where_dot_git_is_a_file() {
        let main_repo = init_temp_repo().await;
        let linked_parent = tempfile::tempdir().expect("tempdir for linked worktree");
        let linked_path = linked_parent.path().join("linked-wt");

        run_git(
            main_repo.path(),
            None,
            &[
                "worktree",
                "add",
                "-b",
                "feature-wt",
                &linked_path.to_string_lossy(),
            ],
            &[],
        )
        .await
        .expect("git worktree add");

        assert!(
            linked_path.join(".git").is_file(),
            "linked worktree .git must be a gitfile, not a directory"
        );

        let checkpoints = CheckpointRef::new();
        let conv_id = Uuid::new_v4();
        std::fs::write(linked_path.join("wt_note.txt"), "worktree turn 1\n")
            .expect("write wt_note");
        let h1 = checkpoints
            .capture(&linked_path, conv_id, 1)
            .await
            .expect("capture in linked worktree");

        std::fs::write(linked_path.join("wt_note.txt"), "worktree turn 2\n")
            .expect("overwrite wt_note");
        checkpoints
            .restore(&linked_path, &h1)
            .await
            .expect("restore in linked worktree");
        assert_eq!(
            std::fs::read_to_string(linked_path.join("wt_note.txt")).expect("read wt_note"),
            "worktree turn 1\n"
        );
    }
}
