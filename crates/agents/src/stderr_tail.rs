//! Per-connection agent stderr ring buffer + diagnostic redaction.
//!
//! When an agent reports `EndTurn` without producing any output, or fails
//! during handshake / mid-turn, the out-of-band evidence available is what the
//! agent printed to stderr and what the host failed to parse.
//!
//! # Security model
//!
//! Everything collected here can end up rendered in the UI or persisted in
//! error events. Therefore **redaction happens on write**: neither
//! [`StderrTail`] nor the caller's turn probe ever holds plaintext, and every
//! read path is safe by construction.
//!
//! Two redaction layers:
//! - [`sanitize_diagnostic`] — a denylist for agent stderr (ANSI-stripped +
//!   credential patterns replaced with `<redacted>`).
//! - [`summarize_parser_error`] — a **default-deny structural allowlist** for
//!   deserialization errors so arbitrary `session/update` payload values are
//!   never echoed.

use std::{
    collections::VecDeque,
    fmt,
    sync::{Mutex, OnceLock},
};

use regex::Regex;

/// Max lines retained. Bounds memory for a chatty agent; the tail is all
/// anyone reads.
const MAX_LINES: usize = 200;
/// Max total bytes retained across all lines.
const MAX_BYTES: usize = 32 * 1024;
/// Max bytes retained for a single line. Agents occasionally dump a whole JSON
/// blob on one line; keep the head, which is where the message lives.
const MAX_LINE_BYTES: usize = 512;
/// Upper bound on how much of an input line is scanned for redaction. Beyond
/// this the tail is discarded outright (never retained), so it bounds the
/// regex cost without opening a truncation-boundary leak.
const MAX_SCAN_BYTES: usize = 16 * 1024;
/// Max bytes for a summarized parser error.
const MAX_DROP_ERROR_BYTES: usize = 200;

/// Where a [`tail_since`](StderrTail::tail_since) slice came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailScope {
    /// Lines emitted after the mark — i.e. during the turn being diagnosed.
    ThisTurn,
    /// The mark matched nothing, so this is the most recent output from
    /// *before* the turn (typically a connect-time failure). Rendered with a
    /// different label so the reader isn't told stale lines are fresh.
    Recent,
}

/// Result of [`StderrTail::tail_since`].
#[derive(Debug, Clone)]
pub struct TailSlice {
    pub lines: Vec<String>,
    pub scope: TailScope,
}

impl TailSlice {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// Bounded ring buffer of an agent process's stderr, redacted on write.
#[derive(Debug, Default)]
pub struct StderrTail {
    inner: Mutex<TailInner>,
}

#[derive(Debug, Default)]
struct TailInner {
    lines: VecDeque<(u64, String)>,
    next_seq: u64,
    bytes: usize,
}

impl StderrTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record stderr text (one or more lines). ANSI-stripped, trimmed,
    /// redacted, and truncated before it lands — the buffer never holds
    /// plaintext.
    ///
    /// A poisoned lock is recovered rather than propagated: this is a
    /// diagnostic side channel and must never be able to take down a live
    /// agent connection.
    pub fn push(&self, raw: &str) {
        for raw_line in raw.split('\n') {
            self.push_single_line(raw_line);
        }
    }

    fn push_single_line(&self, raw: &str) {
        let line = strip_ansi(raw);
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        // Bound the regex scan for a pathological multi-MB line. Whatever is
        // dropped here is dropped entirely — never retained unredacted — and
        // the surviving prefix is orders of magnitude shorter than this cap.
        let scanned = truncate_bytes(line, MAX_SCAN_BYTES);
        // Redact BEFORE truncating to the retained length so a credential
        // straddling the 512-byte cut cannot survive as an unrecognized
        // fragment.
        let line = sanitize_diagnostic(&scanned);
        let line = truncate_bytes(&line, MAX_LINE_BYTES);
        if line.is_empty() {
            return;
        }

        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.bytes += line.len();
        inner.lines.push_back((seq, line));
        while inner.lines.len() > MAX_LINES || (inner.bytes > MAX_BYTES && inner.lines.len() > 1) {
            match inner.lines.pop_front() {
                Some((_, dropped)) => inner.bytes = inner.bytes.saturating_sub(dropped.len()),
                None => break,
            }
        }
    }

