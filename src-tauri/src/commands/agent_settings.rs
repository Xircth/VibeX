use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use agents::{
    AgentAvailabilityInfo, AgentDistribution, AgentKind, AgentPreflightCheckStatus,
    AgentPreflightProbe, AgentPreflightReport, AgentRegistryEntry, CommandBuildInput,
    agent_availability, all_agent_types, build_preflight_report, claude_config_path,
    codex_auth_path, current_platform, local_acp_command_parts, local_agent_runtime_spec,
    local_detection::{
        AgentLocalProbe, AgentLocalState, LocalRuntimeProbe, agent_local_state,
        npm_global_package_dir, npm_package_name, version_at_least,
    },
    minimum_supported_acp_version, opencode_auth_path, registry_entry,
};
use api_types::{
    AgentRuntimeComponentInfo, AgentSettingInfo, LocalAgentRuntimeInfo, PreflightCheck,
    PreflightFix, PreflightResult, PreflightStatus, ReorderAgentsRequest, UpdateAgentPreferences,
};
use db::models::agent_setting::{AgentSetting, PersistedAgentRuntimeIdentity};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{net::TcpStream, sync::OnceCell, time::timeout};

use crate::{error::AppError, state::AppState};

/// Result of the startup installation reconciliation. Detailed diagnostics
/// remain available through the regular Agent preflight endpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallationBootstrap {
    /// Agents whose local CLI + ACP bridge satisfy the same gate used for
    /// real session creation. The frontend uses this to avoid prompting a
    /// Codex-only user about every optional Agent they have not installed.
    pub usable_agents: Vec<AgentKind>,
    pub installed_acp_agents: Vec<AgentKind>,
    pub failed_acp_agents: Vec<AgentKind>,
    pub incompatible_acp_agents: Vec<AgentKind>,
    pub incompatible_runtime_agents: Vec<AgentKind>,
    pub missing_runtime_agents: Vec<AgentKind>,
}

// Both Rust setup and the frontend call the same command. Cache the completed
// reconciliation so setup can prepare catalogs before the first screen while
// the frontend still receives the result needed for its Toast.
static AGENT_BOOTSTRAP_RESULT: OnceLock<tokio::sync::Mutex<Option<AgentInstallationBootstrap>>> =
    OnceLock::new();

/// npm's global prefix is shared by every Agent CLI and ACP bridge. Keep all
/// writes through one process-wide lock: startup reconciliation, a Settings
/// repair, and system maintenance can otherwise run overlapping `npm -g`
/// commands and observe one another's half-written shims.
static GLOBAL_NPM_MUTATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

pub(crate) async fn lock_global_npm_mutations() -> tokio::sync::MutexGuard<'static, ()> {
    GLOBAL_NPM_MUTATION_LOCK
        .get_or_init(Default::default)
        .lock()
        .await
}

async fn invalidate_agent_bootstrap_result() {
    if let Some(result_slot) = AGENT_BOOTSTRAP_RESULT.get() {
        *result_slot.lock().await = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupInstallAction {
    Ready,
    InstallAcp,
    NeedsAcpUpdate,
    NeedsRuntimeSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupAcpReadiness {
    Ready,
    Missing,
    Incompatible,
}

fn startup_install_action(
    runtime_present: bool,
    acp_readiness: StartupAcpReadiness,
    has_separate_acp_adapter: bool,
) -> StartupInstallAction {
    match (runtime_present, acp_readiness) {
        (true, StartupAcpReadiness::Ready) => StartupInstallAction::Ready,
        // For Codex/Claude, ACP is an independently managed local bridge and
        // can safely be installed without altering the user's CLI. For
        // OpenCode-style agents ACP is a CLI subcommand, so an unavailable
        // subcommand means the runtime needs user-approved installation or
        // update in Settings, never an implicit runtime replacement.
        (true, StartupAcpReadiness::Missing) if has_separate_acp_adapter => {
            StartupInstallAction::InstallAcp
        }
        (true, StartupAcpReadiness::Missing) => StartupInstallAction::NeedsRuntimeSetup,
        // A locally present but old/unverifiable ACP is never silently
        // overwritten at startup. Settings offers a visible update action.
        (true, StartupAcpReadiness::Incompatible) => StartupInstallAction::NeedsAcpUpdate,
        (false, _) => StartupInstallAction::NeedsRuntimeSetup,
    }
}

/// Result of invoking the actual ACP executable selected from PATH. This is
/// deliberately separate from npm package metadata: a package directory can
/// exist while PATH resolves a different, older binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalAcpVerification {
    pub executable: Option<PathBuf>,
    pub version: Option<String>,
    pub minimum_supported_version: Option<String>,
    pub probe_error: Option<String>,
}

impl LocalAcpVerification {
    pub(crate) fn is_supported(&self) -> bool {
        self.executable.is_some()
            && self.version.as_deref().is_some_and(|version| {
                self.minimum_supported_version
                    .as_deref()
                    .is_none_or(|minimum| version_at_least(version, minimum))
            })
    }

    fn startup_readiness(&self) -> StartupAcpReadiness {
        if self.is_supported() {
            StartupAcpReadiness::Ready
        } else if self.executable.is_none() {
            StartupAcpReadiness::Missing
        } else {
            StartupAcpReadiness::Incompatible
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalAcpCacheKey {
    executable: PathBuf,
    modified: SystemTime,
    length: u64,
}

#[derive(Debug, Clone)]
struct CachedLocalAcpVerification {
    key: LocalAcpCacheKey,
    verification: LocalAcpVerification,
}

static LOCAL_ACP_VERIFICATION_CACHE: OnceLock<
    std::sync::Mutex<HashMap<AgentKind, CachedLocalAcpVerification>>,
> = OnceLock::new();

/// Result of invoking the actual Agent CLI selected from PATH. The ACP adapter
/// delegates to this exact executable (via e.g. `CODEX_PATH`), so a resolved
/// pathname alone is not enough: old CLIs can advertise stale models or fail
/// against a new ACP bridge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalCliVerification {
    pub executable: Option<PathBuf>,
    pub version: Option<String>,
    pub minimum_supported_version: Option<String>,
    pub probe_error: Option<String>,
}

impl LocalCliVerification {
    pub(crate) fn is_supported(&self) -> bool {
        self.executable.is_some()
            && self
                .minimum_supported_version
                .as_deref()
                .is_none_or(|minimum| {
                    self.version
                        .as_deref()
                        .is_some_and(|version| version_at_least(version, minimum))
                })
    }
}

/// The complete local executable pair that VibeX will use for an ACP agent.
/// A successful npm command alone is deliberately not enough: the resolved
/// CLI can still be a different binary earlier on PATH, and same-binary
/// agents such as OpenCode must also prove that their ACP subcommand runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalAgentRuntimeVerification {
    pub cli: LocalCliVerification,
    pub acp: LocalAcpVerification,
}

impl LocalAgentRuntimeVerification {
    pub(crate) fn is_supported(&self) -> bool {
        self.cli.is_supported() && self.acp.is_supported()
    }

    pub(crate) fn identity(&self) -> Option<LocalAgentRuntimeIdentity> {
        if !self.is_supported() {
            return None;
        }
        Some(LocalAgentRuntimeIdentity {
            cli_path: self.cli.executable.clone()?,
            cli_version: self.cli.version.clone()?,
            acp_path: self.acp.executable.clone()?,
            acp_version: self.acp.version.clone()?,
        })
    }
}

/// Stable identity of the exact local executables that passed verification.
/// Catalog code can use the cache-only accessor below as a fingerprint without
/// starting a subprocess for every selector read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalAgentRuntimeIdentity {
    pub cli_path: PathBuf,
    pub cli_version: String,
    pub acp_path: PathBuf,
    pub acp_version: String,
}

/// A catalog-safe runtime identity. Unlike [`LocalAgentRuntimeIdentity`], this
/// also carries lightweight filesystem revisions, so it can be persisted and
/// checked after a restart without executing either binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalAgentRuntimeCatalogIdentity {
    pub cli_path: PathBuf,
    pub cli_version: String,
    pub cli_revision: String,
    pub acp_path: PathBuf,
    pub acp_version: String,
    pub acp_revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimeExecutableRevision {
    /// Bump when the encoded revision semantics change. Older persisted rows
    /// then naturally fail equality and wait for a verified refresh.
    format: u8,
    canonical_target: String,
    byte_length: u64,
    modified_at: String,
    package_manifest: Option<LocalRuntimePackageManifestRevision>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRuntimePackageManifestRevision {
    path: String,
    byte_length: u64,
    modified_at: String,
    sha256: Option<String>,
}

const RUNTIME_REVISION_FORMAT: u8 = 1;
const MAX_RUNTIME_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_MANIFEST_ANCESTORS: usize = 8;

impl LocalAgentRuntimeVerification {
    /// Build an identity suitable for a persisted capability catalog. This is
    /// intentionally stricter than [`Self::identity`]: an agent may still be
    /// runnable when filesystem metadata is unavailable, but its old catalog
    /// must not be reused until a fresh ACP discovery is possible.
    fn catalog_identity(&self) -> Option<LocalAgentRuntimeCatalogIdentity> {
        let runtime = self.identity()?;
        let cli_revision = local_runtime_executable_revision(&runtime.cli_path)?;
        let acp_revision = if runtime.cli_path == runtime.acp_path {
            cli_revision.clone()
        } else {
            local_runtime_executable_revision(&runtime.acp_path)?
        };
        Some(LocalAgentRuntimeCatalogIdentity {
            cli_path: runtime.cli_path,
            cli_version: runtime.cli_version,
            cli_revision,
            acp_path: runtime.acp_path,
            acp_version: runtime.acp_version,
            acp_revision,
        })
    }
}

fn system_time_revision(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}:{}", duration.as_secs(), duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            format!("-{}:{}", duration.as_secs(), duration.subsec_nanos())
        }
    }
}

/// Return a nearby npm-style package manifest fingerprint when the executable
/// resolves into a package directory. This is deliberately best-effort: raw
/// executable metadata and canonical target remain sufficient for standalone
/// binaries or package-manager shims without a discoverable manifest.
fn nearby_package_manifest_revision(
    canonical_target: &Path,
) -> Option<LocalRuntimePackageManifestRevision> {
    for directory in canonical_target
        .parent()?
        .ancestors()
        .take(MAX_MANIFEST_ANCESTORS)
    {
        let manifest = directory.join("package.json");
        let metadata = match std::fs::metadata(&manifest) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => continue,
        };
        let modified_at = metadata.modified().ok()?;
        let sha256 = if metadata.len() <= MAX_RUNTIME_MANIFEST_BYTES {
            std::fs::read(&manifest).ok().map(|contents| {
                let mut digest = Sha256::new();
                digest.update(contents);
                format!("{:x}", digest.finalize())
            })
        } else {
            None
        };
        let path = std::fs::canonicalize(&manifest).unwrap_or(manifest);
        return Some(LocalRuntimePackageManifestRevision {
            path: path.display().to_string(),
            byte_length: metadata.len(),
            modified_at: system_time_revision(modified_at),
            sha256,
        });
    }
    None
}

/// Produce an opaque, cheap-to-recompute file revision without running a
/// child process. Canonical target catches a symlink repoint, metadata catches
/// file replacement, and a nearby package manifest catches npm updates that
/// keep a launcher shim's mtime unchanged.
fn local_runtime_executable_revision(executable: &Path) -> Option<String> {
    let canonical_target = std::fs::canonicalize(executable).ok()?;
    let metadata = std::fs::metadata(&canonical_target).ok()?;
    let modified_at = metadata.modified().ok()?;
    serde_json::to_string(&LocalRuntimeExecutableRevision {
        format: RUNTIME_REVISION_FORMAT,
        canonical_target: canonical_target.display().to_string(),
        byte_length: metadata.len(),
        modified_at: system_time_revision(modified_at),
        package_manifest: nearby_package_manifest_revision(&canonical_target),
    })
    .ok()
}

