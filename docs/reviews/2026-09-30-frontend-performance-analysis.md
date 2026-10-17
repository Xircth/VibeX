# VibeX 前端性能分析

> 日期：2026-09-30  
> 范围：`frontend/`（Tauri Desktop Host WebView，Operate 模式）  
> 方法：现行源码 + 已落地生产产物 `frontend/dist`（mtime 2026-09-24，`frontend/package.json` 0.2.8）实测体积与 chunk 图  
> 约束：功能与视觉不变；只写可验证结论；优化项按影响排序，区分立即 / 后续  
> 对照：ADR-0061、ADR-0080、`docs/plans/2026-08-31-windows-host-performance.md`；本报告覆盖这些文档未量化的前端产物与热路径

---

## 1. 执行摘要

VibeX 前端已经做了正确的骨架：路由/Dockview 面板懒加载、React Compiler、会话时间线虚拟化 + rAF 合批、Monaco/Shiki/Mermaid/xterm 独立 chunk、Git 大仓库降频、Windows 实色 chrome（运行时不走 WebGL 玻璃）。

当前最大问题不是“没拆包”，而是 **manualChunks 把本应懒加载的库重新塞进启动 vendor**，再叠加会话里几乎必现的 **9.3 MB Shiki**、**文件树全量 DOM**、以及 **安装包里约 11 MB 未压缩 PNG**。

| 维度 | 评分 (0–4) | 关键事实 |
|------|------------|----------|
| 加载 | 1 | 首屏强制 `modulepreload` 约 5.75 MB JS + 0.70 MB CSS；vendor 含 xyflow / gsap / KaTeX / liquid-glass |
| 渲染 | 2 | 时间线已虚拟化；文件树递归全量渲染；流式 Markdown 每 token 生成 span |
| 资源 | 1 | dist 50.6 MB；JS 32.4 MB、PNG 11.3 MB、字体 5.8 MB；98 个 Noto 子集 |
| 交互 | 2 | 会话打开 80 行上限 + rAF 合批；文件树与 Git 面板在可见时仍按 active 轮询 |
| 网络 | 3 | 本机 Tauri/IPC，无公网瀑布；问题在 IPC 体积、轮询与进程级事件 |
| 打包 | 1 | 重库已切 chunk，但 `return 'vendor'` 抵消动态 import |
| 运行时 | 2 | Windows 跳过 WebGL 玻璃；macOS ProjectRail 仍静态拉入 liquid-glass；Shiki 首次代码块支付 9.3 MB 解析 |

**综合：前端性能 11/28，偏弱。** 用户可感知卡顿集中在：冷启动白屏/解析、打开带代码的会话、展开大文件树、打开预览/合并编辑器。

### 立即优化（本迭代可做，视觉与功能不变）

1. 重写 `createManualChunks`，禁止把懒加载库打进启动 vendor  
2. `HostGlass` 对 `liquid-glass-react` 动态 import（Windows 永不下载）  
3. Shiki 改为 core + 按语言加载，去掉 9.3 MB 全家桶  
4. 文件树虚拟滚动  
5. 删除未引用的 `public` PNG；压缩 onboarding 截图  

### 后续优化（需要更长回归或运行时采样）

- Monaco worker 按语言按需  
- 未使用语言包 / 第二套虚拟列表收敛  
- 会话打开路径改为 `timelinePage` 而非 `conversation_detail` 带 timeline  
- macOS `backdrop-filter` 分层预算  
- 进程级 `conversation-events` 订阅收口  

---

## 2. 测量基线（可复现）

### 2.1 产物总体

| 指标 | 数值 | 来源 |
|------|------|------|
| `frontend/dist` 总大小 | **50.6 MB** / 331 文件 | `Get-ChildItem -Recurse` |
| `.js` | 83 文件 / **32.43 MB** | 同上 |
| `.png` | 26 文件 / **11.31 MB** | 同上 |
| `.woff2` | 128 文件 / **4.93 MB** | 同上 |
| `.css` | 11 文件 / **0.95 MB** | 同上 |
| `.ttf` + `.woff` | 41 文件 / **0.90 MB** | KaTeX / Codicon 等 |

这是安装包内嵌体积，也是 WebView 可能解析的上界。Tauri 走本地资源协议，**HTTP gzip 几乎不减轻解析成本**；用户付的是 JS parse/compile 与图片解码。

### 2.2 冷启动强制加载（`frontend/dist/index.html`）

生产 HTML 只注入：

```html
<script type="module" src="/assets/index-BDiRGqto.js"></script>
<link rel="modulepreload" href="/assets/vendor-Dwchowf3.js">
<link rel="modulepreload" href="/assets/vendor-tauri-DCvGpxLm.js">
<link rel="stylesheet" href="/assets/vendor-Cdy4g0Vh.css">
<link rel="stylesheet" href="/assets/index-P2IDju13.css">
```

| 文件 | 未压缩 | 角色 |
|------|--------|------|
| `vendor-Dwchowf3.js` | **4,676,358** | 所有未单独命名的 `node_modules` |
| `index-BDiRGqto.js` | **1,038,555** | 应用壳 + i18n 双语言 + FileIcon |
| `index-P2IDju13.css` | **507,974** | Tailwind/Astryx/legacy + 98 条 Noto `@font-face` |
| `vendor-Cdy4g0Vh.css` | **196,694** | vendor CSS |
| `vendor-tauri-DCvGpxLm.js` | 37,437 | Tauri API |
| **合计** | **6,457,018（约 6.16 MB）** | 进入主窗口前必须下载并解析 |

开发态 `index.html` 另有 `revealDesktopWindowEntry.ts`；生产已合并进主图，不再双入口。

### 2.3 按需但仍巨大的 chunk

