//! Inline "needs you" cards (Phase 5): `ask_person` questions and approval
//! requests that a member posts into its thread. The card is a normal space
//! message addressed to the user (so it shows up in the stream and in
//! receipts), plus a `collaboration_cards` row tracking pending/resolved.
//! Resolving posts the answer back to the asking member as a user message.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::collaboration::{
    self, CollaborationError, DeliveryContext, PostToSpace, caller_seat, db, now_stamp,
    seat_conversation,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardKind {
    Ask,
    Approval,
}

impl CardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Approval => "approval",
        }
    }
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "ask" => Some(Self::Ask),
            "approval" => Some(Self::Approval),
            _ => None,
        }
    }
}

/// Approval decisions offered on an approval card.
pub const APPROVAL_DECISIONS: [&str; 3] = ["allow_once", "allow_always", "deny"];

#[derive(Debug, Clone, Serialize)]
pub struct Card {
    pub id: String,
    pub space_id: String,
    pub kind: CardKind,
    pub from_conversation_id: String,
    pub member_id: Option<String>,
    pub payload: Value,
    pub status: String,
    pub resolution: Option<Value>,
    pub message_id: Option<String>,
    pub reply_message_id: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(FromRow)]
struct CardRow {
    id: String,
    space_id: String,
    kind: String,
    from_conversation_id: String,
    member_id: Option<String>,
    payload_json: String,
    status: String,
    resolution_json: Option<String>,
    message_id: Option<String>,
    reply_message_id: Option<String>,
    created_at: String,
    resolved_at: Option<String>,
}

impl From<CardRow> for Card {
    fn from(row: CardRow) -> Self {
        Self {
            id: row.id,
            space_id: row.space_id,
            kind: CardKind::parse(&row.kind).unwrap_or(CardKind::Ask),
            from_conversation_id: row.from_conversation_id,
            member_id: row.member_id,
            payload: serde_json::from_str(&row.payload_json).unwrap_or(Value::Null),
            status: row.status,
            resolution: row
                .resolution_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok()),
            message_id: row.message_id,
            reply_message_id: row.reply_message_id,
            created_at: row.created_at,
            resolved_at: row.resolved_at,
        }
    }
}

const COLUMNS: &str = "id, space_id, kind, from_conversation_id, member_id, payload_json, status, \
                       resolution_json, message_id, reply_message_id, created_at, resolved_at";

fn bad(message: impl Into<String>) -> CollaborationError {
    CollaborationError::new("conversation_control_failed", message)
}

fn escape(text: &str) -> String {
    text.trim().replace('<', "&lt;").replace('>', "&gt;")
}

/// Text body of the card message. The frontend parses this markup into a
/// card; agents reading the log see a readable question.
pub fn render_card(id: &str, kind: CardKind, payload: &Value) -> String {
    let field = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("");
    match kind {
        CardKind::Ask => {
            let options = payload
                .get("options")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(escape)
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .unwrap_or_default();
            format!(
                "<card kind=\"ask\" id=\"{id}\">\n<question>\n{}\n</question>\n<options>{options}</options>\n</card>",
                escape(field("question"))
            )
        }
        CardKind::Approval => format!(
            "<card kind=\"approval\" id=\"{id}\">\n<action>\n{}\n</action>\n<command>\n{}\n</command>\n<reason>\n{}\n</reason>\n</card>",
            escape(field("action")),
            escape(field("command")),
            escape(field("reason"))
        ),
    }
}

pub struct PostCard {
    pub caller_id: Uuid,
    pub space_id: String,
    pub kind: CardKind,
    pub payload: Value,
    pub operation_id: Uuid,
}

/// Post an ask/approval card into the caller's thread, addressed to the user.
/// Idempotent per `operation_id`.
pub async fn post_card(
    pool: &SqlitePool,
    input: PostCard,
    delivery: &DeliveryContext,
) -> Result<Card, CollaborationError> {
    let id = input.operation_id.to_string();
    if let Some(existing) = load_card(pool, &id).await? {
        if existing.space_id != input.space_id || existing.kind != input.kind {
            return Err(CollaborationError::new(
                "operation_conflict",
                "operation_id was already used for a different card",
            ));
        }
        return Ok(existing);
    }
    let required = match input.kind {
        CardKind::Ask => "question",
        CardKind::Approval => "action",
    };
    if input
        .payload
        .get(required)
        .and_then(Value::as_str)
        .is_none_or(|text| text.trim().is_empty())
    {
        return Err(bad(format!("{required} is required")));
    }
    let seat = caller_seat(pool, &input.space_id, input.caller_id).await?;
    let from = seat_conversation(&seat).unwrap_or(input.caller_id);
    let content = render_card(&id, input.kind, &input.payload);
    let summary = match input.kind {
        CardKind::Ask => format!(
            "问你：{}",
            input.payload["question"].as_str().unwrap_or("").trim()
        ),
        CardKind::Approval => format!(
            "请求审批：{}",
            input.payload["action"].as_str().unwrap_or("").trim()
        ),
    };
    let posted = collaboration::post_to_space_with(
        pool,
        PostToSpace {
            caller_id: Some(input.caller_id),
            space_id: input.space_id.clone(),
            content,
            summary: Some(summary),
            to: vec!["User".to_string()],
            in_reply_to: None,
            operation_id: Uuid::new_v5(&input.operation_id, b"card-message"),
        },
        delivery,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO collaboration_cards
           (id, space_id, from_conversation_id, member_id, kind, payload_json, message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&id)
    .bind(&input.space_id)
    .bind(from.to_string())
    .bind(&seat.member_id)
    .bind(input.kind.as_str())
    .bind(input.payload.to_string())
    .bind(&posted.message_id)
    .bind(now_stamp())
    .execute(pool)
    .await
    .map_err(db)?;
    load_card(pool, &id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))
}

