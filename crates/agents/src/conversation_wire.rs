use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use super::{
    ContentBlock, ConversationArtifactReference, ConversationDelegationView, ConversationErrorView,
    ConversationEventEnvelope, ConversationFeedbackRequest, ConversationFeedbackResponse,
    ConversationFileChangeSummary, ConversationPermissionView, ConversationQuestionRequest,
    ConversationQuestionResponse, ConversationSessionNotice, ConversationTerminalView,
    InternalPromptBlock, MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES, MessageTurn, TurnUsage,
};
use crate::events::{AgentAvailableCommand, AgentSessionConfigOption, AgentSessionMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationTimelineRow {
    MessageTurn {
        turn: MessageTurn,
        phase: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fork_point_status: Option<crate::ForkPointStatus>,
    },
    PermissionRequest {
        request: ConversationPermissionView,
    },
    QuestionRequest {
        request: ConversationQuestionRequest,
        /// Folded from a later `QuestionResponded` event. `None` while still pending;
        /// `Some` once answered — so a rebuilt projection no longer shows answered
        /// questions as perpetually pending.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<ConversationQuestionResponse>,
    },
    FeedbackRequest {
        request: ConversationFeedbackRequest,
        /// Folded from a later `FeedbackSubmitted` event. `None` while still pending.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<ConversationFeedbackResponse>,
    },
    TerminalSummary {
        terminal: ConversationTerminalView,
    },
    Delegation {
        delegation: ConversationDelegationView,
    },
    FileChangeSummary {
        summary: ConversationFileChangeSummary,
        /// Turn that produced this diff summary (checkpoint diff), so the
        /// timeline can anchor the card at the end of its own turn.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<Uuid>,
    },
    ArtifactRevision {
        artifact: ConversationArtifactReference,
    },
    TurnError {
        error: ConversationErrorView,
    },
    SessionNotice {
        notice: ConversationSessionNotice,
    },
}

/// A timeline row plus the incremental-projection metadata that lets the frontend
/// consume it as a dumb container (消灭双投影). `row_id` is stable per row; `revision`
/// is the sequence of the latest event that produced this row's current state
/// (monotonic per row), used for idempotent upsert/append dedup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimelineRow {
    pub row_id: String,
    pub revision: i64,
    pub row: ConversationTimelineRow,
}

/// Which streaming text field an [`ConversationRowOp::AppendText`] targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TimelineTextStream {
    Text,
    Reasoning,
}

/// One operation the frontend applies to its dumb row container. The backend is the
/// single projector; the frontend never folds events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
// `Upsert` carries a full `TimelineRow` (a large enum); `AppendText` is small. These
// ops are streamed one at a time, so the size gap costs nothing — boxing would just
// churn the wire format.
#[allow(clippy::large_enum_variant)]
pub enum ConversationRowOp {
    /// Insert or replace a whole row (new row, status change, tool-call update…).
    /// Applying it clears any accumulated live text for the row.
    Upsert { row: TimelineRow },
    /// Remove a row that no longer represents current projected state.
    Delete { row_id: String, revision: i64 },
    /// Append a streaming text chunk to a row's live-text overlay — sent per delta so
    /// long replies don't re-broadcast the full text each frame (O(n²)).
    AppendText {
        row_id: String,
        revision: i64,
        stream: TimelineTextStream,
        delta: String,
    },
    /// Replace or append the listed blocks on an existing assistant row.
    /// Does not clear the row's live text overlay.
    PatchBlocks {
        row_id: String,
        revision: i64,
        phase: String,
        blocks: Vec<ContentBlock>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        usage: Option<TurnUsage>,
    },
}

/// A batch of row ops for one conversation, emitted on the realtime channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRowOpBatch {
    pub conversation_id: Uuid,
    pub last_sequence: i64,
    /// Last sequence emitted in the immediately preceding batch for this conversation,
    /// when known by the incremental projector. Allows the frontend to distinguish
    /// skipped no-op sequences or coalesced intra-batch revisions from dropped batches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous_sequence: Option<i64>,
    /// Barrier flag emitted after turn truncation/rollback so connected clients drop
    /// stale rows and reload the authoritative snapshot window.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
    pub ops: Vec<ConversationRowOp>,
    /// Latest agent-advertised session modes carried in this batch, if any. Session
    /// control state isn't a timeline row, so it rides alongside the row ops rather
    /// than on a separate channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_modes: Option<ConversationSessionModes>,
    /// Latest agent-advertised config options carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_config_options: Option<Vec<AgentSessionConfigOption>>,
    /// Latest agent-advertised slash/skill catalog carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_commands: Option<Vec<AgentAvailableCommand>>,
    /// Latest session goal state carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_goal: Option<ConversationSessionGoal>,
    /// Latest session async tasks table carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub async_tasks: Option<Vec<crate::AsyncTaskRecord>>,
    /// Latest ephemeral prompt suggestion carried in this batch, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_suggestion: Option<ConversationPromptSuggestion>,
}

