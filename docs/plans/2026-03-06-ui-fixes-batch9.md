# UI Fixes Batch 9 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 UI issues: left panel width overflow, terminal invasion, broken branch switch, old selectors in retry/create dialogs, missing rollback button, and broken enabledPlugins reading.

**Architecture:** Frontend-only fixes except Issue 6 (requires Rust struct change + frontend type sync). All changes are isolated and independent — each task can be committed separately.

**Tech Stack:** React + TypeScript (frontend), Rust + Tauri v2 (backend), dockview-react (panel layout), @tanstack/react-query, @ebay/nice-modal-react

---

## Task 1: Fix Left Panel Width Overflow on Center Panel Close

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Context:**
The `onDidLayoutChange` callback at line ~321 only serializes layout. When center panels are hidden via `group.api.setVisible(false)`, dockview redistributes space and can expand the left panel beyond a reasonable width. The left group has `GROUP_IDS.LEFT = 'group-left'` and initial width of 300px.

**Step 1: Read the current onDidLayoutChange block**

Open `frontend/src/components/layout/IDELayout.tsx` and find the `onDidLayoutChange` callback (around line 321). It currently looks like:

```ts
const layoutDisposable = api.onDidLayoutChange(() => {
  try {
    setSerializedLayout(api.toJSON());
  } catch {
    // Ignore serialization errors during transitions
  }
  setLayoutVersion((v) => v + 1);
});
```

**Step 2: Add width clamp inside onDidLayoutChange**

Replace that block with:

```ts
const layoutDisposable = api.onDidLayoutChange(() => {
  try {
    setSerializedLayout(api.toJSON());
  } catch {
    // Ignore serialization errors during transitions
  }
  setLayoutVersion((v) => v + 1);

  // Clamp left panel width: prevent it from expanding beyond 40% of container
  // when center panels are hidden/resized
  try {
    const leftGroup = api.getGroup(GROUP_IDS.LEFT);
    if (leftGroup && leftGroup.api.isVisible) {
      const containerWidth = api.width;
      const leftWidth = leftGroup.api.width;
      const maxLeftWidth = containerWidth * 0.4;
      if (leftWidth > maxLeftWidth && maxLeftWidth > 200) {
        leftGroup.api.setSize({ width: Math.min(leftWidth, 300) });
      }
    }
  } catch {
    // Ignore resize errors during transitions
  }
});
```

**Step 3: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Commit**

```bash
git add frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: clamp left panel width when center panels are hidden"
```

---

## Task 2: Fix Terminal Panel Invading Left Panel

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Context:**
The `registerDndGuard` prevents panels being *dragged* into the left group. But the bottom group (terminal) can still visually overlap left panel when the user drags the sash. The fix is to also guard against the left group receiving any overlay from bottom group panels.

**Step 1: Read the registerDndGuard function**

In `IDELayout.tsx` find `registerDndGuard` (around line 242). Currently it checks if the target is the left group and prevents non-left panels from being dropped. We need to also guard against panels from groups that should stay in the bottom area.

**Step 2: Update registerDndGuard to also guard bottom group**

Find the existing guard block inside `registerDndGuard`:
```ts
if (isTargetLeftGroup && ev.panel) {
  const draggedId = ev.panel.id;
  if (draggedId !== PANEL_IDS.FILE_TREE && draggedId !== PANEL_IDS.GIT) {
    event.preventDefault();
  }
}
```

Replace with:
```ts
if (isTargetLeftGroup && ev.panel) {
  const draggedId = ev.panel.id;
  if (draggedId !== PANEL_IDS.FILE_TREE && draggedId !== PANEL_IDS.GIT) {
    event.preventDefault();
    return;
  }
}

// Also prevent left-group panels from being dropped into non-left groups
// that would cause the terminal/bottom to span under the left panel
const draggedPanelId = ev.panel?.id;
const isSourceLeftPanel =
  draggedPanelId === PANEL_IDS.FILE_TREE ||
  draggedPanelId === PANEL_IDS.GIT;
const isTargetBottomGroup =
  targetGroup.id === GROUP_IDS.BOTTOM ||
  targetGroup.panels.some((p: { id: string }) => p.id === PANEL_IDS.TERMINAL);
if (isSourceLeftPanel && isTargetBottomGroup) {
  event.preventDefault();
}
```

**Step 3: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Commit**

