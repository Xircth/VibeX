# UI Fixes Batch 7 Design

## 问题列表与设计方案

---

## 1. 字符显示不连续（font-mono 间距问题）

**根因：** `tailwind.legacy.config.js` 的 `font-mono` 映射到 IBM Plex Mono，该字体本身字间距较宽，且没有 `tracking-tight` 补偿。在 `BranchInfoHeader.tsx`、`CommitGraph.tsx` 等用了 `font-mono` 的组件中，字符视觉上分离。

**修复：** 在 `tailwind.legacy.config.js` 的 `fontFamily` 定义中，为 `mono` 添加 `letter-spacing` 配置，或在使用 `font-mono` 的组件上加 `tracking-tight` 类（Tailwind 的 `letter-spacing: -0.025em`）。

具体：全局搜索使用 `font-mono` 的分支名/hash 渲染位置，统一加 `tracking-tight`：
- `BranchInfoHeader.tsx` — 分支名 span
- `CommitGraph.tsx` — hash span 和 ref badge

---

## 2. Diff 文件内容显示 "Content omitted due to file size"

**根因：** 后端 `contentOmitted=true` 时前端直接显示提示，没有交互。`handleOpenInIDE` 函数已存在但未暴露给用户。

**修复：** 在 `DiffCard.tsx` 的 omitted 提示文字旁添加"在编辑器中打开"按钮，调用已有的 `handleOpenInIDE` 函数。不改动后端逻辑。

---

## 3. Diff Changes 改为树形目录结构

**根因：** `DockviewDiffsReviewPanel.tsx` 的 Changes 侧边栏用扁平列表。

**设计：** 新建 `DiffFileTree` 组件：
- 按 `/` 分割路径，构建树状节点结构
- 每个目录节点可折叠展开（默认展开）
- 文件节点点击触发原有的 scroll-to-diff 逻辑
- 目录节点显示子文件数量 badge
- 缩进使用 `pl-4` 层级

---

## 4. 用户消息边框改黑色

**修复：** `UserMessage.tsx` 第57行：`border-green-400` → `border-foreground/20`（跟随主题，避免硬编码黑色在暗色主题下不好看）。

---

## 5. 停止按钮完全没有反应

**根因：** 停止按钮只在 `isAttemptRunning` 为 true 时渲染。`isAttemptRunning` 来自 `useAttemptExecution(workspaceId, taskId)`，当 `workspaceId`（即 `session?.workspace_id`）为 `undefined` 时，hook 内部无法订阅进程状态，`isAttemptRunning` 永远 false，停止按钮从不显示。

**修复：** 在 `TaskFollowUpSection.tsx` 中，将 `workspaceId` fallback 改为也可以从 `task` 本身获取当前 attempt 的 workspace_id。或者直接用 `attempt.id`（已有通过 props 传入的路径）。

具体：`TaskAttemptPanel` 已经有 `attempt.id`（即 workspace id），可以将 `attempt.id` 直接作为 `workspaceId` 传给 `TaskFollowUpSection`，而不是依赖 `session?.workspace_id`。

---

## 6. Rebase Back 有 loading 但无效果

**根因：** `BranchInfoHeader.tsx` 的 `handleRebaseBack`：
1. `attemptsApi.rebaseBack` 返回 `Result<void, GitOperationError>`（不抛出）
2. 代码没有检查 `result.success`
3. 成功后没有 `invalidateQueries` 刷新 branch status

**修复：**
```tsx
const result = await attemptsApi.rebaseBack(worktreeId, repoId);
if (!result.success) {
  // 显示错误
  return;
}
// invalidate branch status query
queryClient.invalidateQueries({ queryKey: ['branch-status', worktreeId] });
```

---

## 7. 回基时报错 "Rebase-back failed: --- stdout"

**根因：** Rust `rebase_back_workspace` 命令在 git rebase 失败时（如无法找到公共 ancestor、目录路径问题）返回包含原始 stdout 的错误消息。"--- stdout" 是错误消息的分隔符。

