---
status: accepted
date: 2026-07-30
decision-makers:
  - VibeX maintainers
---

# ACP Registry 以可验证证据为权威，并通过兼容层接入 `auth/status`

## Context

ADR-0010 至 ADR-0029 已经定义了开放 Agent 身份、官方 Registry、版本锁、Binary
完整性、有限并发、Agent 原生配置以及 ACP-first 管理原则。首轮实现证明统一管线
可行，但代码审查发现实现仍在若干关键路径依赖进程内状态、历史 probe、可变 Registry
快照和硬编码能力值。这些依赖破坏了既有决策中的核心不变量：

- 托管 Binary 安装后被替换，启动门禁仍可能执行它；
- 安装操作持久化为运行中，但取消令牌只存在内存，应用重启后操作可能永久 Busy；
- 用户点击安装后，真正执行时会重新读取当前 Registry，目标版本可能发生变化；
- repair 与 update 重新依赖当前 Registry，无法仅凭现有 Installation lock 修复；
- 生产管理投影没有统一使用已经测试的 reducer；
- ACP 探测创建的连接与临时目录未保证释放，失效连接可能阻止卸载；
- `initialize` 协商结果被裁剪或硬编码，UI 和运行时可能宣称并不存在的能力；
- 会话能力目录没有认证、原生配置和时间维度的失效条件；
- 原生配置冲突没有可恢复交互，多文件写入可能产生部分成功；
- Agent 级新会话默认偏好没有进入生产读写路径；
- Registry 下架、离线快照、检查更新和“已安装”投影仍有语义偏差。

