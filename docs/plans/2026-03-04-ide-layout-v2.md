# IDE Layout V2 - Terminal/Git Fix + Worktree Selector + Task Flow Rework

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken Terminal/Git panels, replace project selector with worktree selector, and rework the post-task-creation flow to use the new dockview Kanban with a dedicated right-panel conversation area.

**Architecture:** Introduce a `WorktreeContext` to provide the active worktree (workspace/attempt) across all components. The right panel switches from rendering `<Outlet/>` (ProjectTasks) to a purpose-built `RightPanelContent` with branch header + conversation area + mini sidebar. The dockview Kanban becomes the real kanban with live task data.

**Tech Stack:** React 18, dockview-react 5.1.0, Tauri v2 (IPC), TanStack Query, Zustand, @dnd-kit, Tailwind CSS, lucide-react icons.

---

## Task 1: Create WorktreeContext — Active Worktree State

**Goal:** Provide the currently-selected worktree (workspace/attempt) ID and metadata across the entire component tree. This replaces reliance on `useParams().attemptId` for Terminal, Git, and branch status.

**Files:**
- Create: `frontend/src/contexts/WorktreeContext.tsx`
- Modify: `frontend/src/components/layout/WorkspaceLayout.tsx:17-31` (wrap with new provider)

**Step 1: Create WorktreeContext**

```tsx
// frontend/src/contexts/WorktreeContext.tsx
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export interface WorktreeState {
  /** Currently selected workspace (attempt) ID */
  activeWorktreeId: string | null;
  /** Task ID that this worktree belongs to */
  activeTaskId: string | null;
  /** Set the active worktree */
  setActiveWorktree: (worktreeId: string | null, taskId: string | null) => void;
}

const WorktreeContext = createContext<WorktreeState | null>(null);

export function WorktreeProvider({ children }: { children: ReactNode }) {
  const [activeWorktreeId, setWorktreeId] = useState<string | null>(null);
  const [activeTaskId, setTaskId] = useState<string | null>(null);

  const setActiveWorktree = useCallback((worktreeId: string | null, taskId: string | null) => {
    setWorktreeId(worktreeId);
    setTaskId(taskId);
  }, []);

  return (
    <WorktreeContext.Provider value={{ activeWorktreeId, activeTaskId, setActiveWorktree }}>
      {children}
    </WorktreeContext.Provider>
  );
}

export function useWorktree(): WorktreeState {
  const ctx = useContext(WorktreeContext);
  if (!ctx) throw new Error('useWorktree must be used within WorktreeProvider');
  return ctx;
}
```

**Step 2: Integrate into WorkspaceLayout**

Modify `frontend/src/components/layout/WorkspaceLayout.tsx`:

```tsx
import { WorktreeProvider } from '@/contexts/WorktreeContext';

export function WorkspaceLayout({ rightPanelContent, toolbarContent }: WorkspaceLayoutProps) {
  return (
    <WorktreeProvider>
      <TerminalProvider>
        <PanelActionsProvider>
          <IDELayout
            rightPanelContent={rightPanelContent}
            toolbarContent={toolbarContent}
          />
        </PanelActionsProvider>
      </TerminalProvider>
    </WorktreeProvider>
  );
}
```

**Step 3: Sync URL params to WorktreeContext**

Modify `frontend/src/components/layout/IDEWorkspaceRoute.tsx` to read `attemptId` from URL params and push it into WorktreeContext:

```tsx
import { Outlet, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { Toolbar } from '@/components/layout/Toolbar';
import { useWorktree } from '@/contexts/WorktreeContext';

function IDEWorkspaceRouteInner() {
  const { attemptId, taskId } = useParams<{ attemptId?: string; taskId?: string }>();
  const { setActiveWorktree } = useWorktree();

  useEffect(() => {
    setActiveWorktree(attemptId ?? null, taskId ?? null);
  }, [attemptId, taskId, setActiveWorktree]);

  return <Outlet />;
}

export function IDEWorkspaceRoute() {
  return (
    <div className="flex flex-col h-screen">
      <WorkspaceLayout
        toolbarContent={<Toolbar />}
        rightPanelContent={<RightPanelContent />}
      />
    </div>
  );
}
```

Note: `RightPanelContent` will be created in Task 6. For now, keep `<Outlet />` as a temporary placeholder until Task 6 is complete.

**Step 4: Commit**

```bash
git add frontend/src/contexts/WorktreeContext.tsx frontend/src/components/layout/WorkspaceLayout.tsx
git commit -m "feat: add WorktreeContext for active worktree state management"
```

---

## Task 2: Fix Terminal — Use WorktreeContext Instead of URL Params