```bash
git add frontend/src/components/layout/IDELayout.tsx
git commit -m "fix: prevent terminal panel from invading left sidebar area"
```

---

## Task 3: Fix "切换目标分支" Button (Change Target Branch)

**Files:**
- Modify: `frontend/src/components/layout/BranchInfoHeader.tsx`

**Context:**
`BranchInfoHeader.tsx` has a `TargetBranchDropdown` component with `handleChangeTarget` that is a stub (empty async function with only a TODO comment). The full working implementation exists in `GitOperations.tsx`:
1. Fetch branches via `useRepoBranches`
2. Open `ChangeTargetBranchDialog.show({ branches, isChangingTargetBranch })`
3. On confirm, call `useChangeTargetBranch` mutation

The `BranchInfoHeader` receives `worktreeId` (workspace ID) and `repo` (with `repo_id`).

**Step 1: Read BranchInfoHeader.tsx fully**

Confirm the `TargetBranchDropdown` function signature and what imports are present at top of file.

**Step 2: Add required imports to BranchInfoHeader.tsx**

At the top of the file, add these imports (after existing imports):
```ts
import { useRepoBranches } from '@/hooks/useRepoBranches';
import { useChangeTargetBranch } from '@/hooks/useChangeTargetBranch';
import { ChangeTargetBranchDialog } from '@/components/dialogs/tasks/ChangeTargetBranchDialog';
```

**Step 3: Replace the stub TargetBranchDropdown with working implementation**

Replace the entire `TargetBranchDropdown` function with:

```tsx
function TargetBranchDropdown({ repo, worktreeId }: { repo: RepoBranchStatus; worktreeId: string }) {
  const { data: branches = [] } = useRepoBranches(repo.repo_id);

  const changeTargetBranch = useChangeTargetBranch(worktreeId, repo.repo_id);
  const isChangingTargetBranch = changeTargetBranch.isPending;

  const handleChangeTarget = useCallback(async () => {
    try {
      const result = await ChangeTargetBranchDialog.show({
        branches,
        isChangingTargetBranch,
      });
      if (result.action === 'confirmed' && result.branchName) {
        changeTargetBranch.mutate({
          newTargetBranch: result.branchName,
          repoId: repo.repo_id,
        });
      }
    } catch {
      // Dialog was dismissed
    }
  }, [branches, isChangingTargetBranch, changeTargetBranch, repo.repo_id]);

  const handleRebase = useCallback(async () => {
    await attemptsApi.rebase(worktreeId, { repo_id: repo.repo_id, old_base_branch: null, new_base_branch: null });
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
        <DropdownMenuItem onSelect={handleChangeTarget} disabled={isChangingTargetBranch}>
          {isChangingTargetBranch ? '切换中...' : '切换目标分支'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRebase}>
          Rebase
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

**Step 4: Verify ChangeTargetBranchDialog.show() signature**

Check `frontend/src/components/dialogs/tasks/ChangeTargetBranchDialog.tsx` to confirm the props it accepts. If it doesn't match the `GitOperations.tsx` pattern, adjust accordingly.

**Step 5: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 6: Commit**

```bash
git add frontend/src/components/layout/BranchInfoHeader.tsx
git commit -m "fix: implement change target branch in BranchInfoHeader"
```

---

## Task 4: Replace Old Variant Selector in RetryEditorInline

**Files:**
- Modify: `frontend/src/components/NormalizedConversation/RetryEditorInline.tsx`

**Context:**
`RetryEditorInline.tsx` currently shows `VariantSelector` (which displays DEFAULT/PLAN/OPUS/APPROVALS variant names). The requirement is to replace it with the same three selectors used in `TaskFollowUpSection`:
- `PermissionSelector` (auto/ask/plan → maps to DEFAULT/APPROVALS/PLAN)
- `ModelSelector` (default/haiku/sonnet/opus → opus maps to OPUS variant)
- `PluginSelector` (from enabledPlugins)

The variant sent to `retryMutation.mutate()` must be computed from these three selectors using the same logic as `TaskFollowUpSection.tsx`:
```ts
const selectedVariant = useMemo(() => {
  if (selectedModelKey === 'opus') return 'OPUS';
  switch (permissionMode) {
    case 'auto': return 'DEFAULT';
    case 'plan': return 'PLAN';
    case 'ask':
    default: return 'APPROVALS';
  }
}, [selectedModelKey, permissionMode]);
```

**Step 1: Update imports in RetryEditorInline.tsx**

Replace the `VariantSelector` import:
```ts
// REMOVE:
import { VariantSelector } from '@/components/tasks/VariantSelector';

