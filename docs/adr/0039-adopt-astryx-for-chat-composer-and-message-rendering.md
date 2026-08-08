---
status: accepted
date: 2026-08-07
decision-makers:
  - VibeX maintainers
---

# 采用 Astryx 组件库重构会话输入体系并移除 Lexical WYSIWYG

## Context

会话输入区（`TaskFollowUpSection` 及其 `follow-up/` 子模块）目前以
`SessionComposerInput`（`frontend/src/components/tasks/follow-up/`）为核心输入框 ——
自研 contentEditable div（手写 HTML 渲染 + 结构化 token chip），仅借用
`frontend/src/components/ui/wysiwyg/` 的 `TypeaheadMenu` 与 typeahead-triggers 工具，
承担 `@` 提及、`/`、`$`、`#`、`!`、`&` 六种命令、文件引用、图片附件等能力；
消息渲染用 `react-markdown` 封装（`Markdown.tsx`，含 KaTeX、Mermaid、
TagReferenceChip、流式 streamdown）；tool call 渲染用自研 `ToolCards`
（`NormalizedConversation/tools/`）。基于 Lexical 的 `WYSIWYGEditor`
（`components/ui/wysiwyg.tsx`）另有 9 处使用（只读渲染 5 处：用户消息、
user_feedback、tool 结果、plan、评论查看；编辑输入 4 处：diff 行内评论、
评论编辑、重试编辑、审批拒绝原因）。`lexical` 及 `@lexical/*` 共 8 个包是
主要前端依赖之一。

Astryx（Meta 开源设计系统，`@astryxdesign/core`，MIT，GitHub `facebook/astryx`，当前 0.3.0 Beta）
提供 150+ 组件与完整 Chat 组件族。经评估，其"纯文本 + 结构化 token"模型与 VibeX
"发送内容即 markdown 字符串 + 序列化 token"的数据模型天然对齐，替换后草稿持久化、
发送格式与后端协议均无需变更。

## 决策

分阶段采纳 Astryx 重构会话输入体系：

1. **前置：升级 React 19**（见 [ADR-0040](0040-upgrade-react-19-for-astryx.md)）。
   `@astryxdesign/core` 的 peerDependencies 为
   `react >= 19.0.0`、`react-dom >= 19.0.0`、`@stylexjs/stylex ^0.19.0`，不升级
   React 19 无法安装使用。依赖树与代码模式已核实兼容（ADR-0040），升级为独立
   前置阶段。
2. **替换输入体系并一次性移除 Lexical**：`SessionComposerInput` →
   `ChatComposerInput`；`WYSIWYGEditor` 全部 9 处使用一并替换（只读渲染 5 处
   → Astryx `Markdown`，编辑输入 4 处 → 纯文本 + token 输入），随后删除
   `wysiwyg/` 目录与 `lexical`、`@lexical/*` 依赖。4 处编辑场景（评论、重试编辑、
   审批拒绝原因）接受从所见即所得变为纯文本 + token 徽章（数据模型不变，仍是
   markdown 字符串）。
3. **保留输入区周边组件**：`SessionComposerTopbar`（含 `DiffStatsBar`、
   `CodexGoalIndicator`、`TokenUsageIndicator`、`TodoListButton`、`SessionSelector`）、
   `ConversationStatusDock`、`ActionBar`、`SessionSettingsSummary` /
   `SessionConfigOptionSelectors`、`AgentMentionProvider` —— 均为输入框的兄弟组件，
   不依赖 lexical，原样保留；`AgentMentionProvider` 数据改接 trigger `'@'` 的 `SearchSource`。
4. **命令重写**：六种命令（`@` `/` `$` `#` `!` `&`）映射为 `ChatComposerInput` 的
   `triggers`（每字符一个 `SearchSource` + `onSelect`）；输入与显示共用同一套
   `ChatComposerToken` 定义，展示侧用 `ChatTokenizedText` 或 `Markdown` 的
   `inlinePlugins` 渲染。
