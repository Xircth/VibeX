mod branch_metadata_ops;
mod branch_query_ops;
mod branch_workflow_ops;
mod cli;
mod conflict_ops;
mod diff_ops;
mod init_ops;
mod panel_ops;
mod remote_ops;
mod stats_ops;
mod types;
mod validation;
mod worktree_ops;

pub use cli::{GitCli, GitCliError, StatusEntry, WorktreeStatus};
pub use types::*;
pub use utils::path::ALWAYS_SKIP_DIRS;
pub use validation::is_valid_branch_prefix;

use std::sync::Once;

static OWNER_VALIDATION_INIT: Once = Once::new();

/// Disable libgit2's repository ownership validation.
///
/// On Windows the owner recorded on a user-created directory can differ from the
/// running process token (elevation, copied/moved folders, network shares), so
/// libgit2 rejects the user's own repositories with `class=Config; code=Owner`.
/// The CLI path already trusts these repos via `-c safe.directory=<path>`; this
/// mirrors that for the libgit2 path. Runs once, ahead of any git operation.
fn ensure_libgit2_owner_validation_disabled() {
    OWNER_VALIDATION_INIT.call_once(|| {
        // SAFETY: libgit2 global options must be set before concurrent git use;
        // `Once` guarantees a single call before the first GitService git op.
        unsafe {
            let _ = git2::opts::set_verify_owner_validation(false);
        }
    });
}

/// Service for managing Git operations in task execution workflows
#[derive(Clone)]
pub struct GitService {}

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}

impl GitService {
    fn summarize_cli_failure(output: &str) -> String {
        output
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with("--- "))
            .unwrap_or("Command failed with no output")
            .to_string()
    }

    fn looks_like_conflict_text(output: &str) -> bool {
        let lowered = output.to_lowercase();
        output.contains("CONFLICT")
            || output.contains("Automatic merge failed")
            || output.contains("could not apply")
            || lowered.contains("resolve all conflicts")
            || lowered.contains("merge conflict")
    }

    /// Create a new GitService for the given repository path
    pub fn new() -> Self {
        ensure_libgit2_owner_validation_disabled();
        Self {}
    }

    pub fn is_branch_name_valid(&self, name: &str) -> bool {
        git2::Branch::name_is_valid(name).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn detailed_status_expands_untracked_directories_with_line_stats() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let service = GitService::new();
        service
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        std::fs::create_dir_all(repo_path.join("backend").join("routes")).unwrap();
        std::fs::create_dir_all(repo_path.join("frontend-react").join("src")).unwrap();
        std::fs::write(
            repo_path
                .join("backend")
                .join("routes")
                .join("contracts.js"),
            "one\ntwo\n",
        )
        .unwrap();
        std::fs::write(
            repo_path.join("frontend-react").join("src").join("App.jsx"),
            "three\n",
        )
        .unwrap();

        let status = service.get_detailed_status(&repo_path).unwrap();
        let paths = status
            .unstaged_files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(status.unstaged_files.len(), 2);
        assert!(paths.contains(&"backend/routes/contracts.js"));
        assert!(paths.contains(&"frontend-react/src/App.jsx"));
        assert_eq!(status.total_additions, 3);
        assert_eq!(status.total_deletions, 0);
        assert!(status.unstaged_files.iter().all(|file| file.status == "?"));
    }
}
