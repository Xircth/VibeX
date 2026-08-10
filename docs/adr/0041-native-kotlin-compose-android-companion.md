---
status: accepted
date: 2026-08-09
decision-makers:
  - VibeX maintainers
---

# Android Mobile Companion 采用原生 Kotlin 与 Jetpack Compose

P1 的首个移动客户端使用原生 Kotlin 与 Jetpack Compose，而不为尚未进入交付范围的
iOS 提前引入跨平台 UI。VibeX 在移动端之间共享版本化 Remote Protocol schema、生成
模型、事件 fixture 与兼容性验收，不把 UI、导航和平台生命周期抽象成共享运行时。

## Consequences

- Android 凭据、Keystore、生命周期、后台连接、通知与无障碍能力直接使用平台 API；
- Kotlin 客户端不得重新手写与 Rust schema 并行的协议权威；
- Android 专属 UI 状态不得进入 Remote Protocol 或要求 Server 提供专属端点；
- 后续 iOS 客户端独立选择原生技术并复用同一协议与跨平台验收套件，不要求复用
  Android UI 代码。

## Considered Options

- Kotlin Multiplatform 或其它跨平台 UI：本阶段否决。iOS 不属于 P1，提前共享 UI 会把
  平台生命周期、凭据和通知差异引入首个客户端，而没有已验证的复用收益。
