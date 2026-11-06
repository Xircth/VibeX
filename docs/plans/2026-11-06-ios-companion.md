# iOS Companion 交付计划

| 字段 | 值 |
|---|---|
| 状态 | Draft |
| 日期 | 2026-11-06 |
| 产品身份 | Mobile companion：观察、沟通、拍板；不是 Workstation |
| 平台 | iOS 17+，Swift + SwiftUI，TestFlight 内测 |
| 相关 ADR | ADR-0033、ADR-0041、ADR-0054、ADR-0059、ADR-0084 |
| 功能对标 | [Android Companion 优化计划](2026-09-08-android-companion-improvement.md) 与 ADR-0033 的 Android P1 能力清单 |

信息架构、视觉语言与文案沿用 Android 计划，iOS 只替换平台实现；本计划不另立产品定义。

## 现状

- `mobile/ios/CompanionCore` 已提供 `HostOrigin`、`CompanionScopes`、`PairingClient`，与
  `mobile/android/companion-core` 行为一致，并带单元测试。
- Android 端本身仅有配对骨架，P1 能力清单是共同目标而非已有实现；两端并行补齐。

## 分期

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 | `CompanionCore` 配对客户端、Scope allowlist、协议版本协商 | `swift test` 通过 |
| M1 | Xcode App 壳层、Keychain 凭据存储、多 Server Profile、扫码/粘贴配对、设备状态与 Forget server | 模拟器配对真实 Host |
| M2 | Project/Workspace 选择、Conversation 列表与搜索、时间线 | 与 Host 事件 fixture 对齐 |
| M3 | WebSocket attach、durable replay、`after_sequence` 续传、未知事件容忍、只读离线缓存 | 协议验收套件 |
| M4 | 创建/追问/取消/重试 Turn、权限审批、结构化问题响应 | 真机端到端 |
| M5 | 文件内容、Diff、Git 状态只读查看 | 真机端到端 |
| M6 | 无障碍、本地化、TestFlight 构建与内测发布 | 内测清单 |

## 前置条件与风险

- App 壳层、模拟器与 TestFlight 需要完整 Xcode 与 Apple Developer 账号；仅有 Command Line
  Tools 的环境只能验证 `CompanionCore`。
- 后台完成通知需要 APNs 或本地轮询方案，协议当前不连接 APNs，需另立 ADR 后再进入 M4。
- 与 Android 共用的跨平台协议验收套件尚未落地，M3 前需要建立。