同时，ACP 已提供 `additionalDirectories`、`session/list`、`session/delete`、
`session_info_update`、`_meta` 传播及会话成本等能力，而 VibeX 尚未完整使用。
ACP 的
[`auth/status`](https://agentclientprotocol.com/rfds/get-auth-state)
仍是 Draft RFD，但它明确提出通过 `agentCapabilities.auth.status` 协商后执行无副作用
认证状态查询，避免用 `session/new` 的不确定错误行为猜测认证状态。VibeX 决定现在
接入该草案，但必须将草案漂移限制在一个可替换的协议兼容边界内。

本 ADR 是对 ADR-0011、ADR-0012、ADR-0016、ADR-0017、ADR-0019、ADR-0021、
ADR-0022、ADR-0023、ADR-0026 与 ADR-0027 的落实和细化，不改变这些 ADR 的产品
方向。若本文与 ADR-0021 中“使用 `session/new` 探测认证”的临时规则冲突，以本文的
能力协商与 `auth/status` 优先规则为准。

## Assumptions and boundaries

以下前提已经确定，不在本次实施中重新讨论：

1. VibeX 默认以用户授予的本机权限运行；本 ADR 不引入 Agent 沙箱或权限收缩。
2. Agent 仍必须通过本地 Runtime 与本地 ACP `stdio` 进程运行，不允许使用 ACP
   内置的临时 Runtime、远程 ACP URL 或用户自定义启动命令。
3. Agent 来源仍只有 Built-in Agent Profile 与 ACP 官方 Registry；不扫描 PATH
   自动接管任意 Agent，也不增加自定义 Registry。
4. Built-in Agent 只在默认展示、不可移除、主动探测和声明式本地补缺方面特殊，
   安装、配置、状态与会话运行仍使用统一管线。
5. VibeX 只读认证状态，不启动浏览器、CLI、设备码登录或注销。API Key 仍由已适配
   Agent 原生配置文件持有，可在本机明文保存；VibeX 不验证 API Key 的远程有效性。
6. 功能与不变量优先于保留当前代码。若现有模块边界妨碍正确实现，应替换或删除，
   不保留双轨兼容路径。

## First-principles decision

VibeX 的 Agent 管理以以下八条不可违反的原则为基础：

1. **执行必须来自当前可验证证据。** “曾经下载成功”不能证明当前磁盘内容可信；
   每次启动必须由当前 Installation lock 和当前文件内容共同授权。
2. **持久事实不能依赖进程内对象。** 进程退出后丢失的取消令牌、连接句柄或队列对象
   不能决定操作是否仍在运行。
3. **用户确认的目标必须不可变。** 点击时确认的 Registry 快照、版本、分发和平台
   是该次安装的输入；后续刷新不能改变它。
4. **能力只能由协商结果授权。** ACP 未广告的能力视为不支持；不得用硬编码 `true`
   或某个 Agent 名称替代能力协商。
5. **状态是证据的投影，不是互相覆盖的布尔值。** membership、installation、
   operation、probe、authentication、enabled 与 platform support 分别保存，由一个
   纯 reducer 生成管理快照。
6. **只读探测必须无副作用且有界。** 探测必须有超时，并在成功、失败、取消后释放
   session、连接和临时目录。
7. **用户配置写入必须原子、可比较、可恢复。** 任何失败都不能留下半套配置；并发
   修改必须向用户暴露冲突决策。
8. **草案协议只能通过兼容层进入核心。** 核心领域依赖 VibeX 的稳定认证观察模型，
   不直接依赖 `auth/status` 草案 JSON 结构。

## Authoritative records

管理系统使用下列权威记录，任何 UI 或 Tauri command 都不得自行推导替代规则：

| Record                      | Authoritative facts                                              | Not authoritative for    |
| --------------------------- | ---------------------------------------------------------------- | ------------------------ |
| `RegistrySnapshot`          | 已校验官方目录、schema、抓取时间、内容摘要                       | 已安装状态、现有启动计划 |
| `FrozenInstallPlan`         | 用户确认的 snapshot、Agent、版本、分发、平台、解析制品与资源声明 | 当前磁盘健康状态         |
| `InstallationAttempt`       | 操作状态、阶段、资源租约、时间和终态                             | 当前可执行版本           |
| `InstallationLock`          | 当前与回滚版本的精确组件、来源、路径、版本、哈希和信任等级       | Registry 最新版本        |
| `ComponentVerification`     | 某次检查时磁盘内容与 lock 的一致性                               | 永久健康保证             |
| `AcpCapabilitySnapshot`     | 某次 initialize 的完整协商结果、协议版本与 fingerprint           | 未广告能力、永久能力     |
| `AuthenticationObservation` | 带来源和时间的认证观察                                           | 凭据有效性、登录操作     |
| `AgentSessionDefault`       | 用户为新会话保存的 ACP option/value 偏好                         | Agent 原生持久配置       |
| `AgentManagementSnapshot`   | 上述事实经 reducer 得到的只读投影                                | 独立业务权威             |

## Installation and operation decisions

### Frozen install plan

前端添加、更新或改变分发方式时必须提交一个不可变目标引用，而不是只提交
`agent_id`：

```text
FrozenInstallPlan
├── operation_kind: install | repair | update | change_distribution
├── agent_id
├── registry_snapshot_id
├── registry_entry_id
├── declared_version
├── platform_target
├── distribution_identity
├── resolved_artifact_or_package_version
├── expected_integrity_or_tofu_policy
└── resource_claims
```

- 普通 Agent 的 install/update 只有在 Registry 快照处于 fresh 状态时才能生成 plan。
- UI 显示的版本和后端生成的 plan 必须来自同一 snapshot；snapshot 不一致时要求刷新，
  不得自动换成新版本。
- plan 在入队事务中与 operation 一起持久化。执行器只读取该 plan，不重新解析 Registry。
- 内置 Agent 的 Built-in Profile 版本也必须生成同形 plan，避免另一套执行路径。
- install 与 update 可以依赖 fresh Registry；repair 默认只允许依据当前
  Installation lock 重建当前版本。上游下架或离线不得阻止现有安装修复。
- 用户明确选择其他分发方式时生成新的 `change_distribution` plan，不能在失败后静默
  fallback。

### Persistent operation state machine

安装操作采用以下持久状态机：

```text
Queued -> Running -> Succeeded
                  -> Failed
                  -> Cancelled
                  -> Interrupted
```

- `Queued`、`Running` 都必须保存 operation id、plan、当前阶段、时间和资源声明。
- 进入 Running 时记录当前宿主 instance id 与 heartbeat；取消令牌只是当前实例的执行
  工具，不是 operation 是否存在的权威。
- 应用启动时，所有属于旧 instance 且仍为 Queued/Running 的操作原子转换为
  `Interrupted`，释放持久资源租约并清理未提交 staging 目录。
- 启动恢复绝不自动重新下载、执行或切换版本。用户从详情页明确执行“重试/修复”时
  创建新的 operation，并保留旧 operation 诊断。
- 当前有效 Installation lock 和回滚 lock 在失败、取消或中断时保持不变。
- `cancel` 对当前实例的 Queued/Running 操作生效；对已经 Interrupted 的操作返回稳定
  终态，而不是“找不到内存令牌”。

### Resource-aware atomic scheduling

调度器必须真正使用 ADR-0026 的资源声明：

- 全局最多两个 mutating operation；
- 同一 Agent 的 install、repair、update、uninstall 串行；
- 共享 Node、Python、uv、包缓存、terminal shim 名称及目标目录分别加资源锁；
- 只读 probe 不占全局安装名额，但与同一 Agent 的原子切换和卸载互斥；
- “检查能否入队”与“创建 operation/占用唯一 Agent 槽位”在一个数据库事务中完成，
  消除 check-then-upsert 竞态；
- 一个失败或取消不会持有租约阻塞其他 Agent。

### Launch-time integrity

每次创建 ACP 连接前必须经过统一 `LaunchGate`：

1. 读取当前 Installation lock；
2. 验证 membership、enabled、platform support 与 readiness；
3. 验证 Runtime、ACP adapter 和必需 base Runtime 的绝对路径；
4. 对 lock 中每个可执行组件计算 SHA-256 并与 expected/TOFU 指纹比较；
5. 验证 terminal shim 的所有权标记与目标仍指向当前 lock；
6. 只有全部通过才构造不可变 launch plan 并执行。

可以使用 `(canonical_path, size, mtime, file_identity, sha256)` 缓存避免重复哈希，但缓存
只是性能优化：任何元数据变化、无法取得稳定 file identity 或显式立即检查都必须重新
计算内容哈希。哈希不匹配时隔离托管文件、将管理投影置为 needs-repair，并禁止启动。
外部安装同样重新验证记录的内容证据，但 VibeX 不删除或修改外部文件。

## Management projection decisions

### One reducer in tests and production

`reduce_management_snapshot` 成为生成 `AgentManagementSnapshot` 的唯一业务入口。
Repository 查询只加载事实，不进行 lifecycle 优先级判断；Tauri command 与前端也不
重新组合状态。

投影优先级为：

1. retired / platform unsupported；
2. active operation；
3. 没有有效 current lock；
4. current lock 组件缺失、哈希错误、shim 错误或 ACP 握手失败；
5. 必需认证或配置缺失；
6. installed and ready。

`enabled` 保持正交。`installed` 只能由有效 current lock、组件证据和兼容性验证共同
得出，不能由 `lifecycle != uninstalled` 推断。历史 probe 可以提供诊断，但不能覆盖
更新后的 installation/operation 事实。

### Active-process definition

只有以下事实可以阻止卸载或移除：

- 当前 Agent 存在状态为 Starting/Ready/Busy 的真实 ACP connection；
- 存在 in-flight turn；
- 存在当前实例的 Queued/Running mutating operation。

Disconnected、Failed、已丢弃的 prepared session、Interrupted operation 和历史连接
记录不得计为活动进程。阻止时继续使用既定提示：
“此 Agent 还有正在执行的进程，暂时无法卸载／移除”。

### Registry projection

- Registry 视图只投影当前官方 snapshot 中仍存在的条目，不把 Built-in Profile
  重新注入缺失条目。
- 已添加但上游下架的 Agent 保留 membership、导航图标、设置和 Installation lock，
  但从 Registry 两个 Tab 消失。
- 离线或过期 snapshot 可以浏览，必须显示最后成功时间；普通 Agent 的 add、check
  update 和 update 均禁用。
- 搜索覆盖名称、简介、作者和 Registry id；disclosure 展示许可证、仓库与完整分发。
- “检查更新”只比较当前 lock 与 fresh snapshot，返回无更新/可更新/不可比较；
  只有用户再次确认才生成 update plan。

## Native configuration and session defaults

### Transactional native configuration

配置保存拆成 prepare 与 commit：

1. 重新读取所有相关文件并计算 revision；
2. 对每个用户修改字段执行三方比较：打开时值、当前磁盘值、用户值；
3. 未冲突字段合并到最新磁盘内容，未知字段原样保留；
4. 同一字段冲突返回结构化 conflict，不写任何文件；
5. 用户选择“采用外部值”或“用当前值覆盖”后重新 prepare；
6. 所有目标内容写入同目录临时文件，完成语法、权限与 schema 校验；
7. 使用可回滚的原子 rename 提交；任一文件失败时恢复全部原文件；
8. 提交后重新读取并验证，再刷新认证与能力目录 fingerprint。

前端必须提供重新载入、逐冲突采用外部值和明确覆盖操作。Toast 只通知结果，不能代替
冲突处理界面。配置预览、遮罩和页面底部统一保存栏继续遵循 ADR-0022。

### Agent-level new-session defaults

生产路径必须使用 `AgentSessionDefaultRepository`：

- 默认值按稳定 AgentId 保存 raw ACP option id/value，不保存展示文本；
- 创建会话读取一次持久默认值，再叠加用户本次创建的显式覆盖；
- 只有当前 prepared ACP session 仍广告完全相同的 option/value 时才应用；
- 已失效默认值回退 Agent 默认并提示用户，同时更新其 stale 状态，不阻止就绪；
- session rebind 使用 Conversation 原有选择做同样校验；
- 原生配置变更、Agent 版本变化或认证观察变化只使 capability catalog 失效，不删除
  用户偏好。

## ACP capability truth and probe lifecycle

### Complete negotiated capability snapshot

VibeX 保存 initialize 返回的协议版本、agent info 和完整能力结构，至少包括：

- load、resume、close、fork、list、delete、additional directories；
- prompt image、audio、embedded context 与 resource link；
- terminal、filesystem、elicitation；
- session config options 与 boolean option；
- MCP stdio、HTTP、SSE；
- authentication logout 与 Draft auth status；
- Agent 提供的未知 `_meta` capability。

缺省能力统一归一化为 unsupported。Conversation binding 和 ready event 从这一快照构造，
禁止硬编码 image/load/close/terminal 为 true。未知字段必须能够保留并安全忽略，
避免 ACP 增加非破坏字段时反序列化失败。

### Capability catalog freshness

会话配置目录的 fingerprint 至少包含：

```text
AgentId
+ current Installation lock digest
+ ACP protocol/agent version
+ normalized initialize capabilities digest
+ Agent-native config revision digest
+ authentication observation generation
+ provider/account generation when observable
```

目录保存 `retrieved_at`、generation 和 refresh result。读取只返回匹配 fingerprint 且
未超过 TTL 的完整快照；过期快照可以先展示为 stale，但后台必须刷新。创建会话页面
不得仅因缓存非空而永久跳过刷新，也不得从静态 Profile 合成模型或 reasoning choices。

成功的 `session/new` 或 config option update 可以原子发布更新目录；失败、超时和格式
错误保留上一份完整快照。两个同 fingerprint 的刷新必须合并或串行，旧 generation
不能覆盖新 generation。

### Bounded probe scope

所有 probe 使用统一作用域，并保证在每条退出路径执行：

1. timeout/cancellation；
2. discard temporary ACP session；
3. disconnect and reap ACP process；
4. remove connection from active set；
5. delete temporary workspace；
6. persist redacted diagnostic。

探测成功后活动连接数必须回到探测前数值。probe 产生的历史记录不参与卸载 Busy 判断。

## Draft `auth/status` adoption

### Compatibility boundary

新增稳定的领域接口：

```text
AuthenticationObserver
  observe(initialized_connection) -> AuthenticationObservation

AuthenticationObservation
  state: authenticated | unauthenticated | unknown | degraded
  method: api_key | account | unknown
  source: acp_auth_status | native_config | builtin_local_provider | runtime_error
  observed_at
  capability_generation
  draft_revision
  diagnostic_code?
```

ACP 草案 JSON 只存在于 `AcpAuthStatusAdapter`。数据库、管理 reducer、Tauri DTO 和前端
不直接依赖草案 request/response 类型，因此 RFD 改名、字段变化或稳定化时只替换 adapter。

### Negotiation and call rules

依据 2026-07-21 接受为 Draft 的 RFD 版本：

1. 只有 initialize 明确返回 `agentCapabilities.auth.status == true` 时才调用
   `auth/status`；未广告时不得乐观调用。
2. 请求只能在 initialize 完成后发出，使用空参数并允许受大小限制的 `_meta`。
3. 响应只读取必需的 `authenticated: boolean`，保留但不信任可选 `message` 与 `_meta`；
   未知字段安全忽略。
4. 调用有短超时、可取消、无重试副作用。超时或 method-not-found 产生 degraded/unknown，
   不把 Agent 安装判为损坏。
5. `authenticated: true` 仅表示 Agent 认为本地存在凭据，不表示凭据远程有效；
   VibeX 不额外验证 API Key。
6. `authenticated: false` 表示该观察时刻 Agent 未发现凭据；它不会删除配置、注销账号
   或修改 readiness 之外的事实。
7. 保存配置、安装/更新完成、进入 Agent 设置和创建会话前可以重新查询；不持续轮询。

### Status-source semantics

`auth/status` 草案故意不报告认证方法，因此 VibeX 不把 `authenticated: true` 自动翻译
为“已通过账号登录”：

- 已适配原生配置中存在 API Key 时，method 为 `api_key`，显示“已通过 API Key 登录”；
  key 是否有效仍由用户负责。
- Built-in local provider 能以官方、无副作用证据确认账号状态时，method 为 `account`，
  显示“已通过账号登录”。
- `auth/status == true` 但没有可靠来源分类时，method 为 `unknown`，显示“已登录”，
  不虚构账号或 API Key 来源。
- `auth/status == false` 且没有更具体的当前凭据证据时，显示“暂未登录”。
- ACP aggregate 状态与当前原生配置/官方本地 Provider 证据矛盾时，状态为 degraded，
  保留最近证据并显示认证状态不一致的预检查诊断；不得静默选一方。
- Profile 明确声明 `authentication_required = false` 的 Agent（例如无需登录的
  OpenCode 配置）不会因为缺少 `auth/status` 或返回 unauthenticated 被阻止创建会话。
- 未广告 `auth/status` 的普通 Agent 不通过 `session/new` 做后台认证探测。若其 Profile/
  Registry 契约没有声明必须认证，则允许尝试真实会话；真实操作返回 AuthRequired 时
  更新 observation 并向用户显示待认证。

这部分细化 ADR-0021：ACP 对“Agent 自己是否发现凭据”优先，本地 Provider 负责 ACP
草案没有表达的凭据来源分类，二者不是对同一个字段进行竞争覆盖。

### Draft drift policy

- adapter 固定记录实现所依据的 RFD revision date，并用官方示例维护协议 fixture；
- 同时测试 capability 缺失、method-not-found、字段增加、字段缺失、超时和畸形响应；
- Draft 改变时先更新 fixture 和 adapter，不通过 Agent 名称特判兼容；
- `auth/status` 稳定进入 ACP schema 后，优先迁移到官方 Rust SDK/generated type，
  但保持领域接口和已有 observation 数据兼容；
- 若上游撤回草案，关闭 adapter 不影响本地 Provider、真实 AuthRequired 错误或 Agent
  的安装与现有会话。

## Stable ACP capability roadmap

在可靠性修复之后，按以下顺序接入已稳定能力：

1. **`additionalDirectories`**：只有 capability 已广告时，把当前 Project/Workspace
   明确关联的额外仓库根传给 `session/new/load/resume`；不得从任意历史路径推断。
2. **`session/list` 与 `session/delete`**：提供显式“导入 Agent 会话”流程和外部会话
   删除操作。ACP session 与 VibeX Conversation 保持不同身份；列表不自动写入 VibeX
   历史，删除也不级联删除 VibeX 事件日志。
3. **`session_info_update`**：保存 Agent 侧标题/时间元数据，但 VibeX 用户标题优先；
   Agent 更新不能覆盖用户明确命名。
4. **`_meta` 传播**：以 namespaced、大小受限、可丢弃 JSON 保存 capability、content、
   tool call 与 session update 元数据；禁止凭 `_meta` 绕过显式能力或权限门禁。
5. **usage cost**：保留 context used/size 以及 amount/currency，作为 Agent 报告的累计
   观察展示，不将其当作账单权威。
6. **MCP HTTP/SSE 与内容类型**：根据协商结果转发 HTTP MCP；SSE 按 ACP/MCP 弃用状态
   仅做兼容。增加 audio、embedded resource 与 resource link 的无损领域表示，不能再
   把 Resource 静默降级为 URI 文本。

每项能力都是独立垂直切片；未完成后续能力不会阻塞本 ADR 的安装可靠性发布门禁。

## Module boundaries

当前大型 Tauri command 模块拆分为以下 Application Core 服务：

```text
Tauri commands / HTTP handlers
              |
              v
AgentManagementApplicationService
    ├── RegistryCatalogService
    ├── InstallPlanService
    ├── InstallationCoordinator
    ├── ArtifactIntegrityService
    ├── ProbeAndCapabilityService
    ├── AuthenticationObserver
    ├── NativeConfigTransactionService
    └── ManagementProjectionService
```

- command/handler 只做输入类型转换、调用和错误映射；
- Registry parser 不安装，installer 不读取可变 Registry，session runtime 不读取
  Registry；
- OpenCode、Grok Build 或其他 Agent 的差异进入声明式 Profile/Registry facts，不进入
  application service 名称分支；
- operation detail、认证状态和错误原因使用 typed record/enum，不再以 ad-hoc
  `detail_json` 承担业务契约；
- 拆分按下述垂直切片进行，不先进行无行为收益的整体搬移。

## TDD delivery plan

本 ADR 确认以下公共测试 seam：domain reducer/planner、SQLite repository、
application service、ACP fixture process、Tauri IPC 和 React UI。测试观察公共行为，
只在 HTTP、clock、filesystem/process runner 与 ACP 子进程边界使用 fake；不验证私有
调用顺序。

每个任务严格执行一个行为测试的 Red -> 最小 Green。代码审查和结构重构在该切片 Green
后单独进行，不把提前重构混进 Red/Green 循环。

### Phase 0 — characterization and migration safety

- [ ] 建立当前 Registry、operation、lock、probe、native config、capability catalog
      数据库 fixture，覆盖旧数据和部分缺失数据。
  - RED：从真实旧 fixture 读取时无法稳定生成预期 management snapshot。
  - GREEN：仅增加迁移 reader/fixture，不改变产品行为。
  - Verify：`cargo test -p db agent_management_migration_fixtures`。
- [ ] 为 Grok Build、OpenCode、Codex、Claude Code 与一个 Binary/npx/uvx 通用 Agent
      建立脱敏 ACP/Registry fixture。
  - RED：现有 fixture 无法复现 auth-required、no-auth、draft auth status 和断连状态。
  - GREEN：增加独立输入 fixture 和期望值，不加入 Agent 名称特判。
  - Verify：`cargo test -p agents management_fixture`。

### Phase 1 — release blockers: integrity and recovery

- [ ] 启动前重新验证 current lock 的每个可执行组件。
  - RED：安装后替换 Runtime 或 ACP 文件，公共 session launch 仍成功。
  - GREEN：统一 LaunchGate 重新哈希并返回 typed integrity error。
  - Acceptance：任何 hash mismatch 都不 spawn ACP；原 lock 保留并进入 needs-repair。
  - Verify：`cargo test -p agents launch_gate_integrity`。
- [ ] 恢复中断的 Queued/Running operation。
  - RED：持久化 Running 后模拟新 app instance，repair/uninstall 永久 Busy。
  - GREEN：启动协调器原子标记 Interrupted、释放租约、清理 staging。
  - Acceptance：不自动重跑；用户能够创建新的 repair operation。
  - Verify：`cargo test -p vibex agent_operation_recovery`。

### Phase 2 — immutable install target and reproducible repair

- [ ] 点击添加时冻结 snapshot/version/distribution plan。
  - RED：入队后刷新 Registry，执行器安装了刷新后的版本。
  - GREEN：operation 只消费事务内保存的 FrozenInstallPlan。
  - Verify：`cargo test -p agents install_plan_is_snapshot_stable`。
- [ ] 从 current Installation lock 完成离线 repair。
  - RED：Registry 下架/离线后 repair 失败或解析最新分发。
  - GREEN：lock 保存并重建精确来源、版本、archive/package 和 integrity policy。
  - Verify：`cargo test -p agents repair_is_registry_independent`。
- [ ] 拆分 check update 与 apply update。
  - RED：点击“检查更新”直接启动安装。
  - GREEN：check 只返回比较结果；确认后才生成 update plan。
  - Verify：Rust service test + `AgentDetail` Vitest。

### Phase 3 — scheduling and truthful projection

- [ ] 在入队事务中取得 Agent 槽位和共享资源租约。
  - RED：两个并发请求覆盖 operation id，或两个 Agent 同时写同一 shim/cache。
  - GREEN：唯一约束与 resource lease scheduler 决定 queued/running。
  - Verify：`cargo test -p agents installation_concurrency`。
- [ ] 让生产查询只使用 management reducer。
  - RED：旧 probe lifecycle 掩盖当前 failed/interrupted/current lock 事实。
  - GREEN：repository 返回 facts，service 调用同一 reducer。
  - Verify：domain table tests + service integration tests。
- [ ] 修正 installed 与 active-process 语义。
  - RED：首次安装失败被列为 installed；Disconnected probe 阻止卸载。
  - GREEN：installed 来自有效 lock，Busy 只计算活动连接/turn/operation。
  - Verify：`cargo test -p agents management_projection`。

### Phase 4 — atomic configuration and defaults

- [ ] 原生配置三方冲突与多文件原子提交。
  - RED：外部同字段修改被静默覆盖，或第二个文件失败留下第一个文件新值。
  - GREEN：prepare/resolve/commit 协议与可回滚 rename。
  - Verify：filesystem fault-injection integration tests。
- [ ] 前端提供 reload/adopt/override 冲突处理并复用底部保存栏。
  - RED：conflict 只产生 Toast，用户无法恢复。
  - GREEN：typed conflict UI 提交明确 resolution。
  - Verify：`AgentSettings` Testing Library tests，包含键盘路径。
- [ ] 接通 AgentSessionDefaultRepository。
  - RED：重启后默认丢失，或 Agent 不再广告 value 时仍发送旧值。
  - GREEN：保存 raw id/value，prepared session 验证后应用或提示回退。
  - Verify：repository + session gate + create form tests。

### Phase 5 — ACP capability truth, cleanup and `auth/status`

- [ ] 完整保存 initialize capability，删除 binding/event 的硬编码 true。
  - RED：不支持 image/load/terminal 的 fixture 仍被 UI/运行时视为支持。
  - GREEN：所有消费者读取 normalized capability snapshot。
  - Verify：ACP fixture integration + generated DTO UI tests。
- [ ] 保证 capability/auth probe 无泄漏。
  - RED：连续刷新后连接数、临时目录数增长，卸载返回 Busy。
  - GREEN：统一 ProbeScope 在所有退出路径清理。
  - Verify：成功、超时、取消、malformed response 四组 resource-count tests。
- [ ] 实现 Draft `auth/status` adapter。
  - RED：
    - 广告 `auth.status` 的 Agent 未收到查询；
    - 未广告的 Agent 被错误调用；
    - `authenticated: true` 被错误标为账号登录；
    - method-not-found 被标为安装损坏。
  - GREEN：按 capability 调用并输出稳定 AuthenticationObservation。
  - Verify：官方示例 fixture、字段扩展 fixture、timeout、unsupported、conflict tests。
- [ ] 修复 capability catalog fingerprint、generation 与 TTL。
  - RED：原生配置、认证或 provider/model 变化后继续读取旧 OpenCode 模型。
  - GREEN：匹配 fingerprint 的缓存即时展示，stale 时后台合并刷新。
  - Verify：service concurrency test + create-session UI stale/refresh tests。

### Phase 6 — Registry semantics and UI

- [ ] 下架的 Built-in entry 从 Registry 消失但保留 Agent bar membership。
  - RED：缺失官方条目被 Profile 重新注入 Registry。
  - GREEN：Registry 与 local membership 分别投影。
  - Verify：service + Registry view tests。
- [ ] 禁用 stale snapshot 的 add/update，补齐搜索、disclosure 与快照时间。
  - RED：fresh=false 仍可点击安装，作者搜索无结果。
  - GREEN：按钮和服务端共同拒绝 stale target。
  - Verify：IPC error contract + React accessibility tests。

### Phase 7 — stable ACP capability slices

- [ ] additional directories；
- [ ] session list/import；
- [ ] session delete；
- [ ] session info update；
- [ ] bounded `_meta` propagation；
- [ ] usage cost；
- [ ] HTTP MCP 和无损 content blocks。

每项分别建立 capability-present/capability-absent fixture。未广告时 UI 不显示、运行时
不调用；广告时使用 exact ACP value。任何一项不得通过 Agent 名称开启。

### Phase 8 — command-layer extraction and release gate

- [ ] 在上述行为已有测试保护后，把 application services 从大型 command 模块抽离。
- [ ] 删除 reducer 之外的状态优先级、Registry 执行期重新解析、OpenCode 业务特判和
      ad-hoc management JSON。
- [ ] 更新 generated types、SQLx metadata、ADR/spec traceability 和 release evidence。

最终验证：

```text
cargo fmt --all --check
pnpm run generate-types && pnpm run generate-types:check
pnpm run prepare-db && pnpm run prepare-db:check
cargo test -p api-types
cargo test -p db
cargo test -p agents
cargo test -p vibex
pnpm --dir frontend exec vitest run
pnpm run check
pnpm run lint
cargo test --workspace
```

真实 Agent smoke gate 至少覆盖：

- Codex、Claude Code、OpenCode、Pi；
- Grok Build；
- 一个 Binary、一个 npx、一个 uvx Registry Agent；
- 应用在安装 staging、下载后、验证后和原子切换前四个阶段分别被终止；
- Runtime/ACP 安装后被篡改；
- Registry 过期、离线、刷新期间条目升级和条目下架；
- `auth/status` 支持、未支持、超时、method-not-found 和与本地证据冲突；
- capability refresh 连续执行后无残留进程、连接或临时目录。

## Review finding traceability

### Standards axis

| Finding                                 | Decision / phase                            |
| --------------------------------------- | ------------------------------------------- |
| 中断安装在重启后永久 Busy               | Persistent operation state machine；Phase 1 |
| 生产投影绕过 reducer                    | One reducer；Phase 3                        |
| probe 泄漏连接并错误阻止卸载            | Bounded probe scope；Phase 5                |
| 完整性仅在下载时检查                    | Launch-time integrity；Phase 1              |
| 共享资源锁缺失且入队非原子              | Resource-aware scheduling；Phase 3          |
| command 层过重、状态 JSON 与 Agent 特判 | Module boundaries；Phase 8                  |

### Spec axis

| Finding                                   | Decision / phase                            |
| ----------------------------------------- | ------------------------------------------- |
| 启动前没有 SHA-256 验证                   | Launch-time integrity；Phase 1              |
| 中断安装不可恢复                          | Persistent operation state machine；Phase 1 |
| 共享资源互斥未接入                        | Resource-aware scheduling；Phase 3          |
| 安装点击目标和 freshness 未锁定           | Frozen install plan；Phase 2                |
| 配置冲突不可恢复且多文件非事务            | Transactional native configuration；Phase 4 |
| Agent 级 session defaults 未接入生产      | Agent-level defaults；Phase 4               |
| installed 与 lifecycle 混淆               | Management projection；Phase 3              |
| 下架 Built-in 仍注入且 Registry UI 不完整 | Registry projection；Phase 6                |
| 检查更新直接执行更新                      | Registry projection / update split；Phase 2 |

## Acceptance criteria

本 ADR 只有在以下条件全部满足时才完成：

1. 任一托管 Runtime/ACP 内容在安装后变化都不能启动进程，并产生可修复诊断。
2. 任意阶段退出应用后，遗留操作在下次启动成为 Interrupted，不自动重跑且不永久 Busy。
3. 用户点击时看到的版本、平台与分发就是最终执行目标。
4. Registry 离线或条目下架时，现有 lock 可以启动和修复，但不能据 stale snapshot
   添加或更新普通 Agent。
5. 所有管理快照由同一 reducer 生成；首次失败安装不进入“已安装”Tab。
6. 并发操作不会覆盖 operation，也不会同时修改同一共享 Runtime、cache、shim 或目录。
7. 配置冲突可以由用户明确解决，多文件提交不会产生部分成功。
8. Agent 默认会话选项跨重启保留，但只在当前 ACP session 仍广告时发送。
9. ACP 未广告的能力不会出现在 UI 或请求中；探测结束后没有活动连接、子进程和临时目录。
10. 广告 `auth.status` 的 Agent 使用 `auth/status`，未广告的 Agent 不被调用；查询失败不
    破坏安装状态，aggregate true 不被虚构为某种登录方式。
11. OpenCode 无需登录时可以创建会话；Grok Build 等需要认证的 Agent 返回明确
    AuthRequired，而不是 Internal error。
12. Standards 与 Spec traceability 表中的每一项都有至少一个保留的行为回归测试。

## Protocol references

- [ACP v1 Initialization and capability negotiation](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP v1 Session setup and additional directories](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 Session list](https://agentclientprotocol.com/protocol/v1/session-list)
- [ACP v1 Session delete](https://agentclientprotocol.com/protocol/v1/session-delete)
- [ACP v1 Extensibility and `_meta`](https://agentclientprotocol.com/protocol/v1/extensibility)
- [Completed RFD: Session info update](https://agentclientprotocol.com/rfds/session-info-update)
- [Completed RFD: Session context size and cost](https://agentclientprotocol.com/rfds/session-usage)
- [Draft RFD: Agent authentication state query](https://agentclientprotocol.com/rfds/get-auth-state)

## Consequences

- 安装、修复和更新的数据库记录更完整，但它们变得可恢复、可审计和可复现。
- 启动前哈希会增加少量 I/O；文件身份缓存降低正常路径成本，正确性优先于启动速度。
- `auth/status` 草案接入会产生协议维护成本，但兼容层将成本限制在 adapter 与 fixtures，
  同时立刻移除用临时 session 猜认证状态的高副作用路径。
- 对认证方法未知的普通 Agent，UI 可能显示更诚实的“已登录”，而不是错误宣称账号或
  API Key；这是草案只提供 aggregate boolean 的直接结果。
- Registry、installer、runtime 和 UI 不再共享隐式状态，代码量可能短期增加，但业务
  权威和失败恢复路径变得单一。
- 旧的硬编码能力、Agent 名称特判和死 reducer 测试必须删除，而不是继续作为 fallback。

## Considered options

- **只修复当前 Grok Build/OpenCode 特例。** 否决：同类问题来自状态和能力权威错误，
  下一个 Registry Agent 会再次触发。
- **每次执行都重新读取最新 Registry。** 否决：破坏用户确认目标，也让现有安装依赖
  上游持续在线。
- **重启后自动续跑安装。** 否决：下载/解压/切换可能已经产生副作用，自动重放无法
  证明幂等。
- **只在安装时验证 SHA-256。** 否决：安装后的文件替换正是启动信任边界。
- **继续用 `session/new` 猜认证状态。** 否决：ACP 官方 `auth/status` RFD 明确指出该
  方法既不可靠又可能产生 session 副作用。
- **等待 `auth/status` 稳定后再集成。** 否决：当前需求需要只读认证状态，且能力协商、
  隔离 adapter、tolerant decoder 与 fallback 足以控制草案漂移风险。
- **把 `authenticated: true` 一律显示为账号登录。** 否决：草案有意移除了认证方法，
  这样做会制造错误信息。
- **先整体重构 command 模块，再补测试。** 否决：无法区分结构搬移与行为修复；采用
  垂直 TDD 切片，最后抽离已被测试覆盖的边界。
