# VibeX 后端性能检查报告

- **日期：** 2026-08-19
- **范围：** Rust 工作区全部后端 crate 与 `src-tauri` 热路径（不含前端渲染）
- **方法：** 逐 crate 静态审查 + 交叉核对热点查询、锁、通道、I/O 与投影路径。未做线上采样或 flamegraph；结论基于代码形状与既有慢查询迁移证据。
- **结论摘要：** 会话事件溯源、WAL、8ms 流式合并、增量行协议已经对准过一次「长会话越来越慢」的根因。当前最大风险不再是「没有快照」，而是 **(1) 远程/工作流用轮询代替推送、(2) 全局锁跨 SQLite I/O、(3) 所谓分页仍折叠整份时间线、(4) ACP 进程与载荷无上界、(5) 热写入维护了错误形状的索引。**

---

## 1. 系统热路径

```
ACP 子进程 stdout
  → AgentConnectionManager.session_notification   (每 token 一次 JSON 树)
  → unbounded mpsc → AgentRuntime 全局 write 锁
  → unbounded persist sink + broadcast(512)
  → ConversationAgentEventRecorder（8ms 合并）
  → BEGIN IMMEDIATE + conversation_events INSERT
  → 投影派生表 + 终态才写 fold_json 快照
  → emit_conversation_row_ops_after（全局 projector Mutex + DB）
  → Tauri 事件 / Remote WS

并行争用同一 SQLite 写锁的还有：
  WorkflowAgentDispatcher 250ms tick（BEGIN IMMEDIATE claim）
  Automation 30s tick（retention 全表 + 递归盘扫描）
  Remote WS 每订阅 50ms attach（事务 + events_since i64::MAX）
```

SQLite 配置见 `crates/db/src/lib.rs`：`WAL`、`synchronous=NORMAL`、`busy_timeout=10s`、池 `max_connections=20`、`acquire_timeout=30s`。这是正确的单写者基线。20 个读连接在 WAL 下合理，但上面四条轮询会把读连接和写锁一起打满。

---

## 2. 已经做对的地方

不要回退这些设计：

| 区域 | 现状 |
|---|---|
| 事件追加 | `BEGIN IMMEDIATE` 内分配 sequence；幂等键在事务内检查；去掉了热路径上多余的预查 |
| 投影 | `conversation_projection_snapshots` + 尾部 replay；终态才物化；追加与派生表同一事务 |
| 实时协议 | `ConversationRowOp` / `AppendText`，前端不再折叠原始事件 |
| 流式落库 | 8ms coalescer，避免每个 token 一次写事务 |
| ACP 安装 | 默认并发 2 + 按资源加锁（ADR-0026） |
| 终端输出 | ACP / PTY 历史均裁到 512 KiB |
| Diff 流 | `spawn_blocking`；目标分支轮询从 1s 降到 5s；单文件 inline 上限 2 MiB |
| 文件树 | `SCAN_ENTRY_BUDGET=30_000`、`SCAN_TIME_BUDGET=1.2s` |
| 自动化认领 | owner lease + 事务内推进 `next_run_at` |
| 委派等待 | `Notify`，锁不跨 `.await` |
| Registry | 24h 缓存、ETag、体积极限 |
| 历史导入命令 | 走 `spawn_blocking` |
| 工作流 run attach 首包 | 发 run + steps，不是整份 event log |

---

## 3. 按严重级别的发现

严重级别定义：

- **P0 / Critical：** 常态路径即可把 SQLite、Tokio 或内存打满，远程或多会话下必现。
- **P1 / High：** 长会话、多 worktree、导入历史、脏工作区时用户可感知卡顿或 RSS 膨胀。
- **P2 / Medium：** 规模上来后才会痛，或只打到次要面。
- **P3 / Low：** 局部浪费，优先修完上面再动。

### P0

#### P0-1. Remote WebSocket 每 50ms 对每个订阅做一次完整 `attach`

