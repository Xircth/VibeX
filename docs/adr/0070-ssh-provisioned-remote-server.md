---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# 通过 SSH 供给与接管远程 VibeX Server

本决定为「把整个工作区搬到远端」补全最后一环：用户只有一台可 SSH 访问的服务器
（无公网 origin、无局域网可达、未安装 VibeX）时，桌面端能够经 SSH **供给**
（安装、启动、升级）一个版本配套的 `vibex-server`，经 SSH **隧道**建立可达，
经 SSH **信任引导**完成设备配对，然后以既有 Server-bound window 使用远端
Host——Agent、Git worktree、终端、插件全部在服务器上运行，桌面（或 WebUI）
只是客户端。

本 ADR 是 [ADR-0069](0069-everything-is-a-plugin-platform.md)（一切皆插件）的
姊妹篇：0069 界定了「工作区搬到远端不是插件能做的事」（L0 边界），本篇给出这件
事的核心路线，并把其中唯一适合插件化的部分（SSH 供给器）交还给 0069 的插件
平台。

对标：VS Code Remote-SSH。其可行性来自产品核心先有 client/server 边界，SSH
扩展只是「供给器 + 隧道 + 指向切换」。VibeX 的对应边界已由 ADR-0033 建立并
部分实现，本篇不重建边界，只补 SSH 通道。

## Context

代码库现状（2026-09-04 核验）：

1. **共享应用核心与 Headless Server 已在。** `crates/server` 提供
   `HeadlessServer` / `host_application_core()`，与 Tauri 桌面共用同一
   Application Core（ADR-0033）；`vibex-server` 独立二进制存在，发行物形态已由
   ADR-0054 定义（跨平台目录 / 可选 Docker，含 `web/` 与官方插件快照）。
2. **远程协议与传输已在。** `crates/remote-protocol` v1.0：版本化命令信封、
   WS 订阅（Conversation / WorkflowRun）、设备配对凭据、`ServerCapabilities`
   协商。前端 `BackendTransport` 注册表已有 `TauriTransport` / `WebTransport`
   （HTTP + WS + token）/ `RemoteDesktopTransport`（`remote_desktop_connect`
   profile，凭据留在 Rust 侧）。
3. **身份、配对与可达名单已在。** Host 身份 + Reachability 名单 + 五分钟一次性
   pairing secret（ADR-0059）；Workstation 客户端等级（ADR-0054）；窗口与
   Server Profile 一对一绑定、断连三动作（ADR-0033）。
4. **远程 P0 能力边界已定义。** ADR-0033 列明 Server-bound window 必须闭环的
   能力（项目/工作区/会话/文件/Git/远程终端/断线重连），以及明确不在 P0 的
   能力（CEF 浏览器、完整插件等，经 capabilities 如实降级）。

缺的是三件事，全部与 SSH 相关：

- **供给**：目标机器上没有 `vibex-server` 时，没有任何自动化安装/启动路径；
- **可达**：ADR-0059 的 Reachability 名单假设 Host 已在运行并能出示邀请；
  「只有 SSH 能进去」的机器既无 origin 也无邀请可扫；
- **信任引导**：配对邀请依赖本机控制台出示；无头服务器没有控制台可看。

## Decision

### 1. 拓扑与职责分离

SSH 只承担三件事：**供给通道**（投递与管理 `vibex-server`）、**承载隧道**
（本地端口转发）、**信任引导通道**（经 SSH exec 取一次性配对邀请）。数据面
维持 remote-protocol over HTTP/WS 不变——SSH 不是第二套应用协议。

```text
桌面 / WebUI 客户端
  │  remote-protocol（HTTP/WS，token + 设备凭据）
  ▼
127.0.0.1:<forwarded>  ── ssh -L 隧道 ──▶  远端 127.0.0.1:<port>
                                              │
                                        vibex-server（loopback-only）
                                              │
                        Agent / worktree / 终端 / 插件内核（全在远端）
```

远端 `vibex-server` 以 **SSH-only 模式**运行：只 bind loopback、不发布任何
非 loopback Reachability、公网零暴露。ADR-0054 的拓扑约束不变：同一数据目录
同一时刻只有一个 Host；插件内核只活在拥有数据目录的 Host（即远端）上。

### 2. SSH Host Profile 与供给链路

Server Profile（ADR-0033）新增 `ssh` 供给类型。它保存 SSH 目标（host、port、
user、可选 jump）与远端数据目录路径等**非秘密元数据**；SSH 认证一律复用
**用户系统 SSH 环境**（`~/.ssh/config`、ssh-agent、密钥文件），VibeX 不存储、
不生成、不管理 SSH 私钥（与 ADR-0060「使用用户环境」同一原则）。

