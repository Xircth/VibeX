# Design: Phase 2 — 前端会话渲染与输入升级

## 所属层

全部在 `frontend/`，不改 Tauri 后端业务逻辑，除非 Phase 1 事件字段需要接线。

- 渲染核心：`frontend/src/components/NormalizedConversation/`
- 会话线程容器：新增 `frontend/src/components/conversation-thread/`
- 工具卡分型：新增或拆分到 `frontend/src/components/NormalizedConversation/tools/`
- 输入区：`frontend/src/components/tasks/follow-up/`
- 共享渲染工具：新增 `frontend/src/lib/conversation-rendering/`
- 测试 fixture：`frontend/src/components/NormalizedConversation/__fixtures__/`

目标是形成单一链路：

`AgentEvent/ImportedConversationDetail -> normalized entries/parts -> ConversationThread -> NormalizedConversation renderer`

Kanban 会话、IDE 会话、Phase 3 导入会话、Phase 6 委托子会话都必须消费同一渲染层。

## 参照实现（Codeg）

| 能力                       | Codeg 文件                                                 | VibeX 落点                                              | 移植策略                                                      |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Streamdown 主链路          | `src/components/ai-elements/message.tsx`                   | `NormalizedConversation/Markdown.tsx`                   | 行为优先移植；保留 VibeX 链接/图片/tag reference 组件         |
| CJK/code/math/mermaid 插件 | `@streamdown/*`                                            | `lib/conversation-rendering/streamdownPlugins.ts`       | `safeCode` 语言降级、math delimiter normalize、mermaid 懒加载 |
| Shiki code block           | `ai-elements/code-block.tsx`                               | `NormalizedConversation/CodeBlock.tsx`                  | 移植 token 渲染、缓存、复制按钮、双主题；删除 Prism 新路径    |
| Stick-to-bottom            | `ai-elements/message-thread.tsx`                           | `conversation-thread/MessageThread.tsx`                 | 采用 `use-stick-to-bottom` 语义与“回到底部”按钮               |
| 虚拟线程                   | `message/virtualized-message-thread.tsx`                   | `conversation-thread/VirtualizedConversationThread.tsx` | 优先验证 `virtua`；失败用 `@tanstack/react-virtual` 等价实现  |
| 滚动上下文                 | `message/message-scroll-context.tsx`                       | `conversation-thread/messageScrollContext.tsx`          | 提供 `scrollToIndex` 给导航轨/turn stats                      |
| 内容 parts 分发            | `message/content-parts-renderer.tsx`                       | `NormalizedConversation/ContentPartsRenderer.tsx`       | 重写为 VibeX 类型适配器，保留 Codeg 分型                      |
| 工具卡                     | `message/agent-tool-call.tsx`, `ai-elements/tool.tsx`      | `tools/*`                                               | 命令、编辑、文件、计划、委托、问答、反馈、goal、图片          |
| 内联 diff                  | `components/diff/unified-diff-preview.tsx`                 | `tools/UnifiedDiffPreview.tsx`                          | 移植轻量 unified diff 预览；不把 Monaco 放入消息流            |
| Thinking                   | `ai-elements/reasoning.tsx`                                | `AggregatedThinkingCard.tsx`                            | 重写为流式/计时/自动收起                                      |
| 导航轨                     | `message/conversation-message-nav.tsx`                     | `conversation-thread/ConversationMessageNav.tsx`        | 行为对齐；接 PanelActions 打开 diff/file                      |
| Turn stats                 | `message/turn-stats.tsx`, `live-turn-stats.tsx`            | `conversation-thread/TurnStats.tsx`                     | 复制、模型、token、耗时、完成时间、回跳                       |
| 图片                       | `user-image-attachments.tsx`, `generated-images-block.tsx` | `UserMessage.tsx`, `tools/GeneratedImagesBlock.tsx`     | 复用现有 ImagePreviewDialog 与 metadata hook                  |
| 输入菜单                   | `chat/message-input.tsx`, command menus                    | `tasks/follow-up/*`                                     | 在既有 sessionComposerTypeahead/Queue 上扩展                  |

## 新依赖（逐条技术理由）

