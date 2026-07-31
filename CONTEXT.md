# VibeX — Ubiquitous Language

Glossary of domain terms. Keep entries implementation-free; link decisions to ADRs in `docs/adr/`.

## Agent Skill 使用规则

### 总则

1. 开始分析、设计、实现、测试或发布前，Agent 必须将任务与下列场景匹配；直接命中时，**先完整阅读对应 `SKILL.md`，再执行任务**。
2. 专用 Skill 优先，且只选择覆盖任务所需的最小集合；跨层改动应组合使用。例如新增 Tauri command 的前端入口，必须同时覆盖 IPC、前后端集成与测试。
3. 动手前先读本文件与相关 ADR。用户可见界面还必须读 `DESIGN.md`、`frontend/CLAUDE.md`，并执行相应设计 Skill。
4. 已安装不等于强制使用：只有任务直接匹配时触发。无法读取 Skill 时说明原因，并采用最接近的安全替代方案。

### 设计与前端

- **新建或重设计 UI、视觉层级和交互**：[`frontend-design`](/Users/sean/.agents/skills/frontend-design/SKILL.md) 与 [`impeccable`](/Users/sean/Documents/Projetcs/VibeX/.agents/skills/impeccable/SKILL.md)。
- **macOS/Tahoe 原生体验、平台交互或窗口外观**：[`apple-design`](/Users/sean/.agents/skills/apple-design/SKILL.md)、[`macos-app-design`](/Users/sean/.agents/skills/macos-app-design/SKILL.md)。
- **探索多个 UI 方向**：[`design-an-interface`](/Users/sean/.agents/skills/design-an-interface/SKILL.md)。**审查可用性、可访问性与 Web 规范**：[`web-design-guidelines`](/Users/sean/.agents/skills/web-design-guidelines/SKILL.md)。
- **浏览器自动化和前端 E2E 验证**：[`webapp-testing`](/Users/sean/.agents/skills/webapp-testing/SKILL.md)、[`agent-browser`](/Users/sean/.agents/skills/agent-browser/SKILL.md)、[`e2e-testing-patterns`](/Users/sean/.agents/skills/e2e-testing-patterns/SKILL.md)。

### Tauri、Rust 与桌面能力

- **任意 Tauri v2 能力或架构变更**：[`tauri-v2`](/Users/sean/.agents/skills/tauri-v2/SKILL.md)、[`understanding-tauri-architecture`](/Users/sean/.agents/skills/understanding-tauri-architecture/SKILL.md)。
- **Rust command 与前端 `invoke`**：[`calling-rust-from-tauri-frontend`](/Users/sean/.agents/skills/calling-rust-from-tauri-frontend/SKILL.md)、[`calling-frontend-from-tauri-rust`](/Users/sean/.agents/skills/calling-frontend-from-tauri-rust/SKILL.md)、[`integrating-tauri-js-frontends`](/Users/sean/.agents/skills/integrating-tauri-js-frontends/SKILL.md)、[`integrating-tauri-rust-frontends`](/Users/sean/.agents/skills/integrating-tauri-rust-frontends/SKILL.md)。**事件**：[`listening-to-tauri-events`](/Users/sean/.agents/skills/listening-to-tauri-events/SKILL.md)。
- **IPC、进程模型、生命周期、runtime authority 或安全**：[`understanding-tauri-ipc`](/Users/sean/.agents/skills/understanding-tauri-ipc/SKILL.md)、[`understanding-tauri-process-model`](/Users/sean/.agents/skills/understanding-tauri-process-model/SKILL.md)、[`understanding-tauri-lifecycle-security`](/Users/sean/.agents/skills/understanding-tauri-lifecycle-security/SKILL.md)、[`understanding-tauri-runtime-authority`](/Users/sean/.agents/skills/understanding-tauri-runtime-authority/SKILL.md)、[`understanding-tauri-ecosystem-security`](/Users/sean/.agents/skills/understanding-tauri-ecosystem-security/SKILL.md)。
- **Capabilities、permissions、scopes、CSP、HTTP headers**：[`configuring-tauri-capabilities`](/Users/sean/.agents/skills/configuring-tauri-capabilities/SKILL.md)、[`configuring-tauri-permissions`](/Users/sean/.agents/skills/configuring-tauri-permissions/SKILL.md)、[`configuring-tauri-scopes`](/Users/sean/.agents/skills/configuring-tauri-scopes/SKILL.md)、[`configuring-tauri-csp`](/Users/sean/.agents/skills/configuring-tauri-csp/SKILL.md)、[`configuring-tauri-http-headers`](/Users/sean/.agents/skills/configuring-tauri-http-headers/SKILL.md)。
- **窗口、托盘、启动屏、资源、插件、sidecar**：[`customizing-tauri-windows`](/Users/sean/.agents/skills/customizing-tauri-windows/SKILL.md)、[`adding-tauri-system-tray`](/Users/sean/.agents/skills/adding-tauri-system-tray/SKILL.md)、[`adding-tauri-splashscreen`](/Users/sean/.agents/skills/adding-tauri-splashscreen/SKILL.md)、[`managing-tauri-app-resources`](/Users/sean/.agents/skills/managing-tauri-app-resources/SKILL.md)、[`developing-tauri-plugins`](/Users/sean/.agents/skills/developing-tauri-plugins/SKILL.md)、[`managing-tauri-plugin-permissions`](/Users/sean/.agents/skills/managing-tauri-plugin-permissions/SKILL.md)、[`embedding-tauri-sidecars`](/Users/sean/.agents/skills/embedding-tauri-sidecars/SKILL.md)、[`running-nodejs-sidecar-in-tauri`](/Users/sean/.agents/skills/running-nodejs-sidecar-in-tauri/SKILL.md)。
- **配置、初始化、迁移、调试和依赖更新**：[`configuring-tauri-apps`](/Users/sean/.agents/skills/configuring-tauri-apps/SKILL.md)、[`setting-up-tauri-projects`](/Users/sean/.agents/skills/setting-up-tauri-projects/SKILL.md)、[`migrating-tauri-apps`](/Users/sean/.agents/skills/migrating-tauri-apps/SKILL.md)、[`debugging-tauri-apps`](/Users/sean/.agents/skills/debugging-tauri-apps/SKILL.md)、[`updating-tauri-dependencies`](/Users/sean/.agents/skills/updating-tauri-dependencies/SKILL.md)。
- **平台打包、签名、CI 或体积优化**：[`distributing-tauri-for-macos`](/Users/sean/.agents/skills/distributing-tauri-for-macos/SKILL.md)、[`distributing-tauri-for-windows`](/Users/sean/.agents/skills/distributing-tauri-for-windows/SKILL.md)、[`packaging-tauri-for-linux`](/Users/sean/.agents/skills/packaging-tauri-for-linux/SKILL.md)、[`distributing-tauri-for-ios`](/Users/sean/.agents/skills/distributing-tauri-for-ios/SKILL.md)、[`distributing-tauri-for-android`](/Users/sean/.agents/skills/distributing-tauri-for-android/SKILL.md)、[`signing-tauri-apps`](/Users/sean/.agents/skills/signing-tauri-apps/SKILL.md)、[`building-tauri-with-github-actions`](/Users/sean/.agents/skills/building-tauri-with-github-actions/SKILL.md)、[`using-crabnebula-cloud-with-tauri`](/Users/sean/.agents/skills/using-crabnebula-cloud-with-tauri/SKILL.md)、[`optimizing-tauri-binary-size`](/Users/sean/.agents/skills/optimizing-tauri-binary-size/SKILL.md)。

