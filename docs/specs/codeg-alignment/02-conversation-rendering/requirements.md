# Requirements: Phase 2 — 前端会话渲染与输入升级 (conversation-rendering)

## Objective

把 VibeX 会话视图升级到 Codeg 级别的“可长时间使用的对话工作台”：流式
Markdown、Shiki 代码高亮、CJK/数学/Mermaid、stick-to-bottom、虚拟滚动、
多类型工具卡片、内联 diff、Thinking 高级展示、消息导航轨、Token/耗时统计、
图片内联展示、生成图片卡、`@` 文件菜单、`/` 命令菜单、消息队列 UI 与命令面板。

对应差距：README C1-C16、A7 的 UI 面、Phase 6 的委托展示入口。用户感知优先级
以 `../traceability.md` 的 22 项矩阵为准。

## Assumptions

- VibeX 当前是 Vite + React 18.2；Codeg 是 Next.js 16 + React 19。Phase 2 不做
  React 19/Next.js 迁移，先验证 Codeg 依赖在 React 18 下的兼容性。
- `frontend/src/components/NormalizedConversation/` 是唯一会话渲染入口。Kanban、
  IDE、历史导入详情、委托子会话都复用同一渲染层。
- 现有 VibeX 反超能力必须保留：tag reference chip、工作区文件路径打开、图片
  metadata/proxy、ImagePreviewDialog、sessionComposerQueue、prompt enhancement、
  Codex goal 状态。
- 若 Codeg 组件可直接移植，需保留 Apache-2.0 出处；若因架构差异重写，也要在
  design.md 写清对齐的行为语义。

## User Stories

- 作为用户，Agent 边输出我边看到稳定增长的 Markdown，而不是整段闪现或整列跳动。
- 作为用户，长代码块有 IDE 级高亮、语言标签、复制按钮，未知语言不会报错或空白。
- 作为中文/日文/韩文用户，长段文字断行自然，单行/软换行不会破坏 Markdown。
- 作为用户，输出中的 LaTeX 公式和 Mermaid 图表能正确显示；错误内容也能回看源码。
- 作为用户，新消息到达时视图自动贴底；我上滚查历史时不会被强行拉回底部。
- 作为用户，1,000 条以上长会话仍能流畅滚动，并能通过右侧导航轨跳到某轮用户消息。
- 作为用户，命令、文件编辑、计划、委托、问答、反馈、图片生成等工具调用各有专门
  卡片，而不是难读的通用 JSON 块。
- 作为用户，我能在消息流内直接查看 patch/diff 摘要和统一 diff，不必频繁切换面板。
- 作为用户，我能看到每轮模型、token、耗时、完成时间，并能复制/回跳到上一条用户消息。
- 作为用户，我在输入框输入 `@`、`/` 或打开命令面板时，有一致的搜索、键盘导航、
  预览和插入体验。

## Acceptance Criteria (EARS)

1. 流式 Markdown：WHEN Agent 输出 `message_chunk`，THE SYSTEM SHALL 以块级增量
   更新渲染，不整列重渲染；用户可见文本连续增长，无明显闪烁；现有文件链接、
   tag reference、图片路径转换仍工作。
2. Streamdown 插件：THE Markdown 管线 SHOULD 优先评估 `streamdown` +
   `@streamdown/cjk` + `@streamdown/code` + `@streamdown/math` +
   `@streamdown/mermaid`；若 React 18 兼容性、首屏 bundle、懒加载边界或 VibeX
   既有链接/图片能力无法同时满足，须切换到 design.md 的等价备选并保留同等验收语义。
3. Shiki：THE 代码高亮 SHALL 使用 Shiki token 渲染，支持亮/暗双主题、语言标签、
   复制按钮、可选行号、未知语言降级为 `text`；不得继续通过
   `dangerouslySetInnerHTML` 注入 Prism HTML。
4. CJK：WHEN 内容包含中文、日文、韩文、全角标点、混排英文/代码，THE SYSTEM
   SHALL 正确断行；用户消息可选择 `remark-breaks` 风格软换行，助手消息保持标准
   Markdown 软换行语义。
5. 数学：WHEN 内容包含 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，THE SYSTEM
   SHALL 渲染为 KaTeX；数学解析失败时显示错误占位并保留原文，不导致消息空白。
