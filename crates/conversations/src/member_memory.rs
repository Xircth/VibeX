//! Phase 4 member memory.
//!
//! * Short-term: `member_activity` gets one 1–2 sentence "what I did" line
//!   per completed member turn ([`record_turn_activity`]); the latest N
//!   entries across the member's threads are injected at turn start.
//! * Long-term: `member_facts` with a scope — `global`, `thread:<id>` or
//!   `private` — retrieved by keyword/BM25 relevance at turn start.
//!
//! Privacy: entries and facts that come from a direct (private) thread are
//! only ever shown inside a direct thread. Group threads never see them, not
//! even as a placeholder line.

use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

use chrono::{SecondsFormat, Utc};
use db::models::collaboration_identity as identity;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::collaboration::CollaborationError;

/// Default number of recent activity entries injected at turn start.
pub const DEFAULT_ACTIVITY_LIMIT: usize = 8;
/// Default number of relevant facts injected at turn start.
pub const DEFAULT_FACT_LIMIT: usize = 6;
const SUMMARY_MAX_CHARS: usize = 240;
const FACT_MAX_CHARS: usize = 2_000;

fn db(error: sqlx::Error) -> CollaborationError {
    CollaborationError::new("memory_failed", error.to_string())
}

fn bad(message: impl Into<String>) -> CollaborationError {
    CollaborationError::new("bad_request", message)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Thread context
// ---------------------------------------------------------------------------

/// Where a member session currently is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryCaller {
    pub member_id: String,
    pub thread_id: String,
    /// True for direct (private) threads.
    pub private: bool,
}

/// Member identity + thread of `conversation_id`, `None` when the
/// conversation is not a member seat.
pub async fn memory_caller(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<MemoryCaller>, CollaborationError> {
    let Some(binding) = identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
    else {
        return Ok(None);
    };
    let private = thread_is_private(pool, &binding.thread_id).await?;
    Ok(Some(MemoryCaller {
        member_id: binding.member_id,
        thread_id: binding.thread_id,
        private,
    }))
}

async fn thread_is_private(pool: &SqlitePool, thread_id: &str) -> Result<bool, CollaborationError> {
    if thread_id.starts_with("direct:") {
        return Ok(true);
    }
    Ok(identity::load_thread(pool, thread_id)
        .await
        .map_err(db)?
        .is_some_and(|thread| thread.kind == "direct"))
}

// ---------------------------------------------------------------------------
// Short-term activity
// ---------------------------------------------------------------------------

/// Turns a finished turn into a short "what I did" line. Pluggable so an LLM
/// summariser can replace the deterministic default.
pub trait ActivitySummarizer: Send + Sync {
    fn summarize(&self, turn: &TurnForSummary) -> Option<String>;
}

#[derive(Debug, Clone, Default)]
pub struct TurnForSummary {
    /// The member's final reply text of the turn.
    pub reply: String,
}

/// Deterministic default: first one or two sentences of the final reply,
/// whitespace-collapsed and capped at 240 characters.
#[derive(Debug, Default, Clone, Copy)]
pub struct FirstSentencesSummarizer;

impl ActivitySummarizer for FirstSentencesSummarizer {
    fn summarize(&self, turn: &TurnForSummary) -> Option<String> {
        first_sentences(&turn.reply, 2, SUMMARY_MAX_CHARS)
    }
}

fn first_sentences(text: &str, sentences: usize, max_chars: usize) -> Option<String> {
    let flat = text
        .lines()
        .map(|line| line.trim().trim_start_matches(['#', '-', '*', '>', ' ']))
        .filter(|line| !line.is_empty() && !line.starts_with("```"))
        .collect::<Vec<_>>()
        .join(" ");
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let mut out = String::new();
    let mut count = 0;
    let mut chars = flat.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        let ends = matches!(ch, '。' | '！' | '？' | '!' | '?')
            || (ch == '.' && chars.peek().is_none_or(|next| next.is_whitespace()));
        if ends {
            count += 1;
            if count >= sentences {
                break;
            }
        }
    }
    let mut out = out.trim().to_string();
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars).collect::<String>() + "…";
    }
    Some(out)
}