**Goal:** Terminal "+" button works regardless of URL. Terminal uses `WorktreeContext.activeWorktreeId` as `workspaceId`. When no worktree is selected, terminal uses project ID as a fallback workspace key (local terminal without PTY binding).

**Files:**
- Modify: `frontend/src/components/layout/panels/TerminalHeaderActions.tsx:1-75`
- Modify: `frontend/src/components/panels/DockviewTerminalPanel.tsx:1-166`

**Step 1: Update TerminalHeaderActions to use WorktreeContext**

Replace the `useParams` dependency with `useWorktree`:

```tsx
// frontend/src/components/layout/panels/TerminalHeaderActions.tsx
import { useCallback, useState } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { Plus } from 'lucide-react';

import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  useTerminalStore,
  generateTerminalTabId,
} from '@/stores/useTerminalStore';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProject } from '@/contexts/ProjectContext';

const SHELL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'powershell.exe', label: 'PowerShell' },
  { value: 'cmd.exe', label: 'CMD' },
  { value: 'bash', label: 'Bash' },
];

export function TerminalHeaderActions(props: IDockviewHeaderActionsProps) {
  const isTerminalGroup = props.panels.some(
    (p) => p.id === PANEL_IDS.TERMINAL
  );
  if (!isTerminalGroup) return null;
  return <TerminalHeaderActionsInner />;
}

function TerminalHeaderActionsInner() {
  const { activeWorktreeId } = useWorktree();
  const { projectId } = useProject();
  // Use worktree ID if available, otherwise fall back to project ID for local terminal
  const workspaceKey = activeWorktreeId || projectId || 'default';

  const addSession = useTerminalStore((s) => s.addSession);
  const [selectedShell, setSelectedShell] = useState<string>('');

  const handleCreateTab = useCallback(() => {
    const tabId = generateTerminalTabId();
    addSession(workspaceKey, tabId, selectedShell || undefined);
  }, [workspaceKey, addSession, selectedShell]);

  return (
    <div className="flex items-center gap-0.5 h-full px-1">
      <select
        value={selectedShell}
        onChange={(e) => setSelectedShell(e.target.value)}
        className="h-6 text-[11px] bg-transparent border border-border rounded px-1 text-muted-foreground hover:text-foreground focus:outline-none cursor-pointer"
        title="Shell type"
      >
        {SHELL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <button
        onClick={handleCreateTab}
        className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title="New terminal"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
```

**Step 2: Update DockviewTerminalPanel to use WorktreeContext**

Replace `useParams` with `useWorktree` + `useProject`. The key change: `workspaceId` is now `activeWorktreeId || projectId || 'default'`, so terminal always has a valid workspace key.

In `DockviewTerminalPanel.tsx`, change lines 2-3 and 20-22:

```tsx
// Replace:
import { useParams } from 'react-router-dom';
// With:
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProject } from '@/contexts/ProjectContext';

// Replace:
const { attemptId } = useParams<{ attemptId?: string }>();
const workspaceId = attemptId;
// With:
const { activeWorktreeId } = useWorktree();
const { projectId } = useProject();
const workspaceId = activeWorktreeId || projectId || undefined;
```

Remove the no-workspace placeholder block (lines 64-77), since `workspaceId` will now always be defined when a project is selected. Replace it with a simple check:

```tsx
if (!workspaceId) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background text-sm text-muted-foreground" data-panel="terminal">
      <p>选择一个项目以打开终端</p>
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/layout/panels/TerminalHeaderActions.tsx frontend/src/components/panels/DockviewTerminalPanel.tsx
git commit -m "fix: terminal uses WorktreeContext, + button always enabled"
```

---

## Task 3: Fix Git Panel — Real Git Status Display

**Goal:** Replace placeholder Git panel with real data from `useWorkspaceBranchStatus`.

**Files:**
- Modify: `frontend/src/components/panels/DockviewGitPanel.tsx:1-22` (full rewrite)

**Step 1: Rewrite DockviewGitPanel**

