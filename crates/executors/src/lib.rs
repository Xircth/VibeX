//! Frozen legacy executor crate (`docs/specs/agent-driver-engine.md` §2.2.3).
//!
//! This crate is strictly frozen for passive legacy profile/configuration
//! deserialization and [`actions::script::ScriptRequest`] execution only.
//! Do NOT add new coding-agent types, process spawners, or protocol adapters here;
//! all live coding-agent execution routes exclusively through `agents::AgentRuntime`
//! (enforced by architecture invariant gate `I5`).

pub mod actions;
pub mod approvals;
pub mod command;
pub mod env;
pub mod executors;
pub mod logs;
pub mod model_selector;
pub mod profile;
