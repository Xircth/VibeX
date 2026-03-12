# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <strong>Deutsch</strong> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) ist ein Enterprise-Workspace für Code-Generierung mit
mehreren Agenten.
Lokale KI-Coding-Agenten wie Claude Code, Codex CLI, OpenCode und Gemini CLI
werden in einer Desktop-App zusammengeführt: mit Sitzungsaggregation,
paralleler `git worktree`-Entwicklung, MCP/Skills-Verwaltung und integriertem
Git/Datei/Terminal-Workflow.

## Hauptoberfläche

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## Sitzungskachelansicht

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> Aktuelle Version: `v0.1.x` (schnelle Iteration)

## Highlights

- Einheitlicher Multi-Agent-Workspace
- Lokale Sitzungsaggregation mit strukturierter Darstellung
- Parallele Entwicklung mit `git worktree`
- MCP-Verwaltung (lokaler Scan + Suche/Installation)
- Skills-Verwaltung (global und projektbezogen)

## Schnellstart

### Voraussetzungen

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- Tauri-2-Build-Abhängigkeiten

### Befehle

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# In src-tauri/ ausführen
cargo check
cargo clippy
cargo build
```

## Lizenz

Apache-2.0. Siehe `LICENSE`.
