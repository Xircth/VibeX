use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

// ============= Type Definitions =============

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageUsageData {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_read_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageDailyUsage {
    pub date: String,
    pub sessions: i64,
    pub usage: ProjectUsageUsageData,
    pub cost: f64,
    pub models_used: Vec<String>,
}

impl Default for ProjectUsageDailyUsage {
    fn default() -> Self {
        Self {
            date: String::new(),
            sessions: 0,
            usage: ProjectUsageUsageData::default(),
            cost: 0.0,
            models_used: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageModelUsage {
    pub model: String,
    pub total_cost: f64,
    pub total_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub session_count: i64,
}

impl Default for ProjectUsageModelUsage {
    fn default() -> Self {
        Self {
            model: String::new(),
            total_cost: 0.0,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            session_count: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageSessionSummary {
    pub session_id: String,
    pub timestamp: i64,
    pub model: String,
    pub usage: ProjectUsageUsageData,
    pub cost: f64,
    pub summary: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageWeekData {
    pub sessions: i64,
    pub cost: f64,
    pub tokens: i64,
}

impl Default for ProjectUsageWeekData {
    fn default() -> Self {
        Self {
            sessions: 0,
            cost: 0.0,
            tokens: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageTrends {
    pub sessions: f64,
    pub cost: f64,
    pub tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageWeeklyComparison {
    pub current_week: ProjectUsageWeekData,
    pub last_week: ProjectUsageWeekData,
    pub trends: ProjectUsageTrends,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageProviderStatus {
    pub provider: String,
    pub success: bool,
    pub error: Option<String>,
    pub sessions_scanned: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageStatistics {
    pub scope: String,
    pub project_id: String,
    pub project_name: String,
    pub total_sessions: i64,
    pub total_usage: ProjectUsageUsageData,
    pub estimated_cost: f64,
    pub sessions: Vec<ProjectUsageSessionSummary>,
    pub daily_usage: Vec<ProjectUsageDailyUsage>,
    pub weekly_comparison: ProjectUsageWeeklyComparison,
    pub by_model: Vec<ProjectUsageModelUsage>,
    pub provider_status: Vec<ProjectUsageProviderStatus>,
    pub last_updated: i64,
}

// ============= Internal Types =============

#[derive(Default, Clone, Copy)]
struct UsageTotals {
    input: i64,
    cached: i64,
    output: i64,
}

#[derive(Default, Clone, Copy)]
struct CostRates {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

fn model_matches(model: &str, candidates: &[&str]) -> bool {
    let model_lower = model.to_lowercase();
    candidates
        .iter()
        .any(|candidate| model_lower.contains(candidate))
}

// ============= Cost Calculation =============

fn calculate_usage_cost(usage: &ProjectUsageUsageData, rates: CostRates) -> f64 {
    let input_cost = (usage.input_tokens as f64 / 1_000_000.0) * rates.input;
    let output_cost = (usage.output_tokens as f64 / 1_000_000.0) * rates.output;
    let cache_write_cost = (usage.cache_write_tokens as f64 / 1_000_000.0) * rates.cache_write;
    let cache_read_cost = (usage.cache_read_tokens as f64 / 1_000_000.0) * rates.cache_read;
    input_cost + output_cost + cache_write_cost + cache_read_cost
}

fn openai_cost_rates(model: &str) -> CostRates {
    if model_matches(model, &["gpt-5.4-mini"]) {
        return CostRates {
            input: 0.75,
            output: 4.50,
            cache_write: 0.0,
            cache_read: 0.075,
        };
    }

    if model_matches(model, &["gpt-5.4-nano"]) {
        return CostRates {
            input: 0.20,
            output: 1.25,
            cache_write: 0.0,
            cache_read: 0.02,
        };
    }

    if model_matches(model, &["gpt-5.4", "gpt-5-4"]) {
        return CostRates {
            input: 2.5,
            output: 15.0,
            cache_write: 0.0,
            cache_read: 0.25,
        };
    }

    if model_matches(model, &["gpt-5.2-pro"]) {
        return CostRates {
            input: 21.0,
            output: 168.0,
            cache_write: 0.0,
            cache_read: 0.0,
        };
    }

    if model_matches(model, &["gpt-5-pro"]) {
        return CostRates {
            input: 15.0,
            output: 120.0,
            cache_write: 0.0,
            cache_read: 0.0,
        };
    }

    if model_matches(model, &["gpt-5.2", "gpt-5.2-chat", "gpt-5.2-codex"]) {
        return CostRates {
            input: 1.75,
            output: 14.0,
            cache_write: 0.0,
            cache_read: 0.175,
        };
    }

    if model_matches(model, &["gpt-5.1-codex-mini", "gpt-5-mini"]) {
        return CostRates {
            input: 0.25,
            output: 2.0,
            cache_write: 0.0,
            cache_read: 0.025,
        };
    }

    if model_matches(model, &["gpt-5-nano"]) {
        return CostRates {
            input: 0.05,
            output: 0.40,
            cache_write: 0.0,
            cache_read: 0.005,
        };
    }

    if model_matches(
        model,
        &[
            "gpt-5.1",
            "gpt-5.1-chat",
            "gpt-5.1-codex-max",
            "gpt-5.1-codex",
            "gpt-5-codex",
            "gpt-5-chat",
            "gpt-5",
        ],
    ) {
        return CostRates {
            input: 1.25,
            output: 10.0,
            cache_write: 0.0,
            cache_read: 0.125,
        };
    }

    if model_matches(model, &["codex-mini-latest"]) {
        return CostRates {
            input: 1.50,
            output: 6.0,
            cache_write: 0.0,
            cache_read: 0.375,
        };
    }

    CostRates {
        input: 3.0,
        output: 15.0,
        cache_write: 0.0,
        cache_read: 0.30,
    }
}

fn claude_cost_rates(model: &str) -> CostRates {
    if model_matches(model, &["claude-opus-4-6", "claude-opus-4.6", "opus-4-6"]) {
        return CostRates {
            input: 5.0,
            output: 25.0,
            cache_write: 6.25,
            cache_read: 0.50,
        };
    }

    if model_matches(
        model,
        &[
            "claude-opus-4-1",
            "claude-opus-4.1",
            "claude-opus-4",
            "claude-opus-3",
            "opus-4-1",
            "opus-4",
            "opus-3",
        ],
    ) {
        return CostRates {
            input: 15.0,
            output: 75.0,
            cache_write: 18.75,
            cache_read: 1.50,
        };
    }

    if model_matches(
        model,
        &[
            "claude-sonnet-4-6",
            "claude-sonnet-4.6",
            "claude-sonnet-4-5",
            "claude-sonnet-4.5",
            "claude-sonnet-4",
            "claude-3-7-sonnet",
            "claude-3-5-sonnet",
            "sonnet-4-6",
            "sonnet-4-5",
            "sonnet-4",
            "sonnet-3.7",
            "sonnet-3-7",
            "sonnet-3.5",
            "sonnet-3-5",
        ],
    ) {
        return CostRates {
            input: 3.0,
            output: 15.0,
            cache_write: 3.75,
            cache_read: 0.30,
        };
    }

    if model_matches(
        model,
        &[
            "claude-haiku-4-5",
            "claude-haiku-4.5",
            "haiku-4-5",
            "haiku-4.5",
        ],
    ) {
        return CostRates {
            input: 1.0,
            output: 5.0,
            cache_write: 1.25,
            cache_read: 0.10,
        };
    }

    if model_matches(model, &["claude-3-5-haiku", "haiku-3.5", "haiku-3-5"]) {
        return CostRates {
            input: 0.80,
            output: 4.0,
            cache_write: 1.0,
            cache_read: 0.08,
        };
    }

    if model_matches(model, &["claude-3-haiku", "haiku-3"]) {
        return CostRates {
            input: 0.25,
            output: 1.25,
            cache_write: 0.30,
            cache_read: 0.03,
        };
    }

    CostRates {
        input: 3.0,
        output: 15.0,
        cache_write: 3.75,
        cache_read: 0.30,
    }
}

// ============= Statistics Builder =============

pub fn build_project_usage_statistics(
    scope: String,
    project_id: String,
    project_name: String,
    sessions: Vec<ProjectUsageSessionSummary>,
    provider_status: Vec<ProjectUsageProviderStatus>,
    now_ms: i64,
) -> ProjectUsageStatistics {
    let mut total_usage = ProjectUsageUsageData::default();
    let mut estimated_cost = 0.0;
    let mut daily_map: HashMap<String, ProjectUsageDailyUsage> = HashMap::new();
    let mut model_map: HashMap<String, ProjectUsageModelUsage> = HashMap::new();
    let one_week_ago = now_ms - 7 * 24 * 60 * 60 * 1000;
    let two_weeks_ago = now_ms - 14 * 24 * 60 * 60 * 1000;
    let mut current_week = ProjectUsageWeekData::default();
    let mut last_week = ProjectUsageWeekData::default();

    for session in &sessions {
        add_usage(&mut total_usage, &session.usage);
        estimated_cost += session.cost;

        let day_key =
            day_key_for_timestamp_ms(session.timestamp).unwrap_or_else(|| "1970-01-01".to_string());
        let daily = daily_map
            .entry(day_key.clone())
            .or_insert_with(|| ProjectUsageDailyUsage {
                date: day_key.clone(),
                ..ProjectUsageDailyUsage::default()
            });
        daily.sessions += 1;
        daily.cost += session.cost;
        add_usage(&mut daily.usage, &session.usage);
        if !daily
            .models_used
            .iter()
            .any(|model| model == &session.model)
        {
            daily.models_used.push(session.model.clone());
        }

        let model_usage =
            model_map
                .entry(session.model.clone())
                .or_insert_with(|| ProjectUsageModelUsage {
                    model: session.model.clone(),
                    ..ProjectUsageModelUsage::default()
                });
        model_usage.session_count += 1;
        model_usage.total_cost += session.cost;
        model_usage.total_tokens += session.usage.total_tokens;
        model_usage.input_tokens += session.usage.input_tokens;
        model_usage.output_tokens += session.usage.output_tokens;
        model_usage.cache_creation_tokens += session.usage.cache_write_tokens;
        model_usage.cache_read_tokens += session.usage.cache_read_tokens;

        if session.timestamp >= one_week_ago {
            current_week.sessions += 1;
            current_week.cost += session.cost;
            current_week.tokens += session.usage.total_tokens;
        } else if session.timestamp >= two_weeks_ago {
            last_week.sessions += 1;
            last_week.cost += session.cost;
            last_week.tokens += session.usage.total_tokens;
        }
    }

    total_usage.total_tokens = total_usage.input_tokens
        + total_usage.output_tokens
        + total_usage.cache_write_tokens
        + total_usage.cache_read_tokens;

    let mut daily_usage: Vec<ProjectUsageDailyUsage> = daily_map.into_values().collect();
    daily_usage.sort_by(|a, b| a.date.cmp(&b.date));
    let mut by_model: Vec<ProjectUsageModelUsage> = model_map.into_values().collect();
    by_model.sort_by(|a, b| b.total_cost.total_cmp(&a.total_cost));

    ProjectUsageStatistics {
        scope,
        project_id,
        project_name,
        total_sessions: sessions.len() as i64,
        total_usage,
        estimated_cost,
        sessions,
        daily_usage,
        weekly_comparison: ProjectUsageWeeklyComparison {
            current_week: current_week.clone(),
            last_week: last_week.clone(),
            trends: ProjectUsageTrends {
                sessions: calculate_trend(current_week.sessions as f64, last_week.sessions as f64),
                cost: calculate_trend(current_week.cost, last_week.cost),
                tokens: calculate_trend(current_week.tokens as f64, last_week.tokens as f64),
            },
        },
        by_model,
        provider_status,
        last_updated: now_ms,
    }
}

fn calculate_trend(current: f64, last: f64) -> f64 {
    if last == 0.0 {
        return 0.0;
    }
    ((current - last) / last) * 100.0
}

fn add_usage(target: &mut ProjectUsageUsageData, usage: &ProjectUsageUsageData) {
    target.input_tokens += usage.input_tokens;
    target.output_tokens += usage.output_tokens;
    target.cache_write_tokens += usage.cache_write_tokens;
    target.cache_read_tokens += usage.cache_read_tokens;
    target.total_tokens += usage.total_tokens;
}

// ============= Claude Sessions Scanning =============

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

fn encode_claude_project_path(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

pub fn scan_claude_sessions(
    workspace_paths: &[PathBuf],
) -> Result<Vec<ProjectUsageSessionSummary>, String> {
    let projects_dir = match claude_projects_dir() {
        Some(dir) if dir.exists() => dir,
        _ => return Ok(Vec::new()),
    };

    let mut sessions = Vec::new();

    if workspace_paths.is_empty() {
        // Scan all projects
        let entries = match fs::read_dir(&projects_dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(Vec::new()),
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_claude_project_sessions(&path, &mut sessions)?;
            }
        }
    } else {
        // Scan specific workspace paths
        for workspace_path in workspace_paths {
            let encoded = encode_claude_project_path(&workspace_path.to_string_lossy());
            let project_dir = projects_dir.join(&encoded);
            if project_dir.exists() {
                scan_claude_project_sessions(&project_dir, &mut sessions)?;
            }
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

fn scan_claude_project_sessions(
    project_dir: &Path,
    sessions: &mut Vec<ProjectUsageSessionSummary>,
) -> Result<(), String> {
    let entries = match fs::read_dir(project_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".jsonl") || name.starts_with("agent-") {
            continue;
        }
        if let Some(summary) = parse_claude_session(&path)? {
            sessions.push(summary);
        }
    }

    Ok(())
}

fn parse_claude_session(path: &Path) -> Result<Option<ProjectUsageSessionSummary>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };

    let reader = BufReader::new(file);
    let mut usage = ProjectUsageUsageData::default();
    let mut total_cost = 0.0;
    let mut model = "unknown".to_string();
    let mut first_timestamp = 0_i64;
    let mut summary: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if first_timestamp == 0 {
            first_timestamp = read_claude_timestamp(&value).unwrap_or(0);
        }

        let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if summary.is_none()
            && entry_type == "summary"
            && let Some(text) = value.get("summary").and_then(|v| v.as_str())
        {
            summary = truncate_summary(text);
        }

        if entry_type != "assistant" {
            continue;
        }

        let Some(message) = value.get("message").and_then(|v| v.as_object()) else {
            continue;
        };

        let message_model = message.get("model").and_then(|v| v.as_str());
        if model == "unknown"
            && let Some(message_model) = message_model
        {
            model = message_model.to_string();
        }

        let Some(usage_map) = message.get("usage").and_then(|v| v.as_object()) else {
            continue;
        };

        let input_tokens = read_i64(usage_map, &["input_tokens"]);
        let output_tokens = read_i64(usage_map, &["output_tokens"]);
        let cache_write_tokens = read_i64(usage_map, &["cache_creation_input_tokens"]);
        let cache_read_tokens = read_i64(usage_map, &["cache_read_input_tokens"]);

        if input_tokens == 0
            && output_tokens == 0
            && cache_write_tokens == 0
            && cache_read_tokens == 0
        {
            continue;
        }

        let message_usage = ProjectUsageUsageData {
            input_tokens,
            output_tokens,
            cache_write_tokens,
            cache_read_tokens,
            total_tokens: input_tokens + output_tokens + cache_write_tokens + cache_read_tokens,
        };

        usage.input_tokens += message_usage.input_tokens;
        usage.output_tokens += message_usage.output_tokens;
        usage.cache_write_tokens += message_usage.cache_write_tokens;
        usage.cache_read_tokens += message_usage.cache_read_tokens;

        let pricing_model = message_model.unwrap_or(model.as_str());
        total_cost += calculate_usage_cost(&message_usage, claude_cost_rates(pricing_model));
    }

    usage.total_tokens = usage.input_tokens
        + usage.output_tokens
        + usage.cache_write_tokens
        + usage.cache_read_tokens;

    if usage.total_tokens == 0 {
        return Ok(None);
    }

    let session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();

    let timestamp = if first_timestamp > 0 {
        first_timestamp
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    Ok(Some(ProjectUsageSessionSummary {
        session_id,
        timestamp,
        model,
        usage,
        cost: total_cost,
        summary,
        provider: "claude".to_string(),
    }))
}

// ============= Codex Sessions Scanning =============

fn resolve_codex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub fn scan_codex_sessions(
    workspace_paths: &[PathBuf],
) -> Result<Vec<ProjectUsageSessionSummary>, String> {
    let codex_home = match resolve_codex_home() {
        Some(home) if home.exists() => home,
        _ => return Ok(Vec::new()),
    };

    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    let mut seen_files = HashSet::new();
    collect_jsonl_files(&sessions_dir, &mut files, &mut seen_files);

    let mut sessions = Vec::new();
    for file in files {
        if let Some(summary) = parse_codex_session(&file, workspace_paths)? {
            sessions.push(summary);
        }
    }

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

fn collect_jsonl_files(root: &Path, output: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, output, seen);
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if seen.insert(path.clone()) {
            output.push(path);
        }
    }
}

fn parse_codex_session(
    path: &Path,
    workspace_paths: &[PathBuf],
) -> Result<Option<ProjectUsageSessionSummary>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };

    let reader = BufReader::new(file);
    let mut usage = ProjectUsageUsageData::default();
    let mut summary: Option<String> = None;
    let mut model: Option<String> = None;
    let mut first_timestamp = 0_i64;
    let mut previous_totals: Option<UsageTotals> = None;
    let mut matches_workspace = workspace_paths.is_empty();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.len() > 512_000 {
            continue;
        }

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if first_timestamp == 0 {
            first_timestamp = read_timestamp_ms(&value).unwrap_or(0);
        }

        let entry_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        if (entry_type == "session_meta" || entry_type == "turn_context")
            && let Some(cwd) = extract_cwd(&value)
            && !workspace_paths.is_empty()
        {
            matches_workspace = workspace_paths
                .iter()
                .any(|filter| path_matches_workspace(&cwd, filter));
            if !matches_workspace {
                break;
            }
        }

        if entry_type == "turn_context" {
            if model.is_none() {
                model = extract_model_from_turn_context(&value);
            }
            continue;
        }

        if !matches_workspace {
            continue;
        }

        if summary.is_none()
            && entry_type == "event_msg"
            && let Some(payload) = value.get("payload").and_then(|payload| payload.as_object())
        {
            let payload_type = payload
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if payload_type == "user_message"
                && let Some(message) = payload.get("message").and_then(|value| value.as_str())
            {
                summary = truncate_summary(message);
            }
        }

        if !(entry_type == "event_msg" || entry_type.is_empty()) {
            continue;
        }

        let payload = value.get("payload").and_then(|value| value.as_object());
        let payload_type = payload
            .and_then(|payload| payload.get("type"))
            .and_then(|value| value.as_str());
        if payload_type != Some("token_count") {
            continue;
        }

        let info = payload
            .and_then(|payload| payload.get("info"))
            .and_then(|value| value.as_object());
        let (input, cached, output, used_total) = if let Some(info) = info {
            if let Some(total) = find_usage_map(info, &["total_token_usage", "totalTokenUsage"]) {
                (
                    read_i64(total, &["input_tokens", "inputTokens"]),
                    read_i64(
                        total,
                        &[
                            "cached_input_tokens",
                            "cache_read_input_tokens",
                            "cachedInputTokens",
                            "cacheReadInputTokens",
                        ],
                    ),
                    read_i64(total, &["output_tokens", "outputTokens"]),
                    true,
                )
            } else if let Some(last) = find_usage_map(info, &["last_token_usage", "lastTokenUsage"])
            {
                (
                    read_i64(last, &["input_tokens", "inputTokens"]),
                    read_i64(
                        last,
                        &[
                            "cached_input_tokens",
                            "cache_read_input_tokens",
                            "cachedInputTokens",
                            "cacheReadInputTokens",
                        ],
                    ),
                    read_i64(last, &["output_tokens", "outputTokens"]),
                    false,
                )
            } else {
                continue;
            }
        } else {
            continue;
        };

        let mut delta = UsageTotals {
            input,
            cached,
            output,
        };

        if used_total {
            let prev = previous_totals.unwrap_or_default();
            delta = UsageTotals {
                input: (input - prev.input).max(0),
                cached: (cached - prev.cached).max(0),
                output: (output - prev.output).max(0),
            };
            previous_totals = Some(UsageTotals {
                input,
                cached,
                output,
            });
        } else {
            let mut next = previous_totals.unwrap_or_default();
            next.input += delta.input;
            next.cached += delta.cached;
            next.output += delta.output;
            previous_totals = Some(next);
        }

        if delta.input == 0 && delta.cached == 0 && delta.output == 0 {
            continue;
        }

        usage.input_tokens += delta.input.max(0);
        usage.output_tokens += delta.output.max(0);
        usage.cache_read_tokens += delta.cached.max(0);
        if model.is_none() {
            model = extract_model_from_token_count(&value);
        }
    }

    if !workspace_paths.is_empty() && !matches_workspace {
        return Ok(None);
    }

    usage.total_tokens = usage.input_tokens
        + usage.output_tokens
        + usage.cache_write_tokens
        + usage.cache_read_tokens;

    if summary.is_none() && usage.total_tokens == 0 {
        return Ok(None);
    }

    let session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let model = model.unwrap_or_else(|| "gpt-5.1".to_string());
    let cost = calculate_usage_cost(&usage, openai_cost_rates(&model));
    let timestamp = if first_timestamp > 0 {
        first_timestamp
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    Ok(Some(ProjectUsageSessionSummary {
        session_id,
        timestamp,
        model,
        usage,
        cost,
        summary,
        provider: "codex".to_string(),
    }))
}

// ============= Helper Functions =============

fn truncate_summary(text: &str) -> Option<String> {
    let cleaned = text.replace('\n', " ").trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    let limit = 45;
    let truncated = if cleaned.chars().count() > limit {
        format!("{}...", cleaned.chars().take(limit).collect::<String>())
    } else {
        cleaned
    };
    Some(truncated)
}

fn find_usage_map<'a>(
    info: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    keys.iter()
        .find_map(|key| info.get(*key).and_then(|value| value.as_object()))
}

fn read_i64(map: &serde_json::Map<String, Value>, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|key| map.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value as i64))
        })
        .unwrap_or(0)
}

fn read_timestamp_ms(value: &Value) -> Option<i64> {
    let raw = value.get("timestamp")?;
    if let Some(text) = raw.as_str() {
        return DateTime::parse_from_rfc3339(text)
            .map(|value| value.timestamp_millis())
            .ok();
    }
    let numeric = raw
        .as_i64()
        .or_else(|| raw.as_f64().map(|value| value as i64))?;
    if numeric > 0 && numeric < 1_000_000_000_000 {
        return Some(numeric * 1000);
    }
    Some(numeric)
}

fn read_claude_timestamp(value: &Value) -> Option<i64> {
    value
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|ts| {
            DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|dt| dt.timestamp_millis())
        })
}

fn day_key_for_timestamp_ms(timestamp_ms: i64) -> Option<String> {
    let utc = Utc.timestamp_millis_opt(timestamp_ms).single()?;
    Some(utc.with_timezone(&Local).format("%Y-%m-%d").to_string())
}

fn extract_cwd(value: &Value) -> Option<String> {
    value
        .get("payload")
        .and_then(|payload| payload.get("cwd"))
        .and_then(|cwd| cwd.as_str())
        .map(|cwd| cwd.to_string())
}

fn path_matches_workspace(cwd: &str, workspace_path: &Path) -> bool {
    let cwd_path = Path::new(cwd);
    cwd_path == workspace_path || cwd_path.starts_with(workspace_path)
}

fn extract_model_from_turn_context(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    if let Some(model) = payload.get("model").and_then(|value| value.as_str()) {
        return Some(model.to_string());
    }
    let info = payload.get("info").and_then(|value| value.as_object())?;
    info.get("model")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn extract_model_from_token_count(value: &Value) -> Option<String> {
    let payload = value.get("payload").and_then(|value| value.as_object())?;
    let info = payload.get("info").and_then(|value| value.as_object());
    let model = info
        .and_then(|info| {
            info.get("model")
                .or_else(|| info.get("model_name"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| payload.get("model").and_then(|value| value.as_str()))
        .or_else(|| value.get("model").and_then(|value| value.as_str()));
    model.map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_session(
        session_id: &str,
        model: &str,
        tokens: i64,
        cost: f64,
        timestamp: i64,
    ) -> ProjectUsageSessionSummary {
        ProjectUsageSessionSummary {
            session_id: session_id.to_string(),
            timestamp,
            model: model.to_string(),
            usage: ProjectUsageUsageData {
                input_tokens: tokens / 2,
                output_tokens: tokens / 2,
                cache_write_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: tokens,
            },
            cost,
            summary: None,
            provider: "test".to_string(),
        }
    }

    fn provider_ok(provider: &str) -> ProjectUsageProviderStatus {
        ProjectUsageProviderStatus {
            provider: provider.to_string(),
            success: true,
            error: None,
            sessions_scanned: 10,
        }
    }

    fn provider_failed(provider: &str, error: &str) -> ProjectUsageProviderStatus {
        ProjectUsageProviderStatus {
            provider: provider.to_string(),
            success: false,
            error: Some(error.to_string()),
            sessions_scanned: 0,
        }
    }

    #[test]
    fn build_empty_project_usage_statistics_returns_zeroed_result() {
        let result = build_project_usage_statistics(
            "project".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            Vec::new(),
            Vec::new(),
            0,
        );

        assert_eq!(result.project_id, "project-1");
        assert_eq!(result.total_sessions, 0);
        assert_eq!(result.estimated_cost, 0.0);
        assert!(result.sessions.is_empty());
    }

    #[test]
    fn merge_provider_sessions_combines_multiple_workspaces() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let sessions = vec![
            fake_session("a", "gpt-5", 1000, 0.12, now),
            fake_session("b", "claude-sonnet", 2000, 0.34, now),
        ];

        let result = build_project_usage_statistics(
            "global".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            sessions,
            vec![
                provider_ok("codex"),
                provider_ok("claude"),
                provider_failed("opencode", "timeout"),
            ],
            now,
        );

        assert_eq!(result.total_sessions, 2);
        assert_eq!(result.provider_status.len(), 3);
        assert_eq!(result.by_model.len(), 2);
    }

    #[test]
    fn gpt_5_4_uses_official_input_cached_output_rates() {
        let usage = ProjectUsageUsageData {
            input_tokens: 400_000,
            output_tokens: 300_000,
            cache_write_tokens: 100_000,
            cache_read_tokens: 200_000,
            total_tokens: 1_000_000,
        };

        let cost = calculate_usage_cost(&usage, openai_cost_rates("gpt-5.4"));

        assert!((cost - 5.55).abs() < 0.000_001);
    }
}
