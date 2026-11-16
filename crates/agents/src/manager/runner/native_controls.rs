//! Native engine capabilities, MCP server serialization, and session controls
//! (`modes`, `model`, `effort`, `available_commands`, `Yolo` mode) for
//! `AgentConnectionRunner::run_native`.

use serde_json::{Map, Value, json};

use super::*;
use crate::{
    conversation::{AgentPromptCapabilities, DeliveryChannel},
    engine::{
        EngineCommandSpec, EngineEffortSpec, EngineHandle, EngineModeSpec, EngineModelInfo,
        NativeEngineDriver,
    },
};

fn build_select_choice(
    id: impl Into<String>,
    label: impl Into<String>,
    description: Option<String>,
) -> SessionConfigSelectOption {
    let mut opt = SessionConfigSelectOption::new(id.into(), label.into());
    if let Some(desc) = description.filter(|d| !d.trim().is_empty()) {
        opt = opt.description(desc);
    }
    opt
}

fn build_mode_state(spec: &EngineModeSpec, yolo: bool) -> SessionModeState {
    let modes = spec
        .modes
        .iter()
        .map(|choice| {
            let mut mode = acp::schema::v1::SessionMode::new(choice.id.clone(), choice.label.clone());
            if let Some(desc) = choice.description.as_deref().filter(|d| !d.trim().is_empty()) {
                mode = mode.description(desc.to_string());
            }
            mode
        })
        .collect();
    let initial = if yolo {
        spec.yolo_mode_id.clone()
    } else {
        spec.default_mode_id.clone()
    };
    SessionModeState::new(initial, modes)
}

fn build_effort_option(spec: &EngineEffortSpec) -> AcpSessionConfigOption {
    let choices = spec
        .choices
        .iter()
        .map(|choice| build_select_choice(choice.id.clone(), choice.label.clone(), choice.description.clone()))
        .collect();
    AcpSessionConfigOption::select(
        "effort",
        "推理强度",
        spec.default_value.clone(),
        SessionConfigSelectOptions::Ungrouped(choices),
    )
    .category(SessionConfigOptionCategory::ThoughtLevel)
}

fn build_model_option(
    models: &[EngineModelInfo],
    preferred_default: Option<&str>,
) -> Option<AcpSessionConfigOption> {
    let mut choices: Vec<SessionConfigSelectOption> = models
        .iter()
        .filter(|m| !m.id.trim().is_empty())
        .map(|m| build_select_choice(m.id.clone(), m.label.clone(), m.description.clone()))
        .collect();

    if let Some(pref) = preferred_default.map(str::trim).filter(|s| !s.is_empty())
        && !choices.iter().any(|c| c.value.0.as_ref() == pref)
    {
        choices.insert(0, build_select_choice(pref, pref, None));
    }

    if choices.is_empty() {
        return None;
    }

    let current = preferred_default
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| models.iter().find(|m| m.is_default).map(|m| m.id.clone()))
        .unwrap_or_else(|| choices[0].value.0.to_string());

    Some(
        AcpSessionConfigOption::select(
            "model",
            "Model",
            current,
            SessionConfigSelectOptions::Ungrouped(choices),
        )
        .category(SessionConfigOptionCategory::Model),
    )
}

fn build_available_commands(specs: &[EngineCommandSpec]) -> Vec<AgentAvailableCommand> {
    specs
        .iter()
        .map(|cmd| AgentAvailableCommand {
            name: cmd.name.clone(),
            description: (!cmd.description.trim().is_empty()).then(|| cmd.description.clone()),
            input_schema: None,
        })
        .collect()
}

fn update_select_option_value(
    options: &mut [AcpSessionConfigOption],
    key: &str,
    new_value: &str,
    allow_custom_insert: bool,
) -> bool {
    let Some(opt) = options.iter_mut().find(|o| o.id.0.as_ref() == key) else {
        return false;
    };
    let SessionConfigKind::Select(select) = &mut opt.kind else {
        return false;
    };
    if let SessionConfigSelectOptions::Ungrouped(choices) = &mut select.options {
        let exists = choices.iter().any(|c| c.value.0.as_ref() == new_value);
        if !exists {
            if !allow_custom_insert {
                return false;
            }
            choices.push(build_select_choice(new_value, new_value, None));
        }
    }
    select.current_value = SessionConfigValueId::new(new_value.to_string());
    true
}

fn current_select_option_value(options: &[AcpSessionConfigOption], key: &str) -> Option<String> {
    let opt = options.iter().find(|o| o.id.0.as_ref() == key)?;
    let SessionConfigKind::Select(select) = &opt.kind else {
        return None;
    };
    let val = select.current_value.0.trim();
    (!val.is_empty()).then(|| val.to_string())
}

