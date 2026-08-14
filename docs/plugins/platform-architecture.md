# Plugin Platform Architecture

## 1. 目标与非目标

Plugin Platform 的目标是让一个可安装包以同一个身份、版本和生命周期同时扩展：

- Agent：Skills、MCP、Hooks 与 Workflows；
- App：文件 opener、preview provider、配置、命令和自定义界面；
- Host：Worker handler、事件订阅和后台服务；
- Runtime：本地 CLI、Binary、MCP 或 sidecar 资源。

平台不把 Tauri plugin、Rust 动态库或任意前端模块加载器暴露为公共兼容面。它也不尝试
把 Codex/Claude Code 原生插件的全部能力自动翻译成 VibeX App contribution。

## 2. 现状根因

当前 Office 路径证明问题来自所有权边界，而不是 UI 菜单：

- `PluginPackage::inspect` 要求至少一个 Skill，App-only package 无法存在；
- 严格 v2 manifest 与宽容 v3 manifest 同时描述 `vibex.office`；
- `plugin_v2_*` 与 `plugin_control_*` 分别保存部分安装/启用事实；
- `AppState` 同时持有 `OfficeRuntime` 和 `PluginControlPlane`；
- Tauri command、conversation execution 和 React preview 按 Office ID/类型分派；
- `ArtifactToolProvider` 已提供 lease seam，却只允许编译进 Host 的 provider adapter。

因此重构必须把 package、runtime、activation 和 contribution publication 收敛到
一个深模块，并让 Office 成为该 interface 的普通调用者。

## 3. 运行拓扑

```text
Plugin source / .vxp
        │
        ▼
┌──────────────────────── VibeX Host ─────────────────────────┐
│ Package Inspector → Installation Store → Plugin Kernel      │
│                                          │                  │
│                 ┌────────────────────────┼─────────────┐    │
│                 ▼                        ▼             ▼    │
│        Host API Bridge         Runtime Resolver   Activation│
│                 ▲                        ▲             │    │
│                 │                        │             ▼    │
│         Full Trust Worker ───────────────┘    Contribution  │
│                                             Registry        │
│                                                │            │
│              ┌────────────────┬────────────────┼─────────┐  │
│              ▼                ▼                ▼         ▼  │
│         Agent Host       App Surface Host  Artifact Host  │  │
│                                                      Automation│
└──────────────┬────────────────┬─────────────────────────────┘
               │                │
        BackendTransport   versioned worker RPC
               │
       Desktop / Web / Remote client
```

Worker 与 Runtime 永远运行在拥有数据目录的 VibeX Host。远程客户端不能把 Host 插件下载
到本机执行，也不能因本机具备某能力而绕开 Server-bound window 的 Host 归属。

## 4. 深模块与 seam

### 4.1 Plugin Kernel

Plugin Kernel 是外部唯一业务 seam。调用方不需要理解 manifest parser、数据库表、Worker
进程、Runtime lock、package digest 或 generation drain。

概念 interface：

```rust
pub trait PluginKernel {
    async fn inspect(&self, source: PluginSource) -> Result<Inspection, PluginError>;
    async fn install(&self, intent: InstallIntent) -> Result<OperationId, PluginError>;
    async fn activate(&self, intent: ActivationIntent) -> Result<OperationId, PluginError>;
    async fn deactivate(&self, plugin: PluginIdentity) -> Result<OperationId, PluginError>;
    async fn update(&self, intent: UpdateIntent) -> Result<OperationId, PluginError>;
    async fn uninstall(&self, intent: UninstallIntent) -> Result<OperationId, PluginError>;
    async fn inventory(&self, query: InventoryQuery) -> Result<PluginInventory, PluginError>;
    async fn invoke(&self, invocation: ContributionInvocation)
        -> Result<InvocationResult, PluginError>;
    fn subscribe(&self, after: OperationSequence) -> PluginEventStream;
}
```

这不是要求最终 Rust trait 逐字一致，而是规定外部 interface 的深度：调用者提交意图并
观察结果，不协调内部步骤。Tauri 和 Axum adapter 只能做鉴权、DTO 与错误转换。

### 4.2 Package Inspector / Compiler

输入是目录、archive、registry artifact 或 linked development source，输出是不可变的
`CompiledPluginPackage`：

- 规范化 identity、版本与来源；
- canonical manifest；
- content tree digest、entrypoint digest 和 resource digest；
- typed contributions 与 Host API requirements；
- Host/platform compatibility；
- runtime candidates；
- warnings 与 blocking diagnostics；
- signature/provenance evidence。

解析器只读，不安装 Runtime、不执行 package code、不写 activation。所有路径在
canonical package root 内解析，并拒绝 traversal、symlink escape、重复大小写身份、
设备文件和不受支持的文件类型。

