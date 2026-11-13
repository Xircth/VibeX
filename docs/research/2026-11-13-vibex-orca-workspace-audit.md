# VibeX 工作区创建与设置生效检查，对照 Orca

日期：2026-11-13。VibeX 基线提交：`457d3525a3554fe9a867feb946c69c830c541fce`，检查对象包含当前工作树未提交的代码。Orca 对照提交：`96bad75a6d84eaa0a029be80817f1692700565be`。

这是修复前的源码调用链审查，不是已安装桌面版本的实机验收。后续实现与验证见 [工作区修复验证](2026-11-13-workspace-fixes-validation.md)。Orca 的独立源码依据见 [Orca 工作区研究](2026-11-13-orca-workspace-creation.md)。

## 结论

工作区设置大部分已接到真实消费者，但生命周期执行目录、失败传播、初始化状态与参数校验存在明确缺口。优先修复这些行为，再增加设置项。工作区目录和分支前缀没有必要重做。

## 实际创建流程

1. 打开项目默认走 `ensure_root_workspace`，绑定项目原目录、当前分支，`use_worktree=false`，不会新建隔离目录。这符合 ADR-0068。
2. “新工作区”会调用 `create_project_session(createWorkspace=true)`，先创建 Task、Workspace 与 WorkspaceRepo，再调用 `ensure_container_exists`。
3. 隔离工作区实际布局为 `base/<短UUID>-<标题>/<repo.name>/`，一个容器可放多个仓库。默认 base 是 Host 数据目录下的 `worktrees`；自定义目录则使用 `<用户目录>/.vibex-workspaces`。
4. 容器物化仓库、复制配置文件/图片、生成工作区说明文件，然后执行项目的创建命令。
5. 用户勾选“包含未提交更改”时，主创建入口在上述步骤完成之后才复制原仓库的未提交变更；最后创建 Session。
6. 另有 task/workspace、PR、协作/Workflow 隔离等入口。它们共用底层容器，但上层持久化、失败恢复和初始化顺序并不完全一致。

