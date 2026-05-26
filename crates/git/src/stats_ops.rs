use std::{collections::HashMap, path::Path};

use chrono::{DateTime, Utc};
use git2::Sort;

use crate::{FileStat, GitService, GitServiceError};

impl GitService {
    /// Collect file statistics from recent commits for ranking purposes.
    pub fn collect_recent_file_stats(
        &self,
        repo_path: &Path,
        commit_limit: usize,
    ) -> Result<HashMap<String, FileStat>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut stats: HashMap<String, FileStat> = HashMap::new();

        let mut revwalk = repo.revwalk()?;
        revwalk.push_head()?;
        revwalk.set_sorting(Sort::TIME)?;

        for (commit_index, oid_result) in revwalk.take(commit_limit).enumerate() {
            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;
            let commit_time = {
                let time = commit.time();
                DateTime::from_timestamp(time.seconds(), 0).unwrap_or_else(Utc::now)
            };

            let commit_tree = commit.tree()?;
            let parent_tree = if commit.parent_count() == 0 {
                None
            } else {
                Some(commit.parent(0)?.tree()?)
            };
            let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;

            diff.foreach(
                &mut |delta, _progress| {
                    if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path())
                    {
                        let path_str = path.to_string_lossy().to_string();
                        let stat = stats.entry(path_str).or_insert(FileStat {
                            last_index: commit_index,
                            commit_count: 0,
                            last_time: commit_time,
                        });
                        stat.commit_count += 1;

                        if commit_index < stat.last_index {
                            stat.last_index = commit_index;
                            stat.last_time = commit_time;
                        }
                    }

                    true
                },
                None,
                None,
                None,
            )?;
        }

        Ok(stats)
    }
}
