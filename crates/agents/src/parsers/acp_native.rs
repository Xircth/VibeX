//! History parser for agents whose transcript is VibeX ACP JSONL.
//!
//! Ported from Codeg `parsers/acp_native.rs` at `2e657fac`. The projection
//! (`project_turns`) is the only reader of [`crate::acp_transcript`].

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use agent_client_protocol::schema::v1::{SessionUpdate, ToolCallContent};
use api_types::AgentKind;
use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize as _;

use crate::{
    acp_tool_projection::{
        extract_tool_call_images, json_value_to_text, serialize_tool_call_content,
        synthesize_edit_input_from_diffs,
    },
    acp_transcript::{self, EntryKind, Transcript, TranscriptEntry, vibex_acp_transcripts_root},
    conversation::{
        ContentBlock, ConversationDetail, ConversationSummary, ImageData, MessageTurn,
        SessionStats, TurnRole, TurnUsage,
    },
    parsers::ParseError,
};

pub struct AcpNativeParser {
    agent_type: AgentKind,
    /// Directory component under the transcripts root. Custom agents pass their
    /// registry id; built-ins that fall back to JSONL pass `AgentKind::as_str`.
    registry_id: String,
    root: PathBuf,
}

impl AcpNativeParser {
    pub fn new(agent_type: AgentKind, registry_id: impl Into<String>) -> Self {
        Self::new_in(agent_type, registry_id, vibex_acp_transcripts_root())
    }

    pub fn new_in(agent_type: AgentKind, registry_id: impl Into<String>, root: PathBuf) -> Self {
        Self {
            agent_type,
            registry_id: registry_id.into(),
            root,
        }
    }

    fn agent_dir(&self) -> &str {
        &self.registry_id
    }

    /// Load one session, following `continues_from`, into a detail whose turns
    /// are the full parse (windowing happens later).
    pub fn load(&self, session_id: &str) -> Result<ConversationDetail, ParseError> {
        let transcript = acp_transcript::read_chain_in(&self.root, self.agent_dir(), session_id);
        if transcript.entries.is_empty() && transcript.header.is_none() {
            return Err(ParseError::Malformed(format!(
                "no ACP transcript for {session_id}"
            )));
        }
        let turns = project_turns(&transcript.entries);
        let mut summary = self.summarize(session_id, &transcript);
        summary.message_count = turns.len() as u32;
        let mut stats = session_stats(&turns).unwrap_or_default();
        let (used, size) = latest_context_window(&transcript.entries);
        stats.context_window_used_tokens = used;
        stats.context_window_max_tokens = size;
        if let (Some(used), Some(size)) = (used, size.filter(|size| *size > 0)) {
            stats.context_window_usage_percent = Some((used as f64 / size as f64) * 100.0);
        }
        Ok(ConversationDetail {
            summary,
            turns,
            session_stats: Some(stats),
        })
    }

    fn summarize(&self, session_id: &str, transcript: &Transcript) -> ConversationSummary {
        let started_at = transcript
            .header
            .as_ref()
            .map(|h| epoch_ms_to_utc(h.started_at_ms))
            .or_else(|| transcript.entries.first().map(|e| epoch_ms_to_utc(e.t)))
            .unwrap_or_else(Utc::now);
        let ended_at = transcript.entries.last().map(|e| epoch_ms_to_utc(e.t));
        let folder_path = transcript
            .header
            .as_ref()
            .map(|h| h.cwd.clone())
            .filter(|c| !c.is_empty());
        let folder_name = folder_path.as_deref().and_then(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        });
        let user_turns = transcript
            .entries
            .iter()
            .filter(|e| e.k == EntryKind::Prompt)
            .count();
        ConversationSummary {
            id: session_id.to_string(),
            agent_type: self.agent_type,
            folder_path,
            folder_name,
            // The first prompt's text is the only title an ACP transcript can
            // honestly yield — ACP has no title channel, and codeg's DB-side
            // auto-title backfill takes it from here.
            title: first_prompt_title(&transcript.entries),
            started_at,
            ended_at,
            message_count: user_turns as u32,
            model: None,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }
}

#[allow(dead_code)]
enum PromptInputBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        uri: Option<String>,
    },
    ResourceLink {
        name: String,
        uri: String,
        mime_type: Option<String>,
        description: Option<String>,
    },
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<String>,
        blob: Option<String>,
    },
}

fn user_turn_block(block: &PromptInputBlock) -> ContentBlock {
    match block {
        PromptInputBlock::Text { text } => ContentBlock::Text { text: text.clone() },
        PromptInputBlock::Image {
            data,
            mime_type,
            uri,
        } => ContentBlock::Image {
            data: data.clone(),
            mime_type: mime_type.clone(),
            uri: uri.clone(),
            width: None,
            height: None,
        },
        PromptInputBlock::ResourceLink { name, uri, .. } => ContentBlock::Text {
            text: format!("[{name}](<{uri}>)"),
        },
        PromptInputBlock::Resource {
            uri,
            mime_type,
            text,
            blob,
        } => {
            if mime_type
                .as_deref()
                .is_some_and(|mime| mime.starts_with("image/"))
                && let Some(data) = blob.clone().filter(|data| !data.is_empty())
            {
                return ContentBlock::Image {
                    data,
                    mime_type: mime_type.clone().unwrap_or_else(|| "image/png".to_string()),
                    uri: Some(uri.clone()),
                    width: None,
                    height: None,
                };
            }
            let mut rendered = uri.clone();
            if let Some(text) = text.as_ref().filter(|text| !text.is_empty()) {
                rendered.push('\n');
                rendered.push_str(text);
            }
            ContentBlock::Text { text: rendered }
        }
    }
}

fn user_turn_block_from_wire(item: &serde_json::Value) -> Option<ContentBlock> {
    let content = agent_client_protocol::schema::v1::ContentBlock::deserialize(item).ok()?;
    prompt_block_from_content(content).map(|block| user_turn_block(&block))
}

