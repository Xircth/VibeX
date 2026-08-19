---
status: accepted
date: 2026-08-14
decision-makers:
  - VibeX maintainers
---

# 共享 Workflow Studio 与 Workflow Creator Plugin

## Context

当前“设置 → 自动化”把列表、内嵌 Turn 编辑器、模板和历史混在一个页面，Workflow Inspector 只是
线性步骤列表。另做一套 Plugin DAG 编辑器会复制布局、Schema 表单、运行投影和调试行为，并最终
产生不一致。

## Decision

1. “设置 → 自动化”成为 Automation Center，包含“自动化”和“工作流”两个一级视图。
2. 索引页左侧是资产列表；模板栏在右侧按需展开并默认收起。创建/编辑进入独立路由，不显示索引
   列表；设置侧栏保留，Workflow Studio 可进入专注模式。
3. Automation 创建时选择“单次会话”或“工作流”，之后 target kind 不可切换。
4. 原生 Workflow editor、运行 Inspector 与 Plugin artifact editor 共享同一 Workflow Studio 模块：
   graph canvas、node inspector、conversation panel、schema forms、run projection 与状态动效只有一份
   实现，Host adapter 可替换。
5. DAG 画布负责真实 pan/zoom、节点与边编辑、键盘操作和选择；运行动效只表达 ready/running/
   waiting/completed/failed 与事件到达，遵守 reduced-motion，不制造与事件无关的装饰动画。
6. 选中 Agent step 打开锚定节点的持久 Inspector，包含“信息”和“对话”两个 Tab；节点移出视口时
   Inspector 停靠右侧，小窗口使用 Sheet。
7. Workflow Creator 是官方、可选、随 VibeX 分发的产品插件。原生 Studio 不依赖插件；插件禁用
   不删除源文件、版本、Automation 或 Run。
8. Plugin 包含 `vibex-workflow-creator` Skill、`vibex-workflow-mcp`、`workflow.definition` content、
   `*.vibex-workflow.json` file opener 和 `artifact.editor` App surface，并且只消费公共 SDK。
9. `workflow.binding` 保留现有 invocation 语义；Core DAG 使用新的 `workflow.definition`，不能重载同名
   contribution。
10. Workflow Creator 默认绑定全部兼容 Agent；用户可在插件设置或 MCP 设置修改同一 binding。

## Consequences

- 需要扩展 file opener 支持完整文件名/glob，不能为 Workflow 抢占所有 `.json`。
- Workflow event subscription 是动画和 Inspector 的唯一运行投影；现有固定 200 条轮询必须删除。
- 模板只生成待编辑 AutomationSpec 或 Workflow source，不直接启用、发布或运行。
- 共享 Studio 是产品深模块，原生与 Plugin wrapper 不得复制业务规则。

## Considered options

- **Workflow 完全内嵌 Automation editor。** 否决。破坏独立资产与多 Automation 复用。
- **原生和 Plugin 分别实现画布。** 否决。状态、布局与调试行为必然漂移。
- **Mermaid 作为生产编辑器。** 否决。它适合静态渲染，不提供需要的节点编辑、连线、键盘和检查器
  交互。
