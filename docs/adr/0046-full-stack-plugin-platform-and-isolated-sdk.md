---
status: accepted
date: 2026-08-13
decision-makers:
  - VibeX maintainers
---

# 全栈 Plugin Package、隔离执行与版本化 SDK

> 公共包布局、作者术语与产品 UI 已由 ADR-0047 修订；本文继续定义内核生命周期、
> Runtime 与 SDK 边界。执行信任与权限模型已由 ADR-0048 修订。

## Context

VibeX 当前的 Plugin control plane 以 Agent Skill 为中心：Portable Plugin 必须至少
包含一个 Skill，Runtime、MCP、PluginAction 与 Plugin Command 只是 Skill 的配套贡献。
与此同时，Office 文件预览仍由核心中的 `OfficePreview`、Office 专用 commands 与
`OfficeRuntime` 提供。这导致一个用户理解中的 Office 插件实际上被分成两份产品：
Agent 使用的插件包和 VibeX 内置的 App 能力。

当前实现还保留严格 v2 manifest 与宽容 v3 package、`plugin_v2_*` 与
`plugin_control_*` 两套持久事实。Office 的启停、恢复、动作校验和预览都有专用分支。
继续在这些分支上增加 App entrypoint 会得到第三套生命周期，而不会形成可供第三方使用
的平台扩展能力。