fn truncate_str(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn epoch_ms_to_utc(ms: u64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(Utc::now)
}

fn first_prompt_title(entries: &[TranscriptEntry]) -> Option<String> {
    let first = entries.iter().find(|e| e.k == EntryKind::Prompt)?;
    let text = prompt_text(&first.p);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_str(trimmed, 80))
}

/// Concatenate the text of a recorded `session/prompt` content-block array.
///
/// Prose ONLY. An attachment-only prompt yields nothing here on purpose: this
/// string is the *authoritative* parsed title, and
/// `commands::conversations` writes it over any unlocked title the row
/// already has — including one the agent itself published over
/// `session_info_update`. Naming such a conversation after its attachment is
/// worth doing, but as a seed for a row that has no title at all; that lives
/// in `acp::manager`'s first-prompt seed (`attachment_names_from_prompt`).
fn prompt_text(payload: &serde_json::Value) -> String {
    payload
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Blocks for a user turn recorded from a `session/prompt` payload.
fn prompt_blocks(payload: &serde_json::Value) -> Vec<ContentBlock> {
    let Some(items) = payload.as_array() else {
        return Vec::new();
    };
    items.iter().filter_map(user_turn_block_from_wire).collect()
}

/// The replayed counterpart of [`crate::acp::types::prompt_block_from_wire`]:
/// a `session/load`
/// chunk arrives already deserialized, so it is converted straight across
/// rather than being serialized back to JSON only to be re-read. Consumes the
/// block, so an embedded image's base64 moves instead of being copied twice.
fn prompt_block_from_content(
    content: agent_client_protocol::schema::v1::ContentBlock,
) -> Option<PromptInputBlock> {
    use agent_client_protocol::schema::v1::{
        ContentBlock as Wire, EmbeddedResourceResource as Res,
    };
    let non_empty = |s: String| (!s.is_empty()).then_some(s);
    match content {
        Wire::Text(t) => Some(PromptInputBlock::Text {
            text: non_empty(t.text)?,
        }),
        Wire::Image(i) => {
            let uri = i.uri.and_then(non_empty);
            if i.data.is_empty() && uri.is_none() {
                return None;
            }
            Some(PromptInputBlock::Image {
                data: i.data,
                mime_type: i.mime_type,
                uri,
            })
        }
        Wire::ResourceLink(l) => {
            let uri = non_empty(l.uri)?;
            Some(PromptInputBlock::ResourceLink {
                name: non_empty(l.name).unwrap_or_else(|| uri.clone()),
                uri,
                mime_type: l.mime_type,
                description: l.description,
            })
        }
        Wire::Resource(r) => {
            let (uri, mime_type, text, blob) = match r.resource {
                Res::TextResourceContents(t) => (t.uri, t.mime_type, non_empty(t.text), None),
                Res::BlobResourceContents(b) => (b.uri, b.mime_type, None, non_empty(b.blob)),
                // A shape this build does not know: it has no uri to show and
                // no bytes this can render.
                _ => return None,
            };
            let is_image = mime_type
                .as_deref()
                .is_some_and(|m| m.starts_with("image/"));
            if uri.is_empty() && !(is_image && blob.is_some()) {
                return None;
            }
            Some(PromptInputBlock::Resource {
                uri,
                mime_type,
                text,
                blob,
            })
        }
        // Audio, and any kind a newer schema adds: nothing to render.
        _ => None,
    }
}

/// Where tool calls are projected: a turn's blocks, plus the index of each
/// call's `ToolUse` and `ToolResult` among them.
struct ToolCards<'a> {
    blocks: &'a mut Vec<ContentBlock>,
    tool_use_index: &'a mut HashMap<String, usize>,
    tool_result_index: &'a mut HashMap<String, usize>,
}

/// Accumulated state of one assistant turn under construction.
#[derive(Default)]
struct PendingTurn {
    blocks: Vec<ContentBlock>,
    started_at_ms: u64,
    last_at_ms: u64,
    /// Index into `blocks` of each open tool call's `ToolUse`, so a later
    /// `tool_call_update` patches the same block instead of appending a
    /// duplicate.
    tool_use_index: HashMap<String, usize>,
    /// Index of each tool call's `ToolResult`, appended on first output.
    tool_result_index: HashMap<String, usize>,
    usage: Option<TurnUsage>,
    duration_ms: Option<u64>,
    model: Option<String>,
    agent_message_id: Option<String>,
    has_content: bool,
}

impl PendingTurn {
    fn new(at_ms: u64) -> Self {
        Self {
            started_at_ms: at_ms,
            last_at_ms: at_ms,
            ..Default::default()
        }
    }

    /// This turn's tool-call cards, for [`upsert_tool_call`] to project into —
    /// which gives the turn content.
    fn tool_cards(&mut self) -> ToolCards<'_> {
        self.has_content = true;
        ToolCards {
            blocks: &mut self.blocks,
            tool_use_index: &mut self.tool_use_index,
            tool_result_index: &mut self.tool_result_index,
        }
    }

    /// Append text, coalescing with a trailing block of the same kind so a
    /// streamed reply becomes one paragraph rather than one block per chunk.
    fn push_text(&mut self, text: &str, thinking: bool) {
        if text.is_empty() {
            return;
        }
        self.has_content = true;
        match self.blocks.last_mut() {
            Some(ContentBlock::Text { text: existing }) if !thinking => {
                existing.push_str(text);
                return;
            }
            Some(ContentBlock::Thinking { text: existing }) if thinking => {
                existing.push_str(text);
                return;
            }
            _ => {}
        }
        self.blocks.push(if thinking {
            ContentBlock::Thinking {
                text: text.to_string(),
            }
        } else {
            ContentBlock::Text {
                text: text.to_string(),
            }
        });
    }
}

