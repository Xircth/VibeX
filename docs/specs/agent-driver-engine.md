# Dimo Agent 驱动引擎标准设计规范（Agent Driver Engine Specification v2.0）

**状态:** Accepted & Normative（v2.0 — 插件化统一原生引擎架构）  
**日期:** 2026-11-15  
**关联决策:** [ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md)（独立引擎优先、ACP 次选）、[ADR-0058](../adr/0058-session-auxiliary-capability-honesty.md)（辅助能力诚实原则）、[ADR-0082](../adr/0082-jsonl-transcript-window.md)、[ADR-0086](../adr/0086-conversation-binding-generations-and-history-segments.md)  
**适用范围:** `crates/agents`、`crates/conversations`、`crates/application`、`crates/server`、`crates/utils`、`scripts/claude-native-*.mjs`、`frontend` 会话控制与渲染管线

---

## 1. 背景与演进目标

依据 [ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md)，Dimo 的 Agent 接入策略已确立为**「核心 Agent 原生引擎优先，长尾 Agent 走 ACP 兼容层次选」**。在 `claude_code`（`ClaudeNativeDriver`）与 `codex`（`CodexNativeDriver`）完成原生接入后，为支持后续将其他主力 Agent（如 `opencode`、`pi`、`kimi_code` 等）**逐个平滑迁移为原生引擎**而不导致编排层膨胀、特判扩散或引入跨引擎回归，本规范定义 Dimo 原生引擎体系的**唯一权威架构边界、驱动契约、注册表路由、隔离语义、流式安全与新引擎准入门禁**。

设计核心信条：
- **编排层零供应商分支（Zero-Branch Control Plane）**：会话编排器只依赖 `NativeEngineDriver` 契约与能力声明，禁止按枚举值或供应商名字写死分支。
- **驱动与实例严格分离（Driver vs Instance Separation）**：驱动负责无状态/池化的协议实现；账号、凭据、环境隔离与配置文件指纹绑定在 `EngineStartSpec` / 实例上下文中。
- **能力诚实与渐进迁移（Honest Capabilities & Incremental Onboarding）**：每个新原生引擎可独立接入 `EngineRegistry` 并通过录制回放夹具验证，不影响既有原生引擎与长尾 ACP 通道。

---

## 2. 四层插件化总体架构

### 2.1 分层拓扑

Dimo **MUST** 保持唯一的运行时控制面与领域接缝，禁止出现“多套并行 Agent 状态机”：

