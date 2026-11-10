//! Inline "needs you" cards: user questions and approval requests that a
//! member posts into its thread. The card is a normal space message addressed
//! to the user (so it shows up in the stream and in receipts), plus a
//! `collaboration_cards` row tracking pending/resolved. Resolving posts the
//! answer back to the asking member as a user message.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use crate::collaboration::{
    self, CollaborationError, DeliveryContext, PostToSpace, append_space_event_tx, caller_seat, db,
    finish_tx, now_stamp, require_caller_thread, seat_conversation,
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
    text.trim()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
            let questions = payload
                .get("questions")
                .map(|value| {
                    format!(
                        "\n<questions>\n{}\n</questions>",
                        escape(&value.to_string())
                    )
                })
                .unwrap_or_default();
            format!(
                "<card kind=\"ask\" id=\"{id}\">\n<question>\n{}\n</question>\n<options>{options}</options>{questions}\n</card>",
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
    require_caller_thread(pool, input.caller_id, &input.space_id).await?;
    let seat = caller_seat(pool, &input.space_id, input.caller_id).await?;
    let from = seat_conversation(&seat).unwrap_or(input.caller_id);
    let to = vec!["User".to_string()];
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
    {
        let stamp = now_stamp();
        let mut conn = pool.acquire().await.map_err(db)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let card_outcome = async {
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
            .bind(&stamp)
            .execute(&mut *conn)
            .await?;
            append_space_event_tx(
                &mut conn,
                &input.space_id,
                "space",
                Some(&posted.message_id),
                &json!({
                    "action": "card_created",
                    "card_id": id,
                    "kind": input.kind.as_str(),
                }),
                &stamp,
            )
            .await?;
            Ok::<(), CollaborationError>(())
        }
        .await;
        finish_tx(&mut conn, card_outcome).await?;
    }
    load_card(pool, &id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))
}

