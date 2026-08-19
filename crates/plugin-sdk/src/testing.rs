//! In-memory Host harness for plugin Worker unit tests.
//!
//! Fidelity gap versus a real VibeX Host:
//! - `storage.database` is an in-memory SQL subset, not the Host-owned plugin file.
//! - `artifact.preview` leases are tokens only; no TCP port or capability process.
//! - `plugin.self.doctor` reports harness state, not Host-persisted crashes.
//! - `runtime.execute`, `network.fetch`, `files.*`, `conversation.*`, `events.*`,
//!   `app.notify`, and `agent.invoke` always fail with `capability_unimplemented`.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::{
    error::PluginSdkError,
    host::{HostClient, HostTransport},
    protocol::PluginContext,
    worker::{
        ActivatedPluginWorker, PluginWorkerDefinition, WorkerLog, WorkerLogger,
        activate_plugin_worker,
    },
};

const KV_VALUE_LIMIT: usize = 256 * 1024;
const KV_TOTAL_LIMIT: usize = 32 * 1024 * 1024;
const ARTIFACT_TEXT_LIMIT: usize = 16 * 1024 * 1024;
const LOG_LIMIT: usize = 16 * 1024;

const IMPLEMENTED: &[&str] = &[
    "storage.settings.get",
    "storage.settings.put",
    "storage.kv.get",
    "storage.kv.put",
    "storage.kv.delete",
    "storage.kv.list",
    "storage.database.execute",
    "storage.database.query",
    "secrets.get",
    "secrets.put",
    "secrets.delete",
    "log.debug",
    "log.info",
    "log.warn",
    "log.error",
    "artifact.preview.open",
    "artifact.preview.close",
    "artifact.readText",
    "artifact.writeText",
    "plugin.self.doctor",
];

#[derive(Clone, Debug)]
pub struct HostCall {
    pub capability: String,
    pub operation: String,
    pub input: Value,
}

struct MemoryState {
    calls: Vec<HostCall>,
    settings: Map<String, Value>,
    kv: BTreeMap<String, Value>,
    secrets: BTreeMap<String, String>,
    logs: Vec<Value>,
    leases: BTreeMap<String, Value>,
    artifact: ArtifactState,
    tables: BTreeMap<String, Table>,
    lease_seq: AtomicU64,
}

#[derive(Clone)]
struct ArtifactState {
    name: String,
    content: String,
    revision: String,
    generation: u64,
}

struct Table {
    columns: Vec<String>,
    rows: Vec<Map<String, Value>>,
}

pub struct MemoryHost {
    state: Mutex<MemoryState>,
}

