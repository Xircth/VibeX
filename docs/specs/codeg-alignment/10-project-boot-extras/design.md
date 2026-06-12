# Design: Phase 10 — Project Boot 与附加体验

## 所属层

- 后端：`src-tauri/src/commands/project_boot.rs`（新）、托盘
  `src-tauri/src/lib.rs` + tauri tray API、`quick_messages`/`experts` 表与
  命令
- 前端：新路由 `/project-boot` 页（双栏：配置+iframe 预览）、设置页快速消息
  与 experts 分区、composer 插入点

## 参照实现（Codeg）

`commands/project_boot.rs`（包管理器检测、shadcn init 执行、模板注册）、
`app/project-boot/*`（20+ 组件的双栏布局与预设模型）、`commands/windows.rs`
（托盘/缩放持久化）、`settings/quick-messages`、`settings/experts`。

## 要点

1. 包管理器检测：`<pm> --version` 并发探测（隐藏窗口），缓存会话期。
2. 预览：静态预设渲染页（本地 HTML 模板 + CSS 变量注入）经 preview_proxy
   提供给 iframe；不真实跑脚手架预览（Codeg 同策略）。
3. 脚手架执行：流式日志事件（复用终端输出通道语义）。
4. 托盘：tauri tray + window-state 插件（已有依赖则复用，无则记录新增
   `tauri-plugin-window-state`——Codeg 同款）。
5. experts 最小集：名称 + 系统提示词 + 适用 Agent 类型；会话创建时注入。

## 测试策略

- 包管理器检测：表驱动（含未安装路径）。
- 模板注册表：序列化往返。
- quick messages/experts：CRUD 命令测试 + composer 插入 vitest。
- Project Boot 端到端：真实创建一次（冒烟，CI 跳过）。

## 风险

- shadcn init 交互式提问导致挂起：全参数化非交互调用，超时保护。
