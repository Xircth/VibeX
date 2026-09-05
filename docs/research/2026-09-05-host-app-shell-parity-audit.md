# Host+APP 壳 vs 纯桌面：完整能力面检查

日期：2026-09-05  
范围：当前工作区树（含另一 Agent 未提交的 Host 填补）。本检查**不改生产代码**。  
对照：ADR-0078 / 0033 / 0054 / 0007；完成标准是 **Host+APP 壳使用上与拆分前纯桌面一致**，不以远程 P0 子集、Companion 或 IM 为借口。

证据目录（本机 scratch，不入库）：`host-command-inventory.txt`、`listen-subscribe-inventory.txt`、`surface-matrix.md`、`known-issues.md`、`contract-tests.log`、`git-status.txt`、`desktop-launch.txt`。

覆盖表与 scratch `surface-matrix.md` 同行同状态。

---

## 1. 结论（先讲清楚）

拆分后桌面前端对 `HOST_COMMANDS` 一律走 `application_call` → Host（`TauriTransport.call`）。这不是“远程才走 Host”： **本机日常使用已经离开原来的 Tauri command 实现。** 只要 Host 参数对不齐、实现变薄、或序列化字段改名，本机就会比拆分前更差。

当前不是“注册表缺几个名字”的问题，而是三类同时存在：

1. **路由已切、实现未齐** — 命令在 `HOST_COMMANDS` 里，本机不再打到 Tauri 副本，Host 解析失败或行为残缺。这是用户能立刻碰到的回归。
2. **从未迁入 Host** — 前端仍调用，但不在 `HOST_COMMANDS` / `DESKTOP_SHELL_COMMANDS`。本机靠残留 `invoke_handler` 还能用；Web/Workstation 直接 `command is not registered`。
3. **壳能力自己坏了** — CEF WebPreview 在本机输入网址回车后空白。这不是允许的远程省略。

图中缺口面：**本轮未能回收原图**。用户消息与工作区没有可打开的缺口截图。下面用三个点名缺陷 + 当前未提交改动（另一 Agent 正在修的面）作为图的替代种子，**没有因此缩小覆盖**。

契约测试 `hostCommandContract.test.ts` **当前失败**（4 个前端字面量不在 HOST/SHELL）。通过也不能当完成门：它不检查参数、事件、UI。

---

## 2. 三个点名缺陷（当前树重读）

另一 Agent 在本检查进行期间继续改 Host。下面以**当前工作区**为准：打开路径序列化与创建会话 payload **已修复**；WebPreview 空白仍 OPEN。证据：`cargo test -p server --lib conversation_detail_uses_open_path_snake_case_keys` 与 `create_project_session_payload_accepts_*` 通过（scratch `named-defect-retrace.log`）。

### 2.1 WebPreview 输入网址回车后空白 — OPEN

| 项 | 当前路径 |
|---|---|
| APP | `DockviewWebPreviewPanel` → `BrowserPanel.navigate()`（`frontend/src/features/browser/BrowserPanel.tsx`）。空启动器不建 tab；回车 `setTabBootstrapUrl` → `browser_create_tab`，再 `browser_apply_intent` `setSurface` / `navigate`。监听 `browser://event`。 |
| 壳 | `DESKTOP_SHELL_COMMANDS`：`browser_create_tab` / `apply_intent` / `close_tab` / `get_tab`。Tauri `src-tauri/src/commands/browser.rs`。不在 Host 注册表。 |
| 参数 | `{ request }` / `{ tabId, intent }` camelCase。**不是** `tabId` vs `tab_id` 对不齐。 |
| UI | 提交非空 URL 立即关掉空白启动层。CEF 子视图若未显示，用户只看到底色，没有 ADR-0007 要求的引擎错误。 |

本机根因：CEF 惰性启动。`create_tab` 在 Chromium initialize 前就 Ack。消息泵失败时丢掉 session，不换成 `unavailable_runtime`，也不把错误回给 JS。创建时 `surface.visible: false`，随后 `setSurface` 可能再次提交隐藏。

Web/Workstation：界面仍提供 WebPreview，Host 返回未注册。`preview.proxy` 只服务 Artifact/插件租约，不是页面预览。