### 测试、诊断与质量

1. 新增行为或修复回归：先用 [`tdd`](/Users/sean/.agents/skills/tdd/SKILL.md) 编写失败测试，再实现最小改动。
2. Tauri API、IPC、窗口、事件或桌面流程：使用 [`testing-tauri-apps`](/Users/sean/.agents/skills/testing-tauri-apps/SKILL.md)；前端单测优先 mock IPC，E2E 按目标平台可行性选择。
3. Rust 单测与集成测试：[`rust-testing`](/Users/sean/.agents/skills/rust-testing/SKILL.md)。复杂缺陷与性能问题：[`diagnosing-bugs`](/Users/sean/.agents/skills/diagnosing-bugs/SKILL.md)。交付前审查：[`code-review`](/Users/sean/.agents/skills/code-review/SKILL.md)。
4. 类型断言迁移：[`migrate-to-shoehorn`](/Users/sean/.agents/skills/migrate-to-shoehorn/SKILL.md)。提交前 hooks：[`setup-pre-commit`](/Users/sean/.agents/skills/setup-pre-commit/SKILL.md)。Git 安全防护：[`git-guardrails-claude-code`](/Users/sean/.agents/skills/git-guardrails-claude-code/SKILL.md)。

### 规格、实现与架构

- **需求澄清、PRD 与规格驱动**：[`grill-me`](/Users/sean/.agents/skills/grill-me/SKILL.md)、[`grilling`](/Users/sean/.agents/skills/grilling/SKILL.md)、[`loop-me`](/Users/sean/.agents/skills/loop-me/SKILL.md)、[`to-prd`](/Users/sean/.agents/skills/to-prd/SKILL.md)、[`spec-driven-development`](/Users/sean/.agents/skills/spec-driven-development/SKILL.md)、[`spec-driven-workflow`](/Users/sean/.agents/skills/spec-driven-workflow/SKILL.md)。
- **按已确认 PRD 实现、拆 issue、QA、分诊与路径探索**：[`implement`](/Users/sean/.agents/skills/implement/SKILL.md)、[`to-issues`](/Users/sean/.agents/skills/to-issues/SKILL.md)、[`qa`](/Users/sean/.agents/skills/qa/SKILL.md)、[`triage`](/Users/sean/.agents/skills/triage/SKILL.md)、[`wayfinder`](/Users/sean/.agents/skills/wayfinder/SKILL.md)。
- **领域术语、架构审查与重构计划**：[`domain-modeling`](/Users/sean/.agents/skills/domain-modeling/SKILL.md)、[`ubiquitous-language`](/Users/sean/.agents/skills/ubiquitous-language/SKILL.md)、[`codebase-design`](/Users/sean/.agents/skills/codebase-design/SKILL.md)、[`improve-codebase-architecture`](/Users/sean/.agents/skills/improve-codebase-architecture/SKILL.md)、[`request-refactor-plan`](/Users/sean/.agents/skills/request-refactor-plan/SKILL.md)。
- **原型、worktree、合并冲突、交接和工程技能初始化**：[`prototype`](/Users/sean/.agents/skills/prototype/SKILL.md)、[`using-git-worktrees`](/Users/sean/.agents/skills/using-git-worktrees/SKILL.md)、[`resolving-merge-conflicts`](/Users/sean/.agents/skills/resolving-merge-conflicts/SKILL.md)、[`handoff`](/Users/sean/.agents/skills/handoff/SKILL.md)、[`setup-matt-pocock-skills`](/Users/sean/.agents/skills/setup-matt-pocock-skills/SKILL.md)。

