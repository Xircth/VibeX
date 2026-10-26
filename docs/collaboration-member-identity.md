# Collaboration member identity

> **唯一权威文档。** 协作空间的bot、会话、私聊/群聊、联系人分组与宿主接口以本文为准。UI 视觉与交互细节见根目录 `DESIGN.md`（Designer 维护）。其他文档只链接到这里，不再各自复述模型。

## 术语

| 代码标识 | 开发术语 | 界面文案（中文 / English） |
| --- | --- | --- |
| `member`（`member.*`、`member_id`、`collaboration_members`） | bot | 助手 / Bot |
| `space` / group thread（`space.*`、`kind: group`） | 群组 | 群组 / Group |
| direct thread（`direct:<member_id>`、`kind: dm`） | 私聊（和 bot 一对一聊天的场景） | 私聊 |
| group thread 内的消息 | 群聊（在群组里聊天的场景） | 群聊 |

代码标识符不改名；「bot」只用于开发文档，界面上写「助手」。

## 模型（当前）

- **Member（bot）**：长期身份，不是会话。一行 `collaboration_members`。名下有一族隐藏会话：每个 thread（私聊或群聊）各一个。
- **Thread**：`group`（群组，id = space id）或 `direct`（私聊，id = `direct:<member_id>`）。
- **Session（会话）**：`(member_id, thread_id)` 唯一对应一个 `conversation_id`。协作空间 UI 展示 bot 与聊天；工作区会话列表用普通命名展示这些会话，并以助手头像+名称标识。
- **新建 bot**（`space.createMember`）：只创建身份 + 一条私聊会话与 `direct:` thread，打开私聊。不加入任何群。表单参数与旧「新建 bot」一致（Agent、mode、config、人设等），写入bot级会话配置。
- **加入群组**（`space.addMember`）：按bot 配置为该群新建一条会话；**私聊会话保留**。不再用 `space.moveMember` 作为主路径（仍兼容，但不移除其它座位）。
- **联系人分组**（`contactGroup.*`）：联系人列表的归档文件夹。无分组时列表平铺；有分组时，未归入任何组的私聊/群聊由前端归入「未分组」（前端生成，无后端行）。
- **标签标题**：群聊打开的会话标签显示群头像与群名；私聊显示该成员头像与成员名。用 thread 的 `kind`（`dm` / `group`）区分。
- **联系人列表**：点击 bot 只打开私聊区，点击群组只打开群聊区。点击消息区中的 bot 头像才打开右侧会话标签。
- **会话命名**：新建 bot / 为 thread 解析会话时不把昵称写入 `sessions.name`。已有「昵称当会话名」的行在列表里按未命名处理，走 Agent 自动命名、首条消息或「新会话」。
- **回执**：群消息投递后 `receipt_state` 为 `queued` → `processing` → `replied`，只前进不后退。详见下文「运行时」。

bot 会话配置在 `collaboration_members`：`agent`、`mode_id`、`config_values`、`persona_prompt`（迁移 `20261024100000`）。`resolve_session` / `member.session.resolve` 新建会话时用bot 配置；无配置时回退角色模式。改配置只影响之后新建的会话。

## 宿主接口（`call('collaboration', method, input)`）

### bot与会话

| method | 要点 |
| --- | --- |
| `space.createMember` | 入参：`workspaceId`、`nickname`/`name`，可选 `agentId`、`roleId`、`modeId`、`configValues`、`personaPrompt`、`avatar`、`color`、`operationId`。忽略入参里的 `spaceId`。返回含 `conversation_id`、`identity_member_id`、`direct_thread_id`（`direct:<id>`）。 |
| `space.addMember` | 把bot拉进群组；为该 `(member, group thread)` 建会话，私聊保留。 |
| `member.session.resolve` | `{ memberId, threadId }` → `{ conversationId }`。缺会话则按bot 配置创建。头像点开会话标签必走此接口，不回退「最近会话」。 |
| `member.config.get` / `member.config.update` | 读写bot级会话配置。 |
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
| `20261024100000` | bot 会话配置列 |
| `20261024110000` | sidebar 相关 |
| `20261024120000` | `collaboration_contact_groups` + thread.`group_id` |
| `20261027010000` | 群组 `lead_member_id`、消息 `root_id` / `hop` |
| `20261027020000` | `collaboration_space_prompt_injections`（会话 × 群组的开场注入标记） |

`collaboration_space_members` 仍是投递/回执/去重读取的座位投影；座位的 `conversation_id` 与对应 `(member, thread)` 绑定一致。

数据回填：`MemberIdentityMigration::run` 幂等；bot id = UUIDv5(`vibex-member:<conversation>`)；每个 space 成为同 id 的 group thread；未分配空间座位成为私聊。

## 运行时

- `resolve_session(member_id, thread_id) -> conversation_id`：缺则创建（db 写行；conversations 加人设与配置）。
- 空间投递经身份解析后再提交；delivery/receipt/dedupe 逻辑不变。
- 群组投递信封：规则、工具说明和人设只在该助手在该群组的 ACP 会话里第一次投递时注入（表 `collaboration_space_prompt_injections`，会话 × 群组）；重建或恢复后重新注入。之后的信封只保留来源、收件人、序号、`root_id`、正文和引用消息。名单与历史用 `list_space_members` / `list_space_messages` 按需拉取。格式与前后对比见 [collaboration-delivery-envelope.md](collaboration-delivery-envelope.md)。
- `send_session_input` 可接受 `member_id` + `thread_id`。`member_id` 是成员身份 id（`collaboration_members.id`，工具字段 `identity_member_id`）或群内席位 id（`collaboration_space_members.member_id`，`list_space_members` / `add_space_member` 的 `member_id`）；二者不是同一套命名空间。宿主解析后发送。
- bot可同时在多个群组；每个群组一条会话。
- **回执**：`receipt_state`：`queued` → `processing` → `replied`。未读游标 `last_seen` 仍随投递推进；更早历史由助手按需调用 `list_space_messages`，不再打进投递信封。
- **Sleep / wake**：空闲会话可睡；唤醒有 cap（见环境变量 `VIBEX_MEMBER_*`）。
- **Handoffs / write_access / bot记忆**：见历史 Phase 2 / Phase 4 实现；Agent 工具见 `crates/agents/src/skills/vibex-multi-agent/MEMORY.md`。

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
