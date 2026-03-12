# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <strong>简体中文</strong> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）是一个面向多 Agent 的企业级代码生成工作台。
它把 Claude Code、Codex CLI、OpenCode、Gemini CLI 等本地 AI 编码代理统一到一个桌面应用中，支持会话聚合、并行 `git worktree` 开发、MCP/Skills 管理，以及 Git/文件/终端一体化工作流。

## 主界面

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## 会话平铺显示

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> 当前版本：`v0.1.x`（快速迭代中）

## 核心亮点

- 多 Agent 统一工作台
- 本地会话聚合与结构化展示
- 内置 `git worktree` 并行开发
- MCP 管理（本地扫描 + 市场搜索/安装）
- Skills 管理（全局与项目级）
- 文件树、Diff、Git、提交、终端一体化

## 支持范围

### 1) 会话解析（历史会话）

| Agent | 环境变量优先路径 | macOS / Linux 默认路径 | Windows 默认路径 |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |

### 2) ACP 实时会话

内置 20+ Agent 适配器（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、OpenClaw 等）。

### 3) Skills 设置页支持

- 已支持：`Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw`
- 其他代理将持续补齐

### 4) MCP 目标应用

当前支持写入：Claude Code、Codex、OpenCode。

## 快速开始

### 环境要求

- Node.js `>=22`
- pnpm `>=10`
- Rust stable（2021 edition）
- Tauri 2 构建依赖

### 开发命令

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# 在 src-tauri/ 下执行
cargo check
cargo clippy
cargo build
```

## 架构概览

```text
Next.js 16 (Static Export) + React 19
        |
        | invoke()
        v
Tauri 2 Commands (Rust)
  |- ACP Manager
  |- Parsers
  |- Git / File Tree / Terminal
  |- MCP marketplace + local config writer
  |- SeaORM + SQLite
```

## 开发约束

- 前端静态导出（`output: "export"`）
- 不使用动态路由（`[param]`），统一查询参数
- 前端参数 `camelCase`，Rust 参数 `snake_case`
- TypeScript strict

## 隐私与安全

- 默认本地优先
- 仅在用户触发时访问网络
- 支持系统代理

## 许可证

Apache-2.0，详见 `LICENSE`。
