---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# 一切皆插件：壳层贡献点、宿主 Provider 缝与无特权官方插件

本决定把「插件优先、一切皆插件」从口号落成可验收的平台契约：定义 VibeX 口径下
「一切皆插件」的边界与原则、插件的完整接管面、实现方案与外部依赖、模块修改面、
官方插件的分发与默认启用策略、安全基线、开发者体验闭环，以及分批次实施计划。

依据：架构评审（2026-09-03，用户反馈十条）、开源依赖调研
[`docs/research/2026-09-04-plugin-platform-oss-dependencies.md`](../research/2026-09-04-plugin-platform-oss-dependencies.md)、
DeepSeek Harness 架构对标，以及产品所有者补充要求（2026-09-04）：官方能力插件化后
以子仓库分发并默认启用、先底层后插件化、官方插件无特权、安全性保证、完整开发/测试/
热更新支持、禁止插件对插件的叠加开发。

## Context

插件平台的包模型、生命周期、市场与信任模型已成体系（ADR-0046/0047/0048/0066/0067），
但插件只能「往边缘加东西」，不能「参与壳层组成」。用户反馈集中暴露两类缺口：

1. **UI 结构级贡献点未开放。** 宿主闭环的 App surface slot 只有
   `plugin.detail.panel` 与 `artifact.editor`（`crates/plugins/src/app_surface.rs`
   白名单）；面板注册表是封闭 `PanelId` 映射
   （`frontend/src/components/layout/panels/PanelRegistry.tsx`，13 种内置面板）。
   看板视图区、工作区面板、设置页面、左右侧栏、底部栏均无插入点。
   `app.command` / `app.toolbar` / `app.status` / `app.composer.slash` /
   `app.timeline.card` / `app.settings.section` 六个 kind 前端已有消费代码
   （`SearchPalette` / `Toolbar` / `StatusBar` / `SessionComposerInput` /
   `AgentTimelineConversation` / `GeneralSettings`），但按 ADR-0066 标准缺官方
   范例，被排除出稳定面。
2. **宿主能力 Provider 缝是编译期硬编码。** 模型供应商按 Agent 特判
   （`model_providers.rs`），外部导入来源是封闭枚举（ADR-0063：原生配置、CC
   Switch）；用量探测按 Agent 硬编码（`crates/agents/src/plan_usage.rs`）；外部
   编辑器是封闭枚举 `EditorType`（`crates/services/src/services/config/editor`）；
   提示词优化是内置服务加硬编码 Composer 按钮
   （`crates/services/src/services/prompt_enhancement.rs`）；浏览器 CEF 随发行物
   全量分发（ADR-0007）。

对标 DeepSeek Harness（Cordis）：其「无特权壳层、能力缝三角（服务定义 + 提供者 +
消费者）、内核最小化纪律」应吸收；其「agent loop 也是插件」不适用（VibeX 是 ACP
编排壳，loop 在外部 Agent 内），其单进程热插拔组合方式不适用（VibeX 是 Rust 内核 +
独立 Node Worker 多进程），其插件树式叠加组合被产品决定排除（见第 3 节原则 8）。

## Part I — 概念、原则与接管面

### 1. 「一切皆插件」的 VibeX 定义

> VibeX 基座只承诺一件事：**多 Agent 会话 + 隔离工作区 + 可信历史**。
> 在此之上的每一个可见 UI 区域、每一项宿主能力提供者、每一个非身份核心的内置
> 功能，都必须存在对应的贡献点或 Provider 缝，且官方功能与第三方插件走同一条路。

「一切皆插件」不是把内核做成插件，而是：**壳层的每个组成位置可被插件占据，宿主的
每类能力提供者可被插件补充或替换，官方功能优先以插件形态交付，且官方插件不享有
任何第三方无法复现的特权。**

### 2. 分层模型

- **L0 基座（不插件化）**：Tauri 壳与窗口管理、Application Core / `Deployment`、
  事件溯源会话核（事件日志、Turn 生命周期、投影）、ACP 连接管理、git worktree
  隔离与 git 引擎、审批与权限、DB、插件内核自身。开放这些会破坏全生态一致性。
- **L1 宿主能力缝（Provider seam）**：插件补充或替换「提供者」。已有：文件
  opener、artifact preview provider、workflow authoring adapter。新增：模型供应商
  预设与导入来源、用量数据源、外部编辑器 opener、浏览器运行时（按需 Runtime）、
  提示词变换；远期：终端后端、搜索 provider、通知通道。
- **L2 UI 扩展面（slot）**：插件参与壳层组成。新增 `app.tab`（中央顶级 Tab）、
  `app.kanban.view`（看板视图，共享看板 Tab）、`app.panel`（工作区内 Dockview
  面板：中央组 Tab / 左侧栏视图）、`app.settings.page`（设置页面）、
  `app.rail.section`（右侧 activity rail 区块）、`app.composer.action`
  （Composer 动作）；既有六个已挂孔 slot 补齐进稳定面。
- **L3 下沉候选（内置 → 官方插件）**：四个看板视图（固定看板、四栏看板、计量
  统计看板、无限画布看板）、Notes / Logs 面板、提示词优化、Web Preview
  （浏览器）、chat channel 桥、历史导入、听写。判定准则：用户分歧大、非产品
  身份核心、已有干净接缝。反例（不下沉）：**工作区本身**以及其中的 Git / Diff /
  终端 / 文件树 / 会话面板——工作区是 L0 结构，默认面板实现留内置，但内部
  slot 开放，插件可新增或替换视图。

### 3. 原则

1. **底层先行。** 插件系统的贡献点、Provider 缝、开发工具链与安全基线先于任何
   内置能力的插件化交付。没有通过标准工具链验收的贡献点，不得开始基于它的官方
   能力迁移（实施计划的批次顺序体现此原则）。
2. **官方插件无特权。** 从内置能力迁出的官方插件只能使用公开 SDK、公开贡献点与
   标准开发流程；宿主不得按插件 ID 特判（重申 ADR-0046），不得为官方插件保留
   私有 `host.call`、私有 slot 或私有生命周期。**任何第三方用同一套开发套件必须
   能开发出功能等价的插件。** CI 增加无特权检查：官方插件包只 import 公开 SDK
   模块；宿主代码中不得出现官方插件 ID 的条件分支。
