# Git 面板增强计划

> 基于 mossx Git 模块的深度审计，制定 VibeUltra Git 面板功能对齐与增强路线图。
> 本计划是 `improvement-plan.md` Phase 2.4（Git 历史可视化）的细化扩展。

---

## 现状总结

### 已实现

| 功能 | 状态 |
|------|------|
| Staged/Unstaged 分区文件列表 | 完成 |
| 单文件 Stage/Unstage/Revert | 完成 |
| 批量 Stage All / Revert All | 完成 |
| Commit 消息输入 + Commit/Commit&Push 按钮 | 完成 |
| Push 按钮（含 ahead 计数） | 完成 |
| Diff 查看器（虚拟滚动 + Split/Unified） | 完成 |
| 提交日志视图（100 条 + ahead/behind） | 完成 |
| 文件状态徽标（A/M/D/R/U） | 完成 |
| 行级 +/- 统计 | 完成 |
| 图片 Diff 特殊处理 | 完成 |
| 自适应轮询 | 完成 |

### 后端已有但前端未用

| 后端命令 | 功能 | 前端状态 |
|----------|------|----------|
| `get_repo_branches` | 获取分支列表 | API 已封装，前端未调用 |
| `get_repo_remotes` | 获取远端列表 | API 已封装，前端未调用 |
| `get_workspace_commit_graph` | 提交图谱（两分支对比） | 前端未调用 |
| `get_workspace_commit_history` | 提交历史 | 前端未调用 |
| `rebase_workspace` | Rebase 操作 | 前端未调用 |
| `merge_workspace` | 合并操作 | 前端未调用 |
| `rename_workspace_branch` | 重命名分支 | 前端未调用 |
| `create_workspace_pr` | 创建 PR（gh CLI） | 前端未调用 |
| `list_open_prs` | 列出开放 PR | 前端未调用 |

---

## Phase 划分

### Phase G1 — Git 面板核心增强（高优先级）

> 目标：补齐用户明确要求的 4 项核心功能。
> 预估：3-5 个工作日

#### G1.1 Pull/Fetch 操作

**缺失**：当前只有 Push，无 Pull/Fetch。

**后端新增**：
- `crates/git/src/lib.rs` 新增方法：
  - `pull_from_remote(branch, remote)` — `git pull --ff-only`（默认快进合并）
  - `fetch_remote(remote)` — `git fetch`
- `src-tauri/src/commands/workspaces.rs` 新增命令：
  - `pull_workspace_branch` — 调用 `pull_from_remote`
  - `fetch_workspace` — 调用 `fetch_remote`
- `crates/api-types/` 新增响应类型：
  - `PullResult { updated: bool, new_commits: u32, conflicts: Vec<String> }`

**前端修改**：
- `frontend/src/lib/api.ts` — 新增 `pullBranch()`、`fetchRemote()`
- `frontend/src/hooks/git/useGitActions.ts` — 新增 `onPull`、`onFetch` 操作
- `frontend/src/components/panels/git/GitPanel.tsx` — 工具栏新增：
  - Pull 按钮（Download 图标）— 当 `commitsBehind > 0` 时高亮显示 behind 数量
  - Fetch 按钮（RefreshCw 图标）— 获取远端最新状态
  - Sync 按钮（ArrowUpDown 图标）— Pull + Push 一键同步（可选）

**参考**：mossx `GitDiffPanel.tsx` Push/Pull/Sync 按钮区。

---

#### G1.2 分支管理

**缺失**：无法查看/切换/创建分支。

**后端利用**：`get_repo_branches` 命令已存在。

**后端新增**：
- `src-tauri/src/commands/repos.rs` 或 `workspaces.rs` 新增：
  - `checkout_branch { repo_path, branch_name }` — `git checkout <branch>`
  - `create_branch { repo_path, branch_name, from_ref? }` — `git checkout -b <name> [from]`
  - `delete_branch { repo_path, branch_name, force }` — `git branch -d/-D`

