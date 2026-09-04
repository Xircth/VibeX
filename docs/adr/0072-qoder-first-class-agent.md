---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# Qoder 接入为一等 Agent，ACP 启动参数收敛到单一解析口

Qoder CLI 原生实现 ACP，具备接入 VibeX 的全部条件。本 ADR 把它加入
`AgentKind`，按既有的 npx 托管安装形态接入，并顺带修掉一处会让它启动错的
既有缺陷：ACP 启动参数在三个地方各推导一遍。

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

分发形态从官方 ACP registry
（`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`）核到，
不靠推断：

```json
{ "id": "qoder", "name": "Qoder CLI",
  "distribution": { "npx": { "package": "@qoder-ai/qodercli@0.2.14", "args": ["--acp"] } } }
```

npm 上 `@qoder-ai/qodercli` 的 `latest` 是 `1.1.42`，`bin` 同时提供 `qodercli`
与 `qoder` 两个名字，`engines.node` 为 `>=20`。这解释了文档间的不一致：Qoder
官方 ACP 文档写 `qoder`、阿里云 Model Studio 文档验证 `qodercli`，两个都对。

一处事实仍未确认：会话历史的落盘位置与格式。未确认前不得给
`default_history_sources` 编路径。

### 既有缺陷：ACP 启动参数有三份推导

`--acp` 是 Qoder 的开关——不带它，同一个可执行文件起的是交互式 TUI 而不是 ACP
server。而 VibeX 目前从 `install_sources` 里按组件反查启动参数，这段逻辑在三处
各写了一遍：

- `crates/agents/src/launch_gate.rs` 的 `discover_path_acp_launch_lock`
- `src-tauri/src/commands/agent_management.rs` 的外部候选启动路径
- 同文件的 user-environment 启动路径

三份推导都只认 `install_sources`，于是「外部检测到的可执行文件」与「它该怎么被
调起来」被拆到了两个数据源，且没有任何地方保证它们一致。

## Decision drivers

1. 能跑的 Agent 才配出现在 `SLOT_B`。
2. 事实来自可核验的来源（官方 registry、npm registry），不靠文档间的转述。
3. 不为一个 Agent 开第二套接入路径；发现缺陷就在源头改，不加第四份推导。

## Decision

### 1. Qoder 是内置档案，不是社区预设

新增 `AgentKind::Qoder`（`as_str()` 为 `"qoder"`），并提供
`qoder_profile()` 加入 `BuiltInProfileCatalog::bundled()`。

选内置档案而非 `CommunityAcpPreset`，因为 Qoder 需要档案才能表达的东西：
`external_candidates` 检测、`AgentSettingsFeature::AuthMode`、原生 MCP 与
Skills 面。社区预设只有一段锁定的 npx 分发 JSON，装不下这些。

`topology` 为 `ProfileTopology::NativeAcp`——Qoder 自带 ACP，不需要适配器。

### 2. 分发走既有的 npx 托管安装形态

`install_sources` 为单条 `native_npx("@qoder-ai/qodercli", "1.1.42", "qodercli",
["--acp"], ">=20", <sha512>)`，与 Kimi Code、DeepSeek Harness 同形，摘要取自 npm
registry 的 `dist.integrity`。`external_candidates` 同时覆盖 `qoder` 与
`qodercli` 两个已发布的 bin 名，用户手动装过的也能被认出来。

### 3. ACP 启动参数只有一个解析口

新增 `agents::acp_launch_args(profile, component)`，成为读取启动参数的唯一入口，
上述三处推导全部改为调用它。解析顺序：

1. `ProfileExternalCandidate::acp_args`——「这个可执行文件怎么说 ACP」是该文件
   自身的属性，检测到的和托管装的是同一件事。
2. 回退到该组件 `install_sources` 上钉的参数，保持现有全部档案的行为不变。

两者同时声明时必须相等，由 `acp_launch_args_have_one_answer_per_profile`
锁定——否则同一个 Agent 会因为「怎么装来的」而启动成不同的东西。

