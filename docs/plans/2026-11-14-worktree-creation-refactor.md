# Spec: Worktree 创建与分发重构

## Objective

重构 VibeX 的 worktree 创建和分发逻辑，解决三个核心问题：

1. **现有工作区选择器概念混淆**（module: `existing-workspace-restrict`）：当前新建会话时，"选择现有工作区"模式下 WorkspaceSelector 同时列出了 worktree workspace、project-root workspace 和所有本地分支。用户可能误选分支导致主目录被 `git checkout` 切换。需要将"选择现有工作区"严格限制为 worktree + 默认目录，分支仅在"新建工作区"模式下作为二级菜单出现。

2. **缺少独立 worktree 创建入口**（module: `standalone-worktree-create`）：当前 worktree 创建完全绑定在会话创建流程中。用户无法在不启动 agent session 的情况下创建 worktree。需要在会话列表"更多选项"菜单中新增"创建 Worktree"入口，弹出完整的高级表单（分支名称、父工作树、备注、设置脚本、稀疏检出），创建后不启动 session。

3. **缺少 Issue/PR 创建源**（module: `issue-pr-worktree-source`）：当前只能基于现有分支创建 worktree。需要新增基于 GitHub Issue 和 PR 的创建选项（仅在项目为 git repo 且本地已安装并认证 gh CLI 时显示）。利用已有的 `create_workspace_from_pr_host` 后端能力扩展为 Issue 场景。

---

## Capability Map

| Module id | Responsibility | Depends on |
|---|---|---|
| existing-workspace-restrict | 重构 WorkspaceSelector：现有工作区模式只展示 worktree + 默认目录；新建工作区模式展示二级 worktree→branch 菜单 | — |
| standalone-worktree-create | 会话列表更多选项新增"创建 Worktree" → 完整表单弹窗（Tab 模式全局遮罩 B 区、Canvas 模式 B 区左侧居中）；后端新增 `create_workspace_standalone` 命令（不创建 task/session） | existing-workspace-restrict |
| issue-pr-worktree-source | 创建表单新增 Issue/PR 创建源选项（gh 已认证时显示）；后端新增 `get_gh_issue_for_worktree` 端点；复用已有 `create_workspace_from_pr_host` | standalone-worktree-create |

---

## Module: existing-workspace-restrict

### 当前行为

`WorkspaceSelector.tsx` 在 `mode === 'existing_workspace'` 时通过 `workspaceBranchOptions`（由 `buildWorkspaceBranchOptions` 生成）渲染下拉菜单。该列表混合了：
- `useWorktree=true` 的 workspace（正确）
- `useWorktree=false` 的 project-root workspace（正确）
- 与 workspace 无关联的纯本地分支 → 选中后创建 `branch:<branchName>` value → 后端走 `ensure_root_workspace` → 在主目录执行 `checkout_branch`（**问题**）

### 目标行为

**现有工作区模式**：下拉菜单只展示已有 workspace（worktree + 默认目录），按 `orderWorkspacesForSelector` 排序。纯分支选项不出现。

**新建工作区模式**：`RepoBranchSelector` 改造为二级菜单结构：
- 一级：workspace 名称（worktree 或"默认目录"）
- 二级（展开/子菜单）：该 workspace 下的可用分支

实现方式：不修改 `RepoBranchSelector` 的内部结构，而是在其上层封装一个 `GroupedBranchSelector` 组件，将 `workspaceBranchOptions` 按 workspace 分组，每个 workspace 下展示其分支列表。选中分支后 value 仍然是 `workspace:xxx` 或 `branch:xxx` 格式。

### 改动范围

- `frontend/src/lib/workspaceBranchOptions.ts` — 新增 `groupOptionsByWorkspace` 函数
- `frontend/src/components/sessions/WorkspaceSelector.tsx` — 新增分组渲染模式
- `frontend/src/components/sessions/SessionCreationForm.tsx` — 现有工作区模式传入过滤后的 options；新建工作区模式使用分组渲染
- `frontend/src/lib/workspaceBranchSegment.ts` — 可能需要调整以配合分组逻辑
- `frontend/src/i18n/locales/en/tasks.json`, `zh-CN/tasks.json` — 新增 UI 文案

### Success Criteria

- [ ] 现有工作区模式下，下拉菜单中不出现无 workspace 关联的纯分支
- [ ] 新建工作区模式下，分支以 `workspace → branch` 二级结构展示
- [ ] 选择纯分支后不再触发主目录 `git checkout`
- [ ] 所有现有测试通过

