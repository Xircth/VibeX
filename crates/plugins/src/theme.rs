//! Color theme contributions (`themes[]`). The rules mirror
//! `validateThemeContributions` in `packages/plugin-sdk/src/theme.ts`, which
//! the Host and the plugin CLI run; `theme_roles_match_the_sdk_contract` keeps
//! the role tables in step.

use std::collections::HashSet;

use serde_json::{Map, Value};

pub const THEME_COLOR_ROLES: &[&str] = &[
    "background",
    "foreground",
    "chrome",
    "surface",
    "popover",
    "mutedForeground",
    "subtleForeground",
    "faintForeground",
    "border",
    "borderSubtle",
    "control",
    "controlHover",
    "raisedControl",
    "raisedControlHover",
    "track",
    "accent",
    "success",
    "warning",
    "danger",
    "info",
    "terminalBackground",
    "terminalForeground",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxConstant",
    "syntaxString",
    "syntaxVariable",
    "syntaxComment",
    "syntaxTag",
    "syntaxPunctuation",
    "syntaxDeleted",
];

pub const REQUIRED_THEME_COLOR_ROLES: &[&str] = &["background", "foreground"];

/// Roles painted as solid fills or text.
pub const OPAQUE_THEME_COLOR_ROLES: &[&str] = &[
    "background",
    "foreground",
    "chrome",
    "surface",
    "popover",
    "accent",
    "terminalBackground",
];

const THEME_FIELDS: &[&str] = &["id", "label", "scheme", "colors"];
const THEME_ID_MAX_LENGTH: usize = 63;
const THEME_LABEL_MAX_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeIssue {
    pub path: String,
    pub message: String,
}