/// Whether a `session/update` carries anything this module reads back — the
/// **write-side** gate, called by `acp::connection` before a line is recorded.
///
/// ACP broadcasts far more than conversation content: `available_commands_update`
/// alone republishes the agent's whole slash-command catalog (tens of KB) every
/// time it changes. Recording what nothing ever reads inflates every later parse
/// of the file for no gain.
///
/// This is a whitelist, not a blacklist, so an unrecognized future variant
/// degrades to "not recorded" rather than to "silently bloats every transcript".
/// It MUST stay in step with the two consumers below —
/// [`apply_update`]'s match arms and [`latest_context_window`] — and
/// `recorded_updates_are_exactly_the_ones_the_projection_reads` fails the build
/// if it drifts from either.
pub fn is_recorded_update(update: &SessionUpdate) -> bool {
    matches!(
        update,
        SessionUpdate::UserMessageChunk(_)
            | SessionUpdate::AgentMessageChunk(_)
            | SessionUpdate::AgentThoughtChunk(_)
            | SessionUpdate::ToolCall(_)
            | SessionUpdate::ToolCallUpdate(_)
            | SessionUpdate::Plan(_)
            | SessionUpdate::UsageUpdate(_)
    )
}

/// The context-window reading a transcript ends on: `(used, size)` from its
/// last recorded `usage_update` or `turn_end` usage payload.
///
/// Matched on the raw payload rather than by deserializing: the answer is
/// almost always in the last few entries, and a string compare per entry costs
/// nothing next to building a `SessionUpdate`.
fn latest_context_window(entries: &[TranscriptEntry]) -> (Option<u64>, Option<u64>) {
    for entry in entries.iter().rev() {
        match entry.k {
            EntryKind::Update
                if entry.p.get("sessionUpdate").and_then(|v| v.as_str())
                    == Some("usage_update") =>
            {
                let field = |name: &str| entry.p.get(name).and_then(|v| v.as_u64());
                // A window of zero is not a reading, it is an agent that reported nothing;
                // surfacing "0 tokens of 0" as a live gauge would be worse than silence.
                if let Some(size) = field("size").filter(|s| *s > 0) {
                    return (field("used"), Some(size));
                }
            }
            EntryKind::TurnEnd => {
                if let Some(usage) = entry.p.get("usage") {
                    let size = usage
                        .get("contextWindowMax")
                        .or_else(|| usage.get("context_window_max"))
                        .and_then(|v| v.as_u64())
                        .filter(|s| *s > 0);
                    let used = usage
                        .get("contextUsed")
                        .or_else(|| usage.get("context_used"))
                        .and_then(|v| v.as_u64())
                        .filter(|u| *u > 0);
                    if size.is_some() || used.is_some() {
                        return (used, size);
                    }
                }
            }
            _ => {}
        }
    }
    (None, None)
}

/// Project recorded transcript entries into turns.
pub fn project_turns(entries: &[TranscriptEntry]) -> Vec<MessageTurn> {
    let mut turns: Vec<MessageTurn> = Vec::new();
    let mut pending: Option<PendingTurn> = None;
    // True between a recorded outgoing prompt and the first agent output: the
    // agent's `user_message_chunk` echo of that same prompt must not become a
    // second user turn.
    let mut prompt_just_recorded = false;
    // Timestamp of the prompt that opened the current turn. An assistant turn's
    // span starts when codeg SENT the prompt, not when the first token arrived —
    // time-to-first-token is part of how long the agent took, and this matches
    // what `turn_timings` records for built-ins.
    let mut turn_start_hint: Option<u64> = None;
    // True when the last block of the open user turn is PROSE — text a
    // `user_message_chunk` streamed — so the next text chunk may be appended to
    // it. False after an attachment marker or an image, which are one block per
    // prompt block in the live projection and must stay that way here: gluing
    // the next chunk's prose onto `[uri](uri)` would render one run-on
    // paragraph where the live path renders two.
    let mut user_prose_open = false;
    // True from a recorded turn end to the next recorded prompt: the gap
    // between two prompted turns, where everything recorded is work the agent
    // did on its own. Never set in a replay, which has no turn ends.
    let mut between_turns = false;
    // Index in `turns` of the user turn of the prompt being answered: set by a
    // recorded prompt, kept across the messages delivered into its turn (a
    // steer), cleared at its turn end. Bounds how far back the turn end and a
    // tool call's update may reach (see `apply_update`). Never set in a replay.
    let mut prompt_start: Option<usize> = None;
    // True from a steer to the end of the turn it was delivered into: the part
    // under construction started at the steer, not at the turn's prompt.
    let mut steered = false;
    let mut seq = 0usize;

    for entry in entries {
        match entry.k {
            EntryKind::Prompt => {
                between_turns = false;
                flush(&mut pending, &mut turns, &mut seq, true);
                let blocks = prompt_blocks(&entry.p);
                // If an earlier non-steer prompt produced no assistant output before
                // a retry resent the exact same prompt (e.g. SilentTurnRecovery
                // after an early process exit or transient failure), coalesce it into
                // the existing trailing user turn instead of rendering two duplicate
                // consecutive user bubbles.
                if !entry.steer
                    && let Some(last) = turns.last_mut()
                    && matches!(last.role, TurnRole::User)
                    && !last.id.contains(":steer:")
                    && last.blocks == blocks
                {
                    last.timestamp = epoch_ms_to_utc(entry.t);
                    steered = false;
                    prompt_start = Some(turns.len() - 1);
                    prompt_just_recorded = true;
                    turn_start_hint = Some(entry.t);
                    user_prose_open = false;
                    continue;
                }
                // A steer is a user message of its own, so it splits the turn
                // like a prompt — the shape Claude Code's history draws, and
                // the live view's — but the turn goes on: same prompt, same
                // turn end.
                let turn_id = if entry.steer {
                    steered = true;
                    format!("acp-{seq}:steer:{seq}")
                } else {
                    steered = false;
                    prompt_start = Some(turns.len());
                    format!("acp-{seq}")
                };
                turns.push(MessageTurn {
                    id: turn_id,
                    role: TurnRole::User,
                    blocks,
                    timestamp: epoch_ms_to_utc(entry.t),
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                    agent_message_id: None,
                });
                seq += 1;
                prompt_just_recorded = true;
                turn_start_hint = Some(entry.t);
                // A recorded prompt is a COMPLETE message, never a half-streamed
                // one, so nothing may be appended to its trailing block.
                user_prose_open = false;
            }
            EntryKind::TurnEnd => {
                if let Some(p) = pending.as_mut() {
                    // After a steer, the part being closed started at the
                    // steer, while `durationMs` spans the whole turn from its
                    // prompt; the part's own span (`flush`) is the honest one.
                    apply_turn_end(p, &entry.p, !steered);
                    p.last_at_ms = entry.t;
                } else if steered {
                    // Nothing came after the last steer, so the usage and model
                    // the turn end reports go on the part before it — never on
                    // a reply to an earlier prompt.
                    if let Some(last) = turns
                        .iter_mut()
                        .skip(prompt_start.unwrap_or(usize::MAX))
                        .rev()
                        .find(|turn| matches!(turn.role, TurnRole::Assistant))
                    {
                        let (model, usage) = turn_end_model_and_usage(&entry.p);
                        if model.is_some() {
                            last.model = model;
                        }
                        if usage.is_some() {
                            last.usage = usage;
                        }
                    }
                }
                flush(&mut pending, &mut turns, &mut seq, true);
                prompt_just_recorded = false;
                turn_start_hint = None;
                user_prose_open = false;
                between_turns = true;
                steered = false;
                prompt_start = None;
            }
            EntryKind::Update => {
                // Deserialized from a BORROWED `&Value`, not a cloned one: this
                // runs once per recorded chunk, and a long conversation records
                // tens of thousands, so cloning each payload only to drop it a
                // line later was a measurable share of the whole read.
                let Ok(update) = SessionUpdate::deserialize(&entry.p) else {
                    // A transcript written by a newer schema than this build
                    // understands. The raw line stays on disk (it is the ACP
                    // wire format, not an internal type), so a later build can
                    // still read it; skipping is the honest degradation.
                    tracing::debug!("[acp-native] skipping unparsable session update");
                    continue;
                };
                apply_update(
                    update,
                    entry.t,
                    between_turns,
                    prompt_start,
                    &mut pending,
                    &mut turns,
                    &mut seq,
                    &mut prompt_just_recorded,
                    &mut turn_start_hint,
                    &mut user_prose_open,
                );
            }
        }
    }
    flush(&mut pending, &mut turns, &mut seq, false);
    attach_latest_context_occupancy(&mut turns, entries);
    turns
}