| 文件 | 未压缩 | 触发条件 |
|------|--------|----------|
| `vendor-shiki-CE9Ifj6Z.js` | **9,325,027** | 会话/预览出现代码块（`import('shiki')`） |
| `ts.worker-DGHjMaqB.js` | **7,020,502** | Monaco 打开 TS/JS（preload 时一并配置） |
| `vendor-monaco-BP6gysRz.js` | **4,303,946** | 预览 / diff / 合并编辑器 |
| `vendor-mermaid-CoYaRTwi.js` | **1,927,262** | Markdown 里出现 mermaid 围栏 |
| `css.worker` / `html.worker` / `json.worker` / `editor.worker` | 约 2.4 MB | Monaco 各语言 |
| `vendor-dockview-CIWcbbAq.js` | 343,809 | 进入 IDE 工作区 |
| `AstryxMarkdown-BuEb-XiV.js` | 237,325 | 渲染会话 Markdown |
| `SessionSettingsSummary-BhOIdF5C.js` | 385,844 | 会话设置摘要 |
| `AgentSettings-DVKOPKji.js` | 327,956 | 设置 → 代理 |

### 2.4 本报告未采集、需要实机补的数字

以下 **没有** 在本机 WebView 上跑 Performance/Lighthouse（Host 是 Tauri，不是可公开 URL）。落地时按 ADR-0080 补：

- 冷启动：`performance.mark` 从 `main.tsx` 到第一次 `revealDesktopWindow`  
- 流式会话：p95 帧时间、长任务（>50 ms）、事件到绘制延迟  
- 打开预览：Monaco + worker 的 parse 时间  
- 大仓库文件树：展开 `node_modules` 或 `crates/` 时的帧时间与 DOM 节点数  
- Private Bytes：无 CEF、idle、1/2 会话（归 Host 进程，不单算前端）

没有这些采样的条目，在文中标为「源码+产物已证实，运行时幅度待测」。

---

## 3. 现状（按能力面）

### 3.1 加载

**已经做好的：**

- `MainAppRoutes` 对设置页、插件页、工作区内容 `React.lazy`  
- `PanelRegistry` 对 Kanban / 文件树 / 预览 / Diff / 终端 / Git / 合并等全部 `lazy()`  
- `FirstRunExperience` 懒加载  
- Monaco 经 `preloadMonacoEditor()` → `monacoRuntime.local` 动态 import  
- Mermaid、KaTeX、Shiki 源码层都是 `import()`  
- React Compiler（`babel-plugin-react-compiler`，target 18）已接入  
- Query 默认 `staleTime` 5 分钟、`refetchOnWindowFocus: false`

**现状瓶颈：**

1. `vite.config.ts` 的 `createManualChunks` 对未点名的 `node_modules` **一律 `return 'vendor'`**。动态 `import('katex')` / `@xyflow/react` / `gsap` / `liquid-glass-react` 仍进入启动 `vendor-Dwchowf3.js`。  
   证据：对该文件做字符串探测，`ReactFlow`、`@xyflow`、`gsap.registerPlugin`、`katex`、`LiquidGlass`、`displacementScale`、`WebGL` 均为 true；`DockviewKanbanPanel-*.js`（200 KB）里 **没有** `ReactFlow`。  
2. 生产 HTML 对 vendor **modulepreload**，主窗口一开就解析 4.7 MB。  
3. `HostGlass` 顶层 `import LiquidGlass from 'liquid-glass-react'`，而 `ProjectRail` 在 `MainAppRoutes` 常驻。Windows 运行时走实色 `div`，但 **JS 仍被解析**。  
4. `frontend/src/i18n/index.ts` 同步 import 全部 zh-CN + en JSON（settings 单文件各约 150 KB，合计约 0.5 MB 源）。`index-BDiRGqto.js` 含 `settings.json`。  
5. `PanelRegistry` 静态 import `FileIcon` → `fileIcons.ts` → `import * as icons from './icons'`（`icons.ts` 源 **991,825 B / 1367 行**）。`index-BDiRGqto.js` 含 `dangerouslySetInnerHTML`（FileIcon 的渲染路径）。

### 3.2 渲染

**已经做好的：**

- `AgentTimelineConversation` 使用 `@tanstack/react-virtual`，`overscan: 10`，估计行高 128px，`observeUnscaledElementRect` / `measureUnscaledBlockHeight`  
- `useConversationTimeline` 用 `requestAnimationFrame` 合批 row-ops，注释明确为避免 “Maximum update depth exceeded”  
- 打开路径后端 `OPEN_TIMELINE_ROW_LIMIT = 80`；更早页走 `timelinePage`  
- Git log、进程日志、分支选择器用 `react-virtuoso`  
- Diff CSS 对长文件使用 `content-visibility: auto`  
- `CodeBlock` / `FileIcon` 有 `memo`；Shiki 对流式代码做增量 tokenize（完整行复用）  
- Dockview 终端 `renderer: 'onlyWhenVisible'`

**现状瓶颈：**

1. **文件树没有虚拟列表。** `FileTreePanel.tsx`（1992 行）`nodes.map` → 递归 `renderNode` → 每个节点一个按钮 + `FileIcon`（`dangerouslySetInnerHTML` SVG）。展开大目录时 DOM 线性增长。2016 年方案文档已把此事标 P0，代码仍未做。  
2. 流式 Markdown：`AstryxMarkdown` → `CodeBlock` → 每 token 一个 `<span class="conv-md-token" style={...}>`。长代码块在虚拟行内部仍然是全量 token DOM。  
3. 双虚拟列表库：`react-virtuoso`（3 处）+ `@tanstack/react-virtual`（时间线）。vendor 已含 virtuoso（`vendor-Dwchowf3.js` 命中 10 次）。  
4. `legacy/index.css` 源 **14,728 行 / 345 KB**，生产 CSS 508 KB，启动时全量解析。macOS chrome 多处 `backdrop-filter: blur(18–30px)`；Windows 有实色回退，macOS 合成成本仍在。  
5. `will-change` 使用克制（browser loading dots、effort slider、onboarding），不是主因。

