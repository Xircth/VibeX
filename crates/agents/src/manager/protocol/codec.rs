use super::*;

pub(crate) fn dropped_update_log_line(
    connection_id: &AgentConnectionId,
    session_id: Option<AgentSessionId>,
    tag: Option<&str>,
    error: &str,
    suppressed: u64,
) -> String {
    let tag_part = tag.unwrap_or("<missing>");
    let session_part = session_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "-".to_string());
    if suppressed > 0 {
        format!(
            "[ACP] ignoring unreadable session/update (connection={connection_id}, session={session_part}, sessionUpdate={tag_part}, +{suppressed} suppressed in previous 10s window): {error}"
        )
    } else {
        format!(
            "[ACP] ignoring unreadable session/update (connection={connection_id}, session={session_part}, sessionUpdate={tag_part}): {error}"
        )
    }
}

/// Remove `"data": null` from a JSON-RPC error response line (alone or in a batch).
///
/// `agent-client-protocol` preserves an explicit `"data": null` as `Some(Value::Null)`
/// and formats it as `"{message}: null"`. Messages with a `"method"` field keep
/// their payload untouched.
pub(crate) fn omit_null_error_data(line: String) -> String {
    if !line.contains("null") || has_null_error_data(&line) == Some(false) {
        return line;
    }
    let Ok(mut message) = serde_json::from_str::<serde_json::Value>(&line) else {
        return line;
    };
    let omit = |message: &mut serde_json::Value| {
        message.get("method").is_none()
            && message
                .get_mut("error")
                .and_then(serde_json::Value::as_object_mut)
                .is_some_and(|error| {
                    if error.get("data").is_some_and(serde_json::Value::is_null) {
                        error.remove("data");
                        true
                    } else {
                        false
                    }
                })
    };
    let changed = match &mut message {
        serde_json::Value::Object(_) => omit(&mut message),
        serde_json::Value::Array(batch) => batch.iter_mut().fold(false, |acc, m| omit(m) || acc),
        _ => false,
    };
    if changed {
        serde_json::to_string(&message).unwrap_or(line)
    } else {
        line
    }
}

pub(in crate::manager) fn has_null_error_data(line: &str) -> Option<bool> {
    use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};

    struct Message(bool);
    struct ErrorData(bool);

    impl<'de> Deserialize<'de> for Message {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Message;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("any JSON value")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Message, A::Error> {
                    let mut has_method = false;
                    let mut null_data = false;
                    while let Some(key) = map.next_key::<&str>()? {
                        match key {
                            "method" => {
                                map.next_value::<IgnoredAny>()?;
                                has_method = true;
                            }
                            "error" => null_data = map.next_value::<ErrorData>()?.0,
                            _ => {
                                map.next_value::<IgnoredAny>()?;
                            }
                        }
                    }
                    Ok(Message(!has_method && null_data))
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Message, A::Error> {
                    let mut any = false;
                    while let Some(Message(hit)) = seq.next_element()? {
                        any |= hit;
                    }
                    Ok(Message(any))
                }
                fn visit_bool<E>(self, _: bool) -> Result<Message, E> {
                    Ok(Message(false))
                }
                fn visit_i64<E>(self, _: i64) -> Result<Message, E> {
                    Ok(Message(false))
                }
                fn visit_u64<E>(self, _: u64) -> Result<Message, E> {
                    Ok(Message(false))
                }
                fn visit_f64<E>(self, _: f64) -> Result<Message, E> {
                    Ok(Message(false))
                }
                fn visit_str<E>(self, _: &str) -> Result<Message, E> {
                    Ok(Message(false))
                }
                fn visit_unit<E>(self) -> Result<Message, E> {
                    Ok(Message(false))
                }
            }
            d.deserialize_any(V)
        }
    }

    impl<'de> Deserialize<'de> for ErrorData {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = ErrorData;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("any JSON value")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<ErrorData, A::Error> {
                    let mut null_data = false;
                    while let Some(key) = map.next_key::<&str>()? {
                        if key == "data" {
                            null_data = map.next_value::<Option<IgnoredAny>>()?.is_none();
                        } else {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                    Ok(ErrorData(null_data))
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<ErrorData, A::Error> {
                    while seq.next_element::<IgnoredAny>()?.is_some() {}
                    Ok(ErrorData(false))
                }
                fn visit_bool<E>(self, _: bool) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
                fn visit_i64<E>(self, _: i64) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
                fn visit_u64<E>(self, _: u64) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
                fn visit_f64<E>(self, _: f64) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
                fn visit_str<E>(self, _: &str) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
                fn visit_unit<E>(self) -> Result<ErrorData, E> {
                    Ok(ErrorData(false))
                }
            }
            d.deserialize_any(V)
        }
    }

    serde_json::from_str::<Message>(line).ok().map(|m| m.0)
}

