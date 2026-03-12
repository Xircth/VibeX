# Layout And Preview UX Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复布局控制器失效、默认面板尺寸、默认开发入口仍触发 Web 服务、预览栏缺按钮、Companion 提示不可关闭以及安装反馈缺失等问题。

**Architecture:** 保持当前 Dockview + PreviewPanel 结构不变，重点修复稳定 group id、默认配置、以及预览状态机。对开发入口改为“默认桌面端 only + legacy 保留”，对预览栏恢复缺失按钮，并对 Companion 提示与安装反馈加显式状态。

**Tech Stack:** React、TypeScript、Dockview、Tauri IPC、Node 文本回归测试。

---

### Task 1: 锁定布局与预览回归测试

**Files:**
- Create: `frontend/tests/layout-and-preview-regressions.test.js`
- Modify: `frontend/tests/desktop-only-dev-mode.test.js`
- Modify: `frontend/tests/terminal-defaults-and-preview-balance.test.js`

**Step 1: Write the failing test**
- 中1/中2 必须基于稳定 group id 控制
- 默认终端高度改为 300
- 默认 `tauri.conf.json` 不再使用 `devUrl: http://localhost:3000`
- 预览区恢复“选择元素作为内容”与“切换 DevTools”按钮
- Companion 提示可关闭且安装成功/失败有反馈

**Step 2: Run test to verify it fails**

Run: `node --test "frontend/tests/layout-and-preview-regressions.test.js" "frontend/tests/desktop-only-dev-mode.test.js" "frontend/tests/terminal-defaults-and-preview-balance.test.js"`
Expected: FAIL

### Task 2: 修复布局控制与默认尺寸

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`
- Modify: `frontend/src/components/layout/IDELayout.tsx`
- Modify: `frontend/src/lib/terminalPreferences.ts`

**Step 1: Implement stable group helpers**
用 `GROUP_IDS.CENTER_1/CENTER_2/LEFT/BOTTOM` 替代数组序号推断。

**Step 2: Normalize restored layout group ids**
布局恢复后给关键 group 重新绑定 canonical id，避免持久化旧布局导致按钮失效。

**Step 3: Adjust defaults**
左栏 300px、终端栏 300px。

### Task 3: 收口默认开发入口

**Files:**
- Modify: `package.json`
- Modify: `scripts/dev.js`
- Modify: `README.md`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/tauri.legacy.conf.json`

**Step 1: Default to desktop-only**
默认 `dev` / `tauri:dev` 均走桌面端 only。

**Step 2: Preserve legacy explicitly**
旧 Web 服务链路只保留 `*:legacy` 入口。

### Task 4: 修复预览工具栏与 Companion 反馈

**Files:**
- Modify: `frontend/src/components/tasks/TaskDetails/preview/ReadyContent.tsx`
- Modify: `frontend/src/components/panels/PreviewPanel.tsx`
- Modify: `frontend/src/lib/api.ts`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Add preview toolbar controls**
恢复“选择元素作为内容”和“切换 DevTools”按钮。

**Step 2: Add closable companion help**
引入 dismissed 状态，允许关闭提示。

**Step 3: Add install success/failure feedback**
安装 Companion 后显示成功或失败信息。

### Task 5: Final verification

**Step 1: Run targeted tests**
Run: `node --test "frontend/tests/layout-and-preview-regressions.test.js" "frontend/tests/desktop-only-dev-mode.test.js" "frontend/tests/terminal-defaults-and-preview-balance.test.js"`
Expected: PASS

**Step 2: Run type checks**
Run: `pnpm run frontend:check && pnpm run backend:check`
Expected: PASS
