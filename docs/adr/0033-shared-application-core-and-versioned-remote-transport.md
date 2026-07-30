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

## 远程协议

VibeX Remote Protocol 从第一版起版本化并提供 capability negotiation：

- `/api/v1/capabilities` 返回 server 版本、协议版本、最低客户端版本和可用能力；
- HTTP 使用稳定 error envelope 与 operation id；
-一个 WebSocket 连接复用多资源订阅；
- Conversation attach 携带 `conversation_id` 与 `after_sequence`；
- 服务端从持久化事件日志返回 snapshot/replay 和 `high_water_mark`，之后发送实时事件；
- 客户端保存最后确认序列，重连时继续；未知的新增事件必须被保留或安全忽略，而不是
  让整个流反序列化失败；
- command 与订阅 ready/attach 必须有明确握手，消除“命令已经发事件，客户端尚未订阅”
  的竞态；
-协议 schema 从 Rust 类型/JSON Schema 生成 TypeScript，并为未来 Swift/Kotlin
  代码生成保留稳定输入。

## 安全边界

- 默认只绑定 loopback；LAN/公网监听必须由用户显式开启；
- 开启服务必须有高熵 access token，HTTP 使用 Bearer，WebSocket 使用受支持的
  subprotocol/token 握手；
- token 可轮换、撤销，并为未来设备配对派生短期一次性 token；
- CORS 使用配置允许列表，不使用通配符；
- 远程文件 API 只接受注册的 Project/Workspace/Artifact id 或作用域内相对路径，
  禁止把任意绝对路径变成远程文件浏览器；
- Office/插件控制台通过逐租约 capability token 代理；代理只允许已注册的本地端口和
  路径，不能成为 SSRF 跳板，iframe 不获得主 access token；
- 未受 TLS 保护的服务只适用于可信 loopback/LAN；公网使用必须通过 TLS 终止层。

## 桌面专属能力与移动端预留

ADR-0007 的 CEF Browser Runtime 仍是桌面专属能力。Web 客户端根据 capabilities
隐藏 CEF/CDP 功能，或使用服务器端受限 preview proxy；不得伪装为等价能力。

移动端本阶段不实现，但协议必须提前支持：

- 多 Server profile；
- 设备配对、token 撤销与最小作用域；
- 会话列表/时间线、流式 Turn、取消、权限请求和结构化问题响应；
- 后台完成通知所需的 run/conversation 摘要；
- 离线只读缓存和未知事件容忍。

是否采用 SwiftUI、Kotlin Compose 或跨平台客户端由后续 ADR 决定。

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
