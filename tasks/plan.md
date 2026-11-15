# Plan: Worktree 创建与分发重构

## Build Order

`existing-workspace-restrict` → `standalone-worktree-create` → `issue-pr-worktree-source`

每个 module 内部按 **后端 → 类型生成 → 前端** 的顺序执行。

---

## Module 1: existing-workspace-restrict

### Task 1.1: 新增 `groupOptionsByWorkspace` 函数

**文件**: `frontend/src/lib/workspaceBranchOptions.ts`

在 `WorkspaceBranchOption` 接口旁新增分组函数：

```typescript
export interface WorkspaceBranchGroup {
  workspace: Workspace | null;   // null = 默认目录
  workspaceId: string | null;
  useWorktree: boolean;
  label: string;
  entries: WorkspaceBranchOption[];
}

export function groupOptionsByWorkspace(
  options: WorkspaceBranchOption[]
): WorkspaceBranchGroup[]
```

逻辑：遍历 options，按 `existingWorkspaceId` 分组；无 workspace 的纯分支归入"默认目录"组（但后续会被过滤）。

**测试**: `workspaceBranchOptions.test.ts` — 新增分组测试

### Task 1.2: 改造 `WorkspaceSelector` 支持分组渲染

**文件**: `frontend/src/components/sessions/WorkspaceSelector.tsx`

新增 `grouped` prop（boolean），当为 true 时：
- 每个 `WorkspaceBranchGroup` 渲染为一个子菜单（`DropdownMenuSub`）
- 一级显示 workspace label（"默认目录"或 workspace name）
- 二级显示该组内的 branch 条目
- 保留 `DropdownMenuRadioGroup` 的选中状态

**注意**: 不修改现有的非分组渲染路径（`grouped=false`），确保向后兼容。

### Task 1.3: 修改 `SessionCreationForm` 的分支选择逻辑

**文件**: `frontend/src/components/sessions/SessionCreationForm.tsx`

改动点：
1. `mode === 'existing_workspace'` 时，传入 `WorkspaceSelector` 的 `options` 过滤为只有 `existingWorkspaceId !== null` 的选项（即已有 workspace 的选项）。同时设置 `grouped=false`（保持平铺列表）。
2. `mode === 'new_workspace'` 时，`RepoBranchSelector` 替换为分组模式的 `WorkspaceSelector`（`grouped=true`），展示 `workspace → branch` 二级结构。

**关键逻辑**: 选中 `branch:xxx` value 时，后端仍需走 `ensure_root_workspace`（创建 project-root workspace + checkout）。但因为我们现在只在 `new_workspace` 模式展示分支，且 `new_workspace` 模式走 `create_workspace`（worktree 模式），所以不会触发主目录 checkout。

**需要确认**: `new_workspace` 模式选择分支时，当前 `RepoBranchSelector` 的 `onBranchChange` 传入 `repos` 的 `target_branch`，这些 repos 最终通过 `create_workspace` 创建 worktree。**这个路径已经是 worktree 创建，不涉及主目录切换。** 所以实际上只需要在 `existing_workspace` 模式过滤掉纯分支选项即可。

重新梳理：
- `existing_workspace` 模式 → `WorkspaceSelector` 只显示 `existingWorkspaceId !== null` 的选项
- `new_workspace` 模式 → 保持现有 `RepoBranchSelector` 不变（它已经是 worktree 创建路径）
- 但用户期望看到"二级菜单结构"→ 这意味着 `new_workspace` 模式的 `RepoBranchSelector` 也需要改造为按 workspace 分组的二级结构

**最终方案**:
- `existing_workspace` 模式：`WorkspaceSelector` 只显示已有 workspace（过滤纯分支）
- `new_workspace` 模式：新建 `GroupedRepoBranchSelector` 组件，按 workspace 分组显示可用分支。每个 workspace 组下列出可以基于其创建的分支。选择后 value 格式仍为 repo+branch，走现有 `create_workspace` 路径。

### Task 1.4: 更新 i18n

**文件**: `frontend/src/i18n/locales/en/tasks.json`, `zh-CN/tasks.json`

新增文案 key：
- `workspaceSelector.defaultDirectory` / `默认目录`
- `workspaceSelector.groupLabel` / `{name} 的工作区`

