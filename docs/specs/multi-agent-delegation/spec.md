# Spec: 多智能体协同 / 委派（Multi-Agent Delegation）

> 状态：**Phase 1 - Specify（待评审）** ｜ 分支：`feature/multi-agent-delegation`
> 创建：2026-06-14

## 1. Objective（目标）

让 VibeX 的**父智能体（v1 限 ClaudeCode）的 LLM 能够自主把自包含子任务委派给独立的子智能体会话**，子任务异步在后台执行，父智能体可并行 fan-out 多个、轮询/等待/取消，并在结果回来后继续推进。同时让父智能体能在运行中**实时接收用户插话（steering）**与**向用户提阻塞式多选问题**。

**用户故事**
- 作为使用 ClaudeCode 的用户，当模型遇到可并行的独立子任务（如「分别在 A、B、C 三个目录里跑测试并汇总」），它能一次性派发多个子 agent，后台并行执行，自己继续干别的，再统一收集结果。
- 作为用户，我能在主会话里**看到**每个委派：子 agent 类型、任务、运行/完成/失败状态，并能一键**打开子会话**查看完整过程。
- 作为用户，我能在父 agent 工作时随时输入纠偏，模型通过 `check_user_feedback` 主动读取；模型遇到真正需要我决策的岔路时用 `ask_user_question` 弹卡片问我。

**成功的样子**：见 §9 Success Criteria。

### 范围（v1）
| 维度 | v1 决策 |
|------|---------|
| 委派语义 | **异步 fan-out**（`delegate_to_agent` 返回 `task_id`；`get_delegation_status` 批量轮询/`wait_ms` 阻塞，封顶 60s；`cancel_delegation`）|
| 父 agent（被注入工具） | **仅 ClaudeCode** |
| 子 agent（可被派发） | 7 个 ACP agent 任意（ClaudeCode/Codex/OpenCode/Gemini/OpenClaw/Cline/Hermes）*（假设，见 §11）* |
| steering 工具 | **接入** `ask_user_question` + `check_user_feedback` |
| 前端 | **完整内联委派卡片** + 打开子会话 |
| MCP 注入方式 | **ACP `session/new` 的 `mcp_servers` 参数**（按会话隔离，见 §4.3）|
| 委派深度上限 | 默认 1（可配置；走 `sessions.parent_session_id` 链计算）|

### 非目标（v1 不做）
- 父 agent 扩展到 ClaudeCode 以外（Codex/OpenCode 的 FileToml/FileJson 注入、4 个 AgentCommand 型 agent 的注入留待 v2）。
- 子 agent 多轮续聊（`continue_with_session`/`close_session`）——v1 子任务一次性（首个 turn 完成即定）。
- 跨工作区委派、远程 agent。

---

## 2. 背景与关键约束

**决定性事实**（已核验，影响整体架构）：VibeX 当时**没有任何「app 自实现工具暴露给 agent LLM」的能力**。前端的 `ask_question`/`feedback_check`/`task_create` 卡片只是按工具名识别 agent 原生工具（见 [NormalizedConversation tools](../../../frontend/src/components/NormalizedConversation/tools)），后端对 MCP 完全被动（只读写用户配置文件，spawn 时零注入）。

> 推论：要让父 LLM 能**调用**委派工具，必须从零搭建「companion MCP 二进制 + 进程间传输 + 进程内 broker」整条链路——没有捷径，因为 ACP agent 的 LLM 只能通过 MCP server 拿到 app 提供的工具。这是本特性的主要工作量来源。

**VibeX 现有可复用锚点**：
- ACP 子系统在 `crates/agents/`：`AgentRuntime.connect()`/`send_prompt()`（[runtime.rs](../../../crates/agents/src/runtime.rs)），turn 完成事件 `AgentEvent::PromptFinished{ stop_reason: Option<String> }`（[events.rs](../../../crates/agents/src/events.rs)）。
- `AgentType` 枚举 7 个 ACP agent（[registry.rs](../../../crates/agents/src/registry.rs)）。
- 事件总线：`broadcast::Sender<AgentEventEnvelope>` → [src-tauri/src/events.rs](../../../src-tauri/src/events.rs) 转发到 Tauri `agent-events` 频道 → 前端 [features/agents/events.ts](../../../frontend/src/features/agents/events.ts) 订阅、[store.ts](../../../frontend/src/features/agents/store.ts) reduce。
- MCP 配置读写：`AgentMcpStrategy`（ClaudeCode = `FileJson`，`mcpServers` 键）+ `read/write_agent_mcp_config()`（[mcp_file.rs](../../../crates/agents/src/mcp_file.rs)）。
- DB：sqlx + 原生 SQL 迁移（`crates/db/migrations/`），`sessions` 表（[session.rs](../../../crates/db/src/models/session.rs)）。
- 类型生成：Rust → `shared/types.ts`（[generate_types.rs](../../../src-tauri/src/bin/generate_types.rs)）。

