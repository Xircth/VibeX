---
title: multi-agent 功能重大改进技术方案
date: 2026-10-19
status: draft
design: docs/plans/2026-10-19-multi-agent-major-improvement-design.md
analysis: docs/plans/2026-10-18-multi-agent-collaboration-enhancement.md
---

# multi-agent 功能重大改进技术方案

实施以本文为准。产品语义以《multi-agent 功能重大改进设计方案》为准。冲突时，先改设计方案里的决策记录，再改代码。不要在实现里另开口径。

仓库分工：

- `C:\Users\18190\Documents\projects\VibeX`：表、控制面、MCP 实现、Composer、`focusConversation`、延时提升器、ADR。
- `C:\Users\18190\Documents\projects\vibex-plugin-multi-agent`：manifest、Worker、Federation 页面、Skill、`config.json` 标量、README。

## 1. 文档说明

按批次 A → G 实施。后一批只依赖前一批已经合并且验收通过的 Host 缝。每批结束跑该批列出的测试和验收，再开下一批。

需求覆盖见 §8 每批「覆盖」以及 §9 端到端剧本。设计方案 §2.1 的 R1–R6.6 都必须在 §9 出现。

## 2. 现状锚点

对照代码，评估文档里这几条仍然成立：

| 事实 | 位置 |
| --- | --- |
| 普通输入唯一写入口 `submit`：先持久化，空闲认领，在途排队 | `crates/conversations/src/input.rs` `ConversationInputControl::submit` |
| companion 写范围 = 同工作区且（自己或子孙） | `crates/conversations/src/relation.rs` `companion_scope_target`（约 176–195 行）；`scoped_control.rs` `authorize` 调用它 |
| `get_session_info` 可读任意未删除会话，不管祖先 | `crates/conversations/src/session_info.rs` 模块注释 |
| 最近会话列表命令已存在，默认窗口不是 7 天 | `crates/application/src/command.rs` `conversation_list_recent` |
| 排队输入表已存在 | 迁移 `crates/db/migrations/20260813010000_conversation_inputs.sql` |
| Composer 摘要是 Host 组件，入参只有 mode/config | `frontend/src/components/tasks/follow-up/SessionSettingsSummary.tsx` |
| `app.settings.page` / `app.tab` 已是贡献种类，Tab 无 `engine` 字段 | `packages/plugin-sdk/src/manifest.ts` `SettingsPageIntegrationManifest`、`TabIntegrationManifest` |
| 一次性委派仍走 broker | `crates/delegation/src/broker.rs`、`crates/delegation-proto` |
| 插件 `conversation.create` 绑定插件作用域 | `CONTEXT.md` Plugin conversation capability；迁移 `20260906010000_plugin_conversation_bindings.sql`、`20260906020000_plugin_scratch_workspaces.sql` |

因此：

- MCP 没有 durable 一等 `create_conversation`。用户在 UI 里开的会话是另一条路。R4.2 要新增工具，不能写成「已经具备」。
- 立即给自己 `submit` 在祖先规则下已经合法（自己等于 parent）。缺口是工具/Skill 明确允许，以及延时表。
- 最新迁移是 `20261017010000_conversation_timeline_rows.sql`。新迁移用更大的时间戳，例如 `20261019100000` 起。

## 3. 目标架构与模块边界

```text
插件 Federation UI
  settings / space tab
        │ host.call
        ▼
crates/application 命令注册（ADR-0078 单缝）
        │
        ▼
crates/conversations
  SessionInfoQuery          已有
  ConversationInputControl  已有 submit
  DelayedInputControl       新
  SpaceRouter               新
  ScopedConversationControl 改：按 token 策略选择祖先或同工作区
        │
        ▼
crates/db  新表 + .sqlx
src-tauri  MCP 工具注册、提升器任务
frontend   SessionSettingsSummary 接受可选 persona
```

允许的改法：加深通用类型和命令。禁止的改法：按插件 ID 分支、在插件 KV 里存空间日志、在 MCP 工具里 `wait` 对方 Turn、新建 Manager Conversation、给 `app.tab` 加 `engine: host-conversation`。