fn catalog_identity_to_persisted(
    identity: &LocalAgentRuntimeCatalogIdentity,
) -> PersistedAgentRuntimeIdentity {
    PersistedAgentRuntimeIdentity {
        cli_path: identity.cli_path.display().to_string(),
        cli_version: identity.cli_version.clone(),
        cli_revision: identity.cli_revision.clone(),
        acp_path: identity.acp_path.display().to_string(),
        acp_version: identity.acp_version.clone(),
        acp_revision: identity.acp_revision.clone(),
    }
}

/// Whether an AgentSetting contains a complete, current persisted identity.
/// `Stale` deliberately includes malformed/partial values: a selector must
/// never fall back to a prior catalog until startup or preflight verifies the
/// runtime again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PersistedRuntimeCatalogIdentity {
    Missing,
    Valid(LocalAgentRuntimeCatalogIdentity),
    Stale,
}

/// Validate a persisted runtime identity against the current process PATH and
/// its current filesystem revisions. `resolve_program` must be a pure local
/// resolver: selector callers intentionally do not use the async resolver,
/// which may refresh a login shell after a miss.
fn persisted_runtime_catalog_identity_with_resolver(
    agent_type: AgentKind,
    setting: &AgentSetting,
    resolve_program: impl Fn(&str) -> Option<PathBuf>,
) -> PersistedRuntimeCatalogIdentity {
    let any_field_present = [
        &setting.runtime_cli_path,
        &setting.runtime_cli_version,
        &setting.runtime_cli_revision,
        &setting.runtime_acp_path,
        &setting.runtime_acp_version,
        &setting.runtime_acp_revision,
    ]
    .iter()
    .any(|field| field.is_some());
    let Some(identity) = setting.persisted_runtime_identity() else {
        return if any_field_present {
            PersistedRuntimeCatalogIdentity::Stale
        } else {
            PersistedRuntimeCatalogIdentity::Missing
        };
    };
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        // Only local-runtime agents may own these fields. Treat a stray row
        // from a migration or a future registry change as unsafe rather than
        // giving an unrelated Agent a catalog produced by another executable.
        return PersistedRuntimeCatalogIdentity::Stale;
    };
    let catalog_identity = LocalAgentRuntimeCatalogIdentity {
        cli_path: PathBuf::from(identity.cli_path),
        cli_version: identity.cli_version,
        cli_revision: identity.cli_revision,
        acp_path: PathBuf::from(identity.acp_path),
        acp_version: identity.acp_version,
        acp_revision: identity.acp_revision,
    };
    if !catalog_identity.cli_path.is_absolute()
        || !catalog_identity.acp_path.is_absolute()
        || catalog_identity.cli_version.trim().is_empty()
        || catalog_identity.acp_version.trim().is_empty()
        || catalog_identity.cli_revision.trim().is_empty()
        || catalog_identity.acp_revision.trim().is_empty()
    {
        return PersistedRuntimeCatalogIdentity::Stale;
    }

    // A selector cannot launch a login shell just to resolve PATH, but it can
    // safely perform the same local `which`-style lookup that the runtime will
    // use once bootstrap has run. Comparing canonical paths also handles npm
    // symlinks and Windows command shims. If PATH now prefers another local
    // install, a version/revision match on the old file is not enough.
    let same_target = |current: PathBuf, persisted: &Path| {
        matches!(
            (
                std::fs::canonicalize(current),
                std::fs::canonicalize(persisted),
            ),
            (Ok(current), Ok(persisted)) if current == persisted
        )
    };
    let cli_on_path = resolve_program(runtime.cli_program);
    let acp_on_path = resolve_program(runtime.acp_program);
    if !cli_on_path.is_some_and(|current| same_target(current, &catalog_identity.cli_path))
        || !acp_on_path.is_some_and(|current| same_target(current, &catalog_identity.acp_path))
    {
        return PersistedRuntimeCatalogIdentity::Stale;
    }

    let cli_revision = local_runtime_executable_revision(&catalog_identity.cli_path);
    let acp_revision = if catalog_identity.cli_path == catalog_identity.acp_path {
        cli_revision.clone()
    } else {
        local_runtime_executable_revision(&catalog_identity.acp_path)
    };
    if cli_revision.as_deref() == Some(catalog_identity.cli_revision.as_str())
        && acp_revision.as_deref() == Some(catalog_identity.acp_revision.as_str())
    {
        PersistedRuntimeCatalogIdentity::Valid(catalog_identity)
    } else {
        PersistedRuntimeCatalogIdentity::Stale
    }
}

/// Validate the persisted pair without spawning a subprocess. `which` scans
/// only the current process PATH and local filesystem; unlike
/// `resolve_program_on_path`, it never invokes a login shell to refresh PATH.
pub(crate) fn persisted_runtime_catalog_identity(
    agent_type: AgentKind,
    setting: &AgentSetting,
) -> PersistedRuntimeCatalogIdentity {
    persisted_runtime_catalog_identity_with_resolver(agent_type, setting, |program| {
        which::which(program).ok()
    })
}

#[derive(Debug, Clone)]
struct CachedLocalCliVerification {
    key: LocalAcpCacheKey,
    verification: LocalCliVerification,
}

static LOCAL_CLI_VERIFICATION_CACHE: OnceLock<
    std::sync::Mutex<HashMap<AgentKind, CachedLocalCliVerification>>,
> = OnceLock::new();

fn to_info(row: &AgentSetting) -> Option<AgentSettingInfo> {
    let Some(agent_type) = AgentKind::from_lenient(&row.agent_type) else {
        tracing::warn!(
            agent_type = %row.agent_type,
            "skipping agent_setting row with unrecognized agent_type"
        );
        return None;
    };
    Some(AgentSettingInfo {
        id: row.id,
        agent_type,
        enabled: row.enabled,
        sort_order: row.sort_order,
        installed_version: row.installed_version.clone(),
        env_json: row.env_json.clone(),
        config_json: row.config_json.clone(),
        auto_approve_mode: row.auto_approve_mode.clone(),
        installed: false,
        runtime_ok: false,
        local_runtime: None,
    })
}

/// Machine-wide runtime facts, probed once per app run (each probe is a short
/// bounded subprocess; results only change when the user installs/upgrades a
/// runtime, and preflight re-checks from scratch anyway).
static RUNTIME_PROBE: OnceCell<LocalRuntimeProbe> = OnceCell::const_new();

async fn runtime_probe() -> &'static LocalRuntimeProbe {
    RUNTIME_PROBE
        .get_or_init(|| async {
            // These independent local commands used to run serially. Keep the
            // same bounded probes, but avoid making first-run inventory wait
            // for three separate command timeouts.
            let (npm_global_root, node_version, uv_version) = tokio::join!(
                probe_command_output(node_installer_program(), &["root", "-g"]),
                probe_command_output("node", &["--version"]),
                probe_command_output("uv", &["--version"]),
            );
            LocalRuntimeProbe {
                npm_global_root,
                node_version,
                uv_version,
            }
        })
        .await
}

async fn probe_command_output(program: &str, args: &[&str]) -> Option<String> {
    let executable = resolve_program_on_path(program).await.ok()?;
    let mut command = utils::process::new_hidden_tokio_command(&executable, args);
    command.kill_on_drop(true);
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Commands whose presence on PATH is evidence the agent itself is installed.
fn program_candidates(distribution: &AgentDistribution) -> Vec<String> {
    match distribution {
        AgentDistribution::Npx { cmd, .. } => vec![cmd.clone()],
        AgentDistribution::Uvx {
            cmd,
            system_command,
            ..
        } => {
            let mut candidates: Vec<String> = system_command
                .as_ref()
                .map(|system| system.cmd.clone())
                .into_iter()
                .collect();
            candidates.push(cmd.clone());
            candidates
        }
        AgentDistribution::Binary { cmd, .. } | AgentDistribution::System { cmd, .. } => {
            vec![cmd.clone()]
        }
    }
}

async fn agent_local_probe(
    entry: &AgentRegistryEntry,
    runtime: &LocalRuntimeProbe,
) -> AgentLocalProbe {
    let marker_available = agent_availability(entry.agent_type).is_available();

    let mut program_on_path = false;
    for candidate in program_candidates(&entry.distribution) {
        if candidate.trim().is_empty() {
            continue;
        }
        if resolve_program_on_path(&candidate).await.is_ok() {
            program_on_path = true;
            break;
        }
    }

    let npm_package_dir_exists = match (&entry.distribution, runtime.npm_global_root.as_deref()) {
        (AgentDistribution::Npx { package, .. }, Some(root)) => {
            npm_global_package_dir(root, package).exists()
        }
        _ => false,
    };

    AgentLocalProbe {
        marker_available,
        program_on_path,
        npm_package_dir_exists,
    }
}

/// Verified local install/runtime state for one agent (shared with the ACP
/// discovery probe's "only poke agents that are actually present" gate).
pub(crate) async fn agent_local_state_for(entry: &AgentRegistryEntry) -> AgentLocalState {
    let runtime = runtime_probe().await;
    let probe = agent_local_probe(entry, runtime).await;
    let mut state = agent_local_state(&entry.distribution, probe, runtime);
    if local_agent_runtime_spec(entry.agent_type).is_some() {
        // Picker/install state must be driven by the same exact executable +
        // version checks as a real session. In particular, `opencode` being
        // on PATH does not prove `opencode acp` works, and an old Codex CLI
        // must not be presented as selectable behind a newer bridge.
        let (cli, acp) = tokio::join!(
            verify_local_cli_runtime(entry.agent_type),
            verify_local_acp_runtime(entry.agent_type)
        );
        state.installed = cli.is_supported() && acp.is_supported();
        state.runtime_ok &= cli.is_supported() && acp.is_supported();
    }
    state
}

fn runtime_component_info(
    executable: Option<&PathBuf>,
    version: Option<&str>,
    minimum_supported_version: Option<&str>,
    supported: bool,
) -> AgentRuntimeComponentInfo {
    AgentRuntimeComponentInfo {
        path: executable.map(|path| path.display().to_string()),
        version: version.map(str::to_string),
        minimum_supported_version: minimum_supported_version.map(str::to_string),
        supported,
    }
}

async fn local_runtime_info_for(agent_type: AgentKind) -> Option<LocalAgentRuntimeInfo> {
    local_agent_runtime_spec(agent_type)?;
    let verification = verify_local_agent_runtime(agent_type).await;
    Some(LocalAgentRuntimeInfo {
        cli: runtime_component_info(
            verification.cli.executable.as_ref(),
            verification.cli.version.as_deref(),
            verification.cli.minimum_supported_version.as_deref(),
            verification.cli.is_supported(),
        ),
        acp: runtime_component_info(
            verification.acp.executable.as_ref(),
            verification.acp.version.as_deref(),
            verification.acp.minimum_supported_version.as_deref(),
            verification.acp.is_supported(),
        ),
    })
}

/// DTO rows enriched with the verified local install/runtime state.
async fn enriched_infos(rows: &[AgentSetting]) -> Vec<AgentSettingInfo> {
    futures::future::join_all(rows.iter().filter_map(|row| {
        let mut info = to_info(row)?;
        Some(async move {
            let entry = registry_entry(info.agent_type);
            let state = agent_local_state_for(&entry).await;
            info.installed = state.installed;
            info.runtime_ok = state.runtime_ok;
            info.local_runtime = local_runtime_info_for(info.agent_type).await;
            info
        })
    }))
    .await
}

#[tauri::command]
pub async fn list_agents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentSettingInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let rows = AgentSetting::list_all(pool).await?;
    Ok(enriched_infos(&rows).await)
}

