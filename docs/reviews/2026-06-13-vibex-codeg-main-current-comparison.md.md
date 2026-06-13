# VibeX 与 codeg-main 当前状态完整对比报告

日期：2026-06-13

对比对象：

- 当前项目：`C:\Users\Administrator\Documents\Projects\VibeX`
- 参考项目：`C:\Users\Administrator\Documents\Projects\codeg-main`

## 1. 结论摘要

从当前代码状态看，VibeX 已经不是早期“只有界面雏形”的状态。它已经完成了两块关键底座：

1. ACP-native agent 平台已经切到 `crates/agents`，并移除了旧 provider/runtime 路径。
2. conversation rendering 对齐工作已经完成大部分核心体验，包括 Markdown、Shiki、高亮、KaTeX、Mermaid、虚拟列表、粘底滚动、工具卡片、inline diff、图片卡、turn stats 与队列提示等。

这意味着：如果只评价“本地桌面 AI 编码工作台”的核心闭环，VibeX 已经具备可继续演进的基础，尤其在本地项目、任务、workspace、git worktree、预览代理和面向工程任务的组织方式上，有自己的优势。

但如果评价“与 codeg-main 的完整产品能力对齐”，VibeX 仍然明显落后。差距最大的不是单个聊天组件，而是产品化操作面：

- 没有 Codeg 的独立 server / web service / Docker / updater / remote transport 能力。
- 没有真正的多 agent delegation broker 与 `codeg-mcp` sidecar 等价物。
- 历史会话导入仍偏通用 JSON/JSONL 解析，缺少 Codeg 针对 7 类 agent 的深度 parser 与统一 conversation 模型。
- 设置、MCP marketplace、Skills 管理、Git 凭据、系统代理、模型提供商、Chat Channels、Project Boot、备份恢复、国际化等仍明显不完整。
- VibeX 文档和规格很多，但用户级文档、安装部署文档、多语言 README 和 release 体验远弱于 Codeg。

综合判断：

| 维度 | VibeX 当前状态 | codeg-main 当前状态 | 判断 |
| --- | --- | --- | --- |
| 本地桌面核心 agent 工作流 | 中高 | 高 | VibeX 已可继续产品化，但成熟度仍低于 Codeg |
| Codeg 功能完整度对齐 | 中低 | 高 | VibeX 约完成 50% 到 60% 的能力面 |
| 产品交付完整度 | 中低 | 高 | VibeX 约 45% 到 55%，Codeg 更接近可交付产品 |
| 工程规格与内部追踪 | 高 | 中 | VibeX 在内部 specs、traceability、closure review 上更强 |
| 端到端部署与用户产品面 | 低 | 高 | Codeg 明显领先 |

一句话结论：VibeX 已经在“本地桌面工程工作台”方向建立了扎实骨架，但 codeg-main 是一个更完整、更产品化、更跨环境的 multi-agent coding workspace。VibeX 的优势是本地项目/任务/worktree 组织和工程化规格；Codeg 的优势是完整产品面、跨端部署、多语言、历史聚合、多 agent 协作和设置生态。

## 2. 对比范围与方法

本报告基于源码、配置、文档和规格文件的静态审阅，重点查看了：

- 根目录 `package.json` / `Cargo.toml` / Tauri 配置。
- 前端路由、设置页、核心组件依赖与国际化结构。
- Rust 后端模块、ACP runtime、agent registry、history parser、MCP、Git、部署相关代码。
- VibeX 的 `docs/specs` 与 `docs/reviews` 下已有规格和阶段验收记录。
- codeg-main 的 README、server、MCP sidecar、delegation、chat channel、web transport、proxy、keyring、parsers 等模块。

未做的事情：

- 未重新启动两个应用进行完整手工体验。
- 未重新跑完整测试套件。
- 未做性能压测、真实 agent API 连接测试或安装包验证。

重要前提：

- VibeX 当前工作区是 dirty worktree，且分支相对远端有大量 ahead commit。本报告只评价当前文件状态，不回滚、不清理用户已有改动。
- `codeg-main` 目录不是 git 仓库快照，无法基于 commit history 判断演进，只能按当前文件内容审阅。
- VibeX 下已有旧版 `docs/reviews/对比报告.md`。该文档反映的是更早状态，本报告不覆盖旧文档，而是作为当前状态的新评估。

## 3. 项目形态总览

### 3.1 基础技术栈

| 项目 | VibeX | codeg-main |
| --- | --- | --- |
| 前端 | Vite + React 18 + TypeScript | Next.js 16 + React 19 + TypeScript |
| 桌面 | Tauri 2 | Tauri 2 |
| Rust 组织 | Cargo workspace，多 crate 拆分 | 单主 crate，附带多个 bin |
| 数据层 | SQLite / SQLx 风格，分布在 `crates/db` 等 crate | SQLite / SeaORM |
| 主要运行形态 | 本地桌面 app | 桌面 app + standalone server + web service + MCP sidecar |
| 前端输出 | Vite dist | Next static export `out` |
| 国际化 | 未发现完整 i18n 框架 | `next-intl`，多语言 messages |
| 更新/安装 | 基础 Tauri app | updater、NSIS hooks、sidecar 准备、server/docker/install scripts |

### 3.2 代码规模粗略对比

排除 `node_modules`、`target`、`dist/out` 等生成目录后的粗略观察：

