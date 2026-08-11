# OpenAI Plugin、Claude Code Plugin 与 VibeX Plugin 对比调研

> 调研日期：2026-08-11  
> 资料口径：OpenAI、Anthropic 官方文档，以及 VibeX 仓库内 ADR、实现与交付说明。外部结论不使用二手资料。

## 核心结论

三者都使用“Plugin”一词，但并不是同一种扩展协议：

这里的 **OpenAI Plugin 是用户链接所指的当前体系**：以
`.codex-plugin/plugin.json`、`SKILL.md` 与 MCP 为核心。它不是早期以
`ai-plugin.json` 和 REST OpenAPI 描述为核心的旧版 ChatGPT Plugin。

- **OpenAI Plugin** 是 ChatGPT 与 Codex 共享的**能力发现、安装和发布单元**。核心组成是 Skill 与可选 MCP server；UI 和用户认证属于 MCP 集成。公开插件进入两产品共享的统一目录，并经过 OpenAI 提交审核。
- **Claude Code Plugin** 是 Claude Code 的**本地开发代理扩展包**。除 Skill 和 MCP 外，还能携带 subagent、hook、LSP、workflow、monitor、output style、theme、可执行文件等，能以用户权限执行本地代码；分发以官方、社区或自建 marketplace 为中心。
- **VibeX Plugin v2** 是 VibeX 自己定义的**受治理工作流与本地工具能力包**。它把精确版本工具、跨 Agent Skill、结构化 `PluginAction` 和 Artifact 生成/预览生命周期绑在一起，强调本地工具供应链可复现和 fail-closed。它不是 OpenAI 或 Claude manifest 的实现。

最重要的产品边界是：**VibeX 已有通用 Plugin v2 内核，但当前用户可见产品只交付了内置 VibeX Office；第三方插件市场、通用导入/安装入口尚未交付。** 因而不能把 `ManifestSource::External` 这一内部类型解释成已经存在的第三方生态。

## 核心比较表

