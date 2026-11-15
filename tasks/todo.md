# Tasks: Worktree 创建与分发重构

## Module 1: existing-workspace-restrict

- [ ] **Task 1.1**: 新增 `groupOptionsByWorkspace` 分组函数
  - Acceptance: `workspaceBranchOptions.ts` 导出 `groupOptionsByWorkspace()` 返回 `WorkspaceBranchGroup[]`
  - Verify: `workspaceBranchOptions.test.ts` 新增分组测试通过
  - Files: `frontend/src/lib/workspaceBranchOptions.ts`, `frontend/src/lib/workspaceBranchOptions.test.ts`

- [ ] **Task 1.2**: 改造 `WorkspaceSelector` 支持分组渲染模式
  - Acceptance: 新增 `grouped` prop，为 true 时渲染 `DropdownMenuSub` 二级结构
  - Verify: 现有 `WorkspaceSelector` 测试不回归
  - Files: `frontend/src/components/sessions/WorkspaceSelector.tsx`

- [ ] **Task 1.3**: 修改 `SessionCreationForm` 过滤现有工作区选项
  - Acceptance: `existing_workspace` 模式只显示 `existingWorkspaceId !== null` 的选项；不再出现纯分支
  - Verify: `SessionCreationForm.test.tsx` 验证过滤逻辑
  - Files: `frontend/src/components/sessions/SessionCreationForm.tsx`

- [ ] **Task 1.4**: 更新 i18n 文案
  - Acceptance: `en/tasks.json` + `zh-CN/tasks.json` 新增 `defaultDirectory` 和 `groupLabel`
  - Verify: 无硬编码中文/英文字符串
  - Files: `frontend/src/i18n/locales/en/tasks.json`, `frontend/src/i18n/locales/zh-CN/tasks.json`

- [ ] **Task 1.5**: Module 1 验证
  - Verify: `pnpm --filter ./frontend exec vitest run` + `pnpm --filter ./frontend run check` + `pnpm --filter ./frontend run lint`

## Module 2: standalone-worktree-create

- [ ] **Task 2.1**: 后端新增 `worktree_add_sparse` CLI 方法
  - Acceptance: `GitCli::worktree_add_sparse()` 执行 `add --no-checkout` + `sparse-checkout init --cone` + `set` + `checkout`
  - Verify: `cargo test -p git` 新增测试通过
  - Files: `crates/git/src/cli.rs`

- [ ] **Task 2.2**: `WorktreeManager::create_worktree` 支持 sparse_dirs
  - Acceptance: `create_worktree` 新增 `sparse_dirs` 参数，非 None 时走 sparse 路径
  - Verify: `cargo test -p services` 通过
  - Files: `crates/services/src/services/worktree_manager.rs`

- [ ] **Task 2.3**: 后端新增 `WorkspaceCreateStandalone` domain command + handler
  - Acceptance: `create_workspace_standalone` IPC 命令创建 Task + Workspace + WorkspaceRepo + 调用 prepare_workspace
  - Verify: `cargo clippy --features qa-mode -- -D warnings`
  - Files: `crates/application/src/domain.rs`, `crates/server/src/host_ops/mod.rs`, `crates/server/src/host_ops/workspace_creation.rs`

- [ ] **Task 2.4**: 类型生成
  - Acceptance: `shared/types.ts` 包含 `CreateStandaloneWorkspaceRequest`
  - Verify: `pnpm run generate-types:check`
  - Files: `src-tauri/src/bin/generate_types.rs`, `shared/types.ts` (自动生成), `shared/hostCommands.ts`

- [ ] **Task 2.5**: 前端新增 API 方法
  - Acceptance: `attemptsApi.createStandaloneWorkspace()` 调用后端命令
  - Files: `frontend/src/lib/api/attempts.ts`

- [ ] **Task 2.6**: Toolbar 新增"创建 Worktree"菜单项
  - Acceptance: "更多选项"下拉菜单中出现"创建 Worktree"
  - Verify: `WorkspaceSessionListToolbar.test.tsx` 新增测试
  - Files: `frontend/src/components/workspace-session-list/WorkspaceSessionListToolbar.tsx`

