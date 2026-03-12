# UI Fixes Batch 4 — Layout & Right Panel UX Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul the IDE layout and right panel UX — adjust panel widths, redesign terminal tabs, move center toggles to toolbar, fix history loading, improve dev server config UX, and beautify file edit display.

**Architecture:** 8 independent UI tasks touching layout stores, dockview panels, conversation history hooks, and display components. Each task is self-contained and can be implemented by a fresh subagent with zero cross-task dependencies.

**Tech Stack:** React, TypeScript, TailwindCSS, Zustand, Dockview, xterm.js, shadcn/ui Dialog

---

## Task 1: Right Panel Min Width → 480px

**Files:**
- Modify: `frontend/src/stores/useLayoutStore.ts:64-65`

**Changes:**

Change line 65 from:
```typescript
const MIN_RIGHT_PANEL_WIDTH = 450;
```
to:
```typescript
const MIN_RIGHT_PANEL_WIDTH = 480;
```

That's it. Single constant change.

---

## Task 2: Left Panel Default Width → 300px

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx:275,324` (initialWidth in toggleFileTree and toggleGitPanel)
- Modify: `frontend/src/components/layout/IDELayout.tsx:221` (initialWidth in buildDefaultLayout)

**Changes:**

In `PanelActionsContext.tsx`, change both occurrences of `initialWidth: 200` to `initialWidth: 300`:

Line 275 (in toggleFileTree):
```typescript
        initialWidth: 300,
```

Line 324 (in toggleGitPanel):
```typescript
        initialWidth: 300,
```

In `IDELayout.tsx`, line 221:
```typescript
      initialWidth: 300,
```

---

## Task 3: Center Panel Toggles → Toolbar + Fix Center-2

**Files:**
- Modify: `frontend/src/components/layout/Toolbar.tsx` — add center-1/center-2 toggle buttons
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx` — remove center toggle buttons
- Modify: `frontend/src/hooks/usePanelActions.ts` (if exists) or `frontend/src/contexts/PanelActionsContext.tsx` — expose center visibility functions

**Changes:**

### 3.1 Add center toggles to Toolbar.tsx

Import `PanelLeft, Columns2` icons and get center visibility functions from `usePanelActionsContext`.

In the Toolbar component, destructure additional functions:
```typescript
const { toggleFileTree, openNewTerminal, toggleCenter1Visibility, toggleCenter2Visibility, isCenter1Visible, isCenter2Visible } = usePanelActionsContext();
```

Note: Need to import `usePanelActionsContext` from `@/contexts/PanelActionsContext` instead of using `usePanelActions` from hooks. Check which one is used - the Toolbar currently uses `usePanelActions` hook.

First check `frontend/src/hooks/usePanelActions.ts` to see what it re-exports. If it doesn't expose center visibility, import directly from context.

Add two new toggle buttons between the Terminal button and the AI Panel button:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", isCenter1Visible() && "bg-accent")}
      onClick={toggleCenter1Visibility}
      aria-label="Toggle center panel 1"
    >
      <PanelLeft className="h-3.5 w-3.5" />
    </Button>
  </TooltipTrigger>
  <TooltipContent side="bottom">Toggle Center 1</TooltipContent>
</Tooltip>

<Tooltip>
  <TooltipTrigger asChild>
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", isCenter2Visible() && "bg-accent")}
      onClick={toggleCenter2Visibility}
      aria-label="Toggle center panel 2"
    >
      <Columns2 className="h-3.5 w-3.5" />
    </Button>
  </TooltipTrigger>
  <TooltipContent side="bottom">Toggle Center 2</TooltipContent>