### 4.3 Installation Store

普通安装物化不可变 snapshot；linked development 显式引用用户目录。二者都生成 digest，
但 linked source 每次变化后必须重新 inspect、计算 package digest 并走 candidate
activation。安装目录不能直接被 Worker 写入；插件持久数据进入独立 data root。

Installation Store 保留当前版本和至少一个可回滚版本。删除 package snapshot 不删除
用户文件、Artifact、Conversation 或插件 data，除非用户单独选择清除插件 data。

### 4.4 Contribution Registry

Registry 保存当前已发布 generation 的只读运行时目录：

```text
ContributionRecord
├─ identity: publisher/plugin/contribution
├─ package_version + package_digest
├─ generation_id
├─ kind + kind_version
├─ declaration
├─ handler_route?       # declarative contribution 可无 handler
├─ required
├─ readiness
├─ surface_capabilities
└─ diagnostics
```

Registry 不负责安装或启动 Worker。它的价值是让以下调用方使用同一目录：

- Agent session assembly；
- Composer 与 Automation action resolver；
- file opener/preview resolver；
- App navigation/settings/action inventory；
- Runtime/diagnostics UI；
- Remote protocol capabilities。

Registry publication 是整个 generation 的一次原子替换。不得逐条 insert 后让调用方观察到
半个插件。

### 4.5 Activation Manager

Activation Manager 管理 candidate-first 事务和旧 generation drain：

```text
installed → resolving → preparing_runtime → starting_candidate
          → validating_candidate → publishing → active
                                             ↘ active_degraded

任一发布前失败 → installed/previous_active
active → draining → disabled
```

每个调用在开始时固定 generation lease。发布新 generation 后，旧 lease 可以完成但不得
生成新的子调用；超时后取消并记录 `generation_drain_timeout`。Preview lease 的 drain
策略按 provider 声明，可允许用户已打开视图自然关闭，但不得无限阻止更新。

Worker 发送 `ready` 只证明 transport 可用，不证明 activation 成功。Activation Manager
还必须核对：

- required handlers 完整；
- handler 与 manifest declaration 匹配；
- runtime probe 通过；
- contribution identity 无非法冲突；
- App artifact metadata 与 SDK major 兼容。

### 4.6 Host API Broker

ADR-0046 将插件执行模型改为 Full Trust。Broker 是 Runtime、Artifact、conversation 与 app lifecycle
等结构化 Host API 的便利层，而不是权限边界；插件也可以直接使用 Node 与浏览器环境能力。

| Capability family       | 典型 scope                                            |
| ----------------------- | ----------------------------------------------------- |
| `filesystem.read/write` | opened artifact、workspace-relative glob、plugin data |
| `network.fetch/listen`  | HTTPS domain allowlist、loopback allocated port       |
| `runtime.execute`       | manifest 中一个精确 runtime lock 与固定 argv schema   |
| `secrets.read`          | 仅当前 plugin 的 named secret                         |
| `storage.*`             | 当前 plugin 的 settings/KV/SQLite                     |
| `agent.*`               | 注册过的 tool/action、当前 invocation context         |
| `artifact.*`            | 指定 Artifact ID、create/open preview/update evidence |
| `conversation.*`        | 当前 Turn 或明确 scope 的只读/追加动作                |
| `app.*`                 | 已声明 surface、navigation intent、notification       |
| `system.*`              | clipboard、open external URL 等受限能力               |

Broker 仍校验 plugin identity、generation、参数 schema 和 Runtime lock，防止生命周期串线或损坏；
它不读取 persisted grant，也不按 capability scope 拒绝 Full Trust 插件。

### 4.7 Worker Host

默认 Worker 是独立 OS 进程，拥有：

- 当前用户完整环境变量、文件系统、网络与子进程能力；
- package code 与插件根目录访问；
- 有界 CPU、内存、进程数、输出和请求并发；
- versioned JSON-RPC/stdio transport；
- heartbeat、structured logs、crash/backoff 与强制终止；
- activation-scoped lifecycle identity。

首个实现使用 VibeX 管理的 JavaScript runtime；protocol 保持语言无关，使其他 Worker adapter
后续能实现同一 seam。进程隔离只用于 crash containment、reload 与 generation drain，不应被描述
为 security sandbox。

Worker crash 只使其 generation 对应 executable contributions degraded/failed。Host 主进程
和其他插件继续工作。连续重启使用有上限的指数退避；超过预算后停止自动重启，等待用户
或新 generation。

### 4.8 Runtime Resolver

Resolver 接受声明式 Runtime request，返回精确 lock：

```text
RuntimeLock
├─ runtime_id
├─ version
├─ target
├─ source + provenance
├─ digest + integrity_level
├─ absolute_entrypoint
├─ probe_evidence
└─ ownership: managed | external
```

