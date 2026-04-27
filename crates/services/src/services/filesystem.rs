#[cfg(not(feature = "qa-mode"))]
use std::collections::HashSet;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(not(feature = "qa-mode"))]
use ignore::WalkBuilder;
use serde::Serialize;
use thiserror::Error;
#[cfg(not(feature = "qa-mode"))]
use tokio_util::sync::CancellationToken;
use ts_rs::TS;
use utils::path::normalize_windows_extended_path_prefix;

#[derive(Clone)]
pub struct FilesystemService {}

#[derive(Debug, Error)]
pub enum FilesystemError {
    #[error("Directory does not exist")]
    DirectoryDoesNotExist,
    #[error("Path is not a directory")]
    PathIsNotDirectory,
    #[error("Failed to read directory: {0}")]
    Io(#[from] std::io::Error),
}
#[derive(Debug, Serialize, TS)]
pub struct DirectoryListResponse {
    pub entries: Vec<DirectoryEntry>,
    pub current_path: String,
}

#[derive(Debug, Serialize, TS)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_directory: bool,
    pub is_git_repo: bool,
    pub last_modified: Option<u64>,
}

impl Default for FilesystemService {
    fn default() -> Self {
        Self::new()
    }
}

impl FilesystemService {
    pub fn new() -> Self {
        FilesystemService {}
    }

    #[cfg(not(feature = "qa-mode"))]
    fn push_unique_directory(
        paths: &mut Vec<PathBuf>,
        seen: &mut HashSet<PathBuf>,
        path: Option<PathBuf>,
    ) {
        let Some(path) = path else {
            return;
        };

        let normalized = utils::path::normalize_macos_private_alias(&path);
        let canonical = normalized.canonicalize().unwrap_or(normalized);
        let canonical = normalize_windows_extended_path_prefix(canonical);

        if canonical.exists() && canonical.is_dir() && seen.insert(canonical.clone()) {
            paths.push(canonical);
        }
    }

    #[cfg(not(feature = "qa-mode"))]
    fn push_named_child_directories(
        paths: &mut Vec<PathBuf>,
        seen: &mut HashSet<PathBuf>,
        parent: Option<PathBuf>,
        child_names: &[&str],
    ) {
        let Some(parent) = parent else {
            return;
        };

        for child_name in child_names {
            Self::push_unique_directory(paths, seen, Some(parent.join(child_name)));
        }
    }

    #[cfg(not(feature = "qa-mode"))]
    fn get_directories_to_skip() -> HashSet<String> {
        let mut skip_dirs = HashSet::from(
            [
                "node_modules",
                "target",
                "build",
                "dist",
                ".next",
                ".nuxt",
                ".cache",
                ".npm",
                ".yarn",
                ".pnpm-store",
                "Library",
                "AppData",
                "Applications",
                ".git",
            ]
            .map(String::from),
        );

        [
            dirs::executable_dir(),
            dirs::data_dir(),
            dirs::download_dir(),
            dirs::picture_dir(),
            dirs::video_dir(),
            dirs::audio_dir(),
        ]
        .into_iter()
        .flatten()
        .filter_map(|path| path.file_name()?.to_str().map(String::from))
        .for_each(|name| {
            skip_dirs.insert(name);
        });

        skip_dirs
    }

    #[cfg_attr(feature = "qa-mode", allow(unused_variables))]
    pub async fn list_git_repos(
        &self,
        path: Option<String>,
        timeout_ms: u64,
        hard_timeout_ms: u64,
        max_depth: Option<usize>,
    ) -> Result<Vec<DirectoryEntry>, FilesystemError> {
        #[cfg(feature = "qa-mode")]
        {
            tracing::info!("QA mode: returning hardcoded QA repos instead of scanning filesystem");
            super::qa_repos::get_qa_repos()
        }

        #[cfg(not(feature = "qa-mode"))]
        {
            let base_path = path
                .map(PathBuf::from)
                .map(normalize_windows_extended_path_prefix)
                .unwrap_or_else(Self::get_home_directory);
            Self::verify_directory(&base_path)?;
            self.list_git_repos_with_timeout(
                vec![base_path],
                timeout_ms,
                hard_timeout_ms,
                max_depth,
            )
            .await
        }
    }