- **位置：** `crates/server/src/ws.rs`（`LIVE_POLL_INTERVAL = 50ms`）、`crates/application/src/conversation.rs` `SqliteConversationRepository::attach`
- **证据：** 有订阅时每个 tick 调用 `attach_conversation` / `attach_workflow_run`。`attach` 始终 `BEGIN`、`SELECT MAX(sequence)`、`events_since(..., i64::MAX)`、反序列化全部返回行。`after_sequence == 0` 时把**整份事件日志**塞进 `SubscriptionSnapshot.payload`。出站帧没有大小上限。
- **影响：** 1 个直播会话 ≈ 20 次 SQLite 事务/秒。N 个 socket × M 个订阅会打满 WAL、池获取（30s timeout）和 JSON CPU。长会话首次 attach 可一次序列化数 MB。`select!` 与发送共用同一 sink，大快照会堵住 Ping/Detach。
- **修复：** 用会话事件 publisher / `Notify` 推送；空闲时只查 `MAX(sequence)`；`events_since` 分页（100–500）；首包用投影行或最近 N 个 turn，不要原始全量日志；出站加有界队列和背压。

#### P0-2. 全局 row-projector 锁跨 SQLite 与整份快照反序列化

- **位置：** `src-tauri/src/events.rs` `emit_conversation_row_ops_after`；锁在 `ConversationContext.row_projectors`
- **证据：** 一把进程级 `Mutex<HashMap<Uuid, IncrementalRowProjector>>` 持有期间执行 `events_since`，miss 时还执行 `IncrementalRowProjector::load`（反序列化整个 `fold_json` + replay 尾部）。终态后 projector 被 drop，下一 turn 第一个事件再次 miss。
- **影响：** 所有直播会话的 8ms flush 串行化。任一会话 miss（打开、truncate、settle 后下一 token）会挡住其它会话的 UI 更新。
- **修复：** 每会话一把锁；DB I/O 在 map 锁外完成；用 `Arc`/`RwLock` 发布。

#### P0-3. `conversation_detail` / `timeline_page` / `rows_since` 仍折叠整份会话

- **位置：** `crates/conversations/src/projection.rs` `project` / `rows_since`；`src-tauri/src/commands/conversations.rs` `conversation_detail_core`、`conversation_timeline_page_core`
- **证据：** `project` = 加载整份 `fold_json` + `events_since(..., i64::MAX)`。分页 API 在内存里 `skip/take`。`conversation_detail` 同时下发 `timeline` 和从 timeline clone 出来的 `turns`。前端打开会话走 `conversation_detail`（`frontend/src/features/conversation/conversationApi.ts`）。
- **影响：** 打开或「翻页」长会话都要分配/解析全部 turn、工具载荷、图片。IPC 体积接近 2×。快照版本对不上时退回从 sequence 0 重放全日志。
- **修复：** 行表或按 turn ordinal 查询；真正的 cursor 分页；detail 只返回 metadata + 最近一页；版本不匹配时后台 `rebuild_projection` 一次，不要每个 open 重放。

### P1

#### P1-1. ACP 连接无数量上限、无空闲回收

- **位置：** `crates/agents/src/manager.rs`、`crates/agents/src/runtime.rs` `ensure_session` / `disconnect`
- **证据：** `connections` HashMap 无上限。超时只针对 **prompt** 空闲（10 分钟），不是进程空闲。复用条件是同一 `(agent_id, workspace_id, working_dir)` 且无在途 prompt。不同 worktree 必新开进程。`disconnect` 只在 rebind，面板关闭不拆连接。`RuntimeState` 的 connections/sessions/prompts/`session_locks` 成功后不裁剪。
- **影响：** 每个 Claude/Codex/Node ACP 子进程常驻数百 MB。十个 worktree 或交错 turn 会留下十个进程直到退出。
- **修复：** 每 agent / 全局进程上限；无在途 turn 后 5–15 分钟回收；最后一块面板 detach 时 disconnect；驱逐 `Disconnected`/`Failed`。

