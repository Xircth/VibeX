use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    error::BrowserHostError,
    userdata::{BookmarkImportInput, HistoryImportInput, now_ms},
    vault::CredentialUpsertInput,
};

const WEBKIT_UNIX_EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalBrowserEngine {
    Chromium,
    Firefox,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedBrowserProfile {
    pub id: String,
    pub browser_id: String,
    pub browser_name: String,
    pub profile_name: String,
    pub profile_path: String,
    pub engine: ExternalBrowserEngine,
    pub has_bookmarks: bool,
    pub has_history: bool,
}

pub fn detect_external_browsers() -> Vec<DetectedBrowserProfile> {
    let mut results = Vec::new();
    let mut seen_paths = HashSet::new();

    for (browser_id, browser_name, user_data_dir) in chromium_browser_roots() {
        if !user_data_dir.is_dir() {
            continue;
        }
        for profile in detect_chromium_profiles(&browser_id, &browser_name, &user_data_dir) {
            if seen_paths.insert(profile.profile_path.clone()) {
                results.push(profile);
            }
        }
    }

    for firefox_root in firefox_roots() {
        if !firefox_root.is_dir() {
            continue;
        }
        for profile in detect_firefox_profiles(&firefox_root) {
            if seen_paths.insert(profile.profile_path.clone()) {
                results.push(profile);
            }
        }
    }

    results
}

fn chromium_browser_roots() -> Vec<(String, String, PathBuf)> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    {
        if let Some(local_app) = dirs::data_local_dir() {
            roots.push((
                "chrome".into(),
                "Google Chrome".into(),
                local_app.join("Google").join("Chrome").join("User Data"),
            ));
            roots.push((
                "edge".into(),
                "Microsoft Edge".into(),
                local_app.join("Microsoft").join("Edge").join("User Data"),
            ));
            roots.push((
                "brave".into(),
                "Brave".into(),
                local_app
                    .join("BraveSoftware")
                    .join("Brave-Browser")
                    .join("User Data"),
            ));
            roots.push((
                "vivaldi".into(),
                "Vivaldi".into(),
                local_app.join("Vivaldi").join("User Data"),
            ));
            roots.push((
                "arc".into(),
                "Arc".into(),
                local_app.join("Arc").join("User Data"),
            ));
            // Microsoft Store / MSIX packaged Arc on Windows
            let packages = local_app.join("Packages");
            if let Ok(entries) = fs::read_dir(&packages) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with("TheBrowserCompany.Arc_") {
                        roots.push((
                            "arc".into(),
                            "Arc".into(),
                            entry
                                .path()
                                .join("LocalCache")
                                .join("Local")
                                .join("Arc")
                                .join("User Data"),
                        ));
                    }
                }
            }
        }
        if let Some(roaming) = dirs::config_dir() {
            roots.push((
                "opera".into(),
                "Opera".into(),
                roaming.join("Opera Software").join("Opera Stable"),
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(app_support) = dirs::config_dir() {
            roots.push((
                "chrome".into(),
                "Google Chrome".into(),
                app_support.join("Google").join("Chrome"),
            ));
            roots.push((
                "edge".into(),
                "Microsoft Edge".into(),
                app_support.join("Microsoft Edge"),
            ));
            roots.push((
                "brave".into(),
                "Brave".into(),
                app_support.join("BraveSoftware").join("Brave-Browser"),
            ));
            roots.push((
                "arc".into(),
                "Arc".into(),
                app_support.join("Arc").join("User Data"),
            ));
            roots.push((
                "vivaldi".into(),
                "Vivaldi".into(),
                app_support.join("Vivaldi"),
            ));
            roots.push((
                "opera".into(),
                "Opera".into(),
                app_support.join("com.operasoftware.Opera"),
            ));
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Some(config) = dirs::config_dir() {
            roots.push((
                "chrome".into(),
                "Google Chrome".into(),
                config.join("google-chrome"),
            ));
            roots.push((
                "chromium".into(),
                "Chromium".into(),
                config.join("chromium"),
            ));
            roots.push((
                "edge".into(),
                "Microsoft Edge".into(),
                config.join("microsoft-edge"),
            ));
            roots.push((
                "brave".into(),
                "Brave".into(),
                config.join("BraveSoftware").join("Brave-Browser"),
            ));
        }
    }

    roots
}

fn firefox_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    if let Some(roaming) = dirs::config_dir() {
        roots.push(roaming.join("Mozilla").join("Firefox"));
    }
    #[cfg(target_os = "macos")]
    if let Some(app_support) = dirs::config_dir() {
        roots.push(app_support.join("Firefox"));
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".mozilla").join("firefox"));
    }
    roots
}

