use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::{
    error::BrowserHostError,
    vault::{
        CredentialMergeStats, CredentialSummary, CredentialUpsertInput, ProfileCredentialStore,
        StoredCredential, ensure_private_dir, merge_credentials, sanitize_profile_id,
        write_private_atomic,
    },
};

const BOOKMARKS_FILENAME: &str = "bookmarks.json";
const HISTORY_FILENAME: &str = "history.json";
const MAX_FREQUENT_HISTORY: usize = 500;
const MAX_BOOKMARKS: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FrequentHistoryEntry {
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
    pub visit_count: u64,
    pub last_visited_at: i64,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUserDataSummary {
    pub profile_id: String,
    pub bookmarks_count: usize,
    pub history_count: usize,
    pub credentials_count: usize,
}

#[derive(Debug, Clone)]
pub struct BookmarkImportInput {
    pub title: String,
    pub url: String,
    pub folder: String,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct HistoryImportInput {
    pub url: String,
    pub title: String,
    pub visit_count: u64,
    pub last_visited_at: i64,
    pub source: String,
}

#[derive(Default)]
struct MemoryProfileState {
    bookmarks: Vec<BookmarkEntry>,
    history: Vec<FrequentHistoryEntry>,
    credentials: Vec<StoredCredential>,
}

pub struct UserDataManager {
    data_dir: Option<PathBuf>,
    memory: Mutex<HashMap<String, MemoryProfileState>>,
    io_lock: Mutex<()>,
}

impl UserDataManager {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            data_dir,
            memory: Mutex::new(HashMap::new()),
            io_lock: Mutex::new(()),
        }
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.data_dir.as_deref()
    }

    pub fn summary(&self, profile_id: &str) -> Result<ProfileUserDataSummary, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let bookmarks = self.load_bookmarks_locked(profile_id)?;
        let history = self.load_history_locked(profile_id)?;
        let credentials = self.load_credentials_locked(profile_id)?;
        Ok(ProfileUserDataSummary {
            profile_id: profile_id.to_owned(),
            bookmarks_count: bookmarks.len(),
            history_count: history.len(),
            credentials_count: credentials.len(),
        })
    }

    pub fn list_bookmarks(&self, profile_id: &str) -> Result<Vec<BookmarkEntry>, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.load_bookmarks_locked(profile_id)
    }

    pub fn add_bookmark(
        &self,
        profile_id: &str,
        url: &str,
        title: Option<&str>,
        folder: Option<&str>,
        favicon: Option<&str>,
    ) -> Result<(BookmarkEntry, bool), BrowserHostError> {
        let normalized_url = normalize_web_url(url).ok_or_else(|| {
            BrowserHostError::new("browser_bad_address", "only http(s) URLs can be bookmarked")
        })?;
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_bookmarks_locked(profile_id)?;
        let clean_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| fallback_title(&normalized_url));
        let clean_folder = folder.map(str::trim).unwrap_or("").to_owned();
        let clean_favicon = favicon
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| default_favicon(&normalized_url));

        if let Some(existing) = items.iter_mut().find(|item| item.url == normalized_url) {
            existing.title = clean_title;
            if !clean_folder.is_empty() {
                existing.folder = clean_folder;
            }
            if clean_favicon.is_some() {
                existing.favicon = clean_favicon;
            }
            let cloned = existing.clone();
            self.save_bookmarks_locked(profile_id, &items)?;
            return Ok((cloned, false));
        }

        let entry = BookmarkEntry {
            id: Uuid::new_v4().to_string(),
            title: clean_title,
            url: normalized_url,
            folder: clean_folder,
            favicon: clean_favicon,
            created_at: now_ms(),
        };
        items.insert(0, entry.clone());
        if items.len() > MAX_BOOKMARKS {
            items.truncate(MAX_BOOKMARKS);
        }
        self.save_bookmarks_locked(profile_id, &items)?;
        Ok((entry, true))
    }

    pub fn remove_bookmark(
        &self,
        profile_id: &str,
        id: Option<&str>,
        url: Option<&str>,
    ) -> Result<bool, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_bookmarks_locked(profile_id)?;
        let before = items.len();
        if let Some(target_id) = id.map(str::trim).filter(|s| !s.is_empty()) {
            items.retain(|item| item.id != target_id);
        } else if let Some(target_url) = url.and_then(normalize_web_url) {
            items.retain(|item| item.url != target_url);
        }
        let changed = items.len() != before;
        if changed {
            self.save_bookmarks_locked(profile_id, &items)?;
        }
        Ok(changed)
    }

    pub fn clear_bookmarks(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.save_bookmarks_locked(profile_id, &[])
    }

    pub fn import_bookmarks(
        &self,
        profile_id: &str,
        incoming: Vec<BookmarkImportInput>,
    ) -> Result<usize, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_bookmarks_locked(profile_id)?;
        let mut by_url: HashMap<String, usize> = items
            .iter()
            .enumerate()
            .map(|(idx, entry)| (entry.url.clone(), idx))
            .collect();
        let mut added = 0usize;

        for raw in incoming {
            let Some(url) = normalize_web_url(&raw.url) else {
                continue;
            };
            let title = if raw.title.trim().is_empty() {
                fallback_title(&url)
            } else {
                raw.title.trim().to_owned()
            };
            let folder = raw.folder.trim().to_owned();
            if let Some(&idx) = by_url.get(&url) {
                if items[idx].title.is_empty() {
                    items[idx].title = title;
                }
                if items[idx].folder.is_empty() && !folder.is_empty() {
                    items[idx].folder = folder;
                }
                continue;
            }
            if items.len() >= MAX_BOOKMARKS {
                break;
            }
            by_url.insert(url.clone(), items.len());
            items.push(BookmarkEntry {
                id: Uuid::new_v4().to_string(),
                title,
                favicon: default_favicon(&url),
                url,
                folder,
                created_at: if raw.created_at > 0 {
                    raw.created_at
                } else {
                    now_ms()
                },
            });
            added += 1;
        }
        if added > 0 {
            self.save_bookmarks_locked(profile_id, &items)?;
        }
        Ok(added)
    }

    pub fn list_history(
        &self,
        profile_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<FrequentHistoryEntry>, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_history_locked(profile_id)?;
        sort_frequent_history(&mut items);
        if let Some(cap) = limit {
            items.truncate(cap);
        }
        Ok(items)
    }

    pub fn record_visit(
        &self,
        profile_id: &str,
        url: &str,
        title: Option<&str>,
        favicon: Option<&str>,
    ) -> Result<(), BrowserHostError> {
        let Some(normalized) = normalize_web_url(url) else {
            return Ok(());
        };
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_history_locked(profile_id)?;
        let now = now_ms();
        let clean_title = title
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| fallback_title(&normalized));
        let clean_favicon = favicon
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| default_favicon(&normalized));

        if let Some(existing) = items.iter_mut().find(|entry| entry.url == normalized) {
            existing.visit_count = existing.visit_count.saturating_add(1);
            existing.last_visited_at = now.max(existing.last_visited_at);
            if !clean_title.is_empty() {
                existing.title = clean_title;
            }
            if clean_favicon.is_some() {
                existing.favicon = clean_favicon;
            }
        } else {
            items.push(FrequentHistoryEntry {
                url: normalized,
                title: clean_title,
                favicon: clean_favicon,
                visit_count: 1,
                last_visited_at: now,
                source: "builtin".to_owned(),
            });
        }
        sort_frequent_history(&mut items);
        items.truncate(MAX_FREQUENT_HISTORY);
        self.save_history_locked(profile_id, &items)
    }

    pub fn import_history(
        &self,
        profile_id: &str,
        incoming: Vec<HistoryImportInput>,
    ) -> Result<usize, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_history_locked(profile_id)?;
        let mut by_url: HashMap<String, usize> = items
            .iter()
            .enumerate()
            .map(|(idx, entry)| (entry.url.clone(), idx))
            .collect();
        let mut added = 0usize;

        for raw in incoming {
            let Some(url) = normalize_web_url(&raw.url) else {
                continue;
            };
            let title = if raw.title.trim().is_empty() {
                fallback_title(&url)
            } else {
                raw.title.trim().to_owned()
            };
            let visits = raw.visit_count.max(1);
            if let Some(&idx) = by_url.get(&url) {
                items[idx].visit_count = items[idx].visit_count.max(visits);
                items[idx].last_visited_at = items[idx].last_visited_at.max(raw.last_visited_at);
                if items[idx].title.is_empty() && !title.is_empty() {
                    items[idx].title = title;
                }
                continue;
            }
            by_url.insert(url.clone(), items.len());
            items.push(FrequentHistoryEntry {
                favicon: default_favicon(&url),
                url,
                title,
                visit_count: visits,
                last_visited_at: raw.last_visited_at,
                source: raw.source,
            });
            added += 1;
        }
        sort_frequent_history(&mut items);
        items.truncate(MAX_FREQUENT_HISTORY);
        self.save_history_locked(profile_id, &items)?;
        Ok(added)
    }

    pub fn clear_history(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.save_history_locked(profile_id, &[])
    }

    pub fn list_credentials_redacted(
        &self,
        profile_id: &str,
    ) -> Result<Vec<CredentialSummary>, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let items = self.load_credentials_locked(profile_id)?;
        Ok(items.iter().map(CredentialSummary::from).collect())
    }

    pub fn get_credential_for_autofill(
        &self,
        profile_id: &str,
        credential_id: &str,
    ) -> Result<StoredCredential, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let items = self.load_credentials_locked(profile_id)?;
        items
            .into_iter()
            .find(|item| item.id == credential_id)
            .ok_or_else(|| BrowserHostError::new("browser_invalid", "saved credential not found"))
    }

    pub fn import_credentials(
        &self,
        profile_id: &str,
        incoming: Vec<CredentialUpsertInput>,
    ) -> Result<CredentialMergeStats, BrowserHostError> {
        if sanitize_profile_id(profile_id) == "ephemeral" {
            return Err(BrowserHostError::new(
                "browser_invalid",
                "passwords cannot be persisted into the ephemeral profile",
            ));
        }
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_credentials_locked(profile_id)?;
        let stats = merge_credentials(&mut items, incoming);
        if stats.added > 0 || stats.updated > 0 {
            self.save_credentials_locked(profile_id, &items)?;
        }
        Ok(stats)
    }

    pub fn remove_credential(
        &self,
        profile_id: &str,
        credential_id: &str,
    ) -> Result<bool, BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut items = self.load_credentials_locked(profile_id)?;
        let before = items.len();
        items.retain(|item| item.id != credential_id);
        let changed = items.len() != before;
        if changed {
            self.save_credentials_locked(profile_id, &items)?;
        }
        Ok(changed)
    }

    pub fn clear_credentials(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.clear_credentials_locked(profile_id)
    }

    pub fn remove_profile_data(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        let _guard = self.io_lock.lock().unwrap_or_else(|p| p.into_inner());
        let _ = self.clear_credentials_locked(profile_id);
        let key = sanitize_profile_id(profile_id);
        self.memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&key);
        if let Some(root) = &self.data_dir {
            let dir = root.join(&key);
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|err| {
                    BrowserHostError::new(
                        "browser_write_failed",
                        format!("remove profile userdata dir: {err}"),
                    )
                })?;
            }
        }
        Ok(())
    }

    fn profile_dir(&self, profile_id: &str) -> Option<PathBuf> {
        let safe = sanitize_profile_id(profile_id);
        if safe == "ephemeral" {
            return None;
        }
        self.data_dir.as_ref().map(|root| root.join(safe))
    }

    fn load_bookmarks_locked(
        &self,
        profile_id: &str,
    ) -> Result<Vec<BookmarkEntry>, BrowserHostError> {
        if let Some(dir) = self.profile_dir(profile_id) {
            let path = dir.join(BOOKMARKS_FILENAME);
            if !path.is_file() {
                return Ok(Vec::new());
            }
            let raw = fs::read_to_string(&path).map_err(|err| {
                BrowserHostError::new("browser_read_failed", format!("read bookmarks: {err}"))
            })?;
            if raw.trim().is_empty() {
                return Ok(Vec::new());
            }
            return serde_json::from_str(&raw).map_err(|err| {
                BrowserHostError::new("browser_read_failed", format!("parse bookmarks: {err}"))
            });
        }
        let key = sanitize_profile_id(profile_id);
        Ok(self
            .memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            .map(|state| state.bookmarks.clone())
            .unwrap_or_default())
    }

    fn save_bookmarks_locked(
        &self,
        profile_id: &str,
        items: &[BookmarkEntry],
    ) -> Result<(), BrowserHostError> {
        if let Some(dir) = self.profile_dir(profile_id) {
            ensure_private_dir(&dir)?;
            let serialized = serde_json::to_vec_pretty(items).map_err(|err| {
                BrowserHostError::new(
                    "browser_write_failed",
                    format!("serialize bookmarks: {err}"),
                )
            })?;
            return write_private_atomic(&dir.join(BOOKMARKS_FILENAME), &serialized);
        }
        let key = sanitize_profile_id(profile_id);
        self.memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(key)
            .or_default()
            .bookmarks = items.to_vec();
        Ok(())
    }

    fn load_history_locked(
        &self,
        profile_id: &str,
    ) -> Result<Vec<FrequentHistoryEntry>, BrowserHostError> {
        if let Some(dir) = self.profile_dir(profile_id) {
            let path = dir.join(HISTORY_FILENAME);
            if !path.is_file() {
                return Ok(Vec::new());
            }
            let raw = fs::read_to_string(&path).map_err(|err| {
                BrowserHostError::new("browser_read_failed", format!("read history: {err}"))
            })?;
            if raw.trim().is_empty() {
                return Ok(Vec::new());
            }
            return serde_json::from_str(&raw).map_err(|err| {
                BrowserHostError::new("browser_read_failed", format!("parse history: {err}"))
            });
        }
        let key = sanitize_profile_id(profile_id);
        Ok(self
            .memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            .map(|state| state.history.clone())
            .unwrap_or_default())
    }

    fn save_history_locked(
        &self,
        profile_id: &str,
        items: &[FrequentHistoryEntry],
    ) -> Result<(), BrowserHostError> {
        if let Some(dir) = self.profile_dir(profile_id) {
            ensure_private_dir(&dir)?;
            let serialized = serde_json::to_vec_pretty(items).map_err(|err| {
                BrowserHostError::new("browser_write_failed", format!("serialize history: {err}"))
            })?;
            return write_private_atomic(&dir.join(HISTORY_FILENAME), &serialized);
        }
        let key = sanitize_profile_id(profile_id);
        self.memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(key)
            .or_default()
            .history = items.to_vec();
        Ok(())
    }

    fn load_credentials_locked(
        &self,
        profile_id: &str,
    ) -> Result<Vec<StoredCredential>, BrowserHostError> {
        if let Some(root) = &self.data_dir
            && sanitize_profile_id(profile_id) != "ephemeral"
        {
            return ProfileCredentialStore::open(Some(root), profile_id)?.load_all();
        }
        let key = sanitize_profile_id(profile_id);
        Ok(self
            .memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&key)
            .map(|state| state.credentials.clone())
            .unwrap_or_default())
    }

    fn save_credentials_locked(
        &self,
        profile_id: &str,
        items: &[StoredCredential],
    ) -> Result<(), BrowserHostError> {
        if let Some(root) = &self.data_dir
            && sanitize_profile_id(profile_id) != "ephemeral"
        {
            return ProfileCredentialStore::open(Some(root), profile_id)?.save_all(items);
        }
        let key = sanitize_profile_id(profile_id);
        self.memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(key)
            .or_default()
            .credentials = items.to_vec();
        Ok(())
    }

    fn clear_credentials_locked(&self, profile_id: &str) -> Result<(), BrowserHostError> {
        if let Some(root) = &self.data_dir
            && sanitize_profile_id(profile_id) != "ephemeral"
        {
            return ProfileCredentialStore::open(Some(root), profile_id)?.clear();
        }
        let key = sanitize_profile_id(profile_id);
        if let Some(state) = self
            .memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(&key)
        {
            state.credentials.clear();
        }
        Ok(())
    }
}

