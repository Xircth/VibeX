use std::path::PathBuf;

use agents::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, ComponentProbeState,
    ExternalCandidateObservation, ManagementFacts, ManagementOperationState, ProbeService,
    RequiredComponentProbe, SessionAuthenticationEvidence, installation_is_complete,
    reduce_management_snapshot, resolve_session_authentication_evidence,
};

fn facts() -> ManagementFacts {
    ManagementFacts {
        agent_id: AgentId::parse("vendor.agent-v2").unwrap(),
        enabled: true,
        retired: false,
        platform_supported: true,
        operation: None,
        installation_present: true,
        required_components: vec![RequiredComponentProbe {
            component_id: "runtime".to_string(),
            state: ComponentProbeState::Verified,
        }],
        authentication: AgentAuthenticationStatus::NotRequired,
        authentication_required: false,
        configuration_required: false,
        configuration_present: true,
    }
}

#[test]
fn management_snapshot_has_status_precedence() {
    let ready = reduce_management_snapshot(facts());
    assert_eq!(ready.lifecycle, AgentLifecycleState::Ready);

    let mut disabled = facts();
    disabled.enabled = false;
    let disabled = reduce_management_snapshot(disabled);
    assert_eq!(disabled.lifecycle, AgentLifecycleState::Ready);
    assert!(!disabled.enabled);

    let mut needs_auth = facts();
    needs_auth.authentication_required = true;
    needs_auth.authentication = AgentAuthenticationStatus::NotLoggedIn;
    assert_eq!(
        reduce_management_snapshot(needs_auth).lifecycle,
        AgentLifecycleState::NeedsAuth
    );

    let mut needs_repair = facts();
    needs_repair.required_components[0].state = ComponentProbeState::HashMismatch;
    needs_repair.authentication_required = true;
    needs_repair.authentication = AgentAuthenticationStatus::NotLoggedIn;
    assert_eq!(
        reduce_management_snapshot(needs_repair).lifecycle,
        AgentLifecycleState::NeedsRepair
    );

    let mut operating = facts();
    operating.required_components[0].state = ComponentProbeState::Missing;
    operating.operation = Some(ManagementOperationState::Updating);
    assert_eq!(
        reduce_management_snapshot(operating).lifecycle,
        AgentLifecycleState::Updating
    );

    let mut unsupported = facts();
    unsupported.operation = Some(ManagementOperationState::Installing);
    unsupported.platform_supported = false;
    assert_eq!(
        reduce_management_snapshot(unsupported).lifecycle,
        AgentLifecycleState::PlatformUnsupported
    );

    let mut retired = facts();
    retired.platform_supported = false;
    retired.retired = true;
    assert_eq!(
        reduce_management_snapshot(retired).lifecycle,
        AgentLifecycleState::Retired
    );

    let mut uninstalled = facts();
    uninstalled.installation_present = false;
    uninstalled.required_components.clear();
    assert_eq!(
        reduce_management_snapshot(uninstalled).lifecycle,
        AgentLifecycleState::Uninstalled
    );
}

#[test]
fn installation_is_complete_when_runtime_and_acp_are_verified() {
    assert!(installation_is_complete(AgentLifecycleState::Ready));
    assert!(installation_is_complete(AgentLifecycleState::NeedsAuth));
    assert!(installation_is_complete(AgentLifecycleState::NeedsConfig));
    assert!(!installation_is_complete(AgentLifecycleState::Uninstalled));
    assert!(!installation_is_complete(AgentLifecycleState::NeedsRepair));
    assert!(!installation_is_complete(AgentLifecycleState::Installing));
}

#[test]
fn probe_service_only_adopts_fully_verified_profile_candidates() {
    let service = ProbeService::bundled();
    let codex = AgentId::parse("codex").unwrap();
    let generic = AgentId::parse("vendor.agent-v2").unwrap();
    assert!(!service.external_candidates(&codex).is_empty());
    assert!(service.external_candidates(&generic).is_empty());

    let candidate = ExternalCandidateObservation {
        component_id: "runtime".to_string(),
        absolute_path: PathBuf::from("/opt/codex"),
        version: Some("0.146.0".to_string()),
        version_verified: true,
        hash_verified: true,
        acp_handshake_verified: true,
    };
    assert!(
        service
            .adopt_external_candidate(&codex, candidate.clone())
            .is_some()
    );

    for invalid in [
        ExternalCandidateObservation {
            absolute_path: PathBuf::from("codex"),
            ..candidate.clone()
        },
        ExternalCandidateObservation {
            hash_verified: false,
            ..candidate.clone()
        },
        ExternalCandidateObservation {
            acp_handshake_verified: false,
            ..candidate
        },
    ] {
        assert!(service.adopt_external_candidate(&codex, invalid).is_none());
    }
}

#[test]
fn session_ready_agent_can_use_an_authentication_free_provider() {
    let resolved = resolve_session_authentication_evidence(
        AgentAuthenticationStatus::NotLoggedIn,
        SessionAuthenticationEvidence::SessionReady,
    );

    assert_eq!(
        resolved.authentication,
        AgentAuthenticationStatus::NotRequired
    );
    assert!(!resolved.authentication_required);
}

#[test]
fn session_authentication_requirement_overrides_a_generic_no_auth_assumption() {
    let resolved = resolve_session_authentication_evidence(
        AgentAuthenticationStatus::NotRequired,
        SessionAuthenticationEvidence::AuthenticationRequired,
    );

    assert_eq!(
        resolved.authentication,
        AgentAuthenticationStatus::NotLoggedIn
    );
    assert!(resolved.authentication_required);
}

#[test]
fn ambiguous_credentials_do_not_block_a_confirmed_ready_session() {
    let resolved = resolve_session_authentication_evidence(
        AgentAuthenticationStatus::MultipleUnknown,
        SessionAuthenticationEvidence::SessionReady,
    );

    assert_eq!(
        resolved.authentication,
        AgentAuthenticationStatus::MultipleUnknown
    );
    assert!(!resolved.authentication_required);
}