fn attach_latest_context_occupancy(turns: &mut [MessageTurn], entries: &[TranscriptEntry]) {
    let (used, size) = latest_context_window(entries);
    if used.is_none() && size.is_none() {
        return;
    }
    let Some(last) = turns
        .iter_mut()
        .rev()
        .find(|turn| matches!(turn.role, TurnRole::Assistant))
    else {
        return;
    };
    match last.usage.as_mut() {
        Some(usage) => {
            if usage.context_used.is_none() {
                usage.context_used = used;
            }
            if usage.context_window_max.is_none() {
                usage.context_window_max = size;
            }
        }
        None => {
            last.usage = Some(TurnUsage {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                context_used: used,
                context_window_max: size,
                cost_amount: None,
                cost_currency: None,
            });
        }
    }
}

fn flush(
    pending: &mut Option<PendingTurn>,
    turns: &mut Vec<MessageTurn>,
    seq: &mut usize,
    closed: bool,
) {
    let Some(mut p) = pending.take() else { return };
    if !p.has_content {
        return;
    }
    p.blocks.retain_mut(|block| match block {
        ContentBlock::Text { text } => {
            let extracted =
                crate::conversation::extract_and_strip_internal_messages(text, None, None, false);
            *text = extracted.visible_text;
            !text.is_empty()
        }
        _ => true,
    });
    if p.blocks.is_empty() {
        return;
    }
    turns.push(MessageTurn {
        id: format!("acp-{seq}"),
        role: TurnRole::Assistant,
        blocks: p.blocks,
        timestamp: epoch_ms_to_utc(p.started_at_ms),
        usage: p.usage,
        duration_ms: p
            .duration_ms
            .or_else(|| p.last_at_ms.checked_sub(p.started_at_ms)),
        model: p.model,
        completed_at: closed.then(|| epoch_ms_to_utc(p.last_at_ms)),
        agent_message_id: p.agent_message_id,
    });
    *seq += 1;
}

/// Close the open part of a turn with what its turn end reports. `whole_turn`
/// is false when the part started at a steer rather than at the turn's prompt:
/// the recorded duration then spans more than this part and is left out.
fn apply_turn_end(pending: &mut PendingTurn, payload: &serde_json::Value, whole_turn: bool) {
    if whole_turn
        && let Some(ms) = payload.get("durationMs").and_then(|v| v.as_u64())
    {
        pending.duration_ms = Some(ms);
    }
    let (model, usage) = turn_end_model_and_usage(payload);
    if model.is_some() {
        pending.model = model;
    }
    if usage.is_some() {
        pending.usage = usage;
    }
}

/// The model and the usage a turn end reports, when it reports them.
fn turn_end_model_and_usage(payload: &serde_json::Value) -> (Option<String>, Option<TurnUsage>) {
    let model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let usage = payload.get("usage").and_then(parse_usage);
    (model, usage)
}

/// Read an ACP usage object. Field names follow the `unstable_session_usage`
/// shape, with snake_case accepted as well since agents differ.
fn parse_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    let get = |camel: &str, snake: &str| -> u64 {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let get_opt = |camel: &str, snake: &str| -> Option<u64> {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
    };
    let input = get("inputTokens", "input_tokens");
    let output = get("outputTokens", "output_tokens");
    let cache_create = get("cacheCreationInputTokens", "cache_creation_input_tokens");
    let cache_read = get("cacheReadInputTokens", "cache_read_input_tokens");
    let context_used = get_opt("contextUsed", "context_used");
    let context_window_max = get_opt("contextWindowMax", "context_window_max");
    if input == 0
        && output == 0
        && cache_create == 0
        && cache_read == 0
        && context_used.is_none()
        && context_window_max.is_none()
    {
        return None;
    }
    Some(TurnUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_create,
        cache_read_input_tokens: cache_read,
        context_used,
        context_window_max,
        cost_amount: None,
        cost_currency: None,
    })
}

