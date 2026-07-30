# 无工作区会话：nullable workspace_id + 专用临时工作目录

允许创建**不挂靠 Project / Workspace** 的 Conversation（纯聊天模式，P3-3）。本 ADR 只
锁定两个在写任何代码前必须先定的设计决策——**数据模型形态**与**agent 工作目录/沙箱策略**
——不含实现。术语见 [CONTEXT.md](../../CONTEXT.md) 的「Workspace-less conversation」。

决定于 2026-07-06（先锁定数据模型与工作目录策略，后续再分片落地）。

## 背景：为什么必须先决策

对齐扫描确认无工作区会话的耦合是硬的、多层的：

- **DB**：`sessions.workspace_id` 为 `BLOB NOT NULL` + `ON DELETE CASCADE` 硬外键；
  `Session.workspace_id: Uuid` / `ConversationRecord.workspace_id: Uuid` 均为非 Option。
  `workspaces`（原 task_attempts）自身还要求 `task_id`/`project_id`/`branch` 非空——即
  一个 Workspace 无法脱离 project→task→branch 链存在。
- **Turn 运行时**（真正的拦路点）：`start_turn` 每回合无条件调用
  `container().ensure_container_exists(&workspace)`，仓库为空时硬报错、worktree 分支要
  `parent_task()`；`working_dir` 从 git 容器推导后喂给 `build_prompt_blocks`——**当前没有
  任何不落地文件系统就能跑 turn 的路径**。
- **前端**：所有会话路由都嵌在 `/local-projects/:projectId/...` 下，IDE 布局/`useProject`/
  git 面板都假设 project+workspace 存在；`conversation_start_turn` 命令要求 `workspace_id`。

因此两个决策直接决定 schema 迁移形态与整条新 `start_turn` 分支及其安全姿态，悬而未决就
写代码几乎注定返工。

## Decision A — 数据模型：`sessions.workspace_id` 置为 nullable（否决 sentinel 工作区）

**采纳：把 `sessions.workspace_id` 改为可空（`Option<Uuid>`）。**

- **否决 sentinel 方案**（保留 NOT NULL，引入一个"无仓库草稿 workspace"占位）：它把一个假的
  project/task/branch 泄漏进**每一处按 workspace 归属的查询与 UI**，用一次性 schema 变更换来
  永久的、四处蔓延的特判——这与"selective alignment / inspectable"基调相悖。
- nullable 是**一次性、有界**的改动：SQLite 需整表重建迁移；两处模型改 `Option<Uuid>`；约 6 个
  查询方法（`find_by_workspace_id`/`list_for_workspace`/`create` 等）改签名；重跑 `.sqlx` 与
  `generate-types`。事件溯源相关表（events/turns/tool_calls/permissions）只外键到 `sessions(id)`，
  **不受影响**。它如实建模了"这个会话没有工作区"这一事实。

## Decision B — agent 工作目录/沙箱：专用 per-conversation 临时目录（否决 $HOME）

**采纳：无工作区会话的 agent 文件/终端工具根目录指向专用临时目录
`~/.vibex/scratch/<conversation_id>/`，而非 $HOME、也非"无目录"。**

- 纯聊天的 agent **仍持有文件/终端工具**。把 `working_dir` 指向 $HOME 会把整个家目录暴露给一个
  用户只想"聊聊"而打开的 agent——这是真实的安全回退，不是观感问题，**否决**。
- **否决"无 working_dir / 禁用文件与终端工具"**：实现上 ACP turn 链路目前必须有一个文件系统
  CWD；且完全禁用工具会让该模式失去大部分实用性。
- 专用 scratch 目录给出一个**默认受限、可丢弃、可审查**的 CWD（agent 多以 CWD 为相对根），写入
  被收敛在一处。**明确记录其局限**：这不是 OS 级沙箱（agent 仍可用绝对路径访问系统其它位置），
  因此无工作区会话被定性为**能力受限的低权限模式**，而非与常规会话等价。OS 级隔离是独立的后续
  课题，不在本 ADR 范围。

## Consequences / 后续落地顺序（本 ADR 不实现）

1. 先落 schema：nullable 迁移 + 两模型 Option 化 + 受影响查询 + `.sqlx`/`generate-types`。
2. 后端 turn 分支：`start_turn` 增加无工作区路径——跳过 `ensure_container_exists`/仓库校验，
   `working_dir` 取 `~/.vibex/scratch/<conversation_id>/`（首用即建）；放宽/绕过 empty-repo 硬报错。
3. 列表可见性：`list_for_workspace` 等按 workspace 归属的列表对 NULL-workspace 会话不可见，需新增
   一个承载面（否则新建的纯聊天会话在任何现有列表里都看不到）。
4. 前端最后：新增非项目路由 + 去 git 面板的布局 + 欢迎页入口 + 列表面。

> 状态：**决策已定，实现未开始。** 首个代码分片为后端-only（步骤 1–3），前端（步骤 4）再分片。
> 在两项决策落档前，`crates/db`、`crates/conversations`、`crates/local-deployment` 与前端都不应
> 动工——本 ADR 即解除该前置。
