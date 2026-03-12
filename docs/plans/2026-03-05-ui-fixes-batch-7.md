# UI Fixes Batch 7 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 12 UI issues covering font spacing, stop button, rebase back, diff tree, user message border, logs button, terminal positioning, terminal tab names, file preview, and panel width overflow.

**Architecture:** All fixes are frontend-only (React/TypeScript), except Issue 6 (Rebase Back) which may show error from Rust backend but the fix is purely frontend. Each issue is independent — fix in priority order. No new routes or backend changes needed.

**Tech Stack:** React 18, TypeScript, TailwindCSS, Dockview, Zustand, lucide-react, NiceModal

---

## Issue 1: 字符显示不连续（font-mono 间距问题）

**Root cause:** IBM Plex Mono 本身字间距较宽，在小字号（`text-[10px]`/`text-[9px]`）下视觉上字符分离。需在 `CommitGraph.tsx` 的 hash span 和 ref badge 上添加 `tracking-tight`。

### Task 1: 为 CommitGraph.tsx 添加 tracking-tight

**Files:**
- Modify: `frontend/src/components/git/CommitGraph.tsx`

**Step 1: 读取 CommitGraph.tsx 的 hash span 和 ref badge 部分（第205-230行）**

```bash
# 在 frontend 目录确认文件位置
ls frontend/src/components/git/
```

**Step 2: 为 hash span 添加 tracking-tight**

找到第210行：
```tsx
<span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
```

改为：
```tsx
<span className="text-[10px] font-mono tracking-tight text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
```

**Step 3: 为 ref badge 添加 tracking-tight**

找到第222行：
```tsx
className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono"
```

改为：
```tsx
className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono tracking-tight"
```

**Step 4: 在 BranchInfoHeader.tsx 中检查 HEAD span**

查看第29行的 `font-mono` span（HEAD 显示），如果有：
```tsx
<span className="font-mono text-foreground truncate">HEAD</span>
```
添加 `tracking-tight`:
```tsx
<span className="font-mono tracking-tight text-foreground truncate">HEAD</span>
```

**Step 5: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: 0 errors.

**Step 6: Commit**

```bash
git add frontend/src/components/git/CommitGraph.tsx frontend/src/components/layout/BranchInfoHeader.tsx
git commit -m "fix: add tracking-tight to font-mono elements to fix character spacing"
```

---

## Issue 2: 用户消息边框改为黑色/主题色

**Root cause:** `UserMessage.tsx` 第57行硬编码了 `border-green-400`，在暗色主题下不好看。

### Task 2: 修改用户消息边框颜色

**Files:**
- Modify: `frontend/src/components/NormalizedConversation/UserMessage.tsx`

**Step 1: 读取文件第55-62行**

确认当前边框类名。

**Step 2: 替换边框颜色**

将：
```tsx
<div className="rounded-xl border border-green-400 bg-background px-4 py-3 text-sm">
```

改为：
```tsx
<div className="rounded-xl border border-foreground/20 bg-background px-4 py-3 text-sm">
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/components/NormalizedConversation/UserMessage.tsx
git commit -m "fix: change user message border from green-400 to foreground/20 for theme compatibility"
```

---

## Issue 3: 停止按钮完全没有反应

**Root cause:** `TaskFollowUpSection.tsx` 第653行：`if (!workspaceId) return null`。`workspaceId` 来自 `session?.workspace_id`，当 `session` 为 `undefined` 时整个组件返回 `null`，停止按钮根本不渲染。

`session` 来自 `attempt.session`（`WorkspaceWithSession.session: Session | undefined`），初始加载时可能为 `undefined`。

**Fix:** 修改 `TaskFollowUpSection` 的 props，同时接收 `attempt`（或直接接收 `workspaceId`），从而使用 `attempt.id` 作为 fallback。

### Task 3: 修复停止按钮 workspaceId 传递

**Files:**
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- Modify: `frontend/src/components/panels/TaskAttemptPanel.tsx`

**Step 1: 读取 TaskFollowUpSection.tsx 第55-75行（Props 定义和 workspaceId 派生）**

**Step 2: 修改 Props 接口**

找到：
```tsx
interface TaskFollowUpSectionProps {
  task: TaskWithAttemptStatus;
  session?: Session;
}
```

改为：
```tsx
interface TaskFollowUpSectionProps {
  task: TaskWithAttemptStatus;
  session?: Session;
  workspaceId?: string;
}
```

