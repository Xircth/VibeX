use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Decode Host/Application command arguments as the frontend actually sends them.
///
/// Product calls wrap some payloads in `request` or `payload`, and some mix a
/// sibling id with a nested `payload` object. Try the value as-is, then unwrap,
/// then merge, so a single Host DTO can serve every caller.
pub fn decode_command_args<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    for key in ["request", "payload"] {
        if let Some(inner) = value.get(key).cloned().filter(|inner| inner.is_object()) {
            if let Ok(parsed) = serde_json::from_value::<T>(inner) {
                return Ok(parsed);
            }
            if let Some(merged) = merge_nested_object(&value, key)
                && let Ok(parsed) = serde_json::from_value::<T>(merged)
            {
                return Ok(parsed);
            }
        }
    }
    serde_json::from_value(value).map_err(|error| error.to_string())
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
        conversation_id: String,
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
}
