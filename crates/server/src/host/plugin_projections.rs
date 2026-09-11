use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use agents::skills::{self, PluginSkillProjectionStatus};
use application::ApplicationError;
use delegation::{AgentDelegationDefaults, DelegationConfig};
use plugins::{InstalledPlugin, PluginPackage};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginConfigureAgentsArgs {
    plugin_id: String,
    #[serde(default)]
    all_agents: bool,
    #[serde(default)]
    agents: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginConfigureMcpArgs {
    plugin_id: String,
    #[serde(default)]
    all_agents: bool,
    #[serde(default)]
    agents: Vec<String>,
}

pub(crate) fn plugin_skill_projection_targets(
    desired: &BTreeSet<String>,
    installed: &BTreeSet<String>,
) -> Vec<String> {
    let targets = desired.intersection(installed).cloned().collect::<Vec<_>>();
    if targets.is_empty() {
        desired.iter().cloned().collect()
    } else {
        targets
    }
}

fn skill_projection_json(
    skill_id: String,
    agent_id: String,
    status: PluginSkillProjectionStatus,
    message: Option<String>,
) -> Value {
    json!({
        "skillId": skill_id,
        "agentId": agent_id,
        "status": match status {
            PluginSkillProjectionStatus::Projected => "projected",
            PluginSkillProjectionStatus::Removed => "removed",
            PluginSkillProjectionStatus::Collision => "collision",
        },
        "message": message,
    })
}

impl ServerApplicationDomains {
    pub(crate) async fn plugin_configure_agents(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginConfigureAgentsArgs = parse(args)?;
        let plugin = self.enabled_plugin(&args.plugin_id).await?;
        let projections = self
            .project_plugin_skills(&plugin, args.all_agents, args.agents)
            .await?;
        serialize(json!({
            "skillProjections": projections,
            "mcpErrors": [],
        }))
    }

    pub(crate) async fn plugin_configure_mcp(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: PluginConfigureMcpArgs = parse(args)?;
        let plugin = self.enabled_plugin(&args.plugin_id).await?;
        let known = skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let desired = if args.all_agents {
            known
        } else {
            let requested = args.agents.into_iter().collect::<BTreeSet<_>>();
            if let Some(unknown) = requested.iter().find(|agent| !known.contains(*agent)) {
                return Err(ApplicationError::bad_request(format!(
                    "Agent `{unknown}` does not support managed MCP projection"
                )));
            }
            requested
        };
        let mcp_errors = self
            .project_plugin_mcp(&plugin, args.all_agents, &desired)
            .await;
        serialize(json!({ "mcpErrors": mcp_errors }))
    }

    /// Project a Plugin's currently-enabled Skills onto the Agents it is bound
    /// to and persist the resulting bindings.
    ///
    /// Takes the package rather than an installed Plugin so a caller that has
    /// just written `config.json` projects from the config it persisted rather
    /// than the one loaded before the write — that config is what switches
    /// Skill domains on and off.
    pub(crate) async fn apply_default_plugin_skill_projections(
        &self,
        plugin: &PluginPackage,
    ) -> Result<(), ApplicationError> {
        if !plugin.skills.is_empty() {
            let (desired, all_agents) = self.desired_bound_agents(plugin.id.as_str()).await?;
            let agents = if all_agents {
                Vec::new()
            } else {
                desired.into_iter().collect()
            };
            let _ = self
                .project_plugin_skills(plugin, all_agents, agents)
                .await?;
        }
        Ok(())
    }

    /// Project a Plugin's managed MCP servers onto the Agents it is bound to.
    pub(crate) async fn apply_default_plugin_mcp_projections(
        &self,
        plugin: &InstalledPlugin,
    ) -> Result<(), ApplicationError> {
        let (known, desired) = self.desired_mcp_agents(plugin.id()).await?;
        let all_agents = desired == known;
        for error in self.project_plugin_mcp(plugin, all_agents, &desired).await {
            tracing::warn!(
                plugin_id = plugin.id(),
                %error,
                "default MCP projection failed"
            );
        }
        Ok(())
    }

    pub(crate) async fn apply_default_plugin_projections(
        &self,
        plugin: &InstalledPlugin,
    ) -> Result<(), ApplicationError> {
        self.apply_default_plugin_skill_projections(plugin).await?;
        self.apply_default_plugin_mcp_projections(plugin).await
    }

    pub(crate) async fn remove_plugin_projections(
        plugin: &InstalledPlugin,
    ) -> Result<(), ApplicationError> {
        if !plugin.skills.is_empty() {
            let skill_ids = plugin
                .skills
                .iter()
                .map(|skill| skill.id.clone())
                .collect::<Vec<_>>();
            skills::remove_plugin_skill_projections(plugin.id(), &skill_ids)
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        }
        for server_id in plugin_mcp_server_ids(plugin) {
            if let Err(error) = services::services::mcp::uninstall_server(server_id).await {
                tracing::warn!(
                    plugin_id = plugin.id(),
                    %error,
                    "plugin MCP projection removal failed"
                );
            }
        }
        Ok(())
    }

    pub(crate) async fn mark_plugin_bindings_disabled(
        &self,
        plugin_id: &str,
    ) -> Result<(), ApplicationError> {
        sqlx::query(
            "UPDATE plugin_agent_bindings_v4
             SET applied = 0, pending_reason = 'plugin_disabled', updated_at = CURRENT_TIMESTAMP
             WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(internal_error)?;
        sqlx::query(
            "UPDATE plugin_mcp_bindings_v4
             SET applied = 0, updated_at = CURRENT_TIMESTAMP WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .execute(&self.pool)
        .await
        .map_err(internal_error)?;
        Ok(())
    }

    pub(crate) async fn refresh_official_product_runtime(&self) -> Result<(), ApplicationError> {
        let Some(broker) = self.delegation_broker.as_ref() else {
            self.plugin_control_plane
                .sync_official_product_mcp_gate()
                .await
                .map_err(internal_error)?;
            return Ok(());
        };
        refresh_official_product_runtime_with(&self.plugin_control_plane, broker).await
    }

    async fn enabled_plugin(&self, plugin_id: &str) -> Result<InstalledPlugin, ApplicationError> {
        let plugin = self
            .plugin_control_plane
            .plugin(plugin_id)
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .ok_or_else(|| ApplicationError::not_found(plugin_id.to_owned()))?;
        if plugin.activation != plugins::PluginActivation::Enabled {
            return Err(ApplicationError::bad_request(
                "plugin must be enabled before configuring Agent projections",
            ));
        }
        Ok(plugin)
    }

    async fn project_plugin_skills(
        &self,
        plugin: &PluginPackage,
        all_agents: bool,
        agents: Vec<String>,
    ) -> Result<Vec<Value>, ApplicationError> {
        let known = skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let desired = if all_agents {
            known.clone()
        } else {
            let requested = agents.into_iter().collect::<BTreeSet<_>>();
            if let Some(unknown) = requested.iter().find(|agent| !known.contains(*agent)) {
                return Err(ApplicationError::bad_request(format!(
                    "Agent `{unknown}` does not support Skill projection"
                )));
            }
            requested
        };
        let installed = self
            .agent_management_runtime
            .local_runtimes()
            .await
            .keys()
            .map(|agent| agent.as_str().to_owned())
            .collect::<BTreeSet<_>>();
        let targets = plugin_skill_projection_targets(&desired, &installed);
        let skill_sources = plugin
            .enabled_skills()
            .map(|skill| (skill.id.clone(), plugin.source.path.join(&skill.path)))
            .collect::<Vec<_>>();
        let projected =
            skills::project_plugin_skills(plugin.id.as_str(), &skill_sources, targets, true)
                .map_err(|error| ApplicationError::internal(error.to_string()))?;
        let projections = projected
            .into_iter()
            .map(|result| {
                skill_projection_json(
                    result.skill_id,
                    result.agent_id,
                    result.status,
                    result.message,
                )
            })
            .collect::<Vec<_>>();
        self.persist_plugin_agent_bindings(
            plugin.id.as_str(),
            &known,
            &desired,
            &installed,
            &projections,
        )
        .await?;
        Ok(projections)
    }

    async fn persist_plugin_agent_bindings(
        &self,
        plugin_id: &str,
        known: &BTreeSet<String>,
        desired: &BTreeSet<String>,
        installed: &BTreeSet<String>,
        projections: &[Value],
    ) -> Result<(), ApplicationError> {
        let outcomes =
            projections
                .iter()
                .fold(BTreeMap::<&str, bool>::new(), |mut outcomes, projection| {
                    let Some(agent_id) = projection.get("agentId").and_then(Value::as_str) else {
                        return outcomes;
                    };
                    let ready =
                        projection.get("status").and_then(Value::as_str) == Some("projected");
                    outcomes
                        .entry(agent_id)
                        .and_modify(|current| *current &= ready)
                        .or_insert(ready);
                    outcomes
                });
        let mut transaction = self.pool.begin().await.map_err(internal_error)?;
        for agent_id in known {
            let wanted = desired.contains(agent_id);
            let applied = wanted
                && (installed.is_empty() || installed.contains(agent_id))
                && outcomes.get(agent_id.as_str()) == Some(&true);
            let pending_reason = if wanted && !installed.is_empty() && !installed.contains(agent_id)
            {
                Some("agent_not_installed")
            } else if wanted && !applied {
                Some("projection_incomplete")
            } else {
                None
            };
            sqlx::query(
                "INSERT INTO plugin_agent_bindings_v4
                     (plugin_id, agent_id, desired, applied, pending_reason, error_code, error_message, updated_at)
                 VALUES (?, ?, ?, ?, ?, NULL, NULL, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id, agent_id) DO UPDATE SET
                     desired = excluded.desired,
                     applied = excluded.applied,
                     pending_reason = excluded.pending_reason,
                     error_code = NULL,
                     error_message = NULL,
                     updated_at = CURRENT_TIMESTAMP",
            )
            .bind(plugin_id)
            .bind(agent_id)
            .bind(i64::from(wanted))
            .bind(i64::from(applied))
            .bind(pending_reason)
            .execute(&mut *transaction)
            .await
            .map_err(internal_error)?;
        }
        transaction.commit().await.map_err(internal_error)?;
        Ok(())
    }

    async fn desired_bound_agents(
        &self,
        plugin_id: &str,
    ) -> Result<(BTreeSet<String>, bool), ApplicationError> {
        let known = skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let saved = sqlx::query_scalar::<_, String>(
            "SELECT agent_id FROM plugin_agent_bindings_v4
             WHERE plugin_id = ? AND desired = 1",
        )
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?;
        let has_saved = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM plugin_agent_bindings_v4 WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_error)?
            > 0;
        if has_saved {
            Ok((saved.into_iter().collect(), false))
        } else {
            Ok((known, true))
        }
    }

    pub(crate) async fn desired_mcp_agents(
        &self,
        plugin_id: &str,
    ) -> Result<(BTreeSet<String>, BTreeSet<String>), ApplicationError> {
        let known = skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        let saved = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT agent_id FROM plugin_mcp_bindings_v4
             WHERE plugin_id = ? AND desired = 1",
        )
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?;
        let has_saved = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_one(&self.pool)
        .await
        .map_err(internal_error)?
            > 0;
        let desired = if has_saved {
            saved.into_iter().collect()
        } else {
            known.clone()
        };
        Ok((known, desired))
    }

    pub(crate) async fn project_plugin_mcp(
        &self,
        plugin: &InstalledPlugin,
        all_agents: bool,
        desired: &BTreeSet<String>,
    ) -> Vec<String> {
        configure_plugin_mcp(
            &self.pool,
            &self.plugin_control_plane,
            &self.worker_runtime,
            plugin,
            all_agents,
            desired,
        )
        .await
    }
}

pub(crate) async fn refresh_official_product_runtime_with(
    plane: &plugins::PluginControlPlane,
    broker: &delegation::DelegationBroker,
) -> Result<(), ApplicationError> {
    plane
        .sync_official_product_mcp_gate()
        .await
        .map_err(internal_error)?;
    let gate = plane.official_product_mcp_gate();
    let plugin_config = if let Some(plugin_id) = gate
        .bindings()
        .into_iter()
        .find(|binding| binding.product == "delegation")
        .map(|binding| binding.plugin_id)
    {
        match plane.plugin(&plugin_id).await {
            Ok(Some(plugin)) => plugin.product_detail().ok().map(|detail| detail.config),
            _ => None,
        }
    } else {
        None
    };
    broker.set_config(official_delegation_config(
        broker.config_snapshot(),
        gate.as_ref(),
        plugin_config.as_ref(),
    ));
    Ok(())
}

pub(crate) fn official_delegation_config(
    mut config: DelegationConfig,
    gate: &plugins::OfficialMcpRuntime,
    plugin_config: Option<&Value>,
) -> DelegationConfig {
    config.enabled = gate.allow_delegation_mcp();
    if let Some(config_value) = plugin_config {
        if let Some(depth) = config_value.get("depthLimit").and_then(Value::as_u64) {
            config.depth_limit = depth as u32;
        }
        if let Some(mb) = config_value
            .get("completedCacheMaxMb")
            .and_then(Value::as_u64)
        {
            config.completed_cache_cap_bytes = mb.saturating_mul(1024 * 1024);
        }
        config.agent_defaults = parse_agent_defaults(config_value.get("agentDefaults"));
    }
    config
}

fn parse_agent_defaults(value: Option<&Value>) -> BTreeMap<String, AgentDelegationDefaults> {
    let Some(object) = value.and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    object
        .iter()
        .filter_map(|(agent_id, defaults)| {
            let record = defaults.as_object()?;
            let mode_id = record
                .get("modeId")
                .or_else(|| record.get("mode_id"))
                .and_then(Value::as_str)
                .filter(|mode| !mode.is_empty())
                .map(str::to_string);
            let config_values = record
                .get("configValues")
                .or_else(|| record.get("config_values"))
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect();
            Some((
                agent_id.clone(),
                AgentDelegationDefaults {
                    mode_id,
                    config_values,
                },
            ))
        })
        .collect()
}

fn plugin_mcp_server_ids(plugin: &InstalledPlugin) -> Vec<String> {
    let mut ids = plugin
        .mcp
        .get("mcpServers")
        .unwrap_or(&plugin.mcp)
        .as_object()
        .map(|servers| {
            servers
                .iter()
                .map(|(server_id, spec)| {
                    plugins::projected_mcp_server_id(plugin.id(), server_id, spec)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

async fn configure_plugin_mcp(
    pool: &SqlitePool,
    control_plane: &plugins::PluginControlPlane,
    worker_runtime: &plugins::PluginWorkerRuntimeProvider,
    plugin: &InstalledPlugin,
    all_agents: bool,
    desired: &BTreeSet<String>,
) -> Vec<String> {
    if let Err(error) = sqlx::query("DELETE FROM plugin_mcp_bindings_v4 WHERE plugin_id = ?")
        .bind(plugin.id())
        .execute(pool)
        .await
    {
        return vec![format!("control-plane binding reset: {error}")];
    }
    let raw_mcp = &plugin.mcp;
    if raw_mcp.is_null() {
        return Vec::new();
    }
    let servers = raw_mcp
        .get("mcpServers")
        .unwrap_or(raw_mcp)
        .as_object()
        .cloned()
        .unwrap_or_default();
    let apps = if all_agents {
        Vec::new()
    } else {
        desired
            .iter()
            .filter_map(|agent| {
                serde_json::from_value::<services::services::mcp::McpAppType>(Value::String(
                    agent.clone(),
                ))
                .ok()
            })
            .collect()
    };
    let mut errors = Vec::new();
    for (server_id, spec) in servers {
        let projected_id = plugins::projected_mcp_server_id(plugin.id(), &server_id, &spec);
        let materialized = match materialize_plugin_mcp_spec(
            control_plane,
            worker_runtime,
            plugin,
            &server_id,
            spec,
        )
        .await
        {
            Ok(spec) => spec,
            Err(error) => {
                errors.push(format!("{server_id}: {error}"));
                continue;
            }
        };
        let error_message = match materialized {
            None => {
                if let Err(error) =
                    services::services::mcp::uninstall_server(projected_id.clone()).await
                {
                    errors.push(format!("{server_id}: {error}"));
                    Some(error.to_string())
                } else {
                    None
                }
            }
            Some(spec) => services::services::mcp::upsert_local_server(
                projected_id,
                spec,
                all_agents,
                apps.clone(),
            )
            .await
            .err()
            .map(|error| error.to_string()),
        };
        if let Some(error) = &error_message {
            errors.push(format!("{server_id}: {error}"));
        }
        let known_agents = skills::skill_capable_agent_ids()
            .into_iter()
            .collect::<BTreeSet<_>>();
        for agent_id in &known_agents {
            let wanted = desired.contains(agent_id);
            let binding_error_code =
                (wanted && error_message.is_some()).then_some("mcp_projection_failed");
            let binding_error_message = if wanted {
                error_message.as_deref()
            } else {
                None
            };
            if let Err(error) = sqlx::query(
                "INSERT INTO plugin_mcp_bindings_v4
                     (plugin_id, mcp_id, agent_id, desired, applied, error_code, error_message, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(plugin_id, mcp_id, agent_id) DO UPDATE SET
                     desired = excluded.desired,
                     applied = excluded.applied,
                     error_code = excluded.error_code,
                     error_message = excluded.error_message,
                     updated_at = CURRENT_TIMESTAMP",
            )
            .bind(plugin.id())
            .bind(&server_id)
            .bind(agent_id)
            .bind(i64::from(wanted))
            .bind(i64::from(wanted && error_message.is_none()))
            .bind(binding_error_code)
            .bind(binding_error_message)
            .execute(pool)
            .await
            {
                errors.push(format!("{server_id}/{agent_id} binding: {error}"));
            }
        }
    }
    errors
}

async fn materialize_plugin_mcp_spec(
    control_plane: &plugins::PluginControlPlane,
    worker_runtime: &plugins::PluginWorkerRuntimeProvider,
    plugin: &InstalledPlugin,
    server_id: &str,
    spec: Value,
) -> Result<Option<Value>, ApplicationError> {
    let Some(managed) = spec.get("managedRuntime").and_then(Value::as_object) else {
        return Ok(Some(spec));
    };
    if spec
        .get("managedRuntime")
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        == Some("hostFamilyBinary")
    {
        return materialize_host_family_binary_mcp(control_plane, server_id, &spec);
    }
    let entrypoint = managed
        .get("entrypoint")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "managed MCP `{server_id}` requires managedRuntime.entrypoint"
            ))
        })?;
    let relative = Path::new(entrypoint);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ApplicationError::bad_request(format!(
            "managed MCP `{server_id}` entrypoint must be a package-relative path"
        )));
    }
    let package_root = plugin
        .source
        .path
        .canonicalize()
        .map_err(|error| ApplicationError::internal(error.to_string()))?;
    let entrypoint = package_root
        .join(relative)
        .canonicalize()
        .map_err(|error| ApplicationError::not_found(error.to_string()))?;
    if !entrypoint.starts_with(&package_root) || !entrypoint.is_file() {
        return Err(ApplicationError::bad_request(format!(
            "managed MCP `{server_id}` entrypoint escapes the installed package"
        )));
    }
    let node = worker_runtime.resolve().await.map_err(internal_error)?;
    let scopes = managed
        .get("hostScopes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let token = json!({
        "typ": "vibex.plugin-mcp",
        "plugin_id": plugin.id(),
        "mcp_id": server_id,
        "scopes": scopes,
    })
    .to_string();
    Ok(Some(json!({
        "type": "stdio",
        "command": node.to_string_lossy(),
        "args": [entrypoint.to_string_lossy()],
        "env": {
            "VIBEX_PLUGIN_MCP_TOKEN": token,
            "VIBEX_MCP_PROTOCOL_REVISION": managed
                .get("protocolRevision")
                .and_then(Value::as_str)
                .unwrap_or("2026-07-28")
        }
    })))
}

