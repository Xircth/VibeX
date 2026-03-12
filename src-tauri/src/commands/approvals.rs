use deployment::Deployment;
use utils::approvals::{ApprovalResponse, ApprovalStatus};

use crate::{error::AppError, state::AppState};

#[tauri::command]
pub async fn respond_to_approval(
    state: tauri::State<'_, AppState>,
    approval_id: String,
    response: ApprovalResponse,
) -> Result<ApprovalStatus, AppError> {
    let service = state.deployment.approvals();

    match service
        .respond(&state.deployment.db().pool, &approval_id, response)
        .await
    {
        Ok((status, _context)) => Ok(status),
        Err(e) => {
            tracing::error!("Failed to respond to approval: {:?}", e);
            Err(AppError::Internal(format!(
                "Failed to respond to approval: {}",
                e
            )))
        }
    }
}
