# Phase 1 Review: Database Foundation

## Scope Reviewed

- `crates/db/migrations/20260616000000_event_sourced_conversation_core.sql`
- `crates/db/src/models/conversation.rs`
- `crates/db/src/models/conversation_turn.rs`
- `crates/db/src/models/conversation_event.rs`
- `crates/db/src/models/conversation_tool.rs`
- `crates/db/src/models/conversation_side_effects.rs`
- `crates/db/src/models/conversation_bundle.rs`
- `crates/db/src/models/mod.rs`

## Result

Phase 1 is complete.

The database foundation now supports the event-sourced conversation core while
preserving `sessions.id` as the physical VibeX conversation id during cutover.
New durable tables cover:

- agent bindings;
- turns;
- append-only events with per-conversation sequence;
- tool calls;
- file changes;
- permissions;
- terminals;
- attachments;
- checkpoints;
- imports;
- exports.

## Verification Performed

```powershell
pnpm run prepare-db
cargo test -p db conversation_identity
cargo test -p db conversation_turn
cargo test -p db conversation_event
cargo test -p db conversation_state_tables
cargo test -p db conversation_import_export
pnpm run prepare-db:check
rg -n "transcript|parsers::loader|external_session_id" crates/db/src/models
```

All commands above passed except the `rg` command intentionally reports
`external_session_id` occurrences. Those fields remain as legacy binding/import
metadata until later cutover phases. No DB model imports parser code or describes
Agent transcript files as the canonical conversation-detail source.

## Notes

- `conversation_events` is authoritative for timeline reconstruction.
- `conversation_agent_bindings.acp_session_id` is the new ACP binding location.
- `sessions.external_session_id` remains only for compatibility with existing
  code until Phase 8 removal.
- The old Tauri conversation detail command has not yet been rewritten; that is
  scheduled for Phase 5/8.

## Next Phase

Proceed to Phase 2: shared domain types.
