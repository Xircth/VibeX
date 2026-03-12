# UI Fixes Batch 5 — Diff Review, Terminal Constraint, Git Commit Graph

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the diff review panel to show full branch diff content, constrain terminal to center/bottom area only, and replace the simple commit list with an interactive commit graph in the Git manager.

**Architecture:** 3 tasks with increasing complexity. Task 1 (diff review) rewires existing components. Task 2 (terminal constraint) adds dockview drop guard. Task 3 (commit graph) requires Rust backend extension + new frontend component.

**Tech Stack:** React, TypeScript, TailwindCSS, Dockview, git2 (Rust), Tauri IPC, @git-diff-view/react, SVG

---

## Task 1: Fix "查看 Git Diff" to Show Full Branch Diff Review

### Problem
Clicking "查看 Git Diff" in the right sidebar opens `DockviewDiffPanel` (Monaco single-file diff editor), which requires the user to manually double-click a file in the file tree. The panel shows nothing by default.

### Root Cause
`PanelRegistry.tsx` maps `PANEL_IDS.DIFFS` → `DockviewDiffPanel` (Monaco-based, needs `diffFilePath` from file tree store). The full-featured `DiffsPanel` (which uses `useDiffStream` + `DiffCard` + `@git-diff-view/react`) is never registered in dockview.

### Solution
Create a new dockview wrapper `DockviewDiffsReviewPanel` that:
1. Uses `useWorktree()` to get `activeWorktreeId`
2. Uses `useAttempt(activeWorktreeId)` to get the `Workspace` object
3. Renders `DiffsPanel` with the workspace as `selectedAttempt`
4. Adds a right-side file directory (Changes sidebar) for navigation

**Layout within the panel (single tab):**
```
┌──────────────────────────────┬──────────────┐
│  Diff Content (scrollable)   │  Changes     │
│  ┌─────────────────────┐     │  Directory   │
│  │ file1.tsx  +10 -5   │     │  ┌────────┐  │
│  │ (inline/split diff) │     │  │file1.tsx│  │
│  └─────────────────────┘     │  │file2.rs │  │
│  ┌─────────────────────┐     │  │file3.md │  │
│  │ file2.rs   +3 -1    │     │  └────────┘  │
│  │ (inline/split diff) │     │              │
│  └─────────────────────┘     │  Git Info:   │
│  ...                         │  3 files     │
│                              │  +13 -6      │
└──────────────────────────────┴──────────────┘
```

### Files to Modify/Create

**Create:** `frontend/src/components/panels/DockviewDiffsReviewPanel.tsx`