**前端新增**：
- `frontend/src/hooks/git/useGitBranches.ts` — 新 Hook：
  ```typescript
  interface UseGitBranches {
    branches: Branch[]
    currentBranch: string
    checkoutBranch: (name: string) => Promise<void>
    createBranch: (name: string) => Promise<void>
    deleteBranch: (name: string, force?: boolean) => Promise<void>
    refreshBranches: () => void
    isLoading: boolean
  }
  ```
- `frontend/src/components/panels/git/GitBranchList.tsx` — 分支列表组件：
  - 本地分支 / 远端分支分组展示
  - 当前分支高亮标记（星号或粗体）
  - 点击切换分支
  - 右上角「+」按钮创建新分支
  - 每个分支行悬停显示操作按钮（checkout / delete）
  - 排序：按最近提交时间降序（利用 `last_commit_date`）
- `GitPanel.tsx` 面板模式新增 `branches` Tab

**参考**：mossx `useGitBranches.ts`。

---

#### G1.3 提交日志增强

**缺失**：Log 视图缺少 To Push/To Pull 分区和右键操作。

**前端修改**：
- `frontend/src/components/panels/git/GitLogView.tsx` — 增强：
  1. **三分区布局**：
     - "To Push"（`commitsAhead > 0` 时显示）— 待推送提交列表
     - "To Pull"（`commitsBehind > 0` 时显示）— 待拉取提交列表
     - "Recent Commits" — 全部提交历史
  2. **右键上下文菜单**（Tauri 原生菜单）：
     - `Copy SHA` — 复制完整 SHA 到剪贴板
     - `Open on GitHub` — 如有 remote URL，打开 `{githubUrl}/commit/{sha}`
  3. **提交详情展开**：
     - 点击提交行展开显示该提交的文件变更列表
     - 显示每个文件的 +/- 统计
     - 点击文件可在 Diff 查看器中预览

**后端利用**：
- `get_workspace_git_log` 已返回 `ahead_entries` / `behind_entries`，前端只需分区渲染
- `get_workspace_commit_history` 已存在，可用于获取详细提交信息

**参考**：mossx `GitLogEntryRow` + 右键菜单。

---

#### G1.4 Flat/Tree 视图切换

**缺失**：文件列表仅有扁平列表，无目录树视图。

**前端新增**：
- `frontend/src/components/panels/git/GitFileTree.tsx` — 目录树组件：
  - `buildDiffTree(files)` — 将扁平文件列表构建为树结构
  - 文件夹节点可折叠/展开（ChevronRight/ChevronDown）
  - 缩进：10px/层
  - 每个文件夹显示包含的变更文件数量
  - 文件节点复用 `GitFileRow` 的操作按钮
- `frontend/src/components/panels/git/GitStagingArea.tsx` — 修改：
  - 顶部新增 Flat/Tree 切换按钮（LayoutGrid / FolderTree 图标）
  - 状态持久化到 `useLayoutStore`
  - 快捷键：`Alt+Shift+V` 切换

**参考**：mossx `DiffTreeSection` + `buildDiffTree`。

---

### Phase G2 — 交互体验增强（中优先级）

> 目标：对齐 mossx 的交互细节，提升操作效率。
> 预估：2-3 个工作日

#### G2.1 丢弃确认弹窗

**缺失**：Revert/Discard 操作无确认，可能导致误操作。

**前端新增**：
- `frontend/src/components/panels/git/GitDiscardDialog.tsx`：
  - 警告文字："此操作不可逆"
  - 受影响文件列表（`<code>` 标签）
  - Cancel / Confirm 按钮
  - 提交中禁用按钮 + loading 状态
- 修改 `GitStagingArea.tsx`：Revert 单文件 / Revert All 触发弹窗

**参考**：mossx `diff-danger-dialog`。

---

#### G2.2 Commit 区域折叠