#### P1-2. 每个 ACP notification 整包 `to_value`，工具预览无界

- **位置：** `crates/agents/src/manager.rs` `session_notification`、`acp_tool_input_preview`、`acp_tool_content_preview`
- **证据：** 匹配类型之前先 `serde_json::to_value(&args)`。`_meta` 有 16 KiB 上限，正文没有。工具 `raw_input`/`raw_output`/diff 整段 `to_string`。图片保留完整 base64。再经 unbounded persist、`recent_events`（2000 条）、`broadcast(512)` 各拷一份。
- **影响：** 一次大文件 Write/Bash 变成多 MB 字符串进 SQLite 和 webview。慢订阅会 `Lagged` 丢 512 条。
- **修复：** 预览硬顶 8–16 KiB；图片计数/体积上限；不要为诊断去整包 `to_value`；诊断用有界通道。

#### P1-3. Fork 对每个事件单独 `BEGIN IMMEDIATE`

- **位置：** `crates/conversations/src/service.rs` `copy_conversation_history`
- **证据：** `events_since(..., 0, i64::MAX)` 后循环 `ConversationEventAppender::append`（每条一次事务 + 投影 + 终态快照刷新）。
- **影响：** 1 万事件的会话 fork 约 1 万次写事务，长时间占住唯一写者。
- **修复：** 单事务批量 insert + 一次 `rebuild_projection`；或 SQL `INSERT … SELECT` 再改写 id。

#### P1-4. `conversation_events` 热写入维护了错误形状的索引

- **位置：** `20260616000000_event_sourced_conversation_core.sql`、`insert_conversation_event`
- **证据：**
  - `UNIQUE(conversation_id, sequence)` 与 `idx_conversation_events_conversation_sequence` 重复
  - 全局 `idx_conversation_events_kind(event_kind)` 对 `assistant_text_delta` 几乎无选择性，但每 token 都更新
  - `UNIQUE(conversation_id, idempotency_key)` 包含 NULL 键
  - `INSERT … RETURNING` 整行含 `normalized_json`/`raw_json`
  - `recent_of_kind_with_executor` 按 `created_at DESC` 排序，现有 kind 索引盖不住
- **影响：** 流式写入放大 B-tree 维护；与 git 轮询、快照 upsert 叠加后更容易 `database is locked`。
- **修复：** 删冗余/低选择性索引；改为 `(conversation_id, event_kind, sequence DESC)` 与部分 `(event_kind, created_at DESC) WHERE event_kind IN (...)`；部分唯一索引排除 NULL；`RETURNING` 只要 id/sequence/created_at。

#### P1-5. 工作流 dispatcher 空闲也 250ms 打一次写路径

- **位置：** `src-tauri/src/lib.rs`、`crates/server/src/composition.rs`、`crates/application/src/workflow.rs` `WorkflowAgentDispatcher::tick`、`crates/workflows/src/store.rs` `claim_ready`
- **证据：** `Ok(false)` 仍 `sleep(250ms)`。每次 tick：过期 run、交互协调、终态 step 协调，然后 `claim_ready` 的 `BEGIN IMMEDIATE` + 反序列化候选 DAG。
- **影响：** 与会话 8ms 追加抢同一写锁，即使没有任何工作流在跑。
- **修复：** turn 终态 / step-ready 时 `Notify`；空闲 1–5s；ready 表为空时不要 `IMMEDIATE`。

#### P1-6. 自动化 retention 每 30s 全表 + 递归量盘