### 3.3 资源

**字体**

- `fonts.css`：`@fontsource-variable/inter/wght.css` + `noto-sans-sc/wght.css` + 4 个 IBM Plex Mono  
- 生产 CSS 含 **98** 个 Noto `woff2` 引用、**7** 个 Inter  
- Windows/Linux `--font-ui` 把 Inter + Noto Sans SC Variable 放在系统字体之前；中文界面会按 unicode-range 拉大量 CJK 子集  
- IBM Plex 四字重无 unicode-range，等宽 UI 一用就可能拉满约 186 KB  
- DESIGN.md 规定 macOS 用 SF Pro / PingFang，不走这些 webfont；Windows/Linux 必须走 bundled 字体（视觉约束，不能删，只能减子集）

**图片**

- `public/onboarding/` 六张 PNG 合计约 **6.0 MB**，`ProductStack` **一次挂载 5 张**，无 `width`/`height`、无 `loading="lazy"`、无 WebP/AVIF  
- `frontend/src` **零处** `loading="lazy"`  
- 无引用的 public PNG（安装包纯浪费）：  
  - `vibe-kanban-screenshot-overview.png` 1,849,253  
  - `beta-workspaces-preview.png` 746,801  
  - `guide-images/*` 约 1.75 MB  
  - 合计约 **4.3 MB**，全仓库无 `guide-images/` / 上述文件名引用  

**图标**

- UI 图标：`lucide-react` 具名 import（可 tree-shake）  
- 文件类型图标：内联 SVG 字符串目录，为历史 singlefile 打包服务，已不需要打进主包

### 3.4 交互

热路径是「打开工作区 → 左侧文件树 + 右侧会话 + 流式 Markdown」。

- 会话：80 行投影 + 虚拟列表 + rAF 合批，方向正确  
- `conversationApi.detail()` 仍拉取带 `timeline` 的 `DbConversationDetail`（`turns` 已空）。长会话的 80 行 + session_modes/commands 仍是一次大 IPC  
- `useConversationTimeline` 已按 `conversationEventsChannel(id)` 订阅  
- **例外：** `useAgentLongRunningTerminals.ts` 调用 `listenToConversationEvents` **不带** `conversationId`，走进程级 `conversation-events` 再本地过滤  
- Git 面板 `useGitStatus({ workspaceId, repoId })` 默认 `pollMode: 'active'` → 15 s（≥120 文件则 30 s）。只有 follow-up 区传了 `'background'`  
- Attention inbox 15 s；MCP 状态 60 s（合理）；插件诊断 4 s（仅详情页打开时）  
- 会话 keepalive `conversationApi.touch` 最长 30 s  
- 工作流 `waitForWorkflowStepConversation` 默认 **150 ms** 轮询，仅在等待 step conversation 的 30 s 窗口内

### 3.5 网络

Desktop 不走公网 CDN。成本是：

- 自定义协议读盘 + V8 解析  
- Tauri/IPC：`conversation_detail`、`git_status`、`file-tree-stream`、`conversation-events`  
- 远程 Host（`BoundHostTransport`）才有真正的网络；本报告按本机 Host 计  

Web 模式（`WebTransportBootstrap`）会多一跳 HTTP；同一套 JS 预算仍然成立。

### 3.6 打包与运行时

```34:93:frontend/vite.config.ts
function createManualChunks(id: string): string | undefined {
  // mermaid / shiki / monaco / xterm / diff / dockview / tauri → 独立 chunk
  return 'vendor'; // 其余全部
}
```

注释写明：曾经把 icons/radix 拆出去，结果在 `React.forwardRef` 之前执行，Host 白屏。这是真实约束：**React 必须先于 Radix/lucide**。正确做法是 `vendor-react` 独立且作为其它 chunk 的依赖，而不是把 xyflow/gsap/katex 和 React 捆在一起。

其它运行时事实：

- `main.tsx` 始终 `React.StrictMode`（生产不双调用，仅开发）  
- `optimizeDeps.include: ['lucide-react', '@module-federation/runtime']` 加速 dev，不影响 prod 体积  
- sourcemap 默认关（`VITE_SOURCEMAP === 'true'` 才开）  
- 插件 Module Federation 运行时在 `pluginFederation.ts`，进工作区才用  
- Windows：`usesSolidHostChrome()` → 无 WebGL 玻璃；macOS：Liquid Glass + 多层 blur  

---

## 4. 优化项（按影响排序）

图例：

- **立即**：不改视觉、不改产品行为，回归面可控  
- **后续**：要实机采样、较大回归，或触及 DESIGN.md 材料  

每项含：问题、原因、证据、影响范围、方案、预期收益、步骤、风险。

---

### P0-1 启动 vendor 吞掉懒加载库

- **优先级：** P0　**批次：** 立即  
- **问题：** 主窗口解析 4.7 MB `vendor-Dwchowf3.js`，其中包含打开 Kanban / 公式 / 加载条 / macOS 玻璃才需要的代码。  
- **原因：** `createManualChunks` 把除 mermaid/shiki/monaco/xterm/diff/dockview/tauri 以外的 `node_modules` 全部命名为 `vendor`。Rollup 同名 chunk 会与 React 打在一起，并被 `index.html` modulepreload。  
- **证据：**  
  - `frontend/dist/index.html` modulepreload `vendor-Dwchowf3.js`（4,676,358 B）  
  - 该文件含 `ReactFlow`、`@xyflow`、`gsap.registerPlugin`、`katex`、`LiquidGlass`  
  - `DockviewKanbanPanel-DPv7BY6m.js`（199,778 B）不含 `ReactFlow`  
