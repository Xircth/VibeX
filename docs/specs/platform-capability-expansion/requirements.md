# Requirements：插件、Office、多 Agent、自动化与 Web 平台化

## 1. 假设

1. VibeX 仍以 Tauri 桌面端为首要交付面；Web 使用同一 React UI，移动端本阶段不开发。
2. 用户启用内置 Office 插件或首次执行其动作，视为同意 VibeX 自动安装被明确展示的
   OfficeCLI 精确版本；应用启动本身不触发下载。
3. Codeg 的参考基线固定为 commit
   `549add8d3ba07f31464c9cddde8ba7a7478eed14`。后续上游变化不自动改变本规格。
4. Codeg 源码为 Apache-2.0；“直接照着做”表示优先达到同等外部行为并合法复用合适
   代码，不要求继承其文件组织或内存状态设计。
5. 本阶段多 Agent 只有 LLM-mediated delegation；确定性 Graph/Workflow
   Engineering 另行决策。
6. 同一 VibeX 数据目录可由桌面或 `vibex-server` 打开，但 Automation Engine、
   Agent runtime 等有副作用的全局资源同一时刻只有一个所有者。
7. 现有插件、自动化和 Web API 可以破坏性迁移；必须提供数据迁移/诊断，不要求保留
   不安全或错误的旧行为。

## 2. 目标

把 VibeX 从“桌面会话客户端 + 若干功能入口”扩展为统一能力平台：

- 用户通过插件安装并使用 Office 等外部能力；
- 父 Agent 可以可靠地委派、观察和取消子 Agent；
- 用户可以把一次完整的会话启动配置保存为安全、可审计的 Automation；
- 同一前端可以通过桌面或 Web 访问同一 Application Core；
- 远程协议足以支撑未来原生移动端，而无需重新定义会话生命周期。

成功不是“出现设置项”，而是每项能力能够创建真实 Turn、产生可恢复事件、展示准确
状态，并在进程崩溃、断线、取消和版本升级时保持语义。

## 3. 功能需求

### PLG — 插件与工具依赖

- **PLG-001**：插件 v2 manifest 支持 metadata、tool dependencies、skills、
  prompt actions、可选 console 和可选 artifact provider binding。
- **PLG-002**：manifest 有 schema version；未知必需字段、未知 provider 或不支持平台
  必须 fail closed，并返回稳定诊断。
- **PLG-003**：内置和第三方插件使用同一解析、安装、启用、激活和诊断服务。
- **PLG-004**：工具依赖安装到 VibeX 托管的版本目录，保存来源、精确版本、哈希、平台、
  安装时间和当前指针；不得修改用户全局包。
- **PLG-005**：工具升级在新位置验证后原子切换，失败/取消/中断不改变当前可用版本。
- **PLG-006**：插件启用、工具安装、Skill 可用、Provider 健康分别建模；UI 能指出具体
  未就绪原因。
- **PLG-007**：旧插件 v1 的任意 `install_command` 不自动执行；迁移结果要么转换为
  受支持依赖，要么标记 `migration_required`。
- **PLG-008**：插件动作使用结构化 prompt blocks，能够在 Composer 和 Automation
  编辑器中使用同一个定义，并在发送前允许用户修改/确认。
- **PLG-009**：插件/工具卸载只删除 VibeX 所有的产物；仍被运行租约引用的版本延迟清理。

### ART — Artifact 与 Office

- **ART-001**：提供 `ArtifactToolProvider` 注册表和公共 Artifact Service；Provider
  只接收已验证的精确工具路径，不自行下载安装。
- **ART-002**：Artifact 记录关联 Conversation、Turn、Workspace、路径、媒体类型、
  内容哈希、producer plugin/provider 和 revision。
- **ART-003**：文件是 Artifact 内容事实；事件日志记录创建/更新/预览/失败引用，不把
  文件字节复制为事件。
- **ART-004**：OfficeCLI Provider 复用一个文件一个 watch 进程的共享/引用计数模型，
  有最大进程数、ready 探测、崩溃回收、空闲清理和显式关闭。
- **ART-005**：首批内置 Office 插件动作至少包含创建/修改 PPTX、创建/修改 DOCX、
  分析/生成 XLSX。
- **ART-006**：OfficeCLI 未安装时，执行 Office 动作自动进入可取消的托管安装；
  成功后继续原动作，失败时保留用户输入并显示诊断。
- **ART-007**：桌面 preview 保持现有 DOCX 降级能力；Web preview 使用短期、逐租约
  capability token 和已注册端口白名单。

### DEL — 多 Agent 委派

- **DEL-001**：父 Agent 通过按会话注入的 `vibex-mcp` 暴露
  `delegate_to_agent`、`get_delegation_status` 和 `cancel_delegation`。
