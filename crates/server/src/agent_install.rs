//! Host-side Agent catalog and user-environment installer for `vibex-server`.

use std::{
    collections::{BTreeMap, HashMap},
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use agents::{
    AgentAutoApproveMode, AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager,
    AgentId, BuiltInProfile, BuiltInProfileCatalog, InstallCandidateSource, InstallEnvironment,
    InstallPlanner, InstallPlanningInput, LockedInstallSource, OfficialRegistryHttpFetcher,
    PlannedDistributionKind, PlannedInstallComponent, ProfileComponent, ProfileTopology,
    RegistryCache, RegistrySnapshotClient, ResolvedInstallPlan, SessionLaunchLock, SystemClock,
    UserEnvironmentLayout, current_platform, npm_global_install_args,
    npm_package_name as npm_spec_name, observed_satisfies_profile, version_at_least,
};
use api_types::AgentSource;
use chrono::Utc;
use db::{
    DBService,
    models::agent_management::{
        AgentMembershipRepository, NewAgentMembership, RegistrySnapshotRepository,
    },
};
use serde::Serialize;
use services::services::agent_registry::AgentRegistrySnapshotStore;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::AgentsCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentCatalogGroup {
    BuiltIn,
    Registry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentCatalogEntry {
    pub agent_id: String,
    pub display_name: String,
    pub description: String,
    pub group: AgentCatalogGroup,
    pub status: String,
    pub detail: String,
}

pub async fn run_agents_command(command: AgentsCommand) -> ExitCode {
    let data_dir = utils::assets::host_data_dir();
    let db = match DBService::new_at(&data_dir).await {
        Ok(db) => db,
        Err(error) => {
            eprintln!("could not open the Host data directory: {error}");
            return ExitCode::from(1);
        }
    };
    match command {
        AgentsCommand::List { json, refresh } => match list_agents(&db.pool, refresh).await {
            Ok(entries) => {
                if json {
                    match serde_json::to_string_pretty(&entries) {
                        Ok(body) => println!("{body}"),
                        Err(error) => {
                            eprintln!("{error}");
                            return ExitCode::from(1);
                        }
                    }
                } else {
                    print_catalog(&entries);
                }
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(1)
            }
        },
        AgentsCommand::Install { agent_id, yes } => {
            match install_agent(&db.pool, &data_dir, &agent_id, yes).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{error}");
                    ExitCode::from(1)
                }
            }
        }
    }
}

async fn list_agents(pool: &SqlitePool, refresh: bool) -> anyhow::Result<Vec<AgentCatalogEntry>> {
    let snapshot = load_registry_snapshot(pool, refresh).await?;
    let statuses = installation_statuses(pool).await?;
    let profiles = BuiltInProfileCatalog::bundled();
    let mut entries = Vec::new();
    let mut built_in_ids = std::collections::HashSet::new();
    for profile in profiles.profiles() {
        built_in_ids.insert(profile.agent_id.clone());
        let status = statuses
            .get(profile.agent_id.as_str())
            .cloned()
            .unwrap_or_else(|| "uninstalled".to_string());
        entries.push(AgentCatalogEntry {
            agent_id: profile.agent_id.to_string(),
            display_name: profile.display_name.to_string(),
            description: profile.description.to_string(),
            group: AgentCatalogGroup::BuiltIn,
            status,
            detail: profile_detail(profile),
        });
    }
    if let Some(snapshot) = snapshot {
        let mut extras = snapshot
            .entries
            .into_iter()
            .filter(|entry| !built_in_ids.contains(&entry.agent_id))
            .map(|entry| {
                let status = statuses
                    .get(entry.agent_id.as_str())
                    .cloned()
                    .unwrap_or_else(|| "available".to_string());
                AgentCatalogEntry {
                    agent_id: entry.agent_id.to_string(),
                    display_name: entry.name,
                    description: entry.description,
                    group: AgentCatalogGroup::Registry,
                    status,
                    detail: registry_detail(&entry.distributions),
                }
            })
            .collect::<Vec<_>>();
        extras.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        entries.extend(extras);
    }
    Ok(entries)
}

