# Vibe Ultra 项目总结文档

> 更新日期：2026-03-06
> 分支：`vk/5468-superpowers-brai`

---

## 一、术语 → 组件映射

用户日常口头描述与实际代码组件的对应关系。

### 布局区域术语

| 用户术语 | 技术术语 | Group ID | 说明 |
|---|---|---|---|
| **左栏** | Left Sidebar | `GROUP_IDS.LEFT = 'group-left'` | 文件树 / Git 面板所在的左侧可收折侧边栏，无标签头（`dv-header-hidden`） |
| **中1栏** | Center-1 | `GROUP_IDS.CENTER_1 = 'group-center-1'` | 主编辑区左半部分（Kanban、欢迎页、Diff、Preview、Logs、Notes 等） |
| **中2栏** | Center-2 | `GROUP_IDS.CENTER_2 = 'group-center-2'` | 主编辑区右半部分，与 Center-1 并排 |
| **终端栏** | Bottom Terminal | `GROUP_IDS.BOTTOM = 'group-bottom'` | 底部终端/日志面板 |
| **右栏** | Right Fixed Panel | —（不属于 dockview） | AI 对话区域，固定宽度（默认 500px），通过 `IDELayout.rightPanelContent` 插槽传入，**不受 dockview 管理** |
| **活动栏** | Activity Bar | — | 最左侧的图标栏（宽 40px），有文件树和 Git 两个图标按钮 |
| **工具栏** | Toolbar | — | 顶部工具栏，含 Logo、分支状态、Tab 切换（Kanban/Workspace）、面板切换按钮组 |
| **状态栏** | StatusBar | — | 底部状态栏 |

### 面板 ID → 组件

| Panel ID | 常量名 | 组件文件 | 默认区域 | 说明 |
|---|---|---|---|---|
| `kanban` | `PANEL_IDS.KANBAN` | `DockviewKanbanPanel` | Center | Kanban 看板（实际以全屏覆盖层渲染，dockview 面板仅占位） |
| `file-tree` | `PANEL_IDS.FILE_TREE` | `DockviewFileTreePanel` | 左栏 | 文件树浏览器 |
| `git` | `PANEL_IDS.GIT` | `DockviewGitPanel` | 左栏 | Git 状态/操作管理器 |
| `terminal` | `PANEL_IDS.TERMINAL` | `DockviewTerminalPanel` | 终端栏 | xterm.js + Tauri PTY，支持多 tab、shell 切换 |
| `diffs` | `PANEL_IDS.DIFFS` | `DockviewDiffsReviewPanel` | 中1/中2 | Diff 审查面板，支持代码注释、行级 review |
| `preview` | `PANEL_IDS.PREVIEW` | `DockviewPreviewPanel` | 中1/中2 | 内嵌 webview 预览（开发服务器 URL） |
| `welcome` | `PANEL_IDS.WELCOME` | `DockviewWelcomePanel` | 中1 | 工作区欢迎/空白占位页 |
| `logs` | `PANEL_IDS.LOGS` | `DockviewLogsPanel` | 中1/中2 | 执行日志查看器 |
| `notes` | `PANEL_IDS.NOTES` | `DockviewNotesPanel` | 中1/中2 | 工作区笔记 |
| `ai-chat` | `PANEL_IDS.AI_CHAT` | `DockviewAIChatPanel` | —（占位） | 仅注册用，实际 AI Chat 在右侧固定面板 |

### 右栏内部结构

```
右栏（RightPanelContent）
├── BranchInfoHeader         ← 分支信息头：当前分支、目标分支、切换目标分支按钮
├── Outlet（路由内容）        ← 根据路由渲染 TaskPanel / TaskAttemptPanel 等
│     ├── TaskPanel          ← 任务详情 + 历史尝试列表
│     └── TaskAttemptPanel   ← 对话历史 + TaskFollowUpSection（输入框）
└── RightPanelSidebar        ← 右侧迷你侧边栏（审阅、标记等）
```

---

## 二、项目架构

### 2.1 技术栈总览

