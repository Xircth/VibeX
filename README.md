# VibeX

> 基于 [vibe-kanban](https://github.com/BloopAI/vibe-kanban) fork，针对桌面端体验深度优化的 AI 编程 Agent 任务管理工具。

<p align="center">
<img src="frontend/src/assets/vibex_logo.png" alt="VibeX Logo" width="200">
</p>

<p align="center">
  让 Claude Code、Gemini CLI、Codex、Amp 等 AI 编程 Agent 的生产力提升 10 倍
</p>

---

## 简介

VibeX 是一个专为 AI 辅助编程工作流设计的桌面任务管理应用，基于 Tauri v2 构建。它解决了在使用多个 AI 编程 Agent 时面临的协调、追踪和审查问题，让你专注于规划与决策，而非繁琐的上下文切换。

### 核心功能

- **多 Agent 并行调度** — 同时运行多个 AI 编程 Agent，串行或并行执行任务
- **看板式任务管理** — 直观追踪每个 Agent 的工作状态
- **内置终端集成** — 无需切换窗口，直接在应用内查看 Agent 输出
- **代码预览与检查** — 实时预览 Agent 生成的代码，支持原生 DevTools 调试
- **统一 MCP 配置** — 集中管理所有 Agent 的 MCP（Model Context Protocol）配置
- **Git Worktree 隔离** — 自动为每个任务创建独立的 git worktree，避免分支冲突

---

## 快速开始

### 系统要求

- [Rust](https://rustup.rs/)（最新稳定版）
- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 8

### 安装依赖

```bash
pnpm install
```

### 启动开发模式

```bash
pnpm run dev
```

等价命令：

```bash
pnpm run dev:desktop
```

> 默认以桌面模式启动。开发时会启动 Vite dev server 并通过 Tauri `devUrl` 连接，支持 HMR，CPU 占用也明显低于 `vite build --watch` 模式。

### 仅构建前端

```bash
cd frontend && pnpm build
```

---

## 额外开发工具

```bash
cargo install cargo-watch
cargo install sqlx-cli
```

---

## 关于本项目

VibeX 是 vibe-kanban 的独立 fork，专注于桌面端原生体验优化，去除了云同步、OAuth 等第三方依赖，保持轻量、私有、可自托管。

上游项目：[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
