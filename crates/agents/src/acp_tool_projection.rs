//! Tool-call projection shared by ACP JSONL history.
//!
//! Ported from Codeg `acp/connection.rs` at `2e657fac` (`serialize_tool_call_content`,
//! `synthesize_edit_input_from_diffs`, `extract_tool_call_images`, `json_value_to_text`).

use std::collections::HashMap;

use agent_client_protocol::schema::v1::{ContentBlock as WireBlock, ToolCallContent};
use serde_json::{Map, Value};

use crate::conversation::ImageData;

fn air_meta_value<'a>(meta: Option<&'a Map<String, Value>>, key: &str) -> Option<&'a Value> {
    meta?.get("jetbrains")?.get("air")?.get(key)
}

/// Serialize tool-call `content` blocks into a single human-readable string.
///
/// `include_diffs = false` skips `Diff` blocks. Used when the edit has been
/// hoisted into a synthesized canonical `raw_input` (see
/// `synthesize_edit_input_from_diffs`): without this the same edit ships twice
/// (doubling the event) and the hunkless full-file `--- /+++` blob stays in the
/// tool `output`, where `extractEditLineChangeStats` mis-counts it as full-file
/// +/- totals in the card header even though the body shows the compact diff.
pub(crate) fn serialize_tool_call_content(
    content: &[ToolCallContent],
    include_diffs: bool,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for item in content {
        match item {
            ToolCallContent::Content(c) => {
                if let WireBlock::Text(text) = &c.content {
                    parts.push(text.text.clone());
                }
            }
            // A codex AIR patch block's text fields are placeholders, never
            // file text (see `diff_block_payload`); its change reaches the
            // card through the synthesized input or not at all.
            ToolCallContent::Diff(diff)
                if include_diffs
                    && air_meta_value(diff.meta.as_ref(), "diffPatch")
                        .is_none() =>
            {
                let path = diff.path.display();
                let mut diff_text = format!("--- {path}\n+++ {path}\n");
                if let Some(old) = &diff.old_text {
                    for line in old.lines() {
                        diff_text.push_str(&format!("-{line}\n"));
                    }
                }
                for line in diff.new_text.lines() {
                    diff_text.push_str(&format!("+{line}\n"));
                }
                parts.push(diff_text);
            }
            ToolCallContent::Terminal(t) => {
                parts.push(format!("[Terminal: {}]", t.terminal_id));
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// Synthesize a canonical edit `raw_input` from `ToolCallContent::Diff` block(s).
///
/// codex-acp reports file edits as ACP `Diff` content blocks and leaves
/// `raw_input` empty — the edit lives only in `content`, and the ACP `title` is
/// the diff header `--- <path>`. With no `raw_input` the frontend classifier
/// (`inferLiveToolName`) falls back to `normalizeToolName(title)`, which returns
/// unrecognized strings verbatim, so the tool call renders as a generic tool
/// literally *named* `--- <path>` (wrench icon, raw header as the title) instead
/// of an edit card. The historical path is unaffected because the JSONL parser
/// stores codex's native `*** Begin Patch` text.
///
/// Reconstructing from the already-serialized `--- /+++` string would be lossy
/// (content lines beginning with `-`/`+`/`---`/`+++`, the old/new boundary,
/// CRLF). Here the structured `Diff` is still intact, so map it losslessly:
/// - one path, one block  -> `{"file_path","old_string","new_string"}`
/// - several paths        -> `{"changes":{"<path>":{"old_text","new_text"},…}}`
/// - a Git patch (codex's AIR `diffPatch`, see [`diff_block_payload`]) ->
///   `{"changes":{"<path>":{"diff":"<patch>"}}}`, plus `file_path` when it is
///   the only path so the card keeps its "Edit <file>" title.
///
/// All shapes classify as `"edit"` (`inferFromInput`) and render through the
/// existing `EditToolInput` / `EditChangesToolInput` pipeline — a ready-made
/// `diff` verbatim, old/new text through `generateUnifiedDiff` (a real hunk
/// diff, minimal even for full-file old/new). Returns `None` when `content`
/// carries no usable `Diff`, so callers only fall back to it when the agent
/// supplied no `raw_input` of its own.
///
/// **Several blocks for ONE path** are one edit, and are combined rather than
/// keyed over each other. Through codex-acp 1.13.x each file came as a single
/// block holding the whole old and new file; 2.0.0 sends one block per hunk
/// (`FileChangeReporter`: "`oldText` and `newText` hold the changed lines and
/// the context lines of the hunk, not the whole file") whenever it sends no
/// patch, and claude has always sent one per `structuredPatch` hunk after a
/// multi-site Edit. Keyed by path, every hunk but the last used to vanish. The
/// hunks' texts are joined with a [`HUNK_SEPARATOR`] line common to both sides,
/// so the frontend's line diff shows each hunk with the elision marked between
/// them. A hunk carries no line numbers, so none are invented.
pub(crate) fn synthesize_edit_input_from_diffs(content: &[ToolCallContent]) -> Option<String> {
    // Keep `old_text` as `Option`: ACP reports `None` for a newly created file
    // (`Diff.old_text` semantics). That distinction is the whole point of this
    // function's fix — collapsing `None` to `""` and emitting an edit shape
    // makes the frontend build a `--- a/<path>` diff, which `isAddedFileDiff`
    // does NOT match, so a freshly created file mis-renders as a modification
    // (the historical apply_patch `*** Add File:` path classifies it correctly).
    let mut order: Vec<String> = Vec::new();
    let mut per_path: HashMap<String, Vec<DiffBlockPayload>> = HashMap::new();
    for item in content {
        let ToolCallContent::Diff(diff) = item else {
            continue;
        };
        // A patch block that does not validate has no usable text either (its
        // `oldText`/`newText` are placeholders), so it is shown as nothing
        // rather than as an empty file.
        let Some(payload) = diff_block_payload(diff) else {
            continue;
        };
        let path = diff.path.display().to_string();
        if !per_path.contains_key(&path) {
            order.push(path.clone());
        }
        per_path.entry(path).or_default().push(payload);
    }

    match order.as_slice() {
        [] => None,
        [path] => {
            let blocks = per_path.remove(path)?;
            if let Some(patch) = joined_patches(&blocks) {
                return Some(
                    serde_json::json!({
                        "file_path": path,
                        "changes": { path: { "diff": patch } },
                    })
                    .to_string(),
                );
            }
            match combined_text_blocks(&blocks)? {
                // New file (old_text absent) → write shape. `inferFromInput`
                // classifies `{file_path, content}` as `write`, whose diff
                // builder emits the `--- /dev/null` header `isAddedFileDiff`
                // keys on → renders as a new file, matching the
                // reloaded-from-DB path.
                (None, new) => Some(
                    serde_json::json!({
                        "file_path": path,
                        "content": new,
                    })
                    .to_string(),
                ),
                // Edit → canonical `{old_string,new_string}` for the frontend's
                // `generateUnifiedDiff` (a real hunk diff, minimal even for
                // full-file old/new).
                (Some(old), new) => Some(
                    serde_json::json!({
                        "file_path": path,
                        "old_string": old,
                        "new_string": new,
                    })
                    .to_string(),
                ),
            }
        }
        many => {
            let mut changes = serde_json::Map::new();
            for path in many {
                let Some(blocks) = per_path.remove(path) else {
                    continue;
                };
                // Per entry, mirror the single-path split: a patch verbatim, a
                // new file as a ready-made creation diff
                // (`buildChunkFromEditChange` returns it verbatim →
                // `--- /dev/null` → new file), an edit as old/new text for the
                // frontend to diff.
                let entry = if let Some(patch) = joined_patches(&blocks) {
                    serde_json::json!({ "diff": patch })
                } else {
                    match combined_text_blocks(&blocks) {
                        Some((None, new)) => {
                            serde_json::json!({ "diff": build_new_file_diff(path, &new) })
                        }
                        Some((Some(old), new)) => {
                            serde_json::json!({ "old_text": old, "new_text": new })
                        }
                        None => continue,
                    }
                };
                changes.insert(path.clone(), entry);
            }
            (!changes.is_empty())
                .then(|| serde_json::json!({ "changes": changes }).to_string())
        }
    }
}

/// The line placed between two hunks of the same file when their texts are
/// combined (see [`synthesize_edit_input_from_diffs`]). It is on both sides, so
/// the line diff treats it as context — an elision mark, not a change.
const HUNK_SEPARATOR: &str = "⋯";

/// What one ACP `Diff` block says, once codex's AIR `diffPatch` is accounted
/// for.
enum DiffBlockPayload {
    /// The standard `oldText` / `newText` pair.
    Text { old: Option<String>, new: String },
    /// A validated Git patch for the block's file, headers rewritten to the
    /// absolute path (see [`normalize_git_patch`]).
    Patch(String),
}

/// Read one `Diff` block. `None` for a block that declares a patch codeg cannot
/// use: codex-acp 2.0.0's contract is that such a block's `oldText: null` /
/// `newText: ""` are "compatibility placeholders … not file snapshots", and a
/// receiver that rejects the patch "must show the change as unavailable" — not
/// render the placeholders as an emptied file.
///
/// codeg declares `diffPatch` to codex only (`build_client_capabilities`), and
/// validates it the way the contract asks: `{version: 1, format: "git_patch",
/// text}` with at least one `@@` hunk.
fn diff_block_payload(diff: &agent_client_protocol::schema::v1::Diff) -> Option<DiffBlockPayload> {
    let Some(patch) =
        air_meta_value(diff.meta.as_ref(), "diffPatch")
    else {
        return Some(DiffBlockPayload::Text {
            old: diff.old_text.clone(),
            new: diff.new_text.clone(),
        });
    };
    let valid = patch.get("version").and_then(serde_json::Value::as_i64) == Some(1)
        && patch.get("format").and_then(serde_json::Value::as_str) == Some("git_patch");
    let text = patch
        .get("text")
        .and_then(serde_json::Value::as_str)
        .filter(|_| valid)?;
    normalize_git_patch(text, &diff.path.display().to_string()).map(DiffBlockPayload::Patch)
}

/// Every patch among `blocks`, joined, or `None` when there is none.
fn joined_patches(blocks: &[DiffBlockPayload]) -> Option<String> {
    let patches: Vec<&str> = blocks
        .iter()
        .filter_map(|block| match block {
            DiffBlockPayload::Patch(patch) => Some(patch.as_str()),
            DiffBlockPayload::Text { .. } => None,
        })
        .collect();
    (!patches.is_empty()).then(|| patches.join("\n"))
}

/// The text blocks of one path combined into a single `(old, new)` pair —
/// `None` when there are none. One block passes through unchanged (a `None`
/// old text keeps meaning "new file"); several are hunks of one edit, joined
/// with [`HUNK_SEPARATOR`] (a missing old text reads as empty there).
fn combined_text_blocks(blocks: &[DiffBlockPayload]) -> Option<(Option<String>, String)> {
    let texts: Vec<(&Option<String>, &String)> = blocks
        .iter()
        .filter_map(|block| match block {
            DiffBlockPayload::Text { old, new } => Some((old, new)),
            DiffBlockPayload::Patch(_) => None,
        })
        .collect();
    match texts.as_slice() {
        [] => None,
        [(old, new)] => Some(((*old).clone(), (*new).clone())),
        many => {
            let join = |parts: Vec<&str>| {
                let mut out = String::new();
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        if !out.ends_with('\n') {
                            out.push('\n');
                        }
                        out.push_str(HUNK_SEPARATOR);
                        out.push('\n');
                    }
                    out.push_str(part);
                }
                out
            };
            let old = join(
                many.iter()
                    .map(|(old, _)| old.as_deref().unwrap_or(""))
                    .collect(),
            );
            let new = join(many.iter().map(|(_, new)| new.as_str()).collect());
            Some((Some(old), new))
        }
    }
}

/// Rewrite a codex Git patch's file headers onto the absolute path, or `None`
/// when the text has no hunk (the contract: "at least one `@@` hunk").
///
/// codex names both sides as the absolute path WITHOUT its leading slash under
/// `a/` / `b/` (`a/workspace/src/app.ts`, Windows `a/C:/work/App.ts`), which the
/// diff preview's `normalizePath` would turn into a relative path — and the
/// preview's file link would then point nowhere. codeg's own diffs name the
/// absolute path (`generateUnifiedDiff`: `--- a/${path}`), so the headers are
/// rewritten to that: `+++` from the block's own `path` (the new side, a
/// rename's target), `---` from the `rename from` line on a rename and from the
/// block path otherwise; `/dev/null` sides stay. The `diff --git` line is
/// dropped — its paths are ambiguous with spaces, and the `---`/`+++` lines
/// that follow carry everything the preview reads from it. Only lines before
/// the first `@@` are headers; after it, a line starting `--- ` is content.
fn normalize_git_patch(patch: &str, block_path: &str) -> Option<String> {
    // Split on `\n` only: the contract keeps the provider's bytes, a `\r`
    // included ("The patch keeps the provider bytes, including a carriage
    // return"), and `str::lines` would strip it off every CRLF hunk line.
    let lines: Vec<&str> = patch.split('\n').collect();
    let first_hunk = lines.iter().position(|line| line.starts_with("@@"))?;
    let (headers, body) = lines.split_at(first_hunk);
    let header = |line: &&str| line.trim_end_matches('\r').to_string();
    let headers: Vec<String> = headers.iter().map(header).collect();
    let renamed_from = headers
        .iter()
        .find_map(|line| line.strip_prefix("rename from "))
        .map(patch_header_path);
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for line in &headers {
        if line.starts_with("diff --git ") || line.starts_with("index ") {
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            if rest.trim_end() == "/dev/null" {
                out.push("--- /dev/null".to_string());
            } else {
                let old = renamed_from.clone().unwrap_or_else(|| block_path.to_string());
                out.push(format!("--- a/{old}"));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            if rest.trim_end() == "/dev/null" {
                out.push("+++ /dev/null".to_string());
            } else {
                out.push(format!("+++ b/{block_path}"));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("rename from ") {
            out.push(format!("rename from {}", patch_header_path(rest)));
            continue;
        }
        if let Some(rest) = line.strip_prefix("rename to ") {
            out.push(format!("rename to {}", patch_header_path(rest)));
            continue;
        }
        out.push(line.clone());
    }
    // The body verbatim — including the empty segment after a final `\n`, so
    // the join below restores it.
    out.extend(body.iter().map(|line| (*line).to_string()));
    Some(out.join("\n"))
}

/// A path as a codex patch header writes it (`a/`/`b/`-prefixed or bare,
/// possibly C-quoted, possibly tab-terminated), back as the absolute path it
/// was made from: the leading slash restored, a Windows drive path as is.
fn patch_header_path(raw: &str) -> String {
    let raw = raw.trim_end_matches(['\t', '\r']);
    let unquoted = match raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        Some(inner) => c_unquote(inner),
        None => raw.to_string(),
    };
    let bare = unquoted
        .strip_prefix("a/")
        .or_else(|| unquoted.strip_prefix("b/"))
        .unwrap_or(&unquoted);
    let is_drive = bare.len() >= 3
        && bare.as_bytes()[0].is_ascii_alphabetic()
        && bare.as_bytes()[1] == b':'
        && bare.as_bytes()[2] == b'/';
    if is_drive || bare.starts_with('/') {
        bare.to_string()
    } else {
        format!("/{bare}")
    }
}

/// Undo Git's C-style path quoting (what codex applies to a path holding a
/// double quote, a backslash or a control character): `\"`, `\\`, the named
/// control escapes, and `\NNN` octal bytes. An escape it does not know is kept
/// as written rather than guessed at.
fn c_unquote(inner: &str) -> String {
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        let named = match next {
            b'"' => Some(b'"'),
            b'\\' => Some(b'\\'),
            b'a' => Some(0x07),
            b'b' => Some(0x08),
            b'f' => Some(0x0c),
            b'n' => Some(b'\n'),
            b'r' => Some(b'\r'),
            b't' => Some(b'\t'),
            b'v' => Some(0x0b),
            _ => None,
        };
        if let Some(byte) = named {
            out.push(byte);
            i += 2;
            continue;
        }
        let octal = bytes.get(i + 1..i + 4).filter(|digits| {
            digits.iter().all(|d| (b'0'..=b'7').contains(d))
        });
        if let Some(digits) = octal {
            let value = digits
                .iter()
                .fold(0u32, |acc, d| acc * 8 + u32::from(d - b'0'));
            if let Ok(byte) = u8::try_from(value) {
                out.push(byte);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Build a minimal unified diff for a newly created file: the `--- /dev/null`
/// header the frontend's `isAddedFileDiff` keys on, then every line of
/// `new_text` as an addition. Byte-for-byte identical to the frontend `write`
/// op's diff builder (`session-files.ts`), so a multi-file batch's new-file
/// entries render exactly like a single-file creation.
fn build_new_file_diff(path: &str, new_text: &str) -> String {
    // `split('\n')` (not `lines()`) mirrors the frontend `content.split("\n")`:
    // it keeps the trailing empty segment from a final newline, so the `+N`
    // count and the trailing `+` addition line match exactly.
    let lines: Vec<&str> = new_text.split('\n').collect();
    let mut out = format!(
        "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@",
        lines.len()
    );
    for line in lines {
        out.push('\n');
        out.push('+');
        out.push_str(line);
    }
    out
}

/// Extract `ContentBlock::Image` payloads from a `ToolCallContent` slice.
/// Returns `None` when no images are present so the upstream `images` field
/// on `AcpEvent::ToolCall(Update)` stays absent for non-image tool calls
/// (preserves replace-on-update semantics: an absent field means "keep
/// prior", a `Some(vec)` replaces).
pub(crate) fn extract_tool_call_images(content: &[ToolCallContent]) -> Option<Vec<ImageData>> {
    let mut imgs: Vec<ImageData> = Vec::new();
    for item in content {
        if let ToolCallContent::Content(c) = item {
            if let WireBlock::Image(img) = &c.content {
                imgs.push(ImageData {
                    data: img.data.clone(),
                    mime_type: img.mime_type.clone(),
                    uri: img.uri.clone(),
                    width: None,
                    height: None,
                });
            }
        }
    }
    if imgs.is_empty() {
        None
    } else {
        Some(imgs)
    }
}


pub(crate) fn json_value_to_text(val: &Option<serde_json::Value>) -> Option<String> {
    match val {
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        Some(value) if !value.is_null() => Some(value.to_string()),
        _ => None,
    }
}