Token：

| scope | 谁拿 | 能力 |
| --- | --- | --- |
| `conversation.read` | 会话增强与协同 | `get_session_info` |
| `conversation.list.workspace` | 协同 | `list_conversations` |
| `conversation.control.descendants` | 会话增强 | 祖先树 `submit` / `steer` / `cancel` |
| `conversation.control.workspace` | 协同启用时 | 同工作区 `submit` / `steer` |
| `collaboration.role` | 协同 | 角色与团队 |
| `collaboration.space` | 协同 | 空间 |

不发万能 Host token（ADR-0057）。

## 4. 数据模型与迁移

每改 `sqlx::query!` 或迁移，跑 `pnpm run prepare-db`。对前端导出的新结构体跑 `pnpm run generate-types`，不手改 `shared/types.ts`。

### 4.1 `20261019100000_collaboration_roles.sql`（批次 C）

```sql
CREATE TABLE collaboration_teams (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collaboration_roles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  team_id TEXT REFERENCES collaboration_teams(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  persona_prompt TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  mode_id TEXT,
  config_values_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_personas (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  role_id TEXT,
  name TEXT NOT NULL,
  team_name TEXT,
  summary TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  snapshotted_at TEXT NOT NULL
);

CREATE INDEX collaboration_roles_team_id ON collaboration_roles(team_id);
```

删除团队把角色的 `team_id` 置空。删除角色不碰 `conversation_personas` 和 `sessions`。

### 4.2 `20261019110000_conversation_delayed_inputs.sql`（批次 E）

```sql
CREATE TABLE conversation_delayed_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  deliver_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','promoted','cancelled','failed')),
  promoted_input_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, operation_id)
);

CREATE INDEX conversation_delayed_inputs_due
  ON conversation_delayed_inputs(status, deliver_at);
```

这张表没有 `sort_key`。提升之前不读、不写 `conversation_inputs`。

### 4.3 `20261019120000_collaboration_spaces.sql`（批次 F）

```sql
CREATE TABLE collaboration_spaces (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by_conversation_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE collaboration_space_members (
  space_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  conversation_id TEXT,
  nickname TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent','user')),
  visible_to_agents INTEGER NOT NULL CHECK (visible_to_agents IN (0,1)),
  PRIMARY KEY (space_id, member_id),
  UNIQUE (space_id, nickname),
  UNIQUE (space_id, conversation_id)
);

CREATE TABLE collaboration_space_messages (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (space_id, seq)
);

CREATE TABLE collaboration_space_deliveries (
  space_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','dispatched','failed')),
  PRIMARY KEY (space_message_id, conversation_id)
);
```

`seq` 在同一事务里 `SELECT COALESCE(MAX(seq),0)+1` 再插入，与消息行同一 `BEGIN IMMEDIATE`。

用户成员：`kind='user'`，`conversation_id` 空，`visible_to_agents=0`。SQLite 的 UNIQUE 允许多个 NULL `conversation_id`，因此每个空间最多一个用户成员要在应用层保证（先查再插入）。

## 5. 控制面与 MCP 契约

错误码稳定，Agent 可分支。HTTP/Tauri 层把它们原样带出。

| code | 含义 |
| --- | --- |
| `not_found` | 目标不存在、已删、已归档，或不在允许的工作区。不附带标题 |
| `out_of_scope` | token 策略不允许（例如只开会话增强时写兄弟会话） |
| `steer_unsupported` | 调用方要求 steer，但该 Agent 会话不能纠偏 |
| `steer_no_active_turn` | 要求 steer 时没有在途 Turn |
| `steer_conflict` | `expected_turn_id` 与当前在途 Turn 不一致 |
| `delay_exceeds_cap` | 超过 `delayMaxHours` 或 168 |
| `nickname_taken` | 空间内昵称已占用 |
| `not_a_member` | 调用方不是该空间的 Agent 成员 |
| `limit_exceeded` | 角色、团队、列表或速率上限 |
| `idempotent_replay` | 不是错误。同一 `operation_id` 返回第一次的回执 |

### 5.1 读

