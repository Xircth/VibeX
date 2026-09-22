# Design：移除 CEF 浏览器链路，以 Codeg 架构交付官方 `vibex.browser` 插件

**日期：** 2026-09-20  
**状态：** `ready-for-implementation`  
**范围：** 桌面 Host 原生标签 + 官方插件产品面。不含把用户 Chrome/Safari Cookie 罐导入；不含远程/Server 上的原生标签（与 Codeg 相同：无 webview 句柄则 MCP 不广告浏览器工具）。

## 目标与非目标

**目标**

1. 删除当前 CEF Web Preview 整条链路（Rust crate、桌面壳 API、前端 `features/browser`、打包 helper）。
2. Host 按 Codeg 实现系统 WebView（wry child / Linux 独立窗）、独立 Cookie profile、隔离 world、grant、eval 闸门。
3. 补齐插件壳层：右侧栏图标、标签栏「+」可多开浏览器页；表现与现在内置浏览器一致。
4. 官方插件 `vibex.browser` 交付：浏览、点选进 Composer 草稿、Agent 操作页面、Agent 经确认跑 JS。

**非目标**

- 保留 CEF 作为 fallback 或编译 feature。
- 插件 Worker/App 自己 `build_as_child`。
- 读取系统浏览器 Cookie 文件。
- 把浏览器工具做进平台 `vibex-mcp`。
- 按插件 ID 特判官方包。
- 扩大到 chat channel、远程预览代理重写、设备模拟全套 CDP。

## Key Decisions

1. **引擎在 Host，产品在插件。** Codeg 的 wry/shim/grant/eval 必须进 `src-tauri`（或 `crates/browser-host`），因为插件没有 native 窗缝。插件只通过公开 `host.call browser.*` 与贡献点工作。
2. **领域模型换成 Codeg 的 tab/grant/snapshot/act/eval，废弃 `BrowserIntent::ExecuteDevTools`。** 继续用 CEF 形 intent 包 wry 会两边都不像。
3. **Cookie 只做应用内 profile。** 独立于主 UI WebView 的 data store；重启复用登录。换引擎不迁移旧 `chromium/` 目录（当新装）。
4. **壳层入口全部改贡献点。** 删除 `RightPanelSidebar` Globe 特判和「+」硬编码「浏览器」。右侧用 `app.rail.section`；中央用 `app.panel` 且 `multiInstance: true`。
5. **点选进输入框走 Conversation draft，不走 enqueueInput。** 否则会直接开 Turn。
6. **Agent 工具在插件 `content.mcp`。** 开关默认关；调用时重读插件启用状态。
7. **拆除在插件切流之后。** 先并行落地 wry Host + 插件，再删 CEF。中间允许一个开发者开关 `VIBEX_BROWSER_ENGINE=cef|wry` 仅存在于 M3，M4 删除开关与 CEF。
8. **Codeg 源码按 Apache-2.0 适配进仓，登记 `docs/third-party/codeg-adoption.md`。** 不 byte-copy 进插件包。

## 架构切分

```text
用户
 ├─ 右侧栏图标          app.rail.section（插件）
 ├─ 标签栏 +            app.panel multiInstance（插件）
 └─ 对话链接            Host 链接策略 → 同一 open 路径

官方插件 vibex.browser
 ├─ Federation chrome（地址栏/tab 条/查找/确认框）
 ├─ content.mcp（browser_* 工具）
 └─ Worker：host.call browser.* / conversation.draft.insert

Host（替换 CEF）
 ├─ wry child webview（Linux：owned window）
 ├─ 隔离 world + Playwright aria bundle（从 Codeg browser-agent 移植）
 ├─ profile Cookie 罐
 ├─ grant / eval confirm / pick
 └─ host.call browser.*  （CapabilityBroker）
```

远程与 `vibex-server`：`browser.capabilities.available=false`；MCP 不注入 browser 工具组。

---