### Task 1.5: 验证

- `pnpm --filter ./frontend exec vitest run src/components/sessions/`
- `pnpm --filter ./frontend run check`
- `pnpm --filter ./frontend run lint`

---

## Module 2: standalone-worktree-create

### Task 2.1: 后端 — 新增 `worktree_add_sparse` CLI 方法

**文件**: `crates/git/src/cli.rs`

```rust
pub fn worktree_add_sparse(
    &self,
    repo_path: &Path,
    worktree_path: &Path,
    branch: &str,
    start_point: &str,
    sparse_dirs: &[String],
) -> Result<(), GitCliError>
```

执行步骤：
1. `git worktree add --no-checkout -b <branch> <path> <start_point>`
2. `git -C <worktree_path> sparse-checkout init --cone`
3. `git -C <worktree_path> sparse-checkout set <dirs...>`
4. `git -C <worktree_path> checkout`

**测试**: `cli.rs` 内新增 test

### Task 2.2: 后端 — `WorktreeManager::create_worktree` 支持 sparse_dirs

**文件**: `crates/services/src/services/worktree_manager.rs`

`create_worktree` 新增参数 `sparse_dirs: Option<&[String]>`，当非 None 时调用 `GitCli::worktree_add_sparse` 而非 `worktree_add`。

同步更新 `WorkspaceManager::create_workspace` 透传 sparse_dirs。

### Task 2.3: 后端 — 新增 `WorkspaceCreateStandalone` domain command

**文件**:
- `crates/application/src/domain.rs` — 新增 `WorkspaceCreateStandalone => "create_workspace_standalone" / "application.call"`
- `crates/server/src/host_ops/mod.rs` — 新增 handler
- `crates/server/src/host_ops/workspace_creation.rs` — 新增 `create_standalone_workspace()` 函数

`create_standalone_workspace` 逻辑：
1. 解析参数：`project_id`, `branch_name`, `parent_workspace_id?`, `name?`, `create_command?`, `run_setup_command: bool`, `sparse_checkout_directories?`
2. 查找项目 repos（取第一个作为 primary repo）
3. 生成 branch name（使用 `git_branch_from_workspace` 或直接用传入的 `branch_name`）
4. 创建 `Task`（轻量级，title = `name ?? branch_name`）
5. 创建 `Workspace`（`use_worktree: true`, `branch = branch_name`, `parent_workspace_id`）
6. 创建 `WorkspaceRepo`
7. 调用 `prepare_workspace()` → worktree 创建
8. 如果 `create_command` 非空且 `run_setup_command`，调用 `run_project_workspace_create_command`
9. 返回 `Workspace`

### Task 2.4: 类型生成

**命令**: `pnpm run generate-types`

在 `src-tauri/src/bin/generate_types.rs` 中注册新类型：
- `CreateStandaloneWorkspaceRequest`
- `CreateStandaloneWorkspaceResponse`（或直接用 `Workspace`）

### Task 2.5: 前端 — 新增 API 方法

**文件**: `frontend/src/lib/api/attempts.ts`

```typescript
createStandaloneWorkspace: (data: CreateStandaloneWorkspaceRequest) => Promise<Workspace>
```

### Task 2.6: 前端 — `WorkspaceSessionListToolbar` 新增菜单项

**文件**: `frontend/src/components/workspace-session-list/WorkspaceSessionListToolbar.tsx`

在"更多选项"下拉菜单的 `DropdownMenuSeparator` 之后（"打开归档区"之前），新增：

```tsx
<DropdownMenuItem onSelect={onCreateWorktree}>
  <FolderGit2 className="h-4 w-4" />
  <span>{t('workspaceSessionList.createWorktree', '创建 Worktree')}</span>
</DropdownMenuItem>
```

新增 `onCreateWorktree` prop 传入组件。

### Task 2.7: 前端 — `WorktreeCreationDialog` 组件

**新建文件**: `frontend/src/components/dialogs/WorktreeCreationDialog.tsx`

