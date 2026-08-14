---
status: accepted
date: 2026-08-13
decision-makers:
  - VibeX maintainers
---

# 产品中心的 Plugin Package、内容与配置模型

## Context

ADR-0046 建立了统一生命周期、隔离执行、Capability Broker、Runtime lock 与 App extension
host，但沿用了以 App/Agent contribution 分类解释插件的开发者视角。实际用户只关心插件提供
了什么功能。把 Skill、Runtime、MCP、命令、激活代和贡献数量直接作为详情页结构，会让
Office 重新看起来像旧 Agent Plugin 工具包，也掩盖它对文件预览等平台能力的扩展。

## Decision

1. VibeX Plugin 在产品界面中是一个不可再拆分的功能产品，不使用“平台扩展/Agent 扩展”分类。
2. 每个包必须有根 `README.md`。frontmatter 的 `summary` 是独立的一句话元数据；README 正文
   是用户说明入口。
3. 可供用户或 Agent 阅读/使用的资源统一进入根 `contents/`，build 生成并签名结构化内容索引。
4. 依赖描述统一进入根 `depends/`；作者入口位于 `runtime/`，发布执行物位于 `dist/`。
5. 根 `config.json` 是用户配置的唯一事实。manifest 内联 schema；Host 校验并原子写回此文件。
   它是可变用户数据，不进入 executable digest 或 activation generation。
6. manifest 使用产品语言 `integrations` 和 `dependencies` 描述内部接线。Kernel 可以编译为私有
   IR，但不得把该 IR 当作公共包格式或用户信息架构。
7. 插件目录采用单列列表；点击后进入独立详情页，只有“内容”和“配置”两个主要 Tab。
8. generation、contribution、handler、runtime lock 属于诊断模型，不出现在普通详情页。
9. Agent-native plugin 不复用 VibeX 产品详情。它在对应 Agent 设置底部以列表加预览呈现，
   预览只包含 Skill、MCP、Runtime、Hook 与 Workflow，不展示 App extension、VibeX capability、
   activation generation 或产品包诊断。
10. `PluginAction` 不再是公共产品或 SDK 概念。可复用的结构化操作统一建模为
    `contents/workflows/` 中的 Plugin Workflow；迁移期遗留字段只能作为兼容输入，不能重新投影为
    用户可见的“动作”或“调用命令”。

## Relationship to ADR-0046

本 ADR 修订 ADR-0046 的公共包布局、术语与产品 UI。ADR-0048 进一步修订执行信任与权限
模型；原子 generation、内容寻址 Runtime、SDK 和 Office 无核心特判要求继续有效。

## Consequences

- Plugin SDK、CLI scaffold、Office reference package、Host DTO 和 UI 必须同时迁移，不能维护两套
  面向作者的 manifest。
- 更新安装物时要保留并重新验证用户 `config.json`，而不是用包内默认值静默覆盖。
- UI 不再从源码路径读取 README/contents；Host 返回已验证的 Product Detail DTO。
- Agent-native plugin 仍在各 Agent 设置内管理，但不会影响 VibeX Product Plugin 的统一展示。
- Agent-native 资源投影与 VibeX Product Detail 使用不同 DTO/视图边界，避免任何一侧的术语或
  权限语义泄漏到另一侧。