#[tauri::command]
pub async fn update_agent_preferences(
    state: tauri::State<'_, AppState>,
    payload: UpdateAgentPreferences,
) -> Result<AgentSettingInfo, AppError> {
    validate_agent_config_json(payload.agent_type, payload.config_json.as_deref())?;
    validate_auto_approve_mode(payload.auto_approve_mode.as_deref())?;

    let pool = &state.deployment.db().pool;
    let updated = AgentSetting::update_preferences(
        pool,
        payload.agent_type.as_str(),
        payload.enabled,
        payload.env_json.as_deref(),
        payload.config_json.as_deref(),
        payload.auto_approve_mode.as_deref(),
    )
    .await
    .map_err(|e| match e {
        db::models::agent_setting::AgentSettingError::NotFound => {
            AppError::NotFound(format!("Agent setting not found: {}", payload.agent_type))
        }
        db::models::agent_setting::AgentSettingError::Database(e) => {
            AppError::Internal(e.to_string())
        }
    })?;
    enriched_infos(std::slice::from_ref(&updated))
        .await
        .pop()
        .ok_or_else(|| {
            AppError::Internal(format!(
                "Updated agent_setting row has unrecognized agent_type: {}",
                updated.agent_type
            ))
        })
}

fn validate_auto_approve_mode(mode: Option<&str>) -> Result<(), AppError> {
    match mode {
        None | Some("off" | "allow_always" | "yolo") => Ok(()),
        Some(mode) => Err(AppError::BadRequest(format!(
            "Unsupported auto approve mode: {}",
            mode
        ))),
    }
}

fn validate_agent_config_json(
    agent_type: AgentKind,
    config_json: Option<&str>,
) -> Result<(), AppError> {
    if agent_type != AgentKind::Codex {
        return Ok(());
    }

    let Some(config_json) = config_json else {
        return Ok(());
    };
    let value: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| AppError::BadRequest(format!("Invalid config JSON: {}", e)))?;
    let Some(config) = value.as_object() else {
        return Err(AppError::BadRequest(
            "Codex config JSON must be an object".to_string(),
        ));
    };

    let unsupported = ["model_provider", "supports_websockets", "reasoning_effort"]
        .into_iter()
        .filter(|key| config.contains_key(*key))
        .collect::<Vec<_>>();
    if unsupported.is_empty() {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "Codex ACP config does not support legacy field(s): {}",
            unsupported.join(", ")
        )))
    }
}

#[tauri::command]
pub async fn reorder_agents(
    state: tauri::State<'_, AppState>,
    payload: ReorderAgentsRequest,
) -> Result<Vec<AgentSettingInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let order: Vec<String> = payload
        .order
        .iter()
        .map(|kind| kind.as_str().to_string())
        .collect();
    AgentSetting::reorder(pool, &order).await?;
    let rows = AgentSetting::list_all(pool).await?;
    Ok(enriched_infos(&rows).await)
}

fn parse_agent_type_key(agent_type: &str) -> Result<AgentKind, AppError> {
    AgentKind::from_lenient(agent_type)
        .ok_or_else(|| AppError::BadRequest(format!("Unknown agent type: {agent_type}")))
}

fn entry_for_agent_key(agent_type: &str) -> Result<AgentRegistryEntry, AppError> {
    Ok(registry_entry(parse_agent_type_key(agent_type)?))
}

fn command_parts_for_entry(entry: &AgentRegistryEntry) -> Result<agents::CommandParts, String> {
    if let Some(parts) = local_acp_command_parts(entry.agent_type) {
        return Ok(parts);
    }
    entry
        .distribution
        .command_parts(&CommandBuildInput {
            platform: current_platform(),
            binary_dir: None,
            prefer_system_uvx_command: false,
        })
        .map_err(|error| error.to_string())
}

fn npm_package_for_entry(entry: &AgentRegistryEntry) -> Option<String> {
    match &entry.distribution {
        AgentDistribution::Npx { package, .. } => Some(package.clone()),
        _ => None,
    }
}

/// The executable the ACP adapter delegates to.  This is intentionally not
/// inferred from the adapter's npm package: Codex ACP and the Codex CLI are
/// independently versioned packages.
#[derive(Clone, Copy)]
struct AgentCliSpec {
    command: &'static str,
    npm_package: &'static str,
}

fn cli_spec_for_agent(agent_type: AgentKind) -> Option<AgentCliSpec> {
    let spec = local_agent_runtime_spec(agent_type)?;
    Some(AgentCliSpec {
        command: spec.cli_program,
        npm_package: spec.npm_package?,
    })
}

fn install_command_for_agent(agent_type: &str) -> Option<(String, Vec<String>)> {
    let entry = entry_for_agent_key(agent_type).ok()?;
    let package = npm_package_for_entry(&entry)?;
    let package = format!("{}@latest", npm_package_name(&package));
    Some((
        node_installer_program().to_string(),
        vec!["install".to_string(), "-g".to_string(), package],
    ))
}

fn uninstall_command_for_agent(agent_type: &str) -> Option<(String, Vec<String>)> {
    let entry = entry_for_agent_key(agent_type).ok()?;
    let package = npm_package_for_entry(&entry)?;
    Some((
        node_installer_program().to_string(),
        vec![
            "uninstall".to_string(),
            "-g".to_string(),
            npm_package_name(&package),
        ],
    ))
}

async fn install_acp_adapter(agent_type: AgentKind) -> Result<(), AppError> {
    let _npm_mutation = lock_global_npm_mutations().await;
    install_acp_adapter_while_npm_locked(agent_type).await
}

async fn install_acp_adapter_while_npm_locked(agent_type: AgentKind) -> Result<(), AppError> {
    let (program, args) = install_command_for_agent(agent_type.as_str()).ok_or_else(|| {
        AppError::Internal(format!("No ACP install action available for {agent_type}"))
    })?;
    let executable = resolve_program_on_path(&program).await?;
    let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
    command.kill_on_drop(true);
    let output = timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| AppError::Internal(format!("ACP adapter install timed out for {agent_type}")))?
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to install ACP adapter for {agent_type}: {error}"
            ))
        })?;
    if !output.status.success() {
        return Err(AppError::Internal(
            utils::process::command_output_detail(&output)
                .map(|detail| format!("ACP adapter install failed for {agent_type}: {detail}"))
                .unwrap_or_else(|| format!("ACP adapter install failed for {agent_type}")),
        ));
    }
    // Global npm installs can update PATH on first install (notably nvm/fnm
    // layouts), so refresh before checking the adapter again.
    let _ = utils::shell::refresh_process_path_after_install().await;
    Ok(())
}

/// Once VibeX has installed or updated an Agent CLI at the user's request,
/// finish the pair by installing its separate ACP bridge when it is absent.
/// This is intentionally limited to missing bridges: an existing old bridge
/// remains a visible Settings update decision rather than a silent overwrite.
async fn install_missing_acp_for_local_runtime(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> Result<(), AppError> {
    let installed = {
        let _npm_mutation = lock_global_npm_mutations().await;
        install_missing_acp_for_local_runtime_while_npm_locked(agent_type).await?
    };
    if !installed {
        return Ok(());
    }

    // Do not hold the global npm lock while this lifecycle hook invalidates
    // the startup snapshot: bootstrap may own that snapshot while waiting for
    // the npm lock. Releasing first prevents a lock-order cycle.
    let verification = local_agent_runtime_changed(pool, agent_type).await;
    require_active_acp_to_be_npm_managed(agent_type).await?;
    require_verified_local_agent_runtime(agent_type, &verification).map(|_| ())
}

async fn install_missing_acp_for_local_runtime_while_npm_locked(
    agent_type: AgentKind,
) -> Result<bool, AppError> {
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        return Ok(false);
    };
    if runtime.cli_program == runtime.acp_program {
        return Ok(false);
    }
    let cli = verify_local_cli_runtime(agent_type).await;
    require_verified_local_cli_runtime(agent_type, &cli, "install its ACP adapter")?;
    let adapter = verify_local_acp_runtime(agent_type).await;
    if adapter.executable.is_some() {
        return Ok(false);
    }
    if !npm_and_node_available().await {
        return Err(AppError::BadRequest(format!(
            "{} was installed, but Node.js/npm is unavailable for installing its ACP adapter. Open Settings → Agent and complete the prerequisite check.",
            runtime.cli_program
        )));
    }
    // Rechecks above happen *after* acquiring the global npm lock, so a
    // bootstrap install that completed while a user clicked "install CLI"
    // cannot cause a duplicate adapter installation.
    install_acp_adapter_while_npm_locked(agent_type).await?;
    Ok(true)
}

/// Reconcile local runtime dependencies at startup. An existing local CLI is
/// never replaced automatically; only its missing ACP bridge is installed.
/// When the CLI itself is absent, the caller receives it for a user-visible
/// Settings → Agent prompt instead of silently downloading an agent.
#[tauri::command]
pub async fn agent_bootstrap_installation(
    state: tauri::State<'_, AppState>,
) -> Result<AgentInstallationBootstrap, AppError> {
    agent_bootstrap_installation_inner(Some(&state.deployment.db().pool)).await
}

/// Startup has database access, so persist the actual adapter version before
/// warming catalogs. That makes a freshly installed/updated local ACP produce
/// a distinct catalog fingerprint instead of exposing a prior adapter's cache.
pub(crate) async fn agent_bootstrap_installation_for_startup(
    pool: &sqlx::SqlitePool,
) -> Result<AgentInstallationBootstrap, AppError> {
    agent_bootstrap_installation_inner(Some(pool)).await
}

