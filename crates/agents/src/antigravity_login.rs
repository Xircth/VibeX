//! Antigravity ACP sign-in.
//!
//! Official `agy_acp_server` advertises auth methods from `initialize` and
//! opens the browser from `authenticate`. `session/new` stays pending until
//! that flow finishes. Authorization URLs printed on stdio, or carried by a
//! server request, are opened here because a hidden server often cannot
//! launch the browser itself.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
};
use workspace_utils::process::new_hidden_tokio_command;

use crate::{AgentId, prepare_agent_runtime_temp_session, recorded_auth_method};

struct SignInOpener {
    seen: Mutex<HashSet<String>>,
    open: Box<dyn Fn(&str) + Send + Sync>,
}

impl SignInOpener {
    fn system() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(HashSet::new()),
            open: Box::new(|url: &str| {
                let url = url.to_string();
                tokio::spawn(async move {
                    if let Err(error) = workspace_utils::browser::open_browser(&url).await {
                        tracing::warn!(%error, "could not open the Antigravity sign-in page");
                    }
                });
            }),
        })
    }

    #[cfg(test)]
    fn discard() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(HashSet::new()),
            open: Box::new(|_| {}),
        })
    }

    fn note(&self, text: &str) {
        let mut fresh = Vec::new();
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for url in http_urls(text) {
            if seen.insert(url.clone()) {
                fresh.push(url);
            }
        }
        drop(seen);
        for url in fresh {
            (self.open)(&url);
        }
    }
}

pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub async fn run_antigravity_login(
    program: &Path,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let mut env = env.clone();
    let agent_id = AgentId::parse("antigravity").expect("bundled AgentId");
    // Declared before `child` so the temp directory is removed after
    // `kill_on_drop` stops the PyInstaller bootloader.
    let runtime_temp = prepare_agent_runtime_temp_session(&agent_id).map_err(|err| {
        format!("could not create a writable temporary directory for Antigravity ({err})")
    })?;
    runtime_temp.bind_env(&mut env);
    let mut command: Command = new_hidden_tokio_command(program, args);
    command
        .envs(&env)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start {} ({err})", program.display()))?;
    if let Some(pid) = child.id() {
        runtime_temp.record_owner_pid(pid);
    }
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err("the Antigravity server did not expose its stdio".to_string());
    };
    let opener = SignInOpener::system();
    if let Some(stderr) = child.stderr.take() {
        let opener = Arc::clone(&opener);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                opener.note(&line);
            }
        });
    }
    let cwd = cwd.to_string_lossy().into_owned();
    let preferred = recorded_auth_method(&env).unwrap_or("oauth-personal");
    match tokio::time::timeout(
        timeout,
        sign_in_with(BufReader::new(stdout), stdin, &cwd, preferred, &opener),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "sign-in did not finish within {} seconds",
            timeout.as_secs()
        )),
    }
}

#[cfg(test)]
async fn sign_in<R, W>(reader: R, writer: W, cwd: &str) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    sign_in_with(
        reader,
        writer,
        cwd,
        "oauth-personal",
        &SignInOpener::discard(),
    )
    .await
}

async fn sign_in_with<R, W>(
    mut reader: R,
    mut writer: W,
    cwd: &str,
    preferred_method: &str,
    opener: &SignInOpener,
) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut next_id = 1u64;
    let initialized = call(
        &mut reader,
        &mut writer,
        &mut next_id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "elicitation": { "url": {} } }
        }),
        opener,
    )
    .await
    .map_err(|error| error.message)?;
    let mut authenticated = false;
    if let Some(method) = choose_auth_method(&advertised_methods(&initialized), preferred_method) {
        call(
            &mut reader,
            &mut writer,
            &mut next_id,
            "authenticate",
            json!({ "methodId": method }),
            opener,
        )
        .await
        .map_err(|error| error.message)?;
        authenticated = true;
    }
    match call(
        &mut reader,
        &mut writer,
        &mut next_id,
        "session/new",
        json!({ "cwd": cwd, "mcpServers": [] }),
        opener,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.auth_required && !authenticated => {
            let method = choose_auth_method(&[], preferred_method)
                .unwrap_or_else(|| preferred_method.to_string());
            call(
                &mut reader,
                &mut writer,
                &mut next_id,
                "authenticate",
                json!({ "methodId": method }),
                opener,
            )
            .await
            .map_err(|error| error.message)?;
            call(
                &mut reader,
                &mut writer,
                &mut next_id,
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                opener,
            )
            .await
            .map_err(|error| error.message)?;
            Ok(())
        }
        Err(error) => Err(error.message),
    }
}

