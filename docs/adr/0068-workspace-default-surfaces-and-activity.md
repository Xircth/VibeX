---
status: accepted
date: 2026-08-31
decision-makers:
  - VibeX maintainers
---

# Workspace 默认面、活动面与桌面通知

本 ADR 固定 Workspace 打开后用户实际碰到的默认工作区、终端、活动列表、
会话时间线与失焦通知的产品事实。它不恢复已退役的 CLI-executor /
`ExecutionProcess` 跑 Agent 路径。

## Context

打开项目、看会话、跑长期命令、回看一次 Turn 花了多久，是同一条日常闭环。
当前实现把这些面接到了过期或错误的事实上：

- 失焦桌面通知窗口是未透明的原生矩形，盖住了已设计好的 toast 卡片。
- 折叠 Turn 时，live overlay 会再追加一条已经存在的 assistant 文本，折叠边界
  两侧各渲染一次同一条消息。
- `files_changed` 卡片不受消息流宽度约束。
- Web Preview 地址栏回车把 URL 交给「打开新标签」，而不是当前预览面。
- ACP `session/create_terminal` 已在 Host 里拉起长期进程并广播生命周期，
  但 Workspace 终端列表没有消费者，所以 `Codex-01` 这类标签不会出现。
- 右侧「执行进程」仍读 `ExecutionProcess`。Agent 已不走这条路径，对话框是空的。
- Notes 输入框吃到全局 `textarea` 圆角且没有内边距，第一个字被裁切。
- 右上角 Toggle 只有「隐藏编辑区和终端区」走 i18n，其余写死英文。
- 打开项目后的默认 Workspace 优先 Git Worktree，而不是项目文件夹当前分支。

## Decision

### 1. 失焦桌面通知是透明宿主

`desktop-toast` 窗口必须是无装饰、无阴影、背景 alpha=0 的透明宿主。
原生窗口不得再铺一层不透明白底。内容只由 toast 卡片占用；窗口其余区域
点击穿透到桌面不可得时，至少在视觉上完全透明。

### 2. 一条 assistant 文本只渲染一次

Conversation store 把 streaming overlay 合并进**已有** text/thinking block，
不得因 overlay 再追加一条相同文本。折叠 Turn 时，prelude 不得包含与
未折叠首条 markdown 相同的文本。折叠只隐藏过程，不复制终态消息。

### 3. Turn 文件变更卡片属于消息流

`TurnFileChangesCard` 的宽度、左右边距与同一 Turn 的消息流一致，不得撑出
会话列。

### 4. Web Preview 地址栏导航当前标签

在已打开的 Web Preview 里输入 URL 并回车，只导航**这个**预览面的当前
browser tab。`onOpenExternalTab` 只服务于 popup / `window.open`。
空白启动面输入第一个 URL 也在本标签内创建 browser tab，不新开 Dockview 面板。

### 5. Agent 长期终端是 ACP 终端事实的投影

Agent 通过 ACP `session/create_terminal` 拉起的长期命令（如 `pnpm run dev`）
投影为当前 Workspace 终端列表中的只读标签：

- 名称：`{AgentDisplayName}-{nn}`，例如 `Codex-01`。序号按该 Workspace 内
  同一 Agent 显示名递增。
- 来源：ACP 终端 registry 的 Created / Exited / Released，加上启动时的
  存活快照。不是旧 executor 日志查看器，也不是用户 PTY。
- 生命周期：命令退出或 Agent release 后从列表移除。用户不能向其写入。

用户自己开的 PTY 终端与 Agent 长期终端共用同一终端面板，用来源区分。

### 6. 工作区活动面取代空的 ExecutionProcess 对话框

右侧栏「执行进程」打开工作区活动列表，事实来源按三类分开，互不假装：

1. **Agent 会话进程** — 当前工作区的 Conversation。点击后用该会话事件投影
   出时间跨度图（输入、输出、Tool、子 Agent / 委派），参考 DeepSeek Harness
   的会话跨度可视化。时长只使用 Turn / Tool / 委派上已有的时间事实，
   缺失就保持缺失。
2. **后台任务** — 仍在跑的 Agent 长期终端，以及脚本类 `ExecutionProcess`
   （setup / cleanup / archive / devserver）。
3. **错误与警告** — 会话 notice、失败 Turn、后台任务失败。不是装饰性空状态。

不把 Agent Turn 再写成 `ExecutionProcess`。

### 7. Notes 输入面不是控件框

Notes 标签的可输入区是内容面：无圆角裁切、有足够内边距。不套用全局
`textarea` 控件圆角。

### 8. Toggle 文案跟随应用语言

Workspace 右上角 Toggle（文件树、编辑区/终端区、终端、AI 面板、重置布局）
以及同一条工具栏上的 Kanban / Workspace 名称，全部走 i18n。中文界面显示中文。

### 9. 默认工作区是项目文件夹当前分支

从首页选择文件夹进入项目后，Workspace 默认面是 **项目仓库目录本身、当前
检出分支**（`use_worktree: false` 的 project-root workspace）。

即使仓库已有 Git Worktree，也不得因为「最近更新」或「同名分支上存在
worktree workspace」就把默认面切到 worktree。Worktree 仍可被用户显式选择。

`ensure_root_workspace` 与分支选项优先级必须与此一致：同一分支上
project-root 优先于 worktree。

## Consequences

- 桌面通知、终端列表、活动面、默认工作区都以当前 ACP / Conversation /
  Workspace 事实为单一来源，不再并联一套 executor 进程模型。
- 前端终端 store 增加 ACP 来源标签；Host 增加存活终端列表与退出生命周期。
- 分支选择器与 Toolbar 回退工作区的测试必须锁定「当前分支的项目目录优先」。

## Considered Options

- 恢复旧 executor 终端捕获：否决。Agent 已不在该路径上运行。
- 把活动面做成 ExecutionProcess 的兼容层：否决。空列表正是该层已经失效的证据。
- 默认打开最近 worktree：否决。用户打开的是项目文件夹，不是 isolation worktree。
