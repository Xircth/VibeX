# Codeg 内置浏览器、Agent 操作浏览器、Agent 在浏览器中运行代码

> 调研日期：2026-09-20
> 仓库：[`xintaofei/codeg`](https://github.com/xintaofei/codeg)
> 快照：tag [`v0.31.0`](https://github.com/xintaofei/codeg/releases/tag/v0.31.0)，commit `aace536fe9e38575a8973ed83435199ecc2700c6`（2026-09-19）
> 合并 PR：[#723](https://github.com/xintaofei/codeg/pull/723) `feat(browser): built-in browser tabs on native webviews (P1 + P2)`，merged 2026-09-19
> 资料口径：只采用该仓库最新代码、官方文档（[docs.codeg.app/guide/browser](https://docs.codeg.app/guide/browser)、[Privacy](https://docs.codeg.app/reference/privacy)、Release notes）与已合并 PR。不把路线图或未落地注释当成已交付能力。

## 总览

三项能力都在 **v0.31.0 首次作为产品面交付**，且都绑定 **桌面端原生 webview 标签页**。它们不是三套独立系统，而是同一条栈上的三层：

| 能力 | 产品状态 | 技术选型 | 与 Agent 的接缝 |
| --- | --- | --- | --- |
| 内置浏览器 | 已交付（桌面完整；Linux 降级为独立窗口；`codeg-server` 只有 loopback 端口桥 iframe） | 平台系统内核：macOS WKWebView、Windows WebView2、Linux WebKitGTK；经 wry / tauri-runtime-wry 嵌入，**不是 CEF、不是 Playwright 驱动外部 Chrome** | 无 Agent 时仍可用：链接、下载、配置文件、本地 HTML 文档视图 |
| Agent 操作浏览器 | 已交付，默认关闭工具组 | Playwright 无障碍树（vendored v1.63.0 `ai` mode）注入隔离 JS world；操作经 MCP 工具 `browser_*` | Agent CLI 仍走 ACP；浏览器工具由 `codeg-mcp` companion 注入 |
| Agent 在浏览器中运行代码 | 已交付但默认关闭；**只是在页面 world 里跑 Agent 写的 JavaScript**，不是浏览器内 Agent 运行时，也不是 Python/WASM 沙箱 | `browser_eval`：snippet 内联进 page world 的 IIFE；每段代码单独确认 | 需要：工具组开 + eval 开关开 + 标签页 `control` 授权 + 人工逐段批准 |

一句话：**Codeg 把系统 WebView 做成工作区里的真浏览器标签页，再通过 MCP 把「读树 / 点按 / 输入 / 跑 JS」交给 ACP Agent。** Agent 进程本身仍是本机 CLI 子进程，并不在浏览器里执行。

---

## 1. 内置浏览器

### 1.1 入口

- 产品入口：对话、工具卡片、终端、编辑器、通知里的链接默认在文件栏旁开成标签页；⌘/Ctrl-click 临时改用系统浏览器。设置在 **Settings → General → Built-in browser**。
- 命令入口：前端 `src/lib/browser/browser-api.ts` 调用 Tauri `browser_*`；桌面以外 `browserCapabilities()` 固定返回 `available: false`。
- 打开标签：`commands::browser::browser_open_tab` → `open_tab_core`（`src-tauri/src/commands/browser.rs`）。
- 官方文档：[Built-in Browser](https://docs.codeg.app/guide/browser)；发布说明：v0.31.0 Release notes。

### 1.2 模块划分

Rust 模块图见 `src-tauri/src/browser/mod.rs`：

| 模块 | 职责 |
| --- | --- |
| `types` | 与前端 `src/lib/browser/types.ts` 共享的线类型 |
| `policy` | 方案白名单、站点规则、管理员 `policy.json` |
| `profile` | Cookie / 存储 / 代理 / Google 登录 UA |
| `registry` | tab id → surface + 状态 |
| `surface` / `surface_child` / `surface_window` | 嵌入子 webview vs 独立窗口 |
| `shim/{macos,windows,linux}` | 平台内核：隔离 world、eval、截图、历史、查找 |
| `doc_guest` | `codeg-doc:` 本地 HTML 受限文档视图 |
| `services` / `service_url` / `listener` | 从终端输出识别本机 dev server |
| `downloads` / `hooks` / `events` / `channel` | 下载、导航回调、状态广播、page→host 消息 |
| `handoff` | 人把页面/元素/截图/控制台递给对话 |

前端：`src/components/browser/*`（chrome、工具栏、查找栏、授权条、eval 确认框）+ `src/lib/browser/*`（偏好、授权记忆、tab store）。

### 1.3 关键组件与技术选型

**内核不是 CEF。** `src-tauri/Cargo.toml` 写明：

- 默认 feature `browser-child`：用 `tauri-runtime-wry` 再导出的 wry，`WebViewBuilder::build_as_child` 直接在工作区窗口上建子 webview。故意不走 Tauri `Window::add_child`，否则主窗口不再是 `WebviewWindow`，所有 `tauri::WebviewWindow` 命令会失败。
- macOS：WKWebView + `WKContentWorld` 名 `codeg`（macOS 11+；更早回落到 page world，报 `ChannelKind::Legacy`）。
- Windows：WebView2 + CDP isolated world 名 `codeg`（`Page.addScriptToEvaluateOnNewDocument {worldName}` + `Runtime.addBinding`）。
- Linux：WebKitGTK script world `codeg`；**子 webview 不能在 Wayland 上定位**，所以每个标签是独立顶层窗口。

**标签页没有 Tauri IPC。** 标签 label 前缀 `browser-` / `browser-popup-` / `codeg-doc-` 被测试禁止出现在任何 capability 的 `windows`/`webviews` 里，页面脚本不能调用任何命令（`browser/mod.rs` 测试）。

**方案白名单**（`policy.rs`）：顶层导航只允许 `http(s)`、`about:blank`、由 http(s) 页面铸造的 `blob:`。`file:`、`tauri:`、`javascript:`、`data:` 文档一律拒绝。子 frame 可额外允许 `data:` / `blob:` / `about:srcdoc`。

**配置文件：** cookies 与站点存储与 App 自身隔离。macOS 14+ 用 `WKWebsiteDataStore` UUID5；Windows/Linux 用独立目录。新标签默认 profile `default`。Google 登录默认伪装 Firefox UA（仅 `accounts.google.com` / `accounts.youtube.com`，可用 `CODEG_BROWSER_SIGN_IN_HOSTS` 扩展）。Linux 不支持该 UA 伪装（iframe 可偷身份）。

**管理员策略：** 启动时读一次机器级 JSON：

- macOS `/Library/Application Support/codeg/policy.json`
- Windows `%ProgramData%\codeg\policy.json`
- Linux `/etc/codeg/policy.json`
- 或 `CODEG_POLICY_FILE`

`browser.enabled: false` 关掉整个内置浏览器；`hostRules` 可 `builtin` / `system` / `block`。托管规则优先于用户规则。

### 1.4 数据流

```
链接点击 / 地址栏 / 终端 toast / Agent browser_open_tab
        │
        ▼
browser-prefs（按来源、站点规则、管理员策略决定 builtin vs system vs block）
        │
        ▼
open_tab_core ──► registry.reserve(tab_id)
                 ──► surface_child | surface_window（wry WebView）
                 ──► shim 安装隔离 world + helper.js
                 ──► navigate(http/https)
                 ──► hooks 更新 title/url/error
                 ──► events 广播 browser://state
        │
        ▼
前端 BrowserTabView 只画 chrome；页面像素由原生 child view 绘制
```

### 1.5 服务端 / Web 模式实际做到哪一步

**原生标签页不存在于 `codeg-server`。** `browser/mod.rs`：server 编译不含 webview 模块；「浏览器标签」是用户自己浏览器里的 iframe。

替代能力是 **端口桥**（`src-tauri/src/web/browser_bridge.rs`）：

- 只桥接服务器 loopback 上的 **明文 http**（`localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`）。
- 每个目标端口一个独立监听端口（默认 codeg 端口后 10 个，或 `CODEG_BRIDGE_PORTS`），页面仍在 `/`，不改写 HTML，HMR / 绝对路径模块可用。
- 工作台用 token 换短期 capability → 入口 URL 设 `HttpOnly; SameSite=Lax` cookie → 再重定向到页面。
- 不能给 Agent 读/操作；官方文档写明 *Desktop only: a browser session has no native tabs, so none of these tools are offered*。

### 1.6 限制与已知缺口（官方写明）

- Linux：独立窗口、无 HTML 文档视图、无查找、无 Google 登录 UA、失败信息更粗。
- 首发不做 favicon、下载进度、后台预加载。
- 重启只恢复 URL + 标题，不恢复滚动/表单/历史。
- macOS 14 以下：无法给标签走系统代理；配了代理则拒绝打开，而不是绕过。
- Windows 改代理要重启进程才生效。
- HTML 文档视图仅 macOS/Windows；不可共享给 Agent。

---

## 2. Agent 操作浏览器

### 2.1 入口

两道闸门，官方文档写得很清楚：

1. **工具组默认关**：Settings → General → In-conversation tools → *Read and drive the built-in browser*。键 `browser_tools.enabled`（`commands/browser_tools.rs`）。在工具调用时重读，关掉会立刻挡住已在跑的会话。
2. **按标签页、按 origin 共享**。出厂 **Default sharing level = `control`（可读可操作）**（`src/lib/browser/browser-prefs.ts` `DEFAULT_BROWSER_PREFS.defaultAgentGrant: "control"`）。工具组一旦打开，新到达的站点会在加载时静默共享。可改为 `read` 或 `none`。

Agent 看不到「打开 Chrome」；它操作的是 **Codeg 工作区里的内置标签**，使用用户自己的 profile（含已登录 cookie）。

### 2.2 与 Agent 的交互方式

Codeg 不把浏览器做成 ACP 客户端能力，而是做成 **codeg-mcp companion 的一组 MCP 工具**：

```
ACP Agent CLI
   │  stdio MCP
   ▼
codeg-mcp  (--features 含 browser[,browser_eval])
   │  UDS + 一次性 token
   ▼
Delegation listener / broker
   │
   ▼
commands::browser::{agent_snapshot_core, agent_act_core, ...}
   │  world-scoped eval / CDP Input.*
   ▼
隔离 world 里的 __codegAgent（Playwright aria tree + act.ts）
```

注入点：`acp/connection.rs` 的 `DelegationInjection.browser`；companion `--features` 解析见 `acp/delegation/companion.rs`。`browser_eval` 不能单独出现：`allows_tool` 要求 `browser && browser_eval`。

工具 schema：`src-tauri/src/acp/delegation/tool_schema.json`。

### 2.3 工具目录与授权矩阵

| 工具 | 需要 | 作用 |
| --- | --- | --- |
| `browser_list_tabs` | 仅工具组 | 列出 tabId、origin、level；未共享时不给 title |
| `browser_open_tab` | 仅工具组 | 在用户面前打开页；**打开 ≠ 共享**（但默认 standing grant 会随后共享） |
| `browser_navigate` | `control`（空白/错误页例外） | 地址栏跳转；跨 origin 会结束旧 grant |
| `browser_close_tab` | `control`（同上例外） | 关标签 |
| `browser_snapshot` | `read` | Playwright `ai` mode 无障碍树 + ref；默认 40_000 字符，可截断 |
| `browser_console_messages` | `read` | 控制台 |
| `browser_screenshot` | `read` | 整页或按 ref 裁切 |
| `browser_click` / `hover` / `type` / `press_key` / `select_option` | `control` | 按 snapshot 的 `generation`+`ref` 操作 |
| `browser_eval` | 工具组 + eval 开关 + `control` + 逐段批准 | 见第 3 节 |

拒绝是 **工具返回值** 而不是传输错误，避免一轮对话被中止。slug 包括 `browser_grant_required`、`browser_control_required`、`browser_stale_ref`、`browser_blocked`、`browser_unavailable` 等（`acp/browser_tools.rs`）。

未共享标签，Agent 只能看到 **origin**（scheme://host[:port]），不能看到 title 或内容。文档 guest 根本不进列表。

### 2.4 页面侧执行引擎

`browser-agent/` 打成 `src-tauri/src/browser/js/agent.bundle.js`：

- 拷贝 Playwright 1.63.0 的 aria tree，以 **`ai` mode** 运行（与 Playwright MCP 相同：可见且接收指针事件的元素都有 ref，包括无 ARIA 角色但 `cursor:pointer` 的 div）。
- 暴露 `globalThis.__codegAgent`：`snapshot` / `elementForRef` / `act` / `locate` / `rectOf`。Rust 通过 **world-scoped eval** 调用，页面脚本碰不到。
- Ref 失效三层：新 document（随机 generation）、地址变化、元素离开。Host 再混入 `epoch`（tab generation + nav epoch），处理 SPA `pushState` 以及隔离 world 看不见的导航。
- 动作默认 **synthetic**：在隔离 world 里 dispatch 事件，并模拟 focus / 表单提交 / 滚动键。**没有独立 scroll 工具**，靠 `PageDown`/`PageUp`/`Home`/`End`。
- Windows 额外走 **trusted** 指针：`locate` 给出视口坐标后，WebView2 CDP `Input.*` 发送真实鼠标事件（`supports_trusted_input` 仅 Windows child surface）。macOS/Linux 无此通道，一直是 synthetic。失败会标明 `fidelity`。
- 被挡住的点击拒绝为 `obscured`；不可见为 `not-visible`（文案要求模型不要重试后者）。

授权决策在 Rust `browser::agent`，**不在 JS bundle 里**。Grant 绑在 tab 状态上：`none | read | control`，绑定单一 origin；离开 origin 即撤销。localhost 还会钉住 listener 的可执行文件路径 + 工作目录（钉进程会在 nodemon 热重载时每分钟打断共享）。

前端 `browser-agent-grant.ts` 记住每个 tab 对每个 origin 的上次决定（含「停止共享」），避免 SSO 跳出再回来洗白授权。记忆不跨重启。

### 2.5 配置项

| 键 / 设置 | 默认 | 作用 |
| --- | --- | --- |
| `browser_tools.enabled`（app_metadata） | `false` | 是否向 Agent 暴露浏览器工具组 |
| `browser_tools.eval_enabled` | `false` | 是否暴露 `browser_eval`（组关时运行时强制为关） |
| `browser:default-agent-grant`（localStorage） | `"control"` | 新站点自动共享级别 |
| Settings → Built-in browser → Site rules | 空 | 按 host 强制 builtin / system / block |
| 管理员 `policy.json` | 启用 | 可整机关掉浏览器 |

### 2.6 安全边界

- 工具组关：Agent 不知道用户开了哪些站。
- Grant 按 tab+origin，不按 URL 路径；不按「Agent 自己打开的」自动放行（打开后 standing grant 才会放行）。
- 每次读/写/拒绝都写在该 tab 的活动条上（成功关闭和 list_tabs 除外）。
- 隔离 world 防止页面伪造 ref 或观察 snapshot。
- Snapshot 后再 check grant（`still_readable` / `still_actionable`），缩短导航窗口。
- 不能操作外部 Chrome/Safari；Release notes 里另有「添加 MCP 时一键填官方 Chrome DevTools 包名」，那是 **第三方 MCP，不是内置浏览器**。

### 2.7 不完整之处

- **Server / Docker / 浏览器会话：工具组根本不广告。** `NoBrowserTabs`；没有原生 webview 句柄。
- Linux 操作可用（独立窗口 + WebKitGTK world），但无 trusted 指针、无文档视图。
- Synthetic 点击无法触发需要用户激活的弹窗，也无法驱动纯 CSS `:hover`。
- `replaceState` 来回同一 URL 时，world 侧仍可能漏检（`browser-agent/README.md` 写明）。
- `agent.rs` 顶部仍有一句过时注释 “Nothing in this build asks for Control yet”；v0.31.0 的动作工具已经要求 `Control`。以工具 schema 与 `agent_act_core` 为准。

---

## 3. Agent 在浏览器中运行代码

### 3.1 这项能力实际是什么

**存在，但是狭义的：在已共享标签的 page world 里执行 Agent 提交的 JavaScript 函数体。**

不是：

- 把 Claude/Codex 等 Agent 本身跑进浏览器（没有 WASM/BrowserPod 运行时）；
- Python / Node 沙箱；
- 在隔离 world 里 eval（故意不这么做）。

证据：`browser/eval.rs` 模块注释、`tool_schema.json` 的 `browser_eval`、官方文档 *Running its own code*、Privacy 页 *An agent's own JavaScript is approved one snippet at a time*。

### 3.2 入口与闸门（六步，顺序就是设计）

`agent_eval_core`（`commands/browser.rs`）写明：

1. `browser_eval` 开关 + 该 tab 的 grant（未共享的 tab **不会弹出确认框**，防止用确认打扰用户）。
2. 在 **codeg 自己的隔离 world** 读真实 URL，对照 grant origin（不信 snippet 返回的地址）。
3. 把完整源码摆到用户面前（`browser://eval-request` → `browser-eval-confirm.tsx`）。
4. 用户回答后再做同样检查（对话框最长 120s）。
5. 在 **page world** 跑代码。
6. 再读一次地址：snippet 可能导航了；结果只在 grant 仍覆盖该 origin 时交给 Agent。

超时：引擎执行 10s；确认 120s；拒绝后该 tab 冷却 15s。同一时刻全应用只有一个确认框；沉默 = 拒绝。**没有任何「始终允许」设置。**

### 3.3 执行模型与「沙箱」边界

- `code` 是函数体，用 `return` 交结果；包进 IIFE，不在页面 globals 留名（`eval_call`）。
- 内联源码而不是 `new Function`/`eval` 字符串，以便在严格 CSP 页面上仍能跑。snippet 可以拆包装器——设计上接受，因为返回值只给 Agent 看，host 不用它做授权。
- **必须跑在 page world**：如果跑在隔离 world，一段已批准代码就能替换 `__codegAgent` / `JSON.stringify`，之后所有 snapshot 都可能撒谎，包括 grant 所用的 URL。
- 上限：代码 4000 字符（按 Unicode 字符，给人读的）；返回值 4000 字符；host 解析上限 256 KiB。
- 异常是 outcome（`kind: exception`），不是工具失败。
- 同步执行；Promise 不会被 await，会以 `kind: promise` 报回来。

这 **不是** 安全沙箱。用户批准后，代码拥有该页面的全部 DOM、cookie、`localStorage` 和同源网络。边界是：**人必须逐段看见源码，且只作用于当前已 `control` 共享的 origin。**

### 3.4 配置

| 项 | 默认 |
| --- | --- |
| `browser_tools.eval_enabled` | 关 |
| 组开关关时运行时 eval | 强制关（库里的 true 不会单独生效） |
| 逐段确认 | 不可关闭 |

### 3.5 不完整 / 明确不做

- Server 模式无此工具。
- 不能自动批准、不能记住批准、不能批量脚本。
- 不能在隔离 world 跑代码，不能当通用 REPL。
- 死循环会卡住页面主线程；host 超时只停止等待，解不了挂死的页面。
- 与「添加 MCP 时的官方 Chrome DevTools server」无关：那是驱动用户本机 Chrome 的外部 MCP 预设（`mcp-settings.tsx`）。

---

## 关键代码路径

### 内置浏览器

- `src-tauri/src/browser/mod.rs` — 模块图、无 IPC 不变量
- `src-tauri/src/browser/surface_child.rs` — macOS/Windows 嵌入 wry child
- `src-tauri/src/browser/surface_window.rs` — Linux / fallback 独立窗口
- `src-tauri/src/browser/shim/{macos,windows,linux}.rs` — 隔离 world
- `src-tauri/src/browser/policy.rs` / `profile.rs` / `doc_guest.rs`
- `src-tauri/src/commands/browser.rs` — `browser_open_tab` 等 UI 命令
- `src/lib/browser/browser-api.ts` / `browser-prefs.ts`
- `src/components/browser/browser-tab-view.tsx` 等 chrome
- `src-tauri/src/web/browser_bridge.rs` — server 端口桥

### Agent 操作

- `src-tauri/src/acp/delegation/tool_schema.json` — MCP 工具定义
- `src-tauri/src/acp/delegation/companion.rs` — feature 门控
- `src-tauri/src/acp/browser_tools.rs` — 结果形状与错误 slug
- `src-tauri/src/acp/delegation/listener.rs` / `transport.rs` — broker 往返
- `src-tauri/src/commands/browser.rs` — `agent_snapshot_core` / `agent_act_core`
- `src-tauri/src/browser/agent.rs` — GrantLevel、listener pin、活动条
- `browser-agent/src/{index,act}.ts` + `vendor/playwright/`
- `src/lib/browser/browser-agent-grant.ts` — 前端 standing grant
- `src-tauri/src/commands/browser_tools.rs` — 两个开关

### 跑 JS

- `src-tauri/src/browser/eval.rs` — 包装、上限、不信任返回地址
- `src-tauri/src/browser/confirm.rs` — 单槽确认 + 冷却
- `src/browser-injected/eval-render.js` — page-world 渲染
- `src/components/browser/browser-eval-confirm.tsx`

---

## 架构与流程

### 桌面进程关系

```
┌──────────────────────────────────────────────────────────┐
│  codeg 桌面（Tauri + React chrome）                        │
│  ┌─────────────┐   bounds/events    ┌─────────────────┐  │
│  │ 工作区 WebView│◄──────────────────►│ wry child/window │  │
│  │ (App UI)     │                    │ WK / WV2 / GTK   │  │
│  └──────┬───────┘                    │ 隔离 world:      │  │
│         │ IPC browser_*              │  __codegAgent    │  │
│         ▼                            │ page world: eval │  │
│  Rust browser::registry / shim       └────────▲────────┘  │
└─────────┬─────────────────────────────────────┘           │
          │ ACP stdio                                       │
          ▼                                                 │
   Agent CLI（Claude/Codex/…）                               │
          │ MCP stdio                                       │
          ▼                                                 │
   codeg-mcp companion ──UDS──► broker ──► agent_*_core     │
└──────────────────────────────────────────────────────────┘
```

### Agent 点一次按钮

```
browser_click{tabId, generation, ref}
  → codeg-mcp 鉴权 token
  → listener 转 BrokerBrowserActRequest
  → agent_act_core
       1. revoke_if_listener_replaced
       2. still_actionable（read? control? epoch 新鲜?）
       3. Windows: locate + CDP Input.*（trusted）
          其它: eval_in_world(__codegAgent.act(...))（synthetic）
       4. 活动条记一行
  → 返回 BrowserActOutcome（done | grant_required | stale_ref | …）
```

### browser_eval

```
browser_eval{tabId, code}
  → 开关? grant=control? 代码 ≤4000?
  → 隔离 world 读 URL，对照 origin
  → 弹出确认（120s / 单槽 / 拒绝冷却 15s）
  → 再检查 grant
  → page world IIFE 执行（10s）
  → 再读 URL；仍覆盖才把 value 交给 Agent
```

---

## 结论

1. **内置浏览器是 v0.31.0 的完整桌面能力**，内核是 **各平台系统 WebView + wry 子视图**，不是 CEF、不是无头 Chromium、也不是驱动用户已打开的 Chrome。Linux 和 `codeg-server` 是有意降级：前者独立窗口，后者只桥 loopback HTTP 到 iframe。
2. **Agent 操作浏览器已落地**，路径是 **ACP Agent → codeg-mcp MCP 工具 → Rust grant 检查 → 隔离 world 里的 Playwright aria/act**。默认工具组关闭，但默认共享级别是 *Read and act*，所以真正的总闸是工具组。Windows 点击可走 CDP 真指针，其它平台是 JS 合成事件。
3. **「在浏览器中运行代码」已落地，但只到「经人工批准、在当前页面 world 跑一段 JS」。** 不是浏览器内代码沙箱，也不是把 Agent 放进浏览器。隔离 world 被明确禁止用于这段 eval，以免污染 snapshot 可信根。
4. 若要对齐 Codeg 这三项，需要同时有：**原生（或等价）浏览器表面、按 origin 的共享模型、以及一条 Agent 工具通道（MCP 或 ACP）**。只做 iframe 预览或只接 Chrome DevTools MCP，都对不齐 v0.31.0 的桌面行为。

### 证据索引

- Release：<https://github.com/xintaofei/codeg/releases/tag/v0.31.0>
- PR：<https://github.com/xintaofei/codeg/pull/723>
- 文档：<https://docs.codeg.app/guide/browser>、<https://docs.codeg.app/reference/privacy>
- 源码快照：本地 `/tmp/codeg-research/codeg` @ `aace536`
