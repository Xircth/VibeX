# Tasks: Phase 2 — 前端会话渲染与输入升级

执行环境：worktree `../VibeX-conversation-rendering`，分支
`feature/conversation-rendering`。

- [x] T2.1 Spike：React 18 兼容性矩阵
  - Acceptance: 在最小 demo 中验证 `streamdown`、`@streamdown/*`、`shiki`、
    `use-stick-to-bottom`、`virtua` 与 Vite/React 18 能否同时运行；产出采用/
    备选决策记录。
  - Verify: `cd frontend && pnpm vitest run <新增 spike 测试>` 或临时 demo 手动
    记录截图；删除临时代码，只保留决策文档。
  - Files: `docs/specs/codeg-alignment/02-conversation-rendering/spike-result.md`

- [x] T2.2 安装依赖与渲染测试 fixture
  - Acceptance: `package.json` 新依赖与 design.md 一致；新增长会话 fixture 覆盖
    CJK、代码、数学、Mermaid、工具卡、图片、diff、Thinking。
  - Verify: `cd frontend && pnpm install --lockfile-only` 后 `pnpm run frontend:check`
  - Files: `frontend/package.json`, lockfile, `NormalizedConversation/__fixtures__/*`

- [x] T2.3 Markdown 管线替换为 Streamdown/备选等价层
  - Acceptance: 流式 chunk 增量渲染；保留 tag reference、workspace file/folder
    链接、本地图片、`.vibe-images/` proxy、用户 soft breaks。
  - Verify: `cd frontend && pnpm vitest run src/components/NormalizedConversation/Markdown.test.tsx`
  - Files: `frontend/src/components/NormalizedConversation/Markdown.tsx`,
    `frontend/src/lib/conversation-rendering/streamdownPlugins.ts`

- [x] T2.4 Shiki CodeBlock 替换 Prism 路径
  - Acceptance: Shiki token 渲染、双主题、未知语言降级、复制按钮；会话与文件预览代码高亮均不再使用
    `dangerouslySetInnerHTML` 或 Prism HTML；VibeX 源码不再直接引用 `prismjs`/`highlightLine`。
  - Verify: `rg "from '../../utils/syntax'|from '@/utils/syntax'|utils/syntax|highlightLine|from 'prismjs'|prismjs|Prism|\\.token\\b|dangerouslySetInnerHTML" frontend/src frontend/package.json`
    仅允许非高亮语义命中（如 Prisma 图标注释、既有受信 SVG/文档 HTML 渲染点）；`cd frontend && pnpm exec vitest run src/components/NormalizedConversation/Markdown.test.tsx src/components/file-tree/FilePreviewPopover.test.tsx src/components/file-tree/file-tree-utils.test.ts` 绿。
  - Files: `NormalizedConversation/CodeBlock.tsx`, `utils/shikiHighlighter.ts`, `components/file-tree/FilePreviewPopover.tsx`, `utils/syntax.ts`（已废弃）

- [x] T2.5 数学与 Mermaid 渲染
  - Acceptance: `$...$`、`$$...$$`、`\(...\)`、`\[...\]` 正常渲染；TeX
    delimiter normalizer 保护 fenced code/inline code；KaTeX 通过
    `remark-math` + `rehype-katex` 接入；Mermaid 按 fenced code 语言懒加载，
    使用 `securityLevel: 'strict'` 渲染为 SVG data URL，不引入
    `dangerouslySetInnerHTML`；错误局部展示失败状态并保留源码。
  - Verify: `cd frontend && pnpm exec vitest run src/components/NormalizedConversation/Markdown.test.tsx`
    20 条通过；相邻回归
    `src/components/NormalizedConversation/Markdown.test.tsx src/components/file-tree/FilePreviewPopover.test.tsx src/components/file-tree/file-tree-utils.test.ts src/components/logs/VirtualizedList.test.ts src/components/kanban/KanbanSessionConversationView.test.tsx`
    96 条通过；`pnpm run check`、`pnpm run lint` 通过；`rg "dangerouslySetInnerHTML|mermaid|katex|remark-math|rehype-katex" frontend/src/components/NormalizedConversation frontend/src/styles/conversation frontend/package.json`
    确认无会话 HTML 注入路径。
  - Files: `Markdown.tsx`, `MermaidDiagram.tsx`, `Markdown.test.tsx`,
    `frontend/src/styles/conversation/conv-markdown.css`, `frontend/package.json`,
    `pnpm-lock.yaml`

