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
- **浏览器自动化和前端 E2E 验证**：[`webapp-testing`](/Users/sean/.agents/skills/webapp-testing/SKILL.md)、[`e2e-testing-patterns`](/Users/sean/.agents/skills/e2e-testing-patterns/SKILL.md)。

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
- **Conversation panel（会话面板）** — 在 Server-bound window 中呈现一个 Conversation 的唯一 Dockview 视图；同一窗口重复打开只聚焦已有面板，关闭或移动面板只改变布局，不取消在途 Turn，也不删除 Conversation。
- **Conversation draft（会话草稿）** — 属于 Server 上某个 Conversation、可由已授权设备继续编辑的未提交 Composer 内容；每次保存基于 revision，冲突必须保留服务器版本与本机版本，不能静默覆盖。
- **Session auxiliary capability（会话辅助能力）** — Composer 与时间线周围的用量、计划、目标、压缩、草稿与查找只呈现 Agent 或用户明确给出的事实；缺失保持缺失，不得从自由文本或本地化文案反推，也不得把未知填成零或成功。见 [ADR-0058](docs/adr/0058-session-auxiliary-capability-honesty.md)。
- **Conversation input（会话输入）** — 已被 Server 接受、等待产生新 Turn 的持久用户意图；它与未提交的 Conversation draft、向在途 Turn 纠偏的 Steering 都不同。
- **Queued conversation input（排队会话输入）** — 尚未被认领并绑定到 Turn 的 Conversation input；同一 Conversation 的多个输入具有稳定顺序，可由所有已授权设备一致查看和修改。
- **Turn steering（回合纠偏）** — 用户针对指定在途 Turn 追加的即时指导；它属于该 Turn，不创建新 Turn，也不能在 Agent 不支持时静默变成排队输入。
- **Turn（回合）** — 会话内一次“用户发起 → agent 应答完毕”的完整周期。同一会话内同一时刻至多一个 turn 在途。
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
- **Conversation relation（会话关系）** — 两个独立 Conversation 之间用于导航、可见性和汇总的亲子关系；它不共享历史，也不参与任一 Conversation 的事件读取。
- **Delegated conversation（委派会话）** — 父 Conversation 为一项明确任务创建的 child Conversation；其 Conversation 与 Turn 事实独立持久化，父级只持有关系、策略和结果摘要。
- **Agent mention（Agent 提及）** — Composer 中用 `&` 插入的结构化引用，表示用户要求父 Agent 考虑把工作委派给该 Agent。它不是前端直接创建子会话的命令。仅当多智能体协同插件已启用、且当前 Conversation 已在启用后完成投递时出现。见 ADR-0031 与 ADR-0057。

会话输入、纠偏、关系与委派策略见
[ADR-0044](docs/adr/0044-conversation-control-plane-and-durable-inputs.md)。
会话辅助能力的事实来源见
[ADR-0058](docs/adr/0058-session-auxiliary-capability-honesty.md)。

- **Workspace-less conversation（无工作区会话）** — 一种不挂靠任何 Project / Workspace 的 Conversation：没有 worktree、没有隔离工作区、没有 git 面板，用于纯聊天/咨询场景。与常规会话的唯一区别是缺少 Workspace 归属；其事件日志、Turn 生命周期、恢复与中断语义与常规会话**完全一致**。因无仓库工作区，其 agent 的文件/终端工具根目录由宿主指定的**专用临时目录**提供（而非某个项目仓库），并据此成为一个能力受限的低权限模式。落地决策（数据模型 + 工作目录/沙箱）见 ADR-0006。

## Channel domain

- **Chat channel（聊天通道）** — 会话与外部 IM 之间的桥接：向外投递会话事件通知，向内接收远程命令。它不是 Paired device，配置、入站循环与出站投递都属于当前 Host（桌面与 `vibex-server` 同一接缝）。授权发送者可用 folder/agent/task/sessions/resume/cancel/approve/deny/answer/search/today/status 完成与桌面等价的工作闭环；未绑定会话时，已选 Project 与 Agent 上的 task 会新建 Conversation。见 [ADR-0056](docs/adr/0056-chat-channel-and-remote-access-codeg-parity.md) 与 [ADR-0062](docs/adr/0062-chat-channel-host-closed-loop.md)。
- **Telegram topic mode（Telegram 主题模式）** — 论坛超群中一题一会话；总题忽略纯文本；总题上的 task 创建新主题并绑定该会话。
- **Weixin iLink（微信 iLink 机器人）** — 扫码接入的可收发微信机器人。企业微信群机器人只出站。二者由 `config.mode` 区分，事件发送走各自 API。
- **Authorized sender（授权发送者）** — 某个聊天通道配置中被明确列入、允许下发入站命令的发送者身份。绑定的 chat/group 目标也视为该聊天可信。不在列表内的消息被静默丢弃；既无绑定目标也无授权列表时该通道入站整体禁用（fail-closed）。
- **Remote approval（远程审批）** — 授权发送者经聊天通道对某条待决权限请求做出的响应。语义与桌面端权限响应完全等同：作用于同一事件日志，二者互斥消解同一请求。
- **Remote question answer（远程提问答复）** — 授权发送者经聊天通道对某条待决提问做出的响应。语义与桌面端 elicitation 答复完全等同。

## Automation domain