/// Agent-advertised session modes (current + available), delivered with a row-op batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSessionModes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub modes: Vec<AgentSessionMode>,
}

/// Session goal snapshot + advertised control actions, delivered with a row-op batch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationSessionGoal {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
}

/// Ephemeral Composer prompt suggestion update, delivered with a row-op batch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPromptSuggestion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// Gap-backfill result: the timeline rows whose state changed after `after_sequence`
/// (revision > after_sequence). The gap path now pulls rows, not raw events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRowPage {
    pub conversation_id: Uuid,
    pub after_sequence: i64,
    pub last_sequence: i64,
    pub rows: Vec<TimelineRow>,
}

/// Tombstone- and reset-aware incremental catch-up response for `conversation_rows_since`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRowsSincePage {
    pub conversation_id: Uuid,
    pub after_sequence: i64,
    pub last_sequence: i64,
    #[serde(default)]
    pub reset: bool,
    pub ops: Vec<ConversationRowOp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTimeline {
    pub conversation_id: Uuid,
    pub projection_version: u32,
    pub last_sequence: i64,
    pub rows: Vec<TimelineRow>,
    /// True when `rows` is a tail window, not the full projection.
    #[serde(default)]
    pub truncated_from_start: bool,
    /// Opaque Base64URL keyset cursor pointing to the oldest row in `rows`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub older_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationEventsPage {
    pub conversation_id: Uuid,
    pub after_sequence: i64,
    pub last_sequence: i64,
    pub has_more: bool,
    pub events: Vec<ConversationEventEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationTimelinePage {
    pub conversation_id: Uuid,
    pub projection_version: u32,
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub rows: Vec<TimelineRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundleManifest {
    pub bundle_version: String,
    pub export_app_version: String,
    pub exported_at: DateTime<Utc>,
    pub source_platform: String,
    pub conversation_ids: Vec<Uuid>,
    pub projection_version: u32,
    pub checksums: Vec<ConversationBundleChecksum>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundleChecksum {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationBundlePayload {
    /// Full visible history for manifest-backed exports; absent in older bundles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_turns: Option<Vec<MessageTurn>>,
    pub manifest: ConversationBundleManifest,
    pub conversations_json: serde_json::Value,
    pub bindings_json: serde_json::Value,
    pub turns_json: serde_json::Value,
    pub events_jsonl: String,
    pub tool_calls_json: serde_json::Value,
    pub file_changes_json: serde_json::Value,
    pub permissions_json: serde_json::Value,
    pub terminals_json: serde_json::Value,
    pub checkpoints_json: serde_json::Value,
}

/// Same bound as live ACP tool previews (ADR-0061). Imported history and open-path
/// projections must not ship larger payloads into the WebView.
pub const MAX_TIMELINE_PREVIEW_BYTES: usize = 16 * 1024;
const MAX_TIMELINE_PREVIEW_IMAGES: usize = 4;

/// Return a substring of `s` whose byte length is `<= max_bytes`, aligned to
/// a UTF-8 character boundary and taken from the TAIL of `s` (so the most
/// recent output is preserved when truncation is required).
pub fn truncate_tail_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len().saturating_sub(max_bytes);
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// If the very end of `s` contains a partial ANSI escape sequence, trim it
/// so downstream ANSI parsers do not render a half-emitted escape sequence.
pub fn trim_partial_ansi_tail(s: &str) -> &str {
    let bytes = s.as_bytes();
    let Some(esc_pos) = bytes.iter().rposition(|&b| b == 0x1B) else {
        return s;
    };
    let after = &bytes[esc_pos + 1..];
    if after.is_empty() {
        return &s[..esc_pos];
    }
    let terminated = match after[0] {
        b'[' => after[1..].iter().any(|&b| (0x40..=0x7E).contains(&b)),
        b']' => {
            after[1..].contains(&0x07)
                || after[1..].windows(2).any(|w| w[0] == 0x1B && w[1] == b'\\')
        }
        _ => true,
    };
    if terminated { s } else { &s[..esc_pos] }
}

pub fn cap_preview_bytes(value: String) -> String {
    if value.len() <= MAX_TIMELINE_PREVIEW_BYTES {
        let trimmed = trim_partial_ansi_tail(&value);
        if trimmed.len() == value.len() {
            return value;
        }
        return trimmed.to_string();
    }
    let tail = trim_partial_ansi_tail(truncate_tail_at_char_boundary(
        &value,
        MAX_TIMELINE_PREVIEW_BYTES,
    ));
    format!("…\n{tail}")
}

pub fn cap_json_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => serde_json::Value::String(cap_preview_bytes(text)),
        other => {
            let serialized = other.to_string();
            if serialized.len() <= MAX_TIMELINE_PREVIEW_BYTES {
                other
            } else {
                serde_json::Value::String(cap_preview_bytes(serialized))
            }
        }
    }
}

pub fn cap_timeline_preview_fields(timeline: &mut ConversationTimeline) {
    for row in &mut timeline.rows {
        cap_timeline_row_preview_fields(row);
    }
}

pub fn cap_timeline_row_preview_fields(row: &mut TimelineRow) {
    cap_timeline_row_kind(&mut row.row);
}

fn cap_timeline_row_kind(row: &mut ConversationTimelineRow) {
    let ConversationTimelineRow::MessageTurn { turn, .. } = row else {
        return;
    };
    cap_content_blocks(&mut turn.blocks);
}

pub fn cap_content_blocks(blocks: &mut [ContentBlock]) {
    for block in blocks {
        cap_tool_preview_fields(block);
    }
}

fn cap_tool_preview_fields(block: &mut ContentBlock) {
    match block {
        ContentBlock::ToolUse {
            input_preview,
            meta,
            images,
            ..
        } => {
            if let Some(preview) = input_preview {
                *preview = cap_preview_bytes(std::mem::take(preview));
            }
            if let Some(value) = meta.take() {
                *meta = Some(cap_json_value(value));
            }
            images.truncate(MAX_TIMELINE_PREVIEW_IMAGES);
        }
        ContentBlock::ToolResult {
            output_preview: Some(preview),
            ..
        } => {
            *preview = cap_preview_bytes(std::mem::take(preview));
        }
        _ => {}
    }
    crate::timeline_images::spill_content_block(block);
}

/// Validates and formats `internal_prompt_contributions` into an `<dimo-plugin-context>`
/// block to append to the Agent prompt.
///
/// Returns `Err(total_bytes)` if the total UTF-8 byte length of all contribution
/// contents exceeds [`MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES`] (16 KiB).
pub fn format_internal_prompt_contributions(
    contributions: &[InternalPromptBlock],
) -> Result<Option<String>, usize> {
    let mut non_empty: Vec<&InternalPromptBlock> = contributions
        .iter()
        .filter(|block| !block.content.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return Ok(None);
    }

    let total_bytes: usize = non_empty.iter().map(|block| block.content.len()).sum();
    if total_bytes > MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES {
        return Err(total_bytes);
    }

    non_empty.sort_by(|left, right| {
        left.priority
            .unwrap_or(0)
            .cmp(&right.priority.unwrap_or(0))
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
    });

    let mut sections = Vec::with_capacity(non_empty.len());
    for block in non_empty {
        let plugin_id = block.plugin_id.trim();
        let content = block.content.trim();
        match block
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
        {
            Some(label) => {
                sections.push(format!(
                    "<plugin-contribution plugin=\"{plugin_id}\" label=\"{label}\">\n{content}\n</plugin-contribution>"
                ));
            }
            None => {
                sections.push(format!(
                    "<plugin-contribution plugin=\"{plugin_id}\">\n{content}\n</plugin-contribution>"
                ));
            }
        }
    }

    Ok(Some(format!(
        "<dimo-plugin-context>\n{}\n</dimo-plugin-context>",
        sections.join("\n\n")
    )))
}

/// Structured side-channel message extracted and stripped from an Assistant turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
#[ts(export)]
pub struct CapturedInternalMessage {
    pub plugin_id: String,
    pub channel: String,
    pub nonce: String,
    pub raw_payload: String,
    pub parsed_payload: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<Uuid>,
}

/// Result of scanning an Assistant text buffer for internal side-channel blocks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct InternalMessageExtraction {
    /// Cleaned user-visible text with all complete internal frames removed and
    /// (when `is_streaming == true`) any trailing incomplete internal frame or prefix
    /// held back so `visible_text` remains strictly monotonically append-only.
    pub visible_text: String,
    /// Complete internal messages discovered in the buffer.
    pub captured: Vec<CapturedInternalMessage>,
    /// True when the end of the buffer is inside an unclosed internal frame or partial
    /// opening marker prefix.
    pub has_pending_tail: bool,
}

const COMMENT_OPEN: &str = "<!--dimo-internal:";
const COMMENT_SPACED_OPEN: &str = "<!-- dimo-internal:";
const FENCE_OPEN: &str = "```dimo-internal:";
const META_OPEN: &str = "<dimo-internal-meta";
const META_CLOSE: &str = "</dimo-internal-meta>";

fn parse_internal_header(header: &str) -> (String, String, String) {
    let trimmed = header.trim();
    let parts: Vec<&str> = trimmed.splitn(3, ':').collect();
    match parts.as_slice() {
        [plugin_id, channel, nonce] => (
            (*plugin_id).to_string(),
            (*channel).to_string(),
            (*nonce).to_string(),
        ),
        [first, second] => (
            (*first).to_string(),
            format!("{first}:{second}"),
            (*second).to_string(),
        ),
        [single] => ((*single).to_string(), (*single).to_string(), String::new()),
        _ => (String::new(), trimmed.to_string(), String::new()),
    }
}

fn parse_payload_json_or_string(raw: &str) -> serde_json::Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return serde_json::Value::String(String::new());
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::Value::String(trimmed.to_string()))
}