</Tooltip>
```

### 3.2 Remove center toggles from RightPanelSidebar.tsx

Remove the entire block between the two separator divs (lines 96-134) that contains the center-1 and center-2 toggle buttons. Also remove the first separator div (line 97). Keep the second separator (line 137) for dev server buttons.

Remove `PanelLeft, Columns2` from the import, and remove `toggleCenter1Visibility, toggleCenter2Visibility, isCenter1Visible, isCenter2Visible` from the destructured context.

### 3.3 Fix Center-2 toggle not working

The current `getCenterGroups()` in `PanelActionsContext.tsx` filters by panel IDs. The issue is that the default layout only creates ONE center group (the Welcome panel). There is no second center group created in `buildDefaultLayout`.

The fix: In `toggleCenter2Visibility`, if `centerGroups.length < 2`, we should not silently return. Instead, we can create a second center group by splitting the first center group. However, this is complex with dockview.

A simpler approach: The default layout should create TWO center groups. Modify `buildDefaultLayout` in `IDELayout.tsx` to add a second center panel (e.g., a "center-2" placeholder) to the right of the welcome panel:

```typescript
// After creating welcomePanel, add a second center column
const center2Panel = api.addPanel({
  id: 'center-2-placeholder',
  component: PANEL_IDS.WELCOME,
  title: '预览',
  position: {
    referencePanel: welcomePanel,
    direction: 'right',
  },
});
```

Actually, this creates complexity. Better approach: just bump the persist version so users get the new default layout, and ensure `getCenterGroups()` correctly identifies groups. The real issue is that after layout restore from persistence, there may only be one center group.

**Simplest fix:** In `toggleCenter2Visibility`, if there are fewer than 2 center groups but at least 1, create a new center group to the right of the first center group:

```typescript
const toggleCenter2Visibility = useCallback(() => {
  if (!dockviewApi) return;
  const centerGroups = getCenterGroups();
  if (centerGroups.length >= 2) {
    const group = centerGroups[1];
    group.api.setVisible(!group.api.isVisible);
  } else if (centerGroups.length === 1) {
    // Create a second center group with a welcome panel
    const refPanel = centerGroups[0].panels[0];
    if (refPanel) {
      dockviewApi.addPanel({
        id: PANEL_IDS.WELCOME + '-2',
        component: PANEL_IDS.WELCOME,
        title: '预览',
        position: {
          referencePanel: refPanel,
          direction: 'right',
        },
      });
    }
  }
}, [dockviewApi, getCenterGroups]);
```

---

## Task 4: Dev Server Config → Centered Modal Dialog

**Files:**
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx` — replace inline floating panel with Dialog

**Changes:**

Replace the absolute-positioned dev config panel (lines 181-206) with a shadcn/ui Dialog component.

Import Dialog components:
```typescript
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
```

Add state for test run logs:
```typescript
const [testRunLogs, setTestRunLogs] = useState<string>('');
const [isTesting, setIsTesting] = useState(false);
```

Replace the `showDevConfig` inline panel with:
```tsx
<Dialog open={showDevConfig} onOpenChange={setShowDevConfig}>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>配置开发服务器</DialogTitle>
    </DialogHeader>
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">启动命令</label>
        <input
          className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="npm run dev"
          value={devCommand}
          onChange={(e) => setDevCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveDevCommand()}
          autoFocus
        />
      </div>
      {testRunLogs && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">日志</label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => navigator.clipboard.writeText(testRunLogs)}
            >
              复制
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto p-3 text-xs font-mono bg-muted rounded-md border whitespace-pre-wrap">
            {testRunLogs}
          </pre>
        </div>
      )}
    </div>
    <DialogFooter className="gap-2">
      <Button variant="outline" onClick={() => setShowDevConfig(false)}>
        取消
      </Button>
      <Button onClick={handleSaveDevCommand} disabled={!devCommand.trim()}>
        保存并启动
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

Move this Dialog to be rendered outside the sidebar div (at the top level of the component return, use a fragment).

---

## Task 5: Fix Loading History Not Showing Conversation Content

**Files:**
- Modify: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts:541-549`

