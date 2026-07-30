# Design：统一插件能力、委派、自动化与远程运行

## 1. 第一性原理

四项功能共享五个不可替代的事实：

1. **用户意图必须先成为结构化数据。** Plugin action、`&Agent` Mention 和
   Automation 不能只靠提示词字符串推断。
2. **有副作用的执行只能有一个权威所有者。** 工具安装、Agent child process、
   Automation scheduler 和 preview process 都由 Application Core 侧运行时拥有。
3. **Turn 是统一执行单位。** 手动发送、委派和自动化最终都创建真实 Conversation/Turn，
   不建立“后台任务专用的第二套会话”。
4. **持久化事实与运行缓存必须分开。** Conversation events、安装锁和 AutomationRun
   可协调；内存 map、watch lease、WebSocket connection 只负责效率。
5. **客户端只是意图与投影。** Tauri、Web 和未来移动端不能各自实现业务状态机。

由此得到的优先级是：领域契约 → 安全安装/执行 → 持久事件 → transport → UI。不能从
设置页面开始倒推后端语义。

## 2. 目标模块

```text
crates/
  plugins/            manifest v2、PluginAction、依赖解析、就绪状态
  tool-runtime/       ToolDependency 安装/验证/版本锁/租约/清理
  artifacts/          Artifact 记录、Provider registry、preview lease
  delegation/         现有 Broker，补齐 Codeg parity
  delegation-proto/   companion 线丝协议
  vibex-mcp/           父会话 companion
  automation/         TurnLaunchSpec、Engine、claim/reconcile/isolation ports
  conversations/      真实 Turn 与事件日志（继续作为权威）
  application/        transport-neutral use-case facade 与 runtime composition ports
  remote-protocol/    v1 DTO、error envelope、capabilities、event subscription
  server/             Axum/static UI/WebSocket/vibex-server binary

src-tauri/
  commands/           Tauri adapters；不持有领域规则
  adapters/           Tauri event/window/CEF/desktop-only 实现

frontend/src/
  lib/transport/      BackendTransport、TauriTransport、WebTransport
  features/plugins/
  features/artifacts/
  features/delegation/
  features/automations/
  features/remote/
```

名称是目标责任边界，不要求一次性搬迁。每次只在一个行为切片需要时抽取；禁止先做无
行为变化的大规模目录搬家。

## 3. 插件与工具模型

### 3.1 Manifest v2

```json
{
  "$schema": "vibex-plugin/v2",
  "id": "vibex.office.presentation",
  "version": "1.0.0",
  "name": "Office Presentation",
  "builtin": true,
  "dependencies": [
    {
      "id": "officecli",
      "kind": "binary",
      "version": "0.8.0",
      "distributions": {
        "aarch64-apple-darwin": {
          "url": "https://…/officecli",
          "sha256": "…"
        }
      },
      "probe": ["--version"]
    }
  ],
  "skills": [
    {
      "id": "office-pptx",
      "source": "bundled",
      "path": "skills/office-pptx"
    }
  ],
  "actions": [
    {
      "id": "create-presentation",
      "label": "创建 PPT",
      "requiredSkills": ["office-pptx"],
      "requiredTools": ["officecli"],
      "promptBlocks": [
        {
          "type": "text",
          "text": "请先澄清目标受众和演示目标，然后创建 PPTX。"
        }
      ],
      "artifactIntent": {
        "mediaTypes": [
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        ],
        "provider": "officecli"
      }
    }
  ]
}
```

`builtin` 不从导入 manifest 信任，而由来源记录决定。manifest 输入先经过 schema
validation，再归一化为领域类型；工具分发选择使用平台三元组和确定性优先级。

### 3.2 状态分解

```text
PluginMembership  added / builtin / removed
PluginActivation  enabled / disabled
DependencyState   missing / installing / ready / failed / incompatible
SkillState        missing / ready / failed
ProviderState     unavailable / ready / degraded
PluginReadiness   由以上状态投影，不单独写真值
```

`PluginReadiness` 的错误列表必须可操作，例如“OfficeCLI 0.8.0 下载哈希不匹配”，不能
只显示 `install_status=failed`。

### 3.3 安装与租约

```text
enable/action
  → resolve dependency graph
  → acquire install lock
  → download to staging
  → verify digest
  → probe exact binary
  → persist ToolInstallationLock
  → atomically switch current
  → acquire runtime lease
```

取消或失败只清理 staging。当前版本、一个回滚版本和有活跃租约的版本保留。工具执行
一律使用安装锁中的绝对路径，不依赖 PATH。

### 3.4 Artifact

建议持久模型：

