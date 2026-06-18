//! Single bridge between the legacy executor key (`BaseCodingAgent`) and the
//! ACP-native agent registry (`AgentType`).
//!
//! Consolidates the thin wrapper that used to be copy-pasted across five command
//! modules (架构报告 A-5), so the error semantics live in exactly one place and can't
//! drift. The underlying total, panic-free, round-trip-tested mapping lives in
//! `crates/agents/src/registry.rs` (`agent_type_from_executor_key`).

use agents::{AgentType, agent_type_from_executor_key};
use executors::executors::BaseCodingAgent;

use crate::error::AppError;

/// Resolve a legacy executor to its ACP-native [`AgentType`], or a `BadRequest` when
/// the executor has no ACP registry entry (i.e. it is not available through the
/// agent runtime).
pub(crate) fn agent_type_from_executor(executor: BaseCodingAgent) -> Result<AgentType, AppError> {
    agent_type_from_executor_key(&executor.to_string()).ok_or_else(|| {
        AppError::BadRequest(format!(
            "{executor} is not available through the ACP-native agent runtime"
        ))
    })
}