```tsx
import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { GitCompare, AlignLeft, Columns2, FileText, ChevronDown, ChevronRight, ChevronsUp, ChevronsDown } from 'lucide-react';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useAttempt } from '@/hooks/useAttempt';
import { useDiffStream } from '@/hooks/useDiffStream';
import { useDiffSummary } from '@/hooks/useDiffSummary';
import DiffCard from '@/components/DiffCard';
import DiffViewSwitch from '@/components/DiffViewSwitch';
import type { Diff, DiffChangeKind } from 'shared/types';

// --- Collapse logic (mirrored from DiffsPanel) ---
type DiffCollapseDefaults = Record<DiffChangeKind, boolean>;

const DEFAULT_COLLAPSE: DiffCollapseDefaults = {
  added: false,
  deleted: true,
  modified: false,
  renamed: true,
  copied: true,
  permissionChange: true,
};
const COLLAPSE_MAX_LINES = 200;

const exceedsMax = (d: Diff, max: number) =>
  d.additions != null || d.deletions != null
    ? (d.additions ?? 0) + (d.deletions ?? 0) > max
    : true;

const getDiffId = (diff: Diff, index: number) =>
  diff.newPath || diff.oldPath || String(index);

// --- Change badge color ---
const changeBadge: Record<DiffChangeKind, { label: string; color: string }> = {
  added: { label: 'A', color: 'text-green-600 bg-green-100' },
  deleted: { label: 'D', color: 'text-red-600 bg-red-100' },
  modified: { label: 'M', color: 'text-blue-600 bg-blue-100' },
  renamed: { label: 'R', color: 'text-yellow-600 bg-yellow-100' },
  copied: { label: 'C', color: 'text-purple-600 bg-purple-100' },
  permissionChange: { label: 'P', color: 'text-gray-600 bg-gray-100' },
};

function DockviewDiffsReviewPanel(_props: IDockviewPanelProps) {
  const { activeWorktreeId } = useWorktree();
  const { data: workspace } = useAttempt(activeWorktreeId ?? undefined);
  const attemptId = workspace?.id ?? null;

  const { diffs, error } = useDiffStream(attemptId, true);
  const { fileCount, added, deleted } = useDiffSummary(attemptId);

  // Collapse state
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [processedIds, setProcessedIds] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Refs for scroll-to-file
  const diffRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-collapse large/deleted diffs
  useEffect(() => {
    if (diffs.length === 0) return;
    const newDiffs = diffs
      .map((d, i) => ({ diff: d, index: i, id: getDiffId(d, i) }))
      .filter(({ id }) => !processedIds.has(id));

    if (newDiffs.length === 0) return;

    const newIds = newDiffs.map(({ id }) => id);
    const toCollapse = newDiffs
      .filter(({ diff }) => DEFAULT_COLLAPSE[diff.change] || exceedsMax(diff, COLLAPSE_MAX_LINES))
      .map(({ id }) => id);

    setProcessedIds(prev => new Set([...prev, ...newIds]));
    if (toCollapse.length > 0) {
      setCollapsedIds(prev => new Set([...prev, ...toCollapse]));
    }
  }, [diffs, processedIds]);

  const ids = useMemo(() => diffs.map((d, i) => getDiffId(d, i)), [diffs]);

  const toggle = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const allCollapsed = collapsedIds.size === diffs.length && diffs.length > 0;

  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(ids));
  }, [allCollapsed, ids]);

  // Scroll to file when clicked in sidebar
  const scrollToFile = useCallback((id: string) => {
    const el = diffRefs.current.get(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Expand if collapsed
      setCollapsedIds(prev => {
        if (prev.has(id)) {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }
        return prev;
      });
    }
  }, []);

  // Empty state
  if (!activeWorktreeId) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm" data-panel="diffs">
        <div className="text-center space-y-2">
          <GitCompare className="h-8 w-8 opacity-40 mx-auto" />
          <p className="font-medium">Diff Review</p>
          <p className="text-xs">选择一个工作区以查看变更</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 m-4">
        <div className="text-red-800 text-sm">{`加载差异失败：${error}`}</div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex" data-panel="diffs">
      {/* Left: Diff content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header toolbar */}
        {diffs.length > 0 && (
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/30">
            <span className="text-xs text-muted-foreground">
              {fileCount} 个文件已更改{' '}
              <span className="text-green-600">+{added}</span>{' '}
              <span className="text-red-600">-{deleted}</span>
            </span>
            <div className="ml-auto flex items-center gap-1">
              <DiffViewSwitch />
              <button
                onClick={handleCollapseAll}
                className="p-1 rounded hover:bg-accent text-muted-foreground"
                title={allCollapsed ? '展开所有' : '折叠所有'}
              >
                {allCollapsed ? <ChevronsDown className="h-3.5 w-3.5" /> : <ChevronsUp className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        )}

        {/* Diff cards */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3">
          {diffs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              尚未进行任何更改
            </div>
          ) : (
            diffs.map((diff, idx) => {
              const id = getDiffId(diff, idx);
              return (
                <div
                  key={id}
                  ref={(el) => { if (el) diffRefs.current.set(id, el); else diffRefs.current.delete(id); }}
                >
                  <DiffCard
                    diff={diff}
                    expanded={!collapsedIds.has(id)}
                    onToggle={() => toggle(id)}
                    selectedAttempt={workspace ?? null}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: Changes directory sidebar */}
      {diffs.length > 0 && (
        <div className={`shrink-0 border-l border-border bg-muted/20 flex flex-col ${sidebarCollapsed ? 'w-8' : 'w-56'}`}>
          {sidebarCollapsed ? (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="h-full flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="展开文件目录"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground">Changes</span>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                  title="收起"
                >
                  <ChevronDown className="h-3 w-3 rotate-90" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {diffs.map((diff, idx) => {
                  const id = getDiffId(diff, idx);
                  const fileName = (diff.newPath || diff.oldPath || '').split(/[/\\]/).pop() || id;
                  const dirPath = (diff.newPath || diff.oldPath || '').split(/[/\\]/).slice(0, -1).join('/');
                  const badge = changeBadge[diff.change] || changeBadge.modified;
                  return (
                    <button
                      key={id}
                      onClick={() => scrollToFile(id)}
                      className="w-full text-left px-2 py-0.5 hover:bg-accent/50 flex items-center gap-1.5 group"
                      title={diff.newPath || diff.oldPath || ''}
                    >
                      <span className={`shrink-0 text-[10px] font-mono font-bold w-4 h-4 flex items-center justify-center rounded ${badge.color}`}>
                        {badge.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs truncate text-foreground">{fileName}</div>
                        {dirPath && (
                          <div className="text-[10px] truncate text-muted-foreground">{dirPath}</div>
                        )}
                      </div>
                      {(diff.additions != null || diff.deletions != null) && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          <span className="text-green-600">+{diff.additions ?? 0}</span>{' '}
                          <span className="text-red-600">-{diff.deletions ?? 0}</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Summary footer */}
              <div className="shrink-0 px-2 py-1.5 border-t border-border text-[10px] text-muted-foreground">
                {fileCount} 个文件 · <span className="text-green-600">+{added}</span> <span className="text-red-600">-{deleted}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default DockviewDiffsReviewPanel;
```