    /// Snapshot the current write position. Taken before a turn's prompt
    /// request is dispatched, so "this turn" has a defined lower bound.
    pub fn mark(&self) -> u64 {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_seq
    }

    /// Lines recorded strictly at or after `mark`, joined by `\n`.
    pub fn since(&self, mark: u64) -> String {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// All currently retained lines joined by `\n`, or `None` if empty.
    pub fn summary(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.lines.is_empty() {
            return None;
        }
        let joined = inner
            .lines
            .iter()
            .map(|(_, line)| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        (!joined.is_empty()).then_some(joined)
    }

    /// Lines recorded at or after `mark`, newest-last, capped.
    ///
    /// Falls back to the most recent lines overall when the turn itself
    /// produced no stderr — a connect-time failure is still the best evidence
    /// available — and says so via [`TailScope`].
    pub fn tail_since(&self, mark: u64, max_lines: usize, max_bytes: usize) -> TailSlice {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let this_turn: Vec<&String> = inner
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line)
            .collect();
        let (source, scope) = if this_turn.is_empty() {
            (
                inner.lines.iter().map(|(_, line)| line).collect::<Vec<_>>(),
                TailScope::Recent,
            )
        } else {
            (this_turn, TailScope::ThisTurn)
        };

        // Take from the tail: the last lines before the turn ended are the
        // ones that explain why.
        let mut picked: Vec<String> = Vec::new();
        let mut used = 0usize;
        for line in source.iter().rev() {
            if picked.len() >= max_lines || used + line.len() > max_bytes {
                break;
            }
            used += line.len();
            picked.push((*line).clone());
        }
        picked.reverse();
        TailSlice {
            lines: picked,
            scope,
        }
    }
}

/// Strip ANSI escape sequences (CSI and OSC) that agents use for colored logs.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final-byte in @-~
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escape (ESC c, ESC =, …): drop the pair.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Truncate to at most `max` bytes without splitting a UTF-8 char.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

/// Collapse runs of whitespace into single spaces.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

type Rules = Vec<(Regex, &'static str)>;

/// Credential-shaped patterns replaced in free-form diagnostic text.
fn denylist() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Vec<(&str, &str)> = vec![
            // Multi-line or inline PEM private key blocks.
            (
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY (<redacted>)-----",
            ),
            (
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY (<redacted>)-----",
            ),
            // Header forms first: they subsume any scheme (Bearer/Basic/Digest/custom).
            (
                r"(?i)\bauthorization\s*[:=]\s*.*",
                "Authorization: <redacted>",
            ),
            (r"(?i)\b(set-)?cookie\s*[:=]\s*.*", "${1}cookie: <redacted>"),
            // Bare `Bearer <token>` with no header prefix.
            (
                r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}",
                "Bearer <redacted>",
            ),
            // Named secrets in JSON (`"api_key": "..."`) or KV (`api_key=...` / `api_key: ...`).
            (
                r#"(?i)["']?\b(api[_\-]?key|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|id[_\-]?token|client[_\-]?secret|token|secret|passwd|password|private[_\-]?key)\b["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,}]+)"#,
                "$1=<redacted>",
            ),
            // Credentials embedded in a URI authority.
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@",
                "${1}<redacted>:<redacted>@",
            ),
            // Same, without the terminating `@` when password exceeds scan bound.
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]{16,}",
                "${1}<redacted>:<redacted>",
            ),
            // Well-known token shapes.
            (r"sk-[A-Za-z0-9_\-]{12,}", "sk-<redacted>"),
            (
                r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}",
                "${1}_<redacted>",
            ),
            (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "xox*-<redacted>"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA<redacted>"),
            (r"\bAIza[0-9A-Za-z_\-]{20,}", "AIza<redacted>"),
            (
                r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+",
                "<jwt <redacted>>",
            ),
        ];
        rules
            .into_iter()
            .filter_map(|(pattern, replacement)| match Regex::new(pattern) {
                Ok(re) => Some((re, replacement)),
                Err(e) => {
                    tracing::error!("[stderr_tail] invalid redaction pattern {pattern:?}: {e}");
                    None
                }
            })
            .collect()
    })
}