fn tool_status_str(status: agent_client_protocol::schema::v1::ToolCallStatus) -> Option<String> {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

fn tool_kind_str(kind: agent_client_protocol::schema::v1::ToolKind) -> Option<String> {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
}

#[allow(clippy::too_many_arguments)]
fn apply_update(
    update: SessionUpdate,
    at_ms: u64,
    between_turns: bool,
    prompt_start: Option<usize>,
    pending: &mut Option<PendingTurn>,
    turns: &mut Vec<MessageTurn>,
    seq: &mut usize,
    prompt_just_recorded: &mut bool,
    turn_start_hint: &mut Option<u64>,
    user_prose_open: &mut bool,
) {
    // Opening a turn consumes the prompt's timestamp, so the turn's span covers
    // time-to-first-token; without a recorded prompt (replay) it starts here.
    macro_rules! open_turn {
        () => {
            pending.get_or_insert_with(|| PendingTurn::new(turn_start_hint.take().unwrap_or(at_ms)))
        };
    }
    match update {
        SessionUpdate::UserMessageChunk(chunk) => {
            // Live path: codeg already recorded the outgoing prompt, so the
            // agent's echo is a duplicate. Replay path: there is no recorded
            // prompt, so this IS the user turn and it also ends the previous
            // assistant turn.
            if *prompt_just_recorded {
                return;
            }
            let Some(input) = prompt_block_from_content(chunk.content) else {
                return;
            };
            // Resource/image chunks append in order to the same user turn;
            // incoming text chunks retain the existing text-coalescing behavior,
            // but only onto prose — an attachment marker is one block per prompt
            // block in the live projection, and appending to it would glue the
            // next sentence onto the end of a markdown link.
            let is_text = matches!(input, PromptInputBlock::Text { .. });
            let block = user_turn_block(&input);
            let coalesce = is_text && *user_prose_open;
            flush(pending, turns, seq, true);
            *turn_start_hint = Some(at_ms);
            match turns.last_mut() {
                // Consecutive replay chunks belong to one user message.
                Some(last) if matches!(last.role, TurnRole::User) => {
                    if let (
                        true,
                        Some(ContentBlock::Text { text: existing }),
                        ContentBlock::Text { text },
                    ) = (coalesce, last.blocks.last_mut(), &block)
                    {
                        existing.push_str(text);
                    } else {
                        last.blocks.push(block);
                    }
                }
                _ => {
                    turns.push(MessageTurn {
                        id: format!("acp-{seq}"),
                        role: TurnRole::User,
                        blocks: vec![block],
                        timestamp: epoch_ms_to_utc(at_ms),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                        agent_message_id: None,
                    });
                    *seq += 1;
                }
            }
            *user_prose_open = is_text;
        }
        SessionUpdate::AgentMessageChunk(chunk) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            if p.agent_message_id.is_none() {
                p.agent_message_id = chunk
                    .message_id
                    .as_ref()
                    .map(|id| id.to_string())
                    .filter(|id| !id.trim().is_empty());
            }
            match &chunk.content {
                agent_client_protocol::schema::v1::ContentBlock::Image(image) => {
                    p.has_content = true;
                    p.blocks.push(ContentBlock::Image {
                        data: image.data.clone(),
                        mime_type: image.mime_type.clone(),
                        uri: image.uri.clone(),
                        width: None,
                        height: None,
                    });
                }
                other => {
                    let text = content_block_text(other);
                    p.push_text(&text, false);
                }
            }
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            let text = content_block_text(&chunk.content);
            p.push_text(&text, true);
        }
        SessionUpdate::ToolCall(tc) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            let id = tc.tool_call_id.to_string();
            let status = tool_status_str(tc.status);
            let kind = tool_kind_str(tc.kind);
            upsert_tool_call(
                p.tool_cards(),
                &id,
                Some(tc.title.clone()),
                tc.raw_input.as_ref(),
                &tc.content,
                tc.raw_output.as_ref(),
                status.as_deref(),
                kind.as_deref(),
                tc.meta.clone().map(serde_json::Value::Object),
                at_ms,
            );
        }
        SessionUpdate::ToolCallUpdate(tcu) => {
            let id = tcu.tool_call_id.to_string();
            let status = tcu.fields.status.and_then(tool_status_str);
            let kind = tcu.fields.kind.and_then(tool_kind_str);
            // An update for a call the open part of the turn did not start can
            // still belong to a card already drawn:
            //
            // * Between turns, a call an EARLIER turn started, finishing after
            //   that turn ended (a command that went to the background, say).
            //   Its card is in the turn that opened it, and the live view draws
            //   nothing for the update itself, so it completes that card rather
            //   than opening a turn with a second card for the same call.
            // * Inside a turn, a call this prompt's turn started before a
            //   message split it — a steer, or a user chunk echoed mid-turn: a
            //   command the steer sent to the background reporting back, or a
            //   streamed call the steer cut off failing at the turn's end. The
            //   live view keeps one card per call across such a split and
            //   updates it in place, so the update goes back to that card.
            //
            // Inside a turn the search never reaches past the prompt that
            // opened it: the live view draws an update from an earlier turn's
            // call as a card of the running turn, so there it stays one.
            let held_by_open_turn = pending
                .as_ref()
                .is_some_and(|p| p.tool_use_index.contains_key(&id));
            let reach = if between_turns { Some(0) } else { prompt_start };
            if let Some(reach) = reach.filter(|_| !held_by_open_turn) {
                let closed = turns
                    .iter_mut()
                    .skip(reach)
                    .rev()
                    .find_map(|turn| closed_tool_card(turn, &id).map(|slots| (turn, slots)));
                if let Some((turn, (mut uses, mut results))) = closed {
                    upsert_tool_call(
                        ToolCards {
                            blocks: &mut turn.blocks,
                            tool_use_index: &mut uses,
                            tool_result_index: &mut results,
                        },
                        &id,
                        tcu.fields.title.clone(),
                        tcu.fields.raw_input.as_ref(),
                        tcu.fields.content.as_deref().unwrap_or(&[]),
                        tcu.fields.raw_output.as_ref(),
                        status.as_deref(),
                        kind.as_deref(),
                        tcu.meta.clone().map(serde_json::Value::Object),
                        at_ms,
                    );
                    return;
                }
            }
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            upsert_tool_call(
                p.tool_cards(),
                &id,
                tcu.fields.title.clone(),
                tcu.fields.raw_input.as_ref(),
                tcu.fields.content.as_deref().unwrap_or(&[]),
                tcu.fields.raw_output.as_ref(),
                status.as_deref(),
                kind.as_deref(),
                tcu.meta.clone().map(serde_json::Value::Object),
                at_ms,
            );
        }
        SessionUpdate::Plan(plan) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            upsert_plan(p, &plan, at_ms);
        }
        // Nothing else describes a TURN. `usage_update` does reach the
        // projection, but through [`latest_context_window`] — it reports the
        // session's context occupancy, not this turn's tokens. The rest
        // (slash-command catalogs, mode switches, config echoes) is refused at
        // record time by [`is_recorded_update`] and survives only in
        // transcripts written before that filter existed.
        _ => {}
    }
}

