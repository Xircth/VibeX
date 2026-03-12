# AGENTS.md

This file provides guidance to Code Agent when working with code in this repository.

## 项目概述

codeg 是一个桌面应用，用于聚合和浏览本地 AI 编码代理的会话记录。它从多个代理（Claude Code、Codex、OpenCode）的本地文件系统中读取会话数据，统一格式后在 UI 中展示。

## 技术栈

- **桌面运行时**: Tauri 2（Rust 后端 + webview 前端）
- **前端**: Next.js 16（静态导出模式）+ React 19 + TypeScript（strict）
- **样式**: Tailwind CSS v4 + shadcn/ui（radix-maia 风格）
- **包管理器**: pnpm

## 开发命令

```bash
# 启动完整应用（Tauri + Next.js Turbopack 开发服务器）
pnpm tauri dev

# 仅启动前端
pnpm dev

# 构建前端（静态导出到 out/）
pnpm build

# 构建 Tauri 桌面应用
pnpm tauri build

# Lint 检查
pnpm eslint .

# Rust 检查（在 src-tauri/ 目录下执行）
cargo check
cargo clippy
cargo build
```

目前尚未配置测试框架。

## 架构

### Rust 后端（`src-tauri/src/`）

后端负责读取和解析本地文件系统上的代理会话文件：

- **`models/`** — 共享数据结构
- **`parsers/`** — 每个代理一个解析器
- **`commands/sessions.rs`** — 暴露给前端的 Tauri 命令

### 前端（`src/`）

- **`lib/types.ts`** — Rust 模型的 TypeScript 镜像。`AgentType` 为 `"claude_code" | "codex" | "open_code"`（snake_case，与 Rust serde 一致）
- **`lib/tauri.ts`** — 对每个 Tauri 命令的类型化 `invoke()` 封装
- **`app/`** — Next.js 页面，不使用动态路由
- **`components/`** — 项目组件
- **`components/ui/`** — shadcn 组件

### 数据流

前端调用 `invoke()` → Tauri 命令 → 解析器读取本地文件 → 返回 `SessionSummary[]` / `SessionDetail` → React 渲染

## 关键约束

- **仅支持静态导出**：`next.config.ts` 设置 `output: "export"`，不支持动态路由（`[param]`），必须使用查询参数替代
- **路径别名**：`@/*` 映射到 `./src/*`，导入写法为 `@/lib/utils`、`@/components/ui/button`
- **Rust serde 约定**：`AgentType` 序列化为 snake_case（`claude_code`、`open_code`）。Tauri 命令参数在 JS 侧使用 camelCase，Rust 侧使用 snake_case

## 代码风格

- Prettier：无分号、尾逗号（es5）、2 空格缩进、80 字符宽度
- ESLint：next/core-web-vitals + typescript + prettier
- TypeScript：strict 模式，启用 `noUnusedLocals` 和 `noUnusedParameters`
- Rust：2021 edition，使用 `thiserror` 定义错误类型