### 其他本机 Skill

以下 Skill 也可用，但仅在用户任务明确匹配时触发：

- **Skill 发现、创建、教学**：[`find-skills`](/Users/sean/.agents/skills/find-skills/SKILL.md)、[`ask-matt`](/Users/sean/.agents/skills/ask-matt/SKILL.md)、[`skill-creator`](/Users/sean/.agents/skills/skill-creator/SKILL.md)、[`writing-great-skills`](/Users/sean/.agents/skills/writing-great-skills/SKILL.md)、[`teach`](/Users/sean/.agents/skills/teach/SKILL.md)、[`scaffold-exercises`](/Users/sean/.agents/skills/scaffold-exercises/SKILL.md)。
- **写作、知识库、Apple 文档与交互脚本**：[`edit-article`](/Users/sean/.agents/skills/edit-article/SKILL.md)、[`writing-beats`](/Users/sean/.agents/skills/writing-beats/SKILL.md)、[`writing-fragments`](/Users/sean/.agents/skills/writing-fragments/SKILL.md)、[`writing-shape`](/Users/sean/.agents/skills/writing-shape/SKILL.md)、[`obsidian-vault`](/Users/sean/.agents/skills/obsidian-vault/SKILL.md)、[`sosumi`](/Users/sean/.agents/skills/sosumi/SKILL.md)、[`wizard`](/Users/sean/.agents/skills/wizard/SKILL.md)。
- **项目能力总览**：用户要求理解本项目的能力、结构或状态时，使用 [`understand-dashboard`](/Users/sean/Documents/Projetcs/VibeX/.agents/skills/understand-dashboard/SKILL.md)。
- **Lark/飞书资源**：认证与通用能力使用 [`lark-shared`](/Users/sean/.agents/skills/lark-shared/SKILL.md)；当用户明确请求操作审批、应用、考勤、Base、日历、通讯录、文档、云盘、事件、IM、邮件、Markdown、妙记、会议纪要、OKR、OpenAPI、表格、幻灯片、任务、视频会议、白板、知识库或报告时，使用对应同名的 [`lark-*`](/Users/sean/.agents/skills) Skill。

## Conversation domain

- **Conversation（会话）** — 用户与一个 agent 之间的持久对话。其完整历史由事件日志权威记录，与任何 agent 进程的存活无关。
- **Turn（回合）** — 会话内一次"用户发起 → agent 应答完毕"的完整周期。同一会话内同一时刻至多一个 turn 在途。
- **In-flight turn（在途回合）** — 已开始、尚未到达终态的 turn。
- **Turn 终态** — 每个 turn 最终恰好落在以下四个终态之一：
  - **Completed（完成）** — agent 正常应答完毕。
  - **Failed（失败）** — agent 侧报告了错误。
  - **Cancelled（取消）** — 用户主动请求停止。
  - **Interrupted（中断）** — 宿主进程在 turn 运行期间死亡（崩溃/强杀/重启），生成过程无法恢复。与 Failed 不同：不是 agent 的错误；与 Cancelled 不同：不是用户的意图。中断的 turn 只能由用户手动重试，绝不自动重发（agent 崩溃前可能已产生副作用）。