- **影响范围：** 所有冷启动（Welcome、工作区、设置窗）。Kanban 未打开也要解析 xyflow。  
- **方案：**  
  1. `vendor-react`：仅 `react` / `react-dom` / `scheduler` / `react-compiler-runtime`  
  2. 其余包 **不要** 强制同名；让动态 import 生成 `vendor-xyflow`、`vendor-gsap`、`vendor-katex`、`vendor-liquid-glass`  
  3. 若 radix/lucide 必须与 React 同图，显式列入 `vendor-react-ui`，并在构建后用 HTML 依赖顺序或 `manualChunks` 保证 React 先执行（复现当年白屏测试）  
- **预期收益：** 启动 JS 从 ~5.75 MB 降到大约 **2.5–3.5 MB**（待一次 `vite build` 核对）。打开 Kanban/公式/预览时再付对应 chunk。感知：冷启动到可点击明显缩短。  
- **步骤：**  
  1. 改 `frontend/vite.config.ts` `createManualChunks`  
  2. `cmd /c "cd frontend && pnpm exec vite build"`，对比新 `index.html` preload 列表与各 chunk 体积  
  3. 跑 `frontend` 现有回归：`MainAppRoutes.test.tsx`、`DesktopHostBootstrap.test.tsx`、欢迎页、工作区、Kanban、会话 Markdown（含公式）、ProjectRail  
  4. 专门回归「Host 不是白屏」：Windows 与 macOS 各开一次主窗  
- **风险：** 拆错顺序会再次白屏。必须保留「React 先于 Radix」测试或手工检查。不要把 `lucide-react` 单独提到 React 之前。

---

### P0-2 Windows 仍解析 liquid-glass-react

- **优先级：** P0　**批次：** 立即  
- **问题：** Windows 运行时不用 WebGL 玻璃，却在启动 vendor 里解析 `LiquidGlass` / `WebGL` / `displacementScale`。  
- **原因：** `frontend/src/components/ui/host-glass.tsx` 静态 `import LiquidGlass from 'liquid-glass-react'`。`usesSolidHostChrome()` 只跳过组件挂载，跳不过模块求值。`ProjectRail`、`SettingsUi`、`BranchInfoHeader` 都引用 `HostGlass`。  
- **证据：** `host-glass.tsx` 第 2 行静态 import；vendor 含 `LiquidGlass`；Windows 分支渲染普通 `div[data-host-chrome=solid]`。  
- **影响范围：** 全部 Windows/Linux 主窗与设置窗启动。macOS 仍需要该库，但应在 ProjectRail 首次绘制时加载，而不是和 React 捆在一起。  
- **方案：** `const LiquidGlass = lazy(() => import('liquid-glass-react'))` 或 `await import()`；solid 分支零引用该模块。配合 P0-1，该库不得再进入 `vendor`。  
- **预期收益：** Windows 启动少解析一块 WebGL 玻璃运行时（量级随 P0-1 一起从 vendor 中消失）。视觉：Windows 仍为实色，macOS 仍为 Liquid Glass。  
- **步骤：** 改 `host-glass.tsx`；补 `host-glass.test.tsx`：solid 平台不加载 `liquid-glass-react`（可用 `vi.mock` 断言 import 次数）。  
- **风险：** macOS 第一帧可能闪一下实色再变成玻璃。用与现网相同的 fallback `div` 尺寸（`solidHostChromeStyle`）避免布局跳动。

---

### P0-3 Shiki 全家桶 9.3 MB

- **优先级：** P0　**批次：** 立即  
- **问题：** 会话里几乎必有代码块。第一次高亮下载并解析 **9.3 MB** `vendor-shiki-*.js`。  
- **原因：** `shikiHighlighter.ts` 使用 `import('shiki')`（bundled 入口），`createHighlighter({ langs: [bash, css, diff, html, javascript, json, markdown, python, rust, tsx, typescript, yaml] })`。Shiki v3 的 bundled 入口会带上 wasm + 大量语法。  
- **证据：**  
  - `frontend/src/utils/shikiHighlighter.ts` `getShikiRuntime()` → `import('shiki')`  
  - `vendor-shiki-CE9Ifj6Z.js` = 9,325,027 B  
  - 调用方：`CodeBlock.tsx`、`ToolArtifact.tsx`、`FilePreviewPopover.tsx`  
- **方案（视觉不变：仍用 github-light / github-dark-default）：**  
  1. 改 `shiki/core` + `engine-javascript` 或 `engine-oniguruma`  
  2. 语言用 `import('shiki/langs/typescript.mjs')` 这类按需包；保持现有 `INITIAL_LANGUAGES` 预加载列表  
  3. 未在初始列表的语言维持现在的 `ensureLanguage` 动态加载  
  4. 不要把 shiki 打进启动 vendor（已独立，保持）  
- **预期收益：** 首次代码高亮从 ~9.3 MB 降到 **大约 200–800 KB 核心 + 每种语言几十 KB**（以一次 build 为准）。流式会话 INP/长任务下降。  
- **步骤：** 改 `shikiHighlighter.ts` 与其测试；`vite build` 看 `vendor-shiki` 消失或显著变小；用 TS/Rust/Python/未知语言代码块做快照测试。  
- **风险：** 个别冷门语言高亮延迟一次网络/磁盘；主题 token 颜色必须与现网一致（锁定两个 bundled theme 名）。禁止换成另一套配色。

---

### P0-4 文件树全量 DOM