对 [`get-bb/bb`](https://github.com/get-bb/bb) 的调研证明“一包同时扩展 Agent 与 App”
能够提供良好的开发体验：bb 使用 Backend/App 双入口、类型化 RPC、原子 reload、dispose
与测试 harness。但 bb 的 Backend 和 App 插件分别在 Server 进程与 App 同源页面中以
全信任代码运行，也没有声明式外部 Runtime、安装锁或 capability permission。这些边界
不适合作为开放的本地 IDE 插件生态默认值。

本决定取代 ADR-0043。ADR-0043 对原生 Codex/Claude Code 插件权威、Agent binding、
Skill projection、Invocation definition 与 Host 所有权的决定继续保留；以下决定取代其
Portable Plugin、用户全局 Runtime、Runtime displacement 和 Shell 信任模型。

## Decision

### 1. Plugin 是一个产品级安装与生命周期单元

VibeX Plugin Package 是唯一的产品扩展单元。内部可以连接 Agent、App、Host 与 Runtime
扩展点，但这些不是面向用户的插件分类。一个包只要含至少一个当前 Host 可识别的有效
integration 即可安装，不再要求 Skill；所有插件走同一安装、授权、激活、更新、诊断、
回滚与卸载管线。

Codex 与 Claude Code 原生插件不因此变成 VibeX 可执行 App Plugin。它们仍由各自原生
位置与信任机制持有，并在“设置 → Agent → 对应 Agent → 插件”中管理。产品级 VibeX
Plugin Package 从新的 Plugin 模块管理。多格式源码包可以共享显式 identity 与 Skill
内容，但原生投影和 VibeX activation 是不同事实。

### 2. v4 manifest 静态声明能力上界

`.vibex-plugin/plugin.json` v4 必须声明：

- `manifestVersion`、`apiVersion`、稳定 `id`、`publisher`、`version` 与 Host 兼容范围；
- 可选 Worker/App entrypoints；
- Agent、App、Host 和 Runtime contributions；
- 运行代码可能使用的 capability requests；
- 每个 Runtime 的确定平台分发、完整性证据、入口与 probe；
- 可选签名与构建 provenance。

Manifest 是安装前可审计的最大能力边界。Worker 运行后可以为已声明 contribution 绑定
handler，但不能注册未声明 contribution、扩大 path/domain scope 或请求未声明权限。
安全相关对象严格校验；未知可选 metadata 可以保留并警告。未知 required contribution、
未知 permission 或无法识别的 executable entrypoint 使 package incompatible，而不是
静默降级。

`manifestVersion`、`apiVersion`、`minimumHostVersion`、每种 contribution kind version
和 package version 分别演进，不能互相代替。

### 3. Contribution Registry 是所有消费方的唯一运行时目录

Plugin Kernel 在一个深模块中拥有 package inspection、installation、grants、runtime
resolution、candidate activation、generation publication、disable、rollback 与 audit。
其外部 interface 只表达用户用例；Tauri、Axum、Desktop/Web UI、Agent executor、
Automation 和 Artifact Host 都是调用该 interface 的 adapter。

Activation Manager 把通过校验的 contribution descriptors 原子发布为不可变
Activation Generation。Contribution Registry 只暴露当前 generation 的 descriptor、
handler route、readiness 和 failure evidence。任何消费方不得按插件 ID 特判，也不得
直接持有 Office 或其他插件 runtime。

Contribution ID 在 package identity 下命名空间化。冲突解析必须确定且可解释；同一
extension point 的用户默认选择是独立状态，不能靠安装顺序静默覆盖。

### 4. Candidate-first 激活与 generation 生命周期

安装、更新、linked-development reload 和重新授权都使用同一事务语义：

1. 物化不可变 package snapshot 并验证 digest、兼容性与静态声明；
2. 解析 Runtime lock，计算 capability grant delta；
3. 在不可见 candidate generation 中启动 Worker、绑定 handlers、probe Runtime；
4. 核对实际 registrations 是 manifest declarations 的子集且必需项均已就绪；
5. 一次事务原子发布 package version、grant、runtime locks 与 generation；
6. 新调用进入新 generation，旧 generation 停止接收调用；
7. 等待旧调用和 preview leases 排空，发送 abort/dispose 后回收旧进程与资源。

Candidate 在发布前失败时，当前 generation 继续服务，不能留下部分 UI、Agent tool、
runtime ref 或数据库写入。Host 崩溃后的恢复以持久 activation intent 和最后完整发布的
generation 为证据；内存 registration 不是权威。

Plugin 可以是 `active_degraded`：非必需 contribution 失败只隔离该能力并记录证据；
必需 contribution 失败则阻止 candidate 发布。

### 5. 第三方代码默认隔离

VibeX 不允许普通第三方插件在 Tauri/Rust 主进程中动态注册 command、加载动态库，或在
React 主应用同源上下文执行任意代码。

执行分为三个 trust tier：

1. **Declarative**：只有 manifest、Skill、MCP 配置和宿主渲染 descriptor，不执行插件
   代码；
2. **Sandboxed Worker**：默认代码入口，在独立 OS 进程中通过版本化 JSON-RPC/stdio
   protocol 与 Capability Broker 通信；文件、网络、秘密、进程、Artifact 和 App 调用
   只能穿过 Broker；
3. **Trusted Native**：需要任意 shell、原生 sidecar 或不能受 Broker 约束的入口，作为
   独立高风险权限显著授权，不得由普通 grant 或同 ID 更新继承。

自定义 App UI 默认使用唯一 origin 的 sandboxed iframe/webview，执行严格 CSP，通过
类型化 bridge 和短期 capability token 通信。简单设置、命令、文件 opener 和状态 UI
优先采用宿主渲染的声明式 surface。第一方签名包未来可以选择 trusted in-process UI，
但它不是公共 SDK 的兼容基线。

### 6. Permission grant 绑定发布者与能力集合

Capability request 是 package 声明；Capability grant 是用户对当前 Host 上明确
publisher、plugin ID、能力集合与 scope 的授权。更新扩大 capability、路径范围、网络
域、runtime 执行或 UI surface 时必须重新授权。来源、publisher 或签名身份变化按新包
处理，不能只因 Plugin ID 相同继承执行权。

Plugin 的 settings、KV、SQLite 与 secrets 按 Plugin identity 隔离。普通插件不能读取
其他插件的数据、secrets、环境变量、主 token 或设备凭据。日志、operation audit 与错误
不得记录秘密。

Shell recipe 不属于普通 Runtime installer。必须使用时只能进入 Trusted Native tier，
每个发生变化的 recipe/digest 重新授权；卸载 recipe 仍是独立破坏性授权。

### 7. Runtime 是内容寻址、引用计数的 Host 资源

托管 Runtime 以 `runtime id + version + target + digest` 标识，安装在 VibeX Host 所有的
版本化目录中。每个 package installation 保存精确 lock，并只向对应 Worker/Agent
execution 投影入口。不同插件可以并存使用同名 Runtime 的不同版本；更新先准备新 lock，
发布新 generation 后再按引用计数回收旧版本。

VibeX 不再通过替换一个用户全局命令并级联删除其他插件来解决版本冲突。向用户终端导出
稳定 shim 是单独的、显式授权 contribution，不是 Runtime 安装默认副作用。外部 Runtime
可以被只读探测和锁定，但其文件所有权仍属于外部管理者。

### 8. SDK 以协议和测试契约为产品

首个公共 SDK 是 TypeScript，并拆为 Worker、App、Protocol 和 Testing 包。SDK 只包装
稳定 wire protocol，不暴露 Tauri、Axum、数据库或内部 Rust 类型。CLI 至少提供
`init`、`dev`、`validate`、`test`、`build`、`pack`、`install --link` 与 `doctor`。

构建生成确定性 `.vxp` package、content digest、runtime lock evidence、可选 SBOM/
signature 和 entrypoint metadata。Testing package 提供 fake Capability Broker、App
harness、lifecycle/crash/reload 测试与 manifest/runtime contract tests，并明确 fake 与
真实 sandbox 的 fidelity difference。

VibeX 随当前安装版本发布“VibeX 插件开发指南”Skill。该 Skill 必须先读取本机 SDK
类型、schema 与 Host capabilities，再指导 Agent 创建、验证、测试和 linked install；
不能依赖可能与本机版本不匹配的在线示例。

### 9. Office 是 SDK 的第一个 reference plugin

Office 的 DOCX/XLSX/PPTX Skills、PluginActions、OfficeCLI Runtime、文件 opener、preview
provider 与设置全部进入同一个 `vibex.office` v4 package。Artifact Host 继续拥有路径
验证、preview lease、capability token 与进程清理；Office 只通过公共 contribution 和
SDK 实现 provider。

核心提供通用 `app.fileOpener` / `artifact.previewProvider` resolution 和 Render
Descriptor，不认识 Office 扩展名或 `vibex.office`。内置降级预览也是一个较低优先级的
core provider。禁用 Office 会原子撤下其 Agent 与 App contributions；已打开 lease 按
generation drain policy 完成或到期，之后文件可回退到其他 provider。

Office reference plugin 与第三方示例使用同一 manifest、SDK、sandbox、权限、安装与
激活路径。“随应用分发”只改变来源和默认可发现性，不能绕过平台契约。

### 10. Application Core 与 Remote protocol 保持唯一业务 seam

Plugin Kernel 属于 ADR-0033 定义的 Application Core。Worker 和 Runtime 在 VibeX Host
执行；Desktop/Web/Remote 客户端只渲染 Host 返回的 contribution inventory 与 App
surface，并通过 BackendTransport 调用。客户端必须协商 surface capabilities；不支持的
surface 明确标记 unavailable，不能尝试本地执行 Host plugin。

## Compatibility and migration

- v2/v3 manifest 只由 migration adapter 读取并编译成 canonical v4 model；新内核不同时
  维护两种运行时实体。
- 现有 Codex/Claude Code source package 仍由 native adapter reconciliation，不会因 v4
  自动获得 App execution 权限。
- 迁移先建立 canonical installation/grant/contribution/runtime/generation schema，再以
  双读校验旧证据；切换后停止旧表写入，验证完整后删除旧运行路径和表。
- 旧 `Plugin trust grant` 不迁移为 Worker、Native 或扩权 grant。可证明等价的低风险
  declarative intent 可以迁移；所有代码执行与扩大权限重新授权。
- Office 迁移完成后必须删除第二份 manifest、Office 专用 commands/state/frontend
  dispatch 和旧 runtime 恢复路径，不保留长期 compatibility branch。
- Automation 与 Conversation 保存 package version/digest、contribution identity 与
  resolved runtime evidence；引用已卸载 contribution 的历史仍可解释，新运行明确失败。

## Consequences

1. `PluginPackage::inspect` 的“至少一个 Skill”规则、按 ID 永久 shell trust 和全局 Runtime
   displacement 被取代。
2. Control Plane 不再同时承担 VibeX 产品插件和 Agent 原生插件的用户信息架构；后者进入
   对应 Agent 设置 tab，但底层 native adapter 与 reconciliation 可以复用。
3. 需要新增 Plugin Kernel、Contribution Registry、Capability Broker、Worker Host、App
   Extension Host 与 Runtime Resolver 深模块，同时删除 Office-specific orchestration。
4. 隔离进程、CSP、跨平台 sandbox、签名和供应链验证会增加实现成本；这是开放第三方执行
   生态的必要成本，不能以安装警告代替。
5. SDK compatibility、protocol generation、reference plugins 与 contract tests 成为发布
   门禁，而不是附属文档。

## Considered options

- **在现有 Agent Plugin 上增加可选 `app` 字段。** 否决。它保留双 control plane、Skill
  必选、全局 Runtime 与 Office 特判，App 只会成为浅层挂件。
- **建立独立 APP Plugin 系统。** 否决。用户仍会面对两个 Office、两套版本与启停状态，
  Agent 与 App contributions 无法原子升级和回滚。
- **照搬 bb 的同进程 Backend 和同源 App 执行。** 否决。可靠性隔离不是安全隔离；开放
  第三方生态不能让任意插件读取全部工作区、凭据和其他插件 secrets。
- **所有插件都采用 iframe + 远程 MCP。** 否决。它不能覆盖本地文件 provider、长驻
  Runtime、离线 Agent tool 和高性能预览；声明式与 Worker 两级仍然必要。
- **继续使用用户全局 Runtime 并在冲突时删除依赖插件。** 否决。它破坏原子升级、回滚
  和版本并存，并把插件安装变成不可预测的级联删除。
- **先开放大量 UI slots，再迁移 Office。** 否决。Office file opener/preview 是检验 App、
  Agent、Runtime、权限和 lease 是否真正统一的最小完整纵向切片。
