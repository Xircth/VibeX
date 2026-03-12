# Vibe-Ultra 项目改进规划文档

> 基于 MossX 参考项目的深度对比分析，制定 VibeUltra 功能对齐与 UI 优化路线图。
> 按 Phase 划分，各 Phase 内部按优先级排列。

---

## Phase 1 — 基础体验提升

> 目标：解决当前最影响用户体验的短板，快速见效。

### 1.1 全局搜索系统 (Command Palette)

**现状**：VibeUltra 仅有基础 SearchBar，缺少统一搜索入口。
**MossX 参考**：`src/features/search/` — 8 种 Provider、BM25 排序、Cmd+K 触发。

**实现要点**：
- 快捷键 `Cmd+K` / `Ctrl+K` 触发全局搜索面板
- Provider 架构（可扩展）：
  - `commandsProvider` — 应用内命令（切换面板、打开设置等）
  - `filesProvider` — 工作区文件搜索
  - `kanbanProvider` — 看板任务搜索
  - `threadsProvider` — 对话线程/Attempt 搜索
  - `historyProvider` — 最近操作历史
- 排序算法：参考 `search/ranking/score.ts`（BM25 + 时近度加权）
- UI：居中弹出模态框，实时过滤，分类展示结果

**参考文件**：
```
mossx/src/features/search/
├── hooks/useUnifiedSearch.ts
├── providers/*.ts
├── ranking/score.ts
└── components/SearchPalette.tsx
```

---

### 1.2 输入增强套件

**现状**：TaskFollowUpSection 功能已较丰富（Diff 统计、Token 使用率、WYSIWYG），但缺少输入历史和快捷操作。

#### 1.2.1 输入历史 (Input History)

- 上/下方向键翻阅历史消息
- 持久化存储到 localStorage
- 参考：`mossx/src/features/composer/hooks/useInputHistoryStore.ts`

#### 1.2.2 @文件引用

- 输入 `@` 触发文件选择弹出框
- 选中文件自动注入为上下文
- 在 WYSIWYG 编辑器中以标签形式展示
- 参考：`mossx/src/features/composer/components/ChatInputBox/ContextBar.tsx`

#### 1.2.3 提示词增强器 (Prompt Enhancer)

- 提供预设提示词模板（如"代码审查"、"重构建议"、"测试生成"）
- 一键插入到输入框
- 参考：`mossx/src/features/composer/components/ChatInputBox/PromptEnhancerDialog.tsx`

---

### 1.3 CSS 主题系统统一

**现状**：VibeUltra 存在两套割裂的设计系统（legacy + new），CSS 变量命名不统一。
**MossX 参考**：统一的 150+ CSS 变量体系，清晰的语义化命名。

**实现要点**：
- 统一为一套 CSS 变量体系，消除 legacy/new 双轨制
- 采用语义化命名（参考 MossX 的命名规范）：

```css
/* 文本层级 */
--text-primary      /* 默认文本 */
--text-strong       /* 强调文本 */
--text-muted        /* 次要文本 */
--text-faint        /* 最淡文本 */

/* 表面色 */
--surface-sidebar   /* 侧栏背景 */
--surface-panel     /* 面板背景 */
--surface-card      /* 卡片背景 */
--surface-hover     /* 悬停态 */
--surface-active    /* 激活态 */
--surface-popover   /* 弹出层 */

/* 边框 */
--border-subtle     /* 最淡边框 */
--border-muted      /* 常规边框 */
--border-strong     /* 强边框 */

/* 品牌色 */
--accent-primary    /* 主色调 */
--destructive       /* 危险操作 */
--success           /* 成功状态 */
--warning           /* 警告状态 */
```

- 合并两个 Tailwind 配置为一个
- 所有组件迁移到统一变量

---

### 1.4 滚动条优化

**现状**：使用默认浏览器滚动条，与 IDE 风格不匹配。
**MossX 参考**：自定义细滚动条，悬停时平滑显现。