static SUMMARIZER: OnceLock<Arc<dyn ActivitySummarizer>> = OnceLock::new();

/// Install a process-wide summariser (first call wins).
pub fn set_activity_summarizer(summarizer: Arc<dyn ActivitySummarizer>) -> bool {
    SUMMARIZER.set(summarizer).is_ok()
}

fn summarizer() -> Arc<dyn ActivitySummarizer> {
    SUMMARIZER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(FirstSentencesSummarizer))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: i64,
    pub member_id: String,
    pub thread_id: String,
    pub summary: String,
    pub private: bool,
    pub created_at: String,
}

/// Append a summary of `reply` for the member behind `conversation_id`.
/// Idempotent per `turn_id`. `None` when not a member seat or nothing to say.
pub async fn record_activity(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Option<Uuid>,
    reply: &str,
    summarizer: &dyn ActivitySummarizer,
) -> Result<Option<i64>, CollaborationError> {
    let Some(caller) = memory_caller(pool, conversation_id).await? else {
        return Ok(None);
    };
    let Some(summary) = summarizer.summarize(&TurnForSummary {
        reply: reply.to_string(),
    }) else {
        return Ok(None);
    };
    let id = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO member_activity
           (member_id, thread_id, summary, created_at, conversation_id, turn_id, private)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(turn_id) WHERE turn_id IS NOT NULL DO NOTHING
           RETURNING id"#,
    )
    .bind(&caller.member_id)
    .bind(&caller.thread_id)
    .bind(summary)
    .bind(now())
    .bind(conversation_id.to_string())
    .bind(turn_id.map(|id| id.to_string()))
    .bind(caller.private)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    Ok(id)
}