```text
  Desktop UI / Server API / Remote IM (Telegram·微信) / Workflow / Delegation MCP
                                        │
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ Layer 1: 控制面 (AgentRuntime + ConversationCore + SQLite Ledger)           │
  │ - Turn 终态机、输入排队、Steering、Pending 审批持久化、跨引擎 Handoff 账本  │
  │ - 能力目录缓存、Provider 变更通知（通过 EngineRegistry 广播失效）           │
  └─────────────────────────────────────┬───────────────────────────────────────┘
                                        │ AgentConnectionCommand / AgentEvent
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ Layer 2: 统一会话编排层 (AgentConnectionRunner — 零供应商特判)             │
  │ - 通过 EngineRegistry 动态解析驱动，读取 EngineCapabilities 构造会话控制    │
  │ - 统一管理会话状态、流式去重、用量归并、审批 revision 校验与 Turn 生命周期   │
  └──────────────┬──────────────────────────────────────────────┬───────────────┘
                 │ (Native Engine Registry Match)               │ (Long-tail ACP)
                 ▼                                              ▼
  ┌──────────────────────────────────────────┐   ┌──────────────────────────────┐
  │ Layer 3A: 可插拔原生引擎驱动层            │   │ Layer 3B: ACP 兼容通道        │
  │  EngineRegistry (engine_id -> Driver)    │   │ - AcpClientBridge (v1/v2)    │
  │  ├─ ClaudeNativeDriver (claude-native)   │   │ - vendor.rs 方言适配          │
  │  ├─ CodexNativeDriver  (codex-native)    │   │ - 演进目标: GenericAcpAdapter │
  │  └─ [Future: OpenCode / Pi / ...]        │   └──────────────┬───────────────┘
  └──────────────┬───────────────────────────┘                  │
                 └──────────────────────┬───────────────────────┘
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ Layer 4: 引擎宿主与 OS 安全底座 (EngineHost / StreamRouter / ProcessTree)   │
  │ - Per-Connection / Per-Turn Win32 JobObject (`CREATE_NO_WINDOW`)            │
  │ - 按 isolate_profile 隔离 Home/Temp + 进程内 DPAPI + 写时脱敏 `StderrTail`  │
  │ - `ProviderNativeHomes` 事务投影与配置指纹失效联动                           │
  └─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心规范条款

1. **单一运行时归口（MUST）**：所有原生引擎驱动（`crates/agents/src/engine/`）**必须**实现 `NativeEngineDriver` Trait 并通过 `AgentConnectionRunner` 统一接入 `AgentRuntime`，对上仅通过 `AgentConnectionCommand` 与 `AgentEvent` 通信。
2. **禁止编排层供应商特判（MUST NOT）**：
   - `crates/agents/src/manager/runner/**` 与 `crates/agents/src/runtime.rs` 中**严禁**出现对 `NativeEngineKind`、特定 `engine_id` 或 `agent_id` 字符串的业务规则 `match`/`if` 分支；
   - 认证提取、默认模式/思考强度、可用命令、工具分类与 `_meta` 包装、问题回答结构编码、默认模型解析、别名等价校验、进程池缓存失效**必须**全部下沉为 `NativeEngineDriver` Trait 行为或由 `EngineCapabilities` 声明。
3. **注册表驱动路由（MUST）**：
   - 运行时引擎选择**必须**经由 `EngineRegistry`（`crates/agents/src/engine/registry.rs`）按 `agent_id`、Profile 策略与 `DIMO_ENGINE_MODE`（`acp` / `native` 灰度开关）完成解析；
   - 原生启动在握手前失败时，仅当存在明确的独立 ACP 适配器二进制且未强制 `native` 时，才允许回退至 `run_acp`；独立 `claude` / `codex` CLI 严禁被误当成 ACP stdio 服务启动。
4. **废弃旧执行器路径（MUST NOT）**：**禁止**在 `crates/executors/` 中新增任何编码 Agent 特性或协议适配；该 crate 保持冻结状态并由架构门禁阻断回归。

---

## 3. 标准驱动契约（`NativeEngineDriver` Contract v2）

### 3.1 职责边界矩阵

| 关注点 | 控制面 / `Runner` 职责（协议无关） | `NativeEngineDriver` 职责（引擎自包含） |
| --- | --- | --- |
| **身份与发现** | 调用 `EngineRegistry::resolve_driver_for_agent` 获取驱动句柄 | 声明 `engine_id()`、`supports_agent(agent_id)`、`descriptor()` |
| **能力与控制面** | 读取 `driver.capabilities()`，生成统一 `SessionModeState` 与 `config_options` | 提供 `EngineCapabilities`（`modes`、`yolo_mode_id`、`effort`、`default_commands`、能力开关）与 `normalize_mode()` |
| **默认模型与别名** | 在启动/回合结束后触发一致性检查 | `resolve_default_model(env)` 读取原生配置；`model_aliases(env)` 声明合法映射目标 |
| **启动环境与鉴权** | 汇总代理环境变量、工作目录、授权裁剪键集合 | `resolve_auth(env)` 解析凭据类型；`prepare_launch_env()` 注入引擎可执行路径并清洗冲突密钥；`profile_isolation_dir()` 声明隔离目录名 |
| **事件与工具规范化** | 维护 Turn 生命周期、增量去重与 UI 事件转发 | `classify_tool_call()` 产出语义类型与厂商可选 `_meta`；驱动内部完成协议事件到 `EngineEvent` 的无损翻译 |
| **交互应答** | 持有 `PendingPermission` / `PendingElicitation` 与 `revision` 校验 | `encode_question_answers()` 按上游协议要求编码答案（例如按问题文本或 `question_id` 键控）；`respond_permission()` 回写协议响应 |
| **用量与缓存活动** | 当 `capabilities().records_idle_compaction_activity == true` 时记录缓存到期 | 解析并上报 `RateLimitsUpdated`、`CacheStatusUpdated`（非官方代理保持 `None`） |
| **缓存与进程池失效** | `AgentRuntime::mark_agent_sessions_config_stale` 统一通知注册表 | `invalidate_engine_caches_for_agent(agent_id)` 经由 `EngineRegistry::invalidate_agent(agent_id)` 调用驱动 `invalidate_caches()` 清理长驻子进程池 |

### 3.2 关键语义铁律

1. **哨兵值与自定义选项诚实原则（MUST）**：
   - 仅当驱动或当前模型支持对应配置项时才暴露给控制面；
   - `default` / `auto` 等仅用于宿主“跟随原生默认”语义的哨兵值，除非上游驱动明确支持，否则**不得**在模型未宣称时作为字面模型 ID 强传给上游 CLI；
   - 交互弹窗选项保留原始 `option_id` / `question_id` 往返，禁止在通用编排层反向猜键。
2. **非官方端点的能力诚实约束（MUST）**：
   - `EngineAuth::is_official_anthropic_session` 等官方基础设施校验为硬约束：使用第三方代理或自定义 `base_url` 时，**必须**将官方专属缓存 TTL 状态保持为 `None`（对齐 [ADR-0058](../adr/0058-session-auxiliary-capability-honesty.md)）。
   - `Launch` vs `Served` 模型一致性校验在比对前**必须**经由驱动 `model_aliases(env)` 解析用户配置别名（如 `ANTHROPIC_DEFAULT_SONNET_MODEL` 或网关自定义路由模型名），防止合法别名映射触发虚假告警或向时间线泄漏冗余 `model_consistency_mismatch` 系统提示。
3. **凭据互斥与默认目录保护（MUST）**：
   - 同一驱动进程环境内不得同时注入彼此冲突的认证头环境变量（例如 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 冲突时必须明确择优或屏蔽宿主机残留键）；
   - 默认模式（`isolate_profile = false`）下**不得**覆盖用户原生配置目录（`~/.claude`、`~/.codex` 等），保证用户原有的认证态、自定义模型目录与别名直接生效；仅当显式启用实例隔离（如 `DIMO_ISOLATE_PROVIDER_PROFILE=1`）时才重绑定独立根目录。
4. **结构化配置投影与过期产物清理（MUST）**：
   - `crates/server/src/host/native/model_providers/` 在切换或保存 Provider 原生配置时，若目标配置不再使用 Dimo 生成的结构化模型目录文件（如 `dimo-model-catalog.json` / `dimo-model-catalog.source.json`），**必须**在同一文件事务中清理旧目录引用并删除过期文件，随后触发 `mark_agent_sessions_config_stale` -> `invalidate_engine_caches_for_agent`。

---

## 4. 控制面、审批安全与状态机规范

### 4.1 无锁 I/O 与事件/副作用分离

1. **禁止持锁跨 I/O（MUST NOT）**：`AgentRuntime`、`AgentConnectionRunner` 及 `ConversationCore` 更新内存投影或数据库状态时，**严禁**在持有 `RwLock`/`Mutex` 写锁期间执行异步通道发送、磁盘落盘或子进程 RPC 等待；`TurnEventRouter` 等发布器在通知下游观察逻辑前**必须**先释放订阅表锁（防止锁嵌套死锁）。
2. **持久化挂起交互（MUST）**：权限审批（Permission）、提问（Elicitation）与计划审批（Plan Review）的待决请求**必须**具备持久化身份与会话绑定，确保桌面面板卸载、应用重启或通过外部 IM 通道远程应答时互斥消解同一请求且不丢失上下文。

### 4.2 后端不透明审批上下文（Opaque Approval Context）

1. **不信任前端载荷（MUST NOT）**：发起审批请求时，完整上下文（`permission_id` / `plan_id`、工具集、路径范围、目标模式、当前 `revision`）**必须**保存在后端权威状态中；前端及外部通道仅回传 `(request_id, decision, expected_revision)`。
2. **修订号校验（MUST）**：后端收到决策后**必须**校验 `expected_revision` 与当前挂起请求一致，防止过期弹窗误放行后续工具调用。

### 4.3 Fail-Closed 能力门控与原子预检

1. **禁止静默降级（MUST NOT）**：
   - 不支持原生 `steer` 时禁止静默改写为普通排队消息；
   - 无法定位 `ForkPoint` 或检查点时禁止静默截断到会话尾部；
2. **跨引擎交接与回滚原子预检（MUST）**：执行 Handoff 或原子回退前必须先做只读 Preflight 预检；任一步失败整体中止并保持工作区与绑定代次不变。

---

## 5. 原生协议通信与无损流式规范

### 5.1 双向 JSON-RPC 2.0 帧路由

所有基于 stdio JSON-RPC 2.0 的原生驱动（`ClaudeSidecarClient`、`CodexAppServer` 及后续同类 RPC 驱动）在 Reader Loop 中**必须**严格区分三类帧：

| 帧特征 | 语义分类 | 处理规范 |
| --- | --- | --- |
| 有 `id`、无 `method` | 本端发起 RPC 的响应 | 唤醒 `pending` 表对应 `oneshot`；若包含 `error` 对象，**必须**映射为 `Err(EngineError::Rpc { .. })`，严禁视为成功 |
| 有 `id`、有 `method` | **服务端主动请求（ServerRequest）** | 路由至服务端请求处理器，挂起等待用户决策后按原 `id` 回写 `{ jsonrpc, id, result }`；未实现方法返回标准 `-32601` 错误响应 |
| 无 `id`、有 `method` | 单向事件通知（Notification） | 规范化为 `EngineEvent` 经由无损路由器投递 |

### 5.2 无损事件分发（Lossless Per-Turn Stream）

1. **禁用易丢消息的 `broadcast` 承接 Turn 流（MUST NOT）**：在 `NativeEngineDriver::send_prompt` 返回单 Turn 事件流时，**禁止**将 `tokio::sync::broadcast::Receiver` 直接暴露并在 `Lagged` 时退出。
2. **有序 MPSC 路由（MUST）**：Reader Loop **必须**在发送 `prompt/send` 或 `turn/start` **之前**通过 `TurnEventRouter`（按 `prompt_id` 或 `session_id/thread_id`）注册 Turn 专用 MPSC 通道，保证高频增量突发时零丢帧且终态（`TurnCompleted` / `TurnInterrupted` / `TurnError`）必达。

### 5.3 模型发现与配置合并

1. 原生模型列表（`list_models`）**应当**按「宿主注入自定义列表 + 运行时服务/SDK 返回列表 + 原生用户配置文件（如 `settings.json` / `config.toml`） + 静默兜底列表」合并去重，并正确设置 `is_default`；
2. 用户配置的默认模型（`DIMO_DEFAULT_MODEL` / `ANTHROPIC_MODEL` / `config.toml model`）优先级高于静态默认标记，静态 `is_default` 优先级高于列表首项。

---

## 6. 多实例隔离、进程树托管与安全规范

### 6.1 进程复用键与目录隔离

1. **完整复用键（MUST）**：任何跨会话复用长驻引擎进程的缓存池（如 `CodexNativeDriver` 的 `global_codex_servers()`），其缓存键**必须**同时覆盖：
   - `workspace_id`
   - `provider_instance_id`
   - `auth_fingerprint`（SHA-256 摘要，不含明文密钥）
   - `native_config_fingerprint`（原生配置文件/目录/auth 文件内容摘要）
   确保同一工作区切换账号、切换网关或修改原生配置后自动起新进程而非复用陈旧实例。
2. **独立隔离根目录（MUST）**：当启用隔离（`spec.isolate_profile = true`）或配置独立临时目录时，按安全哈希段分配私密目录（Unix `0o700`），且**不得**在未显式请求时强行覆写宿主的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。

### 6.2 全链路 OS 级进程树托管

所有 Sidecar、App-Server 与 ACP 子进程**必须**经由 `crates/utils/src/process.rs` 的 `group_spawn_no_window_with_job` 拉起（Windows 携带 `CREATE_NO_WINDOW` 并绑定可关闭子 Win32 Job Object），关闭/取消时由内核一次性回收整棵进程树，并结合进程级 `GUARDIAN_JOB` 兜底。

### 6.3 凭据解析与写时脱敏

1. **进程内原生 DPAPI（MUST）**：Windows 凭据加解密直接在宿主进程调用 `CryptProtectData` / `CryptUnprotectData`，禁止拉起隐藏 `powershell.exe`；
2. **写时脱敏与载荷封顶（MUST）**：所有 `stderr` 与异常诊断文本在入队前**必须**经过 `StderrTail` 完成 ANSI 剥离、凭据正则脱敏（`<redacted>`）与 `MAX_DIAGNOSTIC_PAYLOAD_BYTES`（64 KiB）裁剪，日志与内存中禁止留存明文密钥。

---

## 7. 流式吞吐与前端渲染规范

1. **16ms / 高水位合批（SHOULD）**：`LiveRowOpCoalescer` 流式合批窗口维持 `16ms`，保留高水位提前刷出与终态 Barrier 零延迟直通。
2. **未闭合围栏降级渲染（SHOULD）**：流式长 Markdown 渲染仅对已闭合代码围栏做语法高亮并入 LRU 缓存，末尾未闭合围栏以纯文本增量输出。

---

## 8. 逐个原生引擎迁移标准与验收门禁（Onboarding Standard）

当需要将第 `N` 个 Agent（例如 `opencode`、`pi`、`kimi_code`）从 ACP 迁移为独立原生引擎时，**必须**完整满足以下 5 项准入门禁：

1. **独立 Driver 实现（MUST）**：
   - 在 `crates/agents/src/engine/<name>.rs`（以及可选的 `<name>_protocol.rs` / `<name>_tests.rs`）实现 `NativeEngineDriver`，单文件严格 ≤ 1,500 行；
   - **禁止**修改 `crates/agents/src/manager/runner/**` 或 `crates/agents/src/runtime.rs` 添加任何引擎分支。
2. **注册表与 Profile 对齐（MUST）**：
   - 将新驱动注册进 `EngineRegistry::bundled()`；
   - 更新对应 `BuiltInProfile` / `resolve_native_engine_kind_with_env`（或 `EngineRegistry` 路由解析），确保 `DIMO_ENGINE_MODE=acp` 仍支持灰度回退（仅当独立 ACP 二进制存在时）。
3. **打包与部署一致性（MUST）**：
   - 若新引擎依赖外部或随包分发的辅助脚本（如 Node sidecar），**必须**同步更新 `src-tauri/tauri.conf.json` 与 `scripts/package-host-family.js` 及其测试，保持开发环境与打包产物完全一致。
4. **配置指纹与缓存联动（MUST）**：
   - 明确声明驱动依赖的原生配置路径（同步更新 `capability_catalog.rs` 指纹与驱动 `invalidate_caches()`）；
   - 若涉及长驻进程池，必须在缓存键中包含配置指纹，避免切换配置后继续命中旧连接。
5. **契约测试与回放夹具门禁（MUST）**：
   - 在 `crates/agents/tests/native_engine_contract.rs` 或对应测试模块中补齐基于真实 CLI/SDK 线协议录制的双工（`tokio::io::duplex`）回放测试，至少覆盖：
     - 握手与能力声明（含 `isDefault` 模型、自定义网关、隔离/非隔离目录行为）；
     - 高频增量 Burst（≥ 2,500 条事件无丢帧、终态必达）；
     - 服务端主动发起的双向审批 / 用户提问（验证各自答案编码格式）与 `revision` 校验；
     - `steer` / `interrupt` / `fork_session` / `revert_to`；
     - 子进程异常退出时的 `stderr` 脱敏与 64 KiB 封顶，以及配置变更后的缓存失效。
   - **全量报告约束**：静态检查、夹具校验或结构验证工具发现多个违规时必须单次遍历并汇总输出全部缺陷，禁止 fail-fast。

---

## 9. 架构演进路线（Roadmap）

| 阶段 | 核心交付物 | 状态 |
| --- | --- | --- |
| **Phase 1–3：旗舰双原生引擎接线、安全加固与契约底座** | 1. `ClaudeNativeDriver` 与 `CodexNativeDriver` 正式接入 `AgentRuntime`；<br>2. 双向 JSON-RPC 2.0 帧路由、无损 MPSC `TurnEventRouter`、Win32 子 JobObject、进程内 DPAPI 与写时 `StderrTail`；<br>3. 修复多账号隔离目录、自定义网关模型发现、别名一致性核验、Codex 配置指纹失效与目录残留清理。 | 已完成 |
| **Phase 4：零分支控制面与可插拔 `EngineRegistry` 收口** | 1. 将 `modes` / `effort` / `commands` / `normalize_mode` / `resolve_default_model` / `resolve_auth` / `prepare_launch_env` / `classify_tool_call` / `encode_question_answers` / `model_aliases` / `invalidate_caches` 下沉为 `NativeEngineDriver` 标准契约；<br>2. 新增 `EngineRegistry` 统一注册与按 `agent_id` 广播失效；<br>3. 清除 `manager/runner/**` 与 `runtime.rs` 内所有供应商硬编码分支。 | 已完成 |
| **Phase 5：逐个 Agent 原生化迁移与 `GenericAcpAdapter` 收敛** | 1. 按收益优先级将 `opencode`（`opencode serve`）与 `pi`（`pi --mode rpc`）迁入 `EngineRegistry`；<br>2. 将 `run_acp` 及 `vendor.rs` 方言补丁收敛为 `GenericAcpAdapter`，使原生引擎与长尾 ACP 在同一运行时适配器接口下彻底合流。 | 规划演进 |