---

## 3. Tech Stack

- **后端**：Rust（workspace 多 crate）；tokio（current-thread 用于 companion，多线程用于主进程）；sqlx 0.8（SQLite）；serde / serde_json；thiserror；uuid；`agent-client-protocol`（ACP）。
- **传输**：companion ↔ 主进程走 **UDS（Unix）/ 命名管道（Windows）**，长度前缀 UTF-8 JSON 帧（16MiB 上限）。
- **前端**：React + TypeScript + Vite；Tauri v2 IPC（`tauriInvoke`/`tauriListen`）。
- **打包**：companion 二进制作为 **Tauri sidecar**（`externalBin`）随应用分发。

---

## 4. 架构设计

### 4.1 总览数据流

```
ClaudeCode LLM ─ ToolUse(delegate_to_agent / get_delegation_status / cancel_delegation
                          / ask_user_question / check_user_feedback)
        │ stdio (MCP)
        ▼
   vibex-mcp（companion 二进制，每次父会话启动一个）
        │ UDS / 命名管道（per-launch token 鉴权，长度前缀 JSON 帧）
        ▼
   DelegationListener ──► DelegationBroker（进程内，主应用）
                              │ ConnectionSpawner trait
                              ▼
                     AgentRuntime.connect() + send_prompt()  ── PromptFinished ──┐
                              │                                                   │
   前端委派卡片 ◄── Tauri agent-events（DelegationStarted/Completed）◄────────────┘
   ClaudeCode LLM ◄── MCP tool_result ◄── DelegationTaskReport ◄─────────────────┘
```

### 4.2 模块拆分（提议结构，crate 边界细节见 §11）

```
crates/delegation/                  # 进程内 broker + traits + 传输 listener（纯逻辑，全 trait 解耦，可单测）
  src/
    lib.rs
    types.rs            # DelegationRequest/Outcome/Error, TaskStatus, DelegationTaskReport, DelegationMatchKey
    broker.rs           # DelegationBroker：异步状态机、结果缓存、并行关联、竞态裁决
    depth.rs            # 委派深度 walker（泛型 parent_resolver）
    spawner.rs          # ConnectionSpawner trait（spawn / send_prompt_linked / cancel / disconnect）
    transport.rs        # 线丝类型 BrokerMessage/Request/Response + 帧编解码（companion 与 listener 共享）
    listener.rs         # UDS/管道服务端：token 校验、解析父会话、转交 broker；steering 的 feedback/ask 处理
    meta_writer.rs      # DelegationMetaWriter trait：把委派状态写到父工具调用 meta
    event_emitter.rs    # DelegationEventEmitter trait：发 DelegationStarted/Completed 到父事件流
    config.rs           # DelegationConfig（enabled / depth_limit / cache 上限 / 按 agent 默认值）

crates/vibex-mcp/                   # companion 二进制（最小依赖；依赖 delegation 的 transport 模块）
  src/main.rs           # stdio MCP server：initialize/tools.list/tools.call/notifications.cancelled；
                        #   --parent-connection-id --socket-path --token --parent-pid --features
  tool_schema.json      # 5 个工具的 inputSchema

src-tauri/src/delegation/           # 把 broker 接到真实 VibeX（trait 具体实现 + 注入 + 命令）
  mod.rs
  spawner_impl.rs       # ConnectionSpawner over AgentRuntime（connect + send_prompt + 监听 PromptFinished）
  lookups.rs            # DepthLookup / ChildStatusLookup over crates/db
  meta_emitter_impl.rs  # MetaWriter + EventEmitter over Tauri 事件/DB
  injection.rs          # 把 vibex-mcp 写进 ClaudeCode 的 MCP 配置文件 + token 注册/吊销
  commands.rs           # Tauri 命令：读写 DelegationConfig（启停、深度）等

crates/agents/src/manager.rs        # spawn 路径：注入 companion 前置钩子 + 解析委派链接持久化
crates/db/migrations/<ts>_delegation_columns.sql   # sessions 加列
frontend/src/features/delegation/   # 前端：context + 卡片 + 状态解析 + 打开子会话
```

