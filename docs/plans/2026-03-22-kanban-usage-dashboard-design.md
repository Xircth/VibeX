# Kanban Usage Dashboard Design

## Goal

在 Kanban 页面现有的两段式视图切换基础上，扩展为三段式切换：

1. Kanban 主视图
2. 会话列表 + 监控视图
3. 计量统计看板

其中计量统计看板的数据口径，明确采用 `code-referance/mossx` 中 ClaudeCode、Codex、OpenCode 的本地历史扫描方式，并聚合为“当前项目下全部会话”的 Token 与费用统计。

## Confirmed Requirements

- 入口页面：Kanban 页面
- 左侧箭头：保留，用于已有主视图与会话视图切换
- 右侧箭头：新增，用于继续切换到计量统计看板
- 切换方式：三段式滑动
  - `Kanban -> Session Hub -> Usage Dashboard`
- 统计范围：当前项目下的全部会话
- 数据来源：优先参考 `mossx` 的本地历史扫描逻辑，而不是当前系统数据库内已归档的 token 记录
- 展示结构：优先复用 `mossx` 的四标签页
  - 概览
  - 模型
  - 会话
  - 时间线

## Reference Mapping

### Current project

- 视图切换容器：`frontend/src/components/panels/DockviewKanbanPanel.tsx`
- 会话 Hub：`frontend/src/components/kanban/KanbanSessionHub.tsx`
- 会话上下文：`frontend/src/contexts/KanbanSessionContext.tsx`
- 会话布局状态：`frontend/src/lib/kanbanSessionLayout.ts`
- 会话数据聚合：`frontend/src/hooks/useKanbanProjectSessions.ts`
- Tauri 命令组织：`src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`

### mossx reference

- 前端 usage 看板：`code-referance/mossx/src/features/settings/components/UsageSection.tsx`
- Tauri 前端调用：`code-referance/mossx/src/services/tauri.ts`
- 本地 usage 扫描：`code-referance/mossx/src-tauri/src/local_usage.rs`
- usage 相关类型：`code-referance/mossx/src/types.ts`

## Architecture

### 1. View state

当前 `DockviewKanbanPanel` 使用布尔状态决定是否显示 Session Hub。该模型无法自然扩展到第三屏，因此改为枚举式视图状态更合适：

- `board`
- `sessionHub`
- `usageDashboard`

该状态由 `KanbanSessionContext` 暴露，统一管理左右箭头和当前面板位置。

### 2. Frontend composition

Kanban 容器从当前 2 屏布局扩展为 3 屏滑动布局：

- 第 1 屏：现有 `SessionKanbanBoard`
- 第 2 屏：现有 `KanbanSessionHub`
- 第 3 屏：新增 `KanbanUsageDashboard`

交互规则：

- 在 `board` 视图，左侧悬浮箭头进入 `sessionHub`
- 在 `sessionHub` 视图：
  - 左侧箭头返回 `board`
  - 右侧箭头进入 `usageDashboard`
- 在 `usageDashboard` 视图：
  - 左侧箭头返回 `sessionHub`

这样能保持用户的心智模型稳定，并延续现有滑屏过渡动画。

### 3. Usage data source

新增独立 Tauri 命令模块，专门负责“项目级 usage 聚合”。

关键差异：

- `mossx` 的 usage 面板以 workspacePath 或 all scope 为输入
- 本项目需要以 `projectId` 为输入，然后先解析该项目下所有 workspace 路径，再对这些路径进行 provider 历史扫描

后端命令建议：

- `get_project_usage_statistics(project_id, date_range)`

返回结构建议保持与 `mossx` 的 `LocalUsageStatistics` 高度兼容，但做轻度项目化扩展：

- `projectId`
- `projectName`
- `providers`
- `totalSessions`
- `totalUsage`
- `estimatedCost`
- `sessions`
- `dailyUsage`
- `weeklyComparison`
- `byModel`
- `providerStatus`
- `lastUpdated`

