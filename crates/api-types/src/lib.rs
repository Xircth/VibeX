//! Shared agent identity types (ADR-0002).

pub mod agent_id;
pub mod agent_kind;
pub mod agent_management;
pub mod pulse;

pub use agent_id::*;
pub use agent_kind::*;
pub use agent_management::*;
pub use pulse::*;
