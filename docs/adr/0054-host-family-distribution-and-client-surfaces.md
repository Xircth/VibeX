---
status: accepted
date: 2026-08-17
decision-makers:
  - VibeX maintainers
---

# Host 家族分发与三种客户端表面

VibeX 只发行一个执行面：**VibeX Host**。手机 App、IM 渠道、其它桌面 VibeX
都连接这个 Host。本机桌面可以自己就是 Host，也可以作为工作站客户端连接另一
个 Host。插件内核只活在拥有该数据目录的 Host 上。

本决定补充
[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)
的多端模型，并把 P0 的 Developer Device 升级为可配对的客户端等级。Apple
Developer ID 与 Windows Authenticode 不是本阶段发行门槛；updater 签名与
SHA-256 校验仍然需要。

## 拓扑

同一数据目录同一时刻只有一个 Host。Host 可以是 VibeX.app 或 `vibex-server`。
Agent、Git worktree、Automation、Plugin Worker、官方 MCP 和 Chat channel
适配器都在 Host 上运行。

```text
手机 Companion ──┐
IM Channel ──────┤
其它桌面 Workstation ┤── Remote Protocol / Chat channel ── VibeX Host
本机桌面 ────────┘         （Desktop 或 vibex-server）
```

打开本机 VibeX.app 时，该进程就是 Local Host。只有需要被其它设备连接或无头
常驻时，才打开远程监听或改跑 `vibex-server`。本机日常使用不强制 sidecar。
同一数据目录被 `vibex-server` 占用时，本机桌面只能作为客户端连接，不能再
启动第二份 Host。

## 发行物

一次产品版本同时产出同一 semver 家族：

| 产物 | 形态 | 内容 |
| --- | --- | --- |
| VibeX Desktop | `.dmg` / NSIS / `.msi` / `.AppImage` / `.deb` | 壳 + Host + 前端 + `vibex-mcp` + 官方插件快照 |
| VibeX Server | 跨平台目录 / 可选 Docker | `vibex-server`、`vibex-mcp`、`web/`、`plugins/bundled/` |
| VibeX Companion | Android APK，后续 iOS | 薄客户端，不跑 Agent 或插件 |

不单独发行 MCP 安装器、插件守护进程、第二套 Web 管理台或 IM 客户端。

Server 目录形状：

```text
vibex-server
vibex-mcp
web/
plugins/bundled/
```

安装助手只下载写明的版本，并先验 SHA-256；若本机构有 minisign 私钥则同时
发布 `.sig`。没有 Apple / Windows 代码签名证书时，仍可发布上述 Server 产物
与未公证的桌面安装包。官方 Releases 必须标明签名状态。

## 客户端表面

配对时选择 **Device permission preset**。预设只组织 scopes，鉴权仍认细粒度
scope。新增 scope 不得自动进入旧预设。

### 本机控制台

安装并运行 Host 的那台机器。不经配对，可改监听、TLS、token、设备列表、
备份恢复，以及安装任意插件与 Agent。

### Workstation Device

其它电脑上的 VibeX.app。近乎全接管 Host 上的工作：Project / Workspace /
Conversation / Turn / 文件读写 / Git 写 / 终端 / Workflow / Automation /
使用并启用已安装插件。不接管 Host 运维：监听与公网暴露、管理员 token、
撤销他人设备、备份恢复、升级 Host 二进制。CEF 与本机 Office 自动化留在
Host 机器，远程通过 capabilities 与 preview proxy 使用，不在客户端再跑
一套 runtime。

Workstation 的 scope 集合是 `DEVICE_SCOPES` 加上 `application.call` 与
`plugin.write`，减去一切 Host 管理 scope。

### Companion Device

手机薄客户端。允许会话读写、审批、取消、纠偏、只读 Artifact、离线缓存
和终态通知摘要。不允许插件写入、Workflow/Automation 写入、终端或 Git 写。

### Chat Channel

不是 Paired device。Telegram / 飞书 / 微信等通道配置在 Host 上，只接受
授权发送者的入站命令，并投递无 secret 摘要。VibeX 不发行这些 IM 的客户端。

## 插件绑定

Plugin Kernel、Worker、App surface、Runtime lock 与 Activation Generation
只属于当前 Host。远程 Workstation 通过 Application Core 调用插件命令，
改变的是 Host 事实。Companion 与 Channel 没有插件管理 scope。

官方产品插件随 Host 物化到数据目录。第三方 `.vxp` 也只装到这个 Host。

## 远程协议

非 IM 入口共用 Remote Protocol。配对 secret 五分钟、一次兑换；长期
device credential 进入系统凭据存储或 Android Keystore。默认 loopback；
LAN / 公网必须二次确认，TLS 终止放在外部反代。

桌面与 Server 必须同版本家族。Companion 可以旧一个次版本，靠
capabilities 协商。缺 scope 或 capability 时 fail-closed。

## Consequences

- `CreatePairingRequest` 携带可选 `preset`；有预设时 scopes 由预设展开。
- 现有无预设、显式 scopes 的配对请求保持有效，但仍须是该设备等级允许的子集。
- P0 文档中的 Developer Device 被 Workstation 取代，不再作为默认远程桌面预设。
- Chat channel 适配器属于 Host，随 `vibex-server` 一起运行。
- 本阶段不把缺少 Apple / Windows 身份证书当作发布失败。

## Considered Options

- **本机也强制独立 `vibex-server` sidecar。** 否决。增加端口、配对和双进程，
  却不改变 Local Profile 语义。
- **把 IM 做成第四种 Paired device。** 否决。IM 没有设备凭据存储，授权发送者
  已能表达入站信任。
- **远程桌面复制 Host 到客户端。** 否决。双数据目录破坏 Automation lease 与
  插件 generation。
