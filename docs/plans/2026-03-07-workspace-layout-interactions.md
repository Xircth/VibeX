# Workspace Layout Interactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 调整工作区布局交互，使终端栏被限制在中间区域底部、右栏默认宽度为 420、工作区 Logo 仅显示图标，并允许中1/中2标签互拖。

**Architecture:** 在现有 `Toolbar + Dockview + 固定右栏` 架构上做最小改动：使用 Logo 变体控制工作区页展示；显式创建 `BOTTOM` 与 `CENTER_2` group；通过 `onWillShowOverlay` 和布局恢复校正实现拖拽白名单/黑名单；保持右栏继续独立于 Dockview。

**Tech Stack:** React、TypeScript、dockview-react、Node test

---

### Task 1: 写失败测试

**Files:**
- Create: `frontend/tests/workspace-layout-constraints.test.js`

**Step 1: Write the failing test**

断言以下源码行为：
- `Toolbar.tsx` 使用 `Logo` 的无文字模式
- `useLayoutStore.ts` 默认右栏宽度为 `420`
- `IDELayout.tsx` 显式创建 `GROUP_IDS.BOTTOM` 与 `GROUP_IDS.CENTER_2`
- `IDELayout.tsx` 阻止 `PANEL_IDS.TERMINAL` 的拖放

**Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/workspace-layout-constraints.test.js`

Expected: FAIL，因为当前实现还没有这些约束。

---

### Task 2: 实现工作区 Logo 变体与右栏宽度

**Files:**
- Modify: `frontend/src/components/Logo.tsx`
- Modify: `frontend/src/components/layout/Toolbar.tsx`
- Modify: `frontend/src/stores/useLayoutStore.ts`

**Step 1: Write minimal implementation**

- 给 `Logo` 增加 `showText?: boolean`
- `Toolbar` 传入 `showText={false}`
- 右栏默认宽度改为 `420`，最小宽度调整到不大于默认值

**Step 2: Run test to verify progress**

Run: `node --test frontend/tests/workspace-layout-constraints.test.js`

Expected: 与 Logo / 宽度相关断言通过。

---

### Task 3: 实现 bottom / center2 默认布局与拖拽约束

**Files:**
- Modify: `frontend/src/components/layout/IDELayout.tsx`
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`

**Step 1: Implement minimal layout changes**

- 默认布局显式创建 `GROUP_IDS.BOTTOM` 与 `GROUP_IDS.CENTER_2`
- bottom group 内添加 terminal
- center2 group 内添加第二个欢迎 panel

**Step 2: Implement minimal drag-drop guard**

- 阻止 `PANEL_IDS.TERMINAL` 作为拖动源
- 阻止 bottom group 作为任何拖入目标
- 继续阻止非左栏面板进入左栏

**Step 3: Add restore-time correction**

- 如果 terminal 恢复后不在 `GROUP_IDS.BOTTOM`，则移回 bottom group

**Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/workspace-layout-constraints.test.js`

Expected: PASS。

---

### Task 4: 完整验证

**Files:**
- Verify only

**Step 1: Run targeted tests**

Run: `node --test frontend/tests/workspace-layout-constraints.test.js frontend/tests/settings-page.test.js`

Expected: PASS。

**Step 2: Run frontend type check**

Run: `pnpm run frontend:check`

Expected: exit 0。

**Step 3: Do not commit**

按仓库 `AGENTS.md`，本次不执行 commit。
