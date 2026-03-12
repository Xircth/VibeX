# Terminal Defaults And Preview Balance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复终端创建与中心列预览/拖拽逻辑，并把默认终端加入通用设置。

**Architecture:** 在现有工作区布局基础上，新增一个小型终端偏好辅助模块，统一默认终端、终端高度和 workspace key 逻辑；前端通过局部扩展类型读取新的配置字段，后端新增配置版本保存该字段；`openFilePreview` 调整为显式的“有空占空，无空占少”策略。

**Tech Stack:** React、TypeScript、Rust、serde、dockview-react、node:test

---

### Task 1: 写失败测试

**Files:**
- Create: `frontend/tests/terminal-defaults-and-preview-balance.test.js`

**Step 1: Write the failing test**

断言以下源码行为：
- 终端默认高度为 `350`
- `TerminalHeaderActions` 使用统一 workspace key，不再 fallback 到 `projectId`
- `GeneralSettings` 暴露默认终端设置项
- `openFilePreview` 使用“空优先、少优先”
- Rust 最新配置包含 `default_terminal_shell`

**Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js`

Expected: FAIL。

---

### Task 2: 实现终端偏好与默认高度

**Files:**
- Create: `frontend/src/lib/terminalPreferences.ts`
- Modify: `frontend/src/components/layout/IDELayout.tsx`
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`

**Step 1: Write minimal implementation**

- 抽出默认终端高度常量 `350`
- 让 bottom group 创建都使用该值

**Step 2: Run test to verify progress**

Run: `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js`

Expected: 终端高度相关断言通过。

---

### Task 3: 修复终端 `+` 与默认终端来源

**Files:**
- Modify: `frontend/src/components/layout/panels/TerminalHeaderActions.tsx`
- Modify: `frontend/src/components/panels/DockviewTerminalPanel.tsx`

**Step 1: Implement minimal fix**

- 使用统一 workspace key helper
- `+` 和下拉阻止 header 拖拽事件冒泡
- auto-create terminal 使用默认终端

**Step 2: Run test to verify progress**

Run: `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js`

Expected: 终端创建相关断言通过。

---

### Task 4: 加入默认终端设置项并持久化

**Files:**
- Modify: `frontend/src/pages/settings/GeneralSettings.tsx`
- Modify: `crates/services/src/services/config/mod.rs`
- Create: `crates/services/src/services/config/versions/v9.rs`
- Modify: `crates/services/src/services/config/versions/mod.rs`

**Step 1: Implement minimal config support**

- Rust 配置升级到 `v9`
- 增加 `default_terminal_shell`
- 设置页新增下拉项

**Step 2: Run checks**

Run: `pnpm run backend:check`

Expected: exit 0。

---

### Task 5: 优化文件预览分配与中心拖放

**Files:**
- Modify: `frontend/src/contexts/PanelActionsContext.tsx`
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Step 1: Implement minimal logic**

- `openFilePreview` 按“有空占空，无空占少”选列
- 欢迎页不计入有效内容数
- 中心组互拖显式允许，左/底部保持禁止

**Step 2: Run test to verify it passes**

Run: `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js`

Expected: PASS。

---

### Task 6: 完整验证

**Files:**
- Verify only

**Step 1: Run targeted tests**

Run: `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js frontend/tests/workspace-layout-constraints.test.js frontend/tests/settings-page.test.js`

Expected: PASS。

**Step 2: Run frontend type check**

Run: `pnpm run frontend:check`

Expected: exit 0。

**Step 3: Run backend check**

Run: `pnpm run backend:check`

Expected: exit 0。

**Step 4: Do not commit**

按仓库 `AGENTS.md`，本次不执行 commit。
