# Phase 3 Review: Conversation Event Appender and Projector

## Scope Reviewed

- `crates/db/src/models/conversation_event.rs`
- `crates/db/src/models/conversation_projection.rs`
- `crates/db/src/models/conversation_turn.rs`
- `crates/db/src/models/conversation_tool.rs`
- `crates/db/src/models/conversation_side_effects.rs`
- `crates/db/fixtures/conversation-projection/*.json`

## Result

Phase 3 is complete.

The database layer now has:

- an event appender with per-conversation sequence allocation and idempotency
  dedupe;
- an event-driven state applier for turn status, tool calls, permissions,
  terminals, and file changes;
- a Rust projector that folds persisted events into `ConversationTimeline`;
- projection fixtures for happy path, no-output failure, permission-blocked,
  tool-heavy, terminal, and file-change cases.

## Verification Performed

```powershell
cargo test -p db conversation_event_appender
cargo test -p db conversation_turn_state
cargo test -p db conversation_tool_projection
cargo test -p db conversation_side_effect_projection
cargo test -p db conversation_timeline_projection
cargo test -p db conversation_projection_fixtures
rg -n "transcript|agent session file|external_session" crates/db/fixtures/conversation-projection
```

All tests passed. The fixture directory contains no transcript/session-file
inputs; timelines are projected from event fixtures only.

## Notes

- The current projector is intentionally conservative. It produces canonical
  message, permission, terminal, file-change, error, and session notice rows.
- More refined UI grouping can be added later without changing the event log.
- Tool updates are upserted by `tool_call_id`, preserving raw input/output and
  locations.

## Next Phase

Proceed to Phase 4: ACP runtime integration.
