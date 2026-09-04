---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Qoder 以检测优先接入为一等 Agent，Onboarding 的 Agent 位只列真能跑的

Qoder CLI 原生实现 ACP，具备接入 VibeX 的全部条件。本 ADR 把它加入
`AgentKind`，并规定在没有可锁定分发物的情况下走「检测优先、托管安装延后」的
接入形态。

本决定不改变 [ADR-0002](0002-single-agent-identity-enum.md) 的单一身份枚举，也不
放宽 [ADR-0060](0060-agent-installs-use-user-environment.md) 对安装位置的约束。

## Context

`frontend/src/components/onboarding/hero/EquationLine.tsx` 的四个轮播位语义不同：

- `SLOT_A` 是**用户现在用的 IDE**（Cursor / Trae / Qoder / VS Code / JetBrains）。
- `SLOT_B` 是**VibeX 能跑的 Agent**（13 个内置档案里的 12 个）。

Qoder 目前是 `SLOT_A` 里 `kind: 'mark'` 的一条，用 `EquationIcons` 的通用字形
渲染。这本身没有谎报——它说的是「你从 Qoder 过来」，不是「VibeX 能跑 Qoder」。
问题是**能力缺口**而非诚实性缺口：Qoder CLI 已经原生支持 ACP，VibeX 却接不了它。

Qoder CLI 的接入条件（来自 `docs.qoder.com/cli/acp` 与 Zed ACP agent 页）：

- 以 `--acp` 参数启动即为 ACP server，走 stdio。
- 支持内置工具、Subagent、MCP（stdio/SSE/Streamable HTTP）、权限配置、上下文
  压缩、多模态图片；文件与终端操作走 ACP 交给客户端。这几项正好覆盖 VibeX 依赖
  的 ACP 面。
- 鉴权有两条路：CLI 内 `/login`（浏览器或 PAT），或 `QODER_PERSONAL_ACCESS_TOKEN`
  环境变量；环境变量优先于已登录状态。

阻塞点只有一个：Qoder 官方安装方式是 `curl -fsSL https://qoder.com/install | bash`
的引导脚本，**没有发布逐架构的产物直链与摘要**。VibeX 的 `ProfileInstallSource::Binary`
要求 `url` + `sha256` 逐三元组锁定（见 `cursor_profile()`），Qoder 现在给不了。

另有两处事实待实测确认，不得凭文档写死：

1. 可执行名。Qoder 官方 ACP 文档给的是 `command: "qoder"`，Zed 页面写
   `qoder acp`，阿里云 Model Studio 文档里安装后验证的是 `qodercli --version`。
2. 会话历史的落盘位置与格式。未确认前不得给 `default_history_sources` 编路径。

## Decision drivers

1. 能跑的 Agent 才配出现在 `SLOT_B`。
2. 锁不住摘要就不托管安装，而不是锁一个假摘要或跳过校验。
3. 不为一个 Agent 开第二套接入路径。

## Decision

### 1. Qoder 是内置档案，不是社区预设

新增 `AgentKind::Qoder`（`as_str()` 为 `"qoder"`），并提供
`qoder_profile()` 加入 `BuiltInProfileCatalog::bundled()`。

选内置档案而非 `CommunityAcpPreset`，因为 Qoder 需要档案才能表达的东西：
`external_candidates` 检测、`AgentSettingsFeature::AuthMode`、原生 MCP 与
Skills 面。社区预设只有一段锁定的 npx 分发 JSON，装不下这些。

`topology` 为 `ProfileTopology::NativeAcp`——Qoder 自带 ACP，不需要适配器。

### 2. 分发形态是检测优先，托管安装延后

`install_sources` 本次**留空**，`external_candidates` 承担全部发现职责：
在 PATH 与 Qoder 默认安装目录上探测候选可执行名，用 `--version` 探针确认。