pub fn detect_chromium_profiles(
    browser_id: &str,
    browser_name: &str,
    user_data_dir: &Path,
) -> Vec<DetectedBrowserProfile> {
    let mut out = Vec::new();
    let mut seen_dirs = HashSet::new();

    // Parse Local State for friendly profile names.
    let local_state_path = user_data_dir.join("Local State");
    if let Ok(raw) = fs::read_to_string(&local_state_path)
        && let Ok(json) = serde_json::from_str::<Value>(&raw)
        && let Some(cache) = json
            .pointer("/profile/info_cache")
            .and_then(Value::as_object)
    {
        for (dir_name, meta) in cache {
            let profile_dir = user_data_dir.join(dir_name);
            if !profile_dir.is_dir() {
                continue;
            }
            let has_bookmarks = profile_dir.join("Bookmarks").is_file();
            let has_history = profile_dir.join("History").is_file();
            if !has_bookmarks && !has_history {
                continue;
            }
            let display = meta
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(dir_name.as_str())
                .to_owned();
            seen_dirs.insert(profile_dir.clone());
            out.push(DetectedBrowserProfile {
                id: format!("{browser_id}:{dir_name}"),
                browser_id: browser_id.to_owned(),
                browser_name: browser_name.to_owned(),
                profile_name: display,
                profile_path: profile_dir.to_string_lossy().into_owned(),
                engine: ExternalBrowserEngine::Chromium,
                has_bookmarks,
                has_history,
            });
        }
    }

    // Direct folder scan fallback (e.g. Opera Stable or missing Local State).
    let direct_candidates: Vec<PathBuf> =
        if user_data_dir.join("Bookmarks").is_file() || user_data_dir.join("History").is_file() {
            vec![user_data_dir.to_path_buf()]
        } else if let Ok(entries) = fs::read_dir(user_data_dir) {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n == "Default" || n.starts_with("Profile "))
                })
                .collect()
        } else {
            Vec::new()
        };

    for dir in direct_candidates {
        if seen_dirs.contains(&dir) {
            continue;
        }
        let has_bookmarks = dir.join("Bookmarks").is_file();
        let has_history = dir.join("History").is_file();
        if !has_bookmarks && !has_history {
            continue;
        }
        let dir_name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Default")
            .to_owned();
        out.push(DetectedBrowserProfile {
            id: format!("{browser_id}:{dir_name}"),
            browser_id: browser_id.to_owned(),
            browser_name: browser_name.to_owned(),
            profile_name: if dir_name == "Default" {
                "Default".to_owned()
            } else {
                dir_name
            },
            profile_path: dir.to_string_lossy().into_owned(),
            engine: ExternalBrowserEngine::Chromium,
            has_bookmarks,
            has_history,
        });
    }

    out.sort_by(|a, b| a.profile_name.cmp(&b.profile_name));
    out
}

