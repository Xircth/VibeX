# UI Fixes Batch 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 11 UI bugs and feature gaps across workspace switching, sidebar panels, kanban, messaging, terminal, preview, and action bar.

**Architecture:** Pure frontend fixes except Task 1 (needs new Tauri command for worktree path). All changes are in `frontend/src/` except where noted. Each task is independent and can be committed separately.

**Tech Stack:** React 18, TypeScript, Zustand, @dnd-kit/core, xterm.js, Dockview, Tauri IPC

---

### Task 1: File explorer switches to worktree path on workspace change

**Problem:** `DockviewFileTreePanel` uses `useProjectRepos` which returns the main repo path (`Repo.path`), not the workspace-specific git worktree path. When switching workspaces, the file tree stays on the original repo path.

**Root cause:** The file tree root path is set from `repos[0].path` (project-level), but should use `workspace.container_ref + "/" + repo.name` (workspace-level worktree path).

**Approach:** Add a new Tauri command `get_workspace_worktree_paths` that returns `{ repo_id, worktree_path }[]` for a workspace. In the file tree panel, when `activeWorktreeId` changes, call this API and update `rootPath`. Keep existing file preview tabs open (don't clear `selectedFilePath`).

**Files:**
- Create: `src-tauri/src/commands/worktree_paths.rs` (or add to `workspaces.rs`)
- Modify: `src-tauri/src/commands/workspaces.rs` (add new command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `frontend/src/lib/api.ts` (add API wrapper)
- Modify: `frontend/src/components/panels/DockviewFileTreePanel.tsx:20-37`
- Modify: `shared/types.ts` (add WorktreePathInfo type if needed)

**Step 1: Add Tauri command to return worktree paths**

In `src-tauri/src/commands/workspaces.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct WorktreePathInfo {
    pub repo_id: Uuid,
    pub repo_name: String,
    pub worktree_path: String,
}

#[tauri::command]
pub async fn get_workspace_worktree_paths(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<WorktreePathInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let container_ref = match &workspace.container_ref {
        Some(cr) => cr.clone(),
        None => {
            let cr = state.deployment.container().ensure_container_exists(&workspace).await?;
            cr
        }
    };

    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace_id).await?;
    let mut result = Vec::new();
    for wr in workspace_repos {
        let repo = Repo::find_by_id(pool, wr.repo_id).await?.ok_or(RepoError::NotFound)?;
        let worktree_path = PathBuf::from(&container_ref).join(&repo.name);
        result.push(WorktreePathInfo {
            repo_id: repo.id,
            repo_name: repo.name.clone(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
        });
    }
    Ok(result)
}
```

Register in `src-tauri/src/lib.rs` invoke_handler.

**Step 2: Add frontend API wrapper**

In `frontend/src/lib/api.ts`, inside `attemptsApi`:

```typescript
getWorktreePaths: async (workspaceId: string): Promise<WorktreePathInfo[]> => {
  return tauriInvoke<WorktreePathInfo[]>('get_workspace_worktree_paths', { workspaceId });
},
```

Add to `shared/types.ts`:
```typescript
export type WorktreePathInfo = {
  repo_id: string,
  repo_name: string,
  worktree_path: string,
};
```

**Step 3: Update DockviewFileTreePanel to use worktree path**

```typescript
// DockviewFileTreePanel.tsx
import { useWorktree } from '@/contexts/WorktreeContext';
import { attemptsApi } from '@/lib/api';
// ... existing imports ...

function DockviewFileTreePanel(_props: IDockviewPanelProps) {
  const { rootPath, setRootPath, setSelectedFilePath, setDiffFilePath } = useFileTreeStore();
  const { data: tree, isLoading, refetch } = useFileTree(rootPath);
  const { openFilePreview, openDiffPreview } = usePanelActions();
  const { projectId } = useProject();
  const { data: repos } = useProjectRepos(projectId);
  const { activeWorktreeId } = useWorktree();

  // When workspace changes, switch to worktree path
  useEffect(() => {
    if (!activeWorktreeId) {
      // No workspace active - fall back to project repo path
      if (!rootPath && repos && repos.length > 0) {
        setRootPath(repos[0].path);
      }
      return;
    }
    // Fetch worktree paths for active workspace
    attemptsApi.getWorktreePaths(activeWorktreeId).then((paths) => {
      if (paths.length > 0) {
        setRootPath(paths[0].worktree_path);
      }
    }).catch(console.error);
  }, [activeWorktreeId]); // Only re-run when workspace changes, NOT when rootPath changes
  // ... rest of component unchanged
}
```

**Step 4: Run cargo check and TypeScript check**

Run: `cd src-tauri && cargo check`
Run: `cd frontend && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src-tauri/src/commands/workspaces.rs src-tauri/src/lib.rs frontend/src/lib/api.ts frontend/src/components/panels/DockviewFileTreePanel.tsx shared/types.ts
git commit -m "feat: switch file explorer to worktree path on workspace change"
```

---

### Task 2: Sidebar panels (file explorer / git) are mutually exclusive

**Problem:** Clicking the file explorer button when git manager is open adds it as a tab in the same group (and vice versa). They should be mutually exclusive — opening one closes the other.

**Root cause:** `toggleFileTree` and `toggleGitPanel` in `PanelActionsContext.tsx` add the new panel alongside the existing one using `direction: 'within'`. They never remove the other panel.

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx:232-333`

**Step 1: Modify toggleFileTree to close git panel first**

In `PanelActionsContext.tsx`, modify `toggleFileTree` (around line 232):

```typescript
const toggleFileTree = useCallback(() => {
  if (!dockviewApi) return;

  const fileTreePanel = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
  if (fileTreePanel) {
    // Already open → close it (toggle off)
    dockviewApi.removePanel(fileTreePanel);
    return;
  }

  // Close git panel if open (mutually exclusive)
  const gitPanel = dockviewApi.getPanel(PANEL_IDS.GIT);
  if (gitPanel) {
    // Remember the group before removing git panel
    const group = gitPanel.group;
    dockviewApi.removePanel(gitPanel);
    // Add file tree to the same group (reuse existing left group)
    if (group && group.panels.length >= 0) {
      dockviewApi.addPanel({
        id: PANEL_IDS.FILE_TREE,
        component: PANEL_IDS.FILE_TREE,
        title: '文件管理器',
        position: { referenceGroup: group, direction: 'within' },
      });
      applyLeftGroupHeaderHiding(dockviewApi);
      return;
    }
  }

  // No left group exists → create new one
  const centerRef = dockviewApi.panels.find(
    (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
  );
  if (centerRef) {
    const leftGroup = dockviewApi.addGroup({
      referencePanel: centerRef,
      direction: 'left',
      hideHeader: true,
      initialWidth: 220,
    });
    dockviewApi.addPanel({
      id: PANEL_IDS.FILE_TREE,
      component: PANEL_IDS.FILE_TREE,
      title: '文件管理器',
      position: { referenceGroup: leftGroup, direction: 'within' },
    });
    applyLeftGroupHeaderHiding(dockviewApi);
  }
}, [dockviewApi]);
```

Apply the same pattern to `toggleGitPanel` — when opening git, close file tree first.

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/contexts/PanelActionsContext.tsx
git commit -m "fix: make file explorer and git sidebar mutually exclusive"
```

---

### Task 3: Task card shows title + description separately in kanban

**Problem:** Task creation dialog uses `splitMessageToTitleDescription` to auto-extract title from first line. But in kanban cards, only `task.title` is shown. User wants a dedicated title input field, and kanban cards should show title (bold) + first line of description (small text). Sent messages should only contain description, not title.

**Current behavior:** TaskFormDialog has a single WYSIWYG editor. First line → title, rest → description (via `splitMessageToTitleDescription`).

**Desired behavior:** Add a separate plain-text title input above the WYSIWYG editor. Kanban card shows `title` (bold) + `description` (one line, small). The message sent to Claude only uses `description`.

**Files:**
- Modify: `frontend/src/components/dialogs/tasks/TaskFormDialog.tsx:127-220`
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx:233-240`

**Step 1: Add title input to TaskFormDialog**

In `TaskFormDialog.tsx`, add a title text input field above the WYSIWYG editor. The form should have:
- `title`: plain text input (required)
- `description`: WYSIWYG editor (the task content / instructions for Claude)

Remove the `splitMessageToTitleDescription` usage from the submit handler. Instead:
- `title` comes directly from the title input
- `description` comes from the WYSIWYG editor content

For edit mode, populate title input with `task.title` and WYSIWYG with `task.description` (don't merge them).

```typescript
// In the form's defaultValues:
title: props.mode === 'edit' ? props.task.title : '',
description: props.mode === 'edit' ? (props.task.description ?? '') : '',
```

Add before the WYSIWYG editor in the render:
```tsx
<form.Field name="title">
  {(field) => (
    <div className="space-y-1">
      <Label htmlFor="task-title" className="text-xs">任务标题</Label>
      <input
        id="task-title"
        type="text"
        placeholder="输入任务标题..."
        value={field.state.value}
        onChange={(e) => field.handleChange(e.target.value)}
        className="w-full px-3 py-1.5 text-sm border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        autoFocus
      />
    </div>
  )}
</form.Field>
```

In submit handler, use `title` directly from the form instead of `splitMessageToTitleDescription(description)`.

**Step 2: Update kanban card to show description**

In `DockviewKanbanPanel.tsx`, update `DraggableTaskCard` (line 233-240):

```tsx
<div className="text-xs font-medium text-foreground line-clamp-2 pr-5">
  {task.title}
</div>
{task.description && (
  <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1 pr-5">
    {task.description}
  </div>
)}
{task.executor && (
  <div className="text-[10px] text-muted-foreground mt-1 truncate pr-5">
    {task.executor}
  </div>
)}
```

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/components/dialogs/tasks/TaskFormDialog.tsx frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "feat: separate title input in task form, show title+description in kanban"
```

---

### Task 4: Fix second message sending failure after activating Claude Code

**Problem:** After activating a Claude Code conversation, only one message can be sent. The second message click does nothing.

**Root cause:** In `TaskFollowUpSection.tsx:363-365`, `canTypeFollowUp` returns false when `processes.length === 0`. After the first message is sent and Claude finishes processing, the `executionProcessesVisible` array may become empty again (all processes completed), causing `processes.length === 0` and blocking further input.

**Fix:** The condition `processes.length === 0` was intended to prevent sending before a session exists. Instead, check `workspaceId` only — the session existence is sufficient.

**Files:**
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx:363-378`

**Step 1: Fix canTypeFollowUp condition**

```typescript
// Before (line 363-365):
const canTypeFollowUp = useMemo(() => {
  if (!workspaceId || processes.length === 0 || isSendingFollowUp) {
    return false;
  }
  // ...

// After:
const canTypeFollowUp = useMemo(() => {
  if (!workspaceId || isSendingFollowUp) {
    return false;
  }
  // ...
```

Also remove `processes.length` from the useMemo dependency array (line 374).

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/tasks/TaskFollowUpSection.tsx
git commit -m "fix: allow sending messages when no active processes running"
```

---

### Task 5: Merge three init messages into one component

**Problem:** Three system messages (`System: hook_started`, `System: hook_response`, `System initialized with model: claude-opus-4-6`) are displayed as separate cards. They should be merged into one "Session initialized" component.

**Approach:** In `DisplayConversationEntry.tsx`, detect consecutive system messages that match these init patterns and render them as a single collapsed group. Or better: filter/merge them in the rendering pipeline.

**Simplest approach:** In `DisplayConversationEntry.tsx`, when rendering a `system_message`, check if its content matches one of the init patterns (`System: hook_started`, `System: hook_response`, `System initialized with model:`). If so, render a compact "init" variant. Then in `VirtualizedList.tsx`'s `buildDisplayItems`, aggregate consecutive init messages into a single display item.

**Files:**
- Modify: `frontend/src/components/logs/VirtualizedList.tsx:45-77` (buildDisplayItems)
- Modify: `frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx:1010-1025`

**Step 1: Define init message patterns**

In `VirtualizedList.tsx`, add init message detection to `buildDisplayItems`:

```typescript
function isInitMessage(entry: PatchTypeWithKey): boolean {
  if (entry.type !== 'NORMALIZED_ENTRY') return false;
  const ne = entry as NormalizedEntryPatchType;
  if (ne.entry_type?.type !== 'system_message') return false;
  const content = ne.content ?? '';
  return (
    content.startsWith('System: hook_') ||
    content.startsWith('System initialized with model:')
  );
}
```

In `buildDisplayItems`, aggregate consecutive init messages into a group (similar to how tool_use aggregation works):

```typescript
// After existing aggregation logic, add:
if (isInitMessage(entry)) {
  // Collect all consecutive init messages
  const initGroup: PatchTypeWithKey[] = [entry];
  while (i + 1 < entries.length && isInitMessage(entries[i + 1])) {
    initGroup.push(entries[++i]);
  }
  items.push({
    kind: 'group' as const,
    key: `init-${initGroup[0].patchKey}`,
    type: 'init_group',
    entries: initGroup,
  });
  continue;
}
```

**Step 2: Render init group as compact component**

In `DisplayConversationEntry.tsx` (or in the `ItemContent` switch in `VirtualizedList.tsx`), handle `init_group` type:

```tsx
// Compact init message component
function InitMessageGroup({ entries }: { entries: PatchTypeWithKey[] }) {
  const modelEntry = entries.find(e =>
    e.type === 'NORMALIZED_ENTRY' && (e as any).content?.startsWith('System initialized with model:')
  );
  const modelName = modelEntry
    ? (modelEntry as any).content.replace('System initialized with model: ', '')
    : 'unknown';

  return (
    <div className="px-4 py-1.5 text-xs text-muted-foreground flex items-center gap-2">
      <Settings className="h-3 w-3" />
      <span>会话已初始化 · {modelName}</span>
    </div>
  );
}
```

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/components/logs/VirtualizedList.tsx frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx
git commit -m "feat: merge init system messages into single compact component"
```

---

### Task 6: Fix kanban drag-and-drop between columns

**Problem:** Kanban drag-and-drop was previously fixed but may still have issues with the drag interaction.

**Current state:** `DockviewKanbanPanel.tsx` already has `DndContext`, `useDraggable`, `useDroppable`, and `handleDragEnd` with `updateTask.mutate`. If the issue is that drag doesn't work at all, verify the `PointerSensor` activation constraint isn't too high. If the issue is status not updating, verify the `over.id` correctly maps to `TaskStatus`.

**Verification step:** Read the current implementation (already done above). The code at lines 79-101 looks correct. The `columnKey` is used as `useDroppable({ id: columnKey })`, and `handleDragEnd` reads `over.id as TaskStatus`. This should work.

**If dragging still doesn't work**, the issue may be that `rectIntersection` collision detection fails when the card is dragged outside its column's rect. Consider switching to `closestCenter` or `pointerWithin`.

**Files:**
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx:106-109`

**Step 1: Verify and fix collision detection**

If drag-drop is non-functional, try:

```typescript
import { closestCenter } from '@dnd-kit/core';
// Change line 107:
<DndContext collisionDetection={closestCenter} ...>
```

Also confirm that the `PointerSensor` distance of `8` is reasonable (it is — 8px to start drag).

**Step 2: Test manually, commit if changed**

```bash
git add frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "fix: improve kanban drag-drop collision detection"
```

---

### Task 7: Fix history loading showing empty after loading state ends

**Problem:** After the 5s safety timeout, loading state ends but `entries` array is still empty. The conversation history was never actually loaded.

**Root cause (two issues):**

1. **`useConversationHistoryOld.ts:544-549`:** The initial load effect checks `executionProcesses?.current.length === 0` and returns early. If execution processes haven't arrived from the Tauri stream yet, the entire history load is skipped. Even when `idListKey` later changes (processes arrive), the effect may not re-run properly.

2. **`VirtualizedList.tsx:96-111`:** `onEntriesUpdated` callback has `loading` in its dependency array. When `loading` is `true`, it correctly updates. But after the 5s timeout sets `loading = false`, the callback no longer calls `setLoading(newLoading)`, creating a stale closure issue where late-arriving data never updates the loading state.

**Fix approach:**

1. In `VirtualizedList.tsx`, remove the `if (loading)` guard from `onEntriesUpdated` — always forward the `newLoading` value:

```typescript
const onEntriesUpdated = useCallback(
  (newEntries: PatchTypeWithKey[], addType: AddEntryType, newLoading: boolean) => {
    addTypeRef.current = addType;
    setEntriesState(newEntries);
    setEntries(newEntries);
    setLoading(newLoading);
  },
  [setEntries]  // Remove 'loading' from deps
);
```

2. In `useConversationHistoryOld.ts`, change the early return condition to not skip when `executionProcesses` is empty but instead wait for them:

```typescript
// Line 544-549: Change from:
if (executionProcesses?.current.length === 0 || loadedInitialEntries.current)
  return;

// To:
if (loadedInitialEntries.current) return;
if (!executionProcesses?.current || executionProcesses.current.length === 0) return;
// This still returns early, but idListKey in deps will trigger re-run when processes arrive
```

The key fix is #1 — removing the stale closure. With `idListKey` in the effect deps, re-runs will happen when processes arrive. The `onEntriesUpdated` fix ensures data always flows through.

**Files:**
- Modify: `frontend/src/components/logs/VirtualizedList.tsx:96-111`
- Modify: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts:544-549`

**Step 1: Fix onEntriesUpdated stale closure**

In `VirtualizedList.tsx`, replace lines 96-111:

```typescript
const onEntriesUpdated = useCallback(
  (newEntries: PatchTypeWithKey[], addType: AddEntryType, newLoading: boolean) => {
    addTypeRef.current = addType;
    setEntriesState(newEntries);
    setEntries(newEntries);
    setLoading(newLoading);
  },
  [setEntries]
);
```

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/components/logs/VirtualizedList.tsx frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts
git commit -m "fix: resolve stale closure in history loading, ensure entries flow through"
```

---

### Task 8: Fix terminal background color to match app theme

**Problem:** Terminal has hardcoded dark zinc-950 (`#09090b`) background, doesn't match the app's theme colors.

**Root cause:** `useTauriTerminal.ts:129-150` has hardcoded hex colors. The `terminalTheme.ts` utility already exists with `getTerminalTheme()` that reads CSS variables dynamically, but it's not being used.

**Fix:** Replace hardcoded theme with `getTerminalTheme()` call.

**Files:**
- Modify: `frontend/src/hooks/useTauriTerminal.ts:125-154`

**Step 1: Use getTerminalTheme()**

```typescript
// In useTauriTerminal.ts, add import:
import { getTerminalTheme } from '@/utils/terminalTheme';

// Replace lines 125-154:
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'IBM Plex Mono, Menlo, Monaco, Consolas, monospace',
  theme: getTerminalTheme(),
  scrollback: 5000,
  convertEol: true,
  allowProposedApi: true,
});
```

**Step 2: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add frontend/src/hooks/useTauriTerminal.ts
git commit -m "fix: use dynamic theme for terminal background matching app colors"
```

---

### Task 9: Dev server start button + native preview with browser controls

**Problem:** Right panel sidebar's "start dev server" and "open preview" buttons don't work properly. Preview is a simple iframe without browser controls (back, forward, URL bar, DevTools, responsive view toggle).

**Two sub-problems:**

**9a: Dev server start button** — Currently calls `attemptsApi.startDevServer(activeWorktreeId)` directly. Check if this works or if there's an error. The handler in `RightPanelSidebar.tsx` may not have proper error handling or state feedback.

**9b: Preview panel** — Currently uses `<iframe>` in `ReadyContent.tsx`. Adding full browser controls (back/forward/URL/DevTools/responsive) to an iframe is limited but feasible with a toolbar wrapper. True native webview would require significant Tauri changes. **Pragmatic approach:** Add a toolbar above the iframe with URL bar, back/forward (via iframe history), refresh, and responsive size presets.

**Files:**
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx:66-95` (fix dev server button)
- Modify: `frontend/src/components/tasks/TaskDetails/preview/ReadyContent.tsx:12-22` (add toolbar)

**Step 1: Fix dev server start button with feedback**

In `RightPanelSidebar.tsx`, ensure the start button has loading state and error handling:

```tsx
const [isStarting, setIsStarting] = useState(false);

const handleStartDevServer = async () => {
  if (!activeWorktreeId || isStarting) return;
  setIsStarting(true);
  try {
    await attemptsApi.startDevServer(activeWorktreeId);
  } catch (error) {
    console.error('Failed to start dev server:', error);
  } finally {
    setIsStarting(false);
  }
};
```

After starting, auto-open the Preview panel:
```typescript
handleStartDevServer().then(() => {
  openOrFocusPanel(PANEL_IDS.PREVIEW, 'Preview');
});
```

**Step 2: Add browser toolbar to preview**

In `ReadyContent.tsx`, wrap the iframe in a toolbar container:

```tsx
function ReadyContent({ url, onIframeError }: Props) {
  const [currentUrl, setCurrentUrl] = useState(url);
  const [urlInput, setUrlInput] = useState(url);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [viewMode, setViewMode] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');

  const viewSizes = {
    desktop: { width: '100%', height: '100%' },
    tablet: { width: '768px', height: '100%' },
    mobile: { width: '375px', height: '100%' },
  };

  const handleNavigate = () => {
    let target = urlInput.trim();
    if (target && !target.startsWith('http')) target = 'http://' + target;
    setCurrentUrl(target);
    setIframeKey(k => k + 1);
  };

  const handleRefresh = () => setIframeKey(k => k + 1);

  return (
    <div className="h-full flex flex-col">
      {/* Browser toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/50 shrink-0">
        <button onClick={handleRefresh} className="p-1 hover:bg-accent rounded" title="刷新">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
          className="flex-1 px-2 py-0.5 text-xs border rounded bg-background"
          placeholder="输入 URL..."
        />
        <button onClick={handleNavigate} className="p-1 hover:bg-accent rounded text-xs">Go</button>
        <div className="border-l border-border mx-1 h-4" />
        {(['desktop', 'tablet', 'mobile'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`p-1 rounded text-xs ${viewMode === mode ? 'bg-accent text-foreground' : 'hover:bg-accent text-muted-foreground'}`}
            title={mode}
          >
            {mode === 'desktop' ? <Monitor className="h-3.5 w-3.5" /> :
             mode === 'tablet' ? <Tablet className="h-3.5 w-3.5" /> :
             <Smartphone className="h-3.5 w-3.5" />}
          </button>
        ))}
      </div>
      {/* iframe */}
      <div className="flex-1 flex items-start justify-center overflow-auto bg-muted/20">
        <iframe
          key={iframeKey}
          ref={iframeRef}
          src={currentUrl}
          title="开发服务器预览"
          style={viewMode === 'desktop' ? { width: '100%', height: '100%' } : viewSizes[viewMode]}
          className="border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          referrerPolicy="no-referrer"
          onError={onIframeError}
        />
      </div>
    </div>
  );
}
```

Import `Monitor`, `Tablet`, `Smartphone`, `RefreshCw` from lucide-react.

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/components/layout/RightPanelSidebar.tsx frontend/src/components/tasks/TaskDetails/preview/ReadyContent.tsx
git commit -m "feat: fix dev server start, add browser toolbar to preview panel"
```

---

### Task 10: Replace run-script button with TodoList preview button

**Problem:** The Terminal icon "run script" dropdown near the send button should be replaced with a TodoList preview button that shows current subtask execution status. Also remove all run-script related code.

**Approach:**
- Remove the `hasAnyScript`, `handleRunSetupScript`, `handleRunCleanupScript` code from `TaskFollowUpSection.tsx`
- Remove the `DropdownMenu` with Terminal icon (lines 831-863)
- Add a TodoList preview button in its place that uses `useTodos` hook to show a popover with current todo items and their status
- The existing `TodoPanel.tsx` component already has the rendering logic — reuse it in a Popover.

**Files:**
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx:402-420,831-863`
- Remove references: `handleRunSetupScript`, `handleRunCleanupScript`, `hasAnyScript`

**Step 1: Remove run-script code**

In `TaskFollowUpSection.tsx`:
- Delete `const hasAnyScript = true;` (line 402)
- Delete `handleRunSetupScript` callback (lines 404-411)
- Delete `handleRunCleanupScript` callback (lines 413-420)
- Delete the entire `{hasAnyScript && (<DropdownMenu>...</DropdownMenu>)}` block (lines 831-863)
- Remove `Terminal` from the lucide-react import (line 9) if not used elsewhere

**Step 2: Add TodoList preview popover**

Add imports:
```typescript
import { CheckSquare } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTodos } from '@/hooks/useTodos';
```

Add hook usage:
```typescript
const { entries: allEntries } = useEntries();
const { todos } = useTodos(allEntries);
```

Replace the deleted script dropdown with:
```tsx
{todos.length > 0 && (
  <Popover>
    <PopoverTrigger asChild>
      <Button size="sm" variant="outline" title="查看待办事项">
        <CheckSquare className="h-4 w-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-72 p-2">
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
    </PopoverContent>
  </Popover>
)}
```

**Step 3: Check if attemptsApi.runSetupScript / runCleanupScript are used elsewhere**

Search for `runSetupScript` and `runCleanupScript` usage. If only used in `TaskFollowUpSection.tsx`, the API definitions can stay (they may be used in tests or future features). Don't delete the backend commands.

**Step 4: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 5: Commit**

```bash
git add frontend/src/components/tasks/TaskFollowUpSection.tsx
git commit -m "feat: replace run-script button with TodoList preview popover"
```

---

### Task 11: Fix dragged task card z-index (hidden behind kanban)

**Problem:** When dragging a task card in the kanban, it visually hides behind other elements (kanban columns, panel borders) because the card moves via CSS transform within its parent stacking context, and `zIndex: 1000` doesn't escape the parent.

**Root cause:** No `DragOverlay` is used. The original element is transformed in place, staying within its parent's stacking context.

**Fix:** Add `DragOverlay` from @dnd-kit which renders the dragged item in a React Portal (appended to `document.body`), completely escaping all stacking contexts.

**Files:**
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`

**Step 1: Add DragOverlay with active task tracking**

```typescript
import { DndContext, DragOverlay, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import { useState } from 'react';

// Inside KanbanBoard:
const [activeTask, setActiveTask] = useState<TaskWithAttemptStatus | null>(null);

const handleDragStart = useCallback(
  (event: DragStartEvent) => {
    const taskId = event.active.id as string;
    const allTasks = Object.values(tasksByStatus).flat();
    const task = allTasks.find(t => t.id === taskId) ?? null;
    setActiveTask(task);
  },
  [tasksByStatus],
);

const handleDragEnd = useCallback(
  (event: DragEndEvent) => {
    setActiveTask(null);
    // ... existing handleDragEnd logic
  },
  [updateTask],
);

// In JSX:
<DndContext
  collisionDetection={closestCenter}
  onDragStart={handleDragStart}
  onDragEnd={handleDragEnd}
  sensors={sensors}
>
  <div className="flex gap-3 h-full min-w-0">
    {KANBAN_COLUMNS.map((col) => (/* ... */))}
  </div>
  <DragOverlay dropAnimation={null}>
    {activeTask ? (
      <div className="w-[160px] p-2 rounded border border-primary bg-background shadow-lg">
        <div className="text-xs font-medium text-foreground line-clamp-2">
          {activeTask.title}
        </div>
        {activeTask.description && (
          <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">
            {activeTask.description}
          </div>
        )}
      </div>
    ) : null}
  </DragOverlay>
</DndContext>
```

**Step 2: Make original card invisible while dragging**

In `DraggableTaskCard`, when `isDragging`, make the original card invisible (not just semi-transparent):

```typescript
className={`... ${isDragging ? 'opacity-0' : ''}`}
```

Remove the inline `zIndex` and `transform` style from `DraggableTaskCard` — `DragOverlay` handles the visual movement:

```typescript
style={{
  transform: transform
    ? `translateX(${transform.x}px) translateY(${transform.y}px)`
    : undefined,
  // Remove zIndex — DragOverlay handles this now
}}
```

Actually, keep the transform (needed for the placeholder position shift) but remove the zIndex and use opacity:0 instead of opacity:50:

```typescript
style={{
  transform: transform
    ? `translateX(${transform.x}px) translateY(${transform.y}px)`
    : undefined,
}}
className={`... ${isDragging ? 'opacity-0 cursor-grabbing' : ''}`}
```

**Step 3: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`

**Step 4: Commit**

```bash
git add frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "fix: use DragOverlay for kanban cards to prevent z-index hiding"
```

---

## Execution Order (Recommended)

Tasks can be executed in any order since they're independent. Recommended grouping by complexity:

**Quick fixes (< 5 min each):**
- Task 4: Fix second message sending
- Task 8: Terminal theme

**Medium fixes (5-15 min each):**
- Task 2: Sidebar mutual exclusion
- Task 7: History loading stale closure
- Task 11: DragOverlay for kanban
- Task 6: Kanban drag collision detection

**Feature additions (15-30 min each):**
- Task 3: Task title input + kanban card
- Task 5: Init messages merge
- Task 10: TodoList preview button
- Task 9: Dev server + preview toolbar
- Task 1: Worktree path switching (requires Rust)
