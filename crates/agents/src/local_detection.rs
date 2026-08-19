//! Legacy package/version parsing helpers.
//!
//! Installation truth is the user environment: PATH, npm global prefix, uv
//! tools and the user bin. The Installation lock records the last successful
//! observation of those paths; it is not a second, VibeX-owned install.

use std::path::{Path, PathBuf};

/// Compare dotted numeric versions segment-wise ("v24.16.0", "uv 0.11.28
/// (ebf0f43d7 2026-07-07)" and similar decorated outputs are tolerated).
/// Missing segments count as 0. Non-numeric tails are ignored.
pub fn version_at_least(found: &str, required: &str) -> bool {
    let found = extract_version_segments(found);
    let required = extract_version_segments(required);
    if found.is_empty() {
        return false;
    }
    for i in 0..found.len().max(required.len()) {
        let f = found.get(i).copied().unwrap_or(0);
        let r = required.get(i).copied().unwrap_or(0);
        if f != r {
            return f > r;
        }
    }
    true
}

/// Pull the first dotted-number run out of arbitrary version output.
fn extract_version_segments(raw: &str) -> Vec<u64> {
    let start = match raw.find(|c: char| c.is_ascii_digit()) {
        Some(index) => index,
        None => return Vec::new(),
    };
    raw[start..]
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("")
        .split('.')
        .map_while(|segment| segment.parse::<u64>().ok())
        .collect()
}

/// The npm package name of a versioned spec (`@scope/name@1.2.3` → `@scope/name`).
pub fn npm_package_name(package_spec: &str) -> String {
    if let Some(stripped) = package_spec.strip_prefix('@') {
        return stripped
            .rfind('@')
            .map(|index| format!("@{}", &stripped[..index]))
            .unwrap_or_else(|| package_spec.to_string());
    }
    package_spec
        .split_once('@')
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| package_spec.to_string())
}

/// Where a globally-installed npm package would live under `npm root -g`.
pub fn npm_global_package_dir(npm_global_root: &str, package_spec: &str) -> PathBuf {
    npm_package_name(package_spec)
        .split('/')
        .fold(Path::new(npm_global_root).to_path_buf(), |path, segment| {
            path.join(segment)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison_is_numeric_not_lexical() {
        // "0.11.28" < "0.5.0" lexically — the classic trap.
        assert!(version_at_least("0.11.28", "0.5.0"));
        assert!(version_at_least("v24.16.0", "22.19.0"));
        assert!(version_at_least("1.2", "1.2.0"));
        assert!(!version_at_least("1.2", "1.2.1"));
        assert!(version_at_least(
            "uv 0.11.28 (ebf0f43d7 2026-07-07)",
            "0.5.0"
        ));
        assert!(!version_at_least("garbage", "1.0.0"));
        assert!(version_at_least("10.0.0", "9.99.99"));
    }

    #[test]
    fn npm_package_paths_handle_scopes() {
        assert_eq!(
            npm_package_name("@google/gemini-cli@0.45.2"),
            "@google/gemini-cli"
        );
        assert_eq!(npm_package_name("opencode-ai@1.17.11"), "opencode-ai");
        assert_eq!(npm_package_name("@openai/codex"), "@openai/codex");
        assert_eq!(
            npm_global_package_dir("/g/root", "@google/gemini-cli@0.45.2"),
            Path::new("/g/root").join("@google").join("gemini-cli")
        );
    }
}
