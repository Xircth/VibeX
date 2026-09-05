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

/// Fold stored defaults against the current catalog. Missing catalog evidence
/// keeps every stored option stale instead of inventing a usable value.
pub fn resolve_session_defaults(
    requested: BTreeMap<String, Value>,
    mut stale_ids: Vec<String>,
    advertised_options: Option<&[AgentSessionConfigOption]>,
) -> SessionDefaultValidation {
    let valid = match advertised_options {
        Some(options) => {
            let validation = validate_session_defaults(requested, options);
            stale_ids.extend(validation.stale_ids);
            validation.valid
        }
        None => {
            stale_ids.extend(requested.into_keys());
            BTreeMap::new()
        }
    };
    stale_ids.sort();
    stale_ids.dedup();
    SessionDefaultValidation { valid, stale_ids }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionGateError {
    Disabled,
    Retired,
    NotReady(AgentLifecycleState),
    MissingLock,
    LockAgentMismatch,
    InvalidLaunchPath,
    ExplicitRebindRequired,
}

impl std::fmt::Display for SessionGateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.user_message())
    }
}

impl std::error::Error for SessionGateError {}

impl SessionGateError {
    pub fn user_message(&self) -> &'static str {
        user_message_for(self)
    }
}

fn user_message_for(error: &SessionGateError) -> &'static str {
    match error {
        SessionGateError::Disabled => "This Agent is disabled.",
        SessionGateError::Retired => "This retired Agent cannot start a session.",
        SessionGateError::NotReady(AgentLifecycleState::NeedsAuth) => {
            "This Agent is not signed in."
        }
        SessionGateError::NotReady(AgentLifecycleState::NeedsConfig) => {
            "This Agent is missing required configuration."
        }
        SessionGateError::NotReady(AgentLifecycleState::PlatformUnsupported) => {
            "This Agent is not available on this system."
        }
        SessionGateError::NotReady(
            AgentLifecycleState::Queued
            | AgentLifecycleState::Installing
            | AgentLifecycleState::Updating
            | AgentLifecycleState::Repairing,
        ) => "This Agent is still installing or updating.",
        SessionGateError::NotReady(
            AgentLifecycleState::NeedsRepair | AgentLifecycleState::Uninstalled,
        )
        | SessionGateError::MissingLock => {
            "This Agent is not installed successfully. Repair or reinstall it in Settings."
        }
        SessionGateError::NotReady(AgentLifecycleState::Ready | AgentLifecycleState::Retired) => {
            "This Agent is not ready."
        }
        SessionGateError::LockAgentMismatch | SessionGateError::InvalidLaunchPath => {
            "This Agent's installation is invalid. Repair or reinstall it in Settings."
        }
        SessionGateError::ExplicitRebindRequired => {
            "changing the Agent binding requires an explicit rebind"
        }
    }
}

/// Attach the stored diagnostic output to a session-launch rejection so the
/// caller sees the install/repair root cause instead of leftover lock state.
pub fn session_launch_rejection_message(
    error: &SessionGateError,
    diagnostic_output: Option<&str>,
) -> String {
    let message = error.user_message();
    match diagnostic_output.and_then(diagnostic_output_excerpt) {
        Some(excerpt) => format!("{message}\n\n{excerpt}"),
        None => message.to_string(),
    }
}

pub fn diagnostic_output_excerpt(output: &str) -> Option<String> {
    let mut lines = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if is_stack_frame_line(line) {
            continue;
        }
        lines.push(line);
        if lines.len() == 8 {
            break;
        }
    }
    if lines.is_empty() {
        return None;
    }
    let mut excerpt = lines.join("\n");
    if excerpt.len() > 800 {
        excerpt.truncate(800);
    }
    Some(excerpt)
}

fn is_stack_frame_line(line: &str) -> bool {
    let trimmed = line
        .strip_prefix("npm error")
        .map(str::trim)
        .unwrap_or(line);
    trimmed.starts_with("at ")
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
