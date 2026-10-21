---
title: 多智能体协同功能增强 — 可行性评估与实现方案
date: 2026-10-18
revised: 2026-10-19
status: analysis
scope: vibex.multi-agent + VibeX Host
plugin: C:\Users\18190\Documents\projects\vibex-plugin-multi-agent
reference: C:\Users\18190\Documents\projects\vibex-plugin-computer-use
---

# 多智能体协同功能增强：可行性评估与实现方案

本文只做分析和方案，不改代码。结论先说：五项需求在产品上成立，但**不能只改本插件仓库**。当前 `vibex.multi-agent` 是薄包（Skill + Host 家族 MCP），真正的会话创建、排队、纠偏、列表、Composer 和顶级 Tab 都在 VibeX Host 的 Application Core。按 ADR-0069 / 插件开发规范，缺的是通用 Host 缝，必须先加深公开 SDK 与控制面，再由本插件消费。

对照实现参考：`C:\Users\18190\Documents\projects\vibex-plugin-computer-use`（`app.settings.page` + Worker + Federation 远程模块）。

产品形态按贴合度对照四家开源（详见 §2.5）：协作空间对齐 AgoraHub 频道；（4）身份投递对齐 MCP Agent Mail；信封对齐 agent-inbox AS2；跨 Host 以后才对齐 ANP。投递层仍走 ADR-0044。

## 1. 总评

| 维度 | 结论 |
| --- | --- |
| 是否可行 | **可行**，前提是接受「Host 先开缝、插件再消费」的双仓库交付 |
| 整体难度 | **高**。设置页单独为中；角色/团队为中高；跨会话发送 + 延时队列为高；协作空间 + IM 三栏 + 跨 Tab 会话保持为很高 |
| 能否只做插件 | **不能**。插件对任意用户 Conversation 没有写权限；Composer 摘要不能被插件替换；延时队列不存在；协作空间没有领域表；插件 Tab 不能内嵌 Host 会话面板 |
| 与现行 ADR 冲突 | 与 ADR-0044 companion 祖先作用域、ADR-0031 one-shot 委派、ADR-0057「配置只活在插件详情」有明确张力，需要修订 ADR，不能靠特例绕过 |
| 建议形态 | 保持「官方薄产品插件 + Host 家族 MCP（`vibex-delegation-mcp`）」；新增 Worker/App 只承载设置页和协作空间 Tab；空间产品对齐 AgoraHub 频道；执行权威仍在 `ConversationControl`（Hub 保证投递，Agent 给判断） |

粗估（一名熟悉本仓库的工程师、含测试与 ADR，不含联调意外）：

| 批次 | 内容 | 难度 | 量级 |
| --- | --- | --- | --- |
| A | 设置窗口独立页，迁入现有三项配置 | 低–中 | 数日 |
| B | 按 ID / 按时间窗查询会话 | 中 | 约 1 周 |
| C | 角色、团队，及基于角色创建一等会话 | 中高 | 1.5–2.5 周 |
| D | Composer 角色摘要（一级菜单） | 中 | 约 1 周 |
| E | 向任意同工作区会话发送；自发送；Host 延时队列 | 高 | 1.5–2.5 周 |
| F | 协作空间领域 + MCP（AgoraHub 频道原语，无完整 IM、无义务状态机） | 高 | 2 周 |
| G | IM 三栏 `app.tab` + 跨工作区/看板会话保持 | 很高 | 2.5–4 周 |

A 可独立交付。B–E 构成「可复用协同」。F–G 才是「IM 式自由协作」，依赖 E。G 的 Tab 与 Open Connector 一样走 `app.tab`；跨面保持只需 `workspace.focusConversation`，不新开渲染引擎。

## 2. 现状与约束

### 2.1 本插件今天做什么

仓库 `C:\Users\18190\Documents\projects\vibex-plugin-multi-agent` 是 v4 薄包：`id = vibex.multi-agent`，无 Worker、无 App、无结构面。

- `config.json`：`depthLimit`、`completedCacheMaxMb`、`agentDefaults`
- 配置入口：插件详情「配置」Tab，Host 按 `config.schema` 渲染表单（ADR-0057）
- MCP：`contents/mcps/delegation.json` → Host 家族二进制 `vibex-mcp`，产品面 `delegation`
- 工具：`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`
- 语义：LLM 中介的 **one-shot 子任务**（ADR-0031）。子 Conversation 首个 Turn 终态即完成，父退出级联取消，没有隐式多轮

这套工具解决「把一块自包含工作交给另一个 Agent 并等待结果」。它不是会话目录、不是角色模板、不是 IM。

### 2.2 会话增强已经覆盖的相邻能力

`vibex.session-enhance` 注入 `vibex-session-mcp`：

| 工具 | 现行为 |
| --- | --- |
| `get_session_info` | **本机任意未删除 Conversation 只读**。`@` 面板插入 `[title](vibex://conversation/<uuid>)` 后即可查 |
| `send_session_input` | 只写 **本会话及其子孙**，同一 workspace；走 `ConversationControl.submit` |
| `cancel_session_turn` / `wait_for_session` | 同一祖先作用域。`wait_*` 会阻塞当前 ACP Turn |

ADR-0044 写死：companion token 不能用通用会话命令访问任意用户 Conversation。`crates/conversations/src/scoped_control.rs` 每次调用都查父子关系。

当前协同 Skill 也禁止把会话查询塞进这套工具。本需求要把协同从「父→子委派」扩成「会话间协作」，产品边界需要重画，而不是偷偷复制一套 `get_session_info`。

### 2.3 Host 已经有、但 Agent 用不上的基建