## 1. 浏览器链路拆除

### 1.1 必须删除的模块与文件

**Rust / 打包**

| 路径 | 原因 |
| --- | --- |
| `crates/browser-cef/` 整棵 | CEF 引擎、`stage_cef_runtime`、Windows DComp 开关 |
| `src-tauri/src/bin/vibex_cef_helper.rs` | CEF 子进程入口 |
| `src-tauri/src/cef_pump.rs` | UI 线程 external pump |
| `src-tauri/src/commands/browser.rs` | 桌面壳 `browser_create_tab/apply_intent/close_tab/get_tab` |
| `src-tauri/src/commands/mod.rs` 的 `pub mod browser` | 同上 |
| `src-tauri/src/lib.rs` 中 CEF bootstrap、`setup_browser_runtime`、`schedule_cef_pump`、`pump_cef_session`、invoke 注册四条命令 | 启动路径 |
| `src-tauri/Cargo.toml` `browser-cef` 依赖与 `[[bin]] vibex_cef_helper` | 链接 |
| `Cargo.toml` workspace member `crates/browser-cef` | 工作区 |
| `scripts/stage-cef-runtime.js`、`scripts/stage-cef-runtime.test.js` | 发行物 CEF 暂存 |
| `scripts/run-tauri-build.js` 中 `--bin vibex_cef_helper` | 构建 |
| `scripts/run-tauri-dev-macos.js` 中 helper / `browser-cef` | 开发启动 |
| `src-tauri/src/bin/generate_types.rs` 里四条 `browser_*` 壳命令名 | 生成 `shared/hostCommands.ts` |
| `src-tauri/tests/browser_commands.rs`、`src-tauri/tests/windows_subsystem.rs` 中 helper 断言 | 契约测试 |
| `frontend/tests/cef-browser-runtime-architecture.test.js` | 架构锁，M4 改为锁 wry+插件 |
| `frontend/tests/desktop-release-contract.test.js` 中 CEF/helper 断言 | 发行契约 |

**保留并改写（不要删文件名，换实现）**

- `crates/browser-runtime/`：领域 crate 改成 Codeg 模型（Grant、Snapshot、Act、Eval、Pick）。现有 `BrowserIntent::ExecuteDevTools` 删除。
- `src-tauri/src/windows_webview2.rs`：**保留**。那是主 UI WebView2 的 occlusion 开关，与 CEF 预览无关；长会话仍需要。

**前端**

| 路径 | 处理 |
| --- | --- |
| `frontend/src/features/browser/` 整目录 | 删除。chrome 迁到插件 Federation |
| `frontend/src/components/panels/DockviewWebPreviewPanel.tsx` 及其 test | 删除 |
| `PanelRegistry` 中 `PANEL_IDS.WEB_PREVIEW`、`dev-preview` 别名、favicon 特判 | 删除 |
| `useLayoutStore.ts` `WEB_PREVIEW: 'web-preview'` | 删除；布局反序列化把旧 id 映射到插件面板或丢弃 |
| `PanelActionsContext.openWebPreview` | 删除；改为 `openPluginPanel` 多实例 |
| `RightPanelSidebar.tsx` Globe 硬编码块 | 删除；改渲染 `app.rail.section` |
| `WorkspaceTabAddMenu.tsx` 硬编码「浏览器」项 | 删除；只留插件 `app.panel` |
| `WorkspaceOverlayContext` 对 `nativeSurfaceOverlay` 的 import | 随 features/browser 删除；插件面板自己管 overlay |
| `i18n` `webPreviewPanel.*`、`general.linkOpenBuiltin` 文案 | 改为「浏览器插件」或删除 builtin 选项，只留系统浏览器 / 插件（插件未启用时仅系统） |
| `ClickedElementsProvider` + `inspectTypes.ts` | **保留类型与 Composer 插入。** `inspectTypes` 从 `features/browser` 挪到 `frontend/src/features/composer/` 或 `lib/inspectTypes.ts`。Tauri inspector 继续用同一 payload |
| `useSessionComposerPreviewElementInsertion` | 保留；改为也消费 `conversation.draft` 事件或插件 `host.call` 插入后的前端订阅 |