**Step 3: 修改 workspaceId 派生逻辑**

找到（第67行）：
```tsx
const workspaceId = session?.workspace_id;
```

改为：
```tsx
const workspaceId = session?.workspace_id ?? props.workspaceId;
```

注意：函数参数需要解构 props，或者整个函数签名需要改。实际修改是：

```tsx
export function TaskFollowUpSection({ task, session, workspaceId: workspaceIdProp }: TaskFollowUpSectionProps) {
  // ...
  const workspaceId = session?.workspace_id ?? workspaceIdProp;
```

**Step 4: 修改 TaskAttemptPanel.tsx 中的调用**

找到 `TaskAttemptPanel.tsx` 中：
```tsx
followUp: (
  <TaskFollowUpSection task={task} session={attempt.session} />
),
```

改为：
```tsx
followUp: (
  <TaskFollowUpSection task={task} session={attempt.session} workspaceId={attempt.id} />
),
```

**Step 5: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: 0 errors.

**Step 6: Commit**

```bash
git add frontend/src/components/tasks/TaskFollowUpSection.tsx frontend/src/components/panels/TaskAttemptPanel.tsx
git commit -m "fix: pass attempt.id as workspaceId fallback to prevent stop button disappearing"
```

---

## Issue 4: Rebase Back 有 loading 但无效果

**Root cause:** `BranchInfoHeader.tsx` 的 `handleRebaseBack` 使用 `await attemptsApi.rebaseBack(...)` 但：
1. `rebaseBack` 返回 `Result<void, GitOperationError>`（从不抛出）
2. 代码没有检查 `result.success`
3. 成功后没有 `invalidateQueries` 刷新 branch status

### Task 4: 修复 RebaseBackButton 逻辑

**Files:**
- Modify: `frontend/src/components/layout/BranchInfoHeader.tsx`

**Step 1: 读取 BranchInfoHeader.tsx 完整文件（特别是 imports 和 RebaseBackButton）**

**Step 2: 添加 useQueryClient import（如果尚未存在）**

在文件顶部 imports 中添加（与其他 react-query imports 一起）：
```tsx
import { useQueryClient } from '@tanstack/react-query';
```

**Step 3: 修改 RebaseBackButton 组件**

将当前实现（第107-122行）：
```tsx
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

改为：
```tsx
function RebaseBackButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebaseBack = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await attemptsApi.rebaseBack(worktreeId, repoId);
      if (!result.success) {
        setError('Rebase failed. Please check for conflicts.');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branch-status', worktreeId] });
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId, queryClient]);

  return (
    <div className="flex flex-col items-start gap-0.5">
      <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebaseBack} disabled={loading}>
        Rebase Back
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
    </div>
  );
}
```

**Step 4: 确认 branch-status query key**

在 `BranchInfoHeader.tsx` 或相关文件中搜索 branch status query key 的实际定义，确保 `['branch-status', worktreeId]` 与实际 query key 匹配。如果不匹配则修正。

在文件中搜索 `useQuery` 调用，找到 queryKey 格式：
```bash
grep -n "queryKey" frontend/src/components/layout/BranchInfoHeader.tsx
```

如果 query key 不是 `['branch-status', worktreeId]`，则使用实际的 key。也可以用：
```tsx
queryClient.invalidateQueries({ queryKey: ['branch-status'] });
```
（不传第二个参数，invalidate 所有 branch-status queries）

**Step 5: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**

```bash
git add frontend/src/components/layout/BranchInfoHeader.tsx
git commit -m "fix: check result.success and invalidate branch-status query after rebase back"
```

---

## Issue 5: Diff — Content omitted 添加打开编辑器按钮

**Root cause:** `DiffCard.tsx` 在 `contentOmitted=true` 时只显示文字提示，没有交互。`handleOpenInIDE` 已存在但未在 omitted 状态下暴露给用户。

### Task 5: 在 DiffCard.tsx omitted 提示旁添加按钮

**Files:**
- Modify: `frontend/src/components/DiffCard.tsx`

**Step 1: 读取 DiffCard.tsx 第320-345行（omitted 渲染区域）**

**Step 2: 添加"在编辑器中打开"按钮**

找到（第328-339行）：
```tsx
{isOmitted
  ? 'Content omitted due to file size. Open in editor to view.'
  : isContentEqual ? ... : 'Failed to render diff for this file.'}
