---
status: accepted
date: 2026-08-17
decision-makers:
  - VibeX maintainers
---

# 官方产品 MCP 随 Host 分发、由官方插件激活

> 官方**插件包**不再 builtin 预装，见
> [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md)。
> 官方 MCP **二进制**仍随 Host 分发；未安装或未启用对应插件时不得注入会话。

> 2026-08-17：多智能体协同与会话增强拆成两个插件、两套 MCP，见
> [ADR-0057](0057-session-enhance-and-multi-agent-plugins.md)。
> 本决定中「官方 MCP 由官方插件激活、默认禁用、只影响新 session」仍然有效。

`vibex-mcp` 与 `vibex-workflow-mcp` 是 VibeX 官方产品 MCP。它们作为 Host 家族
的原生文件随桌面和 Server 发行，但只有对应官方插件启用后才注入 Agent session。

本决定落实 Plugin Kernel 对产品 MCP 的托管边界：官方 MCP 随 Host 分发，
由官方插件激活，并保持两条 MCP 产品身份分离。见
[ADR-0046](0046-full-stack-plugin-platform-and-isolated-sdk.md)。

## Decision

### 1. 原生存在

Host 包始终带上官方 MCP 字节：

- `vibex-mcp` 与 Host 可执行文件同目录，沿用现有 sibling / `VIBEX_MCP_BIN` 定位。
- `vibex-workflow-mcp` 作为 `vibex.workflow-creator` 的 managed Runtime，由
  Host 解析，不依赖用户 PATH。

用户不必单独下载或启动这两个进程。

### 2. 插件是唯一生效开关

| 产品 | 官方插件 | MCP | 生效条件 |
| --- | --- | --- | --- |
| 多智能体协同 | `vibex.collaboration` | `vibex-mcp` | 插件 Enabled，且 Agent 广告 `session/new.mcp_servers` |
| 工作流开发 | `vibex.workflow-creator` | `vibex-workflow-mcp` | 同上，且 Agent binding 包含该 Agent |

磁盘上有二进制不等于已注入。插件禁用、未导入或 Activation Generation 未发布时，
Host 不得把对应 MCP 写入 `session/new`，设置页也不得显示为已配置。

启用之后只影响**新的** Agent session。已有 session 不能热挂 STDIO MCP，Host
提示重建会话。

### 3. 两条产品，两个 identity

不得把 Workflow 工具并入 `vibex-mcp`。Delegation Broker 与 listener 可以随
Host 常驻；没有协作插件时 companion 不会被注入，Broker 不会被 Agent 打到。

`vibex.collaboration` 是随 Host 分发的 builtin 插件，默认 Disabled。它提供
协同 Skill 与 MCP 激活门，不要求 Worker。原生 Studio 与 Workflow Core 仍不
依赖 `vibex.workflow-creator`；禁用该插件不删除源文件、版本、Automation 或
Run。

### 4. Host 注入连接上下文

官方 MCP 由 Host 按 session 启动。Host 注入短期 token、Workspace 与 plugin
generation。插件不得持久保存 Server URL、管理员 token 或 device credential。

`DelegationInjector` 是同步、非阻塞的。官方 MCP 门是进程内原子开关，由
Plugin control plane 在导入、启用、禁用和启动恢复时更新。

## Consequences

- 桌面与 Server 在安装 injector 前必须已有 Plugin control plane，并在 builtin
  导入后同步门状态。
- `vibex.collaboration` 进入 `assets/plugins/`，走与 Office 相同的 materialize /
  import 路径。
- companion 注入新增稳定失败码 `official_product_mcp_disabled`。
- 本决定取代“平台几乎总是注入 `vibex-mcp`”的隐含行为。

## Considered Options

- **继续把 `vibex-mcp` 当无门控平台能力。** 否决。用户无法独立关闭协同而不
  伤害 Host。
- **把两个 MCP 合成一个二进制。** 否决。产品生命周期与工具目录会绑死。
- **让用户单独安装 MCP 服务。** 否决。没有 Host socket 与短期 token，进程
  没有产品语义。