- **Session resume（会话恢复）** — 将会话的上下文重载进一个新拉起的 agent 进程。恢复的是**上下文**，永远不是在途 turn 的生成过程。是否可恢复取决于 agent 的能力位。
- **Session rebind（会话重绑定）** — 旧 Agent session 无法继续加载时，经用户确认后为既有 Conversation 建立新的冷启动 Agent session；VibeX 历史保持不变，Agent 侧隐藏上下文不连续，后续交接内容由用户明确控制。
- **Recovery（启动恢复）** — 宿主启动时对上一次进程生命周期遗留状态的协调：将孤立的在途 turn 判定为 Interrupted，使会话回到可发起新 turn 的状态。
- **Event log（事件日志）** — 会话的权威、仅追加的历史记录。会话的一切状态都是事件的推论。
- **Projection（投影）** — 从事件日志折叠出的派生读模型。投影永远可以从事件重建，本身不是权威。
- **Timeline row（时间线行）** — 投影的最小单元：时间线上一个可独立更新的条目（一条消息、一次工具调用、一次权限请求等）。前端渲染的唯一输入。
- **Revision（行修订号）** — 单个时间线行的单调版本号，用于增量更新的幂等去重。
- **Snapshot（投影快照）** — 投影在某个事件序号处的物化缓存，纯粹是重放的加速手段，可随时丢弃重建。
- **Workspace-less conversation（无工作区会话）** — 一种不挂靠任何 Project / Workspace 的 Conversation：没有 worktree、没有隔离工作区、没有 git 面板，用于纯聊天/咨询场景。与常规会话的唯一区别是缺少 Workspace 归属；其事件日志、Turn 生命周期、恢复与中断语义与常规会话**完全一致**。因无仓库工作区，其 agent 的文件/终端工具根目录由宿主指定的**专用临时目录**提供（而非某个项目仓库），并据此成为一个能力受限的低权限模式。落地决策（数据模型 + 工作目录/沙箱）见 ADR-0006。

## Channel domain

- **Chat channel（聊天通道）** — 会话与外部 IM 之间的桥接：向外投递会话事件通知，向内接收远程命令。
- **Authorized sender（授权发送者）** — 某个聊天通道配置中被明确列入、允许下发入站命令的发送者身份。不在列表内的消息被静默丢弃；授权列表为空时该通道入站整体禁用（fail-closed）。
- **Remote approval（远程审批）** — 授权发送者经聊天通道对某条待决权限请求做出的响应。语义与桌面端权限响应完全等同：作用于同一事件日志，二者互斥消解同一请求。

## Automation domain

- **Automation（自动化）** — 一份版本化、transport-neutral 的 `TurnLaunchSpec`，保存结构化 prompt blocks、Agent/mode/config、PluginAction、workspace/branch/isolation 与 manual/schedule 触发；它不是 cron 字符串加任意命令。
- **Automation run（自动化运行）** — Automation 的一次真实执行实例，必须产生一个 Conversation 与 Turn，并由同一持久 Turn 终态投影为 completed/failed/cancelled/interrupted；`start_turn` 成功后仍是 running。
- **Automation owner（自动化所有者）** — 对同一数据目录唯一持有 Engine lease 的 desktop 或 `vibex-server` 宿主。只有 owner 可以 reconciliation、claim due 和 tick；退出后另一宿主才可接管。
- **Due claim（到期认领）** — 在同一事务内创建 Run 并推进 `next_run_at` 的操作；双 Engine/双 tick 不得产生双调度。
- **Automation isolation（自动化隔离）** — 默认每个 Run 创建独立 worktree；shared-root 必须显式选择并通过 clean/branch 检查。运行绝不自动 merge、push、publish 或 deploy。
- **Automation recovery（自动化恢复）** — 启动时把遗留 running Run 变为 Interrupted，释放锁且绝不重发对应 Turn。停机期间至多补一次最近错过的 schedule，其余错过触发不排队。
- **Automation retention（自动化保留）** — terminal Run 与其独立 worktree 默认保留 30 天，并受每个数据目录 10 GiB 配额约束；按完成时间从旧到新清理。running Run 永不参与清理，worktree 删除失败时保留 Run 证据供后续重试，目录计量不跟随符号链接。

## Plugin, Tool, and Artifact domain

- **Plugin membership（插件纳入关系）** — 插件是否属于当前 VibeX catalog；与 enabled、dependency、skill 和 provider readiness 分离。
- **Plugin activation（插件启用状态）** — 用户是否允许一个已纳入 Plugin 的后续动作；启用不能伪造 Tool、Skill 或 Provider readiness。
- **PluginAction（插件动作）** — Composer 与 Automation 共用的结构化工作流意图，由 prompt blocks、所需 Skill/Tool 与可选 Artifact intent 组成；插入动作不等于自动发送或执行。
- **Tool dependency（工具依赖）** — Plugin v2 manifest 中的声明式、精确版本、确定性平台分发；分发必须是无凭据的公网 HTTPS URL，并在执行前通过 SHA-256。
- **Tool installation lock（工具安装锁）** — 版本化托管目录中当前可执行文件、版本、平台、来源 URL 与 hash 的持久证据。Provider 只能从该 lock 获得绝对执行路径，不能把 PATH 查询作为最终语义。
- **Legacy plugin evidence（旧插件证据）** — v1 manifest 的完整只读保存；其 `install_command` 永远不能执行。只有固定 ID 且明确映射的内置插件可自动建立 v2 membership，并仍保持 disabled。
- **Artifact（产物）** — 文件系统中一个文件的持久身份；数据库只保存 relative path、revision/hash、producer Plugin/Provider/Tool-lock 与 Conversation event 证据，不保存文件内容。
- **Artifact preview lease（产物预览租约）** — 对一个已解析 Tool lock、文件、provider 进程和短期 capability 的引用计数租约；最后一个 lease 关闭、过期或进程崩溃时可回收。