| 指标 | VibeX | codeg-main |
| --- | --- | --- |
| 文件总数 | 约 1687 | 约 843 |
| Rust 文件 | 约 253 | 约 237 |
| TS/TSX 文件 | 约 764 | 约 459 |
| Markdown 文件 | 约 312 | 约 51 |
| 测试相关文件 | 约 191 | 约 110 |

这个规模差异不代表 VibeX 功能更多。VibeX 文件数更高，主要来自更细的 workspace crate 拆分、更多 specs、更多阶段文档和更细的前端模块。Codeg 的 product surface 更集中，但运行形态和功能覆盖更完整。

### 3.3 Rust 后端组织差异

VibeX：

- 顶层是 workspace。
- 关键 crate 包括：
  - `crates/agents`
  - `crates/api-types`
  - `crates/db`
  - `crates/executors`
  - `crates/services`
  - `crates/git`
  - `crates/local-deployment`
  - `crates/deployment`
  - `crates/review`
  - `src-tauri`
- `crates/agents` 已成为新的 agent runtime 所有权边界。

codeg-main：

- 主要是单个 Tauri Rust crate。
- 附带多个 bin：
  - `codeg`
  - `codeg-server`
  - `codeg-mcp`
- 关键模块包括：
  - `acp`
  - `commands`
  - `db`
  - `parsers`
  - `web`
  - `chat_channel`
  - `git_credential`
  - `keyring_store`
  - `network`
  - `workspace_transfer`
  - `supervise`
  - `update`

评价：

- VibeX 的 crate 边界更清晰，更适合长期分层演进。
- Codeg 的产品闭环更完整，尤其是 server、MCP sidecar、web transport、delegation、chat channels 等都已经落地。
- VibeX 目前“架构分层”强于“产品闭环”；Codeg 则相反，它更像已经打包过多轮的完整产品。

## 4. 功能覆盖矩阵

| 功能域 | VibeX 当前状态 | codeg-main 当前状态 | 差距判断 |
| --- | --- | --- | --- |
| 7 类 agent registry | 已覆盖 Claude Code、Codex、OpenCode、Gemini、OpenClaw、Cline、Hermes | 已覆盖同类 agent | 基础覆盖接近 |
| ACP live session | 已切到 `crates/agents`，有 session、permission、terminal、mode/config/commands 等 | 更成熟，ACP lifecycle、session state、connection manager 更完整 | Codeg 更成熟 |
| 历史会话导入 | 通用 JSON/JSONL importer，按默认路径和字段猜测 | 针对 Claude/Codex/Gemini/OpenClaw/OpenCode/Cline/Hermes 的深度 parser | Codeg 明显领先 |
| Conversation rendering | Phase 2 基本完成，支持高亮、数学、图表、虚拟列表、工具卡片、diff、图片等 | 使用 streamdown 与成熟 UI 体系，和 i18n、delegation UI 深度集成 | 接近，但 Codeg 仍更完整 |
| 多 agent delegation | 仅有 UI 层对 subagent/spawn 类输出的展示痕迹，无真正 broker/sidecar | 有 `codeg-mcp`、delegation broker、listener、transport、深度限制、取消、状态同步 | Codeg 碾压式领先 |
| MCP 管理 | 有 config/mcp 读写与基础 surface | 本地扫描、官方 registry、Smithery、安装/删除/规范化，多 app 类型 | Codeg 明显领先 |
| Skills 管理 | 主要是读取本地 Codex/agents skills | 支持更完整的 skills/expert/setting 生态 | Codeg 领先 |
| 本地项目/workspace | 多项目、workspace、tasks、git worktree、preview proxy、project rail | folder/workspace、git 窗口、terminal、diff、server/web | VibeX 在任务/worktree 组织上有特色优势 |
| Git 与版本控制 | repo commands、PR/issues/comments 等服务存在 | credential helper、keyring、GitHub account、token validation、askpass、web handlers | Codeg 产品化更完整 |
| 系统代理 | agent env 中可合并代理 env，preview proxy 存在 | 系统代理设置、DB 持久化、HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 应用与清理 | Codeg 领先 |
| Web service / server | 未发现等价 `codeg-server` | standalone server、Axum router、token auth、supervise、upload quota、remote transport | Codeg 明显领先 |
| Docker / 安装脚本 | 未见等价完整产品部署 | README 与 scripts 覆盖 Docker、server install、desktop install | Codeg 领先 |
| Updater | 未见完整 updater 产品链 | Tauri updater、签名、公钥、endpoint、rollback/supervise 相关 | Codeg 领先 |
| Chat Channels | 未见等价功能 | Telegram、Lark、Weixin、scheduler、event subscribers | Codeg 领先 |
| Project Boot | 未见等价成熟功能 | 有 `/project-boot` 路由与相关产品入口 | Codeg 领先 |
| 国际化 | 未发现 next-intl/i18next 等完整方案 | 10 种语言 messages，组件使用 `useTranslations` | Codeg 明显领先 |
| 设置中心 | 约 7 个主 tab | 约 13 个 section | Codeg 更完整 |
| 内部 specs/traceability | 非常丰富，有阶段任务、closure review、problem map | 用户文档强，但内部 spec 较少 | VibeX 领先 |

## 5. Agent 平台对比

### 5.1 VibeX 当前 agent 平台

