# Desktop-Only Dev Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为项目增加桌面端 only 的开发模式，不再依赖独立的 Vite Web 前端服务，同时保持现有默认开发流程不被直接破坏。

**Architecture:** 通过新增一份 `tauri.desktop.conf.json` 覆盖开发态 Tauri 配置，让 Tauri 使用 `frontend/dist` 作为前端来源，并通过 `vite build --watch` 持续构建静态资源。默认 `dev` 与 `tauri:dev` 保持不变，仅新增一组桌面端 only 脚本与文档入口。

**Tech Stack:** Tauri v2、Vite、Node.js 脚本、npm package scripts。

---

### Task 1: 锁定桌面端 only 回归测试

**Files:**
- Create: `frontend/tests/desktop-only-dev-mode.test.js`

**Step 1: Write the failing test**
- 验证存在独立的 `src-tauri/tauri.desktop.conf.json`
- 验证该配置将 `beforeDevCommand` 指向前端静态构建监听，并关闭 `devUrl`
- 验证新增 `frontend:build:watch`、`tauri:dev:desktop`、`dev:desktop`
- 验证 README 暴露桌面端 only 开发命令

**Step 2: Run test to verify it fails**

Run: `node --test "frontend/tests/desktop-only-dev-mode.test.js"`
Expected: FAIL

**Step 3: Write minimal implementation**

新增 Tauri 覆盖配置、前端构建监听脚本、桌面端 only 启动脚本及文档说明。

**Step 4: Run test to verify it passes**

Run: `node --test "frontend/tests/desktop-only-dev-mode.test.js"`
Expected: PASS

### Task 2: 验证桌面端 only 命令链可用

**Files:**
- Modify: `package.json`
- Modify: `frontend/package.json`
- Modify: `README.md`
- Create: `src-tauri/tauri.desktop.conf.json`

**Step 1: Run targeted validation**

Run: `pnpm run frontend:check`
Expected: PASS

**Step 2: Run config/script lint-equivalent validation**

Run: `node --test "frontend/tests/desktop-only-dev-mode.test.js"`
Expected: PASS

### Task 3: 最终验证

**Files:**
- Test: `frontend/tests/desktop-only-dev-mode.test.js`

**Step 1: Run all targeted tests**

Run: `node --test "frontend/tests/desktop-only-dev-mode.test.js" "frontend/tests/preview-companion-install-and-logs.test.js" "frontend/tests/dev-preview-panel-routing.test.js"`
Expected: PASS

**Step 2: Run frontend type check**

Run: `pnpm run frontend:check`
Expected: PASS
