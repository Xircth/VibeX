use super::*;

#[derive(Default)]
pub(super) struct SpaceReviewChainState {
    running: bool,
    rerun_conversation_id: Option<Uuid>,
}

pub(super) static SPACE_REVIEW_QUEUES: OnceLock<std::sync::Mutex<HashMap<String, SpaceReviewChainState>>> =
    OnceLock::new();

pub(super) fn space_review_queues() -> &'static std::sync::Mutex<HashMap<String, SpaceReviewChainState>> {
    SPACE_REVIEW_QUEUES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Enqueue a DS-Bot style `reviewChain` pass for the Space owning `conversation_id`.
/// Concurrent triggers for the same Space within `debounce` or while a review is in flight
/// coalesce into a single review pass so cursors never collide.
pub async fn enqueue_space_memory_review(
    pool: SqlitePool,
    conversation_id: Uuid,
    debounce: std::time::Duration,
    min_new_messages: usize,
) {
    let target_space = match memory_caller(&pool, conversation_id).await {
        Ok(Some(caller)) => {
            if caller.private {
                format!("direct:{}", caller.member_id)
            } else {
                caller.thread_id
            }
        }
        _ => return,
    };

    {
        let mut map = space_review_queues().lock().unwrap();
        let state = map.entry(target_space.clone()).or_default();
        state.rerun_conversation_id = Some(conversation_id);
        if state.running {
            return;
        }
        state.running = true;
    }

    loop {
        if !debounce.is_zero() {
            tokio::time::sleep(debounce).await;
        }
        let next_conv = {
            let mut map = space_review_queues().lock().unwrap();
            let state = map.entry(target_space.clone()).or_default();
            if let Some(conv_id) = state.rerun_conversation_id.take() {
                conv_id
            } else {
                state.running = false;
                break;
            }
        };

        if let Some(model) = active_memory_review_model()
            && let Err(error) = review_conversation_memory_with_threshold(
                &pool,
                next_conv,
                model.as_ref(),
                min_new_messages,
            )
            .await
        {
            tracing::warn!(conversation_id = %next_conv, %error, "post-turn model memory review failed");
        }
        if let Some(distiller) = DISTILLER.get()
            && let Err(error) = distill_member_memory(&pool, distiller.as_ref()).await
        {
            tracing::warn!(%error, "post-turn custom distiller failed");
        }
    }
}

/// Trigger a debounced 2-second post-turn model-driven memory review pass with [`crate::ConversationContext`].
pub fn schedule_post_turn_memory_review_with_context(
    context: crate::ConversationContext,
    pool: SqlitePool,
    conversation_id: Uuid,
) {
    let runtime_model: Arc<dyn MemoryReviewModel> =
        Arc::new(AgentRuntimeMemoryReviewModel::new(context));
    register_runtime_review_model(runtime_model);
    schedule_post_turn_memory_review(pool, conversation_id);
}

/// Trigger a debounced 2-second post-turn model-driven memory review pass (DS-Bot `reviewChain` + same-key coalescing).
pub fn schedule_post_turn_memory_review(pool: SqlitePool, conversation_id: Uuid) {
    tokio::spawn(async move {
        enqueue_space_memory_review(
            pool,
            conversation_id,
            std::time::Duration::from_secs(2),
            MEMORY_REVIEW_MIN_NEW_MESSAGES,
        )
        .await;
    });
}