```text
Artifact {
  id, conversation_id, turn_id, workspace_id?,
  relative_path, media_type, content_hash, revision,
  plugin_id, plugin_version, provider_id, tool_lock_id,
  created_at, updated_at
}
```

路径在有工作区会话中必须是 scope root 下的相对路径；无工作区会话使用 ADR-0006 的
scratch root。文件变化经 debounce 后重新计算 hash，只有 hash 变化才增加 revision
并追加 Artifact 事件。

Office preview lease 包含 artifact id、provider、watch key、loopback port、随机 cap、
expiry 和引用计数。桌面 adapter 可以忽略 cap 直连 loopback；Web proxy 必须验证 cap。

## 4. Delegation 与 `&Mention`

### 4.1 数据流

```text
Composer AgentMention
  → PromptBlock::AgentMention
  → 序列化为 [&Name](vibex://agent/<stable-kind>)
  → 父 Agent + companion tool schema
  → delegate_to_agent
  → vibex-mcp
  → authenticated UDS/named-pipe frame
  → DelegationBroker
  → child Conversation/Turn
  → Conversation events + task report
```

Mention selector 只负责创建结构化 block。Delegation card 只由
`DelegationRequested/Started/...` 事件或对应持久化 projection 产生，两者不能直接
关联为“输入 Mention 即成功”。

### 4.2 Broker 不变量

- `task_id` 和 `delegation_call_id` 全局唯一；
- parent token 绑定 parent connection、conversation 和 allowed root；
- child connection 在持久化 link 成功前不接收 prompt；
- setup 阶段保留取消/完成信号，单锁下按到达序列 first-terminal-wins；
- running 只迁移到 completed/failed/cancelled/interrupted 之一；
- parent teardown 取消整棵活跃子树，但不修改已经终态的子任务；
- 内存结果被驱逐后，status 从 Conversation/Delegation projection 返回，不猜测；
- LLM 输出最多 256 KiB 进入工具结果；完整子会话仍可打开。

### 4.3 能力

Agent readiness 增加 `accepts_session_mcp_servers` 和
`supports_vibex_companion(feature)`。注入逻辑只读能力，不判断 `AgentKind ==
ClaudeCode`。对于会拒绝 MCP server list 的 Agent，UI 明确显示“不支持父级委派”，
它仍可作为子 Agent。

## 5. Automation

### 5.1 领域模型

```text
Automation {
  id, name, enabled,
  trigger_spec,
  turn_launch_spec,
  isolation_spec,
  next_run_at,
  last_run_summary,
  unseen_failure_count,
  spec_version
}

AutomationRun {
  id, automation_id, trigger, scheduled_for,
  status, conversation_id?, turn_id?, connection_id?,
  worktree_workspace_id?, resolved_versions,
  started_at, ended_at?, stop_reason?, error?, summary?
}
```

`TurnLaunchSpec` 复用正常 Composer 发送前的 canonical input：

```rust
pub struct TurnLaunchSpec {
    pub prompt_blocks: Vec<PromptBlock>,
    pub display_text: String,
    pub agent: AgentSelectionIntent,
    pub mode_id: Option<String>,
    pub config_values: Vec<AgentSessionConfigOverride>,
    pub plugin_actions: Vec<PluginActionRef>,
    pub workspace: WorkspaceTarget,
}
```

所有入口先调用同一个 `validate_turn_launch_spec`；Automation editor 不能保存普通
Composer 无法发送的输入。

### 5.2 Engine 时序

```text
tick/manual trigger
  → acquire engine + per-automation lock
  → transaction: claim due + advance next_run + insert running Run
  → cancellation checkpoint
  → prepare isolated workspace
  → cancellation checkpoint
  → resolve Agent/Plugin/Tool versions
  → create Conversation
  → create/start Turn through conversations crate
  → record correlation
  → observe durable terminal event
  → settle Run
  → apply retention/cleanup policy
```

启动 reconciliation：

1. 把上次进程遗留 running Run 标记 Interrupted；
2. 不重新发送其 Turn；
3. 重新计算/认领已经到期的 Automation，每个 Automation 至多产生一个 catch-up Run；
4. 周期性用 Conversation 终态修正丢失广播的 Run。

Engine 的 clock、claim store、workspace preparer、turn launcher 和 owner lock 是 port，
测试使用 fake。真实实现分别接 chrono、SQLite、git/worktree、conversations 和文件锁。

## 6. Application Core 与 Remote Protocol

### 6.1 Use case 形态

```rust
pub trait ApplicationCore: Send + Sync {
    async fn call(
        &self,
        principal: Principal,
        command: ApplicationCommand,
    ) -> Result<ApplicationResult, ApplicationError>;

    async fn attach(
        &self,
        principal: Principal,
        subscription: SubscriptionRequest,
    ) -> Result<SubscriptionBootstrap, ApplicationError>;
}
```