6. Mermaid：WHEN 内容包含 ```mermaid 代码块，THE SYSTEM SHALL 懒加载 Mermaid
   并渲染图表；语法错误时显示错误占位 + 原始代码块；渲染不应阻塞首屏 bundle。
7. 线程容器：THE 会话列表 SHALL 集成 stick-to-bottom：位于底部时自动跟随流式
   高度变化；用户上滚后停止跟随并显示“回到底部”按钮；点击按钮平滑回底。
8. 虚拟滚动：THE 会话列表 SHALL 使用一等虚拟化线程容器。优先验证 Codeg 同款
   `virtua`；若兼容但不能带来明确收益，或会扩大滚动/测量回归面，则使用
   `@tanstack/react-virtual` 等价实现。
   `react-virtuoso` 仅在证明可与 stick-to-bottom 稳定协作时保留。
9. 工具卡片分型：THE renderer SHALL 按内容类型渲染专门卡片：shell/exec、
   apply_patch/edit、file read/write、search/web fetch、todo/plan、agent/delegation、
   ask question、feedback check、goal、generated image、generic JSON。状态必须用
   图标 + 文案 + 颜色共同表达。
10. 内联 diff：WHEN 工具输入/输出包含 unified diff、apply_patch、structuredPatch
    或 edit payload，THE SYSTEM SHALL 在消息流内显示文件列表、+N/-N 统计与
    可展开 unified diff 预览；大型 diff 默认折叠并可打开专项 diff 面板。
11. Thinking：THE Thinking 块 SHALL 支持流式增长、折叠/展开、耗时展示、结束后
    自动收起；用户手动展开过的块不得在同一 turn 结束时强制收起。
12. 导航轨：THE 会话视图 SHALL 提供右侧消息导航轨，列出每条用户消息锚点、文件
    变更数量、+N/-N；点击跳转到对应虚拟行；当前可见消息高亮。
13. Turn stats：THE assistant turn SHALL 显示复制、模型、token、缓存读写 token、
    耗时、完成时间、回跳上一条用户消息。数据来自 Phase 1 Usage/PromptFinished
    等事件；数据缺失时隐藏对应项。
14. 图片：THE 用户图片附件 SHALL 在消息内显示缩略图；点击仍复用现有
    ImagePreviewDialog；THE generated image part SHALL 显示生成中/成功/失败、
    修订 prompt、缩略图和打开预览。
15. Composer：THE 输入区 SHALL 支持 `@` 文件引用菜单、`/` 命令菜单、Agent
    AvailableCommands、skills、图片粘贴/拖拽、队列消息展示/编辑/删除；当前后端仅支持
    单条 queued prompt 时，重排控件 SHALL 以禁用态展示并记录后续多队列模型事项，待
    后端支持多条 queued prompts 后再启用重排。
16. 命令面板：THE SYSTEM SHALL 引入 cmdk 风格命令面板原语，供 `/` 菜单、`@`
    菜单与全局命令复用；键盘导航、过滤、Esc 关闭、Enter 选择一致。
17. 自定义滚动条：IF 接入 overlayscrollbars，THEN 它 SHALL 不破坏虚拟滚动、
    stick-to-bottom、键盘滚动和文本选择；若风险高，可作为裁剪项记录。
18. 视觉合规：WHEN 运行 `npx impeccable detect --fast --json frontend/src/components
    frontend/src/styles`，THE 输出 SHALL 无新增违规；遵守设计禁令（无渐变文字、
    无嵌套卡片、无布局属性动画、无一色系泛滥）。
19. 性能：1,000 条消息、100 个工具卡片、20 个大型代码块的 fixture 会话在桌面端
    滚动无明显卡顿；流式期间 React profile 不应出现整列表重渲染。

## Edge / Error Cases

- Mermaid / KaTeX / Shiki 任一渲染失败：局部降级，不影响整条消息。
- 未闭合代码围栏：流式中按 plaintext 或 raw token 显示，围栏闭合后再高亮。
- 语言标签非法（如 `##`、`function`）：降级 `text`，不向控制台刷错误。
- 超大代码块或 diff：默认折叠并显示截断说明，可打开完整面板。
- 流式 turn 中断：已渲染内容保留，当前卡片状态变 error，后续重试不覆盖历史。
- 虚拟化测量变化：图片加载、Mermaid 渲染、Thinking 展开导致高度变化时不跳动。
- 图片粘贴超出大小/格式限制：toast 提示并拒绝，不插入损坏 markdown。
- cmdk 菜单无结果：显示空状态，Esc/失焦关闭，不污染输入内容。

## Boundaries

- Always：复用现有 shadcn/Radix 原语、`legacy/index.css` token、PanelActions、
  ImagePreviewDialog、sessionComposer 模块；每个新增渲染部件配最小行为测试。
- Ask first：React 19 升级、Next.js 迁移、移除现有 Markdown 文件链接能力、
  引入替代 UI 框架。
- Never：为绕过渲染问题复制第二套会话 UI；直接写 hex 颜色；继续在新代码里使用
  Prism HTML 注入；把大型 monaco editor 嵌进消息流卡片。

## Success Criteria

- 19 条验收全部通过或有明确裁剪记录；新增依赖逐条记录于 design.md。
- `pnpm run frontend:check`、`pnpm run frontend:lint`、受影响测试集、必要时
  `pnpm run frontend:build` 全绿。
- 桌面端截图/冒烟覆盖：流式中、长会话、代码块、公式、Mermaid、权限/工具卡、
  inline diff、Thinking、导航轨、图片、输入菜单。

## Open Questions

- T2.1 已确认 `streamdown` 与 React 18/Vite 兼容，但静态全插件栈包体过大；本阶段采用
  `react-markdown` + Shiki + KaTeX + Mermaid 等价 fallback，后续若启用 Streamdown
  必须先补 lazy-loading 与 chunk 策略。
- T2.1 已确认 `virtua` 与 React 18/Vite 兼容；T2.6 已采用
  `@tanstack/react-virtual` 等价实现，后续替换虚拟器必须先补同 fixture 浏览器滚动回归。