组件结构：
- 使用 shadcn `Dialog` + `DialogOverlay` + `DialogContent`
- 通过 `useLayoutStore(state => state.activeTab)` 判断 Tab/Canvas 模式
- Tab 模式：Dialog 全屏覆盖 B 区（`max-w-2xl mx-auto`）
- Canvas 模式：Dialog 定位到 B 区左侧居中（通过 CSS `position: fixed; left: 1rem; top: 50%; transform: translateY(-50%)`）
- 内部复用 `SessionCreationForm` 的部分控件模式，但表单字段不同

表单字段实现：
1. **分支名称** — `Input`，必填，支持自动生成（基于备注 slugify）
2. **父工作树** — `Select`，数据源为 `useProjectWorktrees(projectId)` 的 worktree workspace 列表，第一项为"无父工作树"
3. **备注** — `Input`，可选
4. **设置脚本** — `Textarea` + Switch 控制是否运行
5. **等待设置完成后再启动智能体** — Switch（暂不连接后端，仅 UI）
6. **稀疏检出** — `Select`（完整检出 / 自定义目录），选择"自定义目录"时展开 `Textarea`（每行一个路径）

表单提交调用 `attemptsApi.createStandaloneWorkspace()`，成功后关闭 Dialog 并刷新 workspace 列表。

### Task 2.8: 前端 — 集成到 Toolbar 和 Layout

**文件**: 
- `frontend/src/components/workspace-session-list/WorkspaceSessionList.tsx` — 传递 `onCreateWorktree` callback 到 Toolbar
- `frontend/src/components/layout/IDELayout.tsx` 或对应容器 — 管理 Dialog 的 open 状态

通过 URL search param `?newWorktree=1` 或 React state 控制 Dialog 开关。

### Task 2.9: 前端 — i18n

**文件**: `frontend/src/i18n/locales/en/tasks.json`, `zh-CN/tasks.json`, `en/panels.json`, `zh-CN/panels.json`

新增文案 key（参考 Orca 截图的中文）：
- `worktreeCreation.branchName` / `分支名称`
- `worktreeCreation.parentWorktree` / `父工作树`
- `worktreeCreation.noParent` / `无父工作树`
- `worktreeCreation.parentHint` / `在侧边栏中将此工作区嵌套到另一个工作区下。不会更改基础分支。`
- `worktreeCreation.notes` / `备注`
- `worktreeCreation.setupScript` / `设置脚本`
- `worktreeCreation.localSettings` / `本地设置`
- `worktreeCreation.runSetupCommand` / `运行设置命令`
- `worktreeCreation.waitSetupBeforeAgent` / `等待设置完成后再启动智能体`
- `worktreeCreation.sparseCheckout` / `稀疏检出`
- `worktreeCreation.fullCheckout` / `完整检出`
- `worktreeCreation.customCheckout` / `自定义目录`
- `worktreeCreation.customCheckoutHint` / `每行输入一个目录路径`
- `worktreeCreation.submit` / `创建工作树`
- `worktreeCreation.submitting` / `创建中…`

### Task 2.10: 测试

- **前端**: 新建 `WorktreeCreationDialog.test.tsx`
  - 渲染所有字段
  - 稀疏检出切换显示/隐藏目录输入
  - 提交调用 `createStandaloneWorkspace`
  - Tab/Canvas 模式定位
- **后端**: `worktree_manager_tests.rs` — 新增 sparse worktree 创建测试
- **类型**: `pnpm run generate-types:check`

---

## Module 3: issue-pr-worktree-source

### Task 3.1: 后端 — 扩展 `GhCli`

**文件**: `crates/services/src/services/git_host/github/cli.rs`

新增/扩展方法：
1. `is_gh_available_and_authenticated(worktree_path: &Path) -> Result<bool, GhCliError>` — 运行 `gh auth status` 检测
2. `view_issue(number: u64, owner: &str, repo: &str) -> Result<GitHubIssueInfo, GhCliError>` — `gh issue view <number> --repo <owner>/<repo> --json number,title,url,state,createdAt,author,labels,body`
3. `list_open_prs(owner: &str, repo: &str) -> Result<Vec<PullRequestInfo>, GhCliError>` — 已有 `list_prs_for_branch` 但需要按 repo 列出所有 open PRs。新增 `list_prs` 方法。

新增类型（如不存在）：
- `GitHubIssueInfo` 已有（在 `cli.rs` 中），确认包含 `title` 字段

