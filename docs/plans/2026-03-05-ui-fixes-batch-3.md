# UI Fixes Batch 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 9 bugs across terminal, tool call collapsing, TodoList button, sidebar panels, panel toggles, git history, markdown tables, rebase feedback, and dev server preview.

**Architecture:** Pure frontend fixes except Task 6 (needs new Tauri command for commit history). All tasks are independent and can be committed separately.

**Tech Stack:** React 18, TypeScript, Zustand, xterm.js, Dockview, Tauri IPC, Lexical WYSIWYG

---

### Task 1: Fix terminal black screen / no content after creating workspace

**Problem:** After creating/selecting a task card, the terminal panel shows pure black with no content. The `getTerminalTheme()` function reads CSS variables from `.new-design` element, but when it's not in the DOM yet (or variables are scoped differently), `hslToHex("")` returns `#000000` for both background AND foreground, making text invisible on a black background. Also, the PTY `create_terminal` backend call requires a valid `workspace_id` with an existing `container_ref` directory, which may fail silently.

**Root cause (two issues):**

1. **Theme fallback produces black-on-black:** In `terminalTheme.ts:52-63`, `getCssVariable('--bg-secondary')` may return empty string if `.new-design` element doesn't exist or CSS variables aren't computed yet. `hslToHex("")` returns `#000000`, so both background and foreground become black.

