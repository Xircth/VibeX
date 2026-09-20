# Design：非 Git 项目与项目树

访客模式：**Operate**。这是日常工程控制面，不是营销页。熟悉感优先于表现；密度、状态和一致的控件词汇优先于新视觉世界。视觉权威是仓库根 `DESIGN.md`，不替换 Tahoe。

## 1. 当前耦合（必须改的事实）

| 层 | 现状 | 问题 |
|---|---|---|
| 导入 | `ProjectFormDialog` 对非 Git 走 `repoApi.initAtPath` | 自动 `git init`，会把 A 变成套着 B/C 的嵌套仓 |
| 项目 | `create_project` 要求可 `resolve_git_repo_path` 的仓库 | 非 Git 目录进不来 |
| 会话 | `ensure_root_workspace` 取第一个 repo 并读当前分支 | 无仓则失败 |
| 工作区 | `workspaces.branch` 非空；container 要求 workspace 有 repo | 非 Git 无法跑 turn |
| 管理 | 项目扁平列表；项目栏 31px 字母徽标 | 看不出 A/B/C 从属，名字不可读 |
| 多仓 | `project_repos` 一对多，Git/工作区按「项目下全部仓」循环 | 与「子仓 = 独立项目」冲突 |

一项目多仓是数据模型能力，不是首页导入的常规路径。本设计把多仓 **迁成项目树**，运行时按「当前项目一个根目录」处理。

## 2. 领域模型

```text
Project
  id
  name
  root_path          -- 会话 CWD 与文件根
  parent_project_id  -- 可空，单父无环
  hidden             -- 从树/列表摘掉
  default_main_branch, default_agent_working_dir  -- Git 项目才有意义

Repo                 -- 仅 Git 项目拥有；通常 0 或 1 条
  path == project.root_path

Workspace            -- 每个项目仍有 root workspace
  Git: 现有逻辑（可 worktree）
  非 Git: use_worktree=false, container_ref=root_path, 不跑 git
```

派生属性 `is_git`：该项目存在 repo 行，或 `root_path` 当下是 Git 仓库。不要另存会过期的布尔，除非探测太贵——导入、init、打开时刷新。

### 2.1 身份规则

- 未隐藏项目的 `root_path` 唯一。隐藏项目保留路径，供再次打开时复用。
- B 是独立项目。A 的 Git 面板可以 **指向** B 的 repo 做操作，但不把 B 写成 A 的 `project_repos`。
- 树边只表示管理从属。删边（摘掉父或释放子）不删磁盘、不删会话。

### 2.2 非 Git 工作区（同一条会话链路）

不走 ADR-0006 的 `workspace_id = NULL`。

`ensure_root_workspace(project)`：

- 若 `is_git`：现有实现。
- 若否：保证存在 `use_worktree=false` 的 root workspace；`container_ref = root_path`；`branch` 存空字符串（列保持 NOT NULL，避免大迁移）；所有 Git 命令在 `!is_git` 时短路。
- `create_start_execution_process` 对无 repo 的 workspace 跳过 HEAD 采样，不要报 `Workspace has no repositories configured`。
- Agent `working_dir` = `root_path`。

创建会话：非 Git 固定这条 root workspace，前端不渲染工作区模式切换。

### 2.3 导入算法

```text
open(folder A):
  is_git = A 自身有 .git
  children = A 的直接子目录中含 .git 者（跳过隐藏名、node_modules、.git）
  展示：
    可选 init Git（默认 false）
    children 勾选列表（默认全不勾）
  提交：
    若 init：git init A，并在已有 children 时先确认嵌套警告
    upsert 项目 A（hidden→false，按 root_path 匹配）
    对勾选的 child：upsert 项目，parent=A
    未勾选的已存在项目：不改 parent
```

扫描失败（权限、超时）时仍允许只导入 A，列表显示错误说明，不阻塞。

### 2.4 摘树与恢复

`hide_project(A)`（替换项目栏当前删除的默认语义）：