`get_session_info`（delegation 与 session 两个 MCP 产品，一个 Rust 函数 `SessionInfoQuery`）：

```text
{ conversation_id: uuid | "vibex://conversation/<uuid>" }
→ 现有 SessionInfo 结构（截断消息）
```

`list_conversations`（仅 delegation）：

```text
{
  since_days?: number,      // 省略 = config.conversationListDefaultDays
  project_id?: uuid,
  workspace_id?: uuid,      // 省略 = 调用方会话的工作区
  limit?: number            // 默认 50，硬顶 100
}
→ [{
  conversation_id, title, agent_id, status, updated_at,
  turn_in_flight, parent_id, delegated, workspace_id,
  mode_id?, config_values?
}]
```

`include` 正文的参数不提供。

### 5.2 角色与创建

```text
create_role / update_role / delete_role / list_roles
create_team / update_team / delete_team / list_teams
```

`create_role` 必填 `name`、`agent_id`。`persona_prompt` 可空字符串。计数在插入事务里检查 100 / 30。

```text
create_conversation({
  agent_id?,          // 无 role_id 时必填
  role_id?,
  title?,
  prompt?,
  workspace_id?,      // 省略 = 调用方工作区
  mode_id?,
  config_values?,
  operation_id
}) → { conversation_id }
```

实现：`ConversationControl::create`，关系 `spawned`。有 `role_id` 时在同一事务写 `conversation_personas`，并把 `persona_prompt` 写成该会话首条可见 Host 说明（用户在时间线上看得到）。不调用 `crates/delegation` broker，不写 `delegation_call_id`，因此不继承级联取消。

`spawned` 的父退出钩子必须显式跳过。给现有级联取消加测试：父取消不影响 `spawned` 子会话的在途 Turn。

### 5.3 发送

```text
send_session_input({
  conversation_id,
  text,
  operation_id,
  steer?: boolean,             // 默认 false
  expected_turn_id?: uuid,     // steer 时必填
  delay_seconds?: number       // 与 deliver_at 二选一
  deliver_at?: iso8601
}) → {
  delivered: "queued" | "dispatched" | "scheduled",
  input_id?,
  turn_id?,
  delayed_input_id?
}
```

策略选择发生在 MCP 边界，不在 SQL：

```rust
enum CompanionWritePolicy {
    AncestorTree,   // conversation.control.descendants
    SameWorkspace,  // conversation.control.workspace
}
```

`SameWorkspace`：`parent.workspace_id == target.workspace_id` 且目标未删除、未归档。自己、子孙、兄弟都通过。`AncestorTree` 保持 `companion_scope_target` 现状。

`delay_seconds > 0` 或 `deliver_at` 在未来：插入 `conversation_delayed_inputs`，`delivered: "scheduled"`。不调用 `submit`。

提升器：Application Core 内周期任务（建议 1s，允许 5s 以内的抖动）。扫描 `status='scheduled' AND deliver_at <= now`，对每一行用该行的 `operation_id` 调用 `submit`。成功则 `promoted` 并记下 `promoted_input_id`。会话已归档则 `failed`。崩溃后：`scheduled` 且到期的行会再次被扫到；`submit` 的 `operation_id` 幂等保证不产生第二份输入。

速率：同一目标会话每小时最多 60 次新 `submit`（重放不计）。同一 `(target, payload_digest)` 10 分钟内再次提交返回第一次回执，并带 `idempotent_replay`。

### 5.4 空间

```text
create_collaboration_space({ name, operation_id })
  → { space_id }
  工作区 = 调用方工作区
  调用方以自己的昵称加入。昵称默认取会话标题，冲突则加短后缀，随后可用 set_space_identity 改

add_space_member({ space_id, conversation_id, nickname, operation_id })
  目标必须在该空间的工作区
  nickname 是提议。成员之后可改

set_space_identity({ space_id, nickname, operation_id })
  只改调用方自己的行

post_to_space({
  space_id,
  content,
  summary?,
  to?: [nickname],          // 空 = 广播
  in_reply_to?: uuid,
  operation_id
}) → {
  message_id, seq,
  receipts: [{ conversation_id, nickname, delivered, input_id?, turn_id? }]
}

list_space_messages({ space_id, since_seq?: number, limit?: number })
  → [{ seq, envelope }]     // since_seq 省略则从 0；limit 默认 50，硬顶 200
```