/// One distillation pass over every member with new activity, persisting cursor in
/// `~/.dimo/spaces/direct_<member_id>/reviewed.json` and writing facts to `MEMORY.md`.
pub async fn distill_member_memory(
    pool: &SqlitePool,
    distiller: &dyn FactDistiller,
) -> Result<usize, CollaborationError> {
    let members = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT member_id FROM member_activity ORDER BY member_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if members.is_empty() {
        return Ok(0);
    }
    let mut written = 0;
    for member_id in members {
        let direct_space = format!("direct:{member_id}");
        let space_lock = space_review_lock(&direct_space);
        let _space_guard = space_lock.lock().await;
        let mut review_state = read_space_review_state(&direct_space);
        let activity = sqlx::query_as::<_, ActivityEntry>(
            r#"SELECT id, member_id, thread_id, summary, private != 0 AS private, created_at
               FROM member_activity WHERE member_id = ? AND id > ? ORDER BY id ASC LIMIT 200"#,
        )
        .bind(&member_id)
        .bind(review_state.last_activity_id)
        .fetch_all(pool)
        .await
        .map_err(db)?;
        let Some(last) = activity.last().map(|entry| entry.id) else {
            continue;
        };
        let private_threads: Vec<&str> = activity
            .iter()
            .filter(|e| e.private)
            .map(|e| e.thread_id.as_str())
            .collect();
        let any_private = !private_threads.is_empty();
        for fact in distiller.distill(&member_id, &activity).await {
            let Ok(content) = check_content(&fact.content) else {
                continue;
            };
            let from_private = fact.thread_id.as_deref().map_or(any_private, |t| {
                t.starts_with("direct:") || private_threads.contains(&t)
            });
            let scope = if from_private {
                FactScope::Private
            } else if fact.global {
                FactScope::Global
            } else if let Some(thread) = fact.thread_id.clone() {
                FactScope::Thread(thread)
            } else {
                FactScope::Global
            };
            let target_space = target_space_for_fact(&member_id, &scope);
            let parsed = read_space_memory_parsed(&target_space, Some(&member_id));
            let squashed = squash_memory_text(&content);
            if parsed.entries.iter().any(|e| {
                e.fact.member_id == member_id
                    && e.fact.scope == scope.as_db()
                    && squash_memory_text(&e.fact.content) == squashed
            }) {
                continue;
            }
            if create_fact(
                pool,
                &member_id,
                &content,
                &scope,
                fact.thread_id.as_deref(),
                "distilled",
            )
            .await
            .is_ok()
            {
                written += 1;
            }
        }
        review_state.last_activity_id = review_state.last_activity_id.max(last);
        review_state.updated_at = now();
        write_space_review_state(&direct_space, &review_state);
    }
    Ok(written)
}

/// Run [`distill_member_memory`] every `interval` with the installed or default distiller.
pub fn spawn_memory_distiller(pool: SqlitePool, interval: std::time::Duration) {
    spawn_memory_distiller_with(pool, fact_distiller(), interval);
}