- **优先级：** P0　**批次：** 立即  
- **问题：** 展开大型仓库时左侧栏掉帧、内存随可见节点线性涨。  
- **原因：** `FileTreePanel` 递归渲染所有展开节点，无 windowing。每个节点含按钮、chevron、`FileIcon` SVG innerHTML。  
- **证据：** `FileTreePanel.tsx` 约 1764 行 `nodes.map((node) => renderNode(node, 1))`，1608 行 `node.children.map(...)`；工程内无 `useVirtualizer`/`Virtuoso` 用于文件树。默认布局 `buildDefaultLayout` 会挂载左侧 activity 面板（常见即文件树）。  
- **影响范围：** 所有带文件树的工作区；`expand all` 路径尤其重。  
- **方案：** 把展开树压平成 `[depth, node]` 列表，用现有 `@tanstack/react-virtual`（时间线已用，避免再引入行为差）。行高固定（现有 CSS 行高），缩进用 `padding-left`。保留懒加载目录、拖拽、预览 popover、键盘。  
- **预期收益：** 数千节点时 DOM 保持几十行；展开/滚动帧时间回到 16 ms 量级（待测）。功能：展开/折叠/定位/引用不变。  
- **步骤：**  
  1. 抽 `flattenVisibleFileTree(nodes, expanded)`（已有 `file-tree-utils.ts` 可延伸）  
  2. 虚拟列表替换递归 `renderNode` 的子树挂载  
  3. 跑 `FileTreePanel.truncated.test.tsx`、`file-tree-utils.test.ts`、`worktree-scan-and-filetree-regressions.test.js`  
  4. 手工：大仓库展开 `node_modules` 一节，滚动、多选、拖到 composer  
- **风险：** 虚拟化与现有 expand-all / lazy listing / 预览锚点 / 键盘上下移动耦合。不要重写数据层，只换渲染。行高估计不准会导致滚动跳动——用现网 CSS 实测一行高度作为 `estimateSize`。

---

### P0-5 安装包内未引用 PNG + 首跑截图过重

- **优先级：** P0　**批次：** 立即  
- **问题：** dist 里 11.3 MB PNG。其中约 4.3 MB 无任何源码引用；首跑 onboarding 一次解码约 6 MB 位图。  
- **原因：** `frontend/public/` 遗留截图；`ProductStack` 同步挂载 5 张 PNG，无尺寸、无现代格式。  
- **证据：**  
  - 全仓库 0 命中 `guide-images/`、`vibe-kanban-screenshot-overview`、`beta-workspaces-preview`  
  - `ProductStack.tsx` 对 5 张 `product-stack-*.png` 直接 `<img src>`，无 lazy  
  - 体积见 §2.1  
- **影响范围：** 安装包体积；首次运行 onboarding（`FirstRunExperience` 已 lazy，但进入后立刻解码 5 图）。日常工作区不受未引用 PNG 影响。  
- **方案：**  
  1. 删除未引用 public PNG（或移出 `frontend/public`）  
  2. onboarding 图压到 WebP/AVIF，单张目标 ≤ 200 KB，并写死 `width`/`height` 或 `aspect-ratio` 防 CLS  
  3. 非首屏截图 `loading="lazy"`；默认只解码最前面 1–2 张  
- **预期收益：** 安装包减少约 **4.3 MB**（删除）+ onboarding 再减数 MB。首跑动画更顺。视觉：截图内容不变，只换编码与清晰度（需对比 DESIGN 首跑）。  
- **步骤：** 列 `public` 引用图；`rg` 确认无引用后删除；替换 onboarding 资源；跑 `FirstRunExperience.test.tsx`。  
- **风险：** 外部文档若硬编码这些 PNG 路径会 404（仓库内无引用）。压缩过度发糊——保留一份 PNG 源在设计资产目录，产品只发 WebP。

---

### P1-1 双语言 i18n 同步打进主包

- **优先级：** P1　**批次：** 立即  
- **问题：** 用户一次只用一种语言，但 `index.js`（1.04 MB）含 zh-CN + en 全量资源。`settings.json` 单语言约 150 KB。  
- **原因：** `frontend/src/i18n/index.ts` 静态 import 18 个 JSON。`main.tsx` 在 render 前 `import '@/i18n'`。  
- **证据：** 源码 18 个 JSON 合计约 0.52 MB；`index-BDiRGqto.js` 含 `settings.json`。  
- **影响范围：** 每次启动。  
- **方案：** 打包当前语言（`getUiLanguage()` 同步可读 localStorage）；另一种语言 `import()`。默认 zh-CN 的用户不再解析 en。  
- **预期收益：** `index.js` 减少约 **200–400 KB**。切语言时多一次短暂加载。  
- **步骤：** 改 i18n 初始化；补切换语言测试；确认设置窗与主窗语言一致。  
- **风险：** 首屏若在 JSON 到达前 render 会闪 key。保持当前语言同步 embed，只懒加载「另一种」。

---

### P1-2 FileIcon 目录不应在应用壳

- **优先级：** P1　**批次：** 立即  
- **问题：** 工作区 tab 偶发文件图标，却让主包依赖近 1 MB 的 SVG 字典。  
- **原因：** `PanelRegistry.tsx` 静态 import `FileIcon`。`fileIcons.ts` `import * as icons`。  
- **证据：** `icons.ts` 991,825 B；`index-BDiRGqto.js` 含 FileIcon 的 `dangerouslySetInnerHTML`；`DockviewFileTreePanel-*.js` 仅 33,722 B（图标不在该 chunk）。  
- **方案：** Panel tab 用 lucide 或按扩展名的小映射；完整 VS Code 风格图标只在 `FileTreePanel` / 预览 tab 动态 import `fileIcons`。  
- **预期收益：** 主包再降数百 KB；文件树打开时再加载图标表。视觉：文件树图标保持原 SVG；tab 上若已是 lucide 则不动。  
- **步骤：** 看 `PanelRegistry` 谁用 `FileIcon`；能换成 lucide 的换成 lucide；其余 `lazy(() => import('@/components/FileIcon'))`。  
- **风险：** tab 图标与树图标短暂不一致。先对 tab 做视觉对照再改。

---

### P1-3 Monaco 预加载拉起 7 MB TS worker

