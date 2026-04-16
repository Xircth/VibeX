# Task Statement
Implement fixes for three active frontend issues after recent rollback/partial fixes:
1. Complete drag file/folder into composer input to insert file reference.
2. Restore and fix `/`, `$`, `#`, `@` command/typeahead behavior.
3. Fix abnormal queued-status display in the follow-up UI.

# Desired Outcome
- Dragging a file/folder from the file tree into the composer inserts a file reference chip reliably.
- `/`, `$`, `#`, `@` each show exactly one correct menu and replace trigger text correctly.
- Queue status shows the correct state without erroneous or stale UI.

# Known Facts / Evidence
- User confirmed root cause for drag was unstable native HTML5 DnD under Dockview/WebView.
- User partially repaired drag and says file tree itself should not be refactored further.
- User explicitly says prior command-system fixes were rolled back and need restoration.
- Current workspace has local modifications in frontend and backend related to file tree, queued messages, and command system.

# Constraints
- Only complete drag-to-input capability; do not continue refactoring the file tree.
- Preserve current frontend appearance as much as practical.
- No new dependencies.
- Verify with frontend check/lint/tests after changes.

# Unknowns / Open Questions
- Exact current queue UI bug surface and whether backend queue status shape also changed.
- Whether current drag helper file `frontend/src/utils/fileReferenceDrag.ts` is complete or partial.
- Which parts of prior command-system fix remain in working tree versus were reverted.

# Likely Codebase Touchpoints
- frontend/src/components/ui/wysiwyg.tsx
- frontend/src/components/ui/wysiwyg/plugins/**
- frontend/src/lib/searchTagsAndFiles.ts
- frontend/src/components/tasks/TaskFollowUpSection.tsx
- frontend/src/lib/api/config.ts / queue status consumers
- frontend/src/components/file-tree/FileTreePanel.tsx
- frontend/src/utils/fileReferenceDrag.ts
- crates/services/src/services/queued_message.rs / src-tauri queue commands if frontend bug traces there
