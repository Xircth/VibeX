use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    time::Instant,
};

use super::ResolvedManagementProgram;
use crate::host::native::model_providers;

const ACP_LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);
const KIMI_ENV_SCRUB_KEYS: &[&str] = &[
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_MAX_CONTEXT_SIZE",
    "KIMI_MODEL_CAPABILITIES",
];

pub(super) async fn execute_kimi_logout(
    environment: &HashMap<String, String>,
    resolved_program: Option<ResolvedManagementProgram>,
) {
    if let Some(program) = resolved_program {
        send_acp_logout(&program, environment).await;
    }
    let homes = resolve_kimi_home_candidates(environment, dirs::home_dir().as_deref());
    for home in homes {
        if let Err(error) = cleanup_kimi_local_auth(&home).await {
            tracing::warn!(
                path = %home.display(),
                %error,
                "Failed to clean local Kimi authentication state during logout"
            );
        }
    }
}

async fn send_acp_logout(
    program: &ResolvedManagementProgram,
    environment: &HashMap<String, String>,
) {
    let mut command = utils::process::new_hidden_tokio_command(&program.path, &program.args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in KIMI_ENV_SCRUB_KEYS {
        command.env_remove(key);
    }
    for (key, value) in environment {
        if !KIMI_ENV_SCRUB_KEYS.contains(&key.as_str()) {
            command.env(key, value);
        }
    }
    let Ok(mut child) = command.spawn() else {
        tracing::warn!(path = %program.path.display(), "Failed to spawn Kimi ACP process for logout");
        return;
    };
    let Some(mut stdin) = child.stdin.take() else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        return;
    };
    let mut reader = BufReader::new(stdout).lines();
    let deadline = Instant::now() + ACP_LOGOUT_TIMEOUT;

    let init_request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "dimo", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    if write_json_line(&mut stdin, &init_request, deadline).await.is_err() {
        return;
    }
    let _ = wait_for_json_rpc_id(&mut reader, 1, deadline).await;

    let logout_request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "logout",
        "params": {}
    });
    if write_json_line(&mut stdin, &logout_request, deadline).await.is_ok() {
        let _ = wait_for_json_rpc_id(&mut reader, 2, deadline).await;
    }
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
}

async fn write_json_line(
    stdin: &mut tokio::process::ChildStdin,
    payload: &Value,
    deadline: Instant,
) -> Result<(), ()> {
    let mut line = serde_json::to_string(payload).map_err(|_| ())?;
    line.push('\n');
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(());
    }
    tokio::time::timeout(remaining, async {
        stdin.write_all(line.as_bytes()).await.map_err(|_| ())?;
        stdin.flush().await.map_err(|_| ())
    })
    .await
    .map_err(|_| ())?
}

async fn wait_for_json_rpc_id(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: i64,
    deadline: Instant,
) -> bool {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        let Ok(Ok(Some(line))) = tokio::time::timeout(remaining, lines.next_line()).await else {
            return false;
        };
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(expected_id) {
            return true;
        }
    }
}

fn resolve_kimi_home_candidates(
    environment: &HashMap<String, String>,
    user_home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(custom) = environment
        .get("KIMI_CODE_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        dirs.push(PathBuf::from(custom));
    } else if let Some(custom) = std::env::var_os("KIMI_CODE_HOME").filter(|value| !value.is_empty()) {
        dirs.push(PathBuf::from(custom));
    }
    let resolved_user_home = environment
        .get("HOME")
        .or_else(|| environment.get("USERPROFILE"))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| user_home.map(Path::to_path_buf));
    if let Some(home) = resolved_user_home {
        for rel in [".kimi-code", ".kimi"] {
            let candidate = home.join(rel);
            if !dirs.iter().any(|existing| existing == &candidate) {
                dirs.push(candidate);
            }
        }
    }
    dirs
}