- **位置：** `crates/db/src/models/automation_v2.rs` `terminal_runs_oldest_first`；宿主循环 `src-tauri/src/commands/automation.rs`、`crates/server/src/automation_runtime.rs`
- **证据：** `WHERE status <> 'running'` 无 LIMIT；对每个历史 worktree `directory_size_without_symlinks`。30s tick 每次都跑，不是按小时。
- **影响：** 历史一长，每次 tick 都是 SQLite 大读 + 阻塞池上的递归 `read_dir`。
- **修复：** `finished_at <= expiry LIMIT n`；settle 时记下 `storage_bytes`；retention 独立 1h 定时器。

#### P1-7. 本地历史「扫描列表」解析全部正文

- **位置：** `crates/agents/src/history/`、`src-tauri/src/commands/local_history.rs`
- **证据：** 遍历 `~/.claude`、`~/.codex`、Gemini、Cline、Cursor 等。每个 json/jsonl `read_to_string` 并解析。列表页只要 title/count/mtime，却持有全部 messages。批量导入对每个选中 agent **再扫一遍整树**。Codex locate 为找 session id 读完整份 jsonl。OpenCode/Hermes 是 N+1 prepare。
- **影响：** 打开「导入本地历史」可到数十秒、数百 MB–GB，占满 `spawn_blocking` 池（git 等一并卡住）。
- **修复：** 列表只读元数据；全文仅对选中 id；扫描结果缓存；导入不要重扫。

#### P1-8. Git / 文件树 / 搜索在 Tokio worker 上同步执行

- **位置：** `get_file_tree`（async 里直接 `WalkBuilder`）；`crates/server/src/domains.rs` `repo_branches`；`src-tauri` workspace git status/diff/commit；`crates/services/src/services/file_search.rs`、`filesystem.rs`
- **证据：** worktree 创建已正确 `spawn_blocking`，但列表/状态/搜索/文件树没有。`get_all_branches` 打开仓库并对每个本地+远程 branch `find_commit`。`file_search` 走完整树再 `truncate(10)`。
- **影响：** 大仓库一次 status/search 卡住 HTTP、WS、ACP 落库共用的 runtime。
- **修复：** 全部 git2/CLI/递归 walk 进 `spawn_blocking`。

#### P1-9. Diff 为统计也装入全文；流累计上限 200 MiB

- **位置：** `crates/git/src/diff_ops.rs`、`crates/services/src/services/diff_stream.rs`
- **证据：** 未省略文件整份 UTF-8 拷贝；单文件 2 MiB，文件数无上限。`compute_diff_stats` 走同一 `get_diffs`。流省略在累计 200 MiB 之后才触发。`Patch::from_diff` 写在 `foreach` 里。
- **影响：** 打开脏 worktree 可分配数百 MB。
- **修复：** stats 走 `numstat`/libgit2 line stats；内容按需；累计上限降到 8–16 MiB。

#### P1-10. 工作区列表先全表再在 Rust 里截断，并 N+1 回填名字

- **位置：** `crates/db/src/models/workspace.rs` `find_all_with_status`
- **证据：** `FROM workspaces w ORDER BY updated_at DESC` 无 WHERE；`archived` 和 `limit` 在 Rust 里 filter/truncate；无名工作区循环 `get_first_user_message` + `UPDATE`。每行还有两条 `execution_processes` 相关子查询。
- **影响：** 工作区轨道延迟随**全部历史工作区**增长，不是页大小。列表路径上还打写锁。
- **修复：** `WHERE archived = ? ORDER BY updated_at DESC LIMIT ?`；名字异步回填。

#### P1-11. 委派完成缓存默认 512 MiB

- **位置：** `crates/delegation/src/types.rs` `DelegationConfig::default`
- **证据：** `completed_cache_cap_bytes: 512 * 1024 * 1024`。每条结果另有 256 KiB 上限，但缓存按父会话堆到半 GB。
- **修复：** 默认数 MiB 或只留 id，正文读 child conversation。

#### P1-12. SQLite 未设 `cache_size` / checkpoint 策略