`post_to_space` 算法：

1. 调用方必须是该空间 `kind=agent` 成员。用户走 UI 的 `host.call`，不走这条 MCP。
2. 解析 `to`。空则取 `visible_to_agents=1` 且 `conversation_id != caller`。未知昵称 → `not_found`，整单不写。
3. 插入消息，`seq` 递增，信封按设计方案 §4.4。
4. 对每个目标构造文本：`summary` 一行，空行，`content`。`operation_id` 用 `uuid_v5(message_id, conversation_id)`，因此重试不会第二次 `submit`。
5. 调用 `ConversationControl::submit`。回执写入 `collaboration_space_deliveries`。
6. 返回。不等待 Turn。

用户在 Tab 发消息：若还没有用户成员则插入隐身成员，再按同样算法扇出。`actor` 对 Agent 视图是用户，不进入可 `@` 集合。

`list_space_messages` 给 Agent 时过滤掉「如何 `@` 用户」所需的信息：信封 `to` 里不出现用户成员 URI。中栏 UI 用 Host 读接口拿含用户气泡的完整日志。两个读投影，一张消息表。

### 5.5 导航

```text
workspace.focusConversation({ conversationId }) → { focused: true }
```

Host：按 ADR-0042 聚焦该窗口中这个 Conversation 的唯一面板；没有则打开。更新窗口当前会话。会话不在任何已打开工作区时，先打开其工作区再聚焦。插件 Tab 不接收时间线数据。

## 6. 前端与插件包

### 6.1 插件包

对照 `vibex-plugin-computer-use`：补 `entrypoints.worker`、`entrypoints.app`、Vite Federation `remoteEntry`、`surface.createSession`。

`plugin.json` 增加：

```json
{
  "id": "settings",
  "kind": "app.settings.page",
  "title": "多智能体协同",
  "handler": "surface.createSession",
  "remote": { "name": "multiAgent", "entry": "remoteEntry.js" }
}
```

```json
{
  "id": "spaces",
  "kind": "app.tab",
  "title": "协作空间",
  "icon": "messages",
  "handler": "surface.createSession",
  "remote": { "name": "multiAgent", "entry": "remoteEntry.js" }
}
```

Tab 对象不写 `engine`。

`config.json` 增加 `conversationListDefaultDays`（默认 7）和 `delayMaxHours`（默认 24）。schema 限制 1–90 与 1–168。

详情配置面改为只读摘要 + 打开设置页。同一远程模块可以挂在详情里做跳转，不复制一份编辑器。

Skill 重写协作段：列表与单条的分工、委派与 `create_conversation` 的分工、发送后继续自己的工作、空间用 `post_to_space`。不把 `get_delegation_status` 写成空间主循环。

### 6.2 Composer

`SessionSettingsSummary` 增加可选 prop：

```ts
persona?: {
  name: string;
  teamName?: string;
  summary?: string;
  agentName: string;
} | null;
```

数据来自会话面板已经在取的 Conversation 详情，Host 在详情里附带 `conversation_personas` 行。没有行则 `persona` 为空，组件行为与今天相同。

有 `persona` 时折叠标签用 `persona.name`。菜单前四项为名称、团队、简介、Agent，不可编辑。最后一项子菜单「会话配置」复用现有 mode/config 行。

文案走现有 i18n（`tasks` / `common`）。不在组件里写「此摘要来自角色模板」这类说明。

### 6.3 协作空间页

三栏用设计令牌，不写死颜色。布局见设计方案 §6.3。数据只通过 `host.call collaboration.space.*` 与 `workspace.focusConversation`。

`@` 补全只列 `visible_to_agents` 的昵称。

## 7. ADR 修订

与对应批次同一 PR 提交。