**配置与依赖**

- 用户设置 `linkOpenBehavior = builtin`：迁移为「当前启用的浏览器 Provider」；无插件则视为 `external`。
- 本机目录 `app_data_dir/chromium/`：不自动删（避免误删）；设置页「清除浏览数据」只清新 profile 根。发行说明写明 CEF Cookie 不迁移。
- `tauri.conf.json` / 生成的 bundle 中 CEF framework、locales、helper app：从打包脚本移除。
- ADR：`0007` 加 superseded 段，指向本规格；`0069` Batch 5 从「CEF Runtime resource」改为「wry Host provider + `vibex.browser`」。

**生成物**

- `pnpm run generate-types`：`DESKTOP_SHELL_COMMANDS` 去掉四条 `browser_*`。
- `shared/hostCommands.ts` 由生成器更新，禁止手改。

### 1.2 调用链（拆除对象）

```text
RightPanelSidebar Globe / WorkspaceTabAddMenu 浏览器 / 对话链接
  → PanelActionsContext.openWebPreview | openOrFocusPanel('web-preview')
  → Dockview 组件 web-preview
  → BrowserPanel
  → browserApi.createTab / applyIntent
  → desktopShellCall browser_create_tab | browser_apply_intent
  → commands::browser
  → BrowserRuntime + CefEngineHandle
  → cef_pump UI 线程 → CEF child HWND
```

M4 之后这条链在仓内 `rg` 应为零命中（允许 `docs/specs/codeg-browser-plugin`、`docs/adr/0007` 历史、`codeg-adoption` 记录）。

### 1.3 拆除顺序

```text
M1 壳层孔（加法，CEF 仍运行）
M2 Host wry + host.call（加法，CEF 仍运行，开发开关切引擎）
M3 官方插件接 wry；产品默认 wry
M4 删 CEF 与旧前端（不可逆除 git revert）
```

禁止先删 CEF 再做插件：中间版本会没有预览。

### 1.4 兼容

| 对象 | 策略 |
| --- | --- |
| 已保存 Dockview 布局里的 `"web-preview"` / `"web-preview:N"` | 启动时改写为 `plugin:vibex.browser/browser` 或多实例 id；插件未启用则该槽显示「启用浏览器插件」占位，不创建 CEF |
| `linkOpenBehavior=builtin` | 读设置时若浏览器插件已启用 → 走插件打开；否则当 `external` |
| 远程客户端 | 行为与现在一致（无桌面壳则无预览）；不把 wry 搬到 Server |
| 旧 CEF profile | 不迁；文档说明需重新登录 |

### 1.5 回滚

- M1–M3：每个里程碑独立 PR，回滚 = revert 该 PR。M3 的 `VIBEX_BROWSER_ENGINE=cef` 可在一个发布周内把产品切回 CEF。
- M4：删除 CEF 后回滚只能 git revert 整个 M4 提交集，并恢复 helper 打包。M4 合并条件：M3 在 Windows 上开预览 30 分钟无 hung、无 GPU 三次崩溃路径。
- 不保留运行时「一键切回 CEF」。M4 之后二进制不含 CEF。

---

## 2. 插件 Host 能力面补全

### 2.1 壳层贡献点

#### `app.panel` 增加 `multiInstance`

现有：`kind: app.panel`，id 为 `plugin:<pluginId>/<panelId>`，再次打开则聚焦。

新增可选字段：

```ts
multiInstance?: boolean; // 默认 false
```

行为：