pub fn detect_firefox_profiles(firefox_root: &Path) -> Vec<DetectedBrowserProfile> {
    let mut out = Vec::new();
    let mut candidates: Vec<(String, PathBuf)> = Vec::new();

    let profiles_ini = firefox_root.join("profiles.ini");
    if let Ok(raw) = fs::read_to_string(&profiles_ini) {
        let mut current_name: Option<String> = None;
        let mut current_path: Option<String> = None;
        let mut is_relative = true;
        let flush = |name: Option<String>,
                     rel_path: Option<String>,
                     rel: bool,
                     dest: &mut Vec<(String, PathBuf)>| {
            if let Some(p) = rel_path {
                let resolved = if rel {
                    firefox_root.join(p)
                } else {
                    PathBuf::from(p)
                };
                if resolved.is_dir() {
                    let label = name.unwrap_or_else(|| {
                        resolved
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("Default")
                            .to_owned()
                    });
                    dest.push((label, resolved));
                }
            }
        };
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                flush(
                    current_name.take(),
                    current_path.take(),
                    is_relative,
                    &mut candidates,
                );
                is_relative = true;
                continue;
            }
            if let Some((k, v)) = trimmed.split_once('=') {
                match k.trim() {
                    "Name" => current_name = Some(v.trim().to_owned()),
                    "Path" => current_path = Some(v.trim().to_owned()),
                    "IsRelative" => is_relative = v.trim() != "0",
                    _ => {}
                }
            }
        }
        flush(current_name, current_path, is_relative, &mut candidates);
    }

    if candidates.is_empty()
        && let Ok(entries) = fs::read_dir(firefox_root.join("Profiles"))
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let label = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Default")
                    .to_owned();
                candidates.push((label, path));
            }
        }
    }

    let mut seen = HashSet::new();
    for (name, dir) in candidates {
        let places = dir.join("places.sqlite");
        if !places.is_file() {
            continue;
        }
        let path_str = dir.to_string_lossy().into_owned();
        if !seen.insert(path_str.clone()) {
            continue;
        }
        out.push(DetectedBrowserProfile {
            id: format!("firefox:{name}"),
            browser_id: "firefox".to_owned(),
            browser_name: "Firefox".to_owned(),
            profile_name: name,
            profile_path: path_str,
            engine: ExternalBrowserEngine::Firefox,
            has_bookmarks: true,
            has_history: true,
        });
    }
    out
}

pub fn import_from_detected_profile(
    profile_path: &Path,
    engine: ExternalBrowserEngine,
    include_bookmarks: bool,
    include_history: bool,
) -> (
    Vec<BookmarkImportInput>,
    Vec<HistoryImportInput>,
    Vec<String>,
) {
    let mut bookmarks = Vec::new();
    let mut history = Vec::new();
    let mut warnings = Vec::new();

    match engine {
        ExternalBrowserEngine::Chromium => {
            if include_bookmarks {
                let bm_path = profile_path.join("Bookmarks");
                if bm_path.is_file() {
                    match fs::read_to_string(&bm_path) {
                        Ok(raw) => match parse_chromium_bookmarks(&raw) {
                            Ok(parsed) => bookmarks.extend(parsed),
                            Err(err) => warnings.push(format!("解析 Chromium 书签失败: {err}")),
                        },
                        Err(err) => warnings.push(format!("读取 Chromium 书签文件失败: {err}")),
                    }
                }
            }
            if include_history {
                let hist_path = profile_path.join("History");
                if hist_path.is_file() {
                    match read_chromium_history(&hist_path) {
                        Ok(parsed) => history.extend(parsed),
                        Err(err) => warnings.push(err),
                    }
                }
            }
        }
        ExternalBrowserEngine::Firefox => {
            let places_path = profile_path.join("places.sqlite");
            if places_path.is_file() {
                match read_firefox_places(&places_path, include_bookmarks, include_history) {
                    Ok((bm, hist)) => {
                        bookmarks.extend(bm);
                        history.extend(hist);
                    }
                    Err(err) => warnings.push(err),
                }
            } else {
                warnings.push("未找到 Firefox places.sqlite 数据库".to_owned());
            }
        }
    }

    (bookmarks, history, warnings)
}

