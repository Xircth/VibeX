use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
};

use agents::conversation::{
    ConversationEvent, ConversationEventEnvelope, ConversationFileChange,
    ConversationFileChangeSummary,
};
use db::models::{
    conversation::ConversationRecord,
    conversation_event::AppendConversationEvent,
    conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
    session_checkpoint::SessionCheckpoint,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use git::{Commit, DiffTarget};
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{
    BeforeTurnContext, CommittedTurnLaunch, ConversationSessionService, ConversationStartTurnInput,
    collect_registered_before_turn_contributions, ensure_conversation_has_no_in_flight_turn,
    is_in_flight_turn_status,
    start::{agent_blocks_with_display_text, conversation_input_blocks_with_display_text},
};
use crate::{ConversationEventAppender, ConversationServiceError};

impl ConversationSessionService {
    /// Idle-check, claim consumption, and Turn commit. Caller must hold the
    /// conversation turn lock. Do not call `turn_lock.lock()` here: dispatch
    /// already holds it, and tokio Mutex is not reentrant.
    pub(super) async fn commit_new_turn(
        &self,
        input: ConversationStartTurnInput,
        origin: &str,
    ) -> Result<CommittedTurnLaunch, ConversationServiceError> {
        let display_text = input
            .display_text
            .as_deref()
            .unwrap_or(&input.text)
            .to_string();
        if display_text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Prompt must include text or an image".to_string(),
            ));
        }
        if input.text.trim().is_empty() && input.images.is_empty() {
            return Err(ConversationServiceError::BadRequest(
                "Agent prompt must include text or an image".to_string(),
            ));
        }
        self.interrupt_orphaned_turn(input.conversation_id).await?;

        let pool = &self.ctx.deployment.db().pool;
        let execution_workspace_id = crate::isolated_workspace::execution_workspace_id(
            &self.ctx,
            input.conversation_id,
            input.workspace_id,
        )
        .await
        .map_err(|error| ConversationServiceError::Internal(error.message))?;
        let workspace = match Workspace::find_by_id(pool, execution_workspace_id).await? {
            Some(workspace) => workspace,
            None if execution_workspace_id != input.workspace_id => {
                Workspace::find_by_id(pool, input.workspace_id)
                    .await?
                    .ok_or_else(|| {
                        ConversationServiceError::NotFound(format!(
                            "Workspace {} not found",
                            input.workspace_id
                        ))
                    })?
            }
            None => {
                return Err(ConversationServiceError::NotFound(format!(
                    "Workspace {} not found",
                    input.workspace_id
                )));
            }
        };
        let container_ref = self
            .ctx
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await?;
        let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
        let working_dir = self
            .ctx
            .host
            .resolve_working_dir(&workspace, &container_ref, &repos)
            .unwrap_or_else(|| container_ref.clone());
        let additional_directories = self.ctx.host.resolve_additional_directories(
            &workspace,
            &container_ref,
            &repos,
            &working_dir,
        );
        let smart_reminder = crate::commit_reminder::pending_smart_reminder_prompt(
            &self.ctx,
            input.conversation_id,
            workspace.clone(),
            origin,
        )
        .await?;
        let prompt_text = if input.collaboration_origin.is_some() {
            input.text.clone()
        } else {
            let persona = crate::collaboration::persona_prompt_text_for_turn(
                pool,
                input.conversation_id,
                Some(&display_text),
            )
            .await
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
            match persona.as_deref() {
                Some(persona) => crate::collaboration::prefix_persona_prompt(persona, &input.text),
                None => input.text.clone(),
            }
        };
        let mut agent_text = match smart_reminder.as_deref() {
            Some(reminder) if !prompt_text.trim().is_empty() => {
                format!("{prompt_text}\n\n{reminder}")
            }
            Some(reminder) => reminder.to_string(),
            None => prompt_text,
        };

        let before_turn_ctx = BeforeTurnContext {
            conversation_id: input.conversation_id,
            workspace_id: input.workspace_id,
            agent_id: input.agent_id.clone(),
            text: input.text.clone(),
            display_text: display_text.clone(),
            origin: origin.to_string(),
        };
        let mut internal_contributions = input.internal_prompt_contributions.clone();
        internal_contributions.extend(self.ctx.host.before_turn(&before_turn_ctx).await?);
        internal_contributions.extend(collect_registered_before_turn_contributions(
            &before_turn_ctx,
        ));
        match agents::format_internal_prompt_contributions(&internal_contributions) {
            Ok(Some(plugin_context_block)) => {
                if agent_text.trim().is_empty() {
                    agent_text = plugin_context_block;
                } else {
                    agent_text = format!("{agent_text}\n\n{plugin_context_block}");
                }
            }
            Ok(None) => {}
            Err(total_bytes) => {
                return Err(ConversationServiceError::BadRequest(format!(
                    "internalPromptContributions size ({total_bytes} bytes) exceeds maximum allowed {} bytes (16 KiB)",
                    agents::MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES
                )));
            }
        }

        let agent_blocks = self
            .ctx
            .host
            .build_prompt_blocks(&working_dir, agent_text, &input.images, &input.file_refs)
            .await?;
        let display_blocks = agent_blocks_with_display_text(&agent_blocks, &display_text);
        let conversation_blocks = conversation_input_blocks_with_display_text(
            &agent_blocks,
            &display_text,
            input.collaboration_origin.as_ref(),
        );

        let conversation = self
            .ensure_conversation(pool, &input, &display_text)
            .await?;
        ensure_conversation_has_no_in_flight_turn(pool, &conversation).await?;
        let turn_id = Uuid::new_v4();
        let conversation_blocks_json = serde_json::to_string(&conversation_blocks)
            .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
        let created_event = ConversationEvent::UserTurnCreated {
            blocks: conversation_blocks,
            workflow_refs: input.workflow_refs.clone(),
        };

        let (turn, created) = if let Some(claim) = input.queued_input_claim {
            // The durable input is the acceptance boundary. Its claim, the Turn row,
            // active-turn pointer, and both causal events therefore commit together.
            // Agent I/O begins only after this transaction has committed and published.
            let dispatched_event = ConversationEvent::ConversationInput {
                event: agents::ConversationInputEvent::Dispatched {
                    input_id: claim.input_id,
                    claim_token: claim.claim_token,
                    turn_id,
                },
            };
            let dispatched_json = serde_json::to_string(&dispatched_event)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
            let created_json = serde_json::to_string(&created_event)
                .map_err(|error| ConversationServiceError::Internal(error.to_string()))?;
            let dispatched_key = format!("conversation-input:{}:dispatched", claim.input_id);
            let created_key = format!("turn:{turn_id}:created");
            let dispatched_id = Uuid::new_v4();
            let created_id = Uuid::new_v4();
            let mut conn = pool.acquire().await?;
            sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await?;
            let transaction = async {
                let active_status: Option<String> = sqlx::query_scalar(
                    r#"SELECT status
                       FROM conversation_turns
                       WHERE id = (
                           SELECT active_turn_id FROM sessions WHERE id = ?
                       )"#,
                )
                .bind(input.conversation_id)
                .fetch_optional(&mut *conn)
                .await?;
                if active_status
                    .as_deref()
                    .is_some_and(is_in_flight_turn_status)
                {
                    return Err(ConversationServiceError::Conflict(
                        "Conversation already has an active turn".to_string(),
                    ));
                }

                ConversationRecord::capture_initial_prompt_on_connection(
                    &mut conn,
                    input.conversation_id,
                    &display_text,
                )
                .await?;
                let turn = ConversationTurnRecord::create_pending_on_connection(
                    &mut conn,
                    turn_id,
                    CreateConversationTurn {
                        conversation_id: input.conversation_id,
                        prompt_id: None,
                        text_preview: Some(&display_text),
                        input_blocks_json: &conversation_blocks_json,
                    },
                )
                .await?;
                if origin != crate::commit_reminder::USER_ORIGIN {
                    ConversationTurnRecord::set_origin_on_connection(&mut conn, turn.id, origin)
                        .await?;
                }
                ConversationRecord::update_active_turn_on_connection(
                    &mut conn,
                    input.conversation_id,
                    Some(turn.id),
                )
                .await?;
                let dispatched = ConversationEventAppender::append_and_apply(
                    &mut conn,
                    AppendConversationEvent {
                        id: dispatched_id,
                        conversation_id: input.conversation_id,
                        turn_id: Some(turn.id),
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "system",
                        event_kind: "conversation_input",
                        normalized_json: &dispatched_json,
                        raw_json: None,
                        idempotency_key: Some(&dispatched_key),
                    },
                )
                .await?;
                let created = ConversationEventAppender::append_and_apply(
                    &mut conn,
                    AppendConversationEvent {
                        id: created_id,
                        conversation_id: input.conversation_id,
                        turn_id: Some(turn.id),
                        binding_id: None,
                        connection_id: None,
                        prompt_id: None,
                        source: "user",
                        event_kind: "user_turn_created",
                        normalized_json: &created_json,
                        raw_json: None,
                        idempotency_key: Some(&created_key),
                    },
                )
                .await?;
                Ok::<_, ConversationServiceError>((turn, dispatched, created))
            }
            .await;
            let (turn, dispatched, created) = match transaction {
                Ok(committed) => {
                    if let Err(error) = sqlx::query("COMMIT").execute(&mut *conn).await {
                        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                        return Err(error.into());
                    }
                    committed
                }
                Err(error) => {
                    let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                    return Err(error);
                }
            };
            drop(conn);
            self.ctx.event_publisher.publish(&dispatched).await;
            self.ctx.event_publisher.publish(&created).await;
            (turn, created)
        } else {
            ConversationRecord::capture_initial_prompt(pool, input.conversation_id, &display_text)
                .await?;
            let turn = ConversationTurnRecord::create_pending(
                pool,
                turn_id,
                CreateConversationTurn {
                    conversation_id: input.conversation_id,
                    prompt_id: None,
                    text_preview: Some(&display_text),
                    input_blocks_json: &conversation_blocks_json,
                },
            )
            .await?;
            crate::workbench_status::reconcile(pool, input.conversation_id).await?;
            if origin != crate::commit_reminder::USER_ORIGIN {
                ConversationTurnRecord::set_origin(pool, turn.id, origin).await?;
            }
            ConversationRecord::update_active_turn(pool, input.conversation_id, Some(turn.id))
                .await?;
            let created = self
                .append_event(
                    input.conversation_id,
                    Some(turn.id),
                    "user",
                    created_event,
                    Some(format!("turn:{}:created", turn.id)),
                )
                .await?;
            (turn, created)
        };

        self.update_runtime_state(input.conversation_id, |state| {
            state.conversation_id = Some(input.conversation_id);
            state.active_turn_id = Some(turn.id);
            state.pending_user_message = Some(display_text.clone());
            state.turn_in_flight = true;
            state.event_sequence = created.sequence;
        })
        .await;
        Ok(CommittedTurnLaunch {
            input,
            working_dir,
            additional_directories,
            agent_blocks,
            display_blocks,
            turn_id: turn.id,
            created_sequence: created.sequence,
            smart_reminder,
        })
    }
}