fn profile_detail(profile: &BuiltInProfile) -> String {
    let names = profile
        .external_candidates
        .iter()
        .map(|candidate| candidate.executable)
        .collect::<Vec<_>>();
    match profile.topology {
        ProfileTopology::AdapterBacked => format!("adapter {}", names.join(" + ")),
        ProfileTopology::NativeAcp => format!("native {}", names.join(" ")),
    }
}

fn registry_detail(distributions: &agents::RegistryDistributions) -> String {
    let mut kinds = Vec::new();
    if distributions.binary.is_some() {
        kinds.push("binary");
    }
    if distributions.npx.is_some() {
        kinds.push("npx");
    }
    if distributions.uvx.is_some() {
        kinds.push("uvx");
    }
    if kinds.is_empty() {
        "registry".to_string()
    } else {
        kinds.join(" ")
    }
}

fn print_catalog(entries: &[AgentCatalogEntry]) {
    let (built_in, registry): (Vec<_>, Vec<_>) = entries
        .iter()
        .partition(|entry| entry.group == AgentCatalogGroup::BuiltIn);
    println!("Built-in");
    if built_in.is_empty() {
        println!("  (none)");
    } else {
        for entry in built_in {
            print_entry(entry);
        }
    }
    println!();
    println!("ACP Registry");
    if registry.is_empty() {
        println!("  (refresh with `vibex-server list --refresh`)");
    } else {
        for entry in registry {
            print_entry(entry);
        }
    }
}

fn print_entry(entry: &AgentCatalogEntry) {
    println!(
        "  {:<20} {:<22} {:<14} {}",
        entry.agent_id, entry.display_name, entry.status, entry.detail
    );
}

async fn installation_statuses(pool: &SqlitePool) -> anyhow::Result<HashMap<String, String>> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT agent_id, lifecycle
           FROM agent_installation
           WHERE current_lock_id IS NOT NULL"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

async fn load_registry_snapshot(
    pool: &SqlitePool,
    refresh: bool,
) -> anyhow::Result<Option<agents::RegistrySnapshot>> {
    let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(pool.clone()));
    let existing = store.load().await?;
    if !refresh && existing.is_some() {
        return Ok(existing);
    }
    let mut cache = existing
        .clone()
        .map(RegistryCache::from_snapshot)
        .unwrap_or_default();
    let client = RegistrySnapshotClient::new(
        std::sync::Arc::new(OfficialRegistryHttpFetcher::default()),
        std::sync::Arc::new(SystemClock),
    );
    let view = if refresh {
        client.refresh(&mut cache).await
    } else {
        client.open(&mut cache).await
    };
    if let Some(error) = view.refresh_error {
        if existing.is_some() {
            eprintln!("registry refresh failed; using the cached snapshot: {error}");
            return Ok(existing);
        }
        anyhow::bail!("ACP Registry is unavailable: {error}");
    }
    if let Some(snapshot) = cache.snapshot().cloned() {
        store.save(&snapshot).await?;
        Ok(Some(snapshot))
    } else {
        Ok(existing)
    }
}

async fn install_agent(
    pool: &SqlitePool,
    data_dir: &Path,
    raw_id: &str,
    yes: bool,
) -> anyhow::Result<()> {
    let agent_id = AgentId::parse(raw_id)
        .map_err(|error| anyhow::anyhow!("invalid Agent id `{raw_id}`: {error}"))?;
    ensure_membership(pool, &agent_id).await?;
    let plan = resolve_plan(pool, &agent_id).await?;
    if !yes && !confirm_install(&plan)? {
        anyhow::bail!("installation canceled");
    }
    println!(
        "Installing {} ({})",
        display_name_for(&agent_id),
        agent_id.as_str()
    );
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("could not resolve the home directory"))?;
    let user_env = UserEnvironmentLayout::for_current_user(&home);
    prepare_user_environment(&user_env).await?;
    let installation = if let Some(adopted) = try_adopt(&agent_id, &plan, &user_env).await? {
        println!("Using the user-environment CLI that already matches the locked versions.");
        adopted
    } else {
        install_plan(&plan, &user_env).await?
    };
    let working_dir = data_dir.join("agents").join(agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    verify_handshake(&agent_id, &installation.launch_lock, &working_dir).await?;
    persist_lock(pool, &plan, &installation).await?;
    println!(
        "Installed {} runtime {} / ACP {}",
        agent_id.as_str(),
        installation.launch_lock.runtime_version,
        installation.launch_lock.acp_version
    );
    Ok(())
}

