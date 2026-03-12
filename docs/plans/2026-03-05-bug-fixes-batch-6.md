# Bug Fixes Batch 6 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 bugs: left panel width overflow, commit hash character spacing, show diff crash, history loading incomplete, log stream missing backend, file browser empty on workspace switch.

**Architecture:** Fixes span frontend (React/TypeScript) and backend (Rust/Tauri). Each bug is independent — fix in order. Frontend bugs 1-4 and 6 are pure frontend. Bug 5 requires both Rust and TypeScript.

**Tech Stack:** React 18, TypeScript, Tauri v2, Rust, Dockview, TailwindCSS

---

## Bug 1: 左栏宽度超过 300px 上限

**Root cause:** In `PanelActionsContext.tsx`, `toggleFileTree` and `toggleGitPanel` search for the leftGroup by scanning `group.panels` for `LEFT_PANEL_IDS`. After `removePanel(gitPanel/fileTreePanel)`, the leftGroup becomes empty (0 panels), so `group.panels.some(...)` returns false, the group is not found, and a **new** group is created at `initialWidth: 300`. This re-creation allows the width to keep growing. Also no `maximumWidth` is enforced.

**Fix strategy:** Use `GROUP_IDS.LEFT` (already defined in `useLayoutStore.ts` as `'group-left'`) to track the left group by ID. Assign this ID when creating the group via `dockviewApi.addGroup()`. Look up by ID in `getGroupById` to avoid the "empty group" miss. Also add a CSS constraint to cap left panel width.

### Task 1: 在 PanelActionsContext.tsx 中用 ID 查找 leftGroup

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`

**Step 1: 读取当前文件，找到 LEFT_PANEL_IDS 和两个 toggle 函数**

Read the file around lines 240-330 to understand current implementation.

**Step 2: 修改 `toggleFileTree` 和 `toggleGitPanel` 中的 leftGroup 查找逻辑**

在两个函数中，将这段扫描逻辑：
```typescript
let leftGroup: ReturnType<typeof dockviewApi.addGroup> | undefined;
for (const group of dockviewApi.groups) {
  if (group.panels.some((p) => LEFT_PANEL_IDS.has(p.id))) {
    leftGroup = group;
    break;
  }
}
```

替换为通过 ID 查找：
```typescript
let leftGroup = dockviewApi.groups.find((g) => g.id === GROUP_IDS.LEFT);
```

同时在 `addGroup` 调用中添加 `id` 参数：
```typescript
leftGroup = dockviewApi.addGroup({
  id: GROUP_IDS.LEFT,          // ← 新增：固定 group ID
  referencePanel: centerRef,
  direction: 'left',
  hideHeader: true,
  initialWidth: 300,
});
```

注意：需要导入 `GROUP_IDS` from `@/stores/useLayoutStore`（如果尚未导入）。

**Step 3: 在 `buildDefaultLayout` (IDELayout.tsx) 中同样加 id**

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

找到 `buildDefaultLayout` 中的 `api.addGroup(...)` 调用（约第216-221行），添加 `id: GROUP_IDS.LEFT`：
```typescript
const leftGroup = api.addGroup({
  id: GROUP_IDS.LEFT,          // ← 新增
  referencePanel: welcomePanel,
  direction: 'left',
  hideHeader: true,
  initialWidth: 300,
});
```

**Step 4: 添加 CSS 最大宽度约束**

在 `IDELayout.tsx` 中找到 leftPanelWidth 相关的 style 或 CSS。

查找 `applyLeftGroupHeaderHiding` 函数，在该函数中或通过 CSS 全局样式添加约束。

在 IDELayout.tsx 的 dockview CSS string（如果存在）或在 global CSS 文件中添加：
```css
/* 限制左侧面板组的最大宽度 */
.dockview-groupview[data-group-id="group-left"] {
  max-width: 300px !important;
}
```

或者，在 `applyLeftGroupHeaderHiding` 函数中，在设置 element style 的地方同时设置 maxWidth：
```typescript
const leftGroupEl = leftGroupPanel?.element;
if (leftGroupEl) {
  leftGroupEl.style.maxWidth = '300px';
}
```

**Step 5: 运行 TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit
```
Expected: 0 errors.

**Step 6: Commit**