| ADR | 修订 |
| --- | --- |
| ADR-0044 | companion 写策略分 `AncestorTree` 与 `SameWorkspace`。延时输入是独立事实，提升后才成为排队输入。`steer` 失败不降级。空间扇出仍逐次 `submit` |
| ADR-0031 | 保持 one-shot。补充 `spawned` 不是委派，不级联取消 |
| ADR-0042 | `focusConversation` 是打开或聚焦唯一面板的导航，不创造第二种面板 |
| ADR-0057 | 协同的领域设置在 `app.settings.page`。详情配置不再是唯一编辑入口。标量仍在 `config.json` |
| ADR-0069 | `app.settings.page` 与 `app.tab` 以本插件为官方消费者推进稳定面。接管面总表补两行：会话人格投影、`workspace.focusConversation`、`collaboration.*` |
| ADR-0058 | 列表上的会话配置只来自已持久化快照；缺失保持缺失 |

不新增「Manager Conversation」ADR。若术语需要进 `CONTEXT.md`，用设计方案 §4.1 的定义，不写表名。

## 8. 分批实施

### 批次 A — 设置页

**覆盖：** R1。页面上预留角色/团队区域的空壳可以等到 C；A 必须能改现有三项和新标量。

**改动：**

- 插件仓库：Worker、App、Federation、`app.settings.page`、`config.json` 新字段、详情页只读。
- Host：确认设置侧栏收录 `settings_page`（电脑控制已经走通的话，只消费，不改 Host 分支）。

**测试：** 插件包贡献解析；设置页渲染三项；`conversationListDefaultDays` 写入后读回。

**验收：**

1. 安装并启用插件，打开设置窗口，侧栏出现「多智能体协同」。
2. 把查询窗口改成 14，重开设置页，仍是 14。`config.json` 中该字段为 14。
3. 打开插件详情配置 Tab，看不到可编辑的深度表单，能点到设置页。
4. 禁用插件，侧栏条目消失。再次启用，14 还在。
5. 回归：电脑控制的设置页仍在，其配置未被改写。
6. 完成标准：不启动 Agent 也能改完标量。详情页不能再当编辑器。

**回滚：** 卸下贡献声明。`config.json` 多出来的字段对旧 Host 无害；新 Host 对缺字段用默认 7 和 24。

### 批次 B — 查询

**覆盖：** R2.1、R2.2。依赖 A 的默认天数。

**改动：**

- `list_conversations` 读模型放在 `crates/conversations`，命令进 `crates/application`。
- delegation MCP 注册 `list_conversations` 与 `get_session_info`。
- session MCP 的 `get_session_info` 改为调用同一函数（若已经是同一函数，只加测试锁住）。
- Skill 写查询分工。

**测试：**

- `cargo test -p conversations list_conversations_excludes_bodies`
- `cargo test -p conversations list_conversations_defaults_to_caller_workspace`
- `cargo test -p conversations get_session_info_same_bytes_from_both_entrypoints`
- 缺 config 快照时 JSON 无该键。

**验收：**

1. 只开协同、关掉会话增强。在 Composer `@` 一个会话，Agent 调用 `get_session_info` 得到标题和截断消息。
2. 不传 ID，调用 `list_conversations`。近 7 天（或设置值）内的会话出现，字段含 ID、Agent、状态；响应体没有消息正文。
3. 传入 `since_days: 1`，更早的会话消失。
4. 对列表中的一个 ID 再查 `get_session_info`，得到上下文。
5. 空闲且从未写入 config 快照的会话，列表里没有编造的 mode。
6. 回归：会话增强打开时，其 `get_session_info` 结果与协同侧一致。
7. 完成标准：Skill 示例不包含对列表的循环全文拉取。

**回滚：** 卸下 MCP 工具。读路径无迁移。

### 批次 C — 角色、团队、一等创建

**覆盖：** R3、R4.2，以及 R4.1 的创建一半（摘要在 D）。

**改动：** 迁移 §4.1；`host.call collaboration.role.*` / `team.*`；MCP 八个工具；`create_conversation`；`spawned` 关系不级联取消；设置页角色/团队 CRUD；首条 Host 说明含人设提示词。

**测试：**