- **优先级：** P1　**批次：** 立即  
- **问题：** 打开普通文件预览也会配置 `tsWorker`；点到 TS/JS 时解析 **7.0 MB** `ts.worker-*.js`。  
- **原因：** `monacoRuntime.local.ts` 无条件 import 五个 worker，`getWorker` 对 `typescript|javascript` 返回 `tsWorker`。`PanelActionsContext` / `DockviewPreviewPanel` / `MergeConflictEditor` 在「即将打开」时 `preloadMonacoEditor()`。  
- **证据：** dist 中 `ts.worker-DGHjMaqB.js` = 7,020,502；`vendor-monaco` = 4,303,946。  
- **方案：**  
  1. worker 改动态 `new Worker(new URL(..., import.meta.url))`，按 `label` 才 import  
  2. 预览 JSON/Markdown/纯文本不要 preload TS worker  
  3. 合并编辑器按语言同样按需  
- **预期收益：** 打开非 TS 预览少 7 MB 解析；TS 文件第一次打开仍付费。功能：高亮/补全不变。  
- **步骤：** 改 `monacoRuntime.local.ts`；测试 `DockviewPreviewPanel.test.tsx`、合并编辑器。  
- **风险：** worker URL 在 Tauri 自定义协议下要验证。先在 Windows WebView2 打开 json 与 ts 各一次。

---

### P1-4 Git 面板默认 active 轮询

- **优先级：** P1　**批次：** 立即  
- **问题：** Git 面板挂载即 15 s 一轮 `getGitStatus`（大仓库 30 s），即使面板被 `onlyWhenVisible` 藏起来，只要组件仍挂着就会轮询。  
- **原因：** `GitPanel.tsx` 调用 `useGitStatus` 不传 `pollMode`，默认 `'active'`。`useGitStatus` 在 `fileCount >= 120` 才降频。  
- **证据：** `useGitStatus.ts` 第 37、58–62 行；`GitPanel.tsx` 第 148 行；仅 `TaskFollowUpSection` 传 `'background'`。  
- **影响范围：** 打开过 Git 面板的工作区；大仓库时与文件树 listing 争用后端。  
- **方案：** 对接 Dockview 可见性：可见 `'active'`，隐藏 `'paused'` 或 `'background'`。可用 `api.onDidActivePanelChange` 或面板 `isVisible`。  
- **预期收益：** 后台 Git 面板不再 15 s 打一次 status。状态条数字仍可通过事件/`file-tree-stream` 更新（若已有）。  
- **步骤：** 改 `GitPanel`；补测试：隐藏面板时 `refetchInterval === false`。  
- **风险：** 切回 Git 面板时 status 可能旧 15–60 s。切回时 `invalidateQueries` 一次即可。

---

### P1-5 进程级 conversation-events 仍有订阅者

- **优先级：** P1　**批次：** 立即  
- **问题：** 任意会话的 row-op 都会进入该监听器。  
- **原因：** `useAgentLongRunningTerminals.ts` 第 181 行 `listenToConversationEvents((batch) => applyConversationBatch(batch))` 无第二参。  
- **证据：** `events.ts` 无 id 时订阅 `conversation-events`；时间线/composer/feedback 已改为带 id。  
- **影响范围：** 多会话并行时的主线程与 IPC。  
- **方案：** 改为按当前 live terminal 的 `session_id` 订阅 `conversation-events:${id}`，或改用已有的 `agent-terminal-events`（该文件已在听）。  
- **预期收益：** 去掉一条进程级热通道。功能：终端跟随会话结束的逻辑保持。  
- **步骤：** 读 `applyConversationBatch`；能删则删，不能则按 session 订阅。补 `useAgentLongRunningTerminals` 测试。  
- **风险：** 漏订阅导致终端 UI 不收尾。用现有 live terminal 列表做对照测试。

---

### P1-6 会话打开仍走 `conversation_detail` 的 timeline 字段

- **优先级：** P1　**批次：** 立即（前端）/ 后续（若要改 IPC 形状）  
- **问题：** 打开会话先 `detail()`，payload 仍带 `timeline`（最多 80 行）。设置摘要等路径也会 prefetch detail。  
- **原因：** `useConversationTimeline` `loadDetail` → `conversationApi.detail` → `conversation_detail`。后端 `project_open(..., OPEN_TIMELINE_ROW_LIMIT)`。`turns` 已空，timeline 仍在。  
- **证据：** `useConversationTimeline.ts` 128–143 行；`OPEN_TIMELINE_ROW_LIMIT = 80`；`shared/types.ts` `DbConversationDetail.timeline`。  
- **方案：** 前端打开改为：summary/controls 与 `timelinePage({ limit: 80 })` 并行；`detail` 不再嵌 timeline（需后端契约，可能超出「只改前端」）。若本迭代只改前端：打开后立刻用 `timelinePage`，忽略 detail 内重复 rows。  
- **预期收益：** 打开长会话的 IPC 与 JSON parse 下降；与 ADR-0061 对齐。  
- **步骤：** 先量一次 80 行 detail 的 JSON 字节；再决定是否动后端。前端改 `loadDetail` 与 `conversationApi.test.ts`。  
- **风险：** 漏掉 `session_modes` / `available_commands` 会导致 composer 控件空一帧。这些字段必须留在 summary 调用里。

---

### P2-1 双虚拟列表库

- **优先级：** P2　**批次：** 后续  
- **问题：** `react-virtuoso` 与 `@tanstack/react-virtual` 并存，增加 vendor 与心智负担。  
- **证据：** 时间线用 tanstack；GitLog / ProcessLogs / BranchSelector 用 virtuoso；vendor 含 virtuoso。  
- **方案：** 新代码只用 tanstack；后续把三处 virtuoso 迁过去后移除依赖。  
- **预期收益：** 数十 KB 级，主要是维护。  
- **风险：** Git log 滚动位置、stick-to-bottom 行为要逐个对。不要和 P0-4 抢同一 PR。

