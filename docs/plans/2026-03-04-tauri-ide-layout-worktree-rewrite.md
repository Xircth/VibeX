# Vibe Kanban Promax 大规模重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 vibe-kanban-promax 从 Axum Web 服务器架构迁移到 Tauri v2 桌面应用，实现类 IDE 的 docking 布局，并优化 Worktree 一主多分协同开发流程。

**Architecture:** 用 Tauri v2 Commands 完全替代 Axum HTTP API，用 Tauri Events 替代 WebSocket JSON Patch 流。前端使用 dockview 实现 VS Code 式面板拖拽布局，Monaco Editor 提供代码编辑/预览，xterm.js + PTY 提供终端。Git 操作层新增 rebase-back 流程，支持 AI 自动冲突解决。

**Tech Stack:** Tauri v2, React 18, TypeScript, dockview, Monaco Editor, xterm.js, SQLx/SQLite, git2, Lexical, rmcp (MCP)

---

## 阶段概览

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **Phase 1** | Tauri v2 项目脚手架搭建 | 无 |
| **Phase 2** | Rust 后端迁移（Axum → Tauri Commands + Events） | Phase 1 |
| **Phase 3** | 前端数据层迁移（HTTP/WS → Tauri invoke/listen） | Phase 2 |
| **Phase 4** | 类 IDE 布局（dockview） | Phase 3 |
| **Phase 5** | 文件树 + Monaco Editor | Phase 4 |
| **Phase 6** | 终端集成（PTY） | Phase 4 |
| **Phase 7** | Worktree 一主多分协同 | Phase 3 |
| **Phase 8** | 清理、裁剪与集成测试 | Phase 4-7 |

### 可并行执行的阶段
- Phase 5 和 Phase 6 可以并行（都依赖 Phase 4，互不依赖）
- Phase 7 可以和 Phase 5/6 并行（只依赖 Phase 3）

---

## 保留与移除清单

### 保留
- AI 执行器：ClaudeCode, Codex, OpenCode
- MCP 服务器集成 (rmcp)
- Lexical 富文本编辑器（消息输入）
- SQLite 数据库 + SQLx
- git2 Git 操作
- PTY 终端服务
- TanStack Query（适配 Tauri Commands）
- Zustand 状态管理
- @dnd-kit（Kanban 拖拽）
- Framer Motion（动画）

### 移除
- Axum HTTP 服务器 + 所有路由（用 Tauri Commands 替代）
- WebSocket 流（用 Tauri Events 替代）
- tower-http 中间件
- i18n 国际化（i18next）
- npx CLI 启动方式
- AI 执行器：Amp, Gemini, CursorAgent, QwenCode, Copilot, Droid, Auggie
- SSE 事件流
- 前端 HTTP API 客户端层（替换为 Tauri invoke）
- wa-sqlite（浏览器端 SQLite，不再需要）
- react-resizable-panels（替换为 dockview）

### 新增
- Tauri v2（tauri, tauri-build, tauri-plugin-shell 等）
- dockview（docking 布局）
- Monaco Editor（@monaco-editor/react）
- 文件树组件（自建，基于 Tauri fs API + git2 状态）

---

## Phase 1: Tauri v2 项目脚手架搭建

> 目标：在现有项目基础上初始化 Tauri v2，建立 Rust ↔ React 的基本通信通道，确保 `pnpm tauri:dev` 能启动空白应用。

### Task 1.1: 初始化 Tauri v2 项目结构

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/icons/` (应用图标)
- Modify: `Cargo.toml` (workspace members 添加 src-tauri)
- Modify: `package.json` (添加 tauri 脚本)

**Step 1: 安装 Tauri CLI**

```bash
cd C:\Users\Administrator\AppData\Local\Temp\vibe-kanban\worktrees\5468-superpowers-brai\vibe-kanban-promax
pnpm add -Dw @tauri-apps/cli@^2
```

**Step 2: 创建 src-tauri/Cargo.toml**

```toml
[package]
name = "vibe-kanban-promax"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
tauri-plugin-shell = "2"
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
anyhow = { workspace = true }

# 复用现有 workspace crates
vk-db = { path = "../crates/db" }
vk-services = { path = "../crates/services" }
vk-executors = { path = "../crates/executors" }
vk-git = { path = "../crates/git" }
vk-local-deployment = { path = "../crates/local-deployment" }
vk-api-types = { path = "../crates/api-types" }
vk-utils = { path = "../crates/utils" }
vk-review = { path = "../crates/review" }
vk-deployment = { path = "../crates/deployment" }
```

**Step 3: 创建 src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

**Step 4: 创建 src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vibe_kanban_promax_lib::run()
}
```

**Step 5: 创建 src-tauri/src/lib.rs（最小启动）**

```rust
use tauri::Manager;

#[tauri::command]
async fn health_check() -> Result<String, String> {
    Ok("ok".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![health_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 6: 创建 src-tauri/tauri.conf.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/nicktomlin/tauri-v2-schema/refs/heads/main/tauri.conf.json",
  "productName": "Vibe Kanban Promax",
  "version": "0.1.0",
  "identifier": "com.vibe-kanban.promax",
  "build": {
    "beforeDevCommand": "pnpm --filter frontend dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm --filter frontend build",
    "frontendDist": "../frontend/dist"
  },
  "app": {
    "title": "Vibe Kanban Promax",
    "windows": [
      {
        "label": "main",
        "title": "Vibe Kanban Promax",
        "width": 1400,
        "height": 900,
        "resizable": true,
        "fullscreen": false,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "plugins": {
    "shell": {
      "open": true
    },
    "fs": {
      "scope": {
        "allow": ["**"],
        "deny": []
      }
    }
  }
}
```

