//! Durable delivery evidence for the one inline request used by Stage B.
use agents::conversation::ContinuationPolicy;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{ConversationStartTurnInput, continuation::HistorySelection};

pub(crate) async fn plan(
    pool: &SqlitePool,
    input: &ConversationStartTurnInput,
    turn_id: Uuid,
    source: Option<Uuid>,
    selection: Option<&HistorySelection>,
) -> Result<(), sqlx::Error> {
    let policy = match input.continuation_policy {
        Some(ContinuationPolicy::Portable) => "portable",
        _ => "fresh",
    };
    let payload = selection.map(|s| s.prompt.as_str()).unwrap_or("");
    let selection_json =
        serde_json::to_string(&selection).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    sqlx::query("INSERT INTO conversation_handoffs (id, conversation_id, turn_id, input_id, source_binding_id, history_revision, policy, status, selection_json, payload_digest) SELECT ?, id, ?, ?, ?, history_revision, ?, 'planned', ?, ? FROM sessions WHERE id = ?")
        .bind(Uuid::new_v4()).bind(turn_id).bind(input.queued_input_claim.map(|c| c.input_id))
        .bind(source).bind(policy).bind(selection_json).bind(format!("{:x}", Sha256::digest(payload)))
        .bind(input.conversation_id).execute(pool).await?;
    Ok(())
}

pub(crate) async fn set_target(
    pool: &SqlitePool,
    turn: Uuid,
    target: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET target_binding_id = ? WHERE turn_id = ? AND status = 'planned'")
        .bind(target).bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn sending(pool: &SqlitePool, turn: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = 'sending', updated_at = datetime('now', 'subsec') WHERE turn_id = ? AND status = 'planned' AND target_binding_id IS NOT NULL")
        .bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn settle(pool: &SqlitePool, turn: Uuid) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = CASE status WHEN 'sending' THEN 'uncertain' ELSE 'cancelled' END, updated_at = datetime('now', 'subsec') WHERE turn_id = ? AND status IN ('planned', 'sending')")
        .bind(turn).execute(pool).await?;
    Ok(())
}

pub(crate) async fn accept(
    pool: &SqlitePool,
    conversation: Uuid,
    connection: &str,
    prompt: &str,
) -> Result<(), sqlx::Error> {
    // A local PromptStarted event is never evidence. Only a successful ACP
    // prompt response, carrying its exact request ID, reaches this interface.
    sqlx::query("UPDATE conversation_handoffs SET status = 'delivered', evidence = 'acp_prompt_response', updated_at = datetime('now', 'subsec') WHERE conversation_id = ? AND status IN ('sending', 'uncertain') AND turn_id IN (SELECT id FROM conversation_turns WHERE prompt_id = ?) AND target_binding_id IN (SELECT id FROM conversation_agent_bindings WHERE connection_id = ?)")
        .bind(conversation).bind(prompt).bind(connection).execute(pool).await?;
    Ok(())
}

pub(crate) async fn recover(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE conversation_handoffs SET status = CASE status WHEN 'sending' THEN 'uncertain' ELSE 'cancelled' END, updated_at = datetime('now', 'subsec') WHERE status IN ('sending', 'planned')")
        .execute(pool).await?;
    Ok(())
}

/// Item IDs a binding has already received through delivered handoffs.
///
/// A resumed binding's native session may have consumed a gap in an earlier
/// switch; delivering it again would duplicate that history. Only `delivered`
/// handoffs count: planned/sending/uncertain deliveries are not evidence that
/// the target ever consumed the content.
pub(crate) async fn delivered_item_ids(
    pool: &SqlitePool,
    target_binding_id: Uuid,
) -> Result<std::collections::HashSet<String>, sqlx::Error> {
    let selections: Vec<String> = sqlx::query_scalar(
        "SELECT selection_json FROM conversation_handoffs WHERE target_binding_id = ? AND status = 'delivered'",
    )
    .bind(target_binding_id)
    .fetch_all(pool)
    .await?;
    let mut ids = std::collections::HashSet::new();
    for selection in selections {
        // A malformed or null selection contributes nothing rather than
        // aborting the delta computation for the whole switch.
        if let Ok(Some(selection)) = serde_json::from_str::<Option<HistorySelection>>(&selection) {
            ids.extend(selection.items.into_iter().map(|item| item.id));
        }
    }
    Ok(ids)
}