impl AgentConnectionRunner {
    /// Checks whether a failed pre-handshake `run_native` attempt may safely fall back to
    /// `run_acp`. Standalone `claude` and `codex` CLIs are NOT ACP stdio servers and must
    /// never be spawned via `run_acp` when native startup fails (`[F1]`).
    pub(in crate::manager) fn can_fallback_to_acp_adapter(&self, mode_env: Option<&str>) -> bool {
        let explicit_acp = mode_env.is_some_and(|v| {
            let trimmed = v.trim();
            trimmed.eq_ignore_ascii_case("acp") || trimmed.eq_ignore_ascii_case("acp-fallback")
        });
        let locked = &self.snapshot.launch_lock.absolute_acp_program;
        let stem = locked
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let has_acp_arg = self
            .snapshot
            .launch_lock
            .args
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("acp"));
        let is_acp_adapter_binary =
            stem.ends_with("-acp") || stem.ends_with("_acp") || has_acp_arg;

        if !is_acp_adapter_binary {
            return false;
        }
        if explicit_acp {
            return true;
        }
        let resolved = crate::prefer_path_launch_program(locked);
        crate::launch_program_available(&resolved)
    }

    pub(in crate::manager) async fn populate_native_capabilities(
        &self,
        driver: &dyn NativeEngineDriver,
    ) {
        let yolo = *self.auto_approve_mode.lock().await == AgentAutoApproveMode::Yolo;
        let engine_caps = driver.capabilities();
        let modes_state = build_mode_state(&engine_caps.modes, yolo);
        let extra_opts = engine_caps
            .effort
            .as_ref()
            .map(build_effort_option)
            .into_iter()
            .collect();
        let (unified_opts, _) = unify_session_config_options(Some(modes_state), extra_opts, true);
        let (modes, current_mode) = session_modes_from_config_options(&unified_opts);
        let config_options = agent_session_config_options_from_acp(unified_opts);
        let available_commands = build_available_commands(&engine_caps.default_commands);

        let mut caps = self.capabilities.write().await;
        caps.protocol_version = Some("native-v1".to_string());
        caps.prompt = AgentPromptCapabilities {
            text: true,
            image: true,
            audio: false,
            resource: true,
            resource_link: true,
        };
        caps.load_session = true;
        caps.resume_session = true;
        caps.close_session = true;
        caps.fork_session = engine_caps.supports_native_fork;
        caps.list_sessions = false;
        caps.delete_session = false;
        caps.steering = engine_caps.supports_native_steer;
        caps.delivery_channel = DeliveryChannel::Native;
        caps.terminal = true;
        caps.additional_directories = true;
        caps.filesystem_requests = true;
        caps.mcp_stdio = true;
        caps.mcp_http = true;
        caps.mcp_sse = true;
        caps.modes = modes;
        caps.current_mode = current_mode;
        caps.config_options = config_options;
        caps.available_commands = available_commands;
    }

    /// Serializes session + delegation-companion MCP servers into the JSON map format
    /// consumed by both `claude-native-driver.mjs` (`options.mcpServers`) and Codex
    /// `app-server` (`config.mcp_servers`).
    pub(in crate::manager) async fn build_native_session_mcp_json(
        &self,
        session_id: Option<AgentSessionId>,
    ) -> Value {
        let servers = match session_id {
            Some(sid) => {
                self.session_mcp_servers_with_companion(
                    &self.snapshot.working_dir,
                    sid,
                    CompanionCapabilities {
                        accepts_session_mcp_servers: true,
                    },
                )
                .await
            }
            None => self.session_mcp_servers().await,
        };

        let mut map = Map::new();
        for server in servers {
            match server {
                acp::schema::v1::McpServer::Stdio(s) => {
                    if s.name.trim().is_empty() {
                        continue;
                    }
                    let mut env_obj = Map::new();
                    for item in s.env {
                        env_obj.insert(item.name, Value::String(item.value));
                    }
                    map.insert(
                        s.name,
                        json!({
                            "type": "stdio",
                            "command": s.command.to_string_lossy(),
                            "args": s.args,
                            "env": env_obj,
                        }),
                    );
                }
                acp::schema::v1::McpServer::Http(s) => {
                    if s.name.trim().is_empty() || s.url.trim().is_empty() {
                        continue;
                    }
                    let mut headers_obj = Map::new();
                    for h in s.headers {
                        headers_obj.insert(h.name, Value::String(h.value));
                    }
                    map.insert(
                        s.name,
                        json!({
                            "type": "http",
                            "url": s.url,
                            "headers": headers_obj,
                        }),
                    );
                }
                acp::schema::v1::McpServer::Sse(s) => {
                    if s.name.trim().is_empty() || s.url.trim().is_empty() {
                        continue;
                    }
                    let mut headers_obj = Map::new();
                    for h in s.headers {
                        headers_obj.insert(h.name, Value::String(h.value));
                    }
                    map.insert(
                        s.name,
                        json!({
                            "type": "sse",
                            "url": s.url,
                            "headers": headers_obj,
                        }),
                    );
                }
                #[allow(unreachable_patterns)]
                _ => {}
            }
        }
        Value::Object(map)
    }

    pub(in crate::manager) async fn seed_native_session_controls(
        &self,
        driver: &dyn NativeEngineDriver,
        handle: &EngineHandle,
        session_id: AgentSessionId,
    ) -> AgentSessionControlsSnapshot {
        let models = driver.list_models(handle).await.unwrap_or_default();
        let yolo = *self.auto_approve_mode.lock().await == AgentAutoApproveMode::Yolo;
        let engine_caps = driver.capabilities();
        let mut modes = build_mode_state(&engine_caps.modes, yolo);

        let mut merged_env: HashMap<String, String> = self
            .snapshot
            .launch_lock
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (k, v) in &self.snapshot.env {
            merged_env.insert(k.clone(), v.clone());
        }
        let default_model_env = merged_env
            .get("DIMO_DEFAULT_MODEL")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| driver.resolve_default_model(&merged_env));
        let mut raw_options = Vec::new();
        if let Some(model_opt) = build_model_option(&models, default_model_env.as_deref()) {
            raw_options.push(model_opt);
        }
        if let Some(effort_opt) = engine_caps.effort.as_ref().map(build_effort_option) {
            raw_options.push(effort_opt);
        }

        let mut asserted = BTreeMap::new();
        if let Some(preferences) = self.preferred_controls.write().await.remove(&session_id) {
            if let Some(pref_mode) = preferences
                .mode
                .as_deref()
                .and_then(|m| driver.normalize_mode(m))
            {
                modes.current_mode_id = acp::schema::v1::SessionModeId::new(pref_mode);
            }
            for item in &preferences.config {
                let val = item.value.trim();
                if val.is_empty() {
                    continue;
                }
                let allow_custom = item.key == "model";
                if update_select_option_value(&mut raw_options, &item.key, val, allow_custom) {
                    asserted.insert(item.key.clone(), val.to_string());
                }
            }
        }

        let (unified_options, mode_uses_set_mode) =
            unify_session_config_options(Some(modes.clone()), raw_options, true);
        let model_ids: Vec<String> = models.into_iter().map(|m| m.id).collect();
        let last_model_id = current_select_option_value(&unified_options, "model");
        let commands = build_available_commands(&engine_caps.default_commands);

        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            entry.modes = Some(modes);
            entry.config_options = unified_options;
            entry.mode_uses_set_mode = mode_uses_set_mode;
            entry.session_model_ids = model_ids;
            entry.last_model_id = last_model_id;
            if entry.available_commands.is_none() {
                entry.available_commands = Some(commands);
            }
            for (k, v) in asserted {
                entry.asserted_config_values.insert(k, v);
            }
        }

        let snapshot = self.session_controls_snapshot(session_id).await;
        {
            let mut caps = self.capabilities.write().await;
            caps.modes = snapshot.modes.clone();
            caps.current_mode = snapshot.current_mode.clone();
            caps.config_options = snapshot.config_options.clone();
            if let Some(ref cmds) = snapshot.available_commands {
                caps.available_commands = cmds.clone();
            }
        }
        snapshot
    }

    pub(in crate::manager) async fn apply_native_mode_change(
        &self,
        driver: &dyn NativeEngineDriver,
        session_id: AgentSessionId,
        mode_id: String,
    ) -> AgentSessionControlsSnapshot {
        let normalized = driver
            .normalize_mode(&mode_id)
            .unwrap_or_else(|| mode_id.clone());
        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            if let Some(ref mut mode_state) = entry.modes {
                mode_state.current_mode_id =
                    acp::schema::v1::SessionModeId::new(normalized.clone());
            }
            update_select_option_value(&mut entry.config_options, "mode", &normalized, false);
        }
        self.emit(
            Some(session_id),
            None,
            AgentEvent::ModeChanged {
                mode_id: normalized,
            },
        );
        let snapshot = self.session_controls_snapshot(session_id).await;
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionModes {
                modes: snapshot.modes.clone(),
                current: snapshot.current_mode.clone(),
            },
        );
        snapshot
    }

    pub(in crate::manager) async fn apply_native_config_change(
        &self,
        driver: &dyn NativeEngineDriver,
        session_id: AgentSessionId,
        key: String,
        value: Value,
    ) -> AgentSessionControlsSnapshot {
        if key == "mode"
            && let Some(mode_str) = value.as_str().map(str::trim).filter(|s| !s.is_empty())
        {
            return self
                .apply_native_mode_change(driver, session_id, mode_str.to_string())
                .await;
        }

        if let Some(val_str) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            let allow_custom = key == "model";
            update_select_option_value(&mut entry.config_options, &key, val_str, allow_custom);
            entry
                .asserted_config_values
                .insert(key.clone(), val_str.to_string());
            if key == "model" {
                entry.last_model_id = Some(val_str.to_string());
            }
        }
        self.emit(
            Some(session_id),
            None,
            AgentEvent::ConfigChanged { key, value },
        );
        let snapshot = self.session_controls_snapshot(session_id).await;
        self.emit(
            Some(session_id),
            None,
            AgentEvent::SessionConfigOptions {
                options: snapshot.config_options.clone(),
            },
        );
        snapshot
    }

    pub(in crate::manager) async fn update_native_controls_from_session_init(
        &self,
        session_id: AgentSessionId,
        model: Option<&str>,
        slash_commands: &[String],
    ) {
        let mut changed = false;
        {
            let mut controls = self.session_controls.write().await;
            let entry = controls.entry(session_id).or_default();
            if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
                entry.last_model_id = Some(m.to_string());
                if !entry.asserted_config_values.contains_key("model") {
                    changed |=
                        update_select_option_value(&mut entry.config_options, "model", m, true);
                }
            }
            if !slash_commands.is_empty() {
                let mut cmds = entry.available_commands.clone().unwrap_or_default();
                for raw in slash_commands {
                    let clean = raw.trim().trim_start_matches('/').to_string();
                    if clean.is_empty() || cmds.iter().any(|c| c.name == clean) {
                        continue;
                    }
                    cmds.push(AgentAvailableCommand {
                        name: clean,
                        description: None,
                        input_schema: None,
                    });
                    changed = true;
                }
                entry.available_commands = Some(cmds);
            }
        }
        if changed {
            self.emit_derived_session_controls(session_id).await;
        }
    }

    pub(in crate::manager) async fn resolve_native_turn_controls(
        &self,
        driver: &dyn NativeEngineDriver,
        session_id: AgentSessionId,
        mode_override: Option<&str>,
        config_overrides: &[AgentSessionConfigOverride],
    ) -> (Option<String>, Option<String>, Option<String>) {
        let yolo = *self.auto_approve_mode.lock().await == AgentAutoApproveMode::Yolo;
        let preferred_model = self
            .preferred_controls
            .read()
            .await
            .get(&session_id)
            .and_then(|prefs| {
                prefs
                    .config
                    .iter()
                    .find(|o| o.key == "model")
                    .map(|o| o.value.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        let controls_guard = self.session_controls.read().await;
        let stored = controls_guard.get(&session_id);

        let mut merged_env: HashMap<String, String> = self
            .snapshot
            .launch_lock
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        merged_env.extend(
            self.snapshot
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone())),
        );

        let model = config_overrides
            .iter()
            .find(|o| o.key == "model")
            .map(|o| o.value.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(preferred_model)
            .or_else(|| {
                stored.and_then(|s| s.asserted_config_values.get("model").cloned())
            })
            .or_else(|| self.snapshot.env.get("DIMO_DEFAULT_MODEL").cloned())
            .filter(|candidate| driver.accepts_model_id(candidate, &merged_env));

        let effort = config_overrides
            .iter()
            .find(|o| o.key == "effort")
            .map(|o| o.value.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                stored.and_then(|s| {
                    s.asserted_config_values
                        .get("effort")
                        .cloned()
                        .or_else(|| current_select_option_value(&s.config_options, "effort"))
                })
            });

        let raw_mode = mode_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config_overrides
                    .iter()
                    .find(|o| o.key == "mode")
                    .map(|o| o.value.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| stored.and_then(|s| current_select_option_value(&s.config_options, "mode")));

        let normalized_mode = raw_mode
            .as_deref()
            .and_then(|m| driver.normalize_mode(m))
            .or(raw_mode);

        let effective_mode = if yolo {
            match normalized_mode.as_deref() {
                Some("plan") => Some("plan".to_string()),
                _ => Some(driver.capabilities().modes.yolo_mode_id),
            }
        } else {
            normalized_mode
        };

        (model, effort, effective_mode)
    }
}