```bash
git add frontend/src/contexts/PanelActionsContext.tsx frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: use group ID to track left panel, prevent width overflow"
```

---

## Bug 2: Commit hash 和分支名称字符间有空格

**Root cause:** `tailwind.new.config.js` 定义了 `'ibm-plex-mono'` 但没有定义 `'mono'` 字体族。`.new-design` 作用域下 `font-mono` 无法映射到 IBM Plex Mono，回退到系统 monospace 字体，在极小字号（`text-[10px]`/`text-[9px]`）下字符间距异常大，视觉上出现字符分离。

### Task 2: 修复 tailwind.new.config.js 字体族定义

**Files:**
- Modify: `frontend/tailwind.new.config.js`

**Step 1: 读取当前 tailwind.new.config.js 的 fontFamily 部分**

找到 `fontFamily` 对象定义（约第 133-136 行）。

**Step 2: 添加 `mono` 字体族别名**

将：
```js
fontFamily: {
  'ibm-plex-sans': ['"IBM Plex Sans"', '"Noto Emoji"', 'sans-serif'],
  'ibm-plex-mono': ['"IBM Plex Mono"', 'monospace'],
},
```

改为：
```js
fontFamily: {
  'ibm-plex-sans': ['"IBM Plex Sans"', '"Noto Emoji"', 'sans-serif'],
  'ibm-plex-mono': ['"IBM Plex Mono"', '"Noto Emoji"', 'monospace'],
  'mono': ['"IBM Plex Mono"', '"Noto Emoji"', 'monospace'],
},
```

关键点：
1. 为 `ibm-plex-mono` 添加 `"Noto Emoji"` 作为 fallback（与 legacy 保持一致）
2. 新增 `mono` 别名，使 `font-mono` 类正确解析

**Step 3: Commit**

```bash
git add frontend/tailwind.new.config.js
git commit -m "fix: add font-mono alias to new Tailwind config for correct monospace rendering"
```

---

## Bug 3: Show Diff 按钮导致应用崩溃

**Root cause:** `DiffCard.tsx` 调用严格版 `useReview()`，当 `ReviewProvider` 不在祖先树中时直接抛出错误导致 React 崩溃。IDE 工作区 (`WorkspaceLayout.tsx`) 中没有 `ReviewProvider`，而 `DiffCard` 是通过 dockview 面板渲染的，在 `ReviewProvider` 外部。

**Fix:** 将 `ReviewProvider` 添加到 `WorkspaceLayout` 的 Provider 树中。由于 `ReviewProvider` 不依赖任何外部 context，这是安全的。

### Task 3: 在 WorkspaceLayout 中添加 ReviewProvider

**Files:**
- Modify: `frontend/src/components/layout/WorkspaceLayout.tsx`

**Step 1: 读取 WorkspaceLayout.tsx 全文**

**Step 2: 添加 ReviewProvider 导入**

```typescript
import { ReviewProvider } from '@/contexts/ReviewProvider';
```

**Step 3: 在 Provider 树中添加 ReviewProvider**

将：
```tsx
<WorktreeProvider>
  <WorktreeSyncFromUrl />
  <TerminalProvider>
    <PanelActionsProvider>
      <IDELayout ... />
    </PanelActionsProvider>
  </TerminalProvider>
</WorktreeProvider>
```

改为：
```tsx
<WorktreeProvider>
  <WorktreeSyncFromUrl />
  <ReviewProvider>
    <TerminalProvider>
      <PanelActionsProvider>
        <IDELayout ... />
      </PanelActionsProvider>
    </TerminalProvider>
  </ReviewProvider>
</WorktreeProvider>
```

注意：`ReviewProvider` 不需要传 `attemptId`（它是可选 prop），如果不传则评论状态不会随工作区切换自动清空，这是可接受的行为。

