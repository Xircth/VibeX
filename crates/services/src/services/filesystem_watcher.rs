use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use futures::{
    SinkExt, StreamExt,
    channel::mpsc::{Receiver, channel},
};
use ignore::{
    WalkBuilder,
    gitignore::{Gitignore, GitignoreBuilder},
};
use notify::{
    RecommendedWatcher, RecursiveMode,
    event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode},
};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};
use thiserror::Error;
use utils::path::ALWAYS_SKIP_DIRS;

pub type WatcherComponents = (
    Arc<Mutex<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    Receiver<DebounceEventResult>,
    PathBuf,
);

#[derive(Debug, Error)]
pub enum FilesystemWatcherError {
    #[error(transparent)]
    Notify(#[from] notify::Error),
    #[error(transparent)]
    Ignore(#[from] ignore::Error),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("Failed to build gitignore: {0}")]
    GitignoreBuilder(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn should_skip_dir(name: &str) -> bool {
    ALWAYS_SKIP_DIRS.contains(&name)
}

/// Check if the platform supports efficient native recursive watching.
/// macOS (FSEvents) and Windows (ReadDirectoryChangesW) support recursive watching natively.
/// Linux (inotify) does not - it requires a watch descriptor per directory.
fn platform_supports_native_recursive() -> bool {
    cfg!(target_os = "macos") || cfg!(target_os = "windows")
}

fn build_gitignore_set(root: &Path) -> Result<Gitignore, FilesystemWatcherError> {
    let mut builder = GitignoreBuilder::new(root);

    // Walk once to collect all .gitignore files under root
    // Use git_ignore(true) to avoid walking into gitignored directories
    WalkBuilder::new(root)
        .follow_links(false)
        .hidden(false) // we *want* to see .gitignore
        .git_ignore(true) // Respect gitignore to skip heavy directories
        .filter_entry(|entry| {
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            // Skip .git directory
            if is_dir
                && let Some(name) = entry.file_name().to_str()
                && should_skip_dir(name)
            {
                return false;
            }

            // only recurse into directories and .gitignore files
            is_dir
                || entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name == ".gitignore")
        })
        .build()
        .try_for_each(|result| {
            // everything that is not a directory and is named .gitignore
            match result {
                Ok(dir_entry) => {
                    if !dir_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                        builder.add(dir_entry.path());
                    }
                    Ok(())
                }
                Err(err)
                    if err.io_error().is_some_and(|io_err| {
                        io_err.kind() == std::io::ErrorKind::PermissionDenied
                    }) =>
                {
                    // Skip entries we don't have permission to read
                    tracing::warn!("Permission denied reading path: {}", err);
                    Ok(())
                }
                Err(e) => Err(FilesystemWatcherError::Ignore(e)),
            }
        })?;

    // Optionally include repo-local excludes
    let info_exclude = root.join(".git/info/exclude");
    if info_exclude.exists() {
        builder.add(info_exclude);
    }

    Ok(builder.build()?)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathKindHint {
    File,
    Directory,
}

impl PathKindHint {
    fn is_dir(self) -> bool {
        matches!(self, Self::Directory)
    }
}

fn path_kind_hint(kind: &EventKind) -> Option<PathKindHint> {
    match kind {
        EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File) => {
            Some(PathKindHint::File)
        }
        EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder) => {
            Some(PathKindHint::Directory)
        }
        _ => None,
    }
}

fn path_allowed(
    path: &Path,
    gi: &Gitignore,
    canonical_root: &Path,
    kind_hint: Option<PathKindHint>,
) -> bool {
    let canonical_path = canonicalize_lossy(path);

    // Convert absolute path to relative path from the gitignore root
    let relative_path = match canonical_path.strip_prefix(canonical_root) {
        Ok(rel_path) => rel_path,
        Err(_) => {
            // Path is outside the watched root, don't ignore it
            return true;
        }
    };

    // Check if path is inside any of the always-skip directories
    if let Some(parent) = relative_path.parent() {
        for component in parent.components() {
            if let std::path::Component::Normal(name) = component
                && let Some(name_str) = name.to_str()
                && should_skip_dir(name_str)
            {
                return false;
            }
        }
    }

    let is_dir = if let Ok(metadata) = std::fs::metadata(&canonical_path) {
        metadata.is_dir()
    } else {
        kind_hint
            .map(PathKindHint::is_dir)
            .unwrap_or_else(|| relative_path.extension().is_none())
    };
    let matched = gi.matched_path_or_any_parents(relative_path, is_dir);

    !matched.is_ignore()
}

fn debounced_should_forward(event: &DebouncedEvent, gi: &Gitignore, canonical_root: &Path) -> bool {
    // DebouncedEvent is a struct that wraps the underlying notify::Event
    if event.kind.is_access() {
        // Ignore access events
        return false;
    }
    let kind_hint = path_kind_hint(&event.kind);

    // We can check its paths field to determine if the event should be forwarded
    event
        .paths
        .iter()
        .all(|path| path_allowed(path, gi, canonical_root, kind_hint))
}

/// How many created files one change batch reports. A batch that lands a whole
/// directory tree should not hand the UI a tab per file.
pub const MAX_ADDED_PATHS: usize = 8;

/// Root-relative, forward-slashed paths of the files created in this batch,
/// capped at `max`. The flag reports whether the cap dropped entries, so a
/// caller can tell "that was all of them" from "there were more".
///
/// Paths are relative because the watcher's root is a canonicalized directory
/// while the UI joins paths onto the root it is displaying; the two need not
/// spell the same directory the same way.
pub fn collect_added_paths(
    events: &[DebouncedEvent],
    canonical_root: &Path,
    max: usize,
) -> (Vec<String>, bool) {
    let mut added: Vec<String> = Vec::new();

    for path in events
        .iter()
        .filter(|event| brings_a_path_into_existence(&event.kind))
        .flat_map(|event| event.paths.iter())
    {
        // A path that is not a file right now is a directory, or is already
        // gone — either way there is nothing to preview. This also discards the
        // source of a rename, which no longer exists at the path it came from.
        if !path.is_file() {
            continue;
        }

        let canonical_path = canonicalize_lossy(path);
        let Ok(relative) = canonical_path.strip_prefix(canonical_root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if relative.is_empty() || added.iter().any(|existing| existing == &relative) {
            continue;
        }

        added.push(relative);
    }

    let truncated = added.len() > max;
    added.truncate(max);

    (added, truncated)
}

/// Whether an event can bring a path into existence.
///
/// A rename counts: saving through a temporary file and renaming it into place
/// reports a rename rather than a create, and the file that appears is just as
/// new as one written in place.
fn brings_a_path_into_existence(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

/// Represents a directory to watch with its recursive mode.
#[derive(Debug, Clone)]
struct WatchTarget {
    path: PathBuf,
    recursive: RecursiveMode,
}

#[derive(Default)]
struct WatchedDirs {
    all: HashSet<PathBuf>,
    recursive: HashSet<PathBuf>,
}

impl WatchedDirs {
    fn contains(&self, path: &Path) -> bool {
        self.all.contains(path)
    }

    fn has_recursive_cover(&self, path: &Path) -> bool {
        self.recursive
            .iter()
            .any(|ancestor| ancestor != path && path.starts_with(ancestor))
    }

    fn insert(&mut self, path: PathBuf, mode: RecursiveMode) {
        if matches!(mode, RecursiveMode::Recursive) {
            self.recursive.insert(path.clone());
        } else {
            self.recursive.remove(&path);
        }
        self.all.insert(path);
    }

    fn remove_dir_and_children<F>(&mut self, prefix: &Path, f: F)
    where
        F: FnMut(&Path),
    {
        self.remove_with_prefix(prefix, true, f);
    }

    fn remove_children_only<F>(&mut self, prefix: &Path, f: F)
    where
        F: FnMut(&Path),
    {
        self.remove_with_prefix(prefix, false, f);
    }

    fn remove_with_prefix<F>(&mut self, prefix: &Path, include_prefix: bool, mut f: F)
    where
        F: FnMut(&Path),
    {
        let to_remove: Vec<PathBuf> = self
            .all
            .iter()
            .filter(|path| path.starts_with(prefix) && (include_prefix || *path != prefix))
            .cloned()
            .collect();

        for path in to_remove {
            self.all.remove(&path);
            self.recursive.remove(&path);
            f(&path);
        }
    }
}

/// Check if a directory or any of its descendants has gitignored directories.
/// Used on macOS/Windows to determine if we can watch recursively.
///
/// This checks recursively to ensure we don't use Recursive mode on a directory
/// that has gitignored descendants (e.g., packages/app1/node_modules).
fn has_ignored_descendants(
    dir: &Path,
    gi: &Gitignore,
    canonical_root: &Path,
    allowed_dirs: &std::collections::HashSet<PathBuf>,
    cache: &mut HashMap<PathBuf, bool>,
) -> bool {
    let key = dir.to_path_buf();
    if let Some(&cached) = cache.get(&key) {
        return cached;
    }

    // Read immediate children
    let result = (|| {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };

        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if !file_type.is_dir() {
                continue;
            }

            let path = entry.path();

            // Check if this subdirectory should be skipped
            if let Some(name) = path.file_name().and_then(|n| n.to_str())
                && should_skip_dir(name)
            {
                return true;
            }

            // If it's not in allowed_dirs, it means WalkBuilder skipped it (gitignored)
            if !allowed_dirs.contains(&path) && !path_allowed(&path, gi, canonical_root, None) {
                return true;
            }

            if has_ignored_descendants(&path, gi, canonical_root, allowed_dirs, cache) {
                return true;
            }
        }
        false
    })();

    cache.insert(key, result);
    result
}

/// Collect directories to watch, respecting gitignore and excluding .git.
/// On macOS/Windows, use recursive mode for directories without ignored subdirectories.
/// On Linux, use non-recursive mode for all directories.
fn collect_watch_directories(root: &Path, gi: &Gitignore) -> Vec<WatchTarget> {
    let use_recursive = platform_supports_native_recursive();

    let mut allowed_dirs: Vec<PathBuf> = WalkBuilder::new(root)
        .follow_links(false)
        .hidden(false)
        .git_ignore(true) // Respect gitignore to skip node_modules, target, etc.
        .filter_entry(|entry| {
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if !is_dir {
                return false;
            }

            if let Some(name) = entry.file_name().to_str()
                && should_skip_dir(name)
            {
                return false;
            }

            true
        })
        .build()
        .filter_map(|result| result.ok())
        .filter(|entry| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .map(|entry| entry.into_path())
        .collect();

    allowed_dirs.sort();

    let allowed_dirs_set: HashSet<PathBuf> = allowed_dirs.iter().cloned().collect();
    let mut ignored_cache = HashMap::new();
    let mut ancestor_stack: Vec<(PathBuf, bool)> = Vec::new();

    allowed_dirs
        .into_iter()
        .filter_map(|path| {
            while ancestor_stack
                .last()
                .is_some_and(|(ancestor, _)| !path.starts_with(ancestor))
            {
                ancestor_stack.pop();
            }

            if ancestor_stack
                .last()
                .is_some_and(|(_, is_recursive)| *is_recursive)
            {
                return None;
            }

            let recursive_mode = if use_recursive {
                if has_ignored_descendants(&path, gi, root, &allowed_dirs_set, &mut ignored_cache) {
                    RecursiveMode::NonRecursive
                } else {
                    RecursiveMode::Recursive
                }
            } else {
                RecursiveMode::NonRecursive
            };

            let is_recursive = matches!(recursive_mode, RecursiveMode::Recursive);
            ancestor_stack.push((path.clone(), is_recursive));

            Some(WatchTarget {
                path,
                recursive: recursive_mode,
            })
        })
        .collect()
}

/// Helper to determine watch mode for a directory (used for dynamically added directories).
/// This does a simple check of immediate children only, since we don't have the full
/// allowed_dirs set at runtime.
fn determine_watch_mode(path: &Path, gi: &Gitignore, canonical_root: &Path) -> RecursiveMode {
    if !platform_supports_native_recursive() {
        return RecursiveMode::NonRecursive;
    }

    let Ok(entries) = std::fs::read_dir(path) else {
        return RecursiveMode::Recursive;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if !file_type.is_dir() {
            continue;
        }

        let child_path = entry.path();

        if let Some(name) = child_path.file_name().and_then(|n| n.to_str())
            && should_skip_dir(name)
        {
            return RecursiveMode::NonRecursive;
        }

        if !path_allowed(&child_path, gi, canonical_root, None) {
            return RecursiveMode::NonRecursive;
        }
    }

    RecursiveMode::Recursive
}

/// Add a watch for a newly created directory
fn add_directory_watch(
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    watched_dirs: &mut WatchedDirs,
    dir_path: &Path,
    gi: &Gitignore,
    canonical_root: &Path,
) {
    let canonical_dir = canonicalize_lossy(dir_path);

    if !path_allowed(&canonical_dir, gi, canonical_root, None) {
        return;
    }

    if watched_dirs.contains(&canonical_dir) || watched_dirs.has_recursive_cover(&canonical_dir) {
        return;
    }

    let mode = determine_watch_mode(&canonical_dir, gi, canonical_root);

    if let Err(e) = debouncer.watch(&canonical_dir, mode) {
        tracing::warn!("Failed to watch new directory {:?}: {}", canonical_dir, e);
    } else {
        if matches!(mode, RecursiveMode::Recursive) {
            watched_dirs.remove_children_only(&canonical_dir, |child| {
                if let Err(err) = debouncer.unwatch(child) {
                    tracing::warn!("Could not unwatch covered directory {:?}: {}", child, err);
                }
            });
        }

        watched_dirs.insert(canonical_dir, mode);
    }
}

/// Remove a watch for a deleted directory
fn remove_directory_watch(
    debouncer: &mut Debouncer<RecommendedWatcher, RecommendedCache>,
    watched_dirs: &mut WatchedDirs,
    dir_path: &Path,
) {
    let canonical_dir = canonicalize_lossy(dir_path);

    watched_dirs.remove_dir_and_children(&canonical_dir, |path| {
        if let Err(e) = debouncer.unwatch(path) {
            tracing::warn!("Could not unwatch deleted directory {:?}: {}", path, e);
        }
    });
}

pub fn async_watcher(root: PathBuf) -> Result<WatcherComponents, FilesystemWatcherError> {
    let canonical_root = canonicalize_lossy(&root);
    let gi_set = Arc::new(build_gitignore_set(&canonical_root)?);
    // NOTE: changes to .gitignore aren’t picked up until the watcher is rebuilt.
    // Recomputing on every change would require rebuilding the full watcher fleet.

    let (mut raw_tx, mut raw_rx) = channel::<DebounceEventResult>(64);
    let (mut filtered_tx, filtered_rx) = channel::<DebounceEventResult>(64);

    let gi_clone = gi_set.clone();
    let root_for_task = canonical_root.clone();

    let debouncer_unwrapped = new_debouncer(
        Duration::from_millis(200),
        None,
        move |res: DebounceEventResult| {
            futures::executor::block_on(async {
                raw_tx.send(res).await.ok();
            });
        },
    )?;

    let debouncer = Arc::new(Mutex::new(debouncer_unwrapped));
    let debouncer_for_init = debouncer.clone();
    let debouncer_for_task = Arc::downgrade(&debouncer);

    let watched_dirs: Arc<Mutex<WatchedDirs>> = Arc::new(Mutex::new(WatchedDirs::default()));
    let watched_dirs_for_task = watched_dirs.clone();

    let watch_targets = collect_watch_directories(&canonical_root, &gi_set);
    {
        let mut debouncer_guard = debouncer_for_init.lock().unwrap();
        let mut watched = watched_dirs.lock().unwrap();

        for target in &watch_targets {
            if let Err(e) = debouncer_guard.watch(&target.path, target.recursive) {
                tracing::warn!("Failed to watch {:?}: {}", target.path, e);
            } else {
                watched.insert(target.path.clone(), target.recursive);
            }
        }
    }

    std::thread::spawn(move || {
        while let Some(result) = futures::executor::block_on(async { raw_rx.next().await }) {
            let Some(debouncer_arc) = debouncer_for_task.upgrade() else {
                break;
            };

            match result {
                Ok(events) => {
                    let mut debouncer_guard = debouncer_arc.lock().unwrap();
                    let mut watched = watched_dirs_for_task.lock().unwrap();

                    for event in &events {
                        if event.kind.is_create() {
                            for path in &event.paths {
                                if path.is_dir() {
                                    add_directory_watch(
                                        &mut debouncer_guard,
                                        &mut watched,
                                        path,
                                        &gi_clone,
                                        &root_for_task,
                                    );
                                }
                            }
                        } else if event.kind.is_remove() {
                            for path in &event.paths {
                                remove_directory_watch(&mut debouncer_guard, &mut watched, path);
                            }
                        } else if let EventKind::Modify(ModifyKind::Name(mode)) = &event.kind {
                            match mode {
                                RenameMode::From => {
                                    for path in &event.paths {
                                        remove_directory_watch(
                                            &mut debouncer_guard,
                                            &mut watched,
                                            path,
                                        );
                                    }
                                }
                                RenameMode::To => {
                                    for path in &event.paths {
                                        if path.is_dir() {
                                            add_directory_watch(
                                                &mut debouncer_guard,
                                                &mut watched,
                                                path,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                                RenameMode::Both => {
                                    if let Some((from, rest)) = event.paths.split_first() {
                                        remove_directory_watch(
                                            &mut debouncer_guard,
                                            &mut watched,
                                            from,
                                        );

                                        if let Some(to) = rest.last()
                                            && to.is_dir()
                                        {
                                            add_directory_watch(
                                                &mut debouncer_guard,
                                                &mut watched,
                                                to,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                                RenameMode::Any | RenameMode::Other => {
                                    for path in &event.paths {
                                        remove_directory_watch(
                                            &mut debouncer_guard,
                                            &mut watched,
                                            path,
                                        );
                                    }

                                    for path in &event.paths {
                                        if path.is_dir() {
                                            add_directory_watch(
                                                &mut debouncer_guard,
                                                &mut watched,
                                                path,
                                                &gi_clone,
                                                &root_for_task,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    drop(debouncer_guard);
                    drop(watched);

                    let filtered_events: Vec<DebouncedEvent> = events
                        .into_iter()
                        .filter(|ev| debounced_should_forward(ev, &gi_set, &root_for_task))
                        .collect();

                    if !filtered_events.is_empty() {
                        futures::executor::block_on(async {
                            filtered_tx.send(Ok(filtered_events)).await.ok();
                        });
                    }
                }
                Err(errors) => {
                    futures::executor::block_on(async {
                        filtered_tx.send(Err(errors)).await.ok();
                    });
                }
            }
        }
    });

    Ok((debouncer, filtered_rx, canonical_root))
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use notify::{Event, event::RemoveKind};
    use tempfile::TempDir;

    use super::*;

    fn gitignore_for(root: &Path, contents: &str) -> Gitignore {
        std::fs::write(root.join(".gitignore"), contents).unwrap();
        build_gitignore_set(root).unwrap()
    }

    fn remove_event(path: PathBuf, kind: RemoveKind) -> DebouncedEvent {
        DebouncedEvent::new(
            Event::new(EventKind::Remove(kind)).add_path(path),
            Instant::now(),
        )
    }

    #[test]
    fn deleted_extensionless_file_does_not_match_directory_only_gitignore_rule() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let gi = gitignore_for(&root, "ignored-dir/\n");

        let file_event = remove_event(root.join("ignored-dir"), RemoveKind::File);

        assert!(debounced_should_forward(&file_event, &gi, &root));
    }

    #[test]
    fn deleted_directory_still_matches_directory_only_gitignore_rule() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let gi = gitignore_for(&root, "ignored-dir/\n");

        let directory_event = remove_event(root.join("ignored-dir"), RemoveKind::Folder);

        assert!(!debounced_should_forward(&directory_event, &gi, &root));
    }

    fn create_event(path: PathBuf, kind: CreateKind) -> DebouncedEvent {
        DebouncedEvent::new(
            Event::new(EventKind::Create(kind)).add_path(path),
            Instant::now(),
        )
    }

    #[test]
    fn reports_created_files_as_root_relative_paths() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        std::fs::create_dir(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/page.html"), "<p>hi</p>").unwrap();

        let events = [create_event(root.join("docs/page.html"), CreateKind::File)];

        let (added, truncated) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert_eq!(added, vec!["docs/page.html"]);
        assert!(!truncated);
    }

    #[test]
    fn ignores_created_directories() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        std::fs::create_dir(root.join("assets")).unwrap();

        let events = [create_event(root.join("assets"), CreateKind::Folder)];

        let (added, truncated) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert!(added.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn ignores_paths_outside_the_watched_root() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("page.html");
        std::fs::write(&outside_file, "<p>hi</p>").unwrap();

        let events = [create_event(outside_file, CreateKind::File)];

        let (added, _) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert!(added.is_empty());
    }

    #[test]
    fn ignores_events_that_do_not_bring_a_path_into_existence() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let path = root.join("page.html");
        std::fs::write(&path, "<p>hi</p>").unwrap();

        let events = [
            remove_event(path.clone(), RemoveKind::File),
            DebouncedEvent::new(
                Event::new(EventKind::Modify(ModifyKind::Data(
                    notify::event::DataChange::Any,
                )))
                .add_path(path.clone()),
                Instant::now(),
            ),
            // An access event is not a content change.
            DebouncedEvent::new(
                Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(path),
                Instant::now(),
            ),
        ];

        let (added, _) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert!(added.is_empty());
    }

    #[test]
    fn counts_a_rename_destination_but_not_its_source() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let source = root.join("page.html.tmp");
        let destination = root.join("page.html");
        std::fs::write(&destination, "<p>hi</p>").unwrap();

        // A save through a temporary file arrives as a rename, and the source
        // is gone by the time the batch is processed.
        let events = [DebouncedEvent::new(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(source)
                .add_path(destination),
            Instant::now(),
        )];

        let (added, _) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert_eq!(added, vec!["page.html"]);
    }

    #[test]
    fn ignores_paths_that_are_no_longer_there() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());

        let events = [create_event(root.join("vanished.html"), CreateKind::File)];

        let (added, _) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert!(added.is_empty());
    }

    #[test]
    fn reports_the_same_path_once() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let path = root.join("page.html");
        std::fs::write(&path, "<p>hi</p>").unwrap();

        let events = [
            create_event(path.clone(), CreateKind::File),
            create_event(path.clone(), CreateKind::Any),
        ];

        let (added, _) = collect_added_paths(&events, &root, MAX_ADDED_PATHS);

        assert_eq!(added, vec!["page.html"]);
    }

    #[test]
    fn caps_the_batch_and_says_so() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let events: Vec<DebouncedEvent> = (0..5)
            .map(|index| {
                let path = root.join(format!("page{index}.html"));
                std::fs::write(&path, "<p>hi</p>").unwrap();
                create_event(path, CreateKind::File)
            })
            .collect();

        let (added, truncated) = collect_added_paths(&events, &root, 3);

        assert_eq!(added, vec!["page0.html", "page1.html", "page2.html"]);
        assert!(truncated);
    }

    #[test]
    fn a_batch_at_the_cap_is_not_truncated() {
        let temp = TempDir::new().unwrap();
        let root = canonicalize_lossy(temp.path());
        let events: Vec<DebouncedEvent> = (0..3)
            .map(|index| {
                let path = root.join(format!("page{index}.html"));
                std::fs::write(&path, "<p>hi</p>").unwrap();
                create_event(path, CreateKind::File)
            })
            .collect();

        let (added, truncated) = collect_added_paths(&events, &root, 3);

        assert_eq!(added.len(), 3);
        assert!(!truncated);
    }
}
