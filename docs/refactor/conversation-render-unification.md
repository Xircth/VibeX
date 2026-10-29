# 会话渲染三套实现对照（唯一依据）

日期：2026-10-29  
分支意图：`refactor/unify-conversation-render`  
范围：`frontend/src/components/NormalizedConversation/**`、`frontend/src/components/conversation-thread/**`、`frontend/src/components/logs/AgentTimelineConversation.tsx`、`frontend/src/features/conversation/**`

开工必读核对：

- `CONTEXT.md` Conversation domain：Conversation / Turn / Timeline row / Projection；UI transcript 权威为 JSONL（ADR-0082）。
- ADR-0042：Conversation 是一等 Dockview 面板；关闭面板不取消 Turn。
- ADR-0071：Turn 完整性（取消握手、恢复回放不进事件日志、终态可达）。
- ADR-0082：打开/翻页历史只来自 JSONL 窗口；控制面（权限、排队输入、Turn 终态、UsageUpdated）仍走事件日志。
- `docs/problemmap/frontend.md` 的 **FE-001** 记录的是 Dockview group policy 重复（已清理），不是本对照表描述的三套会话渲染。本文件是「会话渲染三套实现」的唯一对照依据。

选定唯一实现：**NormalizedConversation**。理由：卡片与 Turn 渲染最完整，且已被 133 个文件依赖；另外两套是时间线壳与导航/用量 chrome，本身不再画消息气泡。

改造原则：另外两套降为适配层，保留原 import 路径；允许改动范围外的调用方（`features/collaboration`、`pages/`、`VirtualizedList.tsx`、`AgentTimelineConversation.test.ts`）零改动。

---

## 三套实现分别是什么

| 套件 | 路径 | 角色 | 规模 |
| --- | --- | --- | --- |
| A. NormalizedConversation | `frontend/src/components/NormalizedConversation/` | 唯一消息/工具/权限/错误卡片库；`MessageTurnView` 按 `MessageTurn` 渲染一整轮；`DisplayConversationEntry` 按遗留 `NormalizedEntry` 渲染单行 | 133 文件 |
| B. conversation-thread | `frontend/src/components/conversation-thread/` | 不渲染消息体。只提供右侧消息导航点、Turn 用量条、时钟与 nav 条目模型 | 9 文件 |
| C. AgentTimelineConversation | `frontend/src/components/logs/AgentTimelineConversation.tsx` | 会话面板时间线壳：虚拟列表、滚动、查找、重发、权限停靠、把 A 的卡片与 B 的 chrome 编排在一起 | 2361 行、21 个 `useEffect` |

主会话面板调用链（改造后保持）：

`KanbanSessionConversationView` / `DockviewLogsPanel` → `logs/VirtualizedList`（不可改）→ **适配层** `AgentTimelineConversation.tsx` → **唯一实现** `NormalizedConversation/ConversationTimeline.tsx` → `MessageTurnView` 等。

协作空间调用链（不可改 collaboration）：

`CollaborationSpacePage` → **适配层** `conversation-thread/ConversationMessageNav` → **唯一实现** `NormalizedConversation/thread/ConversationMessageNav`。

子会话覆盖层（已在 NormalizedConversation 内）：

`ChildConversationViewer` 直接使用 `MessageTurnView`，自己实现了一份 side-row 开关（`ChildInlineSideRow`），与时间线壳的 `InlineTimelineSideRow` 平行。文案不完全相同，本改造不合并，以免改文案。

---

## 同一类消息：谁在画

### 1. 用户消息

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | **主路径** `MessageTurnView`（`turn.role === 'user'`）：`UserMessageMarkdown` + `UserMessageAttachments` + `UserMessageActions`（复制 / 重试 / 编辑） | `MessageTurn.blocks` | ACP/JSONL 时间线的真实气泡。编辑走 `UserMessageEditor`，不经过 `UserMessage.tsx`。 |
| A | **遗留路径** `DisplayConversationEntry` → `UserMessage.tsx` | `NormalizedEntry.entry_type === 'user_message'` | 旧 execution-process / `NormalizedEntry` 单行。含折叠高度、rollback/restore、连续性文案。时间线主路径不走这里。 |
| B | 无气泡。`ConversationMessageNav` 每个用户回合一个导航点 | `buildTimelineNavEntries`（C 侧）或 `buildConversationMessageNavEntries`（DisplayEntry 遗留） | 只导航，不渲染正文。 |
| C | 不自绘。虚拟行里挂 `<MessageTurnView turn={row.turn} />` | `ConversationTimelineTurn` | 负责 `onRetry` / `onEditRetry`、interrupted 抑制（`showInterruptedNotice={false}`）、可编辑判定 `isEditableUserTimelineRow`。 |

