# Unified Workspace Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 MossX 中实现统一搜索面板（Cmd/Ctrl+P），仅搜索当前选中 workspace 的文件、Kanban 任务、线程标题、消息内容、输入历史。

**Architecture:** 前端以 `SearchPalette` 统一承载搜索 UI，按 provider 聚合结果（files/kanban/threads/messages/history）。数据域默认限制在 active workspace，避免全局扫描导致 UI 卡顿。消息内容采用渐进式索引与增量更新，保证首次可用与后续性能。

**Tech Stack:** React + TypeScript + Tauri invoke + Vitest + existing shortcut utilities (`matchesShortcut`, settings shortcuts)

---

### Task 1: Define Scope, Types, and Feature Flag (P0)

**Files:**
- Create: `src/features/search/types.ts`
- Create: `src/features/search/constants.ts`
- Modify: `src/types.ts`
- Modify: `src/features/settings/hooks/useAppSettings.ts`
- Modify: `src-tauri/src/types.rs`

**Step 1: Write failing type checks for new shortcut setting**

```ts
// src/test/search.shortcut.contract.test.ts
import type { AppSettings } from "../types";

it("contains toggleGlobalSearchShortcut", () => {
  const settings = {} as AppSettings;
  expect("toggleGlobalSearchShortcut" in settings).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/test/search.shortcut.contract.test.ts`
Expected: FAIL because key does not exist.

**Step 3: Add minimal settings/types implementation**

```ts
// src/types.ts
export type AppSettings = {
  // ...existing fields
  toggleGlobalSearchShortcut: string | null;
};
```

```ts
// src/features/settings/hooks/useAppSettings.ts
const defaultSettings: AppSettings = {
  // ...existing defaults
  toggleGlobalSearchShortcut: "cmd+p",
};
```

```rust
// src-tauri/src/types.rs
#[serde(default = "default_toggle_global_search_shortcut", rename = "toggleGlobalSearchShortcut")]
pub(crate) toggle_global_search_shortcut: Option<String>,
```

**Step 4: Run test + typecheck**

Run: `npm run test -- src/test/search.shortcut.contract.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/types.ts src/features/settings/hooks/useAppSettings.ts src-tauri/src/types.rs src/test/search.shortcut.contract.test.ts src/features/search/types.ts src/features/search/constants.ts
git commit -m "feat(search): add search scope types and global search shortcut setting"
```

---

### Task 2: Add Shortcut Input in Settings (P0)

