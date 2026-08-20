# Host Reachability 与配对客户端

**状态：** 决策完成；待按切片落地。

**日期：** 2026-08-18。

**决策依据：**

- [ADR-0059：客户端按 Host 身份与 Reachability 名单连接](../adr/0059-host-identity-and-pairing-invitation.md)
- [ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md)
- [ADR-0056](../adr/0056-chat-channel-and-remote-access-codeg-parity.md)
- [ADR-0033](../adr/0033-shared-application-core-and-versioned-remote-transport.md)
- [ADR-0041](../adr/0041-native-kotlin-compose-android-companion.md)

Companion / Workstation 的能力接管面不在本文重开，以 ADR-0054 与
`CONTEXT.md` 为准。本文规定：**本机控制台如何让 Host 被找到**，以及
**Companion / Workstation 如何第一次连上并保持连上**。

事件消费见 [docs/companion/host-events.md](../companion/host-events.md)。
Android UI 见 [docs/companion/android-frontend.md](../companion/android-frontend.md)。
产品仓：`~/Projects/vibex-remote-android`。

## 1. 完成标准

用户能走完且不靠说明书补洞：

1. 本机打开监听后，选局域网和/或一种远程发布，出示**一份**配对邀请。
2. 手机扫码即成为 Companion；其它电脑或浏览器粘贴同一原文即成为 Workstation。
3. 同一 Host 身份在客户端合并为**一个** Server Profile、一份离线缓存。
4. 家里走局域网、出门走已发布的 FRP / Tailscale / Cloudflare，客户端自动试，
   不必改档案、不必换凭证。
5. 后加远程穿透时，在外的已配对设备再扫/贴一次邀请只更新 Reachability，
   不当新设备。
6. 关掉发布或检查失败后，权威名单不再包含那条远程 origin。

「设置页能开但手机连不上」不算完成。

## 2. 拓扑

```text
本机控制台（Host 进程上的运维面）
        │  监听 127.0.0.1:17891
        │  发布 Reachability
        │  出示配对邀请
        ▼
   VibeX Host ── Remote Protocol ──┬── Companion（Android，随后 iOS）
                                   ├── Workstation（其它电脑 VibeX.app）
                                   └── Workstation（浏览器打开 web/）

Reachability 只改变如何打到 Host，不改变 preset。
Agent / Git / 插件只活在 Host 上。
```

| 表面 | 是什么 | 不是什么 |
|---|---|---|
| 本机控制台 | 跑 Host 的那台机器上的设置：监听、发布、邀请、撤设备、token | Paired device |
| Companion | 手机薄客户端 | 小桌面、ACP 客户端、Git/终端/插件写 |
| Workstation | 远程编码闭环，像 VS Code Remote | Host 运维面、管理员 token 入口 |

IM 通道仍不是 Paired device（ADR-0056）。

## 3. 对照 CodeG 移动端（刻意不抄）

