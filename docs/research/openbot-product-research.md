# Nightly Labs OpenBot (`nightly-labs/openbot`) 产品功能深度调研与 VibeX 对比报告

- **调研对象**：[`nightly-labs/openbot`](https://github.com/nightly-labs/openbot)（官网：`https://openbot.run/`）
- **项目热度与许可**：5,718 Stars / 581 Forks（截至调研时）；采用 `PolyForm Noncommercial License 1.0.0`（非商业源码可用，商业使用需在 `Settings → Billing` 购买 Starter 单人或 Team 2–10 人商业授权；`<= 0.1.11` 旧版本为 Apache-2.0），版权归属 `SYNTHETIFY LABS SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ`。
- **核心技术栈**：Electron + SolidJS + TypeScript + Bun + SQLite（本地事件日志与读投影 `openbot.db`）+ Cloudflare Workers / D1 / R2（账号、鉴权、Marketplace 与信令）+ WebRTC / coturn（端到端远程连接）+ Expo（iOS 移动端）+ `cua-driver`（跨平台 Computer Use）+ QuickJS WASM（浏览器脚本沙盒）。
- **核心信息来源（一手源码与架构文档）**：
  - [`README.md`](https://github.com/nightly-labs/openbot/blob/main/README.md)
  - [`docs/glossary.md`](https://github.com/nightly-labs/openbot/blob/main/docs/glossary.md)
  - [`docs/architecture/agents.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/agents.md)
  - [`docs/architecture/channels-and-messaging.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/channels-and-messaging.md)
  - [`docs/messaging.md`](https://github.com/nightly-labs/openbot/blob/main/docs/messaging.md)
  - [`docs/automation.md`](https://github.com/nightly-labs/openbot/blob/main/docs/automation.md)
  - [`docs/architecture/skills-and-plugins.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/skills-and-plugins.md)
  - [`docs/plugin-distribution.md`](https://github.com/nightly-labs/openbot/blob/main/docs/plugin-distribution.md)
  - [`docs/architecture/integrations.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/integrations.md)
  - [`docs/architecture/browser.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/browser.md)
  - [`docs/architecture/computer-use.md`](https://github.com/nightly-labs/openbot/blob/main/docs/architecture/computer-use.md)

---

## 一、 核心结论（Executive Summary）

1. **产品定位**：OpenBot 定位为 **“Local-first desktop workspace for persistent AI teammates（本地优先的持久化 AI 队友桌面工作空间）”**。它不是单一 Agent 的聊天壳，而是把多个主流 Coding Agent CLI（Codex、Claude Code、Grok、Gemini、Cursor、Cline、Kimi、Devin、Copilot、Hermes 等）统一编排为**拥有独立工作区、持久身份、可互相发消息委托任务、可操控内嵌浏览器与桌面（Computer Use）、可被多端（桌面/Web/iOS/Slack/Discord/Telegram/WhatsApp）随时随地访问的“AI 团队”**。
2. **产品护城河与最亮眼的 6 大特性**：
   - **全托管多引擎底座 + 无缝热切（Cross-Provider Handoff）**：支持 10+ 官方 CLI 自动下载、版本锁定与每小时静默更新；支持同一 Agent 在 Codex、Claude、Grok 等引擎间切换时**保留同一个本地会话并自动提取最近 60 轮工具操作摘要（Work Steps）完成上下文交接**。
   - **四级任务编排体系（Side Threads / Routines / Routine Flows / Workflows DAG）**：从单 Agent 并行侧边线程（支持“从此处分支 Branch from here”），到定时/Webhook 触发的 Routine（支持静默运行 `[[no-update]]` 与导出 iCal 日历订阅），再到跨 Agent 结果传递的 **Routine Flows 画布**，以及包含条件分支、循环、人工审批、GitHub/IM 触发器与动作节点的 **Workflows 可视化有向图画布（Agent 还能驱动带头像颜色的光标在画布上实时动画建图）**。
   - **深度的多智能体协作体验（Agent Teammates & Shared Channels）**：支持一对一 A2A 消息、多队友并发派单自动合流（Wait-All Barrier）、带单点责任人（Lead/Task Owner）的共享群聊 Channel，以及所有 Agent 共享读写的 SQLite 结构化数据表（`Shared/Data/agent-data.db`）。
   - **极致的内置浏览器与密码库联动（Embedded Browser + Vault Autofill）**：内嵌 Chromium 浏览器支持三级会话隔离（Shared / Only this agent / Named Profiles）与 SOCKS5/HTTP 代理、**把团队成员的个人电脑作为远程服务器浏览器的网络出口（Computer Proxy Egress）**、QuickJS 沙盒批处理脚本（`run_script` 节省近 40% Token），并原生打通 **1Password / Bitwarden / Proton Pass** 自动安全填充密码而绝不向大模型暴露明文凭证。
   - **全场景多端协同与远程结对（Desktop + Web `/app` + iOS App + Sunshine 远程桌面）**：通过 WebRTC DataChannel 点对点加密直连（Cloudflare 仅做信令与账号，不触碰聊天与文件），iOS 端支持 **iPhone 灵动岛实时活动（Live Activity）**、队列在线编辑（Hold & Edit），且支持 **远程 OAuth 登录中继（Sign-in Relay）**——在云端/无头服务器上安装插件或登录 CLI 时，直接弹出用户本地电脑浏览器完成鉴权并安全回传。
   - **外部 IM 平台“总机路由”模式（Orchestrator Pattern）**：支持一键接入 Slack、Discord、Telegram、WhatsApp，自动在侧边栏创建对应平台的 **Orchestrator Agent（总机智能体）**，简单问题直接答复，复杂问题自动分发给最匹配的专科队友，并将结果回传至原外部帖子。

---

## 二、 核心产品功能模块全景拆解

### 1. 智能体底座与模型运行时（Providers & Runtimes）

| 功能维度 | 产品机制与实现细节（已核实事实） | 源码/文档依据 |
| :--- | :--- | :--- |
| **10+ 托管 CLI 引擎** | 原生支持 **Codex App Server**、**Claude Code**、**Grok CLI**、**OpenCode**（含零登录免费模型与付费 OpenCode Go）、**Gemini**（基于 Antigravity ACP）、**Cursor CLI** (`cursor-agent acp`)、**Cline CLI** (`cline --acp`)、**Kimi Code CLI** (`kimi acp`)、**Devin CLI** (`devin acp`)、**GitHub Copilot CLI** (`copilot --acp`)、**Hermes Agent** (`hermes acp`，自动读取 `~/.hermes` 下的记忆、技能与 `SOUL.md`)。 | `README.md`、`docs/architecture/providers.md` |
| **一键下载与隔离托管** | OpenBot 将各家 CLI 统一安装并版本锁定（`native-runtime.lock.json`）在系统共享目录（如 `~/Library/Application Support/OpenBot/provider-runtimes`），每小时检查更新；不会污染用户系统全局 CLI（如受限 Cursor 进程独立存放在 `~/.cursor/openbot-confined`）。 | `README.md` |
| **本地模型自动发现** | 自动扫描本机端口上的 **Ollama** 与 **LM Studio** 等 OpenAI 兼容服务端（探测过程零密钥泄露、禁止重定向），并支持接入任意自定义 ACP 协议二进制或 OpenAI 兼容 API。 | `README.md` |
| **多账号与备用模型自动故障转移** | 单个 Provider 支持绑定多个账号（`providerAccountId`）；每个 Agent 可配置 **Backup Models（备用模型序列）**，当主模型遇到配额耗尽（Usage limit）或接口报错（`provider-error`）时自动无缝降级并在恢复后切回（`usageLimitReturn`）。 | `docs/architecture/agents.md` (#L730-L740) |
| **跨引擎会话无损热切** | 当用户将一个 Agent 从 Codex 切换为 Claude 或 Grok 时，前端保持同一个对话不断裂；底层通过 `ThreadLifecycle.readWorkSteps` 提取旧引擎最近 60 轮的命令、退出码、修改文件路径、搜索记录等生成交接摘要（Handoff），注入新引擎会话。 | `README.md` (#L169-L170)、`docs/architecture/agents.md` (#L832-L850) |

---

### 2. 持久化“AI 队友”生命周期与工作区（Persistent Teammates & Workspaces）

1. **自然语言创建与配置队友（Prompt-Driven Profiles）**：
   - 用户可在桌面或手机端直接通过自然语言对话让现有 Agent 调用 `openbot.create_agent` 或 `openbot.update_profile` 创建/修改队友（姓名、头衔、`AGENTS.md` 指令、自动生成或本地裁剪上传的头像、引擎、模型、思考力度、权限级别）。
   - **安全不扩权原则**：Agent 创建新队友时，新队友自动继承创建者的权限边界与 Computer Use 限制，且 Agent 只能调用工具收紧自身或队友权限，只有人类用户才能将权限从 `Workspace only` / `Ask first` 提升至 `Full access`（`docs/architecture/agents.md#L755-L760`）。
2. **工作区与存储架构**：
   - **独立工作区**：每个 Agent 拥有独立的持久化目录 `~/OpenBot/Agents/<agent-id>`，根目录下的 `AGENTS.md`（或 `CLAUDE.md`）存放其常驻规则；若 Agent 在运行中自己修改了 `AGENTS.md`，回合结束时聊天流会展示 `"Updated its instructions"` 系统提示，并提供 **View（查看差异）** 与 **Undo（一键回滚）** 按钮（`docs/architecture/agents.md#L870-L898`）。
   - **共享空间与受管传输**：`~/OpenBot/Shared` 用于跨 Agent 共享文件；`~/OpenBot/Shared/Transfers` 存放跨 Agent 传递的文件快照（附带 `.openbot-transfer.json` 清单，记录所有者、接收方、大小与 SHA-256）。
   - **共享结构化数据库（Shared Tables）**：所有 Agent 共享同一个 SQLite 数据库 `~/OpenBot/Shared/Data/agent-data.db`（与系统库 `openbot.db` 严格物理隔离）。任何 Agent 可建表并成为该表的 `owner`（仅 owner 或人类用户可删表/改表结构，其他所有 Agent 均可自由读写数据行），实现多智能体之间的结构化状态协同（`docs/glossary.md#L80-L85`）。
3. **单 Agent 多线程并行与会话分支（Side Threads / Tasks & Branching）**：
   - **Side Threads（侧边线程/子任务）**：除主聊天（Main Thread）外，每个 Agent 顶部栏支持通过 `+` 开启多个并行 Side Threads（或由 Agent 调用 `start_task` 自主开启后台子任务，默认单 Agent 并发上限为 4 个运行中任务，最多 50 个打开线程）。
   - **Branch from here（从此处分支）**：支持在任意已完成的回合消息上点击 `"Branch from here"`，将截至该回合的历史消息与附件完整克隆为一个新的并行分支线程，并在分界线处保留指向源线程消息的跳转锚点（`docs/architecture/agents.md#L457-L471`）。
   - **全局 Tasks 看板**：侧边栏独立的 `Tasks` 页面汇总当前服务器所有 Agent 的并行子线程，支持归档（Archive）、恢复、重命名及“Needs you（等待人工介入）”高亮聚合。
4. **交互式视觉回复（`html_render` & `html_preview`）**：
   - Agent 可调用 `html_preview` 在后台离屏窗口渲染 HTML 并获取截图与高度自检，随后通过 `html_render` 在聊天流中直接发布交互式微应用/可视化图表（运行在无同源权限的 `openbot-visual:` 沙盒 Frame 中，支持全屏、主题同步、以及点击卡片向输入框回填上下文标签 `window.openbotPage.setContext`）（`docs/architecture/agents.md#L774-L809`）。
5. **一键迁移、导出与公开模板分享**：
   - **Grok Bot 导入器**：支持一键导入 Grok Bot 导出的 `.zip` 包（自动迁移智能体指令、头像、技能、定时任务、记忆、工作区文件乃至群聊 Channel）。
   - **整机实例迁移（Instance Transfer）**：`Server settings → Transfer` 支持将整台服务器的全部 Agent、自定义模型配置、MCP 配置、侧边栏三级文件夹及 Routine Flows 打包为单个 `.zip` 迁移至另一台服务器（自动剥离所有 API Key、URL 凭证与隐私数据，并在导入后列出需重新登录的列表）。
   - **Agent Templates（公开链接分享）**：点击聊天头部的 `Publish` 可将单个 Agent 的人设、技能与 Routine 发布为 `openbot.run/agents/<id>` 公开网页卡片（自动生成 1200×630 社交分享大图），他人点击 `openbot://agents/<id>` 即可预览并安装该模板（不包含工作区私有文件与记忆）。

---

### 3. 多智能体协同与通信机制（Multi-Agent Collaboration）

1. **点对点智能体通信（Direct A2A Messaging）**：
   - Agent 之间可通过 `send_message` 互相发送消息、引用回复、贴 Emoji 表情反应、发送图片及传输工作区文件。
   - **静默协同规范（Quiet Internal Coordination）**：内置 `developer-instructions.ts` 严格约束队友间协同不进行废话寒暄或复读循环；当 Agent 向 2 个及以上队友同时派发子任务时，投递队列支持 **Wait-All Barrier（等待全部队友完成后合并为一个回合唤醒发起方）**，若人类用户此时发消息则立即插队响应（`docs/architecture/agents.md#L670-L675`）。
   - **任务跟踪与定向中断（`interrupt_agent`）**：发起委托的 Agent 可查看队友队列深度与运行状态，并调用 `openbot.interrupt_agent` 定向终止自己派发给队友的任务（权限严格隔离：绝不允许中断人类用户、定时任务或其他 Agent 发起的任务）。
2. **桌面共享群聊（Shared Channels）**：
   - 人类与多个 Agent 共同参与的群聊空间，支持最多三级侧边栏文件夹嵌套（`Sidebar Folders`）。
   - **单点责任人机制（Lead / Task Owner）**：每个 Channel 指定一名主责 Agent（Lead）负责承接与分派任务，避免群聊多 Bot 抢答混乱；提供显式的人类生命周期控制（`Stop`、`Resume`、`Reassign` 重新指派、`Archive`、`Restore`），并维护独立的 Channel 专属记忆与 Channel 定时任务。
3. **FIFO 持久化队列与在线挂起编辑（Crash-Safe Queue & Hold-to-Edit）**：
   - 每个 Agent 拥有持久化在 SQLite 中的 FIFO 消息投递队列；当 Agent 忙碌时，新消息既可排队等待，也可在支持原生 Steer 的引擎上直接注入当前运行回合（Steer 模式）。
   - 支持在桌面端和 iOS 移动端对**尚在排队中的消息进行挂起编辑（`queue-edit-v1`）**：点击编辑即锁定该条投递并暂停队列自动下发，修改文字或增删附件保存后原子恢复派发。
4. **结构化人工介入中心（`ask_ui` & Attention Registry）**：
   - 汇总全平台等待用户处理的审批（Approvals）、单选/多选提问（Questions）、密钥安全输入表单（`request_api_key`）以及浏览器人工接管请求（Browser Takeover）。

---

### 4. 自动化、定时任务与可视化工作流（Routines, Routine Flows & Workflows）

OpenBot 构建了从简单到复杂的**四层自动化体系**：

| 自动化层级 | 核心定位 | 关键产品特性 |
| :--- | :--- | :--- |
| **1. Routines（定时与事件例行任务）** | 单 Agent 或单 Channel 的定时/Webhook 任务 | - 支持 Cron/日历定时触发或签名 Webhook 触发（带事件类型与 JSON 字段过滤）。<br>- **独立侧边线程运行（`runIn: "thread"`）**：不打断主聊天，自动将最多 1,500 字运行摘要（Digest）同步给主会话。<br>- **静默运行（Quiet Runs）**：若无新情况，Agent 调用 `routine_no_update` 或输出 `[[no-update]]`，系统自动折叠记录、不亮未读红点、不发桌面/手机通知（连 iPhone 灵动岛也不弹窗）。<br>- **本地 iCalendar 订阅源**：`Server Settings > Routines` 生成本地 `127.0.0.1` 的 `.ics` 日历订阅链接，在 macOS/系统日历中直接查看未来 30 天的 Agent 排期。 |
| **2. Routine Flows（例行任务流画布）** | 跨 Agent 的 Routine 结果流水线 | - 在侧边栏 Routines 视图中为每个 Agent 提供可视化连线画布，将一个 Agent 的 Routine 产出自动传递给下游一个或多个 Agent。<br>- 多输入汇聚节点自动等待全部上游完成后合并投递；上游全部失败则自动跳过下游。 |
| **3. Workflows（多智能体有向图工作流）** | 独立于单个 Agent 的全局可视化编排画布（Waypoints 页面） | - **丰富节点类型**：支持多 Agent 节点、无工具纯模型节点（Model Step，保持 5 分钟热进程复用）、Yes/No 条件分支节点（Condition）、支持回边的循环（Loop）、人工审批卡点（Approval）、桌面通知与外部平台输出。<br>- **GitHub & IM 深度触发与回写**：支持监听 GitHub App 事件（按 Issue/PR 粒度并发隔离）或 Slack/Discord/Telegram 消息直接触发工作流；GitHub 输出节点支持 10 种写操作（甚至能将 Discord 提问里的截图自动通过 Git Data API 提交到仓库的孤儿分支 `openbot-attachments` 并在 Issue 中引用）。<br>- **Agent 动画建图**：Agent 可调用 `edit_workflow` 增删改连线（无需传坐标，系统自动按网格排版），**画布上会出现带有该 Agent 名字与主题色的光标，按拓扑顺序实时播放节点生成与连线动画**（`workflow-build.ts`）。 |
| **4. Local Scripts API & `openbot-cli`** | 面向本机脚本/CI/终端的自动化接口 | - 开启单 Agent 的 `Local scripts` 权限后，本机监听 `127.0.0.1` 随机端口并生成 `0600` 权限凭证文件。<br>- 提供内置命令行 `openbot-cli`（如 `openbot-cli run "Ada" "Run tests" --wait`），支持从终端发送任务、触发 Routine、切换模型、清空上下文、读取并响应审批，甚至支持 Agent 调用 `openbot.await_event` 挂起自身等待外部长耗时编译脚本完成后通过 `waitId` 唤醒。 |

---

### 5. 内嵌受控浏览器、密码库与跨平台桌面操控（Browser, Vault & Computer Use）

1. **三层隔离的内嵌浏览器（Embedded Browser Profiles）**：
   - 每个 Agent 可配置三种会话分区：**Shared（全局共享）**、**Only this agent（仅该智能体独占）**、或 **Named Browser Profiles（命名浏览器配置，支持自定义颜色标签与多 Agent 共用登录态）**。
   - **代理与成员电脑出口共享（Proxies & Computer Proxy Egress）**：每个命名浏览器配置可绑定独立的 HTTP/HTTPS/SOCKS5 代理（主进程内置 RFC 1929 SOCKS5 鉴权中继并强制开启 `disable_non_proxied_udp` 防止 WebRTC 泄露真实 IP）；更具特色的是支持 **“Use your computer…”（成员电脑出口）**：当团队在云端运行 OpenBot Server 时，管理员可勾选将自己本地电脑的桌面客户端作为云端 Agent 浏览器的网络出口（通过 WebRTC `openbot.browser-egress.v1` 隧道转发，且严格拦截私有局域网 IP 防止反向内网穿透）（`docs/architecture/browser.md#L321-L337`）。
   - **QuickJS WASM 批处理脚本（`openbot_browser.run_script`）**：针对传统单步浏览器工具每步消耗一次模型回合与页面快照的问题，OpenBot 在 64MB 内存限制的 QuickJS WebAssembly 沙盒中提供 `run_script`，允许 Agent 在一次工具调用中连续执行最多 200 步（点击、输入、等待条件、提取数据）并仅返回一次最终快照，实测在 Claude Haiku 5.5 基准测试中**减少约 40% Token 消耗且准确率达 30/30**（`docs/architecture/browser.md#L188-L227`）。
   - **批量原生表单填充（`fill_fields`）与人工接管（`request_takeover`）**：支持单次原子校验并填充 1–16 个表单字段；遇到验证码、Passkey 或复杂登录时呼叫人工接管，用户接管期间底层强制锁死该标签页禁止 Agent 触碰。
2. **三大密码管理器零明文集成（1Password / Bitwarden / Proton Pass + 内置 Vault）**：
   - 原生集成 **1Password**（自动创建只读 `Shared with OpenBot` 保险库与服务账号）、**Bitwarden / Vaultwarden** 与 **Proton Pass**，以及内置加密 **Vault**。
   - Agent 仅能看到当前 HTTPS 域名下匹配的登录项元数据（ID、标题、用户名），填充密码或 TOTP 验证码时由主进程直接通过底层安全通道注入页面；**如果某网页在当前会话被 Agent 执行过 `evaluate` 自定义 JS 脚本，系统会标记 `agentScriptedOrigin` 并拒绝自动静默填充，改为弹出安全卡片由人工确认**，防止恶意脚本窃取自动填充的密码（`docs/architecture/skills-and-plugins.md#L97-L101`）。
3. **跨平台 Computer Use（`cua-driver`）与 Sunshine 远程桌面**：
   - 内置打包并签名校验的 `cua-driver` 守护进程，以统一 MCP 服务形式向所有 Provider 暴露屏幕截图、无障碍树读取与键鼠操控能力（支持 macOS、Windows、Linux X11/Xvfb 双虚拟显示器隔离）。
   - 自研跨显示器 **Fitts 最小急动度平滑轨迹光标动画（`agent-cursor-motion.ts`）**，在多屏环境下实时高亮展示 Agent 的点击与移动轨迹。
   - 集成 **Sunshine + Moonlight** 远程桌面流化能力，并提供安全沙盒化的键鼠权限自检面板与跨平台剪贴板同步（`openbot-paste.js`）。

---

### 6. 技能库、插件市场与外部连接器（Skills, Plugins & Connectors）

1. **多引擎统一技能体系（Agent Skills & Skill Packs）**：
   - 遵循 `agentskills.io` 规范（`SKILL.md`），安装时自动双写至 `.agents/skills/` 与 `.claude/skills/`，并通过哈希锁文件 `.openbot/skills-lock.json` 管理；针对 `~/.agents/skills` 全局技能，自动按引擎特性适配（原生读取、生成 Claude 插件软链、或为 Antigravity/ACP 注入描述指令）。
   - **本地技能生命周期闭环**：Agent 可将对话中沉淀的工作流直接通过 `create_skill`、`revise_skill` 打包为带不可变版本号（Revision）的本地技能或技能包（Skill Pack），并在卡片上提供 `"Try skill"` 一键填入示例 Prompt。
2. **Marketplace（Agents / Skills / Apps 三合一市场）**：
   - 托管在 `openbot.run/marketplace`，包含 **Agents**、**Skills** 与 **Apps（Plugins）** 三个分栏。
   - **Plugin（插件）定义**：由 `1 个主机级 MCP Server（App）+ 若干个固定版本的 Agent Skills + 示例 Prompt 与配置指南` 组成；支持免登录浏览、离线快照兜底、SHA-256 完整性校验，以及 `openbot://plugins/<slug>` 深度链接唤起（严格遵循“链接只打开详情页，绝不自动静默安装”的安全铁律）。
   - **MCP OAuth 本地安全代理（`McpOAuthProxy`）**：Agent 进程永远拿不到 MCP 服务的真实 OAuth Token；OpenBot 在本机启动 Loopback 代理，为每个 Agent 签发专属 HMAC Bearer，由代理在转发请求时注入真实 Token 并处理 401 自动刷新，且支持同一 MCP 服务（如 Notion）挂载多个账号并通过 `@<账号名>` 在对话中指定调用（`docs/architecture/integrations.md#L67-L103`）。
3. **内置 GitHub Connector（`openbotgit[bot]` 身份分离）**：
   - 通过 GitHub Device Flow 一键连接，不仅自动挂载 `api.githubcopilot.com/mcp/`，还为 `git` 与 `gh` 注入无明文环境变量的凭证助手。
   - **PR 审批利器**：通过 Account Worker 换取权限受限的 `openbotgit[bot]` App Installation Token，**使 Agent 创建的 Pull Request 作者显示为 `openbotgit[bot]` 而非用户本人，从而允许发起任务的人类开发者自己在 GitHub 上 Approve 该 PR**，完美满足团队分支保护需要 1 人审批的合规要求（`docs/architecture/skills-and-plugins.md#L205-L207`）。

---

### 7. 外部 IM 接入与多端远程协同（External Messaging & Multi-Surface Team Server）

1. **四大外部 IM 平台接入（Slack / Discord / Telegram / WhatsApp）**：
   - **统一的 Orchestrator（总机智能体）范式**：连接任一外部平台时，系统引导用户选择一个模型并在侧边栏 `Integrations` 分组下自动创建该平台的 **Orchestrator Agent**。外部群聊或私聊的新会话首先到达 Orchestrator，简短问题由其直接回答，复杂任务由其通过 `send_message`（携带 `messagingReturn` 标记）委派给最合适的专业 Agent，完成后自动回传到原外部消息线程中。
   - **连接级共享记忆（Workspace Memories）**：每个外部连接（如一个 Slack 工作区或 Discord 服务器）拥有最多 32 条、每条 500 字的公共事实记忆（`openbot.messaging_remember`，例如“谁负责哪个项目”），注入该工作区的所有外部会话，但与个人私有聊天记忆隔离。
   - **原生交互反馈**：消息到达自动贴 `👀`，处理中显示 `"Working on it…"` 并附带 **Stop** 按钮，结束贴 `✅ / ❌ / ⏹`；需要工具审批时直接在 Slack/Discord/Telegram 线程内渲染 **Approve / Deny** 按钮（WhatsApp 个人号则支持回复数字 `1` 或 `2` 审批），且严格校验**只有发起提问的本人或主机管理员才能点击审批或停止**。
   - **主动发帖能力（Outbound Posting）**：任何 Agent 在日常对话、定时任务或工作流中均可调用 `openbot.messaging_list_places` 和 `openbot.messaging_post` 主动向已连接的 Slack 频道、Discord 频道/帖子或 Telegram 群组发布报告。
2. **多端覆盖与零信任 WebRTC 团队架构（Desktop / Web `/app` / iOS Mobile / Hosted Server）**：
   - **四种主机部署形态**：本地桌面应用（macOS / Windows / Linux AppImage）、Linux 无头 systemd 服务（`install-server.sh`）、Docker 容器（支持单机多实例）、macOS 多租户宿主包（`openbot-host setup --create-user`），以及官方 Boat 云主机（闲置 15 分钟自动休眠，收到外部 IM 消息或按钮点击时由 Signal 加密缓存消息并自动唤醒主机）。
   - **端到端加密传输**：主机发布后 Team API 仅监听本机 `localhost`，通过隐藏沙盒页面建立 **WebRTC DataChannel v3**（直连优先，失败走 coturn 中继）。Cloudflare 仅存储账号、成员关系与信令握手，**绝不经手任何聊天内容、文件字节、命令或远程桌面画面**。
   - **细粒度团队角色与 Agent 访问控制（`agent-access-v1`）**：除服务器级角色（Owner / Admin / Member）外，支持创建自定义角色（Role）精细控制每个团队成员能看到并使用哪些 Agent，以及使用权限级别。
   - **iOS 移动端特色体验**：支持扫码配对、**iPhone 灵动岛与锁屏实时活动（Live Activity via APNs）** 实时追踪耗时回合进度、当电脑端闲置超过 30 秒（默认）自动将通知接力推送至手机端。

---

## 三、 OpenBot vs VibeX 核心产品能力全景对比矩阵

| 对比维度 | Nightly Labs OpenBot (`nightly-labs/openbot`) | VibeX（当前架构） | 差距与优势评估 |
| :--- | :--- | :--- | :--- |
| **核心产品定位** | 本地优先的持久化 AI 队友桌面工作空间 + 团队私有云/多端协同中心 | 多智能体协作空间（Space / Group / Direct）+ 全信任插件化研发工作台 | OpenBot 在**跨引擎生命周期管理、多端远程访问与自动化编排**上产品化完成度极高；VibeX 在**可定制 UI 插件体系（v2/v4 SDK）与空间收藏夹沉淀**上更具扩展性。 |
| **底层引擎接入与切换** | 托管 10+ CLI（Codex/Claude/Grok/Gemini/Cursor/Cline/Kimi/Devin/Copilot/Hermes）+ 本地 Ollama/LM Studio 自动发现 + **跨引擎切换自动提取 60 轮 Work Steps 交接** + 备用模型自动故障转移 | 支持主流 ACP / Claude / Codex 等引擎接入 | **OpenBot 显著领先**：一键下载锁定 CLI、多账号切换、配额耗尽自动切 Backup Model、以及跨引擎切换不断会话的 Handoff 机制极其丝滑。 |
| **单 Agent 多线程与分支** | 支持主线程 + 多个并行 Side Threads（Tasks）+ **任意回合一键“Branch from here”派生分支** + 全局 Tasks 面板 | 支持会话管理与后台任务 | **OpenBot 交互更细腻**：聊天头部页签化管理 Side Threads + 会话分支能力非常适合探索性编程与多线并行处理。 |
| **多智能体协同机制** | 1v1 A2A 消息 + 多队友派单 **Wait-All 合流屏障** + `interrupt_agent` 定向中断 + 群聊 Channel 单一主责人（Lead）+ **跨 Agent 共享 SQLite 数据库（`agent-data.db`）** | BotSpace 群聊/私聊、`delegate_to_agent`、`post_space_message`、共享 `collection/` 收藏目录、`memory_write` | 双方各有千秋：VibeX 的共享 `collection/` 文档沉淀很直观；OpenBot 的 **Wait-All 屏障、定向中断权控、共享结构化 SQLite 表** 更适合严谨的工程协同。 |
| **自动化与可视化编排** | **四级体系**：Routines（含静默运行 `[[no-update]]` + iCal 日历订阅）→ Routine Flows（跨 Agent 传递画布）→ **Workflows（含条件/循环/审批/GitHub 触发器与 Agent 光标动画建图的 DAG 画布）** → `openbot-cli` 本地脚本 API | 支持 `schedule`（一次性定时器与 Cron 周期任务）与 Python `run_workflow` 脚本编排 | **OpenBot 产品化体验大幅领先**：静默运行避免垃圾通知轰炸、iCal 日历订阅、以及 Agent 在画布上带光标动画实时搭建可视化 Workflow 极具视觉冲击力与实用价值。 |
| **浏览器与桌面操控** | 内嵌 Chromium（三级 Profile 隔离 + SOCKS5/成员电脑出口代理 + **QuickJS 沙盒 `run_script` 省 40% Token**）+ **1Password/Bitwarden/Proton Pass 零明文自动填充** + 内置 `cua-driver` 跨平台 Computer Use + Sunshine 远程桌面 | MCP Computer Use 插件 + Web 抓取工具 | **OpenBot 深度集成度极高**：特别是 QuickJS 浏览器批处理脚本、密码库零明文填充（含 `agentScriptedOrigin` 防窃取检测）与成员电脑出口共享。 |
| **外部 IM 与多端生态** | Slack / Discord / Telegram / WhatsApp **Orchestrator 总机自动分流** + Web 客户端 (`/app`) + iOS App（含 **iPhone 灵动岛 Live Activity**）+ 远程服务器 **Sign-in Relay（本地浏览器代登录中继）** | 桌面端核心体验 | **OpenBot 跨端与外部触达闭环完整**：Orchestrator 总机模式解决了外部 IM 接入多 Agent 的路由难题，Sign-in Relay 解决了远程服务器 OAuth 登录痛点。 |

---

## 四、 对 VibeX 产品演进的 6 条高价值可落地建议

基于对 `nightly-labs/openbot` 源码与产品设计的深度拆解，建议 VibeX 按优先级吸收以下 6 项经过验证的产品设计：

1. **【P0 · 极高性价比】为定时任务（Schedule/Cron）引入“静默运行（Quiet Run / `no_update`）”机制**：
   - **痛点**：巡检类、监控类定时任务在“一切正常、无新进展”时如果每次都发消息并触发未读红点/通知，会迅速造成用户通知疲劳。
   - **方案**：借鉴 OpenBot 的 `routine_no_update` 工具或 `[[no-update]]` 标记，当定时任务回合无实质更新时，折叠该轮输出、不增加未读计数、不触发声音与弹窗通知。
2. **【P0 · 协同体验升级】多 Agent 派单的“Wait-All 合流屏障”与会话级“从此处分支（Branch from here）”**：
   - **方案 A（合流屏障）**：当主 Agent 在同一回合向多个专业 Bot 并行委派子任务时，投递队列支持等待所有子任务均返回结果后，一次性打包唤醒主 Agent 进行综合汇总，避免每回来一个子结果就打断并触发一次残缺汇总。
   - **方案 B（会话分支）**：在聊天消息菜单增加“从此处分支（Branch from here）”与并行子线程页签（Side Thread Tabs），方便用户在不污染主对话上下文的前提下开辟支线探索。
3. **【P1 · 编程与自动化利器】引入本机安全自动化 CLI（类 `openbot-cli`）与事件挂起唤醒（`await_event`）**：
   - **方案**：提供轻量本机回环 HTTP API 与 CLI 工具，允许用户在终端或长耗时脚本（如大型编译、训练任务）末尾直接一条命令唤醒指定 Agent 汇报结果，支持 Agent 主动挂起等待外部事件回调。
4. **【P1 · 浏览器与安全赋能】引入 QuickJS 沙盒批处理浏览器工具（`run_script`）与密码库零明文填充**：
   - **方案**：将单步浏览器操作升级为可在安全沙盒中一次执行多步交互并只返回最终快照的 `run_script`，大幅降低多步网页操作的 Token 消耗与耗时；同时支持从 1Password / Bitwarden 安全注入登录凭证而不经过 LLM 上下文。
5. **【P1 · GitHub 工程流闭环】GitHub Bot 身份分离（让人类可以 Approve Agent 提交的 PR）**：
   - **方案**：借鉴 `openbotgit[bot]` 设计，使 Agent 创建 PR 时使用独立的 GitHub App Bot 身份而非复用用户个人 Token，从而让下达指令的开发者本人能够在 GitHub 上直接 Approve 该 PR，跑通团队 Code Review 合规闭环。
6. **【P2 · 外部触达与可视化】外部 IM 接入采用“Orchestrator 总机智能体”模式 + 可视化工作流画布动画**：
   - **方案**：未来接入飞书、企微、Slack、Discord 或 Telegram 时，采用“单平台单 Orchestrator 总机 + 内部按专长分发给 Space 内专科 Bot + 连接级共享事实记忆”的架构，对外统一出口、对内专业分工；在可视化工作流上，支持 Agent 调用工具建图时展示带 Agent 头像颜色的光标建图动画。
