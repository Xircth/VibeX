use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Decode Host/Application command arguments as the frontend actually sends them.
///
/// Product calls wrap some payloads in `request` or `payload`, and some mix a
/// sibling id with a nested `payload` object. Try unwrap, then merge, then the
/// value as-is, so a single Host DTO can serve every caller.
///
/// Merge is skipped when the nested object itself contains the same wrapper
/// key. Otherwise `{ scratchType, id, payload: { payload: body } }` would
/// flatten into `{ scratchType, id, payload: body }` and drop the inner
/// payload wrapper that typed bodies such as `UpdateScratch` require.
pub fn decode_command_args<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    let mut wrapper_error = None;
    for key in ["request", "payload"] {
        let Some(inner) = value.get(key).cloned().filter(Value::is_object) else {
            continue;
        };
        let nested_is_wrapper = inner
            .as_object()
            .is_some_and(|nested| nested.contains_key(key));
        match serde_json::from_value::<T>(inner) {
            Ok(parsed) => return Ok(parsed),
            Err(error) => wrapper_error = Some(error.to_string()),
        }
        if nested_is_wrapper {
            continue;
        }
        if let Some(merged) = merge_nested_object(&value, key) {
            match serde_json::from_value::<T>(merged) {
                Ok(parsed) => return Ok(parsed),
                Err(error) => wrapper_error = Some(error.to_string()),
            }
        }
    }
    match serde_json::from_value(value) {
        Ok(parsed) => Ok(parsed),
        Err(error) => Err(wrapper_error.unwrap_or_else(|| error.to_string())),
    }
}

fn merge_nested_object(value: &Value, nested_key: &str) -> Option<Value> {
    let outer = value.as_object()?;
    let nested = outer.get(nested_key)?.as_object()?;
    let mut merged = Map::new();
    for (key, child) in outer {
        if key != nested_key {
            merged.insert(key.clone(), child.clone());
        }
    }
    for (key, child) in nested {
        merged.insert(key.clone(), child.clone());
    }
    Some(Value::Object(merged))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Flat {
        #[serde(alias = "sessionId", alias = "session_id", alias = "conversation_id")]
        conversation_id: String,
        #[serde(alias = "after_sequence")]
        after_sequence: i64,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct WorkspaceUpdate {
        workspace_id: String,
        archived: Option<bool>,
        name: Option<String>,
    }

    #[test]
    fn accepts_flat_camel_case() {
        let parsed: Flat = decode_command_args(serde_json::json!({
            "conversationId": "abc",
            "afterSequence": 4
        }))
        .expect("flat");
        assert_eq!(parsed.conversation_id, "abc");
        assert_eq!(parsed.after_sequence, 4);
    }

    #[test]
    fn unwraps_request_wrapper() {
        let parsed: Flat = decode_command_args(serde_json::json!({
            "request": {
                "conversationId": "abc",
                "afterSequence": 4,
                "limit": 100
            }
        }))
        .expect("request");
        assert_eq!(parsed.conversation_id, "abc");
    }

    #[test]
    fn merges_sibling_id_with_payload() {
        let parsed: WorkspaceUpdate = decode_command_args(serde_json::json!({
            "workspaceId": "ws-1",
            "payload": { "archived": true, "name": "Done" }
        }))
        .expect("merged");
        assert_eq!(parsed.workspace_id, "ws-1");
        assert_eq!(parsed.archived, Some(true));
        assert_eq!(parsed.name.as_deref(), Some("Done"));
    }

    #[test]
    fn accepts_session_id_as_conversation_id() {
        let parsed: Flat = decode_command_args(serde_json::json!({
            "sessionId": "abc",
            "afterSequence": 4
        }))
        .expect("sessionId");
        assert_eq!(parsed.conversation_id, "abc");
    }

    #[test]
    fn request_wrapper_keeps_the_inner_error() {
        let error = decode_command_args::<Flat>(serde_json::json!({
            "request": { "conversationId": "abc" }
        }))
        .expect_err("inner type error");
        assert!(
            error.contains("afterSequence") || error.contains("after_sequence"),
            "masked as {error}"
        );
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct ScratchLikeArgs {
        scratch_type: String,
        id: String,
        #[serde(default)]
        payload: Option<Value>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct UpdateScratchLike {
        payload: Value,
        #[serde(default)]
        expected_revision: Option<u64>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct PayloadWrapper<T> {
        payload: T,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct CreateSessionLike {
        project_id: String,
        #[serde(default)]
        create_workspace: Option<bool>,
    }

    #[test]
    fn keeps_nested_payload_wrapper_for_typed_body() {
        let args: ScratchLikeArgs = decode_command_args(serde_json::json!({
            "scratchType": "DRAFT_FOLLOW_UP",
            "id": "11111111-1111-1111-1111-111111111111",
            "payload": {
                "payload": {
                    "type": "DRAFT_FOLLOW_UP",
                    "data": { "message": "" }
                }
            }
        }))
        .expect("scratch args");

        let update: UpdateScratchLike = decode_command_args(
            args.payload
                .clone()
                .expect("frontend sends UpdateScratch as payload"),
        )
        .expect("update scratch body");
        assert_eq!(update.payload["type"], "DRAFT_FOLLOW_UP");
        assert_eq!(update.payload["data"]["message"], "");
    }

    #[test]
    fn payload_wrapper_dto_accepts_host_create_session_shape() {
        let parsed: PayloadWrapper<CreateSessionLike> = decode_command_args(serde_json::json!({
            "payload": {
                "projectId": "11111111-1111-1111-1111-111111111111",
                "createWorkspace": true
            }
        }))
        .expect("payload wrapper");
        assert_eq!(
            parsed.payload.project_id,
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(parsed.payload.create_workspace, Some(true));
    }

    #[test]
    fn unwraps_payload_when_inner_is_the_dto() {
        let parsed: CreateSessionLike = decode_command_args(serde_json::json!({
            "payload": {
                "projectId": "11111111-1111-1111-1111-111111111111",
                "createWorkspace": false
            }
        }))
        .expect("unwrapped create session");
        assert_eq!(parsed.project_id, "11111111-1111-1111-1111-111111111111");
        assert_eq!(parsed.create_workspace, Some(false));
    }
}
