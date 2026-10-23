---
name: ui-element-tokens
description: How to read "[UI 元素]" tokens inserted by the TauriUI调试器 plugin and jump to the referenced source.
---
# UI element tokens

A `[UI 元素]` token describes a UI element the user picked in the running VibeX dev window:

- `源码` is `relative/path:line:col` from the dev-only `data-vx-source` annotation; open that file first.
- `组件链` lists React components from innermost to outermost.
- `选择器` / `尺寸` / `关键样式` describe the rendered DOM node; prefer design tokens (`var(--*)`) when changing styles.
