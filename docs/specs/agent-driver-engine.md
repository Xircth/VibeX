# VibeX Agent 驱动引擎规范（Agent Driver Engine Specification）

**状态:** Accepted & Implemented（Normative）  
**日期:** 2026-11-15  
**关联决策:** [ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md)（独立引擎优先、ACP 次选）、[ADR-0058](../adr/0058-session-auxiliary-capability-honesty.md)（辅助能力诚实原则）、[ADR-0082](../adr/0082-jsonl-transcript-window.md)、[ADR-0086](../adr/0086-conversation-binding-generations-and-history-segments.md)  
**适用范围:** `crates/agents`、`crates/conversations`、`crates/application`、`crates/utils`、`scripts/claude-native-driver.mjs`、`frontend` 会话渲染管线

---

## 1. 背景与设计目标

依据 [ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md)，VibeX 的 Agent 接入架构已确立为**「旗舰 Agent 独立原生引擎优先，长尾 Agent 走 ACP 兼容层次选」**。当前代码库已完成“2 + N”双轨统一接线与安全收口：

- `crates/agents/src/runtime.rs` 与 `crates/agents/src/manager/` 承载统一的运行时控制面、持久化挂起审批与生命周期管理；
- `crates/agents/src/engine/` 与 `scripts/claude-native-driver.mjs` 作为 `AgentConnectionRunner` 的旗舰原生执行后端正式接线，通过无损逐 Turn 路由、双向 JSON-RPC 2.0 帧分发、多实例隔离与 `ProcessTreeJob` 托管运行；
- 历史遗留的 `crates/executors/` 已冻结为仅保留被动历史配置反序列化与 `ScriptRequest`，并由架构门禁 `I5` 阻断任何新增编码 Agent 执行路径。

本规范结合工程实践与业内对标经验，定义 VibeX Agent 驱动引擎的**唯一权威架构、协议契约、安全隔离、流式性能与测试门禁标准**。

---

## 2. 总体架构与“2 + N”双轨路由规范

### 2.1 分层拓扑

VibeX **MUST** 保持唯一的运行时控制面与领域接缝，禁止出现“两套并行的 Agent 状态机”：