// ADD:
import { PermissionSelector, type PermissionMode } from '@/components/tasks/PermissionSelector';
import { ModelSelector, type ModelKey } from '@/components/tasks/ModelSelector';
import { PluginSelector } from '@/components/tasks/PluginSelector';
```

Also remove unused imports: `useUserSystem` (if it was only used for profiles passed to VariantSelector) and `useVariant` hook.

**Step 2: Replace state/logic in RetryEditorInline.tsx**

Remove:
```ts
const { profiles } = useUserSystem();
// ...
const { selectedVariant, setSelectedVariant } = useVariant({
  processVariant: processProfile?.variant ?? null,
  scratchVariant: undefined,
});
```

Add:
```ts
const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
const [selectedModelKey, setSelectedModelKey] = useState<ModelKey>('default');
const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);

const selectedVariant = useMemo(() => {
  if (selectedModelKey === 'opus') return 'OPUS';
  switch (permissionMode) {
    case 'auto': return 'DEFAULT';
    case 'plan': return 'PLAN';
    case 'ask':
    default: return 'APPROVALS';
  }
}, [selectedModelKey, permissionMode]);
```

**Step 3: Replace VariantSelector JSX with three selectors**

Find the JSX block containing `<VariantSelector ... />`:
```tsx
<VariantSelector
  selectedVariant={selectedVariant}
  onChange={setSelectedVariant}
  currentProfile={profiles?.[attempt.session?.executor ?? ''] ?? null}
/>
```

Replace with:
```tsx
<PermissionSelector
  value={permissionMode}
  onChange={setPermissionMode}
  disabled={isSending}
/>
<ModelSelector
  value={selectedModelKey}
  onChange={setSelectedModelKey}
  disabled={isSending}
/>
<PluginSelector
  value={selectedPlugin}
  onChange={setSelectedPlugin}
  disabled={isSending}
/>
```

**Step 4: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors. If `useUserSystem` or `useVariant` become unused, remove their imports too.

**Step 5: Commit**

```bash
git add frontend/src/components/NormalizedConversation/RetryEditorInline.tsx
git commit -m "feat: replace VariantSelector with three selectors in RetryEditorInline"
```

---

## Task 5: Replace Selectors in TaskFormDialog and CreateAttemptDialog

**Files:**
- Modify: `frontend/src/components/dialogs/tasks/TaskFormDialog.tsx`
- Modify: `frontend/src/components/dialogs/tasks/CreateAttemptDialog.tsx`

**Context:**
Both dialogs use `ExecutorProfileSelector` which includes `AgentSelector` (executor type) + `ConfigSelector` (variant). The `AgentSelector` part (selecting CLAUDE_CODE vs other executors) must be **kept** — that's the agent/executor selection. Only the `ConfigSelector` (variant picker) should be replaced.

However, `ExecutorProfileSelector` is a composite that wraps both together and passes a single `ExecutorProfileId` back. We need to split them:
- Keep `AgentSelector` to let user pick executor
- Replace `ConfigSelector` with `PermissionSelector` + `ModelSelector`
- Compute the final `ExecutorProfileId.variant` from the two new selectors

For `PluginSelector`, plugins are globally configured in `~/.claude/settings.json` and don't need to be passed through `ExecutorProfileId`. Adding it as a visual indicator is acceptable but it won't affect the executor profile passed to the API.

**Note on TaskFormDialog:** The `ExecutorProfileSelector` is only shown when `autoStart` is true (lines that check `autoStartField.state.value`). The `executorProfileId` field holds an `ExecutorProfileId | null`. We need to maintain this shape but compute the variant from the new selectors.

**Step 1: Update TaskFormDialog.tsx imports**

Remove:
```ts
import { ExecutorProfileSelector } from '@/components/settings';
```

Add:
```ts
import { AgentSelector } from '@/components/tasks/AgentSelector';
import { PermissionSelector, type PermissionMode } from '@/components/tasks/PermissionSelector';
import { ModelSelector, type ModelKey } from '@/components/tasks/ModelSelector';
import { PluginSelector } from '@/components/tasks/PluginSelector';
```

**Step 2: Add local selector state in TaskFormDialog.tsx**

Inside the `TaskFormDialogImpl` component, after existing state declarations, add:
```ts
const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
const [selectedModelKey, setSelectedModelKey] = useState<ModelKey>('default');
const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);

