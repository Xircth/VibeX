# CEF Browser Runtime 实施计划

**目标：** 在不迁移 Electron 的前提下，以 `tauri-apps/cef-rs` 构建跨平台
Chromium Browser Runtime，并彻底替换 iframe + preview proxy 的 Web Preview。

**技术栈：** React、TypeScript、Tauri v2、Rust、CEF、cef-rs、Vitest、Cargo test。

**约束：** 纵向 TDD；每个切片一条失败测试、最小实现、通过后再进入下一切片。
旧 Web Preview 不作 fallback，不引入第二套长期运行路径。

## TDD seams（写第一条新测试前必须确认）

1. **Browser Runtime seam（Rust）**
   - 通过 `BrowserRuntime` interface 发出 intent，并从事件流观察 tab 状态。
   - 测试 profile 隔离、导航状态、可见性、关闭与错误语义。
   - 测试不直接访问 CEF handle 或内部 map。
2. **Browser Host seam（Tauri IPC）**
   - 通过注册的 Tauri command 创建、控制、布局和关闭 tab。
   - 用 mock runtime adapter 观察序列化结果与稳定错误码。
3. **Browser Client seam（TypeScript）**
   - 通过 `browserApi` 和 `BrowserWorkspace` 的公开交互验证地址导航、后退前进、
     reload、tab 激活和错误展示。
   - 使用 `@tauri-apps/api/mocks`，不 mock React 内部 hook。
4. **CEF platform smoke seam**
   - 对打包后的应用加载受控本地站点，从用户可见结果验证 Chromium 页面、HMR
     WebSocket、Cookie/profile、popup、DevTools 与输入焦点。
   - Windows/Linux 可自动化；macOS 因 Tauri WebDriver 限制使用可重复的 native
     smoke harness 与人工发布门禁。

## 阶段 0：基线与 CEF 可行性 tracer bullet

### Slice 0.1 — 构建依赖可复现

- 将固定版本 `cef` crate 加入新的 `browser-runtime` workspace crate。
- 使用 `cef-rs` 自带下载/export 工具，不复制外部仓库源码。
- CI 与本地缓存使用任务专属 `CEF_PATH`，构建脚本不得写用户 HOME。
- Red：缺少/损坏 CEF runtime 时返回稳定的 `runtime_unavailable`。
- Green：在支持平台定位固定版本 runtime 并返回版本信息。

### Slice 0.2 — Tauri 窗口内创建单一 Chromium surface

- CEF Browser Host 在主窗口预留矩形内创建 windowed child view。
- 接入 external message pump，Tauri UI 不得被阻塞。
- 加载受控 localhost 页面并验证标题、load-complete 和关闭事件。
- 若任一目标平台无法可靠 parent windowed CEF view，停止实现并记录阻断证据；
  不切换 iframe。

### Slice 0.3 — Bundle spike

- 将 framework、resources、locales 与 helper subprocess 纳入 debug bundle。
- 验证 macOS nested helper 签名顺序、Windows runtime 目录与 Linux launcher/rpath。
- 产出每个平台独立的 runtime manifest；启动时校验 manifest 与文件完整性。

## 阶段 1：Browser Runtime 深模块

### Slice 1.1 — Tab 生命周期

- 新建 `crates/browser-runtime`。
- 实现 `create_tab`、`set_surface`、activate/hide、`close_tab` 与事件流。
- 同一 tab 的页面上下文跨 React render 和 Dockview 切换保持存活。

### Slice 1.2 — 导航

- 实现 navigate、back、forward、reload、stop、focus 与 zoom。
- CEF load/display handler 生成 `BrowserEvent::StateChanged`。
- 地址栏只消费事件状态，不猜测 history 状态。

### Slice 1.3 — Profile

- 实现 Global、Workspace 与 Ephemeral request context。
- Workspace profile 路径通过 Tauri path resolver 注入，不在 runtime 中硬编码。
- 测试相同 profile 共享 Cookie，不同 profile 隔离，Ephemeral 关闭后不留数据。

### Slice 1.4 — 浏览器政策

- popup 默认变为新 tab；显式 external disposition 才交给系统浏览器。
- 权限请求进入 VibeX UI 决策，不自动允许。
- 下载进入明确的 download event 与用户选择路径流程。

## 阶段 2：Tauri Host 与 React chrome

### Slice 2.1 — Tauri commands/events

- 新增 `browser_create_tab`、`browser_apply_intent`、`browser_set_surface`、
  `browser_close_tab`。
- 全部注册进 `generate_handler!`；使用拥有类型和结构化错误。
- Browser events 按 tab id 发往前端。

### Slice 2.2 — Browser client

