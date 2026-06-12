# Tasks: Phase 4 — 工程闭环 UI 补齐

执行环境：worktree `../VibeX-workbench-loop`，分支 `feature/workbench-loop`。

- [ ] T4.1 Delta 协议与后端 watcher 批处理
  - Acceptance: 后端发送 `WorkspaceDelta { added, removed, modified, overflow }`；
    300ms 防抖、1.5s 批窗、单批 2000 路径上限；overflow 触发全量刷新信号。
  - Verify: Rust 临时目录集成测试（批量写入、删除、重命名、overflow）。
  - Files: `crates/services/src/services/filesystem_watcher.rs`,
    `crates/services/src/events/*`, `src-tauri/src/commands/*`

- [ ] T4.2 前端文件树 delta reducer
  - Acceptance: added/removed/modified 就地更新树；用户正在重命名/拖拽时不打断；
    overflow 走现有全量刷新。
  - Verify: vitest reducer 表驱动测试 + 桌面文件增删冒烟。
  - Files: `frontend/src/components/file-tree/*`, file tree store/hooks

- [ ] T4.3 TerminalContext 与多终端标签栏
  - Acceptance: 新建、关闭、重命名、切换、崩溃态、重启；每标签独立 PTY；
    工作区切换后标签状态正确保留或按设计清理。
  - Verify: context reducer 测试 + 桌面开 3 终端、关闭、崩溃命令冒烟。
  - Files: `frontend/src/components/terminal/*`, `frontend/src/contexts/TerminalContext.tsx`

- [ ] T4.4 xterm ligatures
  - Acceptance: 接入 `@xterm/addon-ligatures`；字体支持时生效，不支持时无错误；
    与 fit/web-links addon 顺序稳定。
  - Verify: 终端手动冒烟；无控制台错误。
  - Files: terminal component setup, `frontend/package.json`

- [ ] T4.5 Diff 导航与统计条
  - Acceptance: diff 面板显示文件数、+N/-N、当前差异位置；支持上/下差异跳转；
    首次打开自动定位首个差异。
  - Verify: diff stats 纯函数测试 + Monaco diff navigator 手动冒烟。
  - Files: `frontend/src/components/panels/*Diff*`, diff utils

- [ ] T4.6 Git 变更树形视图
  - Acceptance: 平面/树形切换；目录节点显示聚合数量与变更状态；重命名、删除、
    冲突文件图标清晰。
  - Verify: tree builder 表驱动测试（嵌套、同名、rename、conflict）。
  - Files: `frontend/src/components/panels/git/*`, `frontend/src/lib/gitChangeTree.ts`

- [ ] T4.7 Monaco 编辑面板
  - Acceptance: 从文件树/消息链接打开文件；编辑、Ctrl+S 保存、脏标记、只读/二进制/
    >5MB 提示；外部修改 mtime 冲突提示重载/覆盖。
  - Verify: mtime 冲突命令测试 + 桌面编辑保存冒烟。
  - Files: `frontend/src/components/panels/EditorPanel.tsx`,
    `src-tauri/src/commands/files.rs`, API hooks

- [ ] T4.8 Worktree 管理面
  - Acceptance: 列表展示路径/分支/状态；创建新分支或既有分支 worktree；删除前检查
    未提交变更；可在工作区中打开；错误原文可见。
  - Verify: worktree_manager 集成测试 + 桌面创建/删除冒烟。
  - Files: `frontend/src/components/worktrees/*`, `crates/git/*`（如需补命令）

- [ ] T4.9 统一分支下拉
  - Acceptance: 搜索、切换、新建、合并、变基、删除本地、删除远程、为分支建
    worktree；分支在其他 worktree 检出时给出明确提示。
  - Verify: 分支操作命令 mock 测试 + 真实 git repo 冒烟。
  - Files: `frontend/src/components/git/BranchDropdown.tsx`, git API hooks

- [ ] T4.10 冲突列表与解决 UI
  - Acceptance: 冲突文件列表实时刷新；提供 ours/theirs/open in editor；解决后状态
    更新；不在 UI 层实现 git 逻辑。
  - Verify: 临时冲突仓库集成测试 + 桌面冲突冒烟。
  - Files: conflict UI, `crates/git/conflict_ops.rs` 接线

- [ ] T4.11 独立 Git 操作窗口裁剪决策
  - Acceptance: 对 `/commit`、`/push`、`/stash`、`/merge` 独立路由做产品决策：
    若 VibeX 保持内嵌面板，需记录不实现独立窗口的理由与等价入口。
  - Verify: 更新 design.md 或新增 ADR。
  - Files: `docs/specs/codeg-alignment/04-workbench-engineering-loop/design.md`

- [ ] T4.12 端到端桌面冒烟与视觉验收
  - Acceptance: 创建 worktree → 开终端 → 改文件 → delta 更新 → 树形变更 →
    diff 导航 → 编辑保存 → commit（AI 消息）→ 删除 worktree 全流程通过。
  - Verify: `pnpm run frontend:check`, `pnpm run frontend:lint`,
    `cargo test --workspace`, `npx impeccable detect --fast --json frontend/src/components frontend/src/styles`
  - Files: 修复所有发现问题

- [ ] T4.13 五轴审查 → 修复 → 全门验证 → 合并回 master
  - Acceptance: D1-D9、C17 traceability 项完成/裁剪记录齐全。
  - Verify: 根目录全门：`pnpm run check`, `pnpm run lint`, `cargo test --workspace`
