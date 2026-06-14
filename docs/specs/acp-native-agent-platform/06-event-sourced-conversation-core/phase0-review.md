# Phase 0 Review: Cutover Preparation

## Scope Reviewed

- `requirements.md`
- `design.md`
- `tasks.md`
- `codeg-comparison-adoption.md`
- `deletion-map.md`
- `projection-fixtures.md`
- `docs/specs/acp-native-agent-platform/README.md`

## Result

Phase 0 is complete.

The spec now makes the breaking architecture explicit:

- VibeX-owned conversation events are canonical.
- Agent transcript files are import-only inputs.
- Codeg is a runtime hardening reference, not the completed-history model.
- Old transcript detail loading, frontend transcript/live merging, legacy event
  folding, and provider runtime conversation adapters have explicit deletion or
  isolation targets.
- Projection fixtures have a documented schema and required coverage for
  message, reasoning, plan, tool, permission, terminal, usage, file-change,
  question, feedback, delegation, recovery, and error cases.

## Breaking Assumptions

- The implementation may delete and replace old live conversation paths.
- Compatibility adapters back to transcript-backed conversation detail are out
  of scope.
- Existing historical data, if preserved, must be imported explicitly into
  event-sourced conversations.

## Verification

```powershell
rg -n "06-event-sourced|transcript.*import-only|canonical conversation" docs/specs/acp-native-agent-platform
rg -n "parsers::loader|ConversationRuntimeContext|buildLiveMessageFromEvents|ExecutionProcess" docs/specs/acp-native-agent-platform/06-event-sourced-conversation-core
```

## Next Phase

Proceed to Phase 1: database foundation.
