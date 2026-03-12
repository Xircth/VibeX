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
  <a href="./README.fr.md">Français</a> |
  <strong>Português</strong> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) é um workspace empresarial para geração de código com
múltiplos Agent.
Ele unifica agentes locais como Claude Code, Codex CLI, OpenCode e Gemini CLI
em um único app desktop com agregação de sessões, desenvolvimento paralelo com
`git worktree`, gestão de MCP/Skills e fluxo integrado de Git/arquivos/terminal.

## Interface principal

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## Exibição em mosaico de sessões

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> Versão atual: `v0.1.x` (iteração rápida)

## Destaques

- Workspace unificado para múltiplos Agent
- Agregação local de sessões com visualização estruturada
- Desenvolvimento paralelo com `git worktree`
- Gestão de MCP (varredura local + busca/instalação)
- Gestão de Skills (global e por projeto)

## Início rápido

### Requisitos

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- Dependências de build do Tauri 2

### Comandos

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# Executar em src-tauri/
cargo check
cargo clippy
cargo build
```

## Licença

Apache-2.0. Veja `LICENSE`.
