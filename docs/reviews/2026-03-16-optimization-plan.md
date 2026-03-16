# VibeUltra 项目优化方案

> 制定日期: 2026-03-16 (第二轮)
> 基于: 代码审查报告、前端审查报告、依赖分析报告、性能与安全分析报告

---

## 优化路线图

### 阶段一：P0 安全修复（1-2 小时）

| # | 任务 | 文件 | 修复方式 |
|---|------|------|----------|
| S1 | 收紧 Tauri fs 权限 | `src-tauri/capabilities/default.json` | 限制为 `$HOME/.claude/**`、`$HOME/.vibe-ultra/**`、`$RESOURCE/**`、仓库路径 |
| S2 | file_tree 路径沙盒 | `src-tauri/src/commands/file_tree.rs` | 验证路径必须位于已注册仓库/工作区下；拒绝 `..` 组件 |
| S3 | PowerShell 命令注入修复 | `crates/utils/src/browser.rs:8-9` | 对单引号转义或改用 `-Uri` 参数化 |
| S4 | PowerShell 命令注入修复 | `crates/services/src/services/notification.rs:90-91` | 参数化传递文件路径 |
| S5 | osascript 命令注入修复 | `crates/services/src/services/notification.rs:111-120` | 改用 `notify-rust` crate |
| S6 | aimax filename 验证 | `src-tauri/src/commands/skills.rs:206-218` | 添加白名单校验 |

---

### 阶段二：零成本清理（30 分钟）

无功能变更，纯清理操作。

| # | 任务 | 操作 |
|---|------|------|
| C1 | 移除 `@ibm/plex` devDep | `pnpm remove @ibm/plex` -- 节省 ~30MB |
| C2 | 移除 `@tailwindcss/container-queries` | `pnpm remove` + 清理 Tailwind 配置 |
| C3 | 修正 `@rjsf/*` 分类 | devDep -> dependencies |
| C4 | 移动 tailwind 插件到 devDep | `tailwind-scrollbar`、`tailwindcss-animate` |
| C5 | 清理 New Design 残留 | 删除 `tailwind.new.config.js`；更新 `components.json`；清理文档引用 |
| C6 | 重命名 `useConversationHistoryOld.ts` | -> `useConversationHistory.ts` |

---

### 阶段三：主题适配 Bug 修复（1-2 小时）

#### 3.1 conversation.css 亮色模式 Bug

```css
/* 修复前 (第498行) */
.conv-assistant-msg .ProseMirror pre {
  background: #1e1e2e !important;
}

/* 修复后 -- 使用 CSS 变量 */
.conv-assistant-msg .ProseMirror pre {
  background: var(--conv-code-bg) !important;
}
```

#### 3.2 file-tree.css 添加暗色/亮色支持

为约 15 个 token 类型颜色和 Git 状态颜色添加 `.dark` 变体：

```css
/* 亮色模式（默认） */
.file-tree-token-keyword { color: #cf222e; }
/* 暗色模式 */
.dark .file-tree-token-keyword { color: #ff7b72; }
```

#### 3.3 ProjectTasks.tsx 硬编码颜色

```tsx
/* 修复前 */
style={{ backgroundColor: '#FCFCFC' }}
/* 修复后 */
className="bg-background"
```

---

### 阶段四：代码质量优化（3-4 小时）

#### 4.1 空 catch 块清理（101 处）

按优先级分批处理：
1. 关键路径（Git 操作、文件操作）-- 添加用户可见的 toast 错误提示
2. 防御性编程（dockview 操作）-- 添加 `// expected: dockview may throw during reconstruction` 注释
3. 其余 -- 至少添加 `console.error` 日志

#### 4.2 Rust unwrap() 替换（7+ 处）

替换为 `unwrap_or_else`/`ok_or`/`?` 操作符，返回 `anyhow::Result`。

#### 4.3 提取魔法数字

**文件**: `IDELayout.tsx`

```typescript
const LAYOUT = {
  LEFT_PANEL_DEFAULT_WIDTH: 220,
  LEFT_PANEL_MIN_WIDTH: 200,
  LAYOUT_RETRY_COUNT: 15,
  LAYOUT_SETTLE_DELAY_MS: 100,
} as const;
```

#### 4.4 修复 pushError 语义

**文件**: `useGitCommit.ts` -- 重命名为 `operationError`，或为 pull/fetch 提供独立错误状态。

#### 4.5 合并 usePush + useForcePush

合并为 `usePushOperation(force: boolean)` hook。

---

### 阶段五：性能优化（4-6 小时）

#### 5.1 [P0] 文件树虚拟滚动

**文件**: `FileTreePanel.tsx`

使用 react-virtuoso 扁平化为虚拟滚动列表，通过缩进层级模拟树结构（VS Code 模式）。

#### 5.2 [P0] 对话历史虚拟滚动

**文件**: `DisplayConversationEntry.tsx`

使用 react-virtuoso 的动态高度虚拟化。

#### 5.3 [P1] scroll 事件节流

**文件**: `GitDiffViewer.tsx:83-103`

替换为 `IntersectionObserver`（参考 `DockviewDiffsReviewPanel.tsx:184` 的实现）。

#### 5.4 [P1] N+1 查询修复

