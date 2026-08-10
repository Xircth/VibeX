---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# 桌面与 Web 共用 Application Core 和版本化远程传输

VibeX 采用 Codeg 的多端总体方式：同一 React 应用通过 `BackendTransport` 访问同一套
Application Core；Tauri 桌面和 Axum Web Server 只是不同适配器。未来移动端作为
VibeX Server 的薄客户端，不在移动设备上运行本地 Agent、Git worktree 或 Artifact
工具。

## 进程与模块边界

```text
React UI ─ BackendTransport ┬─ TauriTransport ─ Tauri command adapter ┐
                            └─ WebTransport ─ HTTP/WS adapter ─────────┤
                                                                      ▼
                                                             Application Core
                                                                      │
                  conversations / agents / delegation / plugins / automations
```

Application Core 不依赖 `tauri::AppHandle`、窗口、WebView 或 Axum extractor。每项业务
操作只有一个 core use case；Tauri command 与 HTTP handler 负责认证、参数转换和错误
映射，不重复业务规则。独立 `vibex-server` 组装数据库、Agent runtime、Delegation
Broker、Plugin/Artifact runtime、Automation Engine 和事件总线，并托管静态 Web UI。

前端不得继续在 feature 中直接散布 `tauriInvoke`。所有业务调用和订阅收敛到
`BackendTransport`；桌面行为先通过 TauriTransport 保持，再逐个垂直切片开放
WebTransport。

## Server Profile 与窗口归属

桌面端把本机视为默认 Local Profile，并允许用户保存多个远端 Server Profile。每个
应用窗口在创建时只绑定一个 Server Profile；该窗口中的 Project、Workspace、
Conversation、Agent、设置、Git、终端与运行状态全部由同一个 Server 提供。连接另一
Server 必须打开另一窗口，不允许在同一窗口拼接本机与远端资源。

该边界使权限、凭据、capabilities、事件序列、缓存与资源标识始终具有唯一 Server
归属，避免同名资源、跨 Server 操作和断线恢复产生歧义。Server Profile 只持久化名称、
地址、排序等非秘密元数据；访问凭据由系统凭据存储独立保护，不进入普通数据库、前端
持久状态、URL 或日志。

常规桌面连接只通过设备配对建立，不在 Server Profile 表单中接收长期管理员 token。
五分钟、只可兑换一次的 pairing secret 只负责建立信任；兑换得到的 scoped device
credential 长期保存在系统凭据存储中。关闭窗口、主动断开、网络中断、应用重启以及
Server 管理员 token 轮换均不得使已配对设备失效。只有管理员撤销设备、用户显式忘记
该 Server、客户端凭据丢失或 Server 身份/数据目录被重建时才要求重新配对；撤销必须
同时终止已有 WebSocket 与后续请求。

连接生命周期提供三个不可混用的动作：Remote disconnect 只关闭当前连接并保留档案、
缓存、凭据与配对关系；Forget server 删除本地档案、只读缓存和系统凭据；Device
revocation 在 Server 上终止长期信任并立即使已有 WebSocket 与后续请求失效。关闭窗口、
退出应用和临时断网只能执行 disconnect，绝不隐式 forget 或 revoke。执行 Forget server
时若 Server 可达，客户端先撤销本设备再清理本地数据；若不可达，必须明确告知远端凭据
可能仍有效，并引导用户之后在 Server 设备管理中撤销。

## 远程桌面 P0 完成边界

远程桌面 P0 以可完成一次日常远程编码任务为验收标准，不以 Tauri command 数量或桌面
全功能等价为目标。Server-bound window 必须端到端支持：

- Project、Workspace 与 Worktree 浏览和切换；
- Conversation 创建、恢复、分叉、删除与历史；
- Turn 流式输出、取消、权限审批与结构化问题响应；
- 文件树、读取、编辑、搜索与 Diff；
- Git 状态、暂存、提交、分支与基础 Worktree 操作；
- 远程终端；
- Agent 状态、选择及启动会话所必需的配置；
- durable attach、断线重连、事件补放与只读离线缓存。

CEF/CDP 浏览器、Office 本地应用控制、完整插件与高级 Agent 安装配置、Server 备份升级
运维，以及没有进入上述闭环的桌面命令不属于 P0。它们必须通过 capabilities 明确显示为
不可用或后续能力，不得伪装成功，也不得为追求路由数量绕过 Application Core。

## 所有权模型

P0/P1 的 VibeX Server 是单一所有者、多台可信设备的本地优先服务，不是多用户或多租户
平台。桌面、浏览器与移动客户端都是同一个 Server owner 的 Paired device；每台设备有
独立 credential、scopes、审计身份与撤销生命周期，但不因此成为独立 User。

本阶段不提供账号注册、团队、成员邀请、用户间资源共享，也不按用户隔离 Project、
Conversation、Agent 凭据或文件。未来若引入协作，必须另行定义 User、组织、资源所有权
和授权模型，不能把 Device scope 扩展成隐式且不完整的多用户 RBAC。

配对界面使用人类可理解的 Device permission preset 展示用途与后果，服务端鉴权仍只认
细粒度 scopes。P0 桌面端默认申请 Developer Device 预设，覆盖 Project、Workspace、
Worktree、Conversation、Turn 交互、文件读写与搜索、Diff、Git、终端、Agent 运行状态
及启动会话所必需的配置。

Developer Device 不包含管理员 token 轮换、撤销其他设备、修改监听/TLS/网络暴露、
Server 升级恢复备份，以及安装任意 Runtime、插件或系统组件。P0 不提供逐 endpoint 的
权限勾选器；权限预设与 scopes 的映射由版本化协议定义，新增 scope 不得自动扩大旧预设。

