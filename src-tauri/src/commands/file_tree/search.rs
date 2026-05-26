use std::path::Path;

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use super::listing::{is_special_dir, normalize_path, should_skip_dir};
use crate::error::AppError;

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchMatch {
    pub line: usize,
    pub column: usize,
    pub end_column: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchFileResult {
    pub path: String,
    pub match_count: usize,
    pub matches: Vec<TextSearchMatch>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchResponse {
    pub files: Vec<TextSearchFileResult>,
    pub file_count: usize,
    pub match_count: usize,
    pub limit_hit: bool,
}

#[derive(Debug, Deserialize)]
pub struct TextSearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
}

const MAX_SEARCH_MATCHES: usize = 1_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1_024 * 1_024;
const MAX_PREVIEW_CHARS: usize = 180;

pub(super) fn search_workspace_text_at_path(
    root_path: &str,
    options: TextSearchOptions,
) -> Result<TextSearchResponse, AppError> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Root path is not a directory: {}",
            root_path
        )));
    }

    let regex = compile_search_regex(&options.query, &options).map_err(AppError::BadRequest)?;
    let include_patterns =
        compile_globs(options.include_pattern.as_deref()).map_err(AppError::BadRequest)?;
    let exclude_patterns =
        compile_globs(options.exclude_pattern.as_deref()).map_err(AppError::BadRequest)?;

    let root_for_filter = root.to_path_buf();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if should_skip_dir(&name) {
                    return false;
                }
                if let Ok(rel) = entry.path().strip_prefix(&root_for_filter) {
                    let normalized = normalize_path(&rel.to_string_lossy());
                    if !normalized.is_empty()
                        && is_special_dir(normalized.rsplit('/').next().unwrap_or(""))
                    {
                        return false;
                    }
                }
            }
            name != ".DS_Store"
        })
        .build();

    let mut files = Vec::new();
    let mut total_files = 0usize;
    let mut total_matches = 0usize;
    let mut limit_hit = false;

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let normalized = normalize_path(&rel_path.to_string_lossy());
        if normalized.is_empty() {
            continue;
        }
        if !include_patterns.is_empty() && !matches_any(&normalized, &include_patterns) {
            continue;
        }
        if !exclude_patterns.is_empty() && matches_any(&normalized, &exclude_patterns) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut file_matches = Vec::new();
        let mut file_match_count = 0usize;

        for (line_idx, line) in content.lines().enumerate() {
            for capture in regex.find_iter(line) {
                file_match_count += 1;
                total_matches += 1;
                if file_matches.len() < 50 {
                    file_matches.push(TextSearchMatch {
                        line: line_idx + 1,
                        column: line[..capture.start()].chars().count() + 1,
                        end_column: line[..capture.end()].chars().count() + 1,
                        preview: build_preview(line, capture.start(), capture.end()),
                    });
                }
                if total_matches >= MAX_SEARCH_MATCHES {
                    limit_hit = true;
                    break;
                }
            }
            if limit_hit {
                break;
            }
        }

        if file_match_count > 0 {
            total_files += 1;
            files.push(TextSearchFileResult {
                path: normalized,
                match_count: file_match_count,
                matches: file_matches,
            });
        }
        if limit_hit {
            break;
        }
    }

    Ok(TextSearchResponse {
        files,
        file_count: total_files,
        match_count: total_matches,
        limit_hit,
    })
}

fn compile_search_regex(query: &str, options: &TextSearchOptions) -> Result<Regex, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Search query cannot be empty.".to_string());
    }
    if trimmed.len() > 1000 {
        return Err("Search pattern too long (max 1000 characters).".to_string());
    }
    let pattern = if options.is_regex {
        trimmed.to_string()
    } else {
        regex::escape(trimmed)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{})\b", pattern)
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| format!("Invalid search pattern: {error}"))
}

fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    let normalized = pattern
        .replace('\\', "/")
        .trim()
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        return Err("Glob pattern cannot be empty.".to_string());
    }
    let mut regex_src = String::from("^");
    let chars: Vec<char> = normalized.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1).copied() == Some('*') {
                regex_src.push_str(".*");
                i += 2;
                continue;
            }
            regex_src.push_str("[^/]*");
            i += 1;
            continue;
        }
        if c == '?' {
            regex_src.push_str("[^/]");
            i += 1;
            continue;
        }
        if matches!(
            c,
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\'
        ) {
            regex_src.push('\\');
        }
        regex_src.push(c);
        i += 1;
    }
    regex_src.push('$');
    Regex::new(&regex_src).map_err(|e| format!("Invalid glob `{pattern}`: {e}"))
}

fn compile_globs(input: Option<&str>) -> Result<Vec<Regex>, String> {
    match input {
        None => Ok(Vec::new()),
        Some(s) => s
            .split([',', '\n'])
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(glob_to_regex)
            .collect(),
    }
}

fn matches_any(path: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|p| p.is_match(path))
}

fn build_preview(line: &str, start: usize, end: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_PREVIEW_CHARS {
        return line.trim().to_string();
    }
    let start_char = line[..start].chars().count();
    let end_char = line[..end].chars().count();
    let context = MAX_PREVIEW_CHARS / 2;
    let slice_start = start_char.saturating_sub(context / 2);
    let slice_end = (end_char + context).min(chars.len());
    let mut preview: String = chars[slice_start..slice_end].iter().collect();
    if slice_start > 0 {
        preview = format!("...{preview}");
    }
    if slice_end < chars.len() {
        preview.push_str("...");
    }
    preview.trim().to_string()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{TextSearchOptions, search_workspace_text_at_path};
    use crate::error::AppError;

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vibex-search-{prefix}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn options(query: &str) -> TextSearchOptions {
        TextSearchOptions {
            query: query.to_string(),
            case_sensitive: false,
            whole_word: false,
            is_regex: false,
            include_pattern: None,
            exclude_pattern: None,
        }
    }

    #[test]
    fn search_workspace_text_rejects_empty_query() {
        let root = create_temp_dir("empty-query");
        let error = search_workspace_text_at_path(&path_string(&root), options("   ")).unwrap_err();
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("Search query cannot be empty"));
    }

    #[test]
    fn search_workspace_text_honors_include_exclude_and_skips_binary_files() {
        let root = create_temp_dir("filters");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("keep.txt"), "Alpha here").unwrap();
        fs::write(root.join("src").join("skip.md"), "Alpha here").unwrap();
        fs::write(root.join("binary.txt"), b"Alpha\0here").unwrap();

        let mut search = options("alpha");
        search.include_pattern = Some("*.txt,**/*.md".to_string());
        search.exclude_pattern = Some("src/**".to_string());

        let response = search_workspace_text_at_path(&path_string(&root), search).unwrap();
        let _ = fs::remove_dir_all(&root);

        let paths: Vec<_> = response
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, vec!["keep.txt"]);
        assert_eq!(response.match_count, 1);
    }

    #[test]
    fn search_workspace_text_prunes_special_directories() {
        let root = create_temp_dir("special-dir");
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(
            root.join("node_modules").join("pkg").join("index.js"),
            "needle",
        )
        .unwrap();
        fs::write(root.join("app.js"), "needle").unwrap();

        let response =
            search_workspace_text_at_path(&path_string(&root), options("needle")).unwrap();
        let _ = fs::remove_dir_all(&root);

        let paths: Vec<_> = response
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, vec!["app.js"]);
    }

    #[test]
    fn search_workspace_text_supports_whole_word_matching() {
        let root = create_temp_dir("whole-word");
        fs::write(root.join("words.txt"), "cat catalog cat").unwrap();
        let mut search = options("cat");
        search.whole_word = true;

        let response = search_workspace_text_at_path(&path_string(&root), search).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(response.file_count, 1);
        assert_eq!(response.match_count, 2);
        assert_eq!(response.files[0].matches[0].column, 1);
        assert_eq!(response.files[0].matches[1].column, 13);
    }
}
