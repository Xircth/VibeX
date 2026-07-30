//! Ownership-aware uninstall/remove planning.

use api_types::AgentId;

pub const BUSY_LIFECYCLE_MESSAGE: &str = "此Agent还有正在执行的进程，暂时无法卸载/移除";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComponentOwnership {
    Managed,
    External,
    Shared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleComponent {
    pub component_id: String,
    pub ownership: ComponentOwnership,
    pub shared_reference_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleFacts {
    pub agent_id: AgentId,
    pub built_in: bool,
    pub active_acp_processes: usize,
    pub in_flight_turns: usize,
    pub queued_or_running_operations: usize,
    pub components: Vec<LifecycleComponent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleAction {
    Uninstall,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LifecycleBlockReason {
    #[error("{0}")]
    Busy(String),
    #[error("Built-in Agent cannot be removed")]
    BuiltInCannotBeRemoved,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecyclePlan {
    pub agent_id: AgentId,
    pub delete_component_ids: Vec<String>,
    pub remove_membership: bool,
}

pub struct LifecycleService;

impl LifecycleService {
    pub fn plan(
        &self,
        facts: &mut LifecycleFacts,
        action: LifecycleAction,
    ) -> Result<LifecyclePlan, LifecycleBlockReason> {
        if facts.active_acp_processes > 0
            || facts.in_flight_turns > 0
            || facts.queued_or_running_operations > 0
        {
            return Err(LifecycleBlockReason::Busy(
                BUSY_LIFECYCLE_MESSAGE.to_string(),
            ));
        }
        if action == LifecycleAction::Remove && facts.built_in {
            return Err(LifecycleBlockReason::BuiltInCannotBeRemoved);
        }
        let delete_component_ids = facts
            .components
            .iter()
            .filter(|component| match component.ownership {
                ComponentOwnership::Managed => true,
                ComponentOwnership::External => false,
                ComponentOwnership::Shared => component.shared_reference_count == 0,
            })
            .map(|component| component.component_id.clone())
            .collect();
        Ok(LifecyclePlan {
            agent_id: facts.agent_id.clone(),
            delete_component_ids,
            remove_membership: action == LifecycleAction::Remove,
        })
    }
}
