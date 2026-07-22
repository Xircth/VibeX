# Web Preview 采用独立 CEF Browser Runtime

决定于 2026-07-22。

## 背景

当前 Web Preview 把页面放进 Tauri 主 WebView 内的 `iframe`，并让
localhost 流量经过一个 Rust HTTP 代理。代理需要缓冲 HTML、移除部分响应头、
注入检查脚本，并通过 `postMessage` 回传有限的 console、network 与元素信息。

这条链路不是完整浏览器上下文：身份认证、浏览器存储、WebSocket/HMR、弹窗、
导航历史、DevTools 与页面进程隔离都受到 iframe 或代理实现限制。继续扩展代理只会
把 Chromium 已经解决的问题重新实现一遍。

VibeX 必须继续使用 Tauri、Rust 和 React，同时在 Windows、macOS 与 Linux 提供
一致的 Chromium 能力。因此系统 WebView 也不满足目标：Tauri 在不同平台使用
WebView2、WKWebView 与 WebKitGTK，行为和调试接口并不一致。

## 决定

Web Preview 改为独立的 **Browser Runtime**，以
[`tauri-apps/cef-rs`](https://github.com/tauri-apps/cef-rs) 作为 CEF Rust
绑定，以 Chromium Embedded Framework 作为唯一页面运行引擎。

- React 只渲染浏览器 chrome：地址栏、tab、工具栏、状态与 Inspector pane。
- `crates/browser-runtime` 拥有 profile、tab、导航、权限、下载与 DevTools/CDP
  的领域行为。
- `src-tauri` 的 Browser Host adapter 负责 CEF 生命周期、Tauri 原生窗口句柄、
  child view 布局、焦点、消息泵与 IPC 事件。
- CEF 使用 windowed child view 直接渲染页面；不通过 iframe、HTTP 反向代理或
  页面脚本注入。
- Browser Runtime 不可用时显示明确的初始化错误。旧 Web Preview 不作为
  fallback，也不保留运行时开关。
- Global、Workspace 与 Ephemeral profile 分别映射到独立 CEF request context。
- Console、Network、元素选择、截图与自动化通过 CEF DevTools observer/CDP
  实现，不修改被预览页面。

移动端不在本决定范围内。桌面发行物接受 CEF 带来的体积增长，并承担固定节奏的
CEF/Chromium 安全升级。

## 外部依赖选择

### 采用：tauri-apps/cef-rs

- Rust 100%，与现有 Cargo workspace 相符。
- Tauri 官方组织维护。
- 支持 Windows、macOS、Linux 的 x86_64 与 ARM64。
- 暴露 request context、browser host、DevTools observer、windowed 与 off-screen
  rendering 能力。
- 提供 CEF 下载与跨平台 bundle 工具，避免自行生成原始 CEF 绑定。

### 否决：WEW

WEW 与技术栈相符，但当前仍为 `0.1.0`，并明确要求调用方手工完成大量 CEF
runtime 打包工作。它在 `cef-rs` 上增加了另一个仍不稳定的抽象层，却没有提供
Tauri adapter，不能减少本项目最关键的集成风险。

### 否决：cef-ui 与直接 CEF C/C++ 接入

`cef-ui` 目标 Chromium 版本过旧且维护停滞。直接使用 CEF C/C++ 会重复
`cef-rs` 已经提供的绑定、引用计数和 bundle 工具，增加本项目维护面。

## Browser Runtime Interface

调用方只跨越下面的 interface；CEF 类型、原生窗口类型、线程与 profile 路径均不得
泄露到 interface 中。

```rust
pub trait BrowserRuntime {
    fn create_tab(&self, request: CreateTab) -> Result<BrowserTab, BrowserError>;
    fn apply(&self, tab_id: TabId, intent: BrowserIntent) -> Result<(), BrowserError>;
    fn set_surface(&self, tab_id: TabId, surface: BrowserSurface)
        -> Result<(), BrowserError>;
    fn close_tab(&self, tab_id: TabId) -> Result<(), BrowserError>;
    fn subscribe(&self) -> BrowserEventStream;
}
```

`BrowserIntent` 只表达用户意图：navigate、back、forward、reload、stop、focus、
zoom、find、open-devtools、inspect-element。事件流是 tab 状态的唯一前端事实来源。

## Consequences

1. 必须把 CEF external message pump 正确接入 Tauri event loop。
2. 必须在三个桌面平台把 CEF framework、resources 与 helper subprocess 纳入
   Tauri bundle、签名和更新流程。
3. CEF native child view 之上的 React DOM overlay 不可靠；Browser UI 和
   Inspector 使用预留布局，不覆盖页面 surface。
4. 旧 `preview_proxy`、iframe bridge、页面注入 bundle 与 companion 安装路径在
   CEF 路径达到验收标准后直接删除。
5. CEF 初始化、进程退出或资源缺失必须是可诊断错误，不能静默切换旧实现。

