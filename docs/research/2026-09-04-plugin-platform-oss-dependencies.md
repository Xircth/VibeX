# 插件平台开源依赖调研（一切皆插件方案）

> 调研日期：2026-09-04
> 目的：为「一切皆插件」架构评审的 Phase A/B/C/E 落地能力，评估市面开源项目能否作为
> 方案依赖，减少造轮子。
> 资料口径：只使用各项目的 GitHub 仓库、官方文档、crates.io / npm 元数据与官方发布
> 记录作为论据；二手文章不作为论断来源。维护状态数据截至 2026-09-04。

## 背景约束（评估基线）

以下决策不可推翻，所有匹配度都对照它们评估：

- 插件是 v4 产品包：Rust 内核（`crates/plugins`）负责安装/激活/候选代/回滚；插件
  后端代码跑在**每插件独立 Node 进程 Worker**（stdio JSON-RPC）。Full Trust——
  [ADR-0048](../adr/0048-full-trust-plugin-execution-model.md) 明确无沙箱，Worker
  进程只为热更新与崩溃隔离，不是安全边界。
- 插件 UI 走 iframe App surface + 类型化 bridge（当前实现为 `srcDoc` 文档 +
  `vibex.app-surface/1` postMessage 协议，见
  `frontend/src/components/plugins/AppSurfaceHost.tsx`）；SDK 是 TypeScript
  （`@vibex/plugin-sdk`）。
- 前端用 dockview-react 管理面板；市场为自建官网 Catalog API + 来源锁
  （[ADR-0067](../adr/0067-plugin-platform-improvement-plan.md) Phase 2/3）。
- 主进程不允许第三方动态库/任意 command 注册（ADR-0046）。

要落地的能力：Phase A（6 个已挂孔 UI slot + host.call 供应商预设 API）、Phase B
（`app.panel` 结构级 UI 贡献点：dockview 面板 = 主导航 Tab = 侧栏视图，关键问题是
插件面板前端代码的加载与隔离）、Phase C（宿主能力 Provider 缝）、Phase E（插件依赖
插件：manifest 依赖 + 版本求解 + 激活排序，跨插件服务调用，远期插件自声明扩展点）。

## 结论摘要

| # | 候选 | 结论 | 落点 |
| --- | --- | --- | --- |
| 1 | Cordis | 借鉴设计，不引依赖 | Phase E 语义参照 |
| 2a | Module Federation 2.0 | 部分采用（runtime + vite 插件） | Phase B |
| 2b | single-spa | 不匹配（实质停维） | — |
| 2c | qiankun | 不匹配（价值主张相反） | — |
| 2d | Piral | 不匹配；feed 规范可借鉴 | 市场 API 参照 |
| 3a | Eclipse Theia | 不迁移；借鉴贡献点模型 | Phase B/E 设计参照 |
| 3b | Lumino | 不匹配（与 dockview 同位竞争） | — |
| 4 | pubgrub + semver | 采用 | Phase E（Rust 侧） |
| 5 | extism / wasmtime component model | 不匹配（与 Full Trust 决策相反） | — |
| 6 | Open VSX | 参考不采用 | — |
| 7 | 原生 ESM + import map（补充候选） | Phase B 降级/对照路线 | Phase B |

Phase A 的 6 个 UI slot、host.call 供应商预设 API 与 Phase C 的 Provider 缝均为
宿主内部 seam 的补齐工作，本轮调研对象没有任何一个能直接承接，也不需要外部依赖；
下文不再逐一重复这一点。

## 1. Cordis（cordiverse/cordis）

