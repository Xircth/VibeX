//! Antigravity ACP auth: the server reads `auth.type` from
//! `$GEMINI_HOME/antigravity-acp/settings.json`, not from the process
//! environment. VibeX records the panel choice as `AGY_AUTH_METHOD` and
//! projects it into that file on save and launch.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

const AUTH_METHOD_ENV: &str = "AGY_AUTH_METHOD";
const ACP_SUBDIR: &str = "antigravity-acp";

pub const AUTH_METHODS: &[&str] = &[
    "oauth-personal",
    "oauth-business",
    "gemini-api-key",
    "agent-platform",
];

const CREDENTIAL_ENV_VARS: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySyncStatus {
    Written,
    AlreadyCurrent,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntigravitySyncReport {
    pub path: PathBuf,
    pub status: AntigravitySyncStatus,
    pub reason: Option<String>,
}

enum GcpField<'a> {
    Keep,
    Set(&'a str),
    Clear,
}

pub fn recorded_auth_method(env: &HashMap<String, String>) -> Option<&str> {
    let method = env
        .get(AUTH_METHOD_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if method == "model_provider" {
        return Some("gemini-api-key");
    }
    AUTH_METHODS.contains(&method).then_some(method)
}

fn credential_env_for_method(method: &str) -> &'static [&'static str] {
    match method {
        "gemini-api-key" => &["GEMINI_API_KEY"],
        "agent-platform" => &[
            "GOOGLE_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
        ],
        _ => &[],
    }
}

/// Clear inherited credential vars the chosen method does not consume.
pub fn apply_antigravity_env_policy(env: &mut HashMap<String, String>) {
    let Some(method) = recorded_auth_method(env) else {
        return;
    };
    let keep = credential_env_for_method(method);
    for key in CREDENTIAL_ENV_VARS {
        let kept =
            keep.contains(key) && env.get(*key).is_some_and(|value| !value.trim().is_empty());
        if kept {
            continue;
        }
        env.remove(*key);
    }
}

pub fn resolve_gemini_home(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> Result<PathBuf, String> {
    let configured = env
        .get("GEMINI_HOME")
        .map(String::as_str)
        .filter(|value| !value.is_empty());
    let needs_home = configured
        .is_none_or(|value| value == "~" || value.starts_with("~/") || value.starts_with("~\\"));
    if needs_home && process_home.is_none() {
        return Err(
            "cannot tell which home directory Antigravity will use, so the auth file cannot be named"
                .to_string(),
        );
    }
    Ok(resolve_gemini_home_from(configured, process_home))
}

pub fn resolve_gemini_home_from(configured: Option<&str>, home: Option<&Path>) -> PathBuf {
    match configured.filter(|value| !value.is_empty()) {
        Some(value) => expand_home_prefix(value, home),
        None => home.unwrap_or_else(|| Path::new(".")).join(".gemini"),
    }
}

pub fn antigravity_acp_dir(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> Result<PathBuf, String> {
    Ok(resolve_gemini_home(env, process_home)?.join(ACP_SUBDIR))
}

fn expand_home_prefix(value: &str, home: Option<&Path>) -> PathBuf {
    if value == "~" {
        return home.unwrap_or_else(|| Path::new(".")).to_path_buf();
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.unwrap_or_else(|| Path::new(".")).join(relative);
    }
    PathBuf::from(value)
}

fn gcp_field<'a>(
    env: &'a HashMap<String, String>,
    recorded_method: Option<&str>,
    key: &str,
) -> GcpField<'a> {
    let value = env
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match value {
        Some(value) => GcpField::Set(value),
        None if matches!(recorded_method, Some("oauth-business" | "agent-platform")) => {
            GcpField::Clear
        }
        None => GcpField::Keep,
    }
}

pub fn sync_antigravity_settings(
    env: &HashMap<String, String>,
    process_home: Option<&Path>,
) -> AntigravitySyncReport {
    let recorded = recorded_auth_method(env);
    let acp_dir = match antigravity_acp_dir(env, process_home) {
        Ok(dir) => dir,
        Err(reason) => {
            return AntigravitySyncReport {
                path: PathBuf::from("<unknown>"),
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    let path = acp_dir.join("settings.json");
    let existing = match read_settings(&path) {
        Ok(existing) => existing,
        Err(reason) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    let existing_auth_type = existing
        .as_ref()
        .and_then(|root| root.get("auth"))
        .and_then(|auth| auth.get("type"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let method = match (recorded, existing_auth_type) {
        (Some(method), _) => method,
        (None, Some(_)) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::AlreadyCurrent,
                reason: None,
            };
        }
        (None, None) => "oauth-personal",
    };
    let gcp_project = gcp_field(env, recorded, "GOOGLE_CLOUD_PROJECT");
    let gcp_location = gcp_field(env, recorded, "GOOGLE_CLOUD_LOCATION");
    let updated = match merge_settings(existing, method, gcp_project, gcp_location) {
        Ok(Some(updated)) => updated,
        Ok(None) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::AlreadyCurrent,
                reason: None,
            };
        }
        Err(reason) => {
            return AntigravitySyncReport {
                path,
                status: AntigravitySyncStatus::Skipped,
                reason: Some(reason),
            };
        }
    };
    match write_settings(&acp_dir, &path, &updated) {
        Ok(()) => AntigravitySyncReport {
            path,
            status: AntigravitySyncStatus::Written,
            reason: None,
        },
        Err(err) => AntigravitySyncReport {
            path,
            status: AntigravitySyncStatus::Skipped,
            reason: Some(format!("could not write it ({err})")),
        },
    }
}

fn read_settings(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("could not read it ({err})")),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|err| {
        format!("it is not strict JSON and cannot be rewritten without losing content ({err})")
    })?;
    if !parsed.is_object() {
        return Err("it does not hold a JSON object".to_string());
    }
    Ok(Some(parsed))
}

fn write_settings(acp_dir: &Path, path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let parent = target.parent().unwrap_or(acp_dir);
    std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    let temp = parent.join(format!(".settings.json.vibex-{}.tmp", std::process::id()));
    std::fs::write(&temp, format!("{body}\n")).map_err(|err| err.to_string())?;
    if let Err(err) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(err.to_string());
    }
    Ok(())
}