// Compute variant from permission + model selectors (same logic as TaskFollowUpSection)
const computedVariant = useMemo(() => {
  if (selectedModelKey === 'opus') return 'OPUS';
  switch (permissionMode) {
    case 'auto': return 'DEFAULT';
    case 'plan': return 'PLAN';
    case 'ask':
    default: return 'APPROVALS';
  }
}, [selectedModelKey, permissionMode]);
```

**Step 3: Replace ExecutorProfileSelector JSX in TaskFormDialog**

Find the `ExecutorProfileSelector` usage in the form (inside the `autoStart` field render):
```tsx
<ExecutorProfileSelector
  profiles={profiles}
  selectedProfile={field.state.value}
  onProfileSelect={(profile) => field.handleChange(profile)}
  disabled={isSubmitting || !autoStartField.state.value}
  showLabel={false}
  className="flex items-center gap-2 flex-row flex-[2] min-w-0"
  itemClassName="flex-1 min-w-0"
/>
```

Replace with:
```tsx
<form.Field name="executorProfileId">
  {(field) => (
    <div className="flex items-center gap-1 flex-[2] min-w-0">
      <AgentSelector
        profiles={profiles}
        selectedExecutorProfile={field.state.value}
        onChange={(profile) =>
          field.handleChange({ ...profile, variant: computedVariant })
        }
        disabled={isSubmitting || !autoStartField.state.value}
        showLabel={false}
        className="flex-1 min-w-0"
      />
      <PermissionSelector
        value={permissionMode}
        onChange={(mode) => {
          setPermissionMode(mode);
          if (field.state.value) {
            field.handleChange({ ...field.state.value, variant: computedVariant });
          }
        }}
        disabled={isSubmitting || !autoStartField.state.value}
      />
      <ModelSelector
        value={selectedModelKey}
        onChange={(key) => {
          setSelectedModelKey(key);
          if (field.state.value) {
            field.handleChange({ ...field.state.value, variant: computedVariant });
          }
        }}
        disabled={isSubmitting || !autoStartField.state.value}
      />
      <PluginSelector
        value={selectedPlugin}
        onChange={setSelectedPlugin}
        disabled={isSubmitting || !autoStartField.state.value}
      />
    </div>
  )}