- `false`：保持现状。
- `true`：`openPluginPanel({ contribution, instance: "new" })` 分配 `plugin:<pluginId>/<panelId>:<n>`。
- `openPluginPanel({ contribution, instance: "focus" })`：有实例则激活最近一张；无则 `new`。
- 布局持久化存完整实例 id。插件禁用：槽位变「面板不可用」占位（已有逻辑）。

校验：`packages/plugin-cli/src/validation.ts`、`crates/plugins` parser、SDK `PanelIntegrationManifest`。

#### 新增稳定面 `app.rail.section`

ADR-0069 Batch 4 已点名，本规格作为浏览器的同批消费者（原则：孔与官方消费者同批）。

manifest：

```json
{
  "kind": "app.rail.section",
  "id": "open",
  "title": "Browser",
  "icon": "globe",
  "opens": { "kind": "app.panel", "id": "browser", "instance": "focus" }
}
```

- 只可添加，不可改删内置终端/进程/Diff/笔记。
- 渲染位置：`RightPanelSidebar.tsx` 分隔线下方（现 Globe 所在）。
- 禁用插件：该项不渲染。
- `opens.instance=focus` 对齐现在 Globe；不要每次点击堆新标签。

`app.tab`（顶级 Tab）本规格**不做**浏览器独立顶级 Tab，避免与「工作区预览区标签」重复。需要时另开规格。

### 2.2 `host.call browser.*`

Capability 名：`browser`。仅桌面 Host 实现；Server 上 `supports("browser")=false`，调用返回 `browser_unavailable`。

**谁可以调：** 当前 **已启用且为浏览器 Provider 占用者** 的插件。冲突规则：同时只允许一个插件占用 `provider.browser`（单选）。默认占用者 = 已启用的 `vibex.browser`。第三方替代插件启用时，官方包必须被用户禁用（宿主冲突 UI，不按 ID 特判）。

未占用者调用 → `browser_provider_denied`。

#### 生命周期

```text
插件 activate
  → 若其贡献含 app.panel + provider.browser 占用
  → Host 不立即 Cef/wry 初始化
  → 第一次 browser.tab.create 时创建 wry runtime（主线程）
插件 deactivate / unload
  → 关闭该占用者的全部 tab，DestroyWindow / 卸 child
  → 停泵；不要求 CefShutdown 式再入（wry 按 tab 销毁即可）
进程退出
  → 关全部 surface
```

#### 操作表

| operation | input | 成功 output | 主要错误 |
| --- | --- | --- | --- |
| `capabilities` | `{}` | `{ available, platform, surface: "child"|"window", profiles, docGuest }` | — |
| `tab.create` | `{ url?, profileId?, bounds }` | `AgentTabSummary` | `browser_bad_address`, `browser_blocked`, `browser_open_failed` |
| `tab.close` | `{ tabId }` | `{ ok: true }` | `browser_no_such_tab` |
| `tab.list` | `{}` | `{ tabs: AgentTabSummary[] }` | — |
| `tab.navigate` | `{ tabId, url }` | summary | grant / blocked / bad address |
| `surface.set` | `{ tabId, bounds: {x,y,width,height,scale,visible} }` | `{ ok: true }` | `browser_no_such_tab` |
| `profile.list` / `create` / `remove` / `clear` | id/name | profiles[] | `browser_profile_unsupported`（macOS&lt;14 多 profile） |
| `grant.set` | `{ tabId, level: "none"|"read"|"control" }` | grant | `browser_not_grantable`（文档视图） |
| `snapshot` | `{ tabId, maxChars? }` | `{ snapshot }` 或 error slug | `browser_grant_required`, `browser_read_failed` |
| `act` | `{ tabId, generation, ref?, action }` | `{ action, fidelity }` | `control_required`, `stale_ref`, `action_failed` |
| `screenshot` | `{ tabId, ref?, generation? }` | `{ mime, data }` | grant |
| `console.read` | `{ tabId, minLevel?, limit? }` | entries | grant |
| `pick.start` / `pick.cancel` | `{ tabId }` | `{ requestId }` | — |
| `eval.request` | `{ tabId, code }` | 待确认或 outcome | `eval_disabled`, `eval_busy`, `eval_declined`, `control_required` |
| `eval.decide` | `{ requestId, allow }` | outcome \| declined | — |
| `downloads.list` | `{}` | records | — |

