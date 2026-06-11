use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    session::{Session, SessionStatus},
};
use deployment::Deployment;
use services::services::container::ContainerService;

use super::{NATIVE_ACTIVE_TURNS, NativeProcessHandle, ProviderId, app_error_from_native};
use crate::{error::AppError, state::AppState};

pub(super) async fn remove_active_native_turn(turn_id: &str) -> Option<NativeProcessHandle> {
    NATIVE_ACTIVE_TURNS.lock().await.remove(turn_id)
}

#[cfg(test)]
pub(super) async fn register_active_native_turn_for_test(
    turn_id: String,
    handle: NativeProcessHandle,
) {
    NATIVE_ACTIVE_TURNS.lock().await.insert(turn_id, handle);
}

#[cfg(test)]
pub(super) async fn active_native_turn_provider(turn_id: &str) -> Option<ProviderId> {
    NATIVE_ACTIVE_TURNS
        .lock()
        .await
        .get(turn_id)
        .map(|handle| handle.provider)
}

pub(super) async fn kill_active_native_turn(
    state: &tauri::State<'_, AppState>,
    provider: ProviderId,
    turn_id: String,
) -> Result<(), AppError> {
    let Some(handle) = remove_active_native_turn(&turn_id).await else {
        return Err(AppError::NotFound(format!("Turn {turn_id} is not active")));
    };
    if handle.provider != provider {
        NATIVE_ACTIVE_TURNS
            .lock()
            .await
            .insert(turn_id.clone(), handle);
        return Err(AppError::BadRequest(format!(
            "Turn {turn_id} belongs to a different provider"
        )));
    }

    handle
        .child
        .lock()
        .await
        .kill()
        .await
        .map_err(|error| app_error_from_native(provider, error.to_string()))?;

    let pool = &state.deployment.db().pool;
    if let Err(error) = ExecutionProcess::update_completion(
        pool,
        handle.process_id,
        ExecutionProcessStatus::Killed,
        None,
    )
    .await
    {
        tracing::error!(
            "Failed to mark interrupted native provider process {} killed: {}",
            handle.process_id,
            error
        );
    }
    if let Err(error) =
        Session::update_status(pool, handle.session_id, SessionStatus::InReview).await
    {
        tracing::error!(
            "Failed to mark interrupted native provider session {} in review: {}",
            handle.session_id,
            error
        );
    }
    if let Some(msg_store) = state
        .deployment
        .container()
        .msg_stores()
        .write()
        .await
        .remove(&handle.process_id)
    {
        msg_store.push_finished();
    }

    Ok(())
}