#[derive(Debug, sqlx::FromRow)]
struct ConversationCheckpointRow {
    id: Uuid,
    ordinal: i64,
    before_snapshot_json: Option<String>,
}

struct CollectedCheckpointFileChanges {
    files: Vec<ConversationFileChange>,
    after_repos: Vec<serde_json::Value>,
}

async fn collect_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    checkpoint: &ConversationCheckpointRow,
) -> Result<CollectedCheckpointFileChanges, ConversationServiceError> {
    let pool = &deployment.db().pool;
    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!("Conversation {conversation_id} not found"))
        })?;
    let mut workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Workspace {} not found",
                conversation.workspace_id
            ))
        })?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let checkpoints =
        SessionCheckpoint::find_by_ordinal(pool, conversation_id, checkpoint.ordinal).await?;

    let mut files = Vec::new();
    let mut after_repos = Vec::new();
    for checkpoint_repo in checkpoints {
        let Some(repo) = repos.iter().find(|repo| repo.id == checkpoint_repo.repo_id) else {
            continue;
        };
        let repo_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| PathBuf::from(&container_ref));
        let after_head = deployment.container().git().get_head_info(&repo_path).ok();
        after_repos.push(serde_json::json!({
            "repoId": repo.id,
            "repoName": repo.name,
            "beforeHeadCommit": checkpoint_repo.before_head_commit,
            "afterHeadCommit": after_head.as_ref().map(|head| head.oid.clone()),
        }));

        let Ok(oid) = git2::Oid::from_str(&checkpoint_repo.before_head_commit) else {
            tracing::warn!(
                repo_id = %repo.id,
                before_head = %checkpoint_repo.before_head_commit,
                "failed to parse conversation checkpoint commit"
            );
            continue;
        };
        let base_commit = Commit::new(oid);
        let diffs = match deployment.container().git().get_tracked_diffs(
            DiffTarget::Worktree {
                worktree_path: &repo_path,
                base_commit: &base_commit,
            },
            None,
        ) {
            Ok(diffs) => diffs,
            Err(error) => {
                tracing::warn!(
                    repo_id = %repo.id,
                    path = %repo_path.display(),
                    %error,
                    "failed to compute conversation checkpoint diff"
                );
                continue;
            }
        };
        let repo_id = repo.id.to_string();
        if let Some(before_diffs) =
            checkpoint_before_diffs(checkpoint.before_snapshot_json.as_deref(), &repo_id)
        {
            files.extend(checkpoint_turn_file_changes(&before_diffs, &diffs));
        } else {
            let before_files =
                checkpoint_before_files(checkpoint.before_snapshot_json.as_deref(), &repo_id);
            let before_paths = before_files
                .iter()
                .flat_map(|file| std::iter::once(&file.path).chain(file.old_path.as_ref()))
                .collect::<std::collections::HashSet<_>>();
            files.extend(
                diffs
                    .into_iter()
                    .filter_map(diff_to_conversation_file_change)
                    .filter(|file| !before_paths.contains(&file.path)),
            );
        }
    }

    Ok(CollectedCheckpointFileChanges { files, after_repos })
}

