---
name: vibex-browser
description: Drive VibeX's built-in Browser plugin and its MCP (vibex-browser-browser-tools). Use when the user wants to open, list, read, click, hover, type, press keys, select options, inspect console messages, screenshot, or close in-app browser tabs (GitHub, Baidu, docs, web apps)—not the system browser.
---

# VibeX Browser

Use this Skill whenever the user wants to look at or operate a **web page inside VibeX**, not an external browser.

The tools live on the MCP server **`vibex-browser-browser-tools`**. They appear only after the Browser plugin is enabled **and** the current Agent session was opened or rebound after that. If the tools are missing, tell the user to enable **设置 → 浏览器 → 智能体工具**, then start a **new** session. Do not invent a fallback that opens the OS browser.

## What this plugin is

VibeX Browser is a dock tab next to the editor. Each dock tab is one page (`tabId`). Cookies stay in the app profile. The user can also open tabs from the right rail or the `+` menu, and configure all browser behavior under **设置 → 浏览器**.

You do **not** control the address bar UI. You call MCP tools. New tabs you open with `browser_open_tab` show up in the workspace dock.

## Default share (grant)

New tabs default to **control** (可读可操作): you may list, snapshot, read console, screenshot, click, hover, type, press keys, select options, and run JavaScript.

Grant is a standing setting on that tab. Same-site loads and cross-site navigations keep it. It becomes empty only when:

1. Browser setting **默认共享级别** is `none`, or
2. The user picked **停止共享** on the tab chrome.

Levels:

| UI | `grant.level` | You may |
| --- | --- | --- |
| 停止共享 / empty | missing / `none` | `browser_list_tabs` only (title, URL, tabId) |
| 可读 | `read` | `browser_snapshot`, `browser_console_messages`, `browser_screenshot` |
| 可读可操作 | `control` | all read tools + `browser_click`, `browser_hover`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_eval` (if enabled) |

If a tool returns `browser_grant_required`, tell the user to share that tab from the address-bar chip. If it returns `browser_control_required`, they shared read-only; ask them to switch to 可读可操作.

Do not tell the user to paste cookies, passwords, or DevTools protocol endpoints.

## Tools

Call these by name. Do not rename them. Do not call Host `browser.dispatch` yourself.
Note: `tabId` is optional on read/act tools when only **one** built-in browser tab is open. When multiple tabs are open, pass `tabId` explicitly.

### `browser_list_tabs`

No arguments. Returns every built-in tab: `tabId`, `url`, `title`, `loading`, `origin`, `grant`, `profileId`.

Always list first when the user says “current page”, “this tab”, or “all tabs”, unless they just gave you a `tabId` in this turn.

### `browser_open_tab`

Arguments: `{ "url": "https://...", "profileId"?: "default", "waitForLoad"?: true }` (http or https only).

Opens a **new** dock tab, waits for initial page load to settle, and returns the tab object including `tabId` and `grant`.

### `browser_navigate`

Arguments: `{ "tabId"?, "url": "https://...", "waitForLoad"?: true }`.

Points an **existing** tab at a new address and waits for load to settle. Prefer this over opening another tab when they say “go to”, “open in this tab”, or “navigate”.

### `browser_close_tab`

Arguments: `{ "tabId" }`. Closes that dock tab. Confirm if they did not clearly ask to close it.

### `browser_snapshot`

Arguments: `{ "tabId"?, "maxChars"? }`.

Reads the page as an ARIA tree. Returns `generation`, `url`, `title`, `viewport`, `snapshot`, `refsCount`, `truncated`.

- Refs look like `e1`, `e2`. They are valid **only until the next snapshot** on that tab (or a navigation).
- `generation` (4-part token `<incarnation>.<navEpoch>.<snapSeq>.<nonce>`) is required for subsequent actions (`click`, `hover`, `type`, `press_key`, `select_option`) and ref-cropped `screenshot`. Copy it exactly; do not invent one.
- Requires at least **read** grant.

### `browser_console_messages`

Arguments: `{ "tabId"?, "since"?: 0, "minLevel"?: "debug" | "log" | "info" | "warn" | "error", "limit"?: 100 }`.

Reads console messages (`console.log/info/warn/error/debug`), uncaught `error` events, and `unhandledrejection` events recorded on the tab since the last navigation. Pass `nextSeq` from the previous response as `since` to tail only newer messages. Requires at least **read** grant.

### `browser_screenshot`

Arguments: `{ "tabId"?, "generation"?, "ref"?, "maxWidth"?: 1280, "format"?: "png" | "jpeg" }`.

Captures the visible viewport of a shared tab, or scrolls `ref` into view and crops to its bounding box when both `generation` and `ref` are provided. Returns an image block alongside dimensions. Requires at least **read** grant.

### `browser_click`

Arguments: `{ "tabId"?, "ref", "generation" }`.

Scrolls the element into view and clicks the ref from the **latest** snapshot. Requires **control** grant. After a click that changes the page, snapshot again before the next action.

### `browser_hover`

Arguments: `{ "tabId"?, "ref", "generation" }`.

Scrolls the element into view and dispatches pointer/mouse hover events on the ref. Useful for opening hover menus or tooltips before taking a new snapshot. Requires **control** grant.

### `browser_type`

Arguments: `{ "tabId"?, "ref", "generation", "text", "submit"?: false }`.

Types into the snapshot ref (inputs, textareas, contenteditable). Set `"submit": true` to press Enter / submit the form immediately after typing. Requires **control** grant.

### `browser_press_key`

Arguments: `{ "tabId"?, "generation", "key", "ref"? }`.

Sends a keyboard key (`Enter`, `Escape`, `Tab`, `ArrowDown`, etc.) to `ref` (if provided) or the currently focused element. Requires **control** grant.

### `browser_select_option`

Arguments: `{ "tabId"?, "ref", "generation", "value" }`.

Selects an `<option>` by value or visible label on a `<select>` snapshot ref. Requires **control** grant.

### `browser_eval`

Arguments: `{ "tabId"?, "code" }`.

Runs JavaScript in the page. Depending on the user's **设置 → 浏览器 → JavaScript 执行审批** setting (`ask` vs `silent`), the Host either prompts the user to approve the snippet or runs it directly on control-shared tabs. Use only when structured tools (`snapshot`, `click`, `type`, `select_option`) cannot do the job.

## Playbooks

### Read the current page

1. `browser_list_tabs`
2. Choose `tabId`
3. If `grant` is empty, stop and ask them to share the tab
4. `browser_snapshot`
5. Answer from the tree; quote visible text, do not fabricate unseen content

### Open a site and summarize

1. `browser_open_tab` with the full https URL (automatically waits for initial load)
2. `browser_snapshot`
3. Summarize

### Search on a site (example)

User: open GitHub and search `vibex`

1. `browser_open_tab` `{ "url": "https://github.com" }`
2. `browser_snapshot`, find the search input ref
3. `browser_type` with `{ "ref": "e...", "generation": "...", "text": "vibex", "submit": true }`
4. `browser_snapshot` results and report

## Errors

| Signal | What you do |
| --- | --- |
| Tools absent / handshake failed | Plugin off, **智能体工具** off, or session too old. Enable plugin + tools in **设置 → 浏览器**, **new session**. |
| `browser_tools_disabled` | Turn on 智能体工具 in **设置 → 浏览器**. |
| `browser_grant_required` | Ask them to share the tab (chip next to the URL). |
| `browser_control_required` | Ask them to switch the chip to 可读可操作. |
| `browser_no_such_tab` | List tabs again; the tab was closed. |
| `browser_bad_address` / `browser_blocked_by_policy` | Only http(s) allowed and must not match a Block rule in **设置 → 浏览器 → 站点规则**. |
| `browser_eval_disabled` | Enable 运行页面 JavaScript in **设置 → 浏览器**. |
| `browser_stale_ref` / stale generation | Snapshot again, then retry the action with the new generation and ref. |
| Action returned `ok: false` | Snapshot; the control may be disabled, hidden, or inside a closed menu. Do not loop the same ref. |

## Config the user can change

**设置 → 浏览器** (dedicated full-width settings page):

- **基础设置 / 链接默认打开方式** (`defaultTarget`): one choice for every workspace link, 内置浏览器 or 默认浏览器. There is no per-source or ask-every-time policy.
- **站点规则** (`hostRules`): host/port pattern rules (`builtin`, `system`, `block`) that override the default opener.
- **智能体浏览器工具** (`toolsEnabled`, `defaultGrant`, `evalEnabled`, `evalApproval`).
- **运行环境** (`devtools`, `suspendBackgroundTabs`, `signInUserAgent`).
- **浏览器配置文件** (`profiles`, `newTabProfile`): isolated cookie/storage profiles.
