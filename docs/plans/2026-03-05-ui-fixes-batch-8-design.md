# UI Fixes Batch 8 Design

## Issue 1: Rebase Back 冲突处理

**现状：** `RebaseBackButton` 在 `result.success === false` 时只显示静态文字 "Rebase failed"，没有解析 `GitOperationError` 的具体类型。

**GitOperationError 类型：**
```ts
| { type: "merge_conflicts", message, op, conflicted_files, target_branch }
| { type: "rebase_in_progress" }
```

**设计：**

当 `result.error.type === "merge_conflicts"` 时，在 RebaseBackButton 下方渲染已有的 `ConflictBanner` 组件，传入冲突文件列表。ConflictBanner 已有"Open in Editor"按钮，新增一个"发送给AI"按钮让用户将冲突信息发送给 AI 处理。

具体修改：
- `BranchInfoHeader.tsx` 的 `RebaseBackButton`：解析 `result.error`，当 `type === "merge_conflicts"` 时存储冲突状态（`conflictedFiles`、`targetBranch`、`op`），渲染 `ConflictBanner`
- `ConflictBanner` props 已有 `onOpenEditor`、`onAbort`、`onResolve`、`conflictedFiles`、`op` 等，可以直接复用
- "发送给AI"功能：通过 `onResolve` 回调触发（或新增一个 `onSendToAI` prop）
- 当 `type === "rebase_in_progress"` 时显示简单提示文字

**文件：**
- `frontend/src/components/layout/BranchInfoHeader.tsx`

---

## Issue 2: Diff 标签页按钮改为黑色

**现状：** `toggle-group.tsx` 中的 `toggleGroupItemVariants` 使用 `bg-primary text-primary-foreground`（激活）和 `text-primary-foreground/70`（非激活），在 legacy-design 中 primary 是蓝色，前景是白色，按钮图标在白色背景下不可见。

**设计：**

修改 `toggle-group.tsx` 中的颜色变体：
- 激活态：`bg-foreground/10 text-foreground` → 亮色下接近黑色半透明背景 + 黑色图标
- 非激活态：`text-foreground/50 hover:bg-accent hover:text-accent-foreground` → 半透明黑色图标

**文件：**
- `frontend/src/components/ui/toggle-group.tsx`

---

## Issue 3: 左栏宽度溢出

**现状：** `onDidLayoutChange` 中通过 `el.style.maxWidth = '300px'` 钳制左栏宽度，但 dockview 内部重排会覆盖内联样式，导致不可靠。截图显示文件管理器面板宽度正常，但其父容器（left group）超出 300px。

**设计：**

使用 dockview 原生 API `group.api.setSize({ width: 300 })` 代替直接操作 DOM style。这让 dockview 布局引擎正确处理宽度约束。

在 `onDidLayoutChange` 回调中：
```ts
const leftGroup = api.groups.find((g) => g.id === GROUP_IDS.LEFT);
if (leftGroup && leftGroup.api.width > 300) {
  leftGroup.api.setSize({ width: 300 });
}
```

移除当前的 `(leftGroup as any).element` DOM 操作。

**文件：**
- `frontend/src/components/layout/IDELayout.tsx`

---

## Issue 4: 字体本地化（字符排版根本修复）

**根因：** 字体通过 Google Fonts CDN 加载（`@import url('https://fonts.googleapis.com/css2?...')`），在国内网络环境无法访问，导致 IBM Plex Sans / IBM Plex Mono 从未加载成功，所有文本一直用系统回退字体（Windows: Segoe UI / 微软雅黑）渲染，字符间距特性与 IBM Plex 完全不同。

**设计：**

1. 下载 IBM Plex Sans 和 IBM Plex Mono 的 woff2 字体文件（Regular、Medium、SemiBold、Bold 四个字重，italic 可选），放到 `frontend/public/fonts/` 目录
2. 创建 `frontend/src/styles/fonts.css`，使用 `@font-face` 声明本地字体
3. 移除 `legacy/index.css` 和 `new/index.css` 中的 Google Fonts `@import url(...)` 行
4. 在两个 CSS 入口文件中 `@import './fonts.css'` 替代
5. 在 `.legacy-design` 根元素上添加 `antialiased`（Tailwind 类），改善小字号渲染
6. 移除之前为变通字体问题添加的 `tracking-tight` — 使用正确的 IBM Plex 字体后不再需要

**Noto Emoji 处理：** 保留 Google Fonts 加载（emoji 不是核心 UI 字体，加载失败影响小），或者也本地化。优先保留远程，减小包体积。

**字重映射：**
- Regular (400) — 正文
- Medium (500) — 中等强调
- SemiBold (600) — 标题/按钮
- Bold (700) — 粗体强调

**文件：**
- 新建: `frontend/public/fonts/` 目录 + woff2 文件
- 新建: `frontend/src/styles/fonts.css`
- 修改: `frontend/src/styles/legacy/index.css`
- 修改: `frontend/src/styles/new/index.css`（如果也有 Google Fonts import）
- 修改: `frontend/src/components/git/CommitGraph.tsx` — 移除 `tracking-tight`
- 修改: `frontend/src/components/layout/BranchInfoHeader.tsx` — 移除 `tracking-tight`