| 能力 | 现状 | 缺口 |
| --- | --- | --- |
| 会话列表 | `conversation_list` / `conversation_list_recent`（默认 **3 天**，上限 500） | 无 MCP 工具；摘要不含完整 ACP 会话配置 |
| 创建会话 | `conversation_create`；插件 `host.call conversation.create` | 插件创建的会话 **绑定该插件**，不是工作区一等会话；MCP 没有「直接创建」 |
| 提交 / 纠偏 | `submit` 先持久化再认领；忙则排队；`steer` 必须带 `expected_turn_id`，不支持时失败，不得降级成排队 | MCP 写路径锁在子孙；无 `deliver_at` |
| 排队输入 | `conversation_inputs`：Queued → Claimed → Dispatched | 无独立延时队列 |
| Composer 摘要 | `SessionSettingsSummary`（ActionBar 左下）折叠显示 mode/model/effort 短句 | 无「角色」概念，插件不能替换这块 Host chrome |
| 设置整页 | `app.settings.page`，设置侧栏「For Plugin」分组，路由 `/settings/plugin/:pluginId/:pageId` | 文档仍标预览；电脑控制插件已经在用 |
| 顶级 Tab | `app.tab`，与工作区 / 看板并列 | 插件 Tab 是 Federation/iframe，**不能**挂载 Host Conversation Dockview 面板 |
| 插件会话 API | `host.call conversation.*` | 只触及「本插件创建或 Host 授予」的会话 |

### 2.4 必须遵守的平台规则

1. **官方插件无特权**（ADR-0069）：Host 不得出现 `vibex.multi-agent` 分支。角色摘要、协作空间、聚焦会话都必须是通用缝。
2. **单层扩展**：本插件不能依赖会话增强插件的运行时。复用能力的路径是 Host 公开 API，或派生新包。
3. **贡献点与首个官方消费者同批稳定**。要用 `app.settings.page` / `app.tab`，本插件就是那个消费者，包必须带 Worker + Federation 远程模块（电脑控制同构）。
4. **缺缝先加深 SDK**。插件规范：公开 SDK 表达不了时，先加通用 Host 能力，测通，再消费。
5. **`config.json` 仍是插件配置真相**（ADR-0047）。深度、缓存、查询窗口这类标量放这里。角色/团队/协作空间是领域实体，不应塞进一份配置文件当数据库。
6. **控制面唯一写入口**（ADR-0044）：所有发送走 `submit`/`steer`。协作空间不得自建第二套消息生命周期。
7. **能力诚实**（ADR-0058）：列会话时，活 ACP 会话才有完整 config_options；空闲会话缺失就保持缺失。
8. **等待工具不能当协作主循环**：`get_delegation_status(wait_ms)` / `wait_for_session` 会堵住发送方当前 Turn。IM 式协作的发送必须立刻返回已投递。

### 2.5 开源对照（按与本需求贴合度）

四家都证明「Agent 互发、人不用传话」能工作。硬差是同一件事：它们的成员是邮箱身份或频道座位，**不是 VibeX Conversation**，也就没有 ACP Steering、排队输入、单一在途 Turn。产品形态可以对齐；投递层必须仍是 `ConversationControl.submit` / `steer`。

