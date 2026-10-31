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
    let turns = crate::jsonl_history::load_all_turns(pool, conversation_id)
        .await
        .map_err(db)?
        .unwrap_or_default();
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

/// Persisted review cursor per Space (`~/.vibex/spaces/<space_id>/reviewed.json`).
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

static SPACE_REVIEW_LOCKS: OnceLock<
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

static REVIEW_MODEL: OnceLock<std::sync::RwLock<Option<Arc<dyn MemoryReviewModel>>>> =
    OnceLock::new();
static RUNTIME_REVIEW_MODEL: OnceLock<std::sync::RwLock<Option<Arc<dyn MemoryReviewModel>>>> =
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

fn active_memory_review_model() -> Option<Arc<dyn MemoryReviewModel>> {
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

fn register_runtime_review_model(model: Arc<dyn MemoryReviewModel>) {
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

const MAX_RESIDENT_REVIEW_TURNS: usize = 64;

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

static GLOBAL_RESIDENT_REVIEW_POOL: OnceLock<ResidentReviewSessionPool> = OnceLock::new();

fn global_resident_review_pool() -> &'static ResidentReviewSessionPool {
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
                db::models::conversation::ConversationAgentBindingRecord::latest_for_conversation(
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

        let working_dir = utils::path::vibex_scratch_subdir("memory-review")
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

static DISTILLER: OnceLock<Arc<dyn FactDistiller>> = OnceLock::new();

/// Install a process-wide fact distiller (first call wins).
pub fn set_fact_distiller(distiller: Arc<dyn FactDistiller>) -> bool {
    DISTILLER.set(distiller).is_ok()
}

fn fact_distiller() -> Arc<dyn FactDistiller> {
    DISTILLER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(DefaultFactDistiller))
}

/// Extract clean user message body from a space delivery prompt (stripping
/// opening blocks and `[Message from ...]` / `[Group chat ...]` header lines).
fn extract_last_user_delivery_body(raw_prompt: &str) -> &str {
    let trimmed = raw_prompt.trim();
    if trimmed.contains("<vibex-private-bootstrap>") {
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

fn format_turns_for_review(turns: &[agents::MessageTurn]) -> Vec<(String, String)> {
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
                let clean = raw_text.trim();
                if !clean.is_empty() && clean != "[PASS]" {
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
               ORDER BY joined_at ASC"#,
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
        let turns = crate::jsonl_history::load_all_turns(pool, *conv_id)
            .await
            .map_err(db)?
            .unwrap_or_default();
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

#[derive(Default)]
struct SpaceReviewChainState {
    running: bool,
    rerun_conversation_id: Option<Uuid>,
}

static SPACE_REVIEW_QUEUES: OnceLock<std::sync::Mutex<HashMap<String, SpaceReviewChainState>>> =
    OnceLock::new();

fn space_review_queues() -> &'static std::sync::Mutex<HashMap<String, SpaceReviewChainState>> {
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
/// `~/.vibex/spaces/direct_<member_id>/reviewed.json` and writing facts to `MEMORY.md`.
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

async fn require_caller(
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

async fn resolve_editable_fact_owner(
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
// Unified Space Memory & Collection Index File Engine (DS-Bot + VibeX Collection)
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

fn sanitize_topic_slug(raw: &str) -> Result<String, CollaborationError> {
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

fn parse_topic_title_and_summary(slug: &str, content: &str) -> (String, String) {
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

fn resolve_member_id_from_space(
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

async fn resolve_writer_member_for_space(
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

fn build_memory_summary_card(
    is_direct: bool,
    facts: &[MemberFact],
    activity: &[ActivityEntry],
    topics: &[MemoryTopicRecord],
    indexed_collection_notes: &[String],
) -> MemorySummaryCard {
    let mut sections = Vec::new();
    let char_count: usize = facts.iter().map(|f| f.content.chars().count()).sum();

    if is_direct {
        let global_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope == "global")
            .take(5)
            .map(|f| f.content.clone())
            .collect();
        if !global_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "global".to_string(),
                title: "全局协作规范".to_string(),
                items: global_items,
            });
        }
        let private_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope == "private")
            .take(5)
            .map(|f| f.content.clone())
            .collect();
        if !private_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "private".to_string(),
                title: "私聊偏好与约定".to_string(),
                items: private_items,
            });
        }
        let thread_items: Vec<String> = facts
            .iter()
            .filter(|f| f.scope.starts_with("thread:"))
            .take(4)
            .map(|f| f.content.clone())
            .collect();
        if !thread_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "threads".to_string(),
                title: "群组专项经验".to_string(),
                items: thread_items,
            });
        }
    } else {
        let group_items: Vec<String> = facts.iter().take(6).map(|f| f.content.clone()).collect();
        if !group_items.is_empty() {
            sections.push(MemorySummarySection {
                id: "group".to_string(),
                title: "本群共享共识与规范".to_string(),
                items: group_items,
            });
        }
    }

    if !activity.is_empty() {
        sections.push(MemorySummarySection {
            id: "activity".to_string(),
            title: "近期关键动态".to_string(),
            items: activity.iter().take(3).map(|a| a.summary.clone()).collect(),
        });
    }

    let mut index_items: Vec<String> = topics
        .iter()
        .take(5)
        .map(|t| format!("[[topic:{}]] — {}", t.topic, t.summary))
        .collect();
    index_items.extend(indexed_collection_notes.iter().take(5).cloned());
    if !index_items.is_empty() {
        sections.push(MemorySummarySection {
            id: "index".to_string(),
            title: "主题与收藏知识索引".to_string(),
            items: index_items,
        });
    }

    MemorySummaryCard {
        sections,
        char_count,
        budget_chars: MEMORY_MAIN_MAX_CHARS,
        updated_at: now(),
    }
}

/// List `[[collection:...]]` index lines for items in `space_id` that have not
/// been excluded via `index_excluded.json`.
pub async fn list_indexed_space_collection_pointers(
    pool: &SqlitePool,
    space_id: &str,
) -> Vec<String> {
    let excluded = read_excluded_collection_ids(space_id);
    let collection_rows: Vec<(String, String, String)> = sqlx::query_as(
        r#"SELECT id, file_name, note
           FROM collaboration_space_collection_items
           WHERE space_id = ?
           ORDER BY created_at DESC LIMIT 40"#,
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    collection_rows
        .into_iter()
        .filter(|(id, _, _)| !excluded.iter().any(|ex| ex == id))
        .map(|(_, file_name, note)| {
            if note.trim().is_empty() {
                format!("[[collection:{file_name}]]")
            } else {
                format!("[[collection:{file_name}]] — {}", note.trim())
            }
        })
        .collect()
}

/// Refresh `~/.vibex/spaces/<safe_space>/MEMORY.md` (`## Index` section) and `summary.json`
/// while preserving `MEMORY.md`'s existing entries as the single source of truth.
pub async fn sync_space_memory_files(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Result<MemorySummaryCard, CollaborationError> {
    let member_id = resolve_member_id_from_space(space_id, explicit_member_id);
    let is_direct = space_id.starts_with("direct:") || member_id.is_some();
    let parsed = read_space_memory_parsed(space_id, member_id.as_deref());
    let facts = if let Some(ref mid) = member_id {
        list_facts(pool, mid, None).await.unwrap_or_default()
    } else {
        parsed.entries.iter().map(|e| e.fact.clone()).collect()
    };
    let activity = if let Some(ref mid) = member_id {
        list_activity(pool, mid, true, 10).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let topics = list_space_topics(space_id).unwrap_or_default();
    let indexed_collection_notes = list_indexed_space_collection_pointers(pool, space_id).await;

    let summary = build_memory_summary_card(
        is_direct,
        &facts,
        &activity,
        &topics,
        &indexed_collection_notes,
    );

    let root = space_memory_root_dir(space_id);
    if std::fs::create_dir_all(&root).is_ok() {
        let rendered =
            render_memory_markdown_with_index(&parsed.lines, &topics, &indexed_collection_notes);
        let _ = write_memory_file_atomic(space_id, &rendered);
        if let Ok(summary_bytes) = serde_json::to_vec_pretty(&summary) {
            let _ = std::fs::write(space_summary_path(space_id), summary_bytes);
        }
    }

    Ok(summary)
}

/// Complete view of a space's memory (Assistant `direct:<member_id>` or Group `<space_id>`).
pub async fn view_space_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
) -> Result<SpaceMemoryView, CollaborationError> {
    let member_id = resolve_member_id_from_space(space_id, explicit_member_id);
    let summary = sync_space_memory_files(pool, space_id, member_id.as_deref()).await?;
    let facts = if let Some(ref mid) = member_id {
        list_facts(pool, mid, None).await?
    } else {
        list_thread_facts(pool, space_id).await?
    };
    let activity = if let Some(ref mid) = member_id {
        list_activity(pool, mid, true, 30).await?
    } else {
        sqlx::query_as::<_, ActivityEntry>(
            r#"SELECT id, member_id, thread_id, summary, private != 0 AS private, created_at
               FROM member_activity
               WHERE thread_id = ? AND private = 0
               ORDER BY id DESC LIMIT 30"#,
        )
        .bind(space_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
    };
    let topics = list_space_topics(space_id).unwrap_or_default();
    let journal = list_memory_journal(space_id, 50);
    let excluded_collection_ids = read_excluded_collection_ids(space_id);

    Ok(SpaceMemoryView {
        space_id: space_id.to_string(),
        member_id,
        memory_file_path: space_memory_file_path(space_id)
            .to_string_lossy()
            .replace('\\', "/"),
        summary,
        facts,
        activity,
        topics,
        journal,
        excluded_collection_ids,
    })
}

/// Add a fact from the UI panel for either an assistant (`direct:<member_id>`) or a group (`<space_id>`).
pub async fn add_space_fact(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    content: &str,
    raw_scope: Option<&str>,
) -> Result<MemberFact, CollaborationError> {
    let member_id = resolve_writer_member_for_space(pool, space_id, explicit_member_id).await?;
    let is_direct = resolve_member_id_from_space(space_id, explicit_member_id).is_some();
    let scope = match raw_scope.map(str::trim).filter(|s| !s.is_empty()) {
        Some("global") => FactScope::Global,
        Some("private") => FactScope::Private,
        Some("thread" | "group") => FactScope::Thread(space_id.to_string()),
        Some(other) => FactScope::parse(other)?,
        None => {
            if is_direct {
                FactScope::Private
            } else {
                FactScope::Thread(space_id.to_string())
            }
        }
    };
    let source_thread = if matches!(scope, FactScope::Thread(_)) {
        let has_thread: Option<String> =
            sqlx::query_scalar("SELECT id FROM collaboration_threads WHERE id = ? LIMIT 1")
                .bind(space_id)
                .fetch_optional(pool)
                .await
                .map_err(db)?;
        has_thread
    } else {
        None
    };
    create_fact(
        pool,
        &member_id,
        content,
        &scope,
        source_thread.as_deref(),
        "user",
    )
    .await
}

/// Distill a chat message bubble into the Space's `MEMORY.md`, using the active
/// [`MemoryReviewModel`] (`add` / `edit` / `remove`) when available.
pub async fn distill_message_to_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    message_text: &str,
    raw_scope: Option<&str>,
) -> Result<MemberFact, CollaborationError> {
    if let Some(model) = active_memory_review_model() {
        let member_id = resolve_writer_member_for_space(pool, space_id, explicit_member_id).await?;
        let is_private = resolve_member_id_from_space(space_id, explicit_member_id).is_some();
        let (entries, memory_chars) =
            collect_numbered_space_entries(space_id, &member_id, is_private);
        let prompt = MemoryReviewPrompt {
            space_id: space_id.to_string(),
            member_id: member_id.clone(),
            conversation_id: None,
            system_prompt: build_review_system_prompt(&member_id, space_id, is_private),
            user_prompt: build_review_user_prompt(
                space_id,
                &entries,
                memory_chars,
                &[],
                &[format!("Message: {}", message_text.trim())],
            ),
        };
        if let Ok(raw) = model.complete_review(&prompt).await
            && let Ok(changes) = parse_review_response(&raw)
            && !changes.is_empty()
        {
            let applied =
                apply_review_changes(pool, space_id, &member_id, is_private, &entries, &changes)
                    .await?;
            if let Some(first_fid) = applied.iter().find_map(|c| c.fact_id) {
                let facts = if is_private {
                    list_facts(pool, &member_id, None).await?
                } else {
                    list_thread_facts(pool, space_id).await?
                };
                if let Some(found) = facts.into_iter().find(|f| f.id == first_fid) {
                    return Ok(found);
                }
            }
        }
    }

    let condensed = first_sentences(message_text, 2, MEMORY_ENTRY_MAX_CHARS).unwrap_or_else(|| {
        message_text
            .trim()
            .chars()
            .take(MEMORY_ENTRY_MAX_CHARS)
            .collect()
    });
    add_space_fact(pool, space_id, explicit_member_id, &condensed, raw_scope).await
}

/// Interactive natural-language Q&A and instruction editing for the UI Memory Bar (DS-Bot `memory-ask`).
pub async fn ask_space_memory(
    pool: &SqlitePool,
    space_id: &str,
    explicit_member_id: Option<&str>,
    prompt: &str,
) -> Result<MemoryAskResponse, CollaborationError> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return Err(bad("prompt is required"));
    }

    let mut changes = Vec::new();
    let lower = trimmed.to_ascii_lowercase();

    // 1. Check for explicit ADD instruction ("记住：...", "添加：...", "新增：...", "remember ...", "+ ...")
    let add_payload = trimmed
        .strip_prefix("记住：")
        .or_else(|| trimmed.strip_prefix("记住:"))
        .or_else(|| trimmed.strip_prefix("添加记忆："))
        .or_else(|| trimmed.strip_prefix("添加记忆:"))
        .or_else(|| trimmed.strip_prefix("添加："))
        .or_else(|| trimmed.strip_prefix("添加:"))
        .or_else(|| trimmed.strip_prefix("新增："))
        .or_else(|| trimmed.strip_prefix("新增:"))
        .or_else(|| trimmed.strip_prefix("+ "))
        .or_else(|| {
            if lower.starts_with("remember:") || lower.starts_with("remember ") {
                Some(trimmed[9..].trim())
            } else {
                None
            }
        });

    if let Some(to_add) = add_payload.map(str::trim).filter(|s| !s.is_empty()) {
        let fact = add_space_fact(pool, space_id, explicit_member_id, to_add, None).await?;
        changes.push(MemoryAskChange {
            op: "add".to_string(),
            fact_id: Some(fact.id),
            text: fact.content.clone(),
        });
        let view = view_space_memory(pool, space_id, explicit_member_id).await?;
        return Ok(MemoryAskResponse {
            reply: format!("已记住：{}", fact.content),
            changes,
            matched_facts: vec![fact],
            view,
        });
    }

    // 2. Check for explicit REMOVE / FORGET instruction ("忘掉...", "忘记...", "删除...", "移除...", "forget ...", "- ...")
    let remove_payload = trimmed
        .strip_prefix("忘掉：")
        .or_else(|| trimmed.strip_prefix("忘掉:"))
        .or_else(|| trimmed.strip_prefix("忘掉"))
        .or_else(|| trimmed.strip_prefix("忘记："))
        .or_else(|| trimmed.strip_prefix("忘记:"))
        .or_else(|| trimmed.strip_prefix("忘记"))
        .or_else(|| trimmed.strip_prefix("删除记忆"))
        .or_else(|| trimmed.strip_prefix("删除"))
        .or_else(|| trimmed.strip_prefix("移除"))
        .or_else(|| trimmed.strip_prefix("- "))
        .or_else(|| {
            if lower.starts_with("forget ") {
                Some(trimmed[7..].trim())
            } else {
                None
            }
        });

    if let Some(raw_target) = remove_payload.map(str::trim).filter(|s| !s.is_empty()) {
        let current_view = view_space_memory(pool, space_id, explicit_member_id).await?;
        let target_id = raw_target
            .trim_start_matches('#')
            .split_whitespace()
            .next()
            .and_then(|tok| tok.parse::<i64>().ok());
        let matched = if let Some(fid) = target_id {
            current_view.facts.iter().find(|f| f.id == fid).cloned()
        } else {
            let clean_kw = raw_target
                .trim_start_matches("关于")
                .trim_end_matches("的记忆")
                .trim();
            current_view
                .facts
                .iter()
                .find(|f| f.content.contains(clean_kw))
                .cloned()
        };
        if let Some(target_fact) = matched {
            delete_fact(pool, &target_fact.member_id, target_fact.id).await?;
            changes.push(MemoryAskChange {
                op: "remove".to_string(),
                fact_id: Some(target_fact.id),
                text: target_fact.content.clone(),
            });
            let view = view_space_memory(pool, space_id, explicit_member_id).await?;
            return Ok(MemoryAskResponse {
                reply: format!("已移除记忆 #{}：{}", target_fact.id, target_fact.content),
                changes,
                matched_facts: Vec::new(),
                view,
            });
        }
        return Ok(MemoryAskResponse {
            reply: format!("未找到与「{raw_target}」匹配的记忆条目，未执行删除。"),
            changes,
            matched_facts: Vec::new(),
            view: current_view,
        });
    }

    // 3. Check for REPLACE / EDIT instruction ("把 #1 改成 ...", "把 xxx 改成 yyy")
    if let Some(rest) = trimmed.strip_prefix("把")
        && let Some((left, right)) = rest
            .split_once("改成：")
            .or_else(|| rest.split_once("改成:"))
            .or_else(|| rest.split_once("改成"))
            .or_else(|| rest.split_once("替换为"))
            .or_else(|| rest.split_once("修改为"))
    {
        let left = left.trim();
        let right = right.trim();
        if !left.is_empty() && !right.is_empty() {
            let current_view = view_space_memory(pool, space_id, explicit_member_id).await?;
            let target_id = left.trim_start_matches('#').parse::<i64>().ok();
            let matched = if let Some(fid) = target_id {
                current_view.facts.iter().find(|f| f.id == fid).cloned()
            } else {
                current_view
                    .facts
                    .iter()
                    .find(|f| f.content.contains(left))
                    .cloned()
            };
            if let Some(target_fact) = matched {
                let updated = update_fact(
                    pool,
                    &target_fact.member_id,
                    target_fact.id,
                    Some(right),
                    None,
                )
                .await?;
                changes.push(MemoryAskChange {
                    op: "edit".to_string(),
                    fact_id: Some(updated.id),
                    text: updated.content.clone(),
                });
                let view = view_space_memory(pool, space_id, explicit_member_id).await?;
                return Ok(MemoryAskResponse {
                    reply: format!("已将记忆 #{} 更新为：{}", updated.id, updated.content),
                    changes,
                    matched_facts: vec![updated],
                    view,
                });
            }
            return Ok(MemoryAskResponse {
                reply: format!("未找到与「{left}」匹配的记忆条目，无法修改。"),
                changes,
                matched_facts: Vec::new(),
                view: current_view,
            });
        }
    }

    // 4. Default: Natural-language search / Q&A across facts, topics, and activity
    let view = view_space_memory(pool, space_id, explicit_member_id).await?;
    let terms = tokenize(trimmed);
    let matched_facts: Vec<MemberFact> = if terms.is_empty() {
        view.facts.iter().take(5).cloned().collect()
    } else {
        let docs: Vec<Vec<String>> = view.facts.iter().map(|f| tokenize(&f.content)).collect();
        let scores = bm25(&docs, &terms);
        let mut ranked: Vec<(f64, MemberFact)> = view
            .facts
            .iter()
            .cloned()
            .zip(scores)
            .filter(|(_, s)| *s > 0.0)
            .map(|(f, s)| (s, f))
            .collect();
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
        ranked.into_iter().take(6).map(|(_, f)| f).collect()
    };

    let matched_topics: Vec<&MemoryTopicRecord> = view
        .topics
        .iter()
        .filter(|t| {
            terms.iter().any(|term| {
                t.topic.to_lowercase().contains(term)
                    || t.title.to_lowercase().contains(term)
                    || t.content.to_lowercase().contains(term)
            })
        })
        .collect();

    let reply = if matched_facts.is_empty() && matched_topics.is_empty() {
        if view.facts.is_empty() && view.topics.is_empty() {
            "当前空间还没有记录任何长期记忆。你可以输入「记住：…」直接添加规则。".to_string()
        } else {
            format!(
                "未找到与「{}」直接匹配的记忆（当前共有 {} 条核心记忆、{} 个主题文档）。你可以输入「记住：…」新增，或输入「把 #ID 改成 …」修改。",
                trimmed,
                view.facts.len(),
                view.topics.len()
            )
        }
    } else {
        let mut parts = Vec::new();
        if !matched_facts.is_empty() {
            let bullets = matched_facts
                .iter()
                .map(|f| format!("• (#{}) {}", f.id, f.content))
                .collect::<Vec<_>>()
                .join("\n");
            parts.push(format!(
                "找到 {} 条相关记忆：\n{}",
                matched_facts.len(),
                bullets
            ));
        }
        if !matched_topics.is_empty() {
            let t_bullets = matched_topics
                .iter()
                .map(|t| format!("• [[topic:{}]] — {}", t.topic, t.summary))
                .collect::<Vec<_>>()
                .join("\n");
            parts.push(format!("关联主题文档：\n{t_bullets}"));
        }
        parts.join("\n\n")
    };

    Ok(MemoryAskResponse {
        reply,
        changes,
        matched_facts,
        view,
    })
}

fn input_optional_text(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        input
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

fn input_required_text(
    input: &serde_json::Value,
    keys: &[&str],
) -> Result<String, CollaborationError> {
    input_optional_text(input, keys).ok_or_else(|| {
        let field = keys.first().copied().unwrap_or("field");
        bad(format!("{field} is required"))
    })
}

fn resolve_space_and_member_input(
    input: &serde_json::Value,
) -> Result<(String, Option<String>), CollaborationError> {
    let member_id = input_optional_text(input, &["memberId", "member_id"]);
    let space_id = input_optional_text(input, &["spaceId", "space_id"])
        .or_else(|| member_id.as_ref().map(|m| format!("direct:{m}")))
        .ok_or_else(|| bad("spaceId or memberId is required"))?;
    Ok((space_id, member_id))
}

async fn resolve_fact_owner_input(
    _pool: &SqlitePool,
    input: &serde_json::Value,
    fact_id: i64,
) -> Result<String, CollaborationError> {
    if let Some(mid) = input_optional_text(input, &["memberId", "member_id"]) {
        return Ok(mid);
    }
    if let Some(space_id) = input_optional_text(input, &["spaceId", "space_id"]) {
        if let Some(mid) = space_id.strip_prefix("direct:")
            && !mid.trim().is_empty()
        {
            return Ok(mid.trim().to_string());
        }
        let parsed = read_space_memory_parsed(&space_id, None);
        if let Some(entry) = parsed.entries.into_iter().find(|e| e.fact.id == fact_id) {
            return Ok(entry.fact.member_id);
        }
    }
    if let Some(map) = MEMBER_KNOWN_SPACES.get()
        && let Ok(guard) = map.lock()
    {
        for (member_id, spaces) in guard.iter() {
            for space_id in spaces {
                let parsed = read_space_memory_parsed(space_id, Some(member_id));
                if let Some(entry) = parsed.entries.into_iter().find(|e| e.fact.id == fact_id) {
                    return Ok(entry.fact.member_id);
                }
            }
        }
    }
    Err(CollaborationError::new(
        "not_found",
        "memory fact was not found",
    ))
}

fn input_fact_id(input: &serde_json::Value) -> Result<i64, CollaborationError> {
    ["factId", "fact_id", "id"]
        .iter()
        .find_map(|key| input.get(*key).and_then(serde_json::Value::as_i64))
        .ok_or_else(|| bad("factId is required"))
}

/// Execute a `space.memory.*` or `member.memory.*` host operation and return `(payload, changed_space_and_member)`.
pub async fn execute_space_memory_op(
    pool: &SqlitePool,
    op: &str,
    input: &serde_json::Value,
) -> Result<(serde_json::Value, Option<(String, Option<String>)>), CollaborationError> {
    match op {
        "list" => {
            let member_id = input_required_text(input, &["memberId", "member_id"])?;
            let scope = input_optional_text(input, &["scope"])
                .map(|raw| FactScope::parse(&raw))
                .transpose()?;
            let facts = list_facts(pool, &member_id, scope.as_ref()).await?;
            Ok((
                serde_json::json!({ "memberId": member_id, "facts": facts }),
                None,
            ))
        }
        "update" => {
            let fact_id = input_fact_id(input)?;
            let member_id = resolve_fact_owner_input(pool, input, fact_id).await?;
            let content = input_optional_text(input, &["content"]);
            let scope = input_optional_text(input, &["scope"])
                .map(|raw| FactScope::parse(&raw))
                .transpose()?;
            let fact = update_fact(
                pool,
                &member_id,
                fact_id,
                content.as_deref(),
                scope.as_ref(),
            )
            .await?;
            let changed = input_optional_text(input, &["spaceId", "space_id"])
                .map(|space_id| (space_id, Some(member_id.clone())));
            Ok((
                serde_json::json!({ "memberId": member_id, "fact": fact }),
                changed,
            ))
        }
        "delete" => {
            let fact_id = input_fact_id(input)?;
            let member_id = resolve_fact_owner_input(pool, input, fact_id).await?;
            let deleted = delete_fact(pool, &member_id, fact_id).await?;
            let changed = input_optional_text(input, &["spaceId", "space_id"])
                .map(|space_id| (space_id, Some(member_id.clone())));
            Ok((
                serde_json::json!({ "memberId": member_id, "factId": fact_id, "deleted": deleted }),
                changed,
            ))
        }
        "activity_list" => {
            let member_id = input_required_text(input, &["memberId", "member_id"])?;
            let limit = input
                .get("limit")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 500) as usize;
            let activity = list_activity(pool, &member_id, true, limit).await?;
            Ok((
                serde_json::json!({ "memberId": member_id, "activity": activity }),
                None,
            ))
        }
        "view" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let view = view_space_memory(pool, &space_id, member_id.as_deref()).await?;
            let val = serde_json::to_value(view).map_err(|e| {
                CollaborationError::new("conversation_control_failed", e.to_string())
            })?;
            Ok((val, None))
        }
        "add" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let content = input_required_text(input, &["content", "text"])?;
            let scope = input_optional_text(input, &["scope"]);
            let fact = add_space_fact(
                pool,
                &space_id,
                member_id.as_deref(),
                &content,
                scope.as_deref(),
            )
            .await?;
            let view = view_space_memory(pool, &space_id, member_id.as_deref()).await?;
            Ok((
                serde_json::json!({ "fact": fact, "view": view }),
                Some((space_id, member_id)),
            ))
        }
        "write_topic" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let title = input_optional_text(input, &["title"]);
            let content = input_required_text(input, &["content", "text"])?;
            let record = write_space_topic(&space_id, &topic, title.as_deref(), &content, "user")?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            Ok((
                serde_json::json!({ "topic": record }),
                Some((space_id, member_id)),
            ))
        }
        "read_topic" => {
            let (space_id, _member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let record = read_space_topic(&space_id, &topic)?;
            Ok((serde_json::json!({ "topic": record }), None))
        }
        "delete_topic" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let topic = input_required_text(input, &["topic", "name"])?;
            let deleted = delete_space_topic(&space_id, &topic, "user")?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            Ok((
                serde_json::json!({ "topic": topic, "deleted": deleted }),
                Some((space_id, member_id)),
            ))
        }
        "toggle_collection_index" => {
            let member_id = input_optional_text(input, &["memberId", "member_id"]);
            let space_id = input_required_text(input, &["spaceId", "space_id"])?;
            let item_id = input_required_text(input, &["itemId", "item_id"])?;
            let indexed = input.get("indexed").and_then(serde_json::Value::as_bool);
            let now_indexed = toggle_collection_item_indexed(&space_id, &item_id, indexed)?;
            let _ = sync_space_memory_files(pool, &space_id, member_id.as_deref()).await;
            let excluded = read_excluded_collection_ids(&space_id);
            Ok((
                serde_json::json!({
                    "spaceId": space_id,
                    "itemId": item_id,
                    "indexed": now_indexed,
                    "excludedCollectionIds": excluded,
                }),
                Some((space_id, member_id)),
            ))
        }
        "ask" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let prompt = input_required_text(input, &["prompt", "query", "text"])?;
            let res = ask_space_memory(pool, &space_id, member_id.as_deref(), &prompt).await?;
            let changed = (!res.changes.is_empty()).then_some((space_id, member_id));
            let val = serde_json::to_value(res).map_err(|e| {
                CollaborationError::new("conversation_control_failed", e.to_string())
            })?;
            Ok((val, changed))
        }
        "distill_message" => {
            let (space_id, member_id) = resolve_space_and_member_input(input)?;
            let content = input_required_text(input, &["content", "text", "message"])?;
            let scope = input_optional_text(input, &["scope"]);
            let fact = distill_message_to_memory(
                pool,
                &space_id,
                member_id.as_deref(),
                &content,
                scope.as_deref(),
            )
            .await?;
            Ok((
                serde_json::json!({ "fact": fact }),
                Some((space_id, member_id)),
            ))
        }
        _ => Err(bad(format!("unknown space memory op: {op}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::{create_session, setup_pool};

    struct MockReviewModel {
        response_json: String,
        captured_prompts: std::sync::Mutex<Vec<MemoryReviewPrompt>>,
    }

    impl MockReviewModel {
        fn new(response_json: impl Into<String>) -> Self {
            Self {
                response_json: response_json.into(),
                captured_prompts: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl MemoryReviewModel for MockReviewModel {
        async fn complete_review(
            &self,
            prompt: &MemoryReviewPrompt,
        ) -> Result<String, CollaborationError> {
            self.captured_prompts.lock().unwrap().push(prompt.clone());
            Ok(self.response_json.clone())
        }
    }

    #[test]
    fn secret_guard_catches_api_keys_passwords_and_long_digits_without_false_positives() {
        assert_eq!(
            contains_secret_or_credential("项目统一使用 pnpm 管理依赖"),
            None
        );
        assert_eq!(
            contains_secret_or_credential("私聊里帮用户查了工资单密码。"),
            None
        );
        assert_eq!(
            contains_secret_or_credential("OpenAI key: sk-1234567890abcdefghijklmnop"),
            Some("api_key_prefix")
        );
        assert_eq!(
            contains_secret_or_credential("GitHub token ghp_1234567890abcdefghijklmnopqrstuv"),
            Some("api_key_prefix")
        );
        assert_eq!(
            contains_secret_or_credential("数据库的 password = SuperSecret99"),
            Some("credential_assignment")
        );
        assert_eq!(
            contains_secret_or_credential("测试服登录密码是 Admin8888"),
            Some("credential_assignment_zh")
        );
        assert_eq!(
            contains_secret_or_credential("卡号 6222021234567890123"),
            Some("long_digit_sequence")
        );
    }

    #[tokio::test]
    async fn unified_space_memory_syncs_markdown_topics_journal_and_natural_language_ask() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        create_session(&pool, conv, workspace, Some("Hailer")).await;
        let _ = crate::collaboration::test_support::space_of(&pool, conv).await;
        let member_id = identity::member_id_for_conversation(conv);
        let space_id = format!("direct:{member_id}");

        // 1. Secret write is rejected
        let secret_err = add_space_fact(
            &pool,
            &space_id,
            Some(&member_id),
            "生产环境密码是 P@ssw0rd123",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(secret_err.code, "secret_rejected");

        // 2. Ask bar instruction adds a fact directly into MEMORY.md
        let added = ask_space_memory(
            &pool,
            &space_id,
            Some(&member_id),
            "记住：所有账单邮件归入 Finance 标签并静默归档",
        )
        .await
        .unwrap();
        assert_eq!(added.changes.len(), 1);
        assert_eq!(added.changes[0].op, "add");
        let fact_id = added.changes[0].fact_id.unwrap();

        // 3. Topic creation and MEMORY.md ## Index sync
        let topic = write_space_topic(
            &space_id,
            "mail-templates",
            Some("商务邮件回复模板"),
            "对外商务邮件统一使用英文签名档，并在末尾附带团队日历链接。",
            "user",
        )
        .unwrap();
        assert_eq!(topic.topic, "mail-templates");

        let view = view_space_memory(&pool, &space_id, Some(&member_id))
            .await
            .unwrap();
        assert_eq!(view.facts.len(), 1);
        assert_eq!(view.topics.len(), 1);
        assert!(!view.journal.is_empty());

        let md = std::fs::read_to_string(&view.memory_file_path).unwrap();
        assert!(md.contains("所有账单邮件归入 Finance 标签并静默归档"));
        assert!(md.contains("[[topic:mail-templates]]"));

        // 4. Hand-edit MEMORY.md directly on disk and verify it is authoritative (never overwritten by SQLite)
        let manual_md = format!(
            "# Memory\n\n- 手动在文件中添加的排期规则：每周三下午 3 点进行架构评审\n{}",
            md.trim_start_matches("# Memory").trim_start()
        );
        std::fs::write(&view.memory_file_path, manual_md).unwrap();
        let after_manual = view_space_memory(&pool, &space_id, Some(&member_id))
            .await
            .unwrap();
        assert_eq!(
            after_manual.facts.len(),
            2,
            "hand-edited bullet in MEMORY.md must be parsed and preserved"
        );
        assert!(
            after_manual
                .facts
                .iter()
                .any(|f| f.content.contains("每周三下午 3 点进行架构评审"))
        );

        // 5. Ask bar instruction edits the fact in place inside MEMORY.md
        let edited = ask_space_memory(
            &pool,
            &space_id,
            Some(&member_id),
            &format!("把 #{fact_id} 改成：账单邮件统一归入 Billing 标签"),
        )
        .await
        .unwrap();
        assert_eq!(edited.changes.len(), 1);
        assert_eq!(edited.changes[0].op, "edit");
        assert!(
            edited
                .view
                .facts
                .iter()
                .any(|f| f.content == "账单邮件统一归入 Billing 标签")
        );

        // 6. Ask bar Q&A searches facts from MEMORY.md
        let qa = ask_space_memory(&pool, &space_id, Some(&member_id), "账单邮件怎么处理？")
            .await
            .unwrap();
        assert!(qa.reply.contains("Billing 标签"));
    }

    #[tokio::test]
    async fn model_driven_review_applies_add_edit_and_remove_on_space_memory_md() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        create_session(&pool, conv, workspace, Some("ReviewerBot")).await;
        let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
        let member_id = identity::member_id_for_conversation(conv);

        // Seed 2 initial entries in the group space's MEMORY.md
        let f1 = add_space_fact(
            &pool,
            &group_space_id,
            Some(&member_id),
            "对外接口默认使用 snake_case",
            Some("thread"),
        )
        .await
        .unwrap();
        let f2 = add_space_fact(
            &pool,
            &group_space_id,
            Some(&member_id),
            "临时调试开关开启 verbose 日志",
            Some("thread"),
        )
        .await
        .unwrap();
        assert_ne!(f1.id, f2.id);

        let (entries, memory_chars) =
            collect_numbered_space_entries(&group_space_id, &member_id, false);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].entry_number, 1);
        assert_eq!(entries[1].entry_number, 2);

        // Model reviews the numbered entries and returns add + edit [1] + remove [2] + secret (which must be rejected)
        let model = MockReviewModel::new(
            r#"```json
            {
              "changes": [
                {"op": "edit", "entry": 1, "text": "对外接口统一改为 camelCase 命名"},
                {"op": "remove", "entry": 2},
                {"op": "add", "text": "所有 PR 合并前必须通过 clippy 与 vitest 检查"},
                {"op": "add", "text": "生产密码是 SuperSecret999"}
              ]
            }
            ```"#,
        );

        let prompt = MemoryReviewPrompt {
            space_id: group_space_id.clone(),
            member_id: member_id.clone(),
            conversation_id: Some(conv),
            system_prompt: build_review_system_prompt(&member_id, &group_space_id, false),
            user_prompt: build_review_user_prompt(
                &group_space_id,
                &entries,
                memory_chars,
                &[],
                &["User: 从现在起接口改用 camelCase，去掉临时 verbose 日志，并且 PR 必须跑 clippy 和 vitest。".to_string()],
            ),
        };
        let raw = model.complete_review(&prompt).await.unwrap();
        let parsed_changes = parse_review_response(&raw).unwrap();
        assert_eq!(parsed_changes.len(), 4);

        let applied = apply_review_changes(
            &pool,
            &group_space_id,
            &member_id,
            false,
            &entries,
            &parsed_changes,
        )
        .await
        .unwrap();
        assert_eq!(
            applied.len(),
            3,
            "secret add must be filtered out while edit/remove/valid add succeed"
        );

        let updated_facts = list_thread_facts(&pool, &group_space_id).await.unwrap();
        let texts: Vec<&str> = updated_facts.iter().map(|f| f.content.as_str()).collect();
        assert!(texts.contains(&"对外接口统一改为 camelCase 命名"));
        assert!(texts.contains(&"所有 PR 合并前必须通过 clippy 与 vitest 检查"));
        assert!(!texts.iter().any(|t| t.contains("verbose 日志")));
        assert!(!texts.iter().any(|t| t.contains("SuperSecret999")));
    }

    async fn seed_conversation_turns(conv_id: Uuid, message_texts: &[&str]) {
        let _ = crate::jsonl_history::read_existing_transcript_turns(conv_id);
        let root = agents::acp_transcript::vibex_acp_transcripts_root();
        let sid = conv_id.simple().to_string();
        let mut turns = Vec::with_capacity(message_texts.len());
        let base_ts = chrono::Utc::now();
        for (idx, text) in message_texts.iter().enumerate() {
            let ts = base_ts + chrono::Duration::seconds(idx as i64);
            let is_user = idx % 2 == 0;
            turns.push(agents::MessageTurn {
                id: format!("turn-{}", idx + 1),
                role: if is_user {
                    agents::TurnRole::User
                } else {
                    agents::TurnRole::Assistant
                },
                blocks: vec![agents::ContentBlock::Text {
                    text: (*text).to_string(),
                }],
                timestamp: ts,
                completed_at: (!is_user).then_some(ts),
                usage: None,
                duration_ms: (!is_user).then_some(10),
                model: None,
                agent_message_id: (!is_user).then(|| format!("msg-{}", idx + 1)),
            });
        }
        let header = agents::acp_transcript::TranscriptHeader::new(
            "codex",
            &sid,
            "C:/work",
            base_ts.timestamp_millis().max(0) as u64,
        );
        let mut serialized = serde_json::to_string(&header).unwrap();
        serialized.push('\n');
        for entry in crate::jsonl_history::encode_turns(&turns) {
            serialized.push_str(&serde_json::to_string(&entry).unwrap());
            serialized.push('\n');
        }
        agents::acp_transcript::replace_in(&root, "codex", &sid, serialized)
            .await
            .unwrap();
    }

    #[test]
    fn parse_review_response_handles_malformed_inputs_caps_at_eight_and_filters_invalid_entries() {
        // 1. Empty / whitespace returns empty Vec
        assert!(parse_review_response("").unwrap().is_empty());
        assert!(parse_review_response("   \n\t  ").unwrap().is_empty());

        // 2. Prose without JSON object returns Err
        let no_json = parse_review_response("No memory changes are needed for this turn.");
        assert!(no_json.is_err());

        // 3. Truncated / broken JSON returns Err
        let broken_json = parse_review_response(r#"{"changes": [{"op": "add", "text": "broken"#);
        assert!(broken_json.is_err());
        let reversed_braces = parse_review_response("} invalid {");
        assert!(reversed_braces.is_err());

        // 4. Empty changes array or missing changes key returns empty Vec
        assert!(
            parse_review_response(r#"{"changes": []}"#)
                .unwrap()
                .is_empty()
        );
        assert!(
            parse_review_response(r#"{"other": 123}"#)
                .unwrap()
                .is_empty()
        );

        // 5. Out-of-bounds entry 0, negative entry, empty text, and unknown ops are filtered out,
        //    and valid changes are capped at 8 even when > 8 valid changes are present.
        let over_eight = r#"{
            "changes": [
                {"op": "edit", "entry": 0, "text": "entry 0 must be ignored"},
                {"op": "remove", "entry": 0},
                {"op": "edit", "entry": -2, "text": "negative entry must fail deserialization"},
                {"op": "add", "text": "   "},
                {"op": "unknown_op", "text": "ignored"},
                {"op": "add", "text": "fact 1"},
                {"op": "add", "text": "fact 2"},
                {"op": "edit", "entry": 1, "text": "fact 3"},
                {"op": "remove", "entry": 2},
                {"op": "add", "text": "fact 5"},
                {"op": "add", "text": "fact 6"},
                {"op": "add", "text": "fact 7"},
                {"op": "add", "text": "fact 8"},
                {"op": "add", "text": "fact 9 should be truncated"},
                {"op": "add", "text": "fact 10 should be truncated"}
            ]
        }"#;
        let parsed = parse_review_response(over_eight).unwrap();
        assert_eq!(parsed.len(), 8, "must cap valid review changes at 8");
        assert_eq!(
            parsed[0],
            MemoryReviewChange::Add {
                text: "fact 1".to_string(),
                topic: None,
                scope: None,
            }
        );
        assert_eq!(
            parsed[2],
            MemoryReviewChange::Edit {
                entry: 1,
                text: "fact 3".to_string(),
            }
        );
        assert_eq!(parsed[3], MemoryReviewChange::Remove { entry: 2 });
        assert_eq!(
            parsed[7],
            MemoryReviewChange::Add {
                text: "fact 8".to_string(),
                topic: None,
                scope: None,
            }
        );
    }

    #[tokio::test]
    async fn apply_review_changes_ignores_out_of_bounds_entry_even_when_matching_fact_id() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        create_session(&pool, conv, workspace, Some("BoundsBot")).await;
        let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
        let member_id = identity::member_id_for_conversation(conv);

        let f1 = add_space_fact(
            &pool,
            &group_space_id,
            Some(&member_id),
            "第一条保留规则",
            Some("thread"),
        )
        .await
        .unwrap();
        let f2 = add_space_fact(
            &pool,
            &group_space_id,
            Some(&member_id),
            "第二条保留规则",
            Some("thread"),
        )
        .await
        .unwrap();

        let (entries, _) = collect_numbered_space_entries(&group_space_id, &member_id, false);
        assert_eq!(entries.len(), 2);

        // Attempt to edit and remove out-of-bounds entry numbers (including f1.id as usize if > 2, and 999)
        let bogus_entry = (f1.id.unsigned_abs() as usize).max(99);
        let changes = vec![
            MemoryReviewChange::Edit {
                entry: bogus_entry,
                text: "绝不该生效的越界修改".to_string(),
            },
            MemoryReviewChange::Remove { entry: bogus_entry },
            MemoryReviewChange::Remove { entry: 3 },
            MemoryReviewChange::Add {
                text: "x".repeat(MEMORY_ENTRY_MAX_CHARS + 1),
                topic: None,
                scope: None,
            },
        ];

        let applied = apply_review_changes(
            &pool,
            &group_space_id,
            &member_id,
            false,
            &entries,
            &changes,
        )
        .await
        .unwrap();
        assert!(
            applied.is_empty(),
            "out-of-bounds entry numbers and >300-char adds must not apply any change"
        );

        let remaining = list_thread_facts(&pool, &group_space_id).await.unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(
            remaining
                .iter()
                .any(|f| f.id == f1.id && f.content == "第一条保留规则")
        );
        assert!(
            remaining
                .iter()
                .any(|f| f.id == f2.id && f.content == "第二条保留规则")
        );
    }

    #[tokio::test]
    async fn memory_write_enforces_300_char_limit_across_all_write_paths() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        create_session(&pool, conv, workspace, Some("LimitBot")).await;
        let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;
        let member_id = identity::member_id_for_conversation(conv);

        let exact_300 = "规".repeat(MEMORY_ENTRY_MAX_CHARS);
        let over_300 = "规".repeat(MEMORY_ENTRY_MAX_CHARS + 1);

        // 1. Bot manual `tool_write` with 301 chars is rejected
        let err_write = tool_write(&pool, conv, &over_300, Some("thread"))
            .await
            .unwrap_err();
        assert_eq!(err_write.code, "bad_request");
        assert!(
            err_write.message.contains("300"),
            "expected 300-char limit error, got: {}",
            err_write.message
        );

        // 2. Bot `tool_write_with_options` (add) with 301 chars is rejected
        let err_opts = tool_write_with_options(
            &pool,
            conv,
            ToolWriteOptions {
                content: over_300.clone(),
                scope: Some("thread".to_string()),
                op: Some("add".to_string()),
                fact_id: None,
                topic: None,
                title: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err_opts.code, "bad_request");

        // 3. Exact 300 chars via `tool_write` succeeds
        let ok_fact = tool_write(&pool, conv, &exact_300, Some("thread"))
            .await
            .unwrap();
        assert_eq!(ok_fact.content.chars().count(), MEMORY_ENTRY_MAX_CHARS);

        // 4. Bot `tool_write_with_options` (replace/edit) with 301 chars is rejected
        let err_replace = tool_write_with_options(
            &pool,
            conv,
            ToolWriteOptions {
                content: over_300.clone(),
                scope: None,
                op: Some("replace".to_string()),
                fact_id: Some(ok_fact.id),
                topic: None,
                title: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err_replace.code, "bad_request");

        // 5. Direct `add_space_fact` and `update_fact` also enforce 300 chars
        assert!(
            add_space_fact(&pool, &group_space_id, Some(&member_id), &over_300, None)
                .await
                .is_err()
        );
        assert!(
            update_fact(&pool, &member_id, ok_fact.id, Some(&over_300), None)
                .await
                .is_err()
        );
    }

    struct FailableReviewModel {
        responses: std::sync::Mutex<std::collections::VecDeque<Result<String, CollaborationError>>>,
        prompts: std::sync::Mutex<Vec<MemoryReviewPrompt>>,
    }

    impl FailableReviewModel {
        fn new(responses: Vec<Result<String, CollaborationError>>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses.into()),
                prompts: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.prompts.lock().unwrap().len()
        }
    }

    #[async_trait::async_trait]
    impl MemoryReviewModel for FailableReviewModel {
        async fn complete_review(
            &self,
            prompt: &MemoryReviewPrompt,
        ) -> Result<String, CollaborationError> {
            self.prompts.lock().unwrap().push(prompt.clone());
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(r#"{"changes": []}"#.to_string()))
        }
    }

    #[tokio::test]
    async fn review_requires_30_new_messages_advances_cursor_and_preserves_cursor_on_failure() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv = Uuid::new_v4();
        create_session(&pool, conv, workspace, Some("ThresholdBot")).await;
        let group_space_id = crate::collaboration::test_support::space_of(&pool, conv).await;

        let model = FailableReviewModel::new(vec![
            Ok(r#"{"changes": [{"op": "add", "text": "满 30 条增量消息后沉淀的团队规范"}]}"#.to_string()),
            Err(CollaborationError::new("model_failed", "simulated review error")),
            Ok("not valid json at all".to_string()),
            Ok(r#"{"changes": [{"op": "edit", "entry": 1, "text": "满 60 条消息后更新的团队规范"}]}"#.to_string()),
        ]);

        // 1. Seed 29 messages (< MEMORY_REVIEW_MIN_NEW_MESSAGES = 30): must skip model call & keep cursor at 0
        let msgs_29: Vec<String> = (1..=29).map(|i| format!("讨论消息 {i}")).collect();
        let refs_29: Vec<&str> = msgs_29.iter().map(String::as_str).collect();
        seed_conversation_turns(conv, &refs_29).await;

        let res_under = review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .unwrap();
        assert!(res_under.is_empty());
        assert_eq!(
            model.call_count(),
            0,
            "must not call model before 30 new messages"
        );
        let state_before = read_space_review_state(&group_space_id);
        assert_eq!(state_before.last_turn_count, 0);
        assert!(state_before.last_turn_id.is_none());

        // 2. Seed 30th message: triggers review, applies change, and advances cursor to 30
        let msgs_30: Vec<String> = (1..=30).map(|i| format!("讨论消息 {i}")).collect();
        let refs_30: Vec<&str> = msgs_30.iter().map(String::as_str).collect();
        seed_conversation_turns(conv, &refs_30).await;

        let res_30 = review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .unwrap();
        assert_eq!(res_30.len(), 1);
        assert_eq!(model.call_count(), 1);
        let state_30 = read_space_review_state(&group_space_id);
        assert_eq!(state_30.last_turn_count, 30);
        assert!(state_30.last_turn_id.is_some());
        let saved_turn_id_30 = state_30.last_turn_id.clone();

        // 3. Seed 45 messages (only 15 new since cursor at 30): must skip review and keep cursor at 30
        let msgs_45: Vec<String> = (1..=45).map(|i| format!("讨论消息 {i}")).collect();
        let refs_45: Vec<&str> = msgs_45.iter().map(String::as_str).collect();
        seed_conversation_turns(conv, &refs_45).await;

        let res_45 = review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .unwrap();
        assert!(res_45.is_empty());
        assert_eq!(
            model.call_count(),
            1,
            "only 15 new messages since last review; must skip"
        );
        assert_eq!(read_space_review_state(&group_space_id).last_turn_count, 30);

        // 4. Seed 60 messages (30 new since cursor at 30), but model fails and then returns bad JSON:
        //    cursor must remain at 30 (neither advance to 60 nor regress to 0)
        let msgs_60: Vec<String> = (1..=60).map(|i| format!("讨论消息 {i}")).collect();
        let refs_60: Vec<&str> = msgs_60.iter().map(String::as_str).collect();
        seed_conversation_turns(conv, &refs_60).await;

        assert!(
            review_conversation_memory_with_model(&pool, conv, &model)
                .await
                .is_err()
        );
        let state_after_err = read_space_review_state(&group_space_id);
        assert_eq!(state_after_err.last_turn_count, 30);
        assert_eq!(state_after_err.last_turn_id, saved_turn_id_30);

        assert!(
            review_conversation_memory_with_model(&pool, conv, &model)
                .await
                .is_err()
        );
        let state_after_bad_json = read_space_review_state(&group_space_id);
        assert_eq!(state_after_bad_json.last_turn_count, 30);
        assert_eq!(state_after_bad_json.last_turn_id, saved_turn_id_30);

        // 5. Retry when model succeeds: reviews turns 31..60, edits entry [1], and advances cursor to 60
        let res_60 = review_conversation_memory_with_model(&pool, conv, &model)
            .await
            .unwrap();
        assert_eq!(res_60.len(), 1);
        assert_eq!(res_60[0].op, "edit");
        let state_60 = read_space_review_state(&group_space_id);
        assert_eq!(state_60.last_turn_count, 60);
        assert_ne!(state_60.last_turn_id, saved_turn_id_30);

        let facts = list_thread_facts(&pool, &group_space_id).await.unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].content, "满 60 条消息后更新的团队规范");
    }

    #[tokio::test]
    async fn concurrent_space_reviews_serialize_and_preserve_multi_member_cursors() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let conv_a = Uuid::new_v4();
        let conv_b = Uuid::new_v4();
        create_session(&pool, conv_a, workspace, Some("BotA")).await;
        create_session(&pool, conv_b, workspace, Some("BotB")).await;
        let group_space_id = crate::collaboration::test_support::space_of(&pool, conv_a).await;

        // Add BotB into the same group space using `add_space_member`
        crate::collaboration::add_space_member(
            &pool,
            conv_a,
            &group_space_id,
            conv_b,
            "BotB",
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        // Seed 16 turns in conv_a and 16 turns in conv_b (total 32 new turns across the group space >= 30)
        let msgs_a: Vec<String> = (1..=16).map(|i| format!("BotA 会话消息 {i}")).collect();
        let refs_a: Vec<&str> = msgs_a.iter().map(String::as_str).collect();
        seed_conversation_turns(conv_a, &refs_a).await;

        let msgs_b: Vec<String> = (1..=16).map(|i| format!("BotB 会话消息 {i}")).collect();
        let refs_b: Vec<&str> = msgs_b.iter().map(String::as_str).collect();
        seed_conversation_turns(conv_b, &refs_b).await;

        let model = FailableReviewModel::new(vec![
            Ok(
                r#"{"changes": [{"op": "add", "text": "并发审查只落盘一次的共享记忆"}]}"#
                    .to_string(),
            ),
            Ok(r#"{"changes": [{"op": "add", "text": "不应触发的第二次重复审查"}]}"#.to_string()),
        ]);

        // Fire two concurrent reviews on conv_a and conv_b simultaneously
        let (res_a, res_b) = tokio::join!(
            review_conversation_memory_with_model(&pool, conv_a, &model),
            review_conversation_memory_with_model(&pool, conv_b, &model),
        );
        let applied_a = res_a.unwrap();
        let applied_b = res_b.unwrap();

        // Exactly ONE of the two concurrent calls should have reviewed the 32 messages;
        // the second one sees the updated cursors (0 new messages) and skips model invocation!
        assert_eq!(
            model.call_count(),
            1,
            "same batch of messages across concurrent group members must only be reviewed once"
        );
        assert_eq!(applied_a.len() + applied_b.len(), 1);

        let state = read_space_review_state(&group_space_id);
        assert_eq!(
            state
                .conversations
                .get(&conv_a.to_string())
                .map(|c| c.last_turn_count),
            Some(16)
        );
        assert_eq!(
            state
                .conversations
                .get(&conv_b.to_string())
                .map(|c| c.last_turn_count),
            Some(16)
        );
    }

    struct MockSessionDriver {
        prepare_count: std::sync::atomic::AtomicUsize,
        run_count: std::sync::atomic::AtomicUsize,
        discard_count: std::sync::atomic::AtomicUsize,
        fail_on_run: std::sync::atomic::AtomicUsize,
    }

    impl MockSessionDriver {
        fn new(fail_on_run: usize) -> Self {
            Self {
                prepare_count: std::sync::atomic::AtomicUsize::new(0),
                run_count: std::sync::atomic::AtomicUsize::new(0),
                discard_count: std::sync::atomic::AtomicUsize::new(0),
                fail_on_run: std::sync::atomic::AtomicUsize::new(fail_on_run),
            }
        }
    }

    #[async_trait::async_trait]
    impl ReviewSessionDriver for MockSessionDriver {
        async fn resolve_agent_id(
            &self,
            _prompt: &MemoryReviewPrompt,
        ) -> Result<agents::AgentId, CollaborationError> {
            Ok(agents::AgentId::parse("codex").unwrap())
        }

        async fn is_session_alive(&self, _session: &ResidentReviewSession) -> bool {
            true
        }

        async fn prepare_session(
            &self,
            agent_id: &agents::AgentId,
            _space_id: &str,
        ) -> Result<ResidentReviewSession, CollaborationError> {
            self.prepare_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ResidentReviewSession {
                agent_id: agent_id.clone(),
                session_id: agents::AgentSessionId::from(Uuid::new_v4()),
                connection_id: agents::AgentConnectionId::from(Uuid::new_v4()),
                review_count: 0,
            })
        }

        async fn touch_session(&self, _session: &ResidentReviewSession) {}

        async fn discard_session(&self, _session: &ResidentReviewSession) {
            self.discard_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }

        async fn run_prompt(
            &self,
            _session: &ResidentReviewSession,
            _combined_prompt: String,
        ) -> Result<String, CollaborationError> {
            let run_idx = self
                .run_count
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            if run_idx == self.fail_on_run.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(CollaborationError::new(
                    "review_model_timeout",
                    "simulated timeout",
                ));
            }
            Ok(r#"{"changes": []}"#.to_string())
        }
    }

    #[tokio::test]
    async fn resident_review_session_pool_reuses_live_session_and_evicts_on_failure() {
        let pool = ResidentReviewSessionPool::default();
        // Fail on the 3rd run
        let driver = MockSessionDriver::new(3);
        let prompt = MemoryReviewPrompt {
            space_id: "space-1".to_string(),
            member_id: "member-reuse-1".to_string(),
            conversation_id: None,
            system_prompt: "sys".to_string(),
            user_prompt: "usr".to_string(),
        };

        // Run 1 & Run 2 reuse the exact same resident session
        assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
        assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
        assert_eq!(
            driver
                .prepare_count
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "must prepare session only once across multiple reviews"
        );
        assert_eq!(
            driver.run_count.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
        assert_eq!(
            driver
                .discard_count
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        // Run 3 fails -> evicts and discards the resident session
        assert!(pool.complete_with_driver(&driver, &prompt).await.is_err());
        assert_eq!(
            driver
                .discard_count
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "failed review turn must evict and discard broken session"
        );

        // Run 4 prepares a fresh resident session
        assert!(pool.complete_with_driver(&driver, &prompt).await.is_ok());
        assert_eq!(
            driver
                .prepare_count
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );
    }

    #[tokio::test]
    async fn private_chat_facts_and_topics_never_leak_into_group_space() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let group_conv = Uuid::new_v4();
        let private_conv = Uuid::new_v4();
        create_session(&pool, group_conv, workspace, Some("PrivacyBot")).await;
        create_session(&pool, private_conv, workspace, Some("PrivacyBotDirect")).await;

        let group_space_id = crate::collaboration::test_support::space_of(&pool, group_conv).await;
        let member_id = identity::member_id_for_conversation(group_conv);
        let direct_space_id = format!("direct:{member_id}");

        // Bind `private_conv` to a private direct thread for the same `member_id`
        let private_thread_id = identity::direct_thread_id(&member_id);
        sqlx::query(
            "INSERT INTO collaboration_threads (id, kind, title, created_at) VALUES (?, 'direct', '', '2026-10-24T00:00:00Z')",
        )
        .bind(&private_thread_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO collaboration_thread_members (thread_id, member_id, conversation_id, joined_at) VALUES (?, ?, ?, '2026-10-24T00:00:00Z')",
        )
        .bind(&private_thread_id)
        .bind(&member_id)
        .bind(private_conv.to_string())
        .execute(&pool)
        .await
        .unwrap();

        // 1. Write a private fact and a private topic in `direct:<member_id>`
        let priv_fact = create_fact(
            &pool,
            &member_id,
            "私聊专属秘密：下周三准备个人晋升述职材料",
            &FactScope::Private,
            Some(&private_thread_id),
            "user",
        )
        .await
        .unwrap();
        assert_eq!(priv_fact.scope, "private");

        write_space_topic(
            &direct_space_id,
            "personal-notes",
            Some("个人私密笔记"),
            "这是仅私聊可见的个人复盘内容",
            "user",
        )
        .unwrap();

        // 2. Group space view, group MEMORY.md, group memory_context_text, and group tool_search must NEVER see private fact or private topic
        let group_view = view_space_memory(&pool, &group_space_id, None)
            .await
            .unwrap();
        assert!(
            !group_view
                .facts
                .iter()
                .any(|f| f.content.contains("个人晋升述职材料")),
            "private fact must never appear in group SpaceMemoryView"
        );
        assert!(
            !group_view
                .topics
                .iter()
                .any(|t| t.topic == "personal-notes"),
            "private topic must never appear in group SpaceMemoryView"
        );

        let group_ctx = memory_context_text(&pool, group_conv, None, 10)
            .await
            .unwrap();
        if let Some(ctx_text) = group_ctx {
            assert!(!ctx_text.contains("个人晋升述职材料"));
            assert!(!ctx_text.contains("personal-notes"));
        }

        let search_res = tool_search_with_topic(&pool, group_conv, "晋升述职", None, 20)
            .await
            .unwrap();
        assert_eq!(search_res["facts"].as_array().unwrap().len(), 0);
        assert!(
            !search_res["topics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["topic"] == "personal-notes")
        );
        assert!(
            tool_search_with_topic(&pool, group_conv, "", Some("personal-notes"), 10)
                .await
                .is_err(),
            "recalling a private topic from a group thread must be denied"
        );

        // 3. Attempting to write a `private` scope fact from a group conversation is rejected
        assert!(
            tool_write(
                &pool,
                group_conv,
                "试图从群聊写入私聊作用域",
                Some("private")
            )
            .await
            .is_err()
        );
    }
}
