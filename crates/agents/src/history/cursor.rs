use std::path::{Path, PathBuf};

use api_types::AgentKind;
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};

use super::{
    AgentHistoryError, ImportedAgentMessage, ImportedAgentMessageMetadata,
    ImportedAgentMessageRole, ImportedAgentSession,
};

/// Cursor stores conversations as content-addressed protobuf DAGs in SQLite
/// (`chats/<md5-cwd>/<uuid>/store.db` and `acp-sessions/<uuid>/store.db`).
/// Layout matches the CLI's `agent.v1.*` field tables (2026.07.16 bundle);
/// unknown fields and tool variants degrade instead of failing the session.
pub(super) fn import_cursor_stores(
    root: &Path,
) -> Result<Vec<ImportedAgentSession>, AgentHistoryError> {
    let mut stores = Vec::new();
    collect_store_databases(root, &mut stores)?;
    let mut sessions = Vec::new();
    for store in stores {
        if let Some(session) = import_cursor_store(&store)? {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

fn import_cursor_store(store: &Path) -> Result<Option<ImportedAgentSession>, AgentHistoryError> {
    let Some(session_dir) = store.parent() else {
        return Ok(None);
    };
    let session_id = session_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let sidecar = read_json(session_dir.join("meta.json"));
    let connection = open_cursor_store(store)?;
    let Some(meta) = read_chat_meta(&connection) else {
        return Ok(None);
    };
    if meta.is_subagent {
        return Ok(None);
    }
    let Some(root_id) = meta.latest_root_blob_id.as_deref() else {
        return Ok(None);
    };
    let Some(state_bytes) = read_blob(&connection, root_id) else {
        return Ok(None);
    };
    let mut state = decode_state(&state_bytes);
    if state.turn_blob_ids.is_empty() {
        return Ok(None);
    }
    let messages = build_messages(&connection, &mut state, &meta);
    if messages.is_empty() {
        return Ok(None);
    }
    let title = sidecar
        .as_ref()
        .and_then(|value| nonempty_str(value, "title"))
        .or(meta.name.clone())
        .or_else(|| {
            messages
                .iter()
                .find(|message| message.role == ImportedAgentMessageRole::User)
                .map(|message| super::title_from_content(&message.content))
        });
    let workspace_path = sidecar
        .as_ref()
        .and_then(|value| nonempty_str(value, "cwd"))
        .or_else(|| state.workspace_path())
        .map(PathBuf::from);
    Ok(Some(ImportedAgentSession {
        source_agent: AgentKind::Cursor,
        external_session_id: session_id,
        title,
        workspace_path,
        messages,
        raw_source_path: Some(store.to_path_buf()),
    }))
}

fn open_cursor_store(path: &Path) -> Result<Connection, AgentHistoryError> {
    if let Ok(connection) = try_open_cursor_store(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        return Ok(connection);
    }
    // WAL recovery is not allowed on a read-only handle. Opening read-write
    // without CREATE rebuilds the wal-index the same way the CLI would, without
    // creating a missing database.
    try_open_cursor_store(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

fn try_open_cursor_store(path: &Path, flags: OpenFlags) -> Result<Connection, AgentHistoryError> {
    let connection =
        Connection::open_with_flags(path, flags).map_err(|error| parse_error(path, error))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|error| parse_error(path, error))?;
    connection
        .query_row("SELECT count(*) FROM meta", [], |row| row.get::<_, i64>(0))
        .map_err(|error| parse_error(path, error))?;
    Ok(connection)
}

#[derive(Default)]
struct ChatMeta {
    name: Option<String>,
    created_at_ms: Option<u64>,
    last_used_model: Option<String>,
    latest_root_blob_id: Option<Vec<u8>>,
    is_subagent: bool,
}

fn read_chat_meta(connection: &Connection) -> Option<ChatMeta> {
    let raw: String = connection
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
            row.get(0)
        })
        .ok()?;
    let value = cursor_metadata(&raw)?;
    Some(ChatMeta {
        name: nonempty_str(&value, "name"),
        created_at_ms: json_ms(value.get("createdAt")),
        last_used_model: nonempty_str(&value, "lastUsedModel"),
        latest_root_blob_id: value
            .get("latestRootBlobId")
            .and_then(serde_json::Value::as_str)
            .and_then(hex_decode),
        is_subagent: value
            .get("subagentInfo")
            .is_some_and(|info| !info.is_null()),
    })
}

fn json_ms(value: Option<&serde_json::Value>) -> Option<u64> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
}

fn cursor_metadata(raw: &str) -> Option<serde_json::Value> {
    if raw.trim_start().starts_with('{') {
        return serde_json::from_str(raw).ok();
    }
    serde_json::from_slice(&hex_decode(raw.trim())?).ok()
}

fn read_blob(connection: &Connection, id: &[u8]) -> Option<Vec<u8>> {
    connection
        .query_row(
            "SELECT data FROM blobs WHERE id = ?1",
            [hex_encode(id)],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .ok()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(raw: &str) -> Option<Vec<u8>> {
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return None;
    }
    (0..raw.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(raw.get(index..index + 2)?, 16).ok())
        .collect()
}

mod wire {
    pub enum Val<'a> {
        Varint(u64),
        Fixed64(u64),
        Bytes(&'a [u8]),
        Fixed32,
    }

    impl<'a> Val<'a> {
        pub fn bytes(&self) -> Option<&'a [u8]> {
            match self {
                Val::Bytes(bytes) => Some(bytes),
                _ => None,
            }
        }

        pub fn str(&self) -> Option<&'a str> {
            std::str::from_utf8(self.bytes()?).ok()
        }

        pub fn u64(&self) -> Option<u64> {
            match self {
                Val::Varint(value) => Some(*value),
                _ => None,
            }
        }

        pub fn i32(&self) -> Option<i32> {
            self.u64().map(|value| value as i64 as i32)
        }

        pub fn f64(&self) -> Option<f64> {
            match self {
                Val::Fixed64(value) => Some(f64::from_bits(*value)),
                _ => None,
            }
        }
    }

    pub struct Fields<'a> {
        buf: &'a [u8],
        pos: usize,
        malformed: bool,
    }

    impl<'a> Fields<'a> {
        pub fn new(buf: &'a [u8]) -> Self {
            Self {
                buf,
                pos: 0,
                malformed: false,
            }
        }

        pub fn consumed(&self) -> usize {
            self.pos
        }

        pub fn is_malformed(&self) -> bool {
            self.malformed
        }

        fn varint(&mut self) -> Option<u64> {
            let mut out = 0u64;
            for shift in 0..10 {
                let byte = *self.buf.get(self.pos)?;
                self.pos += 1;
                out |= u64::from(byte & 0x7f) << (7 * shift);
                if byte & 0x80 == 0 {
                    return Some(out);
                }
            }
            None
        }

        fn parse_next(&mut self) -> Option<(u32, Val<'a>)> {
            let key = self.varint()?;
            let field = u32::try_from(key >> 3).ok()?;
            match key & 0x7 {
                0 => Some((field, Val::Varint(self.varint()?))),
                1 => {
                    let end = self.pos.checked_add(8)?;
                    let raw = self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((
                        field,
                        Val::Fixed64(u64::from_le_bytes(raw.try_into().ok()?)),
                    ))
                }
                2 => {
                    let len = usize::try_from(self.varint()?).ok()?;
                    let end = self.pos.checked_add(len)?;
                    let raw = self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((field, Val::Bytes(raw)))
                }
                5 => {
                    let end = self.pos.checked_add(4)?;
                    self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((field, Val::Fixed32))
                }
                _ => None,
            }
        }
    }

    impl<'a> Iterator for Fields<'a> {
        type Item = (u32, Val<'a>);

        fn next(&mut self) -> Option<Self::Item> {
            if self.pos >= self.buf.len() {
                return None;
            }
            let item = self.parse_next();
            if item.is_none() {
                self.malformed = true;
            }
            item
        }
    }

    pub fn first_bytes(buf: &[u8], field: u32) -> Option<Vec<u8>> {
        Fields::new(buf)
            .find(|(number, value)| *number == field && value.bytes().is_some())
            .and_then(|(_, value)| value.bytes().map(<[u8]>::to_vec))
    }

    pub fn first_message(buf: &[u8], field: u32) -> Option<Vec<u8>> {
        first_bytes(buf, field)
    }

    pub fn first_str(buf: &[u8], field: u32) -> Option<String> {
        Fields::new(buf)
            .find(|(number, value)| *number == field && value.str().is_some())
            .and_then(|(_, value)| value.str().map(str::to_string))
    }

    pub fn is_complete_message(buf: &[u8]) -> bool {
        let mut fields = Fields::new(buf);
        while fields.next().is_some() {}
        !fields.is_malformed() && fields.consumed() == buf.len()
    }
}

