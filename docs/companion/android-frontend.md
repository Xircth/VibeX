# Companion Android 前端

**状态：** 决策完成。  
**日期：** 2026-08-18。  
**实现仓：** `~/Projects/vibex-remote-android`  
**能力面：** ADR-0054 Companion。事件折叠见 [host-events.md](./host-events.md)。

本文是产品 UI 规格，不是 Material 默认皮肤说明。信息架构参考
[CodeG Android](https://github.com/xintaofei/codeg-android) 的「多档案 +
会话列表 + 时间线」，不复制它的五栏全控制台（Folders / Git 写 / MCP / 设置改服务器）。

## 1. 对象与一句话

- **对象：** 离开键盘的 Host 主人。
- **一句话：** 看清 Agent 在本机干什么，并在它卡住时拍板。
- **不是：** 缩小版 VibeX 桌面，也不是 CodeG 的远程管理台。

## 2. 视觉方向

桌面 VibeX 是 Tahoe 玻璃；手机上玻璃会脏、会晃。Companion 做成 **夜班台面仪器**：
不透明内容、一条信号、序列当骨架。

**为什么不是那三种套版：** 不用米白衬线、不用黑底酸绿、不用报纸细线通栏。
和桌面的亲缘在 **Plex 字族 + 冷静蓝**，不在毛玻璃。

### 2.1 色板

| Token | Hex | 用途 |
|---|---|---|
| Ink | `#12161C` | 夜间底、强文字反白时的墨 |
| Paper | `#F3F5F7` | 日间内容底（不透明） |
| Panel | `#ECEFF2` / `#1B212A` | 列表与卡片 |
| Signal | `#3F6CC4` | 在线、主按钮、焦点（与桌面 primary 同源） |
| Hold | `#D48A2A` | 待你处理（权限 / 提问） |
| Stop | `#C43C3C` | 失败、撤销、中断 |
| Quiet | `#6B7380` | 次要说明 |

日夜间跟随系统。内容层始终不透明。连接条可以轻微饱和，不做整页渐变。

### 2.2 字体

- **正文 / 标题：** IBM Plex Sans（与桌面 IBM Plex Mono 同族）。
- **序列、origin、agent id：** IBM Plex Mono。
- **不要**用 Inter / Roboto 当品牌脸。系统 CJK 回退：PingFang SC / Noto Sans SC。

字阶：显示标题 22/28 semibold；页标题 17/24 semibold；正文 15/22；说明 13/18；
mono 12/18。

### 2.3 布局

单列。底栏三处，不多于 CodeG 的五栏。

```text
┌─────────────────────────┐
│ ● 在线 · 书房的 Mac     │  ← 信号条（签名）
├─────────────────────────┤
│  会话列表 / 时间线      │
│  ▌消息与工具行          │  ← 序列轨：行左缘一条 2dp
│                         │
├─────────────────────────┤
│  会话     待办     Host │
└─────────────────────────┘
```

宽屏（≥720dp）用左轨 + 内容，仍是这三个去处，不要突然长出「文件夹 / 设置改 MCP」。

### 2.4 签名

**信号条 + 序列轨。** 顶栏始终说出 Host 名和连接态，不用 toast 当主状态。
时间线每行左侧一条细轨，颜色随行：在途 Signal、待办 Hold、终态 Quiet、失败 Stop。
这是「你在看一台正在跑的机器」，不是聊天壁纸。

### 2.5 动效

只做两处：信号条在 recovering 时缓慢呼吸；新时间线行从轨上长出 120ms。
尊重 reduce-motion：两者都改瞬切。不要全页粒子、不要骨架屏闪烁循环。

## 3. 信息架构（对照 CodeG）

| CodeG | Companion | 原因 |
|---|---|---|
| Onboarding → URL + Token | 扫配对邀请；手填是退路 | ADR-0059 |
| Servers 下拉 | Host 档案，按 Host 身份合并 | 不是一条 baseUrl |
| Chats | **会话** | 主路径 |
| Folders + Git 写 | 无 | 无 Git 写 scope |
| Activity 轮询 | **待办**（权限/提问/阻塞） | 手机最要拍板的面 |
| Search 独立 Tab | 会话页顶搜索 | 少一栏 |
| Settings 改 MCP/Agent/通道 | **Host 页**只含本地：外观、持续监控、忘记 Host | 运维在本机控制台 |

底栏：**会话 / 待办 / Host**。待办角标 = 未处理 permission + question +
`turn_blocked`。

## 4. 屏幕

### 4.1 未配对

一屏：短句「连接到你的 VibeX」、主按钮「扫描邀请」、次按钮「手动输入」。
不要功能卖点列表。

### 4.2 扫描 / 手动

- 扫描 `vibex-pairing:`。无效码：「这不是 VibeX 邀请」。
- 手动：origin + pairing token。无「管理员 token」栏。
- 兑换中、过期、scope 超出 Companion：各一句原因 + 「请在电脑上再出示邀请」。

已持有该 Host 身份：合并 Reachability，成功文案「已更新地址」，不当新档案。

### 4.3 会话列表

- 标题、Agent、最后活动、在途点、待办点。
- 顶：搜索；「新会话」（online 才亮）。
- 空：online 则「新会话」；offline 则「上次同步 · 只读」。
- 信号条点开：当前 origin、试探过的名单、再扫邀请、断开（不断开配对）。

### 4.4 新会话

只读目录：Project / Workspace / 就绪 Agent（见 host-events §6）。
无工作区若 Host 允许，单独一项。提交走 `create` + `operation_id`。

### 4.5 时间线

- 用户气泡、助手正文、折叠思考、工具卡、计划、子会话卡、队列/纠偏条。
- 权限/提问：卡片内直接批、拒、作答；同时进待办。
- Composer：跟进；在途且能力允许则纠偏，否则排队。取消只对在途。
- 只读：文件变更摘要、Artifact、终端摘要。点开 diff/内容，没有提交/推送。
- 中断 Turn：说明须手点重试；不自动重发。
- 未知事件：一行「Host 更新了此会话」。

### 4.6 待办

跨会话的「要你拍板」：权限、提问、认证阻塞。点进时间线对应行。
空：「没有等待你的请求」。

### 4.7 Host 页

- 档案列表：名、Host 身份短号、连接态、最后成功 origin。
- 当前档案：忘记 Host（可达则先撤销）、再扫邀请。
- 本机：深浅色、持续监控（前台服务）开关。
- **没有** Agent 安装、MCP、Chat 通道、Git 账号、监听端口。

## 5. 连接态文案

| 状态 | 信号条 | 写操作 |
|---|---|---|
| connecting | 正在连接 | 禁 |
| online | 在线 · {档案名} | 允许 |
| recovering | 正在恢复 | 禁 |
| offline | 离线 · 上次同步 {时间} | 禁 |
| auth_required | 需要重新配对 | 禁 |
| incompatible | 版本不兼容 | 禁 |

全部 origin 失败：列出尝试结果，主按钮「再扫描邀请」，次按钮「打开 Host」。

## 6. 文案规则

- 用户词：邀请、配对、在线、待办、忘记。不用 webhook、scope、sequence、bind。
- 按钮说结果：「允许」「拒绝」「发送」「取消这一轮」「忘记这台 Host」。
- 错误说原因和下一步，不道歉。
- 中英随系统；专有名 VibeX、Host、Agent 不译。

## 7. 无障碍与平台

- minSdk 与现有 `mobile/android` 对齐，不低于 26。
- 触控目标 ≥ 48dp；信号条与待办可 TalkBack。
- 相机权限只在扫码时要；拒绝则走手动。
- `usesCleartextTraffic` 仅因局域网 HTTP；凭证进 Keystore，backup=false。
- 旋转、进程被杀、网络切换：档案与 sequence checkpoint 仍在。

## 8. 验收

- 扫一份邀请能进会话列表，无需先贴 token。
- 待办能批掉一张权限，桌面同一请求消失。
- 关 Host：列表只读，时间线不丢，发送不可用。
- 再出示邀请（已配对）：地址更新，不出现第二个档案。
- 没有入口能改 MCP、Git 远程或监听。