3. **孔与官方消费者同批交付。** 新贡献点与它的第一个官方插件消费者必须在同一
   批次完成 ADR-0066 稳定面四项（CLI validate、Host inspect、真实 UI/Agent 消费、
   作者文档），否则不得进入 `init` 模板与稳定面叙述。这是硬门禁，防止孔位腐烂
   （六个 slot 的现状即教训）。
4. **生效语义双轨且诚实。** Agent 侧贡献（Skill / MCP / Hook）维持 ADR-0066
   「新建会话后生效」；UI 贡献与 Provider 贡献**启用即生效、禁用即原子撤下**
   （激活代机制已支持）。产品文案区分两者，不得混述。
5. **渲染三轨，按交互密度选择。** 宿主渲染声明式 descriptor（状态项、命令、
   简单区块）→ Module Federation 面板（高频交互结构面）→ iframe App surface
   （文档型 / 富媒体 UI）。高频面板不得强制走 iframe。
6. **安全基线不可省略。** Full Trust（ADR-0048）是执行信任模型，不是放弃安全：
   供应链完整性、身份与来源锁、按插件数据隔离、操作审计、原子撤下与崩溃隔离
   构成平台安全基线（第 9 节），每个批次的验收都包含其适用项。
7. **内核最小化纪律。** 每类新行为必须指向一个文档化扩展点；改内核前先回答
   「为什么不能是插件」。本 ADR 的接管面总表（第 4 节）是该纪律的登记处，新增
   行为先改表再改码。
8. **单层扩展，禁止插件叠加。** 插件只能面向**宿主**贡献点开发；不允许插件在
   运行时扩展、拦截、增强或依赖另一个插件（不提供 `dependencies.kind=plugin`、
   跨插件服务调用或插件自声明扩展点）。复用他人插件能力的唯一路径是**派生**：
   修改插件 A 源码，以新身份（新 Publisher + Plugin ID）打包为插件 B，本地植入
   或上传市场后安装。同一贡献点上多个插件的并存与替换由宿主冲突解析处理
   （确定、可解释、用户显式选择），不由插件互相协商。
9. **借鉴设计、控制依赖。** 语义可以来自 Cordis / Theia，实现落在 VibeX 自己的
   manifest 与 Rust 控制面。外部依赖只引入调研确认且仍必要的项（第 12 节）。

### 4. 插件的完整接管面（目标态总表）

| 面 | 贡献点 / API | 状态 | 落点批次 |
| --- | --- | --- | --- |
| Agent 能力 | `content.skill` / `content.mcp` / `content.hook` / `workflow.binding` | 稳定面（已有） | — |
| 文件与产物 | `file.opener` + `artifact.preview`；`file.opener` + `app.surface(artifact.editor)` | 稳定面（已有） | — |
| 详情配置页 | `app.surface(plugin.detail.panel)` | 稳定面（已有） | — |
| 后台服务 | `host.service` | 稳定面（已有） | — |
| 命令面板 | `app.command` | 已挂孔 → 稳定面 | Batch 1 |
| 工具栏 | `app.toolbar` | 已挂孔 → 稳定面 | Batch 1 |
| 底部状态栏 | `app.status`（撤销 3 项截断，改溢出菜单；只可添加，不可改删内置项） | 已挂孔 → 稳定面 | Batch 1 |
| Composer 斜杠 | `app.composer.slash` | 已挂孔 → 稳定面 | Batch 1 |
| 会话时间线卡 | `app.timeline.card` | 已挂孔 → 稳定面 | Batch 1 |
| 通用设置区块 | `app.settings.section` | 已挂孔 → 稳定面 | Batch 1 |
| 供应商预设 API | `host.call: provider.presets.list / save / bind`；导入来源贡献 `provider.model.importSource` | 新增 | Batch 1 |
| 顶级 Tab | `app.tab`（中央 Tab 栏新增成员，与工作区 / 看板 Tab 并列） | 新增 | Batch 2（底层）/ Batch 5（进稳定面，官方浏览器 Tab） |
| 看板视图 | `app.kanban.view`（共享看板 Tab，沿用左右箭头切换与视图记忆；全部禁用则看板 Tab 移除） | 新增 | Batch 2（底层）/ Batch 3、5（官方视图插件） |
| 结构面板 | `app.panel`（工作区内 Dockview 面板：中央组 Tab / 左侧栏视图，声明 `defaultPosition`、图标、渲染轨） | 新增 | Batch 2 |
| 设置页面 | `app.settings.page`（设置侧栏导航条目 + 整页内容，federation / iframe 轨） | 新增 | Batch 2（底层）/ Batch 3（进稳定面） |
| Composer 动作 | `app.composer.action`（提示词变换等提交前动作） | 新增 | Batch 2 |
| 右侧栏区块 | `app.rail.section` | 新增 | Batch 4 |
| 用量数据源 | `provider.usage`（Provider seam） | 新增 | Batch 4 |
| 编辑器 opener | `provider.editor.opener` | 新增 | Batch 4 |
| 浏览器运行时 | CEF 按需 Runtime resource + Web Preview 官方插件面板 | 新增 | Batch 5 |
| 派生开发 | `vibex-plugin fork`（源码派生 + `derivedFrom` 溯源元数据 + 新身份打包） | 新增 | Batch 6 |
| git 面板 API 族 | `host.call: git.*`（status / branch / log / stage / commit） | 评估项，Batch 4 后立项 | 未排期 |

### 5. 明确不开放面

事件日志与 Turn 语义、审批流、worktree 隔离策略、插件内核生命周期、设备配对与
凭据。允许插件替换这些会使会话历史与安全语义不可信。git **引擎**留 L0（Remote
coding loop 关键路径），git **面板 slot** 随 `app.panel` 开放。

**插件对插件的运行时扩展整体不开放**（原则 8）：不提供插件依赖声明、跨插件服务
调用、插件自声明扩展点或任何形式的运行时插件组合。`dependencies.kind=plugin`
维持现有拒绝（`package.rs`），ADR-0066 对它的稳定面排除**不再视为待撤销项**，
而是长期决定。

## Part II — 完整方案

### 6. UI 贡献点设计

**中央 Tab 栏组成。** 应用顶层的中央 Tab 栏由三类成员合成：

1. **工作区 Tab** —— 唯一固定成员。工作区是 L0 结构，不是插件、不可移除，
   其内部能力经 `app.panel` 等 slot 插件化。
