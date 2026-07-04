//! `AgentKind` — the single, system-wide agent identity enum (ADR-0002).
//!
//! Historically agent identity had three parallel concepts — `agents::AgentType`
//! (serde snake_case), `executors::BaseCodingAgent` (serde/strum/sqlx
//! SCREAMING_SNAKE_CASE), and the `executor_key` bridge (`claude_code`, `opencode`) —
//! reconciled only by hand-written string `match` bridges. `AgentKind` collapses them
//! into one enum living in `api-types` (the shared leaf crate).
//!
//! ## Serialized form (canonical): snake_case
//!
//! `claude_code`, `codex`, `opencode`, `gemini`, `openclaw`, `cline`, `hermes`,
//! `qa_mock` — the `executor_key` form already persisted in `sessions.agent_type`.
//! `Serialize` / `Display` / `FromStr` / sqlx all emit this single canonical form.
//!
//! ## Read leniency (zero data migration, ADR-0002)
//!
//! Deserialization accepts every historically-persisted spelling — SCREAMING_SNAKE
//! (`CLAUDE_CODE`, `OPENCODE`), Pascal (`ClaudeCode`), kebab (`claude-code`), and the
//! old `AgentType` snake spellings (`open_code`, `open_claw`) — by normalizing case and
//! separators before matching. New writes converge on the canonical snake form; old rows
//! (scratch profiles, `ExecutorAction` payloads, `agent_setting` seeds) still parse.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use ts_rs::TS;

/// The stable, system-wide agent identity (ADR-0002). `QaMock` is a permanent 8th
/// variant — the `qa-mode` feature gates the mock executor's *availability*, not the
/// identity (feature-gating a variant only complicates serde / TS export).
///
/// `sqlx::Type` stores the canonical snake_case key (DB-generic derive; matches the
/// manual `Serialize`/`Display`). Manual `Serialize`/`Deserialize` (below) provide the
/// canonical-out / lenient-in behavior the derive can't.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, TS, sqlx::Type)]
#[ts(export, rename_all = "snake_case")]
#[sqlx(type_name = "TEXT", rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    Opencode,
    Gemini,
    Openclaw,
    Cline,
    Hermes,
    QaMock,
}

impl AgentKind {
    /// Every variant, in a stable order (registry / picker ordering).
    pub const ALL: [AgentKind; 8] = [
        AgentKind::ClaudeCode,
        AgentKind::Codex,
        AgentKind::Opencode,
        AgentKind::Gemini,
        AgentKind::Openclaw,
        AgentKind::Cline,
        AgentKind::Hermes,
        AgentKind::QaMock,
    ];

    /// The canonical snake_case key (what `Serialize` / `Display` / sqlx emit).
    pub const fn as_str(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude_code",
            AgentKind::Codex => "codex",
            AgentKind::Opencode => "opencode",
            AgentKind::Gemini => "gemini",
            AgentKind::Openclaw => "openclaw",
            AgentKind::Cline => "cline",
            AgentKind::Hermes => "hermes",
            AgentKind::QaMock => "qa_mock",
        }
    }

    /// Lenient parse: accepts any case/separator spelling any producer ever wrote
    /// (`CLAUDE_CODE`, `ClaudeCode`, `claude-code`, `open_code` → `Opencode`, …).
    /// Normalizing to lowercase-without-separators collapses every historical form.
    pub fn from_lenient(raw: &str) -> Option<Self> {
        let normalized: String = raw
            .chars()
            .filter(|c| *c != '_' && *c != '-')
            .flat_map(char::to_lowercase)
            .collect();
        let kind = match normalized.as_str() {
            "claudecode" => AgentKind::ClaudeCode,
            "codex" => AgentKind::Codex,
            "opencode" => AgentKind::Opencode,
            "gemini" => AgentKind::Gemini,
            "openclaw" => AgentKind::Openclaw,
            "cline" => AgentKind::Cline,
            "hermes" => AgentKind::Hermes,
            "qamock" => AgentKind::QaMock,
            _ => return None,
        };
        Some(kind)
    }
}

