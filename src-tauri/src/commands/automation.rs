//! Automations (P0-3): headless, schedulable "start a turn" configurations.
//!
//! A run launches a real session + turn in the background; the linked
//! conversation shows the agent's actual work. A run's status tracks the
//! LAUNCH: `running` while launching, `completed` once the turn was launched,
//! `failed` if launching errored, `interrupted` if the host died mid-launch.
//! Cron schedules are evaluated in LOCAL time; missed ticks are not backfilled
//! (only `next_run_at` is recomputed forward).

use std::time::Duration;

use agents::AgentKind;
use chrono::{DateTime, Local, TimeZone, Utc};
use db::models::{
    automation::{Automation, AutomationInput, AutomationRun},
    session::{CreateSession, Session},
};
use services::services::automation::CronSchedule;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    commands::sessions::resolve_project_workspace,
    conversation_service::{ConversationSessionService, ConversationStartTurnInput},
    error::AppError,
    state::AppState,
};

const POLL_INTERVAL_SECS: u64 = 30;

/// Next fire time strictly after now, in local time, as UTC for storage.
fn next_run_after_now(cron: &str) -> Option<DateTime<Utc>> {
    let schedule = CronSchedule::parse(cron).ok()?;
    let next_local = schedule.next_after(Local::now().naive_local())?;
    Local
        .from_local_datetime(&next_local)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Recompute `next_run_at` for a saved automation: the next cron tail when
/// cron-triggered and enabled, else `None`.
fn compute_next_run(input: &AutomationInput) -> Option<DateTime<Utc>> {
    if input.enabled && input.trigger_kind == "cron" {
        input.cron.as_deref().and_then(next_run_after_now)
    } else {
        None
    }
}

// ── CRUD commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn automation_list(state: tauri::State<'_, AppState>) -> Result<Vec<Automation>, AppError> {
    Automation::list(&state.deployment.db().pool)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_create(
    state: tauri::State<'_, AppState>,
    input: AutomationInput,
) -> Result<Automation, AppError> {
    let next = compute_next_run(&input);
    Automation::create(&state.deployment.db().pool, Uuid::new_v4(), &input, next)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_update(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    input: AutomationInput,
) -> Result<Automation, AppError> {
    let next = compute_next_run(&input);
    Automation::update(&state.deployment.db().pool, id, &input, next)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_set_enabled(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    enabled: bool,
) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;
    let Some(automation) = Automation::find_by_id(pool, id).await? else {
        return Err(AppError::NotFound(format!("automation {id} not found")));
    };
    let next = if enabled && automation.trigger_kind == "cron" {
        automation.cron.as_deref().and_then(next_run_after_now)
    } else {
        None
    };
    Automation::set_enabled(pool, id, enabled, next)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_delete(state: tauri::State<'_, AppState>, id: Uuid) -> Result<(), AppError> {
    Automation::delete(&state.deployment.db().pool, id)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_runs(
    state: tauri::State<'_, AppState>,
    automation_id: Uuid,
    limit: Option<i64>,
) -> Result<Vec<AutomationRun>, AppError> {
    AutomationRun::list_for_automation(
        &state.deployment.db().pool,
        automation_id,
        limit.unwrap_or(20).clamp(1, 200),
    )
    .await
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_unseen_failures(state: tauri::State<'_, AppState>) -> Result<i64, AppError> {
    AutomationRun::unseen_failure_count(&state.deployment.db().pool)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn automation_mark_seen(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    AutomationRun::mark_all_seen(&state.deployment.db().pool)
        .await
        .map_err(AppError::from)
}

/// Fire an automation on demand. Returns the created run.
#[tauri::command]
pub async fn automation_run_now(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<AutomationRun, AppError> {
    let pool = state.deployment.db().pool.clone();
    let Some(automation) = Automation::find_by_id(&pool, id).await? else {
        return Err(AppError::NotFound(format!("automation {id} not found")));
    };
    let run_id = fire(state.inner(), &automation).await;
    AutomationRun::find_by_id(&pool, run_id)
        .await?
        .ok_or_else(|| AppError::Internal("run vanished after creation".to_string()))
}

// ── Run execution ──────────────────────────────────────────────────────────

/// Record a run, launch the session+turn, and settle the run's launch status.
async fn fire(state: &AppState, automation: &Automation) -> Uuid {
    let pool = &state.deployment.db().pool;
    let run_id = Uuid::new_v4();

    match launch(state, automation).await {
        Ok(conversation_id) => {
            let _ = AutomationRun::start(pool, run_id, automation.id, Some(conversation_id)).await;
            let summary = format!("已启动会话 {}", &conversation_id.to_string()[..8]);
            let _ = AutomationRun::finish(pool, run_id, "completed", Some(&summary), None).await;
        }
        Err(error) => {
            let _ = AutomationRun::start(pool, run_id, automation.id, None).await;
            let _ = AutomationRun::finish(pool, run_id, "failed", None, Some(&error.to_string())).await;
        }
    }
    run_id
}

/// Create a workspace + session and start the automation's turn headlessly.
async fn launch(state: &AppState, automation: &Automation) -> Result<Uuid, AppError> {
    let pool = &state.deployment.db().pool;

    // v1 supports in-place isolation (the project's root workspace).
    let workspace = resolve_project_workspace(state, automation.project_id, None).await?;
    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let executor = automation.executor.clone().unwrap_or_default();
    let agent_type = AgentKind::from_lenient(&executor)
        .ok_or_else(|| AppError::BadRequest(format!("automation has no valid executor: {executor:?}")))?;

    let session = Session::create(
        pool,
        &CreateSession {
            executor: automation.executor.clone(),
            task_id: Some(workspace.task_id),
            name: Some(automation.name.clone()),
            initial_prompt: Some(automation.prompt.clone()),
            status: None,
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await?;

    ConversationSessionService::new(state.conversation_context())
        .start_turn(ConversationStartTurnInput {
            agent_type,
            workspace_id: workspace.id,
            conversation_id: session.id,
            executor_profile_id: None,
            text: automation.prompt.clone(),
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
        })
        .await?;

    Ok(session.id)
}

// ── Scheduler ──────────────────────────────────────────────────────────────

/// Drive orphaned `running` automation runs to `interrupted` on startup
/// (the host died mid-launch); called before the scheduler starts.
pub async fn recover_automation_runs(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    let count = AutomationRun::interrupt_orphans(pool).await?;
    if count > 0 {
        tracing::info!("marked {count} orphaned automation run(s) as interrupted");
    }
    Ok(())
}

/// Background poller: every interval, fire due cron automations and roll their
/// `next_run_at` forward. Reschedule happens BEFORE the launch so a slow launch
/// can't delay the next tick.
pub fn start_automation_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
            let state = app.state::<AppState>();
            let pool = state.deployment.db().pool.clone();
            let due = match Automation::due(&pool, Utc::now()).await {
                Ok(due) => due,
                Err(error) => {
                    tracing::warn!("automation scheduler query failed: {error}");
                    continue;
                }
            };
            for automation in due {
                let next = automation.cron.as_deref().and_then(next_run_after_now);
                let _ = Automation::set_next_run(&pool, automation.id, next).await;
                fire(state.inner(), &automation).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cron_trigger_computes_next_run() {
        let input = AutomationInput {
            name: "nightly".into(),
            project_id: Uuid::new_v4(),
            executor: Some("CLAUDE_CODE".into()),
            prompt: "run tests".into(),
            isolation: "in_place".into(),
            trigger_kind: "cron".into(),
            cron: Some("0 3 * * *".into()),
            enabled: true,
        };
        assert!(compute_next_run(&input).is_some());
    }

    #[test]
    fn manual_or_disabled_has_no_next_run() {
        let mut input = AutomationInput {
            name: "manual".into(),
            project_id: Uuid::new_v4(),
            executor: None,
            prompt: "x".into(),
            isolation: "in_place".into(),
            trigger_kind: "manual".into(),
            cron: None,
            enabled: true,
        };
        assert!(compute_next_run(&input).is_none());
        input.trigger_kind = "cron".into();
        input.cron = Some("0 3 * * *".into());
        input.enabled = false;
        assert!(compute_next_run(&input).is_none());
    }
}
