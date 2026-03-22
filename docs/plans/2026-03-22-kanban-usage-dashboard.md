# Kanban Usage Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Kanban 页面新增第三段“计量统计看板”视图，支持通过右侧箭头从“会话列表+监控”切换进入，并基于当前项目下全部 workspace 的 ClaudeCode、Codex、OpenCode 本地历史文件聚合 Token 与费用统计。

**Architecture:** 前端将 `DockviewKanbanPanel` 的双屏滑动重构为三屏枚举状态；后端新增项目级 usage 聚合命令，按 `projectId` 收集 workspace 路径，再适配复用 `mossx` 的本地 usage 扫描逻辑；前端新增 Kanban 专用 usage 面板，复用 `mossx` 的四标签页结构与数据映射思路。

**Tech Stack:** Tauri commands, Rust, ts-rs, React, TypeScript, TanStack Query, Vitest, Tailwind/shadcn

---

### Task 1: 定义项目级 usage 类型与后端命令骨架

**Files:**
- Create: `src-tauri/src/commands/local_usage.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bin/generate_types.rs`
- Test: `src-tauri/src/commands/local_usage.rs`

**Step 1: 写失败测试，定义空项目与基础聚合输出**

在 `src-tauri/src/commands/local_usage.rs` 底部新增 `#[cfg(test)]`，先写最小单测：

```rust
#[test]
fn build_empty_project_usage_statistics_returns_zeroed_result() {
    let result = build_project_usage_statistics(
        "project-1".to_string(),
        "Demo".to_string(),
        Vec::new(),
        Vec::new(),
        0,
    );

    assert_eq!(result.project_id, "project-1");
    assert_eq!(result.total_sessions, 0);
    assert_eq!(result.estimated_cost, 0.0);
    assert!(result.sessions.is_empty());
}
```

**Step 2: 运行测试，确认失败**

Run: `cargo test build_empty_project_usage_statistics_returns_zeroed_result --package vibe-ultra`

Expected: FAIL，提示函数或类型尚未定义。

**Step 3: 写最小实现**

在 `src-tauri/src/commands/local_usage.rs` 中：

- 定义 `ProjectUsageStatistics`
- 定义 `ProjectUsageProviderStatus`
- 定义基础 `build_project_usage_statistics(...)`
- 使用 `#[derive(Serialize, TS)]`

同时在：

- `src-tauri/src/commands/mod.rs` 注册 `pub mod local_usage;`
- `src-tauri/src/lib.rs` 注册 Tauri command
- `src-tauri/src/bin/generate_types.rs` 添加新类型导出

**Step 4: 运行测试，确认通过**

Run: `cargo test build_empty_project_usage_statistics_returns_zeroed_result --package vibe-ultra`

Expected: PASS

**Step 5: 提交检查点**

Run:

```bash
git add src-tauri/src/commands/local_usage.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/bin/generate_types.rs
git commit -m "feat: add project usage command skeleton"
```

### Task 2: 适配并实现项目级本地 usage 聚合

**Files:**
- Modify: `src-tauri/src/commands/local_usage.rs`
- Modify: `src-tauri/src/commands/projects.rs`
- Test: `src-tauri/src/commands/local_usage.rs`

**Step 1: 写失败测试，覆盖多 workspace 聚合与 provider 状态**

在 `src-tauri/src/commands/local_usage.rs` 新增测试：

```rust
#[test]
fn merge_provider_sessions_combines_multiple_workspaces() {
    let sessions = vec![
        fake_session("a", "gpt-5", 1000, 0.12, 100),
        fake_session("b", "claude-sonnet", 2000, 0.34, 200),
    ];

    let result = build_project_usage_statistics(
        "project-1".to_string(),
        "Demo".to_string(),
        sessions,
        vec![provider_ok("codex"), provider_ok("claude"), provider_failed("opencode", "timeout")],
        123,
    );

    assert_eq!(result.total_sessions, 2);
    assert_eq!(result.provider_status.len(), 3);
    assert_eq!(result.by_model.len(), 2);
}
```

**Step 2: 运行测试，确认失败**

Run: `cargo test merge_provider_sessions_combines_multiple_workspaces --package vibe-ultra`

Expected: FAIL，提示辅助构造函数或聚合字段不完整。

**Step 3: 写最小实现**

在 `src-tauri/src/commands/local_usage.rs` 中实现：

- 项目下 workspace 路径收集逻辑
- provider 逐个扫描
- 聚合 `sessions / daily_usage / by_model / weekly_comparison`
- 部分 provider 失败时记录到 `provider_status`
- `get_project_usage_statistics(project_id, date_range)` Tauri command

实现时参考：

- `code-referance/mossx/src-tauri/src/local_usage.rs`
- `src-tauri/src/commands/projects.rs`

要求：

