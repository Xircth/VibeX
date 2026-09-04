---
summary: 官方参考插件，演示命令面板、工具栏、状态栏、斜杠命令、时间线卡片与设置分区六个宿主界面槽位。
---

# 宿主界面示例

这个插件不解决业务问题，它的用途是把 VibeX 开放给插件的六个界面槽位各用一次，作为可运行的参考实现。它维护一份「工作区速览」——只有刷新时间和刷新次数两个字段，存在插件自己的 KV 里——然后把这份数据摊到六个位置上。

它使用的全部是公开 SDK 与公开贡献点，没有任何官方特权。你可以照抄它的 `plugin.json` 和 `runtime/`，换成自己的数据源。

## 它占用了哪些位置

| 槽位 | 你会看到 | 贡献 kind |
| --- | --- | --- |
| 命令面板 | 「工作区速览」，执行后刷新 | `app.command` |
| 工具栏 | 刷新按钮 | `app.toolbar` |
| 状态栏 | 速览时间，每 30 秒自己更新 | `app.status` |
| 输入框斜杠命令 | `/digest`，把速览作为前缀插入 | `app.composer.slash` |
| 会话时间线 | 速览卡片 | `app.timeline.card` |
| 设置页 | 「宿主界面示例」分区 | `app.settings.section` |
| 后台 | 每 5 分钟刷新一次 | `host.service` |

状态栏和工具栏都是**只可添加**：插件能往上加条目，不能改动或移除 VibeX 自己的指示器。状态栏超过三个插件条目时，多出来的进溢出菜单，不会被丢弃。

## 图标

`icon` 只能填 `@vibex/plugin-contract/catalog/icons` 里的名字，插件不能往宿主界面注入自己的图形。这份清单同时被 Rust、SDK 和前端三处校验。

## 开发

```bash
pnpm run build     # 产出 dist/worker.mjs 与 dist/app/
pnpm run validate  # 校验 plugin.json
pnpm test          # 跑 test/plugin.test.mjs
```