/// Run [`distill_member_memory`] every `interval` with an explicit `distiller`.
pub fn spawn_memory_distiller_with(
    pool: SqlitePool,
    distiller: Arc<dyn FactDistiller>,
    interval: std::time::Duration,
) {
    tokio::spawn(async move {
        let period = if interval.is_zero() {
            std::time::Duration::from_secs(120)
        } else {
            interval
        };
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(error) = distill_member_memory(&pool, distiller.as_ref()).await {
                tracing::warn!(%error, "member memory distillation failed");
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Agent tools (scoped to the calling member)
// ---------------------------------------------------------------------------

pub(super) async fn require_caller(
    pool: &SqlitePool,
    caller_id: Uuid,
) -> Result<MemoryCaller, CollaborationError> {
    if resolve_member_id(pool, caller_id).await?.is_none() {
        return Err(CollaborationError::new(
            "not_a_member",
            "current conversation is not a collaboration space member",
        ));
    }
    memory_caller(pool, caller_id).await?.ok_or_else(|| {
        CollaborationError::new(
            "not_a_member",
            "current conversation is not a collaboration space member",
        )
    })
}

/// `memory_search`: facts visible here plus matching non-private activity
/// (private activity only from a private thread).
pub async fn tool_search(
    pool: &SqlitePool,
    caller_id: Uuid,
    query: &str,
    limit: usize,
) -> Result<serde_json::Value, CollaborationError> {
    tool_search_with_topic(pool, caller_id, query, None, limit).await
}

/// Extended `memory_search` supporting optional `topic` recall (DS-Bot `recall(topic)`).
pub async fn tool_search_with_topic(
    pool: &SqlitePool,
    caller_id: Uuid,
    query: &str,
    topic: Option<&str>,
    limit: usize,
) -> Result<serde_json::Value, CollaborationError> {
    let caller = require_caller(pool, caller_id).await?;
    let limit = limit.clamp(1, 50);
    if let Some(topic_key) = topic.map(str::trim).filter(|s| !s.is_empty()) {
        let recalled = if caller.private {
            read_space_topic(&caller.thread_id, topic_key)
                .or_else(|_| read_space_topic(&format!("direct:{}", caller.member_id), topic_key))?
        } else {
            read_space_topic(&caller.thread_id, topic_key)?
        };
        return Ok(serde_json::json!({
            "topic": recalled,
            "facts": [],
            "activity": [],
        }));
    }
    let facts = search_facts(pool, &caller, query, limit).await?;
    let activity = list_activity(pool, &caller.member_id, caller.private, 200).await?;
    let terms = tokenize(query);
    let docs: Vec<Vec<String>> = activity.iter().map(|a| tokenize(&a.summary)).collect();
    let scores = bm25(&docs, &terms);
    let mut hits: Vec<(f64, &ActivityEntry)> = activity
        .iter()
        .zip(scores)
        .filter(|(_, s)| terms.is_empty() || *s > 0.0)
        .map(|(a, s)| (s, a))
        .collect();
    hits.sort_by(|a, b| b.0.total_cmp(&a.0));
    let activity: Vec<_> = hits
        .into_iter()
        .take(limit)
        .map(|(_, a)| a.clone())
        .collect();
    let mut topics = list_space_topics(&caller.thread_id).unwrap_or_default();
    if caller.private {
        for own_topic in
            list_space_topics(&format!("direct:{}", caller.member_id)).unwrap_or_default()
        {
            if !topics.iter().any(|t| t.topic == own_topic.topic) {
                topics.push(own_topic);
            }
        }
    }
    let indexed_collection = list_indexed_space_collection_pointers(pool, &caller.thread_id).await;
    Ok(serde_json::json!({
        "facts": facts,
        "activity": activity,
        "topics": topics,
        "indexedCollection": indexed_collection,
    }))
}

pub(super) async fn resolve_editable_fact_owner(
    pool: &SqlitePool,
    caller: &MemoryCaller,
    fact_id: i64,
) -> Result<String, CollaborationError> {
    let mut spaces = candidate_spaces_for_member(pool, &caller.member_id).await;
    if !spaces.contains(&caller.thread_id) {
        spaces.push(caller.thread_id.clone());
    }
    for space_id in spaces {
        let parsed = read_space_memory_parsed(&space_id, Some(&caller.member_id));
        if let Some(entry) = parsed.entries.into_iter().find(|e| e.fact.id == fact_id) {
            let parsed_scope = FactScope::parse(&entry.fact.scope)?;
            if !parsed_scope.visible_to(caller) {
                return Err(CollaborationError::new(
                    "permission_denied",
                    "fact is not accessible in the current thread",
                ));
            }
            if entry.fact.member_id == caller.member_id {
                return Ok(entry.fact.member_id);
            }
            if !caller.private && parsed_scope == FactScope::Thread(caller.thread_id.clone()) {
                return Ok(entry.fact.member_id);
            }
            return Err(CollaborationError::new(
                "permission_denied",
                "only the owning member or a member of the same group thread may modify this fact",
            ));
        }
    }
    Err(CollaborationError::new(
        "not_found",
        "memory fact was not found",
    ))
}

/// `memory_write`: store a fact for the calling member. Default scope is
/// this thread; in a private thread every write is forced to `private`.
pub async fn tool_write(
    pool: &SqlitePool,
    caller_id: Uuid,
    content: &str,
    scope: Option<&str>,
) -> Result<MemberFact, CollaborationError> {
    let caller = require_caller(pool, caller_id).await?;
    let requested = match scope.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("thread") => FactScope::Thread(caller.thread_id.clone()),
        Some(raw) => FactScope::parse(raw)?,
    };
    if let FactScope::Thread(id) = &requested
        && *id != caller.thread_id
    {
        return Err(bad(
            "an agent may only write thread facts for its current thread",
        ));
    }
    let scope = if caller.private {
        FactScope::Private
    } else if requested == FactScope::Private {
        return Err(bad("cannot write private scope from a group thread"));
    } else {
        requested
    };
    create_fact(
        pool,
        &caller.member_id,
        content,
        &scope,
        Some(&caller.thread_id),
        "agent",
    )
    .await
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolWriteOptions {
    pub content: String,
    pub scope: Option<String>,
    pub op: Option<String>,
    pub fact_id: Option<i64>,
    pub topic: Option<String>,
    pub title: Option<String>,
}

/// Extended `memory_write` supporting `op: "add" | "replace" | "remove"` and `topic`.
pub async fn tool_write_with_options(
    pool: &SqlitePool,
    caller_id: Uuid,
    options: ToolWriteOptions,
) -> Result<serde_json::Value, CollaborationError> {
    let caller = require_caller(pool, caller_id).await?;
    let op = options
        .op
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("add")
        .to_ascii_lowercase();

    if let Some(topic_slug) = options
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let target_space = if caller.private {
            format!("direct:{}", caller.member_id)
        } else {
            caller.thread_id.clone()
        };
        if matches!(op.as_str(), "remove" | "delete" | "forget") {
            let deleted = delete_space_topic(&target_space, topic_slug, "agent")?;
            let _ = sync_space_memory_files(pool, &target_space, Some(&caller.member_id)).await;
            return Ok(serde_json::json!({
                "op": "remove",
                "topic": topic_slug,
                "deleted": deleted,
            }));
        }
        let record = write_space_topic(
            &target_space,
            topic_slug,
            options.title.as_deref(),
            &options.content,
            "agent",
        )?;
        let _ = sync_space_memory_files(pool, &target_space, Some(&caller.member_id)).await;
        return Ok(serde_json::json!({
            "op": op,
            "topic": record,
        }));
    }

    match op.as_str() {
        "remove" | "delete" | "forget" => {
            if let Some(fid) = options.fact_id {
                let owner_id = resolve_editable_fact_owner(pool, &caller, fid).await?;
                let deleted = delete_fact(pool, &owner_id, fid).await?;
                return Ok(serde_json::json!({
                    "op": "remove",
                    "factId": fid,
                    "deleted": deleted,
                }));
            }
            let needle = options.content.trim();
            if needle.is_empty() {
                return Err(bad("fact_id or content is required for remove"));
            }
            let visible_facts = search_facts(pool, &caller, "", 200).await?;
            if let Some(matched) = visible_facts
                .into_iter()
                .find(|f| f.content == needle || f.content.contains(needle))
            {
                let owner_id = resolve_editable_fact_owner(pool, &caller, matched.id).await?;
                let deleted = delete_fact(pool, &owner_id, matched.id).await?;
                return Ok(serde_json::json!({
                    "op": "remove",
                    "factId": matched.id,
                    "deleted": deleted,
                }));
            }
            Ok(serde_json::json!({ "op": "remove", "deleted": false }))
        }
        "replace" | "edit" | "update" => {
            if let Some(fid) = options.fact_id {
                let owner_id = resolve_editable_fact_owner(pool, &caller, fid).await?;
                let scope_parsed = options
                    .scope
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|raw| {
                        let requested = match raw {
                            "thread" => FactScope::Thread(caller.thread_id.clone()),
                            other => FactScope::parse(other)?,
                        };
                        if let FactScope::Thread(id) = &requested
                            && *id != caller.thread_id
                        {
                            return Err(bad(
                                "an agent may only write thread facts for its current thread",
                            ));
                        }
                        if caller.private {
                            Ok(FactScope::Private)
                        } else if requested == FactScope::Private {
                            Err(bad("cannot set private scope from a group thread"))
                        } else {
                            Ok(requested)
                        }
                    })
                    .transpose()?;
                let updated = update_fact(
                    pool,
                    &owner_id,
                    fid,
                    Some(&options.content),
                    scope_parsed.as_ref(),
                )
                .await?;
                return serde_json::to_value(updated).map_err(|e| bad(e.to_string()));
            }
            let created =
                tool_write(pool, caller_id, &options.content, options.scope.as_deref()).await?;
            serde_json::to_value(created).map_err(|e| bad(e.to_string()))
        }
        _ => {
            let created =
                tool_write(pool, caller_id, &options.content, options.scope.as_deref()).await?;
            serde_json::to_value(created).map_err(|e| bad(e.to_string()))
        }
    }
}

// ---------------------------------------------------------------------------
// Unified Space Memory & Collection Index File Engine (DS-Bot + Dimo Collection)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryJournalEntry {
    pub id: String,
    pub ts: String,
    pub space_id: String,
    pub actor: String,
    pub op: String,
    pub scope: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTopicRecord {
    pub topic: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub char_count: usize,
    pub byte_size: u64,
    pub updated_at: String,
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummarySection {
    pub id: String,
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummaryCard {
    pub sections: Vec<MemorySummarySection>,
    pub char_count: usize,
    pub budget_chars: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMemoryView {
    pub space_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub memory_file_path: String,
    pub summary: MemorySummaryCard,
    pub facts: Vec<MemberFact>,
    pub activity: Vec<ActivityEntry>,
    pub topics: Vec<MemoryTopicRecord>,
    pub journal: Vec<MemoryJournalEntry>,
    pub excluded_collection_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAskChange {
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fact_id: Option<i64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAskResponse {
    pub reply: String,
    pub changes: Vec<MemoryAskChange>,
    pub matched_facts: Vec<MemberFact>,
    pub view: SpaceMemoryView,
}

pub fn space_memory_root_dir(space_id: &str) -> std::path::PathBuf {
    let collection_dir = crate::collaboration::space_collection_dir(space_id);
    collection_dir
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or(collection_dir)
}

pub fn space_memory_file_path(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("MEMORY.md")
}

pub fn space_topics_dir(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("topics")
}

pub fn space_journal_path(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("journal.jsonl")
}

pub fn space_summary_path(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("summary.json")
}

pub fn space_index_exclusions_path(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("index_excluded.json")
}

pub(super) fn sanitize_topic_slug(raw: &str) -> Result<String, CollaborationError> {
    let trimmed = raw
        .trim()
        .trim_start_matches("[[")
        .trim_end_matches("]]")
        .trim_start_matches("topic:")
        .trim_end_matches(".md")
        .trim();
    let mut slug = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_')
            || (!ch.is_control() && ch > '\u{007f}')
        {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || ch == '/' || ch == '.')
            && !slug.ends_with('-')
            && !slug.is_empty()
        {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() || slug.eq_ignore_ascii_case("memory") {
        return Err(bad("invalid topic name"));
    }
    Ok(slug)
}

pub fn append_memory_journal(
    space_id: &str,
    actor: &str,
    op: &str,
    scope: &str,
    target: &str,
    before: Option<&str>,
    after: Option<&str>,
) {
    let dir = space_memory_root_dir(space_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let entry = MemoryJournalEntry {
        id: Uuid::new_v4().to_string(),
        ts: now(),
        space_id: space_id.to_string(),
        actor: actor.to_string(),
        op: op.to_string(),
        scope: scope.to_string(),
        target: target.to_string(),
        before: before.map(str::to_string),
        after: after.map(str::to_string),
    };
    if let Ok(line) = serde_json::to_string(&entry)
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(space_journal_path(space_id))
    {
        use std::io::Write as _;
        let _ = writeln!(file, "{line}");
    }
}

pub fn list_memory_journal(space_id: &str, limit: usize) -> Vec<MemoryJournalEntry> {
    let path = space_journal_path(space_id);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut entries: Vec<MemoryJournalEntry> = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<MemoryJournalEntry>(line.trim()).ok())
        .collect();
    entries.reverse();
    entries.truncate(limit.clamp(1, 200));
    entries
}

pub fn read_excluded_collection_ids(space_id: &str) -> Vec<String> {
    let path = space_index_exclusions_path(space_id);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

pub fn toggle_collection_item_indexed(
    space_id: &str,
    item_id: &str,
    indexed: Option<bool>,
) -> Result<bool, CollaborationError> {
    let dir = space_memory_root_dir(space_id);
    std::fs::create_dir_all(&dir).map_err(|e| bad(e.to_string()))?;
    let mut excluded = read_excluded_collection_ids(space_id);
    let currently_indexed = !excluded.iter().any(|id| id == item_id);
    let target_indexed = indexed.unwrap_or(!currently_indexed);
    if target_indexed {
        excluded.retain(|id| id != item_id);
    } else if currently_indexed {
        excluded.push(item_id.to_string());
    }
    let json_bytes = serde_json::to_vec_pretty(&excluded).map_err(|e| bad(e.to_string()))?;
    std::fs::write(space_index_exclusions_path(space_id), json_bytes)
        .map_err(|e| bad(e.to_string()))?;
    Ok(target_indexed)
}

pub(super) fn parse_topic_title_and_summary(slug: &str, content: &str) -> (String, String) {
    let mut title = slug.to_string();
    let mut first_body = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix('#') {
            let clean = heading.trim_start_matches('#').trim();
            if !clean.is_empty() && title == slug {
                title = clean.to_string();
                continue;
            }
        }
        if first_body.is_empty() {
            let clean = trimmed.trim_start_matches(['-', '*', '>', ' ']).trim();
            if !clean.is_empty() {
                first_body = if clean.chars().count() > 80 {
                    format!("{}…", clean.chars().take(80).collect::<String>())
                } else {
                    clean.to_string()
                };
                break;
            }
        }
    }
    if first_body.is_empty() {
        first_body = title.clone();
    }
    (title, first_body)
}

pub fn list_space_topics(space_id: &str) -> Result<Vec<MemoryTopicRecord>, CollaborationError> {
    let dir = space_topics_dir(space_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| bad(e.to_string()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file()
            || path
                .extension()
                .and_then(|e| e.to_str())
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("md"))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let meta = std::fs::metadata(&path).ok();
        let byte_size = meta
            .as_ref()
            .map(|m| m.len())
            .unwrap_or(content.len() as u64);
        let updated_at = meta
            .and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_else(now);
        let (title, summary) = parse_topic_title_and_summary(stem, &content);
        out.push(MemoryTopicRecord {
            topic: stem.to_string(),
            title,
            summary,
            char_count: content.chars().count(),
            byte_size,
            updated_at,
            file_path: path.to_string_lossy().replace('\\', "/"),
            content,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn read_space_topic(
    space_id: &str,
    topic: &str,
) -> Result<MemoryTopicRecord, CollaborationError> {
    let slug = sanitize_topic_slug(topic)?;
    let path = space_topics_dir(space_id).join(format!("{slug}.md"));
    let content = std::fs::read_to_string(&path).map_err(|_| {
        CollaborationError::new("not_found", format!("memory topic '{slug}' was not found"))
    })?;
    let meta = std::fs::metadata(&path).ok();
    let byte_size = meta
        .as_ref()
        .map(|m| m.len())
        .unwrap_or(content.len() as u64);
    let updated_at = meta
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(now);
    let (title, summary) = parse_topic_title_and_summary(&slug, &content);
    Ok(MemoryTopicRecord {
        topic: slug,
        title,
        summary,
        char_count: content.chars().count(),
        byte_size,
        updated_at,
        file_path: path.to_string_lossy().replace('\\', "/"),
        content,
    })
}

pub fn write_space_topic(
    space_id: &str,
    topic: &str,
    title: Option<&str>,
    content: &str,
    actor: &str,
) -> Result<MemoryTopicRecord, CollaborationError> {
    let slug = sanitize_topic_slug(topic)?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(bad("topic content is required"));
    }
    if trimmed.chars().count() > MEMORY_TOPIC_MAX_CHARS {
        return Err(bad(format!(
            "topic content exceeds {MEMORY_TOPIC_MAX_CHARS} characters"
        )));
    }
    if let Some(reason) = contains_secret_or_credential(trimmed) {
        return Err(CollaborationError::new(
            "secret_rejected",
            format!("主题写入被安全策略拦截（{reason}）：请勿将密码、密钥或敏感证件号存入记忆主题"),
        ));
    }
    let dir = space_topics_dir(space_id);
    std::fs::create_dir_all(&dir).map_err(|e| bad(e.to_string()))?;
    let path = dir.join(format!("{slug}.md"));
    if !path.exists() {
        let existing_count = list_space_topics(space_id).map(|v| v.len()).unwrap_or(0);
        if existing_count >= MEMORY_MAX_TOPICS {
            return Err(bad(format!(
                "maximum of {MEMORY_MAX_TOPICS} topics reached for this space"
            )));
        }
    }
    let previous = std::fs::read_to_string(&path).ok();
    let final_body = if let Some(explicit_title) = title.map(str::trim).filter(|s| !s.is_empty()) {
        if trimmed.starts_with('#') {
            trimmed.to_string()
        } else {
            format!("# {explicit_title}\n\n{trimmed}\n")
        }
    } else {
        format!("{trimmed}\n")
    };
    std::fs::write(&path, &final_body).map_err(|e| bad(e.to_string()))?;
    append_memory_journal(
        space_id,
        actor,
        "topic_write",
        "topic",
        &format!("topic:{slug}"),
        previous.as_deref(),
        Some(&final_body),
    );
    read_space_topic(space_id, &slug)
}

pub fn delete_space_topic(
    space_id: &str,
    topic: &str,
    actor: &str,
) -> Result<bool, CollaborationError> {
    let slug = sanitize_topic_slug(topic)?;
    let path = space_topics_dir(space_id).join(format!("{slug}.md"));
    if !path.exists() {
        return Ok(false);
    }
    let previous = std::fs::read_to_string(&path).ok();
    std::fs::remove_file(&path).map_err(|e| bad(e.to_string()))?;
    append_memory_journal(
        space_id,
        actor,
        "topic_delete",
        "topic",
        &format!("topic:{slug}"),
        previous.as_deref(),
        None,
    );
    Ok(true)
}

pub(super) fn resolve_member_id_from_space(
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Option<String> {
    if let Some(id) = space_id
        .trim()
        .strip_prefix("direct:")
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(id.to_string());
    }
    if space_id.trim().is_empty()
        && let Some(m) = explicit_member_id.map(str::trim).filter(|s| !s.is_empty())
    {
        return Some(m.to_string());
    }
    None
}

pub(super) async fn resolve_writer_member_for_space(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Result<String, CollaborationError> {
    if let Some(m) = explicit_member_id.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(m.to_string());
    }
    if let Some(member_id) = resolve_member_id_from_space(space_id, explicit_member_id) {
        return Ok(member_id);
    }
    // Check group lead or any active member in `collaboration_thread_members`
    if let Some(member_id) = sqlx::query_scalar::<_, String>(
        r#"SELECT member_id FROM collaboration_thread_members
           WHERE thread_id = ? AND status = 'active'
           ORDER BY joined_at ASC LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    {
        return Ok(member_id);
    }
    // Check `collaboration_space_members` conversation_id -> member_id
    if let Some(conv_str) = sqlx::query_scalar::<_, String>(
        r#"SELECT conversation_id FROM collaboration_space_members
           WHERE space_id = ? AND status = 'active'
           ORDER BY is_lead DESC, created_at ASC LIMIT 1"#,
    )
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
        && let Ok(cid) = Uuid::parse_str(conv_str.trim())
        && let Some(mid) = resolve_member_id(pool, cid).await?
    {
        return Ok(mid);
    }
    // Fallback: any existing member in collaboration_members
    if let Some(member_id) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM collaboration_members ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(db)?
    {
        return Ok(member_id);
    }
    Err(CollaborationError::new(
        "not_a_member",
        "no assistant member available in this space to bind memory facts",
    ))
}