| 包                                              |                          是否强制 | 理由                                                                                                      | 备选 / 裁剪                                                              |
| ----------------------------------------------- | --------------------------------: | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `streamdown`                                    |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容，但全插件静态接入会显著膨胀首屏构建；T2.3 采用等价 fallback 层先关闭验收风险             | `react-markdown` + block parser + shiki/katex/mermaid                    |
| `@streamdown/cjk`                               |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；本阶段先用 CSS/Markdown fallback 覆盖 CJK 软换行与混排，不引入未使用依赖               | 必要时补轻量 remark/CSS 规则                                             |
| `@streamdown/code`                              |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；当前 Shiki CodeBlock 已经提供统一代码块接入                                            | 直连 Shiki CodeBlock                                                     |
| `@streamdown/math`                              |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；`remark-math` + `rehype-katex` 已满足公式验收                                           | remark-math + rehype-katex                                               |
| `@streamdown/mermaid`                           |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；当前 fenced-code renderer + dynamic `mermaid` import 更易控制 bundle 与安全边界         | 自研 fenced-code renderer + mermaid                                      |
| `shiki`                                         |                                是 | Prism 语言覆盖与样式不够，且当前有 HTML 注入路径                                                          | 无                                                                       |
| `remark-math`                                   | 是，作为 React 18 fallback 已落地 | 在 Streamdown 主链路完成前解析 `$`/`$$` 数学节点，并与现有 `react-markdown` 管线兼容                      | 不解析数学不满足 C5                                                      |
| `rehype-katex`                                  | 是，作为 React 18 fallback 已落地 | 把数学节点渲染为 KaTeX HAST；VibeX 组件层不做 HTML 注入                                                   | 手写公式渲染成本高且易错                                                 |
| `katex`                                         |                                是 | 数学公式渲染                                                                                              | 无                                                                       |
| `dompurify`                                     |                                是 | 文档/HTML 预览仍存在受控 `dangerouslySetInnerHTML` 入口，需要独立净化；Prism 移除后不能顺带移除该安全边界 | 仅用于非会话 HTML 文档预览；会话 Markdown/代码/Mermaid 仍不走 HTML 注入  |
| `mermaid`                                       |                        是，懒加载 | 图表渲染                                                                                                  | 无；可只支持代码块降级但不算完成 C6                                      |
| `use-stick-to-bottom`                           |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；T2.6 已修复自研贴底锚点，后续若替换必须带 DOM/browser 回归                             | 保留当前 scroll anchor                                                   |
| `virtua`                                        |     T2.1 已裁剪为后续评估 | React 18/Vite 兼容；T2.6 已采用 `@tanstack/react-virtual` 等价实现并补齐核心缺陷                           | 当前先复用 VibeX 已有 `@tanstack/react-virtual`，避免重复虚拟器栈        |
| `cmdk`                                          |                                是 | `/`、`@`、全局命令面板共用键盘/过滤语义                                                                   | 手写 Popover 列表不满足一致性                                            |
| `overlayscrollbars` + `overlayscrollbars-react` |             T2.15 已裁剪为后续评估 | 桌面滚动条一致性                                                                                          | Phase 2 优先保留原生滚动，避免破坏虚拟滚动、stick-to-bottom、键盘滚动和文本选择 |

明确不新增：Monaco 到消息流、第二套 UI 框架、SeaORM、Next.js。

### T2.1 spike 决策

`docs/specs/codeg-alignment/02-conversation-rendering/spike-result.md` 已确认
`streamdown`、`@streamdown/*`、`use-stick-to-bottom`、`virtua` 均可在
Vite + React 18 下完成类型检查与生产构建。但静态接入 Streamdown 全插件栈会显著放大
首屏 chunk，并额外引入大量 Shiki/Mermaid 代码；因此本阶段采用等价 fallback 实现，
不安装未被生产代码使用的 spike 依赖。后续若重新启用 Streamdown 或 virtua，必须先补
lazy-loading/chunk 策略与浏览器滚动回归。

## VibeX 保留与改造点

- 保留 `Markdown.tsx` 的本地图片解析、`convertFileSrc`、workspace path link、
  `TagReferenceChip`、`ImagePreviewDialog`。
- 保留 `sessionComposerQueue`、draft scratch、prompt enhancement、Codex goal
  indicator；输入菜单只扩展，不重写业务状态机。
- 保留 `AggregatedFileEditCard`、`EditDiffRenderer` 可用逻辑，但统一到新的
  `UnifiedDiffPreview` 与工具分型。
- 保留现有 CSS token，新增样式进入 `frontend/src/styles/legacy/index.css` 或
  同项目约定位置，不直接散落 hex。

## 数据与类型契约

新增 `AdaptedContentPart`（或扩展现有 normalized entry）作为前端渲染层内部类型：