**实现要点**：
```css
/* 默认隐藏，悬停时显现 */
*::-webkit-scrollbar { width: 8px; }
*::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 4px;
  background-color: var(--scrollbar-thumb);
}
/* Firefox */
scrollbar-width: thin;
scrollbar-color: transparent transparent;
```

---

## Phase 2 — 核心功能对齐

> 目标：补齐 MossX 已有但 VibeUltra 缺失的核心功能。

### 2.1 项目记忆系统 (Project Memory)

**现状**：VibeUltra 完全没有此功能。
**MossX 参考**：`src/features/project-memory/` — 8 种记忆类型、自动分类、上下文注入。

**实现要点**：

#### 后端 (Rust)
- 新建 `crates/project-memory/` crate
- 数据模型：
  ```rust
  struct ProjectMemory {
      id: Uuid,
      project_id: Uuid,
      kind: MemoryKind,       // Architecture, Pattern, Security, Bug, Config 等
      content: String,
      source_thread_id: Option<Uuid>,
      created_at: DateTime,
      updated_at: DateTime,
  }
  ```
- SQLite 存储，支持全文搜索
- Tauri Command：`create_memory`、`list_memories`、`delete_memory`、`search_memories`

#### 前端
- 新建 `frontend/src/features/project-memory/`（采用 features 模式）
- 组件：
  - `ProjectMemoryPanel` — 记忆列表/编辑面板，注册为 dockview 面板
  - `MemoryBadge` — 记忆类型标签
- Hooks：
  - `useProjectMemory()` — CRUD 操作
  - `useMemoryInjection()` — AI 对话前自动注入相关记忆
- 记忆分类器：参考 `mossx/src/features/project-memory/utils/memoryKindClassifier.ts`

---

### 2.2 国际化 (i18n)

**现状**：VibeUltra 完全没有 i18n 支持。
**MossX 参考**：`src/i18n/` — react-i18next，中英双语。

**实现要点**：
- 安装 `react-i18next` + `i18next`
- 创建 `frontend/src/i18n/`：
  ```
  i18n/
  ├── index.ts          ← i18next 初始化
  └── locales/
      ├── en.ts         ← 英文
      └── zh.ts         ← 中文
  ```
- 翻译 key 按功能域组织：
  ```typescript
  {
    toolbar: { newTask: "新建任务", settings: "设置" },
    kanban: { todo: "待办", inProgress: "进行中", done: "完成" },
    composer: { placeholder: "输入消息...", send: "发送" },
    settings: { general: "常规", theme: "主题" }
  }
  ```
- 设置页面添加语言切换器
- 优先翻译高频界面文本，逐步覆盖

---

### 2.3 自动更新系统

**现状**：VibeUltra 未实现自动更新。
**MossX 参考**：`src/features/update/` — tauri-plugin-updater。

**实现要点**：
- 集成 `tauri-plugin-updater`
- 前端 Hook：`useUpdater()` — 检查更新、下载进度、安装
- UI：
  - StatusBar 中显示更新提示
  - 更新详情 Dialog（版本号、Changelog、下载进度条）
- 后端配置更新源 URL

---

### 2.4 Git 面板全面增强

**现状**：VibeUltra 有基础 Git 面板（暂存/提交/推送/日志），但缺少 Pull/Fetch、分支管理、增强日志、树视图等功能。
**MossX 参考**：`src/features/git/` — 完整的 Git 管理模块（4 种模式、树视图、多选、PR 审查等）。

**详细计划**：见 [`docs/plans/git-panel-enhancement-plan.md`](plans/git-panel-enhancement-plan.md)

**分阶段实施**：
- **Phase G1**（核心）— Pull/Fetch、分支管理、日志增强、Flat/Tree 视图切换
- **Phase G2**（交互）— 丢弃确认、Commit 折叠、预览模态框、多文件选择、右键菜单
- **Phase G3**（Diff 增强）— Sticky 文件头、变更导航、Full Diff 模式
- **Phase G4**（GitHub 集成）— Issues/PRs 模式、PR 智能对话、AI Commit 消息

