# VibeUltra 前端审查报告

> 审查日期: 2026-03-16 (第二轮)
> 审查范围: `frontend/src/` 全部前端代码
> 总体评级: **警告** -- 存在主题适配视觉 bug 和多个维护问题

---

## 一、CSS 文件导入状态

### 所有现存 CSS 文件均已正确导入

| CSS 文件 | 导入方式 | 导入位置 |
|----------|----------|----------|
| `conversation.css` | `import` | `DisplayConversationEntry.tsx` |
| `dockview-ayu.css` | `?raw` 内联注入 | `IDELayout.tsx` |
| `diff-style-overrides.css` | `import` | `DiffCard.tsx`、`FileContentView.tsx`、`FileChangeRenderer.tsx`、`EditDiffRenderer.tsx` (4 处重复导入) |
| `edit-diff-overrides.css` | `import` | `FileContentView.tsx`、`EditDiffRenderer.tsx` |
| `file-tree.css` | `import` | `FileTreePanel.tsx` |
| `fonts.css` | `@import` | `legacy/index.css` |
| `legacy/index.css` | `import` | `LegacyDesignScope.tsx` |

### [高] New Design CSS 已删除但配置未清理

**问题**: `styles/new/index.css` 文件已不存在，但以下位置仍引用：
- `frontend/components.json:8` -- `"css": "src/styles/new/index.css"`
- `frontend/CLAUDE.md` 文档多处提及
- `frontend/tests/settings-page.test.js:68` 尝试读取

`tailwind.new.config.js` 仍存在但无实际作用。`NewDesignScope` 组件从未定义或使用。

**修复**: 删除 `tailwind.new.config.js`；更新 `components.json` 指向 `legacy/index.css`；清理文档引用。

### [中] diff-style-overrides.css 被 4 处重复导入

同一 CSS 文件在 4 个组件中重复 `import`。虽然 Vite 会去重，但建议提升到更高层级统一导入。

---

## 二、未使用的组件

### 已删除文件引用清理状态

所有 git status 标记为 `D` 的文件（共 15 个）的引用均已**正确清理**，无残留 import。具体包括：
- `DevBanner.tsx`, `ExecutorConfigForm.tsx`, `NewDesignLayout.tsx`
- `ExecutorProfileSelector.tsx`
- `ClaudeCodeForm.tsx`, `CodexForm.tsx`, `OpenCodeForm.tsx`, `agent-forms/index.ts`
- `GeneralSettings.tsx`, `ProjectSettings.tsx`, `ReposSettings.tsx`
- `CreateConfigurationDialog.tsx`, `DeleteConfigurationDialog.tsx`
- `useGitHubStars.ts`, `TasksLayout.tsx`

---

## 三、暗色/亮色主题适配问题

### 3.1 [高] conversation.css 亮色模式代码块使用暗色背景

**文件**: `frontend/src/styles/conversation.css:498`

```css
.conv-assistant-msg .ProseMirror pre {
  background: #1e1e2e !important;  /* Catppuccin 暗色背景 */
}
```

此选择器**不在 `.dark` 作用域内**，意味着亮色模式下代码块也显示深色背景 `#1e1e2e`，与整体亮色主题严重不协调。

**另外**第 520 行 `color: #c9d1d9 !important` 也在非 `.dark` 选择器中使用了暗色主题颜色。

### 3.2 [高] file-tree.css 完全没有暗色/亮色主题区分

**文件**: `frontend/src/styles/file-tree.css` (1094 行)

整个文件中 `.dark` 选择器出现 **0 次**。所有语法高亮颜色（970-1049 行，约 15 个 token 类型）均为硬编码暗色主题值（`#ff7b72`、`#7ee787`、`#d2a8ff`），在亮色背景上对比度不足。

Git 状态颜色（1014-1049 行）同样硬编码：
- `git-a`(新增): `#89d185`
- `git-m`(修改): `#6bb3f0`
- `git-d`(删除): `#ff6b6b`

### 3.3 [中] conversation.css 硬编码颜色未走 CSS 变量