连接一个 SSH Host Profile 时按以下幂等管线执行，每步可见、可重试、失败不留
半状态：

1. **探测**：`ssh` 执行探测脚本，识别 OS/arch、既有 `vibex-server` 及其版本、
   数据目录占用（ADR-0054：被占用则只能作客户端，禁止起第二个 Host）。
2. **投递**：远端缺失或版本不配套时，下载（远端直连或经本地中转上传）与
   客户端**同 semver 家族**的 VibeX Server 发行物，sha256 校验后解压到版本化
   目录（`~/.vibex/server/<version>/`），原子切换 `current` 链接。
3. **启动**：以 SSH-only 模式启动 `vibex-server`（loopback bind、指定数据
   目录），等待健康检查。进程守护默认用最朴素的方式（nohup + pidfile，随
   发行物提供可选 systemd user unit 模板），不强制远端安装任何守护框架。
4. **隧道**：建立 `ssh -L` 本地转发（随机本地端口），断线自动重建；隧道由
   发起窗口的连接生命周期持有（ADR-0033 窗口-Profile 绑定不变）。
5. **信任引导**：见第 3 节。
6. **连接**：以 `127.0.0.1:<forwarded>` 为 origin 走既有
   `remote_desktop_connect`，之后与任何 Server-bound window 无差别。

**版本配套政策**：客户端优先要求同 semver 家族（同 minor）；`PROTOCOL_VERSION`
+ `ServerCapabilities` 协商允许在兼容窗口内降级使用并明确提示升级；供给器
永远提供「一键把远端升到配套版本」（复用 `plan_host_upgrade` /
`apply_host_upgrade`），升级失败回滚到上一版本化目录。

### 3. SSH 信任引导（扩展 ADR-0059）

ADR-0059 的原则不变：长期凭据不进邀请、secret 五分钟一次性、凭据存系统凭据
存储。SSH 场景的增量是**投递通道**：

- **SSH 权限即管理员证明。** 能以 SSH 登录目标机器并读写数据目录的人，等价于
  能在本机控制台出示邀请的人。因此供给器可经 SSH exec 调用远端
  `vibex-server` 的邀请出示命令，取得一次性 pairing secret 并立即兑换为本
  设备的 scoped device credential——全程不落盘、不进 URL、不需要用户抄码。
- **隧道 origin 不进 Host 权威名单。** `127.0.0.1:<forwarded>` 是客户端本地
  派生地址，对其它设备无意义；它作为**客户端本地 Reachability**（新增来源
  kind `ssh-tunnel`）只存在于本设备的 Profile 中，不违反 ADR-0059
  「`127.0.0.1` 永不进入邀请」。同一 Host 后续若发布真实远程 origin，名单
  合并语义照旧。
- **断连三动作语义沿用**（ADR-0033）：disconnect 关隧道留配对；forget 撤销
  本设备凭据并清理 Profile（可达时先远程撤销）；revoke 在 Server 侧照旧。
  供给器额外提供「停止远端 Server」「卸载远端 Server」两个显式运维动作，
  只经 SSH 执行、要求确认，不与 forget 隐式绑定。

### 4. 能力面：沿用 ADR-0033 P0 边界，不另立标准

本 ADR **不扩大也不重新定义**远程能力面。Server-bound window 经 SSH 隧道
连接后，能力覆盖与降级完全遵循 ADR-0033 的 P0 完成边界与 capabilities 机制
（含远程终端、文件、Git、会话闭环；CEF 浏览器与完整插件面等如实标注不可用）。

配套任务（进实施批次）：**远程能力覆盖矩阵审计**——把桌面命令面对照
`ServerApplicationDomains` 已实现的 DomainCommand 逐域清点，形成
capabilities 台账；差距即 P0 落实的剩余工作，不属于本 ADR 的新决定。

订阅资源目前只有 Conversation / WorkflowRun；P0 清单中的终端流、diff 流、
文件树失效通知需要新增订阅资源类型——这是 remote-protocol 的增量演进
（版本协商已支持），在覆盖矩阵审计后统一排期。

### 5. 插件语义（衔接 ADR-0069）