**定位。** TypeScript「时空可组合性」元框架：plugin = 实现 Service 的对象（函数或
`Service` 子类），context 是服务容器（`ctx.tools`、`ctx.llm` 一类稳定 key），插件用
`inject` 声明服务依赖并等待就绪才启动，注册全部是可逆副作用（`ctx.effect()` /
`ctx.on()`，teardown 按逆序撤销），事件分 `emit` / `waterfall` / `parallel` /
`serial` / `bail` 五种分发模式。它是 DeepSeek Harness 的插件内核。
[仓库](https://github.com/cordiverse/cordis) ·
[DeepSeek Harness 官方 Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) ·
[设计论文（arXiv:2608.25512）](https://arxiv.org/abs/2608.25512)

**维护状态。** MIT。非常活跃：main 分支最近提交 2026-09-03，最新发布
[v4.0.0-rc.9（2026-08-29）](https://github.com/cordiverse/cordis/releases)。但注意三点：

1. **API 未稳定。** README 原文警告 "Cordis is under active development. The API is
   not yet stable and may change without notice"，v4 至今仍是 RC。
2. **bus factor 低。** 贡献分布高度集中于单一作者 shigma（541 次提交，第二名 8 次，
   见[贡献者列表](https://github.com/cordiverse/cordis/graphs/contributors)）。
3. **官方文档未建成。** README 自述 "official documentation is still under
   construction"，当前最好的文档是 DeepSeek Harness 侧的 primer；DeepSeek Harness
   自己也是以 **vendor（源码内嵌）方式**引入 Cordis 而非 npm 依赖（primer 开头明确
   "底层以 vendor 方式引入"），这本身就是上游 API 不稳的佐证。

**匹配分析（关键矛盾：单进程树 vs 多进程）。** Cordis 的全部机制——context 树、
服务查找（沿 ctx 树向上解析）、`inject` 依赖等待、effect 逆序撤销、HMR 的「最小
子树重建」——都建立在**同一个 JS 进程内共享内存对象图**的前提上。服务就是内存里的
对象/类实例，跨插件服务调用就是方法调用。VibeX 的既定模型是**每插件一个独立 Node
Worker 进程**，插件之间没有共享 JS 堆，跨插件调用必须经宿主（Rust 控制面）路由的
RPC。把 Cordis 嵌进这一模型只有三种方式，都不成立：

- **把所有插件收进一个 Cordis 进程**：直接推翻「每插件独立进程」的既定决策，失去
  单插件崩溃隔离与独立热更新（Cordis 的 HMR 是进程内子树重建，无法隔离原生模块
  崩溃或事件循环阻塞）。
- **每个 Worker 内各跑一棵 Cordis 树**：进程边界仍在，跨插件服务依旧要走宿主 RPC，
  Cordis 只剩「单插件内部的模块组织」价值——对一个普通体量的插件包而言收益太小，
  却引入一个 RC 阶段、单维护者的框架依赖，并且其生命周期语义（fiber、fork、
  reload）与 VibeX 已有的激活代（Activation Generation）模型重叠冲突。
- **只用它的类型与调度器、把服务代理成 RPC stub**：等于自己重写 Cordis 的核心
  （服务解析器必须换成跨进程实现），引依赖已无意义。

**但 Phase E 需要的语义，Cordis 是现成最好的参照。** 它验证了一套与 VibeX 词表
高度同构的模型：`inject`（声明依赖服务）↔ manifest `depends.kind=plugin` +
服务贡献声明；「依赖服务就绪才启动、服务方失效先卸载消费方」↔ 激活排序与级联
停用；「注册是可逆副作用」↔ 激活代切换时的贡献注册/撤销；`internal/service`
可用性事件 ↔ 控制面的 contribution readiness 事件。二阶扩展点（插件自声明扩展点）
在 Cordis 里就是「插件注册一个新服务 + 其他插件 inject 它」，映射到 VibeX 即
「插件在 manifest 声明 service contribution，宿主注册表按身份路由跨插件
host.call」。这些语义可以在 Rust 控制面 + JSON-RPC 协议层复刻，无需运行时依赖。

**结论：借鉴设计，不引依赖。** 跨插件服务与激活排序按 Cordis 的
inject/service/effect 语义设计，落在 Phase E 的 manifest 与控制面；不把 Cordis
运行时嵌入 Worker 层。若 v4 正式发布且文档建成，可在单插件内部框架层面重新评估，
但那不是平台依赖决策。

## 2. 微前端 / 远程模块加载（Phase B 插件面板 UI）

### 2.0 两条路线的前提判断

Phase B 的 `app.panel` 是**结构级**贡献：插件面板要成为 dockview 面板、主导航
Tab、侧栏视图，即参与宿主布局、主题 token、焦点管理，理想情况下直接复用宿主的
React 19 与 dockview 实例。当前 iframe `srcDoc` surface（独立文档、postMessage
bridge）适合自包含的文档型 UI，但对结构级面板有硬伤：不共享 React 树与设计 token、
每面板一份框架副本、拖拽/焦点/弹层跨 frame 割裂。ADR-0048 已明确 frame 不是安全
边界，因此「同 JS 上下文加载插件面板代码」不损失任何已承诺的安全属性——隔离要求
从「安全隔离」降为「工程隔离」（版本冲突、样式泄漏、崩溃不连坐），这正是评估下列
框架的准绳：**我们需要的是模块加载 + 共享依赖协商，不是沙箱，也不是路由编排。**

Tauri webview 场景（非 CDN、本地文件）不构成障碍：VibeX 宿主已有本地 HTTP 服务
（web service，`127.0.0.1:17891`，见 `src-tauri/src/commands/web_service.rs`），
插件安装物的 `dist/` 可由宿主以带 CORS 头的本地 HTTP origin 提供，webview 内
`import()` / MF runtime 均可加载；无需依赖远端 CDN。

### 2.1 Module Federation 2.0（module-federation/core）

**定位。** 跨 bundler 的运行时模块联邦：2.0 把 runtime 从 webpack 完全解耦，提供
纯运行时 API（`createInstance` → `registerRemotes` → `loadRemote`），支持
webpack/Rspack/Vite/Rollup 等构建 remote，`mf-manifest.json` 描述产物与共享依赖，
shared 依赖带版本协商与 singleton 约束，另有动态类型提示（remote 的 TS 类型下发）。
[仓库](https://github.com/module-federation/core)（MIT，ByteDance Web Infra 与
Zack Jackson 维护）·
[Runtime API 文档](https://module-federation.io/guide/runtime/runtime-api) ·
[Vite 插件仓库](https://github.com/module-federation/vite)

**维护状态。** 活跃：`@module-federation/vite` 官方维护并持续合并（如
[纯 runtime 注册示例，2026-03-25](https://github.com/module-federation/vite/commit/88e5794b8137b07305d8bf91213f6b9d68eb6d46)）；
2.0 为 stable 线。runtime 包（`@module-federation/runtime`）npm 周下载量高于构建
插件，说明「纯运行时动态联邦」是被广泛使用的形态，与我们的用法一致。

**匹配分析。**

- **宿主侧**：VibeX 前端是 Vite 构建。纯 runtime 用法不要求宿主改造构建管线——
  `createInstance` 后 `registerShared` 把宿主的 react / react-dom /
  `@vibex/plugin-sdk`（以及受控暴露的 dockview API）注册为 shared singleton，再
  `registerRemotes` 指向宿主本地 HTTP origin 上各插件的 `mf-manifest.json`，
  `loadRemote('<plugin>/<panel>')` 拿到组件挂进 dockview。这与「插件面板代码按
  激活代动态注册/撤销」的控制面模型天然吻合（runtime 支持运行时注册/注销 remote）。
- **插件侧**：`@vibex/plugin-sdk` 的构建模板（`vibex-plugin` CLI）加上
  `@module-federation/vite` 产出 remote；作者无感知细节，SDK 锁定共享依赖的
  semver 范围，宿主升级 React 时由 shared 版本协商给出明确失败而非静默双实例。
- **相对纯 ESM import 的增量价值**：共享依赖版本协商 + 失败诊断、产物 manifest
  （天然对接安装物 digest 与激活代校验）、按需分 chunk。代价：插件构建绑定 MF
  产物格式，runtime 引入 ~几十 KB 依赖，Vite 插件比 webpack 实现年轻（需要在
  `test --host` 旅程里覆盖真实加载路径）。
- **不采用其构建期 `import` 同步语法与类型下发**（依赖构建插件与开发服务），只用
  纯 runtime + manifest，保持宿主构建零侵入。

**结论：部分采用，落在 Phase B。** 同上下文面板路线使用
`@module-federation/runtime`（宿主）+ `@module-federation/vite`（SDK 构建模板）；
iframe surface 保留给文档型 App contribution，两者按 surface 类型并存。若实施中
发现 Vite 插件产物在 Tauri webview 有不可绕过的问题，降级路线见 2.5。

### 2.2 single-spa

**定位。** 微前端「路由编排器」：按 URL 路由激活/卸载多个框架异构子应用。

**维护状态。** 实质停维。最后 stable 6.0.3，npm 超过 12 个月无发布；v7 停在
7.0.0-beta.13（2025-09-22）后无进展；社区 issue
[#1361「Why does this project feel abandoned? (Part 2)」](https://github.com/single-spa/single-spa/issues/1361)
无维护者回应，主维护者 Joel Denning 已于 2026 年初离世，社区确认无接棒者。
（MIT。）

**匹配分析。** 即使维护正常也不匹配：它解决的是「URL 路由驱动的子应用编排」，
VibeX 的面板由 dockview 布局驱动、无路由概念；它不提供共享依赖协商（靠 import map
外置）。维护状态使其直接出局。

**结论：不匹配。**

### 2.3 qiankun（umijs/qiankun）

**定位。** 蚂蚁系微前端框架，核心资产是 JS/样式沙箱（membrane 视图隔离 window/
document）与 HTML entry 加载器；3.0 新增不依赖 iframe 的
[ESM 沙箱（PR #3133，2026-07 合并）](https://github.com/umijs/qiankun/pull/3133)
以支持 Vite 原生 ESM 子应用。

**维护状态。** 活跃：3.0.0-rc.21+（`rc` tag），kuitos 主导，
[README](https://github.com/umijs/qiankun) 标注 3.0 active development；stable 线
仍是 2.x。MIT。

**匹配分析。** 价值主张与 VibeX 诉求**正好相反**：qiankun 的全部复杂度花在把子应用
与宿主隔离开（独立 window 视图、样式圈禁、全局变量回收），而 Phase B 面板恰恰要求
**共享**宿主 React 与设计 token；Full Trust 决策又使其沙箱不提供我们需要的任何
安全承诺。其「HTML entry 子应用」粒度也重于「一个 dockview 面板组件」。若未来需要
把不受信第三方脚本圈在主窗口内运行（新 ADR 场景），`@qiankunjs/sandbox` 可独立
使用，届时可重新评估。

**结论：不匹配。**

### 2.4 Piral（smapiot/piral）

**定位。** 完整微前端**应用壳框架**：宿主是 Piral instance（app shell），扩展单元
是 pilet（带生命周期与 API 注入的 npm 包），配套 pilet feed 服务规范与 CLI 全家桶。

**维护状态。** 活跃：piral-core 1.12.2（2026-08-05，见
[CHANGELOG](https://github.com/smapiot/piral/blob/develop/CHANGELOG.md)），smapiot
公司维护，MIT。

**匹配分析。** 采用 Piral 意味着 VibeX 前端壳重写为 Piral instance、插件改写为
pilet、市场对接其 feed 协议——三者 VibeX 都已有自建等价物（dockview 壳、v4 包、
官网 Catalog + 来源锁），迁移是负收益。值得单独一提的是
[Piral Feed Service API 规范](https://docs.piral.io/reference/specifications/feed-api-specification)：
其 pilet 元数据字段（`link` / `integrity` / `spec` / `dependencies`）与 ADR-0067
Phase 2 的 Catalog `versions` + digest 设计同构，可作为官网 API 字段完备性的
对照清单。

**结论：不匹配；feed 规范作为市场 API 的设计参照。**

### 2.5 补充候选：原生 ESM 动态 import + import map

调研过程中确认的最小替代路线：Full Trust 前提下，宿主用
`<script type="importmap">`（或 es-module-shims 垫片）把 react、`@vibex/plugin-sdk`
等共享依赖映射为固定 URL，插件面板构建成 externals 化的纯 ESM 文件，宿主
`import(url)` 加载。零框架依赖、产物即标准 ESM；代价是共享依赖版本协商、加载
manifest、chunk 管理全部自研，import map 在文档加载后不可扩展（动态增删 scope 需
es-module-shims 或预留全量 map）。qiankun 的 ESM 沙箱 RFC 也把
[es-module-shims 作为基座候选](https://github.com/umijs/qiankun/pull/3133)评估，
说明该路线在业界被验证中。**定位：Phase B 的降级/对照路线**——若 MF 2.0 的 Vite
产物在 Tauri webview 出现不可绕过的问题，此路线可承接同上下文加载，版本协商退化为
「宿主锁死共享依赖 major 版本 + manifest engines 校验」。

## 3. Eclipse Theia / Lumino

### 3.1 Eclipse Theia

**定位。** 构建 Web/桌面 IDE 的完整框架：browser 前端 + Node 后端，两侧各一个
InversifyJS DI 容器；扩展是声明 `theiaExtensions` 的 npm 包，导出 ContainerModule
把实现绑定到贡献接口（`CommandContribution`、`MenuContribution`、
`FrontendApplicationContribution` 等），核心用 ContributionProvider（multi-inject）
收集所有实现。[Authoring 文档](https://theia-ide.org/docs/authoring_extensions/) ·
[@theia/core API](https://eclipse-theia.github.io/theia/docs/next/modules/_theia_core.html)
（v1.74 线） · [仓库](https://github.com/eclipse-theia/theia)（EPL-2.0 双许可，
Eclipse Foundation 治理，月度发布，活跃）

**整体迁移是否现实：否。** 论证：

1. **架构互斥。** Theia 的前后端各持一个**全局 DI 容器**，扩展在构建期被收进同一
   应用产物（CLI 收集模块统一 webpack 打包）——这是「编译期组装的单体」，与 VibeX
   「运行期安装、独立 Worker 进程、激活代原子切换」的动态插件模型不同层。采用
   Theia 等于放弃 Rust 宿主（`Deployment` trait、事件溯源会话核心、ACP runtime）
   换一个 Node 后端，重写成本覆盖全部三层。
2. **Electron 绑定。** Theia 桌面形态是 Electron；VibeX 是 Tauri + Rust。
3. **产品面不重叠。** VibeX 的核心域（Conversation 事件溯源、Workspace worktree、
   Agent 编排）在 Theia 里没有对应物，能复用的只有 workbench 表层，而这层 VibeX
   已由 dockview 承担。

**可借鉴的贡献点模型设计**（落 Phase B/E 的扩展点注册表设计）：

- **「接口即扩展点」+ 集中收集**：核心定义贡献接口，注册表通过 ContributionProvider
  统一收集与迭代——对应 VibeX 的做法是 manifest 声明贡献 + Rust 控制面注册表按
  类型收集，语义相同、载体从 DI 换成声明式清单（这也符合 bb 调研中「安装前可静态
  展示行为」的结论）。
- **贡献接口稳定、rebind 是逃生舱**：Theia 实践明确「扩展走贡献点，rebind 视为
  可变契约，patch core 几乎不需要」（EclipseSource 2026-07 实践报告，转述其官方
  布道内容）。映射到 VibeX：稳定面收敛（ADR-0067 Phase 4）之外不给插件提供
  「覆盖宿主实现」的通道。
- **前/后端贡献同包不同入口**（`frontend` / `backend` 模块字段）：与 v4 包
  App/Worker 双入口同构，验证了现有设计。

**结论：不迁移；借鉴贡献点模型设计，不引依赖。**

### 3.2 Lumino（jupyterlab/lumino）

**定位。** JupyterLab 底层 widget/布局/命令库（前身 PhosphorJS）：`DockPanel`、
命令注册表、信号/disposable 原语。框架无关但以命令式 widget 树为中心，React 需经
适配层。[仓库](https://github.com/jupyterlab/lumino)（BSD-3，Project Jupyter 治理）

**维护状态。** 稳定维护（以 upkeep 为主）：最新发布
[v2026.7.3（2026-07-03）](https://github.com/jupyterlab/lumino/releases/tag/v2026.7.3)，
`@lumino/widgets` 2.9.0。

**匹配分析。** 它与 dockview-react 是同位竞争（docking/布局层），VibeX 已深度使用
dockview 且 [ADR-0042](../adr/0042-conversations-are-first-class-dockview-panels.md)
把会话面板定为一等 dockview 面板；替换没有能力增量，只有迁移成本。其命令注册表与
disposable 模式在 TS 生态属常见惯用法，无需引包借鉴。

**结论：不匹配。**

## 4. pubgrub 与 semver 求解（Phase E，Rust 侧）

**定位。** [pubgrub](https://github.com/pubgrub-rs/pubgrub) 是 PubGrub 版本求解
算法（CDCL SAT 变体）的 Rust 实现，**uv 在用，且是 cargo 求解器的指定替代**
（README 自述）。核心接口是 `DependencyProvider` trait：实现 `prioritize`（决定
下一个决策的包）、`choose_version`（区间内选版本）、`get_dependencies`（取某版本
依赖）三个方法即可求解；包类型 `P`、版本类型 `V`、版本集 `VS` 全部泛型（0.3 起
区间类型独立为 `version-ranges` crate）。自带 `OfflineDependencyProvider`——全部
元数据在内存中的实现，选择「约束内版本数最少的包优先」。
[DependencyProvider 文档](https://docs.rs/pubgrub/latest/pubgrub/trait.DependencyProvider.html) ·
[0.3 发布说明](https://github.com/pubgrub-rs/pubgrub/releases/tag/v0.3.0)

**维护状态。** [crates.io](https://crates.io/crates/pubgrub)：0.4.0
（2026-04-10），MPL-2.0，MSRV 1.92，owner 含 Eh2406（cargo 团队）与 konstin
（uv/Astral），总下载 72 万+。活跃且由两大生产使用方的核心人员维护。MPL-2.0 是
文件级 copyleft，作为未修改的 crate 依赖对 VibeX 无传染义务（修改其源文件才需
开源该文件）。

**匹配分析。**

- **规模适配。** 插件依赖图是小图（数十节点量级），`OfflineDependencyProvider`
  直接够用：安装/激活前把本地 catalog + 官网 `versions` 的候选版本喂进内存即可，
  无需实现增量网络 provider。求解耗时在该规模可忽略。
- **错误信息是关键增量。** PubGrub 的差异化能力是**可读的不可满足性解释**（逐步
  推导出「因为 A 依赖 B>=2 而 root 需要 B<2，所以……」），这正是插件安装/激活
  失败时用户可见诊断所需要的文案基础——自研回溯求解器很难达到同等解释质量。
- **与既定模型合缝。** `Dependencies::Unavailable` + 自定义不可用原因类型 `M`
  可以直接表达「平台不支持」「digest 缺失」「来源锁不允许」等 VibeX 特有约束；
  求解结果（精确版本集）落进激活代快照，激活排序再按依赖图拓扑序执行——求解与
  排序两件事分离，pubgrub 只负责前者。
- **semver 解析配套用 [`semver` crate](https://crates.io/crates/semver)**（dtolnay，
  1.0.28 / 2026-04-04，MIT/Apache-2.0，reverse deps 3500+）：manifest 的版本与
  区间解析、`engines.vibex` 校验用它；注意它实现的是 **cargo 语义**的区间（`^`
  默认），插件 manifest 的区间语法需在文档里明确对齐 cargo 语义，避免作者拿 npm
  语义预期。若坚持 npm 语义可用 `nodejs-semver` crate 替换解析层，求解器不变。

**结论：采用（pubgrub 0.4 + semver），落 Phase E。** 放在 `crates/plugins` 的
安装/激活决策路径；`version-ranges` 作为区间表示随 pubgrub 引入。

## 5. extism / wasmtime component model

**预期不匹配，核实后确认。**

- **[extism](https://github.com/extism/extism)**（BSD-3，v1.21.0 / 2026-03-26，
  活跃）：Wasm 插件框架，插件需用各语言 PDK 编译为 `.wasm`，宿主经 host function
  白名单授予能力。它的全部附加价值——内存隔离、无 WASI 默认、host 控制的 HTTP、
  运行限额——服务于「安全执行不受信代码」（README 明确主打 untrusted code）。
  VibeX 已在 ADR-0048 决定 Full Trust + Node Worker + TS SDK：采用 extism 等于
  推翻该决策，同时失去 npm 生态与直接的本机能力（插件要靠宿主逐个开洞），SDK
  形态也从「普通 TS 包」劣化为「PDK 编译产物」。不匹配。
- **[wasmtime component model](https://docs.wasmtime.dev/api/wasmtime/component/index.html)**
  （Bytecode Alliance，活跃；WASI 0.3 已于 2026 年 ratify，
  [Component Model 1.0 仍在路上](https://bytecodealliance.org/articles/the-road-to-component-model-1-0)）：
  同理不匹配——WIT/bindgen 的强类型组件边界很优雅，但要求插件走 Wasm 工具链，
  与 Node Worker + Full Trust 决策正交冲突。唯一相关场景是 ADR-0048 结尾预留的
  「未来不受信 Marketplace 需新 ADR 引入独立 package class」：届时 wasmtime
  组件（或 extism）是该新 class 的首选技术储备。本轮不落任何 Phase。

**结论：均不匹配；wasmtime 组件模型记为远期不受信 package class 的技术储备。**

## 6. Open VSX（eclipse-openvsx/openvsx）

**定位。** Eclipse 基金会的 VS Code 扩展注册中心（open-vsx.org 及可自托管的
server）：Java 17 + Spring Boot 应用，需 PostgreSQL 12+，搜索需 Elasticsearch，
认证走 OAuth2，存储支持本地/S3/Azure/GCS，面向 VSIX 包格式与 VS Code 兼容 API。
[部署文档](https://github.com/eclipse-openvsx/openvsx/wiki/Deploying-Open-VSX) ·
[自托管配置讨论 #703](https://github.com/eclipse-openvsx/openvsx/issues/703)
（EPL-2.0，活跃维护。）

**匹配分析。** 与自建市场相比是净负收益：VibeX 的包格式是 `.vxp`（非 VSIX）、
目录 API 已按 ADR-0067 Phase 2 定义为六类只读接口 + 四元组身份 + digest + 来源锁，
官网（vibex-site）已承载发布流程。引入 Open VSX 意味着运维一套
Java/PostgreSQL/Elasticsearch 栈、把身份模型迁到它的 namespace/token 体系，还要
改造包格式适配——全部是为了得到一个我们已经有的东西。其 namespace 所有权与
publish token 治理可作为官网发布流程的对照参考，但不构成引入理由。

**结论：参考不采用。**

## 建议采用组合

| 候选 | 版本/License | 结论 | Phase | 用途 |
| --- | --- | --- | --- | --- |
| pubgrub（+ version-ranges） | 0.4.0 / MPL-2.0 | **采用** | E | Rust 侧插件依赖版本求解与不可满足性解释 |
| semver（dtolnay） | 1.0.28 / MIT+Apache-2.0 | **采用** | E | manifest 版本与区间解析（cargo 语义，需在作者文档标明） |
| Module Federation 2.0（runtime + vite） | 2.x / MIT | **部分采用** | B | 同上下文插件面板加载 + 共享依赖协商；iframe surface 保留给文档型 UI |
| 原生 ESM + import map | 标准能力 | 降级路线 | B | MF 路线受阻时的同上下文加载兜底 |
| Cordis | 4.0.0-rc.9 / MIT | **借鉴设计，不引依赖** | E | inject/服务就绪/可逆注册语义 → manifest 依赖 + 激活排序 + 跨插件服务注册表 |
| Eclipse Theia | 1.7x / EPL-2.0 | **借鉴设计，不引依赖** | B/E | 贡献点接口 + 集中收集注册表的设计参照 |
| Piral feed 规范 | 1.12.x / MIT | 借鉴设计 | 市场 | Catalog `versions`/integrity 字段完备性对照 |
| single-spa | 6.0.3 / MIT | 不匹配（实质停维） | — | — |
| qiankun | 3.0-rc / MIT | 不匹配（沙箱价值主张与 Full Trust 相反） | — | — |
| Lumino | 2026.7.3 / BSD-3 | 不匹配（与 dockview 同位） | — | — |
| extism | 1.21.0 / BSD-3 | 不匹配（Wasm 沙箱 vs Full Trust） | — | — |
| wasmtime component model | WASI 0.3 / Apache-2.0 | 不匹配；远期不受信 package class 储备 | — | — |
| Open VSX | EPL-2.0 | 参考不采用（重栈 + 格式不符） | — | — |

净结论：**真正值得引的外部依赖只有两个半**——pubgrub + semver（Phase E 求解），
以及 Module Federation 2.0 的 runtime 部分（Phase B 面板加载）。其余候选的价值在
设计层：Cordis 给出跨插件服务与激活排序的语义蓝本，Theia 给出贡献点注册表的形态
蓝本，二者都应转写进 VibeX 自己的 manifest + Rust 控制面，而不是作为运行时依赖
进入 Worker 或前端。