2. **看板 Tab** —— 宿主拥有的**视图容器**，仅当存在至少一个已启用的
   `app.kanban.view` 贡献时出现在 Tab 栏；用户禁用/卸载全部看板视图即整体
   去掉看板 Tab，重新启用任一视图即恢复（市场与设置中的安装入口不依赖看板
   Tab 存在）。
3. **插件顶级 Tab**（`app.tab`）—— 任意插件可新增与工作区 / 看板并列的顶级
   Tab，顶层结构不固定为两员。

插件参与顶层的三条路：向看板 Tab 贡献视图（加入箭头轮换与总览语境）、经
`app.tab` 自建独立顶级 Tab、向工作区内部贡献 `app.panel` 面板。

**`app.tab`（顶级 Tab）。** manifest 声明：`id`、`title`（i18n key 或字面量）、
`icon`（受控集合）、`renderer`（`federation` / `iframe`）、排序权重。Tab ID
命名空间化（`plugin:<pluginId>/<tabId>`），宿主持久化激活 Tab；贡献方插件被
禁用时其 Tab 原子消失，若正处于激活态则回退到工作区 Tab。顶级 Tab 之间、
以及与看板视图之间**互不干涉**：独立渲染、独立数据、按 Tab 错误边界隔离。
与 `app.kanban.view` 的选择标准：内容属于会话总览语境、适合与其他看板视图
轮换的，做看板视图；需要独立顶层入口的，做 `app.tab`。

**`app.kanban.view`（看板视图）。** 看板 Tab 聚合全部已启用插件的看板视图
贡献，沿用现有左右箭头交互在视图间切换，宿主持久化用户最后停留的视图。
manifest 声明：`id`、`title`、`icon`（受控集合）、`renderer`（`federation`
默认）、排序权重。四个内置看板视图——**固定看板、四栏看板、计量统计看板、
无限画布看板**——全部迁为官方能力等价插件（默认启用，第 8 节），迁移后宿主
不再内置任何看板视图实现。官方四视图与第三方视图在容器内完全对等且
**互不干涉**：每个视图独立渲染、独立数据、按视图错误边界隔离，一个视图崩溃
或被禁用不影响其余视图与箭头轮换；用户可任意增删组合（只留一个、四个官方 +
N 个第三方、或全部去掉——见上，全禁用即移除看板 Tab）。第三方扩展计量类
内容的路径有三条：贡献 `provider.usage` 数据（进入计量看板聚合）、贡献自己的
`app.kanban.view`、或 fork 官方计量看板（第 11 节）——不提供向他人视图内部
插区块的机制（原则 8）。

**`app.panel`（工作区内面板）。** manifest 声明：`id`、`title`（i18n key 或
字面量）、`icon`（受控图标名集合，不接受任意 SVG 注入宿主 DOM）、
`defaultPosition`（`center` / `left`，指工作区 Dockview 的中央组与左侧组）、
`renderer`（`federation` / `iframe`）。宿主侧 `PanelRegistry` 从封闭 `PanelId`
映射改为「内置表 + 插件贡献表」的合成注册表；插件面板 ID 命名空间化
（`plugin:<pluginId>/<panelId>`），布局持久化直接序列化该 ID，插件禁用后反
序列化落到「面板不可用」占位（保留布局槽位，启用后恢复）。左侧栏视图不是新
概念——它就是 `defaultPosition: left` 的面板。

**`app.settings.page`（设置页面）。** 设置侧栏可由插件贡献完整页面：manifest
声明 `id`、`title`、`icon`（受控集合）、`renderer`（`federation` / `iframe`）。
插件页面条目在设置侧栏核心条目之后按名称排序列出，禁用即消失。与既有两个
设置面的分工：`app.settings.section` 是**通用设置页内的内嵌区块**（轻量开关
组），`app.settings.page` 是**独立导航条目 + 整页**（功能型设置面，如浏览器
插件的配置页），`plugin.detail.panel` 是**插件详情页的配置 Tab**（该插件自身
的 `config.json` 编辑面，ADR-0047 语义不变）。作者应优先用 detail panel 承载
插件自身配置，只有面向功能领域的设置才用 settings.page，避免设置侧栏膨胀。

**渲染三轨。**

1. 宿主渲染 descriptor：`app.status` / `app.command` / `app.toolbar` 与简单区块
   维持现状（宿主组件渲染 label/icon，回调 `invokeContribution`）。
2. Federation 面板：`app.tab` / `app.panel` / `app.kanban.view` /
   `app.settings.page` 默认轨。宿主用 Module Federation 2.0 纯 runtime
   （`createInstance` / `registerRemotes` / `loadRemote`）从本地插件产物 HTTP
   端点加载远程模块，React 以 singleton 共享；插件构建走
   `@module-federation/vite` 模板（进 `vibex-plugin init`）。每个插件面板包在
   `DockviewPanelErrorBoundary` 内，崩溃不出面板。
3. iframe App surface：现有 `AppSurfaceHost` 轨，保留给文档型 UI 与
   `artifact.editor`。

**生效语义。** UI 贡献随激活代原子出现/撤下；正在显示的插件面板在禁用时替换为
占位并保留 dockview 布局。

### 7. Provider 缝设计

统一形态（能力缝三角）：**服务定义**（Rust trait + wire DTO，归属对应 service
crate）、**提供者**（内置默认 provider + 插件贡献 provider，经 Contribution
Registry 注册）、**消费者**（现有 UI / 命令面）。冲突解析确定且可解释：用户显式
选择 > 内置默认；同类多 provider 并存时消费者聚合（用量）或单选（编辑器）。

- **`provider.model.importSource`**：把 ADR-0063 的导入来源从封闭枚举改为贡献。
  插件返回结构化 `ModelProviderPreset` 草稿（名称、端点、模型映射、凭据引用），
  Host 复用既有校验、投影与「导入不绑定」语义。配套 `host.call`
  `provider.presets.list / save / bind`（bind 需用户在宿主 UI 确认，插件不能
  静默改绑）。
- **`provider.usage`**：定义 `UsageSnapshot` DTO（额度、用量、重置时间、来源
  标识）。`plan_usage.rs` 的内置探测改为首个内置 provider；官方计量统计看板
  视图聚合全部 provider。遵守 ADR-0058 诚实性：缺失保持缺失，不得填零。
- **`provider.editor.opener`**：名称、图标、命令模板、探测（PATH / 固定路径）。
  `EditorType` 枚举收敛为内置默认 provider 集合；`Custom` 变体语义由贡献取代。