```

该区域在一个 `<p>` 或类似元素中。需要在 `isOmitted` 为 true 时，除显示文字外，还显示一个按钮。

找到完整的 omitted 状态渲染块，将文字提示改为：
```tsx
{isOmitted && (
  <div className="flex flex-col items-center gap-2 py-4">
    <p className="text-sm text-muted-foreground">
      Content omitted due to file size.
    </p>
    <Button
      variant="outline"
      size="sm"
      onClick={handleOpenInIDE}
      className="h-7 text-xs"
    >
      在编辑器中打开
    </Button>
  </div>
)}
```

注意：需要确认 `Button` 已经在 DiffCard.tsx 中导入。如果没有：
```tsx
import { Button } from '@/components/ui/button';
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/components/DiffCard.tsx
git commit -m "fix: add open-in-editor button when diff content is omitted due to file size"
```

---

## Issue 6: Diff Changes — 树形目录结构

**Root cause:** `DockviewDiffsReviewPanel.tsx` 的 Changes 侧边栏用扁平列表。需要改为按路径 `/` 分割的树形结构，支持折叠展开。

### Task 6: 新建 DiffFileTree 组件

**Files:**
- Create: `frontend/src/components/diff/DiffFileTree.tsx`
- Modify: `frontend/src/components/panels/DockviewDiffsReviewPanel.tsx`

**Step 1: 创建 DiffFileTree.tsx**

```tsx
// frontend/src/components/diff/DiffFileTree.tsx
import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface DiffFile {
  id: string;
  path: string;
  badge: { label: string; color: string };
  additions: number | null | undefined;
  deletions: number | null | undefined;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Record<string, TreeNode>;
  file?: DiffFile;
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: {} };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        node.children[part] = {
          name: part,
          fullPath: parts.slice(0, i + 1).join('/'),
          children: {},
        };
      }
      node = node.children[part];
      if (i === parts.length - 1) {
        node.file = file;
      }
    }
  }
  return root;
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  onFileClick: (id: string) => void;
}

function TreeNodeView({ node, depth, onFileClick }: TreeNodeViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const children = Object.values(node.children);
  const isDir = !node.file && children.length > 0;
  const indent = depth * 12;

  if (node.file) {
    // 文件节点
    return (
      <button
        onClick={() => onFileClick(node.file!.id)}
        className="w-full flex items-center gap-1.5 px-2 py-0.5 text-left hover:bg-accent/50 rounded-sm"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        <span className={`text-[10px] font-medium px-0.5 rounded shrink-0 ${node.file.badge.color}`}>
          {node.file.badge.label}
        </span>
        <span className="text-xs truncate text-foreground flex-1">{node.name}</span>
        {(node.file.additions != null || node.file.deletions != null) && (
          <span className="text-[10px] shrink-0">
            <span className="text-green-600">+{node.file.additions ?? 0}</span>
            <span className="text-red-600 ml-0.5">-{node.file.deletions ?? 0}</span>
          </span>
        )}
      </button>
    );
  }

  if (isDir) {
    // 目录节点
    const fileCount = countFiles(node);
    return (
      <div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center gap-1 px-2 py-0.5 text-left hover:bg-accent/30 rounded-sm"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          {collapsed
            ? <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          }
          <span className="text-xs font-medium text-muted-foreground flex-1 truncate">{node.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0 bg-muted rounded px-1">{fileCount}</span>
        </button>
        {!collapsed && children.map((child) => (
          <TreeNodeView
            key={child.name}
            node={child}
            depth={depth + 1}
            onFileClick={onFileClick}
          />
        ))}
      </div>
    );
  }

  return null;
}

function countFiles(node: TreeNode): number {
  if (node.file) return 1;
  return Object.values(node.children).reduce((sum, child) => sum + countFiles(child), 0);
}

interface DiffFileTreeProps {
  files: DiffFile[];
  onFileClick: (id: string) => void;
}