async fn agent_bootstrap_installation_inner(
    pool: Option<&sqlx::SqlitePool>,
) -> Result<AgentInstallationBootstrap, AppError> {
    let mut result_slot = AGENT_BOOTSTRAP_RESULT
        .get_or_init(Default::default)
        .lock()
        .await;
    if let Some(result) = result_slot.as_ref() {
        return Ok(result.clone());
    }
    let mut result = AgentInstallationBootstrap {
        usable_agents: Vec::new(),
        installed_acp_agents: Vec::new(),
        failed_acp_agents: Vec::new(),
        incompatible_acp_agents: Vec::new(),
        incompatible_runtime_agents: Vec::new(),
        missing_runtime_agents: Vec::new(),
    };

    let local_runtimes = all_agent_types()
        .into_iter()
        .filter_map(|agent_type| {
            local_agent_runtime_spec(agent_type).map(|runtime| (agent_type, runtime))
        })
        .collect::<Vec<_>>();

    // CLI version probes touch only local executables and run concurrently;
    // an old CLI is not a valid basis for silently installing an ACP bridge.
    let cli_verifications = futures::future::join_all(
        local_runtimes
            .iter()
            .map(|(agent_type, _)| verify_local_cli_runtime(*agent_type)),
    )
    .await;

    let mut installed_runtimes = Vec::new();
    for ((agent_type, runtime), cli_verification) in
        local_runtimes.into_iter().zip(cli_verifications)
    {
        if cli_verification.is_supported() {
            installed_runtimes.push((agent_type, runtime));
        } else {
            if let Some(pool) = pool {
                let _ = AgentSetting::update_version(pool, agent_type.as_str(), None).await;
                let _ =
                    AgentSetting::update_runtime_identity(pool, agent_type.as_str(), None).await;
            }
            if cli_verification.executable.is_some() {
                result.incompatible_runtime_agents.push(agent_type);
            } else {
                result.missing_runtime_agents.push(agent_type);
            }
        }
    }

    // Version probes touch the local ACP executable only and each has a short
    // timeout. Run them together so having several installed agents does not
    // turn startup into N × probe-timeout.
    let acp_verifications = futures::future::join_all(
        installed_runtimes
            .iter()
            .map(|(agent_type, _)| verify_local_acp_runtime(*agent_type)),
    )
    .await;

    for ((agent_type, runtime), verification) in
        installed_runtimes.into_iter().zip(acp_verifications)
    {
        let has_separate_acp_adapter = runtime.cli_program != runtime.acp_program;
        // The CLI was verified immediately above and remains in the
        // metadata-validated cache; pairing it here does not start another
        // version subprocess, but lets us persist one atomic catalog identity.
        let local_runtime_verification = LocalAgentRuntimeVerification {
            cli: verify_local_cli_runtime(agent_type).await,
            acp: verification,
        };
        persist_local_runtime_verification(pool, agent_type, &local_runtime_verification).await;

        match startup_install_action(
            true,
            local_runtime_verification.acp.startup_readiness(),
            has_separate_acp_adapter,
        ) {
            StartupInstallAction::InstallAcp => {
                // An npm shim without an executable `node` cannot install an
                // ACP bridge that VibeX will later launch through `env node`.
                // Fail fast into the Settings preflight instead of holding
                // startup for a doomed npm process.
                if !npm_and_node_available().await {
                    result.failed_acp_agents.push(agent_type);
                    continue;
                }
                match install_acp_adapter(agent_type).await {
                    Ok(()) => {
                        invalidate_local_acp_verification(agent_type);
                        let verification = verify_local_acp_runtime(agent_type).await;
                        let local_runtime_verification = LocalAgentRuntimeVerification {
                            cli: verify_local_cli_runtime(agent_type).await,
                            acp: verification,
                        };
                        persist_local_runtime_verification(
                            pool,
                            agent_type,
                            &local_runtime_verification,
                        )
                        .await;
                        if local_runtime_verification.is_supported() {
                            result.installed_acp_agents.push(agent_type);
                            result.usable_agents.push(agent_type);
                        } else {
                            result.incompatible_acp_agents.push(agent_type);
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            ?agent_type,
                            %error,
                            "startup ACP adapter installation failed"
                        );
                        result.failed_acp_agents.push(agent_type);
                    }
                }
            }
            StartupInstallAction::NeedsAcpUpdate => result.incompatible_acp_agents.push(agent_type),
            StartupInstallAction::NeedsRuntimeSetup => {
                result.missing_runtime_agents.push(agent_type)
            }
            StartupInstallAction::Ready => result.usable_agents.push(agent_type),
        }
    }

    *result_slot = Some(result.clone());
    Ok(result)
}

async fn persist_local_runtime_verification(
    pool: Option<&sqlx::SqlitePool>,
    agent_type: AgentKind,
    verification: &LocalAgentRuntimeVerification,
) {
    let Some(pool) = pool else {
        return;
    };
    let _ = AgentSetting::update_version(
        pool,
        agent_type.as_str(),
        verification.acp.version.as_deref(),
    )
    .await;
    let persisted_identity = verification
        .catalog_identity()
        .as_ref()
        .map(catalog_identity_to_persisted);
    if let Err(error) = AgentSetting::update_runtime_identity(
        pool,
        agent_type.as_str(),
        persisted_identity.as_ref(),
    )
    .await
    {
        tracing::warn!(?agent_type, %error, "failed to persist local runtime identity");
    }
}

/// The only lifecycle hook used after VibeX changes a local Agent CLI or ACP
/// package. npm's launcher shim can keep the same mtime across package
/// updates, so cache-key comparison alone is insufficient here.
pub(crate) async fn local_agent_runtime_changed(
    pool: &sqlx::SqlitePool,
    agent_type: AgentKind,
) -> LocalAgentRuntimeVerification {
    // The startup result is a snapshot. Once Settings or maintenance changes
    // an executable, a later caller must reconcile against the new filesystem
    // state rather than receive the pre-install Toast decision.
    invalidate_agent_bootstrap_result().await;
    invalidate_local_cli_verification(agent_type);
    invalidate_local_acp_verification(agent_type);
    crate::commands::agents::invalidate_capability_probe(agent_type);
    let verification = verify_local_agent_runtime(agent_type).await;
    persist_local_runtime_verification(Some(pool), agent_type, &verification).await;
    verification
}

#[cfg(windows)]
fn node_installer_program() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn node_installer_program() -> &'static str {
    "npm"
}

async fn resolve_program_on_path(program: &str) -> Result<PathBuf, AppError> {
    utils::shell::resolve_executable_path(program)
        .await
        .ok_or_else(|| AppError::Internal(format!("{program} not found in PATH")))
}

async fn npm_and_node_available() -> bool {
    resolve_program_on_path(node_installer_program())
        .await
        .is_ok()
        && probe_command_output("node", &["--version"]).await.is_some()
}

async fn npm_global_root_path() -> Result<PathBuf, AppError> {
    let npm = resolve_program_on_path(node_installer_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(&npm, ["root", "-g"]);
    command.kill_on_drop(true);
    let output = timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| AppError::Internal("Timed out locating npm global root".to_string()))?
        .map_err(|error| {
            AppError::Internal(format!("Failed to locate npm global root: {error}"))
        })?;
    if !output.status.success() {
        return Err(AppError::Internal(
            utils::process::command_output_detail(&output)
                .map(|detail| format!("npm could not locate its global root: {detail}"))
                .unwrap_or_else(|| "npm could not locate its global root".to_string()),
        ));
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err(AppError::Internal(
            "npm returned an empty global root".to_string(),
        ));
    }
    Ok(PathBuf::from(root))
}

fn canonical_path_or_self(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn global_npm_bin_dir(npm_root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // `%APPDATA%\\npm\\node_modules` → `%APPDATA%\\npm`
        npm_root.parent().map(Path::to_path_buf)
    }
    #[cfg(not(windows))]
    {
        // `<prefix>/lib/node_modules` → `<prefix>/bin`
        npm_root
            .parent()
            .and_then(Path::parent)
            .map(|prefix| prefix.join("bin"))
    }
}

fn global_npm_executable_name(program: &str) -> String {
    #[cfg(windows)]
    {
        format!("{program}.cmd")
    }
    #[cfg(not(windows))]
    {
        program.to_string()
    }
}

fn package_declares_program(package_dir: &Path, program: &str) -> bool {
    let manifest = package_dir.join("package.json");
    let Ok(content) = std::fs::read_to_string(manifest) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    match manifest.get("bin") {
        Some(serde_json::Value::Object(binaries)) => binaries.contains_key(program),
        Some(serde_json::Value::String(_)) => manifest
            .get("name")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|name| name.rsplit('/').next().is_some_and(|name| name == program)),
        _ => false,
    }
}

/// Whether the executable currently selected by PATH is the global npm shim
/// (or its resolved package target) for this exact package. This prevents an
/// in-app update from installing a second copy while VibeX continues to launch
/// a Homebrew/standalone binary earlier on PATH.
fn active_executable_is_owned_by_global_npm_package(
    executable: &Path,
    npm_root: &Path,
    package: &str,
    program: &str,
) -> bool {
    let package_dir = npm_global_package_dir(&npm_root.display().to_string(), package);
    let canonical_executable = canonical_path_or_self(executable);
    let canonical_package_dir = canonical_path_or_self(&package_dir);
    if canonical_executable.starts_with(&canonical_package_dir) {
        return true;
    }

    let Some(bin_dir) = global_npm_bin_dir(npm_root) else {
        return false;
    };
    let expected_shim = bin_dir.join(global_npm_executable_name(program));
    canonical_executable == canonical_path_or_self(&expected_shim)
        && package_declares_program(&package_dir, program)
}

async fn require_active_program_to_be_npm_managed(
    agent_type: AgentKind,
    component: &str,
    program: &str,
    package: &str,
) -> Result<(), AppError> {
    let Some(executable) = utils::shell::resolve_executable_path(program).await else {
        // A fresh install is allowed to create the first active executable.
        return Ok(());
    };
    let npm_root = npm_global_root_path().await?;
    if active_executable_is_owned_by_global_npm_package(&executable, &npm_root, package, program) {
        return Ok(());
    }

    Err(AppError::BadRequest(format!(
        "VibeX will not update {} for {} at {} because it is not the active executable installed from npm global package {}. Update that runtime with its own installer, or place VibeX's npm-managed executable first on PATH.",
        component,
        registry_entry(agent_type).name,
        executable.display(),
        npm_package_name(package),
    )))
}

pub(crate) async fn require_active_cli_to_be_npm_managed(
    agent_type: AgentKind,
) -> Result<(), AppError> {
    let spec = cli_spec_for_agent(agent_type).ok_or_else(|| {
        AppError::BadRequest(format!("{agent_type} has no npm-managed local CLI"))
    })?;
    require_active_program_to_be_npm_managed(
        agent_type,
        "Agent CLI runtime",
        spec.command,
        spec.npm_package,
    )
    .await
}

pub(crate) async fn require_active_acp_to_be_npm_managed(
    agent_type: AgentKind,
) -> Result<(), AppError> {
    let runtime = local_agent_runtime_spec(agent_type)
        .ok_or_else(|| AppError::BadRequest(format!("{agent_type} has no local ACP runtime")))?;
    let entry = registry_entry(agent_type);
    let package = npm_package_for_entry(&entry).ok_or_else(|| {
        AppError::BadRequest(format!("{agent_type} ACP adapter is not npm-managed"))
    })?;
    require_active_program_to_be_npm_managed(
        agent_type,
        "ACP adapter",
        runtime.acp_program,
        &package,
    )
    .await
}

/// Verify the CLI which ACP will delegate to. For agents without a declared
/// compatibility floor, a resolvable executable remains usable even if that
/// CLI does not expose a machine-readable `--version`; Codex/Claude/OpenCode
/// have floors and therefore require a verified version.
pub(crate) async fn verify_local_cli_runtime(agent_type: AgentKind) -> LocalCliVerification {
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        return LocalCliVerification {
            executable: None,
            version: None,
            minimum_supported_version: None,
            probe_error: Some("No local Agent runtime is defined for this agent.".to_string()),
        };
    };
    let minimum_supported_version = runtime.cli_minimum_supported_version.map(str::to_string);
    let executable = match resolve_program_on_path(runtime.cli_program).await {
        Ok(executable) => executable,
        Err(error) => {
            return LocalCliVerification {
                executable: None,
                version: None,
                minimum_supported_version,
                probe_error: Some(error.to_string()),
            };
        }
    };
    let cache_key = local_acp_cache_key(&executable);
    if let Some(cache_key) = cache_key.as_ref()
        && let Some(cached) = LOCAL_CLI_VERIFICATION_CACHE
            .get_or_init(Default::default)
            .lock()
            .expect("local CLI verification cache lock")
            .get(&agent_type)
            .filter(|cached| cached.key == *cache_key)
            .cloned()
    {
        return cached.verification;
    }

    let (version, probe_error) =
        match detect_local_cli_version(&executable, Duration::from_secs(5)).await {
            Ok(version) => (version, None),
            Err(error) => (None, Some(error.to_string())),
        };
    let verification = LocalCliVerification {
        executable: Some(executable),
        version,
        minimum_supported_version,
        probe_error,
    };
    if let Some(cache_key) = cache_key {
        LOCAL_CLI_VERIFICATION_CACHE
            .get_or_init(Default::default)
            .lock()
            .expect("local CLI verification cache lock")
            .insert(
                agent_type,
                CachedLocalCliVerification {
                    key: cache_key,
                    verification: verification.clone(),
                },
            );
    }
    verification
}