- **`app.composer.action`（提示词变换）**：Composer 提交前动作贡献，输入草稿 +
  会话上下文引用，输出替换草稿；内置提示词优化迁为官方插件（复用
  `host.service` + broker `agent.invoke`）。
- **浏览器运行时**：CEF 从随发行物分发改为内容寻址 Runtime resource（复用
  Runtime lock / probe / 引用计数），首次打开 Web Preview 时按需下载并验证
  digest；`BrowserRuntime` trait 不变。Web Preview 面板迁为官方插件的
  `app.panel` 贡献。修订 ADR-0007 的分发结论，不修订其 CEF 技术选型。

### 8. 官方能力插件的分发与默认启用（两阶段）

从内置能力迁出的官方插件（四个看板视图、Notes、提示词优化、Web Preview 等，
下称**能力等价插件**）按以下策略分发。本节修订 ADR-0066 第 2 节对这一类插件的
「不预装、默认禁用」决定；官方工具类插件（Office、Workflow Creator、插件开发等
非「从内置迁出」的包）维持 ADR-0066 原策略。

**源码组织：项目子仓库。** 每个官方插件是独立 git 仓库，以 submodule 挂在
`assets/plugins/<name>`（沿用 `assets/plugins/plugin-development` 既有惯例）。
插件仓库自包含：标准 manifest、SDK 依赖、CI（`vibex-plugin build / validate /
test` + `test --host`）。主仓库 CI 只消费其构建产物，不深入其源码——这保证
插件与项目源码可分离。

**阶段一（当前，写死快照）：** 发行物携带能力等价插件的官方快照；Host 首次启动
或从旧版本迁移时，**自动安装并默认启用**这些插件，来源锁记为官方快照
（`sourceKind=official-snapshot`，含 digest 与版本）。用户可禁用、可卸载；卸载后
可从市场官方分类重装。迁移必须保持功能等价：更新后用户不得发现 Notes、提示词
优化或 Web Preview「消失」。市场官方分类同时展示这些插件（写死的本地快照条目 +
官网条目并存时以官网为准）。

**阶段二（插件仓库与项目分离后）：** 官方插件仓库脱离 submodule，作者（产品
所有者）通过官网市场以 **GitHub 地址上传**（ADR-0066 安装物身份四元组，
`sourceKind=github` 或官网托管）。Host 端把能力等价插件的获取方式切换为：从
官网市场官方分类拉取并**自动安装 + 启用**（仅限官方 Publisher 白名单内的能力
等价插件；白名单由 Host 版本携带，不可被市场响应扩充）。离线时回退发行物快照。
切换后主仓库删除对应 submodule 与快照打包逻辑，只保留白名单与拉取策略。

**默认启用的边界。** 自动启用仅适用于能力等价插件白名单；其余官方与第三方包
维持「安装后默认禁用」（ADR-0066）。自动安装仍写入完整审计（第 9 节），digest
校验失败则不安装并显式报错，不静默降级。

### 9. 安全基线

Full Trust（ADR-0048）定义执行信任：**安装即授予本机权限**。本节定义在该模型下
平台必须保证的安全性质；它们不是沙箱，也不得被宣传为沙箱。

1. **供应链完整性。** 安装物必须有 sha256 digest 并在下载、安装、激活各环节
   复验；GitHub 来源钉死 tag/commit；来源锁决定更新通道（ADR-0066）；更新时
   digest、publisher 或可执行入口变化必须重新确认 Full Trust。官网市场维持
   「待审不上架」（ADR-0005）。能力等价插件的自动安装同样过 digest 门。
2. **身份与数据隔离。** 产品身份 = Publisher + Plugin ID（ADR-0046）：同 ID 不同
   Publisher 不能继承权限或数据；派生插件（第 11 节）是新身份，不继承原插件的
   设置、KV、SQLite 与 secrets。插件间数据存储互相隔离；普通插件不能读取其他
   插件的数据、secrets、主 token 或设备凭据。
3. **知情确认。** 市场、`.vxp`、CLI、GitHub 安装一律经过预览弹窗与
   「以本机用户权限运行，不是沙箱」确认（ADR-0066）；能力等价插件的自动安装在
   迁移说明与插件详情页如实标注来源与授权语义。
4. **可撤销与原子性。** 禁用/卸载即原子撤下全部贡献（激活代机制）；候选代失败
   保留上一完整激活代，不留半激活状态。
5. **审计与无秘密日志。** 安装、启用、更新、自动安装、`provider.presets.bind`
   等敏感操作写入 Plugin operation audit（身份、版本/digest、结果、影响面）；
   日志与审计不得记录 secrets。
6. **无特权即安全性质。** 官方插件与第三方同面（原则 2）意味着安全审查面唯一：
   不存在「官方后门 API」需要另行审计。
7. **远期升级路径。** 若产品开放不受信生态，按 ADR-0048 约定以新 ADR 引入独立
   sandbox package class（wasmtime 组件模型为技术储备），不在现有 Full Trust
   API 上零散加权限弹窗。

### 10. 开发者体验完整闭环

目标：开发、调试、测试、热更新、打包、发布全环节一等支持，而不是「一套能用的
流程」。所有能力对官方与第三方作者同权（原则 2）。

- **脚手架**：`vibex-plugin init` 为每类贡献提供可运行模板（panel /
  composer-action / provider / status-toolbar / file-tab / worker 等），init 产物
  必须直接通过 `build / validate / test` 并能在真实 Host 激活（ADR-0066 第 3 节
  标准延续到新模板）。
- **开发与热更新**：`vibex plugin add --dev .` 链接开发目录并监视 digest；Worker
  与声明式贡献变更走候选代原子 reload（已有）。新增：**federation 面板开发模式**
  ——`vibex-plugin dev` 起 Vite dev server，宿主 `loadRemote` 指向 dev 端点，
  面板代码享受 HMR（改代码不重载宿主、不重建激活代）；退出 dev 模式回落到
  构建产物。iframe surface 支持 devtools 打开与 `srcDoc` 热替换。
- **调试与诊断**：宿主提供插件运行诊断面（每插件 Worker 存活、最近崩溃、stdout/
  stderr 日志流、贡献 readiness 与失败证据——诊断模型已有，补 UI 消费）；面板
  崩溃落错误边界并可一键重试；`vibex-plugin doctor` 汇总工具链、SDK 版本与
  Host 兼容性。