VibeX 的最大进展是 `crates/agents` 已经成为产品自有的 agent orchestration 边界。规格文件显示，`docs/specs/acp-native-agent-platform` 的 master cutover 和 legacy removal verification 已完成。当前代码也体现出以下特征：

- `crates/agents/src/registry.rs` 已集中管理 7 类 agent。
- registry 对不同 agent 有明确 distribution 形态：
  - Claude Code：npx `@agentclientprotocol/claude-agent-acp`
  - Codex：`codex-acp` 二进制
  - OpenCode：二进制
  - Gemini：npx
  - OpenClaw：npx
  - Cline：npx
  - Hermes：uvx
- runtime 侧有 session、permission、terminal、preflight、install plan、config、MCP 等模块。
- event 类型已经扩展到 message、thought、tool、plan、usage、session modes、config、options、available commands、permission、terminal、error、raw diagnostic 等。
- Phase 1 closure review 记录了 session persistence、resume、multi-option permission、auto approve、pending persistence、modes/config/commands、preflight、env merge/spawn dedupe 等已完成。

优势：

- VibeX 已经不再依赖旧的 provider/runtime 路径，是干净的 ACP-native 方向。
- agent runtime 被放入独立 crate，后续可以作为稳定边界继续扩展。
- 规格、任务、验收记录比 Codeg 更可追踪。
- 7 agent registry 的产品意图很明确。

不足：

- 成熟度仍低于 Codeg 的 ACP connection/lifecycle/session state 体系。
- 缺少独立 server/web 运行时下的 agent runtime 等价能力。
- 缺少 Codeg 的 binary cache、生命周期订阅、delegation listener、idle sweep 等完整产品机制。
- 历史导入和 live session 的数据模型还没有形成 Codeg 那种统一 conversation 聚合能力。

### 5.2 codeg-main agent 平台

Codeg 的 ACP 相关代码规模明显更大，且已经围绕产品闭环打通：

- `src-tauri/src/acp/connection.rs`
- `src-tauri/src/acp/manager.rs`
- `src-tauri/src/acp/lifecycle.rs`
- `src-tauri/src/acp/session_state.rs`
- `src-tauri/src/acp/delegation/*`

它不仅是“能连接 agent”，而是完整处理了：

- session lifecycle
- connection manager
- internal ACP bus
- event broadcasting
- delegation broker
- companion sidecar
- cancellation
- feedback/question 工具
- server 与 desktop 共享 runtime

优势：

- 更接近真实产品里长期运行的 agent 运行层。
- multi-agent 协作是后端能力，不只是前端展示。
- server/web/desktop 共用更多基础设施。

不足：

- 单 crate 体量很大，边界没有 VibeX workspace 化清晰。
- ACP、web、chat channel、delegation、DB、Git、更新等能力耦合在一个主 crate 中，长期维护需要更强纪律。
- 复杂度明显高于 VibeX，局部修改风险也更高。

### 5.3 Agent 平台结论

VibeX 的方向正确，底座已经重建完成；Codeg 的成熟度更高。VibeX 下一步不应再重建基础 runtime，而应优先补三个产品能力：

1. 历史 conversation 聚合与专用 parser。
2. 真正的 delegation broker/sidecar。
3. transport/server/web 运行边界。

## 6. Conversation Rendering 对比

### 6.1 VibeX 当前状态

VibeX 的 `docs/specs/codeg-alignment/02-conversation-rendering/phase2-closure-review.md` 显示，Phase 2 的核心项已经完成或合理 deferred：

- Markdown fallback layer
- Shiki code highlighting
- CJK/soft break behavior
- KaTeX
- Mermaid
- virtual rows
- thinking cards
- 多类型 tool cards
- inline diff
- nav rail
- TurnStats / LiveTurnStats
- `@` / command sources
- 单条 queued prompt 可视化
- images / generated image cards
- cropped/deferred overlay scrollbar 策略

优势：

- VibeX 的 conversation rendering 已经从“基础消息列表”升级为“工程可用消息流”。
- 对代码、工具调用、diff、数学、图表、图片等编码场景覆盖较全。
- 有较多测试和 closure review 记录，回归保护意识强。

不足：

- 目前是 fallback layer，不是 Codeg 那种完整 `streamdown` 产品链。
- 和国际化、远程 web、delegation card、chat channel 等产品功能的整合仍不足。
- 视觉 polish、极端长会话性能、真实 agent 各种输出兼容性仍需要持续验证。

### 6.2 codeg-main 当前状态

Codeg 使用更成熟的前端渲染依赖和产品组件：

- `streamdown`
- `virtua`
- `use-stick-to-bottom`
- 多语言 UI
- delegation 相关展示
- conversation/folder/session 级产品模型

优势：

- 消息渲染不是孤立组件，而是和产品信息架构、i18n、agent delegation、会话聚合绑定在一起。
- 对真实用户使用场景更完整。

不足：

- 因为产品面更广，组件体系理解成本更高。
- 对 VibeX 来说，完全照搬 Codeg 的 rendering stack 会引入较大迁移成本。

### 6.3 Rendering 结论

VibeX 与 Codeg 在“单条 conversation 的展示能力”上已经接近，但在“conversation 作为产品对象”的完整性上仍落后。差距主要不再是 Markdown 高亮，而是：

- conversation import
- conversation folder/model
- delegation lifecycle
- web/desktop 统一 transport
- i18n 文案体系
- 设置项与用户偏好持久化

## 7. 历史会话与 Conversation 聚合对比