## Remote and device domain

- **Application Core（应用核心）** — 不依赖 Tauri 或 Axum 的用例门面；desktop command、Web route 与 Remote Desktop adapter 都只能做认证、DTO/错误转换后调用同一公共 seam。
- **Remote protocol（远程协议）** — `remote-protocol` 的版本化稳定 ID、error envelope、capabilities、typed command 与 durable subscription DTO。v1 Schema/OpenAPI 位于 `docs/protocol/v1/`。
- **Durable attach（持久订阅附着）** — 以 Conversation sequence 为权威的 ready → snapshot/replay → high-water → live 契约；sequence 去重，未知 event kind 必须可保留或忽略。
- **Device pairing（设备配对）** — 管理员生成五分钟、只可兑换一次的 pairing secret；Server 只存 hash。兑换产生绑定 credential/device id 与批准 scopes 的 device token。
- **Device revocation（设备撤销）** — 撤销后新 HTTP 请求和已经建立的 WebSocket 都必须失效；主 token 或 device token 不得出现在 URL、事件或日志。
- **Offline conversation cache（离线会话缓存）** — 仅包含持久 sequence 与 open events 的只读缓存；`read_only` 必须为 true，不能离线排队写操作。
- **Terminal notification summary（终态通知摘要）** — 只包含 Conversation/Automation 稳定 ID、终态、时间与 operation id 的无 secret 投影；不包含 prompt、输出、诊断或文件路径，也不直接接入 APNs/FCM。

## Agent domain