impl MemoryHost {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MemoryState {
                calls: Vec::new(),
                settings: Map::new(),
                kv: BTreeMap::new(),
                secrets: BTreeMap::new(),
                logs: Vec::new(),
                leases: BTreeMap::new(),
                artifact: ArtifactState {
                    name: "memory.txt".to_owned(),
                    content: String::new(),
                    revision: "sha256:test-0".to_owned(),
                    generation: 0,
                },
                tables: BTreeMap::new(),
                lease_seq: AtomicU64::new(0),
            }),
        }
    }

    pub fn calls(&self) -> Vec<HostCall> {
        self.state.lock().expect("memory host").calls.clone()
    }

    pub fn logs(&self) -> Vec<Value> {
        self.state.lock().expect("memory host").logs.clone()
    }

    fn dispatch(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError> {
        let key = format!("{capability}.{operation}");
        if !IMPLEMENTED.contains(&key.as_str()) {
            return Err(PluginSdkError::new(
                "capability_unimplemented",
                format!("{key} is not implemented by the in-memory harness"),
            ));
        }
        let mut state = self.state.lock().expect("memory host");
        state.calls.push(HostCall {
            capability: capability.to_owned(),
            operation: operation.to_owned(),
            input: input.clone(),
        });
        match key.as_str() {
            "storage.settings.get" => Ok(Value::Object(state.settings.clone())),
            "storage.settings.put" => settings_put(&mut state, input),
            "storage.kv.get" => Ok(state
                .kv
                .get(&required_string(&input, "key")?)
                .cloned()
                .unwrap_or(Value::Null)),
            "storage.kv.put" => kv_put(&mut state, input),
            "storage.kv.delete" => {
                state.kv.remove(&required_string(&input, "key")?);
                Ok(Value::Null)
            }
            "storage.kv.list" => Ok(Value::Array(
                state.kv.keys().cloned().map(Value::String).collect(),
            )),
            "storage.database.execute" => db_run(&mut state, input, false),
            "storage.database.query" => db_run(&mut state, input, true),
            "secrets.get" => secrets_get(&state, input),
            "secrets.put" => {
                let name = required_string(&input, "name")?;
                let value = input
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                state.secrets.insert(name, value);
                Ok(json!({ "present": true }))
            }
            "secrets.delete" => {
                state.secrets.remove(&required_string(&input, "name")?);
                Ok(json!({ "present": false }))
            }
            "log.debug" | "log.info" | "log.warn" | "log.error" => {
                let level = operation;
                append_log(&mut state, level, input);
                Ok(json!({}))
            }
            "artifact.preview.open" => preview_open(&mut state, input),
            "artifact.preview.close" => preview_close(&mut state, input),
            "artifact.readText" => artifact_read(&state, input),
            "artifact.writeText" => artifact_write(&mut state, input),
            "plugin.self.doctor" => Ok(json!({
                "pluginId": "dev.vibex.test",
                "diagnostics": [],
                "recentCrashes": [],
                "implemented": IMPLEMENTED,
                "logs": state.logs,
                "directNetworkPossible": true
            })),
            _ => Err(PluginSdkError::new(
                "capability_unimplemented",
                format!("{key} is not implemented by the in-memory harness"),
            )),
        }
    }
}

impl Default for MemoryHost {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl HostTransport for MemoryHost {
    async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError> {
        self.dispatch(capability, operation, input)
    }
}

struct MemoryLogger {
    host: Arc<MemoryHost>,
}

impl WorkerLogger for MemoryLogger {
    fn log(&self, level: &str, message: &str, fields: Option<&Value>) {
        let mut state = self.host.state.lock().expect("memory host");
        append_log(
            &mut state,
            level,
            json!({ "message": message, "fields": fields }),
        );
    }
}

pub struct WorkerHarness {
    worker: ActivatedPluginWorker,
    pub host: Arc<MemoryHost>,
}

impl WorkerHarness {
    pub fn handlers(&self) -> Vec<String> {
        self.worker.handlers()
    }