- **位置：** `crates/db/src/lib.rs` `DBService::new_at`
- **证据：** 只有 WAL/NORMAL/busy_timeout。默认页缓存相对多 MB 的 `fold_json` 偏小；WAL 每约 1000 页 checkpoint 会卡住唯一写者。
- **修复：** 连接时 `PRAGMA cache_size=-65536`（64MB）；考虑 `mmap_size`、提高 `wal_autocheckpoint` 或后台 checkpoint；退出时 `PRAGMA optimize`。

### P2

| ID | 模块 | 问题 |
|---|---|---|
| P2-1 | conversations | 快照只在 turn 终态刷新；长在途 turn 的每次 `project`/`rows_since` 重放整段当前 turn。版本 bump 后每个 open 全量 replay，直到下一次 settle |
| P2-2 | conversations | `fold_json` 就是整份时间线（含工具/图片）。settle 时再 FTS5 trigram 全量重索引，拉长 `BEGIN IMMEDIATE` |
| P2-3 | application | `output()` 为最后一段 assistant 文本调用完整 `project()` |
| P2-4 | conversations | `ScopedConversationControl::wait` 100ms 轮询 + `list_for_conversation` 全量 turns |
| P2-5 | application | `wait_for_dispatched_input_turn` 25ms 轮询 |
| P2-6 | db | `list_recent` 对 `updated_at` 做 `datetime(replace(substr(...)))`，无法走索引 |
| P2-7 | db | `list_for_workspace` 无 LIMIT；catalog 加载全部未归档 workspaces |
| P2-8 | db | `find_expired_for_cleanup` join 爆炸 + `datetime()` 包住比较列 |
| P2-9 | db | `failed_last_turns` 对每个失败 turn 相关子查询 `MAX(ordinal)` |
| P2-10 | db | `execution_process_logs` 一行一次 INSERT，读路径无界 `fetch_all` |
| P2-11 | db | `conversation_file_changes` 缺 `conversation_id` 索引 |
| P2-12 | db | `list_in_flight` / queued inputs 缺 status 前导/部分索引 |
| P2-13 | agents | `std::fs` 出现在 skills / seed trust / launch 探测的 async 路径 |
| P2-14 | agents | Skills 每次请求重读全部 `SKILL.md`；native config 无 mtime 缓存；全局写锁 |
| P2-15 | agents | Codex plan-usage 每次拉起完整 `app-server` 子进程 |
| P2-16 | agents | stderr 按字节推进 ring，且每块都发 diagnostic |
| P2-17 | agents | 全局 runtime write 锁 + 每 chunk 多个 Mutex（`last_activity`/`stream_dedup`） |
| P2-18 | plugins | 每次 resolve opener 都 `fetch_all` + 重建 catalog |
| P2-19 | plugins | `package_content_digest` 同步走树并 hash 两次；bootstrap 打在 runtime 上 |
| P2-20 | server | 微信 iLink 成功路径无 sleep，空 `getupdates` 会空转 |
| P2-21 | services | notify 回调里 `futures::executor::block_on`；Linux 每目录一个 inotify |
| P2-22 | pty / terminal | 输出 `unbounded_channel`；慢 UI 时 RAM 增长 |
| P2-23 | utils | `MsgStore` 100MB 历史 + `broadcast(10000)` + push 时 clone |
| P2-24 | worktree | `WORKTREE_CREATION_LOCKS` 永不驱逐；空 HEAD 会拷贝全部 untracked |
| P2-25 | server | 静态资源每次整文件读进内存 |
| P2-26 | server | artifact list N+1；`app_surface` 在 async 里 `std::fs::read` 最大 16 MiB |
| P2-27 | settings | 设置文件 watcher 无 debounce，一次保存多次 reload |
| P2-28 | chat | inbound 每 5s `load_store()` 读 settings |
| P2-29 | workflows | `claim_ready` 在事务里为每个候选反序列化整份 DAG JSON |
| P2-30 | conversations | `turn_locks` / runtime_states 直到显式 forget；UI 从不 close |
| P2-31 | git | 每次 `Repository::open`，无 repo handle 缓存 |