**Modify:** `frontend/src/components/layout/panels/PanelRegistry.tsx`

Change the lazy import for diffs:
```typescript
// BEFORE:
const LazyDiffPanel = React.lazy(
  () => import('@/components/panels/DockviewDiffPanel')
);

// AFTER:
const LazyDiffPanel = React.lazy(
  () => import('@/components/panels/DockviewDiffsReviewPanel')
);
```

**Keep** `DockviewDiffPanel.tsx` for potential future use (single-file Monaco diff when double-clicking a file in the file tree), but it is no longer the default for the "查看 Git Diff" button.

### Testing
1. Navigate to a workspace with commits ahead of target branch
2. Click "查看 Git Diff" in right sidebar
3. Verify: full diff review panel opens with all changed files
4. Verify: right sidebar shows file directory with A/M/D badges
5. Verify: clicking a file in directory scrolls to that file's diff
6. Verify: inline/split view toggle works
7. Verify: collapse all / expand all works

---

## Task 2: Constrain Terminal to Center/Bottom Only (Not Left Panel)

### Problem
The terminal panel can be dragged into the left sidebar area (file tree / git manager group), breaking the intended layout where left sidebar is reserved for navigation panels only.

### Root Cause
`DockviewReact` in `IDELayout.tsx` has no `showDndOverlay` callback configured, so all drop targets are allowed by default.

### Solution
Add a `showDndOverlay` callback to `DockviewReact` that:
1. When dragging a terminal panel, only allows dropping into center or bottom groups (rejects left sidebar groups)
2. When dragging any panel, prevents dropping into the left sidebar group if the panel is not a left-panel type (file tree / git)
3. Prevents left-panel types from being dragged out of the left group

### Files to Modify

**Modify:** `frontend/src/components/layout/IDELayout.tsx`

Add imports:
```typescript
import type { DockviewDndOverlayEvent } from 'dockview-react';
```

Add the `showDndOverlay` callback inside the `IDELayout` component (before the `return`):

```typescript
/**
 * Guard: only allow drops that maintain the layout structure.
 * - Terminal can only go into center or bottom (not left sidebar)
 * - Left panel items (file tree, git) can only stay in left group
 * - Non-left panels cannot be dropped into the left group
 */
const showDndOverlay = useCallback((event: DockviewDndOverlayEvent) => {
  const api = apiRef.current;
  if (!api) return true; // allow if no API yet

  // Determine which panel is being dragged
  // The event has the panel being dragged and the target group
  const targetGroup = event.group;
  if (!targetGroup) return true;

  // Check if the target group is the left sidebar
  const targetPanelIds = targetGroup.panels.map((p: { id: string }) => p.id);
  const isTargetLeftGroup = targetPanelIds.some((id: string) =>
    id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT
  );

  // If dropping into left group, only allow left-panel types
  if (isTargetLeftGroup) {
    // Check if the dragged panel is a left-panel type
    // DockviewDndOverlayEvent gives us the getData() for external or panel for internal
    if ('panel' in event && event.panel) {
      const draggedId = event.panel.id;
      if (draggedId !== PANEL_IDS.FILE_TREE && draggedId !== PANEL_IDS.GIT) {
        return false; // block non-left panels from entering left group
      }
    }
  }

  return true; // allow everything else
}, []);
```