| 维度       | OpenAI Plugin                                                                                                                       | Claude Code Plugin                                                                                                             | VibeX Plugin v2                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 定义       | ChatGPT/Codex 可发现、安装、分享和发布的能力包                                                                                      | 扩展 Claude Code 的自包含组件目录                                                                                              | VibeX 可发现、启用、审计的托管工具、Skill、工作流与 Artifact 能力集合                                                               |
| 主要宿主   | ChatGPT 与 Codex；同一公开目录，但能力可因 surface 不同                                                                             | Claude Code CLI、IDE/桌面相关界面及 Agent SDK 场景                                                                             | VibeX 桌面/Server 的 Composer、Conversation、Automation、Artifact runtime                                                           |
| 必需入口   | `.codex-plugin/plugin.json` 必需                                                                                                    | `.claude-plugin/plugin.json` 可选；默认目录可自动发现                                                                          | JSON 中 `$schema: "vibex-plugin/v2"` 必需；当前由宿主导入，不是约定目录包                                                           |
| 核心能力   | Skill、MCP server；MCP 可返回结构化结果和可选 UI；Codex 可加载 hook                                                                 | Skill、agent、hook、MCP、LSP、workflow、monitor、output style、theme、channel、依赖等                                          | `ToolDependency`、Skill 声明、结构化 `PluginAction`、可选 console、Artifact intent；Provider 为宿主已知类型                         |
| 运行模型   | Skill 按匹配加载；生产 MCP 通常是稳定 HTTPS/Streamable HTTP 服务；Codex 也支持包内 `.mcp.json` 启动本地 server；UI 在隔离 iframe 中 | 本机进程模型更重：启用后可自动启动 MCP/LSP，hook 响应事件，monitor 常驻；也支持远程 MCP                                        | VibeX 下载并校验本地二进制，生成 `ToolInstallationLock`，Provider 只接收已解析绝对路径；Action 在发送/运行前重新校验 readiness      |
| UI         | UI 属于 MCP server resource，不属于独立插件前端；优先 MCP Apps 标准，ChatGPT 可加扩展                                               | manifest 没有通用自定义 widget/app UI 原语；主要通过终端/IDE 插件管理界面、MCP 工具、theme/output style 扩展体验               | 可选本地 console；Artifact preview 是租约化能力。不是 MCP Apps UI                                                                   |
| 认证       | 用户级私有数据/写操作应使用符合 MCP 授权规范的 OAuth 2.1；OpenAI host 作为客户端，支持 PKCE、CIMD/DCR 等                            | 远程 MCP 支持 OAuth 2.0、CIMD/DCR、预配置 client、动态 header；`userConfig` 的敏感项进 keychain/credentials 文件               | Plugin v2 manifest 目前没有通用 OAuth 模型；工具分发 URL 必须无凭据，Agent/Provider 凭据属于其他受控边界                            |
| 分发       | 公开插件经 portal 审核后进入 ChatGPT/Codex 统一目录；另有 repo、personal、workspace marketplace/分享                                | 官方 marketplace、自动验证与安全筛查的社区 marketplace，以及任意受信 Git/GitHub/npm/archive/local marketplace                  | ADR 定义内置与第三方走同一管线，但当前生产产品仅导入内置 Office，无通用 marketplace/导入 UI                                         |
| 安装与缓存 | 本地 marketplace 插件复制到 `~/.codex/plugins/cache/...`；可逐个启停；npm 安装不运行 lifecycle scripts                              | 安装到版本化 `~/.claude/plugins/cache`；user/project/local/managed scope；支持 reload、自动更新、依赖和持久 data 目录          | 工具进入 VibeX 托管版本目录；精确版本、目标平台、URL、SHA-256、绝对执行路径和时间写入 lock，升级验证后原子切换                      |
| 权限与安全 | MCP 工具审批策略；插件 hook 安装/启用不等于信任，须单独审核；公开提交要求身份/域名验证、隐私与条款、测试、tool annotations          | 官方明确警告插件可用用户权限执行任意代码；依赖 workspace trust、工具权限、sandbox、MCP approval 和管理员 marketplace allowlist | manifest 未知字段拒绝；未知 Provider 拒绝；任意 `install_command` 被淘汰；工具执行前强制哈希校验；PluginAction 最终发送前由用户确认 |
| 生命周期   | 安装/启用、MCP 连接与 OAuth、hook trust 分离；远程 MCP 服务可独立更新                                                               | 安装、启用、session reload、自动更新、旧版本缓存清理、MCP/LSP/monitor session 生命周期均有明确语义                             | membership、activation、dependency、skill、provider readiness 分离；安装、Provider/preview lease 与 Action/Turn 生命周期分离        |
| 可移植性   | Skill 与 MCP 是主要开放接缝；hook 有 Codex 专属语义                                                                                 | Skill 与 MCP 可复用；agent/LSP/monitor/theme 等为 Claude Code 专属                                                             | Skill 内容可适配复用；ToolDependency、PluginAction、Artifact intent/provider 为 VibeX 专属                                          |