### 2. Assistant 文本

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | `MessageTurnView.renderItem` → `AstryxMarkdown`；思考 → `ThinkingEntry`；流式状态 → `AssistantStreamingStatus` | `planTurnBlocks(turn.blocks)` | 主路径。可折叠过程段（`collapseTurnSegments`）、命令输出走 `AssistantCommandOutputEntry`。 |
| A | `DisplayConversationEntry` 对 `assistant_message`：`AstryxMarkdown` + hover 复制；系统/错误前缀可拆成 `CompactNoticeEntry` | `NormalizedEntry` | 遗留单行。含 Codex/Impeccable/transport notice 拆分。 |
| B | 无 | — | — |
| C | `<MessageTurnView />`；虚拟切片来自 `assistantVirtualSlices` | 同上 + `entry.slice` / `isLastSlice` | C 负责把长 assistant 回合切成虚拟行，A 按 slice 画。 |

### 3. 工具调用

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | `MessageTurnView` 对 `item.kind === 'tool'` → `DisplayConversationEntry` ← `toolBlockToNormalizedEntry` | `ToolUse` / `ToolResult` blocks | 统一卡片：`ToolCallCard` / `ScriptToolCallCard` / `LookupToolCallCard` / `PlanCard` / `UnifiedDiffPreview`；pending_approval 包 `PendingApprovalEntry`。 |
| A | `TurnActivity`（`MessageTurnView` 引用）：`ChatToolCalls`、`SubagentCard`、`AskQuestionToolCard`、`GoalToolCall`、`DelegationCard` | 聚合后的 tool items | 过程折叠、子 agent、提问工具、目标工具的专用呈现。 |
| B | 无 | — | — |
| C | 不自绘工具卡。只把 `MessageTurn` 交给 A | 同上 | 另在 assistant 最后一片后挂 `TurnFileChangesCard`（`file_change_summary` side row，不进 A）。 |

### 4. 权限卡

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | `PermissionRequestCard` | `permission_request` 行的 `request` | 卡片本体。 |
| B | 无 | — | — |
| C | 时间线 **过滤掉** `permission_request`（不 inline）。未应答的 pending 请求 **sticky 停靠**在流底部，渲染 `PermissionRequestCard`。若 `usesComposerStatusDock`，改由 composer 侧 `ConversationStatusDock` 承接 | `sideRows` 中 `kind === 'permission_request' && status === 'pending'` | 停靠策略在 C；卡片在 A。`defaultInlineSideRow` 不含 `permission_request`。 |
| A 子会话 | `ChildConversationViewer` leftover side rows 直接画 `PermissionRequestCard` | 同上 | 无虚拟列表、无 sticky。 |

### 5. 错误

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | `TurnErrorCard`：按 ACP `ConversationError.code` 分型（取消 / 鉴权 / 可 reload / 可 rebind） | `turn_error` side row；composer 也可 `placement="composer"` | 控制面错误。 |
| A | `DisplayConversationEntry`：`error_message` / `system_message` → `CompactNoticeEntry` 或 `PlainNoticeEntry` | `NormalizedEntry` | 遗留日志行，不是 Turn 终态卡。 |
| B | 无 | — | — |
| C | 时间线 **过滤掉** `turn_error`。错误进 `ConversationStatusDock`（`TurnErrorCard`）。`hasTurnError` 传给 `MessageTurnView` 抑制重连空态 | `sideRows` + session notices | 主面板错误不插在消息流中间。 |
| A 子会话 | leftover `turn_error` **inline** `TurnErrorCard` | 同上 | 与主面板不同：错误画在子会话流内。 |

### 6. Usage

