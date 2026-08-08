//! Application boundary for reading an Agent's subscription usage.

use agents::{AgentId, PlanUsageResult};

pub struct AgentPlanUsageApplicationService;

impl AgentPlanUsageApplicationService {
    pub async fn read(agent_id: &AgentId) -> PlanUsageResult {
        agents::probe_plan_usage(agent_id).await
    }
}