/// Compute the files that a reset to the checkpoint before `ordinal` would
/// currently change. This is read-only and uses the same checkpoint snapshot
/// comparison as the persisted per-turn file summary.
pub async fn preview_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    ordinal: i64,
) -> Result<ConversationFileChangeSummary, ConversationServiceError> {
    let checkpoint = sqlx::query_as::<_, ConversationCheckpointRow>(
        r#"SELECT id, ordinal, before_snapshot_json
           FROM conversation_checkpoints
           WHERE conversation_id = ? AND ordinal = ?
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(ordinal)
    .fetch_optional(&deployment.db().pool)
    .await?
    .ok_or_else(|| {
        ConversationServiceError::NotFound(format!(
            "No checkpoint at ordinal {ordinal} for conversation {conversation_id}"
        ))
    })?;

    let collected =
        collect_checkpoint_file_changes(deployment, conversation_id, &checkpoint).await?;
    let summary = checkpoint_file_change_summary(&collected.files);
    Ok(ConversationFileChangeSummary {
        source: "checkpoint_preview".to_string(),
        files: collected.files,
        summary: Some(summary),
    })
}

pub async fn finalize_checkpoint_file_changes<D: Deployment + ?Sized>(
    deployment: &D,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<Option<ConversationEventEnvelope>, ConversationServiceError> {
    let pool = &deployment.db().pool;
    let Some(checkpoint) = sqlx::query_as::<_, ConversationCheckpointRow>(
        r#"SELECT id, ordinal, before_snapshot_json
           FROM conversation_checkpoints
           WHERE conversation_id = ? AND turn_id = ? AND finalized_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1"#,
    )
    .bind(conversation_id)
    .bind(turn_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let collected =
        collect_checkpoint_file_changes(deployment, conversation_id, &checkpoint).await?;
    let files = collected.files;
    let after_repos = collected.after_repos;

    let after_snapshot_json = serde_json::json!({
        "ordinal": checkpoint.ordinal,
        "repos": after_repos,
    })
    .to_string();
    let diff_summary = checkpoint_file_change_summary(&files);
    let diff_summary_json = serde_json::to_string(&serde_json::json!({
        "fileCount": files.len(),
        "summary": diff_summary,
        "before": checkpoint.before_snapshot_json,
    }))?;

    sqlx::query(
        r#"UPDATE conversation_checkpoints
           SET after_snapshot_json = ?,
               diff_summary_json = ?,
               finalized_at = datetime('now', 'subsec')
           WHERE id = ?"#,
    )
    .bind(&after_snapshot_json)
    .bind(&diff_summary_json)
    .bind(checkpoint.id)
    .execute(pool)
    .await?;

    if files.is_empty() {
        return Ok(None);
    }

    let event = ConversationEvent::FileChangeSummaryUpdated {
        summary: ConversationFileChangeSummary {
            source: "checkpoint_diff".to_string(),
            files,
            summary: Some(diff_summary),
        },
    };
    let value = serde_json::to_value(&event)?;
    let event_kind = value["kind"].as_str().unwrap_or("unknown").to_string();
    let normalized_json = serde_json::to_string(&event)?;
    let idempotency_key = format!("checkpoint:{turn_id}:file_changes");
    let record = ConversationEventAppender::append(
        pool,
        AppendConversationEvent {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: Some(turn_id),
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            source: "system",
            event_kind: &event_kind,
            normalized_json: &normalized_json,
            raw_json: Some(&diff_summary_json),
            idempotency_key: Some(&idempotency_key),
        },
    )
    .await?;

    Ok(Some(ConversationEventEnvelope {
        id: record.id,
        conversation_id: record.conversation_id,
        turn_id: record.turn_id,
        sequence: record.sequence,
        source: record.source,
        event,
        created_at: record.created_at,
    }))
}

pub(super) async fn record_conversation_checkpoint(
    deployment: &dyn Deployment,
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
    ordinal: i64,
) -> Result<(), ConversationServiceError> {
    let checkpoints = SessionCheckpoint::find_by_ordinal(pool, conversation_id, ordinal).await?;
    let conversation = ConversationRecord::find_by_id(pool, conversation_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!("Conversation {conversation_id} not found"))
        })?;
    let mut workspace = Workspace::find_by_id(pool, conversation.workspace_id)
        .await?
        .ok_or_else(|| {
            ConversationServiceError::NotFound(format!(
                "Workspace {} not found",
                conversation.workspace_id
            ))
        })?;
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let container_ref = deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let before_snapshot_json = serde_json::json!({
        "ordinal": ordinal,
        "repos": checkpoints
            .iter()
            .map(|checkpoint| {
                let files = repos
                    .iter()
                    .find(|repo| repo.id == checkpoint.repo_id)
                    .and_then(|repo| {
                        let repo_path = workspace
                            .repo_path(repo)
                            .unwrap_or_else(|| PathBuf::from(&container_ref));
                        let oid = git2::Oid::from_str(&checkpoint.before_head_commit).ok()?;
                        let base_commit = Commit::new(oid);
                        deployment
                            .container()
                            .git()
                            .get_tracked_diffs(
                                DiffTarget::Worktree {
                                    worktree_path: &repo_path,
                                    base_commit: &base_commit,
                                },
                                None,
                            )
                            .ok()
                    })
                    .unwrap_or_default();
                serde_json::json!({
                    "repoId": checkpoint.repo_id,
                    "beforeHeadCommit": checkpoint.before_head_commit,
                    "files": files,
                })
            })
            .collect::<Vec<_>>(),
    })
    .to_string();
    sqlx::query(
        r#"INSERT INTO conversation_checkpoints (
               id, conversation_id, turn_id, ordinal, before_snapshot_json
           )
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, ordinal) DO UPDATE SET
               turn_id = excluded.turn_id,
               before_snapshot_json = excluded.before_snapshot_json"#,
    )
    .bind(Uuid::new_v4())
    .bind(conversation_id)
    .bind(turn_id)
    .bind(ordinal)
    .bind(before_snapshot_json)
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) fn checkpoint_before_files(
    before_snapshot_json: Option<&str>,
    repo_id: &str,
) -> Vec<ConversationFileChange> {
    let Some(snapshot) =
        before_snapshot_json.and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
    else {
        return Vec::new();
    };
    snapshot["repos"]
        .as_array()
        .and_then(|repos| {
            repos
                .iter()
                .find(|repo| repo["repoId"].as_str() == Some(repo_id))
        })
        .and_then(|repo| serde_json::from_value(repo["files"].clone()).ok())
        .unwrap_or_default()
}