fn decode_value_map(buf: &[u8], entry_field: u32) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (number, value) in wire::Fields::new(buf) {
        if number != entry_field {
            continue;
        }
        let Some(entry) = value.bytes() else {
            continue;
        };
        let mut key = None;
        let mut decoded = serde_json::Value::Null;
        for (entry_number, entry_value) in wire::Fields::new(entry) {
            match entry_number {
                1 => key = entry_value.str().map(str::to_string),
                2 => {
                    if let Some(bytes) = entry_value.bytes() {
                        decoded = decode_proto_value(bytes);
                    }
                }
                _ => {}
            }
        }
        if let Some(key) = key {
            map.insert(key, decoded);
        }
    }
    serde_json::Value::Object(map)
}

fn decode_proto_value(buf: &[u8]) -> serde_json::Value {
    for (number, value) in wire::Fields::new(buf) {
        match number {
            1 => return serde_json::Value::Null,
            2 => {
                if let Some(float) = value.f64() {
                    return serde_json::Number::from_f64(float)
                        .map(serde_json::Value::Number)
                        .unwrap_or(serde_json::Value::Null);
                }
            }
            3 => {
                if let Some(text) = value.str() {
                    return serde_json::Value::String(text.to_string());
                }
            }
            4 => {
                if let Some(flag) = value.u64() {
                    return serde_json::Value::Bool(flag != 0);
                }
            }
            5 => {
                if let Some(bytes) = value.bytes() {
                    return decode_value_map(bytes, 1);
                }
            }
            6 => {
                if let Some(bytes) = value.bytes() {
                    let items = wire::Fields::new(bytes)
                        .filter(|(field, _)| *field == 1)
                        .filter_map(|(_, item)| item.bytes().map(decode_proto_value))
                        .collect();
                    return serde_json::Value::Array(items);
                }
            }
            _ => {}
        }
    }
    serde_json::Value::Null
}

