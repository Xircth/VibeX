# Host + APP 壳一致性修复与验证计划

目标：让本机纯桌面、桌面作为 Workstation Device、浏览器 Web UI 和 `vibex-server` 在产品 Host 能力上使用同一套事实、命令、参数、权限、事件和错误语义；桌面专属能力按 ADR 明确降级，不伪装成远程等价。

## 批次 0：先恢复可信基线，阻断继续漂移

优先级：立即；完成前不宣称 Host + APP parity。

1. 恢复 Rust 工具链可用性，在同一环境执行 `cargo check`、`cargo test --workspace`、clippy 和生成物检查。记录提交、toolchain、数据库准备状态。
2. 建立命令真值表：每个前端调用的命令、来源（Host/桌面壳）、required scope、DTO、实现函数、事件、副作用、错误码、capability gate、测试旅程。
3. 将 `conversation_attach` 移入 Host Registry；删除它在桌面壳清单中的位置和独立产品实现，桌面 transport 与 Server 共用同一注册表入口。
4. 为 `application_call` 建立长期 HostContext/Core；禁止每次 Tauri 调用重新构造 Core。验证缓存、automation owner、plugin runtime、preview lease、并发调用和关闭窗口行为。
5. 让生成的 `shared/hostCommands.ts`、scope 描述和前端扫描测试成为 CI 门禁；不允许新增未登记命令或 Host/壳重叠命令。
6. 清点并移除普通产品流程中的直接 Tauri 文件 API：会话导出必须提供 Web/Remote 下载路径；项目 README、`.gitignore`、LICENSE 模板必须由 Host 侧项目用例写入。

验收：所有 492 个 Host 命令均有 descriptor、scope、typed args/result、实现状态和至少一个 contract test；桌面与 Server 对同一 command 的 response/error envelope 字节级等价。

## 批次 1：先修实时一致性和生命周期

优先级：P0；直接影响“远程看到的内容是否等于桌面”。

1. 将事件分成 durable conversation、可重建 invalidation、best-effort telemetry 三类；不要给非 durable 广播伪造可恢复 cursor。
2. durable 事件使用持久序列或明确 snapshot/replay；WS attach 按 `ready -> snapshot/replay -> high-water -> live` 完成原子握手。
3. Patch stream 在注册订阅、启动 producer、捕获 high-water 和发送初始 snapshot 之间建立无丢失顺序；每类 stream 增加断线、重连、lag、重复和取消测试。
4. Server WS 对单个 subscription 返回带 `subscription_id` 的结构化错误，不因一个坏 attach 关闭整条连接；未经授权、未知资源、参数错误和版本错误分别可见。
5. RemoteDesktop Rust adapter 实现 subscription ownership、detach、abort、窗口销毁清理和 device revocation 清理；前端 iterator finally 必须能终止 Rust pump。
6. terminal output bridge 按 `(host, session, subscriber)` 去重并随订阅结束回收，验证普通 PTY 与 Agent terminal 两类来源。
7. RemoteDesktop origin 按 loopback/LAN/public 分级；公网 origin 强制 HTTPS，测试覆盖明文 token 禁止发送。

验收：人为断开网络 3 次、暂停客户端消费、撤销设备、关闭窗口和重复挂载后，时间线、项目列表、diff、文件树、Agent 状态和终端输出不重复、不永久丢失，最终状态与 Host 查询一致。

## 批次 2：命令、参数与权限全矩阵

优先级：P1；解决“看得到入口但点了才失败”和“不同壳参数含义不同”。

1. 用 schema/typed request 替代通用启发式 `request`/`payload` 合并；兼容旧 DTO 时给每个命令写明确版本和迁移测试。
2. 对 Project、Repo、Workspace、File、Git、Terminal、Agent、Plugin、Automation、Workflow、Scratch、Tag、Task、Settings 分别建立 read/write/error/scope 矩阵。
3. capability 不再只返回 scope 名称；由注册表、适配器、运行时 ready 状态和当前 credential 共同派生。缺 capability、缺 scope、依赖未 ready、Host 离线必须产生不同且稳定的结果。
4. 对 Workstation、Companion、管理员、本机 Local Profile、远程 profile 做同一命令矩阵；验证新增 scope 不扩大旧 preset。
5. 对文件 API 做 Host 路径语义测试：相对路径、项目/Workspace 作用域、越界、符号链接、手动路径选择、文件树和图片 Blob URL。

验收：每个前端可见写操作都能在 capability 不足时预先禁用或显示准确状态；服务器仍强制 scope；桌面与 Web 对同一输入得到相同成功/失败分类。

## 批次 3：按用户旅程做真实 parity 验收

优先级：P1；验证组合行为而非单函数。

旅程至少包括：

- 新建 Project、注册/克隆 Repo、创建 Workspace、切换 Worktree。
- 创建 Conversation、发送 Turn、流式文本、工具调用、权限审批、结构化问题、取消、纠偏、重试、恢复和失败。
- 文件树读取、编辑保存、搜索、Diff、Git 状态、暂存、提交、分支、冲突恢复。
- 会话 Markdown/HTML 导出；新建项目模板文件在 Host 目录中真实出现，并在远程端可下载导出结果。
- 创建/关闭/重连远程终端，包含 Agent 长期终端观察。
- Agent 安装/认证/配置/能力探测及进度事件。
- Plugin 安装、启用、授权、Runtime probe、App surface invoke、preview lease 回收。
- Workflow 创建、验证、运行、暂停、审批、恢复、Automation 创建和手动运行。
- 配对、断开、Forget server、设备撤销、旧凭据失效和多 Server-bound window 隔离。
- Telegram/飞书/微信/QQ/Webhook 的连接、task、follow-up、approve/deny、question、cancel 和终态通知。

每条旅程都在纯桌面、桌面 Workstation、浏览器 Web UI 和 Headless Server 上记录同一组断言：可见入口、request DTO、Host side effect、event sequence、最终 projection、错误码和恢复行为。

## 批次 4：发布前硬化与长期防回归

优先级：P2，但必须在发布前完成。

1. 在 CI 加入 Rust/TS 生成物新鲜度、命令注册完整性、scope-capability 一致性、Host/壳不相交、WS schema 和前端静态调用扫描。
2. 为每个 Host event channel 维护来源、payload schema、权限、durability、snapshot provider 和消费者清单。
3. 为桌面专属能力维护单独清单：CEF/CDP、Office、本机终端/编辑器、更新器、托盘、监听/TLS、设备管理、备份恢复；每个入口必须有 `desktop.tauri` 或 Host console gate。
4. 记录 remote protocol compatibility matrix：当前版本、前一小版本、最低客户端版本、未知 event kind、未知 capability、错误 envelope。
5. 加入资源和性能门槛：每窗口 WS 数量、每订阅 task 数量、Core 构造次数、PTY bridge 数量、broadcast lag、SQLite 写入延迟和长会话内存。

## 交付门槛

只有同时满足以下条件，才能把目标标记为完成：

- P0 全部关闭，且对应回归测试通过。
- 全部 Host command 有真实实现或明确 `capability_unavailable`，不存在“注册但未接管”。
- 四种客户端表面完成规定旅程；桌面专属能力均按 capability 诚实降级。
- durable attach、事件回放、重连、取消、撤销和窗口生命周期在自动化测试中通过。
- Rust、前端、生成物、数据库 metadata、clippy/lint 和目标平台 E2E 均通过，并保存测试证据。
- 报告更新为按 commit、版本、环境可复现的结果；不能用静态命令数量替代端到端证据。