pub fn parse_chromium_bookmarks(raw: &str) -> Result<Vec<BookmarkImportInput>, String> {
    let root: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let Some(roots) = root.get("roots").and_then(Value::as_object) else {
        return Err("missing roots object".to_owned());
    };
    let mut out = Vec::new();
    for (root_key, node) in roots {
        let root_folder = match root_key.as_str() {
            "bookmark_bar" => "书签栏",
            "other" => "其他书签",
            "synced" => "移动设备书签",
            other => other,
        };
        collect_chromium_bookmark_node(node, root_folder, &mut out);
    }
    Ok(out)
}

fn collect_chromium_bookmark_node(
    node: &Value,
    folder_path: &str,
    out: &mut Vec<BookmarkImportInput>,
) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "url" {
        if let Some(url) = node.get("url").and_then(Value::as_str) {
            let title = node
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let created_at = node
                .get("date_added")
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                        .or_else(|| v.as_i64())
                })
                .map(webkit_us_to_unix_ms)
                .unwrap_or_else(now_ms);
            out.push(BookmarkImportInput {
                title,
                url: url.to_owned(),
                folder: folder_path.to_owned(),
                created_at,
            });
        }
        return;
    }

    if let Some(children) = node.get("children").and_then(Value::as_array) {
        let name = node
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let next_folder = if name.is_empty()
            || name.eq_ignore_ascii_case("Bookmarks bar")
            || name.eq_ignore_ascii_case("Other bookmarks")
            || name.eq_ignore_ascii_case("Mobile bookmarks")
        {
            folder_path.to_owned()
        } else if folder_path.is_empty() {
            name.to_owned()
        } else {
            format!("{folder_path} / {name}")
        };
        for child in children {
            collect_chromium_bookmark_node(child, &next_folder, out);
        }
    }
}

fn copy_sqlite_to_temp(
    db_path: &Path,
    base_name: &str,
) -> Result<(tempfile::TempDir, PathBuf), String> {
    let temp_dir = tempfile::tempdir().map_err(|e| format!("创建临时目录失败: {e}"))?;
    let target_db = temp_dir.path().join(base_name);
    fs::copy(db_path, &target_db).map_err(|e| {
        format!(
            "读取浏览器数据库 {} 失败（若浏览器正在运行并锁定文件，请关闭后重试）: {e}",
            db_path.display()
        )
    })?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", db_path.display(), suffix));
        if sidecar.is_file() {
            let _ = fs::copy(
                &sidecar,
                temp_dir.path().join(format!("{base_name}{suffix}")),
            );
        }
    }
    Ok((temp_dir, target_db))
}

pub fn read_chromium_history(history_path: &Path) -> Result<Vec<HistoryImportInput>, String> {
    let (_tmp, copied_db) = copy_sqlite_to_temp(history_path, "History")?;
    let conn = Connection::open_with_flags(
        &copied_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 Chromium History 数据库失败: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT url, COALESCE(title, ''), COALESCE(visit_count, 1), COALESCE(last_visit_time, 0)
             FROM urls
             WHERE hidden = 0 AND COALESCE(visit_count, 0) > 0
               AND (url LIKE 'http://%' OR url LIKE 'https://%')
             ORDER BY visit_count DESC, last_visit_time DESC
             LIMIT 1000",
        )
        .map_err(|e| format!("查询 Chromium History 失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let url: String = row.get(0)?;
            let title: String = row.get(1)?;
            let visit_count: i64 = row.get(2)?;
            let last_visit_us: i64 = row.get(3)?;
            Ok(HistoryImportInput {
                url,
                title,
                visit_count: visit_count.max(1) as u64,
                last_visited_at: webkit_us_to_unix_ms(last_visit_us),
                source: "chromium".to_owned(),
            })
        })
        .map_err(|e| format!("读取 Chromium History 行失败: {e}"))?;

    let mut out = Vec::new();
    for item in rows.flatten() {
        out.push(item);
    }
    Ok(out)
}