### P3

- `agent_session_for_acp` 每次 notification 线性扫 `session_map`
- `operations.rs` `redact` 每行编译一次 `Regex`
- `history_paths_overlap` 多余分配
- `COUNT(*)` 代替 `EXISTS` 做「是否有 running process」
- `Project::find_most_active` 的 `IN (SELECT … ORDER BY)` 排序被 SQLite 忽略
- `Scratch::find_all` 加载并解析全部草稿/偏好
- `Task::find_all` / `Workspace::fetch_all(None)` 全表
- 启动时 `PluginV1Migration::retire_all`、legacy timezone 解析可短路
- 冗余 `idx_sessions_workspace_id`（已被 workspace+created_at 覆盖）
- workspace `serde_json` 开了 `preserve_order`，热路径略贵
- `src-tauri/src/commands/agent_management.rs` 11172 行、`manager.rs` 6167 行：锁粒度和 clone 风暴难收敛

---

## 4. 按模块审查

### 4.1 `crates/db` — 存储与查询

**职责：** SQLite、迁移、哑模型。会话权威在事件日志；投影是加速手段。

**做得好：** WAL 注释与实现一致；热路径列清单明确；输入队列有复合 + 部分索引；automation due / one-active 索引正确；历史迁移 `20250917123000`、`20251219164205`、`20260112160045` 说明团队已经用真实慢查询补过索引。

**主要问题：** 见 P1-4、P1-6、P1-10、P1-12、P2-6–P2-12。额外注意：

- `MAX(sequence)+1` 在 `BEGIN IMMEDIATE` 里是正确的 SQLite 模式，不必上序列表。
- 快照表设计对，但 `fold_json` 无压缩、无拆分。
- FTS5 `trigram` 为 CJK 是对的，代价是第二份大体量副本；settle 时全量重写。
- `sqlx` 默认 `foreign_keys=true`：每条事件 2–3 次 PK 查找，正确性优先，不要关。

### 4.2 `crates/conversations` — 事件溯源核心

**文件规模：** `projection.rs` 4966 行，`service.rs` 3927 行。

**热路径：**

1. `ConversationEventAppender::append` — 事务内 insert + 派生表 + 终态快照。
2. `ConversationProjector::project` — 读路径，仍是整份 fold。
3. `IncrementalRowProjector` — 实时 O(1) 摊还，但被全局锁和 settle-drop 抵消。
4. `copy_conversation_history` — fork 逐事件事务（P1-3）。
5. 输入 dispatcher 是事件驱动（submit / 终态），不是 sleep 环——保持。

**投影版本：** `CONVERSATION_PROJECTION_VERSION = 14`。版本不匹配时 `load_fold_from_snapshot` 返回空 fold，调用方用 `i64::MAX` 重放全日志，且**不会**自动 `rebuild_projection`。

### 4.3 `crates/application` — Application Core

**问题集中在读适配，不在写语义：**

- `attach` 无界（P0-1）
- `output()` 完整 `project()`（P2-3）
- `catalog` 全量 projects/workspaces
- Workflow dispatcher 250ms + `claim_ready` IMMEDIATE（P1-5）
- Workflow 首包 attach 相对克制（run + steps），但 live replay 上限 10_000 且仍被 50ms 轮询驱动

### 4.4 `crates/agents` — ACP runtime

**文件规模：** `manager.rs` 6167，`runtime.rs` 3010。

**拓扑：** 每连接一个 ACP stdio 子进程；runtime 一份全局 `RwLock<RuntimeState>`。安装并发有界，**运行时进程数无界**。

**每 token 成本（当前）：**

1. `last_activity.lock()`
2. 整包 `SessionNotification` → `serde_json::Value`
3. 可选 `stream_dedup` / `grok_subagent` 锁
4. unbounded 发到 runtime
5. 全局 `state.write()`
6. clone 进 recent_events + persist + broadcast

