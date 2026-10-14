//! Per-tab ring of what the page printed to its console.
//!
//! Captured per tab, cleared on navigation, and filtered to the tab's active
//! origin when read so cross-origin subframes never leak into an agent's read
//! of the top-level page.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_ENTRIES: usize = 200;
pub const MAX_ENTRY_CHARS: usize = 2_000;
pub const MAX_RING_CHARS: usize = 100_000;
pub const DEFAULT_READ_LIMIT: usize = 100;
pub const MAX_READ_LIMIT: usize = 200;
pub const CDP_MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleLevel {
    Debug,
    #[default]
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Some(Self::Debug),
            "log" | "dir" | "dirxml" | "table" | "count" | "timeend" => Some(Self::Log),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" | "assert" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Log => "log",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleSource {
    #[default]
    Console,
    Error,
    UnhandledRejection,
}

impl ConsoleSource {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "error" => Self::Error,
            "unhandled-rejection" | "unhandledRejection" => Self::UnhandledRejection,
            _ => Self::Console,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub seq: u64,
    pub level: ConsoleLevel,
    pub source: ConsoleSource,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub at: i64,
    pub top: bool,
    #[serde(skip)]
    pub frame_origin: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    pub level: ConsoleLevel,
    #[serde(default)]
    pub source: ConsoleSource,
    pub text: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    pub at: i64,
    #[serde(default = "default_top")]
    pub top: bool,
    #[serde(default)]
    pub frame_origin: Option<String>,
}

fn default_top() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleQuery {
    #[serde(default)]
    pub since: u64,
    #[serde(default)]
    pub min_level: Option<ConsoleLevel>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleRead {
    pub url: String,
    pub entries: Vec<ConsoleEntry>,
    pub dropped: u64,
    pub next_since: u64,
    pub more: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ConsoleRing {
    entries: VecDeque<ConsoleEntry>,
    chars: usize,
    next_seq: u64,
    dropped: u64,
}

impl ConsoleRing {
    pub fn clear(&mut self) {
        self.entries.clear();
        self.chars = 0;
        self.dropped = 0;
    }

    pub fn push(&mut self, line: ConsoleLine) -> u64 {
        let (text, clipped) = cap_chars(&line.text, MAX_ENTRY_CHARS);
        if clipped {
            self.dropped = self.dropped.saturating_add(1);
        }
        let weight = text.chars().count();
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let url = line.url.filter(|u| !u.is_empty()).map(|u| cap_chars(&u, 512).0);
        self.entries.push_back(ConsoleEntry {
            seq,
            level: line.level,
            source: line.source,
            text,
            url,
            line: line.line,
            column: line.column,
            at: line.at,
            top: line.top,
            frame_origin: line.frame_origin,
        });
        self.chars = self.chars.saturating_add(weight);
        while self.entries.len() > MAX_ENTRIES
            || (self.chars > MAX_RING_CHARS && self.entries.len() > 1)
        {
            if let Some(old) = self.entries.pop_front() {
                self.chars = self.chars.saturating_sub(old.text.chars().count());
                self.dropped = self.dropped.saturating_add(1);
            }
        }
        seq
    }

    pub fn read(&self, url: &str, origin: &str, query: &ConsoleQuery) -> ConsoleRead {
        let min = query.min_level.unwrap_or(ConsoleLevel::Debug);
        let limit = query
            .limit
            .unwrap_or(DEFAULT_READ_LIMIT)
            .clamp(1, MAX_READ_LIMIT);
        let mut matching = self.entries.iter().filter(|e| {
            e.seq > query.since
                && e.level >= min
                && (e.top || e.frame_origin.as_deref() == Some(origin))
        });
        let entries: Vec<ConsoleEntry> = matching.by_ref().take(limit).cloned().collect();
        let more = matching.next().is_some();
        let next_since = if more {
            entries.last().map(|e| e.seq).unwrap_or(query.since)
        } else {
            self.next_seq.max(query.since)
        };
        ConsoleRead {
            url: url.to_string(),
            entries,
            dropped: self.dropped,
            next_since,
            more,
        }
    }
}

fn cap_chars(raw: &str, max: usize) -> (String, bool) {
    let mut chars = raw.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        (format!("{head}…"), true)
    } else {
        (raw.to_string(), false)
    }
}

pub fn cdp_context_origin(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw == "null" || raw == "://" {
        return None;
    }
    let parsed = url::Url::parse(raw).ok()?;
    match parsed.scheme() {
        "http" | "https" => Some(parsed.origin().ascii_serialization()),
        _ => None,
    }
}

pub fn cdp_console_line(
    params: &Value,
    at: i64,
    top: bool,
    frame_origin: Option<String>,
) -> Option<ConsoleLine> {
    let kind = params.get("type")?.as_str()?;
    let level = ConsoleLevel::parse(kind)?;
    let args = params
        .get("args")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let text = args
        .iter()
        .map(format_remote_object)
        .collect::<Vec<_>>()
        .join(" ");
    let (url, line, column) = top_call_frame(params.get("stackTrace"));
    Some(ConsoleLine {
        level,
        source: ConsoleSource::Console,
        text,
        url,
        line,
        column,
        at,
        top,
        frame_origin,
    })
}

pub fn cdp_exception_line(
    params: &Value,
    at: i64,
    top: bool,
    frame_origin: Option<String>,
) -> Option<ConsoleLine> {
    let details = params.get("exceptionDetails")?;
    let head = details.get("text").and_then(Value::as_str).unwrap_or("Uncaught");
    let body = details
        .get("exception")
        .map(format_remote_object)
        .filter(|s| !s.is_empty());
    let text = match body {
        Some(b) if head.ends_with(':') => format!("{head} {b}"),
        Some(b) if b.starts_with(head) => b,
        Some(b) => format!("{head}: {b}"),
        None => head.to_string(),
    };
    let (stack_url, stack_line, stack_col) = top_call_frame(details.get("stackTrace"));
    let url = details
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .map(str::to_string)
        .or(stack_url);
    let line = details
        .get("lineNumber")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n.saturating_add(1)).ok())
        .or(stack_line);
    let column = details
        .get("columnNumber")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n.saturating_add(1)).ok())
        .or(stack_col);
    Some(ConsoleLine {
        level: ConsoleLevel::Error,
        source: ConsoleSource::Error,
        text,
        url,
        line,
        column,
        at,
        top,
        frame_origin,
    })
}

fn format_remote_object(obj: &Value) -> String {
    if let Some(u) = obj.get("unserializableValue").and_then(Value::as_str) {
        return u.to_string();
    }
    if let Some(val) = obj.get("value") {
        return match val {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }
    if let Some(desc) = obj.get("description").and_then(Value::as_str) {
        return desc.to_string();
    }
    obj.get("type")
        .and_then(Value::as_str)
        .unwrap_or("undefined")
        .to_string()
}

fn top_call_frame(trace: Option<&Value>) -> (Option<String>, Option<u32>, Option<u32>) {
    let Some(frame) = trace
        .and_then(|t| t.get("callFrames"))
        .and_then(Value::as_array)
        .and_then(|frames| frames.first())
    else {
        return (None, None, None);
    };
    let url = frame
        .get("url")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .map(str::to_string);
    let line = frame
        .get("lineNumber")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n.saturating_add(1)).ok());
    let column = frame
        .get("columnNumber")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n.saturating_add(1)).ok());
    (url, line, column)
}