pub fn read_firefox_places(
    places_path: &Path,
    include_bookmarks: bool,
    include_history: bool,
) -> Result<(Vec<BookmarkImportInput>, Vec<HistoryImportInput>), String> {
    let (_tmp, copied_db) = copy_sqlite_to_temp(places_path, "places.sqlite")?;
    let conn = Connection::open_with_flags(
        &copied_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开 Firefox places.sqlite 失败: {e}"))?;

    let mut bookmarks = Vec::new();
    if include_bookmarks {
        let mut stmt = conn
            .prepare(
                "SELECT p.url, COALESCE(NULLIF(b.title, ''), p.title, ''), COALESCE(b.dateAdded, 0)
                 FROM moz_bookmarks b
                 JOIN moz_places p ON b.fk = p.id
                 WHERE b.type = 1 AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')",
            )
            .map_err(|e| format!("查询 Firefox 书签失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let url: String = row.get(0)?;
                let title: String = row.get(1)?;
                let date_added_us: i64 = row.get(2)?;
                Ok(BookmarkImportInput {
                    title,
                    url,
                    folder: "Firefox".to_owned(),
                    created_at: if date_added_us > 0 {
                        date_added_us / 1000
                    } else {
                        now_ms()
                    },
                })
            })
            .map_err(|e| format!("读取 Firefox 书签行失败: {e}"))?;
        for item in rows.flatten() {
            bookmarks.push(item);
        }
    }

    let mut history = Vec::new();
    if include_history {
        let mut stmt = conn
            .prepare(
                "SELECT url, COALESCE(title, ''), COALESCE(visit_count, 1), COALESCE(last_visit_date, 0)
                 FROM moz_places
                 WHERE hidden = 0 AND COALESCE(visit_count, 0) > 0
                   AND (url LIKE 'http://%' OR url LIKE 'https://%')
                 ORDER BY visit_count DESC, last_visit_date DESC
                 LIMIT 1000",
            )
            .map_err(|e| format!("查询 Firefox 历史失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                let url: String = row.get(0)?;
                let title: String = row.get(1)?;
                let visit_count: i64 = row.get(2)?;
                let last_visit_us: i64 = row.get(3)?;
                Ok(HistoryImportInput {
                    url,
                    title,
                    visit_count: visit_count.max(1) as u64,
                    last_visited_at: if last_visit_us > 0 {
                        last_visit_us / 1000
                    } else {
                        now_ms()
                    },
                    source: "firefox".to_owned(),
                })
            })
            .map_err(|e| format!("读取 Firefox 历史行失败: {e}"))?;
        for item in rows.flatten() {
            history.push(item);
        }
    }

    Ok((bookmarks, history))
}

pub fn parse_netscape_bookmarks_html(html: &str) -> Vec<BookmarkImportInput> {
    let mut out = Vec::new();
    let mut folder_stack: Vec<String> = Vec::new();
    let mut pending_folder = false;

    for raw_line in html.lines() {
        let lower = raw_line.to_ascii_lowercase();
        if let Some(h3_start) = lower.find("<h3") {
            if let Some(gt) = raw_line[h3_start..].find('>') {
                let after_gt = &raw_line[h3_start + gt + 1..];
                let end = after_gt
                    .to_ascii_lowercase()
                    .find("</h3>")
                    .unwrap_or(after_gt.len());
                let name = decode_html_entities(after_gt[..end].trim());
                if !name.is_empty() {
                    folder_stack.push(name);
                    pending_folder = true;
                }
            }
            continue;
        }
        if lower.contains("</dl>") && !folder_stack.is_empty() {
            if !pending_folder {
                folder_stack.pop();
            }
            pending_folder = false;
            continue;
        }
        if lower.contains("<dl>") {
            pending_folder = false;
        }
        if let Some(a_start) = lower.find("<a ")
            && let Some(gt) = raw_line[a_start..].find('>')
        {
            let attrs = &raw_line[a_start + 3..a_start + gt];
            if let Some(href) = extract_html_attr(attrs, "href") {
                let after_gt = &raw_line[a_start + gt + 1..];
                let end = after_gt
                    .to_ascii_lowercase()
                    .find("</a>")
                    .unwrap_or(after_gt.len());
                let title = decode_html_entities(after_gt[..end].trim());
                let created_at = extract_html_attr(attrs, "add_date")
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|secs| secs * 1000)
                    .unwrap_or_else(now_ms);
                out.push(BookmarkImportInput {
                    title,
                    url: decode_html_entities(&href),
                    folder: folder_stack.join(" / "),
                    created_at,
                });
            }
        }
    }

    out
}