- **DEL-002**：注入由 ACP/MCP 能力决定，覆盖所有真正支持 `session/new.mcp_servers`
  的 Agent；不支持时返回可见 capability 状态。
- **DEL-003**：每次委派创建 one-shot 子 Conversation/Turn，并持久化 parent
  conversation、parent tool call、delegation id、agent kind 和工作目录证据。
- **DEL-004**：支持并行 fan-out、批量 wait/poll、深度限制、结果大小限制、缓存驱逐后
  数据库回退、显式取消和父级级联取消。
- **DEL-005**：setup/complete/cancel/teardown 竞态遵守 first-terminal-wins，同一
  delegation 恰好一个终态。
- **DEL-006**：Composer 使用 `&` 触发 Agent selector，保存稳定 AgentKind 的结构化
  Mention；普通 `A&B`、代码块、URL 不触发。
- **DEL-007**：发送内容以稳定 URI 序列化 Mention，并让 companion schema 明确提示
  LLM：每个 Mention 是显式委派请求。
- **DEL-008**：UI 只有在真实 delegation 启动后显示任务卡；卡片支持运行/成功/失败/
  取消、刷新恢复和打开子 Conversation。
- **DEL-009**：`ask_user_question`、`check_user_feedback`、`get_session_info` 通过
  独立 feature capability 暴露，不影响核心 delegation 可用性。

### AUT — 自动化

- **AUT-001**：Automation 保存版本化 `TurnLaunchSpec`，覆盖完整 prompt blocks、
  Agent selection、mode/config、Plugin/Skill、workspace/branch 和 isolation。
- **AUT-002**：支持 manual 与 schedule；schedule 保存 cron、IANA timezone、
  `next_run_at` UTC，并提供与后端同源的下一次运行预览。
- **AUT-003**：每次触发先创建 AutomationRun，再创建真实 Conversation 和 Turn；
  Run 跟随 Turn 直到 Completed/Failed/Cancelled/Interrupted。
- **AUT-004**：默认 `worktree_per_run`；`shared_in_root` 需要 per-root 锁、正确 branch
  和 clean worktree。
- **AUT-005**：同一 Automation 首版禁止重叠；重叠触发产生 `skipped` 记录。
- **AUT-006**：到期认领先原子推进 `next_run_at`；停机错过多个 tick 后至多 catch-up
  一次；崩溃遗留 running Run 变为 Interrupted 且不自动重放。
- **AUT-007**：每次 Run 保存实际解析的 Agent Runtime/adapter、Plugin 和 Tool
  版本证据。
- **AUT-008**：取消在每个副作用窗口检查；取消后不得继续创建 worktree、连接或发送
  Turn。
- **AUT-009**：Automation Engine 对数据目录持排他 owner lock；桌面与 Server 不会
  双重调度。
- **AUT-010**：设置页提供列表、创建/编辑、启停、立即运行、cron builder、timezone、
  Agent mode/config、Plugin action、branch、isolation、模板、运行历史和失败状态。
- **AUT-011**：首批提供代码审查、依赖检查、测试覆盖、TODO、CI 排障、Release Notes
  和安全审计模板。
- **AUT-012**：Automation 不自动 merge/push/publish/deploy；结果进入 Conversation
  和 Artifact，等待用户审查。

### WEB — Web 与共享核心

- **WEB-001**：业务 use case 下沉到不依赖 Tauri/Axum 的 Application Core；Tauri
  command 与 HTTP handler 是薄适配器。
- **WEB-002**：前端业务 API 统一经 `BackendTransport.call/subscribe`；桌面使用
  TauriTransport，Web 使用 HTTP/WebSocket。
- **WEB-003**：独立 `vibex-server` 能初始化与桌面相同的数据库、Application Core、
  Agent runtime、Delegation、Plugin/Artifact 和 Automation Engine，并托管静态前端。
- **WEB-004**：Remote Protocol 从 `/api/v1` 开始，提供 capabilities、版本兼容、
  稳定 error envelope 和 operation id。
- **WEB-005**：单 WebSocket 复用订阅；Conversation attach 使用 `after_sequence`，
  从持久事件日志返回 snapshot/replay/high-water 后进入 live。
- **WEB-006**：断线重连不丢已提交事件、不重复应用事件；未知事件不会破坏整个流。
- **WEB-007**：Web UI 覆盖项目/会话、实时 Turn、取消、权限响应、Delegation、
  Plugin/Artifact、Automation 和 Settings 的目标功能；每个未支持的桌面能力由
  capability 明确隐藏/禁用。
- **WEB-008**：默认 loopback、强制高熵 token、可配置 CORS allowlist；LAN 监听显式
  开启；公网部署文档要求 TLS。