export function DiffFileTree({ files, onFileClick }: DiffFileTreeProps) {
  const root = buildTree(files);
  const children = Object.values(root.children);

  return (
    <div className="flex flex-col gap-0">
      {children.map((child) => (
        <TreeNodeView
          key={child.name}
          node={child}
          depth={0}
          onFileClick={onFileClick}
        />
      ))}
    </div>
  );
}
```

**Step 2: 读取 DockviewDiffsReviewPanel.tsx 第207-295行（Changes 侧边栏列表循环）**

了解 `diffs` 数组结构、`scrollToFile(id)` 调用方式、`changeBadge` 对象。

**Step 3: 在 DockviewDiffsReviewPanel.tsx 中替换文件列表**

导入 `DiffFileTree`：
```tsx
import { DiffFileTree } from '@/components/diff/DiffFileTree';
```

将 `diffs.map(...)` 循环替换为：
```tsx
<DiffFileTree
  files={diffs.map((diff, idx) => {
    const id = getDiffId(diff, idx);
    const badge = changeBadge[diff.change] || changeBadge.modified;
    return {
      id,
      path: diff.newPath || diff.oldPath || id,
      badge,
      additions: diff.additions,
      deletions: diff.deletions,
    };
  })}
  onFileClick={scrollToFile}
/>
```

**Step 4: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 5: Commit**

```bash
git add frontend/src/components/diff/DiffFileTree.tsx frontend/src/components/panels/DockviewDiffsReviewPanel.tsx
git commit -m "feat: replace flat diff file list with collapsible tree structure"
```

---

## Issue 7: Logs 按钮改为执行进程列表

**Root cause:** `RightPanelSidebar.tsx` 的 Logs 按钮调用 `openLogs`（打开 Logs 面板），应改为打开 `ViewProcessesDialog`。

### Task 7: 修改 RightPanelSidebar.tsx 的 Logs 按钮

**Files:**
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx`

**Step 1: 读取 RightPanelSidebar.tsx 完整文件**

确认 `sessionId` 在此组件中是否可以获取（用于传给 ViewProcessesDialog）。

**Step 2: 确认 ViewProcessesDialog 的导入方式**

从已探索的信息：`ViewProcessesDialog` 使用 NiceModal，调用方式：
```tsx
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
ViewProcessesDialog.show({ sessionId, initialProcessId: null });
```

**Step 3: 添加导入**

在文件顶部添加：
```tsx
import { ViewProcessesDialog } from '@/components/dialogs/tasks/ViewProcessesDialog';
import { List } from 'lucide-react';
```

注意：如果 `List` 已经在 lucide 导入中，不需要重复导入。

**Step 4: 修改 Logs 按钮**

找到当前按钮定义（第109行）：
```tsx
{ icon: FileText, label: '查看 Logs', onClick: openLogs },
```

改为（假设 `sessionId` 可以从 props 或 context 获取）：
```tsx
{ icon: List, label: '执行进程', onClick: () => ViewProcessesDialog.show({ sessionId, initialProcessId: null }) },
```

如果 `sessionId` 在 `RightPanelSidebar` 中不可用，需要先从 props 或 context 获取。读取完整文件后确认 `sessionId` 来源。如果确实不可用：
- 从 `usePanelActionsContext()` 或 `useWorkspace()` 等 context hook 获取
- 或者从 props 传入

**Step 5: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 6: Commit**

```bash
git add frontend/src/components/layout/RightPanelSidebar.tsx
git commit -m "fix: change logs button to open execution processes dialog instead of logs panel"
```

---

## Issue 8: 终端标签页名称与类型一致

**Root cause:** `useTerminalStore.ts` 的 `addSession` 中，无论 session 类型（`'pty'` 或 `'log-viewer'`），title 默认都是 `Terminal ${N}`。

### Task 8: 修改 addSession 默认标题

**Files:**
- Modify: `frontend/src/stores/useTerminalStore.ts`

**Step 1: 读取 useTerminalStore.ts 第50-85行（addSession 完整实现）**

**Step 2: 修改默认标题逻辑**

找到（第66行左右）：
```typescript
title: options?.title ?? `Terminal ${existing.length + 1}`,
```

改为：
```typescript
title: options?.title ?? (
  options?.type === 'log-viewer'
    ? `日志 ${existing.length + 1}`
    : `终端 ${existing.length + 1}`
),
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/stores/useTerminalStore.ts
git commit -m "fix: use type-appropriate default title for terminal sessions (终端/日志)"
```

---

## Issue 9: 终端占据左栏区域

**Root cause:** `validateTerminalPosition` 通过扫描同组面板 ID 来检测 terminal 是否在左栏，当左栏为空（panel 被关闭后）时检测失败。改为直接比较 `group.id === GROUP_IDS.LEFT`。