- **Agent kind（agent 身份）** — Agent 的全系统唯一、稳定身份标识（如 `claude_code` 或 `codex`），回答“这是哪个 Agent”；普通 Agent 的初始标识可以由 Registry id 派生，但此后不随 Registry 条目改名或换 id 自动改变，也不是只允许固定成员的封闭枚举。
- **Agent source（Agent 来源）** — VibeX 获取 Agent 接入契约的受控来源；当前只允许 VibeX Built-in Agent Profile 与 ACP 官方 Registry，不包含用户自定义清单或自动发现。
- **Agent profile（Agent 档案）** — 驱动统一 Agent 管线的声明式接入契约，描述身份、运行拓扑、分发、检测和版本信息；来源不同不会改变安装、配置或运行语义。
- **Built-in agent（内置 agent）** — 由 VibeX 预先加入并给予默认展示策略的 Agent；当前成员为 Codex、Claude Code、OpenCode 与 Pi，它们与其他 Agent 使用同一管线，可由档案声明本地管理补缺，但不保证彼此拥有相同的管理能力。
- **Built-in agent profile（内置 agent 档案）** — VibeX 为内置 Agent 提供的 Agent 档案，可声明其本地 Runtime、ACP 适配器、检测候选、验证组合与本地管理补缺，但不能改变统一 Agent 管线的语义。
- **Agent management capability（Agent 管理能力）** — Agent 在统一设置界面中提供的认证状态、账户状态与订阅可见性等管理能力；它不包含启动账号登录、注销、ACP 持久配置写入或会话内的模型、模式与推理配置。
- **Local management fallback（本地管理补缺）** — 当 ACP 未提供某项状态管理能力时，Built-in Agent Profile 可以提供的等价本地状态探测；同一状态能力由 ACP 优先。持久配置始终通过已适配的 Agent 原生配置文件编辑，不属于补缺切换。
- **Subscription visibility（订阅可见性）** — 对 Agent 账户套餐、额度、用量与重置时间的只读呈现；购买、升级、降级和取消订阅不属于 VibeX 的 Agent 管理能力。
- **Authentication status（认证状态）** — VibeX 对 Agent 当前认证来源的只读判断：已通过账号登录、已通过 API Key 登录或暂未登录；账号登录与注销始终由官方 Agent 在 VibeX 外部完成。
- **Credential ownership（凭据所有权）** — 表明认证凭据由 Agent Runtime 配置或用户外部环境中的哪一方持有，并界定 VibeX 只能编辑其明确认识的 API Key 配置字段，不能登录、注销或删除外部环境凭据。
- **Agent-native configuration（Agent 原生配置）** — 由本地 Agent Runtime 自身持有并可在 VibeX 外部修改的持久配置；它是 VibeX 当前唯一允许编辑的持久配置来源。
- **New-session default（新会话默认偏好）** — VibeX 为某个 Agent 全局记忆、并在创建会话时尝试应用的 ACP 会话配置选择；它不是 Project 设置或 Agent 原生配置，也不会改变已经存在的会话。
- **Native ACP agent（原生 ACP agent）** — 本地 agent runtime 与 ACP server 由同一个安装物提供的 agent；它只有一个需安装和验证的运行组件。
- **Adapter-backed ACP agent（适配器型 ACP agent）** — ACP server 只负责桥接、实际能力由另一个本地 agent runtime 提供的 agent；两个运行组件都必须安装、验证并显式绑定。
- **Managed agent installation（托管 Agent 安装）** — 安装产物及其生命周期由 VibeX 所有；VibeX 可以校验、升级、修复和卸载这些产物。
- **External agent installation（外部 Agent 安装）** — 由用户或系统所有、经 VibeX 校验后接入的本地 Agent runtime；VibeX 可以使用和重新校验它，但不能擅自升级、修改或卸载它。
- **Installation attempt（安装尝试）** — 一次把 Agent 的托管组件安装、修复或更新到目标版本的有界操作；它可以完成、失败、由用户取消或因宿主退出而中断，其终态不改变 Agent 的已添加关系。
- **Installation lock（安装锁）** — 一次 Agent 安装实际采用的 Agent Runtime、ACP 适配器与基础运行环境的精确版本和来源记录；它使当前安装可以被验证、复现和安全回退。
- **Verified binary（已验证 Binary）** — 其内容与 VibeX 预先维护的预期 SHA-256 一致的 Binary；只有此类产物可以宣称经过 VibeX 完整性验证。
- **TOFU binary（首次信任 Binary）** — 官方 Registry 未提供预期校验和时，首次取得并记录内容指纹、此后严格检查该指纹的普通 Registry Binary；它不等同于已验证 Binary。
- **Installed agent（已安装 Agent）** — 所需本地运行组件已经存在且通过兼容性验证的 Agent；是否已经完成认证不影响其安装状态。
- **Ready agent（就绪 Agent）** — 已安装且满足必需认证与配置条件、可以创建新会话的 Agent。
- **Needs-auth agent（待认证 Agent）** — 已安装但尚未满足必需认证条件的 Agent；它保留在 Agent 设置中，但不能用于创建新会话。
- **Management-degraded agent（管理能力降级 Agent）** — 核心运行与必需认证能力正常、但一项或多项可选管理能力探测失败的就绪 Agent；能力降级不等同于不支持，也不等同于安装损坏。
- **Platform-unsupported agent（平台不支持 Agent）** — 已知 Agent 在当前操作系统或 CPU 架构上没有可用分发契约的状态；它不等同于安装损坏，也不会撤销已有的 Agent 身份或纳入关系。
- **Agent probe（Agent 探测）** — 对某个 Agent 的本地组件、ACP 能力、认证与管理状态进行的一次性观察；探测结果有时间属性，不代表持续监控。
- **Registry entry（注册表条目）** — 某个 agent 身份的元数据（展示名、描述、分发方式、registry id）。registry id（如 claude-acp）是条目的标识，不是身份本身。
- **Registry binding（注册表绑定）** — VibeX 明确维护的 Agent kind 与 Registry entry 对应关系；它用于合并同一 Agent 的受控信息来源，不通过名称相似性自动推断。
- **Added agent（已添加 Agent）** — 已经被纳入 VibeX Agent 集合的 Agent；内置 Agent 默认属于此集合，其他 Agent 在用户确认添加时立即进入，是否安装完成不影响此关系。
- **Available agent（可添加 Agent）** — 当前 Registry 中存在、但尚未被用户纳入 VibeX Agent 集合的 Agent。
- **Agent activation（Agent 启用状态）** — 用户是否允许某个已添加 Agent 接受后续执行的独立开关；禁用不改变其纳入、安装、认证、配置或历史状态。
- **Retired agent（退役 Agent）** — 已停止提供新增、安装和新会话能力，但为保持历史可解释性而继续保留稳定身份的旧 Agent。
- **Uninstall agent（卸载 Agent）** — 删除 VibeX 为 Agent 托管的运行组件，但保留其已添加关系、设置与历史会话，使其可以原位重新安装。
- **Remove agent（移除 Agent）** — 终止非内置 Agent 与 VibeX 的已添加关系，使其离开 Agent 导航带，并清除 VibeX 拥有的 Agent 专属设置与产物；它不删除历史会话，也不触碰外部安装。
- **Agent bar（Agent 导航带）** — “设置 → Agent”中的统一横向 Agent 选择器；所有已添加 Agent 共用同一列表，不按支持等级或安装状态分区，末位固定为打开 Registry 的添加入口。
- **ACP Registry view（ACP 注册表视图）** — 从 Agent bar 添加入口进入的 Agent 发现与管理界面，只展示当前 Registry 中仍存在的条目；条目从上游下架不会移除 Agent bar 中已经纳入的 Agent。
- **Registry snapshot（注册表快照）** — VibeX 最近一次成功获取并验证的 ACP 官方 Registry 目录副本；离线时它只提供带时间标记的浏览能力，不授权新的添加或更新。
- **History import（历史导入）** — 把外部工具（Claude Code、Codex 等）的本地会话历史接管进 VibeX 会话体系的行为。
- **Session fork（会话分叉）** — 从**当前状态**分出一个新 Conversation：新会话是原会话完整历史的独立副本（非破坏性，原会话不受影响），此后独立演化。当 agent 广告了 ACP `session/fork` 且有活会话时，agent 侧上下文也随之分叉（继续对话保有分叉前上下文）；否则新会话为无上下文副本，下次发送冷启动。从当前分叉（非历史某点），以保持可见历史与 agent 上下文一致。与 reset-to-here（在原会话上截断重来，破坏性）互为补充。语义决策见 ADR-0005（2026-07-06 更新）。