/// Reads the v2 checkpoint payload. Unlike the legacy file summary, a full diff
/// snapshot preserves the worktree contents at the beginning of a turn, which
/// lets us compare the two endpoints instead of comparing both to the branch
/// head.
pub(super) fn checkpoint_before_diffs(
    before_snapshot_json: Option<&str>,
    repo_id: &str,
) -> Option<Vec<utils::diff::Diff>> {
    let snapshot: serde_json::Value =
        before_snapshot_json.and_then(|json| serde_json::from_str(json).ok())?;
    let repo = snapshot["repos"]
        .as_array()?
        .iter()
        .find(|repo| repo["repoId"].as_str() == Some(repo_id))?;
    serde_json::from_value(repo["files"].clone()).ok()
}

pub(super) fn checkpoint_turn_file_changes(
    before_diffs: &[utils::diff::Diff],
    after_diffs: &[utils::diff::Diff],
) -> Vec<ConversationFileChange> {
    let before_by_path = checkpoint_diffs_by_path(before_diffs);
    let after_by_path = checkpoint_diffs_by_path(after_diffs);
    let renamed_from_after = after_diffs
        .iter()
        .filter_map(|diff| {
            diff.old_path
                .as_ref()
                .filter(|old_path| diff.new_path.as_ref() != Some(*old_path))
                .cloned()
        })
        .collect::<BTreeSet<_>>();
    let paths = before_by_path
        .keys()
        .filter(|path| !renamed_from_after.contains(*path))
        .chain(after_by_path.keys())
        .cloned()
        .collect::<BTreeSet<_>>();

    paths
        .into_iter()
        .filter_map(|path| {
            let after = after_by_path.get(&path).copied();
            let before = before_by_path.get(&path).copied().or_else(|| {
                after.and_then(|diff| {
                    diff.old_path
                        .as_ref()
                        .and_then(|old_path| before_by_path.get(old_path).copied())
                })
            });
            checkpoint_turn_file_change(&path, before, after)
        })
        .collect()
}