- **测试**：单元层用 Testing 包的 fake broker 与 App harness（ADR-0046）；
  集成层 `vibex-plugin test`；宿主旅程层 `vibex plugin test --host` 覆盖该包声明
  的每个用户可见能力（ADR-0066 第 8 节完成门扩展到新贡献 kind）。官方插件
  仓库 CI 必须全跑三层。
- **打包与发布**：确定性 `pack`（digest 稳定）；市场上传走官网（GitHub 地址或
  `.vxp`）；文档与插件开发 Skill 同步每个新贡献 kind 的完整旅程。

**验收原则：** 每个新贡献 kind 交付时，其「init → dev（含热更）→ test →
add --dev → test --host → pack」全链路必须可走通并写入 Skill；缺任一环节该
kind 不进稳定面。

### 11. 派生开发与同槽并存

响应「在别人插件基础上开发」的需求，但不开放运行时叠加（原则 8）：

- **派生（fork）**：`vibex-plugin fork <source>` 从已安装包快照或 GitHub 仓库
  复制源码，强制换新 Publisher + Plugin ID，写入 `derivedFrom` 溯源元数据
  （原身份 + 版本 + digest）。派生包是完全独立的插件：独立安装、独立数据、
  独立更新通道，不继承原插件权限与数据（第 9 节）。市场详情页展示溯源信息。
  许可证责任由派生作者承担，CLI 在 fork 时提示原包 license。
- **同槽并存与替换**：多个插件贡献同一 slot / Provider 缝时，宿主按确定规则
  呈现：可聚合的聚合（状态项、usage provider、面板并列），需单选的由用户显式
  选择（编辑器默认 opener、同 file pattern 的 opener 优先级——既有机制），
  绝不按安装顺序静默覆盖（重申 ADR-0046）。用户用「禁用 A、启用 B」完成
  替换，而不是让 B 去改 A。

### 12. 外部依赖决定

采用（仅一项）：

1. **Module Federation 2.0 runtime + `@module-federation/vite`**（Batch 2）：
   插件面板远程模块加载、React singleton 共享与 dev HMR。宿主只引 runtime，
   构建零侵入。

不再引入 **pubgrub**：其用途是插件间依赖版本求解；原则 8 取消插件依赖模型后
无使用场景。`semver` crate 维持既有用途（`engines` 与市场 versions 比较），
不新增职责。

借鉴设计不引依赖：Cordis（可逆注册 / 就绪语义 → 激活代与贡献生命周期的对照
参考）、Theia（接口即扩展点 + ContributionProvider 集中收集 → 合成注册表设计）、
Piral pilet feed 规范（→ 市场 Catalog `versions` / integrity 字段对照）。

排除：single-spa（停维）、qiankun（隔离与共享诉求相反）、Piral 整体（重写壳）、
Lumino（与 dockview 同位竞争）、extism / wasmtime（与 Full Trust 冲突；wasmtime
记为远期不受信 package class 储备）、Open VSX（重运维栈，替换自建 Catalog 净负
收益）。降级路线：原生 ESM `import()` + import map（若 MF runtime 集成受阻）。

### 13. 模块修改面

| 模块 | 修改 |
| --- | --- |
| `crates/plugins`（manifest / package.rs / contribution.rs / app_surface.rs / host_capability_broker.rs） | 新贡献 kind 与校验；slot 白名单扩展；`ContributionKind` 增补；broker 新 `host.call` 族；能力等价插件白名单、自动安装与官方快照来源锁；`derivedFrom` 元数据 |
| `crates/services`（config/editor、prompt_enhancement、usage 相关） | Provider trait 定义；内置实现降为默认 provider；`EditorType` 收敛；提示词优化服务随迁出删除 |
| `crates/agents/src/plan_usage.rs` | 探测逻辑迁入内置 usage provider |
| `crates/browser-runtime` / `crates/browser-cef` / 打包脚本 | CEF 按需 Runtime resource；发行物剔除 CEF 全量捆绑 |
| `src-tauri/src/commands`（agent_management/model_providers.rs、plugins、web_service） | 供应商预设 IPC 面向 broker 开放；面板贡献 DTO；启动时能力等价插件迁移安装；`generate-types` 同步 |
| `frontend/src/components/layout/panels/PanelRegistry.tsx`、`IDELayout.tsx`、`StatusBar.tsx`、`Toolbar.tsx`、`RightPanelSidebar.tsx` 及中央 Tab 栏组件 | 合成注册表；面板占位；状态栏溢出菜单；中央 Tab 栏合成（工作区固定 + 看板容器条件存在 + `app.tab` 插件 Tab）；看板 Tab 改为 kanban view 容器（聚合、箭头切换、视图记忆、无视图时移除）；force-hide 终端特判改由面板/视图声明 |
| `frontend/src/components/kanban/`（`KanbanSessionHub`、`SessionCanvasView`、`*Usage*` 等）、Notes / Web Preview 相关组件 | 四个看板视图与 Notes / Web Preview 迁出为官方插件后删除原实现（maiden「不留残留」） |
| `frontend/src/pages/settings/`（`SettingsLayout` 等） | 设置侧栏消费 `app.settings.page` 贡献条目 |
| `packages/plugin-sdk` / `packages/plugin-cli` | 新贡献类型；federation 构建模板与 `dev` HMR 模式；`fork` 命令；`test --host` 旅程扩展；诊断面数据源 |
| `assets/plugins/` | 新增能力等价插件 submodule（notes、prompt-enhancer、kanban-board、kanban-columns、kanban-canvas、kanban-usage、web-preview 等），各自独立仓库与 CI |
| 官网 `vibex-site` Catalog | 官方分类展示能力等价插件；GitHub 地址上传流程（既有）承接阶段二 |
| `shared/types.ts` | 随 Rust DTO 由 `generate-types` 再生 |

## Part III — 实施计划（分批次，不设时限）

批次顺序体现原则 1（底层先行）：Batch 1–2 与 Batch 4 是底层支持，Batch 3 与
Batch 5 是官方能力插件化，Batch 6 是派生与分发闭环。每批完成定义 = 任务全绿 +
验收全过 + 相关 ADR / 文档 / CONTEXT 词表同步。

### Batch 0 — 词表与门禁