- **Automation（自动化）** — 一份版本化的触发配置，在 manual 或 schedule 条件满足时启动一个 Turn 或一个版本化 Workflow；它不是 cron 字符串加任意命令。
- **Single-conversation automation（单次会话自动化）** — 目标为直接创建一个普通 Turn 的 Automation；“单次会话”是产品文案，领域模型仍使用 Turn，不引入含义不明确的 Common 目标类型。
- **Automation spec（自动化规格）** — 可复制、粘贴和版本化的 Automation 创作配置，使用显式格式版本与 Turn/Workflow target union；它不包含数据库身份、运行历史、引擎调度状态、凭据或机器相关路径，导入后必须先解析当前 Host 的 Workspace、Agent 与 Workflow 引用并保持禁用，直到用户确认启用。
- **Automation target kind（自动化目标类型）** — Automation 创建时确定的 Turn 或 Workflow 目标类别；类别在其生命周期内不可切换，也不提供保持同一 Automation 身份的隐式转换。
- **Automation run（自动化运行）** — Automation 的一次真实触发实例；它记录触发与目标运行的关联，终态由对应 Turn 或 Workflow run 的持久事实决定。
- **Automation owner（自动化所有者）** — 对同一数据目录唯一持有 Engine lease 的 desktop 或 `vibex-server` 宿主。只有 owner 可以 reconciliation、claim due 和 tick；退出后另一宿主才可接管。
- **Due claim（到期认领）** — 在同一事务内创建 Run 并推进 `next_run_at` 的操作；双 Engine/双 tick 不得产生双调度。
- **Automation isolation（自动化隔离）** — 默认每个 Run 创建独立 worktree；shared-root 必须显式选择并通过 clean/branch 检查。运行绝不自动 merge、push、publish 或 deploy。
- **Automation recovery（自动化恢复）** — 启动时把遗留的 direct-Turn Run 变为 Interrupted；已关联 Workflow run 的 Run 协调原运行并跟随其终态，两者都绝不重新触发目标。停机期间至多补一次最近错过的 schedule，其余错过触发不排队。
- **Automation retention（自动化保留）** — terminal Run 与其独立 worktree 默认保留 30 天，并受每个数据目录 10 GiB 配额约束；按完成时间从旧到新清理。running Run 永不参与清理，worktree 删除失败时保留 Run 证据供后续重试，目录计量不跟随符号链接。

## Workflow domain

- **Workflow source artifact（工作流源产物）** — Workspace 中可由用户、Agent、原生编辑器或 Plugin 编辑的 Workflow 创作事实源；它可以反复保存和进入版本控制，本身不等于已经发布或正在运行的 Workflow definition。
- **Workflow definition（工作流定义）** — 一份不可变、版本化的步骤依赖图，声明输入、Agent 或 Approval steps、输出引用和执行策略；修改会产生新版本，不改变已开始的运行。
- **Workflow publish（工作流发布）** — 校验 Workflow source artifact 并生成不可变 Workflow definition 版本的显式操作；Automation 绑定精确发布版本，不自动跟随源产物或其他 Automation 后续发布的新版本。
- **Workflow run（工作流运行）** — Workflow definition 某一版本在一组输入与工作区上的持久执行实例；它拥有步骤编排事实，但不复制 child Conversation 与 Turn 的历史。
- **Derived workflow run（派生工作流运行）** — 从既有 Workflow run 的指定步骤创建的新运行；原运行保持只读，满足定义、输入、输出契约与工作区检查点要求的上游结果可以作为复用证据，指定步骤及其传递下游产生新的执行记录。
- **Workflow run pause（工作流运行暂停）** — 先关闭新步骤调度、再取消全部在途 Turn，最终进入可恢复 `paused` 状态的非终态操作；暂停不回滚已经发生的文件或外部副作用，继续节点对话会在原 Child Conversation 中创建新 Turn，而不是恢复已取消 Turn。
- **Workflow step（工作流步骤）** — Workflow definition 中具有稳定身份、依赖、输入和输出契约的最小执行单位。
- **Step run（步骤运行）** — Workflow step 在某次 Workflow run 中的一次可审计执行；重试产生新的 attempt，不能覆盖旧证据。
- **Agent step（Agent 步骤）** — 通过 child Conversation 与一个或多个真实 Turn 完成工作的 Workflow step。
- **Agent step conversation（Agent 步骤会话）** — Agent step 拥有的持久 Child Conversation；自动初始 Prompt、用户或 Controller Agent 的 Steering、取消与后续输入都形成可见对话，但每次继续生成仍创建新的不可变 Turn。
- **Approval step（审批步骤）** — 等待已授权主体作出持久决定的 Workflow step；它不是 Agent Turn。
- **Candidate step output（候选步骤输出）** — Agent step 的某个已完成 Turn 的最后一条非空 Assistant 原始文本；输出 Schema 只作为 Prompt 示例，不对候选做解析或格式校验。继续对话可以产生新候选。
- **Accepted step output（已接受步骤输出）** — 已按 automatic 或 manual 完成策略接受、可被下游 Prompt 引用的候选原始文本；它可以不是合法 JSON。
- **Completion gate（完成门）** — Workflow definition 对步骤完成后的持久确认策略；它可以授权 human 或与 worker 分离的 Controller Agent 接受候选输出，但不能把普通 Agent Step 的自我确认等同于独立 Approval step。
- **Confirmation node projection（确认节点投影）** — Studio 为 manual Agent step 派生的可视确认节点；它打开所属 Agent step 对话并反映等待/放行状态，但不属于 Workflow definition、依赖或可执行 Step。
- **Debug breakpoint（调试断点）** — 只属于某次 Debug run、使指定步骤在完成后等待检查的临时覆盖；它不修改或发布 Workflow definition。
- **Workflow controller agent（工作流控制 Agent）** — 用户在 Workspace 会话中授权、通过 Workflow MCP 查看节点证据、追加节点输入或接受候选输出的 Agent principal；它与实际执行 Agent step 的 worker principal 分离，所有控制操作都必须可审计。
- **Workflow checkpoint（工作流检查点）** — 用于证明已完成步骤所依赖工作区状态的持久证据；摘要相同但检查点不一致时不能自动复用步骤结果。
- **Needs review（需要复核）** — 系统无法证明自动继续或重试不会重复副作用时的非终态；只有明确用户决定才能推进或结束运行。
- **Workflow authoring adapter（工作流创作适配器）** — 原生编辑页、Plugin artifact editor 或 Agent/MCP 等面向同一 Workflow source artifact 与 Workflow Core 的入口；适配器不得拥有独立的校验器、执行器、版本事实或运行状态机。
- **Workflow MCP（工作流 MCP）** — 依赖正在运行的 VibeX Host、把 Agent 工具调用适配到同一 Workflow Application Core 的本地协议入口；它不是独立 Workflow runtime，Host 不可用时不提供发布、调试或运行能力。
- **Plugin-scoped MCP（插件域 MCP）** — 由一个 Plugin 独立拥有身份、工具目录、版本兼容与 Agent binding 的 MCP Server；不同产品能力不因都调用 VibeX Host 就合并为平台内置的通用 MCP，Host 只统一提供生命周期、短期授权、连接上下文和公共 Application Core seam。
- **Workflow debug run（工作流调试运行）** — 从草稿输入或既有运行证据创建的可审计执行实例；它可以只运行选中步骤，也可以从选中步骤继续传递下游，但两种范围共享同一运行、隔离、Conversation 与事件语义。
- **Workflow run subscription（工作流运行订阅）** — 以持久 sequence 为权威的 snapshot、缺失事件 replay、high-water 与 live event 契约；编辑器、Inspector、Plugin 和动效都消费同一投影，不以客户端轮询状态作为运行事实。

