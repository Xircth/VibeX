//! One-shot ACP discovery probe ("warm probe").
//!
//! ACP delivers an agent's modes/models only in the `session/new` (or
//! load/resume) response — there is no lighter pre-session discovery RPC. This
//! probe makes that response obtainable WITHOUT the user ever running the
//! agent: spawn the process, `initialize`, open a throwaway session in a
//! scratch directory, capture the advertised session controls, kill the
//! process. No prompt is sent and no conversation is recorded anywhere.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use agent_client_protocol as acp;
use agent_client_protocol::{
    Agent, ConnectionTo,
    schema::{
        ProtocolVersion,
        v1::{
            AgentNotification, AgentRequest, ClientCapabilities, ElicitationCapabilities,
            ElicitationFormCapabilities, Implementation, InitializeRequest, NewSessionRequest,
            SessionConfigOption as AcpSessionConfigOption, SessionModeId, SessionModeState,
            SessionUpdate,
        },
    },
};
use futures::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    io::ReaderStream,
};
use workspace_utils::{process::new_hidden_tokio_command, shell::refresh_process_path};

use crate::{
    AgentKind,
    distribution::{CommandBuildInput, current_platform},
    error::{AgentError, AgentResult},
    events::{
        AgentSessionConfigChoice, AgentSessionConfigDependency, AgentSessionConfigOption,
        AgentSessionControlsSnapshot,
    },
    manager::{agent_session_config_options_from_acp, agent_session_modes_from_acp},
    registry::{
        ACP_EXECUTABLE_OVERRIDE_ENV, AgentRegistryEntry, local_acp_command_parts,
        local_runtime_launch_acp_executable,
    },
};

/// Post-`session/new` settle time for follow-up `session/update` pushes.
const GRACE_PERIOD: Duration = Duration::from_millis(500);
/// Extra wait when the initial advertisement is empty (agent still resolving
/// its model catalog); bounded so silent agents fail fast enough.
const EMPTY_ADVERTISEMENT_EXTRA_WAIT: Duration = Duration::from_secs(5);

/// The native `opencode models --verbose` command is OpenCode's authoritative
/// list of models *and per-model variants* currently usable by this
/// installation (credentials and project config already applied). Its ACP
/// server may wait on interactive/plugin initialization before answering
/// `session/new`, so using the native query keeps startup catalog discovery
/// fast while retaining model → work-intensity relationships.
const OPENCODE_MODELS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Default, Clone)]
struct CapturedControls {
    modes: Option<SessionModeState>,
    config_options: Option<Vec<AcpSessionConfigOption>>,
}

impl CapturedControls {
    fn has_controls(&self) -> bool {
        self.modes
            .as_ref()
            .is_some_and(|modes| !modes.available_modes.is_empty())
            || self
                .config_options
                .as_ref()
                .is_some_and(|options| !options.is_empty())
    }
}

