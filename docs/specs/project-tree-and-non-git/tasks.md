# Tasks：非 Git 项目与项目树

每项是一小步可合并切片。后端契约先于依赖它的 UI。前端遵守 `DESIGN.md` 与 `design.md` §3；新 UI 只组合已有 shadcn 组件。

```text
M0 契约
 └─ M1 非 Git 项目 + 停自动 init
     ├─ M2 非 Git 会话/工作区短路
     └─ M4 树字段、摘树、路径拖拽
          ├─ M3 导入扫描（勾选后写 parent）
          ├─ M5 欢迎页树 + 项目栏加宽
          └─ M6 Git 面板子仓、原地 init、多仓迁移
               └─ M7 前端收口与检测
```

M2 与 M4 在 M1 后可并行。M3 / M5 / M6 在 M4 后可并行。M3 的扫描 API（T3.1）只需 M1，但对话框提交写 parent 必须等 T4.1。

---

## M0 — 规格冻结

### T0.1 对照需求与设计无歧义

- **Depends**：无
- **Acceptance**：`requirements.md` 每条 PRJ/IMP/TREE/SES/MIG/UI 都能在 `design.md` 找到实现策略；非目标未被任何任务重新打开
- **Verify**：通读三份规格
- **Files**：本目录

---

## M1 — 项目可以没有 Git

目标：选一个非 Git 文件夹可以登记为项目，磁盘上不出现 `.git`。此时还不必能建会话。

### T1.1 迁移：`root_path` / `parent_project_id` / `hidden`

- **Depends**：T0.1
- **内容**：`projects` 增加 `root_path TEXT NOT NULL DEFAULT ''`、`parent_project_id BLOB NULL REFERENCES projects(id)`、`hidden INTEGER NOT NULL DEFAULT 0`。未隐藏行对 `root_path` 唯一（空路径除外）。回填：现有项目 `root_path` = 其第一个 repo 路径。
- **Verify**：迁移在空库与有项目库上可重复执行；`Project` 的 ts-rs 类型已含新字段
- **Files**：`crates/db/migrations/*`、`crates/db/src/models/project.rs`、`shared/types.ts`

### T1.2 `create_project` 允许零仓库

- **Depends**：T1.1
- **内容**：`repositories` 可空，但必须有 `root_path` 或 `init`。校验目录存在且为文件夹。非 Git 不调用 `resolve_git_repo_path` / `init_repo_at_path`。
- **Verify**：服务测试：非 Git 目录创建成功、无 repo 行、未创建 `.git`；Git 目录创建仍登记一条 repo
- **Files**：`crates/services/src/services/project.rs`、`crates/server/src/host_ops/mod.rs`、对应 tests

### T1.3 打开文件夹不再自动 init

- **Depends**：T1.2
- **内容**：`ProjectFormDialog` 已有模式：非 Git 默认不 init，主按钮为「打开文件夹」。可选 Checkbox「将本文件夹初始化为 Git 仓库」默认 false。仅勾选时才 `initAtPath`。
- **UI**：`Checkbox` + `Label` + 现有 `Alert` 提示「不是 Git 仓库」。不改 Dialog 材质。
- **Verify**：组件测试：非 Git 提交不调用 `initAtPath`；勾选后调用。文案 key 中英齐全
- **Files**：`frontend/src/components/dialogs/projects/ProjectFormDialog.tsx`、i18n、现有 dialog 测试

---

## M2 — 非 Git 会话跑在目录上

目标：在非 Git 项目里建会话，agent CWD 为 `root_path`，无 Git 报错。

### T2.1 `ensure_root_workspace` 对无仓短路

- **Depends**：T1.2
- **内容**：无 repo 时不读分支、不 checkout。创建/复用 `use_worktree=false`、`container_ref=root_path`、`branch=""` 的 root workspace。执行过程允许零 repo，跳过 HEAD。
- **Verify**：Rust 测试：非 Git 项目 `create_project_root_session` 成功；spy/断言未调 `get_current_branch`。Git 项目回归仍过
- **Files**：`crates/server/src/host_ops/mod.rs`、`crates/services/src/services/container.rs`、`crates/local-deployment/src/container.rs`、sessions 命令

