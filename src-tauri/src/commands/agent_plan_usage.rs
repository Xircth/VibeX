use agents::PlanUsageResult;
use api_types::AgentId;
use services::services::agent_plan_usage::AgentPlanUsageApplicationService;

#[tauri::command]
pub async fn agent_plan_usage(agent_id: AgentId) -> PlanUsageResult {
    AgentPlanUsageApplicationService::read(&agent_id).await
}
