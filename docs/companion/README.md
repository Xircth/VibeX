# Companion 与配对客户端

本目录是 **VibeX Companion / Workstation 连接与事件消费** 的产品文档。
能力接管面以 [ADR-0054](../adr/0054-host-family-distribution-and-client-surfaces.md)
为准，不再平行定义。

| 文档 | 内容 |
|---|---|
| [连接方案](../plans/2026-08-18-host-reachability-and-paired-clients.md) | Reachability、配对邀请、本机控制台、失败态、切片 |
| [Host 事件](./host-events.md) | Conversation 事件权威、WS attach、Companion 折叠、写命令 |
| [Android 前端](./android-frontend.md) | Companion App 信息架构、视觉、文案、屏幕 |
| [ADR-0059](../adr/0059-host-identity-and-pairing-invitation.md) | Host 身份与配对邀请 |
| [Remote Protocol v1](../protocol/v1/README.md) | 版本化 HTTP / WS 契约 |

Android 产品仓在 `~/Projects/vibex-remote-android`。协议与 ADR 以本仓库为准；
该仓只实现 Companion 客户端。