```tsx
// frontend/src/components/panels/DockviewGitPanel.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { GitBranch, ArrowUp, ArrowDown, AlertTriangle, FileWarning, Circle } from 'lucide-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';

function DockviewGitPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { data: branchStatus, isLoading } = useWorkspaceBranchStatus(activeWorktreeId ?? undefined);

  if (!activeWorktreeId) {
    return (
      <div className="h-full w-full bg-background flex items-center justify-center text-muted-foreground text-sm" data-panel="git">
        <div className="text-center space-y-2">
          <GitBranch className="h-8 w-8 opacity-40 mx-auto" />
          <p className="font-medium">Git 管理器</p>
          <p className="text-xs">选择一个工作区以查看 Git 状态</p>
        </div>
      </div>
    );
  }

  if (isLoading || !branchStatus) {
    return (
      <div className="h-full w-full bg-background flex items-center justify-center text-muted-foreground text-xs" data-panel="git">
        加载 Git 状态...
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background p-3 text-sm" data-panel="git">
      {branchStatus.map((repo) => (
        <div key={repo.repo_id} className="space-y-3">
          {/* Repo name (only show if multiple repos) */}
          {branchStatus.length > 1 && (
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {repo.repo_name}
            </div>
          )}

          {/* Branch info */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <Circle className="h-2 w-2 fill-blue-500 text-blue-500" />
              <span className="text-muted-foreground">目标分支</span>
              <span className="font-mono font-medium text-foreground">{repo.target_branch_name}</span>
            </div>
          </div>

          {/* Ahead/Behind counts */}
          <div className="flex items-center gap-3 text-xs">
            {(repo.commits_ahead ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-green-600">
                <ArrowUp className="h-3 w-3" />
                {repo.commits_ahead} ahead
              </span>
            )}
            {(repo.commits_behind ?? 0) > 0 && (
              <span className="flex items-center gap-1 text-orange-500">
                <ArrowDown className="h-3 w-3" />
                {repo.commits_behind} behind
              </span>
            )}
            {(repo.commits_ahead ?? 0) === 0 && (repo.commits_behind ?? 0) === 0 && (
              <span className="text-muted-foreground">分支已同步</span>
            )}
          </div>

          {/* Uncommitted changes */}
          {repo.has_uncommitted_changes && (
            <div className="flex items-center gap-2 text-xs text-yellow-600">
              <FileWarning className="h-3 w-3" />
              <span>{repo.uncommitted_count ?? 0} 个未提交更改, {repo.untracked_count ?? 0} 个未跟踪</span>
            </div>
          )}

          {/* Conflict state */}
          {repo.is_rebase_in_progress && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              <span>Rebase 进行中 — {repo.conflicted_files.length} 个冲突文件</span>
            </div>
          )}

          {/* Conflicted files list */}
          {repo.conflicted_files.length > 0 && (
            <div className="pl-4 space-y-0.5">
              {repo.conflicted_files.map((f) => (
                <div key={f} className="text-xs font-mono text-destructive truncate">{f}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default DockviewGitPanel;
```

**Step 2: Commit**

```bash
git add frontend/src/components/panels/DockviewGitPanel.tsx
git commit -m "fix: git panel shows real branch status from WorktreeContext"
```

---

## Task 4: Worktree Selector — Replace Project Selector in Toolbar

**Goal:** Replace the project dropdown in Toolbar with a worktree selector that lists all active workspaces for the current project. Clicking a worktree navigates to the corresponding attempt URL and updates `WorktreeContext`.

**Files:**
- Create: `frontend/src/components/layout/WorktreeSelector.tsx`
- Modify: `frontend/src/components/layout/Toolbar.tsx:220-258` (replace project selector)
- Create: `frontend/src/hooks/useProjectWorktrees.ts`

**Step 1: Create useProjectWorktrees hook**

```tsx
// frontend/src/hooks/useProjectWorktrees.ts
import { useQuery } from '@tanstack/react-query';
import { attemptsApi, tasksApi } from '@/lib/api';
import type { Workspace, TaskWithAttemptStatus } from 'shared/types';
import { useProjectTasks } from './useProjectTasks';

export interface WorktreeInfo {
  workspace: Workspace;
  task: TaskWithAttemptStatus | null;
}

/**
 * Returns all active (non-archived) workspaces for the current project,
 * enriched with their parent task info.
 */
export function useProjectWorktrees(projectId: string | undefined) {
  const { tasks, tasksById } = useProjectTasks(projectId ?? '');

  // Collect all workspace IDs by iterating through tasks that have attempts
  const activeTaskIds = tasks
    .filter((t) => t.has_in_progress_attempt || t.status === 'inprogress' || t.status === 'inreview')
    .map((t) => t.id);

  const { data: worktrees, isLoading } = useQuery({
    queryKey: ['projectWorktrees', projectId, activeTaskIds],
    queryFn: async () => {
      if (!activeTaskIds.length) return [];
      const results = await Promise.all(
        activeTaskIds.map((taskId) => attemptsApi.getAll(taskId))
      );
      return results.flat().filter((w) => !w.archived);
    },
    enabled: !!projectId && activeTaskIds.length > 0,
  });

  const enriched: WorktreeInfo[] = (worktrees ?? []).map((ws) => ({
    workspace: ws,
    task: tasksById[ws.task_id] ?? null,
  }));

  return { worktrees: enriched, isLoading };
}
```

**Step 2: Create WorktreeSelector component**