- [ ] **Task 2.7**: 新建 `WorktreeCreationDialog` 组件
  - Acceptance: Dialog 包含全部 7 个字段，稀疏检出选择"自定义目录"时展开目录输入
  - Verify: `WorktreeCreationDialog.test.tsx`
  - Files: `frontend/src/components/dialogs/WorktreeCreationDialog.tsx` (新建)

- [ ] **Task 2.8**: 集成 Dialog 到 Toolbar 和 Layout
  - Acceptance: 点击菜单项 → Dialog 弹出；Tab 模式全屏遮罩、Canvas 模式左侧居中
  - Files: `frontend/src/components/workspace-session-list/WorkspaceSessionList.tsx`, `frontend/src/stores/useLayoutStore.ts`

- [ ] **Task 2.9**: 更新 i18n 文案
  - Acceptance: 所有 WorktreeCreationDialog 字段文案国际化
  - Files: `frontend/src/i18n/locales/en/tasks.json`, `zh-CN/tasks.json`, `en/panels.json`, `zh-CN/panels.json`

- [ ] **Task 2.10**: Module 2 验证
  - Verify: `pnpm test` + `cargo test` + `pnpm run generate-types:check` + `pnpm run check` + `pnpm run lint`

## Module 3: issue-pr-worktree-source

- [ ] **Task 3.1**: 扩展 `GhCli` — auth status + view_issue + list_open_prs
  - Acceptance: `is_gh_available_and_authenticated()`, `view_issue()`, `list_open_prs()` 可用
  - Verify: `cargo test -p services` 新增测试
  - Files: `crates/services/src/services/git_host/github/cli.rs`

- [ ] **Task 3.2**: 后端新增 gh domain commands + handlers
  - Acceptance: `get_gh_auth_status`, `list_gh_issues`, `list_gh_prs` IPC 命令可用
  - Verify: `cargo clippy --features qa-mode -- -D warnings`
  - Files: `crates/application/src/domain.rs`, `crates/server/src/host_ops/mod.rs`, 新增 `crates/server/src/host_ops/gh_commands.rs`

- [ ] **Task 3.3**: 类型生成
  - Acceptance: `shared/types.ts` 包含 `GhAuthStatus`, `GhIssueSummary`, `GhPrSummary`
  - Verify: `pnpm run generate-types:check`
  - Files: `src-tauri/src/bin/generate_types.rs`, `shared/types.ts`, `shared/hostCommands.ts`

- [ ] **Task 3.4**: 前端 `useGhAuthStatus` hook
  - Acceptance: hook 返回 `{ available, authenticated, isLoading }`
  - Files: `frontend/src/features/gh/useGhAuthStatus.ts` (新建)

- [ ] **Task 3.5**: `GhIssueSelector` 组件
  - Acceptance: 列出 open issues，选中后返回 `{ number, title, branch_suggestion }`
  - Files: `frontend/src/components/gh/GhIssueSelector.tsx` (新建)

- [ ] **Task 3.6**: `GhPrSelector` 组件
  - Acceptance: 列出 open PRs，选中后返回 `{ number, head_branch, base_branch }`
  - Files: `frontend/src/components/gh/GhPrSelector.tsx` (新建)

- [ ] **Task 3.7**: `WorktreeCreationDialog` 新增创建源切换
  - Acceptance: 分支/Issue/PR 三种模式切换；gh 未认证时 Issue/PR 不可见
  - Verify: `WorktreeCreationDialog.test.tsx` 更新
  - Files: `frontend/src/components/dialogs/WorktreeCreationDialog.tsx`

- [ ] **Task 3.8**: 前端 API 方法
  - Acceptance: `getGhAuthStatus`, `listGhIssues`, `listGhPrs`
  - Files: `frontend/src/lib/api/attempts.ts`

- [ ] **Task 3.9**: Module 3 验证
  - Verify: `pnpm test` + `cargo test` + `pnpm run generate-types:check` + `pnpm run check` + `pnpm run lint`