</form.Field>
```

**Note:** There's a timing issue — `computedVariant` won't reflect the new state immediately when onChange fires. Fix by computing inline:

```tsx
onChange={(mode) => {
  setPermissionMode(mode);
  if (field.state.value) {
    const v = selectedModelKey === 'opus' ? 'OPUS'
      : mode === 'auto' ? 'DEFAULT'
      : mode === 'plan' ? 'PLAN'
      : 'APPROVALS';
    field.handleChange({ ...field.state.value, variant: v });
  }
}}
```

Apply same inline computation for ModelSelector's onChange.

**Step 4: Update CreateAttemptDialog.tsx imports**

Same as Task 5 Step 1 — remove `ExecutorProfileSelector` import, add four new imports.

**Step 5: Add selector state in CreateAttemptDialog.tsx**

After `const [userSelectedProfile, setUserSelectedProfile] = useState...`, add:
```ts
const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
const [selectedModelKey, setSelectedModelKey] = useState<ModelKey>('default');
const [selectedPlugin, setSelectedPlugin] = useState<string | null>(null);
```

**Step 6: Replace ExecutorProfileSelector in CreateAttemptDialog JSX**

Find:
```tsx
{profiles && (
  <div className="space-y-2">
    <ExecutorProfileSelector
      profiles={profiles}
      selectedProfile={effectiveProfile}
      onProfileSelect={setUserSelectedProfile}
      showLabel={true}
    />
  </div>
)}
```

Replace with:
```tsx
{profiles && (
  <div className="space-y-2">
    <div className="flex items-center gap-1 flex-wrap">
      <AgentSelector
        profiles={profiles}
        selectedExecutorProfile={effectiveProfile}
        onChange={(profile) => {
          const v = selectedModelKey === 'opus' ? 'OPUS'
            : permissionMode === 'auto' ? 'DEFAULT'
            : permissionMode === 'plan' ? 'PLAN'
            : 'APPROVALS';
          setUserSelectedProfile({ ...profile, variant: v });
        }}
        showLabel={true}
      />
      <PermissionSelector
        value={permissionMode}
        onChange={(mode) => {
          setPermissionMode(mode);
          if (effectiveProfile) {
            const v = selectedModelKey === 'opus' ? 'OPUS'
              : mode === 'auto' ? 'DEFAULT'
              : mode === 'plan' ? 'PLAN'
              : 'APPROVALS';
            setUserSelectedProfile({ ...effectiveProfile, variant: v });
          }
        }}
      />
      <ModelSelector
        value={selectedModelKey}
        onChange={(key) => {
          setSelectedModelKey(key);
          if (effectiveProfile) {
            const v = key === 'opus' ? 'OPUS'
              : permissionMode === 'auto' ? 'DEFAULT'
              : permissionMode === 'plan' ? 'PLAN'
              : 'APPROVALS';
            setUserSelectedProfile({ ...effectiveProfile, variant: v });
          }
        }}
      />
      <PluginSelector
        value={selectedPlugin}
        onChange={setSelectedPlugin}
      />
    </div>
  </div>
)}
```

**Step 7: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 8: Commit**

```bash
git add frontend/src/components/dialogs/tasks/TaskFormDialog.tsx frontend/src/components/dialogs/tasks/CreateAttemptDialog.tsx
git commit -m "feat: replace ExecutorProfileSelector with three selectors in create/attempt dialogs"
```

---

## Task 6: Add Rollback Button to UserMessage

**Files:**
- Modify: `frontend/src/components/NormalizedConversation/UserMessage.tsx`

**Context:**
Backend `reset_session_process` Tauri command and frontend `sessionsApi.reset()` are already fully implemented but never called from UI. The goal is to add an `Undo2` icon button next to the edit (retry) icon in `UserMessage`.

When clicked:
1. Show `RestoreLogsDialog` (same dialog as retry, asks about git reset options)
2. On confirm, call `sessionsApi.reset(sessionId, { process_id, force_when_dirty, perform_git_reset })`
3. No editor, no new message — pure rollback

The `UserMessage` component receives `taskAttempt: WorkspaceWithSession` which has `taskAttempt.session?.id` for `sessionId`.

**Step 1: Add imports to UserMessage.tsx**

Add these imports:
```ts
import { Undo2 } from 'lucide-react';
import { sessionsApi } from '@/lib/api';
import { RestoreLogsDialog } from '@/components/dialogs';
import { useBranchStatus } from '@/hooks/useBranchStatus';
```

**Step 2: Add rollback state and handler**

Inside `UserMessage`, after existing state declarations, add:
```ts
const [isRollingBack, setIsRollingBack] = useState(false);
const { data: branchStatus } = useBranchStatus(taskAttempt?.id);

const handleRollback = useCallback(async () => {
  if (!executionProcessId || !taskAttempt?.session?.id) return;
  setIsRollingBack(true);
  try {
    const processes = []; // RestoreLogsDialog only needs executionProcessId + branchStatus
    let modalResult;
    try {
      modalResult = await RestoreLogsDialog.show({
        executionProcessId,
        branchStatus,
        processes,
      });
    } catch {
      return; // Dialog cancelled
    }
    if (!modalResult || modalResult.action !== 'confirmed') return;

    await sessionsApi.reset(taskAttempt.session.id, {
      process_id: executionProcessId,
      force_when_dirty: modalResult.forceWhenDirty ?? false,
      perform_git_reset: modalResult.performGitReset ?? true,
    });
  } catch (err) {
    console.error('Failed to rollback:', err);
  } finally {
    setIsRollingBack(false);
  }
}, [executionProcessId, taskAttempt, branchStatus]);
```

**Step 3: Add rollback button to JSX**

In the `WYSIWYGEditor` block (the non-editing view), the editor is shown with `onEdit={canRetry ? startRetry : undefined}`. The `WYSIWYGEditor` renders an edit icon when `onEdit` is provided.

We need to add the rollback button adjacent to the editor. Find the JSX block (not the `showRetryEditor` branch):

```tsx
<WYSIWYGEditor
  value={content}
  disabled
  className="whitespace-pre-wrap break-words flex flex-col gap-1"
  taskAttemptId={taskAttempt?.id}
  onEdit={canRetry ? startRetry : undefined}
