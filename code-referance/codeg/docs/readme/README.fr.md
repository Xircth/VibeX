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
  <a href="./README.de.md">Deutsch</a> |
  <strong>Français</strong> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) est un workspace de génération de code multi-Agent de
niveau entreprise.
Il unifie des agents locaux comme Claude Code, Codex CLI, OpenCode et Gemini
CLI dans une application desktop avec agrégation des sessions, développement
parallèle via `git worktree`, gestion MCP/Skills et workflow intégré
Git/fichiers/terminal.

## Interface principale

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## Affichage en tuiles des sessions

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> Version actuelle : `v0.1.x` (itération rapide)

## Points forts

- Workspace unifié pour plusieurs Agent
- Agrégation locale des sessions avec affichage structuré
- Développement parallèle avec `git worktree`
- Gestion MCP (scan local + recherche/installation)
- Gestion des Skills (global et projet)

## Démarrage rapide

### Prérequis

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- Dépendances de build Tauri 2

### Commandes

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# Exécuter dans src-tauri/
cargo check
cargo clippy
cargo build
```

## Licence

Apache-2.0. Voir `LICENSE`.