```tsx
// frontend/src/components/layout/WorktreeSelector.tsx
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, GitBranch } from 'lucide-react';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { paths } from '@/lib/paths';

export function WorktreeSelector() {
  const navigate = useNavigate();
  const { projectId, project } = useProject();
  const { activeWorktreeId } = useWorktree();
  const { worktrees } = useProjectWorktrees(projectId);

  const activeWorktree = worktrees.find((w) => w.workspace.id === activeWorktreeId);

  const handleSelect = useCallback(
    (worktreeInfo: typeof worktrees[number]) => {
      if (!projectId) return;
      navigate(paths.attempt(projectId, worktreeInfo.workspace.task_id, worktreeInfo.workspace.id));
    },
    [projectId, navigate]
  );

  const handleGoToKanban = useCallback(() => {
    if (!projectId) return;
    navigate(paths.projectTasks(projectId));
  }, [projectId, navigate]);

  // Display label
  const displayLabel = activeWorktree
    ? activeWorktree.workspace.branch || activeWorktree.task?.title || 'Workspace'
    : project?.name ?? '选择工作区';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="ml-2 h-7 w-36 justify-between gap-1 px-2 sm:w-48 text-xs"
          aria-label="Select worktree"
        >
          <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{displayLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {/* Kanban overview link */}
        <DropdownMenuItem onSelect={handleGoToKanban} className={!activeWorktreeId ? 'bg-accent' : ''}>
          <span className="text-xs">看板总览</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />

        {/* Worktree list */}
        {worktrees.length > 0 ? (
          worktrees.map((wt) => (
            <DropdownMenuItem
              key={wt.workspace.id}
              onSelect={() => handleSelect(wt)}
              className={wt.workspace.id === activeWorktreeId ? 'bg-accent' : ''}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-xs font-mono truncate">{wt.workspace.branch}</span>
                {wt.task && (
                  <span className="text-[10px] text-muted-foreground truncate">{wt.task.title}</span>
                )}
              </div>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>
            <span className="text-xs text-muted-foreground">暂无活跃工作区</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

**Step 3: Replace project selector in Toolbar**

In `Toolbar.tsx`, replace the project dropdown (lines 225-258) with `<WorktreeSelector />`:

```tsx
// Replace the entire DropdownMenu block for project selection with:
import { WorktreeSelector } from '@/components/layout/WorktreeSelector';

// In the JSX, replace:
//   <DropdownMenu>...(project selector)...</DropdownMenu>
// With:
<WorktreeSelector />
```

Keep the `Logo` link before it. Remove `useProjects` import and `handleProjectSwitch` if no longer needed.

**Step 4: Commit**

```bash
git add frontend/src/hooks/useProjectWorktrees.ts frontend/src/components/layout/WorktreeSelector.tsx frontend/src/components/layout/Toolbar.tsx
git commit -m "feat: replace project selector with worktree selector in toolbar"
```

---

## Task 5: Wire Live Data into DockviewKanbanPanel

**Goal:** Replace the static 4-column placeholder with real task data from `useProjectTasks`. Cards are clickable (navigate to attempt), and support drag-to-change-status.

**Files:**
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx:1-30` (full rewrite)

**Step 1: Rewrite DockviewKanbanPanel with live data**