实际 Rust 可以按领域拆 trait，避免单个巨大枚举；这里表达的是适配器只调用 use case，
不包含业务 SQL 和状态推进。

Tauri adapter 注入本地 `Principal`；Server adapter 从 token 解析 remote principal。
两者运行相同 validation/authorization。桌面专属操作在 capability 中声明，仅
Tauri adapter 实现。

### 6.2 前端 Transport

```ts
export interface BackendTransport {
  readonly environment: 'desktop' | 'web' | 'remote-desktop';
  call<TCommand extends CommandName>(
    command: TCommand,
    args: CommandArgs<TCommand>,
  ): Promise<CommandResult<TCommand>>;
  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent>;
  capabilities(): Promise<ServerCapabilities>;
}
```

现有 `frontend/src/lib/api/*` 继续作为 feature-facing API facade，但它们改为依赖
Transport，而不是直接 import Tauri。这样可以逐个 API 切换，不要求一次重写前端。

### 6.3 Attach/replay

```text
client → attach(conversation_id, after_sequence, subscription_id)
server → ready(subscription_id)
server → snapshot?(through_sequence)
server → event(sequence)*
server → live(high_water_mark)
```

命令响应带 `operation_id`。客户端应先 attach/ready 再发送会产生事件的命令，或者
在命令后用返回的 sequence 补拉；两种路径都由契约测试覆盖。

全局列表变化使用独立 resource stream 和 revision/cursor，不把无序广播伪装成
Conversation sequence。

### 6.4 Server 安全

- `Principal` 包含 token id、scope、设备 id（未来）和审计上下文；
- token 只存哈希；显示值只在创建/轮换时返回一次；
- WebSocket token 优先通过 subprotocol；日志 middleware 必须清除认证信息；
- `ProjectScope` 解析所有远程路径；
- Office/console proxy 使用独立 `PreviewCapability`，校验 lease、port、path、expiry；
- iframe 使用 sandbox；在 Web 场景移除 `allow-same-origin`，必要的 URL 重写由受测
  代理完成；
- automation owner lock 和 Server 生命周期一起初始化/释放。

## 7. Codeg 复用清单

复用前建立 `docs/third-party/codeg-adoption.md`，每一项记录 commit、源文件、目标文件、
采用方式（copy/adapt/reimplement）、主要修改和测试。候选：

| 能力 | Codeg 来源 | VibeX 采用方式 |
|---|---|---|
| Office watch/process lease | `src-tauri/src/office_watch/mod.rs` | 已适配；迁入 Artifact Provider 并补来源记录 |
| Office Web proxy | `src-tauri/src/web/handlers/office_watch_proxy.rs` | 适配 token/scope/iframe 测试 |
| Delegation tool schema | `src-tauri/src/acp/delegation/tool_schema.json` | 适配 `&Mention` 和 VibeX AgentKind |
| Broker race/cache behavior | `src-tauri/src/acp/delegation/broker.rs` | 行为/测试对齐，保留 VibeX 模块化 crate |
| Automation model/engine | `src-tauri/src/models/automation.rs`, `automation/engine.rs` | 适配事件溯源 Turn 与 Interrupted |
| Frontend Transport | `src/lib/transport/*` | 接入现有 API facade，避免直接复制路径别名 |
| Axum router/event bridge | `src-tauri/src/web/*` | 复用 adapter 结构，事件 replay 改用持久序列 |

任何 copy/adapt 必须满足 Apache-2.0 第 4 节；若 VibeX 发布包尚无第三方 notices，
在第一次源代码复用切片中建立 NOTICE/归属交付路径。

## 8. TDD 测试缝（实施前评审门）

以下是提议的公共测试缝。按照 TDD 规则，在本规格获批准前不为新功能编写测试；批准后
不得在没有更新本节并再次确认的情况下改测私有实现。