    pub fn host_calls(&self) -> Vec<HostCall> {
        self.host.calls()
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, PluginSdkError> {
        self.worker.invoke(handler, input).await
    }

    pub async fn dispose(&self) -> Result<(), PluginSdkError> {
        self.worker.dispose().await
    }
}

pub fn create_worker_harness(
    definition: &PluginWorkerDefinition,
    context: Option<PluginContext>,
    host: Option<Arc<MemoryHost>>,
) -> Result<WorkerHarness, PluginSdkError> {
    let host = host.unwrap_or_else(|| Arc::new(MemoryHost::new()));
    let context = context.unwrap_or(PluginContext {
        plugin_id: "dev.vibex.test".to_owned(),
        plugin_version: "0.0.0-test".to_owned(),
        generation: 1,
        package_class: crate::protocol::PackageClass::FullTrust,
        granted_capabilities: vec!["*".to_owned()],
    });
    let log = WorkerLog::new(Arc::new(MemoryLogger {
        host: Arc::clone(&host),
    }));
    let worker = activate_plugin_worker(definition, context, HostClient::new(host.clone()), log)?;
    worker.mark_active();
    Ok(WorkerHarness { worker, host })
}

pub struct GenerationHarness {
    active: WorkerHarness,
    context: Option<PluginContext>,
    host: Option<Arc<MemoryHost>>,
    required: Vec<String>,
    pub generation: u64,
}

impl GenerationHarness {
    pub fn handlers(&self) -> Vec<String> {
        self.active.handlers()
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, PluginSdkError> {
        self.active.invoke(handler, input).await
    }

    pub async fn activate_candidate(
        &mut self,
        definition: &PluginWorkerDefinition,
    ) -> Result<u64, PluginSdkError> {
        let next = self.generation + 1;
        let mut context = self.context.clone().unwrap_or(PluginContext {
            plugin_id: "dev.vibex.test".to_owned(),
            plugin_version: "0.0.0-test".to_owned(),
            generation: next,
            package_class: crate::protocol::PackageClass::FullTrust,
            granted_capabilities: vec!["*".to_owned()],
        });
        context.generation = next;
        let candidate = create_worker_harness(definition, Some(context), self.host.clone())?;
        if let Err(error) = assert_required(&candidate, &self.required) {
            let _ = candidate.dispose().await;
            return Err(error);
        }
        let previous = std::mem::replace(&mut self.active, candidate);
        self.generation = next;
        previous.dispose().await?;
        Ok(self.generation)
    }

    pub async fn dispose(&self) -> Result<(), PluginSdkError> {
        self.active.dispose().await
    }
}

pub fn create_generation_harness(
    definition: &PluginWorkerDefinition,
    context: Option<PluginContext>,
    host: Option<Arc<MemoryHost>>,
    required_handlers: &[&str],
) -> Result<GenerationHarness, PluginSdkError> {
    let generation = context.as_ref().map(|item| item.generation).unwrap_or(1);
    let active = create_worker_harness(definition, context.clone(), host.clone())?;
    assert_required(
        &active,
        &required_handlers
            .iter()
            .map(|item| (*item).to_owned())
            .collect::<Vec<_>>(),
    )?;
    Ok(GenerationHarness {
        active,
        context,
        host,
        required: required_handlers
            .iter()
            .map(|item| (*item).to_owned())
            .collect(),
        generation,
    })
}

fn assert_required(worker: &WorkerHarness, required: &[String]) -> Result<(), PluginSdkError> {
    for handler in required {
        if !worker.handlers().iter().any(|item| item == handler) {
            return Err(PluginSdkError::new(
                "required_handler_missing",
                format!("Required handler {handler} is not registered"),
            ));
        }
    }
    Ok(())
}

fn settings_put(state: &mut MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    let object = input
        .get("value")
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| input.as_object().cloned())
        .ok_or_else(|| {
            PluginSdkError::new("config_schema_invalid", "settings.put requires an object")
        })?;
    state.settings = object.clone();
    Ok(Value::Object(object))
}

fn kv_put(state: &mut MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    let key = required_string(&input, "key")?;
    let value = input.get("value").cloned().unwrap_or(Value::Null);
    let encoded = serde_json::to_vec(&value).unwrap_or_default();
    if encoded.len() > KV_VALUE_LIMIT {
        return Err(PluginSdkError::new(
            "kv_quota_exceeded",
            "KV value exceeds 256 KiB",
        ));
    }
    let previous = state
        .kv
        .get(&key)
        .map(|item| serde_json::to_vec(item).unwrap_or_default().len())
        .unwrap_or(0);
    let total = kv_bytes(state) - previous + encoded.len();
    if total > KV_TOTAL_LIMIT {
        return Err(PluginSdkError::new(
            "kv_quota_exceeded",
            "KV store exceeds 32 MiB",
        ));
    }
    state.kv.insert(key, value.clone());
    Ok(value)
}

fn kv_bytes(state: &MemoryState) -> usize {
    state
        .kv
        .values()
        .map(|item| serde_json::to_vec(item).unwrap_or_default().len())
        .sum()
}

fn secrets_get(state: &MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    let name = required_string(&input, "name")?;
    Ok(match state.secrets.get(&name) {
        Some(value) => json!({ "present": true, "value": value }),
        None => json!({ "present": false }),
    })
}

fn append_log(state: &mut MemoryState, level: &str, input: Value) {
    let mut message = input
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if message.len() > LOG_LIMIT {
        message.truncate(LOG_LIMIT);
    }
    let fields = redact(input.get("fields").cloned().unwrap_or(Value::Null));
    state.logs.push(json!({
        "level": level,
        "message": message,
        "fields": fields
    }));
}

fn preview_open(state: &mut MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    if input
        .get("artifactHandle")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(PluginSdkError::new(
            "artifact_handle_invalid",
            "artifactHandle is required",
        ));
    }
    let seq = state.lease_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let lease_id = format!("lease-{seq}");
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|item| item.as_millis() as u64)
        .unwrap_or(0)
        + 300_000;
    let lease = json!({
        "leaseId": lease_id,
        "port": 0,
        "capabilityToken": format!("test-token-{lease_id}"),
        "expiresAtUnixMs": expires,
        "providerId": input.get("providerId"),
        "artifactHandle": input.get("artifactHandle"),
    });
    state.leases.insert(lease_id.clone(), lease.clone());
    Ok(json!({
        "leaseId": lease_id,
        "port": 0,
        "capabilityToken": format!("test-token-{lease_id}"),
        "expiresAtUnixMs": expires
    }))
}