**Files:**
- Modify: `src/features/settings/components/SettingsView.tsx`
- Modify: `src/features/settings/components/SettingsView.test.tsx`
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh.ts`

**Step 1: Write failing UI test for new shortcut row**

```tsx
it("renders global search shortcut input", () => {
  renderSettings();
  expect(screen.getByLabelText("Global Search")).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/features/settings/components/SettingsView.test.tsx`
Expected: FAIL (row missing).

**Step 3: Implement shortcut row + draft mapping**

```tsx
// add key to ShortcutSettingKey + draft map
| "toggleGlobalSearchShortcut"

// render input block in shortcuts section
<input
  className="settings-input settings-input--shortcut"
  value={formatShortcut(shortcutDrafts.globalSearch)}
  onKeyDown={(event) => handleShortcutKeyDown(event, "toggleGlobalSearchShortcut")}
  aria-label={t("settings.globalSearchShortcut")}
/>
```

**Step 4: Add i18n keys**

```ts
// en.ts
globalSearchShortcut: "Global Search",
// zh.ts
globalSearchShortcut: "全局搜索",
```

**Step 5: Run tests**

Run: `npm run test -- src/features/settings/components/SettingsView.test.tsx`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/settings/components/SettingsView.tsx src/features/settings/components/SettingsView.test.tsx src/i18n/locales/en.ts src/i18n/locales/zh.ts
git commit -m "feat(search): add shortcut setting input for global search palette"
```

---

### Task 3: Wire Runtime Shortcut Handler (P0)

**Files:**
- Create: `src/features/app/hooks/useGlobalSearchShortcut.ts`
- Modify: `src/App.tsx`
- Modify: `src/features/app/hooks/useMenuAcceleratorController.ts`
- Modify: `src/features/app/hooks/useMenuAcceleratorController.test.ts` (if present; else create)

**Step 1: Write failing hook test**

```ts
it("triggers open callback when shortcut matches", () => {
  // simulate keydown cmd+p
  // expect onTrigger called once
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/features/app/hooks/useGlobalSearchShortcut.test.ts`
Expected: FAIL (hook missing).

**Step 3: Implement shortcut hook**

```ts
export function useGlobalSearchShortcut({ shortcut, isEnabled, onTrigger }: Props) {
  useEffect(() => {
    if (!isEnabled || !shortcut) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      onTrigger();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcut, isEnabled, onTrigger]);
}
```

**Step 4: Connect to App state**

- In `App.tsx`, add `isSearchPaletteOpen` state and invoke hook with `appSettings.toggleGlobalSearchShortcut`.
- In `useMenuAcceleratorController.ts`, add menu accelerator mapping for new setting.

**Step 5: Run tests**

Run: `npm run test -- src/features/app/hooks/useGlobalSearchShortcut.test.ts && npm run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/app/hooks/useGlobalSearchShortcut.ts src/features/app/hooks/useGlobalSearchShortcut.test.ts src/App.tsx src/features/app/hooks/useMenuAcceleratorController.ts
git commit -m "feat(search): wire runtime shortcut to open search palette"
```

---

### Task 4: Build Search Palette UI Shell (P1)

**Files:**
- Create: `src/features/search/components/SearchPalette.tsx`
- Create: `src/features/search/components/SearchResultList.tsx`
- Create: `src/features/search/hooks/useSearchPaletteState.ts`
- Create: `src/styles/search-palette.css`
- Modify: `src/App.tsx`

**Step 1: Write failing rendering test**

```tsx
it("opens palette and navigates results by arrow keys", async () => {
  // open -> type query -> ArrowDown -> Enter
  // expect onSelect fired
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/features/search/components/SearchPalette.test.tsx`
Expected: FAIL.

**Step 3: Implement minimal palette shell**

- Input + result list + active index.
- Keyboard behavior: `ArrowUp/Down`, `Enter`, `Escape`.
- Basic category badges (`file`, `kanban`, `thread`, `message`, `history`).

**Step 4: Mount palette from App**

- Render portal/modal when `isSearchPaletteOpen` is true.
- Close on `Escape` and on result selection.

**Step 5: Run tests**

Run: `npm run test -- src/features/search/components/SearchPalette.test.tsx`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/search/components/SearchPalette.tsx src/features/search/components/SearchResultList.tsx src/features/search/hooks/useSearchPaletteState.ts src/styles/search-palette.css src/App.tsx
git commit -m "feat(search): add workspace search palette UI shell"
```

---

### Task 5: Implement Providers for Files, Kanban, Threads, History (P1)

**Files:**
- Create: `src/features/search/providers/filesProvider.ts`
- Create: `src/features/search/providers/kanbanProvider.ts`
- Create: `src/features/search/providers/threadProvider.ts`
- Create: `src/features/search/providers/historyProvider.ts`
- Create: `src/features/search/hooks/useUnifiedSearch.ts`
- Modify: `src/App.tsx`

**Step 1: Write failing provider tests**

```ts
it("returns file matches within active workspace only", () => {
  // given files[]
  // expect only active workspace source used
});
```

**Step 2: Run tests to verify failure**

Run: `npm run test -- src/features/search/providers/*.test.ts`
Expected: FAIL.

**Step 3: Implement provider contracts**

- Files: match `path.includes(query)` from active workspace file list.
- Kanban: match `task.title + task.description` with active workspace filter.
- Threads: match thread titles in active workspace.
- History: match stored history text.

**Step 4: Integrate provider aggregator**

```ts
const results = mergeAndRank([
  filesProvider.search(...),
  kanbanProvider.search(...),
  threadProvider.search(...),
  historyProvider.search(...),
]);
```

**Step 5: Wire open actions**

- file -> open file panel
- kanban -> switch to kanban and select task
- thread -> switch active thread
- history -> write into composer draft

**Step 6: Run tests**

Run: `npm run test -- src/features/search/providers/*.test.ts src/features/search/hooks/useUnifiedSearch.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/features/search/providers src/features/search/hooks/useUnifiedSearch.ts src/App.tsx
git commit -m "feat(search): add unified providers for files kanban threads history"
```

---

### Task 6: Add Message Content Search in Active Workspace (P2)

**Files:**
- Create: `src/features/search/providers/messageProvider.ts`
- Create: `src/features/search/indexing/messageIndex.ts`
- Modify: `src/features/threads/hooks/useThreads.ts`
- Modify: `src/features/threads/hooks/useThreadsReducer.ts`
- Modify: `src/features/search/hooks/useUnifiedSearch.ts`

**Step 1: Write failing message search test**

```ts
it("finds message text and returns snippet", () => {
  // given conversation items
  // expect snippet with keyword
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- src/features/search/providers/messageProvider.test.ts`
Expected: FAIL.

**Step 3: Implement index + search**

- Incrementally index `ConversationItem.kind === "message"` text.
- Scope index key by `workspaceId`.
- Build snippet around first hit with simple highlight metadata.

**Step 4: Add jump behavior**

- Selecting message result should activate thread and focus message region (best-effort anchor).

**Step 5: Run tests**

Run: `npm run test -- src/features/search/providers/messageProvider.test.ts src/features/search/indexing/messageIndex.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/search/providers/messageProvider.ts src/features/search/indexing/messageIndex.ts src/features/threads/hooks/useThreads.ts src/features/threads/hooks/useThreadsReducer.ts src/features/search/hooks/useUnifiedSearch.ts
git commit -m "feat(search): add active-workspace message content search"
```

---

### Task 7: Ranking, Recency, and Relevance (P3)

**Files:**
- Create: `src/features/search/ranking/score.ts`
- Create: `src/features/search/ranking/recencyStore.ts`
- Modify: `src/features/search/hooks/useUnifiedSearch.ts`
- Modify: `src/features/search/components/SearchResultList.tsx`

**Step 1: Write failing ranking tests**

```ts
it("prefers recent selections when quality is similar", () => {
  // same query quality, newer selected item ranks higher
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- src/features/search/ranking/*.test.ts`
Expected: FAIL.

**Step 3: Implement scoring**

- `prefix > substring`
- `title/path match > body match`
- `recently opened boost`
- stable tiebreaker by updatedAt

**Step 4: Persist recency**

- store last-open timestamps in client storage (`search.recentOpenMap`).

**Step 5: Run tests**

Run: `npm run test -- src/features/search/ranking/*.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/search/ranking src/features/search/hooks/useUnifiedSearch.ts src/features/search/components/SearchResultList.tsx
git commit -m "feat(search): add recency and relevance ranking"
```

---

### Task 8: Performance Guardrails (P4)

**Files:**
- Modify: `src/features/search/hooks/useUnifiedSearch.ts`
- Create: `src/features/search/perf/limits.ts`
- Create: `src/features/search/perf/chunker.ts`
- Create: `src/features/search/perf/searchMetrics.ts`

**Step 1: Write failing perf-oriented unit tests**

```ts
it("caps candidate set and yields partial results without blocking", async () => {
  // huge list input
  // expect capped + chunked behavior
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- src/features/search/perf/*.test.ts`
Expected: FAIL.

**Step 3: Implement safeguards**

- debounce input (100-150ms)
- chunk processing with `setTimeout`/micro-yield
- hard cap per provider + total cap
- cancel stale search requests by token

**Step 4: Add simple telemetry logs (debug-only)**

- capture query time and result count for tuning.

**Step 5: Run tests + lint**

Run: `npm run test -- src/features/search/perf/*.test.ts && npm run lint`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/search/perf src/features/search/hooks/useUnifiedSearch.ts
git commit -m "perf(search): add debounce chunking caps and stale-cancel"
```

---

### Task 9: Release Safety, Flag, and Regression Suite (P5)

**Files:**
- Modify: `src/features/settings/hooks/useAppSettings.ts`
- Modify: `src/App.tsx`
- Create: `src/features/search/__tests__/integration.searchPalette.test.tsx`
- Modify: `src/test/vitest.setup.ts`
- Modify: `README.zh-CN.md` (search shortcuts and scope)

**Step 1: Write failing integration tests**

```tsx
it("searches only active workspace and does not leak results from others", async () => {
  // setup two workspaces, query matches both
  // expect only active workspace results
});
```

**Step 2: Run test to verify failure**

Run: `npm run test -- src/features/search/__tests__/integration.searchPalette.test.tsx`
Expected: FAIL.

**Step 3: Add release flag + rollback path**

- Add setting `search.unified.enabled` (default true for dev branch).
- If disabled, skip mounting SearchPalette and preserve existing local search UI.

**Step 4: Document user behavior and rollback**

- shortcut customization
- active-workspace-only scope
- disable flag procedure

**Step 5: Full verification run**

Run:
- `npm run test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/settings/hooks/useAppSettings.ts src/App.tsx src/features/search/__tests__/integration.searchPalette.test.tsx src/test/vitest.setup.ts README.zh-CN.md
git commit -m "test(search): add rollout flag integration tests and docs"
```

---

## Non-Goals (for this plan)

- 不做默认“全局跨 workspace 搜索”。
- 不做后端全文检索引擎（如 Tantivy/SQLite FTS）替换。
- 不做语义搜索和 embedding。

## Acceptance Checklist

- `Cmd/Ctrl+P` 打开统一搜索面板，且可在设置中修改快捷键。
- 结果严格限制在当前 active workspace。
- 覆盖 5 类数据源：files / kanban / thread / message / history。
- 搜索交互完整：输入、键盘导航、回车跳转、ESC 关闭。
- 在常规仓库规模下首屏结果响应小于 300ms（开发环境）。
- 具备开关和回滚路径。

## Suggested Execution Order

1. Task 1-3 (P0)
2. Task 4-5 (P1)
3. Task 6 (P2)
4. Task 7 (P3)
5. Task 8 (P4)
6. Task 9 (P5)

## Architectural Guardrails (Mandatory)

1. Minimal Invasion
- 优先新增 `src/features/search/**` 模块，不在老模块中散落搜索实现。
- `App.tsx` 仅做装配层改动（挂载面板、注入数据、处理打开/关闭状态）。
- 对历史模块（threads/kanban/files/settings）的改动仅限“接入点”，禁止重写其既有业务流。

2. Strong Boundaries
- `search` 模块只通过明确输入（activeWorkspaceId、providers data）工作，不直接读取其他模块内部状态。
- provider 只能返回标准化 `SearchResult`，不得携带 UI 组件或跨域副作用。
- 搜索域默认固定为当前 active workspace；跨 workspace 能力必须 feature-flag 且默认关闭。

3. Plug-and-Play
- provider 接口统一：`search(query, context): SearchResult[] | Promise<SearchResult[]>`。
- 新增/删除 provider 不需要修改核心 UI（仅注册表变更）。
- 排序器、索引器、渲染器解耦，任一模块可替换。

4. Backward Compatibility
- 老入口（Sidebar 搜索、文件树过滤、Kanban 搜索）保持可用。
- 新面板失败时可自动降级到老入口，不阻塞主流程。

## Code-Change Budget (Per Task)

- 每个 task 对既有文件改动不超过 3-5 个；超出必须拆 task。
- 每次 PR 至少 60% 新增在 `src/features/search/**`。
- 若发现需要大面积改动旧代码，先停下并回到计划评审。

## Reject Criteria (Must Stop and Re-plan)

- 为了实现搜索而重构 `threads`、`kanban`、`files` 主流程。
- 引入与需求无关的全局状态管理迁移。
- 未经 flag 控制就引入跨 workspace 全局扫描。
