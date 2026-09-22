# Tasks：Codeg 浏览器插件

> 状态：`ready-for-implementation`。规格见 [design.md](design.md)。  
> 每项尽量 RED → GREEN；`Files` 为责任范围。

## 依赖

```text
M1 壳层孔 ──────────────────────────────┐
M2 Host wry + host.call ────────────────┤ 并行
                                        ▼
                               M3 vibex.browser 接线
                                        ▼
                               M4 拆除 CEF
```

## M1 — 插件 Host 壳层孔

### T1.1 `app.panel.multiInstance`

- **Depends**：无。
- **角色**：Plugin Platform + Frontend Shell。
- **RED**：CLI validate 拒绝未知字段以外，接受 `multiInstance: true`；Host inspect 投影该字段。前端测试：`openPluginPanel({ instance: "new" })` 两次产生两个 id；`instance: "focus"` 在已有实例时不新建。
- **GREEN**：SDK `PanelIntegrationManifest`、`validation.ts`、`crates/plugins` parser、`PanelActionsContext.openPluginPanel`、`WorkspaceTabAddMenu` 对 `multiInstance` 面板每次 `new`。
- **Files**：`packages/plugin-sdk/src/manifest.ts`、`packages/plugin-cli/src/validation.ts`、`crates/plugins/src/{package,contribution}.rs`、`frontend/src/contexts/PanelActionsContext.tsx`、`WorkspaceTabAddMenu.tsx`。

### T1.2 `app.rail.section`

- **Depends**：无（可与 T1.1 并行）。
- **角色**：Plugin Platform + Frontend Shell。
- **RED**：manifest kind 校验；Host 贡献目录含 `app_rail_section`；`RightPanelSidebar` 渲染已启用贡献；禁用后图标消失。用 `host-chrome` 或测试插件，不要写死 `vibex.browser`。
- **GREEN**：`ContributionKind::AppRailSection`、`opens` 字段、`RightPanelSidebar` 合成。内置终端/进程/Diff/笔记仍硬编码在前。
- **Files**：`crates/plugins/src/contribution.rs`、`packages/plugin-sdk`、`plugin-cli`、`frontend/src/components/layout/RightPanelSidebar.tsx`、`frontend/src/lib/api/plugins.ts`、`developer-guide.md`。

### T1.3 `conversation.draft.insert`

- **Depends**：无。
- **角色**：Plugin Platform。
- **RED**：broker 测试：占用者省略 `conversationId` 时写入前台会话 draft；非占用者 / 非前台 → `conversation_scope_denied`；`enqueueInput` 不被这条路径调用。
- **GREEN**：`PluginConversationHost` 新操作；前端 draft 更新事件接到 `insertPreviewElementToken`（可先测 hook）。
- **Files**：`crates/plugins/src/host_capability_broker.rs`、conversation host 实现、`frontend/src/components/tasks/follow-up/useSessionComposerPreviewElementInsertion.ts`、`inspectTypes` 迁出 `features/browser`。

### T1.4 链接打开切到插件面板 API

- **Depends**：T1.1。
- **角色**：Frontend Shell。
- **RED**：`openWebPreview` 调用点改为 `openPluginPanel` 多实例；无浏览器贡献时走系统浏览器。
- **GREEN**：对话/工具卡/终端链接共用一条函数。本任务可在 M3 前用占位插件验证。
- **Files**：链接点击处、`PanelActionsContext`、`GeneralSettings` 文案暂保留 builtin，M4 再改语义。

**M1 完成标准：** 测试插件启用后右侧有图标、+ 可连开多张中央标签、draft.insert 进当前 Composer。CEF 行为不变。

---

## M2 — Host wry 运行时

### T2.1 冻结 Codeg 快照并开 crate

- **Depends**：无。
- **角色**：Host Runtime。
- **RED**：`docs/third-party/codeg-adoption.md` 无浏览器一节则本任务未完成。
- **GREEN**：记录 tag `v0.31.0` / commit `aace536`；新建 `crates/browser-host` workspace member；先搬 `policy.rs`+单测（scheme 白名单）。
- **Files**：`Cargo.toml`、`crates/browser-host/`、`codeg-adoption.md`。

### T2.2 移植 grant / eval / confirm / handoff

- **Depends**：T2.1。
- **角色**：Host Runtime。
- **GREEN**：Codeg 对应单测在 VibeX crate 绿。env/路径改为 `VIBEX_*`。
- **Files**：`crates/browser-host/src/{agent,eval,confirm,handoff}.rs` 及 `src/browser-injected` 源。

### T2.3 移植 shim + surface + browser-agent

