# VibeUltra

> 基于 [vibe-kanban](https://github.com/BloopAI/vibe-kanban) fork，针对桌面端体验深度优化的 AI 编程 Agent 任务管理工具。

<p align="center">
  <img src="frontend/public/vibe-kanban-logo.svg" alt="VibeUltra Logo" width="200">
</p>

<p align="center">
  让 Claude Code、Gemini CLI、Codex、Amp 等 AI 编程 Agent 的生产力提升 10 倍
</p>

---

## 简介

VibeUltra 是一个专为 AI 辅助编程工作流设计的桌面任务管理应用，基于 Tauri v2 构建。它解决了在使用多个 AI 编程 Agent 时面临的协调、追踪和审查问题，让你专注于规划与决策，而非繁琐的上下文切换。

### 核心功能

- **多 Agent 并行调度** — 同时运行多个 AI 编程 Agent，串行或并行执行任务
- **看板式任务管理** — 直观追踪每个 Agent 的工作状态
- **内置终端集成** — 无需切换窗口，直接在应用内查看 Agent 输出
- **代码预览与检查** — 实时预览 Agent 生成的代码，支持原生 DevTools 调试
- **统一 MCP 配置** — 集中管理所有 Agent 的 MCP（Model Context Protocol）配置
- **SSH 远程支持** — 在远程服务器上运行时，支持通过 SSH 在本地编辑器打开项目
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

> 默认以桌面模式启动，不会单独开启 Vite web 服务器。Tauri 加载 `frontend/dist`，并通过 `vite build --watch` 保持实时更新。

### 仅构建前端

```bash
cd frontend && pnpm build
```

### 从源码构建（macOS）

```bash
./local-build.sh
# 测试构建结果
cd npx-cli && node bin/cli.js
```

---

## 配置

### 环境变量

| 变量 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `PORT` | 运行时 | 自动分配 | 生产环境服务端口；开发模式下为前端端口（后端使用 PORT+1） |
| `BACKEND_PORT` | 运行时 | `0`（自动） | 后端服务端口（仅开发模式） |
| `FRONTEND_PORT` | 运行时 | `3000` | 前端开发服务端口（仅开发模式） |
| `HOST` | 运行时 | `127.0.0.1` | 后端服务绑定地址 |
| `MCP_HOST` | 运行时 | 同 `HOST` | MCP 连接地址（Windows 下 HOST=0.0.0.0 时建议设为 `127.0.0.1`） |
| `MCP_PORT` | 运行时 | 同 `BACKEND_PORT` | MCP 服务端口 |
| `DISABLE_WORKTREE_CLEANUP` | 运行时 | 未设置 | 禁用 git worktree 自动清理（调试用） |
| `VK_ALLOWED_ORIGINS` | 运行时 | 未设置 | 允许访问后端 API 的来源地址（逗号分隔） |

### 反向代理 / 自定义域名

在 nginx、Caddy、Traefik 等反向代理后运行时，必须设置 `VK_ALLOWED_ORIGINS`，否则浏览器的 `Origin` 请求头会导致 403 错误。

```bash
# 单个来源
VK_ALLOWED_ORIGINS=https://vk.example.com

# 多个来源（逗号分隔）
VK_ALLOWED_ORIGINS=https://vk.example.com,https://vk-staging.example.com
```

### SSH 远程配置

在远程服务器上部署时（如 Docker、systemctl、云主机），可配置本地编辑器通过 SSH 打开远程项目：

1. 使用 Cloudflare Tunnel、ngrok 等工具暴露 Web UI
2. 在 **设置 → 编辑器集成** 中配置：
   - **Remote SSH Host**：服务器地址
   - **Remote SSH User**：SSH 用户名（可选）
3. 确保本地已配置 SSH 密钥（免密认证）且安装了 VSCode Remote-SSH 扩展

---

## 额外开发工具

```bash
cargo install cargo-watch
cargo install sqlx-cli
```

---

## 关于本项目

VibeUltra 是 vibe-kanban 的独立 fork，专注于桌面端原生体验优化，去除了云同步、OAuth 等第三方依赖，保持轻量、私有、可自托管。

上游项目：[BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
