//! Management eligibility gate for every new session, rebind and turn.

use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
};

use api_types::{AgentId, AgentLifecycleState};
use serde_json::Value;

use crate::{AgentManagementSnapshot, AgentSessionConfigOption};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionDefaultValidation {
    pub valid: BTreeMap<String, Value>,
    pub stale_ids: Vec<String>,
}

/// Validate persisted raw ACP option/value pairs against the exact options
/// advertised by the newly prepared session. A catalog or historical option
/// label is never sufficient evidence for sending a saved value.
pub fn validate_session_defaults(
    defaults: BTreeMap<String, Value>,
    advertised_options: &[AgentSessionConfigOption],
) -> SessionDefaultValidation {
    let mut validation = SessionDefaultValidation::default();
    for (option_id, value) in defaults {
        let valid = advertised_options
            .iter()
            .find(|option| option.key == option_id)
            .is_some_and(|option| {
                if option.choices.is_empty() {
                    option.value.as_ref().is_some_and(Value::is_boolean) && value.is_boolean()
                } else {
                    option.choices.iter().any(|choice| choice.value == value)
                }
            });
        if valid {
            validation.valid.insert(option_id, value);
        } else {
            validation.stale_ids.push(option_id);
        }
    }
    validation.stale_ids.sort();
    validation
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLaunchLock {
    pub agent_id: AgentId,
    pub absolute_acp_program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub runtime_version: String,
    pub acp_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionBinding {
    pub agent_id: AgentId,
    pub event_boundary_sequence: u64,
}

#[derive(Debug, Clone)]
pub struct SessionGateInput {
    pub snapshot: AgentManagementSnapshot,
    pub current_lock: Option<SessionLaunchLock>,
    pub requested_defaults: BTreeMap<String, Value>,
    pub advertised_option_ids: Vec<String>,
    pub existing_binding: Option<SessionBinding>,
    pub explicit_rebind: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionLaunchAuthorization {
    pub agent_id: AgentId,
    pub absolute_acp_program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub runtime_version: String,
    pub acp_version: String,
    pub defaults: BTreeMap<String, Value>,
    pub stale_default_ids: Vec<String>,
    pub rebind_event_boundary_sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionGateError {
    #[error("Agent is disabled")]
    Disabled,
    #[error("retired Agent cannot start a session")]
    Retired,
    #[error("Agent is not ready: {0:?}")]
    NotReady(AgentLifecycleState),
    #[error("Agent has no current Installation lock")]
    MissingLock,
    #[error("Installation lock belongs to another Agent")]
    LockAgentMismatch,
    #[error("Installation lock does not contain an absolute ACP program")]
    InvalidLaunchPath,
    #[error("changing the Agent binding requires an explicit rebind")]
    ExplicitRebindRequired,
}

pub struct SessionGate;

impl SessionGate {
    pub fn authorize(
        &self,
        input: SessionGateInput,
    ) -> Result<SessionLaunchAuthorization, SessionGateError> {
        if input.snapshot.lifecycle == AgentLifecycleState::Retired {
            return Err(SessionGateError::Retired);
        }
        if !input.snapshot.enabled {
            return Err(SessionGateError::Disabled);
        }
        if input.snapshot.lifecycle != AgentLifecycleState::Ready {
            return Err(SessionGateError::NotReady(input.snapshot.lifecycle));
        }
        let lock = input.current_lock.ok_or(SessionGateError::MissingLock)?;
        if lock.agent_id != input.snapshot.agent_id {
            return Err(SessionGateError::LockAgentMismatch);
        }
        if !lock.absolute_acp_program.is_absolute() {
            return Err(SessionGateError::InvalidLaunchPath);
        }

        let rebind_event_boundary_sequence = match input.existing_binding {
            Some(binding) if binding.agent_id != input.snapshot.agent_id => {
                if !input.explicit_rebind {
                    return Err(SessionGateError::ExplicitRebindRequired);
                }
                Some(binding.event_boundary_sequence.saturating_add(1))
            }
            _ => None,
        };

        let advertised = input
            .advertised_option_ids
            .into_iter()
            .collect::<HashSet<_>>();
        let mut defaults = BTreeMap::new();
        let mut stale_default_ids = Vec::new();
        for (option_id, value) in input.requested_defaults {
            if advertised.contains(&option_id) {
                defaults.insert(option_id, value);
            } else {
                stale_default_ids.push(option_id);
            }
        }
        stale_default_ids.sort();
        Ok(SessionLaunchAuthorization {
            agent_id: input.snapshot.agent_id,
            absolute_acp_program: lock.absolute_acp_program,
            args: lock.args,
            env: lock.env,
            runtime_version: lock.runtime_version,
            acp_version: lock.acp_version,
            defaults,
            stale_default_ids,
            rebind_event_boundary_sequence,
        })
    }
}