- **WEB-009**：远程文件操作只接受作用域内 id/相对路径；preview proxy 验证租约、
  端口、capability token，并隔离 iframe origin。
- **WEB-010**：桌面可以选择连接远程 VibeX Server，事件按窗口/Server profile 隔离。

### MOB — 移动端预留

- **MOB-001**：本阶段不创建 iOS/Android 工程。
- **MOB-002**：协议 schema 可生成 TypeScript，并保留 Swift/Kotlin 生成路径。
- **MOB-003**：capabilities 支持未来的 server profile、设备配对、token 撤销、
  Conversation streaming、cancel、permission/question response 和通知摘要。
- **MOB-004**：所有客户端必须容忍未知事件，并能以只读方式缓存已确认时间线。

## 4. 非功能需求

- **NFR-001 安全**：所有下载先验证再执行；所有进程使用显式绝对路径；所有远程路径
  canonicalize 后检查 scope；secret 不进入事件、日志、URL query 或 iframe。
- **NFR-002 可恢复性**：任何运行状态都能在进程重启后成为明确终态或从持久事实协调，
  不存在永久“运行中”。
- **NFR-003 可观测性**：安装、委派、自动化和远程操作都有 operation id、结构化状态、
  有界日志和错误码。
- **NFR-004 兼容性**：协议新增字段向后兼容；破坏性变化提升协议或 manifest major
  version。
- **NFR-005 性能**：一个 WebSocket 复用订阅；Office watch 有全局上限；Agent/工具
  安装和 Automation Run 有有界并发。
- **NFR-006 可测试性**：时间、下载、进程、文件系统、Agent spawn 和事件 transport
  都通过公共 port/trait 注入 fake；测试不依赖真实网络和真实 Agent，端到端验收除外。

## 5. 非目标

- 本阶段不实现确定性 Workflow Graph。
- 不开发移动 App，不在浏览器或手机本地运行 Agent。
- 不实现在线插件市场、第三方原生 Provider 动态加载或无审查代码执行。
- 不自动 merge、push、发 PR、发布 Office 文档或部署。
- 不承诺 Web 与桌面 CEF Browser Runtime 等价。

## 6. 成功标准

1. 用户从内置 Office 插件点击“创建 PPT”，VibeX 在缺少 OfficeCLI 时完成可验证的
   自动安装，插入结构化工作流，Agent 生成文件，Artifact 出现在会话并实时预览。
2. 用户输入 `&Codex` 后，支持 MCP 的父 Agent 能创建可见子 Conversation；并行、
   取消、刷新和父进程退出均保持正确终态。
3. 用户可在增强的自动化设置中保存一次含插件/文件/Agent 配置的 Turn，定时运行在
   独立 worktree，最终状态与真实 Turn 一致。
4. 同一生产前端可分别通过 TauriTransport 和 WebTransport 完成核心会话流程，断线后
   从事件序列继续。
5. `cargo test --workspace`、前端 Vitest、协议契约测试、桌面关键 E2E、Web 关键 E2E、
   `pnpm run check` 与 `pnpm run lint` 全部通过。

## 7. 命令

```bash
pnpm install
pnpm run generate-types
pnpm run prepare-db

cargo test -p plugins
cargo test -p tool-runtime
cargo test -p artifacts
cargo test -p delegation
cargo test -p automation
cargo test -p application
cargo test -p remote-protocol
cargo test --workspace

cd frontend && pnpm exec vitest run <target-test>
cd frontend && pnpm test

pnpm run generate-types:check
pnpm run prepare-db:check
pnpm run check
pnpm run lint
pnpm run tauri:dev:desktop
```

新 crate 名是目标结构；在对应 crate 建立前，任务中的目标测试命令预期先因 package
不存在而 RED，随后由最小骨架变为可运行测试。

## 8. 边界

### Always

- 每个切片先提交/记录失败测试输出，再实现最小行为。
- 测试公共行为，不断言私有函数调用次数或内部字段布局。
- DB/query/type 变化同步运行 `prepare-db` 与 `generate-types`。
- 复用 Codeg 代码时记录 commit、源文件、修改摘要和许可证义务。
- 新状态必须有稳定错误码和崩溃协调语义。

### Ask first

- 改变本文件中的 TDD seam。
- 引入新的可执行第三方依赖、协议 major version 或第三方原生 Provider。
- 开放公网监听、自动外部副作用或 Graph Workflow。

### Never

- 为通过测试删除失败断言或绕过真实公共接口。
- 执行旧插件 manifest 的任意 `install_command`。
- 自动重放崩溃时仍在途的 Turn。
- 把主 Server token 暴露给 iframe、日志、事件或 URL query。
- 手工编辑 `shared/types.ts` 或在测试中访问用户真实 Agent/工具配置。
