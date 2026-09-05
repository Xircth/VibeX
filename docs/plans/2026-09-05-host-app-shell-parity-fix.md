# Host+APP 壳对齐纯桌面 — 分批修复计划

依据：[2026-09-05 检查报告](../research/2026-09-05-host-app-shell-parity-audit.md)、ADR-0078。  
规则：每个非 `Host-parity`、且非「APP-shell-intentional 且本机仍可用」的矩阵行，只出现在一个批次。  
Batch 1 = 用户立刻无法使用产品的阻断。

不要手改 `shared/hostCommands.ts` / `shared/types.ts`；改 Rust 描述符后跑 `pnpm run generate-types`。  
不要把 `hostCommandContract.test.ts` 变绿当成产品已齐。

---

## Batch 1 — 本机主路径阻断

目标：WebPreview 回车能出页面或明确报错；时间线能补放；改 session mode/option 能打到 Core；git 建分支/切分支与 create/update workspace 能解析。

**已从 Batch 1 拿掉（当前树已修好，勿再当阻断）：**

- `conversation_detail` snake_case 打开路径 / composer summary 水合（见报告 §2.2）
- `create_project_session` camelCase payload + worktree + prepared session（见报告 §2.3）

| ID | 矩阵行 | 做法 |
|---|---|---|
| B1.1 | WebPreview/CEF 空白 | 惰性 CEF 失败必须变成 `unavailable_runtime` 并返回错误，禁止 Ack 后静默。创建 tab 后 `setSurface` 必须在 overlay 收起后强制 `visible: true`。ADR-0007：无引擎就显示初始化错误。 |
| B1.2 | `conversation_events_since` `{ request }` | Host `parse` 与 Application Core 一样接受扁平或 `{ request: … }`（统一 unwrap）。前端 `.catch(()=>{})` 不能再吞补放失败。 |
| B1.3 | `conversation_set_session_mode` / `set_session_config_option` | Core `parse_args` 接受 `{ request }` 或扁平，与 `conversationApi` 一致。创建后 `initializeSessionControls` 依赖这条。 |
| B1.4 | checkout/create/delete **repo & workspace** branch | Host 接受 FE 的 `branchName`（alias），或改 FE 为 `branch` — 只留一种。 |
| B1.5 | `create_workspace` / `update_workspace` | Host 解开 `{ payload }` / `{ workspaceId, payload }`，与 `attempts.ts` 一致。 |

完成门：WebPreview 回车要么出页面要么明确错误；timeline `eventsSince` 不再静默失败；创建会话后 set mode/option 不再 `bad_request`。

---

## Batch 2 — 本机 Host 路径参数/语义残缺（日常编码仍会踩）

这些命令已在 `HOST_COMMANDS`，本机走 Host，行为比 Tauri 副本差。

| ID | 矩阵行 | 做法 |
|---|---|---|
| B2.1 | `search_repo` 丢 `mode` | Host 接受并使用 `mode` |
| B2.2 | `delete_workspace` | 尊重 `deleteBranches`；在跑进程时拒绝 |
| B2.3 | `get_workspace_branch_status` | 返回全部 repo 的 `RepoBranchStatus[]`，含 PR 附着 |
| B2.4 | `get_workspace_commit_graph` | 使用 `maxCommits` |
| B2.5 | `get_workspace_commit_diffs` | 按 sha 取 commit diff，不是工作区 diff |
| B2.6 | `rename_workspace_branch` | 接受 `newBranchName`；真正 rename，不是 create_branch |
| B2.7 | `change_workspace_target_branch` | 接受 `newTargetBranch`；校验分支存在 |
| B2.8 | `push_workspace_branch` | 尊重 `force` |
| B2.9 | `rebase_workspace` | 使用 old/new base；返回 `RebaseResult` |
| B2.10 | `stash_workspace` | 使用 message / includeUntracked |
| B2.11 | Tags CRUD | 对齐 `{ payload }` / `{ tagId }` / `search` |
| B2.12 | get/update/delete task | 对齐 `{ taskId }` / `{ taskId, payload }` |
| B2.13 | `create_task_and_start` | 创建后真正启动，与拆分前一致 |
| B2.14 | `get_file_at_head` | 使用仓库相对路径，不只文件名 |
| B2.15 | Agent 运行时整族 `{ request }` | `agent_connect` / `prepare_session` / `new_session` / `resume` / `send_prompt` / `cancel` / `disconnect` / `respond_permission` / `list_remote` / `delete_remote` / `import_remote` / `import_local*` / `reset_checkpoint` / `load_session` / `list_session_commands` / `discard_prepared` / `set_prepared_*` / `terminal_snapshot`：一律 `parse_payload`（或等价 unwrap）。不要每个命令手写一次。 |
| B2.16 | `conversation_ensure` 仅零回合 | 打开已有会话若 detail 无 controls，仍应 ensure。打开路径 detail 已 snake_case；无头 live batch 见 B4.7。 |