struct RequestError {
    message: String,
    auth_required: bool,
}

async fn call<R, W>(
    reader: &mut R,
    writer: &mut W,
    next_id: &mut u64,
    method: &str,
    params: Value,
    opener: &SignInOpener,
) -> Result<Value, RequestError>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let id = *next_id;
    *next_id += 1;
    let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    writer
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|err| RequestError::plain(err.to_string()))?;
    writer
        .flush()
        .await
        .map_err(|err| RequestError::plain(err.to_string()))?;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|err| RequestError::plain(err.to_string()))?;
        if read == 0 {
            return Err(RequestError::plain(
                "the Antigravity server stopped before sign-in finished".to_string(),
            ));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(response) = serde_json::from_str::<Value>(trimmed) else {
            opener.note(trimmed);
            continue;
        };
        if response.get("method").is_some() && response.get("id").is_some() {
            opener.note(trimmed);
            reply_to_server(writer, &response).await?;
            continue;
        }
        opener.note(trimmed);
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(RequestError::from_agent(error));
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
}

async fn reply_to_server<W>(writer: &mut W, request: &Value) -> Result<(), RequestError>
where
    W: AsyncWrite + Unpin,
{
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let result = if method == "session/request_permission" {
        json!({ "outcome": { "outcome": "cancelled" } })
    } else if method == "elicitation/create" {
        let action = if request
            .pointer("/params/url")
            .and_then(Value::as_str)
            .is_some()
        {
            "accept"
        } else {
            "cancel"
        };
        json!({ "action": action })
    } else {
        json!({})
    };
    let reply = json!({ "jsonrpc": "2.0", "id": request.get("id").cloned().unwrap_or(Value::Null), "result": result });
    writer
        .write_all(format!("{reply}\n").as_bytes())
        .await
        .map_err(|err| RequestError::plain(err.to_string()))?;
    writer
        .flush()
        .await
        .map_err(|err| RequestError::plain(err.to_string()))
}

impl RequestError {
    fn plain(message: String) -> Self {
        Self {
            message,
            auth_required: false,
        }
    }

    fn from_agent(error: &Value) -> Self {
        let message = error_message(error);
        let top = error.get("message").and_then(Value::as_str).unwrap_or("");
        let detail = error
            .pointer("/data/message")
            .and_then(Value::as_str)
            .unwrap_or("");
        let auth_required = top == "Authentication required"
            && (detail.is_empty() || detail == "Authentication required");
        Self {
            message,
            auth_required,
        }
    }
}

fn advertised_methods(result: &Value) -> Vec<String> {
    result
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|method| method.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn choose_auth_method(advertised: &[String], preferred: &str) -> Option<String> {
    if advertised.is_empty() {
        return None;
    }
    if advertised.iter().any(|method| method == preferred) {
        return Some(preferred.to_string());
    }
    if advertised.iter().any(|method| method == "oauth-personal") {
        return Some("oauth-personal".to_string());
    }
    advertised.first().cloned()
}

fn http_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = text;
    while let Some(start) = ["https://", "http://"]
        .into_iter()
        .filter_map(|prefix| rest.find(prefix))
        .min()
    {
        let tail = &rest[start..];
        let end = tail
            .char_indices()
            .find(|(_, ch)| !is_url_char(*ch))
            .map(|(index, _)| index)
            .unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches('.').to_string();
        if url.len() > "https://".len() {
            urls.push(url);
        }
        rest = &tail[end..];
    }
    urls
}

fn is_url_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            ':' | '/'
                | '?'
                | '#'
                | '['
                | ']'
                | '@'
                | '!'
                | '$'
                | '&'
                | '('
                | ')'
                | '*'
                | '+'
                | ','
                | ';'
                | '='
                | '-'
                | '.'
                | '_'
                | '~'
                | '%'
        )
}