---

## Module: standalone-worktree-create

### 前端

**入口**：`WorkspaceSessionListToolbar.tsx` 的"更多选项"下拉菜单中，新增 `DropdownMenuItem` "创建 Worktree"。

**表单弹窗**：新建 `WorktreeCreationDialog.tsx` 组件。

**弹出逻辑**：
- **Tab 模式**（`boardStyle !== 'canvas'`）：通过 `setRightPanelVisible(false)` + 设置 URL search param `?newWorktree=1` 触发右侧面板内的全屏遮罩（复用现有 `RightPanelContent` 的遮罩机制），或直接在 B 区上叠加一个 `Dialog` 组件。
- **Canvas 模式**（`boardStyle === 'canvas'`）：在 B 区左侧居中位置弹出表单，通过 `useWorkspaceOverlay` 控制 native surface 避让。

实际选择：**统一使用 shadcn `Dialog` 组件**。Tab 模式下 Dialog 渲染在 B 区 overlay 层（通过 portal 挂载到 `[data-overlay-root]`），Canvas 模式下同样使用 Dialog 但定位为左侧居中。通过 `useLayoutStore` 的 `activeTab` 判断模式。

**表单字段**（对应 Orca 截图 + VibeX 已有能力）：

| 字段 | 类型 | 后端映射 | 必填 |
|------|------|---------|------|
| 分支名称 | Input | `branch_name` in `create_worktree` | 是 |
| 父工作树 | Select（workspace 列表） | `parent_workspace_id` in Workspace | 否（默认"无"） |
| 备注 | Input | `name` in Workspace | 否 |
| 设置脚本 | Textarea + Toggle | `create_command` in `ProjectWorktreeSettings` | 否 |
| 运行设置命令 | Toggle (Switch) | 控制是否执行 create_command | 否（默认开） |
| 等待设置完成后再启动智能体 | Toggle (Switch) | 预留字段（暂不实现后端逻辑） | 否 |
| 稀疏检出 | Select（完整检出 / 自定义目录） | 新增 `sparse_checkout_directories: Option<Vec<String>>` | 否（默认完整） |

**稀疏检出后端改动**：
- `crates/git/src/cli.rs` — 新增 `worktree_add_sparse()` 方法，执行 `git worktree add --no-checkout` + `git sparse-checkout init --cone` + `git sparse-checkout set <dirs>` + `git checkout`
- `crates/services/src/services/worktree_manager.rs` — `create_worktree` 新增 `sparse_dirs: Option<&[String]>` 参数
- `crates/application/src/domain.rs` — 新增 `WorkspaceCreateStandalone` domain command
- `shared/types.ts` — 新增 `CreateStandaloneWorkspaceRequest` / `CreateStandaloneWorkspaceResponse` 类型（通过 `generate_types` 生成）

**后端新命令**：`create_workspace_standalone`
- 接受：`project_id`, `branch_name`, `parent_workspace_id?`, `name?`, `create_command?`, `run_setup_command: bool`, `sparse_checkout_directories?`
- 创建 `Task`（轻量级，title 为分支名或备注）、`Workspace`（`use_worktree: true`）、`WorkspaceRepo`
- 调用 `prepare_workspace()` 完成 worktree 创建
- 返回 `Workspace` 对象

### 后端改动

- `crates/application/src/domain.rs` — 新增 `WorkspaceCreateStandalone => "create_workspace_standalone" / "application.call"`
- `crates/server/src/host_ops/mod.rs` — 新增 `DomainCommand::WorkspaceCreateStandalone` handler
- `crates/server/src/host_ops/workspace_creation.rs` — 新增 `create_standalone_workspace()` 函数
- `crates/git/src/cli.rs` — 新增 `worktree_add_sparse()` 方法
- `crates/services/src/services/worktree_manager.rs` — `create_worktree` 新增 sparse_dirs 参数
- `shared/hostCommands.ts` — 注册 `create_workspace_standalone`
- `shared/types.ts` — 新增请求/响应类型（需运行 `generate_types`）

### Success Criteria

- [ ] "更多选项"菜单中出现"创建 Worktree"项
- [ ] 点击后弹出表单弹窗（Tab 模式遮罩 B 区、Canvas 模式左侧居中）
- [ ] 表单包含所有 7 个字段，稀疏检出选择"自定义目录"时出现目录多选输入
- [ ] 创建后返回 workspace，不创建 agent session
- [ ] 稀疏检出 worktree 只包含指定目录的文件
- [ ] 前端 TypeScript、ESLint 检查通过
- [ ] 后端 `cargo clippy --features qa-mode -- -D warnings` 通过
- [ ] `pnpm run generate-types:check` 通过

