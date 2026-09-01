//! Pure, version-locked installation planning and artifact trust checks.

use api_types::AgentId;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256, Sha512};
use uuid::Uuid;

use crate::{
    ProfileComponent, ProfileInstallSource, RegistryAddTarget, RegistryBinaryTarget,
    RegistryPackageDistribution, RegistrySnapshot, UserAgentDistributionKind,
    UserAgentInstallTarget, profiles::BuiltInProfileCatalog,
};

struct BinaryPackagingAdvisory {
    platform: &'static str,
    source_archive: &'static str,
    source_sha256: &'static str,
    replacement_archive: &'static str,
    replacement_sha256: &'static str,
    replacement_command: &'static str,
}

// Immutable compatibility advisories are keyed by the exact upstream artifact
// identity, never by Agent name. The selected replacement is another signed
// asset from the same upstream release, and the frozen plan records its real
// URL, command, and digest. This avoids a failure-time, untracked fallback.
const BINARY_PACKAGING_ADVISORIES: &[BinaryPackagingAdvisory] = &[BinaryPackagingAdvisory {
    platform: "darwin-aarch64",
    source_archive: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin.tar.gz",
    source_sha256: "15018b20b203aee09658fdc64840c4846fc17c108d8dba1a19a95581d3ce2921",
    replacement_archive: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin-onedir.tar.gz",
    replacement_sha256: "3533d7197a3cf807d7ba3b67d54637180544565f6277870f9bcf639ef21754fb",
    replacement_command: "./kimi/kimi",
}];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallCandidateSource {
    BuiltInProfile,
    /// 内置 Agent 的更新目标:Profile 提供组件结构与锁版本基线,Registry 条目提供
    /// 目标版本的组件分发(acp_adapter 或 combined_runtime);无 fresh snapshot
    /// 时回退 [`InstallCandidateSource::BuiltInProfile`]。
    BuiltInProfileWithRegistry(Box<RegistryAddTarget>),
    Registry(Box<RegistryAddTarget>),
    UserDefinition(Box<UserAgentInstallTarget>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallEnvironment {
    pub node_verified: bool,
    pub uv_verified: bool,
    pub python_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlanningInput {
    pub agent_id: AgentId,
    pub source: InstallCandidateSource,
    pub platform: String,
    pub environment: InstallEnvironment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlannedDistributionKind {
    Binary,
    Npx,
    Uvx,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ArtifactTrust {
    ExpectedSha256 { sha256: String },
    EcosystemIntegrity { integrity: String },
    EcosystemIntegrityRequired,
    Tofu,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlannedInstallComponent {
    pub component_id: String,
    pub distribution_kind: PlannedDistributionKind,
    pub version: String,
    pub resolved_source: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub trust: ArtifactTrust,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LockedInstallSource {
    BuiltInProfile,
    BuiltInProfileWithRegistry {
        snapshot_id: Uuid,
        registry_id: String,
    },
    OfficialRegistry {
        snapshot_id: Uuid,
        registry_id: String,
    },
    UserDefinition {
        definition_sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ResolvedInstallPlan {
    pub agent_id: AgentId,
    pub source: LockedInstallSource,
    /// Identity version of the local Runtime (adapter-backed) or the combined
    /// runtime. This is not the Registry update target; see
    /// [`Self::registry_bound_version`].
    pub version: String,
    pub platform: String,
    pub components: Vec<PlannedInstallComponent>,
}

impl ResolvedInstallPlan {
    /// Component a Registry refresh replaces: `acp_adapter` when present,
    /// otherwise `combined_runtime`.
    pub fn registry_bound_component(&self) -> Option<&PlannedInstallComponent> {
        self.components
            .iter()
            .find(|component| component.component_id == "acp_adapter")
            .or_else(|| {
                self.components
                    .iter()
                    .find(|component| component.component_id == "combined_runtime")
            })
    }

    /// Registry-declared version persisted as Installation lock
    /// `registry_version`. Adapter-backed Agents store the ACP adapter here,
    /// never the Runtime pin in [`Self::version`].
    pub fn registry_bound_version(&self) -> &str {
        self.registry_bound_component()
            .map(|component| component.version.as_str())
            .unwrap_or(self.version.as_str())
    }
}

pub fn apply_npx_component_version(component: &mut PlannedInstallComponent, version: &str) {
    let package = crate::local_detection::npm_package_name(&component.resolved_source);
    component.resolved_source = format!("{package}@{version}");
    component.version = version.to_string();
    component.trust = ArtifactTrust::EcosystemIntegrityRequired;
}

/// Apply independently chosen Runtime and ACP versions. Combined runtimes use
/// the ACP version when both are supplied.
pub fn apply_component_versions(
    plan: &mut ResolvedInstallPlan,
    runtime_version: Option<&str>,
    acp_version: Option<&str>,
) -> Result<(), String> {
    let mut changed = false;
    for component in &mut plan.components {
        let selected = match component.component_id.as_str() {
            "agent_runtime" => runtime_version,
            "acp_adapter" => acp_version,
            "combined_runtime" => acp_version.or(runtime_version),
            _ => None,
        };
        let Some(version) = selected.filter(|version| !version.is_empty()) else {
            continue;
        };
        match component.distribution_kind {
            PlannedDistributionKind::Npx => apply_npx_component_version(component, version),
            PlannedDistributionKind::Binary => {
                if plan.version.is_empty() || !component.resolved_source.contains(&plan.version) {
                    return Err("当前二进制下载地址无法安全替换指定版本".to_string());
                }
                component.resolved_source =
                    component.resolved_source.replace(&plan.version, version);
                component.version = version.to_string();
                component.trust = ArtifactTrust::Tofu;
            }
            PlannedDistributionKind::Uvx => {
                return Err("uvx Agent 不支持指定版本安装".to_string());
            }
        }
        changed = true;
    }
    if !changed {
        return Err("Agent 的安装方案没有可替换的版本组件".to_string());
    }
    if let Some(version) = runtime_version.filter(|version| !version.is_empty()) {
        plan.version = version.to_string();
    }
    if let Some(version) = acp_version.filter(|version| !version.is_empty())
        && plan
            .components
            .iter()
            .all(|component| component.component_id != "agent_runtime")
    {
        plan.version = version.to_string();
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InstallPlanningError {
    #[error("no Built-in Profile exists for {agent_id}")]
    MissingProfile { agent_id: AgentId },
    #[error("Agent {agent_id} does not support platform {platform}")]
    UnsupportedPlatform { agent_id: AgentId, platform: String },
    #[error("required local package Runtime is unavailable: {runtime}")]
    RuntimeUnavailable { runtime: &'static str },
    #[error("Registry package `{package}` does not lock Agent version {version}")]
    UnlockedPackageVersion { package: String, version: String },
    #[error("artifact SHA-256 mismatch: expected {expected}, found {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("artifact ecosystem integrity is invalid: {0}")]
    InvalidEcosystemIntegrity(String),
    #[error("TOFU fingerprint changed: expected {expected}, found {actual}")]
    TofuChanged { expected: String, actual: String },
    #[error("version evidence `{evidence_source}` reported {actual}, expected {expected}")]
    VersionEvidenceConflict {
        evidence_source: String,
        expected: String,
        actual: String,
    },
    #[error("Registry target Agent `{registry}` does not match the built-in profile `{profile}`")]
    RegistryTargetAgentMismatch { profile: AgentId, registry: AgentId },
    #[error("built-in Agent `{agent_id}` has no component slot for the Registry distribution")]
    RegistryDistributionDoesNotFitProfile { agent_id: AgentId },
}

pub struct InstallPlanner {
    profiles: BuiltInProfileCatalog,
}

impl InstallPlanner {
    pub fn bundled() -> Self {
        Self {
            profiles: BuiltInProfileCatalog::bundled(),
        }
    }

    pub fn plan(
        &self,
        input: InstallPlanningInput,
    ) -> Result<ResolvedInstallPlan, InstallPlanningError> {
        match input.source.clone() {
            InstallCandidateSource::BuiltInProfile => self.plan_profile(input),
            InstallCandidateSource::BuiltInProfileWithRegistry(target) => {
                self.plan_profile_with_registry(input, *target)
            }
            InstallCandidateSource::Registry(target) => self.plan_registry(input, *target),
            InstallCandidateSource::UserDefinition(target) => {
                self.plan_user_definition(input, *target)
            }
        }
    }

    fn plan_profile(
        &self,
        input: InstallPlanningInput,
    ) -> Result<ResolvedInstallPlan, InstallPlanningError> {
        let profile = self.profiles.profile(&input.agent_id).ok_or_else(|| {
            InstallPlanningError::MissingProfile {
                agent_id: input.agent_id.clone(),
            }
        })?;
        if !profile
            .supported_platforms
            .contains(&input.platform.as_str())
        {
            return Err(InstallPlanningError::UnsupportedPlatform {
                agent_id: input.agent_id,
                platform: input.platform,
            });
        }
        let mut components = Vec::with_capacity(profile.install_sources.len());
        for source in &profile.install_sources {
            components.push(plan_profile_component(source, &input)?);
        }
        let version = components
            .iter()
            .find(|component| {
                component.component_id == component_id(ProfileComponent::AgentRuntime)
                    || component.component_id == component_id(ProfileComponent::CombinedRuntime)
            })
            .or_else(|| components.first())
            .map(|component| component.version.clone())
            .expect("Built-in Profiles declare at least one component");
        Ok(ResolvedInstallPlan {
            agent_id: input.agent_id,
            source: LockedInstallSource::BuiltInProfile,
            version,
            platform: input.platform,
            components,
        })
    }

    fn plan_registry(
        &self,
        input: InstallPlanningInput,
        target: RegistryAddTarget,
    ) -> Result<ResolvedInstallPlan, InstallPlanningError> {
        let component = self.registry_plan_component(&target, &input)?;
        Ok(registry_plan(input, target, component))
    }

    fn plan_profile_with_registry(
        &self,
        input: InstallPlanningInput,
        target: RegistryAddTarget,
    ) -> Result<ResolvedInstallPlan, InstallPlanningError> {
        let mut plan = self.plan_profile(input.clone())?;
        let profile = self.profiles.profile(&input.agent_id).ok_or_else(|| {
            InstallPlanningError::MissingProfile {
                agent_id: input.agent_id.clone(),
            }
        })?;
        let bound_by_registry_id = profile
            .registry_binding
            .as_ref()
            .is_some_and(|binding| binding.registry_id == target.registry_id);
        if target.agent_id != plan.agent_id && !bound_by_registry_id {
            return Err(InstallPlanningError::RegistryTargetAgentMismatch {
                profile: plan.agent_id.clone(),
                registry: target.agent_id.clone(),
            });
        }
        let component = self.registry_plan_component(&target, &input)?;
        let slot = plan
            .components
            .iter()
            .position(|component| component.component_id == "acp_adapter")
            .or_else(|| {
                plan.components
                    .iter()
                    .position(|component| component.component_id == "combined_runtime")
            })
            .ok_or_else(
                || InstallPlanningError::RegistryDistributionDoesNotFitProfile {
                    agent_id: plan.agent_id.clone(),
                },
            )?;
        let mut component = component;
        component.component_id = plan.components[slot].component_id.clone();
        component.version.clone_from(&target.version);
        plan.components[slot] = component;
        // 替换 combined_runtime 时整体版本随 Registry;替换 acp_adapter 时
        // Runtime 版本(plan.version)保持不变。
        if plan
            .components
            .iter()
            .all(|component| component.component_id != "agent_runtime")
        {
            plan.version.clone_from(&target.version);
        }
        plan.source = LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id: target.snapshot_id,
            registry_id: target.registry_id,
        };
        Ok(plan)
    }

    /// 从 Registry 条目解析当前平台的单个组件分发;plan_registry 与
    /// plan_profile_with_registry 共用同一执行路径(ADR-0034 单一 plan)。
    fn registry_plan_component(
        &self,
        target: &RegistryAddTarget,
        input: &InstallPlanningInput,
    ) -> Result<PlannedInstallComponent, InstallPlanningError> {
        if let Some(binary) = target
            .distributions
            .binary
            .as_ref()
            .and_then(|targets| targets.get(&input.platform))
            .cloned()
        {
            let binary = apply_binary_packaging_advisory(&input.platform, binary);
            let trust = binary
                .sha256
                .as_ref()
                .map(|sha256| ArtifactTrust::ExpectedSha256 {
                    sha256: sha256.to_ascii_lowercase(),
                })
                .unwrap_or(ArtifactTrust::Tofu);
            return Ok(PlannedInstallComponent {
                component_id: "combined_runtime".to_string(),
                distribution_kind: PlannedDistributionKind::Binary,
                version: String::new(),
                resolved_source: binary.archive,
                command: binary.cmd,
                args: binary.args,
                env: binary.env,
                trust,
            });
        }
        if input.environment.node_verified
            && let Some(npx) = target.distributions.npx.clone()
        {
            ensure_package_version(&npx, &target.version, false)?;
            return Ok(package_component(&npx, PlannedDistributionKind::Npx));
        }
        if input.environment.uv_verified
            && let Some(uvx) = target.distributions.uvx.clone()
        {
            ensure_package_version(&uvx, &target.version, true)?;
            return Ok(package_component(&uvx, PlannedDistributionKind::Uvx));
        }
        Err(InstallPlanningError::UnsupportedPlatform {
            agent_id: input.agent_id.clone(),
            platform: input.platform.clone(),
        })
    }

    fn plan_user_definition(
        &self,
        input: InstallPlanningInput,
        target: UserAgentInstallTarget,
    ) -> Result<ResolvedInstallPlan, InstallPlanningError> {
        let component = match target.distribution_kind {
            UserAgentDistributionKind::Binary => {
                let binary = target
                    .distributions
                    .binary
                    .as_ref()
                    .and_then(|targets| targets.get(&input.platform))
                    .cloned()
                    .ok_or_else(|| InstallPlanningError::UnsupportedPlatform {
                        agent_id: input.agent_id.clone(),
                        platform: input.platform.clone(),
                    })?;
                let trust = binary
                    .sha256
                    .as_ref()
                    .map(|sha256| ArtifactTrust::ExpectedSha256 {
                        sha256: sha256.to_ascii_lowercase(),
                    })
                    .unwrap_or(ArtifactTrust::Tofu);
                PlannedInstallComponent {
                    component_id: "combined_runtime".to_string(),
                    distribution_kind: PlannedDistributionKind::Binary,
                    version: target.version.clone(),
                    resolved_source: binary.archive,
                    command: binary.cmd,
                    args: binary.args,
                    env: binary.env,
                    trust,
                }
            }
            UserAgentDistributionKind::Npx => {
                if !input.environment.node_verified {
                    return Err(InstallPlanningError::RuntimeUnavailable { runtime: "node" });
                }
                let package = target.distributions.npx.as_ref().ok_or_else(|| {
                    InstallPlanningError::UnsupportedPlatform {
                        agent_id: input.agent_id.clone(),
                        platform: input.platform.clone(),
                    }
                })?;
                ensure_package_version(package, &target.version, false)?;
                let mut component = package_component(package, PlannedDistributionKind::Npx);
                component.version.clone_from(&target.version);
                component
            }
            UserAgentDistributionKind::Uvx => {
                if !input.environment.uv_verified {
                    return Err(InstallPlanningError::RuntimeUnavailable { runtime: "uv" });
                }
                let package = target.distributions.uvx.as_ref().ok_or_else(|| {
                    InstallPlanningError::UnsupportedPlatform {
                        agent_id: input.agent_id.clone(),
                        platform: input.platform.clone(),
                    }
                })?;
                ensure_package_version(package, &target.version, true)?;
                let mut component = package_component(package, PlannedDistributionKind::Uvx);
                component.version.clone_from(&target.version);
                component
            }
        };
        Ok(ResolvedInstallPlan {
            agent_id: input.agent_id,
            source: LockedInstallSource::UserDefinition {
                definition_sha256: target.definition_sha256,
            },
            version: target.version,
            platform: input.platform,
            components: vec![component],
        })
    }
}

fn apply_binary_packaging_advisory(
    platform: &str,
    mut binary: RegistryBinaryTarget,
) -> RegistryBinaryTarget {
    let source_sha256 = binary.sha256.as_deref().map(str::to_ascii_lowercase);
    let Some(advisory) = BINARY_PACKAGING_ADVISORIES.iter().find(|advisory| {
        advisory.platform == platform
            && advisory.source_archive == binary.archive
            && source_sha256.as_deref() == Some(advisory.source_sha256)
    }) else {
        return binary;
    };
    binary.archive = advisory.replacement_archive.to_string();
    binary.sha256 = Some(advisory.replacement_sha256.to_string());
    binary.cmd = advisory.replacement_command.to_string();
    binary
}

fn registry_plan(
    input: InstallPlanningInput,
    target: RegistryAddTarget,
    mut component: PlannedInstallComponent,
) -> ResolvedInstallPlan {
    component.version.clone_from(&target.version);
    ResolvedInstallPlan {
        agent_id: input.agent_id,
        source: LockedInstallSource::OfficialRegistry {
            snapshot_id: target.snapshot_id,
            registry_id: target.registry_id,
        },
        version: target.version,
        platform: input.platform,
        components: vec![component],
    }
}

/// 内置 Agent 更新时从 fresh Registry snapshot 解析其 registry binding 条目的
/// 目标版本。Profile 无 binding 或 snapshot 中无对应条目时返回 `None`,调用方
/// 回退 [`InstallCandidateSource::BuiltInProfile`](Profile 锁版本)。
pub fn registry_target_for_built_in_update(
    catalog: &BuiltInProfileCatalog,
    snapshot: &RegistrySnapshot,
    agent_id: &AgentId,
) -> Option<RegistryAddTarget> {
    let profile = catalog.profile(agent_id)?;
    let binding = profile.registry_binding.as_ref()?;
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.registry_id == binding.registry_id)?;
    let mut target = entry.lock_add_target(snapshot.id);
    target.agent_id = profile.agent_id.clone();
    Some(target)
}

fn package_component(
    package: &RegistryPackageDistribution,
    distribution_kind: PlannedDistributionKind,
) -> PlannedInstallComponent {
    PlannedInstallComponent {
        component_id: "combined_runtime".to_string(),
        distribution_kind,
        version: String::new(),
        resolved_source: package.package.clone(),
        command: match distribution_kind {
            PlannedDistributionKind::Npx => "npm".to_string(),
            PlannedDistributionKind::Uvx => "uv".to_string(),
            PlannedDistributionKind::Binary => unreachable!(),
        },
        args: package.args.clone(),
        env: package.env.clone(),
        trust: package
            .integrity
            .clone()
            .map_or(ArtifactTrust::EcosystemIntegrityRequired, |integrity| {
                ArtifactTrust::EcosystemIntegrity { integrity }
            }),
    }
}

fn plan_profile_component(
    source: &ProfileInstallSource,
    input: &InstallPlanningInput,
) -> Result<PlannedInstallComponent, InstallPlanningError> {
    match source {
        ProfileInstallSource::Npx {
            component,
            package,
            version,
            command,
            args,
            integrity,
            ..
        } => {
            if !input.environment.node_verified {
                return Err(InstallPlanningError::RuntimeUnavailable { runtime: "node" });
            }
            Ok(PlannedInstallComponent {
                component_id: component_id(*component).to_string(),
                distribution_kind: PlannedDistributionKind::Npx,
                version: (*version).to_string(),
                resolved_source: format!("{package}@{version}"),
                command: (*command).to_string(),
                args: args.iter().map(ToString::to_string).collect(),
                env: Default::default(),
                trust: ArtifactTrust::EcosystemIntegrity {
                    integrity: (*integrity).to_string(),
                },
            })
        }
        ProfileInstallSource::Uvx {
            component,
            package,
            version,
            command,
            args,
            ..
        } => {
            if !input.environment.uv_verified {
                return Err(InstallPlanningError::RuntimeUnavailable { runtime: "uv" });
            }
            Ok(PlannedInstallComponent {
                component_id: component_id(*component).to_string(),
                distribution_kind: PlannedDistributionKind::Uvx,
                version: (*version).to_string(),
                resolved_source: (*package).to_string(),
                command: (*command).to_string(),
                args: args.iter().map(ToString::to_string).collect(),
                env: Default::default(),
                trust: ArtifactTrust::EcosystemIntegrityRequired,
            })
        }
        ProfileInstallSource::Binary {
            component,
            version,
            command,
            args,
            artifacts,
            entry,
        } => {
            let artifact = artifacts
                .iter()
                .find(|artifact| artifact.platform == input.platform)
                .ok_or_else(|| InstallPlanningError::UnsupportedPlatform {
                    agent_id: input.agent_id.clone(),
                    platform: input.platform.clone(),
                })?;
            Ok(PlannedInstallComponent {
                component_id: component_id(*component).to_string(),
                distribution_kind: PlannedDistributionKind::Binary,
                version: (*version).to_string(),
                resolved_source: artifact.archive_url.to_string(),
                command: entry.as_ref().map_or_else(
                    || (*command).to_string(),
                    |entry| {
                        if input.platform.starts_with("windows-") {
                            entry.windows.to_string()
                        } else {
                            entry.unix.to_string()
                        }
                    },
                ),
                args: args.iter().map(ToString::to_string).collect(),
                env: Default::default(),
                trust: artifact.sha256.map_or(ArtifactTrust::Tofu, |sha256| {
                    ArtifactTrust::ExpectedSha256 {
                        sha256: sha256.to_string(),
                    }
                }),
            })
        }
    }
}

fn component_id(component: ProfileComponent) -> &'static str {
    match component {
        ProfileComponent::AgentRuntime => "agent_runtime",
        ProfileComponent::AcpAdapter => "acp_adapter",
        ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

fn ensure_package_version(
    package: &RegistryPackageDistribution,
    version: &str,
    python: bool,
) -> Result<(), InstallPlanningError> {
    let locked = if python {
        package.package.ends_with(&format!("=={version}"))
            || package.package.ends_with(&format!("@{version}"))
    } else {
        package.package.ends_with(&format!("@{version}"))
    };
    if locked {
        Ok(())
    } else {
        Err(InstallPlanningError::UnlockedPackageVersion {
            package: package.package.clone(),
            version: version.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TofuFingerprint {
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactVerification {
    pub sha256: String,
    pub tofu_fingerprint: Option<TofuFingerprint>,
}

pub fn verify_artifact_bytes(
    trust: &ArtifactTrust,
    bytes: &[u8],
    previous_tofu: Option<&TofuFingerprint>,
) -> Result<ArtifactVerification, InstallPlanningError> {
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    match trust {
        ArtifactTrust::ExpectedSha256 { sha256: expected } if expected != &sha256 => {
            return Err(InstallPlanningError::HashMismatch {
                expected: expected.clone(),
                actual: sha256,
            });
        }
        ArtifactTrust::EcosystemIntegrity { integrity } => {
            let expected = integrity.strip_prefix("sha512-").ok_or_else(|| {
                InstallPlanningError::InvalidEcosystemIntegrity(integrity.clone())
            })?;
            let expected = STANDARD
                .decode(expected)
                .map_err(|_| InstallPlanningError::InvalidEcosystemIntegrity(integrity.clone()))?;
            let actual = Sha512::digest(bytes);
            if expected.as_slice() != &actual[..] {
                return Err(InstallPlanningError::HashMismatch {
                    expected: integrity.clone(),
                    actual: format!("sha512-{}", STANDARD.encode(actual)),
                });
            }
        }
        ArtifactTrust::EcosystemIntegrityRequired => {
            return Err(InstallPlanningError::InvalidEcosystemIntegrity(
                "ecosystem metadata must be resolved before verification".to_string(),
            ));
        }
        ArtifactTrust::Tofu => {
            if let Some(previous) = previous_tofu
                && previous.sha256 != sha256
            {
                return Err(InstallPlanningError::TofuChanged {
                    expected: previous.sha256.clone(),
                    actual: sha256,
                });
            }
            return Ok(ArtifactVerification {
                sha256: sha256.clone(),
                tofu_fingerprint: Some(TofuFingerprint { sha256 }),
            });
        }
        _ => {}
    }
    Ok(ArtifactVerification {
        sha256,
        tofu_fingerprint: None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionEvidence {
    pub source: String,
    pub version: String,
}

impl VersionEvidence {
    pub fn new(source: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            version: version.into(),
        }
    }
}

pub fn verify_version_evidence(
    locked_version: &str,
    evidence: &[VersionEvidence],
) -> Result<(), InstallPlanningError> {
    for item in evidence {
        let actual = item.version.trim().trim_start_matches('v');
        if actual != locked_version {
            return Err(InstallPlanningError::VersionEvidenceConflict {
                evidence_source: item.source.clone(),
                expected: locked_version.to_string(),
                actual: item.version.clone(),
            });
        }
    }
    Ok(())
}
