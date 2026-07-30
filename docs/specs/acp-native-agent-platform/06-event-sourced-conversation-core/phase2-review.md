# Phase 2 Review: Shared Domain Types

## Scope Reviewed

- `crates/agents/src/conversation.rs`
- `crates/agents/src/lib.rs`
- `src-tauri/src/bin/generate_types.rs`
- `shared/types.ts`

## Result

Phase 2 is complete.

The shared DTO layer now includes:

- `ConversationEvent` and `ConversationEventEnvelope`;
- Hardened event coverage for question, feedback, delegation,
  config-stale, prompt capability, fork support, session load failure, and
  visible errors;
- `AcpCapabilitySnapshot` and `AgentPromptCapabilities`;
- timeline row DTOs;
- events/timeline paging DTOs;
- portable bundle manifest and payload DTOs.

Existing transcript-shaped DTOs remain exported during cutover so current
frontend code keeps compiling. Product conversation rendering must migrate to
the new event/timeline DTOs in later phases.

## Verification Performed

```powershell
pnpm run generate-types
pnpm run generate-types:check
cargo test -p agents capability_snapshot
cargo test -p agents conversation_event_round_trips_coverage_cases
rg -n "QuestionRequested|FeedbackRequested|DelegationStarted|SessionConfigStale|PromptCapabilitiesUpdated|ForkSupportUpdated|AgentBindingLoadFailed" crates/agents src-tauri shared/types.ts
rg -n "ConversationEvent|ConversationTimeline|ConversationBundle" shared/types.ts frontend/src
```

All checks passed.

## Notes

- The new conversation connection status type is named
  `ConversationAgentConnectionStatus` to avoid colliding with the existing
  runtime `AgentConnectionStatus`.
- `ConversationEvent` accepts optional future `message_id` fields on text and
  reasoning deltas.
- Tool updates preserve raw input, raw output, appended raw output, locations,
  metadata, images, and status.

## Next Phase

Proceed to Phase 3: event appender and projector.