这是 VibeX 当前与 Codeg 差距最大的功能域之一。

### 7.1 VibeX 当前状态

VibeX 的 `crates/agents/src/history` 实现了通用 JSON/JSONL importer。它大致能：

- 扫描默认历史路径。
- 从 `content`、`text`、`message` 等字段猜测消息内容。
- 识别 role、timestamp、session id 等通用字段。
- 将 import 结果通过 Tauri command 存储。

优势：

- 实现简单、通用、容易扩展。
- 对未知 agent 格式有一定容错。
- 足以支撑最早期的“看见外部历史”。

不足：

- 对每个 agent 的历史格式理解不深。
- 无法和 Codeg 那样恢复大量 provider-specific metadata。
- 很难准确还原工具调用、thinking、usage、branch、attachments、fork、subagent 等结构。
- conversation 聚合模型还不够产品化。

### 7.2 codeg-main 当前状态

Codeg 有专门的 parser 模块：

- `parsers/claude.rs`
- `parsers/codex.rs`
- `parsers/gemini.rs`
- `parsers/openclaw.rs`
- `parsers/opencode.rs`
- `parsers/cline.rs`
- `parsers/hermes.rs`

这些 parser 体量明显更大，说明它不是只做字段猜测，而是深入处理不同 agent 的历史结构。

优势：

- 更适合真实迁移用户历史数据。
- 可以支撑统一 conversation/folder/session 视图。
- 对导入质量、去重、排序、元数据保留更有利。

不足：

- parser 维护成本更高。
- agent 历史格式变化时需要逐个维护。

### 7.3 历史聚合结论

如果 VibeX 要真正对齐 Codeg，历史会话不能停留在 generic importer。建议把下一阶段列为高优先级：

1. 建立统一 imported conversation 数据模型。
2. 为 7 类 agent 分别建立 parser。
3. 保留 raw payload，避免解析损失不可逆。
4. 做导入去重、增量扫描、错误报告和可重试队列。
5. 给前端做 conversation library / source filter / folder view。

## 8. 多 Agent Delegation 对比

### 8.1 VibeX 当前状态

VibeX 当前能看到对 subagent/spawn 类输出的前端展示痕迹，但没有发现等价于 Codeg 的运行时 delegation broker 或 MCP sidecar。

当前更像是：

- 如果 agent 输出里出现类似 subagent 工具调用，前端可以展示。
- runtime 没有真正负责“启动另一个 agent、建立父子连接、传递问题、汇总结果、取消子任务、控制深度”的完整机制。

优势：

- 前端已经有显示某些 subagent 形态的基础。
- 可以在现有 ACP-native runtime 上继续扩展。

不足：

- 没有真正的 multi-agent collaboration 能力。
- 没有 `codeg-mcp` 等价 sidecar。
- 没有 delegation depth/cancel/status/live reply 等关键能力。
- 对“多个 agent 协作编码”的产品承诺还不能兑现。

### 8.2 codeg-main 当前状态

Codeg 有完整 delegation 栈：

- `src-tauri/src/bin/codeg_mcp.rs`
- `src-tauri/src/acp/delegation/broker.rs`
- `src-tauri/src/acp/delegation/companion.rs`
- `src-tauri/src/acp/delegation/listener.rs`
- `src-tauri/src/acp/delegation/transport.rs`

能力包括：

- MCP stdio companion。
- `delegate_to_agent`、feedback、question 等工具。
- parent connection id、socket path、token、parent pid、features。
- 并发 JSON-RPC dispatch。
- cancellation。
- broker 侧统一调度。

### 8.3 Delegation 结论

这是 Codeg 对 VibeX 的核心护城河之一。VibeX 如果目标是 Codeg-equivalent 产品，delegation 应作为高优先级里程碑，而不是 UI 优化项。

建议实现顺序：

1. 先抽象 delegation domain model：parent session、child session、task request、task result、status、cancel reason。
2. 后端先做本地单机 broker。
3. 再做 sidecar / MCP tool 暴露。
4. 最后接入前端 card、timeline、status、cancel、result fold。

## 9. 本地项目、Workspace 与工程工作流对比

### 9.1 VibeX 的优势

VibeX 在本地工程工作台方向有明显自己的设计，不只是 Codeg 的拷贝：

- Local projects 路由清晰。
- Workspace 与 task 绑定更强。
- Git worktree 是核心工作流之一。
- 有 preview proxy 与 click-to-component 类能力。
- 有 project rail 与 desktop toast。
- 有 local usage cache。
- 有 task board / kanban 倾向的信息架构。

这使 VibeX 更像“围绕一个本地代码项目持续工作的 agent IDE 壳”，而 Codeg 更像“多 agent 会话与跨端 workspace 产品”。

VibeX 在以下场景可能优于 Codeg：

- 多个任务并行用 worktree 隔离。
- 长时间围绕同一 repo 做 agent 编码任务。
- 希望把 project、workspace、task、session 绑定成工程闭环。
- 本地预览、文件树、git 状态与 agent 会话紧密结合。

### 9.2 codeg-main 的优势

Codeg 的项目/workspace 形态更产品化：

- 路由更多，包括 commit、merge、push、stash、workspace、project-boot 等。
- Git 操作有独立窗口或路由。
- Remote/web transport 支撑非桌面使用。
- Chat channel 与 server 让 workspace 可以被外部事件触发。
- 版本控制账号、credential helper 与 keyring 更完整。

