//! Conversation read commands.
//!
//! Composes the DB-side conversation metadata (`DbConversationSummary` over the
//! `sessions` row) with the transcript re-parsed on demand from the bound agent
//! session file (`parsers::loader`). The DB never stores turns; this is where the
//! metadata + re-parse halves meet into the `DbConversationDetail` the frontend
//! renders. VibeX-authored.

use agents::{
    agent_type_from_executor_key,
    conversation::{MessageTurn, SessionStats},
    parsers::loader,
};
use db::models::conversation::DbConversationSummary;
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

/// A conversation's metadata plus its re-parsed transcript.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DbConversationDetail {
    pub summary: DbConversationSummary,
    pub turns: Vec<MessageTurn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_stats: Option<SessionStats>,
    /// The persisted user turn currently being answered, if a turn is in flight.
    /// Reconciled with the live stream on the frontend so a mid-turn load renders
    /// seamlessly. (Populated by the live pipeline; `None` for settled loads.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_flight_user_turn_id: Option<String>,
}

/// Re-parse the transcript for a conversation's bound agent session. Missing
/// binding / parser / file yields an empty transcript (metadata still renders),
/// never an error.
fn load_transcript(summary: &DbConversationSummary) -> (Vec<MessageTurn>, Option<SessionStats>) {
    let (Some(external_id), Some(agent_str)) = (
        summary.external_session_id.as_deref(),
        summary.agent_type.as_deref(),
    ) else {
        return (Vec::new(), None);
    };
    let Some(agent_type) = agent_type_from_executor_key(agent_str) else {
        return (Vec::new(), None);
    };

    match loader::load_conversation_detail(agent_type, external_id, None) {
        Ok(Some(detail)) => (detail.turns, detail.session_stats),
        Ok(None) => (Vec::new(), None),
        Err(error) => {
            tracing::warn!(
                conversation = %summary.id,
                %error,
                "failed to re-parse agent session transcript"
            );
            (Vec::new(), None)
        }
    }
}

pub async fn conversation_detail_core(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<DbConversationDetail>, AppError> {
    let Some(summary) = DbConversationSummary::find_by_id(pool, id).await? else {
        return Ok(None);
    };
    let (turns, session_stats) = load_transcript(&summary);
    Ok(Some(DbConversationDetail {
        summary,
        turns,
        session_stats,
        in_flight_user_turn_id: None,
    }))
}

#[tauri::command]
pub async fn conversation_detail(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Option<DbConversationDetail>, AppError> {
    let id = Uuid::parse_str(&session_id)
        .map_err(|error| AppError::BadRequest(format!("invalid session id: {error}")))?;
    conversation_detail_core(&state.deployment.db().pool, id).await
}

#[tauri::command]
pub async fn conversation_list(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<DbConversationSummary>, AppError> {
    let workspace_id = Uuid::parse_str(&workspace_id)
        .map_err(|error| AppError::BadRequest(format!("invalid workspace id: {error}")))?;
    DbConversationSummary::list_for_workspace(&state.deployment.db().pool, workspace_id)
        .await
        .map_err(Into::into)
}