---

## Phase 3 — UI 精细化

> 目标：参考 MossX 的设计语言，全面提升 VibeUltra 的视觉品质。

### 3.1 面板标签优化

**现状**：dockview 默认标签样式，缺少精致感。
**MossX 参考**：紧凑的 PanelTabs 设计，13px 图标、6px 间距、激活态有微妙光晕。

**实现要点**：
```css
.panel-tab {
  min-width: 20px;
  min-height: 20px;
  padding: 2px;
  color: var(--text-muted);
  transition: color 160ms ease, opacity 160ms ease;
}

.panel-tab.is-active {
  background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
  color: var(--accent-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 46%, transparent);
  border-radius: 6px;
}

.panel-tab-icon svg {
  width: 13px;
  height: 13px;
  stroke-width: 2.2;
}
```

---

### 3.2 侧栏 (Sidebar) 重设计

**现状**：ActivityBar 仅为 40px 图标栏，左栏面板样式较朴素。
**MossX 参考**：精致的侧栏设计，圆角行、悬停态、层级缩进。

**实现要点**：
- 侧栏行高统一：工作区 32px、线程 30px
- 圆角：8px（`--sidebar-row-radius`）
- 悬停态：`background: var(--surface-hover); border-radius: 8px`
- 激活态：左侧 2px 蓝色指示条
- 分组标题：大写字母、10px 字号、`--text-faint` 颜色
- 可折叠分组，带平滑动画

---

### 3.3 通知/Toast 系统升级

**现状**：基础 Alert 组件，缺少精致的 Toast 通知。
**MossX 参考**：居中弹出的 Approval Toast，带代码预览、磨砂背景。

**实现要点**：
- 权限审批 Toast（AI 请求执行操作时弹出）：
  ```css
  .approval-toast {
    background: var(--surface-card);
    border-radius: 12px;
    border: 1px solid var(--border-subtle);
    padding: 12px;
    box-shadow: 0 16px 32px rgba(0, 0, 0, 0.25);
    animation: toast-in 0.2s ease-out;
  }
  ```
- 代码预览区域：等宽字体、8px 内边距、160px 最大高度
- 操作按钮：Allow / Deny / Always Allow
- 背景遮罩：`backdrop-blur-sm` 磨砂效果

---

### 3.4 对话框/弹出框动画

**现状**：Dialog 使用基础出现/消失，无过渡动画。
**MossX 参考**：scale + fade 组合动画，磨砂背景。

**实现要点**：
```css
/* 弹出框 */
[data-state="open"] {
  animation: dialog-in 200ms ease-out;
}
[data-state="closed"] {
  animation: dialog-out 150ms ease-in;
}

@keyframes dialog-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* 背景遮罩 */
.dialog-backdrop {
  background: rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(4px);
}
```

---

### 3.5 加载状态优化

**现状**：使用 Loader2 旋转图标，缺少骨架屏和呼吸动画。
**MossX 参考**：丰富的加载动画（shimmer、breathing、spin）。

**实现要点**：
- **骨架屏组件** `<Skeleton />`：
  ```css
  .skeleton {
    background: linear-gradient(90deg,
      var(--surface-card) 25%,
      var(--surface-hover) 50%,
      var(--surface-card) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
  }
  ```
- **工具执行呼吸动画**：
  ```css
  @keyframes tool-breathing {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }
  ```
- 用于：面板加载、消息流等待、文件树加载

---

### 3.6 字体系统优化

**现状**：使用 IBM Plex Sans/Mono，可进一步优化。
**MossX 参考**：系统字体优先 + SF Mono 代码字体。