fn preview_close(state: &mut MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    let lease_id = required_string(&input, "leaseId")?;
    if state.leases.remove(&lease_id).is_none() {
        return Err(PluginSdkError::new(
            "preview_not_open",
            "Preview lease is not open",
        ));
    }
    Ok(json!({}))
}

fn artifact_read(state: &MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    if let Some(artifact_id) = input.get("artifactId").and_then(Value::as_str)
        && artifact_id != "memory"
        && artifact_id != state.artifact.name
    {
        return Err(PluginSdkError::new(
            "artifact_not_found",
            "Artifact was not found",
        ));
    }
    Ok(json!({
        "name": state.artifact.name,
        "content": state.artifact.content,
        "revision": state.artifact.revision
    }))
}

fn artifact_write(state: &mut MemoryState, input: Value) -> Result<Value, PluginSdkError> {
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if content.len() > ARTIFACT_TEXT_LIMIT {
        return Err(PluginSdkError::new(
            "network_body_too_large",
            "Artifact text exceeds 16 MiB",
        ));
    }
    if let Some(expected) = input.get("expectedRevision").and_then(Value::as_str)
        && expected != state.artifact.revision
    {
        return Err(PluginSdkError::new(
            "artifact_revision_conflict",
            "The artifact changed outside this editor",
        ));
    }
    state.artifact.generation += 1;
    state.artifact.content = content;
    state.artifact.revision = format!("sha256:test-{}", state.artifact.generation);
    Ok(json!({ "revision": state.artifact.revision }))
}

fn db_run(state: &mut MemoryState, input: Value, query: bool) -> Result<Value, PluginSdkError> {
    let sql = input
        .get("sql")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "sql is required"))?;
    let params = input
        .get("params")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let statement = single_sql(sql)?;
    let expanded = bind_params(&statement, &params)?;
    execute_sql(state, &expanded, query)
}

fn single_sql(sql: &str) -> Result<String, PluginSdkError> {
    let stripped = sql.trim().trim_end_matches(';').trim();
    if stripped.is_empty() {
        return Err(PluginSdkError::new("db_sql_denied", "sql is required"));
    }
    if stripped.contains(';') {
        return Err(PluginSdkError::new(
            "db_sql_denied",
            "SQL must be a single statement",
        ));
    }
    let leading = stripped
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if leading == "ATTACH" || leading == "PRAGMA" {
        return Err(PluginSdkError::new(
            "db_sql_denied",
            "ATTACH and PRAGMA are not allowed",
        ));
    }
    Ok(stripped.to_owned())
}