| Seam | 测试入口 | 观察行为 | 不测试 |
|---|---|---|---|
| Plugin Catalog | `PluginService.import/enable/action` | schema、依赖、readiness、动作输出 | SQL 列、内部 reducer |
| Tool Runtime | `ToolRuntime.ensure/upgrade/release` | 下载验证、原子切换、取消、租约 | 某 helper 调用次数 |
| Artifact Service | `ArtifactService.record/open_preview/close` | revision、Provider 选择、租约与事件 | Office watch map 结构 |
| Mention Editor | 用户键入/选择/粘贴/发送 | `&` 触发与结构化往返 | Lexical 私有 node |
| Delegation Companion | MCP `tools/call` over in-memory frame | wire、token、错误与 task report | listener 私有函数 |
| Delegation Broker | `start/status/cancel/parent_closed` | 状态机、竞态、深度、回退 | Mutex/Map 布局 |
| Automation Service | `save/run_now/tick/cancel/runs` | spec 验证、claim、隔离、终态、恢复 | scheduler loop 实现 |
| Application Core | typed use case API | Tauri/Web 得到同等结果/错误 | adapter 内部函数 |
| Remote Protocol | HTTP/WS test client | auth、capabilities、attach/replay/reconnect | Axum handler 数量 |
| Frontend feature | 用户点击/键入，mock Transport | 可见行为、可访问性、错误恢复 | Zustand 内部字段 |
| Desktop/Web E2E | 打包或测试 Server + fake Agent | 关键用户旅程 | 第三方真实账号 |

### TDD 循环

每个 `tasks.md` 切片严格执行：

1. **RED**：只为该切片在上表某一 seam 增加一个行为测试，运行目标命令并保存预期失败；
2. **GREEN**：写能通过该测试的最小实现，不预先实现后续切片；
3. **REVIEW**：目标测试绿后审查命名、重复、安全和可观测性；必要重构不得改变行为；
4. **GATE**：运行该 crate/feature 全套测试；里程碑末运行跨层契约/E2E。

禁止先批量写一整个 milestone 的测试。时间、网络、文件和进程 fake 必须从公共 port
进入；只有 adapter 集成测试可以观察真实临时数据库/临时目录。

## 9. 测试层级

- Rust unit/behavior：manifest、安装状态机、Artifact revision、Broker、cron/timezone、
  claim/reconcile、protocol codec。
- Rust integration：SQLite migration、真实临时文件、fake executable、Axum router、
  UDS/named pipe 可用平台。
- Frontend Vitest：Mention、Plugin action、Automation editor、Transport reconnect、
  capability gating。
- Contract：同一 fixture 分别通过 Tauri test adapter 和 HTTP adapter，比较规范化结果。
- E2E：桌面 Office 动作、多 Agent 子会话、Automation run；Web 登录、会话流、权限/
  取消、断线恢复、Office proxy。
- Packaging smoke：OfficeCLI/`vibex-mcp` sidecar、`vibex-server` 静态资源与跨平台路径。

不以任意覆盖率百分比代替行为覆盖。对 Broker、安装、claim/recovery 和 replay 状态机
使用分支/竞态矩阵；UI 只覆盖关键用户行为。

## 10. 迁移与发布

### 数据迁移

- 插件 v1 行迁到 `legacy_plugin_manifests` 或保留原 JSON 证据；禁止迁移时执行命令。
- 能映射的内置插件转为稳定 plugin id/version；无法映射的第三方条目标记
  `migration_required`。
- 旧 Automation 转成 TurnLaunchSpec v1；本机时区写为明确 IANA zone；`in_place`
  映射为 disabled 的 `shared_in_root` 草稿，用户确认后才能重新启用。
- Web token 从明文配置迁到 secret store/token hash；旧 token 轮换。

### Feature gates

feature gates 只控制发布可见性，不保留两套领域真相：

1. Plugin v2 shadow-read/readiness 对比；
2. Office 内置插件；
3. Delegation capability expansion + `&Mention`；
4. Automation v2（迁移后旧 scheduler 停止）；
5. BackendTransport desktop-only；
6. `vibex-server` + Web beta；
7. remote desktop connection。

每个 gate 只有一个回滚路径：停止启用新入口并继续读兼容数据；禁止同时运行旧、新
Automation Engine。

## 11. 主要风险

| 风险 | 缓解 |
|---|---|
| 插件自动安装成为供应链执行入口 | 声明式分发、精确版本、哈希、staging、绝对路径、无任意 shell |
| Codeg 复制带来许可证遗漏 | adoption 清单、NOTICE/归属检查、源 commit 固定 |
| `&` 与普通文本冲突 | token-boundary 解析、code/URL 排除、粘贴往返测试 |
| LLM 忽略 Mention | UI 不宣称已派发；工具 schema 明示；未来 Graph 模式另行解决 |
| Automation 重复副作用 | 原子 claim、单 owner、per-automation lock、Interrupted 不重放 |
| Web 与桌面功能漂移 | 同一 Application Core、同一前端、adapter contract tests |
| replay 与 live 之间丢事件 | ready/high-water 协议、持久序列、断线 E2E |
| Web 暴露本机文件/端口 | scope id、canonicalize、preview lease/cap、默认 loopback |
| 大重构长期不可交付 | 纵向 tracer bullets、每个 milestone 有可用用户旅程和删除条件 |