OpenAI 架构与包结构见 [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)、[Package your plugin](https://developers.openai.com/plugins/build/plugins)；Claude Code 的完整组件和 manifest 见 [Create plugins](https://code.claude.com/docs/en/plugins) 与 [Plugins reference](https://code.claude.com/docs/en/plugins-reference)。VibeX 的目标定义见 [ADR-0030](../adr/0030-plugins-bind-managed-tools-skills-and-workflows.md)，当前 schema 见 [`crates/plugins/src/manifest.rs`](../../crates/plugins/src/manifest.rs)。

## 关键差异详解

### 1. OpenAI 把 Plugin 设计成跨产品分发单元

OpenAI Plugin 的稳定身份由 `.codex-plugin/plugin.json` 提供。包根可含 `skills/`、`.mcp.json`、`.app.json`、`hooks/` 和 assets；`interface` 保存安装面展示信息。`.app.json` 只是已注册 MCP 连接的兼容映射，底层原语仍是 MCP。[Package your plugin](https://developers.openai.com/plugins/build/plugins)

它的最小形态可以只有 Skill，也可以只有 MCP，或二者结合。Skill 负责“何时、按什么步骤完成工作流”；MCP 负责实时数据、认证授权和受控动作。[Skills](https://developers.openai.com/plugins/concepts/skills)、[MCP server](https://developers.openai.com/plugins/concepts/mcp-server)

公开发布不是简单上传目录：提交方需具备组织权限和验证身份；MCP 插件还要提交生产 URL、验证域名、声明工具读写/开放世界/破坏性 hints、准备正反测试和政策材料。发布后才进入 ChatGPT/Codex 共享目录。[Submit plugins](https://developers.openai.com/plugins/deploy/submission)

### 2. Claude Code 把 Plugin 设计成代理运行时扩展包

Claude Code Plugin 的能力面更接近编辑器/开发工具扩展：除 Skill/MCP 外，可以定义 subagent、生命周期 hook、LSP、workflow、后台 monitor、输出风格、theme、channel 和 `bin/` 可执行文件。manifest 只有 `name` 在存在时必需；没有 manifest 时也能从默认目录发现组件。[Plugins reference](https://code.claude.com/docs/en/plugins-reference)

这带来更强的本机自动化，也扩大了信任边界。Claude Code 官方文档明确说明插件和 marketplace 是高信任组件，能够以用户权限执行任意代码；安装前应审核来源和组件。项目范围插件还受 workspace trust、MCP server approval 和权限配置约束。[Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)、[Security](https://code.claude.com/docs/en/security)

它的分发是 marketplace 联邦，而不是只有一个全球目录。官方 marketplace 自动可用；社区 marketplace 的第三方插件经过自动验证与安全筛查并固定 commit SHA；组织或个人也可发布自建 marketplace。插件源支持 Git commit pin、npm，以及可选 SHA-256 的 HTTPS archive。[Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

### 3. VibeX 把 Plugin 设计成宿主管理的工作流产品能力

VibeX 的专属价值不在于“又一个 Skill 文件夹”，而在于把四件事纳入同一领域模型：

1. 精确版本、确定平台、强制 SHA-256 的本地工具分发；
2. 可同步到不同 Agent 的 Skill；
3. Composer 与 Automation 共用的结构化 `PluginAction`；
4. Artifact intent、Provider、预览 lease 与产生证据。

VibeX 不信任 manifest 自称 `builtin`；membership 来自导入来源。manifest 使用 `deny_unknown_fields`，Artifact Provider 必须同时是声明工具且属于宿主 known-provider allowlist。[`manifest.rs`](../../crates/plugins/src/manifest.rs)、[`service.rs`](../../crates/plugins/src/service.rs)

这与 Claude 的“插件可带任意本地代码”形成明显对照：ADR-0030 明确禁止任意 `install_command`，第三方无代码 manifest 只能引用 VibeX 已知 Provider 类型；原生第三方 Provider 代码被留给未来签名扩展体系。[ADR-0030](../adr/0030-plugins-bind-managed-tools-skills-and-workflows.md)

## VibeX 当前实现边界

必须把“目标架构/已存在内核”与“已经交付的第三方产品生态”分开：

- `PluginService::import_manifest` 能区分 `Bundled`、`External` 与 `LegacyMigration`，说明内核为外部来源预留了模型；但生产代码只在 `office-runtime` 中以 `ManifestSource::Bundled` 导入 Office manifest。[`crates/plugins/src/manifest.rs`](../../crates/plugins/src/manifest.rs)、[`crates/office-runtime/src/lib.rs`](../../crates/office-runtime/src/lib.rs)
- 当前前端 API 直接暴露 `installOffice`、`setOfficeEnabled` 等 Office 专用操作，设置页也只渲染一个 Office catalog，而非通用插件目录。[`frontend/src/lib/api/plugins.ts`](../../frontend/src/lib/api/plugins.ts)、[`PluginsSettings.tsx`](../../frontend/src/pages/settings/PluginsSettings.tsx)
- 当前已经交付的是 Plugin v2 manifest 解析、托管 Tool Runtime、readiness 分层、Office Skill/Action/Artifact 工作流；没有第三方 marketplace、包下载/导入 UI、发布者身份、签名信任链或通用 OAuth 接入产品面。[Plugin v2 delivery](../plugin-v2-tool-runtime-delivery.md)

因此当前准确表述应是：**“VibeX 已有面向托管工作流的 Plugin v2 内核，并以 VibeX Office 验证；第三方插件生态尚未交付。”**

## 迁移与兼容建议

### 可以直接或低成本复用

- **Skill 内容**：三者都以 `SKILL.md` 为核心工作流载体。可共享正文、references、templates 和多数 assets，但应分别校验 frontmatter、工具名、触发规则和路径变量。
- **远程 MCP server**：这是 OpenAI 与 Claude Code 之间最强的可移植接缝。认证元数据、工具 schema 和无 UI 的结构化结果最容易复用；不同宿主的 transport、OAuth client、tool approval 和 UI 能力仍需测试。
- **部分 hook 资产**：OpenAI Codex 为兼容现有 hook 设置了 `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`，但不能据此推断完整 Claude hook 事件和行为都可移植。[OpenAI packaging](https://developers.openai.com/plugins/build/plugins)

### 不能直接兼容

- `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 与 `vibex-plugin/v2` 是三套 schema，不能只改文件名。
- Claude 的 agent、LSP、monitor、theme/output style/channel 没有对应的 OpenAI Plugin 或 VibeX Plugin 原语。
- OpenAI MCP Apps UI 不能直接映射为 Claude Plugin UI，也不能直接映射为 VibeX Artifact preview。
- VibeX `ToolDependency` 必须有精确版本、按平台分发和 SHA-256；Claude 插件中对 PATH、`npx`、hook 安装依赖或任意 shell 的依赖不能原样导入。
- VibeX `PluginAction`、Artifact intent 和 Provider lease 在另外两套 manifest 中没有等价物，需要显式适配。

### 建议的兼容层

不要把 VibeX manifest 改造成 OpenAI 或 Claude manifest 的超集。更稳妥的方向是保留 VibeX 领域模型，并建立显式 adapter：

1. 导入前识别 source ecosystem 和版本；
2. 只转换可证明等价的 Skill 与 MCP 元数据；
3. 对本地二进制重新生成 VibeX `ToolDependency`，要求精确分发与哈希，绝不继承任意安装脚本；
4. 将不可映射的 agent/hook/LSP/UI/Artifact 能力列成诊断，不静默丢失；
5. 只有 VibeX 已知 Provider 才能绑定 Artifact intent；
6. UI 文案使用“VibeX Plugin v2 / 托管工作流插件”，不要暗示兼容 OpenAI Plugin 或 Claude Code Plugin。

若希望一个源码仓库同时服务 OpenAI 与 Claude Code，可以在根目录共存两份 manifest，并共享 `skills/`、MCP 实现和部分 assets；但应分别运行两边验证器并独立发布。官方文档没有承诺“一份 manifest 跨宿主安装”。VibeX 若加入导入能力，应把这种仓库视为多目标源码包，而不是统一运行时包。

OpenAI 的本地 marketplace 能读取旧兼容路径
`$REPO_ROOT/.claude-plugin/marketplace.json`，Codex hook 也会额外设置
`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` 兼容变量；这些是迁移接缝，不能
推导出包级兼容。OpenAI 仍要求插件本体使用 `.codex-plugin/plugin.json`，而
Claude Code 使用自己的 `.claude-plugin/plugin.json` 与组件语义。

## 官方来源

### OpenAI

- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Skills](https://developers.openai.com/plugins/concepts/skills)
- [MCP server](https://developers.openai.com/plugins/concepts/mcp-server)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Authentication](https://developers.openai.com/plugins/build/auth)
- [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Security & Privacy](https://developers.openai.com/plugins/guides/security-privacy)
- [Submit plugins](https://developers.openai.com/plugins/deploy/submission)

### Anthropic

- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Security](https://code.claude.com/docs/en/security)

### VibeX

- [ADR-0030：插件统一绑定托管工具、Skill、提示词工作流与 Artifact Provider](../adr/0030-plugins-bind-managed-tools-skills-and-workflows.md)
- [Plugin v2 and Tool Runtime delivery](../plugin-v2-tool-runtime-delivery.md)
- [`crates/plugins/src/manifest.rs`](../../crates/plugins/src/manifest.rs)
- [`crates/plugins/src/service.rs`](../../crates/plugins/src/service.rs)
- [`frontend/src/lib/api/plugins.ts`](../../frontend/src/lib/api/plugins.ts)
- [`frontend/src/pages/settings/PluginsSettings.tsx`](../../frontend/src/pages/settings/PluginsSettings.tsx)