| 套件 | 组件 | 数据入口 | 差异 |
| --- | --- | --- | --- |
| A | `DisplayConversationEntry` 对 `token_usage_info` **返回 `null`** | `NormalizedEntry` | 遗留 token 行不画。 |
| B | `TurnStats` / `LiveTurnStats`；模型 `turnStatsModel`；时钟 `turnClock` | `TurnStatsData`（tokens、窗口、cache、耗时、完成时刻） | 唯一用量 UI。流式用 `LiveTurnStats` 每秒刷新耗时。 |
| C | `renderTurnStats`：最后一片 assistant 行下面挂 B。`buildLiveTurnStats` / `buildSettledTurnStats` / `mergeMissingTurnStats` 从 `MessageTurn.usage` 取数；并写入 `EntriesContext` 给 composer 用量环 | `MessageTurn.usage` + 实时 overlay | 编排在 C，绘制在 B。C 文件头注释写「inline turn stats intentionally absent」与实现不符，以本表为准：stats **在**。 |

### 7. 其它 side row（对照完整性）

| 行 kind | A | B | C |
| --- | --- | --- | --- |
| `question_request` | `QuestionRequestCard` | 无 | `InlineTimelineSideRow` → A；未回答且 composer dock 开启时从时间线滤掉 |
| `feedback_request` | 无独立卡片 | 无 | C 内联硬编码英文标题 `Feedback requested` |
| `terminal_summary` | 无独立卡片 | 无 | C 内联 muted 卡片 |
| `artifact_revision` | `ArtifactTimelineCard` | 无 | C → A |
| `session_notice`（durable host note） | 无独立卡片 | 无 | C 内联 `conv-compact-notice`；人设卡可按配置隐藏 |
| `delegation` | `DelegationCard` / `ChildConversationViewer` | 无 | 从时间线滤掉，改走 child stack overlay |
| `file_change_summary` | `TurnFileChangesCard` | 无 | 从时间线滤掉，挂在 assistant 最后一片之后 |

`ChildInlineSideRow` 与 `InlineTimelineSideRow` 覆盖 question / feedback / terminal / artifact。feedback 标题：C 为硬编码英文，子会话为 `panels:ui.childConversation.feedbackRequested`。**本改造不统一这两处文案。**

---

## 选定 NormalizedConversation 之后的目标结构

```
NormalizedConversation/
  ConversationTimeline.tsx          ← 原 AgentTimelineConversation 实现
  thread/                           ← 原 conversation-thread 实现
    ConversationMessageNav.tsx
    LiveTurnStats.tsx
    TurnStats.tsx
    messageNavEntries.ts
    turnClock.ts
    turnStatsModel.ts
  MessageTurnView.tsx               ← 主 Turn 渲染
  DisplayConversationEntry.tsx      ← 遗留 NormalizedEntry 单行（工具卡仍走这里）
  …

conversation-thread/*.tsx|ts        ← 适配层：re-export NormalizedConversation/thread
logs/AgentTimelineConversation.tsx  ← 适配层：re-export ConversationTimeline
```

调用方规则：

- 允许改动范围外的模块继续 import 旧路径（适配层）。
- NormalizedConversation 内部改 import 到 `./thread/*`，避免实现依赖适配层。
- `features/conversation` 对 thread chrome 走适配层（`conversation-thread/turnClock`），对外路径不变。

---

## conversationStore 拆分（第三步依据）

`frontend/src/features/conversation/conversationStore.ts`（约 2827 行）是事件驱动 store，0 个 hooks。对外路径保持 `./conversationStore`（re-export `./store`）。

| 目标文件 | 装什么 |
| --- | --- |
| `store/turnLifecycle.ts` | 类型、`conversationStoreReducer`、`applyRowOpBatch`、upsert/patch/append/prune/settle、投影窗口加载 |
| `store/queue.ts` | 乐观 Turn 队列、window+live 合并、`dropSeededInitialPrompt`、pending assistant 占位、同回合排序 |
| `store/permissions.ts` | side row 选择、inline 策略（权限/错误 **不** inline）、durable host note |
| `store/selectors.ts` | `timelineTurnsForEntry`、`timelineItemsForEntry`、`selectConversationTimelineItems` |
| `store/index.ts` | 对外 barrel，API 与拆分前 `conversationStore.ts` 一致 |

说明：store 内没有名为 queue/permission 的独立状态字段。排队输入与权限响应在 `conversationTimelineRegistry` / `conversationApi`。`queue.ts` 对应乐观用户 Turn 与 window/live 行合并；`permissions.ts` 对应 `permission_request` 不进入 inline 时间线、由壳层 sticky 停靠这一投影策略。