- [x] T2.6 ConversationThread + stick-to-bottom + 虚拟化
  - Acceptance: 贴底自动跟随、用户上滚暂停、回底按钮、真实虚拟 rows、1,000 条
    fixture 可索引；`VirtualizedListRef.scrollToIndex(index, options)` 可供后续导航轨调用；
    “上一条用户消息”跳转不再依赖 DOM offset，改为虚拟锚点 + 用户消息索引。回修项：
    Shiki 从首屏 vendor 拆出；虚拟列表不再在每个流式 patch 全量 `measure()`；
    贴底跟随增加 scrollMargin 与测量后二次校正；会话切换重置贴底状态。
  - Verify: `cd frontend && pnpm exec vitest run src/components/logs/VirtualizedList.test.ts`
    15 条通过；相邻回归
    `src/components/NormalizedConversation/Markdown.test.tsx src/components/file-tree/FilePreviewPopover.test.tsx src/components/file-tree/file-tree-utils.test.ts src/components/logs/VirtualizedList.test.ts src/components/kanban/KanbanSessionConversationView.test.tsx`
    通过；`pnpm run check`、`pnpm run lint`、`pnpm run build` 通过；临时 Vite
    `http://127.0.0.1:4173/` HTTP 冒烟返回 200 且包含 root 节点。Browser 插件
    `iab` 不可用，且本机缺少 Chrome executable，未能执行浏览器截图。
  - Files: `components/logs/VirtualizedList.tsx`,
    `components/logs/VirtualizedList.test.ts`,
    `NormalizedConversation/__fixtures__/longConversation.ts`, `vite.config.ts`

- [x] T2.7 ContentPartsRenderer 与工具卡适配器
  - Acceptance: VibeX normalized entries、Phase 3 imported turns、Phase 6 delegation
    events 都能转为 `AdaptedContentPart`；旧单一 ToolCallCard 不再承担全部分型。
  - Verify: `cd frontend && pnpm exec vitest run src/lib/conversation-rendering/adaptContentParts.test.ts`
    12 条通过；覆盖 normalized entries、imported turns、agent event 的 text、
    reasoning、tool-call、plan、terminal、permission、usage、status、error parts。
  - Files: `lib/conversation-rendering/adaptContentParts.ts`,
    `NormalizedConversation/ContentPartsRenderer.tsx`

- [x] T2.8 工具卡分型第一批：命令、文件读写、搜索、通用 JSON
  - Acceptance: 命令卡含 prompt/output/退出状态/运行中状态；文件卡可打开预览；
    搜索/web fetch 可复制/打开；通用 JSON 折叠且保留原文。
  - Verify: `cd frontend && pnpm exec vitest run src/components/NormalizedConversation/tools/ToolCards.test.tsx`
    9 条通过；覆盖命令成功/失败/运行中、安装脚本默认展开、文件预览、web
    打开/复制、通用 JSON、路由分发，以及非命令成功卡不再新增绿色状态样式。
  - Files: `NormalizedConversation/tools/{CommandToolCard,FileToolCard,SearchToolCard,GenericToolCard}.tsx`

- [x] T2.9 工具卡分型第二批：plan、inline diff、question、feedback、goal、generated image
  - Acceptance: `PlanCard` 支持状态/优先级/流式；apply_patch/edit 内联 diff 预览；
    question/feedback/goal/generated image 专卡可渲染成功、运行、错误态。
  - Verify: diff 统计表驱动测试；各卡 fixture 测试。
  - Files: `tools/PlanCard.tsx`, `UnifiedDiffPreview.tsx`,
    `AskQuestionResultCard.tsx`, `FeedbackCheckResultCard.tsx`,
    `GoalToolCall.tsx`, `GeneratedImagesBlock.tsx`

