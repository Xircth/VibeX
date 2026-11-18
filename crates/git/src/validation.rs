use crate::GitCliError;

pub fn is_valid_branch_prefix(prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }

    git2::Branch::name_is_valid(&format!("{prefix}/x")).unwrap_or_default()
}

pub(crate) fn validate_cli_arg<'a>(value: &'a str, label: &str) -> Result<&'a str, GitCliError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git {label}: value cannot be empty"
        )));
    }
    if value.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git {label}: control characters are not allowed"
        )));
    }
    if trimmed.starts_with('-') {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git {label}: leading '-' is not allowed"
        )));
    }
    Ok(trimmed)
}

pub(crate) fn validate_branch_name(branch: &str) -> Result<&str, GitCliError> {
    let trimmed = validate_cli_arg(branch, "branch name")?;
    if trimmed.chars().any(char::is_whitespace)
        || !git2::Branch::name_is_valid(trimmed).unwrap_or(false)
    {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git branch name: {trimmed}"
        )));
    }
    Ok(trimmed)
}

pub(crate) fn validate_ref_or_sha<'a>(value: &'a str, label: &str) -> Result<&'a str, GitCliError> {
    let trimmed = validate_cli_arg(value, label)?;
    if trimmed.chars().any(char::is_whitespace) {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git {label}: whitespace is not allowed"
        )));
    }
    Ok(trimmed)
}

pub(crate) fn validate_remote_name(remote: &str) -> Result<&str, GitCliError> {
    let trimmed = validate_cli_arg(remote, "remote name")?;
    if trimmed.chars().any(char::is_whitespace) || trimmed.contains("..") {
        return Err(GitCliError::CommandFailed(format!(
            "invalid git remote name: {trimmed}"
        )));
    }
    Ok(trimmed)
}

pub(crate) fn validate_remote_url(url: &str) -> Result<&str, GitCliError> {
    let trimmed = validate_cli_arg(url, "remote URL")?;
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("ext::")
        || lower.starts_with("fd::")
        || lower.starts_with("remote-ext::")
    {
        return Err(GitCliError::CommandFailed(format!(
            "unsafe git remote transport is not allowed: {trimmed}"
        )));
    }
    Ok(trimmed)
}

pub(crate) fn validate_reset_mode(mode: &str) -> Result<&'static str, GitCliError> {
    match mode.trim() {
        "soft" => Ok("soft"),
        "mixed" => Ok("mixed"),
        "hard" => Ok("hard"),
        "merge" => Ok("merge"),
        "keep" => Ok("keep"),
        _ => Err(GitCliError::CommandFailed(format!(
            "unsupported git reset mode: {mode}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_prefixes() {
        assert!(is_valid_branch_prefix(""));
        assert!(is_valid_branch_prefix("vu"));
        assert!(is_valid_branch_prefix("vx"));
        assert!(is_valid_branch_prefix("feature"));
        assert!(is_valid_branch_prefix("hotfix-123"));
        assert!(is_valid_branch_prefix("foo.bar"));
        assert!(is_valid_branch_prefix("foo_bar"));
        assert!(is_valid_branch_prefix("FOO-Bar"));
    }

    #[test]
    fn test_invalid_prefixes() {
        assert!(is_valid_branch_prefix("foo/bar"));
        assert!(!is_valid_branch_prefix("foo//bar"));
        assert!(!is_valid_branch_prefix("foo/.bar"));
        assert!(!is_valid_branch_prefix("foo.lock/bar"));
        assert!(!is_valid_branch_prefix("foo..bar"));
        assert!(!is_valid_branch_prefix("foo@{"));
        assert!(!is_valid_branch_prefix("foo.lock"));
        // Note: git2 allows trailing dots in some contexts, but we enforce stricter rules
        // for prefixes by checking the full branch name format
        assert!(!is_valid_branch_prefix("foo bar"));
        assert!(!is_valid_branch_prefix("foo?"));
        assert!(!is_valid_branch_prefix("foo*"));
        assert!(!is_valid_branch_prefix("foo~"));
        assert!(!is_valid_branch_prefix("foo^"));
        assert!(!is_valid_branch_prefix("foo:"));
        assert!(!is_valid_branch_prefix("foo["));
        assert!(!is_valid_branch_prefix("/foo"));
        assert!(!is_valid_branch_prefix("foo/"));
        assert!(!is_valid_branch_prefix(".foo"));
    }

    #[test]
    fn cli_validators_reject_option_injection_and_ext_urls() {
        assert!(validate_branch_name("--upload-pack=evil").is_err());
        assert!(validate_branch_name("-b").is_err());
        assert!(validate_branch_name("feature/ok-1").is_ok());

        assert!(validate_remote_url("--upload-pack=touch /tmp/pwn").is_err());
        assert!(validate_remote_url("ext::sh -c id").is_err());
        assert!(validate_remote_url("EXT::sh -c id").is_err());
        assert!(validate_remote_url("fd::1").is_err());
        assert!(validate_remote_url("https://github.com/org/repo.git").is_ok());

        assert!(validate_reset_mode("hard").is_ok());
        assert!(validate_reset_mode("soft --exec=evil").is_err());
        assert!(validate_ref_or_sha("--output=/tmp/evil", "commit").is_err());
    }
}
