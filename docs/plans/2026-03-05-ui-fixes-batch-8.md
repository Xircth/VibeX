# UI Fixes Batch 8 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 4 issues: rebase-back conflict handling with ConflictBanner, diff toggle button colors, left panel width overflow via dockview API, and font localization to eliminate Google Fonts dependency.

**Architecture:** Issue 4 (font localization) is the highest-impact fix — it resolves the long-standing character spacing problems at their root cause. Each issue is independent. All fixes are frontend-only.

**Tech Stack:** React 18, TypeScript, TailwindCSS, Dockview, IBM Plex fonts (woff2)

---

## Task 1: Rebase Back 冲突处理 — 使用 ConflictBanner

**Files:**
- Modify: `frontend/src/components/layout/BranchInfoHeader.tsx`

**Context:** 当前 `RebaseBackButton`（第107-135行）在 `result.success === false` 时显示静态 "Rebase failed" 文字。`attemptsApi.rebaseBack` 返回 `Result<void, GitOperationError>`，其中 `GitOperationError` 有两种类型：
- `{ type: "merge_conflicts", message, op, conflicted_files, target_branch }`
- `{ type: "rebase_in_progress" }`

需要解析错误类型，当 `merge_conflicts` 时渲染已有的 `ConflictBanner` 组件。

**Step 1: 修改 RebaseBackButton — 添加冲突状态和 ConflictBanner**

添加 import:
```tsx
import { ConflictBanner } from '@/components/tasks/ConflictBanner';
import type { ConflictOp, GitOperationError } from 'shared/types';
```

将 `RebaseBackButton` 组件替换为：

```tsx
function RebaseBackButton({ worktreeId, repoId }: { worktreeId: string; repoId: string }) {
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<{
    files: string[];
    op: ConflictOp | null;
    targetBranch: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleRebaseBack = useCallback(async () => {
    setLoading(true);
    setError(null);
    setConflict(null);
    try {
      const result = await attemptsApi.rebaseBack(worktreeId, repoId);
      if (!result.success) {
        const err = result.error as GitOperationError;
        if (err.type === 'merge_conflicts') {
          setConflict({
            files: [...err.conflicted_files],
            op: err.op ?? null,
            targetBranch: err.target_branch,
          });
        } else if (err.type === 'rebase_in_progress') {
          setError('Rebase is already in progress.');
        } else {
          setError('Rebase failed.');
        }
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
    } finally {
      setLoading(false);
    }
  }, [worktreeId, repoId, queryClient]);

  const handleSendToAI = useCallback(() => {
    // TODO: integrate with AI chat to send conflict info
    setConflict(null);
  }, []);

  const handleAbort = useCallback(async () => {
    await attemptsApi.rebaseBack(worktreeId, repoId);
    setConflict(null);
    queryClient.invalidateQueries({ queryKey: ['branchStatus'] });
  }, [worktreeId, repoId, queryClient]);

  const handleOpenEditor = useCallback(() => {
    // Open file in editor — reuse existing pattern
  }, []);

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="outline" size="sm" className="h-5 text-[10px] px-1.5" onClick={handleRebaseBack} disabled={loading}>
        Rebase Back
      </Button>
      {error && <span className="text-[9px] text-destructive">{error}</span>}
      {conflict && (
        <ConflictBanner
          attemptBranch={null}
          baseBranch={conflict.targetBranch}
          conflictedFiles={conflict.files}
          op={conflict.op}
          onOpenEditor={handleOpenEditor}
          onAbort={handleAbort}
          onResolve={handleSendToAI}
          enableResolve={true}
          enableAbort={true}
        />
      )}
    </div>
  );
}
```

注意：`onResolve` 在 ConflictBanner 中渲染为 "Resolve conflicts" 按钮。需要将该按钮文案改为"发送给AI"。最简单的方式是给 ConflictBanner 新增一个可选 `resolveLabel` prop，默认为 "Resolve conflicts"。

**Step 2: 给 ConflictBanner 添加 resolveLabel prop**

修改 `frontend/src/components/tasks/ConflictBanner.tsx`:

Props 接口（第6-16行）添加一行：
```tsx
resolveLabel?: string;
```

函数参数解构中添加 `resolveLabel`，然后第105行按钮文字：
```tsx
// 找到：
Resolve conflicts
// 改为：
{resolveLabel ?? 'Resolve conflicts'}
```

**Step 3: 在 RebaseBackButton 中传入 resolveLabel**

```tsx
<ConflictBanner
  ...
  onResolve={handleSendToAI}
  resolveLabel="发送给AI"
  ...
/>
```