[codeg-android](https://github.com/xintaofei/codeg-android) /
[codeg-ios](https://github.com/xintaofei/codeg-ios) 的主路径是：Name + URL +
长期 `CODEG_TOKEN` → Test → Save。Android 无扫码；iOS 只扫到 URL，token 仍手贴。
一个档案一条 `baseUrl`。App 是全功能远程控制台（设置、MCP、Git 写）。
WS 重连由会话页承担，无配对、无设备撤销、无推送。

VibeX 只吸收「多档案 + 扫一下进 Host」，并补上他们缺的：短时邀请、Host 身份、
多 Reachability、按 preset 收能力、检查失败从名单撤下。

## 4. 本机控制台：让 Host 被找到

入口仍是设置里现有的 Web 服务页，语义改为：**让这台 Host 被 Companion 和
Workstation 连上**。先保证 `127.0.0.1:17891` 在跑，再谈谁能打到它。

### 4.1 局域网

1. 打开「允许局域网」（真实改 bind，二次确认，ADR-0056）。
2. 探测非 loopback 地址列入 Reachability。
3. 不强迫用户「选一个 IP」。

### 4.2 远程发布

用户可同时开局域网和一种或多种远程发布。向导问的是名单里有什么，不是互斥模式。

**Tailscale / Cloudflare Tunnel**

- 表单只收已发布的 origin（`https://…` 优先）。
- 能探则探；探不到允许保存，状态为未验证。
- VibeX 不代配官方 App / `cloudflared`。

**FRP**

1. 填公网 IP 或域名、对外端口。
2. 部署方式：**命令行默认**，Docker 次选。
3. 给出可审查的 `frps` 命令（钉版本与 SHA-256，token/端口写进命令）。
   禁止 `curl | bash`。
4. 用户到自己的云服务器执行，回来点「检查连接」。
5. 检查顺序：**先在 Host 拉起托管的 `frpc`（本机 17891 → 该服务器）**，再探
   公网 origin（`/health` 或 `/api/v1/capabilities`）。
6. 控制口通而公网不通：提示「服务器在、本机隧道未通」或安全组/端口，
   不说一句「失败」。
7. 成功才把该 origin 写入权威名单。关闭发布则停 `frpc`，并从名单移除；
   不远程卸载用户服务器上的 `frps`。

TLS：公网 HTTP 可以发布，出示邀请前用确认框写明明文风险。有 HTTPS 时邀请
与首选试探只用 `https://`。证书、域名、云安全组仍是用户的云。

远程名单里至少有一条 origin 时，默认请求系统保持唤醒，可关；关闭时说清
手机会掉线。局域网不必默认保活。

### 4.3 权威名单

| 来源 | 进名单条件 | 离开名单 |
|---|---|---|
| 局域网地址 | 当前探测到、非 loopback | 网卡消失或关闭「允许局域网」 |
| FRP / Tailscale / CF | 最近一次检查成功，或用户保存的未验证 origin（CF/TS 探不到时） | 检查失败、用户关闭发布 |

`127.0.0.1` 永不进入邀请或客户端试探列表。

## 5. 配对邀请

一种邀请，两种出示：QR 给手机，原文给桌面/浏览器。

```text
vibex-pairing:1
  host_id
  preset            companion | workstation
  expires_at
  pairing_id
  pairing_token     仅未配对设备兑换；已配对忽略
  reachability[]    origin + kind（lan | frp | tailscale | cloudflare）
```

长期 `vbx_device_`、管理员 token 不得出现。Host 身份不是秘密。

| 客户端状态 | 行为 |
|---|---|
| 未配对、secret 有效 | 向邀请中可及的 origin 兑 secret，按 Host 身份建档案 |
| 未配对、secret 过期 | 失败，请本机控制台再出示 |
| 已有该 `host_id` 的凭证 | 合并 Reachability，不兑换、不换设备 |
| 手填退路 | origin + pairing token，禁止管理员 token |

本机控制台在新发布一条远程 Reachability 后提示：在外的设备再扫/贴一次即可
更新名单。

## 6. Companion App

Android 先做，iOS 同一流（ADR-0041 / ADR-0059）。产品流不是 CodeG 克隆。

**加 Host**

- 空状态：扫邀请。
- 无相机 / 过期 / 从截图加第二台：手填 origin + pairing token。
- 兑换后：Keystore 存 device credential；档案只存 Host 身份、名字、
  Reachability、最后成功 origin。
- 拒绝任何超出 Companion allowlist 的 scope。

**连上之后**

- 按 ADR-0054 Companion 表面工作。
- Durable attach：ready → snapshot/replay → high-water → live。
- 连接态：connecting / online / recovering / offline / auth_required /
  incompatible。非 online 禁用写。
- 试探顺序：上次成功 → 远程 HTTPS → 其余。全部失败：列尝试过的 origin，
  提供「再扫邀请更新地址」和 Forget server。
- Host 在线时拉 Reachability 权威名单并合并。
- 无 Host：只读离线缓存。P1 无 FCM；持续监控需用户显式开前台服务。

**多 Host**

- 多个 Server Profile，一次只用一个（与桌面 Server-bound window 同语义）。
- 切换档案不混会话。Forget server：可达则先撤本设备。

## 7. Workstation（其它电脑与浏览器）

- 同一份邀请，`preset=workstation`。
- VibeX.app：粘贴邀请为主，有相机可扫。打开 **Server-bound window** 绑该
  Host 身份。
- 浏览器：打开任一已发布 origin 的 `web/`，用邀请兑换 Workstation，
  token 只留在内存，不把管理员 token 当主路径。
- 能力面 = Remote coding loop（文件、Git 写、终端、Workflow、Automation、
  已装插件）。本机控制台入口在远程 UI 隐藏且 server 用 scope fail-closed。
- Reachability / 重连 / Host 身份合并与 Companion 相同。

本机正在跑 Host 的那台电脑继续用 Local Profile，不经配对。

## 8. 失败态（必须可恢复）

| 现象 | 用户看到 | 下一步 |
|---|---|---|
| 未开监听 | 服务未启动 | 打开监听 |
| 局域网开了但列表空 | 没有可及地址 | 检查网卡 / 关 VPN |
| FRP 检查：控制口超时 | 服务器不可达 | 放行控制口与安全组 |
| FRP 检查：控制口通、公网 502 | 本机隧道未通 | 确认 Host 在线、frpc 已起 |
| 公网 HTTP 出邀请 | 确认框：流量明文 | 确认或改 HTTPS |
| 邀请过期且未配对 | 邀请已过期 | 再出示 |
| 凭证被撤 | 认证失效 | 再配对 |
| 协议主版本不符 | 版本不兼容 | 升级客户端或 Host |
| 电脑睡眠 | 离线；若用户关过保活则点明 | 唤醒或打开保活 |
| 全部 origin 失败 | 列尝试结果 | 再扫邀请或回到局域网 |

## 9. 协议与实现增量

相对今天的 Remote Protocol / Android 壳：

1. 数据目录稳定 `host_id`；兑换响应与 `GET /api/v1/capabilities` 回传。
2. 只读 Reachability 面（可并进 capabilities）：当前权威名单。
3. 邀请 DTO 与 `vibex-pairing:1` payload；生成端不再出「无 origin 的配对码」
   和「只有 loopback 的地址码」两张分裂码。
4. 本机控制台：局域网探测、三种远程发布、FRP 命令生成、托管 `frpc`、
   真探测、保活、邀请出示。
5. Companion：扫码/粘贴、Keystore、档案按 `host_id` 合并、多 origin 试探、
   durable WS、Forget。
6. 远程桌面与浏览器：同一邀请兑换 Workstation。
7. 测试：QR/粘贴不得含长期凭证；可含 `https://` origin。Agent K 旧断言作废。

钉死的 FRP 发行物走与 Agent 安装相同的校验和策略。不引入 VibeX 云中继。

## 10. 切片

**S1 — 邀请可扫通**  
`host_id` + 邀请含当前探测到的局域网 origin；Android 扫码或手填兑 Companion；
废两张码。局域网闭环先通。信号条 + 会话列表空态可用。

**S2 — 远程发布**  
FRP（命令行 + 本机 `frpc` + 检查）与 Tailscale/CF 表单；HTTP 确认框；保活；
权威名单增删。

**S3 — 多 Reachability 稳定**  
上线拉名单；已配对合并邀请中的 origin；试探顺序；失败列出尝试。

**S4 — Workstation**  
桌面/浏览器粘贴邀请；Server-bound window；scope fail-closed。

**S5 — iOS**  
同一邀请与档案语义，独立原生 UI。

每片验收：对应完成标准中的一条用户路径，加上上表里该片触及的失败态。

## 11. 不做

- 手机或远程桌面讲 ACP。
- Companion 复制 CodeG 的设置 / MCP / Git 写。
- 管理员 token 作为 App 或浏览器的主登录。
- VibeX 官方 frps / Tailscale tailnet / 云中继。
- 默认 Funnel 或未确认的公网暴露。
- 远程 Workstation 管理监听、配对他人、升级 Host。
- P1 的 FCM / APNs。
- 为 iOS 另做一套「贴长期 token」的连接模型。
