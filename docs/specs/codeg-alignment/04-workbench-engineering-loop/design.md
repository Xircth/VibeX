# Design: Phase 4 — 工程闭环 UI 补齐

## 所属层

- 前端：`frontend/src/components/{panels,layout,file-tree}`、新
  `frontend/src/components/worktrees/`、`frontend/src/components/terminal/`
- 后端：`crates/services/src/services/filesystem_watcher.rs`（delta 推送）、
  `src-tauri/src/commands/`（terminal 多会话已支持，补标签语义；workspaces
  git 命令已有，补冲突列表/解决命令若缺）

## 参照实现（Codeg）

| 能力 | Codeg 文件 | 策略 |
|------|-----------|------|
| 分支/worktree 下拉 | `layout/branch-dropdown.tsx` | 行为对齐重写（VibeX 用 shadcn 原语） |
| 终端标签 | `terminal/terminal-tab-bar.tsx`、`contexts/terminal-context.tsx` | 移植结构：TerminalContext 管多会话生命周期 |
| diff 导航 | `diff/diff-viewer.tsx` L147-169 | monaco `createDiffNavigator` + 统计条 |
| delta 推送 | `workspace_state/mod.rs` L39-65 | 移植参数（300ms 防抖/1.5s 批窗/2000 上限）到 filesystem_watcher |
| 变更树 | `aux-panel-git-changes-tab.tsx` ChangeTreeDirNode | 移植树构建纯函数 + 测试 |
| 冲突 | `layout/conflict-dialog.tsx` | 接 crates/git/conflict_ops 既有后端 |
| 编辑面板 | `files/file-workspace-panel.tsx` | Dockview 新面板类型，monaco 已有依赖 |

## 要点

1. **TerminalContext**（前端）：`{ id, title, cwd, sessionId }[]` + 活跃 id；
   关闭→后端 kill；崩溃→标签标记 exited 可重启。复用既有 terminal 命令面。
2. **Delta 协议**：`WorkspaceDelta { added: [], removed: [], modified: [],
   overflow: bool }`，Tauri event `workspace-delta:{workspace_id}`。前端文件树
   reducer 就地应用；overflow=true 触发全量刷新。gitignore 状态由后端在 delta
   中标注（复用 watcher 既有过滤）。
3. **编辑面板**：Dockview panel `editor:{path}`；保存走新命令
   `write_workspace_file(path, content, expected_mtime)`——mtime 不符返回冲突
   错误，UI 提示重载/覆盖。外部修改检测靠 delta 事件。
4. **Worktree 管理面**：设置入口 + 分支下拉双入口；创建对话框（名称→类型
   前缀自动归一，参照 git-worktrees skill 约定 `<project>-<name>` 同级目录）。
5. **冲突列表**：`list_conflicts(workspace)` 若命令缺则在 crates/git 补
   （conflict_ops 已有底层）；解决动作 ours/theirs/open-in-editor。

## 新依赖

- `@xterm/addon-ligatures`（C17，Codeg 同款）。其余无新增（monaco、xterm、
  Dockview、shadcn 均已有）。

## 测试策略

- 树构建纯函数：表驱动（嵌套目录/重命名/冲突状态）。
- delta reducer：vitest（added/removed/modified/overflow 路径）。
- watcher：Rust 集成测试（临时目录改名/批量写入防抖断言）。
- 编辑保存冲突：mtime 不符路径测试。
- 终端标签：context 归约测试。

## 风险

- Dockview+Tauri 拖拽干扰（已知风险区）：编辑面板拖拽问题先查容器拦截。
- watcher 在 Windows 上的事件风暴：批窗参数对齐 Codeg，加 overflow 回退。
