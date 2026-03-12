# Terminal Defaults And Preview Balance Design

## Goal

完善工作区终端与预览标签逻辑：将终端栏默认高度调整为 350px，修复终端栏 `+` 无效问题，为默认终端增加通用设置项，并优化文件预览标签页在中1/中2之间的分配与拖拽体验。

## Scope

### In scope

- 调整 bottom terminal group 的默认高度为 `350px`
- 修复终端栏 `+` 创建终端无效的问题
- 在通用设置页增加“默认终端”配置项
- 打开文件预览时实现“有空占空，无空占少”
- 修复中1 / 中2 普通标签页之间拖动失效的问题

### Out of scope

- 不移除终端栏顶部 shell 下拉
- 不新增项目级终端配置
- 不修改左栏、右栏的布局模型

## Root Causes

### 1. 终端 `+` 无效

当前 `TerminalHeaderActions.tsx` 用 `activeWorktreeId || projectId || 'default'` 作为 session key，而 `DockviewTerminalPanel.tsx` 只读取 `activeWorktreeId`。这会导致新建终端可能写入错误 key，界面上看起来像“没反应”。

同时，终端头部按钮位于 dockview header actions 区，若不阻止事件冒泡，点击容易被 header 拖拽/焦点逻辑干扰。

### 2. 默认终端设置缺失

当前 shell 下拉仅在 `TerminalHeaderActions` 内部使用本地状态，没有统一的全局默认来源。

### 3. 文件预览分配策略不平衡

`openFilePreview` 现在偏向固定目标列，没有在“两列都可见”时执行“有空占空，无空占少”。

### 4. 中1 / 中2 标签拖拽异常

现有拖放规则主要在防御左栏 / bottom 区，但没有把“中心组互拖”显式定义为允许路径；同时中心组的“有效内容数”没有和欢迎占位 panel 区分。

## Design

### 1. 统一终端偏好与 workspace key

新增前端终端偏好辅助模块，集中定义：

- 终端选项列表
- 默认 terminal height 常量
- 默认终端值解析
- 终端 workspace key 解析（仅使用 `activeWorktreeId`）

这样可避免 `DockviewTerminalPanel`、`TerminalHeaderActions`、`GeneralSettings` 三处重复逻辑。

### 2. 默认终端设置

默认终端作为**通用设置项**存入用户配置：

- 字段名：`default_terminal_shell`
- 类型：`Option<String>`（后端）/ `string | null`（前端运行时）
- 合法值：`powershell.exe`、`cmd.exe`、`bash`、`null`

由于当前仓库里的共享类型生成入口缺失，本次不手改 `shared/types.ts`，而是在前端通过局部扩展类型读取该字段，同时在 Rust 配置版本中正式保存它。

### 3. 终端创建逻辑

- `DockviewTerminalPanel` 首次自动创建终端时使用默认终端
- `TerminalHeaderActions` 下拉初始值来自默认终端
- 用户手动修改下拉后，仅影响当前终端栏后续新建终端，不立即写回全局设置
- `+` 按钮与下拉增加事件阻断，避免 Dockview header 拖拽吞掉点击

### 4. 文件预览分配策略

仅针对 `openFilePreview` 调整：

- 当中1、中2都可见：
  - 先找“有效内容数”为 `0` 的列
  - 若都非空，则选有效内容更少的列
- 当只有一个中心列可见：使用该列
- 欢迎占位 panel 不计入“有效内容数”

### 5. 中心列拖拽规则

将拖放规则显式抽象为：

- 左栏只接受 `FILE_TREE` / `GIT`
- bottom terminal group 不接受任何拖入
- `TERMINAL` 自身不可被拖动
- 其余普通标签在 center groups 间显式允许互拖

## Verification

- 新增回归测试覆盖：
  - 终端默认高度 `350`
  - `+` 使用统一 workspace key 与默认终端来源
  - 通用设置页存在默认终端设置项
  - 文件预览采用“有空占空，无空占少”
  - 中心组间拖放允许、左/底部仍受限
- 运行：
  - `node --test frontend/tests/terminal-defaults-and-preview-balance.test.js`
  - `pnpm run frontend:check`
  - `pnpm run backend:check`
