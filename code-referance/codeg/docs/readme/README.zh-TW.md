# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <strong>繁體中文</strong> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）是面向多 Agent 的企業級程式碼生成工作台。
它將 Claude Code、Codex CLI、OpenCode、Gemini CLI 等本地 AI 編碼代理整合到一個桌面應用，支援會話彙整、並行 `git worktree` 開發、MCP/Skills 管理，以及 Git/檔案/終端整合流程。

## 主介面

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## 會話平鋪顯示

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> 目前版本：`v0.1.x`（快速迭代中）

## 核心亮點

- 多 Agent 統一工作台
- 本地會話彙整與結構化顯示
- 內建 `git worktree` 並行開發
- MCP 管理（本地掃描 + 市場搜尋/安裝）
- Skills 管理（全域與專案級）
- 檔案樹、Diff、Git、提交、終端一體化

## 支援範圍

### 1) 會話解析（歷史會話）

| Agent | 環境變數優先路徑 | macOS / Linux 預設路徑 | Windows 預設路徑 |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |

### 2) ACP 即時會話

內建 20+ Agent 適配器（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、OpenClaw 等）。

### 3) Skills 設定頁支援

- 已支援：`Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw`
- 其他代理持續補齊

### 4) MCP 目標應用

目前支援寫入：Claude Code、Codex、OpenCode。

## 快速開始

### 環境需求

- Node.js `>=22`
- pnpm `>=10`
- Rust stable（2021 edition）
- Tauri 2 建置依賴

### 開發命令

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# 在 src-tauri/ 下執行
cargo check
cargo clippy
cargo build
```

## 架構概覽

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

## 開發約束

- 前端靜態匯出（`output: "export"`）
- 不使用動態路由（`[param]`），改用查詢參數
- 前端參數 `camelCase`，Rust 參數 `snake_case`
- TypeScript strict

## 隱私與安全

- 預設本地優先
- 僅在使用者觸發時連網
- 支援系統代理

## 授權

Apache-2.0，詳見 `LICENSE`。
