# BB（get-bb/bb）与 VibeX 对比调研

> 调研日期：2026-08-12
> BB 快照：[`get-bb/bb`](https://github.com/get-bb/bb) `aefe3ea`（2026-08-11）
> VibeX 快照：当前工作区的 README、实现结构与已接受 ADR
> 资料原则：外部事实只采用 BB 官方仓库、文档、源码与 Releases；不把路线图当成已交付能力。

## 执行摘要

正确的 BB 不是一个单体终端 Agent，而是与 VibeX **高度重叠的直接竞品**。两者都在做
多 Agent 的统一工作空间、会话控制面、隔离执行、委派、插件与自动化。区别主要在产品
路线，而不是问题层级：

- **BB** 更接近“可由人和 Agent 共同编程的 Agent IDE / 软件工厂”。桌面、Web、CLI、
  HTTP API 和 Node SDK 共用一套 Server；Agent 可以通过 `bb` CLI 反过来操作 BB 本身。
  多机器 Host、manager/child threads、Workflows、Automations 和插件 SDK 已形成完整体系。
- **VibeX** 更接近“本地优先、原生跨平台、强治理的 Integrated Agent Platform”。它在
  Agent 检测/安装/认证/更新、ACP 语义、桌面交付工作台、隐私默认值和跨平台发行上更强，
  但 CLI/SDK、自操作、多机器执行、确定性工作流和插件开发生态尚未达到 BB 的成熟度。

总体判断：**BB 当前在“平台可编程性和远程/多 Host 协作”上领先；VibeX 在“原生桌面、
隐私、Agent 生命周期治理和完整开发工作台”上有清晰差异化。** VibeX 不宜追逐 BB 的所有
功能，而应优先补齐 CLI/SDK、自操作、远程产品化和确定性工作流，同时守住安全与本地优先
优势。

## 比较边界

BB 官方明确说明项目仍在快速开发，核心架构稳定，但 workflows 和 surfaces 仍在演进。
桌面发行目前只支持 macOS Apple Silicon；`npx bb-app@latest` 的 Server/Web/CLI 路径支持
macOS、Linux 与 Windows WSL2。本文因此把“BB Web 可用”和“BB 原生桌面跨平台”分开判断。
[BB README](https://github.com/get-bb/bb#readme) ·
[平台支持](https://github.com/get-bb/bb/blob/main/docs/platform-support.md)

VibeX 也仍处于测试阶段。当前已有 Remote Protocol、配对/撤销、持久补放和可从源码构建的
`vibex-server`，但桌面 Server Profiles、官方 Server 容器/二进制和 Android companion
仍是未发布路线图，不计入当前产品能力。[VibeX README](../../README.zh-CN.md)

## 核心能力矩阵

| 维度 | BB | VibeX | 当前判断 |
| --- | --- | --- | --- |
| 产品定位 | 可编程 Agent IDE；人和 Agent 都是一等用户 | 本地优先 Integrated Agent Platform | 高度重叠，BB 更强调“系统自操作” |
| 客户端 | Electron 桌面、Web、CLI、HTTP API、Node SDK | Tauri 桌面为主；Remote Protocol/Headless 基础 | BB 的入口和自动化接口更完整 |
| 中央架构 | SQLite Server 为事实源；WebSocket；每台执行机一个 Host daemon | 共享 Application Core；桌面/Headless Host；版本化远程传输 | 两者方向接近，BB 当前产品化更完整 |
| Agent/Provider | Claude Code、Codex、Cursor ACP、Pi、OpenCode、Grok、Hermes 及自定义 ACP | Claude Code、Codex、OpenCode、Pi 与 ACP Registry Agent | 覆盖相近；VibeX 的安装与完整性治理更深 |
| 环境隔离 | unmanaged checkout 或 managed Git worktree；可选 setup | 项目/workspace/worktree 为一等对象 | 两者都强；BB 的远程 Host 串联更成熟 |
| 会话与委派 | standard/manager threads、child threads、隐藏 worker、steer/queue、fork、edit/retry | Conversation/Turn、异步子会话委派、分叉/恢复/取消/重试、事件投影 | BB 操作面更丰富；VibeX 终态和恢复语义更严谨 |
| 工作流 | provider-independent Workflows；parallel/pipeline/phase、预算、超时、恢复、结构化输出 | Automation 已实现；ADR 明确暂未采用显式图编排 | BB 在确定性多 Agent 编排上明显领先 |
| 插件 | 后端 service/cron/HTTP/RPC、UI slots、CLI、存储、官方插件与安装源 | 统一 VibeX/Codex/Claude control plane、Skills/MCP/Runtime、投影与信任治理 | BB authoring/生态更成熟；VibeX 治理模型更谨慎 |
| IDE 配套 | 项目、线程、diff/log、终端/编辑器打开等 Agent 工作区能力 | Git/Diff、文件、多个终端、CEF 浏览器、会话看板、Office Artifact | VibeX 的原生桌面交付闭环更宽 |
| 多端/多机 | 浏览器控制远端 Server；多个已注册 Host；Connect/Tailscale | 远程协议与 Headless 基础已存在，产品化仍在推进 | BB 当前领先 |
| 平台发行 | 桌面仅 macOS ARM64；Host 为 macOS/Linux/WSL2，要求 Node 22.19+ | macOS Intel/ARM64、Windows x64/ARM64、Linux x64/ARM64 原生桌面包 | VibeX 明显领先 |
| 隐私默认值 | 有限匿名生产遥测，默认开启、可用 `BB_TELEMETRY=false` 关闭 | 不自动上传项目、会话、配置或诊断到 VibeX 服务 | VibeX 更符合纯本地优先预期 |
| 社区成熟度 | 调研时约 1.7k stars、176 forks、4.6k commits，发布节奏快 | 社区和生态体量较小，仍在测试阶段 | BB 的市场验证与贡献面更强 |

BB 的系统构成和边界见[系统概览](https://github.com/get-bb/bb/blob/main/docs/system-overview.md)、
[仓库概览](https://github.com/get-bb/bb/blob/main/docs/repository-overview.md)和
[`bb-app` 文档](https://github.com/get-bb/bb/blob/main/packages/bb-app/README.md)。

## BB 的主要优势

### 1. 所有入口共享同一个可编程内核

桌面、Web、CLI、HTTP API 和 Node SDK 都连接同一 Server，而不是各自维护状态。CLI 被定义
为人和 Agent 的一等接口，Agent 可以创建/查询/引导线程、查看结果和控制工作空间。这使
“Agent 操作 Agent IDE 本身”成为产品能力，而不是额外自动化脚本。

这是 BB 最强的战略优势：UI 中能做的事情更容易被组合、测试、远程调用，也更容易形成
自举的软件工厂。[系统概览](https://github.com/get-bb/bb/blob/main/docs/system-overview.md) ·
[`bb-app` CLI/SDK](https://github.com/get-bb/bb/blob/main/packages/bb-app/README.md#cli)

### 2. 多机器执行已经进入产品主路径

Server 负责状态与路由，每台执行机器运行 Host daemon，负责 workspace provisioning、
provider 进程和事件回传。浏览器是控制面，不承担执行；用户可用 BB Connect 或 Tailscale
访问自己的 Server，并把不同项目/环境路由到不同机器。

相较之下，VibeX 已有正确的共享 Core 与 Remote Protocol 方向，但 Server Profiles 和官方
Headless 发行物尚未完成产品化。[多设备文档](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md) ·
[VibeX 远程 ADR](../adr/0033-shared-application-core-and-versioned-remote-transport.md)

### 3. 线程操作模型完整而实用

BB 已提供 standard/manager thread、父子委派、隐藏 worker、steer/queue、跨 provider 启动、
fork、等待和归档等操作。队列消息持久化，manager thread 和 Tasks 插件能把规划与执行分离。
这套能力既可在 UI 使用，也可由 CLI/Agent 调用，形成统一心智模型。

VibeX 的异步委派、独立子会话、取消和事件记录基础很扎实，但目前缺少与 BB 等价的 manager
体验、通用 steer/queue 和同能力 CLI。[BB 官方仓库](https://github.com/get-bb/bb) ·
[VibeX 委派 ADR](../adr/0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)

### 4. Workflows 与 Automations 已形成两层自动化

BB 的 Automations 负责按计划启动 Agent 或脚本；Workflows 则在受限运行时中提供
`agent()`、`parallel()`、`pipeline()`、`phase()` 等确定性编排，包含并发/调用数/超时限制、
运行历史、恢复和 JSON Schema 结构化结果。这不是概念演示，而是有实现与测试的官方插件。

VibeX 已有持久 Automation、版本化 Turn launch spec 和所有权锁，但委派 ADR 明确暂不采用
显式图编排。因此“定时启动一次任务”两者都有，“可恢复的确定性多 Agent 工作流”则是 BB
领先。[BB Workflows](https://github.com/get-bb/bb/tree/main/plugins/workflows) ·
[BB Automations](https://github.com/get-bb/bb/tree/main/plugins/automations) ·
[VibeX Automation ADR](../adr/0032-automations-replay-versioned-turn-launch-specs.md)

### 5. 插件开发面和内置生态更成熟

BB 插件可在 Server 内注册 service、定时任务、HTTP/RPC、线程处理器、设置、存储和 CLI，
前端还可贡献 UI slot。官方仓库已有 Workflows、Automations、Memory、Docs、Tasks、GitHub、
Secrets、Connect 等插件，覆盖从存储到编排的完整样例。

VibeX 的统一插件控制面在跨 Agent 原生生态、来源、binding、Runtime probe 和信任生命周期上
更有治理深度，但开发者 SDK、UI 扩展点和可复用插件生态尚不如 BB 成熟。
[BB 配置与插件文档](https://github.com/get-bb/bb/blob/main/docs/configuration.md#plugins) ·
[VibeX 插件 ADR](../adr/0043-unified-plugin-control-plane-and-global-runtime-trust.md)

### 6. 更强的社区动量

调研快照中，BB 已有约 1.7k stars、176 forks、4.6k commits，并保持高频 stable/nightly
发布。数字会变化，但它反映了更大的用户反馈面、Provider 兼容验证和贡献者基础。
[GitHub 仓库](https://github.com/get-bb/bb) ·
[Releases](https://github.com/get-bb/bb/releases)

## BB 的劣势与风险

### 1. 原生桌面覆盖明显不足

BB 的 Electron 桌面目前只发布 macOS ARM64；Intel Mac、Linux 和 Windows 用户需要走
`npx`/Web，其中 Windows 只支持 WSL2。VibeX 直接提供 macOS Intel/ARM64、Windows
x64/ARM64、Linux x64/ARM64 安装包，对不想维护 Node/WSL 的桌面用户更友好。

BB 的 Host 还依赖 Node 22.19+、Git、Provider CLI，并涉及 `better-sqlite3` 等原生包。统一
TypeScript monorepo 利于迭代，但跨平台安装与 native addon 仍是现实运维面。
[平台支持](https://github.com/get-bb/bb/blob/main/docs/platform-support.md)

### 2. 插件是 Server 内的全信任代码

BB 官方明确说明插件在 Server 进程内运行，是 full-trust code。npm、Git 和本地安装很灵活，
但恶意或有缺陷的插件能获得较大的进程内权限与数据面，故障也可能影响中央 Server。

VibeX 不应复制这条边界。其 Runtime probe、来源/版本证据、显式信任和跨生态 binding 更适合
构建长期安全控制面，即使 authoring 体验更重。

### 3. 权限安全需要主动收紧

BB 的机器权限上限 `maxPermissionMode` 默认是 `full`，线程可选 `accept-edits`、`auto` 或
`full`；`full` 会绕过 sandbox/approval。对于个人本机这很顺手，但团队或远程 Host 应先把
机器 ceiling 调低，再逐任务提升。

更重要的是，BB 文档明确警告：直接把 Server 绑定到 `0.0.0.0` 时，公开 API 无认证并允许
命令执行和文件读取，绝不能暴露到公网；应使用 Connect 或可信 Tailscale 边界。
[配置文档](https://github.com/get-bb/bb/blob/main/docs/configuration.md) ·
[多设备安全说明](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md)

### 4. 便利功能会扩大秘密传播面

`.worktreeinclude` 可以把被 Git 忽略的本地文件复制到新 worktree，官方示例包括 `.env`；
setup 脚本也可安装依赖或生成秘密。这解决了 managed worktree 启动问题，但若缺少最小权限、
过期与清理规则，会把凭据复制到更多目录并暴露给更多 Agent 进程。
[Worktree 文档](https://github.com/get-bb/bb/blob/main/docs/worktrees.md)

### 5. 隐私默认值不如 VibeX 纯粹

BB 的生产遥测默认开启，采集应用启动、thread 数和用户消息数量以及随机安装 ID；官方声明
不收集内容或项目，并允许关闭。它的 Connect 方案也会引入 `getbb.app` 管理的访问路径。
这些设计并非不可接受，但 VibeX“默认不向自营服务上传项目、会话、配置或诊断”的定位更
简单、可解释。[BB README 遥测说明](https://github.com/get-bb/bb#telemetry) ·
[VibeX README](../../README.zh-CN.md)

## VibeX 的主要优势

### 1. Agent 生命周期治理更完整

VibeX 不只启动已安装 CLI，而是统一处理 Agent 检测、托管/外部安装、认证状态、配置、更新、
修复、卸载、版本证据和安装锁，并能托管基础 Node runtime。BB 能发现、安装或升级部分
Provider，并内置 Pi runtime，但核心使用路径仍假设用户已有并已认证 Provider CLI。

这使 VibeX 更适合作为长期的多 Agent 管理层，尤其适合不希望手工维护多个 CLI 和依赖的
桌面用户。[VibeX README](../../README.zh-CN.md) ·
[Agent 安装 ADR](../adr/0011-managed-and-external-agent-installations.md)

### 2. ACP 与会话可靠性语义更严谨

VibeX 把事件日志作为权威，投影可重建；崩溃后的在途 Turn 明确进入 Interrupted，且不自动
重放，避免重复文件修改等副作用。Completed、Failed、Cancelled、Interrupted 被严格区分，
ACP v1/v2 通过适配层保留兼容性。

BB 的线程功能更多，但从公开设计看，VibeX 对协议演进、终态竞争、崩溃恢复和持久补放的
语义约束更系统。[恢复 ADR](../adr/0001-crash-recovery-semantics.md) ·
[远程 ADR](../adr/0033-shared-application-core-and-versioned-remote-transport.md)

### 3. 原生跨平台桌面和交付工作台更完整

VibeX 使用 Tauri/Rust/React，在六个 OS/架构组合发布原生桌面包，并把文件树、Diff、Git、
多个终端、CEF 浏览器、DevTools、会话看板和 Office Artifact 放在同一 Project/Workspace
上下文中。BB 更像 Agent 工作空间与控制台；VibeX 更接近覆盖实现、检查和交付的完整桌面
环境。

这里不能简单推导出 VibeX 性能一定更好——本次没有做同硬件基准测试——但发行覆盖与功能
集成是可验证的产品优势。

### 4. 隐私和插件治理更适合成为差异化

VibeX 默认不向自营云上传数据；插件方向强调来源、portable identity、Agent binding、
Runtime probe/lock、冲突分析和显式 shell trust。BB 的全信任插件模型更快、更开放，VibeX
的模型更适合对安全、审计和多 Agent 配置一致性有要求的团队。

## VibeX 的主要劣势

### 1. 缺少“和 UI 同能力”的一等 CLI/SDK

这是当前最关键的产品缺口。VibeX 的能力主要由桌面 UI 暴露，Agent 还不能像在 BB 中那样，
通过稳定 CLI/SDK 查询并操作项目、会话、委派、自动化和插件。结果是 VibeX 虽然托管 Agent，
但 Agent 对 VibeX 本身的可编程性仍有限。

### 2. 远程与多 Host 架构正确，但产品化落后

VibeX 已有共享 Core、版本化传输、设备配对和 Headless 基础，这是重要资产；但官方 Server
发行物、桌面 Server Profile、远程多机器环境路由和移动控制面还没有成为普通用户可直接
使用的产品路径。BB 已经把 Server/Host/Web/Connect 串成主流程。

### 3. 自动化有了，确定性多 Agent 工作流仍缺位

VibeX 的 Automation 能持久保存 launch spec、调度隔离任务并记录运行，但它仍主要是“按时
启动一轮 Agent”。对于研究、实现、测试、审查等多阶段流程，尚缺 BB Workflows 那样明确的
并行/流水线/阶段、预算、结构化输出、恢复和运行历史模型。

### 4. 插件控制面治理强，开发者体验和生态弱

VibeX 已有较深的插件 control plane 实现，但要形成生态，还需要稳定 SDK、UI contribution
points、后台 service、调度、作用域存储、脚手架、调试器和参考插件。BB 已经用多个官方插件
证明这些扩展点能组合成产品能力。

### 5. 产品宽度带来更高交付成本

Rust/Tauri、React、CEF、ACP、Agent 子进程、数据库、远程协议、插件、自动化和六种平台包
形成很大的组合测试面。VibeX 的每个差异化能力都有价值，但若同时扩张，容易让核心的会话
稳定性、初次启动和日常交互打磨落后于更聚焦的 BB。

## 对 VibeX 的战略建议

### P0：建立可自操作的平台接口

1. **提供与 Application Core 同源的 `vibex` CLI 和 SDK。** 首批覆盖 project/workspace、
   conversation/turn、agent capability、delegation、automation 和 plugin catalog；不能建立
   第二套数据库或绕过 LaunchGate、权限与事件日志。
2. **让 Agent 安全地操作 VibeX 本身。** 以受作用域限制的 CLI/MCP 能力暴露创建子会话、
   查询状态、等待结果、查看 diff 和启动自动化，所有动作进入现有事件/审计模型。

### P0：完成远程产品化

3. **把 `vibex-server` 变成可安装、可升级、可诊断的官方发行物。** 随后交付桌面 Server
   Profiles 与清晰的 Host 在线/离线状态。
4. **统一多机器环境路由。** Project source、Workspace、Agent runtime 和 Host 必须有稳定
   身份；远程传输只做 Application Core 的适配层，不复制业务规则。

### P1：补齐确定性工作流，但保留 VibeX 语义

5. **新增独立 Workflow 领域模型。** 至少定义 run/step、DAG 或受限组合子、并发/预算/超时、
   取消、恢复、结构化输出、事件历史与版本化定义。
6. **不要把 Workflow 混入普通 delegation。** delegation 继续表达 Agent 自主委派；Workflow
   表达用户/系统声明的确定性编排。两者可复用 Conversation/Turn，但权威和恢复规则不同。

### P1：深化插件开发体验，同时强化隔离

7. **提供后端服务、调度、CLI、UI slots 与作用域存储的正式 SDK。** 用官方插件验证每一类
   扩展点，配套脚手架、本地预览、兼容性检查和可观察日志。
8. **不要照搬 BB 的 Server 内 full-trust 默认。** 优先使用进程边界、能力 grants、签名/
   哈希证据和最小权限；任何 shell 或 Host 文件能力都应显式授权并可撤销。

### P2：聚焦可防御的产品差异

9. **继续强化原生跨平台、零自营遥测、Agent 生命周期和 CEF/Office 交付闭环。** 这些是 BB
   短期不容易复制的组合优势。
10. **避免功能数量竞赛。** Web/CLI/SDK、多 Host、Workflow 和插件 DX 是平台杠杆；新增更多
    默认可见面板的边际价值低于把这四项做深。

## 不应照搬 BB 的部分

- 不把直接监听 `0.0.0.0` 的无认证控制 API 作为远程访问捷径。
- 不让第三方插件默认与中央 Server 同进程、同权限运行。
- 不以默认 `full` 机器 ceiling 或单一总开关替代 VibeX 的作用域权限和审计。
- 不在没有秘密分类、过期和清理策略时自动复制 `.env` 等忽略文件到 worktree。
- 不为实现 CLI/SDK 再造一套状态权威；所有 surface 必须共享 Application Core。

## 最终判断

BB 已经证明了一条很有竞争力的路线：**Agent IDE 不只是承载 Agent 的 UI，而应是 Agent 可
编程、可远程、可组合的运行平台。** 在这个维度上，BB 当前领先 VibeX，尤其是 CLI/SDK、
多 Host、Workflows 和插件生态。

VibeX 的机会不是复制一个 TypeScript/Electron 版 BB，而是把自己的优势组合成更安全、更
本地、更完整的替代方案：**原生跨平台桌面 + 严谨 Agent 生命周期 + 可靠事件语义 + 完整
交付工作台**。如果再补上同源 CLI/SDK、远程产品化和确定性 Workflow，VibeX 会从“功能
丰富的 Agent 桌面应用”升级为真正可与 BB 正面竞争的平台。

## 主要来源

### BB 官方资料

- [get-bb/bb README](https://github.com/get-bb/bb#readme)
- [Vision](https://github.com/get-bb/bb/blob/main/docs/VISION.md)
- [System overview](https://github.com/get-bb/bb/blob/main/docs/system-overview.md)
- [Repository overview](https://github.com/get-bb/bb/blob/main/docs/repository-overview.md)
- [bb-app：Web、CLI、SDK 与 Provider](https://github.com/get-bb/bb/blob/main/packages/bb-app/README.md)
- [Platform support](https://github.com/get-bb/bb/blob/main/docs/platform-support.md)
- [Multiple devices](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md)
- [Worktrees](https://github.com/get-bb/bb/blob/main/docs/worktrees.md)
- [Configuration / permissions / plugins](https://github.com/get-bb/bb/blob/main/docs/configuration.md)
- [Workflows 实现](https://github.com/get-bb/bb/tree/main/plugins/workflows)
- [Automations 实现](https://github.com/get-bb/bb/tree/main/plugins/automations)
- [Releases](https://github.com/get-bb/bb/releases)

### VibeX 仓库资料

- [VibeX 中文 README](../../README.zh-CN.md)
- [崩溃恢复语义 ADR](../adr/0001-crash-recovery-semantics.md)
- [Agent 安装与所有权 ADR](../adr/0011-managed-and-external-agent-installations.md)
- [委派 ADR](../adr/0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)
- [Automation ADR](../adr/0032-automations-replay-versioned-turn-launch-specs.md)
- [共享 Core 与远程传输 ADR](../adr/0033-shared-application-core-and-versioned-remote-transport.md)
- [统一插件控制面 ADR](../adr/0043-unified-plugin-control-plane-and-global-runtime-trust.md)