1. `A.hidden = true`
2. 所有 `parent_project_id = A` 的项目设为 `NULL`
3. 不删 sessions / workspaces / 磁盘

`open(path)`：若存在 hidden 或可见项目匹配该 `root_path`（规范化后），复用 id，`hidden=false`。子项目不自动挂回。

路径规范化：Windows 去 `\\?\`、统一分隔符、canonicalize 失败则用规范化字符串比较。比较包含关系时用前缀 + 分隔符边界，避免 `C:\foo` 误匹配 `C:\foobar`。

### 2.5 拖拽挂树

仅当 `is_subpath(child.root_path, parent.root_path)` 且不会成环。后端拒绝非法挂接；前端非法目标不显示放置高亮。

### 2.6 原地 init Git

`init_project_git(A)`：对 `root_path` 做 `initialize_repo_with_main_branch`，创建 repo 行并挂到 A。若 A 仍有 Git 子项目，UI 先 `AlertDialog` 再调用。之后 A 走 Git 会话路径。

### 2.7 多仓迁移

启动或首次读项目时一次性：

1. 项目只有 0/1 个 repo：写入 `root_path`，结束。
2. 多个 repo：
   - 计算共同父目录（所有 path 的最长公共前缀，且该前缀是存在的目录）。有则 upsert 非 Git 父项目，原项目变为子项目（每个仓一个项目，`root_path=仓路径`）。
   - 若某一仓路径包含其余仓：该仓为父，其余为子。
   - 否则：拆成独立根项目，原项目名加仓名以免冲突。
3. 该项目的工作区/会话跟到「主仓」对应的那个项目（原 `repos[0]`），避免会话丢失。

## 3. 前端设计

### 3.1 设计原则（Operate + Tahoe）

- **项目栏是导航/控件层**：可以继续用 `HostGlass`。列表行不是第二层玻璃。禁止玻璃叠玻璃（行上再套 blur、栏内再套玻璃 popover 除外——会话预览 popover 已是叠加层，保持现有 portal，不要放进栏的 overflow）。
- **欢迎页最近列表、导入对话框、Git 面板是内容层**：不透明 `.settings-surface` / `--surface-dialog` / 面板背景。层次靠分组和间距，不加装饰性描边。
- **强调只用 accent**：当前项目、拖放合法目标、主按钮。Git/文件夹差异用 lucide 图标 + 文案，不用彩色条带。
- **控件词汇**：已有 shadcn/Radix 封装。新 UI 先组合，不新造树控件库，不引入第二套表单布局。
- **文案**：用户语言。说「文件夹 / Git 仓库 / 从列表移除」，不说 `parent_project_id`、`hidden`、`root workspace`。

### 3.2 组件清单（只用现有）

已安装、本功能应组合的：

| 需要 | 用 |
|---|---|
| 导入/警告/摘树确认 | `Dialog`、`AlertDialog`/`ConfirmDialog`、`Alert` |
| 勾选 init、勾选子仓 | `Checkbox` + `Label` |
| 主/次操作 | `Button` `variant="default" \| "outline" \| "ghost"` `size="sm"` |
| 路径只读 | 现有 `TextInput` 只读预览，单层控制框 |
| 子仓列表滚动 | `ScrollArea` |
| Git / 文件夹标记 | lucide `GitBranch` / `FolderOpen`，必要时 `Badge variant="secondary"` |
| 扫描中 | `Skeleton`，不要在列表中央放孤立 spinner |
| Git 面板选子仓 | 现有 `Select` 或 `astryx-select`（与 Git 面板其它下拉一致） |
| 摘树结果 | `toast()` |
| 项目栏外壳 | 现有 `HostGlass` |
| 图标按钮提示 | `Tooltip`；图标按钮必须有 `aria-label` |

不要为本功能 `shadcn add` 新组件（不引入 Field/Empty/Collapsible），除非实现时现有 Select 在 Git 面板里无法复用。表单新区用 `flex flex-col gap-3`，不要 `space-y-*`。不要用裸 `bg-blue-500` / `gray-*` / `bg-white`。

图标在 `Button` 内不额外写 `h-4 w-4` 抢尺寸；对话框内与现有 `ProjectFormDialog` 已有用法保持同一密度即可，避免半套新规范半套旧规范。

### 3.3 表面 1：打开文件夹（`ProjectFormDialog` 已有模式）

内容层，沿用现有 `Dialog` + `--surface-dialog`。不要改成玻璃模态。

非 Git 时主按钮文案从「初始化 Git 并打开」改为 **「打开文件夹」**。Init 是独立勾选，不是提交的副作用。

```text
┌ 打开文件夹 ─────────────────────────────────┐
│ 选择一个工程根目录。不必是 Git 仓库。          │
│                                             │
│ [选择文件夹]  D:\work\monorepo               │
│                                             │
│ ⚠ 这不是 Git 仓库。会话将直接在此目录中运行。  │  Alert, warning token
│ ☐ 将本文件夹初始化为 Git 仓库                 │  Checkbox, default off
│                                             │
│ 发现 2 个 Git 仓库                    可选导入 │
│ ┌─────────────────────────────────────────┐ │
│ │ ☐  api     D:\work\monorepo\api         │ │  ScrollArea, max-h ~168px
│ │ ☐  web     D:\work\monorepo\web         │ │
│ └─────────────────────────────────────────┘ │
│ 默认不导入。导入后可在项目栏中切换。           │
│                                             │
│                        [取消]  [打开文件夹]   │
└─────────────────────────────────────────────┘
```

勾选 init 且列表非空时，在勾选下方插入 `Alert`（destructive/warning，不用侧色条）：

> 初始化后，本文件夹会变成 Git 仓库，其中仍包含已有的 Git 仓库。这会造成嵌套仓库。只有在你确实需要把外层也当成仓库时才继续。

提交时若仍勾选 init 且有已发现子仓，再弹出 `ConfirmDialog`（与栏内确认同一组件）做一次明确确认。取消则回到对话框，不 init、不关闭。

扫描中：子仓卡片区域用 2–3 行 `Skeleton`，标题改为「正在查找 Git 仓库…」。空结果：不渲染整块，避免「发现 0 个」噪音。

Git 的 A 同样展示子仓列表（默认不勾）。成功态「已识别为 Git 仓库」保持现有 success 文本色，不要新描边。

### 3.4 表面 2：首页最近项目

欢迎页已是内容层：左列操作 + 最近列表。保持这个拓扑，把扁平 `RecentProjectItem` 换成缩进树。

```text
最近项目
  monorepo                         D:\work\monorepo
    api                            D:\work\monorepo\api
    web                            D:\work\monorepo\web
  notes                            D:\notes