#[derive(Default)]
struct TurnTiming {
    duration_ms: Option<u64>,
    timestamp_ms: Option<u64>,
}

#[derive(Default)]
struct DecodedState {
    turn_blob_ids: Vec<Vec<u8>>,
    timings: Vec<TurnTiming>,
    started_ms: Option<u64>,
    repo_path: Option<String>,
    workspace_uris: Vec<String>,
    shell_cwd: Option<String>,
}

impl DecodedState {
    fn workspace_path(&self) -> Option<String> {
        if let Some(repo) = &self.repo_path {
            return Some(repo.clone());
        }
        if let Some(uri) = self.workspace_uris.last() {
            let path = uri.strip_prefix("file://").unwrap_or(uri);
            if !path.trim().is_empty() {
                return Some(path.to_string());
            }
        }
        self.shell_cwd.clone()
    }
}

fn decode_state(buf: &[u8]) -> DecodedState {
    let mut state = DecodedState::default();
    for (number, value) in wire::Fields::new(buf) {
        match number {
            8 => {
                if let Some(bytes) = value.bytes() {
                    state.turn_blob_ids.push(bytes.to_vec());
                }
            }
            9 => {
                if let Some(uri) = value.str() {
                    state.workspace_uris.push(uri.to_string());
                }
            }
            14 => {
                if let Some(bytes) = value.bytes() {
                    let mut timing = TurnTiming::default();
                    for (field, field_value) in wire::Fields::new(bytes) {
                        match field {
                            1 => timing.duration_ms = field_value.u64(),
                            2 => timing.timestamp_ms = field_value.u64(),
                            _ => {}
                        }
                    }
                    state.timings.push(timing);
                }
            }
            21 => {
                if let Some(bytes) = value.bytes()
                    && state.repo_path.is_none()
                {
                    state.repo_path =
                        wire::first_str(bytes, 1).filter(|path| !path.trim().is_empty());
                }
            }
            26 => state.started_ms = value.u64(),
            _ => {}
        }
    }
    state
}

fn ms_to_utc(ms: u64) -> Option<chrono::DateTime<Utc>> {
    Utc.timestamp_millis_opt(i64::try_from(ms).ok()?).single()
}