错误 slug 与 Codeg `acp/browser_tools.rs` 对齐，便于 MCP 层原样转给 Agent。拒绝是 **JSON 值** 不是 transport 失败。

#### 事件

Host Event Bus 频道（桌面）：`plugin.browser`（或复用 Host bus 带 pluginId）。

| 事件 | 载荷 |
| --- | --- |
| `tab.state` | `BrowserTabState`（url、title、loading、grant、error） |
| `tab.closed` | `{ tabId }` |
| `grant` | `{ tabId, change, level, origin }` |
| `activity` | `{ tabId, action, outcome }` |
| `eval.request` | `{ requestId, tabId, origin, title, code, expiresAt }` |
| `pick.result` | capped element payload |
| `download` | 进度/完成 |

Federation `environment.subscribe("browser", listener)` 由 Host 转上述事件。Worker 需要时用 `conversation.events` 同款 cursor 订阅，或短轮询 `tab.list`（首版允许面板只走 App subscribe）。

#### 消息通道（页面 ↔ Host）

对标 Codeg：隔离 world `codeg` / `__codegAgent` / `__codegPicker`。页面无 Tauri IPC。标签 label 前缀 `browser-` 禁止出现在 capabilities。本通道 **不是** 插件 `bridge.invoke`。

#### 权限

- 页面脚本：零 Host API。
- 插件：仅 `host.call browser.*`，且须为 Provider 占用者。
- Agent：仅 MCP 工具，再经 Host grant。工具组默认关；`eval` 另开关默认关。
- 前台会话 draft：见 2.3。eval 确认：人拒绝、超时、冷却与 Codeg 相同（120s / 15s / 单槽）。

### 2.3 `host.call conversation.draft.insert`

现有 `conversation.append.enqueueInput` 会提交 Turn，且 `conversation_scope_denied` 挡住工作区会话。

新增：

```
conversation.draft.insert
input: {
  conversationId?: string,  // 省略 = 前台工作区会话
  token: {
    kind: "page-element" | "page-screenshot" | "page-console" | "page",
    label: string,
    markdown: string,
    htmlPreview?: string
  }
}
```

规则：

- 浏览器 Provider 占用者可写 **当前前台 Conversation** 的 draft（与 Codeg「活动会话标签」一致）。
- 仍不可写任意未授予会话。
- 冲突走 draft revision（ADR-0044）：失败返回 `draft_conflict` + 当前 revision，插件不重试覆盖。
- 前端 Composer 已有 `insertPreviewElementToken`：Host 插入后发 conversation draft 更新事件，现有 hook 消费。

### 2.4 链接打开缝

删除对 `openWebPreview` 的产品依赖。Host 链接策略：

```
builtin → 若存在浏览器 Provider：tab.create（新实例）
external → 系统浏览器
```

来源（对话、工具卡、终端、编辑器、通知）可保留在 **浏览器插件设置**（对标 Codeg `browser-prefs`），存 `storage.settings`。Host 只提供 `browser.tab.create`；策略表由插件在打开前解释，或 Host 读占用者 config 的 `linkOpen` 键（键名写入插件 `config.json` schema，Host 不按插件 ID 分支）。

### 2.5 与现有系统边界

| 在 Host | 在插件 |
| --- | --- |
| wry surface、profile 目录、grant、eval 执行、scheme 白名单、管理员 `policy.json` | chrome、设置页、MCP schema、确认框 UI、standing grant 默认值 |
| Dockview 注册、rail 合成、多实例 id | 面板 Federation mount |
| Conversation draft 权威 | 触发 insert |
| ACP 注入哪些 MCP | `content.mcp` 声明与 config 开关 |

