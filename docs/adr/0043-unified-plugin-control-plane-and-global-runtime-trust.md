---
status: superseded by ADR-0046
date: 2026-08-11
decision-makers:
  - VibeX maintainers
---

# 统一插件控制面、可移植 Skill 与全局 Runtime 信任

VibeX 采用一个统一 Plugin control plane 管理 VibeX、Codex 与 Claude Code
插件。控制面统一发现、导入、启停、更新、诊断与卸载体验，但不夺取原生生态的内容
权威：Codex 与 Claude Code 插件仍由各自原生插件位置持有，VibeX 保存可追溯引用并
通过可靠原生适配器投影状态。此决定取代 ADR-0030。

## Portable Plugin

VibeX Portable Plugin 以 `.vibex-plugin/plugin.json` 为声明入口，至少包含一个
Skill。省略 Skill 列表时自动发现 `skills/*/SKILL.md`；未知字段保留并警告，单个
可选贡献无效只使该贡献不可用。Runtime、MCP、PluginAction 与 Plugin Command 都是
Skill 的配套贡献，不是 Agent 专属安装物。

同一源目录可以同时包含 VibeX、Codex 与 Claude Code manifests，控制面只展示一个
源包并以格式徽标展示各生态投影。插件 ID 是控制面的唯一身份；同一 ID 只能保留一个
源包，冲突时用户选择保留或替换。普通导入保存稳定快照；链接开发模式持续引用用户
目录且永不删除该目录。原生插件从 VibeX 导入时先进入对应 Agent 的原生插件位置，
VibeX 侧引用保持只读。

## Agent 投影与调用

新导入插件默认禁用。首次启用默认向所有支持 Skill 的已安装 Agent 建立 binding，
并为尚未安装的 Agent 保存待应用意图；用户可以取消个别 Agent。Skill 优先以带
VibeX provenance 的只读软链接投影到 Agent 原生 Skill 目录，不支持链接时使用受控
副本，永不覆盖用户同名 Skill。

PluginAction 与 Plugin Command 共享同一 Invocation definition。Composer 输入 `/`
后允许同名 Plugin Command、Skill 与 Agent Command 并存，分别显示“插件”“技能”
“原生”来源，选择结果保存结构化来源身份，任何来源都不能静默覆盖另一来源。

插件内置 MCP 默认可为全部支持的 Agent 启用，也允许用户进入 MCP 设置选择具体
Agent；原生 Agent 配置仍是权威。Codex/Claude 原生 hooks、MCP 与其他可执行贡献的
信任委托对应原生机制，不能由 VibeX 的 shell 信任替代。

## 用户全局 Runtime

Plugin Runtime 安装到普通终端与 Agent 均可发现的用户级全局环境，不使用 VibeX
私有受管目录，也不为每个 Agent 重复安装。首批声明式来源包括 existing command、
Binary/Archive、npm global、pipx、cargo install、stdio/HTTP MCP；其他系统包管理器
可以使用 shell fallback。默认不得自动请求管理员权限。

每个 Runtime 必须声明命令入口与 probe。安装退出码不能证明就绪；只有从普通 Agent
环境重新解析命令、验证版本并通过 probe 后才形成 Runtime installation lock。未在
manifest 声明的 Skill 前置 CLI 不阻止导入，但标记为未知外部前置条件，不参与自动
安装、冲突分析与 readiness。

同名 Runtime 版本冲突时，VibeX 显示当前版本、目标版本、受影响插件以及将失效的
Automation。用户确认后可以在存在 in-flight Turn 时直接覆盖，不保留旧 Runtime
版本，并级联删除所有依赖旧版本的插件。VibeX 插件删除 membership、bindings、Skill
投影、受管快照与 shell trust；链接开发插件不删除用户目录；原生插件必须经可靠原生
适配器完整卸载，否则阻止整个替换。Artifact、Conversation、Automation 与操作审计
保留，Automation 标记为引用不可用。

卸载普通插件不删除全局 Runtime。Runtime inventory 独立展示实际路径、版本、来源、
probe 与引用插件，清理永远是单独的手动破坏性操作。

## Shell 信任

Portable Plugin 可以声明任意 Shell installer recipe。首次执行前必须展示来源、命令
和用户权限代码执行风险，并按 Plugin ID 创建持续 trust grant。此后同一 ID 即使换
来源、未签名或脚本内容改变，VibeX 也可在安装、手动更新或修复流程中直接执行，不再
逐次确认；替换同 ID 源包继承信任，卸载插件或用户撤销时终止信任。启用插件本身不
创建信任，也不在首版引入后台自动更新。

Shell 使用经过清理、不含 VibeX 或 Agent 凭据的环境运行，记录命令摘要、退出状态与
受影响插件。任意 shell 可能修改 VibeX 所有权外的文件，VibeX 不承诺完整回滚或卸载；
卸载 shell 永远需要新的破坏性确认。

## 原生生命周期与 Host 所有权

每个 Codex/Claude 适配器显式声明 discover、install、enable、update、uninstall
能力。缺少可靠接口的操作降级为只读或打开原生入口，禁止猜测配置格式。原生目录的
外部变化经 reconciliation 如实投影，VibeX 不依据旧状态静默恢复。

插件、Runtime、Skill 投影、原生 Agent 配置与 shell 均属于当前 Server Profile 的
VibeX Host。远程界面操作作用于 Host；只有本机桌面或具备服务器管理权限的设备可以
创建、替换或撤销 shell trust grant。

## Consequences

- 当前 Office 专用 catalog、安装与设置接口必须被通用控制面替换，Office 迁移为普通
  built-in Portable Plugin。
- 当前严格 `vibex-plugin/v2`、`deny_unknown_fields`、精确平台分发和私有托管目录
  语义被替换为宽容 authoring manifest、全局解析结果与独立 runtime inventory。
- Plugin ID 成为持续任意代码信任锚，且全局 Runtime 覆盖可以在运行中级联删除插件；
  UI 必须准确展示这些已接受风险，不能使用弱化文案。
- 原生插件能力取决于可验证适配器，统一控制面不等于所有生态具有相同生命周期能力。
- PluginAction、Automation、Composer commands、Skill hosting 与 MCP 配置必须消费同一
  Plugin control plane，而不是继续维护 Office 或入口专用目录。