**历史导入**是第二大用户可见卡顿（P1-7）。Skills / native config 是设置页卡顿（P2-13/14）。

### 4.5 `crates/server` — Headless / Remote

**最大问题是订阅模型：** Durable attach 的产品语义是 snapshot → replay → live，实现却是 50ms 轮询完整 `attach`。这直接违反「sequence 为权威、live 为增量」的成本模型。

其它：微信空转（P2-20）、静态资源整包读（P2-25）、git 命令不进 blocking 池（P1-8）、artifact N+1（P2-26）。

入站帧 1 MiB 上限、`MissedTickBehavior::Skip`、Telegram `timeout=25` 长轮询应保留。

### 4.6 `crates/services` — Worktree / git host / watcher / diff

- Diff 流隔离和 debounce 正确。
- Watcher 启动双次 WalkBuilder；notify 回调 `block_on`；Linux 每目录 watch。
- Worktree 锁 map 泄漏；untracked seed 无大小上限。
- PR monitor 60s 可接受。
- File search 在 async 上走整树。

### 4.7 `crates/git`

无 repo handle 缓存。`get_diffs` 为 UI 装全文。`collect_recent_file_stats` 对每个 commit 做 tree-to-tree diff（有 `commit_limit`，可接受）。`revwalk` 在 branch query 里通常有 hide/take。

### 4.8 `crates/delegation`

等待路径设计好。默认完成缓存 512 MiB 过大（P1-11）。`calls_started` 在 `parent_closed` 时不清理。活跃子数量有上限（默认 4，钳到 64）。

### 4.9 `crates/workflows` + `crates/automation`

工作流 schema（ready 表、`(run_id, sequence)`、claim TTL）对齐 FIFO。成本在 **250ms 空转写** 和 **claim 时解析 DAG**。

自动化认领语义正确。成本在 **retention 与 due-claim 无 LIMIT**。cron `next_after` 最坏按分钟扫到 8 年，只打到病理表达式。

### 4.10 `crates/plugins` + `crates/tool-runtime` + `crates/artifacts`

控制面按 generation 发布是对的，但 resolve 每次从 SQLite 重建 catalog。digest 是 O(树) 同步哈希。App surface 最大 16 MiB 同步读。Artifact 内容不进数据库（只存路径/hash）——正确。

### 4.11 `crates/local-deployment` + `crates/utils`

PTY 历史 512 KiB 裁剪正确；输出通道无界。`MsgStore` 仍服务全局日志/旧补丁流，100MB + 10000 broadcast 对 agent 补丁风暴偏大。脚本执行（非 agent）仍走 executors；`execution_process_logs` 一行一写会和 ACP 抢写锁。

### 4.12 `src-tauri`

应为薄适配。实际：

- `commands/agent_management.rs` 11172 行：探测、PATH、安装、各 agent 特例
- `events.rs` 持有全局 projector 锁（P0-2）
- `get_file_tree` async 包装同步 walk（P1-8）
- 文件树 listing 的 budget 只覆盖 `list_directory_children`，`get_file_tree_entries` 按 depth 走树，budget 较弱

---

## 5. 交叉争用：四条写者抢一把 SQLite 锁

单写者是 SQLite 事实。当前同时想写的是：

| 来源 | 频率 | 事务形态 |
|---|---|---|
| ACP 流式追加 | 合并后 ~125 Hz 峰值（8ms） | `BEGIN IMMEDIATE` + 派生表；终态再写大 `fold_json` + FTS |
| Remote WS attach | 20 Hz × 订阅数 | 读事务，但占连接、增加 WAL 读快照 |
| Workflow tick | 4 Hz | 即使空闲也可能 `IMMEDIATE` |
| Automation tick | 1/30 Hz，但 retention 很重 | 大 SELECT + 盘扫描 |

