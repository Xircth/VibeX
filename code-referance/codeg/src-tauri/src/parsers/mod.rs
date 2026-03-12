pub mod claude;
pub mod codex;
pub mod gemini;
pub mod opencode;

use std::sync::OnceLock;

use regex::Regex;

use crate::models::{
    ConversationDetail, ConversationSummary, MessageTurn, SessionStats, TurnUsage,
};

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Database error: {0}")]
    Db(#[from] sea_orm::DbErr),
    #[error("Conversation not found: {0}")]
    ConversationNotFound(String),
    #[error("Invalid data: {0}")]
    InvalidData(String),
}

pub trait AgentParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError>;
    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError>;
}

/// Truncate a string to `max_len` characters, appending "..." if truncated.
pub fn truncate_str(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}...", truncated)
    }
}

/// Aggregate turn-level usage and duration into a single `SessionStats`.
pub fn compute_session_stats(turns: &[MessageTurn]) -> Option<SessionStats> {
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut total_cache_create = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_duration = 0u64;
    let mut has_data = false;

    for turn in turns {
        if let Some(ref u) = turn.usage {
            total_in += u.input_tokens;
            total_out += u.output_tokens;
            total_cache_create += u.cache_creation_input_tokens;
            total_cache_read += u.cache_read_input_tokens;
            has_data = true;
        }
        if let Some(d) = turn.duration_ms {
            total_duration += d;
        }
    }

    if !has_data {
        return None;
    }

    Some(SessionStats {
        total_usage: Some(TurnUsage {
            input_tokens: total_in,
            output_tokens: total_out,
            cache_creation_input_tokens: total_cache_create,
            cache_read_input_tokens: total_cache_read,
        }),
        total_tokens: Some(total_in + total_out + total_cache_create + total_cache_read),
        total_duration_ms: total_duration,
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        context_window_usage_percent: None,
    })
}

fn model_capacity_suffix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\[\s*([0-9]+(?:\.[0-9]+)?)\s*([km])\s*\]\s*$")
            .expect("valid model capacity regex")
    })
}

fn parse_model_capacity_suffix(model: &str) -> Option<u64> {
    let captures = model_capacity_suffix_regex().captures(model.trim())?;
    let value = captures.get(1)?.as_str().parse::<f64>().ok()?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }

    let unit = captures
        .get(2)
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_default();
    let multiplier = match unit.as_str() {
        "m" => 1_000_000.0,
        "k" => 1_000.0,
        _ => return None,
    };

    Some((value * multiplier) as u64)
}

pub fn infer_context_window_max_tokens(model: Option<&str>) -> Option<u64> {
    let raw = model?.trim();
    if raw.is_empty() {
        return None;
    }

    if let Some(suffixed_limit) = parse_model_capacity_suffix(raw) {
        return Some(suffixed_limit);
    }

    let normalized = raw
        .rsplit('/')
        .next()
        .unwrap_or(raw)
        .split(':')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_ascii_lowercase();

    if normalized.starts_with("claude") {
        return Some(200_000);
    }
    if normalized.starts_with("gemini") {
        return Some(1_000_000);
    }

    match normalized.as_str() {
        "gpt-5.2-codex" | "gpt-5.1-codex-max" | "gpt-5.1-codex-mini" | "gpt-5.2" => Some(258_000),
        "gpt-5.1" | "gpt-5.1-codex" | "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" | "o1-mini"
        | "o1-preview" => Some(128_000),
        "gpt-4" => Some(8_192),
        "o3" | "o3-mini" | "o1" => Some(200_000),
        _ => {
            if normalized.starts_with("gpt-5") {
                Some(258_000)
            } else if normalized.starts_with("gpt-4o")
                || normalized.starts_with("gpt-4.1")
                || normalized.starts_with("gpt-4-turbo")
            {
                Some(128_000)
            } else if normalized.starts_with("o3") || normalized == "o1" {
                Some(200_000)
            } else if normalized.starts_with("o1-mini") || normalized.starts_with("o1-preview") {
                Some(128_000)
            } else {
                None
            }
        }
    }
}

pub fn latest_turn_total_usage_tokens(turns: &[MessageTurn]) -> Option<u64> {
    turns.iter().rev().find_map(|turn| {
        turn.usage.as_ref().map(|usage| {
            usage
                .input_tokens
                .saturating_add(usage.output_tokens)
                .saturating_add(usage.cache_creation_input_tokens)
                .saturating_add(usage.cache_read_input_tokens)
        })
    })
}