pub(crate) fn invalidate_local_cli_verification(agent_type: AgentKind) {
    if let Some(cache) = LOCAL_CLI_VERIFICATION_CACHE.get() {
        cache
            .lock()
            .expect("local CLI verification cache lock")
            .remove(&agent_type);
    }
}

fn local_acp_cache_key(executable: &PathBuf) -> Option<LocalAcpCacheKey> {
    let metadata = std::fs::metadata(executable).ok()?;
    Some(LocalAcpCacheKey {
        executable: executable.clone(),
        modified: metadata.modified().ok()?,
        length: metadata.len(),
    })
}

/// Verify the ACP command VibeX will actually execute from PATH. Results are
/// cached only while that executable's path and file metadata remain stable;
/// normal in-app install/update flows explicitly invalidate the cache.
pub(crate) async fn verify_local_acp_runtime(agent_type: AgentKind) -> LocalAcpVerification {
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        return LocalAcpVerification {
            executable: None,
            version: None,
            minimum_supported_version: None,
            probe_error: Some("No local ACP runtime is defined for this agent.".to_string()),
        };
    };
    let minimum_supported_version = minimum_supported_acp_version(agent_type);
    let executable = match resolve_program_on_path(runtime.acp_program).await {
        Ok(executable) => executable,
        Err(error) => {
            return LocalAcpVerification {
                executable: None,
                version: None,
                minimum_supported_version,
                probe_error: Some(error.to_string()),
            };
        }
    };
    let cache_key = local_acp_cache_key(&executable);
    if let Some(cache_key) = cache_key.as_ref()
        && let Some(cached) = LOCAL_ACP_VERIFICATION_CACHE
            .get_or_init(Default::default)
            .lock()
            .expect("local ACP verification cache lock")
            .get(&agent_type)
            .filter(|cached| cached.key == *cache_key)
            .cloned()
    {
        return cached.verification;
    }

    let (version, probe_error) =
        match detect_local_acp_version(agent_type, &executable, Duration::from_secs(5)).await {
            Ok(version) => (version, None),
            Err(error) => (None, Some(error.to_string())),
        };
    let verification = LocalAcpVerification {
        executable: Some(executable),
        version,
        minimum_supported_version,
        probe_error,
    };
    if let Some(cache_key) = cache_key {
        LOCAL_ACP_VERIFICATION_CACHE
            .get_or_init(Default::default)
            .lock()
            .expect("local ACP verification cache lock")
            .insert(
                agent_type,
                CachedLocalAcpVerification {
                    key: cache_key,
                    verification: verification.clone(),
                },
            );
    }
    verification
}

pub(crate) fn invalidate_local_acp_verification(agent_type: AgentKind) {
    if let Some(cache) = LOCAL_ACP_VERIFICATION_CACHE.get() {
        cache
            .lock()
            .expect("local ACP verification cache lock")
            .remove(&agent_type);
    }
}

/// Revalidate both parts of the launch pair concurrently. Callers that just
/// changed a package must invalidate the two caches first; normal callers can
/// reuse a metadata-validated result without paying for two subprocesses.
pub(crate) async fn verify_local_agent_runtime(
    agent_type: AgentKind,
) -> LocalAgentRuntimeVerification {
    let (cli, acp) = tokio::join!(
        verify_local_cli_runtime(agent_type),
        verify_local_acp_runtime(agent_type)
    );
    LocalAgentRuntimeVerification { cli, acp }
}

/// Return a previously verified, catalog-safe local runtime identity without
/// spawning a process. The full lightweight revision is checked again so a
/// replaced launcher shim or npm package target cannot continue to fingerprint
/// a capability catalog as valid.
pub(crate) fn cached_verified_local_agent_runtime_identity(
    agent_type: AgentKind,
) -> Option<LocalAgentRuntimeCatalogIdentity> {
    let cli = LOCAL_CLI_VERIFICATION_CACHE
        .get()?
        .lock()
        .expect("local CLI verification cache lock")
        .get(&agent_type)
        .cloned()?;
    let acp = LOCAL_ACP_VERIFICATION_CACHE
        .get()?
        .lock()
        .expect("local ACP verification cache lock")
        .get(&agent_type)
        .cloned()?;

    if local_acp_cache_key(&cli.key.executable).as_ref() != Some(&cli.key)
        || local_acp_cache_key(&acp.key.executable).as_ref() != Some(&acp.key)
    {
        return None;
    }

    LocalAgentRuntimeVerification {
        cli: cli.verification,
        acp: acp.verification,
    }
    .catalog_identity()
}

fn local_runtime_component_diagnostic(
    label: &str,
    command: &str,
    executable: Option<&PathBuf>,
    version: Option<&str>,
    minimum_supported_version: Option<&str>,
    probe_error: Option<&str>,
) -> String {
    let mut detail = match executable {
        None => format!("{label} command `{command}` was not found on PATH"),
        Some(path) => match version {
            Some(version)
                if minimum_supported_version
                    .is_some_and(|minimum| !version_at_least(version, minimum)) =>
            {
                format!(
                    "{label} at {} is version {version}; minimum supported version is {}",
                    path.display(),
                    minimum_supported_version.expect("minimum was checked")
                )
            }
            Some(version) => format!("{label} at {} reported version {version}", path.display()),
            None => format!(
                "{label} at {} did not report a usable version",
                path.display()
            ),
        },
    };
    if let Some(error) = probe_error.filter(|error| !error.trim().is_empty()) {
        detail.push_str(&format!(" ({error})"));
    }
    detail.push('.');
    detail
}

/// Turn an installation's post-command verification into an actionable error.
/// This is intentionally shared by the Settings repair and system maintenance
/// flows so neither can report a package install as success when the active
/// executable pair is still missing, old, or shadowed on PATH.
pub(crate) fn require_verified_local_agent_runtime(
    agent_type: AgentKind,
    verification: &LocalAgentRuntimeVerification,
) -> Result<LocalAgentRuntimeIdentity, AppError> {
    if let Some(identity) = verification.identity() {
        return Ok(identity);
    }

    let runtime = local_agent_runtime_spec(agent_type);
    let cli_command = runtime.map_or_else(
        || agent_type.as_str().to_string(),
        |runtime| runtime.cli_program.to_string(),
    );
    let acp_command = local_acp_command_parts(agent_type)
        .map(|parts| {
            std::iter::once(parts.program)
                .chain(parts.args)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| agent_type.as_str().to_string());
    let agent_name = registry_entry(agent_type)
        .name
        .strip_suffix(" CLI")
        .unwrap_or(&registry_entry(agent_type).name)
        .to_string();
    let mut diagnostics = Vec::new();
    if !verification.cli.is_supported() {
        diagnostics.push(local_runtime_component_diagnostic(
            &format!("{agent_name} CLI"),
            &cli_command,
            verification.cli.executable.as_ref(),
            verification.cli.version.as_deref(),
            verification.cli.minimum_supported_version.as_deref(),
            verification.cli.probe_error.as_deref(),
        ));
    }
    if !verification.acp.is_supported() {
        diagnostics.push(local_runtime_component_diagnostic(
            &format!("{agent_name} ACP"),
            &acp_command,
            verification.acp.executable.as_ref(),
            verification.acp.version.as_deref(),
            verification.acp.minimum_supported_version.as_deref(),
            verification.acp.probe_error.as_deref(),
        ));
    }

    Err(AppError::Internal(format!(
        "{} was installed but VibeX cannot use its active local runtime. {} Open Settings → Agent and run Preflight for the exact path/version diagnostic.",
        agent_name,
        diagnostics.join(" ")
    )))
}

fn require_verified_local_cli_runtime(
    agent_type: AgentKind,
    verification: &LocalCliVerification,
    operation: &str,
) -> Result<(), AppError> {
    if verification.is_supported() {
        return Ok(());
    }
    let runtime = local_agent_runtime_spec(agent_type);
    let command = runtime.map_or_else(
        || agent_type.as_str().to_string(),
        |runtime| runtime.cli_program.to_string(),
    );
    let entry = registry_entry(agent_type);
    let agent_name = entry.name.strip_suffix(" CLI").unwrap_or(&entry.name);
    Err(AppError::BadRequest(format!(
        "VibeX cannot {operation} for {agent_name} until its local Agent CLI is verified. {} Open Settings → Agent and install or update the CLI first.",
        local_runtime_component_diagnostic(
            &format!("{agent_name} CLI"),
            &command,
            verification.executable.as_ref(),
            verification.version.as_deref(),
            verification.minimum_supported_version.as_deref(),
            verification.probe_error.as_deref(),
        )
    )))
}

async fn detect_local_acp_version(
    agent_type: AgentKind,
    executable: &PathBuf,
    timeout_duration: Duration,
) -> Result<Option<String>, AppError> {
    let Some(arg_strings) = local_acp_version_args(agent_type) else {
        return Ok(None);
    };
    let mut command = utils::process::new_hidden_tokio_command(executable, &arg_strings);
    command.kill_on_drop(true);
    let output = match timeout(timeout_duration, command.output()).await {
        Ok(output) => output.map_err(|error| {
            AppError::Internal(format!(
                "Failed to run local ACP version command for {agent_type}: {error}"
            ))
        })?,
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!stdout.is_empty()).then_some(stdout))
}

async fn detect_local_cli_version(
    executable: &PathBuf,
    timeout_duration: Duration,
) -> Result<Option<String>, AppError> {
    let mut command = utils::process::new_hidden_tokio_command(executable, ["--version"]);
    command.kill_on_drop(true);
    let output = match timeout(timeout_duration, command.output()).await {
        Ok(output) => output.map_err(|error| {
            AppError::Internal(format!(
                "Failed to run local Agent CLI version command at {}: {error}",
                executable.display()
            ))
        })?,
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!stdout.is_empty()).then_some(stdout))
}

async fn detect_agent_version_inner(
    entry: &AgentRegistryEntry,
    executable: &PathBuf,
) -> Result<Option<String>, AppError> {
    if local_acp_command_parts(entry.agent_type).is_some() {
        return detect_local_acp_version(entry.agent_type, executable, Duration::from_secs(15))
            .await;
    }

    let arg_strings = version_args_for_entry(entry);
    let mut command = utils::process::new_hidden_tokio_command(executable, &arg_strings);
    // Some ACP adapters (notably the npx Claude adapter) do not exit on an
    // unknown `--version` flag and instead wait on stdin, which would hang
    // preflight forever. Bound the probe and kill the child if it overruns.
    command.kill_on_drop(true);
    let output = match timeout(Duration::from_secs(15), command.output()).await {
        Ok(result) => result.map_err(|e| {
            AppError::Internal(format!(
                "Failed to run ACP version command for {:?}: {}",
                entry.agent_type, e
            ))
        })?,
        // Legacy npx-only entries retain the metadata fallback.
        Err(_) => return detect_global_npm_package_version(entry).await,
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(Some(stdout));
        }
    }

    if let Some(version) = detect_global_npm_package_version(entry).await? {
        return Ok(Some(version));
    }

    Ok(None)
}

/// Ask the actual local ACP command for its version. For same-binary runtimes
/// this must retain the ACP subcommand (for example `opencode acp --version`)
/// rather than checking only the parent CLI.
fn local_acp_version_args(agent_type: AgentKind) -> Option<Vec<String>> {
    let parts = local_acp_command_parts(agent_type)?;
    let mut args = parts.args;
    args.push("--version".to_string());
    Some(args)
}

fn version_args_for_entry(entry: &AgentRegistryEntry) -> Vec<String> {
    match &entry.distribution {
        AgentDistribution::Npx { package, cmd, .. } => {
            let mut args = vec!["-y".to_string(), package.clone()];
            if !cmd.trim().is_empty() {
                args.push(cmd.clone());
            }
            args.push("--version".to_string());
            args
        }
        AgentDistribution::Uvx { package, cmd, .. } => vec![
            "--from".to_string(),
            package.clone(),
            cmd.clone(),
            "--version".to_string(),
        ],
        AgentDistribution::Binary { .. } | AgentDistribution::System { .. } => {
            vec!["--version".to_string()]
        }
    }
}