- 新建 `frontend/src/features/browser/`，集中 IPC 与事件订阅。
- `BrowserWorkspace` 渲染地址栏、导航按钮、加载状态和 surface placeholder。
- `ResizeObserver` 生成布局快照；相同 bounds 不发 IPC，一帧最多一次。

### Slice 2.3 — Dockview cutover

- Web Preview panel 使用 `BrowserWorkspace`。
- 关闭 panel 时关闭 tab；隐藏或移动 group 时只更新 visibility/surface。
- 删除 `ReadyContent` 中的 iframe 页面承载职责。

## 阶段 3：VS Code 级开发者能力

### Slice 3.1 — DevTools/CDP

- 用 CEF DevTools message observer 建立 CDP transport。
- 支持原生 DevTools、console、network、DOM snapshot 与截图。
- 设置有界事件缓存与背压，不能把 network body 默认推给 React。

### Slice 3.2 — Inspect element 与 agent handoff

- 用 CDP DOM/Overlay 实现元素选择。
- 选择结果包含 selector、outerHTML、accessible name、bounding box 与 source map
  可用时的源位置。
- “Add element to chat”只传结构化结果，不安装或修改用户项目依赖。

### Slice 3.3 — Device emulation 与 find

- 通过 CDP 实现 viewport、DPR、touch、user agent 和 media emulation。
- find-in-page 使用 CEF browser host 能力。

## 阶段 4：删除旧架构

- 删除 `src-tauri/src/preview_proxy.rs` 及注入 bundle。
- 删除 `get_preview_proxy_url` command 与前端调用。
- 删除 iframe bridge、companion 安装提示及旧实现专属测试。
- 删除不再使用的 Tauri child WebView permissions。
- 全仓搜索不得出现 Web Preview 对 `iframe`、`preview_proxy` 或 companion 的运行时
  依赖。

## 验收门槛

- `pnpm run check`
- `pnpm run lint`
- `cd frontend && pnpm test`
- `cargo test --workspace`
- 三平台 debug bundle 启动并加载同一受控测试站点。
- Vite HMR 连续更新不整页刷新；WebSocket 连接保持。
- GitHub 登录、workspace Cookie 隔离、popup、新 tab、下载、DevTools、元素选择通过。
- Dockview resize/切 tab 时无页面重建，surface 布局无持续空闲 IPC。
- CEF 资源缺失时显示稳定错误，不进入旧实现。

## 风险控制

- **Event loop：** 阶段 0 首先验证，失败即阻断，不把风险延后到 UI 完成后。
- **Native z-order：** 页面区域不允许 React overlay；工具 UI 使用相邻 pane。
- **发行体积：** 记录每个平台 artifact 增量，但不以退回系统 WebView 解决。
- **安全升级：** 固定 CEF 版本，建立月度升级和紧急 Chromium CVE 更新流程。
- **许可：** bundle 包含 CEF/Chromium third-party notices，发布检查验证其存在。

## 2026-07-22 实施快照

本 worktree 已完成可运行的纵向切片，且页面引擎只有 CEF 一条路径：

- Browser Runtime、Tauri command/event adapter、CEF external message pump、原生 child
  view、Global/Workspace/Ephemeral request context 已接通。
- React browser chrome 已接管 Web Preview，支持地址导航、前进、后退、刷新、停止、
  焦点、原生 DevTools、Dockview 可见性与逐帧合并的 surface 布局同步。
- 已建立有界 CDP transport，并用 `DOM`/`Overlay` domain 实现不注入页面脚本的元素
  选择；旧 iframe、HTTP proxy、注入 bundle 与 companion 安装链路已删除。
- macOS CEF framework、resources 和五个 helper app 已纳入 Tauri bundle 与递归签名；
  打包 smoke test 已验证主应用启动及签名后的 GPU subprocess 启动。Linux/Windows
  staging、resource overlay 与 Linux rpath 已实现，但仍须在对应 CI runner 上做实机
  bundle 验证。

随后完成的浏览器能力：

- popup 由 Browser Runtime 创建同 profile 的受控 sibling tab；React tab strip 只切换
  native surface 可见性，不重建页面。
- 下载保留 Chromium 原生 Save As，并通过事件流显示进度、完成状态与取消操作。
- CEF 权限 callback 会等待 VibeX 显式 Allow/Deny，不静默允许或拒绝。
- 已交付 native zoom、find-in-page，以及通过 CDP 实现的 desktop/tablet/mobile
  viewport、DPR、touch、UA 和 media emulation。

以下仍属于发布门禁，而不是旧实现 fallback：

- 原生 DevTools 与通用 CDP 已可用；专用 console/network pane 与 screenshot UI 尚未
  交付，但底层 domain/transport 不需再次重构。
- Windows、Linux bundle smoke、HMR/Cookie/login 的三平台端到端矩阵仍是正式发布的
  必须条件。