**缺失**：Commit 框始终显示，占用面板空间。

**前端修改**：
- `GitPanel.tsx` 或 `GitCommitBox.tsx`：
  - 添加折叠/展开按钮（ChevronsUpDown / ChevronsDownUp）
  - 默认展开，折叠时仅显示一行提示
  - 状态持久化

---

#### G2.3 文件预览模态框

**缺失**：无法全屏查看单文件 Diff。

**前端新增**：
- `frontend/src/components/panels/git/GitDiffModal.tsx`：
  - 双击 `GitFileRow` 触发
  - Portal 到 `document.body`
  - 文件状态 + 路径 + +/-统计 标题栏
  - 最大化/还原按钮
  - 关闭按钮 + ESC 快捷键
  - 内嵌完整 `GitDiffViewer`（支持 split/unified 切换）

**参考**：mossx `git-history-diff-modal`。

---

#### G2.4 多文件选择

**缺失**：只能单个操作文件，无法批量选中。

**前端修改**：
- `GitStagingArea.tsx` 新增选中状态管理：
  - 单击：选中单文件
  - `Ctrl/Cmd + Click`：追加/移除选中
  - `Shift + Click`：范围选中
- 选中文件高亮样式
- 批量操作：选中多个文件后一键 Stage/Unstage/Discard

---

#### G2.5 右键上下文菜单（文件列表）

**缺失**：文件列表无右键菜单。

**前端新增**：
- 使用 Tauri 原生菜单 API（`@tauri-apps/plugin-menu`）
- 菜单项根据文件状态动态生成：
  - Staged 文件：`Unstage file(s) (N)`
  - Unstaged 文件：`Stage file(s) (N)` / `Discard change(s) (N)`
- 多选时显示操作数量

**参考**：mossx 右键菜单实现。

---

### Phase G3 — Diff 查看器增强（中优先级）

> 目标：提升 Diff 阅读体验，对齐 mossx 的高级浏览功能。
> 预估：2-3 个工作日

#### G3.1 Sticky 文件头

**缺失**：滚动 Diff 时不知道当前查看的是哪个文件。

**前端修改**：
- `GitDiffViewer.tsx`：
  - 滚动时通过 `IntersectionObserver` 或 `scrollTop` 计算当前可见文件
  - 顶部固定显示当前文件路径 + 状态 + +/-统计
  - 平滑切换动画

**参考**：mossx Sticky 文件头实现。

---

#### G3.2 Change Anchor 导航

**缺失**：在长 Diff 中无法快速跳转到变更位置。

**前端新增**：
- `GitDiffViewer.tsx` 工具栏新增：
  - 上一个变更（ChevronUp）/ 下一个变更（ChevronDown）按钮
  - 当前位置 `N/M` 显示
  - 扫描 `[data-line-type="change-*"]` DOM 元素定位
  - `scrollIntoView({ behavior: "smooth", block: "center" })`

**参考**：mossx Change Anchors 实现。

---

#### G3.3 Full Diff 模式

**缺失**：只能看变更上下文，无法查看完整文件内容。

**后端新增**：
- `crates/git/src/lib.rs` 新增：
  - `get_file_full_diff(repo_path, file_path)` — 生成完整文件 Diff（所有行）
- `src-tauri/src/commands/workspaces.rs` 新增命令：
  - `get_workspace_file_full_diff`

**前端修改**：
- `GitDiffViewer.tsx` 新增内容模式切换：
  - `Focused` — 仅变更上下文（默认，当前行为）
  - `All Content` — 加载完整文件 Diff
  - 切换时显示加载状态

**参考**：mossx `contentMode` 实现。

---

### Phase G4 — GitHub 集成（低优先级）

> 目标：集成 GitHub Issues 和 PR 功能，与 AI 对话联动。
> 预估：5-7 个工作日
> 依赖：需要 GitHub Personal Access Token 配置机制