### Task 9: 修复 validateTerminalPosition 使用 group ID

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Step 1: 读取 IDELayout.tsx 第260-300行（validateTerminalPosition 完整函数）**

**Step 2: 修改 isInLeftGroup 判断**

找到（第270-275行）：
```typescript
const termGroup = terminalPanel.group;
const termGroupPanelIds = termGroup.panels.map((p) => p.id);
const isInLeftGroup = termGroupPanelIds.some(
  (id) => id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT
);
```

改为：
```typescript
const termGroup = terminalPanel.group;
const isInLeftGroup = termGroup.id === GROUP_IDS.LEFT;
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: use group ID instead of panel scan to detect terminal in left panel"
```

---

## Issue 10: 文件预览优先显示在 center-2

**Root cause:** `PanelActionsContext.tsx` 的 `openFilePreview` 在选择目标 group 时，优先用空 group，然后用第一个 center group。没有优先选择 `GROUP_IDS.CENTER_2`。

### Task 10: 修改 openFilePreview 优先使用 center-2

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`

**Step 1: 读取 PanelActionsContext.tsx 第141-186行（openFilePreview 完整实现）**

**Step 2: 修改目标 group 选择逻辑**

找到（第161-170行）：
```typescript
const emptyGroup = centerGroups.find((g) => g.panels.length === 0);
const targetGroup = emptyGroup || centerGroups[0];
```

改为：
```typescript
const center2Group = dockviewApi.groups.find((g) => g.id === GROUP_IDS.CENTER_2);
const emptyGroup = centerGroups.find((g) => g.panels.length === 0);
const targetGroup = center2Group || emptyGroup || centerGroups[0];
```

注意：需要确认 `GROUP_IDS` 已在此文件中导入。如果没有，添加导入：
```typescript
import { GROUP_IDS, PANEL_IDS, /* ... */ } from '@/stores/useLayoutStore';
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/contexts/PanelActionsContext.tsx
git commit -m "fix: prioritize center-2 group for file preview panel placement"
```

---

## Issue 11: 关闭中2栏后左栏超出宽度

**Root cause:** 关闭 center-2 panel 后，dockview 把空余空间分配给相邻 group，左侧 group 没有最大宽度约束，导致左栏超出 300px。

### Task 11: 在 IDELayout.tsx 的 onDidLayoutChange 中钳制左栏宽度

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Step 1: 读取 IDELayout.tsx 第320-360行（onDidLayoutChange 回调）**

**Step 2: 在 onDidLayoutChange 中添加宽度钳制**

找到（第328行）：
```typescript
const layoutDisposable = api.onDidLayoutChange(() => {
  try {
    setSerializedLayout(api.toJSON());
  } catch {
    // Ignore serialization errors during transitions
  }
});
```

改为：
```typescript
const layoutDisposable = api.onDidLayoutChange(() => {
  // 钳制左侧面板宽度不超过 300px
  const leftGroup = api.groups.find((g) => g.id === GROUP_IDS.LEFT);
  if (leftGroup?.element) {
    const el = leftGroup.element as HTMLElement;
    if (el.getBoundingClientRect().width > 300) {
      el.style.maxWidth = '300px';
    }
  }
  try {
    setSerializedLayout(api.toJSON());
  } catch {
    // Ignore serialization errors during transitions
  }
});
```

**Step 3: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: clamp left panel width to max 300px on layout change"
```

---

## 最终验证

```bash
# TypeScript 全量检查
cd frontend && npx tsc --noEmit
```

Expected: 0 errors.

所有 11 个 issue 的行为验证：
1. CommitGraph 中 hash 和 ref badge 字符间距正常（无分离）
2. 用户消息边框为黑色/主题色（非绿色）
3. 停止按钮在 attempt 运行时正常显示和响应
4. Rebase Back 点击后 branch status 正确刷新
5. Diff 文件过大时显示"在编辑器中打开"按钮
6. Diff Changes 侧边栏显示树形目录，可折叠展开
7. 右侧边栏 Logs 按钮打开执行进程对话框
8. 终端标签页 pty 显示"终端 N"，log-viewer 显示"日志 N"
9. 终端不再漂移到左侧栏
10. 点击文件时预览优先在 center-2 打开
11. 关闭 center-2 后左栏宽度保持 ≤ 300px