Application Core / 远程协议：`browser.*` **不进** Host Command Registry（与现在桌面壳一致）。远程不复制原生标签。

---

## 3. `vibex.browser` 插件实现（移植 Codeg）

### 3.1 身份与目录

- Publisher `vibex`，Plugin ID `vibex.browser`。
- 仓内路径：`assets/plugins/browser/`（与 office 相同，后续可 submodule）。
- 能力等价插件：默认启用、可卸载（修订 ADR-0066 对该类的例外，同 ADR-0069）。
- License：插件包 Apache-2.0；NOTICE 指向 Codeg。

```text
assets/plugins/browser/
  README.md                 # summary frontmatter
  LICENSE
  NOTICE.md                 # Codeg Apache-2.0
  package.json              # name vibex.browser
  config.json               # toolsEnabled, evalEnabled, defaultGrant, linkOpen
  .vibex-plugin/plugin.json
  contents/mcps/browser.json
  runtime/worker.mjs        # host.call 封装
  runtime/mcp-server.mjs    # stdio MCP，对标 codeg-mcp browser 组
  src/views/panel.tsx       # Federation 面板 chrome
  src/views/settings.tsx    # app.settings.page
  test/plugin.test.mjs
```

Host 侧新代码（非插件包）：

```text
crates/browser-runtime/     # 改写领域类型
crates/browser-host/        # 从 Codeg src-tauri/src/browser 适配的 wry/shim
  src/{mod,agent,eval,confirm,handoff,policy,profile,registry,
       surface,surface_child,surface_window,shim/{macos,windows,linux},
       channel,doc_guest,downloads,hooks,events,listener}.rs
src-tauri/src/browser_host.rs   # 主线程 attach、bounds、事件进 bus
browser-agent/              # 从 Codeg browser-agent 移植，产物提交
  src/{index,act}.ts
  vendor/playwright/
```

`docs/third-party/codeg-adoption.md` 增补一节：pinned commit（建议 `aace536` / tag v0.31.0）、源文件列表、目标文件、改动说明。

### 3.2 可直接移植的 Codeg 模块

源：`https://github.com/xintaofei/codeg` v0.31.0。

| Codeg | 落到 | 改动量 |
| --- | --- | --- |
| `src-tauri/src/browser/mod.rs` 模块图与「无 IPC」测试 | `crates/browser-host` | 能力文件路径改 VibeX capabilities |
| `policy.rs` 方案白名单、host rules、`CODEG_POLICY_FILE` | 同左，env 改 `VIBEX_POLICY_FILE`，路径 `/etc/vibex/policy.json` 等 | 改名 |
| `profile.rs` Cookie 罐 | 根目录 `app_data_dir/browser-profiles/` | 路径 |
| `agent.rs` GrantLevel、listener pin、activity | 原样 | 事件名 `plugin.browser` |
| `eval.rs` + `confirm.rs` + `eval-render.js` | 原样 | 确认 UI 在插件 |
| `handoff.rs` + `picker.js` | 原样 | 输出对接 draft.insert |
| `shim/{macos,windows,linux}.rs` | 原样 | wry 版本跟 Tauri 2.11 锁定 |
| `surface_child.rs` / `surface_window.rs` | 原样 | parent handle 从 VibeX `native_browser_parent` 同类 API 取 |
| `browser-agent/` + Playwright vendor 1.63 | `browser-agent/` | 全局名可保留 `__codegAgent` 或改为 `__vibexAgent`（改一处常量即可） |
| `acp/delegation/tool_schema.json` 中 `browser_*` | 插件 `contents/mcps` + mcp-server | 去掉 Codeg 其它工具 |
| `commands/browser_tools.rs` 两个开关 | 插件 `config.json`：`toolsEnabled`/`evalEnabled` | Host 每次 MCP 调用读占用者 config |
| 前端 `browser-toolbar` / `browser-eval-confirm` / `browser-agent-access` | 插件 `src/views/panel.tsx` | 换 VibeX token / i18n |
| `browser-prefs.ts` standing grant、link 来源 | 插件 config | 不要 localStorage 分窗打架；用 `storage.settings` |