#### G4.1 GitHub Issues 模式

**前提**：新增 GitHub API 集成层。

**后端新增**：
- `crates/github/` 新 crate（或在 `crates/services/` 中新增模块）：
  - GitHub REST/GraphQL API 客户端
  - PAT Token 配置存储（加密存储在 SQLite 或系统 keychain）
  - `list_issues(owner, repo)` — 获取 open issues
  - `get_issue(owner, repo, number)` — 获取单个 issue 详情

**前端新增**：
- `GitPanel.tsx` 面板模式新增 `issues` Tab
- `frontend/src/components/panels/git/GitIssuesView.tsx`：
  - Issue 列表：`#{number}` + 标题 + 相对时间
  - 点击打开浏览器
  - 显示 open issue 总数
  - 加载/空/错误状态

**参考**：mossx `useGitHubIssues.ts` + Issues 模式。

---

#### G4.2 GitHub PRs 模式

**后端新增**：
- `crates/github/` 扩展：
  - `list_pull_requests(owner, repo)` — 获取 open PRs
  - `get_pr_diffs(owner, repo, number)` — 获取 PR Diff
  - `get_pr_comments(owner, repo, number)` — 获取 PR 评论

**前端新增**：
- `GitPanel.tsx` 面板模式新增 `prs` Tab
- `frontend/src/components/panels/git/GitPRsView.tsx`：
  - PR 列表：`#{number}` + 标题 + 作者 + Draft 标记 + 更新时间
  - 选中 PR 切换 Diff 查看器显示 PR Diff
  - PR 详情摘要（标题、描述、分支信息）
  - 评论时间线（Activity Timeline）
  - 右键菜单：`Open on GitHub`

**参考**：mossx PRs 模式 + `PullRequestSummary`。

---

#### G4.3 PR 智能对话（AI 联动）

**前端新增**：
- `frontend/src/hooks/git/usePullRequestComposer.ts`：
  - 选中 PR 时在 AI 输入框预填上下文
  - Send 按钮标签变为 "Ask PR"
  - 构建包含 PR 上下文的完整 prompt
  - 发送后自动创建新 Thread/Attempt

**参考**：mossx `usePullRequestComposer.ts` + `buildPullRequestPrompt`。

---

#### G4.4 AI 生成 Commit 消息

**后端利用**：可复用已有的 AI 执行器基础设施。

**前端修改**：
- `GitCommitBox.tsx`：
  - 新增 AI 生成按钮（Sparkles 图标）
  - 点击后：收集 staged diff → 调用 AI → 填入 commit 消息
  - 加载中显示旋转动画
  - 错误状态处理

---

## 实施顺序与依赖关系

```
Phase G1（核心）
  G1.1 Pull/Fetch  ← 独立，可首先实施
  G1.2 分支管理    ← 独立，可与 G1.1 并行
  G1.3 日志增强    ← 依赖 G1.1（Pull 后 behind 数据更准确）
  G1.4 Flat/Tree   ← 独立，可与 G1.1/G1.2 并行

Phase G2（交互）
  G2.1 丢弃确认    ← 独立
  G2.2 Commit折叠  ← 独立
  G2.3 预览模态    ← 独立
  G2.4 多文件选择  ← 独立
  G2.5 右键菜单    ← 依赖 G2.4（多选后批量操作）

Phase G3（Diff增强）
  G3.1 Sticky头    ← 独立
  G3.2 Anchor导航  ← 独立
  G3.3 Full Diff   ← 需后端新增命令

Phase G4（GitHub）
  G4.1 Issues      ← 需新建 GitHub API 集成层
  G4.2 PRs         ← 依赖 G4.1 的 API 层
  G4.3 PR 智能对话 ← 依赖 G4.2
  G4.4 AI Commit   ← 独立（但建议与 G4 一起做）
```

---

## 文件修改清单

### 新增文件