**Step 7: 创建 src-tauri/capabilities/default.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/nicktomlin/tauri-v2-schema/refs/heads/main/capabilities.json",
  "identifier": "default",
  "description": "Default capabilities for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "fs:default",
    "fs:allow-read",
    "fs:allow-write",
    "dialog:default"
  ]
}
```

**Step 8: 修改根 Cargo.toml，添加 src-tauri 到 workspace**

在 `Cargo.toml` 的 `[workspace] members` 数组中添加 `"src-tauri"`。

**Step 9: 修改根 package.json，添加 tauri 脚本**

```json
{
  "scripts": {
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

**Step 10: 复制应用图标**

```bash
# 从现有 assets 目录复制或生成图标
mkdir -p src-tauri/icons
# 使用 tauri 图标生成工具（如果有 1024x1024 原图）
# npx @tauri-apps/cli icon assets/icon.png
# 或手动放置占位图标
```

**Step 11: 验证 Tauri 应用可以启动**

```bash
pnpm tauri:dev
```

Expected: Tauri 窗口打开，加载前端页面（可能有 API 错误，这是正常的）。

**Step 12: 验证 health_check command 可调用**

在前端控制台测试：
```javascript
const { invoke } = window.__TAURI__.core;
await invoke('health_check'); // 应返回 "ok"
```

**Step 13: Commit**

```bash
git add src-tauri/ Cargo.toml package.json
git commit -m "feat: initialize Tauri v2 project scaffold"
```

---

### Task 1.2: 建立 Tauri 状态管理（AppState）

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 创建 AppState 结构体**

这是 Tauri 应用的全局状态，持有所有服务实例。从 `LocalDeployment` 提取关键服务：

```rust
// src-tauri/src/state.rs
use std::sync::Arc;
use tokio::sync::RwLock;
use vk_db::DBService;
use vk_git::GitService;
use vk_local_deployment::LocalDeployment;

pub struct AppState {
    pub deployment: Arc<LocalDeployment>,
}

impl AppState {
    pub async fn new() -> anyhow::Result<Self> {
        let deployment = LocalDeployment::new().await?;
        Ok(Self {
            deployment: Arc::new(deployment),
        })
    }
}
```

**Step 2: 在 lib.rs 中注册 AppState**

```rust
use tauri::Manager;
mod state;
use state::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = AppState::new().await
                    .expect("Failed to initialize app state");
                handle.manage(state);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![health_check])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 3: 验证 AppState 初始化不报错**

```bash
pnpm tauri:dev
```

Expected: 应用启动，控制台无 panic。

**Step 4: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: add AppState with LocalDeployment initialization"
```

---

### Task 1.3: 建立前端 Tauri 适配层

**Files:**
- Create: `frontend/src/lib/tauri-api.ts`
- Modify: `frontend/package.json`

**Step 1: 安装 Tauri 前端依赖**

```bash
cd frontend
pnpm add @tauri-apps/api@^2 @tauri-apps/plugin-fs@^2 @tauri-apps/plugin-shell@^2 @tauri-apps/plugin-dialog@^2
```

**Step 2: 创建 Tauri API 适配层**

```typescript
// frontend/src/lib/tauri-api.ts
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * 封装 Tauri invoke，统一错误处理
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    console.error(`Tauri command failed: ${cmd}`, error);
    throw error;
  }
}

/**
 * 封装 Tauri event listener，返回取消订阅函数
 */
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/**
 * 封装 Tauri event emit
 */
export async function tauriEmit(event: string, payload?: unknown): Promise<void> {
  await emit(event, payload);
}

// 健康检查（验证通信通道）
export async function healthCheck(): Promise<string> {
  return tauriInvoke<string>('health_check');
}
```

**Step 3: 验证前端可以调用 Tauri command**

在 `App.tsx` 的 `useEffect` 中临时添加：
```typescript
import { healthCheck } from './lib/tauri-api';
useEffect(() => {
  healthCheck().then(console.log).catch(console.error);
}, []);
```

**Step 4: 运行验证**

```bash
pnpm tauri:dev
```

Expected: 控制台输出 "ok"。

**Step 5: 移除临时测试代码，Commit**

```bash
git add frontend/src/lib/tauri-api.ts frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat: add Tauri frontend API adapter layer"
```

---

*Phase 1 完成标志：`pnpm tauri:dev` 可以启动桌面应用，前端能通过 `invoke` 调用 Rust 后端。*

---

## Phase 2: Rust 后端迁移（Axum → Tauri Commands + Events）

> 目标：将所有 Axum HTTP 路由转换为 Tauri Commands，将所有 WebSocket/SSE 流转换为 Tauri Events。保留现有的服务层（ContainerService、GitService 等）不变，只替换传输层。

### 迁移策略

**分组迁移，按功能模块逐个替换：**

1. **CRUD Commands** — 普通 REST 端点 → `#[tauri::command]` 函数
2. **Stream Events** — WebSocket/SSE → Tauri Events（`app.emit()` + `listen()`）
3. **PTY Commands** — 终端 WebSocket → 双向 Tauri Command + Events
4. **模式转换** — Axum 中间件注入 `Extension<T>` → Command 内手动查询

### 错误处理约定

所有 Tauri Commands 统一使用以下错误类型：

```rust
// src-tauri/src/error.rs
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("Conflict: {0}")]
    Conflict(String),
}

// Tauri 要求 command 错误实现 Serialize
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
```

---

### Task 2.1: 创建错误处理和 Command 模块结构

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/projects.rs`
- Create: `src-tauri/src/commands/tasks.rs`
- Create: `src-tauri/src/commands/workspaces.rs`
- Create: `src-tauri/src/commands/sessions.rs`
- Create: `src-tauri/src/commands/terminal.rs`
- Create: `src-tauri/src/commands/events.rs`
- Create: `src-tauri/src/commands/filesystem.rs`
- Create: `src-tauri/src/commands/config.rs`
- Create: `src-tauri/src/commands/repos.rs`
- Create: `src-tauri/src/commands/tags.rs`
- Create: `src-tauri/src/commands/approvals.rs`
- Create: `src-tauri/src/commands/execution_processes.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 创建 error.rs**

创建上述错误处理代码。

**Step 2: 创建 commands/mod.rs 骨架**

```rust
// src-tauri/src/commands/mod.rs
pub mod projects;
pub mod tasks;
pub mod workspaces;
pub mod sessions;
pub mod terminal;
pub mod events;
pub mod filesystem;
pub mod config;
pub mod repos;
pub mod tags;
pub mod approvals;
pub mod execution_processes;
```

**Step 3: 在 lib.rs 中注册所有模块**

```rust
mod error;
mod state;
mod commands;
```

**Step 4: Commit**

```bash
git add src-tauri/src/
git commit -m "feat: create Tauri command module structure and error handling"
```

---

### Task 2.2: 项目管理 Commands（projects）

**Files:**
- Modify: `src-tauri/src/commands/projects.rs`
- Modify: `src-tauri/src/lib.rs` (注册 commands)

**Step 1: 实现项目 CRUD commands**

```rust
// src-tauri/src/commands/projects.rs
use tauri::State;
use uuid::Uuid;
use crate::state::AppState;
use crate::error::AppError;
use vk_db::models::project::{Project, CreateProject, UpdateProject, SearchResult};

#[tauri::command]
pub async fn get_projects(
    state: State<'_, AppState>,
) -> Result<Vec<Project>, AppError> {
    let db = state.deployment.db();
    let projects = Project::find_all(db.pool()).await?;
    Ok(projects)
}

#[tauri::command]
pub async fn get_project(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<Project, AppError> {
    let db = state.deployment.db();
    let project = Project::find_by_id(db.pool(), project_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {project_id} not found")))?;
    Ok(project)
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    payload: CreateProject,
) -> Result<Project, AppError> {
    let project = state.deployment.project().create(payload).await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(project)
}

#[tauri::command]
pub async fn update_project(
    state: State<'_, AppState>,
    project_id: Uuid,
    payload: UpdateProject,
) -> Result<Project, AppError> {
    let db = state.deployment.db();
    let project = Project::update(db.pool(), project_id, payload).await?;
    Ok(project)
}

#[tauri::command]
pub async fn delete_project(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    Project::delete(db.pool(), project_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn search_project_files(
    state: State<'_, AppState>,
    project_id: Uuid,
    query: String,
) -> Result<Vec<SearchResult>, AppError> {
    let results = state.deployment.project()
        .search_files(project_id, &query).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(results)
}

#[tauri::command]
pub async fn open_project_in_editor(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    let project = Project::find_by_id(db.pool(), project_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {project_id}")))?;
    state.deployment.project().open_in_editor(&project).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

// 项目仓库管理
#[tauri::command]
pub async fn get_project_repositories(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<Vec<vk_db::models::repo::Repo>, AppError> {
    let db = state.deployment.db();
    let repos = vk_db::models::repo::Repo::find_by_project_id(db.pool(), project_id).await?;
    Ok(repos)
}

#[tauri::command]
pub async fn add_project_repository(
    state: State<'_, AppState>,
    project_id: Uuid,
    payload: vk_db::models::repo::CreateRepo,
) -> Result<vk_db::models::repo::Repo, AppError> {
    let repo = state.deployment.repo().add_to_project(project_id, payload).await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;
    Ok(repo)
}

#[tauri::command]
pub async fn delete_project_repository(
    state: State<'_, AppState>,
    project_id: Uuid,
    repo_id: Uuid,
) -> Result<(), AppError> {
    state.deployment.repo().remove_from_project(project_id, repo_id).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}
```

**Step 2: 在 lib.rs 注册 project commands**

```rust
.invoke_handler(tauri::generate_handler![
    commands::projects::get_projects,
    commands::projects::get_project,
    commands::projects::create_project,
    commands::projects::update_project,
    commands::projects::delete_project,
    commands::projects::search_project_files,
    commands::projects::open_project_in_editor,
    commands::projects::get_project_repositories,
    commands::projects::add_project_repository,
    commands::projects::delete_project_repository,
])
```

**Step 3: 编写测试**

在 Tauri dev 模式下，从前端控制台验证：
```javascript
await invoke('get_projects'); // 应返回空数组或已有项目
```

**Step 4: Commit**

```bash
git add src-tauri/src/commands/projects.rs src-tauri/src/lib.rs
git commit -m "feat: implement project management Tauri commands"
```

---

### Task 2.3: 任务管理 Commands（tasks）

**Files:**
- Modify: `src-tauri/src/commands/tasks.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现任务 CRUD commands**

```rust
// src-tauri/src/commands/tasks.rs
use tauri::State;
use uuid::Uuid;
use crate::state::AppState;
use crate::error::AppError;
use vk_db::models::task::{Task, TaskWithAttemptStatus, CreateTask, UpdateTask};

#[tauri::command]
pub async fn get_tasks(
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<Vec<TaskWithAttemptStatus>, AppError> {
    let db = state.deployment.db();
    let tasks = Task::find_by_project_id_with_attempt_status(db.pool(), project_id).await?;
    Ok(tasks)
}

#[tauri::command]
pub async fn get_task(
    state: State<'_, AppState>,
    task_id: Uuid,
) -> Result<Task, AppError> {
    let db = state.deployment.db();
    let task = Task::find_by_id(db.pool(), task_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Task {task_id}")))?;
    Ok(task)
}

#[tauri::command]
pub async fn create_task(
    state: State<'_, AppState>,
    payload: CreateTask,
) -> Result<Task, AppError> {
    let db = state.deployment.db();
    let task = Task::create(db.pool(), payload).await?;
    Ok(task)
}

#[tauri::command]
pub async fn update_task(
    state: State<'_, AppState>,
    task_id: Uuid,
    payload: UpdateTask,
) -> Result<Task, AppError> {
    let db = state.deployment.db();
    let task = Task::update(db.pool(), task_id, payload).await?;
    Ok(task)
}

#[tauri::command]
pub async fn delete_task(
    state: State<'_, AppState>,
    task_id: Uuid,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    Task::delete(db.pool(), task_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_task_and_start(
    state: State<'_, AppState>,
    payload: CreateTaskAndStartRequest,
) -> Result<Task, AppError> {
    // 组合操作：创建 task + 创建 workspace + 启动 agent
    let db = state.deployment.db();
    let task = Task::create(db.pool(), payload.task).await?;
    // workspace 创建逻辑委托给 workspace command
    Ok(task)
}
```

**Step 2: 注册到 lib.rs 的 invoke_handler**

**Step 3: Commit**

```bash
git add src-tauri/src/commands/tasks.rs src-tauri/src/lib.rs
git commit -m "feat: implement task management Tauri commands"
```

---

### Task 2.4: Workspace（Task Attempts）Commands

**Files:**
- Modify: `src-tauri/src/commands/workspaces.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现 workspace CRUD + 操作 commands**

```rust
// src-tauri/src/commands/workspaces.rs
use tauri::State;
use uuid::Uuid;
use crate::state::AppState;
use crate::error::AppError;
use vk_db::models::workspace::{Workspace, UpdateWorkspace};

#[tauri::command]
pub async fn get_workspaces(
    state: State<'_, AppState>,
    task_id: Option<Uuid>,
    archived: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<Workspace>, AppError> {
    let db = state.deployment.db();
    let workspaces = match task_id {
        Some(tid) => Workspace::find_by_task_id(db.pool(), tid).await?,
        None => Workspace::find_all(db.pool(), archived, limit).await?,
    };
    Ok(workspaces)
}

#[tauri::command]
pub async fn get_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    let db = state.deployment.db();
    Workspace::find_by_id(db.pool(), workspace_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))
}

#[tauri::command]
pub async fn get_workspace_count(
    state: State<'_, AppState>,
) -> Result<i64, AppError> {
    let db = state.deployment.db();
    let count = Workspace::count(db.pool()).await?;
    Ok(count)
}

#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    task_id: Uuid,
    executor_profile_id: String,
    repos: Vec<WorkspaceRepoInput>,
) -> Result<Workspace, AppError> {
    // 复用 task_attempts.rs 中的创建逻辑
    // 1. 校验 repos 非空
    // 2. 计算 agent_working_dir
    // 3. 生成 git branch 名
    // 4. 创建 Workspace 记录
    // 5. 创建 WorkspaceRepo 记录
    // 6. start_workspace
    todo!("Port from task_attempts.rs create_task_attempt")
}

#[tauri::command]
pub async fn update_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    payload: UpdateWorkspace,
) -> Result<Workspace, AppError> {
    let container = state.deployment.container();
    let db = state.deployment.db();

    // 如果归档，先调用 archive_workspace
    if payload.archived == Some(true) {
        container.archive_workspace(workspace_id).await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    }

    let workspace = Workspace::update(db.pool(), workspace_id, payload).await?;
    Ok(workspace)
}

#[tauri::command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    // 先停止运行的进程，再删除
    let workspace = Workspace::find_by_id(db.pool(), workspace_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;
    state.deployment.container().try_stop(&workspace, true).await;
    Workspace::delete(db.pool(), workspace_id).await?;
    Ok(())
}

#[tauri::command]
pub async fn stop_workspace_execution(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    let workspace = Workspace::find_by_id(db.pool(), workspace_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;
    state.deployment.container().try_stop(&workspace, false).await;
    Ok(())
}

// Git 操作
#[tauri::command]
pub async fn get_workspace_branch_status(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<BranchStatus, AppError> {
    todo!("Port from task_attempts.rs get_task_attempt_branch_status")
}

#[tauri::command]
pub async fn merge_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs merge_task_attempt")
}

#[tauri::command]
pub async fn push_workspace_branch(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    force: bool,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs push/force_push")
}

#[tauri::command]
pub async fn rebase_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs rebase_task_attempt")
}

#[tauri::command]
pub async fn continue_rebase_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs continue_rebase_task_attempt")
}

#[tauri::command]
pub async fn abort_conflicts_workspace(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs abort_conflicts_task_attempt")
}

#[tauri::command]
pub async fn change_workspace_target_branch(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    target_branch: String,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs change_target_branch")
}

#[tauri::command]
pub async fn start_workspace_dev_server(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs start_dev_server")
}

#[tauri::command]
pub async fn run_agent_setup(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    executor_profile_id: String,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs run_agent_setup")
}

// PR 操作
#[tauri::command]
pub async fn create_workspace_pr(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from task_attempts.rs pr::create_pr")
}

#[tauri::command]
pub async fn get_workspace_pr_comments(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<PrComment>, AppError> {
    todo!("Port from task_attempts.rs pr::get_pr_comments")
}
```

**Step 2: 注册到 lib.rs**

**Step 3: 逐个移除 `todo!()` 宏，从 `task_attempts.rs` 中移植具体实现逻辑**

每个 `todo!()` 对应 Axum 路由中的一个处理函数，将其核心逻辑（去掉 Axum 的 `State<Arc<...>>` 和 `Extension<T>` 提取）复制到 Tauri command 中。

**Step 4: Commit**

```bash
git add src-tauri/src/commands/workspaces.rs src-tauri/src/lib.rs
git commit -m "feat: implement workspace management Tauri commands"
```

---

### Task 2.5: 会话与 Follow-up Commands（sessions）

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现会话 commands**

```rust
// src-tauri/src/commands/sessions.rs
use tauri::State;
use uuid::Uuid;
use crate::state::AppState;
use crate::error::AppError;
use vk_db::models::session::Session;
use vk_db::models::execution_process::ExecutionProcess;

#[tauri::command]
pub async fn get_sessions(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<Session>, AppError> {
    let db = state.deployment.db();
    let sessions = Session::find_by_workspace_id(db.pool(), workspace_id).await?;
    Ok(sessions)
}

#[tauri::command]
pub async fn get_session(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<Session, AppError> {
    let db = state.deployment.db();
    Session::find_by_id(db.pool(), session_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Session {session_id}")))
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    executor: Option<String>,
) -> Result<Session, AppError> {
    let db = state.deployment.db();
    // 验证 workspace 存在
    let _workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;
    let session = Session::create(db.pool(), workspace_id, executor).await?;
    Ok(session)
}

/// 核心 follow-up command — 发送消息给 AI agent
#[tauri::command]
pub async fn follow_up(
    state: State<'_, AppState>,
    session_id: Uuid,
    prompt: String,
    executor_profile_id: String,
    retry_process_id: Option<Uuid>,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
) -> Result<ExecutionProcess, AppError> {
    // 移植自 sessions/follow_up.rs 的核心逻辑：
    // 1. 加载 session + workspace
    // 2. 确保容器存在
    // 3. 验证 executor 一致性
    // 4. 可选 git reset（retry 场景）
    // 5. 构建 ExecutorAction（Initial 或 FollowUp）
    // 6. 调用 container.start_execution()
    // 7. 清理 DraftFollowUp scratch
    todo!("Port follow_up core logic from sessions/follow_up.rs")
}

/// 重置到指定进程
#[tauri::command]
pub async fn reset_session_process(
    state: State<'_, AppState>,
    session_id: Uuid,
    process_id: Uuid,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
) -> Result<(), AppError> {
    state.deployment.container()
        .reset_session_to_process(
            session_id,
            process_id,
            perform_git_reset.unwrap_or(true),
            force_when_dirty.unwrap_or(false),
        ).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// 代码审查
#[tauri::command]
pub async fn start_review(
    state: State<'_, AppState>,
    session_id: Uuid,
    executor_profile_id: String,
    additional_prompt: Option<String>,
    use_all_workspace_commits: bool,
) -> Result<ExecutionProcess, AppError> {
    todo!("Port from sessions/review.rs start_review")
}

// 消息队列
#[tauri::command]
pub async fn queue_message(
    state: State<'_, AppState>,
    session_id: Uuid,
    message: String,
    executor_profile_id: String,
) -> Result<QueueStatus, AppError> {
    todo!("Port from sessions/queue.rs")
}

#[tauri::command]
pub async fn cancel_queued_message(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    todo!("Port from sessions/queue.rs")
}

#[tauri::command]
pub async fn get_queue_status(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<QueueStatus, AppError> {
    todo!("Port from sessions/queue.rs")
}
```

**Step 2: 注册到 lib.rs**

**Step 3: 移植 follow_up 核心逻辑（这是最复杂的 command）**

`follow_up` 的移植要点：
- 原代码从 `Extension<Session>` 获取 session → 改为 `Session::find_by_id`
- 原代码从 `State<Arc<DeploymentImpl>>` 获取 deployment → 改为 `State<AppState>`
- 其余业务逻辑保持不变

**Step 4: Commit**

```bash
git add src-tauri/src/commands/sessions.rs src-tauri/src/lib.rs
git commit -m "feat: implement session and follow-up Tauri commands"
```

---

### Task 2.6: 实时事件流（Tauri Events 替代 WebSocket/SSE）

**Files:**
- Modify: `src-tauri/src/commands/events.rs`
- Create: `src-tauri/src/events.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`

> 这是迁移中最关键的部分。原项目有 5 个 WebSocket 流和 1 个 SSE 流，全部需要转为 Tauri Events。

**Step 1: 创建事件管理器**

```rust
// src-tauri/src/events.rs
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use uuid::Uuid;

/// 事件通道名称常量
pub mod channels {
    pub const PROJECTS_STREAM: &str = "projects-stream";
    pub const TASKS_STREAM: &str = "tasks-stream";         // 带 project_id 后缀
    pub const WORKSPACES_STREAM: &str = "workspaces-stream";
    pub const DIFF_STREAM: &str = "diff-stream";           // 带 workspace_id 后缀
    pub const CONVERSATION_STREAM: &str = "conversation-stream"; // 带 session_id 后缀
    pub const GLOBAL_EVENTS: &str = "global-events";       // 替代 SSE
}

/// 启动所有后台事件转发任务
pub fn start_event_forwarding(app: &AppHandle, state: &AppState) {
    // 全局事件流（替代 SSE /api/events）
    let app_handle = app.clone();
    let events = state.deployment.events().clone();
    tokio::spawn(async move {
        let mut stream = events.subscribe();
        while let Ok(event) = stream.recv().await {
            let _ = app_handle.emit(channels::GLOBAL_EVENTS, &event);
        }
    });
}

/// 为特定项目启动任务流转发
#[tauri::command]
pub async fn subscribe_tasks_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: Uuid,
) -> Result<(), AppError> {
    let channel = format!("{}:{}", channels::TASKS_STREAM, project_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        // 从 EventService 获取任务变更流
        // 将 JSON Patch 通过 Tauri Events 转发
        // 逻辑移植自 tasks.rs stream_tasks_ws
        let db = deployment.db();
        let msg_store = deployment.events().msg_store().clone();
        let mut rx = msg_store.subscribe();

        while let Ok(patch) = rx.recv().await {
            // 过滤出 tasks 相关的 patch
            let _ = app.emit(&channel, &patch);
        }
    });

    Ok(())
}

/// 为特定 workspace 启动 diff 流转发
#[tauri::command]
pub async fn subscribe_diff_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Uuid,
    stats_only: bool,
) -> Result<(), AppError> {
    let channel = format!("{}:{}", channels::DIFF_STREAM, workspace_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        let db = deployment.db();
        let workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id)
            .await.ok().flatten();
        if let Some(ws) = workspace {
            if let Ok(mut stream) = deployment.container().stream_diff(&ws, stats_only).await {
                use futures::StreamExt;
                while let Some(Ok(msg)) = stream.next().await {
                    let _ = app.emit(&channel, &msg);
                }
            }
        }
    });

    Ok(())
}

/// 为特定 session 启动对话历史流转发
#[tauri::command]
pub async fn subscribe_conversation_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    let channel = format!("{}:{}", channels::CONVERSATION_STREAM, session_id);
    let deployment = state.deployment.clone();

    tokio::spawn(async move {
        // 获取 MsgStore 并订阅 JSON Patch 流
        if let Some(msg_store) = deployment.container()
            .get_msg_store_by_id(&session_id).await
        {
            let mut rx = msg_store.subscribe();
            while let Ok(patch) = rx.recv().await {
                let _ = app.emit(&channel, &patch);
            }
        }
    });

    Ok(())
}
```

**Step 2: 在 setup 中启动全局事件转发**

```rust
// 修改 src-tauri/src/lib.rs 的 setup 闭包
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::block_on(async move {
        let state = AppState::new().await
            .expect("Failed to initialize app state");
        crate::events::start_event_forwarding(&handle, &state);
        handle.manage(state);
    });
    Ok(())
})
```

**Step 3: 注册订阅 commands**

```rust
.invoke_handler(tauri::generate_handler![
    // ... 之前的 commands ...
    commands::events::subscribe_tasks_stream,
    commands::events::subscribe_diff_stream,
    commands::events::subscribe_conversation_stream,
])
```

**Step 4: Commit**

```bash
git add src-tauri/src/events.rs src-tauri/src/commands/events.rs src-tauri/src/lib.rs
git commit -m "feat: implement Tauri Events for real-time streaming (replaces WebSocket/SSE)"
```

---

### Task 2.7: 终端 PTY Commands

**Files:**
- Modify: `src-tauri/src/commands/terminal.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现 PTY 管理 commands**

```rust
// src-tauri/src/commands/terminal.rs
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use crate::state::AppState;
use crate::error::AppError;

/// 创建新的 PTY 终端会话
#[tauri::command]
pub async fn create_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: Uuid,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Uuid, AppError> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    // 确定工作目录（移植自 terminal.rs 的逻辑）
    let db = state.deployment.db();
    let workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;

    let working_dir = state.deployment.container()
        .workspace_to_current_dir(&workspace);

    // 创建 PTY session
    let pty = state.deployment.pty();
    let (session_id, mut output_rx) = pty.create_session(working_dir, cols, rows).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    // 启动后台任务：PTY 输出 → Tauri Event
    let channel = format!("terminal-output:{}", session_id);
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            let encoded = BASE64.encode(&data);
            let _ = app.emit(&channel, encoded);
        }
    });

    Ok(session_id)
}

/// 向 PTY 写入数据
#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    session_id: Uuid,
    data: String, // base64 encoded
) -> Result<(), AppError> {
    let bytes = BASE64.decode(&data)
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {e}")))?;
    state.deployment.pty().write(session_id, &bytes).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// 调整 PTY 终端大小
#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    session_id: Uuid,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    state.deployment.pty().resize(session_id, cols, rows).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// 关闭 PTY 终端会话
#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    session_id: Uuid,
) -> Result<(), AppError> {
    state.deployment.pty().close_session(session_id).await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}
```

**Step 2: 注册 terminal commands 到 lib.rs**

**Step 3: Commit**

```bash
git add src-tauri/src/commands/terminal.rs src-tauri/src/lib.rs
git commit -m "feat: implement PTY terminal Tauri commands with event-based output"
```

---

### Task 2.8: 文件系统、仓库、配置 Commands

**Files:**
- Modify: `src-tauri/src/commands/filesystem.rs`
- Modify: `src-tauri/src/commands/repos.rs`
- Modify: `src-tauri/src/commands/config.rs`
- Modify: `src-tauri/src/commands/tags.rs`
- Modify: `src-tauri/src/commands/approvals.rs`
- Modify: `src-tauri/src/commands/execution_processes.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 文件系统 commands**

```rust
// src-tauri/src/commands/filesystem.rs
#[tauri::command]
pub async fn list_directory(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<DirectoryListResponse, AppError> {
    state.deployment.filesystem().list_directory(path.as_deref()).await
        .map_err(|e| AppError::Internal(e.to_string()))
}

#[tauri::command]
pub async fn list_git_repos(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Vec<DirectoryEntry>, AppError> {
    match path {
        Some(p) => state.deployment.filesystem()
            .list_git_repos(&p, 800, 1200, 3).await,
        None => state.deployment.filesystem()
            .list_common_git_repos(800, 1200, 4).await,
    }.map_err(|e| AppError::Internal(e.to_string()))
}
```

**Step 2: 配置 commands**

```rust
// src-tauri/src/commands/config.rs
#[tauri::command]
pub async fn get_config(
    state: State<'_, AppState>,
) -> Result<Config, AppError> {
    let config = state.deployment.config().read().await.clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_config(
    state: State<'_, AppState>,
    payload: ConfigUpdate,
) -> Result<Config, AppError> {
    todo!("Port from config routes")
}
```

**Step 3: 标签、审批、执行进程 commands（逐个移植）**

这些较简单，都是标准 CRUD 模式。

**Step 4: Commit**

```bash
git add src-tauri/src/commands/
git commit -m "feat: implement filesystem, config, tags, approvals, and execution process commands"
```

---

### Task 2.9: 移除 Axum 服务器 crate

**Files:**
- Delete: `crates/server/` (整个目录)
- Modify: `Cargo.toml` (workspace members 移除 crates/server)
- Modify: 其他 crate 的 Cargo.toml（移除对 server 的依赖）

**Step 1: 从 workspace members 中移除 crates/server**

**Step 2: 确认无其他 crate 依赖 crates/server**

```bash
grep -r "vk-server" crates/*/Cargo.toml
```

**Step 3: 删除 crates/server 目录**

```bash
rm -rf crates/server
```

**Step 4: 验证编译**

```bash
cargo build
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove Axum server crate (replaced by Tauri commands)"
```

---

### Task 2.10: 裁剪不需要的执行器

**Files:**
- Delete: `crates/executors/src/executors/amp.rs`
- Delete: `crates/executors/src/executors/gemini.rs`
- Delete: `crates/executors/src/executors/cursor.rs`
- Delete: `crates/executors/src/executors/qwen.rs`
- Delete: `crates/executors/src/executors/copilot.rs`
- Delete: `crates/executors/src/executors/droid.rs`
- Delete: `crates/executors/src/executors/auggie.rs`
- Modify: `crates/executors/src/executors/mod.rs` (更新 CodingAgent 枚举)

**Step 1: 修改 CodingAgent 枚举，只保留三个执行器**

```rust
#[enum_dispatch]
pub enum CodingAgent {
    ClaudeCode,
    Codex,
    Opencode,
}
```

**Step 2: 删除不需要的执行器文件**

**Step 3: 清理 mod.rs 中的 imports**

**Step 4: 验证编译**

```bash
cargo build
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove unused AI executors, keep ClaudeCode/Codex/OpenCode only"
```

---

*Phase 2 完成标志：所有 Axum 路由已转为 Tauri Commands，WebSocket/SSE 已转为 Tauri Events，crates/server 已删除，cargo build 通过。*

---

## Phase 3: 前端数据层迁移（HTTP/WS → Tauri invoke/listen）

> 目标：将前端所有 HTTP API 调用替换为 `invoke()`，将所有 WebSocket 流替换为 Tauri Events `listen()`，保持上层 React 组件和 hooks 的接口不变。

### 迁移策略

分三步：
1. **替换 REST API 层** — `lib/api.ts` 中约 60+ 个函数全部改为 `tauriInvoke()`
2. **替换 WebSocket 核心 hook** — `useJsonPatchWsStream` 改为基于 Tauri Events 的 `useTauriEventStream`
3. **替换终端 WebSocket** — `TerminalContext` 改为 Tauri PTY commands + events

---

### Task 3.1: 替换 REST API 层

**Files:**
- Rewrite: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/tauri-api.ts`（添加类型化辅助函数）

**Step 1: 增强 tauri-api.ts 工具层**

```typescript
// frontend/src/lib/tauri-api.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}
```

**Step 2: 逐个替换 api.ts 中的 API 函数**

替换模式（以 projectsApi 为例）：

```typescript
// BEFORE (HTTP)
export const projectsApi = {
  getAll: () => fetchApi<Project[]>('/api/projects'),
  create: (data: CreateProject) => fetchApi<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  // ...
};

// AFTER (Tauri invoke)
export const projectsApi = {
  getAll: () => tauriInvoke<Project[]>('get_projects'),
  create: (data: CreateProject) => tauriInvoke<Project>('create_project', { payload: data }),
  update: (id: string, data: UpdateProject) => tauriInvoke<Project>('update_project', { projectId: id, payload: data }),
  delete: (id: string) => tauriInvoke<void>('delete_project', { projectId: id }),
  openEditor: (id: string, data: OpenEditorRequest) => tauriInvoke<OpenEditorResponse>('open_project_in_editor', { projectId: id, ...data }),
  searchFiles: (id: string, query: string, mode?: SearchMode) => tauriInvoke<SearchResult[]>('search_project_files', { projectId: id, query, mode }),
  getRepositories: (projectId: string) => tauriInvoke<Repo[]>('get_project_repositories', { projectId }),
  addRepository: (projectId: string, data: CreateProjectRepo) => tauriInvoke<Repo>('add_project_repository', { projectId, payload: data }),
  deleteRepository: (projectId: string, repoId: string) => tauriInvoke<void>('delete_project_repository', { projectId, repoId }),
};
```

按同样模式替换所有 API 对象：
- `tasksApi` — 5 个函数
- `sessionsApi` — 6 个函数
- `attemptsApi` — ~30 个函数（最多）
- `executionProcessesApi` — 3 个函数
- `fileSystemApi` — 2 个函数
- `repoApi` — ~12 个函数
- `configApi` — ~4 个函数
- `tagsApi` — 4 个函数
- `mcpServersApi` — 2 个函数
- `profilesApi` — 2 个函数
- `imagesApi` — 5 个函数
- `approvalsApi` — 1 个函数
- `scratchApi` — 4 个函数
- `queueApi` — 3 个函数
- `searchApi` — 1 个函数

**Step 3: 删除 fetchApi 辅助函数和 BASE_URL 相关代码**

移除 `api.ts` 中的 `fetchApi`、`getBaseUrl`、URL 构建逻辑。

**Step 4: 验证编译**

```bash
cd frontend && pnpm tsc --noEmit
```

**Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/tauri-api.ts
git commit -m "refactor: replace all REST API calls with Tauri invoke"
```

---

### Task 3.2: 替换 WebSocket 核心 hook — useTauriEventStream

**Files:**
- Rewrite: `frontend/src/hooks/useJsonPatchWsStream.ts` → 重命名为 `useTauriPatchStream.ts`
- Create: `frontend/src/hooks/useTauriPatchStream.ts`
- Modify: `frontend/src/hooks/useProjectTasks.ts`
- Modify: `frontend/src/hooks/useProjects.ts`
- Modify: `frontend/src/hooks/useExecutionProcesses.ts`
- Modify: `frontend/src/hooks/useDiffStream.ts`
- Modify: `frontend/src/hooks/useScratch.ts`
- Modify: `frontend/src/hooks/useSlashCommands.ts`
- Modify: `frontend/src/hooks/useLogStream.ts`

**Step 1: 创建 useTauriPatchStream**

这是替代 `useJsonPatchWsStream` 的核心 hook，底层从 WebSocket 改为 Tauri Events：

```typescript
// frontend/src/hooks/useTauriPatchStream.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { produce } from 'immer';
import type { Operation } from 'rfc6902';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface TauriPatchStreamOptions<T> {
  /** 初始化订阅的 Tauri command 名称 */
  subscribeCommand: string;
  /** 传给订阅 command 的参数 */
  subscribeArgs?: Record<string, unknown>;
  /** Tauri Event 通道名称 */
  eventChannel: string;
  /** 初始数据构造函数 */
  initialData: () => T;
  /** 是否启用 */
  enabled?: boolean;
  /** 可选的 patch 去重 */
  deduplicatePatches?: (patches: Operation[]) => Operation[];
}

interface TauriPatchStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  isInitialized: boolean;
  error: string | null;
}

export function useTauriPatchStream<T>(
  options: TauriPatchStreamOptions<T>,
): TauriPatchStreamResult<T> {
  const {
    subscribeCommand,
    subscribeArgs,
    eventChannel,
    initialData,
    enabled = true,
    deduplicatePatches,
  } = options;

  const [data, setData] = useState<T | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setData(initialData());

    const setup = async () => {
      try {
        // 1. 订阅 Tauri Event 通道
        const unlisten = await listen<
          | { JsonPatch: Operation[] }
          | { Ready: true }
          | { finished: boolean }
        >(eventChannel, (event) => {
          if (cancelled) return;
          const msg = event.payload;

          if ('JsonPatch' in msg) {
            let patches = msg.JsonPatch;
            if (deduplicatePatches) {
              patches = deduplicatePatches(patches);
            }
            setData((current) => {
              if (!current) return current;
              return produce(current, (draft: any) => {
                // 应用 JSON Patch（复用现有的 applyUpsertPatch 逻辑）
                for (const patch of patches) {
                  applyUpsertPatch(draft, patch);
                }
              });
            });
          } else if ('Ready' in msg) {
            setIsInitialized(true);
          } else if ('finished' in msg) {
            // 流结束
          }
        });

        unlistenRef.current = unlisten;
        setIsConnected(true);

        // 2. 调用订阅 command，让 Rust 端开始推送事件
        await invoke(subscribeCommand, subscribeArgs);
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      setIsConnected(false);
      setIsInitialized(false);
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [enabled, eventChannel, subscribeCommand]);

  return { data, isConnected, isInitialized, error };
}
```

**Step 2: 更新 useProjectTasks 使用新 hook**

```typescript
// frontend/src/hooks/useProjectTasks.ts
// BEFORE:
// const endpoint = projectId ? `/api/tasks/stream/ws?project_id=${projectId}` : undefined;
// return useJsonPatchWsStream(endpoint, !!projectId, initialData);

// AFTER:
return useTauriPatchStream({
  subscribeCommand: 'subscribe_tasks_stream',
  subscribeArgs: { projectId },
  eventChannel: `tasks-stream:${projectId}`,
  initialData: () => ({ tasks: {} }),
  enabled: !!projectId,
});
```

**Step 3: 按同样模式更新所有消费 useJsonPatchWsStream 的 hooks**

- `useProjects` → `subscribe_projects_stream` + `projects-stream`
- `useExecutionProcesses` → `subscribe_execution_processes_stream` + `execution-processes-stream:${sessionId}`
- `useDiffStream` → `subscribe_diff_stream` + `diff-stream:${workspaceId}`
- `useScratch` → `subscribe_scratch_stream` + `scratch-stream:${scratchType}:${id}`
- `useSlashCommands` → `subscribe_slash_commands_stream` + `slash-commands-stream:${...}`
- `useLogStream` → `subscribe_log_stream` + `log-stream:${processId}`

**Step 4: 删除旧的 useJsonPatchWsStream.ts**

**Step 5: 验证编译**

```bash
cd frontend && pnpm tsc --noEmit
```

**Step 6: Commit**

```bash
git add frontend/src/hooks/
git commit -m "refactor: replace WebSocket JSON Patch streams with Tauri Events"
```

---

### Task 3.3: 替换终端 WebSocket（TerminalContext）

**Files:**
- Rewrite: `frontend/src/contexts/TerminalContext.tsx`

**Step 1: 重写 TerminalContext 使用 Tauri PTY commands**

```typescript
// frontend/src/contexts/TerminalContext.tsx
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

interface TerminalConnection {
  sessionId: string;
  unlisten: UnlistenFn;
}

// 创建终端连接（替代 WebSocket）
async function createTerminalConnection(
  workspaceId: string,
  cols: number,
  rows: number,
  onData: (data: Uint8Array) => void,
  onExit: () => void,
): Promise<TerminalConnection> {
  // 1. 创建 PTY session（Tauri command）
  const sessionId = await invoke<string>('create_terminal', {
    workspaceId,
    cols,
    rows,
  });

  // 2. 监听输出事件
  const unlisten = await listen<string>(`terminal-output:${sessionId}`, (event) => {
    // event.payload 是 base64 编码的数据
    const bytes = Uint8Array.from(atob(event.payload), c => c.charCodeAt(0));
    onData(bytes);
  });

  return { sessionId, unlisten };
}

// 写入终端
async function writeTerminal(sessionId: string, data: string): Promise<void> {
  const encoded = btoa(data);
  await invoke('write_terminal', { sessionId, data: encoded });
}

// 调整大小
async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_terminal', { sessionId, cols, rows });
}

// 关闭终端
async function closeTerminal(connection: TerminalConnection): Promise<void> {
  connection.unlisten();
  await invoke('close_terminal', { sessionId: connection.sessionId });
}
```

**Step 2: 更新 TerminalContext 的 Provider 组件中的连接管理逻辑**

将原有的 `WebSocket` 创建/重连逻辑替换为上述函数调用。

**Step 3: 验证编译**

**Step 4: Commit**

```bash
git add frontend/src/contexts/TerminalContext.tsx
git commit -m "refactor: replace terminal WebSocket with Tauri PTY commands and events"
```

---

### Task 3.4: 替换对话历史流

**Files:**
- Modify: `frontend/src/hooks/useConversationHistory/index.ts`
- Modify: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts`

**Step 1: 更新对话历史加载逻辑**

对话历史有两个数据源：
- **历史进程**：加载已完成进程的日志 → 改为 `invoke('get_process_logs', { processId })`
- **运行中进程**：实时流 → 改为 `listen('log-stream:${processId}', handler)`

```typescript
// 替换 streamJsonPatchEntries 中的 WebSocket 连接
// BEFORE: new WebSocket(`${wsBase}/api/execution-processes/${processId}/normalized-logs/ws`)
// AFTER:
async function subscribeProcessLogs(processId: string, onPatch: (patches: Operation[]) => void): Promise<UnlistenFn> {
  const unlisten = await listen<{ JsonPatch: Operation[] } | { finished: boolean }>(
    `log-stream:${processId}`,
    (event) => {
      const msg = event.payload;
      if ('JsonPatch' in msg) {
        onPatch(msg.JsonPatch);
      }
    }
  );
  // 触发 Rust 端开始推送
  await invoke('subscribe_log_stream', { processId });
  return unlisten;
}
```

**Step 2: 验证编译**

**Step 3: Commit**

```bash
git add frontend/src/hooks/useConversationHistory/
git commit -m "refactor: replace conversation history WebSocket with Tauri events"
```

---

### Task 3.5: 移除 HTTP/WebSocket 基础设施代码

**Files:**
- Delete: `frontend/src/lib/api.ts` 中的 `fetchApi`、`getBaseUrl`、`getWsUrl` 等辅助函数
- Delete: `frontend/src/hooks/useJsonPatchWsStream.ts`
- Modify: `frontend/package.json`（移除不再需要的依赖）

**Step 1: 清理 api.ts 中的 HTTP 基础设施**

移除：
- `BASE_URL` / `getBaseUrl()` / `getWsUrl()`
- `fetchApi()` 通用 fetch 封装
- 所有 URL 构建逻辑

**Step 2: 移除不再需要的依赖**

```bash
cd frontend
pnpm remove eventsource  # SSE client（如果有）
# wa-sqlite 也可以移除（不再需要浏览器端 SQLite）
pnpm remove wa-sqlite @aspect-build/aspect-sqlite
```

**Step 3: 验证完整编译**

```bash
cd frontend && pnpm tsc --noEmit && pnpm build
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove HTTP/WebSocket infrastructure, clean up unused dependencies"
```

---

### Task 3.6: 移除 i18n 国际化

**Files:**
- Delete: `frontend/src/i18n/` 目录
- Modify: 所有使用 `useTranslation()` / `t()` 的组件
- Modify: `frontend/package.json`（移除 i18next 依赖）

**Step 1: 搜索所有 i18n 使用点**

```bash
grep -r "useTranslation\|i18n\|t(" frontend/src/ --include="*.ts" --include="*.tsx" -l
```

**Step 2: 将所有 `t('key')` 替换为硬编码中文字符串**

由于不再需要国际化，直接使用中文文案。

**Step 3: 移除 i18n 依赖**

```bash
cd frontend
pnpm remove i18next react-i18next i18next-browser-languagedetector
```

**Step 4: 删除 i18n 目录**

**Step 5: 验证编译**

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove i18n internationalization, use hardcoded Chinese strings"
```

---

*Phase 3 完成标志：前端 `pnpm tsc --noEmit` 和 `pnpm build` 通过，所有数据通过 Tauri invoke/listen 获取，无 HTTP/WebSocket 残留。*

---

## Phase 4: 类 IDE 布局（dockview）

> 目标：用 dockview 替换现有的 react-resizable-panels 三区域布局，实现 VS Code 式的面板拖拽、标签页、布局持久化。

### 布局架构设计

```
┌──────────────────────────────────────────────────────────────┐
│                        标题栏 / 工具栏                        │
├──────────┬───────────────┬───────────────┬──────────────────┤
│          │               │               │                  │
│  左区     │    中1区       │     中2区      │   右区 (固定)    │
│ (文件区)  │  (Kanban 等)  │  (预览 等)     │  (AI 对话工作区) │
│          │  多标签页      │  多标签页       │  Follow-up UI   │
│ 可拖走   │               │               │  宽度可调        │
│          ├───────────────┴───────────────┤                  │
│          │         下区 (终端区)           │                  │
│          │         多标签页/多终端          │                  │
└──────────┴───────────────────────────────┴──────────────────┘
```

**dockview 术语映射：**
- 左区 = `DockviewComponent` 的一个 group（position: left）
- 中1、中2 = 两个 group（position: center），水平分割
- 下区 = 一个 group（position: bottom）
- 右区 = **不使用 dockview 管理**，独立的固定面板（React 组件），通过 CSS flex 与 dockview 区域并列
- 标签页 = dockview panel（每个面板在 group 内显示为 tab）

---

### Task 4.1: 安装 dockview 并创建基础布局组件

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/components/layout/IDELayout.tsx`
- Create: `frontend/src/components/layout/WorkspaceLayout.tsx`
- Create: `frontend/src/components/layout/panels/PanelRegistry.tsx`
- Create: `frontend/src/stores/useLayoutStore.ts`
- Modify: `frontend/src/App.tsx`

**Step 1: 安装 dockview**

```bash
cd frontend
pnpm add dockview dockview-react
```

**Step 2: 创建布局状态管理 store**

```typescript
// frontend/src/stores/useLayoutStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SerializedDockview } from 'dockview';

interface LayoutState {
  /** 每个 worktree 独立存储布局 */
  layouts: Record<string, SerializedDockview>;
  /** AI 对话区宽度（像素） */
  aiPanelWidth: number;
  /** 保存指定 worktree 的布局 */
  saveLayout: (workspaceId: string, layout: SerializedDockview) => void;
  /** 获取指定 worktree 的布局 */
  getLayout: (workspaceId: string) => SerializedDockview | undefined;
  /** 设置 AI 面板宽度 */
  setAiPanelWidth: (width: number) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      layouts: {},
      aiPanelWidth: 400,
      saveLayout: (workspaceId, layout) =>
        set((state) => ({
          layouts: { ...state.layouts, [workspaceId]: layout },
        })),
      getLayout: (workspaceId) => get().layouts[workspaceId],
      setAiPanelWidth: (width) => set({ aiPanelWidth: width }),
    }),
    { name: 'vk-layout-store' },
  ),
);
```

**Step 3: 创建面板注册表**

```typescript
// frontend/src/components/layout/panels/PanelRegistry.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

