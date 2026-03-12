# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <strong>日本語</strong> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）は、複数 Agent 向けのエンタープライズ級コード生成ワークスペースです。
Claude Code、Codex CLI、OpenCode、Gemini CLI などのローカル AI コーディング Agent を 1 つのデスクトップアプリに統合し、セッション集約、並列 `git worktree` 開発、MCP/Skills 管理、Git/ファイル/ターミナル連携を提供します。

## メインインターフェース

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## セッションタイル表示

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> 現在のバージョン: `v0.1.x`（高速に改善中）

## 主な特長

- 同一プロジェクトでのマルチ Agent 統合ワークスペース
- ローカルセッションの集約と構造化表示
- `git worktree` による並列開発
- MCP 管理（ローカルスキャン + 検索/インストール）
- Skills 管理（グローバル/プロジェクト）
- ファイルツリー、Diff、Git、コミット、ターミナルの一体化

## 対応範囲

### 1) セッション取り込み（履歴）

| Agent | 環境変数優先パス | macOS / Linux 既定 | Windows 既定 |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |

### 2) ACP リアルタイムセッション

20 以上の Agent アダプターを内蔵（Claude Code、Codex CLI、Gemini CLI、OpenCode、OpenClaw など）。

### 3) Skills 設定対応

- 対応済み: `Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw`
- 他 Agent は順次追加予定

## クイックスタート

### 要件

- Node.js `>=22`
- pnpm `>=10`
- Rust stable（2021 edition）
- Tauri 2 のビルド依存

### 開発コマンド

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# src-tauri/ で実行
cargo check
cargo clippy
cargo build
```

## ライセンス

Apache-2.0。`LICENSE` を参照してください。
