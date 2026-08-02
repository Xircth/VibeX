# VibeX 平台能力扩展总计划

> 状态：`approved-for-implementation`；公共 seam 与验收于 2026-07-31
> 由维护者确认，实施与发布收口按本目录任务执行。
>
> 日期：2026-07-29
>
> 参考基线：Codeg `549add8d3ba07f31464c9cddde8ba7a7478eed14`

本规格把四项已确认的产品决策落成一个依赖有序的实施计划：

1. 插件升级为“托管工具依赖 + Skill + 提示词/快捷工作流 + Artifact Provider”；
2. 多 Agent 按 Codeg 的 MCP companion + Delegation Broker 方式补齐，Mention 使用 `&`；
3. 自动化按 Codeg 的完整运行语义重建，并强化设置页；
4. Web 按共享 Application Core + Transport + Server 落地；移动端暂不开发，但协议先准备。

## 文档

- [需求与验收](requirements.md)
- [架构与 TDD 策略](design.md)
- [纵向实施任务](tasks.md)

对应 ADR：

- [ADR-0030：插件绑定托管工具、Skill、工作流与 Artifact Provider](../../adr/0030-plugins-bind-managed-tools-skills-and-workflows.md)
- [ADR-0031：异步多 Agent 委派与 `&Agent` Mention](../../adr/0031-llm-mediated-delegation-and-ampersand-agent-mentions.md)
- [ADR-0032：自动化重放版本化 TurnLaunchSpec](../../adr/0032-automations-replay-versioned-turn-launch-specs.md)
- [ADR-0033：共享 Application Core 与版本化远程传输](../../adr/0033-shared-application-core-and-versioned-remote-transport.md)

## 实施原则

- 功能与验收行为优先，不以保留当前表结构、command 或模块位置为目标。
- 每个切片先通过公共接口写一个失败测试，再写最小实现；禁止“先写全部测试，再写全部
  实现”的水平切分。
- 允许复用 Codeg 的 Apache-2.0 代码，但每次复用必须记录源 commit/文件、保留归属、
  标明修改，并通过 VibeX 自己的测试证明行为。
- Conversation 事件日志仍是 Turn 的唯一权威；缓存、AutomationRun、WebSocket
  subscription 和 UI store 都是可协调或可重建的派生状态。
- 安装、启用、运行、认证和健康状态分离；任何自动安装都必须来自声明式、版本锁定、
  可校验的依赖。
- 桌面优先交付，但新协议不得假定 Tauri、绝对本机路径或永久在线 WebSocket。

## 依赖主线

```text
协议/测试缝
   ├─ 插件 v2 → 工具安装 → Artifact Provider → Office 内置插件
   ├─ Delegation parity → &Mention → 多 Agent E2E
   └─ TurnLaunchSpec → Automation Engine v2
                         │
Application Core / BackendTransport
                         ↓
               vibex-server / Web UI
                         ↓
              移动端协议准备（不做 App）
```

插件、Delegation 后端和 TurnLaunchSpec 可以在公共契约确定后并行；Web Server 必须等待
Application Core/Transport 基础，Automation UI 必须等待 TurnLaunchSpec 稳定。完整依赖
与任务编号见 [tasks.md](tasks.md)。
