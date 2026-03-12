# Workspace Layout Interactions Design

## Goal

调整工作区页面的布局与交互：工作区左上角 Logo 仅显示图标且可返回首页；底部终端栏仅位于中间工作区下方且不可被拖拽移动；中间两列标签页允许相互拖动；右栏默认宽度改为 420px。

## Scope

### In scope

- 仅修改工作区页 `Toolbar` 左上角 Logo 展示方式
- 保留普通页面 `Navbar` 和设置页中的品牌文字
- 强化 Dockview 默认布局与拖拽约束
- 调整右栏默认宽度与最小宽度
- 为上述行为补充前端回归测试

### Out of scope

- 不重构右栏为 Dockview 分组
- 不重写 Dockview 标签系统
- 不修改普通页面的顶部导航结构

## Current State

- 工作区页使用 `Toolbar + Dockview + 固定右栏`
- 左栏和终端栏都在 Dockview 内部，右栏在 Dockview 外部
- 终端栏当前通过 `referencePanel: welcomePanel, direction: 'below'` 创建
- 中间第二列目前按需创建，但没有稳定地绑定到 `GROUP_IDS.CENTER_2`

## Design

### 1. Logo 行为

- 为 `Logo` 组件增加 `showText` 变体，默认仍显示文字
- 仅在 `Toolbar` 中传入 `showText={false}`
- `Toolbar` 中现有 `Link to="/local-projects"` 保留不变

### 2. 默认布局约束

- 默认布局继续以欢迎页作为中1锚点
- 显式创建：
  - 左栏 group：`GROUP_IDS.LEFT`
  - 底部终端 group：`GROUP_IDS.BOTTOM`
  - 中2 group：`GROUP_IDS.CENTER_2`
- 终端 panel 放入 `GROUP_IDS.BOTTOM`
- `GROUP_IDS.BOTTOM` 使用 `locked: 'no-drop-target'`

这样可以保证：
- 左栏始终独立
- 终端位于中间区域底部
- 中2是稳定存在的可识别目标组

### 3. 终端拖拽限制

- 在 `onWillShowOverlay` 中新增规则：只要拖动源是 `PANEL_IDS.TERMINAL`，一律 `preventDefault()`
- 对 bottom group 目标一律 `preventDefault()`，阻止任何标签页拖入终端区域
- 启动恢复布局后，如果 terminal 不在 `GROUP_IDS.BOTTOM`，则重新放回 bottom group

### 4. 中1 / 中2 标签拖动

- 保留 Dockview 自带标签拖拽能力
- 通过 DnD guard 实现“只允许中心组互拖”：
  - 左栏只允许 `FILE_TREE` / `GIT`
  - Bottom 不接受任何面板
  - 右栏不在 Dockview 中，天然不可拖入
  - 其余普通标签页可在中1/中2间移动

### 5. 右栏宽度

- `DEFAULT_RIGHT_PANEL_WIDTH` 改为 `420`
- `MIN_RIGHT_PANEL_WIDTH` 下调到不高于默认值，推荐 `360`

## Verification

- 新增源码级回归测试，覆盖：
  - `Toolbar` 使用图标版 Logo
  - 右栏默认宽度为 `420`
  - 默认布局显式创建 bottom / center2 group
  - DnD guard 禁止 terminal 和 bottom 拖放
- 运行：
  - `node --test frontend/tests/workspace-layout-constraints.test.js`
  - `pnpm run frontend:check`

