//! App-bundled declarations for Agents that receive first-class presentation
//! and proactive local detection.
//!
//! A profile is data, not an alternate runtime path. Registry Agents and
//! profile-backed Agents use the same management, installation, ACP and
//! session services. The extra declarations here are facts the remote Registry
//! cannot safely provide: stable identity binding, component topology,
//! release-pinned trust evidence, official local candidates and known native
//! configuration fields.

use api_types::{AgentId, AgentKind, AgentSettingsFeature};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileTopology {
    NativeAcp,
    AdapterBacked,
    NativeEngine(crate::engine::NativeEngineKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileComponent {
    AgentRuntime,
    AcpAdapter,
    CombinedRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBinaryArtifact {
    pub platform: &'static str,
    pub archive_url: &'static str,
    /// `None` mirrors upstream distributions that do not publish a digest;
    /// those artifacts enter the existing trust-on-first-use path.
    pub sha256: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBinaryEntry {
    pub unix: &'static str,
    pub windows: &'static str,
    pub unix_siblings: &'static [&'static str],
    pub windows_siblings: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileInstallSource {
    Npx {
        component: ProfileComponent,
        package: &'static str,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        node_requirement: &'static str,
        integrity: &'static str,
    },
    Uvx {
        component: ProfileComponent,
        package: &'static str,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        uv_requirement: &'static str,
        python_requirement: &'static str,
    },
    Binary {
        component: ProfileComponent,
        version: &'static str,
        command: &'static str,
        args: &'static [&'static str],
        artifacts: Vec<ProfileBinaryArtifact>,
        entry: Option<ProfileBinaryEntry>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileIcon {
    pub light: &'static str,
    pub dark: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileRegistryBinding {
    pub registry_id: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileExternalCandidate {
    pub component: ProfileComponent,
    pub executable: &'static str,
    pub version_args: &'static [&'static str],
    /// Arguments that make this executable speak ACP over stdio. Required for
    /// detection-only profiles, which have no install source to pin them.
    /// Managed installs pin the same invocation on their install source; when
    /// both are declared they must agree (locked by `built_in_profiles`).
    pub acp_args: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDependency {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: &'static str,
    pub version_args: &'static [&'static str],
    pub requirement: &'static str,
    pub required: bool,
    pub repairable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileManagementActionKind {
    Login,
    Logout,
    Setup,
    Subscription,
}

/// One entry point that can run a Profile management action: the executable to
/// launch and the arguments that belong to that executable.
///
/// A program is resolved from the Agent's installation lock or PATH, so an
/// action lists every distribution that can drive it, most preferred first. An
/// Adapter-backed Agent's adapter installs the vendor CLI inside itself and
/// re-exposes it through a passthrough subcommand, so the adapter is a valid
/// entry point whenever the standalone CLI is absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileManagementProgram {
    pub program: &'static str,
    pub args: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileManagementAction {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: ProfileManagementActionKind,
    pub programs: &'static [ProfileManagementProgram],
    pub url: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFormat {
    Json,
    Toml,
    Yaml,
    Dotenv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigFieldKind {
    Text,
    Secret,
    Select,
    Boolean,
    Number,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeConfigSurface {
    Configuration,
    Authentication,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigField {
    pub field_id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub path: &'static [&'static str],
    pub kind: NativeConfigFieldKind,
    pub options: &'static [(&'static str, &'static str)],
    /// Some auth stores use a tagged object. When this field is written,
    /// write this sibling value as well (for example `{ type: "api" }`).
    pub object_discriminator: Option<(&'static str, &'static str)>,
    pub surface: NativeConfigSurface,
    /// Effective value when the key is absent. Official Agent defaults must
    /// be shown; missing is not the same as false.
    pub default_value: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfigBinding {
    pub binding_id: &'static str,
    pub home_relative_path: &'static str,
    pub directory_override_env: Option<&'static str>,
    pub override_relative_path: &'static str,
    pub format: NativeConfigFormat,
    pub fields: &'static [NativeConfigField],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthenticationPrecedence {
    AccountThenApiKey,
    ApiKeyThenAccount,
    SingleSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountEvidenceKind {
    NonEmptyObject,
    NonEmptyObjectAt(&'static [&'static str]),
    NonEmptyStringAt(&'static [&'static str]),
    ProviderEntryNotApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountEvidence {
    pub home_relative_directory: &'static str,
    pub directory_override_env: Option<&'static str>,
    /// Path below an override directory. Some CLIs define an override as a
    /// parent directory rather than the native configuration directory.
    pub override_relative_directory: &'static str,
    pub relative_file: &'static str,
    pub kind: AccountEvidenceKind,
}

impl AccountEvidence {
    pub fn matches(&self, value: &serde_json::Value) -> bool {
        match self.kind {
            AccountEvidenceKind::NonEmptyObject => {
                value.as_object().is_some_and(|object| !object.is_empty())
            }
            AccountEvidenceKind::NonEmptyObjectAt(path) => {
                let mut current = value;
                for segment in path {
                    let Some(next) = current.get(*segment) else {
                        return false;
                    };
                    current = next;
                }
                current.as_object().is_some_and(|object| !object.is_empty())
            }
            AccountEvidenceKind::NonEmptyStringAt(path) => {
                let mut current = value;
                for segment in path {
                    let Some(next) = current.get(*segment) else {
                        return false;
                    };
                    current = next;
                }
                current
                    .as_str()
                    .is_some_and(|value| !value.trim().is_empty())
            }
            AccountEvidenceKind::ProviderEntryNotApiKey => {
                value.as_object().is_some_and(|object| {
                    object.values().any(|entry| {
                        entry
                            .get("type")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|kind| !matches!(kind, "api" | "api_key"))
                    })
                })
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltInProfile {
    pub agent_id: AgentId,
    pub display_name: &'static str,
    pub description: &'static str,
    pub icon: ProfileIcon,
    pub registry_binding: Option<ProfileRegistryBinding>,
    pub topology: ProfileTopology,
    pub supported_platforms: &'static [&'static str],
    pub install_sources: Vec<ProfileInstallSource>,
    pub external_candidates: &'static [ProfileExternalCandidate],
    pub dependencies: &'static [ProfileDependency],
    pub management_actions: &'static [ProfileManagementAction],
    /// Adapter-specific environment variable that must point to the separately
    /// installed local Runtime. `None` means the ACP executable is the Runtime,
    /// the adapter resolves it from PATH / a profile-owned command, or the
    /// adapter ships the vendor CLI used at session start.
    pub runtime_executable_env: Option<&'static str>,
    pub native_config: &'static [NativeConfigBinding],
    pub settings_features: &'static [AgentSettingsFeature],
    pub authentication_precedence: AuthenticationPrecedence,
    pub authentication_required_by_default: bool,
    pub account_evidence: Option<AccountEvidence>,
}

impl BuiltInProfile {
    pub fn binary_required_siblings(&self, windows: bool) -> &'static [&'static str] {
        self.install_sources
            .iter()
            .find_map(|source| match source {
                ProfileInstallSource::Binary {
                    entry: Some(entry), ..
                } => Some(if windows {
                    entry.windows_siblings
                } else {
                    entry.unix_siblings
                }),
                _ => None,
            })
            .unwrap_or(&[])
    }

    /// Whether the profile's ACP adapter ships a usable vendor CLI. Native
    /// engine profiles run the official vendor CLI directly and return `false`.
    pub fn adapter_bundles_runtime(&self) -> bool {
        adapter_bundles_runtime(&self.agent_id)
    }

    /// Whether Host may put `mcpServers` on `session/new`, `session/load`, and
    /// `session/resume`. OpenClaw rejects a non-empty list. Cline, Pi, and
    /// DeepSeek Harness accept the field but load their companion MCP servers
    /// from their own config file on disk (`~/.dsh/mcp.json` for DeepSeek),
    /// so injecting via `session/new` would cause a duplicate that fails
    /// `failOnStartupError` in the agent's MCP client.
    pub fn delivers_session_mcp(&self) -> bool {
        !matches!(
            AgentKind::from_lenient(self.agent_id.as_str()),
            Some(
                AgentKind::Openclaw | AgentKind::Cline | AgentKind::Pi | AgentKind::DeepseekHarness
            )
        )
    }

    /// Flagship native engine backend (`ClaudeNative` or `CodexNative`) when
    /// this profile supports direct native control-plane routing.
    pub fn native_engine_kind(&self) -> Option<crate::engine::NativeEngineKind> {
        crate::engine::resolve_native_engine_kind(
            self.agent_id.as_str(),
            crate::engine::EngineRuntimePreference::NativeFirst,
        )
    }

    /// Resolve the active runtime topology under the requested engine preference
    /// and `DIMO_ENGINE_MODE` grayscale environment override (`native` vs `acp`).
    pub fn effective_topology(
        &self,
        preference: crate::engine::EngineRuntimePreference,
        mode_env: Option<&str>,
    ) -> ProfileTopology {
        if let Some(kind) = crate::engine::resolve_native_engine_kind_with_env(
            self.agent_id.as_str(),
            preference,
            mode_env,
        ) {
            return ProfileTopology::NativeEngine(kind);
        }
        match self.topology {
            ProfileTopology::NativeEngine(kind) => {
                if mode_env.is_some_and(|raw| raw.trim().eq_ignore_ascii_case("acp")) {
                    ProfileTopology::AdapterBacked
                } else {
                    ProfileTopology::NativeEngine(kind)
                }
            }
            other => other,
        }
    }
}

/// Unknown / Registry agents keep wire MCP. OpenClaw, Cline, and Pi skip it.
pub fn profile_delivers_session_mcp(agent_id: &AgentId) -> bool {
    BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .map(BuiltInProfile::delivers_session_mcp)
        .unwrap_or(true)
}

/// Env keys that must not reach an ACP adapter which bundles its own vendor CLI.
pub fn bundled_adapter_runtime_env_keys(_agent_id: &AgentId) -> &'static [&'static str] {
    &[]
}

pub fn adapter_bundles_runtime(agent_id: &AgentId) -> bool {
    !bundled_adapter_runtime_env_keys(agent_id).is_empty()
}

///ACP Registry entry IDs that wrap built-in native-engine Agents and must never
/// surface as duplicate installable Registry cards or overwrite native profiles.
pub fn suppressed_registry_ids_for_built_ins() -> &'static [&'static str] {
    &["claude-acp", "claude-code-acp", "codex-acp"]
}

/// Built-in Agent ID superseded by a suppressed ACP Registry entry ID, if any.
pub fn suppressed_registry_built_in_agent_id(registry_id: &str) -> Option<&'static str> {
    match registry_id.trim() {
        "claude-acp" | "claude-code-acp" => Some("claude_code"),
        "codex-acp" => Some("codex"),
        _ => None,
    }
}

/// Home-relative install directories used by standalone native-engine vendor
/// installers that GUI processes frequently lack on `PATH`.
pub fn native_engine_extra_dirs(agent_id: &str) -> &'static [&'static str] {
    match AgentKind::from_lenient(agent_id) {
        Some(AgentKind::ClaudeCode) => &[".local/bin", ".claude/local"],
        Some(AgentKind::Codex) => &[".local/bin", "AppData/Local/Programs/OpenAI/Codex/bin"],
        _ => &[],
    }
}

fn native_engine_executable_name(agent_id: &str) -> Option<&'static str> {
    match AgentKind::from_lenient(agent_id)? {
        AgentKind::ClaudeCode => Some("claude"),
        AgentKind::Codex => Some("codex"),
        _ => None,
    }
}

/// Resolve a standalone native-engine CLI (`claude`, `codex`) inside `home`'s
/// vendor installer directories when GUI `PATH` does not expose them.
pub fn resolve_native_engine_cli(
    agent_id: &str,
    home: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let cmd = native_engine_executable_name(agent_id)?;
    let extra_dirs = native_engine_extra_dirs(agent_id);
    if let Some(found) = resolve_cli_in_home_dirs(cmd, extra_dirs, home, true) {
        return Some(workspace_utils::process::prefer_direct_spawn_executable(
            found,
        ));
    }
    None
}

pub const ACP_ADAPTER_DOCS_URL: &str = "https://agentclientprotocol.com";

/// Vendor CLI wrapped by a Built-in Profile whose ACP entry point is a
/// third-party adapter (`zcode-acp-server`).
///
/// BOUNDARY: `extra_dirs` and [`resolve_vendor_cli`] are strictly for
/// login/logout management actions, installation diagnostics, preflight checks,
/// and "adapter missing but vendor CLI present" explanations. ACP session
/// spawn, `LaunchGate`, and `discover_path_acp_launch_lock` MUST NEVER use
/// `AcpAdapterRelation` or `resolve_vendor_cli` to spawn a vendor CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpAdapterRelation {
    /// The vendor CLI users install themselves, e.g. `"zcode"`.
    pub native_cmd: &'static str,
    /// Display name for that CLI, e.g. `"ZCode CLI"`.
    pub native_label: &'static str,
    /// Config/credential dir BOTH the vendor CLI and the adapter read, so
    /// installing the adapter needs no second login.
    pub shared_config_dir: &'static str,
    /// Home-relative dirs the vendor's own installers use that a GUI app's PATH
    /// commonly lacks. Probed after PATH and the npm global prefix for
    /// diagnostics/login only — NEVER for ACP spawn.
    pub extra_dirs: &'static [&'static str],
    /// Where the "learn more" action points.
    pub docs_url: &'static str,
}

/// Adapter relation for an Agent, or `None` when the Profile launches the
/// vendor's own CLI / native engine directly.
///
/// Keep `acp_adapter_relation_covers_only_wrapper_agents` in sync when editing.
pub fn acp_adapter_relation(agent_id: &str) -> Option<AcpAdapterRelation> {
    match AgentKind::from_lenient(agent_id)? {
        AgentKind::ZCode => Some(AcpAdapterRelation {
            native_cmd: "zcode",
            native_label: "ZCode CLI",
            shared_config_dir: "~/.zcode",
            extra_dirs: &[".local/bin"],
            docs_url: "https://github.com/william0wang/zcode-acp",
        }),
        _ => None,
    }
}

fn resolve_cli_in_home_dirs(
    cmd: &str,
    extra_dirs: &[&str],
    home: &std::path::Path,
    allow_windows_programs_fallback: bool,
) -> Option<std::path::PathBuf> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    for dir in extra_dirs {
        let base = home.join(dir);
        if let Some(found) = resolve_cli_in_dir(&base, cmd) {
            return Some(found);
        }
    }
    #[cfg(windows)]
    if allow_windows_programs_fallback {
        let mut app_data_roots = vec![home.join("AppData/Local")];
        if dirs::home_dir().as_deref() == Some(home)
            && let Some(env_local_app_data) =
                std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
            && !app_data_roots.contains(&env_local_app_data)
        {
            app_data_roots.push(env_local_app_data);
        }
        for local_app_data in app_data_roots {
            if cmd.eq_ignore_ascii_case("claude") {
                let base = local_app_data.join("Programs").join("claude-code");
                if let Some(found) = resolve_cli_in_dir(&base, "claude") {
                    return Some(found);
                }
            } else if cmd.eq_ignore_ascii_case("codex") {
                let base = local_app_data
                    .join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin");
                if let Some(found) = resolve_cli_in_dir(&base, "codex") {
                    return Some(found);
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = allow_windows_programs_fallback;
    None
}

fn resolve_cli_in_dir(base: &std::path::Path, cmd: &str) -> Option<std::path::PathBuf> {
    let candidates: [std::path::PathBuf; 4] = [
        base.join(format!("{cmd}.exe")),
        base.join(format!("{cmd}.cmd")),
        base.join(format!("{cmd}.bat")),
        base.join(cmd),
    ];
    let slice: &[std::path::PathBuf] = if cfg!(windows) {
        &candidates[..]
    } else {
        &candidates[3..]
    };
    slice.iter().find(|cand| cand.is_file()).cloned()
}

/// Resolve `cmd` inside `home`-relative `extra_dirs` (for login/logout,
/// preflight, and diagnostics ONLY — NEVER for ACP session spawn).
pub fn resolve_vendor_cli_in_extra_dirs(
    cmd: &str,
    extra_dirs: &[&str],
    home: &std::path::Path,
) -> Option<std::path::PathBuf> {
    resolve_cli_in_home_dirs(cmd, extra_dirs, home, true)
}

/// Resolve the vendor CLI wrapped by an ACP adapter (`zcode` — see
/// [`acp_adapter_relation`]).
///
/// BOUNDARY: Strictly for login/logout management actions, installation
/// diagnostics, preflight checks, and "adapter missing but CLI present"
/// explanations. ACP session spawn, `LaunchGate`, and
/// `discover_path_acp_launch_lock` MUST NEVER call this function.
pub async fn resolve_vendor_cli(cmd: &str, extra_dirs: &[&str]) -> Option<std::path::PathBuf> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    if let Some(path) = workspace_utils::shell::resolve_executable_path(cmd).await {
        return Some(path);
    }
    let home = dirs::home_dir()?;
    resolve_vendor_cli_in_extra_dirs(cmd, extra_dirs, &home)
}

/// The arguments that make a Profile's component speak ACP over stdio.
///
/// Managed installs pin the invocation on their install source. Detection-only
/// Profiles have no install source, so their external candidate carries it.
/// This is the only place either is read, so the two cannot drift into two
/// different answers at different call sites.
pub fn acp_launch_args(profile: &BuiltInProfile, component: ProfileComponent) -> Vec<String> {
    let declared = profile
        .external_candidates
        .iter()
        .find(|candidate| candidate.component == component && !candidate.acp_args.is_empty())
        .map(|candidate| candidate.acp_args);
    let pinned = profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            ProfileInstallSource::Npx {
                component: source_component,
                args,
                ..
            }
            | ProfileInstallSource::Uvx {
                component: source_component,
                args,
                ..
            }
            | ProfileInstallSource::Binary {
                component: source_component,
                args,
                ..
            } if *source_component == component => Some(*args),
            _ => None,
        });
    declared
        .or(pinned)
        .unwrap_or(&[])
        .iter()
        .map(|argument| (*argument).to_string())
        .collect()
}

fn normalized_program_command_name(program: &std::path::Path) -> Option<String> {
    let name = program.file_name().and_then(|value| value.to_str())?;
    let trimmed = name
        .strip_suffix(".exe")
        .or_else(|| name.strip_suffix(".EXE"))
        .or_else(|| name.strip_suffix(".cmd"))
        .or_else(|| name.strip_suffix(".CMD"))
        .or_else(|| name.strip_suffix(".bat"))
        .or_else(|| name.strip_suffix(".BAT"))
        .or_else(|| name.strip_suffix(".par"))
        .or_else(|| name.strip_suffix(".PAR"))
        .unwrap_or(name);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub fn candidate_command_matches(executable: &str, program: &std::path::Path) -> bool {
    normalized_program_command_name(program)
        .is_some_and(|name| name.eq_ignore_ascii_case(executable))
}

pub fn external_candidate_for_program<'a>(
    profile: &'a BuiltInProfile,
    component: ProfileComponent,
    program: &std::path::Path,
) -> Option<&'a ProfileExternalCandidate> {
    profile
        .external_candidates
        .iter()
        .find(|candidate| candidate.component == component && candidate_command_matches(candidate.executable, program))
}

pub fn acp_launch_args_for_program(
    profile: &BuiltInProfile,
    component: ProfileComponent,
    program: Option<&std::path::Path>,
) -> Vec<String> {
    if let Some(program) = program
        && let Some(candidate) = external_candidate_for_program(profile, component, program)
    {
        return candidate
            .acp_args
            .iter()
            .map(|argument| (*argument).to_string())
            .collect();
    }
    acp_launch_args(profile, component)
}

fn args_start_with(args: &[String], expected: &[&str]) -> bool {
    args.len() >= expected.len()
        && expected
            .iter()
            .enumerate()
            .all(|(idx, item)| args[idx] == *item)
}

pub fn normalize_acp_launch_args_for_program(
    profile: &BuiltInProfile,
    component: ProfileComponent,
    program: Option<&std::path::Path>,
    args: &mut Vec<String>,
) {
    let Some(program) = program else {
        if args.is_empty() {
            let defaults = acp_launch_args(profile, component);
            if !defaults.is_empty() {
                *args = defaults;
            }
        }
        return;
    };
    let Some(matched) = external_candidate_for_program(profile, component, program) else {
        if args.is_empty() {
            let defaults = acp_launch_args(profile, component);
            if !defaults.is_empty() {
                *args = defaults;
            }
        }
        return;
    };

    for sibling in profile.external_candidates {
        if sibling.component == component
            && !sibling.acp_args.is_empty()
            && sibling.acp_args != matched.acp_args
            && args_start_with(args, sibling.acp_args)
        {
            args.drain(0..sibling.acp_args.len());
            break;
        }
    }

    if matched.acp_args.is_empty() {
        return;
    }

    if args.is_empty() {
        *args = matched
            .acp_args
            .iter()
            .map(|argument| (*argument).to_string())
            .collect();
        return;
    }

    // Deduplicate accidental repeated leading ACP subcommands (e.g. `hermes acp acp`).
    let step = matched.acp_args.len();
    while args.len() >= step * 2
        && args_start_with(args, matched.acp_args)
        && args_start_with(&args[step..], matched.acp_args)
    {
        args.drain(0..step);
    }
}

pub fn version_args_for_program(
    profile: &BuiltInProfile,
    component: ProfileComponent,
    program: Option<&std::path::Path>,
) -> &'static [&'static str] {
    if let Some(program) = program
        && let Some(candidate) = external_candidate_for_program(profile, component, program)
    {
        return candidate.version_args;
    }
    profile
        .external_candidates
        .iter()
        .find(|candidate| candidate.component == component)
        .map(|candidate| candidate.version_args)
        .unwrap_or(&["--version"])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEntryIdentity {
    pub registry_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct BuiltInProfileCatalog {
    profiles: Vec<BuiltInProfile>,
}

impl BuiltInProfileCatalog {
    pub fn bundled() -> Self {
        Self {
            profiles: vec![
                claude_code_profile(),
                codex_profile(),
                pi_profile(),
                opencode_profile(),
                grok_profile(),
                cursor_profile(),
                deepseek_harness_profile(),
                antigravity_profile(),
                cline_profile(),
                openclaw_profile(),
                hermes_profile(),
                codebuddy_profile(),
                kimi_code_profile(),
                qoder_profile(),
                kiro_profile(),
                auggie_profile(),
                trae_profile(),
                command_code_profile(),
                zcode_profile(),
                omp_profile(),
            ],
        }
    }

    /// Permanent built-ins plus community presets that still receive a
    /// management profile after the user adds them. This catalog is not a
    /// membership source: `ensure_current_built_ins` only seeds [`Self::bundled`].
    pub fn management() -> Self {
        let mut profiles = Self::bundled().profiles;
        profiles.extend(community_managed_profiles());
        Self { profiles }
    }

    pub fn profiles(&self) -> &[BuiltInProfile] {
        &self.profiles
    }

    pub fn profile(&self, agent_id: &AgentId) -> Option<&BuiltInProfile> {
        self.profiles.iter().find(|profile| {
            &profile.agent_id == agent_id
                || AgentKind::from_lenient(agent_id.as_str())
                    .zip(AgentKind::from_lenient(profile.agent_id.as_str()))
                    .is_some_and(|(requested, bundled)| requested == bundled)
        })
    }

    /// Agents whose settings expose reusable Model Providers can probe `/models`.
    pub fn supports_reusable_model_providers(&self, agent_id: &AgentId) -> bool {
        self.profile(agent_id).is_some_and(|profile| {
            profile
                .settings_features
                .contains(&AgentSettingsFeature::ReusableModelProviders)
        })
    }

    /// Agents whose provider settings support live `/models` probing (both
    /// reusable provider stores and OpenCode-style provider catalogs).
    pub fn supports_provider_model_detection(&self, agent_id: &AgentId) -> bool {
        self.profile(agent_id).is_some_and(|profile| {
            profile
                .settings_features
                .contains(&AgentSettingsFeature::ReusableModelProviders)
                || profile
                    .settings_features
                    .contains(&AgentSettingsFeature::OpenCodeProviders)
        })
    }

    /// Resolve only an explicit stable Registry id binding. Display names are
    /// intentionally ignored: they are mutable metadata and may collide.
    pub fn resolve_registry_entry(&self, entry: &RegistryEntryIdentity) -> Option<&AgentId> {
        self.profiles.iter().find_map(|profile| {
            let binding = profile.registry_binding.as_ref()?;
            (binding.registry_id == entry.registry_id).then_some(&profile.agent_id)
        })
    }
}

mod built_ins;
mod configs_a;
mod configs_b;
#[cfg(test)]
mod tests;

use built_ins::*;
use configs_a::*;
use configs_b::*;
