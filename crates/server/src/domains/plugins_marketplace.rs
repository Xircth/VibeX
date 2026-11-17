use super::*;

impl ServerApplicationDomains {
    pub(crate) async fn plugin_marketplace_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CatalogArgs {
            query: Option<String>,
        }
        let args: CatalogArgs = parse(args).unwrap_or(CatalogArgs { query: None });
        let mut page = plugins::fetch_catalog(args.query.as_deref())
            .await
            .unwrap_or_default();
        plugins::merge_host_official_catalog(&mut page);
        plugins::filter_catalog_page(&mut page, args.query.as_deref());
        serde_json::to_value(page).map_err(|error| ApplicationError::internal(error.to_string()))
    }

    pub(super) async fn plugin_marketplace_listing(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ListingArgs {
            owner: String,
            plugin_name: String,
        }
        let args: ListingArgs = parse(args)?;
        if plugins::is_authoring_sample_plugin_id(&args.plugin_name)
            || plugins::is_authoring_sample_plugin_id(&format!(
                "{}.{}",
                args.owner, args.plugin_name
            ))
        {
            return Err(ApplicationError::not_found(format!(
                "{}/{}",
                args.owner, args.plugin_name
            )));
        }
        let listing = plugins::fetch_listing(&args.owner, &args.plugin_name)
            .await
            .ok()
            .or_else(|| {
                plugins::listings_from_host_official_catalog()
                    .into_iter()
                    .find(|item| {
                        plugins::package_matches_marketplace(
                            item.offline_plugin_id
                                .as_deref()
                                .unwrap_or(&item.plugin_name),
                            &args.owner,
                            &args.plugin_name,
                        )
                    })
            })
            .ok_or_else(|| {
                ApplicationError::not_found(format!("{}/{}", args.owner, args.plugin_name))
            })?;
        let detail = if listing.show_tree == Some(false) {
            plugins::CatalogPluginDetail {
                summary: listing.summary.clone(),
                readme: listing.readme.clone().unwrap_or_default(),
                contents: Vec::new(),
                listing,
            }
        } else {
            let package_id = listing
                .offline_plugin_id
                .as_deref()
                .unwrap_or(&listing.plugin_name);
            plugins::monorepo_official_plugin_root(package_id)
                .and_then(|local_root| {
                    plugins::PluginPackage::inspect(
                        &local_root,
                        plugins::PluginSourceKind::Marketplace,
                    )
                    .ok()
                })
                .map(|package| plugins::detail_from_package(&package, listing.clone()))
                .unwrap_or_else(|| plugins::CatalogPluginDetail {
                    summary: listing.summary.clone(),
                    readme: listing.readme.clone().unwrap_or_default(),
                    contents: Vec::new(),
                    listing,
                })
        };
        serde_json::to_value(detail).map_err(|error| ApplicationError::internal(error.to_string()))
    }

    pub(super) async fn plugin_marketplace_install(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct InstallArgs {
            owner: String,
            #[serde(alias = "plugin_name")]
            plugin_name: String,
            tag: Option<String>,
            conflict: Option<String>,
        }
        let args: InstallArgs = parse(args)?;
        if plugins::is_authoring_sample_plugin_id(&args.plugin_name)
            || plugins::is_authoring_sample_plugin_id(&format!(
                "{}.{}",
                args.owner, args.plugin_name
            ))
        {
            return Err(ApplicationError::not_found(format!(
                "{}/{}",
                args.owner, args.plugin_name
            )));
        }
        let mut last_error =
            ApplicationError::not_found(format!("{}/{}", args.owner, args.plugin_name));
        let mut import_error: Option<ApplicationError> = None;
        let conflict_decision = args.conflict.clone().unwrap_or_else(|| "reject".into());
        let origin_url = plugins::marketplace_listing_url(&args.owner, &args.plugin_name);
        let monorepo_root =
            plugins::monorepo_official_plugin_root(&args.plugin_name).or_else(|| {
                plugins::monorepo_official_plugin_root(&format!(
                    "{}.{}",
                    args.owner, args.plugin_name
                ))
            });
        let mut tried_monorepo = false;
        if let Some(monorepo_root) = monorepo_root.as_deref()
            && tag_matches_monorepo_official_plugin(args.tag.as_deref(), monorepo_root)
        {
            tried_monorepo = true;
            let git_ref =
                monorepo_plugin_version(monorepo_root).unwrap_or_else(|| "2.0.0".to_owned());
            match self
                .plugin_control_import(json!({
                    "path": monorepo_root.to_string_lossy(),
                    "developerLink": false,
                    "conflictDecision": conflict_decision,
                    "origin": origin_url,
                    "gitRef": git_ref,
                    "locked": true,
                }))
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) => import_error = Some(error),
            }
        }
        let github_urls = plugins::official_github_archive_urls(&args.owner, &args.plugin_name);
        for url in &github_urls {
            match download_marketplace_archive(url).await {
                Ok(archive) => {
                    match self
                        .plugin_control_import(json!({
                            "path": archive.to_string_lossy(),
                            "developerLink": false,
                            "conflictDecision": conflict_decision,
                            "origin": origin_url,
                            "gitRef": args.tag.clone().or_else(|| Some("main".to_owned())),
                            "locked": true,
                        }))
                        .await
                    {
                        Ok(result) => return Ok(result),
                        Err(error) => import_error = Some(error),
                    }
                }
                Err(error) => {
                    if import_error.is_none() {
                        last_error = error;
                    }
                }
            }
        }
        if let Ok(listing) =
            plugins::fetch_artifact(&args.owner, &args.plugin_name, args.tag.as_deref()).await
            && let Some(url) = listing.download_url.clone()
            && !url.starts_with("builtin://")
            && !url.starts_with("offline://")
        {
            match download_marketplace_archive(&url).await {
                Ok(archive) => {
                    match self
                        .plugin_control_import(json!({
                            "path": archive.to_string_lossy(),
                            "developerLink": false,
                            "conflictDecision": conflict_decision,
                            "origin": origin_url,
                            "gitRef": listing.tag,
                            "locked": true,
                            "showTree": listing.show_tree,
                        }))
                        .await
                    {
                        Ok(result) => return Ok(result),
                        Err(error) => import_error = Some(error),
                    }
                }
                Err(error) => {
                    if import_error.is_none() {
                        last_error = error;
                    }
                }
            }
        }
        if !tried_monorepo && let Some(monorepo_root) = monorepo_root.as_deref() {
            let git_ref =
                monorepo_plugin_version(monorepo_root).unwrap_or_else(|| "2.0.0".to_owned());
            match self
                .plugin_control_import(json!({
                    "path": monorepo_root.to_string_lossy(),
                    "developerLink": false,
                    "conflictDecision": conflict_decision,
                    "origin": origin_url,
                    "gitRef": git_ref,
                    "locked": true,
                }))
                .await
            {
                Ok(result) => return Ok(result),
                Err(error) => {
                    if import_error.is_none() {
                        import_error = Some(error);
                    }
                }
            }
        }
        Err(import_error.unwrap_or(last_error))
    }

    pub(super) async fn plugin_control_logs(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LogsArgs {
            plugin_id: String,
            #[serde(default)]
            after: u64,
        }
        let args: LogsArgs = parse(args)?;
        let lines = plugins::recent_plugin_logs(&args.plugin_id, args.after);
        serde_json::to_value(json!({ "lines": lines }))
            .map_err(|error| ApplicationError::internal(error.to_string()))
    }

    pub(super) async fn plugin_control_diagnostics(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginIdentityArgs = parse(args)?;
        let control_plane = self.plugin_control_plane().await?;
        let installed = control_plane
            .catalog()
            .await
            .map_err(internal_error)?
            .into_iter()
            .find(|item| item.id() == args.plugin_id);
        let enabled = installed
            .as_ref()
            .is_some_and(|item| item.activation == plugins::PluginActivation::Enabled);
        let declares_worker = installed
            .as_ref()
            .is_some_and(|item| item.entrypoints.worker.is_some());
        let missing_runtimes = match installed.as_ref() {
            Some(item) => control_plane
                .missing_runtimes(item)
                .await
                .map_err(internal_error)?,
            None => Vec::new(),
        };
        let quarantine_reason = control_plane
            .quarantine_reason(&args.plugin_id)
            .await
            .ok()
            .flatten();
        Ok(json!({
            "workerExpected": enabled && declares_worker,
            "workerRunning": control_plane.is_worker_running(&args.plugin_id).await,
            "generation": control_plane.active_generation(&args.plugin_id).await,
            "quarantined": quarantine_reason.is_some(),
            "quarantineReason": quarantine_reason,
            "missingRuntimes": missing_runtimes,
            "recentCrashes": plugins::recent_plugin_crashes(&args.plugin_id)
                .into_iter()
                .map(|crash| json!({
                    "message": crash.message,
                    "atUnixMs": crash.at_unix_ms as f64,
                }))
                .collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn plugin_control_uninstall(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PluginUninstallArgs {
            plugin_id: String,
            #[serde(default)]
            retain_data: Option<bool>,
        }
        let args: PluginUninstallArgs = parse(args)?;
        let retain_data = args.retain_data.unwrap_or(true);
        let plugin = self
            .plugin_control_plane
            .plugin(&args.plugin_id)
            .await
            .map_err(plugin_error)?;
        let Some(plugin) = plugin else {
            if self.native_plugin_uninstall(&args.plugin_id).await? {
                return Ok(json!({
                    "removed": true,
                    "pluginId": args.plugin_id,
                    "dataRetention": if retain_data { "retained" } else { "deleted" },
                    "reclaimedRuntimes": [],
                }));
            }
            return Err(ApplicationError::not_found(format!(
                "plugin {}",
                args.plugin_id
            )));
        };
        let snapshots = if !retain_data {
            let paths: Vec<String> = sqlx::query_scalar("SELECT DISTINCT source_path FROM plugin_packages_v4 WHERE plugin_id = ? AND source_kind IN ('snapshot', 'marketplace')")
                .bind(plugin.id()).fetch_all(&self.pool).await.map_err(internal_error)?;
            paths
                .into_iter()
                .map(std::path::PathBuf::from)
                .filter(|path| path.exists())
                .map(|path| managed_plugin_snapshot_path(&self.runtime_root, &path))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        Self::remove_plugin_projections(&plugin).await?;
        self.capability_broker
            .kill_plugin_processes(&args.plugin_id)
            .await;
        self.plugin_control_plane
            .uninstall(&args.plugin_id)
            .await
            .map_err(plugin_error)?;
        if !retain_data {
            let _ = self.plugin_control_plane.kv_clear(&args.plugin_id).await;
            for source in snapshots {
                remove_managed_plugin_snapshot(&self.runtime_root, &source)?;
            }
        }
        let reclaimed = self
            .plugin_control_plane
            .reclaim_unreferenced_runtimes(&self.runtime_root)
            .await
            .unwrap_or_default();
        Ok(json!({
            "removed": true,
            "pluginId": args.plugin_id,
            "dataRetention": if retain_data { "retained" } else { "deleted" },
            "reclaimedRuntimes": reclaimed,
        }))
    }

    pub(super) async fn plugin_control_gc_runtimes(
        &self,
        _args: Value,
    ) -> Result<Value, ApplicationError> {
        let reclaimed = self
            .plugin_control_plane
            .reclaim_unreferenced_runtimes(&self.runtime_root)
            .await
            .map_err(plugin_error)?;
        Ok(json!({ "reclaimed": reclaimed }))
    }

    pub(super) async fn plugin_surface_open(&self, args: Value) -> Result<Value, ApplicationError> {
        let request: plugins::AppSurfaceOpenRequest = parse(args)?;
        if let Some(path) = request.artifact_path.as_deref() {
            let path = path
                .to_str()
                .ok_or_else(|| ApplicationError::bad_request("artifact path is invalid"))?;
            self.ensure_registered_repo_file(path).await?;
        }
        serialize(
            self.app_surfaces
                .open(request)
                .await
                .map_err(app_surface_error)?,
        )
    }

    pub(crate) async fn plugin_surface_invoke(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let request: plugins::AppSurfaceInvocation = parse(args)?;
        let plugin_id = request.identity.plugin_id.clone();
        let method = request.method.clone();
        let value = self
            .app_surfaces
            .invoke(request)
            .await
            .map_err(app_surface_error)?;
        if method == "runtime.restart"
            && let Ok(Some(plugin)) = self.plugin_control_plane().await?.plugin(&plugin_id).await
        {
            let _ = self.apply_default_plugin_mcp_projections(&plugin).await;
        }
        Ok(value)
    }

    pub(super) async fn plugin_invoke_contribution(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginInvokeContributionArgs = parse(args)?;
        let plugin_id = args.plugin_id.trim();
        let handler = args.handler.trim();
        if plugin_id.is_empty() || handler.is_empty() {
            return Err(ApplicationError::bad_request(
                "pluginId and handler are required",
            ));
        }
        let plane = self.plugin_control_plane().await?;
        let lease = plane.activation_lease(plugin_id).await.ok_or_else(|| {
            ApplicationError::not_found(format!("plugin `{plugin_id}` is not active"))
        })?;
        let timeout = args
            .timeout_seconds
            .filter(|value| (5..=600).contains(value))
            .map(Duration::from_secs);
        let mut result = match timeout {
            Some(duration) => {
                lease
                    .invoke_with_timeout(handler, args.input.clone(), duration)
                    .await
            }
            None => lease.invoke(handler, args.input.clone()).await,
        };
        if let Err(ref error) = result
            && error.code() == "worker_terminal"
            && let Some(fresh_lease) = plane.activation_lease(plugin_id).await
        {
            result = match timeout {
                Some(duration) => {
                    fresh_lease
                        .invoke_with_timeout(handler, args.input, duration)
                        .await
                }
                None => fresh_lease.invoke(handler, args.input).await,
            };
        }
        let value = result.map_err(|error| ApplicationError::internal(error.to_string()))?;
        if handler == "runtime.restart"
            && let Ok(Some(plugin)) = plane.plugin(plugin_id).await
        {
            let _ = self.apply_default_plugin_mcp_projections(&plugin).await;
        }
        Ok(value)
    }

    pub(super) async fn plugin_command_invoke(
        &self,
        principal: &Principal,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let plugin_id = args
            .get("pluginId")
            .or_else(|| args.get("plugin_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let command_name = args
            .get("command")
            .or_else(|| args.get("commandName"))
            .or_else(|| args.get("command_name"))
            .or_else(|| args.get("handler"))
            .or_else(|| args.get("method"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let input = args
            .get("input")
            .or_else(|| args.get("params"))
            .or_else(|| args.get("args"))
            .or_else(|| args.get("payload"))
            .cloned()
            .unwrap_or(Value::Null);

        let (resolved_plugin_id, resolved_command) =
            if !plugin_id.is_empty() && !command_name.is_empty() {
                (plugin_id, command_name)
            } else if plugin_id.is_empty() && !command_name.is_empty() {
                self.plugin_control_plane()
                    .await?
                    .resolve_dynamic_command_target(&command_name)
                    .await
                    .map_err(plugin_error)?
                    .ok_or_else(|| {
                        ApplicationError::bad_request(
                            "pluginId and command are required for plugin.command.invoke",
                        )
                    })?
            } else {
                return Err(ApplicationError::bad_request(
                    "pluginId and command are required",
                ));
            };

        let control_plane = self.plugin_control_plane().await?;
        if !control_plane.has_command_handler(&resolved_plugin_id, &resolved_command)
            && let Some(domain_command) =
                resolve_bridged_domain_command(&resolved_plugin_id, &resolved_command)
        {
            return self
                .execute_bridged_domain_command(principal, domain_command, input)
                .await;
        }

        control_plane
            .invoke_plugin_command(&resolved_plugin_id, &resolved_command, input)
            .await
            .map_err(plugin_worker_command_error)
    }

    pub(super) async fn invoke_dynamic_plugin_command(
        &self,
        principal: &Principal,
        qualified_command: &str,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        if matches!(
            qualified_command,
            "plugin.command.invoke" | "plugin_command_invoke"
        ) {
            return self.plugin_command_invoke(principal, args).await;
        }
        let control_plane = self.plugin_control_plane().await?;
        let Some((plugin_id, command_name)) = control_plane
            .resolve_dynamic_command_target(qualified_command)
            .await
            .map_err(plugin_error)?
        else {
            return Err(ApplicationError::not_found(qualified_command));
        };
        if !control_plane.has_command_handler(&plugin_id, &command_name)
            && let Some(domain_command) = resolve_bridged_domain_command(&plugin_id, &command_name)
        {
            return self
                .execute_bridged_domain_command(principal, domain_command, args)
                .await;
        }
        let input = args
            .get("input")
            .or_else(|| args.get("params"))
            .cloned()
            .unwrap_or(args);
        control_plane
            .invoke_plugin_command(&plugin_id, &command_name, input)
            .await
            .map_err(plugin_worker_command_error)
    }

    pub(super) async fn execute_bridged_domain_command(
        &self,
        principal: &Principal,
        domain_command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let primary = Box::pin(self.execute_command(principal, domain_command, args.clone())).await;
        if primary.is_ok() {
            return primary;
        }
        if let Some(inner) = args.get("input").or_else(|| args.get("params")).cloned() {
            let fallback = Box::pin(self.execute_command(principal, domain_command, inner)).await;
            if fallback.is_ok() {
                return fallback;
            }
        }
        primary
    }

    pub(super) async fn plugin_surface_revoke(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let identity: plugins::AppSurfaceIdentity = parse(args)?;
        self.app_surfaces
            .revoke(&identity)
            .await
            .map_err(app_surface_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn plugin_host_call(&self, args: Value) -> Result<Value, ApplicationError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PluginHostCallArgs {
            plugin_id: String,
            capability: String,
            operation: String,
            #[serde(default)]
            input: Value,
        }
        let args: PluginHostCallArgs = parse(args)?;
        let plugin_id = args.plugin_id.trim();
        let capability = args.capability.trim();
        let operation = args.operation.trim();
        if plugin_id.is_empty() || capability.is_empty() || operation.is_empty() {
            return Err(ApplicationError::bad_request(
                "pluginId, capability, and operation are required",
            ));
        }
        let is_self_diagnostic =
            capability == "plugin.self" && matches!(operation, "quarantine" | "status" | "doctor");
        if !is_self_diagnostic {
            if let Ok(Some(reason)) = self.plugin_control_plane.quarantine_reason(plugin_id).await {
                return Err(ApplicationError::forbidden(format!(
                    "plugin_quarantined: {reason}"
                )));
            }
            if let Ok(Some(installed)) = self.plugin_control_plane.plugin(plugin_id).await
                && installed.activation != plugins::PluginActivation::Enabled
            {
                return Err(ApplicationError::forbidden(format!(
                    "plugin_disabled: plugin `{plugin_id}` is not enabled"
                )));
            }
        }
        let generation = self
            .plugin_control_plane
            .active_generation(plugin_id)
            .await
            .unwrap_or(0);
        plugins::CapabilityBroker::call(
            &*self.capability_broker,
            plugin_id,
            generation,
            capability,
            operation,
            args.input,
        )
        .await
        .map_err(|error| {
            ApplicationError::bad_request(format!("{}: {}", error.code(), error.message()))
        })
    }

    pub(super) async fn plugin_open_file_preview(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewArgs = parse(args)?;
        self.ensure_registered_repo_file(&args.file_path).await?;
        let extension = std::path::Path::new(&args.file_path)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let control_plane = self.plugin_control_plane().await?;
        let Some(resolved) = control_plane
            .resolve_file_opener(extension.as_deref(), None)
            .await
            .map_err(internal_error)?
        else {
            return Ok(Value::Null);
        };
        let catalog = control_plane
            .contributions()
            .await
            .map_err(internal_error)?;
        let opener = catalog.items.iter().find(|item| {
            item.plugin_id == resolved.plugin_id
                && item.id == resolved.contribution_id
                && item.kind == plugins::ContributionKind::FileOpener
        });
        let preview = catalog
            .items
            .iter()
            .find(|item| {
                item.plugin_id == resolved.plugin_id
                    && item.id == resolved.handler
                    && item.kind == plugins::ContributionKind::PreviewProvider
            })
            .ok_or_else(|| ApplicationError::internal("resolved preview provider disappeared"))?;
        let media_type = opener
            .and_then(|item| item.metadata.get("mediaTypes"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_owned();
        let provider_id = preview.id.clone();
        let plugin = control_plane
            .plugin(&resolved.plugin_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::internal("resolved preview plugin disappeared"))?;
        let result = plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .open(plugins::PluginPreviewRequest {
            file_path: args.file_path,
            media_type,
            plugin_id: resolved.plugin_id.clone(),
            plugin_version: plugin.version.clone(),
            provider_id: provider_id.clone(),
            generation: 0,
            package_digest: String::new(),
        })
        .await
        .map_err(|error| error.to_string());
        match result {
            Ok(lease) => {
                let lease_id = Uuid::parse_str(&lease.lease_id).map_err(internal_error)?;
                self.preview_proxy
                    .register(
                        lease_id,
                        lease.loopback_port,
                        &lease.capability_token,
                        lease.expires_at_unix_ms,
                    )
                    .await
                    .map_err(internal_error)?;
                let preview_url = self
                    .preview_proxy
                    .preview_url(lease_id, &lease.capability_token)
                    .await;
                Ok(json!({
                    "pluginId": resolved.plugin_id,
                    "providerId": provider_id,
                    "generation": resolved.generation,
                    "leaseId": lease_id,
                    "capabilityToken": lease.capability_token,
                    "expiresAtUnixMs": lease.expires_at_unix_ms,
                    "port": lease.loopback_port,
                    "previewUrl": preview_url,
                    "errorCode": Value::Null,
                    "errorMessage": Value::Null,
                }))
            }
            Err(error) => Ok(json!({
                "pluginId": resolved.plugin_id,
                "providerId": provider_id,
                "generation": resolved.generation,
                "leaseId": Value::Null,
                "capabilityToken": Value::Null,
                "expiresAtUnixMs": Value::Null,
                "port": Value::Null,
                "previewUrl": Value::Null,
                "errorCode": "PREVIEW_WORKER_FAILED",
                "errorMessage": error,
            })),
        }
    }

    pub(super) async fn ensure_registered_repo_file(
        &self,
        file_path: &str,
    ) -> Result<(), ApplicationError> {
        let requested = tokio::fs::canonicalize(file_path)
            .await
            .map_err(|_| ApplicationError::not_found("preview file was not found"))?;
        if !requested.is_file() {
            return Err(ApplicationError::bad_request(
                "preview target must be a regular file",
            ));
        }
        let roots = sqlx::query_scalar::<_, String>("SELECT path FROM repos")
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?;
        for root in roots {
            let Ok(root) = tokio::fs::canonicalize(root).await else {
                continue;
            };
            if requested != root && requested.starts_with(root) {
                return Ok(());
            }
        }
        Err(ApplicationError::forbidden(
            "preview file is outside every registered repository",
        ))
    }

    pub(super) async fn plugin_close_file_preview(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewArgs = parse(args)?;
        if let Some(lease_id) = args.lease_id {
            self.preview_proxy.revoke(lease_id).await;
        }
        let lease_id = args.lease_id.map(|value| value.to_string());
        self.preview_host
            .close_preview(&args.file_path, lease_id.as_deref())
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn plugin_renew_file_preview(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginFilePreviewRenewArgs = parse(args)?;
        let lease = self
            .preview_host
            .renew_preview(&args.lease_id.to_string())
            .await
            .map_err(internal_error)?;
        self.preview_proxy
            .renew(args.lease_id, lease.expires_at_unix_ms)
            .await
            .map_err(internal_error)?;
        Ok(json!({
            "leaseId": lease.lease_id,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
        }))
    }
}

pub(crate) fn plugin_control_item(plugin: &plugins::InstalledPlugin) -> Value {
    plugin_control_item_with_quarantine(plugin, None)
}

pub(super) fn plugin_control_item_with_quarantine(
    plugin: &plugins::InstalledPlugin,
    quarantine_reason: Option<String>,
) -> Value {
    let formats = plugin
        .formats
        .iter()
        .map(|format| match format {
            plugins::PackageFormat::Dimo => "dimo",
            plugins::PackageFormat::Codex => "codex",
            plugins::PackageFormat::ClaudeCode => "claude_code",
        })
        .collect::<Vec<_>>();
    let source_kind = match plugin.source.kind {
        plugins::PluginSourceKind::Builtin => "builtin",
        plugins::PluginSourceKind::Snapshot => "snapshot",
        plugins::PluginSourceKind::Marketplace => "marketplace",
        plugins::PluginSourceKind::DeveloperLink => "developer_link",
        plugins::PluginSourceKind::CodexNative => "codex_native",
        plugins::PluginSourceKind::ClaudeCodeNative => "claude_code_native",
    };
    let invocations = plugin
        .invocations
        .iter()
        .map(|invocation| {
            json!({
                "id": invocation.id,
                "label": invocation.label,
                "prompt": invocation.prompt,
                "kind": match invocation.kind {
                    plugins::InvocationKind::Action => "action",
                    plugins::InvocationKind::Command => "command",
                }
            })
        })
        .collect::<Vec<_>>();
    let runtimes = plugin
        .runtimes
        .iter()
        .map(|runtime| {
            json!({
                "id": runtime.id,
                "command": runtime.command,
                "version": runtime.version,
                "target": runtime.target,
                "contentDigest": runtime.content_digest,
                "installer": match runtime.install {
                    plugins::RuntimeInstall::Existing => "existing",
                    plugins::RuntimeInstall::Binary { .. } => "binary",
                    plugins::RuntimeInstall::Archive { .. } => "archive",
                    plugins::RuntimeInstall::Npm { .. } => "npm",
                    plugins::RuntimeInstall::Pipx { .. } => "pipx",
                    plugins::RuntimeInstall::Cargo { .. } => "cargo",
                },
                "installCommand": Value::Null,
            })
        })
        .collect::<Vec<_>>();
    let mcp_servers = plugin
        .mcp
        .as_object()
        .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let app_contributions = plugin
        .app
        .file_openers
        .iter()
        .map(|opener| {
            json!({
                "id": opener.id,
                "kind": "file_opener",
                "label": opener.label,
                "metadata": {
                    "extensions": opener.extensions,
                    "mediaTypes": opener.media_types,
                    "priority": opener.priority,
                    "handler": opener.handler,
                },
            })
        })
        .chain(plugin.app.preview_providers.iter().map(|provider| {
            json!({
                "id": provider.id,
                "kind": "preview_provider",
                "label": provider.id,
                "metadata": {
                    "mediaTypes": provider.media_types,
                    "runtime": provider.runtime,
                    "maxConcurrentPreviews": provider.max_concurrent_previews,
                    "handler": provider.handler,
                },
            })
        }))
        .chain(plugin.app.surfaces.iter().map(|surface| {
            json!({
                "id": surface.id,
                "kind": "app_surface",
                "label": surface.label,
                "metadata": {
                    "slot": surface.slot,
                    "appEntrypoint": surface.app_entrypoint,
                    "route": surface.route,
                    "handler": surface.handler,
                    "allowedMethods": surface.allowed_methods,
                    "minHeight": surface.min_height,
                },
            })
        }))
        .collect::<Vec<_>>();
    json!({
        "id": plugin.id(),
        "publisher": plugin.publisher,
        "packageDigest": plugin.package_digest,
        "updatePackageDigest": Value::Null,
        "name": plugin.name,
        "version": plugin.version,
        "description": plugin.description,
        "enabled": plugin.activation == plugins::PluginActivation::Enabled,
        "quarantined": quarantine_reason.is_some(),
        "quarantineReason": quarantine_reason,
        "builtin": plugin.source.kind == plugins::PluginSourceKind::Builtin,
        "sourceKind": source_kind,
        // Package contents are exposed through the contribution API; the
        // server filesystem layout is not part of the Remote contract.
        "sourcePath": "",
        "formats": formats,
        "skills": plugin.skills,
        "runtimes": runtimes,
        "warnings": plugin.warnings,
        "permissions": plugin.permissions,
        "permissionDelta": [],
        "mcpCount": mcp_servers.len(),
        "mcpServers": mcp_servers,
        "invocationCount": invocations.len(),
        "invocations": invocations,
        "appContributions": app_contributions,
        "nativeManaged": false,
        "enableSupported": true,
        "updateSupported": plugins::source_allows_remote_update(
            plugin.source.kind,
            plugin.source.origin.as_deref(),
        ),
        "rollbackSupported": false,
        "uninstallSupported": plugin.source.kind != plugins::PluginSourceKind::Builtin,
        "sourceOrigin": plugin.source.origin,
        "sourceRef": plugin.source.git_ref,
        "sourceSha": plugin.source.git_sha,
        "hasWorker": plugin.entrypoints.worker.is_some(),
        "sourceLocked": plugin.source.locked,
        "sourceLock": plugin.source.update_lock.clone().or_else(|| plugins::PluginSourceLock::from_source(&plugin.source, &plugin.version, &plugin.package_digest)),
        "sourceShowTree": plugin.source.show_tree,
    })
}

pub(super) async fn download_marketplace_archive(
    url: &str,
) -> Result<std::path::PathBuf, ApplicationError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let response = client
        .get(url)
        .header("user-agent", "Dimo")
        .send()
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ApplicationError::not_found(url.to_owned()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let suffix = plugins::marketplace_archive_suffix(url);
    let path = utils::path::get_dimo_temp_dir().join(format!(
        "market-{}.{}",
        uuid::Uuid::new_v4(),
        suffix
    ));
    std::fs::write(&path, bytes).map_err(|error| ApplicationError::internal(error.to_string()))?;
    Ok(path)
}

pub(super) fn monorepo_plugin_version(monorepo_root: &std::path::Path) -> Option<String> {
    for rel in [".dimo-plugin/plugin.json", "plugin.json"] {
        let manifest_path = monorepo_root.join(rel);
        let Ok(content) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        if let Some(version) = manifest
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(version.to_owned());
        }
    }
    None
}

pub(super) fn tag_matches_monorepo_official_plugin(
    tag: Option<&str>,
    monorepo_root: &std::path::Path,
) -> bool {
    let Some(raw) = tag.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    if matches!(raw, "main" | "master" | "latest" | "HEAD") {
        return true;
    }
    let normalized = raw.strip_prefix('v').unwrap_or(raw);
    monorepo_plugin_version(monorepo_root).is_some_and(|version| {
        let monorepo_ver = version.strip_prefix('v').unwrap_or(&version);
        monorepo_ver == normalized || plugins::is_newer_version(normalized, monorepo_ver)
    })
}

pub(super) fn managed_plugin_snapshot_path(
    runtime_root: &std::path::Path,
    source: &std::path::Path,
) -> Result<std::path::PathBuf, ApplicationError> {
    let source = source.canonicalize().map_err(internal_error)?;
    let allowed = ["plugins/snapshots", "plugins/candidates"]
        .iter()
        .any(|relative| {
            runtime_root
                .join(relative)
                .canonicalize()
                .is_ok_and(|root| source != root && source.starts_with(root))
        });
    if !allowed {
        return Err(ApplicationError::bad_request(
            "plugin package is outside managed storage",
        ));
    }
    Ok(source)
}

pub(super) fn remove_managed_plugin_snapshot(
    runtime_root: &std::path::Path,
    source: &std::path::Path,
) -> Result<(), ApplicationError> {
    let source = managed_plugin_snapshot_path(runtime_root, source)?;
    std::fs::remove_dir_all(source).map_err(internal_error)
}