### Task 3.2: 后端 — 新增 domain commands

**文件**: `crates/application/src/domain.rs`

```rust
GhAuthStatus => "get_gh_auth_status" / "application.call",
GhListIssues => "list_gh_issues" / "application.call",
GhListPrs => "list_gh_prs" / "application.call",
```

**文件**: `crates/server/src/host_ops/mod.rs` — 新增 handlers

每个 handler 逻辑：
1. 解析 `project_id` 或 `repo_id`
2. 获取 repo 的 remote URL → 解析 owner/repo
3. 调用对应的 `GhCli` 方法
4. 返回结果

### Task 3.3: 类型生成

**命令**: `pnpm run generate-types`

注册：
- `GhAuthStatus` (`available: bool, authenticated: bool, error: Option<String>`)
- `GhIssueSummary` (`number: u32, title: String, url: String, state: String, author: Option<String>`)
- `GhPrSummary` (`number: u32, title: String, url: String, head_branch: String, base_branch: String, state: String`)

### Task 3.4: 前端 — gh auth status hook

**新建文件**: `frontend/src/features/gh/useGhAuthStatus.ts`

```typescript
export function useGhAuthStatus(projectId: string | null) {
  return useQuery({
    queryKey: ['ghAuthStatus', projectId],
    queryFn: () => backendCall<GhAuthStatus>('get_gh_auth_status', { projectId }),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}
```

### Task 3.5: 前端 — `GhIssueSelector` 组件

**新建文件**: `frontend/src/components/gh/GhIssueSelector.tsx`

- 调用 `list_gh_issues` 获取 open issues
- 搜索/过滤 UI（可选，初始版本只列出前 50 条）
- 选中 issue 后返回 `{ number, title, url, branch_suggestion: `issue/${number}-${slugify(title)}` }`

### Task 3.6: 前端 — `GhPrSelector` 组件

**新建文件**: `frontend/src/components/gh/GhPrSelector.tsx`

- 调用 `list_gh_prs` 获取 open PRs
- 选中 PR 后返回 `{ number, title, head_branch, base_branch, url }`

### Task 3.7: 前端 — 修改 `WorktreeCreationDialog` 支持创建源切换

**文件**: `frontend/src/components/dialogs/WorktreeCreationDialog.tsx`

在表单顶部（分支名称字段之上）新增创建源选择器（SegmentedControl 或 RadioGroup）：
1. **分支**（默认）— 显示现有的分支名称 Input
2. **GitHub Issue** — 显示 `GhIssueSelector`，选中后自动填充分支名称和备注
3. **GitHub Pull Request** — 显示 `GhPrSelector`，选中后自动填充分支名称，提交时走 `create_workspace_from_pr` 路径

**可见性**：通过 `useGhAuthStatus` 判断，仅 `available && authenticated` 时显示 Issue/PR 选项。

**提交逻辑**：
- 分支模式 → `createStandaloneWorkspace`
- Issue 模式 → `createStandaloneWorkspace`（branch_name 为 `issue/<number>-<slug>`）
- PR 模式 → 复用已有的 `createWorkspaceFromPr` API

### Task 3.8: 前端 — API 方法

**文件**: `frontend/src/lib/api/attempts.ts`

```typescript
getGhAuthStatus: (projectId: string) => Promise<GhAuthStatus>
listGhIssues: (projectId: string) => Promise<GhIssueSummary[]>
listGhPrs: (projectId: string) => Promise<GhPrSummary[]>
```

### Task 3.9: 测试

- **前端**: `GhIssueSelector.test.tsx`, `GhPrSelector.test.tsx`, `useGhAuthStatus.test.ts`
  - Mock gh 未安装/未认证时不显示选项
  - Mock gh 已认证时显示选项
  - 选中 Issue/PR 后正确填充表单字段
- **后端**: `github/cli.rs` tests — issue view, auth status
- **类型**: `pnpm run generate-types:check`

---

## Verification Order

1. Module 1 → `pnpm test + cargo check`
2. Module 2 → `pnpm test + cargo test + generate-types:check + clippy`
3. Module 3 → `pnpm test + cargo test + generate-types:check + clippy`
4. 全量 → `pnpm run check + pnpm run lint`