`browser_create` / `browser_navigate` / `browser_close` 在 SHELL 清单里但无实现、无调用者 — 不是这条回车路径。

**不能标 APP-shell-intentional。** 壳能力必须在本机可用。

### 2.2 会话输入框 `session-settings-summary` — 打开路径 **already-fixed**；无头 live batch 仍缺 controls

UI **仍挂着**：`TaskFollowUpSection` → `ActionBar` → `SessionSettingsSummary`。无 mode/option 时组件 `return null`。

**打开路径序列化（原先标 OPEN 的 camelCase vs snake_case）当前已修好。** `HostConversationDetail` **没有** `rename_all = "camelCase"`（`crates/server/src/host/conversation.rs:24-45`）。字段名是 `session_modes` / `session_config_options` / `active_binding`，与 `shared/types.ts` 和 `conversationStore.ts` 一致。

证明：`host::conversation::tests::conversation_detail_uses_open_path_snake_case_keys` 断言 JSON 有 `session_modes` / `session_config_options` / `active_binding`，且没有 `sessionModes` / `sessionConfigOptions` / `activeBinding`。

本机实时批次：`src-tauri/src/events.rs` 仍把 modes/options 拷进 `ConversationRowOpBatch`，打开后的 live 更新在本机这条路径上仍可用。

**仍 OPEN、单独成项：** 无头 `HostRowOpPublisher`（`crates/server/src/host/row_ops.rs:61-68`）仍恒发 `session_modes: None`、`session_config_options: None`、`available_commands: None`。这影响 Server/远程 live 控制面，**不是**打开会话 detail 水合。不要把它和已修好的打开路径混成一个「summary 仍坏」。

`conversation_set_session_mode` / `set_session_config_option` 前端仍包 `{ request }`、Application Core 仍要扁平字段 — 改选项可能失败并被 `console.warn` 吃掉。那是另一条参数缺口（计划 B1.6），不是 detail 序列化。

### 2.3 创建会话 `create_project_session` — **already-fixed**

产品创建走 `sessionsApi.createProject` → `create_project_session`。当前 APP payload 已是 camelCase，含 `createWorkspace` 与 `repos`（`frontend/src/lib/api/sessions.ts:63-79`）。

Host `CreateProjectSessionPayload`（`host_ops/mod.rs:1852-1872`）：`rename_all = "camelCase"`，并对 `project_id` / `create_workspace` / `repo_id` 等保留 snake_case alias。实现会在 `create_workspace` 时走 `create_worktree_workspace_for_project_session`，并 claim prepared ACP session（`host_ops/mod.rs:840-909`），与 Tauri `sessions.rs` 产品语义对齐。

证明：

- `create_project_session_payload_accepts_host_camel_case`
- `create_project_session_payload_accepts_legacy_snake_case`

**相对 Tauri 的残留（不是创建失败）：** 同名 command 仍同时在 `invoke_handler` 里（双路径残渣，Batch 5）。创建成功后 `initializeSessionControls` 的 set mode/option `{ request }` 包装仍可能失败（B1.6），会话本身已经能建出来。

---

## 3. 架构：ADR-0078 只接上了一半

| ADR-0078 要求 | 当前 |
|---|---|
| `crates/server::host` + `host_commands!` + `HostContext` | **没有这些名字。** 活缝是 `DomainCommand` + `RegisteredCommand` + 生成的 `HOST_COMMANDS` |
| 桌面 `application_call` 挂同一份实现 | 有。每调用 **新建** `host_application_core`：共享 `AgentRuntime`，`PreviewProxyRegistry::default()`（用完即丢），`owns_automation_engine: false` |
| 迁走的 Tauri command 从 `invoke_handler` 删除 | **未做。** 414 个 HOST 名仍在 `invoke_handler`（死副本，但继续漂移） |
| 推送只走 Host Event Bus | 总线存在；本机有 `start_host_event_forwarding`（另一 Agent **已接**）。无头 `agent-events` / `agent-terminal-events` 仍不发 |
| `usePatchStream` + 订阅资源 `patch_stream`，删 9 个 `subscribe_*` | **前端未做。** 仍是 `useTauriPatchStream`。WS 侧 `patch_stream` **已有** |
| `WebTransport.listen` 不只 `terminal-output:*` | **已修**（走 `host_event`） |
| capabilities 由注册表派生 | 仍是硬编码列表 + `DomainCommand::capability_scopes()` |
| 选目录 = Host 目录；时间线图不用 `convertFileSrc` | 本机选目录仍是原生对话框（本机可用）。本机时间线图仍 `convertFileSrc` |