**Step 4: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add frontend/src/components/layout/BranchInfoHeader.tsx frontend/src/components/tasks/ConflictBanner.tsx
git commit -m "fix: show ConflictBanner with send-to-AI option when rebase-back encounters conflicts"
```

---

## Task 2: Diff 标签页按钮颜色改为黑色

**Files:**
- Modify: `frontend/src/components/ui/toggle-group.tsx`

**Context:** 当前 `toggleGroupItemVariants`（第8-22行）：
- 激活态: `bg-primary text-primary-foreground` → 蓝色背景白色图标
- 非激活态: `text-primary-foreground/70` → 白色半透明，在白色背景下不可见

**Step 1: 修改颜色变体**

在 `toggle-group.tsx` 第8-22行，将：

```tsx
const toggleGroupItemVariants = cva(
  'inline-flex h-4 w-4 items-center justify-center rounded-sm text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      active: {
        true: 'bg-primary text-primary-foreground',
        false:
          'text-primary-foreground/70 hover:bg-accent hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      active: false,
    },
  }
);
```

改为：

```tsx
const toggleGroupItemVariants = cva(
  'inline-flex h-4 w-4 items-center justify-center rounded-sm text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      active: {
        true: 'bg-foreground/10 text-foreground',
        false:
          'text-foreground/50 hover:bg-accent hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      active: false,
    },
  }
);
```

**Step 2: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

**Step 3: Commit**

```bash
git add frontend/src/components/ui/toggle-group.tsx
git commit -m "fix: change diff toggle button colors to foreground-based for visibility"
```

---

## Task 3: 左栏宽度溢出 — 使用 dockview setSize API

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Context:** 当前 `onDidLayoutChange` 回调（第321-335行）通过 `(leftGroup as any).element.style.maxWidth = '300px'` 操作 DOM，但 dockview 内部重排会覆盖内联样式，不可靠。应改为使用 dockview 原生 `group.api.setSize({ width: 300 })`。

`DockviewGroupPanelApi` 继承 `GridviewPanelApi`，有 `setSize(event: SizeEvent): void` 方法，`SizeEvent = { width?: number; height?: number }`。group 还有 `api.width` getter 获取当前宽度。

**Step 1: 修改 onDidLayoutChange 回调**

将第321-328行：

```typescript
const layoutDisposable = api.onDidLayoutChange(() => {
  const leftGroup = api.groups.find((g) => g.id === GROUP_IDS.LEFT);
  if (leftGroup) {
    const el = (leftGroup as any).element as HTMLElement | undefined;
    if (el && el.getBoundingClientRect().width > 300) {
      el.style.maxWidth = '300px';
    }
  }
```

改为：

```typescript
const layoutDisposable = api.onDidLayoutChange(() => {
  const leftGroup = api.groups.find((g) => g.id === GROUP_IDS.LEFT);
  if (leftGroup && leftGroup.api.width > 300) {
    leftGroup.api.setSize({ width: 300 });
  }
```

**Step 2: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

注意：如果 TypeScript 报 `leftGroup.api.width` 不存在，可能需要检查 dockview 的类型定义。`DockviewGroupPanel` 的 `api` 属性类型是 `DockviewGroupPanelApi`，它继承自 `GridviewPanelApi` 并有 `width` getter。如果有类型问题，使用 `(leftGroup.api as any).width` 和 `(leftGroup.api as any).setSize(...)` 绕过。

**Step 3: Commit**

```bash
git add frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: use dockview setSize API instead of DOM manipulation to clamp left panel width"
```

---

## Task 4: 字体本地化 — IBM Plex Sans/Mono woff2

**Files:**
- Create: `frontend/public/fonts/` 目录
- Create: `frontend/src/styles/fonts.css`
- Modify: `frontend/src/styles/legacy/index.css`
- Modify: `frontend/src/styles/new/index.css`
- Modify: `frontend/src/styles/legacy/index.css` (`.legacy-design` 添加 antialiased)
- Modify: `frontend/src/components/git/CommitGraph.tsx` — 移除 `tracking-tight`
- Modify: `frontend/src/components/layout/BranchInfoHeader.tsx` — 移除 `tracking-tight`

**Context:** IBM Plex Sans 和 IBM Plex Mono 当前通过 Google Fonts CDN 加载（`@import url('https://fonts.googleapis.com/css2?...')`），在国内环境无法访问，文本一直用系统回退字体渲染。需要将字体文件本地化。

**Step 1: 下载字体文件**

从 Google Fonts 的 GitHub 仓库下载 woff2 文件。IBM Plex 字体在 `https://github.com/IBM/plex/releases` 发布。

需要下载以下文件到 `frontend/public/fonts/`：
- `IBMPlexSans-Regular.woff2`
- `IBMPlexSans-Medium.woff2`
- `IBMPlexSans-SemiBold.woff2`
- `IBMPlexSans-Bold.woff2`
- `IBMPlexMono-Regular.woff2`
- `IBMPlexMono-Medium.woff2`
- `IBMPlexMono-SemiBold.woff2`
- `IBMPlexMono-Bold.woff2`

使用以下命令下载（如果 curl 可用）：

```bash
mkdir -p frontend/public/fonts

# IBM Plex Sans
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Sans/fonts/complete/woff2/IBMPlexSans-Regular.woff2" -o frontend/public/fonts/IBMPlexSans-Regular.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Sans/fonts/complete/woff2/IBMPlexSans-Medium.woff2" -o frontend/public/fonts/IBMPlexSans-Medium.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Sans/fonts/complete/woff2/IBMPlexSans-SemiBold.woff2" -o frontend/public/fonts/IBMPlexSans-SemiBold.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Sans/fonts/complete/woff2/IBMPlexSans-Bold.woff2" -o frontend/public/fonts/IBMPlexSans-Bold.woff2

# IBM Plex Mono
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Mono/fonts/complete/woff2/IBMPlexMono-Regular.woff2" -o frontend/public/fonts/IBMPlexMono-Regular.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Mono/fonts/complete/woff2/IBMPlexMono-Medium.woff2" -o frontend/public/fonts/IBMPlexMono-Medium.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Mono/fonts/complete/woff2/IBMPlexMono-SemiBold.woff2" -o frontend/public/fonts/IBMPlexMono-SemiBold.woff2
curl -L "https://github.com/IBM/plex/raw/master/IBM-Plex-Mono/fonts/complete/woff2/IBMPlexMono-Bold.woff2" -o frontend/public/fonts/IBMPlexMono-Bold.woff2
```

如果 GitHub 也不可达，可以从 npm 包获取：
```bash
cd frontend && npm install @ibm/plex --save-dev
# 然后从 node_modules/@ibm/plex/ 目录复制 woff2 文件到 public/fonts/
```

**Step 2: 创建 `frontend/src/styles/fonts.css`**

```css
/* IBM Plex Sans */
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/IBMPlexSans-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/IBMPlexSans-Medium.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/IBMPlexSans-SemiBold.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Sans';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/IBMPlexSans-Bold.woff2') format('woff2');
}

/* IBM Plex Mono */
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/IBMPlexMono-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/IBMPlexMono-Medium.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/IBMPlexMono-SemiBold.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/IBMPlexMono-Bold.woff2') format('woff2');
}
```

**Step 3: 修改 `frontend/src/styles/legacy/index.css`**

第1行，将：
```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,100..700;1,100..700&family=IBM+Plex+Mono:ital,wght@0,100..700;1,100..700&family=Noto+Emoji:wght@300..700&display=swap');
```
改为：
```css
@import '../fonts.css';
```

**Step 4: 修改 `frontend/src/styles/new/index.css`**

第1行，同样将 Google Fonts import 改为：
```css
@import '../fonts.css';
```

**Step 5: 在 `.legacy-design` 添加 antialiased**

在 `frontend/src/styles/legacy/index.css` 第212-214行，将：
```css
.legacy-design {
  @apply bg-background text-foreground font-sans;
}
```
改为：
```css
.legacy-design {
  @apply bg-background text-foreground font-sans antialiased;
}
```

**Step 6: 移除 CommitGraph.tsx 中的 tracking-tight**

在 `frontend/src/components/git/CommitGraph.tsx`：

第210行，将：
```tsx
<span className="text-[10px] font-mono tracking-tight text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
```
改为：
```tsx
<span className="text-[10px] font-mono text-muted-foreground w-14 shrink-0 group-hover:text-foreground">
```

第220行，将：
```tsx
className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono tracking-tight"
```
改为：
```tsx
className="shrink-0 ml-1 text-[9px] px-1 py-0.5 rounded bg-accent text-accent-foreground font-mono"
```

**Step 7: 移除 BranchInfoHeader.tsx 中的 tracking-tight**

在 `frontend/src/components/layout/BranchInfoHeader.tsx` 第30行，将：
```tsx
<span className="font-mono tracking-tight text-foreground truncate">HEAD</span>
```
改为：
```tsx
<span className="font-mono text-foreground truncate">HEAD</span>
```

**Step 8: TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

**Step 9: Commit**

```bash
git add frontend/public/fonts/ frontend/src/styles/fonts.css frontend/src/styles/legacy/index.css frontend/src/styles/new/index.css frontend/src/components/git/CommitGraph.tsx frontend/src/components/layout/BranchInfoHeader.tsx
git commit -m "fix: localize IBM Plex fonts to eliminate Google Fonts CDN dependency and fix character spacing"
```
