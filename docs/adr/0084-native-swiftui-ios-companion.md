---
status: accepted
date: 2026-11-06
decision-makers:
  - VibeX maintainers
---

# iOS Mobile Companion 采用原生 Swift 与 SwiftUI

iOS 是第二个 Mobile companion，使用原生 Swift 与 SwiftUI，最低 iOS 17，首发经
TestFlight 内测。它与 Android 共享版本化 Remote Protocol schema、稳定 ID 与跨平台协议验收，
不共享 UI、导航和平台生命周期代码。落实 [ADR-0041](0041-native-kotlin-compose-android-companion.md)
对后续 iOS 客户端的约定，并取代 ADR-0033 中“iOS 不属于 P1”的范围边界；P1 的
Android 交付门槛不变。

## Consequences

- 工程位于 `mobile/ios`：`CompanionCore` Swift Package 承载配对与协议客户端，可用
  `swift test` 验证；App 壳层使用 SwiftUI，依赖 `CompanionCore`。
- 协议模型唯一来源是 `docs/protocol/v1/generated/swift/RemoteProtocolModels.swift`，
  包内以符号链接引用，不得手写或复制第二份。
- iOS 与 Android 一样只做观察、沟通和决策：不在手机上运行 Agent、Git 或插件，配对只接受
  `companion` 预设内的 scope。
- 设备凭据存入 Keychain；iOS 专属 UI 状态不得进入 Remote Protocol，也不得要求 Server 提供
  专属端点。
- 后台完成通知所需的摘要沿用 `notification.summary`；协议目前不连接 APNs，推送通道需另立 ADR。
- 功能范围与 Android P1 对等，分期交付见
  [iOS Companion 交付计划](../plans/2026-11-06-ios-companion.md)。

## Considered Options

- Flutter / React Native / Kotlin Multiplatform：否决。会把平台生命周期、凭据与通知差异带入
  客户端，且没有已验证的复用收益，与 ADR-0041 的取舍一致。
- 仅文档立项、不建工程：否决。配对核心依赖已生成的 Swift 模型，可立即落地并验证。
