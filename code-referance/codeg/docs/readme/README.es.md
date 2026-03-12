# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <strong>Español</strong> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) es un espacio de trabajo empresarial para generación de
código con múltiples Agent.
Integra agentes locales como Claude Code, Codex CLI, OpenCode y Gemini CLI en
una sola aplicación de escritorio, con agregación de sesiones, desarrollo
paralelo con `git worktree`, gestión de MCP/Skills y flujo integrado de
Git/archivos/terminal.

## Interfaz principal

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## Vista de mosaico de sesiones

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> Versión actual: `v0.1.x` (iteración rápida)

## Puntos clave

- Espacio de trabajo unificado para múltiples Agent
- Agregación local de sesiones con vista estructurada
- Desarrollo paralelo con `git worktree`
- Gestión MCP (escaneo local + búsqueda/instalación)
- Gestión de Skills (global y por proyecto)

## Inicio rápido

### Requisitos

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- Dependencias de build para Tauri 2

### Comandos

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# Ejecutar en src-tauri/
cargo check
cargo clippy
cargo build
```

## Licencia

Apache-2.0. Ver `LICENSE`.