pub fn merge_context_window_stats(
    stats: Option<SessionStats>,
    used_tokens: Option<u64>,
    max_tokens: Option<u64>,
) -> Option<SessionStats> {
    if used_tokens.is_none() && max_tokens.is_none() {
        return stats;
    }

    let usage_percent = match (used_tokens, max_tokens) {
        (Some(used), Some(max)) if max > 0 => Some((used as f64 / max as f64) * 100.0),
        _ => None,
    };

    match stats {
        Some(mut s) => {
            s.context_window_used_tokens = used_tokens;
            s.context_window_max_tokens = max_tokens;
            s.context_window_usage_percent = usage_percent;
            Some(s)
        }
        None => Some(SessionStats {
            total_usage: None,
            total_tokens: None,
            total_duration_ms: 0,
            context_window_used_tokens: used_tokens,
            context_window_max_tokens: max_tokens,
            context_window_usage_percent: usage_percent,
        }),
    }
}

/// Extract the last path component as the folder name.
pub fn folder_name_from_path(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Normalize a filesystem path string for tolerant cross-platform comparison.
/// This intentionally does not hit the filesystem (no canonicalize), and only
/// normalizes separators/casing differences that commonly break exact matching.
pub fn normalize_path_for_matching(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");

    #[cfg(target_os = "windows")]
    {
        if let Some(stripped) = normalized.strip_prefix("//?/") {
            normalized = stripped.to_string();
        }
        normalized = normalized.to_ascii_lowercase();
    }

    while normalized.ends_with('/') {
        if normalized == "/" {
            break;
        }
        // Keep Windows drive root such as "c:/" intact.
        if normalized.len() == 3
            && normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/')
        {
            break;
        }
        normalized.pop();
    }

    normalized
}

pub fn path_eq_for_matching(left: &str, right: &str) -> bool {
    normalize_path_for_matching(left) == normalize_path_for_matching(right)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::{
        infer_context_window_max_tokens, latest_turn_total_usage_tokens,
        merge_context_window_stats, path_eq_for_matching,
    };
    use crate::models::{MessageTurn, SessionStats, TurnRole, TurnUsage};

    #[test]
    fn infers_model_context_limits() {
        assert_eq!(
            infer_context_window_max_tokens(Some("claude-sonnet-4-6")),
            Some(200_000)
        );
        assert_eq!(
            infer_context_window_max_tokens(Some("gemini-2.5-pro")),
            Some(1_000_000)
        );
        assert_eq!(
            infer_context_window_max_tokens(Some("claude-sonnet-4-6 [1.5M]")),
            Some(1_500_000)
        );
        assert_eq!(infer_context_window_max_tokens(Some("unknown-model")), None);
    }

    #[test]
    fn picks_latest_turn_usage_total_tokens() {
        let timestamp = Utc::now();
        let turns = vec![
            MessageTurn {
                id: "turn-0".to_string(),
                role: TurnRole::Assistant,
                blocks: vec![],
                timestamp,
                usage: Some(TurnUsage {
                    input_tokens: 10,
                    output_tokens: 20,
                    cache_creation_input_tokens: 30,
                    cache_read_input_tokens: 40,
                }),
                duration_ms: None,
                model: None,
            },
            MessageTurn {
                id: "turn-1".to_string(),
                role: TurnRole::Assistant,
                blocks: vec![],
                timestamp,
                usage: Some(TurnUsage {
                    input_tokens: 11,
                    output_tokens: 21,
                    cache_creation_input_tokens: 31,
                    cache_read_input_tokens: 41,
                }),
                duration_ms: None,
                model: None,
            },
        ];

        assert_eq!(latest_turn_total_usage_tokens(&turns), Some(104));
    }

    #[test]
    fn merges_context_window_stats() {
        let merged = merge_context_window_stats(None, Some(1500), Some(3000))
            .expect("context stats should exist");
        assert_eq!(merged.context_window_used_tokens, Some(1500));
        assert_eq!(merged.context_window_max_tokens, Some(3000));
        assert!(merged.total_usage.is_none());
        let percent = merged
            .context_window_usage_percent
            .expect("usage percent should exist");
        assert!((percent - 50.0).abs() < f64::EPSILON);

        let existing = Some(SessionStats {
            total_usage: Some(TurnUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 4,
            }),
            total_tokens: Some(10),
            total_duration_ms: 100,
            context_window_used_tokens: None,
            context_window_max_tokens: None,
            context_window_usage_percent: None,
        });
        let merged_existing =
            merge_context_window_stats(existing, Some(200), Some(1000)).expect("merged");
        assert_eq!(merged_existing.total_tokens, Some(10));
        assert_eq!(merged_existing.context_window_used_tokens, Some(200));
        assert_eq!(merged_existing.context_window_max_tokens, Some(1000));
    }

    #[test]
    fn path_matching_handles_separator_differences() {
        assert!(path_eq_for_matching(
            "/Users/demo/workspace/codeg",
            "/Users/demo/workspace/codeg/"
        ));
        assert!(path_eq_for_matching(
            "C:\\Users\\demo\\workspace\\codeg",
            "C:/Users/demo/workspace/codeg"
        ));
    }
}