依据：[主创建入口](../../crates/server/src/host_ops/mod.rs#L1083)、[根工作区](../../crates/server/src/host_ops/mod.rs#L1526)、[新隔离工作区](../../crates/server/src/host_ops/mod.rs#L1753)、[物化](../../crates/local-deployment/src/container.rs#L1114)、[目录规则](../../crates/services/src/services/worktree_manager.rs#L792)。

## 设置是否生效

| 设置 | 实际状态 | 生效范围与限制 |
| --- | --- | --- |
| 全局工作区目录 | 已接通 | 保存后更新内存 override，之后新建隔离工作区使用新路径；已有 container_ref 不迁移；项目根工作区不受影响。界面未显示最终附加的 `.vibex-workspaces` 和仓库子目录。 |
| 全局分支前缀 | 已接通，但校验不一致 | 普通新任务分支使用 `<prefix>/<短UUID>-<标题>`；不会改已有分支。协作隔离等入口可显式指定自己的分支，不应承诺控制所有分支。 |
| 项目“创建后运行命令” | 有执行路径，但不可靠 | 正常新建容器会运行；cwd 是容器根，常见单仓库命令目录错误；恢复已有空/部分容器时可能跳过。 |
| 项目“销毁前运行命令” | 底层生效，上层错误传播失效 | 底层遇失败会退出，但手动删除入口忽略失败并删除 DB；孤儿清理路径也不执行该项目命令。 |
| 清理提醒开关/阈值 | 两个主要 UI 入口已接通 | 查询项目中 DB 已登记、container_ref 存在的隔离工作区数，达到阈值时询问。是软提醒，不是硬上限或自动清理开关。 |
| “包含未提交更改” | 已接通，但执行顺序有问题 | 默认 false，主入口会复制 tracked diff 和未跟踪文件；复制发生在创建命令之后。 |

配置保存通过 Host Command Registry，`update_config` 保存配置后立即更新 deployment config 和 WorktreeManager override；项目命令每次执行都重新读取对应项目设置。不是单纯前端缓存。

依据：[配置应用](../../crates/server/src/host/catalog/config.rs#L86)、[项目设置存储/执行](../../crates/services/src/services/worktree_settings.rs#L74)、[清理计数](../../crates/server/src/host/catalog/system.rs#L637)、[提醒调用](../../frontend/src/lib/confirmWorktreeCreation.ts#L6)、[未提交变更复制](../../crates/server/src/host_ops/mod.rs#L1863)。

## 应修改：按优先级

### P1：删除命令失败，界面仍可能删除工作区记录

`LocalContainerService::cleanup_workspace` 会传播删除命令失败；但是 Host `delete_workspace` 使用 `let _ = ...container().delete(...)` 丢弃错误，随后执行 `Workspace::delete`，向调用者返回成功。

结果是设置页“命令失败会取消删除，便于检查输出”的承诺不成立：目录可能还在，工作区记录和关联会话却已经删除；之后启动时的孤儿目录清理可能继续删除该目录，而且不经过项目删除命令。

同一路径还先尝试删分支、再删 worktree，且忽略分支错误。被该 worktree 检出的分支通常无法先删，导致“同时删除分支”也可能不生效。

修改：删除命令失败必须返回错误并保留记录；先完成运行状态协调和生命周期命令，再移除 worktree，再删已授权删除的分支，最后删除 DB。文件系统失败必须可重试，不能把 DB 删除当成功兜底。孤儿回收应采用明确的所有权和恢复规则，避免绕过失败保护。

依据：[删除入口](../../crates/server/src/host/product.rs#L1102)、[吞错/删记录](../../crates/server/src/host/product.rs#L1145)、[底层命令门控](../../crates/local-deployment/src/container.rs#L384)、[孤儿回收](../../crates/services/src/services/workspace_manager.rs#L479)。

### P1：生命周期命令 cwd 与设置页示例不匹配

仓库在 `<容器>/<repo.name>`，但创建和删除命令接收的 cwd 是 `<容器>`。设置页示例却是 `pnpm install`、`pnpm run clean`。对 package.json 位于仓库根的普通项目，这些命令在错误目录运行；monorepo 的 `default_working_dir` 同样没有被应用到该生命周期命令。

修改：单仓库默认在仓库工作目录执行；多仓库明确区分逐仓库命令和容器级命令。复用已有工作目录解析逻辑，提供简洁的 cwd 预览。保留容器路径变量，并增加语义清晰的仓库路径变量。

依据：[目录布局](../../crates/services/src/services/workspace_manager.rs#L246)、[创建命令实参](../../crates/local-deployment/src/container.rs#L1242)、[执行 cwd](../../crates/services/src/services/worktree_settings.rs#L160)、[界面示例](../../frontend/src/i18n/locales/zh-CN/settings.json#L37)。

### P1：初始化命令先于“包含未提交更改”执行

主入口先 `ensure_container_exists`，其中运行创建命令，再 `copy_uncommitted_changes`。如果用户改了 package.json、lockfile 或初始化脚本，setup 会基于旧文件执行；复制后依赖和生成物可能与最终文件不一致。

修改：先物化目标提交、复制用户选择的变更和环境文件，再运行 setup，成功后才允许 Session 使用该工作区。复制失败也应进入同一个失败恢复流程。

依据：[当前顺序](../../crates/server/src/host_ops/mod.rs#L1853)、[容器初始化命令](../../crates/local-deployment/src/container.rs#L1235)。

### P1：目录存在被当成“初始化已完成”

`ensure_container_exists` 保存 `workspace_existed = workspace_dir.exists()`，仅当它为 false 才执行创建命令。但底层会补建缺失或损坏的仓库 worktree。崩溃留下空父目录、多仓库只完成一部分、手工删除某仓库子目录时，恢复物化成功后仍可能跳过初始化。

单路径锁只覆盖 Git worktree 的确保/补建，不覆盖整个容器物化和 hook，因此也不能证明整个初始化只执行一次。

修改：用持久化的物化/初始化状态及结果证据判断是否需要继续或重试，在工作区级别串行化初始化。不能用父目录存在推断成功，也不应在每次打开时无条件重跑有副作用的命令。

依据：[存在性门控](../../crates/local-deployment/src/container.rs#L1226)、[底层补建](../../crates/services/src/services/workspace_manager.rs#L322)、[锁范围](../../crates/services/src/services/worktree_manager.rs#L175)。

### P1：主要创建入口缺少整体失败收尾

主入口先写 Task、Workspace 和关联，再进行 Git 物化和 hook；错误通过 `?` 返回，但该入口没有删除已写记录或标记创建失败。hook 失败时底层虽尝试删除物理 worktree，上层记录仍留存；未提交变更复制失败时，也已经存在一个登记好的容器。

其他入口各有不同处理，例如 `create_isolated_workspace` 显式补偿删除 Task/Workspace，而普通创建没有。不能依靠后续定期清理替代一次创建请求的明确结果。

修改：统一 Workspace 创建用例，拆分输入验证、创建中、物化、初始化、ready/failed；失败时完整补偿或保留可见、可重试的失败记录。Git/脚本与 DB 无法放进同一事务，应显式记录阶段，避免假设原子性。

依据：[主入口](../../crates/server/src/host_ops/mod.rs#L1753)、[另一入口补偿](../../crates/conversations/src/isolated_workspace.rs#L118)、[Task 工作区入口](../../crates/server/src/host/product.rs#L928)。

### P1：手动删除的运行中保护仍检查旧 ExecutionProcess

删除入口只检查 `ExecutionProcess::has_running_non_dev_server_processes_for_workspace`。底层 `try_stop` 同样遍历这些进程，并未在这条路径检查或取消 ACP Conversation 的 active turn。Agent Turn 与 ExecutionProcess 已是不同运行事实，ADR-0068 对此有明确约束。

因此，不能用该检查保证正在运行 Agent 的工作区不会被移除。定时过期清理查询反而已有 `sessions.active_turn_id` 过滤，手动删除不一致。

修改：检查真实 Conversation/Turn、Agent 长期终端和用户终端；阻止删除，或经用户决定后完成取消并等待收敛再删除。与后端会话写入争用时还需保证状态协调，不能只加前端禁用。

依据：[手动删除检查](../../crates/server/src/host/product.rs#L1105)、[停止范围](../../crates/services/src/services/container.rs#L777)、[定时清理真实 Turn 检查](../../crates/db/src/models/workspace.rs#L562)。

### P2：分支前缀前后端校验冲突，也影响目录设置保存

实际提取前端校验函数执行，得到：

| 值 | 前端 | 后端契约 |
| --- | --- | --- |
| 空字符串 | 拒绝 | 允许，表示无前缀 |
| `feature/sub` | 通过 | 拒绝，后端禁止任何 `/` |
| `foo..bar` | 通过 | Git ref 校验拒绝 |
| `foo.lock` | 通过 | Git ref 校验拒绝 |
| `feature` | 通过 | 允许 |

工作区目录与分支前缀在同一个保存回调中提交，且先验证前缀。若当前前缀为空，修改目录也会直接 return，不发保存请求。前端页面又会在未编辑时隐藏前缀错误，容易让用户误以为目录已保存。

修改：先确定是否支持空前缀、多段前缀，前后端使用一致契约；目录与前缀独立校验/提交，或明确显示阻断原因。保留后端权威校验。新增保存中、已保存、保存失败状态，失败草稿可重试。

依据：[前端校验](../../frontend/src/pages/settings/WorktreeSettings.tsx#L38)、[联合提交](../../frontend/src/pages/settings/WorktreeSettings.tsx#L84)、[后端校验](../../crates/git/src/validation.rs#L1)、[配置保存前检查](../../crates/server/src/host/catalog/config.rs#L93)。

## 可以改进

1. **显示最终结果，而不增加配置负担。** 创建界面展示“项目原目录/隔离工作区”、实际路径、基准分支和初始化 cwd；目录为空时显示实际默认路径；更换目录注明只影响之后新建的隔离工作区。
2. **提供环境文件的项目级复制规则。** 当前有 `Repo.copy_files` 执行能力，但主工作树设置页仅暴露命令与提醒；前端搜索没有发现主设置面可编辑该字段。可补 `.env` 等按需复制，已存在文件不覆盖，失败给出汇总。共享链接应显式选择；不要默认共享 node_modules 等可写内容，避免削弱隔离。
3. **让初始化可观察、可取消。** lifecycle 使用 `process.output().await`，没有超时/取消入口和实时输出；成功输出也不呈现。长命令会让创建持续等待。复用已有执行日志/活动面，保留退出码、阶段和简洁错误，不再新建一套脚本运行体系。
4. **清理提醒连到真正的工作树管理页。** 当前“查看工作树”只是取消确认，helper 没有导航；计数只覆盖 DB 登记且目录存在的工作区，外部 worktree 不在内。阈值应标为“提醒阈值”，说明它不控制后台过期清理。后台现有 30 分钟检查与 1/72 小时规则是独立行为。
5. **统一创建入口和恢复语义。** 新建、复用、导入已有 worktree 明确区分，共享一次 Workspace 用例；保留 VibeX 多仓库能力，避免直接照搬 Orca 单 worktree 目录布局。
6. **明确解析失败，避免悄悄换基准。** `resolve_workspace_branch` 对不存在于本地的显式分支回退当前分支。用户输入错误、远端 ref 或过时分支时，应区分“未指定，使用当前分支”和“显式指定但不可用”，返回错误或明确请求 fetch。
7. **项目设置自动保存防止旧响应覆盖新草稿。** 当前项目保存成功会无条件把响应写回 draft，只有 projectId 防护，没有草稿 revision/值比较；网络慢时旧响应可能覆盖更新的输入。全局配置保存已有值相等检查，可按同样原则完善项目设置。

依据：[复制逻辑](../../crates/local-deployment/src/copy.rs#L17)、[复制失败只记日志](../../crates/local-deployment/src/container.rs#L815)、[命令等待](../../crates/services/src/services/worktree_settings.rs#L160)、[确认取消行为](../../frontend/src/lib/confirmWorktreeCreation.ts#L14)、[后台清理](../../crates/local-deployment/src/container.rs#L477)、[过期规则](../../crates/db/src/models/workspace.rs#L512)、[分支解析](../../crates/git/src/branch_query_ops.rs#L256)、[项目草稿回写](../../frontend/src/pages/settings/WorktreeSettings.tsx#L126)。

## 对照 Orca 时的取舍

值得借鉴：仓库根执行 setup；文件准备完成后再初始化；删除成功后才清元数据；共享分支前缀语义；同步目录占用声明；明确创建新 worktree 和打开已有 worktree；项目配置与初始化输出可观察。

应保留 VibeX 自己的约束：打开项目默认使用原目录（ADR-0068），而不是强制隔离；多仓库容器；Host/远端共用命令入口；工作流、协作和会话独立的运行事实。

不能照搬：Orca 也有复制/链接错误仅记日志后继续的路径，并非完整事务。VibeX 应区分必须成功的文件准备与用户允许的非阻断步骤，汇总结果，不默默跳过。

## 验证与限制

- 阅读并追踪当前设置页、API、Host 路由、DB、容器、Git worktree 与命令执行调用链；对照相关 ADR。
- 用 Node 从当前 TSX 源码提取并执行真实 `validateBranchPrefix`，核对空值、内部斜杠、双点、`.lock` 和正常值；用 Git ref 检查辅助对照后端显式规则。这是局部校验，不等同完整后端测试。
- 尝试运行 `pnpm exec vitest run src/pages/settings/WorktreeSettings.test.tsx src/pages/settings/useLiveSettingsCommit.test.ts src/lib/confirmWorktreeCreation.test.ts src/lib/workspaceDefault.test.ts src/lib/api/sessions.test.ts`，未能启动：`Command "vitest" not found`。当前根目录和 frontend 均无 node_modules，也无 target 缓存。
- 未安装整套依赖、未运行桌面 UI、未执行真实项目 hooks、未删除用户工作区；因此不能声称已实机复现全部故障，或断言当前已安装 VibeX 二进制包含这些源码。

建议实施顺序：删除失败保护与真实运行状态检查 → cwd/文件准备顺序 → 创建状态与恢复 → 参数校验和保存反馈 → 环境复制与管理体验。验收重点应是故障注入和恢复，不应只补成功路径单测。