/** 所有可用的面板类型 */
export type PanelType =
  | 'kanban'      // Kanban 看板
  | 'preview'     // 文件预览（Monaco Editor）
  | 'diff'        // Git Diff 预览
  | 'file-tree'   // 文件树
  | 'terminal';   // 终端

export interface PanelParams {
  type: PanelType;
  /** 文件预览/diff 的文件路径 */
  filePath?: string;
  /** 终端的 session ID */
  terminalSessionId?: string;
  /** 工作区 ID */
  workspaceId?: string;
}

/** dockview 面板组件映射 */
export const panelComponents: Record<string, React.FC<IDockviewPanelProps<PanelParams>>> = {
  kanban: React.lazy(() => import('../panels/KanbanPanel')),
  preview: React.lazy(() => import('../panels/PreviewPanel')),
  diff: React.lazy(() => import('../panels/DiffPanel')),
  'file-tree': React.lazy(() => import('../panels/FileTreePanel')),
  terminal: React.lazy(() => import('../panels/TerminalPanel')),
};
```

**Step 4: 创建 IDELayout 主布局组件**

```typescript
// frontend/src/components/layout/IDELayout.tsx
import React, { useCallback, useRef, useEffect } from 'react';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type DockviewApi,
} from 'dockview-react';
import { panelComponents, type PanelParams } from './panels/PanelRegistry';
import { useLayoutStore } from '../../stores/useLayoutStore';
import 'dockview/dist/styles/dockview.css';