| 序 | 项目 | 贴合 | 吸收 | 明确不搬 |
| --- | --- | --- | --- | --- |
| 1 | [lpalbou/AgoraHub](https://github.com/lpalbou/AgoraHub) | **（5）协作空间**，最像房间 | 具名频道；`post_message` 立刻入账；消息到达就触发对方 Agent；各 Agent 独立，频道另有 transcript 与 per-channel state；attention 信封（先看标题再决定是否读全文）；「Hub 是保证，Agent 给判断」；从不在背后 resume/关闭别人的 session | 义务状态机（open/blocked 必须有人 reply）作 v1；quiet-board「点名无人则全员可见但不义务」与需求「无 @ = 给全体成员 submit」冲突，首版跟需求；hash chain / markdown mirror |
| 2 | [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)（后续 [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)） | **（4）按身份投递、对方空了再处理** | 每个 Agent 自己的身份、inbox/outbox 形状；发送是异步邮件，不是等子任务；`send_message(to[], subject, body_md, thread_id, importance, ack_required)`；难忘昵称（GreenCastle） | `fetch_inbox` / Claude Code hook 每 120s 轮询（漏信根因）；`acknowledge_message` 当投递回执；文件租约（与 worktree 隔离重叠，v1 不做） |
| 3 | [agent-inbox](https://pypi.org/project/agent-inbox/)（PyPI AS2+SQLite+MCP）与 [npm agent-inbox](https://www.npmjs.com/package/agent-inbox) | 信封与规则归属 | AS2 Create+Note；`to` / `cc` / `inReplyTo`；每个收件人自己一份；线程是父指针不是共享标签；**一条 API 持有消息规则**（MCP/CLI/UI 都是客户端）；`check_inbox` 只给清单（发件人/标题/时间/长度），对齐 AgoraHub 信封 | `check_inbox` 当主循环；按线程空闲过期删信；npm 联邦 |
| 4 | [ANP](https://github.com/agent-network-protocol/AgentNetworkProtocol) | 以后跨 Host、跨产品 | `group.send` + P9 mention 作验收口径 | DID、Group DID 文档、E2EE、联邦中继。同一 VibeX 里几个 Conversation 不先实现 DID |

一句话映射：空间产品 → AgoraHub 频道；（4）身份投递 → Agent Mail；信封 → agent-inbox AS2；跨产品以后 → ANP。保证层永远是 Host 主动 `submit`/`steer`。

## 3. 分项评估

### 3.1 设置改到设置窗口独立页

**可行。难度：低–中。风险：低。**

ADR-0069 明确：`plugin.detail.panel` 编辑插件自身 `config.json`；**面向功能领域的设置用 `app.settings.page`**。多智能体协同是功能领域，不是插件开关清单。电脑控制已经声明：

```json
{ "kind": "app.settings.page", "title": "电脑控制", "handler": "surface.createSession", "remote": { ... } }
```

Host `SettingsLayout` 把 `settings_page` 贡献合成侧栏「For Plugin」。禁用插件后条目消失。

与 ADR-0057 的关系：当时把开关从「设置 → 常规」挪到插件详情，是为了离开通用设置页。独立的「设置 → 多智能体协同」整页与那次决定兼容，只是入口从详情 Tab 换成设置侧栏。`config.json` 继续当标量配置真相。

**实现要点**

- 本包补齐电脑控制同构：`entrypoints.worker/app`、Vite Federation `remoteEntry`、`surface.createSession`。
- 设置页用 `host.call storage.settings.get/put` 读写现有三项；角色/团队走下面第 3.3 节的领域 API，不把大对象写进 schema 表单。
- 插件详情配置 Tab：要么只留只读摘要 +「在设置中打开」，要么继续挂同一远程模块，避免两套编辑器。
- 标题用「多智能体协同」，与产品名一致。
- 文档把 `app.settings.page` 从预览推进稳定面（本插件作为官方消费者）。

**风险**

- 无 Worker 的薄包第一次引入 Federation，要按电脑控制走 `vibex plugin run build/dev` 与 Host 真安装验收，harness 绿不够。
- 设置搜索目录（`SETTINGS_SEARCH_ENTRIES`）不会自动索引插件页内部控件，角色/团队检索要插件自己做，或后续给 Host 搜索贡献点。

**不建议**

- 只把 `app.settings.section` 插进「通用」页。那会把领域 CRUD 塞回 ADR-0057 刚清掉的地方。
- 在 Host 里按插件 ID 写死设置页。

### 3.2 查询会话

**可行。难度：中。风险：中（上下文膨胀、产品边界）。**

#### （1）按会话 ID 查状态和上下文

**已经存在。** `get_session_info` 接受 `vibex://conversation/<uuid>` 或裸 UUID，返回 title、agent、status、model、workspace、parent、是否委派子会话、截断后的消息（上限 200 条 / 约 16k 字）。`@` 面板始终可插入该 URI，不依赖本插件。

缺口：工具挂在会话增强上。用户没开会话增强时，`@会话` 只有 Markdown，Agent 查不了。协同插件不应再实现一个同名工具。

**方案**：协同 Skill 写明「查单个会话用会话增强的 `get_session_info`」。协同设置页可以提示同时启用会话增强。若产品要求「只开协同也能查」，则把 **只读查询**提升为 Host 会话控制面的公开读工具，两个产品 MCP 都投递同一实现，配置开关仍分属两个插件。禁止两套解析器。

#### （2）无 ID 时列出一段时间窗口内的活跃会话

Host 已有 `conversation_list_recent(sinceDays, projectId, limit)`，默认 3 天。需求默认一周，可在设置里改，Agent 也可覆盖。

需要新 MCP 工具，建议名 `list_conversations`：

```text
list_conversations({
  since_days?: number,     // 省略则用设置默认，产品默认 7
  project_id?: uuid,
  workspace_id?: uuid,
  limit?: number,          // 硬顶 100（给 Agent 的列表应严于 Host 500）
  include_config?: boolean // 默认 false；true 时尽力带上已持久化的 mode/config，缺失保持缺失
})
```

返回：`conversation_id`、title、agent_id、status、updated_at、是否在途 Turn、parent_id、是否委派子、workspace。**不要**在列表里带全文上下文。上下文继续 `get_session_info`。

默认窗口进协同 `config.json`，例如 `conversationListDefaultDays: 7`（1–90）。设置页编辑；工具参数覆盖。

**风险**

- 列表 + 再对每个 ID 拉上下文，会打爆父 Agent 上下文。Skill 必须写：先列表再按需 `get_session_info`，禁止循环拉全量。
- 空闲会话没有 live ACP `config_options`。列表里的「会话配置」只能是创建时快照 / 最后一次成功的 set_config。没有快照就省略，不编造。
- 只读查询若对全 Host 开放，Agent 能看到其它项目标题。建议默认限制在 **当前 workspace**，可选 `project_id`；跨项目必须显式参数。
- 与会话增强的产品分工：列表更像协同目录。推荐列表进 `vibex-delegation-mcp`，单条详情继续会话增强。两个插件都启用时体验完整。

### 3.3 角色与团队

**可行。难度：中高。风险：中（存储位置、与 one-shot 委派并存）。**

角色是 **可复用的委派/会话模板**，不是 Conversation。团队是可选分组。会话仍是一等公民；角色只在创建时被引用。

建议属性：

```text
Role {
  id, name, team_id?, summary, persona_prompt,
  agent_id, mode_id?, config_values?,
  workspace_policy?, created_at, updated_at
}
Team { id, name, summary? }
```

MCP：`create_role` / `update_role` / `delete_role` / `list_roles`，团队同样一套。用户在设置页 CRUD，与 Agent 写同一份 Host 数据。

**存储：不要放 `config.json`。** 角色含人设提示词，会增长、要按 id 查询、要被 Conversation 引用。`config.json` 适合深度/缓存/默认天数。角色/团队进 Host 表（例如 `collaboration_roles` / `collaboration_teams`），经通用 `host.call collaboration.role.*` 暴露。设置页 Worker 调这些 API。卸载插件时按产品选择保留或清理（与 config 保留策略分开写进 README）。

这不是给 `vibex.multi-agent` 的私有表。表和 API 是通用「会话人格/模板」缝，本插件是首个官方消费者。

**与现行委派的关系**

- `delegate_to_agent` 继续做一次性子任务，用 `agentDefaults`。
- `create_conversation`（下一节）基于角色拉起 **durable 一等会话**，父退出后仍在。
- 两套并存。Skill 写清：短、自包含、要汇总回父 → 委派；要复用人格、要多轮、要进协作空间 → 角色会话。

**风险**

- Agent 批量建角色造成垃圾模板。设置页要能看见/删；可加每 Host 上限（例如 100 角色 / 30 团队）。
- 人设提示词注入：创建会话时应作为 **系统/首条 Host 说明** 写入，并在 UI 对用户可见，避免「隐藏灵魂」。
- `agentDefaults` 与角色配置重叠。建议：委派仍只用 `agentDefaults`；角色会话只用角色上的 Agent+配置。不要让两者隐式合并。

### 3.4 创建会话（基于角色 / 直接创建）

**创建本身可行，中等。Composer 角色摘要可行，中等偏高，必须改 Host。**

#### 直接创建

今天只有 `delegate_to_agent`（child + one-shot）和用户/CLI `conversation_create`。需要 MCP `create_conversation`：

```text
create_conversation({
  agent_id, title?, prompt?,
  workspace_id?,          // 默认当前会话工作区
  role_id?,               // 有则套用角色
  mode_id?, config_values?,
  durable: true           // Agent 创建的必须 durable，避免父连接拆除后被级联取消
})
```

实现走 `ConversationControl.create`（或 durable `create_child` + relation kind 新值 `spawned`），**不要**走 Delegation Broker 的 one-shot 完成策略。创建出的会话与用户手开的会话同一张 `sessions` 表、同一套队列，是一等公民。

插件 `host.call conversation.create` **不够**：它把会话绑到插件 scope，工作区列表默认不可见。协同创建必须进用户工作区。

#### 基于角色

创建时快照角色：写入 `persona_prompt` 为首条/系统说明，绑定 `role_id`（以后改角色 **不回写** 已存在会话，除非用户显式「同步角色」——首版不做同步）。

若角色被删，会话仍在，摘要回退为普通会话配置。

#### Composer 左下角摘要

`SessionSettingsSummary` 是 Host 组件。插件无法贡献替换。需要 **通用 Conversation 人格投影**：

```text
ConversationPersonaOverlay {
  kind: "role",          // 可扩展
  id, name,
  team_name?,
  summary?,
  agent_id
  // 不含 persona_prompt、不含内部 id 之外的实现细节
}
```

折叠态：显示角色名，不显示 mode/model 短句。展开：一级为角色属性（名称、团队、简介、Agent）；「会话配置」为二级，复用现有 mode/config 菜单。需求写明一级不展示 ID 与人设提示词。人设可在设置页或会话信息里看，避免把长提示词塞进 Composer 菜单。

这是 Host 前端改动，由 overlay 驱动，不 `if pluginId == multi-agent`。

**风险**

- 用户仍应能改基于角色的会话的 mode/model；改的是该会话，不是角色模板。摘要二级菜单就是这条路。
- 创建权限：Agent 在用户工作区开新会话会耗配额、写工作树。应沿用委派的 workspace 根约束与 depth/并发上限；角色会话计入「活跃协同会话」预算，而不是无限开。

### 3.5 向会话发送消息（任意 ID、自己、延时）

**可行。难度：高。风险：高（安全作用域、循环、与 steer 语义）。必须修订 ADR-0044。**

#### 任意会话 ID

现状：`send_session_input` 只允许 parent ∪ descendants。需求是按 ID 向任何会话 `submit`；在途则排队；若该 Agent 支持 Steering 且调用方明确要求，可以 `steer`。

控制面已经满足「调用方不用先读是否空闲」：`submit` 总是持久化，空闲立即认领，忙则排队。这就是 Agent Mail 说的「按身份投递、对方空了再处理」，只是身份是 `conversation_id`，邮箱是该会话的输入队列。

#### 身份投递的现成类比：MCP Agent Mail

[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)（Python 已停，新装用 [mcp_agent_mail_rust](https://github.com/Dicklesworthstone/mcp_agent_mail_rust)）把这件事做成 Gmail 形状：每个 Agent 注册难忘名字，有 inbox/outbox，`send_message` 立刻返回 `deliveries`，不 wait 子任务。这把 `delegate_to_agent`（等子任务）和 `send_session_input`（异步邮件）拆开，正是第（4）点。

VibeX 落地：

- 身份 = Conversation；空间内再绑昵称（GreenCastle 那种难忘名）。
- 发送 = Host 对目标 `submit`（忙则排队）或调用方显式 `steer`。对方下一 Turn 直接看到输入。
- 回执 = `InputReceipt`（`queued` | `dispatched`）。`acknowledge_message` 是已读，不是投递回执。
- Agent Mail 的 Claude Code hook 每 120 秒 `unread_only` 拉 inbox——这是漏信根因。VibeX 应用 Host 主动投递，Skill 不教 `fetch_inbox`。
- `file_reservation_paths` 解决「两人同时改同一文件」。不同 workspace 已有 worktree 隔离；同 workspace 并发写是真缺口，但那是写串行化/审批另一条产品，不进 IM 首版。

**推荐授权模型（首版不要「全 Host 任意 UUID」）**

| 目标 | 是否允许 |
| --- | --- |
| 自己 | 是 |
| 本会话子孙 | 是（现状） |
| 同一 workspace 的其它会话 | 是（本需求的关键放宽） |
| 协作空间里的成员 | 是（走空间投递，见 3.6） |
| 其它 workspace / 已删除 / 已归档 | 否，表现为 not found |

这是对 ADR-0044 §5 的修订：companion 写范围从「祖先树」扩大到「同一 workspace」。跨工作区仍禁止，避免借协同打穿 worktree 隔离。

工具建议从会话增强的 `send_session_input` **放宽并复用**，而不是在协同 MCP 再写一条平行发送。两个产品可以都暴露，底层一个 `ScopedConversationControl` 新策略。配置开关：会话增强的 `sessionControl` 继续管子孙；协同插件启用才打开「同工作区」。只开会话增强时行为与今天一致。

`steer` 保持诚实：调用方传 `steer: true` 且无在途 Turn 或 Agent 不支持 → 稳定错误，不改成排队。默认路径永远是 `submit`。

返回值：立刻 `{ delivered: "queued" | "dispatched", input_id, turn_id? }`。**不要**在工具内等待对方 Turn 结束。

#### 给自己发（含放进队列）

自己已在 companion 作用域内。缺口是产品与 Skill：允许 `conversation_id = 当前会话`，在途时进入普通队列。CI 场景：发一条「流水线结束后再看」的 follow-up，结束当前 Turn，等队列到点再开新 Turn。

无延时时这只是文档 + schema 允许 self。有延时才需要 Host 新能力。

#### 延时消息：独立队列

`conversation_inputs` 没有 `deliver_at`。把延时行塞进同一张表会占 sort_key，挡住后面的即时消息，这正是需求要避免的。

Host 新增：

```text
conversation_delayed_inputs {
  id, conversation_id, operation_id,
  payload, principal, deliver_at, status: scheduled | promoted | cancelled
}
```

提升器（Application Core 内短周期任务，**不是**插件 `host.service`）到点后把行 **promote** 成普通 `conversation_inputs`，再走现有 dispatcher。延时队列与即时队列隔离。取消、会话归档、插件停用时丢弃或拒绝提升。

`host.service`（最小 5 秒）不能当产品延时队列：它跟插件进程走，不是会话控制面，重启/停用会丢，也没有 operation_id 幂等。

MCP 参数：`send_session_input(..., delay_seconds?: number | deliver_at?: iso8601)`。上限建议 24h 或 7d，需产品拍板。延时 0 或省略 = 立即 submit。

**风险**

- 同工作区互发可形成 A↔B 死循环。需要：每会话每小时入队上限、相同 payload digest 冷却、空间内 @ 路由去重。
- 延时消息在目标已归档 / Agent 已卸时的行为：promote 失败并写事件，不重试成活 Turn。
- 进程在 promote 与 dispatch 之间崩溃：延时行已 promoted 则按普通 queued 恢复；未 promoted 则仍等 `deliver_at`。不要自动重发已 Dispatched 的 Turn（ADR-0001）。
- 把「全 Host 任意会话」一次放开，等于 Agent 可向用户所有项目塞队列。首版卡在同 workspace。

### 3.6 协作空间 + IM 三栏

**领域与 MCP 可行，高难度。完整 IM 三栏 + 自由区真会话 + 跨 Tab 状态保持可行，很高难度，且有一条硬边界。**

#### 产品语义（建议冻结）

协作空间是 **会话的 IM 房间**，不是任务图，不是 A2A Task RPC。产品形态对齐 [AgoraHub](https://github.com/lpalbou/AgoraHub) 频道：具名房间、多方 `post_message`、到达即触发、各成员独立、房间另有 transcript。AgoraHub 缺的两块——成员是 Conversation、ACP `steer` / 排队输入——由 ADR-0044 补。

- 成员是 Conversation（角色会话或普通会话均可）。
- 每个成员在空间内有自称身份（昵称），@ 用昵称。
- 发送立刻返回。成员在途 → `submit` 排队；空闲 → 认领新 Turn。发送方继续自己的工作或结束当前 Turn。Hub 保证投递，Agent 给判断。
- 一条空间消息 @ 多个成员 = **同一份文本**分别投递；不同文本就分开发。每个收件人自己一份（agent-inbox：没有「先到先得」）。
- 无 @ = 广播给全部 **Agent 可见成员**（不含用户，不含发送者自己，除非显式 @ 自己），并对每人 `submit`。这与 AgoraHub quiet-board「点名无人则全员可见但不义务」有意偏离，跟需求原文。
- 用户在 UI 发第一条消息时加入空间；用户对 Agent **不可 @、不出现在成员名册**。用户文本仍作为来自 Host/用户的输入投递给各成员。
- 各成员上下文独立。空间日志是房间记录（AgoraHub transcript），不合并进某个会话的 JSONL 权威历史；投递进会话的那一份才进入该会话 transcript。
- 首版不做义务状态机（open/blocked/reply/fyi/resolved）。IM 房间没有「这条必须有人回」的钉住。v2 若要「待回复」，`status=reply` 必须带 `inReplyTo`，否则卸不掉义务（AgoraHub 0050：裸 reply 卸不掉任何东西）。
- 首版不做独立 per-channel KV。共享状态就是空间日志。

这与 ADR-0044「不引入 Manager Conversation」一致：空间是关系 + 投递，不是第三种会话类型。AgoraHub 也把频道和座位上的 Agent session 分开，从不在背后 resume/关闭别人的 session。

#### 语义参考：ANP 排第 4，只作以后跨 Host 的口径

同一 VibeX 里几个 Conversation **不先实现 DID**。[ANP](https://agent-network-protocol.com/) Messaging 1.2 的群聊模型仍可当 mention / 回执的验收口径，**不当 Host 内部协议**。跨 Host、跨产品时再考虑 Group DID + `group.send`。

ANP 把消息分成两路，而不是一个模糊大对象：

| ANP | 协作空间对应 |
| --- | --- |
| `direct.send`（P3 Direct Base） | 第 3.5 节按会话 ID 的 `submit`（点对点） |
| `group.send`（P4 Group Base v2） | `post_to_space`（房间消息） |
| `group.create` / `join` / `add` / `leave` | 建空间、拉成员、退出 |
| Group DID | 空间 id（本机 UUID，URI 形如 `vibex://space/<uuid>`） |
| Agent DID | 成员身份：空间内昵称绑定 `conversation_id` |
| Group Host：排序、投递回执、成员变更 | Application Core 的空间路由器 |
| P9 Mention：`@alice` / `@all` / `@agents` / `@humans` | `@昵称`；无 @ = 广播 Agent 可见成员 |
| `operation_id` + `message_id` | 幂等 operation id + 空间消息 id |
| `origin_proof`、DID 文档发现、P5/P6 E2EE、P8 联邦中继、`device_id` | **全部省略** |

差别也要写死，避免实现时把互联网 Agent 协议搬进进程内 Conversation：

- ANP 面向跨域互联网 Agent：DID 定址、Group DID 文档、服务发现、E2EE（MLS 候选）、联邦中继。VibeX 协作空间的成员全是本机 Conversation，身份已经由 Host 会话表保证。
- ANP 生态比 A2A 薄；A2A 本身是 **Task RPC**，协作空间是 IM 不是任务图。两者都不作为内部 wire。
- ANP Group Host **不做** mention 专属授权和 selector 展开（P9：展开在终端）。VibeX Host 既是房间日志，也是投递者，**必须**在 Core 里把 `@昵称` 展开成若干次 `submit`。这是同构下的职责合并，不是违反 ANP。
- ANP 回执是「Group Host 已接受并排序」。映射为 MCP 立刻返回 `{ delivered, input_id, turn_id? }`。回执不是对方 Turn 完成。

P9 选择器落到本产品：

| ANP | VibeX |
| --- | --- |
| `@alice`（单目标 DID） | `@小B` → 该昵称对应 Conversation |
| 一条消息多个 mention | 同一 `content` 分别 `submit`（需求原话） |
| `@agents` | 全部 `kind=agent` 成员；用户不可见成员排除在外 |
| `@all` | 与 `@agents` 相同（用户不可被 @） |
| `@humans` | 首版拒绝或视为空集；用户只通过 UI 发消息，不进入 Agent 可 @ 名册 |
| 无 mention | 视为 `@agents`，并排除发送者自己 |

#### 信封：ActivityStreams 2.0 + attention 标题

空间日志和 MCP 返回的消息对象用 [ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-core/) 的子集。agent-inbox ADR 0004 已经走这条路（actors、URI id、`to` / `cc`、`inReplyTo`），不必再发明字段名。AgoraHub 的 attention 模型叠在同一信封上：先给标题，再给全文。

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Note",
  "id": "vibex://space-message/<uuid>",
  "actor": "vibex://space/<spaceId>/member/<nickname>",
  "attributedTo": "vibex://conversation/<conversationId>",
  "to": ["vibex://space/<spaceId>/member/小B"],
  "cc": [],
  "inReplyTo": null,
  "summary": "请评审当前 diff",
  "content": "请评审当前 diff。关注 auth.ts 的错误处理。",
  "published": "2026-10-18T08:00:00Z"
}
```

约定：

- `actor`：空间内身份（昵称）。用户消息的 `actor` 对 Agent 视图标 `kind=user`，且永不进入可 @ 集合。
- `attributedTo`：背后的 Conversation（用户消息可省略或标 Host 用户主身份）。
- `to`：主投递对象，对应 @。空 `to` = `@agents`。
- `cc`：抄送，进空间日志，**不**拉起 Turn。首版可以不做 `cc`，需要旁观成员时再加。
- `inReplyTo`：父指针（agent-inbox：线程不是共享标签）。回复必须指向同空间已有消息；投递进会话的文本带上被回复摘要，不把整个空间历史并进 JSONL。
- `summary`：标题。agent-inbox 的 `check_inbox` 清单和 AgoraHub envelope headline 都是这个字段。省略则 Host 从 `content` 截首行。
- `content`：全文。
- 不引入 ActivityPub 的 inbox/outbox 联邦、followers 集合、JSON-LD 扩展词表。id 用 `vibex://` URI，与 `@` 会话引用同一风格。

持久化仍是普通表；AS2 是读写投影和 MCP 载荷，不是第二权威。

投递给 Conversation 的文本做成 attention 信封（标题在前）。@ 点名、正文很短、或用户消息时全文内联进 `submit`；广播也带全文（需求要开 Turn），标题仍在最前，排队被认领时 Agent 先分流。AgoraHub 只在「小 / 点名你 / critical」时内联正文——VibeX 因为要开 Turn，默认内联全文，标题作分流而不是省略正文。

#### 保证层：一条 API 持有消息规则

agent-inbox ADR 0005：MCP、CLI、Web 都是客户端，消息规则只活在一条 HTTP API。VibeX 对应物是 `ConversationControl` + 空间路由器。MCP `post_to_space` 只是适配器：写空间日志、展开 `to[]`、对每个目标 `submit`，立刻返回回执。

对方收到的方式是 Host 对其 Conversation 做 `submit`（在途则排队）或显式 `steer`。发送方结束或继续自己的 Turn。空间投递只追加 queued input，不抢 ACP 连接、不取消在途 Turn。

`list_space_messages({ space_id, since_seq })` 对齐 AgoraHub `read_channel`：故意的全文回看，`seq > since`，给 UI 和偶发回看。它不是 wait，也不是发送方主循环。

#### 领域模型

```text
Space { id, name, created_by_conversation_id, created_at }
SpaceMember {
  space_id, conversation_id?, nickname,
  kind: agent | user,
  visible_to_agents: bool   // user 恒为 false
}
SpaceMessage {
  id, space_id, seq,        // 单调 seq，对齐 AgoraHub read_channel 的 since
  envelope_json,            // AS2 Note 子集（actor/to/cc/inReplyTo/summary/content）
  created_at
}
```

投递：对 `to` 展开后的每个 Agent 成员调用 `ConversationControl.submit`，principal 标明 `kind: space, spaceId, messageId`。幂等键：`space_message_id + target_conversation_id`。这就是 ANP Group Host 回执在本机的落地，也是 AgoraHub「消息到达就触发」在 Conversation 队列上的落地。

MCP（全部立刻返回）：

- `create_collaboration_space` / `list_collaboration_spaces`
- `add_space_member`（拉进已有会话；或先 `create_conversation` 再拉）
- `post_to_space`（`content` + 可选 `summary` + `to` 昵称数组；空 `to` = `@agents`；立刻 `{ delivered, message_id, seq, receipts[] }`）
- `list_space_messages`（`since_seq`，全文回看，给 UI 和偶发查阅）

Skill 主循环是 `post_to_space` 然后继续自己的工作。`list_space_messages` 只用于回看。`wait_for_space` / `check_inbox` / `fetch_inbox` 不进工具表。

#### UI：顶级 Tab 三栏（与 Open Connector 同一条槽，不另开引擎）

协作空间主入口就是 `app.tab`，和 `vibex.open-connector` 一样：Host 只提供中央 Tab 槽，页内容由插件自己画。Open Connector 的 Tab 是 Worker 拉起的 Console iframe，没有 `engine` 字段，也不需要。浏览器插件的 `engine: host-browser` 是另一回事——那是在工作区面板里租用 **Host 已有的浏览器内核**。协作空间没有这种 Host 内核要租。

```text
┌ 协作空间列表 ┬ 空间消息（IM）┬ 自由区 ┐
│ 空间 A      │ 小A: …        │ 成员卡片 / 空间信息
│ 空间 B      │ 小B: …        │ 「在工作区打开」
└─────────────┴───────────────┴────────┘
```

左栏、中栏 IM、用户输入、右栏成员/空间信息全部是插件 Federation UI，数据走 `host.call collaboration.space.*`。中栏画空间 transcript（AgoraHub 频道日志），不是某个成员的 JSONL。这一页 **不声明 engine**。

点击成员后要和看板/工作区共用当前会话：加通用 `host.call workspace.focusConversation({ conversationId })`（Open Connector v1 明确没做 Tab 聚焦缝，这里需要一条新的 **导航 host.call**，仍不是渲染引擎）。Host 聚焦已有 Conversation 面板，窗口级当前会话更新，切回工作区仍是这个会话。符合 ADR-0042「同一窗口同一 Conversation 只存在一个面板」。

右栏如果还想 **嵌进完整 Host 会话 chrome**（时间线、Composer、权限卡、纠偏），那才对得上浏览器那种 `engine:`：插件 iframe 里没有 `AgentTimelineConversation`，也不能 import Host 组件。那是可选后续，**不是做 Tab 的前提**。首版右栏只放成员卡片和跳转。

用户作为不可见成员：IM 中栏显示用户气泡（本地 UI）；`list_space_messages` 给 Agent 的视图里，用户消息的 author 标为 `user`，但不出现在 `members` 的可 @ 列表。

**风险**

- 广播扇出：一条无 @ 消息对 N 个空闲成员拉起 N 个 Turn。必须有空间级速率限制。
- 昵称冲突、改名、成员退出后的 @ 解析。
- 插件禁用：空间数据保留在 Host；Tab 消失；MCP 写路径 fail-closed；已排队输入仍按会话队列处理（它们已是会话事实）。
- 协作主循环如果仍教 Agent 去 `get_delegation_status` / `check_inbox` / `fetch_inbox`，IM 会退回轮询并漏信。Skill 必须重写为 `post_to_space` 后继续自己的工作。
- 三栏高频 IM 用 Federation 可以；不要用文档型 iframe 硬套聊天。

## 4. 目标架构

```text
用户设置窗口 ── app.settings.page (本插件 Federation)
协作空间 Tab ── app.tab (本插件 Federation)
Composer 摘要 ── Host SessionSettingsSummary ← ConversationPersonaOverlay
        │
        ▼
公开 host.call（无插件 ID 分支）
  storage.settings.*          标量配置
  collaboration.role/team.*   角色与团队
  collaboration.space.*       空间、成员、消息
  workspace.focusConversation 跨 Tab 会话选择
  conversation.create/submit  工作区一等会话（MCP 用 Core，不是 plugin-scoped create）
        │
        ▼
Application Core   ← 消息规则只活在这里（agent-inbox ADR 0005）
  ConversationControl.submit / steer / create
  delayed_inputs 提升器
  Space 投递器（AS2 to[] → attention 信封 submit；回执=已入队/已认领）
  Hub 保证投递；Agent 给判断；不抢 ACP 连接
        │
        ▼
vibex-mcp
  product=delegation  协同工具（创建、列表、角色、空间、发送）
  product=session     get_session_info 等只读/子孙控制
```

本插件仓库职责：manifest 贡献点、Skill、设置/Tab UI、`config.json` 标量、README。  
VibeX 仓库职责：表、控制面、MCP 工具实现、Composer overlay、focusConversation、延时提升器、ADR。

官方无特权检查必须继续绿：Host 只认识贡献 kind 与通用 API。

## 5. 建议的 MCP 工具演变

| 工具 | 动作 | 所在产品 |
| --- | --- | --- |
| `delegate_to_agent` 等三件 | 保留 one-shot | delegation |
| `list_conversations` | 新增 | delegation |
| `get_session_info` | 保持；Skill 交叉引用 | session |
| `create_role` / `list_roles` / `update_role` / `delete_role` | 新增 | delegation |
| `create_team` / `list_teams` / … | 新增 | delegation |
| `create_conversation` | 新增，直接或 `role_id` | delegation |
| `send_session_input` | **放宽** 同工作区 + self + 可选 delay；默认不 wait | session（实现）+ 协同启用才打开同工作区 |
| `create_collaboration_space` / `add_space_member` / `post_to_space` / `list_space_messages` | 新增；`post` 立刻返回；`list` 是 `since_seq` 回看 | delegation |
| `wait_for_session` / `get_delegation_status` | 保留给委派/子孙等待；**不是**空间主循环 | 原处 |
| `check_inbox` / `fetch_inbox` / `wait_for_space` | **不提供** | — |

Token：继续拆 scope。协同 token 增加 `collaboration.role`、`collaboration.space`、放宽后的 `conversation.control.workspace`。不要发万能 Host token（ADR-0057）。

## 6. 分阶段交付

必须按序。后面的阶段依赖 Host 缝已经公开且有测试。

**阶段 A — 设置页（可单独发版）**  
本插件升级为带 Worker/App 的包；`app.settings.page` 编辑现有三项；详情页不再作为唯一入口。

**阶段 B — 查询**  
`list_conversations` + 默认天数配置；Skill 说明与 `get_session_info` 的分工；列表不含全文。

**阶段 C — 角色/团队 + 创建**  
Host 表与 `host.call`；设置页 CRUD；MCP 创建 durable 一等会话；委派工具行为不变。

**阶段 D — Composer overlay**  
通用人格投影；角色会话折叠显示角色名。

**阶段 E — 发送与延时**  
修订 ADR-0044 作用域；self submit；`conversation_delayed_inputs` + 提升器。发送立即返回。

**阶段 F — 协作空间控制面（AgoraHub 频道原语，无完整 IM）**  
空间表、成员、AS2 信封（含 `summary` 标题）、单调 `seq`、@ / 空 `to` 路由到 attention 信封 `submit`、投递回执；MCP `post_to_space` / `list_space_messages(since_seq)`。无 IM Tab 也可以用工具打通。本阶段不做：ANP DID / `group.send` JSON-RPC、义务状态机、per-space KV、文件租约。

**阶段 G — IM Tab**  
Open Connector 同款 `app.tab` 三栏（无 engine）；中栏画空间 transcript；用户隐身成员；`workspace.focusConversation` 做跨工作区/看板保持。

## 7. 主要风险与否决项

1. **只改插件仓库**：现有公开 SDK 不能写任意工作区会话、不能改 Composer、不能做延时队列、不能在 Tab 里嵌 Host 会话。只改插件会做出一套假 IM（轮询 + 插件私有 KV），和平台方向相反。
2. **Companion 全 Host 写权限**：一次放开任意 UUID 会打穿项目隔离。首版停在同 workspace + 空间成员。
3. **等待工具当协作循环**：发送方 Turn 被 `wait_ms` 卡住，正是需求要消灭的。空间发送必须 fire-and-forget。Agent Mail 的 120s `fetch_inbox` hook 和 agent-inbox 的 `check_inbox` 都是这条路，会漏信。Host 主动 `submit`/`steer`。
4. **把 ANP 或 A2A 当内部 wire**：DID、E2EE、联邦中继过重；A2A 是任务 RPC。同一 Host 内几个 Conversation 不实现 DID。只吸收群/成员/mention/回执语义，信封用 AS2 子集。
5. **把 AgoraHub 义务/quiet-board 原样搬进 v1**：open/blocked 钉住是任务板，不是 IM；quiet-board「送达但不义务」与「无 @ 也开 Turn」相反。产品形态对齐频道，规则跟需求。
6. **文件租约进协作首版**：Agent Mail 的 lease 解决同树并发写，和 IM 投递正交。同 workspace 写冲突走既有审批/串行化，另开产品。
7. **Steer 静默降级排队**：ADR-0044 禁止。默认 `submit`。
8. **Host 按插件 ID 特判 Composer/Tab**：CI `plugin:no-privilege` 会红，第三方也无法做等价物。
9. **角色当 Conversation**：角色是模板。删角色不得删会话。
10. **延时行进普通队列**：会堵住即时消息。必须独立表。
11. **在插件 Tab 里复刻 Host 时间线**：权限卡、提问卡、纠偏、草稿都会错。右栏用成员卡片 + `focusConversation`。
12. **广播风暴 / @ 循环**：要有速率与 digest 冷却，否则两个 Agent 互相 @ 能打满队列。
13. **查询把一周全文塞进父上下文**：列表只给元数据。

## 8. 需要产品拍板的点

写代码前建议确认这些项（本文已给出推荐值）：

1. 跨会话发送范围：推荐 **同 workspace**，不是全 Host。
2. 单条详情工具：推荐 **继续会话增强 `get_session_info`**，协同只新增列表。
3. 角色存储：推荐 **Host 表**，不是 `config.json`。
4. 改角色是否回写已开会话：推荐 **首版不回写**。
5. 延时上限：推荐 **24 小时**，可配置，封顶 7 天。
6. IM Tab：推荐 **Open Connector 同款 `app.tab`**（插件自绘三栏，无 engine）。查看成员会话用 `workspace.focusConversation`，不在 Tab 内嵌 Host 会话 chrome。
7. 空间消息信封：推荐 **ActivityStreams 2.0 Note 子集**（`actor` / `to` / `cc` / `inReplyTo` / `summary`）。ANP 只作跨 Host 口径，Host 不实现 DID / `group.send` JSON-RPC。
8. 无 @ 广播：推荐 **给全体 Agent 可见成员 `submit`**（需求原文）。不采用 AgoraHub quiet-board「送达但不义务」。
9. attention 信封：推荐 **v1 就做**（AS2 `summary` + submit 文案标题在前，全文内联）。
10. obligation（open/blocked 必须回复）：推荐 **v1 不做**。
11. 文件租约 / per-space KV：推荐 **v1 都不做**。共享状态就是空间日志。

## 9. 结论

需求作为产品方向成立，能把「一次性委派 + 轮询子孙」推进到「可复用角色、一等会话、可投递、可延时、IM 式协作」。开源侧已经有频道（AgoraHub）和按身份邮件（Agent Mail）两块现成形状，缺的是把成员做成 Conversation、用 Host `submit`/`steer` 当保证层。
它不是本插件内部的功能补丁，而是一次 **Host 控制面放宽 + 新领域（角色/空间/延时）+ 本插件结构面（设置页/Tab）** 的组合。

最小有价值切片是 **A + B + C + E 的 self/同工作区 submit（不含延时、不含空间）**：设置页、能列出会话、能按角色开一等会话、能发消息而不轮询。延时队列和协作空间（AgoraHub 频道原语，无义务状态机）在这条切片验证后再做。IM 三栏放在控制面稳定之后。