`RemoteDesktopTransport.listen/subscribe` 仍在 WebView 里用 token 开 WebSocket，凭据回到前端 — ADR 要求 Rust 侧持有。

---

## 4. 另一 Agent 未提交改动：诚实的「已修复」

`git diff --stat` 约 +3180/-1387，集中在 `crates/server/src/host/**`、`host_ops`、usage、slash commands、hostAsset、事件转发。这些是**当前树事实**，不是假设。

**已修复（APP 能打到 Host/壳，参数对齐，UI 仍接线）：**

- 文件树 walk / 子目录 / 文本搜索：`host_ops/file_listing.rs`、`file_search.rs`
- `get_project_usage_statistics`、`agent_plan_usage`（含 payload 包装）
- slash 命令流频道名与 Host 生产者对齐
- `read_binary_asset` 同时给 `data_base64` 与 `base64`；Web `hostFileSrc` 能吃
- Host Event Bus → Tauri `start_host_event_forwarding`
- 本机 conversation row-ops / agent-events / attention 改经总线再转发
- `WebTransport.listen` → `host_event`
- WS `host_event` + `patch_stream`（仅服务端）
- `agent_capability_catalog` / `_fresh` / `refresh`（`{ agentId }`）
- `agent_session_defaults` GET；SET 用 `parse_payload`
- Agent 环境读写、workflow 源读写、chat/config/images/ops/system catalog 填补
- **`conversation_detail` 打开路径 snake_case**（`conversation_detail_uses_open_path_snake_case_keys`）
- **`create_project_session` camelCase + alias + worktree + prepared session**（`create_project_session_payload_accepts_*`）

**仍 OPEN（同批改动没有真正关掉）：** WebPreview 空白；无头 `HostRowOpPublisher` 丢掉 session controls；`conversation_events_since` `{ request }`；set mode/option `{ request }`；绝大多数 agent 运行时 `{ request }`；git `branchName` 等参数残缺；conversation extras；冲突/PR/脚本；前端 patch 流；本机 `convertFileSrc`；local-history Host 桩；agent management 瘦实现。

---

## 5. 清单规模

| 集合 | 数量 |
|---|---|
| `HOST_COMMANDS` | 460 |
| `DESKTOP_SHELL_COMMANDS` | 76 |
| `invoke_handler` | 507 |
| `DomainCommand` | 421 |
| 前端产品调用（含 `call(` / `invokeAsResult` / `callApplicationCommand`） | 533 |
| 其中 HOST | 446 |
| 其中 SHELL | 67 |
| **invoke-only 且前端仍调用** | **20** |
| HOST ∩ invoke_handler（双路径残渣） | 414 |
| `invoke_handler` 不在 HOST 也不在 SHELL | 28 |

契约扫描器只抓 `backendCall` / `tauriInvoke` / `.call(`，**漏掉** `call('…')`、`invokeAsResult`、`callApplicationCommand`。当前失败的 4 个：

`continue_conflicts_workspace`、`get_workspace_conflict_file`、`write_workspace_conflict_resolution`、`plugin_renew_file_preview`

另外 16 个 invoke-only 前端调用被同一扫描器漏掉，包括 conversation 导出/分叉/搜索/rebind/truncate/timeline_page 以及 PR/脚本。

---

## 6. 覆盖表

状态枚举与计划验收标准一致。Args = APP 参数是否对上 Host 解析。

### 6.1 Project / Repo / Workspace / Git / PR / Worktree