| 文件 | Phase | 用途 |
|------|-------|------|
| `frontend/src/hooks/git/useGitBranches.ts` | G1.2 | 分支管理 Hook |
| `frontend/src/components/panels/git/GitBranchList.tsx` | G1.2 | 分支列表组件 |
| `frontend/src/components/panels/git/GitFileTree.tsx` | G1.4 | 目录树视图组件 |
| `frontend/src/components/panels/git/GitDiscardDialog.tsx` | G2.1 | 丢弃确认弹窗 |
| `frontend/src/components/panels/git/GitDiffModal.tsx` | G2.3 | 文件预览模态框 |
| `crates/github/` (整个 crate) | G4.1 | GitHub API 集成 |
| `frontend/src/components/panels/git/GitIssuesView.tsx` | G4.1 | Issues 列表 |
| `frontend/src/components/panels/git/GitPRsView.tsx` | G4.2 | PR 列表与审查 |
| `frontend/src/hooks/git/usePullRequestComposer.ts` | G4.3 | PR AI 对话组合 |

### 修改文件

| 文件 | Phase | 修改内容 |
|------|-------|----------|
| `crates/git/src/lib.rs` | G1.1, G3.3 | 新增 pull/fetch/full-diff 方法 |
| `src-tauri/src/commands/workspaces.rs` | G1.1, G1.2, G3.3 | 新增 Tauri 命令 |
| `crates/api-types/src/*.rs` | G1.1 | 新增 PullResult 等类型 |
| `frontend/src/lib/api.ts` | G1.1, G1.2, G3.3 | 新增 API 封装 |
| `frontend/src/hooks/git/useGitActions.ts` | G1.1 | 新增 pull/fetch 操作 |
| `frontend/src/components/panels/git/GitPanel.tsx` | G1.1-G1.4, G2.2 | 工具栏、模式 Tab |
| `frontend/src/components/panels/git/GitLogView.tsx` | G1.3 | 三分区 + 右键菜单 |
| `frontend/src/components/panels/git/GitStagingArea.tsx` | G1.4, G2.1, G2.4, G2.5 | Tree 视图、多选、右键 |
| `frontend/src/components/panels/git/GitFileRow.tsx` | G2.3, G2.4 | 双击预览、选中状态 |
| `frontend/src/components/panels/git/GitDiffViewer.tsx` | G3.1, G3.2, G3.3 | Sticky头、导航、Full Diff |
| `frontend/src/components/panels/git/GitCommitBox.tsx` | G4.4 | AI 生成按钮 |
| `shared/types.ts` | G1.1 | 自动生成更新 |

---

## 验收标准

### Phase G1 完成标准
- [ ] 可以执行 Pull/Fetch 操作，按钮在有 behind 提交时高亮显示
- [ ] 可以查看所有分支列表，切换分支，创建新分支
- [ ] Log 视图按 To Push / To Pull / Recent 三区分列
- [ ] Log 提交行支持右键 Copy SHA / Open on GitHub
- [ ] 文件列表支持 Flat/Tree 两种视图模式切换

### Phase G2 完成标准
- [ ] Revert/Discard 操作弹出确认对话框
- [ ] Commit 区域可以折叠/展开
- [ ] 双击文件行打开全屏 Diff 预览
- [ ] 支持 Ctrl+Click 多选和 Shift+Click 范围选
- [ ] 文件列表支持右键上下文菜单

### Phase G3 完成标准
- [ ] 滚动 Diff 时顶部固定显示当前文件路径
- [ ] 可通过上/下按钮在变更位置之间跳转
- [ ] 可切换 Focused/All Content 两种 Diff 内容模式

### Phase G4 完成标准
- [ ] 可查看 GitHub Issues 列表并打开链接
- [ ] 可查看 GitHub PRs 列表、PR Diff 和评论
- [ ] 选中 PR 可触发 AI 对话并注入 PR 上下文
- [ ] 可通过 AI 自动生成 Commit 消息
