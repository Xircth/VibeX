# Astryx 组件库采纳与 React 19 升级计划

日期:2026-08-07 · 决策依据:[ADR-0039](docs/adr/0039-adopt-astryx-for-chat-composer-and-message-rendering.md)(accepted)、[ADR-0040](docs/adr/0040-upgrade-react-19-for-astryx.md)(accepted)

## 背景

VibeX 会话输入体系(`SessionComposerInput` + Lexical `WYSIWYGEditor` 9 处使用 +
`react-markdown` + 自研 `ToolCards`)替换为 Meta Astryx 组件库
(`@astryxdesign/core` 0.3.0 Beta)。前置硬门槛:React 19(ADR-0040)。
本计划为执行细节:子里程碑、替换映射、测试范围、验收标准。

## 阶段总览

```
阶段 0  React 19 升级(ADR-0040,独立前置)
   ↓
阶段 1  Astryx 引入(依赖 + theme + CSS + Provider,Badge/StatusDot/Button 验证)
   ↓
阶段 2  替换输入体系并移除 Lexical
   ├── 2a  输入框替换:SessionComposerInput → ChatComposerInput
   ├── 2b  只读渲染替换(5 处)→ Astryx Markdown
   └── 2c  编辑输入替换(4 处)→ 纯文本 + token;删除 wysiwyg/ + lexical 8 包
   ↓
阶段 3  Markdown(KaTeX/Mermaid 自定义)+ ChatToolCalls(审批包装器保留)
   ↓
阶段 4  批量替换 Radix 封装;删除 cmdk 残留
```

## 执行状态(2026-08-08 更新)

| 阶段                                                 | 状态                         | 提交       |
| ---------------------------------------------------- | ---------------------------- | ---------- |
| 0 React 19(19.2.8)                                   | ✅                           | `d5a51f55` |
| 1 Astryx 引入                                        | ✅                           | `91a49cc2` |
| 2a 输入框 → ChatComposerInput                        | ✅                           | `aaef4c71` |
| 2b 只读渲染 → AstryxMarkdown                         | ✅                           | `4cf34243` |
| 2c 编辑场景 + 移除 lexical                           | ✅                           | `47df67fd` |
| 3a Markdown(KaTeX/Mermaid)+ 移除 react-markdown 生态 | ✅                           | `b6fc4742` |
| 3b ToolCardShell → ChatToolCalls                     | ✅                           | `966688a4` |
| 3c 用户消息 → ChatMessage / ChatMessageBubble        | ✅                           | —          |
| 4 cmdk 残留清理                                      | ✅                           | `7fb22e49` |
| 4 Radix 按需替换                                     | ⏸️ 保留(用户决策 2026-08-08) | —          |

**3b 成本评估(实施前核对)**:`ToolCardShell` 被 10 个卡片组件与 `MessageTurnView`
深层使用;`ChatToolCalls` 无 actions API(现有卡片的开文件/复制/打开链接等交互
无处安放)、无 forceExpanded(审批强制展开需受控兜底)、状态仅 4 态
(现有 statusAppearance 有 denied/timed_out 细分)。全量替换 = 10+ 组件剥壳 +
`ToolCards.test.tsx` 18 项重写 + 交互适配。**收益为视觉统一,成本显著**。
**阶段 4 Radix 评估**:11 个 shadcn 封装重写为 Astryx 兼容层(保持项目内 API 不变)
工作量大且改变视觉,`ScrollArea`/`Slot` 无对应物保留。

**3b 落地形态(2026-08-08 追补)**:消息回合的连续调用由 `TurnToolCalls` 直接映射为
一个 `ChatToolCalls.calls` 数组,不同工具类型不再拆组,单条调用也保留聚合 disclosure;
聚合标题按命令/读取/修改/搜索/网页/子 Agent/其他分类计数。原有专用卡片通过
`resultDetail` 继续提供命令输出、文件 actions 与 diff,并由上下文省略重复的单调用
标题。Astryx 0.3.0 的未生效 `label` 与单条无聚合限制通过 pnpm patch 补齐。
`ToolCardShell` 继续服务于消息回合以外和审批强制展开场景。**Radix 决策**:shadcn
封装保留,radix 依赖不替换(用户决策)。