Workflow 领域与 Automation 的关系见
[ADR-0045](docs/adr/0045-workflows-orchestrate-conversation-turns.md)。

## Plugin, Tool, and Artifact domain

- **Plugin control plane（插件控制面）** — VibeX Plugin Package 的唯一安装、授权、启停、更新、诊断、回滚与卸载事实来源；它也可以读取 Agent-native plugin 的投影，但不夺取 Agent 原生存储与信任权威。详细决定见 ADR-0046。
- **Plugin module（插件模块）** — VibeX Plugin Package 的独立产品入口：保留设置侧栏的单列目录，点击条目进入只有“内容/配置”主 Tab 的独立详情页。用户界面不把一个插件拆成平台扩展与 Agent 扩展，也不以 Skill、MCP、Runtime 或 contribution 数量解释产品。
- **Agent plugin setting（Agent 插件设置）** — “设置 → Agent → 对应 Agent”底部默认折叠的 Agent-native plugin 管理上下文；使用列表加预览，只呈现该 Agent 拥有的 Skill、MCP、Runtime、Hook 与 Workflow。操作能力取决于该 Agent 的可靠原生适配器，不能展示或授予 VibeX App 扩展权。
- **Plugin source package（插件源包）** — 被发现或导入的原始只读包及来源证据；它尚不是安装、授权或激活事实。一个源码目录可以同时包含 VibeX 与 Agent 原生格式，各格式的执行权仍分别建立。
- **VibeX Plugin Package（VibeX 插件包）** — 以一个身份、版本和生命周期提供完整功能的产品包；内部可以连接 App、Agent、Host 或 Runtime 扩展点，但它们不是用户分类。公共布局、README summary、contents、depends 与 config 见 ADR-0047。
- **Plugin summary（插件一句话简介）** — 根 `README.md` frontmatter 中独立的 `summary` 标签；必须是一句话，不从 Markdown 标题或段落推断，供目录与详情标题区显示。
- **Plugin content（插件内容）** — 根 `contents/` 下可供用户或 Agent 查看、使用的 Skill、MCP、Hook、Workflow、模板与其他资源；Host 只通过已验证的结构化 content index 暴露它们。
- **Plugin config（插件配置）** — 根 `config.json` 的内容；它是配置页编辑的唯一事实，由 manifest schema 校验和 Host 原子写回，不计入 executable package digest。
- **Plugin dependency（插件依赖）** — 根 `depends/` 下由 manifest 显式引用的 Runtime、CLI、package 或 service 描述；目录存在不自动授予执行权。
- **Plugin identity（插件身份）** — 由稳定 Publisher identity 与 Plugin ID 共同组成的产品身份；显示名称、目录名和相似内容不能建立身份，同 ID 不同 Publisher 的包不能继承权限或数据。
- **Linked development plugin（链接开发插件）** — 用户显式选择持续跟随其开发目录的 Plugin；它与普通安装的不可变快照分离，源内容变化后必须重新校验 contribution、权限和身份，VibeX 永不删除该开发目录。
- **Plugin contribution（插件贡献）** — Plugin Package 向一个明确宿主扩展点提供的独立能力；每项贡献有稳定身份、类型、兼容条件与 readiness，兼容性按贡献判断而不是由包格式或是否含 Skill推断。
- **Agent contribution（Agent 贡献）** — 向 Agent 会话或原生配置提供的 Skill、MCP、Runtime、Hook 或 Workflow；它可以与 App contribution 同包，但只有建立 Agent binding 后才向该 Agent 暴露。
- **App contribution（App 贡献）** — 向 VibeX 用户界面提供的文件 opener、preview provider、设置、命令、状态或自定义 surface；它不因与 Agent contribution 同包而获得主应用执行权。
- **Host contribution（Host 贡献）** — 在 VibeX Host 上提供的受控后台处理、事件响应或调度能力；客户端只观察其投影，不在本地复制执行。
- **Runtime resource（运行时资源）** — Plugin contribution 使用的 CLI、Binary、MCP 或 sidecar 资源；声明、精确解析、安装所有权、运行租约和就绪状态彼此分离。
- **Host-managed Plugin MCP（Host 托管插件 MCP）** — Plugin 通过公共 manifest 声明、由 Host 解析 Runtime 并按 Agent session 启动的本地 MCP Server；Host 注入绑定 Workspace 与父 Conversation 的连接上下文，Plugin 不持久保存 Server 地址或凭据。新 MCP 以 `2026-07-28` protocol revision 为主并按协议协商兼容版本。通用 seam 见 ADR-0051；会话增强与多智能体协同的产品拆分见 ADR-0057。
- **Session enhancement plugin（会话增强插件）** — 内置、不可卸载、默认禁用的产品插件，向会话提供提问、实时反馈、会话查询与会话控制；启停与单工具开关属于该插件，不属于「设置 → 常规」。见 ADR-0057。
- **Multi-agent collaboration plugin（多智能体协同插件）** — 内置、不可卸载、默认禁用的产品插件，向会话提供 LLM-mediated 委派；插件启停即委托启停。深度、结果缓存与子智能体会话默认只属于该插件配置，且只作用于委派子会话。见 ADR-0057。
- **Plugin detail panel（插件详情扩展面）** — 产品详情「配置」Tab 上由插件提供的自定义 App surface；`config.json` 仍是配置真相源，页面布局由插件定义，Host 不按插件 ID 特判设置页。
- **Plugin membership（插件纳入关系）** — Plugin 是否属于当前 Host 的 catalog；与 installation、activation、permission、Agent binding 和 contribution readiness 分离。
- **Plugin installation（插件安装）** — 一个精确 package version/digest 已作为当前 Host 的不可变安装物被接受并持久记录；它不等于启用，也不证明所需权限或 Runtime 已经就绪。
- **Plugin activation（插件启用意图）** — 用户是否允许已安装 Plugin 发布可用 contributions 的持久意图；新安装（含内置插件）默认禁用，启用不能伪造 permission、Runtime、Agent binding 或 contribution readiness。
- **Activation Generation（激活代）** — 一个 Plugin 的 package、permission、Runtime locks 与全部已就绪 contributions 一次原子发布的不可变运行快照；候选代在完整验证前不可见，失败更新必须保留上一完整激活代。
- **Plugin capability request（插件能力请求）** — Package 在执行前静态声明可能需要使用的宿主能力及最大 scope；声明只形成待决请求，不构成授权。
- **Plugin capability grant（插件能力授权）** — 用户在一个 Host 上对明确 Publisher、Plugin identity、能力集合、scope 与信任等级作出的可撤销授权；能力扩大、发布者变化或高风险执行入口变化必须重新授权。
- **Full-trust Plugin（全信任插件）** — 用户安装或启用 VibeX Plugin Package，即信任该包以与 VibeX Host 相同的本机权限运行 Worker、App 与声明的 Runtime；不再存在逐 capability、scope 或 Trusted Native 二次授权。独立 Worker/App frame 只提供生命周期、热更新与崩溃隔离，不是安全沙箱。见 ADR-0048。
- **Plugin Worker（插件工作进程）** — 在 VibeX Host 上隔离执行插件后端代码、且只能通过已授权宿主能力产生副作用的运行实例；它的存活不等于 Plugin 安装或激活事实。
- **App surface（应用扩展面）** — App contribution 在 VibeX 用户界面中的一个宿主渲染或隔离渲染实例；其能力受客户端兼容性、激活代和短期 surface 授权共同约束。
- **Sandboxed plugin surface（沙箱插件扩展面）** — 与主应用文档、存储、凭据和宿主运行时隔离的自定义 App surface；只通过带作用域和期限的消息桥访问声明且已授权的能力。
- **Agent binding（Agent 绑定）** — 用户允许某个已激活 Plugin 的 Agent contributions 在特定 Agent 或 Project 中暴露的关系；绑定不改变 package、Runtime 或 Agent 原生配置的所有权。
- **All-agents binding intent（全 Agent 绑定意图）** — Plugin 默认把兼容的 Agent contributions 投影给当前及未来所有已安装、已启用且支持相应能力的 Agent，并以显式排除项记录用户修改；插件设置与 Agent/MCP 设置只能编辑同一绑定事实。
- **Cross-Agent plugin（跨 Agent 插件）** — 其一个或多个 Agent contributions 可被多个 Agent adapter 等价投影的 VibeX Plugin；App contribution 是否存在不影响其跨 Agent 定义。
- **Skill projection（Skill 投影）** — VibeX 把 Plugin Skill 暴露到 Agent 原生 Skill 位置的受控只读入口；协调与卸载只能修改 VibeX 拥有的投影，不能覆盖用户同名 Skill。
- **Plugin Workflow（插件工作流）** — VibeX Plugin Package 在 `contents/workflows/` 中提供的版本化、结构化流程资源；Composer、Automation 或 Agent binding 只能引用同一 Workflow 身份与依赖证据，不再另建 PluginAction 公共概念。
- **Plugin Command（插件命令）** — 由 VibeX 解析并保留 Plugin/Command 身份的可移植斜杠入口；它不是某个 Agent 的原生命令。
- **Agent Command（Agent 命令）** — 由 Codex、Claude Code 或其他 Agent Runtime 定义并执行的原生斜杠命令；VibeX 只在对应 Agent 上发现和透传，不能宣称跨 Agent 可移植。
- **Command candidate（命令候选项）** — Composer 展示的一个带结构化来源身份的命令候选；同名 Plugin Command、Skill 与 Agent Command 可以并存，任何来源都不能按显示名称静默覆盖另一来源。
- **Runtime requirement（运行时需求）** — Plugin 作者对一个 Runtime resource 的声明式约束；声明不是已经解析、验证、安装或就绪的事实。
- **Runtime installation lock（运行时安装锁）** — Host 对一个 Runtime requirement 实际解析结果的持久证据，记录精确版本、目标平台、来源、完整性、入口与 probe 证据；不同版本可以并存，lock 不自动声明 Host 拥有外部安装。
- **Runtime reference（运行时引用）** — Plugin installation、Activation Generation 或运行租约对精确 Runtime lock 的占用；只有引用归零的 Host-owned Runtime 才能进入回收候选。
- **Runtime probe（运行时探测）** — 对 Runtime lock 的入口、内容、版本与所需能力进行有界验证；安装进程成功不能替代 probe。
- **Runtime inventory（运行时清单）** — 当前 Host 上精确 Runtime locks、所有权、完整性、probe 与引用关系的可审计目录；它不把同名命令压缩成一个用户全局版本。
- **Global command export（全局命令导出）** — 用户显式允许 Host 把某个 Runtime 的稳定 shim 暴露给普通终端的独立贡献；它不是 Runtime 安装默认副作用，也不能覆盖非 VibeX 所有的命令。
- **Trusted native contribution（受信原生贡献）** — 需要任意 shell、原生 sidecar 或不能被普通 Capability Broker 约束的高风险贡献；入口内容变化后必须重新授权，卸载副作用另行确认。
- **Plugin MCP binding（插件 MCP 绑定）** — Plugin 内置 MCP contribution 向 Agent 原生配置的投影关系；原生配置仍是 Agent Runtime 的权威，VibeX 不能为跳过配置步骤的用户制造隐式启用状态。
- **Agent-native plugin（Agent 原生插件）** — 由 Codex、Claude Code 或其他 Agent 自身的包格式、存储、生命周期与信任机制持有的插件；它可与 VibeX Package 共享源码或身份引用，但不会自动获得 VibeX App/Worker 执行权。
- **Native plugin reconciliation（原生插件协调）** — VibeX 重新读取 Agent-native plugin 权威后更新投影的过程；外部更新、禁用、删除或链接失效必须如实呈现，不能依据旧投影静默恢复原生状态。
- **Native plugin management capability（原生插件管理能力）** — 某个 Agent adapter 已可靠实现的 discover、install、enable、update 或 uninstall 操作；没有稳定接口的操作只能降级为只读或打开原生入口。
- **Native plugin trust（原生插件信任）** — Agent Runtime 对其原生 hooks、MCP 与其他可执行贡献负责的授权关系；VibeX capability grant 与原生信任不能互相替代或伪造。
- **External prerequisite（外部前置条件）** — Skill 或说明使用、但 Package 未声明为 Runtime requirement 的 CLI 或服务；它不阻止导入，但 VibeX 不负责安装、probe、冲突分析或 readiness，只能标记依赖未知。
- **Plugin operation audit（插件操作审计）** — 对安装、授权、激活代切换、Runtime、原生投影与破坏性操作的持久证据；记录身份、版本/digest、操作结果与影响范围，不保存秘密或凭据。
- **Official product MCP（官方产品 MCP）** — 随 Host 家族分发、由内置产品插件拥有的 MCP。磁盘上有 Runtime 不等于已注入；只有对应插件启用后才进入之后新开或 rebind 的 Agent session。当前成员为会话增强、多智能体协同与 Workflow Creator。见 ADR-0057。
- **Host-bound plugin environment（Host 绑定插件环境）** — 当前 Server Profile 对应 VibeX Host 上的 Package、contributions、Runtime、grants 与 Agent 原生投影集合；远程客户端操作该 Host 的环境，不在客户端复制执行。
- **Legacy plugin evidence（旧插件证据）** — 对旧 manifest、信任、Runtime 与激活记录的完整只读保存；它只用于迁移解释，不会自动执行旧脚本、获得新授权或重新成为可运行插件。
- **Artifact（产物）** — 文件系统中一个文件的持久身份；数据库只保存 relative path、revision/hash、producer Plugin/Provider/Tool-lock 与 Conversation event 证据，不保存文件内容。
- **Artifact preview lease（产物预览租约）** — 对一个已解析 Tool lock、文件、provider 进程和短期 capability 的引用计数租约；最后一个 lease 关闭、过期或进程崩溃时可回收。