**建议**：
```css
:root {
  /* UI 字体：系统字体栈（更快加载、更好平台原生感） */
  --ui-font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                     "Segoe UI", system-ui, sans-serif;

  /* 代码字体：保留 IBM Plex Mono 或切换为更紧凑的 JetBrains Mono */
  --code-font-family: "JetBrains Mono", "SF Mono", "IBM Plex Mono",
                       "Cascadia Code", Menlo, monospace;
  --code-font-size: 12px;
  --code-line-height: 1.4;
}
```

---

## Phase 4 — 高级功能

> 目标：引入差异化高级特性，提升产品竞争力。

### 4.1 语音输入 (Dictation)

**现状**：VibeUltra 无此功能。
**MossX 参考**：`src-tauri/src/dictation/` — Whisper 本地语音转文字。

**实现要点**：
- Rust 后端：
  - 集成 `whisper-rs`（macOS/Linux）
  - Windows 使用 Stub 或系统 API
  - `cpal` 跨平台音频采集
- 前端：
  - 输入框旁添加麦克风按钮
  - 录音指示器（波形/脉冲动画）
  - 录音结束后自动转文字填入输入框
- 注意：Windows 平台 Whisper 支持可能需要额外适配

---

### 4.2 Spec Hub（规范管理）

**现状**：VibeUltra 无此功能。
**MossX 参考**：`src/features/spec/` — 规范文档管理。

**实现要点**：
- 新增 dockview 面板：`DockviewSpecPanel`
- 支持创建/编辑项目规范文档
- Markdown 编辑 + 实时预览
- 规范可作为 AI 上下文注入（与项目记忆系统联动）

---

### 4.3 并行执行增强

**现状**：VibeUltra 已支持多 Session，但缺少并行可视化。
**MossX 参考**：`src/features/parallel/` — 多 Agent 并行运行。

**实现要点**：
- 并行执行状态面板：同时展示多个 Agent 运行状态
- 进度指示器：每个 Agent 独立的运行/等待/完成状态
- 资源占用提示：内存、API 调用次数
- 一键全部停止/暂停

---

### 4.4 自定义命令系统

**现状**：VibeUltra 无自定义命令。
**MossX 参考**：`src/features/commands/` — 用户自定义命令。

**实现要点**：
- 支持用户创建自定义命令（名称 + 执行脚本/提示词）
- 通过全局搜索 CommandsProvider 触发
- 命令持久化到 SQLite
- 预置常用命令模板

---

## Phase 5 — 架构优化

> 目标：渐进式改善代码架构，提升可维护性。

### 5.1 前端 Features 模块化（渐进式）

**现状**：按类型分散（components/hooks/stores）。
**MossX 参考**：按功能域组织（features/git/、features/search/）。

**策略**：不做全量重构，新功能一律采用 features 模式：
```
frontend/src/features/
├── search/           ← Phase 1 新增
│   ├── components/
│   ├── hooks/
│   ├── providers/
│   └── utils/
├── project-memory/   ← Phase 2 新增
│   ├── components/
│   ├── hooks/
│   ├── services/
│   └── utils/
├── git-history/      ← Phase 2 新增
├── dictation/        ← Phase 4 新增
└── spec/             ← Phase 4 新增
```

旧代码按需迁移，不强制一次性重构。

---

### 5.2 TaskFollowUpSection 拆分

**现状**：超过 1200 行的超大组件。
**MossX 参考**：ChatInputBox 拆分为多个子组件。

**拆分方案**：
```
TaskFollowUpSection (容器, ~200 行)
├── DiffStatsBar          ← 顶部 Diff 统计栏
├── TokenUsageIndicator   ← Token 使用率指示器
├── SessionSelector       ← Session 下拉选择器
├── ConflictResolver      ← 冲突解决部分
├── ReviewCommentsPreview ← 代码审查评论预览
├── MessageQueue          ← 消息队列指示器
├── ComposerInput         ← WYSIWYG 编辑器封装
└── ActionBar             ← 底部操作按钮栏
    ├── ExecutorSelector
    ├── AttachmentButton
    └── SendButton
```

