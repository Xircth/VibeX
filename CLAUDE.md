AGENTS.md

# VibeUltra — Claude 项目规则文档

> 本文档为 AI 编程助手提供完整的项目上下文，包含架构说明、编码规范、术语映射和用户自定义规则。

---

## 一、项目简介

**VibeUltra** 是基于 [vibe-kanban](https://github.com/BloopAI/vibe-kanban) fork、针对桌面端体验深度优化的 AI 编程 Agent 任务管理工具，使用 **Tauri v2** 构建。

核心目标：让 Claude Code、Gemini CLI、Codex、Amp 等 AI 编程 Agent 的生产力提升 10 倍，支持多 Agent 并行调度、看板式任务管理、内置终端、代码预览与 Diff 审查。

**与上游的主要差异：**
- 去除云同步、OAuth 等第三方依赖
- 专注桌面端原生体验（Tauri v2）
- 集成更多 IDE 布局功能（dockview 多面板）

---

## 二、技术栈

### 2.1 前端

| 技术 | 版本/说明 |
|---|---|
| React | 18，函数式组件 + Hooks |
| TypeScript | 严格模式 |
| Vite | 构建工具 |
| dockview-react | v5.1.0，IDE 多面板布局管理 |
| xterm.js | 终端模拟（PTY 通过 Tauri 后端实现） |
| Monaco Editor | 代码编辑/Diff 预览 |
| TanStack Query | 服务端状态管理 |
| Zustand | 客户端状态管理（含 persist 中间件） |
| react-router-dom | v6，路由管理 |
| Tailwind CSS | 样式 |

### 2.2 后端（Rust）

| 技术 | 说明 |
|---|---|
| Tauri v2 | 桌面应用容器，Commands & Events |
| Tokio | 异步运行时 |
| Axum 0.8 | HTTP 服务（MCP、API） |
| SQLite (sqlx) | 本地数据持久化 |
| git2 | Git 操作（diff、branch、worktree、rebase） |
| ts-rs | Rust 结构体 → TypeScript 类型自动生成 |
| serde / serde_json | 序列化 |
| tracing | 日志 |

### 2.3 构建工具

- **pnpm workspace** + `pnpm-workspace.yaml`（前端包管理）
- **Cargo workspace**（所有 Rust crate 统一管理）
- `shared/types.ts`：由 `cargo run --bin generate-types` 自动生成，**禁止手动修改**

---

## 三、项目架构

### 3.1 目录结构

```
VibeUltra/
├── frontend/                  前端（React + Vite）
│   └── src/
│       ├── App.tsx            路由根
│       ├── components/        UI 组件
│       │   ├── layout/        布局组件（IDELayout、Toolbar 等）
│       │   ├── panels/        dockview 面板组件
│       │   └── tasks/         任务相关组件
│       ├── contexts/          React Context 提供者
│       ├── stores/            Zustand 状态 Store
│       ├── hooks/             自定义 Hooks
│       ├── lib/               工具库（api.ts 等）
│       └── pages/             路由页面
├── src-tauri/                 Tauri 入口（Rust）
│   └── src/commands/          Tauri Command 实现
├── crates/
│   ├── api-types/             共享 API 类型（→ shared/types.ts）
│   ├── db/                    数据库层：SQLite schema、migrations、CRUD
│   ├── services/              业务逻辑层：任务、会话、diff 流、queue
│   ├── git/                   Git 操作封装
│   ├── executors/             AI 执行器（Claude Code 等 agent 抽象）
│   ├── deployment/            部署管理：AppState 初始化、事件转发
│   ├── local-deployment/      本地部署实现
│   └── utils/                 通用工具函数
├── shared/
│   └── types.ts               自动生成的 TS 类型（勿手动修改）
├── code-referance/            竞品/参考项目目录（见用户规则）
├── docs/                      文档
└── vendor/                    Patched 第三方库（codex-windows-sandbox 等）
```

### 3.2 数据流

```
用户操作（前端）
    │
    ▼
tauriInvoke('command_name', args)     ← 前端 lib/api.ts 封装的 IPC 调用
    │
    ▼
src-tauri/src/commands/*.rs           ← Tauri Command 处理层
    │
    ▼
crates/services/                      ← 业务逻辑
    ├── crates/db/                    ← 数据持久化（SQLite）
    └── crates/git/                   ← Git 操作
    │
    ▼
Tauri Events（SSE-like 流式）          ← 实时推送（diff stream、conversation stream）
    │
    ▼
前端 useQuery / EventSource 订阅
```

### 3.3 前端布局层次

```
App.tsx（路由根）
└── IDEWorkspaceRoute         /local-projects/:projectId/tasks/*
      └── WorkspaceLayout     Context 注入层
            │  providers: WorktreeProvider → ReviewProvider
            │             → TerminalProvider → PanelActionsProvider
            └── IDELayout     dockview 布局容器
                  ├── Toolbar（顶部工具栏）
                  ├── ActivityBar（左侧图标栏，宽 40px）
                  ├── DockviewReact（多面板管理）
                  │     ├── group-left     → FileTree / Git
                  │     ├── group-center-1 → Kanban / Diffs / Preview / Logs / Notes / Welcome
                  │     ├── group-center-2 → （与 center-1 并排）
                  │     └── group-bottom   → Terminal
                  ├── KanbanBoard（Kanban Tab 激活时全屏覆盖层）
                  ├── RightPanelContent（右侧固定面板，不受 dockview 管理）
                  │     ├── BranchInfoHeader
                  │     ├── Outlet（TaskPanel / TaskAttemptPanel）
                  │     └── RightPanelSidebar
                  └── StatusBar（底部状态栏）
```

---

## 四、术语说明

### 4.1 布局区域术语

| 用户术语 | 技术术语 | Group ID 常量 | 说明 |
|---|---|---|---|
| **左栏** | Left Sidebar | `GROUP_IDS.LEFT = 'group-left'` | 文件树/Git 面板，无标签头（`dv-header-hidden`） |
| **中1栏** | Center-1 | `GROUP_IDS.CENTER_1 = 'group-center-1'` | 主编辑区左半部分 |
| **中2栏** | Center-2 | `GROUP_IDS.CENTER_2 = 'group-center-2'` | 主编辑区右半部分，与 Center-1 并排 |
| **终端栏** | Bottom Terminal | `GROUP_IDS.BOTTOM = 'group-bottom'` | 底部终端/日志面板 |
| **右栏** | Right Fixed Panel | — | AI 对话区，固定宽度（默认 500px），**不受 dockview 管理** |
| **活动栏** | Activity Bar | — | 最左侧图标栏（宽 40px） |
| **工具栏** | Toolbar | — | 顶部工具栏 |
| **状态栏** | StatusBar | — | 底部状态栏 |

### 4.2 面板 ID → 组件映射

| Panel ID | 常量 | 组件文件 | 说明 |
|---|---|---|---|
| `kanban` | `PANEL_IDS.KANBAN` | `DockviewKanbanPanel` | 看板（全屏覆盖层渲染，dockview 仅占位） |
| `file-tree` | `PANEL_IDS.FILE_TREE` | `DockviewFileTreePanel` | 文件树浏览器 |
| `git` | `PANEL_IDS.GIT` | `DockviewGitPanel` | Git 状态/操作管理器 |
| `terminal` | `PANEL_IDS.TERMINAL` | `DockviewTerminalPanel` | xterm.js + Tauri PTY，支持多 tab |
| `diffs` | `PANEL_IDS.DIFFS` | `DockviewDiffsReviewPanel` | Diff 审查，支持代码注释 |
| `preview` | `PANEL_IDS.PREVIEW` | `DockviewPreviewPanel` | 内嵌 webview 预览 |
| `welcome` | `PANEL_IDS.WELCOME` | `DockviewWelcomePanel` | 空白占位欢迎页 |
| `logs` | `PANEL_IDS.LOGS` | `DockviewLogsPanel` | 执行日志查看器 |
| `notes` | `PANEL_IDS.NOTES` | `DockviewNotesPanel` | 工作区笔记 |
| `ai-chat` | `PANEL_IDS.AI_CHAT` | — | 仅注册占位，实际 AI Chat 在右侧固定面板 |

### 4.3 业务术语

| 术语 | 说明 |
|---|---|
| **Task（任务）** | 看板中的一张卡片，代表一个要完成的功能/需求 |
| **Attempt（尝试）** | 对某个 Task 的一次 AI 执行尝试，包含完整的对话历史 |
| **Session（会话）** | 一次 AI Agent 运行实例，对应一个 Attempt |
| **Worktree（工作树）** | Git Worktree，每个 Task 对应一个独立的 git worktree，隔离代码变更 |
| **Executor（执行器）** | AI 编程 Agent 的抽象，当前支持 Claude Code、Codex、ACP、OpenCode 等 |
| **Profile（配置方案）** | AI 执行器的一组配置（模型、权限、环境变量等） |
| **Permission Mode（权限模式）** | `auto`（自动）/ `ask`（询问）/ `plan`（计划）三种 AI 执行权限 |
| **MCP** | Model Context Protocol，AI Agent 上下文协议 |
| **Follow-up（追问）** | 在已有 Attempt 基础上发送新消息继续对话 |
| **Diff Stream** | 实时推送代码变更的 SSE-like 流 |

### 4.4 配置文件位置

| 文件 | 说明 |
|---|---|
| `~/.claude/settings.json` | Claude Code 设置：env 变量、enabledPlugins、permissions |
| `~/.vibe-ultra/config.json` | 应用全局配置 |
| `~/.vibe-ultra/profiles.json` | AI 执行器 profiles 配置 |
| `~/.vibe-ultra/vibe-ultra.db` | SQLite 数据库（本地存储） |
| `localStorage['vibe-ultra-ide-layout']` | IDE 布局持久化（dockview JSON，版本 8） |

---

## 五、编码规范

### 5.1 通用规范

- **文件大小**：通常 200–400 行，最多 800 行；超出时提取工具函数
- **函数长度**：单函数不超过 50 行
- **命名**：语义化、清晰；组件用 PascalCase，函数/变量用 camelCase，Rust 用 snake_case
- **不可变性**：JS/TS 中始终创建新对象，禁止直接修改原对象（`user.name = x` → `{...user, name: x}`）
- **禁止 `console.log`**：调试完成后必须删除

### 5.2 TypeScript / React

- 严格模式 TypeScript，所有组件必须有明确类型
- 优先使用函数式组件 + Hooks
- 使用 TanStack Query 管理服务端状态（请求、缓存、同步）
- 使用 Zustand 管理纯客户端状态
- `shared/types.ts` 是自动生成文件，**禁止手动修改**，类型变更在对应 Rust 结构体中进行
- Tauri IPC 调用统一封装在 `frontend/src/lib/api.ts`，不在组件中直接调用 `invoke`

```typescript
// 正确：使用 api.ts 封装
import { api } from '@/lib/api'
const result = await api.getWorkspace(id)

// 错误：直接在组件中调用 invoke
import { invoke } from '@tauri-apps/api/core'
const result = await invoke('get_workspace', { id })
```

### 5.3 Rust

- 使用 `anyhow::Result` 处理错误，`thiserror` 定义领域错误类型
- 数据库操作使用 `sqlx`，异步查询
- 公共 API 类型在 `crates/api-types/` 中定义，添加 `#[derive(ts_rs::TS)]` 以自动生成 TS 类型
- Tauri Command 函数放在 `src-tauri/src/commands/` 对应模块中
- 修改 API 类型后需重新运行 `cargo run --bin generate-types` 更新 `shared/types.ts`

### 5.4 布局与 dockview

- Group ID 统一使用 `GROUP_IDS` 常量，Panel ID 使用 `PANEL_IDS` 常量
- 左栏宽度上限 40%，通过 `onDidLayoutChange` 动态夹紧
- `api.fromJSON()` 后布局尺寸需要 `setTimeout(100ms)` 延迟才能获取真实 DOM 尺寸
- 布局持久化存在 `localStorage`，key 为 `vibe-ultra-ide-layout`，版本变更需同步更新版本号

---

## 六、关键文件速查

```
frontend/src/
├── App.tsx                              路由根
├── lib/api.ts                           所有 Tauri IPC 调用封装（唯一入口）
├── components/
│   ├── layout/
│   │   ├── IDELayout.tsx                主布局（dockview + 右侧面板）
│   │   ├── IDEWorkspaceRoute.tsx        路由层组合
│   │   ├── WorkspaceLayout.tsx          Context 注入层
│   │   ├── RightPanelContent.tsx        右侧固定面板内容
│   │   ├── Toolbar.tsx                  顶部工具栏
│   │   ├── BranchInfoHeader.tsx         分支信息头
│   │   └── panels/PanelRegistry.tsx     面板注册表
│   ├── panels/
│   │   ├── DockviewTerminalPanel.tsx    终端面板
│   │   └── DockviewDiffsReviewPanel.tsx Diff 审查面板
│   └── tasks/
│       ├── PermissionSelector.tsx       权限选择器（auto/ask/plan）
│       ├── ModelSelector.tsx            模型选择器
│       ├── PluginSelector.tsx           插件选择器
│       └── TaskFollowUpSection.tsx      主 AI 输入区
├── stores/
│   └── useLayoutStore.ts                布局状态（Zustand + persist）
└── hooks/
    └── useClaudeSettings.ts             读取 ~/.claude/settings.json

src-tauri/src/commands/
├── config.rs                            get/update_claude_settings
├── file_tree.rs                         read_file_content、get_file_at_head
├── sessions.rs                          follow_up、reset_session_process
└── workspaces.rs                        branch/git/merge/rebase 操作

crates/
├── executors/src/executors/             各 AI Agent 执行器实现
│   ├── claude.rs                        Claude Code 执行器
│   ├── codex/                           Codex 执行器
│   ├── acp/                             ACP 执行器
│   └── opencode/                        OpenCode 执行器
└── services/                            业务逻辑层

shared/types.ts                          自动生成（勿手动修改）
```

---

## 七、开发工作流

### 启动开发环境

```bash
pnpm install           # 安装前端依赖
pnpm run dev           # 启动 Tauri 开发模式（自动 vite build --watch）
```

### 仅构建前端

```bash
cd frontend && pnpm build
```

### 更新 TS 类型（修改 Rust API 类型后）

```bash
cargo run --bin generate-types
```

### 常用工具

```bash
cargo install cargo-watch    # Rust 热重载辅助
cargo install sqlx-cli       # SQLite 迁移管理
```

### 已知架构限制

| 限制 | 说明 |
|---|---|
| Rust 代码修改需重编译 | `tauri dev` 会自动触发，生产构建需 `tauri build` |
| `shared/types.ts` 为自动生成 | 手动修改会被覆盖，类型修改须在 Rust 结构体中进行 |
| dockview 无原生 `tabOverflowMode` | 通过 CSS 覆盖 `.dv-tabs-container { overflow-x: auto }` 解决 |
| `api.width = 0` 在 fromJSON 后立即调用 | 通过 `setTimeout(100ms)` 延迟夹紧左栏宽度 |
| KanbanBoard 以 absolute overlay 实现 | Kanban/Workspace 共享 dockview 实例，切换时 dockview 设为 `invisible` |

---

## 八、用户自定义规则

### 8.1 参考代码目录

`./code-referance` 目录下为同类竞品项目，可以进行项目代码参考借鉴。在实现新功能或解决问题时，可优先查阅此目录中的参考实现，了解同类产品的设计模式和解决方案，但须结合本项目架构进行适配，不得直接复制粘贴。