async fn detect_global_npm_package_version(
    entry: &AgentRegistryEntry,
) -> Result<Option<String>, AppError> {
    let Some(package_name) = npm_package_for_entry(entry) else {
        return Ok(None);
    };
    detect_global_npm_package_version_by_name(&package_name).await
}

async fn detect_global_npm_package_version_by_name(
    package_name: &str,
) -> Result<Option<String>, AppError> {
    let npm = resolve_program_on_path(node_installer_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(&npm, ["root", "-g"]);
    let output = command.output().await.map_err(|e| {
        AppError::Internal(format!(
            "Failed to locate npm global root while checking {package_name}: {e}"
        ))
    })?;

    if !output.status.success() {
        return Ok(None);
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Ok(None);
    }

    let package_name = npm_package_name(package_name);
    let package_path = package_name
        .split('/')
        .fold(PathBuf::from(root), |path, segment| path.join(segment))
        .join("package.json");
    let content = match tokio::fs::read_to_string(&package_path).await {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Invalid package metadata: {e}")))?;

    Ok(value
        .get("version")
        .and_then(|value| value.as_str())
        .map(|version| version.to_string()))
}

async fn detect_cli_version(spec: AgentCliSpec) -> Result<Option<String>, AppError> {
    let executable = match resolve_program_on_path(spec.command).await {
        Ok(executable) => executable,
        Err(_) => return Ok(None),
    };
    let mut command = utils::process::new_hidden_tokio_command(&executable, ["--version"]);
    command.kill_on_drop(true);
    let output = match timeout(Duration::from_secs(10), command.output()).await {
        Ok(output) => output.map_err(|error| {
            AppError::Internal(format!("Failed to run {} --version: {error}", spec.command))
        })?,
        Err(_) => return Ok(None),
    };
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !version.is_empty() {
            return Ok(Some(version));
        }
    }
    Ok(None)
}

async fn latest_npm_package_version(package: &str) -> Result<Option<String>, AppError> {
    let npm = resolve_program_on_path(node_installer_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(&npm, ["view", package, "version"]);
    command.kill_on_drop(true);
    let output = timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| AppError::Internal(format!("Timed out checking latest {package} version")))?
        .map_err(|error| {
            AppError::Internal(format!("Failed to check latest {package} version: {error}"))
        })?;
    if !output.status.success() {
        return Err(AppError::Internal(format!(
            "npm could not determine the latest {package} version"
        )));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!version.is_empty()).then_some(version))
}

fn cli_update_command_for_agent(agent_type: &str) -> Option<(String, Vec<String>)> {
    let spec = cli_spec_for_agent(parse_agent_type_key(agent_type).ok()?)?;
    Some((
        node_installer_program().to_string(),
        vec![
            "install".to_string(),
            "-g".to_string(),
            format!("{}@latest", spec.npm_package),
        ],
    ))
}

fn auth_probe(agent_type: AgentKind) -> (bool, Option<String>) {
    let auth_path = match agent_type {
        AgentKind::ClaudeCode => claude_config_path(),
        AgentKind::Codex => codex_auth_path(),
        AgentKind::Opencode => opencode_auth_path(),
        AgentKind::Gemini
        | AgentKind::Openclaw
        | AgentKind::Cline
        | AgentKind::Hermes
        | AgentKind::QaMock => None,
    };

    if let Some(path) = auth_path {
        let found = path.exists();
        return (
            found,
            Some(if found {
                format!("Authentication marker found at {}.", path.display())
            } else {
                format!("Authentication marker was not found at {}.", path.display())
            }),
        );
    }

    let availability = agent_availability(agent_type);
    match availability {
        AgentAvailabilityInfo::LoginDetected {
            last_auth_timestamp,
        } => (
            true,
            Some(format!(
                "Authentication marker detected at Unix timestamp {last_auth_timestamp}."
            )),
        ),
        AgentAvailabilityInfo::InstallationFound => (
            false,
            Some("Installation was found, but authentication was not detected.".to_string()),
        ),
        AgentAvailabilityInfo::NotFound => (
            false,
            Some("No authentication marker is known for this agent.".to_string()),
        ),
    }
}

async fn network_probe(distribution: &AgentDistribution) -> Option<bool> {
    let endpoint = match distribution {
        AgentDistribution::Npx { .. } => "registry.npmjs.org:443",
        AgentDistribution::Binary { .. } => "github.com:443",
        AgentDistribution::Uvx { .. } => "pypi.org:443",
        AgentDistribution::System { .. } => return None,
    };

    Some(matches!(
        timeout(Duration::from_secs(2), TcpStream::connect(endpoint)).await,
        Ok(Ok(_))
    ))
}