---

## Module: issue-pr-worktree-source

### 前端

**表单入口**：在 Worktree 创建表单顶部（或分支名称字段旁）新增创建源选择器，选项为：
1. **分支**（默认）— 现有的分支选择流程
2. **GitHub Issue** — 弹出 issue 搜索/选择 UI
3. **GitHub Pull Request** — 弹出 PR 选择 UI

**可见性条件**：仅当以下条件同时满足时显示 Issue/PR 选项：
- 当前项目有 git repo（`isGitProject`）
- 本地安装了 `gh` CLI
- `gh auth status` 认证成功

**后端检测**：新增 `get_gh_auth_status` 端点（或通过现有 `GhCli` 的 `is_available()` + `auth_status()` 组合）。前端在打开创建表单时通过 `useQuery` 检测 gh 可用性。

**Issue 选择**：
- 调用后端 `list_gh_issues` 端点获取项目 repo 的 open issues
- 选中 issue 后，分支名称自动填充为 `issue/<number>-<slugified-title>`（或让用户编辑）
- 备注自动填充为 issue title

**PR 选择**：
- 复用已有的 `create_workspace_from_pr` 端点（已存在于 `workspace_parity.rs`）
- 调用后端 `list_gh_prs` 端点获取 open PRs
- 选中 PR 后，分支名称自动填充为 PR head branch
- 走 `create_workspace_from_pr_host` 流程

### 后端改动

- `crates/services/src/services/git_host/github/cli.rs` — 新增/扩展：
  - `get_gh_auth_status()` — 检测 gh 是否可用且已认证
  - `list_open_issues()` — 已有 `list_issues`，需确认返回类型是否满足 UI 需求
  - `list_open_prs()` — 已有 `list_prs_for_branch`，需新增按 repo 列出所有 open PRs 的方法
  - `view_issue()` — 新增 `gh issue view <number> --json ...` 获取 issue 详情
- `crates/application/src/domain.rs` — 新增：
  - `GhListIssues => "list_gh_issues" / "application.call"`
  - `GhListPrs => "list_gh_prs" / "application.call"`
  - `GhAuthStatus => "get_gh_auth_status" / "application.call"`
- `crates/server/src/host_ops/` — 新增对应 handler
- `shared/types.ts` — 新增 `GhIssueSummary`、`GhPrSummary`、`GhAuthStatus` 类型
- `shared/hostCommands.ts` — 注册新命令

### Success Criteria

- [ ] gh 未安装或未认证时，Issue/PR 选项不可见
- [ ] gh 已认证时，Issue 选项可选择 issue 并自动填充分支名和备注
- [ ] gh 已认证时，PR 选项可选择 PR 并走已有 `create_workspace_from_pr` 流程
- [ ] 分支名称字段允许用户在自动填充后编辑
- [ ] 前端 TypeScript、ESLint 检查通过
- [ ] 后端 clippy 通过

---

## Tech Stack

- **前端**: React 18 + TypeScript, shadcn/ui (Dialog, Select, Input, Switch, Textarea), TanStack Query, i18next
- **后端**: Rust, Tauri IPC, git CLI, sqlx + SQLite, ts-rs (类型生成)
- **外部**: GitHub CLI (`gh`)

---

## Commands

```bash
# 类型生成（修改 shared types 后必须运行）
pnpm run generate-types
pnpm run generate-types:check

# 前端检查
pnpm --filter ./frontend run check        # tsc
pnpm --filter ./frontend run lint          # eslint

# 后端检查
cargo clippy --workspace --all-targets --features qa-mode -- -D warnings

# 测试
pnpm test
cargo test --workspace

# 全量 CI 检查
pnpm run check
pnpm run lint
```

---

## Project Structure

改动涉及的文件：