2. **PTY creation may fail silently:** In `useTauriTerminal.ts:163-168`, if `create_terminal` throws (e.g., workspace directory doesn't exist), the error is written to the terminal in red text — but since foreground is also `#000000`, the error message is invisible.

**Fix approach:**

1. In `terminalTheme.ts`, add hardcoded fallback colors when CSS variables return empty:
   - For `--bg-secondary`: fallback to light mode `"0 0% 95%"` or dark mode `"0 0% 11%"`
   - For `--text-high`: fallback to light mode `"0 0% 5%"` or dark mode `"0 0% 96%"`

2. In `useTauriTerminal.ts`, add a `fitAddon.fit()` call after the terminal becomes visible (active tab), not just on initial mount where container might have zero dimensions.

**Files:**
- Modify: `frontend/src/utils/terminalTheme.ts:70-83`
- Modify: `frontend/src/components/panels/DockviewTerminalPanel.tsx:140-165`

**Step 1: Add CSS variable fallbacks in getTerminalTheme()**

In `terminalTheme.ts`, modify lines 70-83:

```typescript
export function getTerminalTheme(): ITheme {
  const isDark = document.documentElement.classList.contains('dark');

  // Read CSS variables with safe fallbacks
  const background = getCssVariable('--bg-secondary') || (isDark ? '0 0% 11%' : '0 0% 95%');
  const foreground = getCssVariable('--text-high') || (isDark ? '0 0% 96%' : '0 0% 5%');
  const success = getCssVariable('--console-success') || '117 38% 50%';
  const error = getCssVariable('--console-error') || (isDark ? '0 84% 60%' : '0 59% 57%');

  // ... rest unchanged
```

**Step 2: Re-fit terminal when tab becomes active**

In `DockviewTerminalPanel.tsx`, add a `useEffect` in `TerminalTabContent` to re-fit when `isActive` changes to true. The `useTauriTerminal` hook already has a ResizeObserver, but it doesn't trigger when CSS `visibility` changes.

The simplest fix: pass `isActive` to `useTauriTerminal` and trigger `fitAddon.fit()` when it becomes true. Or, in `TerminalTabContent`, add:

```tsx
function TerminalTabContent({ workspaceId, tabId, isActive, shell }: Props) {
  const { containerRef, refit } = useTauriTerminal({
    workspaceId,
    enabled: true,
    shell,
  });

  // Re-fit terminal when tab becomes visible (CSS visibility changes don't trigger ResizeObserver)
  useEffect(() => {
    if (isActive) {
      // Small delay to allow CSS visibility to apply before measuring
      const timer = setTimeout(() => refit?.(), 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, refit]);

  return (
    <div className={`absolute inset-0 ${isActive ? 'visible' : 'invisible'}`} data-terminal-tab={tabId}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
```

Add a `refit` function export from `useTauriTerminal`:

```typescript
// In useTauriTerminal, add to the return:
const refit = useCallback(() => {
  if (fitAddonRef.current && terminalOpenedRef.current) {
    try { fitAddonRef.current.fit(); } catch { /* container may have zero size */ }
  }
}, []);

return { containerRef, cleanup, refit };
```

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/utils/terminalTheme.ts frontend/src/hooks/useTauriTerminal.ts frontend/src/components/panels/DockviewTerminalPanel.tsx
git commit -m "fix: terminal black screen — add theme fallbacks and re-fit on tab activate"
```

---

### Task 2: Aggregate consecutive terminal/command tool calls

**Problem:** Consecutive `command_run` (Bash/Terminal) tool calls in conversation display are NOT collapsed into groups. They appear as individual cards (see screenshot: 10+ consecutive `终端 ls ...` entries).

**Root cause:** `AGGREGATABLE_ACTIONS` in `DisplayConversationEntry.tsx:721` only includes `file_read`, `search`, `web_fetch`. `command_run` is not in the set, so `getAggregatableAction()` returns `null` for terminal calls.

**Fix:** Add `command_run` to `AGGREGATABLE_ACTIONS`, the `AggregationType` union, and `AGGREGATION_LABELS`. Also update the `DisplayItem` type in `VirtualizedList.tsx`.

**Files:**
- Modify: `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx:721-729`
- Modify: `frontend/src/components/logs/VirtualizedList.tsx:50`

**Step 1: Add command_run to aggregation**

In `DisplayConversationEntry.tsx`:

```typescript
// Line 721: Add 'command_run' to the set
const AGGREGATABLE_ACTIONS = new Set(['file_read', 'search', 'web_fetch', 'command_run']);

// Line 723: Add to type
type AggregationType = 'file_read' | 'search' | 'web_fetch' | 'command_run';

// Line 725-729: Add label
const AGGREGATION_LABELS: Record<AggregationType, { icon: React.ReactNode; label: string }> = {
  file_read: { icon: <Eye className="h-3 w-3" />, label: '查看文件' },
  search: { icon: <Search className="h-3 w-3" />, label: '搜索' },
  web_fetch: { icon: <Globe className="h-3 w-3" />, label: '网页抓取' },
  command_run: { icon: <TerminalSquare className="h-3 w-3" />, label: '终端' },
};
```

Import `TerminalSquare` from lucide-react at the top of the file.

In `VirtualizedList.tsx`, update the `DisplayItem` type:

```typescript
// Line 50:
aggregationType: 'file_read' | 'search' | 'web_fetch' | 'command_run';
```

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx frontend/src/components/logs/VirtualizedList.tsx
git commit -m "feat: aggregate consecutive terminal tool calls into collapsible groups"
```

---

### Task 3: Fix TodoList preview button not visible

**Problem:** The TodoList preview button (CheckSquare icon, added in batch 2) is gated by `todos.length > 0`. If the AI agent hasn't called `TodoWrite` yet, or the entries haven't loaded, the button is invisible.

**Fix:** Always show the button (with a muted style when no todos), so users know the feature exists. When there are no todos, show a "暂无待办事项" message in the popover.

**Files:**
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx` (the Popover block around line 801)

**Step 1: Make button always visible**

Change from:
```tsx
{todos.length > 0 && (
  <Popover>
    ...
  </Popover>
)}
```

To:
```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button
      size="sm"
      variant="outline"
      title="查看待办事项"
      className={todos.length === 0 ? 'opacity-50' : ''}
    >
      <CheckSquare className="h-4 w-4" />
      {todos.length > 0 && (
        <span className="ml-1 text-xs">{todos.length}</span>
      )}
    </Button>
  </PopoverTrigger>
  <PopoverContent align="end" className="w-72 p-2">
    {todos.length === 0 ? (
      <div className="text-xs text-muted-foreground py-2 text-center">暂无待办事项</div>
    ) : (
      <>
        <div className="text-xs font-medium mb-1.5">待办事项 ({todos.length})</div>
        <ul className="space-y-1 max-h-48 overflow-auto">
          {todos.map((todo, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs">
              <span className={`shrink-0 mt-0.5 ${
                todo.status === 'completed' ? 'text-green-500' :
                todo.status === 'in_progress' || todo.status === 'in-progress' ? 'text-blue-500' :
                'text-muted-foreground'
              }`}>
                {todo.status === 'completed' ? '✓' :
                 todo.status === 'in_progress' || todo.status === 'in-progress' ? '●' : '○'}
              </span>
              <span className={todo.status === 'cancelled' ? 'line-through text-muted-foreground' : ''}>
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </>
    )}
  </PopoverContent>
</Popover>
```

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/tasks/TaskFollowUpSection.tsx
git commit -m "fix: always show TodoList button, show empty state when no todos"
```

---

### Task 4: Fix sidebar panel mutual exclusion and width

**Problem:** Two issues:
1. Clicking file explorer doesn't properly close git panel (and vice versa) — the `group` reference may become invalid after `removePanel` destroys the last panel in a group.
2. File explorer opens too wide, eating into center panel width.

**Root cause:** After `dockviewApi.removePanel(gitPanel)`, if `gitPanel` was the only panel in its group, the group gets destroyed. The reference `gitPanel.group` becomes stale, so the `if (group)` check may pass but `addPanel({ referenceGroup: group })` fails silently, falling through to "create new group" path which creates ANOTHER left group.

**Fix approach:** Instead of relying on the group reference after removal, check if any left group exists by searching `dockviewApi.groups` after the removal. Also constrain left panel `initialWidth` to a reasonable value (200px) and add `maximumWidth`.

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx:232-348`

**Step 1: Rewrite toggleFileTree and toggleGitPanel**

```typescript
// Helper: find or create the left sidebar group
function getOrCreateLeftGroup(api: DockviewApi): DockviewGroupPanel {
  // Check if any left panel group already exists
  for (const group of api.groups) {
    if (group.panels.some(p => LEFT_PANEL_IDS.has(p.id))) {
      return group;
    }
  }
  // Also check for empty groups on the left (by position heuristic)
  // If no left group, create one
  const centerRef = api.panels.find(
    (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
  );
  if (!centerRef) throw new Error('No center panel to anchor left group');
  return api.addGroup({
    referencePanel: centerRef,
    direction: 'left',
    hideHeader: true,
    initialWidth: 200,
  });
}

const toggleFileTree = useCallback(() => {
  if (!dockviewApi) return;
  const existing = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
  if (existing) {
    dockviewApi.removePanel(existing);
    return;
  }
  // Close git panel first (mutual exclusion)
  const gitPanel = dockviewApi.getPanel(PANEL_IDS.GIT);
  if (gitPanel) dockviewApi.removePanel(gitPanel);

  // Get or create left group, then add file tree
  const leftGroup = getOrCreateLeftGroup(dockviewApi);
  dockviewApi.addPanel({
    id: PANEL_IDS.FILE_TREE,
    component: PANEL_IDS.FILE_TREE,
    title: '文件管理器',
    position: { referenceGroup: leftGroup, direction: 'within' },
  });
  applyLeftGroupHeaderHiding(dockviewApi);
}, [dockviewApi]);

const toggleGitPanel = useCallback(() => {
  if (!dockviewApi) return;
  const existing = dockviewApi.getPanel(PANEL_IDS.GIT);
  if (existing) {
    dockviewApi.removePanel(existing);
    return;
  }
  // Close file tree first (mutual exclusion)
  const filePanel = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
  if (filePanel) dockviewApi.removePanel(filePanel);

  const leftGroup = getOrCreateLeftGroup(dockviewApi);
  dockviewApi.addPanel({
    id: PANEL_IDS.GIT,
    component: PANEL_IDS.GIT,
    title: 'Git',
    position: { referenceGroup: leftGroup, direction: 'within' },
  });
  applyLeftGroupHeaderHiding(dockviewApi);
}, [dockviewApi]);
```

The key improvement: we first remove the conflicting panel, THEN find/create the left group. This avoids the stale group reference problem because `getOrCreateLeftGroup` searches after removal.

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/contexts/PanelActionsContext.tsx
git commit -m "fix: sidebar panel mutual exclusion with stable group reference"
```

---

### Task 5: Add center-1 and center-2 panel toggle buttons

**Problem:** The right sidebar toggle buttons only have Terminal, Logs, Git Diff, Notes. There's no way to toggle center-1 (main conversation) and center-2 (secondary) panel groups.

**Approach:** Add two new toggle buttons to `RightPanelSidebar.tsx` that show/hide the center-1 and center-2 groups using dockview group visibility API.

**Files:**
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx:41-46`
- Modify: `frontend/src/contexts/PanelActionsContext.tsx` (add toggleCenter1, toggleCenter2)
- Modify: `frontend/src/stores/useLayoutStore.ts` (ensure GROUP_IDS exported)

**Step 1: Add toggle functions in PanelActionsContext**

```typescript
const toggleCenterGroup = useCallback((groupId: string) => {
  if (!dockviewApi) return;
  const group = dockviewApi.groups.find(g => g.id === groupId);
  if (!group) return;
  // Toggle visibility by checking if group has active panels
  if (group.api.isVisible) {
    group.api.setVisible(false);
  } else {
    group.api.setVisible(true);
  }
}, [dockviewApi]);

const toggleCenter1 = useCallback(() => toggleCenterGroup(GROUP_IDS.CENTER_1), [toggleCenterGroup]);
const toggleCenter2 = useCallback(() => toggleCenterGroup(GROUP_IDS.CENTER_2), [toggleCenterGroup]);
```

Note: Check if dockview's `GroupPanelApi` has `setVisible`/`isVisible`. If not, use `group.api.setSize({ width: 0 })` or find alternative approach. Dockview may support `setActive`/`maximize` instead. Research the actual API before implementing.

**Step 2: Add buttons to RightPanelSidebar**

```tsx
import { Columns2, PanelLeft } from 'lucide-react';

// Add to buttons array:
{ icon: PanelLeft, label: '切换中栏1', onClick: toggleCenter1 },
{ icon: Columns2, label: '切换中栏2', onClick: toggleCenter2 },
```

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/contexts/PanelActionsContext.tsx frontend/src/components/layout/RightPanelSidebar.tsx
git commit -m "feat: add center-1 and center-2 panel toggle buttons to sidebar"
```

---

### Task 6: Show commit history tree in git panel

**Problem:** The git panel (`DockviewGitPanel.tsx`) only shows branch status (ahead/behind counts, conflicts). No commit history.

**Approach:**
1. Add a new Tauri command `get_workspace_commit_history` that wraps `git.get_branch_commit_messages()` and returns structured commit data.
2. Add frontend API wrapper.
3. Add a "提交历史" section to `DockviewGitPanel` showing commits as a simple list with commit message and short hash.

**Files:**
- Modify: `src-tauri/src/commands/workspaces.rs` (add Tauri command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `frontend/src/lib/api.ts` (add API method)
- Modify: `frontend/src/components/panels/DockviewGitPanel.tsx` (render history)

**Step 1: Add Tauri command**

In `src-tauri/src/commands/workspaces.rs`:

```rust
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CommitInfo {
    pub message: String,
}

#[tauri::command]
pub async fn get_workspace_commit_history(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<Vec<CommitInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or(AppError::NotFound("Workspace not found".to_string()))?;

    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo(pool, workspace_id, repo_id)
        .await?
        .ok_or(AppError::NotFound("Workspace repo not found".to_string()))?;

    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let container_ref = state.deployment.container().ensure_container_exists(&workspace).await?;
    let worktree_path = PathBuf::from(&container_ref).join(&repo.name);

    let git = state.deployment.git();
    let messages = git.get_branch_commit_messages(
        &worktree_path,
        &workspace.branch,
        &workspace_repo.target_branch,
    ).map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(messages.into_iter().map(|m| CommitInfo { message: m }).collect())
}
```

Register in `lib.rs` invoke_handler.

**Step 2: Add frontend API**

In `api.ts`:
```typescript
getCommitHistory: async (workspaceId: string, repoId: string): Promise<CommitInfo[]> => {
  return tauriInvoke<CommitInfo[]>('get_workspace_commit_history', { workspaceId, repoId });
},
```

**Step 3: Render in DockviewGitPanel**

Add a `useQuery` call for commit history and render as a collapsible list:

```tsx
// Inside DockviewGitPanel
const { data: commits } = useQuery({
  queryKey: ['commit-history', workspaceId, repoId],
  queryFn: () => attemptsApi.getCommitHistory(workspaceId, repoId),
  enabled: !!workspaceId && !!repoId,
});

// In render:
{commits && commits.length > 0 && (
  <div className="border-t border-border pt-2">
    <div className="text-xs font-medium text-muted-foreground mb-1">提交历史 ({commits.length})</div>
    <ul className="space-y-1 max-h-60 overflow-auto">
      {commits.map((commit, i) => (
        <li key={i} className="text-xs text-foreground flex items-start gap-1.5 py-0.5">
          <GitCommit className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
          <span className="line-clamp-1">{commit.message}</span>
        </li>
      ))}
    </ul>
  </div>
)}
```

**Step 4: Run cargo check and TypeScript check**

Run: `cd src-tauri && cargo check`
Run: `cd frontend && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src-tauri/src/commands/workspaces.rs src-tauri/src/lib.rs frontend/src/lib/api.ts frontend/src/components/panels/DockviewGitPanel.tsx
git commit -m "feat: show commit history tree in git panel"
```

---

### Task 7: Fix markdown table border visibility

**Problem:** Markdown tables in AI conversation output have borders that are too light/invisible. The table cells use `border-low` Tailwind class which maps to `--text-low` CSS variable, but this may not resolve properly in the legacy design system.

**Root cause:** In `wysiwyg.tsx:218-220`, table theme uses `border border-low` but `border-low` may not be a valid Tailwind color in the active config. The safe alternative is `border-border` which is universally defined.

**Fix:** Change `border-low` to `border-border` in the Lexical theme config.

**Files:**
- Modify: `frontend/src/components/ui/wysiwyg.tsx:218-220`

**Step 1: Update table theme classes**

```typescript
// Line 218-220: Change border-low to border-border
tableCell: 'border border-border px-3 py-2 text-left align-top',
tableCellHeader:
  'bg-muted font-semibold border border-border px-3 py-2 text-left align-top',
```

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/ui/wysiwyg.tsx
git commit -m "fix: make markdown table borders visible (border-low → border-border)"
```

---

### Task 8: Add success/failure toast for rebase and rebase-back

**Problem:** Clicking rebase or rebase-back buttons has no visual feedback on success or failure. In contrast, merge and push show 2-second success indicators.

**Root cause:** In `GitOperations.tsx:201-241`, the rebase handler doesn't set any success state. It only has `setRebasing(true/false)` for the loading spinner. In `useGitOperations.ts`, the rebase `onSuccess` callback only clears the error state — no toast, no success state.

**Fix:** Add `rebaseSuccess` / `rebaseBackSuccess` state variables following the same pattern as `mergeSuccess` / `pushSuccess`.

**Files:**
- Modify: `frontend/src/components/tasks/Toolbar/GitOperations.tsx:201-241`

**Step 1: Add success state and feedback**

Find the existing `mergeSuccess`/`pushSuccess` pattern and replicate for rebase:

```typescript
const [rebaseSuccess, setRebaseSuccess] = useState(false);

const handleRebaseWithNewBranchAndUpstream = async (...) => {
  setRebasing(true);
  try {
    const repoId = getSelectedRepoId();
    if (!repoId) return;
    await git.actions.rebase({ repoId, newBaseBranch, oldBaseBranch });
    setRebaseSuccess(true);
    setTimeout(() => setRebaseSuccess(false), 2000);
  } catch {
    // Error is already handled by useGitOperations context
  } finally {
    setRebasing(false);
  }
};
```

Do the same for `handleRebaseBack`:

```typescript
const [rebaseBackSuccess, setRebaseBackSuccess] = useState(false);

const handleRebaseBack = async () => {
  setRebasingBack(true);
  try {
    const repoId = getSelectedRepoId();
    if (!repoId) return;
    await git.actions.rebaseBack({ repoId });
    setRebaseBackSuccess(true);
    setTimeout(() => setRebaseBackSuccess(false), 2000);
  } catch {
    // Error handled by context
  } finally {
    setRebasingBack(false);
  }
};
```

In the JSX, add visual indicator (green check icon or text) next to the buttons when success state is true, following the pattern used for merge/push buttons.

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/tasks/Toolbar/GitOperations.tsx
git commit -m "fix: add success/failure feedback for rebase and rebase-back buttons"
```

---

### Task 9: Fix dev server start error + preview toolbar

**Problem:** Three issues:
1. Clicking "启动开发服务器" shows "Unknown error" — the error message extraction is wrong
2. No way to configure the dev server command when `dev_server_script` is not set
3. Preview panel is a plain tab, not the enhanced preview with browser toolbar (added in batch 2 but may not be working)

**Root cause (error extraction):** In `RightPanelSidebar.tsx:29`, `err instanceof Error` returns `false` for Tauri errors (which are strings or plain objects), so it always falls to `'Unknown error'`. The actual error is likely `"No dev server script configured for any repository in this workspace"`.

**Fix approach:**

1. Fix error extraction to handle Tauri string errors
2. When no dev server script is configured, show a prompt to configure it instead of just an error
3. Verify the ReadyContent preview toolbar is rendering correctly

**Files:**
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx:28-31`
- Verify: `frontend/src/components/tasks/TaskDetails/preview/ReadyContent.tsx`

**Step 1: Fix error extraction**

In `RightPanelSidebar.tsx`, line 29:

```typescript
// Before:
const message = err instanceof Error ? err.message : 'Unknown error';

// After:
const message = err instanceof Error
  ? err.message
  : typeof err === 'string'
    ? err
    : (err as any)?.message ?? JSON.stringify(err);
```

**Step 2: Add "configure dev server" flow**

When the error contains "No dev server script configured", show a helpful message and offer to open settings. Add an inline input for the dev server command:

```tsx
{startError && startError.includes('No dev server script') && (
  <div className="absolute bottom-12 right-10 w-64 p-3 bg-popover border border-border rounded-lg shadow-lg z-50">
    <div className="text-xs font-medium mb-2">配置开发服务器命令</div>
    <input
      className="w-full px-2 py-1 text-xs border rounded bg-background"
      placeholder="npm run dev"
      value={devCommand}
      onChange={(e) => setDevCommand(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && handleSaveDevCommand()}
    />
    <button
      className="mt-2 w-full px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
      onClick={handleSaveDevCommand}
    >
      保存并启动
    </button>
  </div>
)}
```

The `handleSaveDevCommand` should call `repoApi.update(repoId, { dev_server_script: devCommand })` then retry `startDevServer`.

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/components/layout/RightPanelSidebar.tsx
git commit -m "fix: proper error display for dev server, add inline config when unset"
```

---

## Execution Order (Recommended)

**Quick fixes (< 5 min each):**
- Task 7: Markdown table borders
- Task 3: TodoList button always visible

**Medium fixes (5-15 min each):**
- Task 2: Terminal tool call aggregation
- Task 8: Rebase success feedback
- Task 9: Dev server error + config
- Task 1: Terminal black screen fix
- Task 4: Sidebar panel mutual exclusion

**Feature additions (15-30 min each):**
- Task 5: Center panel toggle buttons
- Task 6: Git commit history (requires Rust)
