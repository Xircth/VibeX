---
status: proposed
date: 2026-08-07
decision-makers:
  - VibeX maintainers
---

# 采用 Astryx 组件库重构会话输入体系并移除 Lexical WYSIWYG

## Context

会话输入区（`TaskFollowUpSection` 及其 `follow-up/` 子模块）目前以
`SessionComposerInput`（基于 Lexical 的 WYSIWYG 富文本编辑器，`frontend/src/components/ui/wysiwyg/`）
为核心输入框，承担 `@` 提及、`/`、`$`、`#`、`!`、`&` 六种命令、文件引用、图片附件等能力；
消息渲染用 `react-markdown` 封装（`Markdown.tsx`，含 KaTeX、Mermaid、TagReferenceChip、流式 streamdown）；
tool call 渲染用自研 `ToolCards`（`NormalizedConversation/tools/`）。Lexical 及其 `@lexical/*`
共 8 个包是主要前端依赖之一。

Astryx（Meta 开源设计系统，`@astryxdesign/core`，MIT，GitHub `facebook/astryx`，当前 0.3.0 Beta）
提供 150+ 组件与完整 Chat 组件族。经评估，其"纯文本 + 结构化 token"模型与 VibeX
"发送内容即 markdown 字符串 + 序列化 token"的数据模型天然对齐，替换后草稿持久化、
发送格式与后端协议均无需变更。

## 决策

分阶段采纳 Astryx 重构会话输入体系：

1. **前置：升级 React 19**。`@astryxdesign/core` 的 peerDependencies 为
   `react >= 19.0.0`、`react-dom >= 19.0.0`、`@stylexjs/stylex ^0.19.0`，
   不升级 React 19 无法安装使用。React 19 升级已单独评估为安全可行。
2. **替换输入框**：`SessionComposerInput` → `ChatComposerInput`，移除 Lexical WYSIWYG
   （`wysiwyg/` 目录与 `lexical`、`@lexical/*` 依赖）。
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
   `components` 承接 Tauri 路径转换与图片预览）。
6. **tool call 渲染**：`ToolCards` → `ChatToolCalls`，`ToolStatus` 映射到
   `ChatToolCallStatus`（pending/running/complete/error），专用卡片（`PlanCard`、
   `UnifiedDiffPreview` 等）映射为 `resultDetail`。

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

- **输入体验变化（需产品确认）**：Lexical 输入框是所见即所得（`**bold**` 即时变粗、
  代码高亮、图片内嵌预览）；`ChatComposerInput` 是纯文本 + token 徽章，markdown 以
  字面文本显示，格式化发生在发送后的渲染阶段。现有内嵌图片渲染变为附件 chip 形式
  （走现有 `onAttachImages` 流程）。
- **能力缺口（需自定义适配）**：
  - Astryx `Markdown` 不支持 KaTeX 数学公式与 Mermaid —— 通过 `components.code`
    自定义接入，或暂保留对应自研渲染；
  - `ChatToolCalls` 无权限审批/提问交互（现有 `PendingApprovalEntry`、
    `AskQuestionResultCard` 的 approve/deny 按钮）—— 需自定义或保留现有组件；
  - `ChatComposerInput` 无内嵌图片渲染 —— 走附件 chip。
- **依赖变化**：移除 `lexical` + `@lexical/*`（8 包）+ `wysiwyg/` 目录；视
  KaTeX/Mermaid 保留情况决定是否移除 `react-markdown`/`remark-*`/`rehype-*`；
  `cmdk` → `CommandPalette`；部分 `@radix-ui/*` → Astryx 弹层组件。
- **测试重写量大**：`follow-up/` 40+ UI 测试、`Markdown.test`、`ToolCards.test` 等需
  重写；纯逻辑 `sessionComposer*.test.ts` 可复用。
- **Beta 依赖风险**：Astryx 当前 0.3.0 Beta，API 可能变动，锁定版本并跟踪 changelog。
- **集成方式**：Astryx 为预编译 ESM + 预编译 CSS（`@astryxdesign/core/astryx.css`），
  无需 PostCSS/Babel 构建插件，`className` 可覆盖样式，不影响 VibeX 现有
  Tailwind / design tokens 体系。

## 分阶段实施路径

1. **阶段 0**：React 19 升级 + 全量回归（独立前置）。
2. **阶段 1**：引入 Astryx（安装 + theme provider + CSS），小范围替换非关键组件
   （`Badge` / `StatusDot` / `Button`）验证集成。
3. **阶段 2**：替换输入框（`ChatComposerInput` + 6 个 triggers 映射 +
   `ChatTokenizedText`），移除 lexical —— 最大一次变更，独立里程碑。
4. **阶段 3**：替换 `Markdown`（含 KaTeX/Mermaid 自定义）与 `ChatToolCalls`
   （含审批适配）。
5. **阶段 4**：按清单批量替换其余组件，逐步删除 `cmdk` / 部分 Radix /
   `react-markdown` 依赖。

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

## 待确认决策点

- 输入体验由所见即所得改为纯文本 + 徽章是否可接受（影响阶段 2 是否按原方案执行）。
- KaTeX / Mermaid 采用自定义接入还是保留自研渲染。
- 审批/提问交互在 `ChatToolCalls` 中的落点（自定义行内交互或保留现有卡片）。