### T2.2 前端隐藏工作区与 Git chrome

- **Depends**：T2.1
- **内容**：项目 `is_git === false` 时：`SessionCreationForm` 不渲染创建方式 / `WorkspaceSelector` / 新工作区块；`BranchInfoHeader` 与会话 Git Actions 不挂载。可有一行「会话将在 {name} 中运行」。
- **UI**：删除而非 disabled。Git 项目像素级保持原状。
- **Verify**：`SessionCreationForm.test.tsx` 增加非 Git 用例；Git 初始化未完成的现有用例不受影响
- **Files**：`SessionCreationForm.tsx`、`BranchInfoHeader.tsx`、引用 Git Actions 的会话布局

---

## M3 — 导入时发现直接子 Git

目标：打开 A 时列出 `A/*/ .git`，默认不勾，勾选则创建独立项目。

### T3.1 `preview_project_import`

- **Depends**：T1.2
- **内容**：只扫直接子目录的 `.git`。跳过点目录与 `node_modules`。返回 `{ is_git, children[] }`。
- **Verify**：filesystem 测试：A/B、A/C 命中；`A/foo/bar/.git` 不命中；无 `.git` 返回空
- **Files**：`crates/services/src/services/filesystem.rs` 或 project service、host_ops、bindings

### T3.2 导入对话框子仓列表

- **Depends**：T3.1、T1.3、T4.1
- **内容**：选中路径后调 preview。`ScrollArea` + `Checkbox` 列表，默认全不勾。提交时对勾选项 upsert 子项目并设置 `parent_project_id`。未勾选的已有项目不改 parent。

- **UI**：无子仓则整块不渲染。扫描中 Skeleton。`Alert` 说明默认不导入。
- **Verify**：dialog 测试：默认不勾；勾两个则三次 create/upsert（A+B+C）
- **Files**：`ProjectFormDialog.tsx`、i18n

### T3.3 路径已存在则复用

- **Depends**：T3.1
- **内容**：upsert by 规范化 `root_path`。隐藏项目取消 hidden。未勾选的已有子项目不改 parent。
- **Verify**：先有 B 再导 A 且不勾 B → B.parent 仍空
- **Files**：project service

---

## M4 — 树、摘树、合法拖拽

### T4.1 parent / hidden API

- **Depends**：T1.1
- **内容**：`list_projects` 返回树字段，默认过滤 hidden。`hide_project`、`set_project_parent`（校验子路径、无环、未隐藏）。
- **Verify**：环、非子路径、hide 释放直接子为根且孙不变
- **Files**：project service、host_ops、`projectsApi`

### T4.2 导入勾选写入 parent

- **Depends**：T4.1、T3.1
- **内容**：把 IMP-003/004 接到 create/upsert
- **Verify**：勾选 B、C 后 list 为 A→B、A→C
- **Files**：create_project 路径、ProjectFormDialog 提交

### T4.3 摘树替换栏内删除

- **Depends**：T4.1
- **内容**：项目栏与欢迎页右键「删除」改为 `hide_project`。ConfirmDialog 用 `design.md` §3.8 文案，非 destructive 默认。toast「已从列表移除」。
- **Verify**：hide 后列表与栏消失；DB 中会话仍在；同路径再打开 id 不变
- **Files**：`ProjectRail.tsx`、`WelcomePage.tsx`、i18n

### T4.4 仅路径包含的拖拽

- **Depends**：T4.1
- **内容**：项目栏拖 Y 到 X：前端先用路径判断是否高亮；松手调 `set_project_parent`。非法无高亮。去掉列表「拖动滚动」，改 `ScrollArea` + 滚轮。
- **Verify**：子路径成功；无关路径不请求或请求被拒；栏仍可滚动
- **Files**：`ProjectRail.tsx`、CSS、project service 测试

---

## M5 — 树的展示（前端重点）

### T5.1 欢迎页最近项目树