Managed Runtime 先下载到 staging，验证 digest，再 probe 并原子发布。Package installation
保存 ref；GC 只删除无 installation/generation/lease 引用的版本。外部 Runtime lock 每次使用
前重新验证；内容变化只有官方完整性证据匹配时才能自动采纳，否则 fail closed。

Runtime invocation 采用固定 executable 与结构化 argv template，以保证可重复执行和诊断。原生
sidecar 与 Worker 一样随插件启用获得 Full Trust，不再有单独 Trusted Native grant。

### 4.9 App Extension Host

App contribution 分两类：

#### Host-rendered surface

插件提供 descriptor，VibeX 使用自身组件和 design tokens 渲染。v4 第一批稳定 surface：

- `app.command`
- `app.settings`
- `app.fileOpener`
- `artifact.previewProvider`
- `app.toolbarAction`
- `app.status`

Host-rendered surface 不执行 package App 代码，适合 Office 第一阶段迁移。

#### Full Trust custom surface

复杂 panel/editor 使用 iframe/webview 作为 mount 与 lifecycle seam，但不把它当安全沙箱：

- document 可以加载脚本、样式、图片、字体和网络资源；
- 不设置 iframe sandbox、CSP 或 Permissions Policy；
- package 代码与 VibeX 运行在同一用户信任级别；
- bridge 只接受 JSON-compatible typed messages；
- 每个 mount 仍绑定 plugin/generation，unmount/generation change 后撤销 session；
- navigation、download、clipboard 与浏览器 API 可直接使用，也可选择结构化 Host API。

UI error boundary 只卸载对应 surface，并提供重试/诊断；不得白屏整个应用。

### 4.10 Artifact Host

现有 Artifact 路径验证、provider probe、preview lease、进程 refcount、capability proxy 与 idle
reap 属于 Artifact Host，而不是 Office Plugin。公共 preview contract：

```ts
type RenderDescriptor =
  | { kind: "web"; capabilityUrl: string; title?: string }
  | { kind: "hostDocument"; renderer: string; payload: JsonValue }
  | { kind: "pluginSurface"; surfaceId: string; sessionId: string };
```

调用链必须是：

```text
file/artifact → resolver(media type, extension, user default)
              → contribution invocation
              → preview lease + RenderDescriptor
              → generic preview panel
```

Resolver 优先用户默认，其次有效 priority，再按稳定 identity 排序。Provider 失效时回退到
下一 compatible provider；同一文件已经打开的 lease 不在背后静默换 provider。

## 5. 身份、信任与数据模型

### 5.1 身份

Package identity 是 `(publisher, plugin_id)`，版本与 digest 标识安装 artifact。Unsigned
local package 使用显式 `local-unverified` publisher evidence，不能冒充 Marketplace
publisher。名称、图标和源目录不参与身份推断。

### 5.2 Full Trust

安装或启用 package 就是信任决定。Worker、App 与 Runtime 继承当前用户权限；Host 不维护或
执行 capability grant/scope/trust-tier 门禁。Manifest 的旧 `permissions` 字段只作为兼容元数据，
不会触发产品授权 UI。publisher、digest 与 generation 仍用于更新、rollback、诊断与生命周期绑定。

### 5.3 数据隔离

每个 Plugin identity 获得独立：

- settings namespace；
- KV namespace；
- SQLite 文件及 append-only migration history；
- secrets namespace；
- data/cache/temp 目录；
- structured log stream。

Uninstall 默认保留 data，并在 UI 中单独提供“删除插件数据”。重新安装只有 identity 与
publisher evidence 匹配时才能重新挂载保留数据。

### 5.4 供应链

`.vxp` 必须是确定性 archive。安装验证 package digest、文件清单、entrypoint metadata、
runtime locks 和可选 signature/SBOM。Registry update 先下载 candidate，不在当前目录原地
覆盖。npm/git materialization 禁止 lifecycle scripts；package build scripts 只在作者的
开发环境运行，不在最终用户安装阶段运行。

## 6. 持久状态

建议 canonical schema 按职责拆分，但只有 Plugin Kernel 写入：

| 表/聚合                     | 权威事实                                               |
| --------------------------- | ------------------------------------------------------ |
| `plugin_packages`           | identity、version、digest、source、signature、manifest |
| `plugin_installations`      | 当前/rollback package、membership、data retention      |
| `plugin_activation_intents` | enabled intent 与 target package                       |
| `plugin_generations`        | 完整发布的 generation 和状态证据                       |
| `plugin_contributions`      | generation 下规范化 declarations；可重建但用于查询     |
| `plugin_grants`             | 旧 permission 元数据的兼容投影；不参与执行门禁         |
| `plugin_runtime_locks`      | installation 使用的精确 Runtime evidence               |
| `plugin_runtime_refs`       | installation/generation/lease refs                     |
| `plugin_bindings`           | Agent/Project/Host 投影意图                            |
| `plugin_settings`           | 非秘密 settings；secrets 进入系统凭据存储              |
| `plugin_operations`         | install/update/activate/uninstall state machine        |
| `plugin_audit`              | 不可变安全与破坏性操作证据                             |