fn checkpoint_diffs_by_path(diffs: &[utils::diff::Diff]) -> HashMap<String, &utils::diff::Diff> {
    diffs
        .iter()
        .filter_map(|diff| {
            let path = git::GitService::diff_path(diff);
            (!path.trim().is_empty()).then_some((path, diff))
        })
        .collect()
}

fn checkpoint_turn_file_change(
    path: &str,
    before: Option<&utils::diff::Diff>,
    after: Option<&utils::diff::Diff>,
) -> Option<ConversationFileChange> {
    let before_exists = before
        .map(|diff| diff.new_path.is_some())
        .unwrap_or_else(|| after.is_some_and(|diff| diff.old_path.is_some()));
    let after_exists = after
        .map(|diff| diff.new_path.is_some())
        .unwrap_or_else(|| before.is_some_and(|diff| diff.old_path.is_some()));
    let before_content = before
        .and_then(|diff| diff.new_content.as_deref())
        .or_else(|| after.and_then(|diff| diff.old_content.as_deref()));
    let after_content = after
        .and_then(|diff| diff.new_content.as_deref())
        .or_else(|| before.and_then(|diff| diff.old_content.as_deref()));

    let (change_kind, additions, deletions) = match (before_exists, after_exists) {
        (false, false) => return None,
        (false, true) => (
            "added",
            after_content.map(|content| content.lines().count() as i64),
            Some(0),
        ),
        (true, false) => (
            "deleted",
            Some(0),
            before_content.map(|content| content.lines().count() as i64),
        ),
        (true, true) => match (before_content, after_content) {
            (Some(before_content), Some(after_content)) if before_content == after_content => {
                return None;
            }
            (Some(before_content), Some(after_content)) => {
                let (additions, deletions) =
                    utils::diff::compute_line_change_counts(before_content, after_content);
                let change_kind = after
                    .map(|diff| diff_change_kind(&diff.change))
                    .unwrap_or("modified");
                (change_kind, Some(additions as i64), Some(deletions as i64))
            }
            _ if before.is_none() || after.is_none() => (
                after
                    .map(|diff| diff_change_kind(&diff.change))
                    .unwrap_or("modified"),
                None,
                None,
            ),
            _ => return None,
        },
    };

    Some(ConversationFileChange {
        path: path.to_string(),
        change_kind: change_kind.to_string(),
        additions,
        deletions,
        old_path: after
            .and_then(|diff| diff.old_path.clone())
            .filter(|old_path| old_path != path),
    })
}