---

### P2-2 Noto Sans SC 98 个子集进安装包

- **优先级：** P2　**批次：** 后续  
- **问题：** 4.93 MB woff2 中大部分是 Noto 切片；中文 Windows 会按需下载多片，但仍全部打进安装包。  
- **原因：** `@fontsource-variable/noto-sans-sc/wght.css` 的 unicode-range 策略。DESIGN.md 要求 Windows/Linux 用 Noto，不能改成雅黑。  
- **方案：** 用 glyphhanger 按产品 UI 字表（中文文案 + 常用标点）做 **一份** variable woff2，目标 1–2 MB；保留 unicode-range 回退或单文件。macOS 继续系统 PingFang。  
- **预期收益：** 安装包减 3 MB 量级；Windows 中文首屏少几次字体请求。  
- **风险：** 缺字回落到下一字体（可能是雅黑）。必须用现网中文 UI 做缺字扫描。视觉：字重轴要接近现在的 Variable。

---

### P2-3 主 CSS 508 KB 一次解析

- **优先级：** P2　**批次：** 后续  
- **问题：** `index-P2IDju13.css` 507,974 B，含 98 条 `@font-face` + 全量 Tailwind/legacy。  
- **原因：** `LegacyDesignScope` 静态 import Astryx CSS + `styles/legacy/index.css`（14,728 行）。  
- **方案：** 按表面拆 CSS（workspace / settings / conversation / onboarding）；字体 `@font-face` 单独文件，Windows 才加载 Noto/Inter。  
- **预期收益：** 启动 CSS parse 下降；macOS 不下载 Inter/Noto。  
- **风险：** 拆 CSS 易丢 token。必须跑 `nightSceneTokens.test.ts` 与样式契约测试。

---

### P2-4 流式 Markdown token DOM

- **优先级：** P2　**批次：** 后续  
- **问题：** 每个 Shiki token 一个 span + inline CSS 变量，流式时虚拟行内部仍很重。  
- **原因：** `CodeBlock.tsx` `TokenizedCode` 双层 map。  
- **方案：** 稳定行用 `<span>` 行级或 CSS 高亮；仅可见行 tokenize；或对超长块在流式期间用 plain text，结束后再高亮（现已有 incremental 复用完整行）。  
- **预期收益：** 长代码流式时主线程更稳。视觉：高亮颜色保持 github-light/dark。  
- **风险：** 流式结束前后闪一下未高亮。可只在 `isStreaming && lineCount > N` 时降级。

---

### P2-5 SessionSettingsSummary / AgentSettings 过大

- **优先级：** P2　**批次：** 后续  
- **问题：** 设置相关 chunk 385 KB / 328 KB，明显大于其它设置页。  
- **证据：** dist 文件名与体积。  
- **方案：** 用 bundle analyzer 看是 agent catalog、表单还是 i18n；再拆路由内组件。  
- **预期收益：** 打开设置更快。主窗不受益（设置已是独立窗 + lazy）。  
- **风险：** 低。按页拆即可。

---

### P2-6 macOS backdrop-filter 分层

- **优先级：** P2　**批次：** 后续  
- **问题：** 标题栏、侧栏、ProjectRail、popover 多层 `blur(18–30px) saturate(...)`，与 WebView 合成叠加。  
- **原因：** DESIGN.md 两层模型要求 chrome 使用 Liquid Glass。Windows 已实色回退。  
- **证据：** `styles/legacy/index.css` 多处 `backdrop-filter`；`prefers-reduced-transparency` 已有 `none`。  
- **方案：** 保持视觉：评估把 blur 限制在标题栏 + ProjectRail，侧栏用半透明无 blur（需设计确认）。本项 **不是立即**，因为可能碰到 DESIGN.md。  
- **预期收益：** macOS 滚动/拖动更稳。  
- **风险：** 改材料即改视觉，必须过 DESIGN.md 与截图对照。未获设计确认前不要做。

---

### P2-7 KaTeX 字体与 CSS 进入错误图

- **优先级：** P2　**批次：** 立即可顺手（依赖 P0-1）  
- **问题：** `loadKatex()` 动态 import `katex` + `katex.min.css`，但 manualChunks 把 katex 推进启动 vendor；dist 里还有 `KaTeX_AMS-Regular-*.ttf` 等。  
- **方案：** P0-1 完成后验证 katex 只在公式块出现时加载；字体保持 KaTeX 默认，不预加载。  
- **预期收益：** 无公式会话零 KaTeX 成本。  
- **风险：** 公式渲染首帧延迟。可接受。

---

### P2-8 GSAP 用于三点加载动画

- **优先级：** P2　**批次：** 立即可顺手（依赖 P0-1）  
- **问题：** `BrowserLoadingBar`、`FilePreviewLoading`、`FirstRunExperience` 为短动画引入 gsap。P0-1 后 gsap 会回到懒 chunk；若仍嫌大，三点跳动可用 CSS `@keyframes`。  
- **方案：** P0-1 后看 `vendor-gsap` 体积；若 >80 KB 且动画可 CSS 化，再替换。视觉：位移/透明度与现网一致。  
- **风险：** onboarding 时间轴比三点 loading 复杂，FirstRun 不要第一波就去 GSAP。

---

### P3-1 设置页 idle 预加载全部页面

- **优先级：** P3　**批次：** 后续  
- **问题：** 进入 `/settings` 后 `scheduleRemainingSettingsPreload` 在 idle 把所有设置 chunk 拉齐。  
- **原因：** `settingsPreload.ts` `preloadRemainingSettingsPages`。对设置窗有意为之，加速切页。  
- **方案：** 只预加载相邻导航项，或 2 s 后再拉。  
- **预期收益：** 设置窗打开后内存更平。  
- **风险：** 切到未预热页会闪 Loader（已有 `RouteFallback`）。