    #[cfg(not(feature = "qa-mode"))]
    async fn list_git_repos_with_timeout(
        &self,
        paths: Vec<PathBuf>,
        timeout_ms: u64,
        hard_timeout_ms: u64,
        max_depth: Option<usize>,
    ) -> Result<Vec<DirectoryEntry>, FilesystemError> {
        let cancel_token = CancellationToken::new();
        let cancel_after_delay = cancel_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(timeout_ms)).await;
            cancel_after_delay.cancel();
        });
        let service = self.clone();
        let cancel_for_scan = cancel_token.clone();
        let mut scan_handle = tokio::spawn(async move {
            service
                .list_git_repos_inner(paths, max_depth, Some(&cancel_for_scan))
                .await
        });

        let hard_timeout = tokio::time::sleep(std::time::Duration::from_millis(hard_timeout_ms));
        tokio::pin!(hard_timeout);

        tokio::select! {
            res = &mut scan_handle => {
                match res {
                    Ok(Ok(repos)) => Ok(repos),
                    Ok(Err(err)) => Err(err),
                    Err(join_err) => Err(FilesystemError::Io(
                        std::io::Error::other(join_err.to_string())))
                }
                }
            _ = &mut hard_timeout => {
                scan_handle.abort();
                tracing::warn!("list_git_repos_with_timeout: hard timeout reached after {}ms", hard_timeout_ms);
                Err(FilesystemError::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Operation forcibly terminated due to hard timeout",
                )))
            }
        }
    }

    #[cfg_attr(feature = "qa-mode", allow(unused_variables))]
    pub async fn list_common_git_repos(
        &self,
        timeout_ms: u64,
        hard_timeout_ms: u64,
        max_depth: Option<usize>,
    ) -> Result<Vec<DirectoryEntry>, FilesystemError> {
        #[cfg(feature = "qa-mode")]
        {
            tracing::info!(
                "QA mode: returning hardcoded QA repos instead of scanning common directories"
            );
            super::qa_repos::get_qa_repos()
        }

        #[cfg(not(feature = "qa-mode"))]
        {
            let home_dir = Self::get_home_directory();
            let search_strings = ["repos", "dev", "work", "code", "projects", "source"];
            let current_dir = std::env::current_dir().ok();
            let document_dir = dirs::document_dir();
            let desktop_dir = dirs::desktop_dir();
            let download_dir = dirs::download_dir();
            let mut paths = Vec::new();
            let mut seen = HashSet::new();

            for base_dir in [
                current_dir.clone(),
                document_dir.clone(),
                desktop_dir.clone(),
                download_dir.clone(),
                Some(home_dir.clone()),
            ] {
                Self::push_named_child_directories(
                    &mut paths,
                    &mut seen,
                    base_dir,
                    &search_strings,
                );
            }

            Self::push_unique_directory(&mut paths, &mut seen, current_dir);
            Self::push_unique_directory(&mut paths, &mut seen, document_dir);
            Self::push_unique_directory(&mut paths, &mut seen, desktop_dir);
            Self::push_unique_directory(&mut paths, &mut seen, download_dir);
            Self::push_unique_directory(&mut paths, &mut seen, Some(home_dir));

            self.list_git_repos_with_timeout(paths, timeout_ms, hard_timeout_ms, max_depth)
                .await
        }
    }

    #[cfg(not(feature = "qa-mode"))]
    fn scan_git_repos_under_root(
        root: &Path,
        max_depth: Option<usize>,
        cancel: Option<&CancellationToken>,
        skip_dirs: &HashSet<String>,
        vibe_ultra_temp_dir: &Path,
        seen_repo_paths: &mut HashSet<PathBuf>,
    ) -> Vec<DirectoryEntry> {
        let mut walker_builder = WalkBuilder::new(root);
        walker_builder
            .follow_links(false)
            .hidden(true)
            .git_ignore(true)
            .git_exclude(true)
            .filter_entry({
                let cancel = cancel.cloned();
                let vibe_ultra_temp_dir = vibe_ultra_temp_dir.to_path_buf();
                let skip_dirs = skip_dirs.clone();
                move |entry| {
                    if let Some(token) = cancel.as_ref()
                        && token.is_cancelled()
                    {
                        tracing::debug!("Cancellation token triggered");
                        return false;
                    }

                    let path = entry.path();
                    if !path.is_dir() {
                        return false;
                    }

                    if utils::path::normalize_macos_private_alias(path)
                        .starts_with(&vibe_ultra_temp_dir)
                    {
                        return false;
                    }

                    if let Some(name) = path.file_name().and_then(|n| n.to_str())
                        && skip_dirs.contains(name)
                    {
                        return false;
                    }

                    true
                }
            })
            .max_depth(max_depth);

        walker_builder
            .build()
            .filter_map(|entry| {
                let entry = entry.ok()?;
                if cancel.is_some_and(|token| token.is_cancelled()) {
                    return None;
                }

                let path = entry.path();
                if !path.join(".git").exists() {
                    return None;
                }

                let repo = git2::Repository::open(path).ok()?;
                let workdir = repo.workdir()?;
                let normalized_path = utils::path::normalize_macos_private_alias(workdir);
                let canonical_path = normalized_path.canonicalize().unwrap_or(normalized_path);
                let canonical_path = normalize_windows_extended_path_prefix(canonical_path);
                let name = canonical_path.file_name()?.to_str()?;
                if !seen_repo_paths.insert(canonical_path.clone()) {
                    return None;
                }

                let last_modified = fs::metadata(&canonical_path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.elapsed().unwrap_or_default().as_secs());

                Some(DirectoryEntry {
                    name: name.to_string(),
                    path: canonical_path,
                    is_directory: true,
                    is_git_repo: true,
                    last_modified,
                })
            })
            .collect()
    }

    #[cfg(not(feature = "qa-mode"))]
    async fn list_git_repos_inner(
        &self,
        paths: Vec<PathBuf>,
        max_depth: Option<usize>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<DirectoryEntry>, FilesystemError> {
        let skip_dirs = Self::get_directories_to_skip();
        let vibe_ultra_temp_dir = utils::path::get_vibe_ultra_temp_dir();
        let mut seen_repo_paths = HashSet::new();
        let mut git_repos = Vec::new();

        for root in paths {
            if cancel.is_some_and(|token| token.is_cancelled()) {
                break;
            }

            if !root.exists() || !root.is_dir() {
                continue;
            }

            git_repos.extend(Self::scan_git_repos_under_root(
                &root,
                max_depth,
                cancel,
                &skip_dirs,
                &vibe_ultra_temp_dir,
                &mut seen_repo_paths,
            ));
        }

        git_repos.sort_by_key(|entry| entry.last_modified.unwrap_or(0));
        Ok(git_repos)
    }

    fn get_home_directory() -> PathBuf {
        dirs::home_dir()
            .or_else(dirs::desktop_dir)
            .or_else(dirs::document_dir)
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    std::env::var("USERPROFILE")
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| PathBuf::from("C:\\"))
                } else {
                    PathBuf::from("/")
                }
            })
    }

    fn verify_directory(path: &Path) -> Result<(), FilesystemError> {
        if !path.exists() {
            return Err(FilesystemError::DirectoryDoesNotExist);
        }
        if !path.is_dir() {
            return Err(FilesystemError::PathIsNotDirectory);
        }
        Ok(())
    }

    pub async fn list_directory(
        &self,
        path: Option<String>,
    ) -> Result<DirectoryListResponse, FilesystemError> {
        let path = path
            .map(PathBuf::from)
            .map(normalize_windows_extended_path_prefix)
            .unwrap_or_else(Self::get_home_directory);
        Self::verify_directory(&path)?;

        let entries = fs::read_dir(&path)?;
        let mut directory_entries = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            let metadata = entry.metadata().ok();
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                // Skip hidden files/directories
                if name.starts_with('.') && name != ".." {
                    continue;
                }

                let is_directory = metadata.is_some_and(|m| m.is_dir());
                let is_git_repo = if is_directory {
                    path.join(".git").exists()
                } else {
                    false
                };

                directory_entries.push(DirectoryEntry {
                    name: name.to_string(),
                    path: normalize_windows_extended_path_prefix(path),
                    is_directory,
                    is_git_repo,
                    last_modified: None,
                });
            }
        }
        // Sort: directories first, then files, both alphabetically
        directory_entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(DirectoryListResponse {
            entries: directory_entries,
            current_path: normalize_windows_extended_path_prefix(path)
                .to_string_lossy()
                .to_string(),
        })
    }
}
