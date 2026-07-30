use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use ts_rs::TS;

const MAX_AGENT_ID_LEN: usize = 128;

/// Open, stable identity for a product Agent.
///
/// Registry identifiers can seed an Agent id, but display names and Registry
/// bindings remain separate metadata. Live product APIs must accept this value
/// object instead of a closed enum of known Agents.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, TS, sqlx::Type)]
#[ts(export)]
#[sqlx(transparent)]
pub struct AgentId(String);

impl AgentId {
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, ParseAgentIdError> {
        let raw = raw.as_ref();
        let bytes = raw.as_bytes();

        if bytes.is_empty() {
            return Err(ParseAgentIdError::Empty);
        }
        if bytes.len() > MAX_AGENT_ID_LEN {
            return Err(ParseAgentIdError::TooLong {
                max: MAX_AGENT_ID_LEN,
            });
        }
        if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
            return Err(ParseAgentIdError::InvalidBoundary);
        }
        if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit()
        {
            return Err(ParseAgentIdError::InvalidBoundary);
        }
        if let Some(invalid) = bytes.iter().copied().find(|byte| {
            !byte.is_ascii_lowercase()
                && !byte.is_ascii_digit()
                && !matches!(byte, b'_' | b'-' | b'.')
        }) {
            return Err(ParseAgentIdError::InvalidCharacter(invalid as char));
        }

        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for AgentId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl fmt::Display for AgentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AgentId {
    type Err = ParseAgentIdError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw)
    }
}

impl TryFrom<String> for AgentId {
    type Error = ParseAgentIdError;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Self::parse(raw)
    }
}

impl Serialize for AgentId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AgentId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(D::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseAgentIdError {
    Empty,
    TooLong { max: usize },
    InvalidBoundary,
    InvalidCharacter(char),
}

impl fmt::Display for ParseAgentIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("Agent id must not be empty"),
            Self::TooLong { max } => {
                write!(formatter, "Agent id must not exceed {max} bytes")
            }
            Self::InvalidBoundary => formatter
                .write_str("Agent id must start and end with a lowercase ASCII letter or digit"),
            Self::InvalidCharacter(character) => write!(
                formatter,
                "Agent id contains invalid character {character:?}; only lowercase ASCII letters, digits, '_', '-' and '.' are allowed"
            ),
        }
    }
}

impl std::error::Error for ParseAgentIdError {}