fn bind_params(sql: &str, params: &[Value]) -> Result<String, PluginSdkError> {
    let mut out = String::new();
    let mut index = 0;
    let mut in_string = false;
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' {
            out.push(ch);
            in_string = !in_string;
            i += 1;
            continue;
        }
        if ch == '?' && !in_string {
            let value = params
                .get(index)
                .ok_or_else(|| PluginSdkError::new("db_sql_denied", "not enough SQL parameters"))?;
            out.push_str(&sql_literal(value));
            index += 1;
            i += 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    if index != params.len() {
        return Err(PluginSdkError::new(
            "db_sql_denied",
            "unused SQL parameters",
        ));
    }
    Ok(out)
}

fn sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_owned(),
        Value::Bool(flag) => {
            if *flag {
                "1".to_owned()
            } else {
                "0".to_owned()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

fn execute_sql(state: &mut MemoryState, sql: &str, query: bool) -> Result<Value, PluginSdkError> {
    let tokens = tokenize(sql);
    if tokens.is_empty() {
        return Err(PluginSdkError::new("db_sql_denied", "sql is required"));
    }
    match tokens[0].to_ascii_uppercase().as_str() {
        "CREATE" => create_table(state, &tokens),
        "INSERT" => insert_row(state, &tokens),
        "SELECT" => select_rows(state, &tokens),
        "UPDATE" => update_rows(state, &tokens),
        "DELETE" => delete_rows(state, &tokens),
        other if query => Err(PluginSdkError::new(
            "db_sql_denied",
            format!("unsupported query {other}"),
        )),
        other => Err(PluginSdkError::new(
            "db_sql_denied",
            format!("unsupported statement {other}"),
        )),
    }
}

fn create_table(state: &mut MemoryState, tokens: &[String]) -> Result<Value, PluginSdkError> {
    let if_not_exists = tokens.len() > 4
        && tokens[1].eq_ignore_ascii_case("TABLE")
        && tokens[2].eq_ignore_ascii_case("IF")
        && tokens[3].eq_ignore_ascii_case("NOT")
        && tokens[4].eq_ignore_ascii_case("EXISTS");
    let name_index = if if_not_exists { 5 } else { 2 };
    let name = tokens
        .get(name_index)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "CREATE TABLE requires a name"))?;
    if state.tables.contains_key(name) {
        if if_not_exists {
            return Ok(json!({ "rows": [], "changes": 0 }));
        }
        return Err(PluginSdkError::new(
            "db_sql_denied",
            format!("table {name} already exists"),
        ));
    }
    let open = tokens
        .iter()
        .position(|item| item == "(")
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "CREATE TABLE requires columns"))?;
    let close = tokens
        .iter()
        .rposition(|item| item == ")")
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "CREATE TABLE requires columns"))?;
    let mut columns = Vec::new();
    let mut skip_type = false;
    for token in &tokens[open + 1..close] {
        if token == "," {
            skip_type = false;
            continue;
        }
        if skip_type {
            continue;
        }
        columns.push(token.clone());
        skip_type = true;
    }
    state.tables.insert(
        name.clone(),
        Table {
            columns,
            rows: Vec::new(),
        },
    );
    Ok(json!({ "rows": [], "changes": 0 }))
}

fn insert_row(state: &mut MemoryState, tokens: &[String]) -> Result<Value, PluginSdkError> {
    let into = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("INTO"))
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires INTO"))?;
    let name = tokens
        .get(into + 1)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires a table"))?;
    let table = state
        .tables
        .get_mut(name)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", format!("unknown table {name}")))?;
    let open_cols = tokens
        .iter()
        .position(|item| item == "(")
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires a column list"))?;
    let close_cols = tokens
        .iter()
        .position(|item| item == ")")
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires a column list"))?;
    let columns = tokens[open_cols + 1..close_cols]
        .iter()
        .filter(|item| *item != ",")
        .cloned()
        .collect::<Vec<_>>();
    let values_at = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("VALUES"))
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires VALUES"))?;
    let open_vals = tokens[values_at..]
        .iter()
        .position(|item| item == "(")
        .map(|item| item + values_at)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires VALUES"))?;
    let close_vals = tokens[open_vals..]
        .iter()
        .position(|item| item == ")")
        .map(|item| item + open_vals)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "INSERT requires VALUES"))?;
    let values = parse_value_list(&tokens[open_vals + 1..close_vals]);
    if columns.len() != values.len() {
        return Err(PluginSdkError::new(
            "db_sql_denied",
            "INSERT column/value count mismatch",
        ));
    }
    let mut row = Map::new();
    for (column, value) in columns.into_iter().zip(values) {
        row.insert(column, value);
    }
    table.rows.push(row);
    Ok(json!({ "rows": [], "changes": 1 }))
}

