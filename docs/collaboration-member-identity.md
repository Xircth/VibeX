# Collaboration member identity

> **唯一权威文档。** 协作空间的成员、会话、私聊/群聊、联系人分组与宿主接口以本文为准。UI 视觉与交互细节见根目录 `DESIGN.md`（Designer 维护）。其他文档只链接到这里，不再各自复述模型。

## 模型（当前）

- **Member（成员）**：长期身份，不是会话。一行 `collaboration_members`。名下有一族隐藏会话：每个 thread（私聊或群聊）各一个。
- **Thread**：`group`（群聊，id = space id）或 `direct`（私聊，id = `direct:<member_id>`）。
- **Session（会话）**：`(member_id, thread_id)` 唯一对应一个 `conversation_id`，对用户隐藏。UI 只展示成员与聊天，不暴露会话列表。
- **新建成员**（`space.createMember`）：只创建身份 + 一条私聊会话与 `direct:` thread，打开私聊。不加入任何群。表单参数与旧「新建成员」一致（Agent、mode、config、人设等），写入成员级会话配置。
- **加入群聊**（`space.addMember`）：按成员配置为该群新建一条会话；**私聊会话保留**。不再用 `space.moveMember` 作为主路径（仍兼容，但不移除其它座位）。
- **联系人分组**（`contactGroup.*`）：联系人列表的归档文件夹。无分组时列表平铺；有分组时，未归入任何组的私聊/群聊由前端归入「未分组」（前端生成，无后端行）。
- **标签标题**：私聊打开的会话标签只显示成员名；群里打开的显示「群名 · 成员名」。用 thread 的 `kind`（`dm` / `group`）区分。
- **回执**：群消息投递后 `receipt_state` 为 `queued` → `processing` → `replied`，只前进不后退。详见下文「运行时」。

成员会话配置在 `collaboration_members`：`agent`、`mode_id`、`config_values`、`persona_prompt`（迁移 `20261024100000`）。`resolve_session` / `member.session.resolve` 新建会话时用成员配置；无配置时回退角色模式。改配置只影响之后新建的会话。

## 宿主接口（`call('collaboration', method, input)`）

### 成员与会话

| method | 要点 |
| --- | --- |
| `space.createMember` | 入参：`workspaceId`、`nickname`/`name`，可选 `agentId`、`roleId`、`modeId`、`configValues`、`personaPrompt`、`avatar`、`color`、`operationId`。忽略入参里的 `spaceId`。返回含 `conversation_id`、`identity_member_id`、`direct_thread_id`（`direct:<id>`）。 |
| `space.addMember` | 把成员拉进群；为该 `(member, group thread)` 建会话，私聊保留。 |
| `member.session.resolve` | `{ memberId, threadId }` → `{ conversationId }`。缺会话则按成员配置创建。头像点开会话标签必走此接口，不回退「最近会话」。 |
| `member.config.get` / `member.config.update` | 读写成员级会话配置。 |
| `member.memory.*` / `member.activity.list` | 用户侧记忆与活动（含 private）。 |

### 联系人列表 / thread

| method | 要点 |
| --- | --- |
| `thread.listSidebar` | `{ workspaceId }` → `{ items }`。每项：`kind`（`group`\|`dm`）、`thread_id`、`space_id`（仅群）、`name`、`tag_color`、`members_preview`（最多 4 个非 User）、`member_count`、`member`（仅私聊）、`last_message`、`last_activity_at`、`unread_count`、`group_id`（null = 未分组）。 |
| `thread.markRead` | `{ threadId, seq? }`。 |
| `thread.update` | 设 `tagColor`（群描边）。 |
| `thread.setGroup` | `{ threadId, groupId }`；`groupId` 空则回到未分组。 |

私聊消息：`space.listMessages` / `space.post`，`spaceId` 传 `direct:<memberId>`。

### 联系人分组

| method | 要点 |
| --- | --- |
| `contactGroup.list` | `{ workspaceId }` → `{ groups }`（`group_id`、`name`、`sort_order`…） |
| `contactGroup.create` / `rename` / `delete` / `reorder` | 删除后该组内 thread 的 `group_id` 清空，前端归入「未分组」。`reorder` 须传完整 `groupIds` 排列。 |

## 表与迁移（摘要）