/// Load OpenCode's currently selectable models and model-dependent effort
/// variants without starting an ACP session. This is deliberately a native
/// OpenCode query, not a static model list: it follows the user's actual
/// credentials, global config, and project-independent installation state.
pub async fn probe_opencode_session_controls(
    cwd: PathBuf,
    env: HashMap<String, String>,
) -> AgentResult<AgentSessionControlsSnapshot> {
    // Never turn a catalog refresh into an implicit bare `opencode` launch.
    // The caller must supply the same verified absolute runtime that live
    // sessions use, otherwise a PATH change could probe a different Agent.
    let acp_program = local_runtime_launch_acp_executable(AgentKind::Opencode, &env)?
        .expect("OpenCode has a local runtime contract");
    let _ = refresh_process_path().await;
    let mut command = new_hidden_tokio_command(acp_program, ["models", "--verbose"]);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .current_dir(cwd);
    for (key, value) in &env {
        if key != ACP_EXECUTABLE_OVERRIDE_ENV {
            command.env(key, value);
        }
    }

    let output = tokio::time::timeout(OPENCODE_MODELS_TIMEOUT, command.output())
        .await
        .map_err(|_| AgentError::Runtime("OpenCode model catalog timed out".to_string()))?
        .map_err(|error| AgentError::Runtime(format!("failed to run OpenCode models: {error}")))?;
    if !output.status.success() {
        return Err(AgentError::Runtime(
            "OpenCode model catalog command failed".to_string(),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = parse_opencode_models_verbose(&stdout);
    if models.is_empty() {
        return Err(AgentError::Runtime(
            "OpenCode reported no selectable models".to_string(),
        ));
    }
    let choices = models
        .iter()
        .map(|model| AgentSessionConfigChoice {
            value: serde_json::Value::String(model.value.clone()),
            label: model.label.clone(),
            description: None,
        })
        .collect::<Vec<_>>();
    let effort_by_model = models
        .iter()
        .filter(|model| !model.efforts.is_empty())
        .map(|model| {
            (
                model.value.clone(),
                model
                    .efforts
                    .iter()
                    .map(|effort| AgentSessionConfigChoice {
                        value: serde_json::Value::String(effort.clone()),
                        label: opencode_effort_label(effort),
                        description: None,
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let all_efforts = unique_opencode_efforts(&models)
        .into_iter()
        .map(|effort| AgentSessionConfigChoice {
            value: serde_json::Value::String(effort.clone()),
            label: opencode_effort_label(&effort),
            description: None,
        })
        .collect::<Vec<_>>();
    let mut config_options = vec![AgentSessionConfigOption {
        key: "model".to_string(),
        label: "Model".to_string(),
        description: Some("Model available through this OpenCode installation".to_string()),
        category: Some("model".to_string()),
        value: None,
        choices,
        dependency: None,
    }];
    if !effort_by_model.is_empty() {
        config_options.push(AgentSessionConfigOption {
            key: "effort".to_string(),
            label: "Work intensity".to_string(),
            description: Some(
                "Available work intensity changes with the selected OpenCode model".to_string(),
            ),
            category: Some("thought_level".to_string()),
            value: None,
            // Keep a stable union for non-dependency-aware consumers while
            // VibeX's selectors use the exact mapping below.
            choices: all_efforts,
            dependency: Some(AgentSessionConfigDependency {
                parent_key: "model".to_string(),
                choices_by_parent_value: effort_by_model,
            }),
        });
    }
    Ok(AgentSessionControlsSnapshot {
        modes: Vec::new(),
        current_mode: None,
        config_options,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OpenCodeModelCatalogEntry {
    value: String,
    label: String,
    efforts: Vec<String>,
}

/// OpenCode prints `provider/model`, then a pretty-printed JSON model record
/// for each entry. Extract complete JSON objects with string/escape awareness
/// rather than splitting on whitespace: descriptions and URLs can themselves
/// contain `/`, which made the old parser fabricate models.
fn parse_opencode_models_verbose(stdout: &str) -> Vec<OpenCodeModelCatalogEntry> {
    let mut cursor = 0;
    let mut models = Vec::new();
    while let Some(relative_start) = stdout[cursor..].find('{') {
        let start = cursor + relative_start;
        let Some(end) = json_object_end(stdout, start) else {
            break;
        };
        let record = &stdout[start..end];
        cursor = end;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(record) else {
            continue;
        };
        let Some(provider) = value.get("providerID").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        let model = format!("{provider}/{id}");
        if models
            .iter()
            .any(|existing: &OpenCodeModelCatalogEntry| existing.value == model)
        {
            continue;
        }
        let label = value
            .get("name")
            .and_then(|value| value.as_str())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&model)
            .to_string();
        let efforts = value
            .get("variants")
            .and_then(|value| value.as_object())
            .map(|variants| {
                let mut values = variants.keys().cloned().collect::<Vec<_>>();
                values.sort_by_key(|value| opencode_effort_sort_key(value));
                values
            })
            .unwrap_or_default();
        models.push(OpenCodeModelCatalogEntry {
            value: model,
            label,
            efforts,
        });
    }
    models
}

fn json_object_end(input: &str, start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'\"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'\"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(start + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn unique_opencode_efforts(models: &[OpenCodeModelCatalogEntry]) -> Vec<String> {
    let mut efforts = models
        .iter()
        .flat_map(|model| model.efforts.iter().cloned())
        .collect::<Vec<_>>();
    efforts.sort_by_key(|value| opencode_effort_sort_key(value));
    efforts.dedup();
    efforts
}

fn opencode_effort_sort_key(value: &str) -> (u8, String) {
    let rank = match value.to_ascii_lowercase().as_str() {
        "none" | "off" | "minimal" => 0,
        "low" => 1,
        "medium" | "moderate" => 2,
        "high" => 3,
        "max" | "xhigh" | "extra_high" => 4,
        _ => 5,
    };
    (rank, value.to_ascii_lowercase())
}

fn opencode_effort_label(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    format!(
        "{}{}",
        first.to_uppercase(),
        chars.as_str().replace(['_', '-'], " ")
    )
}

/// Spawn `entry`'s agent and return the session controls it advertises on
/// `session/new`. `cwd` should be a scratch directory (nothing is written to
/// it by this call, but agents treat it as the session root). Fails — rather
/// than fabricating anything — when the agent can't start, needs
/// authentication, times out, or advertises no controls.
pub async fn probe_session_controls(
    entry: &AgentRegistryEntry,
    cwd: PathBuf,
    env: HashMap<String, String>,
    timeout: Duration,
) -> AgentResult<AgentSessionControlsSnapshot> {
    // Keep the same fail-closed runtime contract as the live connection
    // manager. In particular, probing must never let an adapter's bundled
    // Codex/Claude CLI generate a catalog for a different local runtime.
    let verified_acp_program = local_runtime_launch_acp_executable(entry.agent_type, &env)?;
    let _ = refresh_process_path().await;
    let command_parts = local_acp_command_parts(entry.agent_type).unwrap_or(
        entry.distribution.command_parts(&CommandBuildInput {
            platform: current_platform(),
            binary_dir: None,
            prefer_system_uvx_command: false,
        })?,
    );

    let acp_program = verified_acp_program.unwrap_or_else(|| PathBuf::from(command_parts.program));
    let mut command = new_hidden_tokio_command(acp_program, &command_parts.args);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .current_dir(&cwd);
    for (key, value) in env {
        if key != ACP_EXECUTABLE_OVERRIDE_ENV {
            command.env(key, value);
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| AgentError::Runtime(format!("failed to spawn ACP agent: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::Runtime("ACP child missing stdout".to_string()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AgentError::Runtime("ACP child missing stdin".to_string()))?;

    let (mut to_acp_writer, acp_incoming_reader) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let mut stdout_stream = ReaderStream::new(stdout);
        while let Some(result) = stdout_stream.next().await {
            match result {
                Ok(bytes) => {
                    if to_acp_writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (acp_out_writer, acp_out_reader) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let mut child_stdin = stdin;
        let mut outbound = ReaderStream::new(acp_out_reader);
        while let Some(result) = outbound.next().await {
            match result {
                Ok(bytes) => {
                    if child_stdin.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = child_stdin.flush().await;
                }
                Err(_) => break,
            }
        }
    });

    let transport =
        acp::ByteStreams::new(acp_out_writer.compat_write(), acp_incoming_reader.compat());
    let session_cwd = cwd.clone();
    // Advertisement accumulator: seeded from the `session/new` response, then
    // overlaid with any `session/update` the agent pushes right after — some
    // agents advertise an empty initial set and publish the real options in a
    // follow-up update (mirrors the reference SelectorsReady + grace pattern).
    let captured: Arc<Mutex<CapturedControls>> = Arc::new(Mutex::new(CapturedControls::default()));
    let captured_for_notifications = Arc::clone(&captured);
    let captured_for_wait = Arc::clone(&captured);
    let connect = acp::Client
        .builder()
        .name("VibeX")
        .on_receive_request(
            async move |_request: AgentRequest, responder, _cx| {
                // A discovery probe answers nothing; agents don't need client
                // services to advertise their session controls.
                responder.respond_with_error(acp::Error::method_not_found())
            },
            acp::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: AgentNotification, _cx| {
                if let AgentNotification::SessionNotification(args) = notification {
                    let mut captured = captured_for_notifications
                        .lock()
                        .expect("probe capture lock");
                    match args.update {
                        SessionUpdate::CurrentModeUpdate(update) => {
                            if let Some(modes) = captured.modes.as_mut() {
                                modes.current_mode_id =
                                    SessionModeId::new(update.current_mode_id.0.to_string());
                            }
                        }
                        SessionUpdate::ConfigOptionUpdate(update) => {
                            captured.config_options = Some(update.config_options);
                        }
                        _ => {}
                    }
                }
                Ok(())
            },
            acp::on_receive_notification!(),
        )
        .connect_with(transport, |conn: ConnectionTo<Agent>| async move {
            conn.send_request(
                InitializeRequest::new(ProtocolVersion::LATEST)
                    // Mirror the real runtime's capabilities so the agent
                    // advertises the same option set a live session sees.
                    .client_capabilities(ClientCapabilities::new().terminal(true).elicitation(
                        ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()),
                    ))
                    .client_info(Implementation::new("vibex", env!("CARGO_PKG_VERSION"))),
            )
            .block_task()
            .await?;
            let response = conn
                .send_request(NewSessionRequest::new(session_cwd))
                .block_task()
                .await?;
            {
                let mut captured = captured_for_wait.lock().expect("probe capture lock");
                if response.modes.is_some() {
                    captured.modes = response.modes;
                }
                if response.config_options.is_some() {
                    captured.config_options = response.config_options;
                }
            }
            // Grace window for straggler updates; extend while the agent has
            // published nothing yet (it may still be resolving its catalog).
            tokio::time::sleep(GRACE_PERIOD).await;
            let deadline = tokio::time::Instant::now() + EMPTY_ADVERTISEMENT_EXTRA_WAIT;
            loop {
                let has_controls = {
                    let captured = captured_for_wait.lock().expect("probe capture lock");
                    captured.has_controls()
                };
                if has_controls || tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Ok::<_, acp::Error>(())
        });

    let outcome = tokio::time::timeout(timeout, connect).await;
    let _ = child.kill().await;
    outcome
        .map_err(|_| AgentError::Runtime("ACP discovery probe timed out".to_string()))?
        .map_err(|error| AgentError::Runtime(format!("ACP discovery probe failed: {error}")))?;

    let CapturedControls {
        modes: modes_state,
        config_options,
    } = captured.lock().expect("probe capture lock").clone();
    let (modes, current_mode) = modes_state
        .map(agent_session_modes_from_acp)
        .unwrap_or_default();
    let config_options = config_options
        .map(agent_session_config_options_from_acp)
        .unwrap_or_default();

    if modes.is_empty() && config_options.is_empty() {
        return Err(AgentError::Runtime(
            "agent advertised no session controls".to_string(),
        ));
    }
    Ok(AgentSessionControlsSnapshot {
        modes,
        current_mode,
        config_options,
    })
}

#[cfg(test)]
mod tests {
    use api_types::AgentKind;

    use super::*;
    use crate::registry::registry_entry;

    #[test]
    fn parses_opencode_native_model_catalog_with_per_model_efforts() {
        let models = parse_opencode_models_verbose(
            r#"opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "variants": {}
}
openai/gpt-5.6-sol
{
  "id": "gpt-5.6-sol",
  "providerID": "openai",
  "name": "GPT 5.6 Sol",
  "variants": {
    "high": { "reasoningEffort": "high" },
    "low": { "reasoningEffort": "low" },
    "max": { "reasoningEffort": "max" }
  }
}
"#,
        );
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "opencode/big-pickle");
        assert_eq!(models[0].label, "Big Pickle");
        assert!(models[0].efforts.is_empty());
        assert_eq!(models[1].value, "openai/gpt-5.6-sol");
        assert_eq!(models[1].label, "GPT 5.6 Sol");
        assert_eq!(models[1].efforts, ["low", "high", "max"]);
        assert_eq!(unique_opencode_efforts(&models), ["low", "high", "max"]);
    }

    #[tokio::test]
    async fn local_runtime_probes_refuse_bare_commands() {
        // Both discovery paths must fail before spawning/looking up a bare
        // command. Otherwise an adapter's bundled CLI could populate the
        // persisted selector catalog with a different runtime's controls.
        let scratch = std::env::temp_dir().join("vibex-probe-guard-test");
        for agent_type in [AgentKind::Codex, AgentKind::ClaudeCode] {
            let error = probe_session_controls(
                &registry_entry(agent_type),
                scratch.clone(),
                HashMap::new(),
                Duration::from_secs(1),
            )
            .await
            .expect_err("separate ACP adapter must require an explicit local runtime");
            assert!(
                error.to_string().contains(ACP_EXECUTABLE_OVERRIDE_ENV),
                "{agent_type:?} unexpectedly probed a bare ACP command: {error}"
            );
        }

        let error = probe_opencode_session_controls(scratch, HashMap::new())
            .await
            .expect_err("OpenCode must require its verified absolute executable");
        assert!(error.to_string().contains(ACP_EXECUTABLE_OVERRIDE_ENV));
    }

    /// Live end-to-end probe against the locally installed Codex ACP adapter.
    /// Environment-dependent (needs npm-installed codex-acp + auth), so it is
    /// ignored in CI; run manually with `cargo test -p agents probe_live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn probe_live_codex_advertises_controls() {
        let scratch = std::env::temp_dir().join("vibex-probe-test-codex");
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        let snapshot = probe_session_controls(
            &registry_entry(AgentKind::Codex),
            scratch,
            HashMap::new(),
            Duration::from_secs(30),
        )
        .await
        .expect("probe should capture codex controls");
        assert!(
            !snapshot.config_options.is_empty() || !snapshot.modes.is_empty(),
            "expected advertised controls, got {snapshot:?}"
        );
    }

    /// Live check of the native OpenCode catalog path. Environment-dependent,
    /// so it is deliberately excluded from CI.
    #[tokio::test]
    #[ignore]
    async fn probe_live_opencode_advertises_models() {
        let scratch = std::env::temp_dir().join("vibex-probe-test-opencode");
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        let snapshot = probe_opencode_session_controls(scratch, HashMap::new())
            .await
            .expect("OpenCode should report its installed models");
        assert!(
            snapshot
                .config_options
                .iter()
                .any(|option| option.key == "model" && !option.choices.is_empty()),
            "expected selectable OpenCode models, got {snapshot:?}"
        );
    }
}