```ts
type AdaptedContentPart =
  | { type: "text"; text: string; softBreaks?: boolean }
  | {
      type: "reasoning";
      content: string;
      isStreaming: boolean;
      elapsedMs?: number;
    }
  | {
      type: "tool-call";
      toolCallId?: string;
      toolName: string;
      input?: string;
      output?: string;
      errorText?: string;
      state: ToolState;
      meta?: unknown;
    }
  | { type: "tool-group"; items: ToolCallPart[]; isStreaming: boolean }
  | { type: "plan"; entries: PlanEntry[]; isStreaming: boolean }
  | {
      type: "generated-image";
      status: "generating" | "ready" | "failed";
      image?: GeneratedImage;
      revisedPrompt?: string;
      error?: string;
    }
  | { type: "delegation-status-group"; polls: DelegationPoll[] }
  | { type: "goal-run"; parts: AdaptedContentPart[] };
```

适配器负责把 VibeX `NormalizedEntry`、Phase 3 imported turns、Phase 6 delegation
events 转成该类型。渲染组件只关心 `AdaptedContentPart`，避免继续在 JSX 里分散解析。

## Markdown 管线

1. 输入前处理：
   - `stripTagReferenceAppendix`
   - `replaceTagReferenceMarkersWithMarkdownLinks`
   - `normalizeBareImageReferences`
   - `normalizeMathDelimiters`：把 `\[...\]`/`\(...\)` 转为 `$$...$$`/`$...$`，
     但保护 fenced code 和 inline code。
2. Streamdown 渲染：
   - plugins: `{ cjk, code: safeCode, math, mermaid }`
   - remark: `defaultRemarkPlugins + remarkRewriteFileUriLinks`；用户消息额外启用
     `remark-breaks`
3. Link/Image 组件：
   - 外链通过 Tauri shell 打开
   - workspace file/folder 点击调用 PanelActions
   - `.vibe-images/` 使用现有 metadata/proxy
4. 错误隔离：
   - Markdown subtree 包局部 ErrorBoundary
   - Mermaid/KaTeX/CodeBlock 各自局部降级

## Shiki 设计

- `createHighlighter({ themes: ['github-light','github-dark'], langs: [...] })`
  缓存为单例；语言按需加载。
- `highlightCode(code, lang, callback)` 同 Codeg：先返回 raw tokens，异步完成后
  通知订阅者；cache key 使用语言 + 长度 + 首尾片段。
- `safeLanguage(lang)`：Shiki 不支持的语言统一转 `text`。
- token 渲染用 React `<span>`，不再使用 Prism HTML。
- 主题跟随应用 theme；Phase 7 主题色只影响外层 chrome，不改 Shiki theme 语义。
- 构建层把 `shiki`、`@shikijs/*`、`vscode-oniguruma`、`vscode-textmate` 拆到
  `vendor-shiki`；高亮运行时通过动态 import 加载，避免首屏 `vendor` 吞入完整
  语言包、主题与 oniguruma 引擎。
- highlighter 初始化失败后必须清理 rejected promise，允许后续重试；非法语言先
  规范化为 `text`，不向控制台刷错误。

## 线程与虚拟化设计

- T2.6 当前落点为既有 `components/logs/VirtualizedList.tsx`；后续如拆出
  `conversation-thread/*`，必须保持同一 ref/API 语义。
- `VirtualizedList` 管理 stick-to-bottom 与 scroll viewport。
- 虚拟化采用现有 `@tanstack/react-virtual`：
  - props: `items`, `getItemKey`, `renderItem`, `itemSize`, `bufferSize`,
    `scrollApiRef`, `onVisibleStartIndexChange`
  - 发布 `scrollToIndex(index, { align, smooth })`
  - 图片、Mermaid、Thinking 展开后通过虚拟器 remeasure
- 不在每个流式 patch 调用全量 `rowVirtualizer.measure()`；`measureElement`
  负责行级重测，避免清空全部行高缓存。
- 当权限面板或顶部 chrome 改变 viewport offset 时，虚拟列表记录 `scrollMargin`，
  row translate 使用 `virtualRow.start - scrollMargin`。
- 贴底跟随采用“先滚到底 + RAF 后二次校正”：动态高度测量完成后若用户仍处在
  at-bottom 状态，再补一次 bottom scroll，减少流式高度变化导致的落短。