interface IDELayoutProps {
  workspaceId: string;
}

export const IDELayout: React.FC<IDELayoutProps> = ({ workspaceId }) => {
  const dockviewRef = useRef<DockviewApi | null>(null);
  const { getLayout, saveLayout, aiPanelWidth, setAiPanelWidth } = useLayoutStore();

  const onReady = useCallback((event: DockviewReadyEvent) => {
    dockviewRef.current = event.api;

    // 尝试恢复已保存的布局
    const savedLayout = getLayout(workspaceId);
    if (savedLayout) {
      event.api.fromJSON(savedLayout);
      return;
    }

    // 默认布局
    // 左区：文件树
    const leftGroup = event.api.addPanel({
      id: 'file-tree',
      component: 'file-tree',
      params: { type: 'file-tree', workspaceId },
      position: { direction: 'left' },
    });

    // 中1区：Kanban
    const centerGroup = event.api.addPanel({
      id: 'kanban',
      component: 'kanban',
      params: { type: 'kanban', workspaceId },
      title: 'Kanban',
    });

    // 中2区：预览（初始为空白欢迎页）
    event.api.addPanel({
      id: 'welcome',
      component: 'preview',
      params: { type: 'preview' },
      title: '欢迎',
      position: { direction: 'right', referencePanel: 'kanban' },
    });

    // 下区：终端
    event.api.addPanel({
      id: 'terminal-1',
      component: 'terminal',
      params: { type: 'terminal', workspaceId },
      title: '终端',
      position: { direction: 'below', referencePanel: 'kanban' },
    });
  }, [workspaceId, getLayout]);

  // 布局变更时自动保存
  useEffect(() => {
    const api = dockviewRef.current;
    if (!api) return;

    const disposable = api.onDidLayoutChange(() => {
      const layout = api.toJSON();
      saveLayout(workspaceId, layout);
    });

    return () => disposable.dispose();
  }, [workspaceId, saveLayout]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* dockview 可拖拽区域 */}
      <div style={{ flex: 1, position: 'relative' }}>
        <DockviewReact
          className="dockview-theme-dark"
          onReady={onReady}
          components={panelComponents}
        />
      </div>

      {/* 右区：AI 对话区（固定，不参与 dockview 拖拽） */}
      <div
        style={{
          width: aiPanelWidth,
          minWidth: 300,
          maxWidth: 800,
          borderLeft: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          resize: 'horizontal',
          overflow: 'auto',
          direction: 'rtl', // hack: 让 resize 手柄在左侧
        }}
      >
        <div style={{ direction: 'ltr', height: '100%' }}>
          {/* AI 对话组件将在这里渲染 */}
          <AIChatPanel workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
};
```

**Step 5: 更新 App.tsx 使用新布局**

将原有的 `TasksLayout` + `TaskKanbanBoard` 路由替换为 `IDELayout`。

**Step 6: 移除旧布局依赖**

```bash
cd frontend
pnpm remove react-resizable-panels
```

**Step 7: 验证编译**

```bash
cd frontend && pnpm tsc --noEmit
```

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: implement dockview IDE layout with panel registry and layout persistence"
```

---

### Task 4.2: 创建各面板包装组件

**Files:**
- Create: `frontend/src/components/panels/KanbanPanel.tsx`
- Create: `frontend/src/components/panels/PreviewPanel.tsx`
- Create: `frontend/src/components/panels/DiffPanel.tsx`
- Create: `frontend/src/components/panels/FileTreePanel.tsx`
- Create: `frontend/src/components/panels/TerminalPanel.tsx`
- Create: `frontend/src/components/panels/AIChatPanel.tsx`

**Step 1: Kanban 面板（包装现有 TaskKanbanBoard）**

```typescript
// frontend/src/components/panels/KanbanPanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TaskKanbanBoard } from '../TaskKanbanBoard';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const KanbanPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <TaskKanbanBoard />
    </div>
  );
};

export default KanbanPanel;
```

**Step 2: 预览面板（Monaco Editor 占位，Phase 5 实现）**

```typescript
// frontend/src/components/panels/PreviewPanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const PreviewPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  if (!params.filePath) {
    return <div className="flex items-center justify-center h-full text-gray-500">选择文件以预览</div>;
  }
  // Monaco Editor 将在 Phase 5 实现
  return <div>Preview: {params.filePath}</div>;
};

export default PreviewPanel;
```

**Step 3: Diff 面板（占位，Phase 5 实现）**

```typescript
// frontend/src/components/panels/DiffPanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const DiffPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  return <div>Git Diff: {params.filePath}</div>;
};

export default DiffPanel;
```

**Step 4: 文件树面板（占位，Phase 5 实现）**

```typescript
// frontend/src/components/panels/FileTreePanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const FileTreePanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  return <div>文件树（Phase 5 实现）</div>;
};

export default FileTreePanel;
```

**Step 5: 终端面板（占位，Phase 6 实现）**

```typescript
// frontend/src/components/panels/TerminalPanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const TerminalPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  return <div>终端（Phase 6 实现）</div>;
};

export default TerminalPanel;
```

**Step 6: AI 对话面板（迁移现有 TaskAttemptPanel + TaskFollowUpSection）**

