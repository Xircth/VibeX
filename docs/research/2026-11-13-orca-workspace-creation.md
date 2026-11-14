# Orca 工作区创建与设置落地：源码研究

核查日期：2026-11-13。目标仓库：[stablyai/orca](https://github.com/stablyai/orca)。
本笔记固定于默认分支 `main` 的提交 `96bad75a6d84eaa0a029be80817f1692700565be`。
以下是源码静态核查；未启动 Orca、未执行项目 hooks、未声称已验证安装版的运行行为。
研究范围以本地 Git worktree 创建为主；非 Git folder workspace 与远程 Host 的行为单独标明。

## 主要结论

Orca 值得借鉴的是明确的设置优先级、分支意图、内容准备与 setup 顺序、删除失败保留状态，以及并发路径占用机制。它并非创建过程的完整事务实现：Git 成功后仍可能发生元数据或文件准备失败；许多链接/复制错误仅写日志，setup 也允许异步失败。

## 1. 创建链路与设置生效位置

主链路为：解析 Project/Host → setup 选择预检 → 解析路径/基线/名字 → Git worktree add → 持久化 workspace metadata → 复制或链接文件 → 解析新 worktree 的 setup → 启动 setup/Agent/默认终端 → 返回结果。

- 创建入口在 `createManagedWorktree`；统一生命周期和插件 hook 后再分派本地 Git、folder workspace 或远程拒绝路径。[入口源码](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/workspace-creation.ts#L51-L170)
- 本地创建每次从 `store.getSettings()` 读取 Host 设置；单次请求可以覆盖 `nestWorkspaces`、本地基线刷新偏好。不是只将设置保存而不消费。[设置读取与预检](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-create.ts#L81-L121)
- 前端全局路径编辑确实调用 `updateSettings({workspaceDir: next})`；项目级路径编辑写 `updateRepo`，并显示全局路径作为 fallback。[全局编辑](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/renderer/src/components/settings/general/WorkspaceDirectorySetting.tsx#L62-L100)、[项目覆盖](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/renderer/src/components/settings/repository/worktrees/RepositoryWorktreeDefaultsSection.tsx#L138-L194)

| 设置或输入 | 实际解析规则 | 源码依据 |
| --- | --- | --- |
| worktree 保存位置 | 非空项目 `worktreeBasePath` 优先，否则全局 `workspaceDir`；相对路径从项目目录解析 | [worktree-logic](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-logic.ts#L204-L265) |
| 按项目嵌套 | `nestWorkspaces=true` 时使用 `root/repoName/sanitizedName`，否则 `root/sanitizedName` | [路径计算](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-logic.ts#L63-L89) |
| 基础分支 | 单次显式 base 优先；有效项目 `worktreeBaseRef` 次之；无效/陈旧项目 ref 回落到检测的默认分支 | [worktree-create-base](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspaces/creation/worktree-create-base.ts#L8-L28) |
| 分支前缀 | Git 用户名、自定义或无前缀；空值表示不加前缀；支持 `team/feature` 多段 | [共享 prefix 函数](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/shared/git/branches/branch-prefix.ts#L10-L72) |
| 本地基线刷新 | 默认关闭；创建时读开关并传给 Git add/prepared checkout；不是强制更新所有本地分支 | [默认值](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/shared/default-global-settings.ts#L36-L47)、[应用](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-git-worktree-create.ts#L111-L221) |

WSL/SSH 不能直接套用本机绝对路径。Orca 在 WSL 下可把工作区根映射到 distro home；远程路径计算对本地绝对根使用仓库旁目录。这应理解为按执行 Host 解析设置，不能简单宣称全局路径在所有机器上原样生效。[WSL 与远程路径规则](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-logic.ts#L145-L216)

## 2. 名称、分支与并发

- 显示名称、文件系统安全名称、实际分支名称可以分开。文件系统名称保留 Unicode 字母/数字并处理 emoji、空格、`..`；最终路径检查不能逃出 workspace root。[名称与路径](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-logic.ts#L23-L60)
- 分支意图区分 `create-new`、`open-existing-v2`、`create-exact`，而非遇到冲突后任意复用。exact 模式不自动加后缀；普通候选有 100 次尝试上限；显式复用时检查分支是否已在另一个 worktree 检出。[请求模型](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/shared/worktree/create-types.ts#L94-L113)、[候选解析](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-create-candidate.ts#L131-L304)、[复用检查](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-worktree-create-git.ts#L44-L126)
- 前端 prefix 即时反馈和后端 prefix 构造共用规则；后端显式分支 override 还调用 `git check-ref-format --branch`。[前端反馈](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/renderer/src/components/settings/source-control/BranchPrefixFeedback.tsx#L1-L20)、[后端 prefix](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-branch-name.ts#L1-L47)、[显式分支校验](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-worktree-create-git.ts#L18-L41)
- `openWorktreeCreatePathClaim()` 同步占用候选路径，防止同一进程中两个创建请求都看到目录不存在；finally 释放。并记录项目在创建中，供删除项目时拒绝冲突操作。[路径占用与项目计数](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspaces/creation/worktree-create-in-flight.ts#L18-L79)、[创建释放](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-create.ts#L74-L79)
- 该 claim 是进程内 Set，不是跨进程数据库锁；外部 Git 并发的最终冲突仍需 Git 命令处理。不能把它称为所有环境下完全无竞态。[实现](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspaces/creation/worktree-create-in-flight.ts#L8-L79)

## 3. 复制、链接与 setup 的顺序

Orca 先完成 worktree 内容准备，再决定 setup。具体为手工配置路径 → 共享目录 → `.worktreeinclude` 独立复制 → setup。Git worktree 本身只提供指定提交的内容；本研究未在创建请求模型或这条链路发现复制主仓库所有未提交修改的等价选项，因此不要把 `.worktreeinclude` 说成完整的 dirty tree 迁移。[内容准备](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-materialization.ts#L151-L181)、[setup 在其后](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/workspace-creation.ts#L170-L205)、[创建请求](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/shared/worktree/create-types.ts#L94-L162)

- `.worktreeinclude` 只支持仓库根相对的字面文件/目录；过滤绝对路径、`..`、`.git`、通配符，只复制存在且 gitignored 的路径。读取失败不阻止创建。[include 解析](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/git/worktrees/content-paths/worktree-include-file.ts#L8-L120)
- `orca.yaml` 的 `worktree.sharedDirectories` 只接受存在且 gitignored 的目录，例如 `node_modules`；此模式真正共享链接，不做独立 clone。[共享目录](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/git/worktrees/content-paths/worktree-shared-directories.ts#L67-L112)
- `repo.symlinkPaths` 的 link 模式在 macOS 优先 APFS clone 再回落 symlink；Windows 目录优先 junction。copy 模式是独立内容，share 模式始终链接；已存在目标不覆盖。[文件物化](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-symlinks.ts#L28-L133)、[不覆盖及模式入口](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-symlinks.ts#L150-L309)
- 复制有累计 2 GiB/50,000 entries 默认预算；超额条目跳过并向创建者返回 warning，避免复制大依赖树拖住整个创建。[预算](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-include-copy-budget.ts#L1-L35)、[返回 warning](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-materialization.ts#L174-L181)

setup 的 cwd 明确是新 worktree 的真实目录；环境另外提供 `ORCA_ROOT_PATH`、`ORCA_WORKTREE_PATH`、`ORCA_WORKSPACE_NAME`。[调用](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-setup.ts#L105-L133)、[进程 cwd](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/hooks.ts#L234-L263)、[环境变量](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/setup-hook-env-vars.ts#L22-L44)

## 4. Hooks 设置的明确语义

- `orca.yaml` 共享脚本与项目设置本地脚本通过 `shared-only`、`local-only`、`run-both` 显式仲裁；run-both 为共享脚本后接本地脚本。[有效配置](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/effective-hook-config.ts#L12-L58)
- setup 运行策略分 ask/run-by-default/skip-by-default，单次 run/skip 可覆盖。已有 setup 且 ask 未决定时，在 Git add 之前拒绝，避免为了询问先留下 worktree。[策略](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/effective-hook-config.ts#L60-L89)、[创建预检](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-create.ts#L104-L121)
- 新 worktree 可能来自另一分支，因此重新读取该目录的 `orca.yaml`；若客户端提供批准哈希且内容改变，跳过 setup/默认终端命令并返回 mismatch。旧 Git 客户端未提供哈希时此校验兼容性放行，不能称绝对保证。[新目录解析](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-setup.ts#L58-L102)、[哈希与兼容路径](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/created-worktree-setup-trust.ts#L12-L48)
- setup 与 Agent 可以按设置立即并行，或等待 setup；创建返回 setupReceipt，区分 running/skipped/not_configured/spawn_failed，不能把创建成功当成 setup 成功。[策略解析](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/worktree-runner-script.ts#L59-L78)、[receipt](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-setup.ts#L151-L170)

## 5. 失败、删除与不能照搬的部分

1. Git add 成功后才写 workspace metadata，减少“DB 有记录但 Git 创建尚未开始”的窗口。不过 metadata 早于文件准备和 setup，当前这条链路没有包住全部阶段的自动回滚事务。[Git 后物化](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-create.ts#L183-L236)、[metadata 位置](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-materialization.ts#L77-L154)
2. 链接/复制失败多为日志后继续，无法统一向调用方呈现所有准备错误；预算拒绝才有结构化 warning。setup 的无终端 fallback 也是 fire-and-forget，失败写日志。VibeX 应借鉴阶段划分并补全失败状态，不能照搬“日志即处理”。[逐路径 catch](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/ipc/worktree-symlinks.ts#L206-L275)、[异步 setup](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/creation/runtime-local-worktree-setup.ts#L105-L138)
3. 已注册本地 worktree 删除先执行 archive hook，失败会阻止删除；单纯 force 不隐含忽略 hook 失败，必须专门允许。然后重新确认 Git 注册、锁、dirty 状态、停止 PTY，再删除。[删除预检](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/removal/runtime-registered-local-worktree-removal.ts#L94-L204)、[失败门控](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspaces/removal/worktree-archive-hook-gate.ts#L10-L28)
4. 真正 Git 删除成功或完成明确的 orphan/部分删除恢复后，才调用 finishRemoval 清理 Host 元数据；失败不直接当删除完成。存在后台 deleting 状态，重复删除可加入已有请求。[Git 删除后清理](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/removal/runtime-registered-local-worktree-removal.ts#L236-L303)、[重复请求](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/runtime/workspaces/removal/workspace-removal.ts#L94-L130)
5. 配置解析失败也有被当作无配置的情况：`loadHooks` catch 返回 null。这可能隐藏 YAML 错误；值得为 VibeX 提出可见诊断，而非推荐同样静默降级。[loadHooks](https://github.com/stablyai/orca/blob/96bad75a6d84eaa0a029be80817f1692700565be/src/main/workspace-hooks/hooks.ts#L106-L118)

## 对 VibeX 的可执行借鉴

以下是建议，并非 Orca 已证明满足 VibeX 全部需求：

- 先修复删除失败仍删 DB 的问题，保留失败状态与重试依据；借鉴 Orca 的“文件系统删除完成后清元数据”。
- 将真实 repository cwd 与 container root 分开；复制用户勾选的未提交内容和配置文件后，再执行 setup。
- 使用显式 workspace 初始化阶段/结果区分 checkout、内容准备、setup、ready、failed；容器目录存在不能等价于 setup 已完成。
- 前端与后端共用前缀规范/合法性测试；明确空前缀和多段前缀含义，最终由 Git 校验分支。
- 在创建 UI 展示最终目录、基础分支、目标分支和将应用的初始化动作；写清全局默认、项目覆盖与单次选择的优先级。
- 结合 VibeX 的单 Host 模型增加按仓库/目标路径的并发协调；先补正确性，再考虑 Orca 的 prepared checkout 池或 sparse checkout。
- 保留 VibeX ADR-0068 指定的“打开项目默认根目录工作区”；Orca 新 worktree 的隔离流程不应覆盖这一现有产品语义。