fn display_name_for(agent_id: &AgentId) -> String {
    BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .map(|profile| profile.display_name.to_string())
        .unwrap_or_else(|| agent_id.to_string())
}

fn confirm_install(plan: &ResolvedInstallPlan) -> anyhow::Result<bool> {
    println!("Plan");
    for component in &plan.components {
        println!(
            "  {:<18} {:<8} {}",
            component.component_id,
            format!("{:?}", component.distribution_kind).to_lowercase(),
            component.resolved_source
        );
    }
    if !std::io::stdin().is_terminal() {
        anyhow::bail!("pass --yes to install without a prompt");
    }
    eprint!("Install these user-environment packages? [y/N] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim(), "y" | "Y" | "yes" | "Yes" | "YES"))
}

async fn ensure_membership(pool: &SqlitePool, agent_id: &AgentId) -> anyhow::Result<()> {
    let repository = AgentMembershipRepository::new(pool.clone());
    if repository.find(agent_id).await?.is_some() {
        return Ok(());
    }
    if BuiltInProfileCatalog::bundled().profile(agent_id).is_some() {
        anyhow::bail!("built-in Agent `{agent_id}` is missing from membership");
    }
    let snapshot = load_registry_snapshot(pool, true).await?.ok_or_else(|| {
        anyhow::anyhow!("ACP Registry is empty; run `vibex-server list --refresh`")
    })?;
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| &entry.agent_id == agent_id)
        .ok_or_else(|| anyhow::anyhow!("unknown Agent `{agent_id}`; run `vibex-server list`"))?;
    let position = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM agent_membership",
    )
    .fetch_one(pool)
    .await?;
    repository
        .add(NewAgentMembership {
            agent_id: agent_id.clone(),
            source: AgentSource::OfficialRegistry,
            built_in: false,
            retired: false,
            enabled: true,
            position,
            retained_metadata_json: Some(
                serde_json::json!({
                    "name": entry.name,
                    "description": entry.description,
                    "version": entry.version,
                    "registry_id": entry.registry_id,
                })
                .to_string(),
            ),
            retained_icon_svg: entry.icon_svg.clone(),
        })
        .await?;
    Ok(())
}