```tsx
// frontend/src/components/panels/DockviewKanbanPanel.tsx
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IDockviewPanelProps } from 'dockview-react';
import { DndContext, type DragEndEvent, DragOverlay, closestCorners } from '@dnd-kit/core';
import { useProject } from '@/contexts/ProjectContext';
import { useProjectTasks } from '@/hooks/useProjectTasks';
import { tasksApi } from '@/lib/api';
import { paths } from '@/lib/paths';
import { openTaskForm } from '@/lib/openTaskForm';
import type { TaskWithAttemptStatus, TaskStatus } from 'shared/types';

const KANBAN_COLUMNS = [
  { key: 'todo' as TaskStatus, label: 'TODO', dotColor: '#EF4444' },
  { key: 'inprogress' as TaskStatus, label: 'IN PROGRESS', dotColor: '#22C55E' },
  { key: 'inreview' as TaskStatus, label: 'IN REVIEW', dotColor: '#EAB308' },
  { key: 'done' as TaskStatus, label: 'DONE', dotColor: '#9CA3AF' },
] as const;

function DockviewKanbanPanel(_props: IDockviewPanelProps) {
  const { projectId } = useProject();
  const { tasksByStatus, tasksById } = useProjectTasks(projectId ?? '');
  const navigate = useNavigate();

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !active.data.current) return;
    const draggedTaskId = active.id as string;
    const newStatus = over.id as TaskStatus;
    const task = tasksById[draggedTaskId];
    if (!task || task.status === newStatus) return;
    await tasksApi.update(draggedTaskId, {
      title: task.title,
      description: task.description,
      status: newStatus,
      parent_workspace_id: task.parent_workspace_id,
      image_ids: null,
    });
  }, [tasksById]);

  const handleTaskClick = useCallback((task: TaskWithAttemptStatus) => {
    if (!projectId) return;
    navigate(`${paths.task(projectId, task.id)}/attempts/latest`);
  }, [projectId, navigate]);

  const handleCreateTask = useCallback((status?: TaskStatus) => {
    if (!projectId) return;
    openTaskForm({ mode: 'create', projectId, defaultStatus: status });
  }, [projectId]);

  return (
    <div className="h-full w-full overflow-auto bg-background p-3" data-panel="kanban">
      <DndContext collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 h-full min-w-0">
          {KANBAN_COLUMNS.map((col) => {
            const tasks = tasksByStatus[col.key] ?? [];
            return (
              <KanbanColumn
                key={col.key}
                columnKey={col.key}
                label={col.label}
                dotColor={col.dotColor}
                tasks={tasks}
                onTaskClick={handleTaskClick}
                onCreateTask={() => handleCreateTask(col.key)}
              />
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function KanbanColumn({
  columnKey,
  label,
  dotColor,
  tasks,
  onTaskClick,
  onCreateTask,
}: {
  columnKey: TaskStatus;
  label: string;
  dotColor: string;
  tasks: TaskWithAttemptStatus[];
  onTaskClick: (task: TaskWithAttemptStatus) => void;
  onCreateTask: () => void;
}) {
  return (
    <div className="flex-1 min-w-[160px] flex flex-col rounded-lg bg-muted/30 border border-border">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
        <span className="text-xs font-semibold text-foreground tracking-wide">{label}</span>
        <span className="text-xs text-muted-foreground ml-auto">{tasks.length}</span>
        <button
          onClick={onCreateTask}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="新建任务"
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>
      <div className="flex-1 p-2 space-y-1.5 overflow-auto">
        {tasks.map((task) => (
          <button
            key={task.id}
            onClick={() => onTaskClick(task)}
            className="w-full text-left p-2 rounded border border-border bg-background hover:bg-accent/50 transition-colors"
          >
            <div className="text-xs font-medium text-foreground line-clamp-2">{task.title}</div>
            {task.executor && (
              <div className="text-[10px] text-muted-foreground mt-1 truncate">{task.executor}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default DockviewKanbanPanel;
```

Note: Full @dnd-kit drag-and-drop with `useSortable`/`useDroppable` can be added as a follow-up. This initial version supports basic click-to-navigate and a simplified `onDragEnd` handler.

**Step 2: Commit**

```bash
git add frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "feat: kanban panel shows live task data with click-to-navigate"
```

---

## Task 6: Right Panel Rework — Branch Header + Conversation + Mini Sidebar

**Goal:** Replace `<Outlet/>` in the right panel with a purpose-built component: branch info header at top, AI conversation in center, mini sidebar on the right edge.

**Files:**
- Create: `frontend/src/components/layout/RightPanelContent.tsx`
- Create: `frontend/src/components/layout/BranchInfoHeader.tsx`
- Create: `frontend/src/components/layout/RightPanelSidebar.tsx`
- Modify: `frontend/src/components/layout/IDEWorkspaceRoute.tsx:1-29` (use new right panel)

**Step 1: Create BranchInfoHeader**