Worker PID、in-memory handler、heartbeat 和 open transport 是瞬态投影，不写成另一个权威。
Host 重启后只根据完整 generation 证据重新建立进程；未完成 operation 标记 interrupted，并
按操作语义回滚或允许重试，绝不假装成功。

## 7. 状态与错误

Plugin summary 状态：

- `not_installed`
- `installed_disabled`
- `preparing_runtime`
- `activating`
- `active`
- `active_degraded`
- `incompatible`
- `failed`
- `updating`
- `rolling_back`

每个 contribution 另有 `ready / unavailable / degraded / incompatible`。
聚合状态由事实派生，不持久化第二个真相。

稳定错误至少覆盖：

- package/manifest/path/signature/integrity invalid；
- host/API/contribution/runtime incompatible；
- Host API unsupported 或 invocation schema invalid；
- registration mismatch/collision；
- worker crashed/unresponsive/resource limit；
- runtime install/probe/digest/ownership failure；
- generation publish/drain/rollback failure；
- surface unsupported/token expired/document load failure；
- native adapter capability unavailable。

错误 envelope 必须含 stable code、operation ID、plugin identity、generation（若有）、用户可
执行恢复动作和可审计 diagnostic reference；不能只返回 Worker stderr。

## 8. Remote 与多客户端

Host inventory 通过 versioned Remote protocol 返回：

- package/activation/contribution state；
- 客户端可渲染的 surface kinds；
- operation progress 与 durable sequence；
- capability incompatibility；
- 短期 surface/preview capability URL。

Web 客户端不得读取 Host 本机绝对路径。文件操作使用 Project/Workspace/Artifact identity；
preview proxy 只代理已注册 provider lease 的 loopback endpoint，不能成为任意 SSRF proxy。
主 access token 不进入 iframe URL、插件消息或日志。

## 9. 产品信息架构契约

Plugin 模块服务于 VibeX Product Plugin，保留全局设置侧栏并采用“单列目录 → 独立详情”结构：

- 目录行只显示图标、名称、README summary、发布者/版本和启停状态；
- 点击目录行进入插件独立页面；
- 内容 Tab 展示 README 与 Host 校验过的 `contents/` 索引；
- 配置 Tab 依据 schema 编辑包根 `config.json`；
- 安装/启用即为 Full Trust 决定；失败通过本地化 Toast 呈现；
- contribution、generation、handler、runtime lock、digest 与 crash evidence 只进入诊断/开发工具。

用户界面不把一个插件分成 App/Agent/Host/Runtime，也不以 Skill、MCP、Runtime 或命令数量
解释插件价值。它们是 Kernel 的内部 integration 与执行事实。

Codex、Claude Code 等 Agent-native plugin 位于“设置 → Agent”的对应 Agent 页面底部，默认
折叠并使用原生插件的列表/预览。它只呈现当前 Agent 原生权威和 adapter 支持的操作，不重复
列出 VibeX Package 的 App/Runtime 生命周期；若多格式 source 与 VibeX Package 相关联，可以
显示可追溯链接，但仍是两个独立启停状态。

远程窗口中两个入口都作用于当前 Server Profile 的 Host。当前客户端能力不允许安装或修改时，
页面保持可浏览并准确禁用写操作，不把能力不可用伪装成无插件。

## 10. 内核不变量

1. 一个 Plugin identity 在一个 Host 上只有一个当前 installation 和一个已发布 generation。
2. Contribution Registry 永远不暴露 candidate 或部分 generation。
3. 结构化 Host API 调用能追溯到 declaration、generation、invocation 和 audit evidence；Full
   Trust 插件直接执行的 Node/Browser 副作用不经过 Host 审计。
4. Package 更新失败不会改变当前 generation。
5. 禁用不会删除 Artifact、Conversation、Automation 或插件 data。
6. Runtime GC 不删除仍被 installation、generation 或 lease 引用的内容。
7. Agent、App 和 Runtime contribution 的 package version/digest 必须一致。
8. 核心消费者只按 contribution kind/identity 调用，不识别具体插件 ID。
9. Native Agent plugin 与 VibeX Product Plugin 保持独立 lifecycle，不互相替代启停状态。
10. Built-in/source-bundled 只影响发现与可删除性，不绕过 schema、digest、activation 或
    contract tests。