已确认的已知差异(随 2a/3a 测试记录):

- 无代码围栏感知(`&`/`$` 在代码块内也会触发菜单)
- 复制 chip 得 label 而非序列化文本;token 后保留 NBSP
- `$` 菜单不再常显;`!` 无菜单 Header
- 块级 memo 优化由 Astryx 整体解析替代(流式性能待 GUI 验证)

## 阶段 0:React 19 升级

- 内容:`react`/`react-dom` 升至 `^19`,`@types/react`/`@types/react-dom` 同步;
  处理类型层调整(`React.FC` 隐式 children 移除、`forwardRef` 可选)。
- 依据:ADR-0040(依赖树与代码模式已核实兼容)。
- 验收:
  1. `pnpm run check` 通过;
  2. `cd frontend && pnpm test` 全部通过;
  3. `pnpm run lint` 通过;
  4. `pnpm run dev` 核心流程冒烟(会话输入、消息渲染、工具调用、审批);
  5. lockfile 中 react/react-dom 均为 19.x。

## 阶段 1:Astryx 引入

- 安装:`@astryxdesign/core@0.3.0`(锁定精确版本)、`@astryxdesign/theme-neutral`、
  `@stylexjs/stylex@^0.19.0`(peer 依赖)。
- 集成:入口导入 `astryx.css`(及主题 CSS),挂 `Theme` provider;确认与现有
  Tailwind / design tokens 体系共存(预编译 ESM + CSS,无构建插件,`className`
  可覆盖)。
- 验证:小范围替换 `Badge` / `StatusDot` / `Button` 各 1–2 处使用,确认样式、
  暗色模式、测试环境(jsdom 渲染 Astryx 组件)正常。
- 验收:Astryx 组件在 dev 与测试环境均正常渲染,现有测试无回归。

## 阶段 2:替换输入体系并移除 Lexical

### 2a:输入框替换

- `SessionComposerInput`(`frontend/src/components/tasks/follow-up/`)→
  Astryx `ChatComposerInput`。
- 六种命令映射为 `triggers` 数组(每字符一个 `{ character, searchSource,
onSelect, renderItem }`):
  | trigger | 数据源 | 说明 |
  | --- | --- | --- |
  | `@` | 文件/仓库搜索 | 文件引用 |
  | `/` | 命令列表 | 斜杠命令 |
  | `$` | 变量/本地技能 | 现有 `$` 命令数据源 |
  | `#` | 标签搜索 | 标签引用 |
  | `!` | 插件动作目录 | 插件动作 |
  | `&` | `AgentMentionProvider` | Agent 提及 |
- token:输入与展示共用 `ChatComposerToken` 定义;展示侧 `ChatTokenizedText`
  或 `Markdown` 的 `inlinePlugins` 渲染;草稿持久化与发送格式(markdown 字符串 +
  序列化 token)不变。
- 周边组件(`SessionComposerTopbar`、`ConversationStatusDock`、`ActionBar`、
  `SessionSettingsSummary`、`SessionConfigOptionSelectors`)原样保留。
- 测试:重写 `SessionComposerInput.test.tsx`、`ComposerPluginActions.test.tsx`、
  `AgentMention.test.tsx`;复用纯逻辑 `sessionComposer*.test.ts`(14 个)。
- 验收:输入框不再依赖 `wysiwyg/` 目录;六种命令、附件 chip、IME、草稿恢复
  行为等价。

### 2b:只读渲染替换(5 处)

| 位置                               | 现状                                 | 替换为            | 适配点                                                                     |
| ---------------------------------- | ------------------------------------ | ----------------- | -------------------------------------------------------------------------- |
| `UserMessage.tsx:543`              | WYSIWYGEditor(disabled)              | Astryx `Markdown` | 结构化 token 分支保留 `SessionComposerStructuredText`;无 token 走 Markdown |
| `DisplayConversationEntry.tsx:186` | user_feedback 卡片                   | Astryx `Markdown` | —                                                                          |
| `ToolResultView.tsx:16`            | tool markdown 结果                   | Astryx `Markdown` | —                                                                          |
| `PlanCard.tsx:180`                 | plan raw                             | Astryx `Markdown` | —                                                                          |
| `ReviewCommentRenderer.tsx:71`     | 评论查看(disabled + onEdit/onDelete) | Astryx `Markdown` | 保留 onEdit/onDelete 操作条(自研小部件)                                    |