/// Turn-end hook: summarise the last assistant reply of `turn_id` from the
/// conversation transcript with the installed summariser.
pub async fn record_turn_activity(
    pool: &SqlitePool,
    conversation_id: Uuid,
    turn_id: Uuid,
) -> Result<Option<i64>, CollaborationError> {
    if identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
        .is_none()
    {
        return Ok(None);
    }
    let turns = crate::jsonl_history::load_all_turns(pool, conversation_id)
        .await
        .map_err(db)?
        .unwrap_or_default();
    let reply = turns
        .iter()
        .rev()
        .find(|turn| turn.role == agents::TurnRole::Assistant)
        .map(|turn| {
            turn.blocks
                .iter()
                .filter_map(|block| match block {
                    agents::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if reply.trim().is_empty() {
        return Ok(None);
    }
    record_activity(pool, conversation_id, Some(turn_id), &reply, summarizer().as_ref()).await
}

/// Activity of `member_id`, newest first. `include_private` must only be
/// true for the member's own direct thread or the host (user) view.
pub async fn list_activity(
    pool: &SqlitePool,
    member_id: &str,
    include_private: bool,
    limit: usize,
) -> Result<Vec<ActivityEntry>, CollaborationError> {
    sqlx::query_as::<_, ActivityEntry>(
        r#"SELECT id, member_id, thread_id, summary, private != 0 AS private, created_at
           FROM member_activity
           WHERE member_id = ? AND (? OR private = 0)
           ORDER BY id DESC LIMIT ?"#,
    )
    .bind(member_id)
    .bind(include_private)
    .bind(limit.clamp(1, 500) as i64)
    .fetch_all(pool)
    .await
    .map_err(db)
}

// ---------------------------------------------------------------------------
// Long-term facts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FactScope {
    Global,
    Private,
    Thread(String),
}

impl FactScope {
    pub fn parse(raw: &str) -> Result<Self, CollaborationError> {
        match raw.trim() {
            "global" => Ok(Self::Global),
            "private" => Ok(Self::Private),
            other => match other.strip_prefix("thread:") {
                Some(id) if !id.is_empty() => Ok(Self::Thread(id.to_string())),
                _ => Err(bad("scope must be global, private or thread:<id>")),
            },
        }
    }

    pub fn as_db(&self) -> String {
        match self {
            Self::Global => "global".to_string(),
            Self::Private => "private".to_string(),
            Self::Thread(id) => format!("thread:{id}"),
        }
    }

    /// Whether a fact in this scope may be shown to `caller`.
    pub fn visible_to(&self, caller: &MemoryCaller) -> bool {
        match self {
            Self::Global => true,
            Self::Private => caller.private,
            Self::Thread(id) => *id == caller.thread_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberFact {
    pub id: i64,
    pub member_id: String,
    pub content: String,
    pub scope: String,
    pub source_thread_id: Option<String>,
    pub origin: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

type FactRow = (i64, String, String, String, Option<String>, String, String);

fn fact_from(row: FactRow) -> MemberFact {
    let (id, member_id, content, scope, source_thread_id, origin, updated_at) = row;
    MemberFact {
        id,
        member_id,
        content,
        scope,
        source_thread_id,
        origin,
        updated_at,
        score: None,
    }
}

const FACT_COLUMNS: &str =
    "id, member_id, content, scope, source_thread_id, origin, updated_at";

fn check_content(content: &str) -> Result<String, CollaborationError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(bad("content is required"));
    }
    if content.chars().count() > FACT_MAX_CHARS {
        return Err(bad(format!("content exceeds {FACT_MAX_CHARS} characters")));
    }
    Ok(content.to_string())
}

pub async fn create_fact(
    pool: &SqlitePool,
    member_id: &str,
    content: &str,
    scope: &FactScope,
    source_thread_id: Option<&str>,
    origin: &str,
) -> Result<MemberFact, CollaborationError> {
    let content = check_content(content)?;
    let stamp = now();
    let row = sqlx::query_as::<_, FactRow>(&format!(
        r#"INSERT INTO member_facts
           (member_id, content, scope, source_thread_id, updated_at, created_at, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING {FACT_COLUMNS}"#
    ))
    .bind(member_id)
    .bind(content)
    .bind(scope.as_db())
    .bind(source_thread_id)
    .bind(&stamp)
    .bind(&stamp)
    .bind(origin)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    Ok(fact_from(row))
}

/// Facts of `member_id`; `scope` filters to one exact scope.
pub async fn list_facts(
    pool: &SqlitePool,
    member_id: &str,
    scope: Option<&FactScope>,
) -> Result<Vec<MemberFact>, CollaborationError> {
    let rows = sqlx::query_as::<_, FactRow>(&format!(
        r#"SELECT {FACT_COLUMNS} FROM member_facts
           WHERE member_id = ? AND (? IS NULL OR scope = ?)
           ORDER BY updated_at DESC, id DESC"#
    ))
    .bind(member_id)
    .bind(scope.map(FactScope::as_db))
    .bind(scope.map(FactScope::as_db))
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(fact_from).collect())
}

pub async fn update_fact(
    pool: &SqlitePool,
    member_id: &str,
    fact_id: i64,
    content: Option<&str>,
    scope: Option<&FactScope>,
) -> Result<MemberFact, CollaborationError> {
    let content = content.map(check_content).transpose()?;
    let row = sqlx::query_as::<_, FactRow>(&format!(
        r#"UPDATE member_facts
           SET content = COALESCE(?, content), scope = COALESCE(?, scope), updated_at = ?
           WHERE id = ? AND member_id = ? RETURNING {FACT_COLUMNS}"#
    ))
    .bind(content)
    .bind(scope.map(FactScope::as_db))
    .bind(now())
    .bind(fact_id)
    .bind(member_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "memory fact was not found"))?;
    Ok(fact_from(row))
}

pub async fn delete_fact(
    pool: &SqlitePool,
    member_id: &str,
    fact_id: i64,
) -> Result<bool, CollaborationError> {
    let done = sqlx::query("DELETE FROM member_facts WHERE id = ? AND member_id = ?")
        .bind(fact_id)
        .bind(member_id)
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(done.rows_affected() > 0)
}

/// Facts visible to `caller`, ranked by BM25 against `query` (most recent
/// first when the query has no usable terms).
pub async fn search_facts(
    pool: &SqlitePool,
    caller: &MemoryCaller,
    query: &str,
    limit: usize,
) -> Result<Vec<MemberFact>, CollaborationError> {
    let visible: Vec<MemberFact> = list_facts(pool, &caller.member_id, None)
        .await?
        .into_iter()
        .filter(|fact| FactScope::parse(&fact.scope).is_ok_and(|s| s.visible_to(caller)))
        .collect();
    let terms = tokenize(query);
    if terms.is_empty() {
        return Ok(visible.into_iter().take(limit).collect());
    }
    let docs: Vec<Vec<String>> = visible.iter().map(|f| tokenize(&f.content)).collect();
    let scores = bm25(&docs, &terms);
    let mut ranked: Vec<(f64, MemberFact)> = visible
        .into_iter()
        .zip(scores)
        .filter(|(_, score)| *score > 0.0)
        .map(|(mut fact, score)| {
            fact.score = Some(score);
            (score, fact)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(ranked.into_iter().take(limit).map(|(_, fact)| fact).collect())
}

/// Lower-cased ASCII words plus CJK unigrams and bigrams.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut prev_cjk: Option<char> = None;
    let is_cjk = |c: char| matches!(c as u32, 0x3400..=0x9FFF | 0xF900..=0xFAFF);
    for ch in text.chars() {
        if is_cjk(ch) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            out.push(ch.to_string());
            if let Some(prev) = prev_cjk {
                out.push(format!("{prev}{ch}"));
            }
            prev_cjk = Some(ch);
        } else {
            prev_cjk = None;
            if ch.is_alphanumeric() || ch == '_' {
                word.extend(ch.to_lowercase());
            } else if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out.retain(|t| t.chars().count() > 1 || t.chars().all(is_cjk));
    out
}

fn bm25(docs: &[Vec<String>], terms: &[String]) -> Vec<f64> {
    const K1: f64 = 1.2;
    const B: f64 = 0.75;
    let n = docs.len() as f64;
    if docs.is_empty() {
        return Vec::new();
    }
    let avg = docs.iter().map(Vec::len).sum::<usize>() as f64 / n;
    let mut unique: Vec<&String> = terms.iter().collect();
    unique.sort();
    unique.dedup();
    let df: HashMap<&String, f64> = unique
        .iter()
        .map(|t| (*t, docs.iter().filter(|d| d.contains(t)).count() as f64))
        .collect();
    docs.iter()
        .map(|doc| {
            let len = doc.len() as f64;
            unique
                .iter()
                .map(|t| {
                    let tf = doc.iter().filter(|w| w == t).count() as f64;
                    if tf == 0.0 {
                        return 0.0;
                    }
                    let idf = ((n - df[t] + 0.5) / (df[t] + 0.5) + 1.0).ln();
                    idf * tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * len / avg.max(1.0)))
                })
                .sum()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Turn-start injection
// ---------------------------------------------------------------------------

/// Memory block for a turn of `conversation_id`: the latest `activity_limit`
/// activity lines across the member's threads and the facts most relevant to
/// `query`, both filtered by privacy/scope. `None` when there is nothing.
pub async fn memory_context_text(
    pool: &SqlitePool,
    conversation_id: Uuid,
    query: Option<&str>,
    activity_limit: usize,
) -> Result<Option<String>, CollaborationError> {
    let Some(caller) = memory_caller(pool, conversation_id).await? else {
        return Ok(None);
    };
    // Private entries only inside a private (direct) thread.
    let activity = list_activity(pool, &caller.member_id, caller.private, activity_limit).await?;
    let facts = search_facts(pool, &caller, query.unwrap_or_default(), DEFAULT_FACT_LIMIT).await?;
    if activity.is_empty() && facts.is_empty() {
        return Ok(None);
    }
    let mut titles: HashMap<String, String> = HashMap::new();
    let mut lines = vec!["[成员记忆]".to_string()];
    if !activity.is_empty() {
        lines.push("- 你最近在各处做过的事（新→旧）：".to_string());
        for entry in &activity {
            let place = if entry.thread_id == caller.thread_id {
                "本对话".to_string()
            } else if entry.private {
                "私聊".to_string()
            } else {
                if !titles.contains_key(&entry.thread_id) {
                    let title = identity::load_thread(pool, &entry.thread_id)
                        .await
                        .map_err(db)?
                        .map(|t| t.title)
                        .filter(|t| !t.trim().is_empty())
                        .unwrap_or_else(|| entry.thread_id.clone());
                    titles.insert(entry.thread_id.clone(), title);
                }
                format!("群「{}」", titles[&entry.thread_id])
            };
            lines.push(format!("  - [{}] {place}：{}", entry.created_at, entry.summary));
        }
    }
    if !facts.is_empty() {
        lines.push("- 相关长期记忆：".to_string());
        for fact in &facts {
            lines.push(format!("  - (#{} {}) {}", fact.id, fact.scope, fact.content));
        }
    }
    lines.push(
        "- 记忆工具：`memory_search` 查找更多记忆，`memory_write` 记录值得长期保留的事实（见 `vibex-multi-agent` Skill 的 `MEMORY.md`）。".to_string(),
    );
    Ok(Some(lines.join("\n")))
}

// ---------------------------------------------------------------------------
// Distillation hook
// ---------------------------------------------------------------------------

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

/// One distillation pass over every member with new activity. Returns the
/// number of facts written.
pub async fn distill_member_memory(
    pool: &SqlitePool,
    distiller: &dyn FactDistiller,
) -> Result<usize, CollaborationError> {
    let pending = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT a.member_id, COALESCE(s.last_activity_id, 0)
           FROM member_activity a
           LEFT JOIN member_memory_distill_state s ON s.member_id = a.member_id
           WHERE a.id > COALESCE(s.last_activity_id, 0)
           GROUP BY a.member_id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let mut written = 0;
    for (member_id, after) in pending {
        let activity = sqlx::query_as::<_, ActivityEntry>(
            r#"SELECT id, member_id, thread_id, summary, private != 0 AS private, created_at
               FROM member_activity WHERE member_id = ? AND id > ? ORDER BY id ASC LIMIT 200"#,
        )
        .bind(&member_id)
        .bind(after)
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
            let from_private = fact
                .thread_id
                .as_deref()
                .map_or(any_private, |t| private_threads.contains(&t));
            let scope = if from_private {
                FactScope::Private
            } else if fact.global {
                FactScope::Global
            } else if let Some(thread) = fact.thread_id.clone() {
                FactScope::Thread(thread)
            } else {
                FactScope::Global
            };
            if create_fact(
                pool,
                &member_id,
                &fact.content,
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
        sqlx::query(
            r#"INSERT INTO member_memory_distill_state (member_id, last_activity_id, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(member_id) DO UPDATE SET
                 last_activity_id = excluded.last_activity_id, updated_at = excluded.updated_at"#,
        )
        .bind(&member_id)
        .bind(last)
        .bind(now())
        .execute(pool)
        .await
        .map_err(db)?;
    }
    Ok(written)
}

/// Run [`distill_member_memory`] every `interval`.
pub fn spawn_memory_distiller(
    pool: SqlitePool,
    distiller: Arc<dyn FactDistiller>,
    interval: std::time::Duration,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if let Err(error) = distill_member_memory(&pool, distiller.as_ref()).await {
                tracing::warn!(%error, "member memory distillation failed");
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Agent tools (scoped to the calling member)
// ---------------------------------------------------------------------------

async fn require_caller(
    pool: &SqlitePool,
    caller_id: Uuid,
) -> Result<MemoryCaller, CollaborationError> {
    memory_caller(pool, caller_id).await?.ok_or_else(|| {
        CollaborationError::new("not_a_member", "memory tools need a collaboration member session")
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
    let caller = require_caller(pool, caller_id).await?;
    let limit = limit.clamp(1, 50);
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
    let activity: Vec<_> = hits.into_iter().take(limit).map(|(_, a)| a.clone()).collect();
    Ok(serde_json::json!({ "facts": facts, "activity": activity }))
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
        return Err(bad("an agent may only write thread facts for its current thread"));
    }
    let scope = if caller.private {
        FactScope::Private
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