5. **消息渲染**：`Markdown.tsx` → Astryx `Markdown`（原生 `isStreaming` 增量解析 +
   淡入动画，优于现有 streamdown；`inlinePlugins` 承接 `TagReferenceChip` 等；
   `components` 承接 Tauri 路径转换与图片预览）。KaTeX 与 Mermaid 经
   `components.code` 自定义接入（自研 `MermaidDiagram` 原样复用），随后移除
   `react-markdown` / `remark-*` / `rehype-katex` 依赖。
6. **tool call 渲染**：`ToolCards` → `ChatToolCalls`，`ToolStatus` 映射到
   `ChatToolCallStatus`（pending/running/complete/error）。落地形态（2026-08-08
   实施核对后修正）：`ToolCardShell` 保持 props API（10 个卡片组件零改动），
   内部引擎替换为单 call `ChatToolCalls` 行渲染；受控展开、actions（行右侧）、
   状态 class 保留 —— ChatToolCalls 行级展开不可控，审批 `forceExpanded` 依赖的
   外部展开状态得以保留，故专用卡片（`PlanCard`、`UnifiedDiffPreview` 等）不改为
   `resultDetail` 而继续作为 shell 的受控展开内容。`PendingApprovalEntry` 作为
   审批状态包装器原样保留（审批 UI 自研，与渲染组件正交）。

## Considered Options

- **不替换（维持 Lexical WYSIWYG）**：被否决。用户明确倾向积极替换；Lexical 8 个包
  维护成本高，Astryx 的 triggers/token/流式 Markdown 更贴合产品模型；`liquid-glass-react`
  等已声明 `react >= 19`，React 19 升级本身势在必行。
- **整体换装（含消息气泡、布局、全部表单控件一并替换）**：暂缓。变更面过大，
  无法单里程碑验证；按依赖关系分阶段推进（见下）。
- **自研替代（用现有 typeahead + textarea 重写，不引入 Astryx）**：被否决。
  重复造轮子且失去设计系统一致性；Astryx 的 `ChatComposerInput` 已覆盖
  contentEditable 富输入、token 插入、IME 组合保护、历史、`onKeyDown` seam 等核心诉求。

## Consequences

- **输入体验变化（已确认）**：Lexical 输入框是所见即所得（`**bold**` 即时变粗、
  代码高亮、图片内嵌预览）；`ChatComposerInput` 是纯文本 + token 徽章，markdown 以
  字面文本显示，格式化发生在发送后的渲染阶段。现有内嵌图片渲染变为附件 chip 形式
  （走现有 `onAttachImages` 流程）。该变化已确认覆盖全部编辑场景（评论、重试编辑、
  审批拒绝原因）。
- **能力缺口（已确认落点）**：
  - Astryx `Markdown` 不支持 KaTeX 数学公式与 Mermaid —— 经 `components.code`
    自定义接入，自研 `MermaidDiagram` 原样复用；
  - `ChatToolCalls` 无权限审批/提问交互 —— 保留 `PendingApprovalEntry` 状态
    包装器（含拒绝原因输入），内容层统一走 `ChatToolCalls`；
  - `ChatComposerInput` 无内嵌图片渲染 —— 走附件 chip。
- **依赖变化**：移除 `lexical` + `@lexical/*`（8 包）+ `wysiwyg/` 目录；
  `react-markdown`/`remark-*`/`rehype-*` 在阶段 3 移除；`cmdk` 为残留依赖
  （全仓库无使用）直接删除；Radix 按需替换，无对应物的 `ScrollArea`/`Slot` 保留。
- **测试重写量大**：`follow-up/` 40+ UI 测试、`Markdown.test`、`ToolCards.test` 等需
  重写；纯逻辑 `sessionComposer*.test.ts` 可复用。
- **Beta 依赖风险**：Astryx 当前 0.3.0 Beta，API 可能变动，锁定版本并跟踪 changelog。
- **集成方式**：Astryx 为预编译 ESM + 预编译 CSS（`@astryxdesign/core/astryx.css`），
  无需 PostCSS/Babel 构建插件，`className` 可覆盖样式，不影响 VibeX 现有
  Tailwind / design tokens 体系。

## 分阶段实施路径

1. **阶段 0**：React 19 升级 + 全量回归（独立前置，见 ADR-0040）。
2. **阶段 1**：引入 Astryx（安装 + theme provider + CSS），小范围替换非关键组件
   （`Badge` / `StatusDot` / `Button`）验证集成。