## Remote and device domain

- **Application Core（应用核心）** — 不依赖 Tauri 或 Axum 的用例门面；desktop command、Web route 与 Remote Desktop adapter 都只能做认证、DTO/错误转换后调用同一公共 seam。
- **Server owner（服务器所有者）** — 对一个 VibeX Server 数据目录及其配对设备拥有最终管理权的单一主体；P0/P1 不把不同设备解释为不同用户，也不提供团队成员或多租户数据隔离。
- **VibeX Host（VibeX 主机）** — 当前拥有一个 VibeX 数据目录并对客户端提供 Remote protocol 的运行实例，可以是桌面应用或 Headless Server；同一数据目录同一时刻只能有一个 Host。
- **Host identity（Host 身份）** — 一个数据目录在配对与 capabilities 中出示的稳定身份；客户端用它合并 Server Profile，不以 URL 识别 Host。见 [ADR-0059](docs/adr/0059-host-identity-and-pairing-invitation.md)。
- **Host console（本机控制台）** — 正在运行 Host 的那台机器上的管理面：监听、Reachability 发布、配对邀请、设备撤销、管理员 token 与升级。它不是 Paired device；远程 Workstation 不复制该面。见 [ADR-0059](docs/adr/0059-host-identity-and-pairing-invitation.md)。
- **Server profile（服务器档案）** — 客户端上对一个 VibeX Host 的本地身份；由 Host 身份而不是某条 URL 区分。本机控制台是默认的 Local Profile；远端档案保存非秘密元数据与多条 Reachability，访问凭据独立受保护。
- **Reachability（可达目标）** — 客户端用来找到同一 Host 的一条 origin。一个 Server Profile 可以同时有局域网、FRP、Tailscale 或 Cloudflare 多条；它不是 Paired device，也不改变设备权限。远程 origin 只有通过检查的发布才进入权威名单，检查失败或关闭发布即从名单移除；局域网地址是探测结果，不是发布物。见 [ADR-0059](docs/adr/0059-host-identity-and-pairing-invitation.md)。
_Avoid_: 连接, 隧道, 服务器地址（单独拿来当 Host 身份）
- **Server-bound window（服务器绑定窗口）** — 只呈现并操作一个 Server Profile 所属资源的应用窗口；Project、Workspace、Conversation、Agent、设置与运行状态不得在同一窗口跨 Server 混用，访问另一档案必须使用另一窗口。
- **Remote disconnect（远程断开）** — 只结束 Server-bound window 的当前网络连接，不删除 Server Profile、缓存、device credential 或 Paired device 关系；关闭窗口、退出应用和临时断网都属于这一语义。
- **Forget server（忘记服务器）** — 用户要求客户端删除一个远端 Server Profile、其只读缓存与系统凭据的本地操作；它与 Remote disconnect 不同，并应在可达时先请求撤销本设备。
- **Remote coding loop（远程编码闭环）** — 用户在 Server-bound window 中从选择 Project/Workspace 到运行 Agent、处理交互、编辑文件、审阅 Diff、操作 Git 与终端的完整日常任务；它是远程桌面首版的产品完成边界，不等于所有桌面专属能力的协议镜像。
- **Mobile companion（移动伴随端）** — 连接在线 VibeX Host、观察并控制远端工作的薄客户端，不在移动设备上运行 Agent、Git worktree 或 Artifact 工具；没有 Host 在线时只能读取离线缓存。首个交付平台为 Android，iOS 复用同一 Remote protocol 后续交付。
- **Remote protocol（远程协议）** — `remote-protocol` 的版本化稳定 ID、error envelope、capabilities、typed command 与 durable subscription DTO。v1 Schema/OpenAPI 位于 `docs/protocol/v1/`。
- **Durable attach（持久订阅附着）** — 以 Conversation sequence 为权威的 ready → snapshot/replay → high-water → live 契约；sequence 去重，未知 event kind 必须可保留或忽略。
- **Pairing invitation（配对邀请）** — 本机控制台出示的短时邀请，携带 Host 身份、设备权限预设、当前全部 Reachability（不含 loopback）以及仅供未配对设备使用的一次性 secret。已持有该 Host 身份凭证的设备只合并 Reachability，不重新兑换；secret 过期后仍可从新出示的邀请收下 origin。长期 device credential 不得出现在邀请或 URL 里。见 [ADR-0059](docs/adr/0059-host-identity-and-pairing-invitation.md)。
- **Device pairing（设备配对）** — 未配对设备用邀请里的 secret 兑成长期、可撤销的 device credential；secret 到期或再次出示邀请都不会作废已经配对的设备。
- **Paired device（已配对设备）** — 代表同一 Server owner 的一个客户端身份，持有长期、可撤销的 device credential；断开、应用重启、网络变化或 Server 管理员 token 轮换都不结束配对关系，Device 不是 User。
- **Device permission preset（设备权限预设）** — 配对时向用户展示并审批的一组稳定用途；预设只组织细粒度 scopes，不直接参与授权判断，也不隐含 Server 管理权。当前配对预设为 Workstation Device 与 Companion Device。
- **Workstation Device（工作站设备）** — 其它桌面 VibeX 连上 Host 后近乎全接管工作：会话、文件、Git、终端、Workflow、Automation 与已安装插件。不含监听、token、设备管理和 Host 升级。
- **Companion Device（伴随设备）** — 手机薄客户端：会话、审批、只读 Artifact 与离线缓存。不含插件写入、Workflow/Automation 写入或终端。
- **Host family（Host 家族）** — 同一产品版本打出的 Desktop、`vibex-server` 目录（含 `vibex-mcp`、`web/`、官方插件快照）与后续 Companion 安装包。
- **Device revocation（设备撤销）** — 管理员显式终止已配对设备的长期信任关系；撤销后新 HTTP 请求和已经建立的 WebSocket 都必须失效，主 token 或 device token 不得出现在 URL、事件或日志。
- **Offline conversation cache（离线会话缓存）** — 仅包含持久 sequence 与 open events 的只读缓存；`read_only` 必须为 true，不能离线排队写操作。
- **Terminal notification summary（终态通知摘要）** — 只包含 Conversation/Automation 稳定 ID、终态、时间与 operation id 的无 secret 投影；不包含 prompt、输出、诊断或文件路径，也不直接接入 APNs/FCM。