async fn resolve_plan(
    pool: &SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<ResolvedInstallPlan> {
    let _ = utils::shell::refresh_process_path_after_install().await;
    let node_verified = utils::shell::resolve_executable_path("node")
        .await
        .is_some()
        && utils::shell::resolve_executable_path("npm").await.is_some();
    let uv_verified = utils::shell::resolve_executable_path("uv").await.is_some();
    let python_verified = utils::shell::resolve_executable_path("python3")
        .await
        .is_some()
        || utils::shell::resolve_executable_path("python")
            .await
            .is_some();
    let membership = AgentMembershipRepository::new(pool.clone())
        .find(agent_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Agent `{agent_id}` has not been added"))?;
    let source = match membership.source {
        AgentSource::BuiltInProfile => InstallCandidateSource::BuiltInProfile,
        AgentSource::OfficialRegistry => {
            let snapshot = load_registry_snapshot(pool, false)
                .await?
                .ok_or_else(|| anyhow::anyhow!("ACP Registry cache is empty"))?;
            let entry = snapshot
                .entries
                .iter()
                .find(|entry| &entry.agent_id == agent_id)
                .ok_or_else(|| {
                    anyhow::anyhow!("Agent `{agent_id}` is not in the Registry cache")
                })?;
            InstallCandidateSource::Registry(Box::new(entry.lock_add_target(snapshot.id)))
        }
        AgentSource::UserDefinition => {
            anyhow::bail!("user-declared Agents are installed from Settings")
        }
        AgentSource::RetiredLegacy => anyhow::bail!("retired Agents cannot be installed"),
    };
    InstallPlanner::bundled()
        .plan(InstallPlanningInput {
            agent_id: agent_id.clone(),
            source,
            platform: current_platform(),
            environment: InstallEnvironment {
                node_verified,
                uv_verified,
                python_verified,
            },
        })
        .map_err(anyhow::Error::from)
}

struct InstalledComponent {
    kind: String,
    absolute_path: PathBuf,
    version: String,
    sha256: Option<String>,
}

struct InstalledPlan {
    launch_lock: SessionLaunchLock,
    components: Vec<InstalledComponent>,
}

async fn try_adopt(
    agent_id: &AgentId,
    plan: &ResolvedInstallPlan,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<Option<InstalledPlan>> {
    let catalog = BuiltInProfileCatalog::bundled();
    let Some(profile) = catalog.profile(agent_id) else {
        return Ok(None);
    };
    let mut components = Vec::new();
    for candidate in profile.external_candidates {
        let Some(path) = utils::shell::resolve_executable_path(candidate.executable).await else {
            return Ok(None);
        };
        let path = tokio::fs::canonicalize(&path).await?;
        let version = probe_version(&path).await.unwrap_or_default();
        if version.is_empty() {
            return Ok(None);
        }
        components.push(InstalledComponent {
            kind: match candidate.component {
                ProfileComponent::AgentRuntime => "agent_runtime",
                ProfileComponent::AcpAdapter => "acp_adapter",
                ProfileComponent::CombinedRuntime => "combined_runtime",
            }
            .to_string(),
            absolute_path: path,
            version,
            sha256: None,
        });
    }
    let observed = components
        .iter()
        .map(|component| agents::ObservedUserComponent {
            component_id: component.kind.clone(),
            version: Some(component.version.clone()),
        })
        .collect::<Vec<_>>();
    if !observed_satisfies_profile(profile, &observed) {
        return Ok(None);
    }
    for component in &mut components {
        component.sha256 = Some(file_sha256(&component.absolute_path).await?);
    }
    Ok(Some(build_installed_plan(
        agent_id, plan, user_env, components,
    )?))
}

async fn install_plan(
    plan: &ResolvedInstallPlan,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<InstalledPlan> {
    let mut components = Vec::new();
    for component in &plan.components {
        if let Some(existing) = existing_component(component).await {
            println!(
                "Reusing {} {} at {}",
                component.component_id,
                existing.1,
                existing.0.display()
            );
            components.push(InstalledComponent {
                kind: component.component_id.clone(),
                absolute_path: existing.0,
                version: existing.1,
                sha256: None,
            });
            continue;
        }
        let path = match component.distribution_kind {
            PlannedDistributionKind::Npx => install_npm(component, user_env).await?,
            PlannedDistributionKind::Uvx => install_uv(component, user_env).await?,
            PlannedDistributionKind::Binary => {
                install_binary(&plan.agent_id, component, user_env).await?
            }
        };
        let version = probe_version(&path)
            .await
            .unwrap_or_else(|| component.version.clone());
        components.push(InstalledComponent {
            kind: component.component_id.clone(),
            absolute_path: path,
            version,
            sha256: None,
        });
    }
    for component in &mut components {
        component.sha256 = Some(file_sha256(&component.absolute_path).await?);
    }
    Ok(build_installed_plan(
        &plan.agent_id,
        plan,
        user_env,
        components,
    )?)
}

fn build_installed_plan(
    agent_id: &AgentId,
    plan: &ResolvedInstallPlan,
    user_env: &UserEnvironmentLayout,
    components: Vec<InstalledComponent>,
) -> anyhow::Result<InstalledPlan> {
    let runtime = components
        .iter()
        .find(|component| {
            matches!(
                component.kind.as_str(),
                "agent_runtime" | "combined_runtime"
            )
        })
        .ok_or_else(|| anyhow::anyhow!("installation is missing the local Runtime"))?;
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"))
        .ok_or_else(|| anyhow::anyhow!("installation is missing the ACP executable"))?;
    let args = plan
        .components
        .iter()
        .find(|component| component.component_id == acp.kind)
        .map(|component| component.args.clone())
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    let mut path_entries = user_env.path_entries();
    path_entries.extend(
        components
            .iter()
            .filter_map(|component| component.absolute_path.parent().map(Path::to_path_buf)),
    );
    path_entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .into_owned(),
    );
    if let Some(variable) = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| profile.runtime_executable_env)
    {
        env.insert(
            variable.to_string(),
            runtime.absolute_path.display().to_string(),
        );
    }
    Ok(InstalledPlan {
        launch_lock: SessionLaunchLock {
            agent_id: agent_id.clone(),
            absolute_acp_program: acp.absolute_path.clone(),
            args,
            env,
            runtime_version: runtime.version.clone(),
            acp_version: acp.version.clone(),
        },
        components,
    })
}

async fn existing_component(component: &PlannedInstallComponent) -> Option<(PathBuf, String)> {
    let command = component.command.trim();
    if command.is_empty() || command == "npm" || command == "uv" {
        return None;
    }
    let path = utils::shell::resolve_executable_path(command).await?;
    let path = tokio::fs::canonicalize(path).await.ok()?;
    let version = probe_version(&path).await?;
    version_at_least(&version, &component.version).then_some((path, version))
}

async fn install_npm(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    let npm = utils::shell::resolve_executable_path("npm")
        .await
        .ok_or_else(|| anyhow::anyhow!("npm was not found; install Node.js and npm first"))?;
    println!(
        "$ npm install -g --force --prefix {} {}",
        user_env.npm_prefix.display(),
        component.resolved_source
    );
    let mut command = utils::process::new_hidden_tokio_command(&npm, std::iter::empty::<&str>());
    command.args(npm_global_install_args(
        &user_env.npm_prefix,
        &component.resolved_source,
    ));
    run_command("npm install -g", command).await?;
    let package = npm_spec_name(&component.resolved_source);
    let bin = npm_bin_path(user_env, &component.command, &package);
    if tokio::fs::metadata(&bin).await.is_err() {
        anyhow::bail!(
            "npm install did not produce `{}` under {}",
            component.command,
            user_env.npm_bin.display()
        );
    }
    Ok(tokio::fs::canonicalize(bin).await?)
}

fn npm_bin_path(user_env: &UserEnvironmentLayout, command: &str, package: &str) -> PathBuf {
    let name = if command.is_empty() || command == "npm" {
        package.rsplit('/').next().unwrap_or(package)
    } else {
        Path::new(command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(command)
    };
    if cfg!(windows) {
        user_env.npm_bin.join(format!("{name}.cmd"))
    } else {
        user_env.npm_bin.join(name)
    }
}

async fn install_uv(
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    let uv = utils::shell::resolve_executable_path("uv")
        .await
        .ok_or_else(|| anyhow::anyhow!("uv was not found; install uv first"))?;
    println!("$ uv tool install {}", component.resolved_source);
    let mut command = utils::process::new_hidden_tokio_command(&uv, std::iter::empty::<&str>());
    command
        .arg("tool")
        .arg("install")
        .arg("--force")
        .arg("--no-config");
    if component.resolved_source.starts_with("hermes-agent[") {
        command.arg("--python").arg("3.13");
    }
    command
        .arg(&component.resolved_source)
        .env("UV_TOOL_DIR", &user_env.uv_tool_dir)
        .env("UV_TOOL_BIN_DIR", &user_env.uv_tool_bin)
        .env("UV_PYTHON_INSTALL_DIR", &user_env.uv_python_dir)
        .env("UV_CACHE_DIR", &user_env.uv_cache_dir);
    run_command("uv tool install", command).await?;
    let name = Path::new(&component.command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(component.command.as_str());
    let bin = if cfg!(windows) {
        user_env.uv_tool_bin.join(format!("{name}.exe"))
    } else {
        user_env.uv_tool_bin.join(name)
    };
    if tokio::fs::metadata(&bin).await.is_err() {
        anyhow::bail!("uv tool install did not produce `{}`", bin.display());
    }
    Ok(tokio::fs::canonicalize(bin).await?)
}

async fn install_binary(
    agent_id: &AgentId,
    component: &PlannedInstallComponent,
    user_env: &UserEnvironmentLayout,
) -> anyhow::Result<PathBuf> {
    println!(
        "Downloading {} ({})",
        component.component_id, component.version
    );
    let bytes = reqwest::get(&component.resolved_source)
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let staging = std::env::temp_dir().join(format!("vibex-agent-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let extract_result = extract_archive(&bytes, &component.resolved_source, &staging);
    let staged =
        match extract_result.and_then(|_| find_staged_executable(&staging, &component.command)) {
            Ok(path) => path,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error);
            }
        };
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    let destination = user_bin_destination(&user_env.user_bin, &component.command, &staged);
    tokio::fs::copy(&staged, &destination).await?;
    if let Some(profile) = BuiltInProfileCatalog::bundled().profile(agent_id) {
        let siblings = profile.binary_required_siblings(cfg!(windows));
        if let Some(staged_dir) = staged.parent() {
            for sibling in siblings {
                let name = Path::new(sibling)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(sibling);
                let source = staged_dir.join(name);
                if !source.is_file() {
                    anyhow::bail!("extracted archive is missing required sibling `{name}`");
                }
                tokio::fs::copy(&source, user_env.user_bin.join(name)).await?;
            }
        }
    }
    let _ = tokio::fs::remove_dir_all(&staging).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(&destination).await?.permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&destination, permissions).await?;
    }
    Ok(tokio::fs::canonicalize(destination).await?)
}

fn user_bin_destination(user_bin: &Path, command: &str, staged: &Path) -> PathBuf {
    let name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".exe") || lower.ends_with(".bat") {
            user_bin.join(name)
        } else if staged
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
        {
            user_bin.join(format!("{name}.cmd"))
        } else {
            user_bin.join(format!("{name}.exe"))
        }
    } else {
        user_bin.join(name)
    }
}