```

规则：

- 行高与现有最近项一致（`px-2 py-1.5`，`text-sm` 名称 + `text-xs text-muted-foreground` 路径）。
- 缩进每层 12px，最多视觉上缩三层，更深仍缩进但靠滚动，不改字号。
- 行首用 14px 线形图标：Git 用 `GitBranch`，非 Git 用 `FolderOpen`，颜色 `text-muted-foreground`。当前不需要选中填充（欢迎页不是导航 chrome）。
- 隐藏项目不出现。
- 加载：现有「正在加载」文案或 `Skeleton` 三行。空：现有 empty copy。
- 右键菜单保留打开/删除；删除走摘树文案（见 3.7），不是「永久删除」。

不要把最近列表做成卡片栅格、时间线或玻璃抽屉。

### 3.5 表面 3：项目栏（签名改动）

项目栏仍是 **浮动玻璃切换器**，不是 IDE 侧栏。加宽是为了让树和名字可扫读，不是为了塞进文件树。

现宽约 43px、31px 字母徽标、纵向三个图标按钮。目标：

```text
┌──────────────────────────┐  HostGlass, 宽 ~220px, 高随条目有上限后滚动
│ ●  monorepo              │  当前行：accent 填充 + 对比文字（Tahoe 侧栏选中）
│      api                 │  子行缩进 14px，无连接线
│      web                 │
│    notes                 │
│                          │
│           [+] [📁] [×]   │  右下横排, 30px ghost/raised 图标按钮
└──────────────────────────┘
```

布局：

- 外壳继续 `HostGlass` + 现有 rail token（`--project-rail-*`）。新增宽度 token，例如内容区约 196px + 内边距；不要写死 hex。
- 行：左 22px 圆角方徽标（保留两字母，缩小）+ 名称 `truncate` + 状态点。名称用 Title/Label 档（0.75rem），不要 Display。
- 当前项目：整行 accent 填充，徽标与文字用 `primary-foreground`。不要只靠颜色：`aria-current="page"`。
- 子行不重复大徽标也可，仅缩进 + 名称；第一期允许子行也带小徽标，但同一棵树内尺寸一致。
- 状态点保留（running / idle / error）。加载用现有 spinner，不要换成中心大 Loader。
- hover 仍可弹出最近会话 `Popover`（portal 到 body）。`prefers-reduced-motion` 下无位移，仅背景变化。
- 删除按钮（摘树）在行 hover 时出现，图标 `Trash2`，`aria-label` 改为「从列表移除 {name}」。不要用破坏性红填，除非确认框。
- 三个动作按钮：`Plus` / `FolderOpen` / `X`，`flex flex-row gap-*`，`justify-end`，放在栏底部。分隔用间距，不用满宽 `Separator`（DESIGN.md：不要用满宽分割线切开同卡片内容）。
- 列表可滚动。取消「按住列表拖动滚动」——与挂树拖拽冲突。滚动交给滚轮与 `ScrollArea`。
- `MAX_PROJECT_RAIL_VISIBLE_PROJECTS = 8` 改为按高度滚动，不再用裁切条数挡住子节点。
- `prefers-reduced-transparency`：玻璃退回实心 panel + hairline，现有 HostGlass 必须继续遵守。

拖拽挂树：

- 合法目标（路径包含）：行出现 2px accent focus 环（与现有 focus-visible 同语汇），松手后缩进动画 150ms ease-out。
- 非法目标：无环、光标 `not-allowed` 可选。
- 拖的是整行；不要新增可见手柄，以免窄栏更挤。键盘：第一期不提供键盘挂树，摘树与切换必须可键盘操作。

Windows 长名称：`truncate` + `title` 全名。中文名称两个字徽标仍用现有 `getProjectRailMonogram`。

### 3.6 表面 4：会话创建、分支条、Git Actions

非 Git 时 **不渲染**，不是 disabled。隐藏比一排灰掉的 Git 控件更符合「不是另一套产品，只拿掉不需要的部分」。

`SessionCreationForm`：

- `is_git === false`：去掉「创建方式」两按钮、`WorkspaceSelector`、新工作区分支与「包含未提交」。只留会话名、Agent、提交。
- 可在标题下用一行 `text-xs text-muted-foreground`：「会话将在 {folder name} 中运行。」路径用 mono。
- Git 项目完全保持现状，包括 `Toggle`/`Button` 网格。不要顺便用 ToggleGroup 重构 Git 流。

`BranchInfoHeader`、会话区 Git Actions：`is_git` 为假时 return null。

### 3.7 表面 5：Git 面板

内容层，现有 Git 面板结构保留。

非 Git 且无 Git 子项目：

```text
Git
这个文件夹不是 Git 仓库。
在子文件夹中打开 Git 项目后，可以在那里使用分支、提交和差异。
```

用现有空状态版式（居中、图标低对比、两行文案）。不要放 disabled 的 commit 表单。

非 Git 且有 Git 子项目：

```text
仓库  [ api ▼ ]     -- Select，选项为子项目名
……该子项目的完整 Git 面板……
```

选择变化只切换面板数据源（子项目的 repo id / 其 root workspace），顶栏项目、文件树、当前会话仍是 A。操作失败时 toast，文案带上子项目名。

Git 项目：面板顶部不出现这个选择器。

### 3.8 摘树确认（替换删除）

继续 `ConfirmDialog`，改 copy，**不要** `variant="destructive"` 作为默认（磁盘文件还在、会话还在）。用默认确认。

- 标题：从列表移除「{name}」？
- 正文：项目会从列表和项目栏消失，磁盘上的文件不会删除。其中的会话会保留，之后用同一文件夹即可恢复。子项目会变成独立项目。
- 确认：移除
- 取消：取消

成功 toast：「已从列表移除 {name}」。失败 toast 保持错误。

### 3.9 状态、范围、动效

| 状态 | 行为 |
|---|---|
| 扫描中 | 导入框 Skeleton |
| 扫描失败 | Alert + 仍可只打开 A |
| 路径已是隐藏项目 | 打开即恢复，无第二份 |
| 非法拖放 | 无放置态 |
| 嵌套 init | Alert + Confirm |
| 非 Git 会话 | 无工作区控件 |
| 无子仓 Git 面板 | 说明性空状态 |
| 长树 | 栏内滚动，不缩小字号 |
| reduced-motion | 无位移，交叉淡化或立即 |
| reduced-transparency | 栏实心 |

动效只用于：选中、合法放置、栏显隐（已有）、hover 1px。不要列表入场编排。

### 3.10 可访问与 i18n

- 树是列表，不是仅靠缩进的 div。项目栏用 `role="tree"` / `treeitem` / `aria-level` / `aria-selected`；欢迎页最近项保持 button 列表即可（不是切换器 chrome）。
- 图标按钮都有 `aria-label`。Git vs 文件夹不只靠图标颜色。
- 焦点环用现有 accent，不要自绘 3px 外发光。
- 中英 key 同步：`projectForm.*`、`welcomePage.*`、`projectRail.*`、`sessionCreation.*`、`gitPanel.*`。
- 布局按中文更长字符串预留；按钮不写死英文宽度。

### 3.11 反模式

- 子仓做成父项目的多仓选择器（旧模型）。
- 欢迎页或对话框使用 Liquid Glass。
- 项目栏做成文件树（连接线、三角形展开、三列元数据）。
- 用 `space-y-*` 新堆表单；用 `gray-*` / 硬编码 hex 做树缩进背景。
- 非 Git 显示 disabled 的 Git 控件「以示完整」。
- 摘树与「删除磁盘」混用同一句 copy。

## 4. API 与文件边界

新增/调整（名称可在实现时对齐现有 `application.call` 风格）：

- `create_project`：允许 `repositories: []` + `root_path`；`initGit?: boolean`
- `preview_project_import(path)` → `{ is_git, root_path, children: [{ name, path }] }`
- `hide_project(id)`
- `set_project_parent({ id, parent_id | null })` 校验路径包含与环
- `init_project_git(id)`
- `list_projects`：带 `root_path, parent_project_id, hidden, is_git`；默认排除 hidden
- Git 面板：已有 repo 查询之外，增加「当前项目的 Git 子项目列表」或前端用 `list_projects` 过滤 `parent_id === A && is_git`

主要改动文件（提示，非搬家）：

- 后端：`crates/db` 迁移，`crates/services/src/services/{project,repo,filesystem}.rs`，`crates/server/src/host_ops/mod.rs`，`crates/local-deployment` / container 执行前检查
- 前端：`ProjectFormDialog.tsx`、`WelcomePage.tsx`、`ProjectRail.tsx` + CSS、`SessionCreationForm.tsx`、`BranchInfoHeader.tsx`、`GitPanel.tsx`、`shared/types.ts`

## 5. 测试要点

- 导入非 Git 不创建 `.git`。
- 直接子仓扫描；`A/foo/bar/.git` 不出现。
- 先 B 后 A 不自动挂；合法拖拽才挂；非法拖拽后端 400。
- hide 后会话仍在；同路径打开复用 id。
- 非 Git `create_project_session` 不调用 `get_current_branch`。
- 多仓迁移的三种路径形状各一条夹具。
- 前端：非 Git 会话表单无工作区控件；Git 面板空状态与子仓 Select；项目栏树缩进与右下动作条。