/// Text of an ACP content block. Non-text blocks that still carry a textual
/// projection (resource links, embedded text resources) degrade to it.
fn content_block_text(block: &agent_client_protocol::schema::v1::ContentBlock) -> String {
    match block {
        agent_client_protocol::schema::v1::ContentBlock::Text(t) => t.text.clone(),
        agent_client_protocol::schema::v1::ContentBlock::ResourceLink(link) => link.uri.clone(),
        agent_client_protocol::schema::v1::ContentBlock::Resource(res) => match &res.resource {
            agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(
                t,
            ) => t.text.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Where `id`'s card sits in a turn that is already closed, as the index maps
/// [`upsert_tool_call`] patches through — `None` when the turn has no card for
/// it. A closed turn keeps no index of its own, and only an update for a call
/// the open part did not start ever asks, so the turn's blocks are searched
/// instead.
fn closed_tool_card(
    turn: &MessageTurn,
    id: &str,
) -> Option<(HashMap<String, usize>, HashMap<String, usize>)> {
    let mut uses = HashMap::new();
    let mut results = HashMap::new();
    for (index, block) in turn.blocks.iter().enumerate() {
        match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(use_id),
                ..
            } if use_id == id => {
                uses.insert(id.to_string(), index);
            }
            ContentBlock::ToolResult {
                tool_use_id: Some(result_id),
                ..
            } if result_id == id => {
                results.insert(id.to_string(), index);
            }
            _ => {}
        }
    }
    (!uses.is_empty()).then_some((uses, results))
}

fn tool_call_is_terminal(status: Option<&str>) -> bool {
    matches!(
        status,
        Some("completed") | Some("failed") | Some("cancelled") | Some("canceled")
    )
}

fn observe_tool_clock(
    started_at: &mut Option<DateTime<Utc>>,
    ended_at: &mut Option<DateTime<Utc>>,
    status: Option<&str>,
    at_ms: u64,
) {
    if started_at.is_none() {
        *started_at = Some(epoch_ms_to_utc(at_ms));
    }
    if tool_call_is_terminal(status) {
        *ended_at = Some(epoch_ms_to_utc(at_ms));
    }
}

/// Insert or patch one tool call's `ToolUse` / `ToolResult` pair.
///
/// Uses the same input/output/image projection as the live path so a tool call
/// looks identical whether it is streaming or reloaded from disk. Images live
/// on VibeX `ToolUse` (the rendered card), not on `ToolResult`.
#[allow(clippy::too_many_arguments)]
fn upsert_tool_call(
    cards: ToolCards<'_>,
    id: &str,
    title: Option<String>,
    raw_input: Option<&serde_json::Value>,
    content: &[ToolCallContent],
    raw_output: Option<&serde_json::Value>,
    status: Option<&str>,
    kind: Option<&str>,
    meta: Option<serde_json::Value>,
    at_ms: u64,
) {
    let ToolCards {
        blocks,
        tool_use_index,
        tool_result_index,
    } = cards;
    let own_input = json_value_to_text(&raw_input.cloned()).filter(|t| !t.trim().is_empty());
    let synthesized_edit = if own_input.is_none() {
        synthesize_edit_input_from_diffs(content)
    } else {
        None
    };
    let input_preview = synthesized_edit.clone().or(own_input);
    let output = serialize_tool_call_content(content, synthesized_edit.is_none())
        .or_else(|| json_value_to_text(&raw_output.cloned()));
    let images: Vec<ImageData> = extract_tool_call_images(content).unwrap_or_default();
    let is_error = status == Some("failed");

    match tool_use_index.get(id).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolUse {
                tool_name,
                status: existing_status,
                kind: existing_kind,
                input_preview: existing_input,
                meta: existing_meta,
                images: existing_images,
                started_at,
                ended_at,
                ..
            }) = blocks.get_mut(idx)
            {
                if let Some(t) = title.filter(|t| !t.is_empty()) {
                    *tool_name = t;
                }
                if let Some(s) = status.filter(|s| !s.is_empty()) {
                    *existing_status = Some(s.to_string());
                }
                if let Some(k) = kind.filter(|k| !k.is_empty()) {
                    *existing_kind = Some(k.to_string());
                }
                if input_preview.is_some() {
                    *existing_input = input_preview;
                }
                if meta.is_some() {
                    *existing_meta = meta;
                }
                if !images.is_empty() {
                    *existing_images = images.clone();
                }
                observe_tool_clock(started_at, ended_at, status, at_ms);
            }
        }
        None => {
            let observed = epoch_ms_to_utc(at_ms);
            tool_use_index.insert(id.to_string(), blocks.len());
            blocks.push(ContentBlock::ToolUse {
                tool_use_id: Some(id.to_string()),
                tool_name: title.unwrap_or_else(|| "tool".to_string()),
                status: status.map(str::to_string),
                kind: kind.map(str::to_string),
                input_preview,
                meta,
                images: images.clone(),
                started_at: Some(observed),
                ended_at: tool_call_is_terminal(status).then_some(observed),
            });
        }
    }

    if output.is_none() && images.is_empty() && !is_error {
        return;
    }
    match tool_result_index.get(id).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolResult {
                output_preview,
                is_error: existing_error,
                ..
            }) = blocks.get_mut(idx)
            {
                if output.is_some() {
                    *output_preview = output;
                }
                *existing_error = is_error;
            }
        }
        None => {
            tool_result_index.insert(id.to_string(), blocks.len());
            blocks.push(ContentBlock::ToolResult {
                tool_use_id: Some(id.to_string()),
                output_preview: output,
                is_error,
                agent_stats: None,
            });
        }
    }
}