- **插件跑在 Host 上，Host 在远端。** 连接 SSH Host 时使用的是**远端 Server
  的插件集**（其控制面、Worker、数据都在远端；ADR-0054 拓扑）。本地桌面
  自身 Host 的插件不注入远端窗口。ADR-0069 的 UI 贡献（federation 面板、
  app.tab 等）在远程窗口中的呈现属于「完整插件面」，按 ADR-0033 不在 P0，
  经 capabilities 降级；其资产经隧道加载的设计随 ADR-0069 Batch 2 的资产
  端点一并考虑（同为 HTTP 端点，隧道天然可承载）。
- **SSH 供给器的两阶段形态。**
  - **阶段一（随远程 P0）：宿主内置。** 供给器作为桌面 Host 的内置能力交付
    （Profile 表单的 `ssh` 类型 + 供给管线 + 隧道管理），因为它是连接远端的
    前置设施，且 `remote_desktop_*` 尚未进入 broker 公开面。
  - **阶段二（ADR-0069 Batch 4 后）：迁出为官方能力等价插件。** 将
    `remote.profile.*` / `remote.connect` 开为公开 `host.call` 族后，SSH
    供给器按 ADR-0069 第 8 节迁出为官方插件（`app.settings.page` 管服务器
    列表 + Full Trust Worker 跑 SSH 供给与隧道），并作为「新领域功能插件」
    的第二个试金石（第一个是 SSH 终端类插件，见 0069 讨论）。届时第三方可
    用同一套 API 开发 mosh、teleport、云厂商 API 等替代供给器。

### 6. 安全基线

1. **零公网暴露**：SSH-only 模式 loopback bind；不出示非 loopback 邀请。
2. **SSH 凭据不归 VibeX**：只调用系统 `ssh`（或库实现时读取系统配置与
   agent），不存私钥、不代管 known_hosts 决策（host key 变化时把系统 SSH 的
   告警原样呈现并阻断）。
3. **供应链**：投递的 Server 发行物 sha256 校验（复用 updater 校验语义，
   ADR-0054）；升级走 `apply_host_upgrade` 的计划-校验-回滚路径。
4. **凭据边界沿用**：device credential 存系统凭据存储（ADR-0033）；pairing
   secret 只在 SSH 信道内存续，不写远端磁盘、不进日志。
5. **审计**：供给、启动、升级、停止、卸载、信任引导各步在客户端与 Server
   双侧留审计记录（Server 侧复用既有 operation audit 面）。

## 实施批次

依赖顺序：R0 → R1 → R2；R3 依赖 ADR-0069 Batch 4。各批完成 = 任务全绿 +
验收全过 + 文档/CONTEXT 同步（与 ADR-0069 同一纪律）。

### R0 — 远程能力覆盖矩阵审计

**任务：** 桌面命令面 vs `ServerApplicationDomains` DomainCommand 逐域清点；
P0 清单（ADR-0033）逐项标注「已闭环 / 缺命令 / 缺订阅资源 / 缺 UI 降级」；
产出 capabilities 台账与 remote-protocol 订阅资源增量清单（终端流、diff 流、
文件树失效）。

**验收：** 台账进 `docs/`；每个 P0 项有明确的差距归属；无「未知状态」项。

### R1 — SSH 供给器 MVP（宿主内置）

**任务：** Server Profile 增加 `ssh` 供给类型（元数据不含秘密）；探测/投递/
启动/隧道/信任引导/连接六步幂等管线；版本配套检查与一键升级；nohup+pidfile
守护与 systemd user unit 模板；断连三动作 + 停止/卸载运维动作；`ssh-tunnel`
Reachability kind。

**前端设计要求：** Profile 表单区分「地址连接」与「SSH 供给」两类心智，SSH
认证一栏只说明「使用系统 SSH 配置」，不出现私钥输入框；供给管线以步骤化
进度呈现（探测→投递→启动→隧道→配对→连接），每步失败可单独重试；版本不配套
以非阻断横幅提示并提供一键升级；文案遵守 maiden 原则。

**验收：** 一台仅有 SSH 访问、未装 VibeX 的 Linux 服务器，从新建 Profile 到
Server-bound window 可用全程无手工步骤（除 SSH 密钥本身）；断网后隧道自动
重建且 durable attach 生效（ADR-0033）；forget 后远端凭据被撤销；重复供给
幂等；host key 变化被阻断并可诊断；数据目录被另一 Host 占用时按 ADR-0054
拒绝并解释。

### R2 — P0 能力闭环落实

**任务：** 按 R0 台账补齐 P0 缺口（订阅资源增量、命令补全、capabilities
降级 UI）；重点是远程终端 PTY over WS 流与 diff/文件树订阅。此批工作量由
台账决定，本 ADR 不预设范围。