**任务：** 本 ADR 术语（贡献点、Provider 缝、渲染三轨、生效双轨、能力等价插件、
派生插件、单层扩展、接管面总表）写入根 `CONTEXT.md`；受修订 ADR（0007 / 0063 /
0066）顶部加修订注记；「孔与官方消费者同批交付」「官方插件无特权」「单层扩展」
写入插件开发 Skill 与 `docs/plugins/developer-guide.md`；CI 加入无特权检查
（官方插件包只 import 公开 SDK；宿主无官方插件 ID 条件分支）。

**前端设计要求：** 无 UI 改动。

**验收：** CONTEXT 与本 ADR 用词一致；无特权检查在 CI 生效并对现有官方包通过；
`rg` 检查无旧表述残留。

### Batch 1 — 已挂孔 slot 稳定化 + 供应商 API + DX 基线

**任务：**

1. 六个 slot 各配一个官方参考插件消费面（可合并为一两个官方包，如「会话工具集」），
   走完 CLI validate → Host inspect → UI 消费 → 文档四项，进稳定面与 `init` 模板。
2. `StatusBar` 撤销 `slice(0, 3)`，改溢出菜单；明确「只可添加」产品语义。
3. broker 增加 `provider.presets.list / save / bind`；`bind` 走宿主确认 UI 并入
   审计。
4. `provider.model.importSource` 贡献 kind + 「外部供应商导入」对话框消费贡献列表。
5. 官方示范：一个真实供应商导入插件上架市场官方分类。
6. **DX 基线**：插件运行诊断面 UI（Worker 存活 / 日志流 / readiness 失败证据）；
   `vibex-plugin doctor` 覆盖新 kind；六个 slot 的 init 模板与 Skill 旅程文档。

**前端设计要求：** 全部插件贡献 UI 使用 `DESIGN.md` token（`--surface-*` /
`--text-*`），禁止局部调色板；状态栏项与内置项视觉同权（同高、同字号、同
hover 语义）；供应商确认对话框复用 `dialog-surface`；诊断面进设置 → 插件详情，
不新开顶级入口；文案遵守 maiden 原则 6；en 与 zh-CN locale 同步。

**验收：** `vibex plugin test --host` 覆盖六个 slot 各一条旅程；参考插件从市场
安装→启用→贡献即时出现→禁用→原子消失；供应商插件可把预设写入列表、用户确认后
绑定生效并投影到 Agent 原生配置；未确认的 bind 调用被拒绝且有审计记录；诊断面
能呈现一次人为制造的 Worker 崩溃及其恢复。

### Batch 2 — 看板视图、结构面板、设置页面与 Composer 动作底层（含热更新开发环）

**任务：**

1. `app.panel` manifest / 校验 / DTO / 合成 `PanelRegistry`；面板 ID 命名空间化
   与布局持久化兼容（含旧布局反序列化测试）；占位态（禁用 / 加载失败 / 卸载）。
2. 中央 Tab 栏合成：`app.tab` 贡献点（插件顶级 Tab、激活持久化、禁用回退
   工作区 Tab）+ `app.kanban.view` 贡献点（看板 Tab 改造为宿主视图容器：聚合
   已启用视图、沿用左右箭头切换、最后视图记忆、无已启用视图时看板 Tab 从
   Tab 栏移除）；内置四视图先以内置贡献形态接入容器（实现暂不迁出，迁出在
   Batch 3 / 5）。
3. Module Federation runtime 集成：本地插件产物 HTTP 端点、`loadRemote`、React
   singleton；`@module-federation/vite` 模板进 `vibex-plugin init`（`panel` /
   `kanban-view` 模板）。
4. **`vibex-plugin dev` 面板 HMR 模式**：宿主 `loadRemote` 指向 Vite dev 端点，
   改代码不重载宿主；退出回落构建产物。
5. `app.settings.page` 贡献点：设置侧栏合成插件页面条目，页面走 federation /
   iframe 轨（稳定面认定推迟到 Batch 3 与官方消费者同批，原则 3）。
6. `app.composer.action` 贡献点 + Composer 动作菜单。
7. `IDELayout` 看板 force-hide 终端特判改为面板/视图声明属性
   （如 `hidesBottomDock`），使内置与插件贡献同权。
8. 完成门：**标准样例插件**（非内置迁移）用公开 SDK 各贡献一个示例顶级 Tab、
   示例面板与示例看板视图，走完 init → dev（HMR）→ test → add --dev →
   test --host → pack 全链路。

**前端设计要求：** 插件面板 Tab 与内置 Tab 视觉不可区分（同
`WorkspaceDockviewTab` 渲染，图标来自受控集合）；占位态用统一空态组件（图标 +
一句话 + 恢复动作），不出现技术性错误码正文；federation 面板首帧骨架屏，加载
失败落 `DockviewPanelErrorBoundary` 重试面；Composer 动作菜单遵循 `@` 面板既有
交互模式（ADR-0065）；深浅色即时生效（token 驱动，不重载面板）。

**验收：** 样例插件全链路走通且 HMR 生效（改一行代码 2 秒内面板更新、宿主
不重载）；样例顶级 Tab 与工作区 / 看板 Tab 并列出现，禁用后原子消失且激活态
回退工作区；样例看板视图加入箭头轮换且与内置四视图互不干涉（人为使样例视图
崩溃，其余视图不受影响）；看板 Tab 四个内置视图经容器聚合后交互与迁移前一致
（箭头切换、视图记忆）；旧布局文件迁移后正常打开；禁用插件后布局槽位占位、
启用恢复；本批**不迁移任何内置功能**——底层验收通过是 Batch 3 的开工条件。

### Batch 3 — 官方能力插件化第一波（Notes、提示词优化、三个看板视图）

**任务：**

1. 新建五个独立插件仓库并以 submodule 挂入 `assets/plugins/`：**Notes 面板**
   （`app.panel`）、**提示词优化**（`host.service` + `app.settings.page` +
   `app.composer.action`，经 broker `agent.invoke`；`app.settings.page` 随此
   官方消费者进稳定面）、**固定看板**、**四栏看板**、**无限画布看板**（各为
   `app.kanban.view`，实现自 `KanbanSessionHub` / `SessionCanvasView` 迁出）。
   全部只用公开 SDK 与标准流程（原则 2），各自仓库 CI 跑三层测试。计量统计
   看板依赖 `provider.usage` 缝，留待 Batch 5。