- `agent_setting.rs:92` -- 使用事务批处理 reorder
- `image.rs:186` -- 使用事务包裹批量 INSERT

#### 5.5 [P2] 异步并行化

对独立的数据库查询使用 `tokio::join!` 并行执行，而非串行 await。

#### 5.6 [P2] localStorage 序列化优化

将防抖延时从 100ms 增加到 300-500ms，或使用 `requestIdleCallback`。

#### 5.7 提取 useTemporaryFlag hook

统一 10+ 处 `setTimeout(() => setXxxSuccess(false), 2000)` 模式。

---

### 阶段六：依赖缩减（2-3 小时）

#### 6.1 统一图标库

移除 `@phosphor-icons/react`（修改 3 文件）和 `developer-icons`（修改 1 文件），统一到 `lucide-react`。节省 **~500KB+**。

#### 6.2 移除 CodeMirror 全套

移除 `@uiw/react-codemirror` + 4 个 `@codemirror/*` 包，`json-editor.tsx` 改用 Monaco。节省 **~300KB**。

#### 6.3 Rust workspace 依赖统一

在根 `Cargo.toml` 的 `[workspace.dependencies]` 中添加：

```toml
[workspace.dependencies]
sqlx = { version = "0.8", default-features = false }
dirs = "5"
command-group = { version = "5.0", features = ["with-tokio"] }
strum = "0.27.2"
strum_macros = "0.27.2"
json-patch = "2.0"
tempfile = "3"
regex = "1"
tokio-util = "0.7"
tokio-stream = "0.1"
```

各 crate 改为 `sqlx.workspace = true`，按需追加 features。

#### 6.4 统一目录路径库

评估 `dirs` vs `directories` vs `xdg`，统一为一个。

---

### 阶段七：大文件拆分（长期，按需执行）

#### 7.1 Rust 大文件

| 文件 | 行数 | 拆分方案 |
|------|------|----------|
| `git/src/lib.rs` | 2776 | `branch.rs` + `diff.rs` + `worktree.rs` + `rebase.rs` + `remote.rs` + `log.rs` |
| `executors/claude.rs` | 2723 | `normalize.rs` + `protocol.rs` + `tool_handler.rs`；测试移至 `tests/` |
| `local-deployment/container.rs` | 1467 | `container_lifecycle.rs` + `container_config.rs` |
| `executors/opencode/sdk.rs` | 1463 | 拆分 SDK 连接层和消息处理层 |
| `services/container.rs` | 1426 | 拆分服务注册与服务编排 |
| `git/src/cli.rs` | 1263 | 按 Git 子命令拆分 |

#### 7.2 前端大文件

| 文件 | 行数 | 拆分方案 |
|------|------|----------|
| `api.ts` | 1367 | `api/attempts.ts` + `api/repos.ts` + `api/git.ts` + `api/config.ts` + `api/sessions.ts` |
| `FileTreePanel.tsx` | 1359 | `FileTreeItem.tsx` + `FileTreeContextMenu.tsx` + `useFileTree.ts` + `fileTreeUtils.ts` |
| `DisplayConversationEntry.tsx` | 1205 | `entries/AssistantMessage.tsx` + `ToolCallCard.tsx` + `ThinkingBlock.tsx` |
| `IDELayout.tsx` | 971 | `dockviewLayoutUtils.ts` + `dockviewEventHandlers.ts` + `dockview-ayu.css`(提取内联) |

#### 7.3 CSS 大文件

| 文件 | 行数 | 拆分方案 |
|------|------|----------|
| `file-tree.css` | 1094 | `file-tree-base.css` + `file-tree-syntax.css` + `file-tree-git.css` |
| `conversation.css` | 1024 | `conv-base.css` + `conv-messages.css` + `conv-tools.css` + `conv-markdown.css` + `conv-syntax.css` |
| `diff-style-overrides.css` | 989 | `diff-layout.css` + `diff-widgets.css` + `diff-syntax-light.css` + `diff-syntax-dark.css` |

---

### 阶段八：主题系统统一（长期）

1. 确认并删除 New Design 系统残留
2. 将 `conversation.css` 的颜色变量迁移到 Legacy Design 体系
3. 将 `file-tree.css` 添加完整的暗色/亮色支持
4. 统一暗色切换方式为 `.dark` class（消除 `data-theme='dark'`）
5. 将所有组件硬编码颜色迁移为语义化 CSS 变量
6. 消减 `conversation.css` 中 41 处 `!important`

---

## 优先级总览

| 阶段 | 优先级 | 预估时间 | 风险 | 核心收益 |
|------|--------|----------|------|----------|
| 一 | P0 | 1-2h | 低 | 修复 6 个安全漏洞 |
| 二 | P0 | 30min | 极低 | 清理冗余，节省 30MB |
| 三 | P1 | 1-2h | 低 | 修复亮色模式视觉 bug |
| 四 | P1 | 3-4h | 低 | 修复 101 处空 catch + 7 处 unwrap |
| 五 | P1 | 4-6h | 中 | 虚拟滚动 + N+1 修复 |
| 六 | P2 | 2-3h | 低 | 减少 ~1MB bundle + Rust 依赖统一 |
| 七 | P3 | 按需 | 中 | 文件组织优化 |
| 八 | P3 | 按需 | 中 | 主题一致性 |