/// Strip ANSI escape sequences and redact credential-shaped substrings from
/// free-form diagnostic text.
pub fn sanitize_diagnostic(s: &str) -> String {
    let mut out = strip_ansi(s);
    for (re, replacement) in denylist() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

const SAFE_EXPECT_PHRASES: &[&str] = &[
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "f32",
    "f64",
    "bool",
    "char",
    "string",
    "str",
    "unit",
    "option",
    "seq",
    "map",
    "integer",
    "boolean",
    "null",
    "byte array",
    "floating point number",
    "a string",
    "an integer",
    "a sequence",
    "a map",
    "a boolean",
    "a borrowed string",
    "a byte array",
    "a character",
    "unit struct",
    "newtype struct",
];

const SAFE_SCHEMA_IDENTS: &[&str] = &[
    "sessionId",
    "sessionUpdate",
    "update",
    "content",
    "role",
    "toolCallId",
    "toolCall",
    "status",
    "kind",
    "title",
    "rawInput",
    "rawOutput",
    "entries",
    "used",
    "size",
    "stopReason",
    "meta",
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
    "current_mode_update",
    "available_commands_update",
    "session_info_update",
    "config_option_update",
    "SessionNotification",
    "SessionUpdate",
    "ContentBlock",
    "ToolCall",
    "ToolCallUpdate",
];

fn is_safe_ident(s: &str) -> bool {
    SAFE_SCHEMA_IDENTS.contains(&s)
}

fn safe_expectation(exp: &str) -> bool {
    let exp = exp.trim().trim_end_matches(['.', ',']);
    if SAFE_EXPECT_PHRASES.contains(&exp) {
        return true;
    }
    for prefix in ["struct ", "enum ", "unit variant ", "struct variant "] {
        if let Some(ident) = exp.strip_prefix(prefix) {
            return is_safe_ident(ident.trim());
        }
    }
    if let Some(list) = exp.strip_prefix("one of ") {
        let mut any = false;
        for item in list.split(',') {
            let item = item.trim();
            let Some(ident) = item.strip_prefix('`').and_then(|i| i.strip_suffix('`')) else {
                return false;
            };
            if !is_safe_ident(ident) {
                return false;
            }
            any = true;
        }
        return any;
    }
    false
}

type ShapeRule = (Regex, &'static str, bool);

fn shape_rules() -> &'static Vec<ShapeRule> {
    static RULES: OnceLock<Vec<ShapeRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let specs: Vec<(&str, &str, bool)> = vec![
            (
                r"^invalid type:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid type",
                false,
            ),
            (
                r"^invalid value:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid value",
                false,
            ),
            (
                r"^invalid length.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid length",
                false,
            ),
            (
                r"^unknown variant\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown variant",
                true,
            ),
            (
                r"^unknown field\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown field",
                true,
            ),
        ];
        specs
            .into_iter()
            .filter_map(
                |(pattern, category, subject_is_payload)| match Regex::new(pattern) {
                    Ok(re) => Some((re, category, subject_is_payload)),
                    Err(e) => {
                        tracing::error!("[stderr_tail] invalid shape pattern {pattern:?}: {e}");
                        None
                    }
                },
            )
            .collect()
    })
}

