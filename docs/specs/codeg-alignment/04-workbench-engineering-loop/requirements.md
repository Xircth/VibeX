# Requirements: Phase 4 — 工程闭环 UI 补齐 (workbench-engineering-loop)

## Objective

把工程闭环的前端体验补齐到 Codeg 水平：worktree 管理 UI、多终端标签、diff
导航与统计、Monaco 编辑面板、冲突解决 UI、统一分支管理、git 变更树形展示、
文件树增量推送。VibeX 后端（crates/git、worktree_manager、filesystem_watcher）
已较完整——本阶段以前端为主、后端补 delta 推送。

对应差距：D1–D9、C17。保留 VibeX 反超项（AI commit 消息、文件树拖拽）。

## Acceptance Criteria (EARS)

1. Worktree UI（D1）：THE SYSTEM SHALL 提供 worktree 管理面：列表（路径/分支/
   状态）、创建（新分支或既有分支、自动同级目录命名 `<project>-<name>`）、
   删除（带未提交变更检查与确认）、在工作区中打开。创建/删除走既有
   worktree_manager，错误透传给 UI。
2. 多终端（D2）：THE SYSTEM SHALL 支持多终端标签（新建/关闭/重命名/切换），
   每个标签绑定独立 PTY 会话；关闭标签终止会话；工作区切换时标签保留。
3. Diff 导航（D3）：THE diff 面板 SHALL 显示增删行统计与「上一个/下一个差异」
   导航按钮（monaco diff navigator），并自动定位首个差异。
4. 文件树 delta（D4）：WHEN 文件系统变化，THE 后端 SHALL 推送防抖（300ms，
   批窗 1.5s，单批 ≤2000 路径）的增量 delta 事件，前端文件树就地更新，不再
   全量刷新；超过批限则回退一次全量刷新信号。
5. 变更树形（D5）：THE git 变更列表 SHALL 支持树形视图（目录聚合 + 文件计数）
   与平面视图切换。
6. 编辑面板（D6）：THE SYSTEM SHALL 提供 Monaco 编辑面板：打开文件树文件、
   编辑、Ctrl+S 保存、外部修改检测（提示重载/保留）、脏状态标记。
7. 冲突 UI（D7）：WHEN 仓库存在冲突文件，THE SYSTEM SHALL 列出冲突并提供
   解决入口（采用我方/对方/在编辑器中打开），状态实时刷新。
8. 分支管理（D8）：THE SYSTEM SHALL 提供统一分支下拉：列表/搜索/新建/切换/
   合并/变基/删除（本地与远程删除分开确认）/为分支建 worktree。
9. 终端连字（C17）：xterm 增加 ligatures addon（等宽连字字体下生效）。
10. 视觉合规：同 Phase 2 验收 9（impeccable + 设计禁令）。

## Edge / Error Cases

- worktree 删除时有未提交变更：阻止并列出变更，提供「强制删除」二次确认。
- 分支在其他 worktree 检出：操作给出明确指引（Codeg 同语义）。
- 编辑面板打开二进制/超大文件：提示而非卡死（大小阈值 5MB）。
- delta 推送期间用户正在重命名（内联编辑）：不打断编辑态。

## Boundaries

- Always：每个 git 操作 UI 必须展示后端错误原文（不吞错）；文件/拖拽行为在
  桌面 runtime 验证两个方向（树内移动 + 拖到编辑器）。
- Ask first：无。
- Never：在 UI 层实现 git 逻辑；为 Dockview 拖拽问题加业务层 hack（先查容器
  拦截）。

## Success Criteria

- 10 条验收全过；桌面端冒烟：创建 worktree → 在其中开终端 → 改文件 → 树形
  变更 → diff 导航 → 编辑保存 → commit（AI 消息）→ 删除 worktree 全流程；
  全门绿。
