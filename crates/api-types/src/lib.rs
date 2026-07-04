//! API types shared between local and remote backends.
//!
//! This crate contains:
//! - Row types (e.g., `Issue`, `Project`) - the API representation of database entities
//! - Request types (e.g., `CreateIssueRequest`, `UpdateIssueRequest`) - API input types
//! - Shared enums (e.g., `IssuePriority`, `PullRequestStatus`)

use serde::{Deserialize, Deserializer};

// 批次D2 / ADR-0002: the issue-tracker / notification / pull-request / user /
// project-status modules were the "junk drawer" dead code in this leaf crate — zero
// references anywhere in the workspace. Removed alongside introducing `AgentKind`.
pub mod agent_kind;
pub mod agent_setting;
pub mod project;
pub mod tag;
pub mod workspace;

pub use agent_kind::*;
pub use agent_setting::*;
pub use project::*;
pub use tag::*;
pub use workspace::*;

pub fn some_if_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