fn extract_archive(bytes: &[u8], source: &str, destination: &Path) -> anyhow::Result<()> {
    if source.to_ascii_lowercase().ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        archive.extract(destination)?;
        return Ok(());
    }
    let archive = destination.join("download.archive");
    std::fs::write(&archive, bytes)?;
    let status = std::process::Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(destination)
        .status()?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        anyhow::bail!("tar extract failed with {status}");
    }
    Ok(())
}

fn find_staged_executable(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let relative = PathBuf::from(command);
    let direct = root.join(&relative);
    if direct.is_file() {
        return Ok(direct);
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("binary command `{command}` is not a file name"))?;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name() == Some(file_name) {
                return Ok(path);
            }
        }
    }
    anyhow::bail!("extracted archive does not contain `{command}`")
}

async fn prepare_user_environment(user_env: &UserEnvironmentLayout) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&user_env.user_bin).await?;
    tokio::fs::create_dir_all(&user_env.npm_bin).await?;
    tokio::fs::create_dir_all(&user_env.uv_tool_dir).await?;
    for directory in user_env.path_entries() {
        utils::shell::expose_user_bin_to_process_path(&directory);
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
    Ok(())
}

async fn verify_handshake(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
) -> anyhow::Result<()> {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
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
    ready
        .await
        .map_err(|_| anyhow::anyhow!("ACP process exited before initialize"))??;
    manager.disconnect(connection_id).await?;
    Ok(())
}

async fn persist_lock(
    pool: &SqlitePool,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
) -> anyhow::Result<()> {
    let lock_id = Uuid::new_v4();
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({ "kind": "built_in_profile" }),
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
    .bind(&plan.version)
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
        .bind("user_environment")
        .bind("external")
        .bind(Option::<String>::None)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, 'external', 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
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
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn probe_version(executable: &Path) -> Option<String> {
    let mut command =
        utils::process::new_hidden_tokio_command(executable, std::iter::empty::<&str>());
    command.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

async fn file_sha256(path: &Path) -> anyhow::Result<String> {
    let bytes = tokio::fs::read(path).await?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

async fn run_command(label: &str, mut command: tokio::process::Command) -> anyhow::Result<()> {
    let output = command.output().await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("{label} failed: {}", stderr.trim())
}