### 4. 鉴权走已有的统一模式，不新增机制

`authentication_precedence` 取 `AccountThenApiKey`，`authentication_required_by_default`
为 `true`：账号态（CLI `/login` 的结果）优先，`QODER_PERSONAL_ACCESS_TOKEN`
作为 API-key 侧的凭据。这直接落在 [ADR-0064](0064-unified-agent-authentication-modes.md)
的统一鉴权模式上，不为 Qoder 开例外。

### 5. 未验证的事实保持缺失

- Skills 目录已核实（`~/.qoder/skills/{name}/SKILL.md` 与项目级
  `.qoder/skills/`，见 `docs.qoder.com/cli/Skills`），因此
  `settings_features` 声明 `NativeSkills`。
- 配置文件的键位结构没有文档，因此 `native_config` 为空。声明
  `NativeMcp` 需要知道该往哪个文件写 MCP server，这一条不声明。
- `default_history_sources(AgentKind::Qoder)` 返回空，直到 Qoder 的会话落盘
  格式被确认。空列表的含义是「本机历史导入暂不支持」，UI 照此显示；编造一个
  `~/.qoder/sessions` 路径会让导入对话框列出一个永远为空的来源。

### 6. Onboarding 的 Agent 位与 AgentKind 对齐

`SLOT_B` 只列 `BuiltInProfileCatalog` 里非 QaMock 的内置 Agent。Qoder 接入后
加入 `SLOT_B`，并把 `SLOT_A` 里的 `qoder` 从 `kind: 'mark'` 升为
`kind: 'agent'`（同 Cursor：它既是 IDE 又是 Agent），补 `AgentMark` 分支。

审查中发现 `SLOT_B` 原本还漏了 `cursor`——它是能跑的 Agent 却只出现在 IDE 位。
一并补上，`SLOT_B` 与可运行名册就此完全一致，顺序对齐 `AgentKind::ALL`。

这条是不变量，不是本次的一次性改动：**`SLOT_B` 出现的每一项都必须能在新建会话
时被选中**。它不适用于 `SLOT_A`（IDE 品牌）、`SLOT_C`、`SLOT_D`（产品属性）。
由 `EquationLine.test.ts` 锁定：该表按 `AgentKind` 定型，某个 Agent 从 Rust 身份
枚举里消失时这里编译不过，而不是继续留在落地页上。

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
- `ProfileExternalCandidate` 多一个字段，所有字面量同步补 `acp_args: &[]`；
  既有档案全部走回退分支，行为不变。
- 会话历史导入对 Qoder 不可用，这是明确的已知边界，不是缺陷。

## Considered Options

- **作为 `CommunityAcpPreset` 接入**：否决。预设只能表达一段锁定分发，表达不了
  检测候选与鉴权模式，接入后设置页是残缺的。
- **检测优先、不做托管安装**：否决。本 ADR 初稿据此写就，前提是「Qoder 只有
  `curl | bash` 引导脚本」。核查官方 ACP registry 后该前提不成立：官方分发就是
  npx。且在当前实现下它还会**装出一个坏的**——启动参数只从 `install_sources` 推
  导，没有安装源的档案会以裸 `qoder` 启动，起的是 TUI 而不是 ACP server。
- **调用 `qoder.com/install` 引导脚本**：否决。它是无摘要的远端脚本，与
  ADR-0060 的托管安装校验要求冲突。
- **给 `acp_args` 加第四处推导，不动既有三处**：否决。这正是缺陷本身，再加一份
  只会让分歧更难发现。
- **把 `command` / `args` 整体上提到 `BuiltInProfile`，从安装源移除**：否决。
  适配器型档案的 runtime 与 adapter 是两个组件、两套调用，上提要改全部 13 个
  档案与安装器，收益不抵风险。单一解析口 + 一致性用例已经消除了分歧面。
- **先只改 onboarding 文案（把 Qoder 从 SLOT_A 移除）**：否决。SLOT_A 说的是
  「你从哪来」，本来就成立；删掉它是掩盖能力缺口而不是补上。
