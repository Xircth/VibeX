---
status: accepted
date: 2026-08-18
decision-makers:
  - VibeX maintainers
---

# 客户端按 Host 身份与 Reachability 名单连接

Paired device 用稳定 **Host 身份** 识别一台 Host，用 Host 权威的
**Reachability** 名单找到它。本机控制台出示一份 **配对邀请**：Host 身份、
设备权限预设、当前全部非 loopback Reachability，以及仅供未配对设备兑换的
五分钟一次性 secret。长期 device credential 不得进入邀请、QR 或 URL。

这修正 Agent K / P0.1「配对 QR 不得含 Server URL、客户端手填 origin」的字面
验收。那条规则要防的是长期口令进码，不是防可达地址。CodeG 式「URL QR +
手贴 `CODEG_TOKEN`」和「一个档案一条 baseUrl」明确否决。

本决定补充
[ADR-0033](0033-shared-application-core-and-versioned-remote-transport.md)、
[ADR-0054](0054-host-family-distribution-and-client-surfaces.md) 与
[ADR-0056](0056-chat-channel-and-remote-access-codeg-parity.md)。
Companion / Workstation 的能力面仍以 ADR-0054 为准；浏览器走 Workstation
配对，不是管理员 token。本机控制台仍是唯一运维面。

## 行为

- 一个 Server Profile 对应一个 Host 身份，可同时有多条 Reachability。
- 远程 origin 只有「检查连接」成功才进入权威名单；失败或关闭发布即移除。
  局域网地址是探测结果。`127.0.0.1` 永不进入邀请。
- 未配对设备兑换 secret。已持有该 Host 身份凭证的设备只合并 Reachability，
  不重新兑换；secret 过期后仍可从新出示的邀请收下 origin。
- 客户端按「上次成功 → 远程 HTTPS → 其余」尝试。Host 在线时刷新名单。
- 公网 HTTP 允许，出示邀请前必须确认明文风险。远程发布默认请求保持唤醒。
- 手机扫邀请，其它电脑与浏览器粘贴同一原文。禁止在客户端粘贴管理员 token。

## Considered Options

- **维持手填 origin + 无 URL 的配对 QR。** 否决。做不到扫一次就连，出门后
  无法带上已发布的远程 origin。
- **一个档案一条 URL，换网重配对。** 否决。这是 CodeG 的摩擦来源。
- **VibeX 云中继或把 Tailscale/FRP 做成官方托管。** 否决。与 ADR-0033 的
  P1 边界冲突；隧道所有权留在用户。
- **远程 Workstation 复制本机控制台。** 否决。运维面只留在 Host。

## Consequences

- `PairingChallenge` / 邀请 payload 增加 Host 身份与 Reachability 列表；
  兑换与 `capabilities` 必须回传同一 Host 身份。
- 配对与地址不再是两张码。现有「QR 不得含 http(s)」测试改为「不得含
  `vbx_device_` / 管理员 token」。
- Android Companion 与远程桌面/浏览器消费同一邀请格式。
- 穿透（FRP / Tailscale / Cloudflare）只是 Reachability 的发布方式，
  不改变 Remote Protocol 或设备预设。
