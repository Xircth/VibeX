---
status: accepted
date: 2026-11-17
decision-makers:
  - Dimo maintainers
---

# 供应商预置内置在 Host，插件只能追加

设置 → Agent → 鉴权 → 供应商的新建表单开箱即带预置：有预置来源的 Agent 都有按
Agent 整理的无密钥模板，列表顶部固定 Host 的「自定义」。预置数据随 Host 发版，
不再由默认禁用的官方插件 `dimo.provider-switch` 提供；该插件删除。

[ADR-0079](0079-provider-catalog-templates-are-not-import-sources.md) 其余决定不变：
模板只填表、不是导入源；保存走 Host IPC；判别联合 DTO；`provider.model.catalog`
贡献点与 `provider_catalog_list` 保留，第三方插件仍可追加模板。

## Context

ADR-0079 把目录放进默认禁用的 ProviderSwitch。结果是用户打开新建表单只看到空列表，
得先知道去插件页安装并启用一个插件。预置是供应商表单的基本能力，不是可选扩展；
「数据会过时」靠 Host 发版同步解决即可。

## Decision

1. **数据位置。** 内置目录在 `frontend/src/features/provider-presets/catalogs/<agent>.json`
   （已是 view 形状），图标在 `frontend/public/provider-icons/`，图标渲染方式在
   `icons.json`。表单按 Agent 懒加载对应目录；MiMo Code 复用 OpenCode 目录。
2. **来源。** CC-Switch 固定版本快照（`SOURCE.toml`），由
   `scripts/sync-provider-presets.mjs` 转换。转换规则沿用 ADR-0079 §9、§15、§16：
   去 affiliate、OAuth、协议转换与促销字段，只保留能投影到 Dimo 原生字段的条目。
   Kimi Code 与 DeepSeek Harness 自定义只收 OpenAI chat-completions 预置；CC-Switch
   未覆盖的 Cline 用 `subset-allowlist.toml` 手写。CodeBuddy、Qoder、Auggie、Trae、
   Command Code、ZCode 暂无预置来源，表单不显示预置选择器。
3. **合并顺序。** 内置模板在前，已启用插件贡献的模板追加在后并标注插件名；不去重。
   插件目录加载失败只显示错误，内置模板照常可用。
4. **列表行。** 图标、名称、端点，有官网时带跳转按钮（系统浏览器打开，不选中该行）。
   「自定义」固定在列表顶部，滚动和搜索时始终可见。单色图标随文字色，透明底深色
   图标在深色模式下加浅色底。

## Consequences

- 新建供应商表单开箱有预置；更新预置需要 Host 发版并重跑同步脚本。
- 第三方商标与许可随 Host 分发，见 `provider-presets/THIRD_PARTY_NOTICES.md`。
- `dimo.provider-switch` 从官方插件目录、monorepo 与市场登记中移除。
