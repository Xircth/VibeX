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

/// Optional token breakdown. `None` means the source did not provide the field
/// (ADR-0058 / ADR-0075). Never treat missing as zero.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct ProjectUsageTokenCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
}

/// Dual ledger: protocol is attribution; vendor_log is a breakdown supplement.
/// The two sources are never summed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[ts(export)]
pub struct ProjectUsageSourcedTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProjectUsageTokenCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_log: Option<ProjectUsageTokenCounts>,
    pub sources_disagree: bool,
}

/// Backward-compatible alias used by daily charts. Fields stay optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
pub struct ProjectUsageUsageData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageDailyUsage {
    pub date: String,
    pub sessions: i64,
    pub tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    pub models_used: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageModelUsage {
    pub model: String,
    pub session_count: i64,
    pub tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageFolderUsage {
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    pub session_count: i64,
    pub tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageAgentUsage {
    pub agent_id: String,
    pub session_count: i64,
    pub tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageSessionSummary {
    pub session_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_max: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectUsageWeekData {
    pub sessions: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<i64>,
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
    pub total_tokens: ProjectUsageSourcedTokens,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_estimated_cost: Option<f64>,
    pub sessions: Vec<ProjectUsageSessionSummary>,
    pub daily_usage: Vec<ProjectUsageDailyUsage>,
    pub weekly_comparison: ProjectUsageWeeklyComparison,
    pub by_model: Vec<ProjectUsageModelUsage>,
    pub by_folder: Vec<ProjectUsageFolderUsage>,
    pub by_agent: Vec<ProjectUsageAgentUsage>,
    pub provider_status: Vec<ProjectUsageProviderStatus>,
    pub unattributed_vendor_sessions: i64,
    pub last_updated: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing_notice: Option<String>,
}

/// Vendor-log breakdown keyed by the vendor's session id (aligned later by
/// `sessions.external_session_id`, never by path).
#[derive(Debug, Clone)]
pub struct VendorLogUsage {
    pub external_session_id: String,
    pub timestamp: i64,
    pub model: String,
    pub tokens: ProjectUsageTokenCounts,
    pub cost: Option<f64>,
    pub summary: Option<String>,
    pub provider: String,
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

fn calculate_usage_cost(usage: &ProjectUsageTokenCounts, rates: CostRates) -> Option<f64> {
    let input = usage.input_tokens?;
    let output = usage.output_tokens?;
    let cache_write = usage.cache_write_tokens.unwrap_or(0);
    let cache_read = usage.cache_read_tokens.unwrap_or(0);
    let input_cost = (input as f64 / 1_000_000.0) * rates.input;
    let output_cost = (output as f64 / 1_000_000.0) * rates.output;
    let cache_write_cost = (cache_write as f64 / 1_000_000.0) * rates.cache_write;
    let cache_read_cost = (cache_read as f64 / 1_000_000.0) * rates.cache_read;
    Some(input_cost + output_cost + cache_write_cost + cache_read_cost)
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
    unattributed_vendor_sessions: i64,
    now_ms: i64,
) -> ProjectUsageStatistics {
    let mut total_protocol = AccumulatedTokens::default();
    let mut total_vendor = AccumulatedTokens::default();
    let mut estimated_cost: Option<f64> = None;
    let mut vendor_estimated_cost: Option<f64> = None;
    let mut daily_map: HashMap<String, DailyAccumulator> = HashMap::new();
    let mut model_map: HashMap<String, DimensionAccumulator> = HashMap::new();
    let mut folder_map: HashMap<String, DimensionAccumulator> = HashMap::new();
    let mut agent_map: HashMap<String, DimensionAccumulator> = HashMap::new();
    let one_week_ago = now_ms - 7 * 24 * 60 * 60 * 1000;
    let two_weeks_ago = now_ms - 14 * 24 * 60 * 60 * 1000;
    let mut current_week = ProjectUsageWeekData::default();
    let mut last_week = ProjectUsageWeekData::default();

    for session in &sessions {
        add_optional_tokens(&mut total_protocol, session.tokens.protocol.as_ref());
        add_optional_tokens(&mut total_vendor, session.tokens.vendor_log.as_ref());
        add_optional_cost(&mut estimated_cost, session.cost);
        add_optional_cost(
            &mut vendor_estimated_cost,
            session
                .tokens
                .vendor_log
                .as_ref()
                .and_then(|tokens| vendor_cost_for_model(session.model.as_deref(), tokens)),
        );

        let day_key =
            day_key_for_timestamp_ms(session.timestamp).unwrap_or_else(|| "1970-01-01".to_string());
        let daily = daily_map
            .entry(day_key.clone())
            .or_insert_with(|| DailyAccumulator {
                date: day_key.clone(),
                ..DailyAccumulator::default()
            });
        daily.sessions += 1;
        add_optional_tokens(&mut daily.protocol, session.tokens.protocol.as_ref());
        add_optional_tokens(&mut daily.vendor, session.tokens.vendor_log.as_ref());
        add_optional_cost(&mut daily.cost, session.cost);
        if let Some(model) = session.model.as_ref()
            && !daily.models_used.iter().any(|existing| existing == model)
        {
            daily.models_used.push(model.clone());
        }

        let model_key = session
            .model
            .clone()
            .unwrap_or_else(|| "unprovided".to_string());
        accumulate_dimension(
            &mut model_map,
            &model_key,
            session.tokens.protocol.as_ref(),
            session.tokens.vendor_log.as_ref(),
            session.cost,
        );

        accumulate_dimension(
            &mut folder_map,
            &session.workspace_id,
            session.tokens.protocol.as_ref(),
            session.tokens.vendor_log.as_ref(),
            session.cost,
        );
        folder_map
            .entry(session.workspace_id.clone())
            .or_default()
            .folder
            .clone_from(&session.folder);

        let agent_key = session
            .agent_id
            .clone()
            .unwrap_or_else(|| "unprovided".to_string());
        accumulate_dimension(
            &mut agent_map,
            &agent_key,
            session.tokens.protocol.as_ref(),
            session.tokens.vendor_log.as_ref(),
            session.cost,
        );

        if session.timestamp >= one_week_ago {
            current_week.sessions += 1;
            add_optional_cost(&mut current_week.cost, session.cost);
            add_optional_i64(&mut current_week.tokens, preferred_total(&session.tokens));
        } else if session.timestamp >= two_weeks_ago {
            last_week.sessions += 1;
            add_optional_cost(&mut last_week.cost, session.cost);
            add_optional_i64(&mut last_week.tokens, preferred_total(&session.tokens));
        }
    }

    let mut daily_usage: Vec<ProjectUsageDailyUsage> = daily_map
        .into_values()
        .map(|daily| ProjectUsageDailyUsage {
            date: daily.date,
            sessions: daily.sessions,
            tokens: sourced_from_accumulated(&daily.protocol, &daily.vendor),
            cost: daily.cost,
            models_used: daily.models_used,
        })
        .collect();
    daily_usage.sort_by(|a, b| a.date.cmp(&b.date));

    let mut by_model: Vec<ProjectUsageModelUsage> = model_map
        .into_iter()
        .map(|(model, acc)| ProjectUsageModelUsage {
            model,
            session_count: acc.sessions,
            tokens: sourced_from_accumulated(&acc.protocol, &acc.vendor),
            cost: acc.cost,
        })
        .collect();
    by_model.sort_by(|a, b| optional_cost_cmp(b.cost, a.cost));

    let mut by_folder: Vec<ProjectUsageFolderUsage> = folder_map
        .into_iter()
        .map(|(workspace_id, acc)| ProjectUsageFolderUsage {
            workspace_id,
            folder: acc.folder,
            session_count: acc.sessions,
            tokens: sourced_from_accumulated(&acc.protocol, &acc.vendor),
            cost: acc.cost,
        })
        .collect();
    by_folder.sort_by(|a, b| b.session_count.cmp(&a.session_count));

    let mut by_agent: Vec<ProjectUsageAgentUsage> = agent_map
        .into_iter()
        .map(|(agent_id, acc)| ProjectUsageAgentUsage {
            agent_id,
            session_count: acc.sessions,
            tokens: sourced_from_accumulated(&acc.protocol, &acc.vendor),
            cost: acc.cost,
        })
        .collect();
    by_agent.sort_by(|a, b| b.session_count.cmp(&a.session_count));

    ProjectUsageStatistics {
        scope,
        project_id,
        project_name,
        total_sessions: sessions.len() as i64,
        total_tokens: sourced_from_accumulated(&total_protocol, &total_vendor),
        estimated_cost,
        vendor_estimated_cost,
        sessions,
        daily_usage,
        weekly_comparison: ProjectUsageWeeklyComparison {
            current_week: current_week.clone(),
            last_week: last_week.clone(),
            trends: ProjectUsageTrends {
                sessions: calculate_trend(current_week.sessions as f64, last_week.sessions as f64),
                cost: calculate_trend(
                    current_week.cost.unwrap_or(0.0),
                    last_week.cost.unwrap_or(0.0),
                ),
                tokens: calculate_trend(
                    current_week.tokens.unwrap_or(0) as f64,
                    last_week.tokens.unwrap_or(0) as f64,
                ),
            },
        },
        by_model,
        by_folder,
        by_agent,
        provider_status,
        unattributed_vendor_sessions,
        last_updated: now_ms,
        pricing_notice: None,
    }
}

#[derive(Default, Clone)]
struct AccumulatedTokens {
    input: Option<i64>,
    output: Option<i64>,
    cache_write: Option<i64>,
    cache_read: Option<i64>,
    total: Option<i64>,
}

#[derive(Default, Clone)]
struct DailyAccumulator {
    date: String,
    sessions: i64,
    protocol: AccumulatedTokens,
    vendor: AccumulatedTokens,
    cost: Option<f64>,
    models_used: Vec<String>,
}

#[derive(Default, Clone)]
struct DimensionAccumulator {
    sessions: i64,
    protocol: AccumulatedTokens,
    vendor: AccumulatedTokens,
    cost: Option<f64>,
    folder: Option<String>,
}

fn accumulate_dimension(
    map: &mut HashMap<String, DimensionAccumulator>,
    key: &str,
    protocol: Option<&ProjectUsageTokenCounts>,
    vendor: Option<&ProjectUsageTokenCounts>,
    cost: Option<f64>,
) {
    let entry = map.entry(key.to_string()).or_default();
    entry.sessions += 1;
    add_optional_tokens(&mut entry.protocol, protocol);
    add_optional_tokens(&mut entry.vendor, vendor);
    add_optional_cost(&mut entry.cost, cost);
}

fn add_optional_tokens(target: &mut AccumulatedTokens, usage: Option<&ProjectUsageTokenCounts>) {
    let Some(usage) = usage else {
        return;
    };
    add_optional_i64(&mut target.input, usage.input_tokens);
    add_optional_i64(&mut target.output, usage.output_tokens);
    add_optional_i64(&mut target.cache_write, usage.cache_write_tokens);
    add_optional_i64(&mut target.cache_read, usage.cache_read_tokens);
    add_optional_i64(&mut target.total, usage.total_tokens);
}

fn add_optional_i64(target: &mut Option<i64>, value: Option<i64>) {
    if let Some(value) = value {
        *target = Some(target.unwrap_or(0).saturating_add(value));
    }
}

fn add_optional_cost(target: &mut Option<f64>, value: Option<f64>) {
    if let Some(value) = value {
        *target = Some(target.unwrap_or(0.0) + value);
    }
}

fn sourced_from_accumulated(
    protocol: &AccumulatedTokens,
    vendor: &AccumulatedTokens,
) -> ProjectUsageSourcedTokens {
    let protocol = finish_accumulated(protocol);
    let vendor_log = finish_accumulated(vendor);
    ProjectUsageSourcedTokens {
        sources_disagree: tokens_disagree(protocol.as_ref(), vendor_log.as_ref()),
        protocol,
        vendor_log,
    }
}

fn finish_accumulated(acc: &AccumulatedTokens) -> Option<ProjectUsageTokenCounts> {
    if acc.input.is_none()
        && acc.output.is_none()
        && acc.cache_write.is_none()
        && acc.cache_read.is_none()
        && acc.total.is_none()
    {
        return None;
    }
    Some(ProjectUsageTokenCounts {
        input_tokens: acc.input,
        output_tokens: acc.output,
        cache_write_tokens: acc.cache_write,
        cache_read_tokens: acc.cache_read,
        total_tokens: acc.total.or_else(|| match (acc.input, acc.output) {
            (Some(input), Some(output)) => Some(
                input
                    .saturating_add(output)
                    .saturating_add(acc.cache_write.unwrap_or(0))
                    .saturating_add(acc.cache_read.unwrap_or(0)),
            ),
            _ => None,
        }),
    })
}

fn tokens_disagree(
    protocol: Option<&ProjectUsageTokenCounts>,
    vendor: Option<&ProjectUsageTokenCounts>,
) -> bool {
    match (
        protocol.and_then(|tokens| tokens.total_tokens),
        vendor.and_then(|tokens| tokens.total_tokens),
    ) {
        (Some(left), Some(right)) => left != right,
        _ => false,
    }
}

pub fn preferred_total(tokens: &ProjectUsageSourcedTokens) -> Option<i64> {
    tokens
        .protocol
        .as_ref()
        .and_then(|counts| counts.total_tokens)
}

fn optional_cost_cmp(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    left.unwrap_or(f64::MIN)
        .total_cmp(&right.unwrap_or(f64::MIN))
}

fn vendor_cost_for_model(model: Option<&str>, tokens: &ProjectUsageTokenCounts) -> Option<f64> {
    let model = model?;
    if model_matches(model, &["claude", "sonnet", "opus", "haiku"]) {
        return calculate_usage_cost(tokens, claude_cost_rates(model));
    }
    if model_matches(model, &["gpt", "codex"]) {
        return calculate_usage_cost(tokens, openai_cost_rates(model));
    }
    None
}

pub fn align_vendor_usage(
    sessions: &mut [ProjectUsageSessionSummary],
    vendor_logs: &[VendorLogUsage],
) -> i64 {
    let mut by_external: HashMap<&str, &VendorLogUsage> = HashMap::new();
    for vendor in vendor_logs {
        by_external
            .entry(vendor.external_session_id.as_str())
            .or_insert(vendor);
    }

    let mut attributed = HashSet::new();
    for session in sessions.iter_mut() {
        let Some(external_id) = session.external_session_id.as_deref() else {
            continue;
        };
        let Some(vendor) = by_external.get(external_id) else {
            continue;
        };
        attributed.insert(external_id.to_string());
        if session.model.is_none() && !vendor.model.is_empty() {
            session.model = Some(vendor.model.clone());
        }
        if session.summary.is_none() {
            session.summary = vendor.summary.clone();
        }
        session.tokens.vendor_log = Some(vendor.tokens.clone());
        session.tokens.sources_disagree = tokens_disagree(
            session.tokens.protocol.as_ref(),
            session.tokens.vendor_log.as_ref(),
        );
        if session.cost.is_none() {
            session.cost = vendor.cost;
        }
    }

    vendor_logs
        .iter()
        .filter(|vendor| !attributed.contains(&vendor.external_session_id))
        .count() as i64
}

fn calculate_trend(current: f64, last: f64) -> f64 {
    if last == 0.0 {
        return 0.0;
    }
    ((current - last) / last) * 100.0
}

// ============= Claude Sessions Scanning =============

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

pub fn scan_claude_sessions() -> Result<Vec<VendorLogUsage>, String> {
    let projects_dir = match claude_projects_dir() {
        Some(dir) if dir.exists() => dir,
        _ => return Ok(Vec::new()),
    };

    let mut sessions = Vec::new();
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

    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

fn scan_claude_project_sessions(
    project_dir: &Path,
    sessions: &mut Vec<VendorLogUsage>,
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

fn parse_claude_session(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };

    let reader = BufReader::new(file);
    let mut usage = ProjectUsageTokenCounts::default();
    let mut total_cost = 0.0;
    let mut has_cost = false;
    let mut model = "unknown".to_string();
    let mut first_timestamp = 0_i64;
    let mut summary: Option<String> = None;
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();

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
        if session_id.is_empty()
            && let Some(id) = string_at(&value, &["sessionId", "session_id"])
        {
            session_id = id;
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

        let message_usage = ProjectUsageTokenCounts {
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
            cache_write_tokens: Some(cache_write_tokens),
            cache_read_tokens: Some(cache_read_tokens),
            total_tokens: Some(
                input_tokens + output_tokens + cache_write_tokens + cache_read_tokens,
            ),
        };

        add_optional_i64(&mut usage.input_tokens, message_usage.input_tokens);
        add_optional_i64(&mut usage.output_tokens, message_usage.output_tokens);
        add_optional_i64(
            &mut usage.cache_write_tokens,
            message_usage.cache_write_tokens,
        );
        add_optional_i64(
            &mut usage.cache_read_tokens,
            message_usage.cache_read_tokens,
        );

        let pricing_model = message_model.unwrap_or(model.as_str());
        if let Some(cost) = calculate_usage_cost(&message_usage, claude_cost_rates(pricing_model)) {
            total_cost += cost;
            has_cost = true;
        }
    }

    usage.total_tokens = match (
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_write_tokens,
        usage.cache_read_tokens,
    ) {
        (Some(input), Some(output), cache_write, cache_read) => {
            Some(input + output + cache_write.unwrap_or(0) + cache_read.unwrap_or(0))
        }
        _ => None,
    };

    if usage.total_tokens.unwrap_or(0) == 0 {
        return Ok(None);
    }

    let timestamp = if first_timestamp > 0 {
        first_timestamp
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    };

    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp,
        model,
        tokens: usage,
        cost: has_cost.then_some(total_cost),
        summary,
        provider: "claude".to_string(),
    }))
}

// ============= Codex Sessions Scanning =============

fn resolve_codex_home() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub fn scan_codex_sessions() -> Result<Vec<VendorLogUsage>, String> {
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
        if let Some(summary) = parse_codex_session(&file)? {
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

fn parse_codex_session(path: &Path) -> Result<Option<VendorLogUsage>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };

    let reader = BufReader::new(file);
    let mut usage = ProjectUsageTokenCounts::default();
    let mut summary: Option<String> = None;
    let mut model: Option<String> = None;
    let mut first_timestamp = 0_i64;
    let mut previous_totals: Option<UsageTotals> = None;
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();

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
        if let Some(id) = extract_codex_session_id(&value) {
            session_id = id;
        }

        let entry_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("");

        if entry_type == "turn_context" {
            if model.is_none() {
                model = extract_model_from_turn_context(&value);
            }
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

        add_optional_i64(&mut usage.input_tokens, Some(delta.input.max(0)));
        add_optional_i64(&mut usage.output_tokens, Some(delta.output.max(0)));
        add_optional_i64(&mut usage.cache_read_tokens, Some(delta.cached.max(0)));
        if model.is_none() {
            model = extract_model_from_token_count(&value);
        }
    }

    usage.total_tokens = match (usage.input_tokens, usage.output_tokens) {
        (Some(input), Some(output)) => Some(
            input
                + output
                + usage.cache_write_tokens.unwrap_or(0)
                + usage.cache_read_tokens.unwrap_or(0),
        ),
        _ => None,
    };

    if summary.is_none() && usage.total_tokens.unwrap_or(0) == 0 {
        return Ok(None);
    }

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

    Ok(Some(VendorLogUsage {
        external_session_id: session_id,
        timestamp,
        model,
        tokens: usage,
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

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|candidate| candidate.as_str())
            .map(str::to_string)
    })
}

fn extract_codex_session_id(value: &Value) -> Option<String> {
    if let Some(id) = string_at(value, &["session_id", "sessionId", "id"]) {
        return Some(id);
    }
    let payload = value.get("payload")?;
    string_at(payload, &["session_id", "sessionId", "id"])
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

    fn protocol_tokens(total: i64) -> ProjectUsageSourcedTokens {
        ProjectUsageSourcedTokens {
            protocol: Some(ProjectUsageTokenCounts {
                input_tokens: Some(total / 2),
                output_tokens: Some(total / 2),
                cache_write_tokens: Some(0),
                cache_read_tokens: Some(0),
                total_tokens: Some(total),
            }),
            vendor_log: None,
            sources_disagree: false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn attributed_session(
        session_id: &str,
        workspace_id: &str,
        folder: &str,
        agent_id: &str,
        model: Option<&str>,
        tokens: ProjectUsageSourcedTokens,
        cost: Option<f64>,
        timestamp: i64,
    ) -> ProjectUsageSessionSummary {
        ProjectUsageSessionSummary {
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            folder: Some(folder.to_string()),
            agent_id: Some(agent_id.to_string()),
            timestamp,
            model: model.map(str::to_string),
            tokens,
            context_used: None,
            context_window_max: None,
            cost,
            summary: None,
            external_session_id: Some(session_id.to_string()),
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

    #[test]
    fn build_empty_project_usage_statistics_keeps_tokens_missing() {
        let result = build_project_usage_statistics(
            "project".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            Vec::new(),
            Vec::new(),
            0,
            0,
        );

        assert_eq!(result.project_id, "project-1");
        assert_eq!(result.total_sessions, 0);
        assert_eq!(result.estimated_cost, None);
        assert_eq!(result.total_tokens.protocol, None);
        assert!(result.sessions.is_empty());
    }

    #[test]
    fn attribution_uses_workspace_id_not_folder_path() {
        let now = 1_725_000_000_000;
        let same_repo = "/repo";
        let sessions = vec![
            attributed_session(
                "root",
                "workspace-root",
                same_repo,
                "kimi",
                None,
                ProjectUsageSourcedTokens::default(),
                None,
                now,
            ),
            attributed_session(
                "worktree",
                "workspace-wt",
                same_repo,
                "claude_code",
                Some("claude-sonnet-4"),
                protocol_tokens(200),
                Some(0.2),
                now,
            ),
        ];

        let result = build_project_usage_statistics(
            "project".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            sessions,
            vec![provider_ok("claude")],
            0,
            now,
        );

        assert_eq!(result.total_sessions, 2);
        assert_eq!(result.by_folder.len(), 2);
        assert!(
            result
                .by_folder
                .iter()
                .any(|folder| folder.workspace_id == "workspace-root" && folder.session_count == 1)
        );
        assert!(
            result
                .by_folder
                .iter()
                .any(|folder| folder.workspace_id == "workspace-wt" && folder.session_count == 1)
        );
        assert_eq!(result.by_agent.len(), 2);
    }

    #[test]
    fn missing_protocol_tokens_stay_missing_and_are_not_zero() {
        let now = 1_725_000_000_000;
        let sessions = vec![attributed_session(
            "kimi-1",
            "ws-1",
            "/repo/.worktrees/a",
            "kimi",
            None,
            ProjectUsageSourcedTokens::default(),
            None,
            now,
        )];

        let result = build_project_usage_statistics(
            "project".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            sessions,
            Vec::new(),
            0,
            now,
        );

        assert_eq!(result.total_tokens.protocol, None);
        assert_eq!(result.estimated_cost, None);
        assert_eq!(result.by_agent[0].tokens.protocol, None);
        assert!(!result.total_tokens.sources_disagree);
    }

    #[test]
    fn context_used_is_not_summed_into_token_totals() {
        let now = 1_725_000_000_000;
        let mut tokens = protocol_tokens(40);
        let sessions = vec![ProjectUsageSessionSummary {
            context_used: Some(90_000),
            context_window_max: Some(200_000),
            ..attributed_session(
                "occ",
                "ws-1",
                "/repo",
                "grok",
                None,
                tokens.clone(),
                None,
                now,
            )
        }];
        tokens.protocol.as_mut().unwrap().total_tokens = Some(40);

        let result = build_project_usage_statistics(
            "project".to_string(),
            "project-1".to_string(),
            "Demo".to_string(),
            sessions,
            Vec::new(),
            0,
            now,
        );

        assert_eq!(
            result
                .total_tokens
                .protocol
                .as_ref()
                .and_then(|t| t.total_tokens),
            Some(40)
        );
        assert_ne!(
            result.sessions[0].context_used,
            result
                .total_tokens
                .protocol
                .as_ref()
                .and_then(|t| t.total_tokens)
        );
    }

    #[test]
    fn vendor_alignment_is_by_external_session_id_and_never_sums() {
        let now = 1_725_000_000_000;
        let mut sessions = vec![attributed_session(
            "live-1",
            "ws-1",
            "/repo",
            "claude_code",
            Some("claude-sonnet-4"),
            protocol_tokens(100),
            Some(0.1),
            now,
        )];
        let vendor = vec![
            VendorLogUsage {
                external_session_id: "live-1".to_string(),
                timestamp: now,
                model: "claude-sonnet-4".to_string(),
                tokens: ProjectUsageTokenCounts {
                    input_tokens: Some(80),
                    output_tokens: Some(40),
                    cache_write_tokens: Some(0),
                    cache_read_tokens: Some(0),
                    total_tokens: Some(120),
                },
                cost: Some(0.2),
                summary: None,
                provider: "claude".to_string(),
            },
            VendorLogUsage {
                external_session_id: "orphan".to_string(),
                timestamp: now,
                model: "claude-sonnet-4".to_string(),
                tokens: ProjectUsageTokenCounts {
                    input_tokens: Some(10),
                    output_tokens: Some(10),
                    cache_write_tokens: Some(0),
                    cache_read_tokens: Some(0),
                    total_tokens: Some(20),
                },
                cost: Some(0.01),
                summary: None,
                provider: "claude".to_string(),
            },
        ];

        let unattributed = align_vendor_usage(&mut sessions, &vendor);
        assert_eq!(unattributed, 1);
        assert_eq!(
            sessions[0]
                .tokens
                .vendor_log
                .as_ref()
                .and_then(|t| t.total_tokens),
            Some(120)
        );
        assert!(sessions[0].tokens.sources_disagree);
        assert_eq!(
            sessions[0]
                .tokens
                .protocol
                .as_ref()
                .and_then(|t| t.total_tokens),
            Some(100)
        );
    }

    #[test]
    fn gpt_5_4_uses_official_input_cached_output_rates() {
        let usage = ProjectUsageTokenCounts {
            input_tokens: Some(400_000),
            output_tokens: Some(300_000),
            cache_write_tokens: Some(100_000),
            cache_read_tokens: Some(200_000),
            total_tokens: Some(1_000_000),
        };

        let cost = calculate_usage_cost(&usage, openai_cost_rates("gpt-5.4")).expect("cost");

        assert!((cost - 5.55).abs() < 0.000_001);
    }
}