fn extract_xml_attr(tag_header: &str, attr_name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pattern = format!("{attr_name}={quote}");
        if let Some(start) = tag_header.find(&pattern) {
            let value_start = start + pattern.len();
            if let Some(end_rel) = tag_header[value_start..].find(quote) {
                return Some(tag_header[value_start..value_start + end_rel].to_string());
            }
        }
    }
    None
}

fn trailing_partial_marker_start(tail: &str) -> Option<usize> {
    let prefixes = [COMMENT_OPEN, COMMENT_SPACED_OPEN, FENCE_OPEN, META_OPEN];
    let max_len = prefixes.iter().map(|p| p.len()).max().unwrap_or(0);
    let mut search_start = tail.len().saturating_sub(max_len);
    while search_start < tail.len() && !tail.is_char_boundary(search_start) {
        search_start += 1;
    }
    for (offset, _) in tail[search_start..].char_indices() {
        let idx = search_start + offset;
        let suffix = &tail[idx..];
        if prefixes
            .iter()
            .any(|prefix| prefix.starts_with(suffix) && suffix.len() < prefix.len())
        {
            return Some(idx);
        }
    }
    None
}

/// Scans `raw_text` and strips all `<!--dimo-internal:...-->`,
/// ```` ```dimo-internal:...\n...\n``` ````, and `<dimo-internal-meta ...>...</dimo-internal-meta>`
/// frames while capturing their structured payloads.
///
/// When `is_streaming` is `true`, any incomplete frame or partial opening marker at the
/// end of `raw_text` is held back from `visible_text` so streaming deltas never flash
/// raw `<!--dimo-internal` tags in the chat UI.
pub fn extract_and_strip_internal_messages(
    raw_text: &str,
    conversation_id: Option<Uuid>,
    turn_id: Option<Uuid>,
    is_streaming: bool,
) -> InternalMessageExtraction {
    let mut visible_text = String::with_capacity(raw_text.len());
    let mut captured = Vec::new();
    let mut cursor = 0usize;
    let mut has_pending_tail = false;

    while cursor < raw_text.len() {
        let rest = &raw_text[cursor..];

        // Find the earliest opening marker in `rest`.
        let candidates = [
            rest.find(COMMENT_OPEN).map(|pos| (pos, COMMENT_OPEN)),
            rest.find(COMMENT_SPACED_OPEN)
                .map(|pos| (pos, COMMENT_SPACED_OPEN)),
            rest.find(FENCE_OPEN).map(|pos| (pos, FENCE_OPEN)),
            rest.find(META_OPEN).map(|pos| (pos, META_OPEN)),
        ];

        let earliest = candidates.into_iter().flatten().min_by_key(|(pos, _)| *pos);

        let Some((rel_pos, marker)) = earliest else {
            if is_streaming && let Some(partial_rel) = trailing_partial_marker_start(rest) {
                visible_text.push_str(&rest[..partial_rel]);
                has_pending_tail = true;
            } else {
                visible_text.push_str(rest);
            }
            break;
        };

        // Append everything before the opening marker to `visible_text`.
        visible_text.push_str(&rest[..rel_pos]);
        let frame_start = cursor + rel_pos;
        let after_marker = &raw_text[frame_start + marker.len()..];

        match marker {
            COMMENT_OPEN | COMMENT_SPACED_OPEN => {
                let Some(close_rel) = after_marker.find("-->") else {
                    has_pending_tail = true;
                    break;
                };
                let body = &after_marker[..close_rel];
                let ws_pos = body.find(char::is_whitespace);
                let (header, raw_payload) = match ws_pos {
                    Some(idx) => (&body[..idx], body[idx..].trim()),
                    None => (body.trim(), ""),
                };
                let (plugin_id, channel, nonce) = parse_internal_header(header);
                captured.push(CapturedInternalMessage {
                    plugin_id,
                    channel,
                    nonce,
                    raw_payload: raw_payload.to_string(),
                    parsed_payload: parse_payload_json_or_string(raw_payload),
                    conversation_id,
                    turn_id,
                });
                cursor = frame_start + marker.len() + close_rel + "-->".len();
            }
            FENCE_OPEN => {
                let Some(newline_rel) = after_marker.find('\n') else {
                    has_pending_tail = true;
                    break;
                };
                let header = after_marker[..newline_rel].trim_end_matches('\r').trim();
                let content_after_header = &after_marker[newline_rel + 1..];
                let close_match = content_after_header
                    .find("\n```")
                    .map(|idx| (idx, "\n```".len()))
                    .or_else(|| {
                        content_after_header
                            .find("```")
                            .map(|idx| (idx, "```".len()))
                    });
                let Some((close_rel, close_len)) = close_match else {
                    has_pending_tail = true;
                    break;
                };
                let raw_payload = content_after_header[..close_rel].trim();
                let (plugin_id, channel, nonce) = parse_internal_header(header);
                captured.push(CapturedInternalMessage {
                    plugin_id,
                    channel,
                    nonce,
                    raw_payload: raw_payload.to_string(),
                    parsed_payload: parse_payload_json_or_string(raw_payload),
                    conversation_id,
                    turn_id,
                });
                cursor = frame_start + marker.len() + newline_rel + 1 + close_rel + close_len;
            }
            META_OPEN => {
                let Some(tag_end_rel) = after_marker.find('>') else {
                    has_pending_tail = true;
                    break;
                };
                let tag_attrs = &after_marker[..tag_end_rel];
                let content_after_tag = &after_marker[tag_end_rel + 1..];
                let Some(close_rel) = content_after_tag.find(META_CLOSE) else {
                    has_pending_tail = true;
                    break;
                };
                let raw_payload = content_after_tag[..close_rel].trim();
                let raw_channel = extract_xml_attr(tag_attrs, "channel").unwrap_or_default();
                let explicit_plugin = extract_xml_attr(tag_attrs, "plugin");
                let explicit_nonce = extract_xml_attr(tag_attrs, "nonce");
                let (parsed_plugin, parsed_channel, parsed_nonce) =
                    parse_internal_header(&raw_channel);
                let plugin_id = explicit_plugin.unwrap_or(parsed_plugin);
                let channel = if raw_channel.is_empty() {
                    parsed_channel
                } else {
                    raw_channel
                };
                let nonce = explicit_nonce.unwrap_or(parsed_nonce);
                captured.push(CapturedInternalMessage {
                    plugin_id,
                    channel,
                    nonce,
                    raw_payload: raw_payload.to_string(),
                    parsed_payload: parse_payload_json_or_string(raw_payload),
                    conversation_id,
                    turn_id,
                });
                cursor =
                    frame_start + marker.len() + tag_end_rel + 1 + close_rel + META_CLOSE.len();
            }
            _ => unreachable!(),
        }
    }

    if !is_streaming || !captured.is_empty() {
        // Collapse excessive blank lines left behind by removed blocks.
        while visible_text.contains("\n\n\n") {
            visible_text = visible_text.replace("\n\n\n", "\n\n");
        }
    }

    InternalMessageExtraction {
        visible_text,
        captured,
        has_pending_tail,
    }
}