```
frontend/src/
  components/sessions/
    WorkspaceSelector.tsx          # [module 1] 分组渲染
    SessionCreationForm.tsx        # [module 1] 现有/新建模式区分
  components/workspace-session-list/
    WorkspaceSessionListToolbar.tsx # [module 2] 新增"创建 Worktree"菜单项
  components/dialogs/
    WorktreeCreationDialog.tsx     # [module 2] 新增：完整创建表单弹窗
  components/gh/                   # [module 3] 新增
    GhIssueSelector.tsx            # Issue 选择器
    GhPrSelector.tsx               # PR 选择器
    useGhAuthStatus.ts             # gh 认证状态 hook
  lib/
    workspaceBranchOptions.ts      # [module 1] 新增分组函数
    workspaceBranchSegment.ts      # [module 1] 可能需要调整
  features/agents/
    api.ts                         # [module 2,3] 新增 API 方法
  i18n/locales/
    en/tasks.json                  # 新增文案
    zh-CN/tasks.json               # 新增文案

shared/
  types.ts                         # [module 2,3] 新增类型（自动生成）
  hostCommands.ts                  # [module 2,3] 注册新命令

crates/
  application/src/domain.rs        # [module 2,3] 新增 domain commands
  server/src/host_ops/
    mod.rs                         # [module 2,3] 新增 handlers
    workspace_creation.rs          # [module 2] 新增 standalone 创建函数
  git/src/cli.rs                   # [module 2] 新增 worktree_add_sparse()
  services/src/services/
    worktree_manager.rs            # [module 2] create_worktree 新增 sparse_dirs
    git_host/github/cli.rs         # [module 3] 新增 gh issue/PR/auth 方法
```

---

## Code Style

遵循 VibeX 现有规范：
- Rust: `cargo fmt`, `clippy -D warnings --features qa-mode`
- TypeScript: ESLint (max-warnings 0), Prettier
- 组件使用 shadcn/ui + Astryx 设计系统
- CSS 使用 design tokens (`--surface-*`, `--text-*`)，不硬编码颜色
- 错误处理：后端使用 `thiserror`，前端使用 `SessionCreationStatusCard` 模式
- 国际化：所有用户可见文案使用 `t()` + i18n key

---

## Testing Strategy

- **前端**: Vitest + React Testing Library
  - `WorkspaceSelector.test.tsx` — 验证现有模式过滤、新建模式分组渲染
  - `WorktreeCreationDialog.test.tsx` — 验证表单字段、稀疏检出切换、创建调用
  - `GhIssueSelector.test.tsx` / `GhPrSelector.test.tsx` — 验证 gh 可用性检测和选择逻辑
  - `workspaceBranchOptions.test.ts` — 验证分组函数
- **后端**: Rust unit tests + integration tests
  - `worktree_manager_tests.rs` — 新增 sparse worktree 创建测试
  - `cli.rs` tests — 新增 `worktree_add_sparse` 测试
  - `github/cli.rs` tests — 新增 issue/PR 列表和 auth 检测测试
- **类型生成**: `generate-types:check` CI 验证

---

## Boundaries

### Always do
- 新增 IPC 命令后运行 `pnpm run generate-types` + `pnpm run generate-types:check`
- 修改 `sqlx::query!` 后运行 `pnpm run prepare-db`
- 所有用户可见文案添加 i18n key
- 遵循 `orderWorkspacesForSelector` 的 workspace 排序逻辑
- 稀疏检出创建失败时回滚 worktree 注册

### Ask first
- 修改 Workspace DB schema（当前不需要）
- 添加新的 cargo workspace crate
- 更改 Tauri IPC 命令命名规范

### Never do
- 在 `ensure_root_workspace` 中自动执行 `git checkout` 切换主目录分支（这是本次要修复的问题）
- 在未认证 gh 时尝试调用 gh 命令
- 硬编码 GitHub token 或认证信息
- 在 `comprehensive_worktree_cleanup` 中静默吞掉 metadata 清理错误（上一轮审查发现的 P1 问题，本次不修但需注意）

---

## Open Questions

1. **父工作树的语义**：Orca 的"父工作树"是 lineage 关系（用于侧边栏嵌套展示），VibeX 的 `parent_workspace_id` 也用于此目的。表单中选择父工作树时，是否需要在 UI 上展示 lineage 树结构，还是简单的 Select 下拉即可？
   → 建议：简单 Select 下拉，列出已有 worktree workspace 即可。

2. **"等待设置完成后再启动智能体"**：此 toggle 当前无后端实现（因为独立创建 worktree 不启动 session）。是否需要为未来启动 session 预留此字段？
   → 建议：前端保留此字段但默认为关闭状态，后端暂不处理。

3. **稀疏检出自定义目录的输入方式**：是自由文本输入（逗号分隔）还是目录树多选？
   → 建议：初始版本用自由文本输入（每行一个目录路径），后续可升级为目录树多选。

4. **Issue 创建时的 branch 命名规则**：`issue/<number>-<slugified-title>` 还是让用户完全自定义？
   → 建议：自动填充 `issue/<number>-<title-slug>` 但允许编辑。
