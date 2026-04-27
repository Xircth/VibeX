# Ralph Context Snapshot

## Task statement
Add Console and Network to the Dev Preview inspector, switch all app logo usage from the old raster logo to `frontend/src/assets/vibe_ultra_logo.svg`, add a Settings > System local-data clear action with confirmation toast, audit/fix Git rebase/Git manager/Git diff workspace-following behavior, and audit/fix notifications that bypass Toast or appear in the wrong place.

## Desired outcome
- Dev Preview inspector has in-panel Elements, Console, Network, Logs, and Page views.
- Old Image #1 logo usage is replaced with the SVG asset.
- Settings/System exposes a destructive local-data reset with themed confirmation toast; reset removes VibeUltra local app data without touching project files or worktrees.
- Git UI/actions follow the selected workspace consistently.
- Misplaced notification paths are converted to the app Toast surface where appropriate.

## Known facts/evidence
- Preview inspector was just added in `frontend/src/components/tasks/TaskDetails/preview/PreviewInspectorPane.tsx`.
- Native DevTools command was removed from `src-tauri/src/lib.rs` and `frontend/src/lib/api/misc.ts`.
- Existing dirty worktree includes many prior user-requested changes; do not revert unrelated work.
- Current repo uses React/Tauri/Rust/SQLx.

## Constraints
- Do not affect user project files or worktree directories when clearing local app data.
- Use `apply_patch` for manual file edits.
- No destructive git commands.
- Verify with frontend check/lint and targeted tests; Rust checks if backend commands change.

## Unknowns/open questions
- Where VibeUltra local app data is stored and which files are safe to clear.
- Whether preview proxy already injects scripts suitable for console/network capture.
- Which settings component owns Settings > System.
- Whether current Git workspace-following bugs remain after prior fixes.
- Which notification implementations still bypass Toast.

## Likely codebase touchpoints
- `frontend/src/components/tasks/TaskDetails/preview/*`
- `frontend/src/components/panels/PreviewPanel.tsx`
- `src-tauri/src/preview_proxy.rs`
- `frontend/src/utils/previewBridge.ts`
- `frontend/src/assets/*` and app shell/logo references
- `frontend/src/components/settings/*`, `frontend/src/lib/api/*`, `src-tauri/src/commands/*`
- `frontend/src/components/panels/git/*`, git hooks/API, workspace branch utilities
- Toast/notification components and direct alert/dialog usage