**验收：** ADR-0033 P0 清单在 SSH Host 上逐项过验（一次日常远程编码任务
端到端）；不可用能力全部经 capabilities 如实呈现，无伪装成功。

### R3 — 供给器插件化（阶段二）

**任务：** `remote.profile.* / remote.connect` 进 broker 公开 `host.call`
族；SSH 供给器迁出为官方能力等价插件（ADR-0069 第 8 节分发策略、无特权 CI
检查）；删除宿主内置实现；开发者文档把它写成「新领域功能插件」范例。

**验收：** 插件版供给器功能与内置版等价（对照测试）；第三方按公开 SDK 可
复刻替代供给器（样例仓库验证）；ADR-0069 无特权检查通过。

## Risks

- **SSH 环境多样性。** 远端 shell、权限、发行版差异使探测/投递脚本易碎；
  以「探测脚本输出结构化 JSON + 每步幂等可重试」控制，Windows 远端明确
  列为非目标（首版仅 Linux/macOS 远端）。
- **隧道稳定性。** 网络抖动导致隧道断开；自动重建 + durable attach 缓解，
  重建期间 UI 呈现「重连中」而不是错误堆积。
- **版本偏斜。** 客户端升级快于远端；兼容窗口 + 明确的升级提示 + 一键升级
  缓解；协商失败时拒绝连接并解释，不静默降级到不可用状态。
- **远端资源占用。** Agent 与 worktree 在服务器上消耗真实资源；供给器不做
  资源管理承诺，但停止/卸载动作必须彻底（进程、隧道、pidfile 清理干净）。
- **多客户端并发。** 多设备连接同一远端 Host 的语义由 ADR-0033 所有权模型
  与设备配对承担，本 ADR 不新增并发语义。

## Relationship to prior ADRs

- **建立在 ADR-0033 之上**：共享 Application Core、BackendTransport、Server
  Profile、窗口绑定、断连三动作、远程 P0 边界全部沿用；本 ADR 只新增 `ssh`
  供给类型与配套管线。
- **建立在 ADR-0054 之上**：VibeX Server 发行物、Host 家族版本、Workstation
  客户端等级、「插件内核只活在数据目录 Host 上」沿用；供给器投递的就是
  ADR-0054 定义的 Server 目录形态。
- **扩展 ADR-0059**：新增 `ssh-tunnel` 客户端本地 Reachability kind 与「经
  SSH exec 的邀请投递」；一次性 secret、凭据存储、名单权威性原则不变。
- **呼应 ADR-0060**：SSH 认证使用用户系统环境，VibeX 不代管密钥。
- **姊妹于 ADR-0069**：确认「工作区搬远端」是 L0 核心路线而非插件路线；
  同时把 SSH 供给器规划为阶段二官方插件，成为其「新领域功能插件」试金石；
  `remote.*` host.call 族补入 0069 的宿主数据 API 面盘点。
- **不修订** ADR-0056（chat channel 远程访问）、ADR-0061（本机安全基线，
  远端 Server 同样适用其精神）。

## Considered options

- **SSH 作为数据面协议（命令走 SSH exec / SFTP）。** 否决。等于第二套应用
  协议，绕过 remote-protocol 的版本化、订阅与 capabilities 机制；SSH 只做
  供给、隧道与信任引导。
- **VS Code 式扩展分裂（UI 插件本地跑、workspace 插件远端跑）。** 否决。
  ADR-0054 已定插件内核只活在数据目录 Host 上；分裂执行面会制造两套插件
  语义，与 ADR-0069 单一接管面冲突。远程窗口中的插件 UI 呈现按 capabilities
  逐步开放即可。
- **文件同步/镜像模式（本地跑 Host，rsync/watch 远端代码）。** 否决。双向
  同步的冲突语义与 worktree 隔离、事件溯源历史不可调和；Agent 必须贴着
  真实工作区运行。
- **要求远端预装 Docker 或 systemd。** 否决为硬依赖。发行物已是自包含目录；
  Docker 与 systemd unit 作为可选路径提供，不设为门槛。
- **在 Server Profile 表单接收管理员 token 或私钥。** 否决（沿用 ADR-0059 对
  长期口令进表单的否决；私钥归系统 SSH 管理）。
- **供给器从一开始就做成插件。** 否决。`remote_desktop_*` 未进公开 broker
  面、ADR-0069 Batch 2/4 底层未交付前，插件形态缺乏立足设施；两阶段路径
  既保 P0 进度又兑现「一切皆插件」承诺。