fn materialize_host_family_binary_mcp(
    control_plane: &plugins::PluginControlPlane,
    server_id: &str,
    spec: &Value,
) -> Result<Option<Value>, ApplicationError> {
    let Some(product) = plugins::host_family_product(spec) else {
        return Err(ApplicationError::bad_request(format!(
            "managed MCP `{server_id}` hostFamilyBinary requires a known product"
        )));
    };
    let gate = control_plane.official_product_mcp_gate();
    if !gate
        .bindings()
        .iter()
        .any(|binding| binding.product == product)
    {
        return Ok(None);
    }
    let binary_id = spec
        .get("managedRuntime")
        .and_then(|value| value.get("binaryId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApplicationError::bad_request(format!(
                "managed MCP `{server_id}` hostFamilyBinary requires managedRuntime.binaryId"
            ))
        })?;
    let command = utils::host_bin::locate_host_family_binary(binary_id);
    if product == "workflow" {
        return Ok(Some(plugins::host_family_stdio_spec(
            &command.to_string_lossy(),
            product,
            "",
            None,
            None,
        )));
    }
    let token = gate.token_for_product(product);
    let http_base = gate.http_base();
    if token.as_ref().is_none_or(|value| value.is_empty())
        || http_base.as_ref().is_none_or(|value| value.is_empty())
    {
        return Err(ApplicationError::internal(format!(
            "host family MCP `{server_id}` is not ready for native projection"
        )));
    }
    let features = match product {
        "delegation" => "delegation".to_string(),
        "session" => plugins::session_feature_arg(gate.session_features()),
        "plugin-dev" => "plugin-dev".to_string(),
        other => other.to_string(),
    };
    Ok(Some(plugins::host_family_stdio_spec(
        &command.to_string_lossy(),
        product,
        &features,
        http_base.as_deref(),
        token.as_deref(),
    )))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn configure_agents_args_accept_the_frontend_enable_payload() {
        let args: PluginConfigureAgentsArgs = application::decode_command_args(json!({
            "pluginId": "vibex.plugin-development",
            "allAgents": true,
            "agents": []
        }))
        .expect("frontend enable payload");
        assert_eq!(args.plugin_id, "vibex.plugin-development");
        assert!(args.all_agents);
        assert!(args.agents.is_empty());
    }

    #[test]
    fn projection_targets_fall_back_to_desired_when_no_runtime_is_installed() {
        let desired = BTreeSet::from(["codex".to_owned(), "claude_code".to_owned()]);
        let installed = BTreeSet::new();
        let mut targets = plugin_skill_projection_targets(&desired, &installed);
        targets.sort();
        assert_eq!(targets, vec!["claude_code".to_owned(), "codex".to_owned()]);
    }

    #[test]
    fn projection_targets_prefer_installed_runtimes() {
        let desired = BTreeSet::from(["codex".to_owned(), "claude_code".to_owned()]);
        let installed = BTreeSet::from(["codex".to_owned()]);
        assert_eq!(
            plugin_skill_projection_targets(&desired, &installed),
            vec!["codex".to_owned()]
        );
    }

    #[test]
    fn configure_mcp_args_accept_the_frontend_enable_payload() {
        let args: PluginConfigureMcpArgs = application::decode_command_args(json!({
            "pluginId": "vibex.session-enhance",
            "allAgents": true,
            "agents": []
        }))
        .expect("frontend enable payload");
        assert_eq!(args.plugin_id, "vibex.session-enhance");
        assert!(args.all_agents);
        assert!(args.agents.is_empty());
    }

    #[test]
    fn official_delegation_config_follows_the_mcp_gate() {
        let gate = plugins::OfficialMcpRuntime::default();
        let disabled = official_delegation_config(DelegationConfig::default(), &gate, None);
        assert!(!disabled.enabled);

        gate.publish_binding(plugins::OfficialMcpBinding {
            plugin_id: "vibex.multi-agent".into(),
            binary_id: "vibex-delegation-mcp".into(),
            product: "delegation".into(),
            features: 0,
            token: "token".into(),
        });
        let enabled = official_delegation_config(
            DelegationConfig::default(),
            &gate,
            Some(&json!({
                "depthLimit": 3,
                "completedCacheMaxMb": 64,
            })),
        );
        assert!(enabled.enabled);
        assert_eq!(enabled.depth_limit, 3);
        assert_eq!(enabled.completed_cache_cap_bytes, 64 * 1024 * 1024);
    }
}
