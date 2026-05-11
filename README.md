# VibeX

VibeX 是一个面向 AI 编程工作流的桌面任务管理与执行工作台。它把 Claude Code、OpenCode、Codex 三类 AI Agent 放到同一个本地界面中管理，让你可以围绕项目、工作区、会话、终端、预览和代码变更组织完整开发过程。

<p align="center">
<img src="frontend/src/assets/vibex_logo.png" alt="VibeX Logo" width="200">
</p>

---

## 项目定位

AI 编程工具越来越强，但真实开发并不只是“发一条 prompt 等结果”。一个完整任务往往包含需求澄清、分支隔离、上下文准备、Agent 执行、终端观察、预览验证、代码审查、后续修复和提交合并。VibeX 的目标是把这些环节收束到一个本地桌面工作台中，减少在终端、浏览器、编辑器和多个 Agent CLI 之间反复切换的成本。

VibeX 更适合以下使用方式：

- 同时维护多个项目、工作区或任务分支。
- 希望每个任务都有独立 worktree，避免不同 Agent 互相污染改动。
- 需要在执行过程中实时查看终端输出、代码 diff、预览页面和会话上下文。
- 需要本地优先、可自托管、可检查配置文件的桌面应用。

---

## 核心能力

### 多 Agent 工作台

VibeX 当前聚焦三类编程代理：

- **Claude Code**：适合复杂需求理解、重构、长上下文代码任务。
- **OpenCode**：适合可配置 Provider、MCP、会话和模型管理的开放式工作流。
- **Codex**：适合严格的代码修改、审查、测试和自动化执行流程。

应用会把这些 Agent 的配置、可用状态、终端会话、输出日志和执行结果统一呈现。你可以按任务选择不同 Agent，也可以在后续追问中切换更合适的执行配置。

### 任务与会话管理

- 使用看板式视图组织任务状态。
- 每个任务可以关联独立会话和执行历史。
- 支持后续追问、重试、继续执行和会话恢复。
- 对执行中的 Agent 展示实时日志、工具调用、文件修改与结果状态。
- 支持把任务上下文、点击的预览元素、文件引用等内容插入到输入框。

### Git Worktree 隔离

VibeX 会围绕工作区和任务创建独立的 git worktree，让不同任务的修改彼此隔离。这样可以更安全地并行运行多个 Agent，减少分支冲突，也方便单独审查、测试和回滚某一次任务改动。

### 代码审查与 Diff 视图

- 统一展示 Agent 修改的文件。
- 支持按文件查看 diff 和变更统计。
- 支持 Git 面板中的分支、提交和工作区状态查看。
- 适合在接受 Agent 改动前做人工检查。

### 开发服务器预览

VibeX 可以检测并展示开发服务器地址，把前端预览嵌入到桌面应用中。预览面板支持：

- 自动识别本地 dev server URL。
- 桌面、平板、手机尺寸切换。
- 页面控制台与网络请求观察。
- 点选页面元素并把组件、DOM 片段、源文件位置插入到任务输入框。

### MCP 与本地配置

VibeX 支持集中查看和编辑 Agent 相关配置，包括：

- Claude Code 本地 settings。
- Codex config/auth。
- OpenCode config/auth。
- MCP Server 配置。
- Agent 安装状态与版本检测。

配置仍然保留在本机，便于你用熟悉的 CLI 或编辑器直接检查。

---

## 系统要求

- [Rust](https://rustup.rs/) 最新稳定版
- [Node.js](https://nodejs.org/) 18 或更高版本
- [pnpm](https://pnpm.io/) 8 或更高版本
- 已安装并登录你要使用的 Agent CLI：
  - Claude Code
  - OpenCode
  - Codex

---

## 快速开始

安装依赖：

```bash
pnpm install
```

启动开发模式：

```bash
pnpm run dev
```

该命令会启动 Tauri 桌面端，并连接 Vite dev server 以保留 HMR 热更新。

等价桌面开发命令：

```bash
pnpm run dev:desktop
```

仅构建前端：

```bash
cd frontend
pnpm build
```

常用检查命令：

```bash
pnpm run check
pnpm run backend:check
cargo test --workspace
```

---

## 项目结构

```text
crates/        Rust workspace：服务、数据库、执行器、部署与工具模块
frontend/      React + TypeScript + Vite 前端
src-tauri/     Tauri 桌面壳与系统命令
shared/        Rust 生成的 TypeScript 类型
docs/          项目文档与设计记录
npx-cli/       npm CLI 包相关文件
scripts/       开发、构建和环境辅助脚本
```

`shared/types.ts` 由 Rust 类型生成，请不要手动编辑。修改共享类型后运行：

```bash
pnpm run generate-types
```

---

## 设计原则

- **本地优先**：项目、配置、会话和执行过程尽量保留在本机。
- **可检查**：重要行为尽量有日志、diff、终端输出或配置文件可追踪。
- **隔离执行**：通过 worktree 降低并行任务之间的互相影响。
- **少打断**：把 Agent 输出、预览、代码变更和后续输入组织到同一个任务视图中。
- **不替代人工判断**：VibeX 帮你组织和加速工作流，但最终代码审查、测试和发布决策仍应由开发者确认。

---

## 适用场景

- 用 AI Agent 快速实现中小型功能。
- 对大型重构进行分阶段拆解和验证。
- 在多个 Agent 之间对比同一任务的执行效果。
- 让 Agent 修复测试失败、构建错误或 UI 回归。
- 在前端预览中选中具体元素，要求 Agent 针对该组件修改。
- 对 Agent 生成的代码进行集中审查和后续追问。

---

## 开发工具

推荐安装：

```bash
cargo install cargo-watch
cargo install sqlx-cli
```

常用命令：

```bash
pnpm run backend:dev:watch
pnpm run prepare-db
pnpm run frontend:build
```

---

## 项目状态

VibeX 仍在快速迭代中。当前重点是提升桌面端 AI 编程体验、增强 ACP 兼容性、完善 Agent 配置管理、改进预览调试能力，并让多任务、多 worktree、多 Agent 的协作流程更加稳定。