Codeg 更适合：

- 作为面向普通用户的完整产品发布。
- 桌面和服务器两种部署。
- 多语言、多设置项、多入口场景。
- 外部聊天平台触发 coding agent。

### 9.3 工程工作流结论

VibeX 不应简单复制 Codeg 的 folder/workspace 模型。更好的策略是保留 VibeX 的项目、任务、worktree 优势，同时补齐 Codeg 的产品化能力：

- Git credential/keyring。
- GitHub account 管理。
- Project Boot。
- 版本控制操作入口。
- Web/server transport。
- 备份恢复。
- 用户级 workspace transfer。

## 10. 设置中心与产品能力对比

### 10.1 VibeX 设置中心

当前 VibeX 设置入口大致包括：

- agents
- skills
- mcp
- shortcuts
- editor
- appearance
- system

这些是一个本地桌面编码工具的基础设置，但距离 Codeg 的设置体系仍有明显差距。

主要缺口：

- model providers
- experts
- quick messages
- version control accounts
- chat channels
- web service
- system proxy
- backup/restore
- delegation settings
- update/version management
- i18n/language settings

### 10.2 codeg-main 设置中心

Codeg 设置中心约 13 个 section：

- appearance
- general
- mcp
- skills
- experts
- agents
- model-providers
- quick-messages
- shortcuts
- version-control
- chat-channels
- web-service
- system

这些设置项体现出 Codeg 已经把自己当成完整产品，而不是单一桌面工具。

### 10.3 设置中心结论

VibeX 的设置中心目前属于“最低可用配置面”。如果继续对齐 Codeg，建议按以下顺序补齐：

1. version-control：GitHub/Git token/keyring/credential helper。
2. system proxy：系统代理、agent env、preview proxy 的统一配置。
3. model providers：如果 VibeX 未来支持非 ACP 模型或 provider 配置。
4. MCP marketplace：官方 registry、Smithery、本地扫描、参数化安装。
5. skills CRUD：全局/项目级 skills 创建、编辑、删除、启用。
6. web service：server/token/remote desktop 相关。
7. chat channels：Telegram/Lark/Weixin 等外部入口。
8. backup/restore 与 update。

## 11. MCP 与 Skills 对比

### 11.1 VibeX

VibeX 目前已有：

- agent config read/write。
- MCP list/write。
- skills list。
- install/preflight 相关 surface。

但它更偏“本地配置文件读取与写入”，还不是完整 marketplace 和配置生命周期。

不足：

- 没有 Codeg 的官方 MCP registry / Smithery marketplace 等价能力。
- 没有完整 server install/upsert/remove/canonicalize 流程。
- skills 更偏读取本地目录，缺少完整 CRUD、scope、project/global 管理。
- 缺少 experts、quick messages 等上层生产力抽象。

### 11.2 codeg-main

Codeg 的 MCP 命令更像产品级配置中心：

- 本地扫描。
- 官方 registry。
- Smithery。
- install/upsert/remove。
- stdio/http/sse protocol 支持。
- 跨 app 类型 canonicalization。
- 参数化配置。

### 11.3 结论

VibeX 的 MCP/Skills 已有接口入口，但完整度还不够。建议不要只做 UI 页面，而是先定义统一配置生命周期：

- discover
- inspect
- install
- configure
- enable/disable
- update
- remove
- validate
- repair

## 12. Git、凭据与版本控制对比

### 12.1 VibeX

VibeX 有 git 相关 crate 和 services，也有 repo commands、PR/comments/issues 等功能痕迹。它适合做本地 repo 工作流。

但缺少 Codeg 级别的凭据产品化：

- keyring store。
- GitHub account 管理。
- credential helper。
- askpass 注入。
- token validation。
- web/server 下的 version-control handlers。

### 12.2 codeg-main

Codeg 包含：

- `git_credential.rs`
- `keyring_store.rs`
- `commands/version_control.rs`
- `web/handlers/version_control.rs`

这些能力让它可以在桌面和 server/web 形态下更完整地处理 Git 认证。

### 12.3 结论

VibeX 的 git 工作流“工程操作”较强，但“账号与凭据产品化”不足。如果未来要支持 remote/web/server 或更完整 GitHub 集成，这块必须补。

## 13. 部署、Web Service 与远程能力对比

### 13.1 VibeX

VibeX 当前主要是桌面应用：

- Tauri `main` window。
- Vite dev URL。
- frontend dist。
- shell/fs/dialog 插件。
- 本地 preview proxy。

没有发现等价 Codeg 的：

- `codeg-server`。
- `codeg-mcp` sidecar。
- web static resource serving。
- token auth。
- upload staging/quota/jail。
- Docker deployment。
- server install scripts。
- remote desktop transport。
- updater artifacts。

### 13.2 codeg-main

Codeg 有完整跨端产品化：

- standalone `codeg-server`。
- Axum router。
- token auth。
- upload quota。
- static web serving。
- remote desktop transport。
- supervisor。
- Docker。
- install scripts。
- Tauri updater。
- `codeg-mcp` external binary。

### 13.3 结论

这是产品完整度差距最大的部分之一。VibeX 当前是“桌面优先”，Codeg 是“桌面 + server/web + sidecar + deployment”。