pub(super) fn diff_to_conversation_file_change(
    diff: utils::diff::Diff,
) -> Option<ConversationFileChange> {
    let path = git::GitService::diff_path(&diff);
    if path.trim().is_empty() {
        return None;
    }
    Some(ConversationFileChange {
        path,
        change_kind: diff_change_kind(&diff.change).to_string(),
        additions: diff.additions.map(|value| value as i64),
        deletions: diff.deletions.map(|value| value as i64),
        old_path: diff.old_path,
    })
}

fn diff_change_kind(change: &utils::diff::DiffChangeKind) -> &'static str {
    match change {
        utils::diff::DiffChangeKind::Added => "added",
        utils::diff::DiffChangeKind::Deleted => "deleted",
        utils::diff::DiffChangeKind::Renamed => "renamed",
        utils::diff::DiffChangeKind::Modified
        | utils::diff::DiffChangeKind::Copied
        | utils::diff::DiffChangeKind::PermissionChange => "modified",
    }
}

pub(super) fn checkpoint_file_change_summary(files: &[ConversationFileChange]) -> String {
    let added = files
        .iter()
        .filter(|file| file.change_kind == "added")
        .count();
    let modified = files
        .iter()
        .filter(|file| file.change_kind == "modified")
        .count();
    let deleted = files
        .iter()
        .filter(|file| file.change_kind == "deleted")
        .count();
    let renamed = files
        .iter()
        .filter(|file| file.change_kind == "renamed")
        .count();
    format!(
        "{} file(s) changed: {} added, {} modified, {} deleted, {} renamed",
        files.len(),
        added,
        modified,
        deleted,
        renamed
    )
}
