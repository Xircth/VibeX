use super::*;

// ---------------------------------------------------------------------------
// Model-driven Memory Review & Distillation (DS-Bot Architecture)
// ---------------------------------------------------------------------------

/// Per-conversation review cursor stored inside a Space's `reviewed.json` so multi-member
/// group spaces never overwrite or clobber one another's turn cursors.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationReviewCursor {
    #[serde(default)]
    pub last_turn_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
}

/// Persisted review cursor per Space (`~/.dimo/spaces/<space_id>/reviewed.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceReviewState {
    #[serde(default)]
    pub last_turn_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
    #[serde(default)]
    pub last_activity_id: i64,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub conversations: HashMap<String, ConversationReviewCursor>,
}

pub(super) static SPACE_REVIEW_LOCKS: OnceLock<
    std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

/// Per-space serialization lock (DS-Bot `reviewChain` per space key) ensuring concurrent
/// reviews on the same Space never read stale cursors or overwrite `MEMORY.md` / `reviewed.json`.
pub fn space_review_lock(space_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let map = SPACE_REVIEW_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut guard = map.lock().expect("space review locks mutex poisoned");
    guard
        .entry(space_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub fn space_reviewed_path(space_id: &str) -> std::path::PathBuf {
    space_memory_root_dir(space_id).join("reviewed.json")
}

pub fn read_space_review_state(space_id: &str) -> SpaceReviewState {
    std::fs::read_to_string(space_reviewed_path(space_id))
        .ok()
        .and_then(|raw| serde_json::from_str::<SpaceReviewState>(&raw).ok())
        .unwrap_or_default()
}

pub fn write_space_review_state(space_id: &str, state: &SpaceReviewState) {
    let dir = space_memory_root_dir(space_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(state) {
        let _ = std::fs::write(space_reviewed_path(space_id), bytes);
    }
}

/// Prompt payload passed to [`MemoryReviewModel`] to decide `add` / `edit` / `remove` on a Space's `MEMORY.md`.
#[derive(Debug, Clone)]
pub struct MemoryReviewPrompt {
    pub space_id: String,
    pub member_id: String,
    pub conversation_id: Option<Uuid>,
    pub system_prompt: String,
    pub user_prompt: String,
}

/// Model interface for DS-Bot style memory review (`add` / `edit` / `remove`).
#[async_trait::async_trait]
pub trait MemoryReviewModel: Send + Sync {
    async fn complete_review(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<String, CollaborationError>;
}

pub(super) static REVIEW_MODEL: OnceLock<std::sync::RwLock<Option<Arc<dyn MemoryReviewModel>>>> =
    OnceLock::new();
pub(super) static RUNTIME_REVIEW_MODEL: OnceLock<std::sync::RwLock<Option<Arc<dyn MemoryReviewModel>>>> =
    OnceLock::new();

/// Install or replace a process-wide [`MemoryReviewModel`] (used by tests or custom hosts).
pub fn set_memory_review_model(model: Arc<dyn MemoryReviewModel>) -> bool {
    let cell = REVIEW_MODEL.get_or_init(|| std::sync::RwLock::new(None));
    if let Ok(mut guard) = cell.write() {
        *guard = Some(model);
        return true;
    }
    false
}

/// Clear any test-installed [`MemoryReviewModel`].
pub fn clear_memory_review_model() {
    if let Some(cell) = REVIEW_MODEL.get()
        && let Ok(mut guard) = cell.write()
    {
        *guard = None;
    }
}

pub(super) fn active_memory_review_model() -> Option<Arc<dyn MemoryReviewModel>> {
    if let Some(cell) = REVIEW_MODEL.get()
        && let Ok(guard) = cell.read()
        && let Some(ref model) = *guard
    {
        return Some(model.clone());
    }
    if let Some(cell) = RUNTIME_REVIEW_MODEL.get()
        && let Ok(guard) = cell.read()
        && let Some(ref model) = *guard
    {
        return Some(model.clone());
    }
    None
}

pub(super) fn register_runtime_review_model(model: Arc<dyn MemoryReviewModel>) {
    let cell = RUNTIME_REVIEW_MODEL.get_or_init(|| std::sync::RwLock::new(None));
    if let Ok(mut guard) = cell.write()
        && guard.is_none()
    {
        *guard = Some(model);
    }
}

/// Reusable resident ACP session for background memory review so we do not spawn a new
/// Agent process/session on every review pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidentReviewSession {
    pub agent_id: agents::AgentId,
    pub session_id: agents::AgentSessionId,
    pub connection_id: agents::AgentConnectionId,
    pub review_count: usize,
}

pub(super) const MAX_RESIDENT_REVIEW_TURNS: usize = 64;

/// Backend lifecycle seam for [`ResidentReviewSessionPool`] so resident session reuse,
/// permission auto-rejection, and broken-session eviction can be verified in unit tests.
#[async_trait::async_trait]
pub trait ReviewSessionDriver: Send + Sync {
    async fn resolve_agent_id(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<agents::AgentId, CollaborationError>;

    async fn is_session_alive(&self, session: &ResidentReviewSession) -> bool;

    async fn prepare_session(
        &self,
        agent_id: &agents::AgentId,
        space_id: &str,
    ) -> Result<ResidentReviewSession, CollaborationError>;

    async fn touch_session(&self, session: &ResidentReviewSession);

    async fn discard_session(&self, session: &ResidentReviewSession);

    async fn run_prompt(
        &self,
        session: &ResidentReviewSession,
        combined_prompt: String,
    ) -> Result<String, CollaborationError>;
}

/// Manages resident review sessions keyed by [`agents::AgentId`], reusing live sessions across
/// reviews and evicting/recreating only on connection loss, error, or turn cap.
#[derive(Default)]
pub struct ResidentReviewSessionPool {
    sessions: tokio::sync::Mutex<HashMap<agents::AgentId, ResidentReviewSession>>,
}

impl ResidentReviewSessionPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn complete_with_driver(
        &self,
        driver: &dyn ReviewSessionDriver,
        prompt: &MemoryReviewPrompt,
    ) -> Result<String, CollaborationError> {
        let agent_id = driver.resolve_agent_id(prompt).await?;
        let mut guard = self.sessions.lock().await;

        let reusable = if let Some(existing) = guard.get(&agent_id) {
            existing.review_count < MAX_RESIDENT_REVIEW_TURNS
                && driver.is_session_alive(existing).await
        } else {
            false
        };

        let session = if reusable {
            let s = guard.get(&agent_id).cloned().expect("checked above");
            driver.touch_session(&s).await;
            s
        } else {
            if let Some(stale) = guard.remove(&agent_id) {
                driver.discard_session(&stale).await;
            }
            let fresh = driver.prepare_session(&agent_id, &prompt.space_id).await?;
            guard.insert(agent_id.clone(), fresh.clone());
            fresh
        };

        let combined_prompt = format!(
            "<system_instructions>\n{}\n</system_instructions>\n\n{}",
            prompt.system_prompt, prompt.user_prompt
        );

        match driver.run_prompt(&session, combined_prompt).await {
            Ok(text) => {
                if let Some(entry) = guard.get_mut(&agent_id) {
                    entry.review_count += 1;
                }
                Ok(text)
            }
            Err(err) => {
                if let Some(broken) = guard.remove(&agent_id) {
                    driver.discard_session(&broken).await;
                }
                Err(err)
            }
        }
    }
}

pub(super) static GLOBAL_RESIDENT_REVIEW_POOL: OnceLock<ResidentReviewSessionPool> = OnceLock::new();

pub(super) fn global_resident_review_pool() -> &'static ResidentReviewSessionPool {
    GLOBAL_RESIDENT_REVIEW_POOL.get_or_init(ResidentReviewSessionPool::new)
}

/// Production [`MemoryReviewModel`] backed by [`crate::ConversationContext`] and [`agents::AgentRuntime`].
pub struct AgentRuntimeMemoryReviewModel {
    context: crate::ConversationContext,
}

impl AgentRuntimeMemoryReviewModel {
    pub fn new(context: crate::ConversationContext) -> Self {
        Self { context }
    }
}

#[async_trait::async_trait]
impl ReviewSessionDriver for AgentRuntimeMemoryReviewModel {
    async fn resolve_agent_id(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<agents::AgentId, CollaborationError> {
        let pool = &self.context.deployment.db().pool;
        if let Some(cid) = prompt.conversation_id
            && let Ok(Some(binding)) =
                db::models::conversation::ConversationAgentBindingRecord::active_for_conversation(
                    pool, cid,
                )
                .await
        {
            return Ok(binding.agent_id);
        }
        if let Ok(Some(raw_agent)) = sqlx::query_scalar::<_, String>(
            r#"SELECT s.agent_id
               FROM collaboration_thread_members m
               JOIN sessions s ON s.id = m.conversation_id
               WHERE m.member_id = ? AND s.agent_id IS NOT NULL
               ORDER BY m.joined_at DESC LIMIT 1"#,
        )
        .bind(&prompt.member_id)
        .fetch_optional(pool)
        .await
            && let Ok(parsed) = agents::AgentId::parse(&raw_agent)
        {
            return Ok(parsed);
        }
        Err(CollaborationError::new(
            "review_model_unavailable",
            "no bound agent available to run memory review",
        ))
    }

    async fn is_session_alive(&self, session: &ResidentReviewSession) -> bool {
        self.context
            .agent_runtime
            .session_has_ready_connection(session.session_id)
            .await
            && self
                .context
                .agent_runtime
                .has_bound_acp_session(session.session_id)
                .await
    }

    async fn prepare_session(
        &self,
        agent_id: &agents::AgentId,
        space_id: &str,
    ) -> Result<ResidentReviewSession, CollaborationError> {
        let pool = &self.context.deployment.db().pool;
        let launch = self
            .context
            .host
            .launch_settings(pool, agent_id)
            .await
            .map_err(|e| CollaborationError::new("review_model_unavailable", e.to_string()))?;

        let working_dir = utils::path::dimo_scratch_subdir("memory-review")
            .unwrap_or_else(|_| space_memory_root_dir(space_id));
        let prepared = self
            .context
            .agent_runtime
            .prepare_session(agents::EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id: Uuid::nil(),
                working_dir,
                additional_directories: Vec::new(),
                session_id: agents::AgentSessionId::new(),
                acp_session_id: String::new(),
                auto_approve_mode: agents::AgentAutoApproveMode::AllowAlways,
                env: launch.env,
                preferences: Default::default(),
            })
            .await
            .map_err(|e| CollaborationError::new("review_model_failed", e.to_string()))?;

        Ok(ResidentReviewSession {
            agent_id: agent_id.clone(),
            session_id: prepared.session.id,
            connection_id: prepared.session.connection_id,
            review_count: 0,
        })
    }

    async fn touch_session(&self, session: &ResidentReviewSession) {
        let _ = self
            .context
            .agent_runtime
            .touch_session(session.session_id)
            .await;
    }

    async fn discard_session(&self, session: &ResidentReviewSession) {
        let _ = self
            .context
            .agent_runtime
            .discard_connection(session.connection_id)
            .await;
    }

    async fn run_prompt(
        &self,
        session: &ResidentReviewSession,
        combined_prompt: String,
    ) -> Result<String, CollaborationError> {
        let mut events = self.context.agent_runtime.subscribe_events();
        self.context
            .agent_runtime
            .send_prompt(agents::SendAgentPromptInput {
                connection_id: session.connection_id,
                session_id: session.session_id,
                blocks: vec![agents::AgentContentBlock::Text {
                    text: combined_prompt,
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .map_err(|err| CollaborationError::new("review_model_failed", err.to_string()))?;

        let runtime = &self.context.agent_runtime;
        let collected = tokio::time::timeout(std::time::Duration::from_secs(45), async {
            let mut text = String::new();
            loop {
                match events.recv().await {
                    Ok(envelope) => {
                        if envelope.session_id != Some(session.session_id) {
                            continue;
                        }
                        match envelope.event {
                            agents::events::AgentEvent::MessageChunk {
                                content: agents::AgentContentBlock::Text { text: delta },
                            } => text.push_str(&delta),
                            agents::events::AgentEvent::PermissionRequested { request } => {
                                // Immediately approve any tool permission request so headless review
                                // never blocks waiting 45s for human approval.
                                let response =
                                    agents::permissions::decide_remote_permission_response(
                                        agents::permissions::RemotePermissionIntent::ApproveAlways,
                                        &request.options,
                                    )
                                    .or_else(|| {
                                        request.options.first().map(|opt| {
                                            agents::AgentPermissionResponse::selected(&opt.id)
                                        })
                                    })
                                    .unwrap_or(agents::AgentPermissionResponse::Cancelled);
                                let _ = runtime
                                    .respond_permission(agents::RespondAgentPermissionInput {
                                        connection_id: session.connection_id,
                                        permission_id: request.id,
                                        response,
                                    })
                                    .await;
                            }
                            agents::events::AgentEvent::ElicitationRequested { request } => {
                                let _ = runtime
                                    .respond_elicitation(agents::RespondAgentElicitationInput {
                                        connection_id: session.connection_id,
                                        elicitation_id: request.id,
                                        response:
                                            agents::elicitation::AgentElicitationResponse::Accept {
                                                content: serde_json::json!({}),
                                            },
                                    })
                                    .await;
                            }
                            agents::events::AgentEvent::PromptFinished { .. } => {
                                return Ok(text);
                            }
                            agents::events::AgentEvent::Error { error } => {
                                return Err(CollaborationError::new(
                                    "review_model_failed",
                                    error.message,
                                ));
                            }
                            _ => {}
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(CollaborationError::new(
                            "review_model_failed",
                            "event stream closed during memory review",
                        ));
                    }
                }
            }
        })
        .await;

        match collected {
            Ok(res) => res,
            Err(_) => Err(CollaborationError::new(
                "review_model_timeout",
                "memory review timed out after 45s",
            )),
        }
    }
}

#[async_trait::async_trait]
impl MemoryReviewModel for AgentRuntimeMemoryReviewModel {
    async fn complete_review(
        &self,
        prompt: &MemoryReviewPrompt,
    ) -> Result<String, CollaborationError> {
        global_resident_review_pool()
            .complete_with_driver(self, prompt)
            .await
    }
}

/// One numbered entry (`[1]`, `[2]`, ...) presented to the review model.
#[derive(Debug, Clone)]
pub struct NumberedMemoryEntry {
    pub entry_number: usize,
    pub space_id: String,
    pub fact: MemberFact,
}

/// Structured change parsed from the review model's JSON response (`{"changes": [...]}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum MemoryReviewChange {
    Add {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        topic: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    #[serde(alias = "replace", alias = "update")]
    Edit {
        #[serde(alias = "id", alias = "factId")]
        entry: usize,
        text: String,
    },
    #[serde(alias = "delete", alias = "forget")]
    Remove {
        #[serde(alias = "id", alias = "factId")]
        entry: usize,
    },
}

/// Build DS-Bot's `reviewSystem` prompt for curating `MEMORY.md`.
pub fn build_review_system_prompt(bot_name: &str, where_label: &str, is_private: bool) -> String {
    let scope_note = if is_private {
        "All entries in this private space belong to the private MEMORY.md."
    } else {
        "By default new entries belong to this group space's MEMORY.md (`scope: \"thread\"`); set `\"scope\": \"global\"` only for cross-group universal rules."
    };
    format!(
        r#"You curate the long-term memory of an assistant ("{bot_name}") in {where_label}.
You are shown the current memory entries (numbered [1], [2], …) and the new conversation messages since the last review.

Decide what to add, edit, or remove so that the Space's MEMORY.md stays accurate, concise, and useful in future conversations.

What belongs in memory:
- Durable user preferences, working style, communication conventions, recurring workflows
- Standing project/group rules, architecture decisions, naming conventions, directory/tool agreements
- Stable facts about people, roles, responsibilities, or long-lived tasks

What does NOT belong in memory:
- One-off questions, transient task progress ("I will check...", "Fixed the bug"), greetings, or small talk
- Secrets, passwords, API keys, tokens, private keys, or sensitive ID numbers
- Anything already captured by an existing entry (unless updating it via "edit")

{scope_note}

Operations (maximum 8 changes):
- "add": record a new concise fact (single line, <= 300 chars). Optional "topic" (slug) if it belongs in `topics/<topic>.md`, and optional "scope" ("global" | "private" | "thread").
- "edit": update an existing entry [N] in place when a rule/preference changed or can be made tighter (`{{"op": "edit", "entry": N, "text": "..."}}`).
- "remove": delete an existing entry [N] when the user explicitly revokes it or it is obsolete/contradicted (`{{"op": "remove", "entry": N}}`).

Do NOT call any tools, read/write any files, or run any commands.
Reply with ONE JSON object only (no prose):
{{"changes": [
  {{"op": "add", "text": "..."}},
  {{"op": "edit", "entry": 1, "text": "..."}},
  {{"op": "remove", "entry": 2}}
]}}
If nothing should change, reply:
{{"changes": []}}"#
    )
}

/// Build DS-Bot's `reviewRequest` user prompt showing numbered entries and new messages.
pub fn build_review_user_prompt(
    where_label: &str,
    entries: &[NumberedMemoryEntry],
    memory_chars: usize,
    earlier_messages: &[String],
    new_messages: &[String],
) -> String {
    let mut out = String::new();
    out.push_str("Current memory entries:\n");
    if entries.is_empty() {
        out.push_str("(empty)\n");
    } else {
        for item in entries {
            out.push_str(&format!(
                "[{}] ({}) {}\n",
                item.entry_number, item.fact.scope, item.fact.content
            ));
        }
    }
    let capacity_note = if memory_chars > (MEMORY_MAIN_MAX_CHARS * 4 / 5) {
        " (Getting full — prefer editing or removing old entries over adding new ones.)"
    } else {
        ""
    };
    out.push_str(&format!(
        "\nMEMORY.md has {memory_chars} of {MEMORY_MAIN_MAX_CHARS} characters.{capacity_note}\n"
    ));

    if !earlier_messages.is_empty() {
        out.push_str(&format!(
            "\nEarlier in {where_label}, already reviewed (context only):\n"
        ));
        for msg in earlier_messages {
            out.push_str(&format!("{msg}\n"));
        }
    }

    out.push_str(&format!("\nNew in {where_label}, oldest first:\n"));
    for msg in new_messages {
        out.push_str(&format!("{msg}\n"));
    }
    out
}

/// Parse the model's JSON review response into validated [`MemoryReviewChange`] items (ported from DS-Bot's `parseReview`).
pub fn parse_review_response(raw: &str) -> Result<Vec<MemoryReviewChange>, CollaborationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let start = trimmed
        .find('{')
        .ok_or_else(|| bad("review response did not contain a JSON object"))?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| bad("review response did not contain a closing brace"))?;
    if end < start {
        return Err(bad("invalid JSON object bounds in review response"));
    }
    let json_slice = &trimmed[start..=end];
    let parsed_val: serde_json::Value =
        serde_json::from_str(json_slice).map_err(|e| bad(format!("invalid review JSON: {e}")))?;

    let Some(arr) = parsed_val
        .get("changes")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(Vec::new());
    };

    let mut changes = Vec::new();
    for item in arr {
        if changes.len() >= 8 {
            break;
        }
        if let Ok(change) = serde_json::from_value::<MemoryReviewChange>(item.clone()) {
            match &change {
                MemoryReviewChange::Add { text, .. } if !text.trim().is_empty() => {
                    changes.push(change);
                }
                MemoryReviewChange::Edit { entry, text }
                    if *entry >= 1 && !text.trim().is_empty() =>
                {
                    changes.push(change);
                }
                MemoryReviewChange::Remove { entry } if *entry >= 1 => {
                    changes.push(change);
                }
                _ => {}
            }
        }
    }
    Ok(changes)
}

/// Collect the numbered entries for a Space's `MEMORY.md` (plus `global` entries from `direct:<member_id>` when in a group).
pub fn collect_numbered_space_entries(
    space_id: &str,
    member_id: &str,
    is_private: bool,
) -> (Vec<NumberedMemoryEntry>, usize) {
    let primary_space = if is_private {
        format!("direct:{member_id}")
    } else {
        space_id.to_string()
    };
    let primary_parsed = read_space_memory_parsed(&primary_space, Some(member_id));
    let memory_chars: usize = primary_parsed
        .entries
        .iter()
        .map(|e| e.fact.content.chars().count())
        .sum();

    let mut out = Vec::new();
    for e in primary_parsed.entries {
        let num = out.len() + 1;
        out.push(NumberedMemoryEntry {
            entry_number: num,
            space_id: primary_space.clone(),
            fact: e.fact,
        });
    }
    if !is_private {
        let direct_space = format!("direct:{member_id}");
        let direct_parsed = read_space_memory_parsed(&direct_space, Some(member_id));
        for e in direct_parsed.entries {
            if e.fact.scope == "global" {
                let num = out.len() + 1;
                out.push(NumberedMemoryEntry {
                    entry_number: num,
                    space_id: direct_space.clone(),
                    fact: e.fact,
                });
            }
        }
    }
    (out, memory_chars)
}

/// Apply `add` / `edit` / `remove` changes from [`parse_review_response`] directly to the Space's `MEMORY.md` (ported from DS-Bot's `applyReview`).
pub async fn apply_review_changes(
    pool: &SqlitePool,
    space_id: &str,
    member_id: &str,
    is_private: bool,
    entries: &[NumberedMemoryEntry],
    changes: &[MemoryReviewChange],
) -> Result<Vec<MemoryAskChange>, CollaborationError> {
    let mut applied = Vec::new();
    for change in changes {
        match change {
            MemoryReviewChange::Add { text, topic, scope } => {
                let Ok(clean) = check_content(text) else {
                    continue;
                };
                if let Some(topic_slug) = topic.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    let target_space = if is_private {
                        format!("direct:{member_id}")
                    } else {
                        space_id.to_string()
                    };
                    let existing_body = read_space_topic(&target_space, topic_slug)
                        .ok()
                        .map(|t| t.content)
                        .unwrap_or_default();
                    let next_body = if existing_body.trim().is_empty() {
                        format!("- {clean}")
                    } else {
                        format!("{}\n- {clean}", existing_body.trim_end())
                    };
                    if write_space_topic(
                        &target_space,
                        topic_slug,
                        None,
                        &next_body,
                        "model_review",
                    )
                    .is_ok()
                    {
                        let _ = sync_space_memory_files(pool, &target_space, Some(member_id)).await;
                        applied.push(MemoryAskChange {
                            op: "add".to_string(),
                            fact_id: None,
                            text: clean,
                        });
                    }
                    continue;
                }

                let fact_scope = if is_private {
                    FactScope::Private
                } else {
                    match scope.as_deref().map(str::trim) {
                        Some("global") => FactScope::Global,
                        _ => FactScope::Thread(space_id.to_string()),
                    }
                };
                if let Ok(fact) = create_fact(
                    pool,
                    member_id,
                    &clean,
                    &fact_scope,
                    Some(space_id),
                    "model_review",
                )
                .await
                {
                    applied.push(MemoryAskChange {
                        op: "add".to_string(),
                        fact_id: Some(fact.id),
                        text: fact.content,
                    });
                }
            }
            MemoryReviewChange::Edit { entry, text } => {
                let Ok(clean) = check_content(text) else {
                    continue;
                };
                if *entry == 0 || *entry > entries.len() {
                    continue;
                }
                let Some(target) = entries.iter().find(|e| e.entry_number == *entry) else {
                    continue;
                };
                remember_member_space(&target.fact.member_id, &target.space_id);
                if let Ok(updated) = update_fact(
                    pool,
                    &target.fact.member_id,
                    target.fact.id,
                    Some(&clean),
                    None,
                )
                .await
                {
                    applied.push(MemoryAskChange {
                        op: "edit".to_string(),
                        fact_id: Some(updated.id),
                        text: updated.content,
                    });
                }
            }
            MemoryReviewChange::Remove { entry } => {
                if *entry == 0 || *entry > entries.len() {
                    continue;
                }
                let Some(target) = entries.iter().find(|e| e.entry_number == *entry) else {
                    continue;
                };
                remember_member_space(&target.fact.member_id, &target.space_id);
                if let Ok(true) = delete_fact(pool, &target.fact.member_id, target.fact.id).await {
                    applied.push(MemoryAskChange {
                        op: "remove".to_string(),
                        fact_id: Some(target.fact.id),
                        text: target.fact.content.clone(),
                    });
                }
            }
        }
    }
    Ok(applied)
}

/// Folds recent activity into long-term facts. Implementations return fact
/// contents; scope is decided by the runner so private activity can only
/// ever produce `private` facts.
#[async_trait::async_trait]
pub trait FactDistiller: Send + Sync {
    async fn distill(&self, member_id: &str, activity: &[ActivityEntry]) -> Vec<DistilledFact>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistilledFact {
    pub content: String,
    /// Ask for `global` scope; ignored when any source entry is private.
    pub global: bool,
    /// Thread the fact came from (for `thread:<id>` scope).
    pub thread_id: Option<String>,
}

/// Model-backed default distiller: delegates to the active [`MemoryReviewModel`] if available,
/// never falling back to code-level keyword heuristics.
#[derive(Debug, Default, Clone, Copy)]
pub struct DefaultFactDistiller;

#[async_trait::async_trait]
impl FactDistiller for DefaultFactDistiller {
    async fn distill(&self, member_id: &str, activity: &[ActivityEntry]) -> Vec<DistilledFact> {
        let Some(model) = active_memory_review_model() else {
            return Vec::new();
        };
        if activity.is_empty() {
            return Vec::new();
        }
        let is_private = activity.iter().any(|a| a.private);
        let sample_thread = if is_private {
            format!("direct:{member_id}")
        } else {
            activity
                .last()
                .map(|a| a.thread_id.clone())
                .unwrap_or_else(|| format!("direct:{member_id}"))
        };
        let (entries, memory_chars) =
            collect_numbered_space_entries(&sample_thread, member_id, is_private);
        let new_messages: Vec<String> = activity
            .iter()
            .map(|a| format!("[{}] {}", a.created_at, a.summary))
            .collect();
        let prompt = MemoryReviewPrompt {
            space_id: sample_thread.clone(),
            member_id: member_id.to_string(),
            conversation_id: None,
            system_prompt: build_review_system_prompt(member_id, &sample_thread, is_private),
            user_prompt: build_review_user_prompt(
                &sample_thread,
                &entries,
                memory_chars,
                &[],
                &new_messages,
            ),
        };
        let Ok(raw) = model.complete_review(&prompt).await else {
            return Vec::new();
        };
        let Ok(changes) = parse_review_response(&raw) else {
            return Vec::new();
        };
        changes
            .into_iter()
            .filter_map(|c| match c {
                MemoryReviewChange::Add { text, scope, .. } => Some(DistilledFact {
                    content: text,
                    global: !is_private && scope.as_deref() == Some("global"),
                    thread_id: (!is_private).then(|| sample_thread.clone()),
                }),
                _ => None,
            })
            .collect()
    }
}

pub(super) static DISTILLER: OnceLock<Arc<dyn FactDistiller>> = OnceLock::new();

/// Install a process-wide fact distiller (first call wins).
pub fn set_fact_distiller(distiller: Arc<dyn FactDistiller>) -> bool {
    DISTILLER.set(distiller).is_ok()
}

pub(super) fn fact_distiller() -> Arc<dyn FactDistiller> {
    DISTILLER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(DefaultFactDistiller))
}

/// Extract clean user message body from a space delivery prompt (stripping
/// opening blocks and `[Message from ...]` / `[Group chat ...]` header lines).
pub(super) fn extract_last_user_delivery_body(raw_prompt: &str) -> &str {
    let trimmed = raw_prompt.trim();
    if trimmed.contains("<dimo-private-bootstrap>") {
        return "";
    }
    let mut header_end_and_line: Option<(usize, &str)> = None;
    let mut offset = 0;
    for line in trimmed.split('\n') {
        let l = line.trim();
        if l.starts_with('[')
            && l.ends_with(']')
            && (l.starts_with("[Message from ") || l.starts_with("[Group chat"))
        {
            header_end_and_line = Some((offset + line.len(), l));
        }
        offset += line.len() + 1;
    }
    if let Some((header_end, header_line)) = header_end_and_line {
        let sender = if let Some(rest) = header_line.strip_prefix("[Message from ") {
            rest.trim_end_matches(']')
                .split(" · ")
                .next()
                .map(str::trim)
        } else if let Some((_, after_from)) = header_line.split_once(" · from ") {
            after_from
                .trim_end_matches(']')
                .split(" · ")
                .next()
                .map(str::trim)
        } else {
            None
        };
        if let Some(sender) = sender
            && !crate::collaboration::is_person_ref(sender)
        {
            return "";
        }
        let rest = trimmed
            .get(header_end..)
            .unwrap_or("")
            .trim_start_matches(['\r', '\n']);
        let body = rest
            .split("\n\n[本轮新增群内消息]")
            .next()
            .unwrap_or(rest)
            .split("\n\n[上次发言后的群内新消息]")
            .next()
            .unwrap_or(rest);
        return body.trim();
    }
    let mut byte_offset = 0;
    for block in trimmed.split("\n\n") {
        let b = block.trim();
        if b.starts_with("[上次发言后的群内新消息]")
            || b.starts_with("[本轮新增群内消息]")
            || b.starts_with("[成员记忆]")
            || b.starts_with("[Space 身份与协作规则]")
            || b.starts_with("人设\n")
            || b.starts_with("[协作空间")
        {
            byte_offset += block.len() + 2;
            continue;
        }
        let rest = trimmed.get(byte_offset..).unwrap_or(b);
        return rest
            .split("\n\n[本轮新增群内消息]")
            .next()
            .unwrap_or(rest)
            .split("\n\n[上次发言后的群内新消息]")
            .next()
            .unwrap_or(rest)
            .trim();
    }
    trimmed
}

pub(super) fn format_turns_for_review(turns: &[agents::MessageTurn]) -> Vec<(String, String)> {
    let mut formatted_turns: Vec<(String, String)> = Vec::new();
    for turn in turns {
        if turn.id.contains(":steer:") {
            continue;
        }
        let raw_text = turn
            .blocks
            .iter()
            .filter_map(|b| match b {
                agents::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        match turn.role {
            agents::TurnRole::User => {
                let clean = extract_last_user_delivery_body(&raw_text).trim();
                if !clean.is_empty() {
                    formatted_turns.push((turn.id.clone(), format!("User: {clean}")));
                }
            }
            agents::TurnRole::Assistant => {
                let clean = crate::collaboration::strip_stray_pass_tokens(&raw_text);
                if !clean.is_empty() && !crate::collaboration::is_pass_token(clean) {
                    let condensed =
                        first_sentences(clean, 3, 400).unwrap_or_else(|| clean.to_string());
                    formatted_turns.push((turn.id.clone(), format!("Assistant: {condensed}")));
                }
            }
            agents::TurnRole::System => {}
        }
    }
    formatted_turns
}

/// Run DS-Bot's model-driven post-turn memory review on `conversation_id` using `model`
/// with the default [`MEMORY_REVIEW_MIN_NEW_MESSAGES`] (30-message) incremental threshold.
pub async fn review_conversation_memory_with_model(
    pool: &SqlitePool,
    conversation_id: Uuid,
    model: &dyn MemoryReviewModel,
) -> Result<Vec<MemoryAskChange>, CollaborationError> {
    review_conversation_memory_with_threshold(
        pool,
        conversation_id,
        model,
        MEMORY_REVIEW_MIN_NEW_MESSAGES,
    )
    .await
}

/// Run DS-Bot's model-driven post-turn memory review on `conversation_id` using `model`,
/// requiring at least `min_new_messages` unreviewed messages across the Space before invoking
/// the review model. Serializes concurrent reviews for the same Space via [`space_review_lock`].
pub async fn review_conversation_memory_with_threshold(
    pool: &SqlitePool,
    conversation_id: Uuid,
    model: &dyn MemoryReviewModel,
    min_new_messages: usize,
) -> Result<Vec<MemoryAskChange>, CollaborationError> {
    let Some(caller) = memory_caller(pool, conversation_id).await? else {
        return Ok(Vec::new());
    };
    let target_space = if caller.private {
        format!("direct:{}", caller.member_id)
    } else {
        caller.thread_id.clone()
    };

    let space_lock = space_review_lock(&target_space);
    let _space_guard = space_lock.lock().await;

    let space_conversations: Vec<Uuid> = if caller.private {
        vec![conversation_id]
    } else {
        let mut rows: Vec<String> = sqlx::query_scalar(
            r#"SELECT conversation_id
               FROM collaboration_space_members
               WHERE space_id = ? AND conversation_id IS NOT NULL
               ORDER BY rowid ASC"#,
        )
        .bind(&caller.thread_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let thread_rows: Vec<String> = sqlx::query_scalar(
            r#"SELECT conversation_id
               FROM collaboration_thread_members
               WHERE thread_id = ? AND conversation_id IS NOT NULL
               ORDER BY joined_at ASC"#,
        )
        .bind(&caller.thread_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        rows.extend(thread_rows);
        let mut ids: Vec<Uuid> = Vec::new();
        for raw in rows {
            if let Ok(cid) = Uuid::parse_str(raw.trim())
                && !ids.contains(&cid)
            {
                ids.push(cid);
            }
        }
        if !ids.contains(&conversation_id) {
            ids.push(conversation_id);
        }
        ids
    };

    let mut review_state = read_space_review_state(&target_space);
    let mut earlier_messages: Vec<String> = Vec::new();
    let mut new_messages: Vec<String> = Vec::new();
    let mut next_cursors: HashMap<String, ConversationReviewCursor> =
        review_state.conversations.clone();
    let mut latest_primary_cursor: Option<ConversationReviewCursor> = None;

    for conv_id in &space_conversations {
        let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, *conv_id).await;
        let turns = crate::ConversationProjector::project_turns_summary(pool, *conv_id)
            .await
            .map_err(db)?;
        let formatted_turns = format_turns_for_review(&turns);
        if formatted_turns.is_empty() {
            continue;
        }
        let conv_key = conv_id.to_string();
        let split_idx = if let Some(cursor) = review_state.conversations.get(&conv_key) {
            if let Some(ref last_id) = cursor.last_turn_id
                && let Some(pos) = formatted_turns.iter().rposition(|(id, _)| id == last_id)
            {
                pos + 1
            } else {
                cursor.last_turn_count.min(formatted_turns.len())
            }
        } else if space_conversations.len() == 1 || *conv_id == conversation_id {
            if let Some(ref last_id) = review_state.last_turn_id
                && let Some(pos) = formatted_turns.iter().rposition(|(id, _)| id == last_id)
            {
                pos + 1
            } else if space_conversations.len() == 1 {
                review_state.last_turn_count.min(formatted_turns.len())
            } else {
                0
            }
        } else {
            0
        };

        let updated_cursor = ConversationReviewCursor {
            last_turn_count: formatted_turns.len(),
            last_turn_id: formatted_turns.last().map(|(id, _)| id.clone()),
        };
        if *conv_id == conversation_id || latest_primary_cursor.is_none() {
            latest_primary_cursor = Some(updated_cursor.clone());
        }
        next_cursors.insert(conv_key, updated_cursor);

        if split_idx < formatted_turns.len() {
            let earlier_start = split_idx.saturating_sub(6);
            for (_, text) in &formatted_turns[earlier_start..split_idx] {
                if earlier_messages.len() < 6 {
                    earlier_messages.push(text.clone());
                }
            }
            for (_, text) in &formatted_turns[split_idx..] {
                new_messages.push(text.clone());
            }
        }
    }

    let required_messages = min_new_messages.max(1);
    if new_messages.len() < required_messages {
        return Ok(Vec::new());
    }

    let (entries, memory_chars) =
        collect_numbered_space_entries(&target_space, &caller.member_id, caller.private);
    let where_label = if caller.private {
        "private chat".to_string()
    } else {
        let title = identity::load_thread(pool, &caller.thread_id)
            .await
            .ok()
            .flatten()
            .map(|t| t.title)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| caller.thread_id.clone());
        format!("group \"{title}\"")
    };

    let prompt = MemoryReviewPrompt {
        space_id: target_space.clone(),
        member_id: caller.member_id.clone(),
        conversation_id: Some(conversation_id),
        system_prompt: build_review_system_prompt(&caller.member_id, &where_label, caller.private),
        user_prompt: build_review_user_prompt(
            &where_label,
            &entries,
            memory_chars,
            &earlier_messages,
            &new_messages,
        ),
    };

    let raw_response = model.complete_review(&prompt).await?;
    let changes = parse_review_response(&raw_response)?;
    let applied = apply_review_changes(
        pool,
        &target_space,
        &caller.member_id,
        caller.private,
        &entries,
        &changes,
    )
    .await?;

    if let Some(primary) = latest_primary_cursor {
        review_state.last_turn_count = primary.last_turn_count;
        review_state.last_turn_id = primary.last_turn_id;
    }
    review_state.conversations = next_cursors;
    review_state.updated_at = now();
    write_space_review_state(&target_space, &review_state);

    Ok(applied)
}