- `cargo test -p conversations create_from_role_snapshots_persona`
- `cargo test -p conversations update_role_does_not_touch_persona`
- `cargo test -p conversations delete_role_keeps_session`
- `cargo test -p conversations spawned_survives_parent_cancel`
- `cargo test -p conversations role_cap_100`
- 设置页 Vitest：新建角色后列表出现。

**验收：**

1. 设置页新建团队「评审」，再建角色「评审员」：Agent、简介、人设提示词、会话配置填全。
2. Agent `list_roles` 能看到「评审员」。
3. Agent `create_conversation({ role_id })`。新会话出现在工作区列表，不是插件 scratch。时间线首条能看到人设提示词。
4. 改角色简介。已创建会话的人格投影简介不变。
5. 删除角色。会话仍在，仍可发消息。
6. Agent `create_conversation` 不带 `role_id`，只带 `agent_id`。会话出现在同一列表。
7. `delegate_to_agent` 仍在子 Turn 终态完成；父取消仍取消该委派子会话。第 3 步创建的会话不被取消。
8. 第 101 个角色被拒绝。
9. 完成标准：两种创建都在 `sessions` 表，且 `delegation_call_id` 为空。

**回滚：** 停用 MCP 写工具。表可留。已创建会话不删。

### 批次 D — Composer 角色摘要

**覆盖：** R4.1 的 UI 一半。依赖 C 的 `conversation_personas`。

**改动：** 会话详情附带 persona；`SessionSettingsSummary` 按设计方案 §6.2 分支。

**测试：** `frontend` Vitest `SessionSettingsSummary.persona.test.tsx`：有投影时折叠文本是角色名；展开一级含名称、团队、简介、Agent，不含 UUID 和人设提示词；「会话配置」子菜单仍能改 mode。无投影时快照与改前一致。

**验收：**

1. 打开批次 C 创建的角色会话。左下角显示「评审员」，不显示 mode/model 短句。
2. 展开。一级是名称、团队、简介、Agent。没有角色 ID，没有人设提示词。
3. 打开「会话配置」，改 mode。该会话配置变了，角色模板的 mode 不变。
4. 打开一个直接创建、无角色的会话。左下角仍是原来的短句。
5. 完成标准：组件不读取插件 ID。

**回滚：** 忽略 persona 字段即可恢复旧摘要。

### 批次 E — 发送与延时

**覆盖：** R5.1、R5.2、R5.3。依赖 B（调用方会先查再发）。建议在 F 之前完成，因为空间扇出复用 `submit`。

**改动：** ADR-0044；`CompanionWritePolicy`；迁移 §4.2；提升器；`send_session_input` 参数；速率与摘要冷却。

**测试：**

- `cargo test -p conversations workspace_policy_allows_sibling`
- `cargo test -p conversations ancestor_policy_rejects_sibling`
- `cargo test -p conversations cross_workspace_is_not_found`
- `cargo test -p conversations self_submit_queues_behind_inflight`
- `cargo test -p conversations steer_unsupported_does_not_queue`
- `cargo test -p conversations delayed_row_does_not_take_sort_key`
- `cargo test -p conversations promote_calls_submit_once`
- `cargo test -p conversations promote_failed_when_archived`

**验收：**

1. 同工作区两个一等会话 A、B。A 调用 `send_session_input` 到 B，立刻得到 `queued` 或 `dispatched`。A 的工具返回后 A 仍能继续输出。
2. B 有在途 Turn 时再发一条。返回 `queued`。B 的当前 Turn 不被取消。Turn 结束后该输入成为下一 Turn。
3. 对支持 Steering 的在途 Turn 传 `steer: true` 与正确 `expected_turn_id`。该 Turn 收到纠偏，队列长度不增加。
4. 对不支持 Steering 的会话传 `steer: true`。错误 `steer_unsupported`。队列里没有新行。
5. A 给自己发一条无延时消息。在途则 `queued`。
6. A 给自己发 `delay_seconds: 30`。30 秒内普通队列没有这条。期间再发一条即时消息，即时消息排在前面。到期后延时条才进入队列。
7. `delay_seconds` 超过 168 小时，错误 `delay_exceeds_cap`。
8. 用 B 的 ID 但从另一个工作区的会话调用。`not_found`，响应无标题。
9. 只开会话增强、不开协同。向兄弟会话发送仍是 `out_of_scope`。
10. 完成标准：延时行在提升前 `conversation_inputs` 无对应 `operation_id`。

