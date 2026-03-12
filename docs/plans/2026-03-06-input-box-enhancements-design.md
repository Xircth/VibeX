# 输入框功能完善 Design

## 概述

对 `TaskFollowUpSection.tsx` 中的输入框区域进行功能增强：上方添加信息栏（diff 统计、上下文 token 预览、会话切换），下方底栏重构（模型选择器、权限选择器、Agent 选择器、Review Changes 按钮）。同时修复左栏宽度限制导致手动拖拽失效的 bug。

---

## Issue 0: 左栏宽度限制修复

**现状：** `IDELayout.tsx` 的 `onDidLayoutChange` 中每次布局变化都调用 `setSize({ width: 300 })`，导致用户拖拽调节宽度立即被重置。

**设计：** 直接移除该段强制宽度代码。左栏的 `initialWidth: 300` 在创建时已设置，不需要持续强制。

**文件：** `frontend/src/components/layout/IDELayout.tsx`

---

## Issue 1: 文件变更统计 — "xx 个文件已更改 +xx -xx"

**数据来源：** `useDiffSummary(attemptId)` hook 已存在，返回 `{ fileCount, added, deleted }`。以 `statsOnly: true` 调用后端 `subscribe_diff_stream`，只获取行统计不加载文件内容。

**设计：** 在输入框容器内、WYSIWYGEditor 上方添加一行 top bar：

```tsx
<div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
  <span>{fileCount} 个文件已更改</span>
  <span className="text-green-600">+{added}</span>
  <span className="text-red-600">-{deleted}</span>
  {/* ... 其他上方元素 */}
</div>
```

`attemptId` 从组件中已有的 `workspaceId` 获取。

**文件：** `frontend/src/components/tasks/TaskFollowUpSection.tsx`

---

## Issue 2: 上下文 Token 预览 — hover 显示 "xx%, xx k / xx k tokens"

**数据来源：** `useTokenUsage()` hook 已存在（来自 `EntriesContext`），返回 `{ total_tokens, model_context_window }`。

**设计：** 在 top bar 右侧添加一个带 Tooltip 的圆形进度指示器：

- 显示一个小圆形图标（或百分比数字）
- Hover 时 Tooltip 显示 `"62%, 128k / 200k tokens"`
- 计算方式：`percent = (total_tokens / model_context_window) * 100`
- 格式化：`Math.round(tokens / 1000) + 'k'`

**文件：** `frontend/src/components/tasks/TaskFollowUpSection.tsx`

---

## Issue 3: 会话选择器 — 下拉选择会话或新建

**数据来源：** `useWorkspaceSessions(workspaceId)` hook 已实现但未被使用，返回 `{ sessions, selectedSession, selectSession, startNewSession, isNewSessionMode }`。

**设计：** 在 top bar 右端添加下拉按钮：

- 默认显示当前会话标识（如"最新"或 session 序号）
- 下拉列表展示所有 sessions（按时间排序）
- 底部有"新建会话"选项
- 选中后调用 `selectSession(sessionId)` 或 `startNewSession()`

注意：当前 `TaskFollowUpSection` 的 session 来自 props（`attempt.session`），不是从 hook 获取。需要将 session 切换机制与已有的 props 流集成。初版可以在 top bar 显示会话列表，点击后通过回调通知父组件切换。

**文件：**
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- 可能需要修改 `frontend/src/components/panels/TaskAttemptPanel.tsx` 或 `ProjectTasks.tsx` 的 session 传递方式

---

## Issue 4: 模型选择器 — 改造 VariantSelector

**现状：** `VariantSelector` 从 `ExecutorConfig` 的 variant key 列表生成选项（如 "DEFAULT", "PLAN"）。variant 配置中 `ClaudeCode.model` 字段决定使用的模型。

**设计：** 将 `VariantSelector` 的显示方式改为显示当前 variant 对应的模型名称（友好格式），而非 variant key。如果 variant 配置中有 `model` 字段，则显示模型名（如 "Opus"、"Sonnet"）；否则显示 "Default"。

下拉选项仍然是 variant list，但每项显示友好名称。

模型名映射：
- `claude-opus-4-6` / 含 `opus` → "Opus"
- `claude-sonnet-4-6` / 含 `sonnet` → "Sonnet"
- `claude-haiku` / 含 `haiku` → "Haiku"
- `null` / 未设置 → "Default"

**文件：** `frontend/src/components/tasks/VariantSelector.tsx`

---

## Issue 5: 权限选择器 — 新增组件

**设计：** 新建 `PermissionSelector` 组件，三个选项：
- 自动（`auto`）— 播放图标 `Play`
- 询问（`ask`）— 手指图标 `HandMetal` 或 `MousePointerClick`
- 计划（`plan`）— 列表图标 `List`

当前后端 `ClaudeCode` 类型有 `approvals?: boolean` 和 `dangerously_skip_permissions?: boolean`：
- `auto` = `dangerously_skip_permissions: true`
- `ask` = `approvals: true`（默认行为）
- `plan` = `plan: true`

初版：仅做 UI 选择器，将选中模式存入本地 state。当用户发送消息时，将权限模式附加到 executor 配置中。

图标按钮样式，紧凑。点击弹出下拉菜单。

**文件：**
- 新建: `frontend/src/components/tasks/PermissionSelector.tsx`
- 修改: `frontend/src/components/tasks/TaskFollowUpSection.tsx`

---

## Issue 6: Agent 选择器 — 使用已有组件

**现状：** `AgentSelector` 组件已存在（`frontend/src/components/tasks/AgentSelector.tsx`），从 `profiles` 的 key 列表生成 agent 下拉。未在 `TaskFollowUpSection` 底栏使用。

**设计：** 在底栏添加 `AgentSelector`，紧凑内联模式。传入 `showLabel={false}`（仅显示当前 agent 名称 + ChevronDown）。

**文件：** `frontend/src/components/tasks/TaskFollowUpSection.tsx`

---

## Issue 7: PR Comment → Review Changes with Agent

**现状：** 底栏有 PR Comment 按钮（MessageSquare 图标），调用 `PrCommentsDialog.show()`。

**设计：** 替换为 "Review Changes" 按钮：
- 图标：`GitCompareArrows` 或 `FileSearch`
- 点击调用 `sessionsApi.startReview(sessionId, { executor_profile_id, additional_prompt: null, use_all_workspace_commits: true })`
- `executor_profile_id` 从当前选中的 agent + variant 获取

**文件：** `frontend/src/components/tasks/TaskFollowUpSection.tsx`

---

## Top Bar 布局

```
┌──────────────────────────────────────────────────┐
│ 90个文件已更改 +36930 -19048    ◐ 62%   最新 ▾  │
├──────────────────────────────────────────────────┤
│ [WYSIWYGEditor 输入区域]                          │
├──────────────────────────────────────────────────┤
│ [Opus▾] [>>权限] [默认▾Agent] [📎] [🔍Review] │ → [发送]
└──────────────────────────────────────────────────┘
```

## Bottom Bar 布局

左侧：模型选择器 | 权限选择器（图标） | Agent 选择器 | Attach 按钮 | Review Changes 按钮 | TodoList
右侧：停止/发送按钮