fn select_rows(state: &MemoryState, tokens: &[String]) -> Result<Value, PluginSdkError> {
    let from = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("FROM"))
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "SELECT requires FROM"))?;
    let name = tokens
        .get(from + 1)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "SELECT requires a table"))?;
    let table = state
        .tables
        .get(name)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", format!("unknown table {name}")))?;
    let selected = if tokens[1] == "*" {
        table.columns.clone()
    } else {
        tokens[1..from]
            .iter()
            .filter(|item| *item != ",")
            .cloned()
            .collect()
    };
    let filter = parse_where(tokens)?;
    let rows = table
        .rows
        .iter()
        .filter(|row| matches_where(row, &filter))
        .map(|row| {
            let mut projected = Map::new();
            for column in &selected {
                projected.insert(
                    column.clone(),
                    row.get(column).cloned().unwrap_or(Value::Null),
                );
            }
            Value::Object(projected)
        })
        .collect::<Vec<_>>();
    Ok(json!({ "rows": rows, "changes": 0 }))
}

fn update_rows(state: &mut MemoryState, tokens: &[String]) -> Result<Value, PluginSdkError> {
    let name = tokens
        .get(1)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "UPDATE requires a table"))?;
    let table = state
        .tables
        .get_mut(name)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", format!("unknown table {name}")))?;
    let set_at = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("SET"))
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "UPDATE requires SET"))?;
    let where_at = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("WHERE"));
    let assign_end = where_at.unwrap_or(tokens.len());
    let assignments = parse_assignments(&tokens[set_at + 1..assign_end])?;
    let filter = parse_where(tokens)?;
    let mut changes = 0;
    for row in &mut table.rows {
        if matches_where(row, &filter) {
            for (column, value) in &assignments {
                row.insert(column.clone(), value.clone());
            }
            changes += 1;
        }
    }
    Ok(json!({ "rows": [], "changes": changes }))
}

fn delete_rows(state: &mut MemoryState, tokens: &[String]) -> Result<Value, PluginSdkError> {
    let from = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("FROM"))
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "DELETE requires FROM"))?;
    let name = tokens
        .get(from + 1)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", "DELETE requires a table"))?;
    let filter = parse_where(tokens)?;
    let table = state
        .tables
        .get_mut(name)
        .ok_or_else(|| PluginSdkError::new("db_sql_denied", format!("unknown table {name}")))?;
    let before = table.rows.len();
    table.rows.retain(|row| !matches_where(row, &filter));
    Ok(json!({ "rows": [], "changes": before - table.rows.len() }))
}

fn parse_assignments(tokens: &[String]) -> Result<Vec<(String, Value)>, PluginSdkError> {
    let mut assignments = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if tokens[index] == "," {
            index += 1;
            continue;
        }
        let column = tokens[index].clone();
        if tokens.get(index + 1).map(String::as_str) != Some("=") {
            return Err(PluginSdkError::new(
                "db_sql_denied",
                "UPDATE assignment requires =",
            ));
        }
        let value = parse_sql_value(tokens.get(index + 2).map(String::as_str).unwrap_or("NULL"));
        assignments.push((column, value));
        index += 3;
    }
    Ok(assignments)
}