Update `DockviewReact` props:
```tsx
<DockviewReact
  components={panelComponents}
  onReady={handleReady}
  className="dockview-theme-light dockview-theme-ayu"
  rightHeaderActionsComponent={TerminalHeaderActions}
  showDndOverlay={showDndOverlay}
  disableFloatingGroups={true}
/>
```

Note: `disableFloatingGroups={true}` prevents panels from being dragged out as floating windows, which also helps maintain layout structure.

**Also modify:** `frontend/src/contexts/PanelActionsContext.tsx`

The `openNewTerminal` already positions terminal below center groups, which is correct. But add a safety check: if somehow the terminal is found in a left group after layout restore, move it to the correct position.

In the `handleReady` callback in `IDELayout.tsx`, add a post-restore validation:

```typescript
// After restoring layout, validate terminal position
const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
if (terminalPanel) {
  const termGroup = terminalPanel.group;
  const termGroupPanelIds = termGroup.panels.map(p => p.id);
  const isInLeftGroup = termGroupPanelIds.some(id =>
    id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT
  );
  if (isInLeftGroup) {
    // Terminal is in wrong group — remove and re-add in correct position
    api.removePanel(terminalPanel);
    const centerGroups = api.groups.filter(g => {
      const ids = g.panels.map(p => p.id);
      return !ids.some(id => id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT)
        && !ids.some(id => id === PANEL_IDS.TERMINAL);
    });
    const refPanel = centerGroups[0]?.panels[0];
    if (refPanel) {
      api.addPanel({
        id: PANEL_IDS.TERMINAL,
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        position: { referencePanel: refPanel, direction: 'below' },
        initialHeight: 200,
      });
    }
  }
}
```

### Testing
1. Open terminal in IDE layout
2. Try to drag terminal tab into the left sidebar area (file tree section)
3. Verify: drop overlay does NOT appear over the left sidebar
4. Verify: terminal can still be moved within center/bottom areas
5. Verify: after layout restore, terminal is never in the left group
6. Verify: file tree and git panels cannot be dragged into center area

---

## Task 3: Git Commit Graph — Replace Simple List with Interactive DAG

### Overview
Replace the `CommitHistorySection` component in `DockviewGitPanel` with a visual commit graph showing the complete history of both the current branch and the target branch, with clickable commits that open inline diff views.

### Part 3A: Rust Backend — New `get_commit_graph` API

**Create/Modify:** `crates/git/src/lib.rs`

Add a new struct and method:

```rust
/// A single node in the commit graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitGraphNode {
    /// Abbreviated commit hash (7 chars)
    pub hash: String,
    /// Full commit hash
    pub full_hash: String,
    /// First line of the commit message
    pub message: String,
    /// Author name
    pub author: String,
    /// Commit timestamp (Unix epoch seconds)
    pub timestamp: i64,
    /// Parent commit hashes (full)
    pub parents: Vec<String>,
    /// Branch refs pointing to this commit (e.g., "main", "feature/foo")
    pub refs: Vec<String>,
    /// Whether this commit belongs to the current branch (true) or target branch (false)
    pub is_current_branch: bool,
}

/// Full commit graph result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitGraph {
    /// Ordered list of commits (newest first)
    pub nodes: Vec<CommitGraphNode>,
    /// Hash of the merge-base commit (where branches diverge)
    pub merge_base: Option<String>,
    /// Current branch name
    pub current_branch: String,
    /// Target branch name
    pub target_branch: String,
}
```

Add the new method to `GitService`:

```rust
/// Get the full commit graph for two branches.
/// Returns commits from both branches starting from their tips down to a
/// configurable depth past the merge base, or max_commits total.
pub fn get_commit_graph(
    &self,
    repo_path: &Path,
    branch_name: &str,
    base_branch_name: &str,
    max_commits: usize,
) -> Result<CommitGraph, GitServiceError> {
    let repo = Repository::open(repo_path)?;
    let branch = Self::find_branch(&repo, branch_name)?;
    let base_branch = Self::find_branch(&repo, base_branch_name)?;

    let branch_oid = branch.get().peel_to_commit()?.id();
    let base_oid = base_branch.get().peel_to_commit()?.id();

    // Find merge base
    let merge_base = repo.merge_base(branch_oid, base_oid).ok();

    // Collect all branch refs for labeling
    let mut ref_map: HashMap<Oid, Vec<String>> = HashMap::new();
    for branch_result in repo.branches(None)? {
        let (b, _) = branch_result?;
        if let Some(name) = b.name()? {
            if let Ok(commit) = b.get().peel_to_commit() {
                ref_map.entry(commit.id()).or_default().push(name.to_string());
            }
        }
    }

    // Revwalk from both branch tips
    let mut revwalk = repo.revwalk()?;
    revwalk.push(branch_oid)?;
    revwalk.push(base_oid)?;
    revwalk.set_sorting(git2::Sort::TIME)?; // newest first

    // Collect commits that are reachable only from branch_name (not from base)
    let branch_only: HashSet<Oid> = {
        let mut rw = repo.revwalk()?;
        rw.push(branch_oid)?;
        rw.hide(base_oid)?;
        rw.filter_map(|r| r.ok()).collect()
    };

    let mut nodes = Vec::new();
    let mut count = 0;
    let past_merge_base_count = 5; // show a few commits past merge base for context
    let mut past_merge_base = 0;
    let mut found_merge_base = false;

    for oid_result in revwalk {
        if count >= max_commits { break; }
        if found_merge_base && past_merge_base >= past_merge_base_count { break; }

        let oid = oid_result?;
        let commit = repo.find_commit(oid)?;

        if merge_base == Some(oid) {
            found_merge_base = true;
        }
        if found_merge_base {
            past_merge_base += 1;
        }

        let hash_str = format!("{}", oid);
        let short_hash = hash_str[..7.min(hash_str.len())].to_string();

        let message = commit.message()
            .unwrap_or("")
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();

        let author = commit.author().name().unwrap_or("Unknown").to_string();
        let timestamp = commit.time().seconds();

        let parents: Vec<String> = commit.parent_ids()
            .map(|p| format!("{}", p))
            .collect();

        let refs = ref_map.get(&oid).cloned().unwrap_or_default();
        let is_current_branch = branch_only.contains(&oid);

        nodes.push(CommitGraphNode {
            hash: short_hash,
            full_hash: hash_str,
            message,
            author,
            timestamp,
            parents,
            refs,
            is_current_branch,
        });
        count += 1;
    }

    Ok(CommitGraph {
        nodes,
        merge_base: merge_base.map(|o| format!("{}", o)),
        current_branch: branch_name.to_string(),
        target_branch: base_branch_name.to_string(),
    })
}
```

### Part 3B: Tauri Command

**Modify:** `src-tauri/src/commands/workspaces.rs`

