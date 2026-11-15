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
    collections::{HashMap, HashSet},
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
/// Recommended concise fact size (DS-Bot entry budget).
pub const MEMORY_ENTRY_MAX_CHARS: usize = 300;
/// Core `MEMORY.md` character budget per scope.
pub const MEMORY_MAIN_MAX_CHARS: usize = 4_000;
/// Maximum character count for a single `topics/<topic>.md` file.
pub const MEMORY_TOPIC_MAX_CHARS: usize = 16_000;
/// Maximum number of topic files per space.
pub const MEMORY_MAX_TOPICS: usize = 40;
/// Minimum number of unreviewed incremental messages required before automatic post-turn review runs.
pub const MEMORY_REVIEW_MIN_NEW_MESSAGES: usize = 30;
const SUMMARY_MAX_CHARS: usize = 240;

/// Inspect `text` for credentials, API keys, tokens, passwords, or long ID/card
/// numbers (ported from DS-Bot's `looksSecret` / `looksLikeKey` guard).
pub fn contains_secret_or_credential(text: &str) -> Option<&'static str> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return Some("private_key_block");
    }
    // Check well-known API key prefixes
    for token in trimmed.split(|c: char| {
        c.is_whitespace() || matches!(c, ',' | ';' | '"' | '\'' | '`' | '(' | ')' | '[' | ']')
    }) {
        let t = token.trim_matches(|c: char| matches!(c, ':' | '=' | '：'));
        if (t.starts_with("sk-")
            && t.len() >= 20
            && t[3..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            || ((t.starts_with("ghp_")
                || t.starts_with("gho_")
                || t.starts_with("ghu_")
                || t.starts_with("ghs_")
                || t.starts_with("ghr_"))
                && t.len() >= 24)
            || (t.starts_with("glpat-") && t.len() >= 20)
            || ((t.starts_with("xoxb-") || t.starts_with("xoxp-") || t.starts_with("xoxa-"))
                && t.len() >= 20)
            || (t.starts_with("AIza") && t.len() >= 24)
            || (t.starts_with("AKIA")
                && t.len() >= 16
                && t.chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        {
            return Some("api_key_prefix");
        }
        // 15..=19 contiguous digits (credit cards / national IDs)
        if (15..=19).contains(&t.len()) && t.chars().all(|c| c.is_ascii_digit()) {
            return Some("long_digit_sequence");
        }
    }

    // Check English keyword assignment: password/secret/api_key/token :|=|is <value>
    const EN_KEYS: &[&str] = &[
        "password",
        "passwd",
        "pwd",
        "secret",
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "auth_token",
        "private_key",
        "client_secret",
    ];
    for key in EN_KEYS {
        if let Some(pos) = lower.find(key) {
            let before_ok = pos == 0
                || !lower[..pos]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
            let rest = lower[pos + key.len()..].trim_start();
            let after_op = rest
                .strip_prefix(':')
                .or_else(|| rest.strip_prefix('='))
                .or_else(|| rest.strip_prefix("is "));
            if before_ok
                && let Some(val) = after_op
                && let Some(first_word) = val.split_whitespace().next()
                && first_word.len() >= 4
                && !matches!(
                    first_word.trim_matches(|c: char| !c.is_ascii_alphanumeric()),
                    "null" | "none" | "true" | "false" | "required" | "env" | "empty"
                )
            {
                return Some("credential_assignment");
            }
        }
    }

    // Check Chinese keyword assignment: 密码/口令/密钥/私钥/访问令牌 是/为/:/：/= <value>
    const ZH_KEYS: &[&str] = &["密码", "口令", "密钥", "私钥", "访问令牌"];
    for key in ZH_KEYS {
        if let Some(pos) = trimmed.find(key) {
            let rest = trimmed[pos + key.len()..].trim_start();
            let after_op = rest
                .strip_prefix(':')
                .or_else(|| rest.strip_prefix('：'))
                .or_else(|| rest.strip_prefix('='))
                .or_else(|| rest.strip_prefix('是'))
                .or_else(|| rest.strip_prefix('为'));
            if let Some(val) = after_op {
                let val_trimmed = val.trim_start();
                if let Some(first_word) = val_trimmed.split_whitespace().next() {
                    let clean = first_word.trim_matches(|c: char| {
                        matches!(c, '。' | '，' | ',' | '.' | '"' | '\'' | '`' | '“' | '”')
                    });
                    if clean.chars().count() >= 4
                        && clean.chars().any(|c| c.is_ascii_alphanumeric())
                    {
                        return Some("credential_assignment_zh");
                    }
                }
            }
        }
    }

    None
}

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

/// Resolve the bound collaboration member ID for `conversation_id` without
/// creating any member or thread rows for ordinary non-Bot sessions.
pub async fn resolve_member_id(
    pool: &SqlitePool,
    conversation_id: Uuid,
) -> Result<Option<String>, CollaborationError> {
    Ok(identity::binding_of_conversation(pool, conversation_id)
        .await
        .map_err(db)?
        .map(|binding| binding.member_id))
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
    let _ = crate::ensure_legacy_jsonl_migrated_on_pool(pool, conversation_id).await;
    let turns = crate::ConversationProjector::project_turns_summary(pool, conversation_id)
        .await
        .map_err(db)?;
    let last_user_idx = turns.iter().rposition(|turn| {
        matches!(turn.role, agents::TurnRole::User) && !turn.id.contains(":steer:")
    });
    let round_slice = match last_user_idx {
        Some(idx) => &turns[idx + 1..],
        None => &turns[..],
    };
    let reply = round_slice
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
    record_activity(
        pool,
        conversation_id,
        Some(turn_id),
        &reply,
        summarizer().as_ref(),
    )
    .await
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

#[derive(Debug, Clone)]
pub struct ParsedMemoryEntry {
    pub line_index: usize,
    pub entry_number: usize,
    pub fact: MemberFact,
}

#[derive(Debug, Clone)]
pub struct ParsedMemoryFile {
    pub space_id: String,
    pub lines: Vec<String>,
    pub entries: Vec<ParsedMemoryEntry>,
}

static NEXT_FACT_ID: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(1);
static MEMBER_KNOWN_SPACES: OnceLock<std::sync::Mutex<HashMap<String, HashSet<String>>>> =
    OnceLock::new();

fn remember_member_space(member_id: &str, space_id: &str) {
    if member_id.trim().is_empty() || space_id.trim().is_empty() {
        return;
    }
    let map = MEMBER_KNOWN_SPACES.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut guard) = map.lock() {
        guard
            .entry(member_id.to_string())
            .or_default()
            .insert(space_id.to_string());
    }
}

fn known_spaces_for_member(member_id: &str) -> Vec<String> {
    let mut out = vec![format!("direct:{member_id}")];
    if let Some(map) = MEMBER_KNOWN_SPACES.get()
        && let Ok(guard) = map.lock()
        && let Some(spaces) = guard.get(member_id)
    {
        for s in spaces {
            if !out.contains(s) {
                out.push(s.clone());
            }
        }
    }
    out
}

async fn candidate_spaces_for_member(pool: &SqlitePool, member_id: &str) -> Vec<String> {
    let mut spaces = known_spaces_for_member(member_id);
    if let Ok(rows) = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT thread_id FROM collaboration_thread_members WHERE member_id = ?",
    )
    .bind(member_id)
    .fetch_all(pool)
    .await
    {
        for tid in rows {
            if !tid.trim().is_empty() && !spaces.contains(&tid) {
                remember_member_space(member_id, &tid);
                spaces.push(tid);
            }
        }
    }
    spaces
}

fn allocate_fact_id() -> i64 {
    NEXT_FACT_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn observe_existing_fact_id(id: i64) {
    if (1..1_000_000).contains(&id) {
        let _ = NEXT_FACT_ID.fetch_max(id + 1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn deterministic_fact_id(space_id: &str, text: &str) -> i64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in space_id
        .as_bytes()
        .iter()
        .chain(b"::")
        .chain(text.as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    1_000_000 + ((hash & 0x000f_ffff_ffff_ffff) as i64)
}

/// Normalize entry text for deduplication (ported from DS-Bot's `squash`).
pub fn squash_memory_text(text: &str) -> String {
    text.trim()
        .trim_end_matches(['。', '.', '；', ';', '！', '!'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn sanitize_single_line_entry(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_memory_entry_line(fact: &MemberFact) -> String {
    let clean_text = sanitize_single_line_entry(&fact.content);
    let mut meta = vec![
        format!("id: {}", fact.id),
        format!("member: {}", fact.member_id),
        format!("scope: {}", fact.scope),
        format!("source: {}", fact.origin),
    ];
    if let Some(ref src_thread) = fact.source_thread_id
        && !src_thread.trim().is_empty()
    {
        meta.push(format!("thread: {}", src_thread.trim()));
    }
    meta.push(format!("updated: {}", fact.updated_at));
    format!("- {clean_text} [{}]", meta.join("; "))
}

fn parse_entry_bullet_line(
    space_id: &str,
    default_member_id: Option<&str>,
    fallback_updated_at: &str,
    line: &str,
) -> Option<MemberFact> {
    let trimmed = line.trim();
    let bullet_body = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))?
        .trim();
    if bullet_body.is_empty()
        || bullet_body.starts_with("[[topic:")
        || bullet_body.starts_with("[[collection:")
    {
        return None;
    }

    let mut content_part = bullet_body;
    let mut parsed_id: Option<i64> = None;
    let mut parsed_member: Option<String> = None;
    let mut parsed_scope: Option<String> = None;
    let mut parsed_origin: Option<String> = None;
    let mut parsed_thread: Option<String> = None;
    let mut parsed_updated: Option<String> = None;

    if bullet_body.ends_with(']')
        && let Some(open_idx) = bullet_body.rfind('[')
    {
        let meta_raw = &bullet_body[open_idx + 1..bullet_body.len() - 1];
        if (meta_raw.contains(':') || meta_raw.contains(';'))
            && !meta_raw.contains('[')
            && !meta_raw.contains(']')
        {
            content_part = bullet_body[..open_idx].trim();
            for pair in meta_raw.split(';') {
                if let Some((k, v)) = pair.split_once(':') {
                    let key = k.trim().to_ascii_lowercase();
                    let val = v.trim();
                    if val.is_empty() {
                        continue;
                    }
                    match key.as_str() {
                        "id" => parsed_id = val.parse::<i64>().ok().filter(|n| *n > 0),
                        "member" => parsed_member = Some(val.to_string()),
                        "scope" => parsed_scope = Some(val.to_string()),
                        "source" | "origin" => parsed_origin = Some(val.to_string()),
                        "thread" => parsed_thread = Some(val.to_string()),
                        "updated" => parsed_updated = Some(val.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }

    let content = content_part.trim().to_string();
    if content.is_empty() {
        return None;
    }

    let is_direct = space_id.starts_with("direct:");
    let scope = match parsed_scope.as_deref() {
        Some("global") => "global".to_string(),
        Some("private") => "private".to_string(),
        Some("group" | "thread") => {
            if is_direct {
                "private".to_string()
            } else {
                format!("thread:{space_id}")
            }
        }
        Some(other) if other.starts_with("thread:") => other.to_string(),
        _ => {
            if is_direct {
                "private".to_string()
            } else {
                format!("thread:{space_id}")
            }
        }
    };

    let member_id = parsed_member
        .or_else(|| resolve_member_id_from_space(space_id, default_member_id))
        .unwrap_or_else(|| space_id.to_string());

    let id = parsed_id.unwrap_or_else(|| deterministic_fact_id(space_id, &content));
    observe_existing_fact_id(id);
    remember_member_space(&member_id, space_id);

    let source_thread_id = parsed_thread.or_else(|| {
        scope
            .strip_prefix("thread:")
            .map(str::to_string)
            .or_else(|| (!is_direct).then(|| space_id.to_string()))
    });

    Some(MemberFact {
        id,
        member_id,
        content,
        scope,
        source_thread_id,
        origin: parsed_origin.unwrap_or_else(|| "file".to_string()),
        updated_at: parsed_updated.unwrap_or_else(|| fallback_updated_at.to_string()),
        score: None,
    })
}

/// Parse a Space's `MEMORY.md` content into body lines and structured `MemberFact` entries
/// (ported from DS-Bot's `parseMemory`).
pub fn parse_memory_markdown(
    space_id: &str,
    default_member_id: Option<&str>,
    raw: &str,
    fallback_updated_at: &str,
) -> ParsedMemoryFile {
    let mut lines: Vec<String> = if raw.trim().is_empty() {
        vec!["# Memory".to_string(), String::new()]
    } else {
        raw.lines().map(str::to_string).collect()
    };
    if !lines.iter().any(|l| l.trim().starts_with("# ")) {
        lines.insert(0, String::new());
        lines.insert(0, "# Memory".to_string());
    }

    let mut entries = Vec::new();
    let mut in_index = false;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("## Index") || trimmed.starts_with("## Index ") {
            in_index = true;
            continue;
        }
        if in_index && trimmed.starts_with("## ") {
            in_index = false;
        }
        if in_index || trimmed == "_暂无核心记忆条目_" {
            continue;
        }
        if let Some(fact) =
            parse_entry_bullet_line(space_id, default_member_id, fallback_updated_at, trimmed)
        {
            let entry_number = entries.len() + 1;
            entries.push(ParsedMemoryEntry {
                line_index: idx,
                entry_number,
                fact,
            });
        }
    }

    ParsedMemoryFile {
        space_id: space_id.to_string(),
        lines,
        entries,
    }
}

pub fn read_space_memory_parsed(
    space_id: &str,
    default_member_id: Option<&str>,
) -> ParsedMemoryFile {
    let path = space_memory_file_path(space_id);
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let fallback_updated = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(now);
    parse_memory_markdown(space_id, default_member_id, &raw, &fallback_updated)
}

fn render_memory_markdown_with_index(
    body_lines: &[String],
    topics: &[MemoryTopicRecord],
    indexed_collection_notes: &[String],
) -> String {
    let mut kept_lines = Vec::new();
    let mut in_index = false;
    for line in body_lines {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("## Index") || trimmed.starts_with("## Index ") {
            in_index = true;
            continue;
        }
        if in_index && trimmed.starts_with("## ") {
            in_index = false;
        }
        if in_index || trimmed == "_暂无核心记忆条目_" {
            continue;
        }
        kept_lines.push(line.clone());
    }
    while kept_lines.last().is_some_and(|l| l.trim().is_empty()) {
        kept_lines.pop();
    }
    if kept_lines.is_empty() {
        kept_lines.push("# Memory".to_string());
    }

    let mut md = kept_lines.join("\n");
    md.push('\n');

    if !topics.is_empty() || !indexed_collection_notes.is_empty() {
        md.push_str("\n## Index\n\n");
        for t in topics {
            md.push_str(&format!("- [[topic:{}]] — {}\n", t.topic, t.summary));
        }
        for item_line in indexed_collection_notes {
            md.push_str(&format!("- {item_line}\n"));
        }
    }
    md
}

fn write_memory_file_atomic(space_id: &str, content: &str) -> Result<(), CollaborationError> {
    let root = space_memory_root_dir(space_id);
    std::fs::create_dir_all(&root).map_err(|e| bad(e.to_string()))?;
    let target = space_memory_file_path(space_id);
    let tmp = root.join(format!("MEMORY.md.tmp.{}", Uuid::new_v4()));
    if std::fs::write(&tmp, content).is_ok() {
        if std::fs::rename(&tmp, &target).is_ok() {
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
    }
    std::fs::write(&target, content).map_err(|e| bad(e.to_string()))
}

fn insert_line_before_index(lines: &mut Vec<String>, formatted_line: String) {
    let index_pos = lines.iter().position(|line| {
        let t = line.trim();
        t.eq_ignore_ascii_case("## Index") || t.starts_with("## Index ")
    });
    match index_pos {
        Some(pos) => {
            let mut insert_at = pos;
            while insert_at > 0 && lines[insert_at - 1].trim().is_empty() {
                insert_at -= 1;
            }
            lines.insert(insert_at, formatted_line);
        }
        None => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            if lines.len() == 1 && lines[0].trim().starts_with("# ") {
                lines.push(String::new());
            }
            lines.push(formatted_line);
        }
    }
}

fn check_content(content: &str) -> Result<String, CollaborationError> {
    let content = sanitize_single_line_entry(content);
    if content.is_empty() {
        return Err(bad("content is required"));
    }
    if content.chars().count() > MEMORY_ENTRY_MAX_CHARS {
        return Err(bad(format!(
            "content exceeds {MEMORY_ENTRY_MAX_CHARS} characters"
        )));
    }
    if let Some(reason) = contains_secret_or_credential(&content) {
        return Err(CollaborationError::new(
            "secret_rejected",
            format!(
                "记忆写入被安全策略拦截（{reason}）：请勿将密码、API 密钥、Token 或敏感证件号存入长期记忆"
            ),
        ));
    }
    Ok(content)
}

fn target_space_for_fact(member_id: &str, scope: &FactScope) -> String {
    match scope {
        FactScope::Thread(thread_id) if !thread_id.trim().is_empty() => thread_id.clone(),
        _ => format!("direct:{member_id}"),
    }
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
    let target_space = target_space_for_fact(member_id, scope);
    remember_member_space(member_id, &target_space);
    let mut parsed = read_space_memory_parsed(&target_space, Some(member_id));
    let scope_db = scope.as_db();
    let squashed_new = squash_memory_text(&content);

    // Deduplicate in-place if the same normalized text already exists in this space & scope
    if let Some(existing) = parsed.entries.iter().find(|e| {
        e.fact.member_id == member_id
            && e.fact.scope == scope_db
            && squash_memory_text(&e.fact.content) == squashed_new
    }) {
        return Ok(existing.fact.clone());
    }

    let current_chars: usize = parsed
        .entries
        .iter()
        .map(|e| e.fact.content.chars().count())
        .sum();
    if current_chars + content.chars().count() > MEMORY_MAIN_MAX_CHARS {
        return Err(bad(format!(
            "MEMORY.md exceeds {MEMORY_MAIN_MAX_CHARS} character budget; please edit or remove outdated entries first"
        )));
    }

    let stamp = now();
    let fact = MemberFact {
        id: allocate_fact_id(),
        member_id: member_id.to_string(),
        content,
        scope: scope_db.clone(),
        source_thread_id: source_thread_id.map(str::to_string),
        origin: origin.to_string(),
        updated_at: stamp,
        score: None,
    };

    let formatted = format_memory_entry_line(&fact);
    insert_line_before_index(&mut parsed.lines, formatted);
    let topics = list_space_topics(&target_space).unwrap_or_default();
    let indexed_collection = list_indexed_space_collection_pointers(pool, &target_space).await;
    let rendered = render_memory_markdown_with_index(&parsed.lines, &topics, &indexed_collection);
    write_memory_file_atomic(&target_space, &rendered)?;

    append_memory_journal(
        &target_space,
        origin,
        "add",
        &scope_db,
        &format!("fact:{}", fact.id),
        None,
        Some(&fact.content),
    );
    let _ = sync_space_memory_files(pool, &target_space, Some(member_id)).await;
    Ok(fact)
}

/// Facts of `member_id` read directly from the Space `MEMORY.md` files on disk.
pub async fn list_facts(
    pool: &SqlitePool,
    member_id: &str,
    scope: Option<&FactScope>,
) -> Result<Vec<MemberFact>, CollaborationError> {
    let candidate_spaces = match scope {
        Some(FactScope::Thread(tid)) => vec![tid.clone()],
        Some(FactScope::Global | FactScope::Private) => vec![format!("direct:{member_id}")],
        None => candidate_spaces_for_member(pool, member_id).await,
    };
    let scope_filter = scope.map(FactScope::as_db);
    let mut facts = Vec::new();
    let mut seen_ids = HashSet::new();
    for space_id in candidate_spaces {
        let parsed = read_space_memory_parsed(&space_id, Some(member_id));
        for entry in parsed.entries {
            if entry.fact.member_id != member_id {
                continue;
            }
            if let Some(ref target_scope) = scope_filter
                && &entry.fact.scope != target_scope
            {
                continue;
            }
            if seen_ids.insert(entry.fact.id) {
                facts.push(entry.fact);
            }
        }
    }
    facts.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(facts)
}

/// Shared facts scoped to a specific group/thread (`<space_id>/MEMORY.md`).
pub async fn list_thread_facts(
    _pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<MemberFact>, CollaborationError> {
    let parsed = read_space_memory_parsed(space_id, None);
    let mut facts: Vec<MemberFact> = parsed.entries.into_iter().map(|e| e.fact).collect();
    facts.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(facts)
}

pub async fn update_fact(
    pool: &SqlitePool,
    member_id: &str,
    fact_id: i64,
    content: Option<&str>,
    scope: Option<&FactScope>,
) -> Result<MemberFact, CollaborationError> {
    let checked_content = content.map(check_content).transpose()?;
    let candidate_spaces = candidate_spaces_for_member(pool, member_id).await;

    for source_space in candidate_spaces {
        let mut parsed = read_space_memory_parsed(&source_space, Some(member_id));
        let Some(pos) = parsed
            .entries
            .iter()
            .position(|e| e.fact.id == fact_id && e.fact.member_id == member_id)
        else {
            continue;
        };
        let existing = parsed.entries[pos].clone();
        let before_text = existing.fact.content.clone();
        let new_scope_str = scope
            .map(FactScope::as_db)
            .unwrap_or_else(|| existing.fact.scope.clone());
        let parsed_new_scope = FactScope::parse(&new_scope_str)?;
        let dest_space = target_space_for_fact(member_id, &parsed_new_scope);
        remember_member_space(member_id, &dest_space);

        let updated_fact = MemberFact {
            id: existing.fact.id,
            member_id: existing.fact.member_id.clone(),
            content: checked_content.unwrap_or_else(|| existing.fact.content.clone()),
            scope: new_scope_str.clone(),
            source_thread_id: match &parsed_new_scope {
                FactScope::Thread(tid) => Some(tid.clone()),
                _ => existing.fact.source_thread_id.clone(),
            },
            origin: existing.fact.origin.clone(),
            updated_at: now(),
            score: None,
        };

        let formatted = format_memory_entry_line(&updated_fact);
        if dest_space == source_space {
            let other_chars: usize = parsed
                .entries
                .iter()
                .enumerate()
                .filter(|(idx, _)| *idx != pos)
                .map(|(_, e)| e.fact.content.chars().count())
                .sum();
            if other_chars + updated_fact.content.chars().count() > MEMORY_MAIN_MAX_CHARS {
                return Err(bad(format!(
                    "MEMORY.md exceeds {MEMORY_MAIN_MAX_CHARS} character budget; please edit or remove outdated entries first"
                )));
            }
            parsed.lines[existing.line_index] = formatted;
            let topics = list_space_topics(&source_space).unwrap_or_default();
            let indexed_collection =
                list_indexed_space_collection_pointers(pool, &source_space).await;
            let rendered =
                render_memory_markdown_with_index(&parsed.lines, &topics, &indexed_collection);
            write_memory_file_atomic(&source_space, &rendered)?;
        } else {
            let mut dest_parsed = read_space_memory_parsed(&dest_space, Some(member_id));
            let dest_chars: usize = dest_parsed
                .entries
                .iter()
                .map(|e| e.fact.content.chars().count())
                .sum();
            if dest_chars + updated_fact.content.chars().count() > MEMORY_MAIN_MAX_CHARS {
                return Err(bad(format!(
                    "MEMORY.md exceeds {MEMORY_MAIN_MAX_CHARS} character budget; please edit or remove outdated entries first"
                )));
            }
            // Remove from source_space and insert into dest_space
            parsed.lines.remove(existing.line_index);
            let src_topics = list_space_topics(&source_space).unwrap_or_default();
            let src_col = list_indexed_space_collection_pointers(pool, &source_space).await;
            let src_rendered =
                render_memory_markdown_with_index(&parsed.lines, &src_topics, &src_col);
            write_memory_file_atomic(&source_space, &src_rendered)?;
            let _ = sync_space_memory_files(pool, &source_space, Some(member_id)).await;

            insert_line_before_index(&mut dest_parsed.lines, formatted);
            let dst_topics = list_space_topics(&dest_space).unwrap_or_default();
            let dst_col = list_indexed_space_collection_pointers(pool, &dest_space).await;
            let dst_rendered =
                render_memory_markdown_with_index(&dest_parsed.lines, &dst_topics, &dst_col);
            write_memory_file_atomic(&dest_space, &dst_rendered)?;
        }

        append_memory_journal(
            &dest_space,
            "user",
            "edit",
            &updated_fact.scope,
            &format!("fact:{fact_id}"),
            Some(&before_text),
            Some(&updated_fact.content),
        );
        let _ = sync_space_memory_files(pool, &dest_space, Some(member_id)).await;
        return Ok(updated_fact);
    }

    Err(CollaborationError::new(
        "not_found",
        "memory fact was not found",
    ))
}

pub async fn delete_fact(
    pool: &SqlitePool,
    member_id: &str,
    fact_id: i64,
) -> Result<bool, CollaborationError> {
    let candidate_spaces = candidate_spaces_for_member(pool, member_id).await;
    for source_space in candidate_spaces {
        let mut parsed = read_space_memory_parsed(&source_space, Some(member_id));
        let Some(pos) = parsed
            .entries
            .iter()
            .position(|e| e.fact.id == fact_id && e.fact.member_id == member_id)
        else {
            continue;
        };
        let existing = parsed.entries[pos].clone();
        parsed.lines.remove(existing.line_index);
        let topics = list_space_topics(&source_space).unwrap_or_default();
        let indexed_collection = list_indexed_space_collection_pointers(pool, &source_space).await;
        let rendered =
            render_memory_markdown_with_index(&parsed.lines, &topics, &indexed_collection);
        write_memory_file_atomic(&source_space, &rendered)?;

        append_memory_journal(
            &source_space,
            "user",
            "remove",
            &existing.fact.scope,
            &format!("fact:{fact_id}"),
            Some(&existing.fact.content),
            None,
        );
        let _ = sync_space_memory_files(pool, &source_space, Some(member_id)).await;
        return Ok(true);
    }
    Ok(false)
}

/// Facts visible to `caller`, ranked by BM25 against `query` (most recent
/// first when the query has no usable terms). Includes shared group facts
/// (`thread:<caller.thread_id>`) when in a group thread.
pub async fn search_facts(
    pool: &SqlitePool,
    caller: &MemoryCaller,
    query: &str,
    limit: usize,
) -> Result<Vec<MemberFact>, CollaborationError> {
    let mut visible: Vec<MemberFact> = list_facts(pool, &caller.member_id, None)
        .await?
        .into_iter()
        .filter(|fact| FactScope::parse(&fact.scope).is_ok_and(|s| s.visible_to(caller)))
        .collect();
    if !caller.private {
        let seen_ids: HashSet<i64> = visible.iter().map(|f| f.id).collect();
        if let Ok(group_facts) = list_thread_facts(pool, &caller.thread_id).await {
            for gf in group_facts {
                if !seen_ids.contains(&gf.id) {
                    visible.push(gf);
                }
            }
        }
    }
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
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, fact)| fact)
        .collect())
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
    let topics = list_space_topics(&caller.thread_id).unwrap_or_default();
    let indexed_collection = list_indexed_space_collection_pointers(pool, &caller.thread_id).await;
    if activity.is_empty() && facts.is_empty() && topics.is_empty() && indexed_collection.is_empty()
    {
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
            lines.push(format!(
                "  - [{}] {place}：{}",
                entry.created_at, entry.summary
            ));
        }
    }
    if !facts.is_empty() {
        lines.push("- 相关长期记忆：".to_string());
        for fact in &facts {
            lines.push(format!(
                "  - (#{} {}) {}",
                fact.id, fact.scope, fact.content
            ));
        }
    }
    if !topics.is_empty() || !indexed_collection.is_empty() {
        lines.push("- 主题与收藏知识索引（可调用 `memory_search` 传入 `topic` 或 `read_space_collection_item` 按需读取）：".to_string());
        for t in topics.iter().take(12) {
            lines.push(format!("  - [[topic:{}]] — {}", t.topic, t.summary));
        }
        for col in indexed_collection.iter().take(12) {
            lines.push(format!("  - {col}"));
        }
    }
    lines.push(
        "- 记忆工具：`memory_search` 查找更多记忆或按 `topic` 调取主题文档，`memory_write` 记录/更新/移除长期事实或主题（见 `vibex-bot` Skill 的 `MEMORY.md`）。".to_string(),
    );
    Ok(Some(lines.join("\n")))
}


mod distill;
mod review;
mod space_ops;
#[cfg(test)]
mod tests;

pub use self::{distill::*, review::*, space_ops::*};