- 使用 `spawn_blocking`
- 不因单个 provider 失败导致整体失败
- 日期范围只支持 `7d | 30d | all`

**Step 4: 运行测试，确认通过**

Run: `cargo test project_usage --package vibe-ultra`

Expected: PASS，新增 usage 相关测试全部通过。

**Step 5: 提交检查点**

Run:

```bash
git add src-tauri/src/commands/local_usage.rs src-tauri/src/commands/projects.rs
git commit -m "feat: add project usage aggregation"
```

### Task 3: 生成共享类型并接入前端 API

**Files:**
- Create: `frontend/src/lib/api/localUsage.ts`
- Modify: `frontend/src/lib/api/index.ts`
- Modify: `shared/types.ts`
- Test: `shared/types.ts`

**Step 1: 写失败测试或类型使用点，先让前端引用不存在的 API**

在新文件 `frontend/src/lib/api/localUsage.ts` 中先引用尚不存在的类型：

```ts
import type { ProjectUsageStatistics } from 'shared/types';

export const localUsageApi = {
  getProjectStatistics: async (
    projectId: string,
    dateRange: '7d' | '30d' | 'all'
  ): Promise<ProjectUsageStatistics> => {
    throw new Error('not implemented');
  },
};
```

**Step 2: 运行类型生成检查，确认失败或缺少类型**

Run: `pnpm run generate-types:check`

Expected: FAIL，提示新类型尚未导出，或前端类型不可用。

**Step 3: 写最小实现**

- 运行 `pnpm run generate-types`
- 在 `frontend/src/lib/api/localUsage.ts` 中调用 `tauriInvoke('get_project_usage_statistics', ...)`
- 在 `frontend/src/lib/api/index.ts` 中导出 `localUsageApi`

注意：

- 不手改 `shared/types.ts`
- 仅通过 `src-tauri/src/bin/generate_types.rs` 驱动生成

**Step 4: 运行检查，确认通过**

Run:

```bash
pnpm run generate-types:check
pnpm run check
```

Expected: PASS

**Step 5: 提交检查点**

Run:

```bash
git add frontend/src/lib/api/localUsage.ts frontend/src/lib/api/index.ts src-tauri/src/bin/generate_types.rs shared/types.ts
git commit -m "feat: expose project usage api"
```

### Task 4: 抽离三段式 Kanban 视图状态

**Files:**
- Create: `frontend/src/lib/kanbanPanelView.ts`
- Create: `frontend/src/lib/kanbanPanelView.test.ts`
- Modify: `frontend/src/contexts/KanbanSessionContext.tsx`
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`

**Step 1: 写失败测试，定义三段式切换规则**

在 `frontend/src/lib/kanbanPanelView.test.ts` 写测试：

```ts
import { describe, expect, it } from 'vitest';
import {
  getNextKanbanPanelView,
  getPreviousKanbanPanelView,
} from './kanbanPanelView';

describe('kanbanPanelView', () => {
  it('moves forward from board to session hub to usage dashboard', () => {
    expect(getNextKanbanPanelView('board')).toBe('sessionHub');
    expect(getNextKanbanPanelView('sessionHub')).toBe('usageDashboard');
  });

  it('moves backward from usage dashboard to session hub to board', () => {
    expect(getPreviousKanbanPanelView('usageDashboard')).toBe('sessionHub');
    expect(getPreviousKanbanPanelView('sessionHub')).toBe('board');
  });
});
```

**Step 2: 运行测试，确认失败**

Run: `pnpm vitest frontend/src/lib/kanbanPanelView.test.ts`

Expected: FAIL，提示模块不存在。

**Step 3: 写最小实现**

- 新建 `frontend/src/lib/kanbanPanelView.ts`
- 导出 `KanbanPanelView = 'board' | 'sessionHub' | 'usageDashboard'`
- 提供前进/后退纯函数
- 在 `frontend/src/contexts/KanbanSessionContext.tsx` 中用枚举状态替代 `isSessionHubVisible`
- 在 `frontend/src/components/panels/DockviewKanbanPanel.tsx` 中把滑动宽度从 `200%` 改为 `300%`

**Step 4: 运行测试，确认通过**

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts
pnpm run check
```

Expected: PASS

**Step 5: 提交检查点**

Run:

```bash
git add frontend/src/lib/kanbanPanelView.ts frontend/src/lib/kanbanPanelView.test.ts frontend/src/contexts/KanbanSessionContext.tsx frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "refactor: add three-stage kanban panel state"
```

### Task 5: 构建 Kanban usage 看板 UI