fn missing_field_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^missing field\s+`(?P<field>[^`]*)`").unwrap())
}

fn position_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bat line \d+ column \d+").unwrap())
}

const SAFE_SYNTAX_PREFIXES: &[&str] = &[
    "EOF while parsing",
    "trailing characters",
    "expected value",
    "key must be a string",
    "control character",
    "invalid unicode code point",
    "number out of range",
    "recursion limit exceeded",
];

/// Reduce a deserialization error (`&serde_json::Error`, `&str`, etc.) to a
/// bounded, payload-free summary.
///
/// **Default deny.** The input is matched against a closed set of shapes and
/// rebuilt from templates, with every retained fragment checked against a
/// finite allowlist. Anything unrecognized collapses to
/// `unrecognized parse error (redacted)`.
pub fn summarize_parser_error(e: impl fmt::Display) -> String {
    let raw = e.to_string();
    let first = raw.lines().next().unwrap_or("").trim();
    let first = collapse_whitespace(first);
    let position = position_rule()
        .find(&first)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let body = summarize_body(&first);
    let mut out = body;
    if !position.is_empty() {
        out.push(' ');
        out.push_str(&position);
    }
    let out = sanitize_diagnostic(&out);
    truncate_bytes(&out, MAX_DROP_ERROR_BYTES)
}

fn summarize_body(first: &str) -> String {
    if let Some(caps) = missing_field_rule().captures(first) {
        let field = caps.name("field").map(|m| m.as_str()).unwrap_or("");
        return if is_safe_ident(field) {
            format!("missing field `{field}`")
        } else {
            "missing field (redacted)".to_string()
        };
    }

    for (re, category, subject_is_payload) in shape_rules() {
        let Some(caps) = re.captures(first) else {
            continue;
        };
        let exp = caps.name("exp").map(|m| m.as_str()).unwrap_or("").trim();
        let exp = position_rule().replace(exp, "").trim().to_string();
        let exp = exp.trim_end_matches(',').trim().to_string();
        if !safe_expectation(&exp) {
            return format!("{category} (redacted)");
        }
        let head = if *subject_is_payload {
            format!("{category} (redacted)")
        } else {
            (*category).to_string()
        };
        return format!("{head}, expected {exp}");
    }

    if let Some(phrase) = SAFE_SYNTAX_PREFIXES.iter().find(|p| first.starts_with(**p)) {
        return (*phrase).to_string();
    }

    "unrecognized parse error (redacted)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_strips_ansi_and_drops_blank_lines() {
        let tail = StderrTail::new();
        tail.push("\u{1b}[31mboom\u{1b}[0m");
        tail.push("   ");
        tail.push("");
        tail.push("\u{1b}]0;title\u{7}second");
        let slice = tail.tail_since(0, 10, 4096);
        assert_eq!(slice.lines, vec!["boom", "second"]);
        assert_eq!(tail.summary().as_deref(), Some("boom\nsecond"));
    }

    #[test]
    fn push_truncates_long_line_on_char_boundary() {
        let tail = StderrTail::new();
        tail.push(&"中".repeat(400)); // 1200 bytes
        let slice = tail.tail_since(0, 10, 8192);
        assert_eq!(slice.lines.len(), 1);
        let line = &slice.lines[0];
        assert!(line.len() <= MAX_LINE_BYTES + '…'.len_utf8());
        assert!(line.ends_with('…'));
        assert!(!line.contains('\u{fffd}'));
    }

    #[test]
    fn evicts_oldest_beyond_line_cap() {
        let tail = StderrTail::new();
        for i in 0..(MAX_LINES + 50) {
            tail.push(&format!("line-{i}"));
        }
        let slice = tail.tail_since(0, MAX_LINES + 100, 1024 * 1024);
        assert_eq!(slice.lines.len(), MAX_LINES);
        assert_eq!(slice.lines[0], format!("line-{}", 50));
        assert_eq!(
            slice.lines[MAX_LINES - 1],
            format!("line-{}", MAX_LINES + 49)
        );
    }

    #[test]
    fn evicts_beyond_byte_cap() {
        let tail = StderrTail::new();
        for i in 0..100 {
            tail.push(&format!("{i:04}{}", "x".repeat(496)));
        }
        let inner = tail.inner.lock().unwrap();
        assert!(inner.bytes <= MAX_BYTES, "bytes={}", inner.bytes);
        assert!(inner.lines.len() < 100);
    }

    #[test]
    fn mark_and_since_isolate_turns() {
        let tail = StderrTail::new();
        tail.push("before-1");
        tail.push("before-2");
        let mark = tail.mark();
        assert_eq!(tail.since(mark), "");

        tail.push("during-1\nduring-2");
        assert_eq!(tail.since(mark), "during-1\nduring-2");

        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::ThisTurn);
        assert_eq!(slice.lines, vec!["during-1", "during-2"]);
    }

    #[test]
    fn tail_since_falls_back_to_recent_when_turn_silent() {
        let tail = StderrTail::new();
        tail.push("before-1");
        let mark = tail.mark();
        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::Recent);
        assert_eq!(slice.lines, vec!["before-1"]);
    }

    #[test]
    fn redacts_known_token_shapes_and_headers() {
        let cases = [
            (
                "key sk-live-abcdefghijklmno here",
                "sk-live-abcdefghijklmno",
            ),
            (
                "token ghp_abcdefghijklmnopqrstuvwxyz01",
                "ghp_abcdefghijklmnopqrstuvwxyz01",
            ),
            (
                "pat github_pat_11AA22BB33CC44DD55EE66FF77GG",
                "11AA22BB33CC44DD55EE66FF77GG",
            ),
            ("slack xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"),
            ("aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
            (
                "google AIzaSyDaGmWKa4JsXZ-HjGw7xH_example12345",
                "AIzaSyDaGmWKa4JsXZ-HjGw7xH_example12345",
            ),
            ("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"),
            ("authorization=Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("Cookie: session=deadbeefdeadbeef", "deadbeefdeadbeef"),
            ("Set-Cookie: sid=abcdef123456", "abcdef123456"),
            ("connect https://user:hunter2@example.com/x", "hunter2"),
            ("Bearer abcdefghijklmnopqrst failed", "abcdefghijklmnopqrst"),
            ("invalid api_key=sk_test_abcdef", "sk_test_abcdef"),
            (r#"{"api_key": "secret_json_val"}"#, "secret_json_val"),
            ("token: my_super_secret_token", "my_super_secret_token"),
            ("refresh_token=ref_secret_999", "ref_secret_999"),
            ("password: hunter2hunter2", "hunter2hunter2"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc",
                "eyJzdWIiOiIxMjM0NSJ9",
            ),
            (
                "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
                "MIIEpAIBAAKCAQEA",
            ),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
            assert!(
                out.contains("<redacted>"),
                "expected <redacted> marker in {out:?}"
            );
        }
    }

    #[test]
    fn leaves_benign_text_alone() {
        for benign in [
            "skipped 3 files",
            "token_count=12",
            "Authorization header missing",
            "reading package.json",
            "fetching https://example.com:8080/v1/models",
            "listening on http://127.0.0.1:3000",
        ] {
            assert_eq!(sanitize_diagnostic(benign), benign, "mangled {benign:?}");
        }
    }

    #[test]
    fn redacts_before_truncating_so_a_split_secret_cannot_survive() {
        const SECRET: &str = "sk-live-abcdefghijklmnopqrstuvwxyz";
        let tail = StderrTail::new();
        let prefix = "x".repeat(MAX_LINE_BYTES - 16);
        tail.push(&format!("{prefix}{SECRET} trailing"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("sk-live"), "leaked fragment in {line:?}");
        assert!(
            line.contains("sk-<redacted>"),
            "expected redaction marker in {line:?}"
        );
    }

    #[test]
    fn summarize_parser_error_enforces_default_deny_and_accepts_serde_error() {
        const SECRET: &str = "sk-live-abcdefghijklmnop";
        let serde_err = serde_json::from_str::<u64>(&format!(r#""{SECRET}""#)).unwrap_err();
        let summary = summarize_parser_error(&serde_err);
        assert!(
            summary.starts_with("invalid type, expected u64"),
            "got {summary:?}"
        );
        assert!(!summary.contains(SECRET));

        let inputs = [
            format!(r#"invalid type: string "{SECRET}", expected u64 at line 1 column 40"#),
            format!("unknown variant `{SECRET}`, expected one of `plan`, `usage_update`"),
            format!("unknown field `{SECRET}`, expected `sessionUpdate`"),
            format!("missing field `{SECRET}`"),
            format!("invalid value: string, expected {SECRET}"),
            format!("weird custom error mentioning {SECRET} inline"),
            format!("EOF while parsing {SECRET}"),
        ];
        for input in inputs {
            let out = summarize_parser_error(&input);
            assert!(!out.contains(SECRET), "leaked from {input:?} -> {out:?}");
        }
    }
}