2. 能力等价插件白名单 + 官方快照打包 + 启动迁移：首次启动/升级自动安装并默认
   启用（第 8 节阶段一），来源锁 `official-snapshot`；市场官方分类可见。
3. 删除内置 Notes 面板、内置提示词优化实现（含 `prompt_enhancement` 服务、
   硬编码 Composer 按钮、`PanelId.NOTES`）与三个看板视图的内置实现（计量视图
   暂留内置贡献形态），用户数据（笔记内容、设置、看板布局偏好）无损迁移到
   插件存储。

**前端设计要求：** 迁移后各功能的交互与视觉与迁移前一致（用户无感知），看板
首屏尤其不得出现可感知的加载退化；插件详情页标注「随 VibeX 提供，默认启用，
可禁用可卸载」；卸载后的入口占位给出市场重装动作。

**验收：** 升级后用户的笔记、提示词优化与三个看板视图连续可用（对照测试 +
数据迁移测试），看板首屏时间不高于迁移前（对照测量）；无特权 CI 检查对五个
插件通过；第三方按 Skill 文档可复刻同类插件（用样例仓库验证一次完整复刻
旅程）；仓库不再含被迁移功能的内置实现；禁用/卸载/重装全旅程可走通；三个
看板视图插件互不干涉（单独禁用任一视图，其余视图与箭头轮换不受影响）。看板
Tab 整体移除的旅程待计量视图迁出后在 Batch 5 验收。

### Batch 4 — Provider 缝底层（用量、编辑器、rail）

**任务：**

1. `provider.usage` trait + DTO + 内置探测迁为默认 provider。
2. `provider.editor.opener` + `EditorType` 收敛；官方示范：一个第三方编辑器
   opener 插件（走标准流程，可上架官方分类）。
3. `app.rail.section`：右侧 activity rail 重构为区块列表，内置区块（活动、
   进程）与插件区块同权。
4. 立项评估（不实现）：git `host.call` API 族范围与 Remote protocol 影响。

**前端设计要求：** usage 区块聚合多 provider 时按来源分组并标注来源名，缺失
显示为缺失（ADR-0058）；rail 区块折叠态与现有 rail 一致；编辑器选择对话框
内置与插件 provider 同列、来源以次要文本标注。

**验收：** 第三方 usage provider 的数据出现在聚合视图且缺失字段不填零；编辑器
opener 插件出现在全部「用编辑器打开」入口；`EditorType::Custom` 用户配置无损
迁移；rail 插件区块启停原子出现/消失。

### Batch 5 — 官方能力插件化第二波（计量统计看板、浏览器）

**任务：**

1. **官方计量统计看板插件**（`app.kanban.view` + `provider.usage` 消费）：迁出
   看板计量视图，原 `KanbanUsageDashboard` / `PlanUsageDashboard` 硬编码实现
   删除；进能力等价白名单（默认启用）。至此宿主不再内置任何看板视图实现，
   禁用/卸载全部四个看板插件即可整体去掉看板 Tab。
2. CEF 改为内容寻址 Runtime resource：下载、digest 验证、lock、probe、引用
   计数复用现有 Runtime 机制；发行物剔除 CEF 捆绑。
3. **官方浏览器插件**（Web Preview）：`app.panel`（工作区内预览）+ `app.tab`
   （独立浏览器顶级 Tab——`app.tab` 的首个官方消费者，随之进稳定面）+
   browser runtime 依赖声明；`BrowserRuntime` trait 与 `crates/browser-cef`
   保留为宿主 provider 实现；进能力等价白名单。旧布局中的 `web-preview` 面板
   落占位并提示启用/安装。
4. 评估（立项不实现）：chat channel 桥（Telegram / 企微 / iLink）下沉方案。

**前端设计要求：** 计量看板插件沿用现有计量视觉语言（`planUsageFormat` 格式、
诚实缺失）；CEF 首次下载有进度与失败重试 UI（复用 Runtime 安装样式），下载
确认对话框披露体积与来源；浏览器面板 chrome 维持 ADR-0007 预留布局原则。

**验收：** 新装发行物体积显著下降（记录前后数值）；升级用户看板计量视图与
Web Preview 功能连续（默认启用迁移，箭头切换可达计量视图）；禁用浏览器插件后应用无浏览器功能残留入口；
安装→首次打开触发 CEF 下载→digest 校验→页面可浏览全旅程通过；离线下载失败
给出可诊断错误；卸载后 CEF Runtime 引用归零可回收；两个插件过无特权 CI 检查；
浏览器顶级 Tab 与工作区 / 看板 Tab 并列可用（`app.tab` 稳定面四项完成）；
禁用/卸载全部四个看板插件后看板 Tab 从中央 Tab 栏消失且激活态回落工作区，
重新启用任一视图即恢复。

### Batch 6 — 派生开发与官方分发闭环

**任务：**

1. `vibex-plugin fork <source>`：从已安装包快照或 GitHub 仓库派生，强制新
   Publisher + Plugin ID，写 `derivedFrom` 溯源，提示原 license；市场详情页
   展示溯源。
2. 同槽冲突解析完善：并存聚合与单选规则覆盖全部新 slot / Provider 缝，宿主
   提供「同槽插件」对比视图（看到谁在提供、切换默认）。
3. **阶段二切换**：官方插件仓库脱离 submodule；产品所有者经官网以 GitHub 地址
   上传能力等价插件；Host 切换为市场拉取 + 白名单自动安装启用（离线回退快照）；
   主仓库删除 submodule 与快照打包逻辑。
4. 文档与 Skill 终稿：派生流程、同槽语义、官方插件复刻指南。

**前端设计要求：** 安装预览弹窗对派生包展示 `derivedFrom` 溯源；「同槽插件」
对比视图进插件详情或设置对应能力页，不新开顶级导航；自动安装的官方插件在
已安装列表标注来源（官方市场 / 快照）。

**验收：** fork 一个市场插件→改造→pack→本地植入与上传市场两条路都可安装使用，
且与原插件并存、数据隔离；新数据目录联网首启从市场自动装齐白名单插件并默认
启用，离线首启用快照，两者功能一致；主仓库无官方插件源码残留；同槽两个 usage
provider / 两个编辑器 opener 的并存与切换旅程通过。

## Order and dependencies