## Agent domain

- **Agent kind（agent 身份）** — Agent 的全系统唯一、稳定身份标识（如 `claude_code` 或 `codex`），回答“这是哪个 Agent”；普通 Agent 的初始标识可以由 Registry id 派生，但此后不随 Registry 条目改名或换 id 自动改变，也不是只允许固定成员的封闭枚举。
- **Agent source（Agent 来源）** — VibeX 获取 Agent 接入契约的受控来源；允许 VibeX Built-in Agent Profile、ACP 官方 Registry 与用户声明的 Registry-compatible distribution。用户声明来源不等于官方来源，且不包含任意启动命令、自定义 Registry URL 或 PATH 自动发现。
- **User-declared agent definition（用户声明 Agent 定义）** — 用户为官方 Registry 尚未收录的本地 ACP Agent 提供的版本化接入契约；只接受 Binary、npx 或 uvx 的 Registry-compatible distribution，保存稳定 Agent id、明确分发方式与定义 digest，并复用统一冻结安装计划、Installation lock 和 LaunchGate。
- **Community ACP preset（社区 ACP 预设）** — VibeX 为官方 Registry 尚未收录、但已有成熟开源 ACP 适配器的 Agent 提供的 Registry-compatible 分发模板；它出现在 ACP 注册表「手动添加」页，添加后走用户声明定义同一管线，不得显示为官方 Registry 或 VibeX 已验证。已提升为内置 Agent 的预设只展示已内置状态，不能再以同一身份重复添加。
- **Agent profile（Agent 档案）** — 驱动统一 Agent 管线的声明式接入契约，描述身份、运行拓扑、分发、检测和版本信息；来源不同不会改变安装、配置或运行语义。
- **Built-in agent（内置 agent）** — 由 VibeX 预先加入并给予默认展示策略的 Agent；当前成员为 Claude Code、Codex、Google Antigravity、OpenClaw、OpenCode、Cline、Hermes、CodeBuddy、Kimi Code、Pi、Grok、Cursor 与 DeepSeek Harness。它们与其他 Agent 使用同一安装、探测和会话管线，但可由档案声明各自的官方账号、订阅、Provider 与原生插件管理动作。
- **Built-in agent profile（内置 agent 档案）** — VibeX 为内置 Agent 提供的 Agent 档案，可声明其本地 Runtime、ACP 适配器、检测候选、依赖环境、验证组合、原生配置与白名单管理动作，但不能改变统一 Agent 管线的语义。
- **Agent management capability（Agent 管理能力）** — Agent 在统一设置界面中提供的认证状态、账户状态、订阅入口、Provider 连接以及官方登录、注销和初始化动作。管理动作必须由 Built-in Agent Profile 完整声明，不能接受用户提供的程序、参数、URL 或任意 shell 文本。
- **Profile management action（档案管理动作）** — Built-in Agent Profile 固定声明的登录、注销、初始化或订阅入口；VibeX 只解析当前安装锁或 PATH 中的同名官方可执行文件，并在用户点击后于可见终端中启动，或打开固定官方 URL。
- **Local management fallback（本地管理补缺）** — 当 ACP 未提供某项状态管理能力时，Built-in Agent Profile 可以提供的等价本地状态探测；同一状态能力由 ACP 优先。持久配置始终通过已适配的 Agent 原生配置文件编辑，不属于补缺切换。
- **Subscription visibility（订阅可见性）** — 对 Agent 账户套餐、额度、用量与重置时间的呈现，并可由档案动作打开固定官方订阅页面；购买、升级、降级和取消仍由官方页面完成。
- **Authentication status（认证状态）** — VibeX 对 Agent 当前认证来源的判断：已通过账号登录、已通过 API Key 登录或暂未登录；用户可从设置页显式启动 Built-in Agent Profile 声明的官方登录或注销流程。
- **Credential ownership（凭据所有权）** — 表明认证凭据由 Agent Runtime 配置或用户外部环境中的哪一方持有。VibeX 可启动官方 Agent 的账号流程，也可编辑 Profile 明确认识的本地凭据字段或 Provider 文档，但不采集终端交互内容、不自动生成凭据，也不删除 Profile 范围外的外部环境凭据。
- **Inline device authentication（页内设备认证）** — 只为已适配且固定端点的官方设备授权流程提供页内状态机；短期设备码可以穿过 IPC，访问令牌只能由 Rust 后端交换并直接写入 Agent 官方凭据文件，不能进入前端、数据库或诊断日志。当前仅适配 Codex。
- **Agent authentication mode（Agent 鉴权模式）** — Grok/Cursor 等 Runtime 在订阅登录与显式密钥之间的用户选择；模式保存于 Agent 设置，预检查验证所选模式，启动门在订阅模式下清除继承进程的冲突密钥。
- **OpenCode Provider catalog（OpenCode Provider 目录）** — `models.dev` 的结构化 Provider/模型能力目录；在线响应经 24 小时缓存，离线时使用最后有效缓存或随应用发布的完整快照，不包含用户凭据。Provider 连接同时管理 SDK 包、API 适配器、端点、模型映射与 enabled/disabled 状态。
- **OpenCode plugin health（OpenCode 插件健康）** — `opencode.json` 声明与 OpenCode 缓存中实际安装包的对照结果；VibeX 只安装已声明的插件并保护 OpenCode 保留包，不接受任意包名或安装命令。
- **DeepSeek Harness 鉴权模式** — 仅 `deepseek`（官方 API Key + `https://api.deepseek.com`）与 `custom`（名称、备注、Base URL、API Key）两种；凭据写入 `$DSH_HOME/.credentials.yaml`，自定义端点投影到 `DEEPSEEK_BASE_URL`，密钥不回显。
- **DeepSeek Harness 会话默认配置** — 默认 Agent preset（standard / code / minimal / cordis）、沙箱权限与推理档位；写入 Agent 环境，作用于后续新建会话。
- **DeepSeek Harness plugin（DeepSeek Harness 插件）** — profile 的 `dsh.profile.bundles` 组合包与 `$DSH_HOME/cordis.patch.yml` 中的包名行；添加与移除走官方 `dsh plugin --profile default`。`$DSH_HOME/skills` 是独立 Skill 子系统，不属于插件列表。
- **Grok plugin（Grok 插件）** — 官方 `grok plugin` 管理的安装物，发现自 `grok plugin list` 或 `~/.grok/installed-plugins`；添加走 `grok plugin install <source> --trust`，移除走 `grok plugin uninstall`。Skill 目录不是 Grok 插件。
- **Agent launch preference（Agent 启动偏好）** — Cursor 模型/Run Everything、Grok 权限模式与 OpenClaw Gateway/Session 等不能仅靠子进程环境生效的设置；保存后由受控投影转换成固定 CLI 参数，参数位置和名称由 Built-in Profile 代码决定，用户不能注入参数数组。
- **Agent-native configuration（Agent 原生配置）** — 由本地 Agent Runtime 自身持有并可在 VibeX 外部修改的持久配置；它是 Agent Runtime 的唯一持久配置权威。VibeX 可以保存可复用的 Model Provider 预设与绑定意图，但只有把预设投影到已适配的原生配置后才会影响 Runtime。
- **Model Provider preset（模型供应商预设）** — VibeX 为 Claude Code 与 Codex 保存的本地可复用连接意图，包括名称、Agent 类型、端点、模型映射和凭据；IPC 只暴露凭据是否存在，不回显密钥。绑定或更新已绑定预设时，后端把字段投影到对应 Agent 原生配置；预设文件本身不是 Runtime 配置权威。
- **New-session default（新会话默认偏好）** — VibeX 为某个 Agent 全局记忆、并在创建会话时尝试应用的 ACP 会话配置选择；它不是 Project 设置或 Agent 原生配置，也不会改变已经存在的会话。
- **Native ACP agent（原生 ACP agent）** — 本地 agent runtime 与 ACP server 由同一个安装物提供的 agent；它只有一个需安装和验证的运行组件。
- **Adapter-backed ACP agent（适配器型 ACP agent）** — ACP server 只负责桥接、实际能力由另一个本地 agent runtime 提供的 agent；两个运行组件都必须安装、验证并显式绑定。
- **User-environment agent installation（用户环境 Agent 安装）** — 本地 Runtime 与 ACP 只存在于用户环境（PATH、npm 全局前缀、uv tools、用户 bin）。平台安装也写入该环境，再按 PATH 探测接入；Installation lock 只记录这次观察，不是另一份托管产物。见 [ADR-0060](docs/adr/0060-agent-installs-use-user-environment.md)。
- **External agent installation（外部 Agent 安装）** — 历史用语，现与用户环境安装同义：VibeX 绑定并校验用户环境中的 CLI，不再维护独立托管树。
- **Installation attempt（安装尝试）** — 一次把 Agent 的托管组件安装、修复或更新到目标版本的有界操作；它可以完成、失败、由用户取消或因宿主退出而中断，其终态不改变 Agent 的已添加关系。
- **Installation lock（安装锁）** — 一次成功探测或用户环境安装后，对 Agent Runtime、ACP 适配器路径、版本与分发方式的观察记录；它使当前绑定可以被验证和回退，但不是独立托管产物。
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
- **Uninstall agent（卸载 Agent）** — 按分发方式移除该 Agent 在用户环境中的 CLI 包并清除 Installation lock，但保留其已添加关系、设置与历史会话，使其可以原位重新安装。它不删除 Node、npm、uv、Python 或 Agent 原生配置。
- **Remove agent（移除 Agent）** — 终止非内置 Agent 与 VibeX 的已添加关系，使其离开 Agent 导航带，并先走同一套用户环境卸载，再清除 VibeX 拥有的 Agent 专属设置；它不删除历史会话。
- **Agent bar（Agent 导航带）** — “设置 → Agent”中的统一横向 Agent 选择器；所有已添加 Agent 共用同一列表，不按支持等级或安装状态分区，末位固定为打开 Registry 的添加入口。
- **ACP Registry view（ACP 注册表视图）** — 从 Agent bar 添加入口进入的 Agent 发现与管理界面，只展示当前 Registry 中仍存在的条目；条目从上游下架不会移除 Agent bar 中已经纳入的 Agent。
- **Registry snapshot（注册表快照）** — VibeX 最近一次成功获取并验证的 ACP 官方 Registry 目录副本；离线时它只提供带时间标记的浏览能力，不授权新的添加或更新。
- **History import（历史导入）** — 把外部工具（Claude Code、Codex 等）的本地会话历史接管进 VibeX 会话体系的行为。
- **Session fork（会话分叉）** — 从**当前状态**分出一个新 Conversation：新会话是原会话完整历史的独立副本（非破坏性，原会话不受影响），此后独立演化。当 agent 广告了 ACP `session/fork` 且有活会话时，agent 侧上下文也随之分叉（继续对话保有分叉前上下文）；否则新会话为无上下文副本，下次发送冷启动。从当前分叉（非历史某点），以保持可见历史与 agent 上下文一致。与 reset-to-here（在原会话上截断重来，破坏性）互为补充。语义决策见 ADR-0005（2026-07-06 更新）。