---

### 5.3 测试基础设施

**现状**：VibeUltra 缺少前端测试。
**MossX 参考**：Vitest + Testing Library，有单元测试和集成测试。

**实现要点**：
- 安装 Vitest + @testing-library/react + jsdom
- 配置 `vitest.config.ts`
- 优先为核心 Hook 编写测试：
  - `useLayoutStore` — 布局状态
  - `useClaudeSettings` — 设置读取
  - 全局搜索的 Provider — 搜索逻辑
- 目标：新增代码 80%+ 覆盖率

---

### 5.4 UI 组件库补全

**现状**：基础 shadcn/ui 组件，缺少部分常用组件。
**MossX 参考**：22 个精调组件，CVA 变体系统完善。

**需补充的组件**：
| 组件 | 用途 | 参考 |
|------|------|------|
| `Skeleton` | 骨架屏加载占位 | 新增 |
| `Toast` / `Sonner` | 轻量通知 | MossX 的 toast 系统 |
| `Kbd` | 快捷键标签 | MossX `kbd.tsx` |
| `Progress` | 进度条 | 更新下载、任务进度 |
| `Accordion` | 折叠面板 | 设置页面 |
| `ScrollArea` | 自定义滚动区域 | 全局使用 |
| `Switch` | 开关控件 | 设置页面 |

---

## 各 Phase 产出清单

| Phase | 核心产出 | 新增文件数(估) |
|-------|---------|--------------|
| **Phase 1** | 全局搜索、输入增强、主题统一、滚动条 | ~15 |
| **Phase 2** | 项目记忆、i18n、自动更新、Git 历史 | ~30 |
| **Phase 3** | 面板标签、侧栏、Toast、动画、骨架屏、字体 | ~20 |
| **Phase 4** | 语音输入、Spec Hub、并行增强、自定义命令 | ~25 |
| **Phase 5** | Features 模块化、组件拆分、测试、UI 组件库 | ~20 |

---

## 风险与注意事项

1. **主题统一（Phase 1.3）风险最高** — legacy/new 双轨制迁移涉及大量文件，建议分模块渐进替换
2. **项目记忆系统** — 需设计好与 AI 对话的注入时机和格式，避免上下文溢出
3. **语音输入** — Windows 平台 Whisper 编译可能存在问题，建议先支持 macOS/Linux
4. **Features 模块化** — 严禁一次性大重构，只对新功能采用新结构
5. **组件拆分** — TaskFollowUpSection 拆分需确保 props drilling 不过深，合理使用 Context

---

## 附录：MossX 核心参考文件索引

| 功能 | MossX 文件路径 |
|------|---------------|
| 全局搜索 | `src/features/search/` |
| 搜索排序 | `src/features/search/ranking/score.ts` |
| 项目记忆 | `src/features/project-memory/` |
| 记忆分类 | `src/features/project-memory/utils/memoryKindClassifier.ts` |
| 输入历史 | `src/features/composer/hooks/useInputHistoryStore.ts` |
| 聊天输入 | `src/features/composer/components/ChatInputBox/` |
| 国际化 | `src/i18n/` |
| 自动更新 | `src/features/update/hooks/useUpdaterController.ts` |
| Git 历史 | `src/features/git-history/components/` |
| 语音输入 | `src-tauri/src/dictation/` |
| 暗色主题 | `src/styles/themes.dark.css` |
| 亮色主题 | `src/styles/themes.light.css` |
| 布局 | `src/features/layout/components/DesktopLayout.tsx` |
| 面板标签 | `src/features/layout/components/PanelTabs.tsx` |
| 侧栏样式 | `src/styles/sidebar.css` |
| Toast 样式 | `src/styles/approval-toasts.css` |
| 基础组件 | `src/components/ui/` |
