//! Capability descriptors and grayscale runtime routing for flagship native engines.
//!
//! Claude Code and Codex connect through dedicated native drivers (`ClaudeNative`,
//! `CodexNative`) when `EngineRuntimePreference::NativeFirst` is active, while all
//! 18+ long-tail agents remain on ACP without regression. `DIMO_ENGINE_MODE`
//! (`acp` vs `native`) provides an environment-level grayscale override.

use api_types::AgentKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Flagship native engine backends supported directly by `AgentConnectionManager`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum NativeEngineKind {
    /// Node sidecar (`scripts/claude-native-driver.mjs`) -> `@anthropic-ai/claude-agent-sdk`.
    ClaudeNative,
    /// Rust JSON-RPC 2.0 client -> `codex app-server`.
    CodexNative,
}

impl NativeEngineKind {
    pub const fn engine_id(self) -> &'static str {
        match self {
            Self::ClaudeNative => "claude-native",
            Self::CodexNative => "codex-native",
        }
    }

    pub const fn agent_kind(self) -> AgentKind {
        match self {
            Self::ClaudeNative => AgentKind::ClaudeCode,
            Self::CodexNative => AgentKind::Codex,
        }
    }

    pub fn descriptor(self) -> NativeEngineDescriptor {
        NativeEngineDescriptor::for_kind(self)
    }
}

/// Runtime selection policy when launching an agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum EngineRuntimePreference {
    /// Prefer flagship native engine drivers when available, falling back to ACP for
    /// all other agents.
    #[default]
    NativeFirst,
    /// Force the ACP adapter path even for Claude Code and Codex.
    AcpOnly,
}

/// Static control-plane capabilities exposed by a flagship native engine driver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct NativeEngineDescriptor {
    pub kind: NativeEngineKind,
    pub engine_id: String,
    pub agent_kind: AgentKind,
    pub supports_native_steer: bool,
    pub supports_native_revert: bool,
    pub supports_native_fork: bool,
    pub supports_rate_limit_push: bool,
    pub supports_prompt_cache_ttl: bool,
}

impl NativeEngineDescriptor {
    pub fn for_kind(kind: NativeEngineKind) -> Self {
        match kind {
            NativeEngineKind::ClaudeNative => Self {
                kind,
                engine_id: kind.engine_id().to_string(),
                agent_kind: AgentKind::ClaudeCode,
                supports_native_steer: true,
                supports_native_revert: true,
                supports_native_fork: true,
                supports_rate_limit_push: true,
                supports_prompt_cache_ttl: true,
            },
            NativeEngineKind::CodexNative => Self {
                kind,
                engine_id: kind.engine_id().to_string(),
                agent_kind: AgentKind::Codex,
                supports_native_steer: true,
                supports_native_revert: true,
                supports_native_fork: true,
                supports_rate_limit_push: true,
                supports_prompt_cache_ttl: false,
            },
        }
    }
}

/// Resolves whether `agent_kind_or_id` should run on a native engine driver,
/// honoring `DIMO_ENGINE_MODE=acp|native` grayscale overrides.
pub fn resolve_native_engine_kind(
    agent_kind_or_id: &str,
    preference: EngineRuntimePreference,
) -> Option<NativeEngineKind> {
    let env_mode = std::env::var("DIMO_ENGINE_MODE").ok();
    resolve_native_engine_kind_with_env(agent_kind_or_id, preference, env_mode.as_deref())
}

/// Resolves the effective runtime preference after applying `DIMO_ENGINE_MODE`.
pub(crate) fn effective_runtime_preference(
    preference: EngineRuntimePreference,
    env_mode: Option<&str>,
) -> EngineRuntimePreference {
    match env_mode
        .map(|raw| raw.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("acp" | "acp_only" | "acp-only" | "0" | "false" | "off") => {
            EngineRuntimePreference::AcpOnly
        }
        Some("native" | "native_first" | "native-first" | "1" | "true" | "on") => {
            EngineRuntimePreference::NativeFirst
        }
        _ => preference,
    }
}

/// Pure resolution helper accepting an explicit `DIMO_ENGINE_MODE` value so unit
/// tests can verify grayscale routing deterministically without mutating process env.
pub fn resolve_native_engine_kind_with_env(
    agent_kind_or_id: &str,
    preference: EngineRuntimePreference,
    env_mode: Option<&str>,
) -> Option<NativeEngineKind> {
    if effective_runtime_preference(preference, env_mode) == EngineRuntimePreference::AcpOnly {
        return None;
    }

    let normalized = normalize_agent_token(agent_kind_or_id);
    match normalized.as_str() {
        "claude_code" | "claudecode" | "claude" | "claude_native" => {
            Some(NativeEngineKind::ClaudeNative)
        }
        "codex" | "codex_native" | "openai_codex" | "codex_cli" => {
            Some(NativeEngineKind::CodexNative)
        }
        _ => None,
    }
}

pub(crate) fn normalize_agent_token(raw: &str) -> String {
    let trimmed = raw.trim();
    let unprefixed = trimmed
        .strip_prefix("builtin:")
        .or_else(|| trimmed.strip_prefix("profile:"))
        .unwrap_or(trimmed);
    unprefixed
        .chars()
        .map(|ch| {
            if ch == '-' || ch == ' ' {
                '_'
            } else {
                ch.to_ascii_lowercase()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_claude_and_codex_to_native_first_and_keeps_long_tail_on_acp() {
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "claude_code",
                EngineRuntimePreference::NativeFirst,
                None
            ),
            Some(NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "builtin:claude-code",
                EngineRuntimePreference::NativeFirst,
                None
            ),
            Some(NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "CODEX",
                EngineRuntimePreference::NativeFirst,
                None
            ),
            Some(NativeEngineKind::CodexNative)
        );

        for acp_agent in [
            "opencode",
            "antigravity",
            "cursor",
            "grok",
            "pi",
            "kimi_code",
        ] {
            assert_eq!(
                resolve_native_engine_kind_with_env(
                    acp_agent,
                    EngineRuntimePreference::NativeFirst,
                    None
                ),
                None,
                "expected {acp_agent} to remain on ACP"
            );
        }
    }

    #[test]
    fn honors_acp_only_preference_and_dimo_engine_mode_grayscale_override() {
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "claude_code",
                EngineRuntimePreference::AcpOnly,
                None
            ),
            None
        );
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "codex",
                EngineRuntimePreference::NativeFirst,
                Some("acp")
            ),
            None
        );
        assert_eq!(
            resolve_native_engine_kind_with_env(
                "claude_code",
                EngineRuntimePreference::AcpOnly,
                Some("native")
            ),
            Some(NativeEngineKind::ClaudeNative)
        );
    }

    #[test]
    fn descriptors_advertise_accurate_control_plane_capabilities() {
        let claude = NativeEngineKind::ClaudeNative.descriptor();
        assert_eq!(claude.engine_id, "claude-native");
        assert_eq!(claude.agent_kind, AgentKind::ClaudeCode);
        assert!(claude.supports_native_steer);
        assert!(claude.supports_native_revert);
        assert!(claude.supports_native_fork);
        assert!(claude.supports_rate_limit_push);
        assert!(claude.supports_prompt_cache_ttl);

        let codex = NativeEngineKind::CodexNative.descriptor();
        assert_eq!(codex.engine_id, "codex-native");
        assert_eq!(codex.agent_kind, AgentKind::Codex);
        assert!(codex.supports_native_steer);
        assert!(codex.supports_native_revert);
        assert!(codex.supports_native_fork);
        assert!(codex.supports_rate_limit_push);
        assert!(!codex.supports_prompt_cache_ttl);
    }
}