**不要移植**

- Codeg 的 `codeg-mcp` 整二进制、delegation broker（VibeX 已有）。
- Codeg 端口桥（Server 非本规格）。
- CEF 任何文件。
- VibeX `BrowserPanel.tsx`、CDP Overlay 点选（WebKit 无 Overlay；点选统一 picker.js）。

### 3.3 必须改造点

1. **Parent 窗口：** Codeg 用 Tauri `WebviewWindow`；VibeX 同样。从当前 `native_browser_parent` 抽出，**不要**再给 CEF。Linux 独立窗，不嵌 child。
2. **事件：** Codeg `browser://state` Tauri emit → VibeX Host Event Bus + 插件 subscribe。
3. **MCP 注入：** 占用者插件 `content.mcp` + Host 托管 Runtime（ADR-0051）。不要改 `crates/vibex-mcp`。
4. **Composer：** Codeg `emitAttachPageToSession` → `conversation.draft.insert` + 现有 token UI。
5. **设计系统：** 插件 UI 用 `DESIGN.md` token，禁止带入 Codeg 自己的 CSS 变量。
6. **i18n：** 插件自带 en / zh-CN；Host 壳层（rail 标题）用贡献 `title`。
7. **测试：** Codeg 的 Rust 单测随模块移植；前端 Vitest 按插件 harness 重写。不引入 Codeg 的 `browser-smoke` feature。

### 3.4 移植步骤

1. 冻结 Codeg 快照 tag v0.31.0，写入 adoption 文档。
2. 新建 `crates/browser-host`，先搬 `policy`/`agent`/`eval`（纯逻辑+单测）。
3. 搬 shim + surface；用 `browser-agent:check` 锁 bundle。
4. `src-tauri` 接主线程与 `host.call`。
5. 插件 mcp-server 接同一 core（与桌面 UI 共用 grant）。
6. Federation 面板：占位矩形 ResizeObserver → `surface.set`；确认框吃 `eval.request` 事件。
7. 点选按钮 → `pick.start` → draft.insert。
8. 能力等价安装：`assets/plugins/index` + 白名单自动启用。

### 3.5 接口对齐（插件 manifest 要点）

```json
{
  "id": "vibex.browser",
  "integrations": [
    {
      "kind": "app.panel",
      "id": "browser",
      "title": "Browser",
      "icon": "globe",
      "defaultPosition": "center",
      "multiInstance": true,
      "handler": "surface.createSession",
      "remote": { "name": "browser", "entry": "dist/remoteEntry.js" }
    },
    {
      "kind": "app.rail.section",
      "id": "open",
      "title": "Browser",
      "icon": "globe",
      "opens": { "kind": "app.panel", "id": "browser", "instance": "focus" }
    },
    {
      "kind": "app.settings.page",
      "id": "settings",
      "title": "Browser",
      "icon": "globe",
      "handler": "surface.createSession",
      "remote": { "name": "browserSettings", "entry": "dist/remoteEntry.js" }
    },
    {
      "kind": "content.mcp",
      "id": "browser-tools",
      "transport": "stdio",
      "managedRuntime": { "id": "browser-mcp" }
    }
  ]
}
```

`config.json`：`toolsEnabled`（默认 false）、`evalEnabled`（默认 false）、`defaultGrant`（`none`|`read`|`control`，建议默认 `none` 或 `read`，**不要**抄 Codeg 出厂 `control`）、`linkOpen` 分来源。

### 3.6 验收标准

**产品**