/// Sanitize `usage_update` JSON payloads where an agent emitted `null` for
/// non-optional numeric fields (`used`, `size`, or `cost.amount` / `cost.currency`).
pub(crate) fn fix_usage_update_nulls(val: &mut serde_json::Value) -> bool {
    let Some(obj) = val.as_object_mut() else {
        return false;
    };
    if obj.get("sessionUpdate").and_then(|v| v.as_str()) != Some("usage_update") {
        return false;
    }
    let mut changed = false;
    for key in ["used", "size"] {
        if obj.get(key).is_some_and(|v| v.is_null()) {
            obj.insert(key.to_string(), serde_json::json!(0));
            changed = true;
        }
    }
    if let Some(cost) = obj.get("cost")
        && let Some(cost_obj) = cost.as_object()
        && (cost_obj.get("amount").is_none_or(|v| v.is_null())
            || cost_obj.get("currency").is_none_or(|v| v.is_null()))
    {
        obj.remove("cost");
        changed = true;
    }
    changed
}

pub(crate) const AIR_SESSION_UPDATE_METHOD: &str = "_air/session_update";
pub(crate) const GROK_WORKFLOW_UPDATED_METHOD: &str = "_x.ai/workflow_updated";

pub(crate) fn rewrite_air_or_vendor_notification(val: &mut serde_json::Value) -> bool {
    let Some(obj) = val.as_object_mut() else {
        return false;
    };
    if obj.get("id").is_some() {
        return false;
    }
    let Some(method) = obj.get("method").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match method {
        "session/workflow_updated" => {
            obj.insert(
                "method".to_string(),
                serde_json::Value::String(GROK_WORKFLOW_UPDATED_METHOD.to_string()),
            );
            true
        }
        "session/update" => {
            let tag = obj
                .get("params")
                .and_then(|params| params.get("update"))
                .and_then(|update| {
                    update
                        .get("sessionUpdate")
                        .or_else(|| update.get("session_update"))
                })
                .and_then(serde_json::Value::as_str);
            if matches!(
                tag,
                Some(
                    "async_task_spawned"
                        | "async_task_progress"
                        | "async_task_state_update"
                        | "prompt_suggestion_update"
                )
            ) {
                obj.insert(
                    "method".to_string(),
                    serde_json::Value::String(AIR_SESSION_UPDATE_METHOD.to_string()),
                );
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

pub(crate) fn sanitize_incoming_jsonrpc_line(line: String) -> String {
    let line = omit_null_error_data(line);
    if notification_has_null_session_id(&line) {
        return String::new();
    }
    let needs_usage_fix = line.contains("null") && line.contains("usage_update");
    let needs_air_rewrite = line.contains("async_task_")
        || line.contains("prompt_suggestion_update")
        || line.contains("session/workflow_updated");
    if !needs_usage_fix && !needs_air_rewrite {
        return line;
    }
    let Ok(mut message) = serde_json::from_str::<serde_json::Value>(&line) else {
        return line;
    };
    let mut changed = rewrite_air_or_vendor_notification(&mut message);
    if needs_usage_fix {
        changed |= fix_usage_update_nulls(&mut message);
        if let Some(params) = message.get_mut("params") {
            changed |= fix_usage_update_nulls(params);
            if let Some(update) = params.get_mut("update") {
                changed |= fix_usage_update_nulls(update);
            }
        }
    }
    if changed {
        serde_json::to_string(&message).unwrap_or(line)
    } else {
        line
    }
}

/// Grok 1.0.40+ narrates `session/new` on `_x.ai/session/setup` with
/// `"sessionId": null` before the id exists. A notification with a null id
/// is never a valid session-bound frame; drop it so the runtime neither
/// parks it nor fails to parse the null as a string.
pub(in crate::manager) fn notification_has_null_session_id(line: &str) -> bool {
    if !line.contains("\"sessionId\"") || !line.contains("null") {
        return false;
    }
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    if message.get("method").is_none() || message.get("id").is_some() {
        return false;
    }
    message
        .get("params")
        .and_then(|params| params.get("sessionId"))
        .is_some_and(serde_json::Value::is_null)
}
