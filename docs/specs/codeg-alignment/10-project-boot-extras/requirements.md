# Requirements: Phase 10 — Project Boot 与附加体验 (project-boot-extras)

## Objective

补齐产品体验外延：Project Boot 可视化建项向导、系统托盘与窗口状态、快速消息
库、专家（experts）配置；Pets 桌面宠物列为可选裁剪项。

对应差距：G7、G8、F8、G10。

## Acceptance Criteria (EARS)

1. Project Boot（G7）：THE SYSTEM SHALL 提供可视化新建项目页：
   - 配置面（左）：项目类型（shadcn 起步）、框架模板（Next.js/Vite/React
     Router/Astro）、样式预设（主题色/圆角/字体/图标库）、包管理器选择
     （检测已装：pnpm/npm/yarn/bun + 版本）；
   - 预览面（右）：iframe 实时渲染所选预设；
   - 创建：执行 `shadcn init` + 模板脚手架（Windows 隐藏窗口约束），完成后
     项目自动入库并打开工作区。
2. IF 脚手架命令失败，THEN 完整输出呈现给用户（可滚动日志），残留目录提示
   清理选项。
3. 托盘（G8）：THE 桌面端 SHALL 提供系统托盘（显示/隐藏主窗、退出），窗口
   位置/尺寸/缩放持久化恢复。
4. 快速消息（F8）：THE SYSTEM SHALL 提供快速消息库（预定义 prompt 模板的
   CRUD + composer 一键插入），数据入库。
5. 专家配置（F8）：THE SYSTEM SHALL 支持 experts（系统提示词预设）管理与
   会话级选用（对齐 Codeg experts 语义的最小集）。
6. Pets（G10，可选）：默认裁剪。仅当以上全部完成且产品负责人确认时实施；
   届时单独补充 spec。

## Boundaries

- Always：脚手架进程走共享进程启动层（Windows 无窗）；预览 iframe 走既有
  preview_proxy。
- Never：把模板硬编码进前端（后端提供模板注册表）。

## Success Criteria

- 用 Project Boot 创建一个 Vite+shadcn 项目并直接进入工作区开始会话；托盘/
  窗口状态重启保持；快速消息在 composer 可一键插入；全门绿。