pub async fn load_card(pool: &SqlitePool, id: &str) -> Result<Option<Card>, CollaborationError> {
    Ok(sqlx::query_as::<_, CardRow>(&format!(
        "SELECT {COLUMNS} FROM collaboration_cards WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .map(Card::from))
}

/// Cards of a thread (newest first). `pending_only` drives "needs you".
pub async fn list_cards(
    pool: &SqlitePool,
    space_id: Option<&str>,
    pending_only: bool,
) -> Result<Vec<Card>, CollaborationError> {
    let rows = sqlx::query_as::<_, CardRow>(&format!(
        "SELECT {COLUMNS} FROM collaboration_cards
         WHERE (?1 IS NULL OR space_id = ?1) AND (?2 = 0 OR status = 'pending')
         ORDER BY created_at DESC, rowid DESC LIMIT 500"
    ))
    .bind(space_id)
    .bind(pending_only as i64)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(Card::from).collect())
}

/// Resolve a pending card and deliver the answer to the asking member.
/// `answer` is free text for ask cards; for approval cards `decision` must be
/// one of [`APPROVAL_DECISIONS`]. Resolving twice is rejected.
pub async fn resolve_card(
    pool: &SqlitePool,
    card_id: &str,
    decision: Option<&str>,
    answer: Option<&str>,
    delivery: &DeliveryContext,
) -> Result<Card, CollaborationError> {
    let card = load_card(pool, card_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))?;
    if card.status != "pending" {
        return Err(bad("card was already resolved"));
    }
    let answer = answer.map(str::trim).filter(|text| !text.is_empty());
    let (resolution, reply) = match card.kind {
        CardKind::Ask => {
            let answer = answer.ok_or_else(|| bad("answer is required"))?;
            (json!({ "answer": answer }), format!("[回复问题 {card_id}] {answer}"))
        }
        CardKind::Approval => {
            let decision = decision
                .filter(|d| APPROVAL_DECISIONS.contains(d))
                .ok_or_else(|| bad("decision must be allow_once, allow_always or deny"))?;
            let label = match decision {
                "allow_once" => "允许一次",
                "allow_always" => "本群始终允许",
                _ => "拒绝",
            };
            let mut text = format!("[审批 {card_id}] {label}（{decision}）");
            if let Some(note) = answer {
                text.push_str(&format!("：{note}"));
            }
            (json!({ "decision": decision, "note": answer }), text)
        }
    };
    let claimed = sqlx::query(
        r#"UPDATE collaboration_cards
           SET status = 'resolved', resolution_json = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'"#,
    )
    .bind(resolution.to_string())
    .bind(now_stamp())
    .bind(card_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if claimed.rows_affected() == 0 {
        return Err(bad("card was already resolved"));
    }
    let members =
        collaboration::list_space_members(pool, &card.space_id, collaboration::MessageAudience::User)
            .await?;
    let nickname = members
        .iter()
        .find(|member| member.conversation_id.as_deref() == Some(card.from_conversation_id.as_str()))
        .map(|member| member.nickname.clone());
    if let Some(nickname) = nickname {
        let posted = collaboration::post_to_space_with(
            pool,
            PostToSpace {
                caller_id: None,
                space_id: card.space_id.clone(),
                content: format!("@{nickname} {reply}"),
                summary: None,
                to: vec![nickname],
                in_reply_to: card.message_id.clone(),
                operation_id: Uuid::new_v5(
                    &Uuid::parse_str(card_id).unwrap_or_else(|_| Uuid::new_v4()),
                    b"card-reply",
                ),
            },
            delivery,
        )
        .await?;
        sqlx::query("UPDATE collaboration_cards SET reply_message_id = ? WHERE id = ?")
            .bind(&posted.message_id)
            .bind(card_id)
            .execute(pool)
            .await
            .map_err(db)?;
    }
    load_card(pool, card_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))
}