3. **阶段 2**：替换输入体系并移除 Lexical，拆三个独立可验证子里程碑：
   - **2a**：替换输入框（`ChatComposerInput` + 6 个 triggers 映射 +
     `ChatTokenizedText`）。交付标准：输入框不再依赖 `wysiwyg/`。
   - **2b**：替换只读渲染 5 处（`UserMessage`、`DisplayConversationEntry`
     user_feedback、`ToolResultView`、`PlanCard`、`ReviewCommentRenderer` 查看模式）
     → Astryx `Markdown`（含 file-reference/图片适配）。交付标准：只读路径不再
     import lexical。
   - **2c**：替换编辑输入 4 处（`CommentWidgetLine`、`ReviewCommentRenderer` 编辑、
     `RetryEditorInline`、`PendingApprovalEntry` 原因输入）→ 纯文本 + token 输入；
     随后删除 `wysiwyg/` 目录与 `lexical` 8 包。交付标准：全仓库无 lexical import，
     相关测试重写完成。
4. **阶段 3**：替换 `Markdown`（KaTeX/Mermaid 经 `components.code` 自定义接入，
   移除 `react-markdown`/`remark-*`/`rehype-*`）与 `ChatToolCalls`（落地为
   `ToolCardShell` 内部引擎替换，`PendingApprovalEntry` 包装器保留）。
5. **阶段 4**：残留清理 —— `cmdk` 残留直接删除；Radix 封装**保留不替换**（用户决策
   2026-08-08：11 个 shadcn 封装工作正常且已用 VibeX tokens，替换仅带来视觉变化
   与适配成本，`ScrollArea`/`Slot` 亦无 Astryx 对应物）。

## 其他可替换/新增组件（后续阶段候选）

- **Chat 族**：`ChatComposer`（容器）、`ChatMessage` / `ChatMessageBubble` /
  `ChatMessageList` / `ChatMessageMetadata` / `ChatSystemMessage`（消息气泡）、
  `ChatLayout` / `ChatLayoutScrollButton`、`ChatSendButton`、`ChatDictationButton`（新增听写）。
- **内容**：`CodeBlock`（自研 tokenizer + CSS Custom Highlight API，替换现有
  `CodeBlock` / `CompactCodeBlock`）、`Badge`、`Avatar` / `AvatarGroup`、`StatusDot`、
  `Spinner` / `ProgressBar` / `Skeleton`、`Button` / `IconButton` / `Kbd`、
  `Tooltip` / `Popover` / `HoverCard` / `Dialog` / `Toast`、`Citation`、`Token` / `Tokenizer`。
- **数据输入**：`TextInput` / `TextArea` / `Field` / `Selector` / `MultiSelector` /
  `SegmentedControl`（替换 `ComposerSelect` / `SessionModeSelector`）、
  `Typeahead` / `BaseTypeahead`。
- **Hooks**：`useStreamingText`、`useHotkeys`、`useOverflow` / `useScrollOverflow` /
  `useMediaQuery` / `useListFocus` / `useInputContainer` / `useLayer` / `usePopover` /
  `useTooltip` / `useScrollLock` / `useToast`。

## 已确认决策点（2026-08-07 核对定稿）

- 输入体验由所见即所得改为纯文本 + 徽章：**可接受**，且覆盖 `WYSIWYGEditor` 的
  全部编辑场景（评论、重试编辑、审批拒绝原因）。
- KaTeX / Mermaid：**自定义接入** Astryx `Markdown` 的 `components.code`，保留功能
  并移除 react-markdown 生态。
- 审批/提问交互落点：**保留 `PendingApprovalEntry` 包装器**，内容层统一走
  `ChatToolCalls`。
- 阶段 2 范围：**扩围**为输入框 + 全部 9 处 `WYSIWYGEditor` 使用一并替换，一次性
  移除 lexical；拆 2a/2b/2c 三个子里程碑。
- 阶段 4 边界：按需替换（有对应物的 Radix 封装）；`ScrollArea`/`Slot` 保留；
  `cmdk` 残留直接删除。
- 完整映射表与每阶段验收标准见 [升级计划](docs/plans/2026-08-07-astryx-upgrade.md)。