## ACP 官方参考文档

来源：ACP 官方文档索引（[llms.txt](https://agentclientprotocol.com/llms.txt)）。最后核对：2026-07-16。

### 稳定协议（v1，VibeX 实现优先参考）

- [协议概览](https://agentclientprotocol.com/protocol/v1/overview) — JSON-RPC 通信模型、基础生命周期与约定。
- [初始化](https://agentclientprotocol.com/protocol/v1/initialization) — `initialize`、版本与能力协商。
- [认证](https://agentclientprotocol.com/protocol/v1/authentication) — `authenticate` 与 `logout`。
- [会话建立](https://agentclientprotocol.com/protocol/v1/session-setup) — `session/new`、`session/load`。
- [会话列表](https://agentclientprotocol.com/protocol/v1/session-list) — `session/list`。
- [删除会话](https://agentclientprotocol.com/protocol/v1/session-delete) — `session/delete`。
- [提示回合](https://agentclientprotocol.com/protocol/v1/prompt-turn) — `session/prompt`、更新与结束原因。
- [内容](https://agentclientprotocol.com/protocol/v1/content) — 消息与内容块。
- [工具调用](https://agentclientprotocol.com/protocol/v1/tool-calls) — 工具调用、更新与权限请求。
- [文件系统](https://agentclientprotocol.com/protocol/v1/file-system) — 客户端文件读取与写入能力。
- [取消](https://agentclientprotocol.com/protocol/v1/cancellation) — `session/cancel`。
- [终端](https://agentclientprotocol.com/protocol/v1/terminals) — 终端创建、输出、等待、终止与释放。
- [Agent 计划](https://agentclientprotocol.com/protocol/v1/agent-plan) — 计划展示与更新。
- [会话模式](https://agentclientprotocol.com/protocol/v1/session-modes) — `session/set_mode` 与模式更新。
- [会话配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options) — 模型、推理等级等动态选择器。
- [斜杠命令](https://agentclientprotocol.com/protocol/v1/slash-commands) — 命令发现与更新。
- [扩展性](https://agentclientprotocol.com/protocol/v1/extensibility) — `_meta`、自定义能力与 `_` 前缀方法。
- [传输](https://agentclientprotocol.com/protocol/v1/transports) — 传输机制。
- [Schema](https://agentclientprotocol.com/protocol/v1/schema) — 完整协议类型与 JSON Schema 定义。
- [OpenAPI Schema（JSON）](https://agentclientprotocol.com/api-reference/openapi.json) — 可用于代码生成或机器校验。

### 入门、生态与实现库

- [介绍](https://agentclientprotocol.com/get-started/introduction)
- [架构](https://agentclientprotocol.com/get-started/architecture)
- [Agents](https://agentclientprotocol.com/get-started/agents)
- [Clients](https://agentclientprotocol.com/get-started/clients)
- [ACP Registry](https://agentclientprotocol.com/get-started/registry)
- [Kotlin 库](https://agentclientprotocol.com/libraries/kotlin)
- [Java 库](https://agentclientprotocol.com/libraries/java)
- [Python 库](https://agentclientprotocol.com/libraries/python)
- [Rust 库](https://agentclientprotocol.com/libraries/rust)
- [TypeScript 库](https://agentclientprotocol.com/libraries/typescript)
- [社区维护的库](https://agentclientprotocol.com/libraries/community)
- [官方 GitHub 仓库](https://github.com/agentclientprotocol/agent-client-protocol)

### RFD 与 v2 演进（设计新能力前参考）

- [RFD 流程](https://agentclientprotocol.com/rfds/about)
- [ACP Agent Registry](https://agentclientprotocol.com/rfds/acp-agent-registry)
- [额外工作区根目录](https://agentclientprotocol.com/rfds/additional-directories)
- [认证方法](https://agentclientprotocol.com/rfds/auth-methods)
- [布尔配置选项](https://agentclientprotocol.com/rfds/boolean-config-option)
- [可配置 LLM Provider](https://agentclientprotocol.com/rfds/custom-llm-endpoint)
- [Diff 中表示已删除文件](https://agentclientprotocol.com/rfds/diff-delete)
- [Elicitation：结构化用户输入](https://agentclientprotocol.com/rfds/elicitation)
- [回合结束 Token 用量](https://agentclientprotocol.com/rfds/end-turn-token-usage)
- [引入 RFD 流程](https://agentclientprotocol.com/rfds/introduce-rfd-process)
- [Logout 方法](https://agentclientprotocol.com/rfds/logout-method)
- [MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp)
- [消息 ID](https://agentclientprotocol.com/rfds/message-id)
- [Meta 字段传播约定](https://agentclientprotocol.com/rfds/meta-propagation)
- [模型配置选项类别](https://agentclientprotocol.com/rfds/model-config-category)
- [下一编辑建议](https://agentclientprotocol.com/rfds/next-edit-suggestions)
- [计划操作支持](https://agentclientprotocol.com/rfds/plan-operations)
- [通过 ACP Proxy 扩展 Agent](https://agentclientprotocol.com/rfds/proxy-chains)
- [请求取消机制](https://agentclientprotocol.com/rfds/request-cancellation)
- [基于 SACP 的 Rust SDK](https://agentclientprotocol.com/rfds/rust-sdk-v1)
- [关闭活跃会话](https://agentclientprotocol.com/rfds/session-close)
- [会话配置选项](https://agentclientprotocol.com/rfds/session-config-options)
- [删除会话](https://agentclientprotocol.com/rfds/session-delete)
- [会话分叉](https://agentclientprotocol.com/rfds/session-fork)
- [会话信息更新](https://agentclientprotocol.com/rfds/session-info-update)
- [会话列表](https://agentclientprotocol.com/rfds/session-list)
- [恢复既有会话](https://agentclientprotocol.com/rfds/session-resume)
- [会话上下文大小与成本](https://agentclientprotocol.com/rfds/session-usage)
- [Streamable HTTP 与 WebSocket 传输](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
- [RFD 更新生命周期](https://agentclientprotocol.com/rfds/updates)
- [v2 提案概览](https://agentclientprotocol.com/rfds/v2/overview)
- [v2 必需会话方法](https://agentclientprotocol.com/rfds/v2/required-session-methods)
- [v2 Prompt 生命周期](https://agentclientprotocol.com/rfds/v2/prompt)
- [v2 权限请求](https://agentclientprotocol.com/rfds/v2/permission-requests)
- [v2 消息更新与分块](https://agentclientprotocol.com/rfds/v2/message-updates)
- [v2 工具调用更新](https://agentclientprotocol.com/rfds/v2/tool-call-updates)
- [v2 计划变体](https://agentclientprotocol.com/rfds/v2/plan-variants)
- [v2 Diff 文件状态](https://agentclientprotocol.com/rfds/v2/diff-file-states)
- [v2 枚举变体扩展](https://agentclientprotocol.com/rfds/v2/enum-variant-extension)
- [v2 客户端文件系统与终端能力](https://agentclientprotocol.com/rfds/v2/client-filesystem-terminal-capabilities)
- [v2 会话恢复回放](https://agentclientprotocol.com/rfds/v2/session-resume-replay)
- [v2 终端输出](https://agentclientprotocol.com/rfds/v2/terminal-output)

### 项目、治理与更新

- [公告与更新](https://agentclientprotocol.com/updates)
- [ACP Registry 稳定化公告](https://agentclientprotocol.com/announcements/acp-agent-registry-stabilized)
- [实现信息公告](https://agentclientprotocol.com/announcements/implementation-information)
- [Logout 方法稳定化公告](https://agentclientprotocol.com/announcements/logout-method-stabilized)
- [Lead Maintainer 公告](https://agentclientprotocol.com/announcements/sergey-ignatov-lead-maintainer)
- [Session Close 稳定化公告](https://agentclientprotocol.com/announcements/session-close-stabilized)
- [Session Config Options 稳定化公告](https://agentclientprotocol.com/announcements/session-config-options-stabilized)
- [Session Info Update 稳定化公告](https://agentclientprotocol.com/announcements/session-info-update-stabilized)
- [Session List 稳定化公告](https://agentclientprotocol.com/announcements/session-list-stabilized)
- [Session Resume 稳定化公告](https://agentclientprotocol.com/announcements/session-resume-stabilized)
- [Transports Working Group 公告](https://agentclientprotocol.com/announcements/transports-working-group)
- [贡献指南](https://agentclientprotocol.com/community/contributing)
- [治理](https://agentclientprotocol.com/community/governance)
- [工作组与兴趣组](https://agentclientprotocol.com/community/working-interest-groups)
- [贡献者沟通方式](https://agentclientprotocol.com/community/communication)
- [行为准则](https://agentclientprotocol.com/community/code-of-conduct)
- [出版物、演讲与视频](https://agentclientprotocol.com/publications)
- [品牌资源](https://agentclientprotocol.com/brand)