| 迁移 | 内容 |
| --- | --- |
| `20261024010000` | `collaboration_members` / `threads` / `thread_members` / `member_activity` / `member_facts` |
| `20261024020000` | FK + `ON DELETE CASCADE` |
| `20261024030000`–`060000` | 回执/origin、sleep/wake、handoffs、write_access |
| `20261024100000` | 成员会话配置列 |
| `20261024110000` | sidebar 相关 |
| `20261024120000` | `collaboration_contact_groups` + thread.`group_id` |

`collaboration_space_members` 仍是投递/回执/去重读取的座位投影；座位的 `conversation_id` 与对应 `(member, thread)` 绑定一致。

数据回填：`MemberIdentityMigration::run` 幂等；成员 id = UUIDv5(`vibex-member:<conversation>`)；每个 space 成为同 id 的 group thread；未分配空间座位成为私聊。

## 运行时

- `resolve_session(member_id, thread_id) -> conversation_id`：缺则创建（db 写行；conversations 加人设与配置）。
- 空间投递经身份解析后再提交；delivery/receipt/dedupe 逻辑不变。
- `send_session_input` 可接受 `member_id` + `thread_id`，由宿主解析后发送。
- 成员可同时在多个群；每群一条会话。
- **回执**：`receipt_state`：`queued` → `processing` → `replied`。群投递可带 `<missed_group_messages>`（最多 30 条）。
- **Sleep / wake**：空闲会话可睡；唤醒有 cap（见环境变量 `VIBEX_MEMBER_*`）。
- **Handoffs / write_access / 成员记忆**：见历史 Phase 2 / Phase 4 实现；Agent 工具见 `crates/agents/src/skills/vibex-multi-agent/MEMORY.md`。

## 回滚

变更以加表为主。回滚：部署旧构建，按需 `DROP` 新表并删对应 `_sqlx_migrations` 行。已分叉的会话仍是普通会话。

## Phase 历史与已知限制

Phase 1–4 的实现细节仍以上述迁移与代码为准。Phase 4 已知限制：中文 BM25 较粗；长期事实主要靠 Agent 调 `memory_write`。

与 `origin/master` 上无关的预存测试失败清单（agents/plugins/server 等）不在协作改版范围内，此处不再复述。

## Open questions for final review

- `crates/plugins/src/official_mcp.rs`：官方协作工具列表未包含三个群收藏工具（`list_space_collection`、`add_to_space_collection`、`read_space_collection_item`），而 vibex-mcp 与 `tool_schema.json` 已声明。是否故意省略，待负责人决定。
- 成员加入群聊时目前会立即为其创建群内会话（非懒创建）。完全懒创建需要将 `collaboration_thread_members.conversation_id` 改为可空，并在首次收发时 `resolve_session`；大总管决定暂不做，待终审确认。

### 依赖环境待确认项

以下问题在本次回滚之前就已存在，不影响当前安装和运行（`pnpm install --frozen-lockfile`、tsc 和 dev server 均正常）。修复依赖安装时（6ff5ebb9）为避免扩大改动范围，暂未处理，待负责人确认：

- `plugins/browser` 和 `plugins/computer-use` 把 `@vibex/plugin-sdk` / `@vibex/plugin-cli` 声明为 `link:../VibeX/packages/...`，解析后的路径（`plugins/VibeX/...`）并不存在。应改为 `workspace:*` 或 `link:../../packages/...`。
- 多个插件的 `scripts` 也使用了同样错误的 `../VibeX/packages/plugin-cli/...` 路径；另有一些（如 open-connector、provider-switch、remote-ssh）使用 `../../../packages/...`，多了一级目录。
- `plugins/open-connector` 依赖 `@vibex/plugin-sdk ^1.0.0`，而其他插件依赖 `^2.0.0`，版本要求不一致。

### 启动时 database is locked 警告（2026-10-24 待确认）

20:20 重启 dev 时日志出现一次 `automation startup reconciliation failed … database is locked`。随后检查只有一套 dev 进程（一个 vibex.exe），没有旧 dev 进程残留；之后没有再出现。推测是旧实例被结束后 3 秒内新实例启动、旧进程尚未释放 SQLite 锁。待确认：自动化启动对账是否需要在遇到锁时重试。