```text
Batch 0 → Batch 1 → Batch 2 ─→ Batch 3（第一波插件化，依赖 2 的面板 / 看板视图底层）
                        │
                        └────→ Batch 4（Provider 缝底层，可与 Batch 3 并行）
                                  └──→ Batch 5（第二波插件化，依赖 4 的 usage 缝）
                                          └──→ Batch 6（派生与分发闭环）
```

原则 1 硬约束：Batch 3 不得先于 Batch 2 验收完成开工；Batch 5 不得先于
Batch 4 的 `provider.usage` 验收完成开工。git `host.call` API 族在 Batch 4
评估后另行立项；chat channel 下沉在 Batch 5 评估后另行立项。

## Risks

- **布局持久化兼容。** 面板 ID 开放化必须带旧布局迁移测试；占位机制保证插件
  缺席不毁布局。
- **Federation 与 React 版本演进。** React singleton 共享把宿主 React 大版本
  升级变成插件生态事件；SDK `engines` 声明面板 API 版本，宿主升级前发布兼容
  窗口公告。降级路线（原生 ESM + import map）保留。
- **性能。** 插件面板懒加载 + 骨架屏；descriptor 轨无插件代码参与渲染热路径。
  每批验收含「无插件时零回退」检查；能力等价插件默认启用后，其面板懒加载成本
  不得高于原内置实现（对照测量）。
- **默认启用与 ADR-0066 语义张力。** 能力等价白名单是唯一例外且由 Host 版本
  固化；不得经市场响应或配置扩充，防止「自动安装」被滥用为推广渠道。
- **迁移连续性。** 每个能力等价插件的数据迁移（笔记、设置）必须可测试、可
  回滚；迁移失败保留内置数据不删除。
- **顶级 Tab 与看板视图泛滥。** 开放 `app.tab` 与 `app.kanban.view` 后顶层
  导航可能拥挤，稀释「总览 / 深入」心智模型；靠用户自主启停、市场审核与作者
  指南（明确两者选择标准，第 6 节）缓解，宿主不设数量硬限制，Tab 栏溢出走
  滚动。
- **派生生态碎片化。** fork 门槛低可能产生大量近似包；靠 `derivedFrom` 溯源、
  市场审核与搜索排序缓解，不靠技术禁止。
- **Full Trust 下结构级插件的可见破坏半径。** 不新增安全承诺；靠第 9 节基线
  （供应链、隔离、审计、原子撤下、崩溃隔离）维持产品可用性底线。

## Relationship to prior ADRs

- **修订 ADR-0066**：第 7 节稳定面——六个 slot 经 Batch 1 进入稳定面；第 2 节
  ——能力等价插件白名单允许预装并默认启用（两阶段，见第 8 节），其余包维持
  「不预装、默认禁用」；`dependencies.kind=plugin` 的排除**维持为长期决定**
  （原则 8）。
- **修订 ADR-0063**：外部供应商导入来源由封闭枚举改为 `provider.model.importSource`
  贡献；「导入不绑定、原生配置为权威」语义不变。
- **修订 ADR-0007**：CEF 由随发行物分发改为按需 Runtime resource；CEF 技术
  选型与 `BrowserRuntime` interface 不变。
- **不修订** ADR-0046 的包身份 / 候选代 / digest / 禁止 ID 特判、ADR-0048
  Full Trust、ADR-0051 托管 MCP seam、ADR-0058 诚实性（usage provider 继承其
  约束）、ADR-0068 工作区默认面。
- **姊妹篇 [ADR-0070](0070-ssh-provisioned-remote-server.md)**：「工作区搬到
  远端」是 L0 核心路线（SSH 供给的远程 VibeX Server），不是插件路线；其中的
  SSH 供给器规划为阶段二官方能力等价插件，作为本 ADR「新领域功能插件」的
  试金石案例。

## Considered options

- **整体迁移 Eclipse Theia / code-oss。** 否决。编译期组装单体与运行期安装、
  激活代、独立 Worker 模型架构互斥，等于重写产品。
- **引入 Cordis 作为 Worker 层插件框架。** 否决。单进程内存对象图与每插件独立
  进程根本冲突；v4 仍 RC 且单一作者主导；DSH 亦 vendor 源码。借鉴语义即可。
- **插件依赖插件 + 跨插件服务调用（本 ADR 草案期方案）。** 否决（产品决定，
  原则 8）。运行时叠加使行为归因、故障隔离与卸载语义复杂化，生态易混乱；
  派生（fork + 新身份）覆盖「基于他人插件开发」的需求且保持单层归因。随之
  撤销 pubgrub 依赖。
- **官方能力插件保持内置或成为特权插件。** 否决。特权插件使「一切皆插件」
  沦为口号，且产生第二套不可复现的扩展面；无特权是平台可信度与安全审查面
  唯一性的前提。
- **能力等价插件也默认禁用（严格沿用 ADR-0066）。** 否决。从内置迁出的功能
  若默认禁用，升级用户会遭遇功能凭空消失；默认启用 + 可卸载在功能连续性与
  用户主权之间取得平衡，且范围被白名单严格限定。
- **所有插件 UI 走 iframe。** 否决。高频结构面板的启动与交互开销不可接受；
  三轨渲染按交互密度分配。
- **先开放全部孔位再补官方消费者。** 否决。六个 slot 的腐烂现状即反例；孔与
  官方消费者同批交付是本 ADR 的硬门禁。
- **把 Git / 终端 / 会话面板也下沉为插件。** 否决。产品身份核心且在 Remote
  coding loop 关键路径；开放其 slot 已满足可替换诉求，拆除只减可靠性。
- **工作区本身插件化。** 否决。工作区（Dockview 骨架与会话语义）是产品身份
  核心（L0），是中央 Tab 栏唯一固定成员；只有其**内部能力**经 `app.panel` 等
  slot 插件化。中央 Tab 栏的其余部分全部开放：看板 Tab 的内容全部插件化
  （`app.kanban.view`，含四个官方视图）且全禁用即整体移除，新顶级 Tab 可经
  `app.tab` 自由贡献。（草案期曾把顶级 Tab 整体固化为两员，产品决定改为
  只固化工作区。）
- **在计量看板内开放 `app.usage.section` 区块槽（本 ADR 草案期方案）。** 否决。
  计量看板插件化后，该槽等于向另一个插件的页面内部插区块，违反原则 8（单层
  扩展）。计量扩展路径收敛为：`provider.usage` 供数、自建 `app.kanban.view`、
  或 fork 官方计量看板。
