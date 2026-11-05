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
}