pub fn parse_passwords_csv(
    raw_csv: &str,
    source: &str,
) -> Result<Vec<CredentialUpsertInput>, BrowserHostError> {
    let trimmed = raw_csv.trim_start_matches('\u{feff}');
    let rows = parse_rfc4180_csv(trimmed);
    if rows.is_empty() {
        return Err(BrowserHostError::new(
            "browser_invalid",
            "CSV 文件为空，请检查导出文件内容",
        ));
    }

    let headers: Vec<String> = rows[0]
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    let header_map: HashMap<String, usize> = headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.clone(), i))
        .collect();

    let col_idx = |names: &[&str]| -> Option<usize> {
        names.iter().find_map(|n| header_map.get(*n).copied())
    };

    let name_col = col_idx(&["name", "title", "名称", "标题"]);
    let url_col = col_idx(&["url", "website", "origin", "login_uri", "网址", "链接"]);
    let user_col = col_idx(&[
        "username",
        "user",
        "login_username",
        "account",
        "用户名",
        "账号",
        "账户",
    ]);
    let pass_col = col_idx(&["password", "pass", "login_password", "密码"]);
    let note_col = col_idx(&["note", "notes", "comment", "extra", "备注"]);

    let (Some(url_idx), Some(pass_idx)) = (url_col, pass_col) else {
        return Err(BrowserHostError::new(
            "browser_invalid",
            "未识别到密码 CSV 表头（需要至少包含 url 与 password 列，支持 Chrome/Edge/Safari 导出格式）",
        ));
    };

    let ts = now_ms();
    let mut out = Vec::new();
    for row in rows.iter().skip(1) {
        let get = |idx: Option<usize>| -> String {
            idx.and_then(|i| row.get(i))
                .map(|s| s.trim().to_owned())
                .unwrap_or_default()
        };
        let url = get(Some(url_idx));
        let password = row.get(pass_idx).cloned().unwrap_or_default();
        if url.is_empty() || password.is_empty() {
            continue;
        }
        out.push(CredentialUpsertInput {
            name: get(name_col),
            url,
            username: get(user_col),
            password,
            note: get(note_col),
            source: source.to_owned(),
            updated_at: ts,
        });
    }
    Ok(out)
}

fn parse_rfc4180_csv(input: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                in_quotes = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                if row.iter().any(|cell| !cell.trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                if row.iter().any(|cell| !cell.trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(c),
        }
    }

    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.iter().any(|cell| !cell.trim().is_empty()) {
            rows.push(row);
        }
    }

    rows
}

fn webkit_us_to_unix_ms(webkit_us: i64) -> i64 {
    if webkit_us <= 0 {
        return 0;
    }
    (webkit_us / 1000)
        .saturating_sub(WEBKIT_UNIX_EPOCH_DIFF_MS)
        .max(0)
}

