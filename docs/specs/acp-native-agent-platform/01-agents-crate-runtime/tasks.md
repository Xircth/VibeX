# Tasks: `crates/agents` ACP Runtime

- [x] Task: Create crate scaffold and workspace dependency.
  - Acceptance: `crates/agents` compiles with empty public API and is included in
    the workspace.
  - Verify: `cargo check -p agents`
  - Files: `Cargo.toml`, `crates/agents/Cargo.toml`, `crates/agents/src/lib.rs`.

- [x] Task: Implement runtime identifiers and state models.
  - Acceptance: Connection, session, prompt, permission, terminal, and event IDs
    are typed and serializable.
  - Verify: `cargo test -p agents state`
  - Files: `crates/agents/src/{ids,state,events}.rs`.

- [x] Task: Implement ACP connection manager with fake transport tests.
  - Acceptance: Initialize, new session, prompt, notification handling, and
    cleanup are tested without real agents.
  - Verify: `cargo test -p agents connection`
  - Files: `connection.rs`, `session.rs`, `events.rs`, tests.

- [x] Task: Implement cancellation and prompt queue ownership.
  - Acceptance: Concurrent prompts serialize; cancellation cannot leave a prompt
    stuck as running.
  - Verify: `cargo test -p agents queue cancel`
  - Files: `session.rs`, `connection.rs`.

- [x] Task: Implement host request bridges.
  - Acceptance: Permission, terminal, file read/write, and unsupported extension
    requests are routed through `AgentHost`.
  - Verify: `cargo test -p agents host_requests`
  - Files: `host.rs`, `permissions.rs`, `terminal.rs`, `filesystem.rs`.
