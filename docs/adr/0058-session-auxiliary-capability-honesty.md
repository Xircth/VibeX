---
status: accepted
date: 2026-08-17
decision-makers:
  - VibeX maintainers
---

# 会话辅助能力以协议事实为准，不猜测、不填零、不静默覆盖

Composer 与时间线周围的辅助能力（用量、计划、目标、压缩、草稿、查找）必须
只呈现 Agent 或用户明确给出的事实。缺失字段保持缺失；状态不得从自由文本或
本地化文案反推；本机草稿不得静默覆盖服务器版本。

本决定落实既有产品不变量，不另开第二套会话模型。无工作区会话仍由
[ADR-0006](0006-workspace-less-conversation.md) 独立交付。自动标题只接受 Agent
`SessionInfo.title` 回填，不另起 LLM 起名。`&Agent` 仍是 ADR-0031 的委派建议。
导出、Review 评论预置、未知事件通知保持现有语义。

## Context

审查发现这些能力已经上线，但读模型与协议事实不对齐：

- ACP v1 `UsageUpdate` 是上下文占用（`used` / `size` / `cost`），被写成
  `input_tokens`，output/cache 被填 0。用量环因此把窗口占用谎称成输入 token。
- ACP `PlanEntry` 带 `status` 与 `priority`，进 `AgentPlan` 时只剩字符串，投影
  再一律写成 `pending`，并且每次更新追加一块 Plan。
- Codex Goal 从助手自由文本用中英正则猜测状态，文案写死中文，误报容易。
- `/compact` 的成功/失败靠匹配本地化助手文案，换语言或改文案即失效。
- Composer 草稿走 scratch last-write-wins，违反 ADR-0042 的 revision 冲突规则。
- 会话内查找不存在，只能用全局 FTS，且 FTS 故意不含 thinking/tool I/O。
- 失效的新会话默认只 `tracing::warn`；`SessionConfigStale` 已能进时间线通知，
  但默认应用失败仍可能被当成已生效。
- ADR-0006 的无工作区会话仍未开工，不能塞进本次辅助能力修复。

## Decision drivers

1. 未知不等于零，也不等于成功。
2. 状态只来自用户命令、Turn 终态或 Agent 结构化字段。
3. 草稿冲突必须同时保留服务器版本与本机版本。
4. 一次交付只修辅助能力的诚实性；不把无工作区会话或 LLM 起名混进来。

## Decision

### 1. 用量区分窗口占用与分项 token

`UsageUpdate.used` / `size` 映射为 `context_used` / `context_window_max`。
`input_tokens`、`output_tokens`、cache 只在 Agent 通过 `_meta` 或后续稳定
end-turn Usage 提供时写入；否则为 0 且 UI 不得把它们显示成分项事实。

Composer 用量环使用 `context_used`（若无则用已提供的分项之和）与
`context_window_max`。没有窗口大小则隐藏比值。

### 2. Plan 按 ACP 条目整体替换

`AgentPlan` 保存每条 `content`、`status`、`priority`。投影对同一回合用 Plan
块整体替换，不再追加。Composer 待办读取最新 Plan 块。

### 3. Codex Goal 只认用户 `/goal` 命令

`/goal <objective>` 设置，`pause` / `resume` / `complete` / `clear` 改状态。
助手自由文本不再改 Goal。可见文案走 i18n。

### 4. Compact 由用户 prompt 与 Turn 终态决定

用户消息以 `/compact` 开头即标记该回合为压缩。状态取 Turn 相位：在途为
running，Failed/Cancelled/Interrupted 为 failed，Completed 为 success。
删除对本地化助手文案的匹配。

### 5. Composer 草稿使用 scratch revision

`scratch` 增加单调 `revision`。保存必须带 `expected_revision`（新草稿为 0）。
冲突返回服务器草稿，前端同时保留本机未保存内容，用户选择保留服务器或保留
本机。提交成功且 revision 仍匹配时才清除草稿。

### 6. 会话内查找搜索当前时间线可见文本

Conversation 面板提供查找，范围是当前投影里用户/助手文本、thinking 与 Plan
条目。它不是第二套 FTS。全局 FTS 仍排除 thinking 与 tool I/O。

### 7. 本次不交付的能力

| 能力 | 决定 |
|---|---|
| 无工作区会话 | 仍按 ADR-0006 单独落地 |
| 独立 LLM 自动标题 | 不增加。Agent `SessionInfo.title` 回填未锁定标题即可 |
| 导出 | 保持 Markdown/HTML/bundle |
| `&Agent` | 保持 ADR-0031：chip 是建议，不是强制委派 |
| Review 评论 | 继续在发送时预置进 prompt |
| 未知/较新事件通知 | 保持现有降级显示 |
| 失效 session default | 继续走 `SessionConfigStale` 通知，不得假装已应用 |

## Consequences

- 用量、计划、目标、压缩与草稿冲突都有单一事实来源。
- `AgentPlan` / `ConversationUsage` / `Scratch` 形状变化，需生成类型与投影版本提升。
- 助手回复里的 “Goal completed” 不再改变 Goal 指示器。
- 无工作区会话与 LLM 起名仍是明确的后续工作，不是隐藏债。