如果 VibeX 没有 web/server 目标，可以暂时不追这部分。但如果目标是完整对齐 Codeg，这应当单独成为一个大阶段，而不是作为普通功能小修小补。

## 14. 国际化与用户文档对比

### 14.1 VibeX

未发现完整 i18n 框架，例如 `next-intl`、`i18next`、`react-i18next` 等。前端文案大概率仍是直接写在组件中。

文档方面，VibeX 的内部 specs 很强：

- codeg-alignment
- acp-native-agent-platform
- phase closure review
- task breakdown
- traceability

但用户级文档较弱。当前 README 在终端输出中还观察到编码显示异常，至少说明文档编码/显示兼容性需要检查。

### 14.2 codeg-main

Codeg 有多语言 README 和 message files：

- zh-CN
- zh-TW
- en
- ja
- ko
- fr
- de
- es
- pt
- ar

前端广泛使用 `useTranslations`。

### 14.3 结论

VibeX 内部工程文档强，Codeg 用户文档和国际化强。若 VibeX 要产品化，对外文档和 i18n 应尽早规划，否则后续 UI 文案越多，迁移成本越高。

## 15. 安全、运维与可靠性对比

### 15.1 VibeX 当前安全优势

- local-first，网络暴露面较小。
- ACP-native cutover 后旧 runtime 路径减少，边界更清楚。
- preview proxy 与 agent runtime 分离。
- Phase 2 对 Shiki/Mermaid/图片路径等有一定安全考虑。
- workspace crate 边界有利于后续安全审计。

### 15.2 VibeX 当前不足

- 无完整 keyring/credential helper。
- 无 server token auth，因为暂无 server 产品形态。
- 无 upload quota/jail。
- 无 updater 签名链。
- 无 backup/restore。
- 无系统代理持久化与 UI。
- 无 web service 权限模型。

### 15.3 Codeg 安全与运维优势

- keyring。
- token auth。
- upload quota/jail。
- credential helper。
- updater signing。
- server supervision。
- backup/restore。
- proxy settings。

### 15.4 Codeg 风险

Codeg 的安全边界更复杂，因为它暴露了更多能力：

- standalone server。
- web service。
- chat channels。
- upload。
- remote transport。
- sidecar。
- credentials。

功能越完整，攻击面也越大。Codeg 需要更严密的权限、token、路径、上传和生命周期管理。VibeX 目前因为功能少，天然攻击面小，但一旦补 server/web，也需要同步补安全模型。

## 16. 完整性评分

评分说明：

- 10 分表示接近成熟产品级完整度。
- 5 分表示基础可用但明显缺产品闭环。
- 1 分表示基本不存在或只是 UI 痕迹。

| 维度 | VibeX | codeg-main | 说明 |
| --- | ---: | ---: | --- |
| Agent registry 覆盖 | 8.0 | 8.5 | 两者都覆盖 7 类 agent，Codeg 更成熟 |
| Live ACP session | 7.5 | 9.0 | VibeX 已完成 ACP-native cutover，Codeg lifecycle 更完整 |
| Conversation rendering | 8.0 | 8.5 | VibeX Phase 2 进展很大，Codeg 产品整合更强 |
| 历史会话聚合 | 3.5 | 9.0 | VibeX generic importer，Codeg 专用 parser 完整 |
| 多 agent delegation | 2.0 | 9.0 | VibeX 基本没有真正 broker/sidecar |
| 本地工程 workbench | 8.0 | 8.0 | VibeX worktree/task 强，Codeg product routes 强 |
| MCP/Skills 生态 | 4.5 | 8.5 | VibeX 有入口，Codeg 有 marketplace/install 生命周期 |
| Git 凭据/账号 | 4.0 | 8.5 | VibeX 有 git 操作，Codeg 凭据产品化更完整 |
| 设置中心 | 4.5 | 9.0 | VibeX 7 tab，Codeg 13 section |
| i18n | 1.5 | 9.0 | VibeX 未见完整 i18n，Codeg 多语言完整 |
| Web/server/deployment | 2.5 | 9.0 | VibeX 桌面为主，Codeg 跨端部署完整 |
| 安全/运维产品化 | 4.0 | 8.5 | VibeX 攻击面小但机制少，Codeg 机制更完整 |
| 内部规格与追踪 | 8.5 | 5.5 | VibeX specs/closure review 更强 |
| 用户文档与发布体验 | 4.0 | 9.0 | Codeg README/安装/多语言更强 |

总体评分：

| 总体维度 | VibeX | codeg-main |
| --- | ---: | ---: |
| 本地桌面核心能力 | 6.8 到 7.2 | 8.5 |
| 完整产品能力 | 5.0 到 5.5 | 8.8 |
| Codeg 对齐程度 | 约 55% 到 60% | 100% 参考基准 |
| 面向普通用户交付度 | 约 45% 到 55% | 约 85% 到 90% |

## 17. VibeX 的主要优势

### 17.1 工程边界更清楚

VibeX 使用 workspace crate 组织后端，`crates/agents`、`crates/db`、`crates/services`、`crates/git` 等边界比 Codeg 单 crate 更清楚。长期看，这有利于：

- 局部测试。
- 代码所有权划分。
- 未来抽出 server/runtime。
- 降低单文件膨胀。

### 17.2 内部规格更完整

VibeX 有非常系统的 specs：

- ACP-native platform cutover。
- legacy removal verification。
- Codeg alignment phase docs。
- traceability。
- closure review。

