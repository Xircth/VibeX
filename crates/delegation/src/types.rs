//! Broker-facing request / outcome types.
//!
//! Session ids are `uuid::Uuid` to match VibeX's `sessions.id` column. The
//! wire-stable `code` / `status` strings ship to LLM context and the frontend —
//! do not rename them.

use agents::AgentId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Everything the broker needs to dispatch a single delegation call.
///
/// `parent_connection_id` is the VibeX-internal ACP connection id of the parent
/// session (used to inherit working dir / scope parent-cancel). `requested_working_dir`
/// is the value exactly as the LLM passed it — `None` when omitted — and is part
/// of the `(agent_type, task, requested_working_dir)` correlation key so two
/// parallel calls sharing agent+task but targeting different explicit dirs don't
/// bind to each other's tool_call_id. `working_dir` is the defaulted value the
/// child is actually spawned in.
#[derive(Debug, Clone)]
pub struct DelegationRequest {
    pub parent_connection_id: String,
    pub parent_session_id: Uuid,
    pub parent_tool_use_id: String,
    pub agent_type: AgentId,
    pub task: String,
    pub working_dir: Option<String>,
    pub requested_working_dir: Option<String>,
    pub external_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationSuccess {
    pub text: String,
    pub child_session_id: Uuid,
    pub child_agent_type: AgentId,
    pub turn_count: u32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,
}

/// Broker-internal failure modes. Each maps to a stable `code` string via
/// [`DelegationOutcome::from_err`] so the frontend / MCP consumer can
/// pattern-match without caring about the inner shape.
#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum DelegationError {
    #[error("depth limit exceeded ({current_depth} >= {limit})")]
    DepthLimitExceeded { current_depth: u32, limit: u32 },
    #[error("invalid agent type")]
    InvalidAgentType,
    #[error("invalid working dir: {0}")]
    InvalidWorkingDir(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("subagent runtime error: {0}")]
    SubagentRuntimeError(String),
    /// Child ended its turn via `refusal` (often a backend error per the ACP gap).
    #[error("subagent refused to continue")]
    ChildRefusal,
    #[error("subagent reached max token budget")]
    ChildMaxTokens,
    #[error("subagent reached max turn request budget")]
    ChildMaxTurnRequests,
    /// Child ended `end_turn` without producing any output.
    #[error("subagent produced no output")]
    ChildEmpty,
    #[error("subagent ended with unrecognized stop reason: {0}")]
    ChildUnknown(String),
    #[error("canceled: {reason}")]
    Canceled { reason: String },
    #[error("parent session is gone")]
    ParentSessionGone,
}

/// The single value the broker hands back to the listener. `child_session_id`
/// on the `Err` arm is best-effort — `Some` once the child DB row exists, even
/// if the run later fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DelegationOutcome {
    Ok(DelegationSuccess),
    Err {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        child_session_id: Option<Uuid>,
    },
}

impl DelegationOutcome {
    /// Project a [`DelegationError`] onto its wire-stable `code`. Keep these
    /// strings stable — they ship to LLM context and the frontend.
    pub fn from_err(err: DelegationError, child_session_id: Option<Uuid>) -> Self {
        let code = match &err {
            DelegationError::DepthLimitExceeded { .. } => "depth_limit",
            DelegationError::InvalidAgentType => "invalid_agent_type",
            DelegationError::InvalidWorkingDir(_) => "invalid_working_dir",
            DelegationError::SpawnFailed(_) => "spawn_failed",
            DelegationError::SubagentRuntimeError(_) => "subagent_error",
            DelegationError::ChildRefusal => "child_refusal",
            DelegationError::ChildMaxTokens => "child_max_tokens",
            DelegationError::ChildMaxTurnRequests => "child_max_turn_requests",
            DelegationError::ChildEmpty => "child_empty",
            DelegationError::ChildUnknown(_) => "child_unknown",
            DelegationError::Canceled { .. } => "canceled",
            DelegationError::ParentSessionGone => "canceled",
        };
        DelegationOutcome::Err {
            code: code.to_string(),
            message: err.to_string(),
            child_session_id,
        }
    }
}