fn extract_html_attr(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let needle = format!("{name}=");
    let start = lower.find(&needle)?;
    let rest = attrs[start + needle.len()..].trim_start();
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let inner = &rest[1..];
        let end = inner.find(quote)?;
        Some(inner[..end].to_owned())
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        Some(rest[..end].to_owned())
    }
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chromium_bookmarks_json_with_nested_folders() {
        let sample = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder",
                    "name": "Bookmarks bar",
                    "children": [
                        { "type": "url", "name": "GitHub", "url": "https://github.com/", "date_added": "13350000000000000" },
                        {
                            "type": "folder",
                            "name": "AI",
                            "children": [
                                { "type": "url", "name": "Dimo", "url": "https://dimo.dev/" }
                            ]
                        }
                    ]
                },
                "other": { "type": "folder", "name": "Other bookmarks", "children": [] },
                "synced": { "type": "folder", "name": "Mobile bookmarks", "children": [] }
            }
        }"#;
        let parsed = parse_chromium_bookmarks(sample).expect("parse bookmarks");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].title, "GitHub");
        assert_eq!(parsed[0].folder, "书签栏");
        assert_eq!(parsed[1].title, "Dimo");
        assert_eq!(parsed[1].folder, "书签栏 / AI");
    }

    #[test]
    fn reads_chromium_history_sqlite_and_ranks_by_visits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("History");
        let conn = Connection::open(&db_path).expect("create sqlite");
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
             INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES ('https://docs.rs/', 'Docs.rs', 5, 13350000000000000, 0);
             INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES ('https://github.com/DimoADE/Dimo', 'Dimo Repo', 38, 13360000000000000, 0);
             INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES ('https://hidden.test/', 'Hidden', 99, 13360000000000000, 1);
             INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES ('chrome://settings', 'Settings', 20, 13360000000000000, 0);",
        )
        .expect("seed history");
        drop(conn);

        let items = read_chromium_history(&db_path).expect("read history");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://github.com/DimoADE/Dimo");
        assert_eq!(items[0].visit_count, 38);
        assert!(items[0].last_visited_at > 0);
        assert_eq!(items[1].url, "https://docs.rs/");
    }

    #[test]
    fn reads_firefox_places_sqlite_bookmarks_and_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        let places = dir.path().join("places.sqlite");
        let conn = Connection::open(&places).expect("create places");
        conn.execute_batch(
            "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER DEFAULT 0);
             CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT, dateAdded INTEGER);
             INSERT INTO moz_places (id, url, title, visit_count, last_visit_date, hidden) VALUES (1, 'https://mozilla.org/', 'Mozilla', 12, 1700000000000000, 0);
             INSERT INTO moz_bookmarks (id, type, fk, title, dateAdded) VALUES (10, 1, 1, 'Mozilla Home', 1700000000000000);",
        )
        .expect("seed places");
        drop(conn);

        let (bm, hist) = read_firefox_places(&places, true, true).expect("read places");
        assert_eq!(bm.len(), 1);
        assert_eq!(bm[0].title, "Mozilla Home");
        assert_eq!(hist.len(), 1);
        assert_eq!(hist[0].visit_count, 12);
    }

    #[test]
    fn parses_netscape_bookmark_html_with_entities() {
        let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
        <DL><p>
          <DT><H3>Work &amp; Tools</H3>
          <DL><p>
            <DT><A HREF="https://github.com/?tab=repositories&amp;q=dimo" ADD_DATE="1700000000">GitHub &lt;Repo&gt;</A>
          </DL><p>
        </DL><p>"#;
        let items = parse_netscape_bookmarks_html(html);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].folder, "Work & Tools");
        assert_eq!(items[0].title, "GitHub <Repo>");
        assert_eq!(items[0].url, "https://github.com/?tab=repositories&q=dimo");
    }

    #[test]
    fn parses_rfc4180_password_csv_with_bom_quotes_commas_and_chinese_headers() {
        let csv = "\u{feff}名称,网址,用户名,密码,备注\r\n\
        \"GitHub, Inc.\",https://github.com/login,alice@example.com,\"p@ss\"\"word,123\",\"line1\nline2\"\r\n\
        Safari,https://appleid.apple.com/,bob,secret2,\r\n";
        let creds = parse_passwords_csv(csv, "chrome-csv").expect("parse csv");
        assert_eq!(creds.len(), 2);
        assert_eq!(creds[0].name, "GitHub, Inc.");
        assert_eq!(creds[0].password, "p@ss\"word,123");
        assert_eq!(creds[0].note, "line1\nline2");
        assert_eq!(creds[1].username, "bob");
    }
}