/// ACP plans are cumulative snapshots: each `plan` update replaces the previous
/// one. Model that as a single synthetic `TodoWrite` tool call whose input the
/// frontend already renders as a plan card.
fn upsert_plan(
    pending: &mut PendingTurn,
    plan: &agent_client_protocol::schema::v1::Plan,
    at_ms: u64,
) {
    let todos: Vec<serde_json::Value> = plan
        .entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "content": e.content,
                "status": format!("{:?}", e.status).to_lowercase(),
                "priority": format!("{:?}", e.priority).to_lowercase(),
            })
        })
        .collect();
    let input = serde_json::to_string(&serde_json::json!({ "todos": todos })).unwrap_or_default();
    const PLAN_ID: &str = "acp-plan";
    match pending.tool_use_index.get(PLAN_ID).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolUse { input_preview, .. }) = pending.blocks.get_mut(idx) {
                *input_preview = Some(input);
            }
        }
        None => {
            pending
                .tool_use_index
                .insert(PLAN_ID.to_string(), pending.blocks.len());
            pending.blocks.push(ContentBlock::ToolUse {
                tool_use_id: Some(PLAN_ID.to_string()),
                tool_name: "TodoWrite".to_string(),
                status: None,
                kind: None,
                input_preview: Some(input),
                meta: None,
                images: Vec::new(),
                started_at: Some(epoch_ms_to_utc(at_ms)),
                ended_at: None,
            });
        }
    }
}