Add a new Tauri command:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct CommitGraphNode {
    pub hash: String,
    pub full_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub is_current_branch: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitGraphResult {
    pub nodes: Vec<CommitGraphNode>,
    pub merge_base: Option<String>,
    pub current_branch: String,
    pub target_branch: String,
}

#[tauri::command]
pub async fn get_workspace_commit_graph(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    max_commits: Option<usize>,
) -> Result<CommitGraphResult, AppError> {
    let pool = &state.deployment.db().pool;
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;
    let workspace_repo = WorkspaceRepo::find_by_workspace_and_repo_id(pool, workspace.id, repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;
    let repo = Repo::find_by_id(pool, workspace_repo.repo_id)
        .await?
        .ok_or(RepoError::NotFound)?;

    let git = state.deployment.git();
    let graph = git
        .get_commit_graph(&repo.path, &workspace.branch, &workspace_repo.target_branch, max_commits.unwrap_or(100))
        .unwrap_or_else(|_| CommitGraph {
            nodes: vec![],
            merge_base: None,
            current_branch: workspace.branch.clone(),
            target_branch: workspace_repo.target_branch.clone(),
        });

    // Map from git crate types to command types
    Ok(CommitGraphResult {
        nodes: graph.nodes.into_iter().map(|n| CommitGraphNode {
            hash: n.hash,
            full_hash: n.full_hash,
            message: n.message,
            author: n.author,
            timestamp: n.timestamp,
            parents: n.parents,
            refs: n.refs,
            is_current_branch: n.is_current_branch,
        }).collect(),
        merge_base: graph.merge_base,
        current_branch: graph.current_branch,
        target_branch: graph.target_branch,
    })
}
```

Register the command in `src-tauri/src/lib.rs` (or wherever commands are registered):
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    commands::workspaces::get_workspace_commit_graph,
])
```

### Part 3C: Frontend API

**Modify:** `frontend/src/lib/api.ts`

Add to `attemptsApi`:
```typescript
getCommitGraph: async (workspaceId: string, repoId: string, maxCommits?: number) => {
  return tauriInvoke<CommitGraphResult>('get_workspace_commit_graph', {
    workspaceId,
    repoId,
    maxCommits: maxCommits ?? 100,
  });
},
```

Add TypeScript types (at top of api.ts or in a new types file):
```typescript
export interface CommitGraphNode {
  hash: string;
  full_hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
  refs: string[];
  is_current_branch: boolean;
}

export interface CommitGraphResult {
  nodes: CommitGraphNode[];
  merge_base: string | null;
  current_branch: string;
  target_branch: string;
}
```

### Part 3D: CommitGraph Frontend Component

**Create:** `frontend/src/components/git/CommitGraph.tsx`

This component renders the visual DAG graph with SVG lanes:

```
Visual layout for each commit row:
┌─────────────────────────────────────────────────────────┐
│ ●──── commit message ...   author    2 min ago  [tag]   │
│ │                                                       │
│ ●──── another commit ...   author    5 min ago          │
│ │\                                                      │
│ │ ○── merge base commit    author    1 hr ago           │
│ │ │                                                     │
│ ○ │   target branch commit author    2 hr ago           │
└─────────────────────────────────────────────────────────┘

Legend:
● = current branch commit (filled circle, primary color e.g. blue)
○ = target branch commit (filled circle, secondary color e.g. gray)
⊙ = merge-base commit (double circle)
Lines connect parent→child vertically and with curves for branches
```

Implementation approach:
1. **Lane assignment algorithm**: Simple 2-lane model
   - Lane 0 (left): current branch commits
   - Lane 1 (right): target branch only commits
   - When a commit has parents in different lanes, draw a diagonal line
2. **SVG rendering**: Each row is ~28px tall, with circles at the lane position and vertical/diagonal lines connecting to parents
3. **Interactivity**: Click a commit to open its diff in a center panel tab

```tsx
import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tag, GitMerge } from 'lucide-react';
import { attemptsApi, type CommitGraphNode, type CommitGraphResult } from '@/lib/api';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

const ROW_HEIGHT = 32;
const LANE_WIDTH = 16;
const NODE_RADIUS = 4;
const MERGE_BASE_RADIUS = 6;

const COLORS = {
  currentBranch: '#3B82F6',   // blue-500
  targetBranch: '#9CA3AF',    // gray-400
  mergeBase: '#F59E0B',       // amber-500
};

interface CommitGraphProps {
  workspaceId: string;
  repoId: string;
}

interface LaneNode extends CommitGraphNode {
  lane: number;
  y: number;
  isMergeBase: boolean;
}

function assignLanes(graph: CommitGraphResult): LaneNode[] {
  const mergeBaseHash = graph.merge_base;
  return graph.nodes.map((node, idx) => ({
    ...node,
    lane: node.is_current_branch ? 0 : 1,
    y: idx * ROW_HEIGHT + ROW_HEIGHT / 2,
    isMergeBase: node.full_hash === mergeBaseHash,
  }));
}

function formatTimeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}天前`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

export function CommitGraph({ workspaceId, repoId }: CommitGraphProps) {
  const { data: graph, isLoading } = useQuery({
    queryKey: ['commit-graph', workspaceId, repoId],
    queryFn: () => attemptsApi.getCommitGraph(workspaceId, repoId),
    enabled: !!workspaceId && !!repoId,
    refetchInterval: 10000,
  });

  const { openOrFocusPanel } = usePanelActionsContext();

  const laneNodes = useMemo(() => graph ? assignLanes(graph) : [], [graph]);

  const nodeMap = useMemo(() => {
    const map = new Map<string, LaneNode>();
    for (const node of laneNodes) {
      map.set(node.full_hash, node);
    }
    return map;
  }, [laneNodes]);

  // TODO: clicking a commit will open a commit-diff panel in center area
  const handleCommitClick = useCallback((node: LaneNode) => {
    // For now, open the diff panel — future: open commit-specific diff
    openOrFocusPanel(`commit-diff:${node.hash}`, `${node.hash} diff`);
  }, [openOrFocusPanel]);

  if (isLoading) {
    return <div className="text-xs text-muted-foreground py-2">加载提交图...</div>;
  }

  if (!graph || laneNodes.length === 0) {
    return null;
  }

  const svgWidth = LANE_WIDTH * 3; // 2 lanes + padding
  const totalHeight = laneNodes.length * ROW_HEIGHT;

  return (
    <div className="border-t border-border pt-2 mt-2">
      <div className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
        提交图
        <span className="text-[10px] font-normal">
          (<span style={{ color: COLORS.currentBranch }}>{graph.current_branch}</span>
          {' vs '}
          <span style={{ color: COLORS.targetBranch }}>{graph.target_branch}</span>)
        </span>
      </div>
      <div className="max-h-80 overflow-auto">
        <div className="relative" style={{ minHeight: totalHeight }}>
          {/* SVG lanes */}
          <svg
            className="absolute left-0 top-0"
            width={svgWidth}
            height={totalHeight}
            style={{ pointerEvents: 'none' }}
          >
            {/* Draw connecting lines */}
            {laneNodes.map((node) =>
              node.parents.map((parentHash) => {
                const parent = nodeMap.get(parentHash);
                if (!parent) return null;
                const x1 = node.lane * LANE_WIDTH + LANE_WIDTH / 2;
                const y1 = node.y;
                const x2 = parent.lane * LANE_WIDTH + LANE_WIDTH / 2;
                const y2 = parent.y;

                if (x1 === x2) {
                  // Straight vertical line
                  return (
                    <line
                      key={`${node.full_hash}-${parentHash}`}
                      x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={node.is_current_branch ? COLORS.currentBranch : COLORS.targetBranch}
                      strokeWidth={1.5}
                      opacity={0.5}
                    />
                  );
                } else {
                  // Curved line for branch/merge
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${node.full_hash}-${parentHash}`}
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      fill="none"
                      stroke={node.is_current_branch ? COLORS.currentBranch : COLORS.targetBranch}
                      strokeWidth={1.5}
                      opacity={0.5}
                    />
                  );
                }
              })
            )}

            {/* Draw commit nodes */}
            {laneNodes.map((node) => {
              const cx = node.lane * LANE_WIDTH + LANE_WIDTH / 2;
              const cy = node.y;
              const color = node.isMergeBase
                ? COLORS.mergeBase
                : node.is_current_branch
                ? COLORS.currentBranch
                : COLORS.targetBranch;
              const radius = node.isMergeBase ? MERGE_BASE_RADIUS : NODE_RADIUS;

              return (
                <g key={node.full_hash}>
                  <circle cx={cx} cy={cy} r={radius} fill={color} />
                  {node.isMergeBase && (
                    <circle cx={cx} cy={cy} r={radius - 2} fill="var(--background, #fff)" />
                  )}
                  {node.isMergeBase && (
                    <circle cx={cx} cy={cy} r={2} fill={color} />
                  )}
                </g>
              );
            })}
          </svg>

          {/* Commit info rows */}
          {laneNodes.map((node) => (
            <div
              key={node.full_hash}
              className="flex items-center hover:bg-accent/30 cursor-pointer group"
              style={{ height: ROW_HEIGHT, paddingLeft: svgWidth + 4 }}
              onClick={() => handleCommitClick(node)}
              title={`${node.full_hash}\n${node.message}\n${node.author}`}
            >
              <span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
                {node.hash}
              </span>
              <span className="text-xs truncate flex-1 min-w-0 text-foreground">
                {node.message}
              </span>
              {node.refs.length > 0 && node.refs.map((ref) => (
                <span
                  key={ref}
                  className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono"
                >
                  {ref}
                </span>
              ))}
              <span className="shrink-0 ml-2 text-[10px] text-muted-foreground whitespace-nowrap">
                {node.author}
              </span>
              <span className="shrink-0 ml-2 text-[10px] text-muted-foreground whitespace-nowrap">
                {formatTimeAgo(node.timestamp)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

### Part 3E: Replace CommitHistorySection in DockviewGitPanel

**Modify:** `frontend/src/components/panels/DockviewGitPanel.tsx`

Replace the import and usage:

```typescript
// BEFORE:
function CommitHistorySection({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  // ... simple list implementation
}

// AFTER: Remove CommitHistorySection entirely and import CommitGraph
import { CommitGraph } from '@/components/git/CommitGraph';
```

In the JSX, replace:
```tsx
// BEFORE:
<CommitHistorySection workspaceId={activeWorktreeId!} repoId={repo.repo_id} />

// AFTER:
<CommitGraph workspaceId={activeWorktreeId!} repoId={repo.repo_id} />
```

### Part 3F: Commit Diff Panel (Click-to-View)

When a commit is clicked in the graph, we need to show that commit's diff. This requires:

1. **New Tauri command** `get_commit_diff` that returns the diff for a specific commit hash
2. **New panel** `DockviewCommitDiffPanel` registered with dynamic IDs

However, for the initial implementation, clicking a commit can reuse the existing diff infrastructure:
- Open the existing DiffsReview panel and filter by commit range
- OR open a simpler inline-only diff view

**Simplified approach for v1:** Clicking a commit opens a lightweight panel that shows `git show <hash>` output rendered with `@git-diff-view/react`.

**Create:** `frontend/src/components/panels/DockviewCommitDiffPanel.tsx`

This panel:
1. Receives the commit hash via dockview panel `params`
2. Calls a new Tauri command `get_commit_diff(hash)` that returns `Vec<Diff>`
3. Renders each diff using `DiffCard` in inline-only mode

**New Tauri command in `workspaces.rs`:**
```rust
#[tauri::command]
pub async fn get_commit_diff(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    commit_hash: String,
) -> Result<Vec<Diff>, AppError> {
    // Use git2 to get the diff between this commit and its parent(s)
    // Return as Vec<Diff> matching the existing Diff type
}
```

**New git service method:**
```rust
pub fn get_commit_diff(
    &self,
    repo_path: &Path,
    commit_hash: &str,
) -> Result<Vec<Diff>, GitServiceError> {
    let repo = Repository::open(repo_path)?;
    let oid = Oid::from_str(commit_hash)?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().map(|p| p.tree().ok()).flatten();
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;
    // Convert git2::Diff to our Diff type with patches
    // ...
}
```

Register `commit-diff` as a dynamic panel component in `PanelRegistry.tsx`:
```typescript
const LazyCommitDiffPanel = React.lazy(
  () => import('@/components/panels/DockviewCommitDiffPanel')
);

// In the component map, handle dynamic IDs:
// Panels with ID starting with 'commit-diff:' map to LazyCommitDiffPanel
```

Since dockview uses exact ID matching for components, we need to update the panel component resolution to support prefix matching. Modify `PanelRegistry.tsx`:

```typescript
// Add a resolver function
function resolveComponent(id: string) {
  if (id.startsWith('commit-diff:')) return LazyCommitDiffPanel;
  return PANEL_COMPONENT_MAP[id] ?? null;
}
```

### Testing (Task 3)
1. Open Git manager in left sidebar
2. Verify: commit graph shows with colored lanes and circles
3. Verify: current branch commits appear on left lane (blue)
4. Verify: target branch commits appear on right lane (gray)
5. Verify: merge base shown with special marker (amber double circle)
6. Verify: branch refs (tags, branch names) shown as badges
7. Verify: clicking a commit opens a diff panel in center area
8. Verify: graph refreshes when new commits are added

---

## Implementation Order

1. **Task 1** (Diff Review Panel) — smallest scope, immediate value, no backend changes
2. **Task 2** (Terminal Constraint) — small scope, layout stability improvement
3. **Task 3** (Commit Graph) — largest scope, requires Rust backend + new frontend component
   - 3A: Rust `get_commit_graph` method
   - 3B: Tauri command registration
   - 3C: Frontend API types + call
   - 3D: CommitGraph component
   - 3E: Replace in DockviewGitPanel
   - 3F: Commit diff panel (can be deferred to v2 if needed)

## Layout Version Migration

Since Task 1 changes the panel component mapping for `PANEL_IDS.DIFFS`, existing serialized layouts that have the old DockviewDiffPanel will attempt to render with the new component. This should work transparently since the panel ID remains the same (`'diffs'`), only the underlying component changes. However, to be safe:

**Modify:** `frontend/src/stores/useLayoutStore.ts`

Bump the layout persistence version:
```typescript
version: 8,  // was 7
```

This will trigger the migration function which clears the serialized layout, forcing a fresh layout build on next load.