**Step 4: 运行 TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit
```
Expected: 0 errors.

**Step 5: Commit**

```bash
git add frontend/src/components/layout/WorkspaceLayout.tsx
git commit -m "fix: add ReviewProvider to WorkspaceLayout to prevent Show Diff crash"
```

---

## Bug 4: 加载历史记录无法完整加载

**Root cause:** `useConversationHistoryOld.ts` 中 `loadInitialEntries` 函数遍历历史进程时，早停条件 `flattenEntries(store).length > MIN_INITIAL_ENTRIES`（MIN = 10）只计算 `CodingAgent*` 和 `ReviewRequest` 类型的进程条目，排除了 `ScriptRequest` 类型。这导致在大量 ScriptRequest 历史进程存在时，循环提前 break，跳过了更早的消息历史。

**Fix:** 将 `loadInitialEntries` 的早停逻辑改为计算所有进程的条目总数，而不仅仅依赖 `flattenEntries`（它过滤了 ScriptRequest）。

### Task 4: 修复历史加载早停逻辑

**Files:**
- Modify: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts`

**Step 1: 读取 useConversationHistoryOld.ts 中 loadInitialEntries 函数（约 439-471 行）**

**Step 2: 修改早停条件**

找到 `loadInitialEntries` 中的早停逻辑：
```typescript
if (
  flattenEntries(localDisplayedExecutionProcesses).length >
  MIN_INITIAL_ENTRIES
) {
  break;
}
```

替换为统计所有进程条目总数（不过滤类型）：
```typescript
const totalEntries = Object.values(localDisplayedExecutionProcesses)
  .flatMap((p) => p.entries)
  .length;
if (totalEntries > MIN_INITIAL_ENTRIES) {
  break;
}
```

**Step 3: 同样修复 `loadRemainingEntriesInBatches` 中的批次计数（约 473-512 行）**

找到批次加载中同样使用 `flattenEntries` 计数的地方，用相同方式替换。

**Step 4: 运行 TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit
```
Expected: 0 errors.

**Step 5: Commit**

```bash
git add frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts
git commit -m "fix: count all process entries for history loading threshold, not just CodingAgent types"
```

---

## Bug 5: 运行服务器日志流 "Failed to connect"

**Root cause:** 前端 `useLogStream.ts` 调用 `subscribe_log_stream` Tauri 命令，但该命令在 Rust 后端完全不存在——既未在 `src-tauri/src/commands/events.rs` 中实现，也未注册到 `invoke_handler`。

**Fix:** 仿照 `subscribe_conversation_stream` 在 `events.rs` 中实现 `subscribe_log_stream`，然后在 `lib.rs` 注册。

### Task 5: 实现 Rust 后端 subscribe_log_stream 命令

**Files:**
- Modify: `src-tauri/src/commands/events.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 读取 `src-tauri/src/commands/events.rs` 中 subscribe_conversation_stream 实现（参考实现）**

参考实现（约 55-88 行）：
```rust
#[tauri::command]
pub async fn subscribe_conversation_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    execution_process_id: Uuid,
    normalized: Option<bool>,
) -> Result<(), AppError> {
    let channel = format!("conversation-stream:{}", execution_process_id);
    let deployment = state.deployment.clone();
    let use_normalized = normalized.unwrap_or(true);

    tokio::spawn(async move {
        let stream_opt = if use_normalized {
            deployment.container().stream_normalized_logs(&execution_process_id).await
        } else {
            deployment.container().stream_raw_logs(&execution_process_id).await
        };

        if let Some(mut stream) = stream_opt {
            while let Some(Ok(msg)) = stream.next().await {
                if app.emit(&channel, &msg).is_err() { break; }
            }
        }
    });
    Ok(())
}
```

**Step 2: 在 events.rs 中添加 subscribe_log_stream 函数**

前端 `useLogStream.ts` 监听的事件频道是 `log-stream:{processId}`，调用命令时传参为 `{ processId }`（snake_case 在 Tauri 会自动转换）。

在 `events.rs` 末尾添加：
```rust
#[tauri::command]
pub async fn subscribe_log_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    process_id: Uuid,
) -> Result<(), AppError> {
    let channel = format!("log-stream:{}", process_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        // 使用 stream_raw_logs 获取原始日志流（适合 dev server 输出）
        let stream_opt = deployment
            .container()
            .stream_raw_logs(&process_id)
            .await;

        if let Some(mut stream) = stream_opt {
            while let Some(Ok(msg)) = stream.next().await {
                if app.emit(&channel, &msg).is_err() {
                    break;
                }
            }
        }
    });
    Ok(())
}
```

**Step 3: 在 lib.rs 的 invoke_handler 中注册新命令**