```tsx
// frontend/src/components/layout/BranchInfoHeader.tsx
import { useMemo, useState, useCallback } from 'react';
import { GitBranch, ArrowUp, ArrowDown, AlertTriangle, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useWorkspaceBranchStatus } from '@/hooks/useWorkspaceBranchStatus';
import { attemptsApi } from '@/lib/api';
import type { RepoBranchStatus } from 'shared/types';

export function BranchInfoHeader() {
  const { activeWorktreeId } = useWorktree();
  const { data: branchStatus } = useWorkspaceBranchStatus(activeWorktreeId ?? undefined);

  if (!activeWorktreeId || !branchStatus?.length) return null;

  // Use first repo for single-repo display
  const repo = branchStatus[0];

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-2 space-y-1">
      {/* Target branch row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">目标</span>
        <TargetBranchDropdown
          repo={repo}
          worktreeId={activeWorktreeId}
        />
        <span className="text-muted-foreground">→</span>
        <span className="font-mono text-foreground truncate">HEAD</span>
      </div>

      {/* Status row: ahead/behind + rebase buttons */}
      <div className="flex items-center gap-2 text-xs">
        {(repo.commits_ahead ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-green-600">
            <ArrowUp className="h-2.5 w-2.5" />
            {repo.commits_ahead}
          </span>
        )}
        {(repo.commits_behind ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-orange-500">
            <ArrowDown className="h-2.5 w-2.5" />
            {repo.commits_behind}
          </span>
        )}
        {repo.is_rebase_in_progress && (
          <span className="flex items-center gap-0.5 text-destructive">
            <AlertTriangle className="h-2.5 w-2.5" />
            冲突
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <RebaseButton worktreeId={activeWorktreeId} repoId={repo.repo_id} />
          <RebaseBackButton worktreeId={activeWorktreeId} repoId={repo.repo_id} />
        </div>
      </div>
    </div>
  );
}

function TargetBranchDropdown({ repo, worktreeId }: { repo: RepoBranchStatus; worktreeId: string }) {
  const handleChangeTarget = useCallback(async () => {
    // TODO: open branch picker dialog, then call:
    // attemptsApi.change_target_branch(worktreeId, { repo_id: repo.repo_id, new_target_branch: ... })
  }, [worktreeId, repo.repo_id]);

  const handleRebase = useCallback(async () => {
    await attemptsApi.rebase(worktreeId, { repo_id: repo.repo_id });
  }, [worktreeId, repo.repo_id]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 font-mono text-foreground hover:text-primary transition-colors">
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-24">{repo.target_branch_name}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={handleChangeTarget}>
          切换目标分支
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRebase}>
          Rebase
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RebaseButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const handleRebase = useCallback(async () => {
    setLoading(true);
    try {
      await attemptsApi.rebase(worktreeId, { repo_id: repoId });
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId]);

  return (
    <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebase} disabled={loading}>
      Rebase
    </Button>
  );
}

function RebaseBackButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const handleRebaseBack = useCallback(async () => {
    setLoading(true);
    try {
      await attemptsApi.rebaseBack(worktreeId, repoId);
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId]);

  return (
    <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebaseBack} disabled={loading}>
      Rebase Back
    </Button>
  );
}
```

**Step 2: Create RightPanelSidebar**

```tsx
// frontend/src/components/layout/RightPanelSidebar.tsx
import { Terminal, FileText, GitCompareArrows, StickyNote } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Mini sidebar on the right edge of the right panel.
 * Buttons open dockview center-area tabs.
 */
export function RightPanelSidebar() {
  const { openNewTerminal, openDiffPreview } = usePanelActionsContext();

  const buttons = [
    { icon: Terminal, label: '启动终端', onClick: openNewTerminal },
    { icon: FileText, label: '查看 Logs', onClick: () => { /* TODO: open logs tab */ } },
    { icon: GitCompareArrows, label: '查看 Git Diff', onClick: openDiffPreview },
    { icon: StickyNote, label: '编辑笔记', onClick: () => { /* TODO: open notes tab */ } },
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="shrink-0 w-8 border-l border-border bg-secondary/50 flex flex-col items-center pt-2 gap-1">
        {buttons.map((btn) => {
          const Icon = btn.icon;
          return (
            <Tooltip key={btn.label}>
              <TooltipTrigger asChild>
                <button
                  onClick={btn.onClick}
                  className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{btn.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
```

**Step 3: Create RightPanelContent**

This is the main right panel component. It renders:
- `BranchInfoHeader` at top
- Conversation area in center (from `ProjectTasks` via `<Outlet/>`)
- `RightPanelSidebar` on right edge

```tsx
// frontend/src/components/layout/RightPanelContent.tsx
import { Outlet } from 'react-router-dom';
import { BranchInfoHeader } from '@/components/layout/BranchInfoHeader';
import { RightPanelSidebar } from '@/components/layout/RightPanelSidebar';

/**
 * Right panel content layout:
 * ┌────────────────────────┬───┐
 * │  BranchInfoHeader      │ S │
 * ├────────────────────────│ i │
 * │                        │ d │
 * │  Conversation / Outlet │ e │
 * │  (ProjectTasks)        │ b │
 * │                        │ a │
 * │                        │ r │
 * └────────────────────────┴───┘
 */
export function RightPanelContent() {
  return (
    <div className="h-full flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <BranchInfoHeader />
        <div className="flex-1 min-h-0 overflow-auto">
          <Outlet />
        </div>
      </div>
      <RightPanelSidebar />
    </div>
  );
}
```

**Step 4: Update IDEWorkspaceRoute to use RightPanelContent**

```tsx
// frontend/src/components/layout/IDEWorkspaceRoute.tsx
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout';
import { Toolbar } from '@/components/layout/Toolbar';
import { RightPanelContent } from '@/components/layout/RightPanelContent';

export function IDEWorkspaceRoute() {
  return (
    <div className="flex flex-col h-screen">
      <WorkspaceLayout
        toolbarContent={<Toolbar />}
        rightPanelContent={<RightPanelContent />}
      />
    </div>
  );
}
```