**回滚：** 策略退回 `AncestorTree`。提升器停掉。`scheduled` 行保留不提升，避免半截投递。

### 批次 F — 协作空间控制面

**覆盖：** R6.1、R6.2、R6.3、R6.5 的数据规则。无 Tab 也能用工具打通。依赖 C（成员可以是刚创建的会话）和 E（`submit` 同工作区）。

**改动：** 迁移 §4.3；`SpaceRouter`；MCP 五个工具；Agent 读投影隐藏用户。

**测试：**

- `cargo test -p conversations space_mention_submits_same_text_to_each`
- `cargo test -p conversations space_broadcast_skips_sender_and_user`
- `cargo test -p conversations space_inflight_member_is_queued`
- `cargo test -p conversations space_retry_does_not_double_submit`
- `cargo test -p conversations member_can_rename_self`
- `cargo test -p conversations proposer_nickname_then_rename`
- `cargo test -p conversations list_messages_since_seq`

**验收：**

1. 会话 A `create_conversation` 出 B、C，再 `create_collaboration_space({ name: "评审工作" })`，把自己的身份设为「小A」，`add_space_member` B→「小B」、C→「小C」。
2. A `post_to_space`，`to: ["小B","小C"]`，同一段 `content`。立刻返回两条回执。B、C 空闲则新 Turn 的输入文本相同，且第一行是 `summary`。
3. B 在 Turn 结束前不需要 A 调用任何 wait。A 的工具已经返回。
4. B 有在途 Turn 时再 `@小B`。回执 `queued`。在途 Turn 继续。
5. B `post_to_space` `@小A`。A 收到，B 的 JSONL 不包含 A 的历史，A 的 JSONL 不包含 B 的工具调用。
6. 一条不带 `to` 的消息。小B、小C 收到，小A 不收到。
7. B `set_space_identity` 改为「评审B」。之后 `@评审B` 成功，`@小B` 为 `not_found`。旧消息信封里的 actor 仍是「小B」。
8. `list_space_messages({ since_seq })` 只返回更大的 seq，一次返回全文，调用立即结束。
9. 完成标准：`collaboration_space_deliveries` 行数等于扇出目标数；重放同一 `operation_id` 不增加行。

**回滚：** 停用空间 MCP。已 `submit` 的输入留在各会话队列里，不批量删除。

### 批次 G — IM Tab

**覆盖：** R6.4、R6.5 的可见性、R6.6。依赖 F。

**改动：** 插件 `app.tab` 三栏；`workspace.focusConversation`；用户隐身成员的 UI 路径。

**测试：**

- Host：`focusConversation` 第二次调用不新建面板（Dockview 面板 id 不变）。
- 插件 Vitest：无 `@` 的用户发送走广播；成员补全列表不含用户；空态文案与设计方案一致。
- 若有浏览器工具：走通 §9 的 UI 段。没有则在验收记录里写明未做浏览器验证。

**验收：**

1. 顶部出现「协作空间」。点进去是三栏。没有 Host 会话 chrome 嵌在页内。
2. 左栏看到「评审工作」。点进去，中栏是批次 F 的消息，作者是昵称。
3. 用户输入一条并发送。中栏出现作者「你」。再让 Agent `list` 成员，结果里没有用户。Agent `@` 不到用户。
4. 点「小B」或「在工作区打开」。工作区当前会话变为小B。
5. 切到看板再切回工作区，当前会话仍是小B。窗口里小B 只有一个面板。
6. 空间为空时左栏是「还没有协作空间」。消息为空时中栏是「还没有消息」。
7. 禁用插件。Tab 消失。批次 F 已排队的输入仍会被目标会话消费。
8. 完成标准：Tab 的 manifest 没有 `engine`。右栏没有时间线组件。