### 4.3 MCP 注入（**ACP `session/new` 的 mcp_servers 参数**）

> **已核验**（2026-06-14）：`agent-client-protocol` 0.11.1 的 `NewSessionRequest` 有公开字段 `mcp_servers: Vec<McpServer>`，包含 `McpServer::Stdio` 变体。通过该字段传入 companion 可实现**按会话隔离、内存内、随会话生灭**的注入，无需写配置文件。
>
> 当前 VibeX 在 [manager.rs:951](../../../crates/agents/src/manager.rs#L951) 调用 `NewSessionRequest::new(cwd)` 时尚未填充 `mcp_servers`。无需 cwd 级 `.mcp.json`；`session/new` 的 `mcpServers` 天然按会话隔离，可规避陈旧 token、共享文件并发和 teardown 清理问题。

spawn ClaudeCode 的 `new_acp_session` 路径（[manager.rs:945-962](../../../crates/agents/src/manager.rs#L945)）增强为：

1. 用 `locate_vibex_mcp_binary()` 定位 companion（env 覆盖 `VIBEX_MCP_BIN` → 可执行同级 → PATH）。
2. mint 一个 per-launch UUID `token`，注册进 `TokenRegistry { token → (parent_connection_id, working_dir) }`。
3. 构造一条 companion server（仅当父 agent 是 ClaudeCode 且至少一项功能开启时）：
   ```rust
   let companion = McpServerStdio::new("vibex-mcp", vibex_mcp_bin)
       .args(["--parent-connection-id", conn_id, "--socket-path", sock,
              "--token", token, "--parent-pid", &pid, "--features", "delegation,feedback,ask"]);
   let mut servers = vec![]; // v1 仅注入 companion；后续可并入用户 MCP servers
   servers.push(McpServer::Stdio(companion));
   let req = NewSessionRequest::new(cwd).mcp_servers(servers); // ← 关键改动
   ```
4. ClaudeCode 启动后以 stdio 连 companion，companion 用 `--socket-path/--token` 回连主进程 listener。
5. teardown（父连接断开）：**只需吊销 token**（server 列表随会话消亡，无文件需清理）。

### 4.4 传输与鉴权

- 长度前缀（u32 LE）+ JSON body，16MiB 上限；非换行分隔以保留 `task` 内换行。
- `BrokerMessage` 枚举：`Call`（delegate）/`Status`/`CancelTask`/`Cancel`（MCP notifications/cancelled）/`Feedback`/`CommitFeedback`/`Ask`。每条带 `token`。
- listener 校验 token + `parent_connection_id` 一致，再解析父会话当前 conversation/session，转交 broker。
- Windows 命名管道：服务当前连接前先重绑下个实例，避免客户端 `NotFound` 间隙；companion 侧带 200ms 重试预算。

### 4.5 Broker（异步状态机）

- 单 `Mutex<PendingInner>` 串行化全部状态：`running`/`completed`(按 parent FIFO 字节上限驱逐) / `setups`(setup 窗口预留) / `early_completes`/`early_cancels`(竞态缓冲) / 单调 `seq`(到达序号戳)。
- 任务状态机：`Running → Completed/Failed/Canceled`，`running↔completed` 原子迁移。
- 并行 fan-out 关联：用确定性键 `DelegationMatchKey{ agent_type, task, working_dir }` 把 ACP 侧 tool_call 与 MCP 侧 call 绑定，而非脆弱的到达顺序。
- 竞态裁决：setup 窗口内子任务先完成 / 父取消 / MCP cancel 早到，统一用「到达序号戳 + first-terminal-wins」在单锁下裁决。
- stop_reason 映射：VibeX `PromptFinished.stop_reason: Option<String>`（`"end_turn"`/`"cancelled"`/…）映射到 `DelegationError`（child_refusal/child_max_tokens/child_empty/…），需建立字符串 → 错误码映射表（见 §11）。
- 缓存常量：每 parent 512MB FIFO；单结果文本截断 256KiB；status 预览 2KiB。

### 4.6 ConnectionSpawner 实现（接 AgentRuntime）

`spawner_impl.rs` 把 `ConnectionSpawner` trait 接到 VibeX：
- `spawn(parent_connection_id, agent_type, working_dir, …) -> child_connection_id`：调 `AgentRuntime.connect(ConnectAgentInput{…})` + `new_session`，继承父的 workspace_id/working_dir。
- `send_prompt_linked(conn_id, task, link) -> child_session_id(i)`：`AgentRuntime.send_prompt`，并把 `DelegationLink{ parent_session_id, parent_tool_use_id, delegation_call_id }` 持久化到子 session 行。
- turn 完成：订阅 `AgentEvent::PromptFinished` 过滤本 child_connection_id，回调 broker `complete_call`。
- `cancel`/`disconnect`：对应 runtime 的中断/断开。

### 4.7 数据库

新增迁移 `crates/db/migrations/<YYYYMMDDhhmmss>_delegation_columns.sql`（沿用现有命名/索引约定）：
```sql
ALTER TABLE sessions ADD COLUMN parent_session_id   BLOB;      -- FK→sessions.id（子→父）
ALTER TABLE sessions ADD COLUMN parent_tool_use_id  TEXT;      -- 父 delegate_to_agent 工具调用 id（UI 查找键）
ALTER TABLE sessions ADD COLUMN delegation_call_id  TEXT;      -- broker 内部 task UUID（状态回落查询键）
CREATE INDEX idx_sessions_parent_session_id  ON sessions(parent_session_id)  WHERE parent_session_id  IS NOT NULL;
CREATE INDEX idx_sessions_delegation_call_id ON sessions(delegation_call_id) WHERE delegation_call_id IS NOT NULL;
```
- `session.rs` 模型加三字段 + `create_with_delegation()` + `find_by_delegation_call_id()`（缓存驱逐后的状态回落）。
- 子 session 是一等公民（独立行），既内联在父消息看，也能整会话打开。

### 4.8 前端（完整内联卡片）

- `features/delegation/delegation-context.tsx`：根级订阅 `agent-events`，把 `DelegationStarted/Completed` 映射成 `Map<parent_tool_use_id, DelegationBinding{ childSessionId, agentType, status, errorCode }>`，作为 UI 单一真相源；完成后 2s 宽限再 detach。
- `ToolCallCard.tsx` 新增分支：按 tool_name 识别 `delegate_to_agent` → `DelegateToAgentToolCard`（沿用现有 `ask_question`/`feedback_check` 的正则识别套路，**无需新增后端 ActionType**）。卡片显示：子 agent 图标 + 任务 + 状态徽章 +「打开子会话」按钮（用 [useNavigateWithSearch](../../../frontend/src/hooks/useNavigateWithSearch.ts) 跳到子 session 路由）。
- `get_delegation_status`/`cancel_delegation` 结果与 steering 的 `ask_user_question`/`check_user_feedback` 卡片复用既有识别（后两者前端卡片已存在，仅需补 broker 端逻辑 + 用户回答/插话的输入 UI）。
- 状态多级回落：实时 binding → 持久化 meta → 解析 tool input/output。
- 新增/变更的 Rust 类型经 `generate_types` 同步到 `shared/types.ts`。

### 4.9 Steering 工具（ask / feedback）

- `check_user_feedback`：broker 端维护 per-parent 未读插话队列；listener 读取后由 companion「先回包、回包成功后再 commit」保证至少一次投递。需要前端一个**插话输入入口**（在父会话工作时可输入，落库进队列）。
- `ask_user_question`：listener 注册问题（广播卡片）→ 阻塞等用户作答 → 回传 companion。前端已有结果卡片，需补**作答交互**（卡片可选并提交）。

---

## 5. Commands

```bash
# 安装依赖（worktree 内，pnpm workspace）
pnpm install

# 类型生成（Rust → shared/types.ts）
pnpm --filter <ws> run generate-types        # 或 cargo run --bin generate_types（待确认脚本名）

# 后端编译/测试
cargo build
cargo test -p delegation                     # broker 纯逻辑单测（trait mock）
cargo test -p agents                          # spawner/注入相关
cargo test --workspace

# 前端
pnpm --filter frontend run lint
pnpm --filter frontend run test
pnpm --filter frontend run build

# 跑应用（验证端到端）
pnpm tauri dev
```
> 注：具体脚本名以 worktree 内 `package.json` / `Cargo.toml` 为准，Plan 阶段核对。

---

## 6. Project Structure

见 §4.2。新增：`crates/delegation/`、`crates/vibex-mcp/`、`src-tauri/src/delegation/`、`frontend/src/features/delegation/`、一条 DB 迁移。改动：`crates/agents/src/manager.rs`（spawn 注入钩子）、`src-tauri/tauri.conf.json`（sidecar）、`ToolCallCard.tsx`（卡片分发）、`shared/types.ts`（生成）。

---

## 7. Code Style

遵循仓库现有风格（自动检测，注释语言与所在文件一致）。Rust 侧示例：

```rust
/// Spawns child ACP sessions on behalf of a `delegate_to_agent` call.
/// Implemented in src-tauri over `AgentRuntime`; mocked in broker unit tests.
#[async_trait]
pub trait ConnectionSpawner: Send + Sync {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: Option<String>,
    ) -> Result<String, SpawnerError>;

    async fn send_prompt_linked(
        &self,
        conn_id: &str,
        task: String,
        link: DelegationLink,
    ) -> Result<i64, SpawnerError>;

    async fn cancel(&self, conn_id: &str) -> Result<(), SpawnerError>;
    async fn disconnect(&self, conn_id: &str) -> Result<(), SpawnerError>;
}
```
约定：线丝可见的字符串（`TaskStatus`、错误 `code`）一律 snake_case 且**稳定不改名**（进 LLM 上下文与前端）。

---

## 8. Testing Strategy

| 层级 | 范围 | 位置 |
|------|------|------|
| 单元（Rust） | broker 状态机：注册/完成/取消、缓存驱逐、深度计算、并行关联键、setup 窗口竞态（使用 mock spawner/lookup）| `crates/delegation/src/*.rs` `#[cfg(test)]` |
| 单元（Rust） | transport 帧编解码、token 校验、stop_reason→error 映射 | 同上 |
| 集成（Rust） | spawner_impl 真起子 session（或 fake runtime）、DB 迁移 + `find_by_delegation_call_id` | `crates/delegation/tests/`、`crates/db` |
| 前端单元 | 状态解析多级回落、卡片渲染（running/ok/err）、context reduce | `frontend/src/features/delegation/*.test.tsx` |
| 端到端（手动 v1） | ClaudeCode 真派发一个子 agent → 卡片显示 → 打开子会话 → 取消 | `pnpm tauri dev` 手验，记录步骤 |

覆盖期望：broker 核心逻辑（状态迁移、竞态、关联）优先达到高覆盖；注入/前端以关键路径为主。

---

## 9. Success Criteria（具体可测）

1. **派发**：ClaudeCode 会话中模型调用 `delegate_to_agent(agent_type, task)`，立即返回含 `task_id` 的 running ack（不阻塞），子 session 在 DB 落行且 `parent_session_id` 指向父。
2. **并行**：父一次性发 ≥2 个委派，各自独立绑定到正确的父工具调用卡片（关联键正确，不串卡）。
3. **收集**：`get_delegation_status([ids], wait_ms)` 能批量返回；`wait_ms>0` 在任一任务终态时返回，封顶 60s；驱逐后能从 DB 回落出状态。
4. **取消**：`cancel_delegation(task_id)` 终止运行中的子 agent 并拆除；已完成则返回结果。
5. **深度**：超过 `depth_limit` 的再委派被拒（`depth_limit` 错误码）。
6. **前端**：父消息内联渲染委派卡片（子 agent 图标 + 任务 + 状态徽章），点击可打开子会话查看完整过程；刷新后能从持久化 meta 重建卡片。
7. **steering**：运行中用户输入插话能被 `check_user_feedback` 读到；`ask_user_question` 弹卡片并阻塞，用户作答后模型收到结构化答案。
8. **隔离/清理**：companion 仅经 `session/new` 的 `mcp_servers` 按会话注入（不写用户配置文件）；父会话结束后 token 被吊销，companion 随会话消亡。
9. **测试**：`cargo test -p delegation` 全绿；前端委派相关测试全绿；端到端手验清单通过。

---

## 10. Boundaries

- **Always（总是）**：
  - 改动前先读现有代码；新类型经 `generate_types` 同步前端。
  - 提交前跑 `cargo test -p delegation` 与前端 lint/test。
  - companion 经 `session/new` 的 `mcp_servers` 按会话注入（不碰用户配置文件）；teardown 吊销 token。
  - 线丝字符串（status/error code）保持稳定。
- **Ask first（先问）**：
  - DB schema 变更（本 spec 的迁移已获批；后续再加列需确认）。
  - 新增第三方依赖 / 新 crate / 改 CI。
  - 父 agent 范围扩展到 ClaudeCode 以外、或改注入机制。
  - 改动 `crates/agents` spawn 主路径中与委派无关的部分。
- **Never（绝不）**：
  - 提交密钥；删除/跳过失败测试而不说明。
  - 未经允许执行 `git commit`/`push`/分支操作（遵循全局约定）。
  - 把 per-launch token 硬编码或写入版本库。

---

## 11. Open Questions（待 Plan 阶段解决）

1. ~~**Crate 边界**~~ ✅ **已解决**（见 [plan.md](./plan.md) A1）：抽极小的 `crates/delegation-proto` 装线丝类型，companion 与 broker 共享；companion 不依赖 broker/agents。
2. ~~**stop_reason 映射**~~ ✅ **已解决**（见 plan.md A2）：真实 turn = `format!("{:?}", acp::StopReason)`（PascalCase）+ 少量硬编码 snake 字面量；broker 用大小写/下划线容错归一化映射，`ChildUnknown` 兜底，实现期 pin 一次实际变体集合。
3. ~~**ClaudeCode 配置隔离**~~ ✅ **已解决**：ACP `session/new` 的 `mcp_servers` 参数按会话天然隔离，VibeX 的 `agent-client-protocol` 0.11.1 已支持。无需 cwd 级 `.mcp.json`。见 §4.3。
4. **companion 二进制构建/分发**：新 crate `[[bin]]` + `tauri.conf.json` `externalBin` sidecar；多平台命名（`vibex-mcp-<target-triple>`）与 dev 时 `VIBEX_MCP_BIN` 覆盖路径。
5. ~~**委派事件**~~ ✅ **已解决**（见 plan.md A3）：新增 `AgentEvent::DelegationStarted/Completed` 显式变体（`AgentEvent` 已是 `kind`+snake_case + ts-rs 导出，加变体地道），前端 reducer 加两个 case。
6. **steering 输入 UI**：插话输入入口放哪（会话输入框旁的「插话」？）、`ask_user_question` 作答卡片的提交交互——需与现有 UI 约定对齐。
7. **`generate-types` 实际命令名**与前端 workspace filter 名，按 worktree 配置核对。

---

## 12. 实施阶段预览（Phase 2 将细化）

1. **地基**：DB 迁移 + session 模型字段 + 深度查询。
2. **broker 纯逻辑**：`crates/delegation` 的 types/depth/broker/transport + 全套 trait + 单测（mock）。
3. **companion**：`crates/vibex-mcp` stdio MCP server + tool_schema + transport client；sidecar 打包。
4. **接线**：`src-tauri/src/delegation` 的 trait 实现（spawner/lookups/meta/event）+ listener 启动 + token 注册。
5. **注入**：`crates/agents` 的 `new_acp_session` 在 `session/new` 的 `mcp_servers` 里追加 companion（仅 ClaudeCode）+ token 注册/吊销。
6. **前端**：delegation context + 委派卡片 + 打开子会话 + steering 作答/插话 UI；`generate_types`。
7. **端到端验证 + 测试补全**。

> **门控**：本 spec 经评审通过后，方进入 Phase 2（Plan）。请审阅 §1 范围、§4 架构、§9 成功标准、§10 边界、§11 待决项，确认或提出修改。
