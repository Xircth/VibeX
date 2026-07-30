//! Pure, version-locked installation planning and artifact trust checks.

use api_types::AgentId;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256, Sha512};
use uuid::Uuid;

use crate::{
    ProfileComponent, ProfileInstallSource, RegistryAddTarget, RegistryPackageDistribution,
    profiles::BuiltInProfileCatalog,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallCandidateSource {
    BuiltInProfile,
    Registry(Box<RegistryAddTarget>),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlannedDistributionKind {
    Binary,
    Npx,
    Uvx,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactTrust {
    ExpectedSha256 { sha256: String },
    EcosystemIntegrity { integrity: String },
    EcosystemIntegrityRequired,
    Tofu,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockedInstallSource {
    BuiltInProfile,
    OfficialRegistry {
        snapshot_id: Uuid,
        registry_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedInstallPlan {
    pub agent_id: AgentId,
    pub source: LockedInstallSource,
    pub version: String,
    pub platform: String,
    pub components: Vec<PlannedInstallComponent>,
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
            InstallCandidateSource::Registry(target) => self.plan_registry(input, *target),
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
        if let Some(binary) = target
            .distributions
            .binary
            .as_ref()
            .and_then(|targets| targets.get(&input.platform))
            .cloned()
        {
            let trust = binary
                .sha256
                .as_ref()
                .map(|sha256| ArtifactTrust::ExpectedSha256 {
                    sha256: sha256.to_ascii_lowercase(),
                })
                .unwrap_or(ArtifactTrust::Tofu);
            return Ok(registry_plan(
                input,
                target,
                PlannedInstallComponent {
                    component_id: "combined_runtime".to_string(),
                    distribution_kind: PlannedDistributionKind::Binary,
                    version: String::new(),
                    resolved_source: binary.archive,
                    command: binary.cmd,
                    args: binary.args,
                    env: binary.env,
                    trust,
                },
            ));
        }
        if input.environment.node_verified
            && let Some(npx) = target.distributions.npx.clone()
        {
            ensure_package_version(&npx, &target.version, false)?;
            return Ok(registry_plan(
                input,
                target,
                package_component(&npx, PlannedDistributionKind::Npx),
            ));
        }
        if input.environment.uv_verified
            && input.environment.python_verified
            && let Some(uvx) = target.distributions.uvx.clone()
        {
            ensure_package_version(&uvx, &target.version, true)?;
            return Ok(registry_plan(
                input,
                target,
                package_component(&uvx, PlannedDistributionKind::Uvx),
            ));
        }
        Err(InstallPlanningError::UnsupportedPlatform {
            agent_id: input.agent_id,
            platform: input.platform,
        })
    }
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
        trust: ArtifactTrust::EcosystemIntegrityRequired,
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
        ProfileInstallSource::Binary {
            component,
            version,
            command,
            args,
            artifacts,
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
                command: (*command).to_string(),
                args: args.iter().map(ToString::to_string).collect(),
                env: Default::default(),
                trust: ArtifactTrust::ExpectedSha256 {
                    sha256: artifact.sha256.to_string(),
                },
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
