# Dev Preview Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为桌面端新增独立的开发服务器预览 panel，并把右侧边栏预览按钮绑定到它，保留现有文件预览能力不变。

**Architecture:** 保留 `preview` 作为文件预览 panel，新增 `dev-preview` 作为开发服务器预览 panel。`dev-preview` 使用一个轻量 Dockview 包装组件接入现有 `PreviewPanel`，并补齐其所需的 `ClickedElementsProvider` 与 `ExecutionProcessesProvider` 上下文。

**Tech Stack:** React、TypeScript、Dockview、Zustand、TanStack Query。

---

### Task 1: 锁定 panel 路由回归测试

**Files:**
- Create: `frontend/tests/dev-preview-panel-routing.test.js`
- Modify: `frontend/src/stores/useLayoutStore.ts`
- Modify: `frontend/src/components/layout/panels/PanelRegistry.tsx`
- Modify: `frontend/src/components/layout/RightPanelSidebar.tsx`

**Step 1: Write the failing test**

验证三件事：
- `PANEL_IDS` 暴露 `DEV_PREVIEW`
- `preview` 仍映射到文件预览组件，`dev-preview` 映射到开发预览组件
- 右侧 `Globe` 按钮和启动 dev server 成功后的自动打开逻辑都使用 `PANEL_IDS.DEV_PREVIEW`

**Step 2: Run test to verify it fails**

Run: `node --test "frontend/tests/dev-preview-panel-routing.test.js"`
Expected: FAIL

**Step 3: Write minimal implementation**

新增 `DEV_PREVIEW` panel id，并在注册表与侧边栏逻辑中完成绑定。

**Step 4: Run test to verify it passes**

Run: `node --test "frontend/tests/dev-preview-panel-routing.test.js"`
Expected: PASS

### Task 2: 接入开发预览包装组件

**Files:**
- Create: `frontend/src/components/panels/DockviewDevPreviewPanel.tsx`
- Modify: `frontend/src/components/layout/panels/PanelRegistry.tsx`

**Step 1: Write the failing test**

验证包装组件：
- 渲染 `PreviewPanel`
- 提供 `ClickedElementsProvider`
- 提供 `ExecutionProcessesProvider`

**Step 2: Run test to verify it fails**

Run: `node --test "frontend/tests/dev-preview-panel-routing.test.js"`
Expected: FAIL

**Step 3: Write minimal implementation**

创建 Dockview 包装组件，只补上下文，不改 `PreviewPanel` 行为。

**Step 4: Run test to verify it passes**

Run: `node --test "frontend/tests/dev-preview-panel-routing.test.js"`
Expected: PASS

### Task 3: 完整验证

**Files:**
- Test: `frontend/tests/dev-preview-panel-routing.test.js`
- Test: `frontend/tests/workspace-history-and-selector-regressions.test.js`
- Test: `frontend/tests/history-loading-and-terminal-copy.test.js`

**Step 1: Run targeted tests**

Run: `node --test "frontend/tests/dev-preview-panel-routing.test.js" "frontend/tests/workspace-history-and-selector-regressions.test.js" "frontend/tests/history-loading-and-terminal-copy.test.js"`
Expected: PASS

**Step 2: Run type check**

Run: `pnpm run frontend:check`
Expected: PASS

**Step 3: Run file-scoped lint**

Run: `cd frontend && pnpm exec eslint src/stores/useLayoutStore.ts src/components/layout/panels/PanelRegistry.tsx src/components/layout/RightPanelSidebar.tsx src/components/panels/DockviewDevPreviewPanel.tsx`
Expected: PASS