- **Depends**：T2.2。
- **角色**：Host Runtime。
- **GREEN**：`pnpm browser:agent:check`（或等价）锁 bundle；macOS/Windows child、Linux window 编译过。主线程 parent 从现有 `native_browser_parent` 抽出，不链 `browser-cef`。
- **Files**：`crates/browser-host/src/shim/*`、`surface*.rs`、`browser-agent/`、`src-tauri` 主线程 attach。

### T2.4 `host.call browser.*` + Provider 单选

- **Depends**：T2.3。
- **角色**：Plugin Platform + Host Runtime。
- **RED**：broker 测试：非占用者 denied；Server 构建 `browser_unavailable`；`tab.create` 非法 scheme 拒绝。
- **GREEN**：`CapabilityBroker` 增加 `browser`；桌面第一次 create 才初始化 wry。
- **Files**：`host_capability_broker.rs`、`src-tauri` adapter。

**M2 完成标准：** 无官方插件 UI 也能用测试 Worker 调 `browser.tab.create` 打开标签；Cookie 落在 `browser-profiles/`；标签无 Tauri IPC。

---

## M3 — 官方插件接线

### T3.1 脚手架 `assets/plugins/browser`

- **Depends**：M1、T2.4。
- **角色**：Browser Plugin。
- **GREEN**：`vibex-plugin validate` 通过；`app.panel`+`app.rail.section`+`app.settings.page`+`content.mcp` 声明齐；`plugin:no-privilege` 绿。
- **Files**：`assets/plugins/browser/**`、`assets/plugins/index/official.v1.json`、catalog 白名单。

### T3.2 Federation chrome

- **Depends**：T3.1。
- **角色**：Browser Plugin。
- **GREEN**：地址栏/导航/查找/错误页；ResizeObserver → `surface.set`；eval 确认框；Agent 共享菜单（grant.set）。从 Codeg 组件移植并换 token。
- **Files**：`assets/plugins/browser/src/views/panel.tsx`。

### T3.3 点选 → draft

- **Depends**：T1.3、T3.2。
- **角色**：Browser Plugin。
- **GREEN**：点选后 Composer 出现 token，可删，发送才开 Turn。
- **Files**：panel pick 按钮、Worker `draft.insert`。

### T3.4 MCP 工具组

- **Depends**：T2.4、T3.1。
- **角色**：Browser Plugin。
- **GREEN**：config `toolsEnabled=false` 时 Agent 无工具；true 时工具经 grant 工作；eval 独立开关。调用时重读启用状态。
- **Files**：`runtime/mcp-server.mjs`、`contents/mcps/browser.json`、Host MCP 注入读占用者 config。

### T3.5 产品默认 wry + 开发开关

- **Depends**：T3.2–T3.4。
- **角色**：Host Runtime。
- **GREEN**：默认走 wry；`VIBEX_BROWSER_ENGINE=cef` 仅开发者可切回（M4 删除）。能力等价：新装自动启用 `vibex.browser`。
- **Files**：启动路径、插件自动安装白名单。

**M3 完成标准：** design.md §3.6 产品项；Windows 开预览 30 分钟主 UI 可点。

---

## M4 — 拆除 CEF

### T4.1 删除前端旧链路

- **Depends**：M3。
- **角色**：Frontend Shell。
- **GREEN**：删除 `features/browser`（`inspectTypes` 已迁）、`DockviewWebPreviewPanel`、`WEB_PREVIEW`、Globe 特判、「+」硬编码浏览器、`openWebPreview`。布局 `web-preview*` 映射到插件实例。
- **Files**：见 design.md §1.1 前端表。

### T4.2 删除 Rust/打包 CEF

- **Depends**：T4.1 或并行但同一里程碑。
- **角色**：Host Runtime + Release。
- **GREEN**：删除 `crates/browser-cef`、`cef_pump`、`vibex_cef_helper`、四条桌面壳命令、stage 脚本。`generate-types`。架构测试改为断言 **无** `browser-cef`、**有** `browser-host`。
- **Files**：见 design.md §1.1 Rust 表。

### T4.3 文档与设置

- **Depends**：T4.2。
- **角色**：Release。
- **GREEN**：ADR-0007 superseded 段；ADR-0069 Batch 5 修订；`docs/architecture.md`；`linkOpenBuiltin` 语义；发行说明：Cookie 不迁移、无 helper。
- **Files**：ADR、architecture、settings i18n、release notes。

**M4 完成标准：** `rg` 门禁；发行物无 `vibex_cef_helper`；无 `VIBEX_BROWSER_ENGINE`。

---

## 可立即开工（无依赖）

1. **T1.1** `app.panel.multiInstance`
2. **T1.2** `app.rail.section`
3. **T1.3** `conversation.draft.insert`
4. **T2.1** Codeg 快照 + `crates/browser-host` 空 crate + `policy` 移植

以上四项可同时开四个工作树。T1.4 等 T1.1；T2.2 等 T2.1。
