use agents::PlanUsageResult;
use api_types::AgentId;
use services::services::agent_plan_usage::AgentPlanUsageApplicationService;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn agent_plan_usage(
    state: State<'_, AppState>,
    agent_id: AgentId,
) -> Result<PlanUsageResult, String> {
    let pool = state.deployment.db().pool.clone();
    Ok(AgentPlanUsageApplicationService::read_with_pool(&pool, &agent_id).await)
}
