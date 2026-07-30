//! Pure management-state reduction and read-only built-in candidate policy.

use std::path::PathBuf;

use api_types::{AgentAuthenticationStatus, AgentId, AgentLifecycleState};

use crate::profiles::{BuiltInProfileCatalog, ProfileExternalCandidate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagementOperationState {
    Queued,
    Installing,
    Updating,
    Repairing,
}

impl ManagementOperationState {
    fn lifecycle(self) -> AgentLifecycleState {
        match self {
            Self::Queued => AgentLifecycleState::Queued,
            Self::Installing => AgentLifecycleState::Installing,
            Self::Updating => AgentLifecycleState::Updating,
            Self::Repairing => AgentLifecycleState::Repairing,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentProbeState {
    Verified,
    Missing,
    PathNotAbsolute,
    VersionMismatch,
    HashMismatch,
    AcpHandshakeFailed,
    Damaged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredComponentProbe {
    pub component_id: String,
    pub state: ComponentProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagementFacts {
    pub agent_id: AgentId,
    pub enabled: bool,
    pub retired: bool,
    pub platform_supported: bool,
    pub operation: Option<ManagementOperationState>,
    pub installation_present: bool,
    pub required_components: Vec<RequiredComponentProbe>,
    pub authentication: AgentAuthenticationStatus,
    pub authentication_required: bool,
    pub configuration_required: bool,
    pub configuration_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentManagementSnapshot {
    pub agent_id: AgentId,
    pub enabled: bool,
    pub lifecycle: AgentLifecycleState,
    pub authentication: AgentAuthenticationStatus,
    pub required_components: Vec<RequiredComponentProbe>,
}

pub fn reduce_management_snapshot(facts: ManagementFacts) -> AgentManagementSnapshot {
    let lifecycle = if facts.retired {
        AgentLifecycleState::Retired
    } else if !facts.platform_supported {
        AgentLifecycleState::PlatformUnsupported
    } else if let Some(operation) = facts.operation {
        operation.lifecycle()
    } else if !facts.installation_present {
        AgentLifecycleState::Uninstalled
    } else if facts.required_components.is_empty()
        || facts
            .required_components
            .iter()
            .any(|component| component.state != ComponentProbeState::Verified)
    {
        AgentLifecycleState::NeedsRepair
    } else if facts.authentication_required
        && matches!(
            facts.authentication,
            AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
        )
    {
        AgentLifecycleState::NeedsAuth
    } else if facts.configuration_required && !facts.configuration_present {
        AgentLifecycleState::NeedsConfig
    } else {
        AgentLifecycleState::Ready
    };

    AgentManagementSnapshot {
        agent_id: facts.agent_id,
        enabled: facts.enabled,
        lifecycle,
        authentication: facts.authentication,
        required_components: facts.required_components,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalCandidateObservation {
    pub component_id: String,
    pub absolute_path: PathBuf,
    pub version: Option<String>,
    pub version_verified: bool,
    pub hash_verified: bool,
    pub acp_handshake_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedExternalRuntime {
    pub agent_id: AgentId,
    pub component_id: String,
    pub absolute_path: PathBuf,
    pub version: String,
}

/// Policy-only service. Filesystem/process/hash/ACP adapters collect an
/// observation; this service cannot mutate or install anything.
pub struct ProbeService {
    profiles: BuiltInProfileCatalog,
}

impl ProbeService {
    pub fn bundled() -> Self {
        Self {
            profiles: BuiltInProfileCatalog::bundled(),
        }
    }

    /// Generic Registry Agents deliberately have no implicit local detection.
    pub fn external_candidates(&self, agent_id: &AgentId) -> Vec<ProfileExternalCandidate> {
        self.profiles
            .profile(agent_id)
            .map(|profile| profile.external_candidates.to_vec())
            .unwrap_or_default()
    }

    /// Attach an external candidate only after every required read-only check
    /// has been completed by the boundary adapter.
    pub fn adopt_external_candidate(
        &self,
        agent_id: &AgentId,
        observation: ExternalCandidateObservation,
    ) -> Option<VerifiedExternalRuntime> {
        self.profiles.profile(agent_id)?;
        let version = observation
            .version
            .filter(|version| !version.trim().is_empty())?;
        if !observation.absolute_path.is_absolute()
            || !observation.version_verified
            || !observation.hash_verified
            || !observation.acp_handshake_verified
        {
            return None;
        }
        Some(VerifiedExternalRuntime {
            agent_id: agent_id.clone(),
            component_id: observation.component_id,
            absolute_path: observation.absolute_path,
            version,
        })
    }
}
