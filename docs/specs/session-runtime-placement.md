# Session Runtime Placement Refactor Spec

## Requirements

**User Story:** As a user moving a Codex session between execution and monitor areas, I want the conversation to behave as the same session container, so that messages and live AI output never disappear or reload because only the display position changed.

### Acceptance Criteria

1. WHEN a session moves between execution area and monitor area THEN the system SHALL preserve its rendered user and AI messages without clearing or replaying through an empty state.
2. WHEN a running session moves between areas THEN the system SHALL continue receiving later AI output for that same session.
3. WHEN a session is shown in the monitor area THEN the system SHALL render the same conversation stream as the execution area, with the composer omitted.
4. WHEN a session is shown in the execution area THEN the system SHALL render the same conversation stream and include the composer.
5. WHEN a placement component unmounts THEN the system SHALL NOT treat that unmount as session runtime disposal.
6. WHEN an execution process stream is still initializing THEN the system SHALL NOT interpret an empty process list as process deletion.
7. IF a process is genuinely removed after the execution process stream has initialized THEN the system SHALL remove that process from the visible conversation.
8. WHEN normal placement switching occurs THEN the system SHALL NOT depend on rendered-conversation snapshot fallback to restore messages.

## Design

### Overview

The conversation runtime belongs to `workspaceId + sessionId`, not to the execution or monitor visual position. Execution and monitor views are consumers of that runtime. The runtime owns:

- normalized entries
- token usage
- execution process state reconciliation
- live conversation stream attachment

The visual placements own only:

- layout
- scroll position
- composer visibility

### Architecture

Current issue:

```text
Execution/Monitor component mount
  -> EntriesProvider local state
  -> ExecutionProcessesProvider subscription
  -> VirtualizedList useConversationHistory subscription
  -> unmount/remount clears or replays state
```

Target shape:

```text
SessionRuntime keyed by workspaceId:sessionId
  -> entries and token usage survive placement unmount
  -> stream initialization cannot clear existing runtime state

Execution view
  -> renders runtime entries
  -> shows composer

Monitor view
  -> renders runtime entries
  -> hides composer
```

### Components and Interfaces

1. `EntriesProvider`
   - Must become a runtime-key adapter rather than a local snapshot owner.
   - It reads and writes keyed runtime state.
   - It must not restore from rendered snapshot fallback during normal mount.

2. `useConversationHistory`
   - Must not rely on rendered snapshot fallback for placement switches.
   - It may keep in-memory process runtime state keyed by conversation key.
   - It must ignore temporary empty execution process lists while the process stream is loading or errored.

3. `KanbanSessionConversationView`
   - Continues to choose whether the composer is visible through `interactive`.
   - Must not use provider `key` props as a reload mechanism.

4. `DockviewLogsPanel`
   - Must consume the same keyed runtime as `KanbanSessionConversationView`.
   - Must not create an isolated entries lifecycle for the same session.

### Removed Fallbacks

The following logic is not part of the target design and should be removed from the placement switch path:

- rendered conversation snapshot fallback for normal component remounts
- ignoring empty replacement because a persisted snapshot exists
- saving rendered entries only to hydrate the next placement

Cold history loading from the backend remains valid because it is the source of truth for sessions not already in memory.

### Error Handling

- Empty execution process lists are only destructive after the execution process stream has initialized successfully.
- Stream errors preserve the latest runtime entries and do not clear visible messages.
- Deleted sessions still prune their runtime through the existing session deletion cleanup path.

### Testing Strategy

1. Unit test `EntriesProvider` to prove entries survive provider remount by runtime key without snapshot fallback.
2. Unit test `useConversationHistory` to prove a temporary empty process list during loading does not clear AI output.
3. Unit test genuine process removal after stream initialization still clears removed process entries.
4. Existing front-end typecheck and lint must pass.

## Tasks

- [x] 1. Convert `EntriesProvider` to keyed runtime state instead of local snapshot fallback.
  - Remove rendered snapshot hydration from `EntriesProvider`.
  - Store entries and token usage in a module-level runtime map keyed by conversation key.
  - _Requirements: 1, 3, 4, 5, 8_

- [x] 2. Remove rendered snapshot fallback from `useConversationHistory`.
  - Delete `useSessionConversationStore` hydration/save paths used for placement remounts.
  - Keep process runtime state in memory by conversation key.
  - _Requirements: 1, 2, 5, 8_

- [x] 3. Harden process removal semantics.
  - Do not remove displayed processes while execution process stream is loading or errored.
  - Preserve genuine removal behavior after initialization.
  - _Requirements: 6, 7_

- [x] 4. Remove provider key-based remounts from session conversation views where they only force reloads.
  - `EntriesProvider`, `ExecutionProcessesProvider`, and `KanbanSessionConversationContent` should use conversation identity as data, not as remount trigger.
  - _Requirements: 1, 2, 5_

- [x] 5. Update tests for runtime-key behavior and process stream reconnect behavior.
  - _Requirements: all_
