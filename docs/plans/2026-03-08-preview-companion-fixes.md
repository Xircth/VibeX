# Preview Companion Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复开发预览把 Companion 缺失误判为预览失败的问题，内置本地安装并自动接入 Web Companion，并去掉启动开发服务器后重复创建日志标签的行为。

**Architecture:** 将“iframe 预览已成功加载”和“Companion 已就绪”拆为两个独立状态；预览成功只依赖 iframe 可访问，点击编辑增强能力依赖 Companion。新增一个桌面端本地安装命令负责安装依赖，前端负责定位入口文件并自动接入组件。

**Tech Stack:** React、TypeScript、Tauri commands、Rust、TanStack Query。

---

### Task 1: 锁定预览与日志行为回归测试

**Files:**
- Create: `frontend/tests/preview-companion-install-and-logs.test.js`

**Step 1: Write the failing test**
- 验证预览成功状态与 Companion 就绪状态分离
- 验证右侧边栏不再自动创建 DevServer 日志标签
- 验证 Companion 安装入口不再走 Agent 任务创建

**Step 2: Run test to verify it fails**
Run: `node --test "frontend/tests/preview-companion-install-and-logs.test.js"`
Expected: FAIL

**Step 3: Write minimal implementation**
实现最小状态拆分、删除重复日志标签逻辑、接入本地安装链路。

**Step 4: Run test to verify it passes**
Run: `node --test "frontend/tests/preview-companion-install-and-logs.test.js"`
Expected: PASS

### Task 2: 增加本地安装 Companion 的桌面端能力

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/workspaces.rs`
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/utils/installWebCompanion.ts`

**Step 1: Add install command**
实现本地命令检测包管理器并在目标 repo 根目录安装 `vibe-kanban-web-companion`。

**Step 2: Add frontend integration helper**
检测 `src/main.*` 入口并自动插入 `VibeKanbanWebCompanion`。

**Step 3: Verify**
Run: `pnpm run frontend:check`
Expected: PASS

### Task 3: 完整验证

**Files:**
- Test: `frontend/tests/preview-companion-install-and-logs.test.js`
- Test: `frontend/tests/dev-preview-panel-routing.test.js`
- Test: `frontend/tests/history-loading-and-terminal-copy.test.js`
- Test: `frontend/tests/workspace-history-and-selector-regressions.test.js`

**Step 1: Run targeted tests**
Run: `node --test "frontend/tests/preview-companion-install-and-logs.test.js" "frontend/tests/dev-preview-panel-routing.test.js" "frontend/tests/history-loading-and-terminal-copy.test.js" "frontend/tests/workspace-history-and-selector-regressions.test.js"`
Expected: PASS

**Step 2: Run type check**
Run: `pnpm run frontend:check`
Expected: PASS

**Step 3: Run file-scoped lint**
Run: `cd frontend && pnpm exec eslint src/components/panels/PreviewPanel.tsx src/components/tasks/TaskDetails/preview/NoServerContent.tsx src/components/layout/RightPanelSidebar.tsx src/utils/installWebCompanion.ts`
Expected: PASS