- [x] T2.10 Thinking 卡升级
  - Acceptance: Thinking 流式增长、耗时、结束后自动收起、用户展开不被覆盖。
  - Verify: `AggregatedThinkingCard` 行为测试。
  - Files: `NormalizedConversation/AggregatedThinkingCard.tsx`,
    `NormalizedConversation/ThinkingEntry.tsx`

- [x] T2.11 消息导航轨
  - Acceptance: 每条用户消息都有锚点；有文件变更时显示文件数与 +N/-N；点击
    跳转虚拟行；当前可见行高亮。
  - Verify: nav entry 生成纯函数测试 + scroll mock 行为测试。
  - Files: `conversation-thread/ConversationMessageNav.tsx`,
    `conversation-thread/messageNavEntries.ts`

- [x] T2.12 TurnStats 与 LiveTurnStats
  - Acceptance: 显示复制、模型、token、缓存读写 token、耗时、完成时间、回跳；
    数据缺失隐藏；等待 Phase 1 字段时可用 mock/adapter。
  - Verify: `TurnStats.test.tsx`；Usage 事件 store 归约测试。
  - Files: `conversation-thread/TurnStats.tsx`, `LiveTurnStats.tsx`,
    `hooks/useConversationHistory/conversationTokenUsage.ts`

- [x] T2.13 图片内联展示与生成图片卡
  - Acceptance: 用户附件在消息中缩略展示；点击复用 ImagePreviewDialog；
    generated image 显示状态、revised prompt、错误信息。
  - Verify: 图片 metadata hook mock 测试 + generated image snapshot。
  - Files: `NormalizedConversation/UserMessage.tsx`, `tools/GeneratedImagesBlock.tsx`

- [x] T2.14 Composer：cmdk source registry、`@` 文件、`/` 命令、队列 UI
  - Acceptance: `@` 工作区文件搜索、`/` 内置命令 + Phase 1 AvailableCommands +
    skills；队列消息可展开、编辑、删除；当前后端仅支持单条 queued prompt，重排控件显示为禁用并在
    traceability 记录为后续多队列模型事项；不破坏 draft scratch。
  - Verify: `cd frontend && pnpm vitest run src/components/tasks/follow-up`
  - Files: `components/tasks/follow-up/*`, `lib/conversation-rendering/commandSources.ts`

- [ ] T2.15 overlayscrollbars 接入或裁剪记录
  - Acceptance: 若接入，不破坏 stick-to-bottom、虚拟滚动、键盘滚动、文本选择；
    若裁剪，记录原因和后续 Phase。
  - Verify: 桌面手动冒烟；若接入则新增最小渲染测试。
  - Files: `frontend/src/main.tsx`, `frontend/src/styles/*`, 或裁剪记录

- [ ] T2.16 旧路径清理与唯一入口验证
  - Acceptance: Kanban、IDE、导入会话预览均使用同一 `NormalizedConversation`
    渲染入口；无第二套新消息渲染实现。
  - Verify: `rg "ReactMarkdown|ToolCallCard|AggregatedThinkingCard|ConversationThread" frontend/src`
    人工核对；相关路由冒烟。
  - Files: 会话视图容器、`DisplayConversationEntry.tsx`

- [ ] T2.17 视觉、性能与构建验收
  - Acceptance: impeccable 无新增违规；桌面截图覆盖 10 类状态；长会话无明显卡顿；
    build chunk 无异常膨胀。
  - Verify: `pnpm run frontend:check`, `pnpm run frontend:lint`,
    `cd frontend && pnpm vitest run`, `pnpm run frontend:build`,
    `npx impeccable detect --fast --json frontend/src/components frontend/src/styles`
  - Files: 无特定文件；修复所有发现问题

- [ ] T2.18 五轴审查 → 修复 → 全门验证 → 合并回 master
  - Acceptance: review findings 关闭；traceability 中 C1-C16 全部标记为完成/裁剪。
  - Verify: 根目录全门：`pnpm run check`, `pnpm run lint`, `cargo test --workspace`