```typescript
// frontend/src/components/panels/AIChatPanel.tsx
import React from 'react';
import { TaskAttemptPanel } from '../TaskAttemptPanel';
import { TaskFollowUpSection } from '../TaskFollowUpSection';

interface AIChatPanelProps {
  workspaceId: string;
}

export const AIChatPanel: React.FC<AIChatPanelProps> = ({ workspaceId }) => {
  return (
    <div className="flex flex-col h-full">
      {/* 对话历史区域 */}
      <div className="flex-1 overflow-auto">
        <TaskAttemptPanel workspaceId={workspaceId} />
      </div>
      {/* Follow-up 输入区域（Lexical 编辑器） */}
      <div className="border-t">
        <TaskFollowUpSection workspaceId={workspaceId} />
      </div>
    </div>
  );
};
```

**Step 7: Commit**

```bash
git add frontend/src/components/panels/
git commit -m "feat: create dockview panel wrapper components for all panel types"
```

---

### Task 4.3: 实现面板打开/关闭/拖拽操作 API

**Files:**
- Create: `frontend/src/hooks/usePanelActions.ts`
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Step 1: 创建面板操作 hook**

```typescript
// frontend/src/hooks/usePanelActions.ts
import { useCallback, useContext } from 'react';
import { DockviewApi } from 'dockview';
import type { PanelType, PanelParams } from '../components/layout/panels/PanelRegistry';

/** 提供面板操作的 hook — 打开文件、打开终端、关闭面板等 */
export function usePanelActions(api: DockviewApi | null) {
  /** 在中2区打开文件预览 */
  const openFilePreview = useCallback((filePath: string, readOnly?: boolean) => {
    if (!api) return;

    const panelId = `preview:${filePath}`;
    const existing = api.getPanel(panelId);
    if (existing) {
      // 已有标签页，切换到该标签
      existing.api.setActive();
      return;
    }

    // 在中2区（右侧 center group）添加新标签
    api.addPanel({
      id: panelId,
      component: readOnly ? 'preview' : 'preview',
      params: { type: 'preview', filePath } as PanelParams,
      title: filePath.split('/').pop() || filePath,
      // 尝试添加到已有的预览 group
      position: { referencePanel: 'kanban', direction: 'right' },
    });
  }, [api]);

  /** 打开 Git Diff 预览 */
  const openDiffPreview = useCallback((filePath: string) => {
    if (!api) return;

    const panelId = `diff:${filePath}`;
    const existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      return;
    }

    api.addPanel({
      id: panelId,
      component: 'diff',
      params: { type: 'diff', filePath } as PanelParams,
      title: `Diff: ${filePath.split('/').pop()}`,
      position: { referencePanel: 'kanban', direction: 'right' },
    });
  }, [api]);

  /** 创建新终端标签 */
  const openNewTerminal = useCallback((workspaceId: string) => {
    if (!api) return;

    const terminalId = `terminal-${Date.now()}`;
    api.addPanel({
      id: terminalId,
      component: 'terminal',
      params: { type: 'terminal', workspaceId } as PanelParams,
      title: '终端',
      position: { referencePanel: 'terminal-1', direction: 'within' },
    });
  }, [api]);

  /** 关闭面板 */
  const closePanel = useCallback((panelId: string) => {
    if (!api) return;
    const panel = api.getPanel(panelId);
    if (panel) {
      api.removePanel(panel);
    }
  }, [api]);

  /** 切换文件树可见性 */
  const toggleFileTree = useCallback(() => {
    if (!api) return;
    const panel = api.getPanel('file-tree');
    if (panel) {
      panel.api.setVisible(!panel.api.isVisible);
    }
  }, [api]);

  return {
    openFilePreview,
    openDiffPreview,
    openNewTerminal,
    closePanel,
    toggleFileTree,
  };
}
```

**Step 2: 通过 React Context 暴露 panel actions**

```typescript
// frontend/src/contexts/PanelActionsContext.tsx
import { createContext, useContext } from 'react';
import type { usePanelActions } from '../hooks/usePanelActions';

type PanelActions = ReturnType<typeof usePanelActions>;
export const PanelActionsContext = createContext<PanelActions | null>(null);
export const usePanelActionsContext = () => useContext(PanelActionsContext);
```

**Step 3: Commit**

```bash
git add frontend/src/hooks/usePanelActions.ts frontend/src/contexts/PanelActionsContext.tsx
git commit -m "feat: implement panel open/close/toggle actions for dockview"
```

---

### Task 4.4: 实现工具栏（Toolbar）

**Files:**
- Create: `frontend/src/components/layout/Toolbar.tsx`
- Modify: `frontend/src/components/layout/IDELayout.tsx`

**Step 1: 创建工具栏组件**

```typescript
// frontend/src/components/layout/Toolbar.tsx
import React from 'react';
import { usePanelActionsContext } from '../../contexts/PanelActionsContext';

interface ToolbarProps {
  workspaceId: string;
  /** Worktree 分支名 */
  branchName: string;
  /** 目标分支名 */
  targetBranch: string;
  /** 与目标分支的领先/落后 commit 数 */
  aheadBehind: { ahead: number; behind: number } | null;
  onRebaseBack: () => void;
  onRebaseTarget: () => void;
  onChangeTargetBranch: () => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  workspaceId,
  branchName,
  targetBranch,
  aheadBehind,
  onRebaseBack,
  onRebaseTarget,
  onChangeTargetBranch,
}) => {
  const panelActions = usePanelActionsContext();

  return (
    <div className="h-10 bg-gray-900 border-b border-gray-700 flex items-center px-4 gap-3 text-sm">
      {/* 左侧：面板切换按钮 */}
      <button onClick={() => panelActions?.toggleFileTree()} title="文件树">
        📁
      </button>
      <button onClick={() => panelActions?.openNewTerminal(workspaceId)} title="新终端">
        ⌨️
      </button>

      {/* 中间：分支信息和 Rebase 操作（Phase 7 实现） */}
      <div className="flex items-center gap-2 ml-auto">
        <span className="text-gray-400">{branchName}</span>
        {aheadBehind && (
          <span className="text-gray-500 text-xs">
            ↑{aheadBehind.ahead} ↓{aheadBehind.behind}
          </span>
        )}
        <button
          onClick={onChangeTargetBranch}
          className="text-blue-400 hover:text-blue-300 text-xs"
        >
          → {targetBranch}
        </button>
        <button
          onClick={onRebaseTarget}
          className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-xs"
        >
          Rebase {targetBranch}
        </button>
        <button
          onClick={onRebaseBack}
          className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs"
        >
          Rebase Back
        </button>
      </div>
    </div>
  );
};
```

**Step 2: 集成到 IDELayout**

**Step 3: Commit**

```bash
git add frontend/src/components/layout/Toolbar.tsx
git commit -m "feat: implement IDE toolbar with branch info and rebase actions"
```

---

### Task 4.5: 移除旧布局组件

**Files:**
- Delete: `frontend/src/components/TasksLayout.tsx`
- Delete: `frontend/src/components/RightWorkArea.tsx` (如果存在)
- Modify: `frontend/src/pages/ProjectTasks.tsx` (使用新布局)
- Modify: `frontend/src/App.tsx` (更新路由)

**Step 1: 更新 ProjectTasks 页面使用 IDELayout**

```typescript
// frontend/src/pages/ProjectTasks.tsx
import { IDELayout } from '../components/layout/IDELayout';

export const ProjectTasks: React.FC = () => {
  const { workspaceId } = useParams();
  // ... 现有逻辑 ...
  return <IDELayout workspaceId={workspaceId} />;
};
```

**Step 2: 删除旧布局组件文件**

**Step 3: 移除 react-resizable-panels 如果尚未移除**

**Step 4: 验证编译**

```bash
cd frontend && pnpm tsc --noEmit
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: replace old three-panel layout with dockview IDE layout"
```

---

*Phase 4 完成标志：dockview 布局可用，面板可拖拽，标签页可切换，布局按 worktree 持久化，AI 对话区固定在右侧。*

---

## Phase 5: 文件树 + Monaco Editor（可与 Phase 6 并行）

> 目标：实现文件树浏览（带 Git 状态标记）、Monaco Editor 代码预览/编辑（Ctrl+S 保存）、Git Diff 只读查看。文件树可切换到其他 worktree/主分支。

---

### Task 5.1: Rust 端文件树 + Git 状态 Commands

**Files:**
- Create: `src-tauri/src/commands/file_tree.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现文件树读取 command**

```rust
// src-tauri/src/commands/file_tree.rs
use std::path::{Path, PathBuf};
use serde::Serialize;
use tauri::State;
use crate::state::AppState;
use crate::error::AppError;

#[derive(Debug, Serialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeEntry>>,
    /// Git 状态: "modified", "added", "deleted", "renamed", "untracked", "ignored", null
    pub git_status: Option<String>,
}

/// 读取目录树（带 Git 状态标记）
#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
    root_path: String,
    depth: Option<u32>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    let depth = depth.unwrap_or(3);
    let root = PathBuf::from(&root_path);

    if !root.exists() || !root.is_dir() {
        return Err(AppError::NotFound(format!("Directory not found: {root_path}")));
    }

    // 获取 Git 状态
    let git_statuses = state.deployment.git()
        .get_status_map(&root)
        .await
        .unwrap_or_default(); // 非 git 仓库时返回空 map

    let entries = read_dir_recursive(&root, &root, &git_statuses, depth, 0)?;
    Ok(entries)
}

fn read_dir_recursive(
    base: &Path,
    dir: &Path,
    git_statuses: &std::collections::HashMap<String, String>,
    max_depth: u32,
    current_depth: u32,
) -> Result<Vec<FileTreeEntry>, AppError> {
    if current_depth >= max_depth {
        return Ok(vec![]);
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| AppError::Internal(format!("Failed to read dir: {e}")))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| AppError::Internal(e.to_string()))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过隐藏文件和 .git
        if name.starts_with('.') { continue; }
        // 跳过 node_modules, target 等
        if name == "node_modules" || name == "target" { continue; }

        let relative_path = path.strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let is_dir = path.is_dir();
        let git_status = git_statuses.get(&relative_path).cloned();

        let children = if is_dir {
            Some(read_dir_recursive(base, &path, git_statuses, max_depth, current_depth + 1)?)
        } else {
            None
        };

        entries.push(FileTreeEntry {
            name,
            path: relative_path,
            is_dir,
            children,
            git_status,
        });
    }

    // 目录优先，然后按名称排序
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// 读取文件内容
#[tauri::command]
pub async fn read_file_content(
    path: String,
) -> Result<String, AppError> {
    tokio::fs::read_to_string(&path).await
        .map_err(|e| AppError::Internal(format!("Failed to read file: {e}")))
}

/// 保存文件内容
#[tauri::command]
pub async fn save_file_content(
    path: String,
    content: String,
) -> Result<(), AppError> {
    tokio::fs::write(&path, &content).await
        .map_err(|e| AppError::Internal(format!("Failed to write file: {e}")))
}

/// 删除文件
#[tauri::command]
pub async fn delete_file(
    path: String,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        tokio::fs::remove_dir_all(&path).await
    } else {
        tokio::fs::remove_file(&path).await
    }.map_err(|e| AppError::Internal(format!("Failed to delete: {e}")))
}

/// 获取文件的 Git Diff（与 HEAD 对比）
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    repo_path: String,
    file_path: String,
) -> Result<String, AppError> {
    state.deployment.git()
        .get_file_diff(&PathBuf::from(&repo_path), &file_path)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}
```

**Step 2: 在 GitService 中添加 get_status_map 方法**

如果 `crates/git/src/` 中尚无此方法，需添加：

```rust
// crates/git/src/lib.rs 或相关文件
impl GitService {
    /// 获取仓库中所有文件的 Git 状态映射
    pub async fn get_status_map(&self, repo_path: &Path) -> Result<HashMap<String, String>, GitError> {
        let repo = git2::Repository::open(repo_path)?;
        let statuses = repo.statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))?;

        let mut map = HashMap::new();
        for entry in statuses.iter() {
            if let Some(path) = entry.path() {
                let status = match entry.status() {
                    s if s.contains(git2::Status::WT_MODIFIED) || s.contains(git2::Status::INDEX_MODIFIED) => "modified",
                    s if s.contains(git2::Status::WT_NEW) => "untracked",
                    s if s.contains(git2::Status::INDEX_NEW) => "added",
                    s if s.contains(git2::Status::WT_DELETED) || s.contains(git2::Status::INDEX_DELETED) => "deleted",
                    s if s.contains(git2::Status::WT_RENAMED) || s.contains(git2::Status::INDEX_RENAMED) => "renamed",
                    s if s.contains(git2::Status::IGNORED) => "ignored",
                    _ => continue,
                };
                map.insert(path.to_string(), status.to_string());
            }
        }
        Ok(map)
    }
}
```

**Step 3: 注册 commands，验证编译**

**Step 4: Commit**

```bash
git add src-tauri/src/commands/file_tree.rs crates/git/src/
git commit -m "feat: implement file tree and file operations Tauri commands with Git status"
```

---

### Task 5.2: 文件树前端组件

**Files:**
- Rewrite: `frontend/src/components/panels/FileTreePanel.tsx`
- Create: `frontend/src/components/file-tree/FileTreeNode.tsx`
- Create: `frontend/src/hooks/useFileTree.ts`
- Create: `frontend/src/stores/useFileTreeStore.ts`

**Step 1: 文件树状态 store**

```typescript
// frontend/src/stores/useFileTreeStore.ts
import { create } from 'zustand';

interface FileTreeState {
  /** 当前浏览的根路径（可切换到其他 worktree） */
  currentRoot: string;
  /** 当前 worktree 的根路径（用于还原） */
  worktreeRoot: string;
  /** 是否正在浏览其他 worktree */
  isBrowsingOther: boolean;
  /** 展开的目录路径集合 */
  expandedDirs: Set<string>;

  setCurrentRoot: (path: string) => void;
  setWorktreeRoot: (path: string) => void;
  resetToWorktree: () => void;
  toggleDir: (path: string) => void;
}

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  currentRoot: '',
  worktreeRoot: '',
  isBrowsingOther: false,
  expandedDirs: new Set(),

  setCurrentRoot: (path) => set({
    currentRoot: path,
    isBrowsingOther: path !== get().worktreeRoot,
  }),
  setWorktreeRoot: (path) => set({
    worktreeRoot: path,
    currentRoot: path,
    isBrowsingOther: false,
  }),
  resetToWorktree: () => set((state) => ({
    currentRoot: state.worktreeRoot,
    isBrowsingOther: false,
  })),
  toggleDir: (path) => set((state) => {
    const next = new Set(state.expandedDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { expandedDirs: next };
  }),
}));
```

**Step 2: 文件树数据 hook**

```typescript
// frontend/src/hooks/useFileTree.ts
import { useQuery } from '@tanstack/react-query';
import { tauriInvoke } from '../lib/tauri-api';

interface FileTreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileTreeEntry[] | null;
  git_status: string | null;
}