完成门：针对每个命令写「前端真实 args → Host parse → 与 Tauri 旧语义对照」测试。禁止再靠 serde 默认忽略多余字段假装成功。

---

## Batch 3 — 前端在用、Host 未接管（本机靠残留 invoke，远程必挂）

迁入 Host 后 **删除** 对应 `invoke_handler` 条目。

| ID | 矩阵行 |
|---|---|
| B3.1 | `continue_conflicts_workspace` / `get_workspace_conflict_file` / `write_workspace_conflict_resolution`（ADR-0076 三窗格在 Host 上必须可用） |
| B3.2 | 名称对齐：`continue_rebase_workspace` vs 前端实际调用的 continue-conflicts |
| B3.3 | `create_workspace_pr` / `attach_workspace_pr` / `create_workspace_from_pr` |
| B3.4 | `run_setup_script` / `run_cleanup_script` / `run_archive_script` |
| B3.5 | `conversation_timeline_page` |
| B3.6 | `conversation_rebind_session` |
| B3.7 | `conversation_truncate_to_turn` + `conversation_checkpoint_file_changes_preview` |
| B3.8 | `conversation_close` |
| B3.9 | `conversation_export` / `_markdown` / `_html` |
| B3.10 | `conversation_search` / `conversation_import` / `conversation_fork` |
| B3.11 | `plugin_renew_file_preview` 进入生成的 `HOST_COMMANDS`（DomainCommand 已有） |
| B3.12 | `agent_scan_local_history`：Host 可订阅进度（不能只靠 Tauri Channel） |
| B3.13 | `show_workspace_stash` 若产品仍需要则迁入，否则删 invoke 与死代码 |

完成门：这组名字出现在 `HOST_COMMANDS`（或明确 SHELL）；契约扫描扩到 `call(` / `invokeAsResult` / `callApplicationCommand` 后为绿；Web `/call/{name}` 不再 unregistered。

---

## Batch 4 — 事件与 patch 流（ADR-0078 §4–§5）

| ID | 矩阵行 |
|---|---|
| B4.1 | 前端 `useTauriPatchStream` → 唯一 `usePatchStream`：`transport.subscribe({ resource: 'patch_stream' })`。覆盖 projects / project_workspaces / execution_processes / diff / file_tree / scratch / slash_commands / log / conversation。 |
| B4.2 | 从 `DESKTOP_SHELL_COMMANDS` 和 `invoke_handler` 删除 9 个 `subscribe_*_stream`。 |
| B4.3 | Headless 发出 `agent-events` 与 `agent-terminal-events`（现在只本机 `events.rs` 发）。 |
| B4.4 | `local-history-import-progress`：batch/snapshot 走 Host 真作业，不再 `Default` 空快照；进度从同一总线发。 |
| B4.5 | discovery progress / agent-management 富事件从 Host 管理实现发出，不依赖已死的 Tauri 副本。 |
| B4.6 | `TauriTransport.subscribe` 停止轮询 `conversation_attach` 作为通用订阅；durable conversation 与 Companion 仍用 conversation 资源，产品 UI 用 bus。 |
| B4.7 | 无头 `HostRowOpPublisher` 丢掉 session controls：与本机 `events.rs` 一样拷 `SessionModeUpdated` / `SessionConfigOptionsUpdated` / `AvailableCommandsUpdated`。打开路径 detail 已 snake_case，不要和这条混成「summary 仍坏」。 |

完成门：Web 与本机同一套 listen/subscribe；关掉 Tauri subscribe command 后文件树/diff/slash/scratch 仍更新。

---

## Batch 5 — Host 实现变薄、组装错误、双路径残渣