| Surface | Status | Evidence | Args |
|---|---|---|---|
| Project CRUD + 仓库增删列 | Host-parity | `frontend/src/lib/api/projects.ts`；`crates/server/src/host_ops/mod.rs` | Y |
| `search_project_files` | Host-parity | 同上 | Y |
| `get_project_repository` | missing | `src-tauri` leftover；无 FE 调用 | n/a |
| Repo CRUD/clone/init/status/stage/commit/log/remotes | Host-parity | `repos.ts`；`host_ops` + `host/product.rs` | Y |
| checkout/create/delete **repo** branch | param-misaligned | FE `branchName`；Host `branch` | N |
| `search_repo` | partial | FE `mode` 被丢掉 | N |
| `list_open_prs` / `list_repo_issues` | Host-parity | `invokeAsResult` | Y |
| Workspace 列表/git 状态/暂存/提交/日志 | Host-parity | `attempts.ts`；`host_ops` | Y |
| `create_workspace` | param-misaligned | FE `{ payload }`；Host 扁平 camelCase | N |
| `update_workspace` | param-misaligned | FE `{ workspaceId, payload }`；Host 扁平 | N |
| `delete_workspace` | partial | `deleteBranches` 忽略；不拦在跑进程 | N |
| `get_workspace_branch_status` | partial | FE 要数组；Host 单仓库 | N |
| `get_workspace_commit_graph` | partial | `maxCommits` 忽略，写死 100 | N |
| `get_workspace_commit_diffs` | param-misaligned | `sha` 丢掉，变成工作区 diff | N |
| checkout/create/delete **workspace** branch | param-misaligned | FE `branchName`；Host `branch` | N |
| `rename_workspace_branch` | param-misaligned | FE `newBranchName`；Host `new_name` 且 `create_branch` | N |
| `change_workspace_target_branch` | param-misaligned | FE `newTargetBranch` | N |
| `push_workspace_branch` | partial | `force` 忽略 | N |
| `rebase_workspace` | partial | 变基基线忽略；返回 Null | N |
| `stash_workspace` | partial | message / includeUntracked 忽略 | N |
| `show_workspace_stash` | missing | leftover；无 FE | n/a |
| 冲突 continue / 读文件 / 写回 | missing | `attempts.ts`；不在 HOST | n/a |
| `continue_rebase_workspace` | missing | HOST 名前端不用；前端 continue rebase 打 `continue_conflicts_workspace` | N |
| 创建/附加/从 PR 建工作区 | missing | FE 仍调用 create/from_pr | n/a |
| `get_workspace_pr_comments` | Host-parity | `host/catalog/ops.rs` | Y |
| setup/cleanup/archive 脚本 | missing | `attempts.ts` | n/a |
| `gh_cli_setup` | Host-parity | catalog | Y |
| Worktree 设置 / cleanup status | Host-parity | `config.ts`；`product.rs` | Y |

### 6.2 Session

| Surface | Status | Evidence | Args |
|---|---|---|---|
| list/get/summaries | Host-parity | `sessions.ts`；`host_ops` | Y |
| `create_session` | partial | 仅 DB insert | Y |
| `create_project_root_session` | partial | 无 prepared ACP | Y |
| `create_project_session` | already-fixed | `sessions.ts` camelCase payload；Host alias + worktree + prepared claim | Y |
| rename/pin/status/viewed | Host-parity | `sessions.ts` | Y |
| delete | partial | 不清理 process/scratch/FTS | Y |
| `reset_session_process` | Host-parity | `catalog/ops.rs` | Y |

### 6.3 Conversation / composer

| Surface | Status | Evidence | Args |
|---|---|---|---|
| list/create/output/catalog（Application Core） | Host-parity | `conversationApi` + `crates/application/src/command.rs` | Y |
| `conversation_detail` | already-fixed | 无 `rename_all`；snake_case 与 store 对齐 | Y |
| `conversation_events_since` | param-misaligned | FE `{ request }`；Host 扁平 | N |
| `conversation_ensure_session_controls` | Host-parity | `{ conversationId }`；仅零回合打开 | Y |
| timeline_page / rebind / truncate / checkpoint preview / close / export* / search / import / fork | missing | 前端有调用；invoke-only | n/a |
| start turn / steer / inputs / cancel | Host-parity | Core 嵌套 `request` | Y |
| set mode / set config option | param-misaligned | FE `{ request }`；Core 扁平 | N |
| session-settings-summary（打开路径） | already-fixed | UI 在；detail snake_case 水合 | Y |
| 无头 row-op session controls | event/listen-broken | `host/row_ops.rs` 恒 `None` | n/a |
| drafts（scratch） | Host-parity | `scratchApi` | Y |
| permission / question 答复 | Host-parity | Core | Y |