export function useFileTree(rootPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ['file-tree', rootPath],
    queryFn: () => tauriInvoke<FileTreeEntry[]>('get_file_tree', {
      rootPath,
      depth: 5,
    }),
    enabled,
    refetchInterval: 10_000, // 每 10 秒刷新（检测文件变化）
  });
}
```

**Step 3: 文件树节点组件**

```typescript
// frontend/src/components/file-tree/FileTreeNode.tsx
import React from 'react';
import { usePanelActionsContext } from '../../contexts/PanelActionsContext';
import { useFileTreeStore } from '../../stores/useFileTreeStore';

interface FileTreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileTreeEntry[] | null;
  git_status: string | null;
}

const gitStatusColors: Record<string, string> = {
  modified: 'text-yellow-400',
  added: 'text-green-400',
  deleted: 'text-red-400',
  untracked: 'text-green-300',
  renamed: 'text-blue-400',
};

export const FileTreeNode: React.FC<{
  entry: FileTreeEntry;
  rootPath: string;
  depth: number;
}> = ({ entry, rootPath, depth }) => {
  const panelActions = usePanelActionsContext();
  const { expandedDirs, toggleDir } = useFileTreeStore();
  const isExpanded = expandedDirs.has(entry.path);
  const statusColor = entry.git_status ? gitStatusColors[entry.git_status] : '';

  const handleClick = () => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      // 点击文件 → 在中2区打开预览
      const fullPath = `${rootPath}/${entry.path}`;
      panelActions?.openFilePreview(fullPath);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center cursor-pointer hover:bg-gray-700 px-1 py-0.5 ${statusColor}`}
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={handleClick}
      >
        {entry.is_dir && (
          <span className="mr-1 text-xs">{isExpanded ? '▼' : '▶'}</span>
        )}
        <span className="mr-1 text-xs">{entry.is_dir ? '📁' : '📄'}</span>
        <span className="text-sm truncate">{entry.name}</span>
        {entry.git_status && (
          <span className="ml-auto text-xs opacity-60">{entry.git_status[0].toUpperCase()}</span>
        )}
      </div>
      {entry.is_dir && isExpanded && entry.children?.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          rootPath={rootPath}
          depth={depth + 1}
        />
      ))}
    </div>
  );
};
```

**Step 4: 更新 FileTreePanel**

```typescript
// frontend/src/components/panels/FileTreePanel.tsx
import React from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useFileTree } from '../../hooks/useFileTree';
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import { FileTreeNode } from '../file-tree/FileTreeNode';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const FileTreePanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  const { currentRoot, isBrowsingOther, resetToWorktree, setCurrentRoot } = useFileTreeStore();
  const { data: entries, isLoading } = useFileTree(currentRoot, !!currentRoot);

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-300">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-700 text-xs">
        <span className="truncate flex-1" title={currentRoot}>
          {currentRoot.split(/[/\\]/).pop()}
        </span>
        {isBrowsingOther && (
          <button
            onClick={resetToWorktree}
            className="px-1 py-0.5 bg-blue-600 hover:bg-blue-500 rounded text-xs"
          >
            还原
          </button>
        )}
        {/* Worktree 切换下拉菜单 — 可选择其他 worktree 或主分支 */}
        <select
          className="bg-gray-800 border border-gray-600 rounded text-xs px-1"
          onChange={(e) => setCurrentRoot(e.target.value)}
          value={currentRoot}
        >
          {/* 选项由上层 context 提供（所有 worktree 路径） */}
        </select>
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-auto">
        {isLoading && <div className="p-2 text-gray-500">加载中...</div>}
        {entries?.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            rootPath={currentRoot}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
};

export default FileTreePanel;
```

**Step 5: Commit**

```bash
git add frontend/src/components/file-tree/ frontend/src/components/panels/FileTreePanel.tsx frontend/src/hooks/useFileTree.ts frontend/src/stores/useFileTreeStore.ts
git commit -m "feat: implement file tree panel with Git status markers and worktree switching"
```

---

### Task 5.3: Monaco Editor 集成 — 代码预览/编辑

**Files:**
- Modify: `frontend/package.json`
- Rewrite: `frontend/src/components/panels/PreviewPanel.tsx`
- Create: `frontend/src/hooks/useFileContent.ts`

**Step 1: 安装 Monaco Editor**

```bash
cd frontend
pnpm add @monaco-editor/react monaco-editor
```

**Step 2: 文件内容读取/保存 hook**

```typescript
// frontend/src/hooks/useFileContent.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tauriInvoke } from '../lib/tauri-api';

export function useFileContent(filePath: string | undefined) {
  return useQuery({
    queryKey: ['file-content', filePath],
    queryFn: () => tauriInvoke<string>('read_file_content', { path: filePath! }),
    enabled: !!filePath,
  });
}

export function useSaveFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      tauriInvoke<void>('save_file_content', { path, content }),
    onSuccess: (_, { path }) => {
      queryClient.invalidateQueries({ queryKey: ['file-content', path] });
    },
  });
}
```

**Step 3: 实现 PreviewPanel（Monaco Editor）**

```typescript
// frontend/src/components/panels/PreviewPanel.tsx
import React, { useRef, useCallback, useEffect, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { editor } from 'monaco-editor';
import { useFileContent, useSaveFile } from '../../hooks/useFileContent';
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import type { PanelParams } from '../layout/panels/PanelRegistry';
import { confirm } from '@tauri-apps/plugin-dialog';

const PreviewPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params, api: panelApi }) => {
  const { filePath, workspaceId } = params;
  const { data: content, isLoading } = useFileContent(filePath);
  const saveFile = useSaveFile();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const { worktreeRoot, currentRoot } = useFileTreeStore();

  // 是否为只读（不在当前 worktree 下的文件）
  const isReadOnly = filePath ? !filePath.startsWith(worktreeRoot) : true;

  // 根据文件扩展名推断语言
  const language = filePath ? getLanguageFromPath(filePath) : 'plaintext';

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;

    // 注册 Ctrl+S 保存
    editor.addCommand(
      // eslint-disable-next-line no-bitwise
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        if (filePath && !isReadOnly) {
          const value = editor.getValue();
          saveFile.mutate({ path: filePath, content: value });
          setHasUnsavedChanges(false);
        }
      },
    );

    // 监听内容变化
    editor.onDidChangeModelContent(() => {
      if (!isReadOnly) {
        setHasUnsavedChanges(true);
      }
    });
  };

  // 关闭面板前检查未保存
  useEffect(() => {
    if (!panelApi) return;
    const disposable = panelApi.onWillClose(async () => {
      if (hasUnsavedChanges) {
        const shouldClose = await confirm('文件有未保存的更改，确定要关闭吗？', {
          title: '未保存的更改',
          kind: 'warning',
        });
        if (!shouldClose) {
          // 阻止关闭（dockview 可能不支持直接阻止，需要检查 API）
        }
      }
    });
    return () => disposable?.dispose();
  }, [panelApi, hasUnsavedChanges]);

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        选择文件以预览
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-gray-500">加载中...</div>;
  }

  return (
    <Editor
      height="100%"
      language={language}
      value={content ?? ''}
      theme="vs-dark"
      options={{
        readOnly: isReadOnly,
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: 'on',
        wordWrap: 'on',
        scrollBeyondLastLine: false,
      }}
      onMount={handleEditorMount}
    />
  );
};

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    rs: 'rust', py: 'python', go: 'go',
    json: 'json', toml: 'toml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss',
    sql: 'sql', sh: 'shell', bash: 'shell',
    xml: 'xml', svg: 'xml',
  };
  return map[ext ?? ''] ?? 'plaintext';
}

export default PreviewPanel;
```

**Step 4: Commit**

```bash
git add frontend/src/components/panels/PreviewPanel.tsx frontend/src/hooks/useFileContent.ts frontend/package.json
git commit -m "feat: implement Monaco Editor preview panel with Ctrl+S save and language detection"
```

---

### Task 5.4: Monaco Diff Editor — Git Diff 预览

**Files:**
- Rewrite: `frontend/src/components/panels/DiffPanel.tsx`

**Step 1: 实现 Diff 面板（Monaco DiffEditor）**

```typescript
// frontend/src/components/panels/DiffPanel.tsx
import React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useQuery } from '@tanstack/react-query';
import { tauriInvoke } from '../../lib/tauri-api';
import type { PanelParams } from '../layout/panels/PanelRegistry';

const DiffPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  const { filePath } = params;

  // 获取原始内容（HEAD 版本）和当前内容
  const { data: diffData, isLoading } = useQuery({
    queryKey: ['file-diff', filePath],
    queryFn: async () => {
      const [original, modified] = await Promise.all([
        tauriInvoke<string>('get_file_at_head', { filePath: filePath! }),
        tauriInvoke<string>('read_file_content', { path: filePath! }),
      ]);
      return { original, modified };
    },
    enabled: !!filePath,
  });

  if (!filePath) {
    return <div className="flex items-center justify-center h-full text-gray-500">无文件可对比</div>;
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-gray-500">加载中...</div>;
  }

  const language = getLanguageFromPath(filePath);

  return (
    <DiffEditor
      height="100%"
      language={language}
      original={diffData?.original ?? ''}
      modified={diffData?.modified ?? ''}
      theme="vs-dark"
      options={{
        readOnly: true,           // Diff 预览只读
        renderSideBySide: true,   // 双栏对比
        minimap: { enabled: false },
        fontSize: 14,
      }}
    />
  );
};

// 复用语言检测函数
function getLanguageFromPath(filePath: string): string {
  // 同 PreviewPanel 中的实现
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    rs: 'rust', py: 'python', go: 'go',
    json: 'json', toml: 'toml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  };
  return map[ext ?? ''] ?? 'plaintext';
}

export default DiffPanel;
```

**Step 2: 在 Rust 端添加 get_file_at_head command**

```rust
// src-tauri/src/commands/file_tree.rs（追加）

/// 获取 HEAD 版本的文件内容（用于 Diff 对比）
#[tauri::command]
pub async fn get_file_at_head(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<String, AppError> {
    // 通过 git2 读取 HEAD commit 中的文件内容
    let path = PathBuf::from(&file_path);
    let repo_path = find_git_root(&path)
        .ok_or_else(|| AppError::NotFound("Not in a git repo".into()))?;

    let repo = git2::Repository::open(&repo_path)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let head = repo.head()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let tree = head.peel_to_tree()
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let relative = path.strip_prefix(&repo_path)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let relative_str = relative.to_string_lossy().replace('\\', "/");

    let entry = tree.get_path(std::path::Path::new(&relative_str))
        .map_err(|_| AppError::NotFound("File not found in HEAD".into()))?;
    let blob = repo.find_blob(entry.id())
        .map_err(|e| AppError::Internal(e.to_string()))?;

    String::from_utf8(blob.content().to_vec())
        .map_err(|_| AppError::Internal("File is not valid UTF-8".into()))
}

fn find_git_root(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_file() { path.parent()? } else { path };
    loop {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/panels/DiffPanel.tsx src-tauri/src/commands/file_tree.rs
git commit -m "feat: implement Monaco DiffEditor panel for Git diff preview"
```

---

### Task 5.5: 文件删除确认对话框

**Files:**
- Modify: `frontend/src/components/file-tree/FileTreeNode.tsx`（添加右键菜单）

**Step 1: 添加右键菜单支持文件删除**

```typescript
// 在 FileTreeNode 组件中添加右键菜单
const handleContextMenu = async (e: React.MouseEvent) => {
  e.preventDefault();
  // 使用 Tauri dialog 确认删除
  if (!entry.is_dir) {
    const shouldDelete = await confirm(
      `确定要删除文件 "${entry.name}" 吗？此操作不可撤销。`,
      { title: '删除文件', kind: 'warning' },
    );
    if (shouldDelete) {
      const fullPath = `${rootPath}/${entry.path}`;
      await tauriInvoke('delete_file', { path: fullPath });
      // 刷新文件树
      queryClient.invalidateQueries({ queryKey: ['file-tree'] });
    }
  }
};
```

**Step 2: Commit**

```bash
git add frontend/src/components/file-tree/FileTreeNode.tsx
git commit -m "feat: add file delete with confirmation dialog"
```

---

*Phase 5 完成标志：文件树带 Git 状态标记、支持 worktree 切换、Monaco Editor 代码编辑（Ctrl+S 保存）、Git Diff 只读查看。*

---

## Phase 6: 终端集成（PTY）（可与 Phase 5 并行）

> 目标：在 dockview 的终端面板中集成 xterm.js，通过 Tauri PTY commands 实现真正的终端交互。每个 worktree 有独立的终端集合。

---

### Task 6.1: 终端面板实现（xterm.js + Tauri PTY）

**Files:**
- Rewrite: `frontend/src/components/panels/TerminalPanel.tsx`
- Create: `frontend/src/hooks/useTauriTerminal.ts`
- Create: `frontend/src/stores/useTerminalStore.ts`

**Step 1: 终端状态 store**

```typescript
// frontend/src/stores/useTerminalStore.ts
import { create } from 'zustand';

interface TerminalSession {
  sessionId: string;
  workspaceId: string;
  title: string;
}

interface TerminalState {
  /** 按 worktree 分组的终端会话 */
  sessions: Record<string, TerminalSession[]>; // key = workspaceId
  addSession: (workspaceId: string, session: TerminalSession) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
  getSessions: (workspaceId: string) => TerminalSession[];
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},
  addSession: (workspaceId, session) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [workspaceId]: [...(state.sessions[workspaceId] ?? []), session],
      },
    })),
  removeSession: (workspaceId, sessionId) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [workspaceId]: (state.sessions[workspaceId] ?? []).filter(
          (s) => s.sessionId !== sessionId,
        ),
      },
    })),
  getSessions: (workspaceId) => get().sessions[workspaceId] ?? [],
}));
```

**Step 2: Tauri 终端 hook**

```typescript
// frontend/src/hooks/useTauriTerminal.ts
import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

interface UseTauriTerminalOptions {
  workspaceId: string;
  containerRef: React.RefObject<HTMLDivElement>;
}

interface UseTauriTerminalResult {
  sessionId: string | null;
  terminal: Terminal | null;
}

export function useTauriTerminal({ workspaceId, containerRef }: UseTauriTerminalOptions): UseTauriTerminalResult {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Cascadia Code', 'Fira Code', monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // 创建 PTY session
    const init = async () => {
      const { cols, rows } = terminal;

      const sessionId = await invoke<string>('create_terminal', {
        workspaceId,
        cols,
        rows,
      });
      sessionIdRef.current = sessionId;

      // 监听 PTY 输出
      const unlisten = await listen<string>(
        `terminal-output:${sessionId}`,
        (event) => {
          const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
          terminal.write(bytes);
        },
      );
      unlistenRef.current = unlisten;

      // 终端输入 → PTY
      terminal.onData((data) => {
        const encoded = btoa(data);
        invoke('write_terminal', { sessionId, data: encoded });
      });

      // 终端大小变化 → PTY resize
      terminal.onResize(({ cols, rows }) => {
        invoke('resize_terminal', { sessionId, cols, rows });
      });
    };

    init();

    // 窗口大小变化时重新 fit
    const resizeObserver = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      unlistenRef.current?.();
      if (sessionIdRef.current) {
        invoke('close_terminal', { sessionId: sessionIdRef.current });
      }
    };
  }, [workspaceId]);

  return {
    sessionId: sessionIdRef.current,
    terminal: terminalRef.current,
  };
}
```

**Step 3: 更新 TerminalPanel 组件**

```typescript
// frontend/src/components/panels/TerminalPanel.tsx
import React, { useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useTauriTerminal } from '../../hooks/useTauriTerminal';
import type { PanelParams } from '../layout/panels/PanelRegistry';
import '@xterm/xterm/css/xterm.css';

const TerminalPanel: React.FC<IDockviewPanelProps<PanelParams>> = ({ params }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useTauriTerminal({
    workspaceId: params.workspaceId ?? '',
    containerRef,
  });

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', backgroundColor: '#1e1e1e' }}
    />
  );
};

export default TerminalPanel;
```

**Step 4: Commit**

```bash
git add frontend/src/components/panels/TerminalPanel.tsx frontend/src/hooks/useTauriTerminal.ts frontend/src/stores/useTerminalStore.ts
git commit -m "feat: implement terminal panel with xterm.js and Tauri PTY integration"
```

---

*Phase 6 完成标志：终端面板可用，支持输入/输出/resize，每个 worktree 有独立的终端集合。*

---

## Phase 7: Worktree 一主多分协同（可与 Phase 5/6 并行）

> 目标：实现一主多分的 Worktree 协同开发流程。包括：项目级默认主分支设置、每个 worktree 独立目标分支选择、rebase back 操作、rebase 目标分支操作、与目标分支的领先/落后状态实时显示（5s 刷新）、冲突消息发送到 AI 对话框。

---

### Task 7.1: 数据库层 — 新增主分支配置和 worktree 目标分支字段

**Files:**
- Create: `crates/db/migrations/YYYYMMDD_add_target_branch_fields.sql`
- Modify: `crates/db/src/models/project.rs`
- Modify: `crates/db/src/models/workspace.rs` （确认 target_branch 字段）

**Step 1: 创建数据库迁移**

```sql
-- crates/db/migrations/YYYYMMDD_add_target_branch_fields.sql

-- 项目级默认主分支
ALTER TABLE projects ADD COLUMN default_main_branch TEXT NOT NULL DEFAULT 'main';

-- workspace 级别的目标分支（已有 target_branch 通过 workspace_repos 表）
-- 确认 workspace_repos 表有 target_branch 字段
-- 如果没有：
-- ALTER TABLE workspace_repos ADD COLUMN target_branch TEXT NOT NULL DEFAULT 'main';
```

**Step 2: 更新 Project 模型**

```rust
// crates/db/src/models/project.rs
pub struct Project {
    // ... 现有字段 ...
    pub default_main_branch: String, // 新增
}

pub struct UpdateProject {
    pub name: Option<String>,
    pub default_main_branch: Option<String>, // 新增
}
```

**Step 3: 运行迁移验证**

```bash
cargo build
```

**Step 4: Commit**

```bash
git add crates/db/
git commit -m "feat: add default_main_branch to projects and ensure target_branch on workspace_repos"
```

---

### Task 7.2: Rust 端 — Rebase 操作 Commands

**Files:**
- Create: `src-tauri/src/commands/rebase.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: 实现 rebase 相关 commands**

```rust
// src-tauri/src/commands/rebase.rs
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use std::path::PathBuf;
use crate::state::AppState;
use crate::error::AppError;

/// 与目标分支的领先/落后状态
#[derive(Debug, Serialize, Clone)]
pub struct AheadBehindStatus {
    pub ahead: u32,    // worktree 比 target 多多少 commits
    pub behind: u32,   // worktree 比 target 落后多少 commits
    pub target_branch: String,
    pub current_branch: String,
}

/// Rebase 操作结果
#[derive(Debug, Serialize, Clone)]
pub enum RebaseResult {
    /// Rebase 成功
    Success,
    /// Rebase 产生冲突
    Conflict {
        conflicted_files: Vec<ConflictedFile>,
    },
    /// Rebase 失败（其他错误）
    Error { message: String },
}

#[derive(Debug, Serialize, Clone)]
pub struct ConflictedFile {
    pub path: String,
    pub content: String,  // 包含冲突标记的完整文件内容
}

/// 获取 worktree 与目标分支的领先/落后状态
#[tauri::command]
pub async fn get_ahead_behind_status(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<AheadBehindStatus, AppError> {
    let db = state.deployment.db();
    let workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;

    let repos = vk_db::models::workspace_repo::WorkspaceRepo::find_by_workspace_id(
        db.pool(), workspace_id,
    ).await?;

    // 取第一个 repo（假设单 repo 场景为主）
    let repo = repos.first()
        .ok_or_else(|| AppError::NotFound("No repos for workspace".into()))?;

    let repo_info = vk_db::models::repo::Repo::find_by_id(db.pool(), repo.repo_id).await?
        .ok_or_else(|| AppError::NotFound("Repo not found".into()))?;

    let repo_path = PathBuf::from(&repo_info.path);
    let git = state.deployment.git();

    // 获取领先/落后数
    let (ahead, behind) = git.get_ahead_behind(
        &repo_path,
        &workspace.branch,
        &repo.target_branch,
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(AheadBehindStatus {
        ahead: ahead as u32,
        behind: behind as u32,
        target_branch: repo.target_branch.clone(),
        current_branch: workspace.branch.clone(),
    })
}

/// Rebase 目标分支（将目标分支的最新改动同步到当前 worktree）
/// 即：在当前 worktree 分支上执行 git rebase <target_branch>
#[tauri::command]
pub async fn rebase_onto_target(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RebaseResult, AppError> {
    let db = state.deployment.db();
    let workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;

    let repos = vk_db::models::workspace_repo::WorkspaceRepo::find_by_workspace_id(
        db.pool(), workspace_id,
    ).await?;
    let repo = repos.first()
        .ok_or_else(|| AppError::NotFound("No repos".into()))?;
    let repo_info = vk_db::models::repo::Repo::find_by_id(db.pool(), repo.repo_id).await?
        .ok_or_else(|| AppError::NotFound("Repo not found".into()))?;

    let worktree_path = PathBuf::from(
        workspace.container_ref.as_ref()
            .ok_or_else(|| AppError::Internal("No container ref".into()))?
    );
    let git = state.deployment.git();

    // 执行 rebase
    match git.rebase_branch(&worktree_path, &repo.target_branch).await {
        Ok(_) => Ok(RebaseResult::Success),
        Err(e) => {
            // 检查是否为冲突
            if git.is_rebase_in_progress(&worktree_path).await.unwrap_or(false) {
                let files = git.get_conflicted_files(&worktree_path).await
                    .unwrap_or_default();

                let conflicted_files = collect_conflicted_files(&worktree_path, &files).await;
                Ok(RebaseResult::Conflict { conflicted_files })
            } else {
                Ok(RebaseResult::Error { message: e.to_string() })
            }
        }
    }
}

/// Rebase Back — 将当前 worktree 的改动合并到目标分支
/// 流程：
/// 1. 在 worktree 上执行 git rebase <target_branch>（同步最新改动）
/// 2. 如果成功，在目标分支的 worktree 上执行 git rebase <worktree_branch>（fast-forward）
#[tauri::command]
pub async fn rebase_back(
    state: State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RebaseResult, AppError> {
    let db = state.deployment.db();
    let workspace = vk_db::models::workspace::Workspace::find_by_id(db.pool(), workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id}")))?;

    let repos = vk_db::models::workspace_repo::WorkspaceRepo::find_by_workspace_id(
        db.pool(), workspace_id,
    ).await?;
    let repo = repos.first()
        .ok_or_else(|| AppError::NotFound("No repos".into()))?;
    let repo_info = vk_db::models::repo::Repo::find_by_id(db.pool(), repo.repo_id).await?
        .ok_or_else(|| AppError::NotFound("Repo not found".into()))?;

    let repo_path = PathBuf::from(&repo_info.path);
    let worktree_path = PathBuf::from(
        workspace.container_ref.as_ref()
            .ok_or_else(|| AppError::Internal("No container ref".into()))?
    );
    let git = state.deployment.git();

    // Step 1: worktree 分支 rebase 目标分支
    match git.rebase_branch(&worktree_path, &repo.target_branch).await {
        Ok(_) => {
            // Step 2: 在主仓库中，将目标分支 rebase worktree 分支（fast-forward）
            match git.rebase_branch_in_repo(
                &repo_path,
                &repo.target_branch,
                &workspace.branch,
            ).await {
                Ok(_) => Ok(RebaseResult::Success),
                Err(e) => Ok(RebaseResult::Error {
                    message: format!("目标分支 rebase 失败: {e}"),
                }),
            }
        }
        Err(_) => {
            // 检查是否冲突
            if git.is_rebase_in_progress(&worktree_path).await.unwrap_or(false) {
                let files = git.get_conflicted_files(&worktree_path).await
                    .unwrap_or_default();
                let conflicted_files = collect_conflicted_files(&worktree_path, &files).await;
                Ok(RebaseResult::Conflict { conflicted_files })
            } else {
                Ok(RebaseResult::Error {
                    message: "Rebase 失败".into(),
                })
            }
        }
    }
}

/// 更改 workspace 的目标分支
#[tauri::command]
pub async fn change_workspace_target(
    state: State<'_, AppState>,
    workspace_id: Uuid,
    repo_id: Uuid,
    new_target_branch: String,
) -> Result<(), AppError> {
    let db = state.deployment.db();
    vk_db::models::workspace_repo::WorkspaceRepo::update_target_branch(
        db.pool(),
        workspace_id,
        repo_id,
        &new_target_branch,
    ).await.map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// 获取仓库的所有本地分支（用于目标分支选择下拉菜单）
#[tauri::command]
pub async fn get_repo_branches(
    state: State<'_, AppState>,
    repo_id: Uuid,
) -> Result<Vec<String>, AppError> {
    let db = state.deployment.db();
    let repo = vk_db::models::repo::Repo::find_by_id(db.pool(), repo_id).await?
        .ok_or_else(|| AppError::NotFound("Repo not found".into()))?;

    let repo_path = PathBuf::from(&repo.path);
    let branches = state.deployment.git()
        .get_local_branches(&repo_path).await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(branches.into_iter().map(|b| b.name).collect())
}

/// 收集冲突文件的内容（包含冲突标记）
async fn collect_conflicted_files(
    worktree_path: &PathBuf,
    file_paths: &[String],
) -> Vec<ConflictedFile> {
    let mut result = Vec::new();
    for path in file_paths {
        let full_path = worktree_path.join(path);
        let content = tokio::fs::read_to_string(&full_path).await.unwrap_or_default();
        result.push(ConflictedFile {
            path: path.clone(),
            content,
        });
    }
    result
}
```

**Step 2: 在 GitService 中补充缺少的方法**

如果 `crates/git/src/` 中缺少以下方法，需要添加：

```rust
impl GitService {
    /// 获取两个分支之间的领先/落后 commit 数
    pub async fn get_ahead_behind(
        &self,
        repo_path: &Path,
        branch: &str,
        target: &str,
    ) -> Result<(usize, usize), GitError> {
        let repo = git2::Repository::open(repo_path)?;
        let branch_oid = repo.revparse_single(&format!("refs/heads/{branch}"))?.id();
        let target_oid = repo.revparse_single(&format!("refs/heads/{target}"))?.id();
        let (ahead, behind) = repo.graph_ahead_behind(branch_oid, target_oid)?;
        Ok((ahead, behind))
    }

    /// 在指定仓库中（非 worktree），将 branch_to_rebase 变基到 onto_branch
    pub async fn rebase_branch_in_repo(
        &self,
        repo_path: &Path,
        branch_to_rebase: &str,
        onto_branch: &str,
    ) -> Result<(), GitError> {
        // 使用 git CLI 执行（因为 libgit2 的 rebase API 较复杂）
        let output = tokio::process::Command::new("git")
            .args(["rebase", onto_branch, branch_to_rebase])
            .current_dir(repo_path)
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(GitError::RebaseFailed(stderr.to_string()));
        }
        Ok(())
    }
}
```

**Step 3: 注册 commands，验证编译**

**Step 4: Commit**

```bash
git add src-tauri/src/commands/rebase.rs crates/git/src/ crates/db/
git commit -m "feat: implement rebase-back and rebase-target Tauri commands with conflict detection"
```

---

### Task 7.3: 前端 — Rebase 状态显示和操作 UI

**Files:**
- Create: `frontend/src/hooks/useAheadBehind.ts`
- Create: `frontend/src/hooks/useRebaseActions.ts`
- Create: `frontend/src/components/rebase/RebaseConflictDialog.tsx`
- Modify: `frontend/src/components/layout/Toolbar.tsx`

**Step 1: 领先/落后状态 hook（5s 轮询）**

```typescript
// frontend/src/hooks/useAheadBehind.ts
import { useQuery } from '@tanstack/react-query';
import { tauriInvoke } from '../lib/tauri-api';

interface AheadBehindStatus {
  ahead: number;
  behind: number;
  target_branch: string;
  current_branch: string;
}

export function useAheadBehind(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['ahead-behind', workspaceId],
    queryFn: () => tauriInvoke<AheadBehindStatus>('get_ahead_behind_status', {
      workspaceId: workspaceId!,
    }),
    enabled: !!workspaceId,
    refetchInterval: 5_000, // 5 秒刷新
  });
}
```

**Step 2: Rebase 操作 hook**

```typescript
// frontend/src/hooks/useRebaseActions.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { tauriInvoke } from '../lib/tauri-api';

interface ConflictedFile {
  path: string;
  content: string;
}

type RebaseResult =
  | 'Success'
  | { Conflict: { conflicted_files: ConflictedFile[] } }
  | { Error: { message: string } };

export function useRebaseActions(workspaceId: string) {
  const queryClient = useQueryClient();

  const rebaseOntoTarget = useMutation({
    mutationFn: () => tauriInvoke<RebaseResult>('rebase_onto_target', { workspaceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ahead-behind', workspaceId] });
    },
  });

  const rebaseBack = useMutation({
    mutationFn: () => tauriInvoke<RebaseResult>('rebase_back', { workspaceId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ahead-behind', workspaceId] });
    },
  });

  const changeTarget = useMutation({
    mutationFn: ({ repoId, newBranch }: { repoId: string; newBranch: string }) =>
      tauriInvoke<void>('change_workspace_target', {
        workspaceId,
        repoId,
        newTargetBranch: newBranch,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ahead-behind', workspaceId] });
    },
  });

  return { rebaseOntoTarget, rebaseBack, changeTarget };
}
```

**Step 3: 冲突消息对话框**

```typescript
// frontend/src/components/rebase/RebaseConflictDialog.tsx
import React, { useState } from 'react';

interface ConflictedFile {
  path: string;
  content: string;
}

interface RebaseConflictDialogProps {
  isOpen: boolean;
  conflictedFiles: ConflictedFile[];
  operationType: 'rebase' | 'rebase-back';
  onSendToAI: (message: string) => void;
  onClose: () => void;
}

export const RebaseConflictDialog: React.FC<RebaseConflictDialogProps> = ({
  isOpen,
  conflictedFiles,
  operationType,
  onSendToAI,
  onClose,
}) => {
  if (!isOpen) return null;

  const buildConflictMessage = () => {
    let message = `Rebase 过程中出现冲突，请帮我解决以下文件的冲突并完成 rebase：\n\n`;
    for (const file of conflictedFiles) {
      message += `--- 文件: ${file.path} ---\n`;
      message += `${file.content}\n\n`;
    }
    message += `请解决所有冲突标记（<<<<<<<、=======、>>>>>>>），保留正确的代码，然后执行 git add 和 git rebase --continue 完成 rebase。`;
    return message;
  };

  const handleSend = () => {
    const message = buildConflictMessage();
    onSendToAI(message);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-auto">
        <h3 className="text-lg font-semibold text-white mb-4">
          Rebase 冲突
        </h3>
        <p className="text-gray-300 mb-4">
          {operationType === 'rebase-back' ? 'Rebase Back' : 'Rebase'} 过程中发现 {conflictedFiles.length} 个文件冲突：
        </p>
        <ul className="list-disc list-inside mb-4 text-gray-400">
          {conflictedFiles.map((f) => (
            <li key={f.path} className="text-sm">{f.path}</li>
          ))}
        </ul>
        <p className="text-gray-400 text-sm mb-4">
          点击"发送给 AI"将冲突内容发送到对话框，AI 将自动解决冲突。
          {operationType === 'rebase-back' && (
            <span className="text-yellow-400"> 冲突解决后请重新点击 Rebase Back 按钮。</span>
          )}
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm"
          >
            取消
          </button>
          <button
            onClick={handleSend}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm"
          >
            发送给 AI
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Step 4: 更新 Toolbar 集成 rebase 功能**

更新 `frontend/src/components/layout/Toolbar.tsx`，接入 `useAheadBehind`、`useRebaseActions` 和 `RebaseConflictDialog`：

```typescript
// 在 Toolbar 组件中：
const { data: status } = useAheadBehind(workspaceId);
const { rebaseBack, rebaseOntoTarget } = useRebaseActions(workspaceId);
const [conflictDialog, setConflictDialog] = useState<{
  isOpen: boolean;
  files: ConflictedFile[];
  type: 'rebase' | 'rebase-back';
}>({ isOpen: false, files: [], type: 'rebase' });

const handleRebaseBack = async () => {
  const result = await rebaseBack.mutateAsync();
  if (typeof result === 'object' && 'Conflict' in result) {
    setConflictDialog({
      isOpen: true,
      files: result.Conflict.conflicted_files,
      type: 'rebase-back',
    });
  }
};

const handleRebaseTarget = async () => {
  const result = await rebaseOntoTarget.mutateAsync();
  if (typeof result === 'object' && 'Conflict' in result) {
    setConflictDialog({
      isOpen: true,
      files: result.Conflict.conflicted_files,
      type: 'rebase',
    });
  }
};

// onSendToAI: 通过 sessionsApi.followUp 发送冲突消息
const handleSendConflictToAI = (message: string) => {
  // 使用现有的 follow-up 机制发送消息到 AI 对话框
  // 需要获取当前 workspace 的 active session
};
```

**Step 5: Commit**

```bash
git add frontend/src/hooks/useAheadBehind.ts frontend/src/hooks/useRebaseActions.ts frontend/src/components/rebase/ frontend/src/components/layout/Toolbar.tsx
git commit -m "feat: implement rebase UI with ahead/behind status, conflict dialog, and AI conflict resolution"
```

---

### Task 7.4: 目标分支选择 UI

**Files:**
- Create: `frontend/src/components/rebase/BranchSelector.tsx`
- Modify: `frontend/src/components/layout/Toolbar.tsx`

**Step 1: 分支选择下拉组件**

```typescript
// frontend/src/components/rebase/BranchSelector.tsx
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tauriInvoke } from '../../lib/tauri-api';

interface BranchSelectorProps {
  repoId: string;
  currentTarget: string;
  onSelect: (branch: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  repoId,
  currentTarget,
  onSelect,
  isOpen,
  onClose,
}) => {
  const [filter, setFilter] = useState('');
  const { data: branches } = useQuery({
    queryKey: ['repo-branches', repoId],
    queryFn: () => tauriInvoke<string[]>('get_repo_branches', { repoId }),
    enabled: isOpen,
  });

  if (!isOpen) return null;

  const filtered = branches?.filter((b) =>
    b.toLowerCase().includes(filter.toLowerCase()),
  ) ?? [];

  return (
    <div className="absolute top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 w-64">
      <input
        autoFocus
        className="w-full px-3 py-2 bg-gray-700 border-b border-gray-600 text-sm"
        placeholder="搜索分支..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="max-h-48 overflow-auto">
        {filtered.map((branch) => (
          <button
            key={branch}
            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-700 ${
              branch === currentTarget ? 'text-blue-400' : 'text-gray-300'
            }`}
            onClick={() => { onSelect(branch); onClose(); }}
          >
            {branch}
            {branch === currentTarget && ' ✓'}
          </button>
        ))}
      </div>
    </div>
  );
};
```

**Step 2: 集成到 Toolbar**

在 Toolbar 的目标分支显示旁添加点击事件，打开 BranchSelector。

**Step 3: Commit**

```bash
git add frontend/src/components/rebase/BranchSelector.tsx frontend/src/components/layout/Toolbar.tsx
git commit -m "feat: implement branch selector for worktree target branch switching"
```

---

### Task 7.5: 项目级默认主分支设置

**Files:**
- Modify: `frontend/src/pages/ProjectSettings.tsx`（或在项目管理页面中添加）
- Modify: `src-tauri/src/commands/projects.rs`

**Step 1: 在项目设置中添加主分支选择**

在 `update_project` command 中已支持 `default_main_branch` 更新。在前端项目设置页面中添加分支选择下拉菜单。

**Step 2: 创建新 workspace 时使用项目默认主分支**

修改 `create_workspace` command，当未指定 target_branch 时使用 `project.default_main_branch`。

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: implement project-level default main branch setting"
```

---

*Phase 7 完成标志：工具栏显示领先/落后状态（5s 刷新），rebase back 和 rebase 目标分支操作可用，冲突时弹出对话框可发送给 AI，目标分支可切换。*

---

## Phase 8: 清理、裁剪与集成验证

> 目标：清理所有遗留代码、移除不再需要的依赖、验证完整功能链。

---

### Task 8.1: 清理 Rust 端遗留代码

**Files:**
- Delete: `crates/server/` (如果 Phase 2 未删除)
- Modify: `Cargo.toml` (清理 workspace 依赖)
- Modify: 各 crate 的 Cargo.toml (移除 axum、tower-http 等依赖)

**Step 1: 从 workspace 依赖中移除不再需要的包**

```toml
# 移除：
# axum, tower-http, hyper (HTTP 服务器相关)
# tokio-tungstenite (WebSocket)
```

**Step 2: 清理 crates/executors 中已删除执行器的残留引用**

**Step 3: 验证编译**

```bash
cargo build --release
```

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: clean up Axum/WebSocket dependencies and dead code"
```

---

### Task 8.2: 清理前端遗留代码

**Files:**
- Delete: 所有不再使用的旧组件
- Modify: `frontend/package.json`
- Delete: `frontend/src/hooks/useJsonPatchWsStream.ts` (如果 Phase 3 未删除)

**Step 1: 查找并移除不再引用的旧组件**

```bash
# 查找未使用的导出
cd frontend && npx ts-prune | grep -v "used in module"
```

候选删除：
- `TasksLayout.tsx`（旧三区域布局）
- `RightWorkArea.tsx`（旧右侧面板）
- `PreviewPanel.tsx`（旧预览面板，如果有同名旧文件）
- `DiffsPanel.tsx`（旧 Diff 面板）
- 所有 i18n 相关文件

**Step 2: 移除不再需要的 npm 依赖**

```bash
cd frontend
pnpm remove react-resizable-panels  # 旧布局
pnpm remove i18next react-i18next   # 国际化
pnpm remove wa-sqlite               # 浏览器端 SQLite
pnpm remove eventsource             # SSE 客户端（如有）
```

**Step 3: 验证前端编译**

```bash
cd frontend && pnpm tsc --noEmit && pnpm build
```

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove unused frontend components and dependencies"
```

---

### Task 8.3: 集成验证清单

**手动验证以下功能链：**

1. **启动验证**
   - [ ] `pnpm tauri:dev` 正常启动
   - [ ] 应用窗口显示 IDE 布局
   - [ ] 无控制台错误

2. **项目管理**
   - [ ] 创建新项目
   - [ ] 添加仓库
   - [ ] 删除项目

3. **任务管理**
   - [ ] 创建任务
   - [ ] Kanban 拖拽改变状态
   - [ ] 删除任务

4. **AI 对话**
   - [ ] 创建 workspace
   - [ ] 发送 follow-up 消息
   - [ ] AI 代理（ClaudeCode/Codex/OpenCode）执行
   - [ ] 对话历史实时流

5. **IDE 布局**
   - [ ] 面板拖拽到其他区域
   - [ ] 标签页切换
   - [ ] 关闭/重新打开面板
   - [ ] 布局持久化（重启后恢复）
   - [ ] AI 对话区固定在右侧
   - [ ] AI 对话区宽度可调

6. **文件树**
   - [ ] 显示目录结构
   - [ ] Git 状态标记
   - [ ] 点击文件打开预览
   - [ ] 切换到其他 worktree 浏览
   - [ ] 还原按钮

7. **Monaco Editor**
   - [ ] 语法高亮
   - [ ] Ctrl+S 保存
   - [ ] 未保存关闭确认
   - [ ] Git Diff 只读查看
   - [ ] 非当前 worktree 文件只读

8. **终端**
   - [ ] 打开终端
   - [ ] 输入/输出正常
   - [ ] 多终端标签
   - [ ] 切换 worktree 终端跟随

9. **Worktree 协同**
   - [ ] 领先/落后状态显示（5s 刷新）
   - [ ] Rebase 目标分支操作
   - [ ] Rebase Back 操作
   - [ ] 冲突对话框弹出
   - [ ] 冲突消息发送到 AI 对话
   - [ ] 目标分支切换
   - [ ] 项目默认主分支设置

10. **构建验证**
    - [ ] `cargo build --release` 通过
    - [ ] `pnpm tauri:build` 生成安装包

**Step 1: 依次验证上述所有项**

**Step 2: 修复发现的问题**

**Step 3: 最终 Commit**

```bash
git add -A
git commit -m "chore: integration verification complete"
```

---

*Phase 8 完成标志：所有功能链验证通过，无遗留代码，`pnpm tauri:build` 成功生成安装包。*

---

## 附录 A: 文件变更总览

### 新增文件
```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── capabilities/default.json
├── build.rs
├── icons/
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── state.rs
│   ├── error.rs
│   ├── events.rs
│   └── commands/
│       ├── mod.rs
│       ├── projects.rs
│       ├── tasks.rs
│       ├── workspaces.rs
│       ├── sessions.rs
│       ├── terminal.rs
│       ├── events.rs
│       ├── filesystem.rs
│       ├── config.rs
│       ├── repos.rs
│       ├── tags.rs
│       ├── approvals.rs
│       ├── execution_processes.rs
│       ├── file_tree.rs
│       └── rebase.rs

frontend/src/
├── lib/tauri-api.ts
├── hooks/
│   ├── useTauriPatchStream.ts
│   ├── useTauriTerminal.ts
│   ├── useFileTree.ts
│   ├── useFileContent.ts
│   ├── useAheadBehind.ts
│   └── useRebaseActions.ts
├── stores/
│   ├── useLayoutStore.ts
│   ├── useFileTreeStore.ts
│   └── useTerminalStore.ts
├── components/
│   ├── layout/
│   │   ├── IDELayout.tsx
│   │   ├── Toolbar.tsx
│   │   └── panels/PanelRegistry.tsx
│   ├── panels/
│   │   ├── KanbanPanel.tsx
│   │   ├── PreviewPanel.tsx (Monaco Editor)
│   │   ├── DiffPanel.tsx (Monaco DiffEditor)
│   │   ├── FileTreePanel.tsx
│   │   ├── TerminalPanel.tsx
│   │   └── AIChatPanel.tsx
│   ├── file-tree/
│   │   └── FileTreeNode.tsx
│   └── rebase/
│       ├── RebaseConflictDialog.tsx
│       └── BranchSelector.tsx
└── contexts/
    └── PanelActionsContext.tsx
```

### 删除文件
```
crates/server/                 (整个目录 — Axum HTTP 服务器)
crates/executors/src/executors/amp.rs
crates/executors/src/executors/gemini.rs
crates/executors/src/executors/cursor.rs
crates/executors/src/executors/qwen.rs
crates/executors/src/executors/copilot.rs
crates/executors/src/executors/droid.rs
crates/executors/src/executors/auggie.rs
frontend/src/i18n/             (整个目录)
frontend/src/hooks/useJsonPatchWsStream.ts
frontend/src/components/TasksLayout.tsx
npx-cli/                       (整个目录)
```

### 主要修改文件
```
Cargo.toml                     (workspace members + dependencies)
package.json                   (scripts + dependencies)
frontend/package.json          (dependencies)
frontend/src/lib/api.ts        (HTTP → Tauri invoke)
frontend/src/App.tsx            (路由 → IDE 布局)
frontend/src/contexts/TerminalContext.tsx  (WS → Tauri PTY)
frontend/src/hooks/useConversationHistory/ (WS → Tauri Events)
frontend/src/hooks/useProjectTasks.ts      (WS → Tauri Events)
frontend/src/hooks/useProjects.ts          (WS → Tauri Events)
crates/executors/src/executors/mod.rs      (裁剪执行器枚举)
crates/db/src/models/project.rs            (添加 default_main_branch)
crates/git/src/lib.rs                      (添加 get_status_map, get_ahead_behind 等)
```

---

## 附录 B: 估算 Task 数量

| 阶段 | Task 数 | 关键复杂度 |
|------|---------|-----------|
| Phase 1 | 3 | 低（脚手架搭建） |
| Phase 2 | 10 | **高**（60+ 路由迁移，follow-up 逻辑复杂） |
| Phase 3 | 6 | **高**（60+ API 函数替换，核心 hook 重写） |
| Phase 4 | 5 | 中（dockview 集成，新概念多） |
| Phase 5 | 5 | 中（Monaco Editor 集成，文件树交互） |
| Phase 6 | 1 | 低（已有 PTY 基础设施） |
| Phase 7 | 5 | 中（Git rebase 逻辑，冲突处理） |
| Phase 8 | 3 | 低（清理 + 验证） |
| **合计** | **38 Tasks** | |