fn merge_settings(
    existing: Option<serde_json::Value>,
    method: &str,
    gcp_project: GcpField<'_>,
    gcp_location: GcpField<'_>,
) -> Result<Option<serde_json::Value>, String> {
    let mut root = match existing {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({}),
    };
    let before = root.clone();
    {
        let obj = root
            .as_object_mut()
            .ok_or_else(|| "it does not hold a JSON object".to_string())?;
        match obj.get("auth") {
            None | Some(serde_json::Value::Null) => {
                obj.insert("auth".into(), serde_json::json!({}));
            }
            Some(serde_json::Value::Object(_)) => {}
            Some(_) => return Err("`auth` is not an object".to_string()),
        }
        obj.get_mut("auth")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| "`auth` is not an object".to_string())?
            .insert("type".into(), serde_json::Value::String(method.to_string()));

        let writes =
            matches!(gcp_project, GcpField::Set(_)) || matches!(gcp_location, GcpField::Set(_));
        let clears =
            matches!(gcp_project, GcpField::Clear) || matches!(gcp_location, GcpField::Clear);
        let clearable = clears && obj.get("gcp").is_some_and(serde_json::Value::is_object);
        if writes || clearable {
            match obj.get("gcp") {
                None | Some(serde_json::Value::Null) => {
                    obj.insert("gcp".into(), serde_json::json!({}));
                }
                Some(serde_json::Value::Object(_)) => {}
                Some(_) => return Err("`gcp` is not an object".to_string()),
            }
            let gcp = obj
                .get_mut("gcp")
                .and_then(serde_json::Value::as_object_mut)
                .ok_or_else(|| "`gcp` is not an object".to_string())?;
            for (name, field) in [("project", &gcp_project), ("location", &gcp_location)] {
                match field {
                    GcpField::Set(value) => {
                        gcp.insert(name.into(), serde_json::Value::String((*value).to_string()));
                    }
                    GcpField::Clear => {
                        gcp.remove(name);
                    }
                    GcpField::Keep => {}
                }
            }
            if gcp.is_empty() {
                obj.remove("gcp");
            }
        }
    }
    Ok((root != before).then_some(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(method: &str) -> HashMap<String, String> {
        HashMap::from([(AUTH_METHOD_ENV.to_string(), method.to_string())])
    }

    #[test]
    fn env_policy_scrubs_credentials_the_chosen_method_does_not_use() {
        let mut personal = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "oauth-personal".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
            ("GOOGLE_CLOUD_PROJECT".to_string(), "proj".to_string()),
        ]);
        apply_antigravity_env_policy(&mut personal);
        assert!(!personal.contains_key("GEMINI_API_KEY"));
        assert!(!personal.contains_key("GOOGLE_API_KEY"));
        assert!(!personal.contains_key("GOOGLE_CLOUD_PROJECT"));

        let mut api = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "gemini-api-key".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
        ]);
        apply_antigravity_env_policy(&mut api);
        assert_eq!(api.get("GEMINI_API_KEY").unwrap(), "secret");
        assert!(!api.contains_key("GOOGLE_API_KEY"));

        let mut platform = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "agent-platform".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
        ]);
        apply_antigravity_env_policy(&mut platform);
        assert_eq!(platform.get("GOOGLE_API_KEY").unwrap(), "google");
        assert!(!platform.contains_key("GEMINI_API_KEY"));

        let mut provider = HashMap::from([
            (AUTH_METHOD_ENV.to_string(), "model_provider".to_string()),
            ("GEMINI_API_KEY".to_string(), "secret".to_string()),
            ("GOOGLE_API_KEY".to_string(), "google".to_string()),
        ]);
        apply_antigravity_env_policy(&mut provider);
        assert_eq!(provider.get("GEMINI_API_KEY").unwrap(), "secret");
        assert!(!provider.contains_key("GOOGLE_API_KEY"));
        assert_eq!(recorded_auth_method(&provider), Some("gemini-api-key"));
    }

    #[test]
    fn env_policy_leaves_unrecorded_methods_alone() {
        let mut env = HashMap::from([("GEMINI_API_KEY".to_string(), "secret".to_string())]);
        apply_antigravity_env_policy(&mut env);
        assert_eq!(env.get("GEMINI_API_KEY").unwrap(), "secret");
    }

    #[test]
    fn settings_sync_writes_auth_type_and_preserves_foreign_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = env("oauth-business");
        runtime.insert(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        runtime.insert("GOOGLE_CLOUD_PROJECT".to_string(), "acme".to_string());
        runtime.insert("GOOGLE_CLOUD_LOCATION".to_string(), "global".to_string());
        let report = sync_antigravity_settings(&runtime, None);
        assert_eq!(report.status, AntigravitySyncStatus::Written);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(report.path).unwrap()).unwrap();
        assert_eq!(parsed["auth"]["type"], "oauth-business");
        assert_eq!(parsed["gcp"]["project"], "acme");
        assert_eq!(parsed["gcp"]["location"], "global");

        let second = sync_antigravity_settings(&runtime, None);
        assert_eq!(second.status, AntigravitySyncStatus::AlreadyCurrent);
    }

    #[test]
    fn settings_sync_defaults_oauth_personal_when_nothing_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = HashMap::from([(
            "GEMINI_HOME".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        let report = sync_antigravity_settings(&runtime, None);
        assert_eq!(report.status, AntigravitySyncStatus::Written);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(report.path).unwrap()).unwrap();
        assert_eq!(parsed["auth"]["type"], "oauth-personal");
    }

    #[test]
    fn gemini_home_expands_tilde_against_the_child_home() {
        let home = PathBuf::from("/srv/agy");
        assert_eq!(
            resolve_gemini_home_from(Some("~/profile"), Some(&home)),
            PathBuf::from("/srv/agy/profile")
        );
        assert_eq!(
            resolve_gemini_home_from(None, Some(&home)),
            PathBuf::from("/srv/agy/.gemini")
        );
    }
}
