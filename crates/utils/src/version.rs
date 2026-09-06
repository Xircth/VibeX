/// The current application version from Cargo.toml
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn normalize(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

/// True when `latest` is a higher dotted numeric version than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        normalize(version)
            .split('.')
            .filter_map(|part| {
                let digits: String = part.chars().take_while(|ch| ch.is_ascii_digit()).collect();
                digits.parse().ok()
            })
            .collect()
    }
    let latest = parts(latest);
    let current = parts(current);
    if latest.is_empty() || current.is_empty() {
        return false;
    }
    latest > current
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_detected() {
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(is_newer("v0.3.0", "0.2.9"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        assert!(!is_newer("", "0.2.0"));
        assert!(!is_newer("0.2.1", ""));
    }
}