探测不到时，Agent 设置页给出的动作是「按官方方式安装 Qoder CLI，然后重新
检测」，不是由 VibeX 代下代装。这与 ADR-0060 一致：Agent 装在用户环境里。

Qoder 一旦发布逐架构直链与 sha256，再补 `ProfileInstallSource::Binary` 并把
`external_candidates` 降级为回退。**不得**为了「先能装上」而引入无摘要校验的
下载路径或直接执行 `qoder.com/install`。

### 3. 鉴权走已有的统一模式，不新增机制

`authentication_precedence` 取 `AccountThenApiKey`，`authentication_required_by_default`
为 `true`：账号态（CLI `/login` 的结果）优先，`QODER_PERSONAL_ACCESS_TOKEN`
作为 API-key 侧的凭据。这直接落在 [ADR-0064](0064-unified-agent-authentication-modes.md)
的统一鉴权模式上，不为 Qoder 开例外。

### 4. 未验证的事实保持缺失

- 可执行名与启动参数在实测确认前不写死。档案里的
  `external_candidates` 应同时覆盖已知的两个候选名，取先探测成功者；探针输出
  与 `--version` 的实际格式以实测为准。
- `default_history_sources(AgentKind::Qoder)` 返回空，直到 Qoder 的会话落盘
  格式被确认。空列表的含义是「本机历史导入暂不支持」，UI 照此显示；编造一个
  `~/.qoder/sessions` 路径会让导入对话框列出一个永远为空的来源。

### 5. Onboarding 的 Agent 位与 AgentKind 对齐

`SLOT_B` 只列 `BuiltInProfileCatalog` 里非 QaMock 的内置 Agent。Qoder 接入后
加入 `SLOT_B`，并把 `SLOT_A` 里的 `qoder` 从 `kind: 'mark'` 升为
`kind: 'agent'`（同 Cursor：它既是 IDE 又是 Agent），补 `AgentMark` 分支。

这条是不变量，不是本次的一次性改动：**`SLOT_B` 出现的每一项都必须能在新建会话
时被选中**。它不适用于 `SLOT_A`（IDE 品牌）、`SLOT_C`、`SLOT_D`（产品属性）。

## Consequences

- `AgentKind` 变化会传导到所有穷尽匹配点：`ALL`、`as_str`、`from_lenient`、
  `default_history_sources`、`configured_history_sources`，以及
  `crates/api-types` 与 `crates/agents` 的枚举锁定测试。
- 内置名册从 13 变 14：`legacy_migration.rs` 的 `BUILT_INS` 与
  `crates/db/tests/agent_management.rs` 里锁定顺序的用例同步更新。**不需要**新增
  SQL 迁移——`ensure_current_built_ins` 每次开库都会补齐新 id。
- 需要 `qoder` 图标进 `frontend/public/agents/`，并登记进 `AgentIcon.tsx` 的
  `BUILT_IN_ICON_PATHS` / `BUILT_IN_DISPLAY_NAMES`。
- `AgentKind` 是 `#[derive(TS)]` 类型，改后必须跑 `pnpm run generate-types`。
- 首个版本的 Qoder 只能用于「用户自己装好」的场景。Agent 管理页的安装动作对
  Qoder 不可用，这是明确的已知边界，不是缺陷。

## Considered Options

- **作为 `CommunityAcpPreset` 接入**：否决。预设只能表达一段锁定分发，表达不了
  检测候选与鉴权模式，接入后设置页是残缺的。
- **用 npx 包托管安装**：否决。未发现 Qoder 的官方 npm 分发；拿非官方包锁定
  摘要会把供应链风险写进内置档案。
- **调用 `qoder.com/install` 引导脚本**：否决。它是无摘要的远端脚本，与
  ADR-0060 的托管安装校验要求冲突。
- **先只改 onboarding 文案（把 Qoder 从 SLOT_A 移除）**：否决。SLOT_A 说的是
  「你从哪来」，本来就成立；删掉它是掩盖能力缺口而不是补上。