fn build_messages(
    connection: &Connection,
    state: &mut DecodedState,
    meta: &ChatMeta,
) -> Vec<ImportedAgentMessage> {
    let mut messages = Vec::new();
    let turn_blob_ids = state.turn_blob_ids.clone();
    for (index, turn_id) in turn_blob_ids.iter().enumerate() {
        let Some(turn_bytes) = read_blob(connection, turn_id) else {
            continue;
        };
        let timing = state.timings.get(index);
        let mut created_at = timing
            .and_then(|value| value.timestamp_ms)
            .and_then(ms_to_utc)
            .or_else(|| meta.created_at_ms.and_then(ms_to_utc))
            .or_else(|| state.started_ms.and_then(ms_to_utc));
        if let Some(agent_turn) = wire::first_message(&turn_bytes, 1) {
            let mut span = None;
            let mut assistant = Vec::new();
            for (number, value) in wire::Fields::new(&agent_turn) {
                if number != 2 {
                    continue;
                }
                let Some(step_ref) = value.bytes() else {
                    continue;
                };
                let step = read_blob(connection, step_ref).unwrap_or_else(|| step_ref.to_vec());
                fold_tool_span(&step, &mut span);
                decode_step(connection, &step, state, created_at, &mut assistant);
            }
            if created_at.is_none() {
                created_at = span.and_then(|(start, _)| ms_to_utc(start));
            }
            if let Some(model) = &meta.last_used_model {
                for message in &mut assistant {
                    if message.metadata.model.is_none() {
                        message.metadata.model = Some(model.clone());
                    }
                }
            }
            if let Some(user_ref) = wire::first_bytes(&agent_turn, 1) {
                let user = read_blob(connection, &user_ref).unwrap_or(user_ref);
                push_user_messages(connection, &user, created_at, &mut messages);
            }
            messages.extend(assistant);
        } else if let Some(shell_turn) = wire::first_message(&turn_bytes, 2) {
            push_shell_turn(connection, &shell_turn, index, created_at, &mut messages);
        }
    }
    messages
}

fn push_user_messages(
    connection: &Connection,
    msg: &[u8],
    created_at: Option<chrono::DateTime<Utc>>,
    messages: &mut Vec<ImportedAgentMessage>,
) {
    if let Some(text) = decode_user_text(connection, msg).filter(|text| !text.trim().is_empty()) {
        messages.push(ImportedAgentMessage {
            role: ImportedAgentMessageRole::User,
            content: text,
            created_at,
            metadata: ImportedAgentMessageMetadata::default(),
        });
    }
    for placeholder in decode_user_image_placeholders(connection, msg) {
        messages.push(ImportedAgentMessage {
            role: ImportedAgentMessageRole::User,
            content: placeholder,
            created_at,
            metadata: ImportedAgentMessageMetadata {
                kind: Some("image".to_string()),
                ..Default::default()
            },
        });
    }
}

fn decode_user_text(connection: &Connection, msg: &[u8]) -> Option<String> {
    let text = wire::first_str(msg, 1).filter(|value| !value.is_empty());
    if text.is_some() {
        return text;
    }
    if let Some(id) = wire::first_bytes(msg, 18)
        && let Some(blob) = read_blob(connection, &id)
        && let Ok(text) = String::from_utf8(blob)
        && !text.is_empty()
    {
        return Some(text);
    }
    wire::first_str(msg, 8).filter(|value| !value.is_empty())
}

fn decode_user_image_placeholders(connection: &Connection, msg: &[u8]) -> Vec<String> {
    let mut placeholders = Vec::new();
    for (number, value) in wire::Fields::new(msg) {
        if number != 3 {
            continue;
        }
        let Some(attachment) = value.bytes() else {
            continue;
        };
        let Some(image) = wire::first_message(attachment, 1) else {
            continue;
        };
        let mime = wire::first_str(&image, 7)
            .filter(|value| value.starts_with("image/"))
            .unwrap_or_else(|| "image".to_string());
        if wire::first_bytes(&image, 1)
            .and_then(|id| read_blob(connection, &id))
            .is_some_and(|bytes| !bytes.is_empty())
        {
            placeholders.push(format!("[image: {mime}]"));
        }
    }
    placeholders
}