**Step 5: Commit**

```bash
git add frontend/src/components/layout/BranchInfoHeader.tsx frontend/src/components/layout/RightPanelSidebar.tsx frontend/src/components/layout/RightPanelContent.tsx frontend/src/components/layout/IDEWorkspaceRoute.tsx
git commit -m "feat: right panel with branch header, conversation area, and mini sidebar"
```

---

## Task 7: Post-Task-Creation Flow — Navigate to Right Panel Conversation

**Goal:** After creating a task (with or without autoStart), navigate to the attempt URL so the right panel automatically shows the conversation/logs area.

**Files:**
- Modify: `frontend/src/hooks/useTaskMutations.ts:26-66` (ensure navigation targets)
- Modify: `frontend/src/pages/ProjectTasks.tsx` (slim down — remove kanban rendering since it's now in dockview)

**Step 1: Verify useTaskMutations navigation**

The existing `useTaskMutations.ts` already navigates to `${paths.task(projectId, createdTask.id)}/attempts/latest` on success. This is correct — the `latest` redirect in `ProjectTasks.tsx` will resolve to the actual attempt ID, which then:
1. Updates the URL with the `attemptId` param
2. `IDEWorkspaceRoute` syncs this to `WorktreeContext`
3. Right panel shows `BranchInfoHeader` + conversation

**No changes needed** to `useTaskMutations.ts` — the flow already works.

**Step 2: Slim down ProjectTasks.tsx for right-panel rendering**

`ProjectTasks.tsx` currently renders its own Kanban + TasksLayout. Since the Kanban is now handled by `DockviewKanbanPanel`, and the right panel structure is handled by `RightPanelContent`, we need to modify `ProjectTasks.tsx` to only render the **conversation content** (TaskAttemptPanel or TaskPanel) without the Kanban wrapper.

The key change: When rendered as `<Outlet/>` inside `RightPanelContent`, `ProjectTasks` should only return the attempt/task panel content, not the full `TasksLayout` with kanban.

In `ProjectTasks.tsx`, modify the return JSX (around line 879-916):

Replace the final return block that wraps everything in `<TasksLayout>` with just the right-panel content:

```tsx
// Instead of:
// return <GitOperationsProvider>...<TasksLayout kanban={kanbanContent} attempt={attemptContent} .../>

// Return only the conversation content for the right panel:
return (
  <GitOperationsProvider attemptId={attempt?.id}>
    <ClickedElementsProvider attempt={attempt}>
      <ReviewProvider attemptId={attempt?.id}>
        <ExecutionProcessesProvider attemptId={attempt?.id} sessionId={attempt?.session?.id}>
          <div className="h-full flex flex-col">
            {attemptContent}
          </div>
        </ExecutionProcessesProvider>
      </ReviewProvider>
    </ClickedElementsProvider>
  </GitOperationsProvider>
);
```

Keep all the data-fetching, navigation, and `latest` resolution logic. Remove the kanban-related JSX and the `TasksLayout` import.

**Step 3: Commit**

```bash
git add frontend/src/pages/ProjectTasks.tsx
git commit -m "refactor: ProjectTasks renders only conversation content for right panel"
```

---

## Task 8: Register Logs & Notes Panels in Dockview

**Goal:** Add "Logs" and "Notes" as dockview panel types so the mini sidebar buttons can open them as center-area tabs.

**Files:**
- Create: `frontend/src/components/panels/DockviewLogsPanel.tsx`
- Create: `frontend/src/components/panels/DockviewNotesPanel.tsx`
- Modify: `frontend/src/stores/useLayoutStore.ts` (add LOGS, NOTES to PANEL_IDS)
- Modify: `frontend/src/components/layout/panels/PanelRegistry.tsx` (register new panels)
- Modify: `frontend/src/contexts/PanelActionsContext.tsx` (add openLogs, openNotes methods)
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx` (wire up buttons)

**Step 1: Add PANEL_IDS**

In `useLayoutStore.ts`, add to PANEL_IDS:
```tsx
LOGS: 'logs',
NOTES: 'notes',
```
Bump persist version to 4.

**Step 2: Create DockviewLogsPanel**

```tsx
// frontend/src/components/panels/DockviewLogsPanel.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { ScrollText } from 'lucide-react';

function DockviewLogsPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();

  if (!activeWorktreeId) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background text-muted-foreground text-sm">
        <div className="text-center space-y-2">
          <ScrollText className="h-8 w-8 opacity-40 mx-auto" />
          <p>选择一个工作区以查看日志</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background p-3 text-xs font-mono" data-panel="logs">
      <p className="text-muted-foreground">Logs for workspace {activeWorktreeId}</p>
      {/* TODO: integrate with VirtualizedList / EntriesProvider from TaskAttemptPanel */}
    </div>
  );
}