- 会话 key 变化时先重置 `isAtBottomRef`，再按保存的 scroll offset 恢复，避免
  旧会话的上滚状态泄漏到新会话。
- `ConversationMessageNav` 作为绝对定位 rail，不改变会话布局宽度。
- 线程 viewport 可 focus，使 PageUp/PageDown/Home/End 等原生滚动可用。

## 内容 parts 适配器

新增 `lib/conversation-rendering/adaptContentParts.ts`，把三类来源统一到
`AdaptedContentPart`：

- VibeX `NormalizedEntry`：映射为 text、reasoning、tool-call、plan、usage、
  status、error，并在 part 上保留 `normalizedEntry`，让当前主链路继续复用
  `DisplayConversationEntry` 与已分型工具卡。
- Phase 3 `ImportedAgentMessage`：按原始 role 转 text part，保留导入时间戳。
- Phase 6 `AgentEventEnvelope`：ACP message/thought/tool/permission/terminal/usage/
  status/error 事件直接转 part，给委托子会话和导入预览提供同一入口。

`NormalizedConversation/ContentPartsRenderer.tsx` 是分发入口：已有 normalized
entry 走现有渲染器；尚未归一化的 agent/imported parts 用轻量 ToolCardShell、
Markdown 与 ThinkingEntry 渲染。该层只做分发，不把解析逻辑塞回 ToolCallCard。

## 工具卡分型

| 类型              | 识别                                                 | 渲染                                                           |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| shell/exec        | `bash`, `exec_command`, command_run                  | terminal 风格输出，运行中 shimmer，输出过长只显示尾部          |
| apply_patch/edit  | `apply_patch`, `edit`, structuredPatch, unified diff | 文件列表、+N/-N、内联 `UnifiedDiffPreview`                     |
| file read/write   | `read`, `write`, `notebookedit`, file_read           | 文件路径、打开预览按钮、内容折叠                               |
| search/web fetch  | `search`, `web_fetch`                                | query/url、打开链接、结果折叠                                  |
| todo/plan         | todo_management, plan part                           | `PlanCard`，状态/优先级/流式                                   |
| agent/delegation  | agent, delegate_to_agent                             | Phase 6 前显示普通 agent 卡；Phase 6 后接 `DelegatedSubThread` |
| question/feedback | ask question, check feedback                         | 专门结果卡，区分等待/已回答/错误                               |
| goal              | create_goal/update_goal                              | goal 状态卡                                                    |
| generated image   | generated-image part                                 | 缩略图、状态、revised prompt、错误                             |
| generic           | 未识别 JSON/tool                                     | 结构化 JSON 折叠，不丢原文                                     |

## 输入区设计

- 在 `sessionComposerTypeahead` 上增加 source registry：
  - `@`: 工作区文件/目录，模糊搜索，显示路径和类型
  - `/`: 内置命令、Phase 1 `AvailableCommands`、skills、专家（Phase 10）
  - `$`: 保留现有结构化 token 能力
- 引入 cmdk 作为 listbox/command primitive，不替换 composer 状态机。
- 队列 UI 从 `MessageQueueIndicator` 升级为可展开列表：预览、编辑、删除；重排与
  立即发送按后端能力 gate。当前后端仅支持单条 queued prompt，因此重排控件显示为
  禁用态，后续多队列模型完成后再启用。

## 测试策略

- Markdown：Streamdown spike、CJK、soft breaks、math delimiter、Mermaid 失败、
  本地图片、workspace 链接、tag reference。
- CodeBlock：Shiki raw→async token、未知语言、安全渲染、复制按钮。
- Thread：贴底、上滚暂停、回到底部、虚拟化 scrollToIndex、图片加载 remeasure。
- Tool cards：每种分型 fixture + snapshot/行为测试；diff 统计表驱动测试。
- Composer：typeahead source registry、cmdk 键盘导航、queue CRUD 回归既有测试。
- 性能：大 fixture profile 抽查；必要时加 `renderCount` 测试守卫关键 memo。

## 风险

- React 18 兼容性：T2.1 先 spike streamdown + virtua + use-stick-to-bottom 组合。
- 虚拟化与流式贴底：本阶段最高风险，必须用真实长会话 fixture 验证。
- Mermaid bundle：必须动态 import；`vite.config.ts` 将 Mermaid 生态依赖拆到
  `vendor-mermaid`，build 后检查 chunk 尺寸。
- 现有 Markdown 功能较多，替换时容易丢 workspace 链接/图片能力；先写回归测试。