```
┌─────────────────────────────────────────────────────┐
│              Tauri v2 桌面应用容器                    │
│                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │   前端 (Vite + React) │  │   后端 (Rust / Tokio) │ │
│  │                      │  │                      │ │
│  │  React 18 + TS       │  │  Tauri Commands      │ │
│  │  TanStack Query      │  │  SQLite (sqlx)       │ │
│  │  Zustand             │  │  Git (git2)          │ │
│  │  dockview-react      │  │  PTY (Terminal)      │ │
│  │  xterm.js            │  │  AI Executors        │ │
│  │  Monaco Editor       │  │  Services Layer      │ │
│  │  react-router-dom v6 │  │  Deployment Mgmt     │ │
│  └──────────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 2.2 前端层级结构

```
App.tsx（路由根）
└── IDEWorkspaceRoute         /local-projects/:projectId/tasks/*
      └── WorkspaceLayout     注入 Context 层
            │  providers: WorktreeProvider → ReviewProvider
            │             → TerminalProvider → PanelActionsProvider
            └── IDELayout     dockview 布局容器
                  ├── [工具栏] Toolbar
                  │     ├── WorktreeSelector（左）
                  │     ├── WorkspaceTabSwitcher（中）—— Kanban / Workspace
                  │     └── 面板切换按钮组（右）
                  ├── [活动栏] ActivityBar（宽 40px）
                  ├── [主区域] DockviewReact（dockview 管理）
                  │     ├── group-left     → FileTree / Git
                  │     ├── group-center-1 → Kanban / Welcome / Diffs / Preview / Logs / Notes
                  │     ├── group-center-2 → （同上，并排）
                  │     └── group-bottom   → Terminal
                  ├── [Kanban覆盖层] KanbanBoard（activeTab=kanban 时全屏显示）
                  ├── [右侧固定] RightPanelContent
                  │     ├── BranchInfoHeader
                  │     ├── Outlet（TaskPanel / TaskAttemptPanel）
                  │     └── RightPanelSidebar
                  └── [状态栏] StatusBar
```

### 2.3 后端 Crate 架构

```
src-tauri/（Tauri 入口，组装 Tauri Commands）
│
├── crates/db/              数据库层：SQLite schema、migrations、CRUD
├── crates/services/        业务逻辑层：任务、会话、diff流、queue、scratch
├── crates/git/             Git 操作：diff 生成、branch、worktree、rebase
├── crates/executors/       AI 执行器：Claude Code 等 agent 的抽象和实现
├── crates/deployment/      部署管理：AppState 初始化、事件转发
├── crates/local-deployment/本地部署实现
├── crates/api-types/       共享 API 类型（TS 类型通过 ts-rs 生成）
├── crates/utils/           工具函数：diff 计算、资源路径等
└── crates/review/          （独立 binary，不被主 crate 引用）
```

### 2.4 数据流

```
用户操作（前端）
    │
    ▼
tauriInvoke('command_name', args)     ← 前端调用 Tauri 命令
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
Tauri Events（SSE-like）              ← 流式推送（diff stream, conversation stream）
    │
    ▼
前端 useQuery / EventSource 订阅
```

### 2.5 布局持久化机制

- **存储**：`localStorage` key `vibe-ultra-ide-layout`（版本 8）
- **管理**：Zustand + `persist` 中间件（`useLayoutStore`）
- **序列化**：`api.toJSON()` / `api.fromJSON()`（dockview 内置）
- **恢复流程**：
  1. `handleReady` 读取 `serializedLayout`
  2. `api.fromJSON(layout)` 恢复
  3. `applyLeftGroupHeaderHiding` 重新隐藏左栏头部
  4. `validateTerminalPosition` 检查终端是否误入左栏
  5. `setTimeout(100ms)` 延迟夹紧左栏宽度（等待 DOM 真实尺寸）

### 2.6 AI 输入框组件层次

```
TaskFollowUpSection（主输入区）
├── WYSIWYGEditor               富文本输入
├── PermissionSelector          权限模式：自动 / 询问 / 计划
├── ModelSelector               模型选择：默认 / Opus
├── PluginSelector              插件选择（读取 ~/.claude/settings.json enabledPlugins）
├── Attachment / ReviewChanges  附件 & 审阅按钮
└── Send / Stop / Queue         发送 / 停止 / 排队按钮

RetryEditorInline（重试编辑器）
└── 同上三选择器（权限 / 模型 / 插件）

TaskFormDialog / CreateAttemptDialog（创建任务/尝试对话框）
└── AgentSelector + PermissionSelector + ModelSelector + PluginSelector
```

### 2.7 配置文件

| 文件 | 说明 |
|---|---|
| `~/.claude/settings.json` | Claude Code 设置：env 变量、enabledPlugins、permissions |
| `~/.vibe-ultra/config.json` | Vibe Ultra 应用配置 |
| `~/.vibe-ultra/profiles.json` | AI 执行器 profiles 配置 |
| `~/.vibe-ultra/vibe-ultra.db` | SQLite 数据库 |

---

## 三、已知问题清单

### 3.1 已修复的 Bug（本分支 batch 9–11）

| # | 问题描述 | 修复方式 | 提交 |
|---|---|---|---|
| B1 | `enabledPlugins` 字段被解析为 `Vec<String>` 导致无法读取 `{"plugin": true}` 格式 | Rust 改为 `HashMap<String, bool>` + `Value` 解析 | `893c7c1`, `9fa01f5` |
| B2 | 左侧面板宽度无限制，终端拖拽时侵入左栏 | `onDidLayoutChange` 中夹紧左栏宽度 ≤ 40% | `dee9620` |
| B3 | 初始化时终端侵入左栏（fromJSON 同步，DOM 异步，api.width=0） | `setTimeout(100ms)` 延迟夹紧 | `9fa01f5` |
| B4 | 标签页溢出无法横向滚动，只能用右侧下拉 | CSS 覆盖 `.dv-tabs-container { overflow-x: auto }` | `9fa01f5` |
| B5 | 默认权限为 `ask`（询问），应为 `auto`（自动） | 4 个组件的 `useState` 初始值改为 `'auto'` | `9fa01f5` |
| B6 | `BranchInfoHeader` "切换目标分支" 按钮无效（空函数） | 实现 `handleChangeTarget`，接入 `ChangeTargetBranchDialog` | `c650d89` |
| B7 | `RetryEditorInline` 使用旧的 `VariantSelector` | 替换为 `PermissionSelector + ModelSelector + PluginSelector` | `c650d89` |
| B8 | `TaskFormDialog`/`CreateAttemptDialog` 使用旧的 `ExecutorProfileSelector` | 同上三选择器替换 | `c650d89` |
| B9 | `UserMessage` 无回退按钮（`sessionsApi.reset` 已实现但未连接 UI） | 添加悬浮 Undo 按钮 + `RestoreLogsDialog` | `c650d89` |
| B10 | 终端内容与左边缘紧贴，无内边距 | `px-2 pt-1` padding 加到终端容器 | `00bdf0b` |
| B11 | Diff 预览显示 "Content omitted due to file size." 无法预览 | 添加"加载预览"按钮，按需读取 HEAD 内容 + 工作区内容 | `00bdf0b` |
| B12 | PluginSelector Tauri 二进制未重新编译时返回空插件 | `useClaudeSettings` 增加文件系统 fallback，直接解析 `settings.json` | `00bdf0b` |
| B13 | Diff "加载预览"后显示 +0 -0（modified 文件 oldPath=null，HEAD 路径错误） | 改为 `headRelPath = diff.oldPath \|\| diff.newPath`，修复 `useMemo` 依赖 | `04a3686` |

### 3.2 已知架构限制

| # | 问题 | 影响 | 说明 |
|---|---|---|---|
| A1 | **Tauri 二进制需手动重新编译** | Rust 代码修改后，`tauri dev` 会自动触发，但 production build 需要 `tauri build` | Rust 不像前端可以热重载 |
| A2 | **PluginSelector 仅更新本地 UI 状态** | 选择插件后实际无法控制 Claude Code 使用哪个插件（插件由 `settings.json` 全局控制） | 需要 follow_up API 支持 plugin 字段才能实现 per-message 插件选择 |
| A3 | **dockview 无 `tabOverflowMode` API（v5.1.0）** | 无法原生配置标签溢出行为 | 通过 CSS 覆盖 `overflow-x: auto` 变通解决 |
| A4 | **`api.width = 0` 在 fromJSON 后立即调用** | 左栏宽度夹紧在初始化时失效 | 通过 `setTimeout(100ms)` 绕过 |
| A5 | **`KanbanBoard` 以 absolute overlay 实现** | Kanban 和 Workspace 两个 Tab 共享 dockview 实例，Kanban 激活时 dockview 设为 `invisible` | 切换 Tab 时布局状态得以保留，但内存占用略高 |
| A6 | **`shared/types.ts` 由 Rust 自动生成** | 手动修改 `shared/types.ts` 会被 `generate-types` 脚本覆盖 | 类型修改需在 Rust 结构体中进行 |

### 3.3 待优化项

| # | 优化点 | 优先级 |
|---|---|---|
| O1 | `useClaudeSettings` fallback 路径在 `enabled_plugins` 为空时始终触发（无法区分"真正为空"和"二进制未重编译"） | 中 |
| O2 | `DiffCard` 的"加载预览"每次都重新加载，无缓存 | 低 |
| O3 | `validateTerminalPosition` 只检查 `group.id === GROUP_IDS.LEFT`，无法处理终端在视觉上溢出（宽度异常）的情况 | 低 |
| O4 | 右侧面板宽度限制（最小 480px）在小屏幕上可能导致布局压缩 | 低 |
| O5 | `TaskFollowUpSection` 底部按钮栏在小窗口下 flex-wrap 会换行，影响视觉 | 低 |

---

## 四、关键文件速查

```
frontend/src/
├── App.tsx                              路由根
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
│   │   ├── DockviewDiffsReviewPanel.tsx Diff 审查面板
│   │   └── ...
│   ├── tasks/
│   │   ├── PermissionSelector.tsx       权限选择器
│   │   ├── ModelSelector.tsx            模型选择器
│   │   ├── PluginSelector.tsx           插件选择器
│   │   └── TaskFollowUpSection.tsx      主输入区
│   └── NormalizedConversation/
│       ├── RetryEditorInline.tsx        重试编辑器
│       └── UserMessage.tsx              用户消息（含回退按钮）
├── stores/
│   └── useLayoutStore.ts                布局状态（Zustand + persist）
├── hooks/
│   └── useClaudeSettings.ts             读取 ~/.claude/settings.json
└── lib/
    └── api.ts                           所有 Tauri IPC 调用封装

src-tauri/src/commands/
├── config.rs                            get/update_claude_settings
├── file_tree.rs                         read_file_content, get_file_at_head,
│                                        get_claude_settings_path
├── sessions.rs                          follow_up, reset_session_process
└── workspaces.rs                        branch/git/merge/rebase 操作

shared/types.ts                          自动生成的 TS 类型（勿手动修改）
```