export default DockviewLogsPanel;
```

**Step 3: Create DockviewNotesPanel**

```tsx
// frontend/src/components/panels/DockviewNotesPanel.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { StickyNote } from 'lucide-react';

function DockviewNotesPanel(_props: IDockviewPanelProps) {
  return (
    <div className="h-full w-full overflow-auto bg-background p-3" data-panel="notes">
      <div className="flex items-center gap-2 mb-3">
        <StickyNote className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">笔记</span>
      </div>
      <textarea
        className="w-full h-[calc(100%-2rem)] resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        placeholder="在此处编写笔记..."
      />
    </div>
  );
}

export default DockviewNotesPanel;
```

**Step 4: Register in PanelRegistry**

Add lazy imports and entries to `PANEL_COMPONENT_MAP` and `PANEL_META`.

**Step 5: Add openLogs/openNotes to PanelActionsContext**

Add to the `PanelActions` interface and implementation:
```tsx
openLogs: () => openOrFocusPanel(PANEL_IDS.LOGS, 'Logs'),
openNotes: () => openOrFocusPanel(PANEL_IDS.NOTES, '笔记'),
```

**Step 6: Wire up RightPanelSidebar buttons**

Replace the TODO callbacks with `openLogs` and `openNotes` from context.

**Step 7: Commit**

```bash
git add frontend/src/components/panels/DockviewLogsPanel.tsx frontend/src/components/panels/DockviewNotesPanel.tsx frontend/src/stores/useLayoutStore.ts frontend/src/components/layout/panels/PanelRegistry.tsx frontend/src/contexts/PanelActionsContext.tsx frontend/src/components/layout/RightPanelSidebar.tsx
git commit -m "feat: add Logs and Notes dockview panels with sidebar integration"
```

---

## Task 9: Kanban Card Click → Worktree Switch

**Goal:** Clicking a Kanban task card should navigate to that task's worktree, which in turn updates `WorktreeContext` and shows the conversation in the right panel.

**Files:**
- Already handled in Task 5 — `DockviewKanbanPanel.handleTaskClick` navigates to `paths.task(projectId, task.id)/attempts/latest`, which triggers the URL param change → `WorktreeContext` update.

No additional code needed. This is a verification step.

**Step 1: Verify end-to-end flow**

1. User clicks a task card in Kanban
2. Navigation to `/local-projects/{pid}/tasks/{tid}/attempts/latest`
3. `ProjectTasks.tsx` resolves `latest` to actual attempt ID
4. Redirect to `/local-projects/{pid}/tasks/{tid}/attempts/{aid}`
5. `IDEWorkspaceRoute` reads `attemptId` param → updates `WorktreeContext`
6. Right panel shows `BranchInfoHeader` with branch info
7. Right panel shows conversation/logs
8. Terminal and Git panels update to use the new worktree
9. Toolbar `WorktreeSelector` highlights the active worktree

**Step 2: Commit** (if any adjustments needed)

---

## Task 10: TypeScript Verification & Cleanup

**Goal:** Ensure all code compiles without errors. Remove dead imports. Clean up unused code.

**Files:**
- Verify: `npx tsc --noEmit` from `frontend/`
- Cleanup any unused imports in modified files

**Step 1: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Fix any type errors that arise.

**Step 2: Final commit**

```bash
git add -A
git commit -m "chore: fix type errors and cleanup unused imports"
```

---

## Summary

| Task | Description | New Files | Modified Files |
|------|-------------|-----------|---------------|
| 1 | WorktreeContext | WorktreeContext.tsx | WorkspaceLayout.tsx |
| 2 | Fix Terminal | — | TerminalHeaderActions.tsx, DockviewTerminalPanel.tsx |
| 3 | Fix Git Panel | — | DockviewGitPanel.tsx |
| 4 | Worktree Selector | WorktreeSelector.tsx, useProjectWorktrees.ts | Toolbar.tsx |
| 5 | Live Kanban Data | — | DockviewKanbanPanel.tsx |
| 6 | Right Panel Rework | RightPanelContent.tsx, BranchInfoHeader.tsx, RightPanelSidebar.tsx | IDEWorkspaceRoute.tsx |
| 7 | Task Creation Flow | — | ProjectTasks.tsx |
| 8 | Logs & Notes Panels | DockviewLogsPanel.tsx, DockviewNotesPanel.tsx | useLayoutStore.ts, PanelRegistry.tsx, PanelActionsContext.tsx, RightPanelSidebar.tsx |
| 9 | Kanban→Worktree | — | (verification only) |
| 10 | TypeScript Verify | — | (cleanup) |
