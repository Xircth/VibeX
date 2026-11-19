use super::*;

pub(super) fn profile_component_distribution_kind(
    profile: &agents::BuiltInProfile,
    component_kind: &str,
) -> PlannedDistributionKind {
    profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            agents::ProfileInstallSource::Npx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Npx)
            }
            agents::ProfileInstallSource::Uvx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Uvx)
            }
            agents::ProfileInstallSource::Binary { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Binary)
            }
            _ => None,
        })
        .unwrap_or(PlannedDistributionKind::Binary)
}

pub(super) fn is_native_engine_profile(agent_id: &AgentId) -> bool {
    let catalog = BuiltInProfileCatalog::bundled();
    catalog.profile(agent_id).is_some_and(|profile| {
        matches!(
            profile.effective_topology(
                agents::engine::EngineRuntimePreference::NativeFirst,
                std::env::var("DIMO_ENGINE_MODE").ok().as_deref(),
            ),
            ProfileTopology::NativeEngine(_)
        )
    })
}

pub(super) async fn probe_one_built_in_external_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    profile: &agents::BuiltInProfile,
    local_runtime: Option<&LocalRuntimeEvidence>,
) -> anyhow::Result<()> {
    let configured_env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(profile.agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .flatten();
    let configured_env = parse_agent_env(configured_env_json.as_deref())?;
    let native_engine = is_native_engine_profile(&profile.agent_id);
    let mut components = Vec::new();
    for component_kind in [
        ProfileComponent::AgentRuntime,
        ProfileComponent::AcpAdapter,
        ProfileComponent::CombinedRuntime,
    ] {
        if component_kind == ProfileComponent::AgentRuntime && profile.adapter_bundles_runtime() {
            continue;
        }
        let matching = profile
            .external_candidates
            .iter()
            .filter(|candidate| candidate.component == component_kind)
            .collect::<Vec<_>>();
        if matching.is_empty() {
            continue;
        }
        let is_runtime_candidate = matches!(
            component_kind,
            ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
        );
        let valid_local_runtime = is_runtime_candidate
            .then_some(local_runtime)
            .flatten()
            .filter(|evidence| {
                !agents::launch_program_is_legacy_acp_shim(&profile.agent_id, &evidence.path)
            });
        let mut adopted_component = None;
        let mut last_error: Option<anyhow::Error> = None;
        for candidate in matching {
            let attempt = async {
                let (executable, runtime_version) = if is_runtime_candidate {
                    if let Some(local_runtime) = valid_local_runtime.filter(|evidence| {
                        agents::candidate_command_matches(candidate.executable, &evidence.path)
                    }) {
                        (
                            local_runtime.path.clone(),
                            local_runtime.version.clone().unwrap_or_default(),
                        )
                    } else if native_engine {
                        let fallback_path = match utils::shell::resolve_executable_path(
                            candidate.executable,
                        )
                        .await
                        .filter(|path| {
                            !agents::launch_program_is_legacy_acp_shim(&profile.agent_id, path)
                        }) {
                            Some(path) => Some(path),
                            None => app.path().home_dir().ok().and_then(|home| {
                                agents::resolve_native_engine_cli(profile.agent_id.as_str(), &home)
                            }),
                        };
                        let Some(path) = fallback_path else {
                            anyhow::bail!("external local Runtime is missing");
                        };
                        (path, String::new())
                    } else if let Some(path) =
                        utils::shell::resolve_executable_path(candidate.executable)
                            .await
                            .filter(|path| {
                                !agents::launch_program_is_legacy_acp_shim(&profile.agent_id, path)
                            })
                    {
                        (path, String::new())
                    } else {
                        anyhow::bail!("external local Runtime is missing");
                    }
                } else {
                    let Some(path) = utils::shell::resolve_executable_path(candidate.executable)
                        .await
                    else {
                        anyhow::bail!(
                            "external Agent candidate `{}` was not found",
                            candidate.executable
                        );
                    };
                    (path, String::new())
                };
                let executable = utils::process::prefer_direct_spawn_executable(
                    tokio::fs::canonicalize(executable).await?,
                );
                if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file()
                {
                    anyhow::bail!("external candidate is not an absolute executable file");
                }
                if agents::launch_program_is_legacy_acp_shim(&profile.agent_id, &executable) {
                    anyhow::bail!("legacy ACP adapter shim cannot satisfy NativeEngine profile");
                }
                let mut version = if is_runtime_candidate && !runtime_version.is_empty() {
                    runtime_version
                } else {
                    let mut command = agent_process_command(&executable);
                    command.kill_on_drop(true);
                    command.args(candidate.version_args);
                    let output =
                        tokio::time::timeout(EXTERNAL_COMPONENT_VERSION_TIMEOUT, command.output())
                            .await
                            .map_err(|_| anyhow::anyhow!("external Agent version probe timed out"))??;
                    ensure_success("external Agent version probe", &output)?;
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    [stdout, stderr]
                        .into_iter()
                        .find(|value| !value.is_empty())
                        .unwrap_or_default()
                };
                if version.is_empty() {
                    if candidate.version_args.is_empty() {
                        version =
                            services::services::local_runtime_discovery::executable_file_revision(
                                &executable,
                            )
                            .ok_or_else(|| {
                                anyhow::anyhow!(
                                    "external Agent binary revision could not be read"
                                )
                            })?;
                    } else {
                        anyhow::bail!("external Agent version probe returned no version");
                    }
                }
                let sha256 =
                    format!("{:x}", Sha256::digest(tokio::fs::read(&executable).await?));
                Ok::<InstalledComponent, anyhow::Error>(InstalledComponent {
                    kind: profile_component_key(candidate.component).to_string(),
                    absolute_path: executable,
                    version,
                    sha256: Some(sha256),
                    trust_state: "tofu".to_string(),
                    ownership: "external".to_string(),
                    shared_resource_key: None,
                })
            }
            .await;
            match attempt {
                Ok(component) => {
                    adopted_component = Some(component);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        match adopted_component {
            Some(component) => components.push(component),
            None if component_kind == ProfileComponent::AgentRuntime => continue,
            None => {
                if let Some(error) = last_error {
                    return Err(error);
                }
            }
        }
    }
    let required_components_present = match profile.topology {
        ProfileTopology::NativeAcp => components
            .iter()
            .any(|component| component.kind == "combined_runtime"),
        ProfileTopology::AdapterBacked => components
            .iter()
            .any(|component| component.kind == "acp_adapter"),
        ProfileTopology::NativeEngine(_) => components.iter().any(|component| {
            matches!(
                component.kind.as_str(),
                "combined_runtime" | "agent_runtime" | "acp_adapter"
            )
        }),
    };
    if !required_components_present {
        anyhow::bail!("not every Profile-declared external component is available");
    }
    let observed = components
        .iter()
        .map(|component| ObservedUserComponent {
            component_id: component.kind.clone(),
            version: Some(component.version.clone()),
        })
        .collect::<Vec<_>>();
    if !observed_satisfies_profile(profile, &observed) {
        anyhow::bail!(
            "user-environment Agent is older than the Built-in Profile pin and must be reinstalled"
        );
    }
    let runtime = components.iter().find(|component| {
        matches!(
            component.kind.as_str(),
            "agent_runtime" | "combined_runtime"
        )
    });
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"))
        .ok_or_else(|| anyhow::anyhow!("external ACP executable is missing"))?;
    let args = profile_component_from_key(&acp.kind)
        .map(|component| {
            agents::acp_launch_args_for_program(profile, component, Some(&acp.absolute_path))
        })
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    if profile.agent_id.as_str() == "pi" {
        env.extend(pi_runtime_lock_env(&configured_env));
    }
    let component_dirs = components
        .iter()
        .filter_map(|component| component.absolute_path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    let user_path =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    let (mut path_entries, fallback_entries) =
        if agents::component_dirs_precede_user_path(&profile.agent_id) {
            (component_dirs, user_path)
        } else {
            (user_path, component_dirs)
        };
    path_entries.extend(fallback_entries);
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .to_string(),
    );
    if let Some(runtime) = runtime {
        bind_profile_runtime_executable(&profile.agent_id, &runtime.absolute_path, &mut env);
    }
    let mut launch_lock = SessionLaunchLock {
        agent_id: profile.agent_id.clone(),
        absolute_acp_program: acp.absolute_path.clone(),
        args,
        env,
        runtime_version: runtime
            .map(|component| component.version.clone())
            .unwrap_or_default(),
        acp_version: acp.version.clone(),
    };
    let working_dir = app
        .path()
        .app_data_dir()?
        .join("agents")
        .join(profile.agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    if profile.agent_id.as_str() == "pi" {
        // Runtime preferences are only needed by the adoption handshake. They
        // remain live settings and must not be frozen into the persisted lock.
        for key in [
            "PI_ACP_PI_COMMAND",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
        ] {
            launch_lock.env.remove(key);
        }
    }

    let plan = ResolvedInstallPlan {
        agent_id: profile.agent_id.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: acp.version.clone(),
        platform: agents::current_platform(),
        components: components
            .iter()
            .map(|component| PlannedInstallComponent {
                component_id: component.kind.clone(),
                distribution_kind: profile_component_distribution_kind(profile, &component.kind),
                version: component.version.clone(),
                resolved_source: component.absolute_path.display().to_string(),
                command: component
                    .absolute_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                args: Vec::new(),
                env: Default::default(),
                trust: ArtifactTrust::Tofu,
            })
            .collect(),
    };
    persist_installed_lock(
        pool,
        Uuid::new_v4(),
        &plan,
        &InstalledPlan {
            launch_lock,
            components,
        },
        "external",
    )
    .await?;
    if let Err(error) = record_post_install_probe(app, pool, &profile.agent_id).await {
        tracing::debug!(
            agent_id = %profile.agent_id,
            %error,
            "adopted Agent CLI; ACP handshake will be retried when a session starts"
        );
    }
    Ok(())
}

pub(super) fn profile_component_key(component: ProfileComponent) -> &'static str {
    match component {
        ProfileComponent::AgentRuntime => "agent_runtime",
        ProfileComponent::AcpAdapter => "acp_adapter",
        ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

pub(super) fn profile_component_from_key(key: &str) -> Option<ProfileComponent> {
    match key {
        "agent_runtime" => Some(ProfileComponent::AgentRuntime),
        "acp_adapter" => Some(ProfileComponent::AcpAdapter),
        "combined_runtime" => Some(ProfileComponent::CombinedRuntime),
        _ => None,
    }
}

pub(super) fn bind_profile_runtime_executable(
    agent_id: &AgentId,
    runtime_path: &Path,
    env: &mut BTreeMap<String, String>,
) {
    bind_runtime_executable_env(agent_id, runtime_path, env);
}

pub(super) fn pi_runtime_lock_env(
    configured_env: &HashMap<String, String>,
) -> BTreeMap<String, String> {
    [
        "PI_ACP_PI_COMMAND",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
    ]
    .into_iter()
    .filter_map(|key| {
        configured_env
            .get(key)
            .cloned()
            .map(|value| (key.to_string(), value))
    })
    .collect()
}

pub(crate) fn management_error(
    code: AgentManagementErrorCode,
    message: impl Into<String>,
    agent_id: Option<AgentId>,
) -> AgentManagementErrorView {
    AgentManagementErrorView {
        code,
        message: message.into(),
        agent_id,
        preflight_item_id: None,
    }
}

pub(super) fn internal_error(error: impl std::fmt::Display) -> AgentManagementErrorView {
    management_error(AgentManagementErrorCode::Internal, error.to_string(), None)
}

pub(super) async fn record_post_install_probe(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    struct LockedPayload {
        absolute_acp_program: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        runtime_version: String,
        acp_version: String,
    }

    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await?;
    let payload: LockedPayload = serde_json::from_str(&resolved_json)?;
    if agents::launch_program_is_legacy_acp_shim(agent_id, &payload.absolute_acp_program) {
        anyhow::bail!("persisted lock points to legacy ACP adapter shim");
    }
    let mut launch_env = payload.env.into_iter().collect::<HashMap<_, _>>();
    let configured_env = read_agent_environment(pool, agent_id)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    launch_env.extend(configured_env);
    launch_env.remove("PI_ACP_TRUST_WORKSPACE");
    let mut launch_args = payload.args;
    agents::apply_built_in_launch_policy_for_program(
        agent_id,
        Some(&payload.absolute_acp_program),
        &mut launch_env,
        &mut launch_args,
    );
    let launch_lock = SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: payload.absolute_acp_program,
        args: launch_args,
        env: launch_env.into_iter().collect(),
        runtime_version: payload.runtime_version,
        acp_version: payload.acp_version,
    };
    let working_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .join("agents")
        .join(agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    let capability_auth_observation = if is_native_engine_profile(agent_id) {
        let mut command = agent_process_command(&launch_lock.absolute_acp_program);
        command
            .arg("--version")
            .current_dir(&working_dir)
            .envs(&launch_lock.env)
            .kill_on_drop(true);
        let output = tokio::time::timeout(EXTERNAL_COMPONENT_VERSION_TIMEOUT, command.output())
            .await
            .map_err(|_| anyhow::anyhow!("native engine version probe timed out"))??;
        ensure_success("native engine version probe", &output)?;
        None
    } else {
        let capabilities = probe_acp_capabilities(
            agent_id,
            &launch_lock,
            &working_dir,
            &CancellationToken::new(),
        )
        .await?;
        capabilities.authentication
    };
    let native_authentication = if app.path().home_dir().is_ok() {
        let agent_env = read_agent_environment(pool, agent_id)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        observe_native_authentication(app, agent_id, &agent_env).await
    } else {
        AgentAuthenticationStatus::NotRequired
    };
    let authentication_required_by_default = BuiltInProfileCatalog::management()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (observed, authentication_required) = resolve_authentication_observation(
        native_authentication,
        capability_auth_observation.as_ref(),
        authentication_required_by_default,
    );
    let authentication = recorded_account_over_residue(pool, agent_id, observed).await;
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required
            && !matches!(
                authentication,
                AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
            ),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))
}

pub(super) async fn resolve_native_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    let local = detect_account_login(home, agent_id, environment).await;
    let document = match agent_id.as_str() {
        "codex" => read_account_evidence_document(home, agent_id, environment).await,
        _ => None,
    };
    agents::account_still_present(
        local,
        agents::confirm_account_session(agent_id, local, document.as_ref()).await,
    )
}

pub(super) async fn read_account_evidence_document(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<serde_json::Value> {
    let bytes = read_account_evidence_bytes(home, agent_id, environment).await?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) async fn detect_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    agents::official_account_present(home, agent_id, environment).await
}

pub(super) async fn read_account_evidence_bytes(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<Vec<u8>> {
    let catalog = BuiltInProfileCatalog::bundled();
    let evidence = catalog
        .profile(agent_id)
        .and_then(|profile| profile.account_evidence.as_ref())?;
    let override_directory = evidence.directory_override_env.and_then(|name| {
        environment
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_agent_home_path(home, value))
            .or_else(|| {
                std::env::var_os(name)
                    .filter(|value| !value.is_empty())
                    .map(|value| expand_agent_home_path(home, &value.to_string_lossy()))
            })
    });
    let directory = override_directory
        .map(|directory| directory.join(evidence.override_relative_directory))
        .unwrap_or_else(|| home.join(evidence.home_relative_directory));
    tokio::fs::read(directory.join(evidence.relative_file))
        .await
        .ok()
}

pub(super) fn expand_agent_home_path(home: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

pub(super) fn resolve_agent_home_directory(
    home: &Path,
    environment: &HashMap<String, String>,
    variable: &str,
    fallback: &str,
) -> PathBuf {
    environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(fallback))
}

pub(super) fn resolve_model_provider_native_home(
    home: &Path,
    environment: &HashMap<String, String>,
    agent_id: &AgentId,
) -> PathBuf {
    match agent_id.as_str() {
        "pi" => resolve_agent_home_directory(home, environment, "PI_CODING_AGENT_DIR", ".pi/agent"),
        "claude_code" => {
            resolve_agent_home_directory(home, environment, "CLAUDE_CONFIG_DIR", ".claude")
        }
        "grok" => resolve_agent_home_directory(home, environment, "GROK_HOME", ".grok"),
        "kimi_code" => {
            resolve_agent_home_directory(home, environment, "KIMI_CODE_HOME", ".kimi-code")
        }
        "hermes" => resolve_agent_home_directory(home, environment, "HERMES_HOME", ".hermes"),
        "openclaw" => resolve_agent_home_directory(home, environment, "OPENCLAW_HOME", ".openclaw"),
        "cline" => resolve_agent_home_directory(home, environment, "CLINE_DIR", ".cline/data"),
        "gemini" | "antigravity" => {
            if let Some(value) = environment
                .get("GEMINI_HOME")
                .filter(|value| !value.trim().is_empty())
            {
                expand_agent_home_path(home, value)
            } else {
                home.join(".gemini")
            }
        }
        _ => resolve_agent_home_directory(home, environment, "CODEX_HOME", ".codex"),
    }
}

pub(super) struct InstalledComponent {
    pub(super) kind: String,
    pub(super) absolute_path: PathBuf,
    pub(super) version: String,
    pub(super) sha256: Option<String>,
    pub(super) trust_state: String,
    pub(super) ownership: String,
    pub(super) shared_resource_key: Option<String>,
}

pub(super) struct InstalledPlan {
    pub(super) launch_lock: SessionLaunchLock,
    pub(super) components: Vec<InstalledComponent>,
}

pub(super) fn ensure_success(label: &str, output: &std::process::Output) -> anyhow::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!(
        "{label} failed: {}",
        redact_operation_output(&String::from_utf8_lossy(&output.stderr))
    )
}

/// The global prefix npm would install into, asked of the npm on the current
/// PATH. Discovery has no locked Node runtime yet, so there is nothing else to
/// ask.
pub(super) async fn live_npm_global_prefix() -> Option<PathBuf> {
    let npm = utils::shell::resolve_executable_path(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .await?;
    let mut command = agent_process_command(&npm);
    command.arg("prefix").arg("-g").kill_on_drop(true);
    let output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    if prefix.is_empty() {
        None
    } else {
        Some(PathBuf::from(prefix))
    }
}

pub(super) const ACP_CAPABILITY_PROBE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10);

pub(super) async fn probe_acp_capabilities(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<AcpCapabilitySnapshot> {
    let (event_tx, _event_rx) = agents::manager::manager_event_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let initialized: anyhow::Result<()> = tokio::select! {
        result = ready => match result {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(anyhow::anyhow!("ACP process exited before initialize")),
        },
        () = tokio::time::sleep(ACP_CAPABILITY_PROBE_TIMEOUT) => {
            Err(anyhow::anyhow!("ACP capability probe timed out"))
        }
        () = cancellation.cancelled() => Err(anyhow::anyhow!("operation canceled")),
    };
    if let Err(error) = initialized {
        let _ = manager.disconnect(connection_id).await;
        return Err(error);
    }

    let capabilities = manager.connection_capabilities(connection_id).await;
    let disconnected = manager.disconnect(connection_id).await;
    match (capabilities, disconnected) {
        (Ok(capabilities), Ok(())) => Ok(capabilities),
        (Err(error), _) => Err(error.into()),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

pub(super) fn resolve_authentication_observation(
    native_authentication: AgentAuthenticationStatus,
    observation: Option<&AcpAuthenticationObservationSnapshot>,
    authentication_required_by_default: bool,
) -> (AgentAuthenticationStatus, bool) {
    if matches!(
        native_authentication,
        AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
    ) {
        return (native_authentication, false);
    }

    match observation.map(|observation| observation.state) {
        Some(AuthenticationObservationState::Authenticated) => {
            (AgentAuthenticationStatus::MultipleUnknown, false)
        }
        Some(AuthenticationObservationState::Unauthenticated)
            if authentication_required_by_default =>
        {
            (AgentAuthenticationStatus::NotLoggedIn, true)
        }
        Some(AuthenticationObservationState::Unauthenticated) => {
            (AgentAuthenticationStatus::NotRequired, false)
        }
        Some(
            AuthenticationObservationState::Unknown | AuthenticationObservationState::Degraded,
        )
        | None => (
            native_authentication,
            authentication_required_by_default
                && matches!(
                    native_authentication,
                    AgentAuthenticationStatus::NotLoggedIn
                        | AgentAuthenticationStatus::MultipleUnknown
                ),
        ),
    }
}

pub(super) async fn persist_installed_lock(
    pool: &sqlx::SqlitePool,
    lock_id: Uuid,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
    installation_ownership: &str,
) -> anyhow::Result<()> {
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({
            "kind": "built_in_profile"
        }),
        LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "built_in_profile_with_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::UserDefinition { definition_sha256 } => serde_json::json!({
            "kind": "user_definition",
            "definition_sha256": definition_sha256,
        }),
    };
    let resolved_json = serde_json::json!({
        "source": source,
        "frozen_plan": plan,
        "absolute_acp_program": installation.launch_lock.absolute_acp_program,
        "args": installation.launch_lock.args,
        "env": installation.launch_lock.env,
        "runtime_version": installation.launch_lock.runtime_version,
        "acp_version": installation.launch_lock.acp_version,
    })
    .to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(lock_id.to_string())
    .bind(plan.agent_id.as_str())
    .bind(plan.registry_bound_version())
    .bind(&plan.platform)
    .bind(
        plan.components
            .first()
            .map(|component| format!("{:?}", component.distribution_kind).to_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    )
    .bind(resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    for component in &installation.components {
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256,
                trust_state, ownership, shared_resource_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind(&component.trust_state)
        .bind(&component.ownership)
        .bind(&component.shared_resource_key)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, ?, 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(plan.agent_id.as_str())
    .bind(installation_ownership)
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ?
             AND (severity = 'error' OR operation_kind = 'launch_gate')
             AND read_at IS NULL"#,
    )
    .bind(plan.agent_id.as_str())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) fn redact_operation_output(value: &str) -> String {
    const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
    const REDACTED: &str = "[REDACTED]";
    let mut boundary = value.len().min(MAX_DIAGNOSTIC_BYTES);
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut redacted = value[..boundary].to_string();
    for marker in [
        "ANTHROPIC_API_KEY=",
        "ANTHROPIC_AUTH_TOKEN=",
        "OPENAI_API_KEY=",
        "GEMINI_API_KEY=",
        "GOOGLE_API_KEY=",
        "XAI_API_KEY=",
        "KIMI_API_KEY=",
        "OPENROUTER_API_KEY=",
        "API_KEY=",
        "api_key=",
        "apiKey=",
        "--api-key ",
        "Authorization: Bearer ",
        "authorization: bearer ",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = redacted[search_from..].find(marker) {
            let start = search_from + relative_start;
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map(|offset| value_start + offset)
                .unwrap_or(redacted.len());
            if redacted[value_start..].starts_with(REDACTED) {
                search_from = value_start + REDACTED.len();
                continue;
            }
            redacted.replace_range(value_start..value_end, REDACTED);
            search_from = value_start + REDACTED.len();
        }
    }
    if redacted.len() > MAX_DIAGNOSTIC_BYTES {
        let mut boundary = MAX_DIAGNOSTIC_BYTES;
        while boundary > 0 && !redacted.is_char_boundary(boundary) {
            boundary -= 1;
        }
        redacted.truncate(boundary);
    }
    redacted
}

pub(super) fn dsh_paths(
    home: &Path,
    environment: &HashMap<String, String>,
) -> dsh_configuration::DshPaths {
    dsh_configuration::resolve_paths(home, environment)
}

pub(super) fn parse_agent_env(
    value: Option<&str>,
) -> Result<HashMap<String, String>, serde_json::Error> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(super) async fn read_agent_environment(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, AgentManagementErrorView> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    parse_agent_env(env_json.as_deref()).map_err(internal_error)
}

pub(super) async fn recorded_authentication(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> AgentAuthenticationStatus {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match value.as_deref() {
        Some("account") => AgentAuthenticationStatus::Account,
        Some("api_key") => AgentAuthenticationStatus::ApiKey,
        Some("multiple_unknown") => AgentAuthenticationStatus::MultipleUnknown,
        Some("not_required") => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

pub(super) async fn recorded_account_over_residue(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    observed: AgentAuthenticationStatus,
) -> AgentAuthenticationStatus {
    let account_signed_out = AgentManagementApplicationService::new(pool.clone())
        .account_signed_out(agent_id)
        .await
        .unwrap_or(false);
    agents::resolve_observed_authentication(
        recorded_authentication(pool, agent_id).await,
        observed,
        false,
        account_signed_out,
    )
}

pub(crate) async fn sync_authentication_probe_with_requirement(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
    authentication_required: bool,
) -> Result<(), AgentManagementErrorView> {
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, Some(authentication_required))
        .await
        .map_err(internal_error)
}