fn push_shell_turn(
    connection: &Connection,
    shell_turn: &[u8],
    index: usize,
    created_at: Option<chrono::DateTime<Utc>>,
    messages: &mut Vec<ImportedAgentMessage>,
) {
    let command = wire::first_bytes(shell_turn, 1)
        .and_then(|id| {
            let msg = read_blob(connection, &id).unwrap_or(id);
            wire::first_str(&msg, 1)
        })
        .unwrap_or_default();
    if command.trim().is_empty() {
        return;
    }
    messages.push(ImportedAgentMessage {
        role: ImportedAgentMessageRole::User,
        content: format!("! {command}"),
        created_at,
        metadata: ImportedAgentMessageMetadata::default(),
    });
    let tool_call_id = format!("cursor-shell-{index}");
    let input = serde_json::json!({ "command": command });
    messages.push(ImportedAgentMessage {
        role: ImportedAgentMessageRole::Tool,
        content: format!("[tool: shell]\ninput: {command}"),
        created_at,
        metadata: ImportedAgentMessageMetadata {
            kind: Some("tool_call".to_string()),
            tool_call_id: Some(tool_call_id.clone()),
            tool_name: Some("shell".to_string()),
            raw_input: Some(input),
            ..Default::default()
        },
    });
    let output = wire::first_bytes(shell_turn, 2).map(|id| {
        let msg = read_blob(connection, &id).unwrap_or(id);
        let stdout = wire::first_str(&msg, 1).unwrap_or_default();
        let stderr = wire::first_str(&msg, 2).unwrap_or_default();
        let exit_code = wire::Fields::new(&msg)
            .find(|(field, _)| *field == 3)
            .and_then(|(_, value)| value.i32())
            .unwrap_or(0);
        (join_streams(&stdout, &stderr), exit_code)
    });
    let (preview, exit_code) = output.unwrap_or((None, 0));
    messages.push(ImportedAgentMessage {
        role: ImportedAgentMessageRole::Tool,
        content: preview.clone().unwrap_or_default(),
        created_at,
        metadata: ImportedAgentMessageMetadata {
            kind: Some("tool_result".to_string()),
            tool_call_id: Some(tool_call_id),
            tool_name: Some("shell".to_string()),
            tool_status: Some(if exit_code == 0 {
                "completed".to_string()
            } else {
                "failed".to_string()
            }),
            raw_output: preview.map(serde_json::Value::String),
            ..Default::default()
        },
    });
}

fn fold_tool_span(step: &[u8], span: &mut Option<(u64, u64)>) {
    let Some(tool_call) = wire::first_message(step, 2) else {
        return;
    };
    for (number, value) in wire::Fields::new(&tool_call) {
        if number != 59 && number != 60 {
            continue;
        }
        let Some(ms) = value.u64().filter(|ms| *ms > 0) else {
            continue;
        };
        *span = Some(match *span {
            Some((lo, hi)) => (lo.min(ms), hi.max(ms)),
            None => (ms, ms),
        });
    }
}

fn decode_step(
    connection: &Connection,
    step: &[u8],
    state: &mut DecodedState,
    created_at: Option<chrono::DateTime<Utc>>,
    messages: &mut Vec<ImportedAgentMessage>,
) {
    for (number, value) in wire::Fields::new(step) {
        let Some(body) = value.bytes() else {
            continue;
        };
        match number {
            1 => {
                if let Some(text) = wire::first_str(body, 1).filter(|text| !text.is_empty()) {
                    if let Some(last) = messages.last_mut()
                        && last.role == ImportedAgentMessageRole::Assistant
                        && last.metadata.kind.is_none()
                    {
                        last.content.push_str(&text);
                    } else {
                        messages.push(ImportedAgentMessage {
                            role: ImportedAgentMessageRole::Assistant,
                            content: text,
                            created_at,
                            metadata: ImportedAgentMessageMetadata {
                                model: None,
                                ..Default::default()
                            },
                        });
                    }
                }
            }
            2 => decode_tool_call(connection, body, state, created_at, messages),
            3 => {
                if let Some(text) = wire::first_str(body, 1).filter(|text| !text.is_empty()) {
                    messages.push(ImportedAgentMessage {
                        role: ImportedAgentMessageRole::Assistant,
                        content: text,
                        created_at,
                        metadata: ImportedAgentMessageMetadata {
                            kind: Some("reasoning".to_string()),
                            ..Default::default()
                        },
                    });
                }
            }
            _ => {}
        }
    }
}

fn tool_name_for_field(number: u32) -> Option<&'static str> {
    Some(match number {
        1 => "shell",
        3 => "delete",
        4 => "glob",
        5 => "grep",
        8 => "read",
        9 => "update_todos",
        10 => "read_todos",
        12 => "edit",
        13 => "ls",
        14 => "read_lints",
        15 => "mcp",
        16 => "sem_search",
        17 => "create_plan",
        18 => "web_search",
        19 => "task",
        20 => "list_mcp_resources",
        21 => "read_mcp_resource",
        22 => "apply_agent_diff",
        23 => "ask_question",
        24 => "fetch",
        25 => "switch_mode",
        28 => "generate_image",
        37 => "web_fetch",
        42 => "await",
        55 => "send_message",
        58 => "send_to_user",
        61 => "pi_read",
        62 => "pi_bash",
        63 => "pi_edit",
        64 => "pi_write",
        65 => "pi_grep",
        66 => "pi_find",
        67 => "pi_ls",
        _ => return None,
    })
}