fn error_message(error: &Value) -> String {
    error
        .pointer("/data/message")
        .or_else(|| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("sign-in failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use tokio::io::{DuplexStream, duplex};

    use super::*;

    async fn serve(stream: DuplexStream, session_new: Value) -> Vec<String> {
        let (read, mut write) = tokio::io::split(stream);
        let mut lines = BufReader::new(read).lines();
        let mut methods = Vec::new();
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap().to_string();
            let reply = if method == "session/new" {
                let mut reply = session_new.clone();
                reply["id"] = request["id"].clone();
                reply
            } else {
                json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })
            };
            methods.push(method);
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            if methods.len() == 2 {
                break;
            }
        }
        methods
    }

    #[tokio::test]
    async fn sign_in_succeeds_once_the_server_opens_a_session() {
        let (client, server) = duplex(4096);
        let server = tokio::spawn(serve(
            server,
            json!({ "jsonrpc": "2.0", "result": { "sessionId": "s1" } }),
        ));
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert_eq!(result, Ok(()));
        assert_eq!(server.await.unwrap(), ["initialize", "session/new"]);
    }

    #[tokio::test]
    async fn sign_in_reports_why_the_server_refused() {
        let (client, server) = duplex(4096);
        tokio::spawn(serve(
            server,
            json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32000,
                    "message": "Authentication required",
                    "data": { "message": "gcp.project is required" }
                }
            }),
        ));
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert_eq!(result, Err("gcp.project is required".to_string()));
    }

    #[tokio::test]
    async fn sign_in_fails_when_the_server_exits_first() {
        let (client, server) = duplex(4096);
        drop(server);
        let (read, write) = tokio::io::split(client);

        let result = sign_in(BufReader::new(read), write, "/work").await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sign_in_authenticates_with_the_advertised_method_before_opening_a_session() {
        let (client, server) = duplex(8192);
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let mut methods = Vec::new();
            let mut method_id = None;
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                let method = request["method"].as_str().unwrap().to_string();
                let reply = if method == "initialize" {
                    json!({
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {
                            "authMethods": [
                                { "id": "oauth-business" },
                                { "id": "oauth-personal" }
                            ]
                        }
                    })
                } else if method == "authenticate" {
                    method_id = request["params"]["methodId"].as_str().map(str::to_string);
                    json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} })
                } else {
                    json!({
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": { "sessionId": "s1" }
                    })
                };
                methods.push(method);
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
                if methods.len() == 3 {
                    break;
                }
            }
            (methods, method_id)
        });
        let (read, write) = tokio::io::split(client);

        let result = sign_in_with(
            BufReader::new(read),
            write,
            "/work",
            "oauth-business",
            &SignInOpener::discard(),
        )
        .await;

        assert_eq!(result, Ok(()));
        let (methods, method_id) = server.await.unwrap();
        assert_eq!(methods, ["initialize", "authenticate", "session/new"]);
        assert_eq!(method_id.as_deref(), Some("oauth-business"));
    }

    #[tokio::test]
    async fn sign_in_opens_an_authorization_url_and_answers_the_server() {
        let (client, server) = duplex(8192);
        let opened = Arc::new(Mutex::new(Vec::new()));
        let opener = Arc::new(SignInOpener {
            seen: Mutex::new(HashSet::new()),
            open: {
                let opened = Arc::clone(&opened);
                Box::new(move |url: &str| opened.lock().unwrap().push(url.to_string()))
            },
        });
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let mut client_reply = None;
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                let method = request["method"].as_str().unwrap();
                if method == "initialize" {
                    let reply = json!({ "jsonrpc": "2.0", "id": request["id"], "result": {} });
                    write
                        .write_all(format!("{reply}\n").as_bytes())
                        .await
                        .unwrap();
                    continue;
                }
                write
                    .write_all(
                        b"Open https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.\n",
                    )
                    .await
                    .unwrap();
                write
                    .write_all(
                        br#"{"jsonrpc":"2.0","id":9,"method":"elicitation/create","params":{"mode":"url","url":"https://accounts.google.com/o/oauth2/v2/auth?client_id=abc"}}
"#,
                    )
                    .await
                    .unwrap();
                let reply_line = lines.next_line().await.unwrap().unwrap();
                client_reply = serde_json::from_str(&reply_line).ok();
                let reply = json!({
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": { "sessionId": "s1" }
                });
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
                break;
            }
            client_reply
        });
        let (read, write) = tokio::io::split(client);

        let result = sign_in_with(
            BufReader::new(read),
            write,
            "/work",
            "oauth-personal",
            &opener,
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(
            opened.lock().unwrap().as_slice(),
            ["https://accounts.google.com/o/oauth2/v2/auth?client_id=abc"]
        );
        let reply: Value = server.await.unwrap().expect("elicitation reply");
        assert_eq!(reply["id"], 9);
        assert_eq!(reply["result"]["action"], "accept");
    }
}