- **Depends**：T4.1
- **内容**：按 parent 缩进。图标 GitBranch / FolderOpen。隐藏项不渲染。
- **UI**：内容层，密度与现网一致。`flex` + `gap`，每层 12px padding。
- **Verify**：组件测试：父子顺序与缩进 class；点击子项打开子项目 id
- **Files**：`WelcomePage.tsx`、测试

### T5.2 项目栏加宽 + 树 + 右下动作

- **Depends**：T4.4
- **内容**：宽约 220px；行 = 小徽标 + truncate 名 + 状态点；当前行 accent 填充；子行缩进；底部三按钮横排右对齐。取消 8 条裁切，改为高度内滚动。树语义 `role="tree"`。
- **UI**：仍 `HostGlass`。新宽度走 `--project-rail-*`。不要玻璃行、不要树连接线。
- **Verify**：测试当前项 `aria-current`；三按钮在壳内底部；长名 truncate。实现后对改动文件跑 impeccable detect
- **Files**：`ProjectRail.tsx`、`ProjectRailProjectBadge.tsx`、`frontend/src/styles/legacy/index.css`、rail 测试

---

## M6 — Git 面板、原地升级、迁移

### T6.1 非 Git Git 面板

- **Depends**：T2.2、T4.1
- **内容**：无 Git 子项目：说明性空状态，无 commit UI。有：顶部 Select 子项目，其后复用现有 Git 面板数据钩子，绑定子项目 repo，不切 `projectId`。
- **UI**：空状态与现 `GitPanel` EmptyState 同结构。Select 与面板其它下拉同一组件。
- **Verify**：无子仓不出现 Select；选子仓后 status 请求落到子 repo id
- **Files**：`GitPanel.tsx`、git hooks 如需 repo override

### T6.2 原地 init + 嵌套警告

- **Depends**：T2.1、T3.2
- **内容**：`init_project_git`。对话框勾选 init 且 children 非空：Alert + 提交时 ConfirmDialog。设置里若有入口，同样警告。
- **Verify**：确认后 A 有 repo 且 `.git` 存在；取消则无 `.git`
- **Files**：repo/project service、`ProjectFormDialog.tsx`

### T6.3 多仓 → 树

- **Depends**：T4.1
- **内容**：按 MIG-002 一次性迁移。会话跟原 `repos[0]` 对应项目。用户侧关闭 `add_project_repository`。
- **Verify**：夹具：共同父目录；一仓包含其余；互不相关三条。迁移幂等
- **Files**：db 迁移或启动 backfill、project service、去掉多仓 UI 选择器（脚本对话框、worktree 多仓分支）

---

## M7 — 收口

### T7.1 i18n 与文案

- **Depends**：M5、M6 可见字符串
- **内容**：中英 key 对齐；摘树 / init 警告 / Git 空状态无内部术语
- **Verify**：`pnpm` i18n check（若有）或搜索未翻译 key

### T7.2 设计检测

- **Depends**：T5.2、T3.2、T6.1
- **内容**：对改动的 tsx/css 跑  
  `.agents/skills/impeccable/scripts/impeccable.cmd detect --json <files>`  
  清掉本功能引入的警告（厚色条、纯黑遮罩、gradient text、max-height 动画等）。
- **Verify**：detect 无新增 warning；无内容层玻璃；无 `space-y` 新区；无硬编码 `bg-white` / `gray-*`

### T7.3 回归

- **Depends**：M1–M6
- **内容**：Git 项目建会话、worktree、Git Actions、克隆仓库、创建新 Git 项目模板，行为与改前一致
- **Verify**：相关既有 frontend vitest + 后端 project/session 测试

---

## 建议提交切分

1. db 字段 + 零仓 create + 停自动 init  
2. 非 Git root workspace + 隐藏会话 Git chrome  
3. preview 扫描 + 导入列表  
4. hide/parent API + 摘树文案  
5. 项目栏树与加宽、欢迎页树、合法拖拽  
6. Git 面板子仓 + init 警告 + 多仓迁移  
7. i18n 与 detect  

每步应可单独跑相关测试。不要在第 1 步重做项目栏。
