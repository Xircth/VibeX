---
status: accepted
date: 2026-08-14
decision-makers:
  - VibeX maintainers
---

# Workflow 源产物与可移植 Automation Spec

## Context

ADR-0032 让 Automation 持久化可重放的 Turn launch spec，ADR-0045 让 Automation
可以引用不可变 Workflow version。当前实现仍缺少 Workflow 的创作事实源、目录与版本选择，
设置页也无法编辑 Workflow Automation。若 UI、Agent 和 Plugin 分别维护数据库草稿、内存草稿
或文件副本，同一 Workflow 会出现无法解释的多份权威状态。

Automation 同样缺少稳定的复制、粘贴和导入格式。直接导出数据库记录会泄漏 Host 身份、调度
状态与路径，也无法跨 Workspace 复用。

## Decision

1. 本机配置的 `*.vibex-workflow.json` 是 Workflow 创作阶段的唯一事实源，称为
   Workflow source artifact。默认存放在 `~/.vibex/workflows/`，也允许选择 Workspace 内路径；
   原生 Studio、Plugin artifact editor 与 Agent/MCP 都编辑该文件。
2. source artifact 使用显式 `formatVersion` 和公开 JSON Schema。保存使用 Artifact revision/CAS，
   外部修改冲突不能静默覆盖。
3. `publish` 显式校验 source artifact 并生成不可变 Workflow definition version。运行只引用发布
   版本，不直接执行可变源文件。
4. Automation 的 Workflow target 绑定精确 version。发布新版本不自动更新引用者；只有
   “发布并应用”才更新当前 Automation，其他 Automation 保持原引用。
5. Workflow 是独立可复用资产，可以被手动运行、Agent 调用或多个 Automation 引用；Automation
   只拥有触发条件、Workspace/input binding 与 target reference。
6. `AutomationSpec` 是可复制、粘贴和版本化的创作格式，使用 `turn | workflow` target union。
   它不包含数据库 ID、Run history、`nextRunAt`、凭据、Server URL、绝对路径或 Runtime 解析结果。
7. 导入的 Automation 默认禁用，必须在当前 Host 解析并确认 Workspace、Agent、Workflow 与调度
   绑定后才能启用。
8. Automation target kind 在创建后不可切换，也不提供保持原 Automation 身份的转换操作。
9. 产品文案使用“单次会话”和“工作流”；领域模型继续使用 Turn 与 Workflow，不引入 Common 类型。

## Consequences

- 数据库需要 Workflow catalog/version history 与 Automation workflow-target 更新用例，但不新增第二份
  WorkflowDraft 权威。
- 删除源文件不删除已发布版本或历史 Run；引用发布版本的 Automation 仍可解释并运行。
- 跨 Workspace 复制 Workflow 通过 source artifact 完成；AutomationSpec 使用可移植的相对路径或
  `~/.vibex/workflows/` profile 路径，不导出展开后的主机绝对路径；缺失引用在导入时显式处理。
- ADR-0032 的可重放目标语义继续有效，本 ADR 扩展其公共创作格式与 Workflow target 更新语义。

## Considered options

- **数据库 WorkflowDraft 为权威。** 否决。Agent、Git 与 Artifact editor 仍需要文件，会形成同步协议
  和双事实源。
- **每次保存都发布版本。** 否决。编辑噪声会污染不可变版本历史，且无法区分草稿与可运行版本。
- **Workflow 内嵌在 Automation JSON。** 否决。它破坏 Workflow 独立复用与精确版本绑定。