虽然文件顶部（7-54 行）定义了 `--conv-*` CSS 变量并区分了 `:root`(亮色) 和 `.dark`(暗色)，但后半部分大量直接使用硬编码 HEX 值：

- 288-289: `.dark .conv-terminal-output` 使用 `#0f1117`/`#7ee787`，但亮色缺对应样式
- 766-852: Prism token 颜色约 40 处硬编码
- 1007-1024: 代码块背景 `#f6f8fa`(亮)/`#0d1117`(暗) 直接硬编码

### 3.4 [中] diff-style-overrides.css 部分亮色样式缺暗色适配

该文件整体做得较好（约 51 处 `data-theme='dark'`），但以下缺失：
- 477: tooltip 背景 `#555555` 两种主题同色
- 546: `background: #ffffff` 仅亮色
- 641-647: `.hljs-addition` 背景 `#f0fff4` 和 `.hljs-deletion` 背景 `#ffeef0` 仅亮色

### 3.5 [中] 组件硬编码颜色

| 文件 | 行号 | 颜色 | 问题 |
|------|------|------|------|
| `ProjectTasks.tsx` | 153 | `#FCFCFC` | 近白色背景，暗色模式下为白色块 |
| `CommitGraph.tsx` | 15-18 | `#3B82F6`/`#9CA3AF`/`#F59E0B` | SVG 颜色无主题适配 |
| `WindowControls.tsx` | 89 | `#e81123` | Windows 系统色，可接受 |

### 3.6 暗色模式实现方式不统一

| 系统 | 暗色切换方式 |
|------|-------------|
| Legacy Design | `.dark` CSS class |
| Conversation CSS | `.dark` CSS class |
| Diff Overrides | `data-theme='dark'` 属性 |
| File Tree | **无暗色支持** |

---

## 四、多主题系统并存

当前存在 **三套独立样式系统**：

| 系统 | 入口文件 | 状态 |
|------|----------|------|
| Legacy Design | `styles/legacy/index.css` | **当前生效** -- 所有路由包裹在 `LegacyDesignScope` |
| New Design | `styles/new/index.css` | **已删除** -- 配置未清理 |
| Conversation CSS | `styles/conversation.css` | **独立系统** -- 变量与 Legacy 互不关联 |

另有独立的 `diff-style-overrides.css`、`file-tree.css`、`dockview-ayu.css`。

**建议**: 统一为一套主题变量系统，消除 New Design 残留。

---

## 五、超大样式文件

| 文件 | 行数 | 拆分建议 |
|------|------|----------|
| `file-tree.css` | **1094** | `file-tree-base.css` + `file-tree-syntax.css` + `file-tree-git.css` |
| `conversation.css` | **1024** | `conv-base.css` + `conv-messages.css` + `conv-tools.css` + `conv-markdown.css` + `conv-syntax.css` |
| `diff-style-overrides.css` | **989** | `diff-layout.css` + `diff-widgets.css` + `diff-syntax-light.css` + `diff-syntax-dark.css` |

---

## 六、!important 滥用

- `conversation.css`: **41 处** `!important` -- 代码块区域连续 8 个
- `diff-style-overrides.css`: 6 处 -- 相对克制

---

## 七、命名与组织问题

### useConversationHistoryOld 命名误导

**文件**: `frontend/src/hooks/useConversationHistory/useConversationHistoryOld.ts` (751 行)

"Old" 后缀暗示过渡代码，但 `index.ts` 直接 re-export 为 `useConversationHistory`，是唯一实现。

**建议**: 重命名为 `useConversationHistory.ts`。

---

## 八、总结

| 分类 | 数量 |
|------|------|
| 高优先级 | 4 项（代码块暗色背景 bug、file-tree 无主题支持、New Design 配置残留、3 个 CSS 超大文件） |
| 中优先级 | 7 项（硬编码颜色、diff 主题缺失、!important 滥用、主题系统不统一、命名误导等） |
| 低优先级 | 2 项（CSS 重复导入、dockview ?raw 注入） |