## ACP 官方参考文档

来源：ACP 官方文档索引（[llms.txt](https://agentclientprotocol.com/llms.txt)）。最后核对：2026-08-02。

### v2 Draft（新架构与方案设计优先参考）

ACP v2 当前仍是 Draft，不应被当作已经稳定的生产协议。VibeX 设计新能力时以 v2
语义为目标，但实现与发布必须通过版本协商和功能开关保留 v1 并行兼容；同一连接只使用
协商完成后的一个协议版本。迁移背景与上线约束见
[v2 Draft 公告](https://agentclientprotocol.com/announcements/acp-v2-draft)与
[v1 → v2 迁移指南](https://agentclientprotocol.com/protocol/v2/migration)。

- [协议概览](https://agentclientprotocol.com/protocol/v2/overview) — v2 JSON-RPC 通信模型、角色对称能力与会话生命周期。
- [迁移指南](https://agentclientprotocol.com/protocol/v2/migration) — v1/v2 方法、能力、数据模型与并行兼容差异。
- [初始化](https://agentclientprotocol.com/protocol/v2/initialization) — `initialize`、协议版本与双向能力协商。
- [认证](https://agentclientprotocol.com/protocol/v2/authentication) — `auth/login`、`auth/logout` 与认证方法。
- [会话建立与恢复](https://agentclientprotocol.com/protocol/v2/session-setup) — `session/new`、`session/resume` 与 `replayFrom`。
- [会话列表](https://agentclientprotocol.com/protocol/v2/session-list) — `session/list`。
- [删除会话](https://agentclientprotocol.com/protocol/v2/session-delete) — 可选的 `session/delete`。
- [Prompt 生命周期](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) — 接收确认、运行状态、后台更新与结束原因。
- [内容](https://agentclientprotocol.com/protocol/v2/content) — 消息、内容块、资源与扩展类型。
- [工具调用](https://agentclientprotocol.com/protocol/v2/tool-calls) — ID 驱动的工具调用 upsert、内容分块、结构化 diff、终端展示与权限请求。
- [Elicitation](https://agentclientprotocol.com/protocol/v2/elicitation) — 结构化用户补充输入。
- [取消](https://agentclientprotocol.com/protocol/v2/cancellation) — `session/cancel` 与基于状态更新的取消完成语义。
- [Agent 计划](https://agentclientprotocol.com/protocol/v2/agent-plan) — 带 `planId` 的多计划更新与可扩展计划类型。
- [会话配置选项](https://agentclientprotocol.com/protocol/v2/session-config-options) — 统一模式、模型、模型配置与思考等级。
- [斜杠命令](https://agentclientprotocol.com/protocol/v2/slash-commands) — 命令发现、更新与结构化输入。
- [扩展性](https://agentclientprotocol.com/protocol/v2/extensibility) — 开放枚举、未知变体、`_meta` 与前向兼容。
- [传输](https://agentclientprotocol.com/protocol/v2/transports) — stdio JSON-RPC 与批处理约束。
- [Schema](https://agentclientprotocol.com/protocol/v2/schema) — 完整 v2 类型与 JSON Schema 定义。

v2 不再提供独立的客户端文件系统、客户端终端和 Session Modes 协议面：文件/编辑器/命令
能力通过 MCP 暴露，Agent 终端输出归入工具调用展示，Mode 归入 Session Config Options。
v1 仍是当前稳定兼容基线，排查旧 Agent 行为时参考
[v1 概览](https://agentclientprotocol.com/protocol/v1/overview)与
[v1 Schema](https://agentclientprotocol.com/protocol/v1/schema)。

VibeX 的采用决策见
[ADR-0035](docs/adr/0035-acp-v2-dual-protocol-session-items.md)，分阶段落地与发布门禁见
[ACP V1 → V2 迁移与架构改进计划](docs/plans/2026-08-02-acp-v2-migration.md)。

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

### RFD 与 v2 设计背景（协议文档优先，RFD 用于决策追溯）

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
