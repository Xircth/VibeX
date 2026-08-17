---
status: accepted
date: 2026-08-17
decision-makers:
  - VibeX maintainers
---

# 聊天通道与远程访问对标 CodeG 的完整产品闭环

VibeX 的聊天通道和远程访问必须达到与 CodeG 同等的端到端可用性，并在
安全默认值、Host 绑定和设备模型上超过它。半套命令、假 LAN 开关、只读
token 或「设置页能开但手机连不上」都不算完成。

本决定落实 [ADR-0054](0054-host-family-distribution-and-client-surfaces.md)
与 [ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)，
不把 IM 做成 Paired device，也不再保留平行的薄 REST Web 服务作为产品面。

## 对标边界

CodeG 的完成标准是用户能走完这两条路：

1. **IM：** 加通道 → 连接成功 → 在 Telegram / 飞书 / 微信里选目录和
   Agent、发任务、跟进、批准权限、取消，并收到回合/错误/提问通知。
2. **远程：** 打开监听 → 看到可达地址和二维码 → 浏览器打开同一套 UI，
   或手机用 URL + 凭据接入并工作。

VibeX 必须走出同样的路，并保留这些超过 CodeG 的点：

- 授权发送者 fail-closed；空名单禁用入站。
- 默认 loopback；局域网必须二次确认，TLS 仍在外部。
- 远程鉴权是 Host 管理员 token + 可撤销 device credential，不是长期共享口令一种模型。
- 入站适配器属于 Host，`vibex-server` 与桌面同一套循环。
- 继续支持 QQ OneBot 与通用 Webhook 通道。

## 聊天通道

通道仍不是设备。配置、密钥、适配器、命令分发只属于当前 Host。

### 命令面

授权发送者可以使用与 CodeG 同等的工作闭环。前缀可配置。已选会话上，
非前缀文本视为 follow-up。

| 命令 | 作用 |
| --- | --- |
| `folder [n\|name]` | 列出/选择 Project。无参时 Telegram 发 inline 按钮。 |
| `agent [n\|id]` | 列出/选择 Host 上可用 Agent。 |
| `task \| do <text>` | 在已选 Project/会话上启动 Turn；可新建会话。 |
| `sessions` | 最近会话。 |
| `resume [n\|id]` | 绑定已有会话并继续。 |
| `cancel` | 取消在途 Turn。 |
| `approve [always]` | 答复待决权限。 |
| `deny` | 拒绝待决权限。 |
| `search <keyword>` | 按标题搜索会话。 |
| `today` | 当日会话汇总。 |
| `status` | 通道连接状态。 |
| `help \| start \| ping` | 命令说明与存活探测。 |

权限与提问推送到 IM 后，授权发送者的答复必须走与桌面相同的
Application Core 入口，互斥消解同一请求。

### 连接与渠道

每个已启用通道有真实连接态：`disconnected` / `connecting` /
`connected` / `error`。设置页可以手动连接、断开、测试发送。
状态变化推到前端。

渠道：

- Telegram：long-poll；可选 Topic 模式（论坛超群一题一会话，总题忽略纯文本）。
- 飞书：Lark protobuf WebSocket，群内需 @ 机器人才入站。
- QQ：OneBot 11 WebSocket + HTTP 回发。
- 微信：企业微信群机器人（只出站）与 iLink 扫码机器人（可收可发）两种模式，不再把二者混成一个 Webhook Key。
- 通用 Webhook：出站事件汇点。

每日摘要按通道配置的本地时刻发送。事件过滤器继续存在；另支持独立
HTTP Webhook 汇点。提示词默认不外发。IM 文案至少中英，可在设置中切换。

## 远程访问

设置页「Web 服务」的用户含义是：**让这台 Host 被浏览器、Workstation、
Companion 连上。** 它启动的是 Remote Protocol 的 `ServerRuntime`，并托管
与 Host 家族相同的 `web/` 前端。不再提供第二套业务 REST 作为产品入口。

- 默认端口 `3080`，与 `vibex-server` / Host 家族一致。
- 默认绑定 loopback。打开「允许局域网」后才绑定 `0.0.0.0`，并列出本机
  可达地址。开关必须改变真实监听，不能只改配置。
- 启动时解析或轮换 Host 管理员 token（`SqliteTokenHashStore`）。设置页
  可显示/隐藏、复制、重新生成；新 token 只在生成时完整可见。
- 浏览器打开选中地址即加载前端。配对二维码使用 Workstation 或 Companion
  预设，不再写死两个 read scope。桌面本机设置页也必须能创建配对。
- 端口占用在停止后自动探测并横幅提示。配置自动保存。

## 不做

- 不把 IM 注册为 Paired device。
- 不默认 `allow_origin(Any)`，不默认公网暴露。
- 不为了对标而复制 CodeG 的平行 command 路由表。
- 本阶段仍不要求 Apple / Windows 身份签名。

## Consequences

- 桌面 `start_inbound_manager` 的平行入站循环删除；只保留 Host
  `start_chat_inbound`。
- 桌面 `start_web_server` 必须按 `allow_lan` 绑定，并注入 `static_root`
  与已供给的 Host token。
- 旧薄 REST router 不再作为启动路径。
- CONTEXT 补充 Topic 模式、iLink 模式与远程访问地址展示。