**回滚：** 去掉 `app.tab` 贡献。`focusConversation` 可留，它是通用导航。

## 9. 端到端验收剧本

前置：批次 A–G 都已合并。启用多智能体协同。打开一个有仓库的工作区。会话增强可关可开，两种都要跑第 2 步。

1. 设置页把查询窗口设为 7，延时上限设为 24。
2. 在设置页创建团队「评审组」、角色「评审员」（人设提示词写「只评论 diff，不改文件」）。
3. 用户打开会话 A。A 调用 `list_conversations`，再对其中一个 ID `get_session_info`。关掉会话增强后重复，仍然成功。
4. A `create_conversation({ role_id: 评审员 })` 得到 B。再直接 `create_conversation` 得到 C。B 的 Composer 折叠为「评审员」。C 仍是普通摘要。
5. A 创建空间「评审工作」，身份「小A」，拉入 B「小B」、C「小C」。
6. A 一条消息 `@小B @小C`，正文「请评审当前 diff」。工具立即返回。B、C 各开一 Turn，输入文本相同。A 不被要求轮询。
7. 在 B 的 Turn 尚未结束时，A 再 `@小B` 一句补充。回执为排队。B 结束后才开下一 Turn。
8. B 完成后 `@小A` 汇报。A 下一轮只看到这条投递，看不到 B 的工具细节。
9. C 发一条不 `@` 任何人的消息。B 和 A 都收到，C 自己不收到。
10. A 给自己 `send_session_input`，`delay_seconds: 20`，正文「20 秒后检查评审是否收口」。20 秒内 A 仍可发即时消息且排在前面。
11. 用户打开「协作空间」Tab，看到上述气泡。用户发「我看一下 auth.ts」。Agent 成员名册没有用户。
12. 用户点小B，「在工作区打开」。切到看板再回到工作区，仍是小B，且只有一个面板。
13. 删除角色「评审员」。B 仍在，空间里小B 仍在，Composer 仍显示「评审员」。
14. 父会话若取消，B 和 C 的 Turn 不被级联取消。另一次 `delegate_to_agent` 的子会话仍会被级联取消。

任一步失败即整条剧本失败。修复后从失败步重跑，并把第 6、9、11、12 步再跑一遍，防止扇出、广播、隐身和焦点回退。

## 10. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 同工作区互发打满队列 | 每小时 60 条与 10 分钟摘要冷却；空间广播另计在这 60 条里 |
| 查询把一周全文塞进父上下文 | 列表接口无正文；Skill 禁止循环 `get_session_info` |
| `steer` 被做成排队 | 测试锁住 `steer_unsupported` 时 `conversation_inputs` 无新行 |
| `spawned` 误走委派级联 | 不写 `delegation_call_id`；父取消测试 |
| 提升器与 `submit` 双发 | 提升使用延时行的 `operation_id` |
| Tab 里重做时间线 | G 的完成标准检查 manifest 与组件树 |
| Host 按插件 ID 特判 | `plugin:no-privilege` 保持绿 |
| 昵称改名后旧 `@` 悬空 | 旧信封不改；新解析只用当前昵称；错误 `not_found` |

## 11. 工作量

一名熟悉本仓库的工程师，含测试与 ADR，不含联调意外：

| 批次 | 量级 |
| --- | --- |
| A | 数日 |
| B | 约 1 周 |
| C | 1.5–2.5 周 |
| D | 约 1 周 |
| E | 1.5–2.5 周 |
| F | 约 2 周 |
| G | 2.5–4 周 |

A 可单独发布。B–E 构成可复用协同。F 起才是 IM 式协作。G 放在 F 的工具路径验收之后。

## 12. 实施顺序检查

开工前确认：

- [ ] 设计方案 §8 的 14 条决策没有被实现改写
- [ ] 新迁移时间戳大于 `20261017010000`
- [ ] 每个新 `sqlx` 查询都准备了 `.sqlx`
- [ ] 新的 TS 类型只来自 `pnpm run generate-types`
- [ ] §9 剧本可以在一台已启用插件的桌面上逐步执行
