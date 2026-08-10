# VibeX 远程产品化 P0/P1 改进计划

**状态：** 决策完成，尚未实施。

**日期：** 2026-08-09。

**对照基线：** VibeX `e13d2a4366e2d03f2abc4e523be91cfd626792f9`；Codeg
[`aa0c4d694870420b2caf7dba285b05dca789cecf`](https://github.com/xintaofei/codeg/commit/aa0c4d694870420b2caf7dba285b05dca789cecf)。

**决策依据：**

- [ADR-0033：桌面与 Web 共用 Application Core 和版本化远程传输](../adr/0033-shared-application-core-and-versioned-remote-transport.md)
- [ADR-0041：Android Mobile Companion 采用原生 Kotlin 与 Jetpack Compose](../adr/0041-native-kotlin-compose-android-companion.md)
- [ADR-0042：Conversation 是一等 Dockview 面板](../adr/0042-conversations-are-first-class-dockview-panels.md)

**目标：** 保留 VibeX 已有的 Application Core、版本化 Remote Protocol、持久事件
序列、设备配对与最小权限模型，把现有远程基础设施补成用户可发现、可长期连接、可完成
核心编码闭环的桌面产品；随后交付可部署 Server、Android Mobile companion 和多会话
Split View。

## 1. Outcome

P0 完成后，用户可以在桌面 VibeX 中保存多个 Server Profile，通过一次性配对建立长期
设备信任，在独立 Server-bound window 中连接桌面或 Headless VibeX Host，并完成以下
完整流程：选择 Project/Workspace、创建或恢复 Conversation、运行 Agent、处理权限和
结构化问题、查看和编辑文件、审阅 Diff、操作 Git/Worktree、使用终端，并在断线后按
持久序列恢复，不丢事件也不重复执行写操作。

P1 完成后：

1. `vibex-server` 有可验证的 Docker/Compose 与跨平台独立发行物；
2. Android 原生伴随端可以连接在线桌面或 Headless Host，查看、对话、审批和只读检查
   结果；
3. 桌面 Conversation 成为可拖拽、可分组、可持久恢复的一等 Dockview panel。

P0/P1 均不把 VibeX 变成云服务、多用户协作平台或远程 ACP endpoint。VibeX Host 仍在
用户控制的机器上运行 Agent、Git worktree、终端与 Artifact 工具。

## 2. Current-state inventory

| Area               | Existing foundation                                                                                                   | Gap to close                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Application Core   | `crates/application` 提供 transport-neutral use case 与封闭 command registry                                          | 远程 command 尚未覆盖核心编码闭环                                           |
| Remote Protocol    | `crates/remote-protocol` 提供版本、capabilities、稳定 operation id、typed DTO、pairing 与 durable subscription schema | 需要稳定 Server 身份、完整 scope preset、草稿 CAS 与更多垂直切片            |
| Headless Host      | `crates/server`/`vibex-server` 提供 HTTP、WebSocket、配对、撤销、离线缓存与静态 Web UI                                | 缺少正式容器、签名发行物和完整部署生命周期                                  |
| Desktop bridge     | `src-tauri/src/remote_desktop.rs` 已有按窗口/profile 隔离、URL 校验、HTTP call 与 capabilities                        | Profile 只在内存中，凭据从前端传入，没有用户入口或长期恢复                  |
| Frontend transport | `RemoteDesktopTransport` 已有 call/capabilities/attach 适配                                                           | `subscribe()` 仍以约 250 ms attach 轮询代替持久 WebSocket，且没有产品调用方 |
| Device security    | Server 已有一次性 pairing、scoped device credential、hash 存储、审计与撤销                                            | 桌面尚未采用 pairing-first UI，也没有系统凭据库存储                         |
| Layout             | Dockview 已有 panel、editor group、拖拽与 per-project 本地持久化                                                      | Conversation 仍是锁定的单一右侧内容实例，不能多会话并排                     |
| Draft              | `DRAFT_FOLLOW_UP` 已在 Server 数据库按 Conversation 保存                                                              | 缺少 revision/CAS，多设备可能静默覆盖                                       |
| Mobile             | 协议可生成 Kotlin/Swift 模型，并预留离线缓存与通知摘要                                                                | 没有 Android/iOS 应用工程或真实设备验收                                     |
| Documentation      | ADR-0033、协议文档与 headless 部署文档描述新架构                                                                      | 旧本机自动化文档仍声称无远程/无 Docker；README 没有准确说明交付状态         |

### 2.1 Codeg comparison conclusion

**Codeg 有远程连接功能。** 在本计划锁定的源码基线及其
[项目说明](https://github.com/xintaofei/codeg)中，桌面 Web Service、独立
`codeg-server`、Docker、HTTP/WebSocket transport 和原生移动客户端已经形成可使用的
远程产品路径；移动端连接在线桌面或独立 Server，由 Host 保留文件、Agent runtime 与
Conversation 数据。

| Codeg 已有或更成熟的部分                                 | VibeX 当前状态                                                        | VibeX 采用方式                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 可发现的远程连接管理、独立远程窗口与断线恢复             | 有 Remote Desktop bridge，但 Profile 和凭据仍是内存态，也没有正式入口 | P0 建立持久 Profile、一次配对长期信任、窗口隔离和完整连接状态机                             |
| 一个 WebSocket 复用远程事件、明确 attach/live 生命周期   | 协议与 durable attach 模型更严格，但桌面订阅仍以轮询模拟              | 保留持久 sequence 与 typed protocol，P0 删除轮询并接入真实 multiplexed WebSocket            |
| 从 Project 到 Agent、文件、Diff、Git、终端的远程工作闭环 | Application Core 基础较强，但远程 command 和 UI consumer 覆盖不足     | P0 按六个纵向切片补齐，不追求机械复制全部 Tauri command                                     |
| 独立 Server、Docker、安装脚本和跨平台分发                | Headless Host 已可运行，但正式发行、签名、升级和恢复尚未闭环          | P1-A 交付可验证、可回滚的正式 Server 产物                                                   |
| 原生 iOS/Android 伴随端                                  | 只有生成模型和移动协议预留                                            | P1 首先交付原生 Kotlin/Compose Android；iOS 后续复用同一协议                                |
| Conversation Split View、拖拽分组、布局和草稿恢复        | 已有 Dockview，但 Conversation 仍是锁定单实例；Server draft 没有 CAS  | P1-B 将 Conversation 变成一等 panel；布局不跨设备共享，draft 跨设备共享并用 revision 防冲突 |

VibeX 不复制 Codeg 的明文 Profile token、大型路由业务边界或宽松网络默认值。VibeX 已有
Application Core、typed/versioned protocol、持久 Conversation sequence、最小 scopes、
一次配对长期 credential 和 fail-closed capability 模型是更适合本项目的基础，P0/P1 只补
产品闭环，不建立第二套业务权威。

## 3. Confirmed product and domain decisions

### 3.1 Host, profile and window

- VibeX Host 可以是桌面应用或 Headless Server；同一数据目录同一时刻只有一个 Host。
- 本机是默认 Local Profile；用户可保存多个远端 Server Profile。
- 每个应用窗口只绑定一个 Server Profile。窗口中的 Project、Workspace、Conversation、
  Agent、设置、Git、终端与运行状态不得跨 Server 混用。
- 每个 Server-bound window 独立持有 transport 生命周期；凭据可复用，网络连接不跨窗口
  隐式共享。
- Server Profile 只保存稳定 id、名称、Server identity、origin、排序、最近连接与非秘密
  显示信息。device credential 只进入系统凭据存储。

### 3.2 Pair once, trust until revoked

- 常规桌面 UI 只接受五分钟、一次性的 pairing secret，不接受长期管理员 token。
- pairing secret 只建立关系；兑换后的 scoped device credential 长期有效。
- 关闭窗口、主动断开、网络变化、应用重启与管理员 token 轮换不破坏配对。
- 只有管理员撤销、用户 Forget server、本机凭据丢失，或 Server identity/数据目录重建
  才需要重新配对。
- Remote disconnect、Forget server 与 Device revocation 是三个不同动作：
  - disconnect 只关闭连接；
  - forget 删除本地 Profile、缓存与凭据，并在在线时先撤销自身；
  - revoke 在 Server 上终止信任，并立即使现有 WebSocket 与后续请求失效。

### 3.3 Ownership and authorization

- P0/P1 是单一 Server owner、多台 Paired device，不支持 User、团队或多租户。
- 桌面默认申请 Developer Device permission preset；底层授权仍使用细粒度 scopes。
- Developer Device 允许核心编码闭环，但不允许管理员 token、其它设备、网络暴露、升级、
  恢复、备份及任意 Runtime/插件安装管理。
- scope 与 capability 缺失必须 fail-closed。UI 隐藏不是安全边界。

### 3.4 Offline and connection truth

- HTTP command 不离线排队，不自动重发未知结果的写操作。
- 离线只读缓存包含最后确认 sequence、open interaction 与最后同步时间。
- 客户端统一呈现 `connecting`、`online`、`recovering`、`offline`、`auth_required`、
  `incompatible` 状态；非 online 状态禁止写操作。
- durable attach 使用 ready → snapshot/replay → high-water → live，重连从最后确认 sequence
  继续；未知事件保留或安全降级。

## 4. P0 — Remote coding loop

P0 的完成标准是“用户可在远程 Host 上独立完成一次日常编码任务”，不是“所有 Tauri
command 都有远程路由”。每个子阶段必须形成一个可运行的纵向切片。

### P0.0 — Freeze baselines and protocol guardrails

**Deliverables**

- 为当前 Local/Tauri、Web 与 Remote Desktop transport 建立相同行为 fixture；
- 固定 capabilities、error envelope、operation id、attach/replay、撤销与未知事件基线；
- 在 Remote Protocol 增加稳定 `server_instance_id`，由数据目录持有，并在 pairing
  redemption 与已认证 capabilities 中返回；地址和 Profile 名称变化不改变身份，数据目录
  重建必须改变身份；
- 定义版本化 Developer Device preset → scope 映射；新增 scope 不自动进入旧映射；
- 为每个 P0 capability 建立 command、scope、transport、UI consumer 与测试的登记表；
- 将现有 250 ms polling 固定为待删除的 characterization，不把它扩展到新功能。

**Exit gate**

- schema/OpenAPI/TypeScript/Kotlin 生成结果一致；
- Local/Tauri 的既有行为无变化；
- Server identity、capability mismatch 与 revoke fixture 可重复运行。

### P0.1 — Persistent Server Profile and pairing-first desktop UX

**Domain/storage**

- 建立持久 Server Profile repository，只保存非秘密元数据；
- 为 Windows Credential Manager、macOS Keychain 与 Linux Secret Service 建立统一
  `DeviceCredentialStore` seam；无安全存储时 fail-closed，不退回明文数据库或配置文件；
- 保存 stable profile id、server instance id 与 credential locator，不保存 token value；
- Profile origin 变化必须重新配对，不能为探测未知 Host 而发送旧 credential；重新配对后
  若 Server identity 相同则保留 Profile 和布局，身份变化则要求用户明确确认。

**Desktop UX**

- Server Profile 管理：列表、创建、重命名、排序、测试、打开、断开、Forget server；
- 配对流程：输入 origin → 无凭据 health check → 输入一次性 secret → 展示 Developer
  Device 权限 → 兑换并取得 Server identity → 凭据入系统存储 → 获取已认证 capabilities →
  打开 Server-bound window；
- 不提供长期管理员 token 输入框；
- Profile 行与窗口持续显示连接状态、Server/协议版本、最后同步时间和可操作恢复入口；
- 应用重启恢复窗口与 Profile 绑定，凭据可用时直接连接；凭据缺失进入 `auth_required`；
- Forget server 在线时先撤销本设备，离线时明确警告远端 credential 可能仍有效。

**Exit gate**

- 用户配对一次后，重启两端、断网重连、Profile 改名和管理员 token 轮换均无需重新配对；
- 日志、数据库、前端 store、URL、崩溃报告与 diagnostics 中均找不到 device credential；
- 两个窗口绑定不同 Profile 时不会交叉发送 command、event、cache 或 capability。

### P0.2 — Real desktop WebSocket bridge

- Rust 侧为每个 Server-bound window 建立一个 multiplexed Remote Protocol WebSocket；
- 一个连接承载多个 Conversation/Project 订阅，命令 ready 与 subscription attach 有显式
  握手；
- 实现 heartbeat、指数退避加 jitter、网络恢复、认证失效和版本不兼容状态机；
- outbound command queue 必须有界；超过上限返回稳定 backpressure error，不丢弃或无限
  堆积；
- 记录 operation id，网络错误时区分“确认未发送”与“结果未知”，结果未知的 mutation
  只能查询/reconcile，不能自动重发；
- 每个订阅保存最后确认 sequence，按 durable attach 补放并去重；
- 窗口关闭、Profile disconnect/forget、credential revoke 与应用退出都清理 socket、任务、
  queue 和订阅；一个窗口清理不影响另一个窗口；
- 删除 `RemoteDesktopTransport.subscribe()` 的 250 ms polling 路径，RemoteDesktop、Web
  与 Tauri transport 向上提供同一订阅语义。

**Exit gate**

- 在 command 先于订阅 ready、socket 中断、Server 重启、事件突发和 token revoke 场景下，
  无事件丢失、重复 mutation、无限队列或残留任务；
- 10 个 Conversation 订阅只使用一个窗口级 WebSocket。

### P0.3 — Core workflow command slices

每个切片遵循同一路径：Application Core use case → remote command registry → scope/capability
→ HTTP/WS adapter → BackendTransport → React consumer → Local/Web/Remote parity tests。

#### Slice A — Project, Workspace and Worktree

- 列出、读取和选择 Project/Workspace/Worktree；
- 创建编码任务所需的 Workspace/Worktree；
- 只接受注册 id 与 scope 内路径；不提供远程任意绝对路径浏览；
- Host 侧保持 worktree、branch 与 active owner 的唯一权威。

#### Slice B — Conversation and Turn

- Conversation list/search/create/read/rename/fork/delete；
- Agent session new/resume/rebind 所需的产品意图，不暴露远程 ACP endpoint；
- Turn submit/cancel/retry、队列、permission、elicitation 和 terminal status；
- Timeline snapshot/replay/live 与 open interaction 恢复；
- 保留 Completed/Failed/Cancelled/Interrupted 终态和“不自动重发 Interrupted Turn”。

#### Slice C — Files, search and Diff

- Workspace 范围内文件树、读取、文本编辑、搜索与 Diff；
- 所有路径经 Project/Workspace/Artifact identity 解析和 canonical containment；
- 写入使用 revision/hash 前置条件，冲突返回双方版本，不做 last-write-wins；
- 大文件、二进制、symlink、路径穿越和响应大小有明确限制与错误码。

#### Slice D — Git and Worktree operations

- status、diff、history、branch、stage、unstage、commit 与基础 Worktree 操作；
- 操作目标只能是已注册 repo/worktree，禁止客户端提供任意 cwd；
- destructive 或外部副作用操作沿用现有确认边界；P0 不新增自动 push、merge、publish 或
  deploy 权限。

#### Slice E — Remote terminal

- 在已注册 Workspace 中创建、输入、resize、读取与关闭 PTY；
- terminal id 绑定 device、window、workspace 与 lease，不能跨 scope 接管；
- 输出分帧、限速、有界缓存并在断线后明确声明可恢复范围；
- Developer Device 可以在其 Workspace 终端执行命令，但不能通过 API 选择任意 Host cwd。

#### Slice F — Agent readiness

- 列出 Agent、运行/认证/预检状态、能力和可选 Session 配置；
- 允许选择 Agent 并创建/恢复会话，以及编辑启动会话所必需的安全设置；
- P0 不开放任意 Runtime 安装、插件安装、管理员账号动作或高级本机维护；缺失 Runtime 时
  返回“需要在 Host 管理”的可恢复状态。

### P0.4 — Shared Conversation draft with CAS

- `DRAFT_FOLLOW_UP` 增加单调 revision 与 compare-and-set update；
- draft 属于 Conversation，在桌面、Web 与 Android 之间共享；
- debounced save 携带 `base_revision`，冲突响应同时返回 Server draft 与 current revision；
- 客户端保留本机未保存版本，提供保留本机、采用 Server 或人工合并，不静默覆盖；
- Turn 提交以 draft revision/content digest 关联，仅在提交成功且 revision 仍匹配时清除；
- 本地附件先上传/登记为 scope 内 Artifact，只有 Artifact id 可以进入跨设备 draft；
- draft 是可删除的工作状态，不进入 Conversation Event Log，也不成为历史权威。

### P0.5 — Capability-driven remote UI

- 所有 feature 只经当前窗口的 `BackendTransport`，不直接调用全局 `tauriInvoke`；
- capability 不存在时隐藏创建入口，并在已恢复布局/深链中显示明确不可用状态；
- CEF/CDP、Office 本地控制、完整插件与高级 Agent 管理保持 desktop-only；
- offline 显示缓存、最后同步和 pending interaction，但所有 mutation disabled；
- `auth_required` 只提供重新配对，`incompatible` 显示 Server/client 版本要求，不能降级到
  未版本化路由；
- UI 文案只帮助连接、判断和恢复，不展示 transport、queue 或 token 实现说明。

### P0.6 — Release gates

**Required automated matrix**

- Rust：Application Core、remote registry、auth/pairing/revocation、Server router、WS、文件
  containment、Git/PTY lease、draft CAS；
- Protocol：schema snapshot、OpenAPI、unknown event、old/new client compatibility、scope preset；
- Frontend：Profile/pairing、window binding、connection state、offline disabling、每个 workflow
  slice 的 transport-contract tests；
- E2E：桌面 → 桌面 Host、桌面 → Headless Host、Web → Headless Host；
- Fault injection：Server restart、socket loss、slow consumer、queue saturation、revoke、version
  mismatch、event between command and attach、credential store unavailable；
- Security：credential redaction、URL validation、TLS except loopback、CORS、path traversal、SSRF、
  scope denial 与跨窗口隔离。

**P0 user journeys**

1. 首次配对并在远程窗口完成一次文件修改、测试、Diff、stage 与 commit；
2. Agent 运行中断网，重连后补齐 Timeline，不重复发起 Turn；
3. 关闭应用再打开，直接复用长期 credential；
4. 管理员 token 轮换后 Paired device 继续工作；
5. Device revoke 后现有 socket 断开，所有写操作失败并要求重新配对；
6. 离线时可读缓存但无法发送、审批、编辑、Git 或终端输入；
7. 两个窗口连接不同 Host，任何资源、事件、布局和凭据都不串线。

## 5. P1-A — Server distribution

P1 首先稳定 Host 发行物，Android 才以这些正式产物作为集成目标。

### Deliverables

- GHCR 官方 Linux `amd64`/`arm64` image，固定 tag 与 immutable digest；
- Compose 示例包含只读 image、持久数据卷、健康检查、graceful stop、资源限制示例与升级
  前备份步骤；
- Windows x64、macOS arm64/x64、Linux amd64/arm64 的独立 `vibex-server`；
- release checksum、签名、SBOM、依赖许可证和 provenance；
- 安装 helper 只下载显式版本并验证，不能静默执行未验证 latest；
- 首次启动、生成/保管管理员 token、设备配对、TLS reverse proxy、升级、备份、恢复、回滚、
  revoke 与数据目录 owner 切换文档；
- CI 对每个产物运行 `server:package-smoke`、schema check、认证/未认证 capabilities、静态 UI、
  WebSocket、graceful shutdown 与无 secret 输出检查。

### Boundaries

- 默认 loopback；LAN/公网需要显式 opt-in 和 Caddy/Traefik/Nginx 等外部 TLS；
- 不承诺 Kubernetes、多节点、HA、托管云或内置公网 TLS；
- SQLite 数据目录、Agent runtime 和 Automation Engine 仍是单 Host owner；
- rollback 必须以完整一致的数据目录快照为单位，不能只回滚 binary。

## 6. P1-B — Conversation Split View

Split View 可与 Server/Android 工作线并行，但共享 draft CAS 必须复用 P0 Application Core。

### Deliverables

- Conversation panel 成为 Dockview registry 中的一等 panel type，默认在右侧打开；
- 可拖入编辑区、在 group 内形成 tabs、向四个方向拆分；同屏最多三个 Conversation group；
- 同一 Server-bound window 中一个 Conversation 只有一个 panel，再次打开聚焦现有实例；
- 每个 panel 独立持有 timeline subscription、scroll anchor、composer view、pending interaction
  与 accessibility focus；共享的 Conversation/Turn truth 来自 store/Application Core；
- 关闭 panel 只关闭视图，不 cancel Turn、不 close Agent session、不 delete Conversation；
- 删除全局单会话 DOM re-parenting 假设，不新增 nested splitter；
- Dockview layout/open tabs/sizes/active tab/scroll 只在当前设备持久化，按 stable Server identity、
  Project 与 window identity 隔离，不跨设备同步；
- Profile 改名/origin 更新不丢布局；Server identity 变化不自动套用旧布局；
- keyboard move/split/close/focus、drag target、窄窗口降级与 screen reader label 完整可用。

### Tests and acceptance

- 打开三个同时运行的 Conversation，各自流式更新、审批和草稿不串线；
- 重复打开聚焦而不复制订阅；移动/分组/关闭不影响 Turn；
- 重启恢复布局时不存在已删除 Conversation 的崩溃 panel；无权限/无 capability panel 显示
  可恢复占位；
- 不同 Server/Profile/Project/window 的布局 key 无碰撞；
- Dockview serialization migration 可回退，旧布局恢复失败时只重建布局，不损坏 Conversation。

## 7. P1-C — Android Mobile companion

Android 在 P1-A 的真实桌面/Headless Host 与 P0 稳定协议上交付。技术选择见 ADR-0041。

### Architecture

- 原生 Kotlin + Jetpack Compose；不引入跨平台 UI runtime；
- Rust schema 生成 Kotlin wire models；Android 不手写第二份协议权威；
- domain reducer 消费 snapshot/replay/live fixture，与 TypeScript/Rust 使用同一 golden cases；
- 多 Server Profile 非秘密元数据进入应用数据库，device credential 进入 Android Keystore
  支持的安全存储；日志、deep link、intent、backup 与 crash report 不含 credential；
- 每个 Profile 有独立 HTTP/WS client、sequence checkpoint、离线缓存与连接状态；
- scope/capability 双重 gate，移动 UI 隐藏不构成授权。

### Included experience

- Profile create/rename/reorder/test/disconnect/forget、一次 pairing 长期复用；
- `connecting`/`online`/`recovering`/`offline`/`auth_required`/`incompatible` 和最后同步时间；
- Project/Workspace 选择，Conversation 列表、搜索、Timeline 与只读离线缓存；
- durable live stream、create/follow-up/cancel/retry Turn；
- permission approval、elicitation/structured question response；
- 文件内容、Diff 与 Git status 只读查看；
- 前台实时更新；用户显式开启持续监控时，以 Android foreground service 维持连接并根据
  最小 Terminal notification summary 生成本地通知。

### Excluded experience

- 文件编辑、Git mutation、任意远程 terminal；
- Agent/插件安装、高级配置、Server 运维与其它设备管理；
- Office、CEF/CDP 或任何移动端本地 Agent/Git/Artifact runtime；
- FCM、第三方推送、VibeX 云中继或应用被系统彻底停止后的保证送达；
- iOS 交付。iOS 后续复用协议与 fixture，但独立选择原生 UI。

### Android release gates

- unit：协议 decode、unknown event、reducer、sequence checkpoint、draft CAS conflict、scope gate；
- instrumentation：Keystore、本地缓存迁移、进程恢复、前台服务、无障碍与 deep link 安全；
- contract：桌面 Host 与 Headless Host 的 capabilities、pairing、revoke、WS replay；
- fault：横竖屏、进程被杀、网络切换、Host offline/restart、credential revoke/version mismatch；
- real device：至少一个当前 Android 与一个最低支持版本，覆盖 pairing → Turn → approval →
  offline → reconnect；
- release：签名、最小权限、网络安全配置、备份排除、依赖清单与隐私说明。

## 8. Documentation and migration

- `CONTEXT.md` 维护 Server owner、VibeX Host、Server Profile、Server-bound window、Remote
  disconnect、Forget server、Paired device、permission preset、Remote coding loop、Mobile
  companion、Conversation panel 与 Conversation draft 的唯一语义；
- ADR-0033 继续拥有 Application Core、Remote Protocol、安全、窗口归属、设备信任与移动
  边界；ADR-0041/0042 分别拥有 Android 技术和 Conversation panel 选择；
- `docs/local-automation-api.md` 只描述 legacy loopback automation API，并明确它不是
  Remote Protocol/Headless Server；
- `docs/deployment/headless-server.md` 区分当前 source/package-smoke 与尚未交付的 P1 产物；
- README 中准确说明目前已有基础和计划状态，不把 P0/P1 写成已发布功能；
- 每个 P0/P1 slice 同步更新 protocol schema、capability registry、scope table、部署文档、
  release evidence 与升级/回滚说明；
- 功能正式切换后删除 polling、旧 Profile DTO、单会话 DOM host 和冲突陈述，不保留双权威。

## 9. Delivery order and dependency graph

```text
P0.0 protocol/identity guardrails
  -> P0.1 profiles + secure pairing
  -> P0.2 desktop WebSocket bridge
  -> P0.3 core workflow slices
  -> P0.4 shared draft CAS
  -> P0.5 capability UI
  -> P0.6 remote coding loop release gate

P0 complete
  -> P1-A signed Server distribution
       -> P1-C Android integration and release

P0.4 + existing Dockview
  -> P1-B Conversation Split View (may run parallel with P1-A/P1-C)
```

Documentation, generated protocol artifacts and compatibility tests are completion criteria of each slice,
not a cleanup phase at the end.

## 10. Suggested commit boundaries

| Track         | Commit intent examples                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| P0 identity   | `feat(remote): add stable server instance identity`                                                     |
| P0 scopes     | `feat(remote): version developer device scope preset`                                                   |
| P0 profile    | `feat(remote): persist non-secret server profiles`                                                      |
| P0 credential | `feat(remote): store paired credentials in system vault`                                                |
| P0 UX         | `feat(remote): add pairing-first server profile flow`                                                   |
| P0 transport  | `feat(remote): bridge multiplexed desktop websocket`                                                    |
| P0 cleanup    | `refactor(remote): remove attach polling transport`                                                     |
| P0 slices     | 每个 Project/Conversation/File/Git/Terminal/Agent 垂直切片独立提交                                      |
| Draft         | `feat(conversations): protect shared drafts with revisions`                                             |
| Distribution  | image、standalone package、signing/provenance、docs 分开提交                                            |
| Split View    | panel identity、instance state、drag/split、persistence migration 分开提交                              |
| Android       | project scaffold、generated models、auth/profile、timeline、actions、read-only review、release 分开提交 |

每个提交先建立失败测试或 characterization，再做最小实现；不得把多个业务切片塞入同一
“remote parity”提交。

## 11. Global verification commands

```bash
pnpm run remote-protocol-schema:check
pnpm run generate-types:check
pnpm run prepare-db:check
cargo test -p application
cargo test -p remote-protocol
cargo test -p server
cargo test --workspace
cd frontend && pnpm test
cd frontend && pnpm run test:e2e:web
pnpm run server:package-smoke
pnpm run check
pnpm run lint
```

Android 工程建立后必须补充 Gradle unit、lint、assemble、instrumentation 与协议 fixture
命令，并纳入 CI；不能用 Rust/TypeScript 测试代替真实 Android 构建。

## 12. Explicitly out of scope

- 远程 ACP URL、ACP-over-HTTP/WebSocket 或移动端本地 Agent runtime；
- 多用户、团队、组织、邀请、资源共享和多租户 RBAC；
- 离线 mutation queue 或自动重放结果未知的命令；
- 自动 push、merge、publish、deploy 或远程任意 Host 路径/命令入口；
- P0 的 CEF/CDP、Office、完整插件与高级 Agent 安装配置远程化；
- Kubernetes、多节点、HA、VibeX 托管云、内置公网 TLS；
- FCM/第三方/VibeX 云推送；
- iOS 客户端；
- 为追求 Codeg route 数量复制业务逻辑、降低 TLS/credential/path 安全边界。

## 13. Definition of done

P0 只有在七条 user journey 全部通过、polling 与明文 credential path 被删除、核心编码
闭环不依赖本地 Tauri fallback 时才完成。P1 只有在正式 Server 产物可验证部署、Android
通过真实 Host/设备验收、Split View 不破坏 Conversation/Turn/draft 语义，且所有文档与
generated artifacts 无冲突时才完成。

任何子系统“已有接口但没有产品入口”“只在测试 fixture 可用”“仅隐藏未授权按钮”或
“文档宣称完成但 release artifact 不存在”都不计为完成。
