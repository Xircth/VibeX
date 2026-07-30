# VibeX

**一个本地优先的 AI 编程 Agent 协作工作台。**

[下载最新版本](https://github.com/Xircth/VibeX/releases/latest) ·
[反馈问题](https://github.com/Xircth/VibeX/issues) ·
[Apache-2.0 License](./LICENSE)

[图片描述：VibeX 主界面总览，展示项目导航、Agent 会话、文件树、终端、Diff 与浏览器预览]

VibeX 将 AI Agent、项目工作区、Git、终端、文件预览和代码审查放进同一个桌面应用。你可以同时推进多个开发任务，持续观察 Agent 的执行过程，并在接受、继续或合并改动前保留人工判断。

VibeX 使用 Tauri、Rust 与 React 构建，支持 macOS、Windows 和 Linux。目前项目仍在快速迭代，适合希望尝试本地 AI 编程工作流的开发者。

## 支持的 Agent

VibeX 通过 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 接入本地 Agent Runtime。

| 类型 | Agent |
| --- | --- |
| 重点适配 | Claude Code、Codex、OpenCode |
| 当前可配置 | Gemini CLI、Cline、OpenClaw、Hermes |

VibeX 不会把这些 Agent 的可执行文件直接捆绑进安装包。实际可用性取决于本机的 Runtime、ACP 适配器、版本和认证状态；应用会在设置中检测这些条件并显示修复入口。

## 多 Agent 协作

你可以为同一项目创建多个独立会话，让不同 Agent 分别处理实现、测试、审查或修复任务。每个会话保留自己的消息、工具调用、权限请求、文件变更和执行状态。

支持委派的 Agent 还可以把子任务交给其他 Agent。VibeX 会在父会话中展示子任务的执行状态、目标 Agent 和最终结果，并允许继续查看对应的子会话。

[图片描述：多 Agent 并行工作与子任务委派界面，展示父会话、子 Agent 状态和执行结果]

## 一体化工作区

### 会话与任务

- 使用项目、工作区和看板组织多个开发任务。
- 实时查看 Agent 消息、思考过程、工具调用、权限请求和运行状态。
- 支持继续对话、取消、重试、搜索、导入、导出和会话分叉。
- 应用异常退出后恢复会话上下文，但不会自动重放可能产生副作用的在途任务。

### 文件、Diff 与 Git

- 在文件树中浏览代码、文本、图片、PDF 和常见 Office 文件。
- 按文件查看 Diff、变更统计和提交历史，并为代码审查添加评论。
- 管理分支、暂存区、提交、stash、rebase、Pull Request 等常用 Git 操作。
- 使用 Git worktree 隔离任务，降低多个 Agent 同时修改项目时的相互影响。

### 终端与浏览器

- 在工作区中创建和管理终端，持续观察开发服务器与脚本输出。
- 使用内置 Chromium 浏览器访问本地开发服务，支持标签页、设备尺寸模拟和 DevTools。
- 选取页面元素并把 DOM 与源文件线索带回会话，缩短“发现问题—定位代码—继续修改”的路径。

### Office 文件预览

VibeX 可以预览 `.docx`、`.xlsx` 和 `.pptx` 文件。安装 `officecli` 后可获得实时预览；未安装时，`.docx` 仍提供只读内容预览。

[图片描述：VibeX 工作区组合视图，展示会话、代码 Diff、终端、浏览器和 Office 文件预览]

## 核心特点

- **本地优先**：项目路径、工作区状态、会话记录和应用配置主要保存在本机。
- **过程可检查**：Agent 输出、工具调用、权限请求、终端日志和文件变更都有明确的查看入口。
- **任务相互隔离**：通过独立工作区和 Git worktree 管理并行开发任务。
- **保持人工控制**：VibeX 负责组织和加速工作流，代码审查、测试与发布决策仍由开发者完成。
- **桌面端自动更新**：发布版本通过签名清单检查、下载并安装更新。

## 下载与安装

前往 [GitHub Releases](https://github.com/Xircth/VibeX/releases/latest) 下载适合系统的安装包。

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| Windows | x64 | `.exe`、`.msi` |
| macOS | Intel、Apple Silicon | `.dmg` |
| Linux | x64 | `.deb`、`.AppImage` |

Windows 与 macOS 安装包目前可能未经过平台代码签名或公证，因此系统可能显示未知开发者或安全警告。请只从本仓库的 Releases 页面下载安装包，并自行确认文件来源。

首次启动后，请前往 Agent 设置检查所需 CLI、ACP 适配器和登录状态。不同 Agent 可能还需要各自的账号或 API 配置。

## 本地开发

### 环境要求

- [Rust](https://rustup.rs/) 最新稳定版
- [Node.js](https://nodejs.org/) 18 或更高版本
- [pnpm](https://pnpm.io/) 8 或更高版本
- 至少一个已安装并完成认证的 Agent CLI

### 启动项目

```bash
pnpm install
pnpm run dev
```

`pnpm run dev` 会启动 Tauri 桌面应用和支持热更新的 Vite 开发服务器。

### 检查与测试

```bash
pnpm run check
pnpm run lint
cd frontend && pnpm test
cargo test --workspace
```

### 构建桌面安装包

```bash
pnpm run tauri:build
```

该命令会根据当前操作系统生成原生安装包。需要通过 GitHub Actions 构建全部桌面平台时，可以运行：

```bash
pnpm run tauri:build:all
```

## 项目结构

```text
crates/        Rust workspace：Agent、数据库、Git、服务与执行模块
frontend/      React + TypeScript + Vite 前端
src-tauri/     Tauri 桌面壳、系统集成与 IPC 命令
shared/        由 Rust 生成的共享 TypeScript 类型
scripts/       开发、检查、打包与发布脚本
```

`shared/types.ts` 是生成文件。修改共享 Rust 类型后，请运行 `pnpm run generate-types`，不要直接编辑该文件。

## 隐私与安全

VibeX 是本地优先应用，但不是离线模型。Agent 请求由你配置的本地 CLI 或 ACP Runtime 发起，网络连接、数据处理和账号策略取决于相应的模型供应商。

请在执行前确认 Agent 的权限模式，并在提交或发布前检查终端输出与代码 Diff。IM 渠道密钥目前以权限为 `0600` 的明文文件保存在 `~/.vibex/.env`，请妥善保护和备份该目录。

## 参与贡献

欢迎通过 [Issues](https://github.com/Xircth/VibeX/issues) 报告问题或提出建议，也欢迎提交 Pull Request。提交代码前请运行与改动范围对应的检查和测试。

## 致谢

VibeX 基于 [Tauri](https://tauri.app/)、[React](https://react.dev/)、[Rust](https://www.rust-lang.org/) 和 [Agent Client Protocol](https://agentclientprotocol.com/) 构建。

## License

VibeX 使用 [Apache License 2.0](./LICENSE) 开源。