struct DecodedTool {
    name: String,
    input: Option<serde_json::Value>,
    output: Option<String>,
    is_error: bool,
}

fn decode_tool_call(
    connection: &Connection,
    body: &[u8],
    state: &mut DecodedState,
    created_at: Option<chrono::DateTime<Utc>>,
    messages: &mut Vec<ImportedAgentMessage>,
) {
    let mut tool = None;
    let mut tool_call_id = None;
    for (number, value) in wire::Fields::new(body) {
        match number {
            57 => tool_call_id = value.str().map(str::to_string),
            _ => {
                if tool.is_none()
                    && let (Some(name), Some(payload)) =
                        (tool_name_for_field(number), value.bytes())
                {
                    tool = Some(decode_tool_variant(
                        connection, number, name, payload, state,
                    ));
                }
            }
        }
    }
    let Some(tool) = tool else {
        return;
    };
    let id = tool_call_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("cursor-tool-{}", messages.len()));
    let input_preview = tool
        .input
        .as_ref()
        .and_then(|value| serde_json::to_string(value).ok());
    messages.push(ImportedAgentMessage {
        role: ImportedAgentMessageRole::Tool,
        content: format!(
            "[tool: {}]{}",
            tool.name,
            input_preview
                .as_ref()
                .map(|value| format!("\ninput: {value}"))
                .unwrap_or_default()
        ),
        created_at,
        metadata: ImportedAgentMessageMetadata {
            kind: Some("tool_call".to_string()),
            tool_call_id: Some(id.clone()),
            tool_name: Some(tool.name.clone()),
            raw_input: tool.input,
            ..Default::default()
        },
    });
    messages.push(ImportedAgentMessage {
        role: ImportedAgentMessageRole::Tool,
        content: tool.output.clone().unwrap_or_default(),
        created_at,
        metadata: ImportedAgentMessageMetadata {
            kind: Some("tool_result".to_string()),
            tool_call_id: Some(id),
            tool_name: Some(tool.name),
            tool_status: Some(if tool.is_error {
                "failed".to_string()
            } else {
                "completed".to_string()
            }),
            raw_output: tool.output.map(serde_json::Value::String),
            ..Default::default()
        },
    });
}