/// Aggregate per-turn usage into the session footer. `None` when no turn
/// carried usage (ACP usage reporting is optional).
fn session_stats(turns: &[MessageTurn]) -> Option<SessionStats> {
    let total_duration_ms: u64 = turns.iter().filter_map(|t| t.duration_ms).sum();
    let mut total = TurnUsage {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_used: None,
        context_window_max: None,
        cost_amount: None,
        cost_currency: None,
    };
    let mut any = false;
    for usage in turns.iter().filter_map(|t| t.usage.as_ref()) {
        any = true;
        total.input_tokens += usage.input_tokens;
        total.output_tokens += usage.output_tokens;
        total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        total.cache_read_input_tokens += usage.cache_read_input_tokens;
    }
    if !any && total_duration_ms == 0 {
        return None;
    }
    let total_tokens = any.then(|| {
        total.input_tokens
            + total.output_tokens
            + total.cache_creation_input_tokens
            + total.cache_read_input_tokens
    });
    Some(SessionStats {
        total_usage: any.then_some(total),
        total_tokens,
        total_duration_ms,
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        context_window_usage_percent: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(t: u64, text: &str) -> TranscriptEntry {
        TranscriptEntry {
            t,
            k: EntryKind::Prompt,
            steer: false,
            p: serde_json::json!([{ "type": "text", "text": text }]),
        }
    }

    fn chunk(t: u64, text: &str) -> TranscriptEntry {
        TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text }
            }),
        }
    }

    #[test]
    fn projects_a_prompt_and_merged_assistant_text() {
        let entries = vec![
            prompt(1_000, "hi"),
            chunk(1_100, "Hello "),
            chunk(1_200, "there"),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert!(matches!(turns[0].role, TurnRole::User));
        match &turns[1].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello there"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn preserves_agent_message_id_from_agent_message_chunk() {
        let entries = vec![
            prompt(1_000, "hi"),
            TranscriptEntry {
                t: 1_100,
                k: EntryKind::Update,
                steer: false,
                p: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "msg_claude_01",
                    "content": { "type": "text", "text": "Hello" }
                }),
            },
            chunk(1_200, " world"),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].agent_message_id.as_deref(), Some("msg_claude_01"));
    }

    #[test]
    fn an_open_transcript_leaves_the_assistant_unfinished() {
        let open = project_turns(&[prompt(1_000, "hi"), chunk(1_100, "Hello")]);
        assert!(open[1].completed_at.is_none());

        let continued = project_turns(&[
            prompt(1_000, "one"),
            chunk(1_100, "A"),
            prompt(1_200, "two"),
            chunk(1_300, "B"),
        ]);
        assert!(continued[1].completed_at.is_some());
        assert!(continued[3].completed_at.is_none());

        let closed = project_turns(&[
            prompt(1_000, "hi"),
            chunk(1_100, "Hello"),
            TranscriptEntry {
                t: 1_300,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({ "stopReason": "end_turn" }),
            },
        ]);
        assert!(closed[1].completed_at.is_some());
    }

    #[test]
    fn stamps_usage_update_occupancy_on_the_last_assistant_turn() {
        let turns = project_turns(&[
            prompt(1_000, "hi"),
            chunk(1_100, "Hello"),
            TranscriptEntry {
                t: 1_150,
                k: EntryKind::Update,
                steer: false,
                p: serde_json::json!({
                    "sessionUpdate": "usage_update",
                    "used": 18658,
                    "size": 200000
                }),
            },
            TranscriptEntry {
                t: 1_300,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({ "stopReason": "end_turn", "durationMs": 4000 }),
            },
        ]);
        let usage = turns[1].usage.as_ref().expect("occupancy on assistant");
        assert_eq!(usage.context_used, Some(18658));
        assert_eq!(usage.context_window_max, Some(200000));
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(turns[1].duration_ms, Some(4000));
    }

    fn tool_entry(t: u64, id: &str, status: &str, update: bool) -> TranscriptEntry {
        TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": if update { "tool_call_update" } else { "tool_call" },
                "toolCallId": id,
                "title": "Bash",
                "kind": "execute",
                "status": status
            }),
        }
    }

    #[test]
    fn stamps_tool_call_wall_clock_and_leaves_an_open_call_open() {
        let start = 1_760_000_000_000;
        let turns = project_turns(&[
            prompt(start, "hi"),
            tool_entry(start + 1_000, "open", "pending", false),
            tool_entry(start + 2_000, "done", "pending", false),
            tool_entry(start + 5_400_000, "done", "completed", true),
        ]);
        let assistant = turns
            .iter()
            .find(|turn| matches!(turn.role, TurnRole::Assistant))
            .expect("assistant");
        match &assistant.blocks[0] {
            ContentBlock::ToolUse {
                started_at,
                ended_at,
                ..
            } => {
                assert_eq!(*started_at, Some(epoch_ms_to_utc(start + 1_000)));
                assert!(ended_at.is_none());
            }
            other => panic!("{other:?}"),
        }
        match &assistant.blocks[1] {
            ContentBlock::ToolUse {
                started_at,
                ended_at,
                ..
            } => {
                assert_eq!(*started_at, Some(epoch_ms_to_utc(start + 2_000)));
                assert_eq!(*ended_at, Some(epoch_ms_to_utc(start + 5_400_000)));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn coalesces_retried_prompt_when_first_attempt_produced_no_assistant_output() {
        let turns = project_turns(&[
            prompt(1_000, "hi"),
            TranscriptEntry {
                t: 1_050,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({ "stopReason": "error", "durationMs": 50 }),
            },
            prompt(1_100, "hi"),
            chunk(1_200, "Recovered reply"),
            TranscriptEntry {
                t: 1_300,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({ "stopReason": "end_turn", "durationMs": 200 }),
            },
        ]);
        assert_eq!(turns.len(), 2);
        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
        assert_eq!(turns[0].timestamp, epoch_ms_to_utc(1_100));
    }

    #[test]
    fn steer_prompt_preserves_steer_marker_in_turn_id() {
        let turns = project_turns(&[
            prompt(1_000, "initial task"),
            chunk(1_100, "Working on step 1"),
            TranscriptEntry {
                t: 1_200,
                k: EntryKind::Prompt,
                steer: true,
                p: serde_json::json!([{ "type": "text", "text": "actually focus on step 2" }]),
            },
            chunk(1_300, "Switching to step 2"),
            TranscriptEntry {
                t: 1_400,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({ "stopReason": "end_turn", "durationMs": 400 }),
            },
        ]);
        assert_eq!(turns.len(), 4);
        assert_eq!(turns[0].id, "acp-0");
        assert_eq!(turns[1].id, "acp-1");
        assert_eq!(turns[2].id, "acp-2:steer:2");
        assert!(matches!(turns[2].role, TurnRole::User));
        assert_eq!(turns[3].id, "acp-3");
    }

    #[test]
    fn turn_end_usage_preserves_tokens_and_context_window_occupancy() {
        let entries = vec![
            prompt(1_000, "hi"),
            chunk(1_100, "Hello"),
            TranscriptEntry {
                t: 1_300,
                k: EntryKind::TurnEnd,
                steer: false,
                p: serde_json::json!({
                    "stopReason": "end_turn",
                    "durationMs": 300,
                    "usage": {
                        "inputTokens": 1200,
                        "outputTokens": 350,
                        "contextUsed": 1550,
                        "contextWindowMax": 200000
                    }
                }),
            },
        ];
        let turns = project_turns(&entries);
        let usage = turns[1].usage.as_ref().expect("usage on assistant");
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.output_tokens, 350);
        assert_eq!(usage.context_used, Some(1550));
        assert_eq!(usage.context_window_max, Some(200000));
        assert_eq!(latest_context_window(&entries), (Some(1550), Some(200000)));
    }

    #[test]
    fn tool_call_and_update_preserve_kind_status_and_output() {
        let entries = vec![
            prompt(1_000, "run ls"),
            TranscriptEntry {
                t: 1_100,
                k: EntryKind::Update,
                steer: false,
                p: serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc-1",
                    "title": "Bash",
                    "kind": "execute",
                    "status": "in_progress",
                    "rawInput": { "command": "ls -la" }
                }),
            },
            TranscriptEntry {
                t: 1_200,
                k: EntryKind::Update,
                steer: false,
                p: serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-1",
                    "status": "completed",
                    "content": [{
                        "type": "content",
                        "content": { "type": "text", "text": "total 0" }
                    }]
                }),
            },
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1].blocks.len(), 2);
        match &turns[1].blocks[0] {
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                status,
                kind,
                input_preview,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("tc-1"));
                assert_eq!(tool_name, "Bash");
                assert_eq!(status.as_deref(), Some("completed"));
                assert_eq!(kind.as_deref(), Some("execute"));
                assert!(
                    input_preview
                        .as_deref()
                        .unwrap_or_default()
                        .contains("ls -la")
                );
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
        match &turns[1].blocks[1] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("tc-1"));
                assert_eq!(output_preview.as_deref(), Some("total 0"));
                assert!(!is_error);
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }
}
