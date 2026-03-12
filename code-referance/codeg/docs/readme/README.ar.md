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
  <a href="./README.pt.md">Português</a> |
  <strong>العربية</strong>
</p>

Codeg (Code Generation) هو مساحة عمل مؤسسية لتوليد الشفرة باستخدام عدة
وكلاء Agent.
يوحّد الوكلاء المحليين مثل Claude Code وCodex CLI وOpenCode وGemini CLI داخل
تطبيق سطح مكتب واحد، مع تجميع الجلسات، وتطوير متوازي عبر `git worktree`،
وإدارة MCP/Skills، وسير عمل متكامل لـ Git/الملفات/الطرفية.

## الواجهة الرئيسية

![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## عرض الجلسات كبلاطات

![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

> الإصدار الحالي: `v0.1.x` (تطوير سريع)

## أبرز المزايا

- مساحة عمل موحّدة لعدة Agent
- تجميع محلي للجلسات مع عرض منظّم
- تطوير متوازي باستخدام `git worktree`
- إدارة MCP (فحص محلي + بحث/تثبيت)
- إدارة Skills (عام وعلى مستوى المشروع)

## البدء السريع

### المتطلبات

- Node.js `>=22`
- pnpm `>=10`
- Rust stable (2021 edition)
- تبعيات بناء Tauri 2

### الأوامر

```bash
pnpm install
pnpm tauri dev
pnpm dev
pnpm build
pnpm tauri build
pnpm eslint .

# شغّل داخل src-tauri/
cargo check
cargo clippy
cargo build
```

## الترخيص

Apache-2.0. راجع `LICENSE`.
