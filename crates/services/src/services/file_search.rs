use std::path::Path;

use db::models::project::{SearchMatchType, SearchResult};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    TaskForm,
    Settings,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default)]
    pub mode: SearchMode,
}

#[derive(Clone, Default)]
pub struct FileSearchService;

impl FileSearchService {
    pub fn new() -> Self {
        Self
    }

    pub async fn search_repo(
        &self,
        repo_path: &Path,
        query: &str,
        mode: SearchMode,
    ) -> Result<Vec<SearchResult>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        if !repo_path.exists() {
            return Err(format!("Path not found: {}", repo_path.display()));
        }

        let repo_path = repo_path.to_path_buf();
        let query = query.to_string();
        tokio::task::spawn_blocking(move || search_repo_blocking(&repo_path, &query, mode))
            .await
            .map_err(|error| error.to_string())?
    }
}

fn search_repo_blocking(
    repo_path: &Path,
    query: &str,
    mode: SearchMode,
) -> Result<Vec<SearchResult>, String> {
    let query_lower = query.to_lowercase();
    let walker = match mode {
        SearchMode::Settings => WalkBuilder::new(repo_path)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .hidden(false)
            .filter_entry(|entry| {
                !matches!(
                    entry.file_name().to_string_lossy().as_ref(),
                    ".git" | "node_modules" | "target" | "dist" | "build"
                )
            })
            .build(),
        SearchMode::TaskForm => WalkBuilder::new(repo_path)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .hidden(false)
            .filter_entry(|entry| entry.file_name() != ".git")
            .build(),
    };

    let mut results = Vec::new();
    for entry in walker {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path == repo_path {
            continue;
        }
        let relative = path
            .strip_prefix(repo_path)
            .map_err(|error| error.to_string())?;
        let relative_lower = relative.to_string_lossy().to_lowercase();
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        let match_type = if file_name.contains(&query_lower) {
            SearchMatchType::FileName
        } else if path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name.to_string_lossy().to_lowercase().contains(&query_lower))
        {
            SearchMatchType::DirectoryName
        } else if relative_lower.contains(&query_lower) {
            SearchMatchType::FullPath
        } else {
            continue;
        };
        let score = match match_type {
            SearchMatchType::FileName => 100,
            SearchMatchType::DirectoryName => 10,
            SearchMatchType::FullPath => 1,
        };
        results.push(SearchResult {
            // Repo-relative paths cross into the UI beside git and diff paths,
            // which are always forward-slashed, so normalize the Windows
            // separator here rather than leaving the two styles to be compared.
            path: relative.to_string_lossy().replace('\\', "/"),
            is_file: path.is_file(),
            match_type,
            score,
        });
    }

    results.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    results.truncate(10);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{FileSearchService, SearchMode};

    #[tokio::test]
    async fn search_reads_the_current_filesystem_state() {
        let repo = tempfile::tempdir().expect("temp repo");
        std::fs::create_dir(repo.path().join("src")).expect("src directory");
        std::fs::write(repo.path().join("src/main.rs"), "fn main() {}").expect("source file");

        let service = FileSearchService::new();
        let results = service
            .search_repo(repo.path(), "main", SearchMode::TaskForm)
            .await
            .expect("search");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/main.rs");
    }
}