fn preflight_report_to_api(report: AgentPreflightReport) -> PreflightResult {
    PreflightResult {
        checks: report
            .checks
            .into_iter()
            .map(|check| PreflightCheck {
                check_id: check.check_id,
                label: check.label,
                status: preflight_status_to_api(check.status),
                message: check.message,
                fixes: check
                    .fixes
                    .into_iter()
                    .map(|fix| PreflightFix {
                        action: fix.action_key(),
                        label: fix.label().to_string(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn preflight_status_to_api(status: AgentPreflightCheckStatus) -> PreflightStatus {
    match status {
        AgentPreflightCheckStatus::Pass => PreflightStatus::Pass,
        AgentPreflightCheckStatus::Warn => PreflightStatus::Warn,
        AgentPreflightCheckStatus::Fail => PreflightStatus::Fail,
    }
}

#[tauri::command]
pub async fn agent_preflight(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<PreflightResult, AppError> {
    // Preflight is an explicit user action, so it is the safe place to pick
    // up a CLI the user installed outside VibeX after this process started.
    // Normal picker/startup resolution deliberately uses the one-shot cache
    // to avoid repeatedly spawning login shells for absent commands.
    let _ = utils::shell::refresh_process_path_after_install().await;
    let entry = entry_for_agent_key(&agent_type)?;
    // Preflight is the explicit boundary for a CLI changed outside VibeX.
    // Invalidate both launch caches, persist the actual bridge version, and
    // invalidate any catalog fingerprint before rendering the diagnostics.
    let local_runtime_verification = if local_agent_runtime_spec(entry.agent_type).is_some() {
        Some(local_agent_runtime_changed(&state.deployment.db().pool, entry.agent_type).await)
    } else {
        None
    };
    let (runtime_program, runtime_path, runtime_lookup_error) =
        if let Some(verification) = local_runtime_verification.as_ref() {
            let parts = local_acp_command_parts(entry.agent_type)
                .expect("local runtime verification must have ACP command parts");
            (
                Some(parts.program),
                verification.acp.executable.clone(),
                verification.acp.probe_error.clone(),
            )
        } else {
            match command_parts_for_entry(&entry) {
                Ok(parts) => {
                    let program = parts.program;
                    match resolve_program_on_path(&program).await {
                        Ok(path) => (Some(program), Some(path), None),
                        Err(error) => (Some(program), None, Some(error.to_string())),
                    }
                }
                Err(error) => (None, None, Some(error)),
            }
        };

    let (adapter_version, adapter_version_error) = if let Some(verification) =
        local_runtime_verification.as_ref()
    {
        (
            verification.acp.version.clone(),
            verification.acp.probe_error.clone(),
        )
    } else {
        match runtime_path.as_ref() {
            Some(executable) => match detect_agent_version_inner(&entry, executable).await {
                Ok(Some(version)) if !version.trim().is_empty() => {
                    let pool = &state.deployment.db().pool;
                    let _ = AgentSetting::update_version(
                        pool,
                        entry.agent_type.as_str(),
                        Some(version.as_str()),
                    )
                    .await;
                    (Some(version), None)
                }
                Ok(_) => (None, None),
                Err(error) => (None, Some(error.to_string())),
            },
            None => {
                let pool = &state.deployment.db().pool;
                let _ = AgentSetting::update_version(pool, entry.agent_type.as_str(), None).await;
                (None, None)
            }
        }
    };
    let adapter_runtime_path = runtime_path.as_ref().map(|path| path.display().to_string());
    let network_available = network_probe(&entry.distribution).await;
    let (cli_package, cli_path, cli_version, cli_latest_version, cli_version_error) =
        if let Some(spec) = cli_spec_for_agent(entry.agent_type) {
            let (cli_path, cli_version, local_cli_error) =
                if let Some(verification) = local_runtime_verification.as_ref() {
                    (
                        verification
                            .cli
                            .executable
                            .as_ref()
                            .map(|path| path.display().to_string()),
                        verification.cli.version.clone(),
                        verification.cli.probe_error.clone(),
                    )
                } else {
                    let cli_path = resolve_program_on_path(spec.command)
                        .await
                        .ok()
                        .map(|path| path.display().to_string());
                    let installed_result = detect_cli_version(spec).await;
                    let local_cli_error = installed_result.as_ref().err().map(ToString::to_string);
                    (cli_path, installed_result.ok().flatten(), local_cli_error)
                };
            let latest_result = if network_available == Some(true) {
                latest_npm_package_version(spec.npm_package).await
            } else {
                Ok(None)
            };
            let cli_version_error =
                local_cli_error.or_else(|| latest_result.as_ref().err().map(ToString::to_string));
            (
                Some(spec.npm_package.to_string()),
                cli_path,
                cli_version,
                latest_result.ok().flatten(),
                cli_version_error,
            )
        } else {
            (None, None, None, None, None)
        };
    let (auth_found, auth_hint) = auth_probe(entry.agent_type);
    let adapter_minimum_version = minimum_supported_acp_version(entry.agent_type);
    // Check package-manager prerequisites independently from the ACP
    // executable. A missing adapter must not be misreported as a missing npm
    // installation (or produce a second, incorrect install action).
    let npm_available = if matches!(entry.distribution, AgentDistribution::Npx { .. }) {
        Some(
            resolve_program_on_path(node_installer_program())
                .await
                .is_ok(),
        )
    } else {
        None
    };
    let node_version = if npm_available == Some(true) {
        probe_command_output("node", &["--version"]).await
    } else {
        None
    };
    let uv_available = if matches!(entry.distribution, AgentDistribution::Uvx { .. }) {
        Some(resolve_program_on_path("uv").await.is_ok())
    } else {
        None
    };
    let uv_version = if uv_available == Some(true) {
        probe_command_output("uv", &["--version"]).await
    } else {
        None
    };
    let report = build_preflight_report(AgentPreflightProbe {
        entry,
        platform: current_platform(),
        runtime_program,
        runtime_path: adapter_runtime_path.clone(),
        runtime_lookup_error,
        adapter_version: adapter_version.map(|version| {
            adapter_runtime_path
                .as_ref()
                .map(|path| format!("{version} - Runtime: {path}"))
                .unwrap_or(version)
        }),
        adapter_version_error,
        adapter_minimum_version,
        cli_package,
        cli_path,
        cli_version,
        cli_latest_version,
        cli_version_error,
        npm_available,
        node_version,
        uv_available,
        uv_version,
        auth_found,
        auth_hint,
        network_available,
    });

    Ok(preflight_report_to_api(report))
}

#[tauri::command]
pub async fn detect_agent_local_version(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<Option<String>, AppError> {
    let entry = entry_for_agent_key(&agent_type)?;
    if local_agent_runtime_spec(entry.agent_type).is_some() {
        // This legacy version endpoint is still used by some Settings flows.
        // Treat it as an explicit local-runtime observation so it cannot leave
        // an older persisted catalog identity behind after an external update.
        let verification =
            local_agent_runtime_changed(&state.deployment.db().pool, entry.agent_type).await;
        return Ok(verification.acp.version);
    }
    let program = match command_parts_for_entry(&entry) {
        Ok(parts) => parts.program,
        Err(_) => return Ok(None),
    };

    let executable = match resolve_program_on_path(&program).await {
        Ok(path) => path,
        Err(_) => {
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, entry.agent_type.as_str(), None).await;
            return Ok(None);
        }
    };

    let version = detect_agent_version_inner(&entry, &executable).await?;
    let pool = &state.deployment.db().pool;
    let _ = AgentSetting::update_version(pool, entry.agent_type.as_str(), version.as_deref()).await;
    Ok(version)
}

#[tauri::command]
pub async fn run_agent_fix(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    action: String,
) -> Result<(), AppError> {
    let agent_kind = parse_agent_type_key(&agent_type)?;
    let cli_action = matches!(action.as_str(), "install_cli" | "upgrade_cli");
    let acp_action = matches!(action.as_str(), "install_npm" | "upgrade_npm");

    // This explicit mutation endpoint is also an external-install lifecycle
    // boundary. Never rely on an earlier picker/preflight cache when deciding
    // whether it is safe to update a local runtime or bridge.
    invalidate_local_cli_verification(agent_kind);
    invalidate_local_acp_verification(agent_kind);

    match action.as_str() {
        "install_npm" | "upgrade_npm" => {
            // An ACP bridge without the real local CLI can fall back to a
            // bundled dependency. Refuse this direct/legacy frontend call
            // rather than installing a bridge VibeX must never launch.
            let cli = verify_local_cli_runtime(agent_kind).await;
            require_verified_local_cli_runtime(
                agent_kind,
                &cli,
                "install or update its ACP adapter",
            )?;

            let acp = verify_local_acp_runtime(agent_kind).await;
            if action == "install_npm" && acp.is_supported() {
                // `install_cli` already installs a missing separate bridge.
                // Old frontends can still send a second `install_npm`; treat
                // that as a verified no-op rather than running npm twice.
                let verification =
                    local_agent_runtime_changed(&state.deployment.db().pool, agent_kind).await;
                return require_verified_local_agent_runtime(agent_kind, &verification).map(|_| ());
            }

            // Do not claim an npm update changed a Homebrew/standalone ACP
            // executable that wins PATH resolution over npm's global shim.
            require_active_acp_to_be_npm_managed(agent_kind).await?;
            let _npm_mutation = lock_global_npm_mutations().await;
            let (program, args) = install_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No install action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(&program).await?;
            let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
            command.kill_on_drop(true);
            let output = timeout(Duration::from_secs(120), command.output())
                .await
                .map_err(|_| {
                    AppError::Internal(format!("Install command timed out for {}", agent_type))
                })?
                .map_err(|e| {
                    AppError::Internal(format!(
                        "Failed to run install command for {}: {}",
                        agent_type, e
                    ))
                })?;

            if !output.status.success() {
                return Err(AppError::Internal(
                    utils::process::command_output_detail(&output)
                        .map(|detail| {
                            format!("Install command failed for {}: {}", agent_type, detail)
                        })
                        .unwrap_or_else(|| format!("Install command failed for {}", agent_type)),
                ));
            }
            let _ = utils::shell::refresh_process_path_after_install().await;
        }
        "install_cli" | "upgrade_cli" => {
            // A package-manager update must target the executable VibeX will
            // actually launch. If another installer owns the active CLI, a
            // successful npm command would be a misleading no-op.
            require_active_cli_to_be_npm_managed(agent_kind).await?;
            let _npm_mutation = lock_global_npm_mutations().await;
            let (program, args) = cli_update_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No CLI install action available for {agent_type}"))
            })?;
            let executable = resolve_program_on_path(&program).await?;
            let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
            command.kill_on_drop(true);
            let output = timeout(Duration::from_secs(120), command.output())
                .await
                .map_err(|_| AppError::Internal(format!("CLI install timed out for {agent_type}")))?
                .map_err(|error| {
                    AppError::Internal(format!("Failed to install CLI for {agent_type}: {error}"))
                })?;
            if !output.status.success() {
                return Err(AppError::Internal(
                    utils::process::command_output_detail(&output)
                        .map(|detail| format!("CLI install failed for {agent_type}: {detail}"))
                        .unwrap_or_else(|| format!("CLI install failed for {agent_type}")),
                ));
            }
            let _ = utils::shell::refresh_process_path_after_install().await;
        }
        "uninstall_npm" => {
            let _npm_mutation = lock_global_npm_mutations().await;
            let (program, args) = uninstall_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No uninstall action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(&program).await?;
            let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
            let output = command.output().await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run uninstall command for {}: {}",
                    agent_type, e
                ))
            })?;

            if !output.status.success() {
                return Err(AppError::Internal(
                    utils::process::command_output_detail(&output)
                        .map(|detail| {
                            format!("Uninstall command failed for {}: {}", agent_type, detail)
                        })
                        .unwrap_or_else(|| format!("Uninstall command failed for {}", agent_type)),
                ));
            }
        }
        _ => {
            return Err(AppError::Internal(format!(
                "Unsupported agent fix action: {}",
                action
            )));
        }
    }

    if action == "uninstall_npm" {
        let _ = utils::shell::refresh_process_path_after_install().await;
        let _ = local_agent_runtime_changed(&state.deployment.db().pool, agent_kind).await;
        return Ok(());
    }

    let pool = &state.deployment.db().pool;
    let post_package_verification = local_agent_runtime_changed(pool, agent_kind).await;
    if cli_action {
        require_active_cli_to_be_npm_managed(agent_kind).await?;
        require_verified_local_cli_runtime(
            agent_kind,
            &post_package_verification.cli,
            "finish installing its ACP adapter",
        )?;
        install_missing_acp_for_local_runtime(&state.deployment.db().pool, agent_kind).await?;
    }

    if acp_action {
        require_active_acp_to_be_npm_managed(agent_kind).await?;
    }
    let final_verification = local_agent_runtime_changed(pool, agent_kind).await;
    require_verified_local_agent_runtime(agent_kind, &final_verification).map(|_| ())
}

/// The interactive login arguments for an agent's own CLI, if it has them.
/// The executable itself is always supplied by a successful local runtime
/// verification; never re-resolve a bare command name in the visible terminal.
fn login_args_for_agent(agent_type: AgentKind) -> Option<&'static [&'static str]> {
    match agent_type {
        AgentKind::Codex => Some(&["login"]),
        _ => None,
    }
}

#[cfg(not(windows))]
fn quote_terminal_command_argument(value: &str) -> String {
    // POSIX single quotes make an absolute local CLI path inert even when a
    // user installed it under a directory containing whitespace or shell
    // metacharacters. The standard `'"'"'` sequence represents a literal
    // single quote inside a single-quoted shell word.
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn quote_terminal_command_argument(value: &str) -> String {
    // `cmd /K` still expands `%VAR%` inside double quotes. Escape cmd's
    // metacharacters and disable delayed expansion in the caller so an
    // executable path cannot change the command that follows it.
    let escaped = value
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>")
        .replace('(', "^(")
        .replace(')', "^)")
        .replace('%', "%%")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn local_cli_login_command(agent_type: AgentKind, cli_path: &Path) -> Result<String, AppError> {
    let args = login_args_for_agent(agent_type).ok_or_else(|| {
        AppError::BadRequest(format!("{agent_type} does not support in-app login"))
    })?;
    if !cli_path.is_absolute() {
        return Err(AppError::Internal(format!(
            "Verified local CLI path for {agent_type} was not absolute: {}",
            cli_path.display()
        )));
    }
    let cli_path = cli_path.to_str().ok_or_else(|| {
        AppError::Internal(format!(
            "Verified local CLI path for {agent_type} is not valid UTF-8: {}",
            cli_path.display()
        ))
    })?;
    let mut command = quote_terminal_command_argument(cli_path);
    for arg in args {
        command.push(' ');
        command.push_str(&quote_terminal_command_argument(arg));
    }
    Ok(command)
}

/// Open the agent's interactive login command in a visible OS terminal so the
/// user can complete the (browser/device-code) auth flow. The CLI writes its
/// own credentials (e.g. `~/.codex/auth.json`) which VibeX then detects.
#[tauri::command]
pub async fn open_agent_login_terminal(agent_type: String) -> Result<(), AppError> {
    let agent = parse_agent_type_key(&agent_type)?;
    if login_args_for_agent(agent).is_none() {
        return Err(AppError::BadRequest(format!(
            "{agent_type} does not support in-app login"
        )));
    }
    // Authenticate the same local CLI VibeX will delegate to through ACP.
    // A bare `codex login` here could select a different, bundled/shadowed
    // executable than the one whose version and path Settings reported.
    let cli = verify_local_cli_runtime(agent).await;
    require_verified_local_cli_runtime(agent, &cli, "open its login command")?;
    let cli_path = cli
        .executable
        .as_deref()
        .expect("supported local CLI verification has an executable path");
    let command = local_cli_login_command(agent, cli_path)?;

    let spawn_result = spawn_login_terminal(&command);
    spawn_result.map_err(|e| AppError::Internal(format!("Failed to open login terminal: {e}")))
}

#[cfg(target_os = "windows")]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    // Open a new console window that runs the login command and stays open so
    // the device-code / browser prompt remains visible.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/V:OFF", "/K", command])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    let script = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    let run = format!("{command}; exec $SHELL");
    for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if which::which(terminal).is_ok() {
            if let Ok(()) = std::process::Command::new(terminal)
                .args(["-e", "sh", "-lc", &run])
                .spawn()
                .map(|_| ())
            {
                return Ok(());
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setting_with_runtime_catalog_identity(
        identity: &LocalAgentRuntimeCatalogIdentity,
    ) -> AgentSetting {
        AgentSetting {
            id: 1,
            agent_type: AgentKind::Codex.as_str().to_string(),
            enabled: true,
            sort_order: 0,
            installed_version: Some(identity.acp_version.clone()),
            env_json: None,
            config_json: None,
            auto_approve_mode: "off".to_string(),
            runtime_cli_path: Some(identity.cli_path.display().to_string()),
            runtime_cli_version: Some(identity.cli_version.clone()),
            runtime_cli_revision: Some(identity.cli_revision.clone()),
            runtime_acp_path: Some(identity.acp_path.display().to_string()),
            runtime_acp_version: Some(identity.acp_version.clone()),
            runtime_acp_revision: Some(identity.acp_revision.clone()),
            created_at: "2026-07-16 00:00:00".to_string(),
            updated_at: "2026-07-16 00:00:00".to_string(),
        }
    }

    #[test]
    fn persisted_catalog_identity_requires_unchanged_local_revisions() {
        let directory = std::env::temp_dir().join(format!(
            "vibex-runtime-identity-test-{}",
            uuid::Uuid::new_v4()
        ));
        let package = directory.join("package");
        let bin = package.join("bin");
        std::fs::create_dir_all(&bin).expect("create runtime fixture");
        let cli_path = bin.join("codex");
        let acp_path = bin.join("codex-acp");
        std::fs::write(&cli_path, "#!/bin/sh\necho cli\n").expect("write cli fixture");
        std::fs::write(&acp_path, "#!/bin/sh\necho acp\n").expect("write acp fixture");
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"fixture","version":"1.0.0"}"#,
        )
        .expect("write package fixture");

        let identity = LocalAgentRuntimeCatalogIdentity {
            cli_path: cli_path.clone(),
            cli_version: "0.130.0".to_string(),
            cli_revision: local_runtime_executable_revision(&cli_path)
                .expect("CLI revision should be readable"),
            acp_path: acp_path.clone(),
            acp_version: "1.1.2".to_string(),
            acp_revision: local_runtime_executable_revision(&acp_path)
                .expect("ACP revision should be readable"),
        };
        let setting = setting_with_runtime_catalog_identity(&identity);
        assert!(matches!(
            persisted_runtime_catalog_identity_with_resolver(
                AgentKind::Codex,
                &setting,
                |program| match program {
                    "codex" => Some(cli_path.clone()),
                    "codex-acp" => Some(acp_path.clone()),
                    _ => None,
                },
            ),
            PersistedRuntimeCatalogIdentity::Valid(found) if found == identity
        ));

        // npm can leave a shim's metadata alone while replacing its package.
        // The nearby package manifest hash must still reject the old catalog.
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"fixture","version":"2.0.0","updated":true}"#,
        )
        .expect("replace package fixture");
        assert!(matches!(
            persisted_runtime_catalog_identity_with_resolver(
                AgentKind::Codex,
                &setting,
                |program| match program {
                    "codex" => Some(cli_path.clone()),
                    "codex-acp" => Some(acp_path.clone()),
                    _ => None,
                },
            ),
            PersistedRuntimeCatalogIdentity::Stale
        ));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn persisted_catalog_identity_rejects_a_different_current_path_target() {
        let directory = std::env::temp_dir().join(format!(
            "vibex-runtime-path-priority-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create runtime fixture");
        let cli_path = directory.join("codex");
        let acp_path = directory.join("codex-acp");
        let replacement_cli = directory.join("replacement-codex");
        std::fs::write(&cli_path, "cli").expect("write cli fixture");
        std::fs::write(&acp_path, "acp").expect("write acp fixture");
        std::fs::write(&replacement_cli, "different cli").expect("write replacement fixture");

        let identity = LocalAgentRuntimeCatalogIdentity {
            cli_path: cli_path.clone(),
            cli_version: "0.130.0".to_string(),
            cli_revision: local_runtime_executable_revision(&cli_path)
                .expect("CLI revision should be readable"),
            acp_path: acp_path.clone(),
            acp_version: "1.1.2".to_string(),
            acp_revision: local_runtime_executable_revision(&acp_path)
                .expect("ACP revision should be readable"),
        };
        let setting = setting_with_runtime_catalog_identity(&identity);
        assert!(matches!(
            persisted_runtime_catalog_identity_with_resolver(
                AgentKind::Codex,
                &setting,
                |program| match program {
                    "codex" => Some(replacement_cli.clone()),
                    "codex-acp" => Some(acp_path.clone()),
                    _ => None,
                },
            ),
            PersistedRuntimeCatalogIdentity::Stale
        ));

        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(not(windows))]
    #[test]
    fn local_cli_login_command_quotes_the_verified_absolute_path() {
        let command = local_cli_login_command(
            AgentKind::Codex,
            Path::new("/tmp/VibeX CLI; do-not-run/codex"),
        )
        .expect("absolute local CLI path should build a login command");
        assert_eq!(command, "'/tmp/VibeX CLI; do-not-run/codex' 'login'");
        assert!(local_cli_login_command(AgentKind::Codex, Path::new("codex")).is_err());
    }

    #[tokio::test]
    async fn global_npm_mutation_lock_serializes_installers() {
        let first = lock_global_npm_mutations().await;
        let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let entered_by_waiter = std::sync::Arc::clone(&entered);
        let waiter = tokio::spawn(async move {
            let _second = lock_global_npm_mutations().await;
            entered_by_waiter.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        tokio::task::yield_now().await;
        assert!(
            !entered.load(std::sync::atomic::Ordering::SeqCst),
            "a second global npm mutation must wait for the first"
        );
        drop(first);
        waiter.await.expect("npm lock waiter should finish");
        assert!(entered.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn codex_acp_config_accepts_supported_fields() {
        validate_agent_config_json(
            AgentKind::Codex,
            Some(r#"{"model":"gpt-5.4","model_reasoning_effort":"high"}"#),
        )
        .expect("supported codex config should pass");
    }

    #[test]
    fn codex_acp_config_rejects_legacy_fields() {
        let err = validate_agent_config_json(
            AgentKind::Codex,
            Some(r#"{"model_provider":"openai","supports_websockets":true,"reasoning_effort":"high"}"#),
        )
        .expect_err("legacy codex config should fail");

        assert!(matches!(err, AppError::BadRequest(_)));
        assert!(err.to_string().contains("model_provider"));
        assert!(err.to_string().contains("supports_websockets"));
        assert!(err.to_string().contains("reasoning_effort"));
    }

    #[test]
    fn validates_auto_approve_modes() {
        validate_auto_approve_mode(None).expect("empty auto approve mode is allowed");
        validate_auto_approve_mode(Some("off")).expect("off is allowed");
        validate_auto_approve_mode(Some("allow_always")).expect("allow_always is allowed");
        validate_auto_approve_mode(Some("yolo")).expect("yolo is allowed");

        assert!(matches!(
            validate_auto_approve_mode(Some("always")),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn maps_registry_npx_agents_to_npm_package_specs() {
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentKind::ClaudeCode)).as_deref(),
            Some("@agentclientprotocol/claude-agent-acp@0.59.0")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentKind::Gemini)).as_deref(),
            Some("@google/gemini-cli@0.45.2")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentKind::Codex)).as_deref(),
            Some("@agentclientprotocol/codex-acp@1.1.4")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentKind::Opencode)).as_deref(),
            Some("opencode-ai@1.18.2")
        );
        assert_eq!(
            npm_package_name("@google/gemini-cli@0.45.2"),
            "@google/gemini-cli"
        );
    }

    #[test]
    fn codex_cli_preflight_and_update_target_the_cli_not_its_acp_adapter() {
        let spec = cli_spec_for_agent(AgentKind::Codex).expect("Codex CLI spec");
        assert_eq!(spec.command, "codex");
        assert_eq!(spec.npm_package, "@openai/codex");
        assert_eq!(
            cli_update_command_for_agent("codex"),
            Some((
                node_installer_program().to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "@openai/codex@latest".to_string(),
                ],
            ))
        );
    }

    #[test]
    fn acp_adapter_install_targets_the_latest_adapter_release() {
        assert_eq!(
            install_command_for_agent("codex"),
            Some((
                node_installer_program().to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "@agentclientprotocol/codex-acp@latest".to_string(),
                ],
            ))
        );
    }

    #[test]
    fn startup_only_installs_an_acp_adapter_for_an_existing_runtime() {
        assert_eq!(
            startup_install_action(true, StartupAcpReadiness::Ready, true),
            StartupInstallAction::Ready
        );
        assert_eq!(
            startup_install_action(true, StartupAcpReadiness::Missing, true),
            StartupInstallAction::InstallAcp
        );
        assert_eq!(
            startup_install_action(false, StartupAcpReadiness::Missing, true),
            StartupInstallAction::NeedsRuntimeSetup
        );
        assert_eq!(
            startup_install_action(false, StartupAcpReadiness::Ready, true),
            StartupInstallAction::NeedsRuntimeSetup
        );
        assert_eq!(
            startup_install_action(true, StartupAcpReadiness::Missing, false),
            StartupInstallAction::NeedsRuntimeSetup
        );
        assert_eq!(
            startup_install_action(true, StartupAcpReadiness::Incompatible, true),
            StartupInstallAction::NeedsAcpUpdate
        );
    }

    #[test]
    fn local_acp_readiness_requires_a_supported_version() {
        let old = LocalAcpVerification {
            executable: Some(PathBuf::from("/usr/local/bin/codex-acp")),
            version: Some("1.0.2".to_string()),
            minimum_supported_version: Some("1.1.2".to_string()),
            probe_error: None,
        };
        assert!(!old.is_supported());
        assert_eq!(old.startup_readiness(), StartupAcpReadiness::Incompatible);

        let newer = LocalAcpVerification {
            version: Some("1.1.4".to_string()),
            ..old
        };
        assert!(newer.is_supported());
        assert_eq!(newer.startup_readiness(), StartupAcpReadiness::Ready);
    }

    #[test]
    fn local_cli_verification_rejects_an_old_runtime() {
        let old = LocalCliVerification {
            executable: Some(PathBuf::from("/usr/local/bin/codex")),
            version: Some("0.129.0".to_string()),
            minimum_supported_version: Some("0.130.0".to_string()),
            probe_error: None,
        };
        assert!(!old.is_supported());

        let current = LocalCliVerification {
            version: Some("0.130.0".to_string()),
            ..old
        };
        assert!(current.is_supported());
    }

    #[test]
    fn post_install_gate_requires_the_verified_cli_and_acp_pair() {
        let cli = LocalCliVerification {
            executable: Some(PathBuf::from("/usr/local/bin/opencode")),
            version: Some("1.17.4".to_string()),
            minimum_supported_version: Some("1.17.4".to_string()),
            probe_error: None,
        };
        let acp = LocalAcpVerification {
            executable: Some(PathBuf::from("/usr/local/bin/opencode")),
            version: Some("1.17.4".to_string()),
            minimum_supported_version: Some("1.17.4".to_string()),
            probe_error: None,
        };
        let ready = LocalAgentRuntimeVerification {
            cli: cli.clone(),
            acp: acp.clone(),
        };
        assert!(require_verified_local_agent_runtime(AgentKind::Opencode, &ready).is_ok());

        let missing_embedded_acp = LocalAgentRuntimeVerification {
            cli,
            acp: LocalAcpVerification {
                executable: Some(PathBuf::from("/usr/local/bin/opencode")),
                version: None,
                minimum_supported_version: acp.minimum_supported_version,
                probe_error: Some("`opencode acp --version` did not return a version".to_string()),
            },
        };
        let error =
            require_verified_local_agent_runtime(AgentKind::Opencode, &missing_embedded_acp)
                .expect_err("a healthy parent CLI is not enough without opencode acp");
        assert!(error.to_string().contains("OpenCode ACP"));
    }

    #[test]
    fn embedded_acp_version_check_keeps_the_subcommand() {
        assert_eq!(
            local_acp_version_args(AgentKind::Opencode),
            Some(vec!["acp".to_string(), "--version".to_string()])
        );
        assert_eq!(
            local_acp_version_args(AgentKind::Codex),
            Some(vec!["--version".to_string()])
        );
    }

    #[test]
    fn registry_preflight_helpers_cover_binary_and_npx_agents() {
        let codex = registry_entry(AgentKind::Codex);
        assert_eq!(
            version_args_for_entry(&codex),
            vec![
                "-y".to_string(),
                "@agentclientprotocol/codex-acp@1.1.4".to_string(),
                "codex-acp".to_string(),
                "--version".to_string()
            ]
        );

        let gemini = registry_entry(AgentKind::Gemini);
        assert_eq!(
            version_args_for_entry(&gemini),
            vec![
                "-y".to_string(),
                "@google/gemini-cli@0.45.2".to_string(),
                "gemini".to_string(),
                "--version".to_string()
            ]
        );

        let hermes = registry_entry(AgentKind::Hermes);
        assert_eq!(
            version_args_for_entry(&hermes),
            vec![
                "--from".to_string(),
                "hermes-agent[acp,mcp]==0.16.0".to_string(),
                "hermes-acp".to_string(),
                "--version".to_string()
            ]
        );
    }

    #[test]
    fn parses_all_registry_agent_keys_for_settings_commands() {
        assert_eq!(
            parse_agent_type_key("open_claw").unwrap(),
            AgentKind::Openclaw
        );
        assert_eq!(parse_agent_type_key("cline").unwrap(), AgentKind::Cline);
        assert_eq!(parse_agent_type_key("hermes").unwrap(), AgentKind::Hermes);
    }
}