fn parse_where(tokens: &[String]) -> Result<Vec<(String, Value)>, PluginSdkError> {
    let Some(start) = tokens
        .iter()
        .position(|item| item.eq_ignore_ascii_case("WHERE"))
    else {
        return Ok(Vec::new());
    };
    let mut filter = Vec::new();
    let mut index = start + 1;
    while index < tokens.len() {
        if tokens[index].eq_ignore_ascii_case("AND") {
            index += 1;
            continue;
        }
        let column = tokens[index].clone();
        if tokens.get(index + 1).map(String::as_str) != Some("=") {
            return Err(PluginSdkError::new(
                "db_sql_denied",
                "WHERE only supports equality",
            ));
        }
        let value = parse_sql_value(tokens.get(index + 2).map(String::as_str).unwrap_or("NULL"));
        filter.push((column, value));
        index += 3;
    }
    Ok(filter)
}

fn matches_where(row: &Map<String, Value>, filter: &[(String, Value)]) -> bool {
    filter.iter().all(|(column, expected)| {
        row.get(column)
            .is_some_and(|actual| values_equal(actual, expected))
    })
}

fn values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => {
            a.as_i64() == b.as_i64() && a.as_f64() == b.as_f64()
        }
        _ => left == right,
    }
}

fn parse_value_list(tokens: &[String]) -> Vec<Value> {
    tokens
        .iter()
        .filter(|item| *item != ",")
        .map(|item| parse_sql_value(item))
        .collect()
}

fn parse_sql_value(token: &str) -> Value {
    if token.eq_ignore_ascii_case("NULL") {
        return Value::Null;
    }
    if (token.starts_with('\'') && token.ends_with('\''))
        || (token.starts_with('"') && token.ends_with('"'))
    {
        return Value::String(token[1..token.len() - 1].replace("''", "'"));
    }
    if let Ok(number) = token.parse::<i64>() {
        return json!(number);
    }
    if let Ok(number) = token.parse::<f64>() {
        return json!(number);
    }
    Value::String(token.to_owned())
}

fn tokenize(sql: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' => {
                flush_token(&mut current, &mut tokens);
                let mut value = String::from("'");
                while let Some(next) = chars.next() {
                    value.push(next);
                    if next == '\'' {
                        if chars.peek() == Some(&'\'') {
                            value.push(chars.next().expect("escaped quote"));
                            continue;
                        }
                        break;
                    }
                }
                tokens.push(value);
            }
            '(' | ')' | ',' | '=' => {
                flush_token(&mut current, &mut tokens);
                tokens.push(ch.to_string());
            }
            ch if ch.is_whitespace() => flush_token(&mut current, &mut tokens),
            ch => current.push(ch),
        }
    }
    flush_token(&mut current, &mut tokens);
    tokens
}

fn flush_token(current: &mut String, tokens: &mut Vec<String>) {
    if !current.is_empty() {
        tokens.push(std::mem::take(current));
    }
}

fn required_string(input: &Value, field: &str) -> Result<String, PluginSdkError> {
    input
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| PluginSdkError::new("protocol_invalid", format!("{field} is required")))
}

pub fn redact(value: Value) -> Value {
    let key_pattern = Regex::new(
        r"(?i)(token|authorization|secret|password|VIBEX_SERVER_TOKEN|VIBEX_PLUGIN_DEV_GRANT)",
    )
    .expect("redact regex");
    let bearer = Regex::new(r"(?i)Bearer\s+\S+").expect("bearer regex");
    redact_value(value, &key_pattern, &bearer)
}

fn redact_value(value: Value, keys: &Regex, bearer: &Regex) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| {
                    if keys.is_match(&key) {
                        (key, Value::String("[redacted]".to_owned()))
                    } else {
                        (key, redact_value(item, keys, bearer))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| redact_value(item, keys, bearer))
                .collect(),
        ),
        Value::String(text) => {
            Value::String(bearer.replace_all(&text, "Bearer [redacted]").into_owned())
        }
        other => other,
    }
}