pub fn normalize_web_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.host_str()?;
    Some(parsed.to_string())
}

fn fallback_title(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.trim_start_matches("www.").to_owned())
        })
        .unwrap_or_else(|| url.to_owned())
}

fn default_favicon(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{}://{host}{port}/favicon.ico", parsed.scheme()))
}

fn sort_frequent_history(items: &mut [FrequentHistoryEntry]) {
    items.sort_by(|a, b| {
        b.visit_count
            .cmp(&a.visit_count)
            .then_with(|| b.last_visited_at.cmp(&a.last_visited_at))
            .then_with(|| a.url.cmp(&b.url))
    });
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frequent_history_ranks_by_visits_then_recency_and_caps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mgr = UserDataManager::new(Some(dir.path().to_path_buf()));

        let added = mgr
            .import_history(
                "default",
                vec![
                    HistoryImportInput {
                        url: "https://low.example.com/".into(),
                        title: "Low".into(),
                        visit_count: 2,
                        last_visited_at: 9000,
                        source: "chrome".into(),
                    },
                    HistoryImportInput {
                        url: "https://high.example.com/".into(),
                        title: "High".into(),
                        visit_count: 42,
                        last_visited_at: 5000,
                        source: "chrome".into(),
                    },
                    HistoryImportInput {
                        url: "chrome://settings".into(),
                        title: "Ignored".into(),
                        visit_count: 99,
                        last_visited_at: 9999,
                        source: "chrome".into(),
                    },
                ],
            )
            .expect("import history");
        assert_eq!(added, 2);

        let list = mgr.list_history("default", None).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].url, "https://high.example.com/");
        assert_eq!(list[0].visit_count, 42);
        assert_eq!(list[1].url, "https://low.example.com/");
    }

    #[test]
    fn bookmarks_dedup_and_remove_cleanly() {
        let mgr = UserDataManager::new(None);
        let added = mgr
            .import_bookmarks(
                "default",
                vec![
                    BookmarkImportInput {
                        title: "GitHub".into(),
                        url: "https://github.com/".into(),
                        folder: "Dev".into(),
                        created_at: 100,
                    },
                    BookmarkImportInput {
                        title: "GitHub Duplicate".into(),
                        url: "https://github.com".into(),
                        folder: "Dev".into(),
                        created_at: 200,
                    },
                ],
            )
            .expect("import bookmarks");
        assert_eq!(added, 1);

        let all = mgr.list_bookmarks("default").expect("list");
        assert_eq!(all.len(), 1);
        assert!(
            mgr.remove_bookmark("default", Some(&all[0].id), None)
                .expect("remove")
        );
        assert!(mgr.list_bookmarks("default").expect("empty").is_empty());
    }
}