这让后续开发可以更容易知道“为什么这样做”和“下一阶段补什么”。

### 17.3 本地任务/worktree 工作流有特色

VibeX 不只是聊天壳，它更强调：

- project。
- workspace。
- task。
- session。
- git worktree。
- preview。
- project rail。

这对 agent 编码场景非常有价值，尤其适合多任务并行和隔离开发。

### 17.4 Conversation rendering 已经明显追上

Phase 2 完成后，VibeX 在消息展示能力上不再是主要短板。继续优化应聚焦真实输出兼容性和产品模型，而不是重复做 Markdown 基础功能。

## 18. VibeX 的主要劣势

### 18.1 产品 surface 不完整

VibeX 当前更像强工程骨架，Codeg 更像完整产品。VibeX 缺少：

- server。
- web service。
- updater。
- Docker。
- install scripts。
- sidecar。
- chat channels。
- i18n。
- credential/keyring。
- marketplace。

### 18.2 历史导入过浅

generic importer 是起点，不是终点。真实用户从 Claude/Codex/Gemini/OpenCode 等迁移历史时，会遇到大量格式差异。Codeg 的 parser 投入明显更多。

### 18.3 多 agent 协作还没有真正落地

如果产品宣传多 agent collaboration，VibeX 现在只能算前端/概念层准备，还没有运行时能力。

### 18.4 设置与用户偏好体系太薄

Codeg 的设置中心已经覆盖实际使用中的大量问题。VibeX 目前设置页能支撑早期本地使用，但不足以支撑完整产品。

### 18.5 缺少跨环境抽象

Codeg 前端通过 transport abstraction 区分 Tauri/Web/Remote Desktop。VibeX 仍主要是桌面命令调用思路。后续如果想做 web/server，这会成为架构迁移点。

## 19. codeg-main 的主要优势

### 19.1 完整产品化

Codeg 覆盖桌面、server、web、Docker、updater、sidecar、chat channels，是明显经过产品化打磨的项目。

### 19.2 多 agent 协作是真能力

Codeg 的 delegation broker 和 `codeg-mcp` sidecar 是后端事实，不是 UI 假象。

### 19.3 历史聚合深

针对 7 类 agent 的 parser 是很大的投入，也是用户迁移和 session library 的基础。

### 19.4 设置生态完整

MCP marketplace、Skills、Experts、Model Providers、Quick Messages、Chat Channels、Version Control、Web Service 等构成了完整用户配置面。

### 19.5 国际化与发布体验强

多语言 README、多语言 messages、安装脚本、Docker、updater 都让 Codeg 更像可直接面向用户发布的产品。

## 20. codeg-main 的主要劣势

### 20.1 单 crate 复杂度高

Codeg 后端能力很多，但集中在一个主 Rust crate 中。ACP、server、web、chat channel、credential、update、delegation 等都在同一大工程里，长期维护压力更高。

### 20.2 产品面广带来攻击面和测试压力

server、upload、remote transport、chat channels、credential helper、sidecar 都需要严格安全测试。Codeg 功能越完整，安全和运维复杂度也越高。

### 20.3 内部规格不如 VibeX 体系化

Codeg 用户文档强，但从当前文件观察，类似 VibeX 这种阶段规格、任务拆解、closure review、traceability 的内部工程文档较少。

### 20.4 不一定适合直接照搬

Codeg 的 Next.js、React 19、Tauri resource/server 架构、single crate 组织方式，与 VibeX 当前 Vite + workspace crate 设计不同。VibeX 应吸收能力，而不是机械迁移结构。

## 21. 对 VibeX 的优先级建议

### P0：决定产品方向并补关键底座

1. 明确 VibeX 是否要完整对齐 Codeg 的 server/web 产品形态。
   - 如果是，需要尽早引入 transport abstraction。
   - 如果否，应把 VibeX 定位成更强本地桌面 agent workbench，不追所有 Codeg server 能力。

2. 补齐历史会话聚合。
   - 建立统一 conversation model。
   - 为 7 类 agent 写专用 parser。
   - 支持增量导入、去重、错误报告、raw payload 保留。

3. 做真正 delegation runtime。
   - broker。
   - sidecar/MCP tool。
   - child session lifecycle。
   - cancel/status/live result。

4. 尽早引入 i18n scaffolding。
   - 哪怕第一阶段只做英文/中文，也应避免未来所有 UI 文案二次迁移。

### P1：补产品配置与安全闭环

1. MCP marketplace。
2. Skills CRUD 与 project/global scope。
3. GitHub/Git account、keyring、credential helper。
4. System proxy 设置与 env 统一应用。
5. Backup/restore。
6. Settings center 重构。
7. Update/version management。

### P2：补 Codeg 产品体验项

1. Project Boot。
2. Chat Channels。
3. Quick Messages。
4. Experts。
5. Model Providers。
6. Web service UI。
7. 更完整用户文档和安装指南。

### P3：打磨与差异化

1. 强化 VibeX 自己的 task/worktree 工作流。
2. 让 preview proxy、component inspector、agent session 更紧密结合。
3. 做任务级 dashboard 和多 worktree 状态聚合。
4. 保持 workspace crate 分层，避免因为追 Codeg 功能而变成单体泥球。

## 22. 建议的阶段路线图

### 阶段 A：Conversation Library 与 Import

目标：把历史导入从“能读一些 JSON”升级为“用户可信的会话库”。