---

### P3-2 工作流 150 ms 轮询

- **优先级：** P3　**批次：** 后续  
- **问题：** `waitForWorkflowStepConversation` 默认 150 ms 打 `api.steps`，最多 30 s。  
- **方案：** 若已有 step 事件流则改为事件；否则 150 → 500 ms 对等待体感影响很小。  
- **风险：** 只影响工作流调试等待，不影响主会话。

---

## 5. 立即 vs 后续

### 立即（建议一个 worktree，按 PR 切开，避免和脏树混提交）

| 顺序 | ID | 预估 | 依赖 |
|------|-----|------|------|
| 1 | P0-1 manualChunks | 0.5–1 d | 白屏回归 |
| 2 | P0-2 HostGlass 动态 import | 0.5 d | 最好与 1 同 PR |
| 3 | P0-3 Shiki core | 1 d | 高亮快照 |
| 4 | P0-4 文件树虚拟化 | 1–2 d | 文件树测试 |
| 5 | P0-5 删未用 PNG + 压 onboarding | 0.5 d | 首跑视觉 |
| 6 | P1-1 i18n 按语言 | 0.5 d | |
| 7 | P1-2 FileIcon 脱离壳 | 0.5 d | |
| 8 | P1-3 Monaco worker 按需 | 0.5–1 d | 预览/合并 |
| 9 | P1-4 Git pollMode | 0.3 d | |
| 10 | P1-5 进程级事件 | 0.3 d | |

不要把 1–10 做成一个提交。P0-1/P0-2 必须先合，否则后面的体积对比没有基准。

### 后续

P1-6（若动 IPC）、P2-1～P2-6、P3。P2-6 要设计确认。

---

## 6. 验收方法（做完必须能量）

每次 PR 至少记录：

1. `vite build` 后 `index.html` 的 preload 列表与字节  
2. 启动 JS 合计、Shiki chunk、Monaco `ts.worker`、PNG 合计  
3. 手工：主窗冷启动、打开带代码会话、展开文件树、打开 JSON 预览、打开 TS 预览、打开 Kanban、Windows 外观不变  
4. 相关 vitest  

目标（相对本报告基线，允许 ±10% 测量误差）：

| 指标 | 现在 | 立即批次目标 |
|------|------|----------------|
| 启动 JS+CSS（index.html 引用） | 6.16 MB | ≤ 3.5 MB |
| `vendor-shiki` | 9.32 MB | ≤ 1.0 MB 或拆成 core+langs |
| 未引用 public PNG | ~4.3 MB | 0 |
| 文件树 DOM（展开 2k 节点） | ~2k 行 | ≤ 80 行量级 |
| Host 白屏 | 无 | 仍无 |

---

## 7. 明确不在本报告改动范围

- 不改 Tahoe 两层材料、圆角、字体家族决策（DESIGN.md）  
- 不关流式输出、不关虚拟时间线、不关 Preview  
- 不把 Windows 装回 WebGL 玻璃  
- 不把 Noto 换成微软雅黑  
- 不把 Core Web Vitals 当桌面 Host 的唯一 KPI  
- 不把任务管理器「应用分组 1.6 GB」算成前端泄漏（见 ADR-0080）

---

## 8. 已有正向控制（不要回退）

- 面板 `lazy` + `onlyWhenVisible`（终端）  
- 时间线虚拟化 + rAF 合批 + 80 行 open  
- Shiki 流式增量 tokenize、token cache 160  
- Mermaid / KaTeX / Monaco 源码层动态 import  
- Git 大仓库降频、MCP 60 s、插件诊断仅打开时 4 s  
- Windows 实色 chrome、`prefers-reduced-transparency` 去 blur  
- React Compiler、生产默认无 sourcemap  
- 设置页按路由拆，且非设置路径不 preload 全部设置  

---

## 9. 附录：启动与重 chunk 清单

来自 `frontend/dist`（2026-09-24）：

```
启动：
  4,676,358  assets/vendor-Dwchowf3.js
  1,038,555  assets/index-BDiRGqto.js
    507,974  assets/index-P2IDju13.css
    196,694  assets/vendor-Cdy4g0Vh.css
     37,437  assets/vendor-tauri-DCvGpxLm.js

按需（>200 KB JS）：
  9,325,027  vendor-shiki-*.js
  7,020,502  ts.worker-*.js
  4,303,946  vendor-monaco-*.js
  1,927,262  vendor-mermaid-*.js
  1,031,544  css.worker-*.js
    694,197  html.worker-*.js
    385,844  SessionSettingsSummary-*.js
    384,438  json.worker-*.js
    343,809  vendor-dockview-*.js
    327,956  AgentSettings-*.js
    294,383  vendor-terminal-*.js
    252,404  editor.worker-*.js
    237,325  AstryxMarkdown-*.js
    230,420  KanbanSessionConversationView-*.js
    199,778  DockviewKanbanPanel-*.js
```

源码锚点：

| 主题 | 文件 |
|------|------|
| chunk 策略 | `frontend/vite.config.ts` |
| 启动入口 | `frontend/src/main.tsx`、`frontend/index.html` |
| 玻璃 | `frontend/src/components/ui/host-glass.tsx` |
| Shiki | `frontend/src/utils/shikiHighlighter.ts` |
| 文件树 | `frontend/src/components/file-tree/FileTreePanel.tsx` |
| 时间线 | `frontend/src/features/conversation/useConversationTimeline.ts` |
| 图标字典 | `frontend/src/utils/icons.ts` |
| 字体 | `frontend/src/styles/fonts.css` |
| Git 轮询 | `frontend/src/hooks/git/useGitStatus.ts` |
| 进程级事件 | `frontend/src/hooks/useAgentLongRunningTerminals.ts` |