**Root Cause:**
Line 546: `executionProcesses?.current.length === 0` — this checks a ref that points to `executionProcessesRaw`. When the attempt changes, the reset effect (line 636) runs and sets `loadedInitialEntries.current = false`. But the initial load effect (line 541) depends on `idListKey` which derives from `executionProcessesRaw`. When `executionProcessesRaw` is initially an empty array (still loading from API), `idListKey` is `""`, and `executionProcesses.current.length === 0` causes an early return. When `executionProcessesRaw` finally loads, `idListKey` changes, but `executionProcesses.current` still points to the old empty array because the ref update (line 33: `executionProcesses = useRef(executionProcessesRaw)`) only sets the initial value — the ref is never re-assigned.

Wait — re-reading the code: `const executionProcesses = useRef<ExecutionProcess[]>(executionProcessesRaw);` only sets the INITIAL value. The ref.current is never updated after mount. So `executionProcesses.current.length` is always the length at mount time.

**Fix:** Replace the ref check with a direct check on `executionProcessesRaw`:

Change lines 544-549 from:
```typescript
      // Waiting for execution processes to load
      if (
        executionProcesses?.current.length === 0 ||
        loadedInitialEntries.current
      )
        return;
```

to:
```typescript
      // Waiting for execution processes to load
      if (
        !executionProcessesRaw || executionProcessesRaw.length === 0 ||
        loadedInitialEntries.current
      )
        return;
```

This way, when `executionProcessesRaw` finally loads (triggers `idListKey` change), the effect re-runs and finds a non-empty array, proceeding with the initial load.

---

## Task 6: Terminal Layout Redesign — Vertical Tabs

**Files:**
- Modify: `frontend/src/components/panels/DockviewTerminalPanel.tsx`

**Reference:** Terminal area should have vertical tabs on the right side showing shell type (node, python, cmd), no horizontal tab bar.

**Changes:**

Replace the entire return JSX in `DockviewTerminalPanel` (lines 81-133) with a horizontal flex layout:

```tsx
return (
  <div
    className="h-full w-full flex bg-console"
    data-panel="terminal"
  >
    {/* Terminal content area — takes remaining space */}
    <div className="flex-1 min-w-0 min-h-0 relative">
      {sessions.map((session) => (
        <TerminalTabContent
          key={session.tabId}
          workspaceId={workspaceId}
          tabId={session.tabId}
          isActive={activeTabId === session.tabId}
          shell={session.shell}
        />
      ))}
    </div>

    {/* Vertical tab bar on the right */}
    <div className="shrink-0 w-24 bg-secondary border-l border-border overflow-y-auto flex flex-col gap-0">
      {sessions.map((session) => (
        <button
          key={session.tabId}
          onClick={() => handleSelectTab(session.tabId)}
          className={`flex items-center gap-1.5 px-2 py-1.5 text-xs border-b border-border shrink-0 transition-colors ${
            activeTabId === session.tabId
              ? 'bg-console text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          }`}
        >
          <TerminalIcon className="h-3 w-3 shrink-0" />
          <span className="truncate flex-1 text-left">{session.title}</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => handleCloseTab(e, session.tabId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                handleCloseTab(
                  e as unknown as React.MouseEvent,
                  session.tabId
                );
              }
            }}
            className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </span>
        </button>
      ))}
    </div>
  </div>
);
```

Key changes:
- Main layout: `flex` (horizontal) instead of `flex flex-col`
- Tab bar: moved from top (`h-8`, horizontal) to right side (`w-24`, vertical)
- Terminal content: `flex-1` fills left area
- No "Terminal" title text anywhere

---

## Task 7: File Edit Display — Triangle Expand + Click to Navigate

**Files:**
- Modify: `frontend/src/components/NormalizedConversation/EditDiffRenderer.tsx`
- Modify: `frontend/src/components/NormalizedConversation/FileChangeRenderer.tsx`

**Changes:**

### 7.1 EditDiffRenderer.tsx

Replace `SquarePen` icon import with `ChevronRight`:
```typescript
import { ChevronRight } from 'lucide-react';
```

Replace the header JSX (lines 100-116) to separate expand toggle from file name click:

```tsx
return (
  <div>
    <div className={headerClass}>
      <span
        onClick={() => setExpanded()}
        className="cursor-pointer shrink-0"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 transition-transform',
            effectiveExpanded && 'rotate-90'
          )}
        />
      </span>
      <p
        onClick={() => {
          // Navigate to file in center panel
          if (typeof window !== 'undefined') {
            const event = new CustomEvent('open-file-preview', { detail: { path } });
            window.dispatchEvent(event);
          }
        }}
        className="text-sm font-mono overflow-x-auto flex-1 cursor-pointer hover:underline"
      >
        {path}{' '}
        <span style={{ color: 'hsl(var(--console-success))' }}>
          +{additions}
        </span>{' '}
        <span style={{ color: 'hsl(var(--console-error))' }}>
          -{deletions}
        </span>
      </p>
    </div>
    {/* diff body unchanged */}
  </div>
);
```

Actually, using custom events is not ideal. Better approach: Accept an `onNavigate` callback prop. But since EditDiffRenderer is called from DisplayConversationEntry which doesn't have panel actions access easily, we can use the `usePanelActionsContext` hook directly in EditDiffRenderer.

**Better approach:** Import `usePanelActionsContext` and call `openFilePreview(path)`:

```typescript
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
```

In the component:
```typescript
const { openFilePreview } = usePanelActionsContext();
```

Then the file name click handler:
```typescript
onClick={(e) => {
  e.stopPropagation();
  openFilePreview(path);
}}
```

Note: If `PanelActionsContext` is not available at this point in the tree, we need a try-catch or optional access. Check the component tree — DisplayConversationEntry is rendered inside the right panel which is within PanelActionsProvider. So this should work.

### 7.2 FileChangeRenderer.tsx

Same changes for the write/delete/rename variants:

Import `ChevronRight` and `usePanelActionsContext`:
```typescript
import { ChevronRight } from 'lucide-react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
```

In the component:
```typescript
const { openFilePreview } = usePanelActionsContext();
```

For expandable items (write), replace the header to have separate triangle and clickable filename:
```tsx
<div className={headerClass}>
  {expandable ? (
    <span onClick={() => setExpanded()} className="cursor-pointer shrink-0">
      <ChevronRight
        className={cn('h-3 w-3 transition-transform', effectiveExpanded && 'rotate-90')}
      />
    </span>
  ) : (
    icon
  )}
  <p
    onClick={() => openFilePreview(path)}
    className="text-sm font-mono overflow-x-auto flex-1 cursor-pointer hover:underline"
  >
    {titleNode}
  </p>
</div>
```

For non-expandable items (delete, rename), keep the original icon but make filename clickable for navigation.

---

## Task 8: Right Panel Input — Buttons Inside Input Box

**Files:**
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx`

**Changes:**

Move the action buttons (VariantSelector, Attach, PR Comments, TodoList, Send/Stop/Queue) from the separate bottom bar into the input box container.

Current structure:
```
┌──────────────────────┐
│ WYSIWYGEditor        │  ← rounded-lg border container
└──────────────────────┘
┌──────────────────────┐
│ [Variant] [📎] [💬] [✓] [Send] │  ← separate px-3 py-1 bar
└──────────────────────┘
```

New structure:
```
┌──────────────────────┐
│ WYSIWYGEditor        │
│                      │
│ [Variant] [📎] [💬] [✓]  [Send] │  ← inside the same border container
└──────────────────────┘
```

Replace the two-section layout (lines 671-932). The key change is to merge the action bar INTO the editor container:

Change the grid layout from `grid-rows-[minmax(0,1fr)_auto]` and move the action bar inside the same `rounded-lg border` container as the editor.

New JSX structure:

```tsx
return (
  <div
    className={cn(
      'flex flex-col h-full min-h-0 overflow-hidden',
      isRetryActive && 'opacity-50'
    )}
  >
    {/* Scrollable content area — review comments, conflicts, etc. */}
    <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3">
      <div className="space-y-2">
        {followUpError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{followUpError}</AlertDescription>
          </Alert>
        )}
        {reviewMarkdown && (
          <div className="mb-4">
            <div className="text-sm whitespace-pre-wrap break-words rounded-md border bg-muted p-3">
              {reviewMarkdown}
            </div>
          </div>
        )}
        {branchStatus && (
          <FollowUpConflictSection ... />
        )}
        <ClickedElementsBanner />
        {isQueued && queuedMessage && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted p-3 rounded-md border">
            <Clock className="h-4 w-4 flex-shrink-0" />
            <div className="font-medium">{'消息已排队 - 将在当前运行完成时执行'}</div>
          </div>
        )}
      </div>
    </div>

    {/* Input area with buttons inside */}
    <div className="shrink-0 px-3 pb-3">
      <div
        className="flex flex-col gap-1 rounded-xl border border-border bg-background p-2 overflow-hidden"
        onFocus={() => setIsTextareaFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            setIsTextareaFocused(false);
          }
        }}
      >
        <WYSIWYGEditor
          placeholder={editorPlaceholder}
          value={displayMessage}
          onChange={handleEditorChange}
          disabled={!isEditable}
          onPasteFiles={handlePasteFiles}
          repoIds={repos.map((r) => r.id)}
          projectId={projectId}
          executor={latestProfileId?.executor ?? null}
          taskAttemptId={workspaceId}
          onCmdEnter={handleSubmitShortcut}
          className="min-h-[40px] break-words overflow-wrap-anywhere"
        />

        {/* Action buttons inside the input container */}
        <div className="flex flex-wrap gap-1 items-center pt-1 border-t border-border/50">
          <div className="min-w-0 flex gap-1">
            <VariantSelector ... />
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileInputChange} />
          <Button onClick={handleAttachClick} disabled={!isEditable} size="sm" variant="ghost" className="h-7 w-7 p-0">
            <Paperclip className="h-3.5 w-3.5" />
          </Button>
          <Button onClick={handlePrCommentClick} disabled={!isEditable} size="sm" variant="ghost" className="h-7 w-7 p-0">
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className={cn("h-7 w-7 p-0", todos.length === 0 && "opacity-50")}>
                <CheckSquare className="h-3.5 w-3.5" />
                {todos.length > 0 && <span className="ml-0.5 text-[10px]">{todos.length}</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              {/* same popover content */}
            </PopoverContent>
          </Popover>

          {/* Spacer to push send/stop buttons to right */}
          <div className="flex-1" />

          {/* Send/Stop/Queue buttons */}
          {isAttemptRunning ? (
            <div className="flex items-center gap-1">
              {isQueued ? (
                <Button onClick={cancelQueue} disabled={isQueueLoading} size="sm" variant="ghost" className="h-7 px-2 text-xs">
                  <X className="h-3.5 w-3.5 mr-1" /> 取消队列
                </Button>
              ) : (
                <Button onClick={handleQueueMessage} disabled={...} size="sm" variant="ghost" className="h-7 px-2 text-xs">
                  <Clock className="h-3.5 w-3.5 mr-1" /> 队列
                </Button>
              )}
              <Button onClick={stopExecution} disabled={isStopping} size="sm" variant="destructive" className="h-7 px-2 text-xs">
                <StopCircle className="h-3.5 w-3.5 mr-1" /> 停止
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {comments.length > 0 && (
                <Button onClick={clearComments} size="sm" variant="destructive" disabled={!isEditable} className="h-7 px-2 text-xs">
                  清除审查
                </Button>
              )}
              <Button onClick={onSendFollowUp} disabled={!canSendFollowUp || !isEditable} size="sm" className="h-7 px-2 text-xs rounded-lg">
                {isSendingFollowUp ? <Loader2 className="animate-spin h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  </div>
);
```

Key visual changes:
- Editor and buttons share the same `rounded-xl border` container
- Buttons use `variant="ghost"` and smaller sizing (`h-7 w-7 p-0`) for a cleaner look
- A `border-t border-border/50` subtle separator between editor and buttons
- Send button is compact (icon only when not loading) pushed to the right with `flex-1` spacer