交付：

- `ConversationSource` / `ImportedConversation` / `ImportedMessage` 数据模型。
- 7 类 agent parser。
- raw payload 保留。
- import job 状态。
- duplicate detection。
- frontend conversation library 页面。
- parser fixtures。

### 阶段 B：MCP/Skills/Settings 生态

目标：让设置中心从基础 tab 变成产品配置中心。

交付：

- MCP registry / Smithery / local scan。
- MCP install/remove/update/validate。
- Skills CRUD。
- global/project scope。
- Git account/keyring。
- system proxy。
- settings nav 重构。

### 阶段 C：Delegation

目标：让 VibeX 具备真正多 agent 协作能力。

交付：

- delegation broker。
- child session lifecycle。
- sidecar/MCP command。
- cancel/status/depth。
- frontend delegation card。
- delegation settings。
- integration tests。

### 阶段 D：Transport 与 Server

目标：决定并实现 web/server 边界。

交付：

- frontend transport abstraction。
- desktop transport。
- web transport。
- token auth。
- server process。
- static resource serving。
- upload path/quota policy。
- remote desktop mode。

### 阶段 E：发布产品化

目标：让 VibeX 从开发者本地项目变成可交付产品。

交付：

- updater。
- installer scripts。
- Docker。
- backup/restore。
- user docs。
- multi-language README。
- onboarding。
- release checklist。

## 23. 不建议做的事

1. 不建议直接把 Codeg 的 Next.js 架构迁移到 VibeX。
   - VibeX 当前 Vite + Tauri + workspace crate 已经可用。
   - 真正缺的是 transport/server/delegation 等能力，而不是 Next.js 本身。

2. 不建议为了对齐 Codeg 而弱化 VibeX 的 task/worktree 模型。
   - 这是 VibeX 的差异化优势。

3. 不建议继续堆 UI 页面但不补后端能力。
   - Delegation、MCP marketplace、Git credential、server/web 都必须有后端闭环。

4. 不建议把 generic history importer 当成最终方案。
   - 它可以保留为 fallback，但必须有 agent-specific parser。

5. 不建议在 i18n 缺位时继续大量新增硬编码文案。
   - 越晚迁移，成本越高。

## 24. 证据索引

VibeX 关键路径：

- `Cargo.toml`
- `package.json`
- `frontend/package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/commands/agents.rs`
- `src-tauri/src/commands/skills.rs`
- `crates/agents/src/lib.rs`
- `crates/agents/src/registry.rs`
- `crates/agents/src/events.rs`
- `crates/agents/src/history/mod.rs`
- `frontend/src/MainAppRoutes.tsx`
- `frontend/src/pages/settings/SettingsLayout.tsx`
- `docs/specs/acp-native-agent-platform/README.md`
- `docs/specs/acp-native-agent-platform/00-master-cutover/tasks.md`
- `docs/specs/acp-native-agent-platform/05-legacy-removal-verification/tasks.md`
- `docs/specs/codeg-alignment/traceability.md`
- `docs/specs/codeg-alignment/01-agent-session-core/phase1-closure-review.md`
- `docs/specs/codeg-alignment/02-conversation-rendering/phase2-closure-review.md`

codeg-main 关键路径：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/lib.rs`
- `src-tauri/src/app_state.rs`
- `src-tauri/src/bin/codeg_server.rs`
- `src-tauri/src/bin/codeg_mcp.rs`
- `src-tauri/src/acp/connection.rs`
- `src-tauri/src/acp/manager.rs`
- `src-tauri/src/acp/lifecycle.rs`
- `src-tauri/src/acp/session_state.rs`
- `src-tauri/src/acp/delegation/*`
- `src-tauri/src/parsers/*`
- `src-tauri/src/chat_channel/*`
- `src-tauri/src/network/proxy.rs`
- `src-tauri/src/keyring_store.rs`
- `src-tauri/src/git_credential.rs`
- `src-tauri/src/commands/mcp.rs`
- `src-tauri/src/commands/version_control.rs`
- `src-tauri/src/web/*`
- `src/lib/transport/index.ts`
- `src/lib/api.ts`
- `src/components/settings/settings-shell.tsx`
- `src/i18n/messages/*.json`
- `docs/readme/README.zh-CN.md`

## 25. 最终判断

VibeX 当前已经完成了最关键的“内部换骨”：ACP-native runtime 与 conversation rendering 两个基础层已经明显成型。这个进展很重要，因为它说明 VibeX 不再只是追 Codeg 外观，而是在建立自己的工程底座。

但从完整产品角度看，Codeg 仍然领先一个大阶段。Codeg 的优势集中在可交付产品能力：server/web、sidecar、delegation、history parsers、MCP marketplace、settings ecosystem、credentials、chat channels、i18n、updater、Docker 和用户文档。

因此，VibeX 后续最合理的策略不是“逐页复刻 Codeg”，而是：

1. 保留 VibeX 的本地项目、任务、worktree、preview 工作流优势。
2. 吸收 Codeg 的产品化能力，优先补 history、delegation、MCP/Skills、credentials、i18n、transport/server。
3. 在补齐能力时保持 workspace crate 分层，避免复制 Codeg 单体复杂度。

如果执行上述路线，VibeX 可以形成一个比 Codeg 更偏工程任务管理和本地并行开发的差异化产品，而不是只做 Codeg 的次级复刻。