impl ThemeIssue {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

fn is_theme_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= THEME_ID_MAX_LENGTH
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn hex_digits(color: &str) -> Option<usize> {
    let digits = color.strip_prefix('#')?;
    (matches!(digits.len(), 3 | 6 | 8) && digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(digits.len())
}

fn validate_colors(colors: &Map<String, Value>, path: &str, issues: &mut Vec<ThemeIssue>) {
    for role in REQUIRED_THEME_COLOR_ROLES {
        if !colors.contains_key(*role) {
            issues.push(ThemeIssue::new(
                format!("{path}.colors.{role}"),
                "is required",
            ));
        }
    }
    for (role, color) in colors {
        let role_path = format!("{path}.colors.{role}");
        if !THEME_COLOR_ROLES.contains(&role.as_str()) {
            issues.push(ThemeIssue::new(role_path, "is not a theme color role"));
            continue;
        }
        match color.as_str().and_then(hex_digits) {
            None => issues.push(ThemeIssue::new(
                role_path,
                "must be a hex color (#rgb, #rrggbb, or #rrggbbaa)",
            )),
            Some(8) if OPAQUE_THEME_COLOR_ROLES.contains(&role.as_str()) => {
                issues.push(ThemeIssue::new(role_path, "must be opaque"));
            }
            Some(_) => {}
        }
    }
}

pub fn validate_theme_definition(value: &Value, path: &str) -> Vec<ThemeIssue> {
    let Some(theme) = value.as_object() else {
        return vec![ThemeIssue::new(path, "must be an object")];
    };
    let mut issues = Vec::new();
    for key in theme.keys() {
        if !THEME_FIELDS.contains(&key.as_str()) {
            issues.push(ThemeIssue::new(
                format!("{path}.{key}"),
                "is not a theme field",
            ));
        }
    }
    if !theme
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(is_theme_id)
    {
        issues.push(ThemeIssue::new(
            format!("{path}.id"),
            "must be lowercase letters, digits, and hyphens",
        ));
    }
    let label_fits = theme
        .get("label")
        .and_then(Value::as_str)
        .is_some_and(|label| {
            !label.trim().is_empty() && label.encode_utf16().count() <= THEME_LABEL_MAX_LENGTH
        });
    if !label_fits {
        issues.push(ThemeIssue::new(
            format!("{path}.label"),
            format!("must be 1-{THEME_LABEL_MAX_LENGTH} characters"),
        ));
    }
    if !matches!(
        theme.get("scheme").and_then(Value::as_str),
        Some("light" | "dark")
    ) {
        issues.push(ThemeIssue::new(
            format!("{path}.scheme"),
            "must be light or dark",
        ));
    }
    match theme.get("colors").and_then(Value::as_object) {
        Some(colors) => validate_colors(colors, path, &mut issues),
        None => issues.push(ThemeIssue::new(
            format!("{path}.colors"),
            "must be an object",
        )),
    }
    issues
}

/// Every problem in a manifest's `themes` value, in one pass.
pub fn validate_theme_contributions(value: &Value) -> Vec<ThemeIssue> {
    let Some(entries) = value.as_array() else {
        return vec![ThemeIssue::new("themes", "must be an array")];
    };
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let entry_path = format!("themes[{index}]");
        issues.extend(validate_theme_definition(entry, &entry_path));
        if let Some(id) = entry.get("id").and_then(Value::as_str)
            && !seen.insert(id)
        {
            issues.push(ThemeIssue::new(format!("{entry_path}.id"), "is duplicated"));
        }
    }
    issues
}

pub(crate) fn theme_issues_message(issues: &[ThemeIssue]) -> String {
    let details = issues
        .iter()
        .map(|issue| format!("{} {}", issue.path, issue.message))
        .collect::<Vec<_>>()
        .join("; ");
    format!("invalid themes: {details}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_a_minimal_theme() {
        let themes = json!([{
            "id": "ayu-dark",
            "label": "Ayu Dark",
            "scheme": "dark",
            "colors": { "background": "#0b0e14", "foreground": "#bfbdb6", "borderSubtle": "#ffffff1a" }
        }]);
        assert!(validate_theme_contributions(&themes).is_empty());
    }

    #[test]
    fn reports_every_issue_in_one_pass() {
        let themes = json!([
            {
                "id": "Bad Id",
                "label": "",
                "scheme": "dim",
                "cssVariables": {},
                "colors": { "foreground": "red", "surface": "#ffffff80", "glow": "#fff" }
            },
            { "id": "dupe", "label": "A", "scheme": "light", "colors": { "background": "#fff", "foreground": "#000" } },
            { "id": "dupe", "label": "B", "scheme": "light", "colors": { "background": "#fff", "foreground": "#000" } }
        ]);
        let paths = validate_theme_contributions(&themes)
            .into_iter()
            .map(|issue| format!("{} {}", issue.path, issue.message))
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                "themes[0].cssVariables is not a theme field",
                "themes[0].id must be lowercase letters, digits, and hyphens",
                "themes[0].label must be 1-64 characters",
                "themes[0].scheme must be light or dark",
                "themes[0].colors.background is required",
                "themes[0].colors.foreground must be a hex color (#rgb, #rrggbb, or #rrggbbaa)",
                "themes[0].colors.surface must be opaque",
                "themes[0].colors.glow is not a theme color role",
                "themes[2].id is duplicated",
            ]
        );
    }

    #[test]
    fn theme_roles_match_the_sdk_contract() {
        let source = include_str!("../../../packages/plugin-sdk/src/theme.ts");
        let roles_for = |name: &str| -> Vec<String> {
            let start = source
                .find(&format!("export const {name} = ["))
                .unwrap_or_else(|| panic!("{name} is missing from theme.ts"));
            let body = &source[start..];
            let body = &body[body.find('[').unwrap() + 1..body.find(']').unwrap()];
            body.split(',')
                .map(|role| role.trim().trim_matches('\'').to_owned())
                .filter(|role| !role.is_empty())
                .collect()
        };
        assert_eq!(roles_for("THEME_COLOR_ROLES"), THEME_COLOR_ROLES);
        assert_eq!(
            roles_for("REQUIRED_THEME_COLOR_ROLES"),
            REQUIRED_THEME_COLOR_ROLES
        );
        assert_eq!(
            roles_for("OPAQUE_THEME_COLOR_ROLES"),
            OPAQUE_THEME_COLOR_ROLES
        );
    }
}
