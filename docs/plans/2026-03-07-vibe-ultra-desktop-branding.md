# VibeUltra Desktop Branding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将桌面端品牌更新为 `VibeUltra`，保留 Tauri + frontend 架构，并移除独立 Web/PWA 品牌入口。

**Architecture:** 保持 `frontend/` 作为桌面端内嵌 UI，仅调整用户可见品牌文案、统一 Logo 组件、替换 Tauri bundle icon，并去除 `index.html` 中独立 Web/PWA 入口引用。技术标识不改，避免破坏构建与外部集成。

**Tech Stack:** Tauri v2、React、TypeScript、Vite、Node test、Cargo check

---

## Task 1: 写品牌回归测试

**Files:**
- Create: `frontend/tests/branding-desktop-only.test.js`

**Step 1: Write the failing test**

添加以下断言：

- `frontend/src/components/Logo.tsx` 包含 `VibeUltra`
- `frontend/src/pages/settings/SettingsLayout.tsx` 使用内部品牌图
- `frontend/index.html` 不再包含 `site.webmanifest` 与 `favicon-vk`
- `src-tauri/tauri.conf.json` 的品牌值最终应为 `VibeUltra`

**Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: FAIL，因为当前源码仍包含 `Vibe Kanban` / `favicon-vk` / 旧标题。

**Step 3: Do not commit**

按仓库 `AGENTS.md`，本次跳过 commit 步骤。

---

## Task 2: 更新前端品牌资源与展示组件

**Files:**
- Create: `frontend/src/assets/vibe-ultra.png`
- Modify: `frontend/src/components/Logo.tsx`
- Modify: `frontend/src/pages/settings/SettingsLayout.tsx`
- Modify: `frontend/src/components/layout/StatusBar.tsx`
- Modify: `frontend/src/components/welcome/WelcomePage.tsx`
- Modify: `frontend/src/components/dialogs/global/OnboardingDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/DisclaimerDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/BetaWorkspacesDialog.tsx`
- Modify: `frontend/src/components/dialogs/global/ReleaseNotesDialog.tsx`
- Modify: `frontend/src/contexts/ProjectContext.tsx`
- Modify: `frontend/src/components/dialogs/tasks/CreatePRDialog.tsx`

**Step 1: Copy internal logo asset**

将 `C:/Users/Administrator/Downloads/VibeUltra.png` 复制到 `frontend/src/assets/vibe-ultra.png`。

**Step 2: Implement minimal branding updates**

- `Logo.tsx` 改为图片 + `VibeUltra`
- `SettingsLayout.tsx` 在页头展示内部品牌图
- 统一关键用户可见文案为 `VibeUltra`
- `ProjectContext.tsx` 页面标题改为 `VibeUltra`
- `CreatePRDialog.tsx` 默认 PR 标题后缀改为 `(VibeUltra)`

**Step 3: Run test to verify progress**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: 与前端品牌相关断言通过；Tauri 配置相关断言暂可能仍失败。

---

## Task 3: 更新桌面端应用名与图标

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/icons/*`

**Step 1: Update desktop visible name**

将 `src-tauri/tauri.conf.json` 中：

- `productName` 改为 `VibeUltra`
- `app.windows[0].title` 改为 `VibeUltra`

**Step 2: Generate icon set**

从 `C:/Users/Administrator/Downloads/VibeUltra_background.png` 生成 `src-tauri/icons/` 需要的标准图标文件。

**Step 3: Run test to verify it passes**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS。

---

## Task 4: 去除独立 Web/PWA 入口引用

**Files:**
- Modify: `frontend/index.html`

**Step 1: Remove manifest and favicon references**

删除或停用：

- `rel="icon"` 的 `favicon-vk-*`
- `rel="apple-touch-icon"`
- `rel="manifest"`（如存在）

保留基础 HTML 壳与页面标题。

**Step 2: Verify via tests**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS。

---

## Task 5: 完整验证

**Files:**
- Verify only

**Step 1: Run targeted test**

Run: `node --test frontend/tests/branding-desktop-only.test.js`

Expected: PASS。

**Step 2: Run frontend type check**

Run: `pnpm run frontend:check`

Expected: exit 0。

**Step 3: Run backend check**

Run: `pnpm run backend:check`

Expected: exit 0。

**Step 4: Run final search**

Run: `rg -n --hidden --glob '!Vibe-kanban-originbase/**' --glob '!.git/**' 'Vibe Kanban Promax|VIBE-KANBAN-PROMAX|Vibe Kanban|vibe-kanban' frontend src-tauri`

Expected: 仅剩技术标识或明确保留项；无遗漏的用户可见品牌文案。

**Step 5: Do not commit**

按仓库 `AGENTS.md`，本次跳过 commit 步骤。