其中 `providerStatus` 用于表达 ClaudeCode / Codex / OpenCode 是否成功扫描，避免某一 provider 失败导致整页不可用。

## Reuse Strategy

### Backend reuse

优先复用 `mossx` 的以下设计，而不是逐行照搬：

- provider 扫描入口拆分思路
- token/cost 聚合口径
- 时间范围过滤逻辑
- daily / weekly / by-model 聚合方法
- `spawn_blocking` 扫描方式

需要改造的部分：

- 输入从 `workspacePath` 改为 `projectId -> workspace paths`
- provider 范围从单 provider 查询扩展为多 provider 合并
- 类型导出方式切换到本项目现有 `ts-rs + generate_types` 流程

### Frontend reuse

优先复用 `UsageSection.tsx` 的：

- tab 结构
- 数值格式化思路
- 会话分页与排序逻辑
- daily timeline 的数据映射

不直接复用的部分：

- settings 页面 CSS 类
- workspace picker
- scope 切换按钮

原因：

- Kanban 页面已经有自己的信息架构和视觉体系
- 当前需求口径固定为“当前项目全部会话”，不需要再暴露 workspace / current / all 选择器

## Component Design

### `KanbanUsageDashboard`

职责：

- 拉取项目级 usage 数据
- 提供四个 tab
- 渲染概览卡片、模型排行、会话列表、时间线
- 提供刷新、加载态、空态、局部失败提示

建议拆分：

- `KanbanUsageDashboard.tsx`
- `usageFormatting.ts`
- `usageTabs.ts` 或内联常量

如果组件体积过大，再拆：

- `UsageOverviewTab.tsx`
- `UsageModelsTab.tsx`
- `UsageSessionsTab.tsx`
- `UsageTimelineTab.tsx`

首版不强制拆分，遵循 KISS。

## Error Handling

- 项目无 workspace：显示空态，不报错
- 项目有 workspace 但未扫描到历史：显示“暂无计量数据”
- 某个 provider 扫描失败：
  - 页面仍展示已成功 provider 的数据
  - 顶部显示 provider 失败状态
- 扫描超时：
  - 返回明确错误消息
  - 前端保留重试按钮

## Testing Strategy

### Rust

- provider 聚合函数：覆盖多 workspace 合并
- 日期过滤：覆盖 7d / 30d / all
- 局部失败：覆盖单 provider 失败仍返回部分结果
- 空项目：返回空统计结构

### Frontend

- 三段式视图状态切换
- `board -> sessionHub -> usageDashboard` 过渡
- `usageDashboard -> sessionHub` 返回
- usage tab 的排序 / 分页 / 时间线映射

## Non-Goals

- 不在首版加入 workspace 维度切换
- 不在首版加入 provider 单独筛选器
- 不在首版重构已有 `KanbanSessionHub` 业务逻辑
- 不在首版把 usage 看板接入全局设置页

## Risks

### 1. Provider 扫描差异

ClaudeCode、Codex、OpenCode 的本地历史格式不完全一致，直接统一抽象时容易引入兼容性问题。解决方案是先在后端按 provider 独立解析，再合并成统一统计结果。

### 2. 扫描性能

本地历史文件可能较多。解决方案是：

- 限制扫描时间范围
- 在后台线程执行
- 前端使用 query cache
- 提供手动刷新而不是每次视图切换强制全量刷新

### 3. 视图状态复杂度提升

从布尔状态升级到三态枚举后，现有箭头逻辑、过渡样式、a11y 标签都需要同步调整。解决方案是把切换逻辑集中在 context 中，避免分散在多个组件。

## Implementation Summary

最终实现应满足：

- Kanban 页面支持三段式滑动切换
- Session Hub 右侧新增箭头进入 usage 看板
- usage 看板基于当前项目全部 workspace 的本地历史文件聚合
- UI 结构复用 `mossx` 的四标签页，但视觉风格保持当前项目一致
- 后端与前端都尽量复用已有模块，避免重复实现