- 全局适配:`components` 承接 Tauri `convertFileSrc` 路径转换与图片预览;
  行内代码点击(`findMatchingDiffPath`/`onCodeClick`)如需保留,经
  `components.inlineCode` 或 `inlinePlugins` 适配。
- 测试:重写 `Markdown.test.tsx`(25 项)中渲染相关用例;新增只读渲染等价性
  测试。
- 验收:只读路径不再 import lexical;图片/路径/标签 chip 渲染等价。

### 2c:编辑输入替换(4 处)+ 移除 lexical

| 位置                           | 场景          | 替换为                                    | 所需 triggers                                             |
| ------------------------------ | ------------- | ----------------------------------------- | --------------------------------------------------------- |
| `CommentWidgetLine.tsx:79`     | diff 行内评论 | `ChatComposerInput`(轻量)                 | `#`(文件引用)                                             |
| `ReviewCommentRenderer.tsx:43` | 评论编辑      | `ChatComposerInput`                       | `#`(tag/文件),保留 `onCmdEnter` 提交(经 `onKeyDown` seam) |
| `RetryEditorInline.tsx:90`     | 重试前编辑    | `ChatComposerInput`                       | 与主输入框一致(6 种)                                      |
| `PendingApprovalEntry.tsx:164` | 审批拒绝原因  | `ChatComposerInput` 或 `TextArea`(纯文本) | 无                                                        |

- 全部接受"所见即所得 → 纯文本 + token"体验变化(已确认)。
- 移除:`frontend/src/components/ui/wysiwyg/` 目录(51 文件)、`lexical` +
  `@lexical/*` 8 包;确认全仓库无 lexical import(含 `ui/wysiwyg.tsx` 包装)。
- 测试:重写 `follow-up/` 17 个组件 UI 测试中受影响者、`MessageTurnView` /
  `DisplayConversationEntry` 相关测试。
- 验收:全仓库无 lexical import;`wysiwyg/` 目录删除;编辑场景(评论/重试/审批
  原因)功能等价;`pnpm run check` + 前端测试通过。

## 阶段 3:Markdown 与 ChatToolCalls

- **Markdown**:`Markdown.tsx` → Astryx `Markdown`。
  - `inlinePlugins` 承接 `TagReferenceChip`(`{ pattern, render }`,仿 Lexical
    TextMatchTransformer);
  - KaTeX:经 `components.code`(及行内数学)自定义接入,`katex` 包保留;
  - Mermaid:自研 `MermaidDiagram` 原样复用,经 `components.code` 按语言分发;
  - `isStreaming` 原生增量解析替换现有 streamdown 预处理;
  - 移除 `react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`。
  - 注意:Astryx Markdown 是自研 parser(非 remark 生态),GFM autolink 默认
    关闭(需 `autolink: 'gfm'`),块级语法差异以测试兜底。
- **ChatToolCalls**:`ToolCards`(11 张卡片)内容层 → `ChatToolCalls`;
  `ToolStatus`(shared/types.ts:1277)映射 `ChatToolCallStatus`
  (pending/running/complete/error);消息回合按连续调用段传入多 call 数组,标题按工具
  类型分类计数,单 call 同样聚合;专用卡片(`PlanCard`、`UnifiedDiffPreview`)
  映射 `resultDetail`;`PendingApprovalEntry` 包装器保留(审批 UI 自研不动)。
- 测试:重写 `ToolCards.test.tsx`、`Markdown.test.tsx` 其余用例;`messageTurnTool.test.ts`
  等纯逻辑测试保留。
- 验收:消息渲染(流式/公式/图表/标签/图片)与工具调用(状态/展开/审批包裹)
  行为等价;react-markdown 生态依赖移除。

## 阶段 4:批量替换与残留清理