impl fmt::Display for AgentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for AgentKind {
    type Err = ParseAgentKindError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        AgentKind::from_lenient(s).ok_or_else(|| ParseAgentKindError(s.to_string()))
    }
}

/// Error for an unrecognizable agent-identity string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseAgentKindError(pub String);

impl fmt::Display for ParseAgentKindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown agent kind: {}", self.0)
    }
}

impl std::error::Error for ParseAgentKindError {}

impl Serialize for AgentKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AgentKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        AgentKind::from_lenient(&raw)
            .ok_or_else(|| D::Error::custom(format!("unknown agent kind: {raw}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_serialize_is_executor_key_snake_case() {
        let expected = [
            (AgentKind::ClaudeCode, "claude_code"),
            (AgentKind::Codex, "codex"),
            (AgentKind::Opencode, "opencode"),
            (AgentKind::Gemini, "gemini"),
            (AgentKind::Openclaw, "openclaw"),
            (AgentKind::Cline, "cline"),
            (AgentKind::Hermes, "hermes"),
            (AgentKind::QaMock, "qa_mock"),
        ];
        for (kind, key) in expected {
            assert_eq!(kind.as_str(), key);
            assert_eq!(kind.to_string(), key);
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{key}\""));
            // Canonical form round-trips.
            assert_eq!(AgentKind::from_lenient(key), Some(kind));
        }
    }

    #[test]
    fn lenient_parse_accepts_every_historical_spelling() {
        // SCREAMING_SNAKE (BaseCodingAgent serde/strum/sqlx), Pascal (variant names),
        // kebab (persisted ExecutorProfileId), and the old AgentType snake spellings
        // (open_code / open_claw) all resolve to the right variant.
        let cases = [
            ("CLAUDE_CODE", AgentKind::ClaudeCode),
            ("ClaudeCode", AgentKind::ClaudeCode),
            ("claude-code", AgentKind::ClaudeCode),
            ("claude_code", AgentKind::ClaudeCode),
            ("CODEX", AgentKind::Codex),
            ("OPENCODE", AgentKind::Opencode),
            ("open_code", AgentKind::Opencode), // old AgentType snake_case
            ("Opencode", AgentKind::Opencode),
            ("opencode", AgentKind::Opencode),
            ("OPENCLAW", AgentKind::Openclaw),
            ("open_claw", AgentKind::Openclaw), // old AgentType snake_case
            ("openclaw", AgentKind::Openclaw),
            ("GEMINI", AgentKind::Gemini),
            ("CLINE", AgentKind::Cline),
            ("HERMES", AgentKind::Hermes),
            ("QA_MOCK", AgentKind::QaMock),
            ("QaMock", AgentKind::QaMock),
            ("qa_mock", AgentKind::QaMock),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                AgentKind::from_lenient(raw),
                Some(expected),
                "from_lenient({raw:?})"
            );
            assert_eq!(
                serde_json::from_str::<AgentKind>(&format!("\"{raw}\"")).unwrap(),
                expected,
                "deserialize({raw:?})"
            );
            assert_eq!(raw.parse::<AgentKind>().unwrap(), expected, "FromStr({raw:?})");
        }
    }

    #[test]
    fn unknown_spelling_is_rejected() {
        assert_eq!(AgentKind::from_lenient("nope"), None);
        assert!(serde_json::from_str::<AgentKind>("\"nope\"").is_err());
        assert!("".parse::<AgentKind>().is_err());
    }

    #[test]
    fn deserialize_then_serialize_normalizes_to_canonical() {
        // An old SCREAMING value read back and re-serialized converges on snake_case
        // (the self-healing forward migration; ADR-0002).
        let kind: AgentKind = serde_json::from_str("\"OPENCODE\"").unwrap();
        assert_eq!(serde_json::to_string(&kind).unwrap(), "\"opencode\"");
    }
}