### 6.4 Agent runtime / management / providers

| Surface | Status | Evidence | Args |
|---|---|---|---|
| capability catalog / fresh / refresh | already-fixed | `{ agentId }` | Y |
| session defaults GET/SET | already-fixed | SET 已 `parse_payload` | Y |
| connect/prepare/new/resume/send/cancel/disconnect/permission 及一串 `{ request }` 运行时命令 | param-misaligned | Host `parse(args)` 扁平 | N |
| `agent_runtime_snapshot` | Host-parity | 共享 AppState runtime | Y |
| `agent_scan_local_history` | missing | Channel；不在 HOST | n/a |
| local-history batch/snapshot/import | partial | Host 桩，本机 UI 已走 Host | N |
| management bar/detail/refresh | partial | Host 瘦列表 | mixed |
| set_enabled / rollback / config-file-write | partial | Null / 不 rollback / 打错命令 | N |
| install/repair/update | partial | 无人值守安装，非完整安装器 | mixed |
| environment r/w | already-fixed | `host/management.rs` | Y |
| Codex/OpenCode/DSH/Grok/Pi / catalogs | Host-parity | `host/native*` `parse_request` | Y |
| Skills / MCP / instructions | Host-parity | `host/catalog/*` | Y |

### 6.5 Files / Diff / Terminal / Preview

| Surface | Status | Evidence | Args |
|---|---|---|---|
| file tree / children / text search | already-fixed | `file_listing.rs` / `file_search.rs` | Y |
| read/save/delete/copy/move/mkdir/truncated | Host-parity | `host_ops` | Y |
| `get_file_at_head` | partial | 嵌套路径错误 | N |
| `trash_item` | APP-shell-intentional | SHELL；本机可用 | n/a |
| `list_directory` / `list_git_repos` | Host-parity | FolderPicker | Y |
| 文件树实时流 | event/listen-broken | 仍 `subscribe_*` | Y |
| workspace/repo file diffs | Host-parity | `host_ops` | Y |
| live diff stream | event/listen-broken | `useTauriPatchStream` | Y |
| 用户 PTY CRUD | Host-parity | `host_ops` | Y |
| PTY 输出 | APP-shell-intentional | 本机 Tauri 事件；Web SSE | n/a |
| `open_external_terminal` | APP-shell-intentional | 本机可用 | n/a |
| Agent 长期终端列表 | Host-parity | `product.rs` | Y |
| Agent terminal snapshot | param-misaligned | `{ request }` | N |
| Agent terminal 生命周期事件 | partial | 本机有；Server 无生产者 | n/a |
| WebPreview/CEF | partial | 点名缺陷 1 | Y |
| 过期 `browser_create/navigate/close` 名 | missing | 无实现 | n/a |
| `preview.proxy` | partial | 每调用空 registry | n/a |

### 6.6 Plugin / Chat / Automation / Workflow / Settings

| Surface | Status | Evidence | Args |
|---|---|---|---|
| Plugin 控制面主路径 | Host-parity | `domains.rs` + `surface.rs` | Y |
| `plugin_renew_file_preview` | missing | Domain 有、HOST 清单无；契约测试失败 | Y |
| `plugin_control_import_cli` | APP-shell-intentional | 要 `stream()` | n/a |
| plugin_dev_* | APP-shell-intentional | 壳 | n/a |
| Chat channel 全套 | Host-parity | `catalog/chat.rs` | Y |
| 通知音 / 编辑器探测 | partial | 在 Host 机器上播/查 | Y |
| Automation 命令集 | Host-parity | `domains.rs` | Y |
| `automation_engine_status` | partial | 桌面 `application_call` 永远 `active: false` | Y |
| Workflow Application Core | Host-parity | `RegisteredCommand` | Y |
| workflow source r/w | already-fixed | `product.rs` | Y |
| workflow debug workspace | Host-parity | `surface.rs` | Y |
| workflow_run 订阅 | Host-parity | WS | Y |
| 设置/日志/偏好/崩溃报告 | Host-parity | catalog | Y |
| 窗/托盘/Toast/更新器/备份/隧道/Inspector/本机控制台 | APP-shell-intentional | SHELL；须本机可用 | n/a |