- Radix 封装按需替换(11 包):
  | Radix 包 | Astryx 对应 | 替换 |
  | --- | --- | --- |
  | dropdown-menu | `DropdownMenu` | ✅ |
  | popover | `Popover` | ✅ |
  | select | `Selector` | ✅ |
  | switch | `Switch` | ✅ |
  | tooltip | `Tooltip` | ✅ |
  | progress | `ProgressBar` | ✅ |
  | toggle-group | `ToggleButtonGroup` | ✅ |
  | accordion | `Collapsible`(行为差异需验证) | ⚠️ |
  | label | `Field`/`FieldLabel` | ⚠️ |
  | breadcrumb | `Breadcrumbs`/`BreadcrumbItem` | ✅ |
  | scroll-area | 无对应物 | ❌ 保留 |
  | slot | 无对应物 | ❌ 保留 |
- `cmdk` 为残留依赖(全仓库零使用):直接删除,无需替换。
- 候选增强(可选):其余 `ChatMessage` 族消息容器、`CodeBlock`(CSS Custom Highlight
  替换自研)、`SegmentedControl`(替换 `ComposerSelect`/`SessionModeSelector`)、
  `CommandPalette`(如未来引入全局命令面板)、`ChatDictationButton`(听写)。
- 验收:`pnpm run check`/`lint`/`test` 通过;被替换封装无使用残留;依赖清单
  收敛(radix 仅剩 scroll-area/slot,cmdk/react-markdown/lexical 已无)。

## 依赖变化总览

| 动作         | 依赖                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 新增         | `@astryxdesign/core@0.3.0`(锁定)、`@astryxdesign/theme-neutral`、`@stylexjs/stylex@^0.19.0`               |
| 升级         | `react`/`react-dom` → 19.x、`@types/react`/`@types/react-dom`                                             |
| 移除(2c)     | `lexical`、`@lexical/*`(8 包)                                                                             |
| 移除(阶段 3) | `react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`                                             |
| 移除(阶段 4) | `cmdk`、被替换的 Radix 包                                                                                 |
| 保留         | `katex`、`mermaid`、`shiki`、`dompurify`、`marked`、`@radix-ui/react-scroll-area`、`@radix-ui/react-slot` |

## 测试重写范围

- `follow-up/` 48 个测试:17 个组件 UI 测试受影响(2a/2c 重写),14 个纯逻辑
  `sessionComposer*.test.ts` 复用,17 个 hook 测试视变更面调整。
- `Markdown.test.tsx`(25 项)/ `Markdown.blocks.test.tsx`(2b/阶段 3 重写)。
- `ToolCards.test.tsx`(阶段 3 重写)。
- 复用:`messageTurnTool.test.ts`、`messageTurnBlocks.test.ts` 等纯映射测试。

## 风险与缓解

| 风险                                                   | 缓解                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Astryx 0.3.0 Beta API 变动                             | 精确锁定版本;每阶段升级前核对 changelog;阶段 1 先行验证集成面           |
| Astryx Markdown 自研 parser 与 remark 行为差异         | 2b 先落地渲染等价性测试;autolink 显式配置 `'gfm'`;差异清单随测试沉淀    |
| 纯文本 + token 编辑的体验回退                          | 已产品确认;2a 先行、2c 跟进,分步验证                                    |
| `ChatComposerInput` 无自定义 undo/redo(依赖浏览器原生) | 受控 `value` 覆写会打断 undo 栈——输入框保持非受控或最小受控面           |
| jsdom 中 Astryx 组件渲染                               | 阶段 1 先行验证;必要时按组件 mock                                       |
| `WYSIWYGEditor` 只读渲染的历史富文本                   | 数据模型本就是 markdown 字符串,渲染切换无损;file-reference/图片适配兜底 |

## 执行顺序与依赖

1. 阶段 0 → 1 严格串行(React 19 是 Astryx 安装前提)。
2. 阶段 2a/2b 可并行(独立文件面);2c 依赖 2a 的 token/trigger 模式定稿。
3. 阶段 3 依赖 2b(只读 Markdown 适配点复用)。
4. 阶段 4 独立,可与阶段 3 并行,但建议在 2c 移除 lexical 后开始以保持主线
   干净。
