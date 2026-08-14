---
status: accepted
date: 2026-08-13
decision-makers:
  - VibeX maintainers
---

# VibeX Plugin 采用全信任执行模型

## Context

ADR-0044 以开放任意第三方 Marketplace 为目标，设计了 Sandboxed Worker、Capability
Broker scope、Trusted Native 二次授权、受限 App iframe 与更新时 permission delta。
该模型让最小完整插件同时承担多平台 OS sandbox、权限 UI、授权迁移、scope 校验和 Runtime
授权，显著拖慢 SDK、扩展点与真实插件体验的成熟。

VibeX 当前的产品目标是本地开发者主动安装的 IDE 类插件生态。其信任假设与 VS Code、bb
等桌面开发工具更接近：插件作者代码是安装物的一部分，安装行为本身就是信任决定。用户已
明确选择优先完成能力、开发体验与产品完整性，暂不建设恶意插件安全边界。

## Decision

1. VibeX Plugin Package 采用单一 **Full Trust** 模型。安装或启用包即允许其 Worker、App
   和声明 Runtime 使用与 VibeX Host 相同的本机文件、网络、环境变量与进程能力。
2. 产品界面不展示逐 capability 审批、scope、permission delta 或 Trusted Native 弹窗。
   manifest 中既有 `permissions` 只作为旧 v4 包的兼容元数据与 Host API 使用说明，不产生
   运行门禁；新包可以完全省略。
3. Worker 继续运行在独立 Node 进程，但目的仅是 candidate-first 热更新、超时终止、崩溃
   隔离与 dispose。Host 不再使用 Seatbelt、bubblewrap、Node Permission Model、环境清空或
   Windows fail-closed sandbox。
4. App surface 继续使用独立 frame 与版本化 bridge 管理 mount/revoke/generation，但不使用
   CSP、opaque origin 或 Permissions Policy 限制插件代码。frame 是 UI 生命周期容器，不是
   安全边界。
5. Host RPC 的 contribution identity、handler registration、generation 与协议校验继续存在；
   它们保证 API 正确性和原子生命周期，不代表限制插件的本机权限。
6. Runtime 仍使用内容寻址、精确 lock、probe、candidate readiness 和 generation drain。这些
   是可复现性与可靠性机制，不是用户权限审批。
7. 包 digest、publisher identity、原子更新、失败保留旧代、rollback 与审计继续保留。完整性
   证据用于诊断与可复现更新，不将来源安全包装成权限门禁。

## Consequences

- 插件作者无需设计 capability scope、授权迁移或 Trusted Native recipe，CLI `dev`、linked
  reload 与普通启用使用同一条直接路径。
- Windows、macOS 与 Linux 共享同一种 Worker 启动模型，不再因缺少 OS sandbox 拒绝插件。
- 插件可以读取用户文件、凭据并启动任意程序。VibeX 必须在安装来源和文档中诚实标明这是
  全信任生态，不能声称第三方插件被隔离。
- 未来若产品转向不受信任 Marketplace，必须通过新的 ADR 引入不同 package class 或独立
  sandbox runtime；不得在当前 full-trust API 上悄悄恢复零散权限弹窗。

## Superseded parts of ADR-0044

本 ADR 取代 ADR-0044 第 2 节中的“manifest 是权限上界”、第 5 节 trust tiers、第 6 节
permission grant、App sandbox 要求、测试 harness 的真实 sandbox 要求，以及相应迁移和
Consequences。ADR-0044 的统一产品包、Contribution Registry、candidate generation、Runtime、
SDK、Office reference plugin 与 Application Core seam 继续有效。