- 启用插件：右侧出现浏览器图标；点击打开/聚焦一张中央标签；「+」每次新标签；地址栏导航、后退前进刷新、查找、下载进用户下载目录。
- 登录站点后重启仍登录（独立 profile）。
- 点选元素：Composer 出现可删除 token，发送前不自动开 Turn。
- 工具组关：Agent 无 `browser_*`。开：list/snapshot/act 按 grant 工作；跨 origin 撤 grant。
- eval：关则 `browser_eval_disabled`；开则每段确认，无「始终允许」。
- 禁用/卸载：右侧图标与「+」浏览器项消失；无 child view；链接走系统浏览器；已开会话再调 browser 工具失败。

**平台**

- `pnpm run plugin:no-privilege`：官方包只 import 公开 SDK。
- Host 无 `if plugin_id == "vibex.browser"`。
- Windows：开预览滚动时主 UI 可交互；无 CEF GPU 软件合成 hung（回归：进程树无 `vibex_cef_helper`）。
- `rg browser-cef` / `browser_create_tab` / `WEB_PREVIEW` 在 src 与 frontend 为零（文档/ADR 除外）。

**移植**

- `docs/third-party/codeg-adoption.md` 有完整文件对照。
- `browser-agent` bundle check 进 CI。

---

## 4. 执行计划

### 4.1 阶段与依赖

```text
M1 壳层孔（rail + multiInstance + draft.insert）     ──┐
M2 Host wry（browser-host crate + host.call）        ──┤ 可并行
                                                       ▼
                                              M3 官方插件接线（默认 wry）
                                                       ▼
                                              M4 拆除 CEF 与旧前端
```

M1 不依赖 Codeg。M2 不依赖 Federation。M3 依赖 M1+M2。M4 依赖 M3 验收。

### 4.2 角色

| 角色 | 范围 |
| --- | --- |
| Host Runtime | `browser-host`、wry、grant、eval、主线程 attach |
| Plugin Platform | contribution kind、broker `browser`/`draft`、冲突单选 |
| Frontend Shell | RightPanelSidebar、TabAddMenu、布局迁移、链接打开 |
| Browser Plugin | `assets/plugins/browser`、MCP、Federation chrome、设置页 |
| Release | 去掉 helper 打包、更新 ADR/architecture、发行说明 Cookie 不迁移 |

### 4.3 里程碑与交付物

| 里程碑 | 交付物 | 完成标准 |
| --- | --- | --- |
| M1 | `multiInstance`、`app.rail.section`、`conversation.draft.insert` | 用 `host-surface` 或临时测试插件：右侧图标、+ 多开、draft token 进当前会话 |
| M2 | `crates/browser-host`、`host.call browser.*`、adoption 记录 | 无 UI 的集成测试：create/navigate/snapshot/grant/eval 拒绝；页面无 IPC |
| M3 | `vibex.browser` 默认启用 | 第 3.6 节产品验收；开发开关仍能切 CEF |
| M4 | CEF 与 `features/browser` 删除 | 第 1.2 节 rg 门禁；发行物无 helper；Windows 冒烟 |

### 4.4 风险

| 风险 | 缓解 |
| --- | --- |
| wry child 在 VibeX 主窗上的焦点/DPI 与 Codeg 不一致 | M2 先做 Windows/macOS 嵌入冒烟，Linux 允许独立窗 |
| 多实例面板 bounds 错位导致 native 画在错误矩形 | surface.set 与 Dockview `onlyWhenVisible` 同生命周期；不可见则 hide |
| draft.insert 与本地 Composer 冲突 | 走 revision；失败展示不覆盖 |
| 移植体积大、行为漂移 | 按模块带 Codeg 单测；不改 grant/eval 语义 |
| M4 过早 | 门禁：M3 Windows 稳定性记录 |

### 4.5 立即开工清单

见 [tasks.md](tasks.md)。M1-T1、M1-T2、M2-T1 无互相阻塞，可三路并行。