## 远程协议

VibeX Remote Protocol 从第一版起版本化并提供 capability negotiation：

- `/api/v1/capabilities` 返回 server 版本、协议版本、最低客户端版本和可用能力；
- HTTP 使用稳定 error envelope 与 operation id；
- 一个 WebSocket 连接复用多资源订阅；
- Conversation attach 携带 `conversation_id` 与 `after_sequence`；
- 服务端从持久化事件日志返回 snapshot/replay 和 `high_water_mark`，之后发送实时事件；
- 客户端保存最后确认序列，重连时继续；未知的新增事件必须被保留或安全忽略，而不是
  让整个流反序列化失败；
- command 与订阅 ready/attach 必须有明确握手，消除“命令已经发事件，客户端尚未订阅”
  的竞态；
- 协议 schema 从 Rust 类型/JSON Schema 生成 TypeScript，并为未来 Swift/Kotlin
  代码生成保留稳定输入。

## 安全边界

- 默认只绑定 loopback；LAN/公网监听必须由用户显式开启；
- 开启服务必须有高熵 access token，HTTP 使用 Bearer，WebSocket 使用受支持的
  subprotocol/token 握手；
- 管理员 token 可轮换；设备配对使用短期一次性 secret 派生长期、可独立撤销且具最小
  scopes 的 device credential，管理员 token 轮换不得隐式撤销已配对设备；
- CORS 使用配置允许列表，不使用通配符；
- 远程文件 API 只接受注册的 Project/Workspace/Artifact id 或作用域内相对路径，
  禁止把任意绝对路径变成远程文件浏览器；
- Office/插件控制台通过逐租约 capability token 代理；代理只允许已注册的本地端口和
  路径，不能成为 SSRF 跳板，iframe 不获得主 access token；
- 未受 TLS 保护的服务只适用于可信 loopback/LAN；公网使用必须通过 TLS 终止层。

## 桌面专属能力与移动端预留

ADR-0007 的 CEF Browser Runtime 仍是桌面专属能力。Web 客户端根据 capabilities
隐藏 CEF/CDP 功能，或使用服务器端受限 preview proxy；不得伪装为等价能力。

移动端协议必须支持：

- 多 Server profile；
- 设备配对、token 撤销与最小作用域；
- 会话列表/时间线、流式 Turn、取消、权限请求和结构化问题响应；
- 后台完成通知所需的 run/conversation 摘要；
- 离线只读缓存和未知事件容忍。

P1 先交付 Android Mobile companion，并以 Android 的构建、模拟器、CI 与真实设备验收
作为完成门槛；iOS 不属于 P1，但后续必须复用同一 Remote Protocol schema、稳定 ID 与
跨平台协议验收套件，不能建立 Android 专属后端。Android 客户端的 UI 技术选择与具体
功能边界见 ADR-0041 与对应交付计划。

Android P1 是观察、沟通和决策用的 Mobile companion。它必须支持多 Server Profile、
长期设备配对、Project/Workspace 选择、Conversation 列表与搜索、时间线、实时流、
durable replay、只读离线缓存、创建/追问/取消/重试 Turn、权限审批、结构化问题响应，
以及文件内容、Diff 和 Git 状态的只读查看。它还必须能显示设备状态、重新配对和 Forget
server，但不能管理其它设备。

Android P1 不提供文件编辑、Git 写操作、任意远程终端、Agent/插件安装与高级配置、
Server 运维或 Office、CEF/CDP 等桌面能力。Server 必须通过 scopes 和 capabilities
共同约束这些边界，不能只依赖移动 UI 隐藏入口。

Android 的所有实时与写操作都要求其 Server Profile 对应的 VibeX Host 在线。Host 可以
是桌面应用或 Headless Server，但同一数据目录同一时刻只能有一个 Host；没有 Host 在线
时，Android 仅展示带最后同步时间的只读离线缓存。客户端必须持续呈现正在连接、在线、
正在恢复、离线、认证失效和版本不兼容等连接状态，并在非在线状态禁用所有写操作。

P1 不接入 FCM、第三方推送或 VibeX 云中继。前台连接可以实时更新；用户显式开启持续
监控时，Android 前台服务可以维持连接并根据不含 prompt、输出、文件路径或凭据的终态
通知摘要生成本地通知。应用被系统彻底停止或 Host 离线后不承诺即时通知，恢复连接时由
durable replay 补齐状态。任何云推送或自托管通知中继都需要后续独立决策。

## Consequences

- 当前只暴露少量 Conversation REST/SSE 的 `web_service.rs` 是迁移输入，不是最终
  Server 边界；业务逻辑必须先下沉到 Application Core。
- 自动化调度、Agent 进程和其它全局资源必须有单 owner；桌面与 Server 不能对同一
  数据目录同时各跑一份。
- Web MVP 必须使用真实生产构建的同一前端，不维护第二套管理页面。
- 可以参考和复用 Codeg 的 Transport、Axum adapter、attach/replay 以及 Office proxy
  实现，但 VibeX 应优先使用自己的持久化 Conversation sequence，而不是只依赖内存
  replay buffer。
- 直接复用 Codeg Apache-2.0 源码时，必须保留许可证和归属、标注修改文件，并维护
  来源/变更清单；架构参考不等于逐文件复制。

## Considered Options

- 为 Web 重写一套 UI：否决。它会产生持续的功能漂移和双倍验收面。
- 让 Axum handler 直接调用 Tauri commands：否决。Tauri runtime authority 和窗口
  类型不应成为 headless server 的依赖。
- 移动端直接运行本地 Agent：本阶段否决。移动设备是控制与观察客户端，Server 才是
  执行者。
