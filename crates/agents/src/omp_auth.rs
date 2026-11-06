//! OMP keeps live credentials in `agent.db`, not the empty `auth.json`.
//! Custom endpoints may also store a literal `apiKey` in `models.yml`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use rusqlite::OpenFlags;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OmpCredentialPresence {
    pub account: bool,
    pub api_key: bool,
}

impl OmpCredentialPresence {
    pub fn any(self) -> bool {
        self.account || self.api_key
    }
}

pub fn agent_dir(home: &Path, environment: &BTreeMap<String, String>) -> PathBuf {
    let explicit = environment
        .get("PI_CODING_AGENT_DIR")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| crate::pi_trust::expand_pi_home(value, home));
    match explicit {
        Some(dir) if !is_pi_agent_dir(home, &dir) => dir,
        _ => home.join(".omp").join("agent"),
    }
}

fn is_pi_agent_dir(home: &Path, dir: &Path) -> bool {
    dir == home.join(".pi").join("agent")
}

pub fn credential_presence(agent_dir: &Path) -> OmpCredentialPresence {
    let mut presence = sqlite_presence(&agent_dir.join("agent.db"));
    if models_yml_has_api_key(&agent_dir.join("models.yml")) {
        presence.api_key = true;
    }
    presence
}

fn sqlite_presence(path: &Path) -> OmpCredentialPresence {
    let connection =
        match rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(connection) => connection,
            Err(_) => return OmpCredentialPresence::default(),
        };
    let mut statement = match connection
        .prepare("SELECT credential_type FROM auth_credentials WHERE disabled_cause IS NULL")
    {
        Ok(statement) => statement,
        Err(_) => return OmpCredentialPresence::default(),
    };
    let rows = match statement.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return OmpCredentialPresence::default(),
    };
    let mut presence = OmpCredentialPresence::default();
    for kind in rows.flatten() {
        match kind.as_str() {
            "oauth" => presence.account = true,
            "api_key" => presence.api_key = true,
            _ => {}
        }
    }
    presence
}

fn models_yml_has_api_key(path: &Path) -> bool {
    models_yml_api_key(path).unwrap_or(false)
}

fn models_yml_api_key(path: &Path) -> Option<bool> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
    let providers = value
        .get("providers")
        .and_then(serde_yaml::Value::as_mapping)?;
    Some(providers.values().any(|provider| {
        provider
            .get("apiKey")
            .and_then(serde_yaml::Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
    }))
}

pub fn account_label(agent_dir: &Path) -> Option<String> {
    sqlite_account_label(&agent_dir.join("agent.db"))
}

fn sqlite_account_label(path: &Path) -> Option<String> {
    let connection =
        rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let queries = [
        "SELECT provider, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL AND credential_type = 'oauth' ORDER BY updated_at DESC, id DESC",
        "SELECT provider, data, identity_key FROM auth_credentials WHERE disabled_cause IS NULL AND credential_type = 'oauth'",
        "SELECT provider, NULL, NULL FROM auth_credentials WHERE disabled_cause IS NULL AND credential_type = 'oauth'",
    ];
    for sql in queries {
        let Ok(mut statement) = connection.prepare(sql) else {
            continue;
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0).ok().flatten(),
                row.get::<_, Option<String>>(1).ok().flatten(),
                row.get::<_, Option<String>>(2).ok().flatten(),
            ))
        }) else {
            continue;
        };
        let mut fallback_provider = None;
        for (provider, data, identity_key) in rows.flatten() {
            if let Some(raw_data) = data.as_deref()
                && let Some(label) = extract_omp_oauth_data_label(raw_data)
            {
                return Some(label);
            }
            if let Some(raw_key) = identity_key.as_deref()
                && let Some(label) = normalize_omp_identity_key(raw_key)
            {
                return Some(label);
            }
            if fallback_provider.is_none() {
                fallback_provider = provider
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
            }
        }
        if fallback_provider.is_some() {
            return fallback_provider;
        }
    }
    None
}

fn extract_omp_oauth_data_label(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    extract_identity_from_json(&value)
}