桌面再叠加 git status、diff 流、文件监视。这就是「agent 一跑就 database is locked / 池获取超时」的根因——注释里已经写过一次，轮询又把问题引回来了。

---

## 6. 建议修复顺序

按用户可感知收益 / 风险排序。每一项都应带回归测试（长会话 fixture、双会话并发流、WS 订阅、fork）。

### 第一波（堵住常态放血）

1. **WS / workflow live 改为 Notify + 分页 `events_since`。** 空闲禁止完整 `attach`。
2. **每会话 projector 锁；DB 不在全局 Mutex 里。**
3. **`conversation_detail` 改为 metadata + 最近一页行；让 `timeline_page` 真正按 cursor 查，而不是先 `project()` 再 slice。**
4. **给工具/图片/诊断载荷设上限；停止每个 notification 整包 `to_value`。**

### 第二波（长会话与多 agent）

5. ACP 空闲回收 + 进程上限 + 驱逐 runtime map。
6. 整理 `conversation_events` 索引；`RETURNING` 瘦身。
7. Fork 改为单事务/批量复制。
8. 工作流 tick 事件驱动；automation retention 降频并 LIMIT。
9. 历史扫描元数据化。

### 第三波（仓库与列表）

10. git/status/search/file-tree 全部 `spawn_blocking`；diff 默认 stats。
11. 工作区/会话列表把 filter/LIMIT 推进 SQL；规范化 `updated_at`。
12. SQLite `cache_size` + checkpoint 策略。
13. 插件 catalog 按 generation 缓存。
14. 委派完成缓存降到数 MiB。

### 验证方式（修完再测，不要只看截图）

- 10k+ 事件 fixture：打开会话、翻页、fork、远程 attach 的延迟与堆分配。
- 双会话同时流式：UI 行更新不应互相阻塞（针对 P0-2）。
- 无工作流、无远程客户端空闲 5 分钟：SQLite write 次数应接近 0（针对 P0-1 / P1-5）。
- 10 个 worktree 打开后关闭面板：ACP 子进程数应回落（针对 P1-1）。
- 脏工作区 1000 文件：diff 面板内存应远低于 200 MiB（针对 P1-9）。

---

## 7. 范围外 / 未测

- 未跑 `perf`/`instruments`/生产 WAL 采样；P0/P1 的量级来自循环频率与载荷形状。
- 未测 CEF / `browser-*` 渲染性能。
- 未测前端虚拟列表；后端若仍一次下发整份 timeline，前端优化救不了 IPC。
- `crates/review`、生成协议绑定、测试夹具只扫了是否误入热路径。

---

## 8. 模块评分（热路径健康度）

| 模块 | 评分 | 一句话 |
|---|---|---|
| db 连接/WAL | B+ | 基线对，缺 cache/checkpoint，热索引形状错 |
| conversations 写入 | B | 事务与 coalescer 对；fork 与快照体积差 |
| conversations 读取 | D | 分页是假的；detail 仍是全量 fold |
| application attach | D | 远程 50ms 全量 attach |
| agents runtime | C | 复用和 watchdog 在，进程/载荷无界 |
| agents history | D | 列表即全量解析 |
| server WS | F | 轮询代替订阅 |
| workflows dispatcher | C- | 模型对，空闲写太勤 |
| automation | C | 认领对，retention 太重 |
| git / diff | C | blocking 隔离不完整，diff 太胖 |
| plugins | C+ | generation 模型对，resolve 每次重建 |
| delegation | B- | 等待路径好，缓存默认值离谱 |
| local-deployment PTY | B | 历史有顶，通道无顶 |

**总评：** 架构方向（事件溯源 + 快照 + 行协议 + WAL）是对的，而且已经修过一轮读放大。当前性能债集中在 **把正确的增量协议接回轮询和全量 fold**，以及 **运行时资源（ACP 进程、JSON 预览、完成缓存）没有与安装调度同等的上限。**
)