/// Lifecycle status of an async delegation task. Wire-stable snake_case — ships
/// to LLM context and the frontend, so don't rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Child is running in the background; no terminal result yet.
    Running,
    /// Child ended its turn cleanly; `text` carries the (possibly capped) result.
    Completed,
    /// Child ended in a non-cancel failure; `error_code` / `message` describe it.
    Failed,
    /// Task was canceled.
    Canceled,
    /// Task id is unknown to this parent (never existed, wrong parent, or evicted
    /// with no DB row).
    Unknown,
}

/// Unified report the broker returns for every delegation tool. All fields are
/// optional except `status` so one type describes a running ack, a completed
/// result, a failure, and a setup failure (`task_id: None`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationTaskReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentId>,
    /// Completed result text (capped; open the child session for the full output).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Wire-stable error code for `Failed` / `Canceled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// Deterministic key binding an ACP-side tool_call to its MCP-side delegate call
/// so parallel fan-outs don't cross-bind. Uses `requested_working_dir` (the
/// LLM's explicit value), not the defaulted one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DelegationMatchKey {
    pub agent_type: AgentId,
    pub task: String,
    pub working_dir: Option<String>,
}

/// Linkage persisted onto the child session row (`sessions.parent_session_id`
/// etc.) so the lifecycle resolver can route the child's terminal turn back to
/// the broker. `agent_type` is carried so the spawner can register it for the
/// resolver (which needs it to build the child's terminal outcome) without an
/// extra DB round-trip.
#[derive(Debug, Clone)]
pub struct DelegationLink {
    pub parent_session_id: Uuid,
    pub parent_tool_use_id: String,
    pub delegation_call_id: String,
    pub agent_type: AgentId,
}

/// Runtime-tunable delegation knobs.
#[derive(Debug, Clone)]
pub struct DelegationConfig {
    /// Master feature gate.
    pub enabled: bool,
    /// Max delegation chain depth (root → child = depth 1). Default 1.
    pub depth_limit: u32,
    /// Per-parent result-cache byte budget; `0` disables eviction.
    pub completed_cache_cap_bytes: usize,
}

impl Default for DelegationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            depth_limit: 1,
            completed_cache_cap_bytes: 512 * 1024 * 1024,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_err_maps_stable_codes() {
        let cases = [
            (
                DelegationError::DepthLimitExceeded {
                    current_depth: 2,
                    limit: 1,
                },
                "depth_limit",
            ),
            (DelegationError::InvalidAgentType, "invalid_agent_type"),
            (DelegationError::ChildRefusal, "child_refusal"),
            (DelegationError::ChildMaxTokens, "child_max_tokens"),
            (DelegationError::ChildEmpty, "child_empty"),
            (
                DelegationError::Canceled {
                    reason: "x".to_string(),
                },
                "canceled",
            ),
            (DelegationError::ParentSessionGone, "canceled"),
        ];
        for (err, expected) in cases {
            match DelegationOutcome::from_err(err, None) {
                DelegationOutcome::Err { code, .. } => assert_eq!(code, expected),
                DelegationOutcome::Ok(_) => panic!("expected Err"),
            }
        }
    }

    #[test]
    fn task_report_serializes_status_snake_case() {
        let report = DelegationTaskReport {
            task_id: Some("call-1".to_string()),
            status: TaskStatus::Running,
            child_session_id: None,
            agent_type: Some(AgentId::parse("claude_code").unwrap()),
            text: None,
            error_code: None,
            message: Some("running in background".to_string()),
            duration_ms: None,
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["status"], "running");
        assert_eq!(value["agent_type"], "claude_code");
        // Absent optionals are skipped, not null.
        assert!(value.get("text").is_none());
    }
}
