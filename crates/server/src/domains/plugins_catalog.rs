use super::*;

impl ServerApplicationDomains {
    pub(crate) async fn plugin_catalog(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let inventory = control_plane
            .runtime_inventory()
            .await
            .map_err(internal_error)?;
        let actions = control_plane
            .catalog()
            .await
            .map_err(internal_error)?
            .into_iter()
            .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
            .filter(|plugin| {
                plugin.runtimes.iter().all(|required| {
                    inventory.iter().any(|installed| {
                        installed.id == required.id
                            && required
                                .version
                                .as_deref()
                                .is_none_or(|version| version == installed.version)
                    })
                })
            })
            .flat_map(|plugin| {
                let plugin_id = plugin.id().to_owned();
                let required_tools = plugin
                    .runtimes
                    .iter()
                    .map(|runtime| runtime.id.clone())
                    .collect::<Vec<_>>();
                plugin
                    .package
                    .invocations
                    .into_iter()
                    .filter_map(move |invocation| {
                        (invocation.kind == plugins::InvocationKind::Action).then(|| {
                            json!({
                                "pluginId": plugin_id,
                                "actionId": invocation.id,
                                "label": invocation.label,
                                "requiredSkills": if invocation.required_skills.is_empty() {
                                    invocation.skill.into_iter().collect::<Vec<_>>()
                                } else {
                                    invocation.required_skills
                                },
                                "requiredTools": required_tools,
                                "promptBlocks": [{ "type": "text", "text": invocation.prompt }],
                                "artifactIntent": null,
                            })
                        })
                    })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "actions": actions }))
    }

    pub(super) async fn collaboration_call(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        struct CollaborationCallArgs {
            capability: String,
            operation: String,
            #[serde(default)]
            input: Value,
        }
        let args: CollaborationCallArgs = parse(args)?;
        let enabled = self.deployment.config().read().await.multi_agent_enabled;
        if !enabled || !matches!(args.capability.as_str(), "collaboration" | "workspace") {
            return Err(ApplicationError::capability_unavailable(
                "capability_unimplemented",
            ));
        }
        self.capability_broker
            .call("host", 0, &args.capability, &args.operation, args.input)
            .await
            .map_err(|error| ApplicationError::bad_request(error.code()))
    }

    pub(super) async fn official_product_mcp_state(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let state = control_plane.official_product_mcp_gate().capability_state();
        Ok(json!({
            "delegation": state.delegation,
            "feedback": state.feedback,
            "ask": state.ask,
            "sessions": state.sessions,
            "sessionControl": state.session_control,
        }))
    }

    pub(super) async fn plugin_mcp_status(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let plugins = control_plane.catalog().await.map_err(internal_error)?;
        let host_collaboration_enabled = self.deployment.config().read().await.multi_agent_enabled;
        let binary_runnable = |binary_id: &str| {
            utils::host_bin::locate_runnable_host_family_binary(binary_id).is_some()
        };
        let mut report = plugins::with_host_collaboration_mcp(
            plugins::plugin_mcp_status_report(&plugins, binary_runnable),
            host_collaboration_enabled,
            binary_runnable,
        );
        if let Some(service) = delegation::DelegationService::current() {
            report.listening = service.is_listening().await;
            if !report.listening
                && report.plugins.iter().any(|plugin| plugin.enabled)
                && report.state != plugins::PluginMcpHeadline::Unavailable
            {
                report.state = plugins::PluginMcpHeadline::Stopped;
            }
        }
        serialize(report)
    }

    pub(super) async fn plugin_mcp_ensure_running(&self) -> Result<Value, ApplicationError> {
        let service = delegation::DelegationService::current().ok_or_else(|| {
            ApplicationError::internal("delegation broker is not installed in this process")
        })?;
        service
            .ensure_running()
            .await
            .map_err(ApplicationError::internal)?;
        Ok(json!({ "listening": service.is_listening().await }))
    }

    pub(super) async fn plugin_control_catalog(&self) -> Result<Value, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let plugins = control_plane.catalog().await.map_err(internal_error)?;
        let runtimes = control_plane
            .runtime_inventory()
            .await
            .map_err(internal_error)?;
        let mut plugin_values = Vec::with_capacity(plugins.len());
        for plugin in &plugins {
            let quarantine_reason = control_plane
                .quarantine_reason(plugin.id())
                .await
                .ok()
                .flatten();
            plugin_values.push(plugin_control_item_with_quarantine(
                plugin,
                quarantine_reason,
            ));
        }
        self.merge_native_cli_plugins(&mut plugin_values).await;
        let runtime_values = runtimes
            .into_iter()
            .map(|runtime| {
                json!({
                    "id": runtime.id,
                    "version": runtime.version,
                    "target": runtime.target,
                    "contentDigest": runtime.content_digest,
                    // Remote catalog readers receive runtime identity/evidence,
                    // never a Host filesystem capability or absolute path.
                    "executablePath": "",
                    "ownership": runtime.ownership,
                    "installer": runtime.installer,
                    "probe": runtime.probe,
                    "referencedPlugins": runtime.referenced_plugins,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "plugins": plugin_values, "runtimes": runtime_values }))
    }

    pub(super) async fn plugin_product_detail(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginIdentityArgs = parse(args)?;
        let plugin = self
            .plugin_control_plane()
            .await?
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        let refreshed = plugins::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
            .unwrap_or_else(|_| plugin.package.clone());
        let detail = normalize_product_detail_readme(
            refreshed.product_detail().map_err(internal_error)?,
        );
        serialize(detail)
    }

    pub(super) async fn plugin_save_config(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginConfigArgs = parse(args)?;
        let plugin = self
            .plugin_control_plane()
            .await?
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        let current_package =
            plugins::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
                .unwrap_or_else(|_| plugin.package.clone());
        current_package
            .write_config(args.config)
            .map_err(internal_error)?;
        self.refresh_official_product_runtime().await?;
        // Re-inspect before projecting: `plugin` still carries the config loaded
        // before the write, and the Skill domain gate must read the one that was
        // just persisted.
        let refreshed = plugins::PluginPackage::inspect(&plugin.source.path, plugin.source.kind)
            .map_err(internal_error)?;
        let _ = self
            .plugin_control_plane()
            .await?
            .notify_config_updated(&args.plugin_id, refreshed.config.clone())
            .await;
        if plugin.activation == plugins::PluginActivation::Enabled {
            self.apply_default_plugin_skill_projections(&refreshed)
                .await?;
            self.apply_default_plugin_mcp_projections(&plugin).await?;
        }
        let detail = normalize_product_detail_readme(
            refreshed.product_detail().map_err(internal_error)?,
        );
        serialize(detail)
    }

    pub(super) async fn plugin_contribution_catalog(&self) -> Result<Value, ApplicationError> {
        let catalog = self
            .plugin_control_plane()
            .await?
            .contributions()
            .await
            .map_err(internal_error)?;
        serialize(catalog)
    }

    pub(super) async fn provider_catalog_list(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        struct ProviderCatalogListArgs {
            #[serde(alias = "agentId")]
            agent_id: String,
        }
        let args: ProviderCatalogListArgs = parse(args)?;
        let agent_id = AgentId::parse(&args.agent_id).map_err(|_| {
            ApplicationError::bad_request(format!(
                "provider_agent_unknown: `{}` is not an Agent id",
                args.agent_id
            ))
        })?;
        if matches!(agent_id.as_str(), "cursor" | "codebuddy" | "qoder") {
            return serialize(plugins::ProviderCatalogListView {
                agent_id: agent_id.to_string(),
                generation: 0,
                templates: Vec::new(),
                sources: Vec::new(),
            });
        }
        let listed = self
            .plugin_control_plane()
            .await
            .map_err(|_| ApplicationError::capability_unavailable("provider_catalog_unavailable"))?
            .list_provider_catalog(agent_id.as_str())
            .await
            .map_err(|error| {
                if error.code() == "provider_catalog_unavailable" {
                    ApplicationError::capability_unavailable(error.message())
                } else {
                    internal_error(error)
                }
            })?;
        serialize(listed)
    }

    pub(super) async fn plugin_resolve_file_opener(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ResolveFileOpenerArgs = parse(args)?;
        serialize(
            self.plugin_control_plane()
                .await?
                .resolve_file_opener(args.extension.as_deref(), args.media_type.as_deref())
                .await
                .map_err(internal_error)?,
        )
    }

    pub(super) async fn set_host_collaboration_enabled(
        &self,
        enabled: bool,
    ) -> Result<Value, ApplicationError> {
        let mut new_config = self.deployment.config().read().await.clone();
        new_config.multi_agent_enabled = enabled;
        new_config.clamp_multi_agent();
        let path = utils::assets::settings_path();
        services::services::config::save_config_to_file(&new_config, &path)
            .await
            .map_err(internal_error)?;
        services::services::config::publish_config_runtime(&new_config).await;
        {
            let mut config = self.deployment.config().write().await;
            *config = new_config.clone();
        }
        self.refresh_official_product_runtime().await?;
        serialize(json!({
            "id": plugins::HOST_MULTI_AGENT_ID,
            "enabled": enabled,
        }))
    }

    pub(super) async fn plugin_control_set_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginEnabledArgs = parse(args)?;
        if args.plugin_id == plugins::HOST_MULTI_AGENT_ID {
            return self.set_host_collaboration_enabled(args.enabled).await;
        }
        let control_plane = self.plugin_control_plane().await?;
        if control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .is_none()
        {
            return self
                .native_plugin_set_enabled(&args.plugin_id, args.enabled)
                .await?
                .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)));
        }
        if args.enabled {
            let plugin = control_plane
                .plugin(&args.plugin_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
            let has_worker = plugin.package.entrypoints.worker.is_some();
            self.ensure_plugin_runtimes(&plugin).await?;
            self.ensure_required_plugin_dependencies(&plugin.package)
                .await?;
            let grants = plugins::candidate_capability_grants(&plugin.package, &[], &[])
                .map_err(plugin_error)?;
            control_plane
                .validate_runtime_readiness(&args.plugin_id)
                .await
                .map_err(|error| ApplicationError::conflict(error.to_string()))?;
            if has_worker {
                control_plane
                    .activate_and_enable(
                        &self
                            .worker_runtime
                            .resolve()
                            .await
                            .map_err(internal_error)?,
                        &args.plugin_id,
                        &grants,
                        self.capability_broker.clone(),
                    )
                    .await
                    .map_err(|error| ApplicationError::conflict(error.to_string()))?;
            } else {
                control_plane
                    .set_enabled(&args.plugin_id, true)
                    .await
                    .map_err(internal_error)?;
            }
        } else {
            self.capability_broker
                .kill_plugin_processes(&args.plugin_id)
                .await;
            if let Some(plugin) = control_plane
                .plugin(&args.plugin_id)
                .await
                .map_err(internal_error)?
            {
                Self::remove_plugin_projections(&plugin).await?;
                self.mark_plugin_bindings_disabled(&args.plugin_id).await?;
            }
            if let Some(reason) = args
                .quarantine_reason
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                control_plane
                    .quarantine_plugin(&args.plugin_id, reason)
                    .await
                    .map_err(internal_error)?;
            } else {
                control_plane
                    .set_enabled(&args.plugin_id, false)
                    .await
                    .map_err(internal_error)?;
            }
        }
        self.refresh_official_product_runtime().await?;
        let plugin = control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        if args.enabled {
            self.apply_default_plugin_projections(&plugin).await?;
        }
        let quarantine_reason = control_plane
            .quarantine_reason(plugin.id())
            .await
            .ok()
            .flatten();
        Ok(plugin_control_item_with_quarantine(
            &plugin,
            quarantine_reason,
        ))
    }

    pub(super) async fn plugin_control_grant_permissions(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginGrantPermissionsArgs = parse(args)?;
        let _ = args.permission_ids;
        let control_plane = self.plugin_control_plane().await?;
        serialize(
            control_plane
                .capability_grants(&args.plugin_id)
                .await
                .map_err(internal_error)?,
        )
    }

    pub(super) async fn plugin_control_install_runtime(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PluginRuntimeArgs = parse(args)?;
        let control_plane = self.plugin_control_plane().await?;
        let plugin = control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("plugin {}", args.plugin_id)))?;
        let runtime = plugin
            .runtimes
            .iter()
            .find(|runtime| runtime.id == args.runtime_id)
            .ok_or_else(|| ApplicationError::not_found(format!("runtime {}", args.runtime_id)))?;
        let installation = self.install_declared_runtime(&plugin, runtime).await?;
        serialize(installation)
    }

    pub(super) async fn ensure_plugin_runtimes(
        &self,
        plugin: &plugins::InstalledPlugin,
    ) -> Result<(), ApplicationError> {
        for runtime in &plugin.runtimes {
            let ready = self
                .plugin_control_plane
                .runtime_for_plugin(plugin.id(), &runtime.id)
                .await
                .map_err(plugin_error)?
                .is_some_and(|locked| runtime_lock_matches(runtime, &locked));
            if !ready {
                self.install_declared_runtime(plugin, runtime).await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn ensure_required_plugin_dependencies(
        &self,
        package: &plugins::PluginPackage,
    ) -> Result<(), ApplicationError> {
        let mut visited = std::collections::BTreeSet::from([package.id.as_str().to_owned()]);
        self.ensure_required_plugin_dependencies_inner(package, &mut visited)
            .await
    }

    pub(super) async fn ensure_required_plugin_dependencies_inner(
        &self,
        package: &plugins::PluginPackage,
        visited: &mut std::collections::BTreeSet<String>,
    ) -> Result<(), ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        for dependency in package.plugin_dependencies() {
            if !dependency.required {
                continue;
            }
            if !visited.insert(dependency.id.clone()) {
                continue;
            }
            let installed = control_plane
                .plugin(&dependency.id)
                .await
                .map_err(internal_error)?;
            if installed.is_none() {
                let owner = dependency
                    .publisher
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("vibex");
                let _ = Box::pin(self.plugin_marketplace_install(json!({
                    "owner": owner,
                    "pluginName": dependency.id,
                    "conflict": "keep",
                })))
                .await;
            }
            if let Some(dep_plugin) = control_plane
                .plugin(&dependency.id)
                .await
                .map_err(internal_error)?
            {
                Box::pin(
                    self.ensure_required_plugin_dependencies_inner(&dep_plugin.package, visited),
                )
                .await?;
                let is_live = control_plane
                    .active_generation(&dependency.id)
                    .await
                    .is_some();
                if dep_plugin.activation != plugins::PluginActivation::Enabled || !is_live {
                    let _ = Box::pin(self.plugin_control_set_enabled(json!({
                        "pluginId": dependency.id,
                        "enabled": true,
                    })))
                    .await;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn install_declared_runtime(
        &self,
        plugin: &plugins::InstalledPlugin,
        runtime: &plugins::RuntimeContribution,
    ) -> Result<plugins::RuntimeInstallation, ApplicationError> {
        if let Some(existing) = self
            .plugin_control_plane
            .runtime_inventory()
            .await
            .map_err(plugin_error)?
            .into_iter()
            .find(|locked| runtime_lock_matches(runtime, locked))
        {
            self.plugin_control_plane
                .record_runtime(plugin.id(), existing.clone())
                .await
                .map_err(plugin_error)?;
            return Ok(existing);
        }
        let host = plugins::ContentAddressedRuntimeHost::new(self.runtime_root.clone(), runtime)
            .map_err(plugin_error)?;
        let installation = plugins::GlobalRuntimeInstaller::new(&host)
            .install(plugin.id(), runtime)
            .await
            .map_err(plugin_error)?;
        self.plugin_control_plane
            .record_runtime(plugin.id(), installation.clone())
            .await
            .map_err(plugin_error)?;
        Ok(installation)
    }

    pub(crate) async fn plugin_control_import(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PluginImportArgs {
            path: String,
            #[serde(default)]
            conflict: Option<String>,
            #[serde(default)]
            conflict_decision: Option<String>,
            #[serde(default)]
            developer_link: bool,
            #[serde(default)]
            origin: Option<String>,
            #[serde(default)]
            git_ref: Option<String>,
            #[serde(default)]
            git_sha: Option<String>,
            #[serde(default)]
            locked: bool,
            #[serde(default)]
            show_tree: Option<bool>,
        }
        let args: PluginImportArgs = parse(args)?;
        let source = std::path::PathBuf::from(&args.path);
        if !source.exists() {
            return Err(ApplicationError::not_found(format!(
                "plugin path {}",
                args.path
            )));
        }
        if args.developer_link && source.is_file() {
            return Err(ApplicationError::bad_request(
                "linked development install requires a Plugin directory",
            ));
        }
        let decision = match args
            .conflict
            .as_deref()
            .or(args.conflict_decision.as_deref())
        {
            Some("keep") => plugins::ConflictDecision::KeepInstalled,
            Some("replace") => plugins::ConflictDecision::Replace,
            _ => plugins::ConflictDecision::Reject,
        };
        let source_kind = if args.developer_link {
            plugins::PluginSourceKind::DeveloperLink
        } else if plugins::origin_kind(args.origin.as_deref()) == Some("marketplace") {
            plugins::PluginSourceKind::Marketplace
        } else {
            plugins::PluginSourceKind::Snapshot
        };
        let incoming =
            plugins::PluginPackage::inspect(&source, source_kind).map_err(plugin_error)?;
        let existing = self
            .plugin_control_plane
            .plugin(incoming.id.as_str())
            .await
            .map_err(plugin_error)?;
        if let Some(existing) = &existing {
            if decision == plugins::ConflictDecision::KeepInstalled {
                return Ok(plugin_control_item(existing));
            }
            if decision != plugins::ConflictDecision::Replace {
                return Err(ApplicationError::conflict("plugin is already installed"));
            }
        }
        let mut package = if args.developer_link {
            plugins::PluginPackage::inspect(&source, source_kind).map_err(plugin_error)?
        } else if let Some(existing) = &existing {
            plugins::PluginPackage::materialize_candidate(
                &source,
                &self.runtime_root.join("plugins/candidates"),
                &existing.package,
            )
            .map_err(plugin_error)?
        } else {
            let storage = self.runtime_root.join("plugins/snapshots");
            plugins::PluginPackage::materialize(&source, &storage, source_kind)
                .map_err(plugin_error)?
        };
        if package.api_version != "2.0" {
            return Err(ApplicationError::bad_request(format!(
                "unsupported plugin apiVersion `{}`; VibeX v2 plugin architecture requires apiVersion \"2.0\"",
                package.api_version
            )));
        }
        package.source.kind = source_kind;
        package.source.origin = args.origin;
        package.source.git_ref = args.git_ref;
        package.source.git_sha = args.git_sha;
        package.source.locked = args.locked;
        package.source.show_tree = args.show_tree.or(package.source.show_tree);
        let installed = self
            .plugin_control_plane
            .plugin(package.id.as_str())
            .await
            .map_err(plugin_error)?;
        let replacing_enabled = decision == plugins::ConflictDecision::Replace
            && installed
                .as_ref()
                .is_some_and(|plugin| plugin.activation == plugins::PluginActivation::Enabled);
        if replacing_enabled {
            self.ensure_required_plugin_dependencies(&package).await?;
            let grants =
                plugins::candidate_capability_grants(&package, &[], &[]).map_err(plugin_error)?;
            let node = self
                .worker_runtime
                .resolve()
                .await
                .map_err(internal_error)?;
            return self
                .plugin_control_plane
                .update_and_activate(&node, package, &grants, self.capability_broker.clone())
                .await
                .map(|plugin| plugin_control_item(&plugin))
                .map_err(|error| ApplicationError::conflict(format!("{}: {error}", error.code())));
        }
        let imported = self
            .plugin_control_plane
            .import(package, decision)
            .await
            .map_err(plugin_error)?;
        if existing.is_none()
            && decision != plugins::ConflictDecision::KeepInstalled
            && self
                .plugin_control_plane
                .validate_runtime_readiness(imported.plugin.id())
                .await
                .is_ok()
            && let Ok(enabled_item) = self
                .plugin_control_set_enabled(json!({
                    "pluginId": imported.plugin.id(),
                    "enabled": true,
                }))
                .await
        {
            return Ok(enabled_item);
        }
        Ok(plugin_control_item(&imported.plugin))
    }

    pub(super) async fn plugin_resolve_provider_bind(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct BindArgs {
            request_id: String,
            approved: bool,
        }
        let args: BindArgs = parse(args)?;
        Ok(json!(
            self.capability_broker
                .resolve_provider_bind(&args.request_id, args.approved)
        ))
    }

    pub(super) async fn plugin_control_import_cli(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportCliArgs {
            ecosystem: String,
            command: String,
        }
        let args: ImportCliArgs = parse(args)?;
        let (ecosystem, program_name) = match args.ecosystem.as_str() {
            "codex" => (plugins::NativeEcosystem::Codex, "codex"),
            "claude_code" => (plugins::NativeEcosystem::ClaudeCode, "claude"),
            other => {
                return Err(ApplicationError::bad_request(format!(
                    "unsupported native plugin ecosystem `{other}`"
                )));
            }
        };
        let commands = plugins::parse_official_plugin_import_commands(ecosystem, &args.command)
            .map_err(plugin_error)?;
        let program = utils::shell::resolve_executable_path(program_name)
            .await
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "official `{program_name}` executable was not found"
                ))
            })?;
        let adapter: Box<dyn plugins::NativePluginAdapter> = match ecosystem {
            plugins::NativeEcosystem::Codex => {
                Box::new(plugins::OfficialCliNativePluginAdapter::codex(&program))
            }
            plugins::NativeEcosystem::ClaudeCode => Box::new(
                plugins::OfficialCliNativePluginAdapter::claude_code(&program),
            ),
        };
        let before = adapter
            .discover()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|plugin| plugin.id)
            .collect::<std::collections::BTreeSet<_>>();
        for parsed in &commands {
            let status = utils::process::new_hidden_tokio_command(&program, &parsed.args)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .status()
                .await
                .map_err(|error| {
                    ApplicationError::internal(format!("start plugin import command: {error}"))
                })?;
            if !status.success() {
                return Err(ApplicationError::internal(format!(
                    "plugin import command failed: {}",
                    parsed.display
                )));
            }
        }
        let mut imported_plugin_ids = adapter
            .discover()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|plugin| plugin.id)
            .filter(|plugin_id| !before.contains(plugin_id))
            .collect::<Vec<_>>();
        imported_plugin_ids.sort();
        Ok(json!({
            "success": true,
            "commandsRun": commands.len() as u32,
            "importedPluginIds": imported_plugin_ids,
        }))
    }
}

fn normalize_product_detail_readme(
    mut detail: plugins::PluginProductDetail,
) -> plugins::PluginProductDetail {
    if let Some(rest) = detail.readme.strip_prefix("---\r\n")
        && let Some((_, body)) = rest.split_once("\r\n---\r\n")
    {
        detail.readme = body.to_owned();
    }
    detail
}
