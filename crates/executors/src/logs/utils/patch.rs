use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use json_patch::Patch;
use serde::{Deserialize, Serialize};
use serde_json::{from_value, json, to_value};
use ts_rs::TS;
use workspace_utils::{diff::Diff, msg_store::MsgStore};

use crate::{
    executors::SlashCommandDescription,
    logs::{NormalizedEntry, utils::EntryIndexProvider},
};

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
enum PatchOperation {
    Add,
    Replace,
    Remove,
}

#[allow(clippy::large_enum_variant)]
#[derive(Serialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "type", content = "content")]
pub enum PatchType {
    NormalizedEntry(NormalizedEntry),
    Stdout(String),
    Stderr(String),
    Diff(Diff),
}

#[derive(Serialize)]
struct PatchEntry {
    op: PatchOperation,
    path: String,
    value: PatchType,
}

pub fn escape_json_pointer_segment(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

pub struct ConversationPatch;

impl ConversationPatch {
    pub fn add_normalized_entry(entry_index: usize, entry: NormalizedEntry) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Add,
            path: format!("/entries/{entry_index}"),
            value: PatchType::NormalizedEntry(entry),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn add_stdout(entry_index: usize, entry: String) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Add,
            path: format!("/entries/{entry_index}"),
            value: PatchType::Stdout(entry),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn add_stderr(entry_index: usize, entry: String) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Add,
            path: format!("/entries/{entry_index}"),
            value: PatchType::Stderr(entry),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn add_diff(entry_index: String, diff: Diff) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Add,
            path: format!("/entries/{entry_index}"),
            value: PatchType::Diff(diff),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn replace_diff(entry_index: String, diff: Diff) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Replace,
            path: format!("/entries/{entry_index}"),
            value: PatchType::Diff(diff),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn remove_diff(entry_index: String) -> Patch {
        from_value(json!([{
            "op": PatchOperation::Remove,
            "path": format!("/entries/{entry_index}"),
        }]))
        .unwrap()
    }

    pub fn add_repo_diff(repo_key: &str, file_path: &str, diff: Diff) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Add,
            path: format!(
                "/entries/{}/{}",
                escape_json_pointer_segment(repo_key),
                escape_json_pointer_segment(file_path)
            ),
            value: PatchType::Diff(diff),
        };
        from_value(json!([patch_entry])).unwrap()
    }

    pub fn remove_repo_diff(repo_key: &str, file_path: &str) -> Patch {
        from_value(json!([{
            "op": PatchOperation::Remove,
            "path": format!(
                "/entries/{}/{}",
                escape_json_pointer_segment(repo_key),
                escape_json_pointer_segment(file_path)
            ),
        }]))
        .unwrap()
    }

    pub fn replace_repo_diffs(repo_key: &str, diffs: HashMap<String, Diff>) -> Patch {
        let entries: HashMap<String, PatchType> = diffs
            .into_iter()
            .map(|(path, diff)| (path, PatchType::Diff(diff)))
            .collect();
        from_value(json!([{
            "op": "replace",
            "path": format!("/entries/{}", escape_json_pointer_segment(repo_key)),
            "value": entries,
        }]))
        .unwrap()
    }

    pub fn replace(entry_index: usize, entry: NormalizedEntry) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOperation::Replace,
            path: format!("/entries/{entry_index}"),
            value: PatchType::NormalizedEntry(entry),
        };

        from_value(json!([patch_entry])).unwrap()
    }

    pub fn remove(entry_index: usize) -> Patch {
        from_value(json!([{
            "op": PatchOperation::Remove,
            "path": format!("/entries/{entry_index}"),
        }]))
        .unwrap()
    }
}

pub fn extract_normalized_entry_from_patch(patch: &Patch) -> Option<(usize, NormalizedEntry)> {
    let value = to_value(patch).ok()?;
    let ops = value.as_array()?;
    ops.iter().rev().find_map(|op| {
        let path = op.get("path")?.as_str()?;
        let entry_index = path.strip_prefix("/entries/")?.parse::<usize>().ok()?;

        let value = op.get("value")?;
        (value.get("type")?.as_str()? == "NORMALIZED_ENTRY")
            .then(|| value.get("content"))
            .flatten()
            .and_then(|content| from_value::<NormalizedEntry>(content.clone()).ok())
            .map(|entry| (entry_index, entry))
    })
}

pub fn upsert_normalized_entry(
    msg_store: &Arc<MsgStore>,
    index: usize,
    normalized_entry: NormalizedEntry,
    is_new: bool,
) {
    if is_new {
        msg_store.push_patch(ConversationPatch::add_normalized_entry(
            index,
            normalized_entry,
        ));
    } else {
        msg_store.push_patch(ConversationPatch::replace(index, normalized_entry));
    }
}

pub fn add_normalized_entry(
    msg_store: &Arc<MsgStore>,
    index_provider: &EntryIndexProvider,
    normalized_entry: NormalizedEntry,
) -> usize {
    let index = index_provider.next();
    upsert_normalized_entry(msg_store, index, normalized_entry, true);
    index
}

pub fn replace_normalized_entry(
    msg_store: &Arc<MsgStore>,
    index: usize,
    normalized_entry: NormalizedEntry,
) {
    upsert_normalized_entry(msg_store, index, normalized_entry, false);
}

pub fn patch_entry_path(patch: &Patch) -> Option<String> {
    patch.0.first().map(|op| op.path().to_string())
}

pub fn is_add_or_replace(patch: &Patch) -> bool {
    use json_patch::PatchOperation::*;
    patch.0.iter().all(|op| matches!(op, Add(..) | Replace(..)))
}

pub fn fix_patch_ops(mut patch: Patch, sent_paths: &mut HashSet<String>) -> Patch {
    for op in &mut patch.0 {
        let path_sent = sent_paths.contains(op.path().as_str());
        match op {
            json_patch::PatchOperation::Add(add) if path_sent => {
                *op = json_patch::PatchOperation::Replace(json_patch::ReplaceOperation {
                    path: add.path.clone(),
                    value: add.value.clone(),
                });
            }
            json_patch::PatchOperation::Replace(replace) if !path_sent => {
                *op = json_patch::PatchOperation::Add(json_patch::AddOperation {
                    path: replace.path.clone(),
                    value: replace.value.clone(),
                });
            }
            _ => {}
        };
        if !path_sent {
            sent_paths.insert(op.path().to_string());
        }
    }
    patch
}

pub fn slash_commands(
    commands: Vec<SlashCommandDescription>,
    discovering: bool,
    error: Option<String>,
) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/commands", "value": commands},
        {"op": "replace", "path": "/discovering", "value": discovering},
        {"op": "replace", "path": "/error", "value": error},
    ]))
    .unwrap_or_default()
}

pub fn update_slash_commands(
    slash_commands: Vec<crate::executors::SlashCommandDescription>,
) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/slash_commands", "value": slash_commands},
    ]))
    .unwrap_or_default()
}

pub fn slash_commands_loaded() -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/loading_slash_commands", "value": false},
    ]))
    .unwrap_or_default()
}

pub fn discovery_error(error: String) -> Patch {
    serde_json::from_value(json!([
        {"op": "replace", "path": "/options/error", "value": error},
        {"op": "replace", "path": "/options/loading_slash_commands", "value": false},
    ]))
    .unwrap_or_default()
}