**修复：** 在前端 `BranchInfoHeader.tsx` 中正确解析 `GitOperationError`，显示友好错误提示而非原始错误字符串。同时在 Rust 端检查返回的错误消息格式，确保 stdout 不为空时才包含。

---

## 8. Logs 按钮改为执行进程列表

**修复：** `RightPanelSidebar.tsx` 中将 logs 按钮的 `onClick` 从 `openLogs` 改为打开 `ViewProcessesDialog`（`frontend/src/components/dialogs/tasks/ViewProcessesDialog.tsx` 已存在）。图标从 `FileText` 改为 `List`（更符合"进程列表"语义）。

---

## 9. 终端占据左栏区域

**根因：** `buildDefaultLayout` 用 `direction: 'below'` 相对于欢迎面板放置终端，运行时如果欢迎面板关闭或拖动，终端可能漂移到左侧 group。`validateTerminalPosition` 有防护但不够强。

**修复：** 在 `validateTerminalPosition`（`IDELayout.tsx`）中，判断终端 group ID 是否为 `GROUP_IDS.LEFT`，若是则强制移回底部：
```typescript
if (terminalPanel?.group?.id === GROUP_IDS.LEFT) {
  // 将终端移到正确位置
}
```
同时在 `BOTTOM_PANEL_IDS` 集合检查中也用 `group.id` 而非 panels 内容识别。

---

## 10. 终端标签页名称与类型一致

**修复：** `useTerminalStore.ts` 的 `addSession`：
- `type === 'pty'` 且无自定义 title → `"终端 N"`
- `type === 'log-viewer'` 且无自定义 title → `"日志 N"`
- 有自定义 title（如 DevServer）→ 保持不变

---

## 11. 文件预览不在中2栏显示 + 标签不能跨组拖动

**预览修复：** `PanelActionsContext.tsx` 的 `openFilePreview` 改为优先查找 `GROUP_IDS.CENTER_2` 所在 group：
```typescript
// 优先用 center-2 group
const center2Group = dockviewApi.groups.find(g => g.id === GROUP_IDS.CENTER_2);
const targetGroup = center2Group || emptyGroup || centerGroups[0];
```

**拖动修复：** Dockview 在 `disableFloatingGroups={true}` 时跨组拖动依然支持，但需要确保两个中心 group 都没有 `locked` 属性。检查 `registerDndGuard` 是否阻止了合法的跨中心组拖动，如果是则放开中心组间的拖动限制。

---

## 12. 关闭中2栏后左栏超出宽度

**根因：** 关闭 center-2 panel 后，dockview 把空余空间分配给相邻 group。左侧 group 没有 `maximumWidth` 硬约束，`initialWidth: 300` 只是初始值。

**修复：** 在 `IDELayout.tsx` 的 `onDidLayoutChange` 回调中，检测并钳制左侧 group 宽度：
```typescript
api.onDidLayoutChange(() => {
  const leftGroup = api.groups.find(g => g.id === GROUP_IDS.LEFT);
  if (leftGroup) {
    const el = leftGroup.element;
    const currentWidth = el.getBoundingClientRect().width;
    if (currentWidth > 300) {
      // 通过 dockview API 或直接 style 限制
      (el as HTMLElement).style.maxWidth = '300px';
    }
  }
  setSerializedLayout(api.toJSON());
});
```
或者通过 CSS 选择器对 `[data-group-id="group-left"]` 设置 `max-width: 300px`。

---

## 优先级排序（实施顺序）

1. 字符显示（tracking-tight，影响所有地方）
2. 停止按钮（workspaceId 传递修复）
3. Rebase Back（Result 检查 + query invalidation）
4. 用户消息边框色
5. Diff: Content omitted 按钮
6. Diff: 树形目录
7. Logs → 进程列表
8. 终端标签名
9. 终端占左栏
10. 文件预览中2栏
11. 关闭中2栏宽度修复