| ID | 矩阵行 |
|---|---|
| B5.1 | `application_call` 使用进程内共享 preview registry 与 automation owner，禁止每次 `PreviewProxyRegistry::default()` + `owns_automation_engine: false`。 |
| B5.2 | `automation_engine_status` 在本机 Host 上反映真实 engine。 |
| B5.3 | `preview.proxy` 租约活过单次 `application_call`。 |
| B5.4 | Agent management：set_enabled 返回 view；rollback 真 rollback；`config_file_write` 不要派到 environment_write；install/remove 达到拆分前语义或明确降级 UI。 |
| B5.5 | local-history import：Host 写入 transcript，不是空 Session。 |
| B5.6 | `create_session` / `create_project_root_session` / `delete_session` 补齐 container / prepared session / process+scratch+FTS。 |
| B5.7 | 删除已迁入 HOST 的 414 个 `invoke_handler` 死副本（ADR-0078 §3）。 |
| B5.8 | 删无调用 leftover：`get_project_repository`、`get_tasks`、以及确认无 UI 的 invoke 名。 |
| B5.9 | `RemoteDesktopTransport.listen/subscribe` 凭据不进 WebView（Rust 持有 WS）。 |
| B5.10 | capabilities 由真实注册表+适配器派生，去掉第二份 `TauriTransport` 硬编码清单漂移。 |
| B5.11 | 契约扫描补 `call(` / `invokeAsResult` / `callApplicationCommand`；红测试当作门禁而不是忽略。 |

完成门：本机 UI 不再能 invoke 到与 Host 分叉的旧 Tauri 产品实现；preview/automation 跨调用保持身份。

---

## Batch 6 — 壳诚实降级与收尾

| ID | 矩阵行 |
|---|---|
| B6.1 | Web/Workstation：无 `desktop.tauri` 时隐藏 CEF WebPreview，或提供真正的页面 preview proxy。禁止空白回车。 |
| B6.2 | 删除 SHELL 里无实现的 `browser_create` / `browser_navigate` / `browser_close`。 |
| B6.3 | 本机时间线图片离开 `convertFileSrc`，与 Web 一样 `read_binary_asset` + Blob（ADR-0078 §7）。 |
| B6.4 | 通知音 / 编辑器探测：远程 UI 不要假装本机响了/探测了客户端编辑器。 |
| B6.5 | `plugin_control_import_cli` 继续壳专属，Web 保持拒绝并在 UI 隐藏。 |
| B6.6 | 文档：ADR-0078 与代码名对齐（`HostContext`/`host_commands!` 要么落地要么改 ADR 指向 `DomainCommand`+`RegisteredCommand`）。 |

完成门：无 `desktop.tauri` 的客户端看不到假 CEF；本机壳能力（CEF、对话框、更新器、托盘、备份、隧道、Inspector）仍可用。

---

## 批次外（保持，不当缺陷单开）

这些是 `Host-parity` 或 `APP-shell-intentional` 且本机仍可用，或另一 Agent **已经修好**、只需回归、不要回滚：

- Project/Repo 主 CRUD、工作区 git 状态/暂存/提交、session list/rename/pin、turn/steer/queue、permission/question、PTY、文件读写、plugin 主控制面、chat、automation 命令集、workflow core、设置/日志、scratch、images、attention、pickHostDirectory 本机原生对话框、PTY 输出、trash、open_external_terminal、窗/托盘/Toast/更新器/备份/隧道/Inspector、`browser://event`、desktop-toast。
- already-fixed：file_listing/search、usage/plan usage、slash 频道、`read_binary_asset` 双字段、Host 总线转发、`WebTransport.listen`、WS `patch_stream`（仅服务端）、capability catalog、session defaults、agent environment、workflow source、chat/config/images catalog、**`conversation_detail` snake_case 打开路径**、**`create_project_session` camelCase + worktree + prepared session**。

---

## 建议落地顺序

1 做完才能谈「能用」。2 与 3 可按域平行（git 语义 vs 补注册），但每个命令迁入时立刻删 Tauri 副本，禁止再留死路径。4 必须在 3 的 conversation extras 之后或同时，否则时间线补放与流订阅会互相掩盖。5 是结构债，拖得越久 Host/Tauri 分叉越大。6 是远程诚实与壳收尾。