fn extract_identity_from_json(value: &serde_json::Value) -> Option<String> {
    for key in [
        "email",
        "emailAddress",
        "preferred_username",
        "name",
        "username",
        "account_id",
        "accountId",
    ] {
        if let Some(text) = value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return Some(text.to_string());
        }
    }
    for nested_key in ["user", "account", "profile", "oauthAccount"] {
        if let Some(nested) = value.get(nested_key)
            && let Some(found) = extract_identity_from_json(nested)
        {
            return Some(found);
        }
    }
    for token_key in [
        "id_token",
        "idToken",
        "access",
        "access_token",
        "accessToken",
        "token",
    ] {
        if let Some(token) = value.get(token_key).and_then(serde_json::Value::as_str)
            && let Some(identity) = crate::account_session::jwt_identity(token)
        {
            return Some(identity);
        }
    }
    None
}

fn normalize_omp_identity_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed
        .strip_prefix("email:")
        .or_else(|| trimmed.strip_prefix("EMAIL:"))
    {
        let email = rest.trim();
        if !email.is_empty() {
            return Some(email.to_string());
        }
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_oauth_and_api_key_are_live_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("agent.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE auth_credentials (
                    credential_type TEXT NOT NULL,
                    disabled_cause TEXT
                );
                INSERT INTO auth_credentials (credential_type, disabled_cause) VALUES ('oauth', NULL);
                INSERT INTO auth_credentials (credential_type, disabled_cause) VALUES ('api_key', 'revoked');",
            )
            .unwrap();

        let presence = credential_presence(temp.path());
        assert!(presence.account);
        assert!(!presence.api_key);
    }

    #[test]
    fn models_yml_api_key_counts_without_sqlite() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("models.yml"),
            "providers:\n  local:\n    apiKey: sk-test\n",
        )
        .unwrap();

        let presence = credential_presence(temp.path());
        assert!(!presence.account);
        assert!(presence.api_key);
    }

    #[test]
    fn agent_dir_ignores_pi_home_and_process_env() {
        let home = Path::new("/tmp/vibex-home");
        let pi = home.join(".pi").join("agent");
        let mut env = BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            pi.to_string_lossy().into_owned(),
        )]);
        assert_eq!(agent_dir(home, &env), home.join(".omp").join("agent"));
        env.insert(
            "PI_CODING_AGENT_DIR".to_string(),
            "/tmp/custom-omp".to_string(),
        );
        assert_eq!(agent_dir(home, &env), PathBuf::from("/tmp/custom-omp"));
        env.clear();
        assert_eq!(agent_dir(home, &env), home.join(".omp").join("agent"));
    }

    #[test]
    fn account_label_extracts_email_identity_key_and_provider_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("agent.db");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE auth_credentials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    credential_type TEXT NOT NULL,
                    data TEXT NOT NULL,
                    identity_key TEXT,
                    disabled_cause TEXT,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO auth_credentials (provider, credential_type, data, identity_key, disabled_cause, updated_at)
                VALUES ('google-antigravity', 'oauth', '{\"access\":\"opaque\",\"email\":\"user@example.com\"}', 'email:user@example.com', NULL, 10);",
            )
            .unwrap();
        assert_eq!(
            account_label(temp.path()).as_deref(),
            Some("user@example.com")
        );

        connection
            .execute_batch(
                "DELETE FROM auth_credentials;
                INSERT INTO auth_credentials (provider, credential_type, data, identity_key, disabled_cause, updated_at)
                VALUES ('openai-codex', 'oauth', '{\"access\":\"opaque\"}', 'email:codex@example.com', NULL, 20);",
            )
            .unwrap();
        assert_eq!(
            account_label(temp.path()).as_deref(),
            Some("codex@example.com")
        );

        connection
            .execute_batch(
                "DELETE FROM auth_credentials;
                INSERT INTO auth_credentials (provider, credential_type, data, identity_key, disabled_cause, updated_at)
                VALUES ('github-copilot', 'oauth', '{\"access\":\"opaque\"}', NULL, NULL, 30);",
            )
            .unwrap();
        assert_eq!(
            account_label(temp.path()).as_deref(),
            Some("github-copilot")
        );
    }
}