找到 `src-tauri/src/lib.rs` 中 `commands::events::subscribe_conversation_stream,` 所在行，在其后添加：
```rust
commands::events::subscribe_log_stream,
```

**Step 4: 编译 Rust 后端检查**

```bash
cd src-tauri && cargo check
```
Expected: 0 errors.

**Step 5: 验证前端 useLogStream.ts 调用参数匹配**

检查 `frontend/src/hooks/useLogStream.ts` 中调用方式：
```typescript
await tauriInvoke('subscribe_log_stream', { processId });
```

Tauri 自动将 camelCase `processId` 转换为 snake_case `process_id`，与 Rust 参数名匹配。✓

**Step 6: Commit**

```bash
git add src-tauri/src/commands/events.rs src-tauri/src/lib.rs
git commit -m "fix: implement subscribe_log_stream Tauri command for dev server log streaming"
```

---

## Bug 6: 文件浏览器切换工作区后显示空目录

**Root cause:** `DockviewFileTreePanel.tsx` 中 `prevWorktreeIdRef.current` 在数据（`workspace`、`workspaceRepos`）加载完成之前就被更新为新的 `activeWorktreeId`。当异步数据到达后 effect 重跑时，`activeWorktreeId === prevWorktreeIdRef.current` 条件为 false，整个 if 块被跳过，`setRootPath` 永远不被调用，文件树显示空目录。

**Fix:** 将 `prevWorktreeIdRef.current = activeWorktreeId` 的赋值移到数据校验通过之后。

### Task 6: 修复文件浏览器竞态条件

**Files:**
- Modify: `frontend/src/components/panels/DockviewFileTreePanel.tsx`

**Step 1: 读取 DockviewFileTreePanel.tsx 全文（特别是 useEffect 部分，约第 44-62 行）**

**Step 2: 将 ref 更新移到数据校验之后**

当前代码（问题所在）：
```typescript
useEffect(() => {
  if (activeWorktreeId && activeWorktreeId !== prevWorktreeIdRef.current) {
    prevWorktreeIdRef.current = activeWorktreeId;  // ← 过早更新！

    if (workspace?.container_ref && workspaceRepos.length > 0) {
      const containerRef = workspace.container_ref;
      const repoName = workspaceRepos[0].name;
      const worktreePath = containerRef.replace(/[\\/]+$/, '') + '/' + repoName;
      setRootPath(worktreePath);
    }
  }
}, [activeWorktreeId, workspace, workspaceRepos, repos, setRootPath]);
```

修复后：
```typescript
useEffect(() => {
  if (activeWorktreeId && activeWorktreeId !== prevWorktreeIdRef.current) {
    if (workspace?.container_ref && workspaceRepos.length > 0) {
      const containerRef = workspace.container_ref;
      const repoName = workspaceRepos[0].name;
      const worktreePath = containerRef.replace(/[\\/]+$/, '') + '/' + repoName;
      setRootPath(worktreePath);
      prevWorktreeIdRef.current = activeWorktreeId;  // ← 移到成功设置路径之后
    }
    // 如果数据尚未加载，不更新 ref，等待下次 effect 重跑
  }
}, [activeWorktreeId, workspace, workspaceRepos, repos, setRootPath]);
```

**Step 3: 运行 TypeScript 检查**

```bash
cd frontend && npx tsc --noEmit
```
Expected: 0 errors.

**Step 4: Commit**

```bash
git add frontend/src/components/panels/DockviewFileTreePanel.tsx
git commit -m "fix: update prevWorktreeIdRef only after successfully setting root path"
```

---

## 最终验证

```bash
# 前端 TypeScript 全量检查
cd frontend && npx tsc --noEmit

# Rust 后端编译检查
cd src-tauri && cargo check
```

验证所有 6 个 bug 的行为：
1. 文件管理器 ↔ Git 管理器切换多次后，左栏宽度保持 ≤ 300px
2. Git 提交图中 commit hash 和分支名正常显示（无字符间空格）
3. 点击"查看 Git Diff"不再崩溃，正确打开 diff 标签页
4. Loading History 能加载完整历史消息
5. 运行开发服务器后，日志终端显示实际日志而非 "Failed to connect"
6. 切换工作区后文件浏览器正确显示文件目录