### 6.7 Scratch / Image / Attention / Tags / Tasks / Usage / FS / Events

| Surface | Status | Evidence | Args |
|---|---|---|---|
| Scratch CRUD | Host-parity | `product.rs` | Y |
| Scratch 流 | event/listen-broken | `useTauriPatchStream` | Y |
| Images | Host-parity | `catalog/images.rs` | Y |
| Attention inbox | Host-parity | `product.rs` | Y |
| Tags | param-misaligned | FE payload/tagId；Host 扁平、忽略 search | N |
| get/update/delete task | param-misaligned | FE `taskId`；Host `id` | N |
| `create_task` | Host-parity | `parse_payload_or_value` | Y |
| `create_task_and_start` | partial | 只创建不启动 | Y |
| `get_tasks` | missing | leftover；无 FE | n/a |
| 用量统计 / plan usage | already-fixed | catalog/ops + product | Y |
| pickHostDirectory 本机 | APP-shell-intentional | 原生对话框 | n/a |
| 时间线图片本机 | partial | 仍 `convertFileSrc` | n/a |
| `read_binary_asset` | already-fixed | 双字段 | Y |
| conversation-events 听 | already-fixed | 总线+转发；无头批次丢 controls | Y |
| workspace-sessions-changed | already-fixed | | Y |
| agent-management 事件 | partial | Host 瘦；Tauri 富流残留 | mixed |
| discovery progress | partial | 生产者仍偏 Tauri | n/a |
| `agent-events` | partial | 本机有；Headless 只持久化 | n/a |
| local-history-import-progress | event/listen-broken | 听着；batch 走 Host 桩，生产者不跑 | n/a |
| theme/logs/settings-file | already-fixed | | Y |
| desktop-session-attention | APP-shell-intentional | 本机生产者 | n/a |
| browser://event / desktop-toast | APP-shell-intentional | 不在总线 | n/a |
| 9× subscribe_*_stream | event/listen-broken | 前端未迁 `patch_stream` | Y |
| `conversation_attach` | APP-shell-intentional | TauriTransport 仍轮询 | n/a |
| `application_call` 组装 | partial | 空 preview registry；automation 非 owner | n/a |
| 414 双路径 | partial | ADR 要求删 Tauri 副本 | n/a |
| 契约扫描器 | partial | 漏包装调用；现已红 | n/a |

---

## 7. 本机验证边界

- 本机已有 `pnpm run tauri:dev:desktop` / Vite / CEF helper 在跑。本检查按计划 **不驱动 GUI**，不编造截图。见 `desktop-launch.txt`。
- Vitest：`hostCommandContract` 失败（4 个未登记名）；`tauriTransport` 另有一条既有测试因 mock `data` 失败。`webTransport` 通过。见 `contract-tests.log`。
- `cargo test -p application --test command_contract` 曾被占用中的 `cargo build --bin vibex` 文件锁打断。随后 `cargo test -p server --lib` 已跑通 `conversation_detail_uses_open_path_snake_case_keys` 与 `create_project_session_payload_accepts_*`（`named-defect-retrace.log`）。**不以契约扫描绿作为完成门。**

---

## 8. 不回避的判断

1. 本机 Host+APP 仍比拆分前更容易在若干主路径上失败（WebPreview 空白、git `branchName`、agent `{ request }`、`events_since` 包装）。**创建会话 payload 与 conversation_detail 打开路径已在当前树修好**，不得再当成阻断。残留 Tauri 实现救不了仍走 `application_call` 的缺口。
2. 远程/Web 更差：20 个 invoke-only 前端命令未注册；WebPreview 无页面代理；无头 row-op 丢掉 session controls，也不发 `agent-events`。
3. 另一 Agent 正在填 catalog / 文件树 / 用量 / 事件转发 / detail 序列化 / 创建会话 — 那些面按当前树标 already-fixed。WebPreview、冲突/PR/脚本、conversation extras **没有**被那批改动关掉。
4. `hostCommandContract.test.ts` 现在是红的，而且即变绿也只证明名字在两份清单之一，不证明产品能用。
