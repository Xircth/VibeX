# Session Isolation And Dialog Sizing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复“新建会话无效”，支持同一 workspace 下多会话隔离显示与并行运行，并补充会话标题/状态展示，同时修复对话框因内容过多被撑爆的问题。

**Architecture:** 保持 workspace 共享文件与 Git 状态，但将聊天日志、执行进程、会话选择、会话标题与状态切到 session 维度。后端新增 `get_session_summaries` 命令并把运行中互斥从 workspace 级改为 session 级；前端 `TaskAttemptPanel` 在 new-session 模式下不再回退到旧会话。通用对话框增加最大高度与滚动能力。

**Tech Stack:** React、TypeScript、Tauri commands、Rust、TanStack Query。

---

### Task 1: 锁定会话隔离与对话框回归测试

**Files:**
- Create: `frontend/tests/session-isolation-and-dialog-sizing.test.js`

**Step 1: Write the failing test**
- `TaskAttemptPanel` 在新建模式下不回退旧 session
- `useWorkspaceSessions` / session selector 使用 session summaries
- 后端存在 session summary 命令与 session-level running check
- 对话框增加 max-height 与 overflow-y-auto

**Step 2: Run test to verify it fails**
Run: `node --test "frontend/tests/session-isolation-and-dialog-sizing.test.js"`
Expected: FAIL

**Step 3: Write minimal implementation**
完成后端命令、前端 hook、UI 展示和对话框上限。

**Step 4: Run test to verify it passes**
Run: `node --test "frontend/tests/session-isolation-and-dialog-sizing.test.js"`
Expected: PASS

### Task 2: 实现后端会话摘要与并发放开

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `crates/db/src/models/execution_process.rs`

**Step 1: Add session summary command**
返回 first prompt / running status。

**Step 2: Relax workspace-wide running lock**
把 `follow_up` / `start_review` 的运行检查改为 session 级。

### Task 3: 实现前端会话隔离与会话列表

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/hooks/useWorkspaceSessions.ts`
- Modify: `frontend/src/components/panels/TaskAttemptPanel.tsx`
- Modify: `frontend/src/components/tasks/TaskFollowUpSection.tsx`

**Step 1: New session mode isolation**
new-session 时日志区和执行进程上下文不再回退旧会话。

**Step 2: Session list naming/status**
标题优先第一条 prompt，否则 `session1/session2`；显示运行中/排队/空闲状态。

### Task 4: 修复通用对话框高度

**Files:**
- Modify: `frontend/src/components/ui/dialog.tsx`

**Step 1: Add height cap and scroll**
为对话框根容器增加最大高度与纵向滚动。

### Task 5: Final verification

**Step 1: Run targeted tests**
Run: `node --test "frontend/tests/session-isolation-and-dialog-sizing.test.js"`
Expected: PASS

**Step 2: Run type checks**
Run: `pnpm run frontend:check && pnpm run backend:check`
Expected: PASS