/// Blocking `ask_user_question` for a collaboration member: post an IM card
/// into the conversation's unique thread and keep `question_id` so Host
/// `card.resolve` can complete the companion wait.
pub async fn post_blocking_user_question(
    pool: &SqlitePool,
    caller_id: Uuid,
    questions: &Value,
    question_id: &str,
    delivery: &DeliveryContext,
) -> Result<Card, CollaborationError> {
    let space_id = collaboration::thread_id_for_conversation(pool, caller_id)
        .await?
        .ok_or_else(|| {
            CollaborationError::new("not_found", "conversation is not a collaboration member")
        })?;
    let operation_id = Uuid::parse_str(question_id)
        .map_err(|_| CollaborationError::new("not_found", "question_id must be a UUID"))?;
    let first = questions.as_array().and_then(|items| items.first());
    let question = first
        .and_then(|item| item.get("question"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if question.is_empty() {
        return Err(bad("question is required"));
    }
    let options: Vec<&str> = first
        .and_then(|item| item.get("options"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str().or_else(|| {
                        item.get("label")
                            .or_else(|| item.get("title"))
                            .or_else(|| item.get("value"))
                            .or_else(|| item.get("const"))
                            .and_then(Value::as_str)
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    post_card(
        pool,
        PostCard {
            caller_id,
            space_id,
            kind: CardKind::Ask,
            payload: json!({
                "question": question,
                "options": options,
                "questions": questions,
                "question_id": question_id,
            }),
            operation_id,
        },
        delivery,
    )
    .await
}

/// Questions array for an IM Ask card, taken from an elicitation schema
/// (`x-vibex-questions` or JSON Schema `properties`) or synthesized from the prompt.
pub fn questions_from_elicitation_schema(schema: Option<&Value>, prompt: &str) -> Value {
    if let Some(questions) = schema
        .and_then(|schema| schema.get("x-vibex-questions"))
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        return Value::Array(questions.clone());
    }
    if let Some(properties) = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .filter(|props| !props.is_empty())
    {
        let required_order: Vec<&str> = schema
            .and_then(|schema| schema.get("required"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let required_names: std::collections::HashSet<&str> =
            required_order.iter().copied().collect();
        let companions =
            custom_answer_companions_from_schema_properties(properties, &required_names);
        let mut names: Vec<&String> = Vec::with_capacity(properties.len());
        for req_name in &required_order {
            if let Some((key, _)) = properties.get_key_value(*req_name)
                && !companions.contains_key(key.as_str())
                && !names.contains(&key)
            {
                names.push(key);
            }
        }
        for key in properties.keys() {
            if !companions.contains_key(key.as_str()) && !names.contains(&key) {
                names.push(key);
            }
        }
        let companion_by_question: std::collections::HashMap<&str, &str> = companions
            .iter()
            .map(|(&companion, &question)| (question, companion))
            .collect();
        let mut parsed = Vec::with_capacity(names.len());
        for name in names.iter() {
            let Some(property) = properties.get(*name).and_then(Value::as_object) else {
                continue;
            };
            let raw_type = property.get("type").and_then(Value::as_str).unwrap_or("");
            let is_array = raw_type == "array";
            let title = property
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let description = property
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let fallback_prompt = prompt.trim();
            let question_text = description
                .or_else(|| {
                    if names.len() == 1 {
                        (!fallback_prompt.is_empty())
                            .then_some(fallback_prompt)
                            .or(title)
                    } else {
                        title
                    }
                })
                .or_else(|| (!fallback_prompt.is_empty()).then_some(fallback_prompt))
                .unwrap_or(name.as_str());
            let header_text = title.unwrap_or_else(|| {
                if question_text.is_empty() {
                    name.as_str()
                } else {
                    question_text
                }
            });
            let options = schema_property_options(property, raw_type);
            let mut item = json!({
                "id": name,
                "fieldName": name,
                "header": header_text,
                "question": question_text,
                "multiSelect": is_array,
                "options": options,
            });
            if let Some(&custom_field) = companion_by_question.get(name.as_str())
                && let Some(obj) = item.as_object_mut()
            {
                obj.insert(
                    "customFieldName".to_string(),
                    Value::String(custom_field.to_string()),
                );
            }
            parsed.push(item);
        }
        if !parsed.is_empty() {
            return Value::Array(parsed);
        }
    }
    json!([{
        "question": prompt,
        "header": prompt,
        "options": [],
    }])
}

fn custom_answer_companions_from_schema_properties<'a>(
    properties: &'a serde_json::Map<String, Value>,
    required_names: &std::collections::HashSet<&str>,
) -> std::collections::HashMap<&'a str, &'a str> {
    const CUSTOM_FIELD_SUFFIX: &str = "_custom";
    let mut companions = std::collections::HashMap::new();
    for (name, raw_property) in properties {
        let name_str = name.as_str();
        if !name_str.ends_with(CUSTOM_FIELD_SUFFIX) || required_names.contains(name_str) {
            continue;
        }
        let question_name = &name_str[..name_str.len() - CUSTOM_FIELD_SUFFIX.len()];
        let Some((question_key, question_val)) = properties.get_key_value(question_name) else {
            continue;
        };
        let (Some(question), Some(companion)) =
            (question_val.as_object(), raw_property.as_object())
        else {
            continue;
        };
        let question_type = question.get("type").and_then(Value::as_str).unwrap_or("");
        if question_type != "string" && question_type != "array" {
            continue;
        }
        if schema_property_options(question, question_type).is_empty() {
            continue;
        }
        let companion_type = companion.get("type").and_then(Value::as_str).unwrap_or("");
        if companion_type != "string" {
            continue;
        }
        if !parse_schema_options(companion).is_empty() {
            continue;
        }
        companions.insert(name_str, question_key.as_str());
    }
    companions
}

fn schema_property_options(
    property: &serde_json::Map<String, Value>,
    raw_type: &str,
) -> Vec<Value> {
    if raw_type == "array" {
        return property
            .get("items")
            .and_then(Value::as_object)
            .map(parse_schema_options)
            .unwrap_or_default();
    }
    if raw_type == "boolean" {
        return vec![
            json!({ "value": true, "label": "Yes", "description": "" }),
            json!({ "value": false, "label": "No", "description": "" }),
        ];
    }
    parse_schema_options(property)
}

fn parse_schema_options(property: &serde_json::Map<String, Value>) -> Vec<Value> {
    if let Some(items) = property.get("oneOf").and_then(Value::as_array) {
        return parse_const_options(items);
    }
    if let Some(items) = property.get("anyOf").and_then(Value::as_array) {
        return parse_const_options(items);
    }
    let Some(items) = property.get("enum").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|value| {
            let label = primitive_option_string(value)?;
            Some(json!({
                "value": value,
                "label": label,
                "description": "",
            }))
        })
        .collect()
}

fn parse_const_options(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .filter_map(|raw_choice| {
            let choice = raw_choice.as_object()?;
            let const_val = choice.get("const")?;
            let fallback_label = primitive_option_string(const_val)?;
            let label = choice
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&fallback_label);
            let description = choice
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            Some(json!({
                "value": const_val,
                "label": label,
                "description": description,
            }))
        })
        .collect()
}

fn primitive_option_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Native Grok/Claude elicitation for a seated collab conversation: post the
/// same blocking Ask card MCP `ask_user_question` uses. Ordinary sessions
/// have no seat and return `Ok(None)` so the composer card stays the surface.
pub async fn post_elicitation_question_if_seated(
    pool: &SqlitePool,
    caller_id: Uuid,
    question_id: &str,
    prompt: &str,
    schema: Option<&Value>,
    delivery: &DeliveryContext,
) -> Result<Option<Card>, CollaborationError> {
    if collaboration::thread_id_for_conversation(pool, caller_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let questions = questions_from_elicitation_schema(schema, prompt);
    match post_blocking_user_question(pool, caller_id, &questions, question_id, delivery).await {
        Ok(card) => Ok(Some(card)),
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) => Err(error),
    }
}

/// Settle a matching IM Ask card after the session composer (or Host) already
/// answered the elicitation. Missing or already-resolved cards are ignored.
pub async fn resolve_elicitation_question_card(
    pool: &SqlitePool,
    question_id: &str,
    answer: &str,
    delivery: &DeliveryContext,
) -> Result<(), CollaborationError> {
    match resolve_card(
        pool,
        question_id,
        CardActor::User,
        None,
        Some(answer),
        delivery,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) if error.code == "not_found" => Ok(()),
        Err(error) if error.message.contains("already resolved") => Ok(()),
        Err(error) => Err(error),
    }
}

/// Settle a matching Approval card when the user responds through the
/// conversation permission dock (`conversation.respondPermission`). Missing or
/// already-resolved cards return the current card state without error.
pub async fn resolve_approval_card_if_pending(
    pool: &SqlitePool,
    card_id: &str,
    decision: &str,
    delivery: &DeliveryContext,
) -> Result<Option<Card>, CollaborationError> {
    match resolve_card(
        pool,
        card_id,
        CardActor::User,
        Some(decision),
        None,
        delivery,
    )
    .await
    {
        Ok(card) => Ok(Some(card)),
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) if error.message.contains("already resolved") => load_card(pool, card_id).await,
        Err(error) => Err(error),
    }
}

fn card_reply_text(card: &Card, resolution: &Value) -> Option<String> {
    match card.kind {
        CardKind::Ask => {
            let answer = resolution.get("answer").and_then(Value::as_str)?;
            Some(format!("[回复问题 {}] {answer}", card.id))
        }
        CardKind::Approval => {
            let decision = resolution.get("decision").and_then(Value::as_str)?;
            let label = match decision {
                "allow_once" => "允许一次",
                // The grant is recorded on this card's thread only; there is
                // no per-member grant, so a direct chat says "this chat".
                "allow_always" if card.space_id.starts_with("direct:") => "此私聊始终允许",
                "allow_always" => "本群始终允许",
                _ => "拒绝",
            };
            let mut text = format!("[审批 {}] {label}（{decision}）", card.id);
            if let Some(note) = resolution
                .get("note")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
            {
                text.push_str(&format!("：{note}"));
            }
            Some(text)
        }
    }
}

async fn resolve_card_author_nickname(
    pool: &SqlitePool,
    card: &Card,
) -> Result<Option<String>, CollaborationError> {
    let members = collaboration::list_space_members(
        pool,
        &card.space_id,
        collaboration::MessageAudience::User,
    )
    .await?;
    let from_space = members
        .iter()
        .find(|member| {
            member.conversation_id.as_deref() == Some(card.from_conversation_id.as_str())
        })
        .map(|member| member.nickname.clone());
    if from_space.is_some() {
        return Ok(from_space);
    }
    if let Ok(from_uuid) = Uuid::parse_str(&card.from_conversation_id)
        && let Ok(seat) = caller_seat(pool, &card.space_id, from_uuid).await
    {
        return Ok(Some(seat.nickname));
    }
    Ok(None)
}

/// Deliver a resolved card's formatted reply message (`@nickname [审批/回复问题 ...]`)
/// into its thread and record `reply_message_id`. Used directly for non-blocking
/// cards and as a fallback when a blocking MCP wait is no longer active.
pub async fn deliver_card_reply(
    pool: &SqlitePool,
    card_id: &str,
    reply_as: Option<Uuid>,
    delivery: &DeliveryContext,
) -> Result<Option<String>, CollaborationError> {
    let card = load_card(pool, card_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))?;
    if card.reply_message_id.is_some() {
        return Ok(card.reply_message_id);
    }
    let Some(resolution) = card.resolution.as_ref() else {
        return Ok(None);
    };
    let Some(reply) = card_reply_text(&card, resolution) else {
        return Ok(None);
    };
    let operation_id = Uuid::new_v5(
        &Uuid::parse_str(card_id).unwrap_or_else(|_| Uuid::new_v4()),
        b"card-reply",
    );
    let posted_message_id = if card.space_id.starts_with("direct:") && reply_as.is_none() {
        let (posted, _, _) = collaboration::post_direct_message_with(
            pool,
            collaboration::PostDirectMessage {
                thread_id: card.space_id.clone(),
                content: reply,
                summary: None,
                in_reply_to: card.message_id.clone(),
                operation_id,
            },
            delivery,
        )
        .await?;
        posted.message_id
    } else {
        let Some(nickname) = resolve_card_author_nickname(pool, &card).await? else {
            return Ok(None);
        };
        let posted = collaboration::post_to_space_with(
            pool,
            PostToSpace {
                caller_id: reply_as,
                space_id: card.space_id.clone(),
                content: format!("@{nickname} {reply}"),
                summary: None,
                to: vec![nickname],
                in_reply_to: card.message_id.clone(),
                operation_id,
            },
            delivery,
        )
        .await?;
        posted.message_id
    };
    sqlx::query("UPDATE collaboration_cards SET reply_message_id = ? WHERE id = ?")
        .bind(&posted_message_id)
        .bind(card_id)
        .execute(pool)
        .await
        .map_err(db)?;
    Ok(Some(posted_message_id))
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
    let resolution = match card.kind {
        CardKind::Ask => {
            let answer = answer.ok_or_else(|| bad("answer is required"))?;
            json!({ "answer": answer })
        }
        CardKind::Approval => {
            let decision = decision
                .filter(|d| APPROVAL_DECISIONS.contains(d))
                .ok_or_else(|| bad("decision must be allow_once, allow_always or deny"))?;
            json!({ "decision": decision, "note": answer })
        }
    };
    {
        let stamp = now_stamp();
        let mut conn = pool.acquire().await.map_err(db)?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *conn)
            .await
            .map_err(db)?;
        let res_outcome = async {
            let claimed = sqlx::query(
                r#"UPDATE collaboration_cards
                   SET status = 'resolved', resolution_json = ?, resolved_at = ?
                   WHERE id = ? AND status = 'pending'"#,
            )
            .bind(resolution.to_string())
            .bind(&stamp)
            .bind(card_id)
            .execute(&mut *conn)
            .await?;
            if claimed.rows_affected() == 0 {
                return Err(bad("card was already resolved"));
            }
            append_space_event_tx(
                &mut conn,
                &card.space_id,
                "space",
                card.message_id.as_deref(),
                &json!({
                    "action": "card_resolved",
                    "card_id": card_id,
                    "kind": card.kind.as_str(),
                }),
                &stamp,
            )
            .await?;
            Ok::<(), CollaborationError>(())
        }
        .await;
        finish_tx(&mut conn, res_outcome).await?;
    }
    let skip_member_delivery = card
        .payload
        .get("question_id")
        .and_then(Value::as_str)
        .is_some();
    if !skip_member_delivery {
        deliver_card_reply(pool, card_id, reply_as, delivery).await?;
    }
    let resolved = load_card(pool, card_id)
        .await?
        .ok_or_else(|| CollaborationError::new("not_found", "card was not found"))?;
    if skip_member_delivery
        && let Ok(workspace_id) =
            crate::collaboration::space_workspace_id(pool, &resolved.space_id).await
    {
        delivery.notify_space_changed(
            crate::collaboration::latest_space_changed_event(
                pool,
                workspace_id,
                &resolved.space_id,
                resolved.member_id.clone(),
            )
            .await,
        );
    }
    Ok(resolved)
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
        collaboration::add_space_member(&pool, a, &space.space_id, a, "小A", Uuid::new_v4())
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

    #[tokio::test]
    async fn card_from_dm_cannot_use_shared_group_space_id() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        let created_a = collaboration::host_create_space_member(
            &pool,
            collaboration::HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "Faker".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let a_conv = Uuid::parse_str(created_a.conversation_id.as_deref().unwrap()).unwrap();
        let group =
            collaboration::create_collaboration_space(&pool, a_conv, "海鸥计划", Uuid::new_v4())
                .await
                .unwrap();
        let mut card = ask(a_conv, &group.space_id, Uuid::new_v4());
        card.payload = json!({ "question": "用哪个分支？" });
        let error = post_card(&pool, card, &DeliveryContext::default())
            .await
            .expect_err("DM session must not post a card with a group space_id");
        assert_eq!(error.code, "invalid_origin_space");
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

    #[test]
    fn render_card_includes_ask_user_question_payload() {
        let rendered = render_card(
            "qid",
            CardKind::Ask,
            &json!({
                "question": "用哪个方案？",
                "options": ["Patch (Recommended)", "Rewrite"],
                "question_id": "qid",
                "questions": [{
                    "question": "用哪个方案？",
                    "header": "方案",
                    "multiSelect": false,
                    "options": [
                        { "label": "Patch (Recommended)", "description": "小改。" },
                        { "label": "Rewrite", "description": "重写。" }
                    ]
                }]
            }),
        );
        assert!(rendered.contains("<questions>"));
        assert!(rendered.contains("Patch (Recommended)"));
        assert!(rendered.contains(r#""header""#));
        assert!(rendered.contains("</questions>"));
    }

    #[tokio::test]
    async fn blocking_user_question_posts_to_member_thread_and_skips_reply_delivery() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let question_id = Uuid::new_v4().to_string();
        let questions = json!([{
            "question": "用哪个方案？",
            "header": "方案",
            "multiSelect": false,
            "options": [
                { "label": "A", "description": "one" },
                { "label": "B", "description": "two" }
            ]
        }]);
        let card = post_blocking_user_question(&pool, a, &questions, &question_id, &d)
            .await
            .unwrap();
        assert_eq!(card.id, question_id);
        assert_eq!(card.space_id, space);
        assert_eq!(card.payload["question_id"], json!(question_id));
        assert_eq!(card.payload["options"], json!(["A", "B"]));
        assert!(render_card(&card.id, card.kind, &card.payload).contains("<questions>"));

        let resolved = resolve_card(&pool, &card.id, CardActor::User, None, Some("A"), &d)
            .await
            .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert!(resolved.reply_message_id.is_none());
    }

    #[test]
    fn elicitation_schema_keeps_vibex_questions_for_the_im_card() {
        let schema = json!({
            "type": "object",
            "x-vibex-questions": [{
                "id": "q1",
                "header": "方案",
                "question": "用哪个方案？",
                "options": [
                    { "label": "Patch", "description": "小改" },
                    { "label": "Rewrite", "description": "重写" }
                ]
            }]
        });
        let questions = questions_from_elicitation_schema(Some(&schema), "fallback");
        assert_eq!(questions[0]["question"], json!("用哪个方案？"));
        assert_eq!(questions[0]["options"][0]["label"], json!("Patch"));
        let synthesized = questions_from_elicitation_schema(None, "Pick one");
        assert_eq!(synthesized[0]["question"], json!("Pick one"));
    }

    #[test]
    fn elicitation_schema_extracts_claude_code_properties_and_custom_companions() {
        let schema = json!({
            "type": "object",
            "properties": {
                "auth": {
                    "type": "string",
                    "title": "服务器登录",
                    "description": "如何连接服务器？",
                    "oneOf": [
                        {
                            "const": "ssh_key",
                            "title": "我生成专用密钥，你贴一条命令装上（推荐）",
                            "description": "全程免密自动化部署。"
                        },
                        {
                            "const": "password",
                            "title": "直接把 root 密码给我",
                            "description": "密码会进入会话上下文。"
                        }
                    ]
                },
                "auth_custom": {
                    "type": "string",
                    "title": "Other"
                },
                "checks": {
                    "type": "array",
                    "title": "验证项",
                    "items": {
                        "anyOf": [
                            { "const": "lint", "title": "Lint", "description": "" },
                            { "const": "test", "title": "Tests", "description": "" }
                        ]
                    }
                },
                "checks_custom": {
                    "type": "string",
                    "title": "Other"
                }
            },
            "required": ["auth", "checks"]
        });
        let questions = questions_from_elicitation_schema(Some(&schema), "需要你回答 2 个问题");
        let items = questions.as_array().expect("questions array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], json!("auth"));
        assert_eq!(items[0]["fieldName"], json!("auth"));
        assert_eq!(items[0]["customFieldName"], json!("auth_custom"));
        assert_eq!(items[0]["header"], json!("服务器登录"));
        assert_eq!(items[0]["question"], json!("如何连接服务器？"));
        assert_eq!(items[0]["multiSelect"], json!(false));
        assert_eq!(items[0]["options"].as_array().unwrap().len(), 2);
        assert_eq!(items[0]["options"][0]["value"], json!("ssh_key"));
        assert_eq!(
            items[0]["options"][0]["label"],
            json!("我生成专用密钥，你贴一条命令装上（推荐）")
        );

        assert_eq!(items[1]["id"], json!("checks"));
        assert_eq!(items[1]["customFieldName"], json!("checks_custom"));
        assert_eq!(items[1]["header"], json!("验证项"));
        assert_eq!(items[1]["question"], json!("验证项"));
        assert_eq!(items[1]["multiSelect"], json!(true));
        assert_eq!(items[1]["options"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn native_elicitation_posts_an_im_card_only_for_seated_members() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let question_id = Uuid::new_v4().to_string();
        let schema = json!({
            "type": "object",
            "x-vibex-questions": [{
                "question": "用哪个方案？",
                "header": "方案",
                "options": [
                    { "label": "A", "description": "one" },
                    { "label": "B", "description": "two" }
                ]
            }]
        });
        let card = post_elicitation_question_if_seated(
            &pool,
            a,
            &question_id,
            "用哪个方案？",
            Some(&schema),
            &d,
        )
        .await
        .unwrap()
        .expect("seated member gets an IM card");
        assert_eq!(card.id, question_id);
        assert_eq!(card.space_id, space);
        assert_eq!(card.payload["options"], json!(["A", "B"]));

        resolve_elicitation_question_card(&pool, &question_id, "A", &d)
            .await
            .unwrap();
        resolve_elicitation_question_card(&pool, &question_id, "A", &d)
            .await
            .expect("already-resolved IM card is ignored");

        let outsider = Uuid::new_v4();
        assert!(
            post_elicitation_question_if_seated(
                &pool,
                outsider,
                &Uuid::new_v4().to_string(),
                "hello",
                None,
                &d,
            )
            .await
            .unwrap()
            .is_none()
        );
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
        let resolved = resolve_card(&pool, &card.id, CardActor::User, None, Some(" dev "), &d)
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

    #[tokio::test]
    async fn user_can_resolve_ask_to_user() {
        let (pool, space, a, _, _) = fixture().await;
        let d = DeliveryContext::default();
        let to_user = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        let resolved = resolve_card(&pool, &to_user.id, CardActor::User, None, Some("ok"), &d)
            .await
            .unwrap();
        assert_eq!(resolved.status, "resolved");
    }

    #[tokio::test]
    async fn member_cannot_resolve_ask_addressed_to_user() {
        let (pool, space, a, b, _) = fixture().await;
        let d = DeliveryContext::default();
        let to_user = post_card(&pool, ask(a, &space, Uuid::new_v4()), &d)
            .await
            .unwrap();
        let err = resolve_card(
            &pool,
            &to_user.id,
            CardActor::Member(b),
            None,
            Some("x"),
            &d,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "permission_denied");
        assert!(err.message.contains("only the user"), "{}", err.message);
        assert_eq!(
            load_card(&pool, &to_user.id).await.unwrap().unwrap().status,
            "pending"
        );
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
        assert_eq!(
            load_card(&pool, &card.id).await.unwrap().unwrap().status,
            "pending"
        );
        assert!(
            resolve_card(&pool, &card.id, CardActor::User, Some("deny"), None, &d)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn approval_card_in_direct_space_keeps_delivery_open_and_resolves_dm_nickname() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO workspaces (id, task_id, branch) VALUES (?, ?, 'main')")
            .bind(workspace)
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        let created = collaboration::host_create_space_member(
            &pool,
            collaboration::HostCreateSpaceMember {
                workspace_id: workspace,
                space_id: None,
                nickname: "Faker".to_string(),
                role_id: None,
                agent_id: Some("codex".to_string()),
                team_id: None,
                persona_prompt: None,
                mode_id: None,
                config_values: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let bot_conv = Uuid::parse_str(created.conversation_id.as_deref().unwrap()).unwrap();
        let direct_space = collaboration::thread_id_for_conversation(&pool, bot_conv)
            .await
            .unwrap()
            .expect("bot has direct thread");
        let d = DeliveryContext::default();

        // Simulate user message delivered to the bot in its direct space.
        let (user_post, _, _) = collaboration::post_direct_message_with(
            &pool,
            collaboration::PostDirectMessage {
                thread_id: direct_space.clone(),
                content: "请删除旧Bot".to_string(),
                summary: None,
                in_reply_to: None,
                operation_id: Uuid::new_v4(),
            },
            &d,
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE collaboration_space_deliveries SET receipt_state = 'processing', status = 'dispatched' WHERE space_message_id = ?",
        )
        .bind(&user_post.message_id)
        .execute(&pool)
        .await
        .unwrap();

        // Bot posts an approval card mid-turn: the processing delivery MUST remain open!
        let card = post_card(&pool, approval(bot_conv, &direct_space), &d)
            .await
            .unwrap();
        let receipt_state: String = sqlx::query_scalar(
            "SELECT receipt_state FROM collaboration_space_deliveries WHERE space_message_id = ?",
        )
        .bind(&user_post.message_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            receipt_state, "processing",
            "posting an approval card mid-turn must not close the active delivery"
        );

        // Resolving the card in a direct:<member_id> space must find the DM nickname ("Faker")
        // and post the reply message.
        let resolved = resolve_card(
            &pool,
            &card.id,
            CardActor::User,
            Some("allow_once"),
            None,
            &d,
        )
        .await
        .unwrap();
        assert_eq!(resolved.status, "resolved");
        assert!(
            resolved.reply_message_id.is_some(),
            "direct space approval resolution must deliver reply message to DM bot"
        );
    }
}