```text
  Desktop UI / Server API / Remote IM (Telegram·微信) / Workflow / Delegation MCP
                                        │
                                        ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ Layer 1: 控制面 (AgentRuntime + ConversationCore + SQLite Ledger)          │
  │ - Turn 终态机、输入排队、Steering、Pending 审批持久化、跨引擎 Handoff 账本  │
  │ - 多账号 ProviderInstance、Launch vs Served 模型/思考强度一致性核验        │
  └─────────────────────────────────────┬─────────────────────────────────────┘
                                        │ AgentConnectionCommand / AgentEvent
                                        ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ Layer 2: 统一连接路由与规范化层 (AgentConnectionManager / Runner)           │
  │ - 拓扑决议: ProfileTopology::NativeEngine 默认直连原生驱动                  │
  │ - 能力快照、配置漂移守卫、流式去重、用量归并、Stderr 写时脱敏               │
  └──────────────┬──────────────────────────────────────────┬─────────────────┘
                 │ (NativeEngine Default)                   │ (Long-tail / Registry ACP)
                 ▼                                          ▼
  ┌──────────────────────────────────────┐   ┌────────────────────────────────┐
  │ Layer 3A: 旗舰原生驱动                │   │ Layer 3B: 标准 ACP 通用驱动     │
  │ - ClaudeNativeDriver (Node SDK)      │   │ - AcpClientBridge (v1/v2)      │
  │ - CodexNativeDriver (Rust RPC)       │   │ - vendor.rs 最小方言补丁       │
  └──────────────┬───────────────────────┘   │ - Registry 动态发现与安装       │
                 │                           └────────────────┬───────────────┘
                 └─────────────────────┬──────────────────────┘
                                       ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ Layer 4: 进程树、隔离与安全底座                                            │
  │ - Per-Connection / Per-Turn Win32 JobObject                               │
  │ - Per-Instance 隔离 Home/Auth + 进程内 DPAPI + 写时脱敏 + 录包回放夹具     │
  └───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 规范条款

1. **单一运行时归口（MUST）**：`NativeEngineDriver`（`crates/agents/src/engine/`）**必须**作为 `AgentConnectionRunner` 的内部执行后端接入（与 `run_acp`、`run_in_memory` 平级），对上统一收口到 `AgentConnectionCommand` 与 `AgentEvent`。**禁止**为原生驱动在 `AgentRuntime` 之外另建独立的会话管理、审批通道或事件推送路径。
2. **“2 + N”双轨路由与原生全量切换（MUST）**：
   - **Claude Code（`claude_code`）与 Codex（`codex`）**：内置 Profile 声明 `ProfileTopology::NativeEngine`，默认直接路由至 `ClaudeNativeDriver`（托管 Node.js Sidecar `scripts/claude-native-driver.mjs` 直连 `@anthropic-ai/claude-agent-sdk`）与 `CodexNativeDriver`（纯 Rust JSON-RPC 2.0 客户端直连 `codex app-server`），无需安装或依赖任何 ACP 适配器；
   - **其余内置及社区 Registry Agent**（Gemini/Antigravity、Grok、Kimi、Qoder、OpenCode、Pi 等）：继续走 `agent-client-protocol` 标准 ACP 通道 + `manager/protocol/vendor.rs` 方言补丁；
   - **显式调试覆盖**：已完成原生默认切流，`VIBEX_ENGINE_MODE=acp` 仅作为手动配置了外部 ACP 二进制时的显式调试覆盖开关保留，常规安装与会话启动不再拉取或回退到 ACP 包装器。
3. **废弃旧执行器路径（MUST NOT）**：**禁止**在 `crates/executors/` 中新增任何编码 Agent 特性或协议适配。存量仍调用 `crates/executors/` 的模块**应当**分批迁入 `AgentRuntime` 后下线该 crate。

---

## 3. 控制面、审批安全与状态机规范

### 3.1 无锁 I/O 与事件/副作用分离

1. **禁止持锁跨 I/O（MUST NOT）**：`AgentRuntime`、`AgentConnectionRunner` 及 `ConversationCore` 更新内存投影或数据库状态时，**严禁**在持有 `RwLock`/`Mutex` 写锁期间执行异步通道发送、磁盘落盘或子进程 RPC 等待（参见 `crates/agents/src/runtime.rs` 对异步发射后移锁外的约束）。
2. **持久化挂起交互（MUST）**：权限审批（Permission）、提问（Elicitation）与计划审批（Plan Review）的待决请求**必须**具备持久化身份与会话绑定，确保桌面面板卸载、应用重启或通过外部 IM 通道（Telegram / 微信）远程应答时，与桌面端互斥消解同一请求且不丢失上下文。

### 3.2 后端不透明审批上下文（Opaque Approval Context）

1. **不信任前端载荷（MUST NOT）**：发起审批请求时，完整上下文（`permission_id` / `plan_id`、待执行工具集、允许路径范围、目标模式、当前 `revision`）**必须**保存在后端权威状态中；前端及 IM 通道回调时仅允许回传 `(request_id, decision, expected_revision)`。
2. **修订号校验（MUST）**：后端收到决策后**必须**校验 `expected_revision` 与当前挂起请求一致，防止旧审批弹窗或重复点击误放行已变更的后续工具调用。

### 3.3 Fail-Closed 能力门控与原子预检

1. **能力诚实声明（MUST）**：所有能力位（`steering`、`fork_session`、`revert_to`、Plan 审批、RateLimit 推送、Prompt Cache TTL）**必须**依据真实驱动能力与运行时握手结果显式区分 `Supported`、`Legacy` 与 `Unavailable`。
2. **禁止静默降级（MUST NOT）**：
   - 当连接不支持原生 `steer` 时，**禁止**将 `Steer` 请求静默改写为普通排队输入；
   - 当引擎无法定位历史 `ForkPoint` 或检查点时，**禁止**静默截断到会话尾部；
   - 当第三方代理或未知模型无法确认官方 Cache TTL 时，**必须**保持 `None`（对齐 `EngineAuth::is_official_anthropic_session` 与 [ADR-0058](../adr/0058-session-auxiliary-capability-honesty.md)）。
3. **跨引擎交接与回滚原子预检（MUST）**：
   - 执行跨引擎切换（`crates/conversations/src/handoff.rs`）或原子回退（`CheckpointRef::restore` + `NativeEngineDriver::revert_to`）前，**必须**先执行只读 **Preflight 预检**（目标引擎可达性、历史锚点/Git Ref 完整性、无冲突状态）；
   - 预检任一步失败时**必须**整体中止且不得改动工作区文件或绑定代次；仅在预检通过后按事务/补偿顺序提交，杜绝“代码树已回滚而引擎会话未回滚”的半残状态。

---

## 4. 原生旗舰引擎契约规范（Native Engine Driver Contract）

### 4.1 双向 JSON-RPC 2.0 帧路由

所有基于 stdio JSON-RPC 2.0 的驱动（包括 `CodexAppServer` 与 `ClaudeSidecarClient`）在 Reader Loop 中**必须**严格区分三类消息：

| 帧特征 | 语义分类 | 处理规范 |
| --- | --- | --- |
| 有 `id`、无 `method` | 本端发起 RPC 的响应 | 唤醒 `pending` 表对应 `oneshot`；若包含 `error` 对象，**必须**映射为 `Err(EngineError::Rpc { .. })`，严禁视为成功 |
| 有 `id`、有 `method` | **服务端主动发起的请求（ServerRequest）** | **必须**路由至服务端请求处理器（如 Codex `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`），挂起等待用户决策后按原 `id` 回写 `{ jsonrpc, id, result }` |
| 无 `id`、有 `method` | 单向事件通知（Notification） | 规范化为 `EngineEvent` 投递到事件流 |

- **方法名契约对齐（MUST）**：`CodexNativeDriver` 的历史回滚必须对接官方 `thread/rollback`（禁止使用未定义的方法名或对服务端审批请求反向发送伪造 RPC 并吞错）。

### 4.2 无损事件分发（Lossless Per-Turn Stream）

1. **禁用易丢消息的 `broadcast` 承接 Turn 流（MUST NOT）**：在 `ClaudeNativeDriver::send_prompt` 与 `CodexNativeDriver::send_prompt` 中，**禁止**直接将 `tokio::sync::broadcast::Receiver` 暴露为单 Turn 流并在 `recv().await` 遇到 `Lagged` 时静默退出循环（该缺陷会导致高频增量输出时丢失后续全部事件并永久遗漏 `TurnCompleted`）。
2. **有序路由通道（MUST）**：Reader Loop **应当**直接按 `(session_id, prompt_id)` 将事件投递至该 Turn 专用的 MPSC 通道（或经由支持溢出的 `BoundedRuntimeEventSink` 机制转发），保证单个 Turn 生命周期内事件严格有序且终态必达。

### 4.3 `Launch` vs `Served` 一致性核验

1. **双轨对照（MUST）**：在 `session_config_guard.rs` 防止初始化配置被服务端悄悄重置的基础上，每个 Turn 结束时（`end_turn_usage.rs` / 原生结果事件）**应当**将启动声明的 `(requested_model, requested_effort)` 与实际响应/Transcript 携带的 `served_model` 进行比对（解析 `opus`/`sonnet` 等别名）。
2. **静默降级告警（SHOULD）**：当使用自定义中转 `base_url` 且检测到实际服务模型与请求模型不匹配时，控制面**应当**记录诊断标记并向 UI 暴露非阻塞一致性提示。

---

## 5. 多实例隔离、进程树托管与安全规范

### 5.1 Driver 与 Instance 解耦

1. **进程复用键（MUST）**：长驻引擎服务端（如 `CodexAppServer`）的复用索引**必须**由 `(workspace_id, provider_instance_id, auth_fingerprint)` 共同构成，**禁止**仅以 `workspace_id` 作为唯一键全局共享进程，防止同一工作区下切换不同账号实例或自定义代理端点时发生凭据与上下文串台。
2. **账号目录隔离（MUST）**：不同 `ProviderInstanceConfig` 实例启动子进程时，**必须**分配各自隔离的配置/缓存根路径（如独立的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 及 `runtime_temp` 目录），避免互相覆盖本地 auth/session 状态。

### 5.2 全链路 OS 级进程树托管

1. **统一受控拉起（MUST）**：所有 ACP 进程、Claude Node Sidecar、`codex app-server` 以及 `AgentTerminalRegistry` 托管的长期终端，**必须**统一经由 `crates/utils/src/process.rs` 的 `group_spawn_no_window` 拉起（Windows 携带 `CREATE_NO_WINDOW`）。
2. **Per-Connection / Per-Turn 子 Job Object（MUST）**：
   - 除了进程级保底 `GUARDIAN_JOB`（防止 VibeX 崩溃时遗留孤儿）外，每个活跃连接或可单独取消的终端会话**必须**绑定独立可关闭的 Win32 Job Object（配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）；
   - 取消 Turn、断开连接或释放终端时，通过 `TerminateJobObject` + `CloseHandle` 由内核一次性终结整棵进程树，**禁止**仅依赖易被中间 shell 退出绕过的用户态 PID 树遍历（如 `kill_tree`）作为唯一清理手段。

### 5.3 凭据解析与写时脱敏

1. **进程内原生 DPAPI（MUST）**：Windows 平台读取或写入 `.dpapi` 本地凭据（`crates/agents/src/secret_resolution.rs`）**必须**直接通过 `windows-sys` 在宿主进程内调用 `CryptUnprotectData` / `CryptProtectData`，**禁止**每次拉起隐藏 `powershell.exe` 子进程执行脚本（规避数百毫秒延迟与企业 EDR 拦截）。
2. **最小凭据暴露面（SHOULD）**：对于支持私有配置文件或短时文件注入的引擎，优先将凭据写入仅当前用户可读（`0600`）的临时私有目录并于连接关闭时清理，减少敏感 Token 长期驻留在子进程全局环境变量继承链中。
3. **写时脱敏与载荷封顶（MUST）**：所有 Native 与 ACP 引擎的 `stderr` 及诊断错误载荷，**必须**在写入缓冲区前通过 `crates/agents/src/stderr_tail.rs`（`StderrTail`）完成 ANSI 剥离、正则凭据脱敏（`<redacted>`）与字节上限裁剪（原始诊断摘要与异常载荷保持有界，单条错误载荷不超过 64 KiB），内存与事件日志中**严禁**留存明文密钥。

---

## 6. 流式吞吐与前端渲染规范

1. **16ms / 高水位合批（SHOULD）**：`crates/conversations/src/live_coalescer.rs`（`LiveRowOpCoalescer`）的流式合批窗口**应当**从 `50ms` 收窄至 **`16ms`**（匹配 60 FPS 刷新率），并保留字节数/操作数高水位提前刷出与终态 Barrier（`TurnCompleted`、`Delete`、`reset: true`）零延迟直通。
2. **尾部平滑与闭合围栏高亮缓存（SHOULD）**：`frontend/src/components/NormalizedConversation/AstryxMarkdown.tsx` 在流式渲染长 Markdown 时，**应当**仅对**已闭合**的代码围栏执行语法高亮并写入 LRU 缓存；末尾仍在流式追加的未闭合代码块先以纯文本增量渲染，闭合后再触发一次高亮并入缓存，防止长代码块生成阶段每帧重复分词导致的 UI 掉帧。

---

## 7. 协议契约测试与工程门禁规范

1. **真实录包回放基座（MUST）**：为 `ClaudeNativeDriver`、`CodexNativeDriver` 与 ACP `AgentConnectionRunner` 统一维护**基于真实 CLI 线协议录制的 Golden JSONL Fixtures**，并在 `tokio::io::duplex` 内存双工流下完成无外部网络依赖的回归测试，覆盖：
   - 握手与能力协商（含 `VIBEX_ENGINE_MODE` 路由切换）；
   - Turn 正常完成、高频 delta 压力（验证无 `Lagged` 丢帧）、空响应附带脱敏 `stderr`；
   - **服务端发起的双向审批/提问请求与 `revision` 校验**；
   - `steer`、`fork_session`、`revert_to` 与 `CheckpointRef` 协同回滚；
   - 子进程异常退出、超时中断与 Job Object 进程树回收。
2. **全量错误汇报（MUST）**：任何契约校验测试与夹具检查工具在遇到违规项时**必须**遍历全量集合后一次性报告所有失败点，禁止 fail-fast 在首个错误处中断。
3. **变更与文档预算（MUST）**：新增校验逻辑直接集成到现有 `cargo test` 单元/集成测试与既有检查套件中，保持单文件不超过 1,500 行；不私自引入额外独立治理脚本或冗余包装层。

---

## 8. 分阶段落地路线（Implementation Roadmap）

| 阶段 | 核心交付物 | 验收标准 |
| --- | --- | --- |
| **Phase 1：接线与核心缺陷修复** | 1. 将 `engine/` 模块正式接入 `crates/agents/src/lib.rs` 与 `AgentConnectionRunner`；<br>2. 修复 `CodexAppServer` 双向审批 Request 路由与 `thread/rollback` 方法名；<br>3. 将 Native `send_prompt` 由 `broadcast` 替换为无损 MPSC 流。 | `VIBEX_ENGINE_MODE=native` 可完整跑通 Claude / Codex 的对话、审批、中断、Steer、Fork 与 Revert 端到端闭环。 |
| **Phase 2：隔离、进程托管与安全加固** | 1. 连接缓存键升级为 `(workspace_id, provider_instance_id, auth_fingerprint)` 与独立 Home 目录；<br>2. Per-Connection/Terminal 子 Job Object 上线并替换 `kill_tree`；<br>3. `secret_resolution.rs` 移除 `powershell.exe` 改用进程内 `CryptUnprotectData`；Native `stderr` 全量接入 `StderrTail`。 | Windows 下取消或重启会话无残留子进程；多账号并发切换零串台；安全扫描与诊断日志无明文密钥、无 PowerShell 弹窗/拦截。 |
| **Phase 3：契约测试、旧路径收口与渲染调优** | 1. 补齐 Native 双工录包回放夹具测试；<br>2. 迁移并下线 `crates/executors/` 剩余编码 Agent 路径；<br>3. `LiveRowOpCoalescer` 调优至 `16ms` + 前端未闭合代码块降级高亮。 | 协议升级靠 CI 夹具即可秒级验证；代码库仅剩单一 `AgentRuntime` 引擎边界；60 FPS 流式生成不卡顿。 |