fn decode_tool_variant(
    connection: &Connection,
    field: u32,
    name: &str,
    payload: &[u8],
    state: &mut DecodedState,
) -> DecodedTool {
    let args = wire::first_message(payload, 1);
    let result = wire::first_message(payload, 2);
    let mut tool = DecodedTool {
        name: name.to_string(),
        input: None,
        output: None,
        is_error: false,
    };
    match field {
        1 => {
            if let Some(args) = &args {
                let command = wire::first_str(args, 1);
                if let Some(cwd) = wire::first_str(args, 2).filter(|value| !value.trim().is_empty())
                {
                    state.shell_cwd.get_or_insert(cwd);
                }
                tool.input = Some(json_obj(&[
                    ("command", command),
                    ("description", wire::first_str(args, 15)),
                ]));
            }
            if let Some(result) = &result {
                for (number, value) in wire::Fields::new(result) {
                    let Some(body) = value.bytes() else {
                        continue;
                    };
                    match number {
                        1 | 2 => {
                            let interleaved = if number == 1 { 10 } else { 9 };
                            tool.output = wire::first_str(body, interleaved)
                                .filter(|value| !value.is_empty())
                                .or_else(|| {
                                    join_streams(
                                        &wire::first_str(body, 5).unwrap_or_default(),
                                        &wire::first_str(body, 6).unwrap_or_default(),
                                    )
                                });
                            let exit_code = wire::Fields::new(body)
                                .find(|(field, _)| *field == 3)
                                .and_then(|(_, value)| value.i32())
                                .unwrap_or(0);
                            tool.is_error = number == 2 || exit_code != 0;
                            break;
                        }
                        3 => {
                            tool.output = Some("Command timed out".to_string());
                            tool.is_error = true;
                            break;
                        }
                        4 => {
                            tool.output = Some("Command rejected".to_string());
                            tool.is_error = true;
                            break;
                        }
                        5 | 7 => {
                            tool.output = wire::first_str(body, 1);
                            tool.is_error = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        3 => {
            tool.input = args
                .as_deref()
                .map(|args| json_obj(&[("file_path", wire::first_str(args, 1))]));
        }
        4 => {
            if let Some(args) = &args {
                tool.input = Some(json_obj(&[
                    ("pattern", wire::first_str(args, 2)),
                    ("path", wire::first_str(args, 1)),
                ]));
            }
            if let Some(success) = result
                .as_deref()
                .and_then(|result| wire::first_message(result, 1))
            {
                let files: Vec<String> = wire::Fields::new(&success)
                    .filter(|(number, _)| *number == 3)
                    .filter_map(|(_, value)| value.str().map(str::to_string))
                    .collect();
                if !files.is_empty() {
                    tool.output = Some(files.join("\n"));
                }
            }
        }
        5 => {
            if let Some(args) = &args {
                tool.input = Some(json_obj(&[
                    ("pattern", wire::first_str(args, 1)),
                    ("path", wire::first_str(args, 2)),
                    ("glob", wire::first_str(args, 3)),
                ]));
            }
        }
        8 => {
            if let Some(args) = &args {
                tool.input = Some(json_obj(&[("file_path", wire::first_str(args, 1))]));
            }
            if let Some(result) = &result {
                if let Some(success) = wire::first_message(result, 1) {
                    tool.output = wire::first_str(&success, 1)
                        .filter(|value| !value.is_empty())
                        .or_else(|| {
                            wire::first_bytes(&success, 10)
                                .and_then(|id| read_blob(connection, &id))
                                .and_then(|bytes| String::from_utf8(bytes).ok())
                        });
                } else if let Some(error) = wire::first_message(result, 2) {
                    tool.output = wire::first_str(&error, 1);
                    tool.is_error = true;
                }
            }
        }
        12 => {
            tool.input = args
                .as_deref()
                .map(|args| json_obj(&[("file_path", wire::first_str(args, 1))]));
            if let Some(result) = &result {
                for (number, value) in wire::Fields::new(result) {
                    let Some(body) = value.bytes() else {
                        continue;
                    };
                    match number {
                        1 => {
                            tool.output = wire::first_str(body, 5)
                                .filter(|value| !value.is_empty())
                                .or_else(|| wire::first_str(body, 8));
                            break;
                        }
                        2..=7 => {
                            tool.output =
                                wire::first_str(body, 2).or_else(|| wire::first_str(body, 1));
                            tool.is_error = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        13 => {
            tool.input = args
                .as_deref()
                .map(|args| json_obj(&[("path", wire::first_str(args, 1))]));
        }
        15 => {
            if let Some(args) = &args {
                let server = wire::first_str(args, 9).or_else(|| wire::first_str(args, 4));
                let tool_name = wire::first_str(args, 5).or_else(|| wire::first_str(args, 1));
                tool.name = match (server.filter(|value| !value.is_empty()), tool_name) {
                    (Some(server), Some(name)) => format!("{server}__{name}"),
                    (None, Some(name)) => name,
                    _ => "mcp".to_string(),
                };
                let decoded = decode_value_map(args, 2);
                if decoded.as_object().is_some_and(|map| !map.is_empty()) {
                    tool.input = Some(decoded);
                }
            }
            if let Some(result) = &result {
                if let Some(success) = wire::first_message(result, 1) {
                    let texts: Vec<String> = wire::Fields::new(&success)
                        .filter(|(number, _)| *number == 1)
                        .filter_map(|(_, value)| {
                            value.bytes().and_then(|item| {
                                wire::first_message(item, 1)
                                    .and_then(|text| wire::first_str(&text, 1))
                            })
                        })
                        .collect();
                    if !texts.is_empty() {
                        tool.output = Some(texts.join("\n"));
                    }
                } else if let Some(error) = wire::first_message(result, 2) {
                    tool.output = wire::first_str(&error, 1);
                    tool.is_error = true;
                }
            }
        }
        18 | 24 | 37 => {
            tool.input = args.as_deref().map(|args| {
                json_obj(&[
                    ("query", wire::first_str(args, 1)),
                    ("url", wire::first_str(args, 1)),
                ])
            });
        }
        19 => {
            if let Some(args) = &args {
                tool.input = Some(json_obj(&[
                    ("description", wire::first_str(args, 1)),
                    ("prompt", wire::first_str(args, 2)),
                ]));
            }
            if let Some(result) = &result {
                if let Some(success) = wire::first_message(result, 1) {
                    tool.output = task_report_text(&success);
                } else if let Some(error) = wire::first_message(result, 2) {
                    tool.output = wire::first_str(&error, 1);
                    tool.is_error = true;
                }
            }
        }
        23 => {
            if let Some(args) = &args {
                let questions: Vec<serde_json::Value> = wire::Fields::new(args)
                    .filter(|(number, _)| *number == 2)
                    .filter_map(|(_, value)| {
                        value
                            .bytes()
                            .and_then(|question| wire::first_str(question, 2))
                    })
                    .map(serde_json::Value::String)
                    .collect();
                tool.input = Some(serde_json::json!({
                    "title": wire::first_str(args, 1),
                    "questions": questions,
                }));
            }
        }
        _ => {
            if let Some(args) = &args {
                tool.input =
                    wire::first_str(args, 1).map(|value| serde_json::json!({ "input": value }));
            }
            if let Some(result) = &result {
                tool.output = wire::first_str(result, 1);
            }
        }
    }
    tool
}

fn task_report_text(success: &[u8]) -> Option<String> {
    let mut layer = wire::first_message(success, 1)?;
    for _ in 0..3 {
        let payload = wire::first_bytes(&layer, 1)?;
        if let Ok(text) = std::str::from_utf8(&payload)
            && !text.trim().is_empty()
            && text
                .chars()
                .all(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
        {
            return Some(text.to_string());
        }
        if !wire::is_complete_message(&payload) {
            return None;
        }
        layer = payload;
    }
    None
}

fn json_obj(entries: &[(&str, Option<String>)]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        if let Some(value) = value.clone().filter(|value| !value.is_empty()) {
            map.insert((*key).to_string(), serde_json::Value::String(value));
        }
    }
    serde_json::Value::Object(map)
}

fn join_streams(stdout: &str, stderr: &str) -> Option<String> {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => None,
        (false, true) => Some(stdout.to_string()),
        (true, false) => Some(stderr.to_string()),
        (false, false) => Some(format!("{stdout}\n{stderr}")),
    }
}

fn nonempty_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn read_json(path: PathBuf) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn collect_store_databases(
    path: &Path,
    stores: &mut Vec<PathBuf>,
) -> Result<(), AgentHistoryError> {
    collect_store_databases_inner(path, stores, &mut std::collections::HashSet::new())
}

fn collect_store_databases_inner(
    path: &Path,
    stores: &mut Vec<PathBuf>,
    visited: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), AgentHistoryError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        if path.file_name().and_then(|name| name.to_str()) == Some("store.db") {
            stores.push(path.to_path_buf());
        }
        return Ok(());
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    if !visited.insert(canonical) {
        return Ok(());
    }
    for entry in std::fs::read_dir(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })? {
        let entry = entry.map_err(|error| AgentHistoryError::Read {
            path: path.to_path_buf(),
            error: error.to_string(),
        })?;
        let candidate = entry.path();
        let candidate_metadata =
            std::fs::symlink_metadata(&candidate).map_err(|error| AgentHistoryError::Read {
                path: candidate.clone(),
                error: error.to_string(),
            })?;
        if candidate_metadata.file_type().is_symlink() {
            continue;
        }
        if candidate_metadata.is_dir() {
            collect_store_databases_inner(&candidate, stores, visited)?;
        } else if candidate.file_name().and_then(|name| name.to_str()) == Some("store.db") {
            stores.push(candidate);
        }
    }
    Ok(())
}

fn parse_error(path: &Path, error: impl std::fmt::Display) -> AgentHistoryError {
    AgentHistoryError::Parse {
        path: path.to_path_buf(),
        error: error.to_string(),
    }
}

#[cfg(test)]
pub(super) mod proto {
    pub fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
        out
    }

    pub fn field_bytes(field: u32, bytes: &[u8]) -> Vec<u8> {
        let mut out = varint(u64::from(field << 3 | 2));
        out.extend(varint(bytes.len() as u64));
        out.extend_from_slice(bytes);
        out
    }

    pub fn field_str(field: u32, value: &str) -> Vec<u8> {
        field_bytes(field, value.as_bytes())
    }

    pub fn field_varint(field: u32, value: u64) -> Vec<u8> {
        let mut out = varint(u64::from(field << 3));
        out.extend(varint(value));
        out
    }
}