**Files:**
- Create: `frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.tsx`
- Create: `frontend/src/components/kanban/kanban-usage/usageFormatting.ts`
- Create: `frontend/src/hooks/useProjectUsageStatistics.ts`
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`
- Test: `frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx`

**Step 1: 写失败测试，定义基础渲染**

在 `frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx` 中写最小测试：

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KanbanUsageDashboard } from './KanbanUsageDashboard';

describe('KanbanUsageDashboard', () => {
  it('renders four tabs', () => {
    render(<KanbanUsageDashboard projectId="p1" />);
    expect(screen.getByRole('tab', { name: '概览' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '模型' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '会话' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '时间线' })).toBeInTheDocument();
  });
});
```

**Step 2: 运行测试，确认失败**

Run: `pnpm vitest frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx`

Expected: FAIL，提示组件不存在。

**Step 3: 写最小实现**

- `useProjectUsageStatistics.ts`：封装 TanStack Query
- `KanbanUsageDashboard.tsx`：实现四标签页
- `usageFormatting.ts`：放 `formatNumber / formatCost / formatDate`
- 先完成：
  - 概览卡片
  - 模型排行
  - 会话分页列表
  - 时间线柱状图
- 在 `DockviewKanbanPanel.tsx` 中挂载第三屏内容

样式要求：

- 使用当前项目现有 Tailwind / shadcn 风格
- 不直接复制 `mossx` 的 settings CSS

**Step 4: 运行测试，确认通过**

Run:

```bash
pnpm vitest frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.test.tsx
pnpm run check
```

Expected: PASS

**Step 5: 提交检查点**

Run:

```bash
git add frontend/src/components/kanban/kanban-usage/KanbanUsageDashboard.tsx frontend/src/components/kanban/kanban-usage/usageFormatting.ts frontend/src/hooks/useProjectUsageStatistics.ts frontend/src/components/panels/DockviewKanbanPanel.tsx
git commit -m "feat: add kanban usage dashboard"
```

### Task 6: 接入箭头交互与回归验证

**Files:**
- Modify: `frontend/src/components/panels/DockviewKanbanPanel.tsx`
- Modify: `frontend/src/contexts/KanbanSessionContext.tsx`
- Test: `frontend/src/lib/kanbanPanelView.test.ts`
- Test: `frontend/src/lib/kanbanSessionLayout.test.ts`

**Step 1: 写失败测试，覆盖箭头显隐与方向**

在已有测试基础上新增断言，确保：

- `board` 只显示进入 `sessionHub` 的箭头
- `sessionHub` 同时具备返回和前进
- `usageDashboard` 只显示返回

**Step 2: 运行测试，确认失败**

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
```

Expected: FAIL，提示新状态尚未完全接入。

**Step 3: 写最小实现**

在 `frontend/src/components/panels/DockviewKanbanPanel.tsx` 中：

- 增加右侧箭头
- 根据当前视图状态控制箭头显隐与 aria-label
- 保证原有 Session Hub 与会话卡点击逻辑不变

在 `frontend/src/contexts/KanbanSessionContext.tsx` 中：

- 提供 `goToBoard / goToSessionHub / goToUsageDashboard`
- 保持 `openSessionFromList`、`replaceRightSession`、`promoteMonitorSession` 现有行为不变

**Step 4: 运行验证，确认通过**

Run:

```bash
pnpm vitest frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
pnpm run check
cargo test --package vibe-ultra
```

Expected: PASS

**Step 5: 提交检查点**

Run:

```bash
git add frontend/src/components/panels/DockviewKanbanPanel.tsx frontend/src/contexts/KanbanSessionContext.tsx frontend/src/lib/kanbanPanelView.test.ts frontend/src/lib/kanbanSessionLayout.test.ts
git commit -m "feat: wire kanban usage dashboard navigation"
```

### Task 7: 最终回归与文档校验

**Files:**
- Modify: `docs/plans/2026-03-22-kanban-usage-dashboard-design.md`
- Modify: `docs/plans/2026-03-22-kanban-usage-dashboard.md`

**Step 1: 运行完整验证**

Run:

```bash
pnpm run generate-types:check
pnpm run check
cargo test --workspace
```

Expected: PASS

**Step 2: 手动验证**

手动检查：

- Kanban 默认进入主视图
- 左箭头进入 Session Hub
- 右箭头进入 Usage Dashboard
- Usage Dashboard 可以正确展示四个 tab
- 项目没有 usage 数据时显示空态
- 某个 provider 失败时显示部分成功状态

**Step 3: 更新计划文档中的实际差异**

若实现过程有偏差，回写到这两份文档，确保文档与代码一致。

**Step 4: 再次运行关键验证**

Run:

```bash
pnpm run check
cargo test --workspace
```

Expected: PASS

**Step 5: 提交最终检查点**

Run:

```bash
git add docs/plans/2026-03-22-kanban-usage-dashboard-design.md docs/plans/2026-03-22-kanban-usage-dashboard.md
git commit -m "docs: add kanban usage dashboard plan"
```