/>
```

Replace with:
```tsx
<div className="relative group">
  <WYSIWYGEditor
    value={content}
    disabled
    className="whitespace-pre-wrap break-words flex flex-col gap-1"
    taskAttemptId={taskAttempt?.id}
    onEdit={canRetry ? startRetry : undefined}
  />
  {canRetry && (
    <button
      onClick={handleRollback}
      disabled={isRollingBack}
      className="absolute bottom-0 right-8 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
      title="回退到此消息（不重新发送）"
      aria-label="回退"
    >
      <Undo2 className="h-3.5 w-3.5" />
    </button>
  )}
</div>
```

**Note:** Check where the existing edit button renders (inside `WYSIWYGEditor`) to ensure the `Undo2` button is placed in a non-overlapping position. You may need to adjust `right-8` offset to not collide with the edit icon.

**Step 4: Add `useCallback` to imports if not already imported**

Check top of file: `import { useState } from 'react';` — add `useCallback` to this import.

**Step 5: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 6: Commit**

```bash
git add frontend/src/components/NormalizedConversation/UserMessage.tsx
git commit -m "feat: add rollback button to user messages without re-sending"
```

---

## Task 7: Fix enabledPlugins Reading (Object vs Array)

**Files:**
- Modify: `src-tauri/src/commands/config.rs`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/components/tasks/PluginSelector.tsx`

**Context:**
`~/.claude/settings.json` has:
```json
"enabledPlugins": {
  "glm-plan-usage@zai-coding-plugins": true,
  "glm-plan-bug@zai-coding-plugins": true,
  "superpowers@claude-plugins-official": true,
  "superpowers@superpowers-marketplace": true
}
```

But Rust deserializes `enabled_plugins` as `Vec<String>` (expects array), so it fails silently and returns empty. Fix: change to `HashMap<String, bool>`.

The frontend type must match: change `enabled_plugins: string[]` to `enabled_plugins: Record<string, boolean>`.

The `PluginSelector` must then extract enabled plugins with `Object.entries(plugins).filter(([,v])=>v).map(([k])=>k)`.

**Step 1: Update Rust ClaudeSettings struct**

In `src-tauri/src/commands/config.rs`, find the `ClaudeSettings` struct:
```rust
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    pub enabled_plugins: Vec<String>,
}
```

Replace with:
```rust
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ClaudeSettings {
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, rename = "enabledPlugins")]
    pub enabled_plugins: HashMap<String, bool>,
}
```

**Step 2: Check if update_claude_settings uses enabled_plugins**

In `update_claude_settings`, find where `enabled_plugins` is written back to JSON. It uses `serde_json::to_value(&settings.enabled_plugins)` — since `HashMap<String, bool>` serializes to a JSON object, this will still be correct.

**Step 3: Update frontend ClaudeSettings type in api.ts**

Find in `frontend/src/lib/api.ts`:
```ts
export interface ClaudeSettings {
  env: Record<string, string>;
  enabled_plugins: string[];
}
```

Replace with:
```ts
export interface ClaudeSettings {
  env: Record<string, string>;
  enabled_plugins: Record<string, boolean>;
}
```

**Step 4: Update PluginSelector to handle Record type**

In `frontend/src/components/tasks/PluginSelector.tsx`, find:
```ts
const plugins = settings?.enabled_plugins ?? [];
```

Replace with:
```ts
const pluginsMap = settings?.enabled_plugins ?? {};
const plugins = Object.entries(pluginsMap)
  .filter(([, enabled]) => enabled)
  .map(([name]) => name);
```

**Step 5: Build Rust to verify no compilation errors**

```bash
cd src-tauri && cargo check 2>&1 | tail -20
```
Expected: no errors (or only warnings)

**Step 6: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 7: Commit**

```bash
git add src-tauri/src/commands/config.rs frontend/src/lib/api.ts frontend/src/components/tasks/PluginSelector.tsx
git commit -m "fix: correctly parse enabledPlugins as object map from ~/.claude/settings.json"
```

---

## Execution Order

Tasks 1, 2, 3 are fully independent — can be done in any order.
Tasks 4, 5 depend on Task 4's selector pattern being stable.
Task 6 is independent.
Task 7 is independent but foundational — do it first if PluginSelector is tested.

**Recommended order:** 7 → 1 → 2 → 3 → 4 → 5 → 6

---

## Verification

After all tasks, run:
```bash
cd frontend && npx tsc --noEmit && echo "TS OK"
cd src-tauri && cargo check && echo "Rust OK"
```
