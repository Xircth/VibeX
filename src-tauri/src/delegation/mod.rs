//! Wires the in-process `delegation` broker to VibeX's `AgentRuntime` + DB.
//!
//! The broker and its trait boundaries live in `crates/delegation`; this module
//! provides the concrete implementations: lookups over the `Session` model,
//! a spawner that creates child sessions and drives the runtime, an event
//! emitter that surfaces delegation lifecycle on the parent's stream, and a
//! background resolver that turns child turn-completions into broker results.
//!
//! v1 wires the broker live (listener + resolver running). The ClaudeCode MCP
//! injection (so the agent auto-launches the companion) is a follow-up (T4.4).

mod emitter;
mod inject;
mod lookups;
mod resolver;
mod spawner;
mod wiring;

pub(crate) use wiring::{DelegationState, build_delegation};
