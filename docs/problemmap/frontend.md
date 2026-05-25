# ProblemMap: Frontend

Scope: `frontend/src/**`, excluding generated assets and dependencies.

## Problems

### FE-001: Dockview group policy is duplicated across layout and action context

- Category: duplication, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `frontend/src/components/layout/IDELayout.tsx`, `frontend/src/contexts/PanelActionsContext.tsx`
- Evidence: both files define overlapping group classification and editor-group helper logic, including `LEFT_PANEL_IDS`, `isLeftGroup`, `isBottomGroup`, `isEditorGroup`, `compareEditorGroups`, and `getNextEditorGroupId`.
- Risk: Dockview recovery, terminal group recreation, and editor group preservation can drift between the layout owner and the action API.
- Suggested behavior lock: unit tests for group classification and editor ordering, plus one integration test for terminal-group recreation and editor preservation after layout restore/remove flows.
- Cleanup status: fixed in this pass.
- Fix: extracted `frontend/src/utils/dockviewGroupPolicy.ts` and made `IDELayout.tsx` plus `PanelActionsContext.tsx` consume the same panel/group policy helpers.
- Behavior lock: added `frontend/src/utils/dockviewGroupPolicy.test.ts` for left/bottom/editor classification, placeholder split exclusion, editor group ordering, and next editor group id selection.
- Verification: `pnpm vitest run src/utils/dockviewGroupPolicy.test.ts`; `pnpm run check`; `pnpm run frontend:lint`.

### FE-002: Task follow-up composer is a god component and state machine

- Category: complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- Evidence: the component combines workspace/session resolution, attempt stop state, git summary, scratch persistence, queueing/cancel, image upload, prompt enhancement, hotkey scopes, context compacting, and send flow in one large component.
- Risk: user-send behavior, cancellation, scratch persistence, and context handling are hard to change independently.
- Suggested behavior lock: tests around send/cancel transitions, scratch persistence, and prompt/image inputs before splitting responsibilities.

### FE-003: Conversation history hook hides shared runtime state at module scope

- Category: weak boundary, complex implementation, missing tests
- Severity: high
- Confidence: high
- Files: `frontend/src/hooks/useConversationHistory/useConversationHistory.ts`, `frontend/src/hooks/useConversationHistory/useConversationHistory.test.ts`
- Evidence: `conversationRuntimeByKey` and `conversationStreamSubscriptionCounter` are module-global state, while the hook also owns historic load, live stream retry, flattening, stopped-process reload, and process removal.
- Risk: cross-instance leakage and race conditions are difficult to reason about.
- Suggested behavior lock: multi-instance tests for shared runtime keys, subscription cleanup, stopped-process reload, and stream retry behavior.

### FE-004: Kanban session hub prop-drills orchestration state into sidebar

- Category: complex implementation, weak boundary, over-abstraction
- Severity: high
- Confidence: high
- Files: `frontend/src/components/kanban/KanbanSessionHub.tsx`, `frontend/src/components/kanban/session-hub/SessionHubSidebar.tsx`
- Evidence: the hub owns creation, optimistic status updates, archive/delete flows, filters, resize, and navigation, then passes a wide prop bag into the sidebar.
- Risk: sidebar UI tests do not protect hub orchestration behavior, and future state changes will spread across both components.
- Suggested behavior lock: orchestration tests for create/archive/delete/filter flows before moving state behind a smaller interface.

### FE-005: File tree mixes derivation, IO, drag/drop, preview, and portal rendering

- Category: complex implementation, weak boundary, missing tests
- Severity: high
- Confidence: high
- Files: `frontend/src/components/file-tree/FileTreePanel.tsx`, `frontend/src/components/file-tree/FileTreePanel.truncated.test.tsx`
- Evidence: the file tree component owns lazy directory IO, path normalization, inline create/delete/copy, custom drag/drop, preview fetching, preview selection, and portal rendering. Existing direct coverage is narrow.
- Risk: file-tree to file-tree moves and file-tree to editor/composer drops can regress independently of render-only tests.
- Suggested behavior lock: desktop-runtime drag/drop cases plus unit coverage for path derivation and lazy-load behavior.

### FE-006: App root carries transition-state historical baggage

- Category: historical baggage, weak boundary
- Severity: medium-high
- Confidence: medium-high
- Files: `frontend/src/App.tsx`
- Evidence: app shell code mixes onboarding/maintenance side effects, global `legacy-design` body state, multiple shell entrypoints, and redirects disabled new UI routes back to legacy screens.
- Risk: routing, onboarding gates, and legacy/new design boundaries remain coupled.
- Suggested behavior lock: `MemoryRouter` tests for `/desktop-toast`, `/project-rail`, `/settings/*`, legacy redirects, and disclaimer/onboarding short-circuit behavior.

### FE-007: WYSIWYG wrapper aggregates plugin policy and app context

- Category: over-abstraction, complex implementation, missing tests
- Severity: medium-high
- Confidence: high
- Files: `frontend/src/components/ui/wysiwyg.tsx`
- Evidence: one wrapper owns Lexical theme config, transformer selection, drag-and-drop intake, task/session context wiring, typeahead plugins, keyboard commands, and read-only actions.
- Risk: plugin-level tests do not prove wrapper behavior or app-context integration.
- Suggested behavior lock: wrapper tests for read-only mode, typeahead enablement, drag/drop intake, and task/session context interactions.

## Safest Cleanup Candidates

1. FE-001 Dockview helper dedupe. It has a clear duplicate surface and can be protected with pure unit tests before changing imports.
2. FE-006 App shell split. It is larger, but routing/effect behavior can be locked through focused router tests before extraction.

## Uncertainties

- FE-005 needs desktop-app verification for drag/drop changes. Browser-only tests are insufficient for this repo's Dockview/Tauri/WebView environment.