async fn cleanup_kimi_local_auth(kimi_home: &Path) -> Result<(), String> {
    let credential_path = kimi_home.join("credentials/kimi-code.json");
    if let Ok(bytes) = tokio::fs::read(&credential_path).await {
        let keep_synthetic = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .is_some_and(|value| model_providers::kimi_credential_is_synthetic(&value));
        if !keep_synthetic {
            if let Err(error) = tokio::fs::remove_file(&credential_path).await
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(format!(
                    "移除 {} 失败：{error}",
                    credential_path.display()
                ));
            }
        }
    }

    let config_path = kimi_home.join("config.toml");
    let Ok(config_text) = tokio::fs::read_to_string(&config_path).await else {
        return Ok(());
    };
    let Ok(mut document) = config_text.parse::<toml::Table>() else {
        return Ok(());
    };
    let mut changed = false;
    if let Some(providers) = document.get_mut("providers").and_then(toml::Value::as_table_mut) {
        changed |= providers.remove("managed:kimi-code").is_some();
    }
    let mut removed_models = Vec::new();
    if let Some(models) = document.get_mut("models").and_then(toml::Value::as_table_mut) {
        let keys_to_remove = models
            .iter()
            .filter_map(|(key, entry)| {
                let points_managed = entry
                    .as_table()
                    .and_then(|table| table.get("provider"))
                    .and_then(toml::Value::as_str)
                    == Some("managed:kimi-code");
                (key.starts_with("managed:kimi-code") || points_managed).then(|| key.clone())
            })
            .collect::<Vec<_>>();
        for key in keys_to_remove {
            if models.remove(&key).is_some() {
                removed_models.push(key);
                changed = true;
            }
        }
    }
    if let Some(default_model) = document.get("default_model").and_then(toml::Value::as_str)
        && (default_model.starts_with("managed:kimi-code")
            || removed_models.iter().any(|model| model == default_model))
    {
        document.remove("default_model");
        changed = true;
    }
    if changed {
        let serialized = toml::to_string_pretty(&document)
            .map_err(|error| format!("序列化 {} 失败：{error}", config_path.display()))?;
        tokio::fs::write(&config_path, format!("{serialized}\n"))
            .await
            .map_err(|error| format!("写入 {} 失败：{error}", config_path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[tokio::test]
    async fn cleanup_removes_real_oauth_and_managed_models_but_keeps_synthetic_gate() {
        let root = std::env::temp_dir().join(format!("dimo-kimi-logout-{}", Uuid::new_v4()));
        let home_oauth = root.join(".kimi-code");
        tokio::fs::create_dir_all(home_oauth.join("credentials"))
            .await
            .unwrap();
        tokio::fs::write(
            home_oauth.join("credentials/kimi-code.json"),
            r#"{"access_token":"real-oauth-token","refresh_token":"real-refresh"}"#,
        )
        .await
        .unwrap();
        tokio::fs::write(
            home_oauth.join("config.toml"),
            r#"default_model = "managed:kimi-code:kimi-k2.5"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"

[providers.custom]
type = "openai"
base_url = "https://example.invalid/v1"

[models."managed:kimi-code:kimi-k2.5"]
provider = "managed:kimi-code"
model = "kimi-k2.5"

[models.custom]
provider = "custom"
model = "custom-model"
"#,
        )
        .await
        .unwrap();

        cleanup_kimi_local_auth(&home_oauth).await.unwrap();
        assert!(!home_oauth.join("credentials/kimi-code.json").exists());
        let updated = tokio::fs::read_to_string(home_oauth.join("config.toml"))
            .await
            .unwrap();
        let parsed: toml::Table = updated.parse().unwrap();
        assert!(parsed.get("default_model").is_none());
        let providers = parsed.get("providers").unwrap().as_table().unwrap();
        assert!(!providers.contains_key("managed:kimi-code"));
        assert!(providers.contains_key("custom"));
        let models = parsed.get("models").unwrap().as_table().unwrap();
        assert!(!models.contains_key("managed:kimi-code:kimi-k2.5"));
        assert!(models.contains_key("custom"));

        let home_synthetic = root.join("synthetic-kimi");
        tokio::fs::create_dir_all(home_synthetic.join("credentials"))
            .await
            .unwrap();
        tokio::fs::write(
            home_synthetic.join("credentials/kimi-code.json"),
            r#"{"access_token":"dimo-local-gate","_dimo_synthetic":true}"#,
        )
        .await
        .unwrap();
        cleanup_kimi_local_auth(&home_synthetic).await.unwrap();
        assert!(home_synthetic.join("credentials/kimi-code.json").exists());

        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}
