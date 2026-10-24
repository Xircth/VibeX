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

/// Who is resolving a card. Host/UI calls act as the user (the human
/// owner); MCP calls act as the calling member's conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardActor {
    User,
    Member(Uuid),
}

fn denied(message: impl Into<String>) -> CollaborationError {
    CollaborationError::new("permission_denied", message)
}

/// `ask` cards: the asked member (payload `target_member_id`) or the user.
/// `approval` cards: only the user.
async fn authorize_resolve(
    pool: &SqlitePool,
    card: &Card,
    actor: CardActor,
) -> Result<Option<Uuid>, CollaborationError> {
    let CardActor::Member(caller) = actor else {
        return Ok(None);
    };
    match card.kind {
        CardKind::Approval => Err(denied("only the user can resolve an approval card")),
        CardKind::Ask => {
            let Some(target) = card.payload.get("target_member_id").and_then(Value::as_str) else {
                return Err(denied(
                    "this question was asked to the user; only the user can answer it",
                ));
            };
            let seat = caller_seat(pool, &card.space_id, caller)
                .await
                .map_err(|_| denied("caller is not a member of this thread"))?;
            if seat.member_id != target {
                return Err(denied(
                    "only the asked member or the user can answer this question",
                ));
            }
            Ok(Some(seat_conversation(&seat).unwrap_or(caller)))
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
    let mut payload = input.payload.clone();
    let mut to = vec!["User".to_string()];
    let target = payload
        .get("to")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|nick| !nick.is_empty() && !nick.eq_ignore_ascii_case("user"))
        .map(str::to_string);
    if input.kind == CardKind::Ask
        && let Some(nick) = target
    {
        let members = collaboration::list_space_members(
            pool,
            &input.space_id,
            collaboration::MessageAudience::User,
        )
        .await?;
        let member = members
            .iter()
            .find(|m| m.nickname == nick && m.member_id != seat.member_id)
            .ok_or_else(|| {
                CollaborationError::new("not_a_member", format!("{nick} is not another member of this thread"))
            })?;
        payload["to"] = json!(member.nickname);
        payload["target_member_id"] = json!(member.member_id);
        to = vec![member.nickname.clone()];
    }
    let input = PostCard { payload, ..input };
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
            to,
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
    actor: CardActor,
    decision: Option<&str>,
    answer: Option<&str>,
    delivery: &DeliveryContext,
) -> Result<Card, CollaborationError> {
    let card = load_card(pool, card_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))?;
    let reply_as = authorize_resolve(pool, &card, actor).await?;
    if card.status != "pending" {
        return Err(bad("card was already resolved"));
    }
    let answer = answer.map(str::trim).filter(|text| !text.is_empty());
    let (resolution, reply) = match card.kind {
        CardKind::Ask => {
            let answer = answer.ok_or_else(|| bad("answer is required"))?;
            (
                json!({ "answer": answer }),
                format!("[回复问题 {card_id}] {answer}"),
            )
        }
        CardKind::Approval => {
            let decision = decision
                .filter(|d| APPROVAL_DECISIONS.contains(d))
                .ok_or_else(|| bad("decision must be allow_once, allow_always or deny"))?;
            let label = match decision {
                "allow_once" => "允许一次",
                // The grant is recorded on this card's thread only; there is
                // no per-member grant, so a direct chat says "this chat".
                "allow_always" if card.space_id.starts_with("direct:") => "此私聊始终允许",
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
    let members = collaboration::list_space_members(
        pool,
        &card.space_id,
        collaboration::MessageAudience::User,
    )
    .await?;
    let nickname = members
        .iter()
        .find(|member| {
            member.conversation_id.as_deref() == Some(card.from_conversation_id.as_str())
        })
        .map(|member| member.nickname.clone());
    if let Some(nickname) = nickname {
        let posted = collaboration::post_to_space_with(
            pool,
            PostToSpace {
                caller_id: reply_as,
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

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::AgentId;
    use db::models::session::{CreateSession, Session};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn create_session(pool: &SqlitePool, id: Uuid, workspace: Uuid, name: &str) {
        let input = CreateSession {
            executor: None,
            agent_id: Some(AgentId::parse("codex").unwrap()),
            task_id: None,
            name: Some(name.to_string()),
            initial_prompt: None,
            status: None,
        };
        Session::create(pool, &input, id, workspace).await.unwrap();
    }

    /// Space with members A (asker) and B; C is a live session outside the space.
    async fn fixture() -> (SqlitePool, String, Uuid, Uuid, Uuid) {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        create_session(&pool, a, workspace, "小A").await;
        create_session(&pool, b, workspace, "小B").await;
        create_session(&pool, c, workspace, "小C").await;
        let space = collaboration::create_collaboration_space(&pool, a, "群", Uuid::new_v4())
            .await
            .unwrap();
        collaboration::add_space_member(&pool, a, &space.space_id, b, "小B", Uuid::new_v4())
            .await
            .unwrap();
        (pool, space.space_id, a, b, c)
    }

    fn ask(caller: Uuid, space: &str, op: Uuid) -> PostCard {
        PostCard {
            caller_id: caller,
            space_id: space.to_string(),
            kind: CardKind::Ask,
            payload: json!({ "question": "用哪个 <分支>？", "options": ["main", "dev"] }),
            operation_id: op,
        }
    }

    fn approval(caller: Uuid, space: &str) -> PostCard {
        PostCard {
            caller_id: caller,
            space_id: space.to_string(),
            kind: CardKind::Approval,
            payload: json!({ "action": "run", "command": "rm -rf dist", "reason": "clean" }),
            operation_id: Uuid::new_v4(),
        }
    }

    #[tokio::test]
    async fn post_ask_card_creates_pending_card_and_message() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let op = Uuid::new_v4();
        let card = post_card(&pool, ask(a, &space, op), &d).await.unwrap();
        assert_eq!(card.id, op.to_string());
        assert_eq!(card.kind, CardKind::Ask);
        assert_eq!(card.status, "pending");
        assert_eq!(card.from_conversation_id, a.to_string());
        assert!(card.message_id.is_some());
        assert!(card.resolution.is_none() && card.resolved_at.is_none());
        // idempotent per operation id
        let again = post_card(&pool, ask(a, &space, op), &d).await.unwrap();
        assert_eq!(again.id, card.id);
        assert_eq!(
            list_cards(&pool, Some(&space), false).await.unwrap().len(),
            1
        );
        // same op id reused for a different kind conflicts
        let mut conflict = approval(a, &space);
        conflict.operation_id = op;
        assert_eq!(
            post_card(&pool, conflict, &d).await.unwrap_err().code,
            "operation_conflict"
        );
    }

    #[tokio::test]
    async fn post_validates_required_field_and_membership() {
        let (pool, space, a, _, c) = fixture().await;
        let d = DeliveryContext::default();
        let mut empty = ask(a, &space, Uuid::new_v4());
        empty.payload = json!({ "question": "   " });
        assert!(post_card(&pool, empty, &d).await.is_err());
        let mut no_action = approval(a, &space);
        no_action.payload = json!({ "command": "ls" });
        assert!(post_card(&pool, no_action, &d).await.is_err());
        assert!(list_cards(&pool, None, false).await.unwrap().is_empty());
        // C is not a member of the space and cannot post into it
        assert!(
            post_card(&pool, ask(c, &space, Uuid::new_v4()), &d)
                .await
                .is_err()
        );
    }

    #[test]
    fn render_card_escapes_markup_for_both_kinds() {
        let ask = render_card(
            "x",
            CardKind::Ask,
            &json!({ "question": "<b>hi</b>", "options": ["a<", "b"] }),
        );
        assert!(ask.contains("&lt;b&gt;hi&lt;/b&gt;"));
        assert!(ask.contains("<options>a&lt;|b</options>"));
        let appr = render_card(
            "y",
            CardKind::Approval,
            &json!({ "action": "go", "command": "x>y" }),
        );
        assert!(appr.starts_with("<card kind=\"approval\" id=\"y\">"));
        assert!(appr.contains("x&gt;y"));
    }

    #[tokio::test]
    async fn list_filters_by_space_and_pending() {
        let (pool, space, a, b, _) = fixture().await;
        let d = DeliveryContext::default();
        let first = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        let second = post_card(&pool, approval(b, &space), &d).await.unwrap();
        let all = list_cards(&pool, Some(&space), false).await.unwrap();
        assert_eq!(
            all.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            vec![second.id.clone(), first.id.clone()]
        );
        assert!(
            list_cards(&pool, Some("nope"), false)
                .await
                .unwrap()
                .is_empty()
        );
        resolve_card(&pool, &first.id, CardActor::User, None, Some("dev"), &d)
            .await
            .unwrap();
        let pending = list_cards(&pool, Some(&space), true).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, second.id);
        assert_eq!(list_cards(&pool, None, false).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn resolve_ask_replies_to_asker_and_second_resolve_is_rejected() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let card = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, None, None, &d)
                .await
                .is_err(),
            "answer required"
        );
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, None, Some("  "), &d)
                .await
                .is_err()
        );
        let resolved =
            resolve_card(&pool, &card.id, CardActor::User, None, Some(" dev "), &d)
            .await
            .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert_eq!(resolved.resolution, Some(json!({ "answer": "dev" })));
        assert!(resolved.resolved_at.is_some());
        let reply = resolved.reply_message_id.clone().expect("reply posted");
        let messages = collaboration::list_space_messages(
            &pool,
            &space,
            None,
            None,
            collaboration::MessageAudience::User,
        )
        .await
        .unwrap();
        let reply_msg = messages
            .iter()
            .find(|m| m.envelope.to_string().contains(&reply))
            .expect("reply message in stream");
        let text = reply_msg.envelope.to_string();
        assert!(text.contains("@小A"), "reply addressed to asker: {text}");
        assert!(!text.contains("@小B"));
        // resolving twice is rejected and leaves the first resolution intact
        let err = resolve_card(&pool, &card.id, CardActor::User, None, Some("main"), &d)
            .await
            .unwrap_err();
        assert!(err.message.contains("already resolved"));
        let stored = load_card(&pool, &card.id).await.unwrap().unwrap();
        assert_eq!(stored.resolution, Some(json!({ "answer": "dev" })));
        assert_eq!(stored.reply_message_id, Some(reply));
    }

    #[tokio::test]
    async fn resolve_approval_validates_decision_and_rejects_twice() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let card = post_card(&pool, approval(a, &space), &d).await.unwrap();
        assert_eq!(card.kind, CardKind::Approval);
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, Some("maybe"), None, &d)
                .await
                .is_err()
        );
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, None, None, &d)
                .await
                .is_err()
        );
        let resolved = resolve_card(
            &pool,
            &card.id,
            CardActor::User,
            Some("allow_once"),
            Some("ok"),
            &d,
        )
        .await
        .unwrap();
        assert_eq!(
            resolved.resolution,
            Some(json!({ "decision": "allow_once", "note": "ok" }))
        );
        assert!(resolved.reply_message_id.is_some());
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, Some("deny"), None, &d)
                .await
                .is_err()
        );
        assert_eq!(
            load_card(&pool, &card.id)
                .await
                .unwrap()
                .unwrap()
                .resolution
                .unwrap()["decision"],
            json!("allow_once")
        );
    }

    #[tokio::test]
    async fn resolve_unknown_card_is_not_found() {
        let (pool, _, _, _, _) = fixture().await;
        let err = resolve_card(
            &pool,
            "missing",
            CardActor::User,
            None,
            Some("x"),
            &DeliveryContext::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "not_found");
    }

    fn ask_to(caller: Uuid, space: &str, target: &str) -> PostCard {
        let mut input = ask(caller, space, Uuid::new_v4());
        input.payload["to"] = json!(target);
        input
    }

    #[tokio::test]
    async fn target_member_resolving_ask_succeeds_and_replies_as_that_member() {
        let (pool, space, a, b, _) = fixture().await;
        let d = DeliveryContext::default();
        let card = post_card(&pool, ask_to(a, &space, "小B"), &d).await.unwrap();
        assert!(card.payload["target_member_id"].is_string());
        assert_eq!(card.payload["to"], json!("小B"));
        let resolved =
            resolve_card(&pool, &card.id, CardActor::Member(b), None, Some("dev"), &d)
                .await
                .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert_eq!(resolved.resolution, Some(json!({ "answer": "dev" })));
        let reply = resolved.reply_message_id.expect("reply posted");
        let messages = collaboration::list_space_messages(
            &pool,
            &space,
            None,
            None,
            collaboration::MessageAudience::User,
        )
        .await
        .unwrap();
        let reply_msg = messages
            .iter()
            .find(|m| m.envelope.to_string().contains(&reply))
            .expect("reply in stream");
        assert_eq!(reply_msg.origin, "agent", "reply is posted by the member");
    }

    #[tokio::test]
    async fn user_can_resolve_ask_to_member_and_ask_to_user() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let to_member = post_card(&pool, ask_to(a, &space, "小B"), &d).await.unwrap();
        let to_user = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        for id in [&to_member.id, &to_user.id] {
            let resolved = resolve_card(&pool, id, CardActor::User, None, Some("ok"), &d)
                .await
                .unwrap();
            assert_eq!(resolved.status, "resolved");
        }
    }

    #[tokio::test]
    async fn non_target_member_cannot_resolve_ask() {
        let (pool, space, a, b, c) = fixture().await;
        let d = DeliveryContext::default();
        let card = post_card(&pool, ask_to(a, &space, "小B"), &d).await.unwrap();
        // the asker itself is not the target
        let err = resolve_card(&pool, &card.id, CardActor::Member(a), None, Some("x"), &d)
            .await
            .unwrap_err();
        assert_eq!(err.code, "permission_denied");
        assert!(err.message.contains("asked member or the user"), "{}", err.message);
        // a non-member is rejected too
        let err = resolve_card(&pool, &card.id, CardActor::Member(c), None, Some("x"), &d)
            .await
            .unwrap_err();
        assert_eq!(err.code, "permission_denied");
        // a question asked to the user cannot be answered by a member
        let to_user = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        let err = resolve_card(&pool, &to_user.id, CardActor::Member(b), None, Some("x"), &d)
            .await
            .unwrap_err();
        assert_eq!(err.code, "permission_denied");
        assert!(err.message.contains("only the user"), "{}", err.message);
        for id in [&card.id, &to_user.id] {
            assert_eq!(load_card(&pool, id).await.unwrap().unwrap().status, "pending");
        }
    }

    #[tokio::test]
    async fn member_cannot_resolve_approval() {
        let (pool, space, a, b, _) = fixture().await;
        let d = DeliveryContext::default();
        let card = post_card(&pool, approval(a, &space), &d).await.unwrap();
        for member in [a, b] {
            let err = resolve_card(
                &pool,
                &card.id,
                CardActor::Member(member),
                Some("allow_once"),
                None,
                &d,
            )
            .await
            .unwrap_err();
            assert_eq!(err.code, "permission_denied");
            assert!(err.message.contains("only the user"), "{}", err.message);
        }
        assert_eq!(load_card(&pool, &card.id).await.unwrap().unwrap().status, "pending");
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, Some("deny"), None, &d)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn ask_target_must_be_another_member() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        for target in ["nobody", "小A"] {
            let err = post_card(&pool, ask_to(a, &space, target), &d)
                .await
                .unwrap_err();
            assert_eq!(err.code, "not_a_member");
        }
    }
}
